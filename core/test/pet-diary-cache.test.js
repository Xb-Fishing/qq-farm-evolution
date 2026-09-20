const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createActivityReadCache } = require('../src/controllers/activity-read-cache');
const { registerAdminBearActivityRoutes } = require('../src/controllers/admin-bear-activity-routes');
const { registerAdminPetDiaryOperateRoutes } = require('../src/controllers/admin-pet-diary-operate-routes');

test('手动萌宠操作清除真实读取缓存，权限拒绝不触发操作', async () => {
  const routes = new Map();
  let version = 0;
  let reads = 0;
  let allowed = true;
  const context = {
    app: { get: (url, handler) => routes.set(url, handler), post: (url, handler) => routes.set(url, handler) },
    activityReader: createActivityReadCache(),
    provider: {
      getStatus: () => ({ connection: { connected: true } }),
      isAccountRunning: () => true,
      getBearActivity: async () => { reads += 1; return { version }; },
      operatePetDiary: async () => { version += 1; return { message: 'done' }; },
    },
    getAccountIdFromRequest: () => 'fixture-account',
    canAccessAccount: () => allowed,
    sendProviderError: (_res, error) => { throw error; },
  };
  registerAdminBearActivityRoutes(context);
  registerAdminPetDiaryOperateRoutes(context);
  async function invoke(route, body) {
    let value;
    let status = 200;
    const res = { status(code) { status = code; return res; }, json(data) { value = data; } };
    await routes.get(route)({ body }, res);
    return { status, ...value };
  }
  const read = () => invoke('/api/activity/bear');
  const write = () => invoke('/api/activity/pet-diary/operate', { action: 'initialize' });
  assert.equal((await read()).activity.version, 0);
  assert.equal((await read()).upstreamCached, true);
  assert.equal(reads, 1);
  assert.equal((await write()).ok, true);
  assert.equal((await read()).activity.version, 1);
  assert.equal(reads, 2);
  allowed = false;
  assert.equal((await write()).status, 403);
  assert.equal(version, 1);
});

test('业务拒绝/传输失败/未运行不清除成功缓存、不触发额外写请求或刷新', async () => {
  const routes = new Map();
  let version = 0;
  let reads = 0;
  let operates = 0;
  const running = { value: true };
  const provider = {
    getStatus: () => ({ connection: { connected: true } }),
    isAccountRunning: async () => running.value,
    getBearActivity: async () => { reads += 1; return { version }; },
    operatePetDiary: async () => {
      operates += 1;
      if (operates === 1) {
        // 业务前置拒绝：business 标记 + 固定 code（跨层元数据还原后的形态）
        const err = new Error('今日投喂次数已用完');
        err.business = true;
        err.code = 'PET_DIARY_LIMIT';
        throw err;
      }
      if (operates === 2) throw new Error('upstream transport down'); // 普通传输失败
      version += 1;
      return { message: 'done' };
    },
  };
  const context = {
    app: { get: (url, handler) => routes.set(url, handler), post: (url, handler) => routes.set(url, handler) },
    activityReader: createActivityReadCache(),
    provider,
    getAccountIdFromRequest: () => 'fixture-account',
    canAccessAccount: () => true,
  };
  registerAdminBearActivityRoutes(context);
  registerAdminPetDiaryOperateRoutes(context);

  async function invoke(route, body = {}) {
    let value;
    let status = 200;
    const res = { status(code) { status = code; return res; }, json(data) { value = data; } };
    const handler = route === '/api/activity/bear'
      ? routes.get(route) : routes.get(route);
    await handler({ body }, res);
    return { status, ...value };
  }
  const read = () => invoke('/api/activity/bear');
  const operate = action => invoke('/api/activity/pet-diary/operate', { action });

  // 建立成功读缓存
  assert.equal((await read()).activity.version, 0);
  assert.equal(reads, 1);
  assert.equal((await read()).upstreamCached, true);

  // 1. 业务拒绝：400 + 固定 code，不清缓存、不触发额外读
  const business = await operate('feed');
  assert.equal(business.status, 400);
  assert.equal(business.ok, false);
  assert.equal(business.code, 'PET_DIARY_LIMIT');
  assert.match(business.error, /次数已用完/);
  assert.equal((await read()).upstreamCached, true);
  assert.equal(reads, 1);

  // 2. 传输失败：502、无业务码，不清缓存
  const transport = await operate('feed');
  assert.equal(transport.status, 502);
  assert.equal(transport.ok, false);
  assert.equal(transport.code, undefined);
  assert.equal((await read()).upstreamCached, true);
  assert.equal(reads, 1);

  // 3. 账号未运行：保留现有 409 语义，不清缓存、零 Worker 操作调用
  running.value = false;
  const notRunning = await operate('feed');
  assert.equal(notRunning.status, 409);
  assert.equal(notRunning.ok, false);
  assert.equal((await read()).upstreamCached, true);
  assert.equal(reads, 1);
  running.value = true;

  // 4. 成功操作仍正常清缓存（既有行为）
  const ok = await operate('feed');
  assert.equal(ok.status, 200);
  assert.equal((await read()).activity.version, 1);
  assert.equal(reads, 2);
  assert.equal(operates, 3);
});
