const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { createRequire } = require('node:module');
const { compileFunction } = require('node:vm');

const { stripProtectedWxCredentials } = require('../src/controllers/admin-account-routes');
const { createAdminAccountAccess } = require('../src/controllers/admin-account-access');
const { getDefaultSystemConfig } = require('../src/config/config');
const { findAccountByRef } = require('../src/services/account-resolver');

test('账号请求体不能直接注入微信滚动凭据', () => {
  const sanitized = stripProtectedWxCredentials({
    id: '1', wxid: 'wx-new', code: 'farm-code',
    loginBuffer: 'forged-buffer', refreshtoken: 'forged-refresh',
    accesstoken: 'forged-access', refreshToken: 'forged-refresh-camel',
    accessToken: 'forged-access-camel',
    wxCredentialExpiresAt: 123,
    wxCredentialExpiresIn: 456,
    wxRefreshTokenObservedAt: 789,
    wxCredentialLastSuccessAt: 999,
  });
  assert.deepEqual(sanitized, { id: '1', wxid: 'wx-new', code: 'farm-code' });
});

test('凭据过滤不会修改原始请求对象', () => {
  const source = { id: '1', loginBuffer: 'secret' };
  stripProtectedWxCredentials(source);
  assert.equal(source.loginBuffer, 'secret');
});

const owner = { username: 'fixture-owner', role: 'user' };
const otherOwner = 'fixture-other';
const ownerAccount = { id: '1', username: owner.username, platform: 'qq', qq: '10001', name: 'First', code: 'fixture-one' };
const otherAccount = { id: '2', username: otherOwner, platform: 'wx', name: 'Second', code: 'fixture-two' };
const protectedFields = {
  loginBuffer: randomUUID(),
  refreshtoken: randomUUID(),
  accesstoken: randomUUID(),
  refreshToken: randomUUID(),
  accessToken: randomUUID(),
  wxCredentialExpiresAt: 123,
  wxCredentialExpiresIn: 456,
  wxRefreshTokenObservedAt: 789,
  wxCredentialLastSuccessAt: 999,
};

function accountRoutes({ beforeLockedSave = () => {} } = {}) {
  const filename = require.resolve('../src/controllers/admin-account-routes');
  const routeModule = { exports: {} };
  const routeRequire = createRequire(filename);
  const events = [];
  const adapter = {
    async withAccountCredentialLock(_wxid, id, save) {
      events.push(['lock', id]);
      await beforeLockedSave(accounts);
      return save();
    },
    peekPendingWxInfo: (session, wxid, username) =>
      session === 'fixture-scan' && wxid === 'fixture-wxid' && username === owner.username
        ? protectedFields : null,
    consumePendingWxInfo: session => events.push(['consume', session]),
  };
  const reminder = {
    getSharedWxLoginReminder: () => ({ noteAcceptedScan: async () => {} }),
  };
  const imports = {
    '../services/wx-login-adapter': adapter,
    '../services/wx-login-reminder': reminder,
  };
  const load = compileFunction(readFileSync(filename, 'utf8'), ['module', 'require'], { filename });
  load(routeModule, name => imports[name] ?? routeRequire(name));

  const accounts = [ownerAccount, otherAccount].map(account => ({ ...account, ...protectedFields }));
  const running = new Set(['1']);
  let nextId = 3;
  let systemConfig = { clientVersion: '1.0.0_20260101' };
  const snapshot = () => ({ accounts: accounts.map(account => ({ ...account })), nextId });
  const store = {
    getGlobalWxConfig: () => ({ userIsolation: false }),
    getSystemConfig: () => systemConfig,
    setSystemConfig: value => { systemConfig = value; return value; },
    addOrUpdateAccount(patch) {
      events.push(['save', { ...patch }]);
      const existing = accounts.find(account => account.id === patch.id);
      if (existing) Object.assign(existing, patch);
      else accounts.push({ ...patch, id: String(nextId++) });
      return snapshot();
    },
    deleteAccount(id) {
      events.push(['delete', id]);
      const index = accounts.findIndex(account => account.id === id);
      if (index !== -1) accounts.splice(index, 1);
      return snapshot();
    },
  };
  const provider = {
    getAccounts: () => ({
      nextId,
      accounts: accounts.map(account => ({
        ...account,
        running: running.has(account.id),
        autoLogin: account.autoLogin !== false,
        hasWxCredential: Boolean(account.loginBuffer),
        needsWxRescan: account.id === '2',
        nick: `runtime-${account.name}`,
      })),
    }),
    isAccountRunning: id => running.has(id),
    startAccount: id => { events.push(['start', id]); running.add(id); },
    restartAccount: async id => { events.push(['restart', id]); },
    stopAccount: async id => { events.push(['stop', id]); running.delete(id); },
    setRuntimeAccountName: (id, name) => events.push(['remark', id, name]),
    addAccountLog: (action, _message, id) => events.push(['log', action, id]),
    saveAutoCodeRefresh: async (id, settings) => events.push(['refresh', id, settings]),
  };
  const routes = new Map();
  const app = {
    get: (path, handler) => routes.set(`GET ${path}`, handler),
    post: (path, handler) => routes.set(`POST ${path}`, handler),
    delete: (path, handler) => routes.set(`DELETE ${path}`, handler),
  };
  routeModule.exports.registerAdminAccountRoutes({
    app, provider, store, findAccountByRef,
    addOrUpdateAccount: store.addOrUpdateAccount,
    deleteAccount: store.deleteAccount,
    userStore: { DEFAULT_ACCOUNT_LIMIT: 3 },
    updateRuntimeConfig: config => events.push(['version', config.clientVersion]),
    ...createAdminAccountAccess({ store, getProvider: () => provider }),
  });
  async function invoke(route, currentUser, req = {}) {
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(value) { this.body = value; return this; },
    };
    await routes.get(route)({ currentUser, headers: {}, ...req }, res);
    return { status: res.statusCode, body: res.body };
  }
  return { invoke, accounts, events };
}

