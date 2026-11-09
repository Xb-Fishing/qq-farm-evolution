const test = require('node:test'); const assert = require('node:assert/strict');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const vm = require('node:vm'); const { EventEmitter } = require('node:events'); const { createRequire } = require('node:module');
const prefix = path.resolve(os.tmpdir(), 'session-manager-recovery-'); assert.equal(path.dirname(prefix), path.resolve(os.tmpdir()));
const temporary = fs.mkdtempSync(prefix); process.env.FARM_DATA_DIR = temporary;
const codec = require('../src/runtime/session-codec');
test.after(() => fs.rmSync(temporary, { recursive: true, force: true }));

// 手动时钟：只驱动被 VM 加载源码的计时器边界，不依赖真实等待。
function createManualClock() {
  let now = 0; let sequence = 0; const timers = new Map();
  const settle = async () => { for (let i = 0; i < 40; i += 1) await Promise.resolve(); };
  return {
    now: () => now,
    setTimeout(callback, delay) {
      const id = ++sequence; timers.set(id, { callback, at: now + Math.max(0, Number(delay) || 0) }); return id;
    },
    clearTimeout(id) { timers.delete(id); },
    async advance(ms) {
      const target = now + Math.max(0, ms);
      for (;;) {
        let due = null;
        for (const [id, timer] of timers) if (timer.at <= target && (due === null || timer.at < timers.get(due).at)) due = id;
        if (due === null) break;
        const timer = timers.get(due); timers.delete(due); now = Math.max(now, timer.at);
        timer.callback(); await settle();
      }
      now = target;
    }
  };
}

