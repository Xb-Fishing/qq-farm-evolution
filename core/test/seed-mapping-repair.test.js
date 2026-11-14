const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const temp = fs.realpathSync(os.tmpdir()), prefix = path.resolve(temp, 'farm-seed-mapping-');
assert.equal(path.dirname(prefix), temp);
const privateDir = fs.mkdtempSync(prefix); process.env.FARM_DATA_DIR = privateDir;
const files = [__filename, '../src/gameConfig/EventItems.json', '../src/gameConfig/EventPlants.json', '../src/services/warehouse.js', '../src/services/evolution-issue-inbox.js'].map(f => path.resolve(__dirname, f));
const fingerprint = () => files.map(f => ({ mode: fs.statSync(f).mode & 0o777, hash: crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex') }));
const before = fingerprint(), config = require('../src/config/gameConfig'), { loadProto, types } = require('../src/utils/proto');
test.before(async () => { await loadProto(); });
test.after(() => { try { assert.deepEqual(fingerprint(), before); } finally { assert.equal(path.dirname(privateDir), temp); fs.rmSync(privateDir, { recursive: true, force: true }); } });
function replaceModules(replacements) {
  const saved = replacements.map(([name]) => { const f = require.resolve(name); return [f, require.cache[f]]; });
  replacements.forEach(([, exports], i) => { if (exports) require.cache[saved[i][0]] = { exports }; else delete require.cache[saved[i][0]]; });
  return () => { for (const [f, original] of saved) { if (original) require.cache[f] = original; else delete require.cache[f]; } };
}
function fixture(t, items = [], sale = false) {
  const logs = [], calls = [], utils = require('../src/utils/utils'), store = require('../src/models/store');
  t.after(replaceModules([
    ['../src/config/gameConfig', { ...config,
      getItemById: id => [29981, 29982].includes(Number(id))
        ? { id: Number(id), type: 5, name: Number(id) === 29981 ? '合成种子甲' : '合成种子乙', evidence: 'synthetic fixture' }
        : config.getItemById(id),
      isSeedItem: id => [29981, 29982].includes(Number(id)) || config.isSeedItem(id),
    }],
    ['../src/utils/network', { getUserState: () => ({ accountId: 'fixture-account', level: 1, gold: 0 }), getWsErrorState: () => null,
      sendMsgAsync: async (service, method) => { calls.push({ service, method }); assert.equal(method, 'Bag', 'no unconfirmed game write'); return { body: types.BagReply.encode({ item_bag: { items } }).finish() }; } }],
    ['../src/utils/utils', { ...utils, log: (_tag, message, meta) => logs.push({ message, meta }), logWarn: () => {} }],
    ['../src/models/store', { ...store, isAutomationOn: () => sale }], ['../src/services/warehouse', null],
  ]));
  return { warehouse: require('../src/services/warehouse'), logs, calls };
}
test('observed seed has reviewed explicit size2 and correct seed-to-fruit mapping', () => {
  const p = config.getPlantBySeedId(29005); assert.ok(p, 'reviewed observed seed must have a real mapping');
  assert.equal(p.id, 1029005); assert.equal(p.size, 2); assert.deepEqual(p.fruit, { id: 49005, count: 10 }); assert.equal(p.land_level_need, 1);
  assert.equal(config.getItemById(29005).name, '森野黄金芽种子'); assert.equal(config.getPlantByFruitId(49005).id, p.id);
});
test('actual Bag decoding returns mapped size2 with no footprint fallback with its delivered exclusive icon', async t => {
  const f = fixture(t, [{ id: 29005, count: 1, uid: 7001 }]), bag = await f.warehouse.getBagDetail();
  assert.equal(bag.items.find(x => x.id === 29005)?.plantSize, 2);
  const [seed] = f.warehouse.getBagSeedsFromItems([{ id: 29005, count: 1 }]);
  assert.equal(seed.mappingStatus, 'mapped'); assert.equal(seed.plantSize, 2); assert.equal(seed.requiredLevel, 1);
  assert.equal(f.logs.filter(x => x.meta?.event === 'bag_seed_detect').length, 0);
  assert.equal(bag.seedRecognition.issues.some(x => x.itemId === 29005 && x.kind === 'seed_footprint_unverified'), false);
  assert.equal(bag.seedRecognition.issues.some(x => x.itemId === 29005 && x.kind === 'seed_icon_missing'), false);
  assert.deepEqual(f.calls.map(x => x.method), ['Bag']);
});
test('missing mappings retain bounded diagnostic categories independent of item order and duplicate stacks', t => {
  const f = fixture(t);
  f.warehouse.getBagSeedsFromItems([{ id: 29981, count: 1 }, { id: 29981, count: 2 }]);
  f.warehouse.getBagSeedsFromItems([{ id: 29981, count: 5 }]);
  f.warehouse.getBagSeedsFromItems([{ id: 29981, count: 1 }, { id: 29982, count: 1 }]);
  f.warehouse.getBagSeedsFromItems([{ id: 29982, count: 2 }, { id: 29981, count: 1 }]);
  f.warehouse.getBagSeedsFromItems([{ id: 29981, count: 1 }]);
  const logs = f.logs.filter(x => x.meta?.event === 'bag_seed_detect'); assert.equal(logs.length, 3);
  assert.deepEqual(logs[0].meta.addedSeedIds, [29981]); assert.equal(logs[0].meta.count, 1);
  for (const row of logs) assert.doesNotMatch(row.message, /29982|29981/); assert.deepEqual(f.calls, []);
});
test('cleared sets report later recurrence; unrelated unverified seed size remains zero', t => {
  const f = fixture(t);
  f.warehouse.getBagSeedsFromItems([{ id: 29981, count: 1 }]); f.warehouse.getBagSeedsFromItems([{ id: 29005, count: 1 }]);
  const [seed] = f.warehouse.getBagSeedsFromItems([{ id: 29981, count: 1 }]); assert.equal(seed.plantSize, 0); assert.equal(config.getPlantBySeedId(29981), undefined);
  assert.deepEqual(config.getGenericFallbackItemIds(), []);
});
test('new plant identity does not authorize the conditional-sale activity fruit for automatic sale', async t => {
  assert.ok(config.getPlantByFruitId(49005), 'normal fruit identity is mapped');
  const info = config.getItemById(49005); assert.equal(info.sell_cond, '活动区间外:2026110101'); assert.equal(info.sells, null);
  const f = fixture(t, [{ id: 49005, count: 10 }], true); await f.warehouse.sellAllFruits(); assert.deepEqual(f.calls.map(x => x.method), ['Bag']);
  assert.ok(config.getPlantByFruitId(40001), 'ordinary crop identity stays available');
});
test('the real planting entry uses the newly mapped seed as one request occupying four lands', async t => {
  const f = fixture(t), seeds = f.warehouse.getBagSeedsFromItems([{ id: 29005, count: 1 }]); assert.equal(seeds[0].plantSize, 2);
  const calls = [], restore = replaceModules([
    ['../src/services/warehouse', { getBagSeeds: async () => seeds }], ['../src/services/planting-service', null],
    ['../src/utils/network', { getUserState: () => ({ accountId: 'fixture-account', level: 1 }), getWsErrorState: () => null,
      sendMsgAsync: async (_service, method, bytes) => { assert.equal(method, 'Plant'); const item = types.PlantRequest.decode(bytes).items[0], ids = item.land_ids.map(Number); calls.push({ seed: Number(item.seed_id), ids });
        return { body: types.PlantReply.encode({ land: [{ id: ids[0], land_size: 2, slave_land_ids: ids.slice(1) }, ...ids.slice(1).map(id => ({ id, master_land_id: ids[0] }))] }).finish() }; } }],
    ['../src/services/farm-api', { getShopInfo: async () => { throw new Error('unexpected_shop'); }, buyGoods: async () => { throw new Error('unexpected_buy'); }, getSeedShopId: () => 1, removePlant: async () => ({}) }],
    ['../src/services/farm-fertilizer', { runFertilizerByConfig: async () => ({}) }], ['../src/services/analytics', { getPlantRankings: () => [] }],
    ['../src/models/store', { getPlantingStrategy: () => 'bag_priority', getPreferredSeed: () => 0, getBagSeedPriority: () => [], getBagSeedFallbackStrategy: () => 'level', getPrioritize2x2Crops: () => true, getPlantOrderRandom: () => false, getPlantDelaySeconds: () => 0 }],
    ['../src/utils/behavior', { shuffleInPlace: () => {}, pauseSeconds: async () => {} }],
  ]);
  try {
    const planting = require('../src/services/planting-service'), ids = [1, 2, 5, 6]; const result = await planting.autoPlantEmptyLands([], ids, ids.map(id => ({ id, unlocked: true })));
    assert.equal(result.plantedCount, 1); assert.equal(result.occupiedCount, 4); assert.equal(calls.length, 1); assert.equal(calls[0].seed, 29005); assert.equal(calls[0].ids.length, 4);
  } finally { restore(); }
});
