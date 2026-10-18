'use strict';
// 奶茶活动黄金果实 1040525（黄金·森野甜莓）登记与展示分类回归；
// 2026-10-18 轮扩展覆盖自然 Bag 新出现的三项黄金果实
// 1040165（黄金·茱萸）/1040526（黄金·森野白桃）/1049005（黄金·森野黄金芽）。
// 覆盖：真实 loadProto + 模拟 BagReply 走真实 getBag/getBagDetail/
// getBagSeedsFromItems 入口（网络为注入替身，零真实游戏请求）；
// 名称/type17/category=fruit/金豆豆 1005:3/重复堆叠/种子排除/未知合成 ID
// 仍上报且该项不报警；普通果实/货币/种子分类不退化；专属图哈希核验且不顶替、
// 无伪造 Plant 映射；真实 sellAllFruits 入口（sell=true）证明无 Plant 映射
// 的该项零 Sell 请求，不扩大自动写资格；空与无效数量忽略；失败后替身与
// 环境恢复；候选源码内容/权限指纹不变。旧源（未登记 + 无 type17 分支）在
// 本文件至少两项真实入口业务断言失败（category/itemType/价格/未分类报警）；
// 三项新 ID 各有登记与真实背包两个独立用例，旧配置反证合计至少 6 项失败，
// 旧资源（无 PNG/manifest 行）反证每 ID 至少 1 项业务断言失败。
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

