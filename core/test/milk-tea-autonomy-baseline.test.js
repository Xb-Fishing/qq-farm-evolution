'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const root = fs.realpathSync(os.tmpdir());
const prefix = path.resolve(root, 'milk-autonomy-');
assert.equal(path.dirname(prefix), root);
const data = fs.mkdtempSync(prefix);
process.env.FARM_DATA_DIR = data;
const sourceFiles = ['../src/services/milk-tea-activity.js', '../src/models/store.js', '../src/core/worker.js'].map(rel => path.resolve(__dirname, rel));
const fingerprints = () => sourceFiles.map(file => [fs.statSync(file).mode, crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')]);
const before = fingerprints();
function fixturePath(relative) {
  const target = path.resolve(data, relative);
  assert.ok(target === data || target.startsWith(data + path.sep), 'fixture write boundary');
  return target;
}
test.after(() => { assert.deepEqual(fingerprints(), before); fs.rmSync(data, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); });
const proto = require('../src/utils/proto');
let ordinal = 0;
async function fixture(flags = {}) {
  await proto.loadProto();
  const id = `synthetic-autonomy-${++ordinal}`;
  process.env.FARM_ACCOUNT_ID = id;
  const store = require('../src/models/store');
  const auto = { milk_tea_auto_rewards: false, milk_tea_auto_seeds: false, milk_tea_auto_work: false, milk_tea_auto_upgrade: false,
    milk_tea_work_interaction_type: 1,
    milk_tea_seed_policy: { targetSeedIds: [20525], targetStock: 24, coinReserve: '1000000', coinDailyLimit: '240000', ticketReserve: '8000', ticketDailyLimit: '0' }, ...flags };
  store.applyConfigSnapshot({ automation: auto }, { persist: false, accountId: id });
  const clock = { now: Date.parse('2026-10-29T10:00:00Z') };
  const socket = {}; const calls = []; const requests = [];
  const summary = { shopOpenAt: 1792029600, level: 1, canUpgrade: true, hasUnclaimedWage: true, hasUnclaimedWageKnown: true };
  const goods = { id: 301, rewards: [{ id: 20525, count: '1' }], costs: [{ id: 1001, count: '10000' }],
    purchaseLimit: 100, purchasedCount: 0, purchaseLimitKnown: true, purchasedCountKnown: true, automaticPurchaseDataComplete: true, diamondCostCount: 0, condHints: [] };
  const work = { interact_done: false, my_shift: { shift_id: '7001', employer: { gid: '9001' }, end_at: 1793275200,
    interact_count: 0, interact_limit: 1, interact_previews: [{ interaction_type: 1 }, { interaction_type: 2 }] } };
  const bag = [{ id: 1001, count: '2000000', uid: '1' }, { id: 1041, count: '16000', uid: '2' }];
  const paths = ['../src/utils/network', '../src/services/warehouse', '../src/services/milk-tea-activity'].map(name => require.resolve(name));
  const previous = paths.map(file => [file, require.cache[file]]);
  let unknown = 0; let responseChange = null; let readHook = null;
  const network = { getWs: () => socket, networkEvents: new (require('node:events').EventEmitter)(), getUserState: () => ({}), isConnected: () => true, sendMsgAsync: async (_service, method, body) => {
    calls.push(method);
    if (method === 'Bag') {
      if (readHook) await readHook('bag');
      return { body: proto.types.BagReply.encode({ item_bag: { items: bag } }).finish() };
    }
    assert.equal(method, 'Operate');
    const req = proto.types.MilkTeaOperateRequest.decode(body); const cmd = Number(req.operate_type); calls.push(cmd); requests.push(req);
    if (readHook && [55, 63].includes(cmd)) await readHook(cmd);
    if (unknown === cmd) throw new Error('synthetic unknown transport result');
    const replies = { 63: { milk_tea_get_work_page: work }, 55: { milk_tea_get_shop: { shop: { cashier_capacity_sec: 172800, cashier_elapsed_sec: 0 } } },
      64: { milk_tea_claim_wages: { claimed_count: 1, items: [{ id: 1041, count: 10 }] } },
      65: { milk_tea_interact: { success: false } }, 61: { milk_tea_upgrade: { level: summary.level + 1 } },
      1: { shop_buy: { awards: goods.rewards.map(row => ({ id: row.id, count: (BigInt(row.count) * BigInt(req.shop_buy?.count || 1)).toString() })) } } };
    let reply = { activity_id: req.activity_id, operate_type: cmd, ...replies[cmd] };
    if (responseChange) reply = responseChange(cmd, reply) || reply;
    return { body: proto.types.MilkTeaOperateReply.encode(reply).finish() };
  } };
  require.cache[paths[0]] = { exports: network }; delete require.cache[paths[1]]; delete require.cache[paths[2]];
  let service = require(paths[2]);
  const deps = { now: () => clock.now, getAutomation: () => store.getAutomation(id), isReady: () => true, getConnection: () => socket,
    getActivityDiscoveryList: async () => { calls.push('List'); if (readHook) await readHook('list'); return [{ id: 2026110100, parentId: 0, enabled: true, startTime: 1792029600, endTime: 1794844799 }]; },
    getActivityGroupSnapshot: async () => { calls.push('Group'); if (readHook) await readHook('group'); return { id: 2026110100, startTime: 1792029600, endTime: 1794844799,
      children: [{ id: 2026110101, details: { milkTea: summary } }, { id: 2026110102, details: { exchangeShop: { items: [goods] } } }] }; },
  };
  return { get service() { return service; }, deps, auto, summary, work, goods, bag, calls, requests, clock,
    writes: () => calls.filter(value => typeof value === 'number' && ![55, 63].includes(value)),
    setFlags: patch => store.applyConfigSnapshot({ automation: patch }, { persist: false, accountId: id }),
    unknown: cmd => { unknown = cmd; }, response: fn => { responseChange = fn; }, hook: fn => { readHook = fn; },
    journal: () => fixturePath(`milk-tea-auto-${id}.json`),
    reload: () => { delete require.cache[paths[2]]; service = require(paths[2]); return service; },
    tick: async () => { clock.now += 16 * 60000; return service.runAutomaticMilkTea(deps); },
    close: () => { for (const [file, entry] of previous) { if (entry) require.cache[file] = entry; else delete require.cache[file]; } },
  };
}
module.exports = { fixture, fixturePath, data, proto };
if (require.main === module) {
  for (const [flag, expected] of [['milk_tea_auto_work', 64], ['milk_tea_auto_upgrade', 61], ['milk_tea_auto_seeds', 1]]) {
    test(`existing automatic entry executes independently enabled ${flag} with ordinary rewards off`, async () => {
      const f = await fixture({ [flag]: true });
      try { await f.service.runAutomaticMilkTea(f.deps); assert.ok(f.writes().includes(expected), `expected existing action ${expected} through the automatic entry`); }
      finally { f.close(); }
    });
  }
}
