const test = require('node:test'); const assert = require('node:assert/strict');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const prefix = path.resolve(os.tmpdir(), 'session-login-checkpoint-');
assert.equal(path.dirname(prefix), path.resolve(os.tmpdir()));
const temporary = fs.mkdtempSync(prefix); process.env.FARM_DATA_DIR = temporary;
test.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
const { settleScanCheckpointOnConnect } = require('../src/runtime/runtime-engine');
function fixture({ proxyStartedAt, firstLoginReadyAt, usedCredential }) {
  const account = { id: 'synthetic-checkpoint', username: 'synthetic-owner', wxid: 'synthetic-wx',
    code: 'synthetic-code', credentialGeneration: 'synthetic-new-authorization' };
  const worker = { stopping: false, startedAt: proxyStartedAt, process: { persistentSession: true },
    sessionFacts: { game: { connected: true, firstLoginReadyAt, loginCredentialGeneration: usedCredential } } };
  const resolved = [];
  return { account, worker, resolved, run: () => settleScanCheckpointOnConnect({ accountId: account.id,
    workers: { [account.id]: worker }, getAccounts: () => ({ accounts: [account] }),
    status: { connection: { connected: true } }, reminder: { getScanCheckpoint: () => ({ generation: 3, savedAt: 100 }),
      noteScanCodeResolved: (id, options) => { resolved.push({ id, options }); return Promise.resolve(true); } } }) };
}
test('a fresh management proxy cannot settle a new scan while the host still uses the old authorization', async () => {
  const f = fixture({ proxyStartedAt: 1000, firstLoginReadyAt: 50, usedCredential: 'synthetic-old-authorization' });
  await f.run(); assert.equal(f.resolved.length, 0);
});
test('genuine login with the new authorization settles the checkpoint independently of proxy creation time', async () => {
  const f = fixture({ proxyStartedAt: 50, firstLoginReadyAt: 150, usedCredential: 'synthetic-new-authorization' });
  await f.run(); assert.equal(f.resolved.length, 1); assert.equal(f.resolved[0].options.connected, true);
  assert.equal(f.resolved[0].options.guard(), true); f.worker.stopping = true; assert.equal(f.resolved[0].options.guard(), false);
});
