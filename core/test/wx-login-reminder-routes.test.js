'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/**
 * 微信登录提醒 / 自助重扫路由（admin-wx-login-reminder-routes）回归：
 * 真实异步配置保存（不把 Promise 序列化进响应）、400/503 语义、
 * 用户隔离与 403、管理员代点时推送目标必须取账号属主（而非点击者）、
 * 公开图片能力在认证门前可用且令牌吊销即 410、启用补发、重试路由映射。
 */

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farm-wxlr-routes-'));
process.env.FARM_DATA_DIR = dataDir;
fs.writeFileSync(path.join(dataDir, 'accounts.json'), JSON.stringify({
  accounts: [
    { id: '301', name: '农场号A', platform: 'wx', username: 'owner1', wxid: 'openid-A', code: 'c1' },
    { id: '302', name: '农场号B', platform: 'wx', username: 'owner2', wxid: 'openid-B', code: 'c2' },
    { id: '303', name: 'QQ号', platform: 'qq', username: 'owner1', code: 'c3' },
  ],
  nextId: 304,
}));

// 共享服务的 fetchImpl 在首次创建时绑定全局 fetch：先打桩再注册路由。
const pushes = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  pushes.push({ url: String(url), body: init && init.body ? JSON.parse(init.body) : null });
  return { ok: true, status: 200, json: async () => ({ code: 200 }) };
};
test.after(() => {
  globalThis.fetch = realFetch;
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const store = require('../src/models/store');
const reminderModule = require('../src/services/wx-login-reminder');
const adapter = require('../src/services/wx-login-adapter');
const { registerAdminWxLoginReminderRoutes, registerWxLoginQrImageRoute } = require('../src/controllers/admin-wx-login-reminder-routes');

// 共享服务绑定真实 adapter：只在网络边界（二维码会话）打桩，其余原语保持真实。
const PNG_B64 = Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47]), Buffer.alloc(32)]).toString('base64');
let qrCallCount = 0;
const realAdapterFns = {
  getQRCode: adapter.getQRCode, checkQR: adapter.checkQR,
  cancelWxSession: adapter.cancelWxSession, getWxSessionInfo: adapter.getWxSessionInfo,
};
adapter.getQRCode = async () => {
  qrCallCount += 1;
  const createdAt = Date.now();
  return {
    Success: true,
    Data: {
      Uuid: `routes-sess-${qrCallCount}`, QrBase64: PNG_B64,
      CreatedAt: createdAt, ExpiresAt: createdAt + 300_000,
    },
  };
};
adapter.checkQR = async () => ({ Success: true, Data: { status: 0 } });
adapter.cancelWxSession = () => true;
adapter.getWxSessionInfo = () => null;
test.after(() => {
  Object.assign(adapter, realAdapterFns);
});

const routes = {};
const app = {
  get: (p, h) => { routes[`GET ${p}`] = h; },
  post: (p, h) => { routes[`POST ${p}`] = h; },
};
function findAccount(id) {
  const data = store.getAccounts();
  return (data.accounts || []).find(a => String(a.id) === String(id)) || null;
}
registerAdminWxLoginReminderRoutes({
  app,
  canAccessAccount: (req, accountId) => {
    const user = req.currentUser;
    if (!user) return false;
    if (user.role === 'admin') return true;
    const account = findAccount(accountId);
    return !!account && String(account.username) === String(user.username);
  },
  resolveAccountReference: ref => ref,
  findAccountByRef: (data, id) =>
    ((data && data.accounts) || []).find(a => String(a.id) === String(id)) || null,
  getAccountsForUser: store.getAccounts,
  logger: { info() {}, warn() {} },
});
registerWxLoginQrImageRoute(app);

const shared = reminderModule.getSharedWxLoginReminder();

