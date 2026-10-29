'use strict';
// Full production network/governor source with an isolated clock and collaborators.
// No real account, socket, disk persistence, credential or TSDK is used.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'); const path = require('node:path'); const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const sourceFile = path.resolve(__dirname, '../src/utils/network.js');
const governorFile = path.resolve(__dirname, '../src/services/request-governor.js');
const rawNetwork = fs.readFileSync(sourceFile, 'utf8');
const rawGovernor = fs.readFileSync(governorFile, 'utf8');
const dataRoot = '/isolated-no-io-network-fixture';
const baseNow = Date.parse('2026-10-28T00:00:00Z');
const later = () => new Promise(resolve => setImmediate(resolve));
function createHarness(name) {
  let now = baseNow; let wallOffset = 0; let pauseMs = 0; let blockedEncoding = null; let runtimeInit = null; let replyPolicy = null;
  const timers = new Map(); const transmissions = []; const attempts = []; const events = []; const logs = []; const sockets = [];
  const metrics = { successfulRpcReplies: 0, errorRpcReplies: 0, closeCalls: 0, terminateCalls: 0, websocketConstructions: 0 };
  class Clock extends Date { static now() { return now + wallOffset; } }
  const localProcess = { env: { FARM_DATA_DIR: dataRoot, FARM_ACCOUNT_ID: 'synthetic-heartbeat-offline', NODE_TEST_CONTEXT: 'offline-fixture' } };
  const governorModule = { exports: {} };
  vm.runInNewContext(rawGovernor, { module: governorModule, exports: governorModule.exports, Date: Clock,
    process: localProcess, Math, require: name => { throw new Error(`Unexpected governor dependency: ${  name}`); } }, { filename: governorFile });
  const governor = governorModule.exports;
  const scheduler = {
    setIntervalTask(key, delay, callback) { timers.set(key, { at: now + delay, interval: delay, callback }); },
    setTimeoutTask(key, delay, callback) { timers.set(key, { at: now + delay, interval: 0, callback }); },
    clear(key) { return timers.delete(key); }, clearAll() { timers.clear(); },
  };
  class Socket extends EventEmitter {
    static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
    constructor() { super(); this.readyState = Socket.OPEN; sockets.push(this); metrics.websocketConstructions++; }
    send(bytes) {
      const frame = JSON.parse(Buffer.from(bytes).toString('utf8'));
      const row = { atMs: now - baseNow, method: frame.meta.method_name, sequence: frame.meta.client_seq, readyState: this.readyState };
      attempts.push(row);
      if (this.readyState !== Socket.OPEN) throw new Error('Synthetic socket is not OPEN');
      transmissions.push(row);
      if (replyPolicy) queueMicrotask(() => replyPolicy(frame));
    }
    close() { metrics.closeCalls++; this.readyState = Socket.CLOSING; }
    terminate() { metrics.terminateCalls++; this.readyState = Socket.CLOSED; }
  }
  const proto = {
    GateMessage: { create: value => value, encode: value => ({ finish: () => Buffer.from(JSON.stringify(value)) }), decode: value => JSON.parse(Buffer.from(value).toString('utf8')) },
    LoginRequest: { create: value => value, encode: value => ({ finish: () => Buffer.from(JSON.stringify(value)) }) },
    HeartbeatRequest: { create: value => value, encode: value => ({ finish: () => Buffer.from(JSON.stringify(value)) }) },
    HeartbeatReply: { decode: () => ({}) },
  };
  const config = { heartbeatInterval: 25000, clientVersion: '1.0.0_20261023', serverUrl: 'wss://synthetic.invalid', platform: 'wx', os: 'synthetic' };
  const writeLog = (level, tag, message) => logs.push({ atMs: now - baseNow, level, tag, message });
  const cryptoWasm = { setRuntime() {}, encryptBuffer: async bytes => {
    if (blockedEncoding) await blockedEncoding.promise;
    return bytes;
  } };
  const store = { getWirePauseRemainMs: () => pauseMs, getDeviceProtocolForAccount: () => null };
  const replacements = {
    'node:perf_hooks': { performance: { now: () => now - baseNow } }, 'node:buffer': { Buffer }, 'node:events': EventEmitter, 'node:process': localProcess, ws: Socket,
    '../config/config': { CONFIG: config }, '../services/ace-service': { AceService: class { constructor() { throw new Error('Unexpected ACE initialization'); } } },
    '../services/scheduler': { createScheduler: namespace => { assert.equal(namespace, 'network'); return scheduler; } },
    '../services/status': { updateStatusFromLogin() {}, updateStatusGold() {}, updateStatusLevel() {} },
    '../services/stats': { recordOperation() {}, recordTongQiGift() {}, getTongQiGiftCount: () => 0 },
    './proto': { types: proto }, './utils': { toLong: Number, toNum: Number, syncServerTime() {}, log: (...args) => writeLog('info', ...args), logWarn: (...args) => writeLog('warn', ...args) },
    './crypto-wasm': cryptoWasm, './gateway-token': { createGatewayToken: () => 'SYNTHETIC_ONLY' },
    './tsdk-runtime': { TsdkRuntime: class { async init() { if (runtimeInit) await runtimeInit.promise; } destroy() {} } },
    '../services/request-governor': governor, '../models/store': store, '../runtime/own-quiet-wire': { install: () => ({ active: false }) },
  };
  const module = { exports: {} };
  const context = vm.createContext({ module, exports: module.exports, Buffer, Date: Clock, Math, Map, Set,
    process: localProcess, queueMicrotask, Uint8Array, require: name => {
      if (!Object.hasOwn(replacements, name)) throw new Error(`Unexpected network dependency: ${  name}`);
      return replacements[name];
    }, fetch: () => { throw new Error('Real network access is forbidden'); } });
  // Evaluate exact complete source. The following expressions access private state only.
  vm.runInContext(rawNetwork, context, { filename: sourceFile });
  const network = module.exports;
  const socket = new Socket(); context.fixtureSocket = socket;
  vm.runInContext('ws = fixtureSocket; userState.gid = 1; savedLoginCallback = () => {}; savedCode = "SYNTHETIC_ONLY"; startHeartbeat();', context);
  network.networkEvents.on('disconnect', detail => events.push({ atMs: now - baseNow, type: 'disconnect', code: detail.code }));
  function state() {
    return JSON.parse(vm.runInContext('JSON.stringify({lastHeartbeatResponse, heartbeatMissCount, pending: pendingCallbacks.size, active: typeof activeRequests === "undefined" ? null : activeRequests.size, connected: isConnected()})', context));
  }
  async function at(ms) {
    const target = baseNow + ms; assert.ok(target >= now, 'Monotonic simulated clock');
    while (true) {
      let earliest = null;
      for (const [key, value] of timers) if (value.at <= target && (!earliest || value.at < earliest.value.at)) earliest = { key, value };
      if (!earliest) break;
      now = earliest.value.at;
      if (earliest.value.interval) earliest.value.at += earliest.value.interval;
      else timers.delete(earliest.key);
      earliest.value.callback();
      await later();
    }
    now = target; await later();
  }
  function respond(frame, code = 0) {
    const response = { meta: { message_type: 2, client_seq: frame.meta.client_seq, error_code: code,
      service_name: frame.meta.service_name, method_name: frame.meta.method_name, error_message: code ? 'SYNTHETIC_SERVER_ERROR' : '' }, body: {} };
    metrics[code ? 'errorRpcReplies' : 'successfulRpcReplies']++;
    vm.runInContext('handleMessage(fixtureReply)', Object.assign(context, { fixtureReply: Buffer.from(JSON.stringify(response)) }));
  }
  async function stop() { network.stopNetwork('Synthetic fixture cleanup'); await later(); assert.equal(state().pending, 0); if (state().active !== null) assert.equal(state().active, 0); assert.equal(timers.size, 0); }
  return { name, network, governor, socket, config, transmissions, attempts, events, logs, metrics, state, at, respond, stop,
    advanceOnly(ms) { assert.ok(baseNow + ms >= now); now = baseNow + ms; }, jumpWall(ms) { wallOffset += ms; }, setEncrypt(fn) { cryptoWasm.encryptBuffer = fn; }, setPauseReader(fn) { store.getWirePauseRemainMs = fn; }, blockRuntimeInit() { let release; const promise = new Promise(resolve => { release = resolve; }); runtimeInit = { promise, release }; }, releaseRuntimeInit() { runtimeInit.release(); }, run(expression) { return vm.runInContext(expression, context); }, getSockets: () => sockets, setReplies(fn) { replyPolicy = fn; }, setPause(ms) { pauseMs = ms; },
    blockEncoding() { let release; const promise = new Promise(resolve => { release = resolve; }); blockedEncoding = { promise, release }; },
    async releaseEncoding() { const block = blockedEncoding; blockedEncoding = null; block.release(); await later(); },
  };
}