// 合成 RPC 传输骨架：真实 session-rpc/session-codec 源文件由 fixture 装进
// manager 所在的同一 VM realm（codec 的对象原型检查不能跨 realm），只有
// net 与计时器边界被替换为 EventEmitter socket + 手动时钟；不触真实网络/文件。
function createSyntheticRpcTransport(settings = {}) {
  const clock = createManualClock();
  const descriptor = { socketPath: '/synthetic/session-recovery-probe.sock', capability: 'synthetic-probe-capability',
    hostId: 'synthetic-probe-host', pid: 424242, starttime: '42', contractVersion: 1,
    sourceRoot: '/synthetic/source-root', sourceCommit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    sourceFingerprint: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' };
  const frames = [];
  const socket = new EventEmitter();
  Object.assign(socket, { destroyed: false, writable: true,
    write(buffer) {
      frames.push(buffer);
      const request = codec.decode(buffer.subarray(4));
      if (settings.answerHello && request.method === 'hello') {
        const payload = codec.encode({ id: request.id, value: { hostId: descriptor.hostId, pid: descriptor.pid,
          starttime: descriptor.starttime, contractVersion: descriptor.contractVersion, sourceRoot: descriptor.sourceRoot,
          sourceCommit: descriptor.sourceCommit, sourceFingerprint: descriptor.sourceFingerprint } });
        const header = Buffer.alloc(4); header.writeUInt32BE(payload.length);
        Promise.resolve().then(() => { if (!socket.destroyed) socket.emit('data', Buffer.concat([header, payload])); });
      }
      return true;
    },
    destroy() {
      if (socket.destroyed) return; socket.destroyed = true; socket.writable = false; socket.emit('close');
    } });
  const net = { createConnection: () => {
    Promise.resolve().then(() => { if (!socket.destroyed) socket.emit('connect'); }); return socket;
  } };
  return { clock, socket, net, descriptor, frames, codecModule: { exports: {} }, rpcModule: { exports: {} },
    SessionRpcClient: null,
    requests: () => frames.map(frame => codec.decode(frame.subarray(4))) };
}

function fixture(options = {}) {
  const filename = path.resolve(__dirname, '../src/runtime/worker-manager.js'); const native = createRequire(filename);
  const account = { id: 'synthetic-recovery', name: 'Example account', code: 'synthetic-code', platform: 'wx', autoLogin: true };
  const tasks = new Map(); const intervals = new Map(); const logs = []; let reloads = 0; let stops = 0; let forks = 0; let release;
  let created = 0; let lookups = 0; let attachFailures = options.attachFailures || 0;
  const connectOptions = []; const statusCalls = []; let clientCloses = 0;
  const gates = { connect: { entered: false, release: null }, status: { entered: false, resolve: null, reject: null } };
  const rpcTransport = options.rpcTransport ? createSyntheticRpcTransport(options.rpcTransport) : null;
  const proc = new EventEmitter(); proc.persistentSession = true; proc.businessInitialized = true; proc.ready = Promise.resolve();
  proc.sessionFacts = { sequence: 1, host: { hostId: 'synthetic-host', starttime: '1' },
    game: { connected: true, terminal: false, connectionEpoch: 7, loginEpoch: 1, firstLoginReadyAt: 123 },
    business: { ready: false, epoch: 'synthetic-failed' } };
  proc.send = () => {}; proc.kill = async () => { stops++; }; proc.detach = async () => {};
  proc.refreshSession = async () => ({ facts: proc.sessionFacts });
  proc.reloadBusiness = async () => {
    reloads++;
    if (options.wait) await new Promise(resolve => { release = resolve; });
    if (options.fail) throw new Error('SYNTHETIC_SECRET reload failure');
    proc.sessionFacts = { ...proc.sessionFacts, business: { ready: true, epoch: `synthetic-restored-${reloads}` } };
    return { facts: proc.sessionFacts };
  };
  const originalRefresh = proc.refreshSession;
  if (options.initialAttachFailure) {
    proc.businessInitialized = false; proc.attachFailed = true; proc.recoverableAttach = options.initialAttachFailure !== 'unverified';
    proc.ready = Promise.reject(new Error('synthetic first management attach failure')); proc.ready.catch(() => {});
  }
  if (options.controlDrop) proc.refreshSession = async () => { throw new Error('SYNTHETIC_SECRET closed control socket'); };
  const createProxy = settings => {
    created++;
    if (created === 1) return proc;
    assert.equal(settings.adoptOnly, true, 'recovery cannot create a host');
    const next = new EventEmitter(); Object.assign(next, { persistentSession: true, businessInitialized: false, exitCode: null,
      sessionFacts: proc.sessionFacts, send() {}, detach: async () => {}, kill: async () => { stops++; } });
    next.ready = Promise.resolve().then(() => {
      if (attachFailures-- > 0) throw new Error('synthetic temporary attach failure');
      next.businessInitialized = true;
      next.sessionFacts = { ...proc.sessionFacts, business: { ready: true, epoch: `synthetic-reattached-${created}` } };
    });
    next.ready.catch(() => {});
    next.refreshSession = async () => { await next.ready; return { facts: next.sessionFacts }; };
    return next;
  };
  const registry = { ...native('./session-registry'), ...(options.lookupState ? { lockIsHeld: () => options.lockHeld === true, processIsLive: () => false } : {}), connectSession: async (_dataDir, _account, connectOption) => {
    lookups++;
    connectOptions.push(connectOption);
    if (options.lookupState) return { state: options.lookupState };
    if (rpcTransport) {
      const client = new rpcTransport.SessionRpcClient(rpcTransport.descriptor, connectOption);
      try { const hello = await client.connect(); return { state: 'present', client, hello }; }
      catch { client.close(); return { state: 'unknown' }; }
    }
    if (options.connectHang) return new Promise(resolve => { gates.connect.entered = true; gates.connect.release = resolve; });
    if (lookups <= (options.lookupFailures || 0)) throw new Error('SYNTHETIC_SECRET control discovery failure');
    return { state: 'present', client: {
      call: (method, args, timeout) => {
        statusCalls.push({ method, args, timeout });
        if (options.statusHang) return new Promise((resolve, reject) => { gates.status.entered = true; gates.status.resolve = resolve; gates.status.reject = reject; });
        if (options.statusReject) return Promise.reject(new Error('SYNTHETIC_SECRET status rejected'));
        return originalRefresh();
      },
      close() { clientCloses++; } } };
  } };
  const scheduler = { setTimeoutTask: (name, _ms, callback) => tasks.set(name, callback), clear: name => tasks.delete(name),
    clearAll: () => { tasks.clear(); intervals.clear(); }, setIntervalTask: (name, _ms, callback) => intervals.set(name, callback) };
  const module = { exports: {} };
  const sandbox = { module, exports: module.exports, process, Buffer, console,
    require: name => name === '../services/scheduler' ? { createScheduler: () => scheduler }
      : name === './session-worker-proxy' ? { createSessionWorkerProxy: createProxy, replayLifecycle: async () => {} }
        : name === './session-registry' ? registry
          : name === 'node:net' && rpcTransport ? rpcTransport.net : native(name) };
  if (rpcTransport) {
    sandbox.setTimeout = rpcTransport.clock.setTimeout; sandbox.clearTimeout = rpcTransport.clock.clearTimeout;
  }
  const context = vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(filename, 'utf8'), context, { filename });
  if (rpcTransport) {
    // session-codec/session-rpc 必须与 manager 同 realm：跨 realm 的 args 字面量
    // 会被 codec 的原型检查拒绝，只有在生产同进程结构下才等价。
    const loadRealmModule = (source, moduleObject, moduleFilename) => {
      const wrapper = vm.runInContext(`(function (module, exports, require) {\n${  source  }\n})`, context, { filename: moduleFilename });
      wrapper(moduleObject, moduleObject.exports,
        name => name === './session-codec' ? rpcTransport.codecModule.exports : sandbox.require(name));
    };
    const codecFilename = path.resolve(__dirname, '../src/runtime/session-codec.js');
    const rpcFilename = path.resolve(__dirname, '../src/runtime/session-rpc.js');
    loadRealmModule(fs.readFileSync(codecFilename, 'utf8'), rpcTransport.codecModule, codecFilename);
    loadRealmModule(fs.readFileSync(rpcFilename, 'utf8'), rpcTransport.rpcModule, rpcFilename);
    rpcTransport.SessionRpcClient = rpcTransport.rpcModule.exports.SessionRpcClient;
  }
  const workers = {}; const manager = module.exports.createWorkerManager({ runtimeMode: 'persistent', processRef: { pkg: false, env: {} },
    mainEntryPath: '/synthetic/core/client.js', workerScriptPath: '', workers, globalLogs: [], fork: () => { forks++; },
    store: { ensureAccountSessionMetadata: () => account }, getAccounts: () => ({ accounts: [account] }),
    log: (tag, msg, meta) => {
      logs.push({ tag, msg, meta });
      if (options.diagnosticSinkFailure && meta?.event === 'session_control_recovery_failed') throw new Error('SYNTHETIC_SECRET diagnostic sink failure');
    }, addAccountLog() {}, normalizeStatusForPanel: value => value,
    buildConfigSnapshotForAccount: () => ({}), scheduleAccountRefresh() {}, stopAccountRefresh() {} });
  const takeRecovery = async () => {
    const name = `session_business_recovery_${account.id}`; const callback = tasks.get(name); tasks.delete(name);
    if (callback) await callback();
    return Boolean(callback);
  };
  const startRecovery = () => {
    const name = `session_business_recovery_${account.id}`; const callback = tasks.get(name); tasks.delete(name);
    return { started: Boolean(callback), promise: callback ? callback() : Promise.resolve() };
  };
  const settle = async () => { for (let i = 0; i < 40; i += 1) await Promise.resolve(); };
  const fail = () => proc.emit('error', Object.assign(new Error('synthetic event failure'), { code: 'SESSION_EVENT_DELIVERY_FAILED', phase: 'event_delivery' }));
  return { account, tasks, intervals, proc, workers, manager, logs, fail, takeRecovery, startRecovery, settle,
    connectOptions, statusCalls, clientCloses: () => clientCloses, gates, rpc: rpcTransport,
    counts: () => ({ reloads, stops, forks }), created: () => created, release: () => release?.() };
}

