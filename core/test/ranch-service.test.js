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
function fixture() {
  const file = path.resolve(root, `operations-${Math.random().toString(16).slice(2)}.json`);
  assert.ok(file.startsWith(root + path.sep));
  let now = 1800000000000; let allowed = true; let failure = false; let malformed = false;
  let gold = 100; let price = 10; let grass = 50; let cubs = 5; let writes = 0;
  const calls = []; const ws = {}; let beforeWrite;
  const facilities = [
    { instance_id: '11', facility_id: 6001002, module_type: 6, state: 1, level: 2, capacity: 4,
      ranch: { ranch_inst_id: '11', capacity: 4, animal_count: 1, husbandry_type: 1,
        animals: [{ ranch_inst_id: '11', animal_inst_id: 7, animal_id: '60001', can_deliver: true, can_harvest: true }] } },
    { instance_id: '22', facility_id: 7001001, module_type: 8, state: 1, level: 1, capacity: 100, feed_machine: { feed_count: 10 } },
  ];
  const network = {
    getWs: () => ws, isConnected: () => true, getUserState: () => ({ gid: 42 }),
    withRanchScene: async callback => callback({ assertCurrent() {} }),
    sendMsgAsync: async (service, method, wire) => {
      calls.push(method);
      const route = Object.values(codec.ROUTES).find(x => x.method === method && x.service === service);
      const request = codec.decode(route.request, wire); let reply;
      if (method === 'AllCells') reply = { grid_width: 10, grid_height: 10, facilities: malformed && writes ? [{ ...facilities[0], instance_id: '0' }] : facilities };
      else if (method === 'GetBag') reply = { global_scene_id: 2, physical_items: [{ id: '60001', count: String(cubs) }, { id: '7001', count: String(grass) }], virtual_items: [{ id: '1007', count: String(gold) }] };
      else if (method === 'ShopProfiles') reply = { shop_profiles: [{ shop_id: 5, global_scene_ids: [2] }] };
      else if (method === 'ShopInfo') reply = { goods_list: [{ id: '10002', item_id: '60001', item_count: '1', price: String(price), unlocked: true }] };
      else if (method === 'TaskInfo') reply = { task_info: { growth_tasks: [] } };
      else {
        if (f.rejectUnsent) throw Object.assign(new Error('synthetic budget rejection'), { isGovernedRejection: true });
        beforeWrite?.(); writes++;
        if (failure) throw new Error('synthetic timeout');
        if (method === 'BuyGoods') {
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
  const make = () => createRanchService({ network, file: () => file, now: () => now, canAutomate: () => allowed });
  const f = { service: make(), make, calls, file, get writes() { return writes; }, advance: ms => { now += ms; },
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
