
// Persistent-session async operation tracking.
if (globalThis.process?.env?.FARM_SESSION_BUSINESS === '1') {
  // eslint-disable-next-line no-func-assign -- Preserve the hoisted function and its existing recursive callers.
  operateMilkTeaRequest = require('./business-state').wrapBusinessFunction('services/milk-tea-activity.js:operateMilkTeaRequest', operateMilkTeaRequest);
  // eslint-disable-next-line no-func-assign -- Preserve the hoisted function and its existing recursive callers.
  readBalances = require('./business-state').wrapBusinessFunction('services/milk-tea-activity.js:readBalances', readBalances);
  // eslint-disable-next-line no-func-assign -- Preserve the hoisted function and its existing recursive callers.
  getMilkTeaActivity = require('./business-state').wrapBusinessFunction('services/milk-tea-activity.js:getMilkTeaActivity', getMilkTeaActivity);
  // eslint-disable-next-line no-func-assign -- Preserve the hoisted function and its existing recursive callers.
  readMilkTeaOverview = require('./business-state').wrapBusinessFunction('services/milk-tea-activity.js:readMilkTeaOverview', readMilkTeaOverview);
  // eslint-disable-next-line no-func-assign -- Preserve the hoisted function and its existing recursive callers.
  readInitialGameplay = require('./business-state').wrapBusinessFunction('services/milk-tea-activity.js:readInitialGameplay', readInitialGameplay);
  // eslint-disable-next-line no-func-assign -- Preserve the hoisted function and its existing recursive callers.
  readMilkTeaQueryData = require('./business-state').wrapBusinessFunction('services/milk-tea-activity.js:readMilkTeaQueryData', readMilkTeaQueryData);
  // eslint-disable-next-line no-func-assign -- Preserve the hoisted function and its existing recursive callers.
  queryMilkTeaActivity = require('./business-state').wrapBusinessFunction('services/milk-tea-activity.js:queryMilkTeaActivity', queryMilkTeaActivity);
  // eslint-disable-next-line no-func-assign -- Preserve the hoisted function and its existing recursive callers.
  runManualMilkTeaAction = require('./business-state').wrapBusinessFunction('services/milk-tea-activity.js:runManualMilkTeaAction', runManualMilkTeaAction);
}
/**
 * 奶茶热销中（S4，2026110100 族）只读状态 + 面板手动操作服务
 *
 * 编码证据：公开血缘仓库固定提交的官方编码器重构（owner/repo/SHA 只存
 * core/data/client-config-evidence/sources.json），并与当前 ActivityService.List
 * 下发、官方公告正文交叉核对。evidence=official-encoder-reconstruction
 * （非自然成功请求样本）。用户明确要求的免费奖励自动领取复用同一资格校验，
 * 新增购种、已有班次处理和升级复用已审手动链，独立策略默认关闭；
 * 购种仅在保存目标、库存、保留量及日预算范围内执行，未知结果不重放。
 *
 * 安全边界（照 pet-diary-operate 的手动模式）：
 * - 每次操作前重读 List + 根 GetGroup
 *   做服务端前置校验（资格/费用/次数/时间），与官方客户端行为一致。
 * - 显式查询与手动操作共用每 Worker 单例租约：忙时拒绝不排队。
 * - 钻石（1004）与未知/无法证实的费用一律拒绝；费用必须与用户确认值逐项相等。
 * - 写请求发出后传输失败、回复不匹配、解码失败 = 结果未知，不自动重试。
 * - 不开放：基金付费解锁(75)、好友链接领取、订阅/引导标记。
 * - 首次分享(70)按官方空参数动作独立给分，不伪造外部分享完成结果，敏感Ark不解码。
 * - 时间边界：结算期（公告北京 2026-11-15 00:00 起，或已解码 settle_start_time）
 *   停止营业类操作与活动专属种子购买；最终截止（根 endTime）后停止新增读取与写入。
 */

const { toNum, toLong, log } = require('../utils/utils');
const Long = require('long');
const { sendMsgAsync, getWs } = require('../utils/network');
const { types, getRoot } = require('../utils/proto');
const CONFIG = require('../gameConfig/MilkTeaActivity.json');
const milkTeaPolicy = require('./milk-tea-auto-policy');
const { getItemById, getItemImageById, getGenericFallbackItemIds } = require('../config/gameConfig');

const MILK_TEA_ROOT_ACTIVITY_ID = 2026110100;
const MILK_TEA_MAIN_ACTIVITY_ID = 2026110101;
const MILK_TEA_SHOP_ACTIVITY_ID = 2026110102;
const MILK_TEA_FUND_ACTIVITY_ID = 2026110103;
const MILK_TEA_HAPPY_SHARE_ACTIVITY_ID = 2026110104;

const TICKET_ITEM_ID = toNum(CONFIG.currency.ticketItemId);
const BOOST_ITEM_ID = toNum(CONFIG.cashier.salesItemId);
const DIAMOND_ITEM_ID = toNum(CONFIG.currency.diamondItemId);

// 官方公告正文（北京 2026-11-15 00:00 = UTC 2026-11-14T16:00:00Z）：
// 仅在已确认奶茶根且解码 settle_start_time 缺失/无效时兜底。
const ANNOUNCED_SETTLE_START_AT = toNum(CONFIG.announceSettle.startAt);

// 命令字与选择器来自固定来源编码表（sources.json 已登记）
const OPERATIONS = {
  createShop: [MILK_TEA_MAIN_ACTIVITY_ID, 53, 'milk_tea_create_shop'],
  renameShop: [MILK_TEA_MAIN_ACTIVITY_ID, 54, 'milk_tea_rename_shop'],
  queryShop: [MILK_TEA_MAIN_ACTIVITY_ID, 55, 'milk_tea_get_shop'],
  queryHireList: [MILK_TEA_MAIN_ACTIVITY_ID, 56, 'milk_tea_get_hire_list'],
  hire: [MILK_TEA_MAIN_ACTIVITY_ID, 57, 'milk_tea_hire'],
  queryWorkshop: [MILK_TEA_MAIN_ACTIVITY_ID, 58, 'milk_tea_get_workshop'],
  claimCashier: [MILK_TEA_MAIN_ACTIVITY_ID, 59, 'milk_tea_claim_cashier'],
  boost: [MILK_TEA_MAIN_ACTIVITY_ID, 60, 'milk_tea_boost'],
  upgrade: [MILK_TEA_MAIN_ACTIVITY_ID, 61, 'milk_tea_upgrade'],
  craft: [MILK_TEA_MAIN_ACTIVITY_ID, 62, 'milk_tea_craft'],
  queryWorkPage: [MILK_TEA_MAIN_ACTIVITY_ID, 63, 'milk_tea_get_work_page'],
  claimWages: [MILK_TEA_MAIN_ACTIVITY_ID, 64, 'milk_tea_claim_wages'],
  interact: [MILK_TEA_MAIN_ACTIVITY_ID, 65, 'milk_tea_interact'],
  queryRank: [MILK_TEA_MAIN_ACTIVITY_ID, 66, 'milk_tea_get_rank'],
  querySalesLog: [MILK_TEA_MAIN_ACTIVITY_ID, 67, 'milk_tea_get_sales_log'],
  hireSetting: [MILK_TEA_MAIN_ACTIVITY_ID, 68, 'milk_tea_set_hire_disable'],
  exchange: [MILK_TEA_SHOP_ACTIVITY_ID, 1, 'shop_buy'],
  fundClaim: [MILK_TEA_FUND_ACTIVITY_ID, 76, '', 'growth_fund_claim'],
  shareFirst: [MILK_TEA_HAPPY_SHARE_ACTIVITY_ID, 70, 'share_reward_share'],
  shareMilestones: [MILK_TEA_HAPPY_SHARE_ACTIVITY_ID, 71, 'share_reward_claim_milestones'],
  shareDaily: [MILK_TEA_HAPPY_SHARE_ACTIVITY_ID, 74, 'share_reward_claim_daily'],
};

// 显式查询白名单（仅读取类 Operate；面板用户点击才触发，不自动轮询/翻页）
const QUERY_KINDS = {
  shop: 'queryShop',
  hireList: 'queryHireList',
  workshop: 'queryWorkshop',
  work: 'queryWorkPage',
  rank: 'queryRank',
  sales: 'querySalesLog',
};

// 各查询的参数键白名单：额外字段一律拒绝（不透传、不进缓存键语义）
const QUERY_PARAM_KEYS = {
  shop: [],
  hireList: ['durationId'],
  workshop: [],
  work: [],
  rank: ['page'],
  sales: ['day'],
};

// 手动写白名单（两级写操作策略第①级）
const MANUAL_ACTIONS = new Set([
  'createShop', 'renameShop', 'hire', 'claimCashier', 'boost', 'upgrade', 'craft',
  'claimWages', 'interact', 'hireSetting', 'exchange', 'fundClaim', 'shareDaily', 'shareFirst', 'shareMilestones',
]);

// 结算期必须停止的营业类动作（公告注意事项第 2 条）；领取/工资/基金/快乐值/非种子兑换保留
const SETTLE_BLOCKED_ACTIONS = new Set([
  'createShop', 'renameShop', 'hire', 'boost', 'upgrade', 'craft', 'interact', 'hireSetting',
]);

function businessError(code, message) {
  const err = new Error(message);
  err.code = code;
  err.business = true;
  return err;
}

function fail(code, message) { throw businessError(code, message); }

function str64(value) { return String(value == null ? '' : value); }
function num64(value) { return Number(value) || 0; }
function inputNumber(value) { return (typeof value === 'number' || (typeof value === 'string' && /^\d+$/.test(value))) ? Number(value) : Number.NaN; }
function list(value) { return Array.isArray(value) ? value : []; }
function trimTo(value, max) { return String(value == null ? '' : value).trim().slice(0, max); }

function coreItemDto(raw) {
  if (!raw) return null;
  return { id: num64(raw.id), count: str64(raw.count) };
}

function itemsDto(value, max = 30) {
  return list(value).filter(Boolean).map(coreItemDto).filter(Boolean).slice(0, max);
}

// ---------- 纯标准化（供 activity.js 在根快照处就地消费原始回包） ----------

/** 解码奶茶根 GetGroup 原始回包，按子节点身份返回 { main, shop, fund, happyShare, settleStartTime }。 */
function decodeMilkTeaGroup(rawBody) {
  if (!rawBody || !types.MilkTeaGetGroupReply) return null;
  const reply = types.MilkTeaGetGroupReply.decode(Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody));
  const group = reply.group;
  if (!group || num64(group.head && group.head.activity_id) !== MILK_TEA_ROOT_ACTIVITY_ID) return null;
  const byId = new Map();
  for (const child of list(group.children)) {
    const id = num64(child && child.head && child.head.activity_id);
    if (id > 0) byId.set(id, child);
  }
  return {
    main: byId.get(MILK_TEA_MAIN_ACTIVITY_ID) || null,
    shop: byId.get(MILK_TEA_SHOP_ACTIVITY_ID) || null,
    fund: byId.get(MILK_TEA_FUND_ACTIVITY_ID) || null,
    happyShare: byId.get(MILK_TEA_HAPPY_SHARE_ACTIVITY_ID) || null,
    settleStartTime: num64(group.head && group.head.settle_start_time),
  };
}

function milkTeaSummaryDto(body, trustedDecode = false) {
  const summary = body && body.milk_tea && body.milk_tea.summary;
  if (!summary) return null;
  // 有效开店锚点（已开业且等级已知 ≥1）下，canonical Type 的省略
  // has_unclaimed_wage 才允许按「已确认没有未领工资」处理。
  const canonicalWageDefault = trustedDecode && isCanonicalMessage(summary, CANONICAL_TYPE_NAMES.summary)
    && num64(summary.shop_open_at) > 0 && validInteger(num64(summary.level), 1);
  return {
    shopOpenAt: num64(summary.shop_open_at),
    shopName: trimTo(summary.shop_name, 40),
    renameCdUntilAt: num64(summary.rename_cd_until_at),
    level: num64(summary.level),
    totalRevenue: num64(summary.total_revenue),
    hireDisabled: summary.hire_disabled === true,
    cashierFull: summary.cashier_full === true,
    cashierWarning: summary.cashier_warning === true,
    canUpgrade: summary.can_upgrade === true,
    openingGiftPreview: itemsDto(summary.opening_gift_preview, 10),
    hasWorkerShift: summary.has_worker_shift === true,
    hasUnclaimedWage: summary.has_unclaimed_wage === true,
    // 缺省 bool 会被上面的 ===true 折成 false；工资 latch 只认「明确 false」释放，
    // 用已知标志区分「字段未下发」与「明确没有未领工资」。
    // canonical 缺省例外见上方注释：正规编码省略 false 与显式 false 同义。
    hasUnclaimedWageKnown: (Object.prototype.hasOwnProperty.call(summary, 'has_unclaimed_wage') && typeof summary.has_unclaimed_wage === 'boolean')
      || (canonicalWageDefault && !Object.prototype.hasOwnProperty.call(summary, 'has_unclaimed_wage')),
    nextCupAt: num64(summary.next_cup_at),
  };
}

function condHintDto(hint) {
  if (!hint) return null;
  return {
    condType: trimTo(hint.cond_type, 40),
    params: trimTo(hint.params, 80),
    satisfied: hint.satisfied === true,
    current: num64(hint.current),
    target: num64(hint.target),
  };
}

// ---------- canonical proto3 缺省标量识别（已证省略默认值白名单） ----------
//
// 服务端正规 proto3 编码器对 0/false 标量不上电线：在显式 presence 下，
// 「正规 Type 解码后字段缺失」与「明确默认值」同义。仅当消息确由当前已加载
// proto 根 lookupType 得到的真实 Type 身份解码、调用方已校验根/子节点身份、
// 且满足对应业务锚点时，才把省略标量当作已确认默认值（本活动已证字段：
// Goods.purchased_count/purchase_limit=0、开店 Summary.has_unclaimed_wage=false、
// WorkPage.interact_done=false/MyShift.interact_count=0）。
// plain/fallback 缺字段、空 typed、畸形负值、缺业务锚点一律保持未知零写；
// 不得只凭 .$type 属性（可伪造），身份一律比较真实构造器。
const CANONICAL_TYPE_NAMES = {
  summary: 'gamepb.milkteapb.MilkTeaActivitySummary',
  goods: 'gamepb.milkteapb.MilkTeaGoodsInfo',
  work: 'gamepb.milkteapb.MilkTeaGetWorkPageRsp',
};
function canonicalCtor(name) {
  let ctor = null;
  try {
    const root = typeof getRoot === 'function' ? getRoot() : null;
    ctor = root?.lookupType(name)?.ctor || null;
  } catch { ctor = null; }
  return ctor;
}
function isCanonicalMessage(message, name) {
  const ctor = canonicalCtor(name);
  return !!ctor && !!message && typeof message === 'object' && Object.getPrototypeOf(message) === ctor.prototype;
}
function nonNegativeKnown(message, key) {
  const value = message ? message[key] : undefined;
  return value != null && typeof value !== 'boolean' && /^(?:0|[1-9]\d*)$/.test(String(value))
    && Number.isSafeInteger(Number(value)) && Number(value) >= 0;
}

function growthFundDto(body) {
  const fund = body && body.growth_fund;
  if (!fund) return null;
  return {
    unlocked: fund.unlocked === true,
    automaticClaimDataComplete: list(fund.tiers).length <= 40 && list(fund.tiers).every(tier => tier && num64(tier.tier_id) > 0
      && list(tier.conditions).length > 0 && list(tier.conditions).length <= 20 && list(tier.reward).length <= 20),
    unlockCost: itemsDto(fund.unlock_cost, 10),
    tiers: list(fund.tiers).filter(Boolean).slice(0, 40).map(tier => ({
      tierId: num64(tier.tier_id),
      state: num64(tier.state),
      conditions: list(tier.conditions).filter(Boolean).slice(0, 20).map(cond => ({
        type: trimTo(cond.type, 40),
        currentValue: num64(cond.current_value),
        targetValue: num64(cond.target_value),
        reached: cond.reached === true,
      })),
      reward: itemsDto(tier.reward, 20),
    })),
  };
}

/** 商城富解码（102 体）：真实限购/已购/多条目费用/条件提示，替代通用兜底解析。 */
function exchangeShopRichDto(body, trustedDecode = false) {
  const shop = body && body.shop;
  if (!shop) return null;
  return {
    items: list(shop.goods).filter(Boolean).slice(0, 80).map(goods => {
      const rewards = itemsDto(goods.item, 10);
      const costs = itemsDto(goods.cost, 10);
      const condHints = list(goods.cond_hints).filter(Boolean).slice(0, 12).map(condHintDto).filter(Boolean);
      const complete = rewards.length === list(goods.item).length
        && costs.length === list(goods.cost).length && condHints.length === list(goods.cond_hints).length;
      // Goods 锚点：正商品 ID + 完整且非空的奖励/费用。满足时 canonical Type 的
      // 省略限购/已购按已确认 0 处理（正规 proto3 编码 0 不上电线）。
      const canonicalGoodsDefault = trustedDecode && isCanonicalMessage(goods, CANONICAL_TYPE_NAMES.goods)
        && num64(goods.id) > 0 && complete && rewards.length > 0 && costs.length > 0;
      return {
        id: num64(goods.id),
        name: trimTo(goods.name, 60),
        desc: trimTo(goods.desc, 200),
        order: num64(goods.order),
        rewards,
        costs,
        purchaseLimit: num64(goods.purchase_limit),
        // 限购/已购字段是否真实下发（protobuf 原型默认值不能证明下发）：
        // 自动购种不允许把缺省 0 冒充「已确认未限购/已确认 0 已购」。
        // 例外：canonical Type 身份 + 业务锚点下，省略默认值与显式 0 同义；
        // 显式畸形/负值仍然未知，不放行。
        purchaseLimitKnown: (Object.prototype.hasOwnProperty.call(goods, 'purchase_limit') && nonNegativeKnown(goods, 'purchase_limit'))
          || (canonicalGoodsDefault && !Object.prototype.hasOwnProperty.call(goods, 'purchase_limit')),
        purchasedCountKnown: (Object.prototype.hasOwnProperty.call(goods, 'purchased_count') && nonNegativeKnown(goods, 'purchased_count'))
          || (canonicalGoodsDefault && !Object.prototype.hasOwnProperty.call(goods, 'purchased_count')),
        purchasedCount: num64(goods.purchased_count),
        diamondCostCount: num64(goods.diamond_cost_count),
        condHints,
        // Display bounds must never hide a cost, reward or condition from the
        // automatic authorization check. This is local metadata, not a wire field.
        automaticPurchaseDataComplete: complete,
      };
    }),
  };
}

/**
 * 纯函数：把奶茶专属解码结果合并进已规范化的根快照（无网络、无原始字节外泄）。
 * activity.js 的 getActivityGroupSnapshot 仅对奶茶根调用；解码失败保持通用兜底。
 */
function attachMilkTeaDiscoveryDetails(snapshot, rawBody) {
  const decoded = decodeMilkTeaGroup(rawBody);
  if (!decoded || toNum(snapshot?.id) !== MILK_TEA_ROOT_ACTIVITY_ID) return snapshot;
  const settleStartTime = decoded.settleStartTime;
  if (settleStartTime > 0) {
    snapshot.milkTeaTiming = { settleStartTime };
  }
  for (const child of Array.isArray(snapshot.children) ? snapshot.children : []) {
    if (toNum(child?.id) === MILK_TEA_MAIN_ACTIVITY_ID) {
      // 本函数入口已校验根/子节点身份（canonical 解码可信来源）
      const summary = milkTeaSummaryDto(decoded.main, true);
      if (summary) child.details = { ...(child.details || {}), milkTea: summary };
    }
    else if (toNum(child?.id) === MILK_TEA_SHOP_ACTIVITY_ID) {
      const rich = exchangeShopRichDto(decoded.shop, true);
      if (rich) child.details = { ...(child.details || {}), exchangeShop: rich };
    }
    else if (toNum(child?.id) === MILK_TEA_FUND_ACTIVITY_ID) {
      const fund = growthFundDto(decoded.fund);
      if (fund) child.details = { ...(child.details || {}), growthFund: fund };
    }
  }
  return snapshot;
}

// ---------- 时间边界 ----------

/**
 * 时间边界（每个 await 之后都应用「当前 now」重新计算）：
 * - ended：now >= endTime（最终截止取闭边界）；endTime 未知（0）不判结束。
 * - beforeStart：startTime 已知且尚未到营业开始。
 * - settle：已到结算期（解码 settle_start_time 优先，缺省用官方公告兜底）。
 */
