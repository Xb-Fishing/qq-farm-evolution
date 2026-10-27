// 模块加载前隔离运行数据；任何创建/写入之前校验临时边界。
const _fs = require('node:fs'), _path = require('node:path'), _os = require('node:os');
const _tmpRoot = _fs.realpathSync(_os.tmpdir());
const _prefix = _path.resolve(_tmpRoot, 'farm-retired-fixture-');
if (!_prefix.startsWith(_tmpRoot + _path.sep)) throw new Error('fixture boundary');
const _dataDir = _fs.mkdtempSync(_prefix);
process.env.FARM_DATA_DIR = _dataDir;
require('node:test').after(() => _fs.rmSync(_dataDir, { recursive: true, force: true }));
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const activityService = require('../src/services/activity');
const { normalizeBearActivity, getBearActivity, normalizeDiscoveryActivity, BEAR_GUIDE_MANUAL_ACTIONS } = activityService;
const { OPERATIONS } = require('../src/services/pet-diary-operate');
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
  assert.equal(activity.resources.find(item => item.key === 'seed').itemId, 29004);
  assert.equal(activity.resources.find(item => item.key === 'cake').itemId, 1028);
  // 三档挑战书 ID 来自 ItemInfo 证据闭环，资源区不得回退成“道具 ID 待官方证据”。
  assert.deepEqual(['basic', 'middle', 'advanced'].map(key => activity.resources.find(item => item.key === key).itemId), [80101, 80102, 80103]);
  // 待护送宝藏 1030 已按 Bag + ItemInfo 快照证据闭环，资源区不得回退成 null。
  assert.equal(activity.resources.find(item => item.key === 'treasure').itemId, 1030);
  assert.match(activity.resources.find(item => item.key === 'seed').image, /29004_Crop_9004_Seed/);
  // 元气糕 1028 使用专属图标，不能拿任何种子图顶替。
  assert.match(activity.resources.find(item => item.key === 'cake').image, /1028_%E8%90%8C%E5%AE%A0%E5%85%83%E6%B0%94%E7%B3%95/);
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

test('S3 玩法指南 manualActions 仅镜像已批准的七个面板手动动作，保持只读边界', () => {
  const activity = normalizeBearActivity(snapshot(), { nowSeconds: 1789010000 });
  const guides = new Map(activity.gameplayGuides.map(guide => [guide.key, guide]));
  // 五类已开放手动操作的玩法：映射值必须与批准映射逐项一致。
  assert.deepEqual(guides.get('grow').manualActions, ['initialize', 'feed', 'claimDog']);
  assert.deepEqual(guides.get('treasure').manualActions, ['draw']);
  assert.deepEqual(guides.get('pity').manualActions, ['compensation']);
  assert.deepEqual(guides.get('album').manualActions, ['story']);
  assert.deepEqual(guides.get('gift').manualActions, ['seeds']);
  // 其余六类（未开放或无对应入口）必须为空。
  for (const key of ['care', 'escort', 'raid', 'tactics', 'shop', 'rank']) {
    assert.deepEqual(guides.get(key).manualActions, []);
  }
  // 并集恰为活动卡顶部七个已批准手动按钮；全部属于 pet-diary-operate 现有白名单。
  const union = new Set(Object.values(BEAR_GUIDE_MANUAL_ACTIONS).flat());
  const panelActions = ['initialize', 'feed', 'draw', 'claimDog', 'seeds', 'compensation', 'story'];
  assert.deepEqual([...union].sort(), [...panelActions].sort());
  for (const action of union) {
    assert.ok(Object.prototype.hasOwnProperty.call(OPERATIONS, action), `动作 ${action} 不在现有 OPERATIONS 白名单`);
  }
  // 明确排除未开放/辅助动作，防止展示映射被误当成协议授权扩展点。
  for (const forbidden of ['exchange', 'battle', 'markStories', 'skipBattle']) {
    assert.ok(!union.has(forbidden));
    assert.ok(!Object.prototype.hasOwnProperty.call(BEAR_GUIDE_MANUAL_ACTIONS, forbidden));
  }
  // manualActions 只是展示元数据：只读能力标记保持原值，不能翻成授权判断。
  assert.ok(activity.gameplayGuides.every(guide => guide.operationSupported === false
    && guide.statusAvailable === false && Array.isArray(guide.manualActions)));
  assert.equal(activity.writeOperationsSupported, false);
  assert.ok(activity.exchangeShop.every(item => item.operationSupported === false));
  // 没有说明时 guides 为空，manualActions 不凭空出现。
  const stripped = snapshot();
  stripped.children.forEach(node => { node.payload = { uid: 'SEASON_BEAR_CAMPAIGN' }; });
  assert.deepEqual(normalizeBearActivity(stripped).gameplayGuides, []);
  // 缺失证据改为三类准确边界，不得再笼统宣称所有操作协议待确认。
  assert.ok(activity.missingEvidence.every(item => !/所有操作协议待确认/.test(item)));
  const evidence = activity.missingEvidence.join(' ');
  assert.match(evidence, /已开放面板手动操作/);
  assert.match(evidence, /好友交互暂不开放/);
  assert.match(evidence, /未提供商品兑换入口/);
  // 状态字段区分「操作前校验已解析、快照未展示」与「待官方字段证据」，不再统称尚未确认；
  // 挑战书库存由背包读取在资源区展示，不得列入夺宝玩法卡的缺字段证据清单。
  assert.match(evidence, /已由操作服务解析并用于操作前校验，当前只读快照未展示这些实时状态/);
  assert.match(evidence, /元气糕与三档挑战书库存随背包读取展示，读取失败保持未知、不补零/);
  assert.doesNotMatch(evidence, /的当前状态字段尚未确认/);
  assert.equal(guides.get('raid').missingState, '今日剩余次数、目标护送状态');
  for (const guide of activity.gameplayGuides) {
    assert.ok(!/挑战书库存/.test(guide.missingState), '挑战书库存不属于玩法卡缺字段证据');
  }
});

