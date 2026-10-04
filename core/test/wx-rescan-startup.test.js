'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/**
 * 进程重启后的真实启动路径回归（真实 createRuntimeEngine + 真实
 * startAllAccounts / engine.start，仅 mock Worker 创建与上游出码）：
 *
 * 人工新扫码后旧一次性 Code 已作废（code='' 或旧值）且留下持久
 * code_pending/start_pending 检查点。进程重启时 startAllAccounts 的
 * native startup 换码若临时失败，绝不能拿 await 前快照里的旧 Code/空 Code
 * 拉 Worker（fresh Code before Worker）：待收口检查点在或当前无有效 Code
 * → 沿既有 scheduleRelogin 原间隔+5/3 预算排程；无检查点且旧 Code 合法 →
 * 受控回退保留；明确凭据失效 → 不启动不排程；await 期间暂停/删除/新扫码
 * 收口 → 按最新账号态判定，不用旧快照。
 *
 * 追加：engine.start 在 startAllAccounts 之后执行 rescheduleAll（clearAll
 * 会清掉刚挂的 relogin），恢复任务必须在 rescheduleAll 之后仍然存在且只
 * 触发一次——用真实 engine.start({startAdminServer:false}) 验证，不是只看
 * 一次 spy 调用。
 */

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farm-wxstartup-'));
process.env.FARM_DATA_DIR = dataDir;
// 账号必须落盘预置（addOrUpdateAccount 只更新已存在账号，不追加）。
const STARTUP_IDS = ['501', '502', '503', '504', '505', '506', '507', '508', '509'];
fs.writeFileSync(path.join(dataDir, 'accounts.json'), JSON.stringify({
  accounts: STARTUP_IDS.map(id => ({
    id, name: `农场号${id}`, platform: 'wx', username: `owner-${id}`, wxid: `wx-${id}`,
    autoLogin: true, code: '', loginBuffer: `buffer-${id}`, refreshtoken: `refresh-${id}`,
    wxCredentialExpiresAt: Date.now() + 2 * 3600000,
  })),
  nextId: 510,
}));
test.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

// ── Worker 创建边界 mock：必须在首次 require runtime-engine 前种入缓存 ──
// 引擎顶部 `const { createWorkerManager } = require('./worker-manager')`，
// 真实实现会 fork/起线程；这里记录 start/restart 的账号与 Code 快照。
const workerCalls = { start: [], restart: [], stop: [] };
const workerManagerPath = require.resolve('../src/runtime/worker-manager');
require.cache[workerManagerPath] = {
  id: workerManagerPath, filename: workerManagerPath, loaded: true, paths: [],
  exports: {
    createWorkerManager: (deps) => {
      const workers = deps.workers;
      const mark = (account) => {
        const id = String(account && account.id);
        workers[id] = { startedAt: Date.now(), stopping: false, process: { send() {} } };
        return { id, code: String(account && account.code || '') };
      };
      return {
        startWorker: (account) => { workerCalls.start.push(mark(account)); return true; },
        restartWorker: (account) => { workerCalls.restart.push(mark(account)); return true; },
        stopWorker: (id) => { workerCalls.stop.push(String(id)); delete workers[String(id)]; },
        callWorkerApi: async () => { throw new Error('not running'); },
      };
    },
  },
};

const adapter = require('../src/services/wx-login-adapter');
const store = require('../src/models/store');
const reminderModule = require('../src/services/wx-login-reminder');
const { createRuntimeEngine } = require('../src/runtime/runtime-engine');
const { createScheduler, getSchedulerRegistrySnapshot } = require('../src/services/scheduler');

// 出码/保活边界：getFarmCode 按调用时属性访问（可随时换实现）；
// keepWxCredentialAlive 在服务创建时按值捕获，须在引擎创建前替换。
const codeCalls = { n: 0 };
let farmCodeImpl = async () => ({ Success: true, Data: { code: 'unused-fresh' } });
let keepAliveImpl = async () => ({ Success: true });
const originalGetFarmCode = adapter.getFarmCode;
const originalKeepAlive = adapter.keepWxCredentialAlive;
adapter.getFarmCode = async (wxid, opts) => {
  codeCalls.n += 1;
  return farmCodeImpl(wxid, opts);
};
adapter.keepWxCredentialAlive = async account => keepAliveImpl(account);
test.after(() => {
  adapter.getFarmCode = originalGetFarmCode;
  adapter.keepWxCredentialAlive = originalKeepAlive;
});

const flush = async () => { for (let i = 0; i < 8; i++) await new Promise(r => setImmediate(r)); };
const reloginTasks = id => getSchedulerRegistrySnapshot('auto_code_refresh').schedulers
  .flatMap(s => s.tasks.map(task => task.name))
  .filter(name => name === `relogin_${id}`);
const TEMP_ERROR = new Error('connect ETIMEDOUT upstream');

