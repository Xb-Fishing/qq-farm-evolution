'use strict';
const model = require('./ranch-model');

const DEFAULT_POLICY = Object.freeze({ enabled: false, harvest: true, produce: true, clean: true, tasks: true,
  intervalMinutes: 5, grassEnabled: false, grassDailyLimit: 0, grassReserve: 0,
  placeEnabled: false, cubId: '', ranchId: '', cubDailyLimit: 0, cubReserve: 0,
  buyEnabled: false, shopId: '5', goodsId: '', purchaseCount: 1, currencyId: '1007', currencyDailyLimit: 0, currencyReserve: 0,
  stockCoop: false, stockShed: false, buyMissingCubs: true, stockBudgetMode: 'live' });
const SLOTS = [
  { action: 'harvest', key: 'harvest' }, { action: 'produce', key: 'produce' },
  { action: 'clean', key: 'clean' }, { action: 'claimTasks', key: 'tasks', view: 'tasks' },
  { action: 'addGrass', key: 'grassEnabled' }, { action: 'place', key: 'placeEnabled' },
  { action: 'buy', key: 'buyEnabled', view: 'shop' },
  { key: 'stockCoop', type: 1 }, { key: 'stockShed', type: 2 },
];
const STOCK_SHOP = '5';
const STOCK_CURRENCY = '1007';
const stockEnabled = (policy, type) => type === 1 ? policy.stockCoop : policy.stockShed;
const liveStock = policy => policy.stockBudgetMode === 'live';
const cubTypes = Object.freeze(Object.fromEntries(model.metadata.animals.map(row => [String(row.cub_item_id), row.husbandry_type === '窝' ? 1 : 2])));
const targetTypes = Object.freeze({ cubs: cubTypes, goods: Object.freeze(Object.fromEntries(model.metadata.goods
  .filter(row => cubTypes[row.item_id]).map(row => [String(row.id), cubTypes[row.item_id]]))) });
const positive = count => count > 0n ? count : 0n;
const least = (...counts) => counts.reduce((a, b) => a < b ? a : b);

function fixedTarget(policy, action) {
  return action === 'place' ? policy.cubId : policy.goodsId;
}

function fixedOwnedByStock(policy, action) {
  const type = targetTypes[action === 'place' ? 'cubs' : 'goods'][fixedTarget(policy, action)];
  return type !== undefined && stockEnabled(policy, type);
}

function fixedConfigured(policy, action) {
  return action === 'place' ? Boolean(policy.cubId && policy.ranchId && policy.cubDailyLimit)
    : Boolean(policy.goodsId && policy.currencyDailyLimit);
}

function slotEnabled(policy, slot) {
  if (!slot || !policy[slot.key]) return false;
  const { action } = slot;
  return !['place', 'buy'].includes(action) || (!fixedOwnedByStock(policy, action) && fixedConfigured(policy, action));
}

function actionSlot(action, index) {
  return index === undefined ? SLOTS.find(row => row.action === action) : SLOTS[index];
}

function isAutomaticActionEnabled(policy, action, index) {
  const slot = actionSlot(action, index);
  return policy.enabled && slotEnabled(policy, slot)
    && (slot.type ? ['place', 'buy'].includes(action) : slot.action === action);
}