function timingOf(snapshot, now) {
  const startTime = toNum(snapshot?.startTime);
  const endTime = toNum(snapshot?.endTime);
  const decodedSettle = toNum(snapshot?.milkTeaTiming?.settleStartTime);
  const settleStartTime = decodedSettle > 0 && decodedSettle < endTime
    ? decodedSettle
    : ANNOUNCED_SETTLE_START_AT;
  let phase = 'open';
  if (endTime > 0 && now >= endTime) phase = 'ended';
  else if (startTime > 0 && now < startTime) phase = 'beforeStart';
  else if (now >= settleStartTime) phase = 'settle';
  return {
    startTime,
    endTime,
    settleStartTime,
    settleSource: decodedSettle > 0 && decodedSettle < endTime ? 'decoded' : 'announce',
    phase,
  };
}

function assertActionPhase(action, timing, _now) {
  if (timing.phase === 'ended') {
    fail('SEASON_WISH_MILK_TEA_ENDED', `奶茶热销中已过最终截止时间，停止该操作`);
  }
  if (timing.phase === 'beforeStart') {
    fail('SEASON_WISH_MILK_TEA_NOT_STARTED', '奶茶热销中尚未开始，暂不能操作');
  }
  if (timing.phase === 'settle' && SETTLE_BLOCKED_ACTIONS.has(action)) {
    fail('SEASON_WISH_MILK_TEA_SETTLING', '奶茶热销中已进入结算期，营业类操作已停止（收益/工资/奖励领取不受影响）');
  }
  // 兑换不做笼统结算期拦截：是否活动种子以实际商品奖励名单为准（见 exchange 分支）
}

// ---------- 根存在校验与结束证据（三入口共用） ----------

/** 当前 List 根节点：仅以「是否下发该根」为在架判据；enabled=false 仍可读。 */
function findMilkTeaRootNode(activities) {
  return (activities || []).find(
    node => toNum(node?.id) === MILK_TEA_ROOT_ACTIVITY_ID && toNum(node?.parentId) === 0,
  ) || null;
}

// 消息保持「未由当前 ActivityService.List 下发」固定短语：
// GET 路由的 sendActivityUnavailable 靠它区分下架与普通失败。
function assertMilkTeaRootListed(activities, purpose) {
  if (!findMilkTeaRootNode(activities)) {
    fail('SEASON_WISH_MILK_TEA_UNAVAILABLE', `奶茶热销中未由当前 ActivityService.List 下发，停止${purpose}`);
  }
}

// 最终截止结束证据（每 Worker 单例，Worker 重建自然销毁）：
// 保留最近一次「成功读取」到的最终截止与快照；已确认结束、或（未来）截止时刻
// 已过时，本 Worker 生命周期内三入口零新增 List/GetGroup/库存/Operate。
// 读取失败不触碰本证据（失败不抹截止）。
let endedEvidence = null;

function recordEndedEvidence(timing, overview) {
  const endTime = toNum(timing && timing.endTime);
  if (endTime <= 0) return;
  // 同一截止已带有成功快照时，不因无快照的读取（查询/操作路径）抹掉它
  if (endedEvidence
    && toNum(endedEvidence.endTime) === endTime
    && endedEvidence.overview
    && !overview) {
    return;
  }
  endedEvidence = { endTime, overview };
}

/** 证据是否已生效：快照确认已结束，或（未来）截止时刻已被当前时钟越过。 */
function endedEvidenceActive(now) {
  if (!endedEvidence) return false;
  const recordedPhase = endedEvidence.overview && endedEvidence.overview.timing
    && endedEvidence.overview.timing.phase;
  if (recordedPhase === 'ended') return true;
  return now >= endedEvidence.endTime;
}

// ---------- 租约与连接所有权 ----------

// 每 Worker 单例（Worker 重建自然销毁；不落盘、不新增全局账号表）
let actionLeaseOwner = null;

function acquireLease() {
  if (actionLeaseOwner) return null;
  actionLeaseOwner = Symbol('milk-tea-action');
  return actionLeaseOwner;
}

function releaseLease(token) {
  if (token && actionLeaseOwner === token) actionLeaseOwner = null;
}

function currentConnection(deps) {
  if (deps && typeof deps.getConnection === 'function') return deps.getConnection();
  return typeof getWs === 'function' ? getWs() : null;
}

/** 入口捕获连接对象：之后每个 await 都用它复查所有权（连接重建/未就绪即停）。 */
function captureConnectionContext(deps) {
  return { ws: currentConnection(deps), account: String(process.env.FARM_ACCOUNT_ID || '') };
}

function assertConnectionOwned(deps, context) {
  if (currentConnection(deps) !== context.ws || String(process.env.FARM_ACCOUNT_ID || '') !== context.account) {
    fail('SEASON_WISH_MILK_TEA_CONNECTION_CHANGED', '连接已更换，停止本次奶茶操作（请重新发起）');
  }
  if (deps && typeof deps.isReady === 'function' && deps.isReady() !== true) {
    fail('SEASON_WISH_MILK_TEA_NOT_READY', '账号未就绪，停止本次奶茶操作');
  }
}

// ---------- 阶段标记（2026-10-30 跨 Worker 预算拒绝定位） ----------
// 只在真实请求点给错误附着有限 stage（list=ActivityService.List /
// group=根 GetGroup / precondition=前置读与读 Operate / write=经济写 Operate），
// 供 worker 元数据收集与路由层 429 分类使用。读 Operate 一律 precondition，
// 绝不标 write；本地结构化阶段不携带任何请求参数。
const MILK_TEA_STAGES = new Set(['list', 'group', 'precondition', 'write']);

async function withMilkTeaStage(stage, run) {
  try {
    return await run();
  }
  catch (err) {
    try { if (err && typeof err === 'object' && MILK_TEA_STAGES.has(stage)) err.milkTeaStage = stage; } catch { /* stage is diagnostic only */ }
    throw err;
  }
}

// ---------- 低层收发 ----------

/**
 * 发送一次奶茶 Operate。context.ws 为入口捕获的连接对象；发包前复查所有权与就绪。
 * 读路径（查询）失败按普通错误抛出；写路径由调用方归类为「结果未知」。
 */
async function operateMilkTeaRequest(operation, params, deps, context) {
  const [targetId, command, selector] = operation;
  // 预发送段（连接校验/编码）内抛出的错误是结构上可证的「从未交给传输层」本地拒绝；
  // 打上 preSend 标志，写前声明可据此安全释放。传输 await 之后的任何失败不带此标志。
  let request;
  try {
    assertConnectionOwned(deps, context);
    deps.assertAutomaticAllowed?.();
    const payload = { activity_id: toLong(targetId), operate_type: command };
    if (selector) payload[selector] = params || {};
    request = types.MilkTeaOperateRequest.encode(
      types.MilkTeaOperateRequest.create(payload),
    ).finish();
  }
  catch (err) {
    if (err && typeof err === 'object') err.preSend = true;
    throw err;
  }
  const { body } = await sendMsgAsync('gamepb.activitypb.ActivityService', 'Operate', request);
  assertConnectionOwned(deps, context);
  const reply = types.MilkTeaOperateReply.decode(body);
  if (num64(reply.activity_id) !== targetId || num64(reply.operate_type) !== command) {
    // 读路径普通错误（不标 business）：面板展示为普通失败；写路径由调用方归为结果未知
    const err = new Error('奶茶活动响应不匹配，请刷新后核对结果');
    err.code = 'SEASON_WISH_MILK_TEA_REPLY_MISMATCH';
    throw err;
  }
  return reply;
}

/** 背包余额表（itemId -> BigInt string）。 */
async function readBalances(deps) {
  const result = new Map();
  if (typeof deps.getBag !== 'function' || typeof deps.getBagItems !== 'function') {
    return { balances: result, available: false };
  }
  const bag = await withMilkTeaStage('precondition', () => deps.getBag());
  for (const item of deps.getBagItems(bag) || []) {
    const id = String(num64(item && item.id));
    const count = milkTeaPolicy.parseExactCount(str64(item?.count));
    if (count === null) fail('SEASON_WISH_MILK_TEA_NO_STATE', '背包数量未确认');
    result.set(id, (BigInt(result.get(id) || '0') + BigInt(count)).toString());
  }
  return { balances: result, available: true };
}

function balanceOf(balances, itemId) {
  return BigInt(balances.get(String(itemId)) || '0');
}

function costTotals(costs, count = 1) {
  const totals = new Map();
  for (const cost of costs) {
    const id = num64(cost.id);
    const each = BigInt(str64(cost.count) || '0');
    if (id <= 0 || each <= 0n) return null; // 未知费用条目：无法证实，拒绝
    totals.set(id, (totals.get(id) || 0n) + each * BigInt(count));
  }
  return totals;
}

function confirmedCostsMatch(confirmed, totals) {
  const rows = Array.isArray(confirmed) ? confirmed : [];
  if (rows.length !== totals.size) return false;
  const seen = new Map(totals);
  for (const row of rows) {
    const id = num64(row && row.itemId);
    const count = BigInt(str64(row && row.count) || '-1');
    if (!seen.has(id) || seen.get(id) !== count) return false;
    seen.delete(id);
  }
  return seen.size === 0;
}

function shopNameValid(name) {
  const trimmed = String(name == null ? '' : name).trim();
  const min = toNum(CONFIG.shopName.minLength) || 2;
  const max = toNum(CONFIG.shopName.maxLength) || 8;
  if (typeof name !== 'string' || trimmed.length < min || trimmed.length > max) {
    fail('SEASON_WISH_MILK_TEA_INVALID_NAME', `店名长度需在 ${min}-${max} 个字符之间`);
  }
  return trimmed;
}

// ---------- 默认只读入口（List 确认根下发后读一次根 + 一次库存） ----------

/** Snapshot-only bounds. The existing write entry still refreshes and verifies every cost/limit. */
function getMilkTeaExchangeBounds(goods, inventory, timing = {}) {
  const bounds = { requestMax: 999, limitKnown: false, hasPurchaseLimit: false,
    remainingLimit: null, affordableCount: null, maxCount: null, blockReason: '', unitCosts: [] };
  const integer = value => {
    if (!['number', 'string'].includes(typeof value) || String(value).trim() === '') return null;
    const n = Number(value);
    return Number.isSafeInteger(n) && n >= 0 ? n : null;
  };
  const limit = integer(goods.purchaseLimit);
  const purchased = integer(goods.purchasedCount);
  bounds.limitKnown = limit !== null && (limit === 0 || purchased !== null);
  bounds.hasPurchaseLimit = limit !== null && limit > 0;
  if (bounds.hasPurchaseLimit && purchased !== null) bounds.remainingLimit = Math.max(0, limit - purchased);
  const block = reason => ({ ...bounds, maxCount: 0, blockReason: reason });
  if (toNum(goods.diamondCostCount) > 0 || (goods.costs || []).some(cost => toNum(cost.id) === DIAMOND_ITEM_ID)) return block('该商品涉及钻石，暂不支持兑换');
  if ((goods.condHints || []).some(hint => hint.satisfied === false)) return block('尚未满足兑换条件');
  if (timing.phase === 'settle' && (goods.rewards || []).some(item => (CONFIG.activitySeedItemIds || []).includes(toNum(item.id)))) return block('结算期已停止种子兑换');
  if (bounds.remainingLimit === 0) return block('已达限购上限');
  let totals;
  try { totals = costTotals(goods.costs || []); } catch { totals = null; }
  if (!totals || totals.size === 0 || [...totals.keys()].some(id => !getItemById(id))) return block('兑换费用尚未确认');
  bounds.unitCosts = [...totals].map(([id, count]) => ({ itemId: id, count: count.toString(), name: getItemById(id)?.name || '活动货币' }));
  if (!bounds.limitKnown) return { ...bounds, blockReason: '限购信息尚未确认，请刷新' };
  if (inventory.available !== true || !(inventory.counts instanceof Map)) return { ...bounds, blockReason: '库存尚未确认，请刷新' };
  let affordable = 999n;
  for (const [id, amount] of totals) {
    const raw = inventory.counts.get(id) ?? 0;
    if ((typeof raw === 'number' && !Number.isSafeInteger(raw)) || !/^\d+$/.test(String(raw))) return { ...bounds, blockReason: '余额暂不能精确计算，请刷新' };
    const count = BigInt(String(raw)) / amount;
    if (count < affordable) affordable = count;
  }
  bounds.affordableCount = Number(affordable);
  bounds.maxCount = Math.min(bounds.requestMax, bounds.affordableCount, bounds.remainingLimit ?? bounds.requestMax);
  if (bounds.maxCount === 0) bounds.blockReason = '余额不足，暂不可兑换';
  return bounds;
}

/** 面板只读自动化状态：开关 + 未决计数，无 journal 身份；读失败返回 null 不阻塞首屏。 */
function readAutomationStatusForOverview() {
  try {
    const auto = require('../models/store').getAutomation();
    return {
      rewardsEnabled: auto.milk_tea_auto_rewards === true,
      seedsEnabled: auto.milk_tea_auto_seeds === true,
      workEnabled: auto.milk_tea_auto_work === true,
      upgradeEnabled: auto.milk_tea_auto_upgrade === true,
      craftEnabled: auto.milk_tea_auto_craft === true,
      hireEnabled: auto.milk_tea_auto_hire === true,
      openEnabled: auto.milk_tea_auto_open === true,
      boostEnabled: auto.milk_tea_auto_boost === true,
      hirePolicy: milkTeaPolicy.cloneHirePolicy(auto.milk_tea_hire_policy),
      ...actionStateSummary(),
    };
  }
  catch {
    return { unavailable: true };
  }
}

function buildMilkTeaOverview(snapshot, inventory, now) {
  const displayItems = rows => list(rows).map(item => {
    const id = toNum(item.id); const image = getItemImageById(id) || '';
    return { ...item, name: getItemById(id)?.name || '未知物品', image, iconStatus: !image ? 'missing' : getGenericFallbackItemIds().includes(id) ? 'generic' : 'mapped' };
  });
  const children = Array.isArray(snapshot?.children) ? snapshot.children : [];
  const findChild = id => children.find(node => toNum(node?.id) === id) || null;
  const main = findChild(MILK_TEA_MAIN_ACTIVITY_ID);
  const shop = findChild(MILK_TEA_SHOP_ACTIVITY_ID);
  const fund = findChild(MILK_TEA_FUND_ACTIVITY_ID);
  const happy = findChild(MILK_TEA_HAPPY_SHARE_ACTIVITY_ID);
  const timing = timingOf(snapshot, now);
  const counts = inventory.counts instanceof Map ? inventory.counts : new Map();
  const payloadEntries = Array.isArray(main?.payload?.tips?.txt) ? main.payload.tips.txt : [];
  return {
    activityId: MILK_TEA_ROOT_ACTIVITY_ID,
    mainActivityId: MILK_TEA_MAIN_ACTIVITY_ID,
    title: trimTo(snapshot?.title, 40) || '奶茶热销中',
    timing,
    rules: payloadEntries
      .filter(entry => typeof entry === 'string')
      .map(entry => entry.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]*>/g, '').trim())
      .filter(Boolean)
      .slice(0, 40),
    summary: main?.details?.milkTea || null,
    exchangeShop: shop?.details?.exchangeShop ? { items: list(shop.details.exchangeShop.items).map(goods => ({ ...goods, costs: displayItems(goods.costs), rewards: displayItems(goods.rewards), exchangeBounds: getMilkTeaExchangeBounds(goods, inventory, timing) })) } : null,
    growthFund: fund?.details?.growthFund ? { ...fund.details.growthFund, tiers: list(fund.details.growthFund.tiers).map(tier => ({ ...tier, reward: displayItems(tier.reward) })) } : null,
    shareReward: happy?.details?.shareReward ? { ...happy.details.shareReward, milestones: list(happy.details.shareReward.milestones).map(tier => ({ ...tier, rewards: list(tier.rewards).map(item => ({ ...item, itemName: getItemById(toNum(item.itemId))?.name || '未知物品', description: getItemById(toNum(item.itemId))?.desc || '' })) })) } : null,
    happyShareUpdate: {
      notice: '快乐不独享已新增奶茶券惊喜礼包档位。当前账号的档位和领取状态以服务端下发为准；礼包打开有机会获得奶茶兑换券或游戏道具，奶茶券奖池有限，每位农场主最多抽中一次。',
      gifts: [101616, 101617].map(id => ({ id, name: getItemById(id)?.name || '未知物品',
        description: getItemById(id)?.desc || '', image: getItemImageById(id) || '',
        platform: id === 101616 ? 'QQ' : '微信' })),
      giftTiersAvailable: list(happy?.details?.shareReward?.milestones).some(tier => list(tier.rewards).some(item => [101616, 101617].includes(toNum(item.itemId)))),
    },
    inventory: {
      available: inventory.available === true,
      ticketItemId: TICKET_ITEM_ID,
      boostItemId: BOOST_ITEM_ID,
      ticketCount: toNum(counts.get(TICKET_ITEM_ID)),
      boostItemCount: toNum(counts.get(BOOST_ITEM_ID)),
    },
    // 脱敏自动化状态（只含开关与未决计数，不含 journal 键/身份/时间戳）
    automationStatus: readAutomationStatusForOverview(),
  };
}

async function getMilkTeaActivity(options = {}) {
  if (options.includeGameplay !== true) return readMilkTeaOverview(options);
  const lease = acquireLease();
  if (!lease) fail('SEASON_WISH_MILK_TEA_BUSY', '奶茶查询/操作进行中，请稍后再试（不排队）');
  try { return await readMilkTeaOverview(options); }
  finally { releaseLease(lease); }
}

async function readMilkTeaOverview(options = {}) {
  // 时间一律取「当前」值：入口与每个 await 之后分别重算，不用 await 前的旧值
  const nowSec = () => (typeof options.now === 'function'
    ? Math.floor(options.now() / 1000)
    : Math.floor(Date.now() / 1000));
  // 最近一次成功读到的最终截止已过（或已确认结束）：零新增 List/GetGroup/库存，
  // 直接返回最后一次成功快照
  if (endedEvidenceActive(nowSec())) {
    if (endedEvidence.overview) return endedEvidence.overview;
    fail('SEASON_WISH_MILK_TEA_ENDED', '奶茶热销中已过最终截止时间，停止新增玩法读取');
  }
  // 顶层不反向依赖 activity.js（activity.js 顶层 require 本模块）：函数内延迟取得
  const activityService = require('./activity');
  const listReader = options.getActivityDiscoveryList || activityService.getActivityDiscoveryList;
  const snapshotReader = options.getActivityGroupSnapshot || activityService.getActivityGroupSnapshot;
  const inventoryReader = options.getBagItemCounts || activityService.getBagItemCounts;
  // 连接在首个 await 前入口捕获；此后每个 await 前后都复查所有权/就绪
  const context = captureConnectionContext(options.deps);
  const recheck = () => assertConnectionOwned(options.deps, context);
  recheck();

  // 缺根：仅这一次 List，零 GetGroup/库存/Operate 后续，也不重试
  const activities = await withMilkTeaStage('list', () => listReader());
  recheck();
  assertMilkTeaRootListed(activities, '读取活动详情');
  // List 根时间即拦截：未开始/已过最终截止时零根快照、零库存读取
  const rootTiming = timingOf(findMilkTeaRootNode(activities), nowSec());
  if (rootTiming.phase === 'ended') {
    recordEndedEvidence(rootTiming, null);
    fail('SEASON_WISH_MILK_TEA_ENDED', '奶茶热销中已过最终截止时间，停止新增玩法读取');
  }
  if (rootTiming.phase === 'beforeStart') {
    fail('SEASON_WISH_MILK_TEA_NOT_STARTED', '奶茶热销中尚未开始，停止新增玩法读取');
  }
  const snapshot = await withMilkTeaStage('group', () => snapshotReader(MILK_TEA_ROOT_ACTIVITY_ID, ''));
  recheck();
  if (toNum(snapshot?.id) !== MILK_TEA_ROOT_ACTIVITY_ID) {
    fail('SEASON_WISH_MILK_TEA_UNAVAILABLE', '奶茶活动组不匹配，停止读取');
  }
  let inventory = { counts: new Map(), available: false };
  // 读取过程中跨过最终截止：跳过库存等后续读取，用当前时间收口
  if (timingOf(snapshot, nowSec()).phase !== 'ended') {
    try {
      const catalog = list(snapshot.children).find(node => toNum(node?.id) === MILK_TEA_SHOP_ACTIVITY_ID)?.details?.exchangeShop;
      const costIds = list(catalog?.items).flatMap(goods => list(goods.costs).map(cost => toNum(cost.id)))
        .filter(id => id > 0 && id !== DIAMOND_ITEM_ID && !!getItemById(id));
      inventory = await withMilkTeaStage('precondition', () => inventoryReader([...new Set([TICKET_ITEM_ID, BOOST_ITEM_ID, ...costIds])]));
    } catch (err) { if (err && err.business) throw err; /* 库存失败仍展示活动说明与状态，数量保持未知，不循环重试 */ }
    recheck();
  }
  const overview = buildMilkTeaOverview(snapshot, inventory, nowSec());
  recordEndedEvidence(overview.timing, overview);
  if (options.includeGameplay === true && overview.timing.phase !== 'ended') {
    overview.gameplay = await readInitialGameplay(overview, snapshot, options.deps || {}, context, nowSec);
    overview.automationStatus = readAutomationStatusForOverview();
    overview.timing = timingOf(snapshot, nowSec());
    recordEndedEvidence(overview.timing, overview);
  }
  log('活动', '奶茶热销中只读状态刷新', {
    module: 'activity',
    event: 'milk_tea_activity_read',
    activityId: MILK_TEA_ROOT_ACTIVITY_ID,
    phase: overview.timing.phase,
    exchangeItemCount: overview.exchangeShop?.items?.length || 0,
    fundTierCount: overview.growthFund?.tiers?.length || 0,
    inventoryAvailable: overview.inventory.available,
  });
  return overview;
}

