'use strict';
// 手动重启排队回执回归（登记反证文件，2026-10-09）。
// 反证合同：本文件只经「旧源码已有」的管理路由入口（POST /api/accounts/:id/restart）
// 观察状态码与回执结构；旧代码（按真假判断 restarted）必须在排队用例上以
// 404 误报失败——这是行为差异，不是缺少新增导出或夹具失败。断言一律标量
//（状态码/布尔/计数），不得把缺导出、导入失败或夹具异常计为行为反证。
// 至少一例贯通真实管理路由 + 真实 data-provider + 真实 worker-manager：
// 假 fork 子进程与隔离调度验证真实 undefined 排队返回；模拟退出与既有
// force_kill/restart_fallback 兜底后只启动一台新 Worker。零真实进程、
// 零网络、零凭据操作；业务模块加载前设置独立 FARM_DATA_DIR，夹具写目标
// 先解析校验边界，越界在原语调用前拒绝（计数证明零创建零写入）。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');

// ===== 夹具创建与写边界（先解析校验，任何越界在原语调用前拒绝）=====
const repoRoot = path.resolve(__dirname, '..', '..');
const repoRootReal = fs.realpathSync(repoRoot);
function isInsideOrEqualDir(candidate, base) {
  const c = path.resolve(String(candidate));
  const b = path.resolve(String(base));
  return c === b || c.startsWith(b + path.sep);
}
const tempRoot = fs.realpathSync(path.resolve(os.tmpdir()));
assert.equal(isInsideOrEqualDir(tempRoot, repoRootReal), false, '临时根不得指向仓库');
const privateDir = path.resolve(fs.mkdtempSync(path.join(tempRoot, 'farm-restart-queued-')));
assert.equal(isInsideOrEqualDir(privateDir, tempRoot), true, '独立运行数据目录必须落在临时根内');
process.env.FARM_DATA_DIR = privateDir; // 先于任何业务模块加载
// 整套收尾（成功与失败路径都执行）：候选源码内容与权限最终复核，随后删除隔离运行数据目录
test.after(() => {
  try {
    for (const [file, before] of fingerprintsBefore)
      assert.deepEqual(fingerprintOf(file), before, `候选源码不得被夹具改变（套件收尾最终复核）: ${path.basename(file)}`);
  }
  finally {
    fs.rmSync(privateDir, { recursive: true, force: true });
  }
});
function assertWriteInsidePrivateDir(target) {
  const resolved = path.resolve(String(target));
  if (!isInsideOrEqualDir(resolved, privateDir))
    throw new Error(`夹具写目标越界（已在写入原语前拒绝）: ${resolved}`);
  return resolved;
}

// 候选源码指纹：全部用例（含失败路径）结束后内容与权限不得被夹具改变
const CANDIDATE_SOURCES = [
  path.join(repoRoot, 'core', 'src', 'controllers', 'admin-account-runtime-routes.js'),
];
function fingerprintOf(file) {
  const stat = fs.statSync(file);
  return {
    mode: stat.mode,
    size: stat.size,
    sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
  };
}
const fingerprintsBefore = new Map(CANDIDATE_SOURCES.map(file => [file, fingerprintOf(file)]));

// ===== 业务模块（真实 data-provider / worker-manager；路由经 load 隔离 store）=====
const { createWorkerManager } = require('../src/runtime/worker-manager');
const { createDataProvider } = require('../src/runtime/data-provider');
const { createScheduler } = require('../src/services/scheduler');

