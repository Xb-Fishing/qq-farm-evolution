const test = require('node:test');
const assert = require('node:assert/strict');
const governor = require('../src/services/request-governor');
const {
  WATCH_STATUS,
  ripeJumpedEarly,
  watchFriend,
  noteWatchVisit,
  setPriorityGids,
  noteFriendSummaries,
  getDueWatchFriends,
  getNextWatchDueAt,
  inspectFriendLands,
  getNextKnownFriendRipeEntry,
  isFertilizerHot,
  getWatchStateForTests,
  getMaturityCacheForTests,
  getFriendRipeSnapshot,
  resetFertilizerWatchForTests,
} = require('../src/services/fertilizer-watch');

test.afterEach(() => {
  resetFertilizerWatchForTests();
  governor.resetForTest();
});

test('ripe wall-clock jumping earlier counts as fertilizer', () => {
  assert.equal(ripeJumpedEarly(1_700_000_000_000 + 6 * 3600 * 1000, 1_700_000_000_000 + 5 * 3600 * 1000), true);
  assert.equal(ripeJumpedEarly(1_700_000_000_000 + 6 * 3600 * 1000, 1_700_000_000_000 + 6 * 3600 * 1000 - 10_000), false);
});

test('maturity transition with a fertilizer counter reset does not trigger HOT', () => {
  const now = Date.now();
  const sec = Math.floor(now / 1000);
  inspectFriendLands(181, '成熟切换', [
    { id: 1, plant: { id: 100, left_inorc_fert_times: 1, phases: [{ begin_time: sec }, { begin_time: sec + 3600 }] } },
  ], now);
  // Mature/harvest response can retain the same plant id while the old
  // maturity phase is no longer future and the counter becomes zero.
  inspectFriendLands(181, '成熟切换', [
    { id: 1, plant: { id: 100, left_inorc_fert_times: 0, phases: [{ begin_time: sec - 1 }] } },
  ], now);
  assert.equal(getWatchStateForTests(181, now), null);
});

test('crop replacement does not look like fertilizer use', () => {
  const now = Date.now();
  const sec = Math.floor(now / 1000);
  inspectFriendLands(20, '换种', [
    { id: 1, plant: { id: 100, left_inorc_fert_times: 2, phases: [{ begin_time: sec }, { begin_time: sec + 7200 }] } },
  ], now);
  inspectFriendLands(20, '换种', [
    { id: 1, plant: { id: 101, left_inorc_fert_times: 0, phases: [{ begin_time: sec + 10 }, { begin_time: sec + 3600 }] } },
  ], now + 10_000);
  assert.equal(getNextWatchDueAt(now + 10_000), 0);
});

test('replanting the same crop with a later maturity is not fertilizer use', () => {
  const now = Date.now();
  const sec = Math.floor(now / 1000);
  inspectFriendLands(24, '同种重种', [
    { id: 1, plant: { id: 100, left_inorc_fert_times: 2, phases: [{ begin_time: sec }, { begin_time: sec + 60 }] } },
  ], now);
  inspectFriendLands(24, '同种重种', [
    { id: 1, plant: { id: 100, left_inorc_fert_times: 0, phases: [{ begin_time: sec + 70 }, { begin_time: sec + 7200 }] } },
  ], now + 70_000);
  assert.equal(getNextWatchDueAt(now + 70_000), 0);
});

test('existing friend-land snapshots feed the nearest steal clock without another request', () => {
  const now = Date.now();
  const sec = Math.floor(now / 1000);
  inspectFriendLands(51, '六小时', [
    { id: 1, plant: { id: 100, phases: [{ begin_time: sec }, { begin_time: sec + 6 * 3600 }] } },
  ], now);
  inspectFriendLands(52, '三分钟', [
    { id: 1, plant: { id: 101, phases: [{ begin_time: sec }, { begin_time: sec + 180 }] } },
  ], now);

  const nearest = getNextKnownFriendRipeEntry(now, { myGid: 1 });
  assert.equal(nearest.gid, 52);
  assert.equal(nearest.name, '三分钟');
  assert.ok(nearest.ripeAt >= now + 179_000);
  assert.ok(nearest.ripeAt <= now + 180_000);
});

