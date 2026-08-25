const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { serverMatureSecToLocalMs } = require('../src/services/farming-orchestrator');
const { nextWatchlistPollDelayMs } = require('../src/services/friend-orchestrator');

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
  assert.match(friendSrc, /WATCHLIST_POLL_IDLE_MIN_MS = 5 \* 60_000/);
  assert.match(friendSrc, /WATCHLIST_POLL_IDLE_MAX_MS = 8 \* 60_000/);
  assert.match(friendSrc, /WATCHLIST_POLL_WINDOW_MIN_MS = 45_000/);
  assert.match(friendSrc, /WATCHLIST_POLL_WINDOW_MAX_MS = 75_000/);
  assert.doesNotMatch(friendSrc, /setWatchMode\(/);
  assert.match(friendSrc, /slowdown\.active && !isFertilizerHot\(gid, now\) && !inObservationWindow/);
  assert.match(friendSrc, /baselineDelay \+ gaussianInt\(floorMs/);
});

test('priority polling wakes at the observation boundary and stays within the tighter jitter range', () => {
  const wakeBeforeMs = 122 * 60_000;
  const chooseMax = (_min, max) => max;

  assert.equal(nextWatchlistPollDelayMs(0, { wakeBeforeMs, randomDelay: chooseMax }), 8 * 60_000);
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
  assert.match(body, /nextStealRunAt = dueAt \+ randInt\(30, 120\)/);
  assert.doesNotMatch(body, /ripeRecheckDelayMs/);
  assert.doesNotMatch(body, /nextPreRipeScanAt/);

  const farmStart = src.indexOf('async function runFarmTick');
  const farmEnd = src.indexOf('// ==================== 帮助 Tick', farmStart);
  assert.doesNotMatch(src.slice(farmStart, farmEnd), /refreshFriendRipeSchedule/);
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
