const test = require('node:test'); const assert = require('node:assert/strict');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path'); const crypto = require('node:crypto');
const prefix = path.resolve(os.tmpdir(), 'session-host-test-'); assert.equal(path.dirname(prefix), path.resolve(os.tmpdir()));
const temporary = fs.mkdtempSync(prefix); process.env.FARM_DATA_DIR = temporary;
const { startSessionHost } = require('../src/runtime/session-host'); const { SessionRpcClient } = require('../src/runtime/session-rpc');
const { pathsFor, secureDirectory, processStarttime } = require('../src/runtime/session-registry');
const cleanup = new Set();
test.after(() => { for (const directory of cleanup) fs.rmSync(directory, { recursive: true, force: true }); fs.rmSync(temporary, { recursive: true, force: true }); });
async function fixture(name) {
  const dataDir = path.resolve(temporary, name); assert.equal(dataDir.startsWith(temporary + path.sep), true);
  secureDirectory(dataDir); const account = { id: name, ownerId: 'synthetic-owner', platform: 'wx', sessionGeneration: crypto.randomUUID() };
  const paths = pathsFor(dataDir, account.id); secureDirectory(paths.directory); secureDirectory(paths.socketRoot); cleanup.add(paths.socketRoot);
  const messages = []; let created = 0; let stopped = 0; let latest; const sent = [];
  const game = { snapshot: () => ({ connectionEpoch: 7, connected: stopped === 0, wireSequence: sent.length }),
    syncConfig: value => value, stop: () => { stopped++; }, request: async args => { sent.push(args); return Buffer.from([sent.length]); } };
  const host = await startSessionHost({ bootstrap: { dataDir, paths, account, hostId: crypto.randomUUID(),
    capability: crypto.randomBytes(32).toString('hex'), sourceRoot: path.resolve(__dirname, '../..'), sourceCommit: 'synthetic-commit', sourceFingerprint: crypto.createHash('sha256').update(name).digest('hex') },
    game, requireKernelLock: false, validateTarget: async target => target,
    createBusiness: async context => {
      created++; latest = context;
      return { prepare: async () => {}, activate: async () => {}, resumeProducers: async () => {}, quiesce: async () => ({ nextRunAt: 100 }),
        terminate: async () => {}, resume: async () => {}, deliverEvents: async () => {}, event: () => {}, syncConfig: async () => {},
        send: async message => { messages.push(message); if (message.method !== 'wait') context.onMaster({ type: 'api_response', id: message.id, result: message.method }); } };
    },
  });
  const clients = [];
  const connect = async descriptor => { const client = new SessionRpcClient(descriptor || host.descriptor); clients.push(client); await client.connect(); return client; };
  const claim = (client, id) => client.call('claim', { manager: { id, pid: process.pid, starttime: processStarttime(process.pid) } });
  return { host, connect, claim, messages, get created() { return created; }, get stopped() { return stopped; },
    finish: (id, result) => latest.onMaster({ type: 'api_response', id, result }),
    close: async () => { for (const client of clients) client.close(); await host.close(); } };
}
const target = { runtimeRoot: '/synthetic/accepted', commit: 'synthetic-business', sourceFingerprint: 'synthetic-content' };

test('real private socket authenticates, adopts and updates one business while retaining its connection', async () => {
  const f = await fixture('adoption');
  try {
    const first = await f.connect(); await f.claim(first, 'manager-one');
    const initial = await first.call('attach', { target, config: {} }); assert.equal(initial.game.connectionEpoch, 7);
    const second = await f.connect();
    await assert.rejects(f.claim(second, 'manager-two'), { code: 'SESSION_MANAGER_ALREADY_ATTACHED' });
    await first.call('detach'); await f.claim(second, 'manager-two');
    const adopted = await second.call('attach', { target, config: {} });
    assert.equal(adopted.unchanged, true); assert.equal(adopted.game.connected, true); assert.equal(f.created, 1); assert.equal(f.stopped, 0);
    const status = await second.call('status'); assert.equal(status.facts.business.commit, target.commit);
  } finally { await f.close(); }
});

test('old and new management API IDs cannot receive each other\'s late response', async () => {
  const f = await fixture('api-ownership');
  try {
    const first = await f.connect(); const oldResponses = []; first.on('event', value => { if (value.message?.type === 'api_response') oldResponses.push(value.message); });
    await f.claim(first, 'old'); await first.call('attach', { target, config: {} });
    await first.call('send', { message: { type: 'api_call', id: 1, method: 'wait', args: [] } }); const oldId = f.messages[0].id;
    await first.call('detach'); const second = await f.connect(); const newResponses = [];
    second.on('event', value => { if (value.message?.type === 'api_response') newResponses.push(value.message); });
    await f.claim(second, 'new'); await second.call('attach', { target, config: {} });
    await second.call('send', { message: { type: 'api_call', id: 1, method: 'new-result', args: [] } });
    f.finish(oldId, 'old-result'); await second.call('status'); await first.call('status');
    assert.deepEqual(oldResponses.map(value => [value.id, value.result]), [[1, 'old-result']]);
    assert.deepEqual(newResponses.map(value => [value.id, value.result]), [[1, 'new-result']]);
    assert.notEqual(f.messages[0].id, f.messages[1].id);
  } finally { await f.close(); }
});

test('an invalid capability cannot read account state; authenticated revocation closes the actual session once', async () => {
  const f = await fixture('revocation');
  try {
    await assert.rejects(f.connect({ ...f.host.descriptor, capability: crypto.randomBytes(32).toString('hex') }), { code: 'SESSION_AUTHENTICATION_FAILED' });
    const valid = await f.connect(); await f.claim(valid, 'owner'); await valid.call('attach', { target, config: {} });
    const result = await valid.call('revoke'); assert.equal(result.game.connected, false);
    await f.host.close(); assert.equal(f.stopped, 1); assert.equal(fs.existsSync(f.host.descriptor.socketPath), false);
  } finally { await f.close(); }
});
