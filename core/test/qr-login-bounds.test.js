const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const http = require('node:http');
const crypto = require('node:crypto');
const { test } = require('node:test');

// No data fixture is written: the isolated data root is a sentinel for accidental
// imports. All fixtures below live in memory; only loopback HTTP is permitted.
const previousDataDir = process.env.FARM_DATA_DIR;
const dataDir = path.join(fs.realpathSync(os.tmpdir()), `qr-bounds-${process.pid}`);
assert.equal(fs.existsSync(dataDir), false);
process.env.FARM_DATA_DIR = dataDir;
const express = require('express');
const axios = require('axios');
const servicePath = require.resolve('../src/services/qrlogin');
const routePath = require.resolve('../src/controllers/admin-qr-login-routes');
const { MiniProgramLoginSession: mini } = require(servicePath);
const fingerprints = () => [servicePath, routePath, __filename].map(file =>
  ({ sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
    mode: fs.statSync(file).mode & 0o777 }));
const before = fingerprints();
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) {
  for (let count = 0; count < 100 && !predicate(); count++) await pause(5);
  assert.ok(predicate(), 'fixture reached expected state');
}

async function fixture(run, { deadline = 300, service = mini } = {}) {
  const originalAdapter = axios.defaults.adapter;
  const originalError = console.error;
  const logs = [];
  console.error = (...args) => logs.push(args.join(' '));
  const calls = [];
  const pending = new Set();
  const timers = new Set();
  const responses = [];
  const sockets = new Set();
  let behavior = 'wait';
  let authBehavior = 'auth';
  let activeAdapters = 0;
  const reply = (config, data) => ({ config, status: 200, statusText: 'OK', headers: {}, data });
  axios.defaults.adapter = config => {
    calls.push(config);
    const isAuth = config.method === 'post';
    const mode = isAuth ? authBehavior : behavior;
    if (mode === 'fail') return Promise.reject(new Error('secret-upstream-text'));
    if (mode === 'hold' || mode === 'late') {
      activeAdapters++;
      return new Promise((resolve, reject) => {
        const item = { finish: null };
        const finish = (error) => {
          if (!pending.delete(item)) return;
          activeAdapters--;
          config.signal?.removeEventListener('abort', abort);
          if (error) reject(error);
          else resolve(reply(config, isAuth ? { code: 'auth' }
            : { code: 0, data: { ok: 1, ticket: 'ticket' } }));
        };
        const abort = () => finish(new axios.CanceledError());
        item.finish = finish;
        pending.add(item);
        if (mode === 'hold') {
          config.signal?.addEventListener('abort', abort, { once: true });
          if (config.signal?.aborted) abort();
        }
      });
    }
    if (isAuth) return Promise.resolve(reply(config, { code: mode === 'empty' ? '' : 'auth' }));
    if (config.url.includes('GetLoginCode')) return Promise.resolve(reply(config, { code: 0, data: { code: mode === 'empty' ? '' : 'synthetic' } }));
    return Promise.resolve(reply(config, mode === 'used' ? { code: -10001 }
      : mode === 'error' ? { code: 'secret-upstream-text' }
        : { code: 0, data: { ok: mode === 'wait' ? 0 : 1,
          ticket: mode === 'missing' ? '' : 'ticket', uin: '', nick: 'synthetic' } }));
  };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(routePath, 'utf8'), {
    module, require: () => ({ MiniProgramLoginSession: service }), AbortController,
    setTimeout(fn, ms) {
      const timer = setTimeout(() => { timers.delete(timer); fn(); }, ms === 15000 ? deadline : ms);
      timers.add(timer);
      return timer;
    },
    clearTimeout(timer) { timers.delete(timer); clearTimeout(timer); },
  }, { filename: routePath });
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { responses.push(res); next(); });
  module.exports.registerAdminQrLoginRoutes({ app });
  const server = http.createServer(app);
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  function request(endpoint = 'check', code = 'synthetic') {
    let client;
    let clientDeadlineExpired = false;
    const result = new Promise((resolve, reject) => {
      client = http.request({ hostname: '127.0.0.1', port: server.address().port,
        path: `/api/qr/${endpoint}`, method: 'POST', headers: { 'Content-Type': 'application/json' } }, res => {
        let body = '';
        res.on('data', chunk => { body += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
      });
      client.setTimeout(1500, () => {
        clientDeadlineExpired = true;
        client.destroy(new Error('Fixture client deadline'));
      });
      client.on('error', error => {
        // A route that never responds is a measured behavior, while unrelated
        // transport/setup errors must still fail as their original error.
        if (clientDeadlineExpired) resolve({ status: null, clientDeadlineExpired: true });
        else reject(error);
      });
      client.end(JSON.stringify({ code }));
    });
    // Concurrent baseline requests may reach the fixture deadline before their
    // turn is awaited. Preserve rejection for the caller without orphan events.
    result.catch(() => {});
    return { result, destroy: () => client.destroy() };
  }
  try {
    await run({ calls, logs, pending, responses, timers, request,
      mode: value => { behavior = value; }, authMode: value => { authBehavior = value; },
      active: () => activeAdapters });
  } finally {
    for (const item of pending) item.finish();
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
    await pause(10);
    axios.defaults.adapter = originalAdapter;
    console.error = originalError;
    for (const timer of timers) clearTimeout(timer);
    assert.equal(timers.size, 0, 'route deadline timers cleaned');
    assert.equal(pending.size, 0);
    assert.equal(activeAdapters, 0);
    for (const res of responses) assert.equal(res.listenerCount('close'), 0, 'close listeners cleaned');
  }
}

test('QR login bounded transports and real HTTP lifecycle', async t => {
  try {
    await t.test('three transports carry finite timeout and the same signal; code is one encoded parameter', async () => {
      await fixture(async f => {
        const controller = new AbortController();
        await mini.requestLoginCode({ signal: controller.signal });
        await mini.queryStatus('a&injected=?value', { signal: controller.signal });
        await mini.getAuthCode('ticket', undefined, { signal: controller.signal });
        assert.equal(f.calls.length, 3);
        for (const config of f.calls) {
          assert.equal(config.timeout, 10000);
          assert.equal(config.signal, controller.signal);
        }
        const query = new URL(f.calls[1].url).searchParams;
        assert.deepEqual([...query], [['code', 'a&injected=?value']]);
      });
    });
    await t.test('service rejects malformed input before transport', async () => {
      await fixture(async f => {
        for (const code of [undefined, null, 1, {}, [], '', '  ', 'x'.repeat(513), 'a\n', 'a\0', 'a\u007F', 'a\u0085']) {
          await assert.rejects(mini.queryStatus(code));
        }
        assert.equal(f.calls.length, 0);
        await mini.queryStatus('x'.repeat(512));
        assert.equal(f.calls.length, 1);
      });
    });
    await t.test('HTTP create, Wait, Used and complete OK retain shapes', async () => {
      await fixture(async f => {
        const create = await f.request('create').result;
        assert.equal(create.body.ok, true);
        assert.equal(create.body.data.code, 'synthetic');
        assert.match(create.body.data.image, /^data:image\/png;base64,/);
        for (const [mode, status] of [['wait', 'Wait'], ['used', 'Used'], ['ok', 'OK']]) {
          f.mode(mode);
          const response = await f.request().result;
          assert.equal(response.status, 200);
          assert.equal(response.body.data.status, status);
          if (status === 'OK') assert.equal(response.body.data.code, 'auth');
        }
        for (const config of f.calls) {
          assert.equal(config.timeout, 10000);
          assert.ok(config.signal instanceof AbortSignal);
        }
      });
    });
    await t.test('HTTP rejects malformed code and incomplete successes; upstream errors remain private', async () => {
      await fixture(async f => {
        for (const code of [null, 1, {}, [], '', ' ', 'x'.repeat(513), 'x\n', 'x\u007F', 'x\u0085']) {
          assert.equal((await f.request('check', code).result).status, 400);
        }
        assert.equal(f.calls.length, 0);
        for (const mode of ['fail', 'missing', 'error']) {
          f.mode(mode);
          const response = await f.request().result;
          assert.equal(response.status, 500);
          assert.equal(response.body.ok, false);
          assert.ok(!JSON.stringify(response).includes('secret-upstream-text'));
        }
        assert.equal(f.calls.filter(call => call.method === 'post').length, 0, 'missing ticket never exchanged');
        f.mode('ok'); f.authMode('empty');
        assert.equal((await f.request().result).body.ok, false);
        f.authMode('fail');
        assert.equal((await f.request().result).body.ok, false);
        f.mode('fail');
        assert.equal((await f.request('create').result).status, 500);
        f.mode('empty');
        assert.equal((await f.request('create').result).body.ok, false, 'empty login code cannot produce a usable QR');
        assert.ok(f.logs.length > 0);
        assert.ok(!f.logs.join('').includes('secret-upstream-text'));
      });
    });
    await t.test('shared capacity is four; abort settles transports and capacity recovers', async () => {
      await fixture(async f => {
        f.mode('hold');
        const requests = [f.request('create'), f.request(), f.request(), f.request()];
        await until(() => f.active() === 4);
        assert.equal((await f.request().result).status, 429);
        assert.equal(f.calls.length, 4);
        for (const request of requests) assert.equal((await request.result).status, 504);
        await until(() => f.active() === 0);
        assert.ok(f.calls.every(call => call.signal.aborted));
        f.mode('wait');
        assert.equal((await f.request().result).body.data.status, 'Wait');
      }, { deadline: 80 });
    });
    await t.test('deadline during exchange aborts; client close aborts either phase', async () => {
      await fixture(async f => {
        f.mode('ok'); f.authMode('hold');
        assert.equal((await f.request().result).status, 504);
        await until(() => f.active() === 0);
        assert.ok(f.calls[1].signal.aborted);
        for (const phase of ['query', 'exchange']) {
          f.mode(phase === 'query' ? 'hold' : 'ok');
          const request = f.request();
          const rejected = request.result.catch(error => error);
          await until(() => f.active() === 1);
          request.destroy();
          await rejected;
          await until(() => f.active() === 0);
          assert.ok(f.calls.at(-1).signal.aborted);
        }
        f.mode('wait');
        assert.equal((await f.request().result).status, 200);
      }, { deadline: 80 });
    });
    await t.test('noncooperative service successes after deadline never exchange or write', async () => {
      const service = Object.create(mini);
      let resolveQuery;
      let resolveAuth;
      let exchanges = 0;
      service.queryStatus = () => new Promise(resolve => { resolveQuery = resolve; });
      service.getAuthCode = () => { exchanges++; return new Promise(resolve => { resolveAuth = resolve; }); };
      await fixture(async f => {
        const query = f.request();
        await until(() => typeof resolveQuery === 'function');
        assert.equal((await query.result).status, 504);
        resolveQuery({ status: 'OK', ticket: 'synthetic' });
        await pause(10);
        assert.equal(exchanges, 0, 'late service query success must not start exchange');
        service.queryStatus = async () => ({ status: 'OK', ticket: 'synthetic' });
        const auth = f.request();
        await until(() => typeof resolveAuth === 'function');
        assert.equal((await auth.result).status, 504);
        const response = f.responses.at(-1);
        let lateWrites = 0;
        const originalJson = response.json;
        response.json = function (...args) { lateWrites++; return originalJson.apply(this, args); };
        resolveAuth('synthetic');
        await pause(10);
        assert.equal(lateWrites, 0, 'late service exchange success must not write');
        service.queryStatus = async () => ({ status: 'Wait' });
        assert.equal((await f.request().result).body.data.status, 'Wait');
      }, { deadline: 80, service });
    });
    await t.test('noncooperative late results never exchange or write; retained slots bound accumulation', async () => {
      await fixture(async f => {
        f.mode('late');
        const requests = Array.from({ length: 4 }, () => f.request());
        for (const request of requests) assert.equal((await request.result).status, 504);
        assert.equal(f.active(), 4);
        assert.equal((await f.request().result).status, 429);
        for (const item of [...f.pending]) item.finish();
        await until(() => f.active() === 0);
        await pause(10);
        assert.equal(f.calls.length, 4, 'late query cannot start exchange');
        f.mode('wait');
        assert.equal((await f.request().result).status, 200);
        f.mode('ok'); f.authMode('late');
        assert.equal((await f.request().result).status, 504);
        const response = f.responses.at(-1);
        let lateWrites = 0;
        const originalJson = response.json;
        response.json = function (...args) { lateWrites++; return originalJson.apply(this, args); };
        for (const item of [...f.pending]) item.finish();
        await until(() => f.active() === 0);
        await pause(10);
        assert.equal(lateWrites, 0);
      }, { deadline: 80 });
    });
  } finally {
    assert.deepEqual(fingerprints(), before, 'source/test bytes unchanged by fixtures');
    assert.equal(fs.existsSync(dataDir), false, 'no persistent fixture artifacts');
    if (previousDataDir === undefined) delete process.env.FARM_DATA_DIR;
    else process.env.FARM_DATA_DIR = previousDataDir;
  }
});
