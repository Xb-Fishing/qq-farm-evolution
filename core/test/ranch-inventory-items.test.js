'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const temp = fs.realpathSync(os.tmpdir()), prefix = path.resolve(temp, 'farm-ranch-items-');
assert.equal(path.dirname(prefix), temp);
const data = fs.mkdtempSync(prefix), old = process.env.FARM_DATA_DIR;
process.env.FARM_DATA_DIR = data;
const savedOverrides = Object.fromEntries(['FARM_LOG_DIR', 'FARM_PRIVATE_CONFIG_FILE', 'FARM_ACCOUNT_ID'].map(key => [key, process.env[key]]));
const fixtureLogDir = path.resolve(data, 'logs'), fixtureConfig = path.resolve(data, 'private-config.json');
assert.equal(path.dirname(fixtureLogDir), path.resolve(data)); assert.equal(path.dirname(fixtureConfig), path.resolve(data));
process.env.FARM_LOG_DIR = fixtureLogDir; process.env.FARM_PRIVATE_CONFIG_FILE = fixtureConfig; process.env.FARM_ACCOUNT_ID = 'synthetic-qq-fixture';
const config = require('../src/config/gameConfig');
const { auditBagSeedCoverage } = require('../src/services/seed-catalog-audit');
const { loadProto, types } = require('../src/utils/proto');
const { itemDto } = require('../src/services/ranch-model');
const { pngResourceInfo } = require('../src/services/privacy-guard');
const sources = require('../src/gameConfig/seed_images_named/event-seed-sources.json');
const files = ['../src/gameConfig/EventItems.json', '../src/services/warehouse.js'].map(f => path.resolve(__dirname, f));
const before = files.map(f => [fs.readFileSync(f), fs.statSync(f).mode]);
test.before(loadProto);
test.after(() => {
  for (const [key, value] of Object.entries(savedOverrides)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  files.forEach((f, i) => { assert.deepEqual(fs.readFileSync(f), before[i][0]); assert.equal(fs.statSync(f).mode, before[i][1]); });
  if (old === undefined) delete process.env.FARM_DATA_DIR; else process.env.FARM_DATA_DIR = old;
  assert.equal(path.dirname(path.resolve(data)), temp); fs.rmSync(data, { recursive: true, force: true });
});
const rows = [[1007, '金券', 102], [1102, '牧场经验', 3], [3003, '动物普通收藏点', 12]];
const pinecone = {
  id: 1008,
  file: '1008_ranch_pinecone.png',
  sha256: '349bd3886684d4c5ff5f9d7cd4c0f5a6a3d7cbe99cb3ad05cb79fcd929670c00',
};
function fixture(t, items) {
  const paths = ['../src/utils/network', '../src/models/store', '../src/services/warehouse'].map(require.resolve);
  const saved = paths.map(p => [p, require.cache[p]]), calls = [];
  const store = require('../src/models/store');
  require.cache[paths[0]] = { exports: { networkEvents: new EventEmitter(), getUserState: () => ({ level: 200, gold: 0 }),
    sendMsgAsync: async (_service, method) => { calls.push(method); assert.equal(method, 'Bag', 'metadata must never authorize Sell'); return { body: types.BagReply.encode({ item_bag: { items } }).finish() }; },
  } };
  require.cache[paths[1]] = { exports: { ...store, isAutomationOn: () => true } };
  delete require.cache[paths[2]];
  t.after(() => { for (const [p, entry] of saved) { if (entry) require.cache[p] = entry; else delete require.cache[p]; } });
  return { warehouse: require('../src/services/warehouse'), calls };
}
test('real BagReply now names reviewed ranch inventory without seed gaps; unknown inventory remains visible', async t => {
  const items = rows.map(([id], index) => ({ id, uid: 700 + index, count: 3 }));
  const f = fixture(t, items); const bag = await f.warehouse.getBagDetail();
  for (const [id, name, type] of rows) {
    const item = bag.items.find(item => item.id === id);
    assert.equal(item.name, name); assert.equal(item.category, 'item'); assert.equal(item.itemType, type);
    assert.equal(item.sellable, false); assert.equal(config.isSeedItem(id), false);
    assert.equal(config.getPlantBySeedId(id), undefined); assert.equal(config.getPlantByFruitId(id), undefined);
    for (const key of ['sells', 'sell_cond', 'cond_sells']) assert.equal(config.getItemById(id)?.[key], null);
  }
  assert.deepEqual(f.warehouse.getBagSeedsFromItems(items), []); assert.deepEqual(bag.seedRecognition.issues, []);
  assert.deepEqual(auditBagSeedCoverage([...items, { id: 987654321, count: 1 }], []).issues, [{ itemId: 987654321, kind: 'unclassified_item' }]);
});
test('real BagReply recognizes ranch pinecones without planting, selling or using them', async t => {
  const { id, file } = pinecone;
  const stack = { id, uid: 10080, count: 17 };
  const { warehouse, calls } = fixture(t, [stack]);
  const bag = await warehouse.getBagDetail();
  const item = bag.items.find(row => row.id === id);
  const image = `/game-config/seed_images_named/${file}`;

  assert.equal(item.name, '松果');
  assert.equal(item.category, 'item');
  assert.equal(item.itemType, 2);
  assert.equal(item.count, 17);
  assert.equal(item.countDec, '17');
  assert.equal(item.image, image);
  assert.equal(item.sellable, false);
  assert.equal(item.usable, false);
  assert.equal(config.isSeedItem(id), false);
  assert.equal(config.getPlantBySeedId(id), undefined);
  assert.equal(config.getPlantByFruitId(id), undefined);
  assert.deepEqual(warehouse.getBagSeedsFromItems(bag.originalItems), []);
  assert.deepEqual(bag.seedRecognition.issues, []);
  const unknown = { id: 987654321, count: 1 };
  assert.deepEqual(auditBagSeedCoverage([...bag.originalItems, unknown], []).issues, [
    { itemId: unknown.id, kind: 'unclassified_item' },
  ]);
  assert.deepEqual(itemDto(bag.originalItems[0]), { id: '1008', count: '17', name: '松果', image });

  const goods = require('../src/gameConfig/MallCatalog.json').goods.find(row => row.id === id);
  assert.equal(goods.name, '有机化肥(4小时)');
  assert.deepEqual(goods.items, [{ id: 80012, count: '1' }]);

  assert.deepEqual(calls.splice(0), ['Bag']);
  await warehouse.sellAllFruits();
  assert.deepEqual(calls.splice(0), ['Bag']);
  assert.equal(await warehouse.openFertilizerGiftPacksSilently(), 0);
  assert.deepEqual(calls, ['Bag']);
});
test('牧场每日礼包道具在实际背包命名，保留普通物品安全边界', async t => {
  const id = 80021;
  const stack = { id, uid: 8021, count: 1 };
  const f = fixture(t, [stack]);
  const bag = await f.warehouse.getBagDetail();
  const item = bag.items.find(row => row.id === id);
  assert.equal(item.name, '无机罐头（1小时）');
  assert.equal(item.category, 'item');
  assert.equal(item.sellable, false);
  assert.equal(config.isSeedItem(id), false);
  assert.equal(config.getItemImageById(id), '');
  assert.deepEqual(auditBagSeedCoverage([stack], []).issues, []);
});
test('reviewed snapshot records exact source and original item sprite bytes', () => {
  const proof = sources.reviewedRanchInventoryItems;
  assert.equal(proof.sourceGrade, 'reviewed_public_client_snapshot'); assert.equal(proof.sourceCommit, '545bbcfd209546ffc1594e65cd6d32d30137cddd');
  assert.equal(proof.sha256, 'b69d10841b69a5b5cb7e94948d950319dce6038b10079982ac7365845006a659');
  assert.deepEqual(proof.rows.map(r => r.id), rows.map(r => r[0]));
  assert.equal(proof.iconStatus, 'reviewed_dedicated_and_shared_official_sprite');
  const expected = [[1007, '1007_ranch_currency.png', '4f43e58c6c2be65e345868e4b249e0bd88cae4de1f8ee9a1ef2c7bb6e70eadcc'],
    [1102, '1102_ranch_experience.png', '4890f09a451f687276e648c8b54bb0760dbdf4f295570f146a400e0914d317ff'],
    [3003, '3003_animal_collection_points.png', '93b9b9ac275fbf90eff38c67bed9bd15b68f848f745bcc2edd25119514fd79cf']];
  for (const [id, file, sha] of expected) {
    const resource = sources.reviewedResources.find(row => row.itemId === id);
    assert.ok(resource); assert.equal(resource.file, file);
    assert.equal(resource.sourceCommit, '6ac7a3d7930018058d201af86beea8de6a9f8507');
    const bytes = fs.readFileSync(path.join(__dirname, '../src/gameConfig/seed_images_named', file));
    assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), sha);
    assert.equal(resource.sha256, sha);
    assert.equal(resource.gitBlob, crypto.createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes])).digest('hex'));
    assert.deepEqual([bytes.readUInt32BE(16), bytes.readUInt32BE(20)], [100, 100]);
    assert.ok(config.getItemImageById(id).endsWith(file)); assert.equal(config.isSeedItem(id), false);
  }
  const shared = sources.reviewedResources.find(row => row.itemId === 3003);
  assert.equal(shared.sourceItemId, 3001); assert.equal(shared.sharedSpriteFrame, true);
  assert.equal(shared.spriteFrame, config.getItemById(3003)?.icon_res);
  assert.equal(shared.spriteFrame, config.getItemById(3001)?.icon_res);
});

