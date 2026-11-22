'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const test = require('node:test');
const temp = fs.realpathSync(os.tmpdir());
const repo = fs.realpathSync(path.join(__dirname, '../..'));
assert.ok(temp !== repo && !temp.startsWith(repo + path.sep));
const prefix = path.resolve(temp, 'farm-ranch-service-');
assert.equal(path.dirname(prefix), temp);
const root = fs.mkdtempSync(prefix);
assert.equal(fs.realpathSync(root), root);
function fixturePath(name) {
  const target = path.resolve(root, name);
  assert.equal(path.dirname(target), root);
  assert.equal(fs.existsSync(target), false);
  return target;
}
process.env.FARM_DATA_DIR = root;
process.env.FARM_PRIVATE_CONFIG_FILE = fixturePath('private-config.json');
process.env.FARM_LOG_DIR = fixturePath('logs');
process.env.FARM_SESSION_LOG_DIR = fixturePath('session-logs');
const codec = require('../src/services/ranch-codec');
const { encode, decode } = require('../src/runtime/session-codec');
const { createRanchService } = require('../src/services/ranch-service');
const { createGameSceneCoordinator } = require('../src/runtime/game-scene-coordinator');
test.after(() => {
  // Run after the daily-feedback exit flush, which can otherwise recreate the fixture directory.
  process.once('exit', () => {
    assert.equal(fs.realpathSync(root), root);
    fs.rmSync(root, { recursive: true, force: true });
    assert.equal(fs.existsSync(root), false);
  });
});
function fixture(upgrade = false) {
  const file = fixturePath(`operations-${Math.random().toString(16).slice(2)}.json`);
  let now = 1800000000000; let gameOffset = 0; let allowed = true; let failure = false; let malformed = false;
  let gold = upgrade ? 50000 : 100; let price = 10; let grass = 50; let writes = 0;
  let nextAnimal = 8;
  const cubs = new Map();
  const calls = []; const leases = []; const ws = {}; let beforeWrite;
  const facilities = [
    { instance_id: '11', facility_id: 6001002, module_type: 6, state: 1, level: 2, capacity: 4,
      ranch: { ranch_inst_id: '11', capacity: 4, animal_count: 1, husbandry_type: 1,
        animals: [{ ranch_inst_id: '11', animal_inst_id: 7, animal_id: '60001', can_deliver: true, can_harvest: true }] } },
    { instance_id: '22', facility_id: 7001001, module_type: 8, state: 1, level: 1, capacity: 100, feed_machine: { feed_count: 10 } },
  ];
  if (upgrade) {
    Object.assign(facilities[0], { facility_id: 6001001, level: 1, capacity: 3, upgrade_state: 0, upgrade_end_time: '0' });
    facilities[0].ranch.capacity = 3;
  }
  const network = {
    getWs: () => ws, isConnected: () => true, getUserState: () => ({ gid: 42 }),
    withRanchScene: async (callback, options) => {
      leases.push(options.maxCalls);
      if (f.realScene) return scene.run(callback, options);
      const value = await callback({ initial: f.initial, assertCurrent() {} });
      now += f.restoreDelayMs || 0;
      return value;
    },
    sendMsgAsync: async (service, method, wire) => {
      calls.push(method);
      if (f.onRead) await f.onRead(method);
      const route = Object.values(codec.ROUTES).find(x => x.method === method && x.service === service);
      const request = codec.decode(route.request, wire); let reply;
      if (method === 'PlayerSceneLogin') {
        const id = request.global_scene_id;
        reply = { global_scene_id: id, ...(id === 2
          ? { big_farm_scene_ext_data: codec.encode('SceneData', { homestead_cells: { grid_width: 10, grid_height: 10, facilities } }) }
          : { farm_scene_ext_data: Buffer.from([1]) }) };
      } else if (method === 'AllCells') reply = { grid_width: 10, grid_height: 10, facilities: malformed && writes ? [{ ...facilities[0], instance_id: '0' }] : facilities };
      else if (method === 'GetBag') reply = { global_scene_id: 2,
        physical_items: [{ id: '7001', count: String(grass) }, ...[...cubs].map(([id, count]) => ({ id, count: String(count) })), ...f.lockedCubs, ...f.products.filter(row => BigInt(row.count) > 0n)],
        virtual_items: [{ id: '1007', count: String(gold) }, ...(upgrade ? [{ id: '1102', count: '40000' }] : [])] };
      else if (method === 'GetFacilityDetail') {
        const facility = facilities[0]; assert.equal(request.instance_id, facility.instance_id);
        reply = { info: { instance_id: facility.instance_id, facility_id: facility.facility_id, module_type: facility.module_type,
          level: facility.level, upgrade_cost: [{ id: '1007', count: String(f.upgradeCost) }] } };
      }
      else if (method === 'ShopProfiles') reply = { shop_profiles: [5, 6].map(shop_id => ({ shop_id, global_scene_ids: [2] })) };
      else if (method === 'ShopInfo') reply = { goods_list: f.goods() };
      else if (method === 'TaskInfo') reply = { task_info: { growth_tasks: f.tasks } };
      else if (method === 'EnterHomestead') {
        assert.ok(f.friendHosts.includes(request.host_gid));
        assert.equal(request.reason, 2);
        f.friendVisits.push(request.host_gid);
        reply = { basic: { gid: request.host_gid, name: '测试好友' }, is_tourist: f.tourist === true,
          homestead_cells: { facilities: [{ instance_id: '51' }] } };
      } else if (method === 'GetRanchDetail') {
        assert.ok(f.friendHosts.includes(request.host_gid));
        reply = { ranches: f.friendRanches };
      } else if (method === 'LeaveHomestead') {
        assert.ok(f.friendHosts.includes(request.host_gid));
        reply = {};
      } else {
        if (f.queueFull) throw decode(encode(Object.assign(new Error('synthetic request queue full'), { isLocalRequestRejection: true })));
        if (f.rejectUnsent) throw Object.assign(new Error('synthetic budget rejection'), { isGovernedRejection: true });
        beforeWrite?.(); writes++;
        if (failure) throw decode(encode(Object.assign(new Error('synthetic timeout'), { code: 'LOCAL_REQUEST_TIMEOUT' })));
        if (method === 'UpgradeBuilding') {
          assert.equal(request.inst_id, facilities[0].instance_id);
          gold -= f.upgradeCost; facilities[0].upgrade_state = 1; facilities[0].upgrade_end_time = String(Math.floor(now / 1000) + 10);
          reply = { upgrade: { inst_id: request.inst_id, target_facility_id: 6001002, target_level: 2, state: 1, end_time: facilities[0].upgrade_end_time } };
        } else if (method === 'CompleteBuildingUpgrade') {
          assert.equal(request.inst_id, facilities[0].instance_id);
          Object.assign(facilities[0], { facility_id: 6001002, level: 2, capacity: 4, upgrade_state: 0, upgrade_end_time: '0' });
          facilities[0].ranch.capacity = 4;
          reply = { facility: facilities[0], item: { inst_id: request.inst_id, facility_id: 6001002, level: 2 } };
        } else if (method === 'BuyGoods') {
          const good = f.goods().find(row => row.id === request.goods_id);
          const count = Number(request.num);
          const cost = Number(request.price) * count;
          const quantity = Number(good.item_count) * count;
          gold -= cost;
          cubs.set(good.item_id, (cubs.get(good.item_id) || 0) + quantity);
          if (good.limit_count) good.bought_num = String(Number(good.bought_num ?? 0) + count);
          reply = { goods: { id: good.id }, cost_items: [{ id: '1007', count: String(cost) }], get_items: [{ id: good.item_id, count: String(quantity) }] };
        } else if (method === 'Sell') {
          const earned = new Map();
          for (const stack of request.items) {
            const original = f.products.find(row => row.id === stack.id && row.uid === stack.uid);
            assert.ok(original);
            original.count = (BigInt(original.count) - BigInt(stack.count)).toString();
            for (const price of original.show.sells) earned.set(price.id, (earned.get(price.id) || 0n) + BigInt(price.count) * BigInt(stack.count));
          }
          reply = { sell_items: request.items.map(({ id, uid, count }) => ({ id, uid, count })),
            get_items: [...earned].map(([id, count]) => ({ id, count: count.toString() })) };
        } else if (method === 'StealProduce') {
          assert.ok(f.friendHosts.includes(request.host_gid));
          assert.deepEqual(request.targets, [{ ranch_inst_id: '51', slot_index: 0 }]);
          reply = { op_results: [{ facility_inst_id: '51', kind: 2, target_id: '0', rewards: [{ id: '1060001', count: '1' }] }] };
        } else if (method === 'CleanAllRanch' && f.friendHosts.includes(request.host_gid)) {
          assert.deepEqual(request.ranch_inst_ids, ['51']);
          reply = { op_results: [{ facility_inst_id: '51', kind: 3, target_id: '2' }] };
        } else if (method === 'AddFeed') { grass -= request.add_count; reply = { consumed: [{ id: '7001', count: String(request.add_count) }] }; }
        else if (method === 'PlaceAnimal') {
          reply = { op_results: request.items.map(({ ranch_inst_id, animal_id }) => {
            const room = facilities.find(row => row.instance_id === ranch_inst_id).ranch;
            const animal_inst_id = nextAnimal++;
            cubs.set(animal_id, cubs.get(animal_id) - 1);
            room.animals.push({ ranch_inst_id, animal_id, animal_inst_id });
            room.animal_count++;
            return { facility_inst_id: ranch_inst_id, kind: 1, target_id: String(animal_inst_id) };
          }) };
        } else reply = { op_results: [{ facility_inst_id: '11', kind: 1, target_id: '7' }] };
      }
      if (route.writing && f.mutateReply) reply = f.mutateReply(reply);
      return { body: codec.encode(route.reply, reply) };
    },
  };
  const send = network.sendMsgAsync;
  const scene = createGameSceneCoordinator({
    identity: () => ({ key: 'ranch-fixture', connected: true, level: 30 }),
    priority: () => f.farmPriority === true,
    profile: () => ({ totalLimit: 80, perMethodLimit: 30, windowCount: 0, top: [] }),
    encodeScene: id => codec.encode('PlayerSceneLoginRequest', { global_scene_id: id }),
    decodeScene: body => codec.decode('PlayerSceneLoginReply', body),
    send,
  });
  network.sendMsgAsync = (...args) => f.realScene ? scene.send(...args) : send(...args);
  const make = () => createRanchService({ network, file: () => file, now: () => now + gameOffset, quoteNow: () => now, canAutomate: () => allowed,
    getFriendTargets: () => { if (f.rosterError) throw f.rosterError; return f.friendRoster; },
    canVisitFriend: gid => !f.friendQuiet && !f.blockedFriends.includes(gid) });
  const f = { service: make(), make, calls, leases, scene, file, cubs, facilities, lockedCubs: [], products: [], tasks: [], friendRanches: [], upgradeCost: 14000,
    friendHosts: ['73'], friendVisits: [], friendRoster: [], blockedFriends: [],
    goods: () => [{ id: '10002', item_id: '60001', item_count: '1', price: String(price), unlocked: true }], get writes() { return writes; }, advance: ms => { now += ms; }, correctGameClock: ms => { gameOffset = ms; },
    price: n => { price = n; }, gold: n => { gold = n; }, timeout: () => { failure = true; }, malformed: () => { malformed = true; },
    allow: value => { allowed = value; }, beforeWrite: fn => { beforeWrite = fn; } };
  return f;
}
async function quoteBuy(f) {
  const result = await f.service.prepare('buy', { shopId: '5', goodsId: '10002', count: 1 });
  assert.equal(result.ok, true, JSON.stringify(result)); return result.data.id;
}

