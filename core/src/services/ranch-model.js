'use strict';

const manual = require('../gameConfig/RanchManual.json');
function freezeFacts(value) {
    if (value && typeof value === 'object') {
        Object.values(value).forEach(freezeFacts);
        Object.freeze(value);
    }
    return value;
}
const metadata = freezeFacts(manual);
const items = new Map(manual.items.map(row => [String(row.id), row]));
const animals = new Map(manual.animals.map(row => [String(row.id), row]));
const cubs = new Map(manual.animals.map(row => [String(row.cub_item_id), row]));
const goods = new Map(manual.goods.map(row => [String(row.id), row]));
const facilities = new Map(manual.facilities.map(row => [String(row.facility_id), row]));
const facilityTypes = new Map([[6, 'MODULE_TYPE_RANCH_COOP'], [7, 'MODULE_TYPE_RANCH_SHED'], [8, 'MODULE_TYPE_FEED_MACHINE']]);
const MAX = (1n << 63n) - 1n;
const EGG_SALE_TASK = '300006';
const EGG_ITEM = '1060001';

function fail(code, message) {
    throw Object.assign(new Error(message), { code });
}

function decimal(value, label = '数量') {
    if (typeof value === 'number' && !Number.isSafeInteger(value)) fail('INVALID_ARGUMENT', `${label}必须是安全整数`);
    if (!['number', 'string', 'bigint'].includes(typeof value) || !/^\d+$/.test(String(value))) fail('INVALID_ARGUMENT', `${label}必须是非负整数`);
    const number = BigInt(value);
    if (number > MAX) fail('INVALID_ARGUMENT', `${label}超出范围`);
    return number.toString();
}

function signedMetadata(value, label) {
    if (typeof value === 'number' && !Number.isSafeInteger(value)) fail('INVALID_ARGUMENT', `${label}必须是安全整数`);
    if (!['number', 'string', 'bigint'].includes(typeof value) || !/^-?\d+$/.test(String(value))) fail('INVALID_ARGUMENT', `${label}无效`);
    const number = BigInt(value);
    if (number < -(1n << 63n) || number > MAX) fail('INVALID_ARGUMENT', `${label}超出范围`);
    return number.toString();
}
function optionalTime(value, label) {
    // An unset timer is not an inventory amount. Keep its sentinel unavailable.
    if (String(value) === '-1') return null;
    return decimal(value ?? 0, label);
}

function positiveId(value, label = 'ID') {
    const id = decimal(value, label);
    if (id === '0') fail('INVALID_ARGUMENT', `${label}必须大于零`);
    return id;
}

function positiveCount(value, label = '数量') {
    const count = BigInt(positiveId(value, label));
    if (count > 2147483647n) fail('INVALID_ARGUMENT', `${label}超出范围`);
    return Number(count);
}

function itemDto(item) {
    const id = positiveId(item.id, '物品');
    const config = require('../config/gameConfig');
    const numericId = Number(id);
    const fallback = Number.isSafeInteger(numericId) ? config.getItemById(numericId) : null;
    const image = Number.isSafeInteger(numericId) ? config.getItemImageById(numericId) : '';
    return { id, count: decimal(item.count, '物品数量'), name: items.get(id)?.name || fallback?.name || `物品${id}`, ...(image ? { image } : {}) };
}

function bagEntries(bag) {
    if (!bag || bag.global_scene_id !== 2 || !Array.isArray(bag.physical_items) || !Array.isArray(bag.virtual_items)) fail('RANCH_RESPONSE_MISMATCH', '牧场背包场景或内容未确认');
    return [...bag.physical_items, ...bag.virtual_items];
}

function balance(bag, id) {
    id = positiveId(id);
    if (!bag) return { resourceKey: `item:${id}`, state: 'unavailable', total: null, locked: null, available: null };
    let total = 0n; let locked = 0n;
    for (const item of bagEntries(bag)) {
        if (positiveId(item.id) !== id) continue;
        const count = BigInt(decimal(item.count, '物品数量'));
        total += count;
        if (item.is_locked === true || item.locked === true) locked += count;
    }
    return { resourceKey: `item:${id}`, state: 'known', total: total.toString(), locked: locked.toString(), available: (total - locked).toString() };
}

