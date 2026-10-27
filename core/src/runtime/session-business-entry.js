const { parentPort, workerData } = require('node:worker_threads');
const { encode, decode } = require('./session-codec');
const { createBusinessGate } = require('./business-gate');
const state = require('../services/business-state');
const timers = require('../services/session-scheduler');
const { createSessionBusinessBridge } = require('./session-business-bridge');
const { businessPolicyConfig } = require('./session-config');
const { createModuleLogger, redactString } = require('../services/logger');
const faultLogger = createModuleLogger('session-business');

if (!workerData?.sessionBusiness || process.env.FARM_SESSION_BUSINESS !== '1') throw new Error('Business entry requires a session host');
const gate = createBusinessGate(workerData.epoch);
state.setBusinessGate(gate);
let businessFailure;
function suspendFailedBusiness(detail = {}) {
  if (businessFailure) return;
  const reason = typeof detail.reason === 'string' && /^SESSION_[A-Z_]{1,64}$/.test(detail.reason)
    ? detail.reason : 'SESSION_EVENT_DELIVERY_FAILED';
  businessFailure = Object.assign(new Error(reason), { code: reason });
  timers.pauseSessionSchedulers(); gate.suspend(); bridge.blockControl(reason);
  faultLogger.error('常驻业务控制链异常', { event: 'session_business_fault', reason,
    phase: detail.phase || 'event_delivery', operation: detail.operation || '', method: detail.method || '',
    ...(Number.isFinite(detail.waitMs) ? { waitMs: detail.waitMs, waitCount: detail.waitCount,
      waitOutcome: detail.waitOutcome, controlState: detail.controlState } : {}),
    detail: redactString(String(detail.error?.stack || detail.error?.message || '')).slice(0, 3000) });
  parentPort.postMessage({ type: 'session_business_diagnostic', data: {
    reason, phase: detail.phase || 'event_delivery', operation: String(detail.operation || '').slice(0, 48),
    method: /^[a-z.]{0,96}$/i.test(detail.method || '') ? detail.method || '' : '',
    businessEpoch: workerData.epoch,
    ...(Number.isFinite(detail.waitMs) ? { waitMs: detail.waitMs, waitCount: detail.waitCount,
      waitOutcome: detail.waitOutcome, controlState: detail.controlState } : {}),
  } });
}
const bridge = createSessionBusinessBridge({ port: parentPort, gate, initialFacts: decode(workerData.facts), onControlFailure: suspendFailedBusiness });
globalThis.__farmSessionBridge = bridge;
let worker; let prepared = false; let activated = false; let checkpoint;
let config = businessPolicyConfig(decode(workerData.config));

async function deliver(events) {
  // Start listeners in source order. Their tracked asynchronous bodies retain
  // the legacy EventEmitter concurrency and are drained before any checkpoint.
  for (const event of events || []) {
    try { bridge.deliver(event).catch(error => parentPort.postMessage({ type: 'error', error: error.message })); }
    catch (error) { suspendFailedBusiness({ reason: error.code, phase: 'event_delivery', error }); throw error; }
  }
}
async function control(method, args) {
  if (['relabelConfig', 'syncConfig'].includes(method)) args = businessPolicyConfig(args);
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
  // A legacy host may attempt rollback after replacement preparation fails.
  // A known-failed instance can still drain/checkpoint, but cannot resume work.
  if (businessFailure && method !== 'quiesce') throw businessFailure;
  if (method === 'activate') {
    gate.activate(); activated = true;
    if (!checkpoint) await gate.run('coldStart', () => worker.sessionRuntime.send({ type: 'start', config }));
    else {
      // Revision-only changes do not reset schedules or recreate configuration
      // edge actions. Actual changed policy follows the ordinary config path.
      await gate.run('warmConfig', () => worker.sessionRuntime.applyConfig(config, checkpoint.config));
      await gate.run('rewardSchedule', () => worker.sessionRuntime.refreshRewardsSchedule());
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