async function setOnlyAutomation(f, flags) {
  const { data: { policy } } = await f.service.getAutomation();
  const result = await f.service.setAutomation({ ...policy, harvest: false, produce: false, clean: false, tasks: false, enabled: true, ...flags });
  assert.equal(result.ok, true, result.error);
  f.advance(31000);
}

function saleStack(uid, itemId, count, extra = {}) {
  return { uid, id: itemId, count: String(count), show: { sells: [{ id: '1002', count: '5' }] }, ...extra };
}

test('automatic ranch sale keeps the egg task gap and skips locked or conditionally priced stacks', async () => {
  const f = fixture();
  f.tasks.push({ id: '300006', desc: '出售鸡蛋', progress: '1', total_progress: '3', task_type: 4, is_unlocked: true });
  f.products.push(saleStack('101', '1060001', 6), saleStack('102', '1060002', 3), saleStack('103', '1060001', 4, { is_locked: true }),
    saleStack('104', '1060003', 2, { show: { sells: [{ id: '1002', count: '5' }], sell_cond: [{ type: 'fixture' }] } }));
  await setOnlyAutomation(f, { sellProducts: true });
  const result = await f.service.automate();
  assert.equal(result.ok, true, result.error);
  assert.equal(result.data.outcome, 'confirmed');
  assert.deepEqual(f.products.map(row => row.count), ['2', '0', '4', '2']);
  assert.equal(f.writes, 1);
  assert.equal((await f.service.getAutomation()).data.usage['sell:1060002'], '3');
  f.advance(300001);
  assert.equal((await f.service.automate()).data.skipped, true);
  assert.equal(f.writes, 1);
});

test('manual confirmation owns sales and a confirmed harvest schedules an earlier product sale', async () => {
  const f = fixture();
  await setOnlyAutomation(f, { harvest: true, sellProducts: true });
  f.beforeWrite(() => {
    if (f.writes === 0) f.products.push(saleStack('101', '1060002', 3));
  });
  assert.equal((await f.service.automate()).data.action, 'harvest');
  const manual = await f.service.prepare('sell', { all: true });
  assert.equal(manual.ok, true, manual.error);
  f.advance(31000);
  assert.equal((await f.service.automate()).data.action, 'harvest');
  assert.equal(f.products[0].count, '3');
  assert.equal(f.calls.includes('Sell'), false);
  assert.equal((await f.service.cancel(manual.data.id)).data.cancelled, true);
  f.advance(300001);
  const result = await f.service.automate();
  assert.equal(result.data.action, 'sell');
  assert.equal(result.data.outcome, 'confirmed');
  assert.equal(f.products[0].count, '0');
});

test('the egg task owns its current gap before the surplus sale while both rules are enabled', async () => {
  const f = fixture();
  const task = { id: '300006', desc: '出售鸡蛋', progress: '1', total_progress: '3', task_type: 4, is_unlocked: true };
  f.tasks.push(task);
  f.products.push(saleStack('101', '1060001', 6), saleStack('102', '1060002', 3));
  await setOnlyAutomation(f, { eggSale: true, sellProducts: true });
  f.beforeWrite(() => { task.progress = '3'; });
  const taskSale = await f.service.automate();
  assert.equal(taskSale.data.label, '出售鸡蛋任务');
  assert.equal(taskSale.data.outcome, 'confirmed');
  assert.deepEqual(f.products.map(row => row.count), ['4', '3']);
  f.advance(300001);
  const surplusSale = await f.service.automate();
  assert.equal(surplusSale.data.label, '出售可售产物');
  assert.equal(surplusSale.data.outcome, 'confirmed');
  assert.deepEqual(f.products.map(row => row.count), ['0', '0']);
  assert.equal(f.writes, 2);
});

test('automatic friend ranch runs on its own interval and executes both actions during one visit', async () => {
  const f = fixture();
  f.realScene = true;
  f.friendHosts.push('74');
  f.friendRoster.push({ gid: '73' }, { gid: '74' }, { gid: '42' }, { gid: '75' }, { gid: null });
  f.blockedFriends.push('75');
  f.friendRanches.push({ ranch_inst_id: '51', shelves: [
    { slot_index: 0, can_steal: true, lots: [{ item_id: '1060001', can_steal: true, remain_num: '2' }] },
  ], hazards: [{ hazard_id: '2', owner: '50', hazard_type: 1 }] });
  await setOnlyAutomation(f, { friendSteal: true, friendClean: true, harvest: true, produce: true, clean: true, tasks: true, intervalMinutes: 2 });
  f.friendQuiet = true;
  assert.equal((await f.service.automate()).data.action, 'harvest');
  assert.deepEqual(f.friendVisits, []);
  f.calls.length = 0;
  f.friendQuiet = false;
  f.advance(30000);
  for (const gid of ['73', '74']) {
    const before = f.calls.length;
    const result = await f.service.automate();
    assert.equal(result.ok, true, result.error);
    assert.deepEqual(result.data.results.map(row => [row.action, row.friendGid, row.outcome]),
      [['stealFriend', gid, 'confirmed'], ['cleanFriend', gid, 'confirmed']]);
    assert.deepEqual(f.calls.slice(before), ['PlayerSceneLogin', 'EnterHomestead', 'GetRanchDetail',
      'StealProduce', 'CleanAllRanch', 'LeaveHomestead', 'PlayerSceneLogin']);
    assert.equal(f.scene.snapshot().scene, 1);
    if (gid === '73') {
      f.advance(90001);
      assert.equal((await f.service.automate()).data.action, 'produce');
      f.advance(30000);
    }
  }
  assert.deepEqual(f.friendVisits, ['73', '74']);
  assert.equal(f.writes, 6);
});

test('automatic friend ranch keeps prepared manual work and a newly blacklisted target from dispatching', async () => {
  const f = fixture();
  f.friendRoster.push({ gid: '73' });
  f.friendRanches.push({ ranch_inst_id: '51', shelves: [
    { slot_index: 0, can_steal: true, lots: [{ item_id: '1060001', can_steal: true, remain_num: '2' }] },
  ] });
  await setOnlyAutomation(f, { friendSteal: true });
  const manual = await f.service.prepare('stealFriend', { hostGid: '73' });
  assert.equal(manual.ok, true);
  const before = f.calls.length;
  assert.equal((await f.service.automate()).data.skipped, true);
  assert.equal(f.calls.length, before);
  await f.service.cancel(manual.data.id);
  f.onRead = method => {
    if (method === 'GetRanchDetail') f.blockedFriends.push('73');
  };
  assert.equal((await f.service.automate()).code, 'RANCH_AUTOMATION_PAUSED');
  assert.equal(f.writes, 0);
});

test('an empty steal shelf still lets the same visit clean and a failed roster is reported separately', async t => {
  const records = ranchLogs(t);
  const f = fixture();
  f.friendRoster.push({ gid: '73', name: '测试好友' });
  f.friendRanches.push({ ranch_inst_id: '51', hazards: [{ hazard_id: '2', owner: '50', hazard_type: 1 }] });
  await setOnlyAutomation(f, { friendSteal: true, friendClean: true, intervalMinutes: 2 });
  f.rosterError = new Error('upstream fixture');
  assert.equal((await f.service.automate()).failureStage, 'friendRoster');
  assert.deepEqual(f.calls, []);
  assert.deepEqual(records.filter(row => row.meta.reason === 'read_failed').map(row => [row.meta.action, row.meta.failureStage]),
    [['stealFriend', 'friendRoster'], ['cleanFriend', 'friendRoster']]);
  f.rosterError = null;
  f.advance(120001);
  const scan = await f.service.automate();
  assert.equal(scan.data.action, 'cleanFriend');
  assert.equal(scan.data.outcome, 'confirmed');
  assert.equal(f.calls.includes('StealProduce'), false);
  assert.ok(records.some(row => row.meta.action === 'stealFriend' && row.meta.reason === 'no_friend_targets'));
  assert.ok(records.some(row => row.meta.action === 'cleanFriend' && row.meta.result === 'confirmed'));
});

test('friend patrol keeps its candidate during priority deferral and stops after an uncertain result', async () => {
  const f = fixture();
  f.realScene = true;
  f.friendHosts.push('74');
  f.friendRoster.push({ gid: '73' }, { gid: '74' });
  f.friendRanches.push({ ranch_inst_id: '51', shelves: [
    { slot_index: 0, can_steal: true, lots: [{ item_id: '1060001', can_steal: true, remain_num: '2' }] },
  ], hazards: [{ hazard_id: '2', owner: '50', hazard_type: 1 }] });
  await setOnlyAutomation(f, { friendSteal: true, friendClean: true });
  f.farmPriority = true;
  assert.equal((await f.service.automate()).code, 'RANCH_FARM_PRIORITY');
  assert.deepEqual(f.calls, []);
  f.advance(30001);
  f.farmPriority = false;
  f.timeout();
  assert.equal((await f.service.automate()).data.outcome, 'unknown');
  assert.deepEqual(f.friendVisits, ['73']);
  assert.equal(f.calls.includes('CleanAllRanch'), false);
  assert.equal(f.scene.snapshot().scene, 1);
  f.advance(300001);
  assert.equal((await f.make().automate()).data.skipped, true);
  assert.equal(f.writes, 1);
});

