'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { AsyncResource } = require('node:async_hooks');
const { randomUUID } = require('node:crypto');
const temporary = fs.realpathSync(process.env.FARM_LOG_HISTORY_TEST_DIR || os.tmpdir());
const fixture = fs.mkdtempSync(path.join(temporary, 'own-priority-boundary-'));
process.env.FARM_DATA_DIR = fixture;
process.env.FARM_ACCOUNT_ID = 'synthetic-priority-boundary';
const priority = require('../src/services/own-quiet-priority');
const state = require('../src/services/business-state');
const { createBusinessGate } = require('../src/runtime/business-gate');
const scheduler = require('../src/services/scheduler');
const sessionTimers = require('../src/services/session-scheduler');
const proto = require('../src/utils/proto');
const store = require('../src/models/store');
const network = require('../src/utils/network');
const previousUserState = network.getUserState;
const service = 'gamepb.plantpb.PlantService';
const payload = Buffer.alloc(0);
const scope = () => ({ landIds: [1, 2] });
let calls;
let quiet;
const send = priority.wrapSend(async (_service, _method, _body, _timeout, options) => {
  calls.push(options?.ownFarmQuietPriority);
  if (quiet && !options?.ownFarmQuietPriority) throw Object.assign(new Error('ordinary request remains paused'), { code: 'LOCAL_BUSINESS_PAUSED' });
  return 'ordinary-result';
});
const outcome = async callback => {
  try { return { value: await callback() }; }
  catch (error) { return { error: error.code || error.message }; }
};
function done() {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
}
function gate() {
  const value = createBusinessGate(`synthetic-${  randomUUID()}`);
  value.setAuthorityProvider(() => ({ connectionEpoch: 1, configRevision: 7 }));
  value.activate(); return value;
}
test.before(async () => {
  await proto.loadProto();
  store.applyConfigSnapshot({ automation: { farm: true, harvest: true, plant: true } }, { persist: false, accountId: process.env.FARM_ACCOUNT_ID });
  network.getUserState = () => ({ gid: 42 });
});
test.beforeEach(() => { calls = []; quiet = false; state.setBusinessGate(null); });
test.afterEach(() => { sessionTimers.pauseSessionSchedulers(); state.setBusinessGate(null); });
test.after(() => {
  network.getUserState = previousUserState;
  assert.equal(path.dirname(fixture), temporary);
  fs.rmSync(fixture, { recursive: true, force: true });
});

test('real session timers registered during own maturity publish run normal farm checks after owner settled', { timeout: 5000 }, async () => {
  const currentGate = gate(); state.setBusinessGate(currentGate);
  const timer = scheduler.createScheduler(`scope-session-${  randomUUID()}`);
  sessionTimers.resumeSessionSchedulers();
  const finished = done(); const results = [];
  async function checkAgain() {
    results.push(await outcome(() => send(service, 'AllLands', payload)));
    if (results.length === 1) timer.setTimeoutTask('unified-next', 1, checkAgain);
    else finished.resolve();
  }
  try {
    await currentGate.runProducer('owner-harvest', () => priority.run(scope(), () => {
      timer.setTimeoutTask('unified-next', 1, checkAgain);
    }));
    await finished.promise;
    assert.deepEqual(results, [{ value: 'ordinary-result' }, { value: 'ordinary-result' }]);
    assert.deepEqual(calls, [undefined, undefined], 'new farm work must not borrow the harvest exemption');
  } finally { timer.clearAll(); currentGate.retire(); }
});

test('native named timeout registered by own scope does not poison a later ordinary farm check', { timeout: 5000 }, async () => {
  const timer = scheduler.createScheduler(`scope-native-${  randomUUID()}`); const finished = done();
  let result;
  try {
    await priority.run(scope(), () => {
      timer.setTimeoutTask('farm-check', 1, async () => { result = await outcome(() => send(service, 'AllLands', payload)); finished.resolve(); });
    });
    await finished.promise;
    assert.deepEqual(result, { value: 'ordinary-result' }); assert.deepEqual(calls, [undefined]);
  } finally { timer.clearAll(); }
});

