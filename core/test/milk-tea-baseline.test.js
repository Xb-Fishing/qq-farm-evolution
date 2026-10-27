'use strict';
// 只调用旧源已有的公开注册入口；旧源的三个真实路由仍可达，各计一个行为失败。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const tmp = fs.realpathSync(os.tmpdir()), prefix = path.resolve(tmp, 'farm-milk-tea-baseline-');
assert.ok(prefix.startsWith(tmp + path.sep));
const dir = fs.mkdtempSync(prefix); process.env.FARM_DATA_DIR = dir;
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
const updatePath = require.resolve('../src/controllers/admin-activity-update-routes');
const priorUpdate = require.cache[updatePath];
require.cache[updatePath] = { id: updatePath, filename: updatePath, loaded: true, exports: { registerAdminActivityUpdateRoutes: () => {} } };
test.after(() => { if (priorUpdate) require.cache[updatePath] = priorUpdate; else delete require.cache[updatePath]; });
const { registerAdminActivityRoutes } = require('../src/controllers/admin-activity-routes');
for (const old of ['bear', 'wish', 'happy-share']) {
  test(`旧活动 ${old} 管理读取已退役：真实注册表中不可调用且零上游`, async () => {
    const routes = new Map(); let upstream = 0;
    const app = Object.fromEntries(['get', 'post', 'put', 'delete'].map(method => [method, (url, ...handlers) => routes.set(`${method} ${url}`, handlers.at(-1))]));
    const provider = new Proxy({}, { get: () => async () => { upstream++; return {}; } });
    registerAdminActivityRoutes({ app, provider, store: {}, getAccountIdFromRequest: () => 'synthetic-account', canAccessAccount: () => true, sendProviderError: () => {}, requireAdminToken: (_req, _res, next) => next() });
    assert.equal(routes.has(`get /api/activity/${old}`), false, '已退役活动不得继续注册管理请求入口');
    assert.equal(upstream, 0);
    assert.ok(routes.has('get /api/activity/official-announcements'), '共享公告能力保留');
  });
}