test('friend ranch verifies visit identity, previews available targets and confirms each write once', async () => {
  const f = fixture();
  f.friendRanches.push({ ranch_inst_id: '51', shelves: [
    { slot_index: 0, can_steal: true, lots: [{ item_id: '1060001', can_steal: true, remain_num: '2' }] },
    { slot_index: 1, can_steal: true, lots: [{ item_id: '1060002', can_steal: true, remain_num: '2', stealers: ['42'] }] },
  ], hazards: [{ hazard_id: '2', owner: '50', hazard_type: 1 }, { hazard_id: '3', owner: '42', hazard_type: 1 }] });
  const friend = await f.service.getFriend('73');
  assert.equal(friend.ok, true, friend.error);
  assert.deepEqual([friend.data.stealCount, friend.data.cleanCount], [1, 1]);
  assert.deepEqual(f.calls, ['EnterHomestead', 'GetRanchDetail', 'LeaveHomestead']);
  for (const action of ['stealFriend', 'cleanFriend']) {
    const before = f.writes;
    const quote = await f.service.prepare(action, { hostGid: '73' });
    assert.equal(quote.ok, true, quote.error);
    assert.equal(f.writes, before);
    const result = await f.service.execute(quote.data.id);
    assert.equal(result.data.outcome, 'confirmed', result.data.message);
    assert.equal(result.data.completed, 1);
    assert.equal(f.writes, before + 1);
    assert.equal(f.calls.at(-1), 'LeaveHomestead');
    assert.equal((await f.service.execute(quote.data.id)).data.replayed, true);
    assert.equal(f.writes, before + 1);
  }
  f.tourist = true;
  assert.equal((await f.service.getFriend('73')).code, 'RANCH_FRIEND_UNAVAILABLE');
  assert.deepEqual(f.calls.slice(-2), ['EnterHomestead', 'LeaveHomestead']);
  f.tourist = false;
  f.friendRanches[0].ranch_inst_id = '91';
  assert.equal((await f.service.getFriend('73')).code, 'RANCH_RESPONSE_MISMATCH');
  assert.equal(f.calls.at(-1), 'LeaveHomestead');
  assert.equal((await f.service.prepare('stealFriend', { hostGid: '42' })).code, 'RANCH_INVALID_ARGUMENT');
  assert.equal(f.writes, 2);
});

test('friend ranch rechecks targets before dispatch and keeps mismatched receipts unresolved', async () => {
  const f = fixture();
  const lot = { item_id: '1060001', can_steal: true, remain_num: '2' };
  f.friendRanches.push({ ranch_inst_id: '51', shelves: [{ slot_index: 0, can_steal: true, lots: [lot] }] });
  const quote = await f.service.prepare('stealFriend', { hostGid: '73' });
  assert.equal(quote.ok, true);
  lot.can_steal = false;
  assert.equal((await f.service.execute(quote.data.id)).code, 'RANCH_STATE_CHANGED');
  assert.equal(f.writes, 0);
  lot.can_steal = true;
  f.mutateReply = reply => ({ ...reply, op_results: [{ ...reply.op_results[0], facility_inst_id: '12' }] });
  const result = await f.service.execute(quote.data.id);
  assert.equal(result.data.outcome, 'unknown');
  assert.equal(result.data.friendGid, '73');
  assert.equal((await f.service.execute(quote.data.id)).data.replayed, true);
  assert.equal((await f.service.prepare('stealFriend', { hostGid: '73' })).code, 'RANCH_RESULT_UNCONFIRMED');
  assert.equal((await f.service.getState()).ok, true);
  assert.equal((await f.service.acknowledge(quote.data.id)).code, 'RANCH_REFRESH_REQUIRED');
  assert.equal((await f.service.getFriend('73')).ok, true);
  assert.equal((await f.service.acknowledge(quote.data.id)).data.outcome, 'acknowledged');
  assert.equal(f.writes, 1);
});

test('real service prepares without writes; fresh price changes reject, confirmed receipt is not replayed', async () => {
  const f = fixture(); const id = await quoteBuy(f); assert.equal(f.writes, 0);
  f.price(11); assert.equal((await f.service.execute(id)).code, 'RANCH_STATE_CHANGED'); assert.equal(f.writes, 0);
  f.price(10); const result = await f.service.execute(id); assert.equal(result.data.outcome, 'confirmed'); assert.equal(f.writes, 1);
  assert.equal((await f.make().execute(id)).data.replayed, true); assert.equal(f.writes, 1);
});
test('only proven unsent automatic writes release their durable budget reservation', async () => {
  const f = fixture(); const policy = (await f.service.getAutomation()).data.policy;
  await f.service.setAutomation({ ...policy, enabled: true, buyEnabled: true, goodsId: '10002', currencyDailyLimit: 10 });
  const auto = (await f.service.getAutomation()).data;
  const quote = await f.service.prepare('buy', { shopId: '5', goodsId: '10002', count: 1 }, auto.revision);
  f.rejectUnsent = true;
  assert.equal((await f.service.execute(quote.data.id)).data.outcome, 'not_sent');
  assert.equal(f.writes, 0); assert.equal((await f.service.getAutomation()).data.usage['buy:1007'], '0');
  f.rejectUnsent = false;
  const retry = await f.service.prepare('buy', { shopId: '5', goodsId: '10002', count: 1 }, auto.revision);
  f.timeout(); assert.equal((await f.service.execute(retry.data.id)).data.outcome, 'unknown');
  assert.equal((await f.make().getAutomation()).data.usage['buy:1007'], '10');
  f.advance(86400000);
  assert.equal((await f.make().automate()).data.skipped, true); assert.equal(f.writes, 1);
});
test('a bridged queue rejection refunds the write reservation, while a bridged timeout stays unknown and never replays', async () => {
  const f = fixture(); const policy = (await f.service.getAutomation()).data.policy;
  const settings = await f.service.setAutomation({ ...policy, enabled: true, buyEnabled: true, goodsId: '10002', currencyDailyLimit: 10 });
  const prepare = () => f.service.prepare('buy', { shopId: '5', goodsId: '10002', count: 1 }, settings.data.revision);
  const first = await prepare();
  assert.equal(first.ok, true, first.error);
  f.queueFull = true;
  const rejected = await f.service.execute(first.data.id);
  assert.equal(rejected.data.outcome, 'not_sent');
  assert.equal(rejected.operationNotSent, undefined);
  assert.equal(f.writes, 0);
  assert.equal((await f.service.getAutomation()).data.usage['buy:1007'], '0');

  f.queueFull = false;
  const second = await prepare();
  assert.equal(second.ok, true, second.error);
  f.timeout();
  const timedOut = await f.service.execute(second.data.id);
  assert.equal(timedOut.data.outcome, 'unknown');
  assert.equal(timedOut.operationNotSent, undefined);
  const replacement = f.make();
  assert.equal((await replacement.execute(second.data.id)).data.outcome, 'unknown');
  assert.equal((await replacement.getAutomation()).data.usage['buy:1007'], '10');
  assert.equal(f.writes, 1);
});
test('place subtracts exact inventory reserve before imposing batch and capacity limits', () => {
  const { DEFAULT_POLICY, chooseAction } = require('../src/services/ranch-policy');
  const state = { cubs: [{ id: '60001', count: '100', locked: false }], facilities: [{ id: '11', active: true, ranch: { capacity: 4, count: 0 } }] };
  const action = chooseAction({ ...DEFAULT_POLICY, placeEnabled: true, cubId: '60001', ranchId: '11', cubReserve: 60, cubDailyLimit: 50 }, state, 5);
  assert.equal(action.input.count, 4);
});
test('authenticated offline worker can disable automation without a game read', async () => {
  const { registerAdminRanchRoutes } = require('../src/controllers/admin-ranch-routes');
  const routes = new Map(); let saved;
  registerAdminRanchRoutes({ app: { get() {}, post: (route, handler) => routes.set(route, handler) },
    getAccountIdFromRequest: () => 'account-a', canAccessAccount: () => true,
    provider: { isAccountRunning: () => true, getStatus: () => { throw new Error('connection must not gate configuration'); },
      setRanchAutomation: async (_id, value) => { saved = value; return { ok: true, data: value }; } } });
  const res = { status() { return this; }, json(value) { this.body = value; return this; } };
  await routes.get('/api/ranch/automation')({ body: { enabled: false } }, res);
  assert.equal(saved.enabled, false); assert.equal(res.body.ok, true);
});
test('explicit acknowledgement cancels an unconsumed quote durably without replaying it', async () => {
  const f = fixture(); const id = await quoteBuy(f);
  await f.service.getState();
  const result = await f.service.acknowledge(id);
  assert.equal(result.ok, true, result.error);
  assert.equal(result.data.outcome, 'not_sent');
  assert.equal(f.writes, 0);
  assert.equal((await f.make().acknowledge(id)).data.outcome, 'not_sent', 'a lost cancellation reply is safe to acknowledge again');
  assert.equal((await f.make().execute(id)).data.outcome, 'not_sent');
  assert.equal(f.writes, 0);
  const fresh = await quoteBuy(f);
  assert.notEqual(fresh, id);
  assert.equal((await f.service.execute(fresh)).data.outcome, 'confirmed');
  assert.equal(f.writes, 1);
});
test('explicit cancellation stops a preflight that was already waiting for its read', async () => {
  const f = fixture(); const id = await quoteBuy(f);
  let entered; let release;
  const started = new Promise(resolve => { entered = resolve; });
  const paused = new Promise(resolve => { release = resolve; });
  f.onRead = async method => { if (method === 'GetBag') { entered(); await paused; } };
  const old = f.service.execute(id);
  await started;
  let cancelled;
  try {
    cancelled = await f.service.acknowledge(id);
  } finally { release(); }
  const late = await old;
  assert.equal(cancelled.ok, true, cancelled.error);
  assert.equal(cancelled.data.outcome, 'not_sent');
  assert.equal(late.ok, true, late.error);
  assert.equal(late.data.outcome, 'not_sent');
  assert.equal(late.data.replayed, true);
  assert.equal(f.writes, 0);
});
test('a prepared quote cannot acknowledge or replace a different unknown write', async () => {
  const f = fixture(); const sent = await quoteBuy(f); const prepared = await quoteBuy(f);
  f.timeout();
  assert.equal((await f.service.execute(sent)).data.outcome, 'unknown');
  const denied = await f.service.acknowledge(prepared);
  assert.equal(denied.ok, false);
  assert.equal(denied.code, 'RANCH_INVALID_ARGUMENT');
  const data = JSON.parse(fs.readFileSync(f.file));
  assert.equal(data.lastOperation.id, sent);
  assert.equal(data.lastOperation.outcome, 'unknown');
  assert.equal(data.quotes.find(row => row.id === prepared).status, 'prepared');
  assert.equal(f.writes, 1);
});
test('timeout persists across replacement, blocks manual and automatic until a fresh observed acknowledgement', async () => {
  const f = fixture(); const id = await quoteBuy(f); f.timeout();
  assert.equal((await f.service.execute(id)).data.outcome, 'unknown');
  const next = f.make(); assert.equal((await next.prepare('produce', { all: true })).code, 'RANCH_RESULT_UNCONFIRMED');
  assert.equal((await next.acknowledge(id)).code, 'RANCH_REFRESH_REQUIRED');
  await next.getState(); assert.equal((await next.acknowledge(id)).data.outcome, 'acknowledged');
  assert.equal((await next.execute(id)).data.replayed, true); assert.equal(f.writes, 1);
});
test('confirmed buy survives malformed refreshed DTO and cancel prevents dispatch', async () => {
  const f = fixture(); const id = await quoteBuy(f); f.malformed();
  const result = await f.service.execute(id); assert.equal(result.ok, true); assert.equal(result.data.outcome, 'confirmed');
  assert.equal(result.data.snapshot, null); assert.equal(result.data.refreshRequired, true);
  const g = fixture(); const pending = await quoteBuy(g); await g.service.cancel(pending);
  assert.equal((await g.service.execute(pending)).data.outcome, 'not_sent'); assert.equal(g.writes, 0);
});
test('invalid refreshed state cannot authorize acknowledgement of an unknown write', async () => {
  const f = fixture(); const id = await quoteBuy(f); f.timeout(); f.malformed();
  assert.equal((await f.service.execute(id)).data.outcome, 'unknown');
  assert.equal((await f.service.getState()).ok, false);
  assert.equal((await f.service.acknowledge(id)).code, 'RANCH_REFRESH_REQUIRED');
});
test('place checks new animal and exact destination, duplicate and missing receipt targets', async () => {
  for (const mutate of [null, r => ({ op_results: r.op_results.map(x => ({ ...x, facility_inst_id: '99' })) }),
    r => ({ op_results: [r.op_results[0], r.op_results[0]] }), () => ({ op_results: [] })]) {
    const f = fixture(); f.mutateReply = mutate; f.cubs.set('60001', 5);
    const quote = await f.service.prepare('place', { ranchId: '11', itemId: '60001', count: 2 }); assert.equal(quote.ok, true);
    const result = await f.service.execute(quote.data.id); assert.equal(result.data.outcome, mutate ? 'unknown' : 'confirmed');
  }
});
test('automation is opt-in, shares durable intent and budget, stops after config changes and respects admission', async () => {
  const f = fixture(); assert.equal((await f.service.automate()).data.skipped, true); assert.equal(f.calls.length, 0);
  let config = (await f.service.getAutomation()).data.policy;
  config = { ...config, enabled: true, buyEnabled: true, goodsId: '10002', currencyDailyLimit: 10, currencyReserve: 90 };
  await f.service.setAutomation(config);
  const data = JSON.parse(fs.readFileSync(f.file)); data.automation.cursor = 6; fs.writeFileSync(f.file, JSON.stringify(data));
  f.advance(31000); f.allow(false); await f.service.automate(); assert.equal(f.writes, 0); f.allow(true);
  f.beforeWrite(() => {
    const saved = JSON.parse(fs.readFileSync(f.file)); assert.equal(saved.lastOperation.outcome, 'pending');
    assert.equal(saved.automation.usage['buy:1007'], '10');
  });
  const result = await f.service.automate(); assert.equal(result.data.outcome, 'confirmed', JSON.stringify(result)); assert.equal(f.writes, 1);
  const next = f.make(); const auto = (await next.getAutomation()).data; assert.equal(auto.usage['buy:1007'], '10');
  const q = await next.prepare('buy', { shopId: '5', goodsId: '10002', count: 1 }, auto.revision);
  assert.equal(q.code, 'RANCH_AUTOMATION_PAUSED');
  await next.setAutomation({ ...config, currencyDailyLimit: 30, currencyReserve: 0 });
  const revision = (await next.getAutomation()).data.revision;
  const prepared = await next.prepare('buy', { shopId: '5', goodsId: '10002', count: 1 }, revision);
  assert.equal(prepared.ok, true);
  await next.setAutomation({ ...config, enabled: false });
  assert.equal((await next.execute(prepared.data.id)).code, 'RANCH_AUTOMATION_PAUSED'); assert.equal(f.writes, 1);
});

