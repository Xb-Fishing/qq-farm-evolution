const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const prefix = path.resolve(os.tmpdir(), 'wx-update-session-safety-');
assert.equal(path.dirname(prefix), path.resolve(os.tmpdir()));
const temporary = fs.mkdtempSync(prefix);
process.env.FARM_DATA_DIR = path.join(temporary, 'data');
const { WxLoginService } = require('../src/services/wx-login/service');
const { sanitizeMeta } = require('../src/services/logger');
const { createWxRestartCoordinator, consumeWxRestartHandoff } = require('../src/runtime/wx-restart-handoff');
test.after(() => fs.rmSync(temporary, { recursive: true, force: true }));

function adapterFixture({ failSave = false, Service = WxLoginService } = {}) {
  let stored = { id: 'fixture-account', username: 'fixture-owner', wxid: 'fixture-openid',
    autoLogin: true, loginBuffer: 'old-buffer', refreshtoken: 'old-refresh', accesstoken: 'old-access', wxCredentialLastSuccessAt: 100 };
  const logs = [];
  const modules = {
    'node:crypto': require('node:crypto'),
    './logger': { createModuleLogger: () => ({ info() {}, warn: (message, data) => logs.push(sanitizeMeta(data)) }) },
    './wx-login/service': { WxLoginService: Service },
    '../models/store': {
      getAccounts: () => ({ accounts: [{ ...stored }] }),
      addOrUpdateAccount: patch => { if (failSave) throw new Error('private-storage-path'); stored = { ...stored, ...patch }; },
    },
  };
  const filename = path.join(__dirname, '../src/services/wx-login-adapter.js');
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, exports: module.exports, Error, Buffer,
    require: name => { assert.ok(Object.hasOwn(modules, name), name); return modules[name]; },
  }, { filename });
  return { read: () => stored, run: () => module.exports.keepWxCredentialAlive(stored), logs,
    patch: fields => { stored = { ...stored, ...fields }; },
    runCode: options => module.exports.getFarmCode(stored.wxid, { accountId: stored.id, ...options }) };
}

test('rotated tokens are durable before a pending buffer HTTP request; buffer refusal does not renew successful-login time', async () => {
  const originalFetch = globalThis.fetch;
  const fixture = adapterFixture();
  let resolveBuffer;
  let reachedBuffer;
  const reached = new Promise(resolve => { reachedBuffer = resolve; });
  let calls = 0;
  globalThis.fetch = async () => {
    if (++calls === 1) return new Response(JSON.stringify({ code: 0, user_info: {
      access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 7200,
    } }));
    reachedBuffer();
    return new Promise(resolve => { resolveBuffer = resolve; });
  };
  try {
    const pending = fixture.run();
    await reached;
    const duringRequest = { ...fixture.read() };
    resolveBuffer(new Response(JSON.stringify({ code: -101 })));
    const result = await pending;
    assert.equal(duringRequest.refreshtoken, 'new-refresh');
    assert.equal(duringRequest.accesstoken, 'new-access');
    assert.equal(duringRequest.loginBuffer, 'old-buffer');
    assert.equal(duringRequest.wxCredentialLastSuccessAt, 100);
    assert.equal(result.Success, false);
    assert.equal(result.definitive, true);
    const diagnostic = fixture.logs.at(-1);
    assert.equal(diagnostic.stage, 'login_buffer');
    assert.equal(diagnostic.upstreamStatus, -101);
    assert.equal(diagnostic.refreshStageCompleted, true);
    const scrubbed = sanitizeMeta({ ...diagnostic, accesstoken: 'secret', code: 'one-use-secret' });
    assert.equal(scrubbed.upstreamStatus, -101);
    assert.equal(scrubbed.refreshStageCompleted, true);
    assert.equal(scrubbed.accesstoken, '[REDACTED]');
    assert.equal(scrubbed.code, '[REDACTED]');
  } finally { globalThis.fetch = originalFetch; }
});

test('token checkpoint storage failure prevents the independent buffer request', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({ code: 0, user_info: { access_token: 'new-access', refresh_token: 'new-refresh' } }));
  };
  try {
    let result;
    await assert.doesNotReject(async () => { result = await adapterFixture({ failSave: true }).run(); });
    assert.equal(result.Success, false);
    assert.equal(calls, 1);
    assert.equal(result.Message.includes('private-storage-path'), false);
  } finally { globalThis.fetch = originalFetch; }
});

test('cancelled update stops later native stages while durably retaining an already rotated token for the same credential', async () => {
  const originalFetch = globalThis.fetch;
  let active = true; let calls = 0; let exchanges = 0;
  class Service extends WxLoginService {
    async issueCode() { exchanges += 1; throw new Error('ManualAuth rejected'); }
  }
  const f = adapterFixture({ Service });
  globalThis.fetch = async () => {
    calls += 1; active = false;
    return new Response(JSON.stringify({ code: 0, user_info: { access_token: 'new-access', refresh_token: 'new-refresh' } }));
  };
  try {
    const result = await f.runCode({ guard: () => active, credentialGuard: () => true, intentKey: 'update-fixture' });
    assert.equal(result.Success, false); assert.equal(result.superseded, true);
    assert.equal(calls, 1); assert.equal(exchanges, 1);
    assert.equal(f.read().refreshtoken, 'new-refresh');
    assert.equal(f.read().wxCredentialLastSuccessAt, 100);
  } finally { globalThis.fetch = originalFetch; }
});

