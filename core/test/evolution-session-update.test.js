const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { execFileSync } = require('node:child_process');
const prefix = path.resolve(os.tmpdir(), 'evolution-session-update-');
assert.equal(path.dirname(prefix), path.resolve(os.tmpdir()));
const temporary = fs.mkdtempSync(prefix);
process.env.FARM_DATA_DIR = path.join(temporary, 'data');
const { inspectDeploymentImpact } = require('../src/services/evolution-deployment-impact');
const { requestParent, legacyHasNoLiveWx, prepareUpdatePreflight } = require('../src/services/wx-update-preflight');
test.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
const head = 'a'.repeat(40);
function write(relative, body) {
  const file = path.resolve(temporary, relative);
  assert.equal(file.startsWith(temporary + path.sep), true);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body, { mode: 0o600 });
  return file;
}
function repo(name) {
  const dir = path.join(temporary, name);
  write(`${name}/core/src/runtime.js`, 'module.exports=1;');
  write(`${name}/core/test/example.test.js`, 'old test');
  write(`${name}/docs/guide.md`, 'old guide');
  write(`${name}/docs/CHANGELOG.md`, 'old release notes');
  write(`${name}/core/package.json`, '{}');
  const git = args => execFileSync('git', args, { cwd: dir, stdio: 'pipe', encoding: 'utf8' });
  git(['init', '-q']); git(['add', '.']);
  return dir;
}

test('exact production bytes and modes preserve connections for test/docs-only updates; runtime and dependencies require deployment', () => {
  const left = repo('prior'); const right = repo('next');
  write('next/core/test/example.test.js', 'new test'); write('next/docs/guide.md', 'new guide');
  assert.equal(inspectDeploymentImpact(left, right).equivalent, true);
  write('next/docs/CHANGELOG.md', 'new release notes');
  assert.equal(inspectDeploymentImpact(left, right).equivalent, false,
    '单改前端实际导入的更新记录必须重新交付资源，不能误报无需部署');
  write('next/docs/CHANGELOG.md', 'old release notes');
  for (const file of ['core/src/runtime.js', 'core/package.json']) {
    const original = fs.readFileSync(path.join(right, file));
    write(`next/${file}`, 'changed');
    assert.equal(inspectDeploymentImpact(left, right).equivalent, false);
    write(`next/${file}`, original);
  }
  const file = path.join(right, 'core/src/runtime.js'); const mode = fs.statSync(file).mode & 0o777;
  try { fs.chmodSync(file, mode ^ 0o100); assert.equal(inspectDeploymentImpact(left, right).equivalent, false); }
  finally { fs.chmodSync(file, mode); }
});

test('helper preparation timeout/disconnect/rejection never grants stopping permission', async () => {
  for (const event of ['timeout', 'disconnect', 'reject']) {
    const peer = new EventEmitter(); peer.send = (message, cb) => {
      cb?.();
      if (event === 'disconnect') queueMicrotask(() => peer.emit('disconnect'));
      if (event === 'reject') queueMicrotask(() => peer.emit('message', { ...message, type: 'wx_restart_response', ok: false }));
    };
    await assert.rejects(requestParent(peer, { action: 'prepare', requestId: 'fixture', nonce: 'fixture', targetCommit: head }, 5));
    assert.equal(peer.listenerCount('message'), 0); assert.equal(peer.listenerCount('disconnect'), 0);
  }
});

test('legacy migration requires explicit offline evidence for every WX account', async () => {
  const dataDir = path.join(temporary, 'legacy-data');
  write('legacy-data/accounts.json', JSON.stringify({ accounts: [{ id: 'fixture-wx', platform: 'wx' }] }));
  write('legacy-data/admin-sessions.json', JSON.stringify([{ token: 'fixture-only', user: { role: 'admin' } }]));
  for (const connected of [true, null, false]) {
    const fetchImpl = async () => ({ ok: true, json: async () => ({ ok: true, data: { connection: { connected } } }) });
    assert.equal(await legacyHasNoLiveWx({ dataDir, adminPort: 0, fetchImpl }), connected === false);
  }
  const processRef = { connected: false };
  await assert.rejects(prepareUpdatePreflight({ processRef, dataDir, adminPort: 1 }));
});