test('first scene payload is decoded through the real codec without a redundant AllCells read', async () => {
  const f = fixture();
  f.initial = codec.encode('SceneData', { homestead_cells: { grid_width: 10, grid_height: 10, facilities: [] } });
  const result = await f.service.getState();
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.data.facilities.length, 0);
  assert.deepEqual(f.calls, ['GetBag']);
  assert.equal(f.writes, 0);
});
test('malformed first scene data identifies its decoding stage without exposing wire contents', async () => {
  const f = fixture(); f.initial = Buffer.from([0x12, 0x7F]);
  const result = await f.service.getState();
  assert.equal(result.code, 'RANCH_READ_FAILED');
  assert.equal(result.failureStage, 'scene_data');
  assert.equal(result.failureKind, 'decode');
  assert.equal(result.error, '牧场场景数据失败，请稍后重试');
  assert.equal(JSON.stringify(result).includes('out of range'), false);
  assert.equal(f.calls.length, 0); assert.equal(f.writes, 0);
});

test('quote lifetime reports elapsed time after restoration and expires at the boundary without sending an operation', async () => {
  const f = fixture(); f.restoreDelayMs = 12500;
  const { data: quote } = await f.service.prepare('buy', { shopId: '5', goodsId: '10002', count: 1 });
  assert.equal(quote.validForMs, 47500);
  f.advance(quote.validForMs);
  assert.equal((await f.service.execute(quote.id)).code, 'RANCH_QUOTE_EXPIRED');
  assert.equal(f.writes, 0);

  f.restoreDelayMs = 0;
  const fresh = await quoteBuy(f);
  f.onRead = method => { if (method === 'GetBag') f.advance(60000); };
  assert.equal((await f.service.execute(fresh)).code, 'RANCH_QUOTE_EXPIRED');
  assert.equal(f.writes, 0, 'expiry during the fresh pre-write read is enforced');
});

test('an evicted confirmation cannot reissue a prior purchase', async () => {
  const f = fixture();
  const initial = await quoteBuy(f);
  assert.equal((await f.service.execute(initial)).data.outcome, 'confirmed');
  for (let i = 0; i < 21; i++) await quoteBuy(f);
  const replay = await f.service.execute(initial);
  assert.equal(replay.data.outcome, 'confirmed'); assert.equal(replay.data.replayed, true);
  assert.equal(f.writes, 1);
});

test('a game clock correction cannot expire or extend a live confirmation', async () => {
  const f = fixture();
  const valid = await quoteBuy(f); f.correctGameClock(3600000);
  assert.equal((await f.service.execute(valid)).data.outcome, 'confirmed');
  const expired = await quoteBuy(f); f.correctGameClock(-3600000); f.advance(60001);
  assert.equal((await f.service.execute(expired)).code, 'RANCH_QUOTE_EXPIRED');
  assert.equal(f.writes, 1);
});

test('expiry during encoding refunds the durable automation reservation without dispatching', async t => {
  const f = fixture();
  const saved = await f.service.setAutomation({ ...require('../src/services/ranch-policy').DEFAULT_POLICY,
    enabled: true, buyEnabled: true, goodsId: '10002', currencyDailyLimit: 20 });
  const prepared = await f.service.prepare('buy', { shopId: '5', goodsId: '10002', count: 1 }, saved.data.revision);
  const original = codec.encode;
  t.mock.method(codec, 'encode', (name, payload) => {
    const bytes = original(name, payload);
    if (name === codec.ROUTES.buy.request) f.advance(60001);
    return bytes;
  });
  assert.equal((await f.service.execute(prepared.data.id)).code, 'RANCH_QUOTE_EXPIRED');
  assert.equal(f.writes, 0);
  assert.equal((await f.service.getAutomation()).data.usage['buy:1007'], '0');
  assert.equal((await f.service.execute(prepared.data.id)).data.outcome, 'not_sent');
});

test('facility upgrade checks the live price twice, then starts and completes as two distinct confirmations', async () => {
  const f = fixture(true);
  const target = { facilityId: '11' };
  const quote = await f.service.prepare('upgrade', target);
  assert.equal(quote.ok, true, quote.error); assert.equal(quote.data.costItems[0].count, '14000');
  assert.equal(f.writes, 0); assert.equal(f.calls.filter(x => x === 'GetFacilityDetail').length, 1);
  f.upgradeCost = 14001;
  assert.equal((await f.service.execute(quote.data.id)).code, 'RANCH_STATE_CHANGED'); assert.equal(f.writes, 0);
  const fresh = await f.service.prepare('upgrade', target);
  assert.equal(fresh.data.costItems[0].count, '14001');
  const started = await f.service.execute(fresh.data.id);
  assert.equal(started.data.outcome, 'confirmed', started.data.message);
  assert.match(started.data.message, /已开始升级/);
  const nest = started.data.snapshot.facilities.find(x => x.id === '11');
  assert.equal(nest.level, 1); assert.equal(nest.upgrade.status, 'in_progress');
  assert.equal(nest.upgrade.canComplete, false);
  assert.equal((await f.service.prepare('completeUpgrade', target)).ok, false); assert.equal(f.writes, 1);
  f.advance(10000);
  const complete = await f.service.prepare('completeUpgrade', target); assert.equal(complete.ok, true, complete.error);
  assert.equal(complete.data.costItems.length, 0); assert.equal(f.writes, 1);
  const done = await f.service.execute(complete.data.id); assert.equal(done.data.outcome, 'confirmed', done.data.message);
  assert.equal(done.data.snapshot.facilities.find(x => x.id === '11').level, 2);
  assert.equal((await f.service.execute(complete.data.id)).data.replayed, true); assert.equal(f.writes, 2);
});
test('invalid upgrade instance never requests its detail and a mismatched start receipt is held', async () => {
  const f = fixture(true);
  assert.equal((await f.service.prepare('upgrade', { facilityId: '99' })).ok, false);
  assert.equal(f.calls.includes('GetFacilityDetail'), false);
  const q = await f.service.prepare('upgrade', { facilityId: '11' }); assert.equal(q.ok, true, q.error);
  f.mutateReply = reply => ({ ...reply, upgrade: { ...reply.upgrade, target_level: 9 } });
  const result = await f.service.execute(q.data.id);
  assert.equal(result.data.outcome, 'unknown'); assert.equal(f.writes, 1);
  assert.equal((await f.service.execute(q.data.id)).data.replayed, true); assert.equal(f.writes, 1);
});