// The core first-page read is a single bounded batch, not an automatic action loop.
async function readInitialGameplay(overview, snapshot, deps, context, nowSec) {
  const names = { shop: '店铺', workshop: '工坊', work: '工作' };
  const result = {};
  const recheck = () => {
    assertConnectionOwned(deps, context);
    const phase = timingOf(snapshot, nowSec()).phase;
    if (phase === 'ended') fail('SEASON_WISH_MILK_TEA_ENDED', '奶茶活动已结束，停止后续状态读取');
    if (phase === 'beforeStart') fail('SEASON_WISH_MILK_TEA_NOT_STARTED', '奶茶活动尚未开始，停止后续状态读取');
  };
  for (const kind of ['shop', 'workshop', 'work']) {
    if (!overview.summary || !(overview.summary.shopOpenAt > 0)) {
      result[kind] = { available: false, data: null, error: overview.summary ? '' : '店铺摘要读取失败，请刷新重试',
        ...(overview.summary ? { state: 'not_open' } : {}) };
      continue;
    }
    recheck();
    try {
      const data = await readMilkTeaQueryData(kind, {}, snapshot, deps, context, recheck, nowSec);
      recheck();
      if (!data || typeof data !== 'object' || !Object.keys(data).length) throw new Error('empty_gameplay_reply');
      result[kind] = { available: true, data, error: '' };
    } catch (error) {
      recheck();
      if (error?.business === true) throw error;
      result[kind] = { available: false, data: null, error: `${names[kind]}状态读取失败，请刷新或点击查询重试` };
    }
  }
  return result;
}

async function readMilkTeaQueryData(kind, operateParams, snapshot, deps, context, recheck, nowSec) {
  const operation = OPERATIONS[QUERY_KINDS[kind]];
  // 读 Operate（显式查询/前置校验读取共用）：失败标 precondition，不算 write
  const reply = await withMilkTeaStage('precondition', () => operateMilkTeaRequest(operation, operateParams, deps, context));
  recheck(snapshot);
  const selector = operation[2];
  const rsp = selector ? reply[selector] : null;
  if (!rsp) {
    // 回包缺结果体：读路径普通错误（读无副作用，不标 business，不重试）
    const err = new Error('奶茶查询响应缺少预期结果');
    err.code = 'SEASON_WISH_MILK_TEA_REPLY_MISMATCH';
    throw err;
  }
  const summary = list(snapshot.children).find(row => num64(row.id) === MILK_TEA_MAIN_ACTIVITY_ID)?.details?.milkTea;
  // Existing natural page reads may reconcile local intents; never add an RPC
  // or turn a journal failure into a fake empty gameplay response.
  if (kind === 'shop' || kind === 'work') {
    try { reconcileActionState({ summary, shop: kind === 'shop' ? rsp.shop : undefined,
      work: kind === 'work' ? rsp : undefined, myShiftId: kind === 'work' ? rsp.my_shift?.shift_id : undefined, nowMs: nowSec() * 1000 }); }
    catch { automaticState.lastMessage = '动作记录暂无法对账，自动写保持暂停'; }
  }
  const data = kind === 'shop' ? shopViewDto(rsp.shop, nowSec())
    : kind === 'hireList' ? hireListDto(rsp, nowSec(), timingOf(snapshot, nowSec()))
      : kind === 'workshop' ? workshopDto(rsp)
        : kind === 'work' ? workPageDto(rsp)
          : kind === 'rank' ? rankDto(rsp)
            : salesLogDto(rsp);
  if (kind === 'workshop' && data && typeof deps.getBag === 'function' && typeof deps.getBagItems === 'function') {
    const bag = await withMilkTeaStage('precondition', () => deps.getBag());
    recheck(snapshot);
    try { reconcileActionState({ summary, bagItems: completeMilkBagItems(bag, deps), nowMs: nowSec() * 1000 }); }
    catch { automaticState.lastMessage = '材料记录暂无法对账，预留仍保留'; }
    const fruitIds = new Set(CONFIG.recipes.map(row => row.fruitItemId).filter(Boolean));
    data.fruits = list(deps.getBagItems(bag)).filter(item => fruitIds.has(num64(item.id))).slice(0, 100).map(item => ({
      uid: str64(item.uid), itemId: num64(item.id), name: getItemById(num64(item.id))?.name || '果实',
      count: str64(item.count), locked: item.locked === true || item.is_locked === true,
    }));
  }
  return data;
}

// ---------- 显式查询（shop/hireList/workshop/work/rank/sales；用户点击才发） ----------

function playerDto(player) {
  if (!player) return null;
  return {
    gid: str64(player.gid),
    name: trimTo(player.name, 40),
    level: num64(player.level),
  };
}

// slots is a sparse shift list, not the list of unlocked employee positions.
// The same interpretation is used by the read DTO and the fresh pre-hire check.
function shopSlotAvailability(view, now) {
  const level = CONFIG.storeLevels.find(row => row.level === num64(view?.level));
  const employeeSlotCount = level?.employeeSlotCount ?? null;
  const unknown = { employeeSlotCount, slotAvailabilityKnown: false, freeSlotIndexes: [] };
  if (!employeeSlotCount || !Array.isArray(view?.slots)) return unknown;
  const occupied = new Set();
  const seen = new Set();
  for (const slot of view.slots) {
    if (!slot) return unknown;
    const index = Number(slot.slot_index ?? 0);
    if (!Number.isInteger(index) || index < 0 || index >= employeeSlotCount || seen.has(index)) return unknown;
    seen.add(index);
    const endAt = Number(slot.end_at || 0);
    if (!Number.isFinite(endAt) || endAt < 0) return unknown;
    // A finished shift releases the position even when employee/robot fields remain.
    // Missing time with an actual employee/shift is kept occupied conservatively.
    const hasShift = slot.is_robot === true || num64(slot.shift_id) > 0
      || num64(slot.employee?.gid) > 0 || !!trimTo(slot.employee?.name, 40);
    if (endAt > now || (!endAt && hasShift)) occupied.add(index);
  }
  return {
    employeeSlotCount,
    slotAvailabilityKnown: true,
    freeSlotIndexes: Array.from({ length: employeeSlotCount }, (_, index) => index).filter(index => !occupied.has(index)),
  };
}

function shopViewDto(view, now) {
  if (!view) return null;
  return {
    level: num64(view.level),
    ...shopSlotAvailability(view, now),
    totalRevenue: num64(view.total_revenue),
    nextLevelRevenue: num64(view.next_level_revenue),
    cashierCapacitySec: num64(view.cashier_capacity_sec),
    cashierElapsedSec: num64(view.cashier_elapsed_sec),
    cashierFull: cashierState(view, now).full,
    cashierStateKnown: cashierState(view, now).known,
    cashierObservedAt: now,
    slots: list(view.slots).filter(Boolean).slice(0, 10).map(slot => ({
      slotIndex: num64(slot.slot_index),
      isRobot: slot.is_robot === true,
      shiftId: str64(slot.shift_id),
      beginAt: num64(slot.begin_at),
      endAt: num64(slot.end_at),
      cost: str64(slot.cost),
      talentId: num64(slot.talent_id),
      talentName: trimTo(slot.talent_name, 40),
      interactType: num64(slot.interact_type),
      employee: playerDto(slot.employee),
    })),
    drinkCups: Object.fromEntries([...mapEntries(view.drink_cups)].slice(0, 20).map(([k, v]) => [String(k), num64(v)])),
    nextFullAt: num64(view.next_full_at),
    salesItemId: num64(view.sales_item_id),
    salesDurationSec: num64(view.sales_duration_sec),
    isSettling: view.is_settling === true,
    pendingRewards: itemsDto(view.pending_rewards, 20),
    boostCupsPerUse: num64(view.boost_cups_per_use),
    effectiveCupsPerHour: num64(view.effective_cups_per_hour),
    secPerCup: num64(view.sec_per_cup),
  };
}

function mapEntries(value) {
  if (!value) return [];
  if (typeof value.entries === 'function') return [...value.entries()];
  // protobufjs 把 map<int64,*> 解码成普通对象：键是 int64 的 8 字节小端哈希串
  // （如配方号 2 → '\x02\x00\x00\x00\x00\x00\x00\x00'），需转回数字再进 DTO
  return Object.entries(value).map(([key, val]) => [longKeyFromHash(key), val]);
}

function longKeyFromHash(key) {
  if (/^-?\d+$/.test(key)) return Number(key);
  let value = 0n;
  for (let i = 0; i < 8; i += 1) {
    value |= BigInt(String(key).charCodeAt(i) || 0) << BigInt(8 * i);
  }
  if (value >= 1n << 63n) value -= 1n << 64n;
  return Number(value);
}

function hireCandidateEligible(entry, now) {
  const gid = str64(entry?.friend?.gid);
  const state = Number(entry?.state ?? 0);
  const until = Number(entry?.state_until_at ?? 0);
  const rehire = Number(entry?.rehire_available_at ?? 0);
  return /^[1-9]\d*$/.test(gid) && state === 0
    && Number.isSafeInteger(until) && until >= 0 && until <= now
    && Number.isSafeInteger(rehire) && rehire >= 0 && rehire <= now;
}

function cashierState(view, now) {
  const capacity = Number(view?.cashier_capacity_sec);
  const elapsed = Number(view?.cashier_elapsed_sec);
  const known = Number.isSafeInteger(capacity) && capacity > 0
    && Number.isSafeInteger(elapsed) && elapsed >= 0;
  const full = known && elapsed >= capacity;
  const forecast = Number(view?.next_full_at);
  return { known, full, nextCheckAt: !full && Number.isSafeInteger(forecast) && forecast > now ? forecast * 1000 : 0 };
}

function hireListDto(rsp, now, timing) {
  if (!rsp) return null;
  const friend = entry => ({
    gid: str64(entry && entry.friend && entry.friend.gid),
    name: trimTo(entry && entry.friend && entry.friend.name, 40),
    isRobot: !!(entry && entry.is_robot),
    talentId: num64(entry && entry.talent_id),
    talentName: trimTo(entry && entry.talent_name, 40),
    state: num64(entry && entry.state),
    stateUntilAt: num64(entry && entry.state_until_at),
    rehireAvailableAt: num64(entry && entry.rehire_available_at),
  });
  const seen = new Set();
  const eligible = entry => {
    if (!hireCandidateEligible(entry, now)) return false;
    const gid = str64(entry.friend.gid);
    if (seen.has(gid)) return false;
    seen.add(gid); return true;
  };
  const minimum = num64(rsp.min_remain_biz_sec);
  const windowOpen = !(minimum > 0) || timing.settleStartTime - now >= minimum;
  const friends = windowOpen ? list(rsp.friends).filter(eligible) : [];
  const robots = windowOpen ? list(rsp.robots).filter(eligible) : [];
  return {
    durationId: num64(rsp.duration_id),
    wageTotal: num64(rsp.wage_total),
    minRemainBizSec: num64(rsp.min_remain_biz_sec),
    friends: friends.slice(0, 80).map(friend),
    robots: robots.slice(0, 40).map(friend),
    unavailableCount: list(rsp.friends).length + list(rsp.robots).length - friends.length - robots.length,
    unavailableReason: windowOpen ? '' : '剩余营业时间不足本班最低要求，请选择其他班次',
  };
}

function workshopDto(rsp) {
  if (!rsp) return null;
  return {
    recipes: list(rsp.recipes).filter(Boolean).slice(0, 30).map(recipe => ({
      recipeId: num64(recipe.recipe_id),
      fruitItemId: toNum(CONFIG.recipes.find(row => row.recipeId === num64(recipe.recipe_id))?.fruitItemId),
      name: trimTo(recipe.recipe_name, 40),
      unlocked: recipe.unlocked === true,
      isAdvanced: recipe.is_advanced === true,
      stockCups: num64(recipe.stock_cups),
    })),
  };
}

function interactDto(interact) {
  if (!interact) return null;
  return {
    type: num64(interact.type),
    success: interact.success === true,
    interactionId: str64(interact.interaction_id),
    at: num64(interact.at),
  };
}

function workPageDto(rsp) {
  if (!rsp) return null;
  const shift = rsp.my_shift;
  return {
    myShift: shift ? {
      employer: playerDto(shift.employer),
      shopName: trimTo(shift.shop_name, 40),
      shiftId: str64(shift.shift_id),
      talentId: num64(shift.talent_id),
      talentName: trimTo(shift.talent_name, 40),
      beginAt: num64(shift.begin_at),
      endAt: num64(shift.end_at),
      settleStartAt: num64(shift.settle_start_at),
      interactCount: num64(shift.interact_count),
      interactLimit: num64(shift.interact_limit),
      wageTotal: num64(shift.wage_total),
      interact: interactDto(shift.interact),
      interactPreviews: list(shift.interact_previews).filter(Boolean).slice(0, 10).map(preview => ({
        interactionType: num64(preview.interaction_type),
        promoteCups: num64(preview.promote_cups),
      })),
    } : null,
    slips: list(rsp.slips).filter(Boolean).slice(0, 20).map(slip => ({
      employer: playerDto(slip.employer),
      shopName: trimTo(slip.shop_name, 40),
      shiftId: str64(slip.shift_id),
      beginAt: num64(slip.begin_at),
      endAt: num64(slip.end_at),
      workSec: num64(slip.work_sec),
      wageStatus: num64(slip.wage_status),
      truncated: slip.truncated === true,
      baseWage: num64(slip.wages && slip.wages.base_wage),
      finalWage: num64(slip.wages && slip.wages.final_wage),
    })),
    talentId: num64(rsp.talent_id),
    talentName: trimTo(rsp.talent_name, 40),
    interactDone: rsp.interact_done === true,
  };
}

function rankDto(rsp) {
  if (!rsp) return null;
  return {
    myRank: num64(rsp.my_rank),
    page: num64(rsp.page),
    hasMore: rsp.has_more === true,
    snapshotTime: num64(rsp.snapshot_time),
    ranks: list(rsp.ranks).filter(Boolean).slice(0, 50).map(item => ({
      owner: playerDto(item.owner),
      shopName: trimTo(item.shop_name, 40),
      level: num64(item.level),
      totalRevenue: num64(item.total_revenue),
      rank: num64(item.rank),
    })),
  };
}

function salesLogDto(rsp) {
  if (!rsp) return null;
  return {
    day: num64(rsp.day),
    token: num64(rsp.token),
    coin: num64(rsp.coin),
    cups: num64(rsp.cups),
    cupsByRecipe: Object.fromEntries([...mapEntries(rsp.cups_by_recipe)].slice(0, 20).map(([k, v]) => [String(k), num64(v)])),
    hires: list(rsp.hires).filter(Boolean).slice(0, 20).map(record => ({
      friend: playerDto(record.friend),
      hireAt: num64(record.hire_at),
      durationSec: num64(record.duration_sec),
      workSec: num64(record.work_sec),
      settled: record.settled === true,
      talentName: trimTo(record.talent_name, 40),
    })),
    items: itemsDto(rsp.items, 20),
  };
}

async function queryMilkTeaActivity(kind, params = {}, deps = {}) {
  if (!Object.prototype.hasOwnProperty.call(QUERY_KINDS, kind)) {
    fail('SEASON_WISH_MILK_TEA_UNKNOWN_QUERY', '未知奶茶查询类型');
  }
  // 参数键白名单：额外字段一律拒绝（不透传编码，也不进缓存键语义）
  const allowedKeys = QUERY_PARAM_KEYS[kind];
  for (const key of Object.keys(params && typeof params === 'object' ? params : {})) {
    if (!allowedKeys.includes(key)) {
      fail('SEASON_WISH_MILK_TEA_INVALID_INPUT', `查询参数不支持: ${key}`);
    }
  }
  const nowSec = () => (typeof deps.now === 'function'
    ? Math.floor(deps.now() / 1000)
    : Math.floor(Date.now() / 1000));
  if (endedEvidenceActive(nowSec())) {
    fail('SEASON_WISH_MILK_TEA_ENDED', '奶茶热销中已过最终截止时间，停止新增玩法读取');
  }
  const lease = acquireLease();
  if (!lease) fail('SEASON_WISH_MILK_TEA_BUSY', '奶茶查询/操作进行中，请稍后再试（不排队）');
  try {
    const activityService = require('./activity');
    const listReader = deps.getActivityDiscoveryList || activityService.getActivityDiscoveryList;
    const snapshotReader = deps.getActivityGroupSnapshot || activityService.getActivityGroupSnapshot;
    // 连接在首个 await 前入口捕获；此后每个 await 都复查所有权与就绪
    const context = captureConnectionContext(deps);
    const recheck = timingSource => {
      assertConnectionOwned(deps, context);
      if (timingSource) {
        const timing = timingOf(timingSource, nowSec());
        if (timing.phase === 'ended') fail('SEASON_WISH_MILK_TEA_ENDED', '奶茶热销中已过最终截止时间，停止新增玩法读取');
        if (timing.phase === 'beforeStart') fail('SEASON_WISH_MILK_TEA_NOT_STARTED', '奶茶热销中尚未开始，停止新增玩法读取');
      }
    };
    recheck();

    const activities = await withMilkTeaStage('list', () => listReader());
    const rootNode = findMilkTeaRootNode(activities);
    if (!rootNode) fail('SEASON_WISH_MILK_TEA_UNAVAILABLE', '奶茶热销中未由当前 ActivityService.List 下发，停止查询');
    recheck(rootNode);
    const snapshot = await withMilkTeaStage('group', () => snapshotReader(MILK_TEA_ROOT_ACTIVITY_ID, ''));
    if (toNum(snapshot?.id) !== MILK_TEA_ROOT_ACTIVITY_ID) {
      fail('SEASON_WISH_MILK_TEA_UNAVAILABLE', '奶茶活动组不匹配，停止查询');
    }
    // 成功读到的最终截止留作结束证据：到期后三入口零新增读取（失败不抹截止）
    recordEndedEvidence(timingOf(snapshot, nowSec()), null);
    recheck(snapshot);
    let operateParams = {};
    if (kind === 'hireList') {
      const durationId = inputNumber(params.durationId);
      const known = new Set((CONFIG.hireDurations || []).map(row => toNum(row.durationId)));
      if (!known.has(durationId)) {
        fail('SEASON_WISH_MILK_TEA_INVALID_INPUT', '雇佣时长无效（仅支持 4h/12h/24h 班次）');
      }
      operateParams = { duration_id: durationId };
    }
    else if (kind === 'rank') {
      const page = params.page == null ? 1 : inputNumber(params.page);
      if (!(Number.isInteger(page) && page >= 1 && page <= 1000)) {
        fail('SEASON_WISH_MILK_TEA_INVALID_INPUT', '排行页码无效');
      }
      operateParams = { page };
    }
    else if (kind === 'sales') {
      if (params.day != null) {
        const day = inputNumber(params.day);
        if (!(Number.isInteger(day) && day > 0 && day <= 4_000_000_000)) {
          fail('SEASON_WISH_MILK_TEA_INVALID_INPUT', '销量日志日期参数无效');
        }
        operateParams = { day };
      }
      // day 缺省：按服务端默认（今日）读取一次，不枚举、不翻页
    }
    const data = await readMilkTeaQueryData(kind, operateParams, snapshot, deps, context, recheck, nowSec);
    log('活动', '奶茶显式查询完成', {
      module: 'activity', event: 'milk_tea_query', kind, result: 'ok',
    });
    return { kind, data };
  } finally {
    releaseLease(lease);
  }
}

// ---------- 手动操作 ----------

