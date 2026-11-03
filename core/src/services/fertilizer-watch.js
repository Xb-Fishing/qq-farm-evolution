/**
 * Shared friend maturity cache and natural-deadline PREARM.
 * Priority online/push monitoring lives in friend-activity and friend-orchestrator.
 * Fertilizer-specific HOT inference and extra visits are retired.
 */

const { toNum, toTimeSec, getServerTimeSec, log } = require('../utils/utils');
const { ripeDueAtMs } = require('./steal-schedule');
const friendActivity = require('./friend-activity');

const WATCH_STATUS = Object.freeze({
  HOT: 'HOT',
  COOLDOWN: 'COOLDOWN',
  PREARM: 'PREARM',
});

const MAX_ACTIVE_WATCH = 6;
const JUMP_SLACK_MS = 25_000;
const LAND_JUMP_SLACK_SEC = 20;

// 重点监控好友：更敏感的趋势触发阈值。摘要提前阈值按次随机 1-5s
const PRIORITY_LAND_JUMP_SLACK_SEC = 10;

// 触发后对目标好友秒级追踪。趋势停止的确认门槛（2026-09-22 用户定标）：
// 连续 60 秒成熟时刻不再前移才算施肥结束——好友在线时常分多次施肥，
// 12 秒的窗口会把"施肥中"误判成"已停止"而提前降频丢菜。单次 HOT 硬上限
// 10 分钟（持续有新证据可续到上限）；持久 is_nudged=true 不会续热。

// 自然成熟到点后保留 90 秒受控重试；成功进门即删除。这样预算瞬时拥塞不会让
// PREARM 5 秒后消失并退化成全好友 GetAll 重试。
const PREARM_GRACE_MS = 90_000;

// 盯梢进门的全局预算：最多 10 次/10 秒，且相邻至少 400ms。
// PREARM 到点可优先一次，但该次访问仍计入后续预算。
const GLOBAL_BUDGET_WINDOW_MS = 10_000;

const watches = new Map();
const ripeSnapshots = new Map();
// gid -> 上次地块快照观察时刻（隐时钟 diff 的区间下界）。
const landObservedAt = new Map();
// gid -> Map<landId, snapshot>。LandsNotify 只带变化地块，必须增量合并。
const landSnapshots = new Map();
const landSnapshotNames = new Map();
const completeLandSnapshotGids = new Set();
const visitHistory = [];
// 重点监控好友 GID 集合（面板配置，由 friend-orchestrator 每次列表刷新时同步）
const priorityGids = new Set();

function setPriorityGids(gids) {
  priorityGids.clear();
  // 面板配置可能以数组或 Set 传入；其他输入（含字符串）视为空，不让整串被迭代成 ID。
  const list = Array.isArray(gids) || gids instanceof Set ? gids : [];
  for (const gid of list) {
    const id = toNum(gid);
    if (id) priorityGids.add(id);
  }
}

function isPriorityGid(gid) {
  return priorityGids.has(toNum(gid));
}

function ripeJumpedEarly(prevDueAt, nextDueAt, slackMs = JUMP_SLACK_MS) {
  const prev = Number(prevDueAt) || 0;
  const next = Number(nextDueAt) || 0;
  if (!prev || !next) return false;
  return next < prev - slackMs;
}

function displayNameFor(gid, name) {
  return name || watches.get(gid)?.name || ripeSnapshots.get(gid)?.name || `GID:${gid}`;
}

function isActiveWatch(watch) {
  return watch && watch.status === WATCH_STATUS.PREARM;
}

function activeWatchCount() {
  let count = 0;
  for (const watch of watches.values()) {
    if (isActiveWatch(watch)) count++;
  }
  return count;
}

function dropLowestPriorityWatch() {
  const priority = {
    [WATCH_STATUS.COOLDOWN]: 0,
    [WATCH_STATUS.HOT]: 2,
    [WATCH_STATUS.PREARM]: 3,
  };
  let candidateId = 0;
  let candidatePriority = Number.POSITIVE_INFINITY;
  let candidateAt = Number.POSITIVE_INFINITY;
  for (const [gid, watch] of watches) {
    const p = priority[watch.status] ?? 0;
    const at = Number(watch.lastEvidenceAt || watch.createdAt || 0);
    if (p < candidatePriority || (p === candidatePriority && at < candidateAt)) {
      candidateId = gid;
      candidatePriority = p;
      candidateAt = at;
    }
  }
  if (candidateId) watches.delete(candidateId);
}