test('known friend-land clock ignores blacklist and expires after retry grace', () => {
  const now = Date.now();
  const sec = Math.floor(now / 1000);
  inspectFriendLands(53, '已成熟', [
    { id: 1, plant: { id: 102, phases: [{ begin_time: sec - 100 }] } },
  ], now);
  assert.equal(getNextKnownFriendRipeEntry(now, { graceMs: 90_000 }), null);

  inspectFriendLands(54, '屏蔽', [
    { id: 1, plant: { id: 103, phases: [{ begin_time: sec + 60 }] } },
  ], now);
  assert.equal(
    getNextKnownFriendRipeEntry(now, { blacklist: new Set([54]) }),
    null
  );
});

test('缺少 ripe_time_sec 的好友摘要不会覆盖已经读取的精确地块墙钟', () => {
  const now = 1_700_000_000_000;
  noteFriendSummaries([
    { gid: 24, name: '时钟好友', plant: { ripe_time_sec: 600 } },
  ], { now, myGid: 1 });
  const first = getFriendRipeSnapshot(24, now);
  assert.ok(first && first.dueAt > now);

  noteFriendSummaries([
    { gid: 24, name: '时钟好友', plant: { steal_plant_num: 0, ripe_time_sec: 0 } },
  ], { now: now + 30_000, myGid: 1 });
  const after = getFriendRipeSnapshot(24, now + 30_000);
  assert.equal(after?.dueAt, first.dueAt);
});

test('PREARM is isolated from fertilizer trend and fires only at ripeAt once', () => {
  const now = Date.now();
  const ripeAt = now + 5000;
  watchFriend(50, '自然成熟', {
    now,
    ripeAt,
    mode: 'prearm',
    reason: 'ripe_prearm',
  });
  assert.equal(getWatchStateForTests(50, now).status, WATCH_STATUS.PREARM);
  const profile = governor.getRequestProfile(now);
  assert.equal(profile.watchModeActive, false, 'natural maturity must not boost Enter limits');
  assert.equal(profile.contentionModeActive, true, 'natural maturity keeps failure-only grace');
  assert.equal(getNextWatchDueAt(now), ripeAt);
  assert.equal(getDueWatchFriends(ripeAt - 1).length, 0);
  assert.equal(getDueWatchFriends(ripeAt)[0].watchStatus, WATCH_STATUS.PREARM);
  noteWatchVisit(50, ripeAt);
  assert.equal(getWatchStateForTests(50, ripeAt), null);
});

test('failed PREARM remains retryable briefly, then expires instead of staying due forever', () => {
  const now = Date.now();
  const ripeAt = now + 5000;
  watchFriend(53, '短暂重试', {
    now,
    ripeAt,
    mode: 'prearm',
    reason: 'ripe_prearm',
  });
  assert.equal(getDueWatchFriends(ripeAt + 89_000)[0].gid, 53);
  assert.equal(getDueWatchFriends(ripeAt + 90_001).length, 0);
  assert.equal(getNextWatchDueAt(ripeAt + 90_001), 0);
});


for (const priority of [false, true]) {
  test(`maturity advances update the wall clock without fertilizer HOT or extra visits (priority=${priority})`, () => {
    const now = Date.now(); setPriorityGids(priority ? [71] : []);
    noteFriendSummaries([{ gid: 71, name: '时钟', plant: { ripe_time_sec: 600 } }], { now });
    noteFriendSummaries([{ gid: 71, name: '时钟', plant: { ripe_time_sec: 300 } }], { now: now + 1000 });
    assert.ok(getFriendRipeSnapshot(71, now + 1000).dueAt < now + 400000);
    assert.equal(getWatchStateForTests(71), null); assert.equal(getNextWatchDueAt(now), 0); assert.equal(isFertilizerHot(71), false);
    assert.equal(governor.getRequestProfile(now).watchModeActive, false);
  });
  test(`fertilizer counts and nudge flags never create a separate watch (priority=${priority})`, () => {
    const now = Date.now(), sec = Math.floor(now / 1000); setPriorityGids(priority ? [72] : []);
    const land = (at, count, nudged) => ({ id: 1, plant: { id: 100, left_inorc_fert_times: count, is_nudged: nudged, phases: [{ begin_time: sec }, { begin_time: at }] } });
    inspectFriendLands(72, '时钟', [land(sec + 600, 5, false)], now);
    inspectFriendLands(72, '时钟', [land(sec + 300, 4, true)], now + 1000);
    assert.equal(getWatchStateForTests(72), null); assert.equal(getNextWatchDueAt(now), 0);
    const nearest = getNextKnownFriendRipeEntry(now); assert.equal(nearest.gid, 72); assert.ok(nearest.ripeAt < now + 400000);
    assert.equal(watchFriend(72, '时钟', { now, reason: 'fertilizer_count_decreased' }), false);
  });
}
test('partial updates preserve untouched natural maturity without adding visits', () => {
  const now = Date.now(), sec = Math.floor(now / 1000);
  const land = (id, at) => ({ id, plant: { id: 100 + id, phases: [{ begin_time: sec - 10 }, { begin_time: at }] } });
  inspectFriendLands(73, '增量', [land(1, sec + 300), land(2, sec + 600)], now);
  inspectFriendLands(73, '', [land(1, sec - 1)], now + 1000, { partial: true });
  assert.equal(getWatchStateForTests(73), null); assert.ok(getNextKnownFriendRipeEntry(now + 1000).ripeAt >= now + 599000);
});

