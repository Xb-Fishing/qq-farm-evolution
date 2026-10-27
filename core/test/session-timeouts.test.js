const test = require('node:test'); const assert = require('node:assert/strict');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path'); const crypto = require('node:crypto');
const vm = require('node:vm'); const { createRequire } = require('node:module');
const prefix = path.resolve(os.tmpdir(), 'session-long-handoff-'); assert.equal(path.dirname(prefix), path.resolve(os.tmpdir()));
const temporary = fs.mkdtempSync(prefix); process.env.FARM_DATA_DIR = temporary;
const { startSessionHost } = require('../src/runtime/session-host');
const registry = require('../src/runtime/session-registry');
const { prepareUpdatePreflight } = require('../src/services/wx-update-preflight');
const budgets = require('../src/runtime/session-timeouts');
const roots = new Set();
test.after(() => { for (const root of roots) fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(temporary, { recursive: true, force: true }); });
function load(relative, additions, overrides = {}, globals = {}) {
  const filename = path.resolve(__dirname, '..', relative); const native = createRequire(filename); const module = { exports: {} };
  const bindings = { module, exports: module.exports, process, Buffer, console,
    __dirname: path.dirname(filename), __filename: filename, setTimeout, clearTimeout, setImmediate,
    require: name => overrides[name] || native(name), ...globals };
  vm.compileFunction(fs.readFileSync(filename, 'utf8') + additions, Object.keys(bindings), { filename })(...Object.values(bindings));
  return module.exports;
}

test('actual socket/proxy adoption outlasts legal drain and prepare; fast status cannot hide a short helper window', { timeout: 10000 }, async () => {
  const dataDir = path.resolve(temporary, 'slow-business'); assert.ok(dataDir.startsWith(temporary + path.sep)); registry.secureDirectory(dataDir);
  const account = { id: 'synthetic-long-drain', platform: 'wx', sessionGeneration: crypto.randomUUID() };
  const paths = registry.pathsFor(dataDir, account.id); registry.secureDirectory(paths.directory); registry.secureDirectory(paths.socketRoot); roots.add(paths.socketRoot);
  let stopped = 0; let created = 0; let statusReads = 0; let expectedTarget;
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const target = name => ({ runtimeRoot: `/synthetic/${name}`, commit: name, sourceFingerprint: name });
  const host = await startSessionHost({ bootstrap: { dataDir, paths, account, hostId: crypto.randomUUID(), capability: crypto.randomBytes(32).toString('hex'),
    sourceRoot: path.resolve(__dirname, '../..'), sourceCommit: 'synthetic', sourceFingerprint: crypto.createHash('sha256').update('synthetic').digest('hex') },
    requireKernelLock: false, validateTarget: async value => value,
    game: { snapshot: () => ({ connectionEpoch: 7, connected: stopped === 0, userState: {}, status: {} }), syncConfig: c => c, stop: () => { stopped++; } },
    createBusiness: async () => {
      const index = created++;
      return { prepare: () => pause(index ? 30 : 0), activate: async () => {}, resumeProducers: async () => {},
        quiesce: async () => { await pause(175); return {}; }, resume: async () => {}, terminate: async () => {},
        deliverEvents: async () => {}, event: () => {}, syncConfig: async () => {}, relabelConfig: async () => {}, send: async () => {} };
    } });
  // Only fixture clocks are scaled. Production RPC framing, authentication,
  // proxy lifecycle and host attach queue run unchanged over a real socket.
  const { SessionRpcClient } = load('src/runtime/session-rpc.js', '', {}, {
    setTimeout: (callback, ms) => setTimeout(callback, ms >= 180000 ? ms / 1000 : ms),
  });
  const clients = []; const connect = async () => { const client = new SessionRpcClient(host.descriptor); clients.push(client); await client.connect(); return client; };
  let proxy;
  try {
    const initial = await connect(); await initial.call('claim', { manager: { id: 'synthetic-old', pid: process.pid, starttime: registry.processStarttime(process.pid) } });
    await initial.call('attach', { target: target('before'), config: {} }); await initial.call('detach'); initial.close();
    const { createSessionWorkerProxy } = load('src/runtime/session-worker-proxy.js', '', {
      './session-registry': { ...registry, ensureSession: async () => ({ state: 'present', client: await connect(), descriptor: host.descriptor }) },
      './session-contract': { resolveBusinessTarget: () => expectedTarget },
      './session-lifecycle-journal': { readLifecycleJournal: () => ({ events: [] }), readLifecycleCursor: () => 0, acknowledgeLifecycle: () => {} },
    });
    expectedTarget = target('after'); proxy = createSessionWorkerProxy({ dataDir, account, sourceRoot: path.resolve(__dirname, '../..') }); proxy.on('error', () => {});
    const origin = Date.now();
    const helper = load('scripts/evolution-apply-process.js', '\nmodule.exports.waitFor = waitFor;', {}, {
      Date: class extends Date { static now() { return origin + (Date.now() - origin) * 1000; } },
      setTimeout: (callback, ms) => setTimeout(callback, ms / 1000),
    });
    const checker = await connect();
    const ready = async () => { statusReads++; const result = await checker.call('status'); return result.facts.business?.ready && result.facts.business.commit === expectedTarget.commit; };
    assert.equal(await helper.waitFor(ready, 90000, 'synthetic old window'), false);
    assert.equal(host.core.facts().game.connected, true); assert.ok(statusReads > 3, 'status is fast rather than extending the wait by blocking');
    assert.equal(await helper.waitFor(ready, budgets.sessionReadyTimeoutMs(1), 'synthetic target business'), true);
    await proxy.ready;
    expectedTarget = target('reloaded'); await proxy.reloadBusiness();
    assert.equal(host.core.facts().business.commit, 'reloaded'); assert.equal(host.core.facts().game.connectionEpoch, 7); assert.equal(stopped, 0);
  } finally { await proxy?.detach().catch(() => {}); for (const client of clients) client.close(); await host.close(); }
});

test('real preflight budgets every sequential enabled account and keeps stopped accounts out of the wait', async () => {
  const dataDir = path.resolve(temporary, 'account-count'); assert.ok(dataDir.startsWith(temporary + path.sep)); registry.secureDirectory(dataDir);
  const file = path.resolve(dataDir, 'accounts.json'); assert.ok(file.startsWith(dataDir + path.sep));
  const accounts = [0, 1, 2, 3].map(id => ({ id: `synthetic-budget-${id}`, platform: 'qq', autoLogin: id !== 3 }));
  fs.writeFileSync(file, JSON.stringify({ accounts }), { mode: 0o600 });
  const prepared = await prepareUpdatePreflight({ processRef: { connected: false }, dataDir, targetCommit: 'a'.repeat(40) });
  try {
    assert.equal(prepared.readyTimeoutMs, budgets.sessionReadyTimeoutMs(3));
    assert.ok(prepared.readyTimeoutMs > 3 * budgets.SESSION_ATTACH_TIMEOUT_MS);
    assert.ok(budgets.SESSION_ATTACH_TIMEOUT_MS > 3 * budgets.BUSINESS_CONTROL_TIMEOUT_MS + budgets.BUSINESS_BOOT_TIMEOUT_MS);
    assert.ok(budgets.BUSINESS_CONTROL_TIMEOUT_MS > budgets.BUSINESS_DRAIN_TIMEOUT_MS);
  } finally { prepared.cleanup(); }
});
