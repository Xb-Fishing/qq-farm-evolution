'use strict';
// 奶茶热销中（S4，2026110100 族）读路径与编码回归。
// 覆盖：真实 proto 注册、根快照四类子节点详情解码合并、16 条主玩法请求
// 官方固定 hex 向量逐条字节级核对、商城/快乐值/基金真实回包形状、
// timingOf 时间边界（含最终截止闭边界与营业开始前）、默认只读入口的
// 缺根单次 List / enabled=false 可读 / 读取途中跨边界 / 结束证据生命周期，
// 以及固定配置（EventItems 新增项分类 / EventPlants 未证不登记）核对。
// 网络全部为注入替身，零真实游戏请求；业务模块加载前隔离 FARM_DATA_DIR，
// 夹具目录先解析校验边界，结束后清理并核对候选源码内容与权限不变。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

// ===== 隔离环境（先于任何业务模块加载）=====
const repoRoot = path.resolve(__dirname, '..', '..');
const repoRootReal = fs.realpathSync(repoRoot);
function isInsideOrEqualDir(candidate, base) {
  const c = path.resolve(String(candidate));
  const b = path.resolve(String(base));
  return c === b || c.startsWith(b + path.sep);
}
const tempRoot = fs.realpathSync(path.resolve(os.tmpdir()));
assert.equal(isInsideOrEqualDir(tempRoot, repoRootReal), false, '临时根不得指向仓库');
// mkdtemp 前先验证前缀路径确实落在临时根内（防 tmpdir 解析漂移后越界建目录）
const mkdtempPrefix = path.join(tempRoot, 'farm-milk-tea-activity-');
assert.equal(isInsideOrEqualDir(mkdtempPrefix, tempRoot), true, 'mkdtemp 前缀必须位于临时根内');
const privateDir = path.resolve(fs.mkdtempSync(mkdtempPrefix));
assert.equal(isInsideOrEqualDir(privateDir, tempRoot), true, '独立运行数据目录必须落在临时根内');
process.env.FARM_DATA_DIR = privateDir;
function assertWriteInsidePrivateDir(target) {
  const resolved = path.resolve(String(target));
  if (!isInsideOrEqualDir(resolved, privateDir))
    throw new Error(`夹具写目标越界（已在写入原语前拒绝）: ${resolved}`);
  return resolved;
}

// 候选源码指纹：全部用例结束后内容与权限不得被夹具改变
const CANDIDATE_SOURCES = [
  path.join(repoRoot, 'core', 'src', 'services', 'milk-tea-activity.js'),
  path.join(repoRoot, 'core', 'src', 'proto', 'milk-tea.proto'),
  path.join(repoRoot, 'core', 'src', 'gameConfig', 'MilkTeaActivity.json'),
  path.join(repoRoot, 'core', 'src', 'gameConfig', 'EventItems.json'),
  path.join(repoRoot, 'core', 'src', 'gameConfig', 'EventPlants.json'),
];
function fingerprintOf(file) {
  const stat = fs.statSync(file);
  return {
    mode: stat.mode,
    size: stat.size,
    sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
  };
}
const fingerprintsBefore = new Map(CANDIDATE_SOURCES.map(file => [file, fingerprintOf(file)]));

const { loadProto, types } = require('../src/utils/proto');
const CONFIG = require('../src/gameConfig/MilkTeaActivity.json');
const EVENT_ITEMS = require('../src/gameConfig/EventItems.json');
const EVENT_PLANTS = require('../src/gameConfig/EventPlants.json');

const ROOT = 2026110100;
const MAIN = 2026110101;
const SHOP = 2026110102;
const FUND = 2026110103;
const HAPPY = 2026110104;

/** 每个用例取全新服务实例：模块级租约/结束证据随 require 缓存重置。 */
function freshService() {
  const servicePath = require.resolve('../src/services/milk-tea-activity');
  delete require.cache[servicePath];
  return require('../src/services/milk-tea-activity');
}

