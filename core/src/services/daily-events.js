/**
 * 当日事件日志：重要事件一条条记流水（带时间/级别/摘要），只保留当天。
 * 与 winston 运行日志互补：那个是全量排查用，这个是给人看的「今天发生了什么」。
 * 落盘 core/data/daily-events-<accountId>.json，跨日自动清空。
 */
const fs = require('node:fs');
const path = require('node:path');
const { getDataFile } = require('../config/runtime-paths');
const { collectRuntimePrivacyTerms, redactExternalText } = require('./privacy-guard');

const MAX_EVENTS = 200; // 单日上限，够看且防刷爆

const accounts = new Map(); // accountId -> { date, events: [] }

function todayKey() {
  const d = new Date(Date.now() + 8 * 3600 * 1000); // 北京时间跨日
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

function filePath(accountId) {
  return getDataFile(`daily-events-${accountId || 'default'}.json`);
}

function readPersistedTodayEvents(accountId) {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath(String(accountId || 'default')), 'utf8'));
    if (raw && raw.date === todayKey() && Array.isArray(raw.events)) {
      return raw.events.slice(-MAX_EVENTS);
    }
  } catch {}
  return [];
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

function sanitizeShareableMessage(event, runtimeTerms) {
  const type = String(event && event.type || 'event').slice(0, 40);
  let message = redactExternalText(String(event && event.message || ''));
  for (const term of [...runtimeTerms].sort((left, right) => right.length - left.length)) {
    message = message.split(term).join('[PERSONAL]');
  }
  // 偷菜事件的旧记录直接包含好友昵称；即使昵称尚未进入本机 denylist，也不能外发。
  if (type === 'steal' && message.startsWith('偷取 ')) {
    const countMatch = message.match(/\s(\d+) 个/u);
    if (countMatch && Number.isInteger(countMatch.index)) {
      const suffix = message.slice(countMatch.index + countMatch[0].length);
      message = `偷取 好友 ${countMatch[1]} 个${suffix}`;
    }
  }
  return message
    .replace(/\b(gid|openid|uin|wxid)\s*[:=：]\s*[\w-]+/gi, '$1=[IDENTIFIER]')
    .replace(/\b[\w.%+-]+@[\w.-]+\.[A-Z]{2,}\b/gi, '[EMAIL]')
    .replace(/[\r\n\t]+/g, ' ')
    .trim()
    .slice(0, 500);
}

/**
 * 诊断偷菜问题时保留好友昵称，但凭据、网络地址和账号标识仍必须脱敏。
 * 此函数只处理已经明确属于偷菜/被偷的短文本，不可用于导出任意运行日志。
 */
function sanitizeStealDiagnosticText(value) {
  return redactExternalText(String(value || ''))
    .replace(/\b(gid|openid|uin|wxid)\s*[:=：]\s*[\w-]+/gi, '$1=[IDENTIFIER]')
    .replace(/\b[\w.%+-]+@[\w.-]+\.[A-Z]{2,}\b/gi, '[EMAIL]')
    .replace(/[\r\n\t]+/g, ' ')
    .trim()
    .slice(0, 500);
}

function sanitizeFriendName(value) {
  const name = String(value || '').trim();
  if (!name || /^GID\s*[:=：]/i.test(name)) return '未知好友';
  return sanitizeStealDiagnosticText(name).slice(0, 80) || '未知好友';
}

function formatShareableTime(timestamp) {
  const date = new Date((Number(timestamp) || 0) + 8 * 3600 * 1000);
  const pad = value => String(value).padStart(2, '0');
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} `
    + `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())} +08:00`;
}

/** 构造可交给他人排查的脱敏文本，不包含账号 ID/名称或好友昵称。 */
function buildShareableDailyEventLog(events, options = {}) {
  const date = String(options.date || todayKey());
  const runtimeTerms = options.runtimeTerms || collectRuntimePrivacyTerms();
  const rows = (Array.isArray(events) ? events : []).slice(-MAX_EVENTS).map((event) => {
    const level = event && (event.level === 'warn' || event.level === 'error') ? event.level : 'info';
    const type = String(event && event.type || 'event').replace(/[^\w-]/g, '').slice(0, 40) || 'event';
    const count = Math.max(1, Number(event && event.count) || 1);
    const repeat = count > 1 ? ` ×${count}` : '';
    return `[${formatShareableTime(event && event.at)}] [${level}] [${type}] ${sanitizeShareableMessage(event, runtimeTerms)}${repeat}`;
  });
  return [
    'QQ Farm Bot 今日事件（已脱敏）',
    `日期：${date}（北京时间）`,
    '说明：不包含账号标识、好友昵称、凭据、Token、Webhook、网址或本机地址。',
    '',
    ...(rows.length > 0 ? rows : ['今天没有记录到事件。']),
    '',
  ].join('\n');
}

/**
 * 构造专用偷菜诊断日志：只包含本账号偷菜和别人偷本账号两类事件。
 * 好友昵称按用户要求保留；GID、头像 URL、账号信息和凭据从不写入。
 */
function buildStealDailyEventLog(events, interactRecords, options = {}) {
  const date = String(options.date || todayKey());
  const incomingAvailable = options.incomingAvailable !== false;
  const rows = [];

  for (const event of (Array.isArray(events) ? events : []).slice(-MAX_EVENTS)) {
    if (String(event && event.type || '') !== 'steal') continue;
    if (formatShareableTime(event && event.at).slice(0, 10) !== date) continue;
    const count = Math.max(1, Number(event && event.count) || 1);
    rows.push({
      at: Number(event && event.at) || 0,
      direction: '偷菜',
      message: sanitizeStealDiagnosticText(event && event.message),
      repeat: count > 1 ? ` ×${count}` : '',
    });
  }

  for (const record of Array.isArray(interactRecords) ? interactRecords : []) {
    if (Number(record && record.actionType) !== 1) continue;
    const at = Number(record && (record.serverTimeMs || Number(record.serverTimeSec) * 1000)) || 0;
    if (formatShareableTime(at).slice(0, 10) !== date) continue;
    const friendName = sanitizeFriendName(record && record.nick);
    const detail = sanitizeStealDiagnosticText(record && record.actionDetail) || '偷取作物';
    rows.push({ at, direction: '被偷', message: `${friendName} · ${detail}`, repeat: '' });
  }

  rows.sort((left, right) => left.at - right.at || left.direction.localeCompare(right.direction));
  const incomingStatus = incomingAvailable
    ? '被偷记录：已读取访客互动记录。'
    : '被偷记录：账号离线或接口暂不可用，本次只导出已有偷菜事件。';

  return [
    'QQ Farm Bot 偷菜/被偷事件日志',
    `日期：${date}（北京时间）`,
    '说明：仅包含偷菜与被偷事件；为便于排查会保留好友昵称，请谨慎分享。',
    '安全处理：不包含 GID、账号标识、凭据、Token、Webhook、网址或本机地址。',
    incomingStatus,
    '',
    ...(rows.length > 0
      ? rows.map(row => `[${formatShareableTime(row.at)}] [${row.direction}] ${row.message}${row.repeat}`)
      : ['今天没有记录到偷菜或被偷事件。']),
    '',
  ].join('\n');
}

/** 测试用 */
function resetForTest() {
  accounts.clear();
}

module.exports = {
  recordEvent,
  getTodayEvents,
  readPersistedTodayEvents,
  buildShareableDailyEventLog,
  buildStealDailyEventLog,
  todayKey,
  resetForTest,
  MAX_EVENTS,
};
