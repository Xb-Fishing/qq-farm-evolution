const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');

// 在任何 import/require 之前独立数据目录，零真实网络、全合成身份。
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farm-wx-online-rescan-'));
process.env.FARM_DATA_DIR = dataDir;
test.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

const { createWorkerManager } = require('../src/runtime/worker-manager');
const { createDataProvider } = require('../src/runtime/data-provider');
const { createAutoCodeRefreshService } = require('../src/runtime/auto-code-refresh');
const { createScheduler, getSchedulerRegistrySnapshot } = require('../src/services/scheduler');

// worker_manager 调度器的 watchdog 周期任务会让事件循环滞留，结束时清掉
test.after(() => {
  createScheduler('worker_manager').clearAll();
  createScheduler('auto_code_refresh').clearAll();
});

function load(relative, overrides = {}) {
  const filename = path.join(__dirname, '../src', relative);
  const module = { exports: {} };
  const nativeRequire = createRequire(filename);
  const context = { module, exports: module.exports, Error, Buffer, URL, URLSearchParams, Headers,
    AbortController, setTimeout, clearTimeout, console,
    require: name => Object.hasOwn(overrides, name) ? overrides[name] : nativeRequire(name) };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), context, { filename });
  return module.exports;
}
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

// ─────────────────────────────────────────────────────────────
// 1) 路由层：在线账号扫码保存必须换新授权启动，改备注不动会话
// ─────────────────────────────────────────────────────────────

async function setupOnlineRoute() {
  const account = { id: 'fixture-online', username: 'fixture-owner', platform: 'wx',
    loginType: 'wx_qr', wxid: 'fixture-openid', loginBuffer: 'old-buffer', refreshtoken: 'old-refresh' };
  const calls = { starts: 0, restarts: 0, invalidations: [], refreshSettings: 0, writes: [] };
  class FixtureService {
    async createQrSession() { return { session: { uuid: 'fixture-qr' }, qr: Buffer.from('fixture') }; }
    async poll() { return 'authorized'; }
    async confirm(session) {
      Object.assign(session, { openid: 'fixture-openid', loginBuffer: 'scan-buffer', refreshtoken: 'scan-refresh', accesstoken: 'ascan' });
      return { openid: session.openid };
    }
    async fetchUserInfo() { return {}; }
  }
  const save = patch => {
    Object.assign(account, patch);
    calls.writes.push(account.loginBuffer);
    return { accounts: [account] };
  };
  const adapter = load('services/wx-login-adapter.js', {
    './wx-login/service': { WxLoginService: FixtureService },
    './logger': { createModuleLogger: () => ({ info() {}, warn() {}, error() {} }) },
    '../models/store': { getAccounts: () => ({ accounts: [account] }), addOrUpdateAccount: save },
  });
  const qr = await adapter.getQRCode('fixture-owner');
  const sessionId = qr.Data.Uuid;
  await adapter.checkQR(sessionId, 'fixture-owner');
  const routes = new Map();
  const app = { get() {}, post: (route, handler) => routes.set(route, handler), put() {}, delete() {}, patch() {} };
  load('controllers/admin-account-routes.js', { '../services/wx-login-adapter': adapter }).registerAdminAccountRoutes({
    app,
    provider: {
      getAccounts: () => ({ accounts: [{ id: account.id, platform: account.platform }] }),
      isAccountRunning: () => true,
      invalidateAccountCredentialTasks: () => { calls.invalidations.push(account.loginBuffer); },
      saveAutoCodeRefresh: async () => { calls.refreshSettings += 1; },
      startAccount: async () => { calls.starts += 1; return true; },
      restartAccount: () => { calls.restarts += 1; },
      addAccountLog: () => {},
    },
    getAccountsForUser: () => [account], resolveAccountReference: value => value,
    canAccessAccount: req => req.currentUser.username === account.username,
    addOrUpdateAccount: save,
  });
  const invoke = async body => {
    const response = { statusCode: 200, status(value) { this.statusCode = value; return this; }, json(value) { this.body = value; } };
    await routes.get('/api/accounts')({ body, currentUser: { username: 'fixture-owner', role: 'user' } }, response);
    return response;
  };
  const scanBody = { id: account.id, platform: 'wx', wxid: account.wxid, wxSessionId: sessionId, code: 'scan-session-code' };
  return { account, calls, sessionId, invoke, scanBody, adapter };
}

