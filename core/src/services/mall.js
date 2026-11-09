
// Persistent-session async operation tracking.
if (globalThis.process?.env?.FARM_SESSION_BUSINESS === '1') {
  // eslint-disable-next-line no-func-assign -- Preserve the hoisted function and its existing recursive callers.
  getMallListBySlotType = require('./business-state').wrapBusinessFunction('services/mall.js:getMallListBySlotType', getMallListBySlotType);
  // eslint-disable-next-line no-func-assign -- Preserve the hoisted function and its existing recursive callers.
  purchaseMallGoods = require('./business-state').wrapBusinessFunction('services/mall.js:purchaseMallGoods', purchaseMallGoods);
  // eslint-disable-next-line no-func-assign -- Preserve the hoisted function and its existing recursive callers.
  getMallGoodsList = require('./business-state').wrapBusinessFunction('services/mall.js:getMallGoodsList', getMallGoodsList);
  // eslint-disable-next-line no-func-assign -- Preserve the hoisted function and its existing recursive callers.
  autoBuyOrganicFertilizerViaMall = require('./business-state').wrapBusinessFunction('services/mall.js:autoBuyOrganicFertilizerViaMall', autoBuyOrganicFertilizerViaMall);
  // eslint-disable-next-line no-func-assign -- Preserve the hoisted function and its existing recursive callers.
  autoBuyFertilizerViaMall = require('./business-state').wrapBusinessFunction('services/mall.js:autoBuyFertilizerViaMall', autoBuyFertilizerViaMall);
  // eslint-disable-next-line no-func-assign -- Preserve the hoisted function and its existing recursive callers.
  autoBuyOrganicFertilizer = require('./business-state').wrapBusinessFunction('services/mall.js:autoBuyOrganicFertilizer', autoBuyOrganicFertilizer);
  // eslint-disable-next-line no-func-assign -- Preserve the hoisted function and its existing recursive callers.
  autoBuyFertilizer = require('./business-state').wrapBusinessFunction('services/mall.js:autoBuyFertilizer', autoBuyFertilizer);
  // eslint-disable-next-line no-func-assign -- Preserve the hoisted function and its existing recursive callers.
  buyFreeGifts = require('./business-state').wrapBusinessFunction('services/mall.js:buyFreeGifts', buyFreeGifts);
  // eslint-disable-next-line no-func-assign -- Preserve the hoisted function and its existing recursive callers.
  checkAndBuyFertilizerByThreshold = require('./business-state').wrapBusinessFunction('services/mall.js:checkAndBuyFertilizerByThreshold', checkAndBuyFertilizerByThreshold);
  // eslint-disable-next-line no-func-assign -- Preserve the hoisted function and its existing recursive callers.
  checkAndBuyFertilizerBoth = require('./business-state').wrapBusinessFunction('services/mall.js:checkAndBuyFertilizerBoth', checkAndBuyFertilizerBoth);
  // eslint-disable-next-line no-func-assign -- Preserve the hoisted function and its existing recursive callers.
  getRegularShopForPanel = require('./business-state').wrapBusinessFunction('services/mall.js:getRegularShopForPanel', getRegularShopForPanel);
  // eslint-disable-next-line no-func-assign -- Track the complete panel read.
  getMallCatalogForPanel = require('./business-state').wrapBusinessFunction('services/mall.js:getMallCatalogForPanel', getMallCatalogForPanel);
}
/**
 * 商城服务 - 化肥购买、免费礼包领取
 *
 * 功能：
 * - 获取商城商品列表
 * - 购买商品（含价格/限购解析）
 * - 自动购买有机/无机化肥（按余额自适应）
 * - 每日免费礼包领取
 * - 根据化肥容器剩余时间阈值自动补货
 */
const { Buffer } = require('node:buffer');
const { sendMsgAsync, getUserState } = require('../utils/network');
const { types } = require('../utils/proto');
const { toNum, log, sleep } = require('../utils/utils');
const { getItemById } = require('../config/gameConfig');

// ---- 商品 ID 常量 ----

const ORGANIC_FERTILIZER_MALL_GOODS_ID = 1002;   // 有机化肥
const INORGANIC_FERTILIZER_MALL_GOODS_ID = 1003;  // 无机化肥

// 面板单次购买份数的本地安全上限（不是官方限购语义，仅防误触/防爆仓）
const MALL_PANEL_MAX_COUNT_PER_ORDER = 99;

// 两次购买最小间隔：10分钟
const BUY_COOLDOWN_MS = 10 * 60 * 1000;

// 购买轮次：100轮（防止无限循环）
const MAX_ROUNDS = 100;

// 每轮购买数量：10个
const BUY_PER_ROUND = 10;

// 每日免费礼包 Key
const FREE_GIFTS_DAILY_KEY = 'mall_free_gifts';

// ---- 状态追踪 ----

let lastBuyAt = 0;
let buyDoneDateKey = '';
let buyLastSuccessAt = 0;
let buyPausedNoGoldDateKey = '';

let freeGiftDoneDateKey = '';
let freeGiftLastAt = 0;
let freeGiftLastCheckAt = 0;

// ---- 日期工具 ----

function getDateKey() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// ---- RPC 调用 ----

async function getMallListBySlotType(slotType = 1) {
  const request = types.GetMallListBySlotTypeRequest.encode(
    types.GetMallListBySlotTypeRequest.create({ slot_type: Number(slotType) || 1 })
  ).finish();
  const { body } = await sendMsgAsync('gamepb.mallpb.MallService', 'GetMallListBySlotType', request);
  return types.GetMallListBySlotTypeResponse.decode(body);
}

