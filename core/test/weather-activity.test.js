const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  WEATHER_ACTIVITY_ID,
  WEATHER_EXCHANGE_ACTIVITY_ID,
  WEATHER_TYPE17_ACTIVITY_ID,
  WEATHER_DRAW_ACTIVITY_ID,
  WEATHER_TYPE20_ACTIVITY_ID,
  WEATHER_TYPE6_ACTIVITY_ID,
  WEATHER_CLIENT_UI_UID,
  getWeatherActivity,
  normalizeWeatherActivity,
} = require('../src/services/activity');
const {
  createActivityReadCache,
  registerAdminWeatherActivityRoutes,
  WEATHER_ACTIVITY_UPSTREAM_CACHE_MS,
} = require('../src/controllers/admin-weather-activity-routes');

function createWeatherSnapshot() {
  return {
    id: 2026070300,
    parentId: 0,
    type: 1,
    title: '雨落成诗',
    startTime: 1787709600,
    endTime: 1788883199,
    visible: true,
    enabled: false,
    status: 0,
    discoveryEvidence: {
      protocolShape: [
        { path: '1.2.102', wire: 2, count: 1, byteLengths: [45] },
        { path: '1.2.105', wire: 2, count: 1, byteLengths: [31] },
        { path: '1.2.114', wire: 2, count: 1, byteLengths: [0] },
        { path: '1.2.117', wire: 2, count: 1, byteLengths: [113] },
        { path: '1.2.118', wire: 2, count: 1, byteLengths: [258] },
      ],
    },
    children: [
      {
        id: 2026070301,
        parentId: 2026070300,
        type: 3,
        title: '雨落成诗',
        startTime: 1787709600,
        endTime: 1788883199,
        visible: true,
        enabled: true,
        status: 18,
        payload: {
          uid: 'WeatherBottleUI',
          tips: {
            title: '活动说明',
            txt: [
              '<b>【活动简介】</b>',
              '雷雨天气中，成长中的作物有机会发生闪电变异（1品和2品作物除外），变异果实的售价将提升至原来的4倍！',
              '1.开展气象研究',
              '完成使用天气采集瓶、使用雷雨召唤瓶和收获闪电变异作物任务，即可获得雷电徽章。消耗雷电徽章可依次推进气象研究，并领取对应奖励。',
              '天气采集瓶：前往处于雷雨天气的好友农场，即可使用天气采集瓶。每次成功采集，必定获得雷雨召唤瓶×1。',
              '雷雨召唤瓶：在自己的农场使用雷雨召唤瓶，即可主动召唤一场雷雨。若农场当前已有特殊天气，则暂时无法使用。',
              '使坏天气瓶：在好友农场使用青蛙使坏瓶或乌云使坏瓶，可以触发趣味互动事件，并获得经验奖励。',
              '天气瓶为限时活动道具。活动结束后将无法继续使用，可出售兑换金币。',
              '活动期间已经发生闪电变异的作物不会因活动结束而消失，成熟后仍可正常收获。',
            ],
          },
        },
        details: {
          exchangeShop: {
            items: [{
              id: 200,
              status: 1,
              owned: true,
              statusLabel: '已拥有',
              itemId: 5001,
              itemCount: 1,
              itemName: '天气采集瓶',
              image: '',
              currencyId: 1005,
              currencyName: '金豆豆',
              price: 200,
            }],
          },
        },
        children: [],
      },
      { id: 2026070302, parentId: 2026070300, type: 17, visible: true, enabled: false, status: 0, children: [] },
      {
        id: 2026070303,
        parentId: 2026070300,
        type: 8,
        visible: true,
        enabled: false,
        status: 0,
        details: {
          draw: {
            freeMax: 4,
            freeUsed: 4,
            freeRemaining: 0,
            paidMax: 10,
            paidUsed: 1,
            paidRemaining: 9,
            paidCurrencyId: 5001,
            paidPrice: 1,
            fallbackPrice: 1,
            rewardPool: [{ id: 11001, rarity: 0, itemId: 5002, itemCount: 1, itemName: '物品5002', image: '', probability: '100%' }],
          },
        },
        children: [],
      },
      { id: 2026070304, parentId: 2026070300, type: 20, visible: true, enabled: false, status: 0, children: [] },
      { id: 2026070305, parentId: 2026070300, type: 6, visible: true, enabled: false, status: 0, children: [] },
    ],
  };
}

