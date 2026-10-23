'use strict';
const { test, after } = require('node:test'); const assert = require('node:assert/strict');
const fs = require('node:fs'); const path = require('node:path'); const os = require('node:os'); const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const temporary = path.resolve(process.env.FARM_LOG_HISTORY_TEST_DIR || os.tmpdir());
const fixture = fs.mkdtempSync(path.join(temporary, 'own-quiet-priority-'));
process.env.FARM_DATA_DIR = fixture; process.env.FARM_ACCOUNT_ID = 'synthetic-own-priority';
after(() => { assert.equal(path.dirname(fixture), temporary); fs.rmSync(fixture, { recursive: true, force: true }); });
const utils = require('../src/utils/utils'); const { CONFIG, PlantPhase } = require('../src/config/config');
const analyzer = require('../src/services/farm-land-analyzer'); const priority = require('../src/services/own-quiet-priority');
const behavior = require('../src/utils/behavior');
const source = fs.readFileSync(path.join(__dirname, '../src/services/farming-orchestrator.js'), 'utf8');
const stateSource = fs.readFileSync(path.join(__dirname, '../src/services/business-state.js'), 'utf8');
const base = 1_800_000_000;
const growing = (id, at) => ({ id, unlocked: true, plant: { id: 1001, season: 1,
  phases: at <= base ? [{ phase: 6, begin_time: at }] : [{ phase: 2, begin_time: base - 100 }, { phase: 6, begin_time: at }] } });
const empty = id => ({ id, unlocked: true });
const dead = id => ({ id, unlocked: true, plant: { id: 1001, phases: [{ phase: 7, begin_time: base - 1 }] } });
function harness({ initial = [growing(1, base)], snapshot, multiSeason = false } = {}) {
  let now = base; let lands = initial; let quiet = 600_000; let blockPlant; let failPlant = false; let failHarvest = false; let incomplete = false; let onPurchaseAttempt; let failBeforePurchase = false;
  const flags = { farm: true, harvest: true, plant: true, farm_push: false }; const calls = []; const events = new EventEmitter();
  class Clock extends Date { static now() { return now * 1000; } }
  const deps = {
    '../config/config': { CONFIG, PlantPhase },
    '../utils/network': { getUserState: () => ({ gid: 42 }), isConnected: () => true, networkEvents: events },
    '../utils/utils': { ...utils, getServerTimeMs: () => now * 1000, getServerTimeSec: () => now, randomDelay: async () => {}, log() {}, logWarn() {} },
    '../models/store': { isAutomationOn: key => !!flags[key], getAutomation: () => flags, getPrioritize2x2Crops: () => false, getPauseRemainMs: () => quiet },
    './stats': { recordOperation() {} }, './daily-events': { recordEvent() {} },
    './scheduler': { createScheduler: () => ({ setTimeoutTask() {}, bindTimeoutTask() {}, clearAll() {} }) },
    './farm-api': { getAllLands: async () => { calls.push(['AllLands']); return { lands: incomplete ? [] : lands }; },
      harvest: async ids => { calls.push(['Harvest', [...ids]]); if (failHarvest) throw new Error('uncertain Harvest');
        lands = lands.map(land => ids.includes(land.id) ? { ...land, ...(multiSeason ? growing(land.id, now + 60) : dead(land.id)) } : land);
        return { land: lands.filter(land => ids.includes(land.id)) }; },
      farming() { throw new Error('unexpected Farming'); }, unlockLand() { throw new Error('unexpected unlock'); }, upgradeLand() { throw new Error('unexpected upgrade'); } },
    './farm-land-analyzer': analyzer,
    './farm-fertilizer': { runFertilizerByConfig: async ids => calls.push(['Fertilize', [...ids]]) },
    './planting-service': { autoPlantEmptyLands: async (deadIds, emptyIds, _lands, options) => {
      assert.equal(options.ownQuietPriority, true); const ids = require('../src/services/planting-service').expandRemoved2x2Lands(emptyIds, deadIds, _lands); calls.push(['Plant', ids, options.bagOnly]);
      if (blockPlant) await blockPlant;
      if (failBeforePurchase) throw new Error('ShopInfo unavailable before purchase');
      if (!options.bagOnly) onPurchaseAttempt();
      if (failPlant) throw new Error('uncertain Plant');
      lands = lands.map(land => ids.includes(land.id) ? growing(land.id, now + 60) : land);
      return { plantedLands: ids, plantedCount: ids.length, occupiedCount: ids.length };
    } },
    './farm-scheduler': { startFertilizerBuyCheckTimer() {}, stopFertilizerBuyCheckTimer() {} },
    '../utils/behavior': { ...behavior, markOwnHarvestDueAt() {} },
    './friend-activity': { noteSocialItems() {}, noteMischiefOwners() {} }, './own-quiet-priority': { ...priority, run(scope, callback) { onPurchaseAttempt = scope.onPurchaseAttempt; return priority.run(scope, callback); } },
  };
  const sandbox = vm.createContext({ module: { exports: {} }, Map, Set, Date: Clock, Promise,
    process: { env: { FARM_SESSION_BUSINESS: '1', FARM_ACCOUNT_ID: process.env.FARM_ACCOUNT_ID } } });
  vm.runInContext(stateSource, sandbox); const state = sandbox.module.exports; deps['./business-state'] = state;
  sandbox.module = { exports: {} }; sandbox.require = name => { assert.ok(Object.hasOwn(deps, name), name); return deps[name]; };
  vm.runInContext(source, sandbox); const farm = sandbox.module.exports;
  if (snapshot) {
    sandbox.incoming = snapshot;
    state.restoreBusinessState(vm.runInContext(`(function copy(v) { if(v instanceof Map)return new Map([...v].map(([k,x])=>[k,copy(x)])); if(Array.isArray(v))return v.map(copy); if(v&&typeof v==='object'){const out={};for(const[k,x]of Object.entries(v))out[k]=copy(x);return out;}return v;})(incoming)`, sandbox));
  }
  farm.startFarmCheckLoop({ externalScheduler: true });
  events.on('farmHarvested', event => { if (event.quietPriority || quiet > 0) farm.deferOwnHarvestSale(); else calls.push(['Sell']); });
  return { farm, flags, calls, events, state, advance(sec) { now += sec; utils.syncServerTime(now * 1000); },
    quiet(value) { quiet = value; }, get quietRemaining() { return quiet; }, setLands(value) { lands = value; },
    failPlant(value) { failPlant = value; }, failBeforePurchase(value) { failBeforePurchase = value; }, failHarvest(value) { failHarvest = value; }, incomplete(value) { incomplete = value; }, blockPlant(value) { blockPlant = value; },
    strike() { utils.syncServerTime(now * 1000); return farm.harvestOwnAtMaturity(); } };
}