function resFor() {
  return {
    statusCode: 200, body: null, headers: {}, ended: false,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
    setHeader(k, v) { this.headers[String(k).toLowerCase()] = v; },
    end() { this.ended = true; return this; },
    send(payload) { this.body = payload; return this; },
  };
}
async function call(method, routePath, { user, body, query, params } = {}) {
  const handler = routes[`${method} ${routePath}`];
  assert.ok(typeof handler === 'function', `路由未注册: ${method} ${routePath}`);
  const req = { currentUser: user, body: body || {}, query: query || {}, params: params || {} };
  const res = resFor();
  await handler(req, res);
  return res;
}
const owner1 = { username: 'owner1' };
const owner2 = { username: 'owner2' };
const admin = { username: 'admin', role: 'admin' };

test('未登录一律 401，匿名不得读取配置/状态/发送', async () => {
  for (const [method, p, body] of [
    ['GET', '/api/user/wx-login-reminder/config', null],
    ['POST', '/api/user/wx-login-reminder/config', {}],
    ['GET', '/api/wx-login-help/status', null],
    ['POST', '/api/wx-login-help/send-qr', { accountId: '301' }],
    ['POST', '/api/wx-login-help/retry-login', { accountId: '301' }],
  ]) {
    const res = await call(method, p, { body });
    assert.equal(res.statusCode, 401, `${method} ${p} 必须先登录`);
    assert.equal(res.body.ok, false);
  }
});