function unknownOutcome(action, command, err) {
  return {
    action,
    outcome: 'unknown',
    ok: false,
    command,
    message: `${String(err?.message || err || '请求失败')}：结果未知（请求可能已执行），不自动重试，请刷新后核对`,
  };
}

function definitelyUnsent(err) {
  if (!err || typeof err !== 'object') return false;
  if (err.preSend === true) return true;
  // These two strict fields survive the host's real session codec. They are
  // emitted by the network budget gate before WS.send. Neither error text nor
  // business/timeout/session errors prove that a write was never transmitted.
  return err.isGovernedRejection === true
    && ['budget_total', 'budget_method'].includes(err.governedReason)
    && err.business !== true && err.isServerBusinessError !== true
    && err.serverErrorCode == null && err.unknown !== true && err.code == null;
}

function rewardRows(rows) {
  return itemsDto(rows, 30).map(item => ({ itemId: item.id, count: item.count, name: getItemById(item.id)?.name || '未知物品' }));
}

async function runManualMilkTeaAction(action, input = {}, deps = {}) {
  if (!MANUAL_ACTIONS.has(action)) {
    fail('SEASON_WISH_MILK_TEA_UNKNOWN_ACTION', '该奶茶操作未开放');
  }
  const nowSec = () => (typeof deps.now === 'function'
    ? Math.floor(deps.now() / 1000)
    : Math.floor(Date.now() / 1000));
  if (endedEvidenceActive(nowSec())) {
    fail('SEASON_WISH_MILK_TEA_ENDED', '奶茶热销中已过最终截止时间，停止该操作');
  }
  const lease = acquireLease();
  if (!lease) fail('SEASON_WISH_MILK_TEA_BUSY', '奶茶查询/操作进行中，请稍后再试（不排队）');
  let declared = null;
  let context;
  let rewardPrevious = null;
  try {
    const activityService = require('./activity');
    const listReader = deps.getActivityDiscoveryList || activityService.getActivityDiscoveryList;
    const snapshotReader = deps.getActivityGroupSnapshot || activityService.getActivityGroupSnapshot;
    // 连接在首个 await 前入口捕获；此后每个 await 都复查所有权/就绪，并按当前
    // 时间重核动作相位（读取途中跨入结算期/最终截止即停，零后续写）。
    context = captureConnectionContext(deps);
    let timingSource = null;
    let minimumHireRemainSec = 0;
    const recheck = () => {
      assertConnectionOwned(deps, context);
      deps.assertAutomaticAllowed?.();
      if (timingSource) assertActionPhase(action, timingOf(timingSource, nowSec()), nowSec());
      if (minimumHireRemainSec > 0 && timingOf(timingSource, nowSec()).settleStartTime - nowSec() < minimumHireRemainSec) fail('SEASON_WISH_MILK_TEA_CANDIDATE_CHANGED', '剩余营业时间不足本班最低要求，请重新查询并选择其他班次');
    };
    recheck();
    // 每次操作重读 List + 根状态（服务端前置校验，不用本地缓存资格）
    const activities = await withMilkTeaStage('list', () => listReader());
    const rootNode = findMilkTeaRootNode(activities);
    if (!rootNode) fail('SEASON_WISH_MILK_TEA_UNAVAILABLE', '奶茶热销中未由当前 ActivityService.List 下发，停止操作');
    timingSource = rootNode;
    recheck();
    const snapshot = await withMilkTeaStage('group', () => snapshotReader(MILK_TEA_ROOT_ACTIVITY_ID, ''));
    if (toNum(snapshot?.id) !== MILK_TEA_ROOT_ACTIVITY_ID) {
      fail('SEASON_WISH_MILK_TEA_UNAVAILABLE', '奶茶活动组不匹配，停止操作');
    }
    // 成功读到的最终截止留作结束证据：到期后三入口零新增读取（失败不抹截止）
    recordEndedEvidence(timingOf(snapshot, nowSec()), null);
    timingSource = snapshot;
    recheck();

    const children = Array.isArray(snapshot.children) ? snapshot.children : [];
    const findChild = id => children.find(node => toNum(node?.id) === id) || null;
    const summary = findChild(MILK_TEA_MAIN_ACTIVITY_ID)?.details?.milkTea || null;
    const exchangeShop = findChild(MILK_TEA_SHOP_ACTIVITY_ID)?.details?.exchangeShop || null;
    const growthFund = findChild(MILK_TEA_FUND_ACTIVITY_ID)?.details?.growthFund || null;
    const shareReward = findChild(MILK_TEA_HAPPY_SHARE_ACTIVITY_ID)?.details?.shareReward || null;
    if (['claimWages', 'interact', 'upgrade'].includes(action) || (action === 'exchange' && list(exchangeShop?.items).some(row => num64(row.id) === Number(input.goodsId) && list(row.rewards).some(item => CONFIG.activitySeedItemIds.includes(num64(item.id)))))) {
      reconcileActionState({ summary, goodsById: new Map(list(exchangeShop?.items).map(row => [num64(row.id), row])), nowMs: nowSec() * 1000 });
    }

    const send = async (operationName, params) => {
      const operation = OPERATIONS[operationName];
      const command = operation[1];
      try {
        // 经济写 Operate：失败标 write（业务/严格零发送拒绝原样透传由下方归类）
        const reply = await withMilkTeaStage('write', () => operateMilkTeaRequest(operation, params, deps, context));
        // 回复选择子可与请求选择子不同（如 cmd76 空参请求、176 回复字段）
        return { ok: true, reply, selector: operation[3] || operation[2], command };
      }
      catch (err) {
        // 写前的固定拒绝（连接/就绪/编码前校验，business）原样抛出；写请求已发出
        // 之后的传输失败/解码失败/回显不匹配 = 结果未知（可能已执行），不自动重试
        if (err && (err.business === true || definitelyUnsent(err))) throw err;
        throw Object.assign(new Error('奶茶操作结果未知'), { unknown: true, err });
      }
    };
    // 读侧 Operate（写前前置校验用的查询）也要在每个 await 后复查连接与相位；
    // 失败标 precondition（读 Operate 不算 write）
    const readOperate = async (operation, params) => {
      const reply = await withMilkTeaStage('precondition', () => operateMilkTeaRequest(operation, params, deps, context));
      recheck();
      return reply;
    };
    let operationName = action;
    let params = {};
    // 写前声明所需的活动上下文（upgrade/interact/exchange 分支就地填充）
    let preUpgradeLevel = 0;
    let interactShiftId = '';
    let exchangeDeclaration = null;
    const declarationExtra = {};

    if (action === 'createShop' || action === 'renameShop') {
      const name = shopNameValid(input.shopName);
      if (!summary) fail('SEASON_WISH_MILK_TEA_NO_STATE', '服务端未返回奶茶店铺状态');
      const opened = toNum(summary.shopOpenAt) > 0 || !!summary.shopName;
      if (action === 'createShop') {
        if (opened) fail('SEASON_WISH_MILK_TEA_ALREADY', '店铺已开业，请刷新状态');
      }
      else {
        if (!opened) fail('SEASON_WISH_MILK_TEA_INVALID_STATE', '店铺尚未开业，无法改名');
        if (toNum(summary.renameCdUntilAt) > nowSec()) fail('SEASON_WISH_MILK_TEA_LIMIT', '改名冷却中，请稍后再试');
      }
      params = { shop_name: name };
      declarationExtra.shopName = name;
      if (action === 'createShop') reconcileActionState({ summary, nowMs: nowSec() * 1000 });
    }
    else if (action === 'hire') {
      const durationId = inputNumber(input.durationId);
      const known = new Map((CONFIG.hireDurations || []).map(row => [toNum(row.durationId), row]));
      if (!known.has(durationId)) fail('SEASON_WISH_MILK_TEA_INVALID_INPUT', '雇佣时长无效（仅支持 4h/12h/24h 班次）');
      const wanted = list(input.hires).map(row => ({
        slotIndex: inputNumber(row && row.slotIndex),
        targetGid: str64(row && row.targetGid),
      })).filter(row => row.slotIndex >= 0 && row.targetGid !== '');
      if (wanted.length !== list(input.hires).length || new Set(wanted.map(row => row.slotIndex)).size !== wanted.length || new Set(wanted.map(row => row.targetGid)).size !== wanted.length) fail('SEASON_WISH_MILK_TEA_INVALID_INPUT', '雇佣槽位和成员需唯一且合法');
      if (!wanted.length) fail('SEASON_WISH_MILK_TEA_INVALID_INPUT', '雇佣目标无效');
      // 逐项核对本次候选与空槽：先读店铺视图与候选列表（有界两读）
      const shopReply = await readOperate(OPERATIONS.queryShop, {});
      const shopView = shopReply && shopReply.milk_tea_get_shop && shopReply.milk_tea_get_shop.shop;
      reconcileActionState({ summary, shop: shopView, nowMs: nowSec() * 1000 });
      const availability = shopSlotAvailability(shopView, nowSec());
      if (!availability.slotAvailabilityKnown) fail('SEASON_WISH_MILK_TEA_NO_STATE', '店铺槽位状态未确认，请刷新后重试');
      const freeSlots = new Set(availability.freeSlotIndexes);
      for (const row of wanted) {
        if (!freeSlots.has(row.slotIndex)) fail('SEASON_WISH_MILK_TEA_INVALID_STATE', `槽位 ${row.slotIndex} 不可用（未解锁或已占用）`);
      }
      // No candidate lookup for a slot already reserved by an unresolved write.
      if (wanted.some(row => Object.values(ensureActionState().hires || {}).some(old => old.slotIndex === row.slotIndex))) fail('SEASON_WISH_MILK_TEA_LIMIT', '槽位已有雇佣声明，等待新班次对账');
      if (deps.assertAutomaticAllowed) {
        const funding = await readBalances(deps); recheck();
        if (!funding.available || !hireBudgetAllows(requireAutoConfig(deps), funding.balances, wanted.length, nowSec() * 1000)) fail('SEASON_WISH_MILK_TEA_INSUFFICIENT', '雇佣预算或保留量不足');
      }
      const hireListReply = await readOperate(OPERATIONS.queryHireList, { duration_id: durationId });
      const hireList = hireListReply && hireListReply.milk_tea_get_hire_list;
      if (!hireList || toNum(hireList.duration_id) !== durationId) fail('SEASON_WISH_MILK_TEA_NO_STATE', '雇佣候选班次与当前选择不符');
      minimumHireRemainSec = num64(hireList.min_remain_biz_sec);
      recheck();
      const candidates = new Set([
        ...list(hireList && hireList.friends),
        ...list(hireList && hireList.robots),
      ].filter(entry => hireCandidateEligible(entry, nowSec())).map(entry => str64(entry.friend.gid)));
      for (const row of wanted) {
        if (!candidates.has(row.targetGid)) fail('SEASON_WISH_MILK_TEA_CANDIDATE_CHANGED', '员工当前不可雇佣，已失效旧候选，请重新查询后选择');
      }
      const duration = known.get(durationId);
      if (deps.assertAutomaticAllowed && (!nonNegativeKnown(hireList, 'wage_total')
        || num64(hireList.wage_total) !== num64(duration.cost.count))) fail('SEASON_WISH_MILK_TEA_COST_CHANGED', '当前班次费用未确认');
      const totalCost = [{ itemId: toNum(duration.cost.itemId), count: toNum(duration.cost.count) * wanted.length }];
      if (!confirmedCostsMatch(input.confirmedCosts, new Map(totalCost.map(c => [c.itemId, BigInt(c.count)])))) {
        fail('SEASON_WISH_MILK_TEA_COST_CHANGED', '费用与确认值不一致，请刷新后重新确认');
      }
      const { balances, available } = await readBalances(deps);
      recheck();
      if (!available || balanceOf(balances, totalCost[0].itemId) < BigInt(totalCost[0].count)) {
        fail('SEASON_WISH_MILK_TEA_INSUFFICIENT', '奶茶券不足，无法雇佣');
      }
      if (deps.assertAutomaticAllowed && !hireBudgetAllows(requireAutoConfig(deps), balances, wanted.length, nowSec() * 1000)) fail('SEASON_WISH_MILK_TEA_INSUFFICIENT', '雇佣预算或保留量已变化');
      declarationExtra.hires = wanted.map(row => ({ ...row, durationId,
        baselineShiftId: str64(list(shopView.slots).find(slot => num64(slot.slot_index) === row.slotIndex)?.shift_id || '0'),
        cost: { [duration.cost.itemId]: String(duration.cost.count) } }));
      operationName = 'hire';
      params = { hires: wanted.map(row => ({ slot_index: row.slotIndex, duration_id: durationId, target_gid: Long.fromString(row.targetGid) })) };
    }
    else if (action === 'claimCashier') {
      const shopReply = await readOperate(OPERATIONS.queryShop, {});
      const view = shopReply && shopReply.milk_tea_get_shop && shopReply.milk_tea_get_shop.shop;
      if (!view) fail('SEASON_WISH_MILK_TEA_NO_STATE', '服务端未返回收银台状态');
      if (deps.assertAutomaticAllowed && !cashierState(view, nowSec()).full) fail('SEASON_WISH_MILK_TEA_NO_CLAIMABLE', '收银台尚未满额');
      if (!list(view.pending_rewards).some(item => num64(item?.id) > 0 && num64(item?.count) > 0)) fail('SEASON_WISH_MILK_TEA_NO_CLAIMABLE', '当前没有可领取的收银台收益');
    }
    else if (action === 'boost') {
      const count = inputNumber(input.count);
      if (!(Number.isInteger(count) && count >= 1 && count <= 100)) fail('SEASON_WISH_MILK_TEA_INVALID_INPUT', '宣传喇叭使用数量无效');
      let view = null; let workshop = null;
      if (deps.assertAutomaticAllowed) {
        view = (await readOperate(OPERATIONS.queryShop, {}))?.milk_tea_get_shop?.shop;
        workshop = (await readOperate(OPERATIONS.queryWorkshop, {}))?.milk_tea_get_workshop;
      }
      // Read consumable inventory last, after all other asynchronous queries.
      const all = await readCompleteMilkBag(deps); recheck();
      if (balanceOf(all.balances, BOOST_ITEM_ID) < BigInt(count)) fail('SEASON_WISH_MILK_TEA_INSUFFICIENT', '宣传喇叭库存不足');
      if (!confirmedCostsMatch(input.confirmedCosts, new Map([[BOOST_ITEM_ID, BigInt(count)]]))) fail('SEASON_WISH_MILK_TEA_COST_CHANGED', '费用与确认值不一致，请刷新后重新确认');
      reconcileActionState({ summary, bagItems: all.items, nowMs: nowSec() * 1000 });
      if (deps.assertAutomaticAllowed && automaticBoostCount(view, workshop, all.balances, nowSec()) < count) fail('SEASON_WISH_MILK_TEA_INVALID_STATE', '喇叭可用收益或库存已变化');
      declarationExtra.boost = { count, elapsedSec: num64(view?.cashier_elapsed_sec), baselineStock: balanceOf(all.balances, BOOST_ITEM_ID).toString() };
      params = { count };
    }
    else if (action === 'upgrade') {
      // 升级资格以根快照摘要的 can_upgrade 为准（ShopView 回包无该字段，
      // 不再读 cmd55 后核对不存在的 can_upgrade）
      if (!summary) fail('SEASON_WISH_MILK_TEA_NO_STATE', '服务端未返回奶茶店铺状态');
      if (summary.canUpgrade !== true) fail('SEASON_WISH_MILK_TEA_INVALID_STATE', '当前营业额尚未达到升级条件');
      preUpgradeLevel = num64(summary.level);
      if (!validInteger(preUpgradeLevel, 1)) fail('SEASON_WISH_MILK_TEA_NO_STATE', '升级前等级未确认');
      if (['upgradeCost', 'upgradeCosts', 'upgrade_cost', 'upgrade_costs'].some(key => summary[key] != null && (!Array.isArray(summary[key]) || summary[key].length > 0))) fail('SEASON_WISH_MILK_TEA_UNKNOWN_COST', '升级费用未确认');
    }
    else if (action === 'craft') {
      const fruitUids = list(input.fruitUids).map(value => str64(value));
      if (!fruitUids.length || fruitUids.length > 100
        || fruitUids.some(uid => !/^[1-9]\d*$/.test(uid) || BigInt(uid) > 9223372036854775807n)
        || new Set(fruitUids).size !== fruitUids.length) {
        fail('SEASON_WISH_MILK_TEA_INVALID_INPUT', '加工果实条目无效（需唯一且非空）');
      }
      const recipeId = input.recipeId == null ? 0 : inputNumber(input.recipeId);
      const recipe = (CONFIG.recipes || []).find(row => toNum(row.recipeId) === recipeId) || null;
      if (!Number.isSafeInteger(recipeId) || recipeId < 0 || (recipeId > 0 && !recipe?.fruitItemId)) {
        fail('SEASON_WISH_MILK_TEA_INVALID_INPUT', '未知奶茶配方，停止加工');
      }
      if (typeof deps.getBag !== 'function' || typeof deps.getBagItems !== 'function') {
        fail('SEASON_WISH_MILK_TEA_NO_STATE', '无法读取背包，停止加工');
      }
      const workshopReply = await readOperate(OPERATIONS.queryWorkshop, {});
      const recipes = workshopReply?.milk_tea_get_workshop?.recipes;
      if (!Array.isArray(recipes)) fail('SEASON_WISH_MILK_TEA_NO_STATE', '无法读取当前配方，停止加工');
      // The final Bag read binds complete stack counts immediately before the durable declaration.
      const bag = await deps.getBag();
      recheck();
      const bagItems = completeMilkBagItems(bag, deps);
      reconcileActionState({ summary, bagItems, nowMs: nowSec() * 1000 });
      const fruitIds = new Set((CONFIG.recipes || []).map(row => toNum(row.fruitItemId)).filter(id => id > 0));
      const uidToItem = new Map();
      const selectedUids = new Set(fruitUids); const seenBagUids = new Set();
      for (const item of bagItems) {
        const uid = str64(item && item.uid);
        if (!/^[1-9]\d*$/.test(uid)) continue;
        if (selectedUids.has(uid) && seenBagUids.has(uid)) fail('SEASON_WISH_MILK_TEA_INVALID_STATE', '所选果实UID在完整背包中不唯一');
        seenBagUids.add(uid);
        if (!fruitIds.has(num64(item?.id))) continue;
        if (uidToItem.has(uid)) fail('SEASON_WISH_MILK_TEA_INVALID_STATE', '背包果实条目不唯一，停止加工');
        if (uid) uidToItem.set(uid, item);
      }
      // fruit_uids consumes complete bag stacks in one request. fruitCount is a
      // recipe ratio, not a limit on the number of selected stacks.
      let confirmed = null;
      if (input.confirmedFruits != null) {
        if (!Array.isArray(input.confirmedFruits) || input.confirmedFruits.length !== fruitUids.length) {
          fail('SEASON_WISH_MILK_TEA_INVALID_INPUT', '请确认所有果实条目与数量');
        }
        confirmed = new Map(input.confirmedFruits.map(row => [str64(row?.uid), row]));
        if (confirmed.size !== fruitUids.length || fruitUids.some(uid => !confirmed.has(uid))) {
          fail('SEASON_WISH_MILK_TEA_INVALID_INPUT', '确认的果实条目与选择不符');
        }
      }
      for (const uid of fruitUids) {
        const item = uidToItem.get(uid);
        const itemId = num64(item?.id);
        if (item?.locked === true || item?.is_locked === true || num64(item?.count) <= 0) fail('SEASON_WISH_MILK_TEA_INVALID_STATE', '果实条目已锁定或不可用');
        if (!itemId || !fruitIds.has(itemId)) {
          fail('SEASON_WISH_MILK_TEA_INVALID_STATE', '加工目标不在当前背包或不是奶茶活动果实，请刷新后重选');
        }
        if (recipe && toNum(recipe.fruitItemId) !== itemId) {
          fail('SEASON_WISH_MILK_TEA_INVALID_INPUT', '所选果实与配方不符');
        }
        const count = str64(item.count);
        if (!/^[1-9]\d*$/.test(count)) fail('SEASON_WISH_MILK_TEA_INVALID_STATE', '果实数量无法确认，请刷新后重选');
        const expected = confirmed?.get(uid);
        if (confirmed && (String(expected.count) !== count || Number(expected.itemId) !== itemId)) {
          fail('SEASON_WISH_MILK_TEA_COST_CHANGED', '果实数量或种类已变化，请刷新后重新确认整组消耗');
        }
      }
      const unlockedFruitIds = new Set(recipes.filter(row => row.unlocked === true)
        .map(row => CONFIG.recipes.find(config => config.recipeId === num64(row.recipe_id))?.fruitItemId).filter(Boolean));
      if (fruitUids.some(uid => !unlockedFruitIds.has(num64(uidToItem.get(uid).id)))) {
        fail('SEASON_WISH_MILK_TEA_INVALID_STATE', '所选果实的配方尚未解锁，请刷新后重选');
      }
      declarationExtra.fruits = fruitUids.map(uid => ({ uid, itemId: num64(uidToItem.get(uid).id), count: str64(uidToItem.get(uid).count) }));
      params = { fruit_uids: fruitUids.map(uid => Long.fromString(uid)) };
    }
    else if (action === 'claimWages') {
      const workReply = await readOperate(OPERATIONS.queryWorkPage, {});
      const work = workReply && workReply.milk_tea_get_work_page;
      if (!work) fail('SEASON_WISH_MILK_TEA_NO_STATE', '服务端未返回我的工作状态');
      const hasClaimable = summary?.hasUnclaimedWage === true
        && (list(work.slips).length > 0 || !!work.my_shift);
      if (!hasClaimable) fail('SEASON_WISH_MILK_TEA_INVALID_STATE', '当前没有可领取的工资');
      reconcileActionState({ summary, work, nowMs: nowSec() * 1000 });
      declarationExtra.slips = wageSlips(work);
    }
    else if (action === 'interact') {
      const workReply = await readOperate(OPERATIONS.queryWorkPage, {});
      const work = workReply && workReply.milk_tea_get_work_page;
      const shift = work && work.my_shift;
      if (!shift) fail('SEASON_WISH_MILK_TEA_INVALID_STATE', '当前没有进行中的班次，无法互动');
      if (toNum(input.shiftId) > 0 && str64(input.shiftId) !== str64(shift.shift_id)) {
        fail('SEASON_WISH_MILK_TEA_INVALID_STATE', '班次已变化，请刷新后重新选择');
      }
      const scalarKnown = workScalarKnown(work, nowSec());
      if (work.interact_done === true || !scalarKnown.interactDoneKnown || !scalarKnown.interactCountKnown
        || toNum(shift.interact_limit) <= 0 || toNum(shift.interact_count) >= toNum(shift.interact_limit)) {
        fail('SEASON_WISH_MILK_TEA_LIMIT', '本班次互动次数已用完');
      }
      const interactionType = inputNumber(input.interactionType);
      const previews = list(shift.interact_previews).filter(Boolean).map(preview => toNum(preview.interaction_type));
      if (!previews.includes(interactionType)) {
        fail('SEASON_WISH_MILK_TEA_INVALID_INPUT', '该互动不在当前班次可选项中');
      }
      // 互动目标由当前班次解析（雇主），不接受任意目标
      if (!shift.employer || !str64(shift.employer.gid)) {
        fail('SEASON_WISH_MILK_TEA_NO_STATE', '当前班次缺少雇主信息，无法互动');
      }
      if (input.targetGid != null && str64(input.targetGid) !== str64(shift.employer.gid)) fail('SEASON_WISH_MILK_TEA_INVALID_INPUT', '互动目标与当前班次不符');
      if (toNum(shift.end_at) > 0 && toNum(shift.end_at) <= nowSec()) fail('SEASON_WISH_MILK_TEA_INVALID_STATE', '当前班次已经结束');
      interactShiftId = str64(shift.shift_id);
      if (deps.assertAutomaticAllowed && !workInteractionReady(work, nowSec(), interactionType)) fail('SEASON_WISH_MILK_TEA_NO_STATE', '本班次互动资格未完整确认');
      reconcileActionState({ summary, myShiftId: interactShiftId, nowMs: nowSec() * 1000 });
      params = { target_gid: shift.employer.gid, interaction_type: interactionType };
    }
    else if (action === 'hireSetting') {
      if (typeof input.hireDisabled !== 'boolean') {
        fail('SEASON_WISH_MILK_TEA_INVALID_INPUT', '雇佣开关设置无效');
      }
      if (!summary) fail('SEASON_WISH_MILK_TEA_NO_STATE', '服务端未返回奶茶店铺状态');
      if (summary.hireDisabled === input.hireDisabled) {
        fail('SEASON_WISH_MILK_TEA_ALREADY', `雇佣已被${input.hireDisabled ? '关闭' : '开启'}`);
      }
      params = { hire_disabled: input.hireDisabled };
    }
    else if (action === 'exchange') {
      if (!exchangeShop) fail('SEASON_WISH_MILK_TEA_NO_STATE', '服务端未返回奶茶商城目录');
      const goodsId = toNum(input.goodsId);
      const count = input.count == null ? 1 : inputNumber(input.count);
      if (goodsId <= 0) fail('SEASON_WISH_MILK_TEA_INVALID_INPUT', '商品编号无效');
      if (!(Number.isInteger(count) && count >= 1 && count <= 999)) {
        fail('SEASON_WISH_MILK_TEA_INVALID_INPUT', '兑换数量无效');
      }
      const goods = (exchangeShop.items || []).find(item => toNum(item.id) === goodsId);
      if (!goods) fail('SEASON_WISH_MILK_TEA_INVALID_INPUT', '商城目录未发现该商品');
      if (toNum(goods.diamondCostCount) > 0
        || (goods.costs || []).some(cost => toNum(cost.id) === DIAMOND_ITEM_ID)) {
        fail('SEASON_WISH_MILK_TEA_DIAMOND_BLOCKED', '该商品可能消耗钻石，已阻止兑换');
      }
      for (const hint of goods.condHints || []) {
        if (hint.satisfied === false) {
          fail('SEASON_WISH_MILK_TEA_CONDITION', `兑换条件未满足：${hint.condType || '条件'}（${hint.current}/${hint.target}）`);
        }
      }
      if (toNum(goods.purchaseLimit) > 0
        && toNum(goods.purchasedCount) + count > toNum(goods.purchaseLimit)) {
        fail('SEASON_WISH_MILK_TEA_LIMIT', '兑换数量超过剩余限购次数');
      }
      // 结算期停止活动专属种子购买（种子名单来自当前商城下发与固定配置交叉；
      // 相位用「当前时间」重算，非种子商品不受影响）
      const rewardIds = new Set((goods.rewards || []).map(item => toNum(item.id)));
      const seedIds = new Set((CONFIG.activitySeedItemIds || []).map(toNum));
      if (timingOf(timingSource, nowSec()).phase === 'settle'
        && [...rewardIds].some(id => seedIds.has(id))) {
        fail('SEASON_WISH_MILK_TEA_SETTLING_SEEDS', '结算期已停止活动专属种子购买');
      }
      if ((goods.costs || []).some(cost => !getItemById(toNum(cost.id)))) fail('SEASON_WISH_MILK_TEA_UNKNOWN_COST', '未知费用道具，停止兑换');
      // 内部自动授权上下文：写前用 fresh 商品奖励身份复核已保存目标。
      // 同商品ID/同价格但奖励已换成别的种子时零写（前端不传该字段，只会更严）。
      const expectedSeedId = inputNumber(input.expectedSeedId);
      if (input.expectedSeedId != null) {
        if (!Number.isSafeInteger(expectedSeedId) || expectedSeedId <= 0) {
          fail('SEASON_WISH_MILK_TEA_INVALID_INPUT', '自动购种目标无效');
        }
        const rewardRow = (goods.rewards || []).find(item => toNum(item.id) === expectedSeedId);
        if (!rewardRow || num64(rewardRow.count) <= 0) {
          fail('SEASON_WISH_MILK_TEA_COST_CHANGED', '商品奖励已变化，不再匹配所选种子，停止兑换');
        }
      }
      const totals = costTotals(goods.costs || [], count);
      if (!totals || totals.size === 0) {
        fail('SEASON_WISH_MILK_TEA_UNKNOWN_COST', '该商品费用无法证实，已阻止兑换');
      }
      if (!confirmedCostsMatch(input.confirmedCosts, totals)) {
        fail('SEASON_WISH_MILK_TEA_COST_CHANGED', '费用与确认值不一致，请刷新后重新确认');
      }
      const { balances, available } = await readBalances(deps);
      recheck();
      if (!available) fail('SEASON_WISH_MILK_TEA_NO_STATE', '无法读取背包，停止兑换');
      for (const [itemId, amount] of totals) {
        if (balanceOf(balances, itemId) < amount) {
          fail('SEASON_WISH_MILK_TEA_INSUFFICIENT', '兑换余额不足');
        }
      }
      const activitySeedSet = new Set((CONFIG.activitySeedItemIds || []).map(toNum));
      deps.validateAutomaticPurchase?.({ goods, balances });
      exchangeDeclaration = {
        goodsId,
        seedId: (goods.rewards || []).map(item => toNum(item.id)).find(id => activitySeedSet.has(id)) || 0,
        count,
        baselinePurchased: goods.purchasedCountKnown === true && Number.isSafeInteger(Number(goods.purchasedCount)) ? Number(goods.purchasedCount) : null,
        counterKnown: goods.purchasedCountKnown === true,
        rewards: rewardAmounts(goods.rewards, count),
        spent: Object.fromEntries([...totals].map(([itemId, amount]) => [itemId, amount.toString()])),
      };
      operationName = 'exchange';
      params = { goods_id: goodsId, count };
    }
    else if (action === 'fundClaim') {
      if (!growthFund) fail('SEASON_WISH_MILK_TEA_NO_STATE', '服务端未返回成长基金状态');
      if (growthFund.unlocked !== true) fail('SEASON_WISH_MILK_TEA_INVALID_STATE', '成长基金尚未解锁，仅开放已解锁基金的领取');
      const claimable = (growthFund.tiers || []).some(tier =>
        toNum(tier.state) === 2 && (tier.conditions || []).length > 0
        && (tier.conditions || []).every(cond => cond.reached === true));
      if (!claimable) fail('SEASON_WISH_MILK_TEA_INVALID_STATE', '当前没有已达成可领取的基金档位');
      declarationExtra.tiers = list(growthFund.tiers).filter(tier => num64(tier.state) === 2
        && list(tier.conditions).length > 0 && tier.conditions.every(cond => cond.reached === true)).map(tier => num64(tier.tierId));
      operationName = 'fundClaim';
      params = {}; // 固定来源编码：cmd76 空参数请求（176 仅为回复字段）
    }
    else if (action === 'shareDaily') {
      if (!shareReward || !shareReward.daily) fail('SEASON_WISH_MILK_TEA_NO_STATE', '服务端未返回快乐值状态');
      const daily = shareReward.daily;
      if (daily.rewardClaimed === true) fail('SEASON_WISH_MILK_TEA_CLAIMED', '今日快乐值已领取');
      operationName = 'shareDaily';
      params = {};
    }
    else if (action === 'shareFirst') {
      if (!shareReward?.daily || typeof shareReward.daily.firstShareAwarded !== 'boolean') fail('SEASON_WISH_MILK_TEA_NO_STATE', '服务端未返回首次分享奖励状态');
      if (shareReward.daily.firstShareAwarded) fail('SEASON_WISH_MILK_TEA_CLAIMED', '今日首次分享奖励已领取');
      params = {};
    }
    else if (action === 'shareMilestones') {
      if (!shareReward) fail('SEASON_WISH_MILK_TEA_NO_STATE', '服务端未返回快乐值状态');
      const score = toNum(shareReward.currentScore);
      // 档位 state 语义沿用本仓库已验证解读：2 = 可领取（见一键领取既有实现）
      const claimable = (shareReward.milestones || []).some(tier =>
        toNum(tier.state) === 2 && score >= toNum(tier.threshold));
      if (!claimable) fail('SEASON_WISH_MILK_TEA_NO_CLAIMABLE', '当前没有可领取的快乐值档位');
      operationName = 'shareMilestones';
      params = {};
    }

    recheck();
    deps.beforeAutomaticWrite?.(action);
    recheck();
    const rewardKeys = rewardAttemptKeys(action, shareReward, nowSec() * 1000);
    if (rewardKeys.length) {
      loadAutomaticState();
      if (deps.assertAutomaticAllowed && rewardKeys.some(key => automaticState.claims[key])) fail('SEASON_WISH_MILK_TEA_NO_CLAIMABLE', '本次奖励已提交，请等待状态对账');
      rewardPrevious = { ...automaticState.claims };
      automaticState.claims = { ...automaticState.claims };
      for (const key of rewardKeys) automaticState.claims[key] = nowSec() * 1000;
      try { persistAutomaticState(); }
      catch (error) { automaticState.claims = rewardPrevious; rewardPrevious = null; throw error; }
    }
    // 工资/升级/互动/购种：手动与自动共用同一写前持久声明（含多币种预留），
    // 先落盘后发包；持久化失败抛出 = 零写。未知结果不重发，仅 fresh 对账释放。
    declared = declareManualAction(action, {
      preUpgradeLevel,
      interactShiftId,
      exchangeDeclaration,
      freshLevel: num64(summary?.level),
      automatic: typeof deps.assertAutomaticAllowed === 'function',
      nowMs: nowSec() * 1000,
      extra: declarationExtra,
    });
    const outcome = await send(operationName, params);
    const { reply, selector, command } = outcome;
    // 写请求已成功送达且回显匹配后，仍要求结果体存在；缺失 = 结果未知（不重试）
    if (selector && reply[selector] == null) {
      return unknownOutcome(action, command, new Error('回复缺少预期结果体'));
    }
    const result = reply[selector] || {};
    const positiveItems = rows => list(rows).some(item => num64(item?.id) > 0 && num64(item?.count) > 0);
    const claimedIds = list(result.claimed_tier_ids).map(num64);
    let confirmed = true;
    if (action === 'shareDaily' || action === 'shareFirst') confirmed = num64(result.granted_score) > 0 || positiveItems(result.rewards);
    else if (action === 'shareMilestones' || action === 'fundClaim') {
      const eligible = action === 'shareMilestones'
        ? list(shareReward?.milestones).filter(tier => toNum(tier.state) === 2 && toNum(shareReward.currentScore) >= toNum(tier.threshold)).map(tier => toNum(tier.id))
        : list(growthFund?.tiers).filter(tier => toNum(tier.state) === 2 && list(tier.conditions).length > 0 && tier.conditions.every(cond => cond.reached === true)).map(tier => toNum(tier.tierId));
      confirmed = claimedIds.length > 0 && new Set(claimedIds).size === claimedIds.length && claimedIds.every(id => id > 0 && eligible.includes(id));
      if (action === 'fundClaim') confirmed = confirmed && claimedIds.length === eligible.length;
    }
    else if (action === 'claimCashier') confirmed = positiveItems(result.items);
    else if (action === 'claimWages') confirmed = num64(result.claimed_count) > 0 || positiveItems(result.items);
    else if (action === 'createShop') confirmed = positiveItems(result.opening_gift);
    else if (action === 'exchange') confirmed = exchangeDeclaration?.seedId > 0 ? sameAmounts(rewardAmounts(result.awards), exchangeDeclaration.rewards) : positiveItems(result.awards);
    else if (action === 'interact') confirmed = own(result, 'success') && typeof result.success === 'boolean';
    else if (action === 'boost') confirmed = num64(result.cups) > 0;
    else if (action === 'upgrade') confirmed = num64(result.level) > preUpgradeLevel;
    else if (action === 'craft') {
      const recipes = new Set(declarationExtra.fruits.map(row => CONFIG.recipes.find(recipe => recipe.fruitItemId === row.itemId)?.recipeId));
      const cups = mapEntries(result.crafted_cups);
      confirmed = cups.length === recipes.size && cups.every(([id, count]) => recipes.has(Number(id)) && validInteger(Number(count), 1));
      if (confirmed && list(result.used_fruits).length) {
        confirmed = sameAmounts(rewardAmounts(result.used_fruits), rewardAmounts(declarationExtra.fruits.map(row => ({ id: row.itemId, count: row.count }))));
        const byUid = new Map(declarationExtra.fruits.map(row => [row.uid, row]));
        if (list(result.used_fruits).some(row => num64(row.uid) > 0)) confirmed = confirmed && result.used_fruits.length === byUid.size
          && new Set(result.used_fruits.map(row => str64(row.uid))).size === byUid.size
          && result.used_fruits.every(row => { const expected = byUid.get(str64(row.uid)); return expected && num64(row.id) === expected.itemId && str64(row.count) === expected.count; });
      }
    }
    else if (action === 'hire') {
      const rows = list(result.results); const expected = list(params.hires);
      confirmed = rows.length === expected.length && rows.length > 0 && rows.every((row, index) => (row.success === true || (row.success === false && validInteger(num64(row.error_code), 1)))
        && num64(row.slot_index) === num64(expected[index].slot_index) && num64(row.duration_id) === num64(expected[index].duration_id)
        && str64(row.target_gid) === str64(expected[index].target_gid));
      if (confirmed && deps.assertAutomaticAllowed) confirmed = rows.every(row => row.success !== true
        || hireSlotMatches(ensureActionState().hires?.[`${num64(row.slot_index)}:${str64(row.target_gid)}`], row.slot));
    }
    else if (action === 'hireSetting') confirmed = result.hire_disabled === input.hireDisabled;
    if (!confirmed) return unknownOutcome(action, command, new Error('回复未确认预期动作结果'));
    try { settleDeclaredAction(declared, { action, result, day: beijingDayOf(nowSec() * 1000) }); }
    catch { return unknownOutcome(action, command, new Error('动作已发送，结果持久化未完成')); }


    if (action === 'hire') {
      const results = list(result.results).filter(Boolean).slice(0, 20).map(row => ({
        slotIndex: toNum(row.slot_index),
        durationId: toNum(row.duration_id),
        targetGid: str64(row.target_gid),
        success: row.success === true,
        errorCode: num64(row.error_code),
        errorMsg: trimTo(row.error_msg, 80),
        endAt: row.success === true ? ensureActionState().hires?.[`${num64(row.slot_index)}:${str64(row.target_gid)}`]?.endAt || 0 : 0,
      }));
      const expected = params.hires || [];
      if (results.length !== expected.length || results.some((row, index) => row.slotIndex !== toNum(expected[index].slot_index) || row.durationId !== toNum(expected[index].duration_id) || row.targetGid !== str64(expected[index].target_gid))) return unknownOutcome(action, command, new Error('雇佣回复条目与请求不匹配'));
      log('活动', `奶茶操作完成: ${action}(cmd ${command})`, {
        module: 'activity', event: 'milk_tea_operate', action, command, result: 'ok',
        successCount: results.filter(row => row.success).length,
      });
      return {
        action, ok: results.length > 0 && results.every(row => row.success), command,
        results,
        message: results.every(row => row.success) ? '雇佣成功' : '部分雇佣未成功，请查看明细并刷新',
      };
    }
    if (action === 'interact') {
      // interact 的 success=false 可能是玩法输赢，不是请求失败；如实分开报告
      const success = result.success === true;
      log('活动', `奶茶互动完成: cmd ${command}`, {
        module: 'activity', event: 'milk_tea_operate', action, command, result: success ? 'ok' : 'gameplay_lose',
      });
      return {
        action, ok: true, command,
        gameplaySuccess: success,
        rewards: rewardRows(result.items_gained),
        message: success ? '互动成功' : '互动未生效（玩法结果，非请求失败）',
      };
    }

    const rewards = rewardRows(result.awards || result.items || result.rewards || result.opening_gift);
    log('活动', `奶茶操作完成: ${action}(cmd ${command})`, {
      module: 'activity', event: 'milk_tea_operate', action, command, result: 'ok', rewardCount: rewards.length,
    });
    const extra = {};
    if (action === 'boost') {
      extra.cups = num64(result.cups);
      extra.tokenGain = num64(result.token_gain);
      extra.coinGain = num64(result.coin_gain);
    }
    else if (action === 'upgrade') {
      extra.level = num64(result.level);
    }
    else if (action === 'craft') {
      extra.craftedCups = Object.fromEntries([...mapEntries(result.crafted_cups)].slice(0, 20).map(([k, v]) => [String(k), num64(v)]));
    }
    else if (action === 'claimWages') {
      extra.claimedCount = num64(result.claimed_count);
    }
    else if (action === 'shareDaily' || action === 'shareFirst') {
      extra.grantedScore = num64(result.granted_score);
    }
    else if (action === 'fundClaim' || action === 'shareMilestones') {
      extra.claimedTierIds = list(result.claimed_tier_ids).map(num64).slice(0, 20);
    }
    return {
      action, ok: true, command, rewards,
      message: '操作成功，请刷新查看最新状态',
      ...extra,
    };
  }
  catch (err) {
    try { if (err && typeof err === 'object' && !MILK_TEA_STAGES.has(err.milkTeaStage)) err.milkTeaStage = 'precondition'; } catch { /* diagnostic only */ }
    if (err && err.unknown === true) {
      return unknownOutcome(action, action in OPERATIONS ? OPERATIONS[action][1] : 0, err.err);
    }
    // Only structured proof of no physical send releases this declaration.
    // A failed durable release rolls memory back and retains the reservation.
    if (definitelyUnsent(err) && declared && context
      && currentConnection(deps) === context.ws && String(process.env.FARM_ACCOUNT_ID || '') === context.account) {
      releaseDeclaredAction(declared);
    }
    if (definitelyUnsent(err) && rewardPrevious && context
      && currentConnection(deps) === context.ws && String(process.env.FARM_ACCOUNT_ID || '') === context.account) {
      const pending = automaticState.claims; automaticState.claims = rewardPrevious;
      try { persistAutomaticState(); } catch (error) { automaticState.claims = pending; throw error; }
    }
    throw err;
  }
  finally {
    releaseLease(lease);
  }
}

