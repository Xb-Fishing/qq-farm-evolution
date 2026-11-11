const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// 商店补种先消耗背包库存、只为缺口购买（2026-11-11）端到端回归：真实
// plantFromShop + 真实 proto 编解码（Plant / BuyGoods 边界解码验数量）+
// 真实植物配置，仅在上游传输边界（sendMsgAsync）与背包/配置读取注入可控
// 模拟，不触真实账号、不执行游戏或外部代码。
// 断言核心：选定真实商店种子后每个补种批次至多一次新鲜 Bag 读取；库存
// 优先、只为差额购买；金币/限购只截断购买量，已持有库存仍要种；背包
// 读取抛错/非数组/匹配数量非法时本轮零买零种（未知不当 0 买）；购买
// 失败不重试、不种植、不虚扣钱包；本地回退不加读取不购买。

// 独立数据目录：首次 require 业务模块前完成创建与路径边界检查。
const originalDataDir = process.env.FARM_DATA_DIR;
const fixtureRoot = fs.realpathSync(os.tmpdir());
const repoRoot = fs.realpathSync(path.resolve(__dirname, '..', '..'));
if (fixtureRoot === repoRoot || fixtureRoot.startsWith(repoRoot + path.sep)) {
  throw new Error('fixture root must be outside the source repository');
}
const fixturePrefix = path.resolve(fixtureRoot, 'planting-shop-stock-');
if (path.dirname(fixturePrefix) !== fixtureRoot) throw new Error('fixture creation out of bounds');
const fixtureDataDir = fs.mkdtempSync(fixturePrefix);
process.env.FARM_DATA_DIR = fixtureDataDir;
test.after(() => {
  if (originalDataDir === undefined) delete process.env.FARM_DATA_DIR;
  else process.env.FARM_DATA_DIR = originalDataDir;
  fs.rmSync(fixtureDataDir, { recursive: true, force: true });
  process.on('exit', () => fs.rmSync(fixtureDataDir, { recursive: true, force: true }));
});

const realUtils = require('../src/utils/utils');

const SEED_ID = 20002; // 白萝卜：1x1，本地目录与植物配置都存在
const GOODS_ID = 11;
const PRICE = 3;

// 合成身份 + 可控服务端状态：背包/商店/金币全部为夹具数据。
const state = {
  account: 'fixture-account-a',
  level: 200,
  bag: new Map(),          // seedId -> count（购买入包、种下消耗，模拟服务端）
  shopGoods: [],           // ShopInfoReply goods_list 夹具
  shopInfoError: null,     // 商店不可用（触发本地回退）
  buyError: null,          // BuyGoods 拒绝/超时注入
  buySeedId: undefined,
  buyCalls: [],            // BuyGoods 边界真实解码后的 { goodsId, num, price }
  plantCalls: [],          // Plant 边界真实解码后的 { seedId, landIds }
  plantFailLands: new Set(),
  bagError: null,          // getBagSeeds 抛错注入
  bagSeedsOverride: undefined, // 背包坏返回注入（非数组等）
  bagReads: 0,
  purchaseMarkers: [],
  walletCorrections: [],
};

function mockModule(filename, exports) {
  return { id: filename, filename, loaded: true, exports };
}

const utilsPath = require.resolve('../src/utils/utils');
const networkPath = require.resolve('../src/utils/network');
const warehousePath = require.resolve('../src/services/warehouse');
const fertilizerPath = require.resolve('../src/services/farm-fertilizer');
const analyticsPath = require.resolve('../src/services/analytics');
const storePath = require.resolve('../src/models/store');
const servicePath = require.resolve('../src/services/planting-service');

const logs = [];
const warnings = [];

require.cache[utilsPath] = mockModule(utilsPath, {
  ...realUtils,
  log: (tag, message, meta) => logs.push({ tag, message, meta }),
  logWarn: (tag, message, meta) => warnings.push({ tag, message, meta }),
});

