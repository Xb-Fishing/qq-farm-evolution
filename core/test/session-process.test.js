const test = require('node:test'); const assert = require('node:assert/strict');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const prefix = path.resolve(os.tmpdir(), 'session-flock-process-');
assert.equal(path.dirname(prefix), path.resolve(os.tmpdir()));
const fixture = fs.mkdtempSync(prefix); process.env.FARM_DATA_DIR = path.join(fixture, 'isolated-test-data');
const sourceRoot = path.resolve(__dirname, '../..');
const publish = require('../src/services/evolution-publish');
const validation = require('../src/services/evolution-validation');
const registry = require('../src/runtime/session-registry');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function write(relative, body) {
  const file = path.resolve(fixture, relative);
  assert.ok(file.startsWith(fixture + path.sep));
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); fs.writeFileSync(file, body, { mode: 0o600 });
  return file;
}
function copySources(directory) {
  for (const entry of fs.readdirSync(path.join(sourceRoot, directory), { withFileTypes: true })) {
    const relative = path.join(directory, entry.name);
    if (entry.isDirectory()) copySources(relative);
    else if (entry.isFile() && entry.name.endsWith('.js')) write(relative, fs.readFileSync(path.join(sourceRoot, relative)));
  }
}
const git = args => execFileSync('git', args, { cwd: fixture, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
test.after(() => {
  assert.equal(path.dirname(fixture), path.resolve(os.tmpdir()));
  fs.rmSync(fixture, { recursive: true, force: true });
});

test('real admitted host holds a lifetime flock and is adopted after manager disconnect without a second initialization', { timeout: 60000 }, async () => {
  copySources('core/src');
  write('.gitignore', 'tmp/\ncore/data/\ncore/node_modules\nisolated-test-data/\nremote.git/\n');
  write('core/client.js', '// Synthetic management entry. No network or game login.\n');
  write('docs/HANDOFF.md', 'Isolated session process fixture; no real accounts or gateway access.\n');
  write('core/test/synthetic-adapter.test.js', "require('node:test')('synthetic adapter fixture is isolated',()=>require('node:assert/strict').ok(process.env.FARM_DATA_DIR));\n");
  // Only the adapter in this separately committed synthetic repository is a
  // fake. Admission, process entry, registry, socket authentication and flock
  // are the actual implementations, without a production testing escape hatch.
  write('core/src/runtime/session-game-adapter.js', `
const fs=require('node:fs');const path=require('node:path');
exports.createSessionGameAdapter=async()=>{
 const file=path.join(process.env.FARM_DATA_DIR,'synthetic-initializations.json');
 let count=0;try{count=JSON.parse(fs.readFileSync(file)).count;}catch{}
 fs.writeFileSync(file,JSON.stringify({count:count+1}),{mode:0o600});
 let connected=true;
 return {snapshot:()=>({connectionEpoch:1,connected,userState:{},status:{},clock:{}}),
 syncConfig:value=>value,query:()=>0,request:()=>{throw new Error('Game requests forbidden in this fixture');},
 command:()=>{throw new Error('Game commands forbidden in this fixture');},stop:()=>{connected=false;},onEvent:()=>{},dispose:()=>{}};
};
`);
  const dependencyLink = path.resolve(fixture, 'core/node_modules');
  assert.ok(dependencyLink.startsWith(fixture + path.sep));
  fs.symlinkSync(path.join(sourceRoot, 'core/node_modules'), dependencyLink, 'dir');
  git(['init', '-q', '-b', 'main']); git(['config', 'user.name', 'Synthetic fixture']);
  git(['config', 'user.email', 'synthetic@invalid']); git(['add', '.']); git(['commit', '-qm', 'synthetic session adapter']);
  const remote = path.resolve(fixture, 'remote.git'); assert.ok(remote.startsWith(fixture + path.sep));
  git(['init', '-q', '--bare', '-b', 'main', remote]); git(['remote', 'add', 'origin', remote]);
  const localEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_CONFIG_(?:COUNT|KEY_\d+|VALUE_\d+)$/.test(key)));
  execFileSync('git', ['push', '-q', 'origin', 'main'], { cwd: fixture, env: localEnv });
  const dataDir = path.join(fixture, 'core/data'); registry.secureDirectory(dataDir);
  const manifest = publish.ensureHoldManifest(dataDir, fixture);
  const commit = git(['rev-parse', 'HEAD']);
  const materialized = publish.prepareRuntimeWorkspace({ repoRoot: fixture, runId: 'session-process', commit, dataDir });
  const runtimeRoot = materialized.runtimeRoot;
  await validation.runEvolutionValidation({ repoRoot: runtimeRoot, dataDir, execute: (bin, args, options) => new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd: options.cwd, env: options.env, stdio: 'ignore' });
    child.once('error', reject); child.once('exit', code => code === 0 ? resolve({ code }) : reject(new Error('Synthetic validation failed')));
  }) });
  publish.recordApplyTarget(dataDir, { runId: 'session-process', commit, runtimeRoot,
    sourceFingerprint: validation.logicSnapshot(runtimeRoot).fingerprint, holdDigest: publish.holdDigest(manifest), createdAt: Date.now() });
  const account = { id: 'synthetic-process-account', username: 'synthetic-owner', platform: 'wx', wxid: 'synthetic-subject',
    credentialGeneration: 'synthetic-grant', sessionGeneration: 'synthetic-session', autoLogin: true };
  write('core/data/accounts.json', JSON.stringify({ accounts: [account] }));
  const logDir = path.join(dataDir, 'logs/session-fixture'); let host;
  const clients = [];
  try {
    const results = await Promise.all([0, 1].map(() => registry.ensureSession({ dataDir, account, sourceRoot: runtimeRoot, logDir })));
    for (const result of results) clients.push(result.client);
    host = results[0].descriptor;
    assert.equal(results[1].descriptor.hostId, host.hostId); assert.equal(results[1].descriptor.pid, host.pid);
    assert.equal(registry.descriptorFor(dataDir, account).state, 'present');
    assert.equal(registry.socketIdentity(host.pid, host.starttime, host.socketPath), host.socketInode);
    assert.equal(registry.processIsLive(host.pid, host.starttime), true);
    assert.equal(registry.lockIsHeld(registry.pathsFor(dataDir, account.id).lock), true);
    assert.throws(() => execFileSync('/usr/bin/flock', ['-n', '-E', '73', registry.pathsFor(dataDir, account.id).lock, 'true']), error => error.status === 73);
    for (const client of clients) client.close();
    const adopted = await registry.ensureSession({ dataDir, account, sourceRoot: runtimeRoot, logDir }); clients.push(adopted.client);
    assert.equal(adopted.descriptor.hostId, host.hostId);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'synthetic-initializations.json'))).count, 1);
    const barrier = require('../src/runtime/session-handoff-barrier');
    const other = { ...account, id: 'synthetic-second-account' };
    barrier.beginSessionBarrier({ dataDir, nonce: 'synthetic-handoff', blockedPid: process.pid,
      blockedStarttime: registry.processStarttime(process.pid) });
    try {
      await assert.rejects(registry.ensureSession({ dataDir, account: other, sourceRoot: runtimeRoot, logDir }), { code: 'SESSION_HANDOFF_IN_PROGRESS' });
      const allowed = await registry.ensureSession({ dataDir, account, sourceRoot: runtimeRoot, logDir }); clients.push(allowed.client);
      assert.equal(allowed.descriptor.hostId, host.hostId, 'a handoff blocks creation while preserving adoption');
    } finally { barrier.releaseSessionBarrier(dataDir, 'synthetic-handoff'); }
    const update = require('../src/runtime/session-update');
    const proofs = await update.collectSessionProofs(dataDir);
    assert.equal((await update.verifySessionProofs({ dataDir, proofs })).ok, true);
    const second = await registry.ensureSession({ dataDir, account: other, sourceRoot: runtimeRoot, logDir }); clients.push(second.client);
    write('core/data/accounts.json', JSON.stringify({ accounts: [account, other] }));
    try { assert.equal((await update.verifySessionProofs({ dataDir, proofs })).ok, false, 'a host added after preparation invalidates the whole set'); }
    finally { await second.client.call('revoke'); write('core/data/accounts.json', JSON.stringify({ accounts: [account] })); }
    const watched = path.join(runtimeRoot, 'core/src/runtime/session-host-core.js'); const original = fs.readFileSync(watched); const mode = fs.statSync(watched).mode & 0o777;
    try {
      fs.appendFileSync(watched, '\n// synthetic byte drift\n'); assert.equal(registry.descriptorFor(dataDir, account).state, 'unknown');
      fs.writeFileSync(watched, original); fs.chmodSync(watched, mode ^ 0o100);
      assert.equal(registry.descriptorFor(dataDir, account).state, 'unknown');
    } finally { fs.writeFileSync(watched, original); fs.chmodSync(watched, mode); }
    assert.equal(registry.descriptorFor(dataDir, account).state, 'present');
    await adopted.client.call('revoke');
    for (let i = 0; i < 100 && registry.processIsLive(host.pid, host.starttime); i++) await delay(20);
    assert.equal(registry.processIsLive(host.pid, host.starttime), false);
    assert.equal(fs.existsSync(registry.pathsFor(dataDir, account.id).descriptor), false);
    assert.equal(registry.lockIsHeld(registry.pathsFor(dataDir, account.id).lock), false);
  } catch (error) {
    try { error.message += `\n${  fs.readFileSync(path.join(logDir, fs.readdirSync(logDir)[0]), 'utf8').slice(-2000)}`; } catch {}
    throw error;
  } finally {
    for (const client of clients) client.close();
    if (host && registry.processIsLive(host.pid, host.starttime)) process.kill(host.pid, 'SIGKILL');
  }
});
