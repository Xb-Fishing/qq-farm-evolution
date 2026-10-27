const test = require('node:test'); const assert = require('node:assert/strict');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const { execFileSync, spawn, fork } = require('node:child_process');
const prefix = path.resolve(os.tmpdir(), 'session-update-process-');
assert.equal(path.dirname(prefix), path.resolve(os.tmpdir()));
const fixture = fs.mkdtempSync(prefix); process.env.FARM_DATA_DIR = path.join(fixture, 'isolated-data');
const source = path.resolve(__dirname, '../..');
const publication = require('../src/services/evolution-publish');
const validation = require('../src/services/evolution-validation');
const registry = require('../src/runtime/session-registry');
const { prepareUpdatePreflight } = require('../src/services/wx-update-preflight');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const localEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_CONFIG_(?:COUNT|KEY_\d+|VALUE_\d+)$/.test(key)));
function write(relative, body) {
  const target = path.resolve(fixture, relative); assert.ok(target.startsWith(fixture + path.sep));
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 }); fs.writeFileSync(target, body, { mode: 0o600 });
  return target;
}
function copy(relative) {
  for (const entry of fs.readdirSync(path.join(source, relative), { withFileTypes: true })) {
    const item = path.join(relative, entry.name);
    if (entry.isDirectory()) copy(item);
    else if (entry.isFile() && /\.(?:js|json|proto)$/.test(entry.name)) write(item, fs.readFileSync(path.join(source, item)));
  }
}
const git = (args, cwd = fixture) => execFileSync('git', args, { cwd, env: localEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
function waitMessage(child, type, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const done = (error, value) => { clearTimeout(timer); child.off('message', message); child.off('exit', exit); error ? reject(error) : resolve(value); };
    const message = value => { if (value.type === type) done(null, value); else if (value.type === 'failed') done(new Error(value.error)); };
    const exit = code => done(new Error(`Synthetic manager exited before ${type}: ${code}`));
    const timer = setTimeout(() => done(new Error(`Synthetic manager did not report ${type}`)), timeoutMs);
    child.on('message', message); child.once('exit', exit);
  });
}
async function validate(root, dataDir) {
  await validation.runEvolutionValidation({ repoRoot: root, dataDir, execute: (bin, args, options) => new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd: options.cwd, env: options.env, stdio: 'ignore' });
    child.once('error', reject); child.once('exit', code => code === 0 ? resolve({ code }) : reject(new Error('Synthetic source validation failed')));
  }) });
}