function ensureActiveCapacity() {
  while (activeWatchCount() >= MAX_ACTIVE_WATCH) dropLowestPriorityWatch();
}



function armPreRipe(gid, name, options = {}) {
  const id = toNum(gid);
  const ripeAt = Number(options.ripeAt) || 0;
  if (!id || !ripeAt) return false;
  const now = Number(options.now) || Date.now();
  // 自然成熟点前后会出现并发抢收与阶段切换；只隔离这类预期失败，
  // 不放宽 Enter/AllLands 门限。门限放宽只属于确认施肥后的 HOT。
  require('./request-governor').setContentionMode(true, Math.max(now, ripeAt) + 60_000);
  const existing = watches.get(id);
  if (!existing || !isActiveWatch(existing)) ensureActiveCapacity();
  const isNewPrearm = !existing || existing.status !== WATCH_STATUS.PREARM;
  const resolvedName = displayNameFor(id, name);
  watches.set(id, {
    gid: id,
    name: resolvedName,
    status: WATCH_STATUS.PREARM,
    createdAt: now,
    nextVisitAt: Math.max(now, ripeAt),
    ripeAt,
    hardUntil: Math.max(now, ripeAt) + PREARM_GRACE_MS,
    lastVisitAt: 0,
    lastEvidenceAt: 0,
  });
  // 重点好友进入预布控打一条日志；重复 arm（每次列表刷新都会来）不重复打
  if (isNewPrearm && isPriorityGid(id)) {
    log('好友', `[重点] ${resolvedName} 距成熟约 ${Math.max(0, Math.round((ripeAt - now) / 60000))} 分钟，已提前布控`, {
      module: 'friend',
      event: '重点预布控',
      friendGid: id,
      friendName: resolvedName,
      ripeAt,
      priority: true,
    });
  }
  return true;
}





function watchFriend(gid, name, options = {}) {
  if (options.mode === 'prearm' || options.reason === 'ripe_prearm') return armPreRipe(gid, name, options);
  return false;
}

function updateArmedMaturity(gid, ripeAt, now) {
  const watch = watches.get(toNum(gid));
  if (!watch || watch.status !== WATCH_STATUS.PREARM || !(ripeAt > now)) return;
  // Server times have second precision; don't turn local subsecond rounding
  // into a fresh grace period. A changed future maturity replaces the deadline.
  if (Math.abs(Number(watch.ripeAt) - ripeAt) < 1000) return;
  watch.ripeAt = ripeAt;
  watch.nextVisitAt = ripeAt;
  watch.hardUntil = ripeAt + PREARM_GRACE_MS;
}

function unwatchFriend(gid) {
  const id = toNum(gid);
  if (id) watches.delete(id);
}

function trimVisitHistory(now) {
  const cutoff = now - GLOBAL_BUDGET_WINDOW_MS;
  while (visitHistory.length > 0 && visitHistory[0] <= cutoff) visitHistory.shift();
}

function recordWatchVisit(now) {
  trimVisitHistory(now);
  visitHistory.push(now);
}

function noteWatchVisit(gid, now = Date.now()) {
  const id = toNum(gid);
  const watch = watches.get(id);
  if (!watch) return;
  recordWatchVisit(now);
  watches.delete(id);
}

function advanceWatch(gid, watch, now) {
  // Drop pre-update fertilizer watches instead of resuming retired producers.
  if (watch.status !== WATCH_STATUS.PREARM || now > Number(watch.hardUntil)) watches.delete(gid);
}

function advanceWatches(now) {
  for (const [gid, watch] of [...watches]) advanceWatch(gid, watch, now);
}

function dueEntries(now, status) {
  return [...watches.entries()]
    .filter(([, watch]) => watch.status === status && Number(watch.nextVisitAt) <= now)
    .sort((a, b) => Number(a[1].nextVisitAt) - Number(b[1].nextVisitAt));
}

function watchTarget(gid, watch) {
  return {
    gid,
    name: watch.name,
    stealNum: 0,
    watch: true,
    watchStatus: watch.status,
    level: 0,
  };
}

function getDueWatchFriends(now = Date.now()) {
  advanceWatches(now);
  const prearm = dueEntries(now, WATCH_STATUS.PREARM);
  return prearm.length ? [watchTarget(prearm[0][0], prearm[0][1])] : [];
}