// Only free, explicitly requested rewards participate. A durable latch is
// installed immediately before sending; an unknown result is never replayed.
let automaticState = { nextCheckAt: 0, claims: {}, actionState: null, loaded: false };
let automaticRunning = false;
function automaticStateFile() {
  const account = String(process.env.FARM_ACCOUNT_ID || 'default').replace(/[^\w.-]/g, '_').slice(0, 80);
  return require('../config/runtime-paths').getDataFile(`milk-tea-auto-${account}.json`);
}
function loadAutomaticState() {
  if (automaticState.loaded) return;
  try {
    const fs = require('node:fs');
    if (fs.statSync(automaticStateFile()).size > 262144) throw new Error('milk_journal_too_large');
    const value = JSON.parse(fs.readFileSync(automaticStateFile(), 'utf8'));
    if (value?.version !== 1 || !value.claims || Array.isArray(value.claims) || typeof value.claims !== 'object') throw new Error('invalid_reward_journal');
    automaticState.claims = Object.fromEntries(Object.entries(value.claims).filter(([key, time]) => key.length <= 200 && Number.isSafeInteger(time) && time > 0).slice(-50));
    // 兼容旧胶囊：无 actionState 字段的旧 version1 journal 安全加载（新声明体为空）
    if (value.actionState !== undefined && value.actionState !== null) {
      automaticState.actionState = normalizeActionStateJournal(value.actionState);
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  automaticState.loaded = true;
}
function persistAutomaticState() {
  const fs = require('node:fs');
  const path = require('node:path');
  const file = automaticStateFile();
  const serialized = JSON.stringify({ version: 1, claims: automaticState.claims, actionState: automaticState.actionState });
  if (Buffer.byteLength(serialized) > 262144) throw new Error('milk_journal_too_large');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, serialized, { mode: 0o600 });
    fs.renameSync(tmp, file);
  } finally { try { fs.unlinkSync(tmp); } catch {} }
}

