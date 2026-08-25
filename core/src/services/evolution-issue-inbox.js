/**
 * 自动进化运行问题收件箱。
 *
 * 这里只保存预先定义的脱敏问题类别、时间和次数，不保存账号、好友、接口、URL、
 * 错误原文或凭据。记录最多保留 72 小时；安全巡检确认无需修改时立即清除，产生
 * 代码时则等「应用进化」重启成功后再清除。
 */
const fs = require('node:fs');
const path = require('node:path');
const { getDataFile } = require('../config/runtime-paths');

const ISSUE_FILE = getDataFile('evolution-runtime-issues.json');
const LOCK_FILE = `${ISSUE_FILE}.lock`;
const RETENTION_MS = 72 * 60 * 60 * 1000;
const STALE_LOCK_MS = 30 * 1000;
const MAX_ISSUES = 40;

const ISSUE_DEFINITIONS = Object.freeze({
  slowdown: { severity: 'warn', label: '连续请求失败触发普通巡查降速' },
  harvest_failed: { severity: 'error', label: '自己的成熟作物收获失败' },
  farming_failed: { severity: 'error', label: '自己的农场务农流程失败' },
  plant_failed: { severity: 'error', label: '自己的农场种植失败' },
  kickout: { severity: 'warn', label: '账号会话被服务端踢下线' },
  reconnect_failed: { severity: 'warn', label: '账号网络重连多次失败' },
  code_refresh_failed: { severity: 'error', label: '登录凭据无法生成新的游戏 Code' },
  credential_keepalive_failed: { severity: 'warn', label: '微信长凭据滚动保活失败' },
});

function normalizeIssue(value) {
  const key = String(value && value.key || '');
  const definition = ISSUE_DEFINITIONS[key];
  if (!definition) return null;
  const firstAt = Math.max(0, Number(value.firstAt) || 0);
  const lastAt = Math.max(firstAt, Number(value.lastAt) || firstAt);
  const count = Math.max(1, Math.floor(Number(value.count) || 1));
  return {
    key,
    severity: definition.severity,
    label: definition.label,
    firstAt,
    lastAt,
    count,
  };
}

function pruneIssues(issues, now = Date.now()) {
  const cutoff = now - RETENTION_MS;
  return (Array.isArray(issues) ? issues : [])
    .map(normalizeIssue)
    .filter(issue => issue && issue.lastAt >= cutoff)
    .sort((left, right) => left.lastAt - right.lastAt)
    .slice(-MAX_ISSUES);
}

function readIssueFile(now = Date.now()) {
  try {
    const parsed = JSON.parse(fs.readFileSync(ISSUE_FILE, 'utf8'));
    return pruneIssues(parsed && parsed.issues, now);
  } catch {
    return [];
  }
}

function writeIssueFile(issues) {
  fs.mkdirSync(path.dirname(ISSUE_FILE), { recursive: true, mode: 0o700 });
  const tempFile = `${ISSUE_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tempFile, `${JSON.stringify({ version: 1, issues }, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tempFile, ISSUE_FILE);
  fs.chmodSync(ISSUE_FILE, 0o600);
}

function acquireLock() {
  fs.mkdirSync(path.dirname(LOCK_FILE), { recursive: true, mode: 0o700 });
  try {
    return fs.openSync(LOCK_FILE, 'wx', 0o600);
  } catch (error) {
    if (error.code !== 'EEXIST') return null;
    try {
      if (Date.now() - fs.statSync(LOCK_FILE).mtimeMs <= STALE_LOCK_MS) return null;
      fs.unlinkSync(LOCK_FILE);
      return fs.openSync(LOCK_FILE, 'wx', 0o600);
    } catch {
      return null;
    }
  }
}

function withIssueLock(callback, fallback) {
  const fd = acquireLock();
  if (fd === null) return fallback;
  try {
    return callback();
  } catch {
    return fallback;
  } finally {
    try { fs.closeSync(fd); } catch {}
    try { fs.unlinkSync(LOCK_FILE); } catch {}
  }
}

/** 从今日事件中只接收已定义的问题类型；message/accountId 故意不传入。 */
function recordRuntimeIssue(type, level = 'warn', now = Date.now()) {
  const key = String(type || '');
  const definition = ISSUE_DEFINITIONS[key];
  if (!definition || (level !== 'warn' && level !== 'error')) return false;
  return withIssueLock(() => {
    const issues = readIssueFile(now);
    const existing = issues.find(issue => issue.key === key);
    if (existing) {
      existing.lastAt = now;
      existing.count += 1;
    } else {
      issues.push(normalizeIssue({ key, firstAt: now, lastAt: now, count: 1 }));
    }
    writeIssueFile(pruneIssues(issues, now));
    return true;
  }, false);
}

function getRuntimeIssueSnapshot(now = Date.now()) {
  const fallback = readIssueFile(now).map(issue => ({ ...issue }));
  return withIssueLock(() => {
    const issues = readIssueFile(now);
    // 即使后续不再产生新事件，也会在状态面板/巡检读取时把过期记录物理删除。
    writeIssueFile(issues);
    return issues.map(issue => ({ ...issue }));
  }, fallback);
}

function normalizeRuntimeIssueBatch(value) {
  return (Array.isArray(value) ? value : []).map((item) => {
    const key = String(item && item.key || '');
    if (!ISSUE_DEFINITIONS[key]) return null;
    return {
      key,
      lastAt: Math.max(0, Number(item.lastAt) || 0),
      count: Math.max(1, Math.floor(Number(item.count) || 1)),
    };
  }).filter(Boolean).slice(0, MAX_ISSUES);
}

function toRuntimeIssueBatch(issues) {
  return normalizeRuntimeIssueBatch((Array.isArray(issues) ? issues : []).map(issue => ({
    key: issue.key,
    lastAt: issue.lastAt,
    count: issue.count,
  })));
}

/**
 * 确认某轮已处理的问题。若同一问题在 Agent 启动后再次发生，只扣除旧次数并保留
 * 新发生部分，避免把尚未复盘的新故障一并清掉。
 */
function acknowledgeRuntimeIssues(value, now = Date.now()) {
  const batch = normalizeRuntimeIssueBatch(value);
  if (batch.length === 0) return { acknowledged: 0, remaining: getRuntimeIssueSnapshot(now).length };
  return withIssueLock(() => {
    const issues = readIssueFile(now);
    const acknowledgedByKey = new Map(batch.map(item => [item.key, item]));
    let acknowledged = 0;
    const remaining = [];
    for (const issue of issues) {
      const reviewed = acknowledgedByKey.get(issue.key);
      if (!reviewed) {
        remaining.push(issue);
        continue;
      }
      acknowledged += Math.min(issue.count, reviewed.count);
      if (issue.lastAt > reviewed.lastAt || issue.count > reviewed.count) {
        remaining.push({
          ...issue,
          firstAt: Math.max(issue.firstAt, reviewed.lastAt),
          count: Math.max(1, issue.count - reviewed.count),
        });
      }
    }
    writeIssueFile(remaining);
    return { acknowledged, remaining: remaining.length };
  }, { acknowledged: 0, remaining: readIssueFile(now).length });
}

module.exports = {
  ISSUE_DEFINITIONS,
  RETENTION_MS,
  MAX_ISSUES,
  acknowledgeRuntimeIssues,
  getRuntimeIssueSnapshot,
  normalizeRuntimeIssueBatch,
  recordRuntimeIssue,
  toRuntimeIssueBatch,
};
