const test = require('node:test');
const fs = require('node:fs'); const path = require('node:path'); const os = require('node:os');
const crypto = require('node:crypto'); const assert = require('node:assert/strict');
const runtime = path.resolve(__dirname, '../..');
const tempRoot = fs.realpathSync(os.tmpdir()); const prefix = path.resolve(tempRoot, 'session-bootstrap-test-');
assert.equal(path.dirname(prefix), tempRoot); const work = fs.mkdtempSync(prefix);
process.env.FARM_DATA_DIR = work; process.env.FARM_PRIVATE_CONFIG_FILE = path.join(work, 'private-config.json');
const registry = require('../src/runtime/session-registry');
const contract = require('../src/runtime/session-contract');
const validation = require('../src/services/evolution-validation');
const target = { runtimeRoot: runtime, commit: registry.sourceCommit(runtime), sourceFingerprint: validation.logicSnapshot(runtime).fingerprint };
const savedResolve = contract.resolveBusinessTarget; contract.resolveBusinessTarget = () => target;
const savedNodeOptions = process.env.NODE_OPTIONS;
const preload = path.resolve(work, 'synthetic-preload.cjs'); assert.ok(preload.startsWith(work + path.sep));
fs.writeFileSync(preload, String.raw`
const Module=require('node:module'),fs=require('node:fs'),path=require('node:path');const original=Module._load;const target=JSON.parse(process.env.SYNTHETIC_TARGET);const root=process.env.FARM_DATA_DIR;function mark(event,extra={}){const file=path.resolve(root,'events.jsonl');if(!file.startsWith(root+path.sep))throw Error('fixture_escape');fs.appendFileSync(file,JSON.stringify({event,at:Date.now(),pid:process.pid,starttime:fs.readFileSync('/proc/self/stat','utf8').split(') ').at(-1).split(' ')[19],...extra})+'\n',{mode:0o600});}
const unlink=fs.unlinkSync;fs.unlinkSync=function(file,...args){try{const result=unlink.call(this,file,...args);if(file===process.env.FARM_SESSION_BOOTSTRAP)mark('bootstrap_consumed');return result;}catch(error){if(file===process.env.FARM_SESSION_BOOTSTRAP)mark('bootstrap_unlink_failed',{code:error.code});throw error;}};
const rename=fs.renameSync;fs.renameSync=function(from,to,...args){const result=rename.call(this,from,to,...args);if(String(to).includes('/persistent-sessions/')&&!path.basename(String(to)).startsWith('bootstrap-'))mark('descriptor_written');return result;};
Module._load=function(id,parent,...rest){
 if(parent?.filename.endsWith('/session-host.js')&&id==='./session-game-adapter')return {createSessionGameAdapter:async()=>{mark('adapter_entered');if(process.env.SYNTHETIC_DELAY==='failure'){const e=new Error('synthetic-secret-that-must-not-be-logged');e.code='EACCES';throw e;}if(process.env.SYNTHETIC_DELAY==='1')await new Promise(resolve=>{const poll=()=>{if(fs.existsSync(path.join(root,'release-adapter')))return resolve();setTimeout(poll,5)};poll();});if(process.env.SYNTHETIC_DELAY==='slow')await new Promise(resolve=>setTimeout(resolve,300));mark('adapter_ready');let connected=false;return {snapshot:()=>({connectionEpoch:0,loginEpoch:0,connected,userState:{},status:{},clock:{}}),syncConfig:value=>value,query:()=>0,request:()=>{throw Error('No game requests allowed')},command:()=>{throw Error('No game commands allowed')},stop:()=>{connected=false},onEvent:()=>{},dispose:()=>mark('adapter_disposed')};}};
 const result=original.call(this,id,parent,...rest);if(parent?.filename.endsWith('/session-host.js')&&id==='./session-contract')return {...result,resolveBusinessTarget:()=>target};if(parent?.filename.endsWith('/session-host.js')&&id==='./session-host-core')return {...result,sessionError:code=>{mark('host_error',{code});return result.sessionError(code)}};return result;
};
`, { mode: 0o600 });
const owned = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(predicate, label) {
  const until = Date.now() + 5000;
  while (!predicate()) { if (Date.now() >= until) throw new Error(label); await delay(10); }
}
test.after(async () => {
  contract.resolveBusinessTarget = savedResolve;
  if (savedNodeOptions === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = savedNodeOptions;
  delete process.env.SYNTHETIC_TARGET; delete process.env.SYNTHETIC_DELAY;
  for (const item of owned) {
    const events = fs.existsSync(item.events) ? fs.readFileSync(item.events, 'utf8').trim().split('\n').map(JSON.parse) : [];
    for (const event of events) if (registry.processIsLive(event.pid, event.starttime)) {
      process.kill(event.pid, 'SIGKILL'); await waitFor(() => !registry.processIsLive(event.pid, event.starttime), 'owned fixture child must exit');
    }
    assert.ok(path.basename(item.socketRoot).startsWith('qfs-'));
    fs.rmSync(item.socketRoot, { recursive: true, force: true });
  }
  assert.equal(validation.logicSnapshot(runtime).fingerprint, target.sourceFingerprint, 'source bytes and modes remain unchanged');
  fs.rmSync(work, { recursive: true, force: true });
});

test('real host consumes bootstrap before slow initialization and expiry cannot publish a late stale descriptor', async () => {
  for (const mode of ['normal', 'slow', 'expired', 'failure']) {
    const dataDir = path.resolve(work, mode); assert.ok(dataDir.startsWith(work + path.sep)); fs.mkdirSync(dataDir, { mode: 0o700 });
    const account = { id: `synthetic-${mode}`, platform: 'wx', autoLogin: true, sessionGeneration: 'synthetic-session', credentialGeneration: 'synthetic-grant' };
    const paths = registry.pathsFor(dataDir, account.id); const eventsFile = path.join(dataDir, 'events.jsonl');
    owned.push({ socketRoot: paths.socketRoot, events: eventsFile });
    process.env.NODE_OPTIONS = `--require=${preload}`; process.env.SYNTHETIC_TARGET = JSON.stringify(target);
    process.env.SYNTHETIC_DELAY = mode === 'expired' ? '1' : mode;
    let found; let failure;
    try { found = await registry.ensureSession({ dataDir, account, sourceRoot: runtime, logDir: path.join(dataDir, 'logs'), startupTimeoutMs: 4000 }); }
    catch (error) { failure = error; }
    if (mode === 'expired') {
      assert.equal(failure?.code, 'SESSION_HOST_START_TIMEOUT');
      fs.writeFileSync(path.join(dataDir, 'release-adapter'), 'release', { mode: 0o600 });
      const logfile = path.join(dataDir, 'logs', `${crypto.createHash('sha256').update(account.id).digest('hex').slice(0, 24)  }.log`);
      await waitFor(() => fs.readFileSync(logfile, 'utf8').includes('session_host_start_failed'), 'expired child must report its precise startup stage');
      const diagnostic = JSON.parse(fs.readFileSync(logfile, 'utf8').trim());
      assert.equal(diagnostic.reason, 'SESSION_HOST_START_TIMEOUT'); assert.equal(diagnostic.phase, 'load_adapter');
      assert.equal(fs.existsSync(paths.descriptor), false, 'expired startup never publishes a stale host');
      const events = fs.readFileSync(eventsFile, 'utf8').trim().split('\n').map(JSON.parse);
      assert.ok(events.find(e => e.event === 'bootstrap_consumed').at <= events.find(e => e.event === 'adapter_entered').at);
      assert.equal(events.some(e => e.event === 'bootstrap_unlink_failed'), false);
      assert.ok(events.some(e => e.event === 'adapter_disposed'));
    } else if (mode === 'failure') {
      assert.equal(failure?.code, 'SESSION_HOST_START_FAILED');
      const logfile = path.join(dataDir, 'logs', `${crypto.createHash('sha256').update(account.id).digest('hex').slice(0, 24)  }.log`);
      const text = fs.readFileSync(logfile, 'utf8'); const diagnostic = JSON.parse(text.trim());
      assert.equal(diagnostic.nodeCode, 'EACCES'); assert.equal(diagnostic.phase, 'load_adapter');
      assert.equal(diagnostic.reason, 'SESSION_HOST_START_FAILED');
      assert.doesNotMatch(text, /synthetic-secret/);
      assert.equal(fs.existsSync(paths.descriptor), false);
    } else {
      assert.equal(found?.state, 'present', failure?.message);
      assert.equal(registry.processIsLive(found.descriptor.pid, found.descriptor.starttime), true);
      assert.equal(fs.readdirSync(paths.directory).some(name => name.startsWith('bootstrap-')), false);
      await found.client.call('revoke'); found.client.close();
      await waitFor(() => !registry.processIsLive(found.descriptor.pid, found.descriptor.starttime), 'healthy fixture host cleanup');
    }
  }
});
