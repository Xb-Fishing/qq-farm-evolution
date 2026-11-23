'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const prefix = path.resolve(fs.realpathSync(os.tmpdir()), 'farm-request-policy-');
assert.equal(path.dirname(prefix), fs.realpathSync(os.tmpdir()));
const root = fs.mkdtempSync(prefix); process.env.FARM_DATA_DIR = root;
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
const governor = require('../src/services/request-governor');
const { validateRequestPolicy } = require('../src/services/request-policy');
const store = require('../src/models/store');
const { createDataProvider } = require('../src/runtime/data-provider');
const { createRuntimeState } = require('../src/runtime/runtime-state');
const proto = require('../src/utils/proto');
test.before(() => proto.loadProto());
const policy = { enabled: true, total60s: 8, friend60s: 2, method60s: 5, rosterBonusPer100: 20 };
const at = 1700000000000;
test('friend aggregate and total budgets are independent and expire; disabling bypasses budgets and slowdown without erasing telemetry', () => {
  governor.resetForTest(); governor.configurePolicy(policy);
  const service = 'gamepb.visitpb.VisitService';
  governor.recordSent(service, 'Enter', true, at, { friend: true });
  assert.equal(governor.checkRequest(service, 'Enter', at, { friend: true }).allowed, true);
  governor.recordSent(service, 'Enter', true, at, { friend: true });
  assert.equal(governor.checkRequest(service, 'Enter', at, { friend: true }).reason, 'budget_friend');
  assert.equal(governor.checkRequest('gamepb.plantpb.PlantService', 'AllLands', at).allowed, true);
  for (let i = 0; i < 6; i++) governor.recordSent('synthetic.Service', 'Read', true, at);
  assert.equal(governor.checkRequest('synthetic.Other', 'Read', at).reason, 'budget_total');
  assert.equal(governor.checkRequest('gamepb.userpb.UserService', 'Heartbeat', at).allowed, true);
  governor.configurePolicy({ ...policy, enabled: false });
  assert.equal(governor.checkRequest(service, 'Enter', at, { friend: true }).reason, 'disabled');
  for (let i = 0; i < 15; i++) governor.recordSent(service, 'Enter', false, at, { friend: true });
  assert.equal(governor.getBreakerState(at).active, false);
  assert.equal(governor.getRequestProfile(at).windowCount, 23);
  governor.configurePolicy(policy);
  assert.equal(governor.checkRequest(service, 'Enter', at, { friend: true }).allowed, false);
  assert.equal(governor.checkRequest(service, 'Enter', at + 60001, { friend: true }).allowed, true);
  governor.resetForTest();
});
test('host-derived classification distinguishes own land from friends and cannot be bypassed by an undecodable target', () => {
  const body = id => proto.types.WaterLandRequest.encode({ host_gid: id, land_ids: [1] }).finish();
  const service = 'gamepb.plantpb.PlantService';
  for (const own of [0, 910000]) assert.equal(governor.isFriendRequest(service, 'WaterLand', body(own), 910000), false);
  assert.equal(governor.isFriendRequest(service, 'WaterLand', body(910001), 910000), true);
  assert.equal(governor.isFriendRequest(service, 'WaterLand', Buffer.from([255]), 910000), true);
  assert.equal(governor.isFriendRequest('gamepb.userpb.UserService', 'BatchGetBasicInfo', Buffer.alloc(0), 910000), true);
  assert.equal(governor.isFriendRequest('gamepb.userpb.UserService', 'Heartbeat', Buffer.alloc(0), 910000), false);
});
test('settings save validates before mutation and account snapshots, default plans and host status stay truthful', async () => {
  const broadcasts = [];
  const runtime = createRuntimeState({ store });
  const workers = { fixture: { name: 'fixture', status: { connection: { connected: true } }, process: { persistentSession: true, sessionFacts: { game: {} } } } };
  const provider = createDataProvider({ workers, store, getAccounts: () => ({ accounts: [{ id: 'fixture' }, { id: 'other' }] }),
    nextConfigRevision: runtime.nextConfigRevision,
    broadcastConfigToWorkers: id => broadcasts.push({ id, config: runtime.buildConfigSnapshotForAccount(id) }),
    buildDefaultStatus: () => ({}), normalizeStatusForPanel: value => value });
  for (const bad of [null, { ...policy, enabled: 0 }, { ...policy, total60s: 0 }, { ...policy, friend60s: 1.5 },
    { ...policy, method60s: '5' }, ...[-1, 1.5, null, '60', 10001].map(rosterBonusPer100 => ({ ...policy, rosterBonusPer100 }))]) {
    assert.throws(() => validateRequestPolicy(bad));
    await assert.rejects(provider.saveSettings('fixture', { requestPolicy: bad }));
  }
  assert.equal(broadcasts.length, 0);
  const configured = { ...policy, rosterBonusPer100: 60 };
  await provider.saveSettings('fixture', { requestPolicy: configured });
  assert.equal(broadcasts.length, 1);
  assert.equal(broadcasts[0].id, 'fixture');
  assert.deepEqual(broadcasts[0].config.requestPolicy, configured);
  assert.deepEqual(store.getConfigSnapshot('fixture').requestPolicy, configured);
  const otherPolicy = store.getConfigSnapshot('other').requestPolicy;
  assert.notDeepEqual(otherPolicy, policy);
  assert.deepEqual(runtime.buildConfigSnapshotForAccount('other').requestPolicy, otherPolicy);
  assert.equal(provider.getStatus('fixture').sessionUpgrade.requiresRescan, true);
  workers.fixture.process.sessionFacts.game.requestPolicy = { supported: true, ...policy };
  assert.equal(provider.getStatus('fixture').sessionUpgrade.requiresRescan, false);
  const loaded = JSON.parse(fs.readFileSync(path.join(root, 'store.json')));
  assert.deepEqual(loaded.accountConfigs.fixture.requestPolicy, configured);
  const { rosterBonusPer100, ...legacy } = policy;
  assert.equal(validateRequestPolicy(legacy).rosterBonusPer100, rosterBonusPer100);
  await provider.saveSettings('fixture', { requestPolicy: legacy });
  assert.equal(store.getConfigSnapshot('fixture').requestPolicy.rosterBonusPer100, 60);
});
test('friend rejection survives the real session codec and strict Worker/HTTP metadata path', () => {
  const codec = require('../src/runtime/session-codec');
  const meta = require('../src/services/operation-error-meta');
  const error = Object.assign(new Error('local'), { isGovernedRejection: true, governedReason: 'budget_friend' });
  const decoded = codec.decode(codec.encode(error));
  assert.equal(meta.strictBudgetRejection(decoded).reason, 'budget_friend');
  assert.equal(meta.collectOperationErrorMeta(decoded).reason, 'budget_friend');
  decoded.unknown = true;
  assert.equal(meta.strictBudgetRejection(decoded), null);
});


