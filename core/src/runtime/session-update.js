const fs = require('node:fs'); const path = require('node:path');
const { connectSession, processIsLive, bindingIdentity, privateJson } = require('./session-registry');
const { readLifecycleJournal } = require('./session-lifecycle-journal');
function accountsAt(dataDir) {
  try { const value = JSON.parse(fs.readFileSync(path.join(dataDir, 'accounts.json'), 'utf8')); return value.accounts || []; }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}
async function collectSessionProofs(dataDir, options = {}) {
  let ownedNonce = '';
  const assertCurrent = () => { if (options.guard && !options.guard()) throw new Error('Session handoff cancelled'); };
  try {
  assertCurrent();
  if (options.barrier) {
    require('./session-handoff-barrier').beginSessionBarrier({ dataDir, ...options.barrier });
    ownedNonce = options.barrier.nonce;
    const deadline = Date.now() + 12000;
    for (;;) {
      assertCurrent();
      const pending = fs.readdirSync(path.join(dataDir, 'persistent-sessions')).filter(name => /^bootstrap-[a-f0-9-]+\.json$/.test(name));
      if (!pending.length) break;
      if (Date.now() >= deadline) throw new Error('A session host is still starting');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  const proofs = [];
  for (const account of accountsAt(dataDir)) {
    assertCurrent();
    if (account.autoLogin === false) continue;
    const found = await connectSession(dataDir, account);
    if (found.state === 'absent' || (found.state === 'stale'
      && !processIsLive(found.descriptor?.pid, found.descriptor?.starttime))) continue;
    if (found.state !== 'present') throw new Error('Existing persistent session could not be verified');
    try {
      const { facts } = await found.client.call('status', {}, 10000);
      proofs.push({ accountId: String(account.id), binding: bindingIdentity(account),
        credentialGeneration: account.credentialGeneration, hostId: facts.host.hostId,
        pid: facts.host.pid, starttime: facts.host.starttime, sourceRoot: facts.host.sourceRoot,
        sourceCommit: facts.host.sourceCommit, socketInode: found.descriptor.socketInode,
        connectionEpoch: facts.game.connectionEpoch, connected: facts.game.connected === true, observedAt: Date.now() });
    } finally { found.client.close(); }
  }
  assertCurrent();
  return proofs;
  } catch (error) {
    if (ownedNonce) require('./session-handoff-barrier').releaseSessionBarrier(dataDir, ownedNonce);
    throw error;
  }
}
async function verifySessionProofs({ dataDir, proofs = [], expectedBusinessCommit = '', final = false, barrierNonce = '' }) {
  const fresh = await collectSessionProofs(dataDir);
  if (!final) {
    const identity = list => JSON.stringify(list.map(item => [item.accountId, item.hostId, item.binding, item.credentialGeneration]).sort());
    if (identity(fresh) !== identity(proofs)) return { ok: false, outcomes: [] };
    if (barrierNonce && require('./session-handoff-barrier').readSessionBarrier(dataDir)?.nonce !== barrierNonce)
      return { ok: false, outcomes: [] };
  }
  const accounts = accountsAt(dataDir); const outcomes = [];
  for (const proof of proofs) {
    const account = accounts.find(item => String(item.id) === proof.accountId);
    if (!account || account.autoLogin === false || bindingIdentity(account) !== proof.binding
      || account.credentialGeneration !== proof.credentialGeneration) {
      if (!final) return { ok: false, outcomes };
      if (processIsLive(proof.pid, proof.starttime) && (!account || bindingIdentity(account) !== proof.binding))
        return { ok: false, outcomes };
      const replacement = fresh.find(item => item.accountId === proof.accountId);
      if (replacement) {
        const connected = await connectSession(dataDir, account);
        if (connected.state !== 'present') return { ok: false, outcomes };
        try {
          const { facts } = await connected.client.call('status', {}, 10000);
          if (!facts.business?.ready || facts.business.commit !== expectedBusinessCommit) return { ok: false, outcomes };
        } finally { connected.client.close(); }
      }
      outcomes.push({ accountId: proof.accountId, state: 'changed_by_account_action' }); continue;
    }
    const found = await connectSession(dataDir, account);
    if (found.state !== 'present') {
      if (final) {
        const lifecycle = readLifecycleJournal(dataDir, account.id);
        const genuineStop = lifecycle.events.find(event => event.hostId === proof.hostId
          && event.connectionEpoch >= proof.connectionEpoch && event.observedAt >= proof.observedAt
          && event.credentialGeneration === proof.credentialGeneration
          && (['kickout', 'reconnect_failed'].includes(event.kind) || (event.kind === 'ws_error' && event.code === 400)));
        if (genuineStop && !processIsLive(proof.pid, proof.starttime)) {
          outcomes.push({ accountId: proof.accountId, state: 'upstream_disconnected', eventId: genuineStop.eventId }); continue;
        }
      }
      return { ok: false, outcomes };
    }
    try {
      const { facts } = await found.client.call('status', {}, 10000);
      if (facts.host.hostId !== proof.hostId || facts.host.pid !== proof.pid || facts.host.starttime !== proof.starttime
        || found.descriptor.socketInode !== proof.socketInode || facts.host.sourceRoot !== proof.sourceRoot
        || (!final && facts.game.connectionEpoch !== proof.connectionEpoch)
        || (expectedBusinessCommit && (!facts.business?.ready || facts.business.commit !== expectedBusinessCommit)))
        return { ok: false, outcomes };
      outcomes.push({ accountId: proof.accountId, state: facts.game.connectionEpoch === proof.connectionEpoch ? 'preserved' : 'physical_reconnect',
        hostPid: facts.host.pid, hostCommit: facts.host.sourceCommit, businessCommit: facts.business?.commit || '',
        connectionEpoch: facts.game.connectionEpoch });
    } finally { found.client.close(); }
  }
  if (final) for (const extra of fresh.filter(item => !proofs.some(proof => proof.accountId === item.accountId))) {
    const account = accounts.find(item => String(item.id) === extra.accountId);
    const found = await connectSession(dataDir, account);
    if (found.state !== 'present') return { ok: false, outcomes };
    try { const { facts } = await found.client.call('status', {}, 10000);
      if (!facts.business?.ready || facts.business.commit !== expectedBusinessCommit) return { ok: false, outcomes };
    } finally { found.client.close(); }
  }
  return { ok: true, outcomes };
}
function pinnedSessionRoots(dataDir) {
  const roots = new Set(); const directory = path.join(dataDir, 'persistent-sessions');
  try {
    for (const name of fs.readdirSync(directory)) {
      if (!/^[a-f0-9]{24}\.json$/.test(name)) continue;
      let value;
      try { value = privateJson(path.join(directory, name)); }
      catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      if (!value.pid || !value.starttime || !processIsLive(value.pid, value.starttime)) continue;
      for (const root of [value.sourceRoot, ...(value.businessRoots || [])]) {
        if (typeof root === 'string' && path.isAbsolute(root)) roots.add(path.resolve(root));
      }
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return roots;
}
module.exports = { accountsAt, collectSessionProofs, verifySessionProofs, pinnedSessionRoots };
