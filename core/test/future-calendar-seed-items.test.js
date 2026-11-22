'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const base = path.resolve(__dirname, '../src/gameConfig');
const targets = [
  { id: 26038, name: '款冬花种子', asset: 'Crop_6038', sha: '5ea12d657bed9a342650b39d01c64fea38ec1057a94585caf36ba8fc548282de', blob: 'de9088303dbd92fa0254931b3c2fb896876b75d6' },
  { id: 26084, name: '山茶花种子', asset: 'Crop_6084', sha: '8338326682a80908a2ac6605cd68d1f7c4f615129a82714c01e20bb9792d6dad', blob: '1d1db9152ca99697c90c1e660626664a6928a9f7' },
];
const imageFile = row => `${row.id}_${row.asset}_Seed.png`;
const goldImage = '1046038_Crop_6038_Gold.png';
const goldSha = '18c487dd62b0d9f4357f8a86430c9fbe6fa733f8059be70367718e0db4e4f170';
const goldBlob = 'f812ffeaf1ba216680024bbb10456dad116e7288';
const growPhases = '种子:8640;发芽:8640;小叶子:8640;大叶子:8640;初熟:8640;成熟:0;';
const unknownId = 999998;

// Small disposable synthetic state only; no source edits or runtime registration.
test('future calendar reward items: isolated real codecs and exact assets', async t => {
  const repo = fs.realpathSync(path.resolve(__dirname, '../..'));
  const temp = fs.realpathSync(os.tmpdir());
  assert.ok(temp !== repo && !temp.startsWith(repo + path.sep));
  const prefix = path.resolve(temp, 'future-calendar-seed-items-');
  assert.equal(path.dirname(prefix), temp, 'validate fixture boundary before writing');
  const envKeys = ['FARM_DATA_DIR', 'FARM_LOG_DIR', 'FARM_PRIVATE_CONFIG_FILE'];
  const savedEnv = new Map(envKeys.map(key => [key, process.env[key]]));
  const files = ['EventItems.json', 'EventPlants.json', '../services/warehouse.js', 'seed_images_named/event-seed-sources.json',
    `seed_images_named/${goldImage}`, ...targets.map(row => `seed_images_named/${imageFile(row)}`)];
  // Old-source counterproof must fail an assertion instead of ENOENT.
  for (const file of files) assert.ok(fs.existsSync(path.join(base, file)), `required reviewed asset: ${file}`);
  const fingerprint = () => files.map(file => {
    const full = path.join(base, file);
    return [file, sha(fs.readFileSync(full)), fs.statSync(full).mode & 0o777];
  });
  const before = fingerprint();
  const fixture = fs.mkdtempSync(prefix);
  const savedModules = [];
  try {
    assert.equal(path.dirname(fs.realpathSync(fixture)), temp);
    process.env.FARM_DATA_DIR = fixture;
    delete process.env.FARM_LOG_DIR;
    const privateFile = path.resolve(fixture, 'absent-private-config.json');
    assert.equal(path.dirname(privateFile), fs.realpathSync(fixture));
    process.env.FARM_PRIVATE_CONFIG_FILE = privateFile;
    // First business-module load occurs after writable paths are isolated.
    const config = require('../src/config/gameConfig');
    const { loadProto, types } = require('../src/utils/proto');
    await loadProto();
    const calendar = require('../src/services/solar-calendar');
    await t.test('reviewed reward metadata preserves both seeds and leaves 26084 item-only', () => {
      const items = JSON.parse(fs.readFileSync(path.join(base, 'EventItems.json')));
      for (const row of targets) {
        assert.equal(items.filter(item => item.id === row.id).length, 1);
        const item = config.getItemById(row.id);
        assert.deepEqual([item.name, item.type, item.interaction_type, item.asset_name, item.level, item.sells, item.sell_cond, item.cond_sells],
          [row.name, 5, 'plant', row.asset, 41, '1001:2000', null, null]);
        assert.equal(config.isSeedItem(row.id), true);
      }
      assert.equal(config.getPlantBySeedId(26084), undefined, 'ItemInfo level is not Plant.land_level_need');
    });
    await t.test('winter Plant and reverse indexes resolve the exact base and seedless variant', () => {
      const rows = JSON.parse(fs.readFileSync(path.join(base, 'EventPlants.json')));
      const plant = config.getPlantBySeedId(26038);
      assert.ok(plant, '26038 must resolve to its reviewed Plant');
      const gold = config.getPlantById(1126038);
      assert.ok(gold);
      assert.equal(config.getPlantById(1026038), plant);
      assert.equal(config.getPlantByIdOrSeedId(26038), plant);
      assert.equal(config.getPlantByFruitId(46038), plant);
      assert.equal(config.getPlantByFruitId(1046038), gold);
      assert.equal(config.getMutantDisplayPlantId(1026038, [5]), 1126038);
      assert.equal(config.getPlantBySeedId(0), undefined);
      assert.equal(config.getPlantBySeedId(1046038), undefined);
      assert.equal(config.getPlantBySeedId(unknownId), undefined);
      for (const [loaded, id, seed, name, asset, fruitId, count, mutation] of [
        [plant, 1026038, 26038, '款冬花', 'Crop_6038', 46038, 48, '5:1126038:1'],
        [gold, 1126038, null, '黄金·款冬花', 'gold/Crop_6038', 1046038, 10, null],
      ]) {
        assert.deepEqual(rows.filter(row => row.id === id), [{
          id, seed_id: seed, name, land_level_need: 1, seasons: 1, grow_phases: growPhases,
          exp: 1680, special_fruit: null, fruit_id: fruitId, fruit_count: count,
          asset_name: asset, size: 1, mutant_effect_plant: mutation,
        }]);
        assert.deepEqual([loaded.id, loaded.seed_id, loaded.name, loaded.asset_name, loaded.size, loaded.land_level_need,
          loaded.seasons, loaded.exp, loaded.grow_phases, loaded.mutant_effect_plant],
        [id, Number(seed), name, asset, 1, 1, 1, 1680, growPhases, mutation || '']);
        assert.deepEqual(loaded.fruit, { id: fruitId, count });
      }
    });
    await t.test('winter fruit metadata carries direct prices and excludes gold from automatic sale', () => {
      const items = JSON.parse(fs.readFileSync(path.join(base, 'EventItems.json')));
      for (const [id, name, type, asset, price, level] of [
        [46038, '款冬花', 6, 'Crop_6038', '1001:280', 41],
        [1046038, '黄金·款冬花', 17, 'gold/Crop_6038', '1005:6', 200],
      ]) {
        assert.equal(items.filter(item => item.id === id).length, 1);
        const item = config.getItemById(id);
        assert.deepEqual([item.name, item.type, item.asset_name, item.sells, item.level, item.sell_cond, item.cond_sells,
          item.icon_res, item.bundle_name], [name, type, asset, price, level, null, null, null, null]);
        assert.equal(config.isSeedItem(id), false);
      }
      assert.equal(config.getItemById(1046038).auto_sell, false);
    });
    await t.test('local PNG hashes, git blobs, dimensions and precise provenance', () => {
      const sources = JSON.parse(fs.readFileSync(path.join(base, 'seed_images_named/event-seed-sources.json')));
      for (const row of targets) {
        const file = imageFile(row);
        const matching = sources.reviewedResources.filter(record => record.itemId === row.id);
        assert.equal(matching.length, 1);
        assert.deepEqual(matching[0], { itemId: row.id, file, assetName: row.asset, kind: 'seed',
          sourceGrade: 'reviewed_public_client_snapshot', repositoryAlias: 'public-reference-2',
          sourceCommit: '6ac7a3d7930018058d201af86beea8de6a9f8507',
          sourcePath: `core/src/gameConfig/seed_images_named/seed_images/${row.id}.png`,
          gitBlob: row.blob, sha256: row.sha, width: 100, height: 100 });
        const bytes = fs.readFileSync(path.join(base, 'seed_images_named', file));
        assert.equal(sha(bytes), row.sha);
        const blob = Buffer.concat([Buffer.from(`blob ${bytes.length}`), Buffer.from([0]), bytes]);
        assert.equal(crypto.createHash('sha1').update(blob).digest('hex'), row.blob);
        assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
        assert.deepEqual([bytes.readUInt32BE(16), bytes.readUInt32BE(20)], [100, 100]);
        assert.ok(config.getItemImageById(row.id).endsWith(file));
        assert.ok(config.getSeedImageBySeedId(row.id).endsWith(file));
      }
    });
    await t.test('ordinary fruit reuses its byte-identical seed PNG and gold uses the reviewed archive', () => {
      const sources = JSON.parse(fs.readFileSync(path.join(base, 'seed_images_named/event-seed-sources.json')));
      const winter = sources.reviewedWinterPlantMapping;
      assert.equal(winter.repositoryAlias, 'public-reference-c');
      assert.equal(winter.sourceCommit, '1cef35dfe062bbfe83ad4c8a7014b36f5c795bb2');
      assert.deepEqual(winter.configSources, sources.reviewedPasturePlantMapping.configSources);
      const seed = targets[0];
      const archive = 'core/src/gameConfig/seed_images_named/seed_images';
      const sourceCommit = '6ac7a3d7930018058d201af86beea8de6a9f8507';
      assert.deepEqual(winter.sharedFruitImage, {
        itemId: 46038, seedItemId: seed.id, assetName: seed.asset, iconRes: null, bundleName: null,
        repositoryAlias: 'public-reference-2', sourceCommit, sourcePath: `${archive}/46038.png`,
        seedSourcePath: `${archive}/26038.png`, file: imageFile(seed), byteIdentical: true, gitBlob: seed.blob, sha256: seed.sha,
      });
      assert.deepEqual(sources.reviewedResources.filter(record => record.itemId === 1046038), [{
        itemId: 1046038, file: goldImage, assetName: 'gold/Crop_6038', kind: 'fruit',
        sourceGrade: 'reviewed_public_client_snapshot', repositoryAlias: 'public-reference-2', sourceCommit,
        sourcePath: `${archive}/1046038.png`, gitBlob: goldBlob, sha256: goldSha, width: 100, height: 100,
      }]);
      const png = path.join(base, 'seed_images_named', goldImage);
      const bytes = fs.readFileSync(png);
      assert.equal(fs.statSync(png).mode & 0o777, 0o644);
      assert.equal(sha(bytes), goldSha);
      const blob = Buffer.concat([Buffer.from(`blob ${bytes.length}`), Buffer.from([0]), bytes]);
      assert.equal(crypto.createHash('sha1').update(blob).digest('hex'), goldBlob);
      assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
      assert.deepEqual([bytes.readUInt32BE(16), bytes.readUInt32BE(20)], [100, 100]);
    });
    await t.test('winter base, seed identifier and variant keep the common stage fallback', () => {
      const common = config.getPlantImageByPhase(0, 1);
      assert.ok(common?.startsWith('/game-config/plant_images/'));
      assert.ok(fs.existsSync(path.join(base, common.replace('/game-config/', ''))));
      for (const phase of [1, 2, 3, 4, 5, 6]) {
        for (const id of [1026038, 26038, 1126038]) {
          assert.equal(config.getPlantImageByPhase(id, phase), common);
        }
        assert.equal(config.getMutantPlantImageByPhase(1026038, [5], phase), common);
      }
    });
    await t.test('own and friend land panels display winter crops for both forms of the reported ID', async () => {
      const farmApiPath = require.resolve('../src/services/farm-api');
      const friendApiPath = require.resolve('../src/services/friend-api');
      const farmAnalyzerPath = require.resolve('../src/services/farm-land-analyzer');
      const friendAnalyzerPath = require.resolve('../src/services/friend-land-analyzer');
      const calls = [];
      const beginTime = Math.floor(Date.now() / 1000) - 10;
      const lands = [
        { id: 1, unlocked: true, plant: { id: 26038, phases: [{ phase: 2, begin_time: beginTime }] } },
        { id: 2, unlocked: true, plant: { id: 1026038, phases: [{ phase: 2, begin_time: beginTime }], mutant_config_ids: [5] } },
      ];
      for (const id of [farmApiPath, friendApiPath, farmAnalyzerPath, friendAnalyzerPath]) {
        savedModules.push([id, require.cache[id]]);
        delete require.cache[id];
      }
      require.cache[farmApiPath] = { id: farmApiPath, filename: farmApiPath, loaded: true, exports: {
        getAllLands: async () => { calls.push('own-read'); return { lands }; },
      } };
      require.cache[friendApiPath] = { id: friendApiPath, filename: friendApiPath, loaded: true, exports: {
        enterFriendFarm: async () => { calls.push('friend-read'); return { lands }; },
        leaveFriendFarm: async () => { calls.push('friend-leave'); },
      } };
      try {
        const { getLandsDetail } = require(farmAnalyzerPath);
        const { getFriendLandsDetail } = require(friendAnalyzerPath);
        const own = await getLandsDetail();
        const friend = await getFriendLandsDetail(123);
        const image = config.getPlantImageByPhase(0, 1);
        for (const panel of [own, friend]) {
          assert.deepEqual(panel.lands.map(land => [land.plantName, land.seedId, land.plantSize, land.plantImage]), [
            ['款冬花', 26038, 1, image],
            ['黄金·款冬花', 26038, 1, image],
          ]);
        }
        assert.deepEqual(calls, ['own-read', 'friend-read', 'friend-leave']);
      } finally {
        for (const [id, old] of savedModules.splice(-4).reverse()) {
          if (old) require.cache[id] = old;
          else delete require.cache[id];
        }
      }
    });
    await t.test('future 404/405 direct and quiz reward DTOs decode with zero writes', async () => {
      const now = 1794960000; const socket = {}; const calls = [];
      let response = { server_time: now, default_event_id: 404, events: targets.map((row, index) => ({
        id: 404 + index, window_status: 1, open_start_time: now + 86400, open_end_time: now + 172800,
        rewards: [{ id: row.id, count: 2 }], question_rewards: [{ id: row.id, count: 1 }],
      })) };
      let fail = false;
      const deps = { isReady: () => true, getConnection: () => socket, now: () => now * 1000,
        sendMsgAsync: async (service, method, bytes) => {
          assert.equal(service, 'gamepb.solartermspb.SolarTermsV2Service');
          assert.equal(method, 'GetSolarTermsV2', 'fixture denies all game writes');
          types.GetSolarTermsV2Request.decode(bytes); calls.push(method);
          if (fail) throw new Error('synthetic read failure');
          return { body: types.GetSolarTermsV2Reply.encode(response).finish() };
        } };
      const result = await calendar.getSolarCalendar(deps);
      for (const [index, row] of targets.entries()) {
        const event = result.events.find(event => event.id === 404 + index);
        assert.equal(event.open, false); assert.equal(event.canClaim, false); assert.equal(event.canAnswer, false);
        for (const reward of [event.rewards[0], event.questionRewards[0]]) {
          assert.equal(reward.name, row.name); assert.ok(reward.image.endsWith(imageFile(row)));
          assert.ok(fs.existsSync(path.join(base, 'seed_images_named', path.basename(reward.image))));
        }
        for (const action of ['claim', 'answer'])
          await assert.rejects(calendar.operateSolarCalendar(action, { id: event.id, optionIndex: 0, expectedQuestion: event.question }, deps), /条件/);
      }
      fail = true; await assert.rejects(calendar.getSolarCalendar(deps), /synthetic read failure/);
      fail = false; response = {}; await assert.rejects(calendar.getSolarCalendar(deps), /状态不完整/);
      response = { server_time: now, events: [{ id: 9999, rewards: [{ id: 999999, count: 1 }] }] };
      const unknown = await calendar.getSolarCalendar(deps);
      assert.equal(unknown.events[0].rewards[0].name, '未知物品');
      assert.equal(unknown.events[0].canClaim, false); assert.equal(unknown.events[0].canAnswer, false);
      assert.ok(calls.every(method => method === 'GetSolarTermsV2'));
    });
    await t.test('real Bag, Plant and Sell codecs apply the winter mapping and skip unknown seeds and gold sales', async () => {
      const calls = [];
      const networkPath = require.resolve('../src/utils/network');
      const warehousePath = require.resolve('../src/services/warehouse');
      const plantingPath = require.resolve('../src/services/planting-service');
      const storePath = require.resolve('../src/models/store');
      for (const id of [networkPath, warehousePath, plantingPath, storePath]) savedModules.push([id, require.cache[id]]);
      let bagItems = [
        { id: 26038, count: 1, uid: 8000 }, { id: 26084, count: 2, uid: 8001 },
        { id: 29005, count: 1, uid: 8002 }, { id: 20040, count: 3, uid: 8003 },
        { id: 46038, count: 2, uid: 8004 }, { id: 1046038, count: 3, uid: 8005 },
        { id: unknownId, count: 1, uid: 8006 },
      ];
      const store = require(storePath);
      require.cache[storePath] = { id: storePath, filename: storePath, loaded: true, exports: { ...store,
        isAutomationOn: key => key === 'sell',
        getPlantOrderRandom: () => false,
        getPlantDelaySeconds: () => 0,
      } };
      const network = require(networkPath);
      require.cache[networkPath] = { id: networkPath, filename: networkPath, loaded: true, exports: { ...network,
        getUserState: () => ({ accountId: 'synthetic-calendar-seeds', level: 1, gold: 100 }),
        getWsErrorState: () => null,
        sendMsgAsync: async (service, method, bytes) => {
          calls.push(method);
          if (method === 'Plant') {
            assert.equal(service, 'gamepb.plantpb.PlantService');
            const { items } = types.PlantRequest.decode(bytes);
            assert.deepEqual(items.map(item => [Number(item.seed_id), item.land_ids.map(Number)]), [[26038, [1]]]);
            return { body: types.PlantReply.encode({ land: [{ id: 1 }] }).finish() };
          }
          assert.equal(service, 'gamepb.itempb.ItemService');
          if (method === 'Sell') {
            const { items } = types.SellRequest.decode(bytes);
            assert.deepEqual(items.map(item => [Number(item.id), Number(item.count), Number(item.uid)]), [[46038, 2, 8004]]);
            return { body: types.SellReply.encode({ sell_items: items, get_items: [{ id: 1001, count: 560 }] }).finish() };
          }
          assert.equal(method, 'Bag');
          types.BagRequest.decode(bytes);
          return { body: types.BagReply.encode({ item_bag: { items: bagItems } }).finish() };
        } } };
      delete require.cache[warehousePath];
      const warehouse = require(warehousePath);
      const detail = await warehouse.getBagDetail();
      const seeds = warehouse.getBagSeedsFromItems(detail.items);
      for (const row of targets) {
        const mapped = row.id === 26038;
        const size = mapped ? 1 : 0;
        const item = detail.items.find(item => item.id === row.id);
        assert.deepEqual([item.name, item.category, item.itemType, item.plantSize, item.price], [row.name, 'seed', 5, size, 2000]);
        assert.ok(item.image.endsWith(imageFile(row)));
        const seed = seeds.find(seed => seed.seedId === row.id);
        assert.deepEqual([seed.name, seed.plantSize, seed.mappingStatus], [row.name, size, mapped ? 'mapped' : 'item_only']);
        assert.ok(seed.image.endsWith(imageFile(row)));
        assert.equal(seed.requiredLevel, mapped ? 1 : 0);
      }
      for (const [id, name, type, priceId, price, image] of [
        [46038, '款冬花', 6, 1001, 280, imageFile(targets[0])],
        [1046038, '黄金·款冬花', 17, 1005, 6, goldImage],
      ]) {
        const item = detail.items.find(item => item.id === id);
        assert.deepEqual([item.name, item.category, item.itemType, item.priceId, item.price, item.interactionType],
          [name, 'fruit', type, priceId, price, '']);
        assert.ok(item.image.endsWith(image));
        assert.equal(seeds.some(row => row.seedId === id), false);
      }
      assert.deepEqual([seeds.find(row => row.seedId === 29005).plantSize, seeds.find(row => row.seedId === 20040).plantSize], [2, 1]);
      assert.equal(seeds.find(row => row.seedId === 20040).mappingStatus, 'mapped');
      assert.equal(seeds.find(row => row.seedId === 20040).requiredLevel, 1);
      assert.equal(seeds.some(row => row.seedId === unknownId), false);
      const unknown = warehouse.getBagSeedsFromItems([{ id: unknownId, count: 1, showName: '合成未知种子' }])[0];
      assert.equal(unknown.plantSize, 0); assert.equal(unknown.mappingStatus, 'unknown');
      assert.deepEqual(calls, ['Bag']);
      bagItems = bagItems.filter(item => item.id !== 20040);
      delete require.cache[plantingPath];
      const planting = require(plantingPath);
      assert.deepEqual([26038, 26084, unknownId, 29005].map(planting.getPlantSizeBySeedId), [1, 0, 0, 2]);
      const planted = await planting.plantFromBagSeeds([1, 2, 3, 4], 'synthetic-calendar-seeds');
      assert.equal(planted.totalPlanted, 1);
      assert.equal(planted.occupiedCount, 1);
      assert.deepEqual(planted.plantedLandIds, [1]);
      assert.deepEqual(planted.remainingLandIds, [2, 3, 4]);
      assert.deepEqual(calls, ['Bag', 'Bag', 'Plant']);
      await warehouse.sellAllFruits();
      assert.deepEqual(calls, ['Bag', 'Bag', 'Plant', 'Bag', 'Sell']);
      assert.deepEqual(config.getGenericFallbackItemIds(), []);
    });
  } finally {
    for (const [id, old] of savedModules.reverse()) { if (old) require.cache[id] = old; else delete require.cache[id]; }
    for (const [key, value] of savedEnv) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    try { assert.deepEqual(fingerprint(), before, 'candidate content and permission fingerprints preserved'); }
    finally {
      assert.equal(path.dirname(fs.realpathSync(fixture)), temp);
      fs.rmSync(fixture, { recursive: true, force: true });
      assert.equal(fs.existsSync(fixture), false);
    }
  }
});
