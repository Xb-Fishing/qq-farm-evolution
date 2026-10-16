/**
 * 奶茶热销中（S4，2026110100 族）只读状态 + 面板手动操作服务
 *
 * 编码证据：公开血缘仓库固定提交的官方编码器重构（owner/repo/SHA 只存
 * core/data/client-config-evidence/sources.json），并与当前 ActivityService.List
 * 下发、官方公告正文交叉核对。evidence=official-encoder-reconstruction
 * （非自然成功请求样本）→ 只满足两级写操作策略第①级「面板手动层」；
 * bot 自动循环层在取得官方客户端自然成功样本前禁止接入。
 *
 * 安全边界（照 pet-diary-operate 的手动模式）：
 * - 全部操作只在面板手动触发路径执行；每次操作前重读 List + 根 GetGroup
 *   做服务端前置校验（资格/费用/次数/时间），与官方客户端行为一致。
 * - 显式查询与手动操作共用每 Worker 单例租约：忙时拒绝不排队。
 * - 钻石（1004）与未知/无法证实的费用一律拒绝；费用必须与用户确认值逐项相等。
 * - 写请求发出后传输失败、回复不匹配、解码失败 = 结果未知，不自动重试。
 * - 不开放：基金付费解锁(75)、分享上报(70)、好友链接领取、订阅/引导标记。
 * - 时间边界：结算期（公告北京 2026-11-15 00:00 起，或已解码 settle_start_time）
 *   停止营业类操作与活动专属种子购买；最终截止（根 endTime）后停止新增读取与写入。
 */

const { toNum, toLong, log } = require('../utils/utils');
const { sendMsgAsync, getWs } = require('../utils/network');
const { types } = require('../utils/proto');
const CONFIG = require('../gameConfig/MilkTeaActivity.json');
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
  'claimWages', 'interact', 'hireSetting', 'exchange', 'fundClaim', 'shareDaily', 'shareMilestones',
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

