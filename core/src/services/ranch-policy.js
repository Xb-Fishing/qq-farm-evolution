'use strict';
const model = require('./ranch-model');
const DEFAULT_POLICY = Object.freeze({ enabled: false, harvest: true, produce: true, clean: true, tasks: true,
  intervalMinutes: 5, grassEnabled: false, grassDailyLimit: 0, grassReserve: 0,
  placeEnabled: false, cubId: '', ranchId: '', cubDailyLimit: 0, cubReserve: 0,
  buyEnabled: false, shopId: '5', goodsId: '', purchaseCount: 1, currencyId: '1007', currencyDailyLimit: 0, currencyReserve: 0 });
function normalizePolicy(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('牧场自动化设置无效');
  const result = { ...DEFAULT_POLICY };
  for (const key of Object.keys(result)) {
    if (value[key] === undefined) continue;
    if (typeof result[key] === 'boolean') {
      if (typeof value[key] !== 'boolean') throw new Error('自动化开关无效');
      result[key] = value[key];
    } else if (typeof result[key] === 'number') {
      const n = Number(value[key]);
      if (!Number.isSafeInteger(n) || n < 0 || n > 1000000000) throw new Error('自动化数量或额度无效');
      result[key] = n;
    } else result[key] = value[key] === '' ? '' : model.positiveId(value[key]);
  }
  if (result.intervalMinutes < 2 || result.intervalMinutes > 60 || result.purchaseCount < 1 || result.purchaseCount > 99)
    throw new Error('巡检间隔应为2至60分钟，购买数量应为1至99');
  if (!['5', '6'].includes(result.shopId) || !['1007', '1002', '1005', '1008', '7002'].includes(result.currencyId))
    throw new Error('牧场商店或货币无效');
  if (result.placeEnabled && (!result.cubId || !result.ranchId || !result.cubDailyLimit)) throw new Error('请设置放养目标和每日上限');
  if (result.grassEnabled && !result.grassDailyLimit) throw new Error('请设置每日补草上限');
  if (result.buyEnabled && (!result.goodsId || !result.currencyDailyLimit)) throw new Error('请设置购买商品和每日费用上限');
  return result;
}
const dayKey = now => new Date(now + 8 * 3600000).toISOString().slice(0, 10);
function allowance(policy, plan, raw, usage) {
  if (!policy.enabled) return false;
  const key = { harvest: 'harvest', produce: 'produce', clean: 'clean', claimTasks: 'tasks', addGrass: 'grassEnabled', place: 'placeEnabled', buy: 'buyEnabled' }[plan.action];
  if (!key || !policy[key]) return false;
  if (plan.action === 'place' && (plan.payload.items.some(x => x.ranch_inst_id !== policy.ranchId || x.animal_id !== policy.cubId))) return false;
  if (plan.action === 'buy' && (plan.payload.goods_id !== policy.goodsId || String(raw.shopId) !== policy.shopId || plan.count !== policy.purchaseCount)) return false;
  for (const cost of plan.costItems) {
    const prefix = plan.action === 'addGrass' ? 'grass' : plan.action === 'place' ? 'cub' : plan.action === 'buy' ? 'currency' : '';
    const id = prefix === 'grass' ? '7001' : prefix === 'cub' ? policy.cubId : policy.currencyId;
    if (!prefix || cost.id !== id) return false;
    const count = BigInt(cost.count);
    if (count + BigInt(usage[`${plan.action}:${id}`] || 0) > BigInt(policy[`${prefix}DailyLimit`])
      || BigInt(model.balance(raw.bag, id).available) - count < BigInt(policy[`${prefix}Reserve`])) return false;
  }
  return true;
}
function chooseAction(policy, state, slot) {
  const actions = ['harvest', 'produce', 'clean', 'claimTasks', 'addGrass', 'place', 'buy'];
  const action = actions[slot % actions.length];
  if (action === 'harvest' && policy.harvest && (state.animals.some(x => x.canHarvest) || state.facilities.some(x => x.ranch?.shelves.some(s => s.canCollect)))) return { action, input: { all: true } };
  if (action === 'produce' && policy.produce && state.animals.some(x => x.canProduce)) return { action, input: { all: true } };
  if (action === 'clean' && policy.clean && state.facilities.some(x => x.ranch?.hazards.length)) return { action, input: {} };
  if (action === 'claimTasks' && policy.tasks && state.tasks?.some(x => x.canClaim)) return { action, input: { all: true } };
  if (action === 'buy' && policy.buyEnabled && state.shop?.goods.some(x => x.id === policy.goodsId && x.available)) return { action, input: { shopId: policy.shopId, goodsId: policy.goodsId, count: policy.purchaseCount } };
  if (action === 'addGrass' && policy.grassEnabled) {
    const facility = state.facilities.find(x => x.active && x.feed && x.feed.count < x.capacity / 2);
    const count = facility ? Math.min(facility.capacity - facility.feed.count, Math.max(0, Number(state.grass) - policy.grassReserve), policy.grassDailyLimit, 999) : 0;
    if (count > 0) return { action, input: { facilityId: facility.id, count } };
  }
  if (action === 'place' && policy.placeEnabled) {
    const facility = state.facilities.find(x => x.id === policy.ranchId && x.active && x.ranch);
    const available = state.cubs.filter(x => x.id === policy.cubId && !x.locked).reduce((n, x) => n + BigInt(x.count), 0n);
    const usable = available > BigInt(policy.cubReserve) ? available - BigInt(policy.cubReserve) : 0n;
    const count = facility ? Math.min(facility.ranch.capacity - facility.ranch.count, Number(usable > 50n ? 50n : usable), policy.cubDailyLimit, 50) : 0;
    if (count > 0) return { action, input: { ranchId: policy.ranchId, itemId: policy.cubId, count } };
  }
  return null;
}
module.exports = { DEFAULT_POLICY, normalizePolicy, dayKey, allowance, chooseAction };