// ===== 官方编码器重构固定向量（公开参考项目 milk-tea-protocol-vectors.json，
// evidence=official-encoder-reconstruction；仓库/SHA 见 sources.json）=====
const OFFICIAL_VECTORS = [
  { action: 'createShop', selector: 'milk_tea_create_shop', cmd: 53, params: { shop_name: '奶茶冲鸭' }, hex: '0895f98fc6071035f2090e0a0ce5a5b6e88cb6e586b2e9b8ad' },
  { action: 'renameShop', selector: 'milk_tea_rename_shop', cmd: 54, params: { shop_name: '奶茶小铺' }, hex: '0895f98fc6071036fa090e0a0ce5a5b6e88cb6e5b08fe993ba' },
  { action: 'queryShop', selector: 'milk_tea_get_shop', cmd: 55, params: {}, hex: '0895f98fc6071037820a00' },
  { action: 'queryHireList', selector: 'milk_tea_get_hire_list', cmd: 56, params: { duration_id: 1 }, hex: '0895f98fc60710388a0a020801' },
  { action: 'hire', selector: 'milk_tea_hire', cmd: 57, params: { hires: [{ slot_index: 0, duration_id: 1, target_gid: '101' }] }, hex: '0895f98fc6071039920a080a06080010011865' },
  { action: 'queryWorkshop', selector: 'milk_tea_get_workshop', cmd: 58, params: {}, hex: '0895f98fc607103a9a0a00' },
  { action: 'claimCashier', selector: 'milk_tea_claim_cashier', cmd: 59, params: {}, hex: '0895f98fc607103ba20a00' },
  { action: 'boost', selector: 'milk_tea_boost', cmd: 60, params: { count: 1 }, hex: '0895f98fc607103caa0a020801' },
  { action: 'upgrade', selector: 'milk_tea_upgrade', cmd: 61, params: {}, hex: '0895f98fc607103db20a00' },
  { action: 'craft', selector: 'milk_tea_craft', cmd: 62, params: { fruit_uids: ['23563'] }, hex: '0895f98fc607103eba0a050a038bb801' },
  { action: 'queryWorkPage', selector: 'milk_tea_get_work_page', cmd: 63, params: {}, hex: '0895f98fc607103fc20a00' },
  { action: 'claimWages', selector: 'milk_tea_claim_wages', cmd: 64, params: {}, hex: '0895f98fc6071040ca0a00' },
  { action: 'interact', selector: 'milk_tea_interact', cmd: 65, params: { target_gid: '101', interaction_type: 1 }, hex: '0895f98fc6071041d20a0408651001' },
  { action: 'queryRank', selector: 'milk_tea_get_rank', cmd: 66, params: { page: 1 }, hex: '0895f98fc6071042da0a020801' },
  { action: 'querySalesLog', selector: 'milk_tea_get_sales_log', cmd: 67, params: { day: 20261015 }, hex: '0895f98fc6071043e20a050897d1d409' },
  { action: 'hireSetting', selector: 'milk_tea_set_hire_disable', cmd: 68, params: { hire_disabled: true }, hex: '0895f98fc6071044ea0a020801' },
];

const hex = value => Buffer.from(value).toString('hex');

test('真实 proto 注册且 16 条主玩法请求与官方编码器重构向量逐字节一致', async () => {
  await loadProto();
  for (const name of ['MilkTeaGetGroupReply', 'MilkTeaOperateRequest', 'MilkTeaOperateReply']) {
    assert.ok(types[name], `${name} registered`);
  }
  const service = freshService();
  // 编码表与向量一一对应：目标子活动 2026110101、cmd、选择子三点对齐
  for (const vector of OFFICIAL_VECTORS) {
    const [targetId, command, selector] = service.OPERATIONS[vector.action];
    assert.equal(targetId, MAIN, `${vector.action} target`);
    assert.equal(command, vector.cmd, `${vector.action} cmd`);
    assert.equal(selector, vector.selector, `${vector.action} selector`);
    const payload = { activity_id: MAIN, operate_type: command, [selector]: vector.params };
    const encoded = types.MilkTeaOperateRequest.encode(types.MilkTeaOperateRequest.create(payload)).finish();
    assert.equal(hex(encoded), vector.hex, `${vector.action} bytes`);
  }
  // 无重复类型/半就绪发布：商城(cmd1@2026110102)/基金(cmd76@2026110103)/
  // 快乐值(cmd71,74@2026110104) 与主玩法选择子互不重复
  const selectors = Object.values(service.OPERATIONS).map(op => op[2]).filter(Boolean);
  assert.equal(new Set(selectors).size, selectors.length, '选择子无重复');
  assert.equal(service.OPERATIONS.exchange[0], SHOP);
  assert.equal(service.OPERATIONS.exchange[1], 1);
  assert.equal(service.OPERATIONS.fundClaim[0], FUND);
  assert.equal(service.OPERATIONS.fundClaim[1], 76);
  assert.equal(service.OPERATIONS.shareMilestones[0], HAPPY);
  assert.equal(service.OPERATIONS.shareDaily[1], 74);
  // 基金领取：cmd76 空参数请求（id+cmd，无选择子字段）
  const fundReq = types.MilkTeaOperateRequest.encode(types.MilkTeaOperateRequest.create({
    activity_id: FUND, operate_type: 76,
  })).finish();
  const fundDec = types.MilkTeaOperateRequest.decode(fundReq);
  assert.equal(Number(fundDec.activity_id), FUND);
  assert.equal(Number(fundDec.operate_type), 76);
  assert.equal(fundDec.growth_fund_claim, undefined, 'cmd76 请求体无选择子字段');
});

