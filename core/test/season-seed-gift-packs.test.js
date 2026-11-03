const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

const repo = path.resolve(__dirname, '../..');
const temporaryRoot = fs.realpathSync(os.tmpdir());
const prefix = path.resolve(temporaryRoot, 'farm-seed-gift-packs-');
assert.equal(path.dirname(prefix), temporaryRoot);
assert.equal(temporaryRoot === repo || temporaryRoot.startsWith(repo + path.sep), false);
const privateDir = fs.mkdtempSync(prefix);
assert.equal(fs.realpathSync(privateDir), privateDir);
const originalDataDir = process.env.FARM_DATA_DIR;
process.env.FARM_DATA_DIR = privateDir;

const packs = [
  [101620, '南瓜种子礼包', '09', 'f47157126663210f8324d336fa713c077a7e20fa', '7fd1e53f553cc93fd0cfe2c7b6954149270b6f40c32546cc5e4a61cbf0967087'],
  [101621, '荷风种子礼包', '10', '3da20005fcf1ae385d59e37a2faa9adf5a0325fc', '4f3eaff4e84087dfee123aa33a3f7714d08ee5b294d3214d481ffb4da3b7589d'],
  [101622, '千星种子礼包', '11', 'c62e5cf76029296f41aa4caf642a06399b7c2473', '01a713926b4130f5a2e03dc68f9ea3887f8f1ddcb20b3bc413ef4e33cd088a00'],
  [101623, '萌宠种子礼包', '12', '4f918b122605bc401e2299b330d1fcfdd0bf6b7a', '764b5a8d7076927ed63ee520046047dbbce8f226a52f74905d78cc287341bc6e'],
];
const configDir = path.resolve(__dirname, '../src/gameConfig');
const protectedFiles = [__filename, ...['EventItems.json', 'EventPlants.json', 'seed_images_named/event-seed-sources.json',
  ...packs.map(([id, , icon]) => `seed_images_named/${id}_pack_${icon}.png`)].map(file => path.join(configDir, file)),
path.resolve(__dirname, '../src/config/gameConfig.js'), path.resolve(__dirname, '../src/services/warehouse.js')];
const fingerprint = () => protectedFiles.map(file => fs.existsSync(file)
  ? [file, fs.statSync(file).mode, crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')]
  : [file, 'absent']);
const before = fingerprint();
const config = require('../src/config/gameConfig');
const { loadProto, types } = require('../src/utils/proto');
test.before(loadProto);
test.after(() => {
  try { assert.deepEqual(fingerprint(), before, 'fixtures cannot mutate candidate content or modes'); }
  finally {
    if (originalDataDir === undefined) delete process.env.FARM_DATA_DIR;
    else process.env.FARM_DATA_DIR = originalDataDir;
    assert.equal(path.dirname(path.resolve(privateDir)), temporaryRoot);
    assert.equal(fs.realpathSync(privateDir), privateDir);
    fs.rmSync(privateDir, { recursive: true, force: true });
    assert.equal(fs.existsSync(privateDir), false);
  }
});

function fixture(t, items, fail = false) {
  const logs = [];
  const calls = [];
  const events = new EventEmitter();
  const utils = require('../src/utils/utils');
  const store = require('../src/models/store');
  const replacements = [
    ['../src/utils/network', { networkEvents: events,
      getUserState: () => ({ accountId: 'fixture-account', gid: 7001, level: 1 }),
      getWsErrorState: () => null,
      sendMsgAsync: async (_service, method) => {
        calls.push(method);
        assert.equal(method, 'Bag', 'gift-pack metadata must never authorize a write');
        if (fail) throw new Error('synthetic bag failure');
        return { body: types.BagReply.encode({ item_bag: { items } }).finish() };
      } }],
    ['../src/utils/utils', { ...utils, log: (_tag, _message, meta) => logs.push(meta), logWarn: () => {} }],
    ['../src/models/store', { ...store, isAutomationOn: () => true }],
    ['../src/services/warehouse', null],
  ];
  const saved = replacements.map(([name]) => { const file = require.resolve(name); return [file, require.cache[file]]; });
  replacements.forEach(([, exports], i) => {
    if (exports) require.cache[saved[i][0]] = { exports };
    else delete require.cache[saved[i][0]];
  });
  t.after(() => {
    events.removeAllListeners();
    for (const [file, old] of saved) {
      if (old) require.cache[file] = old;
      else delete require.cache[file];
    }
  });
  return { warehouse: require('../src/services/warehouse'), calls, logs };
}

test('actual Bag DTO names gift packs as items, merges stacks, preserves ordinary seeds and fruit, and shares reads', async t => {
  const f = fixture(t, [...packs.flatMap(([id]) => [{ id, count: 2, uid: id }, { id, count: 3, uid: id + 1000 }]),
    { id: 20002, count: 1 }, { id: 40002, count: 1 }, { id: 799997, count: 1 }]);
  const [bag, parallel] = await Promise.all([f.warehouse.getBagDetail(), f.warehouse.getBagDetail()]);
  assert.deepEqual(parallel.items, bag.items);
  await f.warehouse.getBagDetail();
  assert.deepEqual(f.calls, ['Bag']);
  for (const [id, name] of packs) {
    const item = bag.items.find(x => x.id === id);
    assert.equal(item?.name, name, 'known gift packs must not appear as bare item IDs');
    assert.equal(item.itemType, 11);
    assert.equal(item.category, 'item');
    assert.equal(item.count, 5);
    assert.equal(item.sellable, false);
  }
  assert.equal(bag.items.find(x => x.id === 20002).category, 'seed');
  assert.equal(bag.items.find(x => x.id === 40002).category, 'fruit');
  const unknown = f.logs.filter(x => x?.event === 'bag_unclassified_item');
  assert.ok(unknown.some(x => x.unclassifiedItemIds.includes(799997)));
  assert.ok(unknown.every(x => packs.every(([id]) => !x.unclassifiedItemIds.includes(id))));
});

test('actual Bag image paths resolve to exact reviewed original gift-pack PNGs', async t => {
  const f = fixture(t, packs.map(([id]) => ({ id, count: 1 })));
  const bag = await f.warehouse.getBagDetail();
  const registry = JSON.parse(fs.readFileSync(path.join(configDir, 'seed_images_named/event-seed-sources.json')));
  const { pngResourceInfo } = require('../src/services/privacy-guard');
  for (const [id, , icon, blob, sha] of packs) {
    const image = bag.items.find(x => x.id === id)?.image;
    const file = `${id}_pack_${icon}.png`;
    assert.equal(image, `/game-config/seed_images_named/${file}`);
    const target = path.resolve(configDir, image.slice('/game-config/'.length));
    assert.equal(path.dirname(target), path.join(configDir, 'seed_images_named'));
    const bytes = fs.readFileSync(target);
    assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), sha);
    assert.equal(crypto.createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes])).digest('hex'), blob);
    assert.deepEqual(pngResourceInfo(bytes, { runtimeTerms: [] }), { width: 100, height: 100 });
    const rows = registry.reviewedResources.filter(x => x.itemId === id);
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0], { itemId: id, file, assetName: `gui/texture/icon/pack_${icon}/spriteFrame`, kind: 'item',
      sourceGrade: 'reviewed_public_client_snapshot', repositoryAlias: 'public-reference-2',
      sourceCommit: '5e7c027115ede6fc835bb69d7ad9a081a84c4133',
      sourcePath: `core/src/gameConfig/seed_images_named/seed_images/${id}.png`, gitBlob: blob, sha256: sha, width: 100, height: 100 });
  }
});

