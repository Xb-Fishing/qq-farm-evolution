const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const activityService = require('../src/services/activity');
const { normalizeBearActivity, getBearActivity, normalizeDiscoveryActivity } = activityService;
const { registerAdminBearActivityRoutes } = require('../src/controllers/admin-bear-activity-routes');
const { getItemById, getPlantBySeedId, isSeedItem } = require('../src/config/gameConfig');

function snapshot() {
  return JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/season-bear.json'), 'utf8'));
}

test('S3 说明覆盖全部玩法、结束提示和来源冲突，状态缺失不伪造为零', () => {
  const activity = normalizeBearActivity(snapshot(), { nowSeconds: 1789010000 });
  assert.deepEqual(activity.gameplayGuides.map(item => item.key), [
    'grow', 'care', 'treasure', 'escort', 'raid', 'pity', 'album', 'tactics', 'shop', 'rank', 'gift',
  ]);
  assert.equal(activity.conflicts.length, 5);
  assert.equal(activity.notices.length, 7);
  assert.match(activity.notices.join(' '), /经验种子.*金币种子.*无法产出.*元气糕/);
  assert.match(activity.notices.join(' '), /未成年.*回收.*永久保留.*兑换为金币.*保底额度.*清空/s);
  assert.ok(activity.gameplayGuides.every(item => item.operationSupported === false && item.statusAvailable === false));
  assert.equal(activity.resources.length, 8);
  assert.ok(activity.resources.every(item => item.count === null));
  assert.equal(activity.resources.find(item => item.key === 'seed').itemId, null);
  assert.equal(activity.resources.find(item => item.key === 'cake').itemId, null);
  assert.match(activity.statusLabel, /节点未启用/);
  assert.equal(activity.recordStateAvailable, false);
  assert.deepEqual(activity.protocol.opaqueReadOnlyFields, [115]);
  assert.deepEqual(activity.subActivities.map(item => item.protobufField), [115, 110, 102]);
  assert.ok(activity.subActivities.every(item => item.protocolObserved));
  assert.equal(activity.uid, '');
  assert.equal(activity.uidConfirmed, false);
  assert.equal(activity.clientUiUid, 'SEASON_BEAR_CAMPAIGN');
});

test('S3 没有说明时不按 ID、UID、type 或字段形状编造玩法、资源和冲突', () => {
  const input = snapshot();
  input.children.forEach(node => { node.payload = { uid: 'SEASON_BEAR_CAMPAIGN' }; });
  const activity = normalizeBearActivity(input);
  assert.deepEqual(activity.gameplayGuides, []);
  assert.deepEqual(activity.resources, []);
  assert.deepEqual(activity.notices, []);
  assert.deepEqual(activity.conflicts, []);
  assert.equal(activity.exchangeShop.length, 13);
  assert.equal(activity.writeOperationsSupported, false);
});

test('S3 商城保留全部道具和原始状态码，只补证实的名称，不增加种植映射或操作能力', () => {
  const activity = normalizeBearActivity(snapshot(), {
    inventoryAvailable: true, counts: new Map([[1029, 7], [80001, 2]]),
  });
  assert.equal(activity.exchangeShop.length, 13);
  assert.equal(activity.resources.find(item => item.key === 'currency').count, 7);
  assert.ok(activity.resources.filter(item => !item.itemId).every(item => item.count === null));
  assert.equal(activity.exchangeShop.find(item => item.itemId === 80001).inventoryCount, 2);
  assert.equal(activity.exchangeShop.find(item => item.itemId === 20522).status, 50);
  assert.match(activity.exchangeShop.find(item => item.itemId === 80011).statusLabel, /130.*待确认/);
  assert.ok(activity.exchangeShop.every(item => item.currencyName === '幸运星' && item.operationSupported === false));
  for (const item of activity.exchangeShop) assert.equal(getItemById(item.itemId).name, item.name);
  assert.equal(getItemById(1029).name, '幸运星');
  assert.equal(getPlantBySeedId(20522), undefined);
  assert.equal(isSeedItem(20522), false);
  assert.equal(getPlantBySeedId(29003).size, 2);
  assert.equal(getPlantBySeedId(20883).size, 1);
});

test('已有 field 110 只读解析保留无配置的奖励、未知领取态，不泄露额外字段', () => {
  const node = normalizeDiscoveryActivity({
    activity: { id: 2026090102, parent_id: 2026090100, type: 13 },
    star_record: {
      configs: [{ id: 1, title: '成长奖励', graph: 'private-image', extra: 'private-extra' }, { id: 2, title: '未来奖励' }],
      records: [{ id: 1, unlocked: true, claimed: false, rewards: [{ id: 1029, count: 8 }] }, { id: 3, unlocked: false, claimed: false }],
    },
  });
  assert.deepEqual(node.details.starRecord.records.map(item => item.id), [1, 2, 3]);
  assert.equal(node.details.starRecord.records[1].claimed, null);
  assert.equal(node.details.starRecord.records[2].title, '');
  assert.equal(node.details.starRecord.records[0].rewards[0].itemName, '幸运星');
  assert.doesNotMatch(JSON.stringify(node), /private-image|private-extra/);
  const input = snapshot();
  input.children[1].details = node.details;
  assert.equal(normalizeBearActivity(input).recordStateAvailable, true);
});