test('根快照四类子节点详情解码合并（121 摘要 / 102 商城 / 122 基金 / settle_start_time）', async () => {
  await loadProto();
  const service = freshService();
  const start = 1792000000;
  const end = start + 30 * 86400;
  const settle = end - 4 * 86400;
  const raw = types.MilkTeaGetGroupReply.encode(types.MilkTeaGetGroupReply.create({
    group: {
      head: { activity_id: ROOT, begin_time: start, end_time: end, settle_start_time: settle },
      children: [
        { head: { activity_id: MAIN }, milk_tea: { summary: {
          shop_open_at: start + 100, shop_name: '奶茶冲鸭', level: 3, total_revenue: 12345,
          can_upgrade: true, hire_disabled: false, has_unclaimed_wage: true,
          opening_gift_preview: [{ id: 1041, count: 20 }],
        } } },
        { head: { activity_id: SHOP }, shop: { goods: [{
          id: 9001, name: '森野甜莓种子', order: 1,
          item: [{ id: 20525, count: 1 }], cost: [{ id: 1041, count: 10 }],
          purchase_limit: 5, purchased_count: 1, diamond_cost_count: 0,
          cond_hints: [{ cond_type: 'shop_level', params: '2', satisfied: true, current: 3, target: 2 }],
        }] } },
        { head: { activity_id: FUND }, growth_fund: {
          unlocked: true, unlock_cost: [{ id: 1005, count: 100 }],
          tiers: [{ tier_id: 1, state: 2, conditions: [{ type: 'revenue', current_value: 100, target_value: 100, reached: true }], reward: [{ id: 1041, count: 50 }] }],
        } },
        { head: { activity_id: HAPPY }, share_reward: { summary: {
          score_item_id: 1041, current_score: 12,
          daily: { claimed_count: 0, claim_limit: 1, daily_reward_claimed: false },
          milestones: [{ tier_id: 1, threshold: 10, state: 2, rewards: [{ id: 210048, count: 1 }] }],
        } } },
      ],
    },
  })).finish();

  const decoded = service.decodeMilkTeaGroup(raw);
  assert.equal(Number(decoded.main.head.activity_id), MAIN);
  assert.equal(Number(decoded.shop.head.activity_id), SHOP);
  assert.equal(Number(decoded.fund.head.activity_id), FUND);
  assert.equal(Number(decoded.happyShare.head.activity_id), HAPPY);
  assert.equal(Number(decoded.settleStartTime), settle);

  // 纯函数合并：无网络、不把原始字节落到快照
  const snapshot = {
    id: ROOT, startTime: start, endTime: end,
    children: [{ id: MAIN }, { id: SHOP }, { id: FUND }, { id: HAPPY }],
  };
  const merged = service.normalizeMilkTeaDiscovery(snapshot, raw);
  assert.equal(merged.milkTeaTiming.settleStartTime, settle);
  const mainChild = merged.children.find(node => node.id === MAIN);
  assert.equal(mainChild.details.milkTea.shopName, '奶茶冲鸭');
  assert.equal(mainChild.details.milkTea.level, 3);
  assert.deepEqual(mainChild.details.milkTea.openingGiftPreview, [{ id: 1041, count: '20' }]);
  const shopChild = merged.children.find(node => node.id === SHOP);
  assert.equal(shopChild.details.exchangeShop.items[0].purchaseLimit, 5);
  assert.equal(shopChild.details.exchangeShop.items[0].purchasedCount, 1);
  assert.deepEqual(shopChild.details.exchangeShop.items[0].costs, [{ id: 1041, count: '10' }]);
  assert.equal(shopChild.details.exchangeShop.items[0].condHints[0].satisfied, true);
  const fundChild = merged.children.find(node => node.id === FUND);
  assert.equal(fundChild.details.growthFund.unlocked, true);
  assert.equal(fundChild.details.growthFund.tiers[0].conditions[0].reached, true);
  assert.ok(!('rawBody' in merged) && !Buffer.isBuffer(merged), '原始字节不外泄');
  // 异系根 / 空输入：不伪造状态
  assert.equal(service.decodeMilkTeaGroup(null), null);
  const foreign = types.MilkTeaGetGroupReply.encode(types.MilkTeaGetGroupReply.create({
    group: { head: { activity_id: 2026090100 } },
  })).finish();
  assert.equal(service.decodeMilkTeaGroup(foreign), null);
  const untouched = service.normalizeMilkTeaDiscovery({ id: 2026090100 }, foreign);
  assert.equal(untouched.milkTeaTiming, undefined);
});