require.cache[networkPath] = mockModule(networkPath, {
  // 上游传输边界：所有请求用真实 proto 解码，验真实发出数量。
  sendMsgAsync: async (serviceName, methodName, payload, _timeout, options) => {
    const { types } = require('../src/utils/proto');
    if (serviceName === 'gamepb.shoppb.ShopService' && methodName === 'ShopInfo') {
      if (state.shopInfoError) throw state.shopInfoError;
      types.ShopInfoRequest.decode(payload);
      return {
        body: types.ShopInfoReply.encode(types.ShopInfoReply.create({
          goods_list: state.shopGoods.map(goods => ({ ...goods })),
        })).finish(),
      };
    }
    if (serviceName === 'gamepb.shoppb.ShopService' && methodName === 'BuyGoods') {
      const request = types.BuyGoodsRequest.decode(payload);
      const goodsId = Number(request.goods_id);
      const num = Number(request.num);
      const price = Number(request.price);
      // 先记录真实解码出的购买尝试，再注入拒绝/超时，断言“零重试”用。
      state.buyCalls.push({ goodsId, num, price });
      if (options?.ownFarmQuietPriority) state.purchaseMarkers.push(options.ownFarmQuietPriority);
      if (state.buyError) throw state.buyError;
      const goods = state.shopGoods.find(entry => Number(entry.id) === goodsId);
      const itemSeedId = state.buySeedId ?? (Number(goods && goods.item_id) || SEED_ID);
      if (num > 0) {
        // 购买成功真实入包 + 限购计数推进
        state.bag.set(itemSeedId, (state.bag.get(itemSeedId) || 0) + num);
        if (goods) goods.bought_num = Number(goods.bought_num || 0) + num;
      }
      return {
        body: types.BuyGoodsReply.encode(types.BuyGoodsReply.create({
          get_items: [{ id: itemSeedId, count: num }],
          cost_items: [{ id: 1, count: price * num }],
        })).finish(),
      };
    }
    if (serviceName === 'gamepb.plantpb.PlantService' && methodName === 'Plant') {
      const request = types.PlantRequest.decode(payload);
      const item = request.items && request.items[0];
      const seedId = Number(item.seed_id);
      const landIds = item.land_ids.map(Number);
      // 先记录真实解码出的种植尝试，再注入失败，断言尝试次数用。
      state.plantCalls.push({ seedId, landIds: [...landIds] });
      for (const landId of landIds) {
        if (state.plantFailLands.has(landId)) {
          throw new Error(`土地#${landId} 种植失败: fixture plant rejection`);
        }
      }
      if ((state.bag.get(seedId) || 0) < landIds.length) throw new Error('fixture stock exhausted');
      for (let index = 0; index < landIds.length; index++) {
        const left = (state.bag.get(seedId) || 0) - 1;
        if (left > 0) state.bag.set(seedId, left);
        else state.bag.delete(seedId);
      }
      return {
        body: types.PlantReply.encode(types.PlantReply.create({
          land: landIds.map(id => ({ id })),
        })).finish(),
      };
    }
    throw new Error(`unexpected wire call: ${serviceName}.${methodName}`);
  },
  getUserState: () => ({ accountId: state.account, gid: 12345, level: state.level, gold: 0 }),
  getWsErrorState: () => null,
  correctSessionWallet: (kind, payload) => state.walletCorrections.push({ kind, payload }),
});

require.cache[warehousePath] = mockModule(warehousePath, {
  getBagSeeds: async () => {
    state.bagReads += 1;
    if (state.bagError) throw state.bagError;
    if (state.bagSeedsOverride !== undefined) return state.bagSeedsOverride;
    return [...state.bag.entries()].map(([seedId, count]) => ({
      seedId, name: '白萝卜种子', count, requiredLevel: 1, plantSize: 1,
    }));
  },
});
// farm-api 保持真实模块：buyGoods/getShopInfo 的真实 proto 编码在本测试
// 的 sendMsgAsync 边界解码验数量（不做模块级替身）。
require.cache[fertilizerPath] = mockModule(fertilizerPath, {
  runFertilizerByConfig: async () => ({}),
});
require.cache[analyticsPath] = mockModule(analyticsPath, {
  getPlantRankings: () => [],
});
require.cache[storePath] = mockModule(storePath, {
  getPlantingStrategy: () => 'level',
  getPreferredSeed: () => 0,
  getBagSeedPriority: () => [],
  getBagSeedFallbackStrategy: () => 'level',
  getPrioritize2x2Crops: () => false,
  getPlantOrderRandom: () => false,
  getPlantDelaySeconds: () => 0,
  isAutomationOn: () => true,
});

