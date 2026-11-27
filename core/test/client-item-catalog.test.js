'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

const base = path.resolve(__dirname, '../src/gameConfig');
const audit = require('../src/gameConfig/client-item-catalog-audit.json');
const icons = require('../src/gameConfig/seed_images_named/client-item-icons.json');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const temp = fs.realpathSync(os.tmpdir());
const data = fs.mkdtempSync(path.join(temp, 'farm-client-items-'));
const envKeys = ['FARM_DATA_DIR', 'FARM_LOG_DIR', 'FARM_PRIVATE_CONFIG_FILE'];
const savedEnv = envKeys.map(key => [key, process.env[key]]);
process.env.FARM_DATA_DIR = data;
process.env.FARM_LOG_DIR = path.join(data, 'logs');
process.env.FARM_PRIVATE_CONFIG_FILE = path.join(data, 'private-config.json');
const config = require('../src/config/gameConfig');
const { isInvalidSeedId } = require('../src/config/invalidPlants');
const { auditBagSeedCoverage } = require('../src/services/seed-catalog-audit');
const { loadProto, types } = require('../src/utils/proto');

test.after(() => {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  assert.equal(path.dirname(fs.realpathSync(data)), temp);
  fs.rmSync(data, { recursive: true, force: true });
});

test('official catalog gaps are closed while prior item records and invalid seeds stay unchanged', () => {
  const items = JSON.parse(fs.readFileSync(path.join(base, 'ItemInfo.json')));
  assert.equal(new Set(items.map(row => row.id)).size, items.length);
  assert.equal(sha(JSON.stringify(items.slice(0, audit.preservedExistingItemCount))), audit.preservedExistingItemsSha256);
  const addedIds = new Set(audit.addedItemIds);
  const added = items.filter(row => addedIds.has(row.id)).map(({ evidence, ...row }) => row);
  assert.equal(added.length, 319);
  assert.deepEqual(audit.retainedExistingItemIds, [7003, 7004, 1065003, 1065010, 2065003]);
  assert.equal(sha(JSON.stringify(added)), audit.addedItemsSha256);
  assert.equal(audit.officialItemIds.length, 1176);
  for (const id of audit.officialItemIds) {
    if (isInvalidSeedId(id)) assert.equal(config.getItemById(id), undefined);
    else assert.ok(config.getItemById(id), `official item ${id} must resolve`);
  }
  for (const [id, name, type] of [
    [1901, '头像框碎片·幻彩', 19], [1902, '铭牌碎片·幻彩', 19],
    [7003, '无机罐头容器', 2], [7004, '有机罐头容器', 2], [101407, '召回成功红包', 27],
  ]) {
    assert.deepEqual([config.getItemById(id).name, config.getItemById(id).type], [name, type]);
  }
  assert.equal(config.getItemById(1046084).sells, '1005:6');
  assert.equal(config.getItemById(101407).sells, null);
  assert.equal(config.getItemById(101407).cond_sells, '1001:1');
});

test('real Bag codec names all 319 additions without seed gaps, selling or automatic item use', async t => {
  await loadProto();
  const stacks = audit.addedItemIds.map((id, i) => ({ id, uid: 50000 + i, count: 1 }));
  const calls = [];
  const modulePaths = ['../src/utils/network', '../src/models/store', '../src/services/warehouse'].map(require.resolve);
  const saved = modulePaths.map(file => [file, require.cache[file]]);
  const store = require('../src/models/store');
  require.cache[modulePaths[0]] = { exports: {
    networkEvents: new EventEmitter(),
    getUserState: () => ({ level: 200, gold: 0 }),
    sendMsgAsync: async (_service, method) => {
      calls.push(method);
      assert.equal(method, 'Bag', 'catalog metadata must never initiate writes');
      return { body: types.BagReply.encode({ item_bag: { items: stacks } }).finish() };
    },
  } };
  require.cache[modulePaths[1]] = { exports: { ...store, isAutomationOn: () => true } };
  delete require.cache[modulePaths[2]];
  t.after(() => {
    for (const [file, cached] of saved) {
      if (cached) require.cache[file] = cached;
      else delete require.cache[file];
    }
  });
  const warehouse = require('../src/services/warehouse');
  const bag = await warehouse.getBagDetail();
  assert.equal(bag.items.length, stacks.length);
  for (const item of bag.items) {
    assert.equal(item.name, config.getItemById(item.id).name);
    assert.equal(item.itemType, config.getItemById(item.id).type);
    assert.equal(item.countDec, '1');
    assert.equal(config.isSeedItem(item.id), false);
    assert.equal(config.getPlantBySeedId(item.id), undefined);
  }
  assert.deepEqual(warehouse.getBagSeedsFromItems(stacks), []);
  assert.deepEqual(bag.seedRecognition.issues, []);
  const unknown = { id: 987654321, count: 1 };
  assert.deepEqual(auditBagSeedCoverage([...stacks, unknown], []).issues, [
    { itemId: unknown.id, kind: 'unclassified_item' },
  ]);
  await warehouse.sellAllFruits();
  assert.equal(await warehouse.openFertilizerGiftPacksSilently(), 0);
  assert.ok(calls.length >= 2);
  assert.ok(calls.every(method => method === 'Bag'));
});

test('every added official image is mapped and served as the reviewed PNG bytes', async t => {
  assert.equal(icons.rows.length, 363);
  assert.equal(new Set(icons.rows.map(row => row.id)).size, icons.rows.length);
  const unresolved = audit.officialItemIds.filter(id => !isInvalidSeedId(id) && !config.getItemImageById(id));
  assert.deepEqual(unresolved, icons.gaps.map(row => row.id).sort((a, b) => a - b));
  const app = require('express')();
  app.use('/game-config', require('express').static(base));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  for (const row of icons.rows) {
    const file = path.join(base, 'seed_images_named', row.file);
    const bytes = fs.readFileSync(file);
    assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.equal(sha(bytes), row.sha256);
    assert.equal(bytes.readUInt32BE(16), row.originalSize.width);
    assert.equal(bytes.readUInt32BE(20), row.originalSize.height);
    assert.match(row.textureUrl, /^https:\/\/cdn-resource\.nqf\.qq\.com\/release\/remote\//);
    if (row.outputMode === 'original_png_bytes') assert.equal(row.sha256, row.textureSha256);
    const expectedPath = `/game-config/seed_images_named/${row.file}`;
    assert.equal(config.getItemImageById(row.id), expectedPath);
    const reply = await fetch(`http://127.0.0.1:${server.address().port}${expectedPath}`);
    assert.equal(reply.status, 200);
    assert.match(reply.headers.get('content-type'), /^image\/png/);
    assert.equal(sha(Buffer.from(await reply.arrayBuffer())), row.sha256);
  }
});