// 购买参数严格校验：正整数 goodsId / count；count 同时受 int32 与本操作 99 份
// 本地上限约束。禁止 0 变 1、负数、小数、NaN——畸形参数必须就地失败。
const PURCHASE_COUNT_INT32_MAX = 0x7FFFFFFF;

function assertMallPurchaseArgs(goodsId, count) {
  const id = Number(goodsId);
  const num = Number(count);
  if (!Number.isInteger(id) || id <= 0 || id > PURCHASE_COUNT_INT32_MAX) {
    throw new Error(`商城商品参数无效: goodsId=${String(goodsId)}`);
  }
  if (!Number.isInteger(num) || num <= 0 || num > PURCHASE_COUNT_INT32_MAX || num > MALL_PANEL_MAX_COUNT_PER_ORDER) {
    throw new Error(`商城购买数量无效: count=${String(count)}（单次上限 ${MALL_PANEL_MAX_COUNT_PER_ORDER} 份）`);
  }
  return { goodsId: id, count: num };
}

async function purchaseMallGoods(goodsId, count = 1) {
  const { goodsId: safeId, count: safeCount } = assertMallPurchaseArgs(goodsId, count);
  const request = types.PurchaseRequest.encode(
    types.PurchaseRequest.create({
      goods_id: safeId,
      count: safeCount,
    })
  ).finish();
  const { body } = await sendMsgAsync('gamepb.mallpb.MallService', 'Purchase', request);
  const reply = types.PurchaseResponse.decode(body);
  invalidateMallPanelCatalog();
  return reply;
}

/**
 * 获取指定槽位的商品列表
 */
async function getMallGoodsList(slotType = 1) {
  const reply = await getMallListBySlotType(slotType);
  const rawList = Array.isArray(reply && reply.goods_list) ? reply.goods_list : [];
  const goodsList = [];
  for (const raw of rawList) {
    try {
      goodsList.push(types.MallGoods.decode(raw));
    } catch {
      throw new Error('商城目录包含无法解析的商品');
    }
  }
  return goodsList;
}

// ---- 字节解析工具 ----
// 2026-11-02：原 32 位位运算解析会在价格/限购 >2^31 时截断（截断值可能被当成
// 低价/免费），宽整数也可能因 Number 舍入失真。这里全部改为严格 protobuf
// wire 解析：BigInt 十字节 varint、截断/畸形整体判 invalid，绝不当作 0/免费。

function bytesToBuffer(value) {
  if (value == null) return null;
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array || (value.constructor && value.constructor.name === 'Uint8Array')) {
    return Buffer.from(value);
  }
  if (Array.isArray(value)) return value.every(byte => Number.isInteger(byte) && byte >= 0 && byte <= 255) ? Buffer.from(value) : null;
  if (typeof value === 'object') {
    const numKeys = Object.keys(value).filter((k) => /^\d+$/.test(k));
    numKeys.sort((a, b) => Number(a) - Number(b));
    if (numKeys.length === 0) return null;
    const bytes = numKeys.map((k) => value[k]);
    return numKeys.every((k, i) => Number(k) === i) && bytes.every(byte => Number.isInteger(byte) && byte >= 0 && byte <= 255) ? Buffer.from(bytes) : null;
  }
  return null;
}

/** 严格读取单个 varint（protobuf 上限 10 字节；截断/超长 → null 表示畸形） */
function readVarintStrict(buf, pos) {
  let value = 0n;
  for (let index = 0; index < 10; index++) {
    if (pos >= buf.length) return null; // 截断： continuation 位还在但 buffer 用尽
    const byte = buf[pos++];
    if (index === 9 && byte > 1) return null;
    value |= BigInt(byte & 0x7F) << BigInt(index * 7);
    if ((byte & 0x80) === 0) return { value, next: pos };
  }
  return null; // 超过 10 字节，畸形
}

/**
 * 严格遍历 wire 格式的 varint 字段。
 * 只收集 wireType=0 的字段值（BigInt）；结构损坏（未知 wire type / 长度越界 /
 * varint 截断）时整体判 invalid，绝不部分采信。
 */
function walkVarintFieldsStrict(buf) {
  const fields = [];
  let pos = 0;
  while (pos < buf.length) {
    const tag = readVarintStrict(buf, pos);
    if (!tag) return { ok: false, fields };
    pos = tag.next;
    const fieldNo = Number(tag.value >> 3n);
    const wireType = Number(tag.value & 7n);
    if (fieldNo <= 0 || fieldNo > 0x1FFFFFFF) return { ok: false, fields };
    fields.push({ no: fieldNo, wireType });
    if (wireType === 0) {
      const value = readVarintStrict(buf, pos);
      if (!value) return { ok: false, fields };
      pos = value.next;
      fields[fields.length - 1].value = value.value;
    } else if (wireType === 1) {
      pos += 8;
      if (pos > buf.length) return { ok: false, fields };
    } else if (wireType === 2) {
      const length = readVarintStrict(buf, pos);
      if (!length) return { ok: false, fields };
      if (length.value > BigInt(buf.length - length.next)) return { ok: false, fields };
      pos = length.next + Number(length.value);
      if (pos > buf.length) return { ok: false, fields };
    } else if (wireType === 5) {
      pos += 4;
      if (pos > buf.length) return { ok: false, fields };
    } else {
      // wire type 3/4 (group) 已废弃，6/7 非法
      return { ok: false, fields };
    }
  }
  return { ok: true, fields };
}

function bigToLegacy(value) {
  if (value < 0n) return 0;
  if (value <= BigInt(Number.MAX_SAFE_INTEGER)) return Number(value);
  return value.toString(); // 宽整数：十进制字符串返回，供确认比对，不 Number 舍入
}

function fieldMap(fields) {
  const map = new Map();
  for (const field of fields) {
    if (!map.has(field.no)) map.set(field.no, []); // 重复字段保留全部
    map.get(field.no).push(field.wireType === 0 ? field.value : null);
  }
  return map;
}