test('real planting selection and enabled automatic sale/fertilizer gift entry never use seed gift packs', async t => {
  const items = packs.map(([id]) => ({ id, count: 2 }));
  const f = fixture(t, items);
  assert.deepEqual(f.warehouse.getBagSeedsFromItems(items), []);
  for (const [id] of packs) {
    assert.equal(config.isSeedItem(id), false);
    assert.equal(config.getPlantBySeedId(id), undefined);
    assert.equal(config.getPlantByFruitId(id), undefined);
  }
  await f.warehouse.sellAllFruits();
  assert.equal(await f.warehouse.openFertilizerGiftPacksSilently(), 0);
  assert.deepEqual(f.calls, ['Bag', 'Bag']);
  assert.deepEqual(config.getGenericFallbackItemIds(), []);
});

test('empty and nonpositive gift-pack stacks cannot become plant/sale/use targets', async t => {
  const items = [{ id: 101620, count: 0 }, { id: 101621, count: -1 }, { id: 0, count: 2 }];
  const f = fixture(t, items);
  assert.deepEqual((await f.warehouse.getBagDetail()).items, []);
  assert.deepEqual(f.warehouse.getBagSeedsFromItems(items), []);
  await f.warehouse.sellAllFruits();
  assert.equal(await f.warehouse.openFertilizerGiftPacksSilently(), 0);
  assert.deepEqual(f.calls, ['Bag', 'Bag', 'Bag']);
});

test('ordinary Bag failure preserves failure cooldown and makes no automatic write', async t => {
  const f = fixture(t, [], true);
  await assert.rejects(f.warehouse.getBagDetail(), /synthetic bag failure/);
  await assert.rejects(f.warehouse.getBagDetail(), /背包读取冷却/);
  assert.deepEqual(f.calls, ['Bag']);
  await f.warehouse.sellAllFruits();
  assert.equal(await f.warehouse.openFertilizerGiftPacksSilently(), 0);
  assert.deepEqual(f.calls, ['Bag', 'Bag', 'Bag']);
});
