const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fork, execFileSync } = require('node:child_process');
const { Worker } = require('node:worker_threads');
const { once } = require('node:events');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farm-blacklist-persistence-'));
process.env.FARM_DATA_DIR = dataDir;
const store = require('../src/models/store');
const storePath = require.resolve('../src/models/store');
const workerPath = path.join(__dirname, 'fixtures/blacklist-config-worker.js');
const readDisk = () => JSON.parse(fs.readFileSync(path.join(dataDir, 'store.json'), 'utf8'));
function reloadBlacklist(accountId) {
  const output = execFileSync(process.execPath, ['-e',
    'const store = require(process.argv[1]); console.log(JSON.stringify(store.getFriendBlacklist(process.argv[2])));',
    storePath, accountId], { env: process.env, encoding: 'utf8' });
  return JSON.parse(output.trim().split(/\r?\n/).at(-1));
}
test.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

for (const [mode, action] of [
  ['fork', 'expire'], ['fork', 'pause'], ['thread', 'expire'], ['thread', 'pause'], ['fork', 'ipc-failure'],
]) {
  test(`${mode}/${action}: bad-action pause cannot overwrite newer blacklists from any account`, { timeout: 20000 }, async t => {
    const accountId = `blacklist-${mode}-${action}`;
    const otherId = `${accountId}-other`;
    store.applyConfigSnapshot({
      friendBadRetryDate: action === 'pause' ? '' : '2000-01-01',
      friendBlacklist: [], automation: { friend_bad: true },
    }, { accountId });
    store.setFriendBlacklist(otherId, []);
    const env = { ...process.env, FARM_ACCOUNT_ID: accountId };
    const worker = mode === 'fork'
      ? fork(workerPath, [], { env, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
      : new Worker(workerPath, { env });
    t.after(() => mode === 'fork' ? worker.kill() : worker.terminate());
    const exited = once(worker, 'exit');
    const messages = [];
    worker.on('message', message => messages.push(message));
    assert.equal((await once(worker, 'message'))[0].type, 'ready');

    // The worker has already loaded the old store; the panel saves after that.
    store.setFriendBlacklist(accountId, [101, 102]);
    store.setFriendBlacklist(otherId, [201]);
    if (mode === 'fork') worker.send({ type: action });
    else worker.postMessage({ type: action });
    await exited;
    assert.equal(messages.find(message => message.type === 'checked')?.paused, action === 'pause');
    let disk = readDisk();
    assert.deepEqual(disk.accountConfigs[accountId].friendBlacklist, [101, 102]);
    assert.deepEqual(disk.accountConfigs[otherId].friendBlacklist, [201]);

    // The manager alone persists the small patch against its current state.
    const patch = messages.find(message => message.type === 'automation_patch')?.patch;
    if (action === 'ipc-failure') {
      assert.equal(patch, undefined);
      assert.deepEqual(reloadBlacklist(accountId), [101, 102]);
      return;
    }
    assert.ok(patch);
    if (action === 'expire') assert.deepEqual(patch, { friendBadRetryDate: '' });
    else assert.match(patch.friendBadRetryDate, /^\d{4}-\d{2}-\d{2}$/);
    store.applyConfigSnapshot(patch, { accountId });
    disk = readDisk();
    assert.equal(disk.accountConfigs[accountId].friendBadRetryDate, patch.friendBadRetryDate);
    assert.deepEqual(reloadBlacklist(accountId), [101, 102]);
  });
}

test('applying a default plan preserves account friend lists on disk and after reload', () => {
  const accountId = 'blacklist-default-plan';
  store.applyConfigSnapshot({
    friendBlacklist: [101, 102], knownFriendGids: [101, 102, 103],
    watchlistFriendGids: [103], autoBadFriendGids: [103],
  }, { accountId });
  store.setUserDefaultAccountPlan('blacklist-owner', { plantingStrategy: 'max_profit' });
  const result = store.applyUserDefaultAccountPlan('blacklist-owner', accountId);
  assert.equal(result.plantingStrategy, 'max_profit');
  assert.deepEqual(result.friendBlacklist, [101, 102]);
  assert.deepEqual(result.knownFriendGids, [101, 102, 103]);
  assert.deepEqual(result.watchlistFriendGids, [103]);
  assert.deepEqual(result.autoBadFriendGids, [103]);
  assert.deepEqual(readDisk().accountConfigs[accountId].friendBlacklist, [101, 102]);
  assert.deepEqual(reloadBlacklist(accountId), [101, 102]);
});

test('standalone pause expiry still persists when there is no manager', () => {
  const accountId = 'blacklist-standalone';
  store.applyConfigSnapshot({ friendBadRetryDate: '2000-01-01', friendBlacklist: [401] }, { accountId });
  execFileSync(process.execPath, ['-e',
    'require(process.argv[1]).isFriendBadPaused();',
    require.resolve('../src/services/friend-orchestrator')], {
    env: { ...process.env, FARM_ACCOUNT_ID: accountId }, stdio: 'pipe',
  });
  assert.equal(readDisk().accountConfigs[accountId].friendBadRetryDate, '');
  assert.deepEqual(reloadBlacklist(accountId), [401]);
});
