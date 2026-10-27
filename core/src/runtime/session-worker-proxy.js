const { EventEmitter } = require('node:events'); const path = require('node:path'); const crypto = require('node:crypto');
const { connectSession, ensureSession, processStarttime } = require('./session-registry');
const { resolveBusinessTarget } = require('./session-contract');
const { SESSION_ATTACH_TIMEOUT_MS } = require('./session-timeouts');
const { readLifecycleJournal, readLifecycleCursor, acknowledgeLifecycle } = require('./session-lifecycle-journal');
const { sessionPolicyConfig } = require('./session-config');

async function replayLifecycle({ dataDir, account, onLifecycle }) {
  // Always read the complete durable ring. A single live notification must not
  // advance the cursor across an event which is still available on disk.
  const value = readLifecycleJournal(dataDir, account.id);
  let cursor = readLifecycleCursor(dataDir, account.id);
  if (value.events.length && cursor < value.events[0].sequence - 1)
    await onLifecycle?.({ kind: 'gap', accountId: String(account.id), from: cursor + 1, to: value.events[0].sequence - 1 });
  for (const event of value.events) {
    if (event.sequence <= cursor) continue;
    await onLifecycle?.(event);
    acknowledgeLifecycle(dataDir, account.id, event.sequence); cursor = event.sequence;
  }
}
function createSessionWorkerProxy({ dataDir, account, sourceRoot, logDir, adoptOnly = false, onLifecycle }) {
  const proxy = new EventEmitter(); const managerId = crypto.randomUUID();
  let client; let initialized = false; let detached = false; let exiting = false; let managementCommit = '';
  let initialStart = {}; let initialConfig = {}; let control = Promise.resolve(); let lifecycleQueue = Promise.resolve(); let lastStatus;
  proxy.persistentSession = true; proxy.exitCode = null; proxy.sessionFacts = null;
  proxy.businessInitialized = false;
  proxy.recoverableAttach = false;
  proxy.businessFaultEpoch = '';
  let sameTargetAttachEpoch = '';
  function runtimeError(error, phase, facts = proxy.sessionFacts) {
    const reason = typeof error?.code === 'string' && /^SESSION_[A-Z_]{1,64}$/.test(error.code)
      ? error.code : 'SESSION_CONTROL_FAILED';
    return Object.assign(new Error(reason), { code: reason, phase,
      businessEpoch: facts?.business?.epoch || '', hostId: facts?.host?.hostId || '' });
  }
  function update(facts, message) {
    if (facts && (!proxy.sessionFacts || facts.sequence >= proxy.sessionFacts.sequence)) proxy.sessionFacts = facts;
    if (proxy.businessFaultEpoch && proxy.businessFaultEpoch !== proxy.sessionFacts?.business?.epoch) proxy.businessFaultEpoch = '';
    if (!message) return;
    if (message.type === 'session_business_diagnostic' && message.data?.businessEpoch === proxy.sessionFacts?.business?.epoch)
      proxy.businessFaultEpoch = message.data.businessEpoch;
    if (message.type === 'status_sync') {
      lastStatus = message;
      const actual = proxy.sessionFacts;
      message = { ...message, data: { ...message.data,
        connection: { ...message.data?.connection, connected: actual.game.connected === true },
        sessionRuntime: { managementCommit, hostCommit: actual.host.sourceCommit, businessCommit: actual.business?.commit || '',
          businessReady: actual.business?.ready === true && proxy.businessFaultEpoch !== actual.business?.epoch,
          businessRecoveryPending: proxy.businessFaultEpoch === actual.business?.epoch,
          hostPid: actual.host.pid, connectionEpoch: actual.game.connectionEpoch } } };
    }
    proxy.emit('message', message);
  }
  async function processLifecycle(event) {
    await onLifecycle?.(event);
  }
  function consume(journal) {
    lifecycleQueue = lifecycleQueue.catch(() => {}).then(() => replayLifecycle({ dataDir, account, journal, onLifecycle: processLifecycle }));
    return lifecycleQueue;
  }
  async function status() {
    if (!client?.ready || detached) throw new Error('Session management disconnected');
    const socket = client.socket;
    const result = await client.call('status', {}, 15000); update(result.facts);
    await consume(result.lifecycle);
    if (detached || !client.ready || client.socket !== socket || socket.destroyed)
      throw new Error('Session management changed while reading status');
    update(result.facts, result.status || { type: 'status_sync', data: { status: result.facts.game.status } });
    return result;
  }
  proxy.refreshSession = status;
  proxy.reloadBusiness = async () => {
    await proxy.ready;
    const target = resolveBusinessTarget({ runtimeRoot: sourceRoot, dataDir });
    const attached = await client.call('attach', { target, config: sessionPolicyConfig({ ...initialConfig, ...initialStart }) }, SESSION_ATTACH_TIMEOUT_MS);
    update(attached); return await status();
  };
  proxy.ready = new Promise((resolve, reject) => setImmediate(async () => {
    try {
      const found = adoptOnly ? await connectSession(dataDir, account)
        : await ensureSession({ dataDir, account, sourceRoot, logDir });
      if (found.state !== 'present') throw Object.assign(new Error('Persistent session could not be adopted'), { code: 'SESSION_ADOPTION_UNAVAILABLE', state: found.state });
      client = found.client; proxy.pid = found.descriptor.pid; proxy.descriptor = found.descriptor;
      const target = resolveBusinessTarget({ runtimeRoot: sourceRoot, dataDir });
      managementCommit = target.commit;
      client.on('event', envelope => {
        if (detached) return;
        update(envelope.facts);
        if (envelope.type === 'session_lifecycle') {
          consume({ events: [envelope.event] }).catch(error => proxy.emit('error', error));
        } else if (envelope.type === 'session_exit') {
          exiting = true; proxy.exitCode = 0; proxy.emit('exit', 0, null);
        } else if (envelope.type === 'session_business_error') {
          const actual = proxy.sessionFacts;
          // Older hosts also broadcast a retired receiver's late rejection.
          // Such an event cannot fault a newer, healthy business instance.
          if (envelope.facts?.sequence < actual.sequence || actual.business?.ready !== false
            || envelope.facts?.business?.epoch !== actual.business?.epoch) return;
          if (lastStatus) update(actual, lastStatus);
          proxy.emit('error', runtimeError({ code: 'SESSION_EVENT_DELIVERY_FAILED' }, 'event_delivery', actual));
        }
        else if (envelope.message) {
          update(envelope.facts, envelope.message);
          if (envelope.message.type === 'session_business_diagnostic' && lastStatus) update(proxy.sessionFacts, lastStatus);
        }
      });
      client.on('disconnect', () => {
        if (detached || exiting) return;
        // A broken control socket gives no evidence that the game disconnected.
        proxy.emit('session_unknown');
      });
      const claimed = await client.call('claim', { manager: { id: managerId, pid: process.pid, starttime: processStarttime(process.pid) } });
      update(claimed);
      await status();
      proxy.recoverableAttach = proxy.sessionFacts.game.connected === true && proxy.sessionFacts.game.terminal !== true;
      if (['runtimeRoot', 'commit', 'sourceFingerprint'].every(key => target[key] === proxy.sessionFacts.business?.[key]))
        sameTargetAttachEpoch = proxy.sessionFacts.business?.epoch || '';
      const selectedConfig = initialConfig;
      const attached = await client.call('attach', { target, config: sessionPolicyConfig({ ...initialConfig, ...initialStart }) }, SESSION_ATTACH_TIMEOUT_MS);
      update(attached); initialized = true;
      if (!attached.business?.ready || attached.business.commit !== target.commit) throw new Error('Target business did not become ready');
      if (initialConfig !== selectedConfig) await client.call('send', { message: { type: 'config_sync', config: sessionPolicyConfig(initialConfig) } });
      await status(); proxy.businessInitialized = true; resolve(true);
    } catch (error) {
      if (['SESSION_EPOCH_RETIRED', 'SESSION_REVOKED', 'SESSION_CONTROL_UNAVAILABLE', 'SESSION_BAD_SYNC_REPLY', 'SESSION_BAD_GAME_REPLY'].includes(error?.code)
        && sameTargetAttachEpoch && sameTargetAttachEpoch === proxy.sessionFacts?.business?.epoch) {
        proxy.businessFaultEpoch = sameTargetAttachEpoch;
        if (lastStatus) update(proxy.sessionFacts, lastStatus);
      }
      client?.close(); proxy.emit('error', runtimeError(error, 'attach'));
      // Admission failure is not a physical disconnect and must not cause a
      // second host or a fresh Code attempt through legacy fallback.
      reject(error);
    }
  }));
  proxy.ready.catch(() => {});
  proxy.send = message => {
    if (message?.type === 'start' && !initialized) { initialStart = message.config || {}; return; }
    if (message?.type === 'config_sync') { initialConfig = message.config || {}; if (!initialized) return; }
    if (message?.type === 'config_sync') message = { ...message, config: sessionPolicyConfig(message.config) };
    if (message?.type === 'stop') { proxy.kill().catch(error => proxy.emit('error', error)); return; }
    control = control.catch(() => {}).then(() => proxy.ready).then(() => client.call('send', { message }))
      .then(facts => update(facts));
    control.catch(error => proxy.emit('error', runtimeError(error, 'control')));
  };
  proxy.kill = async () => {
    await proxy.ready.catch(() => {});
    if (!client?.ready) throw new Error('Cannot verify session closure');
    await client.call('revoke', {}, 185000); client.close(); exiting = true;
    if (proxy.exitCode === null) { proxy.exitCode = 0; proxy.emit('exit', 0, null); }
  };
  proxy.detach = async () => {
    detached = true;
    if (client?.ready) { try { await client.call('detach', {}, 5000); } finally { client.close(); } }
  };
  proxy.sourceRoot = path.resolve(sourceRoot);
  return proxy;
}
module.exports = { createSessionWorkerProxy, replayLifecycle };
