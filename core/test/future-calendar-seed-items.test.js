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
    ...targets.map(row => `seed_images_named/${imageFile(row)}`)];
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
    await t.test('reviewed item metadata does not invent a Plant footprint or land requirement', () => {
      const items = JSON.parse(fs.readFileSync(path.join(base, 'EventItems.json')));
      for (const row of targets) {
        assert.equal(items.filter(item => item.id === row.id).length, 1);
        const item = config.getItemById(row.id);
        assert.deepEqual([item.name, item.type, item.interaction_type, item.asset_name, item.level, item.sells, item.sell_cond, item.cond_sells],
          [row.name, 5, 'plant', row.asset, 41, '1001:2000', null, null]);
        assert.equal(config.isSeedItem(row.id), true);
        assert.equal(config.getPlantBySeedId(row.id), undefined, 'ItemInfo level is not verified Plant.land_level_need');
      }
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
    await t.test('synthetic real warehouse Bag and seed DTO retain unknown footprint', async () => {
      const calls = [];
      const networkPath = require.resolve('../src/utils/network');
      const warehousePath = require.resolve('../src/services/warehouse');
      const plantingPath = require.resolve('../src/services/planting-service');
      for (const id of [networkPath, warehousePath, plantingPath]) savedModules.push([id, require.cache[id]]);
      let bagItems = [
        ...targets.map((row, index) => ({ id: row.id, count: 2, uid: 8000 + index })),
        { id: 29005, count: 1, uid: 8002 }, { id: 20040, count: 3, uid: 8003 },
      ];
      const network = require(networkPath);
      require.cache[networkPath] = { id: networkPath, filename: networkPath, loaded: true, exports: { ...network,
        getUserState: () => ({ accountId: 'synthetic-calendar-seeds', level: 1 }),
        getWsErrorState: () => null,
        sendMsgAsync: async (service, method, bytes) => {
          assert.equal(service, 'gamepb.itempb.ItemService'); assert.equal(method, 'Bag', 'synthetic Bag only, never Sell/Use/Plant');
          types.BagRequest.decode(bytes); calls.push(method);
          return { body: types.BagReply.encode({ item_bag: { items: bagItems } }).finish() };
        } } };
      delete require.cache[warehousePath];
      const warehouse = require(warehousePath);
      const detail = await warehouse.getBagDetail();
      const seeds = warehouse.getBagSeedsFromItems(detail.items);
      for (const row of targets) {
        const item = detail.items.find(item => item.id === row.id);
        assert.deepEqual([item.name, item.category, item.itemType, item.plantSize, item.price], [row.name, 'seed', 5, 0, 2000]);
        assert.ok(item.image.endsWith(imageFile(row)));
        const seed = seeds.find(seed => seed.seedId === row.id);
        assert.deepEqual([seed.name, seed.plantSize, seed.mappingStatus], [row.name, 0, 'item_only']);
        assert.ok(seed.image.endsWith(imageFile(row)));
        // ItemInfo.level is display metadata, not Plant.land_level_need.
        assert.equal(seed.requiredLevel, 0);
        assert.equal(config.getPlantBySeedId(row.id), undefined);
      }
      assert.deepEqual([seeds.find(row => row.seedId === 29005).plantSize, seeds.find(row => row.seedId === 20040).plantSize], [2, 1]);
      assert.equal(seeds.find(row => row.seedId === 20040).mappingStatus, 'mapped');
      assert.equal(seeds.find(row => row.seedId === 20040).requiredLevel, 1);
      const unknown = warehouse.getBagSeedsFromItems([{ id: 999998, count: 1, showName: '合成未知种子' }])[0];
      assert.equal(unknown.plantSize, 0); assert.equal(unknown.mappingStatus, 'unknown');
      assert.deepEqual(calls, ['Bag']);
      bagItems = bagItems.filter(item => targets.some(row => row.id === item.id));
      delete require.cache[plantingPath];
      const planting = require(plantingPath);
      const planted = await planting.plantFromBagSeeds([1, 2, 3, 4], 'synthetic-calendar-seeds');
      assert.equal(planted.totalPlanted, 0, 'unknown footprint cannot become plantable at a lower display level');
      assert.deepEqual(planted.remainingLandIds, [1, 2, 3, 4]);
      assert.deepEqual(calls, ['Bag', 'Bag'], 'no Plant, Use, Sell or purchase request');
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
