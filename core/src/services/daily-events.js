/**
 * 当日事件日志：重要事件一条条记流水（带时间/级别/摘要），只保留当天。
 * 与 winston 运行日志互补：那个是全量排查用，这个是给人看的「今天发生了什么」。
 * 落盘 core/data/daily-events-<accountId>.json，跨日自动清空。
 */
const fs = require('node:fs');
const path = require('node:path');
const { getDataFile } = require('../config/runtime-paths');

const MAX_EVENTS = 200; // 单日上限，够看且防刷爆

const accounts = new Map(); // accountId -> { date, events: [] }

function todayKey() {
  const d = new Date(Date.now() + 8 * 3600 * 1000); // 北京时间跨日
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

function filePath(accountId) {
  return getDataFile(`daily-events-${accountId || 'default'}.json`);
}

function load(accountId) {
  const key = String(accountId || 'default');
  let state = accounts.get(key);
  if (state && state.date === todayKey()) return state;
  try {
    const raw = JSON.parse(fs.readFileSync(filePath(key), 'utf8'));
    if (raw && raw.date === todayKey() && Array.isArray(raw.events)) {
      state = { date: raw.date, events: raw.events.slice(-MAX_EVENTS) };
      accounts.set(key, state);
      return state;
    }
  } catch { /* 无文件或损坏 → 新的一天 */ }
  state = { date: todayKey(), events: [] };
  accounts.set(key, state);
  persist(key, state);
  return state;
}

function persist(accountId, state) {
  try {
    const p = filePath(accountId);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(state, null, 2));
  } catch { /* 落盘失败只丢历史，不影响主流程 */ }
}

/**
 * 记录一条当日事件
 * @param {string} accountId
 * @param {'info'|'warn'|'error'} level
 * @param {string} type 事件类型（kickout/slowdown/evolve/harvest_failed/...）
 * @param {string} message 人话摘要
 */
function recordEvent(accountId, level, type, message) {
  const state = load(accountId);
  const last = state.events[state.events.length - 1];
  const entry = {
    at: Date.now(),
    level: level === 'warn' || level === 'error' ? level : 'info',
    type: String(type || 'event').slice(0, 40),
    message: String(message || '').slice(0, 300),
  };
  // 同类型同文案 30 秒内去重（防同错误刷屏）
  if (last && last.type === entry.type && last.message === entry.message
    && entry.at - last.at < 30_000) {
    last.count = (last.count || 1) + 1;
    last.at = entry.at;
  } else {
    state.events.push(entry);
    if (state.events.length > MAX_EVENTS) state.events.splice(0, state.events.length - MAX_EVENTS);
  }
  persist(String(accountId || 'default'), state);
}

function getTodayEvents(accountId) {
  return load(accountId).events;
}

/** 测试用 */
function resetForTest() {
  accounts.clear();
}

module.exports = { recordEvent, getTodayEvents, todayKey, resetForTest, MAX_EVENTS };
