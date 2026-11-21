'use strict';

const model = require('./ranch-model');

const GRASS = '7001';
const TICKETS = '1007';
// Beyond this window, ordinary harvesting, spending or feeding can explain the same net change.
const OBSERVATION_WINDOW_MS = 120000;
const RECHECK_INTERVAL_MS = 15000;

function grassPurchase(plan) {
  return plan.action === 'buy' && plan.payload.goods_id === '10001' && String(plan.marker) === '6'
    && plan.expectedRewards.length === 1 && plan.expectedRewards[0].id === GRASS
    && plan.costItems.length === 1 && plan.costItems[0].id === TICKETS;
}

function machine(raw, id) {
  const rows = raw?.cells?.facilities?.filter(row => String(row.instance_id) === id && row.module_type === 8);
  if (rows?.length !== 1) return null;
  const row = rows[0];
  const count = row.feed_machine?.feed_count;
  if (!Number.isSafeInteger(count) || count < 0 || !Number.isSafeInteger(row.capacity) || count > row.capacity
    || row.capacity <= 0 || (count === 0 && !(row.feed_machine?.status > 0))) return null;
  return { count, capacity: row.capacity, facilityId: String(row.facility_id), consuming: row.feed_machine.consume_rate > 0 };
}

function capture(plan, raw, at) {
  if (plan.action !== 'addGrass' && !grassPurchase(plan)) return null;
  const proof = { at, grass: model.balance(raw.bag, GRASS).total };
  if (grassPurchase(plan)) return { ...proof, tickets: model.balance(raw.bag, TICKETS).total };
  const feeder = machine(raw, plan.payload.instance_id);
  return feeder ? { ...proof, machine: feeder } : null;
}

function receiptEvidence(plan, reply) {
  if (!reply) return { response: false };
  if (plan.action === 'addGrass') {
    const rows = reply.consumed || [];
    return { response: true, conflicting: rows.some(row => String(row.id) !== GRASS && String(row.count) !== '0'),
      consumed: rows.filter(row => String(row.id) === GRASS).reduce((sum, row) => sum + BigInt(row.count), 0n).toString(),
      machine: Number.isInteger(reply.detail?.feed_count) ? reply.detail.feed_count : null };
  }
  function contradicts(rows, expectedId, expectedCount) {
    const positive = (rows || []).filter(row => BigInt(row.count) !== 0n);
    if (!positive.length) return false;
    return positive.some(row => String(row.id) !== expectedId || BigInt(row.count) < 0n)
      || positive.reduce((sum, row) => sum + BigInt(row.count), 0n) !== BigInt(expectedCount);
  }
  const conflicting = (reply.goods && String(reply.goods.id) !== plan.payload.goods_id)
    || contradicts(reply.get_items, GRASS, plan.expectedRewards[0].count)
    || contradicts(reply.cost_items, TICKETS, plan.costItems[0].count);
  return { response: true, conflicting: Boolean(conflicting) };
}

