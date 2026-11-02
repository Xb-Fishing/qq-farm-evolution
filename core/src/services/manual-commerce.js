const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const I64_MAX = 0x7FFFFFFFFFFFFFFFn;
const MAX_COUNT_PER_ORDER = 99;
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const quoteFingerprint = digest;
const fail = (message, code = 'COMMERCE_STATE') => Object.assign(new Error(message), { code });
function decimalOf(value) {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) return '';
  if (value == null || typeof value === 'boolean') return '';
  const text = String(value);
  return /^(?:0|[1-9]\d*)$/.test(text) && BigInt(text) <= I64_MAX ? text : '';
}
function assertPositiveInt(value, label, max = I64_MAX) {
  const text = decimalOf(value);
  if (!text || BigInt(text) <= 0n || BigInt(text) > BigInt(max)) throw fail(`${label}必须为范围内的正整数`, 'COMMERCE_ARGS');
  return text;
}
function assertConfirmation(request, sale = false) {
  if (typeof request?.operationId !== 'string' || !/^[\w-]{16,76}$/.test(request.operationId)) throw fail('操作标识无效', 'COMMERCE_ARGS');
  if (!sale && (typeof request.quoteFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(request.quoteFingerprint))) throw fail('确认报价无效', 'COMMERCE_ARGS');
}
function shopGoodsQuote({ goodsId, price, currencyId, itemId, itemCount, limitCount, boughtNum, requiredLevel, unlocked, conds = [] }) {
  return { goodsId: decimalOf(goodsId), price: decimalOf(price), currencyId: decimalOf(currencyId),
    itemId: decimalOf(itemId), itemCount: decimalOf(itemCount), limitCount: decimalOf(limitCount),
    boughtNum: decimalOf(boughtNum), requiredLevel: decimalOf(requiredLevel), unlocked: unlocked === true,
    conds: conds.map(row => [decimalOf(row.type), decimalOf(row.param)]) };
}
function shopPanelFields(goods, kind, requiredLevel = 0) {
  const currencyId = kind === 'decoration' || kind === 'pet' && Number(goods.item_id) === 90011 ? 1005 : 1001;
  const quote = shopGoodsQuote({ goodsId: goods.id, price: goods.price, currencyId, itemId: goods.item_id,
    itemCount: goods.item_count, limitCount: goods.limit_count, boughtNum: goods.bought_num,
    requiredLevel, unlocked: goods.unlocked, conds: goods.conds || [] });
  const valid = Object.entries(quote).filter(([key]) => !['conds', 'unlocked'].includes(key)).every(([, value]) => value !== '')
    && BigInt(quote.itemCount || 0) > 0n && quote.conds.every(([type, param]) => type === '1' && param !== '');
  return { goodsIdDec: quote.goodsId, priceDec: quote.price, itemCountDec: quote.itemCount,
    limitCountDec: quote.limitCount, boughtNumDec: quote.boughtNum, currencyId,
    quoteKnown: valid, quoteFingerprint: valid ? digest(quote) : '', shopKind: kind };
}
function getSaleQualification(itemId) {
  const config = require('../config/gameConfig');
  const info = config.getItemById(Number(itemId));
  const direct = /^(\d+):(\d+)$/.exec(String(info?.sells || ''));
  const conditional = Boolean(info?.sell_cond && !info?.sells);
  const sellable = !conditional && Boolean(direct || config.getPlantByFruitId(Number(itemId)));
  return { sellable, priceId: direct ? Number(direct[1]) : Number(info?.price_id || 0),
    price: decimalOf(direct ? direct[2] : info?.price) };
}
function bagItemQuote(id, stacks) {
  const qualification = getSaleQualification(id);
  return { id: String(id), ...qualification, stacks: stacks.filter(row => String(row.id) === String(id)).map(row => ({
    uid: decimalOf(row.uidDec ?? row.uid) || '0', count: decimalOf(row.countDec ?? row.count),
    locked: row.locked === true || row.is_locked === true,
    mutants: (row.mutantTypes || row.mutant_types || []).map(decimalOf).sort(),
  })).sort((a, b) => a.uid.localeCompare(b.uid)) };
}
function bagSaleQuote(items, prices) { return { items, prices }; }
function walletBalance(currencyId, state = require('../utils/network').getUserState()) {
  const key = { 1001: 'gold', 1002: 'coupon', 1004: 'diamond', 1005: 'goldBean' }[currencyId];
  const amount = key ? decimalOf(state?.[key]) : '';
  return { known: amount !== '', amount };
}
function requireAffordable(currency, unit, count) {
  if (unit === '0') return;
  const balance = walletBalance(currency);
  if (!balance.known) throw fail('余额未知，请刷新后确认', 'COMMERCE_BALANCE_UNKNOWN');
  if (BigInt(balance.amount) < BigInt(unit) * BigInt(count)) throw fail('余额不足，已取消交易', 'COMMERCE_INSUFFICIENT');
}
function commerceAccountKey() {
  const network = require('../utils/network');
  return digest([String(process.env.FARM_ACCOUNT_ID || ''), String(network.getUserState()?.gid || '')]).slice(0, 24);
}
function ownership() {
  const network = require('../utils/network');
  const account = commerceAccountKey();
  const ws = network.getWs();
  const epochs = () => {
    const game = globalThis.__farmSessionBridge?.readFacts()?.game;
    return game ? `${game.connectionEpoch}:${game.loginEpoch}` : '';
  };
  const epoch = epochs();
  const valid = () => account === commerceAccountKey() && network.isConnected() && ws === network.getWs() && epochs() === epoch;
  if (!valid()) throw fail('账号连接尚未就绪', 'COMMERCE_OWNER');
  return { account, key: `${account}:${epoch}`, connection: ws, valid };
}
let active = false;
async function exclusive(task) {
  if (active) throw fail('交易处理中，请勿重复提交', 'COMMERCE_BUSY');
  active = true;
  try { return await task(); } finally { active = false; }
}
function safeTarget(root, target) {
  const base = path.resolve(root); const file = path.resolve(target);
  if (!file.startsWith(base + path.sep)) throw fail('交易记录路径越界');
  for (let dir = file;; dir = path.dirname(dir)) {
    try { if (fs.lstatSync(dir).isSymbolicLink()) throw fail('交易记录路径含符号链接'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (dir === path.dirname(dir)) break;
  }
  return file;
}
function journalFile(owner) {
  const root = require('../config/runtime-paths').getDataDir();
  return safeTarget(root, path.join(root, 'manual-commerce', `${owner}.json`));
}
function readJournal(owner) {
  const file = journalFile(owner);
  let value;
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 256 * 1024) throw fail('交易记录不可读');
    value = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return { version: 1, owner, targets: {}, receipts: [] };
    throw fail('交易记录损坏或不可读，已暂停提交', 'COMMERCE_JOURNAL');
  }
  if (value?.version !== 1 || value.owner !== owner || !value.targets || Array.isArray(value.targets)
    || typeof value.targets !== 'object' || !Array.isArray(value.receipts) || value.receipts.length > 64
    || Object.keys(value.targets).length > 128 || Object.entries(value.targets).some(([key, entry]) =>
      !/^(?:mall|shop|bag):[\w:-]{1,150}$/.test(key) || !entry || !/^[a-f0-9]{64}$/.test(entry.digest)
      || !/^[a-f0-9]{64}$/.test(entry.basis) || !['declared', 'rejected'].includes(entry.status) || !Number.isSafeInteger(entry.at))) {
    throw fail('交易记录格式异常，已暂停提交', 'COMMERCE_JOURNAL');
  }
  if (value.receipts.some(row => !row || !/^[\w-]{16,82}$/.test(String(row.id)) || !/^[a-f0-9]{64}$/.test(String(row.digest)))) throw fail('交易回执格式异常', 'COMMERCE_JOURNAL');
  return value;
}
function writeJournal(owner, value) {
  const file = journalFile(owner); const dir = path.dirname(file);
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text) > 256 * 1024) throw fail('交易记录超过上限');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temp = safeTarget(require('../config/runtime-paths').getDataDir(), path.join(dir, `.${crypto.randomUUID()}.tmp`));
  try {
    const fd = fs.openSync(temp, 'wx', 0o600);
    try { fs.writeFileSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temp, file);
    const parent = fs.openSync(dir, 'r');
    try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
  } finally { fs.rmSync(temp, { force: true }); }
}
function definitelyUnsent(error) {
  return error?.isGovernedRejection === true && ['budget_total', 'budget_method'].includes(error.governedReason)
    && error.business !== true && error.isServerBusinessError !== true && error.serverErrorCode == null
    && error.unknown !== true && error.code == null;
}
async function guardedWrite(owner, keys, payload, operationId, send, confirmed, invalidate) {
  if (!/^[\w-]{16,80}$/.test(String(operationId))) throw fail('缺少有效操作标识', 'COMMERCE_ARGS');
  const requestDigest = digest(payload); const basis = digest(payload.quote || payload.quotes || payload); const journal = readJournal(owner.account);
  const receipt = journal.receipts.find(row => row.id === operationId);
  if (receipt) {
    if (receipt.digest !== requestDigest) throw fail('操作标识与内容不匹配', 'COMMERCE_ARGS');
    return { commerceConfirmed: true, replayed: true };
  }
  for (const key of keys) {
    const previous = journal.targets[key];
    if (!previous) continue;
    if (previous.status === 'rejected' && previous.basis !== basis) delete journal.targets[key];
    else throw fail('该目标有暂停或未确认交易，请刷新或在游戏内核对；不会重复发送', 'COMMERCE_PENDING');
  }
  if (Object.keys(journal.targets).length + keys.length > 128) throw fail('未确认交易已达上限');
  for (const key of keys) journal.targets[key] = { digest: requestDigest, basis, status: 'declared', at: Date.now() };
  try { writeJournal(owner.account, journal); } catch { throw fail('交易声明保存失败，已取消提交', 'COMMERCE_PERSIST'); }
  let reply;
  try {
    if (!owner.valid()) throw fail('账号连接已变化', 'COMMERCE_OWNER');
    reply = await send();
  } catch (error) {
    if (error?.isServerBusinessError === true && Number.isSafeInteger(error.serverErrorCode) && error.serverErrorCode !== 0) {
      for (const key of keys) journal.targets[key].status = 'rejected';
      try { writeJournal(owner.account, journal); } catch { /* retain the original conservative declaration */ }
      invalidate?.();
      throw fail('服务端拒绝了交易；已暂停该目标，待新鲜价格或额度变化后重新确认', 'COMMERCE_REJECTED');
    }
    if (definitelyUnsent(error)) {
      for (const key of keys) delete journal.targets[key];
      try { writeJournal(owner.account, journal); } catch { /* original declaration remains authoritative */ }
    }
    invalidate?.();
    throw fail('交易结果未确认，已停止；请刷新或在游戏内核对，不会自动重试', 'COMMERCE_UNKNOWN');
  }
  if (!confirmed(reply)) {
    invalidate?.();
    throw fail('回复未确认交易结果，已保留声明阻止重复发送', 'COMMERCE_UNKNOWN');
  }
  for (const key of keys) delete journal.targets[key];
  journal.receipts = [{ id: operationId, digest: requestDigest }, ...journal.receipts].slice(0, 64);
  try { writeJournal(owner.account, journal); } catch { /* confirmed effect remains confirmed; persistent declaration prevents repeats */ }
  if (owner.valid()) invalidate?.();
  return reply;
}
async function guardedMallPurchase(request) {
  assertConfirmation(request);
  const goodsId = assertPositiveInt(request?.goodsId, '商品ID', 0x7FFFFFFF); const count = assertPositiveInt(request?.count, '份数', 99);
  const owner = ownership();
  return exclusive(async () => {
    const mall = require('./mall');
    const list = await mall.getMallGoodsList(1);
    if (!owner.valid()) throw fail('账号连接已变化', 'COMMERCE_OWNER');
    const live = list.find(row => decimalOf(row.goods_id) === goodsId);
    const entry = live && mall.buildMallGoodsPanelEntry(live, 0);
    if (!entry || !entry.catalogMapped || !entry.enabled || entry.expired || entry.invalidReason) throw fail('商品已变化、资格未知或不可购买，请刷新', 'COMMERCE_STALE');
    if (entry.quoteFingerprint !== request.quoteFingerprint) throw fail('价格、奖励或限购已变化，请重新确认', 'COMMERCE_QUOTE_CHANGED');
    const unlimited = !entry.limit.present && live.is_limited !== true && entry.catalogRestricted === null;
    if (!unlimited && (!entry.limit.present || !entry.limit.limitCountDec || BigInt(entry.limit.limitCountDec) <= 0n)) throw fail('限购余量未知', 'COMMERCE_LIMIT');
    if (!unlimited && BigInt(entry.limit.limitCountDec) - BigInt(entry.limit.boughtNumDec) < BigInt(count)) throw fail('剩余限购数量不足', 'COMMERCE_LIMIT');
    if (!entry.isFree) requireAffordable(entry.price.currencyId, entry.price.amountDec, count);
    return guardedWrite(owner, [`mall:${goodsId}`], { goodsId, count, quote: entry.quoteFingerprint }, request.operationId,
      () => mall.purchaseMallGoods(goodsId, count), reply => decimalOf(reply?.goods_id) === goodsId && decimalOf(reply?.count) === count,
      () => { mall.invalidateMallPanelCatalog(); require('./warehouse').invalidatePanelBagCache(); });
  });
}
async function guardedShopPurchase(request) {
  assertConfirmation(request);
  const kind = request?.shopKind;
  if (!['seed', 'pet', 'decoration'].includes(kind)) throw fail('商店类型无效', 'COMMERCE_ARGS');
  const goodsId = assertPositiveInt(request.goodsId, '商品ID'); const count = assertPositiveInt(request.count, '份数', 99); const owner = ownership();
  return exclusive(async () => {
    const farm = require('./farm-api');
    let goods;
    if (kind === 'decoration') {
      if (![2130, 2131].includes(Number(goodsId))) throw fail('商品未下发', 'COMMERCE_STALE');
      const item = require('../config/gameConfig').getItemById(Number(goodsId));
      goods = { id: goodsId, item_id: goodsId, item_count: 1, price: item?.price, limit_count: 0, bought_num: 0, unlocked: true, conds: [] };
    } else {
      const reply = await farm.getShopInfo(kind === 'seed' ? 2 : 3);
      if (!owner.valid()) throw fail('账号连接已变化', 'COMMERCE_OWNER');
      goods = reply?.goods_list?.find(row => decimalOf(row.id) === goodsId);
    }
    if (!goods || goods.unlocked !== true) throw fail('商品未解锁或已下架', 'COMMERCE_STALE');
    const info = require('../config/gameConfig').getItemById(Number(goods.item_id));
    if (kind === 'seed' && Number(info?.type) !== 5 || kind === 'pet' && ![90011, 90002, 90003].includes(Number(goods.item_id))) throw fail('商品类型与当前商店不匹配', 'COMMERCE_STALE');
    let level = 0;
    for (const cond of goods.conds || []) {
      if (Number(cond.type) !== 1 || !decimalOf(cond.param)) throw fail('购买条件尚未核实', 'COMMERCE_COND');
      level = Math.max(level, Number(cond.param));
    }
    const fields = shopPanelFields(goods, kind, level);
    if (!fields.quoteKnown || fields.quoteFingerprint !== request.quoteFingerprint) throw fail('商品价格、数量或条件已变化，请刷新', 'COMMERCE_QUOTE_CHANGED');
    if (level > Number(require('../utils/network').getUserState()?.level || 0)) throw fail('等级不足', 'COMMERCE_COND');
    if (BigInt(fields.limitCountDec) > 0n && BigInt(fields.limitCountDec) - BigInt(fields.boughtNumDec) < BigInt(count)) throw fail('剩余限购数量不足', 'COMMERCE_LIMIT');
    requireAffordable(fields.currencyId, fields.priceDec, count);
    const expected = BigInt(fields.itemCountDec) * BigInt(count);
    return guardedWrite(owner, [`shop:${kind}:${goodsId}`], { kind, goodsId, count, quote: fields.quoteFingerprint }, request.operationId,
      () => farm.buyGoods(goodsId, count, fields.priceDec), reply => Array.isArray(reply?.get_items)
        && reply.get_items.some(row => decimalOf(row.id) === decimalOf(goods.item_id) && decimalOf(row.count) !== '' && BigInt(decimalOf(row.count)) === expected),
      () => require('./warehouse').invalidatePanelBagCache());
  });
}
async function guardedBagSale(request) {
  assertConfirmation(request, true);
  if (!Array.isArray(request?.items) || !request.items.length || request.items.length > 100) throw fail('出售列表无效', 'COMMERCE_ARGS');
  const items = request.items.map(row => ({ id: assertPositiveInt(row?.id, '物品ID', 0x7FFFFFFF),
    uid: row?.uid == null || row.uid === 0 || row.uid === '0' ? '0' : assertPositiveInt(row.uid, '堆栈ID'), count: assertPositiveInt(row?.count, '数量') }));
  if (new Set(items.map(row => `${row.id}:${row.uid}`)).size !== items.length) throw fail('不能重复提交同一堆栈', 'COMMERCE_ARGS');
  if (items.some(row => typeof request.quotes?.[row.id] !== 'string' || !/^[a-f0-9]{64}$/.test(request.quotes[row.id]))) throw fail('缺少库存与售价确认', 'COMMERCE_ARGS');
  const owner = ownership();
  return exclusive(async () => {
    const warehouse = require('./warehouse');
    const bag = await warehouse.getBag();
    if (!owner.valid()) throw fail('账号连接已变化', 'COMMERCE_OWNER');
    const stacks = warehouse.getBagItems(bag);
    for (const item of items) {
      const quote = bagItemQuote(item.id, stacks);
      if (!quote.sellable || !quote.price || !quote.priceId || BigInt(quote.price) <= 0n) throw fail('该物品不具备已确认的出售资格', 'COMMERCE_NOT_SELLABLE');
      if (request.quotes?.[item.id] !== digest(quote)) throw fail('背包库存或售价已变化，请重新确认', 'COMMERCE_QUOTE_CHANGED');
      const matches = quote.stacks.filter(row => row.uid === item.uid);
      if (matches.length !== 1 || matches[0].locked || !matches[0].count || BigInt(matches[0].count) < BigInt(item.count)) throw fail('堆栈已变化、锁定或数量不足', 'COMMERCE_STALE');
    }
    const groups = [];
    for (const item of items) {
      let group = groups.find(rows => !rows.some(row => row.id === item.id));
      if (!group) groups.push(group = []);
      group.push(item);
    }
    if (groups.length > 1 && request.explicitBatch !== true) throw fail('跨堆栈出售须明确确认', 'COMMERCE_ARGS');
    const journal = readJournal(owner.account);
    for (const group of groups) {
      const quotes = Object.fromEntries(group.map(row => [row.id, request.quotes[row.id]]));
      const basis = digest(quotes);
      if (group.some(row => {
        const old = journal.targets[`bag:${row.id}:${row.uid}`];
        return old && (old.status !== 'rejected' || old.basis === basis);
      })) throw fail('所选堆栈有暂停或未确认交易，已取消整批提交', 'COMMERCE_PENDING');
    }
    const replies = [];
    for (let index = 0; index < groups.length; index++) {
      const group = groups[index];
      if (!owner.valid()) throw fail('账号连接已变化，已停止后续出售', 'COMMERCE_OWNER');
      const quotes = Object.fromEntries(group.map(row => [row.id, request.quotes[row.id]]));
      const reply = await guardedWrite(owner, group.map(row => `bag:${row.id}:${row.uid}`), { items: group, quotes }, `${request.operationId}_${index}`,
        () => warehouse.sellItems(group), result => Array.isArray(result?.sell_items) && group.every(row => result.sell_items.some(sold =>
          decimalOf(sold.id) === row.id && decimalOf(sold.count) === row.count && (!decimalOf(sold.uid) || decimalOf(sold.uid) === '0' || decimalOf(sold.uid) === row.uid))),
        () => warehouse.invalidatePanelBagCache());
      if (owner.valid() && reply?.replayed !== true) {
        const total = group.reduce((sum, item) => sum + BigInt(item.count), 0n);
        if (total <= BigInt(Number.MAX_SAFE_INTEGER)) require('./stats').recordOperation('sell', Number(total));
      }
      replies.push(reply);
    }
    return replies.length === 1 ? replies[0] : replies;
  });
}
if (process.env.FARM_SESSION_BUSINESS === '1') {
  const { wrapBusinessFunction } = require('./business-state');
  guardedMallPurchase = wrapBusinessFunction('commerce:mall', guardedMallPurchase); // eslint-disable-line no-func-assign
  guardedShopPurchase = wrapBusinessFunction('commerce:shop', guardedShopPurchase); // eslint-disable-line no-func-assign
  guardedBagSale = wrapBusinessFunction('commerce:sale', guardedBagSale); // eslint-disable-line no-func-assign
}
module.exports = { guardedMallPurchase, guardedShopPurchase, guardedBagSale, decimalOf, assertPositiveInt,
  quoteFingerprint, shopGoodsQuote, shopPanelFields, bagItemQuote, bagSaleQuote, walletBalance, commerceAccountKey, ownership, MAX_COUNT_PER_ORDER };
