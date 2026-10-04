'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/**
 * 自助扫码自动恢复接线（2026-10-04）回归：
 *
 * 1) reason 包装：runtime-engine 把阶段码包成 isRecoveryReason 已识别的
 *    refresh_failed:rescan:<stage>。用真实 createAutoCodeRefreshService +
 *    fake scheduler（mock setTimeout）验证裸阶段码若不包装会缺的预算真的
 *    生效：临时失败按原 intervalMinutes 节奏重试、连续 3 次熔断、每日
 *    5 次上限，成功后不重排——不是只看 provider 方法「被调用」。
 * 2) Worker 连接态收口时间门：旧 Worker 的 connected、空 Code、停止中的
 *    Worker、提交前被替换的 Worker、排队期间的新扫码都不得清检查点；
 *    只有「检查点写入后启动的 Worker + 新 Code 已落盘」的连接才收口。
 * 3) 持久检查点跨进程：全新 reminder 服务实例（同注册表文件）上显式
 *    重试仍可用（不重发二维码、不重放 OAuth），并发重试合并为一次。
 */

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farm-wxrecovery-'));
process.env.FARM_DATA_DIR = dataDir;
fs.writeFileSync(path.join(dataDir, 'accounts.json'), JSON.stringify({
  accounts: [{
    id: '301', name: '农场号Z', platform: 'wx', username: 'ownerZ',
    wxid: 'openid-Z', code: '', loginBuffer: 'buffer-Z', refreshtoken: 'refresh-Z',
  }],
  nextId: 302,
}));
test.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

const adapter = require('../src/services/wx-login-adapter');
const store = require('../src/models/store');
const { createAutoCodeRefreshService } = require('../src/runtime/auto-code-refresh');
const { getSchedulerRegistrySnapshot } = require('../src/services/scheduler');
const { wrapRescanRecoveryReason, settleScanCheckpointOnConnect } = require('../src/runtime/runtime-engine');
const reminderModule = require('../src/services/wx-login-reminder');

// ── 1. 真实 auto-code-refresh + fake scheduler：预算与节奏 ──

function schedulerFixture(t, { id, codeResult }) {
  const account = {
    id, name: `Fixture-${id}`, wxid: `wx-${id}`, platform: 'wx',
    loginBuffer: `buffer-${id}`, refreshtoken: `refresh-${id}`,
    wxCredentialExpiresAt: Date.now() + 2 * 3600000, autoLogin: true,
  };
  const counters = { codeCalls: 0, restarts: 0, writes: 0, blocked: [] };
  const original = adapter.getFarmCode;
  adapter.getFarmCode = async () => {
    counters.codeCalls += 1;
    const result = codeResult();
    if (result instanceof Error) throw result;
    return result;
  };
  const svc = createAutoCodeRefreshService({
    store: {
      isAccountAutoLogin: () => true,
      getAutoCodeRefresh: () => ({ enabled: true, intervalMinutes: 1 }),
    },
    getAccounts: () => ({ accounts: [account] }),
    addOrUpdateAccount: patch => { Object.assign(account, patch); counters.writes += 1; },
    resolveWorkerControls: () => ({ restartWorker: () => { counters.restarts += 1; } }),
    keepWxCredentialAlive: async () => ({ Success: true }),
    getCredentialKeepaliveDelayMs: () => 10_000_000,
    log: () => {},
    addAccountLog: (action) => { if (action === 'auto_relogin_blocked') counters.blocked.push(action); },
  });
  t.after(() => { svc.stopAccount(id); adapter.getFarmCode = original; });
  return { account, counters, svc };
}

const flush = async () => { for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r)); };
const tasksFor = id => getSchedulerRegistrySnapshot('auto_code_refresh').schedulers
  .flatMap(s => s.tasks.map(task => task.name)).filter(name => name.endsWith(`_${id}`));

