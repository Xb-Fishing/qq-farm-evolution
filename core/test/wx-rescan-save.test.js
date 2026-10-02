'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/**
 * 自助重扫保存链（wx-rescan-save.completeOwnedWxRescan）回归：
 * 主审反例4（isCurrent 失效仍写凭据/重启）与反例5（拿旧 code 重启、
 * 从不换新码）。真实 store + 真实 adapter 锁原语，只在网络边界
 * （getFarmCode / peek / consume）打桩；结尾再用真实提醒服务工厂 +
 * 真实保存链做一条端到端 happy path（pending → saved、重启恰好一次）。
 */

const FIXTURE_ACCESS_BEFORE = 'fixture-access-before';
const FIXTURE_ACCESS_AFTER = 'fixture-access-after';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farm-wxrs-'));
process.env.FARM_DATA_DIR = dataDir;
fs.writeFileSync(path.join(dataDir, 'accounts.json'), JSON.stringify({
  accounts: [{
    id: '201', name: '农场号X', platform: 'wx', username: 'ownerX',
    wxid: 'openid-X', code: 'stale-code', loginBuffer: 'old-buffer',
    refreshtoken: 'old-refresh', accesstoken: FIXTURE_ACCESS_BEFORE,
  }],
  nextId: 202,
}));

const adapter = require('../src/services/wx-login-adapter');
const store = require('../src/models/store');
const { completeOwnedWxRescan } = require('../src/services/wx-rescan-save');
const reminderModule = require('../src/services/wx-login-reminder');

const PNG_B64 = Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47]), Buffer.alloc(32)]).toString('base64');

const order = [];
const calls = { farmCode: [], peek: [], consume: [], notes: [] };
const pendingCreds = {
  loginBuffer: 'rotated-buffer', refreshtoken: 'rotated-refresh',
  accesstoken: FIXTURE_ACCESS_AFTER, wxCredentialExpiresAt: 123, wxCredentialExpiresIn: 456,
  wxRefreshTokenObservedAt: 789, wxCredentialLastSuccessAt: 999, avatar: 'a.png',
};
let farmCodeGate = null;
let farmCodeResult = () => ({ Success: true, Data: { code: 'fresh-code-1' } });