function resetShop({ limitCount = 0, boughtNum = 0, price = PRICE } = {}) {
  state.shopGoods = [{
    id: GOODS_ID, item_id: SEED_ID, price, unlocked: true, conds: [],
    limit_count: limitCount, bought_num: boughtNum,
  }];
}

function resetAll(opts = {}) {
  state.account = 'fixture-account-a';
  state.level = 200;
  state.bag = new Map();
  state.shopInfoError = null;
  state.buyError = null;
  state.buySeedId = undefined;
  state.buyCalls = [];
  state.plantCalls = [];
  state.plantFailLands = new Set();
  state.bagError = null;
  state.bagSeedsOverride = undefined;
  state.bagReads = 0;
  state.purchaseMarkers = [];
  state.walletCorrections = [];
  resetShop(opts);
}

async function loadService() {
  await require('../src/utils/proto').loadProto();
  return require('../src/services/planting-service');
}

async function reloadService() {
  delete require.cache[servicePath];
  return loadService();
}

async function callShop(landIds, gold) {
  const userState = { accountId: state.account, level: state.level, gold };
  const service = await loadService();
  const result = await service.plantFromShop(landIds, userState, undefined, state.account);
  return { result, userState };
}

test('购买成功但全部 Plant 失败：第二轮与模块重载后都复用已购库存，只买一次', async () => {
  resetAll();
  state.plantFailLands = new Set([1, 2]);

  // 第一轮：库存 0 → 真实 BuyGoods num=2；两块地 Plant 全部失败，种子留在背包。
  let round = await callShop([1, 2], 1000);
  assert.equal(state.buyCalls.length, 1);
  assert.equal(state.buyCalls[0].num, 2);
  assert.equal(state.buyCalls[0].goodsId, GOODS_ID);
  assert.equal(round.result.plantedCount, 0);
  assert.equal(state.bag.get(SEED_ID) || 0, 2);
  assert.equal(state.bagReads, 1, '每个商店补种批次恰好一次新鲜 Bag 读取');
  assert.equal(round.userState.gold, 1000 - PRICE * 2);

  // 第二轮（同模块）：新鲜 Bag 读到 2 颗已购库存 → 不再购买，只重试种植。
  state.plantCalls = [];
  round = await callShop([1, 2], 1000 - PRICE * 2);
  assert.equal(state.buyCalls.length, 1, '第二轮不得重复购买');
  assert.equal(state.plantCalls.length, 2);
  assert.equal(round.result.plantedCount, 0);
  assert.equal(state.bagReads, 2);
  assert.equal(round.userState.gold, 1000 - PRICE * 2, '复用库存不再扣钱包');

  // 重载模块后第三轮：仍按新鲜背包核算，不依赖任何模块内缓存。
  await reloadService();
  state.plantCalls = [];
  round = await callShop([1, 2], 1000 - PRICE * 2);
  assert.equal(state.buyCalls.length, 1, '模块重载后仍不得重复购买');
  assert.equal(state.plantCalls.length, 2);
  assert.equal(state.bagReads, 3);
});

test('部分 Plant 失败后按新鲜库存核算：第二轮只补真实差额', async () => {
  resetAll();
  state.plantFailLands = new Set([2]);

  // 第一轮：买 2，地块 1 种成、地块 2 失败 → 背包剩 1 颗已购种子。
  let round = await callShop([1, 2], 1000);
  assert.equal(state.buyCalls.length, 1);
  assert.equal(state.buyCalls[0].num, 2);
  assert.equal(round.result.plantedCount, 1);
  assert.equal(state.bag.get(SEED_ID) || 0, 1);

  // 第二轮空地 [2,3]（地块 1 已被占用）：库存 1 → 只买差额 1 颗。
  state.plantFailLands = new Set();
  round = await callShop([2, 3], 1000 - PRICE * 2);
  assert.deepEqual(state.buyCalls.map(call => call.num), [2, 1], '第二轮购买量必须是差额 1');
  assert.equal(round.result.plantedCount, 2);
  assert.equal(state.bag.has(SEED_ID), false, '库存与购买全部种下');
  assert.equal(round.userState.gold, 1000 - PRICE * 2 - PRICE * 1);
  assert.equal(state.bagReads, 2);
});

