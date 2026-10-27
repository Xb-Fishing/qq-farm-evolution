'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const temporary = fs.realpathSync(process.env.FARM_LOG_HISTORY_TEST_DIR || os.tmpdir());
const prefix = path.resolve(temporary, 'daily-quiet-dispatch-');
assert.equal(path.dirname(prefix), temporary);
const fixture = fs.mkdtempSync(prefix);
process.env.FARM_DATA_DIR = fixture;
process.env.FARM_ACCOUNT_ID = 'synthetic-daily-dispatch';
const root = path.resolve(__dirname, '../src');
const files = ['models/store.js', 'utils/pause-until.js', 'core/worker.js', 'services/farming-orchestrator.js'];
const fingerprint = () => files.map(file => {
  const source = path.resolve(root, file); assert.ok(source.startsWith(root + path.sep));
  return [file, fs.statSync(source).mode & 0o777, crypto.createHash('sha256').update(fs.readFileSync(source)).digest('hex')];
});
const original = fingerprint();
const originalNow = Date.now;
after(() => {
  Date.now = originalNow;
  try { assert.deepEqual(fingerprint(), original); }
  finally { assert.ok(fixture.startsWith(temporary + path.sep)); fs.rmSync(fixture, { recursive: true, force: true }); }
});

const program = `
const path=require('node:path'), root=process.argv[1];
const store=require(path.join(root,'models/store'));
const friend=require(path.join(root,'services/friend-api'));
let now=0; Date.now=()=>now;
const observations=[];
function row(name, instant, expected, config={}) {
  now=Date.parse(instant);
  store.applyConfigSnapshot({friendQuietHours:{enabled:true,start:'02:04',end:'06:30',
    pauseUntil:'',idleProtectionEnabled:false,...config}},{persist:false,accountId:process.env.FARM_ACCOUNT_ID});
  observations.push({name,actual:store.getPauseRemainMs(process.env.FARM_ACCOUNT_ID),expected,
    wire:store.getWirePauseRemainMs(process.env.FARM_ACCOUNT_ID), daily:friend.inFriendQuietHours(new Date(now))});
}
row('before start','2026-10-22T02:03:59.999+08:00',0);
row('start inclusive','2026-10-22T02:04:00+08:00',15960000);
row('incident clock','2026-10-22T02:15:00+08:00',15300000);
row('last millisecond','2026-10-22T06:29:59.999+08:00',1);
row('end exclusive','2026-10-22T06:30:00+08:00',0);
row('old UTC shifted window is inactive','2026-10-22T10:04:00+08:00',0);
row('disabled','2026-10-22T02:15:00+08:00',0,{enabled:false});
row('next Beijing day','2026-10-23T02:04:00+08:00',15960000);
row('overnight start','2026-10-22T23:00:00+08:00',14400000,{start:'23:00',end:'03:00'});
row('overnight midnight','2026-10-23T00:00:00+08:00',10800000,{start:'23:00',end:'03:00'});
row('overnight end','2026-10-23T03:00:00+08:00',0,{start:'23:00',end:'03:00'});
row('equal endpoints remain all-day','2026-10-22T12:00:00+08:00',50640000,{end:'02:04'});
row('manual later deadline wins','2026-10-22T02:04:00+08:00',17760000,{pauseUntil:'2026-10-21T23:00:00.000Z'});
row('daily disabled preserves manual deadline','2026-10-22T02:04:00+08:00',17760000,{enabled:false,pauseUntil:'2026-10-21T23:00:00.000Z'});
console.log(JSON.stringify({observations,socketPresent:!!require(path.join(root,'utils/network')).getWs()}));
`;
for (const [index, zone] of ['UTC', 'Asia/Shanghai', 'America/Los_Angeles', 'Asia/Tokyo'].entries()) {
  test(`real store pauses daily automatic producers independently of native TZ ${zone}`, () => {
    const dir = path.resolve(fixture, `zone-${index}`); assert.ok(dir.startsWith(fixture + path.sep));
    fs.mkdirSync(dir, { mode: 0o700 });
    const child = spawnSync(process.execPath, ['-e', program, root], {
      env: { ...process.env, TZ: zone, FARM_DATA_DIR: dir, NODE_OPTIONS: '' },
      encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024,
    });
    assert.equal(child.status, 0, child.stderr);
    const result = JSON.parse(child.stdout.trim().split('\n').at(-1));
    assert.equal(result.socketPresent, false);
    for (const row of result.observations) {
      assert.equal(row.actual, row.expected, row.name);
      assert.equal(row.wire, 0, `${row.name}: daily/manual pause must leave explicit shop reads available`);
    }
  });
}

