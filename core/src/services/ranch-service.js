'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const codec = require('./ranch-codec');
const model = require('./ranch-model');
const feedAudit = require('./ranch-feed-reconciliation');
const friends = require('./ranch-friend');
const social = require('./ranch-social');
const handbook = require('./ranch-handbook');
const cans = require('./ranch-task-cans');
const policyTools = require('./ranch-policy');
const LOCAL_CODES = new Set(['INVALID_ARGUMENT', 'GOODS_UNAVAILABLE', 'PURCHASE_LIMIT_EXCEEDED', 'INSUFFICIENT_BALANCE']);
const error = (code, message) => Object.assign(new Error(message), { code });
const QUOTE_TTL_MS = 60000;
const EXPIRED_MESSAGE = '本次确认已到期，请重新核对数量和费用';
// Scene entry, possible AllCells fallback, view reads, and two restoration attempts.
const READ_CALLS = { animals: 5, tasks: 6, shop: 7, mallGift: 6 };
const AUTOMATION_TICK_MS = 30000;
const CLEAN_CHECK_LIMIT = 4;
const FRIEND_PANEL_TASK_ID = '300008';
const FRIEND_PANEL_TASK_RECHECK_MS = 30000;
const FRIEND_SLOTS = policyTools.SLOTS.flatMap((slot, index) => slot.friend ? [index] : []);
const AUTOMATION_LABELS = { harvest: '自动收获', produce: '自动生产', clean: '自动清理', claimTasks: '自动领取任务奖励',
  addGrass: '自动补草', place: '自动放养', buy: '自动购买', sell: '自动出售产物',
  claimMallGift: '自动领取牧场每日礼包',
  stealFriend: '自动偷取好友牧场产物', cleanFriend: '自动帮好友清理牧场' };
const automaticLabel = slot => slot?.key === 'eggSale' ? '自动出售鸡蛋（任务）' : AUTOMATION_LABELS[slot?.action];
const AUTO_STATUS = {
  full: '栏舍已满', no_facility: '没有可用设施', facility_unconfirmed: '设施或空位未确认',
  no_inventory: '没有可放养的库存幼崽', inventory_covers_vacancy: '现有库存已覆盖空位',
  inventory_reserve: '购买后仍达不到可放养的库存量', place_daily_limit: '今日放养额度已用完',
  buy_daily_limit: '今日购买额度不足', insufficient_balance: '可用余额不足', shop_limit: '商品达到限购',
  no_product: '没有适配且可购买的商品', shop_unconfirmed: '商店货架未确认', pack_exceeds_vacancy: '商品整组数量超过可补空位',
  no_grass: '可用牧草不足', grass_daily_limit: '今日补草额度已用完',
  no_animals: '暂未放养动物', grass_sufficient: '牧草已达到当前畜群的储备量',
  grass_pack_exceeds_deficit: '商品整包数量超过牧草缺口',
  farm_priority: '农场操作优先', request_budget: '本轮请求预算不足', scene_recovery: '等待农场场景恢复',
  shop_unavailable: '牧场未提供所需商店', read_failed: '本轮状态查询失败',
  no_sellable_eggs: '缺少已确认售价的未锁定鸡蛋',
  no_sellable_products: '没有可出售的剩余产物',
  no_ranch_friends: '当前没有可巡查的好友',
  no_friend_targets: '本次巡查没有可操作目标',
  friend_unavailable: '该好友的牧场尚未开放或无法访问',
  friend_quiet: '好友静默时段',
  manual_review: '等待手动确认',
  result_unconfirmed: '上一笔牧场操作待核对',
  scene_busy: '场景正在处理其他操作',
  mall_gift_claimed: '牧场每日礼包已领取', mall_gift_unavailable: '今日暂不可领取牧场礼包',
  mall_gift_unconfirmed: '牧场礼包资格待确认',
};
const AUTO_SCAN_REASONS = { RANCH_FARM_PRIORITY: 'farm_priority', RANCH_BUDGET_BUSY: 'request_budget',
  RANCH_SCENE_RECOVERING: 'scene_recovery', RANCH_SHOP_UNAVAILABLE: 'shop_unavailable',
  RANCH_BUSY: 'scene_busy', RANCH_FARM_BUSY: 'scene_busy' };
const READ_STAGES = { scene: '场景切换', scene_data: '场景数据', cells: '地块', facilityDetail: '设施详情', bag: '背包',
  shopProfiles: '商店目录', shop: '商店', mallGift: '牧场每日礼包', tasks: '任务', reportTaskProgress: '任务进度上报', state: '状态整理', friendRoster: '好友名单',
  enterFriend: '进入好友牧场', friendDetail: '好友牧场详情', leaveFriend: '离开好友牧场' };
const readStage = failure => Object.hasOwn(READ_STAGES, failure?.ranchStage) ? failure.ranchStage : 'unknown';
const readKind = failure => ['encode', 'request', 'decode', 'normalize'].includes(failure?.ranchFailureKind) ? failure.ranchFailureKind : 'unknown';
const AUTOMATION_NOT_SENT = new Set(['RANCH_AUTOMATION_PAUSED', 'RANCH_STATE_CHANGED', 'RANCH_QUOTE_EXPIRED',
  'RANCH_RESULT_UNCONFIRMED', 'RANCH_FARM_PRIORITY', 'RANCH_BUDGET_BUSY', 'RANCH_MANUAL_REVIEW', 'RANCH_NO_ELIGIBLE_TARGET']);
const AUTOMATION_RESULT_LABELS = { confirmed: '已确认', partial: '部分确认，已暂停并等待人工核对',
  unknown: '结果未知，已暂停并等待人工核对', not_sent: '请求未发出', error: '操作预检失败' };
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const planIdentity = plan => digest({ action: plan.action, route: plan.route, payload: plan.payload,
  costs: plan.costItems, rewards: plan.expectedRewards, targets: plan.resultKeys || null,
  ...(plan.upgradeTarget && { upgradeTarget: plan.upgradeTarget }), ...(plan.friendOffers && { friendOffers: plan.friendOffers }),
  ...(plan.taskSale && { taskSale: plan.taskSale }), ...(plan.mallGiftDay && { mallGiftDay: plan.mallGiftDay }) });
function sumItems(items = []) {
  const values = new Map();
  for (const item of items) {
    const parsed = model.itemDto(item); const count = BigInt(parsed.count);
    if (count <= 0n) continue;
    values.set(parsed.id, (values.get(parsed.id) || 0n) + count);
  }
  return [...values].sort(([a], [b]) => a.localeCompare(b)).map(([id, count]) => model.itemDto({ id, count }));
}
const sameItems = (a, b) => JSON.stringify(sumItems(a).map(({ id, count }) => ({ id, count })))
  === JSON.stringify(sumItems(b).map(({ id, count }) => ({ id, count })));

function automationLog(message, meta, warn = false) {
  try {
    const { log, logWarn } = require('../utils/utils');
    (warn ? logWarn : log)('牧场', message, { module: 'ranch', automationCategory: 'ranch', ...meta });
  } catch { /* Observation cannot affect an operation's result. */ }
}

function automationItemName(item) {
  const name = String(item.name).slice(0, 40);
  return policyTools.targetTypes.cubs[item.id] && !name.endsWith('幼崽') ? `${name}幼崽` : name;
}

function automationTarget({ input }, snapshot) {
  const room = snapshot.facilities.find(row => row.id === (input.ranchId || input.facilityId));
  const cub = snapshot.cubs.find(row => row.id === input.itemId);
  const product = snapshot.shop?.goods.find(row => row.id === input.goodsId)?.reward;
  return [room?.name, cub && automationItemName(cub), product && automationItemName(product)]
    .filter(Boolean).map(name => String(name).slice(0, 42)).join(' · ');
}

function automationItems(items) {
  return (items || []).slice(0, 5).map(item => ({ name: automationItemName(item), count: String(item.count) }));
}

function logAutomationResult(context, operation, fallback = 'error') {
  if (operation?.replayed) return;
  const { action, target } = context;
  const outcome = Object.hasOwn(AUTOMATION_RESULT_LABELS, operation?.outcome) ? operation.outcome : fallback;
  const completed = operation?.completed || 0;
  const requested = operation?.requested ?? context.requested;
  const costs = automationItems(operation?.costs);
  const rewards = automationItems(operation?.rewards);
  const details = [];
  if (action === 'cleanFriend' && completed > requested) details.push(`清理 ${completed} 项`);
  else if (requested || completed) details.push(`${completed}/${requested || completed} 项`);
  const format = items => items.map(item => `${item.name}×${item.count}`).join('、');
  if (costs.length) details.push(`消耗 ${format(costs)}`);
  if (rewards.length) details.push(`获得 ${format(rewards)}`);
  if (operation?.reconciliation) details.push(operation.message);
  automationLog(`${context.label || AUTOMATION_LABELS[action]}${target ? `（${target}）` : ''}${operation?.reconciliation && outcome === 'unknown' ? '待核账，程序将自动复查' : AUTOMATION_RESULT_LABELS[outcome]}${details.length ? ` · ${details.join(' · ')}` : ''}`,
    { event: 'ranch_automation_action', logKind: 'action', action, result: outcome, count: completed, completed, requested, target, costs, rewards },
    outcome !== 'confirmed');
}

