'use strict';

// No business persistence modules are imported. Reserve a separate path before
// imports so adding an indirect storage dependency cannot touch account data.
process.env.FARM_DATA_DIR = `/tmp/ranch-codec-model-test-${process.pid}`;
const test = require('node:test');
const assert = require('node:assert/strict');
const protobuf = require('protobufjs');
const codec = require('../src/services/ranch-codec');
const model = require('../src/services/ranch-model');
const HUGE = '9007199254740993';
const NOW = 1700000000000;
const dto = (type, value) => codec.decode(type, codec.encode(type, value));

function fixture() {
    return {
        cells: dto('AllCellsReply', { facilities: [
            { instance_id: HUGE, facility_id: 6001002, module_type: 6, state: 1, level: 2, capacity: 4,
                ranch: { ranch_inst_id: HUGE, capacity: 4, animal_count: 1, husbandry_type: 1,
                    animals: [{ ranch_inst_id: HUGE, animal_inst_id: 7, animal_id: '60001', slot_index: 1, can_deliver: true, can_harvest: true }],
                    shelves: [{ slot_index: 2, total_remain: '3', can_collect: true, lots: [{ item_id: '1060001', remain_num: '3' }] }],
                    hazards: [{ hazard_id: '9007199254740995', hazard_type: 1 }] } },
            { instance_id: '22', facility_id: 7001001, module_type: 8, state: 1, level: 1, capacity: 100, feed_machine: { feed_count: 40 } },
        ] }),
        bag: dto('GetBagReply', { global_scene_id: 2,
            physical_items: [{ id: '60001', count: '5' }, { id: '7001', count: '80' }, { id: '1007', count: '20', is_locked: true }],
            virtual_items: [{ id: '1007', count: '9007199254741000' }] }),
        shopId: '5', shop: dto('ShopInfoReply', { goods_list: [{ id: '10002', item_id: '60001', item_count: '1', price: '10', unlocked: true }] }),
        tasks: dto('TaskInfoReply', { task_info: { growth_tasks: [
            { id: HUGE, progress: '2', total_progress: '2', task_type: 4, is_unlocked: true, rewards: [{ id: '1007', count: '2' }], share_multiple: '2' },
            { id: '300009', progress: '1', total_progress: '1', task_type: 5, is_unlocked: true, rewards: [{ id: '7001', count: '1' }] },
            { id: '9', progress: '2', total_progress: '2', task_type: 1, is_unlocked: true },
        ] } }),
    };
}

test('private codec uses exact independent field tags and preserves int64/defaults', () => {
    // field 2 (length-delimited) in SceneData, then field 1 (varint) grid_width.
    assert.deepEqual([...codec.encode('SceneData', { homestead_cells: { grid_width: 9 } })], [18, 2, 8, 9]);
    const wire = protobuf.Writer.create().uint32(8).int64(HUGE).uint32(16).int32(7).finish();
    assert.deepEqual(codec.decode('AnimalRef', wire), { ranch_inst_id: HUGE, animal_inst_id: 7 });
    assert.deepEqual([...codec.encode('AddFeedRequest', { instance_id: '1', add_count: 3, use_gold: false })], [8, 1, 16, 3]);
    assert.deepEqual([...codec.encode('AddFeedRequest', { instance_id: '1', add_count: 3, use_gold: true })], [8, 1, 16, 3, 24, 1]);
    const animal = codec.decode('AnimalDetail', Buffer.alloc(0));
    assert.equal(animal.can_deliver, false);
    assert.equal(animal.expected_harvest_exp, '0');
    assert.equal(animal.mutation, null);
    const bag = dto('GetBagReply', { global_scene_id: 2, physical_items: [{ id: HUGE, count: '2', uid: '9007199254740997', is_locked: true,
        show: { sells: [{ id: '1007', count: '8' }] }, item_detail: { ranch_product: { src_animal_id: HUGE, price_rate: '10000' } } }] });
    assert.equal(bag.physical_items[0].uid, '9007199254740997');
    assert.equal(bag.physical_items[0].show.sells[0].count, '8');
    assert.equal(bag.physical_items[0].is_locked, true);
    assert.equal(bag.physical_items[0].item_detail.ranch_product.src_animal_id, HUGE);
    assert.throws(() => codec.encode('AnimalRef', { ranch_inst_id: Number(HUGE) }), /Unsafe/);
    assert.throws(() => codec.encode('AnimalRef', { ranch_inst_id: '9223372036854775808' }), /int64/);
    assert.throws(() => codec.encode('AnimalRef', { ranchInstId: '1' }), /Unknown field/);
    assert.equal(codec.ROUTES.clean.service, 'gamepb.animalpb.RanchService');
    assert.equal(codec.ROUTES.bag.writing, false);
    assert.equal(codec.ROUTES.sceneLogin.method, 'PlayerSceneLogin');
});

