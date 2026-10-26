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
  let now = base; let lands = initial; let quiet = 600_000; let blockPlant; let failPlant = false; let failHarvest = false; let incomplete = false; let onPurchaseAttempt; let failBeforePurchase = false; let afterScope;
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
        const seasonOf = id => multiSeason === true || (multiSeason instanceof Set && multiSeason.has(id));
        lands = lands.map(land => ids.includes(land.id) ? { ...land, ...(seasonOf(land.id) ? growing(land.id, now + 60) : dead(land.id)) } : land);
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
    './friend-activity': { noteSocialItems() {}, noteMischiefOwners() {} }, './own-quiet-priority': { ...priority, async run(scope, callback) { onPurchaseAttempt = scope.onPurchaseAttempt; const result = await priority.run(scope, callback); if (afterScope) afterScope(); return result; } },
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
    afterScope(value) { afterScope = value; },
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

// ── 连续成熟合并补种：到点收获仍逐块，收后读地/补种合并到最后一批 ──
const quietCapsule = h => h.state.snapshotBusinessState().domains['services/farming-orchestrator.js'].value.ownQuietState;

test('24 plots ripening every 2s merge replant into one batch; waits never count as backoff', async () => {
  const h = harness({ initial: Array.from({ length: 24 }, (_, i) => growing(i + 1, base + 2 * i)) });
  for (let step = 1; step <= 24; step++) {
    const outcome = await h.strike();
    assert.equal(outcome.harvestedCount, 1, `step ${step}`);
    assert.equal(priority.isActive(), false, `scope released at step ${step}`);
    if (step <= 23) { // 初始化后前 23 趟：只有到点 Harvest，零新增 AllLands/Plant
      assert.equal(h.calls.filter(c => c[0] === 'AllLands').length, 1, `step ${step}`);
      assert.equal(h.calls.some(c => c[0] === 'Plant'), false, `step ${step}`);
      assert.equal(h.farm.getNextMatureDueAtMs(), (base + 2 * step) * 1000, `step ${step}`);
    }
    if (step === 1) {
      const capsule = quietCapsule(h);
      assert.deepEqual([...capsule.pending], [1]);
      assert.equal(capsule.retryAt, (base + 2) * 1000); // 下一真实成熟墙钟，不是退避
      assert.equal(capsule.attempts, 0);
    }
    if (step < 24) h.advance(2);
  }
  assert.deepEqual(h.calls.slice(-3).map(c => c[0]), ['AllLands', 'Plant', 'AllLands']);
  assert.equal(h.calls.filter(c => c[0] === 'Harvest').length, 24);
  assert.equal(h.calls.filter(c => c[0] === 'AllLands').length, 3);
  const plants = h.calls.filter(c => c[0] === 'Plant');
  assert.equal(plants.length, 1);
  assert.deepEqual([...plants[0][1]].sort((a, b) => a - b), Array.from({ length: 24 }, (_, i) => i + 1));
  const settled = quietCapsule(h);
  assert.deepEqual([...settled.pending], []); assert.equal(settled.retryAt, 0);
  assert.equal(settled.attempts, 0); assert.equal(settled.bagOnly, false);
  assert.equal(h.farm.getNextMatureDueAtMs(), (base + 46 + 60) * 1000); // 合并补种后的新一茬
});

test('deferral engages at exactly 10s and replants immediately beyond it', async () => {
  const edge = harness({ initial: [growing(1, base), growing(2, base + 10)] });
  await edge.strike();
  assert.deepEqual(edge.calls.map(c => c[0]), ['AllLands', 'Harvest']);
  assert.equal(quietCapsule(edge).retryAt, (base + 10) * 1000);
  assert.equal(edge.farm.getNextMatureDueAtMs(), (base + 10) * 1000);
  edge.advance(10); await edge.strike();
  assert.equal(edge.calls.filter(c => c[0] === 'Harvest').length, 2);
  assert.deepEqual([...edge.calls.find(c => c[0] === 'Plant')[1]].sort((a, b) => a - b), [1, 2]);
  const far = harness({ initial: [growing(1, base), growing(2, base + 11)] });
  await far.strike();
  assert.deepEqual(far.calls.map(c => c[0]), ['AllLands', 'Harvest', 'AllLands', 'Plant', 'AllLands']);
  assert.deepEqual([...far.calls.find(c => c[0] === 'Plant')[1]], [1]);
});

