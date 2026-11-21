'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'farm-smart-feed-'));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
process.env.FARM_DATA_DIR = root;
process.env.FARM_LOG_DIR = path.join(root, 'logs');

const codec = require('../src/services/ranch-codec');
const { createRanchService } = require('../src/services/ranch-service');
const { DEFAULT_POLICY, SLOTS, chooseSmartFeed, normalizePolicy, slotEnabled } = require('../src/services/ranch-policy');
const smart = { ...DEFAULT_POLICY, smartFeed: true };
const feedSlot = SLOTS.find(slot => slot.feed);
const policy = { ...smart, enabled: true, harvest: false, produce: false, clean: false, tasks: false };

function room(id = '11', count = 1, capacity = 4) {
  return { id, moduleType: 6, active: true, state: 1,
    ranch: { husbandryType: 1, count, capacity, animals: Array.from({ length: count }, (_, index) => ({ id: String(index + 1) })) } };
}
function machine(id = '22', count = 0, capacity = 100, remainingSec = null) {
  return { id, moduleType: 8, active: true, state: 1, capacity, upgradeState: 0, feed: { count, remainingSec, status: 3 } };
}
function card(overrides = {}) {
  return { id: '10001', reward: { id: '7001', count: '1' }, price: { id: '1007', count: '60' },
    maxCount: 999, available: true, remaining: null, ...overrides };
}
function state({ facilities = [room(), machine()], grass = '0', gold = '1000000', goods = [card()] } = {}) {
  return { facilities, grass, currencies: [{ id: '1007', available: gold }],
    shop: goods && { shopId: '6', goods } };
}
const add = (facilityId, count) => ({ action: 'addGrass', input: { facilityId, count } });
const buy = count => ({ action: 'buy', input: { goodsId: '10001', shopId: '6', count } });

test('smart feed is opt-in and parks the old selected grass rules without affecting other shop targets', () => {
  assert.equal(normalizePolicy({ enabled: true }, { fromStorage: true }).smartFeed, false);
  assert.equal(normalizePolicy({ smartFeed: true }).grassDailyLimit, 0);
  const parked = normalizePolicy({ smartFeed: true, grassEnabled: true });
  assert.equal(slotEnabled(normalizePolicy({ ...parked, smartFeed: false }, { previous: parked }), SLOTS[4]), false);
  assert.throws(() => normalizePolicy({ grassEnabled: true }), /每日补草上限/);
  assert.equal(slotEnabled({ ...smart, grassEnabled: true, grassDailyLimit: 100 }, SLOTS[4]), false);
  assert.equal(slotEnabled({ ...smart, buyEnabled: true, shopId: '6', goodsId: '10001', currencyDailyLimit: 100 }, SLOTS[6]), false);
  assert.equal(slotEnabled({ ...smart, buyEnabled: true, goodsId: '10002', currencyDailyLimit: 100 }, SLOTS[6]), true);
  assert.equal(slotEnabled({ ...smart, smartFeed: false, grassEnabled: true, grassDailyLimit: 100 }, SLOTS[4]), true);
  assert.equal(slotEnabled({ ...smart, smartFeed: false, buyEnabled: true, shopId: '6', goodsId: '10001', currencyDailyLimit: 100 }, SLOTS[6]), true);
  assert.equal(slotEnabled(DEFAULT_POLICY, feedSlot), false);
});

test('uses complete active-room occupancy to set the target, never guessing a consumption rate', () => {
  const machine100 = machine('22', 10);
  assert.deepEqual(chooseSmartFeed(smart, state({ facilities: [room('11', 1, 3), machine100], grass: '100' })).selected, add('22', 24));
  assert.deepEqual(chooseSmartFeed(smart, state({ facilities: [room('11', 4), machine100], grass: '33' })).selected, add('22', 33));
  assert.deepEqual(chooseSmartFeed(smart, state({ facilities: [room('11', 4), machine100], grass: '100' })).selected, add('22', 90));
  assert.equal(chooseSmartFeed(smart, state({ facilities: [room('11', 0), machine100] })).reason, 'no_animals');
  assert.equal(chooseSmartFeed(smart, state({ facilities: [room(), machine('22', 100)] })).reason, 'grass_sufficient');
  assert.equal(chooseSmartFeed(smart, state({ facilities: [room(), { ...machine100, feed: null }] })).reason, 'facility_unconfirmed');
  assert.equal(chooseSmartFeed(smart, state({ facilities: [room(), { ...machine100, feed: { count: 0, status: 0 } }] })).reason, 'facility_unconfirmed');
  assert.equal(chooseSmartFeed(smart, state({ facilities: [room(), { ...machine100, upgradeState: 1 }] })).reason, 'no_facility');
  const incomplete = room();
  incomplete.ranch.animals.length = 0;
  assert.equal(chooseSmartFeed(smart, state({ facilities: [incomplete, machine100] })).reason, 'facility_unconfirmed');
});

