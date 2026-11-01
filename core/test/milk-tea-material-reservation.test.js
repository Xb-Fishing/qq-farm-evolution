'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { fixture } = require('./milk-tea-full-loop.test');
const { proto } = require('./milk-tea-autonomy-baseline.test');
const config = require('../src/gameConfig/MilkTeaActivity.json');
const fruits = config.recipes.filter(row => row.fruitItemId > 0).map(row => row.fruitItemId);
const input = rows => ({ fruitUids: rows.map(row => String(row.uid)), confirmedFruits: rows.map(row => ({ uid: String(row.uid), itemId: row.id, count: String(row.count) })) });
function plainBag(f) {
  f.deps.getBag = async () => { f.calls.push('Bag'); return { items: f.bag }; };
  f.deps.getBagItems = bag => bag.items;
}
test('automatic craft selects up to 100 legal mixed whole stacks, stable order and exact counts', async () => {
  const f = await fixture({ milk_tea_auto_craft: true });
  try {
    plainBag(f);
    for (let i = 100; i >= 0; i--) f.bag.push({ id: fruits[i % fruits.length], uid: String(4000 + i), count: String(i + 1) });
    f.bag.push({ id: 40525, uid: '2000', count: '1', locked: true });
    await f.service.runAutomaticMilkTea(f.deps); assert.deepEqual(f.writes(), [62]);
    const req = f.requests.find(row => Number(row.operate_type) === 62).milk_tea_craft;
    assert.equal(req.fruit_uids.length, 100); assert.equal(String(req.fruit_uids[0]), '4000'); assert.equal(String(req.fruit_uids.at(-1)), '4099');
    const state = f.journalData().actionState; assert.equal(state.crafts['4000'].count, '1'); assert.equal(state.crafts['4099'].count, '100');
    assert.equal(f.calls.filter(row => row === 'Bag').length, 2, 'one shared initial Bag plus one final fresh manual validation');
    assert.equal(f.requests.filter(row => Number(row.operate_type) === 58).length, 2);
  } finally { f.close(); }
});
test('duplicate raw material UIDs reject the craft request before any write', async () => {
  const f = await fixture({ milk_tea_auto_craft: true });
  try {
    f.bag.push({ id: 40525, uid: '4000', count: '5' }, { id: 40526, uid: '4000', count: '7' }, { id: 40525, uid: '4001', count: '1' });
    await f.service.runAutomaticMilkTea(f.deps); assert.deepEqual(f.writes(), []);
  } finally { f.close(); }
});
test('manual selected UID duplicated by a nonrecipe item is ambiguous and never sends craft', async () => {
  const f = await fixture({});
  try {
    const row = { id: 40525, uid: '4000', count: '5' };
    f.bag.push(row, { id: 40001, uid: '4000', count: '1' });
    await assert.rejects(f.service.runManualMilkTeaAction('craft', input([row]), f.deps), { code: 'SEASON_WISH_MILK_TEA_INVALID_STATE' });
    assert.deepEqual(f.writes(), []);
  } finally { f.close(); }
});
test('first 100 reserved stacks never hide a later new UID; unknown survives reload/day/config', async () => {
  const f = await fixture({ milk_tea_auto_craft: true });
  try {
    for (let i = 0; i < 100; i++) f.bag.push({ id: 40525, uid: String(4000 + i), count: '5' });
    f.unknown(62); await f.service.runAutomaticMilkTea(f.deps); assert.deepEqual(f.writes(), [62]);
    f.reload(); f.setFlags({ milk_tea_auto_craft: false }); await f.at(86400000);
    f.setFlags({ milk_tea_auto_craft: true }); f.bag.push({ id: 40526, uid: '9000', count: '7' });
    f.unknown(0); await f.tick(); assert.deepEqual(f.writes(), [62, 62]);
    const selected = f.requests.filter(row => Number(row.operate_type) === 62).at(-1).milk_tea_craft.fruit_uids.map(String);
    assert.deepEqual(selected, ['9000']); assert.equal(Object.keys(f.journalData().actionState.crafts).length, 101);
    await f.tick(); assert.deepEqual(f.writes(), [62, 62]);
  } finally { f.close(); }
});
test('same UID becomes usable again only after complete fresh Bag observes absence or zero', async () => {
  const f = await fixture({ milk_tea_auto_craft: true });
  try {
    f.bag.push({ id: 40525, uid: '4000', count: '5' }); f.unknown(62);
    await f.service.runAutomaticMilkTea(f.deps); f.unknown(0); f.reload(); await f.tick(); assert.deepEqual(f.writes(), [62]);
    f.bag.find(row => row.id === 40525).count = '6'; await f.tick(); assert.deepEqual(f.writes(), [62], 'a changed positive stack is not a consumed/new cycle');
    const getter = f.deps.getBag; f.deps.getBag = async () => ({}); await f.tick(); assert.deepEqual(f.writes(), [62]); f.deps.getBag = getter;
    f.bag.splice(f.bag.findIndex(row => row.id === 40525), 1); await f.tick();
    f.bag.push({ id: 40525, uid: '4000', count: '9' }); await f.tick(); assert.deepEqual(f.writes(), [62, 62]);
  } finally { f.close(); }
});
test('normal workshop read reconciles material absence without writing; failed durable reconciliation preserves the claim', async () => {
  const f = await fixture({ milk_tea_auto_craft: true }); const rename = fs.renameSync;
  try {
    const row = { id: 40525, uid: '4000', count: '5' }; f.bag.push(row); f.unknown(62);
    await f.service.runAutomaticMilkTea(f.deps); f.unknown(0); f.bag.splice(f.bag.indexOf(row), 1);
    fs.renameSync = () => { throw new Error('synthetic read reconciliation failure'); };
    const read = await f.service.queryMilkTeaActivity('workshop', {}, f.deps); assert.equal(read.kind, 'workshop');
    fs.renameSync = rename;
    assert.ok(f.journalData().actionState.crafts['4000']); f.bag.push(row); await f.tick(); assert.deepEqual(f.writes(), [62]);
    f.bag.splice(f.bag.indexOf(row), 1); await f.service.queryMilkTeaActivity('workshop', {}, f.deps);
    assert.equal(f.journalData().actionState.crafts['4000'], undefined); assert.deepEqual(f.writes(), [62]);
    f.bag.push({ ...row, count: '7' });
    const result = await f.service.runManualMilkTeaAction('craft', input([f.bag.at(-1)]), f.deps); assert.equal(result.ok, true);
    assert.deepEqual(f.writes(), [62, 62]);
  } finally { fs.renameSync = rename; f.close(); }
});
test('manual unknown craft prevents automatic replay, and shared lease rejects concurrent manual work', async () => {
  const f = await fixture({ milk_tea_auto_craft: true });
  try {
    const row = { id: 40525, uid: '4000', count: '5' }; f.bag.push(row);
    let release; const gate = new Promise(resolve => { release = resolve; }); let first = true;
    f.hook(async stage => { if (stage === 'bag' && first) { first = false; await gate; } });
    const running = f.service.runAutomaticMilkTea(f.deps); await new Promise(resolve => setImmediate(resolve));
    await assert.rejects(f.service.runManualMilkTeaAction('craft', input([row]), f.deps), { code: 'SEASON_WISH_MILK_TEA_BUSY' });
    f.unknown(62); release(); await running; assert.deepEqual(f.writes(), [62]);
    f.hook(null); f.unknown(0);
    await assert.rejects(f.service.runManualMilkTeaAction('craft', input([row]), f.deps), { code: 'SEASON_WISH_MILK_TEA_LIMIT' });
    await f.tick(); assert.deepEqual(f.writes(), [62]);
  } finally { f.close(); }
});
for (const change of ['count', 'kind', 'lock', 'recipe']) test(`manual craft fresh ${change} change rejects before economic write`, async () => {
  const f = await fixture({});
  try {
    plainBag(f); const row = { id: 40525, uid: '4000', count: '5' }; f.bag.push(row); const confirmed = input([row]);
    if (change === 'count') row.count = '6'; if (change === 'kind') row.id = 40526;
    if (change === 'lock') row.locked = true; if (change === 'recipe') f.workshop.recipes.find(row => row.recipe_id === 2).unlocked = false;
    await assert.rejects(f.service.runManualMilkTeaAction('craft', confirmed, f.deps)); assert.deepEqual(f.writes(), []);
  } finally { f.close(); }
});
test('strict zero-send releases craft reservation and unknown text does not', async () => {
  const f = await fixture({ milk_tea_auto_craft: true });
  try {
    f.bag.push({ id: 40525, uid: '4000', count: '5' });
    f.respond(cmd => { if (cmd === 62) { assert.ok(f.journalData().actionState.crafts['4000']); throw Object.assign(new Error('synthetic budget'), { isGovernedRejection: true, governedReason: 'budget_total' }); } });
    await f.service.runAutomaticMilkTea(f.deps); assert.equal(Object.keys(f.journalData().actionState.crafts).length, 0);
    f.respond(cmd => { if (cmd === 62) throw Object.assign(new Error('budget_total'), { isGovernedRejection: 'true', governedReason: 'budget_total' }); });
    await f.tick(); assert.equal(f.journalData().actionState.crafts['4000'].status, 'pending');
    f.reload(); f.respond(null); await f.tick(); assert.equal(f.writes().filter(cmd => cmd === 62).length, 2, 'unknown remains reserved after restart');
  } finally { f.close(); }
});
test('durable craft release failure preserves its original pending reservation in memory and on disk', async () => {
  const f = await fixture({ milk_tea_auto_craft: true }); const rename = fs.renameSync;
  try {
    f.bag.push({ id: 40525, uid: '4000', count: '5' });
    f.respond(cmd => {
      if (cmd === 62) {
        fs.renameSync = () => { throw new Error('synthetic release persistence failure'); };
        throw Object.assign(new Error('synthetic budget'), { isGovernedRejection: true, governedReason: 'budget_method' });
      }
    });
    await f.service.runAutomaticMilkTea(f.deps);
    fs.renameSync = rename;
    assert.equal(f.journalData().actionState.crafts['4000'].status, 'pending');
    f.respond(null); f.reload(); await f.tick(); assert.deepEqual(f.writes(), [62]);
  } finally { fs.renameSync = rename; f.close(); }
});
test('reserved-material sale rejects before Sell, ordinary sale stays usable and in-flight material sale holds the milk lease', async () => {
  const f = await fixture({ milk_tea_auto_craft: true });
  const network = require('../src/utils/network'); const original = network.sendMsgAsync;
  let release; let block = false; let sells = 0; const sent = [];
  try {
    f.bag.push({ id: 40525, uid: '4000', count: '5' }); f.unknown(62); await f.service.runAutomaticMilkTea(f.deps); f.unknown(0);
    network.sendMsgAsync = async (service, method, body) => {
      if (method !== 'Sell') return original(service, method, body);
      sent.push(...proto.types.SellRequest.decode(body).items.map(row => ({ uid: String(row.uid), count: String(row.count) })));
      sells++; if (block) await new Promise(resolve => { release = resolve; });
      return { body: proto.types.SellReply.encode({ items: [{ id: 1001, count: 10 }] }).finish() };
    };
    delete require.cache[require.resolve('../src/services/warehouse')]; const warehouse = require('../src/services/warehouse');
    await assert.rejects(warehouse.sellItems([{ id: 40525, uid: '4000', count: '5' }]), { code: 'SEASON_WISH_MILK_TEA_LIMIT' }); assert.equal(sells, 0);
    await warehouse.sellItems([{ id: 40001, uid: '7000', count: '1' }]); assert.equal(sells, 1);
    await warehouse.sellItems([{ id: 40525, uid: '9007199254740993', count: '9007199254740993' }]);
    assert.deepEqual(sent.at(-1), { uid: '9007199254740993', count: '9007199254740993' }, 'targeted material encoder preserves int64 values');
    await assert.rejects(warehouse.sellItems([{ id: 40525, uid: '9223372036854775808', count: '1' }]), { code: 'SEASON_WISH_MILK_TEA_INVALID_INPUT' }); assert.equal(sells, 2);
    block = true; const sale = warehouse.sellItems([{ id: 40525, uid: '5000', count: '1' }]); await new Promise(resolve => setImmediate(resolve));
    await assert.rejects(f.service.runManualMilkTeaAction('craft', input([{ id: 40525, uid: '4000', count: '5' }]), f.deps), { code: 'SEASON_WISH_MILK_TEA_BUSY' });
    release(); await sale; assert.equal(sells, 3);
    let ordinary = 0; await f.service.withMilkTeaMaterialSale([{ id: 40001, count: '1' }], async () => { ordinary++; }); assert.equal(ordinary, 1);
  } finally { release?.(); network.sendMsgAsync = original; f.close(); }
});
test('mismatched crafted recipe result is unknown and cannot release or replay its material claim', async () => {
  const f = await fixture({ milk_tea_auto_craft: true });
  try {
    f.bag.push({ id: 40525, uid: '4000', count: '5' });
    f.respond((cmd, reply) => cmd === 62 ? { ...reply, milk_tea_craft: { crafted_cups: { 99: 5 } } } : reply);
    const results = await f.service.runAutomaticMilkTea(f.deps);
    assert.equal(results[0].outcome, 'unknown'); assert.equal(f.journalData().actionState.crafts['4000'].status, 'pending');
    f.respond(null); f.reload(); await f.tick(); assert.deepEqual(f.writes(), [62]);
  } finally { f.close(); }
});
test('capacity never evicts unknown UIDs; observing one consumed UID allows exactly one independent new stack', async () => {
  const f = await fixture({ milk_tea_auto_craft: true });
  try {
    const crafts = {};
    for (let i = 0; i < 512; i++) {
      const uid = String(4000 + i); crafts[uid] = { itemId: 40525, count: '5', at: f.clock.now, status: 'pending' };
      f.bag.push({ id: 40525, uid, count: '5' });
    }
    f.bag.push({ id: 40526, uid: '9000', count: '7' });
    fs.writeFileSync(f.journal(), JSON.stringify({ version: 1, claims: {}, actionState: { wages: null, upgrades: null, interactions: {}, purchases: {}, spend: {}, crafts } })); f.reload();
    await f.service.runAutomaticMilkTea(f.deps); assert.deepEqual(f.writes(), []); assert.equal(Object.keys(f.journalData().actionState.crafts).length, 512);
    f.bag.splice(f.bag.findIndex(row => row.uid === '4000'), 1); await f.tick(); assert.deepEqual(f.writes(), [62]);
    assert.deepEqual(f.requests.find(row => Number(row.operate_type) === 62).milk_tea_craft.fruit_uids.map(String), ['9000']);
    assert.equal(Object.keys(f.journalData().actionState.crafts).length, 512);
  } finally { f.close(); }
});
test('actual auto-sell leaves all eight conditional-sale materials in inventory with craft both on and off', async () => {
  for (const enabled of [false, true]) {
    const f = await fixture({ sell: true, milk_tea_auto_craft: enabled });
    const network = require('../src/utils/network'); const original = network.sendMsgAsync; const sold = [];
    try {
      f.bag.push(...fruits.map((id, i) => ({ id, uid: String(5000 + i), count: '2' })));
      network.sendMsgAsync = async (service, method, body) => {
        if (method === 'Sell') { sold.push(...proto.types.SellRequest.decode(body).items.map(row => Number(row.id))); return { body: proto.types.SellReply.encode({ items: [{ id: 1001, count: 10 }] }).finish() }; }
        return original(service, method, body);
      };
      delete require.cache[require.resolve('../src/services/warehouse')]; await require('../src/services/warehouse').sellAllFruits();
      assert.deepEqual(sold, [], 'mapped activity fruits keep their existing conditional-sale exclusion');
    } finally { network.sendMsgAsync = original; f.close(); }
  }
});