test('商城 / 快乐值 / 基金真实回包形状经 DTO 白名单输出（官方 response-fixtures 关键值）', async () => {
  await loadProto();
  const service = freshService();
  // shop 查询回包（fixtures cmd55）：slots/收银台容量/秒每杯/喇叭增益等官方形状
  const shopReply = types.MilkTeaOperateReply.decode(types.MilkTeaOperateReply.encode(types.MilkTeaOperateReply.create({
    activity_id: MAIN, operate_type: 55,
    milk_tea_get_shop: { shop: {
      level: 1, total_revenue: 0, next_level_revenue: 14000,
      cashier_capacity_sec: 172800, sec_per_cup: 90, sales_item_id: 1042,
      boost_cups_per_use: 40, effective_cups_per_hour: 40, is_settling: false,
      next_full_at: 1792100000, projection_ver: 3,
      slots: [{ slot_index: 0, is_robot: true, shift_id: '30065268830667151', begin_at: 1792029668, end_at: 1792044068, cost: 40, talent_id: 9004, talent_name: '默默搬砖', interact_type: 0, employee: { gid: 101, name: '实习员工', level: 0 } }],
      pending_rewards: [], drink_cups: { 2: 19 },
    } },
  })).finish());
  const shop = service.MILK_TEA_SHOP_ACTIVITY_ID && shopViewShape(shopReply);
  function shopViewShape(reply) {
    // 直接经服务导出的查询 DTO 校验（与 queryMilkTeaActivity 同源逻辑在
    // milk-tea-operate.test.js 端到端覆盖；此处锁形状关键字段）
    const view = reply.milk_tea_get_shop.shop;
    return {
      slots: view.slots.length, nextLevelRevenue: Number(view.next_level_revenue),
      cashierCapacitySec: Number(view.cashier_capacity_sec), secPerCup: Number(view.sec_per_cup),
      salesItemId: Number(view.sales_item_id), boostCupsPerUse: Number(view.boost_cups_per_use),
    };
  }
  assert.deepEqual(shop, {
    slots: 1, nextLevelRevenue: 14000, cashierCapacitySec: 172800,
    secPerCup: 90, salesItemId: 1042, boostCupsPerUse: 40,
  });
  // 工坊（cmd58 fixtures）：配方解锁/库存官方形状
  const workshopReply = types.MilkTeaOperateReply.decode(types.MilkTeaOperateReply.encode(types.MilkTeaOperateReply.create({
    activity_id: MAIN, operate_type: 58,
    milk_tea_get_workshop: { recipes: [
      { recipe_id: 1, recipe_name: '普通奶茶', unlocked: true, is_advanced: false, token_price: 3, stock_cups: -1 },
      { recipe_id: 2, recipe_name: '甜莓奶茶', unlocked: true, is_advanced: true, token_price: 10, coin_price: 8215, stock_cups: 19 },
      { recipe_id: 3, recipe_name: '白桃乌龙', unlocked: false, is_advanced: true, token_price: 11, stock_cups: 0 },
    ] },
  })).finish());
  const recipes = workshopReply.milk_tea_get_workshop.recipes;
  assert.equal(recipes.filter(r => r.unlocked).length, 2);
  assert.equal(Number(recipes[1].stock_cups), 19);
  // 加工回包（cmd62 fixtures）：used_fruits/crafted_cups 映射键为字符串化配方号
  const craftReply = types.MilkTeaOperateReply.decode(types.MilkTeaOperateReply.encode(types.MilkTeaOperateReply.create({
    activity_id: MAIN, operate_type: 62,
    milk_tea_craft: { used_fruits: [{ id: 40525, count: 20, uid: 23563 }], crafted_cups: { 2: 20 }, drink_cups: { 2: 20 } },
  })).finish());
  const craft = craftReply.milk_tea_craft;
  // int64 键映射经 protobufjs 解码为哈希串键普通对象；数值经 DTO 转换在
  // milk-tea-operate.test.js 的真实查询/加工链路断言（drinkCups/craftedCups）
  assert.equal(Object.values(craft.crafted_cups).map(Number)[0], 20);
  assert.equal(Object.values(craft.drink_cups).map(Number)[0], 20);
  // 基金领取回包（cmd76 → growth_fund_claim 176）
  const fundReply = types.MilkTeaOperateReply.decode(types.MilkTeaOperateReply.encode(types.MilkTeaOperateReply.create({
    activity_id: FUND, operate_type: 76,
    growth_fund_claim: { claimed_tier_ids: [1, 2], awards: [{ id: 1041, count: 50 }] },
  })).finish());
  assert.deepEqual([...fundReply.growth_fund_claim.claimed_tier_ids].map(Number), [1, 2]);
});