// worker_manager 调度器 watchdog 周期任务会让事件循环滞留，结束时清掉
test.after(() => {
  createScheduler('worker_manager').clearAll();
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

// 静默期配置快照替身：路由既有行为（重启=解除静默）按调用记录核对，不落真实 store
function buildRouteHarness(provider, { canAccess } = {}) {
  const snapshotCalls = [];
  const fakeStore = {
    applyConfigSnapshot: (...args) => { snapshotCalls.push(args); },
    getAccounts: () => ({ accounts: [] }),
  };
  const routes = new Map();
  const app = { post: (route, handler) => routes.set(route, handler) };
  load('controllers/admin-account-runtime-routes.js', { '../models/store': fakeStore })
    .registerAdminAccountRuntimeRoutes({
      app,
      provider,
      resolveAccountReference: value => value,
      canAccessAccount: canAccess || (() => true),
    });
  const invoke = async (id = 'fixture-acct') => {
    const response = {
      statusCode: 200,
      status(value) { this.statusCode = value; return this; },
      json(value) { this.body = value; },
    };
    await routes.get('/api/accounts/:id/restart')({ params: { id } }, response);
    return response;
  };
  return { invoke, snapshotCalls };
}

// 写原语计数：证明越界目标在任何 mkdir/写/删/改权限原语「之前」被守卫拒绝（零创建零写入），
// 且合法目标经守卫后原语正常执行（计数器能观测真实写入，合法路径可用）
function withWritePrimitiveCounters(fn) {
  const tracked = ['mkdirSync', 'writeFileSync', 'appendFileSync', 'rmSync', 'chmodSync', 'symlinkSync'];
  const counts = Object.fromEntries(tracked.map(name => [name, 0]));
  const originals = tracked.map(name => [name, fs[name]]);
  for (const [name, original] of originals)
    fs[name] = (...args) => { counts[name] += 1; return original.apply(fs, args); };
  try {
    return { counts, value: fn() };
  }
  finally {
    for (const [name, original] of originals)
      fs[name] = original;
  }
}

test('夹具边界：越界写目标在任何写原语前拒绝（计数证明零创建零写入）；合法目标经守卫正常执行；候选源码内容与权限不变', () => {
  const escaped = path.join(privateDir, '..', 'farm-restart-queued-escape.json');
  const rejected = withWritePrimitiveCounters(() =>
    assert.throws(() => assertWriteInsidePrivateDir(escaped), /越界/));
  assert.deepEqual(rejected.counts, {
    mkdirSync: 0, writeFileSync: 0, appendFileSync: 0, rmSync: 0, chmodSync: 0, symlinkSync: 0,
  }, '越界拒绝必须发生在任何写原语之前（零创建零写入）');
  assert.equal(fs.existsSync(escaped), false, '被拒绝的目标不得被创建');
  assert.equal(fs.existsSync(path.resolve(privateDir, 'farm-restart-queued-escape.json')), false);
  // 合法目标：守卫放行且写原语被实际调用（证明计数器可观测真实写入、合法路径正常执行）
  const legal = path.join(privateDir, 'legal-guard-fixture.txt');
  const legalRun = withWritePrimitiveCounters(() =>
    fs.writeFileSync(assertWriteInsidePrivateDir(legal), 'legal'));
  assert.equal(legalRun.counts.writeFileSync, 1);
  assert.equal(fs.readFileSync(legal, 'utf8'), 'legal');
  for (const [file, before] of fingerprintsBefore) {
    assert.deepEqual(fingerprintOf(file), before, `候选源码不得被夹具改变: ${path.basename(file)}`);
  }
});

test('无权限：403 且零重启调用、零配置快照', async () => {
  let restartCalls = 0;
  const { invoke, snapshotCalls } = buildRouteHarness(
    { restartAccount: () => { restartCalls += 1; return true; } },
    { canAccess: () => false },
  );
  const res = await invoke();
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.ok, false);
  assert.equal(restartCalls, 0, '授权拒绝必须零重启调用');
  assert.equal(snapshotCalls.length, 0, '授权拒绝不得动配置快照');
});

test('明确拒绝（false）：保留既有 404 语义', async () => {
  const { invoke, snapshotCalls } = buildRouteHarness({ restartAccount: () => false });
  const res = await invoke();
  assert.equal(res.statusCode, 404);
  assert.equal(res.body.ok, false);
  assert.match(String(res.body.error), /Account not found/);
  assert.equal(snapshotCalls.length, 1, '既有行为：重启入口先解除静默（配置快照照旧）');
});

test('即时成功（true）：保留既有 200 回执，不新增 queued 字段', async () => {
  const { invoke } = buildRouteHarness({ restartAccount: () => true });
  const res = await invoke();
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal('queued' in res.body, false, '即时成功不得冒充排队');
});

test('排队（undefined）：202 明确 queued/started，不再误报 404，一次 restartAccount', async () => {
  let restartCalls = 0;
  const { invoke, snapshotCalls } = buildRouteHarness({
    restartAccount: () => { restartCalls += 1; return undefined; },
  });
  const res = await invoke();
  assert.equal(res.statusCode, 202, '排队回执必须是 202，不是 404');
  assert.equal(res.body.ok, true);
  assert.equal(res.body.queued, true);
  assert.equal(res.body.started, false, '排队不表示游戏已连接');
  assert.equal(restartCalls, 1, '只调用一次 restartAccount');
  assert.equal(snapshotCalls.length, 1);
});

test('provider 抛错：500 既有兜底', async () => {
  const { invoke } = buildRouteHarness({ restartAccount: () => { throw new Error('fixture: restart boom'); } });
  const res = await invoke();
  assert.equal(res.statusCode, 500);
  assert.equal(res.body.ok, false);
});

// ===== 真实链路：真实路由 + 真实 data-provider + 真实 worker-manager =====

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

function setupRealChain() {
  const account = { id: 'fixture-restart', name: 'Restart', platform: 'wx', code: 'code-1', autoLogin: true };
  const children = [];
  const workers = {};
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
    scheduleAccountRefresh: () => {},
    stopAccountRefresh: () => {},
  });
  const realProvider = createDataProvider({
    workers,
    globalLogs: [],
    accountLogs: [],
    getAccounts: () => ({ accounts: [account] }),
    callWorkerApi: () => Promise.reject(new Error('fixture: no rpc')),
    restartWorker: manager.restartWorker,
  });
  // 只计数不改行为：证明路由只调用一次 restartAccount，其余全走真实实现
  let restartCalls = 0;
  const realRestart = realProvider.restartAccount;
  realProvider.restartAccount = ref => { restartCalls += 1; return realRestart(ref); };
  return { account, children, workers, manager, realProvider, restartCalls: () => restartCalls };
}