function getNextWatchDueAt(now = Date.now()) {
  advanceWatches(now);
  let dueAt = 0;
  for (const watch of watches.values()) {
    const at = Number(watch.nextVisitAt) || 0;
    if (watch.status === WATCH_STATUS.PREARM && at) dueAt = dueAt ? Math.min(dueAt, at) : at;
  }
  return dueAt;
}

function noteFriendSummaries(friends, options = {}) {
  const now = Number(options.now) || Date.now();
  const myGid = toNum(options.myGid);
  const blacklist = options.blacklist instanceof Set ? options.blacklist : new Set();

  for (const friend of Array.isArray(friends) ? friends : []) {
    const gid = toNum(friend && friend.gid);
    if (!gid || gid === myGid || blacklist.has(gid)) continue;
    const plant = friend.plant;
    const dueAt = plant
      ? ripeDueAtMs(plant.ripe_time_sec != null ? plant.ripe_time_sec : plant.ripeTimeSec, now)
      : 0;
    const prev = ripeSnapshots.get(gid);
    const name = friend.remark || friend.name || prev?.name || `GID:${gid}`;
    // wx 普通好友摘要经常把 ripe_time_sec 省略/置 0。一次“看不到”不能
    // 覆盖之前从实际地块 phases 读到的精确墙钟，否则面板会在用户打开好友
    // 详情前后跳来跳去，偷菜调度也会退化成错误的长时间占位。
    const effectiveDueAt = dueAt || Number(prev?.dueAt) || 0;
    const advanceMs = prev && prev.dueAt && effectiveDueAt
      ? Math.max(0, Number(prev.dueAt) - Number(effectiveDueAt))
      : 0;
    const shock = false;
    ripeSnapshots.set(gid, {
      dueAt: effectiveDueAt,
      at: now,
      name,
      previousDueAt: Number(prev?.dueAt) || 0,
      advanceMs,
      shock,
      source: dueAt ? 'summary' : (prev?.source || 'unknown'),
    });
    updateArmedMaturity(gid, effectiveDueAt, now);

  }
}

function plantSnapshot(land, serverSec, fallbackLandId) {
  const plant = land && land.plant;
  if (!plant || !Array.isArray(plant.phases) || plant.phases.length === 0) return null;
  const phases = plant.phases;
  const first = phases[0];
  const last = phases[phases.length - 1];
  const firstBegin = toTimeSec(first && (first.begin_time != null ? first.begin_time : first.beginTime));
  const matureAt = toTimeSec(last && (last.begin_time != null ? last.begin_time : last.beginTime));
  const fertRaw = plant.left_inorc_fert_times != null
    ? plant.left_inorc_fert_times
    : plant.leftInorcFertTimes;
  // 隐时钟字段（2026-09-22 好友活跃证据）：dry_time/insect_time 挂在当前
  // 阶段 PlantPhaseInfo 上，是未来的变干/生虫时刻（秒），只有主人浇水/
  // 除虫才会重置后移。phases 末项即当前阶段。
  const dryAtSec = toNum(last && (last.dry_time != null ? last.dry_time : last.dryTime));
  const insectAtSec = toNum(last && (last.insect_time != null ? last.insect_time : last.insectTime));
  return {
    landId: toNum(land && land.id) || toNum(fallbackLandId),
    plantId: toNum(plant.id),
    firstBegin,
    matureAt,
    fertLeft: fertRaw == null ? null : toNum(fertRaw),
    nudged: !!(plant.is_nudged || plant.isNudged),
    growing: matureAt > serverSec,
    dryAtMs: dryAtSec > 0 ? dryAtSec * 1000 : 0,
    insectAtMs: insectAtSec > 0 ? insectAtSec * 1000 : 0,
  };
}

function sameCrop(prev, next, slackSec = LAND_JUMP_SLACK_SEC) {
  if (!prev || !next || prev.plantId !== next.plantId) return false;
  if (!prev.matureAt || !next.matureAt) return true;
  // phases 会裁剪；施肥使成熟终点提前，同种重种使终点移到上一茬之后。
  return next.matureAt <= prev.matureAt + slackSec;
}