const service = 'gamepb.userpb.UserService';
const body = Buffer.from('{}');
function frame(row) { return { meta: { client_seq: row.sequence, service_name: service, method_name: row.method } }; }
async function fixture(callback) {
  const h = createHarness('request-lifecycle');
  try { await callback(h); } finally { await h.stop(); }
}

test('preparation within the original deadline sends once and receives success', () => fixture(async h => {
  h.blockEncoding(); h.setReplies(value => h.respond(value));
  const pending = h.network.sendMsgAsync(service, 'Read', body);
  await h.at(10000); assert.equal(h.transmissions.length, 0);
  await h.releaseEncoding(); await pending;
  assert.equal(h.transmissions.length, 1); assert.equal(h.state().pending, 0);
}));

test('expired preparation never sends late and the next heartbeat can recover', () => fixture(async h => {
  h.blockEncoding(); h.setReplies(value => h.respond(value)); await h.at(25000);
  await h.at(46000); await h.releaseEncoding();
  assert.equal(h.transmissions.length, 0, 'expired encoded heartbeat must not reach the socket');
  assert.equal(h.state().pending, 0); assert.equal(h.state().lastHeartbeatResponse, baseNow);
  await h.at(50000); assert.equal(h.transmissions.length, 1);
  assert.equal(h.state().lastHeartbeatResponse, baseNow + 50000);
}));

