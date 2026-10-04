const { getItemById, getItemImageById } = require('../config/gameConfig');
const { sendMsgAsync } = require('../utils/network');
const { types } = require('../utils/proto');
const { toNum, log, logWarn } = require('../utils/utils');
const { getAutomation } = require('../models/store');

const SERVICE = 'gamepb.mysteryshoppb.MysteryShopService';
const CURRENCY_NAMES = {
  1001: '金币',
  1002: '点券',
  1005: '金豆豆',
};

// 商人可能在登录完成后才出现，不能只依赖登录时的一次检查。
// 十分钟一次的只读查询可确保限时商品进入自动购买流程，同时避免过于频繁地请求。
const AUTO_BUY_CHECK_INTERVAL_MS = 10 * 60 * 1000;

// 固定间隔是机器指纹：均匀打散 ±25%，均值仍为 10 分钟（防封巡检 2026-08-23）
function nextAutoBuyCheckDelayMs() {
  const spread = Math.floor(AUTO_BUY_CHECK_INTERVAL_MS * 0.25);
  return AUTO_BUY_CHECK_INTERVAL_MS - spread + Math.floor(Math.random() * (spread * 2 + 1));
}

function normalizeNPC(reply) {
  const npc = reply?.npc;
  const itemId = toNum(npc?.item_id);
  const itemInfo = getItemById(itemId);
  const endTime = toNum(reply?.end_time);
  const purchased = !!npc?.purchased;

  return {
    active: !!reply?.active && !purchased && (!endTime || endTime * 1000 > Date.now()),
    npcId: toNum(npc?.npc_id),
    itemId,
    itemType: toNum(npc?.item_type),
    itemName: itemInfo?.name || `物品${itemId}`,
    itemImage: getItemImageById(itemId),
    itemCount: toNum(npc?.item_count),
    currencyId: toNum(npc?.currency_id),
    currencyName: CURRENCY_NAMES[toNum(npc?.currency_id)] || `货币${toNum(npc?.currency_id)}`,
    price: toNum(npc?.price),
    originalPrice: toNum(npc?.original_price),
    discount: toNum(npc?.discount),
    purchased,
    startTime: toNum(reply?.start_time),
    endTime,
  };
}

async function getActiveMysteryShop() {
  const request = types.GetActiveMysteryNPCRequest.encode(
    types.GetActiveMysteryNPCRequest.create({})
  ).finish();
  const { body } = await sendMsgAsync(SERVICE, 'GetActiveNPC', request);
  return normalizeNPC(types.GetActiveMysteryNPCReply.decode(body));
}

// ---- 面板神秘商人读取缓存（下游刷新不穿透腾讯上游，2026-10-03） ----
// 面板横幅 3 小时固定刷新、商城页挂载与账号切换每次都拉 /api/shop/mystery，
// 无缓存时每次直发 MysteryShopService.GetActiveNPC（固定间隔直发属机器指纹）。
// 语义与 warehouse.getBagForPanel 相同：60s 成功缓存 + 在途合并 + 60s 失败
// 冷却；Buy/Abandon 成功返回后在服务内部失效——面板手动购买与自动购买共用
// 这两个写函数，自动买成交后面板缓存同样失效，一处覆盖全部调用方。只供
// 面板读路径使用；自动购买 checkAndAutoBuyMysteryShop 仍走无缓存的
// getActiveMysteryShop()（库存服务端随机、成交决策需要当前态）。
const MYSTERY_PANEL_CACHE_MS = 60 * 1000;
let panelMysteryCache = null;
let panelMysteryCacheAt = 0;
let panelMysteryInFlight = null;
let panelMysteryRetryAfter = 0;