test('S3 读取仅信 List 根节点，缺少根时不请求详情或背包', async () => {
  let reads = 0;
  for (const list of [[], [{ id: 2026090101, parentId: 2026090100 }], [{ id: 2026090100, parentId: 1 }]]) {
    await assert.rejects(getBearActivity({
      getActivityDiscoveryList: async () => list,
      getActivityGroupSnapshot: async () => { reads += 1; },
      getBagItemCounts: async () => { reads += 1; },
    }), /未由当前 ActivityService.List 下发/);
  }
  assert.equal(reads, 0);
});

test('S3 只读取正常根详情和一次已知道具库存；失败不探测子节点、UID 或重试', async () => {
  const calls = [];
  const options = {
    getActivityDiscoveryList: async () => [{ id: 2026090100, parentId: 0 }],
    getActivityGroupSnapshot: async (...args) => { calls.push(args); return snapshot(); },
    getBagItemCounts: async ids => {
      calls.push(ids);
      throw new Error('inventory unavailable');
    },
  };
  const activity = await getBearActivity(options);
  assert.deepEqual(calls[0], [2026090100, '']);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].length, 14);
  assert.equal(activity.inventoryAvailable, false);
  assert.equal(activity.resources[0].count, null);
  assert.equal(activity.gameplayGuides.length, 11);
  let inventoryReads = 0;
  await assert.rejects(getBearActivity({
    ...options,
    getActivityGroupSnapshot: async () => { throw new Error('unknown response'); },
    getBagItemCounts: async () => { inventoryReads += 1; },
  }), /unknown response/);
  await assert.rejects(getBearActivity({
    ...options,
    getActivityGroupSnapshot: async () => ({ id: 1 }),
    getBagItemCounts: async () => { inventoryReads += 1; },
  }), /活动组不匹配/);
  assert.equal(inventoryReads, 0);
});

test('S3 管理只读链按账号合并并发、缓存成功与失败，权限检查先于缓存', async () => {
  const routes = new Map();
  let reads = 0;
  let allowed = true;
  registerAdminBearActivityRoutes({
    app: { get: (route, handler) => routes.set(route, handler) },
    provider: {
      getStatus: () => ({ connection: { connected: true } }),
      getBearActivity: async key => {
        reads += 1;
        if (key === 'fixture-failure') throw new Error('temporary failure');
        return normalizeBearActivity(snapshot());
      },
    },
    getAccountIdFromRequest: req => req.key,
    canAccessAccount: () => allowed,
    sendProviderError: (res) => res.json({ ok: false }),
  });
  const handler = routes.get('/api/activity/bear');
  const invoke = async key => {
    let body;
    const res = { status: () => res, json: value => { body = value; } };
    await handler({ key }, res);
    return body;
  };
  await Promise.all([invoke('fixture-success'), invoke('fixture-success')]);
  assert.equal(reads, 1);
  assert.equal((await invoke('fixture-success')).upstreamCached, true);
  await invoke('fixture-failure');
  await invoke('fixture-failure');
  assert.equal(reads, 2);
  allowed = false;
  assert.equal((await invoke('fixture-success')).ok, false);
  assert.equal(reads, 2);
  assert.deepEqual([...routes.keys()], ['/api/activity/bear']);
});

test('S3 端到端只读接线与旧天气/公益入口退役，不恢复自动任务和历史写命令', () => {
  const read = file => fs.readFileSync(path.join(__dirname, file), 'utf8');
  const worker = read('../src/core/worker.js');
  const provider = read('../src/runtime/data-provider.js');
  const store = read('../../web/src/stores/activity.ts');
  const view = read('../../web/src/views/Activity.vue');
  const panel = read('../../web/src/components/activity/BearActivityPanel.vue');
  const scan = read('../../web/src/components/admin/AdminActivityUpdatePanel.vue');
  const routes = read('../src/controllers/admin-activity-routes.js');
  assert.match(routes, /registerAdminBearActivityRoutes\(routeContext\)/);
  assert.doesNotMatch(routes, /registerAdminWeatherActivityRoutes|registerAdminCharityActivityRoutes/);
  for (const source of [worker, provider, store]) assert.doesNotMatch(source, /getWeatherActivity|getCharityActivity|fetchWeatherActivity|fetchCharityActivity/);
  assert.doesNotMatch(view, /WeatherActivityPanel|CharityRedFlowerPanel/);
  assert.match(view, /BearActivityPanel/);
  assert.match(provider, /getBearActivity/);
  assert.match(worker, /case 'getBearActivity'/);
  assert.doesNotMatch(worker, /runBear|bear_activity_(claim|feed)|startBear/);
  assert.match(panel, /disabled.*操作协议待确认/s);
  assert.match(panel, /官方说明存在差异/);
  assert.match(scan, /bear-album.*爪印手记/);
  assert.match(scan, /bear-tactics.*锦囊/);
  assert.match(store, /\+\+bearRequestId/);
  for (const name of ['getWeatherActivity', 'getCharityActivity']) assert.equal(activityService[name], undefined);
  for (const id of [2026090100, 2026090101, 2026090102, 2026090103]) {
    assert.ok(Object.entries(activityService).some(([key, value]) => key.endsWith('_ACTIVITY_ID') && value === id));
  }
});