test('the real stop-tree helper preserves the host while a new management process activates the next real business Worker', { timeout: 60000 }, async () => {
  copy('core/src');
  write('core/scripts/evolution-apply-process.js', fs.readFileSync(path.join(source, 'core/scripts/evolution-apply-process.js')));
  write('.gitignore', 'tmp/\ncore/data/\ncore/node_modules\nremote.git/\nisolated-data/\n');
  write('docs/HANDOFF.md', 'Synthetic process update fixture: local fake transport, no real authentication or game requests.\n');
  write('core/client.js', '// The synthetic manager is launched separately.\n');
  write('core/test/synthetic.test.js', "require('node:test')('isolated synthetic source',()=>require('node:assert/strict').ok(process.env.FARM_DATA_DIR));\n");
  write('core/src/runtime/session-game-adapter.js', `
const fs=require('node:fs');const path=require('node:path');const crypto=require('node:crypto');
exports.createSessionGameAdapter=async({account})=>{
 const nonce=crypto.randomUUID();let connections=0;let connected=false;let revision=0;
 const file=path.join(process.env.FARM_DATA_DIR,'synthetic-host-initializations.json');let starts=0;try{starts=JSON.parse(fs.readFileSync(file)).count;}catch{}
 fs.writeFileSync(file,JSON.stringify({count:starts+1}),{mode:0o600});
 const snapshot=()=>({platform:'wx',connectionEpoch:connections,connected,terminal:false,socketPresent:connected,readyState:connected?1:3,
 userState:{gid:77,gold:0,exp:0,level:1},status:{platform:'wx',name:'Synthetic'},clock:{serverTimeMs:0,localTimeAtSync:0},nonce,connections,wireSequence:0,
 configRevision:revision,loginCredentialGeneration:account.credentialGeneration});
 return {snapshot,syncConfig:value=>({...value,__revision:++revision}),
 query:method=>method==='stats.getStats'?{connection:{connected},status:{platform:'wx',name:'Synthetic'},operations:{}}:method==='idle.getIdleProtectionUntil'?0:{active:false},
 command:method=>{if(method==='network.connect'){if(connections)throw new Error('Duplicate physical connect');connections++;connected=true;}},
 request:()=>{throw new Error('Synthetic update must never perform game operations');},stop:()=>{connected=false;},onEvent:()=>{},dispose:()=>{}};
};
`);
  const methods = require('../src/runtime/session-game-adapter');
  const methodExports = Object.entries(methods).filter(([, value]) => value instanceof Set)
    .map(([name, value]) => `exports.${name}=new Set(${JSON.stringify([...value])});`).join('\n');
  const adapterFile = path.resolve(fixture, 'core/src/runtime/session-game-adapter.js');
  assert.ok(adapterFile.startsWith(fixture + path.sep)); fs.appendFileSync(adapterFile, methodExports);
  const dependency = path.resolve(fixture, 'core/node_modules'); assert.ok(dependency.startsWith(fixture + path.sep));
  fs.symlinkSync(path.join(source, 'core/node_modules'), dependency, 'dir');
  git(['init', '-q', '-b', 'main']); git(['config', 'user.name', 'Synthetic']); git(['config', 'user.email', 'synthetic@invalid']);
  git(['add', '.']); git(['commit', '-qm', 'synthetic transport with real business runtime']);
  const remote = path.resolve(fixture, 'remote.git'); assert.ok(remote.startsWith(fixture + path.sep));
  git(['init', '-q', '--bare', '-b', 'main', remote]); git(['remote', 'add', 'origin', remote]); git(['push', '-q', 'origin', 'main']);
  const dataDir = path.join(fixture, 'core/data'); registry.secureDirectory(dataDir);
  const account = { id: 'synthetic-update-account', platform: 'wx', username: 'synthetic-owner', wxid: 'synthetic-subject',
    credentialGeneration: 'synthetic-authorization', sessionGeneration: 'synthetic-session', autoLogin: true };
  write('core/data/accounts.json', JSON.stringify({ accounts: [account] }));
  const held = publication.ensureHoldManifest(dataDir, fixture); const firstCommit = git(['rev-parse', 'HEAD']);
  const first = publication.prepareRuntimeWorkspace({ repoRoot: fixture, runId: 'session-first', commit: firstCommit, dataDir });
  await validate(first.runtimeRoot, dataDir);
  const record = (runtime, commit) => publication.recordApplyTarget(dataDir, { runId: 'synthetic-update', commit,
    runtimeRoot: runtime.runtimeRoot, sourceFingerprint: validation.logicSnapshot(runtime.runtimeRoot).fingerprint,
    holdDigest: publication.holdDigest(held), createdAt: Date.now() });
  record(first, firstCommit);
  const managerFile = write('core/data/synthetic-manager.cjs', `
const fs=require('node:fs');const path=require('node:path');const crypto=require('node:crypto');const {spawn}=require('node:child_process');
const root=process.argv[2],dir=process.env.FARM_DATA_DIR;const r=require(path.join(root,'core/src/runtime/session-registry'));
const contract=require(path.join(root,'core/src/runtime/session-contract'));const account=JSON.parse(fs.readFileSync(path.join(dir,'accounts.json'))).accounts[0];
let live;let noise;let closing=false;
process.on('SIGTERM',async()=>{if(closing)return;closing=true;try{noise?.kill();if(live)await live.client.call('detach',{},1000);}catch{}finally{live?.client.close();process.exit(0);}});
process.on('message',async m=>{if(m.type!=='try_create')return;try{await r.ensureSession({dataDir:dir,account:{...account,id:'synthetic-unwanted-host'},sourceRoot:root});process.send({type:'creation',blocked:false});}
catch(e){process.send({type:'creation',blocked:e.code==='SESSION_HANDOFF_IN_PROGRESS'});}});
(async()=>{
 live=await r.ensureSession({dataDir:dir,account,sourceRoot:root});
 await live.client.call('claim',{manager:{id:crypto.randomUUID(),pid:process.pid,starttime:r.processStarttime(process.pid)}});
 const target=contract.resolveBusinessTarget({runtimeRoot:root,dataDir:dir});
 const config={...require(path.join(root,'core/src/models/store')).getConfigSnapshot(account.id),platform:'wx',code:'synthetic-code'};
 await live.client.call('attach',{target,config});const status=await live.client.call('status');
 noise=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
 process.send({type:'ready',facts:status.facts,noisePid:noise.pid});
})().catch(e=>{process.send({type:'failed',error:e.message});process.exitCode=1;});
`);
  let oldManager; let nextManager; let preflight; const clients = []; let host;
  const startManager = runtimeRoot => fork(managerFile, [runtimeRoot], { env: { ...localEnv, FARM_DATA_DIR: dataDir }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  try {
    oldManager = startManager(first.runtimeRoot); const old = await waitMessage(oldManager, 'ready'); host = old.facts.host;
    assert.equal(old.facts.game.connections, 1); assert.equal(old.facts.business.ready, true);
    const provenance = publication.createTaskWorkspace({ repoRoot: fixture, runId: 'session-next', dataDir });
    const marker = path.resolve(provenance.taskRoot, 'core/src/synthetic-business-version.js');
    assert.ok(marker.startsWith(path.resolve(provenance.taskRoot) + path.sep)); fs.writeFileSync(marker, 'module.exports=2;\n');
    git(['add', '.'], provenance.taskRoot); git(['commit', '-qm', 'synthetic business update'], provenance.taskRoot);
    const secondCommit = git(['rev-parse', 'HEAD'], provenance.taskRoot); git(['push', '-q', 'origin', 'HEAD:main'], provenance.taskRoot);
    const next = publication.prepareRuntimeWorkspace({ repoRoot: fixture, runId: 'session-next', commit: secondCommit, dataDir });
    await validate(next.runtimeRoot, dataDir); record(next, secondCommit);
    preflight = await prepareUpdatePreflight({ processRef: { connected: false }, targetCommit: secondCommit,
      oldPid: oldManager.pid, oldStartTicks: registry.processStarttime(oldManager.pid), dataDir, adminPort: 1 });
    assert.equal(preflight.sessions.length, 1); assert.equal(await preflight.validate(), true);
    assert.equal((await preflight.verifyReady()).ok, false, 'a healthy host with the old business commit cannot be marked ready');
    const pendingCreation = waitMessage(oldManager, 'creation'); oldManager.send({ type: 'try_create' });
    assert.equal((await pendingCreation).blocked, true);
    const proofFile = write('core/data/synthetic-stop-proof.json', JSON.stringify({ pid: oldManager.pid,
      starttime: registry.processStarttime(oldManager.pid), sessions: preflight.sessions }));
    const stopper = write('core/data/synthetic-stop.cjs', `
const fs=require('node:fs');const helper=require(${JSON.stringify(path.join(source, 'core/scripts/evolution-apply-process.js'))});
const proof=JSON.parse(fs.readFileSync(process.argv[2]));helper.stopBotTree(proof.pid,proof.starttime,helper.collectProcesses(),proof.sessions)
.then(()=>process.exit(0),()=>process.exit(1));
`);
    await new Promise((resolve, reject) => { const child = spawn(process.execPath, [stopper, proofFile], { env: localEnv, stdio: 'ignore' });
      child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error('Real stop-tree helper failed'))); });
    assert.equal(registry.processIsLive(oldManager.pid), false); assert.equal(registry.processIsLive(old.noisePid), false);
    assert.equal(registry.processIsLive(host.pid, host.starttime), true);
    nextManager = startManager(next.runtimeRoot); const updated = await waitMessage(nextManager, 'ready');
    assert.equal(updated.facts.host.pid, host.pid); assert.equal(updated.facts.host.starttime, host.starttime);
    assert.equal(updated.facts.game.nonce, old.facts.game.nonce); assert.equal(updated.facts.game.connections, 1);
    assert.equal(updated.facts.game.wireSequence, 0); assert.equal(updated.facts.host.sourceCommit, firstCommit);
    assert.equal(updated.facts.business.commit, secondCommit); assert.equal(updated.facts.business.ready, true);
    assert.equal((await preflight.verifyReady()).ok, true);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'synthetic-host-initializations.json'))).count, 1);
    const current = await registry.connectSession(dataDir, account); clients.push(current.client);
    await current.client.call('revoke');
  } finally {
    try { preflight?.cleanup?.(); } catch {}
    for (const client of clients) client.close();
    for (const child of [oldManager, nextManager]) if (child?.pid && registry.processIsLive(child.pid)) child.kill('SIGTERM');
    if (host && registry.processIsLive(host.pid, host.starttime)) process.kill(host.pid, 'SIGKILL');
    for (let i = 0; i < 50 && [oldManager, nextManager].some(child => child?.pid && registry.processIsLive(child.pid)); i++) await pause(20);
    assert.equal(path.dirname(fixture), path.resolve(os.tmpdir())); fs.rmSync(fixture, { recursive: true, force: true });
  }
});
