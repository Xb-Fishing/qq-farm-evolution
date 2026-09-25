const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farm-credential-runtime-'));
process.env.FARM_DATA_DIR = dataDir;
const adapter = require('../src/services/wx-login-adapter');
const { createAutoCodeRefreshService } = require('../src/runtime/auto-code-refresh');
const { getSchedulerRegistrySnapshot } = require('../src/services/scheduler');
test.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
function fixture(t, keepAlive = async () => ({ Success: true })) {
  const account = { id: 'runtime-fixture', name: 'Fixture', wxid: 'fixture',
    loginBuffer: 'fixture-buffer', refreshtoken: 'fixture-refresh',
    wxCredentialExpiresAt: Date.now() + 2 * 3600000 };
  const counters = { writes: 0, restarts: 0, codeCalls: 0, keepCalls: 0 };
  const original = adapter.getFarmCode;
  adapter.getFarmCode = async () => {
    counters.codeCalls += 1;
    return { Success: true, Data: { code: 'fixture-code' } };
  };
  const svc = createAutoCodeRefreshService({
    store: { isAccountAutoLogin: () => true, getAutoCodeRefresh: () => ({ enabled: true }),
      getKickoutRelogin: () => ({ delayMinutes: 0.00001 }) },
    getAccounts: () => ({ accounts: [account] }),
    addOrUpdateAccount: patch => { Object.assign(account, patch); counters.writes += 1; },
    resolveWorkerControls: () => ({ restartWorker: () => { counters.restarts += 1; } }),
    keepWxCredentialAlive: async () => { counters.keepCalls += 1; return keepAlive(account); },
    getCredentialKeepaliveDelayMs: () => counters.keepCalls === 0 ? 1 : 100000,
    log: () => {}, addAccountLog: () => {},
  });
  t.after(() => { svc.stopAccount(account.id); adapter.getFarmCode = original; });
  return { account, counters, svc };
}
const tasksFor = id => getSchedulerRegistrySnapshot('auto_code_refresh').schedulers
  .flatMap(s => s.tasks.map(task => task.name)).filter(name => name.endsWith(`_${id}`));

test('到期预刷新明确失败后不再申请 Code，新凭据后恢复', async (t) => {
  let terminal = true;
  const { account, counters, svc } = fixture(t, async acc => {
    if (terminal) {
      acc.refreshtoken = 'rotated-fixture-refresh';
      return { Success: false, definitive: true, Message: '微信授权范围已失效' };
    }
    return { Success: true };
  });
  account.wxCredentialExpiresAt = Date.now() - 1;
  assert.equal(await svc.refreshAccountCode(account.id, 'manual_relogin'), false);
  assert.equal(svc.isCredentialBlocked(account.id), true);
  assert.deepEqual(counters, { writes: 0, restarts: 0, codeCalls: 0, keepCalls: 1 });
  assert.equal(await svc.refreshAccountCode(account.id, 'manual_relogin'), false);
  assert.equal(counters.keepCalls, 1);
  // 真正新扫码即便 refresh token 未变，新的 loginBuffer 也应解锁。
  account.loginBuffer = 'new-scan-fixture-buffer';
  terminal = false;
  assert.equal(svc.isCredentialBlocked(account.id), false);
  assert.equal(await svc.refreshAccountCode(account.id, 'manual_relogin'), true);
  assert.equal(counters.restarts, 1);
});

test('保活明确失效清除接管定时器但不停止在线 Worker', async (t) => {
  const observed = deferred();
  const { account, counters, svc } = fixture(t, async () => {
    observed.resolve();
    return { Success: false, definitive: true, Message: '微信授权范围已失效' };
  });
  assert.equal(svc.scheduleRelogin(account.id, 'ws_400'), true);
  await observed.promise;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(svc.isCredentialBlocked(account.id), true);
  assert.deepEqual(tasksFor(account.id), []);
  assert.equal(svc.scheduleRelogin(account.id, 'ws_400'), false);
  assert.equal(counters.codeCalls, 0);
  assert.equal(counters.restarts, 0);
});