test('absolute deadline rejects late encoding even when the timeout task has not run', () => fixture(async h => {
  h.blockEncoding(); h.setReplies(value => h.respond(value)); let error;
  const pending = h.network.sendMsgAsync(service, 'Read', body).catch(value => { error = value; });
  h.advanceOnly(21000); await h.releaseEncoding(); await pending;
  assert.equal(error?.code, 'LOCAL_REQUEST_TIMEOUT'); assert.equal(h.transmissions.length, 0);
}));

test('synchronous final authority work cannot extend the original request deadline', () => fixture(async h => {
  let checks = 0;
  h.network.setSessionTransportHooks({ assertSend() { if (++checks === 3) h.advanceOnly(21000); } });
  h.setReplies(value => h.respond(value));
  let error; await h.network.sendMsgAsync(service, 'Read', body).catch(value => { error = value; });
  assert.equal(error?.code, 'LOCAL_REQUEST_TIMEOUT'); assert.equal(h.transmissions.length, 0);
}));

test('a successful reply after the deadline cannot beat an unprocessed timeout task', () => fixture(async h => {
  let error;
  const pending = h.network.sendMsgAsync(service, 'Read', body).catch(value => { error = value; });
  await later(); h.advanceOnly(21000); h.respond(frame(h.transmissions[0])); await pending;
  assert.equal(error?.code, 'LOCAL_REQUEST_TIMEOUT'); assert.equal(h.state().pending, 0);
}));

test('wall clock changes do not consume or extend a monotonic request deadline', () => fixture(async h => {
  h.blockEncoding(); h.setReplies(value => h.respond(value));
  const pending = h.network.sendMsgAsync(service, 'Read', body);
  h.advanceOnly(10000); h.jumpWall(86400000); await h.releaseEncoding(); await pending;
  assert.equal(h.transmissions.length, 1);
}));

