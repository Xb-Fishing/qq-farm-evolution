const test = require('node:test'); const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const prefix = path.resolve(os.tmpdir(), 'session-account-generation-'); assert.equal(path.dirname(prefix), path.resolve(os.tmpdir()));
const temporary = fs.mkdtempSync(prefix); process.env.FARM_DATA_DIR = temporary;
test.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
const store = require('../src/models/store'); const { bindingIdentity } = require('../src/runtime/session-registry');
let sequence = 0;
function fresh() { const data = store.addOrUpdateAccount({ name: '示例农场', username: `synthetic-owner-${++sequence}`, platform: 'wx', wxid: 'synthetic-wx' }); return data.accounts.at(-1); }
const current = id => store.getAccounts().accounts.find(account => account.id === id);

test('same-subject credential acceptance leaves the live connection identity until a new Code is ready', () => {
  const original = fresh();
  store.addOrUpdateAccount({ id: original.id, code: '', loginBuffer: 'synthetic-confirmed-grant' }, { newAuthorization: true });
  const pending = current(original.id);
  assert.notEqual(pending.credentialGeneration, original.credentialGeneration);
  assert.equal(pending.sessionGeneration, original.sessionGeneration);
  assert.equal(bindingIdentity(pending), bindingIdentity(original));
  store.addOrUpdateAccount({ id: original.id, code: 'synthetic-one-use' }, { activateSession: true });
  const activated = current(original.id);
  assert.notEqual(activated.sessionGeneration, pending.sessionGeneration);
  assert.equal(activated.credentialGeneration, pending.credentialGeneration);
});

test('display/profile/token updates preserve identities while owner and subject replacement revoke them', () => {
  const original = fresh();
  store.addOrUpdateAccount({ id: original.id, name: '更新显示名', openId: 'synthetic-profile', accesstoken: crypto.randomUUID(), code: 'synthetic-refreshed' });
  const rotated = current(original.id);
  assert.equal(rotated.credentialGeneration, original.credentialGeneration); assert.equal(rotated.sessionGeneration, original.sessionGeneration);
  store.addOrUpdateAccount({ id: original.id, username: 'another-synthetic-owner' });
  const transferred = current(original.id);
  assert.notEqual(transferred.credentialGeneration, original.credentialGeneration); assert.notEqual(transferred.sessionGeneration, original.sessionGeneration);
  store.addOrUpdateAccount({ id: original.id, wxid: 'another-synthetic-subject' });
  assert.notEqual(current(original.id).sessionGeneration, transferred.sessionGeneration);
});

test('explicit stop rotates only the live-session fence; incoming fields cannot choose either identity', () => {
  const original = fresh();
  store.addOrUpdateAccount({ id: original.id, autoLogin: false }, { revokeSession: true });
  const stopped = current(original.id);
  assert.notEqual(stopped.sessionGeneration, original.sessionGeneration); assert.equal(stopped.credentialGeneration, original.credentialGeneration);
  store.addOrUpdateAccount({ id: original.id, sessionGeneration: original.sessionGeneration, credentialGeneration: 'caller-selected' });
  assert.equal(current(original.id).sessionGeneration, stopped.sessionGeneration); assert.equal(current(original.id).credentialGeneration, stopped.credentialGeneration);
});

test('old account migration is durable without forging a new authorization time', () => {
  const original = fresh(); const data = store.getAccounts();
  const row = data.accounts.find(account => account.id === original.id); delete row.credentialGeneration; delete row.sessionGeneration;
  const file = path.resolve(temporary, 'accounts.json'); assert.equal(path.dirname(file), temporary);
  fs.writeFileSync(file, JSON.stringify(data), { mode: 0o600 });
  const migrated = store.ensureAccountSessionMetadata(original.id); const again = store.ensureAccountSessionMetadata(original.id);
  assert.equal(migrated.updatedAt, original.updatedAt); assert.equal(migrated.credentialGeneration, again.credentialGeneration);
  assert.equal(migrated.sessionGeneration, again.sessionGeneration); assert.equal(current(original.id).sessionGeneration, migrated.sessionGeneration);
});

test('account ID reuse cannot adopt an old owner\'s persistent host', () => {
  for (const account of store.getAccounts().accounts) store.deleteAccount(account.id);
  const old = fresh(); store.deleteAccount(old.id); const next = fresh();
  assert.equal(old.id, next.id); assert.notEqual(old.sessionGeneration, next.sessionGeneration); assert.notEqual(bindingIdentity(old), bindingIdentity(next));
});