test('prefers verified urgent machines and buys a single shared shortfall within exact shop and wallet bounds', () => {
  const facilities = [room('11', 4), machine('22', 97), machine('23', 90, 100, '30')];
  const existing = chooseSmartFeed(smart, state({ facilities, grass: '7', goods: null }));
  assert.deepEqual(existing, { selected: add('23', 7), urgent: true });
  assert.deepEqual(chooseSmartFeed(smart, state({ facilities, goods: null })), { needsShop: true });
  assert.deepEqual(chooseSmartFeed(smart, state({ facilities })).selected, buy(13));
  const packs = [card({ reward: { id: '7001', count: '2' }, remaining: '4' })];
  assert.deepEqual(chooseSmartFeed(smart, state({ facilities, goods: packs })).selected, buy(4));
  assert.deepEqual(chooseSmartFeed(smart, state({ facilities, goods: packs, gold: '130' })).selected, buy(2));
  assert.equal(chooseSmartFeed(smart, state({ facilities, goods: packs, gold: '59' })).reason, 'insufficient_balance');
  assert.equal(chooseSmartFeed(smart, state({ facilities, goods: [card({ remaining: '0', available: false })] })).reason, 'shop_limit');
  assert.equal(chooseSmartFeed(smart, state({ facilities, goods: [card(), card()] })).reason, 'shop_unconfirmed');
  assert.equal(chooseSmartFeed(smart, state({ facilities, goods: [card({ reward: { id: '7001', count: '14' } })] })).reason, 'grass_pack_exceeds_deficit');
  assert.equal(chooseSmartFeed(smart, state({ facilities, goods: [card({ reward: { id: '7003', count: '1' } })] })).reason, 'no_product');
  assert.deepEqual(chooseSmartFeed(smart, state({ facilities: [room('11', 4), machine('22', 1, 8000)] })).selected, buy(999));
});

