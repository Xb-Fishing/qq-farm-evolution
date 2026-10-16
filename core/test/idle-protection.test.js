const assert = require('node:assert/strict');
const { test, after, afterEach } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const crypto = require('node:crypto');
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'farm-idle-protection-'));
process.env.FARM_DATA_DIR = fixture;
process.env.FARM_ACCOUNT_ID = 'synthetic-idle-account';
const files = ['core/worker.js', 'utils/network.js', 'utils/behavior.js', 'utils/idle-protection.js',
  'models/store.js', 'services/friend-visit.js'];
const sourceRoot = path.resolve(__dirname, '../src');
const fingerprint = () => files.map(file => {
  const absolute = path.resolve(sourceRoot, file);
  assert.ok(absolute.startsWith(sourceRoot + path.sep));
  return [file, fs.statSync(absolute).mode & 0o777, crypto.createHash('sha256').update(fs.readFileSync(absolute)).digest('hex')];
});
const original = fingerprint();
const protection = require('../src/utils/idle-protection');
const { idleNapMs } = require('../src/utils/behavior');
const store = require('../src/models/store');
afterEach(() => { protection.setIdleProtectionUntil(0); assert.deepEqual(fingerprint(), original); });
after(() => {
  try { assert.deepEqual(fingerprint(), original); }
  finally { assert.equal(path.dirname(fixture), os.tmpdir()); fs.rmSync(fixture, { recursive: true, force: true }); }
});

function actualFunction(relative, name) {
  const source = fs.readFileSync(path.join(sourceRoot, relative), 'utf8');
  const start = new RegExp(`(?:async )?function ${name}\\(`).exec(source);
  assert.ok(start, `existing production function ${name}`);
  const end = source.indexOf('\n}', start.index);
  assert.ok(end > start.index);
  return source.slice(start.index, end + 2);
}

test('configured nap range is honored above ten minutes and leaves the active window', () => {
  for (let i = 0; i < 100; i++) {
    const delay = idleNapMs(3600_000, 8000, { minSleepMs: 12 * 60_000, maxSleepMs: 20 * 60_000, activeMs: 10 * 60_000 });
    assert.ok(delay >= 12 * 60_000 && delay <= 20 * 60_000);
  }
  assert.equal(idleNapMs(14 * 60_000, 8000, { minSleepMs: 5 * 60_000, maxSleepMs: 20 * 60_000, activeMs: 10 * 60_000 }), 8000);
  assert.equal(idleNapMs(0, 8000, { minSleepMs: 15 * 60_000, maxSleepMs: 15 * 60_000 }), 15 * 60_000);
});

test('protection only covers idle time, never an already due target or known harvest', () => {
  const now = Date.now();
  const base = { enabled: true, now, farmAt: now + 180_000, helpAt: now + 240_000, horizonMs: 3600_000, activeMs: 600_000 };
  assert.equal(protection.planIdleProtection(base), now + 180_000);
  assert.equal(protection.planIdleProtection({ ...base, enabled: false }), 0);
  assert.equal(protection.planIdleProtection({ ...base, horizonMs: 60_000 }), 0);
  assert.equal(protection.planIdleProtection({ ...base, stealDueAt: now - 1 }), 0);
  assert.equal(protection.planIdleProtection({ ...base, ownDueAt: now + 120_000 }), now + 110_000);
  assert.equal(protection.planIdleProtection({ ...base, stealDueAt: now + 90_000 }), now + 88_500);
});