// ---------- 工资/升级/互动/购种 写前持久声明与对账（version1 journal 可选新字段） ----------
//
// actionState 与 claims 完全独立：claims 保留既有两日/50 条裁剪；actionState 的
// 未决声明不被裁剪驱逐，只在 fresh 状态给出明确证据时释放。写前先持久化声明与
// 多币种预留，持久化失败抛出（零写）；未知结果不重发。

// New action records deliberately do not participate in reward claim expiry.
const ACTION_JOURNAL_LIMITS = { purchases: 32, interactions: 64, crafts: 512, hires: 16, funds: 40 };
const AUTO_COST_ITEM_IDS = [1001, 1041];
const own = (value, key) => value != null && Object.prototype.hasOwnProperty.call(value, key);
const validInteger = (value, min = 0) => Number.isSafeInteger(value) && value >= min;
function beijingDayOf(nowMs) { return new Date(nowMs + 8 * 3600_000).toISOString().slice(0, 10); }
function normalizeActionStateJournal(raw) {
  // version1 可选新字段（crafts/hires/funds/boost/open/cursor/hireSpend）：
  // 旧 journal/胶囊无这些键合法加载（懒迁移），存在时必须逐项可规范化。
  const empty = { wages: null, upgrades: null, interactions: {}, purchases: {}, spend: {} };
  if (raw == null) return empty; // Old version-1 journals and capsules.
  const object = value => value && typeof value === 'object' && !Array.isArray(value);
  const reject = () => { throw new Error('invalid_milk_action_journal'); };
  if (!object(raw)) reject();
  const value = JSON.parse(JSON.stringify(raw));
  for (const key of ['interactions', 'purchases', 'spend']) if (!object(value[key])) reject();
  if (Object.keys(value.purchases).length > ACTION_JOURNAL_LIMITS.purchases || Object.keys(value.interactions).length > ACTION_JOURNAL_LIMITS.interactions || Object.keys(value.spend).length > 4) reject();
  const statusValid = row => row.status === 'pending' || row.status === 'confirmed';
  const slipValid = row => object(row) && /^[1-9]\d{0,18}$/.test(String(row.shiftId)) && validInteger(row.endAt);
  if (value.wages != null && (!object(value.wages) || value.wages.pending !== true || !validInteger(value.wages.at, 1) || !statusValid(value.wages)
    || (value.wages.slips !== undefined && (!Array.isArray(value.wages.slips) || value.wages.slips.length > 20 || !value.wages.slips.every(slipValid))))) reject();
  if (value.upgrades != null && (!object(value.upgrades) || !validInteger(value.upgrades.pendingLevel, 1) || !validInteger(value.upgrades.at, 1) || !statusValid(value.upgrades))) reject();
  for (const [id, row] of Object.entries(value.interactions)) {
    if (!/^[1-9]\d{0,18}$/.test(id) || !object(row) || !validInteger(row.at, 1) || !statusValid(row)) reject();
  }
  const costsValid = rows => object(rows) && Object.keys(rows).length > 0 && Object.entries(rows).every(([id, count]) => /^[1-9]\d*$/.test(id) && milkTeaPolicy.parseExactCount(count) !== null && BigInt(count) > 0n);
  for (const [id, row] of Object.entries(value.purchases)) {
    if (!object(row) || String(row.goodsId) !== id || !validInteger(row.goodsId, 1) || !validInteger(row.seedId, 1)
      || !validInteger(row.count, 1) || row.count > 999 || (row.baselinePurchased !== null && !validInteger(row.baselinePurchased))
      || !validInteger(row.at, 1) || !/^\d{4}-\d{2}-\d{2}$/.test(row.day) || !statusValid(row)
      || !costsValid(row.spent) || !costsValid(row.rewards)) reject();
  }
  for (const [day, row] of Object.entries(value.spend)) if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !costsValid(row)) reject();
  // ---- 可选新集合（懒迁移）：存在才校验，未用胶囊编码不变 ----
  if (value.crafts !== undefined) {
    if (!object(value.crafts) || Object.keys(value.crafts).length > ACTION_JOURNAL_LIMITS.crafts) reject();
    for (const [uid, row] of Object.entries(value.crafts)) {
      if (!/^[1-9]\d{0,18}$/.test(uid) || !object(row) || !validInteger(row.itemId, 1)
        || !/^[1-9]\d*$/.test(String(row.count)) || !validInteger(row.at, 1) || !statusValid(row)) reject();
    }
  }
  if (value.hires !== undefined) {
    if (!object(value.hires) || Object.keys(value.hires).length > ACTION_JOURNAL_LIMITS.hires) reject();
    for (const [key, row] of Object.entries(value.hires)) {
      if (!object(row) || key !== `${row.slotIndex}:${row.targetGid}` || !validInteger(row.slotIndex)
        || !/^[1-9]\d{0,18}$/.test(String(row.targetGid)) || !validInteger(row.durationId, 1)
        || !costsValid(row.cost) || !validInteger(row.at, 1) || !statusValid(row)) reject();
      if ((row.endAt !== undefined || row.observedShiftId !== undefined)
        && (row.status !== 'confirmed' || !validInteger(row.endAt, 1) || !/^[1-9]\d{0,18}$/.test(String(row.observedShiftId)))) reject();
    }
  }
  if (value.funds !== undefined) {
    if (!object(value.funds) || Object.keys(value.funds).length > ACTION_JOURNAL_LIMITS.funds) reject();
    for (const [tierId, row] of Object.entries(value.funds)) {
      if (!/^[1-9]\d{0,9}$/.test(tierId) || !object(row) || !validInteger(row.at, 1) || !statusValid(row)) reject();
    }
  }
  if (value.hireSpend !== undefined) {
    if (!object(value.hireSpend) || Object.keys(value.hireSpend).length > 4) reject();
    for (const [day, row] of Object.entries(value.hireSpend)) if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !costsValid(row)) reject();
  }
  if (value.boost !== undefined && value.boost !== null
    && (!object(value.boost) || !validInteger(value.boost.count, 1) || value.boost.count > 100
      || !validInteger(value.boost.elapsedSec) || !validInteger(value.boost.at, 1) || !statusValid(value.boost))) reject();
  if (value.open !== undefined && value.open !== null
    && (!object(value.open) || !/^\d{4}-\d{2}-\d{2}$/.test(String(value.open.day)) || String(value.open.shopName || '').trim().length < 2
      || !validInteger(value.open.at, 1) || !statusValid(value.open))) reject();
  if (value.cursor !== undefined && value.cursor !== null && !validInteger(value.cursor)) reject();
  if (value.schedule !== undefined && (!object(value.schedule)
    || !validInteger(value.schedule.cursor) || value.schedule.cursor > 7
    || !validInteger(value.schedule.cycleAt) || !validInteger(value.schedule.followupsLeft)
    || value.schedule.followupsLeft > 2 || !validInteger(value.schedule.nextAt)
    || typeof value.schedule.policyIdentity !== 'string')) reject();
  return { ...empty, ...value };
}
function ensureActionState() {
  if (automaticState.actionState == null) automaticState.actionState = normalizeActionStateJournal(null);
  return automaticState.actionState;
}
// Publish a memory update only with its durable write. A failed rename must not
// make the next in-process invocation forget an unknown request.
function changeActionState(update) {
  loadAutomaticState();
  const previous = ensureActionState();
  const next = JSON.parse(JSON.stringify(previous));
  const result = update(next);
  normalizeActionStateJournal(next);
  automaticState.actionState = next;
  try { persistAutomaticState(); }
  catch (error) { automaticState.actionState = previous; throw error; }
  return result;
}
function pendingSpendByCurrency(state) {
  const totals = new Map();
  for (const row of Object.values(state?.purchases || {})) {
    if (row.status === 'confirmed') continue;
    for (const [id, amount] of Object.entries(row.spent)) totals.set(id, (totals.get(id) || 0n) + BigInt(amount));
  }
  return totals;
}
function dailyBudgetUsage(state, day) {
  const confirmed = new Map(Object.entries(state?.spend?.[day] || {}).map(([id, n]) => [id, BigInt(n)]));
  const pending = pendingSpendByCurrency(state);
  const used = new Map(confirmed);
  for (const [id, n] of pending) used.set(id, (used.get(id) || 0n) + n);
  return { confirmed, pending, used };
}
function recordConfirmedSpend(state, day, spent) {
  const row = state.spend[day] || {};
  for (const [id, n] of Object.entries(spent)) row[id] = ((BigInt(row[id] || '0')) + BigInt(n)).toString();
  state.spend[day] = row;
}
function rewardAmounts(rows, multiplier = 1) {
  if (!Array.isArray(rows) || !rows.length) return null;
  const amounts = {};
  for (const row of rows) {
    const id = num64(row?.id); const n = milkTeaPolicy.parseExactCount(str64(row?.count));
    if (!validInteger(id, 1) || n === null || BigInt(n) <= 0n) return null;
    amounts[id] = ((BigInt(amounts[id] || '0')) + BigInt(n) * BigInt(multiplier)).toString();
  }
  return amounts;
}
function sameAmounts(a, b) {
  return a && b && Object.keys(a).length === Object.keys(b).length && Object.entries(a).every(([id, n]) => b[id] === n);
}
function wageSlips(work) {
  const rows = list(work?.slips);
  if (!rows.length || rows.length > 20) return [];
  const ids = new Set(); const result = [];
  for (const row of rows) {
    const shiftId = str64(row?.shift_id); const endAt = num64(row?.end_at);
    if (!/^[1-9]\d{0,18}$/.test(shiftId) || ids.has(shiftId) || !validInteger(endAt)) return [];
    ids.add(shiftId); result.push({ shiftId, endAt });
  }
  return result;
}
function sharedCurrencyReservations(state) {
  const pending = pendingSpendByCurrency(state);
  for (const row of Object.values(state.hires || {})) if (row.status !== 'confirmed') {
    for (const [id, n] of Object.entries(row.cost)) pending.set(id, (pending.get(id) || 0n) + BigInt(n));
  }
  return pending;
}
function hireBudgetAllows(auto, balances, count = 1, nowMs = Date.now()) {
  const policy = milkTeaPolicy.normalizeHirePolicy(auto.milk_tea_hire_policy);
  const cost = milkTeaPolicy.hireDurationCost(policy.durationId);
  if (!cost || cost.itemId !== TICKET_ITEM_ID || !balances || !validInteger(count, 1)) return false;
  const state = ensureActionState(); const day = beijingDayOf(nowMs);
  const amount = BigInt(cost.count) * BigInt(count);
  const pendingHire = Object.values(state.hires || {}).filter(row => row.status !== 'confirmed')
    .reduce((sum, row) => sum + BigInt(row.cost[TICKET_ITEM_ID] || '0'), 0n);
  return BigInt(state.hireSpend?.[day]?.[TICKET_ITEM_ID] || '0') + pendingHire + amount <= BigInt(policy.ticketDailyLimit)
    && balanceOf(balances, TICKET_ITEM_ID) - (sharedCurrencyReservations(state).get(String(TICKET_ITEM_ID)) || 0n) - amount >= BigInt(policy.ticketReserve);
}
function recordHireSpend(state, day, cost) {
  state.hireSpend ||= {};
  const today = state.hireSpend[day] || {};
  for (const [id, n] of Object.entries(cost)) today[id] = (BigInt(today[id] || '0') + BigInt(n)).toString();
  state.hireSpend[day] = today;
}
function hireSlotMatches(row, slot) {
  const duration = CONFIG.hireDurations.find(item => item.durationId === row?.durationId)?.durationSec;
  return !!row && !!duration && !!slot && num64(slot.slot_index) === row.slotIndex && str64(slot.employee?.gid) === row.targetGid
    && /^[1-9]\d{0,18}$/.test(str64(slot.shift_id)) && str64(slot.shift_id) !== row.baselineShiftId
    && num64(slot.begin_at) * 1000 >= row.at - 1000 && num64(slot.end_at) * 1000 > row.at
    && validInteger(num64(slot.begin_at), 1) && validInteger(num64(slot.end_at), 1)
    && num64(slot.end_at) > num64(slot.begin_at) && num64(slot.end_at) - num64(slot.begin_at) <= duration
    && str64(slot.cost) === row.cost[TICKET_ITEM_ID];
}
function reconcileActionState({ summary, myShiftId, goodsById, nowMs, work, bagItems, shop }) {
  loadAutomaticState();
  // Do not write an empty journal on every read.
  const before = JSON.stringify(ensureActionState());
  const update = state => {
    const day = beijingDayOf(nowMs);
    state.spend = Object.fromEntries(Object.entries(state.spend).filter(([key]) => key === day));
    if (state.hireSpend) state.hireSpend = Object.fromEntries(Object.entries(state.hireSpend).filter(([key]) => key === day));
    if (state.wages && summary?.hasUnclaimedWageKnown === true && summary.hasUnclaimedWage === false) state.wages = null;
    // A confirmed legacy latch may advance only to provably later, distinct
    // wage slips. Time or a different day by itself is never sufficient.
    if (state.wages?.status === 'confirmed' && summary?.hasUnclaimedWage === true) {
      const slips = wageSlips(work); const previous = new Set(list(state.wages.slips).map(row => row.shiftId));
      if (slips.some(row => row.endAt * 1000 > state.wages.at && row.endAt * 1000 <= nowMs && !previous.has(row.shiftId))) state.wages = null;
    }
    if (state.upgrades && validInteger(summary?.level, 1) && summary.level > state.upgrades.pendingLevel) state.upgrades = null;
    if (/^[1-9]\d{0,18}$/.test(String(myShiftId || ''))) {
      state.interactions = Object.fromEntries(Object.entries(state.interactions).filter(([id]) => id === String(myShiftId)));
    }
    for (const [key, row] of Object.entries(state.purchases)) {
      const goods = goodsById?.get(row.goodsId);
      if (goods?.purchasedCountKnown !== true || !validInteger(goods.purchasedCount)
        || (row.status === 'confirmed' && row.baselinePurchased === null ? goods.purchasedCount < row.count
          : !validInteger(row.baselinePurchased) || goods.purchasedCount < row.baselinePurchased + row.count)
        || !sameAmounts(rewardAmounts(goods.rewards, row.count), row.rewards)) continue;
      // The actual debit day of an unknown write is unproven. Charge the day
      // of natural confirmation so a delayed debit cannot free a second allowance.
      if (row.status !== 'confirmed') recordConfirmedSpend(state, day, row.spent);
      delete state.purchases[key];
    }
    if (Array.isArray(bagItems)) {
      const byUid = new Map(); let unique = true;
      for (const item of bagItems) {
        const uid = str64(item?.uid);
        if (!/^[1-9]\d*$/.test(uid)) continue;
        if (byUid.has(uid)) unique = false;
        byUid.set(uid, item);
      }
      if (unique) for (const uid of Object.keys(state.crafts || {})) {
        const item = byUid.get(uid);
        if (!item || (nonNegativeKnown(item, 'count') && BigInt(str64(item.count)) === 0n)) delete state.crafts[uid];
      }
      // One horn attempt remains reserved until a normal inventory read proves
      // its whole debit. A changed configuration cannot create a new intent.
      if (state.boost) {
        const amount = bagItems.filter(item => num64(item?.id) === BOOST_ITEM_ID)
          .reduce((sum, item) => sum + (nonNegativeKnown(item, 'count') ? BigInt(str64(item.count)) : 0n), 0n);
        if (state.boost.baselineStock != null && amount <= BigInt(state.boost.baselineStock) - BigInt(state.boost.count)) state.boost = null;
      }
    }
    if (state.open && summary?.shopOpenAt > 0) state.open = null;
    if (shopSlotAvailability(shop, Math.floor(nowMs / 1000)).slotAvailabilityKnown) for (const [key, row] of Object.entries(state.hires || {})) {
      const slot = shop.slots.find(item => num64(item?.slot_index) === row.slotIndex);
      if (hireSlotMatches(row, slot)) {
        if (row.status !== 'confirmed') recordHireSpend(state, day, row.cost);
        row.status = 'confirmed'; row.observedShiftId = str64(slot.shift_id); row.endAt = num64(slot.end_at);
      }
      // Sparse lists may remove an ended employee completely. Only a proved
      // shift's real end plus this fresh valid slot list retires its intent.
      if (row.status === 'confirmed' && /^[1-9]\d{0,18}$/.test(String(row.observedShiftId))
        && validInteger(row.endAt, 1) && row.endAt <= Math.floor(nowMs / 1000)) delete state.hires[key];
    }
  };
  const probe = JSON.parse(before); update(probe);
  if (JSON.stringify(probe) === before) return false;
  changeActionState(state => Object.assign(state, probe));
  return true;
}
function actionStateSummary() {
  loadAutomaticState(); const state = ensureActionState();
  return { pendingPurchases: Object.values(state.purchases).filter(row => row.status !== 'confirmed').length,
    pendingInteractions: Object.values(state.interactions).filter(row => row.status !== 'confirmed').length,
    wagesPending: !!state.wages, upgradePending: !!state.upgrades,
    reservedFruitStacks: Object.keys(state.crafts || {}).length,
    pendingHires: Object.values(state.hires || {}).filter(row => row.status !== 'confirmed').length,
    lastMessage: automaticState.lastMessage || '', familyReasons: automaticState.familyReasons || {},
    seedReasons: Object.entries(automaticState.seedReasons || {}).slice(0, 8).map(([id, reason]) => ({ name: getItemById(Number(id))?.name || '活动种子', reason })),
    nextCheckAt: automaticState.nextCheckAt || 0 };
}
function declareManualAction(action, { preUpgradeLevel, interactShiftId, exchangeDeclaration, nowMs, automatic, extra = {} }) {
  if (!['claimWages', 'interact', 'upgrade', 'craft', 'hire', 'fundClaim', 'boost', 'createShop'].includes(action) && !(action === 'exchange' && exchangeDeclaration?.seedId > 0)) return null;
  return changeActionState(state => {
    const common = { at: nowMs, status: 'pending' };
    if (action === 'claimWages') {
      if (state.wages) fail('SEASON_WISH_MILK_TEA_NO_CLAIMABLE', '工资已提交，等待明确无待领状态对账');
      state.wages = { pending: true, ...common, ...(extra.slips?.length ? { slips: extra.slips } : {}) }; return { kind: 'wages' };
    }
    if (action === 'upgrade') {
      if (!validInteger(preUpgradeLevel, 1) || state.upgrades) fail('SEASON_WISH_MILK_TEA_INVALID_STATE', '升级等级未确认或上次升级待对账');
      state.upgrades = { pendingLevel: preUpgradeLevel, ...common }; return { kind: 'upgrade' };
    }
    if (action === 'interact') {
      if (!/^[1-9]\d{0,18}$/.test(interactShiftId) || state.interactions[interactShiftId] || Object.keys(state.interactions).length >= ACTION_JOURNAL_LIMITS.interactions) fail('SEASON_WISH_MILK_TEA_LIMIT', '本班次已尝试或班次记录无法确认');
      state.interactions[interactShiftId] = common; return { kind: 'interact', shiftId: interactShiftId };
    }
    if (action === 'craft') {
      state.crafts ||= {};
      if (!extra.fruits?.length || extra.fruits.some(row => state.crafts[row.uid])
        || Object.keys(state.crafts).length + extra.fruits.length > ACTION_JOURNAL_LIMITS.crafts) fail('SEASON_WISH_MILK_TEA_LIMIT', '果实已预留或材料记录已满，等待背包对账');
      for (const row of extra.fruits) state.crafts[row.uid] = { itemId: row.itemId, count: row.count, ...common };
      return { kind: 'craft', keys: extra.fruits.map(row => row.uid) };
    }
    if (action === 'hire') {
      state.hires ||= {};
      if (!extra.hires?.length || extra.hires.some(row => Object.values(state.hires).some(old => old.slotIndex === row.slotIndex))
        || Object.keys(state.hires).length + extra.hires.length > ACTION_JOURNAL_LIMITS.hires) fail('SEASON_WISH_MILK_TEA_LIMIT', '雇佣槽位已有声明，等待新班次对账');
      const keys = [];
      for (const row of extra.hires) {
        const key = `${row.slotIndex}:${row.targetGid}`; keys.push(key);
        state.hires[key] = { ...row, ...common };
      }
      return { kind: 'hire', keys };
    }
    if (action === 'fundClaim') {
      state.funds ||= {};
      if (!extra.tiers?.length || extra.tiers.some(id => state.funds[id]) || Object.keys(state.funds).length + extra.tiers.length > ACTION_JOURNAL_LIMITS.funds) fail('SEASON_WISH_MILK_TEA_LIMIT', '基金奖励已提交或记录已满');
      for (const id of extra.tiers) state.funds[id] = common;
      return { kind: 'fund', keys: extra.tiers.map(String) };
    }
    if (action === 'boost') {
      if (state.boost && (automatic || state.boost.status !== 'confirmed')) fail('SEASON_WISH_MILK_TEA_LIMIT', '喇叭使用已提交，等待库存对账');
      state.boost = { ...extra.boost, ...common }; return { kind: 'boost' };
    }
    if (action === 'createShop') {
      if (state.open) fail('SEASON_WISH_MILK_TEA_LIMIT', '开店已提交，等待店铺对账');
      state.open = { day: beijingDayOf(nowMs), shopName: extra.shopName, ...common }; return { kind: 'open' };
    }
    const row = exchangeDeclaration; const key = String(row.goodsId);
    const previous = state.purchases[key];
    // A fresh manual confirmation is a new intent after a confirmed result.
    // Automatic execution still needs a known counter and natural reconciliation;
    // a manual unknown result is never replaced, including an unknown baseline.
    if ((automatic && (!validInteger(row.baselinePurchased) || !row.counterKnown || previous))
      || (!automatic && previous?.status === 'pending') || !row.rewards
      || (!previous && Object.keys(state.purchases).length >= ACTION_JOURNAL_LIMITS.purchases)) fail('SEASON_WISH_MILK_TEA_LIMIT', '商品计数未确认或上次购买待对账');
    state.purchases[key] = { ...row, day: beijingDayOf(nowMs), ...common };
    delete state.purchases[key].counterKnown;
    return { kind: 'purchase', key };
  });
}
function settleDeclaredAction(declared, { day, result }) {
  if (!declared) return;
  changeActionState(state => {
    if (['craft', 'hire', 'fund'].includes(declared.kind)) {
      const collection = state[declared.kind === 'craft' ? 'crafts' : declared.kind === 'hire' ? 'hires' : 'funds'];
      for (const key of declared.keys) {
        const row = collection[key]; if (!row) throw new Error('missing_milk_action_declaration');
        if (declared.kind === 'hire') {
          const reply = list(result?.results).find(item => num64(item.slot_index) === row.slotIndex && str64(item.target_gid) === row.targetGid);
          if (reply?.success !== true) { delete collection[key]; continue; }
          if (hireSlotMatches(row, reply.slot)) { row.observedShiftId = str64(reply.slot.shift_id); row.endAt = num64(reply.slot.end_at); }
        }
        if (declared.kind === 'hire' && row.status !== 'confirmed') recordHireSpend(state, day, row.cost);
        row.status = 'confirmed';
      }
      return;
    }
    const row = declared.kind === 'wages' ? state.wages : declared.kind === 'upgrade' ? state.upgrades
      : declared.kind === 'boost' ? state.boost : declared.kind === 'open' ? state.open
      : declared.kind === 'interact' ? state.interactions[declared.shiftId] : state.purchases[declared.key];
    if (!row) throw new Error('missing_milk_action_declaration');
    if (declared.kind === 'purchase' && row.status !== 'confirmed') recordConfirmedSpend(state, day, row.spent);
    row.status = 'confirmed'; // Keep identity until a fresh state advances it.
  });
}
function releaseDeclaredAction(declared) {
  if (!declared) return;
  changeActionState(state => {
    if (declared.kind === 'wages') state.wages = null;
    else if (['craft', 'hire', 'fund'].includes(declared.kind)) {
      const key = declared.kind === 'craft' ? 'crafts' : declared.kind === 'hire' ? 'hires' : 'funds';
      for (const id of declared.keys) delete state[key][id];
    }
    else if (declared.kind === 'boost') state.boost = null;
    else if (declared.kind === 'open') state.open = null;
    else if (declared.kind === 'upgrade') state.upgrades = null;
    else if (declared.kind === 'interact') delete state.interactions[declared.shiftId];
    else delete state.purchases[declared.key];
  });
}
function automationPolicyIdentity(auto) {
  return JSON.stringify(['rewards', 'seeds', 'work', 'upgrade', 'craft', 'hire', 'open', 'boost'].map(key => auto[`milk_tea_auto_${key}`] === true)
    .concat([auto.milk_tea_work_interaction_type, auto.milk_tea_seed_policy, auto.milk_tea_hire_policy]));
}
function unchangedMilkTeaPolicy(identity, auto) {
  if (identity === automationPolicyIdentity(auto)) return true;
  if (['craft', 'hire', 'open', 'boost'].some(key => auto[`milk_tea_auto_${key}`] === true)) return false;
  // Older warm capsules used the six-field identity. New disabled options do
  // not invalidate their already scheduled deadline or rerun cold economics.
  return identity === JSON.stringify([auto.milk_tea_auto_rewards === true, auto.milk_tea_auto_seeds === true, auto.milk_tea_auto_work === true,
    auto.milk_tea_auto_upgrade === true, auto.milk_tea_work_interaction_type, auto.milk_tea_seed_policy]);
}
function automaticMilkTeaWakeAt(now = Date.now()) {
  const auto = require('../models/store').getAutomation();
  if (!milkTeaPolicy.anyMilkTeaAutoSwitchOn(auto)) return now + 86400_000;
  if (!automaticState.nextCheckAt) {
    try {
      loadAutomaticState(); const schedule = automaticState.actionState?.schedule;
      if (schedule?.policyIdentity === automationPolicyIdentity(auto)) automaticState.nextCheckAt = schedule.nextAt;
    } catch { return now + 15 * 60_000; }
  }
  if (automaticState.policyIdentity == null && automaticState.nextCheckAt > 0) automaticState.policyIdentity = automationPolicyIdentity(auto);
  if (!milkTeaPolicy.anyMilkTeaAutoSwitchOn(auto) || endedEvidenceActive(Math.floor(now / 1000))) return now + 86400_000;
  if (!unchangedMilkTeaPolicy(automaticState.policyIdentity, auto)) return now;
  return automaticState.nextCheckAt || now;
}
function markMilkTeaMaterialsDirty(now = Date.now()) {
  if (require('../models/store').getAutomation().milk_tea_auto_craft !== true) return;
  if (!automaticState.dirtyAt || automaticState.dirtyAt <= now) automaticState.dirtyAt = now + 60_000;
  automaticState.nextCheckAt = Math.min(automaticState.nextCheckAt || Infinity, automaticState.dirtyAt);
}
function seedPurchaseForGoods(auto, goods, balances, nowMs, onBlocked) {
  const blocked = message => { onBlocked?.(message); return null; };
  const policy = milkTeaPolicy.normalizeSeedPolicy(auto.milk_tea_seed_policy);
  const state = ensureActionState();
  if (goods?.automaticPurchaseDataComplete !== true || goods?.purchaseLimitKnown !== true || goods?.purchasedCountKnown !== true
    || !validInteger(goods.purchaseLimit) || !validInteger(goods.purchasedCount) || state.purchases[String(goods.id)]
    || !Array.isArray(goods.condHints) || goods.condHints.some(hint => hint?.satisfied !== true)
    || num64(goods.diamondCostCount) > 0) return blocked('购种暂停：商城条件、限购或已购信息未确认，或该商品上次购买待对账');
  const rewards = rewardAmounts(goods.rewards);
  if (!rewards || Object.keys(rewards).length !== 1) return blocked('购种暂停：商品奖励身份或数量未确认');
  const seedId = Number(Object.keys(rewards)[0]);
  if (!policy.targetSeedIds.includes(seedId) || !milkTeaPolicy.ACTIVITY_SEED_ITEM_IDS.includes(seedId)) return null;
  const each = BigInt(rewards[seedId]);
  if (each > 9999n) return null;
  const totals = milkTeaPolicy.mergeCosts(list(goods.costs).map(row => ({ itemId: num64(row.id), count: str64(row.count) })));
  if (!totals?.size || [...totals.keys()].some(id => !AUTO_COST_ITEM_IDS.includes(Number(id)))) return blocked('购种暂停：费用未确认或含不允许自动支付的货币');
  const { used } = dailyBudgetUsage(state, beijingDayOf(nowMs));
  const pending = sharedCurrencyReservations(state);
  const limits = { 1001: policy.coinDailyLimit, 1041: policy.ticketDailyLimit };
  const reserve = { 1001: policy.coinReserve, 1041: policy.ticketReserve };
  const reserves = {}; const dailyRemaining = {};
  for (const id of AUTO_COST_ITEM_IDS) {
    reserves[id] = (BigInt(reserve[id]) + (pending.get(String(id)) || 0n)).toString();
    const remaining = BigInt(limits[id]) - (used.get(String(id)) || 0n);
    dailyRemaining[id] = (remaining > 0n ? remaining : 0n).toString();
  }
  const gap = BigInt(policy.targetStock) - balanceOf(balances, seedId);
  if (gap < each) return blocked(gap <= 0n ? '购种跳过：目标库存已满足' : '购种跳过：库存缺口不足一份商品');
  if (goods.purchaseLimit > 0 && goods.purchasedCount >= goods.purchaseLimit) return blocked('购种暂停：当前商品限购已用尽');
  for (const [id, cost] of totals) {
    if (BigInt(dailyRemaining[id] || '0') < cost) return blocked('购种暂停：日预算不足，未决购买仍占用额度');
    if (balanceOf(balances, id) - BigInt(reserves[id] || '0') < cost) return blocked('购种暂停：余额不足或需要保留资源');
  }
  const count = milkTeaPolicy.purchasePortionCount({ stockGap: policy.targetStock - Number(balanceOf(balances, seedId)), seedsPerPortion: Number(each),
    remainingLimit: goods.purchaseLimit === 0 ? Infinity : Math.max(0, goods.purchaseLimit - goods.purchasedCount),
    unitCosts: totals, balances, reserves, dailyRemaining });
  if (count <= 0) return blocked('购种暂停：当前库存、限购与预算未同时满足');
  return { goodsId: goods.id, seedId, count, rewards: rewardAmounts(goods.rewards, count),
    unitRewards: rewards, unitCosts: Object.fromEntries([...totals].map(([id, n]) => [id, n.toString()])),
    confirmedCosts: [...totals].map(([id, n]) => ({ itemId: Number(id), count: (n * BigInt(count)).toString() })) };
}
// 工作页省略默认值：显式字段维持原语义；仅在 canonical Type 身份 + 有效班次
// 锚点（正班次ID/雇主/未来结束/正上限/有可选项）时，省略 interact_done 与
// interact_count 才按已确认 false/0 处理（已证省略默认值白名单）。
function workScalarKnown(work, nowSec) {
  const shift = work?.my_shift;
  const explicit = {
    interactDoneKnown: own(work, 'interact_done') && typeof work.interact_done === 'boolean',
    interactCountKnown: own(shift, 'interact_count') && nonNegativeKnown(shift, 'interact_count'),
  };
  if (explicit.interactDoneKnown && explicit.interactCountKnown) return explicit;
  if (!isCanonicalMessage(work, CANONICAL_TYPE_NAMES.work)) return { interactDoneKnown: false, interactCountKnown: false };
  const anchored = isCanonicalMessage(shift, 'gamepb.milkteapb.MilkTeaMyShift') && /^[1-9]\d{0,18}$/.test(str64(shift.shift_id))
    && /^[1-9]\d*$/.test(str64(shift.employer?.gid))
    && own(shift, 'interact_limit') && validInteger(num64(shift.interact_limit), 1)
    && own(shift, 'end_at') && num64(shift.end_at) > nowSec
    && list(shift.interact_previews).some(row => validInteger(num64(row?.interaction_type), 1));
  if (!anchored) return { interactDoneKnown: false, interactCountKnown: false };
  return {
    interactDoneKnown: explicit.interactDoneKnown || !own(work, 'interact_done'),
    interactCountKnown: explicit.interactCountKnown || !own(shift, 'interact_count'),
  };
}