function taskList(reply) {
    if (!reply) return null;
    const info = reply.task_info;
    if (!info) fail('RANCH_RESPONSE_MISMATCH', '任务信息未确认');
    const result = new Map();
    for (const row of [...(info.growth_tasks || []), ...(info.daily_tasks || []), ...(info.tasks || [])]) {
        if (![4, 5].includes(row.task_type)) continue;
        const id = positiveId(row.id);
        if (result.has(id)) fail('RANCH_RESPONSE_MISMATCH', '任务ID重复');
        const total = decimal(row.total_progress);
        const progress = decimal(row.progress);
        result.set(id, { id, category: row.task_type === 5 ? 'daily' : 'growth', desc: row.desc || `任务${id}`, total, progress,
            unlocked: row.is_unlocked === true, claimed: row.is_claimed === true,
            canClaim: row.is_unlocked === true && row.is_claimed !== true && BigInt(total) > 0n && BigInt(progress) >= BigInt(total),
            ...(id === '300018' && row.task_type === 4 ? { upgradeFacilityModuleType: 6, upgradeFacilityLevel: 2 } : {}),
            rewards: (row.rewards || []).map(itemDto) });
    }
    return [...result.values()];
}

function eggSaleTask(tasks) {
    return tasks?.find(row => row.id === EGG_SALE_TASK && row.desc === '出售鸡蛋');
}

function shopCards(raw, nowMs) {
    if (!raw.shop) return null;
    const shopId = positiveId(raw.shopId, '商店');
    if (!['5', '6'].includes(shopId) || !Array.isArray(raw.shop.goods_list)) fail('INVALID_ARGUMENT', '商店未确认');
    return { shopId, goods: raw.shop.goods_list.map(row => {
        const id = positiveId(row.id); const config = goods.get(id);
        const itemId = positiveId(row.item_id);
        const valid = !!config && String(config.shop_id) === shopId && String(config.item_id) === itemId && items.has(String(config.price_id));
        const bought = BigInt(decimal(row.bought_num)); const limit = BigInt(decimal(row.limit_count));
        const remaining = limit === 0n ? null : (limit > bought ? limit - bought : 0n).toString();
        const now = BigInt(Math.floor(nowMs / 1000));
        const start = BigInt(signedMetadata(row.discount_start_time, '折扣开始时间')); const end = BigInt(signedMetadata(row.discount_end_time, '折扣结束时间'));
        const discount = start > 0n && start <= now && now < end;
        const price = valid ? itemDto({ id: config.price_id, count: discount ? row.discount_price : row.price }) : null;
        const reward = itemDto({ id: itemId, count: row.item_count });
        const expired = row.is_display_countdown === true && BigInt(signedMetadata(row.end_time, '商品结束时间')) <= now;
        return { id, reward, price, animal: cubs.get(itemId) || null, maxCount: config?.one_buy_count || 0, remaining,
            available: valid && row.unlocked === true && row.owned !== true && !expired && reward.count !== '0' && remaining !== '0',
            requiredLevel: (row.conds || []).find(cond => cond.type === 3)?.param?.toString() || null };
    }) };
}

function upgradeEndTimeMs(value) {
    if (!['number', 'string'].includes(typeof value) || !/^\d+$/.test(String(value))) return null;
    const time = Number(value);
    if (!Number.isSafeInteger(time) || time <= 0) return null;
    return time < 100_000_000_000 ? time * 1000 : time;
}

function upgradeConfigs(facility) {
    const current = facilities.get(String(facility.facility_id));
    if (!current || current.level !== facility.level || current.module_type !== facilityTypes.get(facility.module_type)) return {};
    const next = facilities.get(String(current.next_facility_id));
    if (next?.module_type !== current.module_type || next?.level !== current.level + 1) return { current };
    return { current, next };
}