test('numeric validation and balance distinguish known zero, locked and unavailable', () => {
    assert.equal(model.decimal('0009007199254740993'), HUGE);
    for (const bad of [-1, Number(HUGE), '1.2', '', null, {}, '9223372036854775808']) assert.throws(() => model.decimal(bad));
    assert.throws(() => model.positiveId('0'));
    assert.throws(() => model.positiveCount('2147483648'));
    const raw = fixture();
    assert.deepEqual(model.balance(raw.bag, '1007'), { resourceKey: 'item:1007', state: 'known', total: '9007199254741020', locked: '20', available: '9007199254741000' });
    assert.equal(model.balance(raw.bag, '7002').available, '0');
    assert.equal(model.balance(null, '7002').state, 'unavailable');
    const state = model.normalizeState(raw, NOW);
    assert.equal(state.animals[0].ranchId, HUGE);
    assert.equal(state.animals[0].canProduce, true);
    assert.equal(state.cubs[0].name.includes('鸡'), true);
    assert.equal(state.tasks.length, 2);
    assert.equal(state.tasks[0].id, HUGE);
    delete raw.tasks;
    assert.equal(model.normalizeState(raw, NOW).tasksState, 'unavailable');
    raw.bag.global_scene_id = 1;
    assert.throws(() => model.normalizeState(raw, NOW), /场景/);
});

test('facility upgrade routes and independent wire fixtures preserve target, costs and int64 identifiers', () => {
    const routeTriples = [
        ['facilityDetail', 'GetFacilityDetail', false],
        ['upgrade', 'UpgradeBuilding', true],
        ['completeUpgrade', 'CompleteBuildingUpgrade', true],
    ];
    const idWire = protobuf.Writer.create().uint32(8).int64(HUGE).finish();
    for (const [route, method, writing] of routeTriples) {
        assert.deepEqual(codec.ROUTES[route], { service: 'gamepb.homesteadpb.HomesteadService', method,
            request: `${method}Request`, reply: `${method}Reply`, writing });
        assert.deepEqual(Buffer.from(codec.encode(`${method}Request`, { [writing ? 'inst_id' : 'instance_id']: HUGE })), Buffer.from(idWire));
    }
    const detailWire = protobuf.Writer.create().uint32(10).fork()
        .uint32(8).int64(HUGE).uint32(40).int32(6)
        .uint32(50).fork().uint32(8).int64('1007').uint32(16).int64('14000').ldelim()
        .uint32(56).int32(1).uint32(64).int32(6001001).ldelim().finish();
    const { info } = codec.decode('GetFacilityDetailReply', detailWire);
    assert.deepEqual([info.instance_id, info.module_type, info.level, info.facility_id], [HUGE, 6, 1, 6001001]);
    assert.deepEqual(info.upgrade_cost.map(({ id, count }) => [id, count]), [['1007', '14000']]);
    assert.equal(codec.decode('GetFacilityDetailReply', Buffer.alloc(0)).info, null);
    const started = protobuf.Writer.create().uint32(10).fork().uint32(8).int64(HUGE)
        .uint32(16).int32(1).uint32(24).int64('1700000010').uint32(32).int32(6001002).uint32(40).int32(2).ldelim().finish();
    assert.deepEqual(codec.decode('UpgradeBuildingReply', started).upgrade, {
        inst_id: HUGE, state: 1, end_time: '1700000010', target_facility_id: 6001002, target_level: 2,
    });
    const completed = protobuf.Writer.create().uint32(10).fork().uint32(8).int64(HUGE)
        .uint32(16).int32(6001002).uint32(56).int32(2).ldelim()
        .uint32(18).fork().uint32(8).int64(HUGE).uint32(16).int32(6001002).uint32(24).int32(2).ldelim().finish();
    const reply = codec.decode('CompleteBuildingUpgradeReply', completed);
    assert.deepEqual([reply.facility.instance_id, reply.facility.facility_id, reply.facility.level], [HUGE, 6001002, 2]);
    assert.deepEqual([reply.item.inst_id, reply.item.facility_id, reply.item.level], [HUGE, 6001002, 2]);
});