test('real preparation guards persist token rotation after pause, and reject it after new authorization', async () => {
  const nativeAdapter = require('../src/services/wx-login-adapter');
  const { createAutoCodeRefreshService } = require('../src/runtime/auto-code-refresh');
  const originalCode = nativeAdapter.getFarmCode;
  const originalFetch = globalThis.fetch;
  try {
    for (const change of ['pause', 'rescan']) {
      let requests = 0;
      class Service extends WxLoginService { async issueCode() { throw new Error('ManualAuth rejected'); } }
      const f = adapterFixture({ Service });
      nativeAdapter.getFarmCode = (_wxid, options) => f.runCode(options);
      const svc = createAutoCodeRefreshService({
        store: { isAccountAutoLogin: account => account.autoLogin !== false },
        getAccounts: () => ({ accounts: [f.read()] }), addOrUpdateAccount: f.patch,
        log() {}, addAccountLog() {},
      });
      globalThis.fetch = async () => {
        requests += 1;
        if (change === 'pause') { f.patch({ autoLogin: false }); svc.stopAccount(f.read().id); }
        else { svc.invalidateCredentialTasks(f.read().id); f.patch({ refreshtoken: 'rescan-refresh' }); }
        return new Response(JSON.stringify({ code: 0, user_info: { access_token: 'new-access', refresh_token: 'new-refresh' } }));
      };
      assert.equal(await svc.prepareRestartCode(f.read().id, { intentKey: change }), null);
      assert.equal(requests, 1);
      assert.equal(f.read().refreshtoken, change === 'pause' ? 'new-refresh' : 'rescan-refresh');
      svc.stopAccount(f.read().id);
    }
  } finally { nativeAdapter.getFarmCode = originalCode; globalThis.fetch = originalFetch; }
});

function restartFixture() {
  let time = 100000;
  const accounts = [{ id: 'fixture-wx', username: 'fixture-owner', platform: 'wx', wxid: 'fixture-openid',
    autoLogin: true, loginBuffer: 'fixture-buffer', refreshtoken: 'fixture-refresh', code: 'used-code' }];
  const workers = { 'fixture-wx': { status: { connection: { connected: true } } } };
  let available = true;
  let generation = 1;
  const calls = { prepared: 0 };
  const getAccounts = () => ({ accounts });
  const isAutoLogin = a => a.autoLogin === true;
  const coordinator = createWxRestartCoordinator({ getAccounts, isAutoLogin, workers, now: () => time,
    autoCodeRefresh: {
      prepareRestartCode: async () => { calls.prepared += 1; return available ? { code: 'fresh-code', generation } : null; },
      isRestartGenerationCurrent: (_id, expected) => expected === generation,
    } });
  const request = { targetCommit: 'a'.repeat(40), nonce: 'fixture-restart-nonce', oldPid: 12345, oldStartTicks: '555' };
  return { accounts, workers, calls, coordinator, request, getAccounts, isAutoLogin,
    expire: () => { time += 90001; }, unavailable: () => { available = false; }, rotate: () => { generation += 1; },
    consume: file => consumeWxRestartHandoff({ file, directory: temporary, ...request,
      actualCommit: request.targetCommit, getAccounts, isAutoLogin, now: () => time }) };
}

test('update preparation failure leaves existing session and saved Code intact', async () => {
  const f = restartFixture(); f.unavailable();
  assert.equal((await f.coordinator.prepareWxRestart(f.request)).ok, false);
  assert.equal(f.workers['fixture-wx'].status.connection.connected, true);
  assert.equal(f.accounts[0].code, 'used-code');
});

test('unknown WX connection state cannot be treated as an empty offline batch', async () => {
  const f = restartFixture(); f.workers['fixture-wx'].status = {};
  assert.equal((await f.coordinator.prepareWxRestart(f.request)).ok, false);
  assert.equal(f.calls.prepared, 0);
});

test('prepared restart is invalidated by timeout, pause, binding, credentials, new online account and generation', async () => {
  for (const change of [f => f.expire(), f => { f.accounts[0].autoLogin = false; },
    f => { f.accounts[0].wxid = 'new-binding'; }, f => { f.accounts[0].refreshtoken = 'rotated'; },
    f => { f.accounts.push({ ...f.accounts[0], id: 'fixture-new' }); }, f => f.rotate()]) {
    const f = restartFixture(); const result = await f.coordinator.prepareWxRestart(f.request);
    assert.equal(result.ok, true); assert.equal(f.coordinator.validateWxRestart(result.handoff), true);
    change(f); assert.equal(f.coordinator.validateWxRestart(result.handoff), false);
  }
});

test('fresh Code is privately handed off once and rejected after binding changes', async () => {
  for (const stale of [false, true]) {
    const f = restartFixture();
    const prepared = await f.coordinator.prepareWxRestart(f.request);
    const file = path.resolve(temporary, `${f.request.nonce}.json`);
    assert.equal(path.dirname(file), path.resolve(temporary));
    fs.writeFileSync(file, JSON.stringify(prepared.handoff), { mode: 0o600 });
    if (stale) f.accounts[0].wxid = 'new-binding';
    const codes = f.consume(file);
    assert.equal(codes.get('fixture-wx')?.code, stale ? undefined : 'fresh-code');
    assert.equal(f.consume(file).size, 0);
    assert.equal(fs.existsSync(file), false);
  }
});