// 候选源码指纹：全部用例结束后内容与权限不得被夹具改变。
// 新增资源（manifest/三张黄金果实 PNG）在旧源基线不存在时必须能表达 absent，
// 不能在基线导入阶段就抛 ENOENT——旧源反证只允许产生 ERR_ASSERTION 业务失败。
const seedImagesDir = path.join(repoRoot, 'core', 'src', 'gameConfig', 'seed_images_named');
const NEW_GOLDEN_FRUITS = [
  {
    id: 1040165,
    name: '黄金·茱萸',
    plantId: 1120165,
    assetName: 'gold/Crop_165',
    file: '1040165_gold_Crop_165.png',
    sells: '1005:6',
    price: 6,
    sourceCommit: '4eb9b2a6a720e4dcc9f19b0ca7f19cc2f73f7811',
    sourcePath: 'core/src/gameConfig/seed_images_named/seed_images/1040165.png',
    gitBlob: 'f90765c0e4e0b38206429aae7cb5f55c8ef83e79',
    sha256: '6b570b0e384bf5fde7cc0549b30f7308699448f9a986a5136cc5878a3fe76ebd',
  },
  {
    id: 1040526,
    name: '黄金·森野白桃',
    plantId: 1120526,
    assetName: 'gold/Crop_526',
    file: '1040526_gold_Crop_526.png',
    sells: '1005:3',
    price: 3,
    sourceCommit: '4eb9b2a6a720e4dcc9f19b0ca7f19cc2f73f7811',
    sourcePath: 'core/src/gameConfig/seed_images_named/seed_images/1040526.png',
    gitBlob: '2c74e15835cb1ae7b4ace60e1a48915e571b99e7',
    sha256: 'a6b4d053ac29dcc6347a5e44603f53a4cfb690263df8ca60c700ff8446494da5',
  },
  {
    id: 1049005,
    name: '黄金·森野黄金芽',
    plantId: 1129005,
    assetName: 'gold/Crop_9005',
    file: '1049005_gold_Crop_9005.png',
    sells: '1005:30',
    price: 30,
    sourceCommit: '4eb9b2a6a720e4dcc9f19b0ca7f19cc2f73f7811',
    sourcePath: 'core/src/gameConfig/seed_images_named/seed_images/1049005.png',
    gitBlob: '02f24e93fd2cb92cd866b9f2156c78d8a57d65db',
    sha256: 'f29ba6766aecd1244678f161fc8c5a8edc92672caef2ac41003db861a7ed8efb',
  },
];
const CANDIDATE_SOURCES = [
  __filename,
  path.join(repoRoot, 'core', 'src', 'gameConfig', 'EventItems.json'),
  path.join(repoRoot, 'core', 'src', 'gameConfig', 'EventPlants.json'),
  path.join(repoRoot, 'core', 'src', 'gameConfig', 'ItemInfo.json'),
  path.join(repoRoot, 'core', 'src', 'services', 'warehouse.js'),
  path.join(seedImagesDir, 'event-seed-sources.json'),
  ...NEW_GOLDEN_FRUITS.map(spec => path.join(seedImagesDir, spec.file)),
];
function fingerprintOf(file) {
  if (!fs.existsSync(file)) return { absent: true };
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
const { pngResourceInfo } = require('../src/services/privacy-guard');

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
  // 已核验的专属图与登记同轮交付，不以其他道具图顶替。
  assert.match(getItemImageById(GOLDEN_FRUIT_ID), /1040525_gold_Crop_525\.png$/);
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

test('已确认普通活动种子按单格、四格保持原占地，真正未知种子仍为零', () => {
  const warehouse = require('../src/services/warehouse');
  const seeds = warehouse.getBagSeedsFromItems([
    { id: 20529, count: 2 }, // 森野芭乐：现已核验默认单格映射
    { id: 29004, count: 3 }, // 泡泡棉花糖：EventPlants 1029004 size=2
    { id: 799991, count: 1, showName: '合成未知种子' },
  ]);
  const byId = new Map(seeds.map(seed => [seed.seedId, seed]));
  assert.equal(byId.get(20529)?.plantSize, 1);
  assert.equal(byId.get(20529)?.mappingStatus, 'mapped');
  assert.equal(byId.get(799991)?.plantSize, 0, '真正缺少 Plant 的种子继续保留未知占地');
  assert.equal(byId.get(29004)?.plantSize, 2, '四格作物 plantSize 保持 2');
  assert.equal(byId.get(29004)?.mappingStatus, 'mapped');
});

// ===== 1.5 本轮（2026-10-18）新增三项黄金果实：登记/资源证明表驱动 =====

for (const spec of NEW_GOLDEN_FRUITS) {
  test(`${spec.id} ${spec.name} 登记字段逐项核对、无伪造 Plant、非种子且专属图与资源证明对齐`, () => {
    const info = getItemById(spec.id);
    assert.equal(info?.name, spec.name);
    assert.equal(Number(info?.type), 17);
    assert.equal(info?.asset_name, spec.assetName);
    assert.equal(info?.sells, spec.sells);
    // seed=null 的黄金 Plant 只作类型交叉：不得伪造本地植物/种子映射。
    assert.equal(getPlantByFruitId(spec.id), undefined, '黄金果实不得伪造 fruit→Plant 映射');
    assert.equal(getPlantBySeedId(spec.id), undefined, '黄金果实不得被登记为种子');
    assert.equal(isSeedItem(spec.id), false);
    // 资源读取前的业务守卫：先由业务索引与 manifest 存在性断言证明本项已交付，
    // 旧源只能在此产生 ERR_ASSERTION 业务失败，不能先碰新 PNG 造成环境异常。
    const expectedImage = `/game-config/seed_images_named/${spec.file}`;
    assert.equal(getItemImageById(spec.id), expectedImage, '专属图必须由业务索引精确命中');
    const manifest = JSON.parse(fs.readFileSync(
      path.join(seedImagesDir, 'event-seed-sources.json'), 'utf8'));
    const row = manifest.reviewedResources.find(entry => entry.itemId === spec.id);
    assert.ok(row, 'manifest.reviewedResources 必须登记本项专属图来源');
    assert.equal(row.file, spec.file);
    assert.equal(row.assetName, spec.assetName);
    assert.equal(row.kind, 'golden_fruit');
    assert.equal(row.sourceGrade, 'reviewed_public_client_snapshot');
    assert.equal(row.sourceCommit, spec.sourceCommit);
    assert.equal(row.sourcePath, spec.sourcePath);
    assert.equal(row.gitBlob, spec.gitBlob);
    assert.equal(row.sha256, spec.sha256);
    assert.ok(manifest.references.some(ref =>
      ref.repositoryAlias === row.repositoryAlias && ref.commit === row.sourceCommit),
    '来源提交必须能对上既有 references 记录');
    const target = path.join(seedImagesDir, row.file);
    assert.equal(path.dirname(target), seedImagesDir, '资源必须位于 seed_images_named 目录内');
    const bytes = fs.readFileSync(target);
    assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), row.sha256,
      'PNG 字节必须与登记 SHA-256 一致');
    assert.equal(crypto.createHash('sha1').update(
      Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes])).digest('hex'), row.gitBlob,
    'PNG 字节必须与登记 Git blob 一致');
    assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'PNG 签名');
    assert.deepEqual(pngResourceInfo(bytes, { runtimeTerms: [] }),
      { width: row.width, height: row.height }, '完整 PNG 结构/块/CRC/元数据核验');
    assert.equal(row.width, 100);
    assert.equal(row.height, 100);
    // EventItems 唯一；黄金 Plant 不进 EventPlants
    const items = JSON.parse(fs.readFileSync(
      path.join(repoRoot, 'core', 'src', 'gameConfig', 'EventItems.json'), 'utf8'));
    assert.equal(items.filter(entry => entry.id === spec.id).length, 1, 'EventItems 不得重复登记');
    const plants = JSON.parse(fs.readFileSync(
      path.join(repoRoot, 'core', 'src', 'gameConfig', 'EventPlants.json'), 'utf8'));
    assert.equal(plants.some(entry => Number(entry.fruit_id) === spec.id
      || Number(entry.seed_id) === spec.id || entry.id === spec.plantId), false,
    `公开参考 Plant ${spec.plantId} 仅作类型交叉，不得登记为本地植物`);
  });
}