function upgradeFixture() {
    const raw = fixture();
    Object.assign(raw.cells.facilities[0], { facility_id: 6001001, level: 1, capacity: 3 });
    raw.bag.virtual_items.push({ id: '1102', count: String(model.metadata.levels.find(row => row.level === 8).exp) });
    const detail = { instance_id: HUGE, facility_id: 6001001, module_type: 6, level: 1,
        upgrade_cost: [{ id: '1007', count: '15000' }] };
    return { raw, detail, facility: raw.cells.facilities[0], input: { facilityId: HUGE } };
}

test('upgrade preview is read-only, uses the fixed level chain, and prepares against exact dynamic costs', () => {
    const { raw, detail, input } = upgradeFixture();
    const initial = model.normalizeState(raw, NOW).facilities[0].upgrade;
    assert.deepEqual({ ...initial, costs: initial.costs.map(({ id, count }) => [id, count]) }, {
        status: 'available', nextLevel: 2, nextCapacity: 4, durationSec: 10, requiredLevel: 8,
        costs: [['1007', '14000']], canStart: true, canComplete: false, reason: '', endTimeMs: null,
    });
    assert.throws(() => model.planAction('upgrade', input, raw, NOW), { code: 'RANCH_PRICE_UNKNOWN' });
    raw.facilityDetail = detail;
    const plan = model.planAction('upgrade', input, raw, NOW);
    assert.deepEqual(plan.payload, { inst_id: HUGE });
    assert.deepEqual(plan.upgradeTarget, { instanceId: HUGE, fromId: 6001001, fromLevel: 1, toId: 6001002, toLevel: 2 });
    assert.equal(plan.label, '开始升级：窝 Lv.1 → Lv.2');
    assert.deepEqual(plan.costItems.map(({ id, count }) => [id, count]), [['1007', '15000']]);
    for (const changes of [{ instance_id: '22' }, { facility_id: 6001002 }, { module_type: 7 }, { level: 2 }]) {
        raw.facilityDetail = { ...detail, ...changes };
        assert.throws(() => model.planAction('upgrade', input, raw, NOW), { code: 'RANCH_STATE_CHANGED' });
    }
    for (const costs of [undefined, [], [{ id: '1007', count: '0' }], [{ id: '1007', count: '-1' }]]) {
        raw.facilityDetail = { ...detail, upgrade_cost: costs };
        assert.throws(() => model.planAction('upgrade', input, raw, NOW), { code: 'RANCH_PRICE_UNKNOWN' });
    }
    raw.facilityDetail = { ...detail, upgrade_cost: [{ id: '1007', count: '9007199254741000' }, { id: '1007', count: '1' }] };
    assert.throws(() => model.planAction('upgrade', input, raw, NOW), { code: 'INSUFFICIENT_BALANCE' });
    raw.facilityDetail = detail;
    raw.bag.virtual_items.pop();
    assert.throws(() => model.planAction('upgrade', input, raw, NOW), { code: 'RANCH_UPGRADE_UNAVAILABLE' });
});

