'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { fixture: baseFixture } = require('./milk-tea-autonomy-baseline.test');
const config = require('../src/gameConfig/MilkTeaActivity.json');
const READS = new Set([55, 56, 58, 63]);
async function fixture(flags = {}) {
  const f = await baseFixture(flags);
  f.summary.level = 11;
  f.shop = { level: 11, cashier_capacity_sec: 172800, cashier_elapsed_sec: 0, slots: [], drink_cups: { 2: 1000 }, boost_cups_per_use: 10, is_settling: false };
  f.workshop = { recipes: config.recipes.map(row => ({ recipe_id: row.recipeId, unlocked: true, stock_cups: 1000 })) };
  f.candidates = { duration_id: 1, wage_total: 40, min_remain_biz_sec: 14400,
    friends: [{ friend: { gid: '9101' }, state: 1 }, { friend: { gid: '9102' } }], robots: [{ friend: { gid: '9201' } }] };
  f.fund = { unlocked: false, automaticClaimDataComplete: true, tiers: [{ tierId: 1, state: 2, conditions: [{ reached: true }] }] };
  f.share = { currentScore: 20, daily: { rewardClaimed: false, firstShareAwarded: false }, milestones: [{ id: 1, state: 2, threshold: 10 }] };
  const readGroup = f.deps.getActivityGroupSnapshot;
  f.deps.getActivityGroupSnapshot = async () => {
    const snapshot = await readGroup();
    snapshot.children.push({ id: 2026110103, details: { growthFund: f.fund } }, { id: 2026110104, details: { shareReward: f.share } });
    return snapshot;
  };
  let override;
  f.respond = fn => { override = fn; };
  f.response((cmd, reply) => {
    const req = f.requests.at(-1);
    const now = Math.floor(f.clock.now / 1000);
    const crafted = {};
    if (cmd === 62) for (const uid of req.milk_tea_craft.fruit_uids.map(String)) {
      const fruit = f.bag.find(row => String(row.uid) === uid);
      const id = config.recipes.find(row => row.fruitItemId === fruit?.id)?.recipeId;
      if (id) crafted[id] = (crafted[id] || 0) + Number(fruit.count);
    }
    const results = cmd !== 57 ? [] : req.milk_tea_hire.hires.map(row => ({ ...row, success: true, slot: {
      slot_index: row.slot_index, employee: { gid: row.target_gid }, shift_id: 10000 + f.requests.length,
      begin_at: now, end_at: now + (config.hireDurations.find(d => d.durationId === Number(row.duration_id))?.durationSec || 14400),
      cost: config.hireDurations.find(d => d.durationId === Number(row.duration_id))?.cost.count || 40,
    } }));
    const bodies = {
      55: { milk_tea_get_shop: { shop: f.shop } }, 56: { milk_tea_get_hire_list: f.candidates }, 58: { milk_tea_get_workshop: f.workshop },
      57: { milk_tea_hire: { results } }, 62: { milk_tea_craft: { crafted_cups: crafted } },
      53: { milk_tea_create_shop: { opening_gift: [{ id: 1041, count: 10 }] } },
      59: { milk_tea_claim_cashier: { items: [{ id: 1041, count: 10 }] } }, 60: { milk_tea_boost: { cups: 10 } },
      74: { share_reward_claim_daily: { granted_score: 5 } }, 70: { share_reward_share: { granted_score: 5 } },
      71: { share_reward_claim_milestones: { claimed_tier_ids: [1] } },
      76: { growth_fund_claim: { claimed_tier_ids: f.fund.tiers.filter(row => row.state === 2).map(row => row.tierId) } },
    };
    const next = { ...reply, ...bodies[cmd] };
    return override ? override(cmd, next, req) || next : next;
  });
  const warehouse = require('../src/services/warehouse');
  Object.assign(f.deps, { getBag: warehouse.getBag, getBagItems: warehouse.getBagItems });
  f.writes = () => f.requests.map(row => Number(row.operate_type)).filter(cmd => !READS.has(cmd));
  f.journalData = () => JSON.parse(fs.readFileSync(f.journal(), 'utf8'));
  f.at = milliseconds => { f.clock.now += milliseconds; return f.service.runAutomaticMilkTea(f.deps); };
  return f;
}
module.exports = { fixture };