let fileSequence = 0;
function fixture({ grass: initialGrass = 0, beforePrepareDelta = 0, receiptMode = 'complete' } = {}) {
  const file = path.join(root, `ledger-${++fileSequence}.json`);
  const writes = [];
  const reads = [];
  const leases = [];
  const ws = {};
  let now = 1800000000000;
  let count = 10;
  let grass = initialGrass;
  let gold = 6000;
  let produce = false;
  let uncertain = false;
  let allow = true;
  const feed = () => ({ feed_count: count, consume_rate: 0, remaining_secs: '-1', is_owner: true, status: 3 });
  const cells = () => ({ grid_width: 10, grid_height: 10, facilities: [
    { instance_id: '11', facility_id: 6001002, module_type: 6, state: 1, level: 2, capacity: 4,
      ranch: { ranch_inst_id: '11', husbandry_type: 1, animal_count: 1, capacity: 4,
        animals: [{ ranch_inst_id: '11', animal_inst_id: 1, animal_id: '60001', can_deliver: produce }] } },
    { instance_id: '22', facility_id: 7001001, module_type: 8, state: 1, level: 1, capacity: 100, feed_machine: feed() },
  ] });
  const network = {
    getWs: () => ws, isConnected: () => true, getUserState: () => ({ gid: 42 }),
    withRanchScene: (callback, { maxCalls }) => {
      leases.push(maxCalls);
      return callback({ initial: null, assertCurrent() {} });
    },
    sendMsgAsync: async (service, method, body) => {
      const route = Object.values(codec.ROUTES).find(row => row.service === service && row.method === method);
      const request = codec.decode(route.request, body);
      let reply;
      if (method === 'AllCells') {
        if (beforePrepareDelta && reads.filter(read => read === 'AllCells').length === 1) count += beforePrepareDelta;
        reply = cells();
      } else if (method === 'GetBag') reply = { global_scene_id: 2, physical_items: grass ? [{ id: '7001', count: String(grass) }] : [],
        virtual_items: [{ id: '1007', count: String(gold) }] };
      else if (method === 'ShopProfiles') reply = { shop_profiles: [{ shop_id: 6, global_scene_ids: [2] }] };
      else if (method === 'ShopInfo') {
        assert.equal(request.shop_id, '6');
        reply = { goods_list: [{ id: '10001', item_id: '7001', item_count: '1', price: '60', unlocked: true }] };
      } else if (method === 'BuyGoods') {
        writes.push([method, request.num]);
        const quantity = Number(request.num);
        grass += quantity;
        gold -= quantity * 60;
        if (uncertain) {
          gold--;
          throw new Error('fixture buy response lost with another balance change');
        }
        if (receiptMode === 'lost') throw new Error('synthetic missing purchase reply');
        reply = { goods: { id: '10001' }, get_items: [{ id: '7001', count: String(quantity) }],
          cost_items: [{ id: '1007', count: String(quantity * 60) }] };
      } else if (method === 'AddFeed') {
        writes.push([method, request.add_count]);
        assert.equal(request.instance_id, '22');
        assert.equal(request.use_gold, false);
        grass -= request.add_count;
        count += request.add_count;
        if (uncertain) {
          count--;
          throw new Error('fixture feed response lost with an ambiguous machine delta');
        }
        if (receiptMode === 'lost') throw new Error('synthetic missing feeding reply');
        reply = receiptMode === 'incomplete' ? {} : { detail: feed(), consumed: [{ id: '7001', count: String(request.add_count) }] };
        if (receiptMode === 'consumed-in-between') { reply.consumed = []; count--; }
      } else if (method === 'TriggerProduce') {
        writes.push([method]);
        produce = false;
        reply = { op_results: [{ facility_inst_id: '11', kind: 1, target_id: '1' }] };
      } else throw new Error(`Unexpected fixture RPC: ${method}`);
      if (!route.writing) reads.push(method);
      return { body: codec.encode(route.reply, reply) };
    },
  };
  const make = () => createRanchService({ file: () => file, network, now: () => now, canAutomate: () => allow });
  return { file, make, service: make(), writes, reads, leases, advance: ms => { now += ms; },
    options: ({ feedCount = count, produces = produce, loseReply = uncertain, enabled = allow }) => {
      count = feedCount; produce = produces; uncertain = loseReply; allow = enabled;
    } };
}

test('scheduler buys only the deficit and uses a later fresh inventory snapshot to add it', async () => {
  const f = fixture();
  assert.equal((await f.service.setAutomation(policy)).ok, true);
  f.advance(30000);
  const bought = await f.service.automate();
  assert.equal(bought.data.outcome, 'confirmed', JSON.stringify(bought));
  assert.deepEqual(f.writes, [['BuyGoods', '15']]);
  assert.deepEqual(f.leases, [7, 7, 10]);
  const usage = (await f.service.getAutomation()).data.usage;
  assert.equal(usage['smartFeed:buy:1007'], '900');
  assert.equal(usage['buy:1007'], undefined);
  const reads = f.reads.length;
  assert.equal((await f.service.automate()).data.skipped, true);
  f.advance(30000);
  const fed = await f.service.automate();
  assert.equal(fed.data.outcome, 'confirmed', JSON.stringify(fed));
  assert.deepEqual(f.writes, [['BuyGoods', '15'], ['AddFeed', 15]]);
  assert.deepEqual(f.leases.slice(3), [7, 5, 10]);
  assert.ok(f.reads.slice(reads).includes('GetBag'));
  assert.ok(!f.reads.slice(reads).includes('ShopInfo'));
  f.advance(300000);
  assert.equal((await f.service.automate()).data.skipped, true);
  assert.equal(f.writes.length, 2);
});

