'use strict';
const {test,after}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');const os=require('node:os');const crypto=require('node:crypto');const Module=require('node:module');
const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'farm-local-provider-'));process.env.FARM_DATA_DIR=root;process.env.FARM_PRIVATE_CONFIG_FILE=path.join(root,'none.json');const provider=require('../src/runtime/optional-module-provider');const appRoot=path.resolve(__dirname,'../..');
const put=(name,value)=>{const full=path.resolve(root,name);assert.ok(full.startsWith(root+path.sep));fs.mkdirSync(path.dirname(full),{recursive:true});fs.writeFileSync(full,typeof value==='string'?value:JSON.stringify(value));return full;};const sha=v=>crypto.createHash('sha256').update(v).digest('hex');
after(()=>fs.rmSync(root,{recursive:true,force:true}));
function pack(name,label){const body=`module.exports={start:()=>true,attach:m=>{m.exports={label:${JSON.stringify(label)}};return true;}};`;const file=put(`${name}/preload.cjs`,body);put(`${name}/manifest.json`,{privatePreloadSha256:sha(body)});return path.dirname(file);}
test('ordinary startup without a local provider is inert and does not create configuration',()=>{assert.equal(provider.start(),false);assert.equal(fs.existsSync(path.join(root,'local-module-provider.json')),false);});
test('local provider loads in a normal process and selects only the matching update target before link activation',()=>{
 const previous=pack('previous','old'); const next=pack('next','new');put('local-module-provider.json',{version:1,packageRoot:previous});assert.equal(provider.start(),true);
 const filename=path.join(appRoot,'core/src/services/fixture.js');const mod=new Module(filename);mod.filename=filename;assert.equal(provider.attach(mod),true);assert.equal(mod.exports.label,'old');
 put('program-update.json',{phase:'applying',target:{runtimeRoot:appRoot},overlay:{previousRoot:previous,root:next}});const selected=new Module(mod.filename);assert.equal(provider.attach(selected),true);assert.equal(selected.exports.label,'new');
 put('program-update.json',{phase:'applying',taskRoot:appRoot,target:{runtimeRoot:'/new/runtime'},overlay:{previousRoot:previous,root:next}});const helper=new Module(mod.filename);assert.equal(provider.attach(helper),true);assert.equal(helper.exports.label,'new');
 put('program-update.json',{phase:'applying',target:{runtimeRoot:'/different/runtime'},overlay:{previousRoot:previous,root:next}});const unrelated=new Module(mod.filename);assert.equal(provider.attach(unrelated),true);assert.equal(unrelated.exports.label,'old');
 put('previous/preload.cjs','tampered');assert.throws(()=>provider.start(),/module_provider_changed/);
});

test('a real business Worker starts the registered core provider before loading state domains', async () => {
 const { Worker } = require('node:worker_threads');
 const body = `module.exports={start:(root,role)=>{require('node:worker_threads').parentPort.postMessage({kind:'fixture_provider_started',role,stateAlreadyLoaded:!!require.cache[require('node:path').join(root,'core/src/services/business-state.js')]});return true;},attach:()=>true};`;
 const loader=put('worker-provider/preload.cjs',body);put('worker-provider/manifest.json',{privatePreloadSha256:sha(body)});
 put('local-module-provider.json',{version:1,packageRoot:path.dirname(loader)});put('program-update.json',{phase:'idle'});
 const worker=new Worker(path.join(appRoot,'core/src/runtime/session-business-entry.js'),{workerData:{sessionBusiness:true},env:{...process.env,FARM_DATA_DIR:root,FARM_SESSION_BUSINESS:'1',FARM_WORKER:''}});
 worker.on('error',()=>{});
 try {
  const result=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('provider start was not observed')),4000);worker.on('message',value=>{if(value.kind==='fixture_provider_started'){clearTimeout(timer);resolve(value);}});worker.once('error',error=>{clearTimeout(timer);reject(error);});});
  assert.equal(result.role,'business');assert.equal(result.stateAlreadyLoaded,false);
 } finally {await worker.terminate();}
});
