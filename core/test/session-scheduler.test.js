const test = require('node:test'); const assert = require('node:assert/strict');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const prefix = path.resolve(os.tmpdir(), 'session-timer-test-'); assert.equal(path.dirname(prefix), path.resolve(os.tmpdir()));
const temporary = fs.mkdtempSync(prefix); process.env.FARM_DATA_DIR = temporary;
const { setBusinessGate } = require('../src/services/business-state'); const { createBusinessGate } = require('../src/runtime/business-gate');
const { createSessionScheduler, pauseSessionSchedulers, resumeSessionSchedulers, captureSessionSchedulers, restoreSessionSchedulers } = require('../src/services/session-scheduler');
test.after(() => { pauseSessionSchedulers(); setBusinessGate(null); fs.rmSync(temporary, { recursive: true, force: true }); });
function clock() {
  let at = 1000; let sequence = 0; const tasks = new Map();
  const create = (callback, delay, repeat) => { const id = ++sequence; tasks.set(id, { callback, at: at + delay, repeat, id }); return id; };
  const timing = { now: () => at, setTimeout: (callback, delay) => create(callback, delay, 0), setInterval: (callback, delay) => create(callback, delay, delay),
    clearTimeout: id => tasks.delete(id), clearInterval: id => tasks.delete(id) };
  const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
  return { timing, settle, now: () => at, advance: async delta => {
    const end = at + delta;
    for (;;) {
      const next = [...tasks.values()].filter(task => task.at <= end).sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!next) break;
      at = next.at;
      if (next.repeat) next.at += next.repeat; else tasks.delete(next.id);
      next.callback(); await settle();
    }
    at = end; await settle();
  } };
}
let sequence = 0;
function scheduler(name, time) {
  return createSessionScheduler(name, { namespace: name, createdAt: time.now(), timers: new Map() }, { warn: () => {} }, time.timing);
}
function setup() { pauseSessionSchedulers(); const gate = createBusinessGate(`timers-${++sequence}`); setBusinessGate(gate); return { gate, time: clock(), name: `scope-${sequence}` }; }

test('warm timer restore keeps the original absolute deadline and rebinds the new callback once', async () => {
  const { gate, time, name } = setup(); let oldCalls = 0; let newCalls = 0;
  const old = scheduler(name, time); old.setTimeoutTask('once', 100, () => { oldCalls++; });
  gate.activate(); resumeSessionSchedulers(); await time.advance(40); pauseSessionSchedulers(); await gate.quiesce();
  const saved = captureSessionSchedulers(); const original = saved.namespaces.find(scope => scope.name === name).timers[0];
  assert.equal(original.nextRunAt, 1100);
  const next = scheduler(name, time); next.bindTimeoutTask('once', () => { newCalls++; });
  restoreSessionSchedulers(saved); gate.activate(); resumeSessionSchedulers();
  await time.advance(59); assert.equal(newCalls, 0); await time.advance(1);
  assert.equal(newCalls, 1); assert.equal(oldCalls, 0); assert.equal(next.has('once'), false);
  pauseSessionSchedulers(); next.clearAll();
});

test('interval restore preserves the next phase; an overdue tick runs once and keeps overlap prevention', async () => {
  const { gate, time, name } = setup(); const calls = []; let release;
  const hold = new Promise(resolve => { release = resolve; });
  const old = scheduler(name, time); old.setIntervalTask('interval', 100, async () => { calls.push('old'); await hold; });
  gate.activate(); resumeSessionSchedulers(); await time.advance(100); pauseSessionSchedulers();
  let drained = false; const pending = gate.quiesce().then(() => { drained = true; });
  await time.settle(); assert.equal(drained, false); assert.throws(captureSessionSchedulers, /still running/);
  release(); await pending; const saved = captureSessionSchedulers();
  assert.equal(saved.namespaces.find(scope => scope.name === name).timers[0].nextRunAt, 1200);
  await time.advance(350);
  const next = scheduler(name, time); next.bindIntervalTask('interval', () => { calls.push(time.now()); });
  restoreSessionSchedulers(saved); gate.activate(); resumeSessionSchedulers(); await time.advance(0);
  assert.deepEqual(calls, ['old', 1450]); await time.advance(100); assert.deepEqual(calls, ['old', 1450, 1550]);
  pauseSessionSchedulers(); next.clearAll();
});

test('a pending immediate interval callback is retained during quiescence and is not consumed twice', async () => {
  const { gate, time, name } = setup(); let calls = 0;
  const old = scheduler(name, time); old.setIntervalTask('immediate', 100, () => { calls++; }, { runImmediately: true });
  const saved = captureSessionSchedulers(); await time.settle(); assert.equal(calls, 0);
  const next = scheduler(name, time); next.bindIntervalTask('immediate', () => { calls++; }); restoreSessionSchedulers(saved);
  gate.activate(); resumeSessionSchedulers(); await time.settle(); assert.equal(calls, 1);
  await time.advance(100); assert.equal(calls, 2); pauseSessionSchedulers(); next.clearAll();
});

test('missing timer bindings reject before replacing the new instance state', () => {
  const { time, name } = setup(); const next = scheduler(name, time);
  next.setTimeoutTask('existing', 100, () => {});
  const snapshot = captureSessionSchedulers(); const scope = snapshot.namespaces.find(scope => scope.name === name); scope.timers[0].name = 'unknown';
  assert.throws(() => restoreSessionSchedulers(snapshot), /binding unavailable/);
  assert.equal(next.has('existing'), true); next.clearAll();
});