test('stop immediately settles an unresolved preparation and its later completion cannot send', () => fixture(async h => {
  h.blockEncoding(); let settled = false;
  const pending = h.network.sendMsgAsync(service, 'Read', body).catch(() => { settled = true; });
  h.network.stopNetwork('synthetic stop'); await later();
  assert.equal(settled, true, 'stop must settle before encryption completes');
  await h.releaseEncoding(); await pending; assert.equal(h.transmissions.length, 0);
}));

test('cleanup settles preparations before clearing their timers', () => fixture(async h => {
  h.blockEncoding(); let settled = false;
  const pending = h.network.sendMsgAsync(service, 'Read', body).catch(() => { settled = true; });
  h.network.cleanup('synthetic cleanup'); await later(); assert.equal(settled, true);
  await h.releaseEncoding(); await pending; assert.equal(h.transmissions.length, 0);
}));

test('an encoded request stays bound to its original socket', () => fixture(async h => {
  h.blockEncoding(); h.setReplies(value => h.respond(value)); let rejected = false;
  const pending = h.network.sendMsgAsync(service, 'Read', body).catch(() => { rejected = true; });
  h.network.connect('SYNTHETIC_ONLY', () => {}); await h.releaseEncoding(); await pending;
  assert.equal(rejected, true); assert.equal(h.transmissions.length, 0);
}));

test('authority revocation after encoding still rejects without sending', () => fixture(async h => {
  h.blockEncoding(); let revoked = false;
  h.network.setSessionTransportHooks({ assertSend() { if (revoked) throw Object.assign(new Error('retired'), { code: 'SESSION_EPOCH_RETIRED' }); } });
  let error; const pending = h.network.sendMsgAsync(service, 'Read', body).catch(value => { error = value; });
  revoked = true; await h.releaseEncoding(); await pending;
  assert.equal(error?.code, 'SESSION_EPOCH_RETIRED'); assert.equal(h.transmissions.length, 0);
}));

test('synchronous reentry keeps each request timer and response associated with itself', () => fixture(async h => {
  let checks = 0; let inner; let outerError;
  h.network.setSessionTransportHooks({ assertSend(_service, method) {
    if (method === 'Outer' && ++checks === 2) inner = h.network.sendMsgAsync(service, 'Inner', body, 40000).catch(error => error);
  } });
  const outer = h.network.sendMsgAsync(service, 'Outer', body).catch(error => { outerError = error; });
  await later(); assert.equal(h.transmissions.length, 2);
  await h.at(21000); assert.equal(outerError?.code, 'LOCAL_REQUEST_TIMEOUT');
  h.respond(frame(h.transmissions.find(row => row.method === 'Inner'))); await inner; await outer;
  assert.equal(h.state().pending, 0);
}));

test('concurrent encoding still respects the final shared pending limit', () => fixture(async h => {
  h.blockEncoding(); const pending = [];
  for (let i = 0; i < 11; i++) pending.push(h.network.sendMsgAsync(service, 'Read', body).catch(error => error));
  await h.releaseEncoding(); assert.equal(h.transmissions.length, 10); assert.equal(h.state().pending, 10);
  for (const row of h.transmissions) h.respond(frame(row));
  const results = await Promise.all(pending);
  assert.equal(results.filter(value => value instanceof Error || /请求队列已满/.test(value?.message || '')).length, 1);
}));

test('explicit custom response timeouts retain their own total deadline', () => fixture(async h => {
  h.blockEncoding(); h.setReplies(value => h.respond(value));
  const pending = h.network.sendMsgAsync(service, 'Read', body, 40000);
  h.advanceOnly(30000); await h.releaseEncoding(); await pending; assert.equal(h.transmissions.length, 1);
}));

test('direct Login does not acquire an unintended 20 second response timeout', () => fixture(async h => {
  let calls = 0;
  await h.network.sendMsg(service, 'Login', body, error => { assert.equal(error == null, true); calls++; });
  h.advanceOnly(50000); h.respond(frame(h.transmissions[0])); await later(); assert.equal(calls, 1);
}));

test('cleanup after resolve prevents a queued old heartbeat continuation updating the new lifecycle', () => fixture(async h => {
  await h.at(25000); assert.equal(h.transmissions.length, 1);
  h.respond(frame(h.transmissions[0])); h.network.cleanup('before success continuation'); await later();
  assert.equal(h.state().lastHeartbeatResponse, baseNow);
}));