// ===== 2.5 三项黄金果实的真实背包入口 =====

for (const spec of NEW_GOLDEN_FRUITS) {
  test(`真实 getBagDetail：${spec.id} ${spec.name} 展示 fruit/type17/金豆豆 ${spec.sells}、2+3 合并且一次 Bag 缓存复用`, async () => {
    const bagBody = await encodeSimulatedBagReply({
      item_bag: {
        items: [
          { id: spec.id, count: 2, uid: 9101 },
          { id: spec.id, count: 3, uid: 9102 },
          { id: 1001, count: 888 },
          { id: SYNTHETIC_UNKNOWN_ID, count: 1 }, // 合成未知：仍需上报
          { id: spec.id, count: 0 }, // 无效数量：忽略
        ],
      },
    });
    const { warehouse, calls, logs, restore } = await reloadWarehouseWithNetworkStub({ bagBody });
    try {
      const detail = await warehouse.getBagDetail();
      await warehouse.getBagDetail(); // 连续读取沿面板缓存
      assert.deepEqual(calls.map(call => call.method), ['Bag'], '只一次 Bag RPC，缓存复用不新增读取');
      const entry = detail.items.find(item => item.id === spec.id);
      assert.ok(entry, `${spec.id} 必须出现在背包详情`);
      assert.equal(entry.name, spec.name);
      assert.equal(entry.category, 'fruit', '已登记 type17 黄金果实展示分类为果实');
      assert.equal(entry.itemType, 17);
      assert.equal(entry.priceId, 1005);
      assert.equal(entry.price, spec.price);
      assert.equal(entry.priceUnit, '金豆豆');
      assert.equal(entry.count, 5, '两堆 2+3 必须合并计数');
      assert.equal(entry.image, `/game-config/seed_images_named/${spec.file}`,
        '已核验专属图进入真实背包详情');
      assert.equal(entry.plantSize, 1, '非种子展示 plantSize 默认 1');
      // 审计与日志：本 ID 无缺口、不进未分类；合成未知仍上报
      assert.equal(detail.seedRecognition.issues.filter(i => i.itemId === spec.id).length, 0);
      const unclassified = logs.filter(l => l.meta && l.meta.event === 'bag_unclassified_item');
      assert.equal(unclassified.length, 1, '合成未知必须仍上报');
      assert.deepEqual(unclassified[0].meta.unclassifiedItemIds, [SYNTHETIC_UNKNOWN_ID]);
      assert.equal(unclassified[0].meta.unclassifiedItemIds.includes(spec.id), false,
        '已登记黄金果实不得再报未分类');
    } finally {
      restore();
    }
  });
}