test('complete upgrade requires the same eligible facility and a known elapsed timer, and carries no costs', () => {
    const { raw, facility, input } = upgradeFixture();
    assert.throws(() => model.planAction('completeUpgrade', input, raw, NOW), { code: 'RANCH_UPGRADE_UNAVAILABLE' });
    for (const time of ['1700000000', String(NOW)]) {
        Object.assign(facility, { upgrade_state: 1, upgrade_end_time: time });
        assert.throws(() => model.planAction('completeUpgrade', input, raw, NOW - 1), { code: 'RANCH_UPGRADE_PENDING' });
        assert.throws(() => model.planAction('upgrade', input, raw, NOW), { code: 'RANCH_UPGRADE_UNAVAILABLE' });
        const plan = model.planAction('completeUpgrade', input, raw, NOW);
        assert.deepEqual(plan.payload, { inst_id: HUGE });
        assert.deepEqual(plan.costItems, []);
        assert.equal(plan.label, '完成升级：窝 Lv.1 → Lv.2');
        assert.equal(model.normalizeState(raw, NOW).facilities[0].upgrade.endTimeMs, NOW);
    }
    for (const [state, end] of [[2, '0'], [2, '-1'], [3, '1700000000']]) {
        Object.assign(facility, { upgrade_state: state, upgrade_end_time: end });
        assert.equal(model.normalizeState(raw, NOW).facilities[0].upgrade.canComplete, false);
    }
    Object.assign(facility, { upgrade_state: 0, upgrade_end_time: '0', facility_id: 6001008, level: 8 });
    assert.equal(model.normalizeState(raw, NOW).facilities[0].upgrade.status, 'not_available');
});

test('only the reviewed coop upgrade task has a facility navigation target', () => {
    const raw = fixture();
    raw.tasks.task_info.growth_tasks.push({ id: '300018', task_type: 4, is_unlocked: true, total_progress: '2', progress: '1', rewards: [] });
    const tasks = model.normalizeState(raw, NOW).tasks;
    const task = tasks.find(row => row.id === '300018');
    assert.deepEqual([task.upgradeFacilityModuleType, task.upgradeFacilityLevel, task.canClaim], [6, 2, false]);
    assert.equal(tasks.filter(row => Object.hasOwn(row, 'upgradeFacilityModuleType')).length, 1);
});

test('buy cross-checks current shop, discounts, max count and exact BigInt affordability', () => {
    const raw = fixture();
    raw.shop.goods_list[0].price = '900719925474099';
    let plan = model.planAction('buy', { shopId: 5, goodsId: '10002', count: 9 }, raw, NOW);
    assert.equal(plan.costItems[0].count, '8106479329266891');
    assert.deepEqual(plan.payload, { goods_id: '10002', num: '9', price: '900719925474099', auto_add: false });
    assert.throws(() => model.planAction('buy', { shopId: 5, goodsId: '10002', count: 11 }, raw, NOW), /不足/);
    raw.shop.goods_list[0].discount_start_time = '1699999999';
    raw.shop.goods_list[0].discount_end_time = '1700000001';
    raw.shop.goods_list[0].discount_price = '0';
    plan = model.planAction('buy', { shopId: 5, goodsId: '10002', count: 1 }, raw, NOW);
    assert.equal(plan.payload.price, '0');
    assert.throws(() => model.planAction('buy', { shopId: 5, goodsId: '10002', count: 100 }, raw, NOW), /上限/);
    assert.throws(() => model.planAction('buy', { shopId: 5, goodsId: '10002', count: 1, autoPlace: true }, raw, NOW), /入包/);
    raw.shopId = '6';
    assert.throws(() => model.planAction('buy', { shopId: 6, goodsId: '10002', count: 1 }, raw, NOW), /未确认/);
    raw.shopId = '5'; raw.shop.goods_list[0].item_id = '7001';
    assert.throws(() => model.planAction('buy', { shopId: 5, goodsId: '10002', count: 1 }, raw, NOW), /未确认/);
});