for (const kind of ['native', 'session']) {
  test(`${kind} named interval and runImmediately each start without inherited own eligibility`, { timeout: 5000 }, async () => {
    const currentGate = gate();
    if (kind === 'session') { state.setBusinessGate(currentGate); sessionTimers.resumeSessionSchedulers(); }
    const timer = scheduler.createScheduler(`scope-interval-${  randomUUID()}`); const finished = done(); const results = [];
    try {
      await priority.run(scope(), () => {
        timer.setIntervalTask('farm-check', 2, async () => {
          results.push(await outcome(() => send(service, 'AllLands', payload)));
          if (results.length === 2) { timer.clear('farm-check'); finished.resolve(); }
        }, { runImmediately: true });
      });
      await finished.promise;
      assert.deepEqual(results, [{ value: 'ordinary-result' }, { value: 'ordinary-result' }]);
      assert.deepEqual(calls, [undefined, undefined]);
    } finally { timer.clearAll(); currentGate.retire(); }
  });
}

test('fresh producer clears only own eligibility while nested run keeps the same owner marker and authority', { timeout: 5000 }, async () => {
  const currentGate = gate();
  try {
    await currentGate.runProducer('owner', () => priority.run(scope(), async () => {
      const original = currentGate.operation();
      await currentGate.run('nested-step', async () => {
        assert.equal(currentGate.operation().authority, original.authority);
        await send(service, 'AllLands', payload);
      });
      await currentGate.runProducer('independent', async () => {
        assert.notEqual(currentGate.operation().authority, original.authority);
        assert.equal(priority.inScope(), false);
        assert.equal(priority.isActive(), true, 'clearing eligibility must not clear the real in-flight owner');
        await send(service, 'AllLands', payload);
      });
      await Promise.resolve(); await send(service, 'AllLands', payload);
    }));
    assert.ok(calls[0]); assert.equal(calls[1], undefined); assert.ok(calls[2]);
  } finally { currentGate.retire(); }
});

test('new transport event retains explicit connection origin without acquiring own eligibility', { timeout: 5000 }, async () => {
  const currentGate = gate();
  try {
    await currentGate.runProducer('owner', () => priority.run(scope(), async () => {
      await currentGate.runEvent('lands', async () => {
        assert.equal(priority.inScope(), false);
        assert.equal(currentGate.operation().connectionEpoch, 9);
        assert.equal(currentGate.operation().configRevision, 7);
        await send(service, 'AllLands', payload);
      }, 9);
    }));
    assert.deepEqual(calls, [undefined]);
  } finally { currentGate.retire(); }
});

test('preparation is a fresh context and a retired gate still cannot open new work', { timeout: 5000 }, async () => {
  const currentGate = gate(); let entered = false;
  try {
    await currentGate.runProducer('owner', () => priority.run(scope(), () => currentGate.prepare('prepare', () => {
      assert.equal(priority.inScope(), false); assert.equal(currentGate.operation().preparation, true);
    })));
    currentGate.retire(); await currentGate.runProducer('late', () => { entered = true; }); assert.equal(entered, false);
  } finally { currentGate.retire(); }
});

test('direct late timer and Promise continuation of the ended owner remain rejected', { timeout: 5000 }, async () => {
  const finished = done(); let release; const blocked = new Promise(resolve => { release = resolve; });
  let late; let timerResult; let promiseResult;
  await priority.run(scope(), () => {
    late = AsyncResource.bind(() => send(service, 'AllLands', payload));
    setTimeout(async () => { timerResult = await outcome(() => send(service, 'AllLands', payload)); finished.resolve(); }, 1);
    blocked.then(async () => { promiseResult = await outcome(() => send(service, 'AllLands', payload)); });
  });
  await assert.rejects(late(), { code: 'OWN_PRIORITY_CANCELLED' }); release(); await finished.promise;
  assert.deepEqual(timerResult, { error: 'OWN_PRIORITY_CANCELLED' });
  assert.deepEqual(promiseResult, { error: 'OWN_PRIORITY_CANCELLED' }); assert.equal(calls.length, 0);
});

test('an independent producer cannot reuse the current owner marker to bypass quiet', { timeout: 5000 }, async () => {
  const currentGate = gate(); quiet = true;
  try {
    await currentGate.runProducer('owner', () => priority.run(scope(), async () => {
      assert.equal(await send(service, 'AllLands', payload), 'ordinary-result');
      const result = await currentGate.runProducer('ordinary', () => outcome(() => send(service, 'AllLands', payload)));
      assert.deepEqual(result, { error: 'LOCAL_BUSINESS_PAUSED' });
    }));
    assert.ok(calls[0]); assert.equal(calls[1], undefined);
  } finally { currentGate.retire(); }
});
