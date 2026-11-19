'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const temp = fs.realpathSync(os.tmpdir());
const repo = fs.realpathSync(path.join(__dirname, '../..'));
assert.ok(temp !== repo && !temp.startsWith(repo + path.sep));
const prefix = path.resolve(temp, 'farm-ranch-admission-');
assert.equal(path.dirname(prefix), temp);
const root = fs.mkdtempSync(prefix);
function fixturePath(name) {
  const target = path.resolve(root, name);
  assert.equal(path.dirname(target), root);
  return target;
}
process.env.FARM_DATA_DIR = root;
process.env.FARM_PRIVATE_CONFIG_FILE = fixturePath('private-config.json');
process.env.FARM_LOG_DIR = fixturePath('logs');
process.env.FARM_SESSION_LOG_DIR = fixturePath('session-logs');
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

const codec = require('../src/services/ranch-codec');
const { createRanchService } = require('../src/services/ranch-service');
const { createGameSceneCoordinator, SCENE_METHOD, SCENE_SERVICE } = require('../src/runtime/game-scene-coordinator');

const facility = { instance_id: '11', facility_id: 6001001, module_type: 6, state: 1, level: 1, capacity: 3,
  ranch: { ranch_inst_id: '11', capacity: 3, animal_count: 1, husbandry_type: 1,
    animals: [{ ranch_inst_id: '11', animal_inst_id: 7, animal_id: '60001', can_deliver: true }] } };
const cells = { grid_width: 10, grid_height: 10, facilities: [facility] };
const replies = {
  AllCells: cells,
  GetBag: { global_scene_id: 2, physical_items: [], virtual_items: [{ id: '1007', count: '50000' }, { id: '1102', count: '40000' }] },
  ShopProfiles: { shop_profiles: [{ shop_id: 5, global_scene_ids: [2] }] },
  ShopInfo: { goods_list: [{ id: '10002', item_id: '60001', item_count: '1', price: '10', unlocked: true }] },
  TaskInfo: { task_info: { growth_tasks: [{ id: '31', task_type: 4, is_unlocked: true, progress: '1', total_progress: '1' }] } },
  GetFacilityDetail: { info: { instance_id: facility.instance_id, facility_id: facility.facility_id, module_type: facility.module_type,
    level: facility.level, upgrade_cost: [{ id: '1007', count: '14000' }] } },
};
let nextLedger = 0;
function fixture({ embedded = false } = {}) {
  const identity = { key: 'fixture-login', connected: true, level: 30, revision: 1 };
  const calls = []; const ws = {};
  const totalMs = 1000;
  const f = { identity, calls, totalMs, time: 1800000000000, urgent: false, windowCount: 0, totalLimit: 80,
    perMethodLimit: 4, restoresToReject: 0 };
  const scene = createGameSceneCoordinator({
    now: () => f.time, totalMs, identity: () => identity, priority: () => f.urgent,
    profile: () => ({ totalLimit: f.totalLimit, windowCount: f.windowCount, perMethodLimit: f.perMethodLimit,
      top: [{ method: `${SCENE_SERVICE}.${SCENE_METHOD}`, count: 1 }] }),
    encodeScene: id => codec.encode('PlayerSceneLoginRequest', { global_scene_id: id }),
    decodeScene: body => codec.decode('PlayerSceneLoginReply', body),
    send: async (service, method, body, _timeout, _extra, restoring) => {
      if (method === SCENE_METHOD) {
        const id = codec.decode('PlayerSceneLoginRequest', body).global_scene_id;
        assert.equal(service, SCENE_SERVICE);
        assert.equal(restoring, id === 1);
        calls.push(id);
        if (id === 1 && f.restoresToReject > 0) {
          f.restoresToReject--;
          throw new Error('synthetic first restoration failure');
        }
        const ranchData = codec.encode('SceneData', embedded ? { homestead_cells: cells } : {});
        return { body: codec.encode('PlayerSceneLoginReply', { global_scene_id: id,
          ...(id === 1 ? { farm_scene_ext_data: Buffer.from([1]) } : { big_farm_scene_ext_data: ranchData.length ? ranchData : Buffer.from([8, 1]) }) }) };
      }
      calls.push(method);
      const route = Object.values(codec.ROUTES).find(route => route.service === service && route.method === method);
      assert.ok(route && !route.writing && Object.hasOwn(replies, method), `unexpected synthetic dispatch: ${method}`);
      codec.decode(route.request, body);
      if (f.readFailure) throw f.readFailure;
      return { body: codec.encode(route.reply, replies[method]) };
    },
  });
  const ledger = fixturePath(`operations-${++nextLedger}.json`);
  const network = { getWs: () => ws, isConnected: () => identity.connected, getUserState: () => ({ gid: 42 }),
    withRanchScene: scene.run, sendMsgAsync: scene.send };
  return Object.assign(f, { scene, service: createRanchService({ network, file: () => ledger, now: () => f.time }) });
}