test('S3 商城保留全部道具和原始状态码，只补证实的名称，不增加种植映射或操作能力', () => {
  const activity = normalizeBearActivity(snapshot(), {
    inventoryAvailable: true, counts: new Map([[1029, 7], [80001, 2], [80102, 3]]),
  });
  assert.equal(activity.exchangeShop.length, 13);
  assert.equal(activity.resources.find(item => item.key === 'currency').count, 7);
  assert.equal(activity.resources.find(item => item.key === 'seed').count, 0);
  assert.equal(activity.resources.find(item => item.key === 'cake').count, 0);
  // 挑战书库存随背包读取透出；缺档显示 0（读取成功时），不新增任何操作能力。
  assert.equal(activity.resources.find(item => item.key === 'middle').count, 3);
  assert.equal(activity.resources.find(item => item.key === 'basic').count, 0);
  assert.equal(activity.resources.find(item => item.key === 'advanced').count, 0);
  assert.ok(activity.resources.filter(item => /挑战书/.test(item.name)).every(item => item.image === '' && item.operationSupported === undefined));
  assert.equal(activity.exchangeShop.find(item => item.itemId === 80001).inventoryCount, 2);
  assert.equal(activity.exchangeShop.find(item => item.itemId === 20522).status, 50);
  assert.match(activity.exchangeShop.find(item => item.itemId === 80011).statusLabel, /130.*待确认/);
  assert.ok(activity.exchangeShop.every(item => item.currencyName === '幸运星' && item.operationSupported === false));
  for (const item of activity.exchangeShop) assert.equal(getItemById(item.itemId).name, item.name);
  assert.equal(getItemById(1029).name, '幸运星');
  assert.equal(getPlantBySeedId(20522).size, 1);
  assert.equal(isSeedItem(20522), true);
  assert.equal(getItemById(20522).type, 5);
  assert.equal(getItemById(20522).interaction_type, 'plant');
  assert.equal(getItemById(20523).type, 5);
  assert.equal(getPlantBySeedId(29003).size, 2);
  assert.equal(getPlantBySeedId(20883).size, 1);
});

test('S3 field 110 奖励记录为活动种子和产出物补名称与图标', () => {
  const input = snapshot();
  input.children[1].details = {
    starRecord: {
      records: [{ id: 1, title: '比熊赠礼', unlocked: true, claimed: true, rewards: [
        { itemId: 29004, itemCount: 1, count: 1, itemName: '物品#29004', image: '' },
        { itemId: 20516, itemCount: 32, count: 32, itemName: '物品#20516', image: '' },
      ] }],
    },
  };
  const activity = normalizeBearActivity(input, { inventoryAvailable: true, counts: new Map([[29004, 3], [20516, 56]]) });
  const seed = activity.resources.find(item => item.key === 'seed');
  const cake = activity.resources.find(item => item.key === 'cake');
  assert.deepEqual({ itemId: seed.itemId, count: seed.count, name: seed.name }, { itemId: 29004, count: 3, name: '泡泡棉花糖种子' });
  assert.deepEqual({ itemId: cake.itemId, count: cake.count, name: cake.name }, { itemId: 1028, count: 0, name: '萌宠元气糕' });
  const reward = activity.records[0].rewards.find(item => item.itemId === 29004);
  assert.equal(reward.itemName, '泡泡棉花糖种子');
  assert.equal(activity.records[0].rewards.find(item => item.itemId === 20516).itemName, '狗尾草种子');
  assert.equal(isSeedItem(20516), true);
  assert.equal(getItemById(20516).name, '狗尾草种子');
  assert.match(reward.image, /29004_Crop_9004_Seed/);
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

test("S3 读取仅信 List 根节点，缺少根时不请求详情或背包（轮换退役：入口零网络）", async () => {
 let calls=0; const read=async()=>{calls++; throw new Error('unexpected read');};
 const mod=require('../src/services/activity');
 await assert.rejects(mod.getBearActivity({ getActivityDiscoveryList: read, getActivityGroupSnapshot: read, getBagItemCounts: read }), /下架/);
 assert.equal(calls,0);
});

test("S3 只读取正常根详情和一次已知道具库存；失败不探测子节点、UID 或重试（轮换退役：入口零网络）", async () => {
 let calls=0; const read=async()=>{calls++; throw new Error('unexpected read');};
 const mod=require('../src/services/activity');
 await assert.rejects(mod.getBearActivity({ getActivityDiscoveryList: read, getActivityGroupSnapshot: read, getBagItemCounts: read }), /下架/);
 assert.equal(calls,0);
});

test("S3 管理只读链按账号合并并发、缓存成功与失败，权限检查先于缓存（轮换退役：入口零网络）", async () => {
 let calls=0; const read=async()=>{calls++; throw new Error('unexpected read');};
 const mod=require('../src/services/activity');
 await assert.rejects(mod.getBearActivity({ getActivityDiscoveryList: read, getActivityGroupSnapshot: read, getBagItemCounts: read }), /下架/);
 assert.equal(calls,0);
});

test("S3 端到端只读接线与旧天气/公益入口退役，不恢复自动任务和历史写命令（轮换退役：入口零网络）", async () => {
 let calls=0; const read=async()=>{calls++; throw new Error('unexpected read');};
 const mod=require('../src/services/activity');
 await assert.rejects(mod.getBearActivity({ getActivityDiscoveryList: read, getActivityGroupSnapshot: read, getBagItemCounts: read }), /下架/);
 assert.equal(calls,0);
});
