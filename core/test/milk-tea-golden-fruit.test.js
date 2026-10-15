'use strict';
// 奶茶活动黄金果实 1040525（黄金·森野甜莓）登记与展示分类回归。
// 覆盖：真实 loadProto + 模拟 BagReply 走真实 getBag/getBagDetail/
// getBagSeedsFromItems 入口（网络为注入替身，零真实游戏请求）；
// 名称/type17/category=fruit/金豆豆 1005:3/重复堆叠/种子排除/未知合成 ID
// 仍上报且该项不报警；普通果实/货币/种子分类不退化；缺图为空不顶替、
// 无伪造 Plant 映射；真实 sellAllFruits 入口（sell=true）证明无 Plant 映射
// 的该项零 Sell 请求，不扩大自动写资格；空与无效数量忽略；失败后替身与
// 环境恢复；候选源码内容/权限指纹不变。旧源（未登记 + 无 type17 分支）在
// 本文件至少两项真实入口业务断言失败（category/itemType/价格/未分类报警）。
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
const mkdtempPrefix = path.join(tempRoot, 'farm-milk-tea-golden-fruit-');
assert.equal(isInsideOrEqualDir(mkdtempPrefix, tempRoot), true, 'mkdtemp 前缀必须位于临时根内');
const privateDir = path.resolve(fs.mkdtempSync(mkdtempPrefix));
assert.equal(isInsideOrEqualDir(privateDir, tempRoot), true, '独立运行数据目录必须落在临时根内');
const originalDataDir = process.env.FARM_DATA_DIR;
process.env.FARM_DATA_DIR = privateDir;
test.after(() => {
  try {
    assertCandidateSourcesUnchanged();
  } finally {
    if (originalDataDir === undefined) delete process.env.FARM_DATA_DIR;
    else process.env.FARM_DATA_DIR = originalDataDir;
    fs.rmSync(assertWriteInsidePrivateDir(privateDir), { recursive: true, force: true });
    process.once('exit', () => fs.rmSync(assertWriteInsidePrivateDir(privateDir), { recursive: true, force: true }));
  }
});
function assertWriteInsidePrivateDir(target) {
  const resolved = path.resolve(String(target));
  if (!isInsideOrEqualDir(resolved, privateDir))
    throw new Error(`夹具写目标越界（已在写入原语前拒绝）: ${resolved}`);
  return resolved;
}

function writeFixture(target, contents, io = fs) {
  const resolved = assertWriteInsidePrivateDir(target);
  io.mkdirSync(path.dirname(resolved), { recursive: true });
  io.writeFileSync(resolved, contents);
  return resolved;
}

