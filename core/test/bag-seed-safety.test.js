const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

// No business module may load before the isolated data root is installed.
test('bag seed safety through real DTO, planting entry points and Plant codec', async (t) => {
  const sourcePaths = [
    'src/gameConfig/EventItems.json', 'src/gameConfig/EventPlants.json',
    'src/gameConfig/Plant.json', 'src/services/planting-service.js',
    'src/services/warehouse.js', 'test/bag-seed-safety.test.js',
  ].map(file => path.resolve(__dirname, '..', file));
  const snapshots = sourcePaths.map(file => ({
    file, bytes: fs.readFileSync(file), mode: fs.statSync(file).mode,
  }));
  const previousDataDir = process.env.FARM_DATA_DIR;
  const tempParent = fs.realpathSync(os.tmpdir());
  const repoRoot = fs.realpathSync(path.resolve(__dirname, '..', '..'));
  assert.ok(tempParent !== repoRoot && !tempParent.startsWith(repoRoot + path.sep));
  const fixturePrefix = path.resolve(tempParent, 'bag-seed-safety-');
  assert.equal(path.dirname(fixturePrefix), tempParent);
  const dataDir = fs.mkdtempSync(fixturePrefix);
  assert.equal(path.dirname(fs.realpathSync(dataDir)), tempParent);
  process.env.FARM_DATA_DIR = dataDir;
  const savedModules = new Map();
  const state = { items: [], calls: [], failAt: 0, malformedAt: 0, error: 'reply lost after send', shopCalls: 0 };
  function inject(relative, exports) {
    const filename = require.resolve(relative);
    if (!savedModules.has(filename)) savedModules.set(filename, require.cache[filename]);
    require.cache[filename] = { id: filename, filename, loaded: true, exports };
  }
  try {
    const realUtils = require('../src/utils/utils');
    inject('../src/utils/utils', { ...realUtils, log: () => {}, logWarn: () => {} });
    inject('../src/models/store', {
      getPlantingStrategy: () => 'bag_priority', getPreferredSeed: () => 0,
      getBagSeedPriority: () => [20002], getBagSeedFallbackStrategy: () => 'level',
      getPrioritize2x2Crops: () => false, getPlantOrderRandom: () => false,
      getPlantDelaySeconds: () => 0, isAutomationOn: () => false,
    });
    inject('../src/services/evolution-issue-inbox', { recordRuntimeIssue: () => {} });
    inject('../src/services/status', { updateStatusGold: () => {} });
    const proto = require('../src/utils/proto');
    await proto.loadProto();
    const { types } = proto;
    inject('../src/utils/network', {
      networkEvents: new EventEmitter(),
      getUserState: () => ({ accountId: 'synthetic-bag-safety', level: 200, gold: 1000 }),
      getWsErrorState: () => null,
      sendMsgAsync: async (service, method, payload) => {
        assert.equal(service, 'gamepb.plantpb.PlantService');
        assert.equal(method, 'Plant');
        const request = types.PlantRequest.decode(payload);
        assert.equal(request.items.length, 1);
        const item = request.items[0];
        const call = { seedId: Number(item.seed_id), landIds: item.land_ids.map(Number) };
        state.calls.push(call); // The attempt has already crossed the transport boundary.
        if (state.calls.length === state.failAt) throw new Error(state.error);
        if (state.calls.length === state.malformedAt) return { body: Buffer.from([0x0A, 0xFF]) };
        return { body: types.PlantReply.encode(types.PlantReply.create({
          land: call.landIds.map(id => ({ id })),
        })).finish() };
      },
    });
    const warehouse = require('../src/services/warehouse');
    inject('../src/services/warehouse', {
      ...warehouse, getBagSeeds: async () => warehouse.getBagSeedsFromItems(state.items),
    });
    const shop = async () => { state.shopCalls++; throw new Error('unexpected shop effect'); };
    inject('../src/services/farm-api', {
      getShopInfo: shop, buyGoods: shop, getSeedShopId: shop, removePlant: shop,
    });
    inject('../src/services/farm-fertilizer', { runFertilizerByConfig: async () => ({}) });
    inject('../src/services/analytics', { getPlantRankings: () => [] });
    const planting = require('../src/services/planting-service');
    const config = require('../src/config/gameConfig');
    const { auditBagSeedCoverage } = require('../src/services/seed-catalog-audit');
    function reset(items, failAt = 0, error = 'reply lost after send') {
      Object.assign(state, { items, calls: [], failAt, malformedAt: 0, error, shopCalls: 0 });
    }
    const twoSeeds = () => [{ id: 20002, count: 3 }, { id: 20003, count: 2 }];
    const autoPlant = () => planting.autoPlantEmptyLands([], [1, 2, 3],
      [1, 2, 3].map(id => ({ id, unlocked: true })));

    await t.test('first sent request loses its reply: no next land, seed or shop fallback', async () => {
      reset(twoSeeds(), 1);
      const result = await autoPlant();
      assert.equal(state.calls.length, 1);
      assert.equal(state.shopCalls, 0);
      assert.equal(result.plantedCount, 0);
    });
    await t.test('partial success then failure keeps totals and stops before the next seed', async () => {
      reset([{ id: 20002, count: 2 }, { id: 20003, count: 2 }], 2);
      const result = await planting.plantFromBagSeeds([1, 2, 3]);
      assert.deepEqual(state.calls, [
        { seedId: 20002, landIds: [1] }, { seedId: 20002, landIds: [2] },
      ]);
      assert.equal(result.totalPlanted, 1);
      assert.equal(result.occupiedCount, 1);
      assert.deepEqual(result.plantedLandIds, [1]);
      assert.deepEqual(result.remainingLandIds, [2, 3]);
      assert.equal(result.fallbackAllowed, false);
      assert.equal(state.shopCalls, 0);
    });
    await t.test('a malformed reply after dispatch does not permit another Plant or shop fallback', async () => {
      reset(twoSeeds());
      state.malformedAt = 1;
      const result = await autoPlant();
      assert.equal(state.calls.length, 1);
      assert.equal(state.shopCalls, 0);
      assert.equal(result.plantedCount, 0);
    });
    await t.test('ordinary failure stops only this round; fresh next invocation succeeds', async () => {
      reset(twoSeeds(), 1, 'ordinary planting rejection');
      const failed = await planting.plantFromBagSeeds([1, 2, 3]);
      assert.equal(state.calls.length, 1);
      assert.equal(failed.fallbackAllowed, false);
      reset(twoSeeds());
      const fresh = await planting.plantFromBagSeeds([1, 2, 3]);
      assert.equal(fresh.totalPlanted, 3);
      assert.equal(state.calls.length, 3);
    });
    await t.test('normal multiple seeds include seeds outside the priority list', async () => {
      reset([{ id: 20002, count: 1 }, { id: 20003, count: 2 }]);
      const result = await planting.plantFromBagSeeds([1, 2, 3]);
      assert.equal(result.totalPlanted, 3);
      assert.deepEqual(state.calls.map(call => call.seedId), [20002, 20003, 20003]);
      assert.deepEqual(result.remainingLandIds, []);
      assert.equal(state.shopCalls, 0);
    });
    await t.test('plantSeeds without stopOnError retains its default continuation', async () => {
      reset([], 1);
      const result = await planting.plantSeeds(20002, [1, 2, 3]);
      assert.equal(state.calls.length, 2);
      assert.equal(result.planted, 1);
      assert.deepEqual(result.plantedLandIds, [2]);
      reset([], 1);
      const bounded = await planting.plantSeeds(20002, [1, 2, 3], { maxPlantCount: 2 });
      assert.equal(state.calls.length, 3);
      assert.equal(bounded.planted, 2);
    });
    await t.test('verified pasture seed uses ordinary single plots without shop fallback', async () => {
      reset([{ id: 20040, count: 2 }]);
      assert.equal(config.getPlantBySeedId(20040)?.size, 1);
      const result = await planting.plantFromBagSeeds([1, 2]);
      assert.equal(result.totalPlanted, 2);
      assert.deepEqual(state.calls, [{ seedId: 20040, landIds: [1] }, { seedId: 20040, landIds: [2] }]);
      assert.equal(state.shopCalls, 0);
    });
    await t.test('synthetic item-only seed retains real audit gaps and zero automatic Plant', async () => {
      const unknownId = 940040;
      config.registerRuntimeItem(unknownId, { name: '合成未知占地种子', type: 5, interaction_type: 'plant', evidence: 'synthetic item-only fixture; not production evidence' });
      reset([{ id: unknownId, count: 2 }]);
      const info = config.getItemById(unknownId);
      assert.equal(info?.name, '合成未知占地种子');
      assert.equal(info.type, 5);
      assert.equal(config.isSeedItem(unknownId), true);
      assert.equal(config.getPlantBySeedId(unknownId), undefined);
      assert.equal(config.getSeedImageBySeedId(unknownId), '');
      const seeds = warehouse.getBagSeedsFromItems(state.items);
      assert.equal(seeds.length, 1);
      assert.equal(seeds[0].name, '合成未知占地种子');
      assert.equal(seeds[0].plantSize, 0);
      assert.equal(seeds[0].mappingStatus, 'item_only');
      assert.deepEqual(auditBagSeedCoverage(state.items, seeds).issues.map(issue => issue.kind).sort(),
        ['seed_footprint_unverified', 'seed_icon_missing'].sort());
      await planting.plantFromBagSeeds([1, 2]);
      await planting.autoPlantEmptyLands([], [1, 2],
        [1, 2].map(id => ({ id, unlocked: true })), { bagOnly: true });
      assert.deepEqual(state.calls, []);
      assert.equal(state.shopCalls, 0);
    });
  } finally {
    for (const [filename, original] of savedModules) {
      if (original) require.cache[filename] = original;
      else delete require.cache[filename];
    }
    if (previousDataDir === undefined) delete process.env.FARM_DATA_DIR;
    else process.env.FARM_DATA_DIR = previousDataDir;
    assert.equal(path.dirname(path.resolve(dataDir)), tempParent);
    assert.equal(path.dirname(fs.realpathSync(dataDir)), tempParent);
    fs.rmSync(dataDir, { recursive: true, force: true });
    for (const { file, bytes, mode } of snapshots) {
      assert.deepEqual(fs.readFileSync(file), bytes, `source content unchanged: ${file}`);
      assert.equal(fs.statSync(file).mode, mode, `source permissions unchanged: ${file}`);
    }
  }
});