test('own harvest/replant preserves quiet, schedules another crop, and defers sale/fertilizer', async () => {
  const h = harness(); await h.strike();
  assert.deepEqual(h.calls.map(c => c[0]), ['AllLands', 'Harvest', 'AllLands', 'Plant', 'AllLands']);
  assert.equal(h.quietRemaining, 600_000); assert.equal(h.farm.getNextMatureDueAtMs(), (base + 60) * 1000);
  await h.farm.flushOwnPriorityDeferred(); assert.equal(h.calls.some(c => ['Sell', 'Fertilize'].includes(c[0])), false);
  h.advance(60); await h.strike(); assert.equal(h.calls.filter(c => c[0] === 'Harvest').length, 2);
  h.quiet(0); await h.farm.flushOwnPriorityDeferred(); assert.deepEqual(h.calls.slice(-2).map(c => c[0]), ['Sell', 'Fertilize']);
});
test('own replant keeps friend yield after harvest and across quiet end; reentry is rejected', async () => {
  const h = harness(); let release; h.blockPlant(new Promise(resolve => { release = resolve; }));
  const task = h.strike(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(priority.isActive(), true); assert.equal(behavior.ownHarvestIsDue(), true);
  h.quiet(0); assert.equal(behavior.ownHarvestIsImminent(), true);
  const count = h.calls.length; await h.farm.runFarmOperation('all', { automatic: true }); assert.equal(h.calls.length, count);
  await assert.rejects(h.strike(), /事务仍在执行/); release(); await task; assert.equal(priority.isActive(), false);
});
test('multi-season growth and disabled plant never remove or plant; disabled harvest never reads', async () => {
  const h = harness({ multiSeason: true }); await h.strike(); assert.equal(h.calls.some(c => c[0] === 'Plant'), false);
  assert.equal(h.farm.getNextMatureDueAtMs(), (base + 60) * 1000);
  const off = harness(); off.flags.harvest = false; await off.strike(); assert.equal(off.calls.length, 0);
  off.flags.harvest = true; off.flags.plant = false; await off.strike(); assert.equal(off.calls.some(c => c[0] === 'Plant'), false);
});
test('uncertain Plant persists targets and backs off; inventory retry never repeats Harvest', async () => {
  const h = harness(); h.failPlant(true); await assert.rejects(h.strike(), /uncertain Plant/);
  assert.equal(h.farm.getNextMatureDueAtMs(), (base + 30) * 1000);
  const count = h.calls.length; await h.strike(); assert.equal(h.calls.length, count);
  h.advance(30); h.failPlant(false); await h.strike(); assert.equal(h.calls.filter(c => c[0] === 'Harvest').length, 1);
  assert.equal(h.calls.filter(c => c[0] === 'Plant').at(-1)[2], true);
});
test('uncertain Harvest reconciles before retry and does not repeat a consumed harvest', async () => {
  const h = harness(); h.failHarvest(true); await assert.rejects(h.strike(), /uncertain Harvest/);
  h.setLands([dead(1)]); h.failHarvest(false); h.advance(30); await h.strike();
  assert.equal(h.calls.filter(c => c[0] === 'Harvest').length, 1); assert.equal(h.calls.some(c => c[0] === 'Plant'), true);
});
test('incomplete snapshot keeps pending work and unknown plants untouched', async () => {
  const h = harness(); h.events.on('farmHarvested', () => h.incomplete(true)); await assert.rejects(h.strike(), /快照暂不可用/);
  assert.equal(h.calls.some(c => c[0] === 'Plant'), false); assert.ok(h.farm.getNextMatureDueAtMs() > base * 1000);
});
test('partial quiet pushes update one deadline without losing other land', async () => {
  const h = harness({ initial: [growing(1, base + 60), growing(2, base + 120)] }); await h.strike();
  h.events.emit('landsChanged', [growing(2, base + 30)]); assert.equal(h.farm.getNextMatureDueAtMs(), (base + 30) * 1000);
  h.events.emit('landsChanged', [empty(2)]); assert.equal(h.farm.getNextMatureDueAtMs(), (base + 60) * 1000);
});
test('warm checkpoint resumes pending inventory retry once and accepts only declared legacy defaults', async () => {
  const h = harness(); h.failPlant(true); await assert.rejects(h.strike());
  const checkpoint = h.state.snapshotBusinessState(); const restored = harness({ initial: [dead(1)], snapshot: checkpoint });
  restored.advance(30); await restored.strike(); assert.equal(restored.calls.some(c => c[0] === 'Harvest'), false);
  assert.equal(restored.calls.find(c => c[0] === 'Plant')[2], true);
  delete checkpoint.domains['services/farming-orchestrator.js'].value.ownQuietState;
  const old = harness({ initial: [growing(1, base + 120)], snapshot: checkpoint }); assert.ok(old.farm.getNextMatureDueAtMs() > 0);
  checkpoint.domains['services/farming-orchestrator.js'].value.unrecognized = true;
  assert.throws(() => harness({ snapshot: checkpoint }), /fields changed/);
});

test('a failure before BuyGoods does not permanently disable the configured shop fallback', async () => {
  const h = harness(); h.failBeforePurchase(true); await assert.rejects(h.strike(), /before purchase/);
  h.failBeforePurchase(false); h.advance(30); await h.strike();
  assert.equal(h.calls.filter(c => c[0] === 'Plant').at(-1)[2], false);
});

test('legacy capsule rebuilds the four-cell footprint before its first protected harvest', async () => {
  const master = { ...growing(5, base), land_size: 2, slave_land_ids: [1, 2, 6] };
  const lands = [master, ...[1, 2, 6].map(id => ({ ...empty(id), master_land_id: 5 }))];
  const h = harness({ initial: lands });
  await h.farm.runFarmOperation('upgrade');
  const checkpoint = h.state.snapshotBusinessState();
  delete checkpoint.domains['services/farming-orchestrator.js'].value.ownQuietState;
  const warm = harness({ initial: lands, snapshot: checkpoint });
  await warm.strike();
  assert.equal(warm.calls[0][0], 'AllLands');
  assert.deepEqual([...warm.calls.find(c => c[0] === 'Plant')[1]].sort((a, b) => a - b), [1, 2, 5, 6]);
});

test('multi-season four-cell crop clears its whole occupied footprint without premature snapshot retries', async () => {
  const lands = [{ ...growing(5, base), land_size: 2, slave_land_ids: [1, 2, 6] },
    ...[1, 2, 6].map(id => ({ ...empty(id), master_land_id: 5 }))];
  const h = harness({ initial: lands, multiSeason: true });
  await h.strike();
  assert.equal(h.calls.some(c => c[0] === 'Plant'), false);
  assert.equal(h.farm.getNextMatureDueAtMs(), (base + 60) * 1000);
  const count = h.calls.length; h.advance(30); await h.strike(); assert.equal(h.calls.length, count);
});