test('在线扫码保存：新 Code 经真实 restartAccount→manager 重建连接，保活按新授权重挂', async () => {
  const NEW_EXPIRY = Date.now() + 7200000;
  const account = { id: 'fixture-chain', username: 'fixture-owner', name: 'Chain', platform: 'wx',
    loginType: 'wx_qr', wxid: 'fixture-openid', loginBuffer: 'old-buffer', refreshtoken: 'old-refresh',
    code: 'code-1', autoLogin: true, wxCredentialExpiresAt: Date.now() + 3600000 };
  const children = [];
  const workers = {};
  const keepaliveDelayAccounts = [];
  const svc = createAutoCodeRefreshService({
    store: { isAccountAutoLogin: () => true, getAutoCodeRefresh: () => ({ enabled: true, intervalMinutes: 60 }) },
    getAccounts: () => ({ accounts: [account] }),
    addOrUpdateAccount: patch => Object.assign(account, patch),
    resolveWorkerControls: () => ({}),
    getCredentialKeepaliveDelayMs: acc => {
      keepaliveDelayAccounts.push({ loginBuffer: acc.loginBuffer, expiresAt: acc.wxCredentialExpiresAt });
      return 3600000;
    },
    log: () => {}, addAccountLog: () => {},
  });
  const manager = createWorkerManager({
    fork: () => { const child = new FakeChild(); children.push(child); return child; },
    WorkerThread: undefined,
    runtimeMode: 'fork',
    processRef: { env: {} },
    workerScriptPath: 'fixture-worker.js',
    workers,
    globalLogs: [],
    log: () => {},
    addAccountLog: () => {},
    normalizeStatusForPanel: data => data,
    buildConfigSnapshotForAccount: () => ({}),
    getAccounts: () => ({ accounts: [account] }),
    scheduleAccountRefresh: svc.scheduleAccount,
    stopAccountRefresh: svc.stopAccount,
  });
  const realProvider = createDataProvider({
    workers,
    globalLogs: [],
    accountLogs: [],
    getAccounts: () => ({ accounts: [account] }),
    callWorkerApi: () => Promise.reject(new Error('fixture: no rpc')),
    restartWorker: manager.restartWorker,
    stopAutoCodeRefresh: svc.stopAccount,
  });
  assert.equal(manager.startWorker(account), true);
  assert.equal(startConfigOf(children[0]).config.code, 'code-1');

  class ChainScanService {
    async createQrSession() { return { session: { uuid: 'fixture-qr-chain' }, qr: Buffer.from('fixture') }; }
    async poll() { return 'authorized'; }
    async confirm(session) {
      Object.assign(session, { openid: 'fixture-openid', loginBuffer: 'scan-buffer', refreshtoken: 'scan-refresh',
        accesstoken: 'ascan', credentialExpiresAt: NEW_EXPIRY, credentialExpiresIn: 7200 });
      return { openid: session.openid };
    }
    async fetchUserInfo() { return {}; }
  }
  const save = patch => { Object.assign(account, patch); return { accounts: [account] }; };
  const adapter = load('services/wx-login-adapter.js', {
    './wx-login/service': { WxLoginService: ChainScanService },
    './logger': { createModuleLogger: () => ({ info() {}, warn() {}, error() {} }) },
    '../models/store': { getAccounts: () => ({ accounts: [account] }), addOrUpdateAccount: save },
  });
  const qr = await adapter.getQRCode('fixture-owner');
  const sessionId = qr.Data.Uuid;
  await adapter.checkQR(sessionId, 'fixture-owner');

  const routes = new Map();
  const app = { get() {}, post: (route, handler) => routes.set(route, handler), put() {}, delete() {}, patch() {} };
  load('controllers/admin-account-routes.js', { '../services/wx-login-adapter': adapter }).registerAdminAccountRoutes({
    app,
    provider: {
      getAccounts: () => ({ accounts: [{ id: account.id, platform: account.platform }] }),
      isAccountRunning: () => !!workers[account.id],
      invalidateAccountCredentialTasks: realProvider.invalidateAccountCredentialTasks,
      restartAccount: realProvider.restartAccount,
      addAccountLog: () => {},
    },
    getAccountsForUser: () => [account], resolveAccountReference: value => value,
    canAccessAccount: req => req.currentUser.username === account.username,
    addOrUpdateAccount: save,
  });

  const response = { statusCode: 200, status(value) { this.statusCode = value; return this; }, json(value) { this.body = value; } };
  await routes.get('/api/accounts')({
    body: { id: account.id, platform: 'wx', wxid: account.wxid, wxSessionId: sessionId, code: 'rescan-code' },
    currentUser: { username: 'fixture-owner', role: 'user' },
  }, response);
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.startup.queued, true, '在线重扫应报告正在用新授权重连');

  // 新扫码凭据与二维码 Code 已落盘，旧任务已失效（换代）
  assert.equal(account.loginBuffer, 'scan-buffer');
  assert.equal(account.code, 'rescan-code');
  assert.equal(account.wxCredentialExpiresAt, NEW_EXPIRY);
  // 旧 Worker 收到 stop 且尚未被替换
  assert.ok(children[0].sent.some(msg => msg.type === 'stop'));
  assert.equal(children.length, 1);
  assert.equal(workers[account.id].stopping, true);

  // 旧进程退出 → 真实 restartWorker 链启动新 Worker，必须带二维码新 Code
  children[0].emit('exit', 0, null);
  assert.equal(children.length, 2);
  assert.equal(startConfigOf(children[1]).config.code, 'rescan-code');
  assert.equal(workers[account.id].process, children[1]);
  // startWorker 重挂保活走真实 scheduleAccount 回调，读到的是新授权（新 expiry）
  const lastKeepalive = keepaliveDelayAccounts.at(-1);
  assert.equal(lastKeepalive.loginBuffer, 'scan-buffer');
  assert.equal(lastKeepalive.expiresAt, NEW_EXPIRY);
  assert.equal(svc.isCredentialBlocked(account.id), false);
});