/**
 * 精确解析商城价格（corepb.Item: field 1 货币 ID, field 2 数量）。
 * 返回十进制字符串；valid=false 表示畸形/截断，调用方必须拒绝交易而不是当 0。
 */
function parseMallPriceExact(raw) {
  if (raw == null) return { valid: true, absent: true, free: false, currencyId: '0', amount: '' };
  if (typeof raw === 'number') {
    if (!Number.isSafeInteger(raw) || raw < 0) return { valid: false };
    const text = String(raw);
    return { valid: true, absent: false, free: text === '0', currencyId: '0', amount: text };
  }
  const buf = bytesToBuffer(raw);
  if (!buf) return { valid: false };
  if (!buf.length) return { valid: true, absent: true, free: false, currencyId: '0', amount: '' };
  const walk = walkVarintFieldsStrict(buf);
  if (!walk.ok) return { valid: false };
  const map = fieldMap(walk.fields);
  if (map.has(1) && map.get(1).length > 1) return { valid: false };
  if (map.has(2) && map.get(2).length > 1) return { valid: false };
  const currencyId = map.has(1) ? map.get(1)[0] : 0n;
  const amount = map.has(2) ? map.get(2)[0] : 0n;
  if (currencyId === null || amount === null || currencyId > 0x7FFFFFFFn || amount > 0x7FFFFFFFFFFFFFFFn) return { valid: false };
  if (!map.has(2) && currencyId !== 0n) return { valid: false };
  return {
    valid: true,
    absent: false,
    free: amount === 0n,
    currencyId: currencyId.toString(),
    amount: amount.toString(),
  };
}

/**
 * 精确解析限购信息（field 1 类型, field 2 已购, field 3 限购数）。
 */
function parseMallLimitExact(raw) {
  if (raw == null) return { valid: true, present: false, limitType: '0', boughtNum: '0', limitCount: '0' };
  const buf = bytesToBuffer(raw);
  if (!buf) return { valid: false };
  if (!buf.length) return { valid: true, present: false, limitType: '0', boughtNum: '0', limitCount: '0' };
  const walk = walkVarintFieldsStrict(buf);
  if (!walk.ok) return { valid: false };
  const map = fieldMap(walk.fields);
  for (const no of [1, 2, 3]) if (map.has(no) && map.get(no).length > 1) return { valid: false };
  const limitType = map.has(1) ? map.get(1)[0] : 0n;
  const boughtNum = map.has(2) ? map.get(2)[0] : 0n;
  const limitCount = map.has(3) ? map.get(3)[0] : 0n;
  if ([limitType, boughtNum, limitCount].some(value => value === null || value > 0x7FFFFFFFFFFFFFFFn)) return { valid: false };
  return {
    valid: true,
    present: true,
    limitType: limitType.toString(),
    boughtNum: boughtNum.toString(),
    limitCount: limitCount.toString(),
  };
}

/**
 * 精确解析每份商品的物品列表（MallGoods.item_ids 每项是序列化 corepb.Item）。
 * 任一元素畸形 → 整体 invalid。
 */
function parseMallItemsExact(itemIdsRaw) {
  if (itemIdsRaw == null) return { valid: true, items: [] };
  const list = Array.isArray(itemIdsRaw) ? itemIdsRaw : [itemIdsRaw];
  const items = [];
  for (const entry of list) {
    const buf = bytesToBuffer(entry);
    if (!buf || !buf.length) return { valid: false, items: [] };
    const walk = walkVarintFieldsStrict(buf);
    if (!walk.ok) return { valid: false, items: [] };
    const map = fieldMap(walk.fields);
    for (const no of [1, 2]) if (map.has(no) && map.get(no).length > 1) return { valid: false, items: [] };
    const id = map.has(1) ? map.get(1)[0] : 0n;
    const count = map.has(2) ? map.get(2)[0] : 0n;
    if (id === null || count === null || id <= 0n || id > 0x7FFFFFFFn || count <= 0n || count > 0x7FFFFFFFFFFFFFFFn) return { valid: false, items: [] };
    items.push({ id: id.toString(), count: count.toString() });
  }
  return { valid: true, items };
}

/**
 * 解析商城价格字段（旧接口兼容：小整数返回 number，宽整数返回十进制字符串）
 */
function parseMallPriceInfo(raw) {
  const exact = parseMallPriceExact(raw);
  if (!exact.valid) throw new Error('商城价格数据畸形');
  if (exact.absent) return { currencyId: 0, price: 0 };
  return {
    currencyId: bigToLegacy(BigInt(exact.currencyId)),
    price: bigToLegacy(BigInt(exact.amount)),
  };
}

function parseMallPriceValue(raw) {
  return parseMallPriceInfo(raw).price;
}

/**
 * 解析限购信息（旧接口兼容）
 */
function parseMallLimitInfo(raw) {
  const exact = parseMallLimitExact(raw);
  if (!exact.valid) throw new Error('商城限购数据畸形');
  if (!exact.present) return { limitType: 0, limitCount: 0, boughtNum: 0 };
  return {
    limitType: bigToLegacy(BigInt(exact.limitType)),
    limitCount: bigToLegacy(BigInt(exact.limitCount)),
    boughtNum: bigToLegacy(BigInt(exact.boughtNum)),
  };
}

/**
 * 解析商城物品 ID 列表（旧接口兼容）
 */
function parseMallItemIds(raw) {
  const exact = parseMallItemsExact(raw);
  return exact.valid ? exact.items.map((item) => bigToLegacy(BigInt(item.id))) : [];
}

// ---- 商品查找 ----

