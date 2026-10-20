const { AsyncLocalStorage } = require('node:async_hooks');
const { EventEmitter } = require('node:events');
const { encode } = require('./session-codec');
const { bindingIdentity } = require('./session-registry');
const { sessionError } = require('./session-host-core');

const STATS_METHODS = new Set(['recordOperation', 'recordTongQiGift', 'getTongQiGiftCount', 'getTongQiGiftLimit',
  'initStats', 'initStatsWithPersistence', 'updateStats', 'setInitialValues', 'recordGoldExp', 'resetSessionGains',
  'getStats', 'saveStats', 'getTodayKey', 'loadPersistedStats', 'checkAndResetDailyStats']);
const GOVERNOR_METHODS = new Set(['getRequestProfile', 'getBreakerState', 'clearBreaker', 'setWatchMode',
  'setContentionMode', 'setUrgentMode', 'urgentModeActive']);
const STATUS_METHODS = new Set(['setStatusPlatform', 'updateStatus', 'updateStatusFromLogin', 'updateStatusGold', 'updateStatusLevel']);
const NETWORK_READ_METHODS = new Set(['getWsErrorState', 'getAceStatus', 'getRequestProfile', 'getBreakerState',
  'buildLoginDeviceInfo', 'buildWebSocketHeaders', 'extractServerClientVersion']);
const STATS_READ_METHODS = new Set(['getTongQiGiftCount', 'getTongQiGiftLimit', 'getStats', 'getTodayKey', 'loadPersistedStats']);
const GOVERNOR_READ_METHODS = new Set(['getRequestProfile', 'getBreakerState', 'urgentModeActive']);
const MAINTENANCE = new Set(['gamepb.userpb.UserService.Login', 'gamepb.userpb.UserService.Heartbeat',
  'gamepb.acepb.AceService.AntiData']);

