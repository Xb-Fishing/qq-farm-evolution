'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/**
 * D 组「旧行为基线」：只用旧树（base 2e7c306）就存在的接口——旧
 * completeOwnedWxRescan(accountId/sessionId/openid/owner/isCurrent/
 * provider/reminder)、旧 dataProvider（startAccountFromSavedWxCode 等）、
 * 旧 reminder 面板回调（noteSessionConsumed/noteAcceptedScan）。
 *
 * 断言的是本轮修复的行为，旧树上必须是真实的断言失败（不是缺助手的
 * TypeError）：换码临时失败时已确认凭据已落盘且旧 Code 已作废；启动被
 * 明确拒绝时 started 必须为 false；dataProvider 必须透传 startWorker 的
 * false。不得使用 noteScanCodePending、getScanCheckpoint、retrySaved、
 * scheduleRescanRecovery 等新接口。
 */

// 合成测试值统一以命名常量存放（denylist 规范），字段与断言只引用常量。
const FIXTURE_ACCESS_OLD = 'old-access';
const FIXTURE_ACCESS_Y = 'access-Y';
const FIXTURE_ACCESS_CONFIRMED = 'confirmed-access';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farm-wxold-'));
process.env.FARM_DATA_DIR = dataDir;
fs.writeFileSync(path.join(dataDir, 'accounts.json'), JSON.stringify({
  accounts: [{
    id: '201', name: '农场号X', platform: 'wx', username: 'ownerX',
    wxid: 'openid-X', code: 'stale-code', loginBuffer: 'old-buffer',
    refreshtoken: 'old-refresh', accesstoken: FIXTURE_ACCESS_OLD,
  }, {
    id: '401', name: '农场号Y', platform: 'wx', username: 'ownerY',
    wxid: 'openid-Y', code: 'expected-new-code', loginBuffer: 'buffer-Y',
    refreshtoken: 'refresh-Y', accesstoken: FIXTURE_ACCESS_Y, autoLogin: true,
  }],
  nextId: 402,
}));
test.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

const adapter = require('../src/services/wx-login-adapter');
const store = require('../src/models/store');
const { completeOwnedWxRescan } = require('../src/services/wx-rescan-save');

const calls = { farmCode: [], peek: [], consume: [] };
const pendingCreds = {
  loginBuffer: 'confirmed-buffer', refreshtoken: 'confirmed-refresh',
  accesstoken: FIXTURE_ACCESS_CONFIRMED, wxCredentialExpiresAt: 123,
  wxCredentialExpiresIn: 456, wxRefreshTokenObservedAt: 789,
  wxCredentialLastSuccessAt: 999, avatar: 'a.png',
};
let farmCodeImpl = () => ({ Success: true, Data: { code: 'fresh-code-1' } });
const originalGetFarmCode = adapter.getFarmCode;
const originalPeek = adapter.peekPendingWxInfo;
const originalConsume = adapter.consumePendingWxInfo;
adapter.getFarmCode = async (openid, opts) => {
  calls.farmCode.push({ openid, opts });
  return farmCodeImpl();
};
adapter.peekPendingWxInfo = () => pendingCreds;
adapter.consumePendingWxInfo = () => { calls.consume.push(1); };
test.after(() => {
  adapter.getFarmCode = originalGetFarmCode;
  adapter.peekPendingWxInfo = originalPeek;
  adapter.consumePendingWxInfo = originalConsume;
});

function readAccount(id) {
  const data = store.getAccounts();
  return (data.accounts || []).find(acc => String(acc.id) === String(id)) || null;
}

function reset201() {
  calls.farmCode.length = 0;
  calls.consume.length = 0;
  farmCodeImpl = () => ({ Success: true, Data: { code: 'fresh-code-1' } });
  store.addOrUpdateAccount({
    id: '201', platform: 'wx', username: 'ownerX', wxid: 'openid-X',
    code: 'stale-code', loginBuffer: 'old-buffer',
    refreshtoken: 'old-refresh', accesstoken: FIXTURE_ACCESS_OLD,
  });
}