// scheduler 的 auto_code_refresh 命名空间 store 是进程级共享的：各测试
// t.mock.timers reset 只丢弃 mock 时钟，注册表里仍留着上一例的 Timeout
// 句柄；后例 clearAll 清到跨时钟的陈旧句柄时，可能误取消本例刚挂的
// mock 定时器（Node20 MockTimers 缺陷）。与 wx-scan-recovery 的
// schedulerFixture 在 t.after 里 svc.stopAccount 清理同构——引擎不暴露
// autoCodeRefresh，这里用同命名空间的公共 clearAll 清干净共享 store。
function cleanupSharedScheduler(t) {
  t.after(() => {
    try { createScheduler('auto_code_refresh').clearAll(); } catch { /* 已清即可 */ }
  });
}

/** 每测试隔离：暂停其余账号（startAllAccounts 会跳过），重置本测试账号。 */
function isolate(id, fields = {}) {
  for (const acc of store.getAccounts().accounts || []) {
    if (String(acc.id) !== String(id)) store.addOrUpdateAccount({ id: String(acc.id), autoLogin: false });
  }
  workerCalls.start.length = 0;
  workerCalls.restart.length = 0;
  workerCalls.stop.length = 0;
  codeCalls.n = 0;
  farmCodeImpl = async () => ({ Success: true, Data: { code: `fresh-${id}` } });
  keepAliveImpl = async () => ({ Success: true });
  // 恢复间隔固定 1 分钟（迁移保留既有 intervalMinutes），tick 断言可写死节奏。
  store.setAutoCodeRefresh(String(id), { enabled: true, intervalMinutes: 1 });
  store.addOrUpdateAccount({
    id, autoLogin: true, code: '', wxCredentialExpiresAt: Date.now() + 2 * 3600000, ...fields,
  });
  return id;
}

/** 在共享 reminder（引擎读检查点用的同一实例）上种持久待收口检查点。 */
async function seedCheckpoint(id) {
  const reminder = reminderModule.getSharedWxLoginReminder();
  const generation = await reminder.noteAcceptedScan(String(id), {
    owner: `owner-${id}`, wxid: `wx-${id}`,
  });
  assert.equal(typeof generation, 'number', '扫码代次必须推进');
  await reminder.noteScanCodePending(String(id), {
    generation, stage: 'code_pending', error: '换取农场码失败: temp',
    owner: `owner-${id}`, wxid: `wx-${id}`,
  });
  assert.ok(reminder.getScanCheckpoint(String(id)), '检查点种子就绪');
  return { reminder, generation };
}

test('待收口检查点+空 Code：startup 换码临时失败 → 0 Worker、按原间隔挂 1 个恢复任务', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  cleanupSharedScheduler(t);
  const id = isolate('501', { code: '' });
  await seedCheckpoint(id);
  farmCodeImpl = async () => { throw TEMP_ERROR; };
  const engine = createRuntimeEngine({});
  await engine.startAllAccounts();
  assert.equal(workerCalls.start.length + workerCalls.restart.length, 0, '空 Code 绝不拉 Worker');
  assert.equal(reloginTasks(id).length, 1, '恰好一个恢复任务（原队列）');
  // 原间隔 60 分钟：差 1ms 不触发，等满才发起第一次恢复换码。
  t.mock.timers.tick(59_999); await flush();
  assert.equal(codeCalls.n, 1, '恢复任务必须等满原定间隔');
  t.mock.timers.tick(1); await flush();
  assert.equal(codeCalls.n, 2, '等满原间隔后恢复换码恰好触发一次');
  assert.equal(reloginTasks(id).length, 1, '失败后重排仍只有一个任务');
});

test('待收口检查点+旧一次性 Code：临时失败不得回退旧码（0 Worker、挂恢复）', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  cleanupSharedScheduler(t);
  const id = isolate('502', { code: 'stale-one-time-code' });
  await seedCheckpoint(id);
  farmCodeImpl = async () => { throw TEMP_ERROR; };
  const engine = createRuntimeEngine({});
  await engine.startAllAccounts();
  assert.equal(workerCalls.start.length, 0, '检查点在时旧一次性 Code 不是合法回退');
  assert.equal(workerCalls.restart.length, 0);
  assert.deepEqual(workerCalls.start.map(c => c.code), []);
  assert.equal(reloginTasks(id).length, 1);
});

test('无检查点+既有合法 Code：legacy 受控回退保留（拿最新账号态启动）', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  cleanupSharedScheduler(t);
  const id = isolate('503', { code: 'valid-old-code' });
  farmCodeImpl = async () => { throw TEMP_ERROR; };
  const engine = createRuntimeEngine({});
  await engine.startAllAccounts();
  assert.equal(workerCalls.start.length, 1, '临时网络失败+无检查点：受控回退保留');
  assert.deepEqual(workerCalls.start[0], { id, code: 'valid-old-code' });
  assert.equal(workerCalls.restart.length, 0);
  assert.equal(reloginTasks(id).length, 0, '已回退启动的不另挂恢复任务');
});

