const test = require('node:test'); const assert = require('node:assert/strict');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const prefix = path.resolve(os.tmpdir(), 'session-lifecycle-journal-');
assert.equal(path.dirname(prefix), path.resolve(os.tmpdir()));
const temporary = fs.mkdtempSync(prefix); process.env.FARM_DATA_DIR = temporary;
const { pathsFor, secureDirectory, processStarttime } = require('../src/runtime/session-registry');
const { createLifecycleJournal, readLifecycleCursor } = require('../src/runtime/session-lifecycle-journal');
const { replayLifecycle } = require('../src/runtime/session-worker-proxy');
test.after(() => fs.rmSync(temporary, { recursive: true, force: true }));

test('a live event after a gap replays the complete durable journal in order; a failed fact write is not acknowledged', async () => {
  const account = { id: 'synthetic-journal-account', credentialGeneration: 'synthetic-authorization', sessionGeneration: 'synthetic-session' };
  secureDirectory(pathsFor(temporary, account.id).directory);
  const journal = createLifecycleJournal({ dataDir: temporary, account, identity: { hostId: 'synthetic-host', binding: 'synthetic-binding', pid: process.pid, starttime: processStarttime(process.pid) } });
  const game = { connectionEpoch: 1, connected: true, firstLoginReadyAt: 100, loginReadyAt: 100,
    loginCredentialGeneration: 'synthetic-authorization' };
  const first = journal.append('login_ready', game);
  const kick = journal.append('kickout', { ...game, connected: false }, { otherTerminal: true });
  const third = journal.append('disconnect', { ...game, connected: false });
  const observed = [];
  await assert.rejects(replayLifecycle({ dataDir: temporary, account, journal: { events: [third] }, onLifecycle: event => {
    observed.push(event.eventId); if (event.kind === 'kickout') throw new Error('synthetic durable fact write failed');
  } }), /fact write failed/);
  assert.deepEqual(observed, [first.eventId, kick.eventId]); assert.equal(readLifecycleCursor(temporary, account.id), 1);
  const retried = [];
  await replayLifecycle({ dataDir: temporary, account, onLifecycle: event => retried.push(event.eventId) });
  assert.deepEqual(retried, [kick.eventId, third.eventId]); assert.equal(readLifecycleCursor(temporary, account.id), 3);
  await replayLifecycle({ dataDir: temporary, account, onLifecycle: () => { throw new Error('acknowledged events cannot run again'); } });
});

test('a truncated journal reports the actual missing range and keeps original event identities and times', async () => {
  const account = { id: 'synthetic-truncated-account', credentialGeneration: 'synthetic-authorization', sessionGeneration: 'synthetic-session' };
  secureDirectory(pathsFor(temporary, account.id).directory);
  let now = 1000;
  const journal = createLifecycleJournal({ dataDir: temporary, account, identity: { hostId: 'synthetic-host', binding: 'synthetic-binding', pid: process.pid, starttime: processStarttime(process.pid) }, now: () => now++ });
  for (let i = 0; i < 260; i++) journal.append('disconnect', { connectionEpoch: 1, connected: false });
  const original = journal.read(); const observed = [];
  await replayLifecycle({ dataDir: temporary, account, onLifecycle: event => observed.push(event) });
  assert.deepEqual(observed[0], { kind: 'gap', accountId: account.id, from: 1, to: 4 });
  assert.deepEqual(observed.slice(1), original.events);
  assert.equal(observed.slice(1).some(event => event.kind === 'kickout'), false);
});
