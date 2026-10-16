const test = require('node:test'); const assert = require('node:assert/strict');
const fs = require('node:fs'); const path = require('node:path'); const os = require('node:os'); const crypto = require('node:crypto');
const temp = fs.realpathSync(os.tmpdir()); const prefix = path.resolve(temp, 'farm-single-footprint-');
assert.equal(path.dirname(prefix), temp);
const data = fs.mkdtempSync(prefix); process.env.FARM_DATA_DIR = data;
const base = path.resolve(__dirname, '../src/gameConfig');
const files = [__filename, ...['EventPlants.json', 'EventItems.json', 'seed_images_named/event-seed-sources.json'].map(x => path.resolve(base, x))];
const fingerprint = () => files.map(file => ({ mode: fs.statSync(file).mode & 0o777, sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') }));
const before = fingerprint(); const config = require('../src/config/gameConfig');
const { loadProto, types } = require('../src/utils/proto');
const cases = [
  [20525, 1020525, 40525, '森野甜莓'], [20526, 1020526, 40526, '森野白桃'],
  [20527, 1020527, 40527, '森野甜橙'], [20528, 1020528, 40528, '森野红柚'],
  [20529, 1020529, 40529, '森野芭乐'], [21435, 1021435, 41435, '森野柿子'],
  [20021, 1020021, 40021, '森野可可豆'],
];
test.before(async () => { await loadProto(); });
test.after(() => { try { assert.deepEqual(fingerprint(), before); } finally { assert.equal(path.dirname(data), temp); fs.rmSync(data, { recursive: true, force: true }); } });
function replaceModules(replacements) {
  const old = replacements.map(([name]) => { const id = require.resolve(name); return [id, require.cache[id]]; });
  replacements.forEach(([, value], i) => { if (value) require.cache[old[i][0]] = { exports: value }; else delete require.cache[old[i][0]]; });
  return () => { for (const [id, value] of old) { if (value) require.cache[id] = value; else delete require.cache[id]; } };
}
function warehouseFixture(t, items = [], sale = false) {
  const calls = []; const logs = []; const store = require('../src/models/store'); const utils = require('../src/utils/utils');
  t.after(replaceModules([
    ['../src/utils/network', { getUserState: () => ({ accountId: 'synthetic-footprint', level: 1, gold: 0 }), getWsErrorState: () => null,
      sendMsgAsync: async (_service, method) => { calls.push(method); assert.equal(method, 'Bag', 'fixture permits no economic game write'); return { body: types.BagReply.encode({ item_bag: { items } }).finish() }; } }],
    ['../src/utils/utils', { ...utils, log: (_tag, message, meta) => logs.push({ message, meta }), logWarn: () => {} }],
    ['../src/models/store', { ...store, isAutomationOn: () => sale }], ['../src/services/warehouse', null],
  ]));
  return { warehouse: require('../src/services/warehouse'), calls, logs };
}
for (const [seed, plantId, fruitId, name] of cases) test(`${name} follows its reviewed single-plot mapping through the real bag priority entry`, t => {
  const plant = config.getPlantBySeedId(seed);
  assert.ok(plant, 'reviewed current seed must have its Plant mapping');
  assert.equal(plant.id, plantId); assert.equal(plant.size, 1); assert.equal(plant.land_level_need, 1);
  assert.deepEqual(plant.fruit, { id: fruitId, count: 10 }); assert.equal(config.getPlantByFruitId(fruitId).id, plantId);
  const f = warehouseFixture(t); const [dto] = f.warehouse.getBagSeedsFromItems([{ id: seed, count: 2 }]);
  assert.equal(dto.name, `${name  }种子`); assert.equal(dto.plantSize, 1); assert.equal(dto.mappingStatus, 'mapped');
  assert.equal(dto.requiredLevel, 1, 'ItemInfo display level must not replace Plant land requirement');
  assert.ok(dto.image); assert.equal(f.logs.some(x => x.meta?.event === 'bag_seed_detect'), false); assert.deepEqual(f.calls, []);
});

test('actual BagReply decoding clears all seven known footprint gaps while keeping existing four-grid and images', async t => {
  const items = [...cases.map(([id], i) => ({ id, count: 1, uid: 8000 + i })), { id: 29005, count: 1, uid: 8010 }];
  const f = warehouseFixture(t, items); const bag = await f.warehouse.getBagDetail();
  for (const [seed] of cases) assert.equal(bag.items.find(x => x.id === seed)?.plantSize, 1);
  assert.equal(bag.items.find(x => x.id === 29005)?.plantSize, 2);
  assert.equal(bag.seedRecognition.issues.some(x => ['seed_footprint_unverified', 'seed_icon_missing'].includes(x.kind)), false);
  assert.deepEqual(f.calls, ['Bag']);
});

test('new mappings do not allow selling milk-tea recipe ingredients with conditional-only prices', async t => {
  for (const [, plant, fruit] of cases) {
    assert.equal(config.getPlantByFruitId(fruit)?.id, plant);
    const info = config.getItemById(fruit); assert.equal(info.sells, null); assert.equal(info.official_type, 6);
    assert.equal(info.sell_cond, '活动区间外:2026110101'); assert.ok(info.cond_sells); assert.ok(info.evidence);
  }
  const f = warehouseFixture(t, cases.map(([, , id], i) => ({ id, count: 10, uid: 8100 + i })), true);
  await f.warehouse.sellAllFruits(); assert.deepEqual(f.calls, ['Bag'], 'all conditional-only fruit must produce zero Sell');
});

test('unrelated entries and rare/golden meanings are preserved; reviewed defaults are explicit', () => {
  const plants = JSON.parse(fs.readFileSync(path.join(base, 'EventPlants.json'))); const items = JSON.parse(fs.readFileSync(path.join(base, 'EventItems.json')));
  const hash = x => crypto.createHash('sha256').update(JSON.stringify(x)).digest('hex');
  const selectedPlants = new Set(cases.map(x => x[1])); const selectedFruits = new Set(cases.map(x => x[2]));
  assert.equal(hash(plants.filter(x => !selectedPlants.has(x.id))), '74e6c25a895ffe9d969e1bdf17486181a82c1e9fbca3da295a36bc877d652a9d');
  assert.equal(hash(items.filter(x => !selectedFruits.has(x.id))), '4baaa0138392f234b1a06ca7dd2161537b8de7cdf9ce8932e5bd950fb072ebe6');
  for (const [seed, plant] of cases) assert.equal(plants.find(x => x.id === plant && x.seed_id === seed)?.size, 1);
  assert.equal(config.getPlantBySeedId(29005).size, 2); assert.equal(config.getPlantBySeedId(29004).size, 2);
  assert.equal(config.getPlantByFruitId(1040525), undefined, 'golden fruit does not become a seed-bearing Plant');
  assert.equal(new Set(plants.map(x => x.id)).size, plants.length); assert.equal(new Set(items.map(x => x.id)).size, items.length);
  const provenance = JSON.parse(fs.readFileSync(path.join(base, 'seed_images_named/event-seed-sources.json'))).reviewedPlantMappings;
  assert.ok(provenance, 'selected default-size registrations must retain reviewed provenance');
  assert.equal(provenance.sourceGrade, 'reviewed_public_client_snapshot');
  assert.equal(provenance.sizeEvidence, 'reviewed_client_default_single_plot');
  assert.deepEqual(provenance.mappings.map(x => [x.seedId, x.plantId, x.fruitId, x.size, x.sourceSize]), cases.map(x => [x[0], x[1], x[2], 1, null]));
});

test('real planting selects one plot for the confirmed seed and leaves truly unknown seeds unplanted', async t => {
  const f = warehouseFixture(t); const seeds = f.warehouse.getBagSeedsFromItems([{ id: 20525, count: 1 }, { id: 799991, count: 1, showName: '合成未知种子' }]);
  assert.equal(seeds.find(x => x.seedId === 799991).plantSize, 0);
  const calls = []; const restore = replaceModules([
    ['../src/services/warehouse', { getBagSeeds: async () => seeds }], ['../src/services/planting-service', null],
    ['../src/utils/network', { getUserState: () => ({ accountId: 'synthetic-footprint', level: 1 }), getWsErrorState: () => null,
      sendMsgAsync: async (_service, method, bytes) => { assert.equal(method, 'Plant'); const row = types.PlantRequest.decode(bytes).items[0]; calls.push({ seed: Number(row.seed_id), ids: row.land_ids.map(Number) });
        return { body: types.PlantReply.encode({ land: [{ id: 1, land_size: 1 }] }).finish() }; } }],
    ['../src/services/farm-api', { getShopInfo: async () => { throw new Error('unexpected_shop'); }, buyGoods: async () => { throw new Error('unexpected_buy'); }, getSeedShopId: () => 1, removePlant: async () => ({}) }],
    ['../src/services/farm-fertilizer', { runFertilizerByConfig: async () => ({}) }], ['../src/services/analytics', { getPlantRankings: () => [] }],
    ['../src/models/store', { getPlantingStrategy: () => 'bag_priority', getPreferredSeed: () => 0, getBagSeedPriority: () => [], getBagSeedFallbackStrategy: () => 'level', getPrioritize2x2Crops: () => true, getPlantOrderRandom: () => false, getPlantDelaySeconds: () => 0 }],
    ['../src/utils/behavior', { shuffleInPlace: () => {}, pauseSeconds: async () => {} }],
  ]);
  try {
    const planting = require('../src/services/planting-service');
    const result = await planting.autoPlantEmptyLands([], [1], [{ id: 1, unlocked: true }]);
    assert.equal(result.plantedCount, 1); assert.equal(result.occupiedCount, 1);
    assert.deepEqual(calls, [{ seed: 20525, ids: [1] }]);
  } finally { restore(); }
});