const store = require('../src/models/store');
let now = Date.parse('2026-10-22T02:15:00+08:00');
function clock(value) {
  now = Date.parse(value); Date.now = () => now;
  store.applyConfigSnapshot({ friendQuietHours: { enabled: true, start: '02:04', end: '06:30', pauseUntil: '', idleProtectionEnabled: false } },
    { persist: false, accountId: process.env.FARM_ACCOUNT_ID });
}
function actual(file, name) {
  const source = fs.readFileSync(path.join(root, file), 'utf8');
  let begin = source.indexOf(`async function ${name}(`);
  if (begin < 0) begin = source.indexOf(`function ${name}(`);
  assert.ok(begin >= 0, name);
  const end = source.indexOf('\n}', begin); assert.ok(end > begin, name);
  return source.slice(begin, end + 2);
}
function scope(values, functions) {
  const sandbox = { Date, process, getPauseRemainMs: store.getPauseRemainMs, ...values };
  vm.createContext(sandbox);
  vm.runInContext(functions.map(([file, name]) => actual(file, name)).join('\n'), sandbox);
  return sandbox;
}

test('actual farm automatic entry stops during daily quiet and resumes at the exclusive end', async () => {
  let calls = 0;
  const c = scope({ isCheckingFarm: false, isFirstFarmCheck: true,
    getUserState: () => ({ gid: 42 }), isAutomationOn: () => true, isConnected: () => true,
    stealIsDue: () => false, stealIsImminent: () => false, ownHarvestIsDue: () => false,
    runFarmOperation: async (_type, options) => { calls++; assert.equal(options.automatic, true); return { hadWork: true }; },
    isTransientNetworkError: () => false, logWarn() {},
  }, [['services/farming-orchestrator.js', 'checkFarm']]);
  clock('2026-10-22T02:15:00+08:00'); assert.equal(await c.checkFarm(), false); assert.equal(calls, 0);
  clock('2026-10-22T06:30:00+08:00'); assert.equal(await c.checkFarm(), true); assert.equal(calls, 1);
});

test('actual land push retains passive observations and rejects both new and previously queued checks', async () => {
  let observations = 0; let queued; let runs = 0;
  const c = scope({ friendActivity: { noteSocialItems() { observations++; }, noteMischiefOwners() { observations++; } },
    getUserState: () => ({ gid: 42 }), isAutomationOn: () => true, isIdleQuiet: () => false,
    analyzeLands: () => ({ matureSchedule: [], harvestable: [] }), ownMatureSchedule: new Map(),
    rememberOwnLands() {}, publishOwnMaturitySchedule() {}, getServerTimeMs: () => Date.now(),
    isCheckingFarm: false, lastPushTime: 0, shouldRefresh2x2Plan: false, log() {},
    farmScheduler: { setTimeoutTask(_name, _delay, fn) { queued = fn; } },
    checkFarm: async () => { runs++; },
  }, [['services/farming-orchestrator.js', 'onLandsChangedPush'], ['services/farming-orchestrator.js', 'onFarmPushTimer']]);
  clock('2026-10-22T02:03:59+08:00'); c.onLandsChangedPush([]); assert.equal(typeof queued, 'function');
  clock('2026-10-22T02:04:00+08:00'); await queued(); assert.equal(runs, 0);
  queued = null; c.onLandsChangedPush([]); assert.equal(queued, null); assert.equal(observations, 4);
  clock('2026-10-22T06:30:00+08:00'); c.onLandsChangedPush([]); await queued(); assert.equal(runs, 1);
});