function upgradeCosts(rows) {
    if (!Array.isArray(rows) || rows.length === 0) return null;
    try {
        const totals = new Map();
        for (const row of rows) {
            const id = positiveId(row?.id, '升级材料');
            const amount = BigInt(decimal(row?.count, '升级费用'));
            if (amount === 0n) return null;
            totals.set(id, (totals.get(id) || 0n) + amount);
        }
        return [...totals].sort(([a], [b]) => a.localeCompare(b)).map(([id, count]) => itemDto({ id, count }));
    } catch {
        return null;
    }
}

function facilityUpgrade(facility, bag, level, nowMs, detail) {
    const { current, next } = upgradeConfigs(facility);
    const endTimeMs = upgradeEndTimeMs(facility.upgrade_end_time);
    const requiredLevel = Number(/^RANCH_LEVEL:(\d+)$/.exec(next?.upgrade_conditions || '')?.[1]) || null;
    const durationSec = Number.isInteger(next?.upgrade_secs) && next.upgrade_secs > 0 ? next.upgrade_secs : null;
    const referenceCosts = typeof next?.upgrade_cost === 'string' ? next.upgrade_cost.split(';').map(entry => {
        const [id, count, extra] = entry.split(':');
        return extra === undefined ? { id, count } : null;
    }) : null;
    const result = { status: 'unknown', nextLevel: next?.level ?? null, nextCapacity: next?.capacity ?? null,
        durationSec, requiredLevel, costs: upgradeCosts(referenceCosts), canStart: false, canComplete: false, reason: '', endTimeMs };
    const unavailable = (status, reason, code) => ({ ...result, status, reason, code });
    if (!current || (current.next_facility_id != null && !next))
        return unavailable('unknown', '当前设施或目标等级未确认', 'RANCH_CONFIG_UNKNOWN');
    if (!next) return unavailable('not_available', '设施已达最高等级', 'RANCH_UPGRADE_UNAVAILABLE');
    if (facility.state !== 1) return unavailable('not_available', '设施尚未建成或未就绪', 'RANCH_UPGRADE_UNAVAILABLE');
    if (detail != null && (String(detail.instance_id) !== String(facility.instance_id) || detail.module_type !== facility.module_type
        || detail.facility_id !== facility.facility_id || detail.level !== facility.level))
        return unavailable('unknown', '设施身份或等级已变化，请重新核对', 'RANCH_STATE_CHANGED');
    if (facility.upgrade_state === 1 || facility.upgrade_state === 2) {
        if (endTimeMs === null) return unavailable('unknown', '升级结束时间未确认', 'RANCH_UPGRADE_UNAVAILABLE');
        if (nowMs < endTimeMs) return unavailable('in_progress', '设施正在升级，结束后可手动完成', 'RANCH_UPGRADE_PENDING');
        return { ...result, status: 'ready', costs: [], canComplete: true };
    }
    if (facility.upgrade_state !== 0 || endTimeMs !== null)
        return unavailable('unknown', '设施升级状态未确认', 'RANCH_UPGRADE_UNAVAILABLE');
    if (requiredLevel === null || durationSec === null || result.costs === null)
        return unavailable('unknown', '升级条件或预计费用未确认', 'RANCH_CONFIG_UNKNOWN');
    if (level === null) return unavailable('unknown', '牧场等级未确认', 'RANCH_UPGRADE_UNAVAILABLE');
    if (level < requiredLevel) return unavailable('not_available', `需要牧场等级 ${requiredLevel} 级`, 'RANCH_UPGRADE_UNAVAILABLE');
    if (detail != null) {
        result.costs = upgradeCosts(detail.upgrade_cost);
        if (!result.costs) return unavailable('unknown', '升级费用未确认', 'RANCH_PRICE_UNKNOWN');
        const missing = result.costs.find(cost => BigInt(balance(bag, cost.id).available) < BigInt(cost.count));
        if (missing) {
            const available = balance(bag, missing.id).available;
            const shortage = BigInt(missing.count) - BigInt(available);
            return unavailable('not_available', `${missing.name}不足：升级需要 ${missing.count}，可用 ${available}，还差 ${shortage}`, 'INSUFFICIENT_BALANCE');
        }
    }
    return { ...result, status: 'available', canStart: true };
}