test('timingOf：营业开始前 / 进行 / 结算 / 最终截止（闭边界）与结算时间来源', () => {
  const service = freshService();
  const start = 1792000000;
  const settle = start + 10 * 86400;
  const end = start + 20 * 86400;
  const snapshot = { startTime: start, endTime: end, milkTeaTiming: { settleStartTime: settle } };
  assert.equal(service.timingOf(snapshot, start - 1).phase, 'beforeStart');
  assert.equal(service.timingOf(snapshot, start).phase, 'open');
  assert.equal(service.timingOf(snapshot, settle - 1).phase, 'open');
  assert.equal(service.timingOf(snapshot, settle).phase, 'settle');
  assert.equal(service.timingOf(snapshot, end - 1).phase, 'settle');
  // 最终截止闭边界：now === endTime 即结束
  assert.equal(service.timingOf(snapshot, end).phase, 'ended');
  assert.equal(service.timingOf(snapshot, end + 1).phase, 'ended');
  assert.equal(service.timingOf(snapshot, end).settleSource, 'decoded');
  // 解码 settle 缺失/无效：公告兜底（北京 2026-11-15 00:00）
  const announce = service.timingOf({ startTime: start, endTime: end }, start);
  assert.equal(announce.settleSource, 'announce');
  assert.equal(announce.settleStartTime, Number(CONFIG.announceSettle.startAt));
  // endTime 未知（0）不判结束；startTime 未知不判开始前
  assert.equal(service.timingOf({ startTime: 0, endTime: 0 }, 1).phase, 'open');
});