test('actual farm read finishing after daily quiet starts does not begin analysis or follow-up work', async () => {
  let analyzed = 0; let reads = 0;
  const empty = Object.fromEntries(['harvestable', 'needWeed', 'needBug', 'needGoldenBug', 'needWater', 'dead', 'empty', 'unlockable', 'upgradable', 'growing', 'matureSchedule'].map(key => [key, []]));
  const c = scope({ ownQuietPriority: { isActive: () => false }, getAllLands: async () => { reads++; clock('2026-10-22T02:04:00+08:00'); return { lands: [{}] }; },
    analyzeLands: () => { analyzed++; return empty; }, isFirstFarmCheck: false,
    noteOwnFarmNudge() {}, replaceOwnMaturitySchedule() {}, isAutomationOn: () => false,
    ownHarvestIsImminent: () => false, stealIsDue: () => false, getAutomation: () => ({ fertilizer: 'none' }),
    shouldRefresh2x2Plan: false,
  }, [['services/farming-orchestrator.js', 'runFarmOperation']]);
  clock('2026-10-22T02:03:59+08:00'); await c.runFarmOperation('all', { automatic: true });
  assert.equal(reads, 1); assert.equal(analyzed, 0);
});

test('actual unified tick uses the real daily pause, keeps dispatch pending and resumes farm/help', async () => {
  let farm = 0; let help = 0; let pausedUntil = 0; let reportsPaused = 0;
  const c = scope({ armOwnHarvestGuard() {}, unifiedSchedulerRunning: true, loginReady: true, friendSyncPaused: false,
    markIdleQuietUntil: value => { pausedUntil = value; }, pauseAceReports: () => { reportsPaused++; },
    lastPauseAnnounceAt: 0, getIdleProtectionUntil: () => 0, formatIdleRemain: () => 'remaining', log() {},
    nextFarmRunAt: 0, nextHelpRunAt: 0, nextStealRunAt: 0, markStealDueAt() {}, resumeAceReports() {},
    getAutomation: () => ({ farm: true, harvest: false, friend_steal: false }), ownHarvestDueAt: () => 0,
    nextScheduledStealAt: () => 0, stealIsImminent: () => false, STEAL_IDLE_MS: 30000,
    runFarmTick: async () => { farm++; }, runHelpTick: async () => { help++; },
  }, [['core/worker.js', 'pauseRemainMsNow'], ['core/worker.js', 'runUnifiedTick']]);
  clock('2026-10-22T02:15:00+08:00'); await c.runUnifiedTick();
  assert.equal(farm, 0); assert.equal(help, 0); assert.equal(reportsPaused, 1);
  assert.equal(pausedUntil, Date.parse('2026-10-22T06:30:00+08:00'));
  clock('2026-10-22T06:30:00+08:00'); await c.runUnifiedTick(); assert.equal(farm, 1); assert.equal(help, 1);
});

test('actual daily step leaves a paused day pending and preserves completed-step deduplication', async () => {
  let runs = 0; let done = false;
  const c = scope({ lastDailyRunDate: 'already-started', isDailyRoutineDone: () => done,
    markDailyRoutineDone: () => { done = true; },
  }, [['core/worker.js', 'pauseRemainMsNow'], ['core/worker.js', 'runDailyRoutineStep']]);
  const runner = async () => { runs++; };
  clock('2026-10-22T02:15:00+08:00'); await c.runDailyRoutineStep('synthetic', runner); assert.equal(runs, 0); assert.equal(c.lastDailyRunDate, '');
  clock('2026-10-22T06:30:00+08:00'); await c.runDailyRoutineStep('synthetic', runner, () => ({ doneToday: true }));
  await c.runDailyRoutineStep('synthetic', runner); assert.equal(runs, 1);
});

