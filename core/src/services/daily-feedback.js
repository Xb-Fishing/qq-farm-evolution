/** Private daily feedback: allowlisted facts only, never request bodies or error text. */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');
const { execFileSync } = require('node:child_process');
const { getDataDir } = require('../config/runtime-paths');

const feedbackContext = new AsyncLocalStorage();
const RETENTION_MS = 72 * 60 * 60 * 1000;
const MAX_DAY_BYTES = 12 * 1024 * 1024;
const PAGES = new Set(['dashboard', 'farm', 'friends', 'bag', 'shop', 'task', 'warehouse', 'activity', 'settings', 'accounts', 'admin', 'other']);
const OUTCOMES = new Set(['started', 'succeeded', 'accepted', 'failed', 'partial', 'rejected', 'aborted', 'observed']);
const CATEGORIES = new Set(['vue_error', 'unhandled_rejection', 'script_error', 'network_error', 'request_timeout', 'runtime_warn', 'runtime_error']);
const TARGETS = new Set(['button', 'link', 'input', 'select', 'tab', 'control']);
const OPERATIONS = new Set(['initialize', 'feed', 'draw', 'claimDog', 'seeds', 'compensation', 'story', 'exchange',
  'harvest', 'water', 'weed', 'insect', 'fertilize', 'remove', 'plant', 'steal', 'help', 'all']);
const DOMAINS = new Set(['farm', 'friends', 'activity', 'auth', 'network', 'worker', 'admin', 'system']);
const REASONS = new Set(['timeout', 'not_ready', 'permission', 'invalid_input', 'insufficient_resources', 'network', 'unknown']);
const TRACE_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const ACTION_RE = /^(?:GET|POST|PUT|PATCH|DELETE) \/api\/[a-zA-Z/:_-]{1,120}$/;
const DAY_FILE_RE = /^\d{4}-\d{2}-\d{2}\.jsonl$/;
const bounded = (value, max) => Number.isFinite(value) ? Math.max(0, Math.min(max, Math.floor(value))) : 0;
const dateKey = now => new Date(now).toISOString().slice(0, 10);

function normalizeFeedback(value, now, revision = '') {
  if (!value || !['click', 'request', 'client_error', 'runtime'].includes(value.kind)) return null;
  const item = { at: now, kind: value.kind };
  if (typeof revision === 'string' && /^[a-f0-9]{40}$/.test(revision)) item.revision = revision;
  if (typeof value.trace === 'string' && TRACE_RE.test(value.trace)) item.trace = value.trace;
  if (value.kind === 'click') {
    if (!PAGES.has(value.page) || !TARGETS.has(value.target)) return null;
    item.page = value.page;
    item.target = value.target;
    item.outcome = 'observed';
  } else if (value.kind === 'request') {
    if (typeof value.action !== 'string' || !ACTION_RE.test(value.action) || !OUTCOMES.has(value.outcome)) return null;
    item.action = value.action;
    if (OPERATIONS.has(value.operation)) item.operation = value.operation;
    item.outcome = value.outcome;
    if (REASONS.has(value.reason)) item.reason = value.reason;
    item.durationMs = bounded(value.durationMs, 3600000);
    item.httpStatus = bounded(value.httpStatus, 599);
    for (const key of ['successCount', 'failedCount', 'changedCount', 'itemCount']) {
      if (Number.isFinite(value[key])) item[key] = bounded(value[key], 1000000);
    }
  } else {
    if (!CATEGORIES.has(value.category)) return null;
    item.category = value.category;
    item.domain = DOMAINS.has(value.domain) ? value.domain : 'system';
    if (PAGES.has(value.page)) item.page = value.page;
    item.outcome = 'failed';
  }
  return item;
}

