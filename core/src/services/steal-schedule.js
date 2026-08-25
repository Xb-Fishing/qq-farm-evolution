/**
 * 根据好友摘要计算下一次偷菜时刻。
 * steal_plant_num > 0 → 已经可偷，在本轮成功进门确认前一直保持立即到期。
 * ripe_time_sec：倒计时秒，或服务器绝对时间戳。
 */

const { toNum, getServerTimeSec } = require('../utils/utils');

function plantNum(plant, snake, camel) {
  if (!plant) return 0;
  const raw = plant[snake] != null ? plant[snake] : plant[camel];
  return toNum(raw);
}

function ripeDueAtMs(ripeRaw, nowMs) {
  const n = toNum(ripeRaw);
  if (n <= 0) return 0;
  if (n > 1e12) return n;
  if (n > 1e9) {
    const remainSec = n - getServerTimeSec();
    return remainSec > 0 ? nowMs + remainSec * 1000 : nowMs;
  }
  return nowMs + n * 1000;
}

function computeNextStealDueAt(friends, options = {}) {
  const now = Number(options.now) || Date.now();
  const myGid = toNum(options.myGid);
  const blacklist = options.blacklist instanceof Set ? options.blacklist : new Set();
  let dueAt = 0;

  for (const friend of Array.isArray(friends) ? friends : []) {
    const gid = toNum(friend && friend.gid);
    if (!gid || gid === myGid || blacklist.has(gid)) continue;
    const plant = friend && friend.plant;
    if (!plant) continue;

    const stealNum = plantNum(plant, 'steal_plant_num', 'stealPlantNum');
    // 即使正在执行偷菜轮次也不能预先丢掉这个 due。
    // friend-orchestrator 会在成功进门后按 GID 更新/清理；进门失败则
    // 必须继续作为全局最小值进入有界短重试，不能跳到更晚的好友。
    if (stealNum > 0) {
      dueAt = dueAt ? Math.min(dueAt, now) : now;
    }

    const ripeAt = ripeDueAtMs(
      plant.ripe_time_sec != null ? plant.ripe_time_sec : plant.ripeTimeSec,
      now
    );
    if (ripeAt > 0) {
      dueAt = dueAt ? Math.min(dueAt, ripeAt) : ripeAt;
    }
  }

  const ownRipeAt = Number(options.ownRipeAtMs) || 0;
  if (ownRipeAt > 0) {
    dueAt = dueAt ? Math.min(dueAt, ownRipeAt) : ownRipeAt;
  }

  return dueAt;
}

function mergeDueAt(...times) {
  let dueAt = 0;
  for (const raw of times) {
    const t = Number(raw) || 0;
    if (t <= 0) continue;
    dueAt = dueAt ? Math.min(dueAt, t) : t;
  }
  return dueAt;
}

/**
 * 缓存成熟点只在到期后的短重试宽限内继续视为“待处理”。
 * 否则一次没能清掉的旧墙钟会永久把统一调度器维持在到期状态。
 */
function cachedDueWithinGrace(dueAt, now = Date.now(), graceMs = 90_000) {
  const due = Number(dueAt) || 0;
  const current = Number(now) || Date.now();
  const grace = Math.max(0, Number(graceMs) || 0);
  return due > 0 && due >= current - grace ? due : 0;
}

/** 成熟还早时先在 dueAt - wakeBefore 醒来刷列表；已经进入窗口则等到 dueAt 再偷。 */
function nextPreRipeScanAt(dueAt, now, wakeBeforeMs) {
  const due = Number(dueAt) || 0;
  const t = Number(now) || 0;
  const windowMs = Math.max(0, Number(wakeBeforeMs) || 0);
  if (due <= t) return due > 0 ? t : 0;
  if (windowMs <= 0 || due <= t + windowMs) return due;
  return due - windowMs;
}

module.exports = {
  computeNextStealDueAt,
  ripeDueAtMs,
  mergeDueAt,
  cachedDueWithinGrace,
  nextPreRipeScanAt,
};
