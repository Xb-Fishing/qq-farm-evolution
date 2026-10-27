const test = require('node:test'); const assert = require('node:assert/strict');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const prefix = path.resolve(os.tmpdir(), 'session-packet-equivalence-');
assert.equal(path.dirname(prefix), path.resolve(os.tmpdir()));
const temporary = fs.mkdtempSync(prefix); process.env.FARM_DATA_DIR = path.join(temporary, 'isolated-state');
const { createSessionBusinessRuntime } = require('../src/runtime/session-business-runtime');
const { loadProto, types } = require('../src/utils/proto');
const actualSource = path.resolve(__dirname, '../src');
const actorRoot = path.join(temporary, 'actor');
const entry = path.resolve(actorRoot, 'core/src/runtime/session-business-entry.js');
assert.ok(entry.startsWith(temporary + path.sep)); fs.mkdirSync(path.dirname(entry), { recursive: true, mode: 0o700 });
// Run the same real warehouse and milk-tea services through a direct local
// facade and the production session bridge. Only the upstream transport replies
// are synthetic; no gateway, authorization or real game operation is performed.
fs.writeFileSync(entry, `
const path=require('node:path');const {parentPort,workerData}=require('node:worker_threads');const {EventEmitter}=require('node:events');
const root=${JSON.stringify(actualSource)};const {encode,decode}=require(path.join(root,'runtime/session-codec'));
const config=decode(workerData.config);const local=config.mode==='local';process.env.FARM_SESSION_BUSINESS=local?'0':'1';
let facts=decode(workerData.facts);let gate;let bridge;let sequence=0;const pending=new Map();const sockets=new Map();
const socket=()=>{const epoch=facts.game.connectionEpoch;if(!sockets.has(epoch))sockets.set(epoch,{readyState:1});return sockets.get(epoch);};
const user={};Object.assign(user,facts.game.userState);
let network;
if(local){network={networkEvents:new EventEmitter(),getWs:socket,getUserState:()=>user,isConnected:()=>true,
 sendMsgAsync:(service,method,body,timeout,options)=>new Promise((resolve,reject)=>{const id=++sequence;pending.set(id,{resolve,reject});parentPort.postMessage({kind:'business_request',id,sequence:id,
 body:encode({service,method,body:Buffer.from(body),timeout,options,configRevision:1,connectionEpoch:facts.game.connectionEpoch})});})};
 const file=require.resolve(path.join(root,'utils/network'));require.cache[file]={id:file,filename:file,loaded:true,exports:network};
 parentPort.on('message',m=>{if(m.kind!=='game_reply')return;const callback=pending.get(m.id);if(!callback)return;pending.delete(m.id);const result=decode(m.body);
 if(result.error)callback.reject(result.error);else{facts=result.value.facts;Object.assign(user,facts.game.userState);callback.resolve(result.value.value);}});
}else{gate=require(path.join(root,'runtime/business-gate')).createBusinessGate(workerData.epoch);require(path.join(root,'services/business-state')).setBusinessGate(gate);
 bridge=require(path.join(root,'runtime/session-business-bridge')).createSessionBusinessBridge({port:parentPort,gate,initialFacts:facts});bridge.setAppliedRevision(1);network=bridge.network;}
async function run(){const warehouse=require(path.join(root,'services/warehouse'));const milk=require(path.join(root,'services/milk-tea-activity'));
 const second=Math.floor(Date.UTC(2026,10,2)/1000);const now=()=>second*1000;const start=second-86400,end=second+20*86400;
 const result=await milk.runManualMilkTeaAction('craft',{fruitUids:['23563','9007199254741017','23565'],confirmedFruits:[
 {uid:'23563',itemId:40525,count:'7'},{uid:'9007199254741017',itemId:40525,count:'9'},{uid:'23565',itemId:40526,count:'11'}]},
 {now,isReady:()=>true,getBag:warehouse.getBag,getBagItems:warehouse.getBagItems,
 getActivityDiscoveryList:async()=>[{id:2026110100,parentId:0,enabled:true,startTime:start,endTime:end}],
 getActivityGroupSnapshot:async()=>({id:2026110100,startTime:start,endTime:end,children:[{id:2026110101,details:{milkTea:{shopOpenAt:start,level:1}}}],milkTeaTiming:{settleStartTime:end-4*86400}})});
 return result;}
parentPort.on('message',m=>{if(m.kind!=='business_control')return;const task=(async()=>{
 if(m.method==='prepare'){await require(path.join(root,'utils/proto')).loadProto();return true;}
 if(m.method==='activate'){if(gate)gate.activate();try{return await (gate?gate.run('real-craft',run):run());}catch(error){return {failed:true,message:error.message,code:error.code||'',business:error.business===true,isGovernedRejection:error.isGovernedRejection===true,governedReason:error.governedReason||''};}}
 return true;})();task.then(value=>({value}),error=>({error})).then(result=>parentPort.postMessage({kind:'business_reply',id:m.id,body:encode(result)}));});
parentPort.postMessage({kind:'business_boot'});
`, { mode: 0o600 });
test.after(() => { assert.equal(path.dirname(temporary), path.resolve(os.tmpdir())); fs.rmSync(temporary, { recursive: true, force: true }); });