test('配置保存是真实异步落盘：POST 后 GET/磁盘都返回持久化字段', async () => {
  const res = await call('POST', '/api/user/wx-login-reminder/config', {
    user: owner1,
    body: {
      enabled: true,
      barkServer: 'https://bark.selfhost.example.com',
      deviceKey: 'owner1-key',
      serverUrl: 'https://panel.example.com',
    },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.config.enabled, true);
  assert.equal(res.body.config.deviceKey, 'owner1-key');
  assert.equal(typeof res.body.config.barkServer, 'string');

  const read = await call('GET', '/api/user/wx-login-reminder/config', { user: owner1 });
  assert.equal(read.statusCode, 200);
  assert.deepEqual(read.body.config, {
    enabled: true,
    barkServer: 'https://bark.selfhost.example.com',
    deviceKey: 'owner1-key',
    serverUrl: 'https://panel.example.com',
    advanceEnabled: true,
    maintenanceCycleHours: 24,
    advanceMinutes: 60,
  });
  // 磁盘上确实有（重启可恢复），且为私有权限。
  const registry = JSON.parse(fs.readFileSync(path.join(dataDir, 'wx-login-reminder.json'), 'utf8'));
  assert.equal(registry.users.owner1.deviceKey, 'owner1-key');
  assert.equal(fs.statSync(path.join(dataDir, 'wx-login-reminder.json')).mode & 0o777, 0o600);
});

test('配置校验失败 400：带字段级错误，不落盘', async () => {
  const addressWithFixtureCredentials = new URL('https://bark.example.com');
  const FIXTURE_ADDRESS_PASSWORD = '[REDACTED]';
  addressWithFixtureCredentials.username = 'fixture-user';
  addressWithFixtureCredentials.password = FIXTURE_ADDRESS_PASSWORD;
  const cases = [
    { enabled: 'yes' },
    { barkServer: 'ftp://bark.example.com' },
    { barkServer: addressWithFixtureCredentials.href },
    { deviceKey: 'has space inside' },
    { serverUrl: 'javascript:alert(1)' },
  ];
  for (const body of cases) {
    const res = await call('POST', '/api/user/wx-login-reminder/config', { user: owner2, body });
    assert.equal(res.statusCode, 400, JSON.stringify(body));
    assert.equal(res.body.ok, false);
    assert.ok(Object.keys(res.body.fields || {}).length > 0, '必须给出字段级错误');
  }
  const untouched = await call('GET', '/api/user/wx-login-reminder/config', { user: owner2 });
  assert.equal(untouched.body.config.deviceKey, '', '非法补丁不得部分落盘');
});

test('维护计划字段校验：数值边界、周期-提前量关系、部分 PATCH 合并、可关闭', async () => {
  // 非法值：非有限数、越界、提前量不小于周期。
  for (const body of [
    { maintenanceCycleHours: 3 },
    { maintenanceCycleHours: 169 },
    { maintenanceCycleHours: 'abc' },
    { advanceMinutes: 4 },
    { advanceMinutes: 24 * 60 },
    { maintenanceCycleHours: 4, advanceMinutes: 240 },
    { advanceEnabled: 'yes' },
  ]) {
    const res = await call('POST', '/api/user/wx-login-reminder/config', { user: owner2, body });
    assert.equal(res.statusCode, 400, JSON.stringify(body));
    assert.equal(res.body.ok, false);
    assert.ok(Object.keys(res.body.fields || {}).length > 0);
  }

  // 只改周期但小于既有提前量：关系校验必须拦截。
  const shrink = await call('POST', '/api/user/wx-login-reminder/config', {
    user: owner2, body: { maintenanceCycleHours: 5 },
  });
  // 默认提前量 60 < 5h：应通过；把提前量改大后再缩周期才被拦。
  assert.equal(shrink.statusCode, 200);
  const widen = await call('POST', '/api/user/wx-login-reminder/config', {
    user: owner2, body: { advanceMinutes: 290 },
  });
  assert.equal(widen.statusCode, 200);
  assert.equal(widen.body.config.advanceMinutes, 290);
  const shrinkNow = await call('POST', '/api/user/wx-login-reminder/config', {
    user: owner2, body: { maintenanceCycleHours: 4 },
  });
  assert.equal(shrinkNow.statusCode, 400);
  assert.ok(shrinkNow.body.fields.maintenanceCycleHours);

  // 部分 PATCH 合并：只改提前量，周期保持。
  const partial = await call('POST', '/api/user/wx-login-reminder/config', {
    user: owner2, body: { advanceMinutes: 90 },
  });
  assert.equal(partial.statusCode, 200);
  assert.equal(partial.body.config.advanceMinutes, 90);
  assert.equal(partial.body.config.maintenanceCycleHours, 5);

  // 可整体关闭提前提醒（保留终态失效提醒模式）。
  const off = await call('POST', '/api/user/wx-login-reminder/config', {
    user: owner2, body: { advanceEnabled: false },
  });
  assert.equal(off.statusCode, 200);
  assert.equal(off.body.config.advanceEnabled, false);
  assert.equal(off.body.config.enabled, false, '总开关仍保持用户自己的设置');
});

test('启用时面板地址必须手机可达：localhost 拒绝；缺地址拒绝启用', async () => {
  const local = await call('POST', '/api/user/wx-login-reminder/config', {
    user: owner2,
    body: { enabled: true, deviceKey: 'k2', serverUrl: 'http://127.0.0.1:8080' },
  });
  assert.equal(local.statusCode, 400);
  assert.ok(local.body.fields.serverUrl);

  const missing = await call('POST', '/api/user/wx-login-reminder/config', {
    user: owner2,
    body: { enabled: true, deviceKey: 'k2' },
  });
  assert.equal(missing.statusCode, 400);
  assert.ok(missing.body.fields.serverUrl);
});

test('状态文件写入失败 → 503 而非 500/成功', async () => {
  const original = shared.setUserConfig;
  shared.setUserConfig = async () => { throw new Error('REGISTRY_UNAVAILABLE'); };
  try {
    const res = await call('POST', '/api/user/wx-login-reminder/config', {
      user: owner2,
      body: { enabled: false, deviceKey: 'k2', serverUrl: 'https://panel2.example.com' },
    });
    assert.equal(res.statusCode, 503);
    assert.equal(res.body.ok, false);
  }
  finally {
    shared.setUserConfig = original;
  }
});

test('配置按登录用户隔离：owner2 读不到 owner1 的 Key', async () => {
  const res = await call('GET', '/api/user/wx-login-reminder/config', { user: owner2 });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.config.deviceKey, '');
  assert.equal(res.body.config.enabled, false);
});