function findOrganicFertilizerMallGoods(goodsList) {
  const list = Array.isArray(goodsList) ? goodsList : [];
  return list.find((g) => toNum(g && g.goods_id) === ORGANIC_FERTILIZER_MALL_GOODS_ID) || null;
}

function findInorganicFertilizerMallGoods(goodsList) {
  const list = Array.isArray(goodsList) ? goodsList : [];
  return list.find((g) => toNum(g && g.goods_id) === INORGANIC_FERTILIZER_MALL_GOODS_ID) || null;
}

function findFertilizerMallGoods(goodsList, type = 'organic') {
  if (type === 'normal') return findInorganicFertilizerMallGoods(goodsList);
  return findOrganicFertilizerMallGoods(goodsList);
}

// ---- 官方静态分类目录（只读交叉参照，不制造可买库存） ----

let cachedCatalog = null;
function loadMallCatalog() {
  if (cachedCatalog) return cachedCatalog;
  cachedCatalog = require('../gameConfig/MallCatalog.json');
  return cachedCatalog;
}

// ---- 面板确认报价指纹：价格、货币、每份奖励、限购/已购与期次 ----
// 同一商品在写前 fresh 复核时指纹变化（变价/余量变化/期次变化）即拒绝，
// 由 manual-commerce 守护在购买前重算比对。

const quoteCrypto = require('node:crypto');

function buildMallQuote(entry) {
  return {
    goodsId: entry.goodsId,
    free: entry.isFree,
    currencyId: entry.price.currencyIdDec,
    amount: entry.price.amountDec,
    items: entry.items.map((item) => `${item.idDec}x${item.countDec}`).sort().join(';'),
    limitPresent: entry.limit.present,
    limitType: entry.limit.limitType,
    limitCount: entry.limit.limitCountDec,
    boughtNum: entry.limit.boughtNumDec,
    startTime: entry.startTime,
    endTime: entry.endTime,
    enabled: entry.enabled,
    zone: entry.zone,
  };
}

function mallQuoteFingerprint(quote) {
  return quoteCrypto.createHash('sha256').update(JSON.stringify(quote)).digest('hex');
}

// 仅展示已核验的日额度/商品总额度；2/3 不猜周期或重置时间。
const LIMIT_PERIOD_LABELS = new Map([[1, '每日'], [4, '总限购']]);

function getCurrencyName(currencyId) {
  const id = Number(currencyId) || 0;
  if (id === 0) return '';
  const item = getItemById(id);
  if (item && item.name) return String(item.name);
  return { 1001: '金币', 1002: '点券', 1004: '钻石', 1005: '金豆豆' }[id] || `道具#${id}`;
}

/**
 * 把服务端 slot_type=1 实际下发商品与官方静态目录交叉，产出面板条目。
 * 静态目录只用于分类/命名/限购语义佐证：当前 List 不存在的商品不会出现，
 * 未映射进官方目录的商品标记 catalogMapped=false 且禁止购买。
 */
function buildMallGoodsPanelEntry(liveGoods, sourceOrder) {
  const goodsId = toNum(liveGoods && liveGoods.goods_id);
  if (!(goodsId > 0)) return null;

  const catalog = loadMallCatalog();
  const catalogEntry = (catalog.goods || []).find((entry) => entry.id === goodsId) || null;

  const price = parseMallPriceExact(liveGoods.price);
  const limit = parseMallLimitExact(liveGoods.limit);
  const items = parseMallItemsExact(liveGoods.item_ids);

  const liveEnd = toNum(liveGoods.end_time) || 0;
  const ends = [liveEnd, catalogEntry?.endTimeSec || 0].filter(value => value > 0);
  const endTime = ends.length ? Math.min(...ends) : 0;
  const startTime = catalogEntry?.startTimeSec || 0;
  const nowSeconds = Math.floor(Date.now() / 1000);
  const isFree = liveGoods.is_free === true;

  const invalidReason = !catalogEntry || !['featured', 'packages'].includes(catalogEntry.zone) ? '商品分类尚未核实'
    : !catalogEntry.priceKnown ? '此商品须在游戏内完成广告、分享或其他资格核验'
    : !price.valid ? '价格数据畸形'
    : !limit.valid ? '限购数据畸形'
    : limit.present && !['1', '2', '3', '4'].includes(limit.limitType) ? '限购类型尚未核实'
    : !items.valid ? '奖励数据畸形'
    : (!price.absent && !isFree && price.currencyId === '0' && price.amount !== '0') ? '价格货币缺失'
    : items.items.length === 0 ? '每份奖励未知'
    : isFree && (price.absent ? catalogEntry.price?.amount !== '0' : price.amount !== '0') ? '免费标记与费用不一致'
    : !isFree && (price.absent || price.amount === '0') ? '费用状态未知'
    : liveGoods.is_limited === true && !limit.present ? '限购额度未知'
    : null;

  let soldOut = false;
  let remaining = null;
  if (limit.valid && limit.present) {
    if (BigInt(limit.limitCount) > 0n) {
      const left = BigInt(limit.limitCount) - BigInt(limit.boughtNum);
      remaining = left > 0n ? left.toString() : '0';
      soldOut = left <= 0n;
    }
    // limitCount=0：未知限额语义，remaining 保持 null（不冒充不限量）
  }

  const period = limit.valid && limit.present ? Number(limit.limitType) : 0;

  const entry = {
    goodsId,
    name: String((liveGoods.name || catalogEntry?.name || '').trim() || `商品 #${goodsId}`),
    zone: catalogEntry ? catalogEntry.zone : null, // featured | packages | null(未映射)
    slotType: catalogEntry ? catalogEntry.slotType : '',
    goodsType: catalogEntry ? catalogEntry.goodsType : null,
    catalogMapped: !!catalogEntry,
    catalogRestricted: catalogEntry ? catalogEntry.restriction : null,
    sourceOrder,
    isFree,
    price: {
      valid: price.valid,
      present: !price.absent,
      free: isFree || (price.valid && !price.absent && price.amount === '0'),
      currencyId: price.valid && !price.absent ? Number(price.currencyId) : 0,
      currencyIdDec: price.valid && !price.absent ? price.currencyId : '',
      amountDec: price.valid && !price.absent ? price.amount : '', // 精确十进制，宽整数不丢
      currencyName: price.valid && !price.absent && price.currencyId !== '0' ? getCurrencyName(price.currencyId) : '',
    },
    items: items.valid ? items.items.map((item) => ({
      id: Number(item.id),
      idDec: item.id,
      countDec: item.count,
      count: Number(item.count) <= Number.MAX_SAFE_INTEGER ? Number(item.count) : null,
      name: getItemById(Number(item.id))?.name || `物品#${item.id}`,
    })) : [],
    itemsValid: items.valid,
    limit: {
      valid: limit.valid,
      present: limit.present,
      limitType: period,
      periodLabel: LIMIT_PERIOD_LABELS.get(period) || null, // 2/3 不猜中文
      limitCountDec: limit.limitCount,
      boughtNumDec: limit.boughtNum,
      remainingDec: remaining,
    },
    soldOut,
    discount: String(liveGoods.discount || catalogEntry?.discountLabel || ''),
    isActivity: liveGoods.is_activity === true || endTime > 0,
    endTime,
    startTime,
    expired: endTime > 0 && nowSeconds >= endTime,
    enabled: (!Object.hasOwn(liveGoods, 'enabled') || liveGoods.enabled === true) && (!startTime || nowSeconds >= startTime),
    invalidReason,
  };
  entry.quote = buildMallQuote(entry);
  entry.quoteFingerprint = mallQuoteFingerprint(entry.quote);
  return entry;
}

