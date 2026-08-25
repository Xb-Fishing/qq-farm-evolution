const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  LOG_RETENTION_MS,
  buildHourlyLogFilename,
  cleanupExpiredLogFiles,
  createModuleLogger
} = require('../src/services/logger');

test('builds hourly log filenames in local time', () => {
  const date = new Date(2026, 6, 11, 15, 42, 30);
  assert.equal(buildHourlyLogFilename('combined', date), 'combined-2026-07-11-15.log');
  assert.equal(buildHourlyLogFilename('error', date), 'error-2026-07-11-15.log');
});

test('removes only managed log files older than 72 hours', () => {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-farm-logs-'));
  const now = new Date(2026, 6, 11, 15).getTime();
  const oldTime = new Date(now - LOG_RETENTION_MS - 1000);
  const recentTime = new Date(now - LOG_RETENTION_MS + 1000);
  const oldCombined = path.join(logDir, 'combined-2026-07-08-14.log');
  const recentError = path.join(logDir, 'error-2026-07-08-15.log');
  const unrelated = path.join(logDir, 'custom.log');

  try {
    fs.writeFileSync(oldCombined, 'old');
    fs.writeFileSync(recentError, 'recent');
    fs.writeFileSync(unrelated, 'keep');
    fs.utimesSync(oldCombined, oldTime, oldTime);
    fs.utimesSync(recentError, recentTime, recentTime);
    fs.utimesSync(unrelated, oldTime, oldTime);

    assert.equal(cleanupExpiredLogFiles(logDir, now), 1);
    assert.equal(fs.existsSync(oldCombined), false);
    assert.equal(fs.existsSync(recentError), true);
    assert.equal(fs.existsSync(unrelated), true);
  } finally {
    fs.rmSync(logDir, { recursive: true, force: true });
  }
});

// node --test 子进程（NODE_TEST_CONTEXT 已设）不得把夹具日志写进生产日志目录，
// 否则「肥佬/催熟党」这类测试好友会混进 combined-*.log，污染面板与安全巡检证据。
test('test runner fixture logs never reach the production log dir', async () => {
  assert.ok(process.env.NODE_TEST_CONTEXT, '应在 node --test 下运行');

  const { ensureDataDir } = require('../src/config/runtime-paths');
  const prodLogDir = path.join(ensureDataDir(), 'logs');
  const before = new Set(fs.existsSync(prodLogDir)
    ? fs.readdirSync(prodLogDir).filter(name => name.endsWith('.log'))
    : []);

  const logger = createModuleLogger('fixture-probe');
  logger.info('测试夹具日志不应落盘');
  logger.error('测试夹具错误日志不应落盘');
  await new Promise(resolve => setTimeout(resolve, 300));

  const after = new Set(fs.existsSync(prodLogDir)
    ? fs.readdirSync(prodLogDir).filter(name => name.endsWith('.log'))
    : []);
  const fresh = [...after].filter(name => !before.has(name));
  assert.deepEqual(fresh, [], `测试进程不应新建日志文件: ${fresh.join(', ')}`);
  const leaked = [...after].filter(name => name.startsWith('combined-')
    && fs.readFileSync(path.join(prodLogDir, name), 'utf8').includes('fixture-probe'));
  assert.deepEqual(leaked, [], `夹具日志泄漏进生产日志: ${leaked.join(', ')}`);
});