test('注册表文件携带 __proto__ 用户键不产生原型污染（重启后语义）', async () => {
  const file = path.join(dataDir, 'wx-login-reminder.json');
  // JSON.parse 产物中的 __proto__ 是自有键；新实例（等价重启）按自有键处理且不污染原型。
  fs.writeFileSync(file, JSON.stringify({
    users: JSON.parse('{"owner1":{"enabled":true,"deviceKey":"owner1-key","serverUrl":"https://panel.example.com"},"__proto__":{"enabled":true,"deviceKey":"evil"}}'),
    generations: {},
    incidents: {},
  }));
  const reborn = reminderModule.createWxLoginReminderService({
    getAccounts: store.getAccounts, log: () => {}, registryFile: () => file,
  });
  assert.equal(reborn.getUserConfig('owner2').deviceKey, '', '不得读到 __proto__ 里的配置');
  assert.equal(({}).deviceKey, undefined, 'Object.prototype 不得被污染');
  assert.equal(reborn.getUserConfig('owner1').deviceKey, 'owner1-key');
});

test('状态接口：缺参 400 / 他人账号 403 / 不存在 404 / 非微信 400；本人正常', async () => {
  const missing = await call('GET', '/api/wx-login-help/status', { user: owner1, query: {} });
  assert.equal(missing.statusCode, 400);

  const foreign = await call('GET', '/api/wx-login-help/status', { user: owner2, query: { accountId: '301' } });
  assert.equal(foreign.statusCode, 403);

  // 访问权先于存在性检查：普通用户对未知账号 403（不泄露存在性）；
  // 管理员（访问权恒真）才走得到「账号不存在」的 404。
  const noneAsUser = await call('GET', '/api/wx-login-help/status', { user: owner1, query: { accountId: '999' } });
  assert.equal(noneAsUser.statusCode, 403);
  const none = await call('GET', '/api/wx-login-help/status', { user: admin, query: { accountId: '999' } });
  assert.equal(none.statusCode, 404);

  const qq = await call('GET', '/api/wx-login-help/status', { user: owner1, query: { accountId: '303' } });
  assert.equal(qq.statusCode, 400);

  const ok = await call('GET', '/api/wx-login-help/status', { user: owner1, query: { accountId: '301' } });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.body.ok, true);
  assert.equal(typeof ok.body.data.serverNow, 'number', '状态必须带服务器时钟（供前端做偏移无关倒计时）');
  assert.equal(ok.body.data.account.id, '301');
  assert.equal(ok.body.data.incident.needsRescan, false);
});

test('发送二维码：推送目标取账号属主配置（管理员代点也是发给属主）', async () => {
  pushes.length = 0;
  const res = await call('POST', '/api/wx-login-help/send-qr', {
    user: admin, // 管理员有权访问，但绝不能推给管理员的设备
    body: { accountId: '301' },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.data.pushed, true);
  assert.equal(pushes.length, 1, '属主配置就绪：恰好一次外发');
  const body = pushes[0].body;
  assert.equal(body.device_key, 'owner1-key', 'device_key 必须是账号属主的 Key');
  assert.match(body.image, /^https:\/\/panel\.example\.com\/api\/wx-login-qr-image\/[0-9a-f]{64}$/);
  assert.match(body.url, /\/wx-login-help\?accountId=301$/);
  assert.equal(res.body.data.session.sessionId.length > 0, true);
});

test('属主未配置 Bark：会话仍在页面展示，pushed=false 且带原因，不外发', async () => {
  pushes.length = 0;
  const res = await call('POST', '/api/wx-login-help/send-qr', {
    user: owner2,
    body: { accountId: '302' },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.data.pushed, false);
  assert.ok(res.body.data.pushError.length > 0);
  assert.equal(pushes.length, 0, '未配置绝不外发');
});

test('公开图片路由在认证门前可用：有效令牌 200 PNG，无效/被替换 410', async () => {
  pushes.length = 0;
  // 通过属主本人真实发送拿令牌（响应不含令牌；从推送的 image URL 提取）。
  await call('POST', '/api/wx-login-help/send-qr', { user: owner1, body: { accountId: '301' } });
  const token = String(pushes[0].body.image).split('/').pop();
  const good = await call('GET', '/api/wx-login-qr-image/:token', { params: { token } });
  assert.equal(good.statusCode, 200, '未登录也可读图（Bark 通知内嵌图片）');
  assert.equal(good.headers['content-type'], 'image/png');
  assert.equal(good.headers['cache-control'], 'no-store');
  assert.ok(Buffer.isBuffer(good.body) && good.body.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47])));

  const bad = await call('GET', '/api/wx-login-qr-image/:token', { params: { token: 'f'.repeat(64) } });
  assert.equal(bad.statusCode, 410);

  // 重新发送会吊销旧令牌：旧图立即 410。
  pushes.length = 0;
  await call('POST', '/api/wx-login-help/send-qr', { user: owner1, body: { accountId: '301' } });
  const replaced = await call('GET', '/api/wx-login-qr-image/:token', { params: { token } });
  assert.equal(replaced.statusCode, 410, '被新二维码替换的旧令牌必须立即吊销');
});

