'use strict';
/**
 * 奶茶三路由专用请求结果 sidecar（2026-10-30 奶茶 502 定位修复）。
 *
 * 通用 daily-feedback / admin-feedback-routes 是保护文件，本文件是独立私有
 * 存储：只由服务端路由在 finish/close 时写一行白名单字段，用既有
 * feedbackContext 的 trace UUID 关联原始反馈。只记可信结果——原始动作、
 * 有限阶段、固定码、预算原因、HTTP 状态与结局；请求参数、账号身份、错误
 * 原文、堆栈一律不落盘，客户端输入不能伪造后端结果字段。
 *
 * 存储：dataDir/milk-tea-request-feedback/<day>.jsonl，UTC 日键滚动，
 * 24h 有界（只保留两个日键文件，读取按 at 过滤），每文件行数/字节双上限；
 * finish 与 close 只记一次（计数不双记）。
 */
const fs = require('node:fs');
const path = require('node:path');
const { feedbackContext, TRACE_RE } = require('./daily-feedback');
const { getDataDir } = require('../config/runtime-paths');

const RETENTION_MS = 24 * 60 * 60 * 1000;
const MAX_DAY_ROWS = 2000;
const MAX_DAY_BYTES = 1024 * 1024;
const DAY_FILE_RE = /^\d{4}-\d{2}-\d{2}\.jsonl$/;

// 冻结的动作白名单（与 milk-tea-activity 的 MANUAL_ACTIONS/QUERY_KINDS 对齐）：
// 刻意不 import 服务模块——新增动作未同步时宁可少记，不自动放行新值入库。
const ACTIONS = new Set([
  'createShop', 'renameShop', 'hire', 'claimCashier', 'boost', 'upgrade', 'craft',
  'claimWages', 'interact', 'hireSetting', 'exchange', 'fundClaim', 'shareDaily', 'shareFirst', 'shareMilestones',
  'shop', 'hireList', 'workshop', 'work', 'rank', 'sales',
]);
const ROUTES = new Set(['snapshot', 'query', 'operate']);
const STAGES = new Set(['list', 'group', 'precondition', 'write']);
const OUTCOMES = new Set(['succeeded', 'business', 'unavailable', 'budget', 'transport', 'unknown_write', 'rejected_input', 'not_ready', 'aborted', 'partial']);
const BUDGET_REASONS = new Set(['budget_total', 'budget_method']);
const CODE_RE = /^SEASON_WISH_MILK_TEA_[A-Z0-9_]{1,48}$/;

// 与普通每日反馈使用相同 UTC 日键。
function dayKeyOf(now) {
  return new Date(now).toISOString().slice(0, 10);
}

function normalizeRecord(value, now) {
  if (!value || typeof value !== 'object' || !Number.isFinite(now)) return null;
  if (!ROUTES.has(value.route) || !OUTCOMES.has(value.outcome)) return null;
  if (value.action !== undefined && !ACTIONS.has(value.action)) return null;
  if (value.stage !== undefined && !STAGES.has(value.stage)) return null;
  if (value.code !== undefined && !(typeof value.code === 'string' && (value.code === 'MILK_TEA_RATE_LIMITED' || CODE_RE.test(value.code)))) return null;
  if (value.governedReason !== undefined && !BUDGET_REASONS.has(value.governedReason)) return null;
  if (value.outcome === 'business' && !CODE_RE.test(value.code)) return null;
  const item = { at: now, kind: 'milk_request', route: value.route, outcome: value.outcome };
  if (ACTIONS.has(value.action)) item.action = value.action;
  if (STAGES.has(value.stage)) item.stage = value.stage;
  if (value.code === 'MILK_TEA_RATE_LIMITED' || (typeof value.code === 'string' && CODE_RE.test(value.code))) item.code = value.code;
  if (BUDGET_REASONS.has(value.governedReason)) item.governedReason = value.governedReason;
  if (Number.isInteger(value.httpStatus) && value.httpStatus >= 100 && value.httpStatus <= 599) item.httpStatus = value.httpStatus;
  if (typeof value.trace === 'string' && TRACE_RE.test(value.trace)) item.trace = value.trace;
  return item;
}

