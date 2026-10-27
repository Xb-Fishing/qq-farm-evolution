const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const prefix = path.resolve(os.tmpdir(), 'milk-auto-control-');
assert.equal(path.dirname(prefix), fs.realpathSync(os.tmpdir()));
const data = fs.mkdtempSync(prefix);
process.env.FARM_DATA_DIR = data;
process.env.FARM_ACCOUNT_ID = 'synthetic-milk-auto-control';
after(() => fs.rmSync(data, { recursive: true, force: true }));
const store = require('../src/models/store');
const milk = require('../src/services/milk-tea-activity');

test('activity rewards default off and enabling them leaves disabled ordinary tasks unchanged', () => {
  assert.equal(store.getAutomation().milk_tea_auto_rewards, false);
  store.applyConfigSnapshot({ automation: { task: false, milk_tea_auto_rewards: true } }, { persist: false });
  assert.equal(store.getAutomation().task, false);
  assert.equal(store.getAutomation().milk_tea_auto_rewards, true);
  const now = Date.now();
  assert.ok(milk.automaticMilkTeaWakeAt(now) <= now, 'activity wake must not depend on ordinary task preference');
});

test('disabling activity rewards stops their deadline even when ordinary tasks stay enabled', () => {
  store.applyConfigSnapshot({ automation: { task: true, milk_tea_auto_rewards: false } }, { persist: false });
  assert.equal(store.getAutomation().task, true);
  assert.ok(milk.automaticMilkTeaWakeAt(Date.now()) > Date.now() + 60000);
});

test('real unified caller dispatches activity rewards with task off, and never dispatches them from task alone', async () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../src/core/worker.js'), 'utf8');
  const start = source.indexOf('async function runUnifiedTick(');
  const end = source.indexOf('\n}', start);
  let calls = 0;
  const now = Date.now();
  const auto = { task: false, milk_tea_auto_rewards: true, friend_steal: false };
  const sandbox = {
    Date, unifiedSchedulerRunning: true, loginReady: true, friendSyncPaused: false,
    armOwnHarvestGuard() {}, pauseRemainMsNow: () => 0, resumeAceReports() {}, markIdleQuietUntil() {},
    getAutomation: () => auto, ownHarvestDueAt: () => 0, nextScheduledStealAt: () => now + 600000,
    nextFarmRunAt: now + 600000, nextHelpRunAt: now + 600000, nextActivityRewardsAt: () => now,
    nextStealRunAt: now + 600000,
    stealIsImminent: () => false, stealIsDue: () => false, markStealDueAt() {}, STEAL_IDLE_MS: 86400000,
    ownHarvestIsDue: () => false, ownHarvestIsImminent: () => false, OWN_HARVEST_RESERVE_MS: 10000,
    require: name => {
      assert.equal(name, '../services/milk-tea-activity');
      return { runAutomaticMilkTea: async deps => { assert.equal(deps.canRun(), true); calls++; } };
    },
  };
  vm.createContext(sandbox); vm.runInContext(source.slice(start, end + 2), sandbox);
  await sandbox.runUnifiedTick(); assert.equal(calls, 1);
  auto.task = true; auto.milk_tea_auto_rewards = false;
  await sandbox.runUnifiedTick(); assert.equal(calls, 1);
});