/** 检查好友地块。options.partial=true 表示 LandsNotify 增量，不算一次实际进门。 */
function inspectFriendLands(gid, name, lands, now = Date.now(), options = {}) {
  const id = toNum(gid);
  if (!id) return { ripeAt: 0, growing: false };
  const server = getServerTimeSec();
  const partial = !!options.partial;
  const previous = landSnapshots.get(id) || new Map();
  const next = partial ? new Map(previous) : new Map();
  if (!partial) completeLandSnapshotGids.add(id);
  const weakReasons = new Set();
  const landJumpSlackSec = isPriorityGid(id) ? PRIORITY_LAND_JUMP_SLACK_SEC : LAND_JUMP_SLACK_SEC;

  (Array.isArray(lands) ? lands : []).forEach((land, index) => {
    const explicitLandId = toNum(land && land.id);
    const landId = explicitLandId || -(index + 1);
    const snapshot = plantSnapshot(land, server, landId);
    const prev = previous.get(landId);
    if (!snapshot) {
      next.delete(landId);
      return;
    }

    if (sameCrop(prev, snapshot, landJumpSlackSec)) {
      // 状态隐时钟（2026-09-22 好友活跃证据）：同一茬内倒计时显著后移 =
      // 主人在两次观察之间浇过水/除过虫。同一茬才可比（换茬会重置）。
      if (prev.dryAtMs > 0 && snapshot.dryAtMs > prev.dryAtMs + 5 * 60_000) {
        weakReasons.add('owner_watered_recently');
      }
      if (prev.insectAtMs > 0 && snapshot.insectAtMs > prev.insectAtMs + 5 * 60_000) {
        weakReasons.add('owner_derugged_recently');
      }
    }
    next.set(landId, snapshot);
  });
  landSnapshots.set(id, next);

  let earliestMature = 0;
  let growing = false;
  for (const snapshot of next.values()) {
    if (!snapshot.growing) continue;
    growing = true;
    earliestMature = earliestMature
      ? Math.min(earliestMature, snapshot.matureAt)
      : snapshot.matureAt;
  }

  const resolvedName = displayNameFor(id, name);
  landSnapshotNames.set(id, resolvedName);
  const ripeAt = earliestMature > 0
    ? now + Math.max(0, earliestMature - server) * 1000
    : 0;
  const previousRipe = ripeSnapshots.get(id);
  if (ripeAt > 0 || previousRipe) {
    ripeSnapshots.set(id, {
      ...(previousRipe || {}),
      dueAt: ripeAt,
      at: now,
      name: resolvedName,
      source: 'lands',
    });
  }
  updateArmedMaturity(id, ripeAt, now);
  // 好友活跃证据（2026-09-22，零成本搭车）：
  // 1. 社交道具：地块上非我放置且最近 30 分钟内的社交道具 → 操作者活跃。
  // 2. 隐时钟：weakReasons 里的 owner_watered/derugged → 主人刚动过。
  // 证据不触发 HOT（不是施肥证据），只进 friend-activity 记录。
  try {
    friendActivity.noteSocialItems(lands, options.myGid, now);
  } catch { /* 证据记录失败不影响主流程 */ }
  if (weakReasons.has('owner_watered_recently') || weakReasons.has('owner_derugged_recently')) {
    try {
      const prevObservedAt = landObservedAt.get(id) || now - 60_000;
      friendActivity.recordActivity(id, prevObservedAt, 'implicit_clock',
        [...weakReasons].filter(reason => reason.startsWith('owner_')).join(','));
    } catch { /* 同上 */ }
  }
  landObservedAt.set(id, now);

  // 只有完整基线（或其增量合并）才能证明全场没有作物。
  if (!growing && completeLandSnapshotGids.has(id)) {
    unwatchFriend(id);
    return { ripeAt: 0, growing: false };
  }

  const watch = watches.get(id);
  if (watch) {
    watch.name = resolvedName || watch.name;
    if (ripeAt > 0) watch.ripeAt = ripeAt;
    // 推送只提供证据，不消耗一次“进门确认”也不推迟 nextVisitAt。
    if (!partial) noteWatchVisit(id, now);
  }
  return { ripeAt, growing };
}

/**
 * 返回已有进门/地块推送快照中最早的好友成熟墙钟。
 *
 * wx 好友摘要可能不带 ripe_time_sec，但 Bot 为帮忙、偷菜、捣乱或收到
 * LandsNotify 时已经读到了每块地的 phases。这里只复用已有快照，不发新请求。
 */
