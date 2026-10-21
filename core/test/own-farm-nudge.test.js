const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { randomUUID } = require('node:crypto');
const { EventEmitter } = require('node:events');

const temporaryRoot = path.resolve(process.env.FARM_LOG_HISTORY_TEST_DIR || os.tmpdir());
const dataDir = path.resolve(temporaryRoot, `own-farm-nudge-${randomUUID()}`);
assert.ok(dataDir.startsWith(temporaryRoot + path.sep));
process.env.FARM_DATA_DIR = dataDir;
test.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

const utils = require('../src/utils/utils');
const analyzer = require('../src/services/farm-land-analyzer');
const { CONFIG, PlantPhase } = require('../src/config/config');
const protobuf = require('protobufjs');
const proto = new protobuf.Root().loadSync(path.join(__dirname, '../src/proto/plantpb.proto'), { keepCase: true });
const LandInfo = proto.lookupType('gamepb.plantpb.LandInfo');
const source = fs.readFileSync(path.join(__dirname, '../src/services/farming-orchestrator.js'), 'utf8');
const businessStateSource = fs.readFileSync(path.join(__dirname, '../src/services/business-state.js'), 'utf8');
const base = 1_800_000_000;

// Run the complete production module, real phase analyzer and wire decoder.
// Only external effects are replaced: no fixture can send a game request.
function fixture(snapshot) {
  let now = base;
  let lands = [];
  let harvestReply = { land: [] };
  const logs = [];
  const calls = [];
  const sandbox = vm.createContext({ module: { exports: {} }, Map, Set, Date, Promise,
    process: { env: { FARM_SESSION_BUSINESS: '1', FARM_ACCOUNT_ID: 'synthetic-own-farm' } } });
  vm.runInContext(businessStateSource, sandbox);
  const state = sandbox.module.exports;
  const prohibited = () => { throw new Error('Unexpected game write'); };
  const dependencies = {
    '../config/config': { CONFIG, PlantPhase },
    '../utils/network': { getUserState: () => ({}), isConnected: () => true, networkEvents: new EventEmitter() },
    '../utils/utils': { ...utils, getServerTimeSec: () => now, getServerTimeMs: () => now * 1000,
      log: (tag, msg, meta) => logs.push({ tag, msg, meta }),
      logWarn: (tag, msg, meta) => logs.push({ tag, msg, meta, level: 'warn' }), randomDelay: async () => {} },
    '../models/store': { isAutomationOn: () => false, getAutomation: () => ({}), getPrioritize2x2Crops: () => false },
    './stats': { recordOperation() {} },
    './daily-events': { recordEvent() {} },
    './scheduler': { createScheduler: () => ({ bindTimeoutTask() {}, clearAll() {} }) },
    './farm-api': { getAllLands: async () => ({ lands }), harvest: async ids => {
      calls.push([...ids]); if (harvestReply instanceof Error) throw harvestReply; return harvestReply;
    },
      farming: prohibited, unlockLand: prohibited, upgradeLand: prohibited },
    './farm-land-analyzer': analyzer,
    './farm-fertilizer': { runFertilizerByConfig: prohibited },
    './planting-service': { autoPlantEmptyLands: prohibited },
    './farm-scheduler': { startFertilizerBuyCheckTimer() {}, stopFertilizerBuyCheckTimer() {} },
    '../utils/behavior': { markOwnHarvestDueAt() {}, stealIsDue: () => false, stealIsImminent: () => false,
      ownHarvestIsDue: () => false, ownHarvestIsImminent: () => false, isIdleQuiet: () => false },
    './friend-activity': {},
    './business-state': state,
  };
  sandbox.module = { exports: {} };
  sandbox.require = name => {
    assert.ok(Object.hasOwn(dependencies, name), `Unexpected dependency ${name}`);
    return dependencies[name];
  };
  vm.runInContext(source, sandbox);
  const farm = sandbox.module.exports;
  farm.resetOwnNudgeBaselineForTests();
  if (snapshot) {
    // A real Worker deserializes into its own realm. Clone into the new VM likewise.
    sandbox.incoming = snapshot;
    const localSnapshot = vm.runInContext(`(function clone(value) {
      if (value instanceof Map) return new Map([...value].map(([key, item]) => [key, clone(item)]));
      if (Array.isArray(value)) return value.map(clone);
      if (value && typeof value === 'object') {
        const copy = {}; for (const [key, item] of Object.entries(value)) copy[key] = clone(item); return copy;
      }
      return value;
    })(incoming)`, sandbox);
    state.restoreBusinessState(localSnapshot);
  }
  return {
    farm, logs, calls, state,
    advance(seconds) { now += seconds; },
    async run(nextLands, op = 'upgrade', reply = { land: [] }) {
      lands = nextLands;
      harvestReply = reply;
      utils.syncServerTime(now * 1000);
      return farm.runFarmOperation(op);
    },
  };
}

