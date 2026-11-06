const test=require('node:test');const fs=require('node:fs'); const path=require('node:path'); const net=require('node:net'); const vm=require('node:vm'); const crypto=require('node:crypto'); const assert=require('node:assert/strict');const {once}=require('node:events');const {createRequire}=require('node:module');
const runtime=path.resolve(__dirname,'../..');const temp=fs.realpathSync('/tmp'); const prefix=path.resolve(temp,'session-api-queue-');assert.equal(path.dirname(prefix),temp);const work=fs.mkdtempSync(prefix);process.env.FARM_DATA_DIR=work;process.env.FARM_PRIVATE_CONFIG_FILE=path.join(work,'private-config.json');
const runtimeFiles=['core/src/runtime/session-worker-proxy.js','core/src/runtime/session-rpc.js','core/src/runtime/worker-manager.js','core/src/runtime/session-registry.js'];const hashes=()=>Object.fromEntries(runtimeFiles.map(f=>[f,crypto.createHash('sha256').update(fs.readFileSync(path.join(runtime,f))).digest('hex')]));const before=hashes();
const {SessionRpcClient,framed}=require(path.join(runtime,'core/src/runtime/session-rpc'));const nativeRegistry=require(path.join(runtime,'core/src/runtime/session-registry'));const flush=()=>new Promise(resolve=>setImmediate(resolve));
function load(file,overrides,extras={}){const filename=path.join(runtime,file); const native=createRequire(filename); const mod={exports:{}};vm.runInThisContext(`(function(module,exports,require,process,Buffer,console,setImmediate,Date){${fs.readFileSync(filename,'utf8')}\n})`,{filename})(mod,mod.exports,name=>Object.hasOwn(overrides,name)?overrides[name]:native(name),process,Buffer,console,setImmediate,extras.Date||Date);return mod.exports;}
async function scenario(t,missingState){
 const dataDir=path.join(work,missingState);assert.ok(dataDir.startsWith(work+path.sep));fs.mkdirSync(dataDir,{mode:0o700});const socketPath=path.join(dataDir,'control.sock');const now=Date.now(); const available=true; let lookups=0; let creates=0; let revoke=0; let sendAttempts=0;let blockControl=false; let releaseControl; let enterControl;const blocked=new Promise(resolve=>{enterControl=resolve});const received=[]; const peers=new Set(); const logs=[]; const tasks=new Map(); const intervals=new Map();
 const account={id:'synthetic-control',name:'Synthetic control account',platform:'wx',autoLogin:true,code:'synthetic-never-sent-code'};const target={runtimeRoot:runtime,commit:'synthetic-commit',sourceFingerprint:'a'.repeat(64)};
 const descriptor={socketPath,hostId:'synthetic-host',pid:12345,starttime:'synthetic-start',contractVersion:1,sourceRoot:runtime,sourceCommit:'synthetic-commit',sourceFingerprint:'a'.repeat(64),capability:'synthetic-capability'};
 const facts={sequence:1,host:{hostId:descriptor.hostId,pid:descriptor.pid,starttime:descriptor.starttime,sourceCommit:descriptor.sourceCommit},game:{connected:true,terminal:false,connectionEpoch:7,loginEpoch:1,firstLoginReadyAt:123,status:{}},business:{...target,ready:true,epoch:'synthetic-business'}};
 const server=net.createServer(socket=>{peers.add(socket);socket.on('error',()=>{});socket.on('close',()=>peers.delete(socket));const send=framed(socket,request=>{received.push({method:request.method,type:request.args?.message?.type,apiMethod:request.args?.message?.method,apiId:request.args?.message?.id});if(blockControl&&request.method==='send'&&request.args?.message?.type===(missingState==='sent'?'api_call':'config_sync')){blockControl=false;releaseControl=()=>send({kind:'response',id:request.id,value:facts});enterControl();return;}let value;if(request.method==='hello')value=descriptor;else if(request.method==='status')value={facts,status:{type:'status_sync',data:{}},lifecycle:{events:[]}};else {value=facts;if(request.method==='revoke')revoke++;}send({kind:'response',id:request.id,value});if(request.method==='send'&&request.args?.message?.type==='watchdog_ping')send({kind:'event',message:{facts,message:{type:'watchdog_pong',at:now}}});});});server.listen(socketPath);await once(server,'listening');
 const clients=[];t.after(async()=>{releaseControl?.();for(const client of clients)client.close();for(const peer of peers)peer.destroy();if(server.listening)await new Promise(resolve=>server.close(resolve));});const connect=async()=>{lookups++;if(!available)return {state:missingState,descriptor};const client=new SessionRpcClient(descriptor);await client.connect();const call=client.call.bind(client);client.call=(method,...args)=>{if(method==='send')sendAttempts++;return call(method,...args);};clients.push(client);return {state:'present',descriptor,client};};
 const registry={...nativeRegistry,connectSession:connect,ensureSession:async()=>{creates++;return connect();},processStarttime:()=> 'synthetic-manager-start'};
 const proxyModule=load('core/src/runtime/session-worker-proxy.js',{'./session-registry':registry,'./session-contract':{resolveBusinessTarget:()=>target},'./session-lifecycle-journal':{readLifecycleJournal:()=>({events:[]}),readLifecycleCursor:()=>0,acknowledgeLifecycle:()=>{}}});
 const scheduler={setTimeoutTask:(name,delay,callback)=>tasks.set(name,{delay,callback}),clear:name=>tasks.delete(name),clearAll:()=>{tasks.clear();intervals.clear();},setIntervalTask:(name,delay,callback)=>intervals.set(name,{delay,callback})};class ClockDate extends Date{static now(){return now;}}
 const managerModule=load('core/src/runtime/worker-manager.js',{'../services/scheduler':{createScheduler:()=>scheduler},'./session-worker-proxy':proxyModule,'./session-registry':registry},{Date:ClockDate});
 const workers={};const manager=managerModule.createWorkerManager({runtimeMode:'persistent',processRef:{pkg:false,env:{}},mainEntryPath:path.join(runtime,'core/client.js'),workerScriptPath:'',workers,globalLogs:[],fork:()=>{throw new Error('No legacy fork allowed');},store:{ensureAccountSessionMetadata:()=>account},getAccounts:()=>({accounts:[account]}),log:(tag,msg,meta)=>logs.push({tag,msg,meta}),addAccountLog(){},normalizeStatusForPanel:value=>value,buildConfigSnapshotForAccount:()=>({}),scheduleAccountRefresh(){},stopAccountRefresh(){}});
 assert.equal(await manager.startWorker(account),true);const proxy=workers[account.id].process;await proxy.ready;const rawErrors=[];proxy.on('error',error=>rawErrors.push({code:error.code,phase:error.phase}));

 blockControl=true;
 let apiError; let api;
 if(missingState==='sent')api=manager.callWorkerApi(account.id,'syntheticEconomicWrite',1,{_timeoutMs:10000});
 else proxy.send({type:'config_sync',config:{}});
 if(api)api.catch(error=>{apiError=error.message;});
 await blocked;
 if(missingState==='expired')proxy.send({type:'api_call',id:700,method:'syntheticEconomicWrite',args:[],dispatchDeadlineAt:Date.now()-1});
 else {
  if(!api){api=manager.callWorkerApi(account.id,'syntheticEconomicWrite',1,{_timeoutMs:10000});api.catch(error=>{apiError=error.message;});}
  if(missingState==='sent')assert.equal(proxy.cancelApi(received.find(row=>row.type==='api_call').apiId),false,'already sent cannot be declared cancelled');
  const timeout=[...tasks].find(([name])=>name.startsWith('api_timeout_'));assert.ok(timeout);tasks.delete(timeout[0]);timeout[1].callback();await flush();assert.equal(apiError,'API Timeout');
 }
 const beforeRelease=received.filter(row=>row.type==='api_call').length;
 assert.equal(beforeRelease,missingState==='sent'?1:0);
 releaseControl();releaseControl=null;proxy.send({type:'watchdog_ping',at:now});
 const until=Date.now()+2000;
 while(!received.some(row=>row.type==='watchdog_ping')){assert.ok(Date.now()<until,'queue must reach the explicit trailing barrier');await new Promise(resolve=>setTimeout(resolve,1));}
 assert.equal(received.filter(row=>row.type==='api_call').length,missingState==='sent'?1:0,'no timed-out unsent action or replay after unknown outcome');
 assert.equal(rawErrors.length,0,'local cancellation is not a session business fault');
 assert.equal(creates,1);assert.equal(revoke,0);assert.ok(lookups>=1);assert.ok(sendAttempts>=1);
 await manager.detachAll();for(const client of clients)client.close();for(const peer of peers)peer.destroy();await new Promise(resolve=>server.close(resolve));
}
test.after(()=>{assert.deepEqual(hashes(),before);fs.rmSync(work,{recursive:true,force:true});});
for(const mode of ['queued','expired','sent'])test(`API dispatch cancellation preserves transport ownership: ${mode}`,t=>scenario(t,mode));
