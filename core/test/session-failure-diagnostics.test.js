const test = require('node:test'); const assert = require('node:assert/strict');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'session-failure-evidence-test-'));
process.env.FARM_DATA_DIR = temporary;
test.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
const logged = []; const loggerPath = require.resolve('../src/services/logger');
require.cache[loggerPath] = { id: loggerPath, filename: loggerPath, loaded: true,
  exports: { createModuleLogger: () => ({ error: (_message, row) => logged.push(row) }) } };
const { createSessionFailureReporter } = require('../src/runtime/session-failure-diagnostics');
const { createSessionBusinessRuntime } = require('../src/runtime/session-business-runtime');
const { createSessionHostCore } = require('../src/runtime/session-host-core');
const { encode } = require('../src/runtime/session-codec');
function fixtureRoot() {
  const root = fs.mkdtempSync(path.join(temporary, 'synthetic-worker-')); const dir = path.join(root, 'core/src/runtime');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'session-business-entry.js'), `
    const {parentPort}=require('node:worker_threads');
    const {encode,decode}=require(${JSON.stringify(require.resolve('../src/runtime/session-codec'))});
    parentPort.on('message',m=>{const input=decode(m.body);
      if(input?.mode==='exit')process.exit(7);
      if(input?.mode==='throw')throw Object.assign(new Error('SYNTHETIC_SECRET'),{code:'ERR_WORKER_OUT_OF_MEMORY'});
      const reply=input?.mode==='reply-error'?{error:Object.assign(new Error('SYNTHETIC_SECRET'),{code:'SESSION_CONTROL_UNAVAILABLE'})}:{value:true};
      parentPort.postMessage({kind:'business_reply',id:m.id,body:encode(reply)});
    });parentPort.postMessage({kind:'business_boot'});`);
  return root;
}
function runtime() { return createSessionBusinessRuntime({ target: { runtimeRoot: fixtureRoot() }, epoch: 'synthetic-epoch',
  facts: { host: { accountId: 'synthetic' } }, config: {}, read: () => ({}),
  command: () => { throw new Error('No game commands'); }, request: () => { throw new Error('No game requests'); }, onMaster: () => {} }); }
