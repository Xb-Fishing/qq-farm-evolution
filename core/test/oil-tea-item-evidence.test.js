const test = require('node:test'); const assert = require('node:assert/strict');
const fs = require('node:fs'); const path = require('node:path'); const os = require('node:os'); const crypto = require('node:crypto');
// FARM_DATA_DIR 必须先于任何业务模块加载隔离。
const temp = fs.realpathSync(os.tmpdir()); const prefix = path.resolve(temp, 'farm-oil-tea-evidence-');
assert.equal(path.dirname(prefix), temp);
const repoRoot = fs.realpathSync(path.resolve(__dirname, '../..'));
assert.ok(temp !== repoRoot && !temp.startsWith(repoRoot + path.sep), 'fixture temp root must be outside candidate');
const data = fs.mkdtempSync(prefix); process.env.FARM_DATA_DIR = data;
const repoFiles = ['../src/gameConfig/EventPlants.json', '../src/gameConfig/EventItems.json', '../src/gameConfig/seed_images_named/event-seed-sources.json'].map(x => path.resolve(__dirname, x));
const pngFiles = ['20530_Crop_530_Seed.png', '40530_Crop_530_Fruit.png', '1040529_gold_Crop_529.png', '1040530_gold_Crop_530.png']
  .map(x => path.resolve(__dirname, '../src/gameConfig/seed_images_named', x));