function createMilkTeaRequestFeedbackStore({ dataDir, now = Date.now } = {}) {
  const folder = path.join(dataDir, 'milk-tea-request-feedback');
  let dropped = 0;

  function fileOf(day) { return path.join(folder, `${day}.jsonl`); }

  function ensureFolder() {
    const absolute = path.resolve(folder);
    let parent = path.parse(absolute).root;
    for (const part of absolute.slice(parent.length).split(path.sep).filter(Boolean)) {
      parent = path.join(parent, part);
      try {
        const stat = fs.lstatSync(parent);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('unsafe sidecar directory');
      }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        try { fs.mkdirSync(parent, { mode: 0o700 }); } catch (race) {
          if (race.code !== 'EEXIST') throw race;
          const stat = fs.lstatSync(parent);
          if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('unsafe sidecar directory');
        }
      }
    }
    fs.chmodSync(folder, 0o700);
  }

  function readDay(day) {
    let fd;
    const file = fileOf(day);
    try {
      fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size > MAX_DAY_BYTES + 4096) throw new Error('invalid sidecar file');
      return fs.readFileSync(fd, 'utf8');
    }
    catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
    finally { if (fd !== undefined) fs.closeSync(fd); }
  }

  function prune(currentDay) {
    try {
      for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
        if (!entry.isFile() || !DAY_FILE_RE.test(entry.name)) continue;
        // 只保留当日与前一日的两个日键（24h + 0600 滚动余量）
        if (entry.name >= dayKeyOf(now() - RETENTION_MS)) continue;
        try { fs.unlinkSync(path.join(folder, entry.name)); } catch { dropped += 1; }
      }
    }
    catch { /* 目录不可读：写入路径自行兜底 */ }
  }

  function record(value) {
    const time = now();
    const item = normalizeRecord(value, time);
    if (!item) return false;
    try {
      ensureFolder();
      const day = dayKeyOf(time);
      prune(day);
      const file = fileOf(day);
      const line = `${JSON.stringify(item)}\n`;
      let fd;
      try {
        fd = fs.openSync(file, fs.constants.O_RDWR | fs.constants.O_APPEND | fs.constants.O_CREAT
          | fs.constants.O_NOFOLLOW, 0o600);
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.nlink !== 1) throw new Error('unsafe sidecar file');
        fs.fchmodSync(fd, 0o600);
        const previous = stat.size ? fs.readFileSync(fd, 'utf8') : '';
        const lines = previous ? previous.trimEnd().split('\n').length : 0;
        if (lines >= MAX_DAY_ROWS || stat.size + Buffer.byteLength(line) > MAX_DAY_BYTES) {
          dropped += 1;
          return false;
        }
        fs.writeSync(fd, previous && !previous.endsWith('\n') ? `\n${line}` : line);
        return true;
      }
      finally { if (fd !== undefined) fs.closeSync(fd); }
    }
    catch {
      dropped += 1;
      return false;
    }
  }

  /** 读回（关联诊断用）：默认 24h 窗口，可按 trace 过滤。自身抛错由调用方处理。 */
  function load({ trace, sinceMs } = {}) {
    const time = now();
    const since = Number.isFinite(sinceMs) ? Math.max(sinceMs, time - RETENTION_MS) : time - RETENTION_MS;
    const rows = [];
    let day = dayKeyOf(since);
    const today = dayKeyOf(time);
    for (let guard = 0; guard < 4 && day <= today; guard += 1, day = dayKeyOf(new Date(`${day}T00:00:00.001Z`).getTime() + 24 * 3600_000)) {
      const text = readDay(day);
      if (!text) continue;
      for (const line of text.split('\n')) {
        if (!line) continue;
        let raw;
        try { raw = JSON.parse(line); } catch { continue; }
        const item = normalizeRecord({ ...raw, at: undefined }, raw.at);
        if (!item || item.at < since || item.at > time) continue;
        if (trace !== undefined && item.trace !== trace) continue;
        rows.push(item);
      }
    }
    return rows;
  }

  return { record, load, stats: () => ({ dropped }) };
}

let singleton;
function getMilkTeaRequestFeedback() {
  if (!singleton) {
    if (process.env.NODE_TEST_CONTEXT && !process.env.FARM_DATA_DIR) {
      singleton = { record: () => false, load: () => [], stats: () => ({ dropped: 0 }) };
    }
    else {
      singleton = createMilkTeaRequestFeedbackStore({ dataDir: getDataDir() });
    }
  }
  return singleton;
}

/**
 * 路由侧一次性挂接：finish/close 仅记一行；返回控制器供 catch 分支在
 * res.json 前补充可信字段。挂接或落盘异常都不改变请求结果。
 */
function beginMilkTeaRequestFeedback(res, base, { store = getMilkTeaRequestFeedback() } = {}) {
  const patch = {};
  let finished = false;
  try {
    const store_ = feedbackContext.getStore();
    if (store_ && TRACE_RE.test(store_.trace)) patch.trace = store_.trace;
  }
  catch { /* 反馈上下文缺失：照常记录，仅无关联 */ }
  const flush = (aborted = false) => {
    if (finished) return;
    finished = true;
    try {
      const status = Number(res.statusCode);
      store.record({ ...base, ...patch, ...(aborted ? { outcome: 'aborted' } : {}), httpStatus: Number.isInteger(status) ? status : undefined });
    }
    catch { /* 诊断失败不影响请求 */ }
  };
  try {
    res.once('finish', () => flush(false));
    res.once('close', () => flush(res.writableFinished !== true));
  }
  catch { /* 非标准 res：无法挂接则不记录 */ }
  return {
    set(values) {
      if (values && typeof values === 'object') Object.assign(patch, values);
      return this;
    },
  };
}

module.exports = {
  createMilkTeaRequestFeedbackStore,
  getMilkTeaRequestFeedback,
  beginMilkTeaRequestFeedback,
  normalizeRecord,
  dayKeyOf,
};
