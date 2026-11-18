'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const base = fs.realpathSync(os.tmpdir());
const prefix = path.resolve(base, 'farm-qq-gateway-');
assert.equal(path.dirname(prefix), base);
const data = fs.mkdtempSync(prefix), old = process.env.FARM_DATA_DIR;
process.env.FARM_DATA_DIR = data;
const savedOverrides = Object.fromEntries(['FARM_LOG_DIR', 'FARM_PRIVATE_CONFIG_FILE', 'FARM_ACCOUNT_ID'].map(key => [key, process.env[key]]));
const fixtureLogDir = path.resolve(data, 'logs'), fixtureConfig = path.resolve(data, 'private-config.json');
assert.equal(path.dirname(fixtureLogDir), path.resolve(data)); assert.equal(path.dirname(fixtureConfig), path.resolve(data));
process.env.FARM_LOG_DIR = fixtureLogDir; process.env.FARM_PRIVATE_CONFIG_FILE = fixtureConfig; process.env.FARM_ACCOUNT_ID = 'synthetic-qq-fixture';
const source = require.resolve('../src/services/qq-login-gateway');
const before = fs.readFileSync(source), mode = fs.statSync(source).mode;
const { createQqLoginGateway, safeError, validPng } = require(source);
test.after(() => {
  for (const [key, value] of Object.entries(savedOverrides)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  assert.deepEqual(fs.readFileSync(source), before); assert.equal(fs.statSync(source).mode, mode);
  if (old === undefined) delete process.env.FARM_DATA_DIR; else process.env.FARM_DATA_DIR = old;
  assert.equal(path.dirname(path.resolve(data)), base); fs.rmSync(data, { recursive: true, force: true });
});
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZVQAAAAASUVORK5CYII=';
// Reserved synthetic hosts only; construct origins from explicit URL components.
const fixtureOrigin = (host = 'auth.example', protocol = 'https:') => `${protocol}//${host}`;
const config = () => ({ FARM_QQ_AUTH_ENABLED: '1', FARM_QQ_AUTH_ENDPOINT: fixtureOrigin(), FARM_QQ_AUTH_SIGNATURE: 'SyntheticFixtureSignature0123456789' });
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
function fixture(env = config()) {
  let clock = 1000000; const calls = [], timers = [];
  let respond = c => ({ ok: true, task: { id: 'upstream-fixture', status: 'waiting_scan', qrImage: png, expiresAt: clock + 120000 }, ...(c.url.endsWith('/code') ? { code: 'fixture-code' } : {}) });
  const manager = createQqLoginGateway({ env, now: () => clock,
    request: async c => { calls.push(c); return { status: 200, data: await respond(c) }; },
    schedule: (fn, ms) => { const timer = { fn, ms, unref() {} }; timers.push(timer); return timer; }, unschedule: t => { t.cleared = true; },
  });
  return { manager, env, calls, timers, advance: ms => { clock += ms; }, respond: fn => { respond = fn; }, task: (overrides = {}) => ({ ok: true, task: { id: 'upstream-fixture', status: 'waiting_scan', qrImage: png, expiresAt: clock + 120000, ...overrides } }) };
}
test('configuration defaults closed; rejects unsafe endpoints and default signatures without a request', async () => {
  const credentialUrl = new URL(fixtureOrigin()); credentialUrl.username = 'bad'; credentialUrl.password = 'bad';
  for (const overrides of [{ FARM_QQ_AUTH_ENABLED: '' }, { FARM_QQ_AUTH_ENDPOINT: fixtureOrigin('auth.example', 'http:') },
    { FARM_QQ_AUTH_ENDPOINT: credentialUrl.href }, { FARM_QQ_AUTH_ENDPOINT: `${fixtureOrigin()}?x=1` },
    { FARM_QQ_AUTH_ENDPOINT: `${fixtureOrigin()}#fragment` }, { FARM_QQ_AUTH_ENDPOINT: 'file:///tmp/auth' },
    { FARM_QQ_AUTH_SIGNATURE: 'qq-miniapp-auth-default-signing-secret' }, { FARM_QQ_AUTH_SIGNATURE: 'short' },
    { FARM_QQ_AUTH_SIGNATURE: `${'a'.repeat(40)}\n` }]) {
    const h = fixture({ ...config(), ...overrides }); assert.equal(h.manager.config().enabled, false);
    await assert.rejects(h.manager.create('owner'), { code: 'DISABLED' }); assert.equal(h.calls.length, 0);
  }
  for (const endpoint of [fixtureOrigin('127.0.0.1:8787', 'http:'), fixtureOrigin('[::1]:8787', 'http:'), fixtureOrigin('localhost:8787', 'http:')])
    assert.equal(fixture({ ...config(), FARM_QQ_AUTH_ENDPOINT: endpoint }).manager.config().enabled, true);
});

test('PNG validation rejects truncated images and excessive decoded dimensions', () => {
  assert.equal(validPng('data:image/png;base64,iVBORw0KGgo='), false, 'a signature alone is not a complete PNG');
  const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZVQAAAAASUVORK5CYII=', 'base64');
  const asImage = body => `data:image/png;base64,${body.toString('base64')}`;
  assert.equal(validPng(asImage(bytes)), true);
  assert.equal(validPng(asImage(bytes.subarray(0, bytes.length - 12))), false);
  const large = Buffer.from(bytes); large.writeUInt32BE(65535, 16);
  assert.equal(validPng(asImage(large)), false);
});

test('repeated-character signatures remain disabled and prototype names never enter public errors', async () => {
  const h = fixture({ ...config(), FARM_QQ_AUTH_SIGNATURE: 'a'.repeat(40) });
  assert.equal(h.manager.config().enabled, false);
  await assert.rejects(h.manager.create('owner'), { code: 'DISABLED' }); assert.equal(h.calls.length, 0);
  for (const code of ['constructor', '__proto__', 'toString']) assert.equal(safeError({ code }).code, 'FAILED');
});

test('actual Axios transport uses the fixed authenticated contract and refuses redirects', async t => {
  const requests = []; let redirect = false; let loggedOut = false;
  const server = http.createServer(async (req, res) => {
    let text = ''; for await (const chunk of req) text += chunk;
    requests.push({ method: req.method, path: req.url, signature: req.headers['x-api-signature'], body: JSON.parse(text || '{}') });
    if (redirect) { res.writeHead(302, { location: '/unexpected-target' }); res.end(); return; }
    let reply = { ok: true };
    if (req.url.endsWith('/qrcode') || req.url.endsWith('/status')) reply.task = {
      id: 'synthetic-gateway-task', status: req.url.endsWith('/qrcode') ? 'waiting_scan' : 'confirmed', qrImage: png, expiresAt: Date.now() + 120000,
    };
    if (req.url.endsWith('/code')) { loggedOut = true; reply.code = 'synthetic-code-after-logout'; }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(reply));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const env = { ...config(), FARM_QQ_AUTH_ENDPOINT: fixtureOrigin(`127.0.0.1:${server.address().port}`, 'http:') };
  const manager = createQqLoginGateway({ env });
  const task = await manager.create('synthetic-session');
  await manager.status('synthetic-session', task.taskId);
  const result = await manager.code('synthetic-session', task.taskId);
  assert.equal(loggedOut, true); assert.equal(result.code, 'synthetic-code-after-logout');
  assert.deepEqual(requests.map(row => row.path), ['/api/qq/login/qrcode', '/api/qq/login/status', '/api/qq/miniapp/code']);
  assert.deepEqual(requests[2].body, { taskId: 'synthetic-gateway-task', appId: '1112386029' });
  assert.ok(requests.every(row => row.method === 'POST' && row.signature === env.FARM_QQ_AUTH_SIGNATURE));
  redirect = true;
  await assert.rejects(manager.create('synthetic-session'), { code: 'FAILED' });
  assert.equal(requests.filter(row => row.path === '/unexpected-target').length, 0);
  assert.equal(requests.length, 4);
});
test('fixed request policy, local task ownership, polling interval and frozen configuration', async () => {
  const h = fixture(); const job = await h.manager.create('session-a');
  assert.notEqual(job.taskId, 'upstream-fixture'); assert.doesNotMatch(JSON.stringify(job), /upstream-fixture|signature|endpoint/);
  for (const action of ['status', 'code', 'cancel']) await assert.rejects(h.manager[action]('session-b', job.taskId), { code: 'NOT_FOUND' });
  assert.equal(h.calls.length, 1);
  h.env.FARM_QQ_AUTH_ENDPOINT = fixtureOrigin('other.example'); h.env.FARM_QQ_AUTH_SIGNATURE = 'OtherFixtureSignature012345678901234';
  await h.manager.status('session-a', job.taskId);
  await assert.rejects(h.manager.status('session-a', job.taskId), { code: 'WAIT' });
  assert.deepEqual(h.calls[1].data, { taskId: 'upstream-fixture', refresh: false });
  h.advance(2000); await h.manager.status('session-a', job.taskId);
  await h.manager.cancel('session-a', job.taskId);
  for (const call of h.calls) {
    assert.ok(call.url.startsWith(`${fixtureOrigin()}/api/qq/`)); assert.equal(call.headers['X-API-Signature'], config().FARM_QQ_AUTH_SIGNATURE);
    assert.equal(call.method, 'POST'); assert.equal(call.proxy, false); assert.equal(call.maxRedirects, 0);
    assert.equal(call.maxContentLength, 2 * 1024 * 1024); assert.equal(call.timeout, 15000);
  }
});
test('creation reserves slot; cancellation and late creation cannot unlock an unknown workflow', async () => {
  const h = fixture(); const pending = deferred(); h.respond(() => pending.promise);
  const creating = h.manager.create('owner'); await assert.rejects(h.manager.create('other'), { code: 'BUSY' });
  await assert.rejects(h.manager.cancelOwner('owner'), { code: 'CANCEL_PENDING' });
  await assert.rejects(h.manager.create('other'), { code: 'BUSY' });
  h.respond(() => ({ ok: true })); pending.resolve(h.task());
  await assert.rejects(creating, { code: 'EXPIRED' }); assert.ok(h.calls.at(-1).url.endsWith('/logout'));
  h.respond(() => h.task()); await h.manager.create('other');
});
test('strict task and image validation rejects malformed ordinary success payloads', async () => {
  for (const overrides of [{ id: '' }, { status: 'success' }, { expiresAt: null }, { expiresAt: '1120000' },
    { expiresAt: Infinity }, { expiresAt: 1000000 }, { expiresAt: 1180001 },
    { qrImage: `${fixtureOrigin('image.example')}/qr.png` }, { qrImage: 'data:image/png;base64,YWJjZA==' },
    { qrImage: `data:image/png;base64,${'A'.repeat(2800000)}` }]) {
    const h = fixture(); h.respond(c => c.url.endsWith('/logout') ? { ok: true } : h.task(overrides));
    await assert.rejects(h.manager.create('owner'), { code: 'INVALID' });
  }
});
test('code requires confirmed state; exactly one explicit request and logout-complete ok response', async () => {
  const h = fixture(); const job = await h.manager.create('owner');
  await assert.rejects(h.manager.code('owner', job.taskId), { code: 'UNCONFIRMED' });
  h.respond(() => h.task({ status: 'confirmed' })); await h.manager.status('owner', job.taskId);
  const pending = deferred(); h.respond(c => c.url.endsWith('/code') ? pending.promise : { ok: true });
  const code = h.manager.code('owner', job.taskId);
  await assert.rejects(h.manager.code('owner', job.taskId), { code: 'BUSY' });
  const request = h.calls.at(-1); assert.equal(request.timeout, 90000); assert.deepEqual(request.data, { taskId: 'upstream-fixture', appId: '1112386029' });
  pending.resolve({ ok: true, code: 'fixture-code', nickname: 'fixture', logoutStatus: 'success' });
  assert.deepEqual(await code, { code: 'fixture-code', nickname: 'fixture' });
  await assert.rejects(h.manager.code('owner', job.taskId), { code: 'NOT_FOUND' });
});
test('ordinary cancel failure and code unknown retain bounded protection and expose only local errors', async () => {
  const h = fixture(); const job = await h.manager.create('owner');
  h.respond(() => ({ ok: false, code: 'secret-upstream', error: 'private-origin' }));
  await assert.rejects(h.manager.cancel('owner', job.taskId), { code: 'CANCEL_PENDING' });
  await assert.rejects(h.manager.create('other'), { code: 'BUSY' });
  assert.doesNotMatch(JSON.stringify(safeError(new Error('private-origin'))), /private-origin/);
  h.advance(196000); await h.timers.at(-1).fn(); h.respond(() => h.task());
  const next = await h.manager.create('owner'); h.respond(() => h.task({ status: 'confirmed' })); await h.manager.status('owner', next.taskId);
  h.respond(() => ({ ok: false })); await assert.rejects(h.manager.code('owner', next.taskId), { code: 'CODE_UNKNOWN' });
  await assert.rejects(h.manager.code('owner', next.taskId)); assert.equal(h.calls.filter(c => c.url.endsWith('/code')).length, 1);
});
test('expired and cancelled in-flight Code never returns a code; rejected create is not replayed', async () => {
  for (const expire of [false, true]) {
    const h = fixture(); h.respond(() => h.task({ status: 'confirmed' })); const job = await h.manager.create('owner');
    const pending = deferred(); h.respond(() => pending.promise); const work = h.manager.code('owner', job.taskId);
    if (expire) { h.advance(120001); await h.timers.at(-1).fn(); }
    else await assert.rejects(h.manager.cancel('owner', job.taskId), { code: 'CANCEL_PENDING' });
    pending.resolve({ ok: true, code: 'must-not-escape' }); await assert.rejects(work, { code: 'CODE_UNKNOWN' });
  }
  const h = fixture(); h.respond(() => { throw new Error('transport secret'); });
  await assert.rejects(h.manager.create('owner'), { code: 'FAILED' }); await assert.rejects(h.manager.create('owner'), { code: 'BUSY' }); assert.equal(h.calls.length, 1);
});
test('only HTTP 200 and boolean ok are accepted; foreign task IDs cannot confirm a workflow', async () => {
  for (const response of [{ status: 201, data: { ok: true } }, { status: 302, data: { ok: true } },
    { status: 200, data: { ok: 'true' } }, { status: 200, data: { ok: false, error: 'private-error' } }]) {
    const manager = createQqLoginGateway({ env: config(), request: async () => response, schedule: () => ({ unref() {} }), unschedule() {} });
    await assert.rejects(manager.create('owner'), { code: 'FAILED' });
  }
  const h = fixture(); const job = await h.manager.create('owner'); h.respond(() => h.task({ id: 'foreign-task', status: 'confirmed' }));
  await assert.rejects(h.manager.status('owner', job.taskId), { code: 'INVALID' });
  await assert.rejects(h.manager.code('owner', job.taskId), { code: 'UNCONFIRMED' });
});
