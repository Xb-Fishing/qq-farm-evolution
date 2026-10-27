'use strict';
const { test, before, after } = require('node:test'); const assert = require('node:assert/strict');
const fs = require('node:fs'); const path = require('node:path'); const vm = require('node:vm'); const os = require('node:os');
const tmp = path.resolve(process.env.FARM_LOG_HISTORY_TEST_DIR || os.tmpdir());
const fixture = fs.mkdtempSync(path.join(tmp, 'own-quiet-wire-'));
process.env.FARM_DATA_DIR = fixture; process.env.FARM_ACCOUNT_ID = 'synthetic-quiet-wire';
after(() => { assert.equal(path.dirname(fixture), tmp); fs.rmSync(fixture, { recursive: true, force: true }); });
const proto = require('../src/utils/proto'); const { install, admits } = require('../src/runtime/own-quiet-wire');
const store = require('../src/models/store'); const priority = require('../src/services/own-quiet-priority');
before(() => proto.loadProto());
const plantService = 'gamepb.plantpb.PlantService';
const marker = (phase = 'harvest') => ({ version: 1, phase, accountId: process.env.FARM_ACCOUNT_ID, landIds: [1, 2] });
const encode = (type, value) => proto.types[type].encode(proto.types[type].create(value)).finish();
function allow(service, method, type, value, scope = marker()) {
  return admits({ service, method, body: encode(type, value), marker: scope, types: proto.types, ownGid: 42, accountId: process.env.FARM_ACCOUNT_ID });
}
function harness() {
  const source = fs.readFileSync(path.join(__dirname, '../src/utils/network.js'), 'utf8');
  const take = name => { const begin = new RegExp(`(?:async )?function ${name}\\(`).exec(source).index; return source.slice(begin, source.indexOf('\n}', begin) + 2); };
  let paused = 60_000; let sent = 0; let governed = 0; let recorded = 0; let release;
  const hostStore = { getWirePauseRemainMs: () => paused };
  const context = vm.createContext({ process: { env: { FARM_ACCOUNT_ID: process.env.FARM_ACCOUNT_ID } },
    getStoreModule: () => hostStore, ws: { readyState: 1, send() { sent++; } }, WebSocket: { OPEN: 1 },
    clientSeq: 1, pendingCallbacks: new Map(), encodeMsg: () => new Promise(resolve => { release = resolve; }),
    requestGovernor: { checkRequest: () => { governed++; return { allowed: true }; }, recordSent() { recorded++; } },
    networkScheduler: { setTimeoutTask() {}, clear() {} }, isConnected: () => true, log() {},
    GOVERNED_BUDGET_REASONS: new Set(), sessionTransportHooks: null,
  });
  vm.runInContext(['sessionAuthorityError', 'businessPauseError', 'sendMsg', 'sendMsgAsync'].map(take).join('\n'), context);
  const network = { sendMsgAsync: context.sendMsgAsync, getUserState: () => ({ gid: 42 }) };
  const native = network.sendMsgAsync; install({ network, store: hostStore, types: proto.types, accountId: process.env.FARM_ACCOUNT_ID });
  return { network, native, context, hostStore, counters: () => ({ sent, governed, recorded }),
    release() { release(Buffer.from('encoded')); }, pause(value) { paused = value; } };
}

