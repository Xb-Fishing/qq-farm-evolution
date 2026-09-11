/**
 * 好友施肥趋势状态机。
 *
 * NORMAL   无状态：只靠好友摘要/推送维护基线，不主动进门。
 * HOT      任一可信可疑信号直接触发；短时秒级追踪，只有新变化才能续热。
 * COOLDOWN 热追踪结束：停止进门，强证据可重新触发。
 * PREARM   自然成熟预布控：与化肥趋势隔离，只在成熟点进门一次。
 */

const { toNum, toTimeSec, getServerTimeSec, log } = require('../utils/utils');
const { gaussianInt } = require('../utils/behavior');
const { ripeDueAtMs } = require('./steal-schedule');

const WATCH_STATUS = Object.freeze({
  HOT: 'HOT',
  COOLDOWN: 'COOLDOWN',
  PREARM: 'PREARM',
});

const MAX_ACTIVE_WATCH = 6;
const JUMP_SLACK_MS = 25_000;
const SUMMARY_SHOCK_MS = 30 * 60 * 1000;
const LAND_JUMP_SLACK_SEC = 20;

// 重点监控好友：更敏感的趋势触发阈值。摘要提前阈值按次随机 1-5s
const PRIORITY_JUMP_SLACK_MIN_MS = 1_000;
const PRIORITY_JUMP_SLACK_MAX_MS = 5_000;
const PRIORITY_SUMMARY_SHOCK_MS = 10 * 60 * 1000;
const PRIORITY_LAND_JUMP_SLACK_SEC = 10;

// 触发后只对目标好友秒级追踪。连续 12 秒没有新变化即视为不再可疑，单次 HOT
// 最长 45 秒；持久 is_nudged=true 不会续热。
const HOT_FIRST_MIN_MS = 400;
const HOT_FIRST_MAX_MS = 800;
const HOT_RECHECK_MIN_MS = 700;
const HOT_RECHECK_MAX_MS = 1_200;
const HOT_IDLE_MS = 12_000;
const HOT_MAX_MS = 45_000;
const COOLDOWN_MS = 30_000;

// 自然成熟到点后保留 90 秒受控重试；成功进门即删除。这样预算瞬时拥塞不会让
// PREARM 5 秒后消失并退化成全好友 GetAll 重试。
const PREARM_GRACE_MS = 90_000;

// 盯梢进门的全局预算：最多 10 次/10 秒，且相邻至少 400ms。
// PREARM 到点可优先一次，但该次访问仍计入后续预算。
const GLOBAL_MIN_VISIT_GAP_MS = 400;
const GLOBAL_BUDGET_WINDOW_MS = 10_000;
const GLOBAL_BUDGET_VISITS = 10;

const watches = new Map();
const ripeSnapshots = new Map();
// gid -> Map<landId, snapshot>。LandsNotify 只带变化地块，必须增量合并。
const landSnapshots = new Map();
const landSnapshotNames = new Map();
const completeLandSnapshotGids = new Set();
const visitHistory = [];
// 重点监控好友 GID 集合（面板配置，由 friend-orchestrator 每次列表刷新时同步）
const priorityGids = new Set();

function setPriorityGids(gids) {
  priorityGids.clear();
  for (const gid of Array.isArray(gids) ? gids : []) {
    const id = toNum(gid);
    if (id) priorityGids.add(id);
  }
}

function isPriorityGid(gid) {
  return priorityGids.has(toNum(gid));
}

function randomBetween(min, max) {
  return gaussianInt(min, max);
}

function hotFirstDelayMs() {
  return randomBetween(HOT_FIRST_MIN_MS, HOT_FIRST_MAX_MS);
}

