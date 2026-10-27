const test = require('node:test'); const assert = require('node:assert/strict');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const prefix = path.resolve(os.tmpdir(), 'session-host-core-test-'); assert.equal(path.dirname(prefix), path.resolve(os.tmpdir()));
const temporary = fs.mkdtempSync(prefix); process.env.FARM_DATA_DIR = temporary;
test.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
const { createSessionHostCore } = require('../src/runtime/session-host-core');
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const target = commit => ({ runtimeRoot: `/synthetic/${  commit}`, commit, sourceFingerprint: commit });
function fixture(options = {}) {
  const sent = []; const runtimes = []; const received = []; const phases = [];
  let connectionEpoch = 1; let connected = true; let onEvent; let configuration;
  const game = {
    snapshot: () => ({ connectionEpoch, connected, wireSequence: sent.length }),
    syncConfig: value => { configuration = value; },
    command: (method, args) => ({ method, args }),
    request: async (args, guard) => { guard(); if (options.encoding) await options.encoding.promise; guard(); sent.push(args); return { body: Buffer.from([sent.length]) }; },
    stop: () => { connected = false; }, onEvent: callback => { onEvent = callback; },
  };
  const createBusiness = async context => {
    const version = context.target.commit; const runtime = {
      context,
      prepare: async () => { phases.push(`${version  }:prepare`); if (options.failPrepare === version) throw new Error('prepare failed'); },
      activate: async events => {
        phases.push(`${version  }:activate`); received.push(...events.map(event => [version, event.name]));
        if (options.failAfterRequest === version) { await context.request(1, { action: 'one-shot' }); throw new Error('activation failed'); }
      },
      resumeProducers: async () => { phases.push(`${version  }:producers`); },
      deliverEvents: async events => { received.push(...events.map(event => [version, event.name])); },
      quiesce: async () => { phases.push(`${version  }:quiesce`); options.onQuiesce?.(name => onEvent(name, {})); return { nextAt: 1234, quota: 7 }; },
      resume: async events => { phases.push(`${version  }:resume`); received.push(...events.map(event => [version, event.name])); },
      terminate: async () => { phases.push(`${version  }:terminate`); },
      event: name => { received.push([version, name]); },
      syncConfig: async () => {}, relabelConfig: async () => {}, send: async () => {},
    }; runtimes.push(runtime); return runtime;
  };
  const core = createSessionHostCore({ identity: { hostId: 'synthetic-host' }, game, createBusiness, validateTarget: async value => value });
  return { core, sent, runtimes, phases, received, emit: name => onEvent(name, {}),
    reconnect: () => { connectionEpoch++; }, get configuration() { return configuration; } };
}

test('business replacement keeps physical connection and sequence; old epoch cannot issue requests', async () => {
  const f = fixture({ onQuiesce: emit => emit('landsChanged') });
  await f.core.attach(target('v1'), { revision: 1 });
  const old = f.runtimes[0].context; const first = await old.request(1, { action: 'read' });
  assert.equal(first.value.body[0], 1);
  await f.core.attach(target('v2'), { revision: 2 });
  assert.deepEqual(f.runtimes[1].context.checkpoint, { nextAt: 1234, quota: 7 });
  assert.equal(f.core.facts().game.connectionEpoch, 1);
  assert.deepEqual(f.received, [['v2', 'landsChanged']]);
  assert.ok(f.phases.indexOf('v2:prepare') < f.phases.indexOf('v2:activate'));
  const second = await f.runtimes[1].context.request(1, { action: 'next' }); assert.equal(second.value.body[0], 2);
  await assert.rejects(old.request(2, { action: 'stale-write' }), { code: 'SESSION_EPOCH_RETIRED' });
  assert.equal(f.sent.length, 2); assert.equal(f.configuration.revision, 2);
});

test('same request identity returns its first outcome and refuses different payload reuse', async () => {
  const f = fixture(); await f.core.attach(target('v1'), {});
  const api = f.runtimes[0].context; const args = { method: 'make', body: Buffer.from([1]) };
  const [a, b] = await Promise.all([api.request(1, args), api.request(1, args)]);
  assert.deepEqual(a.value, b.value); assert.equal(f.sent.length, 1);
  await assert.rejects(api.request(1, { ...args, body: Buffer.from([2]) }), { code: 'SESSION_REQUEST_ID_REUSED' });
  assert.equal(f.sent.length, 1);
});

test('failed preparation resumes previous business and replays held events without resetting state', async () => {
  const f = fixture({ failPrepare: 'bad', onQuiesce: emit => emit('friendLandsChanged') });
  await f.core.attach(target('v1'), { revision: 1 });
  await assert.rejects(f.core.attach(target('bad'), { revision: 2 }), /prepare failed/);
  assert.equal(f.core.facts().business.commit, 'v1'); assert.equal(f.core.facts().business.ready, true);
  assert.deepEqual(f.received, [['v1', 'friendLandsChanged']]);
  assert.equal(f.configuration.revision, 1); assert.equal(f.sent.length, 0);
});

test('activation failure after an issued operation never rolls back and replays the old checkpoint', async () => {
  const f = fixture({ failAfterRequest: 'bad' }); await f.core.attach(target('v1'), {});
  await assert.rejects(f.core.attach(target('bad'), {}), { code: 'SESSION_BUSINESS_ACTIVATION_OUTCOME_UNKNOWN' });
  assert.equal(f.core.facts().business.commit, 'bad'); assert.equal(f.core.facts().business.ready, false);
  assert.equal(f.sent.length, 1); assert.equal(f.phases.includes('v1:resume'), false);
  await assert.rejects(f.runtimes[1].context.request(2, { action: 'duplicate' }), { code: 'SESSION_EPOCH_RETIRED' });
});

test('revocation and a physical reconnect are checked after asynchronous encoding, before sending', async () => {
  for (const revoke of [false, true]) {
    const encoding = deferred(); const f = fixture({ encoding }); await f.core.attach(target('v1'), {});
    const pending = f.runtimes[0].context.request(1, { action: 'write' }); await Promise.resolve();
    let stopped; if (revoke) stopped = f.core.revoke(); else f.reconnect();
    encoding.resolve(); await assert.rejects(pending, { code: revoke ? 'SESSION_EPOCH_RETIRED' : 'SESSION_CONNECTION_CHANGED' });
    if (stopped) await stopped; assert.equal(f.sent.length, 0);
  }
});

test('management detach and verified adoption do not stop the game or create a new business', async () => {
  const f = fixture(); await f.core.attach(target('v1'), {});
  const alive = new Set([1, 2]); const isAlive = value => alive.has(value.pid);
  f.core.claimManager({ id: 'one', pid: 1, starttime: 'a' }, isAlive);
  assert.throws(() => f.core.claimManager({ id: 'two', pid: 2, starttime: 'b' }, isAlive), { code: 'SESSION_MANAGER_ALREADY_ATTACHED' });
  f.core.detachManager('one'); f.core.claimManager({ id: 'two', pid: 2, starttime: 'b' }, isAlive);
  assert.equal(f.core.facts().game.connected, true); assert.equal(f.runtimes.length, 1); assert.equal(f.sent.length, 0);
});
