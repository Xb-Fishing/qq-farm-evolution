
/**
 * 奶茶自主动作（购种/班次工作/升级）纯配置与精确整数算法模块。
 *
 * 只做三件事，无网络、无持久化、无 Worker 状态，store 与 milk-tea 服务共享：
 * 1. 默认值与 failclosed 规范化（无效输入关闭购买目标，绝不把额度 0 变成默认大值）；
 * 2. 本期活动种子白名单（CONFIG.activitySeedItemIds 八项）；
 * 3. 购种份数/预算的 BigInt 精确计算。
 *
 * 金额一律用非负整数字符串承载（protobuf count 是 int64），比较用 BigInt。
 */

const CONFIG = require('../gameConfig/MilkTeaActivity.json');
const toNum = value => Number(value) || 0;

// 本期已登记八项活动种子（20525/26/27/28/29、21435、20021、29005）。
// 自动购种目标只能来自这份名单；名单外的目标一律拒绝。
const ACTIVITY_SEED_ITEM_IDS = Object.freeze((CONFIG.activitySeedItemIds || []).map(toNum).filter(id => id > 0));

// 允许自动支付的活动货币：金币 1001、奶茶券 1041。其余（含钻石 1004）零写。
const ALLOWED_AUTO_COST_ITEM_IDS = Object.freeze([1001, 1041]);

const COIN_ITEM_ID = 1001;
const TICKET_ITEM_ID = 1041;

// 工程推荐值（非官方安全保证）：库存目标 24；金币保留 100 万/日支 24 万；
// 奶茶券保留 8000/日支 0（稀有种子必须用户自己开额度）。
const DEFAULT_SEED_POLICY = Object.freeze({
    targetSeedIds: Object.freeze([]),
    targetStock: 24,
    coinReserve: '1000000',
    coinDailyLimit: '240000',
    ticketReserve: '8000',
    ticketDailyLimit: '0',
});

const MAX_TARGET_STOCK = 9999;
const MAX_TARGET_SEEDS = 8;
const INTERACTION_TYPES = new Set(CONFIG.interactionTypes.map(row => row.id));

/** 严格解析非负整数字符串；不合规返回 null（不猜、不补零）。 */
function parseExactCount(value) {
    if (typeof value === 'number') {
        return Number.isSafeInteger(value) && value >= 0 ? value.toString() : null;
    }
    if (typeof value !== 'string' || !/^\d+$/.test(value) || value.length > 20) return null;
    if (String(BigInt(value)) !== value) return null; // 拒绝 '007' 这类非规范形式
    return value;
}

/** 白名单内的正整数种子 ID 列表（去重，保持输入顺序，最多 8 项）。 */
function normalizeTargetSeedIds(raw, allowedIds = ACTIVITY_SEED_ITEM_IDS) {
    if (!Array.isArray(raw)) return null;
    const allowed = new Set(allowedIds);
    const result = [];
    for (const item of raw) {
        const n = Number(item);
        if (!Number.isSafeInteger(n) || n <= 0) return null;
        if (!allowed.has(n)) return null;
        if (!result.includes(n)) result.push(n);
        if (result.length > MAX_TARGET_SEEDS) return null;
    }
    return result;
}

/**
 * failclosed 规范化：任一字段无效时整体关闭购买目标和额度，
 * 不做部分采纳，不继续使用可能更宽的旧购买授权。
 */