const fingerprint = () => [...repoFiles, ...pngFiles].map(file => (fs.existsSync(file)
  ? { mode: fs.statSync(file).mode & 0o777, sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') }
  : { missing: true }));
const before = fingerprint();
const config = require('../src/config/gameConfig');
const { loadProto, types } = require('../src/utils/proto');
const planting = require('../src/services/planting-service');
const GROW = '种子:8640;发芽:8640;小叶子:8640;大叶子:8640;初熟:8640;成熟:0;';
test.before(async () => { await loadProto(); });
test.after(() => { try { assert.deepEqual(fingerprint(), before); } finally { assert.equal(path.dirname(data), temp); fs.rmSync(data, { recursive: true, force: true }); } });
function replaceModules(replacements) {
  const old = replacements.map(([name]) => { const id = require.resolve(name); return [id, require.cache[id]]; });
  replacements.forEach(([, value], i) => { if (value) require.cache[old[i][0]] = { exports: value }; else delete require.cache[old[i][0]]; });
  return () => { for (const [id, value] of old) { if (value) require.cache[id] = value; else delete require.cache[id]; } };
}
// 合成 Bag：网络完全替身，唯一经济写原语是 Sell，且逐条记录请求内容。
function warehouseFixture(t, items = [], sale = false) {
  const calls = []; const logs = []; let gold = 0;
  const store = require('../src/models/store'); const utils = require('../src/utils/utils');
  t.after(replaceModules([
    ['../src/utils/network', { getUserState: () => ({ accountId: 'synthetic-oil-tea', level: 1, gold }), getWsErrorState: () => null,
      sendMsgAsync: async (_service, method, request) => {
        calls.push({ method, request });
        if (method === 'Sell') { gold += 2800; return { body: types.SellReply.encode({}).finish() }; }
        assert.equal(method, 'Bag', 'fixture permits no economic game write besides Sell');
        return { body: types.BagReply.encode({ item_bag: { items } }).finish() };
      } }],
    ['../src/utils/utils', { ...utils, log: (_tag, message, meta) => logs.push({ message, meta }), logWarn: () => {} }],
    ['../src/models/store', { ...store, isAutomationOn: () => sale }], ['../src/services/warehouse', null],
  ]));
  return { warehouse: require('../src/services/warehouse'), calls, logs };
}
const sellRequestIds = calls => calls.filter(c => c.method === 'Sell').flatMap(c => types.SellRequest.decode(c.request).items.map(item => Number(item.id)));

test('官方逐行核对的油茶四 Item：精确 type/asset/sells 且 sell_cond/cond_sells 均 null', () => {
  const seed = config.getItemById(20530);
  assert.ok(seed, '20530 油茶种子必须已在 ItemInfo 索引');
  assert.equal(seed.name, '油茶种子'); assert.equal(seed.type, 5); assert.equal(seed.interaction_type, 'plant');
  assert.equal(seed.asset_name, 'Crop_530'); assert.equal(seed.sells, '1001:2000'); assert.equal(seed.level, 41);
  assert.equal(seed.sell_cond, null); assert.equal(seed.cond_sells, null); assert.ok(config.isSeedItem(20530));
  const fruit = config.getItemById(40530);
  assert.ok(fruit, '40530 油茶必须已在 ItemInfo 索引');
  assert.equal(fruit.name, '油茶'); assert.equal(fruit.type, 4); assert.equal(fruit.official_type, 6);
  assert.equal(fruit.asset_name, 'Crop_530'); assert.equal(fruit.sells, '1001:280');
  assert.equal(fruit.sell_cond, null); assert.equal(fruit.cond_sells, null);
  for (const [id, name, asset] of [[1040529, '黄金·森野芭乐', 'gold/Crop_529'], [1040530, '黄金·油茶', 'gold/Crop_530']]) {
    const golden = config.getItemById(id);
    assert.ok(golden, `${id} 必须已登记`);
    assert.equal(golden.name, name); assert.equal(golden.type, 17); assert.equal(golden.asset_name, asset);
    assert.equal(golden.sells, '1005:6', `${id} 按官方行取 1005:6，不沿用旧族 1005:3 特例`);
    assert.equal(golden.sell_cond, null); assert.equal(golden.cond_sells, null);
  }
});

test('普通油茶 Plant 1020530 逐字段核对；黄金 1120529/1120530 不进植物表', () => {
  const plant = config.getPlantBySeedId(20530);
  assert.ok(plant, '20530 必须有已核对的 Plant 映射');
  assert.equal(plant.id, 1020530); assert.equal(plant.name, '油茶'); assert.equal(plant.seed_id, 20530);
  assert.equal(plant.land_level_need, 1); assert.equal(plant.seasons, 1); assert.equal(plant.exp, 1680);
  assert.equal(plant.grow_phases, GROW, 'grow_phases 必须保留官方原串');
  assert.deepEqual(plant.fruit, { id: 40530, count: 48 }); assert.equal(plant.asset_name, 'Crop_530');
  assert.equal(plant.size, 1, '同版本缺省单格证据下显式登记 1'); assert.equal(plant.mutant_effect_plant, '5:1120530:1');
  assert.equal(config.getPlantByFruitId(40530).id, 1020530);
  assert.ok(!config.getPlantById(1120530), '黄金·油茶仅类型交叉，不得进植物表');
  assert.ok(!config.getPlantById(1120529), '黄金·森野芭乐仅类型交叉，不得进植物表');
  assert.ok(!config.getPlantByFruitId(1040530)); assert.ok(!config.getPlantByFruitId(1040529));
});

test('真实背包分类：20530 走已映射单格种子，40530 果实，黄金仅展示分类；1x1/2x2 消费边界不混', async t => {
  const f = warehouseFixture(t, [
    { id: 20530, count: 5, uid: 9001 }, { id: 40530, count: 48, uid: 9002 },
    { id: 1040529, count: 2, uid: 9003 }, { id: 1040530, count: 1, uid: 9004 }, { id: 29005, count: 3, uid: 9005 },
  ]);
  const [seedDto] = f.warehouse.getBagSeedsFromItems([{ id: 20530, count: 5 }]);
  assert.ok(seedDto, '20530 必须被真实背包种子识别链路识别');
  assert.equal(seedDto.name, '油茶种子'); assert.equal(seedDto.plantSize, 1); assert.equal(seedDto.mappingStatus, 'mapped');
  assert.equal(seedDto.requiredLevel, 1, 'ItemInfo 展示 level 41 不得替代 Plant land_level_need 1');
  assert.ok(seedDto.image, '已交付专属种子图必须命中');
  assert.equal(planting.getPlantSizeBySeedId(20530), 1, '真实种植入口按单格消费油茶种子');
  assert.equal(planting.getPlantSizeBySeedId(29005), 2, '既有 2x2 作物尺寸不受影响');
  const dtos = f.warehouse.getBagSeedsFromItems([{ id: 20530, count: 5 }, { id: 29005, count: 3 }]);
  assert.deepEqual(dtos.filter(s => Number(s.plantSize) === 2).map(s => s.seedId), [29005], '2x2 优先队列不得误收单格油茶');
  assert.deepEqual(dtos.filter(s => Number(s.plantSize) === 1).map(s => s.seedId), [20530], '单格队列必须收油茶');
  const detail = await f.warehouse.getBagDetail();
  const byId = id => detail.items.find(row => row.id === id);
  assert.equal(byId(20530).category, 'seed'); assert.equal(byId(40530).category, 'fruit');
  assert.equal(byId(1040529).category, 'fruit', 'type 17 黄金果实保持展示分类'); assert.equal(byId(1040530).category, 'fruit');
  assert.ok(byId(40530).image && byId(1040529).image && byId(1040530).image, '四张专属图必须命中命名映射');
  for (const [id, file] of [[20530, '20530_Crop_530_Seed.png'], [40530, '40530_Crop_530_Fruit.png'],
    [1040529, '1040529_gold_Crop_529.png'], [1040530, '1040530_gold_Crop_530.png']]) {
    assert.ok(byId(id).image.endsWith(file), 'lookup must resolve the reviewed dedicated resource');
  }
  assert.deepEqual(f.calls.map(c => c.method), ['Bag']);
});

test('真实 sellAllFruits：普通 40530 可售，两个黄金不自动售，旧活动 40529 条件售价仍保护', async t => {
  const f = warehouseFixture(t, [
    { id: 40530, count: 48, uid: 9100 }, { id: 1040529, count: 2, uid: 9101 },
    { id: 1040530, count: 1, uid: 9102 }, { id: 40529, count: 10, uid: 9103 },
  ], true);
  await f.warehouse.sellAllFruits();
  assert.deepEqual(sellRequestIds(f.calls), [40530], '只有无条件售价的普通油茶进入自动出售');
  assert.deepEqual(f.calls.filter(c => c.method === 'Sell').flatMap(c => types.SellRequest.decode(c.request).items.map(item => Number(item.count))), [48]);
  assert.ok(f.logs.some(x => x.message.includes('油茶x48')), '出售日志必须记录普通油茶');
});

test('真实背包种植与四格优先入口分别消费正确种子，优先列表不是白名单', async t => {
  const f = warehouseFixture(t);
  const seeds = f.warehouse.getBagSeedsFromItems([{ id: 20530, count: 2 }, { id: 29005, count: 1 }]);
  assert.equal(seeds.find(row => row.seedId === 20530)?.plantSize, 1);
  const store = require('../src/models/store');
  const utils = require('../src/utils/utils');
  const calls = [];
  const restore = replaceModules([
    ['../src/utils/network', {
      getUserState: () => ({ accountId: 'synthetic-oil-tea', level: 240 }), getWsErrorState: () => null,
      sendMsgAsync: async (service, method, payload) => {
        assert.equal(service, 'gamepb.plantpb.PlantService'); assert.equal(method, 'Plant');
        const request = types.PlantRequest.decode(payload);
        assert.equal(request.items.length, 1);
        const item = request.items[0]; const ids = item.land_ids.map(Number);
        calls.push({ seed: Number(item.seed_id), ids });
        const land = ids.length === 4
          ? [{ id: ids[0], land_size: 2, slave_land_ids: ids.slice(1) }, ...ids.slice(1).map(id => ({ id, master_land_id: ids[0] }))]
          : ids.map(id => ({ id }));
        return { body: types.PlantReply.encode({ land }).finish() };
      },
    }],
    ['../src/models/store', { ...store, getBagSeedPriority: () => [], getPrioritize2x2Crops: () => true,
      getPlantOrderRandom: () => false, getPlantDelaySeconds: () => 0 }],
    ['../src/utils/utils', { ...utils, log: () => {}, logWarn: () => {} }],
    ['../src/services/warehouse', { getBagSeeds: async () => seeds }],
    ['../src/services/planting-service', null],
  ]);
  try {
    const service = require('../src/services/planting-service');
    const ordinary = await service.plantFromBagSeeds([11, 12], 'synthetic-oil-tea');
    assert.equal(ordinary.totalPlanted, 2);
    assert.deepEqual(calls, [{ seed: 20530, ids: [11] }, { seed: 20530, ids: [12] }]);
    const ids = [1, 2, 5, 6];
    const square = await service.plantPrioritized2x2Crops(ids, ids.map(id => ({ id, unlocked: true })), 'synthetic-oil-tea');
    assert.equal(square.plantedCount, 1); assert.equal(square.occupiedCount, 4);
    assert.equal(calls.length, 3); assert.equal(calls[2].seed, 29005);
    assert.deepEqual([...calls[2].ids].sort((a, b) => a - b), ids);
  } finally { restore(); }
});

test('资源登记与 PNG 字节一致：4 张专属图 sourcePath/gitBlob/sha256/尺寸逐项对齐', () => {
  const registry = JSON.parse(fs.readFileSync(repoFiles[2], 'utf8')).reviewedResources;
  const expect = {
    20530: ['20530_Crop_530_Seed.png', 'Crop_530', 'seed'],
    40530: ['40530_Crop_530_Fruit.png', 'Crop_530', 'fruit'],
    1040529: ['1040529_gold_Crop_529.png', 'gold/Crop_529', 'golden_fruit'],
    1040530: ['1040530_gold_Crop_530.png', 'gold/Crop_530', 'golden_fruit'],
  };
  for (const [id, [file, assetName, kind]] of Object.entries(expect)) {
    const row = registry.find(entry => entry.itemId === Number(id));
    assert.ok(row, `${id} 必须登记 reviewedResources`);
    const pngPath = path.resolve(__dirname, '../src/gameConfig/seed_images_named', file);
    assert.ok(fs.existsSync(pngPath), `${file} 专属图必须已交付`);
    assert.equal(row.file, file); assert.equal(row.assetName, assetName); assert.equal(row.kind, kind);
    assert.equal(row.sourceGrade, 'reviewed_public_client_snapshot'); assert.equal(row.repositoryAlias, 'public-reference-2');
    assert.equal(row.sourceCommit, '5e7c027115ede6fc835bb69d7ad9a081a84c4133');
    assert.equal(row.sourcePath, `core/src/gameConfig/seed_images_named/seed_images/${id}.png`);
    const bytes = fs.readFileSync(pngPath);
    assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), row.sha256, `${id} PNG 字节必须与登记 sha256 一致`);
    assert.equal(crypto.createHash('sha1').update(Buffer.from(`blob ${bytes.length}\0`)).update(bytes).digest('hex'), row.gitBlob, `${id} PNG 必须与登记 Git blob 一致`);
    assert.deepEqual([bytes.readUInt32BE(16), bytes.readUInt32BE(20)], [row.width, row.height]);
    assert.equal(bytes.subarray(1, 4).toString(), 'PNG');
  }
});

test('旧家族基线保持：1020529 森野芭乐与 40529 条件售价深比较不变', () => {
  const plant = config.getPlantBySeedId(20529);
  assert.equal(plant.id, 1020529); assert.deepEqual(plant.fruit, { id: 40529, count: 10 }); assert.equal(plant.size, 1);
  assert.equal(plant.mutant_effect_plant, '5:1120529:1');
  const fruit = config.getItemById(40529);
  assert.equal(fruit.type, 4); assert.equal(fruit.official_type, 6); assert.equal(fruit.sells, null);
  assert.equal(fruit.sell_cond, '活动区间外:2026110101'); assert.equal(fruit.cond_sells, '1001:10000');
});