function assertAccountView(data, ids, nextId) {
  assert.equal(data.nextId, nextId);
  assert.deepEqual(data.accounts.map(account => account.id), ids);
  for (const account of data.accounts) {
    for (const field of Object.keys(protectedFields)) {
      assert.equal(Object.hasOwn(account, field), false, field);
    }
    assert.equal(typeof account.running, 'boolean');
    assert.equal(typeof account.autoLogin, 'boolean');
    assert.equal(typeof account.hasWxCredential, 'boolean');
    assert.equal(typeof account.needsWxRescan, 'boolean');
    assert.equal(account.nick, `runtime-${account.name}`);
  }
}

test('账号读取保留可见账号的 Code、运行时字段和未知用户空视图', async () => {
  const f = accountRoutes();
  const result = await f.invoke('GET /api/accounts', owner);
  assert.equal(result.status, 200);
  assert.equal(result.body.ok, true);
  assertAccountView(result.body.data, ['1'], 3);
  assert.deepEqual(result.body.data.accounts[0], {
    ...ownerAccount, running: true, autoLogin: true, hasWxCredential: true, needsWxRescan: false, nick: 'runtime-First',
  });
  assert.deepEqual(await f.invoke('GET /api/accounts'), {
    status: 200, body: { ok: true, data: { accounts: [], nextId: 1 } },
  });
  assert.deepEqual(f.accounts[0].refreshToken, protectedFields.refreshToken);
});