const stockPolicy = { enabled: true, harvest: false, produce: false, clean: false, tasks: false,
  stockCoop: true, buyMissingCubs: true, cubDailyLimit: 10, currencyDailyLimit: 100, intervalMinutes: 2 };
const chick = { id: '10002', item_id: '60001', item_count: '1', price: '10', unlocked: true };
const duck = { ...chick, id: '10003', item_id: '60002', conds: [{ type: 3, param: '12' }] };
const sheep = { ...chick, id: '10008', item_id: '70001' };
const stockRoom = (id, type, capacity) => ({ instance_id: id, facility_id: type === 1 ? 6001001 : 6002001,
  module_type: 5 + type, state: 1, level: 1, capacity, ranch: { ranch_inst_id: id, capacity, animal_count: 0, husbandry_type: type, animals: [] } });

async function startStock(f, overrides = {}) {
  const saved = await f.service.setAutomation({ ...stockPolicy, ...overrides });
  assert.equal(saved.ok, true, saved.error);
  f.advance(30000);
}
async function stockRound(f) {
  const result = await f.service.automate();
  assert.equal(result.ok, true, result.error);
  if (!result.data.skipped) assert.equal(result.data.outcome, 'confirmed', result.data.message);
  f.advance(120000);
  return result.data;
}

test('stock scheduler places matching unlocked inventory, then buys the highest live tier and stops at capacity', async () => {
  const f = fixture();
  f.cubs.set('60001', 1);
  f.lockedCubs.push({ id: '60001', count: '8', is_locked: true });
  const goods = [
    { ...chick, conds: [{ type: 3, param: '2' }] },
    { ...duck, item_count: '2', limit_count: '4', bought_num: '3' },
    { ...duck, id: '10004', item_id: '60003', conds: [{ type: 3, param: '8' }] },
    { ...duck, id: '10005', item_id: '60004', unlocked: false, conds: [{ type: 3, param: '18' }] },
    sheep,
  ];
  f.goods = () => goods;
  await startStock(f);

  const placed = await stockRound(f);
  assert.equal(placed.action, 'place');
  assert.equal(placed.completed, 1);
  assert.equal(f.calls.includes('ShopInfo'), false, 'stock placement works independently of the shop');
  const purchased = await stockRound(f);
  assert.equal(purchased.action, 'buy');
  assert.equal(purchased.completed, 1);
  assert.deepEqual(purchased.rewards.map(item => [item.id, item.count]), [['60002', '2']]);
  assert.deepEqual(purchased.costs.map(item => [item.id, item.count]), [['1007', '10']]);
  const rest = await stockRound(f);
  assert.equal(rest.action, 'place');
  assert.equal(rest.completed, 2);
  assert.equal((await stockRound(f)).skipped, true);
  assert.equal((await stockRound(f)).skipped, true);
  assert.equal(f.writes, 3);
});

test('stock scheduler shares daily and reserve limits and buys only whole packs within the net shortage', async () => {
  for (const [overrides, expected] of [
    [{ currencyDailyLimit: 25 }, 2],
    [{ currencyReserve: 79 }, 2],
    [{ cubDailyLimit: 3 }, 1],
    [{ cubReserve: 4, currencyDailyLimit: 20 }, 0],
  ]) {
    const f = fixture();
    f.facilities[0] = stockRoom('11', 1, 7);
    const pack = { ...duck, item_count: '2' };
    f.goods = () => [pack];
    await startStock(f, overrides);
    const result = await stockRound(f);
    assert.equal(result.completed ?? 0, expected, JSON.stringify(overrides));
    if (expected) assert.equal(Number(result.rewards[0].count), expected * 2);
  }

  const f = fixture();
  f.facilities[0] = stockRoom('11', 1, 10);
  const pack = { ...duck, item_count: '2', limit_count: '5', bought_num: '4' };
  f.goods = () => [pack];
  await startStock(f);
  assert.equal((await stockRound(f)).completed, 1);
  assert.equal((await stockRound(f)).completed, 2);
  assert.equal((await stockRound(f)).skipped, true, 'shop limit stops further buy approvals');
  assert.equal(f.writes, 2);
});

test('an unavailable coop slot does not displace the shed turn, and either type can be enabled alone', async () => {
  for (const [coop, shed] of [[true, true], [true, false], [false, true]]) {
    const f = fixture();
    f.facilities[0] = { ...stockRoom('11', 1, 3), state: 2 };
    f.facilities.push(stockRoom('12', 2, 3));
    f.cubs.set('60001', 3);
    f.cubs.set('70001', 1);
    f.goods = () => [chick, sheep];
    await startStock(f, { stockCoop: coop, stockShed: shed });
    if (coop) assert.equal((await stockRound(f)).skipped, true);
    const result = await stockRound(f);
    if (!shed) assert.equal(result.skipped, true);
    else {
      assert.equal(result.action, 'place');
      assert.equal(f.facilities[2].ranch.animal_count, 1);
      if (coop) assert.equal((await stockRound(f)).skipped, true);
      const purchase = await stockRound(f);
      assert.equal(purchase.action, 'buy');
      assert.deepEqual(purchase.rewards.map(item => [item.id, item.count]), [['70001', '2']]);
    }
    assert.equal(f.cubs.get('60001'), 3);
  }
});

test('stock scheduler ignores unknown occupancy and missing compatible offers', async () => {
  for (const failure of ['missing ranch', 'missing occupants', 'upgrade', 'no compatible goods', 'duplicate offer']) {
    const f = fixture();
    if (failure === 'missing ranch') delete f.facilities[0].ranch;
    if (failure === 'missing occupants') f.facilities[0].ranch.animals = [];
    if (failure === 'upgrade') f.facilities[0].upgrade_state = 1;
    if (failure === 'no compatible goods') f.goods = () => [sheep];
    if (failure === 'duplicate offer') f.goods = () => [chick, { ...chick, price: '1' }];
    await startStock(f);
    assert.equal((await stockRound(f)).skipped, true, failure);
    assert.equal(f.writes, 0, failure);
  }
});

test('both prepare and execute check fresh stocking requirements before any dispatch', async () => {
  for (const changeAt of [2, 3]) {
    for (const change of ['new stock', 'filled room', 'best offer changes', 'currency reserve changes']) {
      const f = fixture();
      let reads = 0;
      let goods = [chick];
      f.goods = () => goods;
      f.onRead = method => {
        if (method === 'AllCells' && change === 'filled room' && reads + 1 === changeAt)
          f.facilities[0].ranch.capacity = 1;
        if (method !== 'GetBag' || ++reads !== changeAt) return;
        if (change === 'new stock') f.cubs.set('60002', 3);
        if (change === 'best offer changes') goods = [chick, duck];
        if (change === 'currency reserve changes') f.gold(34);
      };
      await startStock(f, change === 'currency reserve changes' ? { currencyReserve: 5 } : { stockBudgetMode: 'live', cubDailyLimit: 0, currencyDailyLimit: 0 });
      const result = await f.service.automate();
      assert.equal(result.code, 'RANCH_AUTOMATION_PAUSED', `${change} during read ${changeAt}: ${JSON.stringify(result)}`);
      assert.equal(f.writes, 0);
      assert.deepEqual((await f.service.getAutomation()).data.usage, {});
    }
  }
});

test('an unknown automatic purchase blocks all subsequent stock writes after service replacement', async () => {
  const f = fixture();
  f.facilities.push(stockRoom('12', 2, 3));
  f.goods = () => [chick, sheep];
  await startStock(f, { stockShed: true, stockBudgetMode: 'live', cubDailyLimit: 0, currencyDailyLimit: 0 });
  f.timeout();
  const timedOut = await f.service.automate();
  assert.equal(timedOut.data.outcome, 'unknown');
  assert.equal(f.writes, 1);
  const calls = [...f.calls];
  f.advance(86400000);
  assert.equal((await f.make().automate()).data.skipped, true);
  assert.deepEqual(f.calls, calls);
});

test('saved fixed cub purchases are bounded by compatible net vacancy and do not opt in to stock placement', async () => {
  const f = fixture();
  f.cubs.set('60002', 2);
  f.facilities.push(stockRoom('12', 2, 3));
  await startStock(f, { stockCoop: false, buyEnabled: true, goodsId: '10002', purchaseCount: 5 });
  const data = JSON.parse(fs.readFileSync(f.file, 'utf8'));
  delete data.automation.policy.stockCoop;
  delete data.automation.policy.stockShed;
  delete data.automation.policy.buyMissingCubs;
  fs.writeFileSync(f.file, JSON.stringify(data));
  const purchase = await stockRound(f);
  assert.equal(purchase.action, 'buy');
  assert.equal(purchase.completed, 1);
  assert.equal((await stockRound(f)).skipped, true);
  assert.equal(f.writes, 1);
  assert.equal((await f.service.getAutomation()).data.policy.stockShed, false);
});

test('an explicitly authorized non-cub purchase keeps its order quantity with full facilities', async () => {
  const f = fixture();
  f.facilities[0] = stockRoom('11', 1, 1);
  f.goods = () => [{ ...chick, id: '10001', item_id: '7001' }];
  await startStock(f, { stockCoop: false, buyEnabled: true, shopId: '6', goodsId: '10001', purchaseCount: 2 });
  const result = await stockRound(f);
  assert.equal(result.action, 'buy');
  assert.equal(result.completed, 2);
  assert.deepEqual(result.rewards.map(item => [item.id, item.count]), [['7001', '2']]);
});

test('confirmed purchases exhaust the shared spend allowance before another stock purchase', async () => {
  const f = fixture();
  f.facilities[0] = stockRoom('11', 1, 5);
  f.facilities.push(stockRoom('12', 2, 5));
  f.goods = () => [chick, sheep];
  await startStock(f, { stockShed: true, currencyDailyLimit: 20 });
  assert.equal((await stockRound(f)).completed, 2);
  assert.equal((await stockRound(f)).skipped, true);
  assert.equal((await stockRound(f)).action, 'place');
  assert.equal((await stockRound(f)).skipped, true);
  assert.equal((await stockRound(f)).skipped, true);
  assert.deepEqual((await f.service.getAutomation()).data.usage, { 'buy:1007': '20', 'place:60001': '2' });
});