async function createSessionGameAdapter({ account, onRevoked = () => {}, onMaster = () => {} }) {
  const network = require('../utils/network'); const stats = require('../services/stats');
  const status = require('../services/status'); const governor = require('../services/request-governor');
  const store = require('../models/store'); const idle = require('../utils/idle-protection');
  const utils = require('../utils/utils'); const proto = require('../utils/proto');
  const { CONFIG } = require('../config/config');
  const authority = new AsyncLocalStorage(); const events = new EventEmitter();
  const expectedBinding = bindingIdentity(account); let stopped = false; let loginReady = false;
  let lastSocket = null; let connectionEpoch = 0; let configRevision = 0; let loginEpoch = 0; let policyIdentity = '';
  let loginReadyAt = 0; let firstLoginReadyAt = 0; let loginCredentialGeneration = ''; let terminationPending = false;
  CONFIG.platform = account.platform || 'qq'; status.setStatusPlatform(CONFIG.platform);
  utils.setLogHook((tag, msg, isWarn, meta) => onMaster({ type: 'log', data: {
    time: new Date().toLocaleString('sv-SE'), tag, msg, isWarn, meta: meta || {},
  } }));
  status.setRecordGoldExpHook((gold, exp) => { stats.recordGoldExp(gold, exp); onMaster({ type: 'stat_update', data: { gold, exp } }); });
  await proto.loadProto();

  function assertBinding() {
    const current = store.getAccounts().accounts.find(item => String(item.id) === String(account.id));
    if (stopped || !current || current.autoLogin === false || bindingIdentity(current) !== expectedBinding) {
      if (!stopped) { stopped = true; queueMicrotask(() => onRevoked('SESSION_BINDING_REVOKED')); }
      throw sessionError('SESSION_BINDING_REVOKED');
    }
  }
  function emit(name, args) { events.emit('game', name, encode(args)); }
  network.setSessionTransportHooks({
    assertSend(service, method) {
      assertBinding();
      const lease = authority.getStore();
      if (lease) {
        lease.assertSend();
        if (!loginReady) throw sessionError('SESSION_GAME_NOT_READY');
        return;
      }
      if (!MAINTENANCE.has(`${service}.${method}`)) throw sessionError('SESSION_REQUEST_WITHOUT_AUTHORITY');
    },
    // Business decoding/observation stays with the replaceable version. It uses
    // the same ordinary Bag read, before that physical login's ready callback.
    onInitialBag: () => emit('initialBagNeeded', []),
    onRawNotify: (type, body) => emit('raw_notify', [{ type, body: Buffer.from(body || []) }]),
  });
  const originalEmit = network.networkEvents.emit;
  network.networkEvents.emit = function (name, ...args) {
    if (name === 'disconnect' || name === 'kickout' || name === 'reconnect_failed') loginReady = false;
    if (name === 'kickout' || name === 'reconnect_failed' || (name === 'ws_error' && Number(args[0]?.code) === 400)) terminationPending = true;
    const result = originalEmit.call(this, name, ...args);
    emit(name, args); return result;
  };
  function snapshot() {
    const socket = network.getWs();
    if (socket && socket !== lastSocket) { lastSocket = socket; connectionEpoch++; }
    return { connectionEpoch, loginEpoch, configRevision, loginReadyAt, firstLoginReadyAt, loginCredentialGeneration,
      clientVersion: CONFIG.clientVersion, platform: CONFIG.platform,
      sessionGeneration: account.sessionGeneration, connected: loginReady && network.isConnected(),
      terminal: stopped || terminationPending,
      socketPresent: Boolean(socket), readyState: socket?.readyState ?? 3,
      userState: { ...network.getUserState() }, status: { ...status.statusData },
      clock: utils.getServerClockSnapshot(), idleProtectionUntil: idle.getIdleProtectionUntil(),
      wsError: network.getWsErrorState(), ace: network.getAceStatus() };
  }
  function syncConfig(config = {}) {
    assertBinding();
    const comparable = { ...config }; delete comparable.__revision; delete comparable.code; delete comparable.platform;
    const ordered = value => Array.isArray(value) ? value.map(ordered) : value && typeof value === 'object'
      ? Object.fromEntries(Object.keys(value).sort().map(key => [key, ordered(value[key])])) : value;
    const identity = JSON.stringify(ordered(comparable));
    if (identity !== policyIdentity) { policyIdentity = identity; configRevision++; }
    const patch = { ...config }; delete patch.knownFriendGids;
    store.applyConfigSnapshot(patch, { persist: false, accountId: account.id });
    if (store.getFriendQuietHours(account.id).idleProtectionEnabled !== true) idle.setIdleProtectionUntil(0);
    return { ...config, __revision: configRevision };
  }
  async function request(args, assertSend) {
    assertBinding();
    if (!loginReady) throw sessionError('SESSION_GAME_NOT_READY');
    if (!args || typeof args.service !== 'string' || typeof args.method !== 'string'
      || !(args.body instanceof Uint8Array)) throw sessionError('SESSION_REQUEST_INVALID');
    if (args.configRevision !== configRevision) throw sessionError('SESSION_CONFIG_CHANGED');
    return authority.run({ assertSend: () => {
      assertSend(); if (args.configRevision !== configRevision) throw sessionError('SESSION_CONFIG_CHANGED');
    } }, () => network.sendMsgAsync(args.service, args.method, Buffer.from(args.body), args.timeout, args.options || {}));
  }
  function wallet(kind, input = {}) {
    const state = network.getUserState();
    if (kind === 'coupon') state.coupon = Math.max(0, Number(input.value) || 0);
    else if (kind === 'seedCost') for (const amount of input.amounts || []) state.gold -= Number(amount) || 0;
    else if (kind === 'saleFallback') {
      if (Number(state.gold || 0) - Number(input.previousGold || 0) <= 0 && input.gain > 0) {
        state.gold = Number(state.gold || 0) + Number(input.gain); status.updateStatusGold(state.gold);
      }
    } else if (kind === 'initialBag') {
      if (input.diamond !== undefined) state.diamond = Number(input.diamond) || 0;
      if (Number(input.goldBean) > 0) state.goldBean = Number(input.goldBean);
    } else throw sessionError('SESSION_WALLET_COMMAND_INVALID');
    return { ...state };
  }
  function command(method, args = []) {
    assertBinding();
    const split = method.indexOf('.'); const domain = method.slice(0, split); const name = method.slice(split + 1);
    if (domain === 'stats' && STATS_METHODS.has(name)) return stats[name](...args);
    if (domain === 'governor' && GOVERNOR_METHODS.has(name)) return governor[name](...args);
    if (domain === 'status' && STATUS_METHODS.has(name)) return status[name](...args);
    if (domain === 'wallet') return wallet(name, args[0]);
    if (domain === 'clock' && name === 'syncServerTime') return utils.syncServerTime(...args);
    if (domain === 'idle' && name === 'getIdleProtectionUntil') return idle.getIdleProtectionUntil(...args);
    if (domain === 'idle' && name === 'setIdleProtectionUntil') return idle.setIdleProtectionUntil(...args);
    if (domain === 'network' && NETWORK_READ_METHODS.has(name)) return network[name](...args);
    if (domain === 'network' && ['pauseAceReports', 'resumeAceReports'].includes(name)) return network[name](...args);
    if (method === 'network.cleanup') return network.cleanup(...args);
    if (method === 'network.reconnect') return authority.exit(() => network.reconnect(...args));
    if (method === 'network.connect') {
      if (network.getWs()) throw sessionError('SESSION_CONNECTION_ALREADY_EXISTS');
      const credential = String(args[1] || account.credentialGeneration || '');
      return authority.exit(() => network.connect(args[0], () => {
        loginReady = true; terminationPending = false; loginEpoch++; loginReadyAt = Date.now(); firstLoginReadyAt ||= loginReadyAt;
        loginCredentialGeneration = credential; emit('login_ready', []);
      }));
    }
    if (['network.stopNetwork', 'network.close'].includes(method)) {
      // These are real account/network lifecycle operations. Warm replacement
      // never invokes the legacy stopBot path.
      network.stopNetwork(args[0] || '账号停止'); loginReady = false;
      queueMicrotask(() => onRevoked('SESSION_PHYSICAL_STOPPED')); return true;
    }
    throw sessionError('SESSION_COMMAND_UNSUPPORTED');
  }
  function query(method, args = []) {
    assertBinding();
    const [domain, name] = method.split('.');
    if (domain === 'stats' && STATS_READ_METHODS.has(name)) return stats[name](...args);
    if (domain === 'governor' && GOVERNOR_READ_METHODS.has(name)) return governor[name](...args);
    if (domain === 'network' && NETWORK_READ_METHODS.has(name)) return network[name](...args);
    if (method === 'idle.getIdleProtectionUntil') return idle.getIdleProtectionUntil(...args);
    throw sessionError('SESSION_QUERY_UNSUPPORTED');
  }
  function stop(reason) { stopped = true; loginReady = false; network.stopNetwork(reason); stats.saveStats(); }
  return { snapshot, syncConfig, request, command, query, stop, onEvent: callback => events.on('game', callback),
    copyEvent: args => Buffer.from(args), lookupType: name => proto.getRoot().lookupType(name),
    dispose: () => { network.networkEvents.emit = originalEmit; network.setSessionTransportHooks(null); } };
}
module.exports = { createSessionGameAdapter, STATS_METHODS, STATS_READ_METHODS, GOVERNOR_METHODS, GOVERNOR_READ_METHODS,
  STATUS_METHODS, NETWORK_READ_METHODS };
