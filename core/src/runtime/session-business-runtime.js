const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { encode, decode } = require('./session-codec');
const { BUSINESS_CONTROL_TIMEOUT_MS, BUSINESS_BOOT_TIMEOUT_MS } = require('./session-timeouts');

// The host never imports gameplay from a new release into its module cache.
// Each candidate gets a separate Worker and a separate business authority.
async function createSessionBusinessRuntime(options) {
  const worker = new Worker(path.join(options.target.runtimeRoot, 'core/src/runtime/session-business-entry.js'), {
    workerData: { sessionBusiness: true, accountId: String(options.facts.host.accountId),
      epoch: options.epoch, facts: encode(options.facts), config: encode(options.config), checkpoint: options.checkpoint },
    env: { ...process.env, FARM_SESSION_ROLE: 'business', FARM_SESSION_BUSINESS: '1',
      FARM_ACCOUNT_ID: String(options.facts.host.accountId), FARM_SESSION_EPOCH: options.epoch },
    execArgv: process.execArgv.filter(value => !value.startsWith('--inspect')),
  });
  const waiting = new Map(); let sequence = 0; let dead = false; let failure;
  let bootResolve; let bootReject;
  const boot = new Promise((resolve, reject) => { bootResolve = resolve; bootReject = reject; });
  function fail(error) {
    if (dead) return;
    dead = true; failure = error; bootReject(error);
    for (const pending of waiting.values()) { clearTimeout(pending.timer); pending.reject(error); }
    waiting.clear();
  }
  worker.on('error', fail);
  worker.on('exit', code => fail(Object.assign(new Error('Business Worker exited'), { code: 'SESSION_BUSINESS_EXIT', exitCode: code })));
  worker.on('message', message => {
    if (message?.kind === 'business_boot') { bootResolve(); return; }
    if (message?.kind === 'business_reply') {
      const pending = waiting.get(message.id); if (!pending) return;
      waiting.delete(message.id); clearTimeout(pending.timer);
      try { const result = decode(message.body); result.error ? pending.reject(result.error) : pending.resolve(result.value); }
      catch (error) { pending.reject(error); }
      return;
    }
    if (message?.kind === 'business_sync') {
      const header = new Int32Array(message.buffer, 0, 2);
      try {
        const request = decode(message.body);
        const value = request.kind === 'facts' ? { facts: options.read() }
          : request.kind === 'query' ? options.query(request.method, request.args)
            : request.kind === 'command' ? options.command(request.method, request.args, request.connectionEpoch) : (() => { throw new Error('Invalid business command'); })();
        const body = encode({ value });
        if (body.length > message.buffer.byteLength - 8) throw new Error('Business synchronous reply too large');
        new Uint8Array(message.buffer, 8, body.length).set(body);
        Atomics.store(header, 1, body.length); Atomics.store(header, 0, 1);
      } catch (error) {
        const body = encode({ error });
        if (body.length <= message.buffer.byteLength - 8) {
          new Uint8Array(message.buffer, 8, body.length).set(body);
          Atomics.store(header, 1, body.length); Atomics.store(header, 0, 1);
        } else Atomics.store(header, 0, 2);
      }
      Atomics.notify(header, 0); return;
    }
    if (message?.kind === 'business_request') {
      Promise.resolve().then(() => options.request(message.sequence, decode(message.body)))
        .then(value => ({ value }), error => ({ error }))
        .then(result => { if (!dead) worker.postMessage({ kind: 'game_reply', id: message.id, body: encode(result) }); })
        .catch(fail);
      return;
    }
    if (!message?.kind && message?.type) options.onMaster(message);
  });
  async function call(method, args) {
    await boot;
    if (dead) throw failure;
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { waiting.delete(id); reject(new Error(`Business control timed out: ${method}`)); }, BUSINESS_CONTROL_TIMEOUT_MS);
      waiting.set(id, { resolve, reject, timer });
      try { worker.postMessage({ kind: 'business_control', id, method, body: encode(args) }); }
      catch (error) { clearTimeout(timer); waiting.delete(id); reject(error); }
    });
  }
  // A failed boot must not strand a host's attach queue forever.
  const bootTimer = setTimeout(() => { fail(new Error('Business Worker boot timed out')); worker.terminate(); }, BUSINESS_BOOT_TIMEOUT_MS);
  boot.finally(() => clearTimeout(bootTimer)).catch(() => {});
  return {
    prepare: () => call('prepare'), activate: events => call('activate', events),
    resumeProducers: () => call('resumeProducers'), quiesce: () => call('quiesce'),
    resume: events => call('resume', events), relabelConfig: config => call('relabelConfig', config),
    syncConfig: config => call('syncConfig', config), send: message => call('send', message),
    event: (name, args, facts) => call('event', { name, args, facts }), deliverEvents: events => call('events', events),
    terminate: async () => { fail(new Error('Business Worker retired')); await worker.terminate(); },
  };
}
module.exports = { createSessionBusinessRuntime };
