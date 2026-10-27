const { EventEmitter } = require('node:events');
const { performance } = require('node:perf_hooks');
const { encode, decode } = require('./session-codec');
const { STATS_METHODS, STATS_READ_METHODS, GOVERNOR_METHODS, GOVERNOR_READ_METHODS,
  STATUS_METHODS, NETWORK_READ_METHODS } = require('./session-game-adapter');

function createSessionBusinessBridge({ port, gate, initialFacts, onControlFailure }) {
  let facts = initialFacts; let sequence = 0; let appliedRevision = 0; let onReady; let readinessObserver;
  const pending = new Map(); const sockets = new Map(); const userState = {}; const statusData = {};
  const syncBuffer = new SharedArrayBuffer(8 + 8 * 1024 * 1024); let syncHealthy = true;
  let controlFailure;
  function blockControl(reason = 'SESSION_CONTROL_UNAVAILABLE') {
    syncHealthy = false;
    controlFailure ||= Object.assign(new Error(reason), { code: reason });
    return controlFailure;
  }
  function failControl(reason, kind, method, originalError, details = {}) {
    const first = syncHealthy;
    const error = blockControl(reason);
    if (first) {
      Object.assign(error, details);
      try { onControlFailure?.({ reason, phase: kind === 'request' ? 'game_reply' : 'sync_channel', operation: kind, method: method || '', error: originalError, ...details }); } catch {}
    }
    return error;
  }
  const fatalControlError = error => ['SESSION_EPOCH_RETIRED', 'SESSION_REVOKED', 'SESSION_BINDING_REVOKED',
    'SESSION_CONTROL_UNAVAILABLE', 'SESSION_BAD_SYNC_REPLY'].includes(error?.code);
  const utils = require('../utils/utils'); const idle = require('../utils/idle-protection');
  function lookupType(name) { return require('../utils/proto').getRoot().lookupType(name); }
  function socketFor(epoch) {
    if (!sockets.has(epoch)) sockets.set(epoch, { sessionSocketEpoch: epoch,
      get readyState() { return facts.game.connectionEpoch === epoch ? facts.game.readyState : 3; },
      close: () => command('network.close', []) });
    return sockets.get(epoch);
  }
  const codecOptions = { lookupType,
    special: value => value?.kind === 'sessionSocket' ? socketFor(value.epoch) : (() => { throw new Error('Invalid session reference'); })() };
  function applyFacts(next) {
    if (!next || next.sequence < facts.sequence) return;
    facts = next;
    for (const key of Object.keys(userState)) if (!Object.hasOwn(next.game.userState, key)) delete userState[key];
    for (const key of Object.keys(statusData)) if (!Object.hasOwn(next.game.status, key)) delete statusData[key];
    Object.assign(userState, next.game.userState); Object.assign(statusData, next.game.status);
    if (next.game.clientVersion) require('../config/config').CONFIG.clientVersion = next.game.clientVersion;
    if (next.game.platform) require('../config/config').CONFIG.platform = next.game.platform;
    utils.restoreServerClockSnapshot(next.game.clock);
    readinessObserver?.(next.game);
  }
  applyFacts(initialFacts);
  function sync(kind, method, args = []) {
    if (!syncHealthy) throw controlFailure;
    const buffer = syncBuffer; const header = new Int32Array(buffer, 0, 2);
    Atomics.store(header, 0, 0); Atomics.store(header, 1, 0);
    try { port.postMessage({ kind: 'business_sync', buffer, body: encode({ kind, method, args,
      connectionEpoch: kind === 'command' ? gate.operation()?.connectionEpoch : undefined }) }); }
    catch (error) { throw failControl('SESSION_CONTROL_UNAVAILABLE', kind, method, error); }
    const startedAt = performance.now(); const deadline = startedAt + 15000;
    let waitCount = 0; let waitOutcome = 'not-needed';
    // The host publishes state=1 before notifying. Its notification may arrive
    // after the Worker consumed that reply and reused this buffer. Such a wake
    // belongs to the earlier call; only the predicate proves this reply ready.
    while (Atomics.load(header, 0) === 0) {
      const remaining = deadline - performance.now();
      if (remaining <= 0) break;
      waitCount++;
      waitOutcome = Atomics.wait(header, 0, 0, remaining);
    }
    const controlState = Atomics.load(header, 0);
    if (controlState !== 1) {
      throw failControl('SESSION_CONTROL_UNAVAILABLE', kind, method, undefined, {
        waitMs: Math.round(performance.now() - startedAt), waitCount, waitOutcome, controlState,
      });
    }
    const length = Atomics.load(header, 1);
    if (length < 1 || length > buffer.byteLength - 8) throw failControl('SESSION_BAD_SYNC_REPLY', kind, method);
    let reply;
    try { reply = decode(Buffer.from(new Uint8Array(buffer, 8, length)), { lookupType }); }
    catch (error) { throw failControl('SESSION_BAD_SYNC_REPLY', kind, method, error); }
    if (reply.error) {
      if (fatalControlError(reply.error)) throw failControl(reply.error.code, kind, method, reply.error);
      throw reply.error;
    }
    try { applyFacts(reply.value.facts); return reply.value.value; }
    catch (error) { throw failControl('SESSION_BAD_SYNC_REPLY', kind, method, error); }
  }
  function readFacts() { sync('facts'); return facts; }
  function query(method, args = []) { return sync('query', method, args); }
  function command(method, args = []) {
    if (!syncHealthy) throw controlFailure;
    const operation = gate.operation();
    if (!operation || operation.preparation) throw Object.assign(new Error('Business authority is not active'), { code: 'SESSION_EPOCH_RETIRED' });
    operation.connectionEpoch ??= readFacts().game.connectionEpoch;
    return sync('command', method, args);
  }
  function sendMsgAsync(service, method, body, timeout, options) {
    if (!syncHealthy) return Promise.reject(controlFailure);
    const operation = gate.operation();
    if (!operation || operation.preparation) return Promise.reject(Object.assign(new Error('Business authority is not active'), { code: 'SESSION_EPOCH_RETIRED' }));
    const id = ++sequence;
    operation.connectionEpoch ??= readFacts().game.connectionEpoch;
    operation.configRevision ??= appliedRevision;
    const args = { service, method, body: Buffer.from(body || []), timeout, options,
      configRevision: operation.configRevision, connectionEpoch: operation.connectionEpoch };
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject, method: `${service}.${method}` });
      try { port.postMessage({ kind: 'business_request', id, sequence: id, body: encode(args) }); }
      catch (error) { pending.delete(id); reject(error); }
    });
  }
  const networkEvents = new EventEmitter();
  const add = networkEvents.on;
  const wrappers = new Map();
  networkEvents.on = networkEvents.addListener = function (name, listener) {
    let byName = wrappers.get(listener); if (!byName) { byName = new Map(); wrappers.set(listener, byName); }
    let wrapped = byName.get(name);
    if (!wrapped) {
      wrapped = (...args) => gate.run(`network:${name}`, () => listener(...args)).catch(error => {
        port.postMessage({ type: 'error', error: error.message });
      });
      byName.set(name, wrapped);
    }
    return add.call(this, name, wrapped);
  };
  const remove = networkEvents.removeListener;
  networkEvents.off = networkEvents.removeListener = function (name, listener) {
    return remove.call(this, name, wrappers.get(listener)?.get(name) || listener);
  };
  const network = { networkEvents, getUserState: () => { readFacts(); return userState; },
    getWs: () => { readFacts(); return facts.game.socketPresent ? socketFor(facts.game.connectionEpoch) : null; },
    isConnected: () => readFacts().game.readyState === 1 && facts.game.socketPresent,
    connect: (code, callback) => { onReady = callback; return command('network.connect', [code]); },
    sendMsgAsync,
    sendMsg: async (service, method, body, callback, timeout, options) => {
      try { const value = await sendMsgAsync(service, method, body, timeout, options); callback?.(null, value.body, value.meta); }
      catch (error) { callback?.(error); }
    },
    correctSessionWallet: (kind, input) => command(`wallet.${kind}`, [input]),
  };
  for (const method of NETWORK_READ_METHODS) network[method] = (...args) => query(`network.${method}`, args);
  for (const method of ['reconnect', 'cleanup', 'stopNetwork', 'pauseAceReports', 'resumeAceReports'])
    network[method] = (...args) => command(`network.${method}`, args);
  network.applyServerVersionInfo = info => {
    const version = network.extractServerClientVersion(info);
    if (version) require('../config/config').CONFIG.clientVersion = version;
    return Boolean(version);
  };
  const stats = {};
  for (const method of STATS_METHODS) stats[method] = (...args) => (STATS_READ_METHODS.has(method) ? query : command)(`stats.${method}`, args);
  const status = { statusData, initStatusBar: () => false, cleanupStatusBar: () => {}, setRecordGoldExpHook: () => {} };
  for (const method of STATUS_METHODS) status[method] = (...args) => command(`status.${method}`, args);
  const governor = {};
  for (const method of GOVERNOR_METHODS) governor[method] = (...args) => (GOVERNOR_READ_METHODS.has(method) ? query : command)(`governor.${method}`, args);
  function install(relative, exports) {
    const filename = require.resolve(relative);
    require.cache[filename] = { id: filename, filename, loaded: true, exports };
  }
  install('../utils/network', network); install('../services/stats', stats); install('../services/status', status);
  install('../services/request-governor', governor);
  install('../utils/idle-protection', { ...idle,
    getIdleProtectionUntil: (...args) => query('idle.getIdleProtectionUntil', args),
    setIdleProtectionUntil: (...args) => command('idle.setIdleProtectionUntil', args) });
  const nativeSyncClock = utils.syncServerTime;
  utils.syncServerTime = (...args) => { const result = command('clock.syncServerTime', args); nativeSyncClock(...args); return result; };
  port.on('message', message => {
    if (message?.kind !== 'game_reply') return;
    const callback = pending.get(message.id); if (!callback) return;
    pending.delete(message.id);
    try {
      const reply = decode(message.body, { lookupType });
      if (reply.error) callback.reject(fatalControlError(reply.error)
        ? failControl(reply.error.code, 'request', callback.method, reply.error) : reply.error);
      else { applyFacts(reply.value.facts); callback.resolve(reply.value.value); }
    } catch (error) { callback.reject(failControl('SESSION_BAD_GAME_REPLY', 'request', callback.method, error)); }
  });
  function deliver(event) {
    applyFacts(event.facts);
    if (event.facts.game.connectionEpoch !== readFacts().game.connectionEpoch) return Promise.resolve();
    // Preserve the physical origin even if a delayed callback runs after a
    // reconnect. Local queries must not silently relabel the event's authority.
    return gate.runEvent(`transport:${event.name}`, async () => {
      const args = decode(event.args, { lookupType });
      if (event.name === 'initialBagNeeded') {
        try {
          const warehouse = require('../services/warehouse');
          const bag = await warehouse.getBag(); const input = {};
          for (const item of warehouse.getBagItems(bag) || []) {
            const id = utils.toNum(item.id); const count = utils.toNum(item.count);
            if (id === 1004) input.diamond = count;
            else if (id === 1005 && count > 0) input.goldBean = count;
          }
          command('wallet.initialBag', [input]);
        } catch { /* Same optional startup read as the legacy network. */ }
      } else if (event.name === 'login_ready') await onReady?.();
      else networkEvents.emit(event.name, ...args);
    }, event.facts.game.connectionEpoch);
  }
  gate.setAuthorityProvider(() => ({ connectionEpoch: facts.game.connectionEpoch, configRevision: appliedRevision }));
  return { deliver, applyFacts, readFacts, command, query, network, pending, blockControl,
    observeReadiness: callback => { readinessObserver = callback; callback(facts.game); },
    setLoginCallback: callback => { onReady = callback; },
    setAppliedRevision: revision => { appliedRevision = Number(revision) || 0; },
    encodeCheckpoint: value => encode(value, { special: item => {
      for (const [epoch, socket] of sockets) if (item === socket) return { kind: 'sessionSocket', epoch };
    } }),
    decodeCheckpoint: value => decode(value, codecOptions) };
}
module.exports = { createSessionBusinessBridge };
