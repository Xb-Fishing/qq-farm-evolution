'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const codec = require('./ranch-codec');
const model = require('./ranch-model');
const policyTools = require('./ranch-policy');
const LOCAL_CODES = new Set(['INVALID_ARGUMENT', 'GOODS_UNAVAILABLE', 'PURCHASE_LIMIT_EXCEEDED', 'INSUFFICIENT_BALANCE']);
const error = (code, message) => Object.assign(new Error(message), { code });
const QUOTE_TTL_MS = 60000;
const EXPIRED_MESSAGE = '本次确认已到期，请重新核对数量和费用';
// Scene entry, possible AllCells fallback, view reads, and two restoration attempts.
const READ_CALLS = { animals: 5, tasks: 6, shop: 7 };
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const planIdentity = plan => digest({ action: plan.action, route: plan.route, payload: plan.payload,
  costs: plan.costItems, rewards: plan.expectedRewards, targets: plan.resultKeys || null, ...(plan.upgradeTarget && { upgradeTarget: plan.upgradeTarget }) });
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

/** Intents are persisted before writes; a late response or process replacement never replays them. */
function createRanchService({ network, file, now = Date.now, quoteNow = now, canAutomate = () => false }) {
  const sockets = new WeakMap();
  const inFlight = new Set();
  let autoRunning = false;
  function autoState(data) {
    const state = data.automation || { policy: { ...policyTools.DEFAULT_POLICY }, revision: 0, nextAt: 0, cursor: 0, day: '', usage: {} };
    try {
      state.policy = policyTools.normalizePolicy(state.policy, { fromStorage: true });
      if (!Number.isSafeInteger(state.revision) || state.revision < 0 || !Number.isSafeInteger(state.nextAt) || state.nextAt < 0
        || !Number.isSafeInteger(state.cursor) || state.cursor < 0 || !state.usage || typeof state.usage !== 'object' || Array.isArray(state.usage)
        || Object.entries(state.usage).some(([key, value]) => !/^(?:buy|place|addGrass):[1-9]\d*$/.test(key) || !/^\d{1,19}$/.test(String(value)))) throw new Error('Invalid automation record');
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
    data.automation = { ...state, policy, revision: state.revision + 1, nextAt: now() + 30000 };
    save(data); return { ...data.automation, targetTypes: policyTools.targetTypes };
  }
  function manualReviewOwns(data, type) {
    if (!type) return false;
    return data.quotes.some(quote => {
      if (quote.autoRevision !== undefined || quote.status !== 'prepared' || quote.expiresAt <= quoteNow()) return false;
      const targetType = quote.action === 'buy' ? policyTools.targetTypes.goods[quote.input?.goodsId]
        : quote.action === 'place' ? policyTools.targetTypes.cubs[quote.input?.itemId] : undefined;
      return type === targetType && quote.origin === origin();
    });
  }
  function checkAutomaticAction(data, action, revision, slot) {
    const state = autoState(data);
    if (manualReviewOwns(data, policyTools.SLOTS[slot]?.type))
      throw error('RANCH_AUTOMATION_PAUSED', '同类幼崽正在手动确认，智能补栏暂缓');
    if (!canAutomate() || state.revision !== revision || !policyTools.isAutomaticActionEnabled(state.policy, action, slot))
      throw error('RANCH_AUTOMATION_PAUSED', '该动作的自动化设置已变化或已由按栏舍补齐接管');
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
  function visibleOperation(value) {
    if (!value) return null;
    const outcome = value.outcome === 'pending' && !inFlight.has(value.id) ? 'unknown' : value.outcome;
    return { id: value.id, action: value.action, label: value.label, outcome, completed: value.completed || 0,
      requested: value.requested || 0, rewards: value.rewards || [], costs: value.costs || [],
      message: value.message || (outcome === 'unknown' ? '上一笔操作结果尚未确认，请刷新核对后再操作' : ''), at: value.at };
  }
  function unresolved(data) {
    return data.lastOperation && ['pending', 'unknown', 'partial'].includes(visibleOperation(data.lastOperation).outcome);
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
  async function loadRaw(initial, view = 'animals', shopId = '5') {
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
  function viewFor(action) { return action === 'buy' ? 'shop' : action === 'claimTasks' ? 'tasks' : 'animals'; }
  async function loadAction(initial, action, input, assertCurrent, rechecking = false, autoSlot, autoRevision) {
    const raw = await loadRaw(initial, viewFor(action), input.shopId);
    assertCurrent();
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
  async function getState(view = 'animals', shopId = '5', stock) {
    if (!['animals', 'shop', 'tasks'].includes(view)) throw error('RANCH_INVALID_ARGUMENT', '牧场页面无效');
    return withScene(async ({ initial, assertCurrent }) => {
      const raw = await loadRaw(initial, view, shopId); assertCurrent();
      let snapshot = await stage('state', 'normalize', () => model.normalizeState(raw, now()));
      if (stock && policyTools.chooseStock(stock.policy, snapshot, stock.type, stock.usage).needsShop) {
        await loadShop(raw, policyTools.STOCK_SHOP);
        assertCurrent();
        snapshot = await stage('state', 'normalize', () => model.normalizeState(raw, now()));
      }
      const data = read(); data.lastObservedAt = now(); data.lastObservedOperationId = data.lastOperation?.id || null; save(data);
      return { ...snapshot, view, lastOperation: visibleOperation(data.lastOperation) };
    }, READ_CALLS[stock ? 'shop' : view]);
  }
  async function prepare(action, input = {}, autoRevision, autoSlot) {
    if (!['buy', 'place', 'addGrass', 'produce', 'harvest', 'clean', 'claimTasks', 'upgrade', 'completeUpgrade'].includes(action)) throw error('RANCH_INVALID_ARGUMENT', '不支持的牧场操作');
    validateInput(input);
    const accountOrigin = origin();
    const previous = read();
    if (unresolved(previous)) throw error('RANCH_RESULT_UNCONFIRMED', '上一笔操作结果待核对，请先刷新并确认');
    if (autoRevision !== undefined) checkAutomaticAction(previous, action, autoRevision, autoSlot);
    const prepared = await withScene(async ({ initial, assertCurrent }) => {
      const { raw, plan } = await loadAction(initial, action, input, assertCurrent, false, autoSlot, autoRevision);
      if (origin() !== accountOrigin) throw error('RANCH_SESSION_CHANGED', '账号连接已变化，请重新确认');
      if (plan.count > 50 && ['place', 'produce', 'harvest', 'clean', 'claimTasks'].includes(action))
        throw error('RANCH_INVALID_ARGUMENT', '本次目标数量过多，请分次操作');
      const issuedAt = quoteNow();
      const quote = { id: crypto.randomUUID(), action, input, plan, fingerprint: planIdentity(plan), origin: accountOrigin,
        at: issuedAt, expiresAt: issuedAt + QUOTE_TTL_MS, status: 'prepared' };
      const data = read(); if (unresolved(data)) throw error('RANCH_RESULT_UNCONFIRMED', '上一笔操作尚未确认');
      if (autoRevision !== undefined) {
        const state = checkAutomaticAction(data, action, autoRevision, autoSlot);
        if (!policyTools.allowance(state.policy, plan, raw, state.usage, autoSlot, now()))
          throw error('RANCH_AUTOMATION_PAUSED', '自动化设置或可用额度已变化');
        quote.autoRevision = autoRevision;
        if (autoSlot !== undefined) quote.autoSlot = autoSlot;
      }
      data.quotes = data.quotes.filter(row => row.status !== 'prepared' || row.expiresAt > quoteNow()).slice(-19);
      data.quotes.push(quote); save(data);
      return { id: quote.id, action, label: plan.label, count: plan.count,
        costItems: plan.costItems, expectedRewards: sumItems(plan.expectedRewards), expiresAt: quote.expiresAt };
    }, READ_CALLS[policyTools.SLOTS[autoSlot]?.type ? 'shop' : viewFor(action)] + (action === 'upgrade' ? 1 : 0));
    // Device clocks can differ from the game clock. Report time left after scene restoration.
    return { ...prepared, validForMs: Math.min(QUOTE_TTL_MS, Math.max(0, prepared.expiresAt - quoteNow())) };
  }
  function verifyReply(plan, reply, before, after) {
    const unknown = message => { throw error('RANCH_RESULT_UNKNOWN', message); };
    let rewards = []; let completed = plan.count;
    if (plan.action === 'buy') {
      if (String(reply.goods?.id) !== plan.payload.goods_id || !sameItems(reply.cost_items, plan.costItems)
        || !sameItems(reply.get_items, plan.expectedRewards)) unknown('购买回执的商品、费用或数量未完全匹配，请核对库存');
      rewards = reply.get_items;
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
      completed = reply.op_results.length; rewards = reply.op_results.flatMap(row => row.rewards || []);
    }
    if (['place', 'addGrass', 'upgrade'].includes(plan.action)) {
      if (!after) unknown('写入已回复，但新库存未能读取，请刷新核对');
      for (const cost of plan.costItems) if (BigInt(model.balance(before.bag, cost.id).total) - BigInt(model.balance(after.bag, cost.id).total) !== BigInt(cost.count))
        unknown('库存变化与本次费用未匹配，请核对结果');
    }
    const success = { upgrade: '已开始升级，到时可在设施卡完成升级', completeUpgrade: '设施升级已完成' };
    return { outcome: completed < plan.count ? 'partial' : 'confirmed', completed, requested: plan.count,
      rewards: sumItems(rewards), costs: plan.costItems, message: completed < plan.count ? `已确认 ${completed} 项，其余状态发生变化，请刷新核对` : success[plan.action] || '操作已确认' };
  }
  function checkQuote(data, quote, id) {
    if (!quote) {
      if (data.lastOperation?.id === id) return { ...visibleOperation(data.lastOperation), replayed: true };
      throw error('RANCH_CONFIRMATION_MISSING', '确认记录已失效，请刷新牧场核对结果');
    }
    if (quote.status !== 'prepared') {
      const result = quote.result || (data.lastOperation?.id === id && data.lastOperation);
      if (!result) throw error('RANCH_RESULT_UNCONFIRMED', '执行结果待核对，请刷新牧场');
      return { ...visibleOperation(result), replayed: true };
    }
    if (unresolved(data)) throw error('RANCH_RESULT_UNCONFIRMED', '上一笔操作结果待核对');
    if (quote.origin !== origin()) throw error('RANCH_SESSION_CHANGED', '账号连接已变化，请刷新牧场后重新选择操作');
    if (quote.expiresAt <= quoteNow()) throw error('RANCH_QUOTE_EXPIRED', EXPIRED_MESSAGE);
    return null;
  }
  async function execute(id, markOperationNotSent) {
    if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)) throw error('RANCH_INVALID_ARGUMENT', '确认记录无效');
    let data = read(); let quote = data.quotes.find(row => row.id === id);
    const replay = checkQuote(data, quote, id);
    if (replay) return replay;
    if (quote.autoRevision !== undefined) checkAutomaticAction(data, quote.action, quote.autoRevision, quote.autoSlot);
    let operationAttempted = false;
    return withScene(async ({ initial, assertCurrent }) => {
      const { raw: before, plan } = await loadAction(initial, quote.action, quote.input, assertCurrent, true, quote.autoSlot, quote.autoRevision);
      data = read(); quote = data.quotes.find(row => row.id === id);
      const settled = checkQuote(data, quote, id);
      if (settled) return settled;
      if (planIdentity(plan) !== quote.fingerprint) throw error('RANCH_STATE_CHANGED', '数量、费用或目标状态已变化，请重新核对');
      if (quote.autoRevision !== undefined) {
        const state = checkAutomaticAction(data, quote.action, quote.autoRevision, quote.autoSlot);
        if (!policyTools.allowance(state.policy, plan, before, state.usage, quote.autoSlot, now()))
          throw error('RANCH_AUTOMATION_PAUSED', '自动化已暂停或超出费用上限');
        // Reserve before dispatch, in the same durable record as the operation intent.
        for (const cost of plan.costItems) {
          const key = `${plan.action}:${cost.id}`;
          state.usage[key] = (BigInt(state.usage[key] || 0) + BigInt(cost.count)).toString();
        }
        data.automation = state;
        quote.autoReservation = { day: state.day, costs: plan.costItems };
      }
      assertCurrent();
      const pending = { id, action: quote.action, label: plan.label, outcome: 'pending', at: now(), requested: plan.count };
      quote.status = 'pending'; quote.result = pending; data.lastOperation = pending; save(data); inFlight.add(id);
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
              if (manualReviewOwns(latest, policyTools.SLOTS[quote.autoSlot]?.type) || !canAutomate() || state.revision !== quote.autoRevision || state.day !== quote.autoReservation.day
                || !policyTools.isAutomaticActionEnabled(state.policy, plan.action, quote.autoSlot))
                throw Object.assign(error('RANCH_AUTOMATION_PAUSED', '自动化设置或额度日期已变化'), { isLocalRequestRejection: true });
            }
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
        if (reply) {
          try { after = await loadRaw(null); } catch { /* A confirmed receipt is not undone by a read failure. */ }
          try { result = { ...pending, ...verifyReply(plan, reply, before, after) }; }
          catch (failure) { result = { ...pending, outcome: 'unknown', completed: 0, message: failure.message }; }
        }
        result ||= { ...pending, outcome: 'unknown', completed: 0, message: '操作结果尚未确认' };
        if (after) {
          if (plan.action === 'claimTasks') after.tasks = reply;
          if (plan.action === 'buy' && before.shop) {
            try { after.shop = await rpc('shop', { shop_id: before.shopId }); after.shopId = before.shopId; } catch { /* Keep the confirmed purchase and refreshable inventory. */ }
          }
        }
        let snapshot = null;
        try { if (after) snapshot = model.normalizeState(after, now()); } catch { /* Preserve a confirmed write when the refreshed DTO is invalid. */ }

        // Read the latest ledger after refresh so a policy saved while awaiting it survives.
        data = read(); quote = data.quotes.find(row => row.id === id);
        if (result.outcome === 'not_sent' && quote?.autoReservation && data.automation?.day === quote.autoReservation.day) {
          for (const cost of quote.autoReservation.costs) {
            const key = `${quote.action}:${cost.id}`;
            const remaining = BigInt(data.automation.usage[key] || 0) - BigInt(cost.count);
            data.automation.usage[key] = (remaining > 0n ? remaining : 0n).toString();
          }
        }
        if (quote) { quote.status = result.outcome; quote.result = result; }
        data.lastOperation = result;
        if (snapshot) { data.lastObservedAt = now(); data.lastObservedOperationId = id; }
        try { save(data); } catch { result.storageWarning = true; }
        if (expiredBeforeDispatch) {
          if (result.storageWarning) throw error('RANCH_RESULT_UNCONFIRMED', '确认结果未能保存，请刷新牧场核对');
          throw error('RANCH_QUOTE_EXPIRED', EXPIRED_MESSAGE);
        }
        return { ...result, snapshot,
          refreshRequired: !snapshot, message: !snapshot && result.outcome === 'confirmed' ? '操作已确认，页面刷新失败，请稍后刷新' : result.message };
      } finally { inFlight.delete(id); }
    }).catch(failure => {
      if (!operationAttempted && (failure?.isGovernedRejection === true
        || (failure?.isLocalRequestRejection === true && failure.outcome === 'not_sent'))) {
        markOperationNotSent(id);
      }
      throw failure;
    });
  }
  function acknowledge(id) {
    const data = read(); const op = visibleOperation(data.lastOperation);
    const quote = data.quotes.find(row => row.id === id);
    // A lost HTTP admission can leave only an unconsumed quote. Explicitly
    // cancel it so an older preflight can never dispatch after this response.
    if (!unresolved(data) && !inFlight.has(id)) {
      if (quote?.status === 'cancelled' && quote.result?.outcome === 'not_sent') return visibleOperation(quote.result);
      if (quote?.status === 'prepared' && cancel(id).cancelled)
        return visibleOperation(read().quotes.find(row => row.id === id).result);
    }
    if (!op || op.id !== id || !['unknown', 'partial'].includes(op.outcome) || inFlight.has(id))
      throw error('RANCH_INVALID_ARGUMENT', '没有可核对的未确认结果');
    if (data.lastObservedOperationId !== op.id) throw error('RANCH_REFRESH_REQUIRED', '请先刷新牧场并核对库存与动物状态');
    data.lastOperation = { ...data.lastOperation, outcome: 'acknowledged', message: '已由用户核对，不会重放原请求' }; save(data);
    return visibleOperation(data.lastOperation);
  }
  function cancel(id) {
    if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)) return { cancelled: false };
    const data = read(); const quote = data.quotes.find(row => row.id === id);
    if (!quote || quote.status !== 'prepared') return { cancelled: false, alreadyDispatched: !!quote && quote.status !== 'prepared' };
    quote.status = 'cancelled'; quote.result = { id, action: quote.action, label: quote.plan.label, outcome: 'not_sent',
      completed: 0, requested: quote.plan.count, message: '已取消尚未发送的操作', at: now() }; save(data);
    return { cancelled: true };
  }
  async function safe(callback) {
    let quoteId;
    try { return { ok: true, data: await callback(id => { quoteId = id; }) }; }
    catch (failure) {
      const known = /^RANCH_[A-Z_]{1,64}$/.test(failure.code || '') || LOCAL_CODES.has(failure.code);
      const labels = { scene: '场景切换', scene_data: '场景数据', cells: '地块', facilityDetail: '设施详情', bag: '背包', shopProfiles: '商店目录', shop: '商店', tasks: '任务', state: '状态整理' };
      const failureStage = Object.hasOwn(labels, failure.ranchStage) ? failure.ranchStage : 'unknown';
      const failureKind = ['encode', 'request', 'decode', 'normalize'].includes(failure.ranchFailureKind) ? failure.ranchFailureKind : 'unknown';
      if (!known) {
        try { require('../utils/utils').logWarn('牧场', '牧场读取失败', { module: 'ranch', event: 'ranch_read_failed', failureStage, failureKind }); } catch { /* Diagnostics cannot change request results. */ }
      }
      return { ok: false, failureStage, failureKind, code: known ? (failure.code.startsWith('RANCH_') ? failure.code : `RANCH_${failure.code}`) : 'RANCH_READ_FAILED',
        error: known ? failure.message : `牧场${labels[failureStage] || '读取'}失败，请稍后重试`, sceneRecoveryRequired: failure.sceneRecoveryRequired === true,
        ...(quoteId && { operationNotSent: true, quoteId }) };
    }
  }
  async function automate(markOperationNotSent) {
    if (autoRunning || !canAutomate()) return { skipped: true };
    const data = read(); const state = autoState(data);
    if (!state.policy.enabled || state.nextAt > now() || unresolved(data)) return { skipped: true };
    autoRunning = true;
    try {
      const { SLOTS } = policyTools;
      const eligibleSlots = SLOTS.flatMap((slot, index) =>
        policyTools.slotEnabled(state.policy, slot) && !manualReviewOwns(data, slot.type) ? [index] : []);
      if (!eligibleSlots.length) return { skipped: true };
      const cursor = eligibleSlots.find(i => i >= state.cursor % SLOTS.length) ?? eligibleSlots[0];
      state.cursor = (cursor + 1) % SLOTS.length;
      state.nextAt = now() + state.policy.intervalMinutes * 60000;
      data.automation = state; save(data);
      const { type, view = 'animals' } = SLOTS[cursor];
      const snapshot = await getState(view, state.policy.shopId, type && { ...state, type });
      const fresh = autoState(read());
      if (!canAutomate() || fresh.revision !== state.revision || snapshot.sceneRecoveryRequired) return { skipped: true };
      const slots = [cursor, ...eligibleSlots.filter(i => i !== cursor && !SLOTS[i].view && !SLOTS[i].type)];
      for (const slot of slots) {
        const selected = policyTools.chooseAction(state.policy, snapshot, slot, fresh.usage);
        if (!selected) continue;
        const quote = await prepare(selected.action, selected.input, state.revision, slot);
        return await execute(quote.id, markOperationNotSent);
      }
      return { skipped: true };
    } finally { autoRunning = false; }
  }
  return { getState: (...args) => safe(() => getState(...args)), prepare: (...args) => safe(() => prepare(...args)),
    getAutomation: () => safe(getAutomation), setAutomation: value => safe(() => setAutomation(value)), automate: () => safe(automate),
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
      file: () => require('../config/runtime-paths').getDataFile(`ranch-operations-${suffix}.json`),
      // Heartbeat clock corrections affect game rules, not the user's review window.
      quoteNow: () => Math.floor(performance.timeOrigin + performance.now()),
      now: () => require('../utils/utils').getServerTimeSec() * 1000 });
  }
  return instance;
}
let automationAdmission;
module.exports = { createRanchService, planIdentity, sumItems,
  bindRanchAutomation: callback => { automationAdmission = callback; },
  runRanchAutomation: () => service().automate(), getRanchAutomation: () => service().getAutomation(),
  setRanchAutomation: value => service().setAutomation(value),
  getRanchState: (...args) => service().getState(...args), prepareRanchAction: (...args) => service().prepare(...args),
  operateRanch: id => service().execute(id), cancelRanchAction: id => service().cancel(id), acknowledgeRanch: id => service().acknowledge(id) };
if (process.env.FARM_SESSION_BUSINESS === '1') {
  const { wrapBusinessFunction } = require('./business-state');
  for (const name of ['runRanchAutomation', 'getRanchState', 'prepareRanchAction', 'operateRanch', 'acknowledgeRanch', 'setRanchAutomation'])
    module.exports[name] = wrapBusinessFunction(`ranch:${name}`, module.exports[name]);
}