test('actual manager repairs the retired business once while preserving its host and credentials', async () => {
  const f = fixture(); await f.manager.startWorker(f.account); f.fail(); f.fail();
  await f.takeRecovery();
  assert.equal(f.counts().reloads, 1, 'runtime fault must reach the existing adopt/reload path');
  assert.equal(f.counts().stops, 0); assert.equal(f.counts().forks, 0);
  assert.equal(f.proc.sessionFacts.game.connectionEpoch, 7); assert.equal(f.account.code, 'synthetic-code');
  assert.equal(f.proc.sessionFacts.business.ready, true);
  assert.ok(f.logs.some(row => row.meta.event === 'session_business_recovered'));
  assert.equal(f.logs.some(row => row.msg.includes('子进程启动失败')), false);
  await f.manager.detachAll();
});

test('quiet/no-op, offline state and a disabled account never trigger business recovery or a fresh login', async () => {
  for (const mode of ['healthy', 'offline', 'disabled']) {
    const f = fixture(); await f.manager.startWorker(f.account);
    if (mode === 'healthy') f.proc.sessionFacts.business.ready = true;
    if (mode === 'offline') f.proc.sessionFacts.game.connected = false;
    if (mode === 'disabled') f.account.autoLogin = false;
    f.fail(); await f.takeRecovery();
    assert.deepEqual(f.counts(), { reloads: 0, stops: 0, forks: 0 });
    await f.manager.detachAll();
  }
});

