'use strict';
const test = require('node:test'); const assert = require('node:assert/strict');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path'); const vm = require('node:vm');
const { createRequire, Module } = require('node:module'); const { EventEmitter } = require('node:events'); const { execFileSync } = require('node:child_process');
const prefix = path.resolve(fs.realpathSync(os.tmpdir()), 'milk-session-'); assert.equal(path.dirname(prefix), fs.realpathSync(os.tmpdir()));
const data = fs.mkdtempSync(prefix); process.env.FARM_DATA_DIR = data;
test.after(() => fs.rmSync(data, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }));
const sourceRoot = path.resolve(__dirname, '../..');
const { createSessionBusinessRuntime } = require('../src/runtime/session-business-runtime');
const { encode, decode } = require('../src/runtime/session-codec');

test('actual old adapter and old store pass new policy to real business Workers, preserving old loaded capsules', { timeout: 30000 }, async t => {
  const filename = path.resolve(__dirname, '../src/runtime/session-game-adapter.js'); const native = createRequire(filename); const module = { exports: {} };
  const storeFile = path.resolve(__dirname, '../src/models/store.js');
  const oldSource = execFileSync('git', ['show', 'fc8020813f9d0f47e0eb85dc9b16ca15e94b2669:core/src/models/store.js'], { cwd: sourceRoot, encoding: 'utf8' });
  const oldModule = new Module(storeFile); oldModule.filename = storeFile; oldModule.paths = Module._nodeModulePaths(path.dirname(storeFile)); oldModule._compile(oldSource, storeFile);
  const oldStore = oldModule.exports;
  const account = { id: 'synthetic-old-milk-host', platform: 'wx', credentialGeneration: 'synthetic-grant', autoLogin: true };
  let connects = 0; let stops = 0; let writes = 0;
  const network = { setSessionTransportHooks() {}, networkEvents: new EventEmitter(), getWs: () => null, isConnected: () => false,
    getUserState: () => ({}), getWsErrorState: () => ({}), getAceStatus: () => ({}), connect: () => { connects++; }, stopNetwork: () => { stops++; },
    sendMsgAsync: () => { writes++; throw new Error('No game requests allowed in the host configuration fixture'); } };
  const methods = new Proxy({}, { get: (_target, key) => key === 'getStats' ? () => ({}) : () => undefined });
  Object.assign(network, { pauseAceReports() {}, resumeAceReports() {}, cleanup() {}, getBreakerState: () => ({}), getRequestProfile: () => ({}), buildLoginDeviceInfo: () => ({}), buildWebSocketHeaders: () => ({}), extractServerClientVersion: () => '' });
  const replacements = { '../utils/network': network, '../services/stats': methods, '../services/status': { setStatusPlatform() {}, setRecordGoldExpHook() {}, statusData: {} },
    '../services/request-governor': methods, '../models/store': { ...oldStore, getAccounts: () => ({ accounts: [account] }) },
    '../utils/idle-protection': { getIdleProtectionUntil: () => 0, setIdleProtectionUntil() {} },
    '../utils/utils': { setLogHook() {}, getServerClockSnapshot: () => ({}) }, '../utils/proto': { loadProto: async () => {} }, '../config/config': { CONFIG: {} } };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module, exports: module.exports, Buffer, process, queueMicrotask, Uint8Array, require: name => replacements[name] || native(name) }, { filename });
  const adapter = await module.exports.createSessionGameAdapter({ account });
  t.after(() => adapter.dispose());
  const config = adapter.syncConfig({ platform: 'wx', automation: { farm: false, harvest: false, plant: false, task: false, friend: false, friend_steal: false,
    milk_tea_auto_rewards: false, milk_tea_auto_work: true, milk_tea_auto_upgrade: true, milk_tea_auto_seeds: true, milk_tea_work_interaction_type: 3,
    milk_tea_seed_policy: { targetSeedIds: [20525], targetStock: 24, coinReserve: '1000000', coinDailyLimit: '240000', ticketReserve: '8000', ticketDailyLimit: '0' } } });
  assert.equal(oldStore.getAutomation(account.id).milk_tea_auto_seeds, undefined, 'old host store really does not understand new keys');
  assert.equal(config.automation.milk_tea_auto_seeds, true, 'adapter returns raw config, not old normalized config');
  let sequence = 0;
  const plain = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  const invoke = fn => { try { return plain(fn()); } catch (error) { throw Object.assign(new Error(error.message), { code: error.code }); } };
  const facts = () => ({ sequence: ++sequence, host: { accountId: account.id }, game: plain(adapter.snapshot()) });
  const options = { target: { runtimeRoot: sourceRoot }, epoch: 'synthetic-milk-cold', facts: facts(), config: plain(config),
    read: facts, command: (method, args) => ({ value: invoke(() => adapter.command(method, args)), facts: facts() }), query: (method, args) => ({ value: invoke(() => adapter.query(method, args)), facts: facts() }),
    request: () => { writes++; throw new Error('No gameplay during configuration or restore'); }, onMaster() {} };
  const cold = await createSessionBusinessRuntime(options); let checkpoint;
  try { await cold.prepare(); await cold.activate([]); checkpoint = decode(await cold.quiesce()); }
  finally { await cold.terminate(); }
  assert.equal(checkpoint.config.automation.milk_tea_auto_work, true); assert.deepEqual(checkpoint.config.automation.milk_tea_seed_policy.targetSeedIds, [20525]);
  const state = checkpoint.state.domains['services/milk-tea-activity.js']; const version = state.version;
  const deadline = Date.now() + 600000;
  state.value.automaticState = { nextCheckAt: deadline, claims: { 'daily:2099-01-01': 1 }, loaded: true }; // Genuine old shape.
  const warm = await createSessionBusinessRuntime({ ...options, epoch: 'synthetic-milk-warm', checkpoint: encode(checkpoint), facts: facts() });
  let after;
  try { await warm.prepare(); await warm.activate([]); after = decode(await warm.quiesce()); }
  finally { await warm.terminate(); }
  assert.equal(after.state.domains['services/milk-tea-activity.js'].version, version);
  assert.equal(after.state.domains['services/milk-tea-activity.js'].value.automaticState.nextCheckAt, deadline);
  assert.deepEqual(after.state.domains['services/milk-tea-activity.js'].value.automaticState.claims, { 'daily:2099-01-01': 1 });
  assert.equal(after.config.automation.milk_tea_auto_upgrade, true); assert.equal(after.config.automation.milk_tea_work_interaction_type, 3);
  const pending = { wages: { pending: true, at: 1793268000000, status: 'pending' }, upgrades: { pendingLevel: 3, at: 1793268000000, status: 'pending' },
    interactions: { '7001': { at: 1793268000000, status: 'pending' } }, purchases: { '301': { goodsId: 301, seedId: 20525, count: 1, baselinePurchased: 0,
      spent: { '1001': '10000' }, rewards: { '20525': '1' }, day: '2026-10-29', at: 1793268000000, status: 'pending' } }, spend: {} };
  after.state.domains['services/milk-tea-activity.js'].value.automaticState.actionState = pending;
  const next = await createSessionBusinessRuntime({ ...options, epoch: 'synthetic-milk-pending', checkpoint: encode(after), facts: facts() });
  try {
    await next.prepare(); await next.activate([]); const restored = decode(await next.quiesce());
    assert.deepEqual(restored.state.domains['services/milk-tea-activity.js'].value.automaticState.actionState, pending);
  } finally { await next.terminate(); }
  assert.equal(connects, 1, 'warm replacement did not reconnect old host'); assert.equal(writes, 0); assert.equal(stops, 0);
});
