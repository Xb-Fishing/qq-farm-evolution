const test = require('node:test');
const assert = require('node:assert/strict');
const {
  randInt,
  gaussianInt,
  shuffleInPlace,
  delayMsFromSeconds,
  maybeStretchDelay,
  stealOverdueBackoffMs,
} = require('../src/utils/behavior');

test('randInt stays in range', () => {
  for (let i = 0; i < 80; i++) {
    const n = randInt(3, 7);
    assert.ok(n >= 3 && n <= 7);
  }
  assert.equal(randInt(4, 4), 4);
});

test('gaussianInt stays in range and clusters near midpoint', () => {
  const samples = Array.from({ length: 200 }, () => gaussianInt(1000, 3000));
  assert.ok(samples.every((n) => n >= 1000 && n <= 3000));
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  assert.ok(mean > 1600 && mean < 2400, `mean ${mean}`);
});

test('shuffleInPlace keeps the same members', () => {
  const src = [1, 2, 3, 4, 5];
  const copy = [...src];
  shuffleInPlace(copy);
  assert.deepEqual([...copy].sort((a, b) => a - b), src);
});

test('delayMsFromSeconds respects zero and jitters around the base', () => {
  assert.equal(delayMsFromSeconds(0), 0);
  const samples = Array.from({ length: 40 }, () => delayMsFromSeconds(2));
  assert.ok(samples.every((n) => n >= 1300 && n <= 2700));
});

test('maybeStretchDelay sometimes adds idle time', () => {
  const stretched = Array.from({ length: 80 }, () => maybeStretchDelay(5000, 1));
  assert.ok(stretched.every((n) => n >= 13000 && n <= 27000));
  assert.equal(maybeStretchDelay(5000, 0), 5000);
});

test('overdue steal retries back off immediately and cap near 30 seconds', () => {
  const first = Array.from({ length: 40 }, () => stealOverdueBackoffMs(0));
  assert.ok(first.every((n) => n >= 900 && n <= 1800));
  const repeated = Array.from({ length: 40 }, () => stealOverdueBackoffMs(99));
  assert.ok(repeated.every((n) => n >= 30_150 && n <= 30_850));
});

test('idleNapMs stays on patrol when mature is within 30 minutes', () => {
  const { idleNapMs } = require('../src/utils/behavior');
  assert.equal(idleNapMs(30 * 60 * 1000, 10_000), 10_000);
  assert.equal(idleNapMs(20 * 60 * 1000, 12_000), 12_000);
});

test('idleNapMs naps when nothing is scheduled at all', () => {
  const { idleNapMs } = require('../src/utils/behavior');
  const tenMin = 10 * 60 * 1000;
  const oneMin = 60 * 1000;
  const naps = Array.from({ length: 40 }, () => idleNapMs(0, 12_000, { maxSleepMs: tenMin }));
  assert.ok(naps.every((n) => n >= oneMin && n <= tenMin));
});

test('idleNapMs sleeps up to the configured max then leaves a 30-minute window', () => {
  const { idleNapMs } = require('../src/utils/behavior');
  const twoHours = 2 * 3600 * 1000;
  const oneMin = 60 * 1000;
  const far = Array.from({ length: 40 }, () => idleNapMs(6 * 3600 * 1000, 10_000, { maxSleepMs: twoHours }));
  assert.ok(far.every((n) => n >= oneMin && n <= twoHours));
  const fortyMin = 40 * 60 * 1000;
  const short = Array.from({ length: 40 }, () => idleNapMs(fortyMin, 10_000, { maxSleepMs: twoHours }));
  assert.ok(short.every((n) => n >= oneMin && n <= 10 * 60 * 1000));
});

test('idleNapMs uses a custom active window in minutes', () => {
  const { idleNapMs } = require('../src/utils/behavior');
  const tenMin = 10 * 60 * 1000;
  const oneMin = 60 * 1000;
  assert.equal(idleNapMs(tenMin, 10_000, { activeMs: tenMin }), 10_000);
  const twoHours = 2 * 3600 * 1000;
  const naps = Array.from({ length: 40 }, () => idleNapMs(40 * 60 * 1000, 10_000, {
    maxSleepMs: twoHours,
    activeMs: tenMin,
  }));
  assert.ok(naps.every((n) => n >= oneMin && n <= 30 * 60 * 1000));
});

test('steal priority flags flip at the due time', () => {
  const { markStealDueAt, stealIsDue, stealIsImminent } = require('../src/utils/behavior');
  markStealDueAt(Date.now() + 5000);
  assert.equal(stealIsDue(), false);
  assert.equal(stealIsImminent(1500), false);
  assert.equal(stealIsImminent(8000), true);
  markStealDueAt(Date.now() - 1);
  assert.equal(stealIsDue(), true);
  markStealDueAt(0);
  assert.equal(stealIsDue(), false);
});

test('own harvest priority reserves the channel before its exact due time', () => {
  const {
    markOwnHarvestDueAt,
    ownHarvestIsDue,
    ownHarvestIsImminent,
    getOwnHarvestDueAt,
  } = require('../src/utils/behavior');
  const now = 1_000_000;
  markOwnHarvestDueAt(now + 10_000);
  assert.equal(getOwnHarvestDueAt(), now + 10_000);
  assert.equal(ownHarvestIsDue(now), false);
  assert.equal(ownHarvestIsImminent(9_999, now), false);
  assert.equal(ownHarvestIsImminent(10_000, now), true);
  assert.equal(ownHarvestIsDue(now + 10_000), true);
  markOwnHarvestDueAt(0);
  assert.equal(ownHarvestIsDue(now + 20_000), false);
});