test('failed repair retains the record, retries within a host budget and never stops the account', async () => {
  const f = fixture({ fail: true }); await f.manager.startWorker(f.account); f.fail();
  for (let i = 0; i < 4; i++) await f.takeRecovery();
  assert.equal(f.counts().reloads, 3); assert.equal(f.counts().stops, 0); assert.equal(f.workers[f.account.id].stopping, false);
  f.fail(); await f.takeRecovery(); assert.equal(f.counts().reloads, 3);
  await f.manager.detachAll();
});

test('owner stop, rebinding or management detach cancels delayed repair', async () => {
  for (const mode of ['disabled', 'generation', 'detach']) {
    const f = fixture(); await f.manager.startWorker(f.account); f.fail();
    if (mode === 'disabled') f.account.autoLogin = false;
    if (mode === 'generation') f.account.credentialGeneration = 'synthetic-new-generation';
    if (mode === 'detach') await f.manager.detachAll();
    await f.takeRecovery(); assert.equal(f.counts().reloads, 0); assert.equal(f.counts().stops, 0);
    await f.manager.detachAll();
  }
});

test('persistent watchdog reuses business recovery without placing the online account into legacy stop state', async () => {
  const f = fixture(); await f.manager.startWorker(f.account);
  f.workers[f.account.id].lastPongAt = 0;
  await f.intervals.get('watchdog_tick')(); await f.takeRecovery();
  assert.equal(f.counts().reloads, 1); assert.equal(f.workers[f.account.id].stopping, false); assert.equal(f.counts().stops, 0);
  await f.manager.detachAll();
});

test('lost control reattaches adopt-only and retries its own failed replacement without losing ownership', async () => {
  const f = fixture({ controlDrop: true, attachFailures: 1 }); await f.manager.startWorker(f.account);
  f.proc.emit('session_unknown'); await f.takeRecovery();
  assert.equal(f.created(), 2); assert.equal(f.workers[f.account.id].stopping, false);
  await f.takeRecovery();
  assert.equal(f.created(), 3); assert.equal(f.workers[f.account.id].process.sessionFacts.business.ready, true);
  assert.ok(f.logs.some(row => row.meta.event === 'session_business_recovered'));
  assert.equal(f.counts().stops, 0); assert.equal(f.counts().forks, 0);
  await f.manager.detachAll();
});

test('control status read failure retains the original record for a bounded retry', async () => {
  const f = fixture({ controlDrop: true, lookupFailures: 1 }); await f.manager.startWorker(f.account);
  const original = f.workers[f.account.id]; f.proc.emit('session_unknown'); await f.takeRecovery();
  assert.equal(f.workers[f.account.id], original); assert.equal(f.created(), 1);
  await f.takeRecovery(); assert.equal(f.created(), 2);
  assert.ok(f.logs.some(row => row.meta.event === 'session_business_recovered')); assert.equal(f.counts().stops, 0);
  await f.manager.detachAll();
});

test('local diagnostic with legacy ready=true remains visibly pending until a real host event retires the epoch', async () => {
  const f = fixture(); await f.manager.startWorker(f.account);
  f.proc.sessionFacts.business.ready = true; f.proc.businessFaultEpoch = f.proc.sessionFacts.business.epoch;
  f.proc.emit('message', { type: 'session_business_diagnostic', data: { businessEpoch: f.proc.businessFaultEpoch, reason: 'SESSION_CONTROL_UNAVAILABLE' } });
  for (let i = 0; i < 7; i++) await f.takeRecovery();
  assert.equal(f.counts().reloads, 0); assert.equal(f.counts().stops, 0);
  assert.ok(f.logs.some(row => row.meta.event === 'session_business_recovery_pending'));
  assert.equal(f.logs.some(row => row.meta.event === 'session_business_recovered'), false);
  f.proc.sessionFacts.business.ready = false; f.fail(); await f.takeRecovery();
  assert.equal(f.counts().reloads, 1); assert.ok(f.logs.some(row => row.meta.event === 'session_business_recovered'));
  await f.manager.detachAll();
});

