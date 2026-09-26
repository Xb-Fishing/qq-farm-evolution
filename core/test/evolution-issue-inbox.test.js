const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-farm-evolution-issues-'));
process.env.FARM_DATA_DIR = dataDir;

const {
  RETENTION_MS,
  acknowledgeRuntimeIssues,
  getRuntimeIssueSnapshot,
  recordRuntimeIssue,
  toRuntimeIssueBatch,
} = require('../src/services/evolution-issue-inbox');

test.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

test('运行问题收件箱只接受脱敏白名单并按类别合并', () => {
  const now = Date.parse('2026-08-25T12:00:00Z');
  assert.equal(recordRuntimeIssue('unknown_raw_error', 'error', now), false);
  assert.equal(recordRuntimeIssue('harvest_failed', 'info', now), false);
  assert.equal(recordRuntimeIssue('harvest_failed', 'error', now), true);
  assert.equal(recordRuntimeIssue('harvest_failed', 'error', now + 1000), true);

  const issues = getRuntimeIssueSnapshot(now + 1000);
  assert.equal(issues.length, 1);
  assert.deepEqual(issues[0], {
    key: 'harvest_failed',
    severity: 'error',
    label: '自己的成熟作物收获失败',
    firstAt: now,
    lastAt: now + 1000,
    count: 2,
  });

  const persisted = fs.readFileSync(path.join(dataDir, 'evolution-runtime-issues.json'), 'utf8');
  assert.doesNotMatch(persisted, /account|friend|gid|https?:|token|unknown_raw_error/i);
});

test('确认一批问题时保留 Agent 启动后再次发生的部分', () => {
  const snapshot = getRuntimeIssueSnapshot(Date.parse('2026-08-25T12:00:02Z'));
  const batch = toRuntimeIssueBatch(snapshot);
  recordRuntimeIssue('harvest_failed', 'error', Date.parse('2026-08-25T12:00:03Z'));

  const result = acknowledgeRuntimeIssues(batch, Date.parse('2026-08-25T12:00:04Z'));
  assert.equal(result.acknowledged, 2);
  const remaining = getRuntimeIssueSnapshot(Date.parse('2026-08-25T12:00:04Z'));
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].count, 1);
  assert.equal(remaining[0].lastAt, Date.parse('2026-08-25T12:00:03Z'));

  acknowledgeRuntimeIssues(toRuntimeIssueBatch(remaining), Date.parse('2026-08-25T12:00:04Z'));
  assert.deepEqual(getRuntimeIssueSnapshot(Date.parse('2026-08-25T12:00:04Z')), []);
});

test('未处理问题超过 72 小时也会自动物理清理', () => {
  const now = Date.parse('2026-08-25T12:00:00Z');
  recordRuntimeIssue('slowdown', 'warn', now);
  assert.equal(getRuntimeIssueSnapshot(now).length, 1);
  assert.deepEqual(getRuntimeIssueSnapshot(now + RETENTION_MS + 1), []);

  const persisted = JSON.parse(fs.readFileSync(
    path.join(dataDir, 'evolution-runtime-issues.json'), 'utf8'));
  assert.deepEqual(persisted.issues, []);
});

test('bag_unclassified 待办：新未知 ID 上报、确认后新发生不被误清', () => {
  const t0 = Date.parse('2026-09-26T03:19:00Z');
  assert.equal(recordRuntimeIssue('bag_unclassified', 'warn', t0), true);
  let issues = getRuntimeIssueSnapshot(t0);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].key, 'bag_unclassified');
  assert.equal(issues[0].severity, 'warn');

  // Agent 复盘确认这批未知 ID 后，又出现新的未识别 ID（lastAt 更晚）
  const batch = toRuntimeIssueBatch(issues);
  recordRuntimeIssue('bag_unclassified', 'warn', t0 + 3600_000);
  const result = acknowledgeRuntimeIssues(batch, t0 + 3600_000);
  assert.equal(result.acknowledged, 1);
  issues = getRuntimeIssueSnapshot(t0 + 3600_000);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].key, 'bag_unclassified');
  assert.equal(issues[0].lastAt, t0 + 3600_000, 'ack of the old batch must not clear the newer occurrence');
});