test('place verifies stock, kind and capacity; grass verifies exact machine stock and cap', () => {
    const raw = fixture();
    const plan = model.planAction('place', { ranchId: HUGE, itemId: '60001', count: 2 }, raw, NOW);
    assert.equal(plan.payload.items.length, 2);
    assert.deepEqual(plan.payload.items[0], { ranch_inst_id: HUGE, animal_id: '60001' });
    assert.equal(plan.costItems[0].count, '2');
    assert.throws(() => model.planAction('place', { ranchId: HUGE, itemId: '60001', count: 4 }, raw, NOW), /容量/);
    raw.cells.facilities[0].ranch.husbandry_type = 2;
    assert.throws(() => model.planAction('place', { ranchId: HUGE, itemId: '60001', count: 1 }, raw, NOW), /匹配/);
    raw.cells.facilities[0].ranch.husbandry_type = 1;
    raw.bag.physical_items[0].is_locked = true;
    assert.throws(() => model.planAction('place', { ranchId: HUGE, itemId: '60001', count: 1 }, raw, NOW), /不足/);
    assert.throws(() => model.planAction('place', { ranchId: HUGE, itemId: '999999', count: 1 }, raw, NOW), /匹配/);
    assert.deepEqual(model.planAction('addGrass', { facilityId: '22', count: 60 }, raw, NOW).payload, { instance_id: '22', add_count: 60, use_gold: false });
    assert.throws(() => model.planAction('addGrass', { facilityId: '22', count: 61 }, raw, NOW), /容量/);
    raw.bag.physical_items[1].is_locked = true;
    assert.throws(() => model.planAction('addGrass', { facilityId: '22', count: 1 }, raw, NOW), /不足/);
    assert.throws(() => model.planAction('addGrass', { facilityId: HUGE, count: 1 }, raw, NOW), /容量/);
});

test('produce/harvest use verified all/select semantics and reject stale/empty targets', () => {
    const raw = fixture();
    assert.deepEqual(model.planAction('produce', { all: true }, raw, NOW).payload, { targets: [] });
    assert.deepEqual(model.planAction('produce', { ranchId: HUGE, animalId: 7 }, raw, NOW).payload,
        { targets: [{ ranch_inst_id: HUGE, animal_inst_id: 7 }] });
    assert.deepEqual(model.planAction('harvest', { all: true }, raw, NOW).payload, { op: 1 });
    const plan = model.planAction('harvest', { ranchId: HUGE, animalId: 7 }, raw, NOW);
    assert.deepEqual(plan.payload, { op: 4, animals: [{ ranch_inst_id: HUGE, animal_inst_id: 7 }] });
    assert.deepEqual(model.planAction('harvest', { all: true }, raw, NOW).resultKeys, [`${HUGE}:1:7`, `${HUGE}:2:2`]);
    assert.throws(() => model.planAction('harvest', { targets: [] }, raw, NOW), /选择/);
    assert.throws(() => model.planAction('produce', { ranchId: HUGE, animalId: 8 }, raw, NOW), /变化/);
    raw.cells.facilities[0].ranch.animals[0].can_deliver = false;
    assert.throws(() => model.planAction('produce', { all: true }, raw, NOW), /没有/);
});