test('saved setting defaults off, roundtrips the range and preserves a longer manual pause', () => {
  const id = process.env.FARM_ACCOUNT_ID;
  store.applyConfigSnapshot({ friendQuietHours: {} }, { persist: false, accountId: id });
  assert.equal(store.getFriendQuietHours(id).idleProtectionEnabled, false);
  store.applyConfigSnapshot({ friendQuietHours: { idleProtectionEnabled: true, minSleepMinutes: 12, maxSleepMinutes: 20 } }, { persist: false, accountId: id });
  assert.equal(store.getFriendQuietHours(id).minSleepMinutes, 12);
  assert.equal(store.getFriendQuietHours(id).maxSleepMinutes, 20);
  const now = Date.now();
  protection.setIdleProtectionUntil(now + 180_000);
  assert.ok(store.getPauseRemainMs(id) > 179_000);
  const manual = new Date(now + 600_000).toISOString();
  store.applyConfigSnapshot({ friendQuietHours: { pauseUntil: manual, idleProtectionEnabled: false } }, { persist: false, accountId: id });
  assert.equal(store.getFriendQuietHours(id).pauseUntil, manual);
  assert.ok(store.getPauseRemainMs(id) > 599_000);
  store.applyConfigSnapshot({ friendQuietHours: { pauseUntil: '' } }, { persist: false, accountId: id });
  assert.equal(store.getPauseRemainMs(id), 0);
  protection.setIdleProtectionUntil(now - 1);
  store.applyConfigSnapshot({ friendQuietHours: { idleProtectionEnabled: true } }, { persist: false, accountId: id });
  assert.equal(store.getPauseRemainMs(id), 0);
});

function wireHarness() {
  let paused = 0; let sent = 0; let governed = 0; let recorded = 0; let release;
  const timers = new Map();
  const context = {
    process: { env: { FARM_ACCOUNT_ID: 'synthetic-idle-account' } },
    getStoreModule: () => ({ getPauseRemainMs: () => paused }),
    ws: { readyState: 1, send: () => { sent++; } }, WebSocket: { OPEN: 1 },
    clientSeq: 1, pendingCallbacks: new Map(),
    encodeMsg: async () => Buffer.from('synthetic'),
    requestGovernor: { checkRequest: () => { governed++; return { allowed: true }; }, recordSent: () => { recorded++; } },
    networkScheduler: { setTimeoutTask: (key, delay, fn) => timers.set(key, fn), clear: key => timers.delete(key) },
    isConnected: () => true, log() {}, GOVERNED_BUDGET_REASONS: new Set(),
  };
  vm.createContext(context);
  vm.runInContext(['businessPauseError', 'sendMsg', 'sendMsgAsync'].map(n => actualFunction('utils/network.js', n)).join('\n'), context);
  return { context, timers, pause: n => { paused = n; }, counters: () => ({ sent, governed, recorded }),
    blockEncoding() { context.encodeMsg = () => new Promise(r => { release = r; }); }, release() { release(Buffer.from('synthetic')); } };
}

test('wire guard blocks all business paths without budget accounting, heartbeat and login remain available', async () => {
  const h = wireHarness(); h.pause(60_000);
  for (const [service, method] of [['gamepb.plantpb.PlantService', 'Harvest'], ['gamepb.visitpb.VisitService', 'Enter'],
    ['gamepb.friendpb.FriendService', 'GetAll'], ['synthetic.service', 'Heartbeat']]) {
    await assert.rejects(h.context.sendMsgAsync(service, method, Buffer.alloc(0)), { code: 'LOCAL_BUSINESS_PAUSED' });
  }
  assert.deepEqual(h.counters(), { sent: 0, governed: 0, recorded: 0 });
  assert.equal(await h.context.sendMsg('gamepb.userpb.UserService', 'Heartbeat', Buffer.alloc(0)), true);
  assert.equal(await h.context.sendMsg('gamepb.userpb.UserService', 'Login', Buffer.alloc(0)), true);
  assert.equal(h.counters().sent, 2);
  h.pause(0);
  assert.equal(await h.context.sendMsg('gamepb.plantpb.PlantService', 'Harvest', Buffer.alloc(0)), true);
  assert.equal(h.counters().sent, 3);
});

test('a pause beginning during encoding cancels the queued send and clears callbacks and timeouts', async () => {
  const h = wireHarness(); h.blockEncoding();
  const pending = h.context.sendMsgAsync('gamepb.plantpb.PlantService', 'Harvest', Buffer.alloc(0));
  h.pause(60_000); h.release();
  await assert.rejects(pending, { code: 'LOCAL_BUSINESS_PAUSED' });
  assert.deepEqual(h.counters(), { sent: 0, governed: 1, recorded: 0 });
  assert.equal(h.context.pendingCallbacks.size, 0); assert.equal(h.timers.size, 0);
});

