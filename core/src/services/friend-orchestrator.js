const { CONFIG } = require('../config/config');
const {
  isAutomationOn,
  getFriendBlacklist,
  getWatchlistFriendGids,
  getAutoAcceptFriendMinLevel,
  getKnownFriendGids,
  applyConfigSnapshot,
  getFriendBadRetryDate,
  readFriendDogInfoCache,
  getPauseRemainMs,
  getFriendQuietHours,
} = require('../models/store');
const { getUserState, isConnected, networkEvents } = require('../utils/network');
const { toNum, log, logWarn, randomDelay } = require('../utils/utils');
const {
  computeNextStealDueAt,
  mergeDueAt,
  ripeDueAtMs,
  cachedDueWithinGrace,
} = require('./steal-schedule');
const {
  noteFriendSummaries,
  getDueWatchFriends,
  getNextWatchDueAt,
  unwatchFriend,
  watchFriend,
  setPriorityGids,
  isPriorityGid,
  isFertilizerHot,
  getNextKnownFriendRipeEntry,
} = require('./fertilizer-watch');
const { getBreakerState } = require('./request-governor');
const {
  stealIsDue,
  stealIsImminent,
  markStealDueAt,
  ownHarvestIsDue,
  ownHarvestIsImminent,
  gaussianInt,
} = require('../utils/behavior');
const { setOperationLimitsCallback } = require('./farm');
const { createScheduler } = require('./scheduler');
const {
  getAllFriends,
  extractReplyFriends,
  inFriendQuietHours,
  postToMaster,
  normalizeFriendGids,
  acceptFriends,
  getApplications,
  clearAllInvalidKnownFriendGidCooldown,
} = require('./friend-api');
const {
  checkDailyReset,
  canOperate,
  canOperateBad,
  getCanGetHelpExp,
  getHelpAutoDisabledByLimit,
  updateOperationLimits,
} = require('./friend-operation-limits');
const {
  visitFriend,
  visitFriendForSteal,
  visitFriendForHelp,
} = require('./friend-visit');
const { sellAllFruits } = require('./warehouse');
const {
  getFriendsList,
  fetchFriendsDogInfo,
  setFriendsListCache,
} = require('./friend-land-analyzer');

// ===== State =====
let isCheckingFriends = false;
let friendLoopRunning = false;
let externalSchedulerMode = false;
const friendScheduler = createScheduler('friend');
let badExecutedOnStartup = false;
let consecutiveBadFailureCount = 0;
let dogInfoBootstrapAttempted = false;
let dogInfoBootstrapReadyAt = 0;
// 上一轮好友摘要看到的最近成熟时刻（Date.now 基准）。化肥状态机的
// nextVisitAt 动态合并，不能写进这个基线，否则快路径访问后会残留过期 due。
let nextFriendStealDueAtMs = 0;
// 单个好友维度保存摘要成熟点；成功进门后只清该好友，避免一个旧的全局最小值
// 在目标已经处理后继续把面板和统一调度器卡在“到期”。
const friendSummaryDueByGid = new Map();
// worker.js 注入的唤醒重排回调（重点巡田读到新成熟时刻时调用）
let armStealWakeForWorker = () => { };
// 重点监控好友的最近成熟时刻（不含自己收获），用于 worker 把窗口提前到 122 分钟
let nextWatchlistStealDueAtMs = 0;
// 重点监控可见性：配置变化才报一次；每个好友每茬进入 122 分钟窗口报一次
let lastWatchlistKey = '';
const watchlistWindowAnnounced = new Map();
// 重点好友主动巡田：wx 等平台摘要没有 ripe_time_sec，必须进门读地块才有精确成熟时刻
const watchlistPollNextAt = new Map();
const watchlistPollRipeAt = new Map();
const watchlistNames = new Map();
let watchlistPollLoopArmed = false;
const WATCHLIST_POLL_TICK_MS = 3_000;
// 普通重点巡田只负责更新成熟墙钟/施肥基线，不关心对方日常收菜和重种。
// 未知或无作物保持 5-8 分钟；已知进入 122 分钟观察范围收紧到 45-75 秒。
// 真正发现施肥趋势后由 fertilizer-watch 独立切换到秒级 HOT。
const WATCHLIST_POLL_IDLE_MIN_MS = 5 * 60_000;
const WATCHLIST_POLL_IDLE_MAX_MS = 8 * 60_000;
const WATCHLIST_POLL_WINDOW_MIN_MS = 45_000;
const WATCHLIST_POLL_WINDOW_MAX_MS = 75_000;
let lastRipeRefreshAt = 0;
const RIPE_REFRESH_MIN_MS = 30_000;
// 自己成熟前给收获请求预留通道，新的好友扫描/进门不得占用这段窗口。
const OWN_HARVEST_RESERVE_MS = 10_000;

const BAD_FAILURE_LIMIT = 3;
// 成熟前多久开始布控（到点走快路径抢收）
const DUE_PREARM_MS = 10_000;
// 重点监控好友提前更久布控
const DUE_PREARM_WATCHLIST_MS = 60_000;
// 成熟后保留短时直接抢收重试；超过宽限的旧墙钟不再永久占住调度器。
const STEAL_OVERDUE_GRACE_MS = 90_000;
// 化肥一次最多催熟约 2 小时：重点监控好友在成熟前进入低频观察范围。
// 窗口分钟数可按账号配置（friendQuietHours.watchlistWakeBeforeMinutes，默认 122）
const DEFAULT_WATCHLIST_WAKE_BEFORE_MINUTES = 122;
const WATCHLIST_WAKE_BEFORE_MS = DEFAULT_WATCHLIST_WAKE_BEFORE_MINUTES * 60 * 1000;

/** 重点监控好友当前生效的低频观察范围毫秒数（面板可配，默认 122 分钟） */
function getWatchlistWakeBeforeMs() {
  const minutes = Number((getFriendQuietHours() || {}).watchlistWakeBeforeMinutes) || 0;
  return (minutes > 0 ? Math.min(360, minutes) : DEFAULT_WATCHLIST_WAKE_BEFORE_MINUTES) * 60 * 1000;
}

function nextWatchlistPollDelayMs(remainMs, options = {}) {
  const remain = Number(remainMs) || 0;
  const wakeBeforeMs = Math.max(
    DUE_PREARM_WATCHLIST_MS,
    Number(options.wakeBeforeMs) || getWatchlistWakeBeforeMs()
  );
  const randomDelay = typeof options.randomDelay === 'function'
    ? options.randomDelay
    : gaussianInt;
  if (remain <= 0) {
    return randomDelay(WATCHLIST_POLL_IDLE_MIN_MS, WATCHLIST_POLL_IDLE_MAX_MS);
  }
  if (remain > wakeBeforeMs) {
    // 不能让窗口外已经挂好的 5-8 分钟定时器睡过观察窗口入口。
    return Math.max(
      WATCHLIST_POLL_TICK_MS,
      Math.min(
        randomDelay(WATCHLIST_POLL_IDLE_MIN_MS, WATCHLIST_POLL_IDLE_MAX_MS),
        remain - wakeBeforeMs
      )
    );
  }
  if (remain <= DUE_PREARM_WATCHLIST_MS) {
    // PREARM 已独立按成熟墙钟触发，无需继续进门确认日常状态。
    return randomDelay(WATCHLIST_POLL_WINDOW_MIN_MS, WATCHLIST_POLL_WINDOW_MAX_MS);
  }
  // 不错过成熟前 60 秒的 PREARM 武装点；其余时间保持单目标抖动基线刷新。
  return Math.max(
    WATCHLIST_POLL_TICK_MS,
    Math.min(
      randomDelay(WATCHLIST_POLL_WINDOW_MIN_MS, WATCHLIST_POLL_WINDOW_MAX_MS),
      remain - DUE_PREARM_WATCHLIST_MS
    )
  );
}