test('loss of automatic admission after reserving a stock order keeps the request unsent', async t => {
  const f = fixture();
  await startStock(f, { stockBudgetMode: 'live', cubDailyLimit: 0, currencyDailyLimit: 0 });
  const original = codec.encode;
  t.mock.method(codec, 'encode', (name, payload) => {
    const bytes = original(name, payload);
    if (name === codec.ROUTES.buy.request) f.allow(false);
    return bytes;
  });
  const result = await f.service.automate();
  assert.equal(result.data.outcome, 'not_sent');
  assert.equal(f.writes, 0);
  assert.equal(f.calls.includes('BuyGoods'), false);
  assert.equal((await f.service.getAutomation()).data.usage['buy:1007'], '0');
});

test('coop and shed can place only existing cubs with a zero purchase budget, then resume after inventory arrives', async () => {
  const f = fixture();
  f.facilities.push(stockRoom('12', 2, 3));
  f.cubs.set('60001', 1);
  await startStock(f, { stockShed: true, buyMissingCubs: false, stockBudgetMode: 'live', cubDailyLimit: 0, currencyDailyLimit: 0 });
  assert.equal((await stockRound(f)).action, 'place');
  assert.equal((await stockRound(f)).skipped, true);
  f.cubs.set('70001', 1);
  assert.equal((await stockRound(f)).skipped, true);
  assert.equal((await stockRound(f)).action, 'place');
  assert.equal(f.facilities[2].ranch.animal_count, 1);
  assert.equal(f.calls.includes('ShopInfo'), false);
  assert.equal(f.calls.includes('BuyGoods'), false);
});

test('live stock mode buys only what current vacancies, available tickets and shop limits allow', async () => {
  for (const { vacancies, tickets, remaining, count } of [
    { vacancies: 3, tickets: 20, remaining: 5, count: 1 },
    { vacancies: 8, tickets: 25, remaining: 5, count: 2 },
    { vacancies: 8, tickets: 80, remaining: 1, count: 1 },
    { vacancies: 8, tickets: 9, remaining: 5, count: 0 },
  ]) {
    const f = fixture();
    f.facilities[0] = stockRoom('11', 1, vacancies);
    f.gold(tickets);
    const pack = { ...duck, item_count: '2', limit_count: '5', bought_num: String(5 - remaining) };
    f.goods = () => [pack];
    await startStock(f, { stockBudgetMode: 'live', cubDailyLimit: 0, currencyDailyLimit: 0 });
    const result = await stockRound(f);
    assert.equal(result.completed ?? 0, count);
    if (count) {
      assert.equal(result.action, 'buy');
      assert.deepEqual(result.costs.map(item => [item.id, item.count]), [['1007', String(count * 10)]]);
      assert.equal((await stockRound(f)).completed, count * 2);
    }
    assert.equal((await stockRound(f)).skipped, true);
  }
});

test('live stock buys the highest affordable unlocked tier with verified shop level conditions', async () => {
  const f = fixture();
  f.gold(1100);
  f.goods = () => [
    { ...chick, price: '2', conds: [{ type: 3, param: '1' }] },
    { ...duck, price: '1080', conds: [{ type: 3, param: '3' }] },
    { ...duck, id: '10004', item_id: '60003', price: '2712', conds: [{ type: 3, param: '9' }] },
  ];
  await startStock(f, { stockBudgetMode: 'live', cubDailyLimit: 0, currencyDailyLimit: 0 });
  const result = await stockRound(f);
  assert.equal(result.action, 'buy');
  assert.equal(result.completed, 1);
  assert.deepEqual(result.rewards.map(item => [item.id, item.count]), [['60002', '1']]);
  assert.equal(result.costs[0].count, '1080');
});

test('a persisted stocking policy without a mode reloads as manual and keeps its previous budget', async () => {
  const f = fixture();
  f.facilities[0] = stockRoom('11', 1, 5);
  await startStock(f, { cubDailyLimit: 3, currencyDailyLimit: 10 });
  const data = JSON.parse(fs.readFileSync(f.file, 'utf8'));
  delete data.automation.policy.stockBudgetMode;
  fs.writeFileSync(f.file, JSON.stringify(data));
  f.service = f.make();
  const policy = (await f.service.getAutomation()).data.policy;
  assert.equal(policy.stockBudgetMode, 'manual');
  assert.equal(policy.cubDailyLimit, 3);
  assert.equal(policy.currencyDailyLimit, 10);
  assert.equal((await stockRound(f)).completed, 1);
  assert.equal((await stockRound(f)).action, 'place');
  assert.equal((await stockRound(f)).skipped, true);
});

test('selecting live stock preserves manual quota semantics for existing fixed actions', async () => {
  const f = fixture();
  f.facilities[0] = stockRoom('11', 1, 4);
  const food = { ...chick, id: '10001', item_id: '7001' };
  f.goods = () => [food, chick];
  await startStock(f, { stockBudgetMode: 'live', cubDailyLimit: 0, currencyDailyLimit: 10, buyEnabled: true,
    shopId: '6', goodsId: food.id, purchaseCount: 2 });
  assert.equal((await stockRound(f)).skipped, true, 'fixed purchase retains its manual quota');
  assert.equal((await stockRound(f)).completed, 4, 'stock purchase is capped by live vacancy');
  assert.equal((await f.service.getAutomation()).data.usage['buy:1007'], '40');
});

test('inventory-only stock owns the coop, including when two same-type fixed rules are retained with no quotas', async () => {
  const f = fixture();
  f.cubs.set('60002', 1);
  const policy = { ...stockPolicy, stockBudgetMode: 'live', buyMissingCubs: false, cubDailyLimit: 0, currencyDailyLimit: 0,
    placeEnabled: true, ranchId: '11', cubId: '60001', buyEnabled: true, goodsId: '10002' };
  const saved = await f.service.setAutomation(policy);
  assert.equal(saved.ok, true, saved.error);
  assert.equal(saved.data.targetTypes.cubs['60002'], 1);
  assert.equal(saved.data.targetTypes.goods['10008'], 2);
  assert.equal(saved.data.targetTypes.goods['10001'], undefined);
  assert.deepEqual((await f.service.getAutomation()).data.targetTypes, saved.data.targetTypes);
  for (const [name, value] of Object.entries(policy)) assert.equal(saved.data.policy[name], value, name);
  f.advance(30000);
  const buy = { shopId: '5', goodsId: '10002', count: 1 };
  const place = { ranchId: '11', itemId: '60001', count: 1 };
  assert.equal((await f.service.prepare('buy', buy, saved.data.revision)).code, 'RANCH_AUTOMATION_PAUSED');
  assert.equal((await f.service.prepare('place', place, saved.data.revision)).code, 'RANCH_AUTOMATION_PAUSED');
  assert.deepEqual(f.calls, []);
  assert.equal((await stockRound(f)).action, 'place');
  assert.equal((await stockRound(f)).skipped, true);
  assert.equal((await stockRound(f)).skipped, true);
  assert.equal(f.calls.includes('ShopInfo'), false);

  const parked = await f.service.setAutomation({ ...policy, stockCoop: false });
  assert.equal(parked.ok, true, parked.error);
  assert.equal(parked.data.policy.placeEnabled, true);
  assert.equal(parked.data.policy.buyEnabled, true);
  f.service = f.make();
  f.advance(30000);
  f.calls.length = 0;
  assert.equal((await stockRound(f)).skipped, true);
  assert.deepEqual(f.calls, []);
  assert.equal(f.writes, 1);
});

test('turning off coop ownership restores valid fixed purchase and placement without reselecting their targets', async () => {
  const f = fixture();
  f.facilities[0] = stockRoom('11', 1, 3);
  const policy = { ...stockPolicy, stockBudgetMode: 'live', buyMissingCubs: false,
    placeEnabled: true, cubId: '60001', ranchId: '11', buyEnabled: true, goodsId: '10002' };
  await startStock(f, policy);
  assert.equal((await stockRound(f)).skipped, true);
  assert.equal(f.calls.includes('ShopInfo'), false);

  const restored = await f.service.setAutomation({ ...policy, stockCoop: false });
  assert.equal(restored.ok, true, restored.error);
  f.advance(30000);
  assert.equal((await stockRound(f)).skipped, true, 'fixed placement waits for inventory');
  assert.equal((await stockRound(f)).action, 'buy');
  assert.equal((await stockRound(f)).action, 'place');
  assert.equal(f.facilities[0].ranch.animal_count, 1);
});

test('coop ownership leaves fixed shed rules and purchases of feed eligible', async () => {
  const f = fixture();
  f.facilities.push(stockRoom('12', 2, 4));
  f.cubs.set('70001', 1);
  f.goods = () => [sheep];
  const policy = { ...stockPolicy, stockBudgetMode: 'live', buyMissingCubs: false,
    placeEnabled: true, cubId: '70001', ranchId: '12', buyEnabled: true, goodsId: '10008', purchaseCount: 2 };
  await startStock(f, policy);
  assert.equal((await stockRound(f)).action, 'place');
  const shedPurchase = await stockRound(f);
  assert.equal(shedPurchase.action, 'buy');
  assert.equal(shedPurchase.rewards[0].id, '70001');
  const food = { ...chick, id: '10001', item_id: '7001' };
  f.goods = () => [food];
  const saved = await f.service.setAutomation({ ...policy, placeEnabled: false, shopId: '6', goodsId: food.id });
  assert.equal(saved.ok, true, saved.error);
  f.advance(120000);
  let purchase = await stockRound(f);
  if (purchase.skipped) purchase = await stockRound(f);
  assert.equal(purchase.action, 'buy');
  assert.equal(purchase.rewards[0].id, '7001');
});