function normalizeSeedPolicy(raw, prev = DEFAULT_SEED_POLICY) {
    const base = prev && typeof prev === 'object' ? prev : DEFAULT_SEED_POLICY;
    if (raw === undefined) return cloneSeedPolicy(base);
    if (raw === null) return disabledSeedPolicy();
    if (typeof raw !== 'object' || Array.isArray(raw)) return disabledSeedPolicy();
    const targetSeedIds = normalizeTargetSeedIds(raw.targetSeedIds);
    const targetStock = Number.isSafeInteger(raw.targetStock) && raw.targetStock >= 0 && raw.targetStock <= MAX_TARGET_STOCK
        ? raw.targetStock : null;
    const coinReserve = parseExactCount(raw.coinReserve);
    const coinDailyLimit = parseExactCount(raw.coinDailyLimit);
    const ticketReserve = parseExactCount(raw.ticketReserve);
    const ticketDailyLimit = parseExactCount(raw.ticketDailyLimit);
    if (targetSeedIds === null || targetStock === null || coinReserve === null
        || coinDailyLimit === null || ticketReserve === null || ticketDailyLimit === null) {
        return disabledSeedPolicy();
    }
    return {
        targetSeedIds: Object.freeze([...targetSeedIds]),
        targetStock,
        coinReserve,
        coinDailyLimit,
        ticketReserve,
        ticketDailyLimit,
    };
}

function disabledSeedPolicy() {
    return { targetSeedIds: [], targetStock: 0, coinReserve: '0', coinDailyLimit: '0', ticketReserve: '0', ticketDailyLimit: '0' };
}

function cloneSeedPolicy(policy) {
    const base = policy && typeof policy === 'object' ? policy : DEFAULT_SEED_POLICY;
    return {
        targetSeedIds: [...(base.targetSeedIds || [])],
        targetStock: Number(base.targetStock) || 0,
        coinReserve: String(base.coinReserve ?? '0'),
        coinDailyLimit: String(base.coinDailyLimit ?? '0'),
        ticketReserve: String(base.ticketReserve ?? '0'),
        ticketDailyLimit: String(base.ticketDailyLimit ?? '0'),
    };
}

/** 互动类型：正整数（默认 1，须在实际 fresh 选项中，服务侧再核）。 */
function normalizeWorkInteractionType(raw, prev = 1) {
    if (raw === undefined) return INTERACTION_TYPES.has(prev) ? prev : 0;
    if (raw === null) return 0;
    const n = Number(raw);
    if (!Number.isSafeInteger(n) || !INTERACTION_TYPES.has(n)) return 0;
    return n;
}

/** 新增奶茶自动化键的默认值（automation 平面键之外的补充默认，见 store.js）。 */
function defaultMilkTeaAutomation() {
    return {
        milk_tea_auto_seeds: false,
        milk_tea_auto_work: false,
        milk_tea_auto_upgrade: false,
        milk_tea_seed_policy: cloneSeedPolicy(DEFAULT_SEED_POLICY),
        milk_tea_work_interaction_type: 1,
    };
}

function anyMilkTeaAutoSwitchOn(automation) {
    return automation
        && (automation.milk_tea_auto_rewards === true
            || automation.milk_tea_auto_seeds === true
            || automation.milk_tea_auto_work === true
            || automation.milk_tea_auto_upgrade === true);
}

/**
 * 合并多条费用为 Map<itemId(string), BigInt>。重复同币种相加。
 * 任一条目金额非正整数即返回 null（未知费用零写）。
 */
function mergeCosts(rows) {
    if (!Array.isArray(rows)) return null;
    const totals = new Map();
    for (const row of rows) {
        if (!row || typeof row !== 'object') return null;
        const itemId = Number(row.itemId);
        const count = parseExactCount(row.count);
        if (!Number.isSafeInteger(itemId) || itemId <= 0 || count === null) return null;
        const amount = BigInt(count);
        if (amount <= 0n) return null;
        totals.set(String(itemId), (totals.get(String(itemId)) || 0n) + amount);
    }
    return totals;
}

function costMapToObject(totals) {
    const out = {};
    if (!totals) return out;
    for (const [id, amount] of totals) out[id] = amount.toString();
    return out;
}

