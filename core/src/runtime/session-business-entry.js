const { parentPort, workerData } = require('node:worker_threads');
const { encode, decode } = require('./session-codec');
const { createBusinessGate } = require('./business-gate');
const state = require('../services/business-state');
const timers = require('../services/session-scheduler');
const { createSessionBusinessBridge } = require('./session-business-bridge');

if (!workerData?.sessionBusiness || process.env.FARM_SESSION_BUSINESS !== '1') throw new Error('Business entry requires a session host');
const gate = createBusinessGate(workerData.epoch);
state.setBusinessGate(gate);
const bridge = createSessionBusinessBridge({ port: parentPort, gate, initialFacts: decode(workerData.facts) });
globalThis.__farmSessionBridge = bridge;
let worker; let prepared = false; let activated = false; let checkpoint;
let config = decode(workerData.config);

async function deliver(events) {
  // Start listeners in source order. Their tracked asynchronous bodies retain
  // the legacy EventEmitter concurrency and are drained before any checkpoint.
  for (const event of events || []) bridge.deliver(event).catch(error => parentPort.postMessage({ type: 'error', error: error.message }));
}
async function control(method, args) {
  if (method === 'prepare') {
    if (prepared) throw new Error('Business already prepared');
    await gate.prepare('prepare', async () => {
      const { loadProto } = require('../utils/proto'); await loadProto();
      require('./session-state-domains').loadBusinessDomains();
      worker = require('../core/worker');
      checkpoint = workerData.checkpoint ? bridge.decodeCheckpoint(workerData.checkpoint) : null;
      if (checkpoint) {
        state.restoreBusinessState(checkpoint.state);
        worker.sessionRuntime.restoreConfig(checkpoint.config);
        state.bindBusinessState();
        timers.restoreSessionSchedulers(checkpoint.timers);
      } else worker.sessionRuntime.restoreConfig(config);
    });
    prepared = true; return true;
  }
  if (!prepared) throw new Error('Business not prepared');
  if (method === 'activate') {
    gate.activate(); activated = true;
    if (!checkpoint) await gate.run('coldStart', () => worker.sessionRuntime.send({ type: 'start', config }));
    else {
      // Revision-only changes do not reset schedules or recreate configuration
      // edge actions. Actual changed policy follows the ordinary config path.
      await gate.run('warmConfig', () => worker.sessionRuntime.applyConfig(config, checkpoint.config));
    }
    await deliver(args); return true;
  }
  if (method === 'resumeProducers') { timers.resumeSessionSchedulers(); return true; }
  if (method === 'quiesce') {
    timers.pauseSessionSchedulers(); await gate.quiesce();
    if (bridge.pending.size) throw new Error('Business requests still active');
    return bridge.encodeCheckpoint({ state: state.snapshotBusinessState(), timers: timers.captureSessionSchedulers(),
      config: worker.sessionRuntime.config() });
  }
  if (method === 'relabelConfig') {
    config = args;
    return gate.prepare('relabelConfig', () => worker.sessionRuntime.relabelConfig(args));
  }
  if (method === 'resume') {
    gate.activate(); await deliver(args); timers.resumeSessionSchedulers(); return true;
  }
  if (method === 'event') { await deliver([args]); return true; }
  if (method === 'events') { await deliver(args); return true; }
  if (!activated) throw new Error('Business not active');
  if (method === 'syncConfig') {
    config = args;
    return gate.run('syncConfig', () => worker.sessionRuntime.applyConfig(args, worker.sessionRuntime.config()));
  }
  if (method === 'send') return gate.run('managementMessage', () => worker.sessionRuntime.send(args));
  throw new Error('Business method unsupported');
}
let queue = Promise.resolve();
parentPort.on('message', message => {
  if (message?.kind !== 'business_control') return;
  const operation = queue.then(() => control(message.method, decode(message.body)));
  queue = operation.catch(() => {});
  operation.then(value => ({ value }), error => ({ error })).then(reply => {
    parentPort.postMessage({ kind: 'business_reply', id: message.id, body: encode(reply) });
  }).catch(() => process.exit(1));
});
parentPort.postMessage({ kind: 'business_boot' });
