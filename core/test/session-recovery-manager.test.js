const test = require('node:test'); const assert = require('node:assert/strict');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const vm = require('node:vm'); const { EventEmitter } = require('node:events'); const { createRequire } = require('node:module');
const prefix = path.resolve(os.tmpdir(), 'session-manager-recovery-'); assert.equal(path.dirname(prefix), path.resolve(os.tmpdir()));
const temporary = fs.mkdtempSync(prefix); process.env.FARM_DATA_DIR = temporary;
test.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
function fixture(options = {}) {
  const filename = path.resolve(__dirname, '../src/runtime/worker-manager.js'); const native = createRequire(filename);
  const account = { id: 'synthetic-recovery', name: 'Example account', code: 'synthetic-code', platform: 'wx', autoLogin: true };
  const tasks = new Map(); const intervals = new Map(); const logs = []; let reloads = 0; let stops = 0; let forks = 0; let release;
  let created = 0; let lookups = 0; let attachFailures = options.attachFailures || 0;
  const proc = new EventEmitter(); proc.persistentSession = true; proc.businessInitialized = true; proc.ready = Promise.resolve();
  proc.sessionFacts = { sequence: 1, host: { hostId: 'synthetic-host', starttime: '1' },
    game: { connected: true, terminal: false, connectionEpoch: 7, loginEpoch: 1, firstLoginReadyAt: 123 },
    business: { ready: false, epoch: 'synthetic-failed' } };
  proc.send = () => {}; proc.kill = async () => { stops++; }; proc.detach = async () => {};
  proc.refreshSession = async () => ({ facts: proc.sessionFacts });
  proc.reloadBusiness = async () => {
    reloads++;
    if (options.wait) await new Promise(resolve => { release = resolve; });
    if (options.fail) throw new Error('synthetic replacement failure');
    proc.sessionFacts = { ...proc.sessionFacts, business: { ready: true, epoch: `synthetic-restored-${reloads}` } };
    return { facts: proc.sessionFacts };
  };
  const originalRefresh = proc.refreshSession;
  if (options.initialAttachFailure) {
    proc.businessInitialized = false; proc.recoverableAttach = options.initialAttachFailure !== 'unverified';
    proc.ready = Promise.reject(new Error('synthetic first management attach failure')); proc.ready.catch(() => {});
  }
  if (options.controlDrop) proc.refreshSession = async () => { throw new Error('synthetic closed control socket'); };
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
  const registry = { ...native('./session-registry'), connectSession: async () => {
    lookups++;
    if (lookups <= (options.lookupFailures || 0)) throw new Error('synthetic status read failure');
    return { state: 'present', client: { call: () => originalRefresh(), close() {} } };
  } };
  const scheduler = { setTimeoutTask: (name, _ms, callback) => tasks.set(name, callback), clear: name => tasks.delete(name),
    clearAll: () => { tasks.clear(); intervals.clear(); }, setIntervalTask: (name, _ms, callback) => intervals.set(name, callback) };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module, exports: module.exports, process, Buffer, console,
    require: name => name === '../services/scheduler' ? { createScheduler: () => scheduler }
      : name === './session-worker-proxy' ? { createSessionWorkerProxy: createProxy, replayLifecycle: async () => {} }
        : name === './session-registry' ? registry : native(name) }, { filename });
  const workers = {}; const manager = module.exports.createWorkerManager({ runtimeMode: 'persistent', processRef: { pkg: false, env: {} },
    mainEntryPath: '/synthetic/core/client.js', workerScriptPath: '', workers, globalLogs: [], fork: () => { forks++; },
    store: { ensureAccountSessionMetadata: () => account }, getAccounts: () => ({ accounts: [account] }),
    log: (tag, msg, meta) => logs.push({ tag, msg, meta }), addAccountLog() {}, normalizeStatusForPanel: value => value,
    buildConfigSnapshotForAccount: () => ({}), scheduleAccountRefresh() {}, stopAccountRefresh() {} });
  const takeRecovery = async () => {
    const name = `session_business_recovery_${account.id}`; const callback = tasks.get(name); tasks.delete(name);
    if (callback) await callback();
    return Boolean(callback);
  };
  const fail = () => proc.emit('error', Object.assign(new Error('synthetic event failure'), { code: 'SESSION_EVENT_DELIVERY_FAILED', phase: 'event_delivery' }));
  return { account, tasks, intervals, proc, workers, manager, logs, fail, takeRecovery,
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