function compare(plan, proof, receipt, after, at) {
  const purchase = plan.action === 'buy';
  const expected = purchase ? plan.expectedRewards[0].count : String(plan.count);
  const report = { action: plan.action, expectedGrass: expected, observedGrass: null,
    ...(purchase ? { expectedTickets: plan.costItems[0].count, observedTickets: null }
      : { expectedMachine: expected, observedMachine: null, receiptMachine: receipt?.machine ?? null,
        receiptConsumed: receipt?.response ? receipt.consumed : null }) };
  let matches = false;
  if (after?.bag) {
    try {
      report.bagNow = model.balance(after.bag, GRASS).total;
      if (purchase) report.observedTickets = (BigInt(proof.tickets) - BigInt(model.balance(after.bag, TICKETS).total)).toString();
    } catch { report.bagNow = null; report.observedTickets = null; }
  }
  if (report.bagNow != null) {
    const change = BigInt(report.bagNow) - BigInt(proof.grass);
    report.observedGrass = (purchase ? change : -change).toString();
    if (purchase) {
      matches = report.observedTickets === report.expectedTickets;
    } else {
      const fresh = machine(after, plan.payload.instance_id);
      if (fresh && fresh.facilityId === proof.machine.facilityId && fresh.capacity === proof.machine.capacity) {
        report.machineNow = fresh.count;
        report.observedMachine = String(fresh.count - proof.machine.count);
        const expectedAfter = proof.machine.count + plan.count;
        const machineReceipt = receipt?.machine;
        // An immediate machine receipt can prove the deposit even when animals consume grass before the refresh.
        matches = report.observedMachine === expected || (machineReceipt === expectedAfter && fresh.count <= expectedAfter)
          || (receipt?.consumed === expected && machineReceipt == null && fresh.consuming && fresh.count > proof.machine.count && fresh.count <= expectedAfter);
      }
    }
    matches = matches && report.observedGrass === expected && !receipt?.conflicting
      && at >= proof.at && at - proof.at <= OBSERVATION_WINDOW_MS;
  }
  const value = n => n == null ? '未读到' : n;
  const message = purchase
    ? `牧草预计入包 ${expected}，实际 ${value(report.observedGrass)}；金券预计扣除 ${report.expectedTickets}，实际 ${value(report.observedTickets)}`
    : `背包牧草预计扣除 ${expected}，实际 ${value(report.observedGrass)}；牧草机预计增加 ${expected}，实际净增 ${value(report.observedMachine)}`;
  return { matches, report, message };
}

// Older ledgers retained the machine reading and the decoded rejection reason, but not the pre-write bag.
function legacyFeed(quote, gid) {
  const plan = quote?.plan;
  const marker = plan?.marker;
  return quote?.action === 'addGrass' && ['unknown', 'pending'].includes(quote.status) && !quote.feedBefore
    && String(quote.origin).split(':')[0] === String(gid)
    && marker && marker.facilityId === plan?.payload?.instance_id && Number.isSafeInteger(marker.occupied)
    && marker.occupied >= 0 && Number.isSafeInteger(marker.capacity) && marker.occupied + plan.count <= marker.capacity;
}

function observeLegacy(quote, raw, at) {
  const { plan } = quote;
  const current = machine(raw, plan.payload.instance_id);
  if (!current || current.capacity !== plan.marker.capacity) return null;
  const bag = model.balance(raw.bag, GRASS).total;
  const report = { legacy: true, expectedGrass: String(plan.count), observedGrass: null, bagNow: bag,
    expectedMachine: String(plan.count), observedMachine: String(current.count - plan.marker.occupied), machineNow: current.count };
  const previous = quote.legacyObservation;
  const independent = previous && at - previous.at >= RECHECK_INTERVAL_MS && previous.bag === bag
    && current.count <= previous.machine && previous.capacity === current.capacity;
  // Both samples must show that the old command is no longer applicable. Its historical debit remains unknown.
  const target = plan.marker.occupied + plan.count;
  const finalReply = quote.result?.message === '补草扣除回执未匹配，请核对牧草数量'
    || quote.result?.reconciliation?.finalReply === true;
  report.finalReply = finalReply;
  const superseded = independent && ((finalReply && bag === '0') || current.count >= target);
  const text = `原单预计使用牧草 ${plan.count}，旧记录未保存扣前库存。现有背包 ${bag}，牧草机 ${plan.marker.occupied} → ${current.count}。`;
  return { outcome: superseded ? 'replanned' : 'unknown', completed: 0, costs: [], rewards: [], reconciliation: report,
    message: text + (superseded ? '两次刷新确认原指令已不适用，保留原用量待查，按当前余粮重新规划。' : '正在只读核账，原单不会重发。'),
    observation: { at, bag, machine: current.count, capacity: current.capacity } };
}

module.exports = { capture, receiptEvidence, compare, legacyFeed, observeLegacy, OBSERVATION_WINDOW_MS, RECHECK_INTERVAL_MS };
