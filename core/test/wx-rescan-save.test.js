'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/**
 * 自助重扫保存链（wx-rescan-save，2026-10-04 凭据优先重排）回归：
 * 已确认的完整长凭据必须在任何换码 await 之前、在既有账号锁内落盘并作废
 * 旧 Code/旧任务（换码临时失败、会话到期都不再丢授权）；农场 Code 一律用
 * 「已持久化凭据 + 显式 accountId + 独立 rescan 意图键」换发，绝不依赖已
 * 消费的一次性会话；isCurrent 守卫在入口、每个 await 之后、每个副作用之前
 * 复验；同一会话的孪生完成不二次推进代次；启动结果如实透传（false/排队≠
 * 在线），失败保留 start_pending 检查点供显式重试。真实 store + 真实 adapter
 * 锁原语，只在网络边界（getFarmCode / peek / consume）打桩；结尾用真实提醒
 * 服务工厂 + 真实保存链做一条端到端（pending → saved、重启恰好一次）。
 */

const FIXTURE_ACCESS_BEFORE = 'fixture-access-before';
const FIXTURE_ACCESS_AFTER = 'fixture-access-after';
const FIXTURE_ACCESS_PREVIOUS = 'fixture-access-previous-round';

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
const { completeOwnedWxRescan, retrySavedWxScanLogin } = require('../src/services/wx-rescan-save');
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
let peekResult = () => pendingCreds;

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
  return peekResult();
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
    restartAccount: async () => { counts.restart += 1; order.push('restart'); return true; },
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