test('late events from an old socket cannot close or mutate the current connection', () => fixture(async h => {
  h.network.connect('SYNTHETIC_ONLY', () => {}); const first = h.network.getWs();
  const oldClose = first.listeners('close')[0]; const oldError = first.listeners('error')[0]; const oldOpen = first.listeners('open')[0];
  h.network.connect('SYNTHETIC_ONLY', () => {}); const current = h.network.getWs();
  oldClose(1006); oldError(new Error('Unexpected server response: 400')); await oldOpen();
  assert.equal(h.network.getWs(), current); assert.equal(current.readyState, 1); assert.equal(h.network.getWsErrorState().code, 0);
}));


test('final pause inspection cannot spend past the original deadline and then send', () => fixture(async h => {
  let checks = 0;
  h.setPauseReader(() => { if (++checks === 3) h.advanceOnly(21000); return 0; });
  h.setReplies(value => h.respond(value)); let error;
  await h.network.sendMsgAsync(service, 'Read', body).catch(value => { error = value; });
  assert.equal(error?.code, 'LOCAL_REQUEST_TIMEOUT'); assert.equal(h.transmissions.length, 0);
}));

test('direct requests without callbacks do not retain a pending response slot', () => fixture(async h => {
  assert.equal(await h.network.sendMsg(service, 'Read', body), true);
  assert.equal(h.state().pending, 0); if (h.state().active !== null) assert.equal(h.state().active, 0);
}));

test('a callback reentering during cleanup cannot leave another preparing request alive', () => fixture(async h => {
  h.blockEncoding(); let cancelled = 0; let nestedRejected = false;
  h.network.sendMsg(service, 'Login', body, () => {
    cancelled++; h.network.sendMsgAsync(service, 'Read', body).catch(() => { nestedRejected = true; });
  });
  h.network.cleanup('reentrant cleanup'); await later();
  assert.equal(cancelled, 1); assert.equal(nestedRejected, true);
  await h.releaseEncoding(); assert.equal(h.transmissions.length, 0);
}));

test('encoding failure settles once without sending or retaining response state', () => fixture(async h => {
  let recorded = 0;
  const original = h.governor.recordSent;
  h.governor.recordSent = function(...args) { recorded++; return Reflect.apply(original, this, args); };
  h.setEncrypt(async () => { throw new Error('synthetic encryption failure'); });
  await assert.rejects(h.network.sendMsgAsync(service, 'Read', body), /synthetic encryption failure/);
  assert.equal(h.transmissions.length, 0); assert.equal(h.state().pending, 0); assert.equal(recorded, 0);
}));

test('business-error breaker exemption remains separate from transport timeouts', () => fixture(async h => {
  const results = []; const original = h.governor.recordSent;
  h.governor.recordSent = function(...args) { results.push(args); return Reflect.apply(original, this, args); };
  h.setReplies(value => h.respond(value, 12345));
  await assert.rejects(h.network.sendMsgAsync(service, 'Read', body, 20000, { breakerExemptBusinessError: true }), /12345/);
  assert.equal(results.length, 1); assert.equal(results[0][2], false); assert.equal(results[0][4].breakerExempt, true);
}));

test('an old open initialization finishing after a socket replacement never sends a new Login', () => fixture(async h => {
  h.config.tsdkAceEnabled = true; h.blockRuntimeInit();
  h.network.connect('SYNTHETIC_ONLY', () => {}); const first = h.network.getWs();
  const opening = first.listeners('open')[0](); await later();
  h.network.connect('SYNTHETIC_ONLY', () => {}); const current = h.network.getWs();
  h.releaseRuntimeInit(); await opening;
  assert.equal(h.network.getWs(), current); assert.equal(h.transmissions.length, 0);
}));