test('wrapRescanRecoveryReason：阶段码包装为分类器已识别的 refresh_failed:rescan:<stage>', () => {
  assert.equal(wrapRescanRecoveryReason('code_temporary'), 'refresh_failed:rescan:code_temporary');
  assert.equal(wrapRescanRecoveryReason('start_refused'), 'refresh_failed:rescan:start_refused');
  assert.equal(wrapRescanRecoveryReason(''), 'refresh_failed:rescan:recovery');
  assert.equal(wrapRescanRecoveryReason(undefined), 'refresh_failed:rescan:recovery');
  // 与 auto-code-refresh 前缀匹配语义一致（includes('refresh_failed')）。
  for (const stage of ['code_temporary', 'start_refused', 'recovery']) {
    assert.ok(wrapRescanRecoveryReason(stage).includes('refresh_failed'));
  }
});

test('真实调度器：临时失败按原间隔重试，连续 3 次熔断后不再排程（不永远循环）', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const id = 'sched-3';
  const { counters, svc } = schedulerFixture(t, {
    id, codeResult: () => new Error('connect ETIMEDOUT upstream'),
  });
  const reason = wrapRescanRecoveryReason('code_temporary');
  assert.equal(svc.scheduleRelogin(id, reason), true, '预算内允许排程');
  // 原节奏：intervalMinutes=1 → 60000ms，差 1ms 都不触发。
  t.mock.timers.tick(59_999); await flush();
  assert.equal(counters.codeCalls, 0, '首个重试必须等满原定间隔');
  t.mock.timers.tick(1); await flush();
  assert.equal(counters.codeCalls, 1);
  t.mock.timers.tick(59_999); await flush();
  assert.equal(counters.codeCalls, 1, '第二次重试同样等满间隔');
  t.mock.timers.tick(1); await flush();
  assert.equal(counters.codeCalls, 2);
  t.mock.timers.tick(60_000); await flush();
  assert.equal(counters.codeCalls, 3, '第三次失败后预算熔断');
  assert.ok(counters.blocked.length >= 1, '熔断必须留下 auto_relogin_blocked 记录');
  // 熔断后不再有 relogin 任务，也不会发起第 4 次换码。
  t.mock.timers.tick(180_000); await flush();
  assert.equal(counters.codeCalls, 3, '连续 3 次失败后绝不继续循环');
  assert.ok(!tasksFor(id).includes(`relogin_${id}`), '熔断后 relogin 任务已消失');
  assert.equal(svc.scheduleRelogin(id, reason), false, '熔断内再次排程被拒');
  assert.equal(counters.restarts, 0);
});

test('真实调度器：每日 5 次上限对包装后的 reason 同样生效', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const id = 'sched-5';
  let fail = false;
  const { counters, svc } = schedulerFixture(t, {
    id,
    codeResult: () => (fail ? new Error('connect ETIMEDOUT upstream')
      : { Success: true, Data: { code: 'fixture-code' } }),
  });
  const reason = wrapRescanRecoveryReason('code_temporary');
  // 当天已通过其他恢复路径成功 4 次（attempts 累计、failures 清零）。
  for (let i = 0; i < 4; i++) {
    assert.equal(await svc.refreshAccountCode(id, reason), true);
  }
  assert.equal(counters.restarts, 4);
  fail = true; // 第 5 次起临时失败
  assert.equal(svc.scheduleRelogin(id, reason), true, '每日 4 次仍未触顶');
  t.mock.timers.tick(60_000); await flush();
  assert.equal(counters.codeCalls, 5, '第 5 次尝试照常执行');
  t.mock.timers.tick(180_000); await flush();
  assert.equal(counters.codeCalls, 5, '每日 5 次用尽后不再排程');
  assert.ok(counters.blocked.length >= 1);
  assert.equal(svc.scheduleRelogin(id, reason), false, '触顶后显式排程也被拒');
});

// ── 2. Worker 连接态收口时间门（真实 reminder 服务 + 真实注册表文件） ──