// 候选源码指纹：全部用例结束后内容与权限不得被夹具改变
const CANDIDATE_SOURCES = [
  __filename,
  path.join(repoRoot, 'core', 'src', 'gameConfig', 'EventItems.json'),
  path.join(repoRoot, 'core', 'src', 'gameConfig', 'EventPlants.json'),
  path.join(repoRoot, 'core', 'src', 'gameConfig', 'ItemInfo.json'),
  path.join(repoRoot, 'core', 'src', 'services', 'warehouse.js'),
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
function assertCandidateSourcesUnchanged() {
  for (const [file, before] of fingerprintsBefore) {
    assert.deepEqual(fingerprintOf(file), before, 'fixture must preserve candidate content and modes');
  }
}

const { loadProto, types } = require('../src/utils/proto');
const {
  getItemById,
  getItemImageById,
  getPlantByFruitId,
  getPlantBySeedId,
  isSeedItem,
  registerRuntimeItem,
} = require('../src/config/gameConfig');

const GOLDEN_FRUIT_ID = 1040525;
const SYNTHETIC_UNKNOWN_ID = 4299977;

function mockModule(filename, exports) {
  return { id: filename, filename, loaded: true, exports };
}

/** 真实 proto 编码的模拟 Bag 回包体（含堆叠两份黄金果实与回归样本）。 */
async function encodeSimulatedBagReply(overrides = {}) {
  await loadProto();
  const payload = {
    item_bag: {
      items: [
        { id: GOLDEN_FRUIT_ID, count: 2, uid: 9001 },
        { id: GOLDEN_FRUIT_ID, count: 3, uid: 9002 },
        { id: 41072, count: 48 }, // 普通果实（EventPlants 1021072 已映射）
        { id: 1001, count: 9999 }, // 货币
        { id: 21072, count: 2 }, // 种子
        { id: SYNTHETIC_UNKNOWN_ID, count: 1 }, // 合成未知：仍需上报
        { id: GOLDEN_FRUIT_ID, count: 0 }, // 无效数量：必须被忽略
        { id: 0, count: 7 }, // 无效 ID：必须被忽略
        { id: SYNTHETIC_UNKNOWN_ID, count: 0 }, // 无效数量的未知：不上报
      ],
    },
  };
  const reply = types.BagReply.create(Object.assign(payload, overrides));
  return types.BagReply.encode(reply).finish();
}

/**
 * 重载 warehouse 并注入网络替身。返回 { warehouse, calls, logs, restore }；
 * calls 记录全部 RPC（method + 已解码请求），logs 捕获 utils 日志。
 */
async function reloadWarehouseWithNetworkStub({ bagBody, bagBodies, sellBodies, onSell } = {}) {
  await loadProto();
  const warehousePath = require.resolve('../src/services/warehouse');
  const networkPath = require.resolve('../src/utils/network');
  const utilsPath = require.resolve('../src/utils/utils');
  const previous = new Map([warehousePath, networkPath, utilsPath]
    .map(p => [p, require.cache[p]]));
  const calls = [];
  const logs = [];
  let stateGold = 0;
  const sellQueue = sellBodies || [];
  const utilsMod = require('../src/utils/utils');
  require.cache[utilsPath] = mockModule(utilsPath, {
    ...utilsMod,
    log: (tag, message, meta) => logs.push({ tag, message, meta }),
    logWarn: (tag, message, meta) => logs.push({ tag, message, meta }),
  });
  require.cache[networkPath] = mockModule(networkPath, {
    sendMsgAsync: async (service, method, request) => {
      const entry = { service, method };
      if (method === 'Sell') {
        entry.itemIds = types.SellRequest.decode(request).items
          .map(item => Number(item.id));
        if (onSell) onSell();
        stateGold = 200; // 出售后服务端金币状态变化（真实语义）
      }
      calls.push(entry);
      if (method === 'Bag') {
        const body = bagBodies?.length ? bagBodies.shift() : bagBody;
        if (body instanceof Error) throw body;
        return { body };
      }
      if (method === 'Sell') {
        const body = sellQueue.length ? sellQueue.shift() : emptySellReplyBody();
        return { body };
      }
      throw new Error('unexpected RPC in isolated fixture');
    },
    networkEvents: { emit: () => {} },
    getUserState: () => ({ gold: stateGold, level: 100 }),
  });
  delete require.cache[warehousePath];
  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    delete require.cache[warehousePath];
    for (const [p, entry] of previous) {
      if (entry === undefined) delete require.cache[p];
      else require.cache[p] = entry;
    }
  };
  try {
    const warehouse = require('../src/services/warehouse');
    return { warehouse, calls, logs, restore };
  } catch (error) {
    restore();
    throw error;
  }
}

let cachedEmptySellReply = null;
function emptySellReplyBody() {
  if (!cachedEmptySellReply) {
    const reply = types.SellReply.create({
      sell_items: [{ id: 41072, count: 48 }],
      get_items: [{ id: 1001, count: 200 }],
    });
    cachedEmptySellReply = types.SellReply.encode(reply).finish();
  }
  return cachedEmptySellReply;
}

// ===== 1. 登记与无伪造映射 =====

test('1040525 按 type17 黄金果实登记，字段逐项核对且不伪造植物映射', async () => {
  const info = getItemById(GOLDEN_FRUIT_ID);
  assert.equal(info?.name, '黄金·森野甜莓');
  assert.equal(Number(info?.type), 17);
  assert.equal(info?.asset_name, 'gold/Crop_525');
  assert.equal(info?.sells, '1005:3');
  // 展示分类不等于出售资格：无 Plant 映射（公开 Plant 1120525 仅类型交叉不进本地表）
  assert.equal(getPlantByFruitId(GOLDEN_FRUIT_ID), undefined);
  assert.equal(getPlantBySeedId(GOLDEN_FRUIT_ID), undefined);
  assert.equal(isSeedItem(GOLDEN_FRUIT_ID), false);
  // 缺图为空，不以其他道具图顶替，也不进通用回退集合
  assert.equal(getItemImageById(GOLDEN_FRUIT_ID), '');
  // EventItems 无重复 ID、无新增植物条目（1120525 不进 EventPlants）
  const items = JSON.parse(fs.readFileSync(
    path.join(repoRoot, 'core', 'src', 'gameConfig', 'EventItems.json'), 'utf8'));
  const ids = items.map(entry => entry.id);
  assert.equal(new Set(ids).size, ids.length, 'EventItems ID 必须唯一');
  assert.equal(ids.filter(id => id === GOLDEN_FRUIT_ID).length, 1);
  const plants = JSON.parse(fs.readFileSync(
    path.join(repoRoot, 'core', 'src', 'gameConfig', 'EventPlants.json'), 'utf8'));
  assert.equal(plants.some(entry => Number(entry.fruit_id) === GOLDEN_FRUIT_ID
    || Number(entry.seed_id) === GOLDEN_FRUIT_ID || entry.id === 1120525), false,
  '公开参考 Plant 1120525 仅作类型交叉，不得登记为本地植物');
});

