const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'); const path = require('node:path'); const os = require('node:os'); const vm = require('node:vm');
const prefix = path.resolve(os.tmpdir(), 'quiet-policy-fixture-'); assert.equal(path.dirname(prefix), fs.realpathSync(os.tmpdir()));
const data = fs.mkdtempSync(prefix); process.env.FARM_DATA_DIR = data; process.env.FARM_ACCOUNT_ID = 'synthetic-quiet-policy';
after(() => fs.rmSync(data, { recursive: true, force: true }));
const store = require('../src/models/store'); const idle = require('../src/utils/idle-protection');
const source = fs.readFileSync(path.resolve(__dirname, '../src/utils/network.js'), 'utf8');
const begin = source.indexOf('function businessPauseError('); const end = source.indexOf('\n}', begin);
const context = { process, getStoreModule: () => store }; vm.createContext(context); vm.runInContext(source.slice(begin, end + 2), context);
test('manual quiet still pauses automatic dispatch but leaves shop reads available with protection disabled', () => {
  const pauseUntil = new Date(Date.now() + 600000).toISOString();
  store.applyConfigSnapshot({ friendQuietHours: { idleProtectionEnabled: false, pauseUntil } }, { persist: false });
  idle.setIdleProtectionUntil(Date.now() + 120000);
  assert.ok(store.getPauseRemainMs() > 590000);
  assert.equal(context.businessPauseError('gamepb.shoppb.ShopService', 'ShopInfo'), null);
  assert.equal(store.getFriendQuietHours().pauseUntil, pauseUntil);
});
test('enabled idle wire protection blocks reads, expires, and always preserves heartbeat/login', () => {
  store.applyConfigSnapshot({ friendQuietHours: { idleProtectionEnabled: true } }, { persist: false });
  idle.setIdleProtectionUntil(Date.now() + 60000);
  assert.equal(context.businessPauseError('gamepb.shoppb.ShopService', 'ShopInfo').code, 'LOCAL_BUSINESS_PAUSED');
  for (const method of ['Login', 'Heartbeat']) assert.equal(context.businessPauseError('gamepb.userpb.UserService', method), null);
  idle.setIdleProtectionUntil(0);
  assert.equal(context.businessPauseError('gamepb.shoppb.ShopService', 'ShopInfo'), null);
});
test('new manager/old host envelope retains manual quiet only in business and preserves source config', () => {
  const { sessionPolicyConfig, businessPolicyConfig } = require('../src/runtime/session-config');
  const original = { friendQuietHours: { pauseUntil: new Date(Date.now() + 600000).toISOString(), idleProtectionEnabled: false }, __revision: 7 };
  const host = sessionPolicyConfig(original);
  assert.equal(host.friendQuietHours.pauseUntil, '');
  assert.deepEqual(businessPolicyConfig(host), original);
  assert.notEqual(original.friendQuietHours.pauseUntil, '');
  assert.deepEqual(businessPolicyConfig({ __revision: 3 }), { __revision: 3 });
});
