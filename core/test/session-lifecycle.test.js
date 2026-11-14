const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const {
  nextCredentialKeepaliveDelayMs,
  WX_KEEPALIVE_AHEAD_MIN_MS,
  WX_KEEPALIVE_AHEAD_MAX_MS,
  WX_KEEPALIVE_MIGRATION_MIN_MS,
  WX_KEEPALIVE_MIGRATION_MAX_MS,
  WX_KEEPALIVE_RETRY_BASE_MS,
  WX_KEEPALIVE_RETRY_MAX_MS,
  WX_KEEPALIVE_TERMINAL_RECHECK_MS,
} = require('../src/runtime/auto-code-refresh');
const {
  selectActivitySnapshotRoots,
  selectKnownActivityReviewRoots,
  selectUnknownOnlineActivities,
} = require('../src/controllers/admin-activity-update-routes');
const {
  normalizeDiscoveryActivity,
  summarizeActivityProtocolShape,
} = require('../src/services/activity');

test('在线活动发现不把 ID 大小误当开放顺序', () => {
  const activities = [
    { id: 2026081800, title: '已登记活动' },
    { id: 2026070300, title: '稍后开放但 ID 较小的活动' },
    { id: 2026070301, title: '较小 ID 活动子节点' },
    { id: 2026070301, title: '重复节点' },
  ];
  assert.deepEqual(
    selectUnknownOnlineActivities(activities, [2026081800]),
    [activities[1], activities[2]],
  );
});

test('活动检查低频复核当前已登记根活动，不逐个请求子节点', () => {
  const now = 2_000;
  const activities = [
    { id: 101, parentId: 0, startTime: 1_000, endTime: 3_000, visible: true, enabled: false },
    { id: 102, parentId: 101, startTime: 1_000, endTime: 3_000, visible: true, enabled: true },
    { id: 201, parentId: 0, startTime: 1_000, endTime: 1_500, visible: true },
    { id: 301, parentId: 0, startTime: 2_500, endTime: 3_500, visible: true },
    { id: 401, parentId: 0, startTime: 1_000, endTime: 3_000, visible: true },
  ];
  assert.deepEqual(
    selectKnownActivityReviewRoots(activities, [101, 102, 201, 301], now).map(item => item.id),
    [101],
  );
});

test('新活动详情只读取 List 已下发的根节点，不逐个试探子节点', () => {
  const root = { id: 101, parentId: 0, title: '活动根' };
  const childA = { id: 102, parentId: 101, title: '子玩法 A' };
  const childB = { id: 103, parentId: 101, title: '子玩法 B' };
  assert.deepEqual(
    selectActivitySnapshotRoots([childB, childA, root], [childA, childB]).map(item => item.id),
    [101],
  );

  const source = fs.readFileSync(path.join(__dirname, '../src/controllers/admin-activity-update-routes.js'), 'utf8');
  assert.doesNotMatch(source, /buildDateProbeIds|selectRotatingProbeIds|GetGroup probe/);
  assert.match(source, /禁止枚举未由 ActivityService\.List 下发的活动 ID/);
});

test('活动发现快照保留道具玩法详情且协议形状不包含字段值', () => {
  const snapshot = normalizeDiscoveryActivity({
    activity: {
      id: 2026070301,
      parent_id: 2026070300,
      title: '测试活动',
      type: 3,
    },
    exchange_shop: {
      items: [{
        id: 7,
        item: { id: 1023, count: 2 },
        cost: { id: 1018, count: 5 },
        status: 1,
        name: '测试道具',
      }],
    },
  });
  assert.equal(snapshot.details.exchangeShop.items.length, 1);
  assert.equal(snapshot.details.exchangeShop.items[0].itemId, 1023);
  assert.equal(snapshot.details.exchangeShop.items[0].currencyId, 1018);
  assert.equal(snapshot.details.exchangeShop.items[0].price, 5);

  const shape = summarizeActivityProtocolShape(Buffer.from([0x08, 0x63, 0x12, 0x02, 0x08, 0x2A]));
  assert.deepEqual(shape.map(item => `${item.path}:${item.wire}`), ['1:0', '2:2', '2.1:0']);
  assert.equal(JSON.stringify(shape).includes('value'), false);
  assert.deepEqual(shape[1].byteLengths, [2]);
});

