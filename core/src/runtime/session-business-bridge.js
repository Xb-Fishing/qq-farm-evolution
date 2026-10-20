const { EventEmitter } = require('node:events');
const { encode, decode } = require('./session-codec');
const { STATS_METHODS, STATS_READ_METHODS, GOVERNOR_METHODS, GOVERNOR_READ_METHODS,
  STATUS_METHODS, NETWORK_READ_METHODS } = require('./session-game-adapter');

function createSessionBusinessBridge({ port, gate, initialFacts }) {
  let facts = initialFacts; let sequence = 0; let appliedRevision = 0; let onReady; let readinessObserver;
  const pending = new Map(); const sockets = new Map(); const userState = {}; const statusData = {};
  const syncBuffer = new SharedArrayBuffer(8 + 8 * 1024 * 1024); let syncHealthy = true;
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
    if (!syncHealthy) throw new Error('Session synchronous channel failed; discard this business instance');
    const buffer = syncBuffer; const header = new Int32Array(buffer, 0, 2);
    Atomics.store(header, 0, 0); Atomics.store(header, 1, 0);
    port.postMessage({ kind: 'business_sync', buffer, body: encode({ kind, method, args,
      connectionEpoch: kind === 'command' ? gate.operation()?.connectionEpoch : undefined }) });
    if (Atomics.wait(header, 0, 0, 15000) === 'timed-out' || Atomics.load(header, 0) !== 1) {
      syncHealthy = false;
      throw Object.assign(new Error('Session host unavailable'), { code: 'SESSION_CONTROL_UNAVAILABLE' });
    }
    const length = Atomics.load(header, 1);
    if (length < 1 || length > buffer.byteLength - 8) throw new Error('Invalid synchronous session reply');
    const reply = decode(Buffer.from(new Uint8Array(buffer, 8, length)), { lookupType });
    if (reply.error) throw reply.error;
    applyFacts(reply.value.facts); return reply.value.value;
  }
  function readFacts() { sync('facts'); return facts; }
  function query(method, args = []) { return sync('query', method, args); }
  function command(method, args = []) {
    const operation = gate.operation();
    if (!operation || operation.preparation) throw Object.assign(new Error('Business authority is not active'), { code: 'SESSION_EPOCH_RETIRED' });
    operation.connectionEpoch ??= readFacts().game.connectionEpoch;
    return sync('command', method, args);
  }
  function sendMsgAsync(service, method, body, timeout, options) {
    const operation = gate.operation();
    if (!operation || operation.preparation) return Promise.reject(Object.assign(new Error('Business authority is not active'), { code: 'SESSION_EPOCH_RETIRED' }));
    const id = ++sequence;
    operation.connectionEpoch ??= readFacts().game.connectionEpoch;
    operation.configRevision ??= appliedRevision;
    const args = { service, method, body: Buffer.from(body || []), timeout, options,
      configRevision: operation.configRevision, connectionEpoch: operation.connectionEpoch };
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
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
      if (reply.error) callback.reject(reply.error);
      else { applyFacts(reply.value.facts); callback.resolve(reply.value.value); }
    } catch (error) { callback.reject(error); }
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
  return { deliver, applyFacts, readFacts, command, query, network, pending,
    observeReadiness: callback => { readinessObserver = callback; callback(facts.game); },
    setLoginCallback: callback => { onReady = callback; },
    setAppliedRevision: revision => { appliedRevision = Number(revision) || 0; },
    encodeCheckpoint: value => encode(value, { special: item => {
      for (const [epoch, socket] of sockets) if (item === socket) return { kind: 'sessionSocket', epoch };
    } }),
    decodeCheckpoint: value => decode(value, codecOptions) };
}
module.exports = { createSessionBusinessBridge };