function normalizeState(raw, nowMs = Date.now()) {
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) fail('INVALID_ARGUMENT', '时间无效');
    const entries = bagEntries(raw?.bag);
    if (!Array.isArray(raw?.cells?.facilities)) fail('RANCH_RESPONSE_MISMATCH', '牧场设施未确认');
    const exp = balance(raw.bag, '1102').total;
    const level = [...manual.levels].reverse().find(row => BigInt(row.exp) <= BigInt(exp));
    const next = manual.levels.find(row => row.level === level?.level + 1);
    const ownFacilities = raw.cells.facilities.filter(row => facilityTypes.has(row.module_type)).map(row => {
        const id = positiveId(row.instance_id);
        const config = facilities.get(String(row.facility_id));
        const ranch = row.ranch;
        if (ranch && positiveId(ranch.ranch_inst_id) !== id) fail('RANCH_RESPONSE_MISMATCH', '栏舍ID不匹配');
        return { id, facilityId: String(row.facility_id), name: config?.name || `设施${row.facility_id}`, moduleType: row.module_type,
            level: row.level, capacity: row.capacity, state: row.state, active: row.state === 1,
            upgradeState: row.upgrade_state, upgradeEndTime: optionalTime(row.upgrade_end_time, '设施升级时间'),
            upgrade: facilityUpgrade(row, raw.bag, level?.level ?? null, nowMs,
                String(raw.facilityDetail?.instance_id) === id ? raw.facilityDetail : undefined),
            feed: row.feed_machine ? { count: row.feed_machine.feed_count, consumeRate: row.feed_machine.consume_rate,
                remainingSec: optionalTime(row.feed_machine.remaining_secs, '饲料剩余时间'), status: row.feed_machine.status } : null,
            ranch: ranch ? { capacity: ranch.capacity, count: ranch.animal_count, husbandryType: ranch.husbandry_type,
                grass: ranch.grass ? { amount: decimal(ranch.grass.amount), emptyAtMs: optionalTime(ranch.grass.empty_at_ms, '牧草耗尽时间') } : null,
                animals: (ranch.animals || []).map(animal => {
                    const animalId = positiveId(animal.animal_id); const cfg = animals.get(animalId);
                    return { id: positiveCount(animal.animal_inst_id), ranchId: id, animalId, slot: animal.slot_index,
                        name: `${animal.mutation?.mutation_type ? '巨大' : ''}${cfg?.name || `动物${animalId}`}`, stage: animal.stage,
                        canProduce: animal.can_deliver === true, canHarvest: animal.can_harvest === true,
                        canFeed: animal.can_feed === true, canRelease: animal.can_donate === true,
                        grassBlocked: animal.grass_blocked === true, producing: animal.producing === true, limitedCanUsed: animal.limited_can_used === true,
                        produceCount: animal.produce_count, maxProduceCount: cfg?.max_produce_count ?? null,
                        infantReadyAtMs: optionalTime(animal.infant_ready_at_ms, '动物阶段时间'), growReadyAtMs: optionalTime(animal.grow_ready_at_ms, '动物阶段时间'),
                        produceReadyAtMs: optionalTime(animal.produce_ready_at_ms, '动物阶段时间'), matureReadyAtMs: optionalTime(animal.mature_ready_at_ms, '动物阶段时间'),
                        mutation: animal.mutation || null };
                }),
                shelves: (ranch.shelves || []).map(shelf => ({ slot: shelf.slot_index, remaining: decimal(shelf.total_remain), canCollect: shelf.can_collect === true,
                    products: (shelf.lots || []).map(lot => itemDto({ id: lot.item_id, count: lot.remain_num })) })),
                hazards: (ranch.hazards || []).map(hazard => ({ id: positiveId(hazard.hazard_id), type: hazard.hazard_type })) } : null };
    });
    const physicalItems = new Set(raw.bag.physical_items);
    const inventory = entries.map(item => ({ ...itemDto(item), uid: signedMetadata(item.uid ?? 0, '物品实例标识'), locked: item.is_locked === true || item.locked === true,
        type: items.get(String(item.id))?.type || 0, animalId: cubs.has(String(item.id)) ? String(cubs.get(String(item.id)).id) : null,
        husbandryType: cubs.has(String(item.id)) ? (cubs.get(String(item.id)).husbandry_type === '窝' ? 1 : 2) : null,
        sellPrices: (item.show?.sells || []).map(itemDto), canSell: physicalItems.has(item) && salePrices(item).length > 0,
        product: item.item_detail?.ranch_product || null }));
    return { unlocked: true, sceneId: 2, serverTime: nowMs, level: level?.level ?? null, levelState: level ? 'known' : 'unavailable',
        exp, currentExp: level ? (BigInt(exp) - BigInt(level.exp)).toString() : null,
        neededExp: next && level ? (BigInt(next.exp) - BigInt(level.exp)).toString() : null,
        facilities: ownFacilities, animals: ownFacilities.flatMap(row => row.ranch?.animals || []), inventory, bag: inventory,
        cubs: inventory.filter(item => item.animalId), grass: balance(raw.bag, '7001').available,
        currencies: ['1007', '1002', '1005', '1008', '7002'].map(id => ({ ...itemDto({ id, count: balance(raw.bag, id).total }), ...balance(raw.bag, id) })),
        shop: shopCards(raw, nowMs), tasks: taskList(raw.tasks), tasksState: raw.tasks ? 'known' : 'unavailable' };
}

