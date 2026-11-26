const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

const testData = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-farm-sweet-potato-trade-'));
process.env.FARM_DATA_DIR = testData;
test.after(() => fs.rmSync(testData, { recursive: true, force: true }));

const { getRoot, loadProto } = require('../src/utils/proto');

test('regular and golden crops are mapped and event currencies stay out of automatic sales', () => {
  const config = require('../src/config/gameConfig');
  const seed = config.getPlantBySeedId(20307);
  assert.equal(seed.id, 1020307);
  assert.equal(seed.size, 1);
  assert.equal(seed.fruit.id, 40307);
  assert.equal(config.getItemById(20307).type, 5);
  assert.equal(config.getItemById(40307).type, 6);
  assert.equal(config.getPlantByFruitId(1040307).id, 1120307);
  assert.equal(config.getItemById(1040307).name, '黄金·红薯');
  for (const id of [1032, 1033]) {
    const item = config.getItemById(id);
    assert.equal(item.auto_sell, false);
    assert.equal(Boolean(item.sells), false);
  }
});

async function fixture() {
  await loadProto();
  const type = suffix => getRoot().lookupType(`gamepb.activitypb.sweetpotato.${suffix}`);
  const calls = [];
  const state = { available: true, seedsClaimed: false, pendingDividend: 19 };
  const responses = {
    91: { seeds: { grant: { item_id: 20307, count: 28 } } },
    92: { quote: { accepts_sales: true, price: { base: 111, bonus: 33, remaining: 8000, shop: { owner: 42 } } } },
    93: { sale: { count: 2, unit_price: 144, proceeds: 288, balance: 7288 } },
    95: { records: { rows: [{ count: 2, proceeds: 288, dividend: 5 }] } },
    96: { exchange: { unit_price: 7000, balance: 0, grant: { item_id: 80001, count: 1 } } },
    97: { catalog: { rows: [{ index: 10, unit_price: 7000, limit: 3 }] } },
    99: { dividend: { amount: 19, balance: 7019 } },
  };
  const filename = path.resolve(__dirname, '../src/services/sweet-potato-trade.js');
  const realRequire = createRequire(filename);
  const context = { exports: {} };
  const overrides = {
    './activity': {
      getSweetPotatoActivity: async () => ({ available: state.available, personal: state }),
      sweetPotatoOutsideWindow: () => !state.available,
    },
    '../utils/network': {
      getUserState: () => ({ gid: 42 }),
      sendMsgAsync: async (service, method, bytes) => {
        assert.equal(service, 'gamepb.activitypb.ActivityService');
        assert.equal(method, 'Operate');
        const data = type('TradeRequest').decode(bytes);
        calls.push(data);
        const body = type('TradeReply').encode({ id: 2026111708, command: data.command, ...responses[data.command] }).finish();
        state.onReply?.(data.command);
        return { body };
      },
    },
    './warehouse': {
      getBag: async () => [{ id: 1032, count: 2 }, { id: 1033, count: 7000 }],
      getBagItems: bag => bag,
      invalidatePanelBagCache: () => {},
    },
    './friend-api': { getAllFriends: async () => ({ game_friends: [{ gid: 43 }] }) },
    '../utils/utils': { log: () => {} },
  };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module: context,
    require: name => Object.hasOwn(overrides, name) ? overrides[name] : realRequire(name),
  }, { filename });
  return { run: context.exports.runSweetPotatoTrade, calls, responses, state };
}

test('actual wire codec sends one quote and one matching sale after checking the confirmed amount', async () => {
  const f = await fixture();
  const snapshot = await f.run('quote');
  assert.equal(snapshot.quote.unitPrice, 144);
  assert.equal(snapshot.stock.potatoes, 2);
  const receipt = await f.run('sale', { shop: 42, unitPrice: 144, count: 2, potatoes: 2 });
  assert.equal(receipt.proceeds, 288);
  const writes = f.calls.filter(x => x.command === 93);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].sale.count.toNumber(), 2);
});

test('changed price, missing acceptance and unlisted shops cannot submit a sale', async () => {
  const f = await fixture();
  await assert.rejects(f.run('sale', { shop: 42, potatoes: 2, count: 1, unitPrice: 145 }), /价格或收购额度/);
  delete f.responses[92].quote.accepts_sales;
  await assert.rejects(f.run('sale', { shop: 42, potatoes: 2, count: 1, unitPrice: 144 }), /价格或收购额度/);
  await assert.rejects(f.run('quote', { shop: 999 }), /当前账号的好友列表/);
  assert.deepEqual(f.calls.map(row => row.command), [92, 92]);
});

test('an account connection replaced during the quote cannot submit the sale', async () => {
  const f = await fixture();
  let current = true;
  f.state.onReply = command => { if (command === 92) current = false; };
  await assert.rejects(
    f.run('sale', { shop: 42, potatoes: 2, count: 1, unitPrice: 144 }, () => current),
    /账号连接已变化/,
  );
  assert.deepEqual(f.calls.map(row => row.command), [92]);
});

test('catalogue admits only identified prices, and exchanges require the expected item and quantity', async () => {
  const f = await fixture();
  const current = await f.run('catalog');
  assert.equal(current.catalog[0].itemId, 80001);
  const response = await f.run('exchange', { index: 10, count: 1, unitPrice: 7000, coins: 7000 });
  assert.equal(response.reward.itemId, 80001);
  assert.equal(response.balance, 0);
  f.responses[97].catalog.rows[0].unit_price = 6500;
  await assert.rejects(f.run('exchange', { index: 10, count: 1, unitPrice: 6500, coins: 7000 }), /价格或余量/);
  assert.equal(f.calls.filter(x => x.command === 96).length, 1);
});

test('claim and records use distinct, verified receipts and activity availability gates all requests', async () => {
  const f = await fixture();
  assert.equal((await f.run('seeds')).count, 28);
  assert.equal((await f.run('dividend')).amount, 19);
  assert.equal((await f.run('records'))[0].dividend, 5);
  f.state.available = false;
  await assert.rejects(f.run('catalog'), /状态不可用/);
  assert.deepEqual(f.calls.map(row => row.command), [91, 99, 95]);
});
