const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const SESSION_TOKEN = crypto.randomBytes(18).toString('hex');
const FIXTURE_PASSWORD = crypto.randomBytes(18).toString('hex');

const tempParent = fs.realpathSync(os.tmpdir());
const tempPrefix = path.resolve(tempParent, 'farm-mengka-nt-');
assert.equal(path.dirname(tempPrefix), tempParent);
const tempRoot = fs.mkdtempSync(tempPrefix);
process.env.FARM_DATA_DIR = tempRoot;
process.env.FARM_PRIVATE_CONFIG_FILE = path.join(tempRoot, 'none.json');
test.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
const express = require('express');
const { registerMengkaNtBridge } = require('../src/controllers/mengka-nt-bridge');
const { registerAdminAuthRoutes } = require('../src/controllers/admin-auth-routes');
const { registerAdminAccountRoutes } = require('../src/controllers/admin-account-routes');

async function fixture(t, options = {}) {
  const accounts = (options.accounts || []).map(account => ({ ...account }));
  const running = new Set(options.running || []);
  const starts = [];
  const restarts = [];
  const writes = [];
  const user = { username: 'fixture-owner', role: 'user', accountLimit: options.limit || 2 };
  const sessions = new Map();
  const app = express();
  app.use(express.json());
  registerMengkaNtBridge(app);
  const getAccounts = () => ({ accounts: accounts.map(account => ({ ...account })) });
  const provider = { getAccounts, isAccountRunning: id => running.has(String(id)),
    startAccount: id => { starts.push(String(id)); running.add(String(id)); return true; },
    restartAccount: id => { restarts.push(String(id)); return true; }, addAccountLog: () => {} };
  const requireToken = (req, res, next) => {
    const current = sessions.get(req.headers['x-admin-token']);
    if (!current) return res.status(401).json({ ok: false, error: '未登录' });
    req.currentUser = current;
    return next();
  };
  registerAdminAuthRoutes({ app, logger: { warn() {} },
    userStore: { validateUser: (name, password) => name === user.username && password === FIXTURE_PASSWORD ? user : null,
      addLoginLog() {}, DEFAULT_ACCOUNT_LIMIT: 2 },
    requireAdminToken: requireToken,
    createAdminSession: value => { sessions.set(SESSION_TOKEN, value); return SESSION_TOKEN; }, updateAdminSessions() {},
  });
  app.use('/api', requireToken);
  registerAdminAccountRoutes({ app, provider, getIo: () => null,
    addOrUpdateAccount: body => {
      writes.push({ ...body });
      const index = accounts.findIndex(account => account.id === body.id);
      if (index >= 0) accounts[index] = { ...accounts[index], ...body };
      else accounts.push({ id: String(accounts.length + 1), autoLogin: true, ...body });
      return getAccounts();
    },
    getAccountsForUser: username => username ? accounts.filter(account => account.username === username) : accounts,
    resolveAccountReference: value => String(value),
    canAccessAccount: (req, id) => accounts.some(account => account.id === String(id) && account.username === req.currentUser.username),
    userStore: { DEFAULT_ACCOUNT_LIMIT: 2 }, store: {},
  });
  const server = await new Promise(resolve => { const result = app.listen(0, '127.0.0.1', () => resolve(result)); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const request = (route, body, token = SESSION_TOKEN) => new Promise((resolve, reject) => {
    const outgoing = http.request({ hostname: server.address().address, port: server.address().port, path: route,
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { 'x-admin-token': token } : {}) },
    }, (response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { text += chunk; });
      response.on('end', () => {
        try { resolve({ status: response.statusCode, data: JSON.parse(text) }); }
        catch (error) { reject(error); }
      });
    });
    outgoing.on('error', reject);
    outgoing.setTimeout(3000, () => outgoing.destroy(new Error('fixture request timeout')));
    outgoing.end(body === undefined ? undefined : JSON.stringify(body));
  });
  const login = () => request('/mengka-nt/api/login', { username: user.username, password: FIXTURE_PASSWORD }, '');
  return { accounts, running, starts, restarts, writes, request, login, sessions };
}

const push = overrides => ({ name: 'QQ fixture', code: 'fresh-code', platform: 'qq', uin: '10001', qq: '10001', ...overrides });
const existing = overrides => ({ id: '1', name: 'QQ fixture', code: 'old-code', platform: 'qq',
  uin: '10001', qq: '10001', username: 'fixture-owner', credentialGeneration: 'credential-a', sessionGeneration: 'session-a', ...overrides });

test('真实 HTTP：桥接账号密码登录与原Token鉴权一致，新账号创建并启动，重复推送不重启', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.request('/mengka-nt/api/accounts', push(), '')).status, 401);
  assert.equal((await f.request('/mengka-nt/api/login', { username: 'fixture-owner', password: 'wrong' }, '')).status, 401);
  const login = await f.login();
  assert.equal(login.data.data.token, SESSION_TOKEN);
  assert.equal((await f.request('/mengka-nt/api/accounts')).data.data.accounts.length, 0);
  const created = await f.request('/mengka-nt/api/accounts', push());
  assert.equal(created.data.bridge.state, 'created');
  assert.equal(created.data.startup.queued, true);
  assert.deepEqual(f.starts, ['1']);
  assert.equal(f.accounts[0].loginType, 'mengka_nt');
  const repeated = await f.request('/mengka-nt/api/accounts', push({ id: '1' }));
  assert.equal(repeated.data.bridge.state, 'unchanged');
  assert.equal(f.writes.length, 1);
  assert.deepEqual(f.restarts, []);
  f.sessions.clear();
  assert.equal((await f.request('/mengka-nt/api/accounts', push({ id: '1' }))).status, 401);
  assert.equal(f.writes.length, 1);
});