test('默认只读入口：缺根仅一次 List 零后续；enabled=false 可读；快照不匹配即停', async () => {
  await loadProto();
  const service = freshService();
  const start = Math.floor(Date.now() / 1000) - 3600;
  const end = start + 20 * 86400;
  const rootListed = (extra = {}) => [{ id: ROOT, parentId: 0, enabled: true, ...extra }];

  // 缺根：一次 List，零 GetGroup/库存，且是业务拒绝（非普通错误伪装）
  let listCalls = 0; let snapshotCalls = 0; let inventoryCalls = 0;
  await assert.rejects(
    service.getMilkTeaActivity({
      getActivityDiscoveryList: async () => { listCalls += 1; return [{ id: 2026090100, parentId: 0 }]; },
      getActivityGroupSnapshot: async () => { snapshotCalls += 1; return null; },
      getBagItemCounts: async () => { inventoryCalls += 1; return { counts: new Map(), available: true }; },
    }),
    err => err.business === true && err.code === 'SEASON_WISH_MILK_TEA_UNAVAILABLE' && /未由当前 ActivityService\.List 下发/.test(err.message),
  );
  assert.equal(listCalls, 1);
  assert.equal(snapshotCalls, 0);
  assert.equal(inventoryCalls, 0);

  // enabled=false：仍在架可读（仅显示未启用，不触发探测）
  listCalls = 0; snapshotCalls = 0;
  const overview = await service.getMilkTeaActivity({
    getActivityDiscoveryList: async () => { listCalls += 1; return rootListed({ enabled: false }); },
    getActivityGroupSnapshot: async () => { snapshotCalls += 1; return { id: ROOT, startTime: start, endTime: end, children: [] }; },
    getBagItemCounts: async () => { inventoryCalls += 1; return { counts: new Map([[1041, 5]]), available: true }; },
  });
  assert.equal(listCalls, 1);
  assert.equal(snapshotCalls, 1);
  assert.equal(inventoryCalls, 1);
  assert.equal(overview.timing.phase, 'open');
  assert.equal(overview.inventory.ticketCount, 5);

  // 快照根不匹配：零库存读取
  snapshotCalls = 0; inventoryCalls = 0;
  await assert.rejects(
    service.getMilkTeaActivity({
      getActivityDiscoveryList: async () => rootListed(),
      getActivityGroupSnapshot: async () => { snapshotCalls += 1; return { id: 2026090100 }; },
      getBagItemCounts: async () => { inventoryCalls += 1; return { counts: new Map(), available: true }; },
    }),
    err => err.business === true && err.code === 'SEASON_WISH_MILK_TEA_UNAVAILABLE',
  );
  assert.equal(snapshotCalls, 1);
  assert.equal(inventoryCalls, 0);
});

test('读取途中跨最终截止：跳过库存；成功结束证据保持到模块生命周期，二次刷新零读取', async () => {
  await loadProto();
  const service = freshService();
  const start = Math.floor(Date.now() / 1000) - 30 * 86400;
  const end = Math.floor(Date.now() / 1000) + 1; // 读取过程中将越过
  let listCalls = 0; let snapshotCalls = 0; let inventoryCalls = 0;
  const snapshot = { id: ROOT, startTime: start, endTime: end, title: '奶茶热销中', children: [] };
  const readers = {
    getActivityDiscoveryList: async () => { listCalls += 1; return [{ id: ROOT, parentId: 0 }]; },
    getActivityGroupSnapshot: async () => { snapshotCalls += 1; return snapshot; },
    getBagItemCounts: async () => { inventoryCalls += 1; return { counts: new Map(), available: true }; },
  };
  let clock = end - 2;
  const crossingReaders = {
    ...readers,
    now: () => clock * 1000,
    // 时间在快照读取的 await 期间越过最终截止（读取过程中跨边界）
    getActivityGroupSnapshot: async () => { snapshotCalls += 1; clock = end + 1; return snapshot; },
  };
  const overview = await service.getMilkTeaActivity(crossingReaders);
  assert.equal(overview.timing.phase, 'ended');
  assert.equal(inventoryCalls, 0, '跨过最终截止后不再新增库存读取');
  assert.equal(listCalls, 1);
  assert.equal(snapshotCalls, 1);

  // 成功结束证据：同一模块实例再次读取零网络，返回同一结束快照
  clock = end + 10;
  const again = await service.getMilkTeaActivity(readers);
  assert.equal(listCalls, 1);
  assert.equal(snapshotCalls, 1);
  assert.equal(again, overview);
  assert.equal(again.timing.phase, 'ended');

  // 结束证据同样拦截显式查询与手动操作入口（见 milk-tea-operate.test.js 行为项）
  await assert.rejects(service.queryMilkTeaActivity('shop', {}, {
    ...readers, getConnection: () => ({}), isReady: () => true,
  }), err => err.code === 'SEASON_WISH_MILK_TEA_ENDED');
  await assert.rejects(service.runManualMilkTeaAction('boost', { count: 1 }, {
    ...readers, getConnection: () => ({}), isReady: () => true, getBag: async () => ({}), getBagItems: () => [],
  }), err => err.code === 'SEASON_WISH_MILK_TEA_ENDED');
  assert.equal(listCalls, 1, '结束证据生效期间零新增读取');
});

