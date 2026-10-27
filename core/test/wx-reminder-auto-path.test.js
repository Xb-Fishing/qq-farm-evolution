const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/**
 * 微信失效提醒的自动触发边界（auto-code-refresh / relogin-reminder）。
 * 基线可运行：只 import 7e03ada 已存在的模块，通过对既有 API 注入
 * onWxCredentialDefinitivelyInvalid / shouldSkipOfflineReminder 依赖，
 * 在旧代码上以行为（回调未触发/跳过未生效）失败，而非 import 失败。
 */

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farm-wx-reminder-auto-'));
process.env.FARM_DATA_DIR = dataDir;
const adapter = require('../src/services/wx-login-adapter');
const { createAutoCodeRefreshService } = require('../src/runtime/auto-code-refresh');
const { createReloginReminderService } = require('../src/runtime/relogin-reminder');
test.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function fixture(t, keepAlive = async () => ({ Success: true }), { platform = 'wx' } = {}) {
  const account = {
    id: `auto-fixture-${platform}`, name: 'AutoFixture', platform,
    username: 'fixture-owner', wxid: 'fixture-openid',
    loginBuffer: 'fixture-buffer', refreshtoken: 'fixture-refresh',
    wxCredentialExpiresAt: Date.now() + 2 * 3600000,
  };
  const counters = { keepCalls: 0 };
  const callbacks = [];
  const original = adapter.getFarmCode;
  adapter.getFarmCode = async () => ({ Success: true, Data: { code: 'fixture-code' } });
  const svc = createAutoCodeRefreshService({
    store: { isAccountAutoLogin: () => true, getAutoCodeRefresh: () => ({ enabled: true }),
      getKickoutRelogin: () => ({ delayMinutes: 0.00001 }) },
    getAccounts: () => ({ accounts: [account] }),
    addOrUpdateAccount: patch => Object.assign(account, patch),
    resolveWorkerControls: () => ({ restartWorker: () => {} }),
    keepWxCredentialAlive: async acc => { counters.keepCalls += 1; return keepAlive(acc); },
    getCredentialKeepaliveDelayMs: () => (counters.keepCalls === 0 ? 1 : 100000),
    log: () => {}, addAccountLog: () => {},
    // 被测注入点：明确失效时的微信重扫提醒回调。
    onWxCredentialDefinitivelyInvalid: snapshot => callbacks.push(snapshot),
  });
  t.after(() => { svc.stopAccount(account.id); adapter.getFarmCode = original; });
  return { account, counters, callbacks, svc };
}