if (require.main === module) {
  for (const [mode, target] of [
    ['automatic', (BigInt(Number.MAX_SAFE_INTEGER) + 2n).toString()],
    ['manual', (BigInt(Number.MAX_SAFE_INTEGER) + 2n).toString()],
    ['automatic-max-int64', (2n ** 63n - 1n).toString()],
  ]) test(`hire ${mode} encodes only the exact supplied synthetic int64 candidate and confirms its own journal`, async () => {
    const automatic = mode !== 'manual'; const f = await fixture({ milk_tea_auto_hire: automatic });
    try {
      f.candidates.friends = [{ friend: { gid: target } }]; f.candidates.robots = [];
      const result = automatic ? (await f.service.runAutomaticMilkTea(f.deps))[0]
        : await f.service.runManualMilkTeaAction('hire', { durationId: 1, hires: [{ slotIndex: 0, targetGid: target }], confirmedCosts: [{ itemId: 1041, count: '40' }] }, f.deps);
      const request = f.requests.find(row => Number(row.operate_type) === 57);
      assert.equal(String(request.milk_tea_hire.hires[0].target_gid), target, 'int64 candidate may never round into an unlisted target');
      assert.deepEqual(f.writes(), [57]); assert.equal(result.ok, true);
      assert.equal(f.journalData().actionState.hires[`0:${target}`].status, 'confirmed');
      assert.equal(f.journalData().actionState.hireSpend['2026-10-29']['1041'], '40');
    } finally { f.close(); }
  });
  test('harvest dirty wake supersedes persisted fallback only at 60s and repeated events merge without postponing', async () => {
    const f = await fixture({ milk_tea_auto_craft: true });
    try {
      await f.service.runAutomaticMilkTea(f.deps); const fallback = f.journalData().actionState.schedule.nextAt;
      f.bag.push({ id: 40525, uid: '4000', count: '5' }); f.clock.now += 1000;
      f.service.markMilkTeaMaterialsDirty(f.clock.now); const due = f.service.automaticMilkTeaWakeAt(f.clock.now);
      assert.equal(due, f.clock.now + 60000); assert.ok(due < fallback);
      f.clock.now += 10000; f.service.markMilkTeaMaterialsDirty(f.clock.now);
      assert.equal(f.service.automaticMilkTeaWakeAt(f.clock.now), due);
      const before = f.calls.length; await f.at(49000); assert.equal(f.calls.length, before, 'no read or craft before dirty deadline');
      await f.at(1000); assert.deepEqual(f.writes(), [62], 'due material event must not be masked by the old persisted fallback');
    } finally { f.close(); }
  });
  test('only autoHire selects first eligible after busy friend, one free slot and independent 40-ticket budget', async () => {
    const f = await fixture({ milk_tea_auto_hire: true });
    try {
      await f.service.runAutomaticMilkTea(f.deps);
      assert.deepEqual(f.writes(), [57]);
      const input = f.requests.find(row => Number(row.operate_type) === 57).milk_tea_hire.hires;
      assert.equal(input.length, 1); assert.equal(Number(input[0].slot_index), 0); assert.equal(String(input[0].target_gid), '9102');
      const state = f.journalData().actionState;
      assert.equal(state.hireSpend['2026-10-29']['1041'], '40'); assert.deepEqual(state.spend, {});
      assert.equal(f.deps.getAutomation().milk_tea_seed_policy.ticketDailyLimit, '0');
    } finally { f.close(); }
  });
  for (const reason of ['full', 'budget', 'reserve']) test(`hire ${reason} makes zero candidate queries and zero writes`, async () => {
    const f = await fixture({ milk_tea_auto_hire: true });
    try {
      if (reason === 'full') f.shop.slots = [0, 1].map(slot_index => ({ slot_index, shift_id: 100 + slot_index, end_at: f.clock.now / 1000 + 3600 }));
      else f.setFlags({ milk_tea_hire_policy: { durationId: 1, ticketDailyLimit: reason === 'budget' ? '0' : '480', ticketReserve: reason === 'reserve' ? '16000' : '8000' } });
      await f.service.runAutomaticMilkTea(f.deps);
      assert.equal(f.requests.some(row => Number(row.operate_type) === 56), false); assert.deepEqual(f.writes(), []);
    } finally { f.close(); }
  });
  test('unknown hire survives reload/day/policy, then exact new shift reconciles once and expires only with fresh ended shift', async () => {
    const f = await fixture({ milk_tea_auto_hire: true });
    try {
      f.shop.level = 1; f.unknown(57); await f.service.runAutomaticMilkTea(f.deps);
      assert.deepEqual(f.writes(), [57]); const record = Object.values(f.journalData().actionState.hires)[0];
      await assert.rejects(f.service.runManualMilkTeaAction('hire', { durationId: 1, hires: [{ slotIndex: 0, targetGid: '9201' }], confirmedCosts: [{ itemId: 1041, count: '40' }] }, f.deps), { code: 'SEASON_WISH_MILK_TEA_LIMIT' });
      assert.deepEqual(f.writes(), [57], 'manual cannot replace an unknown automatic slot intent');
      f.reload(); f.setFlags({ milk_tea_hire_policy: { durationId: 2, ticketDailyLimit: '480', ticketReserve: '8000' } });
      await f.at(86400000); assert.deepEqual(f.writes(), [57]);
      f.shop.slots = [{ slot_index: 0, employee: { gid: '9102' }, shift_id: '7009', cost: 40, begin_at: record.at / 1000, end_at: record.at / 1000 + 14400 }];
      f.unknown(0); await f.at(16 * 60000);
      assert.equal(f.service.actionStateSummary().pendingHires, 0);
      assert.equal(f.journalData().actionState.hireSpend['2026-10-30']['1041'], '40');
      await f.at(16 * 60000); assert.equal(f.journalData().actionState.hireSpend['2026-10-30']['1041'], '40');
      assert.deepEqual(f.writes(), [57], 'expired first shift does not authorize a changed duration with stale candidate fee');
    } finally { f.close(); }
  });
  test('proved completed shift may disappear from sparse slots and permit the next legitimate hire', async () => {
    const f = await fixture({ milk_tea_auto_hire: true }); let slot;
    try {
      f.shop.level = 1; f.respond((cmd, reply) => { if (cmd === 57) slot = reply.milk_tea_hire.results[0].slot; return reply; });
      await f.service.runAutomaticMilkTea(f.deps);
      const confirmed = Object.values(f.journalData().actionState.hires)[0];
      assert.equal(confirmed.status, 'confirmed'); assert.ok(confirmed.endAt > f.clock.now / 1000, 'exact success slot proof is durable immediately');
      f.shop.slots = []; await f.at(3600000); assert.deepEqual(f.writes(), [57], 'a fresh empty list before the proved end cannot retire the claim');
      await f.at(4 * 3600000); assert.deepEqual(f.writes(), [57, 57]); assert.equal(f.journalData().actionState.hireSpend[f.service.beijingDayOf(f.clock.now)]['1041'], '80');
    } finally { f.close(); }
  });
  test('normal page shop read reconciles an unknown hire; absurd or wrong-duration slot proof does not', async () => {
    const f = await fixture({ milk_tea_auto_hire: true });
    try {
      f.shop.level = 1; f.unknown(57); await f.service.runAutomaticMilkTea(f.deps);
      const row = Object.values(f.journalData().actionState.hires)[0]; f.unknown(0);
      f.shop.slots = [{ slot_index: 0, employee: { gid: '9102' }, shift_id: '7009', cost: 40, begin_at: row.at / 1000, end_at: row.at / 1000 + 43200 }];
      await f.service.queryMilkTeaActivity('shop', {}, f.deps); assert.equal(f.service.actionStateSummary().pendingHires, 1);
      f.shop.slots[0].end_at = row.at / 1000 + 14400;
      await f.service.queryMilkTeaActivity('shop', {}, f.deps); assert.equal(f.service.actionStateSummary().pendingHires, 0);
      assert.deepEqual(f.writes(), [57]); assert.equal(f.journalData().actionState.hireSpend['2026-10-29']['1041'], '40');
    } finally { f.close(); }
  });
  for (const change of ['settings', 'epoch', 'day', 'minimum', 'fee', 'candidate']) test(`hire ${change} changing during fresh validation sends no hire`, async () => {
    const f = await fixture({ milk_tea_auto_hire: true });
    try {
      if (change === 'settings') f.hook(stage => { if (stage === 'bag') f.setFlags({ milk_tea_auto_hire: false }); });
      if (change === 'epoch') {
        let connection = f.deps.getConnection(); f.deps.getConnection = () => connection;
        f.hook(stage => { if (stage === 'bag') connection = {}; });
      }
      if (change === 'day') f.hook(stage => { if (stage === 'bag') f.clock.now += 86400000; });
      if (change === 'minimum') f.candidates.min_remain_biz_sec = 99999999;
      if (change === 'fee') f.candidates.wage_total = 41;
      if (change === 'candidate') f.candidates.friends.concat(f.candidates.robots).forEach(row => { row.state = 1; });
      await f.service.runAutomaticMilkTea(f.deps); assert.deepEqual(f.writes(), []);
    } finally { f.close(); }
  });
  test('all families share three-write cap, persistent fair cursor, two followups and bounded shared initial reads', async () => {
    const f = await fixture({ milk_tea_auto_rewards: true, milk_tea_auto_seeds: true, milk_tea_auto_work: true, milk_tea_auto_upgrade: true,
      milk_tea_auto_craft: true, milk_tea_auto_hire: true, milk_tea_auto_boost: true });
    try {
      f.bag.push({ id: 40525, uid: '3001', count: '10' }, { id: 1042, uid: '3002', count: '5' });
      f.fund.unlocked = true; f.shop.cashier_elapsed_sec = 172800; f.shop.pending_rewards = [{ id: 1041, count: 10 }];
      const rounds = [];
      for (let round = 0; round < 3; round++) {
        const start = f.writes().length; const listStart = f.calls.filter(x => x === 'List').length;
        const groupStart = f.calls.filter(x => x === 'Group').length;
        await f.service.runAutomaticMilkTea(f.deps);
        const writes = f.writes().slice(start); rounds.push(writes);
        assert.ok(writes.length <= 3, JSON.stringify(rounds));
        assert.equal(f.calls.filter(x => x === 'List').length - listStart, 1 + writes.length);
        assert.equal(f.calls.filter(x => x === 'Group').length - groupStart, 1 + writes.length);
        if (round === 0) { f.shop.cashier_elapsed_sec = 0; f.shop.pending_rewards = []; }
        f.clock.now += 60000; if (round === 1) f.reload();
      }
      assert.deepEqual(rounds[0], [59, 1, 62]); assert.ok(rounds[1].includes(57)); assert.ok(rounds[1].includes(64)); assert.ok(rounds[1].includes(61));
      assert.ok(rounds[2].includes(74)); assert.ok(rounds[2].includes(76)); assert.ok(rounds[2].includes(60));
      const before = f.calls.length; await f.service.runAutomaticMilkTea(f.deps); assert.equal(f.calls.length, before, 'no perpetual one-minute success poller');
      assert.equal(f.journalData().actionState.schedule.followupsLeft, 0);
    } finally { f.close(); }
  });
  test('open is an optional free prerequisite, preserves existing names and unknown remains claimed', async () => {
    const f = await fixture({ milk_tea_auto_open: true });
    try {
      Object.assign(f.summary, { shopOpenAt: 0, shopName: '', level: 1 });
      f.unknown(53); await f.service.runAutomaticMilkTea(f.deps); f.unknown(0); f.reload(); await f.tick();
      assert.deepEqual(f.writes(), [53]); f.summary.shopOpenAt = f.clock.now / 1000; f.summary.shopName = '示例小店';
      await f.tick(); assert.deepEqual(f.writes(), [53]); assert.equal(f.requests.some(row => Number(row.operate_type) === 54), false);
    } finally { f.close(); }
  });
  test('fund uses only complete unlocked claimable tiers, shared unknown survives reload/day without paid unlock', async () => {
    const f = await fixture({ milk_tea_auto_rewards: true });
    try {
      f.share.daily.rewardClaimed = true; f.share.daily.firstShareAwarded = true; f.share.milestones = [];
      await f.service.runAutomaticMilkTea(f.deps); assert.deepEqual(f.writes(), []);
      f.fund.unlocked = true; f.fund.automaticClaimDataComplete = false; await f.tick(); assert.deepEqual(f.writes(), []);
      f.fund.automaticClaimDataComplete = true; f.unknown(76);
      const manual = await f.service.runManualMilkTeaAction('fundClaim', {}, f.deps); assert.equal(manual.outcome, 'unknown');
      await f.tick(); assert.deepEqual(f.writes(), [76], 'automatic fund collection shares the unknown manual tier claim');
      f.reload(); f.unknown(0); await f.at(86400000); assert.deepEqual(f.writes(), [76]);
      assert.equal(f.requests.some(row => Number(row.operate_type) === 75), false);
    } finally { f.close(); }
  });
  test('horn policy uses only useful existing stock, unknown survives reload and full/unknown/settling never spend', async () => {
    const f = await fixture({ milk_tea_auto_boost: true });
    try {
      f.bag.push({ id: 1042, uid: '3002', count: '5' }); f.shop.drink_cups = { 2: 10 };
      f.unknown(60); await f.service.runAutomaticMilkTea(f.deps);
      assert.deepEqual(f.writes(), [60]); assert.equal(Number(f.requests.find(row => Number(row.operate_type) === 60).milk_tea_boost.count), 1);
      await assert.rejects(f.service.runManualMilkTeaAction('boost', { count: 1, confirmedCosts: [{ itemId: 1042, count: '1' }] }, f.deps), { code: 'SEASON_WISH_MILK_TEA_LIMIT' });
      f.reload(); f.unknown(0); await f.at(86400000); assert.deepEqual(f.writes(), [60]);
      assert.equal(f.requests.some(row => Number(row.operate_type) === 1), false, 'never buy horns');
      f.bag.find(row => row.id === 1042).count = '4'; f.shop.is_settling = true; await f.tick(); assert.deepEqual(f.writes(), [60]);
      f.shop.is_settling = false; f.shop.cashier_elapsed_sec = 172800; await f.tick(); assert.deepEqual(f.writes(), [60]);
      f.shop.cashier_elapsed_sec = 0; f.shop.boost_cups_per_use = 0; await f.tick(); assert.deepEqual(f.writes(), [60]);
    } finally { f.close(); }
  });
  test('legacy confirmed wages migrate to a proven later slip, same or unknown slip cannot reopen', async () => {
    const f = await fixture({ milk_tea_auto_work: true });
    try {
      f.work.my_shift = null; f.work.slips = [{ shift_id: '8001', end_at: f.clock.now / 1000 - 1 }];
      await f.service.runAutomaticMilkTea(f.deps);
      const old = f.journalData(); delete old.actionState.wages.slips; fs.writeFileSync(f.journal(), JSON.stringify(old)); f.reload();
      await f.tick(); assert.deepEqual(f.writes(), [64]);
      f.work.slips = [{ shift_id: '8002', end_at: f.clock.now / 1000 }]; await f.tick(); assert.deepEqual(f.writes(), [64, 64]);
      await f.tick(); assert.deepEqual(f.writes(), [64, 64]);
      f.summary.hasUnclaimedWage = false; f.summary.hasUnclaimedWageKnown = true; await f.tick();
      f.summary.hasUnclaimedWage = true; f.unknown(64); await f.tick(); f.reload();
      f.work.slips = [{ shift_id: '8003', end_at: f.clock.now / 1000 }]; await f.tick(); assert.deepEqual(f.writes(), [64, 64, 64]);
    } finally { f.close(); }
  });
}
