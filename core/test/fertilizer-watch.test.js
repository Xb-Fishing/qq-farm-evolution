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

test('one summary jump enters HOT immediately and schedules realtime monitoring', () => {
  const now = 1_700_000_000_000;
  noteFriendSummaries([
    { gid: 9, name: '肥佬', plant: { steal_plant_num: 0, ripe_time_sec: 21600 } },
  ], { now, myGid: 1 });
  noteFriendSummaries([
    { gid: 9, name: '肥佬', plant: { steal_plant_num: 0, ripe_time_sec: 600 } },
  ], { now: now + 30_000, myGid: 1 });

  assert.equal(getDueWatchFriends(now + 30_000).length, 0);
  const dueAt = getNextWatchDueAt(now + 30_000);
  assert.equal(getWatchStateForTests(9, now + 30_000).status, WATCH_STATUS.HOT);
  assert.equal(isFertilizerHot(9, now + 30_000), true);
  assert.equal(governor.getRequestProfile(now + 30_000).watchModeActive, true);
  assert.ok(dueAt >= now + 30_000 + 400);
  assert.ok(dueAt <= now + 30_000 + 800);
  assert.equal(getDueWatchFriends(dueAt).length, 1);
  assert.equal(getDueWatchFriends(dueAt)[0].gid, 9);
});

test('nudged without a baseline enters HOT immediately; no growing lands drop it', () => {
  const now = Date.now();
  inspectFriendLands(8, '催熟党', [
    { id: 1, plant: { id: 100, is_nudged: true, phases: [{ begin_time: Math.floor(now / 1000) + 3600 }] } },
  ], now);
  assert.equal(getWatchStateForTests(8, now).status, WATCH_STATUS.HOT);
  assert.ok(getNextWatchDueAt(now) > now);
  inspectFriendLands(8, '催熟党', [], now);
  assert.equal(getNextWatchDueAt(now), 0);
});

test('fertilizer decrease is compared per land instead of using the farm minimum', () => {
  const now = Date.now();
  const phaseAt = Math.floor(now / 1000) + 3600;
  inspectFriendLands(18, '分地施肥', [
    { id: 1, plant: { id: 100, left_inorc_fert_times: 0, phases: [{ begin_time: phaseAt }] } },
    { id: 2, plant: { id: 100, left_inorc_fert_times: 2, phases: [{ begin_time: phaseAt }] } },
  ], now);
  inspectFriendLands(18, '分地施肥', [
    { id: 1, plant: { id: 100, left_inorc_fert_times: 0, phases: [{ begin_time: phaseAt }] } },
    { id: 2, plant: { id: 100, left_inorc_fert_times: 1, phases: [{ begin_time: phaseAt }] } },
  ], now + 1000);
  assert.equal(getWatchStateForTests(18, now + 1000).status, WATCH_STATUS.HOT);
  assert.ok(getNextWatchDueAt(now + 1000) > now + 1000);
});