test('operator holding a grass quote, paused automation, and an unknown write each block further writes', async () => {
  const f = fixture({ grass: 20 });
  await f.service.setAutomation(policy);
  f.advance(30000);
  const manual = await f.service.prepare('addGrass', { facilityId: '22', count: 1 });
  assert.equal(manual.ok, true);
  assert.equal((await f.service.automate()).data.skipped, true);
  assert.equal(f.writes.length, 0);
  f.options({ enabled: false });
  f.advance(60000);
  assert.equal((await f.service.automate()).data.skipped, true);
  f.options({ enabled: true, loseReply: true });
  assert.equal((await f.service.automate()).data.outcome, 'unknown');
  assert.deepEqual(f.writes, [['AddFeed', 15]]);
  f.advance(86400000);
  assert.equal((await f.make().automate()).data.skipped, true);
  assert.equal(f.writes.length, 1);
});

test('a starving machine takes one inventory-only turn and hands the deferred rotation slot back', async () => {
  const f = fixture({ grass: 25 });
  f.options({ feedCount: 25 });
  await f.service.setAutomation({ ...policy, produce: true });
  f.advance(30000);
  assert.equal((await f.service.automate()).data.skipped, true);

  f.options({ feedCount: 0, produces: true });
  f.advance(300000);
  assert.equal((await f.service.automate()).data.action, 'addGrass');
  assert.deepEqual(f.writes, [['AddFeed', 25]]);
  f.advance(300000);
  assert.equal((await f.service.automate()).data.action, 'produce');
  assert.deepEqual(f.writes, [['AddFeed', 25], ['TriggerProduce']]);
});

test('a lost grass purchase reply does not start a second purchase or a feed against ambiguous inventory', async () => {
  const f = fixture();
  await f.service.setAutomation(policy);
  f.options({ loseReply: true });
  f.advance(30000);
  assert.equal((await f.service.automate()).data.outcome, 'unknown');
  f.advance(86400000);
  assert.equal((await f.make().automate()).data.skipped, true);
  assert.deepEqual(f.writes, [['BuyGoods', '15']]);
});

test('a natural decrease during preparation still permits a smaller, safe inventory transfer', async () => {
  const f = fixture({ grass: 20, beforePrepareDelta: -1 });
  await f.service.setAutomation(policy);
  f.advance(30000);
  const result = await f.service.automate();
  assert.equal(result.data.outcome, 'confirmed', JSON.stringify(result));
  assert.deepEqual(f.writes, [['AddFeed', 15]]);
});

test('a fresh snapshot with a smaller deficit invalidates the older, larger purchase before sending', async () => {
  const f = fixture({ beforePrepareDelta: 12 });
  await f.service.setAutomation(policy);
  f.advance(30000);
  assert.equal((await f.service.automate()).code, 'RANCH_AUTOMATION_PAUSED');
  assert.deepEqual(f.writes, []);
});


test('fresh before/after records settle missing feed debits and lost replies without a second write', async () => {
  for (const mode of ['incomplete', 'consumed-in-between', 'lost']) {
    const f = fixture({ grass: 15, receiptMode: mode });
    const quote = await f.service.prepare('addGrass', { facilityId: '22', count: 15 });
    const result = (await f.service.execute(quote.data.id)).data;
    assert.equal(result.outcome, 'confirmed', mode);
    assert.equal(result.reconciliation.expectedGrass, '15');
    assert.equal(result.reconciliation.observedGrass, '15');
    assert.equal(result.reconciliation.observedMachine, mode === 'consumed-in-between' ? '14' : '15');
    assert.match(result.message, /自动核账已确认/);
    const replay = await f.make().execute(quote.data.id);
    assert.equal(replay.data.replayed, true);
    assert.equal(f.writes.length, 1);
  }
  const f = fixture({ receiptMode: 'lost' });
  await f.service.setAutomation(policy); f.advance(30000);
  const bought = (await f.service.automate()).data;
  assert.equal(bought.outcome, 'confirmed');
  assert.equal(bought.reconciliation.observedTickets, '900');
  f.advance(30000);
  assert.equal((await f.service.automate()).data.action, 'addGrass');
  assert.equal(f.writes.filter(([action]) => action === 'BuyGoods').length, 1);
});

