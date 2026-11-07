const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');

const CODES = new Set(['SESSION_BUSINESS_EXIT', 'SESSION_CONTROL_UNAVAILABLE', 'SESSION_BAD_SYNC_REPLY',
  'SESSION_BAD_GAME_REPLY', 'SESSION_EPOCH_RETIRED', 'SESSION_REVOKED', 'SESSION_BINDING_REVOKED',
  'SESSION_CONNECTION_CHANGED', 'SESSION_GAME_NOT_READY', 'ERR_WORKER_OUT_OF_MEMORY',
  'ERR_WORKER_UNCAUGHT_EXCEPTION', 'ERR_WORKER_NOT_RUNNING']);
const KINDS = new Set(['worker_error', 'worker_exit', 'boot_timeout', 'control_timeout',
  'reply_error', 'reply_decode', 'control_post', 'event_rejection']);
const METHODS = new Set(['prepare', 'activate', 'resumeProducers', 'quiesce', 'resume',
  'relabelConfig', 'syncConfig', 'send', 'event', 'events']);
const EVENTS = new Set(['disconnect', 'ws_error', 'kickout', 'reconnect_failed', 'login_ready',
  'initialBagNeeded', 'raw_notify', 'landsChanged', 'friendLandsChanged']);
const integer = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const epochHash = value => typeof value === 'string' && value.length > 0 && value.length <= 256
  ? crypto.createHash('sha256').update(value).digest('hex') : null;

// Only controlled metadata enters the log. In particular, never copy an error
// message/stack, event payload, target path or arbitrary property into evidence.
function createSessionFailureReporter({ epoch, write } = {}) {
  const seen = new Set();
  let logger;
  return (kind, error, context = {}) => {
    try {
      if (!KINDS.has(kind)) return;
      const method = METHODS.has(context.method) ? context.method : 'other';
      const key = `${kind}:${method}`;
      if (seen.has(key) || seen.size >= 16) return;
      seen.add(key);
      const row = { event: 'session_failure_evidence', phase: kind, method,
        failureReason: CODES.has(error?.code) ? error.code : 'other',
        errorKind: ['Error', 'TypeError', 'RangeError', 'SyntaxError'].includes(error?.name) ? error.name : 'other',
        workerExitStatus: integer(error?.exitCode), businessEpochHash: epochHash(epoch),
        observedAt: Date.now(), monotonicMs: Math.round(performance.now()) };
      if (kind === 'event_rejection') Object.assign(row, {
        eventKind: EVENTS.has(context.eventName) ? context.eventName : 'other',
        receiverCurrent: context.receiverCurrent === true,
        eventConnectionEpoch: integer(context.eventConnectionEpoch),
        currentConnectionEpoch: integer(context.currentConnectionEpoch),
        eventSequence: integer(context.eventSequence),
        connected: context.connected === true, terminal: context.terminal === true,
      });
      if (write) write(row);
      else {
        logger ||= require('../services/logger').createModuleLogger('session-diagnostics');
        logger.error('常驻业务首错诊断', row);
      }
    } catch { /* Diagnostics must never change session authority or cleanup. */ }
  };
}
module.exports = { createSessionFailureReporter };