test('failure evidence strips secrets, hashes epoch, bounds duplicates and survives a broken sink', () => {
  const rows = []; const report = createSessionFailureReporter({ epoch: 'SYNTHETIC_SECRET', write: row => rows.push(row) });
  for (let i = 0; i < 30; i++) report('event_rejection', { code: 'SYNTHETIC_SECRET', message: 'SYNTHETIC_SECRET' },
    { method: 'event', eventName: 'SYNTHETIC_SECRET', eventConnectionEpoch: 1, receiverCurrent: false });
  assert.equal(rows.length, 1); assert.equal(rows[0].failureReason, 'other'); assert.equal(rows[0].receiverCurrent, false);
  assert.match(rows[0].businessEpochHash, /^[a-f0-9]{64}$/); assert.equal(JSON.stringify(rows).includes('SYNTHETIC_SECRET'), false);
  assert.doesNotThrow(() => createSessionFailureReporter({ write: () => { throw new Error('sink'); } })('worker_exit', {}));
  assert.doesNotThrow(() => report('worker_error', { get code() { throw new Error('getter'); } }));
});
test('real Worker unexpected exit is recorded before next event and expected retirement is quiet', async () => {
  const start = logged.length; const r = await runtime();
  try { await r.prepare(); await assert.rejects(r.send({ mode: 'exit' }), { code: 'SESSION_BUSINESS_EXIT' });
    assert.equal(logged.length - start, 1); assert.equal(logged[start].phase, 'worker_exit'); assert.equal(logged[start].workerExitStatus, 7);
    await assert.rejects(r.event('disconnect', encode([]), {}), { code: 'SESSION_BUSINESS_EXIT' }); assert.equal(logged.length - start, 1);
  } finally { await r.terminate(); }
  const before = logged.length; const healthy = await runtime(); await healthy.prepare(); await healthy.terminate(); assert.equal(logged.length, before);
});
test('real Worker thrown error keeps safe cause while reply failures are bounded by method', async () => {
  const start = logged.length; const r = await runtime();
  try { await r.prepare(); await assert.rejects(r.send({ mode: 'throw' })); assert.equal(logged.length - start, 1);
    assert.equal(logged[start].phase, 'worker_error'); assert.equal(logged[start].failureReason, 'ERR_WORKER_OUT_OF_MEMORY');
  } finally { await r.terminate(); }
  const before = logged.length; const reply = await runtime();
  try { for (let i = 0; i < 3; i++) await assert.rejects(reply.send({ mode: 'reply-error' }), { code: 'SESSION_CONTROL_UNAVAILABLE' });
    assert.equal(logged.length - before, 1); assert.equal(logged[before].phase, 'reply_error'); assert.equal(logged[before].method, 'send');
    assert.equal(JSON.stringify(logged.slice(start)).includes('SYNTHETIC_SECRET'), false);
  } finally { await reply.terminate(); }
});
test('host normal disconnect is quiet and stale receiver failures cannot disable the new business', async () => {
  let callback; let connected = true; const pending = []; const failures = [];
  const game = { snapshot: () => ({ connected, connectionEpoch: 1, terminal: false }), syncConfig: c => c,
    onEvent: cb => { callback = cb; }, stop: () => {} };
  const core = createSessionHostCore({ identity: {}, game, validateTarget: async x => x,
    createBusiness: async () => ({ prepare: async () => {}, activate: async () => {}, resumeProducers: async () => {},
      deliverEvents: async () => {}, quiesce: async () => ({}), terminate: async () => {},
      event: () => new Promise((resolve, reject) => pending.push({ resolve, reject })) }) });
  core.events.on('business-error', x => failures.push(x));
  const target = commit => ({ runtimeRoot: '/synthetic', commit });
  await core.attach(target('one'), {}); const start = logged.length;
  connected = false; callback('disconnect', encode([])); pending.shift().resolve(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(logged.length, start); assert.equal(core.facts().business.ready, true);
  callback('disconnect', encode([])); callback('disconnect', encode([])); const old = pending.splice(0);
  await core.attach(target('two'), {});
  for (const p of old) p.reject(Object.assign(new Error('SYNTHETIC_SECRET'), { code: 'SESSION_BUSINESS_EXIT', exitCode: 7 }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(logged.length - start, 1); assert.equal(logged[start].phase, 'event_rejection');
  assert.equal(logged[start].receiverCurrent, false); assert.equal(logged[start].eventKind, 'disconnect');
  assert.equal(logged[start].workerExitStatus, 7); assert.equal(failures.length, 2); assert.equal(core.facts().business.ready, true);
  assert.equal(JSON.stringify(logged.slice(start)).includes('SYNTHETIC_SECRET'), false); await core.revoke();
});


test('default reporter retains safe cause through the actual private log sink', () => {
  const directory = fs.mkdtempSync(path.join(temporary, 'real-logger-'));
  const helper = require.resolve('../src/runtime/session-failure-diagnostics');
  const script = `
    const fs=require('node:fs'),path=require('node:path');
    require(${JSON.stringify(helper)}).createSessionFailureReporter({epoch:'SYNTHETIC_SECRET'})(
      'worker_exit',Object.assign(new Error('SYNTHETIC_SECRET'),{code:'SESSION_BUSINESS_EXIT',exitCode:7}));
    const timer=setInterval(()=>{
      const root=path.join(process.env.FARM_DATA_DIR,'logs');
      if(!fs.existsSync(root))return;
      const rows=fs.readdirSync(root).filter(f=>f.startsWith('combined-')&&f.endsWith('.log')).flatMap(f=>
        fs.readFileSync(path.join(root,f),'utf8').split('\\n').filter(Boolean).map(l=>{try{return JSON.parse(l)}catch{return null}}));
      const row=rows.find(x=>x?.event==='session_failure_evidence');
      if(row){console.log(JSON.stringify(row));clearInterval(timer);process.exit(0);}
    },20);setTimeout(()=>process.exit(2),5000);
  `;
  const env = { ...process.env, FARM_DATA_DIR: directory, NODE_OPTIONS: '' }; delete env.NODE_TEST_CONTEXT;
  const result = require('node:child_process').spawnSync(process.execPath, ['-e', script], { env, encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const rows = result.stdout.split('\n').map(l => { try { return JSON.parse(l); } catch { return null; } });
  const row = rows.find(x => x?.event === 'session_failure_evidence'); assert.ok(row);
  assert.equal(row.failureReason, 'SESSION_BUSINESS_EXIT'); assert.equal(row.workerExitStatus, 7);
  assert.match(row.businessEpochHash, /^[a-f0-9]{64}$/); assert.equal(result.stdout.includes('SYNTHETIC_SECRET'), false);
});
