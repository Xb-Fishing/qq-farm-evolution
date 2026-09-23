const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { serverMatureSecToLocalMs } = require('../src/services/farming-orchestrator');
const { nextWatchlistPollDelayMs } = require('../src/services/friend-orchestrator');
const { mergeDueAt } = require('../src/services/steal-schedule');

// worker.js 不可直接 require（会连游戏服务），这里锁住独立成熟保护器的接线与优先级。
const src = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'core', 'worker.js'),
  'utf8'
);
const friendSrc = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'services', 'friend-orchestrator.js'),
  'utf8'
);
const friendOperationSrc = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'services', 'friend-operation-limits.js'),
  'utf8'
);
const friendVisitSrc = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'services', 'friend-visit.js'),
  'utf8'
);
const friendLandAnalyzerSrc = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'services', 'friend-land-analyzer.js'),
  'utf8'
);

test('server maturity seconds map to a precise local millisecond wall clock', () => {
  const serverNowMs = 1_700_000_000_250;
  const localNowMs = 50_000;
  assert.equal(
    serverMatureSecToLocalMs(1_700_000_001, localNowMs, serverNowMs),
    50_750
  );
  assert.equal(serverMatureSecToLocalMs(0, localNowMs, serverNowMs), 0);
});

test('own harvest guard is independently armed for the full absolute due time', () => {
  assert.match(src, /setTimeoutTask\('own_harvest_guard'/);
  assert.match(src, /await harvestOwnAtMaturity\(\)/);
  assert.match(src, /clearOwnHarvestGuard\(true\)/);
  assert.doesNotMatch(src, /SENTINEL_ARM_OWN_MS/);

  const actDelay = src.match(/OWN_HARVEST_ACT_DELAY_MS = \[(\d+), (\d+)\]/);
  assert.ok(actDelay, 'own harvest act delay defined');
  assert.ok(Number(actDelay[1]) >= 0);
  assert.ok(Number(actDelay[2]) < 1000, 'healthy harvest stays millisecond-level');
});

test('own harvest has a bounded retry ladder, obeys pause, and is not stopped by slowdown', () => {
  assert.match(src, /OWN_HARVEST_RETRY_WINDOWS_MS = \[/);
  assert.match(src, /const pauseRemain = pauseRemainMsNow\(\)/);
  assert.match(src, /scheduleOwnHarvestRetry\(\)/);
  const start = src.indexOf('async function runOwnHarvestStrike');
  const end = src.indexOf('// ==================== 好友成熟哨兵', start);
  const body = src.slice(start, end);
  assert.doesNotMatch(body, /getBreakerState\(\)/);
  assert.doesNotMatch(body, /breaker\.active/);
});

test('steal tick protects own crops before entering any friend farm', () => {
  const start = src.indexOf('async function runStealTick');
  const end = src.indexOf('// ==================== 统一调度器', start);
  const body = src.slice(start, end);
  const own = body.indexOf('await runOwnHarvestStrike()');
  const friend = body.indexOf('await checkFriends({ onlySteal: true })');
  assert.ok(own >= 0, 'own harvest strike exists in steal tick');
  assert.ok(friend > own, 'friend stealing starts only after own harvest');
});

test('friend sentinel keeps its own short timer without sharing own-harvest state', () => {
  assert.match(src, /sentinelTimer = setTimeout\(runSentinelStrike/);
  assert.match(src, /SENTINEL_ARM_WATCHLIST_MS = 5_000/);
  assert.match(src, /SENTINEL_ARM_NORMAL_MS = 2_000/);
  const clearAt = src.indexOf('clearSentinel();');
  assert.ok(src.indexOf('stopUnifiedScheduler();', clearAt) > clearAt);
});

test('哨兵到点链路有预进门驻留与请求治理紧急通道（2026-09-22）', () => {
  // 预进门：武装成立后提前 3s 进目标农场驻留，Strike 复用 Enter 回复。
  assert.match(src, /SENTINEL_PRE_ENTER_AHEAD_MS = 3_000/);
  assert.match(src, /function armSentinelPreEnter/);
  assert.match(src, /armSentinelPreEnter\(sentinelArmedFor\)/);
  assert.match(src, /sentinelPreEnter = \{ gid, dueAt, enteredAt: Date\.now\(\), enterReply \}/);
  // Strike 打开 15s 紧急窗口并把会话传给 checkFriends 快路径。
  const strike = src.slice(
    src.indexOf('async function runSentinelStrike'),
    src.indexOf('function armMaturitySentinel')
  );
  assert.match(strike, /setUrgentStrikeMode\(15_000\)/);
  assert.match(strike, /preEnter: preEnter/);
  assert.match(strike, /clearSentinelPreEnter\(\)/);
  // 紧急窗口最终落在 request-governor setUrgentMode（15s），沙箱可注入桩。
  assert.match(src, /function setUrgentStrikeMode\(windowMs\) \{/);
  assert.match(src, /globalThis\.__setUrgentStrikeMode/);
  assert.match(src, /setUrgentMode\(true, Date\.now\(\) \+ ms\)/);
  // 预进门失败静默兜底：Strike 走完整路径。
  assert.match(src, /\/\* 预进门失败：Strike 走完整路径 \*\//);
  // visitFriendForSteal 复用预进门回复，不重复 Enter。
  assert.match(friendVisitSrc, /preEnter && preEnter\.enterReply/);
});

test('immediately stealable friends arm contention grace even without a ripe timestamp', () => {
  const start = friendSrc.indexOf('if (stealTargets.length > 0 && doSteal)');
  const stealBlock = friendSrc.slice(
    start,
    friendSrc.indexOf('// Help', start)
  );
  assert.match(
    stealBlock,
    /setContentionMode\(true, Date\.now\(\) \+ 60_000\)/
  );
  assert.doesNotMatch(stealBlock, /setWatchMode\(/);
});

test('every friend harvest entry point renews contention grace at the API boundary', () => {
  const start = friendOperationSrc.indexOf('async function stealHarvest');
  const end = friendOperationSrc.indexOf('\n}', start);
  assert.match(
    friendOperationSrc.slice(start, end),
    /setContentionMode\(true, Date\.now\(\) \+ 60_000\)/
  );
});

test('priority baseline polling tightens only inside the observation window without opening governor watch mode', () => {
  // 2026-09-23：常态档降为 10-15 分钟（推送承担发现），在线/活跃档先于窗口判断
  assert.match(friendSrc, /WATCHLIST_POLL_IDLE_MIN_MS = 10 \* 60_000/);
  assert.match(friendSrc, /WATCHLIST_POLL_IDLE_MAX_MS = 15 \* 60_000/);
  assert.match(friendSrc, /WATCHLIST_POLL_WINDOW_MIN_MS = 45_000/);
  assert.match(friendSrc, /WATCHLIST_POLL_WINDOW_MAX_MS = 75_000/);
  assert.doesNotMatch(friendSrc, /setWatchMode\(/);
  assert.match(friendSrc, /slowdown\.active && !isFertilizerHot\(gid, now\) && !inObservationWindow/);
  assert.match(friendSrc, /baselineDelay \+ gaussianInt\(floorMs/);
});

test('priority polling wakes at the observation boundary and stays within the tighter jitter range', () => {
  const wakeBeforeMs = 122 * 60_000;
  const chooseMax = (_min, max) => max;

  assert.equal(nextWatchlistPollDelayMs(0, { wakeBeforeMs, randomDelay: chooseMax }), 15 * 60_000);
  assert.equal(
    nextWatchlistPollDelayMs(wakeBeforeMs + 20_000, { wakeBeforeMs, randomDelay: chooseMax }),
    20_000,
    'an idle timer must not oversleep the observation-window boundary'
  );
  assert.equal(
    nextWatchlistPollDelayMs(90 * 60_000, { wakeBeforeMs, randomDelay: chooseMax }),
    75_000
  );
  assert.equal(
    nextWatchlistPollDelayMs(90_000, { wakeBeforeMs, randomDelay: chooseMax }),
    30_000,
    'the last baseline must not skip the 60-second PREARM boundary'
  );
});

test('unified scheduler has no global breaker branch that postpones all work', () => {
  const start = src.indexOf('async function runUnifiedTick');
  const end = src.indexOf('function scheduleUnifiedNextTick', start);
  const body = src.slice(start, end);
  assert.doesNotMatch(body, /breaker\.active/);
  assert.doesNotMatch(body, /cooldown/);
});

test('a successful friend visit clears only that friend cached due clock', () => {
  assert.match(friendSrc, /const friendSummaryDueByGid = new Map\(\)/);
  assert.match(friendSrc, /friendSummaryDueByGid\.delete\(id\)/);
  assert.match(friendSrc, /applyStealVisitResult\(target\.gid, result\)/);
  assert.match(friendSrc, /cachedDueWithinGrace\(dueAt, now, STEAL_OVERDUE_GRACE_MS\)/);
});

test('already-read ordinary friend lands join the steal clock and arm direct PREARM near maturity', () => {
  assert.match(friendSrc, /getNextKnownFriendRipeEntry\(now/);
  assert.match(friendSrc, /knownEntry\.ripeAt <= now \+ prearmMs/);
  assert.match(friendSrc, /ripeAt: knownEntry\.ripeAt,[\s\S]*mode: 'prearm'/);
  assert.match(friendVisitSrc, /return \{ acted: actionLogs\.length > 0, entered: true, ripeAtMs \}/);
  assert.match(friendSrc, /const result = await visitFriendForHelp\([\s\S]*applyStealVisitResult\(target\.gid, result\)/);
});

test('enter success with Harvest failure keeps the bounded mature retry', () => {
  assert.match(friendVisitSrc, /retryNeeded: stealAttemptFailed/);
  assert.match(friendSrc, /if \(result\.retryNeeded === true\)/);
  assert.match(friendSrc, /friendSummaryDueByGid\.set\(id, visitedAt\)/);
});

test('persisted daily routines cannot enter or postpone the own maturity guard', () => {
  const start = src.indexOf('async function runOwnHarvestStrike');
  const end = src.indexOf('// ==================== 好友成熟哨兵', start);
  const guard = src.slice(start, end);
  assert.match(guard, /await harvestOwnAtMaturity\(\)/);
  assert.doesNotMatch(guard, /runDailyRoutine/);
  assert.doesNotMatch(guard, /ordinarySlowdownFloorMs/);
});

test('friend due stealing retains the 80-300ms wake cap and onlySteal path', () => {
  assert.match(src, /matureInMs \+ randInt\(80, 300\)/);
  const start = src.indexOf('async function runStealTick');
  const end = src.indexOf('// ==================== 统一调度器', start);
  assert.match(src.slice(start, end), /await checkFriends\(\{ onlySteal: true \}\)/);
});

test('known ordinary steal maturity waits for due while HOT and PREARM keep independent visits', () => {
  const start = src.indexOf('function armStealWake');
  const end = src.indexOf('async function runStealTick', start);
  const body = src.slice(start, end);
  assert.match(body, /getNextWatchDueAt\(now\)/);
  // 2026-09-22 催熟兜底：重点好友挂未来墙钟时，真实到期与 60-120s 摘要
  // 刷新下限取 min；无重点墙钟时保持按真实到期一次性唤醒。
  assert.match(body, /nextStealRunAt = Math\.min\(/);
  assert.match(body, /dueAt \+ randInt\(30, 120\)/);
  assert.match(body, /gaussianInt\(PRIORITY_SUMMARY_FLOOR_MIN_MS, PRIORITY_SUMMARY_FLOOR_MAX_MS\)/);
  assert.match(body, /watchlistDue > now/);
  assert.doesNotMatch(body, /ripeRecheckDelayMs/);
  assert.doesNotMatch(body, /nextPreRipeScanAt/);

  const farmStart = src.indexOf('async function runFarmTick');
  const farmEnd = src.indexOf('// ==================== 帮助 Tick', farmStart);
  assert.doesNotMatch(src.slice(farmStart, farmEnd), /refreshFriendRipeSchedule/);
});

test('催熟兜底摘要下限常量保持高斯抖动且不低于一分钟', () => {
  assert.match(src, /PRIORITY_SUMMARY_FLOOR_MIN_MS = 60_000/);
  assert.match(src, /PRIORITY_SUMMARY_FLOOR_MAX_MS = 120_000/);
});

test('unknown friend maturity uses only a five-to-eight-minute rediscovery fallback', () => {
  assert.match(src, /STEAL_REDISCOVERY_MIN_MS = 5 \* 60_000/);
  assert.match(src, /STEAL_REDISCOVERY_MAX_MS = 8 \* 60_000/);
  const start = src.indexOf('function stealRediscoveryDelayMs');
  const end = src.indexOf('function idleMaxSleepMs', start);
  assert.match(
    src.slice(start, end),
    /gaussianInt\(STEAL_REDISCOVERY_MIN_MS, STEAL_REDISCOVERY_MAX_MS\)/
  );
});

test('the steal dashboard clock does not masquerade own-crop maturity as friend maturity', () => {
  const start = src.indexOf('function resolveStealDueAt');
  const end = src.indexOf('function nextScheduledStealAt', start);
  const body = src.slice(start, end);
  assert.match(body, /getNextStealDueAtMs/);
  assert.match(body, /getNextWatchlistStealDueAtMs/);
  assert.doesNotMatch(body, /ownHarvestDueAt/);
});

test('dashboard exposes the next real steal check separately from known maturity', () => {
  const start = src.indexOf('const stealDue = resolveStealDueAt(now)');
  const end = src.indexOf('const slowdownNow', start);
  const body = src.slice(start, end);
  assert.match(body, /const stealKnownRemainSec = stealDue > now/);
  assert.match(body, /const stealCheckAt = nextScheduledStealAt\(\)/);
  assert.match(body, /const stealRemainSec = !stealPending && stealCheckAt > now/);
});

test('existing manual and detail friend entries feed clocks and immediately re-arm scheduling', () => {
  const detailStart = friendLandAnalyzerSrc.indexOf('async function getFriendLandsDetail');
  const detailEnd = friendLandAnalyzerSrc.indexOf('// ===== Cache accessors', detailStart);
  assert.match(
    friendLandAnalyzerSrc.slice(detailStart, detailEnd),
    /inspectFriendLands\(gid, '', lands\)/
  );
  const manualStart = friendVisitSrc.indexOf('async function doFriendOperation');
  const manualEnd = friendVisitSrc.indexOf('// ===== Full friend visit', manualStart);
  assert.match(
    friendVisitSrc.slice(manualStart, manualEnd),
    /inspectFriendLands\(numericGid, '', lands\)/
  );
  const apiStart = src.indexOf("case 'getFriendLands':");
  const apiEnd = src.indexOf("case 'getSeeds':", apiStart);
  const apiCases = src.slice(apiStart, apiEnd);
  assert.match(apiCases, /getFriendLandsDetail/);
  assert.match(apiCases, /doFriendOperation/);
  assert.ok((apiCases.match(/armStealWake\(\)/g) || []).length >= 4);
});

test('ordinary slowdown still cannot block priority HOT or PREARM entry', () => {
  assert.match(friendSrc, /slowdown\.active && !isFertilizerHot\(gid, now\)/);
  assert.match(friendSrc, /mode: 'prearm'/);
  const start = friendSrc.indexOf('async function checkFriends');
  const end = friendSrc.indexOf('// ===== Friend check loop', start);
  const checkBody = friendSrc.slice(start, end);
  assert.doesNotMatch(checkBody, /getBreakerState\(/);
  assert.doesNotMatch(checkBody, /cooldown/);
});

test('panel readiness gate and friends-list in-flight merging cannot touch the revenue ticks', () => {
  // 2026-09-18 启动竞态收口：面板好友入口的就绪闸门与在途合并只存在于
  // handleApiCall / friend-land-analyzer 面板路径，收益链 tick 不引用它们。
  const apiStart = src.indexOf('async function handleApiCall');
  const apiEnd = src.indexOf('// ==================== 每日礼包总览', apiStart);
  const apiBody = src.slice(apiStart, apiEnd);

  // 闸门先于同步暂停：未就绪的面板调用既不设置暂停也不等待，就地本地返回
  const gate = apiBody.indexOf('FRIEND_PANEL_ENTRY_METHODS.has(method)');
  const earlyReturn = apiBody.indexOf('账号未就绪');
  const pause = apiBody.indexOf('friendSyncPaused = true');
  assert.ok(gate >= 0, 'panel readiness gate exists');
  assert.ok(earlyReturn > gate && pause > earlyReturn,
    'gate returns a local error before the sync pause is set');

  // 面板在途合并只落在 friend-land-analyzer；偷菜链 checkFriends 直接读
  // getAllFriends（核心巡查/到点偷菜/HOT/PREARM 不进入面板缓存）
  assert.match(friendLandAnalyzerSrc, /friendsListInFlight/);
  assert.match(friendLandAnalyzerSrc, /generation === friendsListGeneration/);
  const checkStart = friendSrc.indexOf('async function checkFriends');
  const checkEnd = friendSrc.indexOf('// ===== Friend check loop', checkStart);
  const checkBody = friendSrc.slice(checkStart, checkEnd);
  assert.doesNotMatch(checkBody, /getFriendsList/);
  assert.doesNotMatch(checkBody, /friendsListInFlight/);

  // 收益链 tick 不咨询面板就绪闸门，也不等待面板读取
  for (const [marker, endMarker] of [
    ['async function runOwnHarvestStrike', '// ==================== 好友成熟哨兵'],
    ['async function runStealTick', '// ==================== 统一调度器'],
    ['async function runUnifiedTick', 'function scheduleUnifiedNextTick'],
  ]) {
    const start = src.indexOf(marker);
    assert.ok(start >= 0, `${marker} exists`);
    const body = src.slice(start, src.indexOf(endMarker, start));
    assert.doesNotMatch(body, /FRIEND_PANEL_ENTRY_METHODS/);
    assert.doesNotMatch(body, /getFriendsList/);
  }
});

// ==================== 面板读取在途 × 收益链真实执行（隔离 VM） ====================

// 在隔离 VM 中执行真实 worker 收益函数：普通面板 getFriends 读取在途时，
// 自己成熟收获、好友到点偷菜（统一调度器分发）、重点 HOT/PREARM 哨兵都
// 继续出手，不因普通面板读取设置好友同步暂停。严禁启动真实 Worker 或网络：
// 面板链路的真实 friend-land-analyzer 以永不自动兑现的 deferred 作为上游边界，
// 收益链的协议出口（harvestOwnAtMaturity / checkFriends）注入记录器。

function mockModule(filename, exports) {
  return { id: filename, filename, loaded: true, exports, paths: [] };
}

/** 上游 deferred 的真实 analyzer 链（面板普通 getFriends 走真实代码路径）。 */
function loadAnalyzerChainForSentinel() {
  const upstream = { calls: 0, pending: [] };
  const getAllFriends = () => {
    upstream.calls += 1;
    return new Promise((resolve, reject) => {
      upstream.pending.push({ resolve, reject });
    });
  };
  const servicePath = require.resolve('../src/services/friend-land-analyzer');
  const friendApiPath = require.resolve('../src/services/friend-api');
  const networkPath = require.resolve('../src/utils/network');
  const storePath = require.resolve('../src/models/store');
  const fertilizerPath = require.resolve('../src/services/fertilizer-watch');
  const farmLandAnalyzerPath = require.resolve('../src/services/farm-land-analyzer');
  const paths = [servicePath, friendApiPath, networkPath, storePath,
    fertilizerPath, farmLandAnalyzerPath];
  const previous = new Map(paths.map(file => [file, require.cache[file]]));

  require.cache[friendApiPath] = mockModule(friendApiPath, {
    getAllFriends,
    enterFriendFarm: async () => ({ lands: [] }),
    leaveFriendFarm: async () => {},
    getDogName: () => '',
    handleFriendEnterError: () => ({ handled: false }),
  });
  require.cache[networkPath] = mockModule(networkPath, {
    getUserState: () => ({ gid: 4321 }),
    networkEvents: { on: () => {}, off: () => {} },
    sendMsgAsync: async () => { throw new Error('unexpected upstream call'); },
  });
  require.cache[storePath] = mockModule(storePath, {
    getPlantBlacklist: () => [],
    getFriendBlacklist: () => [],
    readFriendDogInfoCache: () => null,
    writeFriendDogInfoCache: () => {},
  });
  require.cache[fertilizerPath] = mockModule(fertilizerPath, {
    inspectFriendLands: () => {},
    getFriendRipeSnapshot: () => null,
  });
  require.cache[farmLandAnalyzerPath] = mockModule(farmLandAnalyzerPath, {
    getCurrentPhase: () => null,
    buildLandMap: () => new Map(),
    getDisplayLandContext: () => ({
      sourceLand: null, occupiedByMaster: false, masterLandId: 0, occupiedLandIds: [],
    }),
    isOccupiedSlaveLand: () => false,
    getQixiDewStatus: () => null,
  });
  delete require.cache[servicePath];
  const previousAccountId = process.env.FARM_ACCOUNT_ID;
  process.env.FARM_ACCOUNT_ID = 'maturity-sentinel-test';
  return {
    analyzer: require(servicePath),
    upstream,
    restore() {
      if (previousAccountId === undefined) delete process.env.FARM_ACCOUNT_ID;
      else process.env.FARM_ACCOUNT_ID = previousAccountId;
      delete require.cache[servicePath];
      for (const file of paths) {
        if (previous.get(file)) require.cache[file] = previous.get(file);
        else delete require.cache[file];
      }
    },
  };
}

/** 从 worker.js 提取真实收益入口：面板入口 + 自己收获 + 偷菜 tick + 统一 tick + 哨兵。 */
function extractRevenueEntrySource() {
  const slices = [];
  const take = (startMarker, endMarker, label) => {
    const start = src.indexOf(startMarker);
    assert.ok(start >= 0, `${label} exists in worker.js`);
    const end = src.indexOf(endMarker, start);
    assert.ok(end > start, `${label} end marker exists`);
    slices.push(src.slice(start, end));
  };
  const setStart = src.indexOf('const FRIEND_PANEL_ENTRY_METHODS = new Set([');
  assert.ok(setStart >= 0, 'entry set declaration exists');
  slices.push(src.slice(setStart, src.indexOf(']);', setStart) + ']);'.length));
  take('async function handleApiCall', '// ==================== 每日礼包总览', 'handleApiCall');
  take('async function runOwnHarvestStrike', '// ==================== 好友成熟哨兵', 'runOwnHarvestStrike');
  take('function clearSentinel()', '// 偷菜 due 连续', 'sentinel block');
  take('async function runStealTick', '// ==================== 统一调度器', 'runStealTick');
  take('async function runUnifiedTick', 'function scheduleUnifiedNextTick', 'runUnifiedTick');
  return `${slices.join('\n')}\n;({ handleApiCall, runOwnHarvestStrike, runStealTick, runUnifiedTick, runSentinelStrike, armMaturitySentinel, clearSentinel })`;
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

test('普通面板 getFriends 在途：自己成熟收获、好友到点偷菜、重点 HOT/PREARM 哨兵全部继续出手', async () => {
  const chain = loadAnalyzerChainForSentinel();
  try {
    // 收益链协议出口记录器：自己收获 / 到点偷菜（含哨兵抢收共用入口）
    const calls = { harvest: 0, checkFriends: 0, checkFriendsOpts: [] };
    // 自己成熟墙钟持有者：0=无自己成熟（统一 tick 正常分发偷菜）；
    // 设为当前时刻后 runOwnHarvestStrike 直发毫秒级收获
    let ownDueHolder = 0;
    const responses = [];

    const sandbox = {
      // —— 面板入口（真实 handleApiCall + 真实 analyzer 链）——
      isRunning: true,
      loginReady: true,
      getWs: () => ({ readyState: 1 }),
      sendToMaster: message => responses.push(message),
      log: () => {},
      friendSyncPaused: false,
      getFriendsList: chain.analyzer.getFriendsList,
      fetchFriendsDogInfo: async () => { throw new Error('not part of this test'); },
      syncFriendsFromGids: async () => { throw new Error('not part of this test'); },
      require: () => { throw new Error('unexpected require in test'); },
      // —— runOwnHarvestStrike ——
      ownHarvestStrikeRunning: false,
      ownHarvestDueAt: () => ownDueHolder,
      ownHarvestRetryAttempt: 0,
      lastOwnHarvestFailureLogAt: 0,
      getAutomation: () => ({ farm: true, harvest: true, friend_steal: true }),
      pauseRemainMsNow: () => 0,
      setOwnHarvestGuardTimer: () => {},
      scheduleOwnHarvestRetry: () => {},
      armOwnHarvestGuard: () => {},
      randInt: (min, _max) => min,
      harvestOwnAtMaturity: async () => {
        calls.harvest += 1;
        return { harvestedCount: 3 };
      },
      armStealWake: () => {},
      // —— runStealTick / runUnifiedTick ——
      stealTaskRunning: false,
      ownHarvestIsDue: () => ownDueHolder > 0 && ownDueHolder <= Date.now(),
      ownHarvestIsImminent: (reserveMs = 10_000, now = Date.now()) =>
        ownDueHolder > 0 && ownDueHolder - now <= reserveMs,
      checkFriends: async opts => {
        calls.checkFriends += 1;
        calls.checkFriendsOpts.push(opts);
        return true;
      },
      isTransientNetworkError: () => false,
      nextStealRunAt: 0,
      markStealDueAt: () => {},
      unifiedSchedulerRunning: true,
      markIdleQuietUntil: () => {},
      pauseAceReports: () => {},
      resumeAceReports: () => {},
      formatIdleRemain: ms => `${Math.round(ms / 60000)}分钟`,
      lastPauseAnnounceAt: 0,
      nextFarmRunAt: Date.now() + 60_000,
      nextHelpRunAt: Date.now() + 60_000,
      STEAL_IDLE_MS: 24 * 60 * 60_000,
      nextScheduledStealAt: () => Date.now() - 1000,
      stealIsDue: () => true,
      stealIsImminent: () => false,
      runFarmTick: async () => { throw new Error('farm tick must not run in this test'); },
      runHelpTick: async () => { throw new Error('help tick must not run in this test'); },
      // —— 哨兵（重点 HOT/PREARM 到点路径）——
      // 生产常量按原值注入（既有测试已锁定这些值不得漂移）
      SENTINEL_ARM_WATCHLIST_MS: 5_000,
      SENTINEL_ARM_NORMAL_MS: 2_000,
      SENTINEL_ACT_DELAY_MS: [30, 80],
      SENTINEL_PRE_ENTER_AHEAD_MS: 3_000,
      OWN_HARVEST_RESERVE_MS: 10_000,
      sentinelTimer: null,
      sentinelArmedFor: null,
      sentinelPreEnter: null,
      sentinelPreEnterTimer: null,
      getDueWatchFriends: () => [],
      __setUrgentStrikeMode: () => {},
      getNextStealDueAtMs: () => 0,
      getNextWatchDueAt: () => Date.now() + 20,
      getNextWatchlistStealDueAtMs: () => 0,
      mergeDueAt,
      setTimeout,
      clearTimeout,
    };
    const script = new vm.Script(extractRevenueEntrySource(),
      { filename: 'worker.js#revenue-entries' });
    const fns = script.runInContext(vm.createContext(sandbox));

    // 1) 真实 handleApiCall 发起普通面板读取（非强制）：上游 deferred，保持在途
    const panelRead = fns.handleApiCall({ id: 'panel-normal', method: 'getFriends', args: [false] });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(chain.upstream.calls, 1, 'panel read reaches its (deferred) upstream once');
    assert.equal(sandbox.friendSyncPaused, false,
      '普通面板读取不设置好友同步暂停（只有强制/狗信息/GID 同步才暂停）');

    // 2) 面板读取在途：统一调度器正常分发到点偷菜（真实 runStealTick → checkFriends）
    const checkBefore = calls.checkFriends;
    await fns.runUnifiedTick();
    assert.equal(calls.checkFriends, checkBefore + 1,
      '统一 tick 在面板读取在途时照常分发到点偷菜');
    // 注：opts 对象在 vm realm 内构造，用属性断言避免跨 realm 原型比较
    const stealOpts = calls.checkFriendsOpts[calls.checkFriendsOpts.length - 1];
    assert.equal(stealOpts.onlySteal, true, '到点偷菜走 onlySteal 快路径');
    assert.equal(sandbox.friendSyncPaused, false, '偷菜分发后仍未被面板读取暂停');

    // 3) 面板读取仍在途：自己作物到点 → 真实 runOwnHarvestStrike 直发毫秒级收获
    ownDueHolder = Date.now();
    await fns.runOwnHarvestStrike();
    assert.equal(calls.harvest, 1, '自己成熟收获在面板读取在途时照常出手');
    assert.equal(sandbox.friendSyncPaused, false);
    ownDueHolder = 0;

    // 4) 面板读取仍在途：重点 HOT/PREARM 目标 20ms 后到期 → 哨兵武装并在到点出手
    const sentinelBefore = calls.checkFriends;
    fns.armMaturitySentinel(Date.now());
    assert.ok(sandbox.sentinelArmedFor, '重点目标进入武装区间即布控哨兵');
    assert.ok(sandbox.sentinelTimer, '哨兵定时器已挂载');
    await sleep(200);
    assert.equal(calls.checkFriends, sentinelBefore + 1,
      '哨兵到点出手（HOT/PREARM 抢收）不受面板读取影响');
    assert.equal(sandbox.friendSyncPaused, false, '哨兵出手前后都未被面板读取暂停');

    // 5) 面板读取完成：正常返回列表，全程零暂停
    assert.equal(responses.length, 0, '面板响应等待真实上游完成');
    chain.upstream.pending[0].resolve({ game_friends: [{ gid: 777, name: 'F777', level: 4 }] });
    await panelRead;
    assert.equal(responses.length, 1);
    assert.strictEqual(responses[0].error, null);
    assert.equal(responses[0].result.length, 1);
    assert.equal(sandbox.friendSyncPaused, false,
      '普通面板读取完成后也没有设置过同步暂停');

    // 6) 反向对照（非空洞证明）：暂停变量被真实 tick 消费——手动置位后
    //    偷菜/收获/哨兵全部短路，说明上面的「继续出手」结论依赖真实的暂停语义
    sandbox.friendSyncPaused = true;
    const controlBefore = { harvest: calls.harvest, check: calls.checkFriends };
    await fns.runStealTick({ farm: true, harvest: true, friend_steal: true });
    ownDueHolder = Date.now();
    await fns.runOwnHarvestStrike();
    sandbox.sentinelArmedFor = { kind: 'friend', dueAt: Date.now() };
    await fns.runSentinelStrike();
    assert.equal(calls.checkFriends, controlBefore.check,
      '暂停期间偷菜 tick 短路（证明 tick 确实消费 friendSyncPaused）');
    assert.equal(calls.harvest, controlBefore.harvest,
      '暂停期间自己收获走受控重试而不是直发（证明收获确实消费 friendSyncPaused）');
    sandbox.friendSyncPaused = false;
  } finally {
    chain.restore();
  }
});

// 2026-09-22 误报回归：收获+补种会让"全场最早成熟/全场最小施肥次数"天然
// 变小，旧聚合比较每轮收种都误报"检测到催熟/化肥"。同茬守卫后只有真正的
// 同一茬墙钟前移/施肥次数下降才报。
test('own-farm nudge detection ignores replant boundaries and trusts same-crop drops', () => {
  const farm = require('../src/services/farming-orchestrator');
  farm.resetOwnNudgeBaselineForTests();
  const base = 1_800_000_000;
  // 基线：两块地，慢作物 6h 后熟
  let lands = [
    { id: 1, plant: { id: 100, left_inorc_fert_times: 3, phases: [{ begin_time: base }, { begin_time: base + 21600 }] } },
    { id: 2, plant: { id: 200, left_inorc_fert_times: 5, phases: [{ begin_time: base }, { begin_time: base + 3600 }] } },
  ];
  let schedule = [{ landId: 1, matureAtSec: base + 21600 }, { landId: 2, matureAtSec: base + 3600 }];
  assert.equal(farm.noteOwnFarmNudgeForTests(lands, base + 3600, schedule), false);
  // 补种边界：地 2 收获后改种 6 分钟短作物（新茬 plantId 不同）——不许报
  lands = [
    { id: 1, plant: { id: 100, left_inorc_fert_times: 3, phases: [{ begin_time: base }, { begin_time: base + 21600 }] } },
    { id: 2, plant: { id: 999, left_inorc_fert_times: 1, phases: [{ begin_time: base + 3600 }, { begin_time: base + 3960 }] } },
  ];
  schedule = [{ landId: 1, matureAtSec: base + 21600 }, { landId: 2, matureAtSec: base + 3960 }];
  assert.equal(farm.noteOwnFarmNudgeForTests(lands, base + 3960 - 60, schedule), false, '换茬补种不是催熟');
  // 同一茬墙钟前移 >25s（真施肥/催熟）——必须报
  lands = [
    { id: 1, plant: { id: 100, left_inorc_fert_times: 2, phases: [{ begin_time: base }, { begin_time: base + 21000 }] } },
    { id: 2, plant: { id: 999, left_inorc_fert_times: 1, phases: [{ begin_time: base + 3600 }, { begin_time: base + 3960 }] } },
  ];
  schedule = [{ landId: 1, matureAtSec: base + 21000 }, { landId: 2, matureAtSec: base + 3960 }];
  assert.equal(farm.noteOwnFarmNudgeForTests(lands, base + 21000 - 60, schedule), true, '同茬墙钟前移+施肥次数下降必须报');
});