test('到期预刷新明确失效：触发一次微信重扫回调并携带绑定快照', async (t) => {
  const { account, callbacks, svc } = fixture(t, async acc => {
    acc.refreshtoken = 'rotated-fixture-refresh';
    return { Success: false, definitive: true, Message: '微信授权范围已失效' };
  });
  account.wxCredentialExpiresAt = Date.now() - 1;
  assert.equal(await svc.refreshAccountCode(account.id, 'manual_relogin'), false);
  assert.equal(svc.isCredentialBlocked(account.id), true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(callbacks.length, 1, '应恰好触发一次提醒回调');
  assert.deepEqual(callbacks[0], {
    accountId: account.id,
    owner: 'fixture-owner',
    wxid: 'fixture-openid',
  }, '回调必须携带稳定绑定快照（属主/wxid），而非延迟取当前值');
});

test('保活明确失效（keepalive 终态路径）也触发一次回调', async (t) => {
  const observed = deferred();
  const { account, callbacks, svc } = fixture(t, async () => {
    observed.resolve();
    return { Success: false, definitive: true, Message: '微信登录凭证已失效，请在面板重新扫码登录' };
  });
  assert.equal(svc.scheduleRelogin(account.id, 'ws_400'), true);
  await observed.promise;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(callbacks.length, 1, 'keepalive 终态路径同样要通知');
  assert.equal(callbacks[0].accountId, account.id);
});

test('健康滚动续期不触发提醒回调', async (t) => {
  const { account, counters, callbacks, svc } = fixture(t, async () => ({
    Success: true, expiresAt: Date.now() + 24 * 3600000, refreshTokenRotated: true,
  }));
  account.wxCredentialExpiresAt = Date.now() - 1;
  assert.equal(await svc.refreshAccountCode(account.id, 'manual_relogin'), true);
  assert.equal(counters.keepCalls, 1);
  assert.equal(svc.isCredentialBlocked(account.id), false);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(callbacks.length, 0, '正常续期绝不提醒');
});

test('临时网络失败不触发提醒回调，也不阻断凭据', async (t) => {
  const { account, callbacks, svc } = fixture(t, async () => ({
    Success: false, Message: '无法连接微信服务器（网络波动），请稍后重试',
  }));
  account.wxCredentialExpiresAt = Date.now() - 1;
  await svc.refreshAccountCode(account.id, 'manual_relogin');
  assert.equal(svc.isCredentialBlocked(account.id), false, '网络波动不得判定凭据失效');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(callbacks.length, 0, '临时失败绝不提醒');
});

test('QQ 账号即使错误文案命中明确失效也不触发微信重扫回调', async (t) => {
  const { account, callbacks, svc } = fixture(t, async () => ({
    Success: false, definitive: true, Message: '微信授权范围已失效',
  }), { platform: 'qq' });
  account.wxCredentialExpiresAt = Date.now() - 1;
  await svc.refreshAccountCode(account.id, 'manual_relogin');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(callbacks.length, 0, '微信重扫提醒只面向原生 WX 账号');
});

test('回调抛错/拒绝不影响凭据阻断与刷新流程', async (t) => {
  const { account } = fixture(t, async acc => {
    acc.refreshtoken = 'rotated-again';
    return { Success: false, definitive: true, Message: '微信授权范围已失效' };
  });
  const svc2 = createAutoCodeRefreshService({
    store: { isAccountAutoLogin: () => true, getAutoCodeRefresh: () => ({ enabled: true }) },
    getAccounts: () => ({ accounts: [account] }),
    addOrUpdateAccount: () => {},
    resolveWorkerControls: () => ({ restartWorker: () => {} }),
    keepWxCredentialAlive: async () => ({ Success: false, definitive: true, Message: '微信授权范围已失效' }),
    getCredentialKeepaliveDelayMs: () => 100000,
    log: () => {}, addAccountLog: () => {},
    onWxCredentialDefinitivelyInvalid: () => { throw new Error('reminder exploded'); },
  });
  t.after(() => svc2.stopAccount(account.id));
  account.wxCredentialExpiresAt = Date.now() - 1;
  let completed = false;
  await assert.doesNotReject(async () => {
    await svc2.refreshAccountCode(account.id, 'manual_relogin');
    completed = true;
  });
  assert.equal(completed, true);
  assert.equal(svc2.isCredentialBlocked(account.id), true, '阻断语义不受提醒故障影响');
});

test('微信重扫提醒已认领时跳过通用下线推送（QQ/普通路径不变）', async () => {
  const sent = [];
  const skips = [];
  const FIXTURE_PUSH_TOKEN = '[REDACTED]';
  const build = shouldSkip => createReloginReminderService({
    store: { getOfflineReminder: () => ({
      channel: 'pushoo', token: FIXTURE_PUSH_TOKEN, title: '账号下线提醒', msg: '账号已离线',
      offlineDeleteSec: 0, reloginUrlMode: 'none',
    }) },
    miniProgramLoginSession: null,
    sendPushooMessage: async payload => { sent.push(payload); return { ok: true }; },
    sendSmtpEmail: async () => ({ ok: true }),
    log: (level, message) => { if (message.includes('跳过')) skips.push(message); },
    addAccountLog: () => {},
    getAccounts: () => ({ accounts: [{ id: 'wx-acc', username: 'fixture-owner', platform: 'wx' }] }),
    addOrUpdateAccount: () => {},
    resolveWorkerControls: () => ({}),
    ...(shouldSkip ? { shouldSkipOfflineReminder: ({ accountId }) => accountId === 'wx-acc' } : {}),
  });
  await build(true).triggerOfflineReminder({ accountId: 'wx-acc', accountName: 'A', reason: 'kickout_101' });
  assert.equal(sent.length, 0, '已被重扫提醒覆盖的失效不得再发通用下线推送');
  assert.equal(skips.length, 1, '应留下跳过日志');
  await build(false).triggerOfflineReminder({ accountId: 'qq-acc', accountName: 'B', reason: 'offline' });
  assert.equal(sent.length, 1, 'QQ/普通掉线路径不受影响');
  assert.ok(sent[0].title.includes('B'));
});
