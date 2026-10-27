const test = require('node:test'); const assert = require('node:assert/strict');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const vm = require('node:vm'); const { Worker } = require('node:worker_threads'); const { performance } = require('node:perf_hooks');
const { createRequire } = require('node:module'); const { EventEmitter } = require('node:events');
const prefix = path.resolve(os.tmpdir(), 'session-wakeup-order-'); assert.equal(path.dirname(prefix), path.resolve(os.tmpdir()));
const temporary = fs.mkdtempSync(prefix); process.env.FARM_DATA_DIR = temporary;
test.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
const source = path.resolve(__dirname, '../src');
const { encode, decode } = require('../src/runtime/session-codec');
const { createSessionHostCore } = require('../src/runtime/session-host-core');
const { createBusinessGate } = require('../src/runtime/business-gate');
const { loadProto, types } = require('../src/utils/proto');
const actor = path.resolve(temporary, 'actual-callers.cjs'); assert.equal(path.dirname(actor), temporary);
// No wait return, timeout or server error is fabricated. The extra barrier fixes
// a legal thread schedule between publishing reply 1 and notifying its waiter.
const actorSource = `
const {parentPort,workerData}=require('node:worker_threads');const path=require('node:path');const {performance}=require('node:perf_hooks');
const root=workerData.source;const {decode}=require(path.join(root,'runtime/session-codec'));const gate=require(path.join(root,'runtime/business-gate')).createBusinessGate(workerData.epoch);
require(path.join(root,'services/business-state')).setBusinessGate(gate);const barrier=new Int32Array(workerData.barrier);let first=true,waits=0,earlyWake=false;const trace=[];const nativeWait=Atomics.wait;
Atomics.wait=function(header,...args){waits++;if(earlyWake)Atomics.store(barrier,0,4);const result=nativeWait(header,...args);trace.push({result,state:Atomics.load(header,0)});if(result==='ok'&&Atomics.load(header,0)===0){earlyWake=true;Atomics.store(barrier,0,2);}return result;};
const port={on:(...args)=>parentPort.on(...args),postMessage:message=>{parentPort.postMessage(message);if(first&&message.kind==='business_sync'){first=false;const header=new Int32Array(message.buffer,0,2);const until=performance.now()+5000;while(Atomics.load(header,0)===0&&performance.now()<until){}}}};
const bridge=require(path.join(root,'runtime/session-business-bridge')).createSessionBusinessBridge({port,gate,initialFacts:decode(workerData.facts),onControlFailure:detail=>parentPort.postMessage({kind:'diagnostic',reason:detail.reason})});
bridge.setAppliedRevision(1);globalThis.__farmSessionBridge=bridge;gate.activate();
(async()=>{let done=false;await gate.run('real-caller',async()=>{
if(workerData.mode.startsWith('auto-bad')){await require(path.join(root,'utils/proto')).loadProto();require(path.join(root,'models/store')).applyConfigSnapshot({platform:'wx',autoBadFriendGids:[9101],automation:{friend_bad:true},friendQuietHours:{enabled:false,pauseUntil:'',idleProtectionEnabled:false}},{persist:false,accountId:process.env.FARM_ACCOUNT_ID});
const bad=require(path.join(root,'services/friend-auto-bad'));bad.startAutoBadLoop();if(workerData.mode==='auto-bad-evidence')require(path.join(root,'services/friend-activity')).recordActivity(9101,Date.now(),'at_home','synthetic');await bad.runTickBody();done=bad.getSessionStateForTests(9101).done;
}else{bridge.network.getUserState();if(workerData.mode==='command')bridge.command('stats.recordOperation',['steal',1]);else bridge.network.isConnected();}
});parentPort.postMessage({kind:'result',ok:true,waits,done,trace});})().catch(error=>{Atomics.store(barrier,0,3);parentPort.postMessage({kind:'result',ok:false,waits,error:{code:error.code,message:error.message}});}).finally(()=>parentPort.close());
`;
assert.doesNotThrow(() => new vm.Script(actorSource, { filename: actor })); fs.writeFileSync(actor, actorSource, { mode: 0o600 });

