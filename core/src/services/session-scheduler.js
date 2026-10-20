const { businessProducer } = require('./business-state');

let paused = true; let ordinal = 0;
const namespaces = new Map(); const bindings = new Map();
const keyFor = (namespace, name) => `${namespace}\0${name}`;

function createSessionScheduler(namespace, store, logger, timing = {}) {
  const now = timing.now || (() => Date.now());
  const timeout = timing.setTimeout || setTimeout; const interval = timing.setInterval || setInterval;
  const clearTimeoutFn = timing.clearTimeout || clearTimeout; const clearIntervalFn = timing.clearInterval || clearInterval;
  const records = store.timers;
  function current(record) { return records.get(record.name) === record; }
  function clearHandle(record) {
    if (record.handle !== null) {
      if (record.handleKind === 'interval') clearIntervalFn(record.handle); else clearTimeoutFn(record.handle);
      record.handle = null;
    }
  }
  function clear(name) {
    const record = records.get(String(name || '')); if (!record) return false;
    clearHandle(record); records.delete(record.name); return true;
  }
  function clearAll() { for (const name of [...records.keys()]) clear(name); }
  async function run(record, immediate = false) {
    if (paused || !current(record)) return;
    if (record.kind === 'interval' && !immediate) record.nextRunAt = now() + record.delayMs;
    if (record.preventOverlap && record.running) return;
    if (immediate) record.immediatePending = false;
    record.running = true; record.lastRunAt = now(); record.runCount++;
    try { await businessProducer(`${namespace}:${record.name}`, record.callback); }
    catch (error) {
      logger.warn(`[${namespace}] ${record.kind} 任务执行失败: ${record.name}`, {
        module: 'scheduler', scope: namespace, task: record.name, error: error?.message || String(error),
      });
    } finally {
      if (current(record)) {
        record.running = false;
        if (record.kind === 'timeout') records.delete(record.name);
      }
    }
  }
  function schedule(record) {
    if (paused || !current(record) || record.handle !== null) return;
    const delay = Math.max(0, record.nextRunAt - now());
    record.handleKind = 'timeout';
    record.handle = timeout(() => {
      if (paused || !current(record)) return;
      record.handle = null;
      if (record.kind === 'interval') {
        record.handleKind = 'interval';
        record.handle = interval(() => { run(record).catch(() => {}); }, record.delayMs);
      }
      run(record).catch(() => {});
    }, delay);
    if (record.immediatePending) Promise.resolve().then(() => run(record, true)).catch(() => {});
  }
  function bind(name, kind, callback) {
    name = String(name || '');
    if (!name || typeof callback !== 'function') throw new Error('Business timer binding invalid');
    bindings.set(keyFor(namespace, name), { kind, callback });
  }
  function create(name, kind, delay, callback, options = {}) {
    name = String(name || ''); bind(name, kind, callback); clear(name);
    const numeric = Number(delay); const delayMs = Math.max(kind === 'interval' ? 1 : 0,
      Number.isFinite(numeric) ? Math.floor(numeric) : kind === 'interval' ? 1000 : 0);
    const createdAt = now();
    const record = { name, kind, delayMs, callback, createdAt, nextRunAt: createdAt + delayMs,
      lastRunAt: 0, runCount: 0, running: false, preventOverlap: options.preventOverlap !== false,
      immediatePending: kind === 'interval' && options.runImmediately === true,
      handle: null, handleKind: '', ordinal: ++ordinal };
    records.set(name, record); schedule(record); return record.handle || record;
  }
  const api = {
    namespace,
    setTimeoutTask: (name, delay, callback) => create(name, 'timeout', delay, callback),
    setIntervalTask: (name, delay, callback, options) => create(name, 'interval', delay, callback, options),
    bindTimeoutTask: (name, callback) => bind(name, 'timeout', callback),
    bindIntervalTask: (name, callback) => bind(name, 'interval', callback),
    clear, clearAll, has: name => records.has(String(name || '')), getTaskNames: () => [...records.keys()],
    getSnapshot: () => ({ namespace, createdAt: store.createdAt, taskCount: records.size,
      tasks: [...records.values()].map(({ callback: _callback, handle: _handle, handleKind: _kind, ...record }) => record) }),
    pause: () => { for (const record of records.values()) clearHandle(record); },
    resume: () => { for (const record of records.values()) schedule(record); },
    scheduleRecord: schedule,
    store,
  };
  namespaces.set(namespace, api);
  return api;
}
function pauseSessionSchedulers() {
  paused = true;
  for (const api of namespaces.values()) api.pause();
}
function resumeSessionSchedulers() {
  paused = false;
  // Registration order breaks equal-deadline ties just as native timers did.
  const pending = [...namespaces.values()].flatMap(api => [...api.store.timers.values()].map(record => ({ api, record })))
    .sort((a, b) => a.record.nextRunAt - b.record.nextRunAt || a.record.ordinal - b.record.ordinal);
  for (const { api, record } of pending) api.scheduleRecord(record);
}
function captureSessionSchedulers() {
  if (!paused) throw new Error('Business timers must be paused before capture');
  const result = { version: 1, namespaces: [] };
  for (const [name, api] of namespaces) {
    const timers = [];
    for (const record of api.store.timers.values()) {
      if (record.running) throw new Error('Business timer still running');
      const { callback: _callback, handle: _handle, handleKind: _kind, ...saved } = record;
      timers.push(saved);
    }
    result.namespaces.push({ name, createdAt: api.store.createdAt, timers });
  }
  return result;
}
function restoreSessionSchedulers(snapshot) {
  if (!paused || snapshot?.version !== 1 || !Array.isArray(snapshot.namespaces)) throw new Error('Business timer checkpoint invalid');
  const planned = []; const names = new Set();
  for (const scope of snapshot.namespaces) {
    const api = namespaces.get(scope.name);
    if (!api || names.has(scope.name) || !Array.isArray(scope.timers)) throw new Error('Business timer namespace unavailable');
    names.add(scope.name); const tasks = new Set();
    for (const record of scope.timers) {
      const binding = bindings.get(keyFor(scope.name, record.name));
      if (!binding || binding.kind !== record.kind || tasks.has(record.name) || record.running
        || !['timeout', 'interval'].includes(record.kind) || !Number.isFinite(record.nextRunAt) || record.nextRunAt < 0
        || !Number.isSafeInteger(record.delayMs) || record.delayMs < (record.kind === 'interval' ? 1 : 0))
        throw new Error(`Business timer binding unavailable: ${scope.name}:${record.name}`);
      tasks.add(record.name); planned.push({ api, record: { ...record, callback: binding.callback, handle: null, handleKind: '' } });
    }
  }
  for (const api of namespaces.values()) api.clearAll();
  for (const scope of snapshot.namespaces) namespaces.get(scope.name).store.createdAt = scope.createdAt;
  for (const { api, record } of planned) { api.store.timers.set(record.name, record); ordinal = Math.max(ordinal, record.ordinal || 0); }
}
module.exports = { createSessionScheduler, pauseSessionSchedulers, resumeSessionSchedulers,
  captureSessionSchedulers, restoreSessionSchedulers };