test('背包库存足够：零购买、零扣款，直接用库存种植', async () => {
  resetAll();
  state.bag.set(SEED_ID, 4);

  const { result, userState } = await callShop([1, 2], 1000);
  assert.equal(state.buyCalls.length, 0, '库存足够不得调用 BuyGoods');
  assert.equal(result.plantedCount, 2);
  assert.deepEqual(state.plantCalls.map(call => call.landIds), [[1], [2]]);
  assert.equal(userState.gold, 1000, '未购买不得虚扣钱包');
  assert.equal(state.bag.get(SEED_ID) || 0, 2);
  assert.equal(state.bagReads, 1);
});

test('部分库存：只购买缺口，日志与扣款绑定实际购买量', async () => {
  resetAll();
  state.bag.set(SEED_ID, 1);
  logs.length = 0;

  const { result, userState } = await callShop([1, 2, 3], 1000);
  assert.equal(state.buyCalls.length, 1);
  assert.equal(state.buyCalls[0].num, 2, '只买 3-1=2 的缺口');
  assert.equal(result.plantedCount, 3);
  assert.equal(userState.gold, 1000 - PRICE * 2);
  const buyLog = logs.find(entry => entry.meta && entry.meta.event === '购买种子' && entry.meta.result === 'ok');
  assert.ok(buyLog, '购买日志存在');
  assert.equal(buyLog.meta.count, 2);
  assert.equal(buyLog.meta.cost, PRICE * 2);
});

test('金币为 0：不购买，但已持有库存仍要种植', async () => {
  resetAll();
  state.bag.set(SEED_ID, 1);

  const { result, userState } = await callShop([1, 2, 3], 0);
  assert.equal(state.buyCalls.length, 0);
  assert.deepEqual(state.plantCalls.map(call => call.landIds), [[1]], '金币 0 仍种下已有的 1 颗库存');
  assert.equal(result.plantedCount, 1);
  assert.equal(userState.gold, 0);
  assert.equal(state.bag.has(SEED_ID), false);
});

test('金币有限：只购买可负担差额，超出部分不种不扣', async () => {
  resetAll();

  // 7 金币 / 单价 3 → 只买 2 颗，种 2 块地。
  const { result, userState } = await callShop([1, 2, 3, 4], 7);
  assert.equal(state.buyCalls.length, 1);
  assert.equal(state.buyCalls[0].num, 2);
  assert.equal(result.plantedCount, 2);
  assert.deepEqual(state.plantCalls.map(call => call.landIds), [[1], [2]]);
  assert.equal(userState.gold, 7 - PRICE * 2);
});

test('限购余量 1：购买量截断为 1；limit_count=0 保持不限购语义', async () => {
  // limit_count=5 / bought_num=4 → 余量 1：3 块空地只买 1 颗、种 1 块。
  resetAll({ limitCount: 5, boughtNum: 4 });
  let round = await callShop([1, 2, 3], 1000);
  assert.equal(round.result.plantedCount, 1);
  assert.equal(state.buyCalls.length, 1);
  assert.equal(state.buyCalls[0].num, 1, '限购余量 1 时只买 1 颗');
  assert.deepEqual(state.plantCalls.map(call => call.landIds), [[1]]);
  assert.equal(round.userState.gold, 1000 - PRICE);

  // limit_count=0（普通种子商店）：同场景不设限，按缺口全买。
  resetAll({ limitCount: 0, boughtNum: 7 });
  round = await callShop([1, 2, 3], 1000);
  assert.equal(round.result.plantedCount, 3);
  assert.equal(state.buyCalls[0].num, 3, 'limit_count=0 未设限语义保持');
});

test('背包返回非数组：本轮零购买零种植', async () => {
  resetAll();
  state.bagSeedsOverride = { code: -1, msg: 'bad reply' };

  const { result, userState } = await callShop([1, 2], 1000);
  assert.equal(state.buyCalls.length, 0);
  assert.equal(state.plantCalls.length, 0);
  assert.equal(result.plantedCount, 0);
  assert.equal(userState.gold, 1000);
  assert.equal(state.bagReads, 1);
});

test('背包读取抛错：本轮零购买零种植', async () => {
  resetAll();
  state.bagError = new Error('fixture bag read failure');
  state.bag.set(SEED_ID, 5);

  const { result, userState } = await callShop([1, 2], 1000);
  assert.equal(state.buyCalls.length, 0);
  assert.equal(state.plantCalls.length, 0);
  assert.equal(result.plantedCount, 0);
  assert.equal(userState.gold, 1000);
});

