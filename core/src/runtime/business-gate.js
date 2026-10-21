const { AsyncLocalStorage } = require('node:async_hooks');
const crypto = require('node:crypto');
const { BUSINESS_DRAIN_TIMEOUT_MS } = require('./session-timeouts');

function createBusinessGate(epoch) {
  const context = new AsyncLocalStorage();
  const active = new Set();
  let open = false;
  let closed = false;
  let authorityProvider = null;
  function enter(name, callback, preparation = false, connectionEpoch) {
    const parent = context.getStore();
    // A draining operation may finish its own chain; an expired ALS callback
    // cannot resurrect that chain after its originating operation settled.
    if (closed || (parent ? parent.epoch !== epoch || !parent.live : !open && !preparation)) return Promise.resolve(undefined);
    const currentAuthority = parent ? null : authorityProvider?.();
    const authority = parent?.authority || { epoch: connectionEpoch ?? currentAuthority?.connectionEpoch,
      revision: currentAuthority?.configRevision };
    const operation = { id: crypto.randomUUID(), epoch, name, live: true,
      preparation: preparation || parent?.preparation === true, authority };
    Object.defineProperty(operation, 'connectionEpoch', { get: () => authority.epoch,
      set: value => { if (authority.epoch !== undefined && authority.epoch !== value) throw new Error('Business connection origin changed'); authority.epoch = value; } });
    Object.defineProperty(operation, 'configRevision', { get: () => authority.revision,
      set: value => { if (authority.revision !== undefined && authority.revision !== value) throw new Error('Business policy origin changed'); authority.revision = value; } });
    let resolve; let reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    active.add(promise);
    promise.finally(() => { operation.live = false; active.delete(promise); }).catch(() => {});
    // EventEmitter listeners historically begin synchronously. Keep mutations
    // before their first await in the same turn while tracking their full body.
    try { Promise.resolve(context.run(operation, callback)).then(resolve, reject); }
    catch (error) { reject(error); }
    return promise;
  }
  const run = (name, callback) => enter(name, callback);
  async function quiesce(timeoutMs = BUSINESS_DRAIN_TIMEOUT_MS) {
    open = false;
    const deadline = Date.now() + timeoutMs;
    while (active.size) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error('Business drain timed out');
      let timer;
      try {
        await Promise.race([Promise.allSettled([...active]), new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('Business drain timed out')), remaining);
        })]);
      } finally { clearTimeout(timer); }
    }
  }
  return { run, quiesce,
    setAuthorityProvider: callback => { authorityProvider = callback; },
    runProducer: (name, callback) => context.exit(() => enter(name, callback)),
    runEvent: (name, callback, connectionEpoch) => context.exit(() => enter(name, callback, false, connectionEpoch)),
    prepare: (name, callback) => context.exit(() => enter(name, callback, true)),
    suspend: () => { open = false; },
    activate: () => { if (closed) throw new Error('Business epoch retired'); open = true; },
    retire: () => { closed = true; open = false; },
    operation: () => { const value = context.getStore(); return !closed && value?.live && value.epoch === epoch ? value : undefined; },
    get active() { return active.size; }, get open() { return open && !closed; } };
}
module.exports = { createBusinessGate };