const views = {
  animals: { action: 'produce', input: { all: true }, extraReads: [] },
  tasks: { action: 'claimTasks', input: { all: true }, extraReads: ['TaskInfo'] },
  shop: { action: 'buy', input: { shopId: '5', goodsId: '10002', count: 1 }, extraReads: ['ShopProfiles', 'ShopInfo'] },
};
async function checkAdmission(fn, expected) {
  const f = fixture();
  f.windowCount = 17;
  f.totalLimit = f.windowCount + expected.length + 8 - 1;
  const denied = await fn(f.service);
  assert.equal(denied.code, 'RANCH_BUDGET_BUSY');
  assert.deepEqual(f.calls, []);
  f.totalLimit++;
  f.perMethodLimit--;
  assert.equal((await fn(f.service)).code, 'RANCH_BUDGET_BUSY');
  assert.deepEqual(f.calls, []);
  f.perMethodLimit++;
  f.restoresToReject = 1;
  const admitted = await fn(f.service);
  assert.equal(admitted.ok, true, admitted.error);
  assert.equal(admitted.data.sceneRecoveryRequired, false);
  assert.deepEqual(f.calls, expected);
  assert.equal(f.scene.snapshot().scene, 1);
}

for (const [view, { action, input, extraReads }] of Object.entries(views)) {
  const expected = [2, 'AllCells', 'GetBag', ...extraReads, 1, 1];
  test(`${view} state uses its bounded lease, including AllCells and both restores`, async () => {
    await checkAdmission(service => service.getState(view), expected);
  });
  test(`${action} prepare uses the ${view} lease without economic sends`, async () => {
    await checkAdmission(service => service.prepare(action, input), expected);
  });
}
test('upgrade prepare reserves one extra facility detail call', async () => {
  await checkAdmission(service => service.prepare('upgrade', { facilityId: '11' }),
    [2, 'AllCells', 'GetBag', 'GetFacilityDetail', 1, 1]);
});
test('embedded homestead cells need no additional AllCells request', async () => {
  const f = fixture({ embedded: true });
  assert.equal((await f.service.getState('animals')).ok, true);
  assert.deepEqual(f.calls, [2, 'GetBag', 1]);
});

async function fillLease(f) {
  for (const method of ['AllCells', 'GetBag']) {
    const route = Object.values(codec.ROUTES).find(route => route.method === method);
    await f.scene.send(route.service, method, codec.encode(route.request, {}));
  }
}
test('full lease allows a final ownership assertion and rejects an extra send before dispatch', async () => {
  const f = fixture();
  f.restoresToReject = 1;
  const value = await f.scene.run(async ({ assertCurrent }) => {
    await fillLease(f);
    assert.doesNotThrow(assertCurrent);
    const route = codec.ROUTES.bag;
    await assert.rejects(f.scene.send(route.service, route.method, codec.encode(route.request, {})), { code: 'RANCH_REQUEST_BOUND' });
    assert.doesNotThrow(assertCurrent);
    return { finished: true };
  }, { maxCalls: 5 });
  assert.equal(value.finished, true);
  assert.deepEqual(f.calls, [2, 'AllCells', 'GetBag', 1, 1]);
});

for (const [label, code, invalidate] of [
  ['login key', 'RANCH_SESSION_CHANGED', f => { f.identity.key = 'replacement-login'; }],
  ['revision', 'RANCH_SETTINGS_CHANGED', f => { f.identity.revision++; }],
  ['priority', 'RANCH_FARM_PRIORITY', f => { f.urgent = true; }],
  ['deadline', 'RANCH_FARM_PRIORITY', f => { f.time += f.totalMs; }],
]) {
  test(`${label} still invalidates ownership at full capacity`, async () => {
    const f = fixture();
    await assert.rejects(f.scene.run(async ({ assertCurrent }) => {
      await fillLease(f);
      invalidate(f);
      assertCurrent();
    }, { maxCalls: 5 }), { code });
    assert.deepEqual(f.calls, [2, 'AllCells', 'GetBag', ...(label === 'login key' ? [] : [1])]);
  });
}

test('execute still reserves ten calls and binds a zero-dispatch budget rejection to the prepared quote', async () => {
  const f = fixture();
  const quote = await f.service.prepare('buy', views.shop.input);
  assert.equal(quote.ok, true, quote.error);
  f.calls.length = 0;
  f.totalLimit = 17;
  const denied = await f.service.execute(quote.data.id);
  assert.equal(denied.code, 'RANCH_BUDGET_BUSY');
  assert.equal(denied.operationNotSent, true);
  assert.equal(denied.quoteId, quote.data.id);
  assert.deepEqual(f.calls, []);
  f.totalLimit++;
  f.readFailure = Object.assign(new Error('synthetic read timeout'), { code: 'LOCAL_REQUEST_TIMEOUT', operationNotSent: true, quoteId: quote.data.id });
  const timeout = await f.service.execute(quote.data.id);
  assert.equal(timeout.ok, false);
  assert.equal(timeout.operationNotSent, undefined);
  assert.equal(timeout.quoteId, undefined);
  assert.deepEqual(f.calls, [2, 'AllCells', 1]);
});

test('pre-write governed errors bind only execute proof and preserve a failed restoration flag', async () => {
  const f = fixture();
  const quote = await f.service.prepare('buy', views.shop.input);
  assert.equal(quote.ok, true, quote.error);
  f.readFailure = Object.assign(new Error('synthetic governed rejection'), {
    code: 'RANCH_BUDGET_BUSY', isGovernedRejection: true,
  });
  assert.equal((await f.service.getState()).operationNotSent, undefined);
  f.calls.length = 0;
  f.restoresToReject = 2;
  const result = await f.service.execute(quote.data.id);
  assert.equal(result.ok, false);
  assert.equal(result.operationNotSent, true);
  assert.equal(result.quoteId, quote.data.id);
  assert.equal(result.sceneRecoveryRequired, true);
  assert.deepEqual(f.calls, [2, 'AllCells', 1, 1]);
});