test('manual adoption recovers the existing business without creating a host or refreshing credentials', async () => {
  const f = fixture(); await f.manager.startWorker(f.account);
  const result = await f.manager.tryAdoptAccountSession(f.account, { connectedOnly: true, isCurrent: () => true });
  assert.equal(result.state, 'adopted'); assert.equal(result.facts.game.connected, true); assert.equal(result.facts.business.ready, true);
  assert.equal(result.facts.game.connectionEpoch, 7); assert.equal(result.facts.game.loginEpoch, 1);
  assert.equal(f.counts().stops, 0); assert.equal(f.counts().forks, 0);
  await f.manager.detachAll();
});

test('manual adoption discards old proxy results after ready, status or reload awaits', async () => {
  for (const stage of ['ready', 'status', 'reload']) {
    for (const change of ['record', 'process', 'stopping']) {
      const f = fixture(); await f.manager.startWorker(f.account);
      let release; let enter;
      const entered = new Promise(resolve => { enter = resolve; });
      const wait = new Promise(resolve => { release = resolve; });
      const oldFacts = structuredClone(f.proc.sessionFacts); oldFacts.business.ready = true;
      if (stage === 'ready') f.proc.ready = wait;
      if (stage === 'status') f.proc.refreshSession = async () => { enter(); await wait; return { facts: oldFacts }; };
      if (stage === 'reload') f.proc.reloadBusiness = async () => { enter(); await wait; return { facts: oldFacts }; };
      const pending = f.manager.tryAdoptAccountSession(f.account, { connectedOnly: true, isCurrent: () => true });
      if (stage === 'ready') await Promise.resolve();
      else await entered;
      const replacement = { persistentSession: true, detach: async () => {} };
      if (change === 'record') f.workers[f.account.id] = { process: replacement };
      if (change === 'process') f.workers[f.account.id].process = replacement;
      if (change === 'stopping') f.workers[f.account.id].stopping = true;
      release();
      assert.equal((await pending).state, 'cancelled', `${stage}:${change}`);
      assert.equal(f.counts().stops, 0); assert.equal(f.counts().forks, 0);
      await f.manager.detachAll();
    }
  }
});

test('a known local fault survives simultaneous control loss without a false healthy attach', async () => {
  const f = fixture({ controlDrop: true }); await f.manager.startWorker(f.account);
  f.proc.sessionFacts.business.ready = true; f.proc.businessFaultEpoch = f.proc.sessionFacts.business.epoch;
  f.proc.emit('message', { type: 'session_business_diagnostic', data: { businessEpoch: f.proc.businessFaultEpoch, reason: 'SESSION_CONTROL_UNAVAILABLE' } });
  f.proc.emit('session_unknown');
  for (let i = 0; i < 7; i++) await f.takeRecovery();
  assert.equal(f.created(), 1, 'legacy ready with a known fault cannot be reattached as healthy');
  assert.ok(f.logs.some(row => row.meta.event === 'session_business_recovery_pending'));
  f.proc.sessionFacts.business.ready = false; f.fail(); await f.takeRecovery();
  assert.equal(f.created(), 2); assert.ok(f.logs.some(row => row.meta.event === 'session_business_recovered'));
  assert.equal(f.counts().stops, 0); await f.manager.detachAll();
});

test('a failed initial management attach recovers the verified existing host without any cold start', async () => {
  const f = fixture({ initialAttachFailure: true, controlDrop: true }); assert.equal(await f.manager.startWorker(f.account), false);
  f.proc.emit('error', Object.assign(new Error('synthetic initial attach failure'), { code: 'SESSION_CONTROL_FAILED', phase: 'attach' }));
  await f.takeRecovery(); assert.equal(f.created(), 2);
  assert.ok(f.logs.some(row => row.meta.event === 'session_business_recovered'));
  assert.equal(f.counts().forks, 0); assert.equal(f.counts().stops, 0); await f.manager.detachAll();
});