test('匹配库存数量非法（NaN/负数/小数）：本轮零购买零种植；缺目标项才是库存 0', async () => {
  for (const badCount of [Number.NaN, -3, 2.5, Infinity, Number.MAX_SAFE_INTEGER + 1,
    null, undefined, '', ' ', true, false, [], [0], {}, 'fixture-private-count']) {
    resetAll();
    warnings.length = 0;
    state.bagSeedsOverride = [{ seedId: SEED_ID, count: badCount, requiredLevel: 1, plantSize: 1 }];
    const { result, userState } = await callShop([1, 2], 1000);
    assert.equal(state.buyCalls.length, 0, `count=${badCount} 不得触发购买`);
    assert.equal(state.plantCalls.length, 0, `count=${badCount} 不得种植`);
    assert.equal(result.plantedCount, 0);
    assert.equal(userState.gold, 1000);
    assert.ok(warnings.every(entry => !entry.message.includes('fixture-private-count')), '不记录非法库存原文');
  }

  // 背包无该 seedId 匹配项（只有别的种子）：库存按 0 处理，正常购买。
  resetAll();
  state.bagSeedsOverride = [{ seedId: 20001, count: 9, requiredLevel: 1, plantSize: 1 }];
  const round = await callShop([1, 2], 1000);
  assert.equal(state.buyCalls.length, 1);
  assert.equal(state.buyCalls[0].num, 2, '无匹配项是库存 0，按缺口购买');
  assert.equal(round.result.plantedCount, 2);
});

test('购买被普通拒绝：不重试、不种植、不扣钱包（含已有库存也不种）', async () => {
  resetAll();
  state.bag.set(SEED_ID, 1);
  state.buyError = Object.assign(new Error('fixture: 金币不足'), { isServerBusinessError: true });

  const { result, userState } = await callShop([1, 2], 1000);
  assert.equal(state.buyCalls.length, 1, '购买被拒绝不得重试');
  assert.equal(state.plantCalls.length, 0, '购买失败后不得继续 Plant');
  assert.equal(result.plantedCount, 0);
  assert.equal(userState.gold, 1000, '失败购买不得扣钱包');
  assert.equal(state.bag.get(SEED_ID) || 0, 1, '库存原样保留');
});

test('购买超时：同样零重试零种植零扣款', async () => {
  resetAll();
  state.buyError = Object.assign(new Error('请求超时: BuyGoods'), { code: 'LOCAL_REQUEST_TIMEOUT' });

  const { result, userState } = await callShop([1, 2], 1000);
  assert.equal(state.buyCalls.length, 1, '超时不得当场重试');
  assert.equal(state.plantCalls.length, 0);
  assert.equal(result.plantedCount, 0);
  assert.equal(userState.gold, 1000);
});

test('本地回退（商店不可用）：沿用库存约束种植，不购买也不新增背包读取', async () => {
  resetAll();
  state.shopInfoError = new Error('fixture: shop unreachable');
  state.bag.set(SEED_ID, 3);

  const { result, userState } = await callShop([1, 2, 3, 4, 5], 1000);
  assert.equal(state.buyCalls.length, 0, '本地回退不得购买');
  assert.equal(result.plantedCount, 3, '按本地回退库存上限种植');
  assert.deepEqual(state.plantCalls.map(call => call.landIds), [[1], [2], [3]]);
  assert.equal(userState.gold, 1000);
  // findBestSeedFromLocal 的 1 次读取之外，plantFromShop 不得再读背包。
  assert.equal(state.bagReads, 1);
});

test('新账号新背包按新鲜读取核算，不沿用上一批库存', async () => {
  resetAll();
  state.bag.set(SEED_ID, 4);
  await callShop([1, 2], 1000);
  assert.equal(state.buyCalls.length, 0);
  assert.equal(state.bagReads, 1);

  // 换账号并把背包换成 3 颗：不得沿用上一批“库存充足”的结果。
  state.account = 'fixture-account-b';
  state.bag = new Map([[SEED_ID, 3]]);
  const round = await callShop([1, 2, 3, 4, 5], 1000);
  assert.equal(state.bagReads, 2, '新批次必须重新读背包');
  assert.equal(state.buyCalls.length, 1);
  assert.equal(state.buyCalls[0].num, 2, '新库存 3 颗只补 5-3=2 的缺口');
  assert.equal(round.result.plantedCount, 5);
  assert.equal(round.userState.gold, 1000 - PRICE * 2);
});

