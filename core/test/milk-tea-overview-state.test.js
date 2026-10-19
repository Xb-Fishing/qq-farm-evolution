const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const prefix = path.join(fs.realpathSync(os.tmpdir()), 'farm-milk-overview-');
assert.ok(path.resolve(prefix).startsWith(fs.realpathSync(os.tmpdir()) + path.sep));
const dataDir = fs.mkdtempSync(prefix);
process.env.FARM_DATA_DIR = dataDir;
const { loadProto, types } = require('../src/utils/proto');
const sourceFiles = [__filename, '../src/services/activity.js', '../src/services/milk-tea-activity.js', '../src/core/worker.js'].map(file => path.resolve(__dirname, file));
const fingerprint = () => sourceFiles.map(file => ({ file, mode: fs.statSync(file).mode & 0o777,
  sha: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') }));
const before = fingerprint();
test.before(async () => { await loadProto(); });
test.after(() => {
  try { assert.equal(path.dirname(dataDir), fs.realpathSync(os.tmpdir())); fs.rmSync(dataDir, { recursive: true, force: true }); }
  finally { assert.deepEqual(fingerprint(), before); }
});
const ROOT = 2026110100;
const MAIN = 2026110101;
const NOW = 2_000_000_000;
function fixture(t) {
  const paths = ['../src/utils/network', '../src/services/warehouse', '../src/services/activity', '../src/services/milk-tea-activity'].map(name => require.resolve(name));
  const saved = paths.map(file => [file, require.cache[file]]);
  const counts = { list: 0, group: 0, bag: 0, commands: [] };
  const clock = { now: NOW };
  let connection = {};
  const items = [{ id: 1041, count: 17 }, { id: 1042, count: 2 }, { id: 40525, count: 8, uid: 9001 }];
  const getBag = async () => { counts.bag += 1; return { items }; };
  const getBagItems = bag => bag.items;
  for (const file of paths) delete require.cache[file];
  require.cache[paths[0]] = { exports: { sendMsgAsync: (...args) => deps.sendMsgAsync(...args),
    getWs: () => connection, getUserState: () => ({ gid: 7 }), isConnected: () => true } };
  require.cache[paths[1]] = { exports: { getBag, getBagItems } };
  const activity = require('../src/services/activity');
  const milk = require('../src/services/milk-tea-activity');
  t.after(() => { for (const [file, value] of saved) { if (value) require.cache[file] = value; else delete require.cache[file]; } });
  const snapshot = { id: ROOT, parentId: 0, startTime: NOW - 100, endTime: NOW + 100,
    children: [{ id: MAIN, details: { milkTea: { shopOpenAt: 1, shopName: '测试小店', level: 1, totalRevenue: 1560 } } }] };
  const deps = {
    now: () => clock.now * 1000, isReady: () => true, getConnection: () => connection,
    getBag, getBagItems,
    sendMsgAsync: async (_service, _method, bytes) => {
      const req = types.MilkTeaOperateRequest.decode(bytes);
      const command = Number(req.operate_type); counts.commands.push(command);
      const body = command === 55 ? { milk_tea_get_shop: { shop: { level: 1, pending_rewards: [{ id: 1041, count: 9 }], slots: [] } } }
        : command === 58 ? { milk_tea_get_workshop: { recipes: [{ recipe_id: 2, recipe_name: '甜莓奶茶', unlocked: true }] } }
          : command === 63 ? { milk_tea_get_work_page: { slips: [{ shift_id: 7001, wage_status: 1, wages: { final_wage: 40 } }] } } : {};
      return { body: types.MilkTeaOperateReply.encode({ activity_id: req.activity_id, operate_type: req.operate_type, ...body }).finish() };
    },
    getActivityDiscoveryList: async () => { counts.list += 1; return [snapshot]; },
    getActivityGroupSnapshot: async () => { counts.group += 1; return snapshot; },
  };
  const options = { includeGameplay: true, now: deps.now, deps,
    getActivityDiscoveryList: deps.getActivityDiscoveryList, getActivityGroupSnapshot: deps.getActivityGroupSnapshot };
  return { activity, milk, deps, options, snapshot, counts, clock, changeConnection: () => { connection = {}; } };
}

test('the real default inventory reader is exported and returns known counts without a test-only replacement', async t => {
  const f = fixture(t);
  assert.equal(typeof f.activity.getBagItemCounts, 'function');
  const result = await f.milk.getMilkTeaActivity({ ...f.options, includeGameplay: false });
  assert.equal(result.inventory.available, true); assert.equal(result.inventory.ticketCount, 17); assert.equal(result.inventory.boostItemCount, 2);
  assert.equal(f.counts.bag, 1); assert.deepEqual(f.counts.commands, []);
});

test('one real overview entry reads each core gameplay once, reuses its List/group and never dispatches writes', async t => {
  const f = fixture(t); const result = await f.milk.getMilkTeaActivity(f.options);
  assert.ok(result.gameplay, 'the overview must contain its actual core gameplay state');
  assert.deepEqual(f.counts.commands, [55, 58, 63]); assert.equal(f.counts.list, 1); assert.equal(f.counts.group, 1);
  for (const kind of ['shop', 'workshop', 'work']) assert.equal(result.gameplay[kind].available, true, kind);
  assert.equal(result.gameplay.shop.data.employeeSlotCount, 1);
  assert.equal(result.gameplay.shop.data.slotAvailabilityKnown, true);
  assert.deepEqual(result.gameplay.shop.data.freeSlotIndexes, [0], 'the real initial DTO fills omitted empty positions');
  assert.equal(result.gameplay.workshop.data.recipes[0].name, '甜莓奶茶');
  assert.equal(result.gameplay.workshop.data.recipes[0].fruitItemId, 40525, 'default decoder supplies the actual recipe/fruit mapping used by bulk selection');
  assert.equal(result.gameplay.workshop.data.fruits[0].uid, '9001');
  assert.equal(result.gameplay.work.data.myShift, null); assert.equal(result.gameplay.work.data.slips[0].finalWage, 40);
});

test('a not-yet-opened shop has a concrete state and sends none of the extra gameplay queries', async t => {
  const f = fixture(t); f.snapshot.children[0].details.milkTea.shopOpenAt = 0;
  const result = await f.milk.getMilkTeaActivity(f.options);
  assert.ok(result.gameplay);
  for (const kind of ['shop', 'workshop', 'work']) assert.equal(result.gameplay[kind].state, 'not_open');
  assert.deepEqual(f.counts.commands, []);
});

test('ordinary detail failure is partial, bounded and does not discard inventory or retry the failed query', async t => {
  const f = fixture(t); const send = f.deps.sendMsgAsync;
  f.deps.sendMsgAsync = async (...args) => {
    if (Number(types.MilkTeaOperateRequest.decode(args[2]).operate_type) === 55) { f.counts.commands.push(55); throw new Error('ordinary read failure'); }
    return send(...args);
  };
  const result = await f.milk.getMilkTeaActivity(f.options);
  assert.ok(result.gameplay);
  assert.equal(result.inventory.available, true); assert.equal(result.gameplay.shop.available, false);
  assert.match(result.gameplay.shop.error, /店铺状态读取失败/);
  assert.equal(result.gameplay.workshop.available, true); assert.equal(result.gameplay.work.available, true);
  assert.deepEqual(f.counts.commands, [55, 58, 63]);
});

test('the overview takes the real action lease before awaiting and releases it for the next user query', async t => {
  const f = fixture(t); let resolve;
  const gate = new Promise(r => { resolve = r; }); f.options.getActivityDiscoveryList = () => gate;
  const pending = f.milk.getMilkTeaActivity(f.options);
  await assert.rejects(f.milk.queryMilkTeaActivity('shop', {}, f.deps), error => error.code === 'SEASON_WISH_MILK_TEA_BUSY');
  assert.equal(f.counts.list, 0); resolve([f.snapshot]); await pending;
  const next = await f.milk.queryMilkTeaActivity('shop', {}, f.deps);
  assert.equal(next.kind, 'shop'); assert.equal(next.data.level, 1);
});

for (const mode of ['connection', 'deadline']) {
  test(`${mode} changes after the first detail stop all remaining gameplay requests`, async t => {
    const f = fixture(t); const send = f.deps.sendMsgAsync;
    f.deps.sendMsgAsync = async (...args) => { const result = await send(...args);
      if (mode === 'connection') f.changeConnection(); else f.clock.now = NOW + 101;
      return result;
    };
    await assert.rejects(f.milk.getMilkTeaActivity(f.options), error => error.code === (mode === 'connection'
      ? 'SEASON_WISH_MILK_TEA_CONNECTION_CHANGED' : 'SEASON_WISH_MILK_TEA_ENDED'));
    assert.deepEqual(f.counts.commands, [55]);
  });
}