test('getBagSeedsFromItems：三项黄金果实均非种子，单格/四格/合成未知保持原状', () => {
  const warehouse = require('../src/services/warehouse');
  const seeds = warehouse.getBagSeedsFromItems([
    ...NEW_GOLDEN_FRUITS.map(spec => ({ id: spec.id, count: 2 })),
    { id: 20529, count: 2 }, // 已核验默认单格
    { id: 29004, count: 3 }, // 四格
    { id: 799991, count: 1, showName: '合成未知种子' },
  ]);
  const seedIds = seeds.map(seed => seed.seedId);
  assert.deepEqual(seedIds, [20529, 29004, 799991], '种子列表不得混入黄金果实');
  for (const spec of NEW_GOLDEN_FRUITS) {
    assert.equal(seedIds.includes(spec.id), false, `${spec.id} 不是种子`);
    assert.equal(seeds.some(seed => seed.name && seed.name.includes(spec.name)), false);
  }
  assert.equal(seeds.find(seed => seed.seedId === 20529)?.plantSize, 1);
  assert.equal(seeds.find(seed => seed.seedId === 29004)?.plantSize, 2);
  assert.equal(seeds.find(seed => seed.seedId === 799991)?.plantSize, 0,
    '真正缺少 Plant 的合成未知继续保留未知占地');
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
    assert.match(entry.image, /1040525_gold_Crop_525\.png$/, '已核验专属图进入真实背包详情');
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

test('sell=true 混合包：三项黄金果实与条件售价材料零 Sell，仅旧映射果实 41072 出售', async () => {
  const storePath = require.resolve('../src/models/store');
  const previousStore = require.cache[storePath];
  require.cache[storePath] = mockModule(storePath, {
    isAutomationOn: flag => flag === 'sell',
  });
  const bagBody = await encodeSimulatedBagReply({
    item_bag: {
      items: [
        ...NEW_GOLDEN_FRUITS.map(spec => ({ id: spec.id, count: 2 })),
        { id: 41072, count: 48 }, // 旧普通果实（EventPlants 已映射，正常出售）
        { id: 40526, count: 10 }, // 奶茶材料：仅条件售价，不得自动出售
        { id: 1001, count: 9999 },
      ],
    },
  });
  const { warehouse, calls, restore } = await reloadWarehouseWithNetworkStub({ bagBody });
  try {
    await warehouse.sellAllFruits();
    const sellCalls = calls.filter(call => call.method === 'Sell');
    assert.equal(sellCalls.length, 1, '只有旧映射果实走真实出售链路');
    assert.deepEqual(sellCalls.flatMap(call => call.itemIds).sort(), [41072],
      '条件售价材料与黄金果实都不得进入 Sell 请求');
    for (const spec of NEW_GOLDEN_FRUITS) {
      assert.equal(sellCalls.some(call => call.itemIds.includes(spec.id)), false,
        `${spec.id} 无 Plant 映射，展示分类不构成自动出售资格`);
    }
  } finally {
    restore();
    if (previousStore === undefined) delete require.cache[storePath];
    else require.cache[storePath] = previousStore;
  }
});

test('背包仅剩本轮三项黄金果实时 sellAllFruits 零 Sell 零误报', async () => {
  const storePath = require.resolve('../src/models/store');
  const previousStore = require.cache[storePath];
  require.cache[storePath] = mockModule(storePath, {
    isAutomationOn: flag => flag === 'sell',
  });
  const bagBody = await encodeSimulatedBagReply({
    item_bag: {
      items: [
        ...NEW_GOLDEN_FRUITS.map(spec => ({ id: spec.id, count: 2 })),
        { id: 1001, count: 9999 },
      ],
    },
  });
  const { warehouse, calls, logs, restore } = await reloadWarehouseWithNetworkStub({ bagBody });
  try {
    await warehouse.sellAllFruits();
    assert.deepEqual(calls.map(call => call.method), ['Bag'], '仅一次 Bag 读取');
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
    item_bag: {
      items: [
        { id: GOLDEN_FRUIT_ID, count: 2 },
        ...NEW_GOLDEN_FRUITS.map(spec => ({ id: spec.id, count: 1 })),
      ],
    },
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
      for (const spec of NEW_GOLDEN_FRUITS) {
        const entry = detail.items.find(item => item.id === spec.id);
        assert.equal(entry?.name, spec.name);
        assert.equal(entry?.category, 'fruit');
        assert.equal(entry?.itemType, 17);
        assert.equal(entry?.count, 1);
      }
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
