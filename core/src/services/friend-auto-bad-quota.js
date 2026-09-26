/**
 * 在线捣乱按游戏日暂停闸门（2026-09-26）。
 *
 * 用户定标："额度不足的话在线捣乱就可以停止到第二天了"。
 * 可信耗尽判定（只读本地额度缓存，零额外 RPC）：
 *  - bot 总额度 getBadRemainingTimes() <= 0；或
 *  - 放虫 + 放草两个单项 getRemainingTimes(PUT_*_OPERATION_ID, BAD_DAILY_LIMIT) 均为 0。
 * 仅一项为 0 不算耗尽（另一项仍可执行）。canOperate=false / 网络失败 / 超时 /
 * 无可放土地 / 1001046 已放过都不是额度耗尽，本模块不做任何推断。
 *
 * 暂停到下一游戏日：日界与 friend-operation-limits.checkDailyReset 完全一致
 * （服务器时间 + UTC+8 日界）。恢复时只调用现有导出的 checkDailyReset 让
 * 额度缓存按游戏日更新（修复"次日仍读昨日缓存又暂停"的陷阱），不发探测、
 * 不重放旧事件，等新的有效在线证据再动作。
 *
 * 持久化：<运行数据目录>/auto-bad-quota/<accountId 稳定哈希>.json，只含
 * version/dayKey/reason/resumeAt（零好友、零凭据）。数据目录统一走
 * config/runtime-paths.getDataDir()（内含 FARM_DATA_DIR 支持），绝不落到
 * 相对 cwd。进程重启后同游戏日闸门仍生效；跨账号按文件名天然隔离
 * （哈希避免 sanitize 碰撞/目录穿越）；旧日/损坏/白名单外记录读到即当无闸门。
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const UTC_PLUS_8_OFFSET_MS = 8 * 3600 * 1000;
const DAY_MS = 24 * 3600 * 1000;
const STATE_VERSION = 1;
// 读回校验：只接受本模块 pause() 产生的固定原因码；任意文字不透传
const REASONS = new Set(['total_zero', 'both_items_zero']);
const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

// accountId -> { dayKey, reason, resumeAt } | null（null = 已加载且无闸门）
const loadedAccounts = new Map();

const deps = {
  now: () => Date.now(),
  // 与 checkDailyReset 相同的服务器时间来源（秒→毫秒，未同步则退回本地钟）
  serverNow: () => {
    const sec = require('../utils/utils').getServerTimeSec();
    return sec > 0 ? sec * 1000 : Date.now();
  },
  accountId: () => process.env.FARM_ACCOUNT_ID || '',
  // 统一走运行数据目录 helper（FARM_DATA_DIR 在其内部支持），绝不落相对 cwd
  dataDir: () => require('../config/runtime-paths').getDataDir(),
  // 恢复时调用现有导出（不修改其逻辑），让额度缓存按游戏日更新
  checkDailyReset: () => require('./friend-operation-limits').checkDailyReset(),
};

/** 与 checkDailyReset 同源的日界计算：dayKey(YYYY-MM-DD) + 下一日界时刻(ms)。 */
function dayInfo() {
  const china = deps.serverNow() + UTC_PLUS_8_OFFSET_MS;
  const dayKey = new Date(china).toISOString().slice(0, 10);
  const resumeAt = Math.floor(china / DAY_MS) * DAY_MS + DAY_MS - UTC_PLUS_8_OFFSET_MS;
  return { dayKey, resumeAt };
}

/** 账号文件名用稳定哈希：避免 a/b 与 a_b 的 sanitize 碰撞与目录穿越。 */
function stateFilePath(accountId) {
  const id = String(accountId || '');
  if (!id) return null;
  const hash = crypto.createHash('sha256').update(id).digest('hex').slice(0, 24);
  return path.join(deps.dataDir(), 'auto-bad-quota', `${hash}.json`);
}

function loadFromDisk(accountId) {
  const file = stateFilePath(accountId);
  if (!file) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    // 读回校验：版本/dayKey 格式/原因白名单/resumeAt 有限安全整数——
    // 旧日、损坏、Infinity、任意 reason 内容都当无闸门（不透传、不热循环）
    if (raw && raw.version === STATE_VERSION
      && DAY_KEY_RE.test(String(raw.dayKey))
      && REASONS.has(raw.reason)
      && Number.isSafeInteger(raw.resumeAt) && raw.resumeAt > 0) {
      return { dayKey: raw.dayKey, reason: raw.reason, resumeAt: raw.resumeAt };
    }
  } catch { /* 缺失/损坏：当无闸门（只保存真实观察，不推断） */ }
  return null;
}

function persistToDisk(accountId, state) {
  const file = stateFilePath(accountId);
  if (!file) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({
      version: STATE_VERSION,
      dayKey: state.dayKey,
      reason: state.reason,
      resumeAt: state.resumeAt,
    }), { mode: 0o600 });
    fs.renameSync(tmp, file); // 原子写
  } catch { /* 落盘失败不阻断暂停：内存闸门当日仍生效 */ }
}

/** 当前账号的闸门状态（懒加载磁盘；返回 null 表示当日无闸门）。 */
function getGate() {
  const accountId = deps.accountId();
  if (!accountId) return null;
  if (!loadedAccounts.has(accountId)) {
    loadedAccounts.set(accountId, loadFromDisk(accountId));
  }
  return loadedAccounts.get(accountId);
}

/** 闸门是否在效力中：dayKey 是今天且未到日界。旧日状态读到即忽略。 */
function activePause() {
  const gate = getGate();
  if (!gate) return null;
  const { dayKey } = dayInfo();
  if (gate.dayKey !== dayKey) return null; // 明日不沿用旧日闸门
  return gate;
}

/**
 * 恢复剩余毫秒（按服务器钟计算）：resumeAt 是服务器 epoch 边界，本机
 * 时钟可能有偏差——排本地 timer 必须用该 serverNow 差值，不得用
 * resumeAt - 本机 now。
 */
function resumeDelayMs() {
  const gate = activePause();
  if (!gate) return 0;
  return Math.max(0, gate.resumeAt - deps.serverNow());
}

/**
 * 记录当日暂停（幂等：已暂停返回 null，调用方据此只打一次日志）。
 * 只应由"真实观察到的额度耗尽"路径调用。
 */
function pause(reason) {
  const accountId = deps.accountId();
  if (!accountId) return null;
  if (activePause()) return null;
  const { dayKey, resumeAt } = dayInfo();
  const state = { dayKey, reason: String(reason || ''), resumeAt };
  loadedAccounts.set(accountId, state);
  persistToDisk(accountId, state);
  return state;
}

/**
 * 到日界后的恢复：调用现有 checkDailyReset（按游戏日清额度缓存），跨日即
 * 清闸门。返回 true 表示本次跨日清了闸门（调用方可感知恢复时刻）。
 */
function resumeIfNewDay() {
  const gate = getGate();
  if (!gate) return false;
  const { dayKey } = dayInfo();
  if (gate.dayKey === dayKey) return false;
  deps.checkDailyReset(); // 先让额度缓存按新游戏日更新，再读额度
  loadedAccounts.set(deps.accountId(), null);
  return true;
}

function resetForTests() {
  loadedAccounts.clear();
}

module.exports = {
  activePause,
  resumeDelayMs,
  pause,
  resumeIfNewDay,
  resetForTests,
  __depsForTests: deps,
  __stateFileForTests: accountId => stateFilePath(accountId),
};