function land(id, matureAt, options = {}) {
  const value = { id, unlocked: true, plant: { id: 1001, season: 1,
    phases: [{ phase: 2, phase_id: 2, begin_time: base - 100 }, { phase: 6, phase_id: 19, begin_time: matureAt }],
    left_inorc_fert_times: 3, ...options } };
  return LandInfo.decode(LandInfo.encode(LandInfo.fromObject(value)).finish());
}
function matureLand(id, matureAt, phase = 6) {
  // No own count field on the wire: protobuf correctly supplies the default 0.
  const value = { id, unlocked: true, plant: { id: 1001, season: 1,
    phases: [{ phase, phase_id: phase === 7 ? 0 : 19, begin_time: matureAt }] } };
  return LandInfo.decode(LandInfo.encode(LandInfo.fromObject(value)).finish());
}
const nudgeLogs = f => f.logs.filter(row => row.meta?.event === '催熟');

test('natural maturity and wire-default fertilizer count do not report acceleration', async () => {
  const f = fixture();
  await f.run([land(1, base + 4500), land(2, base + 9000)]);
  f.advance(4500);
  const mature = matureLand(1, base + 4500);
  assert.equal(Object.hasOwn(mature.plant, 'left_inorc_fert_times'), false);
  assert.equal(utils.toNum(mature.plant.left_inorc_fert_times), 0);
  await f.run([mature, land(2, base + 9000)]);
  assert.deepEqual(nudgeLogs(f), [], 'the other land being 75 minutes away does not prove fertilizer use');
});

test('harvested dead plants reset their baseline without a fertilizer report', async () => {
  const f = fixture();
  await f.run([land(1, base + 4500), land(2, base + 9000)]);
  f.advance(4500);
  await f.run([matureLand(1, base + 4500, 7), land(2, base + 9000)]);
  assert.deepEqual(nudgeLogs(f), []);
});

test('empty full snapshot ends the old baseline before same-species planting', async () => {
  const f = fixture();
  await f.run([land(1, base + 9000)]);
  await f.run([{ id: 1, unlocked: true }]);
  await f.run([land(1, base + 9000, { left_inorc_fert_times: 2, is_nudged: true })]);
  assert.deepEqual(nudgeLogs(f), []);
});

test('same species in a new season cannot inherit fertilizer evidence', async () => {
  const f = fixture();
  await f.run([land(1, base + 9000)]);
  await f.run([land(1, base + 8000, { season: 2, left_inorc_fert_times: 2, is_nudged: true })]);
  assert.deepEqual(nudgeLogs(f), []);
});

test('same-species replant with a later maturity resets counters and flags', async () => {
  const f = fixture();
  await f.run([land(1, base + 9000)]);
  await f.run([land(1, base + 10000, { left_inorc_fert_times: 2, is_nudged: true })]);
  assert.deepEqual(nudgeLogs(f), []);
});

test('returning to earlier growth stages rebuilds the baseline even with an earlier deadline', async () => {
  const f = fixture();
  await f.run([land(1, base + 9000)]);
  await f.run([land(1, base + 8000, { left_inorc_fert_times: 2, phases: [
    { phase: 1, begin_time: base }, { phase: 2, begin_time: base + 100 },
    { phase: 6, phase_id: 19, begin_time: base + 8000 },
  ] })]);
  assert.deepEqual(nudgeLogs(f), []);
});

test('natural phase suffix trimming and elapsed time preserve the absolute maturity', async () => {
  const f = fixture();
  const phases = [{ phase: 2, begin_time: base - 100 }, { phase: 2, begin_time: base + 100 }, { phase: 6, phase_id: 19, begin_time: base + 9000 }];
  await f.run([land(1, base + 9000, { phases })]);
  f.advance(100);
  await f.run([land(1, base + 9000, { phases: phases.slice(1) })]);
  assert.deepEqual(nudgeLogs(f), []);
  assert.equal(f.farm.getNextMatureDueAtMs() > 0, true);
});