test('an unverified initial attach has no recovery authority or cold-login fallback', async () => {
  const f = fixture({ initialAttachFailure: 'unverified' }); assert.equal(await f.manager.startWorker(f.account), false);
  f.proc.emit('error', Object.assign(new Error('synthetic admission failure'), { code: 'SESSION_CONTROL_FAILED', phase: 'attach' }));
  await f.takeRecovery(); assert.equal(f.created(), 1);
  assert.equal(f.counts().stops, 0); assert.equal(f.counts().forks, 0); await f.manager.detachAll();
});


test('only proven host absence retires a failed logical proxy, without a revoke or cold restart', async () => {
  for (const lockHeld of [false, true]) {
    const f = fixture({ initialAttachFailure: 'unverified', lookupState: 'absent', lockHeld });
    assert.equal(await f.manager.startWorker(f.account), false);
    const original = f.workers[f.account.id];
    const result = await f.manager.tryAdoptAccountSession(f.account.id);
    assert.equal(result.state, lockHeld ? 'unknown' : 'absent');
    assert.equal(f.workers[f.account.id], lockHeld ? original : undefined);
    assert.equal(f.counts().stops, 0); assert.equal(f.counts().forks, 0);
    await f.manager.detachAll();
  }
});

test('recovery bounds a silent control handshake to five seconds, closes the socket and reports the failed phase', async () => {
  const f = fixture({ controlDrop: true, rpcTransport: {} });
  await f.manager.startWorker(f.account);
  f.proc.emit('session_unknown');
  const run = f.startRecovery();
  assert.equal(run.started, true);
  try {
    await f.settle();
    assert.ok(f.rpc.requests().some(request => request.method === 'hello'), 'the real hello frame must be sent before waiting');
    assert.equal(f.rpc.socket.destroyed, false, 'encoding or transport failure must not masquerade as a timeout');
    await f.rpc.clock.advance(4999);
    assert.equal(f.rpc.socket.destroyed, false, 'the silent hello remains pending before its deadline');
    await f.rpc.clock.advance(1);
    assert.equal(f.rpc.socket.destroyed, true, 'a silent hello must end the probe at the five-second bound and close the socket');
    assert.deepEqual(f.connectOptions.filter(option => option && typeof option === 'object')
      .map(option => ({ connectTimeoutMs: option.connectTimeoutMs, handshakeTimeoutMs: option.handshakeTimeoutMs })),
    [{ connectTimeoutMs: 5000, handshakeTimeoutMs: 5000 }],
      'the recovery fallback must pass explicit five-second connect and handshake deadlines');
    await run.promise;
    const rows = f.logs.filter(row => row.meta?.event === 'session_control_recovery_failed');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].meta.phase, 'discover');
    assert.equal(rows[0].meta.attempt, 1);
    assert.equal(rows[0].meta.exhausted, false);
    assert.equal(f.counts().reloads, 0); assert.equal(f.counts().stops, 0);
  } finally {
    await f.rpc.clock.advance(200000);
    f.rpc.socket.destroy();
    await run.promise.catch(() => {});
  }
  await f.manager.detachAll();
});

test('a host answering hello but silent on status fails its own five-second status probe', async () => {
  const f = fixture({ controlDrop: true, rpcTransport: { answerHello: true } });
  await f.manager.startWorker(f.account);
  f.proc.emit('session_unknown');
  const run = f.startRecovery();
  assert.equal(run.started, true);
  try {
    await f.settle();
    assert.ok(f.rpc.requests().some(request => request.method === 'status'), 'the real status frame must be sent before waiting');
    assert.equal(f.rpc.socket.destroyed, false, 'a synchronous codec rejection is not a status timeout');
    await f.rpc.clock.advance(4999);
    assert.equal(f.rpc.socket.destroyed, false, 'the silent status remains pending before its deadline');
    await f.rpc.clock.advance(1);
    assert.equal(f.rpc.socket.destroyed, true, 'a silent status reply must end at the five-second bound and close the socket');
    assert.deepEqual(f.connectOptions.filter(option => option && typeof option === 'object')
      .map(option => ({ connectTimeoutMs: option.connectTimeoutMs, handshakeTimeoutMs: option.handshakeTimeoutMs })),
    [{ connectTimeoutMs: 5000, handshakeTimeoutMs: 5000 }]);
    await run.promise;
    const requests = f.rpc.requests();
    assert.ok(requests.some(request => request.method === 'hello'));
    assert.ok(requests.some(request => request.method === 'status'), 'the fallback must have issued its real status request');
    const rows = f.logs.filter(row => row.meta?.event === 'session_control_recovery_failed');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].meta.phase, 'status');
    assert.equal(rows[0].meta.attempt, 1);
  } finally {
    await f.rpc.clock.advance(200000);
    f.rpc.socket.destroy();
    await run.promise.catch(() => {});
  }
  await f.manager.detachAll();
});