test('decoded allowlist rejects stealing, unrelated land, shop, purchase, bad markers and malformed protobuf', () => {
  assert.equal(allow(plantService, 'Harvest', 'HarvestRequest', { host_gid: 42, land_ids: [1] }), true);
  for (const value of [{ host_gid: 99, land_ids: [1] }, { host_gid: 0, land_ids: [1] }, { host_gid: 42, land_ids: [3] }]) {
    assert.equal(allow(plantService, 'Harvest', 'HarvestRequest', value), false);
  }
  assert.equal(allow(plantService, 'AllLands', 'AllLandsRequest', {}, marker('snapshot')), true);
  assert.equal(allow(plantService, 'AllLands', 'AllLandsRequest', { host_gid: 99 }), false);
  assert.equal(allow(plantService, 'RemovePlant', 'RemovePlantRequest', { land_ids: [1] }, marker('replant')), true);
  assert.equal(allow(plantService, 'Plant', 'PlantRequest', { items: [{ seed_id: 20001, land_ids: [1] }] }, marker('replant')), true);
  assert.equal(allow(plantService, 'Plant', 'PlantRequest', { items: [{ seed_id: 20001, land_ids: [3] }] }, marker('replant')), false);
  const shop = 'gamepb.shoppb.ShopService';
  assert.equal(allow(shop, 'ShopInfo', 'ShopInfoRequest', { shop_id: 3 }, marker('replant')), false);
  assert.equal(allow(shop, 'ShopInfo', 'ShopInfoRequest', { shop_id: 2 }, marker('replant')), true);
  const planned = { ...marker('replant'), purchase: { seedId: 20001, goodsId: 10, count: 2, price: 5 } };
  assert.equal(allow(shop, 'BuyGoods', 'BuyGoodsRequest', { goods_id: 10, num: 2, price: 5 }, planned), true);
  assert.equal(allow(shop, 'BuyGoods', 'BuyGoodsRequest', { goods_id: 11, num: 2, price: 5 }, planned), false);
  assert.equal(allow(plantService, 'Harvest', 'HarvestRequest', { host_gid: 42, land_ids: [1] }, { ...marker(), version: 2 }), false);
  assert.equal(admits({ service: plantService, method: 'Harvest', body: Buffer.from([255]), marker: marker(), types: proto.types, ownGid: 42, accountId: process.env.FARM_ACCOUNT_ID }), false);
});
test('actual pre/post-encoding gates exempt only scoped own request; concurrent friend remains paused', async () => {
  const h = harness(); const body = encode('HarvestRequest', { host_gid: 42, land_ids: [1] });
  const own = h.network.sendMsgAsync(plantService, 'Harvest', body, 20000, { ownFarmQuietPriority: marker() });
  assert.equal(h.hostStore.getWirePauseRemainMs(process.env.FARM_ACCOUNT_ID), 60_000);
  await assert.rejects(h.network.sendMsgAsync(plantService, 'Harvest', encode('HarvestRequest', { host_gid: 99, land_ids: [1] })), { code: 'LOCAL_BUSINESS_PAUSED' });
  await assert.rejects(h.network.sendMsgAsync('gamepb.visitpb.VisitService', 'Enter', Buffer.alloc(0), 1, { ownFarmQuietPriority: marker() }), { code: 'LOCAL_BUSINESS_PAUSED' });
  assert.deepEqual(h.counters(), { sent: 0, governed: 1, recorded: 0 });
  h.release(); await new Promise(resolve => setImmediate(resolve)); assert.equal(h.counters().sent, 1);
  [...h.context.pendingCallbacks.values()][0](null, Buffer.alloc(0), { error_code: 0 }); await own;
  assert.deepEqual(h.counters(), { sent: 1, governed: 1, recorded: 1 });
  assert.equal(h.hostStore.getWirePauseRemainMs(process.env.FARM_ACCOUNT_ID), 60_000);
});
test('original session authority and hard budgets still reject the exempt request', async () => {
  const h = harness(); const args = [plantService, 'Harvest', encode('HarvestRequest', { host_gid: 42, land_ids: [1] }), 1, { ownFarmQuietPriority: marker() }];
  h.context.sessionTransportHooks = { assertRequestAllowed() { throw Object.assign(new Error('retired'), { code: 'SESSION_EPOCH_RETIRED' }); } };
  // sessionAuthorityError calls the original authority hook, independent of quiet eligibility.
  h.context.sessionAuthorityError = () => Object.assign(new Error('retired'), { code: 'SESSION_EPOCH_RETIRED' });
  await assert.rejects(h.network.sendMsgAsync(...args), { code: 'SESSION_EPOCH_RETIRED' });
  h.context.sessionAuthorityError = () => null;
  h.context.requestGovernor.checkRequest = () => ({ allowed: false, reason: 'budget_total' });
  await assert.rejects(h.network.sendMsgAsync(...args), /budget_total/); assert.equal(h.counters().sent, 0);
});
test('business scope preserves unrelated options and rejects late or disabled work', async () => {
  store.applyConfigSnapshot({ automation: { farm: true, harvest: true, plant: true } }, { persist: false, accountId: process.env.FARM_ACCOUNT_ID });
  const network = require('../src/utils/network'); const previous = network.getUserState;
  network.getUserState = () => ({ gid: 42 });
  let late; let called = 0; let received;
  const send = priority.wrapSend(async (...args) => { called++; received = args; return 'same-value'; });
  try {
    await priority.run({ landIds: [1] }, async () => {
      assert.equal(await send(plantService, 'Harvest', encode('HarvestRequest', { host_gid: 42, land_ids: [1] }), 1234, { breakerExemptBusinessError: true }), 'same-value');
      late = () => send(plantService, 'Harvest', encode('HarvestRequest', { host_gid: 42, land_ids: [1] }));
      const { AsyncResource } = require('node:async_hooks'); late = AsyncResource.bind(late);
    });
    assert.equal(received[3], 1234); assert.equal(received[4].breakerExemptBusinessError, true);
    assert.equal(received[4].ownFarmQuietPriority.phase, 'harvest');
    await assert.rejects(late(), { code: 'OWN_PRIORITY_CANCELLED' }); assert.equal(called, 1);
  } finally { network.getUserState = previous; }
});