// ---- 面板目录读取：60s 缓存 + 在途合并 + 失败冷却（写成功后失效） ----

const MALL_PANEL_CACHE_MS = 60 * 1000;
let regularPanelCache = {};
const regularPanelInFlight = new Map();
let regularOwner = null;
function invalidateRegularShopPanels() { regularPanelCache = {}; regularPanelInFlight.clear(); }
async function getRegularShopForPanel(shopId) {
  if (![1, 2, 3].includes(Number(shopId))) throw new Error('未核实的商店入口');
  const owner = require('./manual-commerce').ownership();
  if (regularOwner?.key !== owner.key || regularOwner?.connection !== owner.connection) invalidateRegularShopPanels();
  regularOwner = owner;
  const key = String(shopId); const entry = regularPanelCache[key];
  if (entry?.value && entry.until > Date.now()) return entry.value;
  if (regularPanelInFlight.has(key)) return regularPanelInFlight.get(key);
  if (entry?.retryAfter > Date.now()) throw new Error('商店读取冷却中，请稍后再试');
  const pending = (async () => {
    try {
      const raw = await require('./farm-api').getShopInfo(Number(shopId));
      if (!owner.valid()) throw new Error('账号连接已变更，请刷新');
      const value = types.ShopInfoReply.toObject(raw, { longs: String, defaults: true });
      if (regularPanelInFlight.get(key) === pending) regularPanelCache[key] = { value, until: Date.now() + MALL_PANEL_CACHE_MS };
      return value;
    } catch (error) {
      if (regularPanelInFlight.get(key) === pending && owner.valid()) regularPanelCache[key] = { retryAfter: Date.now() + MALL_PANEL_CACHE_MS };
      throw error;
    } finally { if (regularPanelInFlight.get(key) === pending) regularPanelInFlight.delete(key); }
  })();
  regularPanelInFlight.set(key, pending);
  return pending;
}
let panelCatalogCache = null;
let panelCatalogCacheAt = 0;
let panelCatalogInFlight = null;
let panelCatalogRetryAfter = 0;
let panelCatalogOwner = null;

async function buildMallPanelCatalog() {
  const goodsList = await getMallGoodsList(1);
  const catalog = loadMallCatalog();
  const zones = { featured: [], packages: [], unknown: [] };
  let malformedCount = 0;
  let unmappedCount = 0;
  for (const [sourceOrder, live] of goodsList.entries()) {
    const entry = buildMallGoodsPanelEntry(live, sourceOrder);
    if (!entry) throw new Error('商城商品缺少有效标识');
    if (entry.expired) continue;
    if (entry.invalidReason) malformedCount += 1;
    if (!entry.catalogMapped) unmappedCount += 1;
    if (entry.zone === 'featured') zones.featured.push(entry);
    else if (entry.zone === 'packages') zones.packages.push(entry);
    else zones.unknown.push(entry);
  }
  return {
    source: 'mall-service',
    rpcSlotRead: catalog.rpcSlotRead || 1,
    zones,
    malformedCount,
    unmappedCount,
    fetchedAt: Date.now(),
  };
}

function getMallCatalogForPanel() {
  const owner = require('./manual-commerce').ownership();
  if (panelCatalogOwner?.key !== owner.key || panelCatalogOwner?.connection !== owner.connection) invalidateMallPanelCatalog();
  panelCatalogOwner = owner;
  const now = Date.now();
  if (panelCatalogCache && now - panelCatalogCacheAt < MALL_PANEL_CACHE_MS) {
    return Promise.resolve(panelCatalogCache);
  }
  if (panelCatalogInFlight) return panelCatalogInFlight;
  if (now < panelCatalogRetryAfter) {
    return Promise.reject(new Error('商城目录读取冷却中，请稍后再试'));
  }
  const pending = (async () => {
    try {
      const value = await buildMallPanelCatalog();
      if (!owner.valid()) throw new Error('账号连接已变更，请刷新');
      if (panelCatalogInFlight === pending && owner.valid()) {
        panelCatalogCache = value;
        panelCatalogCacheAt = Date.now();
        panelCatalogRetryAfter = 0;
      }
      return value;
    } catch (err) {
      if (panelCatalogInFlight === pending) {
        panelCatalogRetryAfter = Date.now() + MALL_PANEL_CACHE_MS;
      }
      throw err;
    }
  })();
  panelCatalogInFlight = pending;
  return pending.finally(() => {
    if (panelCatalogInFlight === pending) panelCatalogInFlight = null;
  });
}