test('warm capsule with a deferred replant wakes on time only, never reharvesting', async () => {
  const donor = harness({ initial: [growing(1, base), growing(2, base + 8)] });
  await donor.strike(); // Harvest[1]，pending=[1] 合并等待到 base+8
  const capsule = donor.state.snapshotBusinessState();
  const h = harness({ initial: [dead(1), growing(2, base + 8)], snapshot: capsule });
  assert.equal(h.farm.getNextMatureDueAtMs(), (base + 8) * 1000);
  const before = h.calls.length; await h.strike(); // 提前唤醒：零请求
  assert.equal(h.calls.length, before);
  h.advance(8); await h.strike();
  assert.deepEqual(h.calls.filter(c => c[0] === 'Harvest').map(c => [c[0], [...c[1]]]), [['Harvest', [2]]]); // 不重收旧地
  assert.deepEqual([...h.calls.find(c => c[0] === 'Plant')[1]].sort((a, b) => a - b), [1, 2]);
  assert.deepEqual([...quietCapsule(h).pending], []);
});

test('uncertain merged replant keeps targets and bagOnly, recovering without a second harvest', async () => {
  const h = harness({ initial: [growing(1, base), growing(2, base + 2), growing(3, base + 4)] });
  await h.strike(); h.advance(2); await h.strike();
  h.advance(2); h.failPlant(true);
  await assert.rejects(h.strike(), /uncertain Plant/);
  assert.deepEqual([...quietCapsule(h).pending], [1, 2, 3]);
  assert.equal(h.farm.getNextMatureDueAtMs(), (base + 34) * 1000);
  h.advance(30); h.failPlant(false); await h.strike();
  assert.equal(h.calls.filter(c => c[0] === 'Harvest').length, 3); // 无重复收获
  const plants = h.calls.filter(c => c[0] === 'Plant');
  assert.equal(plants.length, 2);
  assert.deepEqual([...plants.at(-1)[1]].sort((a, b) => a - b), [1, 2, 3]);
  assert.equal(plants.at(-1)[2], true); // bagOnly 胶囊延续
  assert.deepEqual([...quietCapsule(h).pending], []);
});

test('scope cleanup crossing the deferred deadline never turns a normal wait into backoff', async () => {
  const h = harness({ initial: [growing(1, base), growing(2, base + 2)] });
  h.afterScope(() => { h.afterScope(null); h.advance(2); });
  assert.equal((await h.strike()).harvestedCount, 1);
  assert.equal(quietCapsule(h).attempts, 0);
  assert.equal(quietCapsule(h).retryAt, (base + 2) * 1000);
  assert.equal(priority.isActive(), false);
  assert.equal((await h.strike()).harvestedCount, 1);
  assert.deepEqual(h.calls.filter(c => c[0] === 'Harvest').map(c => [...c[1]]), [[1], [2]]);
  assert.deepEqual([...h.calls.find(c => c[0] === 'Plant')[1]], [1, 2]);
});

