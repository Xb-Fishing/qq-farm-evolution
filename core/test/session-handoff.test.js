const test = require('node:test'); const assert = require('node:assert/strict');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const vm = require('node:vm'); const { EventEmitter } = require('node:events'); const { createRequire } = require('node:module');
const prefix = path.resolve(os.tmpdir(), 'session-handoff-failure-');
assert.equal(path.dirname(prefix), path.resolve(os.tmpdir()));
const temporary = fs.mkdtempSync(prefix); process.env.FARM_DATA_DIR = temporary;
test.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
const registry = require('../src/runtime/session-registry');
const barrier = require('../src/runtime/session-handoff-barrier');
const { collectSessionProofs } = require('../src/runtime/session-update');
const { createWxRestartCoordinator } = require('../src/runtime/wx-restart-handoff');
const { prepareUpdatePreflight } = require('../src/services/wx-update-preflight');
const head = 'a'.repeat(40); let fixtureId = 0;
function fixture() {
  const dataDir = path.resolve(temporary, `case-${++fixtureId}`); assert.ok(dataDir.startsWith(temporary + path.sep));
  fs.mkdirSync(dataDir, { mode: 0o700 });
  const request = { nonce: `synthetic-handoff-${fixtureId}`, targetCommit: head,
    oldPid: process.pid, oldStartTicks: registry.processStarttime(process.pid) };
  const begin = () => barrier.beginSessionBarrier({ dataDir, nonce: request.nonce,
    blockedPid: request.oldPid, blockedStarttime: request.oldStartTicks });
  return { dataDir, request, begin, release: () => barrier.releaseSessionBarrier(dataDir, request.nonce) };
}
function vmModule(relative, overrides) {
  const filename = path.resolve(__dirname, '../src', relative); const native = createRequire(filename); const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module, exports: module.exports, process, Buffer, Date, console,
    require: name => overrides[name] || native(name), setTimeout, clearTimeout }, { filename });
  return module.exports;
}

test('an empty persistent host set still validates its barrier; legacy coordinators need no barrier', async () => {
  const f = fixture(); let validations = 0;
  const base = { getAccounts: () => ({ accounts: [] }), isAutoLogin: () => true, workers: {}, autoCodeRefresh: {} };
  const persistent = createWxRestartCoordinator({ ...base, preparePersistentSessions: async () => { f.begin(); return []; },
    validatePersistentSessions: proofs => { assert.equal(proofs.length, 0); validations++; return false; },
    releasePersistentSessions: f.release });
  assert.equal((await persistent.prepareWxRestart(f.request)).ok, false);
  assert.equal(validations, 1); assert.equal(barrier.readSessionBarrier(f.dataDir), null);
  const legacy = createWxRestartCoordinator(base); const prepared = await legacy.prepareWxRestart(f.request);
  assert.equal(prepared.ok, true); assert.equal(await legacy.validateWxRestart(prepared.handoff), true);
});

test('proof collection releases only its own barrier after read failure or cancellation', async () => {
  for (const cancelled of [false, true]) {
    const f = fixture(); let checks = 0;
    if (!cancelled) fs.writeFileSync(path.join(f.dataDir, 'accounts.json'), '{malformed');
    else { f.begin(); fs.writeFileSync(path.join(f.dataDir, 'persistent-sessions/bootstrap-aaaa.json'), '{}'); }
    await assert.rejects(collectSessionProofs(f.dataDir, { barrier: { nonce: f.request.nonce,
      blockedPid: process.pid, blockedStarttime: f.request.oldStartTicks }, guard: () => !cancelled || ++checks < 2 }));
    assert.equal(barrier.readSessionBarrier(f.dataDir), null);
    f.begin(); barrier.releaseSessionBarrier(f.dataDir, 'unrelated-nonce');
    assert.equal(barrier.readSessionBarrier(f.dataDir).nonce, f.request.nonce); f.release();
  }
});

test('no-IPC legacy evidence failure cannot leave the old manager blocked', async () => {
  const f = fixture(); f.begin(); f.release();
  fs.writeFileSync(path.join(f.dataDir, 'accounts.json'), JSON.stringify({ accounts: [{ id: 'synthetic-wx', platform: 'wx', autoLogin: false }] }));
  await assert.rejects(prepareUpdatePreflight({ processRef: { connected: false }, dataDir: f.dataDir,
    oldPid: process.pid, oldStartTicks: f.request.oldStartTicks, targetCommit: head, adminPort: 1 }), { wxUpdateReason: 'legacy' });
  assert.equal(barrier.readSessionBarrier(f.dataDir), null);
  barrier.assertSessionCreationAllowed(f.dataDir);
});

