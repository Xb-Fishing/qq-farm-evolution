'use strict';

const model = require('./ranch-model');
const actions = new Set(['stealFriend', 'cleanFriend']);

function fail(code, message) {
  throw Object.assign(new Error(message), { code });
}

function verifyEntry(entry, host) {
  if (entry.basic?.gid !== host || entry.is_tourist === true || !entry.homestead_cells)
    fail('RANCH_FRIEND_UNAVAILABLE', '好友牧场身份或访问资格未确认');
}

function describe(entry, detail, host, self) {
  const facilities = new Set(entry.homestead_cells.facilities.map(row => row.instance_id));
  const seen = new Set();
  const hazardKeys = new Set();
  const stealable = [];
  const hazards = [];
  for (const ranch of detail.ranches) {
    const ranchId = model.positiveId(ranch.ranch_inst_id);
    if (!facilities.has(ranchId) || seen.has(ranchId))
      fail('RANCH_RESPONSE_MISMATCH', '好友牧场详情与进入时的栏舍不匹配');
    seen.add(ranchId);
    for (const shelf of ranch.shelves) {
      if (shelf.can_steal !== true || !Number.isSafeInteger(shelf.slot_index) || shelf.slot_index < 0) continue;
      const lots = shelf.lots.filter(lot => lot.can_steal && BigInt(model.decimal(lot.remain_num)) > 0n
        && !lot.stealers.some(gid => String(gid) === self));
      if (lots.length) stealable.push({ ranchId, slot: shelf.slot_index,
        items: [...new Set(lots.map(lot => model.positiveId(lot.item_id)))].sort() });
    }
    for (const hazard of ranch.hazards) {
      const hazardId = model.positiveId(hazard.hazard_id);
      const key = `${ranchId}:${hazardId}`;
      if (hazardKeys.has(key)) fail('RANCH_RESPONSE_MISMATCH', '好友牧场污物信息重复');
      hazardKeys.add(key);
      if (hazard.hazard_type === 1 && String(hazard.owner) === self) continue;
      hazards.push({ ranchId, hazardId });
    }
  }
  stealable.sort((a, b) => `${a.ranchId}:${a.slot}`.localeCompare(`${b.ranchId}:${b.slot}`));
  hazards.sort((a, b) => `${a.ranchId}:${a.hazardId}`.localeCompare(`${b.ranchId}:${b.hazardId}`));
  return { host, name: entry.basic.name, stealable, hazards, ranchIds: seen, hazardKeys };
}

function plan(action, data) {
  const steal = action === 'stealFriend';
  const targets = steal ? data.stealable : data.hazards;
  const label = steal ? '偷取好友牧场产物' : '帮好友清理牧场';
  if (!targets.length) fail('RANCH_STATE_CHANGED', steal ? '当前没有可偷产物' : '当前没有可清扫的污物');
  if (targets.length > 50) fail('RANCH_INVALID_ARGUMENT', '本次好友牧场操作目标过多');
  const resultKeys = targets.map(row => `${row.ranchId}:${steal ? row.slot : row.hazardId}`);
  if (new Set(resultKeys).size !== resultKeys.length) fail('RANCH_RESPONSE_MISMATCH', '好友牧场包含重复目标');
  const payload = steal
    ? { host_gid: data.host, targets: targets.map(row => ({ ranch_inst_id: row.ranchId, slot_index: row.slot })) }
    : { host_gid: data.host, ranch_inst_ids: [...new Set(targets.map(row => row.ranchId))] };
  return { action, label, route: steal ? 'stealFriend' : 'clean', payload, count: targets.length,
    resultKeys, friendOffers: targets, costItems: [], expectedRewards: [] };
}

function verify(plan, reply) {
  const steal = plan.action === 'stealFriend';
  const rows = reply.op_results || [];
  const seen = new Set();
  if (!rows.length) fail('RANCH_RESULT_UNKNOWN', '服务端未返回完成目标');
  if (!steal) {
    // CleanAllRanch sends facility IDs. The server can report hazards that appeared after the preview.
    const facilities = new Set(plan.payload.ranch_inst_ids);
    const rewards = [];
    for (const row of rows) {
      const key = `${row.facility_inst_id}:${model.positiveId(row.target_id)}`;
      if (row.kind !== 3 || !facilities.has(row.facility_inst_id) || seen.has(key) || row.costs.length)
        fail('RANCH_RESULT_UNKNOWN', '清理回执与所选栏舍不匹配');
      seen.add(key);
      for (const item of row.rewards) {
        if (model.decimal(item.count) === '0') continue;
        model.positiveId(item.id);
        rewards.push(item);
      }
    }
    return { completed: rows.length, rewards };
  }
  for (const row of rows) {
    const key = `${row.facility_inst_id}:${row.target_id}`;
    const index = plan.resultKeys.indexOf(key);
    if (index < 0 || seen.has(key) || row.kind !== 2 || row.costs.length
      || !row.rewards.length || row.rewards.some(item => BigInt(model.decimal(item.count)) <= 0n
        || !plan.friendOffers[index].items.includes(String(item.id))))
      fail('RANCH_RESULT_UNKNOWN', '好友牧场回执与确认范围不匹配，请刷新核对');
    seen.add(key);
  }
  return { completed: rows.length, rewards: rows.flatMap(row => row.rewards) };
}

function cleaningGoalMet(plan, friend) {
  return plan?.action === 'cleanFriend' && plan.payload?.host_gid === friend.host
    && plan.payload.ranch_inst_ids?.length > 0 && plan.resultKeys?.length > 0
    && plan.payload.ranch_inst_ids.every(id => friend.ranchIds.has(id))
    && plan.resultKeys.every(key => !friend.hazardKeys.has(key));
}

module.exports = { actions, verifyEntry, describe, plan, verify, cleaningGoalMet };
