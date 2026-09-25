const test = require('node:test');
const assert = require('node:assert/strict');

const { WxLoginService } = require('../src/services/wx-login/service');
const { isDefinitiveWxCredentialError } = require('../src/services/wx-login-adapter');

function jsonResponse(value) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

test('凭据刷新保留腾讯返回的有效期和滚动 token 状态', async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url) => {
    requests.push(String(url));
    if (requests.length === 1) {
      return jsonResponse({
        code: 0,
        user_info: {
          access_token: 'a2',
          refresh_token: 'r2',
          expires_in: 5400,
        },
      });
    }
    return jsonResponse({
      code: 0,
      ext_info: { list_s: { login_buffer: { value: ['buffer-new'] } } },
    });
  };

  const before = Date.now();
  try {
    const result = await new WxLoginService().refreshLoginBuffer({
      openid: 'openid-fixture',
      refreshtoken: 'r1',
      accesstoken: 'a1',
      cookies: new Map(),
    });
    assert.equal(result.loginBuffer, 'buffer-new');
    assert.equal(result.refreshtoken, 'r2');
    assert.equal(result.accesstoken, 'a2');
    assert.equal(result.credentialExpiresIn, 5400);
    assert.ok(result.credentialExpiresAt >= before + 5400 * 1000);
    assert.ok(result.credentialExpiresAt <= Date.now() + 5400 * 1000);
    assert.equal(result.refreshTokenRotated, true);
    assert.equal(requests.length, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('loginBuffer 失败时仍携带已滚动 token 的有效期，且 40188 不会高频重试', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) {
      return jsonResponse({
        code: 0,
        userInfo: {
          accessToken: 'a2',
          refreshToken: 'r2',
          expiresIn: 3600,
        },
      });
    }
    return jsonResponse({ code: 40188, msg: 'GetLoginBuffer error [40188] [invalid scope]' });
  };

  try {
    await assert.rejects(
      new WxLoginService().refreshLoginBuffer({
        openid: 'openid-fixture',
        refreshtoken: 'r1',
        accesstoken: 'a1',
        cookies: new Map(),
      }),
      (error) => {
        assert.equal(error.refreshtoken, 'r2');
        assert.equal(error.accesstoken, 'a2');
        assert.equal(error.credentialExpiresIn, 3600);
        assert.equal(error.refreshTokenRotated, true);
        assert.equal(isDefinitiveWxCredentialError(error.message), true);
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('40188 不依赖上游文案，诊断区分 token 刷新与 buffer 授权拒绝', async () => {
  const originalFetch = globalThis.fetch;
  const marker = 'fixture-private-message';
  try {
    for (const stage of ['refresh_token', 'login_buffer']) {
      let calls = 0;
      globalThis.fetch = async () => {
        calls += 1;
        if (stage === 'login_buffer' && calls === 1) {
          return jsonResponse({ code: 0, userInfo: { accessToken: 'a2', refreshToken: 'r2' } });
        }
        return jsonResponse({ code: 40188, msg: marker });
      };
      await assert.rejects(new WxLoginService().refreshLoginBuffer({
        openid: 'openid-fixture', accesstoken: 'a1', refreshtoken: 'r1', cookies: new Map(),
      }), error => {
        assert.equal(error.wxStage, stage);
        assert.equal(error.wxCode, 40188);
        assert.equal(error.tokenRefreshSucceeded === true, stage === 'login_buffer');
        assert.equal(isDefinitiveWxCredentialError(error.message), true);
        assert.equal(error.message.includes(marker), false);
        return true;
      });
      assert.equal(calls, stage === 'refresh_token' ? 1 : 2);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('刷新回包结构异常不应误判永久失效或回显上游消息', async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => jsonResponse({ code: -1, msg: 'invalid response fixture-private-message' });
    await assert.rejects(new WxLoginService().refreshLoginBuffer({
      openid: 'openid-fixture', accesstoken: 'a1', refreshtoken: 'r1', cookies: new Map(),
    }), error => {
      assert.equal(isDefinitiveWxCredentialError(error.message), false);
      assert.equal(error.message.includes('fixture-private-message'), false);
      assert.equal(error.wxStage, 'refresh_token');
      return true;
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