test('旧 exit 不取消新代次的强杀/重启回退定时器，下一轮重启仍完成', () => {
  const f = setupManager();
  f.manager.startWorker(f.account);
  const proc1 = f.children[0];
  f.account.code = 'code-2';
  f.manager.restartWorker(f.account);
  proc1.emit('exit', 0, null);
  const proc2 = f.children[1];
  assert.equal(startConfigOf(proc2).config.code, 'code-2');

  // 第二轮重启挂在 proc2 上：force_kill / restart_fallback 属于新代次
  f.account.code = 'code-3';
  f.manager.restartWorker(f.account);
  const taskNames = () => getSchedulerRegistrySnapshot('worker_manager')
    .schedulers[0].tasks.map(task => task.name);
  assert.ok(taskNames().includes('force_kill_fixture-mgr'));
  assert.ok(taskNames().includes('restart_fallback_fixture-mgr'));

  // 旧进程 exit 迟到再次送达：不得取消新代次定时器、不得动新 Worker
  proc1.emit('exit', 1, 'SIGKILL');
  assert.ok(taskNames().includes('force_kill_fixture-mgr'), '旧 exit 不得清新代次强杀定时器');
  assert.ok(taskNames().includes('restart_fallback_fixture-mgr'), '旧 exit 不得清新代次重启回退');
  assert.equal(f.workers['fixture-mgr'].process, proc2);

  // 下一轮重启仍会完成，且按最新 Code 启动
  proc2.emit('exit', 0, null);
  assert.equal(f.children.length, 3);
  assert.equal(startConfigOf(f.children[2]).config.code, 'code-3');
});

test('在线账号扫码保存后旧任务失效且不追加授权请求（mock 分流守卫）', async () => {
  const f = await setupOnlineRoute();
  const response = await f.invoke(f.scanBody);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.startup.queued, true);
  assert.equal(f.account.loginBuffer, 'scan-buffer');
  assert.equal(f.account.refreshtoken, 'scan-refresh');
  assert.deepEqual(f.calls.invalidations, ['scan-buffer']);
  assert.equal(f.calls.starts, 0, '在线重扫不得再追加一次换 Code 启动');
  assert.equal(f.calls.restarts, 1);
  assert.equal(f.adapter.peekPendingWxInfo(f.sessionId, f.account.wxid, 'fixture-owner'), null);
});

