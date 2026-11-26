const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createSweetPotatoAutomation } = require('../src/services/sweet-potato-automation');

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'farm-sweet-potato-auto-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const state = {
    now: Date.parse('2026-11-26T06:00:00Z'), allowed: true, open: true, reads: 0, clear: 0, writes: [], logs: [],
    board: { available: true, personal: { seedsClaimed: false, pendingDividend: 0, coinBalance: 0 } },
    bag: { seeds: 0, potatoes: 0, coins: 0, selected: 0 }, field: { empty: [], planted: [], ready: [] },
    quote: { acceptsSales: true, unitPrice: 2, remaining: 8000 },
    catalog: [{ index: 10, itemId: 80001, unitPrice: 7000, limit: 2 }],
  };
  const trade = {
    getSweetPotatoInventory: async () => ({ ...state.bag }),
    getOwnSweetPotatoQuote: async () => state.quote,
    getSweetPotatoCatalog: async () => state.catalog,
    getSweetPotatoRewardId: () => 80001,
    runSweetPotatoTrade: async (action, input, check, persisted) => {
      state.beforeWrite?.();
      check();
      persisted();
      if (state.reject) throw state.reject;
      state.writes.push({ action, input });
      if (action === 'seeds') state.board.personal.seedsClaimed = true;
      if (action === 'plantCrop') {
        state.field.empty = state.field.empty.filter(id => id !== input.landId);
        state.field.planted.push(input.landId);
      }
      if (action === 'harvestCrop') state.field.ready = state.field.ready.filter(id => id !== input.landId);
      if (action === 'sale') state.bag.potatoes -= input.count;
      if (action === 'exchange') state.bag.coins -= input.unitPrice;
      return { cost: action === 'exchange' ? input.unitPrice : 0 };
    },
  };
  const spawn = () => createSweetPotatoAutomation({
    file: () => path.join(directory, 'state.json'), now: () => state.now, allowWindow: () => state.open,
    activity: async () => { state.reads++; return state.board; }, plots: async () => state.field, trade,
    observe: (action, result) => state.logs.push([action, result]),
  });
  const engine = spawn();
  return { state, engine, spawn, run: (runner = engine) => runner.tick(() => state.allowed, () => state.clear++) };
}

test('disabled and paused sessions make no upstream reads, and enabling takes a confirmed daily claim once', async t => {
  const f = fixture(t);
  await f.run();
  assert.equal(f.state.reads, 0);
  f.engine.update({ enabled: true });
  f.state.allowed = false;
  await f.run();
  assert.equal(f.state.reads, 0);
  f.state.allowed = true;
  await f.run();
  assert.deepEqual(f.state.writes.map(x => x.action), ['seeds']);
  assert.equal(f.state.clear, 1);
  await f.run();
  assert.equal(f.state.reads, 1);
  f.state.now += 30000;
  await f.run();
  assert.equal(f.state.writes.length, 1);
  f.state.open = false;
  f.state.now += 600000;
  await f.run();
  assert.equal(f.state.reads, 2);
});

test('auto-growing harvests only eligible sweet potatoes and sows one available empty plot', async t => {
  const f = fixture(t);
  f.engine.update({ enabled: true, claim: false, grow: true });
  f.state.field = { ready: [5], empty: [2], planted: [5] };
  f.state.bag.seeds = 4;
  await f.run();
  f.state.now += 30000;
  await f.run();
  assert.deepEqual(f.state.writes, [
    { action: 'harvestCrop', input: { landId: 5 } },
    { action: 'plantCrop', input: { landId: 2 } },
  ]);
});

test('selling preserves inventory and explicit order cap, while exchange honors budget across worker reload', async t => {
  const f = fixture(t);
  f.engine.update({ enabled: true, claim: false, sell: true, keepPotatoes: 3, saleBatch: 2 });
  f.state.bag.potatoes = 10;
  await f.run();
  assert.deepEqual(f.state.writes[0], { action: 'sale', input: { count: 2, unitPrice: 2, potatoes: 10 } });
  f.engine.update({ enabled: true, claim: false, exchangeIndex: 10, coinBudget: 10000, keepCoins: 3000 });
  f.state.bag.coins = 17000;
  await f.run();
  assert.equal(f.engine.status().spentToday, 7000);
  f.state.now += 30000;
  await f.run(f.spawn());
  assert.equal(f.state.writes.filter(x => x.action === 'exchange').length, 1);
});

test('a lost write receipt persists across restart, prevents replay and reconciles when the claim is observed', async t => {
  const f = fixture(t);
  f.engine.update({ enabled: true });
  f.state.reject = new Error('test missing response');
  await f.run();
  const next = f.spawn();
  assert.deepEqual(next.status().pending, ['seeds']);
  assert.throws(() => next.assertManualAllowed('seeds'), /待核对/);
  f.state.now += 300000;
  f.state.reject = null;
  await f.run(next);
  assert.equal(f.state.writes.length, 0);
  f.state.board.personal.seedsClaimed = true;
  f.state.now += 300000;
  await f.run(next);
  assert.deepEqual(next.status().pending, []);
  assert.deepEqual(f.state.logs, [['seeds', 'unknown'], ['seeds', 'reconciled']]);
});

test('disabling before dispatch stops the write, and proven governor rejection does not leave an unknown intent', async t => {
  const f = fixture(t);
  f.engine.update({ enabled: true });
  f.state.beforeWrite = () => f.engine.update({ enabled: false });
  await f.run();
  assert.deepEqual(f.state.writes, []);
  assert.deepEqual(f.engine.status().pending, []);
  f.engine.update({ enabled: true });
  f.state.beforeWrite = null;
  f.state.reject = Object.assign(new Error('local governor fixture'), { isGovernedRejection: true });
  await f.run();
  assert.deepEqual(f.engine.status().pending, []);
});
