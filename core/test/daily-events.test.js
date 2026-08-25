const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-farm-daily-events-'));
process.env.FARM_DATA_DIR = dataDir;

const {
  buildShareableDailyEventLog,
  getTodayEvents,
  recordEvent,
  resetForTest,
} = require('../src/services/daily-events');
const {
  getDailyEventsWithFallback,
  registerAdminBagRoutes,
} = require('../src/controllers/admin-bag-routes');

test.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

test('可分享的今日事件日志删除好友身份、网址、邮箱和运行时个人字段', () => {
  const publicUrl = ['https:/', '/example.invalid/private'].join('');
  const email = ['person', 'example.invalid'].join('@');
  const content = buildShareableDailyEventLog([
    {
      at: Date.parse('2026-08-25T02:00:00Z'),
      level: 'info',
      type: 'steal',
      message: `偷取 未登记好友昵称 3 个（测试作物） ${publicUrl}`,
    },
    {
      at: Date.parse('2026-08-25T02:01:00Z'),
      level: 'warn',
      type: 'kickout',
      message: `PrivateAccount 被踢\n联系 ${email}`,
      count: 2,
    },
  ], {
    date: '2026-08-25',
    runtimeTerms: new Set(['PrivateAccount']),
  });

  assert.match(content, /2026-08-25 10:00:00 \+08:00/);
  assert.match(content, /偷取 好友 3 个（测试作物）/);
  assert.match(content, /\[PERSONAL\] 被踢 联系 \[EMAIL\] ×2/);
  assert.doesNotMatch(content, /未登记好友昵称|PrivateAccount|example\.invalid/);
});

test('账号 Worker 离线时今日事件接口回退读取已落盘日志', async () => {
  resetForTest();
  recordEvent('offline-fixture', 'warn', 'kickout', '被踢下线：测试原因');
  const events = await getDailyEventsWithFallback({
    getDailyEvents: async () => { throw new Error('账号未运行'); },
  }, 'offline-fixture');

  assert.deepEqual(events, getTodayEvents('offline-fixture'));
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'kickout');
});

test('下载接口复用账号权限并返回禁止缓存的 UTF-8 脱敏附件', async () => {
  const getRoutes = new Map();
  registerAdminBagRoutes({
    app: {
      get: (route, handler) => getRoutes.set(route, handler),
      post: () => {},
    },
    provider: { getDailyEvents: async () => getTodayEvents('offline-fixture') },
    emitRealtimeLog: () => {},
    getAccountIdFromRequest: () => 'offline-fixture',
    canAccessAccount: () => true,
    sendProviderError: (_res, error) => { throw error; },
  });

  const headers = {};
  let body = '';
  const response = {
    setHeader: (name, value) => { headers[name] = value; },
    send: (value) => { body = value; },
  };
  await getRoutes.get('/api/daily-events/download')({}, response);

  assert.match(headers['Content-Disposition'], /^attachment; filename="farm-events-\d{4}-\d{2}-\d{2}\.txt"$/);
  assert.equal(headers['Cache-Control'], 'no-store');
  assert.ok(body.startsWith('\uFEFFQQ Farm Bot 今日事件（已脱敏）'));
  assert.doesNotMatch(body, /offline-fixture/);
});