test('claiming a type during a fixed action preflight prevents dispatch without affecting a one-off manual quote', async () => {
  for (const action of ['buy', 'place']) {
    for (const phase of ['prepare', 'execute']) {
      const f = fixture();
      f.cubs.set('60001', 1);
      const policy = { ...stockPolicy, stockCoop: false, stockBudgetMode: 'live', buyMissingCubs: false,
        placeEnabled: true, cubId: '60001', ranchId: '11', buyEnabled: true, goodsId: '10002' };
      const saved = await f.service.setAutomation(policy);
      const input = action === 'buy' ? { shopId: '5', goodsId: '10002', count: 1 } : { ranchId: '11', itemId: '60001', count: 1 };
      const prepare = () => f.service.prepare(action, input, saved.data.revision);
      const pending = phase === 'execute' ? await prepare() : null;
      if (pending) assert.equal(pending.ok, true, pending.error);
      f.onRead = async method => {
        if (method !== (action === 'buy' ? 'ShopInfo' : 'GetBag')) return;
        f.onRead = null;
        const edited = await f.service.setAutomation({ ...policy, stockCoop: true });
        assert.equal(edited.ok, true, edited.error);
      };
      const blocked = pending ? await f.service.execute(pending.data.id) : await prepare();
      assert.equal(blocked.code, 'RANCH_AUTOMATION_PAUSED');
      assert.equal(f.writes, 0);
      const manual = await f.service.prepare(action, input);
      assert.equal(manual.ok, true, manual.error);
      assert.equal((await f.service.execute(manual.data.id)).data.outcome, 'confirmed');
      assert.equal(f.writes, 1);
    }
  }
});

test('stock places the highest confirmed tier across stacks, selecting the room that fits the most per operation', async () => {
  const f = fixture();
  f.facilities[0] = stockRoom('11', 1, 1);
  f.facilities.push(stockRoom('13', 1, 4));
  f.cubs.set('60002', 5);
  f.cubs.set('60001', 3);
  f.goods = () => [
    { ...duck, conds: [{ type: 3, param: '2' }] },
    { ...chick, conds: [{ type: 3, param: '4' }] },
  ];
  await startStock(f, { stockBudgetMode: 'live', buyMissingCubs: false });
  const placed = await stockRound(f);
  assert.equal(placed.action, 'place');
  assert.equal(placed.completed, 3);
  assert.equal(placed.costs[0].id, '60001');
  assert.equal(f.facilities[0].ranch.animal_count, 0);
  assert.equal(f.facilities[2].ranch.animal_count, 3);
  assert.equal(f.calls.filter(call => call === 'ShopInfo').length, 3, 'discovery and both checks use fresh shop tier data');
  assert.deepEqual(f.leases, [7, 7, 10], 'scene limits cover shop reads in all three stages');
  f.calls.length = 0;
  assert.equal((await stockRound(f)).costs[0].id, '60002');
  assert.equal(f.calls.includes('ShopInfo'), false, 'one inventory type needs no shop lookup');
});

test('stock rechecks changing inventory tiers before placement without sending the earlier candidate', async () => {
  const f = fixture();
  f.cubs.set('60002', 2);
  f.cubs.set('60001', 2);
  let reads = 0;
  f.goods = () => {
    reads++;
    return [
      { ...duck, conds: [{ type: 3, param: reads < 3 ? '2' : '5' }] },
      { ...chick, conds: [{ type: 3, param: '4' }] },
    ];
  };
  await startStock(f, { stockBudgetMode: 'live', buyMissingCubs: false });
  const rejected = await f.service.automate();
  assert.equal(rejected.code, 'RANCH_AUTOMATION_PAUSED');
  assert.equal(reads, 3);
  assert.equal(f.calls.includes('PlaceAnimal'), false);
});

test('a manual cub preview reserves its type until confirmation or expiry, while other facilities may restock', async () => {
  for (const settle of ['confirm', 'expire']) {
    const f = fixture();
    f.cubs.set('60001', 2);
    await startStock(f, { stockBudgetMode: 'live', buyMissingCubs: false });
    const manual = await f.service.prepare('place', { ranchId: '11', itemId: '60001', count: 1 });
    assert.equal(manual.ok, true);
    f.calls.length = 0;
    assert.equal((await f.service.automate()).data.skipped, true);
    assert.deepEqual(f.calls, [], 'no scene read or competing write while the owner reviews the same type');
    if (settle === 'confirm') assert.equal((await f.service.execute(manual.data.id)).data.completed, 1);
    else f.advance(manual.data.validForMs + 1);
    assert.equal((await f.service.automate()).data.completed, settle === 'confirm' ? 1 : 2);
  }

  const f = fixture();
  f.facilities.push(stockRoom('12', 2, 2));
  f.cubs.set('70001', 1);
  await startStock(f, { stockCoop: true, stockShed: true, stockBudgetMode: 'live' });
  const manual = await f.service.prepare('buy', { shopId: '5', goodsId: '10002', count: 1 });
  assert.equal(manual.ok, true);
  const result = await f.service.automate();
  assert.equal(result.data.action, 'place');
  assert.equal(result.data.costs[0].id, '70001');
  assert.equal(f.calls.includes('BuyGoods'), false);
});

function ranchLogs(t) {
  const records = [];
  const { setLogHook } = require('../src/utils/utils');
  setLogHook((tag, message, isWarn, meta) => records.push({ tag, message, isWarn, meta }));
  t.after(() => setLogHook(null));
  return records;
}

test('automation logs confirmed purchases with true receipt data and skips manual, replayed, and timer-only work', async t => {
  const records = ranchLogs(t);
  const f = fixture();
  await startStock(f, { stockBudgetMode: 'live', cubDailyLimit: 0, currencyDailyLimit: 0 });
  assert.equal(records.length, 0);
  const result = await f.service.automate();
  assert.equal(result.data.outcome, 'confirmed');
  const [entry] = records;
  assert.equal(records.length, 1);
  assert.equal(entry.tag, '牧场');
  assert.equal(entry.isWarn, false);
  assert.equal(entry.meta.automationCategory, 'ranch');
  assert.equal(entry.meta.event, 'ranch_automation_action');
  assert.equal(entry.meta.action, 'buy');
  assert.equal(entry.meta.completed, 3);
  assert.equal(entry.meta.result, 'confirmed');
  assert.deepEqual(entry.meta.costs, [{ name: '金券', count: '30' }]);
  assert.deepEqual(entry.meta.rewards, [{ name: '鸡幼崽', count: '3' }]);
  assert.match(entry.message, /自动购买.*鸡幼崽.*3\/3.*金券×30.*鸡幼崽×3/);
  assert.equal((await f.service.execute(result.data.id)).data.replayed, true);
  for (let tick = 0; tick < 3; tick++) {
    f.advance(30000);
    assert.equal((await f.service.automate()).data.skipped, true);
  }
  const manual = await f.service.prepare('buy', { shopId: '5', goodsId: '10002', count: 1 });
  assert.equal((await f.service.execute(manual.data.id)).data.outcome, 'confirmed');
  assert.equal(records.length, 1);
});

test('automation logs true confirmed partial amounts and clearly pauses, without another action entry on repeated ticks', async t => {
  const records = ranchLogs(t);
  const f = fixture();
  f.facilities[0].ranch.animals.push({ ranch_inst_id: '11', animal_inst_id: 8, animal_id: '60001', can_harvest: true });
  f.mutateReply = reply => ({ ...reply, op_results: reply.op_results.map(item => ({ ...item,
    rewards: [{ id: '2060001', count: '2' }], costs: [{ id: '7001', count: '1' }] })) });
  await startStock(f, { stockCoop: false, harvest: true });
  const result = await f.service.automate();
  assert.equal(result.data.outcome, 'partial');
  assert.equal(records.length, 1);
  assert.equal(records[0].meta.result, 'partial');
  assert.equal(records[0].meta.completed, 1);
  assert.equal(records[0].meta.requested, 2);
  assert.deepEqual(records[0].meta.rewards.map(item => item.count), ['2']);
  assert.deepEqual(records[0].meta.costs, [{ name: '牧草', count: '1' }]);
  assert.match(records[0].message, /部分确认.*已暂停.*人工核对/);
  f.advance(120000);
  assert.equal((await f.service.automate()).data.skipped, true);
  assert.equal(records.length, 1);
});

test('automation distinguishes unknown, proven unsent, and preflight error without leaking upstream diagnostics', async t => {
  const records = ranchLogs(t);
  for (const outcome of ['unknown', 'not_sent', 'error']) {
    const f = fixture();
    await startStock(f, { stockBudgetMode: 'live' });
    if (outcome === 'unknown') f.timeout();
    else if (outcome === 'not_sent') f.rejectUnsent = true;
    else {
      let reads = 0;
      f.onRead = method => {
        if (method === 'ShopInfo' && ++reads === 2) throw new Error('internal fixture upstream detail');
      };
    }
    const result = await f.service.automate();
    const entry = records.at(-1);
    if (outcome === 'error') assert.equal(result.ok, false);
    else assert.equal(result.data.outcome, outcome);
    assert.equal(entry.meta.event, 'ranch_automation_action');
    assert.equal(entry.meta.result, outcome);
    assert.equal(entry.meta.action, 'buy');
    assert.equal(entry.meta.completed, 0);
    assert.deepEqual(entry.meta.costs, []);
    assert.deepEqual(entry.meta.rewards, []);
    assert.equal(entry.isWarn, true);
    if (outcome === 'unknown') {
      assert.match(entry.message, /结果未知.*已暂停.*人工核对/);
      f.advance(86400000);
      assert.equal((await f.make().automate()).data.skipped, true);
      assert.equal(records.length, 1);
    }
  }
  assert.equal(records.length, 3);
  assert.ok(!JSON.stringify(records).includes('internal fixture upstream detail'));
});

test('enabled due rounds report concrete stop reasons only when the reason changes', async t => {
  const records = ranchLogs(t);
  const f = fixture();
  f.facilities[0] = stockRoom('11', 1, 3);
  f.gold(0);
  await startStock(f, { stockBudgetMode: 'live' });
  assert.equal((await stockRound(f)).skipped, true);
  assert.equal((await stockRound(f)).skipped, true);
  assert.deepEqual(records.map(row => row.meta.reason), ['insufficient_balance']);
  f.service = f.make();
  assert.equal((await stockRound(f)).skipped, true);
  assert.deepEqual(records.map(row => row.meta.reason), ['insufficient_balance']);
  f.gold(100);
  f.goods = () => [{ ...chick, limit_count: '1', bought_num: '1' }];
  assert.equal((await stockRound(f)).skipped, true);
  assert.equal((await stockRound(f)).skipped, true);
  f.goods = () => [];
  assert.equal((await stockRound(f)).skipped, true);
  f.cubs.set('60001', 3);
  assert.equal((await stockRound(f)).action, 'place');
  assert.equal(records.at(-1).meta.action, 'place');
  for (const part of ['自动放养', '窝', '鸡幼崽', '3/3']) assert.ok(records.at(-1).message.includes(part));
  assert.equal((await stockRound(f)).skipped, true);
  assert.equal((await stockRound(f)).skipped, true);
  assert.deepEqual(records.filter(row => row.meta.event === 'ranch_automation_status').map(row => row.meta.reason),
    ['insufficient_balance', 'shop_limit', 'no_product', 'full']);
  const saved = await f.service.setAutomation({ ...stockPolicy, enabled: false });
  assert.equal(saved.ok, true, saved.error);
  const previous = records.length;
  assert.equal((await stockRound(f)).skipped, true);
  assert.equal(records.length, previous);
});