test('actual saved-fertilizer callback and independent fertilizer purchase interval honor daily quiet', async () => {
  let writes = 0;
  const c = scope({ loginReady: true, runFertilizerByConfig: async () => { writes++; }, log() {}, logWarn() {},
    isAutomationOn: () => true, getFertilizerBuyOrganicCount: () => 1, getFertilizerBuyOrganicThresholdHours: () => 1,
    getFertilizerBuyNormalCount: () => 1, getFertilizerBuyNormalThresholdHours: () => 1,
    checkAndBuyFertilizerBoth: async () => { writes++; },
  }, [['core/worker.js', 'pauseRemainMsNow'], ['core/worker.js', 'onTimer_fertilizer_immediate_after_save'], ['services/farm-scheduler.js', 'checkFertilizerBuyOnce']]);
  clock('2026-10-22T02:15:00+08:00'); await c.onTimer_fertilizer_immediate_after_save(); await c.checkFertilizerBuyOnce(); assert.equal(writes, 0);
  clock('2026-10-22T06:30:00+08:00'); await c.onTimer_fertilizer_immediate_after_save(); await c.checkFertilizerBuyOnce(); assert.equal(writes, 2);
});

test('automatic friend applications defer via the existing task and recheck after a read', async () => {
  let reads = 0; let accepts = 0; let queued;
  const applications = [{ gid: 42, name: 'Synthetic', level: 10 }];
  let crossBoundary = false;
  const c = scope({ friendLoopRunning: true, log() {}, toNum: Number, getAutoAcceptFriendMinLevel: () => 0,
    friendScheduler: { setTimeoutTask(name, delay, fn) { assert.equal(name, 'friend_check_bootstrap_applications'); assert.ok(delay > 0); queued = fn; } },
    acceptFriendsWithRetry: async () => { accepts++; },
    getApplications: async () => { reads++; if (crossBoundary) clock('2026-10-22T02:04:00+08:00'); return { applications }; },
  }, [['services/friend-orchestrator.js', 'deferFriendApplicationsDuringQuiet'],
    ['services/friend-orchestrator.js', 'onFriendApplicationReceived'], ['services/friend-orchestrator.js', 'checkAndAcceptApplications']]);
  clock('2026-10-22T02:15:00+08:00'); c.onFriendApplicationReceived(applications); await c.checkAndAcceptApplications();
  assert.equal(reads, 0); assert.equal(accepts, 0); assert.equal(typeof queued, 'function');
  clock('2026-10-22T06:30:00+08:00'); await queued(); assert.equal(reads, 1); assert.equal(accepts, 1);
  crossBoundary = true; clock('2026-10-22T02:03:59+08:00'); await c.checkAndAcceptApplications();
  assert.equal(reads, 2); assert.equal(accepts, 1, 'a completed read must not start automatic acceptance after quiet begins');
});

test('actual startup mischief producer does not read friends during daily quiet', async () => {
  let calls = 0;
  const c = scope({ badExecutedOnStartup: false, isAutomationOn: () => true, isFriendBadPaused: () => false,
    getUserState: () => ({ gid: 42 }), log() {},
    getAllFriends: async () => { calls++; return {}; }, extractReplyFriends: () => [],
  }, [['services/friend-orchestrator.js', 'runBadOnceOnStartup']]);
  clock('2026-10-22T02:15:00+08:00'); await c.runBadOnceOnStartup(true); assert.equal(calls, 0);
  clock('2026-10-22T06:30:00+08:00'); await c.runBadOnceOnStartup(true); assert.equal(calls, 1);
});

