const fs = require('node:fs');
const path = require('node:path');
const { getDataFile } = require('../config/runtime-paths');

const stateByAccount = new Map();

function getDateKey(now = new Date()) {
  const date = now instanceof Date ? now : new Date(now);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function normalizeAccountId(accountId) {
  return String(accountId || 'default').replace(/[^\w.-]/g, '_').slice(0, 80) || 'default';
}

function statePath(accountId) {
  return getDataFile(`daily-routine-${normalizeAccountId(accountId)}.json`);
}

function loadState(accountId, dateKey) {
  const accountKey = normalizeAccountId(accountId);
  const cached = stateByAccount.get(accountKey);
  if (cached && cached.date === dateKey) return cached;

  let state = null;
  try {
    const raw = JSON.parse(fs.readFileSync(statePath(accountKey), 'utf8'));
    if (raw && raw.date === dateKey && raw.done && typeof raw.done === 'object') {
      state = { date: dateKey, done: { ...raw.done } };
    }
  } catch { /* 无文件或损坏时安全地重新核对当天任务 */ }

  if (!state) state = { date: dateKey, done: {} };
  stateByAccount.set(accountKey, state);
  return state;
}

function persistState(accountId, state) {
  try {
    const file = statePath(accountId);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(state, null, 2));
    return true;
  } catch {
    // 落盘失败只退化为本进程去重，不能阻断后续每日任务。
    return false;
  }
}

function isDailyRoutineDone(accountId, routineKey, now = new Date()) {
  const key = String(routineKey || '').trim();
  if (!key) return false;
  const state = loadState(accountId, getDateKey(now));
  return state.done[key] === true;
}

function markDailyRoutineDone(accountId, routineKey, now = new Date()) {
  const key = String(routineKey || '').trim();
  if (!key) return false;
  const dateKey = getDateKey(now);
  const state = loadState(accountId, dateKey);
  if (state.done[key] === true) return false;
  state.done[key] = true;
  persistState(accountId, state);
  return true;
}

function resetMemoryForTest() {
  stateByAccount.clear();
}

module.exports = {
  getDateKey,
  isDailyRoutineDone,
  markDailyRoutineDone,
  resetMemoryForTest,
};
