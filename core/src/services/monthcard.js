
// Persistent-session async operation tracking.
if (globalThis.process?.env?.FARM_SESSION_BUSINESS === '1') {
  // eslint-disable-next-line no-func-assign -- Preserve the hoisted function and its existing recursive callers.
  getMonthCardInfos = require('./business-state').wrapBusinessFunction('services/monthcard.js:getMonthCardInfos', getMonthCardInfos);
  // eslint-disable-next-line no-func-assign -- Preserve the hoisted function and its existing recursive callers.
  claimMonthCardReward = require('./business-state').wrapBusinessFunction('services/monthcard.js:claimMonthCardReward', claimMonthCardReward);
  // eslint-disable-next-line no-func-assign -- Preserve the hoisted function and its existing recursive callers.
  performDailyMonthCardGift = require('./business-state').wrapBusinessFunction('services/monthcard.js:performDailyMonthCardGift', performDailyMonthCardGift);
  // eslint-disable-next-line no-func-assign -- Preserve the hoisted function and its existing recursive callers.
  getMonthCardPanelInfos = require('./business-state').wrapBusinessFunction('services/monthcard.js:getMonthCardPanelInfos', getMonthCardPanelInfos);
}
/**
 * 月卡服务 - 每日自动领取月卡礼包
 *
 * 功能：
 * - 查询月卡状态（是否拥有、是否可领取）
 * - 自动领取月卡每日奖励
 */
const { sendMsgAsync } = require('../utils/network');
const { types } = require('../utils/proto');
const { log, toNum } = require('../utils/utils');
const { getItemById } = require('../config/gameConfig');

const DAILY_KEY = 'month_card_gift';

// 两次检查最小间隔：10分钟
const CHECK_COOLDOWN_MS = 10 * 60 * 1000;

// 每日状态追踪
let doneDateKey = '';
let lastCheckAt = 0;
let lastClaimAt = 0;
let lastResult = '';
let lastHasCard = null;
let lastHasClaimable = null;

// ---- 日期工具 ----

function getDateKey() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function markDoneToday() {
  doneDateKey = getDateKey();
}

function isDoneToday() {
  return doneDateKey === getDateKey();
}

// ---- 奖励摘要 ----
// 1001→金币, 1002→经验, 200→点券

function getRewardSummary(items) {
  const list = Array.isArray(items) ? items : [];
  const parts = [];
  for (const item of list) {
    const id = toNum(item.id);
    const count = toNum(item.count);
    if (count <= 0) continue;
    if (id === 1001 || id === 500001) {
      parts.push(`金币${count}`);
    } else if (id === 1002 || id === 500002) {
      parts.push(`经验${count}`);
    } else if (id === 200) {
      parts.push(`点券${count}`);
    } else {
      const info = getItemById(id);
      const name = info && info.name ? String(info.name) : `物品#${id}`;
      parts.push(`${name}x${count}`);
    }
  }
  return parts.join('/');
}

// ---- RPC 调用 ----

async function getMonthCardInfos() {
  const request = types.GetMonthCardInfosRequest.encode(
    types.GetMonthCardInfosRequest.create({})
  ).finish();
  const { body } = await sendMsgAsync('gamepb.mallpb.MallService', 'GetMonthCardInfos', request);
  return types.GetMonthCardInfosReply.decode(body);
}

// ---- 面板月卡只读视图：60s 缓存 + 在途合并 + 失败冷却 ----
// 仅在用户首次切到月卡分区时读取；不轮询、不新增领取/付费写。

const MONTHCARD_PANEL_CACHE_MS = 60 * 1000;
let panelMonthCardCache = null;
let panelMonthCardCacheAt = 0;
let panelMonthCardInFlight = null;
let panelMonthCardRetryAfter = 0;
let panelMonthCardOwner = null;

function buildMonthCardPanelEntry(info) {
  if (!info) throw new Error('月卡条目不完整');
  const goodsId = toNum(info.goods_id);
  if (!(goodsId > 0)) throw new Error('月卡条目标识不完整');
  const rewardId = toNum(info.reward && info.reward.id);
  const rewardCount = toNum(info.reward && info.reward.count);
  if (info.can_claim === true && (!(rewardId > 0) || !(rewardCount > 0))) throw new Error('可领月卡的奖励未完整下发');
  return {
    goodsId,
    owned: null, // 当前 schema 未提供持有期限；列出条目不等于已拥有。
    canClaim: info.can_claim === true,
    reward: {
      id: rewardId,
      count: rewardCount,
      countDec: require('./manual-commerce').decimalOf(info.reward?.count),
      summary: `${getItemById(rewardId)?.name || '未知奖励'} × ${require('./manual-commerce').decimalOf(info.reward?.count) || '未知'}`,
    },
  };
}

function getMonthCardPanelInfos() {
  const owner = require('./manual-commerce').ownership();
  if (panelMonthCardOwner?.key !== owner.key || panelMonthCardOwner?.connection !== owner.connection) invalidateMonthCardPanelCache();
  panelMonthCardOwner = owner;
  const now = Date.now();
  if (panelMonthCardCache && now - panelMonthCardCacheAt < MONTHCARD_PANEL_CACHE_MS) {
    return Promise.resolve(panelMonthCardCache);
  }
  if (panelMonthCardInFlight) return panelMonthCardInFlight;
  if (now < panelMonthCardRetryAfter) {
    return Promise.reject(new Error('月卡信息读取冷却中，请稍后再试'));
  }
  const pending = (async () => {
    try {
      const reply = await getMonthCardInfos();
      if (!owner.valid()) throw new Error('账号连接已变化，请刷新');
      if (!Array.isArray(reply?.infos)) throw new Error('月卡回复结构不完整');
      const cards = reply.infos
        .map(buildMonthCardPanelEntry)
        .filter(Boolean);
      const value = { source: 'monthcard-service', cards, ownershipKnown: false, fetchedAt: Date.now() };
      if (panelMonthCardInFlight === pending) {
        panelMonthCardCache = value;
        panelMonthCardCacheAt = Date.now();
        panelMonthCardRetryAfter = 0;
      }
      return value;
    } catch (err) {
      if (panelMonthCardInFlight === pending && owner.valid()) {
        panelMonthCardRetryAfter = Date.now() + MONTHCARD_PANEL_CACHE_MS;
      }
      throw err;
    }
  })();
  panelMonthCardInFlight = pending;
  return pending.finally(() => {
    if (panelMonthCardInFlight === pending) panelMonthCardInFlight = null;
  });
}

