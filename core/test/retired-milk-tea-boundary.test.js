'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const base = fs.realpathSync(os.tmpdir()), prefix = path.resolve(base, 'farm-retired-milk-boundary-');
assert.equal(path.dirname(prefix), base);
const data = fs.mkdtempSync(prefix), old = process.env.FARM_DATA_DIR;
process.env.FARM_DATA_DIR = data;
const savedOverrides = Object.fromEntries(['FARM_LOG_DIR', 'FARM_PRIVATE_CONFIG_FILE', 'FARM_ACCOUNT_ID'].map(key => [key, process.env[key]]));
const fixtureLogDir = path.resolve(data, 'logs'), fixtureConfig = path.resolve(data, 'private-config.json');
assert.equal(path.dirname(fixtureLogDir), path.resolve(data)); assert.equal(path.dirname(fixtureConfig), path.resolve(data));
process.env.FARM_LOG_DIR = fixtureLogDir; process.env.FARM_PRIVATE_CONFIG_FILE = fixtureConfig; process.env.FARM_ACCOUNT_ID = 'synthetic-qq-fixture';
const files = ['../src/services/activity', '../src/services/milk-tea-activity',
  '../src/controllers/admin-farm-resource-routes', '../src/runtime/data-provider', '../src/models/store'].map(require.resolve);
const before = files.map(p => [fs.readFileSync(p), fs.statSync(p).mode]);
test.after(() => {
  for (const [key, value] of Object.entries(savedOverrides)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  files.forEach((file, i) => { assert.deepEqual(fs.readFileSync(file), before[i][0]); assert.equal(fs.statSync(file).mode, before[i][1]); });
  if (old === undefined) delete process.env.FARM_DATA_DIR; else process.env.FARM_DATA_DIR = old;
  assert.equal(path.dirname(path.resolve(data)), base); fs.rmSync(data, { recursive: true, force: true });
});

test('current automation route rejects retired and mixed settings before persistence or broadcast', async () => {
  const store = require('../src/models/store');
  const accountId = 'synthetic-retired-settings';
  store.applyConfigSnapshot({ automation: { task: true, milk_tea_auto_rewards: true } }, { accountId, persist: false });
  const original = store.getConfigSnapshot(accountId);
  const routes = new Map(); let allowed = true; let revision = 0; let broadcasts = 0; let calls = 0;
  const provider = require('../src/runtime/data-provider').createDataProvider({ store, workers: {}, globalLogs: [], accountLogs: [],
    getAccounts: () => ({ accounts: [{ id: accountId }] }), nextConfigRevision: () => ++revision,
    broadcastConfigToWorkers: () => { broadcasts++; }, callWorkerApi: () => assert.fail('no game calls for retired settings'),
  });
  const setAutomation = provider.setAutomation;
  provider.setAutomation = (...args) => { calls++; return setAutomation(...args); };
  require('../src/controllers/admin-farm-resource-routes').registerAdminFarmResourceRoutes({
    app: { get() {}, post: (name, fn) => routes.set(name, fn) }, provider,
    getAccountIdFromRequest: () => accountId, canAccessAccount: () => allowed,
  });
  async function request(body) {
    const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; return this; } };
    await routes.get('/api/automation')({ body }, res);
    return res;
  }
  const persisted = () => fs.readdirSync(data).sort();
  const beforeFiles = persisted();
  for (const body of [
    { milk_tea_control: { milk_tea_auto_rewards: true } },
    { milk_tea_auto_rewards: false }, { milk_tea_seed_policy: {} },
    { task: false, milk_tea_control: { milk_tea_auto_rewards: false } },
    { milk_tea_auto_craft: true, task: false },
  ]) {
    const response = await request(body);
    assert.equal(response.statusCode, 410);
    assert.equal(response.body.code, 'ACTIVITY_RETIRED');
    assert.deepEqual(store.getConfigSnapshot(accountId), original, 'old settings remain compatible and unmodified');
    assert.deepEqual(persisted(), beforeFiles);
    assert.equal(calls, 0); assert.equal(revision, 0); assert.equal(broadcasts, 0);
  }
  allowed = false;
  assert.equal((await request({ milk_tea_control: {} })).statusCode, 403);
  assert.equal(calls, 0);
  allowed = true;
  const saved = await request({ task: false });
  assert.equal(saved.statusCode, 200); assert.equal(saved.body.ok, true);
  assert.equal(store.getAutomation(accountId).task, false);
  assert.equal(store.getAutomation(accountId).milk_tea_auto_rewards, true, 'retirement does not erase stored legacy state');
  assert.equal(calls, 1); assert.equal(revision, 1); assert.equal(broadcasts, 1);
});
test('public activity retains shared reads, exports no retired gameplay and never invokes the retired decoder', async () => {
  const { loadProto, types } = require('../src/utils/proto'); await loadProto();
  const networkPath = require.resolve('../src/utils/network'), activityPath = files[0], legacyPath = files[1];
  const saved = [networkPath, activityPath, legacyPath].map(p => [p, require.cache[p]]);
  let requests = 0, decodes = 0;
  const raw = types.MilkTeaGetGroupReply.encode(types.MilkTeaGetGroupReply.create({ group: {
    head: { activity_id: 2026110100 }, children: [{ head: { activity_id: 2026110101 }, milk_tea: { summary: { level: 2 } } }],
  } })).finish();
  const legacy = require('../src/services/milk-tea-activity');
  require.cache[legacyPath] = { id: legacyPath, filename: legacyPath, loaded: true, exports: { ...legacy,
    normalizeMilkTeaDiscovery(...args) { decodes++; return legacy.normalizeMilkTeaDiscovery(...args); },
  } };
  require.cache[networkPath] = { id: networkPath, filename: networkPath, loaded: true, exports: {
    sendMsgAsync: async (_service, method) => { requests++; assert.equal(method, 'GetGroup', 'no game writes permitted'); return { body: raw }; },
  } };
  delete require.cache[activityPath];
  try {
    const shared = require('../src/services/activity');
    let privateBody;
    const snapshot = await shared.getActivityGroupSnapshot(2026110100, '', { onRawBody: value => { privateBody = value; } });
    assert.equal(decodes, 0, 'ordinary discovery must not invoke retired dedicated decoding');
    assert.equal(requests, 1); assert.ok(Buffer.from(raw).equals(privateBody));
    assert.doesNotMatch(JSON.stringify(snapshot), /rawBody|"type":"Buffer"/);
    for (const name of Object.keys(legacy)) assert.equal(Object.hasOwn(shared, name), false, `retired export ${name}`);
    for (const name of ['getActivityGroupSnapshot', 'getActivityDiscoveryList', 'getBagItemCounts']) assert.equal(typeof shared[name], 'function');
  } finally { for (const [p, entry] of saved) { if (entry) require.cache[p] = entry; else delete require.cache[p]; } }
});
