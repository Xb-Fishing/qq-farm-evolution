const { test } = require('node:test');
const assert = require('node:assert/strict');
const store = require('../src/models/store');
const { registerAdminFriendRoutes } = require('../src/controllers/admin-friend-routes');

// 在线自动捣乱（2026-09-25）：名单持久化 + 路由开合 + 配置快照透传到 Worker
test('autoBadFriendGids 存取往返并进入配置快照', () => {
  const accountId = `auto-bad-test-${Date.now()}`;
  store.setWatchlistFriendGids(accountId, []); // 建立账号配置
  assert.deepEqual(store.getAutoBadFriendGids(accountId), []);

  store.setAutoBadFriendGids(accountId, [1202689703, 'bad', 0, -1]);
  assert.deepEqual(store.getAutoBadFriendGids(accountId), [1202689703], '非法 gid 应被过滤');

  // applyConfigSnapshot 是 Worker 收 config_sync 后的合并入口，必须认识新字段
  store.applyConfigSnapshot({ autoBadFriendGids: [42] }, { persist: false, accountId });
  assert.ok(store.getAutoBadFriendGids(accountId).includes(42), 'config_sync 补丁应更新名单');
});

test('friend-auto-bad 路由可查询与切换并广播配置', async () => {
  const accountId = `auto-bad-route-${Date.now()}`;
  store.setWatchlistFriendGids(accountId, []);
  const routes = new Map();
  let broadcast = 0;
  registerAdminFriendRoutes({
    app: { get: (p, h) => routes.set(`GET ${p}`, h), post: (p, h) => routes.set(`POST ${p}`, h) },
    provider: {
      getFriends: async () => [],
      broadcastConfig: () => { broadcast += 1; },
    },
    store,
    getAccountIdFromRequest: () => accountId,
    canAccessAccount: () => true,
  });

  const res = () => {
    const state = {};
    return { state, status(c) { state.code = c; return this; }, json(d) { state.body = d; } };
  };

  const list = res();
  await routes.get('GET /api/friend-auto-bad')({}, list);
  assert.equal(list.state.body.ok, true);

  const toggled = res();
  await routes.get('POST /api/friend-auto-bad/toggle')({ body: { gid: 1202689703 } }, toggled);
  assert.equal(toggled.state.body.ok, true);
  assert.deepEqual(toggled.state.body.data.map(item => item.gid), [1202689703]);
  assert.ok(broadcast >= 1, '切换后必须 broadcastConfig 让 Worker 立即生效');
});