/**
 * 计算本次自动购种份数：库存缺口/每份种子数/剩余限购/可用余额/日剩余额度/单次999 共同取最小。
 * 任一未知维度（null）直接返回 0 —— 不把未知当无限、不当 0 额度放行。
 * - stockGap：目标库存 - 当前库存（可为负，按 0 处理）
 * - seedsPerPortion：fresh 商品每份给出的目标种子颗数（>0 已确认）
 * - remainingLimit：null=限购未知（拒绝）；Infinity=已确认未限购
 * - balances/reserves：Map 或对象，itemId -> 精确整数字符串；读取失败传 null 拒绝
 * - dailyRemaining：Map 或对象，允许币种 -> 精确整数字符串；缺币种按 0
 */
function purchasePortionCount({ stockGap, seedsPerPortion, remainingLimit, unitCosts, balances, reserves, dailyRemaining, requestMax = 999 }) {
    if (!Number.isFinite(stockGap)) return 0;
    if (!Number.isSafeInteger(seedsPerPortion) || seedsPerPortion <= 0) return 0;
    if (remainingLimit !== Infinity && (!Number.isSafeInteger(remainingLimit) || remainingLimit < 0)) return 0;
    if (!Number.isSafeInteger(requestMax) || requestMax <= 0) return 0;
    let max = Math.min(requestMax, Math.floor(Math.max(0, stockGap) / seedsPerPortion));
    if (Number.isFinite(remainingLimit)) max = Math.min(max, remainingLimit);
    if (max <= 0) return 0;
    const totals = mergeCosts(unitCostsToArray(unitCosts));
    if (!totals || totals.size === 0) return 0;
    const readAmount = (source, key) => {
        if (source == null) return null;
        if (typeof source.get === 'function') return source.get(String(key));
        return source[String(key)];
    };
    for (const [id, perPortion] of totals) {
        if (!ALLOWED_AUTO_COST_ITEM_IDS.includes(Number(id))) return 0; // 仅金币/奶茶券
        const rawBalance = readAmount(balances, id);
        const balance = parseExactCount(rawBalance);
        if (balance === null) return 0; // 背包读取失败/未知：零写
        const rawReserve = readAmount(reserves, id);
        const reserve = parseExactCount(rawReserve);
        if (reserve === null) return 0;
        const available = BigInt(balance) - BigInt(reserve);
        const affordable = available <= 0n ? 0n : available / perPortion;
        if (affordable < BigInt(max)) max = Number(affordable);
        const rawDaily = readAmount(dailyRemaining, id);
        const daily = rawDaily == null ? 0n : BigInt(parseExactCount(rawDaily) ?? '0');
        const byDaily = daily <= 0n ? 0n : daily / perPortion;
        if (byDaily < BigInt(max)) max = Number(byDaily);
        if (max <= 0) return 0;
    }
    return Math.max(0, Math.min(max, requestMax));
}

// mergeCosts 接受数组；Map/对象输入先转数组
function unitCostsToArray(unitCosts) {
    if (!unitCosts) return null;
    if (Array.isArray(unitCosts)) return unitCosts;
    if (typeof unitCosts.entries === 'function') {
        return [...unitCosts.entries()].map(([itemId, count]) => ({ itemId: Number(itemId), count: count.toString() }));
    }
    if (typeof unitCosts === 'object') {
        return Object.entries(unitCosts).map(([itemId, count]) => ({ itemId: Number(itemId), count: String(count) }));
    }
    return null;
}

module.exports = {
    ACTIVITY_SEED_ITEM_IDS,
    ALLOWED_AUTO_COST_ITEM_IDS,
    COIN_ITEM_ID,
    TICKET_ITEM_ID,
    DEFAULT_SEED_POLICY,
    parseExactCount,
    normalizeTargetSeedIds,
    normalizeSeedPolicy,
    cloneSeedPolicy,
    normalizeWorkInteractionType,
    defaultMilkTeaAutomation,
    anyMilkTeaAutoSwitchOn,
    mergeCosts,
    costMapToObject,
    purchasePortionCount,
};