async function actualCaller(mode) {
  const messages = []; const requests = []; const hostErrors = []; let commands = 0; let connections = 0; let stops = 0;
  const now = Math.floor(Date.now() / 1000); const land = { id: 1, plant: { id: 1001001, phases: [{ phase: 2, begin_time: now - 30 }], insect_owners: [], weed_owners: [] } };
  const core = createSessionHostCore({ identity: { hostId: 'synthetic-wakeup-host', accountId: 'synthetic-wakeup-account' },
    validateTarget: async target => target,
    createBusiness: async () => ({ prepare: async () => {}, activate: async () => {}, resumeProducers: async () => {}, terminate: async () => {} }),
    game: { snapshot: () => ({ platform: 'wx', connectionEpoch: 1, loginEpoch: 1, firstLoginReadyAt: 123, connected: true,
      readyState: 1, socketPresent: true, userState: { gid: 9001, level: 10 }, status: {}, clock: {} }),
    syncConfig: value => value, stop: () => { stops++; },
    command: method => { commands++; if (method === 'network.connect') connections++; }, query: () => 0,
    request: async args => {
      requests.push(args.method); let body;
      if (args.method === 'Enter') body = types.VisitEnterReply.encode({ lands: [land], at_home: true, basic: { gid: 9101, name: 'Example friend' } }).finish();
      else if (args.method === 'CheckCanOperate') body = types.CheckCanOperateReply.encode({ can_operate: true }).finish();
      else if (args.method === 'PutInsects' || args.method === 'PutWeeds') body = types[args.method === 'PutInsects' ? 'PutInsectsReply' : 'PutWeedsReply'].encode({ lands: [land] }).finish();
      else if (args.method === 'Leave') body = Buffer.alloc(0);
      else throw new Error('Unexpected synthetic upstream method');
      return { body };
    } } });
  await core.attach({ runtimeRoot: temporary, commit: 'synthetic-wakeup', sourceFingerprint: 'synthetic-wakeup' }, {});
  const initial = core.facts(); const epoch = initial.business.epoch; const barrierBuffer = new SharedArrayBuffer(4); const barrier = new Int32Array(barrierBuffer);
  const worker = new Worker(actor, { workerData: { source, epoch, facts: encode(initial), mode, barrier: barrierBuffer },
    env: { ...process.env, FARM_SESSION_BUSINESS: '1', FARM_ACCOUNT_ID: 'synthetic-wakeup-account' } });
  let first = true; let notified = 0; let timer;
  try {
    const result = await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Controlled wakeup-order scenario did not finish')), 20000);
      worker.on('error', reject);
      worker.on('message', message => {
        messages.push(message);
        if (message.kind === 'result') { resolve(message); return; }
        if (message.kind === 'business_sync') {
          const header = new Int32Array(message.buffer, 0, 2);
          try {
            const input = decode(message.body); const value = input.kind === 'facts' ? { facts: core.facts() }
              : input.kind === 'query' ? core.query(input.method, input.args) : core.command(epoch, input.method, input.args, input.connectionEpoch);
            const body = encode({ value }); new Uint8Array(message.buffer, 8, body.length).set(body);
            Atomics.store(header, 1, body.length); Atomics.store(header, 0, 1);
            if (first) {
              first = false; const deadline = performance.now() + 5000;
              while (Atomics.load(header, 0) === 1 && performance.now() < deadline) { /* Wait until reply 1 is consumed. */ }
              while (Atomics.load(header, 0) === 0 && performance.now() < deadline) {
                notified = Atomics.notify(header, 0, 1); if (notified) break;
              }
              while (![3, 4].includes(Atomics.load(barrier, 0)) && performance.now() < deadline) { /* Observe old failure or the corrected predicate wait. */ }
            } else Atomics.notify(header, 0);
          } catch (error) { hostErrors.push(error.message); reject(error); }
        } else if (message.kind === 'business_request') {
          core.request(epoch, message.sequence, decode(message.body)).then(value => ({ value }), error => ({ error }))
            .then(reply => worker.postMessage({ kind: 'game_reply', id: message.id, body: encode(reply) })).catch(reject);
        }
      });
    });
    assert.equal(result.ok, true, JSON.stringify(result.error));
    assert.equal(result.trace.some(row => row.result === 'ok' && row.state === 0), true, 'native wake occurred before the current reply was ready'); assert.equal(notified, 1, 'old notify really woke a later wait');
    assert.equal(Atomics.load(barrier, 0), 4, 'the caller waited again for the unfinished current reply');
    assert.deepEqual(hostErrors, []); assert.equal(messages.some(row => row.kind === 'diagnostic'), false);
    assert.equal(core.facts().business.epoch, epoch); assert.equal(core.facts().game.connectionEpoch, 1);
    assert.equal(connections, 0); assert.equal(stops, 0);
    return { result, requests, commands, syncCount: messages.filter(row => row.kind === 'business_sync').length };
  } finally { clearTimeout(timer); await worker.terminate(); await core.revoke(); }
}