test('pinecone icon is the reviewed client snapshot PNG with publication-safe metadata', () => {
  const { id, file, sha256 } = pinecone;
  const row = sources.reviewedResources.find(resource => resource.itemId === id);
  const sourceCommit = '6ac7a3d7930018058d201af86beea8de6a9f8507';
  const repositoryAlias = 'public-reference-2';
  assert.deepEqual(row, {
    itemId: id,
    file,
    kind: 'item',
    sourceGrade: 'reviewed_public_client_snapshot',
    repositoryAlias,
    sourceCommit,
    sourcePath: 'core/src/gameConfig/seed_images_named/seed_images/1008.png',
    gitBlob: 'e45bd3c90c878f6dd218fdf9bf91157a5126203a',
    sha256,
    width: 100,
    height: 100,
    spriteFrame: 'gui/texture/icon/1008/spriteFrame',
    bundleName: 'mcRes',
  });
  assert.ok(sources.references.some(ref => ref.repositoryAlias === repositoryAlias && ref.commit === sourceCommit));
  const item = config.getItemById(id);
  assert.equal(item.icon_res, row.spriteFrame);
  assert.equal(item.bundle_name, row.bundleName);
  for (const key of ['asset_name', 'sells', 'sell_cond', 'cond_sells', 'can_use']) assert.equal(item[key], null);

  const iconPath = path.join(__dirname, '../src/gameConfig/seed_images_named', file);
  const stat = fs.lstatSync(iconPath);
  assert.ok(stat.isFile());
  assert.equal(stat.mode & 0o111, 0);
  const bytes = fs.readFileSync(iconPath);
  assert.deepEqual(pngResourceInfo(bytes, { runtimeTerms: [] }), { width: row.width, height: row.height });
  assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), sha256);
  const gitBlob = Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes]);
  assert.equal(crypto.createHash('sha1').update(gitBlob).digest('hex'), row.gitBlob);
});