test('unmatched delivery is rechecked read-only after restart; the refreshed ledger releases the hold', async () => {
  const f = fixture({ grass: 15 });
  f.options({ loseReply: true });
  const quote = (await f.service.prepare('addGrass', { facilityId: '22', count: 15 })).data;
  const pending = (await f.service.execute(quote.id)).data;
  assert.equal(pending.outcome, 'unknown');
  assert.deepEqual([pending.reconciliation.expectedGrass, pending.reconciliation.observedGrass, pending.reconciliation.observedMachine], ['15', '15', '14']);
  assert.equal(pending.reconciliation.checking, true);
  assert.equal((await f.service.acknowledge(quote.id)).code, 'RANCH_AUTO_RECONCILING');
  f.options({ loseReply: false, feedCount: 25 });
  f.advance(30000);
  const restored = f.make();
  await restored.automate();
  const observed = (await restored.getState()).data.lastOperation;
  assert.equal(observed.outcome, 'confirmed');
  assert.equal(observed.reconciliation.observedMachine, '15');
  assert.equal(f.writes.length, 1);
});

test('an old decoded feed response with no bag baseline is archived only after two reads prove its command obsolete', async () => {
  const f = fixture({ grass: 15 });
  f.options({ loseReply: true });
  const q = (await f.service.prepare('addGrass', { facilityId: '22', count: 15 })).data;
  assert.equal((await f.service.execute(q.id)).data.outcome, 'unknown');
  const data = JSON.parse(fs.readFileSync(f.file));
  const held = data.quotes.find(row => row.id === q.id);
  delete held.feedBefore; delete held.feedReceipt; delete held.result.reconciliation;
  held.result.message = '补草扣除回执未匹配，请核对牧草数量'; data.lastOperation = held.result;
  fs.writeFileSync(f.file, JSON.stringify(data));
  const restored = f.make();
  await restored.automate();
  const one = JSON.parse(fs.readFileSync(f.file)).lastOperation;
  assert.equal(one.outcome, 'unknown');
  assert.equal(one.reconciliation.observedGrass, null);
  f.advance(30000); await restored.automate();
  const end = (await restored.getState()).data.lastOperation;
  assert.equal(end.outcome, 'replanned'); assert.deepEqual(end.costs, []); assert.equal(end.completed, 0);
  assert.equal((await restored.execute(q.id)).data.replayed, true); assert.equal(f.writes.length, 1);
});


test('an overdue feed still rechecks at low frequency and retires a satisfied goal without fabricating an old debit', async () => {
  const f = fixture({ grass: 15 });
  f.options({ loseReply: true });
  const q = (await f.service.prepare('addGrass', { facilityId: '22', count: 15 })).data;
  assert.equal((await f.service.execute(q.id)).data.outcome, 'unknown');
  const resumed = f.make();
  f.options({ feedCount: 25, loseReply: false });
  f.advance(700000);
  await resumed.automate();
  const reads = f.reads.length;
  await resumed.automate();
  assert.equal(f.reads.length, reads);
  assert.equal(JSON.parse(fs.readFileSync(f.file)).lastOperation.outcome, 'unknown');
  f.advance(600000); await resumed.automate();
  const end = JSON.parse(fs.readFileSync(f.file)).lastOperation;
  assert.equal(end.outcome, 'replanned'); assert.equal(end.completed, 0); assert.equal(f.writes.length, 1);
});

test('lost dashboard responses read the bound feed receipt and only cancel an unused quote', async () => {
  const f = fixture({ grass: 15 });
  const prepared = (await f.service.prepare('addGrass', { facilityId: '22', count: 5 })).data;
  const cancelled = (await f.service.acknowledge({ feedReceiptId: prepared.id })).data;
  assert.equal(cancelled.id, prepared.id); assert.equal(cancelled.outcome, 'not_sent');
  assert.equal((await f.service.execute(prepared.id)).data.outcome, 'not_sent'); assert.equal(f.writes.length, 0);
  const prepared2 = (await f.service.prepare('addGrass', { facilityId: '22', count: 5 })).data;
  const completed = (await f.service.execute(prepared2.id)).data;
  assert.equal(completed.outcome, 'confirmed');
  const replay = (await f.service.acknowledge({ feedReceiptId: prepared2.id })).data;
  assert.equal(replay.outcome, 'confirmed'); assert.equal(f.writes.length, 1);
});