function workInteractionReady(work, nowSec, type) {
  const shift = work?.my_shift;
  const known = workScalarKnown(work, nowSec);
  return !!shift && known.interactDoneKnown && work.interact_done === false
    && known.interactCountKnown && own(shift, 'interact_limit') && own(shift, 'end_at')
    && validInteger(num64(shift.interact_count)) && validInteger(num64(shift.interact_limit), 1)
    && num64(shift.interact_count) < num64(shift.interact_limit) && num64(shift.end_at) > nowSec
    && /^[1-9]\d{0,18}$/.test(str64(shift.shift_id))
    && list(shift.interact_previews).some(row => num64(row.interaction_type) === type);
}

function requireAutoConfig(deps) {
  return typeof deps.getAutomation === 'function' ? deps.getAutomation() : require('../models/store').getAutomation();
}
function completeMilkBagItems(bag, deps) {
  if (!(Array.isArray(bag?.item_bag?.items) || Array.isArray(bag?.items))) fail('SEASON_WISH_MILK_TEA_NO_STATE', '背包完整性未确认');
  const items = deps.getBagItems(bag);
  if (!Array.isArray(items) || items.some(item => !validInteger(num64(item?.id), 1)
    || milkTeaPolicy.parseExactCount(str64(item?.count)) === null)) fail('SEASON_WISH_MILK_TEA_NO_STATE', '背包数量未确认');
  return items;
}
async function readCompleteMilkBag(deps) {
  if (typeof deps.getBag !== 'function' || typeof deps.getBagItems !== 'function') fail('SEASON_WISH_MILK_TEA_NO_STATE', '无法读取完整背包');
  const bag = await deps.getBag();
  const items = completeMilkBagItems(bag, deps); const balances = new Map();
  for (const item of items) {
    const id = String(num64(item.id));
    balances.set(id, (BigInt(balances.get(id) || '0') + BigInt(str64(item.count))).toString());
  }
  return { items, balances };
}
function craftPlan(workshop, items) {
  if (!Array.isArray(workshop?.recipes) || !Array.isArray(items)) return null;
  const unlocked = new Set(); const recipeIds = new Set();
  for (const recipe of workshop.recipes) {
    const id = num64(recipe?.recipe_id);
    if (!validInteger(id, 1) || recipeIds.has(id)) return null;
    recipeIds.add(id);
    const fruit = CONFIG.recipes.find(row => row.recipeId === id)?.fruitItemId;
    if (fruit > 0 && recipe.unlocked === true) unlocked.add(fruit);
  }
  const counts = new Map();
  for (const item of items) {
    const uid = str64(item?.uid);
    if (/^[1-9]\d*$/.test(uid)) counts.set(uid, (counts.get(uid) || 0) + 1);
  }
  const reserved = ensureActionState().crafts || {};
  const maximum = Math.min(100, ACTION_JOURNAL_LIMITS.crafts - Object.keys(reserved).length);
  if (maximum <= 0) return null;
  const fruits = items.filter(item => unlocked.has(num64(item.id))).map(item => ({ uid: str64(item.uid), itemId: num64(item.id), count: str64(item.count), locked: item.locked === true || item.is_locked === true }))
    .filter(row => /^[1-9]\d{0,18}$/.test(row.uid) && BigInt(row.uid) <= 9223372036854775807n
      && counts.get(row.uid) === 1 && !reserved[row.uid] && !row.locked
      && milkTeaPolicy.parseExactCount(row.count) !== null && BigInt(row.count) > 0n)
    .sort((a, b) => BigInt(a.uid) < BigInt(b.uid) ? -1 : 1).slice(0, maximum);
  return fruits.length ? { fruitUids: fruits.map(row => row.uid), confirmedFruits: fruits.map(({ uid, itemId, count }) => ({ uid, itemId, count })) } : null;
}
function automaticBoostCount(view, workshop, balances, nowSec) {
  const cashier = cashierState(view, nowSec);
  if (!cashier.known || cashier.full || view?.is_settling !== false || !nonNegativeKnown(view, 'boost_cups_per_use')
    || num64(view.boost_cups_per_use) <= 0 || !Array.isArray(workshop?.recipes) || !balances) return 0;
  const amounts = [...mapEntries(view.drink_cups)].map(([, value]) => Number(value));
  const stocks = workshop.recipes.map(row => nonNegativeKnown(row, 'stock_cups') ? Number(row.stock_cups) : Number.NaN);
  if (!amounts.length || amounts.some(n => !validInteger(n)) || stocks.some(n => !validInteger(n))) return 0;
  const cups = Math.min(amounts.reduce((sum, n) => sum + n, 0), stocks.reduce((sum, n) => sum + n, 0));
  if (!validInteger(cups)) return 0;
  const stock = balanceOf(balances, BOOST_ITEM_ID);
  return Math.max(0, Math.min(100, Number(stock > 100n ? 100n : stock), Math.floor(cups / num64(view.boost_cups_per_use))));
}

// Only recipe-material sales participate in the existing milk lease. Ordinary
// inventory sales keep their original path and do not load this journal.
async function withMilkTeaMaterialSale(items, send) {
  const fruitIds = new Set(CONFIG.recipes.map(row => row.fruitItemId).filter(id => id > 0));
  if (!list(items).some(item => fruitIds.has(num64(item?.id)))) return send();
  const lease = acquireLease();
  if (!lease) fail('SEASON_WISH_MILK_TEA_BUSY', '奶茶材料正在核对或加工，请稍后出售');
  try {
    loadAutomaticState(); const reserved = ensureActionState().crafts || {};
    const seen = new Set();
    for (const item of items.filter(row => fruitIds.has(num64(row?.id)))) {
      const uid = str64(item.uid == null ? '0' : item.uid); const count = milkTeaPolicy.parseExactCount(str64(item.count));
      if (!/^(?:0|[1-9]\d{0,18})$/.test(uid) || BigInt(uid) > 9223372036854775807n || count === null
        || BigInt(count) <= 0n || BigInt(count) > 9223372036854775807n || (uid !== '0' && seen.has(uid))) fail('SEASON_WISH_MILK_TEA_INVALID_INPUT', '奶茶材料出售条目不完整或不唯一');
      if (uid !== '0') seen.add(uid);
    }
    if (items.some(item => reserved[str64(item?.uid)] || (fruitIds.has(num64(item?.id)) && !/^[1-9]\d*$/.test(str64(item?.uid))
      && Object.values(reserved).some(row => row.itemId === num64(item.id))))) fail('SEASON_WISH_MILK_TEA_LIMIT', '果实已用于奶茶制作声明，等待背包对账');
    return await send();
  } finally { releaseLease(lease); }
}