function createDailyFeedbackStore({ dataDir, now = Date.now, revision = '', maxDayBytes = MAX_DAY_BYTES } = {}) {
  const folder = path.join(dataDir, 'daily-feedback');
  let queue = [];
  let timer = null;
  let cleanupAt = 0;
  let dropped = 0;
  let snapshotCache = null;
  function cleanup() {
    const time = now();
    if (cleanupAt && time - cleanupAt < 3600000) return;
    cleanupAt = time;
    fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      if (entry.isFile() && DAY_FILE_RE.test(entry.name)
          && Date.parse(entry.name.slice(0, 10)) < time - RETENTION_MS) {
        fs.unlinkSync(path.join(folder, entry.name));
      }
    }
  }
  function flush() {
    if (timer) clearTimeout(timer);
    timer = null;
    try {
      cleanup();
      const groups = new Map();
      for (const item of queue) {
        const key = dateKey(item.at);
        groups.set(key, `${groups.get(key) || ''}${JSON.stringify(item)}\n`);
      }
      for (const [day, text] of groups) {
        const file = path.join(folder, `${day}.jsonl`);
        const size = fs.existsSync(file) ? fs.statSync(file).size : 0;
        const lines = text.split('\n').filter(Boolean);
        let length = size;
        let allowed = '';
        for (const line of lines) {
          const bytes = Buffer.byteLength(line) + 1;
          if (length + bytes > maxDayBytes) { dropped += 1; continue; }
          length += bytes;
          allowed += `${line}\n`;
        }
        if (allowed) fs.appendFileSync(file, allowed, { mode: 0o600 });
      }
      queue = [];
    } catch {
      // Telemetry cannot interrupt gameplay. The summary makes collection loss visible.
      dropped += queue.length;
      queue = [];
    }
  }
  function record(value) {
    const item = normalizeFeedback(value, now(), revision);
    if (!item) return false;
    if (queue.length >= 2000) { dropped += 1; return false; }
    queue.push(item);
    if (!timer) { timer = setTimeout(flush, 500); timer.unref?.(); }
    return true;
  }
  function snapshot({ force = false } = {}) {
    const time = now();
    if (!force && snapshotCache && time - snapshotCache.generatedAt < 10000) return snapshotCache;
    flush();
    const groups = new Map();
    const counts = { clicks: 0, requests: 0, failures: 0, accepted: 0, runtimeErrors: 0, clientErrors: 0 };
    let unreadableFiles = 0;
    try {
      for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
        if (!entry.isFile() || !DAY_FILE_RE.test(entry.name)) continue;
        const start = Date.parse(entry.name.slice(0, 10));
        if (start + 86400000 < time - 86400000 || start > time) continue;
        const file = path.join(folder, entry.name);
        if (fs.statSync(file).size > maxDayBytes) { unreadableFiles += 1; continue; }
        for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
          if (!line) continue;
          let raw;
          try { raw = JSON.parse(line); } catch { unreadableFiles += 1; continue; }
          if (!Number.isFinite(raw.at) || raw.at < time - 86400000 || raw.at > time) continue;
          const item = normalizeFeedback(raw, raw.at, raw.revision);
          if (!item) continue;
          if (item.kind === 'click') counts.clicks += 1;
          if (item.kind === 'request') counts.requests += 1;
          if (item.kind === 'runtime') counts.runtimeErrors += 1;
          if (item.kind === 'client_error') counts.clientErrors += 1;
          if (item.outcome === 'accepted') counts.accepted += 1;
          if (['failed', 'rejected', 'partial', 'aborted'].includes(item.outcome)) counts.failures += 1;
          const key = item.action ? `${item.action}${item.operation ? `:${item.operation}` : ''}${item.reason ? `:${item.reason}` : ''}` : item.category || `click:${item.page}:${item.target}`;
          const row = groups.get(key) || { key, count: 0, failures: 0, lastAt: 0, maxDurationMs: 0 };
          row.count += 1;
          if (['failed', 'rejected', 'partial', 'aborted'].includes(item.outcome)) row.failures += 1;
          row.lastAt = Math.max(row.lastAt, item.at);
          row.maxDurationMs = Math.max(row.maxDurationMs, item.durationMs || 0);
          groups.set(key, row);
        }
      }
    } catch { unreadableFiles += 1; }
    snapshotCache = { day: dateKey(time), generatedAt: time, windowHours: 24, counts, dropped, unreadableFiles,
      groups: [...groups.values()].sort((a, b) => b.failures - a.failures || b.lastAt - a.lastAt).slice(0, 100),
      coverageNote: '仅代表实际观察到的交互；未点击或无返回的路径不能视为验证通过' };
    try {
      const file = path.join(dataDir, 'daily-feedback-summary.json');
      const temp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(temp, JSON.stringify(snapshotCache), { mode: 0o600 });
      fs.renameSync(temp, file);
    } catch {}
    return snapshotCache;
  }
  return { record, flush, snapshot };
}

let singleton;
function getDailyFeedback() {
  if (!singleton) {
    if (process.env.NODE_TEST_CONTEXT && !process.env.FARM_DATA_DIR) {
      return { record: () => false, flush: () => {}, snapshot: () => ({ counts: {}, groups: [] }) };
    }
    let revision = '';
    try { revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: path.resolve(__dirname, '../../..'), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); } catch {}
    singleton = createDailyFeedbackStore({ dataDir: getDataDir(), revision });
    const cleanupTimer = setInterval(() => singleton.snapshot(), 3600000);
    cleanupTimer.unref?.();
    process.once('exit', () => singleton.flush());
  }
  return singleton;
}
function recordRuntimeFeedback(level, moduleName, meta = {}) {
  if (!['warn', 'error'].includes(level)) return;
  if (typeof meta?.module === 'string') moduleName = meta.module;
  const domain = /friend|steal/i.test(moduleName) ? 'friends'
    : /farm|plant|harvest/i.test(moduleName) ? 'farm'
      : /activity|pet/i.test(moduleName) ? 'activity'
        : /auth|login|code.refresh/i.test(moduleName) ? 'auth'
          : /network|socket|request/i.test(moduleName) ? 'network'
            : /worker/i.test(moduleName) ? 'worker' : /admin/i.test(moduleName) ? 'admin' : 'system';
  getDailyFeedback().record({ kind: 'runtime', domain, category: level === 'warn' ? 'runtime_warn' : 'runtime_error', trace: feedbackContext.getStore()?.trace });
}
module.exports = { createDailyFeedbackStore, getDailyFeedback, recordRuntimeFeedback, feedbackContext,
  normalizeFeedback, TRACE_RE, RETENTION_MS, MAX_DAY_BYTES, newFeedbackTrace: () => crypto.randomUUID() };