function invalidateMonthCardPanelCache() {
  panelMonthCardCache = null;
  panelMonthCardCacheAt = 0;
  panelMonthCardRetryAfter = 0;
  panelMonthCardInFlight = null;
}

async function claimMonthCardReward(goodsId) {
  const request = types.ClaimMonthCardRewardRequest.encode(
    types.ClaimMonthCardRewardRequest.create({ goods_id: Number(goodsId) || 0 })
  ).finish();
  const { body } = await sendMsgAsync('gamepb.mallpb.MallService', 'ClaimMonthCardReward', request);
  invalidateMonthCardPanelCache();
  return types.ClaimMonthCardRewardReply.decode(body);
}

// ---- 主逻辑 ----

/**
 * 执行每日月卡礼包领取
 * @param {boolean} force - 强制检查
 */
async function performDailyMonthCardGift(force = false) {
  const now = Date.now();

  if (!force && isDoneToday()) return false;
  if (!force && now - lastCheckAt < CHECK_COOLDOWN_MS) return false;

  lastCheckAt = now;

  try {
    const reply = await getMonthCardInfos();
    const infos = Array.isArray(reply && reply.infos) ? reply.infos : [];

    lastHasCard = infos.length > 0;

    // 筛选可领取的月卡
    const claimable = infos.filter(
      (info) => info && info.can_claim && Number(info.goods_id || 0) > 0
    );

    lastHasClaimable = claimable.length > 0;

    if (!infos.length) {
      markDoneToday();
      lastResult = 'none';
      log('月卡', '当前没有月卡或已过期', { module: 'task', event: DAILY_KEY, result: 'none' });
      return false;
    }

    if (!claimable.length) {
      markDoneToday();
      lastResult = 'none';
      log('月卡', '今日暂无可领取月卡礼包', { module: 'task', event: DAILY_KEY, result: 'none' });
      return false;
    }

    let claimed = 0;
    for (const card of claimable) {
      try {
        const result = await claimMonthCardReward(Number(card.goods_id || 0));
        const items = Array.isArray(result && result.items) ? result.items : [];
        const summary = getRewardSummary(items);
        log('月卡',
          summary ? `领取成功 → ${summary}` : '领取成功',
          { module: 'task', event: DAILY_KEY, result: 'ok', goodsId: Number(card.goods_id || 0) }
        );
        claimed += 1;
      } catch (err) {
        log('月卡',
          `领取失败(gid=${Number(card.goods_id || 0)}): ${err.message}`,
          { module: 'task', event: DAILY_KEY, result: 'error', goodsId: Number(card.goods_id || 0) }
        );
      }
    }

    if (claimed > 0) {
      lastClaimAt = Date.now();
      markDoneToday();
      lastResult = 'ok';
      return true;
    }

    log('月卡', '本次未成功领取月卡礼包', { module: 'task', event: DAILY_KEY, result: 'none' });
    lastResult = 'none';
    return false;
  } catch (err) {
    lastResult = 'error';
    log('月卡', `查询月卡礼包失败: ${err.message}`, {
      module: 'task', event: DAILY_KEY, result: 'error',
    });
    return false;
  }
}

module.exports = {
  performDailyMonthCardGift,
  getMonthCardInfos,
  getMonthCardPanelInfos,
  invalidateMonthCardPanelCache,
  getMonthCardDailyState: () => ({
    key: DAILY_KEY,
    doneToday: isDoneToday(),
    lastCheckAt,
    lastClaimAt,
    result: lastResult,
    hasCard: lastHasCard,
    hasClaimable: lastHasClaimable,
  }),
};

// Persistent-session data capsule. No handles, functions or in-flight work.
if (globalThis.process?.env?.FARM_SESSION_BUSINESS === '1') {
  const { registerDataState } = require('./business-state');
  // panelMonthCard* 为 2026-11-02 新增只读缓存字段：旧检查点缺省走 optionalKeys
  // 懒迁移（恢复为空缓存，下次选月卡分区再读），不新增业务域。
  registerDataState('services/monthcard.js', () => ({ doneDateKey, lastCheckAt, lastClaimAt, lastResult, lastHasCard, lastHasClaimable, panelMonthCardCache, panelMonthCardCacheAt, panelMonthCardRetryAfter }), value => {
      doneDateKey = value.doneDateKey;
      lastCheckAt = value.lastCheckAt;
      lastClaimAt = value.lastClaimAt;
      lastResult = value.lastResult;
      lastHasCard = value.lastHasCard;
      lastHasClaimable = value.lastHasClaimable;
      panelMonthCardCache = value.panelMonthCardCache ?? null;
      panelMonthCardCacheAt = value.panelMonthCardCacheAt ?? 0;
      panelMonthCardRetryAfter = value.panelMonthCardRetryAfter ?? 0;
  }, { optionalKeys: ['panelMonthCardCache', 'panelMonthCardCacheAt', 'panelMonthCardRetryAfter'], idle: () => !panelMonthCardInFlight });
}
