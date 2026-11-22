'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const helper = require('../src/services/ranch-task-cans');
const codec = require('../src/services/ranch-codec');

const now = 1795300000000;
const ranchId = '9007199254740993';
const animalId = 3;

function item(id, count, fields = {}) {
  return { id, count: String(count), ...fields };
}

function state({ ordinary = 0, organic = 0, items = [], money = 10, animal = {} } = {}) {
  return {
    bag: {
      global_scene_id: 2,
      physical_items: items,
      virtual_items: [item('7003', ordinary), item('7004', organic), item('1007', money)],
    },
    cells: { facilities: [{ instance_id: ranchId, ranch: { ranch_inst_id: ranchId, animals: [
      { ranch_inst_id: ranchId, animal_inst_id: animalId, stage: 2, can_feed: true, limited_can_used: false,
        grow_ready_at_ms: String(now + 299500), ...animal },
    ] } }] },
  };
}

function roundTrip(type, body) {
  return codec.decode(type, codec.encode(type, body));
}

test('can planner uses the current phase deadline and prefers a funded ordinary bucket', () => {
  const before = state({ ordinary: 300, organic: 500, items: [item('80021', 1, { uid: '21' })] });
  const { plan } = helper.planStep(before, now);
  assert.equal(plan.action, 'feedCan');
  assert.equal(plan.costItems[0].count, '300');
  assert.deepEqual(plan.payload, { targets: [{ ranch_inst_id: ranchId, animal_inst_id: animalId }], bucket_type: 2 });
  assert.deepEqual(roundTrip(codec.ROUTES.feedCan.request, plan.payload), plan.payload);
  assert.deepEqual(Buffer.from(codec.encode(codec.ROUTES.feedCan.request, plan.payload)),
    Buffer.from('0a0b08818080808080801010031002', 'hex'));

  for (const animal of [{}, { limited_can_used: true }]) {
    const ordinary = animal.limited_can_used ? 400 : 299;
    const fallback = helper.planStep(state({ ordinary, organic: 300, animal }), now);
    assert.equal(fallback.plan.payload.bucket_type, 1);
  }

  for (const animal of [{ can_feed: false }, { grow_ready_at_ms: '-1' }, { stage: 9 }]) {
    assert.equal(helper.planStep(state({ animal, ordinary: 40000, items: before.bag.physical_items }), now).plan, null);
  }
});

test('fill plans use one unlocked known item and fresh state turns the fill into a feed', () => {
  const uid = '9007199254740994';
  const chosen = item('80021', 2, { uid });
  const items = [item('80022', 1, { uid: '22' }), item('80021', 1, { uid: '21', is_locked: true }),
    item('89999', 1, { uid: '101' }), chosen];
  const before = state({ items });
  const { plan } = helper.planStep(before, now);
  assert.equal(plan.action, 'fillCan');
  assert.deepEqual(plan.payload, { item: { id: '80021', count: '1', uid } });
  const decoded = roundTrip(codec.ROUTES.fillCan.request, plan.payload).item;
  assert.equal(decoded.uid, uid);
  assert.equal(decoded.id, '80021');
  assert.equal(decoded.count, '1');

  const response = roundTrip(codec.ROUTES.fillCan.reply, { ...plan.payload, get_items: [item('7003', 3600)] });
  const after = state({ ordinary: 3600, items: [...items.slice(0, -1), { ...chosen, count: '1' }] });
  assert.equal(helper.verifyStep(plan, before, response, after).outcome, 'confirmed');
  assert.equal(helper.planStep(after, now).plan.action, 'feedCan');
  assert.equal(helper.verifyStep(plan, before, response, state({ ordinary: 3599, items: after.bag.physical_items })).outcome, 'unknown');
  assert.equal(helper.verifyStep(plan, before, { ...response, item: { ...response.item, uid: '21' } }, after).outcome, 'unknown');
  assert.equal(helper.verifyStep(plan, before, response, state({ ordinary: 3600, items: items.slice(0, -1) })).outcome, 'unknown');
  const wrongBatch = items.map(entry => entry.uid === '21' ? { ...entry, count: '0' } : entry);
  assert.equal(helper.verifyStep(plan, before, response, state({ ordinary: 3600, items: wrongBatch })).outcome, 'unknown');
  assert.equal(helper.planStep(state({ items: [chosen, { ...chosen, id: '89999' }] }), now).plan, null);

  const longPhase = { grow_ready_at_ms: String(now + 3601000) };
  assert.equal(helper.planStep(state({ items, animal: longPhase }), now).plan.payload.item.id, '80022');
  assert.equal(helper.planStep(state({ items: [chosen], animal: longPhase }), now).plan, null);
  assert.equal(helper.planStep(state({ items, animal: { limited_can_used: true } }), now).plan, null);
});

test('a feed needs an exact target, bag debit and reply balance, with no additional cost', () => {
  const before = state({ ordinary: 300 });
  const { plan } = helper.planStep(before, now);
  const result = { kind: 1, facility_inst_id: ranchId, target_id: String(animalId) };
  const reply = roundTrip(codec.ROUTES.feedCan.reply, { deduct_secs: '300', op_results: [result] });
  const after = state();
  const confirmed = helper.verifyStep(plan, before, reply, after);
  assert.equal(confirmed.outcome, 'confirmed');
  assert.equal(confirmed.completed, 1);
  assert.equal(confirmed.costs[0].count, '300');

  const mismatches = [
    { ...reply, op_results: [] },
    { ...reply, op_results: [{ ...reply.op_results[0], target_id: '4' }] },
    { ...reply, op_results: [{ ...reply.op_results[0], costs: [item('1007', 1)] }] },
    { ...reply, deduct_secs: '301' },
    { ...reply, deduct_secs: '0' },
    { ...reply, bucket_remain_secs: '1' },
  ];
  for (const candidate of mismatches) assert.equal(helper.verifyStep(plan, before, candidate, after).outcome, 'unknown');
  for (const response of [state({ ordinary: 1 }), state({ money: 9 }), null]) {
    assert.equal(helper.verifyStep(plan, before, reply, response).outcome, 'unknown');
  }

  const fasterReply = roundTrip(codec.ROUTES.feedCan.reply, {
    deduct_secs: '299', bucket_remain_secs: '1', op_results: [{ ...result, costs: [item('7003', 299)] }],
  });
  assert.equal(helper.verifyStep(plan, before, fasterReply, state({ ordinary: 1 })).costs[0].count, '299');
});
