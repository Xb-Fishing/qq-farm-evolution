'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const ordinaryFailure = {
  ok: false, code: 'RANCH_READ_FAILED', error: '牧场背包失败，请稍后重试',
  failureStage: 'bag', failureKind: 'request', sceneRecoveryRequired: false,
};
const success = { ok: true, data: { unlocked: true } };

function registerFixture(t, load) {
  const base = fs.realpathSync(os.tmpdir());
  const prefix = path.join(base, 'farm-ranch-read-cache-');
  assert.equal(path.dirname(prefix), base);
  const root = fs.mkdtempSync(prefix);
  const overrides = {
    FARM_DATA_DIR: root,
    FARM_LOG_DIR: path.join(root, 'logs'),
    FARM_PRIVATE_CONFIG_FILE: path.join(root, 'private-config.json'),
  };
  const saved = Object.fromEntries(Object.keys(overrides).map(key => [key, process.env[key]]));
  t.after(() => {
    try {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    } finally {
      assert.equal(fs.realpathSync(root), root);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  assert.equal(fs.realpathSync(root), root);
  assert.equal(path.dirname(root), base);
  for (const target of [overrides.FARM_LOG_DIR, overrides.FARM_PRIVATE_CONFIG_FILE]) {
    assert.equal(path.dirname(target), root);
    assert.equal(fs.existsSync(target), false);
  }
  Object.assign(process.env, overrides);

  const { createActivityReadCache } = require('../src/controllers/activity-read-cache');
  const { createAdminRouteHelpers } = require('../src/controllers/admin-route-helpers');
  const { registerAdminRanchRoutes } = require('../src/controllers/admin-ranch-routes');
  const routes = new Map();
  const reads = [];
  const actions = [];
  let time = 1000;
  const status = { authorized: true, connected: true, running: true };
  registerAdminRanchRoutes({
    app: {
      get: (route, handler) => routes.set('GET ' + route, handler),
      post: (route, handler) => routes.set('POST ' + route, handler),
    },
    getAccountIdFromRequest: req => req.accountId,
    canAccessAccount: (_req, id) => status.authorized && ['fixture-a', 'fixture-b'].includes(id),
    provider: {
      getStatus: () => ({ connection: { connected: status.connected } }),
      isAccountRunning: () => status.running,
      getRanchState: (...args) => {
        reads.push(args);
        return load(...args);
      },
      operateRanch: (id, quoteId) => {
        actions.push([id, quoteId]);
        return success;
      },
    },
    activityReader: createActivityReadCache({ now: () => time }),
    sendProviderError: createAdminRouteHelpers({}).sendProviderError,
  });
  async function call(route, req) {
    const response = { status: 200 };
    const res = {
      status(code) { response.status = code; return this; },
      json(body) { response.body = body; return this; },
    };
    await routes.get(route)(req, res);
    return response;
  }
  return {
    reads, actions, status,
    advance: ms => { time += ms; },
    state: (accountId = 'fixture-a', query) => call('GET /api/ranch/state', { accountId, query }),
    operate: (accountId, quoteId) => call('POST /api/ranch/operate', { accountId, body: { quoteId } }),
  };
}

function expectFailure(response, cached, failure = ordinaryFailure, status = 502) {
  assert.deepEqual(response, { status, body: { ...failure, upstreamCached: cached } });
}

test('three ordinary failures share one read until the 60-second TTL permits recovery', async t => {
  let upstream = ordinaryFailure;
  const f = registerFixture(t, () => upstream);
  const first = await f.state();
  const second = await f.state();
  f.advance(59_999);
  const third = await f.state();
  assert.deepEqual(f.reads, [['fixture-a', 'animals', '5']]);
  expectFailure(first, false);
  expectFailure(second, true);
  expectFailure(third, true);
  assert.deepEqual(f.actions, []);

  f.advance(1);
  upstream = success;
  assert.deepEqual(await f.state(), { status: 200, body: { ...success, upstreamCached: false } });
  assert.deepEqual(await f.state(), { status: 200, body: { ...success, upstreamCached: true } });
  assert.equal(f.reads.length, 2);
});

test('concurrent ordinary failures coalesce and later reads reuse the settled result', async t => {
  const failure = { ok: false, code: 'RANCH_OFFLINE', error: '账号尚未连接' };
  let release;
  const deferred = new Promise(resolve => { release = resolve; });
  const f = registerFixture(t, () => deferred);
  const requests = [f.state(), f.state(), f.state()];
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.reads.length, 1);
  } finally {
    release(failure);
    await Promise.all(requests);
  }
  const [first, second, third] = await Promise.all(requests);
  expectFailure(first, false, failure, 409);
  expectFailure(second, true, failure, 409);
  expectFailure(third, true, failure, 409);
  expectFailure(await f.state(), true, failure, 409);
  assert.equal(f.reads.length, 1);
  assert.deepEqual(f.actions, []);
});

test('thrown provider errors retain their negative-cache TTL and response', async t => {
  let throwError = true;
  const f = registerFixture(t, () => {
    if (throwError) throw new Error('synthetic provider error');
    return success;
  });
  const expected = { status: 500, body: { ok: false, error: 'synthetic provider error' } };
  assert.deepEqual(await f.state(), expected);
  assert.deepEqual(await f.state(), expected);
  assert.equal(f.reads.length, 1);
  throwError = false;
  f.advance(60_000);
  assert.deepEqual(await f.state(), { status: 200, body: { ...success, upstreamCached: false } });
  assert.equal(f.reads.length, 2);
});

test('state checks account, authorization, connection, running state and query before using cached reads', async t => {
  const f = registerFixture(t, () => ordinaryFailure);
  assert.equal((await f.state('')).status, 400);
  for (const query of [{ view: 'unknown' }, { shopId: '7' }, { shopId: ['5', '6'] }]) {
    assert.equal((await f.state('fixture-a', query)).status, 400);
  }
  assert.deepEqual(f.reads, []);
  expectFailure(await f.state(), false);

  f.status.authorized = false;
  assert.equal((await f.state()).status, 403);
  f.status.authorized = true;
  f.status.connected = false;
  assert.deepEqual(await f.state(), { status: 200, body: { ok: false, error: '账号未连接，暂时无法读取牧场' } });
  f.status.connected = true;
  f.status.running = false;
  assert.equal((await f.state()).status, 409);
  f.status.running = true;
  expectFailure(await f.state(), true);
  assert.deepEqual(f.reads, [['fixture-a', 'animals', '5']]);
  assert.deepEqual(f.actions, []);
});

test('account, view and shop isolate failures and actions invalidate only the selected account', async t => {
  const f = registerFixture(t, (id, view, shop) => ({ ...ordinaryFailure, error: [id, view, shop].join('/') }));
  const keys = [
    ['fixture-a', 'animals', '5'],
    ['fixture-a', 'shop', '5'],
    ['fixture-a', 'shop', '6'],
    ['fixture-b', 'animals', '5'],
  ];
  async function check(key, cached) {
    const [id, view, shopId] = key;
    expectFailure(await f.state(id, { view, shopId }), cached, { ...ordinaryFailure, error: key.join('/') });
  }
  for (const key of keys) {
    await check(key, false);
    await check(key, true);
  }
  assert.deepEqual(f.reads, keys);

  const quote = '00000000-0000-0000-0000-000000000001';
  assert.deepEqual(await f.operate('fixture-a', quote), { status: 200, body: success });
  for (const key of keys) await check(key, key[0] === 'fixture-b');
  assert.deepEqual(f.reads, [...keys, ...keys.slice(0, 3)]);
  assert.deepEqual(f.actions, [['fixture-a', quote]]);
});

test('both scene recovery response shapes clear the current key immediately', async t => {
  const recovering = { ok: true, data: { sceneRecoveryRequired: true } };
  const failed = { ...ordinaryFailure, sceneRecoveryRequired: true };
  const f = registerFixture(t, () => [recovering, failed, success][f.reads.length - 1]);
  assert.deepEqual(await f.state(), { status: 200, body: { ...recovering, upstreamCached: false } });
  expectFailure(await f.state(), false, failed);
  assert.deepEqual(await f.state(), { status: 200, body: { ...success, upstreamCached: false } });
  assert.deepEqual(await f.state(), { status: 200, body: { ...success, upstreamCached: true } });
  assert.equal(f.reads.length, 3);
});