test('the fallback status call carries the real five-second timeout and closes its temporary client on failure', async () => {
  const f = fixture({ controlDrop: true, statusReject: true });
  await f.manager.startWorker(f.account);
  f.proc.emit('session_unknown');
  await f.takeRecovery();
  assert.deepEqual(f.statusCalls.map(call => ({ method: call.method, timeout: call.timeout })),
    [{ method: 'status', timeout: 5000 }],
    'the fallback status request must be sent with the five-second probe deadline');
  assert.equal(f.clientCloses(), 1, 'a failed status probe must close its temporary control client');
  const rows = f.logs.filter(row => row.meta?.event === 'session_control_recovery_failed');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].meta.phase, 'status');
  assert.equal(f.counts().reloads, 0); assert.equal(f.counts().stops, 0); assert.equal(f.counts().forks, 0);
  await f.manager.detachAll();
});

test('a failing discovery cycle logs at most three bounded phase rows without identity or original errors', async () => {
  const f = fixture({ controlDrop: true, lookupFailures: 3 });
  await f.manager.startWorker(f.account);
  f.proc.emit('session_unknown');
  const ran = [];
  for (let i = 0; i < 4; i += 1) ran.push(await f.takeRecovery());
  assert.deepEqual(ran, [true, true, true, false], 'the fourth cycle must not run');
  const rows = f.logs.filter(row => row.meta?.event === 'session_control_recovery_failed');
  assert.deepEqual(rows.map(row => ({ phase: row.meta.phase, attempt: row.meta.attempt, exhausted: row.meta.exhausted })),
    [{ phase: 'discover', attempt: 1, exhausted: false },
      { phase: 'discover', attempt: 2, exhausted: false },
      { phase: 'discover', attempt: 3, exhausted: true }]);
  for (const row of rows) assert.deepEqual(Object.keys(row.meta).sort(), ['attempt', 'event', 'exhausted', 'phase'],
    'the bounded diagnostic must not carry account identity or error payloads');
  assert.equal(JSON.stringify(f.logs).includes('SYNTHETIC_SECRET'), false, 'original probe errors must stay out of logs');
  assert.equal(f.counts().reloads, 0); assert.equal(f.counts().stops, 0); assert.equal(f.counts().forks, 0);
  await f.manager.detachAll();
});

test('adopt-phase failures report the same bounded rows and stop after three attempts', async () => {
  const f = fixture({ fail: true });
  await f.manager.startWorker(f.account);
  f.fail();
  for (let i = 0; i < 4; i += 1) await f.takeRecovery();
  const rows = f.logs.filter(row => row.meta?.event === 'session_control_recovery_failed');
  assert.deepEqual(rows.map(row => ({ phase: row.meta.phase, attempt: row.meta.attempt, exhausted: row.meta.exhausted })),
    [{ phase: 'adopt', attempt: 1, exhausted: false },
      { phase: 'adopt', attempt: 2, exhausted: false },
      { phase: 'adopt', attempt: 3, exhausted: true }]);
  for (const row of rows) assert.deepEqual(Object.keys(row.meta).sort(), ['attempt', 'event', 'exhausted', 'phase']);
  assert.equal(JSON.stringify(f.logs).includes('SYNTHETIC_SECRET'), false);
  await f.manager.detachAll();
});

test('one failed probe followed by a successful fallback still recovers without extra failure rows', async () => {
  const f = fixture({ controlDrop: true, lookupFailures: 1 });
  await f.manager.startWorker(f.account);
  f.proc.emit('session_unknown');
  await f.takeRecovery();
  let rows = f.logs.filter(row => row.meta?.event === 'session_control_recovery_failed');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].meta.phase, 'discover');
  assert.equal(rows[0].meta.attempt, 1);
  assert.equal(rows[0].meta.exhausted, false);
  await f.takeRecovery();
  assert.ok(f.logs.some(row => row.meta.event === 'session_business_recovered'));
  rows = f.logs.filter(row => row.meta?.event === 'session_control_recovery_failed');
  assert.equal(rows.length, 1, 'a later successful probe adds no further failure rows');
  assert.equal(f.counts().stops, 0); assert.equal(f.counts().forks, 0);
  await f.manager.detachAll();
});

