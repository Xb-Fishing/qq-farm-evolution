'use strict';

const model = require('./ranch-model');

const SCHEMA = `
message FeedAnimalRequest {
  repeated AnimalRef targets = 1;
  int32 bucket_type = 2;
}
message FeedAnimalReply {
  repeated RanchDetail ranches = 1;
  int64 deduct_secs = 2;
  int64 bucket_remain_secs = 4;
  repeated FacilityOpResult op_results = 5;
}
message RanchUseCanRequest { Item item = 1; }
message RanchUseCanReply {
  Item item = 1;
  repeated Item get_items = 2;
  repeated Item compensated_items = 3;
}
`;

const ROUTES = Object.freeze({
  feedCan: { service: 'gamepb.animalpb.AnimalService', method: 'FeedAnimal', request: 'FeedAnimalRequest', reply: 'FeedAnimalReply', writing: true },
  fillCan: { service: 'gamepb.itempb.ItemService', method: 'Use', request: 'RanchUseCanRequest', reply: 'RanchUseCanReply', writing: true },
});

// Scene 2 MCItemInfo lists can items by bucket type and the time each adds.
const BUCKETS = [
  { id: '7003', type: 2, cans: ['80021', '80022', '80023', '80024'] },
  { id: '7004', type: 1, cans: ['80031', '80032', '80033', '80034'] },
];
const DURATIONS = [3600n, 14400n, 28800n, 43200n];
const PHASE_END = [null, 'infant_ready_at_ms', 'grow_ready_at_ms', 'produce_ready_at_ms', 'mature_ready_at_ms'];

function balances(bag) {
  if (bag?.global_scene_id !== 2 || !Array.isArray(bag.physical_items) || !Array.isArray(bag.virtual_items))
    throw new Error('牧场背包未确认');
  const totals = new Map();
  const available = new Map();
  for (const item of [...bag.physical_items, ...bag.virtual_items]) {
    const id = model.positiveId(item.id);
    const count = BigInt(model.decimal(item.count));
    totals.set(id, (totals.get(id) ?? 0n) + count);
    if (!item.is_locked && !item.locked) available.set(id, (available.get(id) ?? 0n) + count);
  }
  return { totals, available };
}

function targets(cells, nowMs) {
  const known = [];
  let unknown = false;
  const seen = new Set();
  const serverSec = BigInt(Math.floor(nowMs / 1000));
  for (const facility of cells.facilities) {
    const ranch = facility.ranch;
    if (!ranch) continue;
    const ranchId = model.positiveId(ranch.ranch_inst_id);
    if (ranchId !== model.positiveId(facility.instance_id) || !Array.isArray(ranch.animals)) throw new Error('牧场栏位未确认');
    for (const animal of ranch.animals) {
      const id = model.positiveCount(animal.animal_inst_id);
      const key = `${ranchId}:${id}`;
      if (seen.has(key) || model.positiveId(animal.ranch_inst_id) !== ranchId) throw new Error('牧场动物目标未确认');
      seen.add(key);
      if (animal.can_feed !== true) continue;
      const field = PHASE_END[animal.stage];
      const deadline = field && animal[field];
      if (!/^[1-9]\d*$/.test(String(deadline))) {
        unknown = true;
        continue;
      }
      const seconds = (BigInt(model.positiveId(deadline)) + 999n) / 1000n - serverSec;
      if (seconds <= 0n) {
        unknown = true;
        continue;
      }
      known.push({ seconds, ordinary: animal.limited_can_used === false,
        ref: { ranch_inst_id: ranchId, animal_inst_id: id } });
    }
  }
  return { known, unknown };
}

function bucketTarget(candidates, bucket, seconds) {
  return candidates.find(target => (bucket.type === 1 || target.ordinary) && target.seconds <= seconds);
}

