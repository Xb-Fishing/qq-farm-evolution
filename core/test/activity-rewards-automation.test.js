const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'); const path = require('node:path'); const os = require('node:os');
const prefix = path.resolve(os.tmpdir(), 'activity-rewards-fixture-');
assert.equal(path.dirname(prefix), fs.realpathSync(os.tmpdir()));
const data = fs.mkdtempSync(prefix); process.env.FARM_DATA_DIR = data;
const { loadProto, types } = require('../src/utils/proto');
before(loadProto); after(() => fs.rmSync(data, { recursive: true, force: true }));
let ordinal = 0;
function fixture() {
  process.env.FARM_ACCOUNT_ID = `synthetic-rewards-${++ordinal}`;
  const clock = { now: Date.parse('2026-10-20T10:00:00Z') };
  let enabled = true; let paused = false; let ready = true; let unknown = false;
  const socket = {};
  const view = { level: 1, slots: [], cashier_capacity_sec: 172800, cashier_elapsed_sec: 100,
    next_full_at: Math.floor(clock.now / 1000) + 172700, pending_rewards: [{ id: 1041, count: 10 }] };
  const share = { currentScore: 30, daily: { rewardClaimed: true, firstShareAwarded: true, claimedCount: 1, claimLimit: 1 }, milestones: [] };
  const requests = [];
  const serviceFile = require.resolve('../src/services/milk-tea-activity');
  const networkFile = require.resolve('../src/utils/network'); const saved = require.cache[networkFile];
  const network = { getWs: () => socket, sendMsgAsync: async (_service, method, bytes) => {
    assert.equal(method, 'Operate'); const req = types.MilkTeaOperateRequest.decode(bytes); const cmd = Number(req.operate_type); requests.push(cmd);
    if (cmd !== 55 && unknown) throw new Error('synthetic lost reply');
    const replies = {
      55: { milk_tea_get_shop: { shop: view } }, 59: { milk_tea_claim_cashier: { items: [{ id: 1041, count: 10 }] } },
      70: { share_reward_share: { granted_score: 5 } }, 74: { share_reward_claim_daily: { granted_score: 5 } },
      71: { share_reward_claim_milestones: { claimed_tier_ids: share.milestones.map(row => row.id) } },
    };
    return { body: types.MilkTeaOperateReply.encode({ activity_id: req.activity_id, operate_type: cmd, ...replies[cmd] }).finish() };
  } };
  require.cache[networkFile] = { exports: network }; delete require.cache[serviceFile];
  const service = require(serviceFile);
  const deps = { now: () => clock.now, enabled: () => enabled, isPaused: () => paused, isReady: () => ready, getConnection: () => socket,
    getActivityDiscoveryList: async () => [{ id: 2026110100, parentId: 0, enabled: true, startTime: 1792029600, endTime: 1794844799 }],
    getActivityGroupSnapshot: async () => ({ id: 2026110100, startTime: 1792029600, endTime: 1794844799,
      children: [{ id: 2026110101, details: { milkTea: { shopOpenAt: 1792029600 } } }, { id: 2026110104, details: { shareReward: share } }] }),
  };
  return { service, view, share, requests, deps, clock, setEnabled: value => { enabled = value; }, setPaused: value => { paused = value; },
    setReady: value => { ready = value; }, setUnknown: value => { unknown = value; },
    reload() { delete require.cache[serviceFile]; return require(serviceFile); },
    close() { if (saved) require.cache[networkFile] = saved; else delete require.cache[networkFile]; delete require.cache[serviceFile]; } };
}

test('cashier forecast, pending rewards and cup rate never substitute for a full fresh cashier', async () => {
  const f = fixture();
  try {
    f.view.next_full_at = Math.floor(f.clock.now / 1000) - 100; f.view.sec_per_cup = 0.1;
    await f.service.runAutomaticMilkTea(f.deps); assert.deepEqual(f.requests, [55]);
    f.clock.now += 16 * 60000; f.view.cashier_elapsed_sec = 172800;
    await f.service.runAutomaticMilkTea(f.deps); assert.equal(f.requests.filter(cmd => cmd === 59).length, 1);
    f.clock.now += 16 * 60000; await f.service.runAutomaticMilkTea(f.deps);
    assert.equal(f.requests.filter(cmd => cmd === 59).length, 1, 'the unchanged full state is not replayed');
  } finally { f.close(); }
});

