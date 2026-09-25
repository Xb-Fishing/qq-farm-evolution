const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function fixture({ failSave = false, refreshError } = {}) {
  let stored = { id: 'fixture-account', wxid: 'fixture-openid', loginBuffer: 'old-buffer',
    refreshtoken: 'old-refresh', accesstoken: 'aold' };
  const calls = { buffers: [], refresh: 0, saves: [], logs: [] };
  let failNewCode = true;
  class Service {
    async issueCode({ loginBuffer }) {
      calls.buffers.push(loginBuffer);
      if (loginBuffer === 'old-buffer') throw new Error('ManualAuth rejected');
      if (failNewCode) throw new Error('socket read timeout');
      return 'fixture-code';
    }
    async refreshLoginBuffer({ refreshtoken }) {
      calls.refresh += 1;
      assert.equal(refreshtoken, 'old-refresh');
      if (refreshError) throw refreshError;
      return { loginBuffer: 'new-buffer', refreshtoken: 'new-refresh', accesstoken: 'anew',
        credentialExpiresIn: 7200, credentialExpiresAt: Date.now() + 7200000, refreshTokenRotated: true };
    }
  }
  const modules = {
    'node:crypto': require('node:crypto'),
    './logger': { createModuleLogger: () => ({ info: (...args) => calls.logs.push(args),
      warn: (...args) => calls.logs.push(args) }) },
    './wx-login/service': { WxLoginService: Service },
    '../models/store': {
      getAccounts: () => ({ accounts: [{ ...stored }] }),
      addOrUpdateAccount: patch => {
        calls.saves.push(patch);
        if (failSave) throw new Error('fixture-private-path/new-refresh');
        stored = { ...stored, ...patch };
      },
    },
  };
  const filename = path.join(__dirname, '../src/services/wx-login-adapter.js');
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, exports: module.exports, Error, Buffer,
    require: name => { assert.ok(Object.hasOwn(modules, name), name); return modules[name]; },
  }, { filename });
  return { calls, read: () => stored, recover: () => { failNewCode = false; },
    definitive: module.exports.isDefinitiveWxCredentialError,
    run: () => module.exports.getFarmCode(stored.wxid, { accountId: stored.id }) };
}

test('续期成功后换 Code 超时仍落盘完整新凭据，重试直接复用新 buffer', async () => {
  const f = fixture();
  assert.equal((await f.run()).Success, false);
  assert.equal(f.read().refreshtoken, 'new-refresh');
  assert.equal(f.read().accesstoken, 'anew');
  assert.equal(f.read().loginBuffer, 'new-buffer');
  assert.equal(f.read().wxCredentialExpiresIn, 7200);
  assert.ok(f.read().wxCredentialLastSuccessAt > 0);
  f.recover();
  assert.equal((await f.run()).Success, true);
  assert.equal(f.calls.refresh, 1);
  assert.deepEqual(f.calls.buffers, ['old-buffer', 'new-buffer', 'new-buffer']);
});

test('结构异常和 HTTP 错误不是授权撤销，明确凭据错误仍需重新授权', () => {
  const f = fixture();
  for (const message of ['WeChat token refresh failed: code=500 msg=invalid response',
    'WeChat token refresh failed: HTTP 503', 'login buffer refresh failed: invalid JSON',
    'Unable to obtain WeChat login buffer (HTTP 401)', 'fixture transport timeout']) {
    assert.equal(f.definitive(message), false, message);
  }
  for (const message of ['code=40188', 'code=40030', 'code=42007',
    'RefreshToken empty token code=-109', 'WeChat refresh_token failed: code=-109 credential response rejected',
    'refresh token expired', 'invalid refresh_token',
    '微信授权范围已失效', '凭证已失效']) {
    assert.equal(f.definitive(message), true, message);
  }
});

test('续期阶段诊断只记录白名单阶段、整数错误码和是否已刷新', async () => {
  const error = Object.assign(new Error('fixture transport timeout'), {
    wxStage: 'login_buffer', wxCode: 40188, tokenRefreshSucceeded: true,
    refreshtoken: 'fixture-private-refresh', accesstoken: 'afail',
  });
  const f = fixture({ refreshError: error });
  await f.run();
  const diagnostic = f.calls.logs[0][1];
  assert.equal(diagnostic.stage, 'login_buffer');
  assert.equal(diagnostic.code, 40188);
  assert.equal(diagnostic.tokenRefreshSucceeded, true);
  assert.doesNotMatch(JSON.stringify(f.calls.logs), /fixture-private/);
  const unsafe = fixture({ refreshError: Object.assign(new Error('fixture transport timeout'), {
    wxStage: 'fixture-private-stage', wxCode: 'fixture-private-code', tokenRefreshSucceeded: 'fixture-private-value',
  }) });
  await unsafe.run();
  assert.equal(unsafe.calls.logs[0][1].stage, 'unknown');
  assert.equal(unsafe.calls.logs[0][1].code, null);
  assert.equal(unsafe.calls.logs[0][1].tokenRefreshSucceeded, false);
  assert.doesNotMatch(JSON.stringify(unsafe.calls.logs), /fixture-private/);
});

test('新凭据落盘失败时不继续申请 Code、不返回成功或泄露存储异常', async () => {
  const f = fixture({ failSave: true });
  f.recover();
  const result = await f.run();
  assert.equal(result.Success, false);
  assert.match(result.Message, /凭据保存失败/);
  assert.deepEqual(f.calls.buffers, ['old-buffer']);
  assert.doesNotMatch(JSON.stringify([result, f.calls.logs]), /fixture-private-path|new-refresh/);
});
