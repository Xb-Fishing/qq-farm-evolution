const process = require('node:process');
const { parentPort, workerData } = require('node:worker_threads');

const { CONFIG } = require('../config/config');
const {
    gaussianInt,
    randInt,
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
    markIdleQuietUntil,
} = require('../utils/behavior');
const { getLevelExpProgress } = require('../config/gameConfig');
const {
    getAutomation,
    getPreferredSeed,
    getConfigSnapshot,
    applyConfigSnapshot,
    getFriendQuietHours,
    getPauseRemainMs,
} = require('../models/store');
const {
    checkAndClaimEmails,
    getEmailDailyState
} = require('../services/email');
const {
    checkFarm,
    startFarmCheckLoop,
    stopFarmCheckLoop,
    refreshFarmCheckLoop,
    getLandsDetail,
    getAvailableSeeds,
    runFarmOperation,
    runFertilizerByConfig,
    ORGANIC_FERTILIZER_ID,
    fertilize,
    removePlant,
    harvestOwnAtMaturity,
    getNextMatureInMs,
    getNextMatureDueAtMs
} = require('../services/farm');
const {
    checkFriends,
    startFriendCheckLoop,
    stopFriendCheckLoop,
    refreshFriendCheckLoop,
    runBadOnceOnStartup,
    runGoldenBugPlacement,
    getFriendsList,
    getFriendLandsDetail,
    doFriendOperation,
    getFriendDogInfo,
    batchGetFriendDogInfo,
    syncFriendsFromGids,
    fetchFriendsDogInfo,
    getNextStealDueAtMs,
    getNextWatchlistStealDueAtMs,
    setArmStealWakeCallback,
    getWatchlistWakeBeforeMs,
    delFriend
} = require('../services/friend');
const { mergeDueAt } = require('../services/steal-schedule');
const { getNextWatchDueAt, inspectFriendLands, getDueWatchFriends } = require('../services/fertilizer-watch');
const { getInteractRecords } = require('../services/interact');
const { processInviteCodes } = require('../services/invite');
const {
    autoBuyFertilizer,
    checkAndBuyFertilizerBoth,
    buyFreeGifts,
    getFreeGiftDailyState
} = require('../services/mall');
const {
    performDailyMonthCardGift,
    getMonthCardDailyState
} = require('../services/monthcard');
const {
    performDailyVipGift,
    getVipDailyState
} = require('../services/qqvip');
const {
    createScheduler,
    getSchedulerRegistrySnapshot
} = require('../services/scheduler');
const {
    isDailyRoutineDone,
    markDailyRoutineDone,
} = require('../services/daily-routine-state');
const {
    performDailyShare,
    getShareDailyState
} = require('../services/share');
const {
    resetSessionGains,
    recordOperation,
    initStatsWithPersistence,
    saveStats
} = require('../services/stats');
const {
    initStatusBar,
    setStatusPlatform,
    setRecordGoldExpHook,
    statusData
} = require('../services/status');
const {
    cleanupTaskSystem,
    checkAndClaimTasks,
    getTaskClaimDailyState,
    getTaskDailyStateLikeApp,
    getGrowthTaskStateLikeApp
} = require('../services/task');
const {
    sellAllFruits,
    getBag,
    getBagItems,
    openFertilizerGiftPacksSilently
} = require('../services/warehouse');
const {
    connect,
    stopNetwork,
    getWs,
    getUserState,
    networkEvents,
    pauseAceReports,
    resumeAceReports,
    getBreakerState,
} = require('../utils/network');
const { loadProto } = require('../utils/proto');
const { setLogHook, log, toNum } = require('../utils/utils');

// 设置环境变量中的账号ID
if (parentPort && workerData && workerData.accountId && !process.env.FARM_ACCOUNT_ID) {
    process.env.FARM_ACCOUNT_ID = String(workerData.accountId);
}

// ==================== IPC 通信 ====================

/** 发送消息给主进程 */
function sendToMaster(message) {
    if (process.send) {
        process.send(message);
        return;
    }
    if (parentPort) {
        parentPort.postMessage(message);
    }
}

/** 监听主进程消息 */
function onMasterMessage(handler) {
    if (process.send) process.on('message', handler);
    if (parentPort) parentPort.on('message', handler);
}

/** 退出 Worker 进程 */
function exitWorker(code = 0) {
    if (parentPort) {
        try { parentPort.close(); } catch { }
    }
    setImmediate(() => process.exit(code));
}

// ==================== 格式化工具 ====================

function pad2(num) {
    return String(num).padStart(2, '0');
}

function formatLocalDateTime24(date = new Date()) {
    const d = date instanceof Date ? date : new Date();
    const yyyy = d.getFullYear();
    const mm = pad2(d.getMonth() + 1);
    const dd = pad2(d.getDate());
    const hh = pad2(d.getHours());
    const min = pad2(d.getMinutes());
    const ss = pad2(d.getSeconds());
    return `${yyyy  }-${  mm  }-${  dd  } ${  hh  }:${  min  }:${  ss}`;
}

// ==================== 日志/统计钩子 ====================

setLogHook((tag, msg, isWarn, meta) => {
    sendToMaster({
        type: 'log',
        data: {
            time: formatLocalDateTime24(new Date()),
            tag,
            msg,
            isWarn,
            meta: meta || {}
        }
    });
});

setRecordGoldExpHook((gold, exp) => {
    const { recordGoldExp } = require('../services/stats');
    recordGoldExp(gold, exp);
    sendToMaster({
        type: 'stat_update',
        data: { gold, exp }
    });
});

// ==================== 全局状态 ====================

let isRunning = false;
let loginReady = false;
let appliedConfigRevision = 0;
let unifiedSchedulerRunning = false;

// ==================== 工具函数 ====================

/** 判断是否是瞬时网络错误（可忽略） */
function isTransientNetworkError(err) {
    const msg = String(err && err.message || '');
    if (!msg) return false;
    return ['连接未打开', '请求超时', '请求已中断', '连接关闭', '发送失败', '请求队列已满']
        .some(text => msg.includes(text));
}

// ==================== 农场/好友/偷菜 Tick 任务 ====================

let farmTaskRunning = false;
let nextFarmRunAt = 0;
let lastStatusHash = '';
let lastStatusSentAt = 0;
let onSellGain = null;
let onFarmHarvested = null;
let onOwnMaturityChanged = null;
let onDogSkillGiftPending = null;
let harvestSellRunning = false;
let onWsError = null;
let onDisconnectHandler = null;
let onClientVersionUpdate = null;
let wsErrorHandledAt = 0;
let lastDailyRunDate = '';
let friendSyncPaused = false;

const workerScheduler = createScheduler('worker');

/** 每日任务是否启用 */
function isDailyRoutineEnabled() { return true; }

async function runDailyRoutineStep(key, runner, getState, force = false) {
    const accountId = process.env.FARM_ACCOUNT_ID || '';
    if (!force && isDailyRoutineDone(accountId, key)) return;
    await runner(force);
    const state = typeof getState === 'function' ? getState() : null;
    if (state && state.doneToday) markDailyRoutineDone(accountId, key);
}