test('在线账号普通改备注不清会话不重启；非扫码更新仍走直接重启', async () => {
  const f = await setupOnlineRoute();
  const remark = await f.invoke({ id: f.account.id, name: 'Fixture' });
  assert.equal(remark.body.ok, true);
  assert.equal(remark.body.startup.queued, false);
  assert.equal(f.calls.starts, 0);
  assert.equal(f.calls.restarts, 0);
  assert.equal(f.calls.invalidations.length, 0);
  assert.equal(f.calls.refreshSettings, 0);

  const edit = await f.invoke({ id: f.account.id, platform: 'wx', code: 'manual-new-code' });
  assert.equal(edit.body.ok, true);
  assert.equal(edit.body.startup.queued, false);
  assert.equal(f.calls.restarts, 1);
  assert.equal(f.calls.starts, 0);
});

// ─────────────────────────────────────────────────────────────
// 2) worker-manager：两轮扫码并发、旧进程迟到 exit/message
// ─────────────────────────────────────────────────────────────

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.sent = [];
    this.exitCode = null;
    this.signalCode = null;
    this.killed = false;
  }
  send(msg) { this.sent.push(msg); }
  kill() { this.killed = true; }
}

function setupManager() {
  const account = { id: 'fixture-mgr', name: 'Mgr', platform: 'wx', code: 'code-1', autoLogin: true };
  const children = [];
  const workers = {};
  const calls = { refreshArms: 0, refreshStops: 0 };
  const manager = createWorkerManager({
    fork: () => { const child = new FakeChild(); children.push(child); return child; },
    WorkerThread: undefined,
    runtimeMode: 'fork',
    processRef: { env: {} },
    workerScriptPath: 'fixture-worker.js',
    workers,
    globalLogs: [],
    log: () => {},
    addAccountLog: () => {},
    normalizeStatusForPanel: data => data,
    buildConfigSnapshotForAccount: () => ({}),
    getOfflineAutoDeleteMs: () => Infinity,
    triggerOfflineReminder: () => {},
    getAccounts: () => ({ accounts: [account] }),
    scheduleAccountRefresh: () => { calls.refreshArms += 1; },
    stopAccountRefresh: () => { calls.refreshStops += 1; },
  });
  return { account, children, workers, manager, calls };
}

function startConfigOf(child) {
  return child.sent.find(msg => msg.type === 'start');
}

test('两轮扫码只留一台 Worker 且使用最新 Code，不回放第一轮快照', () => {
  const f = setupManager();
  assert.equal(f.manager.startWorker(f.account), true);
  const oldProc = f.children[0];
  assert.equal(startConfigOf(oldProc).config.code, 'code-1');

  // 第一轮扫码已排重启（旧 worker 尚未退出），期间第二轮扫码把凭据换成 code-2
  f.manager.restartWorker({ ...f.account, code: 'code-1' });
  f.account.code = 'code-2';
  f.manager.restartWorker({ ...f.account, code: 'code-2' });

  oldProc.emit('exit', 0, null);
  assert.equal(f.children.length, 2, '只能启动一台新 Worker');
  const newProc = f.children[1];
  assert.equal(startConfigOf(newProc).config.code, 'code-2', '新 Worker 必须带最新扫码 Code');
  assert.equal(f.workers['fixture-mgr'].process, newProc);
});