/** 面板商城写成功后调用：缓存失效，下一次读取重新穿透拿最新价格/余量 */
function invalidateMallPanelCatalog() {
  panelCatalogCache = null;
  panelCatalogCacheAt = 0;
  panelCatalogRetryAfter = 0;
  panelCatalogInFlight = null;
}

// ---- 自动购买 ----

/**
 * 通过商城自动购买有机化肥
 */
async function autoBuyOrganicFertilizerViaMall() {
  const goodsList = await getMallGoodsList(1);
  const goods = findOrganicFertilizerMallGoods(goodsList);
  if (!goods) return 0;

  const goodsId = toNum(goods.goods_id);
  if (goodsId <= 0) return 0;

  const price = parseMallPriceValue(goods.price);
  let ticket = Math.max(0, toNum((getUserState() || {}).ticket));
  let totalBought = 0;
  let perRound = BUY_PER_ROUND;

  // 根据余额调整每轮购买量
  if (price > 0 && ticket > 0) {
    perRound = Math.max(1, Math.min(BUY_PER_ROUND, Math.floor(ticket / price) || 1));
  }

  for (let round = 0; round < MAX_ROUNDS; round++) {
    if (price > 0 && ticket > 0 && ticket < price) {
      buyPausedNoGoldDateKey = getDateKey();
      break;
    }

    try {
      await purchaseMallGoods(goodsId, perRound);
      totalBought += perRound;

      if (price > 0 && ticket > 0) {
        ticket = Math.max(0, ticket - price * perRound);
        if (ticket < price) break;
      }
      await sleep(300);
    } catch (err) {
      const msg = String(err && err.message || '');
      log('商城', `购买化肥失败: ${msg}`, {
        module: 'warehouse', event: '购买化肥', result: 'error', error: msg,
      });

      if (msg.includes('余额不足') || msg.includes('点券不足') || msg.includes('code=1000019')) {
        if (perRound > 1) {
          perRound = 1;
          continue;
        }
        buyPausedNoGoldDateKey = getDateKey();
      }
      break;
    }
  }

  if (totalBought > 0) {
    log('商城', `购买化肥成功，共购买 ${totalBought} 个`, {
      module: 'warehouse', event: '购买化肥', result: 'ok', count: totalBought, type: 'organic', automationAction: true,
    });
  }
  return totalBought;
}

/**
 * 通过商城自动购买指定类型化肥
 */
function isAutomaticMallPaused(options) {
  return options?.automatic === true
    && require('../models/store').getPauseRemainMs(process.env.FARM_ACCOUNT_ID || '') > 0;
}

async function autoBuyFertilizerViaMall(type = 'organic', targetCount = 0, options = {}) {
  if (isAutomaticMallPaused(options)) return 0;
  const typeLabel = type === 'normal' ? '无机化肥' : '有机化肥';
  log('商城', `开始购买化肥, 类型: ${typeLabel}, 数量: ${targetCount || '不限'}`, {
    module: 'warehouse', event: '购买化肥', type, targetCount,
  });

  const goodsList = await getMallGoodsList(1);
  if (isAutomaticMallPaused(options)) return 0;
  const goods = findFertilizerMallGoods(goodsList, type);
  if (!goods) {
    log('商城', '未找到化肥商品', {
      module: 'warehouse', event: '购买化肥', result: 'error', type, error: '商品不存在',
    });
    return 0;
  }

  const goodsId = toNum(goods.goods_id);
  if (goodsId <= 0) return 0;

  const price = parseMallPriceValue(goods.price);
  let ticket = Math.max(0, toNum((getUserState() || {}).ticket));
  let totalBought = 0;
  let perRound = BUY_PER_ROUND;

  if (price > 0 && ticket > 0) {
    perRound = Math.max(1, Math.min(BUY_PER_ROUND, Math.floor(ticket / price) || 1));
  }

  log('商城', `准备购买化肥: goodsId=${goodsId}, 单价=${price}`, {
    module: 'warehouse', event: '购买化肥', goodsId, singlePrice: price, ticket, perRound,
  });

  const limit = targetCount > 0 ? targetCount : Infinity;

  for (let round = 0; round < MAX_ROUNDS; round++) {
    if (isAutomaticMallPaused(options)) break;
    if (targetCount > 0 && totalBought >= limit) break;

    if (price > 0 && ticket > 0 && ticket < price) {
      buyPausedNoGoldDateKey = getDateKey();
      break;
    }

    const buyCount = targetCount > 0 ? Math.min(perRound, limit - totalBought) : perRound;

    try {
      await purchaseMallGoods(goodsId, buyCount);
      totalBought += buyCount;

      if (price > 0 && ticket > 0) {
        ticket = Math.max(0, ticket - price * buyCount);
        if (ticket < price) break;
      }
      await sleep(300);
    } catch (err) {
      const msg = String(err && err.message || '');
      log('商城', `购买化肥失败: ${msg}`, {
        module: 'warehouse', event: '购买化肥', result: 'error', error: msg, type,
      });

      if (msg.includes('余额不足') || msg.includes('点券不足') || msg.includes('code=1000019')) {
        if (perRound > 1) {
          perRound = 1;
          continue;
        }
        buyPausedNoGoldDateKey = getDateKey();
      }
      break;
    }
  }

  if (totalBought > 0) {
    log('商城', `购买化肥成功，共购买 ${totalBought} 个`, {
      module: 'warehouse', event: '购买化肥', result: 'ok', count: totalBought, type, automationAction: true,
    });
  }

  return totalBought;
}

