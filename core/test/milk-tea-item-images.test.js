'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

const root = path.resolve(__dirname, '../..');
const tempRoot = fs.realpathSync(os.tmpdir());
const prefix = path.resolve(tempRoot, 'farm-milk-reward-images-');
assert.equal(path.dirname(prefix), tempRoot);
assert.ok(!tempRoot.startsWith(root + path.sep));
const dataDir = fs.mkdtempSync(prefix);
const savedEnv = { data: process.env.FARM_DATA_DIR, account: process.env.FARM_ACCOUNT_ID };
process.env.FARM_DATA_DIR = dataDir;
process.env.FARM_ACCOUNT_ID = 'synthetic-milk-reward-images';
const base = path.resolve(root, 'core/src/gameConfig/seed_images_named');
const specs = [
  [1041, '奶茶券', 'icon_s4_ticket'],
  [1042, '宣传喇叭', 'icon_s4_boost'],
  [2163, '缤纷奶茶头像框', 'img_avatar_S4_1'],
  [202011, '缤纷奶茶木牌', 'icon_skin_board_10'],
  [203012, '缤纷奶茶栅栏', 'icon_skin_barrier_11'],
  [205011, '缤纷奶茶狗屋', 'icon_skin_doghouse_10'],
  [206011, '缤纷奶茶仓库', 'icon_skin_warehouse_10'],
  [207012, '缤纷奶茶街道', 'icon_skin_road_11'],
  [208012, '缤纷奶茶围栏', 'icon_skin_fence_11'],
  [210031, '可可屋顶', 'icon_wuding04'],
  [210032, '暖光木门', 'icon_men04'],
  [210033, '绿意款窗', 'icon_chuang04'],
  [210034, '杏仁墙面', 'icon_qiangmian04'],
  [210035, '茶木地板', 'icon_diban04'],
  [210036, '莓果桌椅', 'icon_zhuoyi04'],
  [210037, '茶语装饰', 'icon_zhuangshi04'],
  [210048, '人气招牌装饰', 'icon_zhuangshi06'],
];
const fileName = ([id, , icon]) => `${id}_${icon}.png`;
const tracked = [__filename, path.join(base, 'event-seed-sources.json'),
  path.join(root, 'core/src/gameConfig/EventItems.json'),
  ...specs.map(spec => path.join(base, fileName(spec)))];
function fingerprint() {
  return tracked.map(file => fs.existsSync(file)
    ? [file, fs.statSync(file).mode & 0o777, crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')]
    : [file, 'absent']);
}
const before = fingerprint();
test.after(() => {
  try { assert.deepEqual(fingerprint(), before); }
  finally {
    for (const [key, value] of [['FARM_DATA_DIR', savedEnv.data], ['FARM_ACCOUNT_ID', savedEnv.account]]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    assert.equal(path.dirname(path.resolve(dataDir)), tempRoot);
    assert.ok(path.basename(dataDir).startsWith('farm-milk-reward-images-'));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

const config = require('../src/config/gameConfig');
const { loadProto, types } = require('../src/utils/proto');
const { pngResourceInfo } = require('../src/services/privacy-guard');
const registry = JSON.parse(fs.readFileSync(path.join(base, 'event-seed-sources.json')));
test.before(async () => { await loadProto(); });

for (const spec of specs) test(`current reward ${spec[0]} resolves its own named, source-verified item image`, () => {
  const [id, name] = spec;
  assert.equal(config.getItemImageById(id), `/game-config/seed_images_named/${fileName(spec)}`);
  assert.equal(config.getItemById(id)?.name, name);
  assert.equal(config.isSeedItem(id), false);
  assert.equal(config.getPlantBySeedId(id), undefined);
  assert.equal(config.getPlantByFruitId(id), undefined);
  const row = registry.reviewedResources.find(entry => entry.itemId === id);
  assert.ok(row);
  assert.equal(row.file, fileName(spec));
  assert.equal(row.assetPath.split('/').at(-2), spec[2]);
  assert.equal(row.sourceGrade, 'reviewed_public_client_snapshot');
  assert.ok(registry.references.some(ref => ref.repositoryAlias === row.repositoryAlias && ref.commit === row.sourceCommit));
  const target = path.resolve(base, row.file);
  assert.equal(path.dirname(target), base);
  const bytes = fs.readFileSync(target);
  assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), row.sha256);
  assert.equal(crypto.createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes])).digest('hex'), row.gitBlob);
  assert.deepEqual(pngResourceInfo(bytes, { runtimeTerms: [] }), { width: row.width, height: row.height });
  assert.equal(row.width, id === 2163 ? 128 : 100);
  assert.equal(row.height, row.width);
});