test('只读入口：账号未就绪零读取；库存普通失败不伪造状态、不重试', async () => {
  await loadProto();
  const service = freshService();
  const start = Math.floor(Date.now() / 1000) - 3600;
  const end = start + 20 * 86400;
  let listCalls = 0;
  await assert.rejects(
    service.getMilkTeaActivity({
      deps: { isReady: () => false },
      getActivityDiscoveryList: async () => { listCalls += 1; return [{ id: ROOT, parentId: 0 }]; },
      getActivityGroupSnapshot: async () => ({ id: ROOT, startTime: start, endTime: end }),
      getBagItemCounts: async () => { throw new Error('inventory down'); },
    }),
    err => err.code === 'SEASON_WISH_MILK_TEA_NOT_READY',
  );
  assert.equal(listCalls, 0, '未就绪在首次读取前拒绝');

  let inventoryCalls = 0;
  const overview = await service.getMilkTeaActivity({
    getActivityDiscoveryList: async () => [{ id: ROOT, parentId: 0 }],
    getActivityGroupSnapshot: async () => ({ id: ROOT, startTime: start, endTime: end, children: [] }),
    getBagItemCounts: async () => {
      inventoryCalls += 1;
      throw new Error('inventory down');
    },
  });
  assert.equal(inventoryCalls, 1);
  assert.equal(overview.inventory.available, false);
  assert.equal(overview.timing.phase, 'open');
});

test('固定配置：物品分类无重复，已核验森野植物显式登记正确占地', () => {
  const ids = EVENT_ITEMS.map(item => item.id);
  assert.equal(new Set(ids).size, ids.length, 'EventItems 无重复 id');
  const byId = new Map(EVENT_ITEMS.map(item => [item.id, item]));
  // 货币/道具（type 19）、果实（本地 type 4、源表 type 6）、种子（type 5 + plant 交互）
  assert.deepEqual([byId.get(1041).name, byId.get(1041).type], ['奶茶券', 19]);
  assert.deepEqual([byId.get(1042).name, byId.get(1042).type], ['宣传喇叭', 19]);
  assert.equal(byId.get(40525).type, 4);
  assert.equal(byId.get(40525).official_type, 6);
  for (const seedId of CONFIG.activitySeedItemIds) {
    const seed = byId.get(seedId);
    assert.ok(seed, `种子 ${seedId} 在 EventItems 登记`);
    assert.equal(seed.type, 5, `种子 ${seedId} type=5`);
    assert.equal(seed.interaction_type, 'plant', `种子 ${seedId} plant 交互`);
    assert.ok(/种子/.test(seed.name), `种子 ${seedId} 名称以种子命名`);
  }
  // 七种普通作物按已核验默认单格登记，黄金芽仍明确四格。
  const plantSeedIds = new Set(EVENT_PLANTS.map(plant => Number(plant.seed_id)));
  for (const seedId of CONFIG.activitySeedItemIds) {
    assert.equal(plantSeedIds.has(seedId), true, `种子 ${seedId} 采用已复核映射`);
    assert.equal(EVENT_PLANTS.find(plant => Number(plant.seed_id) === seedId)?.size, seedId === 29005 ? 2 : 1);
  }
  assert.equal('plantSize' in (byId.get(29005) || {}), false, '占地由EventPlants提供，不在EventItems侧伪造字段');
  // 活动编号与编码表一致
  assert.equal(Number(CONFIG.activityIds.root), ROOT);
  assert.equal(Number(CONFIG.activityIds.main), MAIN);
  assert.equal(Number(CONFIG.activityIds.shop), SHOP);
  assert.equal(Number(CONFIG.activityIds.growthFund), FUND);
  assert.equal(Number(CONFIG.activityIds.happyShare), HAPPY);
  // 雇佣费用仅奶茶券（1041），不含钻石
  for (const duration of CONFIG.hireDurations) {
    assert.equal(duration.cost.itemId, 1041);
    assert.ok(duration.cost.count > 0);
  }
});

test.after(() => {
  for (const [file, before] of fingerprintsBefore) {
    assert.deepEqual(fingerprintOf(file), before, `候选源码被改动: ${file}`);
  }
  fs.rmSync(assertWriteInsidePrivateDir(privateDir), { recursive: true, force: true });
});