/**
 * 自动购买有机化肥（带冷却检查）
 */
async function autoBuyOrganicFertilizer(force = false) {
  const now = Date.now();
  if (!force && now - lastBuyAt < BUY_COOLDOWN_MS) return 0;

  lastBuyAt = now;

  try {
    const bought = await autoBuyOrganicFertilizerViaMall();
    if (bought > 0) {
      buyDoneDateKey = getDateKey();
      buyLastSuccessAt = Date.now();
      log('商城', `自动购买有机化肥 x${bought}`, {
        module: 'warehouse', event: '购买化肥', result: 'ok', count: bought,
      });
    }
    return bought;
  } catch {
    return 0;
  }
}

/**
 * 自动购买化肥（带冷却检查，通用版）
 */
async function autoBuyFertilizer(force = false, type = 'organic', targetCount = 0, options = {}) {
  if (isAutomaticMallPaused(options)) return 0;
  const now = Date.now();
  if (!force && now - lastBuyAt < BUY_COOLDOWN_MS) return 0;

  lastBuyAt = now;

  try {
    const bought = await autoBuyFertilizerViaMall(type, targetCount, options);
    if (bought > 0) {
      buyDoneDateKey = getDateKey();
      buyLastSuccessAt = Date.now();
      const label = type === 'normal' ? '无机化肥' : '有机化肥';
      log('商城', `自动购买${label} x${bought}`, {
        module: 'warehouse', event: '购买化肥', result: 'ok', count: bought, type,
      });
    }
    return bought;
  } catch {
    return 0;
  }
}

// ---- 免费礼包 ----

function isDoneTodayByKey(dateKey) {
  return String(dateKey || '') === getDateKey();
}

/**
 * 自动购买免费礼包
 */
async function buyFreeGifts(force = false) {
  const now = Date.now();

  if (!force && isDoneTodayByKey(freeGiftDoneDateKey)) return 0;
  if (!force && now - freeGiftLastCheckAt < BUY_COOLDOWN_MS) return 0;

  freeGiftLastCheckAt = now;

  try {
    // 抓包显示“每日福利”(goodsId=1001)位于 slot_type=1。
    // 旧实现请求 slot_type=2，导致自动任务无法找到免费商品。
    const reply = await getMallListBySlotType(1);
    const rawList = Array.isArray(reply && reply.goods_list) ? reply.goods_list : [];
    const goodsList = [];

    for (const raw of rawList) {
      try {
        goodsList.push(types.MallGoods.decode(raw));
      } catch {
        // skip
      }
    }

    const freeGoods = goodsList.filter(
      (g) => !!g && g.is_free === true && Number(g.goods_id || 0) > 0
    );

    if (!freeGoods.length) {
      freeGiftDoneDateKey = getDateKey();
      log('商城', '今日暂无可领取免费礼包', {
        module: 'task', event: FREE_GIFTS_DAILY_KEY, result: 'none',
      });
      return 0;
    }

    let claimed = 0;
    for (const goods of freeGoods) {
      try {
        await purchaseMallGoods(Number(goods.goods_id || 0), 1);
        claimed += 1;
      } catch {
        // skip failed
      }
    }

    freeGiftDoneDateKey = getDateKey();

    if (claimed > 0) {
      freeGiftLastAt = Date.now();
      log('商城', `自动购买免费礼包 x${claimed}`, {
        module: 'task', event: FREE_GIFTS_DAILY_KEY, result: 'ok', count: claimed,
      });
    } else {
      log('商城', '本次未成功领取免费礼包', {
        module: 'task', event: FREE_GIFTS_DAILY_KEY, result: 'none',
      });
    }

    return claimed;
  } catch (err) {
    log('商城', `领取免费礼包失败: ${err.message}`, {
      module: 'task', event: FREE_GIFTS_DAILY_KEY, result: 'error',
    });
    return 0;
  }
}

// ---- 按阈值补货 ----

/**
 * 根据化肥容器剩余时间阈值自动补货
 */
async function checkAndBuyFertilizerByThreshold(type, count, thresholdHours) {
  const { getBag, getBagItems, getContainerHoursFromBagItems } = require('./warehouse');

  if (count <= 0 || thresholdHours <= 0) {
    return { bought: 0, message: '参数无效' };
  }

  try {
    const bag = await getBag();
    const items = getBagItems(bag);
    const hours = getContainerHoursFromBagItems(items);
    const currentHours = type === 'normal' ? hours.normal : hours.organic;
    const label = type === 'normal' ? '无机化肥' : '有机化肥';

    log('商城', `检测${label}容器: 剩余 ${currentHours.toFixed(1)} 小时，阈值 ${thresholdHours} 小时`, {
      module: 'mall', event: 'check_fertilizer', type, currentHours, thresholdHours,
    });

    if (currentHours < thresholdHours) {
      const bought = await autoBuyFertilizer(true, type, count);
      return { bought, currentHours, thresholdHours, needed: true };
    }

    return { bought: 0, currentHours, thresholdHours, needed: false };
  } catch (err) {
    log('商城', `检测化肥容器失败: ${err.message}`, {
      module: 'mall', event: 'check_fertilizer', result: 'error', error: err.message,
    });
    return { bought: 0, error: err.message };
  }
}

/**
 * 同时检查并补充两种化肥
 */
