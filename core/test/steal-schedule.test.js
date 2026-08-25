const test = require('node:test');
const assert = require('node:assert/strict');
const { computeNextStealDueAt, cachedDueWithinGrace } = require('../src/services/steal-schedule');

const NOW = 1_700_000_000_000;

test('already-stealable friends wake immediately when not in a steal round', () => {
  const due = computeNextStealDueAt([
    { gid: 2, plant: { steal_plant_num: 3, ripe_time_sec: 0 } },
    { gid: 3, plant: { steal_plant_num: 0, ripe_time_sec: 120 } },
  ], { now: NOW, myGid: 1, stealingNow: false });
  assert.equal(due, NOW);
});

test('steal round keeps already-stealable friend pending until its visit result clears it', () => {
  const due = computeNextStealDueAt([
    { gid: 2, plant: { steal_plant_num: 3, ripe_time_sec: 0 } },
    { gid: 3, plant: { steal_plant_num: 0, ripe_time_sec: 40 } },
    { gid: 4, plant: { steal_plant_num: 0, ripe_time_sec: 90 } },
  ], { now: NOW, myGid: 1, stealingNow: true });
  assert.equal(due, NOW);
});

test('skips self and blacklist', () => {
  const due = computeNextStealDueAt([
    { gid: 1, plant: { steal_plant_num: 9, ripe_time_sec: 1 } },
    { gid: 8, plant: { steal_plant_num: 9, ripe_time_sec: 1 } },
    { gid: 3, plant: { steal_plant_num: 0, ripe_time_sec: 15 } },
  ], { now: NOW, myGid: 1, blacklist: new Set([8]), stealingNow: false });
  assert.equal(due, NOW + 15 * 1000);
});

test('no growing crops means no steal timer', () => {
  const due = computeNextStealDueAt([
    { gid: 2, plant: { steal_plant_num: 0, ripe_time_sec: 0 } },
  ], { now: NOW, myGid: 1, stealingNow: true });
  assert.equal(due, 0);
});

test('protobuf Long ripe_time_sec is treated as a countdown', () => {
  const due = computeNextStealDueAt([
    { gid: 3, plant: { steal_plant_num: 0, ripe_time_sec: { low: 21600, high: 0, toNumber() { return 21600; } } } },
  ], { now: NOW, myGid: 1, stealingNow: true });
  assert.equal(due, NOW + 21600 * 1000);
});

test('schedule helper can merge an explicitly supplied own maturity for non-dashboard callers', () => {
  const due = computeNextStealDueAt([
    { gid: 3, plant: { steal_plant_num: 0, ripe_time_sec: 21600 } },
  ], { now: NOW, myGid: 1, stealingNow: true, ownRipeAtMs: NOW + 3600 * 1000 });
  assert.equal(due, NOW + 3600 * 1000);
});

test('absolute server ripe timestamps convert to remaining time', () => {
  const { getServerTimeSec } = require('../src/utils/utils');
  const now = Date.now();
  const ripeAbs = getServerTimeSec() + 21600;
  const due = computeNextStealDueAt([
    { gid: 3, plant: { steal_plant_num: 0, ripe_time_sec: ripeAbs } },
  ], { now, myGid: 1, stealingNow: true });
  assert.ok(Math.abs(due - (now + 21600 * 1000)) < 2000);
});

test('nextPreRipeScanAt wakes wakeBefore minutes before ripe, then waits for ripe', () => {
  const { nextPreRipeScanAt } = require('../src/services/steal-schedule');
  const now = NOW;
  const thirtyMin = 30 * 60 * 1000;
  const sixHours = 6 * 3600 * 1000;
  assert.equal(nextPreRipeScanAt(now + sixHours, now, thirtyMin), now + sixHours - thirtyMin);
  assert.equal(nextPreRipeScanAt(now + thirtyMin, now, thirtyMin), now + thirtyMin);
  assert.equal(nextPreRipeScanAt(now + 10 * 60 * 1000, now, thirtyMin), now + 10 * 60 * 1000);
  assert.equal(nextPreRipeScanAt(0, now, thirtyMin), 0);
});

test('cached due remains retryable briefly after maturity but cannot stay pending forever', () => {
  assert.equal(cachedDueWithinGrace(NOW + 10_000, NOW), NOW + 10_000);
  assert.equal(cachedDueWithinGrace(NOW - 89_000, NOW), NOW - 89_000);
  assert.equal(cachedDueWithinGrace(NOW - 91_000, NOW), 0);
  assert.equal(cachedDueWithinGrace(0, NOW), 0);
});