test('an overdue nonzero reply is a timeout and cannot use business-error exemption', () => fixture(async h => {
  const results = [];
  const original = h.governor.recordSent;
  h.governor.recordSent = function(...args) { results.push(args); return Reflect.apply(original, this, args); };
  let error;
  const pending = h.network.sendMsgAsync(service, 'Read', body, 20000, { breakerExemptBusinessError: true }).catch(value => { error = value; });
  await later(); h.advanceOnly(21000); h.respond(frame(h.transmissions[0]), 12345); await pending;
  assert.equal(error?.code, 'LOCAL_REQUEST_TIMEOUT'); assert.equal(results.length, 1);
  assert.equal(results[0][2], false); assert.equal(results[0][4].breakerExempt, false);
}));


test('a governor-rejected request does not consume a protocol sequence before heartbeat', () => fixture(async h => {
  for (let i = 0; i < h.governor.TOTAL_LIMIT; i++) h.governor.recordSent('synthetic.Business', 'Read', true, baseNow);
  await assert.rejects(h.network.sendMsgAsync('synthetic.Business', 'Read', body), /budget_total/);
  h.setReplies(value => h.respond(value)); await h.at(25000);
  assert.equal(h.transmissions.length, 1); assert.equal(h.transmissions[0].method, 'Heartbeat');
  assert.equal(h.transmissions[0].sequence, 1); assert.equal(h.state().lastHeartbeatResponse, baseNow + 25000);
}));

test('permission and quiet rejection leave the next transmitted protocol sequence unchanged', () => fixture(async h => {
  h.network.setSessionTransportHooks({ assertSend() { throw Object.assign(new Error('retired'), { code: 'SESSION_EPOCH_RETIRED' }); } });
  await assert.rejects(h.network.sendMsgAsync(service, 'Read', body), /retired/);
  h.network.setSessionTransportHooks(null); h.setPause(60000);
  await assert.rejects(h.network.sendMsgAsync(service, 'Read', body), { code: 'LOCAL_BUSINESS_PAUSED' });
  h.setPause(0); h.setReplies(value => h.respond(value)); await h.network.sendMsgAsync(service, 'Read', body);
  assert.equal(h.transmissions.length, 1); assert.equal(h.transmissions[0].sequence, 1);
}));

test('a preparation that expires without transmission does not leave a protocol hole', () => fixture(async h => {
  h.blockEncoding(); const cancelled = h.network.sendMsgAsync(service, 'Slow', body, 1000).catch(error => error);
  await h.at(2000); await h.releaseEncoding(); await cancelled;
  h.setReplies(value => h.respond(value)); await h.network.sendMsgAsync(service, 'Read', body);
  assert.equal(h.transmissions.length, 1); assert.equal(h.transmissions[0].sequence, 1);
}));

test('a slow internal request expiring cannot delete a faster request using its first wire sequence', () => fixture(async h => {
  let release;
  h.setEncrypt(bytes => bytes.toString() === 'slow' ? new Promise(resolve => { release = () => resolve(bytes); }) : Promise.resolve(bytes));
  const slow = h.network.sendMsgAsync(service, 'Slow', Buffer.from('slow'), 1000).catch(error => error);
  const fast = h.network.sendMsgAsync(service, 'Fast', body, 40000).catch(error => error);
  await later(); assert.equal(h.transmissions.length, 1); assert.equal(h.transmissions[0].sequence, 1);
  await h.at(2000); assert.equal(h.state().pending, 1, 'expiry of an unsent internal id cannot erase wire1');
  h.respond(frame(h.transmissions[0])); const reply = await fast; assert.equal(reply.meta.method_name, 'Fast');
  release(); await later(); await slow; assert.equal(h.transmissions.length, 1);
}));

test('reverse preparation completion keeps each response associated with its actual wire sequence', () => fixture(async h => {
  let release;
  h.setEncrypt(bytes => bytes.toString() === 'slow' ? new Promise(resolve => { release = () => resolve(bytes); }) : Promise.resolve(bytes));
  const slow = h.network.sendMsgAsync(service, 'Slow', Buffer.from('slow'), 40000).catch(error => error);
  const fast = h.network.sendMsgAsync(service, 'Fast', body, 40000).catch(error => error);
  await later(); assert.equal(h.transmissions[0].sequence, 1); h.respond(frame(h.transmissions[0]));
  assert.equal((await fast).meta.method_name, 'Fast'); release(); await later();
  assert.equal(h.transmissions[1].sequence, 2); h.respond(frame(h.transmissions[1]));
  assert.equal((await slow).meta.method_name, 'Slow'); assert.equal(h.state().pending, 0);
}));

