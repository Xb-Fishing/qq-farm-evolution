const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./milk-tea-autonomy-baseline.test');
const policy = require('../src/services/milk-tea-auto-policy');
const config = require('../src/config/gameConfig');
test('complete registered seed targets, including experience mushroom and more than eight entries, persist through account and default-plan reload', () => {
  const ids = [...new Set([20523, ...config.getAllSeeds().slice(0, 12).map(seed => seed.seedId)])];
  assert.ok(ids.length > 8);
  const value = { ...policy.cloneSeedPolicy(policy.DEFAULT_SEED_POLICY), targetSeedIds: ids, ticketDailyLimit: '5000' };
  assert.deepEqual(policy.normalizeSeedPolicy(value).targetSeedIds, ids);
  const store = require('../src/models/store');
  store.applyConfigSnapshot({ automation: { milk_tea_seed_policy: value } }, { accountId: 'synthetic-complete-seeds' });
  store.setUserDefaultAccountPlan('synthetic-complete-template', { automation: { milk_tea_seed_policy: value } });
  delete require.cache[require.resolve('../src/models/store')]; const loaded = require('../src/models/store');
  assert.deepEqual(loaded.getAutomation('synthetic-complete-seeds').milk_tea_seed_policy.targetSeedIds, ids);
  assert.deepEqual(loaded.getUserDefaultAccountPlan('synthetic-complete-template').config.automation.milk_tea_seed_policy.targetSeedIds, ids);
  for (const id of [101616, 40523, 999999999, -1, 1.5]) assert.deepEqual(policy.normalizeSeedPolicy({ ...value, targetSeedIds: [id] }).targetSeedIds, []);
});
test('static catalog covers all configured seeds without consulting any provider or requiring a fake account', () => {
  const routes = new Map(); const provider = new Proxy({}, { get() { throw Error('static catalog must never consult game provider'); } });
  require('../src/controllers/admin-milk-tea-activity-routes').registerAdminMilkTeaActivityRoutes({ app: { get: (url, handler) => routes.set(url, handler), post() {} }, provider });
  let body; routes.get('/api/activity/milk-tea/seed-catalog')({}, { json(value) { body = value; } });
  assert.equal(body.ok, true); assert.equal(body.seeds.length, config.getAllSeeds().length);
  assert.equal(body.seeds.find(seed => seed.id === 20523).name, '经验蘑菇种子');
});
async function mushroom(run) {
  const f = await fixture({ milk_tea_auto_seeds: true });
  try {
    f.summary.level = 13; f.goods.id = 310; f.goods.rewards = [{ id: 20523, count: '1' }]; f.goods.costs = [{ id: 1041, count: '5000' }];
    f.goods.purchaseLimit = 150; f.goods.condHints = [{ condType: '活动检查', params: '2026110101_奶茶店等级_13', satisfied: true, current: 13, target: 13 }];
    f.setFlags({ milk_tea_seed_policy: { ...f.auto.milk_tea_seed_policy, targetSeedIds: [20523], targetStock: 1, ticketDailyLimit: '5000' } });
    await run(f);
  } finally { f.close(); }
}
test('experience mushroom follows the real automatic exchange entry once at shop level 13 and within the original budget', () => mushroom(async f => {
  f.goods.condHints[0].satisfied = false; f.goods.condHints[0].current = 12;
  await f.service.runAutomaticMilkTea(f.deps); assert.deepEqual(f.writes(), []);
  f.goods.condHints[0].satisfied = true; f.goods.condHints[0].current = 13;
  await f.tick(); assert.deepEqual(f.writes(), [1]);
  const req = f.requests.find(req => Number(req.operate_type) === 1);
  assert.equal(Number(req.activity_id), 2026110102); assert.equal(Number(req.shop_buy.goods_id), 310); assert.equal(Number(req.shop_buy.count), 1);
  await f.tick(); assert.deepEqual(f.writes(), [1], 'unchanged confirmed purchase must not replay');
}));
test('missing eligibility, exhausted budget and a target absent from this activity shop remain zero writes', async () => {
  for (const change of [f => { f.goods.automaticPurchaseDataComplete = false; }, f => { f.setFlags({ milk_tea_seed_policy: { ...policy.DEFAULT_SEED_POLICY, targetSeedIds: [20523], ticketDailyLimit: '0' } }); }, f => { f.goods.rewards = [{ id: 20525, count: '1' }]; }]) await mushroom(async f => {
    change(f); await f.service.runAutomaticMilkTea(f.deps); assert.deepEqual(f.writes(), []);
  });
});
test('unknown mushroom exchange result retains the shared declaration and cannot be replayed', () => mushroom(async f => {
  f.unknown(1); await f.service.runAutomaticMilkTea(f.deps); assert.deepEqual(f.writes(), [1]);
  f.unknown(0); f.reload(); await f.tick(); assert.deepEqual(f.writes(), [1]);
}));

test('experience mushroom settlement bounds and real manual exchange both refuse purchase', () => mushroom(async f => {
  const bounds = f.service.getMilkTeaExchangeBounds(f.goods, {available:true,counts:new Map([[1041,16000]])}, {phase:'settle'});
  assert.equal(bounds.maxCount,0); assert.match(bounds.blockReason,/结算/);
  f.clock.now=Date.parse('2026-11-15T01:00:00Z');
  const warehouse=require('../src/services/warehouse');
  await assert.rejects(f.service.runManualMilkTeaAction('exchange',{goodsId:310,count:1,confirmedCosts:[{itemId:1041,count:'5000'}]}, {...f.deps,getBag:warehouse.getBag,getBagItems:warehouse.getBagItems}), /结算/);
  assert.deepEqual(f.writes(),[]);
}));
test('manual unknown mushroom exchange owns the same declaration as automatic restock', () => mushroom(async f => {
  f.unknown(1); const warehouse=require('../src/services/warehouse');
  const reply=await f.service.runManualMilkTeaAction('exchange',{goodsId:310,count:1,confirmedCosts:[{itemId:1041,count:'5000'}]}, {...f.deps,getBag:warehouse.getBag,getBagItems:warehouse.getBagItems});
  assert.equal(reply.outcome,'unknown');assert.deepEqual(f.writes(),[1]);
  f.unknown(0);f.reload();await f.tick();assert.deepEqual(f.writes(),[1]);
}));
test('new seed stock already at target and a wrong positive reply cannot produce overbuy or confirmed reward', async () => {
  await mushroom(async f=>{f.bag.push({id:20523,count:'1',uid:'300'});await f.service.runAutomaticMilkTea(f.deps);assert.deepEqual(f.writes(),[]);});
  await mushroom(async f=>{f.response((cmd,reply)=>cmd===1?{...reply,shop_buy:{awards:[{id:20525,count:1}]}}:reply);await f.service.runAutomaticMilkTea(f.deps);assert.deepEqual(f.writes(),[1]);f.reload();await f.tick();assert.deepEqual(f.writes(),[1]);});
});
