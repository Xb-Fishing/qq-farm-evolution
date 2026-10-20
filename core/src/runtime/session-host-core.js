const { EventEmitter } = require('node:events');
const crypto = require('node:crypto');
const { encode } = require('./session-codec');
const { BUSINESS_DRAIN_TIMEOUT_MS } = require('./session-timeouts');

function sessionError(code) { return Object.assign(new Error(code), { code }); }

// All control mutations share a queue. Game requests stay concurrent, just as
// before; each is owned by one business epoch and one physical connection.
function createSessionHostCore({ identity, game, createBusiness, validateTarget }) {
  const events = new EventEmitter();
  let control = Promise.resolve(); let business = null; let epoch = null; let revoked = false;
  let factSequence = 0; let manager = null; let lastMasterStatus = null;
  let bufferEvents = false; let transition = null; const queuedEvents = [];
  const activeRequests = new Set();
  function facts() {
    return { sequence: ++factSequence, game: game.snapshot(), host: { ...identity },
      business: business ? { ...business.target, epoch: epoch?.id || '', ready: business.ready === true } : null };
  }
  function emitMaster(message) {
    if (message?.type === 'status_sync') lastMasterStatus = message;
    events.emit('master', { message, facts: facts() });
  }
  function deliverEvent(receiver, event) {
    const failed = () => {
      receiver.ready = false;
      if (receiver === business && epoch) epoch.allowed = false;
      events.emit('business-error', { code: 'SESSION_EVENT_DELIVERY_FAILED', facts: facts() });
    };
    try { Promise.resolve(receiver.event(event.name, event.args, event.facts)).catch(failed); }
    catch { failed(); }
  }
  function serialize(callback) {
    const result = control.then(callback); control = result.catch(() => {}); return result;
  }
  function assertEpoch(value) {
    if (revoked || !epoch || value !== epoch.id || !epoch.allowed) throw sessionError('SESSION_EPOCH_RETIRED');
    return epoch;
  }
  function assertLease(lease) {
    assertEpoch(lease.epoch);
    if (lease.closed || game.snapshot().connectionEpoch !== lease.connectionEpoch) throw sessionError('SESSION_CONNECTION_CHANGED');
  }
  function request(value, sequence, args) {
    let owner;
    try { owner = assertEpoch(value); } catch (error) { return Promise.reject(error); }
    if (!Number.isSafeInteger(sequence) || sequence < 1) return Promise.reject(sessionError('SESSION_REQUEST_SEQUENCE'));
    const signature = crypto.createHash('sha256').update(encode(args)).digest('hex');
    if (sequence <= owner.lastSequence) {
      const previous = owner.replies.get(sequence);
      if (!previous) return Promise.reject(sessionError('SESSION_REQUEST_OUTCOME_UNKNOWN'));
      if (previous.signature !== signature) return Promise.reject(sessionError('SESSION_REQUEST_ID_REUSED'));
      return previous.promise;
    }
    if (sequence !== owner.lastSequence + 1) return Promise.reject(sessionError('SESSION_REQUEST_SEQUENCE'));
    owner.lastSequence = sequence;
    const lease = { epoch: owner.id, connectionEpoch: args.connectionEpoch ?? game.snapshot().connectionEpoch, closed: false };
    owner.requestCount++;
    const promise = Promise.resolve().then(() => {
      assertLease(lease);
      return game.request(args, () => assertLease(lease));
    }).then(value => { assertLease(lease); return { value, facts: facts() }; });
    activeRequests.add(promise); owner.replies.set(sequence, { promise, signature });
    promise.finally(() => {
      lease.closed = true; activeRequests.delete(promise);
      // Keep bounded replies, while the sequence watermark permanently prevents
      // an expired request from being executed a second time in this epoch.
      while (owner.replies.size > 256) owner.replies.delete(owner.replies.keys().next().value);
    }).catch(() => {});
    return promise;
  }
  function command(value, method, args, connectionEpoch) {
    const owner = assertEpoch(value);
    if (connectionEpoch !== undefined && connectionEpoch !== game.snapshot().connectionEpoch)
      throw sessionError('SESSION_CONNECTION_CHANGED');
    owner.commandCount++;
    return { value: game.command(method, args), facts: facts() };
  }
  function query(method, args) {
    if (revoked) throw sessionError('SESSION_REVOKED');
    return { value: game.query(method, args), facts: facts() };
  }
  async function waitRequests(timeoutMs = BUSINESS_DRAIN_TIMEOUT_MS) {
    const deadline = Date.now() + timeoutMs;
    while (activeRequests.size) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw sessionError('SESSION_REQUEST_DRAIN_TIMEOUT');
      let timer;
      try { await Promise.race([Promise.allSettled([...activeRequests]), new Promise((_, reject) => {
        timer = setTimeout(() => reject(sessionError('SESSION_REQUEST_DRAIN_TIMEOUT')), remaining);
      })]); } finally { clearTimeout(timer); }
    }
  }
  function makeEpoch() { return { id: crypto.randomUUID(), allowed: false, lastSequence: 0, requestCount: 0, commandCount: 0, replies: new Map() }; }
  function takeEvents() { return queuedEvents.splice(0); }
  async function flushEvents(receiver) {
    for (let batch = 0; queuedEvents.length && batch < 16; batch++) await receiver.deliverEvents(takeEvents());
    if (queuedEvents.length) throw sessionError('SESSION_EVENT_DRAIN_BUSY');
  }
  function attach(target, config) {
    return serialize(async () => {
      if (revoked) throw sessionError('SESSION_REVOKED');
      target = await validateTarget(target);
      if (business?.ready && business.target.runtimeRoot === target.runtimeRoot && business.target.commit === target.commit
        && business.target.sourceFingerprint === target.sourceFingerprint) {
        config = game.syncConfig(config) || config; await business.syncConfig(config); business.config = config; return { ...facts(), unchanged: true };
      }
      const previous = business; const previousEpoch = epoch; let checkpoint; let candidate; let nextEpoch;
      events.emit('business-pins', [target.runtimeRoot, previous?.target?.runtimeRoot].filter(Boolean));
      try {
        if (previous) {
          bufferEvents = true; transition = { events: [] };
          checkpoint = await previous.quiesce();
          await waitRequests();
          if (previousEpoch) previousEpoch.allowed = false;
        }
        if (revoked) throw sessionError('SESSION_REVOKED');
        config = game.syncConfig(config) || config;
        nextEpoch = makeEpoch();
        candidate = await createBusiness({ target, config, checkpoint, epoch: nextEpoch.id, facts: facts(),
          request: (sequence, args) => request(nextEpoch.id, sequence, args),
          command: (method, args, origin) => command(nextEpoch.id, method, args, origin),
          query,
          read: () => facts(), onMaster: message => { if (epoch === nextEpoch && !revoked) emitMaster(message); } });
        candidate.target = target; candidate.config = config; candidate.ready = false;
        await candidate.prepare();
        if (revoked) throw sessionError('SESSION_REVOKED');
        // Authority moves only after the new code restored all domains and
        // bound its producers without running them.
        epoch = nextEpoch; business = candidate; nextEpoch.allowed = true;
        await candidate.activate(takeEvents());
        await flushEvents(candidate);
        bufferEvents = false;
        await candidate.resumeProducers();
        if (revoked || epoch !== nextEpoch) throw sessionError('SESSION_REVOKED');
        transition = null;
        candidate.ready = true;
        if (previous) await previous.terminate();
        events.emit('business-ready', facts());
        events.emit('business-pins', [candidate.target.runtimeRoot]);
        return facts();
      } catch (error) {
        if (nextEpoch) nextEpoch.allowed = false;
        // A failed activation that already issued requests must not roll back a
        // stale checkpoint. Keep its failed state available for explicit repair.
        if (!revoked && nextEpoch && (nextEpoch.requestCount > 0 || nextEpoch.commandCount > 0)) {
          candidate.ready = false; business = candidate; epoch = nextEpoch;
          if (previous) await previous.terminate().catch(() => {});
          transition = null; bufferEvents = false;
          for (const event of takeEvents()) deliverEvent(candidate, event);
          events.emit('business-pins', [candidate.target.runtimeRoot]);
          throw sessionError('SESSION_BUSINESS_ACTIVATION_OUTCOME_UNKNOWN');
        }
        if (candidate) await candidate.terminate().catch(() => {});
        if (revoked) {
          if (previous) await previous.terminate().catch(() => {});
          business = null; epoch = null; queuedEvents.length = 0; bufferEvents = false; transition = null;
        }
        if (!revoked && previous) {
          epoch = previousEpoch; business = previous; previousEpoch.allowed = true;
          const restoredConfig = game.syncConfig(previous.config) || previous.config;
          await previous.relabelConfig(restoredConfig);
          previous.config = restoredConfig;
          bufferEvents = true;
          const replay = transition ? transition.events.splice(0) : takeEvents(); queuedEvents.length = 0;
          await previous.resume(replay); await flushEvents(previous); bufferEvents = false; transition = null;
        } else if (!revoked) { business = null; epoch = null; }
        events.emit('business-pins', [business?.target?.runtimeRoot].filter(Boolean));
        throw error;
      }
    });
  }
  function dispatch(message) {
    return serialize(async () => {
      if (revoked || !business) throw sessionError('SESSION_BUSINESS_UNAVAILABLE');
      if (message?.type === 'config_sync') {
        const config = game.syncConfig(message.config || {}) || message.config;
        message = { ...message, config }; business.config = config;
      }
      if (message?.type === 'config_sync') await business.syncConfig(message.config);
      else await business.send(message);
      return facts();
    });
  }
  function revoke(reason = '账号停止') {
    // Revocation preempts a pending warm preparation, including an async encode.
    revoked = true; if (epoch) epoch.allowed = false;
    const closing = Promise.resolve().then(() => game.stop(reason));
    return serialize(async () => {
      await closing; await waitRequests();
      if (business) await business.terminate();
      business = null; epoch = null;
      return facts();
    });
  }
  function claimManager(next, isAlive) {
    if (typeof next?.id !== 'string' || !next.id || next.id.length > 128 || !next.pid || !next.starttime || !isAlive(next)) throw sessionError('SESSION_MANAGER_IDENTITY');
    if (manager && manager.id !== next.id && isAlive(manager)) throw sessionError('SESSION_MANAGER_ALREADY_ATTACHED');
    manager = { ...next }; return facts();
  }
  function detachManager(id) { if (manager?.id === id) manager = null; }
  game.onEvent?.((name, args) => {
    const snapshot = facts();
    const event = { name, args: game.copyEvent ? game.copyEvent(args) : args, facts: snapshot };
    transition?.events.push(event);
    if (bufferEvents) queuedEvents.push(event);
    else if (business) deliverEvent(business, event);
    events.emit('game-event', { name, args, facts: snapshot });
  });
  return { events, facts, attach, dispatch, revoke, request, command, query, claimManager, detachManager, receiveMaster: emitMaster,
    lastMasterStatus: () => lastMasterStatus, waitRequests,
    get revoked() { return revoked; }, get manager() { return manager; } };
}
module.exports = { createSessionHostCore, sessionError };