test('并发恢复只换一次 Code 并重启一次 Worker', async (t) => {
  const ready = deferred();
  const { account, counters, svc } = fixture(t);
  adapter.getFarmCode = async () => { counters.codeCalls += 1; return ready.promise; };
  const first = svc.refreshAccountCode(account.id, 'ws_400');
  const second = svc.refreshAccountCode(account.id, 'manual_relogin');
  ready.resolve({ Success: true, Data: { code: 'fixture-code' } });
  assert.deepEqual(await Promise.all([first, second]), [true, true]);
  assert.equal(counters.codeCalls, 1);
  assert.equal(counters.writes, 1);
  assert.equal(counters.restarts, 1);
});

test('停止后迟到 Code 不写回也不重新启动账号', async (t) => {
  const ready = deferred();
  const { account, counters, svc } = fixture(t);
  adapter.getFarmCode = async () => ready.promise;
  const pending = svc.refreshAccountCode(account.id, 'manual_relogin');
  svc.stopAccount(account.id);
  ready.resolve({ Success: true, Data: { code: 'late-fixture-code' } });
  assert.equal(await pending, false);
  assert.equal(counters.writes, 0);
  assert.equal(counters.restarts, 0);
});

test('旧保活迟到失败不会重新阻断已扫码新代次', async (t) => {
  const entered = deferred();
  const ready = deferred();
  const { account, svc } = fixture(t, async () => { entered.resolve(); return ready.promise; });
  svc.scheduleAccount(account.id);
  await entered.promise;
  svc.stopAccount(account.id);
  account.loginBuffer = 'new-scan-fixture-buffer';
  svc.scheduleAccount(account.id);
  ready.resolve({ Success: false, definitive: true, Message: '微信授权范围已失效' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(svc.isCredentialBlocked(account.id), false);
  // 在新保活自身执行前停止；旧调用不能移除新代次任务。
  assert.ok(tasksFor(account.id).includes(`wx_keepalive_${account.id}`));
  svc.stopAccount(account.id);
});

test('临时续期失败允许仍有效的现有凭据获取 Code', async (t) => {
  const { account, counters, svc } = fixture(t, async () => ({ Success: false, Message: 'temporary timeout' }));
  account.wxCredentialExpiresAt = Date.now() - 1;
  assert.equal(await svc.refreshAccountCode(account.id, 'manual_relogin'), true);
  assert.equal(svc.isCredentialBlocked(account.id), false);
  assert.equal(counters.codeCalls, 1);
  assert.equal(counters.restarts, 1);
});


test('重新扫码后的恢复不加入旧代次未完成的请求', async (t) => {
  const old = deferred();
  const { account, counters, svc } = fixture(t);
  adapter.getFarmCode = async () => {
    counters.codeCalls += 1;
    return counters.codeCalls === 1 ? old.promise : { Success: true, Data: { code: 'new-fixture-code' } };
  };
  const pending = svc.refreshAccountCode(account.id, 'manual_relogin');
  svc.stopAccount(account.id);
  account.loginBuffer = 'new-scan-fixture-buffer';
  assert.equal(await svc.refreshAccountCode(account.id, 'manual_relogin'), true);
  old.resolve({ Success: true, Data: { code: 'old-fixture-code' } });
  assert.equal(await pending, false);
  assert.equal(account.code, 'new-fixture-code');
  assert.equal(counters.restarts, 1);
});


test('接管请求期间手动停止，迟到失败不能重新挂接管定时器', async (t) => {
  const entered = deferred();
  const old = deferred();
  const { account, svc } = fixture(t);
  adapter.getFarmCode = async () => { entered.resolve(); return old.promise; };
  assert.equal(svc.scheduleKickoutRelogin(account.id, 'kickout:test'), true);
  await entered.promise;
  svc.stopAccount(account.id);
  old.resolve({ Success: false, Message: 'temporary timeout' });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(tasksFor(account.id), []);
});