function reminderStub({ generation = 3, accepted = generation } = {}) {
  return {
    noteSessionConsumed: (sessionId, accountId) => { calls.notes.push({ type: 'consumed', sessionId, accountId }); },
    noteAcceptedScan: async (accountId, options) => {
      calls.notes.push({ type: 'accepted', accountId, options });
      return accepted;
    },
    noteScanCodePending: async (accountId, options) => { calls.notes.push({ type: 'pending', accountId, options }); },
    noteScanCodeResolved: async (accountId, options) => { calls.notes.push({ type: 'resolved', accountId, options }); },
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
  farmCodeGate = null;
  farmCodeResult = () => ({ Success: true, Data: { code: 'fresh-code-1' } });
  peekResult = () => pendingCreds;
  // 各用例共享同一 store：重置回种子态，断言「未被写」才有意义。
  store.addOrUpdateAccount({
    id: '201', platform: 'wx', username: 'ownerX', wxid: 'openid-X',
    code: 'stale-code', loginBuffer: 'old-buffer',
    refreshtoken: 'old-refresh', accesstoken: FIXTURE_ACCESS_BEFORE,
  });
}

const acceptedNotes = () => calls.notes.filter(note => note.type === 'accepted');
const pendingNotes = () => calls.notes.filter(note => note.type === 'pending');
const resolvedNotes = () => calls.notes.filter(note => note.type === 'resolved');

test('守卫入口即失效 → 不读会话、不换码、不写、不启动（superseded）', async () => {
  resetCalls();
  const args = baseArgs({ isCurrent: () => false });
  const result = await completeOwnedWxRescan(args);
  assert.equal(result.superseded, true);
  assert.equal(result.ok, false);
  assert.equal(calls.peek.length, 0, '守卫失败时连会话都不读');
  assert.equal(calls.farmCode.length, 0, '守卫失败不得发起换码');
  assert.equal(readAccount().code, 'stale-code', 'store 不得被写');
  assert.equal(args.provider.counts.restart, 0);
});

test('已确认凭据最先落盘：锁内保存 + 作废旧码与旧任务 + 消费会话，全部先于换码', async () => {
  resetCalls();
  farmCodeResult = () => { throw new Error('connect ETIMEDOUT upstream'); };
  const args = baseArgs();
  const result = await completeOwnedWxRescan(args);
  assert.equal(result.ok, false);
  assert.equal(result.retryable, true);
  assert.equal(result.stage, 'code_temporary');
  // 换码失败也不能丢掉已确认授权：完整凭据已保存、旧 code 已作废。
  const saved = readAccount();
  assert.equal(saved.loginBuffer, 'rotated-buffer');
  assert.equal(saved.refreshtoken, 'rotated-refresh');
  assert.equal(saved.accesstoken, FIXTURE_ACCESS_AFTER);
  assert.equal(saved.code, '', '旧一次性 Code 必须作废，不得拿旧码冒充新授权');
  assert.equal(saved.autoLogin, true);
  // 顺序：作废旧任务 → 保存（addOrUpdateAccount）→ 消费会话；换码在其后失败。
  assert.deepEqual(order, ['invalidate', 'consume']);
  assert.equal(args.provider.counts.restart + args.provider.counts.start, 0, '换码失败不得启动');
  // 真实接受只发生一次，且显式携带属主/微信/守卫绑定（临界区内复验用）。
  assert.equal(acceptedNotes().length, 1);
  assert.equal(acceptedNotes()[0].options.keepSessionId, 'sess-9');
  assert.equal(acceptedNotes()[0].options.owner, 'ownerX');
  assert.equal(acceptedNotes()[0].options.wxid, 'openid-X');
  assert.equal(typeof acceptedNotes()[0].options.guard, 'function');
  // 检查点写入 code_pending（初始 + 换码临时失败的错误更新，同代次）。
  assert.ok(pendingNotes().length >= 1);
  for (const note of pendingNotes()) {
    assert.equal(note.options.stage, 'code_pending');
    assert.equal(note.options.generation, 3);
  }
  assert.match(pendingNotes()[pendingNotes().length - 1].options.error, /换取农场码失败/);
});

test('换码走持久凭据 + 显式 accountId + 独立 rescan 意图键（不依赖一次性会话）', async () => {
  resetCalls();
  const args = baseArgs();
  const result = await completeOwnedWxRescan(args);
  assert.equal(result.ok, true);
  assert.equal(result.started, true);
  assert.equal(result.stage, 'restart_submitted');
  assert.equal(calls.farmCode.length, 1);
  assert.equal(calls.farmCode[0].openid, 'openid-X');
  assert.equal(calls.farmCode[0].opts.accountId, '201');
  assert.equal(calls.farmCode[0].opts.intentKey, 'rescan');
  assert.equal(typeof calls.farmCode[0].opts.guard, 'function', '作用域守卫必须传入换码意图');
  assert.ok(!('sessionId' in calls.farmCode[0].opts), '重排后换码不得依赖扫码会话');
  // 换成的新码才允许保存并用于重启。
  assert.equal(readAccount().code, 'fresh-code-1');
  assert.equal(args.provider.counts.restart, 1);
  assert.equal(args.provider.counts.start + args.provider.counts.startFromSavedCode, 0);
  assert.deepEqual(order, ['invalidate', 'consume', 'restart']);
  // 启动提交被接受 → 检查点收口。
  assert.equal(resolvedNotes().length, 1);
  assert.equal(resolvedNotes()[0].options.generation, 3);
});

test('守卫在换码后失效 → 迟到结果不得更新检查点、不得启动（superseded）', async () => {
  resetCalls();
  // 换码请求一经发出守卫即失效：换码 await 之后的所有副作用全部拦下。
  let flipped = false;
  farmCodeGate = async () => { flipped = true; };
  const args = baseArgs({ isCurrent: () => !flipped });
  const result = await completeOwnedWxRescan(args);
  assert.equal(result.superseded, true);
  assert.equal(calls.farmCode.length, 1, '换码已发出（凭据已安全落盘）');
  assert.equal(readAccount().code, '', '未换成新码前不得写任何 code');
  assert.equal(args.provider.counts.restart, 0);
  // 迟到的旧完成连检查点都不得再动。
  assert.equal(pendingNotes().length, 1, '只保留凭据落盘时写下的 code_pending');
});

test('守卫在账号锁内失效 → 抛出 superseded，凭据不落盘、会话不消费', async () => {
  resetCalls();
  let guardCalls = 0;
  const guard = () => (++guardCalls) <= 1; // 入口通过，锁内失败
  const args = baseArgs({ isCurrent: guard });
  const result = await completeOwnedWxRescan(args);
  assert.equal(result.superseded, true);
  assert.equal(calls.consume.length, 0);
  assert.equal(acceptedNotes().length, 0, '未保存不得假报接受扫码');
  assert.equal(readAccount().code, 'stale-code');
  assert.equal(readAccount().loginBuffer, 'old-buffer');
});

test('排队等锁期间本地会话自然过期 → 入口捕获的已确认凭据仍完整落盘', async () => {
  resetCalls();
  // 第一次 peek（入口，同步）拿到已确认 grant；第二次 peek（锁内，等锁后）
  // 会话已过本地 TTL——人工确认过的授权不得因排队/过期丢失。
  let peeks = 0;
  peekResult = () => (++peeks === 1 ? pendingCreds : null);
  farmCodeResult = () => { throw new Error('connect ETIMEDOUT upstream'); };
  const args = baseArgs();
  const result = await completeOwnedWxRescan(args);
  assert.equal(result.ok, false);
  assert.equal(result.retryable, true, '换码临时失败可重试（凭据已在）');
  const saved = readAccount();
  assert.equal(saved.loginBuffer, 'rotated-buffer');
  assert.equal(saved.accesstoken, FIXTURE_ACCESS_AFTER);
  assert.equal(saved.code, '', '旧一次性 Code 必须作废');
  assert.equal(calls.consume.length, 1, '会话消费仍尽力执行（过期即无效清理）');
  assert.equal(acceptedNotes().length, 1, '凭据落盘即真实接受一次');
  assert.equal(args.provider.counts.restart + args.provider.counts.start, 0);
});

test('同一会话并发完成 singleflight：只保存/接受/换码/启动各一次', async () => {
  resetCalls();
  // 两个并发 complete 同时进入：第一个挂起在账号锁前，第二个按会话身份
  // 让位——绝不比对凭据字段（同 buffer 的新扫码是合法新轮次）。
  const args = baseArgs();
  const [first, second] = await Promise.all([
    completeOwnedWxRescan(args),
    completeOwnedWxRescan(baseArgs()),
  ]);
  assert.equal(first.ok, true);
  assert.equal(second.superseded, true, '并发孪生直接让位');
  assert.equal(calls.consume.length, 1);
  assert.equal(calls.farmCode.length, 1);
  assert.equal(acceptedNotes().length, 1);
  assert.equal(args.provider.counts.restart, 1);
});

test('顺序重放（真实 adapter：会话已消费，peek 不再返回）→ unconfirmed，不重复接受', async () => {
  resetCalls();
  const first = await completeOwnedWxRescan(baseArgs());
  assert.equal(first.ok, true);
  peekResult = () => null; // 真实 adapter 中会话已被消费
  const second = await completeOwnedWxRescan(baseArgs());
  assert.equal(second.ok, false);
  assert.equal(second.stage, 'unconfirmed');
  assert.equal(acceptedNotes().length, 1, '同一会话只接受一次');
  assert.equal(readAccount().code, 'fresh-code-1');
});

test('新一轮已确认扫码返回相同 loginBuffer 但新令牌 → 照常完整保存并接受', async () => {
  resetCalls();
  // 账号已带着同 buffer 的上一轮授权（真实场景：服务端复用了 buffer 值），
  // 但新一轮扫码会话确认后 refresh/access 已更新——不得按 buffer 判等误杀。
  store.addOrUpdateAccount({
    id: '201', platform: 'wx', username: 'ownerX', wxid: 'openid-X',
    code: 'previous-code', loginBuffer: 'rotated-buffer',
    refreshtoken: 'previous-refresh', accesstoken: FIXTURE_ACCESS_PREVIOUS,
  });
  const result = await completeOwnedWxRescan(baseArgs({ sessionId: 'sess-new-round' }));
  assert.equal(result.ok, true);
  const saved = readAccount();
  assert.equal(saved.loginBuffer, 'rotated-buffer');
  assert.equal(saved.refreshtoken, 'rotated-refresh', '新 refresh 必须落盘');
  assert.equal(saved.accesstoken, FIXTURE_ACCESS_AFTER, '新 access 必须落盘');
  assert.equal(saved.code, 'fresh-code-1');
  assert.equal(acceptedNotes().length, 1, '真实新扫码必须被接受');
});

test('会话未确认/已过期（peek 无 loginBuffer）→ 不保存、不消费、不假报接受', async () => {
  resetCalls();
  peekResult = () => null;
  const result = await completeOwnedWxRescan(baseArgs());
  assert.equal(result.ok, false);
  assert.equal(result.stage, 'unconfirmed');
  assert.equal(calls.consume.length, 0);
  assert.equal(acceptedNotes().length, 0);
  assert.equal(readAccount().code, 'stale-code');
});

test('noteAcceptedScan 被新扫码拒收（迟到完成）→ superseded，不取消新请求', async () => {
  resetCalls();
  const stale = reminderStub({ accepted: false });
  const result = await completeOwnedWxRescan(baseArgs({ reminder: stale }));
  assert.equal(result.superseded, true);
  // 凭据落盘是事实，但被拒收的完成不再写检查点、不再启动。
  assert.equal(readAccount().code, '');
  assert.equal(pendingNotes().length, 0, '被新扫码拒收的完成不写自己的检查点');
  assert.equal(calls.farmCode.length, 0);
});

test('换码明确失效 → 检查点收口为终态（resolved），非 retryable', async () => {
  resetCalls();
  farmCodeResult = () => ({ Success: false, Message: '微信授权范围已失效' });
  const result = await completeOwnedWxRescan(baseArgs());
  farmCodeResult = () => ({ Success: true, Data: { code: 'fresh-code-1' } });
  assert.equal(result.ok, false);
  assert.equal(result.stage, 'code_definitive');
  assert.equal(result.retryable, undefined);
  assert.match(result.error, /重新发送二维码/);
  // 凭据已先落盘（授权人工确认过）；检查点引导重新扫码。
  assert.equal(readAccount().loginBuffer, 'rotated-buffer');
  assert.equal(resolvedNotes().length, 1);
});

test('重启被明确拒绝（false）→ 如实 started:false，保留 start_pending 检查点', async () => {
  resetCalls();
  const provider = baseProvider({ restartAccount: async () => false });
  const result = await completeOwnedWxRescan(baseArgs({ provider }));
  assert.equal(result.ok, true, '凭据保存是事实');
  assert.equal(result.started, false, '被拒不冒充在线');
  assert.equal(result.stage, 'restart_refused');
  assert.equal(readAccount().code, 'fresh-code-1');
  const pending = pendingNotes().filter(note => note.options.stage === 'start_pending');
  assert.equal(pending.length, 1, '启动被拒保留检查点供显式重试');
  assert.equal(resolvedNotes().length, 0, '未收口');
});

test('重启提交排队（undefined）→ 已提交即收口，但排队≠农场在线', async () => {
  resetCalls();
  const provider = baseProvider({ restartAccount: async () => undefined });
  const result = await completeOwnedWxRescan(baseArgs({ provider }));
  assert.equal(result.ok, true);
  assert.equal(result.started, true);
  assert.equal(result.stage, 'restart_queued');
  assert.equal(resolvedNotes().length, 1);
});

test('重启抛错 → 凭据已落盘，启动失败如实带回并保留 start_pending', async () => {
  resetCalls();
  const provider = baseProvider({
    restartAccount: async () => { throw new Error('worker boot failed'); },
  });
  const result = await completeOwnedWxRescan(baseArgs({ provider }));
  assert.equal(result.ok, true);
  assert.equal(result.started, false);
  assert.equal(result.stage, 'start_failed');
  assert.match(result.error, /启动失败/);
  assert.equal(readAccount().code, 'fresh-code-1', '凭据已落盘');
  assert.equal(calls.consume.length, 1);
  assert.equal(pendingNotes().filter(note => note.options.stage === 'start_pending').length, 1);
});

test('离线账号：保存后换新码并用已存新码启动，不额外再换一次', async () => {
  resetCalls();
  const provider = baseProvider({ isAccountRunning: () => false });
  const result = await completeOwnedWxRescan(baseArgs({ provider }));
  assert.equal(result.ok, true);
  assert.equal(result.started, true);
  assert.equal(result.stage, 'start_submitted');
  assert.equal(calls.farmCode.length, 1, '离线路径同样只换一次码');
  assert.deepEqual(provider.counts.autoCode, [{ key: '201', cfg: { enabled: true, intervalMinutes: 60 } }]);
  assert.equal(provider.counts.startFromSavedCode, 1);
  assert.equal(provider.counts.start, 0);
  assert.equal(provider.savedCode, 'fresh-code-1', '必须用刚换的新码启动');
});

test('离线启动被拒（startAccountFromSavedWxCode=false）→ started:false + start_pending', async () => {
  resetCalls();
  const refused = baseProvider({
    isAccountRunning: () => false,
    startAccountFromSavedWxCode: async () => false,
  });
  const result = await completeOwnedWxRescan(baseArgs({ provider: refused }));
  assert.equal(result.ok, true, '保存是事实');
  assert.equal(result.started, false, '启动被拒不冒充成功');
  assert.equal(result.stage, 'start_refused');
  assert.equal(calls.consume.length, 1);
  assert.equal(pendingNotes().filter(note => note.options.stage === 'start_pending').length, 1);
});

test('扫码微信与账号绑定不一致 → 拒绝保存且不发起换码（换绑只能走面板编辑）', async () => {
  resetCalls();
  const result = await completeOwnedWxRescan(baseArgs({ openid: 'openid-OTHER' }));
  assert.equal(result.ok, false);
  assert.equal(result.stage, 'binding_mismatch');
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

test('显式重试（QR 过期/进程重启后）：凭据已在 → 再换全新码并重启，不重放 OAuth', async () => {
  resetCalls();
  // 先走一条「凭据已保存、换码临时失败」的链。
  farmCodeResult = () => { throw new Error('connect ETIMEDOUT upstream'); };
  await completeOwnedWxRescan(baseArgs());
  assert.equal(readAccount().code, '');
  // 显式重试：不再有扫码会话参与，仅用持久凭据换新码。
  farmCodeResult = () => ({ Success: true, Data: { code: 'fresh-code-2' } });
  peekResult = () => null;
  const provider = baseProvider();
  const result = await retrySavedWxScanLogin({
    accountId: '201', provider, reminder: reminderStub(), isCurrent: () => true, generation: 3,
  });
  assert.equal(result.ok, true);
  assert.equal(result.started, true);
  assert.equal(calls.farmCode.length, 2);
  assert.equal(calls.farmCode[1].opts.intentKey, 'rescan');
  assert.ok(!('sessionId' in calls.farmCode[1].opts));
  assert.equal(readAccount().code, 'fresh-code-2', '重试必须换成全新 Code');
  assert.equal(provider.counts.restart, 1);
  // 重试不重放扫码接受语义。
  assert.equal(acceptedNotes().length, 1, '仍只有完成链那一次');
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
  assert.equal(readAccount().code, 'fresh-code-1', '真实 store 已写入新换的码');
  assert.deepEqual(order, ['invalidate', 'consume', 'restart'], '执行顺序与单测一致');
  assert.equal(provider.counts.restart, 1, '重启恰好一次');
  assert.equal(calls.consume.length, 1, '一次性会话恰好消费一次');
  // 启动已收口：持久检查点不可见（真实服务路径，notes 打桩只用于单测）。
  assert.equal(service.getScanCheckpoint('201'), null);
  // 新扫码代次已推进：旧图片能力立即吊销。
  assert.equal(service.getQrImage(push.imageToken), null);
  // 守望终态后停止轮询。
  const polls = checkCount;
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(checkCount, polls, 'saved 后守望不得继续轮询');
});
