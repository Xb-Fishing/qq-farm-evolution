const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createActivityReadCache } = require('../src/controllers/activity-read-cache');
const { registerAdminSeasonActivityRoutes } = require('../src/controllers/admin-season-activity-routes');

// 2026-09-25 事故回归：read 缓存曾以无参调用 loader，参数风格的
// `read: (accountId) => provider.getX(accountId)` 拿到 undefined →
// resolveAccountId('') → 误报「账号未运行」。loader 必须收到 cacheKey。
test('season 路由 loader 收到 accountId，不再误报账号未运行', async () => {
  const routes = new Map();
  const seenKeys = [];
  const context = {
    app: { get: (url, handler) => routes.set(url, handler) },
    activityReader: createActivityReadCache({ ttlMs: 60_000 }),
    provider: {
      getStatus: () => ({ connection: { connected: true } }),
      getWishActivity: async (ref) => { seenKeys.push(['wish', ref]); return { ok: ref === '1' }; },
      getHappyShareActivity: async (ref) => { seenKeys.push(['happyShare', ref]); return { ok: ref === '1' }; },
    },
    getAccountIdFromRequest: () => '1',
    canAccessAccount: () => true,
    sendProviderError: (_res, error) => { throw error; },
  };
  registerAdminSeasonActivityRoutes(context);

  async function invoke(route) {
    let value;
    const res = { status() { return res; }, json(data) { value = data; } };
    await routes.get(route)({}, res);
    return value;
  }

  const wish = await invoke('/api/activity/wish');
  assert.equal(wish.ok, true, `wish 应返回活动数据，实际 ${JSON.stringify(wish)}`);
  const happy = await invoke('/api/activity/happy-share');
  assert.equal(happy.ok, true, `happy-share 应返回活动数据，实际 ${JSON.stringify(happy)}`);
  assert.deepEqual(seenKeys, [['wish', '1'], ['happyShare', '1']],
    'loader 必须收到 cacheKey（accountId），且两条路由各自真实读取（缓存不互串）');
  // 二次请求命中各自缓存，不会把 wish 的数据回填给 happy-share
  const wishAgain = await invoke('/api/activity/wish');
  assert.equal(wishAgain.activity.ok, true);
});