test('旧进程迟到 message/exit 不得改新 Worker 状态、清其请求或重登计时', async () => {
  const f = setupManager();
  f.manager.startWorker(f.account);
  const oldProc = f.children[0];

  // 旧 Worker 自己的挂起请求在其退出时应被拒绝
  const oldCall = f.manager.callWorkerApi('fixture-mgr', 'getLands');
  const oldSettled = deferred();
  oldCall.then(() => oldSettled.resolve('resolved'), err => oldSettled.resolve(err.message));

  f.account.code = 'code-2';
  f.manager.restartWorker(f.account);
  // 模拟 force_kill 与 restart_fallback 竞态：新 Worker 已注册后旧 exit 才送达
  oldProc.emit('exit', 0, null);
  const newProc = f.children[1];
  assert.equal(startConfigOf(newProc).config.code, 'code-2');
  assert.equal(await oldSettled.promise, 'Worker exited');

  const wrk = f.workers['fixture-mgr'];
  const armsAfterStart = f.calls.refreshArms;

  // 新 Worker 的挂起请求：旧进程的 api_response / 再次 exit 都不能动它
  const newCall = f.manager.callWorkerApi('fixture-mgr', 'getBag');
  let newSettled = null;
  newCall.then(() => { newSettled = 'resolved'; }, err => { newSettled = err.message; });
  oldProc.emit('message', { type: 'api_response', id: 1, error: 'stale' });
  oldProc.emit('exit', 1, 'SIGKILL');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(newSettled, null, '旧进程不能拒绝新 Worker 的请求');
  assert.equal(wrk.requests.size, 1);

  // 旧进程迟到状态回填 / 被踢消息不能作用于新 Worker
  oldProc.emit('message', { type: 'status_sync', data: { connection: { connected: false } } });
  oldProc.emit('message', { type: 'account_kicked', reason: 'stale' });
  assert.equal(wrk.status, null, '旧状态不得回填新 Worker');
  assert.equal(f.workers['fixture-mgr'], wrk, '旧消息不得停掉新 Worker');
  assert.equal(f.calls.refreshArms, armsAfterStart, '旧消息不得重挂/清保活');
  // restart 本身停一次（旧代次），旧进程迟到消息不得再追加清理
  assert.equal(f.calls.refreshStops, 1, '旧消息不得清新 Worker 的保活');
});

// ─────────────────────────────────────────────────────────────
// 3) 迟到旧续期：新扫码换代后不得回写 Code、不得重启
// ─────────────────────────────────────────────────────────────

test('新扫码保存后旧续期迟到：不回写旧 Code、不挂旧重启', async () => {
  const account = { id: 'fixture-refresh', name: 'Refresh', wxid: 'wx-fixture',
    loginBuffer: 'scan-buffer', refreshtoken: 'scan-refresh',
    wxCredentialExpiresAt: Date.now() - 1000, code: 'scan-session-code' };
  const writes = [];
  const restarts = [];
  let releaseKeepalive;
  const gate = new Promise(resolve => { releaseKeepalive = resolve; });
  const svc = createAutoCodeRefreshService({
    store: { isAccountAutoLogin: () => true, getAutoCodeRefresh: () => ({ enabled: true, intervalMinutes: 60 }) },
    getAccounts: () => ({ accounts: [account] }),
    addOrUpdateAccount: patch => { writes.push(patch); Object.assign(account, patch); },
    resolveWorkerControls: () => ({ restartWorker: acc => restarts.push(acc.code) }),
    keepWxCredentialAlive: async () => gate,
    getCredentialKeepaliveDelayMs: () => 600000,
    log: () => {},
    addAccountLog: () => {},
  });

  const inFlight = svc.refreshAccountCode('fixture-refresh', 'timer');
  await new Promise(resolve => setImmediate(resolve));
  // 新扫码保存：invalidateAccountCredentialTasks 即 stopAccount，换代 + 清旧任务
  svc.stopAccount('fixture-refresh');
  account.loginBuffer = 'newer-scan-buffer';
  releaseKeepalive();

  assert.equal(await inFlight, false);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(writes, [], '迟到续期不得回写任何 Code/凭据');
  assert.deepEqual(restarts, [], '迟到续期不得挂旧重启');
  // 新授权不被旧失败身份阻断（即使服务端复用 refresh token）
  assert.equal(svc.isCredentialBlocked('fixture-refresh'), false);
});

// ─────────────────────────────────────────────────────────────
// 4) relogin 契约：refreshAccountCode 返回 {ok}，失败必须暴露 needScan
// ─────────────────────────────────────────────────────────────

async function invokeRelogin(provider) {
  const routes = new Map();
  const app = { post: (route, handler) => routes.set(route, handler) };
  load('controllers/admin-account-runtime-routes.js', {
    '../models/store': { getAccounts: () => ({ accounts: [] }) },
  }).registerAdminAccountRuntimeRoutes({
    app, provider,
    resolveAccountReference: value => value,
    canAccessAccount: () => true,
  });
  const response = { statusCode: 200, status(value) { this.statusCode = value; return this; }, json(value) { this.body = value; } };
  await routes.get('/api/accounts/:id/relogin')({ params: { id: 'fixture-online' } }, response);
  return response;
}