test('newly observed maturity replaces a previously armed deadline without a HOT visit', () => {
  const now = Date.now(), sec = Math.floor(now / 1000);
  const land = at => ({ id: 1, plant: { id: 101, phases: [{ begin_time: sec - 60 }, { begin_time: at }] } });
  inspectFriendLands(74, '时钟', [land(sec + 60)], now);
  watchFriend(74, '时钟', { now, ripeAt: now + 60000, mode: 'prearm' });
  inspectFriendLands(74, '', [land(sec + 30)], now, { partial: true });
  const state = getWatchStateForTests(74, now); assert.equal(state.status, WATCH_STATUS.PREARM); assert.equal(state.nextVisitAt, now + 30000);
  assert.equal(getDueWatchFriends(now + 29999).length, 0); assert.equal(getDueWatchFriends(now + 30000).length, 1); assert.equal(governor.getRequestProfile(now).watchModeActive, false);
});

test('old HOT state is discarded on restore while shared clocks and PREARM survive', () => {
  const fs = require('node:fs'), vm = require('node:vm'), path = require('node:path');
  const file = path.resolve(__dirname, '../src/services/fertilizer-watch.js'); let capsule, watchMode;
  const module = { exports: {} };
  const mocks = { '../utils/utils': { toNum: Number, toTimeSec: Number, getServerTimeSec: () => 1800000000, log() {} }, './steal-schedule': require('../src/services/steal-schedule'), './friend-activity': { noteSocialItems() {} }, './request-governor': { setWatchMode: value => { watchMode = value; } }, './business-state': { registerDataState: (_name, capture, restore, options) => { capsule = { capture, restore, ...options }; }, restoreContainer: (target, source) => { target.clear?.(); if (target instanceof Map) for (const entry of source) target.set(...entry); else if (target instanceof Set) for (const entry of source) target.add(entry); else { target.splice(0, target.length, ...source); } } } };
  vm.compileFunction(fs.readFileSync(file, 'utf8'), ['require', 'module', 'exports', 'globalThis', 'Map', 'Set'])(name => { assert.ok(Object.hasOwn(mocks, name), name); return mocks[name]; }, module, module.exports, { process: { env: { FARM_SESSION_BUSINESS: '1' } } }, Map, Set);
  const value = capsule.capture(); assert.equal(Object.keys(value).length, 8); value.watches.set(1, { status: 'HOT', nextVisitAt: 1800000000100 }); value.watches.set(2, { status: 'PREARM', nextVisitAt: 1800000001000, hardUntil: 1800000091000 }); value.ripeSnapshots.set(2, { dueAt: 1800000001000 }); value.priorityGids.add(2);
  capsule.restore(structuredClone(value)); assert.equal(watchMode, undefined, 'preparation must not issue governor commands'); module.exports.retireFertilizerWatchMode(); assert.equal(module.exports.getWatchStateForTests(1, 1800000000000), null); assert.equal(module.exports.getWatchStateForTests(2, 1800000000000).status, 'PREARM'); assert.equal(module.exports.isPriorityGid(2), true); assert.equal(watchMode, false);
});