function isWatchlistObservationWindow(remainMs) {
  const remain = Number(remainMs) || 0;
  return remain > 0 && remain <= getWatchlistWakeBeforeMs();
}

function recomputeFriendSummaryClocks(now = Date.now()) {
  const watchlistSet = new Set(getWatchlistFriendGids(process.env.FARM_ACCOUNT_ID || '').map(toNum));
  let allMin = 0;
  let watchlistMin = 0;
  for (const [gid, dueAt] of [...friendSummaryDueByGid.entries()]) {
    const activeDue = cachedDueWithinGrace(dueAt, now, STEAL_OVERDUE_GRACE_MS);
    if (!activeDue) {
      friendSummaryDueByGid.delete(gid);
      continue;
    }
    allMin = allMin ? Math.min(allMin, activeDue) : activeDue;
    if (watchlistSet.has(gid)) {
      watchlistMin = watchlistMin ? Math.min(watchlistMin, activeDue) : activeDue;
    }
  }
  nextFriendStealDueAtMs = allMin;
  nextWatchlistStealDueAtMs = watchlistMin;
}

function applyStealVisitResult(gid, result, visitedAt = Date.now()) {
  const id = toNum(gid);
  if (!id || !result || !result.entered) return;

  const ripeAt = Number(result.ripeAtMs) || 0;
  if (result.retryNeeded === true) {
    // 已进门但 Harvest 失败：建立一个当前到期点交给短退避链继续抢，
    // 不删除 PREARM/重点好友缓存；90s 总宽限仍负责最终收敛。
    friendSummaryDueByGid.set(id, visitedAt);
    recomputeFriendSummaryClocks(visitedAt);
    return;
  }
  if (ripeAt > visitedAt) friendSummaryDueByGid.set(id, ripeAt);
  else friendSummaryDueByGid.delete(id);
  recomputeFriendSummaryClocks(visitedAt);

  const configured = getWatchlistFriendGids(process.env.FARM_ACCOUNT_ID || '')
    .some((configuredGid) => toNum(configuredGid) === id);
  if (!configured && !watchlistPollRipeAt.has(id)) return;
  if (ripeAt > visitedAt) {
    watchlistPollRipeAt.set(id, ripeAt);
    watchlistPollNextAt.set(id, visitedAt + nextWatchlistPollDelayMs(ripeAt - visitedAt));
  } else {
    // 成熟后已进门确认：无论成功偷到还是已经被别人抢走，都清掉旧成熟墙钟。
    watchlistPollRipeAt.delete(id);
    watchlistWindowAnnounced.delete(id);
    watchlistPollNextAt.set(id, visitedAt + nextWatchlistPollDelayMs(0));
  }
}

// ===== Helpers =====

function isTransientNetworkError(err) {
  const msg = String((err && err.message) || '');
  if (!msg) return false;
  return [
    '连接未打开',
    '请求超时',
    '请求已中断',
    '连接关闭',
    '发送失败',
    '请求队列已满',
  ].some(kw => msg.includes(kw));
}

function clearFriendsListCache() {
  setFriendsListCache(null);
}

async function bootstrapFriendDogInfoCacheIfNeeded() {
  if (dogInfoBootstrapAttempted) return;
  if (Date.now() < dogInfoBootstrapReadyAt) return;

  const accountId = process.env.FARM_ACCOUNT_ID || '';
  if (!accountId) return;
  if (!isAutomationOn('friend') || !isConnected()) return;

  const dogInfoCache = readFriendDogInfoCache(accountId);
  if (dogInfoCache && Object.keys(dogInfoCache).length > 0) return;

  dogInfoBootstrapAttempted = true;
  try {
    log('好友', '护主犬缓存为空，上号稳定后自动获取一次好友狗信息', {
      module: 'friend',
      event: '自动获取好友狗信息',
      source: 'friend_loop_bootstrap',
    });
    await fetchFriendsDogInfo();
  } catch (err) {
    logWarn('好友', `自动获取好友狗信息失败: ${err.message}`);
  }
}

function syncAutomationPatchToMaster(patch) {
  postToMaster({
    type: 'automation_patch',
    patch,
  });
}

function resetBadFailureCount() {
  consecutiveBadFailureCount = 0;
}