test('未知 S4 种子 plantSize=0 与已确认四格种子 29004 size=2 保持不变', () => {
  const warehouse = require('../src/services/warehouse');
  const seeds = warehouse.getBagSeedsFromItems([
    { id: 20529, count: 2 }, // 森野芭乐种子：已登记但无 Plant 映射
    { id: 29004, count: 3 }, // 泡泡棉花糖：EventPlants 1029004 size=2
  ]);
  const byId = new Map(seeds.map(seed => [seed.seedId, seed]));
  assert.equal(byId.get(20529)?.plantSize, 0, '无 Plant 映射的活动种子 plantSize 保持 0');
  assert.equal(byId.get(20529)?.mappingStatus, 'item_only');
  assert.equal(byId.get(29004)?.plantSize, 2, '四格作物 plantSize 保持 2');
  assert.equal(byId.get(29004)?.mappingStatus, 'mapped');
});

// ===== 2. 真实入口：getBagDetail / getBagSeedsFromItems =====

test('模拟 BagReply 经真实 getBagDetail：黄金果实展示为 fruit/type17/金豆豆且分类不退化', async () => {
  const bagBody = await encodeSimulatedBagReply();
  const { warehouse, logs, restore } = await reloadWarehouseWithNetworkStub({ bagBody });
  try {
    const detail = await warehouse.getBagDetail();
    const entry = detail.items.find(item => item.id === GOLDEN_FRUIT_ID);
    assert.ok(entry, '1040525 必须出现在背包详情');
    assert.equal(entry.name, '黄金·森野甜莓');
    assert.equal(entry.category, 'fruit', '已登记 type17 黄金果实展示分类为果实');
    assert.equal(entry.itemType, 17);
    assert.equal(entry.priceId, 1005);
    assert.equal(entry.price, 3);
    assert.equal(entry.priceUnit, '金豆豆');
    assert.equal(entry.count, 5, '两堆 2+3 必须合并计数');
    assert.equal(entry.image, '', '专属图未取得时为空，不以其他道具图顶替');
    assert.equal(entry.plantSize, 1, '非种子展示 plantSize 默认 1');
    // 普通果实 / 货币 / 种子分类不退化
    const normalFruit = detail.items.find(item => item.id === 41072);
    assert.equal(normalFruit?.category, 'fruit');
    assert.equal(normalFruit?.itemType, 4);
    const gold = detail.items.find(item => item.id === 1001);
    assert.equal(gold?.category, 'gold');
    const seed = detail.items.find(item => item.id === 21072);
    assert.equal(seed?.category, 'seed');
    assert.equal(seed?.plantSize, 1);
    // 无效数量/无效 ID 不进背包
    assert.equal(detail.items.some(item => item.id === 0), false);
    assert.equal(detail.originalItems.some(item => item.id === GOLDEN_FRUIT_ID && item.count === 0), false);
    // 审计：该项无缺口；合成未知仍按 unclassified_item 上报
    assert.equal(detail.seedRecognition.issues.filter(i => i.itemId === GOLDEN_FRUIT_ID).length, 0);
    assert.ok(detail.seedRecognition.issues.some(
      i => i.itemId === SYNTHETIC_UNKNOWN_ID && i.kind === 'unclassified_item'));
    // 日志：合成未知仍报 bag_unclassified_item，黄金果实不再报警
    const unclassified = logs.filter(l => l.meta && l.meta.event === 'bag_unclassified_item');
    assert.equal(unclassified.length, 1, '合成未知必须仍上报');
    assert.deepEqual(unclassified[0].meta.unclassifiedItemIds, [SYNTHETIC_UNKNOWN_ID],
      '无效数量的未知不计入未分类清单');
    assert.ok(!unclassified[0].meta.unclassifiedItemIds.includes(GOLDEN_FRUIT_ID),
      '已登记黄金果实不得再报未分类');
  } finally {
    restore();
  }
});

