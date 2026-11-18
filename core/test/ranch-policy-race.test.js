'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const input = { shopId: '5', goodsId: '10002', count: 1 };
const initialPolicy = { enabled: true, buyEnabled: true, goodsId: input.goodsId, currencyDailyLimit: 10 };
const editedPolicy = { ...initialPolicy, enabled: false, currencyDailyLimit: 30, currencyReserve: 15, shopId: '6', goodsId: '10003' };
const buyCost = { id: '1007', count: '10' };
const buyReward = { id: '60001', count: '1' };

async function withFixture(run) {
  const base = fs.realpathSync(os.tmpdir());
  const prefix = path.join(base, 'farm-ranch-policy-race-');
  assert.equal(path.dirname(prefix), base);
  const root = fs.mkdtempSync(prefix);
  const overrides = {
    FARM_DATA_DIR: root,
    FARM_LOG_DIR: path.join(root, 'logs'),
    FARM_PRIVATE_CONFIG_FILE: path.join(root, 'private-config.json'),
  };
  const saved = Object.fromEntries(Object.keys(overrides).map(key => [key, process.env[key]]));
  try {
    assert.equal(fs.realpathSync(root), root);
    assert.equal(path.dirname(root), base);
    const file = path.join(root, 'operations.json');
    for (const target of [file, overrides.FARM_LOG_DIR, overrides.FARM_PRIVATE_CONFIG_FILE]) {
      assert.equal(path.dirname(target), root);
      assert.equal(fs.existsSync(target), false);
    }
    Object.assign(process.env, overrides);
    const codec = require('../src/services/ranch-codec');
    const { createRanchService } = require('../src/services/ranch-service');
    const ws = {};
    let gold = 100;
    let writes = 0;
    let pause;
    let now = 1800000000000;
    const calls = [];
    const network = {
      getWs: () => ws,
      isConnected: () => true,
      getUserState: () => ({ gid: 42 }),
      withRanchScene: callback => callback({ initial: null, assertCurrent() {} }),
      sendMsgAsync: async (service, method, wire) => {
        const route = Object.values(codec.ROUTES).find(row => row.service === service && row.method === method);
        assert.ok(route, method);
        const request = codec.decode(route.request, wire);
        calls.push(method);
        if (pause?.method === method && pause.afterWrite === (writes > 0)) {
          const gate = pause;
          pause = null;
          gate.enter();
          await gate.release;
        }
        let reply;
        switch (method) {
          case 'AllCells':
            reply = { grid_width: 10, grid_height: 10, facilities: [] };
            break;
          case 'GetBag':
            reply = {
              global_scene_id: 2,
              physical_items: gold < 100 ? [buyReward] : [],
              virtual_items: [{ id: '1007', count: String(gold) }],
            };
            break;
          case 'ShopProfiles':
            reply = { shop_profiles: [{ shop_id: 5, global_scene_ids: [2] }] };
            break;
          case 'ShopInfo':
            assert.equal(String(request.shop_id), input.shopId);
            reply = { goods_list: [{ id: input.goodsId, item_id: buyReward.id, item_count: '1', price: '10', unlocked: true }] };
            break;
          case 'BuyGoods':
            assert.equal(String(request.goods_id), input.goodsId);
            assert.equal(Number(request.num), input.count);
            writes++;
            gold -= 10;
            reply = { goods: { id: input.goodsId }, cost_items: [buyCost], get_items: [{ ...buyReward, count: f.mismatched ? '2' : '1' }] };
            break;
          default:
            assert.fail(`Unexpected synthetic RPC: ${method}`);
        }
        return { body: codec.encode(route.reply, reply) };
      },
    };
    const make = () => createRanchService({ network, file: () => file, now: () => now, canAutomate: () => true });
    const f = {
      service: make(), make, calls,
      get writes() { return writes; },
      advance: ms => { now += ms; },
      readLedger: () => JSON.parse(fs.readFileSync(file, 'utf8')),
      gate(method, afterWrite) {
        let enter;
        let finish;
        const entered = new Promise(resolve => { enter = resolve; });
        const release = new Promise((resolve, reject) => {
          finish = error => error ? reject(error) : resolve();
        });
        // A cleanup release can happen before the RPC reaches the gate.
        void release.catch(() => {});
        pause = { method, afterWrite, enter, release };
        return { entered, finish };
      },
    };
    await run(f);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    assert.equal(fs.realpathSync(root), root);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function ok(result) {
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.data;
}

async function prepare(f) {
  const initial = ok(await f.service.setAutomation(initialPolicy));
  assert.equal(initial.revision, 1);
  return ok(await f.service.prepare('buy', input, initial.revision)).id;
}

async function saveWhilePaused(f, id, method, { afterWrite = false, failure } = {}) {
  const gate = f.gate(method, afterWrite);
  const operation = f.service.execute(id);
  let edited;
  try {
    await Promise.race([gate.entered, operation.then(result => assert.fail(`Operation completed before ${method} paused: ${JSON.stringify(result)}`))]);
    assert.equal(f.writes, Number(afterWrite));
    const dispatched = afterWrite || method === 'BuyGoods';
    const ledger = f.readLedger();
    assert.equal(ledger.quotes.find(quote => quote.id === id).status, dispatched ? 'pending' : 'prepared');
    if (dispatched) {
      assert.equal(ledger.lastOperation.outcome, 'pending');
      const calls = [...f.calls];
      const replay = ok(await f.make().execute(id));
      assert.equal(replay.outcome, 'unknown');
      assert.equal(replay.replayed, true);
      assert.deepEqual(f.calls, calls);
    }
    f.advance(1000);
    edited = ok(await f.service.setAutomation(editedPolicy));
    assert.equal(edited.revision, 2);
    for (const [key, value] of Object.entries(editedPolicy)) assert.equal(edited.policy[key], value, key);
    assert.deepEqual(ok(await f.make().getAutomation()), edited);
  } finally {
    gate.finish(failure);
    await operation;
  }
  return { result: await operation, edited };
}

async function assertPersisted(f, id, edited, outcome, writes) {
  const next = f.make();
  assert.deepEqual(ok(await next.getAutomation()), edited, 'completion must preserve the latest saved automation record');
  const ledger = f.readLedger();
  assert.equal(ledger.lastOperation.id, id);
  assert.equal(ledger.lastOperation.outcome, outcome);
  const quote = ledger.quotes.find(row => row.id === id);
  assert.equal(quote.status, outcome);
  assert.deepEqual(quote.result, ledger.lastOperation);
  const calls = [...f.calls];
  for (const service of [f.service, next]) {
    const replay = ok(await service.execute(id));
    assert.equal(replay.outcome, outcome);
    assert.equal(replay.replayed, true);
  }
  assert.deepEqual(f.calls, calls);
  assert.equal(f.writes, writes);
}

for (const rejectShop of [false, true]) {
  test(`policy saved during final ShopInfo survives ${rejectShop ? 'an ordinary refresh rejection' : 'a successful refresh'}`, () => withFixture(async f => {
    const id = await prepare(f);
    const { result, edited } = await saveWhilePaused(f, id, 'ShopInfo', {
      afterWrite: true,
      failure: rejectShop ? new Error('synthetic final refresh failure') : undefined,
    });
    const receipt = ok(result);
    assert.equal(receipt.outcome, 'confirmed');
    assert.equal(receipt.completed, 1);
    assert.equal(receipt.costs[0].id, buyCost.id);
    assert.equal(receipt.costs[0].count, buyCost.count);
    assert.equal(receipt.rewards[0].id, buyReward.id);
    assert.equal(receipt.rewards[0].count, buyReward.count);
    assert.equal(receipt.refreshRequired, false);
    assert.equal(receipt.snapshot.shop?.shopId ?? null, rejectShop ? null : input.shopId);
    assert.equal(receipt.snapshot.currencies.find(item => item.id === buyCost.id).count, '90');
    assert.deepEqual(edited.usage, { 'buy:1007': '10' });
    assert.equal(f.readLedger().lastObservedOperationId, id);
    assert.equal(f.readLedger().lastObservedAt, receipt.snapshot.serverTime);
    assert.equal(f.calls.filter(method => method === 'ShopInfo').length, 3);
    await assertPersisted(f, id, edited, 'confirmed', 1);
  }));
}

test('policy changes during pre-dispatch loadRaw invalidate an automatic quote before any write', () => withFixture(async f => {
  const id = await prepare(f);
  const { result, edited } = await saveWhilePaused(f, id, 'ShopInfo');
  assert.equal(result.ok, false);
  assert.equal(result.code, 'RANCH_AUTOMATION_PAUSED');
  assert.deepEqual(edited.usage, {});
  assert.deepEqual(ok(await f.make().getAutomation()), edited);
  assert.equal(f.readLedger().lastOperation, null);
  assert.equal(f.writes, 0);
  assert.equal(f.calls.includes('BuyGoods'), false);
}));

test('post-buy loadRaw preserves the latest policy and a mismatched receipt stays unknown across replacement', () => withFixture(async f => {
  f.mismatched = true;
  const id = await prepare(f);
  const { result, edited } = await saveWhilePaused(f, id, 'GetBag', { afterWrite: true });
  assert.equal(ok(result).outcome, 'unknown');
  assert.deepEqual(edited.usage, { 'buy:1007': '10' });
  await assertPersisted(f, id, edited, 'unknown', 1);
  const next = f.make();
  assert.equal((await next.prepare('buy', input)).code, 'RANCH_RESULT_UNCONFIRMED');
  assert.equal(f.writes, 1);
}));

test('a proven unsent buy refunds its reservation on the latest policy ledger', () => withFixture(async f => {
  const id = await prepare(f);
  const { result, edited } = await saveWhilePaused(f, id, 'BuyGoods', {
    failure: Object.assign(new Error('synthetic budget rejection'), { isGovernedRejection: true }),
  });
  assert.equal(ok(result).outcome, 'not_sent');
  assert.deepEqual(edited.usage, { 'buy:1007': '10' });
  assert.equal(f.calls.filter(method => method === 'BuyGoods').length, 1);
  await assertPersisted(f, id, { ...edited, usage: { 'buy:1007': '0' } }, 'not_sent', 0);
}));
