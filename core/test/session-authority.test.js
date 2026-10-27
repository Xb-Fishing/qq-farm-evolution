const test = require('node:test'); const assert = require('node:assert/strict');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const vm = require('node:vm'); const { EventEmitter } = require('node:events'); const { createRequire } = require('node:module');
const prefix = path.resolve(os.tmpdir(), 'session-policy-authority-'); assert.equal(path.dirname(prefix), path.resolve(os.tmpdir()));
const temporary = fs.mkdtempSync(prefix); process.env.FARM_DATA_DIR = temporary;
test.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
const { createSessionBusinessRuntime } = require('../src/runtime/session-business-runtime');
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { resolve, promise }; };
const actorRoot = path.resolve(temporary, 'actor'); const entry = path.resolve(actorRoot, 'core/src/runtime/session-business-entry.js');
assert.ok(entry.startsWith(temporary + path.sep)); fs.mkdirSync(path.dirname(entry), { recursive: true, mode: 0o700 });
fs.writeFileSync(entry, `
const path=require('node:path');const {parentPort,workerData}=require('node:worker_threads');
const root=${JSON.stringify(path.resolve(__dirname, '../src'))};const {encode,decode}=require(path.join(root,'runtime/session-codec'));
const gate=require(path.join(root,'runtime/business-gate')).createBusinessGate(workerData.epoch);
const bridge=require(path.join(root,'runtime/session-business-bridge')).createSessionBusinessBridge({port:parentPort,gate,initialFacts:decode(workerData.facts)});
bridge.setAppliedRevision(1);let continueBatch;const waiting=new Promise(done=>{continueBatch=done;});
async function control(method,args){
 if(method==='prepare')return true;if(method==='activate'){gate.activate();return true;}
 if(method==='syncConfig'){bridge.setAppliedRevision(args.__revision);return true;}
 if(method==='send'&&args.phase==='continue'){continueBatch();return true;}
 if(method!=='send')throw new Error('unsupported fixture control');
 return gate.run('root-batch',async()=>{
  if(args.phase==='before_rpc'){parentPort.postMessage({type:'phase',phase:'before_rpc'});await waiting;
   return gate.run('nested-batch',()=>bridge.network.sendMsgAsync('synthetic.Service','Write',Buffer.from([1])));}
  const result=await bridge.network.sendMsgAsync('synthetic.Service','Write',Buffer.from([2]));
  require(path.join(root,'services/stats')).recordOperation('harvest',7);
  bridge.network.correctSessionWallet('seedCost',{amounts:[7]});
  let nextCode='';try{await gate.run('next-old-decision',()=>bridge.network.sendMsgAsync('synthetic.Service','Write',Buffer.from([3])));}catch(error){nextCode=error.code;}
  return {body:result.body,nextCode};
 });}
parentPort.on('message',message=>{if(message.kind!=='business_control')return;
 Promise.resolve().then(()=>control(message.method,decode(message.body))).then(value=>({value}),error=>({error}))
 .then(reply=>parentPort.postMessage({kind:'business_reply',id:message.id,body:encode(reply)}));});
parentPort.postMessage({kind:'business_boot'});
`, { mode: 0o600 });

for (const phase of ['before_rpc', 'settle_sent']) {
  test(`a batch keeps its original policy across await and settles already-sent work: ${phase}`, { timeout: 30000 }, async () => {
    let revision = 1; let sequence = 1; let wallet = 100; let harvested = 0; const attempted = []; const sent = []; const reached = deferred(); const reply = deferred();
    const facts = () => ({ sequence: sequence++, host: { accountId: 'synthetic-policy' }, game: {
      connectionEpoch: 1, configRevision: revision, connected: true, readyState: 1, socketPresent: true,
      userState: { gold: wallet }, status: {}, clock: { serverTimeMs: 0, localTimeAtSync: 0 } } });
    const runtime = await createSessionBusinessRuntime({ target: { runtimeRoot: actorRoot }, epoch: `synthetic-${phase}`,
      config: {}, facts: facts(), read: facts, query: () => ({ value: 0, facts: facts() }),
      command: (method, args) => {
        if (method === 'stats.recordOperation') { assert.equal(args[0], 'harvest'); harvested += args[1]; }
        else { assert.equal(method, 'wallet.seedCost'); wallet -= args[0].amounts[0]; }
        return { value: undefined, facts: facts() };
      },
      onMaster: message => { if (message.type === 'phase') reached.resolve(); },
      request: async (_id, args) => {
        attempted.push(args.configRevision);
        if (args.configRevision !== revision) throw Object.assign(new Error('policy changed'), { code: 'SESSION_CONFIG_CHANGED' });
        sent.push(Buffer.from(args.body)); reached.resolve(); await reply.promise;
        return { value: { body: Buffer.from('confirmed') }, facts: facts() };
      } });
    try {
      await runtime.prepare(); await runtime.activate([]);
      const outcome = runtime.send({ phase }).then(value => ({ value }), error => ({ error }));
      await reached.promise; revision = 2; await runtime.syncConfig({ __revision: revision });
      if (phase === 'before_rpc') await runtime.send({ phase: 'continue' }); else reply.resolve();
      const result = await outcome;
      if (phase === 'before_rpc') {
        assert.equal(result.error?.code, 'SESSION_CONFIG_CHANGED'); assert.deepEqual(attempted, [1]);
        assert.equal(sent.length, 0); assert.equal(wallet, 100); assert.equal(harvested, 0);
      } else {
        assert.deepEqual(result.value.body, Buffer.from('confirmed')); assert.equal(result.value.nextCode, 'SESSION_CONFIG_CHANGED');
        assert.deepEqual(attempted, [1, 1]); assert.equal(sent.length, 1); assert.equal(wallet, 93); assert.equal(harvested, 7);
      }
    } finally { reply.resolve(); await runtime.terminate(); }
  });
}