test('helper rejection after a successful IPC reply releases the prepared nonce and cancels parent work', async () => {
  const f = fixture(); const peer = new EventEmitter(); peer.connected = true; let cancellations = 0;
  peer.send = (message, callback) => {
    callback?.();
    if (message.type === 'wx_restart_cancel') { cancellations++; return; }
    barrier.beginSessionBarrier({ dataDir: f.dataDir, nonce: message.nonce, blockedPid: process.pid, blockedStarttime: f.request.oldStartTicks });
    queueMicrotask(() => peer.emit('message', { ...message, type: 'wx_restart_response', ok: true,
      handoff: { version: 1, nonce: message.nonce, targetCommit: head, oldPid: process.pid,
        oldStartTicks: f.request.oldStartTicks, accounts: [], createdAt: 1, expiresAt: 2 } }));
  };
  await assert.rejects(prepareUpdatePreflight({ processRef: peer, dataDir: f.dataDir,
    oldPid: process.pid, oldStartTicks: f.request.oldStartTicks, targetCommit: head }), { wxUpdateReason: 'expired' });
  assert.equal(cancellations, 1); assert.equal(barrier.readSessionBarrier(f.dataDir), null);
});

test('successful preparation transfers cleanup, while coordinator failure always releases it', async () => {
  for (const success of [false, true]) {
    const f = fixture();
    const coordinator = createWxRestartCoordinator({ getAccounts: () => ({ accounts: [] }), isAutoLogin: () => true, workers: {}, autoCodeRefresh: {},
      preparePersistentSessions: async () => { f.begin(); if (!success) throw new Error('synthetic scan failure'); return []; },
      validatePersistentSessions: () => true, releasePersistentSessions: f.release });
    if (!success) await assert.rejects(coordinator.prepareWxRestart(f.request), /synthetic scan failure/);
    else {
      assert.equal((await coordinator.prepareWxRestart(f.request)).ok, true);
      assert.equal(barrier.readSessionBarrier(f.dataDir).nonce, f.request.nonce);
      coordinator.cancelWxRestart(f.request);
    }
    assert.equal(barrier.readSessionBarrier(f.dataDir), null);
  }
});

test('zombie owner/blocked identities neither retain nor create a live barrier', () => {
  const f = fixture(); f.begin(); let liveChecks = 0;
  const isolated = vmModule('runtime/session-handoff-barrier.js', { './session-registry': { ...registry,
    processIsLive: () => { liveChecks++; return false; } } });
  assert.equal(isolated.readSessionBarrier(f.dataDir), null);
  assert.equal(f.begin().nonce, f.request.nonce, 'the actual live owner remains valid');
  assert.throws(() => isolated.beginSessionBarrier({ dataDir: f.dataDir, nonce: 'different-nonce',
    blockedPid: process.pid, blockedStarttime: f.request.oldStartTicks }), /identity changed/);
  assert.ok(liveChecks >= 2); f.release();
});

test('a deleted account with a reaped or zombie host does not block final readiness', async () => {
  const f = fixture(); let liveChecks = 0;
  const isolated = vmModule('runtime/session-update.js', { './session-registry': { ...registry,
    processIsLive: () => { liveChecks++; return false; }, processStarttime: () => 'synthetic-old-start' } });
  const result = await isolated.verifySessionProofs({ dataDir: f.dataDir, final: true, expectedBusinessCommit: head,
    proofs: [{ accountId: 'synthetic-deleted', pid: 12345, starttime: 'synthetic-old-start', binding: 'synthetic-old-binding' }] });
  assert.equal(result.ok, true); assert.equal(result.outcomes[0].state, 'changed_by_account_action'); assert.equal(liveChecks, 1);
});

test('the actual helper finalizer removes its private environment after a post-ready early return', () => {
  const f = fixture();
  const file = name => { const target = path.resolve(f.dataDir, name); assert.ok(target.startsWith(f.dataDir + path.sep)); fs.writeFileSync(target, 'synthetic private fixture', { mode: 0o600 }); return target; };
  const contextFile = file('apply-context.json'); const handoff = file('handoff.json');
  const buildRoot = path.resolve(f.dataDir, 'build'); assert.ok(buildRoot.startsWith(f.dataDir + path.sep)); fs.mkdirSync(buildRoot);
  const source = fs.readFileSync(path.resolve(__dirname, '../scripts/evolution-apply-process.js'), 'utf8');
  const start = source.lastIndexOf('  } finally {'); const end = source.indexOf('\n  }\n}', start);
  assert.ok(start > 0 && end > start);
  const finalizer = source.slice(start + '  } finally {'.length, end);
  let cleanups = 0;
  const result = vm.runInNewContext(`(() => { try { return 'post-ready-revalidation-failed'; } finally { ${finalizer} } })()`, {
    fs, contextFile, buildRoot, wxPreflight: { file: handoff, cleanup: () => { cleanups++; throw new Error('synthetic cleanup failure'); } },
  });
  assert.equal(result, 'post-ready-revalidation-failed'); assert.equal(cleanups, 1);
  for (const target of [contextFile, handoff, buildRoot]) assert.equal(fs.existsSync(target), false);
});