test('failed final snapshot preserves the merged targets and retries reads without harvesting twice', async () => {
  const h = harness({ initial: [growing(1, base), growing(2, base + 2)] });
  await h.strike(); h.advance(2);
  h.events.once('farmHarvested', () => h.incomplete(true));
  await assert.rejects(h.strike(), /收后土地快照暂不可用/);
  assert.equal(priority.isActive(), false);
  assert.deepEqual([...quietCapsule(h).pending], [1, 2]);
  assert.equal(quietCapsule(h).bagOnly, false);
  assert.equal(quietCapsule(h).retryAt, (base + 32) * 1000);
  assert.equal(h.calls.some(c => c[0] === 'Plant'), false);
  h.advance(30); h.incomplete(false); await h.strike();
  assert.equal(h.calls.filter(c => c[0] === 'Harvest').length, 2);
  assert.deepEqual([...h.calls.find(c => c[0] === 'Plant')[1]], [1, 2]);
  assert.deepEqual([...quietCapsule(h).pending], []);
});

test('multi-season 2x2 footprint stays intact across a merged replant', async () => {
  const lands = [{ ...growing(5, base), land_size: 2, slave_land_ids: [1, 2, 6] },
    ...[1, 2, 6].map(id => ({ ...empty(id), master_land_id: 5 })), growing(3, base + 2)];
  const h = harness({ initial: lands, multiSeason: new Set([5]) }); // 只有主地换季，#3 收后枯死待补种
  await h.strike(); // 主地到点收获后新一季 base+60，地块#3 两秒后到期 → 合并等待
  assert.deepEqual(h.calls.map(c => c[0]), ['AllLands', 'Harvest']);
  assert.deepEqual([...quietCapsule(h).pending], [5, 1, 2, 6]);
  h.advance(2); await h.strike(); // #3 收获后无下一成熟点 → 合并补种
  assert.deepEqual(h.calls.filter(c => c[0] === 'Harvest').map(c => [c[0], [...c[1]]]),
    [['Harvest', [5]], ['Harvest', [3]]]);
  assert.deepEqual([...h.calls.find(c => c[0] === 'Plant')[1]], [3]); // 占地从属不拆种
});

test('plant switch off never defers and still replants nothing', async () => {
  const h = harness({ initial: [growing(1, base), growing(2, base + 4)] });
  h.flags.plant = false;
  await h.strike();
  assert.deepEqual(h.calls.map(c => c[0]), ['AllLands', 'Harvest', 'AllLands']);
  assert.deepEqual([...quietCapsule(h).pending], []);
  h.advance(4); await h.strike();
  assert.equal(h.calls.filter(c => c[0] === 'Harvest').length, 2);
  assert.equal(h.calls.some(c => c[0] === 'Plant'), false);
});

// ── 真实 request-governor：合并后的整段请求不撞 80/30 预算，硬拦截仍在 ──
const governorSource = fs.readFileSync(path.join(__dirname, '../src/services/request-governor.js'), 'utf8');
function freshGovernor() {
  const sandbox = vm.createContext({ module: { exports: {} }, process: { env: { NODE_TEST_CONTEXT: 'isolated' } } });
  vm.runInContext(governorSource, sandbox);
  return sandbox.module.exports;
}
const PLANT_SVC = 'gamepb.plantpb.PlantService'; const VISIT_SVC = 'gamepb.visitpb.VisitService';
const SHOP_SVC = 'gamepb.shoppb.ShopService';

test('merged 24-plot segment stays inside the real governor 80 total / 30 per-method budget', async () => {
  const h = harness({ initial: Array.from({ length: 24 }, (_, i) => growing(i + 1, base + 2 * i)) });
  for (let step = 1; step <= 24; step++) { await h.strike(); if (step < 24) h.advance(2); }
  const governor = freshGovernor(); const now = 1_900_000_000_000;
  const sequence = [];
  for (const call of h.calls) {
    if (call[0] !== 'Plant') { sequence.push([PLANT_SVC, call[0]]); continue; }
    // 明确的补种夹具：批量移除、一次商店读/买、每块一次 Plant。
    // 只证明这份回放的预算，不代表真实背包/策略的全部额外请求。
    sequence.push([PLANT_SVC, 'RemovePlant'], [SHOP_SVC, 'ShopInfo'], [SHOP_SVC, 'BuyGoods']);
    for (const id of call[1]) sequence.push([PLANT_SVC, 'Plant']);
  }
  for (const [service, method] of sequence) {
    assert.equal(governor.checkRequest(service, method, now).allowed, true, `${service}.${method}`);
    governor.recordSent(service, method, true, now);
  }
  const profile = governor.getRequestProfile(now);
  assert.equal(profile.totalLimit, 80); assert.equal(profile.perMethodLimit, 30);
  assert.equal(profile.windowCount, 54); // 24 Harvest + 3 AllLands + 3 商店/移除 + 24 Plant
  assert.ok(Math.max(...profile.top.map(entry => entry.count)) <= profile.perMethodLimit);
});

