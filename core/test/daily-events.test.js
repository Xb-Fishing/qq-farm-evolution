const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-farm-daily-events-'));
process.env.FARM_DATA_DIR = dataDir;

const {
  buildShareableDailyEventLog,
  buildStealDailyEventLog,
  getTodayEvents,
  recordEvent,
  resetForTest,
} = require('../src/services/daily-events');
const {
  getDailyEventsWithFallback,
  registerAdminBagRoutes,
} = require('../src/controllers/admin-bag-routes');
const {
  acknowledgeRuntimeIssues,
  getRuntimeIssueSnapshot,
  toRuntimeIssueBatch,
} = require('../src/services/evolution-issue-inbox');

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

test('日常错误事件只向自动进化收件箱投递脱敏类别', () => {
  const existing = getRuntimeIssueSnapshot();
  acknowledgeRuntimeIssues(toRuntimeIssueBatch(existing));
  const privateUrl = ['https:/', '/private.invalid/path'].join('');
  recordEvent('private-account', 'error', 'plant_failed', `私人好友种植失败 ${privateUrl}`);

  const issues = getRuntimeIssueSnapshot();
  assert.equal(issues.length, 1);
  assert.equal(issues[0].key, 'plant_failed');
  const persisted = fs.readFileSync(path.join(dataDir, 'evolution-runtime-issues.json'), 'utf8');
  assert.doesNotMatch(persisted, /private-account|私人好友|private\.invalid/);
});

test('偷菜专用日志只导出偷菜和被偷并保留好友昵称', () => {
  const secretUrl = ['https:/', '/example.invalid/avatar'].join('');
  const content = buildStealDailyEventLog([
    {
      at: Date.parse('2026-08-25T02:00:00Z'),
      level: 'info',
      type: 'steal',
      message: '偷取 测试好友甲 3 个（测试作物）',
    },
    {
      at: Date.parse('2026-08-25T02:01:00Z'),
      level: 'info',
      type: 'harvest',
      message: '收获 12 个作物',
    },
  ], [
    {
      serverTimeMs: Date.parse('2026-08-25T02:02:00Z'),
      actionType: 1,
      nick: '测试好友乙',
      visitorGid: 123456,
      avatarUrl: secretUrl,
      actionDetail: '偷取 测试作物 × 2 · 地块 4',
    },
    {
      serverTimeMs: Date.parse('2026-08-25T02:03:00Z'),
      actionType: 2,
      nick: '帮忙好友',
      actionDetail: '帮忙 1 次',
    },
  ], { date: '2026-08-25', incomingAvailable: true });

  assert.match(content, /\[偷菜\] 偷取 测试好友甲 3 个（测试作物）/);
  assert.match(content, /\[被偷\] 测试好友乙 · 偷取 测试作物 × 2 · 地块 4/);
  assert.doesNotMatch(content, /收获 12 个|帮忙好友|123456|example\.invalid/);
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

test('偷菜专用下载读取一次互动记录并返回保留好友昵称的附件', async () => {
  const getRoutes = new Map();
  let interactCalls = 0;
  registerAdminBagRoutes({
    app: {
      get: (route, handler) => getRoutes.set(route, handler),
      post: () => {},
    },
    provider: {
      getDailyEvents: async () => [{
        at: Date.now(),
        level: 'info',
        type: 'steal',
        message: '偷取 测试好友甲 1 个（测试作物）',
      }],
      getInteractRecords: async () => {
        interactCalls += 1;
        return [{
          serverTimeMs: Date.now(),
          actionType: 1,
          nick: '测试好友乙',
          actionDetail: '偷取 测试作物 × 1',
        }];
      },
    },
    emitRealtimeLog: () => {},
    getAccountIdFromRequest: () => 'test-account',
    canAccessAccount: () => true,
    sendProviderError: (_res, error) => { throw error; },
  });

  const headers = {};
  let body = '';
  const response = {
    setHeader: (name, value) => { headers[name] = value; },
    send: (value) => { body = value; },
  };
  await getRoutes.get('/api/daily-events/steal-download')({}, response);

  assert.equal(interactCalls, 1);
  assert.match(headers['Content-Disposition'], /^attachment; filename="farm-steal-events-\d{4}-\d{2}-\d{2}\.txt"$/);
  assert.equal(headers['Cache-Control'], 'no-store');
  assert.ok(body.startsWith('\uFEFFQQ Farm Bot 偷菜/被偷事件日志'));
  assert.match(body, /测试好友甲/);
  assert.match(body, /测试好友乙/);
  assert.doesNotMatch(body, /test-account/);
});

test('账号离线时偷菜专用下载仍返回落盘记录并标注被偷数据未读取', async () => {
  resetForTest();
  recordEvent('offline-steal-fixture', 'info', 'steal', '偷取 离线测试好友 2 个（测试作物）');
  const getRoutes = new Map();
  registerAdminBagRoutes({
    app: {
      get: (route, handler) => getRoutes.set(route, handler),
      post: () => {},
    },
    provider: {
      getDailyEvents: async () => { throw new Error('账号未运行'); },
      getInteractRecords: async () => { throw new Error('账号未运行'); },
    },
    emitRealtimeLog: () => {},
    getAccountIdFromRequest: () => 'offline-steal-fixture',
    canAccessAccount: () => true,
    sendProviderError: (_res, error) => { throw error; },
  });

  let body = '';
  const response = {
    setHeader: () => {},
    send: (value) => { body = value; },
  };
  await getRoutes.get('/api/daily-events/steal-download')({}, response);

  assert.match(body, /离线测试好友/);
  assert.match(body, /账号离线或接口暂不可用/);
  assert.doesNotMatch(body, /offline-steal-fixture|账号未运行/);
});
