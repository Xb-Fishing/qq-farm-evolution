/** Private daily feedback: allowlisted facts only, never request bodies or error text. */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');
const { execFileSync } = require('node:child_process');
const { isMainThread } = require('node:worker_threads');
const { getDataDir } = require('../config/runtime-paths');

const feedbackContext = new AsyncLocalStorage();
const RETENTION_MS = 24 * 60 * 60 * 1000;
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
  if (!value || !['click', 'request', 'client_error', 'runtime', 'monitor'].includes(value.kind)) return null;
  const item = { at: now, kind: value.kind };
  if (typeof revision === 'string' && /^[a-f0-9]{40}$/.test(revision)) item.revision = revision;
  if (value.kind !== 'monitor' && typeof value.trace === 'string' && TRACE_RE.test(value.trace)) item.trace = value.trace;
  if (value.kind === 'monitor') {
    if (value.category !== 'priority_poll' || !['succeeded', 'failed'].includes(value.outcome)
        || !['baseline', 'observation'].includes(value.mode) || !Number.isFinite(value.nextDelayMs)) return null;
    item.category = 'priority_poll';
    item.outcome = value.outcome;
    item.mode = value.mode;
    item.nextDelayMs = bounded(value.nextDelayMs, 3600000);
  } else if (value.kind === 'click') {
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
  const lockFile = path.join(folder, '.write.lock');
  const watermarkFile = path.join(folder, '.acknowledged.json');
  const summaryFile = path.join(dataDir, 'daily-feedback-summary.json');
  let queue = [];
  let timer = null;
  let dropped = 0;
  let snapshotCache = null;
  let cacheExpiresAt = 0;

  // Do not follow links in either the private directory or its ancestry.
  function ensureFolder() {
    const absolute = path.resolve(folder);
    let parent = path.parse(absolute).root;
    for (const part of absolute.slice(parent.length).split(path.sep).filter(Boolean)) {
      parent = path.join(parent, part);
      try {
        const stat = fs.lstatSync(parent);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('unsafe feedback directory');
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        try { fs.mkdirSync(parent, { mode: 0o700 }); } catch (race) {
          if (race.code !== 'EEXIST') throw race;
          const stat = fs.lstatSync(parent);
          if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('unsafe feedback directory');
        }
      }
    }
    fs.chmodSync(folder, 0o700);
  }
  function readPrivate(file, limit = maxDayBytes) {
    let fd;
    try {
      fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size > limit) throw new Error('invalid feedback file');
      return fs.readFileSync(fd, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    } finally { if (fd !== undefined) fs.closeSync(fd); }
  }
  function writePrivate(file, text) {
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('unsafe feedback file');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const temp = path.join(path.dirname(file), `.feedback-${crypto.randomUUID()}.tmp`);
    let fd;
    try {
      fd = fs.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
      fs.writeFileSync(fd, text);
      fs.closeSync(fd);
      fd = undefined;
      fs.renameSync(temp, file);
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      try { fs.unlinkSync(temp); } catch {}
    }
  }
  function recoverDeadOwner() {
    const original = readPrivate(lockFile, 512);
    const owner = JSON.parse(original);
    if (!Number.isSafeInteger(owner?.pid) || owner.pid <= 0 || !TRACE_RE.test(owner.nonce || '')) return false;
    try { process.kill(owner.pid, 0); return false; } catch (error) {
      // Never steal on a timeout, permission failure, or from another live worker.
      if (error.code !== 'ESRCH') return false;
    }
    if (readPrivate(lockFile, 512) !== original) return false;
    fs.unlinkSync(lockFile);
    return true;
  }
  function withLock(action) {
    let fd;
    let lockText;
    try {
      ensureFolder();
      const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW;
      try { fd = fs.openSync(lockFile, flags, 0o600); } catch (error) {
        if (error.code !== 'EEXIST' || !recoverDeadOwner()) throw error;
        fd = fs.openSync(lockFile, flags, 0o600);
      }
      lockText = JSON.stringify({ pid: process.pid, nonce: crypto.randomUUID() });
      fs.writeFileSync(fd, lockText);
      return { complete: true, value: action() };
    } catch { return { complete: false }; }
    finally {
      if (fd !== undefined) {
        fs.closeSync(fd);
        try { if (readPrivate(lockFile, 512) === lockText) fs.unlinkSync(lockFile); } catch {}
      }
    }
  }
  function scheduleFlush() {
    if (queue.length && !timer) { timer = setTimeout(flush, 500); timer.unref?.(); }
  }
  function watermark(time) {
    try {
      const value = JSON.parse(readPrivate(watermarkFile, 256));
      if (value?.version === 1 && Number.isSafeInteger(value.throughAt)
          && value.throughAt >= 0 && value.throughAt <= time) return value.throughAt;
    } catch {}
    return -1;
  }
  function cleanupLocked(time, throughAt) {
    let unreadableFiles = 0;
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      if (!entry.isFile() || !DAY_FILE_RE.test(entry.name)) continue;
      const file = path.join(folder, entry.name);
      const original = readPrivate(file);
      if (original === null) continue;
      const kept = [];
      for (const line of original.split('\n')) {
        if (!line) continue;
        let raw;
        try { raw = JSON.parse(line); } catch { unreadableFiles += 1; continue; }
        if (!raw || !Number.isSafeInteger(raw.at) || raw.at < time - RETENTION_MS || raw.at > time || raw.at <= throughAt) continue;
        const item = normalizeFeedback(raw, raw.at, raw.revision);
        if (item) kept.push(JSON.stringify(item));
      }
      const text = kept.length ? `${kept.join('\n')}\n` : '';
      if (!text) fs.unlinkSync(file);
      else if (text !== original) writePrivate(file, text);
    }
    return unreadableFiles;
  }
  // Game workers only append the small pending batch. Full-day scans belong to
  // explicit snapshots and main-process maintenance, never the 500 ms flush path.
  function flushLocked(time) {
    const throughAt = watermark(time);
    queue = queue.filter(item => item.at >= time - RETENTION_MS && item.at <= time && item.at > throughAt);
    const groups = new Map();
    for (const item of queue) {
      const key = dateKey(item.at);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(item);
    }
    for (const [day, items] of groups) {
      const file = path.join(folder, `${day}.jsonl`);
      const flags = fs.constants.O_RDWR | fs.constants.O_APPEND | fs.constants.O_CREAT
        | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK;
      const fd = fs.openSync(file, flags, 0o600);
      try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.nlink !== 1) throw new Error('unsafe feedback file');
        fs.fchmodSync(fd, 0o600);
        let text = '';
        if (stat.size) {
          const tail = Buffer.alloc(1);
          fs.readSync(fd, tail, 0, 1, stat.size - 1);
          if (tail[0] !== 10) text = '\n';
        }
        let length = stat.size + Buffer.byteLength(text);
        let rejected = 0;
        let accepted = 0;
        for (const item of items) {
          const line = `${JSON.stringify(item)}\n`;
          const bytes = Buffer.byteLength(line);
          if (length + bytes > maxDayBytes) { rejected += 1; continue; }
          length += bytes;
          accepted += 1;
          text += line;
        }
        if (accepted) {
          try { fs.writeFileSync(fd, text); } catch (error) {
            // Preserve the queue and undo a partial append while still holding
            // the shared lock; retry must not duplicate an already written row.
            fs.ftruncateSync(fd, stat.size);
            throw error;
          }
        }
        dropped += rejected;
        const written = new Set(items);
        queue = queue.filter(item => !written.has(item));
      } finally { fs.closeSync(fd); }
    }
  }
  function flush() {
    if (timer) clearTimeout(timer);
    timer = null;
    const result = withLock(() => flushLocked(now()));
    scheduleFlush();
    return result.complete;
  }
  function record(value) {
    const item = normalizeFeedback(value, now(), revision);
    if (!item) return false;
    snapshotCache = null;
    if (queue.length >= 2000) { dropped += 1; return false; }
    queue.push(item);
    scheduleFlush();
    return true;
  }
  function summaryLocked(time, unreadableFiles = 0) {
    const groups = new Map();
    const counts = { clicks: 0, requests: 0, failures: 0, accepted: 0, runtimeErrors: 0, clientErrors: 0 };
    const monitor = { attempts: 0, successes: 0, failures: 0, observation: 0, baseline: 0 };
    let expiresAt = Infinity;
    const throughAt = watermark(time);
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      if (!entry.isFile() || !DAY_FILE_RE.test(entry.name)) continue;
      for (const line of (readPrivate(path.join(folder, entry.name)) || '').split('\n')) {
        if (!line) continue;
        let raw;
        try { raw = JSON.parse(line); } catch { unreadableFiles += 1; continue; }
        if (!raw || !Number.isSafeInteger(raw.at) || raw.at < time - RETENTION_MS || raw.at > time || raw.at <= throughAt) continue;
        const item = normalizeFeedback(raw, raw.at, raw.revision);
        if (!item) continue;
        expiresAt = Math.min(expiresAt, item.at + RETENTION_MS + 1);
        if (item.kind === 'monitor') {
          monitor.attempts += 1;
          monitor[item.outcome === 'succeeded' ? 'successes' : 'failures'] += 1;
          monitor[item.mode] += 1;
        }
        if (item.kind === 'click') counts.clicks += 1;
        if (item.kind === 'request') counts.requests += 1;
        if (item.kind === 'runtime') counts.runtimeErrors += 1;
        if (item.kind === 'client_error') counts.clientErrors += 1;
        if (item.outcome === 'accepted') counts.accepted += 1;
        if (['failed', 'rejected', 'partial', 'aborted'].includes(item.outcome)) counts.failures += 1;
        const key = item.kind === 'monitor' ? `priority_poll:${item.mode}`
          : item.action ? `${item.action}${item.operation ? `:${item.operation}` : ''}${item.reason ? `:${item.reason}` : ''}`
            : item.category || `click:${item.page}:${item.target}`;
        const row = groups.get(key) || { key, count: 0, failures: 0, lastAt: 0, maxDurationMs: 0 };
        row.count += 1;
        if (['failed', 'rejected', 'partial', 'aborted'].includes(item.outcome)) row.failures += 1;
        row.lastAt = Math.max(row.lastAt, item.at);
        row.maxDurationMs = Math.max(row.maxDurationMs, item.durationMs || 0);
        groups.set(key, row);
      }
    }
    const summary = { day: dateKey(time), generatedAt: time, windowHours: 24, counts, monitor, dropped, pending: queue.length, unreadableFiles,
      groups: [...groups.values()].sort((a, b) => b.failures - a.failures || b.lastAt - a.lastAt).slice(0, 100),
      coverageNote: '仅代表实际观察到的交互；未点击或无返回的路径不能视为验证通过' };
    writePrivate(summaryFile, JSON.stringify(summary));
    snapshotCache = summary;
    cacheExpiresAt = Math.min(time + 10000, expiresAt);
    return summary;
  }
  function maintainLocked(time) {
    const unreadableFiles = cleanupLocked(time, watermark(time));
    flushLocked(time);
    return summaryLocked(time, unreadableFiles);
  }
  function snapshot({ force = false } = {}) {
    const time = now();
    if (!force && snapshotCache && time >= snapshotCache.generatedAt && time < cacheExpiresAt) return snapshotCache;
    const result = withLock(() => maintainLocked(time));
    scheduleFlush();
    return result.complete ? result.value : {
      day: dateKey(time), generatedAt: time, windowHours: 24, counts: {}, groups: [],
      monitor: { attempts: 0, successes: 0, failures: 0, observation: 0, baseline: 0 },
      dropped, pending: queue.length, unreadableFiles: 1,
      coverageNote: '反馈存储暂不可读；不能视为验证通过',
    };
  }
  function captureBatch() {
    const time = now();
    const result = withLock(() => { maintainLocked(time); return { throughAt: time }; });
    scheduleFlush();
    return result.complete ? result.value : null;
  }
  function acknowledgeBatch(batch) {
    const time = now();
    if (!Number.isSafeInteger(batch?.throughAt) || batch.throughAt < 0 || batch.throughAt > time) return false;
    snapshotCache = null;
    const result = withLock(() => {
      const throughAt = Math.max(watermark(time), batch.throughAt);
      writePrivate(watermarkFile, JSON.stringify({ version: 1, throughAt }));
      maintainLocked(time);
    });
    scheduleFlush();
    return result.complete;
  }
  return { record, flush, snapshot, captureBatch, acknowledgeBatch };
}

let singleton;
function getDailyFeedback() {
  if (!singleton) {
    if (process.env.NODE_TEST_CONTEXT && !process.env.FARM_DATA_DIR) {
      return { record: () => false, flush: () => false, snapshot: () => ({ counts: {}, groups: [] }),
        captureBatch: () => null, acknowledgeBatch: () => false };
    }
    let revision = '';
    try { revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: path.resolve(__dirname, '../../..'), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); } catch {}
    singleton = createDailyFeedbackStore({ dataDir: getDataDir(), revision });
    if (isMainThread && !process.env.FARM_ACCOUNT_ID) {
      const cleanupTimer = setInterval(() => singleton.snapshot({ force: true }), 60000);
      cleanupTimer.unref?.();
    }
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