async function checkAndBuyFertilizerBoth(options = {}) {
  const { getBag, getBagItems, getContainerHoursFromBagItems } = require('./warehouse');

  const {
    buyOrganic = false,
    buyNormal = false,
    organicCount = 0,
    organicThresholdHours = 0,
    normalCount = 0,
    normalThresholdHours = 0,
  } = options || {};

  const result = { organicBought: 0, normalBought: 0, organicCurrentHours: 0, normalCurrentHours: 0 };

  if (!buyOrganic && !buyNormal || isAutomaticMallPaused(options)) return result;

  try {
    const bag = await getBag();
    const items = getBagItems(bag);
    const hours = getContainerHoursFromBagItems(items);

    result.organicCurrentHours = hours.organic;
    result.normalCurrentHours = hours.normal;
    if (isAutomaticMallPaused(options)) return result;

    // 有机化肥
    if (buyOrganic && organicCount > 0 && organicThresholdHours > 0) {
      log('商城', `检测有机化肥容器: 剩余 ${hours.organic.toFixed(1)} 小时，阈值 ${organicThresholdHours} 小时`, {
        module: 'mall', event: 'check_fertilizer_organic', currentHours: hours.organic, thresholdHours: organicThresholdHours,
      });

      if (hours.organic < organicThresholdHours) {
        result.organicBought = await autoBuyFertilizer(true, 'organic', organicCount, options);
      }
    }

    // 两次购买之间随机间隔 1~3 秒
    if (buyOrganic && buyNormal && result.organicBought > 0) {
      const delay = 1000 + Math.random() * 2000;
      await sleep(delay);
    }

    if (isAutomaticMallPaused(options)) return result;
    // 无机化肥
    if (buyNormal && normalCount > 0 && normalThresholdHours > 0) {
      log('商城', `检测无机化肥容器: 剩余 ${hours.normal.toFixed(1)} 小时，阈值 ${normalThresholdHours} 小时`, {
        module: 'mall', event: 'check_fertilizer_normal', currentHours: hours.normal, thresholdHours: normalThresholdHours,
      });

      if (hours.normal < normalThresholdHours) {
        result.normalBought = await autoBuyFertilizer(true, 'normal', normalCount, options);
      }
    }

    return result;
  } catch (err) {
    log('商城', `检测化肥容器失败: ${err.message}`, {
      module: 'mall', event: 'check_fertilizer', result: 'error', error: err.message,
    });
    return { ...result, error: err.message };
  }
}

// ---- 导出 ----

module.exports = {
  autoBuyOrganicFertilizer,
  autoBuyFertilizer,
  checkAndBuyFertilizerByThreshold,
  checkAndBuyFertilizerBoth,
  buyFreeGifts,
  getMallGoodsList,
  purchaseMallGoods,
  parseMallPriceValue,
  parseMallPriceInfo,
  parseMallLimitInfo,
  parseMallItemIds,
  parseMallPriceExact,
  parseMallLimitExact,
  parseMallItemsExact,
  getRegularShopForPanel,
  invalidateRegularShopPanels,
  assertMallPurchaseArgs,
  getMallCatalogForPanel,
  invalidateMallPanelCatalog,
  loadMallCatalog,
  buildMallGoodsPanelEntry,
  buildMallQuote,
  mallQuoteFingerprint,
  MALL_PANEL_MAX_COUNT_PER_ORDER,

  getFertilizerBuyDailyState: () => ({
    key: 'fertilizer_buy',
    doneToday: buyDoneDateKey === getDateKey(),
    pausedNoGoldToday: buyPausedNoGoldDateKey === getDateKey(),
    lastSuccessAt: buyLastSuccessAt,
  }),

  getFreeGiftDailyState: () => ({
    key: FREE_GIFTS_DAILY_KEY,
    doneToday: freeGiftDoneDateKey === getDateKey(),
    lastCheckAt: freeGiftLastCheckAt,
    lastClaimAt: freeGiftLastAt,
  }),
};

// Persistent-session data capsule. No handles, functions or in-flight work.
if (globalThis.process?.env?.FARM_SESSION_BUSINESS === '1') {
  const { registerDataState } = require('./business-state');
  // panelCatalog* 为 2026-11-02 新增字段：旧 8a 检查点缺省走 optionalKeys 懒迁移
  //（恢复为空缓存，下一次面板读取重新拉取），不新增业务域、不影响 32 域总数。
  registerDataState('services/mall.js', () => ({ lastBuyAt, buyDoneDateKey, buyLastSuccessAt, buyPausedNoGoldDateKey, freeGiftDoneDateKey, freeGiftLastAt, freeGiftLastCheckAt, panelCatalogCache, panelCatalogCacheAt, panelCatalogRetryAfter, regularPanelCache }), value => {
      lastBuyAt = value.lastBuyAt;
      buyDoneDateKey = value.buyDoneDateKey;
      buyLastSuccessAt = value.buyLastSuccessAt;
      buyPausedNoGoldDateKey = value.buyPausedNoGoldDateKey;
      freeGiftDoneDateKey = value.freeGiftDoneDateKey;
      freeGiftLastAt = value.freeGiftLastAt;
      freeGiftLastCheckAt = value.freeGiftLastCheckAt;
      regularPanelCache = value.regularPanelCache ?? {};
      panelCatalogCache = value.panelCatalogCache ?? null;
      panelCatalogCacheAt = value.panelCatalogCacheAt ?? 0;
      panelCatalogRetryAfter = value.panelCatalogRetryAfter ?? 0;
  }, { optionalKeys: ['panelCatalogCache', 'panelCatalogCacheAt', 'panelCatalogRetryAfter', 'regularPanelCache'], idle: () => !panelCatalogInFlight && regularPanelInFlight.size === 0 });
}