test('clean targets known own hazards; tasks batch only qualified ordinary rewards', () => {
    const raw = fixture();
    let plan = model.planAction('clean', {}, raw, NOW);
    assert.deepEqual(plan.payload, { ranch_inst_ids: [HUGE] });
    assert.deepEqual(plan.resultKeys, [`${HUGE}:3:9007199254740995`]);
    plan = model.planAction('claimTasks', { all: true }, raw, NOW);
    assert.deepEqual(plan.payload, { ids: [HUGE, '300009'], do_shared: false });
    assert.equal(plan.route, 'claimTasks');
    assert.equal(plan.expectedRewards[0].count, '2'); // share_multiple does not double ordinary rewards.
    assert.deepEqual(dto('BatchClaimTaskRewardRequest', plan.payload), plan.payload);
    assert.throws(() => model.planAction('claimTasks', { taskId: '9' }, raw, NOW), /未完成/);
    assert.throws(() => model.planAction('claimTasks', { all: true, double: true }, raw, NOW), /普通/);
    raw.tasks.task_info.growth_tasks[0].is_claimed = true;
    assert.throws(() => model.planAction('claimTasks', { taskId: HUGE }, raw, NOW), /未完成/);
    raw.cells.facilities[0].ranch.hazards = [];
    assert.throws(() => model.planAction('clean', {}, raw, NOW), /没有/);
    for (const unsupported of ['feed', 'useCan', 'claimIllustrated']) assert.throws(() => model.planAction(unsupported, {}, raw, NOW), /不支持/);
});

test('signed item-instance identifiers and unset timers do not become inventory quantities', () => {
    const raw = fixture();
    // Independent protobuf writer: Item field 6 is a signed identifier.
    const itemWire = protobuf.Writer.create().uint32(8).int64(60001).uint32(16).int64(5)
        .uint32(48).int64('-9223372036854775808').finish();
    raw.bag.physical_items[0] = codec.decode('Item', itemWire);
    raw.cells.facilities[0].upgrade_end_time = '-1';
    raw.cells.facilities[0].ranch.grass = { amount: '0', empty_at_ms: '-1' };
    raw.cells.facilities[0].ranch.animals[0].produce_ready_at_ms = '-1';
    raw.cells.facilities[1].feed_machine.remaining_secs = '-1';
    const state = model.normalizeState(raw, NOW);
    assert.equal(state.inventory[0].uid, '-9223372036854775808');
    assert.equal(state.inventory[0].count, '5');
    assert.equal(state.facilities[0].upgradeEndTime, null);
    assert.equal(state.facilities[0].ranch.grass.emptyAtMs, null);
    assert.equal(state.animals[0].produceReadyAtMs, null);
    assert.equal(state.facilities[1].feed.remainingSec, null);
    raw.bag.physical_items[0].count = '-1';
    assert.throws(() => model.normalizeState(raw, NOW), /物品数量必须是非负整数/);
    raw.bag.physical_items[0].count = '5';raw.cells.facilities[0].upgrade_end_time = '-2';
    assert.throws(() => model.normalizeState(raw, NOW), /设施升级时间必须是非负整数/);
});

test('shop zero timestamps are not quantities or active free discounts', () => {
    const raw = fixture();
    const goods = raw.shop.goods_list[0];
    goods.discount_start_time = '-62135596800'; goods.discount_end_time = '-62135596800'; goods.discount_price = '0';
    assert.equal(model.normalizeState(raw, NOW).shop.goods[0].price.count, '10');
    assert.equal(model.planAction('buy', { shopId: '5', goodsId: '10002', count: 2 }, raw, NOW).costItems[0].count, '20');
    goods.discount_start_time = String(Math.floor(NOW / 1000) - 10); goods.discount_end_time = String(Math.floor(NOW / 1000) + 10); goods.discount_price = '3';
    assert.equal(model.planAction('buy', { shopId: '5', goodsId: '10002', count: 2 }, raw, NOW).costItems[0].count, '6');
    goods.discount_price = '-1';assert.throws(() => model.normalizeState(raw, NOW), /物品数量必须是非负整数/);
    goods.discount_price = '3';goods.is_display_countdown = true;goods.end_time = '-62135596800';
    assert.equal(model.normalizeState(raw, NOW).shop.goods[0].available, false);
});