for (const role of ['user', 'admin', 'super_admin']) {
  test(`${role} 的读取、新建、编辑、备注、删除共用最新账号视图`, async () => {
    const f = accountRoutes();
    const user = { ...owner, role };
    const isAdmin = role !== 'user';
    const initialIds = isAdmin ? ['1', '2'] : ['1'];
    const targetId = isAdmin ? '2' : '1';
    const visibleIds = [...initialIds, '3'];

    const read = await f.invoke('GET /api/accounts', user);
    assert.equal(read.status, 200);
    assertAccountView(read.body.data, initialIds, 3);

    const gateway = new URL(getDefaultSystemConfig().serverUrl);
    gateway.searchParams.set('code', 'fixture-new');
    gateway.searchParams.set('ver', '1.2.3_20261001');
    const create = await f.invoke('POST /api/accounts', user, {
      body: { name: 'New', platform: 'qq', username: otherOwner,
        gatewayUrl: gateway.toString() },
    });
    assert.equal(create.status, 200);
    assert.deepEqual(create.body.startup, { queued: true, autoRefreshEnabled: false });
    assert.equal(create.body.clientVersion, '1.2.3_20261001');
    assert.equal(create.body.clientVersionUpdated, true);
    assertAccountView(create.body.data, visibleIds, 4);
    assert.equal(create.body.data.accounts.at(-1).username, owner.username);
    assert.equal(create.body.data.accounts.at(-1).code, 'fixture-new');
    assert.equal(create.body.data.accounts.at(-1).running, true);
    assert.ok(f.events.some(event => event[0] === 'version' && event[1] === create.body.clientVersion));

    const edit = await f.invoke('POST /api/accounts', user, {
      body: { id: targetId, username: isAdmin ? owner.username : otherOwner, code: 'fixture-edited', autoLogin: false },
    });
    assert.equal(edit.status, 200);
    assert.deepEqual(edit.body.startup, { queued: false, autoRefreshEnabled: false });
    assert.equal(edit.body.clientVersion, '');
    assert.equal(edit.body.clientVersionUpdated, false);
    assertAccountView(edit.body.data, visibleIds, 4);
    const edited = edit.body.data.accounts.find(account => account.id === targetId);
    assert.equal(edited.username, owner.username);
    assert.equal(edited.code, 'fixture-edited');
    assert.equal(edited.autoLogin, false);

    const remark = await f.invoke('POST /api/account/remark', user, {
      body: { accountId: isAdmin ? targetId : ownerAccount.qq, remark: ' Renamed ' },
    });
    assert.equal(remark.status, 200);
    assert.equal(remark.body.ok, true);
    assertAccountView(remark.body.data, visibleIds, 4);
    const remarked = remark.body.data.accounts.find(account => account.id === targetId);
    assert.equal(remarked.name, 'Renamed');
    assert.equal(remarked.code, 'fixture-edited');
    assert.ok(f.events.some(event => event[0] === 'remark' && event[1] === targetId && event[2] === 'Renamed'));

    const deleted = await f.invoke('DELETE /api/accounts/:id', user, { params: { id: targetId } });
    assert.equal(deleted.status, 200);
    assert.equal(deleted.body.ok, true);
    assertAccountView(deleted.body.data, visibleIds.filter(id => id !== targetId), 4);
    assert.deepEqual(f.events.slice(-3), [['stop', targetId], ['delete', targetId], ['log', 'delete', targetId]]);
  });
}

test('不可见或不存在的备注返回同一 404，拒绝路径无副作用', async () => {
  const f = accountRoutes();
  const notFound = { status: 404, body: { ok: false, error: 'Account not found' } };
  assert.deepEqual(await f.invoke('POST /api/account/remark', owner, { body: { id: '404', remark: 'Unused' } }), notFound);
  assert.deepEqual(await f.invoke('POST /api/account/remark', owner, { body: { id: '2', remark: 'Unused' } }), notFound);
  assert.deepEqual(await f.invoke('POST /api/account/remark', owner, { body: { id: '1', remark: ' ' } }), {
    status: 400, body: { ok: false, error: 'Missing remark' },
  });
  const forbidden = { status: 403, body: { ok: false, error: '无权访问此账号' } };
  assert.deepEqual(await f.invoke('POST /api/accounts', owner, { body: { id: '2', name: 'Unused' } }), forbidden);
  assert.deepEqual(await f.invoke('DELETE /api/accounts/:id', owner, { params: { id: '2' } }), forbidden);
  assert.deepEqual(f.events, []);
});

test('普通编辑忽略客户端属主，保留纯备注更新和现有运行状态', async () => {
  const f = accountRoutes();
  const edit = await f.invoke('POST /api/accounts', owner, {
    body: { id: '1', name: 'Renamed', username: otherOwner },
  });
  assert.equal(edit.status, 200);
  assert.equal(f.accounts[0].username, owner.username);
  assert.equal(f.accounts[0].name, 'Renamed');
  assert.deepEqual(f.events, [['lock', '1'], ['save', { id: '1', name: 'Renamed' }], ['log', 'update', '1']]);
});