test('farm tick rechecks daily quiet between farm, task, email and gift producers', async () => {
  const calls = [];
  let crosses = 'farm';
  const step = async name => { calls.push(name); if (crosses === name) clock('2026-10-22T02:04:00+08:00'); };
  const c = scope({ farmTaskRunning: false, friendSyncPaused: false, CONFIG: {},
    stealIsDue: () => false, stealIsImminent: () => false, ownHarvestIsDue: () => false,
    flushOwnPriorityDeferred: async () => {}, checkFarm: () => step('farm'), checkAndClaimTasks: () => step('task'),
    checkAndClaimEmails: () => step('email'), openFertilizerGiftPacksSilently: () => step('gift'),
    randomIntervalMs: () => 1000, getNextMatureInMs: () => 0, nextIdleHorizonMs: () => 100000,
    idleNapMs: () => 1000, idleMaxSleepMs: () => 100000, idleMinSleepMs: () => 0,
    effectiveWakeBeforeMs: () => 0, capDelayByMatureInMs: value => value,
    maybeStretchDelay: value => value, ordinarySlowdownFloorMs: () => 0, logIdleSleep() {}, armStealWake() {}, nextFarmRunAt: 0,
  }, [['core/worker.js', 'pauseRemainMsNow'], ['core/worker.js', 'runFarmTick']]);
  const config = { farm: true, task: true, email: true, fertilizer_gift: true };
  clock('2026-10-22T02:03:59+08:00'); await c.runFarmTick(config); assert.deepEqual(calls, ['farm']);
  calls.length = 0; crosses = 'task'; clock('2026-10-22T02:03:59+08:00'); await c.runFarmTick(config); assert.deepEqual(calls, ['farm', 'task']);
  calls.length = 0; crosses = ''; clock('2026-10-22T06:30:00+08:00'); await c.runFarmTick(config); assert.deepEqual(calls, ['farm', 'task', 'email', 'gift']);
});

test('fertilizer threshold read crossing the boundary cancels automatic purchases and preserves explicit checks', async () => {
  let reads = 0; let buys = 0;
  const warehouse = { getBag: async () => { reads++; clock('2026-10-22T02:04:00+08:00'); return {}; },
    getBagItems: () => [], getContainerHoursFromBagItems: () => ({ organic: 0, normal: 0 }) };
  const c = scope({ require: name => {
    if (name === '../models/store') return store;
    assert.equal(name, './warehouse'); return warehouse;
  }, log() {}, sleep: async () => {}, autoBuyFertilizer: async () => { buys++; return 1; },
  }, [['services/mall.js', 'isAutomaticMallPaused'], ['services/mall.js', 'checkAndBuyFertilizerBoth']]);
  const options = { buyOrganic: true, buyNormal: true, organicCount: 1, normalCount: 1, organicThresholdHours: 1, normalThresholdHours: 1 };
  clock('2026-10-22T02:03:59+08:00'); await c.checkAndBuyFertilizerBoth({ ...options, automatic: true });
  assert.equal(reads, 1); assert.equal(buys, 0);
  const result = await c.checkAndBuyFertilizerBoth(options); assert.equal(reads, 2); assert.equal(buys, 2);
  assert.equal(result.organicBought, 1); assert.equal(result.normalBought, 1);
});

function mallScope(options = {}) {
  let buys = 0;
  const c = scope({ require: name => { assert.equal(name, '../models/store'); return store; },
    log() {}, toNum: Number, getUserState: () => ({ ticket: 100 }),
    getMallGoodsList: async () => { if (options.crossCatalogue) clock('2026-10-22T02:04:00+08:00'); return [{ goods_id: 1, price: [] }]; },
    findFertilizerMallGoods: goods => goods[0], parseMallPriceValue: () => 0, BUY_PER_ROUND: 1, MAX_ROUNDS: 3,
    purchaseMallGoods: async () => { buys++; }, sleep: async () => { if (options.crossBatch) clock('2026-10-22T02:04:00+08:00'); },
    lastBuyAt: 0, BUY_COOLDOWN_MS: 60000, buyDoneDateKey: '', buyLastSuccessAt: 0, getDateKey: () => 'synthetic-day',
  }, [['services/mall.js', 'isAutomaticMallPaused'], ['services/mall.js', 'autoBuyFertilizer'], ['services/mall.js', 'autoBuyFertilizerViaMall']]);
  return { c, buys: () => buys };
}