function hotRecheckDelayMs() {
  return randomBetween(HOT_RECHECK_MIN_MS, HOT_RECHECK_MAX_MS);
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
  return watch && watch.status !== WATCH_STATUS.COOLDOWN;
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

function startCooldown(watch, now, reason) {
  if (!watch) return;
  const wasHot = watch.status === WATCH_STATUS.HOT;
  watch.status = WATCH_STATUS.COOLDOWN;
  watch.nextVisitAt = 0;
  watch.cooldownUntil = now + COOLDOWN_MS;
  watch.transitionReason = reason || '';
  if (wasHot) {
    const priority = isPriorityGid(watch.gid);
    log('好友', `${priority ? '[重点] ' : ''}${watch.name} 施肥趋势停止，盯梢降频冷却`, {
      module: 'friend',
      event: '化肥盯梢冷却',
      friendGid: watch.gid,
      friendName: watch.name,
      reason: reason || '',
      ...(priority ? { priority: true } : {}),
    });
  }
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
  if (!options.force && existing && existing.status === WATCH_STATUS.HOT) {
    existing.name = displayNameFor(id, name || existing.name);
    existing.ripeAt = ripeAt;
    return false;
  }
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

function activateHot(gid, name, options = {}) {
  const id = toNum(gid);
  if (!id) return false;
  const now = Number(options.now) || Date.now();
  const reason = options.reason || 'strong_evidence';
  const advanceMs = Math.max(0, Number(options.advanceMs) || 0);
  const existing = watches.get(id);
  const resolvedName = displayNameFor(id, name || existing?.name);
  const ripeAt = Number(options.ripeAt) || Number(existing?.ripeAt) || 0;

  if (existing && existing.status === WATCH_STATUS.HOT) {
    existing.name = resolvedName;
    existing.ripeAt = ripeAt;
    existing.lastEvidenceAt = now;
    existing.evidenceCount = (Number(existing.evidenceCount) || 0) + 1;
    existing.hotUntil = Math.min(existing.hardUntil, now + HOT_IDLE_MS);
    existing.nextVisitAt = Math.min(
      Number(existing.nextVisitAt) || Number.POSITIVE_INFINITY,
      now + hotFirstDelayMs()
    );
    existing.transitionReason = reason;
    if (advanceMs > 0) existing.lastAdvanceMs = advanceMs;
    return false;
  }

  if (!existing || !isActiveWatch(existing)) ensureActiveCapacity();
  const hardUntil = now + HOT_MAX_MS;
  // 只有确认进入施肥 HOT 后才临时放宽进门/读地块门限。
  require('./request-governor').setWatchMode(true, hardUntil);
  watches.set(id, {
    gid: id,
    name: resolvedName,
    status: WATCH_STATUS.HOT,
    createdAt: existing?.createdAt || now,
    hotStartedAt: now,
    lastEvidenceAt: now,
    evidenceCount: (Number(existing?.evidenceCount) || 0) + 1,
    nextVisitAt: now + hotFirstDelayMs(),
    hotUntil: Math.min(hardUntil, now + HOT_IDLE_MS),
    hardUntil,
    ripeAt,
    lastVisitAt: Number(existing?.lastVisitAt) || 0,
    visitCount: 0,
    transitionReason: reason,
    lastAdvanceMs: advanceMs,
  });
  const priority = isPriorityGid(id);
  log('好友', `${priority ? '[重点] ' : ''}${resolvedName} 确认有施肥趋势，进入秒级盯梢`, {
    module: 'friend',
    event: '化肥趋势触发',
    friendGid: id,
    friendName: resolvedName,
    reason,
    advanceMs,
    ...(priority ? { priority: true } : {}),
  });
  return true;
}

function noteWeakSignal(gid, name, options = {}) {
  return activateHot(gid, name, {
    ...options,
    reason: `suspicious:${options.reason || 'weak_signal'}`,
  });
}

/** 兼容原调用入口：自然成熟必须显式 mode=prearm，其他直接调用视为强证据。 */
function watchFriend(gid, name, options = {}) {
  if (options.mode === 'prearm' || options.reason === 'ripe_prearm') {
    return armPreRipe(gid, name, options);
  }
  if (options.weak) return noteWeakSignal(gid, name, options);
  return activateHot(gid, name, options);
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

function nextGlobalPermitAt(now) {
  trimVisitHistory(now);
  let permitAt = now;
  if (visitHistory.length > 0) {
    permitAt = Math.max(permitAt, visitHistory[visitHistory.length - 1] + GLOBAL_MIN_VISIT_GAP_MS);
  }
  if (visitHistory.length >= GLOBAL_BUDGET_VISITS) {
    const budgetIndex = visitHistory.length - GLOBAL_BUDGET_VISITS;
    permitAt = Math.max(permitAt, visitHistory[budgetIndex] + GLOBAL_BUDGET_WINDOW_MS);
  }
  return permitAt;
}

function noteWatchVisit(gid, now = Date.now()) {
  const id = toNum(gid);
  const watch = watches.get(id);
  if (!watch) return;
  recordWatchVisit(now);
  watch.lastVisitAt = now;

  if (watch.status === WATCH_STATUS.PREARM) {
    watches.delete(id);
    return;
  }
  if (watch.status === WATCH_STATUS.HOT) {
    if (now >= Number(watch.hotUntil) || now >= Number(watch.hardUntil)) {
      startCooldown(watch, now, 'hot_window_elapsed');
      return;
    }
    watch.visitCount = (Number(watch.visitCount) || 0) + 1;
    watch.nextVisitAt = now + hotRecheckDelayMs();
  }
}

function advanceWatch(gid, watch, now) {
  if (watch.status === WATCH_STATUS.HOT &&
      (now >= Number(watch.hotUntil) || now >= Number(watch.hardUntil))) {
    const ripeAt = Number(watch.ripeAt) || 0;
    if (ripeAt > now && ripeAt <= now + PREARM_GRACE_MS * 2) {
      armPreRipe(gid, watch.name, { now, ripeAt, mode: 'prearm', force: true });
    } else {
      startCooldown(watch, now, 'no_new_fertilizer_change');
    }
  } else if (watch.status === WATCH_STATUS.COOLDOWN && now >= Number(watch.cooldownUntil)) {
    watches.delete(gid);
  } else if (watch.status === WATCH_STATUS.PREARM && now > Number(watch.hardUntil)) {
    watches.delete(gid);
  }
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

  // 成熟到点是一次性动作，优先于化肥确认预算。
  const prearm = dueEntries(now, WATCH_STATUS.PREARM);
  if (prearm.length > 0) return [watchTarget(prearm[0][0], prearm[0][1])];

  if (nextGlobalPermitAt(now) > now) return [];
  const hot = dueEntries(now, WATCH_STATUS.HOT);
  if (hot.length > 0) return [watchTarget(hot[0][0], hot[0][1])];
  return [];
}

function getNextWatchDueAt(now = Date.now()) {
  advanceWatches(now);
  let prearmAt = 0;
  let trendAt = 0;
  for (const watch of watches.values()) {
    const t = Number(watch.nextVisitAt) || 0;
    if (!t) continue;
    if (watch.status === WATCH_STATUS.PREARM) {
      prearmAt = prearmAt ? Math.min(prearmAt, t) : t;
    } else if (watch.status === WATCH_STATUS.HOT) {
      trendAt = trendAt ? Math.min(trendAt, t) : t;
    }
  }
  if (trendAt > 0) trendAt = Math.max(trendAt, nextGlobalPermitAt(now));
  if (prearmAt > 0 && trendAt > 0) return Math.min(prearmAt, trendAt);
  return prearmAt || trendAt;
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
    const jumped = !!prev && ripeJumpedEarly(
      prev.dueAt,
      effectiveDueAt,
      isPriorityGid(gid) ? randomBetween(PRIORITY_JUMP_SLACK_MIN_MS, PRIORITY_JUMP_SLACK_MAX_MS) : JUMP_SLACK_MS
    );
    const shockMs = isPriorityGid(gid) ? PRIORITY_SUMMARY_SHOCK_MS : SUMMARY_SHOCK_MS;
    const shock = jumped && advanceMs >= shockMs;
    ripeSnapshots.set(gid, {
      dueAt: effectiveDueAt,
      at: now,
      name,
      previousDueAt: Number(prev?.dueAt) || 0,
      advanceMs,
      shock,
      source: dueAt ? 'summary' : (prev?.source || 'unknown'),
    });
    if (!jumped) continue;
    activateHot(gid, name, {
      now,
      ripeAt: effectiveDueAt,
      advanceMs,
      reason: shock ? 'summary_ripe_shock_30m' : 'summary_ripe_advanced',
    });
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
  return {
    landId: toNum(land && land.id) || toNum(fallbackLandId),
    plantId: toNum(plant.id),
    firstBegin,
    matureAt,
    fertLeft: fertRaw == null ? null : toNum(fertRaw),
    nudged: !!(plant.is_nudged || plant.isNudged),
    growing: matureAt > serverSec,
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
  const strongReasons = new Set();
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
      if (prev.matureAt > 0 && snapshot.matureAt > 0 &&
          snapshot.matureAt < prev.matureAt - landJumpSlackSec) {
        strongReasons.add('land_ripe_advanced');
      }
      if (prev.fertLeft != null && snapshot.fertLeft != null && snapshot.fertLeft < prev.fertLeft) {
        strongReasons.add('fertilizer_count_decreased');
      }
      if (snapshot.nudged && !prev.nudged) strongReasons.add('nudged_rising');
    } else if (snapshot.nudged) {
      // 没有同一茬基线时仍直接短时 HOT；持久 true 不会产生新证据续热。
      weakReasons.add('nudged_without_baseline');
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
  if (strongReasons.size > 0) {
    activateHot(id, resolvedName, {
      now,
      ripeAt,
      reason: [...strongReasons].join(','),
    });
  } else if (weakReasons.size > 0) {
    noteWeakSignal(id, resolvedName, {
      now,
      ripeAt,
      reason: [...weakReasons].join(','),
    });
  }

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
function isFertilizerHot(gid, now = Date.now()) {
  const watch = watches.get(toNum(gid));
  return !!watch
    && watch.status === WATCH_STATUS.HOT
    && now < Number(watch.hotUntil)
    && now < Number(watch.hardUntil);
}

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

module.exports = {
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