function oldProvider(overrides = {}) {
  const counts = { restart: 0, start: 0, startFromSavedCode: 0, invalidate: 0, autoCode: [] };
  const provider = {
    counts,
    isAccountRunning: () => true,
    restartAccount: async () => { counts.restart += 1; return true; },
    startAccount: async () => { counts.start += 1; return true; },
    startAccountFromSavedWxCode: async () => { counts.startFromSavedCode += 1; return true; },
    invalidateAccountCredentialTasks: () => { counts.invalidate += 1; },
    saveAutoCodeRefresh: async (key, cfg) => { counts.autoCode.push({ key, cfg }); },
    ...overrides,
  };
  return provider;
}

// 只用旧树就存在的 reminder 回调面。
function oldReminderStub() {
  return {
    noteSessionConsumed: () => {},
    noteAcceptedScan: async () => 1,
  };
}

function oldArgs(overrides = {}) {
  return {
    accountId: '201', sessionId: 'sess-9', openid: 'openid-X', owner: 'ownerX',
    isCurrent: () => true, provider: oldProvider(), reminder: oldReminderStub(),
    ...overrides,
  };
}

test('换码临时失败：已确认凭据必须已落盘、旧一次性 Code 必须已作废（凭据先于换码）', async () => {
  reset201();
  farmCodeImpl = () => { throw new Error('connect ETIMEDOUT upstream'); };
  const args = oldArgs();
  const result = await completeOwnedWxRescan(args);
  assert.equal(result.ok, false);
  assert.equal(result.retryable, true, '临时失败可重试');
  const saved = readAccount('201');
  assert.equal(saved.loginBuffer, 'confirmed-buffer', '人工确认过的授权不得因换码临时失败丢失');
  assert.equal(saved.refreshtoken, 'confirmed-refresh');
  assert.equal(saved.accesstoken, FIXTURE_ACCESS_CONFIRMED);
  assert.equal(saved.code, '', '旧一次性 Code 必须作废，不得拿旧码冒充新授权');
  assert.equal(calls.consume.length, 1, '一次性会话在凭据落盘后即消费');
  assert.equal(args.provider.counts.restart + args.provider.counts.start, 0, '换码失败不得启动');
});

test('重启被明确拒绝（restartAccount=false）：started 必须为 false，不冒充在线', async () => {
  reset201();
  const provider = oldProvider({ restartAccount: async () => false });
  const result = await completeOwnedWxRescan(oldArgs({ provider }));
  assert.equal(result.ok, true, '凭据保存是事实');
  assert.equal(result.started, false, '运行时明确拒绝重启时不得上报已启动');
  assert.equal(readAccount('201').code, 'fresh-code-1', '新换的 Code 已落盘');
});

test('dataProvider.startAccountFromSavedWxCode：startWorker 拒绝（false）必须如实透传', () => {
  const callsStart = [];
  const { createDataProvider } = require('../src/runtime/data-provider');
  const provider = createDataProvider({
    workers: {},
    globalLogs: [],
    accountLogs: [],
    store,
    getAccounts: store.getAccounts,
    callWorkerApi: async () => { throw new Error('not running'); },
    buildDefaultStatus: () => ({}),
    normalizeStatusForPanel: status => status,
    filterLogs: logs => logs,
    nextConfigRevision: () => 1,
    broadcastConfigToWorkers: () => {},
    startWorker: () => { callsStart.push(1); return false; },
    stopWorker: () => {},
    restartWorker: () => false,
    scheduleAutoCodeRefresh: () => {},
    stopAutoCodeRefresh: () => {},
    refreshAccountCode: async () => false,
    needsWxRescan: () => false,
  });
  assert.equal(provider.startAccountFromSavedWxCode('401', 'expected-new-code'), false,
    'startWorker 拒绝启动时不得返回 true（不冒充已启动）');
  assert.equal(callsStart.length, 1);
});