function salePrices(item) {
    if (![106, 107].includes(items.get(String(item.id))?.type) || item.is_locked || item.locked
        || item.show?.sell_cond?.length || item.show?.cond_sells?.length || !item.show?.sells?.length
        || !/^\d+$/.test(String(item.uid)) || BigInt(item.uid) <= 0n || BigInt(item.count) <= 0n) return [];
    if (!item.show.sells.every(price => BigInt(decimal(price.id)) > 0n && BigInt(decimal(price.count)) > 0n)) return [];
    return item.show.sells.map(itemDto).sort((a, b) => a.id.localeCompare(b.id) || a.count.localeCompare(b.count));
}

const AUTO_SALE_BATCH_SIZE = 50;

function automaticSaleItems(state, deferEggs) {
    if (!Array.isArray(state.tasks)) return [];
    const eggTask = eggSaleTask(state.tasks);
    const pending = eggTask?.unlocked && !eggTask.claimed && BigInt(eggTask.total) > BigInt(eggTask.progress);
    let reservedEggs = pending ? BigInt(eggTask.total) - BigInt(eggTask.progress) : 0n;
    const selected = [];
    for (const item of state.inventory) {
        if (!item.canSell) continue;
        let count = BigInt(item.count);
        if (item.id === EGG_ITEM && pending) {
            if (deferEggs) continue;
            const reserve = count < reservedEggs ? count : reservedEggs;
            count -= reserve;
            reservedEggs -= reserve;
        }
        if (count > 0n) selected.push({ uid: item.uid, count: count.toString() });
        if (selected.length === AUTO_SALE_BATCH_SIZE) break;
    }
    return selected;
}

function selectedFacility(rows, instanceId) {
    const id = positiveId(instanceId, '设施实例');
    const targets = rows.filter(row => String(row.instance_id) === id);
    if (targets.length !== 1 || !facilityTypes.has(targets[0].module_type)) fail('RANCH_FACILITY_NOT_FOUND', '设施实例未确认');
    return targets[0];
}