test('the real adapter refuses business before login and rechecks login/policy after asynchronous encoding', async () => {
  const filename = path.resolve(__dirname, '../src/runtime/session-game-adapter.js'); const native = createRequire(filename); const module = { exports: {} };
  const account = { id: 'synthetic-adapter', platform: 'wx', credentialGeneration: 'synthetic-grant' };
  const state = {}; const socket = { readyState: 1 }; let hooks; let ready; let sent = 0; let encoding;
  const network = { setSessionTransportHooks: value => { hooks = value; }, networkEvents: new EventEmitter(),
    getWs: () => socket, isConnected: () => true, getUserState: () => state, getWsErrorState: () => ({}), getAceStatus: () => ({}),
    connect: (_code, callback) => { ready = callback; }, stopNetwork: () => {},
    sendMsgAsync: async (service, method) => { if (encoding) await encoding.promise; hooks.assertSend(service, method); sent++; return { body: Buffer.from('ok') }; } };
  // connect starts from no socket, then the fixture exposes an OPEN socket.
  let socketPresent = false; network.getWs = () => socketPresent ? socket : null;
  const replacements = { '../utils/network': network, '../services/stats': {}, '../services/status': { setStatusPlatform: () => {}, setRecordGoldExpHook: () => {}, statusData: {} },
    '../services/request-governor': {}, '../models/store': { getAccounts: () => ({ accounts: [account] }),
      applyConfigSnapshot: () => {}, getFriendQuietHours: () => ({ idleProtectionEnabled: true }) },
    '../utils/idle-protection': { getIdleProtectionUntil: () => 0 },
    '../utils/utils': { setLogHook: () => {}, getServerClockSnapshot: () => ({}) },
    '../utils/proto': { loadProto: async () => {} }, '../config/config': { CONFIG: {} } };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module, exports: module.exports, Buffer, process, queueMicrotask,
    Uint8Array, require: name => replacements[name] || native(name) }, { filename });
  const adapter = await module.exports.createSessionGameAdapter({ account });
  try {
    const config = adapter.syncConfig({ policy: 'first' }); const args = { service: 'synthetic.Service', method: 'Write', body: Buffer.from([1]), configRevision: config.__revision };
    await assert.rejects(adapter.request(args, () => {}), { code: 'SESSION_GAME_NOT_READY' }); assert.equal(sent, 0);
    for (const [service, method] of [['gamepb.userpb.UserService', 'Login'], ['gamepb.userpb.UserService', 'Heartbeat'], ['gamepb.acepb.AceService', 'AntiData']])
      assert.doesNotThrow(() => hooks.assertSend(service, method));
    adapter.command('network.connect', ['synthetic-code']); socketPresent = true; ready();
    encoding = deferred(); const pending = adapter.request(args, () => {}); network.networkEvents.emit('disconnect'); encoding.resolve();
    await assert.rejects(pending, { code: 'SESSION_GAME_NOT_READY' }); assert.equal(sent, 0);
    ready(); encoding = deferred(); const stale = adapter.request(args, () => {}); adapter.syncConfig({ policy: 'second' }); encoding.resolve();
    await assert.rejects(stale, { code: 'SESSION_CONFIG_CHANGED' }); assert.equal(sent, 0);
    encoding = null; const fresh = { ...args, configRevision: adapter.snapshot().configRevision };
    assert.deepEqual((await adapter.request(fresh, () => {})).body, Buffer.from('ok')); assert.equal(sent, 1);
  } finally { adapter.dispose(); }
});