test('real unified scheduling converts a long nap to protection and resumes at its deadline', async () => {
  let now = Date.now(); let scheduled; let ran = 0; let protectedUntil = 0;
  const ctx = {
    unifiedSchedulerRunning: true, loginReady: true, Date: { now: () => now },
    nextFarmRunAt: now + 180_000, nextHelpRunAt: now + 240_000,
    pauseRemainMsNow: () => Math.max(0, protectedUntil - now),
    getFriendQuietHours: () => ({ idleProtectionEnabled: true }),
    setIdleProtectionUntil: n => { protectedUntil = n; }, planIdleProtection: protection.planIdleProtection,
    ownHarvestDueAt: () => 0, resolveStealDueAt: () => now + 3600_000,
    nextIdleHorizonMs: () => 3600_000, effectiveWakeBeforeMs: () => 600_000,
    workerScheduler: { clear() {}, setTimeoutTask: (key, delay, fn) => { scheduled = { delay, fn }; } },
    markIdleQuietUntil() {}, pauseAceReports() {}, resumeAceReports() {}, formatIdleRemain: () => '3分', log() {},
    nextScheduledStealAt: () => now + 30_000, STEAL_IDLE_MS: 86400_000,
    runUnifiedTick: async () => { ran++; ctx.nextFarmRunAt = now + 8000; ctx.nextHelpRunAt = now + 30_000; },
  };
  vm.createContext(ctx); vm.runInContext(actualFunction('core/worker.js', 'scheduleUnifiedNextTick'), ctx);
  ctx.scheduleUnifiedNextTick();
  assert.equal(scheduled.delay, 180_000); assert.equal(protectedUntil, now + 180_000);
  assert.equal(ran, 0); now += 180_000;
  await scheduled.fn(); assert.equal(ran, 1); assert.equal(scheduled.delay, 8000);
});

test('queued push fast-lane rechecks protection before harvest, with normal behavior restored afterward', async () => {
  let paused = 0; let calls = 0; let release;
  const oldRun = new Promise(resolve => { release = resolve; });
  const ctx = {
    process: { env: { FARM_ACCOUNT_ID: 'synthetic-idle-account' } }, Date,
    getPauseRemainMs: () => paused, toNum: Number, isPriorityGid: () => true,
    friendActivity: { isFriendOnlineRecently: () => true }, fastLaneRipeLandIds: () => [1],
    fastLaneRecent: new Map(), fastLaneInFlight: new Map([[42, oldRun]]),
    stealHarvest: async () => { calls++; return {}; }, sumHarvestItemCount: () => ({ total: 1 }),
    recordOperation() {}, log() {}, recordEvent() {}, fastLaneDailyText: () => '', sellAllFruits: async () => {},
  };
  vm.createContext(ctx); vm.runInContext(actualFunction('services/friend-visit.js', 'fastLaneSteal'), ctx);
  await ctx.fastLaneSteal(42, []); const queued = ctx.fastLaneInFlight.get(42);
  paused = 60_000; release(); await queued; assert.equal(calls, 0);
  ctx.fastLaneRecent.clear(); ctx.fastLaneInFlight.clear(); paused = 0;
  await ctx.fastLaneSteal(42, []); await ctx.fastLaneInFlight.get(42); assert.equal(calls, 1);
});

test('already armed pre-entry timer does not enter a friend farm after protection begins', async () => {
  let callback; let calls = 0;
  const now = Date.now();
  const ctx = { Date, Number, sentinelArmedFor: { gid: 42 }, sentinelPreEnterTimer: null,
    clearSentinelPreEnter() {}, SENTINEL_PRE_ENTER_AHEAD_MS: 500,
    setTimeout: fn => { callback = fn; return { unref() {} }; }, pauseRemainMsNow: () => 60_000,
    require: () => { calls++; throw new Error('must not dispatch'); } };
  vm.createContext(ctx); vm.runInContext(actualFunction('core/worker.js', 'armSentinelPreEnter'), ctx);
  ctx.armSentinelPreEnter({ gid: 42, dueAt: now + 1000 }); await callback(); assert.equal(calls, 0);
});
