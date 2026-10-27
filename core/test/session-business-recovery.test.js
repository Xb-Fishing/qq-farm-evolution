const test = require('node:test'); const assert = require('node:assert/strict');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path'); const { once, EventEmitter } = require('node:events');
const vm = require('node:vm'); const { createRequire } = require('node:module');
const prefix = path.resolve(os.tmpdir(), 'session-business-recovery-'); assert.equal(path.dirname(prefix), path.resolve(os.tmpdir()));
const temporary = fs.mkdtempSync(prefix); process.env.FARM_DATA_DIR = temporary;
test.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
const { createBusinessGate } = require('../src/runtime/business-gate');
const { createSessionBusinessBridge } = require('../src/runtime/session-business-bridge');
const { createSessionHostCore } = require('../src/runtime/session-host-core');
const { createSessionBusinessRuntime } = require('../src/runtime/session-business-runtime');
const { encode, decode } = require('../src/runtime/session-codec');

test('fatal control failure suspends producers once and forbids later writes from the old operation', async () => {
  const gate = createBusinessGate('synthetic-business'); const port = new EventEmitter(); const diagnostics = []; let requests = 0;
  let sequence = 0; const facts = () => ({ sequence: ++sequence, host: { accountId: 'synthetic-account' },
    game: { connectionEpoch: 1, readyState: 1, socketPresent: true, connected: true, userState: {}, status: {}, clock: {} } });
  port.postMessage = message => {
    if (message.kind === 'business_request') { requests++; return; }
    const input = decode(message.body); const header = new Int32Array(message.buffer, 0, 2);
    const reply = input.kind === 'command' ? { error: Object.assign(new Error('synthetic retired owner'), { code: 'SESSION_EPOCH_RETIRED' }) }
      : { value: { facts: facts() } };
    const body = encode(reply); new Uint8Array(message.buffer, 8, body.length).set(body);
    Atomics.store(header, 1, body.length); Atomics.store(header, 0, 1);
  };
  const bridge = createSessionBusinessBridge({ port, gate, initialFacts: facts(), onControlFailure: detail => { diagnostics.push(detail); gate.suspend?.(); } });
  gate.activate();
  await gate.run('old-operation', async () => {
    assert.throws(() => bridge.command('status.updateStatus', []), { code: 'SESSION_EPOCH_RETIRED' });
    assert.equal(diagnostics.length, 1, 'first failure must retain its stage before it is generalized');
    assert.equal(diagnostics[0].operation, 'command'); assert.equal(diagnostics[0].method, 'status.updateStatus');
    await assert.rejects(bridge.network.sendMsgAsync('synthetic.Service', 'Write', Buffer.from([1])), { code: 'SESSION_EPOCH_RETIRED' });
    assert.throws(() => bridge.readFacts(), { code: 'SESSION_EPOCH_RETIRED' });
  });
  let ticks = 0; await gate.runProducer('later-timer', () => { ticks++; });
  assert.equal(ticks, 0); assert.equal(requests, 0); assert.equal(diagnostics.length, 1);
});

test('async retired-epoch replies and timer-origin control faults suspend once; normal game failures do not', async () => {
  for (const kind of ['request-fatal', 'query-fatal', 'request-normal']) {
    const gate = createBusinessGate('synthetic-reply-owner'); const port = new EventEmitter(); const diagnostics = []; let request;
    const facts = { sequence: 1, host: {}, game: { connectionEpoch: 1, userState: {}, status: {}, clock: {} } };
    port.postMessage = message => {
      if (message.kind === 'business_request') { request = message; return; }
      const input = decode(message.body); const header = new Int32Array(message.buffer, 0, 2);
      const reply = input.kind === 'query' ? { error: Object.assign(new Error('synthetic timer control fault'), { code: 'SESSION_CONTROL_UNAVAILABLE' }) }
        : { value: { facts } };
      const body = encode(reply); new Uint8Array(message.buffer, 8, body.length).set(body); Atomics.store(header, 1, body.length); Atomics.store(header, 0, 1);
    };
    const bridge = createSessionBusinessBridge({ port, gate, initialFacts: facts,
      onControlFailure: detail => { diagnostics.push(detail); gate.suspend?.(); } }); gate.activate();
    if (kind === 'query-fatal') await gate.runProducer('timer', () => {
      assert.throws(() => bridge.query('idle.getIdleProtectionUntil'), { code: 'SESSION_CONTROL_UNAVAILABLE' });
    });
    else await gate.run('request', async () => {
      const promise = bridge.network.sendMsgAsync('synthetic.Service', 'Read', Buffer.alloc(0));
      const code = kind === 'request-fatal' ? 'SESSION_EPOCH_RETIRED' : 'SYNTHETIC_GAME_REJECTION';
      port.emit('message', { kind: 'game_reply', id: request.id, body: encode({ error: Object.assign(new Error('synthetic rejection'), { code }) }) });
      await assert.rejects(promise, { code });
    });
    let ran = false; await gate.runProducer('later', () => { ran = true; });
    assert.equal(diagnostics.length, kind === 'request-normal' ? 0 : 1);
    assert.equal(ran, kind === 'request-normal');
  }
});