test('unknown cashier outcome survives module/process-style reload until a fresh non-full state releases it', async () => {
  const f = fixture();
  try {
    f.view.cashier_elapsed_sec = 172800; f.setUnknown(true);
    await f.service.runAutomaticMilkTea(f.deps); assert.equal(f.requests.filter(cmd => cmd === 59).length, 1);
    const reloaded = f.reload(); f.clock.now += 16 * 60000; f.setUnknown(false);
    await reloaded.runAutomaticMilkTea(f.deps); assert.equal(f.requests.filter(cmd => cmd === 59).length, 1);
    f.view.cashier_elapsed_sec = 0; f.clock.now += 16 * 60000; await reloaded.runAutomaticMilkTea(f.deps);
    f.view.cashier_elapsed_sec = 172800; f.clock.now += 16 * 60000; await reloaded.runAutomaticMilkTea(f.deps);
    assert.equal(f.requests.filter(cmd => cmd === 59).length, 2);
  } finally { f.close(); }
});

test('a manual unknown reward attempt is also visible to the automatic runner after reload', async () => {
  const f = fixture();
  try {
    f.view.cashier_elapsed_sec = 172800; f.setUnknown(true);
    assert.equal((await f.service.runManualMilkTeaAction('claimCashier', {}, f.deps)).outcome, 'unknown');
    f.setUnknown(false); await f.reload().runAutomaticMilkTea(f.deps);
    assert.equal(f.requests.filter(cmd => cmd === 59).length, 1);
  } finally { f.close(); }
});

test('harvest becoming imminent during a read yields with no write and an ended activity has no past wake deadline', async () => {
  const f = fixture();
  try {
    let safe = true; const read = f.deps.getActivityGroupSnapshot;
    f.deps.canRun = () => safe; f.deps.getActivityGroupSnapshot = async (...args) => { safe = false; return read(...args); };
    await f.service.runAutomaticMilkTea(f.deps); assert.deepEqual(f.requests, []);
    f.clock.now = 1794844799 * 1000 + 86400000; safe = true; f.deps.getActivityGroupSnapshot = read;
    await f.service.runAutomaticMilkTea(f.deps);
    assert.ok(f.service.automaticMilkTeaWakeAt(f.clock.now) > f.clock.now + 60000);
  } finally { f.close(); }
});

test('automatic daily, first-share and milestone rewards are independent and use S4 commands once', async () => {
  const f = fixture();
  try {
    f.share.daily.rewardClaimed = false; f.share.daily.firstShareAwarded = false;
    f.share.milestones = [{ id: 1, state: 2, threshold: 30 }];
    await f.service.runAutomaticMilkTea(f.deps);
    assert.deepEqual(f.requests.filter(cmd => cmd !== 55), [74, 70, 71]);
    f.clock.now += 16 * 60000; await f.service.runAutomaticMilkTea(f.deps);
    assert.deepEqual(f.requests.filter(cmd => cmd !== 55), [74, 70, 71]);
  } finally { f.close(); }
});

test('disabled, manual/idle paused, not-ready and unlisted accounts perform zero reward writes', async () => {
  const f = fixture();
  try {
    f.share.daily.rewardClaimed = false;
    f.setEnabled(false); await f.service.runAutomaticMilkTea(f.deps); assert.equal(f.requests.length, 0);
    f.setEnabled(true); f.setPaused(true); await f.service.runAutomaticMilkTea(f.deps); assert.equal(f.requests.length, 0);
    f.setPaused(false); f.setReady(false); await f.service.runAutomaticMilkTea(f.deps); assert.equal(f.requests.length, 0);
    f.clock.now += 16 * 60000; f.setReady(true); f.deps.getActivityDiscoveryList = async () => [];
    await f.service.runAutomaticMilkTea(f.deps); assert.equal(f.requests.length, 0);
  } finally { f.close(); }
});

test('pause starting during a read stops the remaining requests; invalid cashier capacity never claims', async () => {
  const f = fixture();
  try {
    f.deps.getActivityGroupSnapshot = async () => { f.setPaused(true); return { id: 2026110100 }; };
    await f.service.runAutomaticMilkTea(f.deps); assert.equal(f.requests.length, 0);
    for (const capacity of [0, -1, Number.NaN, Infinity, undefined, 1.5]) assert.equal(f.service.cashierState({ cashier_capacity_sec: capacity, cashier_elapsed_sec: 172800 }, 1).full, false);
  } finally { f.close(); }
});

test('legacy endedEvidence-only milk capsule restores without altering its deadline', () => {
  const f = fixture();
  try {
    delete require.cache[require.resolve('../src/services/milk-tea-activity')];
    process.env.FARM_SESSION_BUSINESS = '1';
    require('../src/services/milk-tea-activity');
    const state = require('../src/services/business-state');
    const captured = state.snapshotBusinessState();
    captured.domains['services/milk-tea-activity.js'].value = { endedEvidence: { endTime: 1794844799, overview: null } };
    state.restoreBusinessState(captured);
    const result = state.snapshotBusinessState().domains['services/milk-tea-activity.js'].value;
    assert.equal(result.endedEvidence.endTime, 1794844799); assert.deepEqual(result.automaticState.claims, {});
  } finally { delete process.env.FARM_SESSION_BUSINESS; f.close(); }
});