/** Intents are persisted before writes; a late response or process replacement never replays them. */
function createRanchService({ network, file, now = Date.now, quoteNow = now, canAutomate = () => false,
  getFriendTargets = () => [], canVisitFriend = () => true }) {
  const sockets = new WeakMap();
  const inFlight = new Set();
  let autoRunning = false;
  function noteAutoStatus(slot, reason, revision, { friendName, failure } = {}) {
    if (reason && !Object.hasOwn(AUTO_STATUS, reason)) return;
    const failureStage = readStage(failure);
    const failureKind = readKind(failure);
    const serverErrorCode = Number.isSafeInteger(failure?.serverErrorCode) ? failure.serverErrorCode : undefined;
    const status = reason === 'read_failed' ? [reason, failureStage, failureKind, serverErrorCode].join(':') : reason;
    try {
      const data = read();
      if (data.automation?.revision !== revision) return;
      const statuses = data.automationStatuses || {};
      if (statuses[slot.key] === status) return;
      if (status) statuses[slot.key] = status;
      else delete statuses[slot.key];
      data.automationStatuses = statuses;
      save(data);
    } catch { return; /* Observation must never block or corrupt automation. */ }
    if (!reason) return;
    const target = slot.feed ? '智能供草' : slot.type === 1 ? '窝补齐' : slot.type === 2 ? '棚补齐' : automaticLabel(slot);
    const result = ['facility_unconfirmed', 'shop_unconfirmed', 'scene_recovery', 'read_failed', 'result_unconfirmed'].includes(reason) ? 'paused' : 'skipped';
    const step = reason === 'read_failed' && READ_STAGES[failureStage] ? ` · ${READ_STAGES[failureStage]}` : '';
    const subject = friendName ? `${target}（${friendName}）` : target;
    const disposition = reason === 'no_friend_targets' ? '' : '暂缓';
    automationLog(`${subject}${disposition} · ${AUTO_STATUS[reason]}${step}`,
      { event: 'ranch_automation_status', logKind: 'status', action: slot.feed ? 'smartFeed' : slot.action || 'stock', result, reason, target,
        ...(reason === 'read_failed' && { failureStage, failureKind, serverErrorCode }) }, result === 'paused');
  }
  function autoState(data) {
    const state = data.automation || { policy: { ...policyTools.DEFAULT_POLICY }, revision: 0, nextAt: 0, cursor: 0, day: '', usage: {} };
    try {
      state.policy = policyTools.normalizePolicy(state.policy, { fromStorage: true });
      state.friendNextAt ??= 0;
      state.friendCursor ??= state.friendCursors?.stealFriend ?? state.friendCursors?.cleanFriend ?? 0;
      if (!Number.isSafeInteger(state.revision) || state.revision < 0 || !Number.isSafeInteger(state.nextAt) || state.nextAt < 0
        || !Number.isSafeInteger(state.cursor) || state.cursor < 0 || !state.usage || typeof state.usage !== 'object' || Array.isArray(state.usage)
        || Object.entries(state.usage).some(([key, value]) => !/^(?:(?:buy|place|addGrass|sell):[1-9]\d*|smartFeed:(?:buy:1007|addGrass:7001))$/.test(key) || !/^\d{1,19}$/.test(String(value)))
        || !Number.isSafeInteger(state.friendNextAt) || state.friendNextAt < 0
        || !Number.isSafeInteger(state.friendCursor) || state.friendCursor < 0)
        throw new Error('Invalid automation record');
    } catch { throw error('RANCH_STORAGE_ERROR', '自动化记录不完整，已暂停执行'); }
    if (state.day !== policyTools.dayKey(now())) { state.day = policyTools.dayKey(now()); state.usage = {}; }
    return state;
  }
  function getAutomation() { return { ...autoState(read()), targetTypes: policyTools.targetTypes }; }
  function setAutomation(value) {
    const data = read(); const state = autoState(data);
    let policy;
    try { policy = policyTools.normalizePolicy(value, { previous: state.policy }); }
    catch (failure) { throw error('RANCH_INVALID_ARGUMENT', failure.message); }
    const cursor = policy.eggSale && !state.policy.eggSale ? policyTools.SLOTS.findIndex(slot => slot.key === 'eggSale')
      : policy.smartFeed && !state.policy.smartFeed ? policyTools.SLOTS.findIndex(slot => slot.feed)
        : policy.sellProducts && !state.policy.sellProducts ? policyTools.SLOTS.findIndex(slot => slot.key === 'sellProducts') : state.cursor;
    const nextAt = now() + AUTOMATION_TICK_MS;
    data.automation = { ...state, policy, revision: state.revision + 1, nextAt, friendNextAt: nextAt, cursor };
    if (!policy.enabled) delete data.automationStatuses;
    else if (data.automationStatuses) {
      for (const slot of policyTools.SLOTS) if (!policyTools.slotEnabled(policy, slot)) delete data.automationStatuses[slot.key];
    }
    save(data); return { ...data.automation, targetTypes: policyTools.targetTypes };
  }
  function manualReviewOwns(data, slot) {
    if (!slot?.type && !slot?.feed && !slot?.friend && !['sell', 'claimMallGift'].includes(slot?.action)) return false;
    return data.quotes.some(quote => {
      if (quote.autoRevision !== undefined || quote.status !== 'prepared' || quote.expiresAt <= quoteNow()) return false;
      if (['sell', 'claimMallGift'].includes(slot.action)) return quote.action === slot.action && quote.origin === origin();
      if (slot.friend) return friends.actions.has(quote.action) && quote.origin === origin();
      if (slot.feed) return (quote.action === 'addGrass' || (quote.action === 'buy'
        && String(quote.input?.shopId) === policyTools.FEED_SHOP && String(quote.input?.goodsId) === policyTools.FEED_GOODS))
        && quote.origin === origin();
      const targetType = quote.action === 'buy' ? policyTools.targetTypes.goods[quote.input?.goodsId]
        : quote.action === 'place' ? policyTools.targetTypes.cubs[quote.input?.itemId] : undefined;
      return slot.type === targetType && quote.origin === origin();
    });
  }
  function checkAutomaticAction(data, action, revision, slot, input) {
    const state = autoState(data);
    const automationSlot = policyTools.SLOTS[slot];
    if (manualReviewOwns(data, automationSlot))
      throw error('RANCH_AUTOMATION_PAUSED', automationSlot.feed ? '牧草操作正在手动确认，智能供草暂缓'
        : automationSlot.action === 'sell' ? '出售正在手动确认，自动出售暂缓'
          : automationSlot.action === 'claimMallGift' ? '礼包正在手动确认，自动领取暂缓'
          : automationSlot.friend ? '好友牧场操作正在手动确认，自动巡查暂缓' : '同类幼崽正在手动确认，智能补栏暂缓');
    if (!canAutomate() || state.revision !== revision || !policyTools.isAutomaticActionEnabled(state.policy, action, slot))
      throw error('RANCH_AUTOMATION_PAUSED', '该动作的自动化设置已变化或已由智能规则接管');
    if (automationSlot?.friend && !canVisitFriend(input?.hostGid))
      throw error('RANCH_AUTOMATION_PAUSED', '好友巡查已暂停或目标已不适用');
    return state;
  }
  function origin() {
    const socket = network.getWs();
    if (!socket || !network.isConnected()) throw error('RANCH_OFFLINE', '账号尚未连接');
    if (!sockets.has(socket)) sockets.set(socket, crypto.randomUUID());
    return `${String(network.getUserState().gid)}:${sockets.get(socket)}`;
  }
  function read() {
    try {
      const data = JSON.parse(fs.readFileSync(file(), 'utf8'));
      if (data.version !== 1 || !Array.isArray(data.quotes) || data.quotes.length > 30) throw new Error('invalid');
      return data;
    } catch (failure) {
      if (failure.code === 'ENOENT') return { version: 1, quotes: [], lastOperation: null, lastObservedAt: 0 };
      throw error('RANCH_STORAGE_ERROR', '牧场操作记录暂不可读，已停止新操作');
    }
  }
  function save(data) {
    const target = file(); fs.mkdirSync(path.dirname(target), { recursive: true });
    const temporary = `${target}.${crypto.randomUUID()}.tmp`;
    const fd = fs.openSync(temporary, 'wx', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(data)); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    try { fs.renameSync(temporary, target); } finally { fs.rmSync(temporary, { force: true }); }
  }
  function visibleOperation(value, quote) {
    if (!value) return null;
    const outcome = value.outcome === 'pending' && !inFlight.has(value.id) ? 'unknown' : value.outcome;
    const cleanReviewStatus = value.action === 'cleanFriend' && ['pending', 'unknown', 'partial'].includes(outcome)
      ? quote?.status === 'prepared' ? 'not_admitted' : value.cleanHeld ? 'deferred' : 'checking'
      : null;
    return { id: value.id, action: value.action, label: value.label, outcome, completed: value.completed || 0,
      requested: value.requested || 0, rewards: value.rewards || [], costs: value.costs || [],
      ...(value.friendGid && { friendGid: value.friendGid }),
      ...(value.reconciliation && { reconciliation: value.reconciliation }),
      ...(value.taskSaleReceipt && { taskSaleReceipt: true }),
      ...(value.cleanHeld === true && { cleanHeld: true }),
      ...(cleanReviewStatus && { cleanReview: cleanReviewStatus }),
      message: cleanReviewStatus === 'deferred' ? '程序将在后续正常访问时核对原目标，期间暂停清理这位好友的牧场'
        : cleanReviewStatus === 'checking' ? '程序将读取好友牧场自动核对，原请求保持单次执行'
          : value.message || (outcome === 'unknown' ? '上一笔操作结果尚未确认，请刷新核对后再操作' : ''), at: value.at };
  }
  function unresolved(data) {
    const op = data.lastOperation;
    return op && !(op.action === 'cleanFriend' && op.cleanHeld === true)
      && ['pending', 'unknown', 'partial'].includes(visibleOperation(op).outcome);
  }
  function ownsCleanQuote(quote, playerOrigin) {
    return quote?.action === 'cleanFriend' && typeof quote.origin === 'string'
      && quote.origin.split(':')[0] === playerOrigin.split(':')[0];
  }
  function storedCleanReceipt(data, id, playerOrigin) {
    const owner = playerOrigin.split(':')[0];
    const held = Object.entries(data.friendCleanHolds || {})
      .find(([key, hold]) => key.startsWith(`${owner}:`) && hold.result.id === id)?.[1].result;
    if (held) return held;
    const last = data.lastOperation;
    if (last?.action === 'cleanFriend' && last.id === id && data.lastCleanOwner?.id === id && data.lastCleanOwner.owner === owner)
      return last;
    return null;
  }
  function getCleanOperation(id) {
    const data = read();
    const quote = data.quotes.find(row => row.id === id);
    const currentOrigin = origin();
    if (!ownsCleanQuote(quote, currentOrigin)) {
      const stored = storedCleanReceipt(data, id, currentOrigin);
      if (stored) return visibleOperation(stored);
      throw error('RANCH_CONFIRMATION_MISSING', '清理记录暂不可用');
    }
    const result = data.lastOperation?.id === id ? data.lastOperation : quote.result;
    if (result) return visibleOperation(result, quote);
    const expired = quote.status === 'prepared' && quote.expiresAt <= quoteNow();
    return visibleOperation({ id, action: quote.action, label: quote.plan.label, friendGid: quote.input.hostGid,
      outcome: expired ? 'not_sent' : 'unknown',
      message: expired ? '确认单已过期，本次清理未发出' : '尚未发出清理，可取消本次确认单', at: quote.at }, quote);
  }
  async function stage(name, kind, callback) {
    try { return await callback(); }
    catch (failure) {
      // Only local fixed labels leave this boundary; upstream text and payloads stay private.
      if (failure && typeof failure === 'object') {
        failure.ranchStage ||= name; failure.ranchFailureKind ||= kind;
      }
      throw failure;
    }
  }
  async function rpc(routeName, payload = {}, beforeDispatch) {
    const route = codec.ROUTES[routeName]; if (!route) throw error('RANCH_INVALID_ARGUMENT', '不支持的牧场请求');
    const wire = await stage(routeName, 'encode', () => codec.encode(route.request, payload));
    const response = await stage(routeName, 'request', () => {
      if (beforeDispatch) beforeDispatch();
      return network.sendMsgAsync(route.service, route.method, wire, 2500);
    });
    return stage(routeName, 'decode', () => codec.decode(route.reply, response.body));
  }
  async function loadRaw(initial, view = 'animals', shopId = '5', manualOpen = false) {
    let cells;
    if (initial) cells = (await stage('scene_data', 'decode', () => codec.decode('SceneData', initial))).homestead_cells;
    if (!cells) cells = await rpc('cells');
    if (!Number.isInteger(cells.grid_width) || cells.grid_width <= 0 || !Number.isInteger(cells.grid_height) || cells.grid_height <= 0)
      throw error('RANCH_RESPONSE_MISMATCH', '牧场地块信息未完整提供');
    const bag = await rpc('bag', { global_scene_id: 2 });
    if (bag.global_scene_id !== 2) throw error('RANCH_RESPONSE_MISMATCH', '牧场背包场景不匹配');
    const raw = { cells, bag };
    if (view === 'shop') await loadShop(raw, shopId);
    if (view === 'tasks') raw.tasks = await rpc('tasks', { global_scene_id: 2 });
    if (view === 'mallGift') {
      const day = model.ranchDay(now());
      raw.mallGift = await rpc('mallGift', { slot_type: 6, is_manual_open: manualOpen, global_scene_id: 2 });
      if (day !== model.ranchDay(now())) throw error('RANCH_STATE_CHANGED', '牧场礼包已切换日期，请刷新后重试');
      raw.mallGiftDay = day;
      applyMallGiftAttempt(raw, read());
    }
    return raw;
  }
  async function loadShop(raw, shopId) {
    const id = model.positiveId(shopId, '商店');
    if (!['5', '6'].includes(id)) throw error('RANCH_INVALID_ARGUMENT', '不支持的牧场商店');
    const profiles = await rpc('shopProfiles', { global_scene_id: 2 });
    const profile = profiles.shop_profiles.find(row => String(row.shop_id) === id && row.global_scene_ids.includes(2));
    if (!profile) throw error('RANCH_SHOP_UNAVAILABLE', '当前牧场未提供此商店');
    raw.shopId = id;
    raw.shop = await rpc('shop', { shop_id: id });
  }
  function mallGiftAttempt(data, day) {
    const attempt = data.mallGiftAttempt;
    return attempt?.owner === String(network.getUserState().gid) && attempt.day === day ? attempt : null;
  }
  function applyMallGiftAttempt(raw, data) {
    raw.mallGiftOutcome = mallGiftAttempt(data, raw.mallGiftDay)?.outcome;
  }
  function viewFor(action, input) {
    if (action === 'claimMallGift') return 'mallGift';
    if (action === 'buy') return 'shop';
    return action === 'claimTasks' || (action === 'sell' && (input?.taskId !== undefined || input?.autoProducts === true)) ? 'tasks' : 'animals';
  }
  async function inActionScene(action, input, callback, maxCalls, activeScene) {
    if (activeScene) return callback(activeScene);
    if (!friends.actions.has(action)) return withScene(callback, maxCalls);
    return visitFriend(input.hostGid, callback);
  }
  async function visitFriend(hostGid, callback, maxCalls = 7) {
    const host = model.positiveId(hostGid, '好友');
    const self = String(network.getUserState().gid);
    if (host === self) throw error('RANCH_INVALID_ARGUMENT', '请选择好友牧场');
    const visitOrigin = origin();
    let observedFriend;
    let observedHoldId;
    const result = await withScene(async context => {
      let entered = false;
      try {
        const entry = await rpc('enterFriend', { host_gid: host, reason: 2 });
        entered = true;
        context.assertCurrent();
        friends.verifyEntry(entry, host);
        const detail = await rpc('friendDetail', { host_gid: host });
        context.assertCurrent();
        const friend = await stage('friendDetail', 'normalize', () => friends.describe(entry, detail, host, self));
        observedFriend = { ...friend, self };
        observedHoldId = read().friendCleanHolds?.[cleanHoldKey(self, host)]?.result.id;
        return await callback({ ...context, friend: { ...friend, entry, detail, self } });
      } finally {
        if (entered) {
          try { await rpc('leaveFriend', { host_gid: host }); }
          catch {
            // The scene coordinator will still restore the actor's farm in its finally.
            try { require('../utils/utils').logWarn('牧场', '好友牧场离场未确认，等待恢复原场景', { module: 'ranch', event: 'ranch_friend_leave' }); } catch {}
          }
        }
      }
    }, maxCalls);
    if (observedHoldId && !result.sceneRecoveryRequired && visitOrigin === origin()) {
      const resolved = reconcileCleanHold(observedFriend, observedHoldId);
      if (resolved && result.host === observedFriend.host) {
        result.cleanOperation = resolved;
        delete result.cleanHeld;
      }
    }
    return result;
  }
  function cleanHoldKey(owner, host) { return `${owner}:${host}`; }
  function friendCleanHeld(friend) {
    const data = read();
    return Boolean(data.friendCleanHolds?.[cleanHoldKey(friend.self, friend.host)]);
  }
  function reconcileCleanHold(friend, observedId) {
    const data = read();
    const key = cleanHoldKey(friend.self, friend.host);
    const hold = data.friendCleanHolds?.[key];
    if (hold?.result.id !== observedId || !friends.cleaningGoalMet(hold.plan, friend)) return null;
    const result = cleanAcknowledged(hold.result);
    const quote = data.quotes.find(row => row.id === hold.result.id);
    if (quote) { quote.status = result.outcome; quote.result = result; }
    if (data.lastOperation?.id === result.id) data.lastOperation = result;
    delete data.friendCleanHolds[key];
    save(data);
    logCleanAcknowledged(result);
    return visibleOperation(result);
  }
  function cleanAcknowledged(operation) {
    return { ...operation, outcome: 'acknowledged', cleanHeld: false, completed: 0, rewards: [], costs: [],
      message: '自动核对完成，原清理目标已消失，恢复正常巡查' };
  }
  function logCleanAcknowledged(operation) {
    automationLog(operation.message, { event: 'ranch_automation_status', logKind: 'status',
      action: 'cleanFriend', result: 'acknowledged', reason: 'friend_clean_reconciled' });
  }
  async function getFriend(hostGid) {
    const currentOrigin = origin();
    const previous = read();
    const op = previous.lastOperation;
    const quote = previous.quotes.find(row => row.id === op?.id);
    let goalMet = false;
    const snapshot = await visitFriend(hostGid, ({ friend }) => {
      goalMet = ownsCleanQuote(quote, currentOrigin) && friends.cleaningGoalMet(quote.plan, friend);
      return { name: friend.name, host: friend.host, stealCount: friend.stealable.length, cleanCount: friend.hazards.length,
        ...(friendCleanHeld(friend) && { cleanHeld: true }) };
    });
    if (op?.friendGid === snapshot.host && !snapshot.sceneRecoveryRequired && currentOrigin === origin()) {
      const data = read();
      if (data.lastOperation?.id === op.id && unresolved(data) && !inFlight.has(op.id)) {
        const latest = data.quotes.find(row => row.id === op.id);
        if (op.action === 'cleanFriend') {
          if (goalMet && ownsCleanQuote(latest, currentOrigin)) {
            latest.status = 'acknowledged';
            latest.result = data.lastOperation = cleanAcknowledged(data.lastOperation);
            data.lastCleanOwner = { id: op.id, owner: currentOrigin.split(':')[0] };
            save(data);
            snapshot.cleanOperation = visibleOperation(latest.result);
            logCleanAcknowledged(latest.result);
          }
        } else {
          data.lastObservedAt = now(); data.lastObservedOperationId = op.id;
          save(data);
        }
      }
    }
    return snapshot;
  }
  async function loadAction(initial, action, input, assertCurrent, rechecking = false, autoSlot, autoRevision, friend, activeScene) {
    if (friend && social.ACTIONS.has(action)) return { raw: null, plan: friend.taskPlan };
    if (friend) {
      if (action === 'cleanFriend' && friendCleanHeld(friend))
        throw error('RANCH_RESULT_UNCONFIRMED', '本好友上次清理结果仍未知，原目标消失后才能再次清理');
      return { raw: null, plan: friends.plan(action, friend) };
    }
    const raw = activeScene?.taskRaw || await loadRaw(initial, viewFor(action, input), input.shopId);
    assertCurrent();
    if (activeScene?.taskPlan?.action === action) return { raw, plan: activeScene.taskPlan };
    try {
      const stockType = action === 'place' && policyTools.SLOTS[autoSlot]?.type;
      if (stockType) {
        const { policy, usage } = checkAutomaticAction(read(), action, autoRevision, autoSlot);
        const state = model.normalizeState(raw, now());
        if (policyTools.chooseStock(policy, state, stockType, usage).needsShop === 'place') {
          await loadShop(raw, policyTools.STOCK_SHOP);
          assertCurrent();
        }
      }
      if (action === 'upgrade') {
        const facility = model.selectedFacility(raw.cells.facilities, input.facilityId);
        if (facility.state !== 1) throw error('RANCH_UPGRADE_UNAVAILABLE', '设施尚未建成或未就绪');
        raw.facilityDetail = (await rpc('facilityDetail', { instance_id: String(facility.instance_id) })).info;
        assertCurrent();
      }
      return { raw, plan: model.planAction(action, input, raw, now()) };
    } catch (failure) {
      if (rechecking && action === 'sell' && failure.code === 'RANCH_NO_ELIGIBLE_TARGET')
        throw error('RANCH_STATE_CHANGED', '可售产物或报价已变化，请重新核对');
      if (rechecking && ['upgrade', 'completeUpgrade'].includes(action)
        && ['RANCH_FACILITY_NOT_FOUND', 'RANCH_UPGRADE_UNAVAILABLE', 'RANCH_UPGRADE_PENDING', 'RANCH_PRICE_UNKNOWN', 'INSUFFICIENT_BALANCE'].includes(failure.code))
        throw error('RANCH_STATE_CHANGED', `${failure.message}，请重新核对`);
      throw failure;
    }
  }
  function validateInput(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || JSON.stringify(input).length > 6000)
      throw error('RANCH_INVALID_ARGUMENT', '操作参数无效');
    if (input.count !== undefined && model.positiveCount(input.count) > 999) throw error('RANCH_INVALID_ARGUMENT', '单次数量不能超过999');
    for (const key of ['targets', 'taskIds']) if (input[key] && (!Array.isArray(input[key]) || input[key].length > 50))
      throw error('RANCH_INVALID_ARGUMENT', '本次目标数量过多，请分次操作');
  }
  async function withScene(callback, maxCalls = 10) {
    if (typeof network.withRanchScene !== 'function') throw error('RANCH_CONNECTION_UPDATE_REQUIRED', '当前连接尚未支持牧场，请更新程序后重试');
    return stage('scene', 'request', () => network.withRanchScene(callback, { maxCalls }));
  }
  async function reportFriendPanel() {
    const accountOrigin = origin();
    const owner = model.positiveId(accountOrigin.split(':')[0], '玩家');
    const observed = read().friendPanelTask;
    if (observed?.owner === owner && observed.completed === true) return { completed: true };

    return withScene(async ({ assertCurrent }) => {
      const taskFrom = reply => reply?.task_info && model.taskList(reply)?.find(task =>
        task.id === FRIEND_PANEL_TASK_ID && task.category === 'growth' && task.total === '1');
      const isComplete = task => task?.claimed === true || task?.canClaim === true;
      const stillCurrent = () => {
        assertCurrent();
        if (origin() !== accountOrigin) throw error('RANCH_SESSION_CHANGED', '账号连接已变化，请重新打开好友牧场');
      };
      const confirm = () => {
        stillCurrent();
        const data = read();
        data.friendPanelTask = { owner, completed: true };
        save(data);
        return { completed: true };
      };
      const getTask = async () => taskFrom(await rpc('tasks', { global_scene_id: 2 }));
      const task = await getTask();
      stillCurrent();
      if (isComplete(task)) return confirm();
      if (!task?.unlocked || task.progress !== '0') return { completed: false };

      const previous = read().friendPanelTask;
      // Recheck progress on the next open and give a possibly delivered request time to settle.
      if (previous?.owner === owner && quoteNow() - previous.at < FRIEND_PANEL_TASK_RECHECK_MS)
        return { completed: false };
      const reply = await rpc('reportTaskProgress', { task_id: FRIEND_PANEL_TASK_ID, progress: '1' }, () => {
        stillCurrent();
        const data = read();
        data.friendPanelTask = { owner, at: quoteNow() };
        save(data);
      });
      return isComplete(taskFrom(reply)) || isComplete(await getTask()) ? confirm() : { completed: false };
    }, READ_CALLS.tasks);
  }
  async function getState(view = 'animals', shopId = '5', scan, manualOpen = false) {
    if (!Object.hasOwn(READ_CALLS, view)) throw error('RANCH_INVALID_ARGUMENT', '牧场页面无效');
    const observedId = read().lastOperation?.id;
    return withScene(async ({ initial, assertCurrent }) => {
      const raw = await loadRaw(initial, view, shopId, manualOpen); assertCurrent();
      let snapshot = await stage('state', 'normalize', () => model.normalizeState(raw, now()));
      const needsShop = scan?.feed ? policyTools.chooseSmartFeed(scan.policy, snapshot).needsShop
        : scan?.type && policyTools.chooseStock(scan.policy, snapshot, scan.type, scan.usage).needsShop;
      if (needsShop) {
        await loadShop(raw, scan.feed ? policyTools.FEED_SHOP : policyTools.STOCK_SHOP);
        assertCurrent();
        snapshot = await stage('state', 'normalize', () => model.normalizeState(raw, now()));
      }
      const data = read();
      const reconciled = reconcileObserved(data, raw, observedId);
      const giftReconciled = reconcileMallGift(data, raw, observedId);
      if (!data.lastOperation?.friendGid && (data.lastOperation?.action !== 'claimMallGift' || raw.mallGift != null)) {
        data.lastObservedAt = now();
        data.lastObservedOperationId = data.lastOperation?.id === observedId ? observedId || null : null;
      }
      save(data);
      logFeedCheck(reconciled);
      if (giftReconciled) automationLog(giftReconciled.message, { event: 'ranch_mall_gift_reconciled',
        action: 'claimMallGift', result: giftReconciled.outcome });
      const operation = data.lastOperation;
      const quote = data.quotes.find(row => row.id === operation?.id);
      const playerOrigin = operation?.action === 'cleanFriend' ? origin() : null;
      const visible = !playerOrigin || ownsCleanQuote(quote, playerOrigin) || storedCleanReceipt(data, operation.id, playerOrigin);
      return { ...snapshot, view, lastOperation: visible ? visibleOperation(operation, quote) : null };
    }, READ_CALLS[scan ? 'shop' : view]);
  }
  async function prepare(action, input = {}, autoRevision, autoSlot, activeScene) {
    if (!['buy', 'place', 'addGrass', 'produce', 'harvest', 'clean', 'sell', 'claimTasks', 'claimMallGift', 'upgrade', 'completeUpgrade'].includes(action)
      && !friends.actions.has(action) && !(social.ACTIONS.has(action) && activeScene?.friend?.taskPlan)
      && !(Object.hasOwn(cans.ROUTES, action) && activeScene?.taskPlan?.action === action))
      throw error('RANCH_INVALID_ARGUMENT', '不支持的牧场操作');
    validateInput(input);
    const accountOrigin = origin();
    const previous = read();
    if (unresolved(previous)) throw error('RANCH_RESULT_UNCONFIRMED', previous.lastOperation.action === 'cleanFriend'
      ? '程序正在核对上一次好友牧场清理' : '上一笔操作结果待核对，请先刷新并确认');
    if (autoRevision !== undefined) checkAutomaticAction(previous, action, autoRevision, autoSlot, input);
    const prepared = await inActionScene(action, input, async ({ initial, assertCurrent, friend }) => {
      const { raw, plan } = await loadAction(initial, action, input, assertCurrent, false, autoSlot, autoRevision, friend, activeScene);
      if (origin() !== accountOrigin) throw error('RANCH_SESSION_CHANGED', '账号连接已变化，请重新确认');
      if (plan.count > 50 && ['place', 'produce', 'harvest', 'clean', 'claimTasks'].includes(action))
        throw error('RANCH_INVALID_ARGUMENT', '本次目标数量过多，请分次操作');
      const issuedAt = quoteNow();
      const quote = { id: crypto.randomUUID(), action, input, plan, fingerprint: planIdentity(plan), origin: accountOrigin,
        at: issuedAt, expiresAt: issuedAt + QUOTE_TTL_MS, status: 'prepared' };
      const data = read(); if (unresolved(data)) throw error('RANCH_RESULT_UNCONFIRMED', '上一笔操作尚未确认');
      if (autoRevision !== undefined) {
        const state = checkAutomaticAction(data, action, autoRevision, autoSlot, input);
        if (!policyTools.allowance(state.policy, plan, raw, state.usage, autoSlot, now()))
          throw error('RANCH_AUTOMATION_PAUSED', '自动化设置或可用额度已变化');
        quote.autoRevision = autoRevision;
        if (autoSlot !== undefined) quote.autoSlot = autoSlot;
      }
      data.quotes = data.quotes.filter(row => row.status !== 'prepared' || row.expiresAt > quoteNow()).slice(-19);
      data.quotes.push(quote); save(data);
      return { id: quote.id, action, label: plan.label, count: plan.count,
        costItems: action === 'sell' ? sumItems(plan.costItems) : plan.costItems, expectedRewards: sumItems(plan.expectedRewards), expiresAt: quote.expiresAt };
    }, READ_CALLS[policyTools.SLOTS[autoSlot]?.type ? 'shop' : viewFor(action, input)] + (action === 'upgrade' ? 1 : 0), activeScene);
    // Device clocks can differ from the game clock. Report time left after scene restoration.
    return { ...prepared, validForMs: Math.min(QUOTE_TTL_MS, Math.max(0, prepared.expiresAt - quoteNow())) };
  }
  function verifyReply(plan, reply, before, after, afterFriend) {
    if (Object.hasOwn(cans.ROUTES, plan.action)) return cans.verifyStep(plan, before, reply, after);
    const unknown = message => { throw error('RANCH_RESULT_UNKNOWN', message); };
    let rewards = []; let costs = plan.costItems; let completed = plan.count;
    if (plan.action === 'claimMallGift') {
      if (reply.success !== true || reply.goods_id !== plan.payload.goods_id
        || !model.dailyMallLimit(reply.purchase_limit, '1') || !model.mallGiftReward(reply.reward_items))
        unknown('礼包回执未完全匹配，请刷新商城核对领取状态');
      rewards = reply.reward_items;
    } else if (plan.action === 'buy') {
      if (String(reply.goods?.id) !== plan.payload.goods_id || !sameItems(reply.cost_items, plan.costItems)
        || !sameItems(reply.get_items, plan.expectedRewards)) unknown('购买回执的商品、费用或数量未完全匹配，请核对库存');
      rewards = reply.get_items;
    } else if (plan.action === 'sell') {
      const stacks = rows => JSON.stringify((rows || []).map(row => [String(row.id), String(row.uid), String(row.count)])
        .sort((a, b) => a[1].localeCompare(b[1])));
      if (stacks(reply.sell_items) !== stacks(plan.payload.items) || !sameItems(reply.get_items, plan.expectedRewards))
        unknown('出售回执的产物、数量或所得未完全匹配，请刷新核对');
      rewards = reply.get_items;
    } else if (social.ACTIONS.has(plan.action)) {
      ({ rewards, completed } = social.verify(plan, reply, afterFriend));
    } else if (friends.actions.has(plan.action)) {
      ({ rewards, completed } = friends.verify(plan, reply));
    } else if (plan.action === 'claimTasks') {
      rewards = reply.items || [];
      if (!sameItems(rewards, plan.expectedRewards)) unknown('任务奖励回执未完全匹配，请核对领取状态');
      const remaining = model.normalizeState({ ...before, tasks: reply }, now()).tasks;
      if (remaining.some(row => plan.payload.ids.includes(row.id) && !row.claimed)) unknown('任务仍显示未领取，请核对结果');
    } else if (plan.upgradeTarget) {
      const target = plan.upgradeTarget;
      const matchesTarget = row => String(row?.instance_id) === target.instanceId && row.facility_id === target.toId && row.level === target.toLevel;
      const current = after && model.selectedFacility(after.cells.facilities, target.instanceId);
      if (plan.action === 'upgrade') {
        const start = reply.upgrade;
        if (String(start?.inst_id) !== target.instanceId || start.target_facility_id !== target.toId || start.target_level !== target.toLevel)
          unknown('升级回执的设施或目标等级不匹配，请刷新核对');
        const progressing = current?.facility_id === target.fromId && current.level === target.fromLevel && [1, 2].includes(current.upgrade_state);
        if (!progressing && !matchesTarget(current)) unknown('设施尚未显示本次升级，请刷新核对');
      } else if (!matchesTarget(reply.facility) || (after && !matchesTarget(current))) {
        unknown('设施实际等级与升级目标不匹配，请刷新核对');
      }
    } else if (plan.action === 'addGrass') {
      if (!sameItems(reply.consumed, plan.costItems)) unknown('补草扣除回执未匹配，请核对牧草数量');
    } else {
      if (!Array.isArray(reply.op_results) || !reply.op_results.length) unknown('游戏尚未返回明确完成的目标');
      const keys = reply.op_results.map(row => `${row.facility_inst_id}:${row.kind}:${row.target_id}`);
      if (new Set(keys).size !== keys.length) unknown('游戏回执包含重复目标');
      if (plan.action === 'place' && reply.op_results.length !== plan.count) unknown('放养数量未匹配，请核对栏舍');
      if (plan.action === 'place') {
        const target = plan.payload.items[0];
        const prior = before.cells.facilities.find(row => String(row.instance_id) === target.ranch_inst_id)?.ranch;
        const current = after?.cells.facilities.find(row => String(row.instance_id) === target.ranch_inst_id)?.ranch;
        for (const row of reply.op_results) {
          const animal = current?.animals.find(value => String(value.animal_inst_id) === String(row.target_id));
          if (String(row.facility_inst_id) !== target.ranch_inst_id || row.kind !== 1
            || !animal || String(animal.animal_id) !== target.animal_id
            || prior?.animals.some(value => String(value.animal_inst_id) === String(row.target_id)))
            unknown('放养回执与新增动物或目标栏舍不匹配，请核对结果');
        }
      }
      if (plan.resultKeys) {
        const facilities = new Map(before.cells.facilities.map(row => [String(row.instance_id), row]));
        for (const [index, key] of keys.entries()) {
          if (plan.resultKeys.includes(key)) continue;
          const row = reply.op_results[index]; const facility = facilities.get(String(row.facility_inst_id));
          const knownAnimal = row.kind === 1 && facility?.ranch?.animals.some(animal => String(animal.animal_inst_id) === String(row.target_id));
          const knownShelf = row.kind === 2 && facility?.ranch?.shelves.some(shelf => String(shelf.slot_index) === String(row.target_id));
          const allAction = plan.payload.op === 1 || plan.action === 'produce' && !plan.payload.targets.length;
          if (allAction && (knownAnimal || plan.action === 'harvest' && knownShelf)) continue;
          if (plan.action === 'clean' && row.kind === 3 && plan.payload.ranch_inst_ids.includes(String(row.facility_inst_id))) continue;
          unknown('回执目标超出本次操作范围');
        }
      }
      completed = reply.op_results.length;
      rewards = reply.op_results.flatMap(row => row.rewards || []);
      if (!costs.length) {
        try { costs = sumItems(reply.op_results.flatMap(row => row.costs || [])); }
        catch { /* Missing cost evidence must not undo a confirmed game result. */ }
      }
    }
    if (['place', 'addGrass', 'upgrade'].includes(plan.action)) {
      if (!after) unknown('写入已回复，但新库存未能读取，请刷新核对');
      for (const cost of plan.costItems) if (BigInt(model.balance(before.bag, cost.id).total) - BigInt(model.balance(after.bag, cost.id).total) !== BigInt(cost.count))
        unknown('库存变化与本次费用未匹配，请核对结果');
    }
    const success = { upgrade: '已开始升级，到时可在设施卡完成升级', completeUpgrade: '设施升级已完成' };
    const partial = completed < plan.count && plan.action !== 'cleanFriend';
    return { outcome: partial ? 'partial' : 'confirmed', completed, requested: plan.count,
      rewards: sumItems(rewards), costs, message: partial ? `已确认 ${completed} 项，其余状态发生变化，请刷新核对` : success[plan.action] || '操作已确认' };
  }
  function checkQuote(data, quote, id) {
    if (!quote) {
      if (data.lastOperation?.id === id && data.lastOperation.action !== 'cleanFriend')
        return { ...visibleOperation(data.lastOperation), replayed: true };
      if ((data.friendCleanHolds || data.lastCleanOwner?.id === id) && network.isConnected()) {
        const stored = storedCleanReceipt(data, id, origin());
        if (stored) return { ...visibleOperation(stored), replayed: true };
      }
      throw error('RANCH_CONFIRMATION_MISSING', '确认记录已失效，请刷新牧场核对结果');
    }
    if (quote.status !== 'prepared') {
      if (quote.action === 'cleanFriend' && (!network.isConnected() || !ownsCleanQuote(quote, origin())))
        throw error('RANCH_CONFIRMATION_MISSING', '清理记录暂不可用');
      const result = quote.result || (data.lastOperation?.id === id && data.lastOperation);
      if (!result) throw error('RANCH_RESULT_UNCONFIRMED', '执行结果待核对，请刷新牧场');
      return { ...visibleOperation(result, quote), replayed: true };
    }
    if (unresolved(data)) throw error('RANCH_RESULT_UNCONFIRMED', '上一笔操作结果待核对');
    if (quote.origin !== origin()) throw error('RANCH_SESSION_CHANGED', '账号连接已变化，请刷新牧场后重新选择操作');
    if (quote.expiresAt <= quoteNow()) throw error('RANCH_QUOTE_EXPIRED', EXPIRED_MESSAGE);
    return null;
  }
  async function execute(id, markOperationNotSent, activeScene) {
    if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)) throw error('RANCH_INVALID_ARGUMENT', '确认记录无效');
    let data = read(); let quote = data.quotes.find(row => row.id === id);
    const replay = checkQuote(data, quote, id);
    if (replay) return replay;
    if (social.ACTIONS.has(quote.action) && (!activeScene?.friend?.taskPlan || !activeScene.taskAdmission))
      throw error('RANCH_INVALID_ARGUMENT', '请从成长手册执行该任务');
    if (Object.hasOwn(cans.ROUTES, quote.action) && (!activeScene?.taskPlan || !activeScene.taskAdmission))
      throw error('RANCH_INVALID_ARGUMENT', '请从成长手册使用罐头');
    if (quote.autoRevision !== undefined) checkAutomaticAction(data, quote.action, quote.autoRevision, quote.autoSlot, quote.input);
    let operationAttempted = false;
    return inActionScene(quote.action, quote.input, async ({ initial, assertCurrent, friend }) => {
      const { raw: before, plan } = await loadAction(initial, quote.action, quote.input, assertCurrent, true, quote.autoSlot, quote.autoRevision,
        friend, activeScene);
      data = read(); quote = data.quotes.find(row => row.id === id);
      const settled = checkQuote(data, quote, id);
      if (settled) return settled;
      if (planIdentity(plan) !== quote.fingerprint) throw error('RANCH_STATE_CHANGED', '数量、费用或目标状态已变化，请重新核对');
      if (quote.autoRevision !== undefined) {
        const state = checkAutomaticAction(data, quote.action, quote.autoRevision, quote.autoSlot, quote.input);
        if (!policyTools.allowance(state.policy, plan, before, state.usage, quote.autoSlot, now()))
          throw error('RANCH_AUTOMATION_PAUSED', '自动化已暂停或超出费用上限');
        // Reserve before dispatch, in the same durable record as the operation intent.
        for (const cost of plan.costItems) {
          const key = `${policyTools.SLOTS[quote.autoSlot]?.feed ? 'smartFeed:' : ''}${plan.action}:${cost.id}`;
          state.usage[key] = (BigInt(state.usage[key] || 0) + BigInt(cost.count)).toString();
        }
        data.automation = state;
        quote.autoReservation = { day: state.day, costs: plan.costItems };
      }
      if (plan.mallGiftDay && (plan.mallGiftDay !== model.ranchDay(now()) || mallGiftAttempt(data, plan.mallGiftDay)))
        throw error('RANCH_STATE_CHANGED', '牧场礼包领取状态或日期已变化，请刷新后再核对');
      assertCurrent();
      const baseline = feedAudit.capture(plan, before, quoteNow());
      if (!baseline && plan.action === 'addGrass') throw error('RANCH_STATE_CHANGED', '牧草机数据尚未完整，待刷新后再投喂');
      if (baseline) quote.feedBefore = { ...baseline, owner: String(network.getUserState().gid) };
      const pending = { id, action: quote.action, label: plan.label, outcome: 'pending', at: now(), requested: plan.count,
        ...(friend && { friendGid: friend.host }) };
      quote.status = 'pending'; quote.result = pending; data.lastOperation = pending;
      if (quote.action === 'cleanFriend') data.lastCleanOwner = { id, owner: friend.self };
      if (plan.mallGiftDay) data.mallGiftAttempt = { id, owner: String(network.getUserState().gid), day: plan.mallGiftDay, outcome: 'unknown' };
      save(data); inFlight.add(id);
      let result; let reply; let after = null; let expiredBeforeDispatch = false;
      try {
        try {
          reply = await rpc(plan.route, plan.payload, () => {
            // Persistence and encoding can outlast the preview; only this refusal proves no dispatch.
            if (quote.expiresAt <= quoteNow()) {
              expiredBeforeDispatch = true;
              throw error('RANCH_QUOTE_EXPIRED', EXPIRED_MESSAGE);
            }
            if (quote.autoRevision !== undefined) {
              const latest = read();
              const state = autoState(latest);
              if (manualReviewOwns(latest, policyTools.SLOTS[quote.autoSlot]) || !canAutomate() || state.revision !== quote.autoRevision || state.day !== quote.autoReservation.day
                || !policyTools.isAutomaticActionEnabled(state.policy, plan.action, quote.autoSlot)
                || (friend && !canVisitFriend(friend.host)))
                throw Object.assign(error('RANCH_AUTOMATION_PAUSED', '自动化设置或额度日期已变化'), { isLocalRequestRejection: true });
            }
            if (plan.mallGiftDay && plan.mallGiftDay !== model.ranchDay(now()))
              throw Object.assign(error('RANCH_STATE_CHANGED', '牧场礼包已切换日期，请刷新后重试'), { isLocalRequestRejection: true });
            if (activeScene?.taskAdmission && !activeScene.taskAdmission())
              throw Object.assign(error('RANCH_AUTOMATION_PAUSED', '任务资格或好友巡查设置已变化'), { isLocalRequestRejection: true });
            assertCurrent();
            operationAttempted = true;
          });
        }
        catch (failure) {
          const local = expiredBeforeDispatch || failure.isLocalRequestRejection === true || failure.isGovernedRejection === true
            || /^SESSION_(?:CONFIG_CHANGED|EPOCH_RETIRED|CONNECTION_CHANGED|BINDING_REVOKED)$/.test(failure.code || '');
          result = { ...pending, outcome: local ? 'not_sent' : 'unknown', completed: 0,
            message: local ? '本次请求未发出，请刷新后重试' : '请求结果尚未确认，不会自动重试；请刷新核对' };
        }
        let receiptProof;
        if (reply || (baseline && operationAttempted && result?.outcome === 'unknown')) {
          let afterFriend;
          if (plan.action === 'placeMosquito') {
            try {
              afterFriend = await rpc('friendDetail', { host_gid: friend.host });
              assertCurrent();
            } catch { afterFriend = null; }
          }
          if (!friend) {
            const view = plan.taskSale ? 'tasks' : plan.mallGiftDay ? 'mallGift' : 'animals';
            try { after = await loadRaw(null, view); assertCurrent(); } catch { after = null; }
          }
          if (baseline) {
            receiptProof = feedAudit.receiptEvidence(plan, reply);
            const comparison = feedAudit.compare(plan, baseline, receiptProof, after, quoteNow());
            result = feedResult(quote, comparison, pending);
          } else {
            try {
              result = { ...pending, ...verifyReply(plan, reply, before, after, afterFriend) };
              if (plan.taskSale && !taskSaleProgressReached(plan, after)) {
                result.outcome = 'unknown';
                result.taskSaleReceipt = true;
                result.message = '鸡蛋已出售，任务进度待自动刷新；不会重复出售';
              }
            }
            catch (failure) { result = { ...pending, outcome: 'unknown', completed: 0, message: failure.message }; }
          }
        }
        result ||= { ...pending, outcome: 'unknown', completed: 0, message: '操作结果尚未确认' };
        if (after) {
          if (plan.action === 'claimTasks') after.tasks = reply;
          if (plan.action === 'buy' && before.shop) {
            try { after.shop = await rpc('shop', { shop_id: before.shopId }); after.shopId = before.shopId; } catch { /* Keep the confirmed purchase and refreshable inventory. */ }
          }
        }
        if (after?.mallGiftDay === plan.mallGiftDay && plan.mallGiftDay && result.outcome === 'confirmed')
          after.mallGiftOutcome = 'confirmed';
        let snapshot = null;
        try { if (after) snapshot = model.normalizeState(after, now()); } catch { /* Preserve a confirmed write when the refreshed DTO is invalid. */ }

        // Read the latest ledger after refresh so a policy saved while awaiting it survives.
        data = read(); quote = data.quotes.find(row => row.id === id);
        if (result.outcome === 'not_sent' && quote?.autoReservation && data.automation?.day === quote.autoReservation.day) {
          for (const cost of quote.autoReservation.costs) {
            const key = `${policyTools.SLOTS[quote.autoSlot]?.feed ? 'smartFeed:' : ''}${quote.action}:${cost.id}`;
            const remaining = BigInt(data.automation.usage[key] || 0) - BigInt(cost.count);
            data.automation.usage[key] = (remaining > 0n ? remaining : 0n).toString();
          }
        }
        if (quote) {
          quote.status = result.outcome; quote.result = result;
          if (receiptProof) quote.feedReceipt = receiptProof;
        }
        data.lastOperation = result;
        if (plan.mallGiftDay && data.mallGiftAttempt?.id === id) {
          if (result.outcome === 'not_sent') delete data.mallGiftAttempt;
          else if (result.outcome === 'confirmed') data.mallGiftAttempt.outcome = 'confirmed';
        }
        if (snapshot && !plan.mallGiftDay) { data.lastObservedAt = now(); data.lastObservedOperationId = id; }
        try { save(data); } catch { result.storageWarning = true; }
        if (plan.action === 'sell' && result.outcome === 'confirmed') {
          try {
            const { log } = require('../utils/utils');
            const income = result.rewards.map(row => `${row.name}×${row.count}`).join('、');
            log('牧场', `出售牧场产物已确认 · ${result.completed} 批 · 收益 ${income}`, { module: 'ranch', event: 'ranch_sell_confirmed' });
          } catch { /* Logging does not determine sale confirmation. */ }
        }
        if (expiredBeforeDispatch) {
          if (result.storageWarning) throw error('RANCH_RESULT_UNCONFIRMED', '确认结果未能保存，请刷新牧场核对');
          throw error('RANCH_QUOTE_EXPIRED', EXPIRED_MESSAGE);
        }
        if (plan.mallGiftDay && quote?.autoRevision === undefined && result.outcome === 'confirmed') {
          automationLog(`牧场每日礼包已领取 · ${result.rewards[0].name}×${result.rewards[0].count}`, { event: 'ranch_mall_gift_claimed', action: 'claimMallGift', source: 'manual' });
        }
        if (friend && quote?.autoRevision === undefined && result.outcome === 'confirmed' && !result.replayed) {
          try { require('../utils/utils').log('牧场', `${plan.label}已确认 · ${result.completed} 项`, { module: 'ranch', event: 'ranch_friend_action' }); } catch {}
        }
        const cleanReview = plan.action === 'cleanFriend' && visibleOperation(result, quote).cleanReview;
        return { ...result, ...(cleanReview && { cleanReview }), snapshot,
          refreshRequired: !snapshot && !friend, message: !snapshot && !friend && result.outcome === 'confirmed' ? '操作已确认，页面刷新失败，请稍后刷新' : result.message };
      } finally { inFlight.delete(id); }
    }, undefined, activeScene).catch(failure => {
      if (!operationAttempted && (failure?.isGovernedRejection === true
        || (failure?.isLocalRequestRejection === true && failure.outcome === 'not_sent'))) {
        markOperationNotSent(id);
      }
      throw failure;
    });
  }
  function acknowledge(id) {
    if (id && typeof id === 'object' && typeof id.feedReceiptId === 'string' && /^[a-f0-9-]{36}$/.test(id.feedReceiptId)) {
      const receiptId = id.feedReceiptId;
      const data = read();
      const quote = data.quotes.find(row => row.id === receiptId);
      if (!quote) {
        if (data.lastOperation?.id === receiptId) {
          if (data.lastOperation.action === 'cleanFriend') throw error('RANCH_INVALID_ARGUMENT', '此单据不属于牧草核账');
          return visibleOperation(data.lastOperation);
        }
        return { id: receiptId, outcome: 'replanned', completed: 0, message: '旧单据已失效，按当前库存继续，原单不会重发' };
      }
      if (!(quote.action === 'addGrass' || (quote.action === 'buy' && String(quote.input?.shopId) === '6'
        && String(quote.input?.goodsId) === '10001'))) throw error('RANCH_INVALID_ARGUMENT', '此单据不属于牧草核账');
      if (quote.status === 'prepared') cancel(receiptId);
      return visibleOperation(read().quotes.find(row => row.id === receiptId)?.result);
    }
    const data = read(); const op = visibleOperation(data.lastOperation);
    const quote = data.quotes.find(row => row.id === id);
    // A lost HTTP admission can leave only an unconsumed quote. Explicitly
    // cancel it so an older preflight can never dispatch after this response.
    if (!unresolved(data) && !inFlight.has(id)) {
      if (quote?.action === 'cleanFriend' && !ownsCleanQuote(quote, origin()))
        throw error('RANCH_CONFIRMATION_MISSING', '清理记录暂不可用');
      if (quote?.status === 'cancelled' && quote.result?.outcome === 'not_sent') return visibleOperation(quote.result);
      if (quote?.status === 'prepared' && cancel(id).cancelled)
        return visibleOperation(read().quotes.find(row => row.id === id).result);
    }
    if (!op || op.id !== id || !['unknown', 'partial'].includes(op.outcome) || inFlight.has(id))
      throw error('RANCH_INVALID_ARGUMENT', '没有可核对的未确认结果');
    if (op.action === 'cleanFriend') throw error('RANCH_AUTO_RECONCILING', '程序正在自动核对好友牧场清理');
    if (op.taskSaleReceipt) throw error('RANCH_AUTO_RECONCILING', '鸡蛋出售已确认，程序将自动刷新任务进度');
    if (quote?.feedBefore || quote?.action === 'addGrass' || op.reconciliation) {
      throw error('RANCH_AUTO_RECONCILING', '牧草账目由程序自动读取并核对');
    }
    if (data.lastObservedOperationId !== op.id)
      throw error('RANCH_REFRESH_REQUIRED', op.friendGid ? '请先刷新本次操作的好友牧场并核对'
        : op.action === 'claimMallGift' ? '请先刷新牧场每日礼包并核对领取状态' : '请先刷新牧场并核对库存与动物状态');
    data.lastOperation = { ...data.lastOperation, outcome: 'acknowledged', message: '已由用户核对，不会重放原请求' }; save(data);
    return visibleOperation(data.lastOperation);
  }
  function feedResult(quote, report, pending) {
    report.report.checking = !report.matches && (quote.feedChecks || 0) < 3 && quoteNow() - quote.feedBefore.at <= feedAudit.OBSERVATION_WINDOW_MS;
    return { ...pending, outcome: report.matches ? 'confirmed' : 'unknown',
      requested: quote.plan.count, completed: report.matches ? quote.plan.count : 0,
      rewards: report.matches ? sumItems(quote.plan.expectedRewards) : [], costs: report.matches ? quote.plan.costItems : [],
      reconciliation: report.report, message: `${report.matches ? '自动核账已确认' : '账目暂未匹配'}。${report.message}` };
  }

  function taskSaleProgressReached(plan, raw) {
    const task = raw?.tasks && model.eggSaleTask(model.taskList(raw.tasks));
    return task?.total === plan.taskSale.total && (task.claimed || BigInt(task.progress) >= BigInt(plan.taskSale.expected));
  }

  function reconcileMallGift(data, raw, observedId) {
    const entry = data.lastOperation;
    const attempt = mallGiftAttempt(data, raw.mallGiftDay);
    if (!attempt || attempt.id !== observedId || entry?.id !== observedId || inFlight.has(observedId)
      || !unresolved(data) || model.mallGiftStatus(raw.mallGift) !== 'claimed') return null;
    const result = { ...entry, outcome: 'acknowledged', message: '商城限购显示今日礼包已领取，到账回执待核实' };
    const quote = data.quotes.find(row => row.id === observedId);
    if (quote) { quote.status = result.outcome; quote.result = result; }
    attempt.outcome = 'confirmed';
    data.lastOperation = result;
    return result;
  }

  function reconcileObserved(data, raw, observedId) {
    const entry = data.lastOperation;
    if (!observedId || entry?.id !== observedId || inFlight.has(observedId) || !unresolved(data)) return null;
    const quote = data.quotes.find(row => row.id === observedId);
    const gid = String(network.getUserState().gid);
    let result;
    if (quote?.plan?.taskSale && entry.taskSaleReceipt === true) {
      if (String(quote.origin).split(':')[0] !== gid || !taskSaleProgressReached(quote.plan, raw)) return null;
      result = { ...entry, outcome: 'confirmed', message: '鸡蛋出售和任务进度均已确认' };
    } else if (feedAudit.legacyFeed(quote, gid)) {
      const observed = feedAudit.observeLegacy(quote, raw, quoteNow());
      if (!observed) return null;
      const { observation, ...update } = observed;
      if (!quote.legacyObservation || observation.at - quote.legacyObservation.at >= feedAudit.RECHECK_INTERVAL_MS)
        quote.legacyObservation = observation;
      result = { ...entry, ...update };
      result.reconciliation.checking = result.outcome === 'unknown' && (quote.feedChecks || 0) < 3;
    } else {
      if (!quote?.feedBefore || quote.feedBefore.owner !== gid) return null;
      const comparison = feedAudit.compare(quote.plan, quote.feedBefore, quote.feedReceipt, raw, quoteNow());
      result = feedResult(quote, comparison, { id: quote.id, action: quote.action, label: quote.plan.label, at: entry.at });
      // The past debit can remain uncertain even when the requested stock or fill level is demonstrably present.
      // Retire that intent separately from a confirmed transaction. Never refund or replay its reserved cost.
      if (!comparison.matches && !quote.feedReceipt?.conflicting) {
        const values = comparison.report;
        const previous = quote.goalObservation;
        const at = quoteNow();
        const met = quote.action === 'buy'
          ? values.observedGrass != null && BigInt(values.observedGrass) >= BigInt(values.expectedGrass)
          : values.observedMachine != null && Number(values.observedMachine) >= quote.plan.count;
        if (met && previous?.met && at - previous.at >= feedAudit.RECHECK_INTERVAL_MS) {
          result.outcome = 'replanned'; result.reconciliation.checking = false;
          result.message = `两次刷新确认目标已达到，历史扣除量仍未核实。原单已结束，按当前库存继续。${comparison.message}`;
        }
        if (!previous || !met || !previous.met || at - previous.at >= feedAudit.RECHECK_INTERVAL_MS)
          quote.goalObservation = { at, met };
      }
    }
    const changed = result.outcome !== entry.outcome || JSON.stringify(entry.reconciliation) !== JSON.stringify(result.reconciliation);
    data.lastOperation = result; quote.result = result; quote.status = result.outcome;
    return changed ? { result, automatic: quote.autoRevision !== undefined } : null;
  }

  function logFeedCheck(update) {
    if (!update) return;
    const { result, automatic } = update;
    if (automatic && result.outcome === 'confirmed') logAutomationResult({ action: result.action }, result);
    else automationLog(result.message, { event: 'ranch_feed_reconciliation', logKind: 'status', result: result.outcome,
      action: result.action, source: automatic ? 'automatic' : 'manual' }, result.outcome === 'unknown');
  }

  function deferCleanRecheck(id, playerOrigin) {
    const data = read();
    const quote = data.quotes.find(row => row.id === id);
    if (!ownsCleanQuote(quote, playerOrigin) || data.lastOperation?.id !== id || !unresolved(data) || inFlight.has(id)) return;
    const { action, payload, resultKeys } = quote.plan;
    const owner = playerOrigin.split(':')[0];
    const result = { ...data.lastOperation, outcome: 'unknown', cleanHeld: true, completed: 0, rewards: [], costs: [] };
    data.friendCleanHolds ||= {};
    data.friendCleanHolds[cleanHoldKey(owner, payload.host_gid)] = { plan: { action, payload, resultKeys }, result };
    data.lastCleanOwner = { id, owner };
    quote.status = result.outcome;
    quote.result = data.lastOperation = result;
    save(data);
  }
  async function recheckUnknownOperation(data) {
    const quote = data.quotes.find(row => row.id === data.lastOperation?.id);
    if (!quote || inFlight.has(quote.id)) return { skipped: true };
    if (quote.action === 'cleanFriend') {
      const host = data.lastOperation.friendGid;
      const currentOrigin = origin();
      if (!host || !ownsCleanQuote(quote, currentOrigin)) return { skipped: true };
      const at = quoteNow();
      const checks = quote.cleanChecks || 0;
      if (checks >= CLEAN_CHECK_LIMIT) {
        deferCleanRecheck(quote.id, currentOrigin);
        return { skipped: true };
      }
      if (!canVisitFriend(host) || at - (quote.cleanCheckedAt ?? quote.at) < (checks < 3 ? AUTOMATION_TICK_MS : 5 * 60000))
        return { skipped: true };
      quote.cleanChecks = checks + 1;
      quote.cleanCheckedAt = at;
      save(data);
      try { await getFriend(host); }
      finally {
        if (quote.cleanChecks === CLEAN_CHECK_LIMIT && network.isConnected() && currentOrigin === origin())
          deferCleanRecheck(quote.id, currentOrigin);
      }
      return { skipped: true };
    }
    if (quote.plan?.mallGiftDay && mallGiftAttempt(data, model.ranchDay(now()))?.id === quote.id) {
      const at = quoteNow();
      const checks = quote.mallGiftChecks || 0;
      if (checks >= 3 || at - (quote.mallGiftCheckedAt ?? quote.at) < AUTOMATION_TICK_MS) return { skipped: true };
      quote.mallGiftChecks = checks + 1;
      quote.mallGiftCheckedAt = at;
      save(data);
      await getState('mallGift');
      return { skipped: true };
    }
    if (quote.plan?.taskSale && data.lastOperation?.taskSaleReceipt === true) {
      if (quoteNow() - (quote.taskSaleCheckedAt || quote.at) < 30000) return { skipped: true };
      quote.taskSaleCheckedAt = quoteNow(); save(data);
      await getState('tasks');
      return { skipped: true };
    }
    const at = quoteNow();
    const gid = String(network.getUserState().gid);
    const legacy = feedAudit.legacyFeed(quote, gid);
    if (!legacy && (!quote.feedBefore || quote.feedBefore.owner !== gid)) return { skipped: true };
    const expired = !legacy && (at < quote.feedBefore.at || at - quote.feedBefore.at > feedAudit.OBSERVATION_WINDOW_MS);
    const interval = expired || (quote.feedChecks || 0) >= 3 ? 10 * 60000 : feedAudit.RECHECK_INTERVAL_MS;
    if (at - (quote.feedCheckedAt ?? quote.feedBefore?.at ?? 0) < interval) return { skipped: true };
    quote.feedChecks = Math.min(3, (quote.feedChecks || 0) + 1);
    quote.feedCheckedAt = at;
    save(data);
    await getState('animals');
    return { skipped: true };
  }
  function cancel(id) {
    if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)) return { cancelled: false };
    const data = read(); const quote = data.quotes.find(row => row.id === id);
    if (!quote || quote.status !== 'prepared') return { cancelled: false, alreadyDispatched: !!quote && quote.status !== 'prepared' };
    quote.status = 'cancelled'; quote.result = { id, action: quote.action, label: quote.plan.label, outcome: 'not_sent',
      completed: 0, requested: quote.plan.count, message: '已取消尚未发送的操作', at: now() }; save(data);
    return { cancelled: true };
  }
  async function safe(callback, logReadFailure = true) {
    let quoteId;
    try { return { ok: true, data: await callback(id => { quoteId = id; }) }; }
    catch (failure) {
      const known = /^RANCH_[A-Z_]{1,64}$/.test(failure.code || '') || LOCAL_CODES.has(failure.code);
      const failureStage = readStage(failure);
      const failureKind = readKind(failure);
      if (!known && logReadFailure) {
        try { require('../utils/utils').logWarn('牧场', '牧场读取失败', { module: 'ranch', event: 'ranch_read_failed', failureStage, failureKind }); } catch { /* Diagnostics cannot change request results. */ }
      }
      return { ok: false, failureStage, failureKind, code: known ? (failure.code.startsWith('RANCH_') ? failure.code : `RANCH_${failure.code}`) : 'RANCH_READ_FAILED',
        error: known ? failure.message : `牧场${READ_STAGES[failureStage] || '读取'}失败，请稍后重试`, sceneRecoveryRequired: failure.sceneRecoveryRequired === true,
        ...(quoteId && { operationNotSent: true, quoteId }) };
    }
  }
  async function friendCandidates() {
    const self = String(network.getUserState().gid);
    const roster = await stage('friendRoster', 'request', getFriendTargets);
    if (!Array.isArray(roster)) return [];
    const targets = new Map();
    for (const row of roster) {
      let gid;
      try { gid = model.positiveId(row?.gid, '好友'); }
      catch { continue; }
      if (gid !== self && canVisitFriend(gid)) targets.set(gid, { gid, name: String(row.name || '').slice(0, 42) });
    }
    return [...targets.values()].sort((a, b) => a.gid.length - b.gid.length || a.gid.localeCompare(b.gid));
  }
  async function runFriendTask(action, cursor, canSend) {
    if (!social.ACTIONS.has(action) && !friends.actions.has(action)) throw error('RANCH_INVALID_ARGUMENT', '不支持的好友牧场任务');
    if (!canSend() || !canVisitFriend()) throw error('RANCH_AUTOMATION_PAUSED', '好友牧场任务暂缓');
    if (unresolved(read())) throw error('RANCH_RESULT_UNCONFIRMED', '上一笔牧场操作待核对');
    const candidates = await friendCandidates();
    if (!candidates.length) return { outcome: 'no_friends', nextCursor: cursor };
    const index = cursor % candidates.length;
    const target = candidates[index];
    const nextCursor = (index + 1) % candidates.length;
    const taskAdmission = () => canSend() && canVisitFriend(target.gid) && !manualReviewOwns(read(), { friend: true });
    if (!taskAdmission()) throw error('RANCH_AUTOMATION_PAUSED', '好友牧场任务暂缓');
    try {
      return await visitFriend(target.gid, async scene => {
        if (social.ACTIONS.has(action)) {
          const times = await rpc('ranchOpTimes');
          scene.friend.taskPlan = social.plan(action, { ...scene.friend, times });
        } else {
          const offers = action === 'stealFriend' ? scene.friend.stealable : scene.friend.hazards;
          if (offers.length && (action !== 'cleanFriend' || !friendCleanHeld(scene.friend)))
            scene.friend.taskPlan = friends.plan(action, scene.friend);
        }
        if (!scene.friend.taskPlan) return { outcome: 'no_target', nextCursor };
        scene.taskAdmission = taskAdmission;
        scene.assertCurrent();
        const quote = await prepare(action, { hostGid: target.gid }, undefined, undefined, scene);
        const result = await execute(quote.id, () => {}, scene);
        return { ...result, nextCursor };
      }, action === 'placeMosquito' ? 9 : 8);
    } catch (failure) {
      if (failure.code === 'RANCH_FRIEND_UNAVAILABLE') return { outcome: 'no_target', nextCursor };
      throw failure;
    }
  }
  async function runOwnTask(kind, max, canSend) {
    if (!handbook.ACTIONS.has(kind) || !Number.isSafeInteger(max) || max < 1 || max > 50)
      throw error('RANCH_INVALID_ARGUMENT', '不支持的自家牧场任务');
    if (!canSend() || unresolved(read())) throw error('RANCH_AUTOMATION_PAUSED', '自家牧场任务暂缓');
    return withScene(async scene => {
      const raw = await loadRaw(scene.initial, kind === 'gainRanchXp' ? 'tasks' : 'animals');
      const book = kind === 'growAlbum' ? await rpc('ranchBook', { type: 101 }) : null;
      scene.assertCurrent();
      const data = read();
      const { policy } = autoState(data);
      let selected;
      if (kind === 'useCans') {
        const { plan, reason } = cans.planStep(raw, now());
        if (!plan) return { outcome: 'no_target', reason };
        scene.taskPlan = { ...plan, expectedRewards: plan.expectedRewards || [] };
        selected = { action: plan.action, input: {}, preparing: plan.action === 'fillCan' };
      } else {
        selected = handbook.choose(kind, model.normalizeState(raw, now()), { max, reserve: policy.cubReserve, book });
        if (!selected) return { outcome: 'no_target' };
      }
      const type = selected.action === 'place' ? policyTools.targetTypes.cubs[selected.input.itemId] : null;
      scene.taskAdmission = () => canSend() && !manualReviewOwns(read(), { type });
      if (!scene.taskAdmission()) return { outcome: 'not_sent' };
      scene.taskRaw = raw;
      const quote = await prepare(selected.action, selected.input, undefined, undefined, scene);
      const result = await execute(quote.id, () => {}, scene);
      return { ...result, preparing: selected.preparing };
    }, 9);
  }
  function scheduleProductSale(revision, result) {
    if (result.outcome !== 'confirmed' || result.replayed || result.sceneRecoveryRequired) return;
    try {
      const data = read();
      const state = autoState(data);
      if (state.revision !== revision || !state.policy.sellProducts) return;
      const slot = policyTools.SLOTS.findIndex(row => row.key === 'sellProducts');
      if (manualReviewOwns(data, policyTools.SLOTS[slot])) return;
      state.cursor = slot;
      state.nextAt = Math.min(state.nextAt, now() + AUTOMATION_TICK_MS);
      data.automation = state;
      save(data);
    } catch { /* The saved regular schedule can continue. */ }
  }
  async function performAutomatic(selected, revision, slot, target, markOperationNotSent, activeScene) {
    const context = { action: selected.action, label: automaticLabel(policyTools.SLOTS[slot]), target, requested: selected.input.count };
    let quoteId;
    try {
      const quote = await prepare(selected.action, selected.input, revision, slot, activeScene);
      quoteId = quote.id;
      context.requested = quote.count;
      const result = await execute(quoteId, markOperationNotSent, activeScene);
      logAutomationResult(context, result);
      return result;
    } catch (failure) {
      let recorded;
      try {
        const last = quoteId && read().lastOperation;
        if (last && last.id === quoteId) recorded = visibleOperation(last);
      } catch { /* Use the preflight disposition if the ledger cannot be read. */ }
      const notSent = AUTOMATION_NOT_SENT.has(failure.code) || failure.isGovernedRejection === true || failure.isLocalRequestRejection === true;
      logAutomationResult(context, recorded, notSent ? 'not_sent' : 'error');
      throw failure;
    }
  }
  async function automateFriends(state, slots, markOperationNotSent) {
    const { SLOTS } = policyTools;
    const handled = new Set();
    let target;
    let nextCursor = state.friendCursor;
    let interval = state.policy.intervalMinutes * 60000;
    try {
      const candidates = await friendCandidates();
      const latest = read();
      if (!canAutomate() || !canVisitFriend() || unresolved(latest) || latest.automation?.revision !== state.revision)
        return { skipped: true };
      if (!candidates.length) {
        for (const slot of slots) noteAutoStatus(SLOTS[slot], 'no_ranch_friends', state.revision);
        return { skipped: true };
      }
      const index = state.friendCursor % candidates.length;
      target = candidates[index];
      nextCursor = (index + 1) % candidates.length;
      const scan = await visitFriend(target.gid, async scene => {
        const results = [];
        const friendName = target.name || String(scene.friend.name || '').slice(0, 42);
        for (const slot of slots) {
          const { action } = SLOTS[slot];
          const targets = action === 'stealFriend' ? scene.friend.stealable : scene.friend.hazards;
          if (action === 'cleanFriend' && friendCleanHeld(scene.friend)) {
            noteAutoStatus(SLOTS[slot], 'result_unconfirmed', state.revision, { friendName });
            handled.add(slot);
            continue;
          }
          if (!targets.length) {
            noteAutoStatus(SLOTS[slot], 'no_friend_targets', state.revision, { friendName });
            handled.add(slot);
            continue;
          }
          const operation = await performAutomatic({ action, input: { hostGid: target.gid } },
            state.revision, slot, friendName, markOperationNotSent, scene);
          results.push(operation);
          noteAutoStatus(SLOTS[slot], undefined, state.revision);
          handled.add(slot);
          if (operation.outcome !== 'confirmed' || operation.storageWarning) break;
        }
        return { results };
      }, slots.length > 1 ? 8 : 7);
      const steal = scan.results.find(operation => operation.action === 'stealFriend');
      if (steal) scheduleProductSale(state.revision, { ...steal, sceneRecoveryRequired: scan.sceneRecoveryRequired });
      if (!scan.results.length) return { skipped: true, sceneRecoveryRequired: scan.sceneRecoveryRequired };
      return { ...scan.results[0], results: scan.results, sceneRecoveryRequired: scan.sceneRecoveryRequired };
    } catch (failure) {
      if (failure.code === 'RANCH_AUTOMATION_PAUSED') throw failure;
      const reason = failure.code === 'RANCH_FRIEND_UNAVAILABLE' ? 'friend_unavailable' : AUTO_SCAN_REASONS[failure.code]
        || (failure.isGovernedRejection ? 'request_budget' : 'read_failed');
      if (['farm_priority', 'request_budget', 'scene_recovery', 'scene_busy'].includes(reason)) {
        // An interrupted visit can be retried on the next worker tick without losing its place.
        nextCursor = handled.size ? nextCursor : state.friendCursor;
        interval = AUTOMATION_TICK_MS;
      }
      for (const slot of slots) {
        if (!handled.has(slot)) noteAutoStatus(SLOTS[slot], reason, state.revision, { friendName: target?.name, failure });
      }
      if (reason === 'friend_unavailable') return { skipped: true };
      throw failure;
    } finally {
      const latest = read();
      if (latest.automation?.revision === state.revision) {
        latest.automation.friendCursor = nextCursor;
        latest.automation.friendNextAt = now() + interval;
        save(latest);
      }
    }
  }
  async function automate(markOperationNotSent) {
    if (autoRunning || !canAutomate()) return { skipped: true };
    const data = read(); const state = autoState(data);
    if (unresolved(data)) {
      for (const slot of FRIEND_SLOTS) {
        if (state.policy.enabled && policyTools.slotEnabled(state.policy, policyTools.SLOTS[slot]))
          noteAutoStatus(policyTools.SLOTS[slot], 'result_unconfirmed', state.revision);
      }
      autoRunning = true;
      try { return await recheckUnknownOperation(read()); } finally { autoRunning = false; }
    }
    if (!state.policy.enabled || Math.min(state.nextAt, state.friendNextAt) > now()) return { skipped: true };
    autoRunning = true;
    let viewedSlot;
    let attemptingAction = false;
    try {
      const { SLOTS } = policyTools;
      const friendSlots = [];
      if (state.friendNextAt <= now()) {
        for (const index of FRIEND_SLOTS) {
          const slot = SLOTS[index];
          if (!policyTools.slotEnabled(state.policy, slot)) continue;
          if (!canVisitFriend()) noteAutoStatus(slot, 'friend_quiet', state.revision);
          else if (manualReviewOwns(data, slot)) noteAutoStatus(slot, 'manual_review', state.revision);
          else friendSlots.push(index);
        }
      }
      const eligibleSlots = SLOTS.flatMap((slot, index) =>
        !slot.friend && policyTools.slotEnabled(state.policy, slot) && !manualReviewOwns(data, slot) ? [index] : []);
      const ownDue = state.nextAt <= now() && eligibleSlots.length > 0;
      if (friendSlots.length && (!ownDue || state.friendNextAt <= state.nextAt))
        return await automateFriends(state, friendSlots, markOperationNotSent);
      if (!ownDue) return { skipped: true };
      const cursor = eligibleSlots.find(i => i >= state.cursor % SLOTS.length) ?? eligibleSlots[0];
      state.cursor = (cursor + 1) % SLOTS.length;
      // The configured interval is for the rotation. Each tick still admits only one turn.
      const at = now();
      const turnInterval = Math.max(AUTOMATION_TICK_MS, state.policy.intervalMinutes * 60000 / eligibleSlots.length);
      const scheduledAt = Math.max(state.nextAt, at - AUTOMATION_TICK_MS);
      state.nextAt = Math.max(at + AUTOMATION_TICK_MS, Math.floor(scheduledAt + turnInterval));
      data.automation = state; save(data);
      viewedSlot = SLOTS[cursor];
      const giftAttempt = viewedSlot.key === 'mallGift' && mallGiftAttempt(data, model.ranchDay(at));
      if (giftAttempt) {
        noteAutoStatus(viewedSlot, giftAttempt.outcome === 'confirmed' ? 'mall_gift_claimed' : 'result_unconfirmed', state.revision);
        return { skipped: true };
      }
      const { type, feed, view = 'animals' } = viewedSlot;
      const snapshot = await getState(view, state.policy.shopId, (type || feed) && { ...state, type, feed });
      const fresh = autoState(read());
      if (!canAutomate() || fresh.revision !== state.revision) return { skipped: true };
      if (snapshot.sceneRecoveryRequired) {
        noteAutoStatus(viewedSlot, 'scene_recovery', state.revision);
        return { skipped: true };
      }
      const feedSlot = eligibleSlots.find(i => SLOTS[i].feed);
      const urgentFeed = feedSlot !== undefined && cursor !== feedSlot && data.lastOperation?.action !== 'addGrass'
        ? policyTools.chooseSmartFeed(state.policy, snapshot) : null;
      const feedFirst = urgentFeed?.urgent && urgentFeed.selected?.action === 'addGrass';
      const slots = [cursor, ...eligibleSlots.filter(i => i !== cursor && !SLOTS[i].view && !SLOTS[i].type && !SLOTS[i].feed && !SLOTS[i].friend)];
      if (feedFirst) slots.unshift(feedSlot);
      for (const slot of slots) {
        const { selected, reason } = policyTools.inspectAction(state.policy, snapshot, slot, fresh.usage);
        if (slot === cursor) noteAutoStatus(viewedSlot, reason, state.revision);
        if (!selected) continue;
        if (slot !== cursor) noteAutoStatus(SLOTS[slot], undefined, state.revision);
        attemptingAction = true;
        const result = await performAutomatic(selected, state.revision, slot, automationTarget(selected, snapshot), markOperationNotSent);
        if (selected.action === 'harvest' && result.snapshot?.inventory?.some(row => row.canSell))
          scheduleProductSale(state.revision, result);
        if (SLOTS[slot].key === 'eggSale' && result.outcome === 'confirmed' && state.policy.tasks) {
          const latest = read(); const current = autoState(latest);
          if (current.revision === state.revision) {
            current.cursor = SLOTS.findIndex(row => row.action === 'claimTasks');
            current.nextAt = Math.min(current.nextAt, now() + 30000);
            latest.automation = current; save(latest);
          }
        }
        if (SLOTS[slot].feed && (selected.action === 'buy' || slot !== cursor)
          && result.outcome === 'confirmed' && !result.replayed && !result.sceneRecoveryRequired) {
          try {
            const latest = read();
            const current = autoState(latest);
            if (current.revision === state.revision) {
              // Use a fresh feeding turn after buying, or resume a slot deferred by an urgent feed.
              current.cursor = selected.action === 'buy' ? slot : cursor;
              if (selected.action === 'buy') current.nextAt = Math.min(current.nextAt, now() + 30000);
              latest.automation = current; save(latest);
            }
          } catch { /* The regular timer can continue even if its priority update fails. */ }
        }
        return result;
      }
      return { skipped: true };
    } catch (failure) {
      if (!attemptingAction && viewedSlot && canAutomate()) {
        const reason = Object.hasOwn(AUTO_SCAN_REASONS, failure.code) ? AUTO_SCAN_REASONS[failure.code] : 'read_failed';
        noteAutoStatus(viewedSlot, reason, state.revision, { failure });
      }
      throw failure;
    } finally { autoRunning = false; }
  }
  return { getState: (view, shopId) => safe(() => getState(view, shopId, undefined, true)), getFriend: host => safe(() => getFriend(host)),
    getCleanOperation: id => safe(() => getCleanOperation(id), false),
    reportFriendPanel: () => safe(reportFriendPanel),
    runFriendTask: (...args) => safe(() => runFriendTask(...args), false),
    runOwnTask: (...args) => safe(() => runOwnTask(...args), false),
    prepare: (action, input, revision, slot) => safe(() => prepare(action, input, revision, slot)),
    getAutomation: () => safe(getAutomation), setAutomation: value => safe(() => setAutomation(value)), automate: () => safe(automate, false),
    execute: id => safe(markOperationNotSent => execute(id, markOperationNotSent)),
    cancel: (...args) => safe(() => cancel(...args)), acknowledge: (...args) => safe(() => acknowledge(...args)) };
}
let instance;
function service() {
  if (!instance) {
    const account = String(process.env.FARM_ACCOUNT_ID || '');
    if (!account) throw error('RANCH_ACCOUNT_REQUIRED', '牧场请求未绑定账号');
    const suffix = crypto.createHash('sha256').update(account).digest('hex').slice(0, 24);
    instance = createRanchService({ network: require('../utils/network'),
      canAutomate: () => typeof automationAdmission === 'function' && automationAdmission(),
      getFriendTargets: () => require('./friend-land-analyzer').getFriendsList(false, { throwOnError: true }),
      canVisitFriend: gid => !require('./friend-api').inFriendQuietHours()
        && (gid === undefined || !require('../models/store').getFriendBlacklist(account).some(value => String(value) === gid)),
      file: () => require('../config/runtime-paths').getDataFile(`ranch-operations-${suffix}.json`),
      // Heartbeat clock corrections affect game rules, not the user's review window.
      quoteNow: () => Math.floor(performance.timeOrigin + performance.now()),
      now: () => require('../utils/utils').getServerTimeSec() * 1000 });
  }
  return instance;
}
let automationAdmission;
module.exports = { createRanchService, planIdentity, sumItems,
  runRanchFriendTask: (...args) => service().runFriendTask(...args),
  runRanchOwnTask: (...args) => service().runOwnTask(...args),
  bindRanchAutomation: callback => { automationAdmission = callback; },
  runRanchAutomation: () => service().automate(), getRanchAutomation: () => service().getAutomation(),
  setRanchAutomation: value => service().setAutomation(value),
  getRanchState: (...args) => service().getState(...args), getRanchFriend: host => service().getFriend(host), prepareRanchAction: (...args) => service().prepare(...args),
  getRanchCleanOperation: id => service().getCleanOperation(id),
  reportRanchFriendPanel: () => service().reportFriendPanel(),
  operateRanch: id => service().execute(id), cancelRanchAction: id => service().cancel(id), acknowledgeRanch: id => service().acknowledge(id) };
if (process.env.FARM_SESSION_BUSINESS === '1') {
  const { wrapBusinessFunction } = require('./business-state');
  for (const name of ['runRanchAutomation', 'runRanchFriendTask', 'runRanchOwnTask', 'getRanchState', 'getRanchFriend', 'getRanchCleanOperation', 'reportRanchFriendPanel', 'prepareRanchAction', 'operateRanch', 'acknowledgeRanch', 'setRanchAutomation'])
    module.exports[name] = wrapBusinessFunction(`ranch:${name}`, module.exports[name]);
}