function cancelViaRoute(f) {
  const { createActivityReadCache } = require('../src/controllers/activity-read-cache');
  const { registerAdminRanchRoutes } = require('../src/controllers/admin-ranch-routes');
  const routes = new Map();
  const id = 'account-a';
  registerAdminRanchRoutes({
    app: { get() {}, post: (route, handler) => routes.set(route, handler) },
    getAccountIdFromRequest: () => id, canAccessAccount: () => true,
    provider: {
      isAccountRunning: () => true,
      getStatus: () => ({ connection: { connected: false } }),
      getGamePanelReadScope: () => JSON.stringify([id, 'binding', 1, 'host', 1, 1, 1]),
      cancelRanchAction: (account, quote) => {
        assert.equal(account, id);
        return f.service.cancel(quote);
      },
    },
    activityReader: createActivityReadCache(),
    sendProviderError: (_res, error) => { throw error; },
  });
  return async quoteId => {
    const res = { code: 200, status(code) { this.code = code; return this; }, json(body) { this.body = body; } };
    await routes.get('/api/ranch/cancel')({ body: { quoteId } }, res);
    return { code: res.code, body: res.body };
  };
}

test('cancel over the offline worker route returns the reserved type to an already-due stock round', async () => {
  const f = fixture();
  f.cubs.set('60001', 2);
  await startStock(f, { stockBudgetMode: 'live', buyMissingCubs: false });
  const quote = await f.service.prepare('place', { ranchId: '11', itemId: '60001', count: 1 });
  assert.equal(quote.ok, true);
  assert.equal((await f.service.automate()).data.skipped, true);
  assert.equal(f.writes, 0);
  const cancel = cancelViaRoute(f);
  const calls = f.calls.length;
  assert.deepEqual(await cancel(quote.data.id), { code: 200, body: { ok: true, data: { cancelled: true } } });
  assert.equal((await cancel(quote.data.id)).code, 409);
  assert.equal(f.calls.length, calls);
  assert.equal(f.writes, 0);
  const reopened = f.make();
  assert.equal((await reopened.execute(quote.data.id)).data.outcome, 'not_sent');
  assert.equal(f.writes, 0);
  const resumed = await f.service.automate();
  assert.equal(resumed.data.outcome, 'confirmed');
  assert.equal(resumed.data.costs[0].id, '60001');
  assert.equal(resumed.data.completed, 2);
  assert.equal(f.writes, 1);
});

test('cancel over the offline worker route wins before dispatch during an execute preflight', async () => {
  const f = fixture(); const id = await quoteBuy(f); const cancel = cancelViaRoute(f);
  let started, resume;
  const entered = new Promise(resolve => { started = resolve; });
  const paused = new Promise(resolve => { resume = resolve; });
  f.onRead = async method => { if (method === 'GetBag') { started(); await paused; } };
  const running = f.service.execute(id);
  await entered;
  try {
    assert.equal((await cancel(id)).code, 200);
    assert.equal(f.writes, 0);
  } finally { resume(); }
  assert.equal((await running).data.outcome, 'not_sent');
  assert.equal(f.writes, 0);
});

for (const outcome of ['unknown', 'confirmed']) {
  test(`cancel preserves a dispatched ${outcome} operation and its durable budget`, async () => {
    const f = fixture(); const cancel = cancelViaRoute(f);
    await startStock(f, { stockBudgetMode: 'live' });
    if (outcome === 'unknown') f.timeout();
    let inFlightCancel;
    f.beforeWrite(() => {
      const pending = JSON.parse(fs.readFileSync(f.file, 'utf8'));
      const usage = pending.automation.usage;
      assert.equal(pending.lastOperation.outcome, 'pending');
      assert.ok(BigInt(usage['buy:1007']) > 0n);
      inFlightCancel = cancel(pending.lastOperation.id);
    });
    const result = await f.service.automate();
    assert.equal(result.data.outcome, outcome);
    assert.equal((await inFlightCancel).code, 409);
    assert.equal(f.writes, 1);
    const before = fs.readFileSync(f.file, 'utf8');
    assert.ok(BigInt(JSON.parse(before).automation.usage['buy:1007']) > 0n);
    assert.equal((await cancel(result.data.id)).code, 409);
    assert.equal(fs.readFileSync(f.file, 'utf8'), before);
    assert.equal((await f.make().execute(result.data.id)).data.outcome, outcome);
    assert.equal(f.writes, 1);
  });
}

test('cancel preserves a partial operation and the existing spend ledger', async () => {
  const f = fixture();
  await startStock(f, { stockBudgetMode: 'live' });
  assert.equal((await f.service.automate()).data.outcome, 'confirmed');
  const room = f.facilities[0].ranch;
  room.animals.push({ ...room.animals[0], animal_inst_id: 8 });
  room.animal_count = 2;
  const quote = await f.service.prepare('produce', { all: true });
  assert.equal(quote.ok, true, quote.error);
  assert.equal(quote.data.count, 2);
  assert.equal((await f.service.execute(quote.data.id)).data.outcome, 'partial');
  const before = fs.readFileSync(f.file, 'utf8');
  assert.ok(BigInt(JSON.parse(before).automation.usage['buy:1007']) > 0n);
  assert.equal((await cancelViaRoute(f)(quote.data.id)).code, 409);
  assert.equal(fs.readFileSync(f.file, 'utf8'), before);
  assert.equal((await f.make().execute(quote.data.id)).data.outcome, 'partial');
  assert.equal(f.writes, 2);
});


const ranchProduct = (uid, count, price, flags = {}) => ({
  id: '1060001', uid, count, show: { sells: [{ id: '1007', count: price }] }, ...flags,
});

test('牧场批量出售跳过锁定、条件及非产物堆栈，按实际 UID 和报价确认一次', async () => {
  const f = fixture();
  const first = ranchProduct('9007199254741001', '3', '2');
  const second = ranchProduct('9007199254741002', '2', '4');
  f.products.push(first, second, ranchProduct('9007199254741003', '9', '8', { is_locked: true }),
    ranchProduct('9007199254741004', '6', '3', { show: { sells: [{ id: '1007', count: '5' }], sell_cond: [{ type: 'synthetic' }] } }),
    ranchProduct('9007199254741005', '4', '2', { id: '7001' }));
  const snapshot = await f.service.getState('animals');
  assert.deepEqual(snapshot.data.inventory.filter(row => row.canSell).map(row => row.uid), [first.uid, second.uid]);
  const quote = await f.service.prepare('sell', { all: true });
  assert.equal(quote.ok, true, quote.error);
  assert.deepEqual(quote.data.costItems.map(row => [row.id, row.count]), [['1060001', '5']]);
  assert.deepEqual(quote.data.expectedRewards.map(row => [row.id, row.count]), [['1007', '14']]);
  assert.equal(f.writes, 0);
  second.show.sells[0].count = '5';
  assert.equal((await f.service.execute(quote.data.id)).code, 'RANCH_STATE_CHANGED');
  assert.equal(f.writes, 0);
  second.show.sells[0].count = '4';
  const result = await f.service.execute(quote.data.id);
  assert.equal(result.data.outcome, 'confirmed', JSON.stringify({ message: result.data.message, writes: f.writes }));
  assert.deepEqual(result.data.rewards.map(row => [row.id, row.count]), [['1007', '14']]);
  assert.deepEqual(f.products.map(row => row.count), ['0', '0', '9', '6', '4']);
  assert.equal((await f.make().execute(quote.data.id)).data.replayed, true);
  assert.equal(f.writes, 1);
});

test('单批出售只提交确认数量，回执 UID 不匹配时保留未知并拒绝重发', async () => {
  const f = fixture();
  const item = ranchProduct('9007199254741001', '5', '3');
  f.products.push(item);
  const input = { uid: item.uid, itemId: item.id, count: 2 };
  const invalid = await f.service.prepare('sell', { ...input, itemId: '2060001' });
  assert.equal(invalid.code, 'RANCH_STATE_CHANGED');
  const quote = await f.service.prepare('sell', input);
  assert.equal(quote.ok, true, quote.error);
  assert.equal(quote.data.expectedRewards[0].count, '6');
  f.mutateReply = reply => ({ ...reply, sell_items: [{ ...reply.sell_items[0], uid: '9007199254741002' }] });
  const result = await f.service.execute(quote.data.id);
  assert.equal(result.data.outcome, 'unknown');
  assert.equal(item.count, '3');
  assert.equal((await f.make().execute(quote.data.id)).data.replayed, true);
  assert.equal((await f.make().prepare('sell', input)).code, 'RANCH_RESULT_UNCONFIRMED');
  assert.equal(f.writes, 1);
});


test('出售鸡蛋任务只卖进度缺口，进度延迟期间复查且不再次出售', async () => {
  const f = fixture();
  const task = { id: '300006', desc: '出售鸡蛋', progress: '1', total_progress: '3', task_type: 4, is_unlocked: true };
  f.tasks.push(task);
  f.products.push(ranchProduct('9007199254741001', '15', '1'));
  const policy = (await f.service.getAutomation()).data.policy;
  await f.service.setAutomation({ ...policy, enabled: true, eggSale: true });
  f.advance(31000);
  const result = await f.service.automate();
  assert.equal(result.data.outcome, 'unknown', result.error);
  assert.equal(result.data.taskSaleReceipt, true);
  assert.equal(f.products[0].count, '13');
  assert.equal((await f.service.acknowledge(result.data.id)).code, 'RANCH_AUTO_RECONCILING');
  await f.service.automate();
  assert.equal(f.calls.filter(method => method === 'Sell').length, 1);
  task.progress = '3';
  f.advance(31000);
  await f.service.automate();
  const snapshot = (await f.service.getState('tasks')).data;
  assert.equal(snapshot.lastOperation.outcome, 'confirmed');
  assert.equal(snapshot.tasks[0].canClaim, true);
  assert.equal(f.calls.filter(method => method === 'Sell').length, 1);
});