function milkTeaSummaryDto(body) {
  const summary = body && body.milk_tea && body.milk_tea.summary;
  if (!summary) return null;
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

function growthFundDto(body) {
  const fund = body && body.growth_fund;
  if (!fund) return null;
  return {
    unlocked: fund.unlocked === true,
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
function exchangeShopRichDto(body) {
  const shop = body && body.shop;
  if (!shop) return null;
  return {
    items: list(shop.goods).filter(Boolean).slice(0, 80).map(goods => ({
      id: num64(goods.id),
      name: trimTo(goods.name, 60),
      desc: trimTo(goods.desc, 200),
      order: num64(goods.order),
      rewards: itemsDto(goods.item, 10),
      costs: itemsDto(goods.cost, 10),
      purchaseLimit: num64(goods.purchase_limit),
      purchasedCount: num64(goods.purchased_count),
      diamondCostCount: num64(goods.diamond_cost_count),
      condHints: list(goods.cond_hints).filter(Boolean).slice(0, 12).map(condHintDto).filter(Boolean),
    })),
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
      const summary = milkTeaSummaryDto(decoded.main);
      if (summary) child.details = { ...(child.details || {}), milkTea: summary };
    }
    else if (toNum(child?.id) === MILK_TEA_SHOP_ACTIVITY_ID) {
      const rich = exchangeShopRichDto(decoded.shop);
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
  return { ws: currentConnection(deps) };
}

function assertConnectionOwned(deps, context) {
  if (currentConnection(deps) !== context.ws) {
    fail('SEASON_WISH_MILK_TEA_CONNECTION_CHANGED', '连接已更换，停止本次奶茶操作（请重新发起）');
  }
  if (deps && typeof deps.isReady === 'function' && deps.isReady() !== true) {
    fail('SEASON_WISH_MILK_TEA_NOT_READY', '账号未就绪，停止本次奶茶操作');
  }
}

// ---------- 低层收发 ----------

/**
 * 发送一次奶茶 Operate。context.ws 为入口捕获的连接对象；发包前复查所有权与就绪。
 * 读路径（查询）失败按普通错误抛出；写路径由调用方归类为「结果未知」。
 */
async function operateMilkTeaRequest(operation, params, deps, context) {
  const [targetId, command, selector] = operation;
  assertConnectionOwned(deps, context);
  const payload = { activity_id: toLong(targetId), operate_type: command };
  if (selector) payload[selector] = params || {};
  const request = types.MilkTeaOperateRequest.encode(
    types.MilkTeaOperateRequest.create(payload),
  ).finish();
  const { body } = await sendMsgAsync('gamepb.activitypb.ActivityService', 'Operate', request);
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
  const bag = await deps.getBag();
  for (const item of deps.getBagItems(bag) || []) {
    const id = String(num64(item && item.id));
    result.set(id, (BigInt(result.get(id) || '0') + BigInt(str64(item && item.count) || '0')).toString());
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
    shareReward: happy?.details?.shareReward ? { ...happy.details.shareReward, milestones: list(happy.details.shareReward.milestones).map(tier => ({ ...tier, rewards: list(tier.rewards).map(item => ({ ...item, itemName: getItemById(toNum(item.itemId))?.name || '未知物品' })) })) } : null,
    inventory: {
      available: inventory.available === true,
      ticketItemId: TICKET_ITEM_ID,
      boostItemId: BOOST_ITEM_ID,
      ticketCount: toNum(counts.get(TICKET_ITEM_ID)),
      boostItemCount: toNum(counts.get(BOOST_ITEM_ID)),
    },
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
  const activities = await listReader();
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
  const snapshot = await snapshotReader(MILK_TEA_ROOT_ACTIVITY_ID, '');
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
      inventory = await inventoryReader([...new Set([TICKET_ITEM_ID, BOOST_ITEM_ID, ...costIds])]);
    } catch (err) { if (err && err.business) throw err; /* 库存失败仍展示活动说明与状态，数量保持未知，不循环重试 */ }
    recheck();
  }
  const overview = buildMilkTeaOverview(snapshot, inventory, nowSec());
  recordEndedEvidence(overview.timing, overview);
  if (options.includeGameplay === true && overview.timing.phase !== 'ended') {
    overview.gameplay = await readInitialGameplay(overview, snapshot, options.deps || {}, context, nowSec);
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
      const data = await readMilkTeaQueryData(kind, {}, snapshot, deps, context, recheck);
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

async function readMilkTeaQueryData(kind, operateParams, snapshot, deps, context, recheck) {
  const operation = OPERATIONS[QUERY_KINDS[kind]];
  const reply = await operateMilkTeaRequest(operation, operateParams, deps, context);
  recheck(snapshot);
  const selector = operation[2];
  const rsp = selector ? reply[selector] : null;
  if (!rsp) {
    // 回包缺结果体：读路径普通错误（读无副作用，不标 business，不重试）
    const err = new Error('奶茶查询响应缺少预期结果');
    err.code = 'SEASON_WISH_MILK_TEA_REPLY_MISMATCH';
    throw err;
  }
  const data = kind === 'shop' ? shopViewDto(rsp.shop)
    : kind === 'hireList' ? hireListDto(rsp)
      : kind === 'workshop' ? workshopDto(rsp)
        : kind === 'work' ? workPageDto(rsp)
          : kind === 'rank' ? rankDto(rsp)
            : salesLogDto(rsp);
  if (kind === 'workshop' && data && typeof deps.getBag === 'function' && typeof deps.getBagItems === 'function') {
    const bag = await deps.getBag();
    recheck(snapshot);
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

function shopViewDto(view) {
  if (!view) return null;
  return {
    level: num64(view.level),
    totalRevenue: num64(view.total_revenue),
    nextLevelRevenue: num64(view.next_level_revenue),
    cashierCapacitySec: num64(view.cashier_capacity_sec),
    cashierElapsedSec: num64(view.cashier_elapsed_sec),
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

function hireListDto(rsp) {
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
  return {
    durationId: num64(rsp.duration_id),
    wageTotal: num64(rsp.wage_total),
    minRemainBizSec: num64(rsp.min_remain_biz_sec),
    friends: list(rsp.friends).filter(Boolean).slice(0, 80).map(friend),
    robots: list(rsp.robots).filter(Boolean).slice(0, 40).map(friend),
  };
}

function workshopDto(rsp) {
  if (!rsp) return null;
  return {
    recipes: list(rsp.recipes).filter(Boolean).slice(0, 30).map(recipe => ({
      recipeId: num64(recipe.recipe_id),
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

    const activities = await listReader();
    const rootNode = findMilkTeaRootNode(activities);
    if (!rootNode) fail('SEASON_WISH_MILK_TEA_UNAVAILABLE', '奶茶热销中未由当前 ActivityService.List 下发，停止查询');
    recheck(rootNode);
    const snapshot = await snapshotReader(MILK_TEA_ROOT_ACTIVITY_ID, '');
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
    const data = await readMilkTeaQueryData(kind, operateParams, snapshot, deps, context, recheck);
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
  try {
    const activityService = require('./activity');
    const listReader = deps.getActivityDiscoveryList || activityService.getActivityDiscoveryList;
    const snapshotReader = deps.getActivityGroupSnapshot || activityService.getActivityGroupSnapshot;
    // 连接在首个 await 前入口捕获；此后每个 await 都复查所有权/就绪，并按当前
    // 时间重核动作相位（读取途中跨入结算期/最终截止即停，零后续写）。
    const context = captureConnectionContext(deps);
    let timingSource = null;
    const recheck = () => {
      assertConnectionOwned(deps, context);
      if (timingSource) assertActionPhase(action, timingOf(timingSource, nowSec()), nowSec());
    };
    recheck();
    // 每次操作重读 List + 根状态（服务端前置校验，不用本地缓存资格）
    const activities = await listReader();
    const rootNode = findMilkTeaRootNode(activities);
    if (!rootNode) fail('SEASON_WISH_MILK_TEA_UNAVAILABLE', '奶茶热销中未由当前 ActivityService.List 下发，停止操作');
    timingSource = rootNode;
    recheck();
    const snapshot = await snapshotReader(MILK_TEA_ROOT_ACTIVITY_ID, '');
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

    const send = async (operationName, params) => {
      const operation = OPERATIONS[operationName];
      const command = operation[1];
      try {
        const reply = await operateMilkTeaRequest(operation, params, deps, context);
        // 回复选择子可与请求选择子不同（如 cmd76 空参请求、176 回复字段）
        return { ok: true, reply, selector: operation[3] || operation[2], command };
      }
      catch (err) {
        // 写前的固定拒绝（连接/就绪/编码前校验，business）原样抛出；写请求已发出
        // 之后的传输失败/解码失败/回显不匹配 = 结果未知（可能已执行），不自动重试
        if (err && err.business === true) throw err;
        throw Object.assign(new Error('奶茶操作结果未知'), { unknown: true, err });
      }
    };
    // 读侧 Operate（写前前置校验用的查询）也要在每个 await 后复查连接与相位
    const readOperate = async (operation, params) => {
      const reply = await operateMilkTeaRequest(operation, params, deps, context);
      recheck();
      return reply;
    };
    let operationName = action;
    let params = {};

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
      const slots = list(shopView && shopView.slots).filter(Boolean);
      const freeSlots = new Set(slots.filter(slot => !slot.employee && !slot.is_robot).map(slot => toNum(slot.slot_index)));
      for (const row of wanted) {
        if (!freeSlots.has(row.slotIndex)) fail('SEASON_WISH_MILK_TEA_INVALID_STATE', `槽位 ${row.slotIndex} 不可用（未解锁或已占用）`);
      }
      const hireListReply = await readOperate(OPERATIONS.queryHireList, { duration_id: durationId });
      const hireList = hireListReply && hireListReply.milk_tea_get_hire_list;
      if (!hireList || toNum(hireList.duration_id) !== durationId) fail('SEASON_WISH_MILK_TEA_NO_STATE', '雇佣候选班次与当前选择不符');
      const candidates = new Set([
        ...list(hireList && hireList.friends),
        ...list(hireList && hireList.robots),
      ].map(entry => str64(entry && entry.friend && entry.friend.gid)).filter(Boolean));
      for (const row of wanted) {
        if (!candidates.has(row.targetGid)) fail('SEASON_WISH_MILK_TEA_INVALID_STATE', '雇佣目标不在本次候选列表中，请刷新后重选');
      }
      const duration = known.get(durationId);
      const totalCost = [{ itemId: toNum(duration.cost.itemId), count: toNum(duration.cost.count) * wanted.length }];
      if (!confirmedCostsMatch(input.confirmedCosts, new Map(totalCost.map(c => [c.itemId, BigInt(c.count)])))) {
        fail('SEASON_WISH_MILK_TEA_COST_CHANGED', '费用与确认值不一致，请刷新后重新确认');
      }
      const { balances, available } = await readBalances(deps);
      recheck();
      if (!available || balanceOf(balances, totalCost[0].itemId) < BigInt(totalCost[0].count)) {
        fail('SEASON_WISH_MILK_TEA_INSUFFICIENT', '奶茶券不足，无法雇佣');
      }
      operationName = 'hire';
      params = { hires: wanted.map(row => ({ slot_index: row.slotIndex, duration_id: durationId, target_gid: toLong(row.targetGid) })) };
    }
    else if (action === 'claimCashier') {
      const shopReply = await readOperate(OPERATIONS.queryShop, {});
      const view = shopReply && shopReply.milk_tea_get_shop && shopReply.milk_tea_get_shop.shop;
      if (!view) fail('SEASON_WISH_MILK_TEA_NO_STATE', '服务端未返回收银台状态');
      if (!list(view.pending_rewards).some(item => num64(item?.id) > 0 && num64(item?.count) > 0)) fail('SEASON_WISH_MILK_TEA_NO_CLAIMABLE', '当前没有可领取的收银台收益');
    }
    else if (action === 'boost') {
      const count = inputNumber(input.count);
      if (!(Number.isInteger(count) && count >= 1 && count <= 100)) {
        fail('SEASON_WISH_MILK_TEA_INVALID_INPUT', '宣传喇叭使用数量无效');
      }
      const { balances, available } = await readBalances(deps);
      recheck();
      if (!available || balanceOf(balances, BOOST_ITEM_ID) < BigInt(count)) {
        fail('SEASON_WISH_MILK_TEA_INSUFFICIENT', `宣传喇叭不足（需要 ${count} 个）`);
      }
      const totalCost = [{ itemId: BOOST_ITEM_ID, count }];
      if (!confirmedCostsMatch(input.confirmedCosts, new Map(totalCost.map(c => [c.itemId, BigInt(c.count)])))) {
        fail('SEASON_WISH_MILK_TEA_COST_CHANGED', '费用与确认值不一致，请刷新后重新确认');
      }
      params = { count };
    }
    else if (action === 'upgrade') {
      // 升级资格以根快照摘要的 can_upgrade 为准（ShopView 回包无该字段，
      // 不再读 cmd55 后核对不存在的 can_upgrade）
      if (!summary) fail('SEASON_WISH_MILK_TEA_NO_STATE', '服务端未返回奶茶店铺状态');
      if (summary.canUpgrade !== true) fail('SEASON_WISH_MILK_TEA_INVALID_STATE', '当前营业额尚未达到升级条件');
    }
    else if (action === 'craft') {
      const fruitUids = list(input.fruitUids).map(value => str64(value)).filter(Boolean);
      if (!fruitUids.length || new Set(fruitUids).size !== fruitUids.length) {
        fail('SEASON_WISH_MILK_TEA_INVALID_INPUT', '加工果实条目无效（需唯一且非空）');
      }
      if (typeof deps.getBag !== 'function' || typeof deps.getBagItems !== 'function') {
        fail('SEASON_WISH_MILK_TEA_NO_STATE', '无法读取背包，停止加工');
      }
      const bag = await deps.getBag();
      recheck();
      const fruitIds = new Set((CONFIG.recipes || []).map(row => toNum(row.fruitItemId)).filter(id => id > 0));
      const uidToItem = new Map();
      for (const item of deps.getBagItems(bag) || []) {
        if (!fruitIds.has(num64(item?.id))) continue;
        const uid = str64(item && item.uid);
        if (!/^[1-9]\d*$/.test(uid)) continue;
        if (uidToItem.has(uid)) fail('SEASON_WISH_MILK_TEA_INVALID_STATE', '背包果实条目不唯一，停止加工');
        if (uid) uidToItem.set(uid, item);
      }
      const recipeId = toNum(input.recipeId);
      // 指定了配方就必须是已知配方：未知配方无法核对果实归属，写前拒绝
      if (recipeId > 0 && !(CONFIG.recipes || []).some(row => toNum(row.recipeId) === recipeId)) {
        fail('SEASON_WISH_MILK_TEA_INVALID_INPUT', '未知奶茶配方，停止加工');
      }
      const recipe = (CONFIG.recipes || []).find(row => toNum(row.recipeId) === recipeId) || null;
      // 配方所需果实数量是唯一核实口径：多给/少给都在写前拒绝
      if (recipe && toNum(recipe.fruitCount) > 0 && fruitUids.length !== toNum(recipe.fruitCount)) {
        fail('SEASON_WISH_MILK_TEA_INVALID_INPUT', `加工果实数量与配方不符（需 ${toNum(recipe.fruitCount)} 个）`);
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
      }
      params = { fruit_uids: fruitUids.map(uid => toLong(uid)) };
    }
    else if (action === 'claimWages') {
      const workReply = await readOperate(OPERATIONS.queryWorkPage, {});
      const work = workReply && workReply.milk_tea_get_work_page;
      if (!work) fail('SEASON_WISH_MILK_TEA_NO_STATE', '服务端未返回我的工作状态');
      const hasClaimable = summary?.hasUnclaimedWage === true
        && (list(work.slips).length > 0 || !!work.my_shift);
      if (!hasClaimable) fail('SEASON_WISH_MILK_TEA_INVALID_STATE', '当前没有可领取的工资');
    }
    else if (action === 'interact') {
      const workReply = await readOperate(OPERATIONS.queryWorkPage, {});
      const work = workReply && workReply.milk_tea_get_work_page;
      const shift = work && work.my_shift;
      if (!shift) fail('SEASON_WISH_MILK_TEA_INVALID_STATE', '当前没有进行中的班次，无法互动');
      if (toNum(input.shiftId) > 0 && str64(input.shiftId) !== str64(shift.shift_id)) {
        fail('SEASON_WISH_MILK_TEA_INVALID_STATE', '班次已变化，请刷新后重新选择');
      }
      if (work.interact_done === true || toNum(shift.interact_limit) <= 0 || toNum(shift.interact_count) >= toNum(shift.interact_limit)) {
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
      operationName = 'fundClaim';
      params = {}; // 固定来源编码：cmd76 空参数请求（176 仅为回复字段）
    }
    else if (action === 'shareDaily') {
      if (!shareReward || !shareReward.daily) fail('SEASON_WISH_MILK_TEA_NO_STATE', '服务端未返回快乐值状态');
      const daily = shareReward.daily;
      if (daily.rewardClaimed === true) fail('SEASON_WISH_MILK_TEA_CLAIMED', '今日快乐值已领取');
      if (toNum(daily.claimLimit) > 0 && toNum(daily.claimedCount) >= toNum(daily.claimLimit)) {
        fail('SEASON_WISH_MILK_TEA_LIMIT', '今日快乐值领取次数已用完');
      }
      operationName = 'shareDaily';
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
    if (action === 'shareDaily') confirmed = num64(result.granted_score) > 0 || positiveItems(result.rewards);
    else if (action === 'shareMilestones' || action === 'fundClaim') {
      const eligible = action === 'shareMilestones'
        ? list(shareReward?.milestones).filter(tier => toNum(tier.state) === 2 && toNum(shareReward.currentScore) >= toNum(tier.threshold)).map(tier => toNum(tier.id))
        : list(growthFund?.tiers).filter(tier => toNum(tier.state) === 2 && list(tier.conditions).length > 0 && tier.conditions.every(cond => cond.reached === true)).map(tier => toNum(tier.tierId));
      confirmed = claimedIds.length > 0 && new Set(claimedIds).size === claimedIds.length && claimedIds.every(id => id > 0 && eligible.includes(id));
    }
    else if (action === 'claimCashier') confirmed = positiveItems(result.items);
    else if (action === 'claimWages') confirmed = num64(result.claimed_count) > 0 || positiveItems(result.items);
    else if (action === 'createShop') confirmed = positiveItems(result.opening_gift);
    else if (action === 'exchange') confirmed = positiveItems(result.awards);
    else if (action === 'boost') confirmed = num64(result.cups) > 0;
    else if (action === 'upgrade') confirmed = num64(result.level) > 0;
    else if (action === 'craft') confirmed = mapEntries(result.crafted_cups).some(([, count]) => num64(count) > 0);
    else if (action === 'hireSetting') confirmed = result.hire_disabled === input.hireDisabled;
    if (!confirmed) return unknownOutcome(action, command, new Error('回复未确认预期动作结果'));


    if (action === 'hire') {
      const results = list(result.results).filter(Boolean).slice(0, 20).map(row => ({
        slotIndex: toNum(row.slot_index),
        durationId: toNum(row.duration_id),
        targetGid: str64(row.target_gid),
        success: row.success === true,
        errorCode: num64(row.error_code),
        errorMsg: trimTo(row.error_msg, 80),
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
    else if (action === 'shareDaily') {
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
    if (err && err.unknown === true) {
      return unknownOutcome(action, action in OPERATIONS ? OPERATIONS[action][1] : 0, err.err);
    }
    throw err;
  }
  finally {
    releaseLease(lease);
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
};