test('automatic fertilizer origin reaches the catalogue-read guard while an explicit purchase remains usable', async () => {
  const f = mallScope({ crossCatalogue: true });
  clock('2026-10-22T02:03:59+08:00'); const cancelled = await f.c.autoBuyFertilizer(true, 'organic', 1, { automatic: true });
  assert.equal(cancelled, 0); assert.equal(f.buys(), 0); assert.equal(f.c.buyDoneDateKey, '');
  const manual = await f.c.autoBuyFertilizer(true, 'organic', 1); assert.equal(manual, 1); assert.equal(f.buys(), 1);
});

test('automatic fertilizer batches retain the completed purchase and stop the next batch at quiet start', async () => {
  const f = mallScope({ crossBatch: true });
  clock('2026-10-22T02:03:59+08:00'); const bought = await f.c.autoBuyFertilizer(true, 'organic', 2, { automatic: true });
  assert.equal(bought, 1); assert.equal(f.buys(), 1); assert.equal(f.c.buyDoneDateKey, 'synthetic-day');
});

test('startup mischief remains pending when the friend read crosses quiet and runs normally after resume', async () => {
  let visits = 0; let cross = true;
  const c = scope({ badExecutedOnStartup: false, isAutomationOn: () => true, isFriendBadPaused: () => false,
    getUserState: () => ({ gid: 42 }), log() {}, logWarn() {}, toNum: Number, getFriendBlacklist: () => [],
    getAllFriends: async () => { if (cross) clock('2026-10-22T02:04:00+08:00'); return { friends: [{ gid: 84, level: 10, name: 'Synthetic' }] }; },
    extractReplyFriends: reply => reply.friends, canOperateBad: () => true, friendReadLifecycleSeq: 1,
    visitFriend: async () => { visits++; return {}; }, applyStealVisitResult() {}, trackBadVisitResult: () => false,
    recordBadFailure: () => false, isTransientNetworkError: () => false, randomDelay: async () => {},
  }, [['services/friend-orchestrator.js', 'runBadOnceOnStartup']]);
  clock('2026-10-22T02:03:59+08:00'); await c.runBadOnceOnStartup(); assert.equal(visits, 0); assert.equal(c.badExecutedOnStartup, false);
  cross = false; clock('2026-10-22T06:30:00+08:00'); await c.runBadOnceOnStartup(); assert.equal(visits, 1); assert.equal(c.badExecutedOnStartup, true);
});

test('automatic friend acceptance retains successful settlement and defers the extra read; explicit handling stays available', async () => {
  let accepted = 0; let refreshes = 0; let invalidations = 0; let synced = [];
  const c = scope({ friendLoopRunning: true, log() {}, logWarn() {}, toNum: Number,
    friendScheduler: { setTimeoutTask() {} }, acceptFriends: async () => { accepted++; clock('2026-10-22T02:04:00+08:00'); return { friends: [{ gid: 84, name: 'Synthetic' }] }; },
    getKnownFriendGids: () => [], normalizeFriendGids: values => values.map(Number),
    applyConfigSnapshot: value => { synced = Array.from(value.knownFriendGids); }, postToMaster: () => true,
    clearFriendsListCache: () => { invalidations++; }, getFriendsList: async () => { refreshes++; },
  }, [['services/friend-orchestrator.js', 'deferFriendApplicationsDuringQuiet'], ['services/friend-orchestrator.js', 'acceptFriendsWithRetry']]);
  clock('2026-10-22T02:03:59+08:00'); await c.acceptFriendsWithRetry([84], { automatic: true });
  assert.equal(accepted, 1); assert.deepEqual(synced, [84]); assert.equal(invalidations, 1); assert.equal(refreshes, 0);
  await c.acceptFriendsWithRetry([84]); assert.equal(accepted, 2); assert.equal(refreshes, 1);
});