/** 获取当天日期键 */
function getLocalDateKey() {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y  }-${  m  }-${  day}`;
}

// ==================== 每日任务 ====================

async function runDailyRoutines(force = false) {
    if (!loginReady || friendSyncPaused) return;
    try {
        await runDailyRoutineStep('email_rewards', checkAndClaimEmails, getEmailDailyState, force);
        await runDailyRoutineStep('daily_share', performDailyShare, getShareDailyState, force);
        await runDailyRoutineStep('month_card_gift', performDailyMonthCardGift, getMonthCardDailyState, force);
        await runDailyRoutineStep('mall_free_gifts', buyFreeGifts, getFreeGiftDailyState, force);
        await runDailyRoutineStep('vip_daily_gift', performDailyVipGift, getVipDailyState, force);
    } catch (err) {
        log('系统', `每日任务调度失败: ${  err.message}`, {
            module: 'system',
            event: '每日任务',
            result: 'error'
        });
    }
}

function stopDailyRoutineTimer() {
    workerScheduler.clear('daily_routine_interval');
}

function startDailyRoutineTimer() {
    stopDailyRoutineTimer();
    lastDailyRunDate = getLocalDateKey();
    // 完成态按账号落盘；worker/主进程重启不再把当天已完成项目强制重查一遍。
    runDailyRoutines(false).catch(() => null);

    // 每 60 秒检查一次日期是否变化
    workerScheduler.setIntervalTask('daily_routine_interval', 60000, () => {
        if (!loginReady) return;
        const today = getLocalDateKey();
        if (today === lastDailyRunDate) return;
        lastDailyRunDate = today;
        runDailyRoutines(false)
            .then(() => runBadOnceOnStartup(true))
            .catch(() => null);
    });
}

// 神秘商人可能在登录后的任意时间出现；登录后先检查，并持续短周期探测。
function stopMysteryShopAutoBuyTimer() {
    workerScheduler.clear('mystery_shop_auto_buy_initial');
    workerScheduler.clear('mystery_shop_auto_buy_interval');
    workerScheduler.clear('mystery_shop_auto_buy_after_save');
}

function runMysteryShopAutoBuy() {
    if (!loginReady || getAutomation().mystery_shop_auto_buy !== true) return Promise.resolve();
    const { checkAndAutoBuyMysteryShop } = require('../services/mystery-shop');
    return checkAndAutoBuyMysteryShop();
}

function startMysteryShopAutoBuyTimer() {
    const { nextAutoBuyCheckDelayMs } = require('../services/mystery-shop');
    stopMysteryShopAutoBuyTimer();
    // 自排程 + 每次抖动，替代固定 10 分钟 interval（等间隔是机器指纹）；串行天然不重叠
    const chainNext = (delayMs) => workerScheduler.setTimeoutTask(
        'mystery_shop_auto_buy_interval',
        delayMs,
        () => runMysteryShopAutoBuy()
            .catch(() => null)
            .finally(() => chainNext(nextAutoBuyCheckDelayMs()))
    );
    chainNext(10 * 1000);
}

// ==================== 间隔计算 ====================

function normalizeIntervalRangeSec(minVal, maxVal, defaultVal) {
    const def = Math.max(1, Number.parseInt(defaultVal, 10) || 3);
    let min = Math.max(1, Number.parseInt(minVal, 10) || def);
    let max = Math.max(1, Number.parseInt(maxVal, 10) || def);
    if (min > max) [min, max] = [max, min];
    return { min, max };
}

function applyIntervalsToRuntime(intervals) {
    const iv = intervals && typeof intervals === 'object' ? intervals : {};
    const farmDefault = Math.max(2, Number.parseInt(iv.farm, 10) || 2);
    const farmRange = normalizeIntervalRangeSec(iv.farmMin, iv.farmMax, farmDefault);
    CONFIG.farmCheckIntervalMin = farmRange.min * 1000;
    CONFIG.farmCheckIntervalMax = farmRange.max * 1000;
    CONFIG.farmCheckInterval = CONFIG.farmCheckIntervalMin;

    const helpRange = normalizeIntervalRangeSec(iv.helpMin, iv.helpMax, 30);
    CONFIG.helpCheckIntervalMin = helpRange.min * 1000;
    CONFIG.helpCheckIntervalMax = helpRange.max * 1000;

    const stealRange = normalizeIntervalRangeSec(iv.stealMin, iv.stealMax, 25);
    CONFIG.stealCheckIntervalMin = stealRange.min * 1000;
    CONFIG.stealCheckIntervalMax = stealRange.max * 1000;
}

/** 在 [minMs, maxMs] 范围内取一个偏中间的毫秒数 */
function randomIntervalMs(minMs, maxMs) {
    const min = Math.max(1, Math.floor(Number(minMs) || 3));
    const max = Math.max(min, Math.floor(Number(maxMs) || min * 2));
    return gaussianInt(min, max);
}

function ordinarySlowdownFloorMs(kind = 'farm') {
    const state = getBreakerState();
    if (!state.active || state.mode !== 'slowdown') return 0;
    const base = Math.max(30_000, Number(state.recommendedDelayMs) || 90_000);
    return kind === 'help'
        ? gaussianInt(base, Math.floor(base * 1.5))
        : gaussianInt(Math.floor(base * 0.75), Math.floor(base * 1.25));
}

/** 成熟唤醒：农场可带一点余量；偷菜几乎立刻（80-300ms） */
function capDelayByMatureInMs(delayMs, matureInMs, { steal = false } = {}) {
    if (matureInMs > 0 && matureInMs < delayMs) {
        return steal
            ? matureInMs + randInt(80, 300)
            : matureInMs + randInt(300, 2000);
    }
    return delayMs;
}

// ==================== 统一调度时间重置 ====================

function resetUnifiedSchedule() {
    const farmDelay = randomIntervalMs(
        CONFIG.farmCheckIntervalMin || CONFIG.farmCheckInterval || 8000,
        CONFIG.farmCheckIntervalMax || CONFIG.farmCheckInterval || 12000
    );
    const helpDelay = randomIntervalMs(
        CONFIG.helpCheckIntervalMin || 30000,
        CONFIG.helpCheckIntervalMax || 35000
    );
    const stealDelay = randInt(800, 2000);
    const now = Date.now();
    nextFarmRunAt = now + farmDelay;
    nextHelpRunAt = now + helpDelay;
    nextStealRunAt = now + stealDelay;
    markStealDueAt(nextStealRunAt);
}

// ==================== 农场 Tick ====================

async function runFarmTick(autoConfig) {
    if (farmTaskRunning || friendSyncPaused) return;
    if ((stealIsDue() || stealIsImminent(1500)) && !ownHarvestIsDue()) return;
    farmTaskRunning = true;

    try {
        if (autoConfig.farm) await checkFarm();
        if (autoConfig.task) await checkAndClaimTasks();
        if (autoConfig.email) await checkAndClaimEmails();
        if (autoConfig.fertilizer_gift) await openFertilizerGiftPacksSilently();
    } catch { } finally {
        const patrol = randomIntervalMs(
            CONFIG.farmCheckIntervalMin || CONFIG.farmCheckInterval || 8000,
            CONFIG.farmCheckIntervalMax || CONFIG.farmCheckInterval || 12000
        );
        const matureMs = getNextMatureInMs();
        const horizon = nextIdleHorizonMs();
        const nap = idleNapMs(horizon, patrol, {
            maxSleepMs: idleMaxSleepMs(),
            activeMs: effectiveWakeBeforeMs(),
        });
        const nextDelay = capDelayByMatureInMs(nap, matureMs);
        const normalDelay = matureMs > 0 && matureMs < nextDelay
            ? nextDelay
            : maybeStretchDelay(nextDelay);
        const delay = Math.max(normalDelay, ordinarySlowdownFloorMs('farm'));
        nextFarmRunAt = Date.now() + delay;
        logIdleSleep(delay, horizon, { activeMs: effectiveWakeBeforeMs() });
        armStealWake();
        farmTaskRunning = false;
    }
}

// ==================== 帮助 Tick ====================

let helpTaskRunning = false;
let nextHelpRunAt = 0;

async function runHelpTick(autoConfig) {
    if (helpTaskRunning || friendSyncPaused) return;
    if (ownHarvestIsDue() || ownHarvestIsImminent(10_000)) return;
    if (stealIsDue() || stealIsImminent(1500)) return;
    if (!autoConfig.friend_help && !autoConfig.friend_golden_bug) return;
    helpTaskRunning = true;

    try {
        if (autoConfig.friend_help) await checkFriends({ onlyHelp: true });
        if (autoConfig.friend_golden_bug) await runGoldenBugPlacement();
    } catch (err) {
        if (!isTransientNetworkError(err)) {
            log('系统', `帮助巡查执行失败: ${  err.message}`, {
                module: 'system',
                event: '帮助巡查',
                result: 'error'
            });
        }
    } finally {
        const patrol = randomIntervalMs(
            CONFIG.helpCheckIntervalMin || 30000,
            CONFIG.helpCheckIntervalMax || 35000
        );
        const horizon = nextIdleHorizonMs();
        const nap = idleNapMs(horizon, patrol, {
            maxSleepMs: idleMaxSleepMs(),
            activeMs: effectiveWakeBeforeMs(),
        });
        const delay = Math.max(nap, ordinarySlowdownFloorMs('help'));
        nextHelpRunAt = Date.now() + delay;
        logIdleSleep(delay, horizon, { activeMs: effectiveWakeBeforeMs() });
        armStealWake();
        helpTaskRunning = false;
    }
}

// ==================== 偷菜 Tick ====================

let stealTaskRunning = false;
let nextStealRunAt = 0;
const STEAL_IDLE_MS = 24 * 3600 * 1000;
const STEAL_REDISCOVERY_MIN_MS = 5 * 60_000;
const STEAL_REDISCOVERY_MAX_MS = 8 * 60_000;
// ponytail: 重点好友摘要刷新下限，60-120s 高斯抖动。请求代价是空闲期每下限
// 一次 getAllFriends（全部好友共用一次请求）；要更快的催熟捕获就收紧这两个值，
// 代价是更高请求密度（防封红线内已尽量取宽）。
const PRIORITY_SUMMARY_FLOOR_MIN_MS = 60_000;
const PRIORITY_SUMMARY_FLOOR_MAX_MS = 120_000;

/**
 * 只有完全没有成熟墙钟时才低频重新发现。普通偷菜有已知时刻后直接等到点，
 * 不再借用施肥观察窗口做 3-5 秒/15-30 秒摘要重查。重点用户施肥 HOT、
 * 自然成熟 PREARM 都有各自的 nextVisitAt，会独立并入 armStealWake。
 */
function stealRediscoveryDelayMs() {
    return gaussianInt(STEAL_REDISCOVERY_MIN_MS, STEAL_REDISCOVERY_MAX_MS);
}

function idleMaxSleepMs() {
    const minutes = Number((getFriendQuietHours() || {}).maxSleepMinutes) || 120;
    // 单次睡眠封顶 10 分钟（下限 1 分钟，idleNapMs 在区间内随机取）：
    // 勤醒来重估时刻表，防催熟/估算偏差睡过头
    return Math.max(1, Math.min(10, minutes)) * 60 * 1000;
}

function idleWakeBeforeMs() {
    const minutes = Number((getFriendQuietHours() || {}).wakeBeforeMinutes) || 66;
    return Math.max(5, Math.min(180, minutes)) * 60 * 1000;
}

// 化肥一次最多催熟约 2 小时：重点监控好友在成熟前进入盯梢窗口（分钟数面板可配，
// 默认 122），普通好友仍按 wakeBeforeMinutes（默认 66 分钟）。
function effectiveWakeBeforeMs(now = Date.now()) {
    const watchlistWakeBeforeMs = getWatchlistWakeBeforeMs();
    const watchlistDue = Number(getNextWatchlistStealDueAtMs()) || 0;
    if (watchlistDue > 0 && watchlistDue - now <= watchlistWakeBeforeMs) {
        return watchlistWakeBeforeMs;
    }
    return idleWakeBeforeMs();
}

function formatIdleRemain(ms) {
    const sec = Math.max(0, Math.ceil((Number(ms) || 0) / 1000));
    if (sec < 60) return `${sec}秒`;
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    if (h > 0) return m > 0 ? `${h}小时${m}分` : `${h}小时`;
    return `${m}分`;
}

let lastIdleSleepLogAt = 0;
// 「不长睡」按状态去重：同一类原因只打一次，长睡或原因类别变化后才会再打
let lastIdleAwakeReason = '';

function logIdleSleep(delayMs, horizonMs, options = {}) {
    const delay = Math.max(0, Number(delayMs) || 0);
    const horizon = Math.max(0, Number(horizonMs) || 0);
    const active = Math.max(0, Number(options.activeMs) || idleWakeBeforeMs());
    const now = Date.now();
    if (delay >= 60_000) {
        if (now - lastIdleSleepLogAt < 15_000) return;
        lastIdleSleepLogAt = now;
        lastIdleAwakeReason = '';
        const extra = horizon > 0
            ? `，距下次成熟/可偷约 ${formatIdleRemain(horizon)}`
            : '';
        log('系统', `没事做，先歇 ${formatIdleRemain(delay)} 再看${extra}`, {
            module: 'system',
            event: '空闲歇息',
            sleepMs: delay,
            horizonMs: horizon,
        });
        return;
    }
    let key = 'short';
    let reason = `本次只要 ${formatIdleRemain(delay)}`;
    if (horizon <= 0) {
        key = 'none';
        reason = '没有可等的成熟/可偷时刻';
    }
    else if (horizon <= active) {
        key = 'window';
        reason = `距下次约 ${formatIdleRemain(horizon)}，已在 ${Math.round(active / 60000)} 分钟窗口内`;
    }
    if (key === lastIdleAwakeReason) return;
    lastIdleAwakeReason = key;
    log('系统', `不长睡，${reason}，按正常巡查看`, {
        module: 'system',
        event: '空闲不歇',
        sleepMs: delay,
        horizonMs: horizon,
        wakeBeforeMs: active,
    });
}

function nextIdleHorizonMs(now = Date.now()) {
    const ownMs = getNextMatureInMs();
    const stealDue = mergeDueAt(
        Number(getNextStealDueAtMs()) || 0,
        Number(getStealDueAt()) || 0,
        getNextWatchDueAt(now)
    );
    const stealMs = stealDue > now ? stealDue - now : 0;
    const times = [ownMs, stealMs].filter((ms) => ms > 0);
    return times.length ? Math.min(...times) : 0;
}

function ownHarvestDueAt() {
    return Number(getNextMatureDueAtMs()) || 0;
}

function resolveStealDueAt(now = Date.now()) {
    return mergeDueAt(
        Number(getNextStealDueAtMs()) || 0,
        Number(getStealDueAt()) || 0,
        getNextWatchDueAt(now),
        Number(getNextWatchlistStealDueAtMs()) || 0
    );
}

function nextScheduledStealAt() {
    return Number(nextStealRunAt) || Number(getStealDueAt()) || 0;
}

// ==================== 自己成熟保护器：绝对墙钟长时间武装 ====================
// 服务端成熟点是秒级时间戳；结合最近一次服务器校时换算成本机毫秒墙钟，
// 健康链路在到点后 30-80ms 直接发缓存地块的 Harvest，不先做 AllLands。
const OWN_HARVEST_RESERVE_MS = 10_000;
const OWN_HARVEST_ACT_DELAY_MS = [30, 80];
const OWN_HARVEST_RETRY_WINDOWS_MS = [
    [180, 320],
    [500, 800],
    [1200, 1800],
    [3500, 5500],
    [8000, 12000],
    [20000, 30000],
];
let ownHarvestArmedFor = 0;
let ownHarvestRetryAttempt = 0;
let ownHarvestStrikeRunning = false;
let lastOwnHarvestFailureLogAt = 0;

function clearOwnHarvestGuard(clearDue = false) {
    workerScheduler.clear('own_harvest_guard');
    ownHarvestArmedFor = 0;
    ownHarvestRetryAttempt = 0;
    ownHarvestStrikeRunning = false;
    if (clearDue) markOwnHarvestDueAt(0);
}

function setOwnHarvestGuardTimer(delayMs, dueAt) {
    ownHarvestArmedFor = Number(dueAt) || 0;
    workerScheduler.setTimeoutTask('own_harvest_guard', Math.max(0, delayMs), async () => {
        ownHarvestArmedFor = 0;
        await runOwnHarvestStrike();
    });
}

function scheduleOwnHarvestRetry() {
    const index = Math.min(ownHarvestRetryAttempt, OWN_HARVEST_RETRY_WINDOWS_MS.length - 1);
    const [minMs, maxMs] = OWN_HARVEST_RETRY_WINDOWS_MS[index];
    ownHarvestRetryAttempt += 1;
    setOwnHarvestGuardTimer(randInt(minMs, maxMs), ownHarvestDueAt());
}

/** 新土地快照/催熟推送到达即重排；不依赖统一 tick，也不受偷菜时钟覆盖。 */
function armOwnHarvestGuard(now = Date.now()) {
    const dueAt = ownHarvestDueAt();
    const autoConfig = getAutomation();
    if (!loginReady || !autoConfig.farm || !autoConfig.harvest || !dueAt) {
        workerScheduler.clear('own_harvest_guard');
        ownHarvestArmedFor = 0;
        markOwnHarvestDueAt(0);
        return;
    }

    markOwnHarvestDueAt(dueAt);
    if (ownHarvestArmedFor && Math.abs(ownHarvestArmedFor - dueAt) <= 5
        && workerScheduler.has('own_harvest_guard')) return;

    ownHarvestRetryAttempt = 0;
    const actDelay = dueAt > now
        ? randInt(OWN_HARVEST_ACT_DELAY_MS[0], OWN_HARVEST_ACT_DELAY_MS[1])
        : 0;
    setOwnHarvestGuardTimer(Math.max(0, dueAt - now) + actDelay, dueAt);
}

async function runOwnHarvestStrike() {
    if (ownHarvestStrikeRunning) return;
    const dueAt = ownHarvestDueAt();
    const autoConfig = getAutomation();
    if (!loginReady || !autoConfig.farm || !autoConfig.harvest || !dueAt) {
        armOwnHarvestGuard();
        return;
    }

    // 明确静默仍高于业务收益优先级；异常阈值只降低普通巡查速度，
    // 自己到点收获继续受请求硬预算保护，不再被整号冻结。
    const pauseRemain = pauseRemainMsNow();
    if (pauseRemain > 0) {
        setOwnHarvestGuardTimer(pauseRemain + randInt(100, 500), dueAt);
        return;
    }
    const ws = getWs();
    if (friendSyncPaused || !ws || ws.readyState !== 1) {
        scheduleOwnHarvestRetry();
        return;
    }

    ownHarvestStrikeRunning = true;
    try {
        const outcome = await harvestOwnAtMaturity();
        if (Number(outcome && outcome.harvestedCount) > 0) {
            ownHarvestRetryAttempt = 0;
            armOwnHarvestGuard();
            armStealWake();
            return;
        }
        // 快照在执行前已被其他收获更新：只按新的墙钟重新武装，不报假成功。
        armOwnHarvestGuard();
    } catch (err) {
        const now = Date.now();
        if (now - lastOwnHarvestFailureLogAt > 5000) {
            lastOwnHarvestFailureLogAt = now;
            log('农场', `到点保护收获失败，将受控重试: ${err.message}`, {
                module: 'farm',
                event: '到点保护收获',
                result: 'retry',
                dueAt,
                retryAttempt: ownHarvestRetryAttempt + 1,
            });
        }
        scheduleOwnHarvestRetry();
    } finally {
        ownHarvestStrikeRunning = false;
    }
}

// ==================== 好友成熟哨兵：最后几秒武装，到点即刻出手 ====================
// 自己的菜由下方独立绝对墙钟保护器负责；好友哨兵只处理偷菜，避免两种 due 共用状态。
const SENTINEL_ARM_WATCHLIST_MS = 5_000;  // 重点好友：剩 5s 武装
const SENTINEL_ARM_NORMAL_MS = 2_000;     // 普通好友：剩 2s 武装
const SENTINEL_ACT_DELAY_MS = [30, 80];   // 到点出手延迟区间
// 预进门（2026-09-22，借鉴 wjnnone 蹲守）：武装时提前 3s 进目标农场驻留，
// 到点 Strike 跳过 Enter 往返（省一个 RTT，100-300ms → 直接出手）。
const SENTINEL_PRE_ENTER_AHEAD_MS = 3_000;
let sentinelTimer = null;
let sentinelArmedFor = null; // { kind: 'friend', dueAt, gid? }
// 预进门驻留状态：{ gid, dueAt, enteredAt }；Strike 消费或超时清理。
let sentinelPreEnter = null;
let sentinelPreEnterTimer = null;

function clearSentinel() {
    if (sentinelTimer) {
        clearTimeout(sentinelTimer);
        sentinelTimer = null;
    }
    sentinelArmedFor = null;
    clearSentinelPreEnter();
}

function clearSentinelPreEnter() {
    if (sentinelPreEnterTimer) {
        clearTimeout(sentinelPreEnterTimer);
        sentinelPreEnterTimer = null;
    }
    sentinelPreEnter = null;
}

/**
 * 打开成熟抢收紧急窗口（见 request-governor setUrgentMode）。
 * 惰性查找 globalThis.__setUrgentStrikeMode：生产路径在 worker 初始化时
 * 挂上真实实现；测试沙箱（vm context）注入同名桩即可覆盖，不需要 require。
 */
function setUrgentStrikeMode(windowMs) {
    const helper = globalThis.__setUrgentStrikeMode
        || ((ms) => { require('../services/request-governor').setUrgentMode(true, Date.now() + ms); });
    helper(windowMs);
}

/**
 * 预进门驻留：武装成立后提前 3s 进目标农场（请求治理紧急通道放行）。
 * 进门后不做任何操作，纯驻留；到点 Strike 直接发偷取请求。
 * 失败静默（连接断/被踢等）——Strike 走常规完整路径兜底。
 * 不主动 Leave：驻留过期由服务端会话管理，成功 Strike 的业务路径自己会 Leave。
 */
function armSentinelPreEnter(armed) {
    const gid = Number(armed && armed.gid) || 0;
    const dueAt = Number(armed && armed.dueAt) || 0;
    if (!gid || !dueAt) return;
    const now = Date.now();
    const aheadMs = dueAt - now;
    if (aheadMs <= 0 || aheadMs > SENTINEL_PRE_ENTER_AHEAD_MS + 1_500) return;
    clearSentinelPreEnter();
    sentinelPreEnterTimer = setTimeout(async () => {
        sentinelPreEnterTimer = null;
        const stillArmed = sentinelArmedFor && Number(sentinelArmedFor.gid) === gid;
        if (!stillArmed) return;
        try {
            setUrgentStrikeMode(15_000);
            const enterReply = await require('../services/friend-api').enterFriendFarm(gid);
            sentinelPreEnter = { gid, dueAt, enteredAt: Date.now(), enterReply };
            // 兜底清理：dueAt 后 60s 仍未被 Strike 消费则丢弃驻留标记。
            sentinelPreEnterTimer = setTimeout(() => {
                if (sentinelPreEnter && Number(sentinelPreEnter.gid) === gid) {
                    sentinelPreEnter = null;
                }
            }, 60_000);
            sentinelPreEnterTimer.unref?.();
        } catch { /* 预进门失败：Strike 走完整路径 */ }
    }, Math.max(0, aheadMs - SENTINEL_PRE_ENTER_AHEAD_MS));
    sentinelPreEnterTimer.unref?.();
}

/** 好友哨兵到点动作：走偷菜快路径（含抢收快路径逻辑）。 */
async function runSentinelStrike() {
    const armed = sentinelArmedFor;
    sentinelTimer = null;
    sentinelArmedFor = null;
    if (!armed || friendSyncPaused) return;
    const autoConfig = getAutomation();
    const startedAt = Date.now();
    const preEnter = sentinelPreEnter
        && Number(sentinelPreEnter.gid) === Number(armed.gid)
        && sentinelPreEnter.enteredAt > 0
        ? sentinelPreEnter
        : null;
    try {
        if (autoConfig.friend_steal && !ownHarvestIsImminent(10_000)) {
            // 抢收紧急通道：到点链路（Enter/CheckCanOperate/Harvest/Leave）
            // 不被 60s 硬预算丢弃；窗口 15s，覆盖整次 Strike。
            // 注：用惰性 require 保持测试沙箱（vm context 无 require）可注入桩。
            if (typeof setUrgentStrikeMode === 'function') setUrgentStrikeMode(15_000);
            const handled = await checkFriends({
                onlySteal: true,
                preEnter: preEnter
                    ? { gid: preEnter.gid, enteredAt: preEnter.enteredAt, enterReply: preEnter.enterReply }
                    : null,
            });
            if (preEnter) clearSentinelPreEnter();
            if (!handled) return;
            log('系统', `哨兵抢收完成，成熟到点后 ${Date.now() - startedAt}ms 出手${preEnter ? '（预进门驻留）' : ''}`, {
                module: 'system', event: '哨兵抢收', result: 'ok', preEnter: !!preEnter
            });
        }
    } catch { /* 失败交由常规 tick 兜底 */ }
    finally {
        clearSentinelPreEnter();
        // 哨兵已处理该时刻，把常规偷菜唤醒顺延一小段，避免同一时刻重复进门
        nextStealRunAt = Date.now() + randInt(1500, 3000);
        markStealDueAt(0);
        armStealWake();
    }
}

/**
 * 每次重排偷菜唤醒时调用：最近的成熟事件进入武装区间就挂哨兵。
 * 哨兵只在武装窗口内替代唤醒抖动；到点动作本身仍是既有业务路径。
 */
function armMaturitySentinel(now = Date.now()) {
    if (friendSyncPaused) { clearSentinel(); return; }
    // 好友侧最近 due：盯梢目标(重点好友)与普通好友分开取
    const friendDue = Number(getNextStealDueAtMs()) || 0;
    const watchDue = getNextWatchDueAt(now);
    const watchlistDue = Number(getNextWatchlistStealDueAtMs()) || 0;
    const nearestFriendDue = mergeDueAt(friendDue, watchDue, watchlistDue);

    let candidate = null;
    if (nearestFriendDue > now && nearestFriendDue - now <= SENTINEL_ARM_NORMAL_MS) {
        // 普通好友目标在 2s 内
        candidate = { kind: 'friend', dueAt: nearestFriendDue, armMs: SENTINEL_ARM_NORMAL_MS };
    }
    // 重点好友 5s 窗口单独看（比普通好友宽），就武装（自己的菜已在上面处理）
    if (!candidate && nearestFriendDue > now && nearestFriendDue - now <= SENTINEL_ARM_WATCHLIST_MS) {
        const watchlistDueIn = nearestFriendDue - now;
        candidate = { kind: 'friend', dueAt: nearestFriendDue, armMs: watchlistDueIn <= SENTINEL_ARM_WATCHLIST_MS ? SENTINEL_ARM_WATCHLIST_MS : 0 };
    }

    if (!candidate) { clearSentinel(); return; }
    if (sentinelArmedFor && sentinelArmedFor.kind === candidate.kind
        && Math.abs(sentinelArmedFor.dueAt - candidate.dueAt) < 500) return; // 已武装同一目标

    clearSentinel();
    // 目标 gid：优先从到点盯梢（PREARM/HOT）解析；普通好友摘要 due 无 gid 时
    // 不做预进门（armMaturitySentinel 的合并时钟拿不到归属），Strike 走完整路径。
    const dueWatch = getDueWatchFriends(now);
    const dueGid = dueWatch.length > 0 ? Number(dueWatch[0].gid) || 0 : 0;
    sentinelArmedFor = { kind: candidate.kind, dueAt: candidate.dueAt, gid: dueGid };
    const delay = Math.max(0, candidate.dueAt - now) + randInt(SENTINEL_ACT_DELAY_MS[0], SENTINEL_ACT_DELAY_MS[1]);
    sentinelTimer = setTimeout(runSentinelStrike, delay);
    sentinelTimer.unref?.();
    if (dueGid) armSentinelPreEnter(sentinelArmedFor);
}

// 偷菜 due 连续「已过期仍未被一轮成功巡查清掉」的次数；恢复到未来 due 即清零。
let stealOverdueStrikes = 0;

function armStealWake(now = Date.now()) {
    const watchlistDue = Number(getNextWatchlistStealDueAtMs()) || 0;
    const dueAt = mergeDueAt(
        Number(getNextStealDueAtMs()) || 0,
        getNextWatchDueAt(now),
        watchlistDue
    );
    if (dueAt > now) {
        stealOverdueStrikes = 0;
        // 普通偷菜按成熟墙钟一次性到点唤醒；若 dueAt 来自 HOT/PREARM，
        // 它本身就是该目标下一次独立进门时刻，不需要全好友摘要轮询。
        // 重点好友催熟兜底（2026-09-22）：催熟可从任意时刻直接立即可偷，
        // 122 分钟观察窗与窗口外 5-8 分钟巡田都盖不住「窗口外催熟→秒偷」；
        // 有重点好友挂未来成熟墙钟时加 60-120s 摘要刷新下限（一次
        // getAllFriends 覆盖全部好友），瞬熟立即出现在摘要可偷列表走既有
        // 抢收、普通施肥提前触发摘要跳变 HOT。真实到期更近时 min 自然取
        // 真实值，HOT/PREARM 的更短到期不受影响。
        const summaryFloorMs = watchlistDue > now
            ? gaussianInt(PRIORITY_SUMMARY_FLOOR_MIN_MS, PRIORITY_SUMMARY_FLOOR_MAX_MS)
            : 0;
        nextStealRunAt = Math.min(
            dueAt + randInt(30, 120),
            summaryFloorMs > 0 ? now + summaryFloorMs : Number.POSITIVE_INFINITY
        );
        markStealDueAt(dueAt);
        armMaturitySentinel(now);
        return;
    }
    armMaturitySentinel(now);
    if (dueAt > 0) {
        // 过期 due 从第一次重试起就使用短退避；连续清不掉再指数退避 + 抖动，
        // 避免统一 tick 的 100ms 地板把 GetAll 打成固定间隔请求风暴。
        nextStealRunAt = now + stealOverdueBackoffMs(stealOverdueStrikes);
        stealOverdueStrikes = Math.min(stealOverdueStrikes + 1, 8);
        markStealDueAt(dueAt);
        return;
    }
    stealOverdueStrikes = 0;
    nextStealRunAt = now + stealRediscoveryDelayMs();
    markStealDueAt(0);
}

async function runStealTick(autoConfig) {
    if (stealTaskRunning || friendSyncPaused) return;
    if (!autoConfig.friend_steal) return;
    stealTaskRunning = true;

    try {
        // 同时到点时先保护自己的菜；失败或仍在成熟保护窗口内，本轮不进好友农场。
        if (autoConfig.farm && autoConfig.harvest && ownHarvestIsDue()) {
            await runOwnHarvestStrike();
        }
        if (ownHarvestIsDue() || ownHarvestIsImminent(10_000)) return;
        await checkFriends({ onlySteal: true });
    } catch (err) {
        if (!isTransientNetworkError(err)) {
            log('系统', `偷菜巡查执行失败: ${  err.message}`, {
                module: 'system',
                event: '偷菜巡查',
                result: 'error'
            });
        }
    } finally {
        armStealWake();
        stealTaskRunning = false;
    }
}

// ==================== 统一调度器 ====================

// ===== 自定义免打扰：pauseUntil 到点前所有检测短路（WS 心跳保留，不掉线）=====
let lastPauseAnnounceAt = 0;

function pauseRemainMsNow() {
    return Math.max(0, getPauseRemainMs(process.env.FARM_ACCOUNT_ID || ''));
}

async function runUnifiedTick() {
    if (!unifiedSchedulerRunning || !loginReady || friendSyncPaused) return;

    // 免打扰：偷菜/农场/帮助/推送全部不做，只等唤醒
    const pauseRemain = pauseRemainMsNow();
    if (pauseRemain > 0) {
        markIdleQuietUntil(0);
        pauseAceReports();
        const now = Date.now();
        if (now - lastPauseAnnounceAt > 10 * 60_000) {
            lastPauseAnnounceAt = now;
            log('系统', `免打扰中，${formatIdleRemain(pauseRemain)}内不做任何检测`, {
                module: 'system',
                event: '免打扰',
                pauseRemainMs: pauseRemain,
            });
        }
        nextFarmRunAt = now + pauseRemain;
        nextHelpRunAt = now + pauseRemain;
        nextStealRunAt = now + pauseRemain;
        markStealDueAt(now + pauseRemain);
        return;
    }

    resumeAceReports();
    markIdleQuietUntil(0);

    const now = Date.now();
    const autoConfig = getAutomation();
    const ownDue = ownHarvestDueAt();
    if (autoConfig.farm && autoConfig.harvest && ownDue > 0) {
        armOwnHarvestGuard(now);
        if (ownHarvestIsDue(now)) {
            const retryWakeAt = now + 1000;
            if (nextFarmRunAt <= retryWakeAt) nextFarmRunAt = retryWakeAt;
            if (nextHelpRunAt <= retryWakeAt) nextHelpRunAt = retryWakeAt + 300;
            if (nextStealRunAt <= retryWakeAt) nextStealRunAt = retryWakeAt + 500;
            return;
        }
        if (ownHarvestIsImminent(OWN_HARVEST_RESERVE_MS, now)) {
            // 最后十秒不再启动好友/帮助/普通农场事务，给精确定时 Harvest 留出通道。
            const resumeAt = ownDue + 200;
            if (nextFarmRunAt <= resumeAt) nextFarmRunAt = resumeAt;
            if (nextHelpRunAt <= resumeAt) nextHelpRunAt = resumeAt + 300;
            if (nextStealRunAt <= resumeAt) nextStealRunAt = resumeAt + 500;
            return;
        }
    }
    const stealAt = nextScheduledStealAt();
    const shouldFarm = now >= nextFarmRunAt;
    const shouldHelp = now >= nextHelpRunAt;
    const shouldSteal = stealAt > 0 && now >= stealAt;

    if (!shouldFarm && !shouldHelp && !shouldSteal && !stealIsImminent(1500)) return;

    if (!autoConfig.friend_steal) {
        nextStealRunAt = now + STEAL_IDLE_MS;
        markStealDueAt(0);
    } else if (shouldSteal || stealIsDue()) {
        await runStealTick(autoConfig);
        return;
    } else if (stealIsImminent(1500)) {
        const afterSteal = nextScheduledStealAt() + 200;
        if (nextFarmRunAt <= now) nextFarmRunAt = afterSteal;
        if (nextHelpRunAt <= now) nextHelpRunAt = afterSteal + 300;
        return;
    }
    if (shouldFarm) await runFarmTick(autoConfig);
    if (shouldHelp) await runHelpTick(autoConfig);
}

function scheduleUnifiedNextTick() {
    if (!unifiedSchedulerRunning) return;
    workerScheduler.clear('unified_next_tick');

    if (!loginReady) {
        workerScheduler.setTimeoutTask('unified_next_tick', 500, async () => {
            try { await runUnifiedTick(); } finally { scheduleUnifiedNextTick(); }
        });
        return;
    }

    const now = Date.now();
    const pauseRemain = pauseRemainMsNow();
    const stealAt = pauseRemain > 0 ? now + pauseRemain : nextScheduledStealAt();
    const nearest = Math.min(
        Number(nextFarmRunAt) || now + 8000,
        Number(nextHelpRunAt) || now + 30000,
        Number(stealAt) || now + STEAL_IDLE_MS
    );
    const waitMs = Math.max(100, nearest - now);
    if (waitMs >= 60_000) {
        markIdleQuietUntil(now + waitMs);
        pauseAceReports();
    } else {
        markIdleQuietUntil(0);
        resumeAceReports();
    }

    workerScheduler.setTimeoutTask('unified_next_tick', waitMs, async () => {
        try { await runUnifiedTick(); } finally { scheduleUnifiedNextTick(); }
    });
}

function startUnifiedScheduler() {
    if (unifiedSchedulerRunning) return;
    unifiedSchedulerRunning = true;
    resetUnifiedSchedule();
    armOwnHarvestGuard();
    scheduleUnifiedNextTick();
}

function stopUnifiedScheduler() {
    unifiedSchedulerRunning = false;
    farmTaskRunning = false;
    helpTaskRunning = false;
    stealTaskRunning = false;
    markStealDueAt(0);
    clearOwnHarvestGuard(true);
    workerScheduler.clear('unified_next_tick');
}

// ==================== 配置同步 ====================

function applyRuntimeConfig(config, syncStatusAfter = false) {
    const prevAuto = getAutomation();
    const accountId = process.env.FARM_ACCOUNT_ID || '';

    applyConfigSnapshot(config || {}, {
        persist: false,
        accountId
    });

    const revision = Number((config || {}).__revision || 0);
    if (revision > 0) appliedConfigRevision = revision;

    const intervals = config && config.intervals && typeof config.intervals === 'object'
        ? config.intervals : null;
    if (intervals) applyIntervalsToRuntime(intervals);

    if (loginReady) {
        refreshFarmCheckLoop(3000);
        refreshFriendCheckLoop(12000);
        resetUnifiedSchedule();
        armOwnHarvestGuard();
        scheduleUnifiedNextTick();

        const hasAutomation = !!(config && config.automation && typeof config.automation === 'object');
        if (hasAutomation) {
            const newAuto = getAutomation();

            const mysteryShopConfigChanged = [
                'mystery_shop_auto_buy',
                'mystery_shop_allow_gold',
                'mystery_shop_allow_coupon',
                'mystery_shop_allow_gold_bean'
            ].some(key => prevAuto?.[key] !== newAuto?.[key]);
            if (newAuto?.mystery_shop_auto_buy && mysteryShopConfigChanged) {
                workerScheduler.setTimeoutTask('mystery_shop_auto_buy_after_save', 2000, () => {
                    runMysteryShopAutoBuy().catch(() => null);
                });
            }

            // 每日任务从关变开 → 立即执行一次
            const prevDailyEnabled = isDailyRoutineEnabled(prevAuto);
            const newDailyEnabled = isDailyRoutineEnabled(newAuto);
            if (!prevDailyEnabled && newDailyEnabled) {
                workerScheduler.setTimeoutTask('daily_routine_immediate', 2000, () => {
                    runDailyRoutines(true).catch(() => null);
                });
            }

            // 施肥策略变化 → 立即施肥
            const prevFert = String(prevAuto && prevAuto.fertilizer ? prevAuto.fertilizer : '').toLowerCase();
            const newFert = String(newAuto && newAuto.fertilizer ? newAuto.fertilizer : '').toLowerCase();
            const fertChanged = prevFert !== newFert;
            if (fertChanged && (newFert === 'both' || newFert === 'organic' || newFert === 'smart' || newFert === 'smart_only' || newFert === 'smart_normal' || newFert === 'final_normal' || newFert === 'final_organic')) {
                workerScheduler.setTimeoutTask('fertilizer_immediate_after_save', 1000, async () => {
                    if (!loginReady) return;
                    try {
                        await runFertilizerByConfig([], { skipNormal: true });
                    } catch (err) {
                        log('施肥', `保存配置后立即施肥失败: ${  err.message}`, {
                            module: 'farm', event: '施肥', result: 'error'
                        });
                    }
                });
            }

            // 好友捣乱从关变开 → 立即执行
            const prevBad = !!(prevAuto && prevAuto.friend_bad);
            const newBad = !!(newAuto && newAuto.friend_bad);
            if (!prevBad && newBad) {
                workerScheduler.setTimeoutTask('friend_bad_immediate', 3000, async () => {
                    if (!loginReady) return;
                    try {
                        await runBadOnceOnStartup(true);
                    } catch (err) {
                        log('好友', `开启自动捣乱后立即执行失败: ${  err.message}`, {
                            module: 'friend', event: '开启捣乱立即执行', result: 'error'
                        });
                    }
                });
            }

            const prevGoldenBug = !!(prevAuto && prevAuto.friend_golden_bug);
            const newGoldenBug = !!(newAuto && newAuto.friend_golden_bug);
            if (!prevGoldenBug && newGoldenBug) {
                workerScheduler.setTimeoutTask('friend_golden_bug_immediate', 3000, async () => {
                    if (!loginReady) return;
                    await runGoldenBugPlacement({ force: true });
                });
            }
        }
    }

    if (syncStatusAfter) syncStatus();
}

// ==================== 主控消息处理 ====================

onMasterMessage(async (msg) => {
    try {
        if (msg.type === 'start') {
            await startBot(msg.config);
        } else if (msg.type === 'stop') {
            await stopBot();
        } else if (msg.type === 'api_call') {
            handleApiCall(msg);
        } else if (msg.type === 'config_sync') {
            applyRuntimeConfig(msg.config || {}, true);
        } else if (msg.type === 'watchdog_ping') {
            sendToMaster({ type: 'watchdog_pong', at: msg.at || Date.now() });
        }
    } catch (err) {
        sendToMaster({ type: 'error', error: err.message });
    }
});

// ==================== 启动/停止 Bot ====================

async function startBot(config) {
    if (isRunning) return;
    isRunning = true;

    const { code, platform } = config;
    CONFIG.platform = platform || 'qq';

    await loadProto();
    log('系统', '正在连接服务器...');

    applyRuntimeConfig(getConfigSnapshot(), false);
    initStatusBar();
    setStatusPlatform(CONFIG.platform);

    // WebSocket 错误监听
    if (onWsError) {
        networkEvents.off('ws_error', onWsError);
        onWsError = null;
    }
    onWsError = (wsErr) => {
        if ((Number(wsErr?.code) || 0) !== 400) return;
        const now = Date.now();
        if (now - wsErrorHandledAt < 5000) return;
        wsErrorHandledAt = now;

        log('系统', '连接被拒绝，可能需要更新 Code');
        sendToMaster({
            type: 'ws_error',
            code: 400,
            message: wsErr?.message || ''
        });
        if (isRunning) {
            workerScheduler.setTimeoutTask('ws_error_cleanup', 500, () => {
                if (isRunning) stopBot().catch(() => exitWorker(0));
            });
        }
    };
    networkEvents.on('ws_error', onWsError);
    networkEvents.on('reconnect_failed', onReconnectFailed);
    networkEvents.on('kickout', onKickout);
    networkEvents.on('friendLandsChanged', onFriendLandsChanged);

    if (onClientVersionUpdate) networkEvents.off('client_version_update', onClientVersionUpdate);
    onClientVersionUpdate = ({ clientVersion, previous }) => {
        sendToMaster({
            type: 'client_version_update',
            clientVersion: String(clientVersion || ''),
            previous: String(previous || '')
        });
    };
    networkEvents.on('client_version_update', onClientVersionUpdate);

    // 断线监听
    if (onDisconnectHandler) networkEvents.off('disconnect', onDisconnectHandler);
    onDisconnectHandler = () => {
        if (!loginReady) return;
        loginReady = false;
        log('系统', '连接断开，暂停自动化任务，等待重连...');
    };
    networkEvents.on('disconnect', onDisconnectHandler);

    // 登录成功回调
    const onReady = async () => {
        loginReady = true;

        // 出售收益监听
        if (onSellGain) networkEvents.off('sell', onSellGain);
        onSellGain = (sellInfo) => {
            const gold = Number(sellInfo && sellInfo.gold || sellInfo || 0);
            const count = Number(sellInfo && sellInfo.count || 0);
            if (!Number.isFinite(gold) || gold <= 0) return;
            if (count > 0) recordOperation('sell', count);
        };
        networkEvents.on('sell', onSellGain);

        // 收获后自动出售
        if (onFarmHarvested) networkEvents.off('farmHarvested', onFarmHarvested);
        onFarmHarvested = async () => {
            if (harvestSellRunning) return;
            if (!getAutomation().sell) return;
            harvestSellRunning = true;
            try {
                await sellAllFruits();
            } catch (err) {
                log('仓库', `收获后自动出售失败: ${  err.message}`, {
                    module: 'warehouse', event: '收获后出售', result: 'error'
                });
            } finally {
                harvestSellRunning = false;
            }
        };
        networkEvents.on('farmHarvested', onFarmHarvested);

        if (onOwnMaturityChanged) networkEvents.off('ownMaturityChanged', onOwnMaturityChanged);
        onOwnMaturityChanged = () => {
            armOwnHarvestGuard();
            // 新墙钟也立即参与下一轮状态与统一调度重算，但自己的精确定时器独立运行。
            if (unifiedSchedulerRunning) scheduleUnifiedNextTick();
        };
        networkEvents.on('ownMaturityChanged', onOwnMaturityChanged);

        if (onDogSkillGiftPending) networkEvents.off('dogSkillGiftPending', onDogSkillGiftPending);
        onDogSkillGiftPending = (count) => {
            const pendingCount = Math.max(0, toNum(count));
            if (!loginReady || pendingCount <= 0) return;
            require('../services/dog-skill-gifts').checkAndClaimDogSkillGifts(pendingCount).catch(() => null);
        };
        networkEvents.on('dogSkillGiftPending', onDogSkillGiftPending);

        // 获取背包点券数
        try {
            const bag = await getBag();
            const items = getBagItems(bag);
            let couponCount = 0;
            for (const item of items || []) {
                if (toNum(item && item.id) === 1002) {
                    couponCount = toNum(item.count);
                    break;
                }
            }
            const state = getUserState();
            state.coupon = Math.max(0, couponCount);
        } catch { }

        // 初始化统计数据
        const userState = getUserState();
        const accountId = process.env.FARM_ACCOUNT_ID || '';
        initStatsWithPersistence(
            accountId,
            Number(userState.gold || 0),
            Number(userState.exp || 0),
            Number(userState.coupon || 0)
        );
        resetSessionGains();

        // 处理邀请码
        await processInviteCodes();

        // 打开肥料礼包
        if (getAutomation().fertilizer_gift) {
            await openFertilizerGiftPacksSilently().catch(() => 0);
        }

        // 延迟执行放虫放草
        workerScheduler.setTimeoutTask('bad_startup_once', 15000, async () => {
            try {
                await runBadOnceOnStartup();
            } catch (err) {
                log('好友', `启动时放虫放草执行失败: ${  err.message}`, {
                    module: 'friend', event: '启动放虫放草失败', error: err.message
                });
            }
        });

        // 启动各检查循环
        startFarmCheckLoop({ externalScheduler: true });
        startFriendCheckLoop({ externalScheduler: true });
        // 重点巡田读到新成熟时刻时立即重排偷菜唤醒
        setArmStealWakeCallback(armStealWake);
        armOwnHarvestGuard();

        // 启动统一调度器
        if (unifiedSchedulerRunning) {
            resetUnifiedSchedule();
            scheduleUnifiedNextTick();
        } else {
            startUnifiedScheduler();
        }

        // 启动每日定时器
        startDailyRoutineTimer();
        startMysteryShopAutoBuyTimer();

        syncStatus();
    };

    // 建立连接
    connect(code, onReady);

    // 定期同步状态
    workerScheduler.setIntervalTask('status_sync', 5000, syncStatus, { preventOverlap: true });
}

async function stopBot() {
    if (!isRunning) return exitWorker(0);
    saveStats();
    isRunning = false;
    loginReady = false;
    friendSyncPaused = false;

    clearSentinel();
    stopUnifiedScheduler();
    stopMysteryShopAutoBuyTimer();

    networkEvents.off('kickout', onKickout);
    networkEvents.off('reconnect_failed', onReconnectFailed);
    networkEvents.off('friendLandsChanged', onFriendLandsChanged);
    if (onClientVersionUpdate) {
        networkEvents.off('client_version_update', onClientVersionUpdate);
        onClientVersionUpdate = null;
    }

    if (onDisconnectHandler) {
        networkEvents.off('disconnect', onDisconnectHandler);
        onDisconnectHandler = null;
    }
    if (onWsError) {
        networkEvents.off('ws_error', onWsError);
        onWsError = null;
    }
    if (onSellGain) {
        networkEvents.off('sell', onSellGain);
        onSellGain = null;
    }
    if (onFarmHarvested) {
        networkEvents.off('farmHarvested', onFarmHarvested);
        onFarmHarvested = null;
    }
    if (onOwnMaturityChanged) {
        networkEvents.off('ownMaturityChanged', onOwnMaturityChanged);
        onOwnMaturityChanged = null;
    }
    if (onDogSkillGiftPending) {
        networkEvents.off('dogSkillGiftPending', onDogSkillGiftPending);
        onDogSkillGiftPending = null;
    }

    stopFarmCheckLoop();
    stopFriendCheckLoop();
    stopDailyRoutineTimer();
    cleanupTaskSystem();
    workerScheduler.clearAll();
    stopNetwork('账号停止');

    const ws = getWs();
    if (ws) ws.close();

    exitWorker(0);
}

// ==================== 踢下线处理 ====================

function onKickout(info) {
    const reason = info && info.reason ? info.reason : '未知';
    log('系统', `检测到踢下线，准备自动停止账号。原因: ${  reason}`);
    require('../services/daily-events').recordEvent(
        process.env.FARM_ACCOUNT_ID || '', 'warn', 'kickout', `被踢下线：${reason}`);
    sendToMaster({ type: 'account_kicked', reason });
    workerScheduler.setTimeoutTask('kickout_stop', 500, () => {
        stopBot().catch(() => exitWorker(0));
    });
}

function onReconnectFailed(info) {
    const reason = info && info.reason ? info.reason : '未知';
    log('系统', `连接多次重试失败，准备停止账号。原因: ${  reason}`);
    require('../services/daily-events').recordEvent(
        process.env.FARM_ACCOUNT_ID || '', 'warn', 'reconnect_failed', '网络连接多次重试失败');
    sendToMaster({ type: 'ws_reconnect_failed', reason });
    stopBot().catch(() => exitWorker(0));
}

/** 好友农场地块变化推送：检测催熟/施肥痕迹，触发盯梢并立即重排偷菜唤醒 */
function onFriendLandsChanged(info) {
    const hostGid = toNum(info && info.hostGid);
    const lands = info && info.lands;
    if (!hostGid || !Array.isArray(lands) || lands.length === 0) return;
    try {
        // LandsNotify 只包含发生变化的地块，必须与既有地块基线合并。
        inspectFriendLands(hostGid, '', lands, Date.now(), { partial: true });
        // 推送即活跃（2026-09-23 实验确认通道存活）：好友农场有动作的毫秒级
        // 证据——进活跃表后巡田自动收紧到 45-75s，施肥证据则直接进 HOT。
        require('../services/friend-activity').recordActivity(hostGid, Date.now(), 'lands_push',
            `${lands.length} lands changed`);
        // 推送即出手窗口（2026-09-23 用户定标）：不等 1s 档 tick，直接把该好友
        // 的巡田拉近到 ~300ms 后——推送→进门→偷 的端到端压到 1 秒内。
        require('../services/friend').pullWatchlistPollToNow(hostGid, 300);
        armStealWake();
    } catch { }
}

// ==================== API 调用处理 ====================

// 好友面板入口的就绪闸门（2026-09-18 启动竞态收口）：协议加载/登录完成/
// 连接打开任一不满足时，直接按既有响应结构返回本地错误——零上游请求、
// 不等待登录、不轮询、不设置好友同步暂停。协议就绪不等于登录就绪；
// 主进程侧的外层超时也不会取消 Worker 内部任务，所以未就绪必须就地收口。
// 该集合与下方 isFriendSync 三入口保持一致，不得扩散到其他面板方法，
// 更不得接入自己收获/偷菜/HOT/PREARM 等收益链路径。
const FRIEND_PANEL_ENTRY_METHODS = new Set([
    'getFriends',
    'fetchFriendsDogInfo',
    'syncFriendsFromGids',
]);

// 萌宠手动操作的业务错误元数据（2026-09-20 跨 Worker 丢失修复）：
// pet-diary-operate 抛出的业务拒绝带 business 标记 + 固定 code，旧管理通道
// 只回传 error 字符串导致下游一律按 502 服务故障处理。此处只收集严格布尔
// 标记与限定格式的固定业务码（PET_DIARY_ 前缀），不序列化整个 Error、堆栈、
// cause 或任意附加属性，也不扩大到其他业务错误。
const PET_DIARY_ERROR_CODE_RE = /^PET_DIARY_[A-Z0-9_]{1,48}$/;

function collectPetDiaryErrorMeta(err) {
    if (!err || err.business !== true) return null;
    const code = err.code;
    if (typeof code !== 'string' || !PET_DIARY_ERROR_CODE_RE.test(code)) return null;
    return { business: true, code };
}

/**
 * 只读探测：好友摘要字段在线漂移验证（2026-09-22）。
 * 拉两次 force-refresh 摘要（间隔 gapMs，默认 15s），逐好友 diff
 * gold/level/tags/plant 子字段，返回漂移明细 + 完整前后快照（脱敏 gid）。
 * 目的：验证「好友在线期间摘要字段会变」是否成立，为在线检测选字段。
 */
async function probeFriendSummaryDrift(gapMs = 15_000) {
    const gap = Math.max(5_000, Math.min(60_000, Number(gapMs) || 15_000));
    const snapshotFields = (friend) => ({
        level: Number(friend && friend.level) || 0,
        gold: Number(friend && friend.gold) || 0,
        tags: friend && friend.tags ? JSON.stringify(friend.tags) : '',
        plant: friend && friend.plant ? {
            stealPlantNum: Number(friend.plant.stealPlantNum ?? friend.plant.steal_plant_num) || 0,
            dryNum: Number(friend.plant.dryNum ?? friend.plant.dry_num) || 0,
            weedNum: Number(friend.plant.weedNum ?? friend.plant.weed_num) || 0,
            insectNum: Number(friend.plant.insectNum ?? friend.plant.insect_num) || 0,
            ripeTimeSec: Number(friend.plant.ripeTimeSec ?? friend.plant.ripe_time_sec) || 0,
        } : null,
    });
    const before = await getFriendsList(true);
    const beforeMap = new Map((before.friends || before || []).map(f => [Number(f.gid), f]));
    await new Promise(resolve => setTimeout(resolve, gap));
    const after = await getFriendsList(true);
    const afterMap = new Map((after.friends || after || []).map(f => [Number(f.gid), f]));

    const drifts = [];
    for (const [gid, friend] of afterMap) {
        const prev = beforeMap.get(gid);
        if (!prev) continue;
        const a = snapshotFields(prev);
        const b = snapshotFields(friend);
        const changed = [];
        if (a.level !== b.level) changed.push(`level ${a.level}→${b.level}`);
        if (a.gold !== b.gold) changed.push(`gold ${a.gold}→${b.gold}`);
        if (a.tags !== b.tags) changed.push('tags');
        if (JSON.stringify(a.plant) !== JSON.stringify(b.plant)) {
            if (a.plant && b.plant) {
                for (const key of Object.keys(a.plant)) {
                    if (a.plant[key] !== b.plant[key]) changed.push(`${key} ${a.plant[key]}→${b.plant[key]}`);
                }
            } else changed.push('plant presence');
        }
        if (changed.length > 0) {
            drifts.push({ name: friend.name || friend.remark || '', changed });
        }
    }
    log('系统', `摘要漂移探测完成：${drifts.length}/${afterMap.size} 位好友字段变化（间隔 ${Math.round(gap / 1000)}s）`,
        {
            module: 'system', event: 'summary_drift_probe', result: 'ok',
            gapMs: gap,
            friends: afterMap.size,
            drifted: drifts.length,
            driftDetail: drifts.map(item => `${item.name}: ${item.changed.join(', ')}`).join(' | ').slice(0, 500),
        });
    return {
        gapMs: gap,
        friendsBefore: beforeMap.size,
        friendsAfter: afterMap.size,
        driftedFriends: drifts.length,
        drifts,
        note: 'drifts>0 说明摘要字段在窗口内变化；结合巡田/趋势触发日志可判断是否与在线活动相关',
    };
}

async function handleApiCall(msg) {
    const { id, method, args } = msg;
    let result = null;
    let error = null;
    let errorMeta = null;

    if (FRIEND_PANEL_ENTRY_METHODS.has(method)) {
        const ws = getWs();
        if (!isRunning || !loginReady || !ws || ws.readyState !== 1) {
            sendToMaster({
                type: 'api_response',
                id,
                result: null,
                error: '账号未就绪（未登录或连接未打开），请稍后重试',
            });
            return;
        }
    }

    // 好友同步操作期间暂停自动化
    const isFriendSync = method === 'getFriends' && args[0] === true
        || method === 'fetchFriendsDogInfo'
        || method === 'syncFriendsFromGids';

    if (isFriendSync) {
        friendSyncPaused = true;
        log('系统', '好友同步操作开始，已暂停其他自动化进程', {
            module: 'system', event: '好友同步暂停', method
        });
    }

    try {
        switch (method) {
            case 'getLands':
                result = await require('../services/farm-land-analyzer').getLandsDetailForPanel();
                break;
            case 'getFriends':
                result = await getFriendsList(args[0] === true);
                break;
            case 'probeFriendSummaryDrift':
                // 只读探测（2026-09-22 在线信号验证）：间隔取两次全量好友摘要并
                // diff 字段（gold/level/tags/plant 微态），输出哪些字段在好友
                // 在线期间发生漂移。两次调用走既有 getAllFriends 通道与治理预算。
                result = await probeFriendSummaryDrift(args[0]);
                break;
            case 'clearFriendsCache':
                require('../services/friend').clearFriendsListCache();
                result = { ok: true };
                break;
            case 'getInteractRecords':
                result = await getInteractRecords();
                break;
            case 'getFriendLands':
                result = await getFriendLandsDetail(args[0]);
                armStealWake();
                break;
            case 'doFriendOp':
                result = await doFriendOperation(args[0], args[1]);
                armStealWake();
                break;
            case 'getFriendDogInfo':
                result = await getFriendDogInfo(args[0]);
                armStealWake();
                break;
            case 'batchGetFriendDogInfo':
                result = await batchGetFriendDogInfo(args[0]);
                armStealWake();
                break;
            case 'syncFriendsFromGids':
                result = await syncFriendsFromGids(args[0]);
                break;
            case 'fetchFriendsDogInfo':
                result = await fetchFriendsDogInfo();
                break;
            case 'delFriend':
                result = await delFriend(args[0]);
                break;
            case 'getSeeds':
                result = await getAvailableSeeds();
                break;
            case 'getBag':
                result = await require('../services/warehouse').getBagDetail();
                break;
            case 'getBagSeeds':
                result = await require('../services/warehouse').getBagSeedsForPanel();
                break;
            case 'getDailyEvents':
                result = require('../services/daily-events').getTodayEvents(
                    process.env.FARM_ACCOUNT_ID || '');
                break;
            case 'clearBreaker': {
                const cleared = require('../services/request-governor').clearBreaker();
                if (cleared) {
                    resetUnifiedSchedule();
                    armOwnHarvestGuard();
                    armStealWake();
                    scheduleUnifiedNextTick();
                    log('系统', '异常降速已手动取消，恢复正常巡查', {
                        module: 'system', event: '降速取消', result: 'ok'
                    });
                    require('../services/daily-events').recordEvent(
                        process.env.FARM_ACCOUNT_ID || '', 'info', 'slowdown', '异常降速已手动取消');
                }
                result = { cleared };
                break;
            }
            case 'getDogSkillGiftStatus': {
                const dogGifts = require('../services/dog-skill-gifts');
                result = { pendingCount: dogGifts.getPendingGiftCount(await dogGifts.getDogInfoForPanel()) };
                break;
            }
            case 'claimDogSkillGifts':
                result = await require('../services/dog-skill-gifts').checkAndClaimDogSkillGifts();
                require('../services/dog-skill-gifts').invalidatePanelDogInfoCache();
                break;
            case 'useItem': {
                const { useItem } = require('../services/warehouse');
                const itemId = Number(args[0]) || 0;
                const count = Math.max(1, Number(args[1]) || 1);
                const uid = Number(args[2]) || 0;
                result = await useItem(itemId, count, uid);
                break;
            }
            case 'sellItems': {
                const { sellItems } = require('../services/warehouse');
                const items = Array.isArray(args[0]) ? args[0] : [];
                const totalCount = items.reduce((sum, it) => sum + (Number(it.count) || 0), 0);
                result = await sellItems(items.map(it => ({
                    id: it.id, count: it.count, uid: it.uid || 0
                })));
                if (totalCount > 0) recordOperation('sell', totalCount);
                break;
            }
            case 'setAutomation': {
                const item = args && args[0] ? args[0] : {};
                const patch = { [item.key]: item.value };
                applyRuntimeConfig({ automation: patch }, true);
                result = getAutomation();
                break;
            }
            case 'doFarmOp':
                result = await runFarmOperation(args[0]);
                // 面板触发的农场操作（收获/浇水/除草等）同时变更土地与背包
                require('../services/farm-land-analyzer').invalidatePanelLandsCache();
                require('../services/warehouse').invalidatePanelBagCache();
                break;
            case 'buyFertilizer': {
                const fertType = args[0] || 'organic';
                const count = Number(args[1]) || 1;
                result = await autoBuyFertilizer(true, fertType, count);
                require('../services/warehouse').invalidatePanelBagCache();
                break;
            }
            case 'checkAndBuyFertilizer': {
                const opts = args[0] || {};
                result = await checkAndBuyFertilizerBoth(opts);
                require('../services/warehouse').invalidatePanelBagCache();
                break;
            }
            case 'getAnalytics': {
                const { getPlantRankings } = require('../services/analytics');
                result = getPlantRankings(args[0]);
                break;
            }
            case 'getShopInfo': {
                const { getShopInfo } = require('../services/farm');
                result = await getShopInfo(args[0]);
                break;
            }
            case 'buyGoods': {
                const { buyGoods } = require('../services/farm');
                result = await buyGoods(args[0], args[1], args[2]);
                break;
            }
            case 'getMallGoods': {
                const { getMallGoodsList } = require('../services/mall');
                result = await getMallGoodsList(0);
                break;
            }
            case 'buyMallGoods': {
                const { purchaseMallGoods } = require('../services/mall');
                result = await purchaseMallGoods(args[0], args[1]);
                break;
            }
            case 'getMysteryShop': {
                const { getActiveMysteryShop } = require('../services/mystery-shop');
                result = await getActiveMysteryShop();
                break;
            }
            case 'buyMysteryShopGoods': {
                const { buyMysteryShopGoods } = require('../services/mystery-shop');
                result = await buyMysteryShopGoods(args[0]);
                break;
            }
            case 'abandonMysteryShop': {
                const { abandonMysteryShop } = require('../services/mystery-shop');
                result = await abandonMysteryShop();
                break;
            }
            case 'getActivityDiscoveryList': {
                const { getActivityDiscoveryList } = require('../services/activity');
                result = await getActivityDiscoveryList();
                break;
            }
            case 'getActivityGroupSnapshot': {
                const { getActivityGroupSnapshot } = require('../services/activity');
                result = await getActivityGroupSnapshot(args[0], args[1]);
                break;
            }
            case 'getBearActivity': {
                const { getBearActivity } = require('../services/activity');
                result = await getBearActivity();
                break;
            }
            case 'operatePetDiary': {
                const { runManualPetDiaryAction } = require('../services/pet-diary-operate');
                const { getBag } = require('../services/warehouse');
                const { getBagItems } = require('../services/warehouse');
                result = await runManualPetDiaryAction(args[0], args[1], { getBag, getBagItems });
                break;
            }
            case 'getIllustratedList': {
                const { getIllustratedListV2 } = require('../services/illustrated');
                result = await getIllustratedListV2(args[0], args[1]);
                break;
            }
            case 'claimIllustratedRewards': {
                const { claimAllRewardsV2 } = require('../services/illustrated');
                result = await claimAllRewardsV2(args[0]);
                break;
            }
            case 'getCareerInfo': {
                const { getCareerInfo } = require('../services/career');
                result = await getCareerInfo(args[0]);
                break;
            }
            case 'getDailyGiftOverview':
                result = await getDailyGiftOverview();
                break;
            case 'getSchedulers':
                result = getSchedulerRegistrySnapshot();
                break;
            case 'fertilizeLand': {
                const landId = Number(args[0]) || 0;
                if (!landId) {
                    error = '无效的土地ID';
                } else {
                    log('施肥', `正在对土地 ${  landId  } 使用有机肥料催熟`, {
                        module: 'farm', event: '催熟', landId
                    });
                    const fertilizeCount = await fertilize([landId], ORGANIC_FERTILIZER_ID);
                    if (fertilizeCount > 0) {
                        log('施肥', `土地 ${  landId  } 催熟成功`, {
                            module: 'farm', event: '催熟', result: 'ok', landId
                        });
                        result = { success: true, count: fertilizeCount };
                    } else {
                        log('施肥', `土地 ${  landId  } 催熟失败，可能有机肥料不足`, {
                            module: 'farm', event: '催熟', result: 'error', landId
                        });
                        result = { success: false, count: 0 };
                    }
                    // 面板催熟同时变更土地与背包化肥数量
                    require('../services/farm-land-analyzer').invalidatePanelLandsCache();
                    require('../services/warehouse').invalidatePanelBagCache();
                }
                break;
            }
            case 'removePlant': {
                const landId = Number(args[0]) || 0;
                if (!landId) {
                    error = '无效的土地ID';
                } else {
                    result = await removePlant([landId]);
                    require('../services/farm-land-analyzer').invalidatePanelLandsCache();
                }
                break;
            }
            case 'removeAllPlants': {
                const landsDetail = await getLandsDetail();
                const lands = landsDetail?.lands || [];
                const occupiedLands = lands
                    .filter(l => l && l.unlocked && l.status !== 'empty' && l.status !== 'locked')
                    .map(l => l.id);

                if (occupiedLands.length === 0) {
                    result = { removed: 0, message: '没有可铲除的作物' };
                } else {
                    await removePlant(occupiedLands);
                    log('铲除', `已铲除 ${  occupiedLands.length  } 块土地上的作物`, {
                        module: 'farm', event: '一键铲除', result: 'ok', count: occupiedLands.length
                    });
                    result = { removed: occupiedLands.length };
                }
                require('../services/farm-land-analyzer').invalidatePanelLandsCache();
                break;
            }
            default:
                error = 'Unknown method';
        }
    } catch (err) {
        error = err.message;
        errorMeta = collectPetDiaryErrorMeta(err);
    }

    if (isFriendSync) {
        friendSyncPaused = false;
        log('系统', '好友同步操作完成，已恢复自动化进程', {
            module: 'system', event: '好友同步恢复', method
        });
    }

    sendToMaster({
        type: 'api_response',
        id,
        result,
        error,
        ...(errorMeta ? { errorMeta } : {})
    });
}

// ==================== 每日礼包总览 ====================

async function getDailyGiftOverview() {
    const auto = getAutomation() || {};
    const accountId = process.env.FARM_ACCOUNT_ID || '';
    const withPersistedDone = (key, serviceState) => ({
        ...(serviceState || {}),
        doneToday: !!(serviceState && serviceState.doneToday)
            || isDailyRoutineDone(accountId, key),
    });

    const taskState = getTaskDailyStateLikeApp
        ? await getTaskDailyStateLikeApp()
        : getTaskClaimDailyState ? getTaskClaimDailyState() : { doneToday: false, lastClaimAt: 0 };

    const growthState = getGrowthTaskStateLikeApp
        ? await getGrowthTaskStateLikeApp()
        : { doneToday: false, completedCount: 0, totalCount: 0, tasks: [] };

    const emailState = withPersistedDone('email_rewards', getEmailDailyState
        ? getEmailDailyState()
        : { doneToday: false, lastCheckAt: 0 });

    const freeGiftState = withPersistedDone('mall_free_gifts', getFreeGiftDailyState
        ? getFreeGiftDailyState()
        : { doneToday: false, lastClaimAt: 0 });

    const shareState = withPersistedDone('daily_share', getShareDailyState
        ? getShareDailyState()
        : { doneToday: false, lastClaimAt: 0 });

    const vipState = withPersistedDone('vip_daily_gift', getVipDailyState
        ? getVipDailyState()
        : { doneToday: false, lastClaimAt: 0 });

    const monthCardState = withPersistedDone('month_card_gift', getMonthCardDailyState
        ? getMonthCardDailyState()
        : { doneToday: false, lastClaimAt: 0 });

    return {
        date: new Date().toISOString().slice(0, 10),
        growth: {
            key: 'growth_task',
            label: '成长任务',
            doneToday: !!growthState.doneToday,
            completedCount: Number(growthState.completedCount || 0),
            totalCount: Number(growthState.totalCount || 0),
            tasks: Array.isArray(growthState.tasks) ? growthState.tasks : []
        },
        gifts: [
            {
                key: 'task_claim',
                label: '每日任务',
                enabled: !!auto.task,
                doneToday: !!taskState.doneToday,
                lastAt: Number(taskState.lastClaimAt || 0),
                completedCount: Number(taskState.completedCount || 0),
                totalCount: Number(taskState.totalCount || 0)
            },
            {
                key: 'email_rewards',
                label: '邮箱奖励',
                enabled: true,
                doneToday: !!emailState.doneToday,
                lastAt: Number(emailState.lastCheckAt || 0)
            },
            {
                key: 'mall_free_gifts',
                label: '商城免费礼包',
                enabled: true,
                doneToday: !!freeGiftState.doneToday,
                lastAt: Number(freeGiftState.lastClaimAt || 0)
            },
            {
                key: 'daily_share',
                label: '分享礼包',
                enabled: true,
                doneToday: !!shareState.doneToday,
                lastAt: Number(shareState.lastClaimAt || 0)
            },
            {
                key: 'vip_daily_gift',
                label: '会员礼包',
                enabled: true,
                doneToday: !!vipState.doneToday,
                lastAt: Number(vipState.lastClaimAt || vipState.lastCheckAt || 0),
                hasGift: Object.hasOwn(vipState, 'hasGift') ? !!vipState.hasGift : undefined,
                canClaim: Object.hasOwn(vipState, 'canClaim') ? !!vipState.canClaim : undefined,
                result: vipState.result || ''
            },
            {
                key: 'month_card_gift',
                label: '月卡礼包',
                enabled: true,
                doneToday: !!monthCardState.doneToday,
                lastAt: Number(monthCardState.lastClaimAt || monthCardState.lastCheckAt || 0),
                hasCard: Object.hasOwn(monthCardState, 'hasCard') ? !!monthCardState.hasCard : undefined,
                hasClaimable: Object.hasOwn(monthCardState, 'hasClaimable') ? !!monthCardState.hasClaimable : undefined,
                result: monthCardState.result || ''
            }
        ]
    };
}

// ==================== 状态同步 ====================

function syncStatus() {
    if (!process.send && !parentPort) return;

    const userState = getUserState();
    const ws = getWs();
    const connected = !!(loginReady && ws && ws.readyState === 1);

    let levelProgress = null;
    const level = userState.level ?? statusData.level ?? 0;
    const exp = userState.exp ?? statusData.exp ?? 0;
    if (level > 0 && exp >= 0) {
        levelProgress = getLevelExpProgress(level, exp);
    }

    const limits = require('../services/friend').getOperationLimits();
    const stats = require('../services/stats').getStats(statusData, userState, connected, limits);

    const now = Date.now();
    const farmRemainSec = Math.max(0, Math.ceil((Number(nextFarmRunAt || 0) - now) / 1000));
    // 帮助经验到上限：帮忙全停，「下次帮助」的下一个真实事件是北京时间跨日恢复，
    // 倒计时按这个算（不是写死文案）；未到上限则照常按 tick 间隔
    const { getCanGetHelpExp } = require('../services/friend-operation-limits');
    const expCapped = getAutomation().friend_help_exp_limit === true && !getCanGetHelpExp();
    let helpRemainSec;
    if (expCapped) {
        const { getServerTimeSec } = require('../utils/utils');
        const serverMs = (getServerTimeSec() > 0 ? getServerTimeSec() * 1000 : now) + 8 * 3600 * 1000;
        const cnNextMidnightUtcMs = Date.UTC(
            new Date(serverMs).getUTCFullYear(),
            new Date(serverMs).getUTCMonth(),
            new Date(serverMs).getUTCDate() + 1
        ) - 8 * 3600 * 1000;
        helpRemainSec = Math.max(0, Math.ceil((cnNextMidnightUtcMs - now) / 1000));
    } else {
        helpRemainSec = Math.max(0, Math.ceil((Number(nextHelpRunAt || 0) - now) / 1000));
    }
    const stealDue = resolveStealDueAt(now);
    const stealPending = stealDue > 0 && stealDue <= now;
    const stealKnownRemainSec = stealDue > now
        ? Math.max(0, Math.ceil((stealDue - now) / 1000))
        : 0;
    const stealCheckAt = nextScheduledStealAt();
    // 卡片标题是“下次检查倒计时”，主值必须是真实调度的下次
    // 摘要/抢收检查，不能再拿“已知成熟墙钟”冒充。
    const stealRemainSec = !stealPending && stealCheckAt > now
        ? Math.max(0, Math.ceil((stealCheckAt - now) / 1000))
        : 0;
    const stealRetryRemainSec = stealPending
        ? Math.max(0, Math.ceil((nextScheduledStealAt() - now) / 1000))
        : 0;

    const slowdownNow = getBreakerState(now);
    stats.slowdown = slowdownNow.active
        ? {
            active: true,
            remainSec: Math.max(0, Math.ceil((slowdownNow.until - now) / 1000)),
            recommendedDelaySec: Math.ceil((slowdownNow.recommendedDelayMs || 0) / 1000),
        }
        : { active: false, remainSec: 0, recommendedDelaySec: 0 };
    // 兼容旧面板字段：新机制不再存在整号硬熔断。
    stats.breaker = { active: false, remainSec: 0 };

    // 重点监控好友的成熟倒计时快照（面板展示 + 设置参考）
    stats.watchlistRipe = require('../services/friend').getWatchlistRipeSnapshots(now);
    stats.watchlistWakeBeforeMinutes = Math.round(getWatchlistWakeBeforeMs() / 60000);

    stats.nextChecks = {
        farmRemainSec,
        helpRemainSec,
        helpExpCapped: expCapped,
        stealRemainSec,
        stealKnownRemainSec,
        stealPending,
        stealRetryRemainSec,
        friendRemainSec: Math.max(helpRemainSec, stealRemainSec)
    };
    stats.automation = getAutomation();
    stats.preferredSeed = getPreferredSeed();
    stats.levelProgress = levelProgress;
    stats.configRevision = appliedConfigRevision;

    const hash = JSON.stringify(stats);
    const now2 = Date.now();

    if (hash !== lastStatusHash || now2 - lastStatusSentAt > 30000) {
        lastStatusHash = hash;
        lastStatusSentAt = now2;
        sendToMaster({ type: 'status_sync', data: stats });
    }
}