function rewardAttemptKeys(action, share, now) {
  const day = new Date(now + 8 * 3600_000).toISOString().slice(0, 10);
  if (action === 'claimCashier') return ['cashier'];
  if (action === 'shareDaily') return [`daily:${day}`];
  if (action === 'shareFirst') return [`first:${day}`];
  if (action === 'shareMilestones') return list(share?.milestones).filter(row => toNum(row.state) === 2 && toNum(share.currentScore) >= toNum(row.threshold)).map(row => `tier:${toNum(row.id)}`);
  return [];
}
async function runAutomaticMilkTea(deps = {}) {
  const nowMs = () => typeof deps.now === 'function' ? deps.now() : Date.now();
  const autoCfg = () => requireAutoConfig(deps);
  // Freeze every flag and budget before the first await; no mixed authorization.
  const selected = JSON.parse(JSON.stringify(autoCfg()));
  const identity = automationPolicyIdentity(selected);
  const enabled = () => (typeof deps.enabled !== 'function' || deps.enabled() === true) && milkTeaPolicy.anyMilkTeaAutoSwitchOn(autoCfg());
  const paused = () => typeof deps.isPaused === 'function' ? deps.isPaused() : require('../models/store').getPauseRemainMs(process.env.FARM_ACCOUNT_ID || '') > 0;
  if (automaticState.policyIdentity == null && automaticState.nextCheckAt > 0) automaticState.policyIdentity = identity;
  if (automaticRunning || !enabled() || paused() || (unchangedMilkTeaPolicy(automaticState.policyIdentity, selected) && nowMs() < automaticState.nextCheckAt) || endedEvidenceActive(Math.floor(nowMs() / 1000))) return;
  const lease = acquireLease();
  if (!lease) { automaticState.nextCheckAt = nowMs() + 60_000; return; }
  automaticRunning = true; automaticState.policyIdentity = identity;
  let held = true; let context; let failed = false; let cursor = 0; let cycleAt = nowMs(); let followupsLeft = 2;
  const results = []; const reasons = {}; let newWrites = 0;
  automaticState.nextCheckAt = nowMs() + 15 * 60_000;
  const dirtyIsDue = validInteger(automaticState.dirtyAt, 1) && automaticState.dirtyAt <= nowMs();
  if (dirtyIsDue) delete automaticState.dirtyAt;
  try {
    const warehouse = require('./warehouse');
    deps = { getBag: warehouse.getBag, getBagItems: warehouse.getBagItems, ...deps };
    loadAutomaticState();
    const saved = ensureActionState().schedule;
    if (saved) {
      cursor = saved.cursor;
      if (nowMs() < saved.cycleAt + 15 * 60_000) { cycleAt = saved.cycleAt; followupsLeft = saved.followupsLeft; }
      if (saved.policyIdentity === identity && nowMs() < saved.nextAt && !dirtyIsDue && !automaticState.dirtyAt) {
        automaticState.nextCheckAt = saved.nextAt; return results;
      }
    }
    const day = beijingDayOf(nowMs());
    context = captureConnectionContext(deps);
    let timingSource = null;
    const recheck = () => {
      assertConnectionOwned(deps, context);
      if (!enabled() || paused() || automationPolicyIdentity(autoCfg()) !== identity || beijingDayOf(nowMs()) !== day) fail('SEASON_WISH_MILK_TEA_PAUSED', '自动化设置或日期已变化，等待重新核对');
      if (typeof deps.canRun === 'function' && deps.canRun() !== true) fail('SEASON_WISH_MILK_TEA_YIELD', '优先处理到点收获');
      if (timingSource && timingOf(timingSource, Math.floor(nowMs() / 1000)).phase === 'ended') {
        recordEndedEvidence(timingOf(timingSource, Math.floor(nowMs() / 1000)), null);
        fail('SEASON_WISH_MILK_TEA_ENDED', '奶茶活动已结束');
      }
    };
    recheck();
    const activity = require('./activity');
    const activities = await (deps.getActivityDiscoveryList || activity.getActivityDiscoveryList)(); recheck();
    timingSource = findMilkTeaRootNode(activities);
    if (!timingSource) { automaticState.nextCheckAt = nowMs() + 6 * 3600_000; return results; }
    const snapshot = await (deps.getActivityGroupSnapshot || activity.getActivityGroupSnapshot)(MILK_TEA_ROOT_ACTIVITY_ID, ''); recheck();
    if (num64(snapshot?.id) !== MILK_TEA_ROOT_ACTIVITY_ID) return results;
    timingSource = snapshot;
    const nowSec = () => Math.floor(nowMs() / 1000);
    const timing = timingOf(snapshot, nowSec()); recordEndedEvidence(timing, null);
    if (!['open', 'settle'].includes(timing.phase)) return results;
    const child = id => list(snapshot.children).find(row => num64(row.id) === id)?.details;
    const summary = child(MILK_TEA_MAIN_ACTIVITY_ID)?.milkTea;
    const share = child(MILK_TEA_HAPPY_SHARE_ACTIVITY_ID)?.shareReward;
    const fund = child(MILK_TEA_FUND_ACTIVITY_ID)?.growthFund;
    const goodsList = list(child(MILK_TEA_SHOP_ACTIVITY_ID)?.exchangeShop?.items);
    const plans = []; const families = ['restock', 'craft', 'hire', 'work', 'upgrade', 'share', 'fund', 'boost'];
    const seedReasons = {}; automaticState.seedReasons = seedReasons;
    const add = (family, action, input = {}) => plans.push({ family, action, input });
    let work = null; let shop = null; let workshop = null; let inventory = null;
    const opened = summary?.shopOpenAt > 0;
    const closed = summary && validInteger(summary.shopOpenAt) && summary.shopOpenAt === 0 && validInteger(summary.level, 1) && !summary.shopName;
    const read = async (name, params = {}) => { const reply = await operateMilkTeaRequest(OPERATIONS[name], params, deps, context); recheck(); return reply; };
    if (selected.milk_tea_auto_work === true) {
      work = (await read('queryWorkPage'))?.milk_tea_get_work_page;
      const end = num64(work?.my_shift?.end_at) * 1000;
      if (end > nowMs()) automaticState.nextCheckAt = Math.min(automaticState.nextCheckAt, end + 1000);
    }
    if (opened && (selected.milk_tea_auto_rewards === true || selected.milk_tea_auto_hire === true || selected.milk_tea_auto_boost === true)) {
      shop = (await read('queryShop'))?.milk_tea_get_shop?.shop;
      for (const slot of list(shop?.slots)) {
        const end = num64(slot?.end_at) * 1000;
        if (end > nowMs()) automaticState.nextCheckAt = Math.min(automaticState.nextCheckAt, end + 1000);
      }
      const cashier = cashierState(shop, nowSec());
      if (cashier.known && !cashier.full && automaticState.claims.cashier) {
        delete automaticState.claims.cashier; persistAutomaticState();
      }
      if (timing.phase === 'open' && cashier.nextCheckAt > nowMs()) automaticState.nextCheckAt = Math.min(automaticState.nextCheckAt, cashier.nextCheckAt);
    }
    if (opened && timing.phase === 'open' && (selected.milk_tea_auto_craft === true || selected.milk_tea_auto_boost === true)) workshop = (await read('queryWorkshop'))?.milk_tea_get_workshop;
    if (timing.phase === 'open' && (selected.milk_tea_auto_craft === true || selected.milk_tea_auto_hire === true || selected.milk_tea_auto_boost === true
      || (selected.milk_tea_auto_seeds === true && selected.milk_tea_seed_policy?.targetSeedIds?.length))) {
      inventory = await readCompleteMilkBag(deps); recheck();
    }
    reconcileActionState({ summary, myShiftId: work?.my_shift?.shift_id, work, shop, bagItems: inventory?.items,
      goodsById: new Map(goodsList.map(row => [row.id, row])), nowMs: nowMs() });
    const state = ensureActionState();
    if (closed && timing.phase === 'open' && selected.milk_tea_auto_open === true && !state.open) add('prerequisite', 'createShop', { shopName: '奶茶小店' });
    else if (!opened) { reasons.open = '店铺未开业或状态未确认'; }
    if (opened) {
      if (selected.milk_tea_auto_rewards === true && cashierState(shop, nowSec()).full
        && list(shop?.pending_rewards).some(row => num64(row?.id) > 0 && num64(row?.count) > 0) && !automaticState.claims.cashier) add('urgent', 'claimCashier');
      if (timing.phase === 'open' && selected.milk_tea_auto_seeds === true) {
        reasons.restock = selected.milk_tea_seed_policy?.targetSeedIds?.length ? '当前商城未发现符合目标的可购商品' : '未选择购种目标，本轮不购买';
        for (const seedId of list(selected.milk_tea_seed_policy?.targetSeedIds)) {
          seedReasons[seedId] = '当前商城未发现该目标的可购商品';
          for (const goods of goodsList) {
            if (!list(goods.rewards).some(row => num64(row.id) === seedId)) continue;
            const plan = seedPurchaseForGoods(selected, goods, inventory?.balances, nowMs(), message => { reasons.restock = message; seedReasons[seedId] = message; });
            if (plan) {
              seedReasons[seedId] = '条件已满足，等待公平调度';
              if (!plans.some(row => row.family === 'restock')) {
                add('restock', 'exchange', { goodsId: plan.goodsId, count: plan.count, confirmedCosts: plan.confirmedCosts, expectedSeedId: plan.seedId }); plans[plans.length - 1].purchase = plan;
              }
              break;
            }
          }
        }
      }
      if (timing.phase === 'open' && selected.milk_tea_auto_craft === true) {
        const plan = craftPlan(workshop, inventory?.items);
        if (plan) add('craft', 'craft', plan);
        else reasons.craft = Object.keys(state.crafts || {}).length ? '材料已预留或没有新的已解锁果实整组' : '暂无可用且已解锁的果实整组';
      }
      if (timing.phase === 'open' && selected.milk_tea_auto_hire === true) {
        const availability = shopSlotAvailability(shop, nowSec());
        const slot = availability.freeSlotIndexes.find(index => !Object.values(state.hires || {}).some(row => row.slotIndex === index));
        if (!availability.slotAvailabilityKnown || slot == null) reasons.hire = '暂无已确认空闲且未预留的雇佣槽位';
        else if (!hireBudgetAllows(selected, inventory?.balances, 1, nowMs())) reasons.hire = '雇佣预算不足或需要保留奶茶券';
        else {
          const policy = milkTeaPolicy.normalizeHirePolicy(selected.milk_tea_hire_policy);
          const candidates = (await read('queryHireList', { duration_id: policy.durationId }))?.milk_tea_get_hire_list;
          const duration = milkTeaPolicy.hireDurationCost(policy.durationId);
          const remaining = timingOf(snapshot, nowSec()).settleStartTime - nowSec();
          const eligible = list(candidates?.friends).concat(list(candidates?.robots)).find(entry => hireCandidateEligible(entry, nowSec()));
          if (num64(candidates?.duration_id) === policy.durationId && nonNegativeKnown(candidates, 'min_remain_biz_sec')
            && remaining >= num64(candidates.min_remain_biz_sec) && num64(candidates.wage_total) === Number(duration.count) && eligible) {
            add('hire', 'hire', { durationId: policy.durationId, hires: [{ slotIndex: slot, targetGid: str64(eligible.friend.gid) }], confirmedCosts: [{ itemId: duration.itemId, count: duration.count }] });
          } else reasons.hire = '暂无合资格员工或班次费用、剩余营业时间未确认';
        }
      }
      if (selected.milk_tea_auto_work === true) {
        if (summary?.hasUnclaimedWage === true && !state.wages && (list(work?.slips).length || work?.my_shift)) add('work', 'claimWages');
        {
          const type = milkTeaPolicy.normalizeWorkInteractionType(selected.milk_tea_work_interaction_type);
          if (timing.phase === 'open' && workInteractionReady(work, nowSec(), type) && !state.interactions[str64(work.my_shift.shift_id)]) add('work', 'interact', { interactionType: type, shiftId: str64(work.my_shift.shift_id) });
          else reasons.work = state.wages ? '工资已提交，等待新工资单对账' : '暂无可互动班次或可领取工资';
        }
      }
      if (timing.phase === 'open' && selected.milk_tea_auto_upgrade === true && summary?.canUpgrade === true && validInteger(summary.level, 1) && !state.upgrades) add('upgrade', 'upgrade');
      if (selected.milk_tea_auto_rewards === true) {
        if (share?.daily?.rewardClaimed === false && !automaticState.claims[`daily:${day}`]) add('share', 'shareDaily');
        if (share?.daily?.firstShareAwarded === false && !automaticState.claims[`first:${day}`]) add('share', 'shareFirst');
        if (list(share?.milestones).some(row => num64(row.state) === 2 && num64(share.currentScore) >= num64(row.threshold) && !automaticState.claims[`tier:${num64(row.id)}`])) add('share', 'shareMilestones');
        const tiers = list(fund?.tiers).filter(row => num64(row.state) === 2 && list(row.conditions).length && row.conditions.every(cond => cond.reached === true));
        if (fund?.unlocked === true && fund.automaticClaimDataComplete === true && tiers.length && tiers.every(row => !state.funds?.[row.tierId])) add('fund', 'fundClaim');
      }
      if (timing.phase === 'open' && selected.milk_tea_auto_boost === true) {
        const count = automaticBoostCount(shop, workshop, inventory?.balances, nowSec());
        if (count > 0 && !state.boost) add('boost', 'boost', { count, confirmedCosts: [{ itemId: BOOST_ITEM_ID, count: String(count) }] });
        else reasons.boost = state.boost ? '喇叭已提交，等待库存对账' : '喇叭库存或可用杯数不足，或当前不宜加速';
      }
    }
    automaticState.familyReasons = reasons;
    automaticState.lastMessage = reasons.restock || '本轮已核对，暂无已确认可执行动作';
    releaseLease(lease); held = false;
    const ordered = plans.filter(plan => ['prerequisite', 'urgent'].includes(plan.family));
    if (!ordered.some(plan => plan.family === 'prerequisite')) for (let offset = 0; offset < families.length; offset++) {
      const family = families[(cursor + offset) % families.length]; const plan = plans.find(row => row.family === family); if (plan) ordered.push(plan);
    }
    if (!ordered.some(plan => plan.family === 'prerequisite')) for (let offset = 0; offset < families.length; offset++) {
      const family = families[(cursor + offset) % families.length];
      for (const plan of plans.filter(row => row.family === family)) if (!ordered.includes(plan)) ordered.push(plan);
    }
    for (const plan of ordered.slice(0, 3)) {
      recheck();
      const index = families.indexOf(plan.family); if (index >= 0) cursor = (index + 1) % families.length;
      changeActionState(row => { row.schedule = { cursor, cycleAt, followupsLeft, nextAt: automaticState.nextCheckAt, policyIdentity: identity }; });
      const result = await runManualMilkTeaAction(plan.action, plan.input, { ...deps, assertAutomaticAllowed: recheck,
        beforeAutomaticWrite: () => { recheck(); if (newWrites >= 3) fail('SEASON_WISH_MILK_TEA_LIMIT', '本轮自动动作额度已用尽'); newWrites++; },
        validateAutomaticPurchase: !plan.purchase ? undefined : ({ goods, balances }) => {
          recheck(); const fresh = seedPurchaseForGoods(selected, goods, balances, nowMs());
          if (!fresh || fresh.seedId !== plan.purchase.seedId || fresh.count < plan.purchase.count || !sameAmounts(fresh.unitRewards, plan.purchase.unitRewards)
            || !sameAmounts(fresh.unitCosts, plan.purchase.unitCosts)) fail('SEASON_WISH_MILK_TEA_COST_CHANGED', '自动购买的目标、费用、库存或预算已变化');
        },
      });
      results.push(result);
      if (plan.action === 'hire') for (const row of list(result?.results)) if (row.success === true && row.endAt * 1000 > nowMs()) {
        automaticState.nextCheckAt = Math.min(automaticState.nextCheckAt, row.endAt * 1000 + 1000);
      }
      if (result?.ok !== true || result?.outcome === 'unknown') { failed = true; automaticState.lastMessage = '上次操作结果未知，已保留声明，等待正常状态对账'; break; }
      automaticState.lastMessage = '本轮动作已提交，后续按最新状态复核';
    }
    if (!failed && results.some(result => result?.ok === true) && followupsLeft > 0) {
      followupsLeft--; automaticState.nextCheckAt = Math.min(automaticState.nextCheckAt, nowMs() + 60_000);
    }
    return results;
  } catch (error) {
    failed = true;
    automaticState.lastMessage = error?.code === 'SEASON_WISH_MILK_TEA_YIELD' ? '已让位于成熟收获或好友抢收' : '本轮检查未完成，已暂停操作，等待下一次复核';
    automaticState.nextCheckAt = error?.code === 'SEASON_WISH_MILK_TEA_YIELD' ? nowMs() + 1000 : Math.max(automaticState.nextCheckAt, nowMs() + 60_000);
    if (!['SEASON_WISH_MILK_TEA_PAUSED', 'SEASON_WISH_MILK_TEA_YIELD'].includes(error?.code)) log('活动', '奶茶自动化本轮未完成，等待下次状态复核', { module: 'activity', event: 'milk_tea_auto_check', result: 'error', code: String(error?.code || 'read_failed').slice(0, 80) });
    return results;
  } finally {
    if (held) releaseLease(lease);
    if (automaticState.dirtyAt > nowMs()) automaticState.nextCheckAt = Math.min(automaticState.nextCheckAt, automaticState.dirtyAt);
    // A late response cannot publish into a different account's journal.
    if (context && currentConnection(deps) === context.ws && String(process.env.FARM_ACCOUNT_ID || '') === context.account) {
      try { changeActionState(row => { row.schedule = { cursor, cycleAt, followupsLeft, nextAt: automaticState.nextCheckAt, policyIdentity: identity }; }); }
      catch { automaticState.lastMessage = '调度状态保存失败，经济操作声明仍保留'; }
    }
    automaticRunning = false;
  }
}

module.exports = {
  MILK_TEA_ROOT_ACTIVITY_ID,
  MILK_TEA_MAIN_ACTIVITY_ID,
  MILK_TEA_SHOP_ACTIVITY_ID,
  MILK_TEA_FUND_ACTIVITY_ID,
  MILK_TEA_HAPPY_SHARE_ACTIVITY_ID,
  OPERATIONS,
  QUERY_KINDS,
  MANUAL_ACTIONS,
  normalizeMilkTeaDiscovery: attachMilkTeaDiscoveryDetails,
  decodeMilkTeaGroup,
  milkTeaSummaryDto,
  growthFundDto,
  exchangeShopRichDto,
  getMilkTeaExchangeBounds,
  getMilkTeaActivity,
  queryMilkTeaActivity,
  runManualMilkTeaAction,
  // 测试与内部核对用（无网络纯函数）
  timingOf,
  hireCandidateEligible,
  cashierState,
  runAutomaticMilkTea,
  automaticMilkTeaWakeAt,
  markMilkTeaMaterialsDirty,
  withMilkTeaMaterialSale,
  // 自主动作对账/预算（无网络纯函数，测试与面板状态用）
  reconcileActionState,
  dailyBudgetUsage,
  actionStateSummary,
  normalizeActionStateJournal,
  beijingDayOf,
};

// Persistent-session data capsule. No handles, functions or in-flight work.
if (globalThis.process?.env?.FARM_SESSION_BUSINESS === '1') {
  const { registerBusinessState } = require('./business-state');
  registerBusinessState('services/milk-tea-activity.js', {
    version: 1,
    capture: () => ({ endedEvidence, automaticState }),
    validate(value) {
      const keys = value && Object.keys(value).sort().join(',');
      if (keys !== 'endedEvidence' && keys !== 'automaticState,endedEvidence') throw new Error('Invalid milk reward checkpoint');
      if (value.automaticState && (!Number.isFinite(value.automaticState.nextCheckAt) || !value.automaticState.claims || Array.isArray(value.automaticState.claims) || typeof value.automaticState.claims !== 'object' || typeof value.automaticState.loaded !== 'boolean')) throw new Error('Invalid milk automatic state');
      // actionState 为可选新字段：旧胶囊无该字段合法；存在时必须能规范化
      if (value.automaticState?.actionState !== undefined && value.automaticState.actionState !== null) {
        normalizeActionStateJournal(value.automaticState.actionState);
      }
    },
    restore(value) { endedEvidence = value.endedEvidence; automaticState = value.automaticState || { nextCheckAt: 0, claims: {}, actionState: null, loaded: false }; },
    idle: () => actionLeaseOwner === null && !automaticRunning,
  });
}