function reminderFixture(t, { retrySaved } = {}) {
  const registryFile = path.join(dataDir, `wx-reminder-${Math.random().toString(36).slice(2)}.json`);
  const service = reminderModule.createWxLoginReminderService({
    getAccounts: store.getAccounts,
    log: () => {}, addAccountLog: () => {},
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ code: 200 }) }),
    ...(retrySaved ? { retrySaved } : {}),
    registryFile: () => registryFile,
  });
  t.after(() => { try { fs.unlinkSync(registryFile); } catch { /* 未落盘即可 */ } });
  return { service, registryFile };
}

async function seedCheckpoint(service, { stage = 'code_pending', error = '换取农场码失败: temp' } = {}) {
  const generation = await service.noteAcceptedScan('301', { owner: 'ownerZ', wxid: 'openid-Z' });
  assert.equal(typeof generation, 'number');
  await service.noteScanCodePending('301', { generation, stage, error, owner: 'ownerZ', wxid: 'openid-Z' });
  const checkpoint = service.getScanCheckpoint('301');
  assert.ok(checkpoint, '检查点种子就绪');
  return checkpoint;
}

function resetAccount301(code) {
  store.addOrUpdateAccount({
    id: '301', platform: 'wx', username: 'ownerZ', wxid: 'openid-Z',
    code, loginBuffer: 'buffer-Z', refreshtoken: 'refresh-Z',
  });
}

const CONNECTED = { connection: { connected: true } };
const workerAt = (startedAt, extra = {}) => ({ startedAt, stopping: false, ...extra });

test('旧 Worker 的 connected 不清检查点（新授权已存、新码未换成的窗口期）', async (t) => {
  const { service } = reminderFixture(t);
  const checkpoint = await seedCheckpoint(service);
  resetAccount301('fresh-code-Z');
  const workers = { 301: workerAt(checkpoint.savedAt - 60_000) }; // 检查点之前就在跑的旧 Worker
  const settled = settleScanCheckpointOnConnect({
    reminder: service, workers, getAccounts: store.getAccounts, accountId: '301', status: CONNECTED,
  });
  if (settled && settled.then) await settled;
  await flush();
  assert.ok(service.getScanCheckpoint('301'), '旧 Worker 连接不得清新扫码的检查点');
});

test('新 Code 未落盘（code 为空）时连接不收口', async (t) => {
  const { service } = reminderFixture(t);
  const checkpoint = await seedCheckpoint(service);
  resetAccount301(''); // 完成链已作废旧 Code、新码换发临时失败
  const workers = { 301: workerAt(checkpoint.savedAt + 5_000) };
  const settled = settleScanCheckpointOnConnect({
    reminder: service, workers, getAccounts: store.getAccounts, accountId: '301', status: CONNECTED,
  });
  if (settled && settled.then) await settled;
  await flush();
  assert.ok(service.getScanCheckpoint('301'), '没有新 Code 就不算本次授权的启动在收口');
});

test('非 connected 状态不触碰检查点', async (t) => {
  const { service } = reminderFixture(t);
  const checkpoint = await seedCheckpoint(service);
  resetAccount301('fresh-code-Z');
  const workers = { 301: workerAt(checkpoint.savedAt + 5_000) };
  for (const status of [{ connection: { connected: false } }, { connection: {} }, {}]) {
    const settled = settleScanCheckpointOnConnect({
      reminder: service, workers, getAccounts: store.getAccounts, accountId: '301', status,
    });
    if (settled && settled.then) await settled;
  }
  await flush();
  assert.ok(service.getScanCheckpoint('301'), '只有真正连上才允许收口');
});

test('停止中的 Worker / 提交前被替换的 Worker 不清检查点', async (t) => {
  const { service } = reminderFixture(t);
  const checkpoint = await seedCheckpoint(service);
  resetAccount301('fresh-code-Z');
  // 停止中
  const stopping = settleScanCheckpointOnConnect({
    reminder: service, workers: { 301: workerAt(checkpoint.savedAt + 5_000, { stopping: true }) },
    getAccounts: store.getAccounts, accountId: '301', status: CONNECTED,
  });
  if (stopping && stopping.then) await stopping;
  await flush();
  assert.ok(service.getScanCheckpoint('301'), '停止中的 Worker 不收口');
  // 捕获后、临界区提交前 Worker 被换掉：guard 必须拒收。
  const workers = { 301: workerAt(checkpoint.savedAt + 5_000) };
  const pending = settleScanCheckpointOnConnect({
    reminder: service, workers, getAccounts: store.getAccounts, accountId: '301', status: CONNECTED,
  });
  workers[301] = workerAt(checkpoint.savedAt + 9_000); // 同步替换，提交发生在微任务后
  if (pending && pending.then) await pending;
  await flush();
  assert.ok(service.getScanCheckpoint('301'), '提交瞬间已不是同一条 Worker → 不收口');
});