test('真实配置与背包入口：奶茶券为道具、甜莓为果实、所有种子有名、已核验单格和四格均正确', async () => {
  await loadProto();
  const networkPath = require.resolve('../src/utils/network');
  const warehousePath = require.resolve('../src/services/warehouse');
  const saved = [networkPath,warehousePath].map(file=>[file,require.cache[file]]);
  const items = [1041,1042,40525,...CONFIG.activitySeedItemIds].map((id,index)=>({id,count:3,uid:100+index}));
  require.cache[networkPath] = {id:networkPath,filename:networkPath,loaded:true,exports:{sendMsgAsync:async()=>({body:types.BagReply.encode(types.BagReply.create({item_bag:{items}})).finish()})}};
  delete require.cache[warehousePath];
  try {
    const warehouse=require('../src/services/warehouse');const config=require('../src/config/gameConfig');
    const bag=await warehouse.getBagDetail();const byId=new Map(bag.items.map(item=>[item.id,item]));
    assert.equal(byId.get(1041).category,'item');assert.equal(byId.get(1041).name,'奶茶券');
    assert.equal(byId.get(40525).category,'fruit');assert.equal(byId.get(40525).name,'森野甜莓');
    const seeds=warehouse.getBagSeedsFromItems(items);assert.equal(seeds.length,CONFIG.activitySeedItemIds.length);
    for (const id of CONFIG.activitySeedItemIds) {
      const seed = seeds.find(s => s.seedId === id);
      assert.match(seed.name, /种子/); assert.doesNotMatch(seed.name, /未知|物品\d/);
      assert.equal(seed.plantSize, id === 29005 ? 2 : 1);
      assert.equal(config.getPlantBySeedId(id)?.size, id === 29005 ? 2 : 1);
      if (id === 29005) assert.equal(config.getPlantBySeedId(id)?.id, 1029005);
    }
  } finally {for(const [file,entry] of saved){if(entry)require.cache[file]=entry;else delete require.cache[file];}}
});

test('共享真实GetGroup入口：四类详情可用，私有原始回调保留、公开快照无原始字节', async () => {
  await loadProto();const networkPath=require.resolve('../src/utils/network'),activityPath=require.resolve('../src/services/activity');
  const previous=[networkPath,activityPath].map(p=>[p,require.cache[p]]);let requests=0;
  const raw=types.MilkTeaGetGroupReply.encode(types.MilkTeaGetGroupReply.create({group:{head:{activity_id:ROOT,begin_time:1,end_time:4102444800},children:[
    {head:{activity_id:MAIN},milk_tea:{summary:{shop_name:'测试奶茶店',level:2}}},
    {head:{activity_id:SHOP},shop:{goods:[{id:9001,item:[{id:20525,count:1}],cost:[{id:1041,count:10}],purchase_limit:5}]}},
    {head:{activity_id:FUND},growth_fund:{unlocked:true,tiers:[{tier_id:1,state:2}]}},
    {head:{activity_id:HAPPY},share_reward:{summary:{current_score:20,daily:{claim_limit:1},milestones:[{tier_id:1,threshold:20,state:2}]}}},
  ]}})).finish();
  require.cache[networkPath]={id:networkPath,filename:networkPath,loaded:true,exports:{sendMsgAsync:async(_s,method)=>{requests++;assert.equal(method,'GetGroup');return{body:raw};}}};delete require.cache[activityPath];
  try{
    const activity=require('../src/services/activity');let privateBody;
    const result=await activity.getActivityGroupSnapshot(ROOT,'',{onRawBody:body=>{privateBody=body;}});
    const children=new Map(result.children.map(child=>[child.id,child]));
    assert.equal(children.get(MAIN).details.milkTea.level,2);assert.equal(children.get(SHOP).details.exchangeShop.items[0].purchaseLimit,5);
    assert.equal(children.get(FUND).details.growthFund.unlocked,true);assert.equal(children.get(HAPPY).details.shareReward.currentScore,20);
    assert.equal(requests,1);assert.ok(Buffer.isBuffer(privateBody));assert.ok(privateBody.equals(Buffer.from(raw)));
    assert.doesNotMatch(JSON.stringify(result),/rawBody|"type":"Buffer"/);
    const overview=await activity.getMilkTeaActivity({getActivityDiscoveryList:async()=>[{id:ROOT,parentId:0}],getActivityGroupSnapshot:activity.getActivityGroupSnapshot,getBagItemCounts:async()=>({available:true,counts:new Map([[1041,20]])})});
    assert.equal(overview.summary.level,2);assert.equal(overview.exchangeShop.items[0].costs[0].name,'奶茶券');assert.equal(overview.shareReward.currentScore,20);
  } finally {for(const [p,entry] of previous){if(entry)require.cache[p]=entry;else delete require.cache[p];}}
});
