'use strict';
const model = require('./ranch-model');

const DEFAULT_POLICY = Object.freeze({ enabled: false, harvest: true, produce: true, clean: true, tasks: true,
  intervalMinutes: 5, grassEnabled: false, grassDailyLimit: 0, grassReserve: 0,
  placeEnabled: false, cubId: '', ranchId: '', cubDailyLimit: 0, cubReserve: 0,
  buyEnabled: false, shopId: '5', goodsId: '', purchaseCount: 1, currencyId: '1007', currencyDailyLimit: 0, currencyReserve: 0,
  stockCoop: false, stockShed: false, buyMissingCubs: false });
const SLOTS = [
  { action: 'harvest', key: 'harvest' }, { action: 'produce', key: 'produce' },
  { action: 'clean', key: 'clean' }, { action: 'claimTasks', key: 'tasks', view: 'tasks' },
  { action: 'addGrass', key: 'grassEnabled' }, { action: 'place', key: 'placeEnabled' },
  { action: 'buy', key: 'buyEnabled', view: 'shop' },
  { key: 'stockCoop', type: 1 }, { key: 'stockShed', type: 2 },
];
const STOCK_SHOP = '5';
const stockEnabled = (policy, type) => type === 1 ? policy.stockCoop : policy.stockShed;
const cubTypes = new Map(model.metadata.animals.map(row => [String(row.cub_item_id), row.husbandry_type === '窝' ? 1 : 2]));
const positive = count => count > 0n ? count : 0n;
const least = (...counts) => counts.reduce((a, b) => a < b ? a : b);

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
  if (result.stockCoop || result.stockShed) {
    if (!result.cubDailyLimit) throw new Error('按栏舍补齐需要设置每日放养上限');
    if (result.buyMissingCubs && !result.currencyDailyLimit) throw new Error('缺口补购需要设置每日花费上限');
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
    if (cubTypes.get(cub.id) === type && !cub.locked) amounts.set(cub.id, (amounts.get(cub.id) || 0n) + BigInt(cub.count));
  }
  return amounts;
}

function cubNeed(policy, state, type) {
  const rooms = vacancies(state, type);
  if (!rooms?.length) return null;
  const amounts = availableCubs(state, type);
  const free = rooms.reduce((total, room) => total + room.count, 0n);
  const reserve = id => BigInt(stockEnabled(policy, type) || policy.placeEnabled && policy.cubId === id ? policy.cubReserve : 0);
  const usable = [...amounts].map(([id, amount]) => [id, positive(amount - reserve(id))]);
  const missing = positive(free - usable.reduce((total, [, count]) => total + count, 0n));
  return { rooms, amounts, usable, missing, reserve };
}

function buyCount(policy, state, usage, card, cap) {
  if (!card?.available || card.price?.id !== policy.currencyId || cap <= 0n) return 0n;
  const unit = BigInt(card.price.count);
  const currency = state.currencies.find(item => item.id === card.price.id);
  if (!currency || BigInt(currency.available) < BigInt(policy.currencyReserve)) return 0n;
  const limit = least(cap, BigInt(card.maxCount), card.remaining === null ? cap : BigInt(card.remaining));
  if (!unit) return limit;
  return least(limit, remaining(policy, usage, 'buy', card.price.id) / unit,
    (BigInt(currency.available) - BigInt(policy.currencyReserve)) / unit);
}

function fixedBuy(policy, state, usage) {
  if (state.shop?.shopId !== policy.shopId) return null;
  const cards = state.shop.goods.filter(row => row.id === policy.goodsId);
  const [card] = cards;
  if (cards.length !== 1 || !card.available) return null;
  const requested = BigInt(policy.purchaseCount);
  const type = cubTypes.get(card.reward.id);
  let count;
  if (type) {
    if (stockEnabled(policy, type) && policy.buyMissingCubs) return null;
    const need = cubNeed(policy, state, type);
    if (!need) return null;
    count = buyCount(policy, state, usage, card, least(requested, need.missing / BigInt(card.reward.count)));
  } else {
    count = buyCount(policy, state, usage, card, requested);
    if (count !== requested) return null;
  }
  return count > 0n ? { action: 'buy', input: { shopId: policy.shopId, goodsId: policy.goodsId, count: Number(count) } } : null;
}

function chooseStock(policy, state, type, usage) {
  const need = cubNeed(policy, state, type);
  const quota = remaining(policy, usage, 'place', '');
  if (!need || !quota) return {};
  for (const [itemId, count] of need.usable) {
    if (count > 0n) {
      const room = need.rooms[0];
      return { selected: { action: 'place', input: { ranchId: room.id, itemId, count: Number(least(count, room.count, quota, 50n)) } } };
    }
  }
  if (!policy.buyMissingCubs) return {};
  const missing = least(need.missing, quota);
  if (missing <= 0n || remaining(policy, usage, 'buy', policy.currencyId) <= 0n
    || !state.currencies.some(item => item.id === policy.currencyId && BigInt(item.available) > BigInt(policy.currencyReserve))) return {};
  if (state.shop?.shopId !== STOCK_SHOP) return { needsShop: true };
  if (new Set(state.shop.goods.map(card => card.id)).size !== state.shop.goods.length) return {};
  // The live unlock level takes precedence. The cub IDs follow progression within each husbandry type.
  const candidates = state.shop.goods.filter(card => card.available && cubTypes.get(card.reward.id) === type
    && card.price?.id === policy.currencyId && BigInt(card.price.count) > 0n)
    .sort((a, b) => Number(b.requiredLevel ?? 0) - Number(a.requiredLevel ?? 0) || Number(b.reward.id) - Number(a.reward.id));
  for (const card of candidates) {
    const perUnit = BigInt(card.reward.count);
    const count = buyCount(policy, state, usage, card, least(99n, missing / perUnit));
    if (count > 0n && (need.amounts.get(card.reward.id) || 0n) + count * perUnit > need.reserve(card.reward.id))
      return { selected: { action: 'buy', input: { shopId: STOCK_SHOP, goodsId: card.id, count: Number(count) } } };
  }
  return {};
}

function allowance(policy, plan, raw, usage, slot, now) {
  if (!policy.enabled) return false;
  const currentSlot = slot === undefined ? SLOTS.find(row => row.action === plan.action) : SLOTS[slot];
  if (!currentSlot || !policy[currentSlot.key]) return false;
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

  for (const cost of plan.costItems) {
    const prefix = { addGrass: 'grass', place: 'cub', buy: 'currency' }[plan.action];
    if (!prefix || (plan.action === 'addGrass' && cost.id !== '7001') || (plan.action === 'buy' && cost.id !== policy.currencyId)) return false;
    const { id } = cost;
    const count = BigInt(cost.count);
    if (count > remaining(policy, usage, plan.action, id)
      || BigInt(model.balance(raw.bag, id).available) - count < BigInt(policy[`${prefix}Reserve`])) return false;
  }
  return true;
}

function chooseAction(policy, state, slot, usage = {}) {
  const { action, type, key } = SLOTS[slot];
  if (!policy[key]) return null;
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
module.exports = { DEFAULT_POLICY, SLOTS, STOCK_SHOP, normalizePolicy, dayKey, allowance, chooseAction, chooseStock };
