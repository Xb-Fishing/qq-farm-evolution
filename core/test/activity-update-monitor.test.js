const assert = require('node:assert/strict');
const test = require('node:test');
const {
  analyzeReport,
  isActivityReportFresh,
  MANUAL_SCAN_UPSTREAM_CACHE_MS,
} = require('../src/services/activity-update-monitor');

test('本机扫描结果只作为辅助证据，不直接生成在线候选活动', () => {
  const result = analyzeReport({
    source: { version: 'new' },
    unknownActivityIds: [2026081802, 2026081800, 2026081900],
  }, { source: { version: 'old' } });
  assert.equal(result.sourceChanged, true);
  assert.deepEqual(result.unknownActivityIds, []);
  assert.deepEqual(result.localEvidence.unknownActivityIds, [2026081802, 2026081800, 2026081900]);
  assert.deepEqual(result.analysis.candidateGroups, []);
  assert.equal(result.analysis.requiresProtocolSample, false);
  assert.equal(result.analysis.safeToAutoApply, false);
});

test('活动更新分析合并在线 List 和本地源码候选', () => {
  const result = analyzeReport({
    source: { version: 'same' },
    unknownActivityIds: [],
  }, null, {
    available: true,
    unknownActivityIds: [2026081800],
    activities: [{ id: 2026081800, title: '未来活动' }],
    groups: [{ id: 2026081800, title: '未来活动', children: [] }],
  });
  assert.equal(result.status, 'update-found');
  assert.deepEqual(result.unknownActivityIds, [2026081800]);
  assert.equal(result.online.available, true);
});

test('扫描间隔带 ±20% 抖动，打破整点规律', () => {
  const { DEFAULT_INTERVAL_MS, nextScanDelayMs } = require('../src/services/activity-update-monitor');
  const spread = Math.floor(DEFAULT_INTERVAL_MS * 0.2);
  const samples = new Set();
  for (let i = 0; i < 50; i++) {
    const delay = nextScanDelayMs(DEFAULT_INTERVAL_MS);
    assert.ok(delay >= DEFAULT_INTERVAL_MS - spread);
    assert.ok(delay <= DEFAULT_INTERVAL_MS + spread);
    samples.add(delay);
  }
  assert.ok(samples.size > 1, '多次采样应产生不同间隔');
});

test('首扫等待账号启动，离线补扫保持低频且带抖动', () => {
  const {
    nextInitialScanDelayMs,
    nextUnavailableRetryDelayMs,
  } = require('../src/services/activity-update-monitor');
  assert.equal(nextInitialScanDelayMs(() => 0), 15_000);
  assert.equal(nextInitialScanDelayMs(() => 0.999999), 25_000);
  assert.equal(nextUnavailableRetryDelayMs(() => 0), 60_000);
  assert.equal(nextUnavailableRetryDelayMs(() => 0.999999), 90_000);
});

test('管理面板频繁刷新在两分钟内复用活动扫描结果', () => {
  const scannedAt = 10_000;
  assert.equal(MANUAL_SCAN_UPSTREAM_CACHE_MS, 120_000);
  assert.equal(isActivityReportFresh({ scannedAt }, MANUAL_SCAN_UPSTREAM_CACHE_MS, scannedAt + 119_999), true);
  assert.equal(isActivityReportFresh({ scannedAt }, MANUAL_SCAN_UPSTREAM_CACHE_MS, scannedAt + 120_000), false);
  assert.equal(isActivityReportFresh(null, MANUAL_SCAN_UPSTREAM_CACHE_MS, scannedAt), false);
  assert.equal(isActivityReportFresh({ scannedAt, status: 'unavailable' }, MANUAL_SCAN_UPSTREAM_CACHE_MS, scannedAt + 1), false);
  assert.equal(isActivityReportFresh({ scannedAt, online: { available: false } }, MANUAL_SCAN_UPSTREAM_CACHE_MS, scannedAt + 1), false);
});