test('maturity advance is compared per land even when another land remains earliest', () => {
  const now = Date.now();
  const sec = Math.floor(now / 1000);
  inspectFriendLands(19, '后排催熟', [
    { id: 1, plant: { id: 100, phases: [{ begin_time: sec }, { begin_time: sec + 3600 }] } },
    { id: 2, plant: { id: 101, phases: [{ begin_time: sec }, { begin_time: sec + 7200 }] } },
  ], now);
  inspectFriendLands(19, '后排催熟', [
    { id: 1, plant: { id: 100, phases: [{ begin_time: sec }, { begin_time: sec + 3600 }] } },
    { id: 2, plant: { id: 101, phases: [{ begin_time: sec }, { begin_time: sec + 5400 }] } },
  ], now + 1000);
  assert.equal(getWatchStateForTests(19, now + 1000).status, WATCH_STATUS.HOT);
  assert.ok(getNextWatchDueAt(now + 1000) > now + 1000);
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

test('phase history pruning still compares the same crop per land', () => {
  const now = Date.now();
  const sec = Math.floor(now / 1000);
  inspectFriendLands(25, '阶段裁剪', [
    { id: 1, plant: { id: 100, left_inorc_fert_times: 2, phases: [
      { begin_time: sec - 100 },
      { begin_time: sec + 100 },
      { begin_time: sec + 3600 },
    ] } },
  ], now);
  inspectFriendLands(25, '阶段裁剪', [
    { id: 1, plant: { id: 100, left_inorc_fert_times: 1, phases: [
      { begin_time: sec + 100 },
      { begin_time: sec + 3000 },
    ] } },
  ], now + 1000);
  assert.ok(getNextWatchDueAt(now + 1000) > now + 1000);
});

test('partial LandsNotify keeps untouched growing lands and does not drop the watch', () => {
  const now = Date.now();
  const sec = Math.floor(now / 1000);
  inspectFriendLands(21, '增量通知', [
    { id: 1, plant: { id: 100, is_nudged: true, phases: [{ begin_time: sec }, { begin_time: sec + 3600 }] } },
    { id: 2, plant: { id: 101, phases: [{ begin_time: sec }, { begin_time: sec + 7200 }] } },
  ], now);
  assert.ok(getNextWatchDueAt(now) > now);

  inspectFriendLands(21, '', [
    { id: 1, plant: { id: 100, phases: [{ begin_time: sec }, { begin_time: sec - 1 }] } },
  ], now + 1000, { partial: true });
  assert.equal(getWatchStateForTests(21, now + 1000).status, WATCH_STATUS.HOT);
  assert.ok(getNextWatchDueAt(now + 1000) > 0);
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

test('a first partial mature-land notify cannot prove the whole farm stopped growing', () => {
  const now = 1_700_000_000_000;
  noteFriendSummaries([
    { gid: 23, name: '只有增量', plant: { ripe_time_sec: 600 } },
  ], { now, myGid: 1 });
  noteFriendSummaries([
    { gid: 23, name: '只有增量', plant: { ripe_time_sec: 500 } },
  ], { now: now + 1000, myGid: 1 });
  assert.ok(getNextWatchDueAt(now + 1000) > now + 1000);

  inspectFriendLands(23, '', [
    { id: 1, plant: { id: 100, phases: [{ begin_time: 1 }] } },
  ], now + 2000, { partial: true });
  assert.equal(getWatchStateForTests(23, now + 2000).status, WATCH_STATUS.HOT);
  assert.ok(getNextWatchDueAt(now + 2000) > 0);
});

test('summary jump within eight seconds still creates a close watch', () => {
  const now = 1_700_000_000_000;
  noteFriendSummaries([
    { gid: 22, name: '瞬熟', plant: { ripe_time_sec: 600 } },
  ], { now, myGid: 1 });
  noteFriendSummaries([
    { gid: 22, name: '瞬熟', plant: { ripe_time_sec: 5 } },
  ], { now: now + 1000, myGid: 1 });
  const dueAt = getNextWatchDueAt(now + 1000);
  assert.equal(getWatchStateForTests(22, now + 1000).status, WATCH_STATUS.HOT);
  assert.ok(dueAt > now + 1000);
  assert.ok(dueAt < now + 5000);
});

test('a thirty-minute summary shock is cached per friend and enters HOT immediately', () => {
  const now = 1_700_000_000_000;
  noteFriendSummaries([
    { gid: 30, name: '剧烈催熟', plant: { ripe_time_sec: 7200 } },
  ], { now, myGid: 1 });
  noteFriendSummaries([
    { gid: 30, name: '剧烈催熟', plant: { ripe_time_sec: 3600 } },
  ], { now: now + 1000, myGid: 1 });
  const state = getWatchStateForTests(30, now + 1000);
  const cache = getMaturityCacheForTests(30);
  assert.equal(state.status, WATCH_STATUS.HOT);
  assert.equal(cache.shock, true);
  assert.ok(cache.advanceMs >= 30 * 60 * 1000);
  assert.equal(state.transitionReason, 'summary_ripe_shock_30m');
});

test('an unchanged cached maturity does not renew HOT', () => {
  const now = 1_700_000_000_000;
  noteFriendSummaries([
    { gid: 31, name: '稳定', plant: { ripe_time_sec: 600 } },
  ], { now, myGid: 1 });
  noteFriendSummaries([
    { gid: 31, name: '稳定', plant: { ripe_time_sec: 500 } },
  ], { now: now + 1000, myGid: 1 });
  const first = getWatchStateForTests(31, now + 1000);
  noteFriendSummaries([
    { gid: 31, name: '稳定', plant: { ripe_time_sec: 499 } },
  ], { now: now + 2000, myGid: 1 });
  const stable = getWatchStateForTests(31, now + 2000);
  assert.equal(stable.status, WATCH_STATUS.HOT);
  assert.equal(stable.hotUntil, first.hotUntil);
});

test('HOT does not renew on an unchanged snapshot and cools after idle window', () => {
  const now = Date.now();
  const sec = Math.floor(now / 1000);
  inspectFriendLands(32, '不续热', [
    { id: 1, plant: { id: 100, left_inorc_fert_times: 2, phases: [{ begin_time: sec }, { begin_time: sec + 3600 }] } },
  ], now);
  inspectFriendLands(32, '不续热', [
    { id: 1, plant: { id: 100, left_inorc_fert_times: 1, phases: [{ begin_time: sec }, { begin_time: sec + 3000 }] } },
  ], now + 1000);
  const hot = getWatchStateForTests(32, now + 1000);
  assert.equal(hot.status, WATCH_STATUS.HOT);

  inspectFriendLands(32, '不续热', [
    { id: 1, plant: { id: 100, left_inorc_fert_times: 1, phases: [{ begin_time: sec }, { begin_time: sec + 3000 }] } },
  ], hot.nextVisitAt);
  const unchanged = getWatchStateForTests(32, hot.nextVisitAt);
  assert.equal(unchanged.hotUntil, hot.hotUntil);
  assert.equal(getWatchStateForTests(32, hot.hotUntil + 1).status, WATCH_STATUS.COOLDOWN);
});

test('new strong evidence renews HOT but never extends its hard cap', () => {
  const now = Date.now();
  const sec = Math.floor(now / 1000);
  inspectFriendLands(33, '续热', [
    { id: 1, plant: { id: 100, left_inorc_fert_times: 3, phases: [{ begin_time: sec }, { begin_time: sec + 3600 }] } },
  ], now);
  inspectFriendLands(33, '续热', [
    { id: 1, plant: { id: 100, left_inorc_fert_times: 2, phases: [{ begin_time: sec }, { begin_time: sec + 3300 }] } },
  ], now + 1000);
  const first = getWatchStateForTests(33, now + 1000);

  inspectFriendLands(33, '续热', [
    { id: 1, plant: { id: 100, left_inorc_fert_times: 1, phases: [{ begin_time: sec }, { begin_time: sec + 3000 }] } },
  ], now + 6000, { partial: true });
  const renewed = getWatchStateForTests(33, now + 6000);
  assert.equal(renewed.status, WATCH_STATUS.HOT);
  assert.ok(renewed.hotUntil > first.hotUntil);
  assert.ok(renewed.hotUntil <= first.hardUntil);
  assert.equal(renewed.lastVisitAt, first.lastVisitAt);
});

test('global budget yields one due trend target and enforces a minimum gap', () => {
  const now = Date.now();
  watchFriend(40, '热点A', { now, reason: 'test_strong' });
  watchFriend(41, '热点B', { now, reason: 'test_strong' });
  const dueAt = Math.max(
    getWatchStateForTests(40, now).nextVisitAt,
    getWatchStateForTests(41, now).nextVisitAt
  );
  const firstDue = getDueWatchFriends(dueAt);
  assert.equal(firstDue.length, 1);
  noteWatchVisit(firstDue[0].gid, dueAt);
  assert.equal(getDueWatchFriends(dueAt).length, 0);
  const secondDue = getDueWatchFriends(dueAt + 400);
  assert.equal(secondDue.length, 1);
  assert.notEqual(secondDue[0].gid, firstDue[0].gid);
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

test('an expiring HOT close to maturity becomes PREARM instead of polling forever', () => {
  const now = Date.now();
  const ripeAt = now + 13_000;
  watchFriend(51, '临近成熟', { now, ripeAt, reason: 'test_strong' });
  const hot = getWatchStateForTests(51, now);
  assert.equal(hot.status, WATCH_STATUS.HOT);
  const prearm = getWatchStateForTests(51, hot.hotUntil + 1);
  assert.equal(prearm.status, WATCH_STATUS.PREARM);
  assert.equal(prearm.nextVisitAt, ripeAt);
});

test('rolling global budget caps ten trend visits per ten seconds', () => {
  const now = Date.now();
  watchFriend(52, '预算测试', { now, reason: 'test_strong' });
  for (let i = 0; i < 10; i++) noteWatchVisit(52, now + i * 400);
  const scheduled = getNextWatchDueAt(now + 4000);
  assert.ok(scheduled >= now + 10_000);
});

test('one friend trend does not promote another friend', () => {
  const now = 1_700_000_000_000;
  const baseline = (gid, name) => ({ gid, name, plant: { ripe_time_sec: 600 } });
  noteFriendSummaries([baseline(60, '甲'), baseline(61, '乙')], { now, myGid: 1 });
  noteFriendSummaries([
    { gid: 60, name: '甲', plant: { ripe_time_sec: 500 } },
    { gid: 61, name: '乙', plant: { ripe_time_sec: 599 } },
  ], { now: now + 1000, myGid: 1 });
  assert.equal(getWatchStateForTests(60, now + 1000).status, WATCH_STATUS.HOT);
  assert.equal(getWatchStateForTests(61, now + 1000), null);
  assert.equal(getMaturityCacheForTests(61).shock, false);
});

test('priority friend triggers HOT on small summary advance, normal friend does not', () => {
  const now = 1_700_000_000_000;
  setPriorityGids([70]);
  const baseline = (gid, name) => ({ gid, name, plant: { ripe_time_sec: 600 } });
  noteFriendSummaries([baseline(70, '重点'), baseline(71, '路人')], { now, myGid: 1 });
  // 1 秒后倒计时从 600 变 590：成熟墙钟提前约 9 秒（>5s 重点阈值，<25s 普通阈值）
  noteFriendSummaries([
    { gid: 70, name: '重点', plant: { ripe_time_sec: 590 } },
    { gid: 71, name: '路人', plant: { ripe_time_sec: 590 } },
  ], { now: now + 1000, myGid: 1 });
  assert.equal(getWatchStateForTests(70, now + 1000).status, WATCH_STATUS.HOT);
  assert.equal(getWatchStateForTests(71, now + 1000), null);
});
