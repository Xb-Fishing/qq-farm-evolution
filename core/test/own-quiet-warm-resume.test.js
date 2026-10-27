'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../src/core/worker.js'), 'utf8');
function actual(name) {
  const begin = new RegExp(`function ${name}\\(`).exec(source).index;
  return source.slice(begin, source.indexOf('\n}', begin) + 2);
}
const refresh = source.match(/refreshRewardsSchedule: (\(\) => \{[\s\S]*?\}),\n\s*send:/)[1];
test('warm activation replaces a restored quiet-until timer with the preserved own maturity deadline', () => {
  const now = Date.now();
  const dueAt = now + 60_000;
  const quietUntil = now + 4 * 3600_000;
  const tasks = new Map([['own_harvest_guard', { dueAt: quietUntil }]]);
  let marked = 0;
  let unifiedCalls = 0;
  const sandbox = vm.createContext({ Date, loginReady: true, unifiedSchedulerRunning: true,
    ownHarvestArmedFor: dueAt, ownHarvestRetryAttempt: 4, ownHarvestDueAt: () => dueAt,
    getAutomation: () => ({ farm: true, harvest: true }), OWN_HARVEST_ACT_DELAY_MS: [30, 80],
    randInt: min => min, markOwnHarvestDueAt: value => { marked = value; }, onTimer_own_harvest_guard() {},
    scheduleUnifiedNextTick: () => { unifiedCalls++; },
    workerScheduler: { has: name => tasks.has(name), clear: name => tasks.delete(name),
      setTimeoutTask: (name, delay) => tasks.set(name, { dueAt: now + delay }) },
  });
  vm.runInContext([actual('setOwnHarvestGuardTimer'), actual('armOwnHarvestGuard'), `const refresh = ${refresh};`].join('\n'), sandbox);
  vm.runInContext('refresh()', sandbox);
  assert.equal(marked, dueAt);
  assert.ok(Math.abs(tasks.get('own_harvest_guard').dueAt - (dueAt + 30)) < 100);
  assert.ok(tasks.get('own_harvest_guard').dueAt < quietUntil);
  assert.equal(sandbox.ownHarvestRetryAttempt, 0); assert.equal(unifiedCalls, 1);
  sandbox.getAutomation = () => ({ farm: false, harvest: false });
  vm.runInContext('refresh()', sandbox); assert.equal(tasks.has('own_harvest_guard'), false);
});
