const Long = require('long');
const { getRoot } = require('../utils/proto');
const { getUserState, sendMsgAsync } = require('../utils/network');
const { log } = require('../utils/utils');
const { getBag, getBagItems, invalidatePanelBagCache } = require('./warehouse');

const ACTIVITY_ID = 2026111708;
const SEED_ID = 20307;
const POTATO_ID = 1032;
const COIN_ID = 1033;
// The catalogue response supplies slot and price. A changed price needs fresh item evidence.
const REWARDS = new Map([
  [1, [1000000, 204013, '七彩花弦']],
  [2, [60000, 101627, '福气金豆礼包']],
  [3, [40000, 40522, '金币果']],
  [4, [40000, 40523, '经验蘑菇']],
  [5, [8500, 80011, '有机化肥（1小时）']],
  [6, [28000, 101620, '南瓜种子礼包']],
  [7, [28000, 101621, '荷风种子礼包']],
  [8, [28000, 101622, '千星种子礼包']],
  [9, [35000, 101623, '萌宠种子礼包']],
  [10, [7000, 80001, '化肥（1小时）']],
]);
const COMMANDS = Object.freeze({
  seeds: 91,
  quote: 92,
  sale: 93,
  records: 95,
  exchange: 96,
  catalog: 97,
  dividend: 99,
});

let pendingOperation = false;

function quantity(value) {
  if (typeof value !== 'number' && typeof value !== 'string' && !Long.isLong(value)) return null;
  const text = value.toString();
  if (!/^\d+$/.test(text)) return null;
  const number = Number(text);
  return Number.isSafeInteger(number) ? number : null;
}

function positive(value, message) {
  const number = quantity(value);
  if (!(number > 0)) throw new Error(message);
  return number;
}

function tradeType(name) {
  return getRoot().lookupType(`gamepb.activitypb.sweetpotato.${name}`);
}

async function operate(action, args, checkConnection) {
  checkConnection();
  if (require('./activity').sweetPotatoOutsideWindow()) throw new Error('以薯换福活动已结束或尚未开放');
  const command = COMMANDS[action];
  const request = tradeType('TradeRequest');
  const body = request.encode(request.create({ id: ACTIVITY_ID, command, [action]: args })).finish();
  const reply = await sendMsgAsync('gamepb.activitypb.ActivityService', 'Operate', body);
  checkConnection();
  const parsed = tradeType('TradeReply').decode(reply.body);
  if ((Object.hasOwn(parsed, 'id') && quantity(parsed.id) !== ACTIVITY_ID)
    || (Object.hasOwn(parsed, 'command') && parsed.command !== command)) {
    throw new Error('活动回执与本次操作不符，请刷新活动状态');
  }
  return parsed[action];
}

async function requireActivity(checkConnection) {
  const { getSweetPotatoActivity } = require('./activity');
  const activity = await getSweetPotatoActivity(() => { checkConnection(); return true; });
  checkConnection();
  if (activity?.available !== true) throw new Error('当前账号的活动状态不可用');
  return activity.personal;
}

async function shopTarget(value) {
  const own = positive(getUserState()?.gid, '当前账号尚未进入农场');
  if (value === undefined || value === null || value === '') return own;
  const target = positive(value, '好友编号无效');
  if (target === own) return target;
  const { getAllFriends } = require('./friend-api');
  const roster = await getAllFriends();
  if (!roster?.game_friends?.some(row => quantity(row.gid) === target)) {
    throw new Error('请从当前账号的好友列表选择铺子');
  }
  return target;
}

async function quote(shop, checkConnection) {
  const data = await operate('quote', { shop }, checkConnection);
  if (!data?.price || quantity(data.price.shop?.owner) !== shop) throw new Error('该铺子暂无可核实的行情');
  const base = positive(data.price.base, '该铺子未下发有效的基础价格');
  const bonus = Object.hasOwn(data.price, 'bonus') ? quantity(data.price.bonus) : 0;
  if (bonus === null || !Number.isSafeInteger(base + bonus)) throw new Error('该铺子未下发有效的加成价格');
  return {
    shop, name: data.price.shop.name || '',
    unitPrice: base + bonus,
    remaining: Object.hasOwn(data.price, 'remaining') ? quantity(data.price.remaining) : null,
    acceptsSales: Object.hasOwn(data, 'accepts_sales') ? data.accepts_sales === true : null,
  };
}

async function catalog(checkConnection) {
  const data = await operate('catalog', {}, checkConnection);
  if (!data) throw new Error('未收到活动兑换目录');
  return (data.rows || []).flatMap(row => {
    const index = quantity(row.index);
    const unitPrice = quantity(row.unit_price);
    if (!(index > 0 && unitPrice > 0)) return [];
    const reward = REWARDS.get(index);
    const identified = reward?.[0] === unitPrice;
    return [{
      index,
      unitPrice,
      itemId: identified ? reward[1] : null,
      name: identified ? reward[2] : '',
      state: Object.hasOwn(row, 'state') ? quantity(row.state) : null,
      limit: Object.hasOwn(row, 'limit') ? quantity(row.limit) : null,
    }];
  });
}