test('actual consecutive connection reads survive a previous notification waking the next wait', { timeout: 25000 }, async () => {
  const result = await actualCaller('facts'); assert.equal(result.syncCount, 2); assert.equal(result.commands, 0); assert.deepEqual(result.requests, []);
});

test('the same legal wakeup order executes a command once without resending or replacing its business', { timeout: 25000 }, async () => {
  const result = await actualCaller('command'); assert.equal(result.syncCount, 2); assert.equal(result.commands, 1); assert.deepEqual(result.requests, []);
});

test('actual online-mischief empty and evidence paths retain real myGid, connection checks, visit and write guards', { timeout: 30000 }, async () => {
  await loadProto();
  const empty = await actualCaller('auto-bad-empty'); assert.deepEqual(empty.requests, []);
  const evidence = await actualCaller('auto-bad-evidence');
  assert.deepEqual(evidence.requests, ['Enter', 'CheckCanOperate', 'PutInsects', 'CheckCanOperate', 'PutWeeds', 'Leave']);
  assert.equal(evidence.result.done, true);
});

function deadlineFixture(mode) {
  const filename = path.join(source, 'runtime/session-business-bridge.js'); const native = createRequire(filename); const module = { exports: {} };
  const gate = createBusinessGate('synthetic-deadline'); const port = new EventEmitter(); const faults = []; const waits = []; let posts = 0; let now = 0;
  port.postMessage = message => { posts++; if (mode === 'malformed') Atomics.store(new Int32Array(message.buffer, 0, 2), 0, 2); };
  const localRequire = Object.assign(name => name === './session-codec' ? { encode: () => Buffer.alloc(0), decode: () => assert.fail('no incomplete reply can be decoded') }
    : name === 'node:perf_hooks' ? { performance: { now: () => now } } : native(name), native);
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module, exports: module.exports, require: localRequire, SharedArrayBuffer, Buffer,
    Atomics: { load: Atomics.load, store: Atomics.store, wait: (_header, _index, _value, remaining) => {
      waits.push(remaining); now += 3000; return now < 15000 ? 'ok' : 'timed-out';
    } } }, { filename });
  const bridge = module.exports.createSessionBusinessBridge({ port, gate, initialFacts: { sequence: 1, game: { connectionEpoch: 1, userState: {}, status: {}, clock: {} } },
    onControlFailure: detail => { faults.push(detail); gate.suspend(); } }); gate.activate();
  return { bridge, gate, faults, waits, posts: () => posts };
}

test('early wakes keep the original total deadline, one outbound call, and fatal handling for genuinely missing replies', async () => {
  for (const mode of ['read', 'command']) {
    const f = deadlineFixture(mode);
    await f.gate.run('deadline', () => assert.throws(() => mode === 'command'
      ? f.bridge.command('stats.recordOperation', ['steal', 1]) : f.bridge.readFacts(), { code: 'SESSION_CONTROL_UNAVAILABLE' }));
    assert.deepEqual(f.waits, [15000, 12000, 9000, 6000, 3000]); assert.equal(f.posts(), 1);
    assert.equal(f.faults[0].waitMs, 15000); assert.equal(f.faults[0].waitCount, 5); assert.equal(f.faults[0].controlState, 0);
    assert.equal(f.gate.open, false); assert.throws(() => f.bridge.readFacts()); assert.equal(f.posts(), 1, 'no unknown operation is replayed');
  }
});

test('malformed completion remains fatal without waiting or inventing a result', () => {
  const f = deadlineFixture('malformed'); assert.throws(() => f.bridge.readFacts());
  assert.equal(f.posts(), 1); assert.equal(f.waits.length, 0); assert.equal(f.faults[0].controlState, 2); assert.equal(f.gate.open, false);
});