test('微信凭据按服务端有效期续期，不再每半小时真实刷新', () => {
  const now = Date.parse('2026-08-26T02:00:00Z');
  const account = { wxCredentialExpiresAt: now + 2 * 60 * 60000 };
  assert.equal(
    nextCredentialKeepaliveDelayMs(account, { now, random: () => 0 }),
    2 * 60 * 60000 - WX_KEEPALIVE_AHEAD_MIN_MS,
  );
  assert.equal(
    nextCredentialKeepaliveDelayMs(account, { now, random: () => 0.999999 }),
    2 * 60 * 60000 - WX_KEEPALIVE_AHEAD_MAX_MS,
  );

  const migration = nextCredentialKeepaliveDelayMs({}, { now, random: () => 0.5 });
  assert.ok(migration >= WX_KEEPALIVE_MIGRATION_MIN_MS);
  assert.ok(migration <= WX_KEEPALIVE_MIGRATION_MAX_MS);

  assert.equal(
    nextCredentialKeepaliveDelayMs(account, { reason: 'retry', failureCount: 1, random: () => 0 }),
    WX_KEEPALIVE_RETRY_BASE_MS,
  );
  assert.equal(
    nextCredentialKeepaliveDelayMs(account, { reason: 'retry', failureCount: 9, random: () => 0 }),
    WX_KEEPALIVE_RETRY_MAX_MS,
  );
  assert.equal(
    nextCredentialKeepaliveDelayMs(account, { reason: 'definitive', random: () => 0 }),
    WX_KEEPALIVE_TERMINAL_RECHECK_MS,
  );
});

test('在线账号不再按固定周期换 Code 或重启 Worker', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/runtime/auto-code-refresh.js'), 'utf8');
  const requestBlock = source.slice(
    source.indexOf('async function requestFarmCode'),
    source.indexOf('async function refreshAccountCode'),
  );
  const refreshBlock = source.slice(
    source.indexOf('async function refreshAccountCode'),
    source.indexOf('function armCredentialKeepalive'),
  );
  const scheduleBlock = source.slice(
    source.indexOf('function scheduleAccount'),
    source.indexOf('function rescheduleAll'),
  );
  const keepaliveBlock = source.slice(
    source.indexOf('function armCredentialKeepalive'),
    source.indexOf('function armOfflineCredentialKeepalive'),
  );

  assert.doesNotMatch(requestBlock, /keepWxCredentialAlive/);
  assert.match(refreshBlock, /addOrUpdateAccount\(\{ id: account\.id, code \}\)/);
  assert.doesNotMatch(refreshBlock, /nextAccount\s*=\s*\{\s*\.\.\.account,\s*code\s*\}/);
  assert.doesNotMatch(scheduleBlock, /refreshAccountCode\s*\(\s*accountId\s*,\s*['"]timer['"]/);
  assert.match(scheduleBlock, /armCredentialKeepalive/);
  assert.match(keepaliveBlock, /setTimeoutTask/);
  assert.match(keepaliveBlock, /不换游戏 Code/);
});

test('Worker 每次启动后都会重新挂载凭据保活', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/runtime/worker-manager.js'), 'utf8');
  // 语义不绑定局部变量名：startWorker 末尾守卫式重挂保活，参数为 canonical
  // 账号对象的 id（真实消费新 expiry 的行为由 wx-online-rescan 链路用例覆盖）
  assert.match(source, /if \(typeof scheduleAccountRefresh === 'function'\) scheduleAccountRefresh\(\w+\.id\);/);
});

test('Code 刷新和长凭据保活失败会留下脱敏进化线索', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/runtime/auto-code-refresh.js'), 'utf8');
  assert.match(source, /recordEvolutionIssue\('code_refresh_failed', 'error'\)/);
  assert.match(source, /recordEvolutionIssue\('credential_keepalive_failed', 'warn'\)/);
  assert.doesNotMatch(source, /recordRuntimeIssue\([^\n]*err\.message/);
});

test('应用进化只复用既有 farm tmux pane', () => {
  const shim = fs.readFileSync(path.join(__dirname, '../../scripts/apply-evolution.sh'), 'utf8');
  const helper = fs.readFileSync(path.join(__dirname, '../scripts/evolution-apply-process.js'), 'utf8');
  // 薄壳只传参；pane 定位、送键与重启全部在受审 helper 内完成。
  assert.match(shim, /FARM_TMUX_TARGET:\?missing tmux target/);
  assert.match(helper, /'display-message', '-p', '-t', target, '#\{pane_pid\}'/);
  // 字节编码和清行/回车由真实重启行为测试覆盖，静态门只约束目标 pane。
  assert.match(helper, /'send-keys', '-t', tmuxTarget,/);
  // 只在原 pane 内启动重启分支：不新建会话/窗口，不向 pane 发中断键。
  assert.doesNotMatch(helper, /new-session|new-window/);
  assert.doesNotMatch(helper, /'C-c'/);
  assert.doesNotMatch(shim, /tmux new(?:-session)?/);
  assert.doesNotMatch(shim, /nohup bash start\.sh/);
});

test('自动进化子进程的 Git hook 明确拒绝直接推送', () => {
  const hook = path.join(__dirname, '../../scripts/evolution-hooks/pre-push');
  const source = fs.readFileSync(hook, 'utf8');
  assert.ok((fs.statSync(hook).mode & 0o111) !== 0);
  assert.match(source, /parent privacy gate owns GitHub uploads/);
  assert.match(source, /exit 1/);
});