function fixture(t, bagError) {
  const paths = ['../src/utils/network', '../src/services/warehouse', '../src/services/activity', '../src/services/milk-tea-activity']
    .map(name => require.resolve(name));
  const saved = paths.map(file => [file, require.cache[file]]);
  const calls = [];
  const bag = types.BagReply.encode(types.BagReply.create({ item_bag: { items:
    [...specs.map(([id]) => ({ id, count: 2 })), { id: 799993, count: 1 }],
  } })).finish();
  const snapshot = types.MilkTeaGetGroupReply.encode(types.MilkTeaGetGroupReply.create({ group: {
    head: { activity_id: 2026110100, begin_time: 1, end_time: 4102444800 }, children: [
      { head: { activity_id: 2026110101 }, milk_tea: { summary: { level: 1 } } },
      { head: { activity_id: 2026110102 }, shop: { goods: specs.slice(2).map(([id], index) => ({
        id: 301 + index, item: [{ id, count: 1 }], cost: [{ id: 1041, count: 1 }], purchase_limit: 5,
      })) } },
      { head: { activity_id: 2026110103 }, growth_fund: { unlocked: false, tiers: [
        { tier_id: 1, reward: [{ id: 2163, count: 1 }], state: 1 },
      ] } },
    ],
  } })).finish();
  const connection = {};
  require.cache[paths[0]] = { id: paths[0], filename: paths[0], loaded: true, exports: {
    sendMsgAsync: async (_service, method) => {
      calls.push(method);
      if (method === 'Bag') { if (bagError) throw bagError; return { body: bag }; }
      assert.equal(method, 'GetGroup', 'the fixture rejects all economic writes and unexpected reads');
      return { body: snapshot };
    },
    getWs: () => connection, getUserState: () => ({ level: 1, gold: 0 }), networkEvents: new EventEmitter(),
  } };
  for (const file of paths.slice(1)) delete require.cache[file];
  t.after(() => {
    for (const [file, entry] of saved) {
      if (entry) require.cache[file] = entry;
      else delete require.cache[file];
    }
  });
  return { calls, connection, warehouse: require('../src/services/warehouse'), activity: require('../src/services/activity') };
}

test('real BagReply and panel cache deliver all reward images; reward metadata grants no automatic selling', async t => {
  const f = fixture(t);
  const detail = await f.warehouse.getBagDetail();
  await f.warehouse.getBagDetail();
  for (const spec of specs) {
    const entry = detail.items.find(item => item.id === spec[0]);
    assert.equal(entry?.name, spec[1]);
    assert.equal(entry?.image, config.getItemImageById(spec[0]));
    assert.notEqual(entry?.category, 'fruit');
    assert.notEqual(entry?.category, 'seed');
  }
  const unknown = detail.items.find(item => item.id === 799993);
  assert.equal(unknown?.image, '');
  assert.equal(config.getItemById(799993), undefined);
  assert.deepEqual(f.calls, ['Bag'], 'repeat panel reads reuse the existing cache');
  const store = require('../src/models/store');
  store.applyConfigSnapshot({ automation: { sell: true } }, { persist: false, accountId: process.env.FARM_ACCOUNT_ID });
  assert.equal(store.isAutomationOn('sell'), true);
  await f.warehouse.sellAllFruits();
  assert.deepEqual(f.calls, ['Bag', 'Bag'], 'none of the currency, props or decorations may dispatch Sell');
});

test('real shared GetGroup and milk-tea overview attach names and images to costs, rewards and fund previews', async t => {
  const f = fixture(t);
  const overview = await f.activity.getMilkTeaActivity({
    deps: { isReady: () => true, getConnection: () => f.connection },
    getActivityDiscoveryList: async () => [{ id: 2026110100, parentId: 0 }],
    getActivityGroupSnapshot: f.activity.getActivityGroupSnapshot,
  });
  assert.equal(overview.exchangeShop.items.length, 15);
  for (const goods of overview.exchangeShop.items) {
    const reward = goods.rewards[0];
    assert.equal(reward.name, config.getItemById(reward.id).name);
    assert.equal(reward.image, config.getItemImageById(reward.id));
    assert.equal(reward.iconStatus, 'mapped');
    assert.equal(goods.costs[0].name, '奶茶券');
    assert.equal(goods.costs[0].image, config.getItemImageById(1041));
  }
  assert.equal(overview.growthFund.tiers[0].reward[0].image, config.getItemImageById(2163));
  assert.equal(overview.inventory.ticketCount, 2);
  assert.deepEqual(f.calls, ['GetGroup', 'Bag'], 'one group and one inventory read, zero Operate or other write');
});

test('ordinary inventory failure preserves the existing panel cooldown without retry or fake success', async t => {
  const f = fixture(t, new Error('synthetic inventory read failure'));
  await assert.rejects(f.warehouse.getBagDetail(), /synthetic inventory/);
  await assert.rejects(f.warehouse.getBagDetail(), /背包读取冷却中/);
  assert.deepEqual(f.calls, ['Bag']);
});
