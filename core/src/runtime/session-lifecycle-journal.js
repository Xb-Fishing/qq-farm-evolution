const path = require('node:path'); const crypto = require('node:crypto');
const { pathsFor, privateJson, atomicJson, secureDirectory } = require('./session-registry');
const LIMIT = 256;
function journalPath(dataDir, accountId) {
  const paths = pathsFor(dataDir, accountId);
  return path.join(paths.directory, `${path.basename(paths.descriptor, '.json')}-events.json`);
}
function readLifecycleJournal(dataDir, accountId) {
  const file = journalPath(dataDir, accountId);
  try {
    secureDirectory(path.dirname(file), false);
    const value = privateJson(file);
    if (value.version !== 1 || !Array.isArray(value.events) || value.events.length > LIMIT
      || !Number.isSafeInteger(value.sequence) || value.events.some((row, index) =>
        !Number.isSafeInteger(row.sequence) || row.sequence > value.sequence
        || (index > 0 && row.sequence <= value.events[index - 1].sequence))) throw new Error('Invalid lifecycle journal');
    return value;
  } catch (error) { if (error.code === 'ENOENT') return { version: 1, sequence: 0, acknowledged: 0, events: [] }; throw error; }
}
// One host owns this account's lifetime flock, so event appends have one writer.
// Consumer cursors live elsewhere; ACK never races with an event-file rename.
function createLifecycleJournal({ dataDir, account, identity, now = Date.now }) {
  const file = journalPath(dataDir, account.id);
  const prior = readLifecycleJournal(dataDir, account.id);
  let sequence = prior.sequence; const events = prior.events;
  function append(kind, game, detail = {}) {
    const observedAt = now();
    const row = { version: 1, sequence: ++sequence, eventId: crypto.randomUUID(), kind, observedAt,
      hostId: identity.hostId, hostPid: identity.pid, hostStarttime: identity.starttime,
      binding: identity.binding, accountId: String(account.id), credentialGeneration: account.credentialGeneration,
      sessionGeneration: account.sessionGeneration, connectionEpoch: game.connectionEpoch,
      loginCredentialGeneration: game.loginCredentialGeneration || '',
      loginReadyAt: game.loginReadyAt || 0, firstLoginReadyAt: game.firstLoginReadyAt || 0,
      connected: game.connected === true, ...detail };
    events.push(row); if (events.length > LIMIT) events.splice(0, events.length - LIMIT);
    atomicJson(file, { version: 1, sequence, oldestSequence: events[0]?.sequence || sequence + 1, events });
    return row;
  }
  return { append, read: () => ({ version: 1, sequence, oldestSequence: events[0]?.sequence || sequence + 1, events: [...events] }) };
}
function cursorPath(dataDir, accountId) { return journalPath(dataDir, accountId).replace(/-events\.json$/, '-cursor.json'); }
function readLifecycleCursor(dataDir, accountId) {
  try { const value = privateJson(cursorPath(dataDir, accountId)); return Number.isSafeInteger(value.sequence) ? value.sequence : 0; }
  catch (error) { if (error.code === 'ENOENT') return 0; throw error; }
}
function acknowledgeLifecycle(dataDir, accountId, sequence) {
  const current = readLifecycleCursor(dataDir, accountId);
  if (!Number.isSafeInteger(sequence) || sequence < current) throw new Error('Invalid lifecycle acknowledgement');
  atomicJson(cursorPath(dataDir, accountId), { version: 1, sequence });
}
module.exports = { createLifecycleJournal, readLifecycleJournal, readLifecycleCursor, acknowledgeLifecycle, journalPath };