test('雨落成诗按在线证据标准化活动树、道具、次数和只读边界', () => {
  const activity = normalizeWeatherActivity(createWeatherSnapshot(), new Map([[5001, 3], [5002, 7]]));

  assert.equal(WEATHER_ACTIVITY_ID, 2026070300);
  assert.equal(WEATHER_CLIENT_UI_UID, 'WeatherBottleUI');
  assert.equal(activity.uid, '');
  assert.equal(activity.uidConfirmed, false);
  assert.equal(activity.clientUiUid, 'WeatherBottleUI');
  assert.equal(activity.subActivities.length, 5);
  assert.deepEqual(activity.subActivities.map(item => item.id), [
    2026070301, 2026070302, 2026070303, 2026070304, 2026070305,
  ]);
  assert.deepEqual(activity.subActivities.map(item => item.protobufField), [102, 114, 105, 118, 117]);
  assert.equal(activity.subActivities[0].statusLabel, '进行中');
  assert.equal(activity.items.weatherBottle.itemName, '天气采集瓶');
  assert.equal(activity.items.weatherBottle.itemCount, 3);
  assert.equal(activity.items.drawReward.itemName, '物品5002');
  assert.equal(activity.items.drawReward.itemCount, 7);
  assert.equal(activity.exchangeShop[0].price, 200);
  assert.equal(activity.draw.freeRemaining, 0);
  assert.equal(activity.draw.paidRemaining, 9);
  assert.equal(activity.draw.currencyName, '天气采集瓶');
  assert.equal(activity.draw.rewardPool[0].probability, '100%');
  assert.deepEqual(activity.protocol.opaqueReadOnlyFields, [114, 117, 118]);
  assert.equal(activity.protocol.observedShape.length, 5);
  assert.ok(activity.subActivities.every(item => item.protocolObserved));
  assert.equal(activity.readOnly, true);
  assert.equal(activity.writeOperationsSupported, false);
  assert.ok(activity.ruleLines.every(line => !line.includes('<')));
  assert.deepEqual(activity.gameplayGuides.map(item => item.key), [
    'mutation', 'collect', 'summon', 'research', 'prank',
  ]);
  assert.equal(activity.summary.gameplayGuideCount, 5);
  assert.ok(activity.gameplayGuides.every(item => item.source === 'activity_rules'));
  assert.ok(activity.gameplayGuides.every(item => item.operationSupported === false));
  assert.match(activity.gameplayGuides.find(item => item.key === 'collect').steps.join(' '), /好友农场.*召唤瓶/);
  assert.match(activity.gameplayGuides.find(item => item.key === 'research').steps.join(' '), /雷电徽章.*阶段奖励/);
  assert.match(activity.gameplayGuides.find(item => item.key === 'mutation').steps.join(' '), /4 倍/);
  assert.equal(activity.ruleWarnings.length, 2);
});

test('没有活动说明证据时不凭协议节点猜玩法 UI', () => {
  const snapshot = createWeatherSnapshot();
  snapshot.children[0].payload.tips.txt = ['当前只有通用活动说明'];
  const activity = normalizeWeatherActivity(snapshot);

  assert.deepEqual(activity.gameplayGuides, []);
  assert.deepEqual(activity.ruleWarnings, []);
  assert.equal(activity.summary.gameplayGuideCount, 0);
});

test('雨落成诗只读读取先验证 List 根节点，活动结束后不再触发 GetGroup', async () => {
  let snapshotReads = 0;
  await assert.rejects(getWeatherActivity({
    getActivityDiscoveryList: async () => [],
    getActivityGroupSnapshot: async () => {
      snapshotReads += 1;
      return createWeatherSnapshot();
    },
  }), /未由当前 ActivityService\.List 下发/);
  assert.equal(snapshotReads, 0);
});

test('雨落成诗只读读取使用 List 已下发根节点和空 UID', async () => {
  let request = null;
  const activity = await getWeatherActivity({
    getActivityDiscoveryList: async () => [{ id: WEATHER_ACTIVITY_ID, parentId: 0 }],
    getActivityGroupSnapshot: async (activityId, uid) => {
      request = { activityId, uid };
      return createWeatherSnapshot();
    },
  });
  assert.deepEqual(request, { activityId: WEATHER_ACTIVITY_ID, uid: '' });
  assert.equal(activity.activityId, WEATHER_ACTIVITY_ID);
});

test('雨落成诗根节点和全部子节点都进入已知活动注册表', () => {
  const knownIds = [
    WEATHER_ACTIVITY_ID,
    WEATHER_EXCHANGE_ACTIVITY_ID,
    WEATHER_TYPE17_ACTIVITY_ID,
    WEATHER_DRAW_ACTIVITY_ID,
    WEATHER_TYPE20_ACTIVITY_ID,
    WEATHER_TYPE6_ACTIVITY_ID,
  ];
  assert.deepEqual(knownIds, [
    2026070300,
    2026070301,
    2026070302,
    2026070303,
    2026070304,
    2026070305,
  ]);
});

