'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const tempRoot = fs.realpathSync(os.tmpdir()), prefix = path.resolve(tempRoot, 'farm-qq-routes-');
assert.equal(path.dirname(prefix), tempRoot);
const dataDir = fs.mkdtempSync(prefix), previous = process.env.FARM_DATA_DIR;
process.env.FARM_DATA_DIR = dataDir;
const savedOverrides = Object.fromEntries(['FARM_LOG_DIR', 'FARM_PRIVATE_CONFIG_FILE', 'FARM_ACCOUNT_ID'].map(key => [key, process.env[key]]));
const fixtureLogDir = path.resolve(dataDir, 'logs'), fixtureConfig = path.resolve(dataDir, 'private-config.json');
assert.equal(path.dirname(fixtureLogDir), path.resolve(dataDir)); assert.equal(path.dirname(fixtureConfig), path.resolve(dataDir));
process.env.FARM_LOG_DIR = fixtureLogDir; process.env.FARM_PRIVATE_CONFIG_FILE = fixtureConfig; process.env.FARM_ACCOUNT_ID = 'synthetic-qq-fixture';
const express = require('express');
const { createQqLoginGateway } = require('../src/services/qq-login-gateway');
const { registerAdminQqLoginRoutes } = require('../src/controllers/admin-qq-login-routes');
const files = ['../src/controllers/admin-qq-login-routes', '../src/services/qq-login-gateway'].map(require.resolve);
const before = files.map(file => [fs.readFileSync(file), fs.statSync(file).mode]);
test.after(() => {
  for (const [key, value] of Object.entries(savedOverrides)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  files.forEach((file, i) => { assert.deepEqual(fs.readFileSync(file), before[i][0]); assert.equal(fs.statSync(file).mode, before[i][1]); });
  if (previous === undefined) delete process.env.FARM_DATA_DIR; else process.env.FARM_DATA_DIR = previous;
  assert.equal(path.dirname(path.resolve(dataDir)), tempRoot); fs.rmSync(dataDir, { recursive: true, force: true });
});
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const fixtureOrigin = (host = 'auth.example', protocol = 'https:') => `${protocol}//${host}`;
async function fixture(t, enabled = true) {
  const calls = [], sessions = new Map([['session-a', 'fixture-user'], ['session-b', 'fixture-user'], ['session-c', 'other-user']]);
  const timers = [];
  let responder = c => c.url.endsWith('/qrcode') || c.url.endsWith('/status')
    ? { ok: true, task: { id: 'upstream-task', status: 'confirmed', qrImage: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZVQAAAAASUVORK5CYII=', expiresAt: Date.now() + 120000 } } : { ok: true, code: 'fixture-code' };
  const manager = createQqLoginGateway({ env: enabled ? { FARM_QQ_AUTH_ENABLED: '1', FARM_QQ_AUTH_ENDPOINT: fixtureOrigin(), FARM_QQ_AUTH_SIGNATURE: 'FixtureSignature01234567890123456789' } : {},
    request: async config => { calls.push(config); return { status: 200, data: await responder(config) }; },
    schedule: (fn, ms) => { const timer = setTimeout(fn, ms); timer.unref(); timers.push(timer); return timer; },
  });
  const cancelObserved = deferred(), originalCancelOwner = manager.cancelOwner;
  manager.cancelOwner = owner => { cancelObserved.resolve(); return originalCancelOwner(owner); };
  const app = express(); app.use(express.json());
  const requireAdminToken = (req, res, next) => {
    // Mirror production middleware's destructive refresh of request identity.
    req.currentUser = null; req.adminToken = '';
    const token = req.headers['x-admin-token'];
    if (!sessions.has(token)) return res.status(401).json({ ok: false });
    req.currentUser = { username: sessions.get(token) }; req.adminToken = token; next();
  };
  app.use(requireAdminToken);
  registerAdminQqLoginRoutes({ app, requireAdminToken, manager });
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => { for (const timer of timers) clearTimeout(timer); await new Promise(resolve => server.close(resolve)); });
  const send = (action, body = {}, sessionValue = 'session-a', method = action === 'config' ? 'GET' : 'POST') => new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port: server.address().port, path: `/api/qq-login/${action}`, method,
      headers: { 'content-type': 'application/json', 'x-admin-token': sessionValue } }, response => {
      let text = ''; response.on('data', bytes => { text += bytes; }); response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(text) }));
    }); request.on('error', reject); request.end(method === 'GET' ? undefined : JSON.stringify(body));
  });
  return { calls, sessions, send, port: server.address().port, cancelObserved: cancelObserved.promise, respond: fn => { responder = fn; } };
}
test('real authenticated HTTP routes: default disabled, boolean config only, invalid bodies and foreign sessions make zero upstream calls', async t => {
  const disabled = await fixture(t, false); assert.deepEqual((await disabled.send('config')).body, { ok: true, data: { enabled: false } });
  assert.equal((await disabled.send('create')).body.code, 'DISABLED'); assert.equal(disabled.calls.length, 0);
  const h = await fixture(t);
  assert.equal((await h.send('config', {}, 'revoked')).status, 401);
  assert.equal((await h.send('create', { endpoint: fixtureOrigin('forbidden.example') })).status, 400); assert.equal(h.calls.length, 0);
  assert.equal((await h.send('create', [])).status, 400); assert.equal(h.calls.length, 0);
  const job = (await h.send('create')).body.data;
  for (const token of ['session-b', 'session-c']) for (const action of ['status', 'code', 'cancel'])
    assert.equal((await h.send(action, { taskId: job.taskId }, token)).body.code, 'NOT_FOUND');
  assert.equal(h.calls.length, 1); assert.doesNotMatch(JSON.stringify(job), /upstream-task|Signature|auth.example/);
  assert.equal((await h.send('code', { taskId: job.taskId })).body.data.code, 'fixture-code');
  assert.equal((await h.send('code', { taskId: job.taskId })).body.code, 'NOT_FOUND');
});
test('session revoked or replaced during create is re-read after await and original task is cancelled', async t => {
  for (const replaced of [false, true]) {
    const h = await fixture(t); const ready = deferred(), pending = deferred();
    h.respond(c => { if (c.url.endsWith('/qrcode')) { ready.resolve(); return pending.promise; } return { ok: true }; });
    const work = h.send('create'); await ready.promise;
    if (replaced) h.sessions.set('session-a', 'replacement-user'); else h.sessions.delete('session-a');
    pending.resolve({ ok: true, task: { id: 'late-task', status: 'confirmed', qrImage: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZVQAAAAASUVORK5CYII=', expiresAt: Date.now() + 120000 } });
    // A different valid identity must receive an explicit denial, not an unended response.
    const response = await work; assert.equal(response.status, 401); assert.ok(h.calls.some(c => c.url.endsWith('/logout')));
    assert.doesNotMatch(JSON.stringify(response.body), /late-task|fixture-code/);
  }
});
test('revocation during Code prevents delivery; ordinary cancellation failure is reported', async t => {
  const h = await fixture(t); const job = (await h.send('create')).body.data;
  h.respond(() => ({ ok: false, error: 'upstream-private' }));
  assert.equal((await h.send('cancel', { taskId: job.taskId })).body.code, 'CANCEL_PENDING');
  assert.equal((await h.send('create')).body.code, 'BUSY');
  const other = await fixture(t); const next = (await other.send('create')).body.data;
  const ready = deferred(), pending = deferred();
  other.respond(c => { if (c.url.endsWith('/code')) { ready.resolve(); return pending.promise; } return { ok: true }; });
  const work = other.send('code', { taskId: next.taskId }); await ready.promise; other.sessions.delete('session-a'); pending.resolve({ ok: true, code: 'never-deliver' });
  const response = await work; assert.equal(response.status, 401); assert.doesNotMatch(JSON.stringify(response.body), /never-deliver/);
});
test('real HTTP disconnect cancels an in-flight create and cleans its late upstream task', async t => {
  const h = await fixture(t), started = deferred(), pending = deferred(), loggedOut = deferred();
  h.respond(c => {
    if (c.url.endsWith('/qrcode')) { started.resolve(); return pending.promise; }
    assert.ok(c.url.endsWith('/logout')); loggedOut.resolve(); return { ok: true };
  });
  const request = http.request({ host: '127.0.0.1', port: h.port, path: '/api/qq-login/create', method: 'POST',
    headers: { 'content-type': 'application/json', 'x-admin-token': 'session-a' } });
  request.on('error', () => {}); request.end('{}'); await started.promise; request.destroy();
  await h.cancelObserved;
  pending.resolve({ ok: true, task: { id: 'disconnected-upstream', status: 'confirmed', qrImage: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZVQAAAAASUVORK5CYII=', expiresAt: Date.now() + 120000 } });
  await loggedOut.promise; assert.equal(h.calls.filter(c => c.url.endsWith('/logout')).length, 1);
});