async function probe(mode, scenario) {
  let sequence = 1; let connectionEpoch = 1;
  const packets = []; const canonicalCommands = [];
  const facts = () => ({ sequence: sequence++, host: { accountId: 'synthetic-packet-account' }, game: {
    platform: 'wx', connectionEpoch, connected: true, readyState: 1, socketPresent: true,
    userState: { gid: 77, gold: 1000 }, status: { platform: 'wx' }, clock: { serverTimeMs: 0, localTimeAtSync: 0 } } });
  const runtime = await createSessionBusinessRuntime({ target: { runtimeRoot: actorRoot }, epoch: `synthetic-${mode}-${scenario}`,
    facts: facts(), config: { mode }, read: facts,
    command: method => { canonicalCommands.push(method); return { facts: facts(), value: undefined }; },
    query: () => ({ facts: facts(), value: 0 }), onMaster: () => {},
    request: async (_id, args) => {
      packets.push({ service: args.service, method: args.method, body: Buffer.from(args.body).toString('hex') });
      let body;
      if (args.method === 'Bag') {
        body = types.BagReply.encode(types.BagReply.create({ item_bag: { items: [
          { id: 40525, uid: '23563', count: '7' }, { id: 40525, uid: '9007199254741017', count: '9' },
          { id: 40526, uid: '23565', count: '11' },
        ] } })).finish();
        if (scenario === 'connection_change') connectionEpoch++;
      } else {
        assert.equal(args.service, 'gamepb.activitypb.ActivityService'); assert.equal(args.method, 'Operate');
        const request = types.MilkTeaOperateRequest.decode(args.body); const command = Number(request.operate_type);
        if (scenario === 'budget' && command === 58) throw Object.assign(new Error('synthetic method budget'), { isGovernedRejection: true, governedReason: 'budget_method' });
        if (scenario === 'unknown_write' && command === 62) throw new Error('synthetic transport failure');
        const reply = { activity_id: request.activity_id, operate_type: command };
        if (command === 58) reply.milk_tea_get_workshop = { recipes: [{ recipe_id: 2, unlocked: true }, { recipe_id: 3, unlocked: true }] };
        else { assert.equal(command, 62); reply.milk_tea_craft = { crafted_cups: { 2: 16, 3: 11 }, used_fruits: [] }; }
        body = types.MilkTeaOperateReply.encode(types.MilkTeaOperateReply.create(reply)).finish();
      }
      return { value: { body, meta: { message_type: 2 } }, facts: facts() };
    } });
  try { await runtime.prepare(); const outcome = await runtime.activate([]); return { packets, outcome, canonicalCommands }; }
  finally { await runtime.terminate(); }
}

for (const scenario of ['success', 'unknown_write', 'budget', 'connection_change']) {
  test(`real batch crafting has identical local/bridged packets, quantities and outcomes: ${scenario}`, { timeout: 30000 }, async () => {
    await loadProto(); const old = await probe('local', scenario); const bridged = await probe('bridge', scenario);
    assert.deepEqual(bridged, old);
    const operations = bridged.packets.filter(packet => packet.method === 'Operate')
      .map(packet => types.MilkTeaOperateRequest.decode(Buffer.from(packet.body, 'hex')));
    if (scenario === 'success' || scenario === 'unknown_write') {
      assert.equal(bridged.outcome.failed, undefined, JSON.stringify(bridged.outcome));
      assert.deepEqual(operations.map(request => Number(request.operate_type)), [58, 62]);
      assert.deepEqual(operations[1].milk_tea_craft.fruit_uids.map(String), ['23563', '9007199254741017', '23565']);
      assert.equal(operations.filter(request => Number(request.operate_type) === 62).length, 1, 'unknown results cannot replay the write');
      assert.equal(bridged.outcome.ok, scenario === 'success');
    } else {
      assert.equal(operations.some(request => Number(request.operate_type) === 62), false);
      assert.equal(bridged.packets.length, scenario === 'budget' ? 2 : 1, JSON.stringify(bridged.outcome));
      if (scenario === 'budget') assert.equal(bridged.outcome.isGovernedRejection, true);
      else assert.equal(bridged.outcome.code, 'SEASON_WISH_MILK_TEA_CONNECTION_CHANGED');
    }
    assert.deepEqual(bridged.canonicalCommands, [], 'manual crafting does not invent wallet or stats corrections');
  });
}