test('governor keeps hard blocks while urgent, HOT and own-harvest chains pass', () => {
  const governor = freshGovernor(); const now = 1_900_000_000_000;
  const put = (service, method) => {
    assert.equal(governor.checkRequest(service, method, now).allowed, true, method);
    governor.recordSent(service, method, true, now);
  };
  for (let i = 0; i < 30; i++) put(PLANT_SVC, 'Plant');
  const methodBlock = governor.checkRequest(PLANT_SVC, 'Plant', now);
  assert.equal(methodBlock.allowed, false); assert.equal(methodBlock.reason, 'budget_method');
  assert.equal(governor.checkRequest(PLANT_SVC, 'Harvest', now).reason, 'whitelist');
  for (let i = 0; i < 30; i++) put(PLANT_SVC, 'AllLands');
  for (let i = 0; i < 20; i++) put(PLANT_SVC, 'RemovePlant');
  const totalBlock = governor.checkRequest(PLANT_SVC, 'RemovePlant', now);
  assert.equal(totalBlock.allowed, false); assert.equal(totalBlock.reason, 'budget_total');
  governor.setUrgentMode(true, now + 5_000); // 好友到点急链 / PREARM 预进门
  for (const [service, method] of [[VISIT_SVC, 'Enter'], [VISIT_SVC, 'Leave'], [PLANT_SVC, 'AllLands'],
    [PLANT_SVC, 'CheckCanOperate'], [PLANT_SVC, 'Harvest']])
    assert.equal(governor.checkRequest(service, method, now).allowed, true, method);
  governor.setUrgentMode(false);
  assert.equal(governor.checkRequest(VISIT_SVC, 'Enter', now).allowed, false);
  governor.setWatchMode(true, now + 60_000); // 施肥 HOT：总量×1.5、进门/读地×3
  assert.equal(governor.checkRequest(VISIT_SVC, 'Enter', now).allowed, true);
  assert.equal(governor.checkRequest(PLANT_SVC, 'AllLands', now).allowed, true);
  for (let i = 0; i < 40; i++) governor.recordSent(VISIT_SVC, 'Enter', true, now);
  assert.equal(governor.checkRequest(PLANT_SVC, 'AllLands', now).reason, 'budget_total');
  const slowed = freshGovernor();
  for (let i = 0; i < 12; i++) slowed.recordSent(PLANT_SVC, 'Plant', false, now);
  assert.equal(slowed.getBreakerState(now + 1).active, true); // 普通降速生效
  assert.equal(slowed.checkRequest(PLANT_SVC, 'Harvest', now + 1).allowed, true); // 不阻自己收获
  slowed.setUrgentMode(true, now + 5_000);
  assert.equal(slowed.checkRequest(VISIT_SVC, 'Enter', now + 1).allowed, true); // 不阻好友急链
  slowed.setUrgentMode(false); slowed.setWatchMode(true, now + 60_000);
  assert.equal(slowed.checkRequest(VISIT_SVC, 'Enter', now + 1).allowed, true);
  assert.equal(slowed.checkRequest(PLANT_SVC, 'AllLands', now + 1).allowed, true);
});