test('直接登录失败不再误报成功，按 needScan 引导扫码', async () => {
  const failed = await invokeRelogin({ refreshAccountCode: async () => ({ ok: false }) });
  assert.equal(failed.statusCode, 409);
  assert.equal(failed.body.ok, false);
  assert.equal(failed.body.needScan, true);

  const succeeded = await invokeRelogin({ refreshAccountCode: async () => ({ ok: true }) });
  assert.equal(succeeded.statusCode, 200);
  assert.equal(succeeded.body.ok, true);
});

test('换代重名 reqId：旧 RPC 被结算拒绝，新 Worker 同号请求正常返回', async () => {
  const f = setupManager();
  f.manager.startWorker(f.account);
  const oldProc = f.children[0];
  const oldSettled = deferred();
  f.manager.callWorkerApi('fixture-mgr', 'getLands', { _timeoutMs: 60000 })
    .then(() => oldSettled.resolve('resolved'), err => oldSettled.resolve(err.message));

  // 旧进程拒绝退出：restart 只能走 1500ms fallback 强杀换新
  f.account.code = 'code-2';
  f.manager.restartWorker(f.account);
  await new Promise(resolve => setTimeout(resolve, 1700));

  // fallback 替换旧记录前必须结算旧 RPC（否则只剩已被重名覆盖的定时器，永久悬挂）
  assert.equal(await oldSettled.promise, 'Worker exited');
  const newProc = f.children[1];
  assert.ok(newProc, 'fallback 必须已启动新 Worker');
  assert.equal(startConfigOf(newProc).config.code, 'code-2');

  // 新记录 reqId 从 1 重置，与旧请求同号：新请求必须能正常结算
  const newSettled = deferred();
  f.manager.callWorkerApi('fixture-mgr', 'getBag', { _timeoutMs: 5000 })
    .then(value => newSettled.resolve(`ok:${  JSON.stringify(value)}`), err => newSettled.resolve(`err:${  err.message}`));
  await new Promise(resolve => setImmediate(resolve));
  const call = newProc.sent.find(msg => msg.type === 'api_call');
  assert.equal(call.id, 1);
  newProc.emit('message', { type: 'api_response', id: 1, result: { fresh: true } });
  assert.equal(await newSettled.promise, 'ok:{"fresh":true}');

  // 旧 exit 迟到：不得影响新记录
  oldProc.emit('exit', 0, null);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.workers['fixture-mgr'].process, newProc);
});

test('kill 同步触发 exit/doRestart 重入：force_kill 不得删掉新注册的 Worker 记录', async () => {
  const account = { id: 'fixture-reenter', name: 'Re', platform: 'wx', code: 'code-1', autoLogin: true };
  class SyncExitChild extends FakeChild {
    kill() { super.kill(); this.emit('exit', null, 'SIGKILL'); }
  }
  const children = [];
  const workers = {};
  const manager = createWorkerManager({
    fork: () => { const child = new SyncExitChild(); children.push(child); return child; },
    WorkerThread: undefined,
    runtimeMode: 'fork',
    processRef: { env: {} },
    workerScriptPath: 'fixture-worker.js',
    workers,
    globalLogs: [],
    log: () => {},
    addAccountLog: () => {},
    normalizeStatusForPanel: data => data,
    buildConfigSnapshotForAccount: () => ({}),
    getAccounts: () => ({ accounts: [account] }),
    scheduleAccountRefresh: () => {},
    stopAccountRefresh: () => {},
  });
  manager.startWorker(account);
  const proc1 = children[0];
  assert.equal(startConfigOf(proc1).config.code, 'code-1');

  // 重启排队后，force_kill(1000ms) 的 kill() 同步触发 exit → doRestart 注册新
  // Worker；force_kill 回调随后不得把这条新记录删掉
  account.code = 'code-2';
  manager.restartWorker(account);
  await new Promise(resolve => setTimeout(resolve, 1100));

  const wrk = workers['fixture-reenter'];
  assert.ok(wrk, 'kill 同步重入后新 Worker 记录必须仍在');
  assert.notEqual(wrk.process, proc1);
  assert.equal(startConfigOf(children[1]).config.code, 'code-2');

  // 1500ms restart_fallback 已随 doRestart 清理/置 restarted，不得再动新记录
  await new Promise(resolve => setTimeout(resolve, 500));
  assert.equal(workers['fixture-reenter'], wrk, 'fallback 回调不得删除新代次记录');
});