async function stock(checkConnection) {
  checkConnection();
  const items = getBagItems(await getBag());
  checkConnection();
  const totals = { seeds: 0, potatoes: 0, coins: 0 };
  for (const row of items) {
    const id = quantity(row.id);
    const count = quantity(row.count);
    if (count === null) continue;
    if (id === SEED_ID) totals.seeds += count;
    if (id === POTATO_ID) totals.potatoes += count;
    if (id === COIN_ID) totals.coins += count;
  }
  return totals;
}

function confirmedGrant(reward, expectedId) {
  const itemId = positive(reward?.item_id, '活动回执缺少奖励道具');
  const count = positive(reward?.count, '活动回执缺少奖励数量');
  if (expectedId && itemId !== expectedId) throw new Error('奖励与预期不符，请核对背包');
  return { itemId, count };
}

async function mutate(action, input, checkConnection) {
  if (pendingOperation) throw new Error('上一次活动操作正在确认，请稍等');
  pendingOperation = true;
  try {
    const activity = await requireActivity(checkConnection);
    if (action === 'seeds') {
      if (activity.seedsClaimed !== false) throw new Error('种子已领取或资格暂未确认');
      return confirmedGrant((await operate('seeds', {}, checkConnection))?.grant, SEED_ID);
    }
    if (action === 'dividend') {
      const amount = positive(activity.pendingDividend, '当前没有可确认的待领分红');
      const result = await operate('dividend', {}, checkConnection);
      if (quantity(result?.amount) !== amount) throw new Error('分红回执待核对，请刷新活动状态');
      return { amount, balance: quantity(result.balance) };
    }
    const count = positive(input.count, '请输入有效的操作数量');
    const price = positive(input.unitPrice, '请刷新价格后重新确认');
    const total = count * price;
    if (!Number.isSafeInteger(total)) throw new Error('本次操作金额超出范围');
    const items = await stock(checkConnection);
    if (action === 'sale') {
      const shop = await shopTarget(input.shop);
      const fresh = await quote(shop, checkConnection);
      if (items.potatoes !== quantity(input.potatoes) || items.potatoes < count) throw new Error('蜜薯库存已变化，请刷新');
      if (fresh.unitPrice !== price || fresh.acceptsSales !== true || fresh.remaining === null || fresh.remaining < count)
        throw new Error('铺子价格或收购额度已变化，请查询后重新确认');
      const result = await operate('sale', { shop, count }, checkConnection);
      if (quantity(result?.count) !== count || quantity(result.unit_price) !== price || quantity(result.proceeds) !== total)
        throw new Error('售卖回执待核对，请刷新铺价和背包');
      return { count, proceeds: total, balance: quantity(result.balance) };
    }
    const index = positive(input.index, '请选择有效的兑换档位');
    const goods = (await catalog(checkConnection)).find(row => row.index === index);
    if (items.coins !== quantity(input.coins) || items.coins < total) throw new Error('福气币余额已变化，请刷新');
    if (!goods?.itemId || goods.unitPrice !== price || goods.limit === null || goods.limit < count)
      throw new Error('兑换价格或余量已变化，请重新确认');
    const result = await operate('exchange', { index, count }, checkConnection);
    if (quantity(result?.unit_price) !== price) throw new Error('兑换回执待核对，请刷新目录和背包');
    const reward = confirmedGrant(result.grant, goods.itemId);
    return { reward, cost: total, balance: quantity(result.balance) };
  } finally {
    invalidatePanelBagCache();
    pendingOperation = false;
  }
}

async function runSweetPotatoTrade(action, input = {}, isCurrent = () => true) {
  const checkConnection = () => {
    if (!isCurrent()) throw new Error('账号连接已变化，请核对活动状态');
  };
  if (['seeds', 'sale', 'exchange', 'dividend'].includes(action)) {
    const result = await mutate(action, input, checkConnection);
    log('活动', `以薯换福已确认：${{ seeds: '领取红薯种子', sale: '出售蜜薯', exchange: '兑换奖励', dividend: '领取分红' }[action]}`, {
      module: 'activity', event: 'sweet_potato_action', action, result: 'ok',
    });
    return result;
  }
  await requireActivity(checkConnection);
  if (action === 'quote') return { quote: await quote(await shopTarget(input.shop), checkConnection), stock: await stock(checkConnection) };
  if (action === 'catalog') return { catalog: await catalog(checkConnection), stock: await stock(checkConnection) };
  if (action === 'records') {
    const data = await operate('records', {}, checkConnection);
    return (data?.rows || []).map(row => ({
      seller: row.seller || '',
      at: quantity(row.time),
      count: quantity(row.count),
      proceeds: quantity(row.proceeds),
      dividend: quantity(row.dividend),
    }));
  }
  throw new Error('无效的活动操作');
}

module.exports = {
  runSweetPotatoTrade: require('./business-state').wrapBusinessFunction(
    'services/sweet-potato-trade.js:runSweetPotatoTrade',
    runSweetPotatoTrade,
  ),
};