test('真实链路排队：活进程重启走真实 undefined → 202；模拟退出与既有兜底后只启动一台新 Worker', async () => {
  const f = setupRealChain();
  const { invoke } = buildRouteHarness(f.realProvider);
  assert.equal(f.manager.startWorker(f.account), true);
  const oldProc = f.children[0];

  // 活 Worker（未退出）重启：真实 restartWorker 无同步结果 → undefined → 排队回执
  const res = await invoke('fixture-restart');
  assert.equal(res.statusCode, 202, '旧代码在真实排队场景误报 404（行为反证锚点）');
  assert.equal(res.body.queued, true);
  assert.equal(res.body.started, false);
  assert.equal(f.restartCalls(), 1, '路由只调用一次 restartAccount');
  assert.equal(f.children.length, 1, '排队阶段不得有新进程');
  assert.ok(oldProc.sent.some(msg => msg.type === 'stop'), '旧进程收到停止指令');
  assert.equal(f.workers['fixture-restart'].stopping, true);

  // 模拟旧进程退出 → 真实 restart 链拉起新 Worker（唯一一台）
  oldProc.emit('exit', 0, null);
  assert.equal(f.children.length, 2, '退出后必须且只能启动一台新 Worker');
  const newProc = f.children[1];
  const startMsg = newProc.sent.find(msg => msg.type === 'start');
  assert.ok(startMsg, '新 Worker 收到启动配置');
  assert.equal(f.workers['fixture-restart'].process, newProc);

  // 度过既有 force_kill(1000ms)/restart_fallback(1500ms) 兜底窗口：仍只有一台新 Worker
  await new Promise(resolve => setTimeout(resolve, 1700));
  assert.equal(f.children.length, 2, '既有兜底不得再追加第二台新 Worker');
  assert.equal(f.workers['fixture-restart'].process, newProc);
});

test('真实链路未运行：直接启动成功保留 200；不存在账号的明确拒绝保留 404', async () => {
  const f = setupRealChain();
  const { invoke } = buildRouteHarness(f.realProvider);
  // 未运行 → restartWorker 走 startWorker：启动成功 = true → 200（不冒充排队）
  const started = await invoke('fixture-restart');
  assert.equal(started.statusCode, 200);
  assert.equal(started.body.ok, true);
  assert.equal('queued' in started.body, false);
  assert.equal(f.children.length, 1);

  // 真实 provider 解析不到账号 → false → 404 既有拒绝语义（不误报排队）
  const stopped = await invoke('fixture-missing');
  assert.equal(stopped.statusCode, 404, '明确拒绝保留 404，不误报排队');
  assert.equal(stopped.body.ok, false);
  assert.equal(f.children.length, 1, '拒绝路径零新进程');
});