function getNextKnownFriendRipeEntry(now = Date.now(), options = {}) {
  const current = Number(now) || Date.now();
  const server = getServerTimeSec();
  const graceMs = Math.max(0, Number(options.graceMs) || PREARM_GRACE_MS);
  const myGid = toNum(options.myGid);
  const blacklist = options.blacklist instanceof Set ? options.blacklist : new Set();
  let nearest = null;

  for (const [gid, snapshots] of landSnapshots.entries()) {
    if (!gid || gid === myGid || blacklist.has(gid)) continue;
    for (const snapshot of snapshots.values()) {
      // 快照创建时已成熟/死亡的地块不是新的成熟时钟。只保留
      // “当时还在生长”的墙钟：它到点后可进入宽限重试，下次成功
      // 进门会刷新 growing=false，避免已偷过的成熟地块反复 PREARM。
      if (!snapshot || snapshot.growing !== true) continue;
      const matureAt = Number(snapshot && snapshot.matureAt) || 0;
      if (matureAt <= 0) continue;
      const ripeAt = current + (matureAt - server) * 1000;
      if (ripeAt < current - graceMs) continue;
      if (!nearest || ripeAt < nearest.ripeAt) {
        nearest = {
          gid,
          name: landSnapshotNames.get(gid) || `GID:${gid}`,
          ripeAt,
        };
      }
    }
  }
  return nearest;
}

function getWatchStateForTests(gid, now = Date.now()) {
  advanceWatches(now);
  const watch = watches.get(toNum(gid));
  return watch ? { ...watch } : null;
}

/** 当前是否仍处于确认施肥后的 HOT；普通重点巡检与自然成熟 PREARM 均返回 false。 */
function isFertilizerHot() { return false; }

function getMaturityCacheForTests(gid) {
  const snapshot = ripeSnapshots.get(toNum(gid));
  return snapshot ? { ...snapshot } : null;
}

function getFriendRipeSnapshot(gid, now = Date.now()) {
  const snapshot = ripeSnapshots.get(toNum(gid));
  if (!snapshot || !snapshot.dueAt || snapshot.dueAt < now - PREARM_GRACE_MS) return null;
  return { ...snapshot };
}

function getFriendRipeSnapshots(now = Date.now()) {
  return [...ripeSnapshots.entries()]
    .map(([gid]) => {
      const snapshot = getFriendRipeSnapshot(gid, now);
      return snapshot ? { gid, ...snapshot } : null;
    })
    .filter(Boolean);
}

function resetFertilizerWatchForTests() {
  watches.clear();
  ripeSnapshots.clear();
  landSnapshots.clear();
  landSnapshotNames.clear();
  completeLandSnapshotGids.clear();
  visitHistory.length = 0;
  priorityGids.clear();
}

function retireFertilizerWatchMode() { require('./request-governor').setWatchMode(false); }

module.exports = {
  retireFertilizerWatchMode,
  WATCH_STATUS,
  ripeJumpedEarly,
  watchFriend,
  unwatchFriend,
  noteWatchVisit,
  getDueWatchFriends,
  getNextWatchDueAt,
  noteFriendSummaries,
  inspectFriendLands,
  getNextKnownFriendRipeEntry,
  setPriorityGids,
  isPriorityGid,
  isFertilizerHot,
  getWatchStateForTests,
  getMaturityCacheForTests,
  getFriendRipeSnapshot,
  getFriendRipeSnapshots,
  resetFertilizerWatchForTests,
};

// Persistent-session data capsule. No handles, functions or in-flight work.
if (globalThis.process?.env?.FARM_SESSION_BUSINESS === '1') {
  const { registerDataState, restoreContainer } = require('./business-state');
  registerDataState('services/fertilizer-watch.js', () => ({ watches, ripeSnapshots, landObservedAt, landSnapshots, landSnapshotNames, completeLandSnapshotGids, visitHistory, priorityGids }), value => {
      restoreContainer(watches, value.watches);
      for (const [gid, watch] of watches) if (watch.status !== WATCH_STATUS.PREARM) watches.delete(gid);
      restoreContainer(ripeSnapshots, value.ripeSnapshots);
      restoreContainer(landObservedAt, value.landObservedAt);
      restoreContainer(landSnapshots, value.landSnapshots);
      restoreContainer(landSnapshotNames, value.landSnapshotNames);
      restoreContainer(completeLandSnapshotGids, value.completeLandSnapshotGids);
      restoreContainer(visitHistory, value.visitHistory);
      restoreContainer(priorityGids, value.priorityGids);
  }, { });
}
