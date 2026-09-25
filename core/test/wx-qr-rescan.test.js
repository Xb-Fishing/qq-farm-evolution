const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farm-qr-rescan-'));
process.env.FARM_DATA_DIR = dataDir;
test.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

function load(relative, overrides = {}, globals = {}) {
  const filename = path.join(__dirname, '../src', relative);
  const module = { exports: {} };
  const nativeRequire = createRequire(filename);
  const context = { module, exports: module.exports, Error, Buffer, URL, URLSearchParams, Headers,
    AbortController, setTimeout, clearTimeout, console, ...globals,
    require: name => Object.hasOwn(overrides, name) ? overrides[name] : nativeRequire(name) };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), context, { filename });
  return module.exports;
}
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
function reply(body, status = 200, cookiePairs = []) {
  const headers = new Headers();
  for (const value of cookiePairs) headers.append('set-cookie', value);
  return new Response(JSON.stringify(body), { status, headers });
}
function service(fetch) {
  return new (load('services/wx-login/service.js', {
    './native-protocol': { getNativeWxLoginCode: () => assert.fail('unexpected native request') },
  }, { fetch }).WxLoginService)();
}

test('扫码 confirm 缓冲阶段临时失败重试不重放 OAuth，成功后重复 confirm 零请求', async () => {
  let callbacks = 0;
  let buffers = 0;
  const svc = service(async url => {
    if (String(url).includes('pcyyb_oauth?')) {
      callbacks += 1;
      return reply({}, 200, ['openid=fixture-openid', 'accesstoken=fixture-access', 'refreshtoken=fixture-refresh']);
    }
    buffers += 1;
    return buffers === 1 ? reply({}, 503)
      : reply({ code: 0, ext_info: { list_s: { login_buffer: { value: ['fixture-buffer'] } } } });
  });
  const session = { cookies: new Map(), oauthCode: 'fixture-oauth' };
  await assert.rejects(svc.confirm(session), /HTTP 503/);
  assert.equal(session.oauthCallbackComplete, true);
  const result = await svc.confirm(session);
  assert.equal(result.loginBuffer, 'fixture-buffer');
  await svc.confirm(session);
  assert.equal(callbacks, 1);
  assert.equal(buffers, 2);
});

test('OAuth 回调结果未知时不得重复消费一次性 code', async () => {
  let calls = 0;
  const svc = service(async () => { calls += 1; throw new Error('fixture transport timeout'); });
  const session = { cookies: new Map(), oauthCode: 'fixture-oauth' };
  await assert.rejects(svc.confirm(session), /timeout/);
  await assert.rejects(svc.confirm(session), /重新获取二维码/);
  assert.equal(calls, 1);
});

async function setup() {
  const account = { id: 'fixture-account', username: 'fixture-owner', platform: 'wx',
    loginType: 'wx_qr', wxid: 'fixture-openid', loginBuffer: 'old-buffer', refreshtoken: 'old-refresh' };
  const calls = { starts: 0, refreshSettings: 0, invalidations: [], writes: [], issue: 0, poll: 0 };
  const behavior = { issue: async () => 'fixture-code', refresh: async () => ({
    loginBuffer: 'scan-rotated-buffer', refreshtoken: 'scan-rotated-refresh', accesstoken: 'anew',
  }) };
  class FixtureService {
    async createQrSession() { return { session: { uuid: 'fixture-qr' }, qr: Buffer.from('fixture') }; }
    async poll() { calls.poll += 1; return 'authorized'; }
    async confirm(session) {
      Object.assign(session, { openid: 'fixture-openid', loginBuffer: 'scan-buffer', refreshtoken: 'scan-refresh', accesstoken: 'ascan' });
      return { openid: session.openid };
    }
    async fetchUserInfo() { return {}; }
    async issueCode() { calls.issue += 1; return behavior.issue(); }
    async refreshLoginBuffer() { return behavior.refresh(); }
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
  assert.equal((await adapter.checkQR(sessionId, 'fixture-owner')).Success, true);
  const routes = new Map();
  const app = { get() {}, post: (route, handler) => routes.set(route, handler), put() {}, delete() {}, patch() {} };
  load('controllers/admin-account-routes.js', { '../services/wx-login-adapter': adapter }).registerAdminAccountRoutes({
    app,
    provider: {
      getAccounts: () => ({ accounts: [{ id: account.id, platform: account.platform }] }),
      isAccountRunning: () => false,
      invalidateAccountCredentialTasks: () => { calls.invalidations.push(account.loginBuffer); },
      saveAutoCodeRefresh: async () => { calls.refreshSettings += 1; },
      startAccount: async () => { calls.starts += 1; },
    },
    getAccountsForUser: () => [account], resolveAccountReference: value => value,
    canAccessAccount: req => req.currentUser.username === account.username,
    addOrUpdateAccount: save,
  });
  const invoke = async (body, owner = 'fixture-owner') => {
    const response = { statusCode: 200, status(value) { this.statusCode = value; return this; }, json(value) { this.body = value; } };
    await routes.get('/api/accounts')({ body, currentUser: { username: owner, role: 'user' } }, response);
    return response;
  };
  const scanBody = { id: account.id, platform: 'wx', wxid: account.wxid, wxSessionId: sessionId };
  return { account, calls, behavior, adapter, sessionId, invoke, scanBody };
}

test('扫码会话刷新部分失败保留已轮换 token，临时错误不强迫重扫码', async () => {
  const f = await setup();
  f.behavior.issue = async () => { throw new Error('ManualAuth rejected'); };
  f.behavior.refresh = async () => {
    const error = new Error('fixture transport timeout');
    Object.assign(error, { refreshtoken: 'rolled-refresh', accesstoken: 'aroll', credentialExpiresAt: 999999 });
    throw error;
  };
  const result = await f.adapter.getFarmCode(f.account.wxid, { sessionId: f.sessionId, owner: 'fixture-owner' });
  assert.equal(result.Success, false);
  assert.equal(result.definitive, false);
  assert.match(result.Message, /稍后重试/);
  assert.doesNotMatch(result.Message, /请重新扫码登录/);
  const pending = f.adapter.peekPendingWxInfo(f.sessionId, f.account.wxid, 'fixture-owner');
  assert.equal(pending.refreshtoken, 'rolled-refresh');
  assert.equal(pending.accesstoken, 'aroll');
  assert.equal(pending.wxCredentialExpiresAt, 999999);
  assert.equal(f.account.refreshtoken, 'old-refresh');
});

test('旧续期先完成，新扫码保存锁内重读最新凭据并仅启动一次', async () => {
  const f = await setup();
  const release = deferred();
  const entered = deferred();
  const renewal = f.adapter.withAccountCredentialLock(f.account.wxid, f.account.id, async () => {
    entered.resolve();
    await release.promise;
    f.account.loginBuffer = 'old-rotated-buffer';
    f.calls.writes.push(f.account.loginBuffer);
  });
  await entered.promise;
  const saving = f.invoke(f.scanBody);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.calls.writes.length, 0);
  // 保存排队期间扫码会话自己发生滚动，保存不能使用锁外旧快照。
  let issueCalls = 0;
  f.behavior.issue = async () => {
    issueCalls += 1;
    if (issueCalls === 1) throw new Error('ManualAuth rejected');
    return 'fixture-new-code';
  };
  assert.equal((await f.adapter.getFarmCode(f.account.wxid, { sessionId: f.sessionId, owner: 'fixture-owner' })).Success, true);
  release.resolve();
  await renewal;
  const response = await saving;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.ok, true);
  assert.deepEqual(f.calls.writes, ['old-rotated-buffer', 'scan-rotated-buffer']);
  assert.equal(f.account.refreshtoken, 'scan-rotated-refresh');
  assert.equal(f.calls.starts, 1);
  assert.deepEqual(f.calls.invalidations, ['scan-rotated-buffer']);
  assert.equal(f.calls.refreshSettings, 1);
  assert.equal(response.body.startup.queued, true);
  assert.equal(f.adapter.peekPendingWxInfo(f.sessionId, f.account.wxid, 'fixture-owner'), null);
});