test('静默补种经真实作用域发送：购买标记只授权差额，Plant仍可用全部库存', async () => {
  resetAll();
  state.bag.set(SEED_ID, 1);
  const priority = require('../src/services/own-quiet-priority');
  await priority.run({ landIds: [1, 2] }, async scope => {
    scope.phase = 'replant';
    const round = await callShop([1, 2], 1000);
    assert.equal(round.result.plantedCount, 2);
    assert.equal(round.userState.gold, 1000 - PRICE);
  });
  assert.equal(state.buyCalls.length, 1);
  assert.equal(state.buyCalls[0].num, 1);
  assert.equal(state.purchaseMarkers.length, 1);
  assert.equal(state.purchaseMarkers[0].purchase.count, 1);
  assert.equal(state.purchaseMarkers[0].purchase.seedId, SEED_ID);
  assert.equal(state.purchaseMarkers[0].phase, 'replant');
  assert.equal(priority.isActive(), false, '作用域完成后不保留授权');
});

test('持久会话钱包经真实购买结果只结算差额，保持原钱包校正分支', async () => {
  resetAll();
  state.bag.set(SEED_ID, 1);
  await loadService(); // 先按普通夹具完成模块加载；仅切换已有钱包结算分支。
  const previous = process.env.FARM_SESSION_BUSINESS;
  try {
    process.env.FARM_SESSION_BUSINESS = '1';
    const round = await callShop([1, 2], 1000);
    assert.equal(round.result.plantedCount, 2);
    assert.equal(round.userState.gold, 1000, '会话钱包不由旧本地对象重复扣减');
    assert.deepEqual(state.walletCorrections, [{ kind: 'seedCost', payload: { amounts: [PRICE] } }]);
    assert.equal(state.buyCalls[0].num, 1);
  } finally {
    if (previous === undefined) delete process.env.FARM_SESSION_BUSINESS;
    else process.env.FARM_SESSION_BUSINESS = previous;
  }
});

test('非法价格或限购数据不变成免费/不限购；安全数字串库存仍可复用', async () => {
  for (const terms of [{ price: -1 }, { limitCount: -1 }, { limitCount: 5, boughtNum: -1 },
    { limitCount: '9007199254740993' }]) {
    resetAll(terms);
    const round = await callShop([1, 2], 1000);
    assert.equal(state.buyCalls.length, 0);
    assert.equal(state.plantCalls.length, 0);
    assert.equal(round.userState.gold, 1000);
  }
  resetAll();
  state.bag.set(SEED_ID, 2);
  state.bagSeedsOverride = [{ seedId: SEED_ID, count: '2', plantSize: 1 }];
  const round = await callShop([1, 2], 0);
  assert.equal(state.buyCalls.length, 0);
  assert.equal(round.result.plantedCount, 2);
});

test('用尽限购后多轮及模块重载零购买，仅新鲜商店明确恢复额度才购买', async () => {
  resetAll({ limitCount: 5, boughtNum: 5 });
  await callShop([1, 2], 1000);
  await callShop([1, 2], 1000);
  await reloadService();
  await callShop([1, 2], 1000);
  assert.equal(state.buyCalls.length, 0);
  state.shopGoods[0].limit_count = 6;
  await callShop([1, 2], 1000);
  assert.deepEqual(state.buyCalls.map(call => call.num), [1]);
});

test('购买回包改变实际种子ID时，不把原种子的库存算给另一种子', async () => {
  resetAll();
  state.bag.set(SEED_ID, 1);
  state.buySeedId = 20001;
  const round = await callShop([1, 2], 1000);
  assert.deepEqual(state.buyCalls.map(call => call.num), [1]);
  assert.equal(round.result.plantedCount, 1);
  assert.deepEqual(state.plantCalls, [{ seedId: 20001, landIds: [1] }]);
  assert.equal(state.bag.get(SEED_ID), 1, '原种子的库存不被混算或消费');
  assert.equal(round.userState.gold, 1000 - PRICE);
});