test('健康在线QQ只更新Code，保留连接代次；原手动保存仍沿原重启行为', async (t) => {
  const f = await fixture(t, { accounts: [existing()], running: ['1'] });
  await f.login();
  const result = await f.request('/mengka-nt/api/accounts', push({ id: '1' }));
  assert.equal(result.data.bridge.state, 'saved_online');
  assert.equal(result.data.startup.queued, false);
  assert.equal(f.accounts[0].code, 'fresh-code');
  assert.equal(f.accounts[0].credentialGeneration, 'credential-a');
  assert.equal(f.accounts[0].sessionGeneration, 'session-a');
  assert.deepEqual(f.starts, []);
  assert.deepEqual(f.restarts, []);
  await f.request('/api/accounts', push({ id: '1', code: 'manual-code', mengkaNtBridge: true }));
  assert.deepEqual(f.restarts, ['1']);
});

test('已有离线或手动停用的QQ只保存，不拉起；请求不能改自动登录和微信凭据', async (t) => {
  const f = await fixture(t, { accounts: [existing({ autoLogin: false })] });
  await f.login();
  const result = await f.request('/mengka-nt/api/accounts', push({ id: '1', autoLogin: true,
    username: 'another-user', loginBuffer: 'forged', startAfterSave: true }));
  assert.equal(result.data.bridge.state, 'saved_offline');
  assert.equal(f.accounts[0].autoLogin, false);
  assert.equal(f.accounts[0].username, 'fixture-owner');
  assert.equal(f.accounts[0].loginBuffer, undefined);
  assert.deepEqual(f.starts, []);
});

test('拒绝跨用户/跨平台/错QQ和超额创建；响应仅含本用户账号，非法桥接路径不放行', async (t) => {
  const f = await fixture(t, { accounts: [existing(), existing({ id: '2', qq: '10002', uin: '10002', username: 'other-owner' }),
    existing({ id: '3', platform: 'wx' })], limit: 2 });
  await f.login();
  assert.equal((await f.request('/mengka-nt/api/accounts', push({ id: '2', qq: '10002', uin: '10002' }))).status, 403);
  assert.equal((await f.request('/mengka-nt/api/accounts', push({ id: '2' }))).status, 403);
  assert.equal((await f.request('/mengka-nt/api/accounts', push({ id: '2', platform: 'wx' }))).status, 403);
  assert.equal((await f.request('/mengka-nt/api/accounts', push({ id: 'unknown-account' }))).status, 403);
  assert.equal((await f.request('/mengka-nt/api/accounts', push({ id: '3' }))).status, 409);
  assert.equal((await f.request('/mengka-nt/api/accounts', push({ id: '1', qq: '10009', uin: '10009' }))).status, 409);
  assert.equal((await f.request('/mengka-nt/api/accounts', push({ platform: 'wx' }))).status, 400);
  assert.equal((await f.request('/mengka-nt/api/accounts', push({ code: '' }))).status, 400);
  assert.equal((await f.request('/mengka-nt/api/accounts', push({ qq: '10003', uin: '10003' }))).status, 403);
  const result = await f.request('/mengka-nt/api/accounts', push({ id: '1' }));
  assert.deepEqual(result.data.data.accounts.map(account => account.id), ['1', '3']);
  assert.equal((await f.request('/mengka-nt/api/accounts/2/restart', {})).status, 404);
  assert.equal(f.writes.length, 1);
});

test('等待保存锁时账号转移、换绑或删除，拒绝迟到推送且零写零启动', async (t) => {
  const adapter = require('../src/services/wx-login-adapter');
  for (const variant of ['owner', 'qq', 'platform', 'removed']) {
    const f = await fixture(t, { accounts: [existing()] });
    await f.login();
    let release;
    const blocked = new Promise(resolve => { release = resolve; });
    let reached;
    const waiting = new Promise(resolve => { reached = resolve; });
    const original = adapter.withAccountCredentialLock;
    adapter.withAccountCredentialLock = async (_wxid, _id, save) => { reached(); await blocked; return save(); };
    try {
      const request = f.request('/mengka-nt/api/accounts', push({ id: '1' }));
      await waiting;
      if (variant === 'owner') f.accounts[0].username = 'another-owner';
      if (variant === 'qq') f.accounts[0].qq = '10009';
      if (variant === 'platform') f.accounts[0].platform = 'wx';
      if (variant === 'removed') f.accounts.length = 0;
      release();
      const response = await request;
      assert.equal(response.status, 409, variant);
      assert.equal(f.writes.length, 0, variant);
      assert.equal(f.starts.length, 0, variant);
      assert.equal(f.restarts.length, 0, variant);
    } finally { release(); adapter.withAccountCredentialLock = original; }
  }
});