function planAction(action, input = {}, raw, nowMs = Date.now()) {
    const state = normalizeState(raw, nowMs);
    const labels = { buy: '购买牧场商品', place: '放养幼崽', addGrass: '补充牧草', produce: '牧场生产', harvest: '牧场收获', clean: '清理牧场',
        claimTasks: '领取牧场任务', sell: '出售牧场产物', upgrade: '开始升级', completeUpgrade: '完成升级' };
    if (!labels[action]) fail('INVALID_ARGUMENT', '不支持的牧场操作');
    const plan = { action, label: labels[action], route: action, payload: {}, costItems: [], expectedRewards: [], marker: null, count: 1 };
    if (action === 'buy') {
        if (input.autoPlace === true || input.auto_add === true) fail('INVALID_ARGUMENT', '请先购买入包再放养');
        const shopId = positiveId(input.shopId); const id = positiveId(input.goodsId); const count = positiveCount(input.count);
        const card = state.shop?.shopId === shopId && state.shop.goods.find(row => row.id === id);
        if (!card?.available) fail('GOODS_UNAVAILABLE', '当前商品或配置未确认');
        if (count > card.maxCount || card.remaining !== null && BigInt(count) > BigInt(card.remaining)) fail('PURCHASE_LIMIT_EXCEEDED', '购买数量超过上限');
        plan.payload = { goods_id: id, num: String(count), price: card.price.count, auto_add: false };
        plan.costItems = [itemDto({ id: card.price.id, count: BigInt(card.price.count) * BigInt(count) })];
        plan.expectedRewards = [itemDto({ id: card.reward.id, count: BigInt(card.reward.count) * BigInt(count) })];
        plan.marker = shopId; plan.count = count;
    } else if (action === 'place') {
        const id = positiveId(input.ranchId); const itemId = positiveId(input.itemId); const count = positiveCount(input.count);
        const config = cubs.get(itemId); const ranch = state.facilities.find(row => row.id === id)?.ranch;
        if (!config || !ranch || ranch.husbandryType !== (config.husbandry_type === '窝' ? 1 : 2)) fail('RANCH_ANIMAL_MISMATCH', '幼崽与栏舍不匹配');
        if (!Number.isInteger(ranch.capacity) || !Number.isInteger(ranch.count) || ranch.count < 0 || count > ranch.capacity - ranch.count) fail('RANCH_FULL', '栏舍容量不足');
        plan.payload = { items: Array.from({ length: count }, () => ({ ranch_inst_id: id, animal_id: String(config.id) })) };
        plan.costItems = [itemDto({ id: itemId, count })]; plan.count = count;
        plan.marker = { ranchId: id, animalId: String(config.id), capacity: ranch.capacity, occupied: ranch.count };
    } else if (action === 'addGrass') {
        const id = positiveId(input.facilityId); const count = positiveCount(input.count);
        const facility = state.facilities.find(row => row.id === id && row.moduleType === 8);
        if (!facility?.feed || !Number.isInteger(facility.capacity) || !Number.isInteger(facility.feed.count) || facility.feed.count < 0 || count > facility.capacity - facility.feed.count) fail('RANCH_GRASS_CAPACITY', '牧草机容量未确认或不足');
        plan.payload = { instance_id: id, add_count: count, use_gold: false };
        plan.costItems = [itemDto({ id: '7001', count })]; plan.count = count;
        plan.marker = { facilityId: id, capacity: facility.capacity, occupied: facility.feed.count };
    } else if (action === 'upgrade' || action === 'completeUpgrade') {
        const facility = selectedFacility(raw.cells.facilities, input.facilityId);
        const id = String(facility.instance_id);
        const upgrade = facilityUpgrade(facility, raw.bag, state.level, nowMs, raw.facilityDetail);
        const starting = action === 'upgrade';
        if (!(starting ? upgrade.canStart : upgrade.canComplete))
            fail(upgrade.code || 'RANCH_UPGRADE_UNAVAILABLE', upgrade.reason || '当前阶段不能执行此升级操作');
        if (starting && !raw.facilityDetail) fail('RANCH_PRICE_UNKNOWN', '升级费用未确认');
        const { current, next } = upgradeConfigs(facility);
        plan.payload = { inst_id: id };
        plan.upgradeTarget = { instanceId: id, fromId: current.facility_id, fromLevel: current.level, toId: next.facility_id, toLevel: next.level };
        plan.label = `${labels[action]}：${current.name} Lv.${current.level} → Lv.${next.level}`;
        if (starting) plan.costItems = upgrade.costs;
    } else if (action === 'produce' || action === 'harvest') {
        const eligible = animal => action === 'produce' ? animal.canProduce : animal.canHarvest;
        let selected;
        if (input.all === true) selected = state.animals.filter(eligible);
        else {
            const targets = input.targets || [{ ranchId: input.ranchId, animalId: input.animalId }];
            if (!Array.isArray(targets) || !targets.length) fail('INVALID_ARGUMENT', '请选择动物');
            selected = targets.map(target => {
                const id = positiveId(target.ranchId); const animalId = positiveCount(target.animalId);
                const animal = state.animals.find(row => row.ranchId === id && row.id === animalId);
                if (!animal || !eligible(animal)) fail('RANCH_STATE_CHANGED', '动物状态已变化');
                return animal;
            });
        }
        const refs = selected.map(row => ({ ranch_inst_id: row.ranchId, animal_inst_id: row.id }));
        if (new Set(refs.map(row => `${row.ranch_inst_id}:${row.animal_inst_id}`)).size !== refs.length) fail('INVALID_ARGUMENT', '动物目标重复');
        const shelves = action === 'harvest' && input.all === true ? state.facilities.flatMap(row => (row.ranch?.shelves || []).filter(shelf => shelf.canCollect).map(shelf => ({ ranch_inst_id: row.id, slot_index: shelf.slot }))) : [];
        plan.count = refs.length + shelves.length;
        if (!plan.count) fail('RANCH_NO_ELIGIBLE_TARGET', '没有符合条件的目标');
        plan.payload = action === 'produce' ? { targets: input.all === true ? [] : refs } : input.all === true ? { op: 1 } : { op: 4, animals: refs };
        plan.marker = { animals: refs, shelves };
        plan.resultKeys = [...refs.map(row => `${row.ranch_inst_id}:1:${row.animal_inst_id}`), ...shelves.map(row => `${row.ranch_inst_id}:2:${row.slot_index}`)];
    } else if (action === 'clean') {
        const chosen = state.facilities.filter(row => row.ranch?.hazards.length);
        if (!chosen.length) fail('RANCH_NO_ELIGIBLE_TARGET', '没有可清理的污物');
        plan.payload = { ranch_inst_ids: chosen.map(row => row.id) };
        plan.resultKeys = chosen.flatMap(row => row.ranch.hazards.map(hazard => `${row.id}:3:${hazard.id}`));
        plan.marker = plan.resultKeys; plan.count = plan.resultKeys.length;
    } else if (action === 'sell') {
        const physical = raw.bag.physical_items;
        let selected;
        if (input.taskId !== undefined) {
            const task = eggSaleTask(state.tasks);
            if (String(input.taskId) !== EGG_SALE_TASK || !task?.unlocked || task.claimed || task.canClaim)
                fail('RANCH_STATE_CHANGED', '出售鸡蛋任务尚未解锁、已完成或已变化');
            let missing = BigInt(task.total) - BigInt(task.progress);
            if (missing <= 0n) fail('RANCH_STATE_CHANGED', '出售鸡蛋任务已经完成');
            selected = [];
            for (const item of physical) {
                if (!missing) break;
                if (String(item.id) !== EGG_ITEM) continue;
                const prices = salePrices(item);
                if (!prices.length) continue;
                const count = BigInt(item.count) < missing ? BigInt(item.count) : missing;
                selected.push({ item, prices, count: count.toString() });
                missing -= count;
            }
            plan.taskSale = { id: task.id, progress: task.progress, total: task.total,
                expected: (BigInt(task.total) - missing).toString() };
            plan.label = '出售鸡蛋任务';
        } else if (input.autoProducts === true) {
            const amounts = new Map(automaticSaleItems(state, input.deferEggs === true).map(row => [row.uid, row.count]));
            selected = physical.filter(item => amounts.has(String(item.uid)))
                .map(item => ({ item, prices: salePrices(item), count: amounts.get(String(item.uid)) }));
            plan.productSale = true;
            plan.label = '出售可售产物';
        } else if (input.all === true) {
            selected = physical.map(item => ({ item, prices: salePrices(item), count: String(item.count) }))
                .filter(row => row.prices.length);
        } else {
            const uid = positiveId(input.uid, '物品批次');
            const count = positiveId(input.count, '出售数量');
            const itemId = positiveId(input.itemId, '物品');
            const matches = physical.filter(item => String(item.uid) === uid && String(item.id) === itemId);
            const prices = matches.length === 1 ? salePrices(matches[0]) : [];
            if (!prices.length || BigInt(matches[0].count) < BigInt(count)) fail('RANCH_STATE_CHANGED', '产物、可售数量或报价已变化');
            selected = [{ item: matches[0], prices, count }];
        }
        if (!selected.length) fail('RANCH_NO_ELIGIBLE_TARGET', '没有售价已确认的可售产物');
        const idCounts = new Map();
        for (const item of physical) {
            const uid = String(item.uid);
            idCounts.set(uid, (idCounts.get(uid) || 0) + 1);
        }
        if (selected.some(row => idCounts.get(String(row.item.uid)) !== 1)) fail('RANCH_STATE_CHANGED', '牧场产物批次重复，请重新读取背包');
        selected.sort((a, b) => String(a.item.uid).localeCompare(String(b.item.uid)));
        plan.payload = { items: selected.map(({ item, count }) => ({ id: positiveId(item.id), uid: positiveId(item.uid), count })) };
        plan.costItems = plan.payload.items.map(itemDto);
        plan.expectedRewards = selected.flatMap(({ count, prices }) => prices.map(price => itemDto({ id: price.id, count: BigInt(count) * BigInt(price.count) })));
        plan.count = selected.length;
    } else if (action === 'claimTasks') {
        if (input.double === true || input.do_shared === true) fail('INVALID_ARGUMENT', '仅支持普通任务奖励');
        if (!state.tasks) fail('RANCH_TASK_UNAVAILABLE', '任务信息不可用');
        let chosen;
        if (input.all === true) chosen = state.tasks.filter(task => task.canClaim);
        else {
            const ids = input.taskIds || [input.taskId];
            if (!Array.isArray(ids) || !ids.length) fail('INVALID_ARGUMENT', '请选择任务');
            const wanted = ids.map(id => positiveId(id));
            if (new Set(wanted).size !== wanted.length) fail('INVALID_ARGUMENT', '任务重复');
            chosen = wanted.map(id => state.tasks.find(task => task.id === id));
            if (chosen.some(task => !task?.canClaim)) fail('RANCH_TASK_UNAVAILABLE', '任务未完成或已领取');
        }
        if (!chosen.length) fail('RANCH_NO_ELIGIBLE_TARGET', '没有可领取的任务');
        plan.route = 'claimTasks'; plan.payload = { ids: chosen.map(task => task.id), do_shared: false };
        plan.expectedRewards = chosen.flatMap(task => task.rewards); plan.marker = chosen; plan.count = chosen.length;
    }
    for (const cost of plan.costItems) if (BigInt(balance(raw.bag, cost.id).available) < BigInt(cost.count)) fail('INSUFFICIENT_BALANCE', `${cost.name}不足`);
    return plan;
}

module.exports = { decimal, positiveId, positiveCount, balance, itemDto, normalizeState, planAction, selectedFacility, metadata, taskList,
    eggSaleTask, automaticSaleItems, EGG_SALE_TASK, EGG_ITEM };