test('real static HTTP delivers mapped ranch PNGs with the reviewed content type and hash', async t => {
  const app = require('express')();
  app.use('/game-config', require('express').static(path.join(__dirname, '../src/gameConfig')));
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  for (const id of [...rows.map(([id]) => id), pinecone.id]) {
    const response = await new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port: server.address().port, path: config.getItemImageById(id) }, res => {
        const chunks = []; res.on('data', bytes => chunks.push(bytes));
        res.on('end', () => resolve({ status: res.statusCode, contentType: res.headers['content-type'], bytes: Buffer.concat(chunks) }));
      }).on('error', reject);
    });
    assert.equal(response.status, 200); assert.equal(response.contentType, 'image/png');
    assert.equal(crypto.createHash('sha256').update(response.bytes).digest('hex'), sources.reviewedResources.find(row => row.itemId === id).sha256);
  }
});
test('real automatic sale entry retains all three items and pasture feed even with selling enabled', async t => {
  const f = fixture(t, [...rows.map(([id]) => ({ id, count: 3 })), { id: 7001, count: 40 }]);
  await f.warehouse.sellAllFruits(); assert.deepEqual(f.calls, ['Bag']);
  assert.equal(config.getItemById(7001).auto_sell, false); assert.equal(config.getPlantBySeedId(29005).size, 2);
});
