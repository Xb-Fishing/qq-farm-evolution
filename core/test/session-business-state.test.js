const test = require('node:test'); const assert = require('node:assert/strict');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const prefix = path.resolve(os.tmpdir(), 'session-business-test-'); assert.equal(path.dirname(prefix), path.resolve(os.tmpdir()));
const temporary = fs.mkdtempSync(prefix); process.env.FARM_DATA_DIR = temporary;
test.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
const { createBusinessGate } = require('../src/runtime/business-gate');
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function stateModule() { const file = require.resolve('../src/services/business-state'); delete require.cache[file]; return require(file); }

test('quiesce drains unawaited nested tasks, permits their continuation and rejects new producers', async () => {
  const gate = createBusinessGate('epoch-1'); gate.activate();
  const entered = deferred(); const release = deferred(); const events = []; let nested;
  await gate.run('outer', () => { nested = gate.run('nested', async () => { entered.resolve(); await release.promise; events.push('nested'); await gate.run('tail', () => events.push('tail')); }); });
  await entered.promise;
  let drained = false; const drain = gate.quiesce().then(() => { drained = true; });
  await gate.run('new producer', () => events.push('wrong'));
  await Promise.resolve(); assert.equal(drained, false);
  release.resolve(); await nested; await drain;
  assert.deepEqual(events, ['nested', 'tail']); assert.equal(gate.active, 0);
});

test('expired ALS callbacks cannot resurrect work after drain or retirement', async () => {
  const gate = createBusinessGate('epoch-2'); gate.activate();
  let delayed; let staleOperation; let calls = 0;
  await gate.run('origin', () => {
    staleOperation = gate.operation();
    const { AsyncResource } = require('node:async_hooks'); const resource = new AsyncResource('stale-callback');
    delayed = () => resource.runInAsyncScope(() => gate.run('late', () => { calls++; }));
  });
  await gate.quiesce(); gate.activate(); await delayed(); assert.equal(staleOperation.live, false); assert.equal(calls, 0);
  gate.retire(); await gate.run('retired', () => { calls++; }); await delayed(); assert.equal(calls, 0);
});

test('known producers open a fresh task while event mutations stay synchronous; preparation does not open producers', async () => {
  const gate = createBusinessGate('epoch-producers'); let count = 0; let timer;
  await gate.prepare('bindings', async () => {
    assert.equal(gate.operation().preparation, true);
    await gate.run('nested binding', () => { assert.equal(gate.operation().preparation, true); });
    await gate.runProducer('premature timer', () => { count++; });
  });
  assert.equal(count, 0); gate.activate();
  await gate.run('registration', () => {
    const { AsyncResource } = require('node:async_hooks'); const resource = new AsyncResource('timer-context');
    timer = () => resource.runInAsyncScope(() => gate.runProducer('known timer', () => { count++; }));
  });
  const pending = gate.run('synchronous event', () => { count++; }); assert.equal(count, 1); await pending;
  await timer(); assert.equal(count, 2); await gate.quiesce(); gate.retire(); await timer(); assert.equal(count, 2);
});

test('all checkpoint domains and schemas are required before any restore runs', () => {
  let restores = 0;
  const create = () => {
    const state = stateModule();
    state.registerBusinessState('deadlines', { capture: () => ({ nextFarm: 100, nextSteal: 90 }), restore: () => { restores++; } });
    state.registerBusinessState('quotas', { version: 2, capture: () => new Map([['help', 4]]), restore: () => { restores++; } });
    return state;
  };
  let state = create();
  const snapshot = state.snapshotBusinessState();
  assert.throws(() => state.restoreBusinessState({ version: 1, domains: {} }), /domains changed/);
  assert.equal(restores, 0); assert.throws(() => state.assertBusinessStateHealthy(), /restore failed/);
  assert.throws(() => state.restoreBusinessState(snapshot), /discard this instance/);
  state = create();
  const wrong = structuredClone(snapshot); wrong.domains.quotas.version = 1;
  assert.throws(() => state.restoreBusinessState(wrong), /schema changed/); assert.equal(restores, 0);
  state = create(); state.restoreBusinessState(snapshot); assert.equal(restores, 2); state.assertBusinessStateHealthy();
});

test('restore errors poison the new instance; strict container matching preserves old content on mismatch', () => {
  const state = stateModule();
  state.registerBusinessState('state', { capture: () => 1, restore: () => { throw new Error('incompatible'); } });
  const snapshot = state.snapshotBusinessState(); assert.throws(() => state.restoreBusinessState(snapshot), /incompatible/);
  assert.throws(() => state.snapshotBusinessState(), /restore failed/);
  for (const [target, wrong] of [[new Map([['a', 1]]), {}], [new Set([1]), new Map()], [[1], {}], [{ a: 1 }, []]]) {
    const before = structuredClone(target); assert.throws(() => state.restoreContainer(target, wrong), /container changed/); assert.deepEqual(target, before);
  }
  const array = [1, 2, 3]; const sparse = []; sparse.length = 4; sparse[2] = 7;
  state.restoreContainer(array, sparse); assert.equal(array.length, 4); assert.equal(Object.hasOwn(array, 0), false); assert.equal(array[2], 7);
});