test('actual proxy ignores old/healthy delivery failures and keeps a matching local diagnostic degraded until replacement', async () => {
  const filename = path.resolve(__dirname, '../src/runtime/session-worker-proxy.js'); const native = createRequire(filename);
  let facts = { sequence: 1, host: { hostId: 'synthetic-host', sourceCommit: 'synthetic-commit', pid: 1 },
    game: { connected: true, connectionEpoch: 1 }, business: { ready: true, epoch: 'synthetic-current', commit: 'synthetic-commit' } };
  const client = new EventEmitter(); client.ready = true; client.socket = { destroyed: false };
  client.close = () => { client.ready = false; }; client.call = async method => method === 'status'
    ? { facts, lifecycle: { events: [] }, status: { type: 'status_sync', data: {} } } : facts;
  const registry = { connectSession: async () => ({ state: 'present', client, descriptor: { pid: 1 } }), processStarttime: () => 'synthetic-time' };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module, exports: module.exports, process, setImmediate,
    require: name => name === './session-registry' ? registry
      : name === './session-contract' ? { resolveBusinessTarget: () => ({ commit: 'synthetic-commit' }) }
        : name === './session-lifecycle-journal' ? { readLifecycleJournal: () => ({ events: [] }), readLifecycleCursor: () => 0 } : native(name),
  }, { filename });
  const proxy = module.exports.createSessionWorkerProxy({ dataDir: temporary, account: { id: 'synthetic-account' }, sourceRoot: temporary, adoptOnly: true });
  const errors = []; const messages = []; proxy.on('error', error => errors.push(error)); proxy.on('message', message => messages.push(message));
  try {
    await proxy.ready;
    const emit = (type, next, message) => client.emit('event', { type, facts: next, message });
    emit('session_business_error', { ...facts, sequence: 0, business: { ...facts.business, ready: false, epoch: 'synthetic-old' } });
    emit('session_business_error', { ...facts, sequence: 2 }); assert.equal(errors.length, 0);
    facts = { ...facts, sequence: 3 }; emit('session_master', facts, { type: 'session_business_diagnostic', data: { businessEpoch: facts.business.epoch, reason: 'SESSION_CONTROL_UNAVAILABLE' } });
    await proxy.refreshSession(); assert.equal(messages.at(-1).data.sessionRuntime.businessReady, false);
    assert.equal(messages.at(-1).data.sessionRuntime.businessRecoveryPending, true);
    facts = { ...facts, sequence: 4, business: { ...facts.business, ready: false } }; emit('session_business_error', facts);
    assert.equal(errors.length, 1); assert.equal(errors[0].code, 'SESSION_EVENT_DELIVERY_FAILED'); assert.equal(errors[0].phase, 'event_delivery');
    facts = { ...facts, sequence: 5, business: { ...facts.business, ready: true, epoch: 'synthetic-replacement' } };
    await proxy.refreshSession(); assert.equal(proxy.businessFaultEpoch, ''); assert.equal(messages.at(-1).data.sessionRuntime.businessReady, true);
  } finally { await proxy.detach(); }
  client.ready = true; const nativeCall = client.call;
  client.call = async method => {
    if (method === 'attach') throw Object.assign(new Error('synthetic existing local business failure'), { code: 'SESSION_CONTROL_UNAVAILABLE' });
    return nativeCall(method);
  };
  const initial = module.exports.createSessionWorkerProxy({ dataDir: temporary, account: { id: 'synthetic-account' }, sourceRoot: temporary, adoptOnly: true });
  const initialMessages = []; initial.on('error', () => {}); initial.on('message', value => initialMessages.push(value));
  await assert.rejects(initial.ready);
  assert.equal(initial.businessFaultEpoch, facts.business.epoch);
  assert.equal(initialMessages.at(-1).data.sessionRuntime.businessReady, false);
  assert.equal(initialMessages.at(-1).data.sessionRuntime.businessRecoveryPending, true); await initial.detach();
});