test('genuine earlier maturity and wire-default zero while still growing are detected once', async () => {
  const f = fixture();
  await f.run([land(1, base + 9000)]);
  const accelerated = land(1, base + 8000, { left_inorc_fert_times: undefined });
  assert.equal(Object.hasOwn(accelerated.plant, 'left_inorc_fert_times'), false);
  await f.run([accelerated]);
  await f.run([accelerated]);
  assert.equal(nudgeLogs(f).length, 1);
  assert.ok(Array.isArray(nudgeLogs(f)[0].meta.landIds));
  assert.ok(Array.isArray(nudgeLogs(f)[0].meta.reasons));
  assert.deepEqual(Array.from(nudgeLogs(f)[0].meta.landIds), [1]);
  assert.deepEqual(Array.from(nudgeLogs(f)[0].meta.reasons), ['fertilizer_count_decreased', 'mature_time_advanced']);
});

test('a fresh nudge flag during continuous growth remains visible and is deduplicated', async () => {
  const f = fixture();
  await f.run([land(1, base + 9000)]);
  await f.run([land(1, base + 9000, { is_nudged: true })]);
  await f.run([land(1, base + 9000, { is_nudged: true })]);
  assert.equal(nudgeLogs(f).length, 1);
});

test('true instant acceleration is detected when the previous maturity was still in the future', async () => {
  const f = fixture();
  await f.run([land(1, base + 9000)]);
  await f.run([matureLand(1, base)]);
  assert.equal(nudgeLogs(f).length, 1);
  assert.match(nudgeLogs(f)[0].msg, /作物已成熟/);
});

test('successful own harvest clears the old baseline before any same-species replant', async () => {
  const f = fixture();
  await f.run([land(1, base + 100)]);
  f.advance(100);
  await f.run([matureLand(1, base + 100)], 'harvest');
  assert.equal(f.calls.length, 1);
  assert.equal(f.state.snapshotBusinessState().domains['services/farming-orchestrator.js'].value.ownNudgeLandSnapshots.has(1), false);
  assert.deepEqual(nudgeLogs(f), []);
  f.logs.length = 0;
  // Simulate the old deadline moving backwards relative to a new same-species crop.
  await f.run([land(1, base + 110, { left_inorc_fert_times: 1, is_nudged: true })]);
  assert.deepEqual(nudgeLogs(f), []);
});

test('a failed harvest keeps the observed baseline and does not replay the write', async () => {
  const f = fixture();
  await f.run([land(1, base + 100)]);
  f.advance(100);
  await f.run([matureLand(1, base + 100)], 'harvest', new Error('Synthetic harvest failure'));
  assert.equal(f.calls.length, 1);
  assert.equal(f.state.snapshotBusinessState().domains['services/farming-orchestrator.js'].value.ownNudgeLandSnapshots.has(1), true);
  assert.deepEqual(nudgeLogs(f), []);
});

test('warm business state preserves comparable snapshots without duplicate reports', async () => {
  const before = fixture();
  await before.run([land(1, base + 9000)]);
  await before.run([land(1, base + 8000, { left_inorc_fert_times: 2 })]);
  const after = fixture(before.state.snapshotBusinessState());
  await after.run([land(1, base + 8000, { left_inorc_fert_times: 2 })]);
  assert.deepEqual(nudgeLogs(after), []);
  await after.run([land(1, base + 7000, { left_inorc_fert_times: 1 })]);
  assert.equal(nudgeLogs(after).length, 1);
});

test('legacy warm snapshots only prime the new lifecycle-aware baseline', async () => {
  const before = fixture();
  const snapshot = before.state.snapshotBusinessState();
  snapshot.domains['services/farming-orchestrator.js'].value.ownNudgeLandSnapshots.set(1,
    { plantId: 1001, matureAtSec: base + 9000, fertLeft: 3, nudged: false });
  const after = fixture(snapshot);
  await after.run([land(1, base + 8000, { left_inorc_fert_times: 2 })]);
  assert.deepEqual(nudgeLogs(after), []);
  await after.run([land(1, base + 7000, { left_inorc_fert_times: 1 })]);
  assert.equal(nudgeLogs(after).length, 1);
});