const originalGetFarmCode = adapter.getFarmCode;
const originalPeek = adapter.peekPendingWxInfo;
const originalConsume = adapter.consumePendingWxInfo;
adapter.getFarmCode = async (openid, opts) => {
  calls.farmCode.push({ openid, opts });
  if (farmCodeGate) await farmCodeGate();
  return farmCodeResult();
};
adapter.peekPendingWxInfo = (sessionId, openid, owner) => {
  calls.peek.push({ sessionId, openid, owner });
  return pendingCreds;
};
adapter.consumePendingWxInfo = (sessionId, openid, owner) => {
  calls.consume.push({ sessionId, openid, owner, at: order.length });
  order.push('consume');
};
test.after(() => {
  adapter.getFarmCode = originalGetFarmCode;
  adapter.peekPendingWxInfo = originalPeek;
  adapter.consumePendingWxInfo = originalConsume;
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function readAccount(id = '201') {
  const data = store.getAccounts();
  return (data.accounts || []).find(acc => String(acc.id) === String(id)) || null;
}

function baseProvider(overrides = {}) {
  const counts = { restart: 0, start: 0, startFromSavedCode: 0, invalidate: 0, autoCode: [] };
  const provider = {
    counts,
    isAccountRunning: () => true,
    restartAccount: async () => { counts.restart += 1; order.push('restart'); },
    startAccount: async () => { counts.start += 1; order.push('start'); return true; },
    startAccountFromSavedWxCode: async (key, code) => {
      counts.startFromSavedCode += 1; provider.savedCode = code; order.push('startFromSavedCode'); return true;
    },
    invalidateAccountCredentialTasks: () => { counts.invalidate += 1; order.push('invalidate'); },
    saveAutoCodeRefresh: async (key, cfg) => { counts.autoCode.push({ key, cfg }); },
    ...overrides,
  };
  return provider;
}

function reminderStub() {
  return {
    noteSessionConsumed: (sessionId, accountId) => { calls.notes.push({ type: 'consumed', sessionId, accountId }); },
    noteAcceptedScan: async (accountId, options) => { calls.notes.push({ type: 'accepted', accountId, options }); },
  };
}

function baseArgs(overrides = {}) {
  return {
    accountId: '201', sessionId: 'sess-9', openid: 'openid-X', owner: 'ownerX',
    isCurrent: () => true, provider: baseProvider(), reminder: reminderStub(),
    ...overrides,
  };
}

function resetCalls() {
  calls.farmCode.length = 0; calls.peek.length = 0; calls.consume.length = 0; calls.notes.length = 0;
  order.length = 0;
  // 各用例共享同一 store：重置回种子态，断言「未被写」才有意义。
  store.addOrUpdateAccount({
    id: '201', platform: 'wx', username: 'ownerX', wxid: 'openid-X',
    code: 'stale-code', loginBuffer: 'old-buffer',
    refreshtoken: 'old-refresh', accesstoken: FIXTURE_ACCESS_BEFORE,
  });
}

test('反例4回归：isCurrent 失效（入口）→ 不换码、不写、不启动', async () => {
  resetCalls();
  const args = baseArgs({ isCurrent: () => false });
  const result = await completeOwnedWxRescan(args);
  assert.equal(result.superseded, true);
  assert.equal(result.ok, false);
  assert.equal(calls.farmCode.length, 0, '守卫失败不得发起换码');
  assert.equal(readAccount().code, 'stale-code', 'store 不得被写');
  assert.equal(args.provider.counts.restart, 0);
});

test('反例4回归：isCurrent 在换码后失效 → 已换的码丢弃，不保存不启动', async () => {
  resetCalls();
  let gateResolve;
  farmCodeGate = () => new Promise(resolve => { gateResolve = resolve; });
  let guardCalls = 0;
  const guard = () => (++guardCalls) <= 1; // 入口通过，换码后失败
  const args = baseArgs({ isCurrent: guard });
  const pending = completeOwnedWxRescan(args);
  await new Promise(resolve => setImmediate(resolve));
  gateResolve();
  const result = await pending;
  farmCodeGate = null;
  assert.equal(result.superseded, true);
  assert.equal(calls.farmCode.length, 1, '只允许一次换码尝试');
  assert.equal(calls.consume.length, 0, '未保存不得消费一次性会话');
  assert.equal(readAccount().code, 'stale-code');
  assert.equal(args.provider.counts.restart + args.provider.counts.start, 0);
});

test('反例4回归：isCurrent 在账号锁内失效 → 抛出 superseded，store 原样', async () => {
  resetCalls();
  let guardCalls = 0;
  const guard = () => (++guardCalls) <= 2; // 入口+换码后通过，锁内失败
  const args = baseArgs({ isCurrent: guard });
  const result = await completeOwnedWxRescan(args);
  assert.equal(result.superseded, true);
  assert.equal(calls.consume.length, 0);
  assert.equal(readAccount().code, 'stale-code');
  assert.equal(readAccount().loginBuffer, 'old-buffer');
});

test('happy path：先换新码（无 accountId、锁外）→ 锁内保存最新轮换凭据 → 消费 → 重启恰好一次', async () => {
  resetCalls();
  const args = baseArgs();
  const result = await completeOwnedWxRescan(args);
  assert.deepEqual(result, { ok: true, started: true, savedAccount: result.savedAccount });
  // 换码走属主扫码会话、在账号锁外（不带 accountId）。
  assert.equal(calls.farmCode.length, 1);
  assert.equal(calls.farmCode[0].openid, 'openid-X');
  assert.deepEqual(calls.farmCode[0].opts, { sessionId: 'sess-9', owner: 'ownerX' });
  assert.ok(!('accountId' in calls.farmCode[0].opts), '换码选项不得携带 accountId（必须在账号锁外）');
  // 保存的是新 code 与锁内重读到的最新轮换凭据。
  const saved = readAccount();
  assert.equal(saved.code, 'fresh-code-1', '保存并重启必须用新换的 code（反例5）');
  assert.equal(saved.loginBuffer, 'rotated-buffer');
  assert.equal(saved.refreshtoken, 'rotated-refresh');
  assert.equal(saved.platform, 'wx');
  // 顺序：失效旧任务 → 持久化 → 消费会话 → 重启；消费必须在保存之后。
  assert.deepEqual(order, ['invalidate', 'consume', 'restart']);
  assert.equal(args.provider.counts.restart, 1);
  assert.equal(args.provider.counts.start + args.provider.counts.startFromSavedCode, 0);
  // 提醒服务收到自身完成语义（keepSessionId=同一会话）。
  assert.equal(calls.notes.length, 2);
  assert.deepEqual(calls.notes[1], {
    type: 'accepted', accountId: '201', options: { keepSessionId: 'sess-9' },
  });
});

test('离线账号：保存后走 保存自动换码 + 用已存新码启动，不额外再换一次码', async () => {
  resetCalls();
  const provider = baseProvider({ isAccountRunning: () => false });
  const result = await completeOwnedWxRescan(baseArgs({ provider }));
  assert.equal(result.ok, true);
  assert.equal(result.started, true);
  assert.equal(calls.farmCode.length, 1, '离线路径同样只换一次码');
  assert.deepEqual(provider.counts.autoCode, [{ key: '201', cfg: { enabled: true, intervalMinutes: 60 } }]);
  assert.equal(provider.counts.startFromSavedCode, 1);
  assert.equal(provider.counts.start, 0);
  assert.equal(provider.savedCode, 'fresh-code-1', '必须用刚保存的新码启动');
});

test('离线且运行时不支持从已存码启动 → 回退 startAccount；启动被拒如实报告 started:false', async () => {
  resetCalls();
  const legacy = baseProvider({
    isAccountRunning: () => false,
    startAccountFromSavedWxCode: undefined,
  });
  delete legacy.startAccountFromSavedWxCode;
  const okResult = await completeOwnedWxRescan(baseArgs({ provider: legacy }));
  assert.equal(okResult.ok, true);
  assert.equal(legacy.counts.start, 1, '旧运行时回退 startAccount');

  resetCalls();
  const refused = baseProvider({
    isAccountRunning: () => false,
    startAccountFromSavedWxCode: async () => false,
  });
  const result = await completeOwnedWxRescan(baseArgs({ provider: refused }));
  assert.equal(result.ok, true, '保存是事实');
  assert.equal(result.started, false, '启动被拒不冒充成功');
  assert.ok(result.error.length > 0);
  // 保存已发生：会话已消费。
  assert.equal(calls.consume.length, 1);
});

test('换码临时失败 → retryable 且保留一次性会话（不消费、不重启、不写 store）', async () => {
  resetCalls();
  farmCodeResult = () => { throw new Error('connect ETIMEDOUT upstream'); };
  const args = baseArgs();
  const result = await completeOwnedWxRescan(args);
  farmCodeResult = () => ({ Success: true, Data: { code: 'fresh-code-1' } });
  assert.equal(result.ok, false);
  assert.equal(result.retryable, true);
  assert.equal(calls.consume.length, 0, '临时失败不得吞掉一次性 OAuth 检查点');
  assert.equal(readAccount().code, 'stale-code');
  assert.equal(args.provider.counts.restart, 0);
});

test('换码明确失效（授权范围失效）→ 终态错误，非 retryable', async () => {
  resetCalls();
  farmCodeResult = () => ({ Success: false, Message: '微信授权范围已失效' });
  const result = await completeOwnedWxRescan(baseArgs());
  farmCodeResult = () => ({ Success: true, Data: { code: 'fresh-code-1' } });
  assert.equal(result.ok, false);
  assert.equal(result.retryable, undefined);
  assert.match(result.error, /重新发送二维码/);
  assert.equal(calls.consume.length, 0);
});

test('扫码微信与账号绑定不一致 → 拒绝保存且不发起换码（换绑只能走面板编辑）', async () => {
  resetCalls();
  const result = await completeOwnedWxRescan(baseArgs({ openid: 'openid-OTHER' }));
  assert.equal(result.ok, false);
  assert.match(result.error, /不一致/);
  assert.equal(calls.farmCode.length, 0);
  assert.equal(readAccount().code, 'stale-code');
});

test('属主不匹配 → 拒绝保存', async () => {
  resetCalls();
  const result = await completeOwnedWxRescan(baseArgs({ owner: 'someone-else' }));
  assert.equal(result.ok, false);
  assert.match(result.error, /属主/);
  assert.equal(calls.farmCode.length, 0);
});

test('重启抛错 → 保存仍为事实（ok:true），启动失败如实带回', async () => {
  resetCalls();
  const provider = baseProvider({
    restartAccount: async () => { throw new Error('worker boot failed'); },
  });
  const result = await completeOwnedWxRescan(baseArgs({ provider }));
  assert.equal(result.ok, true);
  assert.equal(result.started, false);
  assert.match(result.error, /启动失败/);
  assert.equal(readAccount().code, 'fresh-code-1', '凭据已落盘');
  assert.equal(calls.consume.length, 1);
});

test('真实服务工厂 + 真实保存链端到端：守望完成扫码 → pending 变 saved、重启恰好一次、代次推进', async () => {
  resetCalls();
  const registryFile = path.join(dataDir, 'wx-login-reminder-e2e.json');
  const sent = [];
  let checkCount = 0;
  const provider = baseProvider();
  const hybridAdapter = {
    ...adapter,
    getQRCode: async () => ({
      Success: true,
      Data: {
        Uuid: 'e2e-sess-1', QrBase64: PNG_B64,
        CreatedAt: Date.now(), ExpiresAt: Date.now() + 300_000,
      },
    }),
    checkQR: async () => {
      checkCount += 1;
      return checkCount === 1
        ? { Success: true, Data: { status: 0 } }
        : { Success: true, Data: { acctSectResp: { userName: 'openid-X' } } };
    },
  };
  const service = reminderModule.createWxLoginReminderService({
    getAccounts: store.getAccounts,
    log: () => {}, addAccountLog: () => {},
    fetchImpl: async (url, init) => { sent.push({ url, init }); return { ok: true, status: 200, json: async () => ({ code: 200 }) }; },
    watcherPollMs: 5,
    adapter: hybridAdapter,
    completeRescan: opts => completeOwnedWxRescan({ ...opts, provider, reminder: service }),
    registryFile: () => registryFile,
  });
  await service.setUserConfig('ownerX', {
    enabled: true, deviceKey: 'owner-x-key', serverUrl: 'https://panel.example.com',
  });
  const push = await service.requestQrPush({ account: readAccount() });
  assert.equal(push.session.sessionId, 'e2e-sess-1');
  assert.equal(push.pushed, true, '属主配置就绪时推送成功');
  assert.ok(String(sent[0].init.body).includes('"image":"https://panel.example.com/api/wx-login-qr-image/'));

  const deadline = Date.now() + 5000;
  while (Date.now() < deadline
    && (!service.getPendingSession('201') || service.getPendingSession('201').state !== 'saved')) {
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  const final = service.getPendingSession('201');
  assert.equal(final && final.state, 'saved', '真实保存链完成后自身 pending 保留为 saved（keepSessionId 语义）');
  assert.equal(readAccount().code, 'fresh-code-1', '真实 store 已写入新码');
  assert.deepEqual(order, ['invalidate', 'consume', 'restart'], '执行顺序与单测一致');
  assert.equal(provider.counts.restart, 1, '重启恰好一次');
  assert.equal(calls.consume.length, 1, '一次性会话恰好消费一次');
  // 新扫码代次已推进：旧图片能力立即吊销。
  assert.equal(service.getQrImage(push.imageToken), null);
  // 守望终态后停止轮询。
  const polls = checkCount;
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(checkCount, polls, 'saved 后守望不得继续轮询');
});