for (const origin of ['transport-event', 'local-api']) test(`real ${origin} business fault drains and restores on the legacy host without reconnecting or resuming the failed owner`, { timeout: 30000 }, async () => {
  let connects = 0; let stops = 0; let requests = 0; let readFailure = false; let eventCallback; let firstRuntime;
  const messages = []; const game = {
    snapshot: () => ({ connectionEpoch: connects, loginEpoch: 1, firstLoginReadyAt: 123,
      connected: connects > 0, readyState: connects ? 1 : 3, socketPresent: connects > 0, userState: {}, status: {}, clock: {} }),
    syncConfig: config => ({ ...config, __revision: 1 }),
    command: method => { if (method === 'network.connect') connects++; },
    query: method => method === 'idle.getIdleProtectionUntil' ? 0 : {},
    request: () => { requests++; throw new Error('No gameplay request is allowed in this fixture'); },
    onEvent: callback => { eventCallback = callback; }, stop: () => { stops++; },
  };
  const core = createSessionHostCore({ identity: { hostId: 'synthetic-host', accountId: 'synthetic-account' }, game,
    validateTarget: async target => target,
    createBusiness: async options => {
      const runtime = await createSessionBusinessRuntime({ ...options, read: () => {
        if (readFailure) { readFailure = false; throw Object.assign(new Error('synthetic initial control failure'), { code: 'SESSION_CONTROL_UNAVAILABLE' }); }
        return options.read();
      } });
      firstRuntime ||= runtime;
      if (options.target.commit === 'synthetic-bad-prepare') return { ...runtime, prepare: async () => { await runtime.prepare(); throw new Error('synthetic preparation failure'); } };
      return runtime;
    } });
  core.events.on('master', envelope => messages.push(envelope.message));
  const target = commit => ({ runtimeRoot: path.resolve(__dirname, '../..'), commit, sourceFingerprint: commit });
  try {
    await core.attach(target('synthetic-first'), { code: 'synthetic-code', platform: 'wx' });
    const original = core.facts(); assert.equal(connects, 1);
    readFailure = true;
    if (origin === 'local-api') {
      const diagnosed = new Promise(resolve => {
        const onMaster = envelope => {
          if (envelope.message?.type !== 'session_business_diagnostic') return;
          core.events.off('master', onMaster); resolve();
        };
        core.events.on('master', onMaster);
      });
      await core.dispatch({ type: 'api_call', id: 1, method: 'getBag', args: [] }); await diagnosed;
      assert.equal(core.facts().business.ready, true, 'legacy host has not observed a transport event failure yet');
      await assert.rejects(core.attach(target('synthetic-first'), { platform: 'wx' }));
      assert.equal(connects, 1, 'same-target fast path cannot repair or reconnect this legacy host');
    }
    const failed = once(core.events, 'business-error');
    eventCallback('raw_notify', encode([{ type: 'synthetic.Push', body: Buffer.alloc(0) }])); await failed;
    assert.equal(core.facts().business.ready, false); assert.equal(core.facts().game.connected, true);
    const diagnostics = messages.filter(message => message.type === 'session_business_diagnostic');
    assert.equal(diagnostics.length, 1); assert.equal(diagnostics[0].data.reason, 'SESSION_CONTROL_UNAVAILABLE');
    await assert.rejects(core.attach(target('synthetic-bad-prepare'), { platform: 'wx' }));
    await assert.rejects(firstRuntime.resume([]), 'a failed legacy rollback cannot reactivate the local business gate');
    await core.attach(target('synthetic-recovered'), { platform: 'wx' });
    const current = core.facts();
    assert.equal(current.business.ready, true); assert.notEqual(current.business.epoch, original.business.epoch);
    assert.equal(current.game.connectionEpoch, original.game.connectionEpoch);
    assert.equal(current.game.firstLoginReadyAt, original.game.firstLoginReadyAt);
    assert.equal(connects, 1); assert.equal(stops, 0); assert.equal(requests, 0);
  } finally { await core.revoke(); }
});