test('getBagSeedsFromItems 不把黄金果实当种子；同输入混合未知仍进待办收件箱', async () => {
  const inboxPath = require.resolve('../src/services/evolution-issue-inbox');
  const previousInbox = require.cache[inboxPath];
  const recorded = [];
  require.cache[inboxPath] = mockModule(inboxPath, {
    recordRuntimeIssue: (type, level) => {
      recorded.push({ type, level });
      return true;
    },
  });
  const bagBody = await encodeSimulatedBagReply();
  const { warehouse, logs, restore } = await reloadWarehouseWithNetworkStub({ bagBody });
  try {
    // 直接喂 items（真实入口同构输入：含堆叠、未知与无效数量）
    const decoded = types.BagReply.decode(bagBody);
    const items = decoded.item_bag.items;
    const seeds = warehouse.getBagSeedsFromItems(items);
    assert.deepEqual(seeds.map(seed => seed.seedId), [21072], '种子列表只含真实种子');
    assert.equal(seeds[0]?.count, 2);
    const unclassified = logs.filter(l => l.meta && l.meta.event === 'bag_unclassified_item');
    assert.equal(unclassified.length, 1);
    assert.deepEqual(unclassified[0].meta.unclassifiedItemIds, [SYNTHETIC_UNKNOWN_ID]);
    assert.equal(recorded.length, 1, '合成未知仍进自动进化待办');
    assert.deepEqual(recorded[0], { type: 'bag_unclassified', level: 'warn' });
    // 空输入与全无效数量：零日志零待办零种子
    recorded.length = 0;
    logs.length = 0;
    assert.deepEqual(warehouse.getBagSeedsFromItems([]), []);
    assert.deepEqual(warehouse.getBagSeedsFromItems([
      { id: GOLDEN_FRUIT_ID, count: 0 },
      { id: 0, count: 5 },
      { id: SYNTHETIC_UNKNOWN_ID, count: -1 },
    ]), []);
    assert.equal(logs.filter(l => l.meta && l.meta.event === 'bag_unclassified_item').length, 0);
    assert.equal(recorded.length, 0);
  } finally {
    restore();
    if (previousInbox === undefined) delete require.cache[inboxPath];
    else require.cache[inboxPath] = previousInbox;
  }
});

// ===== 3. 真实 sellAllFruits 入口：展示分类不扩大自动出售资格 =====

test('sellAllFruits（sell=true）对无 Plant 映射的黄金果实零 Sell 请求', async () => {
  const storePath = require.resolve('../src/models/store');
  const previousStore = require.cache[storePath];
  require.cache[storePath] = mockModule(storePath, {
    isAutomationOn: flag => flag === 'sell',
  });
  const bagBody = await encodeSimulatedBagReply();
  const { warehouse, calls, logs, restore } = await reloadWarehouseWithNetworkStub({ bagBody });
  try {
    await warehouse.sellAllFruits();
    const sellCalls = calls.filter(call => call.method === 'Sell');
    assert.deepEqual(calls.map(call => call.method), ['Bag', 'Sell']);
    assert.equal(sellCalls.length, 1, '普通映射果实仍走真实出售链路');
    for (const call of sellCalls) {
      assert.ok(!call.itemIds.includes(GOLDEN_FRUIT_ID),
        '无 Plant 映射的黄金果实不得出现在任何 Sell 请求中');
    }
    assert.deepEqual(sellCalls.flatMap(call => call.itemIds).sort(), [41072]);
    assert.equal(logs.some(l => l.message.includes('无果实可出售')), false);
  } finally {
    restore();
    if (previousStore === undefined) delete require.cache[storePath];
    else require.cache[storePath] = previousStore;
  }
});

test('背包仅剩黄金果实时 sellAllFruits 零请求零误报', async () => {
  const storePath = require.resolve('../src/models/store');
  const previousStore = require.cache[storePath];
  require.cache[storePath] = mockModule(storePath, {
    isAutomationOn: flag => flag === 'sell',
  });
  const bagBody = await encodeSimulatedBagReply({
    item_bag: {
      items: [
        { id: GOLDEN_FRUIT_ID, count: 5 },
        { id: 1001, count: 9999 },
      ],
    },
  });
  const { warehouse, calls, logs, restore } = await reloadWarehouseWithNetworkStub({ bagBody });
  try {
    await warehouse.sellAllFruits();
    assert.deepEqual(calls.map(call => call.method), ['Bag']);
    assert.equal(calls.filter(call => call.method === 'Sell').length, 0, '零 Sell 请求');
    assert.equal(logs.some(l => l.message.includes('无果实可出售')), true);
  } finally {
    restore();
    if (previousStore === undefined) delete require.cache[storePath];
    else require.cache[storePath] = previousStore;
  }
});

