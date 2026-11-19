'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const test = require('node:test');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'farm-ranch-service-'));
process.env.FARM_DATA_DIR = root;
const codec = require('../src/services/ranch-codec');
const { createRanchService } = require('../src/services/ranch-service');
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
function fixture(upgrade = false) {
  const file = path.resolve(root, `operations-${Math.random().toString(16).slice(2)}.json`);
  assert.ok(file.startsWith(root + path.sep));
  let now = 1800000000000; let gameOffset = 0; let allowed = true; let failure = false; let malformed = false;
  let gold = upgrade ? 50000 : 100; let price = 10; let grass = 50; let cubs = 5; let writes = 0;
  const calls = []; const ws = {}; let beforeWrite;
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
    withRanchScene: async callback => {
      const value = await callback({ initial: f.initial, assertCurrent() {} });
      now += f.restoreDelayMs || 0;
      return value;
    },
    sendMsgAsync: async (service, method, wire) => {
      calls.push(method);
      f.onRead?.(method);
      const route = Object.values(codec.ROUTES).find(x => x.method === method && x.service === service);
      const request = codec.decode(route.request, wire); let reply;
      if (method === 'AllCells') reply = { grid_width: 10, grid_height: 10, facilities: malformed && writes ? [{ ...facilities[0], instance_id: '0' }] : facilities };
      else if (method === 'GetBag') reply = { global_scene_id: 2, physical_items: [{ id: '60001', count: String(cubs) }, { id: '7001', count: String(grass) }], virtual_items: [{ id: '1007', count: String(gold) }, ...(upgrade ? [{ id: '1102', count: '40000' }] : [])] };
      else if (method === 'GetFacilityDetail') {
        const facility = facilities[0]; assert.equal(request.instance_id, facility.instance_id);
        reply = { info: { instance_id: facility.instance_id, facility_id: facility.facility_id, module_type: facility.module_type,
          level: facility.level, upgrade_cost: [{ id: '1007', count: String(f.upgradeCost) }] } };
      }
      else if (method === 'ShopProfiles') reply = { shop_profiles: [{ shop_id: 5, global_scene_ids: [2] }] };
      else if (method === 'ShopInfo') reply = { goods_list: [{ id: '10002', item_id: '60001', item_count: '1', price: String(price), unlocked: true }] };
      else if (method === 'TaskInfo') reply = { task_info: { growth_tasks: [] } };
      else {
        if (f.rejectUnsent) throw Object.assign(new Error('synthetic budget rejection'), { isGovernedRejection: true });
        beforeWrite?.(); writes++;
        if (failure) throw new Error('synthetic timeout');
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
          const count = Number(request.num); gold -= price * count; cubs += count;
          reply = { goods: { id: '10002' }, cost_items: [{ id: '1007', count: String(price * count) }], get_items: [{ id: '60001', count: String(count) }] };
        } else if (method === 'AddFeed') { grass -= request.add_count; reply = { consumed: [{ id: '7001', count: String(request.add_count) }] }; }
        else if (method === 'PlaceAnimal') {
          cubs -= request.items.length;
          for (let n = 0; n < request.items.length; n++) facilities[0].ranch.animals.push({ animal_inst_id: 8 + n, animal_id: '60001', ranch_inst_id: '11' });
          reply = { op_results: request.items.map((_x, i) => ({ facility_inst_id: '11', kind: 1, target_id: String(i + 8) })) };
        } else reply = { op_results: [{ facility_inst_id: '11', kind: 1, target_id: '7' }] };
      }
      if (route.writing && f.mutateReply) reply = f.mutateReply(reply);
      return { body: codec.encode(route.reply, reply) };
    },
  };
  const make = () => createRanchService({ network, file: () => file, now: () => now + gameOffset, quoteNow: () => now, canAutomate: () => allowed });
  const f = { service: make(), make, calls, file, upgradeCost: 14000, get writes() { return writes; }, advance: ms => { now += ms; }, correctGameClock: ms => { gameOffset = ms; },
    price: n => { price = n; }, timeout: () => { failure = true; }, malformed: () => { malformed = true; },
    allow: value => { allowed = value; }, beforeWrite: fn => { beforeWrite = fn; } };
  return f;
}
async function quoteBuy(f) {
  const result = await f.service.prepare('buy', { shopId: '5', goodsId: '10002', count: 1 });
  assert.equal(result.ok, true, JSON.stringify(result)); return result.data.id;
}
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
    const f = fixture(); f.mutateReply = mutate;
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