test('检查点写入后启动的 Worker 连上新 Code → 收口（自动恢复上线的兜底路径）', async (t) => {
  const { service } = reminderFixture(t);
  const checkpoint = await seedCheckpoint(service);
  resetAccount301('fresh-code-Z');
  const settled = settleScanCheckpointOnConnect({
    reminder: service, workers: { 301: workerAt(checkpoint.savedAt + 5_000) },
    getAccounts: store.getAccounts, accountId: '301', status: CONNECTED,
  });
  assert.ok(settled && settled.then, '合法收口必须走真实 noteScanCodeResolved');
  assert.equal(await settled, true, '真实清除必须 resolve true（连接收口含内存 pending 翻转）');
  assert.equal(service.getScanCheckpoint('301'), null, '新 Worker 连上后检查点收口');
});

test('排队旧事件带旧代次 → 不能清新扫码的检查点（代次绑定拒收）', async (t) => {
  const { service } = reminderFixture(t);
  const first = await seedCheckpoint(service); // 代次 N 的旧检查点
  // 等待期间新扫码被接受：代次推进 + 旧检查点清空，再写入新代次检查点。
  const second = await seedCheckpoint(service);
  assert.ok(second.generation > first.generation);
  // 旧事件提交时带着捕获时的旧代次（时间门捕获值的语义）。
  const settled = service.noteScanCodeResolved('301', {
    generation: first.generation, owner: 'ownerZ', wxid: 'openid-Z',
  });
  await settled;
  const live = service.getScanCheckpoint('301');
  assert.ok(live, '新代次检查点不得被旧代次的收口清掉');
  assert.equal(live.generation, second.generation);
});

// ── 3. 持久检查点跨进程：显式重试不重发二维码、不重放 OAuth ──

test('进程重启后（全新服务实例 + 同注册表文件）显式重试仍可用，并发合并为一次', async (t) => {
  const retries = [];
  const seeded = reminderFixture(t);
  await seedCheckpoint(seeded.service);
  resetAccount301('');
  // 模拟进程重启：全新服务实例读同一注册表文件，只接入 retrySaved。
  const restarted = reminderModule.createWxLoginReminderService({
    getAccounts: store.getAccounts,
    log: () => {}, addAccountLog: () => {},
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ code: 200 }) }),
    retrySaved: async (opts) => { retries.push(opts); return { ok: true, started: true, stage: 'start_submitted' }; },
    registryFile: () => seeded.registryFile,
  });
  const account301 = store.getAccounts().accounts.find(acc => String(acc.id) === '301');
  const [a, b] = await Promise.all([
    restarted.retryCompleteLogin(account301),
    restarted.retryCompleteLogin(account301),
  ]);
  assert.equal(retries.length, 1, '并发重试合并为一次（inFlightRetry）');
  assert.equal(retries[0].accountId, '301');
  assert.equal(retries[0].generation, seeded.service.getScanCheckpoint('301').generation);
  assert.equal(typeof retries[0].isCurrent, 'function');
  assert.deepEqual([a.ok, a.started], [true, true]);
  assert.equal(b, a, '同一 in-flight 任务');
  // 再次显式重试是一次新的手动动作，仍从持久凭据出发。
  await restarted.retryCompleteLogin(account301);
  assert.equal(retries.length, 2);
  for (const opts of retries) {
    assert.ok(!('sessionId' in opts), '重试不得依赖一次性扫码会话');
  }
});
