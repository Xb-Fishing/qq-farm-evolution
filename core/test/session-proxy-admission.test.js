const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'); const path = require('node:path'); const os = require('node:os');
const vm = require('node:vm'); const { createRequire } = require('node:module'); const { EventEmitter } = require('node:events');
const tempRoot = fs.realpathSync(os.tmpdir()); const prefix = path.resolve(tempRoot, 'session-api-admission-');
assert.equal(path.dirname(prefix), tempRoot); const dataDir = fs.mkdtempSync(prefix);
process.env.FARM_DATA_DIR = dataDir;
const file = path.resolve(__dirname, '../src/runtime/session-worker-proxy.js'); const source = fs.readFileSync(file, 'utf8');
test.after(() => { assert.equal(fs.readFileSync(file, 'utf8'), source); fs.rmSync(dataDir, { recursive: true, force: true }); });

test('API calls during cold admission fail immediately and are never sent later after readiness', async (t) => {
  let release; let entered;
  const gate = new Promise(resolve => { release = resolve; });
  const attaching = new Promise(resolve => { entered = resolve; });
  const sends = []; const responses = [];
  const target = { runtimeRoot: path.resolve(__dirname, '../..'), commit: 'a'.repeat(40), sourceFingerprint: 'b'.repeat(64) };
  const facts = { sequence: 1, host: { hostId: 'synthetic-host', pid: 12345, sourceCommit: target.commit },
    game: { connected: true, terminal: false, status: {} }, business: { ...target, ready: true, epoch: 'synthetic-business' } };
  const client = new EventEmitter(); client.ready = true; client.socket = { destroyed: false, writable: true };
  client.call = async (method, args) => {
    if (method === 'attach') { entered(); await gate; }
    if (method === 'status') return { facts, lifecycle: { events: [] } };
    if (method === 'send') sends.push(args.message);
    return facts;
  };
  client.close = () => { client.ready = false; client.socket.destroyed = true; };
  const original = createRequire(file); const mod = { exports: {} };
  const mocks = {
    './session-registry': { ensureSession: async () => ({ state: 'present', descriptor: { pid: 12345 }, client }), processStarttime: () => 'synthetic-start' },
    './session-contract': { resolveBusinessTarget: () => target },
    './session-lifecycle-journal': { readLifecycleJournal: () => ({ events: [] }), readLifecycleCursor: () => 0, acknowledgeLifecycle() {} },
  };
  vm.compileFunction(source, ['require', 'module', 'exports'], { filename: file })(name => mocks[name] || original(name), mod, mod.exports);
  const proxy = mod.exports.createSessionWorkerProxy({ dataDir, account: { id: 'synthetic-account' }, sourceRoot: target.runtimeRoot });
  proxy.on('error', () => {}); proxy.on('message', message => { if (message.type === 'api_response') responses.push(message); });
  t.after(async () => { release(); await proxy.ready.catch(() => {}); await proxy.detach(); });
  await attaching;
  assert.equal(proxy.send({ type: 'api_call', id: 1, method: 'useItem', args: [20001, 1] }), false);
  await new Promise(resolve => queueMicrotask(resolve));
  assert.equal(responses.length, 1); assert.match(responses[0].error, /账号未就绪/); assert.equal(sends.length, 0);
  release(); await proxy.ready;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sends.length, 0, 'readiness cannot replay the rejected economic request');
  proxy.send({ type: 'api_call', id: 2, method: 'getBag', args: [] });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(sends.map(message => message.id), [2]);
});
