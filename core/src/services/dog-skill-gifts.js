const { getItemById } = require('../config/gameConfig');
const { sendMsgAsync } = require('../utils/network');
const { types } = require('../utils/proto');
const { toNum } = require('../utils/utils');
const { createModuleLogger } = require('./logger');

const DOG_SKILL_GIFT_ITEM_ID = 101351;
const logger = createModuleLogger('dog');
let pendingClaim = null;

async function getDogInfo() {
  const payload = types.GetDogInfoRequest.encode(types.GetDogInfoRequest.create({})).finish();
  const { body } = await sendMsgAsync('gamepb.dogpb.DogService', 'GetDogInfo', payload);
  return types.GetDogInfoReply.decode(body);
}

// ---- 面板狗信息读取缓存（下游刷新不穿透腾讯上游） ----
// FarmPanel 60s 固定轮询 /api/dog/skill-gifts；无缓存时每次直发
// DogService.GetDogInfo（固定间隔机器指纹）。只供面板 RPC 使用；
// 领取礼包的 checkAndClaimDogSkillGifts 继续走无缓存新鲜读取。
// 语义与 interact.js 相同：60s 成功缓存 + 在途合并 + 60s 失败冷却。
const DOG_INFO_PANEL_CACHE_MS = 60 * 1000;
let panelDogInfoCache = null;
let panelDogInfoCacheAt = 0;
let panelDogInfoInFlight = null;
let panelDogInfoRetryAfter = 0;

async function getDogInfoForPanel() {
  const now = Date.now();
  if (panelDogInfoCache && now - panelDogInfoCacheAt < DOG_INFO_PANEL_CACHE_MS) {
    return panelDogInfoCache;
  }
  if (panelDogInfoInFlight) return panelDogInfoInFlight;
  if (now < panelDogInfoRetryAfter) {
    throw new Error('狗信息读取冷却中，请稍后再试');
  }
  const pending = (async () => {
    try {
      const reply = await getDogInfo();
      if (panelDogInfoInFlight === pending) {
        panelDogInfoCache = reply;
        panelDogInfoCacheAt = Date.now();
        panelDogInfoRetryAfter = 0;
      }
      return reply;
    } catch (err) {
      if (panelDogInfoInFlight === pending) {
        panelDogInfoRetryAfter = Date.now() + DOG_INFO_PANEL_CACHE_MS;
      }
      throw err;
    }
  })();
  panelDogInfoInFlight = pending;
  try {
    return await pending;
  } finally {
    if (panelDogInfoInFlight === pending) panelDogInfoInFlight = null;
  }
}

function invalidatePanelDogInfoCache() {
  panelDogInfoCache = null;
  panelDogInfoCacheAt = 0;
  panelDogInfoRetryAfter = 0;
  // 在途读取解除引用：其完成体检查 inFlight === pending 失败，不写回旧状态
  panelDogInfoInFlight = null;
}

async function claimSkillGifts() {
  const payload = types.ClaimSkillGiftsRequest.encode(types.ClaimSkillGiftsRequest.create({})).finish();
  const { body } = await sendMsgAsync('gamepb.dogpb.DogService', 'ClaimSkillGifts', payload);
  return types.ClaimSkillGiftsReply.decode(body);
}

function getPendingGiftCount(reply) {
  return Math.max(0, toNum(reply && (reply.pending_gift_count ?? reply.pendingGiftCount)));
}

async function checkAndClaimDogSkillGifts(pendingCountHint) {
  if (pendingClaim) return pendingClaim;

  const request = (async () => {
    try {
      const hintedCount = Math.max(0, toNum(pendingCountHint));
      const pendingCount = hintedCount > 0 ? hintedCount : getPendingGiftCount(await getDogInfo());
      if (pendingCount <= 0) return { claimed: 0, pending: 0, item: null };

      const reply = await claimSkillGifts();
      const item = reply && reply.item || null;
      const claimed = Math.max(0, toNum(reply && reply.claimed_count)) || Math.max(0, toNum(item && item.count));
      const itemId = toNum(item && item.id);
      const itemName = getItemById(itemId)?.name || (itemId > 0 ? `物品#${itemId}` : '同气连枝礼包');
      if (claimed > 0) logger.info(`拾取${itemName} x${claimed}`, { itemId, count: claimed });
      return { claimed, pending: Math.max(0, pendingCount - claimed), item };
    } catch (error) {
      logger.warn(`拾取同气连枝礼包失败: ${error?.message || error}`);
      return {
        claimed: 0,
        pending: Math.max(0, toNum(pendingCountHint)),
        item: null,
        error: String(error?.message || error)
      };
    }
  })();

  pendingClaim = request;
  try {
    return await request;
  } finally {
    if (pendingClaim === request) pendingClaim = null;
  }
}

module.exports = {
  DOG_SKILL_GIFT_ITEM_ID,
  getDogInfo,
  getDogInfoForPanel,
  invalidatePanelDogInfoCache,
  claimSkillGifts,
  getPendingGiftCount,
  checkAndClaimDogSkillGifts
};