test('final pending-capacity rejection does not consume the next heartbeat wire sequence', () => fixture(async h => {
  h.blockEncoding(); const pending = [];
  for (let i = 0; i < 11; i++) pending.push(h.network.sendMsgAsync(service, 'Read', body).catch(error => error));
  await h.releaseEncoding(); assert.equal(h.transmissions.length, 10);
  assert.deepEqual(h.transmissions.map(row => row.sequence), Array.from({ length: 10 }, (_, i) => i + 1));
  for (const row of h.transmissions) h.respond(frame(row)); await Promise.all(pending);
  h.setReplies(value => h.respond(value)); await h.at(25000); assert.equal(h.transmissions.at(-1).sequence, 11);
}));

test('a socket send attempt is never assigned a reused protocol sequence after an exception', () => fixture(async h => {
  const original = h.socket.send;
  h.socket.send = () => { throw new Error('synthetic uncertain write'); };
  await assert.rejects(h.network.sendMsgAsync(service, 'Read', body), /synthetic uncertain write/);
  h.socket.send = original; h.setReplies(value => h.respond(value)); await h.network.sendMsgAsync(service, 'Read', body);
  assert.equal(h.transmissions.length, 1); assert.equal(h.transmissions[0].sequence, 2);
}));

test('reentrant governor rejection preserves both timer identity and later heartbeat sequence', () => fixture(async h => {
  for (let i = 0; i < h.governor.TOTAL_LIMIT; i++) h.governor.recordSent('synthetic.Business', 'Read', true, baseNow);
  let reentered = false; let rejected;
  h.network.setSessionTransportHooks({ assertSend(_service, method) {
    if (method === 'Heartbeat' && !reentered) { reentered = true; rejected = h.network.sendMsgAsync('synthetic.Business', 'Read', body).catch(error => error); }
  } });
  h.setReplies(value => h.respond(value)); await h.at(25000); await rejected; await h.at(50000);
  assert.deepEqual(h.transmissions.map(row => row.sequence), [1, 2]);
}));

test('active slowdown and exhausted business budget keep successful maintenance heartbeats running', () => fixture(async h => {
  for (let i = 0; i < 12; i++) h.governor.recordSent('synthetic.Business', 'Read', false, baseNow);
  for (let i = 12; i < h.governor.TOTAL_LIMIT; i++) h.governor.recordSent('synthetic.Business', 'Read', true, baseNow);
  assert.equal(h.governor.getBreakerState(baseNow).active, true);
  assert.equal(h.governor.checkRequest('synthetic.Business', 'Read', baseNow).allowed, false);
  h.setReplies(value => h.respond(value)); await h.at(75000);
  assert.equal(h.transmissions.length, 3); assert.equal(h.metrics.closeCalls, 0);
  assert.equal(h.state().lastHeartbeatResponse, baseNow + 75000);
  assert.equal(h.governor.getBreakerState(baseNow + 75000).active, true);
}));

test('an inbound blackhole after a healthy heartbeat reproduces50/75/100s without a governor send denial', () => fixture(async h => {
  for (let i = 0; i < 12; i++) h.governor.recordSent('synthetic.Business', 'Read', false, baseNow);
  let replied = false;
  h.setReplies(value => { if (!replied) { replied = true; h.respond(value); } });
  await h.at(125000);
  assert.equal(h.metrics.successfulRpcReplies, 1);
  assert.deepEqual(h.transmissions.filter(row => row.method === 'Heartbeat').map(row => row.atMs), [25000, 50000, 75000, 100000]);
  const warnings = h.logs.filter(row => row.message.includes('miss='));
  assert.deepEqual(warnings.map(row => row.message.match(/\((\d+)s/)[1]), ['50', '75', '100']);
  assert.equal(h.events.filter(row => row.code === 'heartbeat_timeout').length, 1);
}));