test('普通编辑在凭据锁等待期间失去归属时拒绝保存', async () => {
  const f = accountRoutes({ beforeLockedSave: accounts => { accounts[0].username = otherOwner; } });
  const edit = await f.invoke('POST /api/accounts', owner, { body: { id: '1', name: 'Late edit' } });
  assert.deepEqual(edit, { status: 403, body: { ok: false, error: '无权访问此账号' } });
  assert.equal(f.accounts[0].name, ownerAccount.name);
  assert.deepEqual(f.events, [['lock', '1']]);
});

test('桥接重复提交保持启动结果并返回安全账号视图', async () => {
  const f = accountRoutes();
  const duplicate = await f.invoke('POST /api/accounts', owner, {
    mengkaNtBridge: true,
    body: { ...ownerAccount },
  });
  assert.equal(duplicate.status, 200);
  assert.deepEqual(duplicate.body.bridge, { source: 'mengka_nt', state: 'unchanged', startPolicy: 'new_accounts_only' });
  assert.deepEqual(duplicate.body.startup, { queued: false, autoRefreshEnabled: false });
  assertAccountView(duplicate.body.data, ['1'], 3);
  assert.deepEqual(f.events, []);

  const updated = await f.invoke('POST /api/accounts', owner, {
    mengkaNtBridge: true,
    body: { ...ownerAccount, code: 'fixture-bridge-update' },
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.bridge.state, 'saved_online');
  assert.deepEqual(updated.body.startup, duplicate.body.startup);
  assertAccountView(updated.body.data, ['1'], 3);
  assert.equal(updated.body.data.accounts[0].code, 'fixture-bridge-update');
  assert.deepEqual(f.events.map(([action]) => action), ['lock', 'save', 'log']);
});

test('微信扫码新建保留启动和自动刷新状态，响应隐藏滚动凭据', async () => {
  const f = accountRoutes();
  const body = { platform: 'wx', loginType: 'wx_qr', wxid: 'fixture-wxid', code: 'fixture-scan-code' };
  const invalid = await f.invoke('POST /api/accounts', owner, { body: { ...body, wxSessionId: 'expired' } });
  assert.deepEqual(invalid, {
    status: 400, body: { ok: false, error: '微信扫码会话无效或已过期，请重新扫码' },
  });
  assert.deepEqual(f.events, []);
  const created = await f.invoke('POST /api/accounts', owner, { body: { ...body, wxSessionId: 'fixture-scan' } });
  assert.equal(created.status, 200);
  assert.deepEqual(created.body.startup, { queued: true, autoRefreshEnabled: true });
  assertAccountView(created.body.data, ['1', '3'], 4);
  assert.equal(created.body.data.accounts[1].code, body.code);
  assert.equal(created.body.data.accounts[1].hasWxCredential, true);
  assert.equal(f.accounts[2].loginBuffer, protectedFields.loginBuffer);
  assert.deepEqual(f.events.slice(-2), [['refresh', '3', { enabled: true, intervalMinutes: 60 }], ['start', '3']]);
});

test('既有微信账号重新扫码保留属主、自动登录和启动状态，返回新 Code', async () => {
  const f = accountRoutes();
  Object.assign(f.accounts[0], { platform: 'wx', wxid: 'fixture-wxid' });
  const result = await f.invoke('POST /api/accounts', owner, {
    body: {
      id: '1', platform: 'wx', wxid: 'fixture-wxid', wxSessionId: 'fixture-scan',
      username: otherOwner, autoLogin: false, code: 'fixture-rescan-code',
    },
  });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.startup, { queued: true, autoRefreshEnabled: false, state: 'submitted' });
  assertAccountView(result.body.data, ['1'], 3);
  assert.equal(result.body.data.accounts[0].username, owner.username);
  assert.equal(result.body.data.accounts[0].autoLogin, true);
  assert.equal(result.body.data.accounts[0].code, 'fixture-rescan-code');
  assert.deepEqual(f.events.map(([action]) => action), ['lock', 'save', 'consume', 'log', 'restart']);
});