async function getMysteryShopForPanel() {
  const now = Date.now();
  if (panelMysteryCache && now - panelMysteryCacheAt < MYSTERY_PANEL_CACHE_MS) {
    return panelMysteryCache;
  }
  if (panelMysteryInFlight) return panelMysteryInFlight;
  if (now < panelMysteryRetryAfter) {
    throw new Error('神秘商人读取冷却中，请稍后再试');
  }
  const pending = (async () => {
    try {
      const shop = await getActiveMysteryShop();
      if (panelMysteryInFlight === pending) {
        panelMysteryCache = shop;
        panelMysteryCacheAt = Date.now();
        panelMysteryRetryAfter = 0;
      }
      return shop;
    } catch (err) {
      if (panelMysteryInFlight === pending) {
        panelMysteryRetryAfter = Date.now() + MYSTERY_PANEL_CACHE_MS;
      }
      throw err;
    }
  })();
  panelMysteryInFlight = pending;
  try {
    return await pending;
  } finally {
    if (panelMysteryInFlight === pending) panelMysteryInFlight = null;
  }
}

function invalidatePanelMysteryCache() {
  panelMysteryCache = null;
  panelMysteryCacheAt = 0;
  panelMysteryRetryAfter = 0;
  // 在途读取也解除引用：其完成体检查 inFlight === pending 失败，不会写回旧数据
  panelMysteryInFlight = null;
}

async function buyMysteryShopGoods(npcId) {
  const id = toNum(npcId);
  if (id <= 0) throw new Error('无效的神秘商人 ID');

  const request = types.BuyMysteryShopRequest.encode(
    types.BuyMysteryShopRequest.create({ npc_id: id })
  ).finish();
  const { body } = await sendMsgAsync(SERVICE, 'Buy', request);
  invalidatePanelMysteryCache();
  const reply = types.BuyMysteryShopReply.decode(body);
  return {
    reward: {
      itemId: toNum(reply?.reward?.item_id),
      count: toNum(reply?.reward?.count),
    },
    purchased: !!reply?.npc?.purchased,
  };
}

async function abandonMysteryShop() {
  const request = types.AbandonMysteryShopRequest.encode(
    types.AbandonMysteryShopRequest.create({})
  ).finish();
  const { body } = await sendMsgAsync(SERVICE, 'Abandon', request);
  invalidatePanelMysteryCache();
  types.AbandonMysteryShopReply.decode(body);
  return { abandoned: true };
}

function isCurrencyAllowed(currencyId, automation = getAutomation() || {}) {
  const keyByCurrency = {
    1001: 'mystery_shop_allow_gold',
    1002: 'mystery_shop_allow_coupon',
    1005: 'mystery_shop_allow_gold_bean',
  };
  const key = keyByCurrency[toNum(currencyId)];
  return !!key && automation[key] === true;
}

async function checkAndAutoBuyMysteryShop() {
  const automation = getAutomation() || {};
  if (automation.mystery_shop_auto_buy !== true) return { skipped: true, reason: 'disabled' };

  try {
    const offer = await getActiveMysteryShop();
    if (!offer.active) return { skipped: true, reason: 'inactive' };
    if (!isCurrencyAllowed(offer.currencyId, automation)) {
      log('商城', `神秘商人自动购买已跳过：未允许使用${offer.currencyName}`, {
        module: 'shop', event: '神秘商人自动购买', result: 'skip', currencyId: offer.currencyId
      });
      return { skipped: true, reason: 'currency_not_allowed', offer };
    }

    const result = await buyMysteryShopGoods(offer.npcId);
    log('商城', `神秘商人自动购买成功：${offer.itemName} x${offer.itemCount}，花费 ${offer.price} ${offer.currencyName}`, {
      module: 'shop', event: '神秘商人自动购买', result: 'success', itemId: offer.itemId,
      count: offer.itemCount, currencyId: offer.currencyId, price: offer.price
    });
    return { ...result, offer };
  } catch (err) {
    logWarn('商城', `神秘商人自动购买检查失败: ${err.message}`, {
      module: 'shop', event: '神秘商人自动购买', result: 'error', error: err.message
    });
    return { skipped: true, reason: 'error', error: err.message };
  }
}

module.exports = {
  AUTO_BUY_CHECK_INTERVAL_MS,
  nextAutoBuyCheckDelayMs,
  getActiveMysteryShop,
  getMysteryShopForPanel,
  invalidatePanelMysteryCache,
  MYSTERY_PANEL_CACHE_MS,
  buyMysteryShopGoods,
  abandonMysteryShop,
  checkAndAutoBuyMysteryShop,
  isCurrencyAllowed,
  normalizeNPC,
};
