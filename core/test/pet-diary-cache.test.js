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