test('雨落成诗管理接口只读取已连接账号状态', async () => {
  const routes = new Map();
  const activity = normalizeWeatherActivity(createWeatherSnapshot());
  let upstreamReads = 0;
  registerAdminWeatherActivityRoutes({
    app: { get: (route, handler) => routes.set(route, handler) },
    provider: {
      getStatus: () => ({ connection: { connected: true } }),
      getWeatherActivity: async () => {
        upstreamReads += 1;
        return activity;
      },
    },
    getAccountIdFromRequest: () => 'account-A',
    canAccessAccount: () => true,
    sendProviderError: (_res, error) => { throw error; },
  });

  let body = null;
  await routes.get('/api/activity/weather')({}, { json: value => { body = value; } });
  assert.equal(body.ok, true);
  assert.equal(body.activity.activityId, WEATHER_ACTIVITY_ID);
  assert.equal(body.activity.writeOperationsSupported, false);
  assert.equal(body.upstreamCached, false);

  await routes.get('/api/activity/weather')({}, { json: value => { body = value; } });
  assert.equal(body.upstreamCached, true);
  assert.equal(body.upstreamCacheMs, WEATHER_ACTIVITY_UPSTREAM_CACHE_MS);
  assert.equal(upstreamReads, 1);
});

test('活动只读缓存合并并发请求，过期后才重新读取腾讯上游', async () => {
  let now = 1_000;
  let upstreamReads = 0;
  const cache = createActivityReadCache({ ttlMs: 10_000, now: () => now });
  const loader = async () => {
    upstreamReads += 1;
    return { version: upstreamReads };
  };

  const [first, concurrent] = await Promise.all([
    cache.read('account-A', loader),
    cache.read('account-A', loader),
  ]);
  assert.equal(upstreamReads, 1);
  assert.equal(first.value.version, 1);
  assert.equal(concurrent.value.version, 1);

  const cached = await cache.read('account-A', loader);
  assert.equal(cached.upstreamCached, true);
  assert.equal(upstreamReads, 1);

  now += 10_000;
  const refreshed = await cache.read('account-A', loader);
  assert.equal(refreshed.upstreamCached, false);
  assert.equal(upstreamReads, 2);
});

test('活动只读缓存也缓存短期失败，避免页面刷新放大上游异常', async () => {
  let now = 1_000;
  let upstreamReads = 0;
  const cache = createActivityReadCache({ ttlMs: 10_000, now: () => now });
  const loader = async () => {
    upstreamReads += 1;
    throw new Error('temporary upstream failure');
  };

  await assert.rejects(cache.read('account-A', loader), /temporary upstream failure/);
  await assert.rejects(cache.read('account-A', loader), /temporary upstream failure/);
  assert.equal(upstreamReads, 1);

  now += 10_000;
  await assert.rejects(cache.read('account-A', loader), /temporary upstream failure/);
  assert.equal(upstreamReads, 2);
});

test('过期鹊桥专属 UI 与自动例行入口已停用，历史协议解析仍保留', () => {
  const workerSource = fs.readFileSync(path.join(__dirname, '../src/core/worker.js'), 'utf8');
  const activityViewSource = fs.readFileSync(path.join(__dirname, '../../web/src/views/Activity.vue'), 'utf8');

  assert.doesNotMatch(workerSource, /runQixi|startQixi|qixi_activity_/);
  assert.doesNotMatch(activityViewSource, /QixiActivityPanel|鹊桥寄情/);
  assert.match(activityViewSource, /WeatherActivityPanel|雨落成诗/);
  assert.doesNotMatch(workerSource, /case 'getQixiActivity'/);
});

test('雨落成诗专属 UI 按活动说明展示玩法，协议节点只作为诊断信息', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../web/src/components/activity/WeatherActivityPanel.vue'), 'utf8');
  const scanSource = fs.readFileSync(path.join(__dirname, '../../web/src/components/admin/AdminActivityUpdatePanel.vue'), 'utf8');

  assert.match(source, /天气瓶主线/);
  assert.match(source, /玩法说明与参与条件/);
  assert.match(source, /活动注意事项/);
  assert.match(source, /协议接入状态（诊断信息）/);
  assert.doesNotMatch(source, /未命名玩法/);
  assert.match(scanSource, /根据活动说明识别的 UI 检查项/);
  assert.match(scanSource, /它们不能作为写操作命令或参数的证据/);
  assert.doesNotMatch(scanSource, /个候选或当前活动入口/);
  assert.match(scanSource, /本次新活动候选组/);
  assert.match(source, /1 分钟内重复刷新复用本地结果/);
  assert.match(source, /当前请在官方 QQ 农场活动页人工执行/);
  assert.match(source, /必须先取得当前官方客户端自然操作产生的成功请求样本/);
  assert.doesNotMatch(source, /操作协议待确认，当前不提供执行按钮/);
});
