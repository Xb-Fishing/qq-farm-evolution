'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), vm = require('node:vm');
const { createRequire } = require('node:module');
const prefix = path.resolve(fs.realpathSync(os.tmpdir()), 'farm-dog-feeding-');
assert.equal(path.dirname(prefix), fs.realpathSync(os.tmpdir()));
const root = fs.mkdtempSync(prefix); process.env.FARM_DATA_DIR = root;
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
const proto = require('../src/utils/proto'); test.before(() => proto.loadProto());
const serviceRoot = path.resolve(__dirname, '../src/services');
function varint(input) { let n = BigInt(input); const bytes = []; do { const b = Number(n & 127n); n >>= 7n; bytes.push(b | (n ? 128 : 0)); } while (n); return bytes; }
function field(tag, n) { return [...varint(tag * 8), ...varint(n)]; }
function fixture() {
  const dir = fs.mkdtempSync(path.join(root, 'case-')); assert.equal(path.dirname(dir), root);
  const state = { remaining: 3600, capacity: 30 * 86400, activeDog: 2, count: 3, writes: [], reads: 0,
    unknown: false, lost: false, budget: false, enabled: false, paused: false, log: [], ws: {}, epoch: 1 };
  const env = { ...process.env, FARM_SESSION_BUSINESS: '', FARM_ACCOUNT_ID: 'synthetic-dog', FARM_DATA_DIR: dir };
  const network = { getWs: () => state.ws, isConnected: () => true, getUserState: () => ({ gid: 910000 }),
    sendMsgAsync: async (service, method, body) => {
      assert.equal(service, 'gamepb.dogpb.DogService');
      if (method === 'GetDogInfo') {
        state.reads++; if (state.onRead) state.onRead();
        // Independent bytes: tag2 selected dog, tag3 remaining seconds, tag4 capacity.
        const dog = Buffer.from([...field(1, 2), 18, 3, ...Buffer.from('Dog'), ...field(5, 1)]);
        return { body: Buffer.from([10, dog.length, ...dog, ...field(2, state.activeDog),
          ...(state.remaining ? field(3, state.remaining) : []), ...field(4, state.capacity)]) };
      }
      assert.equal(method, 'AddFood');
      if (state.budget) throw Object.assign(new Error('local budget'), { isGovernedRejection: true, governedReason: 'budget_friend' });
      const sent = proto.types.AddFoodRequest.decode(body);
      state.writes.push({ itemId: Number(sent.item_id), count: Number(sent.count) });
      state.remaining += { 90004: 86400, 90005: 259200, 90006: 432000 }[Number(sent.item_id)]; state.count--;
      if (state.swapAfterWrite) state.epoch++;
      if (state.lost) throw new Error('lost response');
      return { body: state.unknown ? Buffer.alloc(0) : proto.types.AddFoodReply.encode({ protect_time: state.remaining }).finish() };
    } };
  const warehouse = { getBag: async () => proto.types.BagReply.decode(proto.types.BagReply.encode({ item_bag: { items: [{ id: 90004, count: state.count }] } }).finish()),
    getBagItems: value => value.item_bag.items, invalidatePanelBagCache() {} };
  let panel;
  const mocks = { '../utils/network': network, '../utils/proto': proto, './warehouse': warehouse,
    '../models/store': { getAutomation: () => ({ dog_auto_feed: state.enabled }), getPauseRemainMs: () => state.paused ? 1000 : 0 },
    '../utils/utils': { log: (...args) => state.log.push(args) }, './own-quiet-priority': { isActive: () => false },
    './dog-skill-gifts': { invalidatePanelDogInfoCache() {} },
    '../config/runtime-paths': { getDataDir: () => dir, getResourcePath: require('../src/config/runtime-paths').getResourcePath },
  };
  function load(name) {
    const file = path.join(serviceRoot, name + '.js'), mod = { exports: {} }, native = createRequire(file);
    vm.compileFunction(fs.readFileSync(file, 'utf8'), ['require', 'module', 'exports', 'process', 'globalThis'])(
      key => key === './game-panel-readonly' ? panel : Object.hasOwn(mocks, key) ? mocks[key] : native(key), mod, mod.exports, { env },
      { process: { env }, __farmSessionBridge: { readFacts: () => ({ game: { connectionEpoch: state.epoch, loginEpoch: 1 } }) } });
    return mod.exports;
  }
  panel = load('game-panel-readonly');
  let serial = 0;
  return { state, panel, reload: () => load('manual-commerce'), manual: load('manual-commerce'),
    request: async () => ({ itemId: 90004, count: 1, operationId: `synthetic_dog_action_${++serial}`, quoteFingerprint: (await panel.getDogReadPanel()).foods[0].quoteFingerprint }) };
}
test('actual panel decoder and AddFood path confirm one food debit and exact guard time, including omitted expired protection', async () => {
  for (const remaining of [0, 3600]) {
    const f = fixture(); f.state.remaining = remaining;
    const before = await f.panel.getDogReadPanel();
    assert.equal(before.protectionKnown, true); assert.equal(before.protectionSeconds, remaining);
    assert.equal(before.capacitySeconds, 2592000); assert.equal(before.foods[0].durationSeconds, 86400);
    const result = await f.manual.guardedDogFeeding(await f.request());
    assert.equal(result.confirmed, true); assert.equal(result.remainingSeconds, remaining + 86400);
    assert.deepEqual(f.state.writes, [{ itemId: 90004, count: 1 }]);
    assert.equal(f.state.count, 2); assert.equal(f.state.log.length, 1);
  }
});
test('capacity, inactive dog, changed quote and invalid count are rejected before any food write', async () => {
  for (const kind of ['capacity', 'dog', 'quote', 'count']) {
    const f = fixture(); const request = await f.request();
    if (kind === 'capacity') f.state.remaining = f.state.capacity - 1;
    if (kind === 'dog') f.state.activeDog = 0;
    if (kind === 'quote') request.quoteFingerprint = '0'.repeat(64);
    if (kind === 'count') request.count = 2;
    await assert.rejects(f.manual.guardedDogFeeding(request));
    assert.equal(f.state.writes.length, 0); assert.equal(f.state.log.length, 0);
  }
});
test('lost or empty reply remains durably unknown and cannot be resent after service reload', async () => {
  for (const kind of ['lost', 'unknown']) {
    const f = fixture(); f.state[kind] = true;
    await assert.rejects(f.manual.guardedDogFeeding(await f.request()), { code: 'COMMERCE_UNKNOWN' });
    assert.equal(f.state.writes.length, 1); assert.equal(f.state.log.length, 0);
    f.state[kind] = false;
    await assert.rejects(f.reload().guardedDogFeeding(await f.request()), { code: 'COMMERCE_PENDING' });
    assert.equal(f.state.writes.length, 1);
  }
});
test('only a strict zero-send budget rejection releases the durable declaration', async () => {
  const f = fixture(); f.state.budget = true;
  await assert.rejects(f.manual.guardedDogFeeding(await f.request())); assert.equal(f.state.writes.length, 0);
  f.state.budget = false;
  assert.equal((await f.manual.guardedDogFeeding(await f.request())).confirmed, true);
  assert.equal(f.state.writes.length, 1);
});
test('automatic feeding is opt-in, honors pause and the six-hour threshold, and shares the single-item writer', async () => {
  const f = fixture(); await f.manual.runDogAutoFeeding(); assert.equal(f.state.reads, 0);
  f.state.enabled = true; f.state.paused = true;
  await f.manual.runDogAutoFeeding(); assert.equal(f.state.reads, 0);
  f.state.paused = false;
  await f.manual.runDogAutoFeeding();
  assert.equal(f.state.writes.length, 1); const reads = f.state.reads;
  await f.manual.runDogAutoFeeding(); assert.equal(f.state.reads, reads); assert.equal(f.state.writes.length, 1);
  const fresh = f.reload(); await fresh.runDogAutoFeeding(); assert.equal(f.state.writes.length, 1, 'fresh state prevents another feed even across reload');
});


test('automatic writer rechecks fresh protection inside the shared transaction before consuming', async () => {
  const f = fixture(); f.state.enabled = true; const request = await f.request();
  f.state.remaining = 7 * 3600; // another accepted feed need not change this selected food stack
  const result = await f.manual.guardedDogFeeding(request, { automatic: true });
  assert.equal(result.skipped, true); assert.equal(f.state.writes.length, 0); assert.equal(f.state.log.length, 0);
});
test('changed physical login after AddFood or during reconciliation keeps the declaration unknown', async () => {
  for (const phase of ['reply', 'reconciliation']) {
    const f = fixture();
    if (phase === 'reply') f.state.swapAfterWrite = true;
    else f.state.onRead = () => { if (f.state.writes.length) f.state.epoch++; };
    await assert.rejects(f.manual.guardedDogFeeding(await f.request()), { code: 'COMMERCE_UNKNOWN' });
    assert.equal(f.state.writes.length, 1); assert.equal(f.state.log.length, 0);
    f.state.swapAfterWrite = false; f.state.onRead = null;
    await assert.rejects(f.reload().guardedDogFeeding(await f.request()), { code: 'COMMERCE_PENDING' });
    assert.equal(f.state.writes.length, 1);
  }
});