function normalizePolicy(value, { previous, fromStorage = false } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('牧场自动化设置无效');
  const result = { ...DEFAULT_POLICY };
  for (const key of Object.keys(result)) {
    if (value[key] === undefined) continue;
    if (key === 'stockBudgetMode') {
      if (!['live', 'manual'].includes(value[key])) throw new Error('补齐额度模式无效');
      result[key] = value[key];
    } else if (typeof result[key] === 'boolean') {
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
  if (result.grassEnabled && !result.grassDailyLimit) throw new Error('请设置每日补草上限');
  if (!fromStorage) {
    for (const [action, enabled, message] of [
      ['place', 'placeEnabled', '请设置放养目标和每日上限'],
      ['buy', 'buyEnabled', '请设置购买商品和每日费用上限'],
    ]) {
      if (!result[enabled] || fixedOwnedByStock(result, action) || fixedConfigured(result, action)) continue;
      // A saved rule may leave stock ownership before its budget is configured.
      // Preserve the selection but let slotEnabled keep the rule inactive.
      const parked = previous?.[enabled] && !fixedConfigured(previous, action)
        && fixedTarget(previous, action) === fixedTarget(result, action);
      if (!parked) throw new Error(message);
    }
  }
  if (result.stockCoop || result.stockShed) {
    // Previously saved stock policies retain their caps and purchase authorization.
    if (value.stockBudgetMode === undefined) {
      result.stockBudgetMode = 'manual';
      if (value.buyMissingCubs === undefined) result.buyMissingCubs = false;
    }
    if (!liveStock(result)) {
      if (!result.cubDailyLimit) throw new Error('按栏舍补齐需要设置每日放养上限');
      if (result.buyMissingCubs && !result.currencyDailyLimit) throw new Error('缺口补购需要设置每日花费上限');
    }
  }
  return result;
}
const dayKey = now => new Date(now + 8 * 3600000).toISOString().slice(0, 10);

function remaining(policy, usage, action, id) {
  const prefix = { addGrass: 'grass', place: 'cub', buy: 'currency' }[action];
  const used = action === 'place' && (policy.stockCoop || policy.stockShed)
    ? Object.entries(usage).filter(([key]) => key.startsWith('place:')).reduce((total, [, count]) => total + BigInt(count), 0n)
    : BigInt(usage[`${action}:${id}`] || 0);
  return positive(BigInt(policy[`${prefix}DailyLimit`]) - used);
}

function vacancies(state, type) {
  const rooms = state.facilities.filter(room => room.moduleType === type + 5);
  if (new Set(rooms.map(room => room.id)).size !== rooms.length) return null;
  const open = [];
  for (const room of rooms) {
    if (room.state === 2 || room.state === 3) continue;
    const ranch = room.ranch;
    if (!room.active || !ranch || ranch.husbandryType !== type || !Number.isSafeInteger(ranch.capacity)
      || !Number.isSafeInteger(ranch.count) || ranch.capacity <= 0 || ranch.count < 0 || ranch.count > ranch.capacity
      || ranch.animals.length !== ranch.count || new Set(ranch.animals.map(animal => animal.id)).size !== ranch.count) return null;
    if (room.upgradeState === 1 || room.upgradeState === 2) continue;
    if (room.upgradeState !== 0 || (room.upgradeEndTime !== '0' && room.upgradeEndTime !== null)) return null;
    if (ranch.capacity > ranch.count) open.push({ id: room.id, count: BigInt(ranch.capacity - ranch.count) });
  }
  return open;
}

function availableCubs(state, type) {
  const amounts = new Map();
  for (const cub of state.cubs) {
    if (cubTypes[cub.id] === type && !cub.locked) amounts.set(cub.id, (amounts.get(cub.id) || 0n) + BigInt(cub.count));
  }
  return amounts;
}

function cubNeed(policy, state, type, useLiveBudget = false) {
  const rooms = vacancies(state, type);
  if (!rooms?.length) return null;
  const amounts = availableCubs(state, type);
  const free = rooms.reduce((total, room) => total + room.count, 0n);
  const reserve = id => !useLiveBudget && (stockEnabled(policy, type) || policy.placeEnabled && policy.cubId === id)
    ? BigInt(policy.cubReserve) : 0n;
  const usable = [...amounts].map(([id, amount]) => [id, positive(amount - reserve(id))]).filter(([, count]) => count > 0n);
  const missing = positive(free - usable.reduce((total, [, count]) => total + count, 0n));
  return { rooms, amounts, free, usable, missing, reserve };
}

function buyBudget(policy, state, usage, useLiveBudget = false) {
  const id = useLiveBudget ? STOCK_CURRENCY : policy.currencyId;
  const currency = state.currencies.find(item => item.id === id);
  const reserve = useLiveBudget ? 0n : BigInt(policy.currencyReserve);
  const available = currency ? BigInt(currency.available) - reserve : -1n;
  return { id, available, daily: useLiveBudget ? null : remaining(policy, usage, 'buy', id) };
}

function buyCount(budget, card, cap) {
  if (!card?.available || card.price?.id !== budget.id || cap <= 0n || budget.available < 0n) return 0n;
  const unit = BigInt(card.price.count);
  const limit = least(cap, BigInt(card.maxCount), card.remaining === null ? cap : BigInt(card.remaining));
  if (!unit) return limit;
  const affordable = budget.available / unit;
  return budget.daily === null ? least(limit, affordable) : least(limit, affordable, budget.daily / unit);
}

function fixedBuy(policy, state, usage) {
  if (state.shop?.shopId !== policy.shopId) return null;
  const cards = state.shop.goods.filter(row => row.id === policy.goodsId);
  const [card] = cards;
  if (cards.length !== 1 || !card.available) return null;
  const requested = BigInt(policy.purchaseCount);
  const budget = buyBudget(policy, state, usage);
  const type = cubTypes[card.reward.id];
  let count;
  if (type) {
    const need = cubNeed(policy, state, type);
    if (!need) return null;
    count = buyCount(budget, card, least(requested, need.missing / BigInt(card.reward.count)));
  } else {
    count = buyCount(budget, card, requested);
    if (count !== requested) return null;
  }
  return count > 0n ? { action: 'buy', input: { shopId: policy.shopId, goodsId: policy.goodsId, count: Number(count) } } : null;
}

function chooseStock(policy, state, type, usage) {
  const useLiveBudget = liveStock(policy);
  const need = cubNeed(policy, state, type, useLiveBudget);
  if (!need) return {};
  const quota = useLiveBudget ? need.free : remaining(policy, usage, 'place', '');
  if (!quota) return {};
  if (need.usable.length) {
    if (need.usable.length > 1 && state.shop?.shopId !== STOCK_SHOP) return { needsShop: 'place' };
    const levels = new Map();
    for (const card of state.shop?.goods || []) {
      const level = Number(card.requiredLevel);
      if (!card.animal || !card.price || !Number.isSafeInteger(level) || level < 1) continue;
      const known = levels.get(card.reward.id);
      levels.set(card.reward.id, known === undefined || known === level ? level : 0);
    }
    const [[itemId, count]] = need.usable.sort(([a, countA], [b, countB]) =>
      (levels.get(b) || 0) - (levels.get(a) || 0) || (countA === countB ? a.localeCompare(b) : countA > countB ? -1 : 1));
    const room = need.rooms.reduce((best, next) => next.count > best.count ? next : best);
    return { selected: { action: 'place', input: { ranchId: room.id, itemId, count: Number(least(count, room.count, quota, 50n)) } } };
  }
  if (!policy.buyMissingCubs) return {};
  const missing = least(need.missing, quota);
  const budget = buyBudget(policy, state, usage, useLiveBudget);
  if (missing <= 0n || budget.daily === 0n || budget.available <= 0n) return {};
  if (state.shop?.shopId !== STOCK_SHOP) return { needsShop: 'buy' };
  if (new Set(state.shop.goods.map(card => card.id)).size !== state.shop.goods.length) return {};
  // The live unlock level takes precedence. The cub IDs follow progression within each husbandry type.
  const candidates = state.shop.goods.filter(card => card.available && cubTypes[card.reward.id] === type
    && card.price?.id === budget.id && BigInt(card.price.count) > 0n)
    .sort((a, b) => Number(b.requiredLevel ?? 0) - Number(a.requiredLevel ?? 0) || Number(b.reward.id) - Number(a.reward.id));
  for (const card of candidates) {
    const perUnit = BigInt(card.reward.count);
    const count = buyCount(budget, card, least(99n, missing / perUnit));
    if (count > 0n && (need.amounts.get(card.reward.id) || 0n) + count * perUnit > need.reserve(card.reward.id))
      return { selected: { action: 'buy', input: { shopId: STOCK_SHOP, goodsId: card.id, count: Number(count) } } };
  }
  return {};
}

function allowance(policy, plan, raw, usage, slot, now) {
  if (!isAutomaticActionEnabled(policy, plan.action, slot)) return false;
  const currentSlot = actionSlot(plan.action, slot);
  if (currentSlot.type || plan.action === 'buy') {
    const state = model.normalizeState(raw, now);
    const candidate = currentSlot.type ? chooseStock(policy, state, currentSlot.type, usage).selected : fixedBuy(policy, state, usage);
    if (candidate?.action !== plan.action || plan.count !== candidate.input.count) return false;
    if (plan.action === 'buy' && (plan.payload.goods_id !== candidate.input.goodsId || String(raw.shopId) !== candidate.input.shopId)) return false;
    if (plan.action === 'place' && (plan.costItems[0]?.id !== candidate.input.itemId
      || plan.payload.items.some(row => row.ranch_inst_id !== candidate.input.ranchId))) return false;
  } else {
    if (plan.action !== currentSlot.action) return false;
    if (plan.action === 'place' && (plan.costItems[0]?.id !== policy.cubId
      || plan.payload.items.some(row => row.ranch_inst_id !== policy.ranchId)
      || !raw.cells.facilities.some(row => String(row.instance_id) === policy.ranchId && row.state === 1))) return false;
  }

  const useLiveBudget = currentSlot.type && liveStock(policy);
  const currencyId = useLiveBudget ? STOCK_CURRENCY : policy.currencyId;
  for (const cost of plan.costItems) {
    const prefix = { addGrass: 'grass', place: 'cub', buy: 'currency' }[plan.action];
    if (!prefix || (plan.action === 'addGrass' && cost.id !== '7001') || (plan.action === 'buy' && cost.id !== currencyId)) return false;
    const { id } = cost;
    const count = BigInt(cost.count);
    const reserve = useLiveBudget ? 0n : BigInt(policy[`${prefix}Reserve`]);
    if ((!useLiveBudget && count > remaining(policy, usage, plan.action, id))
      || BigInt(model.balance(raw.bag, id).available) - count < reserve) return false;
  }
  return true;
}

function chooseAction(policy, state, slot, usage = {}) {
  if (!slotEnabled(policy, SLOTS[slot])) return null;
  const { action, type } = SLOTS[slot];
  if (type) return chooseStock(policy, state, type, usage).selected;
  if (action === 'harvest' && (state.animals.some(x => x.canHarvest) || state.facilities.some(x => x.ranch?.shelves.some(s => s.canCollect)))) return { action, input: { all: true } };
  if (action === 'produce' && state.animals.some(x => x.canProduce)) return { action, input: { all: true } };
  if (action === 'clean' && state.facilities.some(x => x.ranch?.hazards.length)) return { action, input: {} };
  if (action === 'claimTasks' && state.tasks?.some(x => x.canClaim)) return { action, input: { all: true } };
  if (action === 'buy') return fixedBuy(policy, state, usage);
  if (action === 'addGrass') {
    const facility = state.facilities.find(x => x.active && x.feed && x.feed.count < x.capacity / 2);
    const count = facility ? Math.min(facility.capacity - facility.feed.count, Math.max(0, Number(state.grass) - policy.grassReserve), Number(remaining(policy, usage, 'addGrass', '7001')), 999) : 0;
    if (count > 0) return { action, input: { facilityId: facility.id, count } };
  }
  if (action === 'place') {
    const facility = state.facilities.find(x => x.id === policy.ranchId && x.active && x.ranch);
    const available = state.cubs.filter(x => x.id === policy.cubId && !x.locked).reduce((n, x) => n + BigInt(x.count), 0n);
    const usable = positive(available - BigInt(policy.cubReserve));
    const count = facility ? Math.min(facility.ranch.capacity - facility.ranch.count, Number(least(usable, remaining(policy, usage, 'place', policy.cubId), 50n))) : 0;
    if (count > 0) return { action, input: { ranchId: policy.ranchId, itemId: policy.cubId, count } };
  }
  return null;
}
module.exports = { DEFAULT_POLICY, SLOTS, STOCK_SHOP, targetTypes, normalizePolicy, dayKey, allowance, chooseAction,
  chooseStock, slotEnabled, isAutomaticActionEnabled };
