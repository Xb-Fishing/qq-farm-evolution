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

// ===== 测试污染边界（2026-09-28）=====
// 真实 getBagSeedsFromItems 合成未知物品路径：测试进程指向默认生产数据目录
// （含显式 FARM_DATA_DIR 指向默认目录）时收件箱不持久化；独立临时目录的
// 生产模式（无 NODE_TEST_CONTEXT）正常登记一次，同签名重复调用不刷次数。
const INBOX_PATH = require.resolve('../src/services/evolution-issue-inbox');
const DEFAULT_DATA_DIR = path.join(__dirname, '..', 'data');
const DEFAULT_ISSUE_FILE = path.join(DEFAULT_DATA_DIR, 'evolution-runtime-issues.json');

function readDefaultIssueFile() {
  try { return fs.readFileSync(DEFAULT_ISSUE_FILE, 'utf8'); } catch { return null; }
}

/** 换入按指定环境解析 ISSUE_FILE 的全新收件箱实例；warehouse 的懒 require 在调用时命中它。 */
function withFreshInbox(envOverrides, run) {
  const savedDir = process.env.FARM_DATA_DIR;
  const savedTestContext = process.env.NODE_TEST_CONTEXT;
  const savedEntry = require.cache[INBOX_PATH];
  delete require.cache[INBOX_PATH];
  for (const [key, value] of Object.entries(envOverrides)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return run(require(INBOX_PATH));
  } finally {
    delete require.cache[INBOX_PATH];
    if (savedEntry) require.cache[INBOX_PATH] = savedEntry;
    if (savedDir === undefined) delete process.env.FARM_DATA_DIR;
    else process.env.FARM_DATA_DIR = savedDir;
    if (savedTestContext === undefined) delete process.env.NODE_TEST_CONTEXT;
    else process.env.NODE_TEST_CONTEXT = savedTestContext;
  }
}

test('测试进程指向默认生产数据目录时不持久化（含显式 FARM_DATA_DIR 指向默认目录）', () => {
  const warehouse = require('../src/services/warehouse'); // 真实识别路径
  const before = readDefaultIssueFile();

  // 场景 1：未设 FARM_DATA_DIR（收件箱按默认生产目录解析）
  withFreshInbox({ NODE_TEST_CONTEXT: 'test', FARM_DATA_DIR: undefined }, (inbox) => {
    warehouse.getBagSeedsFromItems([{ id: 4299131, count: 1 }]);
    assert.equal(inbox.recordRuntimeIssue('bag_unclassified', 'warn'), false,
      '测试上下文 + 默认目录：直接调用也不持久化');
    assert.equal(readDefaultIssueFile(), before, '生产收件箱文件未被写入');
  });

  // 场景 2：显式把 FARM_DATA_DIR 指向默认目录——按最终路径判断，同样不写
  withFreshInbox({ NODE_TEST_CONTEXT: 'test', FARM_DATA_DIR: DEFAULT_DATA_DIR }, (inbox) => {
    warehouse.getBagSeedsFromItems([{ id: 4299132, count: 1 }]);
    assert.equal(inbox.recordRuntimeIssue('bag_unclassified', 'warn'), false,
      '显式指向默认目录同样不持久化');
    assert.equal(readDefaultIssueFile(), before, '生产收件箱文件仍未被写入');
  });
});

test('独立目录的生产模式经真实未知物品路径登记一次，同签名重复不刷次数', () => {
  const prodDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-farm-inbox-prod-'));
  try {
    const warehouse = require('../src/services/warehouse');
    withFreshInbox({ NODE_TEST_CONTEXT: undefined, FARM_DATA_DIR: prodDir }, (inbox) => {
      warehouse.getBagSeedsFromItems([{ id: 4299133, count: 1 }]);
      let issues = inbox.getRuntimeIssueSnapshot();
      assert.equal(issues.length, 1, '生产模式在独立目录正常登记');
      assert.equal(issues[0].key, 'bag_unclassified');
      assert.equal(issues[0].count, 1, '首次出现登记一次');

      warehouse.getBagSeedsFromItems([{ id: 4299133, count: 1 }]);
      issues = inbox.getRuntimeIssueSnapshot();
      assert.equal(issues[0].count, 1, '同签名重复调用不刷次数');

      warehouse.getBagSeedsFromItems([{ id: 4299133, count: 1 }, { id: 4299134, count: 1 }]);
      issues = inbox.getRuntimeIssueSnapshot();
      assert.equal(issues[0].count, 2, '新增未知 ID 才再登记');
    });
  } finally {
    fs.rmSync(prodDir, { recursive: true, force: true });
  }
});