test('a throwing diagnostic sink cannot interrupt bounded retry cleanup or later recovery', async () => {
  const f = fixture({ controlDrop: true, lookupFailures: 3, diagnosticSinkFailure: true });
  await f.manager.startWorker(f.account);
  f.proc.emit('session_unknown');
  for (let i = 0; i < 3; i++) assert.equal(await f.takeRecovery(), true);
  assert.equal(await f.takeRecovery(), false, 'failed diagnostics cannot leave a fourth scheduled attempt');
  const rows = f.logs.filter(row => row.meta?.event === 'session_control_recovery_failed');
  assert.equal(rows.length, 3, 'every failure reaches the sink without preventing the remaining cleanup');
  f.proc.emit('session_unknown');
  assert.equal(await f.takeRecovery(), false, 'a throwing sink cannot reset the discovery hard budget');
  assert.equal(f.counts().stops, 0); assert.equal(f.counts().forks, 0);
  assert.equal(JSON.stringify(f.logs).includes('SYNTHETIC_SECRET'), false);
  await f.manager.detachAll();

  const restored = fixture({ controlDrop: true, lookupFailures: 1, diagnosticSinkFailure: true });
  await restored.manager.startWorker(restored.account);
  restored.proc.emit('session_unknown');
  await restored.takeRecovery(); await restored.takeRecovery();
  assert.ok(restored.logs.some(row => row.meta?.event === 'session_business_recovered'));
  assert.equal(restored.counts().stops, 0); assert.equal(restored.counts().forks, 0);
  await restored.manager.detachAll();
});

test('owner changes during a suspended probe stop scheduling without stale failure rows or reloads', async () => {
  for (const hang of ['connect', 'status', 'status-success']) {
    for (const change of ['disabled', 'generation', 'binding', 'record', 'process', 'detach']) {
      const f = fixture(hang === 'connect' ? { controlDrop: true, connectHang: true } : { controlDrop: true, statusHang: true });
      await f.manager.startWorker(f.account);
      f.proc.emit('session_unknown');
      const run = f.startRecovery();
      await f.settle();
      const gate = hang === 'connect' ? f.gates.connect : f.gates.status;
      assert.equal(gate.entered, true, `${hang} suspension must be reached before the ownership change`);
      if (change === 'disabled') f.account.autoLogin = false;
      if (change === 'generation') f.account.credentialGeneration = 'synthetic-new-generation';
      if (change === 'binding') f.account.sessionGeneration = 'synthetic-new-binding';
      if (change === 'record') f.workers[f.account.id] = { process: { persistentSession: true, detach: async () => {} }, stopping: false };
      if (change === 'process') f.workers[f.account.id].process = { persistentSession: true, detach: async () => {} };
      if (change === 'detach') await f.manager.detachAll();
      let lateCalls = 0; let lateCloses = 0;
      if (hang === 'connect') f.gates.connect.release({ state: 'present', client: {
        call: () => { lateCalls++; return { facts: f.proc.sessionFacts }; }, close() { lateCloses++; },
      } });
      else if (hang === 'status-success') f.gates.status.resolve({ facts: f.proc.sessionFacts });
      else f.gates.status.reject(new Error('SYNTHETIC_SECRET status rejected after owner change'));
      await run.promise;
      if (hang === 'connect') {
        assert.equal(lateCalls, 0, `${change} must not authorize a late status request`);
        assert.equal(lateCloses, 1, `${change} must close the late temporary client`);
      } else assert.equal(f.clientCloses(), 1, `${change} must close the rejected status client`);
      assert.equal(f.logs.filter(row => row.meta?.event === 'session_control_recovery_failed').length, 0,
        `${hang}:${change} must not log a stale failure`);
      assert.equal(f.tasks.has(`session_business_recovery_${f.account.id}`), false, `${hang}:${change} must not reschedule`);
      assert.equal(f.counts().reloads, 0);
      assert.equal(f.counts().stops, 0);
      await f.manager.detachAll();
    }
  }
});