test('重试完成登录路由映射：失败 400；成功如实报告 started/startError', async () => {
  const original = shared.retryCompleteLogin;
  try {
    shared.retryCompleteLogin = async () => ({ ok: false, error: '本地扫码会话已到期' });
    const failed = await call('POST', '/api/wx-login-help/retry-login', {
      user: owner1, body: { accountId: '301' },
    });
    assert.equal(failed.statusCode, 400);
    assert.equal(failed.body.error, '本地扫码会话已到期');

    shared.retryCompleteLogin = async () => ({ ok: true, started: false, error: '账号启动失败: x' });
    const savedNotStarted = await call('POST', '/api/wx-login-help/retry-login', {
      user: owner1, body: { accountId: '301' },
    });
    assert.equal(savedNotStarted.statusCode, 200);
    assert.deepEqual(savedNotStarted.body.data, { started: false, startError: '账号启动失败: x' });

    shared.retryCompleteLogin = async () => ({ ok: true, started: true });
    const started = await call('POST', '/api/wx-login-help/retry-login', {
      user: owner1, body: { accountId: '301' },
    });
    assert.deepEqual(started.body.data, { started: true, startError: '' });
  }
  finally {
    shared.retryCompleteLogin = original;
  }
  const foreign = await call('POST', '/api/wx-login-help/retry-login', {
    user: owner2, body: { accountId: '301' },
  });
  assert.equal(foreign.statusCode, 403);
});

test('启用提醒时补发此前未发送的待重扫事件（每代次至多一条）', async () => {
  pushes.length = 0;
  // owner2 先经历一次失效（未配置 → 只记 needsRescan，不外发）。
  assert.equal(await shared.noteCredentialInvalid('302'), false);
  assert.equal(shared.getIncident('302').needsRescan, true);
  assert.equal(pushes.length, 0);

  const enable = await call('POST', '/api/user/wx-login-reminder/config', {
    user: owner2,
    body: { enabled: true, deviceKey: 'owner2-key', serverUrl: 'https://panel2.example.com' },
  });
  assert.equal(enable.statusCode, 200);
  assert.deepEqual(enable.body.dispatched, ['302'], '启用即补发该用户所有未声明事件');
  assert.equal(pushes.length, 1);
  assert.equal(pushes[0].body.device_key, 'owner2-key');
  assert.match(pushes[0].body.url, /\/wx-login-help\?accountId=302$/);

  // 再次保存（无新事件）：不再补发。
  pushes.length = 0;
  const again = await call('POST', '/api/user/wx-login-reminder/config', {
    user: owner2,
    body: { enabled: true, deviceKey: 'owner2-key', serverUrl: 'https://panel2.example.com' },
  });
  assert.equal(again.statusCode, 200);
  assert.deepEqual(again.body.dispatched, []);
  assert.equal(pushes.length, 0);
});

test('send-qr 被更新的请求取代：返回 superseded 而非错误', async () => {
  const original = shared.requestQrPush;
  try {
    shared.requestQrPush = async () => ({ superseded: true });
    const res = await call('POST', '/api/wx-login-help/send-qr', {
      user: owner1, body: { accountId: '301' },
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body.data, { superseded: true });
  }
  finally {
    shared.requestQrPush = original;
  }
});