function getLocalDateKey(offsetDays = 0) {
  const date = new Date();
  date.setDate(date.getDate() + offsetDays);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function pauseFriendBadUntilTomorrow(reason) {
  const accountId = process.env.FARM_ACCOUNT_ID || '';
  const retryDate = getLocalDateKey(1);
  applyConfigSnapshot(
    { friendBadRetryDate: retryDate },
    { accountId }
  );
  syncAutomationPatchToMaster({ friendBadRetryDate: retryDate });
  resetBadFailureCount();
  log('好友', `捣乱连续失败 ${BAD_FAILURE_LIMIT} 次，已暂停至 ${retryDate} 再尝试。最后错误: ${reason || '未知'}`, {
    module: 'friend',
    event: '自动暂停捣乱',
    result: 'paused',
    failureCount: BAD_FAILURE_LIMIT,
    retryDate,
    reason,
  });
}

function isFriendBadPaused() {
  const accountId = process.env.FARM_ACCOUNT_ID || '';
  const retryDate = getFriendBadRetryDate(accountId);
  if (!retryDate) return false;
  if (getLocalDateKey() < retryDate) return true;

  applyConfigSnapshot({ friendBadRetryDate: '' }, { accountId });
  syncAutomationPatchToMaster({ friendBadRetryDate: '' });
  resetBadFailureCount();
  return false;
}

function recordBadFailure(reason, context = {}) {
  consecutiveBadFailureCount += 1;
  log('好友', `捣乱失败 ${consecutiveBadFailureCount}/${BAD_FAILURE_LIMIT}: ${reason || '未知错误'}`, {
    module: 'friend',
    event: '捣乱失败计数',
    result: 'error',
    failureCount: consecutiveBadFailureCount,
    failureLimit: BAD_FAILURE_LIMIT,
    reason,
    ...context,
  });

  if (consecutiveBadFailureCount >= BAD_FAILURE_LIMIT) {
    pauseFriendBadUntilTomorrow(reason);
    return true;
  }

  return false;
}

function isIgnorableBadFailureMessage(message) {
  const text = String(message || '');
  if (!text) return true;
  return [
    '??',
    'No target',
    '?????',
    '1001046',
    'used up',
    'no target',
    '没有可捣乱土地',
    '捣乱失败或今日次数已用完',
    '今日次数已用完',
    '次数已用完',
    '已经放过',
    '来晚一步',
  ].some(kw => text.includes(kw));
}

function trackBadVisitResult(result, target, context = {}) {
  const count = Number(
    result && (
      result.count
      || (Number(result.bugCount || 0) + Number(result.weedCount || 0))
    ) || 0
  );
  if (count > 0) {
    resetBadFailureCount();
    return false;
  }

  const message = String(result && result.message || '').trim();
  if (isIgnorableBadFailureMessage(message)) return false;

  return recordBadFailure(message, {
    friendName: target && target.name,
    friendGid: target && target.gid,
    ...context,
  });
}

// ===== Main friend check routine =====

/**
 * Main friend check routine: visits friends to steal, help, and/or put weeds/bugs.
 * Called by the loop or triggered externally.
 */
async function checkFriends(options = {}) {
  const userState = getUserState();
  if (!isAutomationOn('friend') || !isConnected()) return false;

  const onlyHelp = options.onlyHelp || false;
  const onlySteal = options.onlySteal || false;
  const onlyBad = options.onlyBad || false;
  const ignoreExpLimit = options.ignoreExpLimit || false;

  if (ownHarvestIsDue() || ownHarvestIsImminent(OWN_HARVEST_RESERVE_MS)) return false;
  await bootstrapFriendDogInfoCacheIfNeeded();

  const accountId = process.env.FARM_ACCOUNT_ID || '';
  const helpEnabled = !!isAutomationOn('friend_help');
  const stealEnabled = !!isAutomationOn('friend_steal');
  const badEnabled = !!isAutomationOn('friend_bad');

  const doHelp = onlyHelp ? true : (onlySteal || onlyBad ? false : helpEnabled);
  const doSteal = onlySteal ? true : (onlyHelp || onlyBad ? false : stealEnabled);
  const doBad = onlyBad ? true : (onlyHelp || onlySteal ? false : badEnabled);

  const shouldRun = doHelp || doSteal || doBad;

  if (isCheckingFriends || !userState.gid || !shouldRun) return false;
  // 静默时段不再挡偷菜；帮助/捣乱在时段内直接歇着
  if (inFriendQuietHours() && !doSteal) return false;

  isCheckingFriends = true;
  checkDailyReset();

  try {
    // 抢收快路径：有到点的盯梢目标（临近成熟/催熟）→ 跳过好友列表刷新直接进门，
    // 省掉一次全量 getAllFriends 往返，抢的是这几百毫秒
    if (onlySteal) {
      const fastBlacklist = new Set(getFriendBlacklist(accountId));
      const dueWatches = getDueWatchFriends().filter((w) =>
        w.gid && w.gid !== userState.gid && !fastBlacklist.has(w.gid)
      );
      if (dueWatches.length > 0 && canOperate(0x2714)) {
        const tally = { steal: 0, water: 0, weed: 0, bug: 0, putBug: 0, putWeed: 0 };
        for (const target of dueWatches) {
          if (!canOperate(0x2714) || ownHarvestIsImminent(OWN_HARVEST_RESERVE_MS)) break;
          let result = null;
          try {
            result = await visitFriendForSteal(target, tally, userState.gid, accountId);
          } catch { }
          applyStealVisitResult(target.gid, result);
          if (ownHarvestIsImminent(OWN_HARVEST_RESERVE_MS)) break;
          await randomDelay(40, 120);
        }
        if (tally.steal > 0) {
          try { await sellAllFruits(); } catch { }
          log('好友', `抢收快路径 → 偷${tally.steal}`, {
            module: 'friend',
            event: '好友巡查循环',
            result: 'ok',
            visited: dueWatches.length,
            summary: [`偷${tally.steal}`],
          });
        }
        return true;
      }
    }

    const allFriendsReply = await getAllFriends();
    const rawFriends = extractReplyFriends(allFriendsReply);

    if (rawFriends.length === 0) {
      log('好友', '没有好友', {
        module: 'friend',
        event: '好友扫描',
        result: 'empty',
      });
      return false;
    }

    const blacklist = new Set(getFriendBlacklist(accountId));
    const watchlistSet = new Set(getWatchlistFriendGids(accountId));
    const dogInfoCache = readFriendDogInfoCache(accountId);
    const guardDogGidSet = dogInfoCache
      ? new Set(Object.keys(dogInfoCache).map(Number))
      : new Set();
    const expLimitEnabled = !!isAutomationOn('friend_help_exp_limit');
    const helpExpReached = expLimitEnabled && !getCanGetHelpExp();

    // ---- Build target lists ----
    const stealTargets = [];
    const helpTargets = [];
    const visitedGids = new Set();

    applyStealScheduleFromFriends(rawFriends, {
      myGid: userState.gid,
      blacklist,
    });
    const currentStealDueAt = getNextStealDueAtMs();
    if (doHelp && !doSteal && currentStealDueAt > 0 && currentStealDueAt <= Date.now()) {
      return true;
    }

    // Steal targets: friends with stealable crops
    if (doSteal) {
      for (const friend of rawFriends) {
        const gid = toNum(friend.gid);
        if (gid === userState.gid) continue;
        if (visitedGids.has(gid)) continue;
        if (blacklist.has(gid)) continue;

        const name = friend.remark || friend.name || `GID:${gid}`;
        const plant = friend.plant;
        const stealNum = plant ? toNum(plant.steal_plant_num) : 0;
        const level = toNum(friend.level);

        if (stealNum > 0) {
          stealTargets.push({ gid, name, stealNum, level });
        }
        visitedGids.add(gid);
      }
      const stealGids = new Set(stealTargets.map(item => item.gid));
      for (const watch of getDueWatchFriends()) {
        if (!watch.gid || watch.gid === userState.gid) continue;
        if (blacklist.has(watch.gid)) {
          unwatchFriend(watch.gid);
          continue;
        }
        if (stealGids.has(watch.gid)) continue;
        stealTargets.push(watch);
        stealGids.add(watch.gid);
      }
    }

    // Help targets
    // 帮助经验到上限后完全不再进门帮忙（含护主犬），只保留好友列表刷新，降频防封
    if (doHelp && (!helpExpReached || ignoreExpLimit)) {
      for (const friend of rawFriends) {
        const gid = toNum(friend.gid);
        if (gid === userState.gid) continue;
        if (blacklist.has(gid)) continue;

        const name = friend.remark || friend.name || `GID:${gid}`;
        const plant = friend.plant;
        const dryNum = plant ? toNum(plant.dry_num) : 0;
        const weedNum = plant ? toNum(plant.weed_num) : 0;
        const insectNum = plant ? toNum(plant.insect_num) : 0;

        if (dryNum > 0 || weedNum > 0 || insectNum > 0) {
          const dogId = toNum(friend.dogId);
          const hasGuardDog = guardDogGidSet.has(gid) || dogId === 90021;
          helpTargets.push({
            gid,
            name,
            dryNum,
            weedNum,
            insectNum,
            dogId,
            hasGuardDog,
          });
        }
      }
    }

    // Sort: 重点监控好友最前，然后非盯梢目标，同级按等级降序
    stealTargets.sort((a, b) => {
      const aPriority = watchlistSet.has(a.gid);
      const bPriority = watchlistSet.has(b.gid);
      if (aPriority !== bPriority) return aPriority ? -1 : 1;
      if (!!a.watch !== !!b.watch) return a.watch ? 1 : -1;
      return b.level - a.level;
    });
    helpTargets.sort((a, b) => {
      if (a.hasGuardDog !== b.hasGuardDog) return a.hasGuardDog ? -1 : 1;
      const aTotal = a.dryNum + a.weedNum + a.insectNum;
      const bTotal = b.dryNum + b.weedNum + b.insectNum;
      return bTotal - aTotal;
    });

    // ---- Execute ----
    const tally = { steal: 0, water: 0, weed: 0, bug: 0, putBug: 0, putWeed: 0 };

    // Steal — 好友之间只留极短间隔，不走种植那种长延迟
    if (stealTargets.length > 0 && doSteal) {
      // 好友摘要有时只给“当前可偷”，不给 ripe_time_sec。此时不会经过 PREARM，
      // 但批量 Harvest 失败后逐地回退仍是成熟竞速的正常状态竞争，先补一段短窗口，
      // 避免这些预期失败累计进异常降速阈值；请求预算和进门预算保持不变。
      require('./request-governor').setContentionMode(true, Date.now() + 60_000);
      for (const target of stealTargets) {
        if (!canOperate(0x2714) || ownHarvestIsImminent(OWN_HARVEST_RESERVE_MS)) break; // 10004 = steal
        let result = null;
        try {
          result = await visitFriendForSteal(target, tally, userState.gid, userState.accountId);
        } catch {
          // Skip individual failures
        }
        applyStealVisitResult(target.gid, result);
        if (ownHarvestIsImminent(OWN_HARVEST_RESERVE_MS)) break;
        await randomDelay(target.watch ? 400 : 40, target.watch ? 900 : 120);
      }
    }

    // Auto-sell after stealing
    if (tally.steal > 0) {
      try {
        await sellAllFruits();
      } catch {
        // Ignore sell errors
      }
    }

    // Help
    if (helpTargets.length > 0 && doHelp) {
      for (const target of helpTargets) {
        if (stealIsDue() || ownHarvestIsImminent(OWN_HARVEST_RESERVE_MS)) break;
        try {
          const result = await visitFriendForHelp(
            target, tally, userState.gid, userState.accountId,
            ignoreExpLimit, helpExpReached
          );
          applyStealVisitResult(target.gid, result);
        } catch {
          // Skip individual failures
        }
        if (stealIsDue() || ownHarvestIsImminent(OWN_HARVEST_RESERVE_MS)) break;
        await randomDelay(
          helpExpReached ? 300 : 500,
          helpExpReached ? 700 : 1000
        );
      }
    }

    // Bad (put weeds/insects)
    if (doBad && !isFriendBadPaused()) {
      log('好友', '开始自动放虫放草', {
        module: 'friend',
        event: '开始自动放虫放草',
      });

      const badCandidates = [];
      const badVisited = new Set();

      for (const friend of rawFriends) {
        const gid = toNum(friend.gid);
        if (gid === userState.gid) continue;
        if (badVisited.has(gid)) continue;
        if (blacklist.has(gid)) continue;

        const name = friend.remark || friend.name || `GID:${gid}`;
        const plant = friend.plant;
        const stealNum = plant ? toNum(plant.steal_plant_num) : 0;
        const dryNum = plant ? toNum(plant.dry_num) : 0;
        const weedNum = plant ? toNum(plant.weed_num) : 0;
        const insectNum = plant ? toNum(plant.insect_num) : 0;

        // Target friends with empty farms (no crops, no issues)
        if (stealNum === 0 && dryNum === 0 && weedNum === 0 && insectNum === 0) {
          const level = toNum(friend.level);
          badCandidates.push({ gid, name, level });
        }
        badVisited.add(gid);
      }

      badCandidates.sort((a, b) => b.level - a.level);

      const topCount = Math.min(20, badCandidates.length);
      const topTargets = badCandidates.slice(0, topCount);

      if (topTargets.length > 0) {
        log('好友',
          `找到 ${badCandidates.length} 个可捣乱的好友，处理等级最高的前${topTargets.length}个`,
          {
            module: 'friend',
            event: '放虫放草好友列表',
            totalCount: badCandidates.length,
            topCount: topTargets.length,
          }
        );

        for (let i = 0; i < topTargets.length; i++) {
          const target = topTargets[i];
          if (!canOperateBad()) {
            log('好友', '放虫放草次数已用完，停止执行', {
              module: 'friend',
              event: '放虫放草次数用完',
            });
            break;
          }

          try {
            const result = await visitFriend(target, tally, userState.gid, userState.accountId);
            applyStealVisitResult(target.gid, result);
            if (trackBadVisitResult(result, target, { source: 'friend_check' })) {
              break;
            }
          } catch (err) {
            if (recordBadFailure(err && err.message, {
              friendName: target.name,
              friendGid: target.gid,
              source: 'friend_check',
            })) {
              break;
            }
          }
          if (stealIsDue() || ownHarvestIsImminent(OWN_HARVEST_RESERVE_MS)) break;
          await randomDelay(500, 1500);
        }
      }
    }

    // ---- Summary ----
    const summary = [];
    if (tally.steal > 0) summary.push(`偷${tally.steal}`);
    if (tally.weed > 0) summary.push(`除草${tally.weed}`);
    if (tally.bug > 0) summary.push(`除虫${tally.bug}`);
    if (tally.water > 0) summary.push(`浇水${tally.water}`);
    if (tally.putBug > 0) summary.push(`放虫${tally.putBug}`);
    if (tally.putWeed > 0) summary.push(`放草${tally.putWeed}`);

    const visited = stealTargets.length + helpTargets.length;
    if (summary.length > 0) {
      log('好友', `巡查完成 → ${summary.join('/')}`, {
        module: 'friend',
        event: '好友巡查循环',
        result: 'ok',
        visited,
        summary,
      });
    }

    return summary.length > 0;
  } catch (err) {
    if (!isTransientNetworkError(err)) {
      logWarn('好友', `巡查异常: ${err.message}`);
    }
    return false;
  } finally {
    isCheckingFriends = false;
  }
}

// ===== Friend check loop =====

async function friendCheckLoop() {
  if (externalSchedulerMode) return;
  if (!friendLoopRunning) return;

  if (ownHarvestIsImminent(OWN_HARVEST_RESERVE_MS)) {
    friendScheduler.setTimeoutTask('friend_check_loop', OWN_HARVEST_RESERVE_MS, () => friendCheckLoop());
    return;
  }

  await bootstrapFriendDogInfoCacheIfNeeded();

  await checkFriends();

  if (!friendLoopRunning) return;

  const interval = Math.max(30000, CONFIG.friendCheckInterval);
  friendScheduler.setTimeoutTask('friend_check_loop', interval, () => friendCheckLoop());
}

function startFriendCheckLoop(opts = {}) {
  if (friendLoopRunning) return;

  externalSchedulerMode = !!opts.externalScheduler;
  friendLoopRunning = true;
  dogInfoBootstrapAttempted = false;
  dogInfoBootstrapReadyAt = Date.now() + (2 * 60 * 1000);

  // Sync operation limits callback
  setOperationLimitsCallback(updateOperationLimits);

  // Listen for friend application events
  networkEvents.on('friendApplicationReceived', onFriendApplicationReceived);

  if (!externalSchedulerMode) {
    // Start after a 2-minute delay
    const initialDelay = 2 * 60 * 1000;
    log('好友', '好友巡查循环将在 2 分钟后启动', {
      module: 'friend',
      event: '好友巡查延迟启动',
      delayMs: initialDelay,
    });
    friendScheduler.setTimeoutTask('friend_check_loop', initialDelay, () => friendCheckLoop());
  }

  // Bootstrap: periodically check for pending applications
  friendScheduler.setTimeoutTask(
    'friend_check_bootstrap_applications',
    30 * 1000,
    () => checkAndAcceptApplications()
  );
}

function stopFriendCheckLoop() {
  friendLoopRunning = false;
  externalSchedulerMode = false;
  dogInfoBootstrapAttempted = false;
  dogInfoBootstrapReadyAt = 0;
  watchlistPollLoopArmed = false;
  watchlistPollNextAt.clear();
  clearAllInvalidKnownFriendGidCooldown();
  networkEvents.off('friendApplicationReceived', onFriendApplicationReceived);
  friendScheduler.clearAll();
}

function refreshFriendCheckLoop(delayMs = 0) {
  if (!friendLoopRunning || externalSchedulerMode) return;
  friendScheduler.setTimeoutTask(
    'friend_check_loop',
    Math.max(0, delayMs),
    () => friendCheckLoop()
  );
}

// ===== Friend application handling =====

function onFriendApplicationReceived(applications) {
  const names = applications
    .map(app => app.name || `GID:${toNum(app.gid)}`)
    .join(', ');
  log('申请', `收到 ${applications.length} 个好友申请: ${names}`);

  for (const app of applications) {
    log('申请',
      `申请详情: name=${app.name}, gid=${toNum(app.gid)}, level=${app.level}, levelType=${typeof app.level}`
    );
  }

  const minLevel = getAutoAcceptFriendMinLevel();
  let toAccept = applications;

  if (minLevel > 0) {
    toAccept = applications.filter(app => {
      const level = toNum(app.level) || 0;
      const name = app.name || `GID:${toNum(app.gid)}`;
      log('申请', `${name} 等级: ${level}, 最低要求: ${minLevel}级`);
      if (level >= minLevel) return true;
      log('申请', `${name} 等级 ${level} < ${minLevel}，跳过`);
      return false;
    });
  }

  if (toAccept.length === 0) return;

  const gids = toAccept.map(app => toNum(app.gid));
  acceptFriendsWithRetry(gids);
}

async function checkAndAcceptApplications() {
  try {
    const reply = await getApplications();
    const apps = reply.applications || [];
    if (apps.length === 0) return;

    const names = apps
      .map(app => app.name || `GID:${toNum(app.gid)}`)
      .join(', ');
    log('申请', `发现 ${apps.length} 个待处理申请: ${names}`);

    const minLevel = getAutoAcceptFriendMinLevel();
    let toAccept = apps;

    if (minLevel > 0) {
      toAccept = apps.filter(app => {
        const level = toNum(app.level) || 0;
        const name = app.name || `GID:${toNum(app.gid)}`;
        log('申请', `${name} 等级: ${level}, 最低要求: ${minLevel}级`);
        if (level >= minLevel) return true;
        log('申请', `${name} 等级 ${level} < ${minLevel}，跳过`);
        return false;
      });
    }

    if (toAccept.length === 0) return;

    const gids = toAccept.map(app => toNum(app.gid));
    await acceptFriendsWithRetry(gids);
  } catch {
    // Ignore application check errors
  }
}

async function acceptFriendsWithRetry(gids) {
  if (gids.length === 0) return;

  try {
    const reply = await acceptFriends(gids);
    const friends = reply.friends || [];

    if (friends.length > 0) {
      const names = friends
        .map(f => f.name || f.remark || `GID:${toNum(f.gid)}`)
        .join(', ');
      log('申请', `已同意 ${friends.length} 人: ${names}`);

      // Sync accepted GIDs to known friends list
      const newGids = friends
        .map(f => toNum(f.gid))
        .filter(g => g > 0);

      if (newGids.length > 0) {
        const currentGids = normalizeFriendGids(getKnownFriendGids());
        const mergedGids = normalizeFriendGids([...currentGids, ...newGids]);

        if (mergedGids.length !== currentGids.length) {
          const accountId = process.env.FARM_ACCOUNT_ID || '';
          applyConfigSnapshot(
            { knownFriendGids: mergedGids },
            { persist: false, accountId }
          );

          const synced = postToMaster({
            type: 'known_friend_gids_sync',
            gids: mergedGids,
          });

          if (!synced) {
            applyConfigSnapshot(
              { knownFriendGids: mergedGids },
              { persist: true, accountId }
            );
          }

          log('申请', `已将 ${newGids.length} 人加入好友列表`, {
            module: 'friend',
            event: '好友加入列表',
            result: 'ok',
          });
        }

        // Refresh friends list cache
        clearFriendsListCache();
        try {
          await getFriendsList(true);
          log('申请', '已刷新好友列表', {
            module: 'friend',
            event: '刷新好友列表',
            result: 'ok',
          });
        } catch (err) {
          logWarn('申请', `刷新好友列表失败: ${err.message}`);
        }
      }
    }
  } catch (err) {
    logWarn('申请', `同意失败: ${err.message}`);
  }
}

// ===== Bad on startup =====

/**
 * Run a one-time "bad" operation on startup to put weeds/insects on friends' farms.
 */
async function runBadOnceOnStartup(force = false) {
  if (!force && badExecutedOnStartup) return;

  const badEnabled = isAutomationOn('friend_bad');
  if (!badEnabled) return;
  if (isFriendBadPaused()) return;

  const userState = getUserState();
  if (!userState.gid) {
    log('好友', '用户未登录，无法执行放虫放草', {
      module: 'friend',
      event: '放虫放草未登录',
    });
    return;
  }

  const accountId = process.env.FARM_ACCOUNT_ID || '';
  const label = force ? '开启自动捣乱后立即执行' : '启动时放虫放草';

  log('好友', `========== ${label}开始 ==========`, {
    module: 'friend',
    event: `${label}开始`,
  });

  try {
    const allFriendsReply = await getAllFriends();
    const rawFriends = extractReplyFriends(allFriendsReply);

    if (rawFriends.length === 0) {
      log('好友', '没有好友，放虫放草结束', {
        module: 'friend',
        event: '没有游戏好友',
      });
      return;
    }

    const blacklist = new Set(getFriendBlacklist(accountId));
    const badCandidates = [];
    const badVisited = new Set();

    for (const friend of rawFriends) {
      const gid = toNum(friend.gid);
      if (gid === userState.gid) continue;
      if (badVisited.has(gid)) continue;
      if (blacklist.has(gid)) continue;

      const name = friend.remark || friend.name || `GID:${gid}`;
      const plant = friend.plant;
      const stealNum = plant ? toNum(plant.steal_plant_num) : 0;
      const dryNum = plant ? toNum(plant.dry_num) : 0;
      const weedNum = plant ? toNum(plant.weed_num) : 0;
      const insectNum = plant ? toNum(plant.insect_num) : 0;

      if (stealNum === 0 && dryNum === 0 && weedNum === 0 && insectNum === 0) {
        const level = toNum(friend.level);
        badCandidates.push({ gid, name, level });
      }
      badVisited.add(gid);
    }

    badCandidates.sort((a, b) => b.level - a.level);

    const topCount = Math.min(20, badCandidates.length);
    const topTargets = badCandidates.slice(0, topCount);

    log('好友',
      `找到 ${badCandidates.length} 个可捣乱的好友，处理等级最高的前${topTargets.length}个`,
      {
        module: 'friend',
        event: '放虫放草好友列表',
        totalCount: badCandidates.length,
        topCount: topTargets.length,
      }
    );

    const tally = { steal: 0, water: 0, weed: 0, bug: 0, putBug: 0, putWeed: 0 };
    let processedCount = 0;

    for (let i = 0; i < topTargets.length; i++) {
      const target = topTargets[i];
      if (!canOperateBad()) {
        log('好友', `放虫放草次数已用完，停止执行。已处理 ${processedCount} 个好友`, {
          module: 'friend',
          event: '放虫放草次数用完',
          processedCount,
        });
        break;
      }

      log('好友',
        `${label} ${i + 1}/${topTargets.length}: ${target.name} (等级${target.level})`,
        {
          module: 'friend',
          event: '放虫放草处理好友',
          index: i + 1,
          total: topTargets.length,
          friendName: target.name,
          level: target.level,
        }
      );

      try {
        const result = await visitFriend(target, tally, userState.gid, accountId);
        applyStealVisitResult(target.gid, result);
        processedCount++;
        if (trackBadVisitResult(result, target, { source: 'startup_bad' })) {
          break;
        }
      } catch (err) {
        log('好友', `放虫放草失败: ${target.name}, 错误: ${err.message}`, {
          module: 'friend',
          event: '放虫放草失败',
          friendName: target.name,
          error: err.message,
        });
        if (recordBadFailure(err && err.message, {
          friendName: target.name,
          friendGid: target.gid,
          source: 'startup_bad',
        })) {
          break;
        }
      }
      await randomDelay(500, 1500);
    }

    badExecutedOnStartup = true;

    const summary = [];
    if (tally.putBug > 0) summary.push(`放虫${tally.putBug}`);
    if (tally.putWeed > 0) summary.push(`放草${tally.putWeed}`);

    log('好友',
      `========== ${label}结束 ========== 处理${processedCount}人${ 
        summary.length > 0 ? ` → ${summary.join('/')}` : ''}`,
      {
        module: 'friend',
        event: `${label}结束`,
        processedCount,
        summary,
      }
    );
  } catch (err) {
    if (!isTransientNetworkError(err)) {
      logWarn('好友', `${label}异常: ${err.message}`);
    }
  }
}

// ===== Status queries =====

function isHelpExpLimitReached() {
  return getHelpAutoDisabledByLimit();
}

function isCheckingFriendsRunning() {
  return isCheckingFriends;
}

// ===== Sync friends from external GID list =====

async function syncFriendsFromGids(gids) {
  const newGids = normalizeFriendGids(gids);
  if (newGids.length === 0) return [];

  const currentGids = normalizeFriendGids(getKnownFriendGids());
  const mergedGids = normalizeFriendGids([...currentGids, ...newGids]);

  if (mergedGids.length !== currentGids.length) {
    const accountId = process.env.FARM_ACCOUNT_ID || '';
    applyConfigSnapshot(
      { knownFriendGids: mergedGids },
      { persist: false, accountId }
    );

    const synced = postToMaster({
      type: 'known_friend_gids_sync',
      gids: mergedGids,
    });

    if (!synced) {
      applyConfigSnapshot(
        { knownFriendGids: mergedGids },
        { persist: true, accountId }
      );
    }

    log('好友',
      `批量添加 ${newGids.length} 个好友GID，当前共 ${mergedGids.length} 个`,
      {
        module: 'friend',
        event: '批量添加好友GID',
        result: 'ok',
        addedCount: newGids.length,
        totalKnownGids: mergedGids.length,
      }
    );
  }

  clearFriendsListCache();
  return await getFriendsList(true);
}

async function refreshFriendRipeSchedule(options = {}) {
  const force = !!options.force;
  const now = Date.now();
  if (isCheckingFriends) return false;
  if (!force && lastRipeRefreshAt && now - lastRipeRefreshAt < RIPE_REFRESH_MIN_MS) return false;
  if (!isAutomationOn('friend') || !isConnected()) return false;
  if (ownHarvestIsDue(now) || ownHarvestIsImminent(OWN_HARVEST_RESERVE_MS, now)) return false;
  const userState = getUserState();
  if (!userState.gid) return false;

  isCheckingFriends = true;
  try {
    const allFriendsReply = await getAllFriends();
    const rawFriends = extractReplyFriends(allFriendsReply);
    lastRipeRefreshAt = Date.now();
    if (!rawFriends.length) return false;
    const accountId = process.env.FARM_ACCOUNT_ID || '';
    applyStealScheduleFromFriends(rawFriends, {
      myGid: userState.gid,
      blacklist: new Set(getFriendBlacklist(accountId)),
    });
    return true;
  } catch (err) {
    if (!isTransientNetworkError(err)) {
      logWarn('好友', `刷新成熟时刻失败: ${err.message}`);
    }
    return false;
  } finally {
    isCheckingFriends = false;
  }
}

function formatWatchlistRemain(ms) {
  const min = Math.max(1, Math.round(ms / 60000));
  if (min < 60) return `${min}分钟`;
  return `${Math.round((min / 60) * 10) / 10}小时`;
}

function watchlistFriendStatus(friend, now) {
  const plant = friend && friend.plant;
  if (!plant) return '无作物信息';
  const stealNum = toNum(plant.steal_plant_num != null ? plant.steal_plant_num : plant.stealPlantNum);
  if (stealNum > 0) return '现在可偷';
  const dueAt = ripeDueAtMs(plant.ripe_time_sec != null ? plant.ripe_time_sec : plant.ripeTimeSec, now);
  if (!dueAt) return '暂无成熟时刻';
  return `约${formatWatchlistRemain(dueAt - now)}后成熟`;
}

/**
 * 重点监控可见性日志：配置生效报一次；重点好友进入 122 分钟盯梢窗口每茬报一次。
 */
function announceWatchlist(rawFriends, watchlistSet, { now, myGid, blacklist }) {
  const key = [...watchlistSet].map(Number).filter(Boolean).sort((a, b) => a - b).join(',');
  if (key !== lastWatchlistKey) {
    lastWatchlistKey = key;
    watchlistWindowAnnounced.clear();
    if (watchlistSet.size > 0) {
      const items = [];
      for (const gid of watchlistSet) {
        const f = (Array.isArray(rawFriends) ? rawFriends : [])
          .find(item => toNum(item && item.gid) === gid);
        const name = f ? (f.remark || f.name || `GID:${gid}`) : `GID:${gid}`;
        items.push(`${name}（${f && !blacklist.has(gid) ? watchlistFriendStatus(f, now) : '不在好友列表/已屏蔽'}）`);
      }
      log('好友', `重点监控已生效：${items.join('、')}`, {
        module: 'friend',
        event: '重点监控',
        gids: [...watchlistSet],
      });
    }
  }

  if (watchlistSet.size === 0) return;
  for (const friend of Array.isArray(rawFriends) ? rawFriends : []) {
    const gid = toNum(friend && friend.gid);
    if (!gid || gid === myGid || blacklist.has(gid) || !watchlistSet.has(gid)) continue;
    const plant = friend.plant;
    const dueAt = plant
      ? ripeDueAtMs(plant.ripe_time_sec != null ? plant.ripe_time_sec : plant.ripeTimeSec, now)
      : 0;
    const announced = watchlistWindowAnnounced.get(gid);
    if (dueAt > now && dueAt - now <= getWatchlistWakeBeforeMs()) {
      // 同一茬只报一次；成熟时刻明显变化（催熟/新一茬）重新报
      if (!announced || Math.abs(announced - dueAt) > 60_000) {
        watchlistWindowAnnounced.set(gid, dueAt);
        const name = friend.remark || friend.name || `GID:${gid}`;
        log('好友', `[重点] ${name} 距成熟约 ${formatWatchlistRemain(dueAt - now)}，进入低频观察窗口`, {
          module: 'friend',
          event: '重点低频观察窗口',
          friendGid: gid,
          friendName: name,
          dueAt,
        });
      }
    } else if (announced) {
      // 摘要没有成熟时刻 ≠ 作物没了（wx 摘要根本不带 ripe_time_sec）；
      // 只有摘要明确给出窗口外时刻、且巡田也没在跟踪时才清除，下一茬才会重新报
      if (dueAt > 0 && !watchlistPollRipeAt.has(gid)) {
        watchlistWindowAnnounced.delete(gid);
      }
    }
  }
}

/**
 * 重点监控好友主动巡田：wx 等平台的好友摘要不带 ripe_time_sec，
 * 只有进门读地块才有精确成熟时刻与施肥证据（fertLeft/nudged/matureAt）。
 * 节奏：>122 分钟、未知或无作物 5-8min 一次；≤122 分钟 45-75s 一次；
 * ≤60s 交给 PREARM 到点抢收。只有确认施肥趋势才由 HOT 秒级追踪。
 * 只对重点好友生效，次数远低于帮助巡查的全列表频率。
 */
function ensureWatchlistPollLoop() {
  if (watchlistPollLoopArmed) return;
  watchlistPollLoopArmed = true;
  friendScheduler.setTimeoutTask('watchlist_poll', WATCHLIST_POLL_TICK_MS, () => watchlistPollTick());
}

async function watchlistPollTick() {
  if (!watchlistPollLoopArmed) return;
  try {
    const accountId = process.env.FARM_ACCOUNT_ID || '';
    const gids = getWatchlistFriendGids(accountId);
    const userState = getUserState();
    if (gids.length === 0 || !userState.gid || !isConnected() || !isAutomationOn('friend_steal')) {
      friendScheduler.setTimeoutTask('watchlist_poll', 30_000, () => watchlistPollTick());
      return;
    }
    // 免打扰期间不巡田
    if (getPauseRemainMs(accountId) > 0) {
      friendScheduler.setTimeoutTask('watchlist_poll', 30_000, () => watchlistPollTick());
      return;
    }
    // 不跟抢收/全量巡查抢通道
    if (isCheckingFriends || stealIsDue() || stealIsImminent(1200)
        || ownHarvestIsImminent(OWN_HARVEST_RESERVE_MS)) {
      friendScheduler.setTimeoutTask('watchlist_poll', WATCHLIST_POLL_TICK_MS, () => watchlistPollTick());
      return;
    }
    const now = Date.now();
    const slowdown = getBreakerState(now);
    const blacklist = new Set(getFriendBlacklist(accountId));
    for (const gid of gids) {
      if (ownHarvestIsImminent(OWN_HARVEST_RESERVE_MS)) break;
      if (gid === userState.gid || blacklist.has(gid)) continue;
      if ((watchlistPollNextAt.get(gid) || 0) > now) continue;
      // 异常期只放慢普通重点巡检，不再等一个长冷却窗口结束。
      // 已确认的施肥 HOT 仍保持原有秒级节奏。
      const knownRipeAt = Number(watchlistPollRipeAt.get(gid)) || 0;
      const inObservationWindow = isWatchlistObservationWindow(knownRipeAt - now);
      if (slowdown.active && !isFertilizerHot(gid, now) && !inObservationWindow) {
        const baselineDelay = nextWatchlistPollDelayMs(knownRipeAt - now);
        const floorMs = Math.max(30_000, Number(slowdown.recommendedDelayMs) || 90_000);
        watchlistPollNextAt.set(
          gid,
          now + baselineDelay + gaussianInt(floorMs, Math.floor(floorMs * 1.5))
        );
        continue;
      }
      const name = watchlistNames.get(gid) || `GID:${gid}`;
      const tally = { steal: 0, water: 0, weed: 0, bug: 0, putBug: 0, putWeed: 0 };
      let result = null;
      try {
        result = await visitFriendForSteal({ gid, name }, tally, userState.gid, accountId);
      } catch { }
      if (tally.steal > 0) {
        try { await sellAllFruits(); } catch { }
      }
      const visitedAt = Date.now();
      if (result && result.entered) {
        const ripeAt = Number(result.ripeAtMs) || 0;
        if (ripeAt > visitedAt) {
          watchlistPollRipeAt.set(gid, ripeAt);
          // 新读到的成熟时刻立即并进偷菜唤醒，不等下一轮巡查
          armStealWakeForWorker();
          const remainMs = ripeAt - visitedAt;
          // 进入 122 分钟窗口报一次（摘要没有成熟时刻时，这是唯一的窗口日志来源）
          if (remainMs <= getWatchlistWakeBeforeMs()) {
            const announced = watchlistWindowAnnounced.get(gid);
            if (!announced || Math.abs(announced - ripeAt) > 60_000) {
              watchlistWindowAnnounced.set(gid, ripeAt);
              log('好友', `[重点] ${name} 距成熟约 ${formatWatchlistRemain(remainMs)}，进入低频观察窗口`, {
                module: 'friend',
                event: '重点低频观察窗口',
                friendGid: gid,
                friendName: name,
                dueAt: ripeAt,
              });
            }
          }
          if (remainMs <= DUE_PREARM_WATCHLIST_MS) {
            watchFriend(gid, name, { now: visitedAt, ripeAt, mode: 'prearm', reason: 'ripe_prearm' });
          }
          watchlistPollNextAt.set(gid, visitedAt + nextWatchlistPollDelayMs(remainMs));
        } else {
          // 没有在长的作物（或刚被偷光）：退到慢档，等新一茬
          watchlistPollRipeAt.delete(gid);
          watchlistWindowAnnounced.delete(gid);
          // 不提前关闭治理器的成熟竞速宽限；让 ripeAt 后 60 秒自然过期，
          // 避免“第一轮偷完部分地块”后续抢收失败被误计入异常降速阈值。
          watchlistPollNextAt.set(gid, visitedAt + nextWatchlistPollDelayMs(0));
        }
      } else {
        watchlistPollNextAt.set(gid, visitedAt + nextWatchlistPollDelayMs(0));
      }
      if (ownHarvestIsImminent(OWN_HARVEST_RESERVE_MS)) break;
      await randomDelay(800, 1500);
    }
  } finally {
    if (watchlistPollLoopArmed) {
      friendScheduler.setTimeoutTask('watchlist_poll', WATCHLIST_POLL_TICK_MS, () => watchlistPollTick());
    }
  }
}

function applyStealScheduleFromFriends(rawFriends, { myGid, blacklist }) {
  const now = Date.now();
  lastRipeRefreshAt = now;
  const watchlistSet = new Set(getWatchlistFriendGids(process.env.FARM_ACCOUNT_ID || ''));
  setPriorityGids(watchlistSet);
  // 维护重点好友名字表 + 清掉已移出重点的巡田状态
  for (const friend of Array.isArray(rawFriends) ? rawFriends : []) {
    const gid = toNum(friend && friend.gid);
    if (gid && watchlistSet.has(gid)) {
      watchlistNames.set(gid, friend.remark || friend.name || `GID:${gid}`);
    }
  }
  for (const gid of [...watchlistPollRipeAt.keys()]) {
    if (!watchlistSet.has(gid)) {
      watchlistPollRipeAt.delete(gid);
      watchlistPollNextAt.delete(gid);
      watchlistNames.delete(gid);
    }
  }
  if (watchlistSet.size > 0) ensureWatchlistPollLoop();
  announceWatchlist(rawFriends, watchlistSet, { now, myGid, blacklist });
  noteFriendSummaries(rawFriends, { now, myGid, blacklist });
  nextFriendStealDueAtMs = computeNextStealDueAt(rawFriends, {
    now,
    myGid,
    blacklist,
    ownRipeAtMs: 0,
  });
  nextWatchlistStealDueAtMs = watchlistSet.size > 0
    ? computeNextStealDueAt(
      rawFriends.filter(f => watchlistSet.has(toNum(f && f.gid))),
      { now, myGid, blacklist, ownRipeAtMs: 0 }
    )
    : 0;
  friendSummaryDueByGid.clear();
  for (const friend of Array.isArray(rawFriends) ? rawFriends : []) {
    const gid = toNum(friend && friend.gid);
    if (!gid || gid === myGid || blacklist.has(gid)) continue;
    const dueAt = computeNextStealDueAt([friend], {
      now,
      myGid,
      blacklist,
      ownRipeAtMs: 0,
    });
    if (dueAt > 0) friendSummaryDueByGid.set(gid, dueAt);
  }
  recomputeFriendSummaryClocks(now);
  const combinedDueAt = getNextStealDueAtMs(now);
  if (combinedDueAt > 0) {
    markStealDueAt(combinedDueAt <= now ? now : combinedDueAt);
  } else {
    markStealDueAt(0);
  }

  // 自然成熟竞速：ripeAt 在 DUE_PREARM_MS 内的好友提前布控，
  // 到点后走快路径直接进门，不用等下一轮全量扫描
  for (const friend of Array.isArray(rawFriends) ? rawFriends : []) {
    const gid = toNum(friend && friend.gid);
    if (!gid || gid === myGid || blacklist.has(gid)) continue;
    const plant = friend.plant;
    if (!plant || toNum(plant.steal_plant_num) > 0) continue;
    const ripeAt = ripeDueAtMs(
      plant.ripe_time_sec != null ? plant.ripe_time_sec : plant.ripeTimeSec,
      now
    );
    const prearmMs = watchlistSet.has(gid) ? DUE_PREARM_WATCHLIST_MS : DUE_PREARM_MS;
    if (ripeAt > now && ripeAt <= now + prearmMs) {
      watchFriend(gid, friend.remark || friend.name || `GID:${gid}`, {
        now,
        ripeAt,
        mode: 'prearm',
        reason: 'ripe_prearm',
      });
    }
  }

  return combinedDueAt;
}

function getNextStealDueAtMs(now = Date.now()) {
  recomputeFriendSummaryClocks(now);
  const accountId = process.env.FARM_ACCOUNT_ID || '';
  const knownEntry = getNextKnownFriendRipeEntry(now, {
    myGid: getUserState().gid,
    blacklist: new Set(getFriendBlacklist(accountId)),
    graceMs: STEAL_OVERDUE_GRACE_MS,
  });
  if (knownEntry) {
    const prearmMs = isPriorityGid(knownEntry.gid)
      ? DUE_PREARM_WATCHLIST_MS
      : DUE_PREARM_MS;
    if (knownEntry.ripeAt <= now + prearmMs) {
      // 精确地块墙钟临近到点时才转 PREARM；远期不占用 HOT/PREARM
      // 活跃容量，到点后可跳过缺 ripe_time_sec 的 wx 摘要直接进门。
      watchFriend(knownEntry.gid, knownEntry.name, {
        now,
        ripeAt: knownEntry.ripeAt,
        mode: 'prearm',
        reason: 'ripe_prearm',
      });
    }
  }
  return mergeDueAt(
    cachedDueWithinGrace(nextFriendStealDueAtMs, now, STEAL_OVERDUE_GRACE_MS),
    knownEntry && knownEntry.ripeAt,
    getNextWatchDueAt(now)
  );
}

/** worker.js 注入 armStealWake；重点巡田读到新时刻后立即重排偷菜唤醒 */
function setArmStealWakeCallback(fn) {
  if (typeof fn === 'function') armStealWakeForWorker = fn;
}

/**
 * 重点监控好友的最近成熟/可偷时刻（Date.now 基准，0 = 没有/未知）。
 * 摘要时刻 + 主动巡田读到的精确时刻合并。
 */
function getNextWatchlistStealDueAtMs(now = Date.now()) {
  recomputeFriendSummaryClocks(now);
  let pollMin = 0;
  for (const ripeAt of watchlistPollRipeAt.values()) {
    const activeDue = cachedDueWithinGrace(ripeAt, now, STEAL_OVERDUE_GRACE_MS);
    if (activeDue > 0) pollMin = pollMin ? Math.min(pollMin, activeDue) : activeDue;
  }
  return mergeDueAt(
    cachedDueWithinGrace(nextWatchlistStealDueAtMs, now, STEAL_OVERDUE_GRACE_MS),
    pollMin
  );
}

/**
 * 距最近一位好友作物成熟还剩多少毫秒（0 = 没有/未知/已到期）。
 */
function getNextStealMatureInMs() {
  const dueAt = getNextStealDueAtMs();
  if (!dueAt) return 0;
  return Math.max(0, dueAt - Date.now());
}

// ===== Exports =====
/** 重点好友当前已知的成熟时刻快照（给面板展示剩余时间用） */
function getWatchlistRipeSnapshots(now = Date.now()) {
  const list = [];
  for (const [gid, ripeAt] of watchlistPollRipeAt.entries()) {
    if (!cachedDueWithinGrace(ripeAt, now, STEAL_OVERDUE_GRACE_MS)) continue;
    list.push({
      gid,
      name: watchlistNames.get(gid) || `GID:${gid}`,
      ripeAt,
      remainSec: ripeAt > now ? Math.ceil((ripeAt - now) / 1000) : 0,
      matured: ripeAt <= now,
      inWindow: ripeAt - now <= getWatchlistWakeBeforeMs(),
    });
  }
  return list.sort((a, b) => a.ripeAt - b.ripeAt);
}

module.exports = {
  checkFriends,
  startFriendCheckLoop,
  stopFriendCheckLoop,
  refreshFriendCheckLoop,
  runBadOnceOnStartup,
  isHelpExpLimitReached,
  isCheckingFriendsRunning,
  clearFriendsListCache,
  syncFriendsFromGids,
  getNextStealMatureInMs,
  getNextStealDueAtMs,
  getNextWatchlistStealDueAtMs,
  getWatchlistRipeSnapshots,
  getWatchlistWakeBeforeMs,
  nextWatchlistPollDelayMs,
  setArmStealWakeCallback,
  WATCHLIST_WAKE_BEFORE_MS,
  refreshFriendRipeSchedule,
};