function planStep(raw, nowMs) {
  try {
    if (!Number.isSafeInteger(nowMs) || nowMs <= 0 || !Array.isArray(raw?.cells?.facilities))
      return { plan: null, reason: '罐头喂养状态未确认' };
    const { known, unknown } = targets(raw.cells, nowMs);
    if (!known.length) return { plan: null, reason: unknown ? '当前阶段的罐头消耗未确认' : '当前没有可喂养的动物' };
    const { available } = balances(raw.bag);
    for (const bucket of BUCKETS) {
      const target = bucketTarget(known, bucket, available.get(bucket.id) ?? 0n);
      if (target) {
        return { plan: { action: 'feedCan', route: 'feedCan', label: '喂养牧场动物', count: 1,
          payload: { targets: [target.ref], bucket_type: bucket.type }, bucketId: bucket.id,
          costItems: [model.itemDto({ id: bucket.id, count: target.seconds })] }, reason: null };
      }
    }

    const batches = new Map();
    const duplicate = new Set();
    for (const item of raw.bag.physical_items) {
      const uid = String(item.uid);
      if (batches.has(uid)) duplicate.add(uid);
      else batches.set(uid, item);
    }
    for (const [index, seconds] of DURATIONS.entries()) {
      for (const bucket of BUCKETS) {
        const id = bucket.cans[index];
        if (!bucketTarget(known, bucket, (available.get(bucket.id) ?? 0n) + seconds)) continue;
        for (const [uid, item] of batches) {
          if (String(item.id) !== id || item.is_locked || item.locked || duplicate.has(uid)
            || !/^[1-9]\d*$/.test(uid) || BigInt(model.decimal(item.count)) < 1n) continue;
          const payload = { item: { id, uid: model.positiveId(uid), count: '1' } };
          return { plan: { action: 'fillCan', route: 'fillCan', label: '添加一罐牧场罐头', count: 1,
            payload, bucketId: bucket.id, seconds: seconds.toString(), costItems: [model.itemDto(payload.item)] }, reason: null };
        }
      }
    }
    return { plan: null, reason: '可用罐头时长不足或没有可添加的已知库存罐头' };
  } catch {
    return { plan: null, reason: '罐头库存或动物状态未确认' };
  }
}

function onlyExpectedDebit(before, after, id, expected) {
  return (before.get(id) ?? 0n) - (after.get(id) ?? 0n) === expected
    && [...before].every(([itemId, count]) => itemId === id || (after.get(itemId) ?? 0n) >= count);
}

function batchCount(bag, id, uid) {
  const matches = bag.physical_items.filter(item => String(item.uid) === uid);
  if (!matches.length) return 0n;
  if (matches.length !== 1 || String(matches[0].id) !== id || matches[0].is_locked || matches[0].locked)
    throw new Error('罐头批次未确认');
  return BigInt(model.decimal(matches[0].count));
}

function verifyStep(plan, before, reply, after) {
  const unknown = { outcome: 'unknown', completed: 0, costs: [], rewards: [], message: '罐头操作的回执、目标或背包变化未匹配' };
  try {
    const was = balances(before.bag).totals;
    const next = balances(after.bag).totals;
    const bucketBefore = was.get(plan.bucketId) ?? 0n;
    const bucketAfter = next.get(plan.bucketId) ?? 0n;
    let costs;
    if (plan.action === 'feedCan') {
      const [target] = plan.payload.targets;
      const [result] = reply.op_results;
      const seconds = BigInt(model.positiveId(reply.deduct_secs));
      const remain = BigInt(model.decimal(reply.bucket_remain_secs));
      if (reply.op_results.length !== 1 || result.kind !== 1 || String(result.facility_inst_id) !== target.ranch_inst_id
        || String(result.target_id) !== String(target.animal_inst_id) || result.rewards.length
        || (result.costs.length > 0 && (result.costs.length !== 1 || String(result.costs[0].id) !== plan.bucketId
          || BigInt(model.decimal(result.costs[0].count)) !== seconds))
        || seconds > BigInt(plan.costItems[0].count) || remain !== bucketBefore - seconds || remain !== bucketAfter
        || !onlyExpectedDebit(was, next, plan.bucketId, seconds)) return unknown;
      costs = [model.itemDto({ id: plan.bucketId, count: seconds })];
    } else if (plan.action === 'fillCan') {
      const { id, uid } = plan.payload.item;
      const seconds = BigInt(plan.seconds);
      if (String(reply.item?.id) !== id || String(reply.item.uid) !== uid || String(reply.item.count) !== '1'
        || reply.compensated_items.length
        || (reply.get_items.length > 0 && (reply.get_items.length !== 1 || String(reply.get_items[0].id) !== plan.bucketId
          || BigInt(model.decimal(reply.get_items[0].count)) !== seconds))
        || !onlyExpectedDebit(was, next, id, 1n)
        || batchCount(before.bag, id, uid) - batchCount(after.bag, id, uid) !== 1n
        || bucketAfter - bucketBefore !== seconds) return unknown;
      costs = plan.costItems;
    } else {
      return unknown;
    }
    return { outcome: 'confirmed', completed: 1, costs, rewards: [],
      message: plan.action === 'feedCan' ? '已核对喂养目标和罐头扣除时长' : '已核对一罐库存扣除和罐头桶新增时长' };
  } catch {
    return unknown;
  }
}

module.exports = { SCHEMA, ROUTES, planStep, verifyStep };
