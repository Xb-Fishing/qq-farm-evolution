const test = require('node:test'); const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path'); const net = require('node:net');
const prefix = path.resolve(os.tmpdir(), 'session-registry-test-'); assert.equal(path.dirname(prefix), path.resolve(os.tmpdir()));
const temporary = fs.mkdtempSync(prefix); process.env.FARM_DATA_DIR = temporary;
const { secureDirectory, pathsFor, socketIdentity, processStarttime, descriptorFor, bindingIdentity } = require('../src/runtime/session-registry');
const { framed } = require('../src/runtime/session-rpc'); const { encode } = require('../src/runtime/session-codec');
const cleanup = new Set();
test.after(() => { for (const directory of cleanup) fs.rmSync(directory, { recursive: true, force: true }); fs.rmSync(temporary, { recursive: true, force: true }); });
function target(name) { const file = path.resolve(temporary, name); assert.equal(file.startsWith(temporary + path.sep), true); return file; }

test('persistent binding follows owner and authorization nonce without tying it to token rotation or display names', () => {
  const account = { id: 'synthetic-account', username: 'synthetic-owner', platform: 'wx', wxid: 'synthetic-wx', sessionGeneration: 'generation-one', name: 'display-one' };
  const binding = bindingIdentity(account);
  assert.equal(bindingIdentity({ ...account, name: 'display-two', accesstoken: crypto.randomUUID() }), binding);
  assert.notEqual(bindingIdentity({ ...account, sessionGeneration: 'generation-two' }), binding);
  assert.notEqual(bindingIdentity({ ...account, username: 'another-owner' }), binding);
});

test('private directories reject symlink ancestors before creating any child', () => {
  const outside = target('outside'); fs.mkdirSync(outside, { mode: 0o700 });
  const link = target('link'); fs.symlinkSync(outside, link);
  assert.throws(() => secureDirectory(path.join(link, 'new', 'nested')), /unavailable/);
  assert.deepEqual(fs.readdirSync(outside), []);
  const privateDirectory = target('private'); secureDirectory(privateDirectory); assert.equal(fs.statSync(privateDirectory).mode & 511, 0o700);
  fs.chmodSync(privateDirectory, 0o755); assert.throws(() => secureDirectory(privateDirectory), /unavailable/);
});

test('session adoption verifies actual listening socket ownership and PID starttime', async () => {
  if (process.platform !== 'linux') return;
  const paths = pathsFor(temporary, 'synthetic-account');
  secureDirectory(paths.socketRoot); cleanup.add(paths.socketRoot);
  const server = net.createServer();
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(paths.socketPath, resolve); });
    fs.chmodSync(paths.socketPath, 0o600);
    const starttime = processStarttime(process.pid);
    const inode = socketIdentity(process.pid, starttime, paths.socketPath); assert.match(inode, /^\d+$/);
    assert.equal(socketIdentity(process.pid, `${starttime}-wrong`, paths.socketPath), '');
    assert.equal(socketIdentity(99999999, starttime, paths.socketPath), '');
    fs.chmodSync(paths.socketPath, 0o666); assert.equal(socketIdentity(process.pid, starttime, paths.socketPath), '');
  } finally { await new Promise(resolve => server.close(resolve)); }
  const missing = target('does-not-exist'); assert.equal(descriptorFor(missing, { id: 'synthetic-account' }).state, 'absent');
  assert.equal(fs.existsSync(missing), false, 'read-only lookup does not create data directories');
});

test('an asynchronous framed handler rejection closes its socket without unhandled rejection', async () => {
  const server = net.createServer(socket => framed(socket, async () => { await Promise.resolve(); throw new Error('bad request'); }));
  let client;
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    client = net.createConnection(server.address().port, '127.0.0.1');
    await new Promise((resolve, reject) => { client.once('connect', resolve); client.once('error', reject); });
    const closed = new Promise(resolve => client.once('close', resolve));
    const bytes = encode({ kind: 'request' }); const header = Buffer.alloc(4); header.writeUInt32BE(bytes.length);
    client.write(Buffer.concat([header, bytes])); await closed;
  } finally { client?.destroy(); await new Promise(resolve => server.close(resolve)); }
});