// ===== 4. 收尾：源码指纹与夹具清理 =====

test('已知 type17 分类经独立运行时登记和真实背包入口验证', async () => {
  const id = 4299988; // 合成道具，独立证明分类行为，不依赖新增配置存在。
  registerRuntimeItem(id, { name: '合成黄金果实', type: 17 });
  const bagBody = await encodeSimulatedBagReply({ item_bag: { items: [{ id, count: 1 }] } });
  const { warehouse, calls, restore } = await reloadWarehouseWithNetworkStub({ bagBody });
  try {
    const detail = await warehouse.getBagDetail();
    assert.equal(detail.items[0].category, 'fruit');
    assert.equal(detail.items[0].itemType, 17);
    assert.equal(getPlantByFruitId(id), undefined);
    assert.deepEqual(calls.map(call => call.method), ['Bag']);
  } finally {
    restore();
  }
});

test('读取拒绝或损坏回包后冷却期零新增读取，到期后恢复并清理替身', async () => {
  const files = ['../src/services/warehouse', '../src/utils/network', '../src/utils/utils']
    .map(file => require.resolve(file));
  const bagBody = await encodeSimulatedBagReply({
    item_bag: { items: [{ id: GOLDEN_FRUIT_ID, count: 2 }] },
  });
  for (const failure of [new Error('synthetic Bag unavailable'), Buffer.from([0xFF])]) {
    const previous = new Map(files.map(file => [file, require.cache[file]]));
    const { warehouse, calls, restore } = await reloadWarehouseWithNetworkStub({ bagBodies: [failure, bagBody] });
    const originalNow = Date.now;
    let now = originalNow();
    Date.now = () => now;
    try {
      await assert.rejects(warehouse.getBagDetail());
      assert.deepEqual(calls.map(call => call.method), ['Bag'], 'failed read must not retry');
      await assert.rejects(warehouse.getBagDetail(), /背包读取冷却中/);
      assert.deepEqual(calls.map(call => call.method), ['Bag'], 'cooldown must not reach upstream');
      now += 60_001; // 保留现有 60s 失败冷却，用受控时钟跨过截止。
      const detail = await warehouse.getBagDetail();
      assert.equal(detail.items[0].name, '黄金·森野甜莓');
      assert.equal(detail.items[0].category, 'fruit');
      assert.equal(detail.items[0].count, 2);
      assert.deepEqual(calls.map(call => call.method), ['Bag', 'Bag']);
    } finally {
      Date.now = originalNow;
      restore();
      for (const [file, cached] of previous) assert.equal(require.cache[file], cached);
      assertCandidateSourcesUnchanged();
    }
  }
});

test('实际夹具写入先守边界：越界零创建零写入，合法写和失败路径保持候选指纹', () => {
  const counts = { mkdir: 0, write: 0 };
  const io = {
    mkdirSync(...args) { counts.mkdir++; return fs.mkdirSync(...args); },
    writeFileSync(...args) { counts.write++; return fs.writeFileSync(...args); },
  };
  const outside = path.join(repoRoot, 'core', 'src', 'services', 'warehouse.js');
  assert.throws(() => writeFixture(outside, 'must never write', io), /越界/);
  assert.deepEqual(counts, { mkdir: 0, write: 0 });
  assertCandidateSourcesUnchanged();
  const target = writeFixture(path.join(privateDir, 'nested', 'proof.txt'), 'isolated', io);
  assert.deepEqual(counts, { mkdir: 1, write: 1 });
  assert.equal(fs.readFileSync(target, 'utf8'), 'isolated');
  const failedTarget = path.join(privateDir, 'failed', 'proof.txt');
  try {
    assert.throws(() => writeFixture(failedTarget, 'not written', {
      mkdirSync: io.mkdirSync,
      writeFileSync() { counts.write++; throw new Error('synthetic fixture write failure'); },
    }), /synthetic fixture write failure/);
    assert.deepEqual(counts, { mkdir: 2, write: 2 });
    assert.equal(fs.existsSync(failedTarget), false);
  } finally {
    assertCandidateSourcesUnchanged();
    fs.rmSync(assertWriteInsidePrivateDir(path.join(privateDir, 'nested')), { recursive: true, force: true });
    fs.rmSync(assertWriteInsidePrivateDir(path.join(privateDir, 'failed')), { recursive: true, force: true });
    assert.equal(fs.existsSync(target), false);
    assert.equal(fs.existsSync(path.dirname(failedTarget)), false);
  }
});