test('HOT preserves the existing boost for aggregate friend traffic and reports effective caps', () => {
  governor.resetForTest(); governor.configurePolicy(policy); governor.setWatchMode(true, at + 10000);
  for (let i = 0; i < 2; i++) governor.recordSent('gamepb.visitpb.VisitService', 'Enter', true, at, { friend: true });
  assert.equal(governor.checkRequest('gamepb.visitpb.VisitService', 'Enter', at, { friend: true }).allowed, true);
  governor.recordSent('gamepb.visitpb.VisitService', 'Enter', true, at, { friend: true });
  assert.equal(governor.checkRequest('gamepb.visitpb.VisitService', 'Enter', at, { friend: true }).reason, 'budget_friend');
  assert.equal(governor.getRequestProfile(at).effectiveFriendLimit, 3);
  assert.equal(governor.getRequestProfile(at).effectiveTotalLimit, 12);
  governor.resetForTest();
});
test('default plan rejects invalid request policy before mutation instead of silently coercing thresholds', () => {
  const configured = { ...policy, rosterBonusPer100: 0 };
  store.setUserDefaultAccountPlan('synthetic-owner', { requestPolicy: configured });
  const before = store.getUserDefaultAccountPlan('synthetic-owner');
  assert.deepEqual(before.config.requestPolicy, configured);
  assert.deepEqual(store.applyUserDefaultAccountPlan('synthetic-owner', 'from-plan').requestPolicy, configured);
  for (const bad of [{ ...policy, method60s: true }, { ...policy, friend60s: '20' }, { ...policy, total60s: 0 }, { ...policy, rosterBonusPer100: -1 }]) {
    assert.throws(() => store.setUserDefaultAccountPlan('synthetic-owner', { requestPolicy: { ...bad, enabled: false } }), { code: 'REQUEST_POLICY_INVALID' });
    assert.deepEqual(store.getUserDefaultAccountPlan('synthetic-owner'), before);
  }
});
