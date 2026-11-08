const test = require('node:test'); const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), vm = require('node:vm');
const { createRequire } = require('node:module'); const { EventEmitter } = require('node:events');
const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'client-version-fixture-'));process.env.FARM_DATA_DIR=root;
test.after(()=>fs.rmSync(root,{recursive:true,force:true}));
const { VERIFIED_CLIENT_VERSION: target, prepareClientRuntime, compareClientVersions } = require('../src/runtime/client-runtime-version');
const old='1.13.0.5_20260723', issuer='00000000-0000-4000-8000-000000000001';
const envelope=(revision=2,clientVersion=target)=>({schema:1,accountId:'fixture-account',platform:'wx',clientVersion,issuer,revision});
test('strict version envelope rejects unrelated data, stale changed versions and cross-account/platform requests; same-version retries retain highest revision',()=>{
 const state={issuer,revision:20},context={accountId:'fixture-account',platform:'wx',currentVersion:target,state};
 const same=prepareClientRuntime(envelope(1),context);assert.equal(same.apply,false);assert.equal(same.nextState.revision,20);assert.equal(state.revision,20);
 for(const value of [{...envelope(),accountId:'other'},{...envelope(),platform:'qq'},{...envelope(),schema:2},{...envelope(),serverUrl:'untrusted'},{...envelope(),revision:-1},{...envelope(),clientVersion:'arbitrary'}]) assert.throws(()=>prepareClientRuntime(value,context),/校验/);
 assert.throws(()=>prepareClientRuntime(envelope(1,'1.17.0.1_20261108'),context),{code:'SESSION_CLIENT_VERSION_STALE'});
 assert.equal(prepareClientRuntime(undefined,context),null);
 assert.equal(prepareClientRuntime(envelope(21),{...context,currentVersion:'1.17.0.1_20261108'}).apply,false,'server upgrade is not downgraded');
 assert.ok(compareClientVersions('1.16.3.8_20261028',old)>0);assert.equal(compareClientVersions('1.16.3_20261028','1.16.3.0_20261028'),0);
});
async function adapterFixture(savedVersion=old){
 const file=path.resolve(__dirname,'../src/runtime/session-game-adapter.js');const req=createRequire(file);const socket={readyState:1};const calls=[];
 const account={id:'fixture-account',platform:'wx',sessionGeneration:'fixture-binding'};const config={CONFIG:{clientVersion:old,platform:'qq'},updateRuntimeConfig:value=>{assert.deepEqual(Object.keys(value),['clientVersion']);config.CONFIG.clientVersion=value.clientVersion;calls.push(['version',value.clientVersion]);}};
 let fail=false;const store={getSystemConfig:()=>({clientVersion:savedVersion}),getAccounts:()=>({accounts:[account]}),getFriendQuietHours:()=>({}),applyConfigSnapshot:(value)=>{if(fail)throw Error('synthetic store failure');assert.equal(Object.hasOwn(value,'__clientRuntime'),false);calls.push(['store',value]);}};
 const network={networkEvents:new EventEmitter(),getWs:()=>socket,isConnected:()=>true,getUserState:()=>({}),setSessionTransportHooks(){},stopNetwork(){throw Error('must not close connection');},connect(){throw Error('must not reconnect');}};
 const replacements={'../utils/network':network,'../config/config':config,'../models/store':store,'../services/stats':{},'../services/status':{setStatusPlatform(){},setRecordGoldExpHook(){}},'../services/request-governor':{},'../utils/idle-protection':{setIdleProtectionUntil(){}},'../utils/utils':{setLogHook(){},getServerClockSnapshot:()=>({})},'../utils/proto':{loadProto:async()=>{},getRoot:()=>({})}};
 replacements['../services/status'].setRecordGoldExpHook=()=>{};
 const mod={exports:{}};vm.runInNewContext(fs.readFileSync(file,'utf8'),{module:mod,exports:mod.exports,require:name=>Object.hasOwn(replacements,name)?replacements[name]:req(name),Buffer,process,queueMicrotask},{filename:file});
 const adapter=await mod.exports.createSessionGameAdapter({account});return{adapter,config,calls,socket,fail:value=>{fail=value;},network};
}
test('native adapter loads saved version before login and normal config_sync updates only version after successful store application',async()=>{
 const f=await adapterFixture('1.15.0.1_20261001');assert.equal(f.config.CONFIG.clientVersion,'1.15.0.1_20261001');f.calls.length=0;
 try{f.fail(true);assert.throws(()=>f.adapter.syncConfig({__clientRuntime:envelope(10)}),/store failure/);assert.equal(f.config.CONFIG.clientVersion,'1.15.0.1_20261001');
 f.fail(false);const applied=f.adapter.syncConfig({__clientRuntime:envelope(9),automation:{task:false}});assert.equal(f.config.CONFIG.clientVersion,target);assert.deepEqual(f.calls.map(row=>row[0]),['store','version']);assert.equal(f.network.getWs(),f.socket);assert.equal(f.adapter.syncConfig({__clientRuntime:envelope(10),automation:{task:false}}).__revision,applied.__revision,'metadata-only refresh does not invalidate ordinary game requests');
 f.adapter.syncConfig({automation:{task:false}});assert.equal(f.config.CONFIG.clientVersion,target,'legacy configuration never resets the physical version');}finally{f.adapter.dispose();}
});
test('real manager snapshot includes configured version bound to the account; normal system-config save broadcasts after persistence',()=>{
 const base=require('../src/models/store');const account={id:'fixture-account',platform:'wx'};base.setSystemConfig({clientVersion:target});
 const store={...base,getAccounts:()=>({accounts:[account]})};const runtime=require('../src/runtime/runtime-state').createRuntimeState({store});
 const snapshot=runtime.buildConfigSnapshotForAccount(account.id);assert.equal(snapshot.__clientRuntime.clientVersion,target);assert.equal(snapshot.__clientRuntime.accountId,account.id);assert.equal(snapshot.__clientRuntime.platform,'wx');
 runtime.nextConfigRevision();assert.equal(runtime.buildConfigSnapshotForAccount(account.id).__clientRuntime.revision,snapshot.__clientRuntime.revision,'ordinary configuration revisions do not churn the old host version identity');
 const calls=[];runtime.startClientRuntimeVersionSync(()=>calls.push('broadcast'));
 const routes=new Map();const app={get(){},post:(url,...handlers)=>routes.set(url,handlers.at(-1)),put(){},delete(){}};
 require('../src/controllers/admin-system-routes').registerAdminSystemRoutes({app,store,logger:{warn(){}},requireAdminToken(){},requireAdminRole(){},requireSuperAdminRole(){},requireDangerConfirmation:(req,res,action)=>req.body.confirmation===action,getDefaultSystemConfig:()=>({clientVersion:target}),getRuntimeConfig:()=>({clientVersion:target}),updateRuntimeConfig:value=>{calls.push('manager');require('../src/config/config').updateRuntimeConfig(value);}});
 const res={json(value){this.body=value;},status(){return this;}};const handler=routes.get('/api/admin/system-config');handler({body:{clientVersion:target},currentUser:{}},res);assert.deepEqual(calls,[]);
 handler({body:{clientVersion:target,confirmation:'UPDATE_SYSTEM_CONFIG'},currentUser:{}},res);assert.equal(res.body.ok,true);assert.deepEqual(calls,['manager','broadcast']);
 const reset=routes.get('/api/admin/system-config/reset');calls.length=0;reset({body:{confirmation:'RESET_SYSTEM_CONFIG'},currentUser:{}},res);assert.equal(res.body.ok,true);assert.deepEqual(calls,['manager','broadcast']);runtime.stopClientRuntimeVersionSync();
});