test('离线账号普通改备注或手动编辑不自动启动、不改刷新配置', async () => {
  const f = await setup();
  for (const body of [{ id: f.account.id, name: 'Fixture' }, { id: f.account.id, platform: 'wx', code: 'fixture-code' }]) {
    const response = await f.invoke(body);
    assert.equal(response.body.ok, true);
    assert.equal(response.body.startup.queued, false);
  }
  assert.equal(f.calls.starts, 0);
  assert.equal(f.calls.refreshSettings, 0);
});

test('其他用户不能轮询或消费扫码会话，也不能更新目标账号', async () => {
  const f = await setup();
  const polls = f.calls.poll;
  assert.equal((await f.adapter.checkQR(f.sessionId, 'another-fixture-owner')).Success, false);
  assert.equal(f.calls.poll, polls);
  assert.equal(f.adapter.peekPendingWxInfo(f.sessionId, f.account.wxid, 'another-fixture-owner'), null);
  assert.equal(f.adapter.consumePendingWxInfo(f.sessionId, f.account.wxid, 'another-fixture-owner'), false);
  const code = await f.adapter.getFarmCode(f.account.wxid, { sessionId: f.sessionId, owner: 'another-fixture-owner' });
  assert.equal(code.Success, false);
  assert.equal(f.calls.issue, 0);
  const response = await f.invoke(f.scanBody, 'another-fixture-owner');
  assert.equal(response.statusCode, 403);
  assert.equal(f.calls.writes.length, 0);
  assert.equal(f.calls.starts, 0);
  assert.ok(f.adapter.peekPendingWxInfo(f.sessionId, f.account.wxid, 'fixture-owner'));
});

test('扫码失败阶段只记录固定原因，不记录凭据或身份原文', async () => {
  let handler;
  const events = [];
  const marker = ['private', 'fixture', 'value'].join('-');
  load('controllers/admin-proxy-routes.js', {
    'node-fetch': async () => { throw new Error('Unexpected network'); },
    '../services/wx-login-adapter': { checkQR: async () => ({ Success: false, Message: `timeout ${marker}` }) },
  }, { process: { env: {} } }).registerAdminProxyRoutes({
    app: { post: (_route, fn) => { handler = fn; } },
    logger: { info() {}, error() {}, warn: (message, meta) => events.push({ message, meta }) },
  });
  const res = { json(value) { this.body = value; }, status() { return this; } };
  await handler({ body: { action: 'checkqr', uuid: marker }, headers: {}, currentUser: { username: marker } }, res);
  assert.equal(res.body.Success, false);
  assert.equal(events.length, 1);
  assert.equal(events[0].meta.reason, 'transport');
  assert.equal(events[0].meta.phase, 'checkqr');
  assert.equal(JSON.stringify(events).includes(marker), false);
});