test('startup 换码成功：按 fresh Code 重启（既有 freshCode 启动路径），不走回退', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  cleanupSharedScheduler(t);
  const id = isolate('504', { code: 'old-code-504' });
  const engine = createRuntimeEngine({});
  await engine.startAllAccounts();
  assert.equal(codeCalls.n, 1);
  assert.equal(workerCalls.restart.length, 1, '成功路径由换码服务按新 Code 重启');
  assert.equal(workerCalls.restart[0].code, `fresh-${id}`);
  assert.equal(workerCalls.start.length, 0, '不再额外走旧快照回退');
  const saved = store.getAccounts().accounts.find(acc => String(acc.id) === id);
  assert.equal(saved.code, `fresh-${id}`, '新 Code 已落盘');
  assert.equal(reloginTasks(id).length, 0);
});

test('明确凭据失效（definitive）：不启动、不排程', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  cleanupSharedScheduler(t);
  const id = isolate('505', { code: 'old-code-505', wxCredentialExpiresAt: 0 });
  keepAliveImpl = async () => ({ Success: false, definitive: true, Message: '微信授权已失效 fixture' });
  const engine = createRuntimeEngine({});
  await engine.startAllAccounts();
  assert.equal(codeCalls.n, 0, '保活已判明确失效，不应再出码');
  assert.equal(workerCalls.start.length + workerCalls.restart.length, 0);
  assert.equal(reloginTasks(id).length, 0, '明确失效不挂恢复任务');
});

test('await 期间账号被暂停：不拿旧快照回退，不启动不排程', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  cleanupSharedScheduler(t);
  const id = isolate('506', { code: 'stale-code-506' });
  await seedCheckpoint(id);
  farmCodeImpl = async () => {
    // startup 换码在途：用户在面板暂停了该账号。
    store.addOrUpdateAccount({ id, autoLogin: false });
    throw TEMP_ERROR;
  };
  const engine = createRuntimeEngine({});
  await engine.startAllAccounts();
  assert.equal(workerCalls.start.length + workerCalls.restart.length, 0, '已暂停不得借启动迁移重开');
  assert.equal(reloginTasks(id).length, 0, '已暂停不挂恢复任务');
});

test('await 期间账号被删除：不启动不排程', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  cleanupSharedScheduler(t);
  const id = isolate('507', { code: 'stale-code-507' });
  await seedCheckpoint(id);
  farmCodeImpl = async () => {
    store.deleteAccount(id);
    throw TEMP_ERROR;
  };
  const engine = createRuntimeEngine({});
  await engine.startAllAccounts();
  assert.equal(workerCalls.start.length + workerCalls.restart.length, 0);
  assert.equal(reloginTasks(id).length, 0);
});

test('await 期间新扫码收口+新 Code 落盘：回退必须用最新 Code，不得用旧快照', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  cleanupSharedScheduler(t);
  const id = isolate('508', { code: '' });
  const { reminder, generation } = await seedCheckpoint(id);
  farmCodeImpl = async () => {
    // startup 换码在途：另一轮人工重试完成收口——检查点清除、新 Code 落盘。
    await reminder.noteScanCodeResolved(String(id), {
      generation, owner: `owner-${id}`, wxid: `wx-${id}`,
    });
    store.addOrUpdateAccount({ id, code: 'midawait-fresh-code' });
    throw TEMP_ERROR;
  };
  const engine = createRuntimeEngine({});
  await engine.startAllAccounts();
  assert.equal(workerCalls.start.length, 1, '无检查点+合法新 Code：受控回退保留');
  assert.equal(workerCalls.start[0].code, 'midawait-fresh-code',
    '回退必须读最新账号态，绝不拿 await 前快照的空 Code');
  assert.equal(reloginTasks(id).length, 0);
});

test('真实 engine.start：rescheduleAll（clearAll）之后恢复任务仍在，且只触发一次', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  cleanupSharedScheduler(t);
  const id = isolate('509', { code: '' });
  await seedCheckpoint(id);
  farmCodeImpl = async () => { throw TEMP_ERROR; };
  const engine = createRuntimeEngine({});
  t.after(() => engine.stopAllAccounts());
  await engine.start({ startAdminServer: false });
  assert.equal(workerCalls.start.length + workerCalls.restart.length, 0, '空 Code 全程不拉 Worker');
  assert.equal(reloginTasks(id).length, 1,
    'start() 的 rescheduleAll 清空调度器后，启动期恢复任务必须被重挂存活');
  // 幸存的任务要真的会触发，且一次 tick 只触发一次（无重复排程）。
  t.mock.timers.tick(60_000); await flush();
  assert.equal(codeCalls.n, 2, '恢复换码在原间隔后真实触发（startup 1 次 + 恢复 1 次）');
  assert.equal(reloginTasks(id).length, 1, '失败重排后仍只有一个任务');
  assert.equal(workerCalls.start.length + workerCalls.restart.length, 0);
});
