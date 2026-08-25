/**
 * 操作节奏：随机间隔、高斯抖动、顺序打乱。
 * ponytail: 只做节拍，不做指纹/协议伪装。
 */

function randInt(min, max) {
  const lo = Math.floor(Number(min) || 0);
  const hi = Math.max(lo, Math.floor(Number(max) || lo));
  if (hi === lo) return lo;
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}

/** Box-Muller，结果钳在 [min, max]，均值在中点 */
function gaussianInt(min, max) {
  const lo = Math.floor(Number(min) || 0);
  const hi = Math.max(lo, Math.floor(Number(max) || lo));
  if (hi === lo) return lo;
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  const mean = (lo + hi) / 2;
  const sigma = (hi - lo) / 6;
  const val = Math.round(mean + z * sigma);
  return Math.min(hi, Math.max(lo, val));
}

function shuffleInPlace(arr) {
  const list = Array.isArray(arr) ? arr : [];
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

function delayMsFromSeconds(sec, jitterRatio = 0.35) {
  const base = Math.max(0, Number(sec) || 0) * 1000;
  if (base <= 0) return 0;
  const spread = Math.max(80, Math.floor(base * jitterRatio));
  return gaussianInt(Math.max(0, base - spread), base + spread);
}

function humanPause(minMs, maxMs) {
  const delay = maxMs == null ? Math.max(0, Math.floor(minMs) || 0) : gaussianInt(minMs, maxMs);
  if (delay <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, delay));
}

function pauseSeconds(sec) {
  return humanPause(delayMsFromSeconds(sec));
}

/** 偶尔把下次间隔拉长，模拟放下手机。偷菜路径禁止调用。 */
function maybeStretchDelay(delayMs, chance = 0.05) {
  const base = Math.max(0, Math.floor(Number(delayMs) || 0));
  if (Math.random() >= chance) return base;
  return base + randInt(8000, 22000);
}

const IDLE_ACTIVE_MS = 30 * 60 * 1000;
const DEFAULT_MAX_SLEEP_MS = 2 * 3600 * 1000;
const MIN_SLEEP_MS = 60 * 1000;

/**
 * 成熟还早时随机歇着：最短约 1 分钟，最长 maxSleep（默认 2 小时），醒了还没菜就再歇。
 * 距成熟/可偷 ≤ activeMs 则不再长睡。偷菜路径禁止调用。
 * 完全空闲（无任何已知成熟/可偷时刻）也歇：土地推送、偷菜时刻表和重点监控
 * 各有独立唤醒通道，不受此歇息影响。
 */
function idleNapMs(nextEventMs, patrolMs, options = {}) {
  const patrol = Math.max(0, Math.floor(Number(patrolMs) || 0));
  const horizon = Math.max(0, Math.floor(Number(nextEventMs) || 0));
  const maxSleep = Math.max(MIN_SLEEP_MS, Math.floor(Number(options.maxSleepMs) || DEFAULT_MAX_SLEEP_MS));
  const active = Math.max(0, Math.floor(Number(options.activeMs) || IDLE_ACTIVE_MS));
  if (horizon <= 0) return randInt(MIN_SLEEP_MS, maxSleep);
  if (horizon <= active) return patrol;
  const room = horizon - active;
  const hi = Math.min(maxSleep, room);
  if (hi < MIN_SLEEP_MS) return patrol;
  return randInt(MIN_SLEEP_MS, hi);
}

let stealDueAt = 0;
let ownHarvestDueAt = 0;

function markStealDueAt(ts) {
  stealDueAt = Math.max(0, Number(ts) || 0);
}

function stealIsDue(now = Date.now()) {
  return stealDueAt > 0 && now >= stealDueAt;
}

function stealIsImminent(withinMs = 1500, now = Date.now()) {
  return stealDueAt > 0 && stealDueAt - now <= withinMs;
}

function getStealDueAt() {
  return stealDueAt;
}

/**
 * 偷菜 due 已过期却没被一轮成功巡查清掉（如 GetAll 被预算拦下）时的重试退避。
 * 第一次过期也至少退避约 1 秒，此后指数退避 + 抖动：
 * 统一 tick 的 100ms 地板 + 「过期 → nextStealRunAt=now」会打成 101ms 固定
 * 间隔的请求风暴（2026-08-24 14:38 实测 2 分钟 1226 次被拦 + 突发真请求）。
 */
const STEAL_OVERDUE_BASE_MS = 900;
const STEAL_OVERDUE_MAX_MS = 30 * 1000;

function stealOverdueBackoffMs(strikes) {
  const n = Math.max(0, Math.floor(Number(strikes) || 0));
  if (n <= 0) return randInt(STEAL_OVERDUE_BASE_MS, STEAL_OVERDUE_BASE_MS * 2);
  const base = Math.min(STEAL_OVERDUE_MAX_MS, STEAL_OVERDUE_BASE_MS * 2 ** Math.min(n, 6));
  return base + randInt(150, 850);
}

/** 自己作物的绝对成熟墙钟。只用于业务抢占，不绕过通信层安全闸门。 */
function markOwnHarvestDueAt(ts) {
  ownHarvestDueAt = Math.max(0, Number(ts) || 0);
}

function ownHarvestIsDue(now = Date.now()) {
  return ownHarvestDueAt > 0 && now >= ownHarvestDueAt;
}

function ownHarvestIsImminent(withinMs = 3000, now = Date.now()) {
  return ownHarvestDueAt > 0 && ownHarvestDueAt - now <= withinMs;
}

function getOwnHarvestDueAt() {
  return ownHarvestDueAt;
}

let idleQuietUntil = 0;

function markIdleQuietUntil(ts) {
  idleQuietUntil = Math.max(0, Number(ts) || 0);
}

function isIdleQuiet(now = Date.now()) {
  return idleQuietUntil > now;
}

module.exports = {
  randInt,
  gaussianInt,
  shuffleInPlace,
  delayMsFromSeconds,
  humanPause,
  pauseSeconds,
  maybeStretchDelay,
  idleNapMs,
  markStealDueAt,
  stealIsDue,
  stealIsImminent,
  getStealDueAt,
  stealOverdueBackoffMs,
  markOwnHarvestDueAt,
  ownHarvestIsDue,
  ownHarvestIsImminent,
  getOwnHarvestDueAt,
  markIdleQuietUntil,
  isIdleQuiet,
};
