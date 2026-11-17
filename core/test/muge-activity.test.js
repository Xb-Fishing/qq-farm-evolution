const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const tempRoot = fs.realpathSync(os.tmpdir());
const fixturePrefix = path.join(tempRoot, 'muge-route-');
assert.ok(fixturePrefix.startsWith(tempRoot + path.sep));
assert.ok(!tempRoot.startsWith(path.resolve(__dirname, '../..') + path.sep));
const privateDir = fs.mkdtempSync(fixturePrefix);
assert.ok(fs.realpathSync(privateDir).startsWith(fs.realpathSync(os.tmpdir()) + path.sep));
process.env.FARM_DATA_DIR = privateDir;
const sources = ['services/muge-activity.js', 'controllers/admin-muge-activity-routes.js', 'controllers/admin-activity-routes.js', 'services/activity.js', '../test/muge-activity.test.js', '../test/muge-panel.test.js'].map(p => path.resolve(__dirname, '../src', p));
const fingerprint = p => [fs.statSync(p).mode, crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')];
const before = sources.map(fingerprint);
test.after(() => {
  try { assert.deepEqual(sources.map(fingerprint), before); }
  finally { fs.rmSync(privateDir, { recursive: true, force: true }); }
});
const service = require('../src/services/muge-activity');
const { registerAdminMugeActivityRoutes } = require('../src/controllers/admin-muge-activity-routes');
const { createActivityReadCache } = require('../src/controllers/activity-read-cache');
const express = require('express');
function fixture(endTime = null) {
  return { id: 2026111700, parentId: 0, enabled: false, title: '牧歌初启', endTime, payload: {
    uid: 'MugeMainUI', tips: { txt: ['<b>活动简介</b>', '1. 本活动分为四大模块', '2. 兴牧庆典：饲养数量达到档位领取奖励', '3. 牧友同行：已开启牧场的好友数量达标领取', '4. 成长手册：农场25级开启牧场', '5. 牧场人格：首次分享可获奖励', '6. 结束后邮件补发'] }, secret: crypto.randomBytes(12).toString('hex'),
  }, children: [{ id: 2026111702, parentId: 2026111700, type: 28 }] };
}
test('pure DTO uses proven rule lines only, validates root and keeps personal state unknown', () => {
  const input = fixture();
  const dto = service.normalizeMuge(input);
  assert.equal(JSON.stringify(dto).includes(input.payload.secret), false);
  assert.equal(dto.available, true); assert.equal(dto.personal, null); assert.equal(dto.endTime, null);
  assert.equal(dto.sections.length, 4); assert.doesNotMatch(JSON.stringify(dto), /<b>|children|type/);
  assert.match(dto.sections[2].lines[0], /25级/);
  for (const mutate of [r => r.id++, r => r.parentId++, r => r.payload.uid = 'wrong', r => r.payload = null, r => r.payload.tips.txt = []]) {
    const root = fixture(); mutate(root); assert.equal(service.normalizeMuge(root).available, false);
  }
  const future = fixture(); future.startTime = 200; assert.equal(service.normalizeMuge(future, 100).phase, 'upcoming');
  assert.equal(service.normalizeMuge(fixture(99), 100).available, false);
  assert.throws(() => service.findRoot({}), /格式/);
});
// Real Express registration and middleware; transport is intercepted without opening a socket.
function harness(errorMapper) {
  const app = express();
  const counts = { list: 0, group: 0, running: 0 };
  const bodies = new Map();
  const provider = {
    getStatus: () => ({ connection: { connected: true } }),
    isAccountRunning: async () => { counts.running++; return true; },
    getActivityDiscoveryList: async id => { assert.match(id, /^synthetic-/); counts.list++; return [bodies.get(id) || fixture()]; },
    getActivityGroupSnapshot: async (id, root, uid) => { assert.match(id, /^synthetic-/); assert.equal(root, 2026111700); assert.equal(uid, ''); counts.group++; return bodies.get(id) || fixture(); },
  };
  app.use((req, res, next) => { if (!req.user) return res.status(401).json({ ok: false }); next(); });
  registerAdminMugeActivityRoutes({ app, provider, activityReader: createActivityReadCache(), getAccountIdFromRequest: req => req.headers['x-account-id'], canAccessAccount: req => req.user?.allowed === true, sendProviderError: errorMapper || ((res, error) => res.status(502).json({ ok: false, error: error.message })) });
  const handler = app._router;
  const read = (id = 'synthetic-a', user = { allowed: true }) => new Promise((resolve, reject) => {
    const req = { method: 'GET', url: '/api/activity/muge', headers: { 'x-account-id': id }, user };
    const res = { statusCode: 200, setHeader(key, value) { this.headers ||= {}; this.headers[key] = value; }, getHeader(key) { return this.headers?.[key]; }, end() {}, status(n) { this.statusCode = n; return this; }, json(body) { resolve({ status: this.statusCode, headers: this.headers || {}, ...body }); return this; } };
    handler.handle(req, res, reject);
  });
  return { provider, counts, bodies, read };
}
test('route auth, disconnected and stopped accounts read zero upstream', async () => {
  const h = harness(); assert.equal((await h.read('synthetic-a', null)).status, 401);
  assert.equal((await h.read('synthetic-a', { allowed: false })).status, 403);
  assert.equal((await h.read('')).status, 400);
  h.provider.getStatus = () => null; assert.equal((await h.read()).ok, false);
  h.provider.getStatus = () => ({ connection: { connected: true } }); h.provider.isAccountRunning = async () => false;
  assert.equal((await h.read()).status, 409); assert.equal(h.counts.list, 0); assert.equal(h.counts.group, 0);
});
test('route cache coalesces reads with bare account loader and isolates accounts', async () => {
  const h = harness(); const replies = await Promise.all([h.read(), h.read(), h.read()]);
  assert.ok(replies.every(r => r.ok && r.activity.available)); assert.equal(h.counts.list, 1); assert.equal(h.counts.group, 1);
  await h.read(); assert.equal(h.counts.list, 1); await h.read('synthetic-b'); assert.equal(h.counts.list, 2);
});
test('missing root skips Group; malformed/failed List is an error and bounded by failure cache', async () => {
  for (const response of [[], null, { wrong: true }]) {
    const h = harness(); h.provider.getActivityDiscoveryList = async () => response;
    const result = await h.read(); assert.equal(result.ok, Array.isArray(response)); assert.equal(h.counts.group, 0);
  }
  const h = harness(); let reads = 0; h.provider.getActivityDiscoveryList = async () => { reads++; throw new Error('ordinary-failure'); };
  assert.equal((await h.read()).error, 'ordinary-failure'); assert.equal((await h.read()).error, 'ordinary-failure'); assert.equal(reads, 1);
});
test('deadline survives failures and cache; expiry before and across every await stops reads', async () => {
  const realNow = Date.now; let now = 2000000000000; Date.now = () => now;
  try {
    const h = harness(); h.bodies.set('synthetic-a', fixture(now / 1000 + 120));
    assert.equal((await h.read()).activity.available, true);
    now += 61000; h.provider.getActivityDiscoveryList = async () => { throw new Error('network'); };
    assert.equal((await h.read()).error, 'network'); now += 60000;
    const previous = { ...h.counts }; assert.equal((await h.read()).activity.available, false); assert.deepEqual(h.counts, previous);
    for (const stage of ['running', 'list', 'group']) {
      const x = harness(); const end = now / 1000 + 1;
      x.bodies.set('synthetic-a', fixture(end));
      if (stage === 'running') {
        await x.read(); x.provider.isAccountRunning = async () => { now += 2000; return true; };
      }
      if (stage === 'list') x.provider.getActivityDiscoveryList = async () => { now += 2000; return [fixture(end)]; };
      if (stage === 'group') x.provider.getActivityGroupSnapshot = async () => { now += 2000; return fixture(end); };
      assert.equal((await x.read()).activity.available, false);
      if (stage === 'list') assert.equal(x.counts.group, 0);
    }
  } finally { Date.now = realNow; }
});

test('Group failures retain successful List deadline, retry only after 60s; unknown end stays readable', async () => {
  const realNow = Date.now; let now = 2000000000000; Date.now = () => now;
  try {
    const h = harness(); const end = now / 1000 + 130; let groupReads = 0;
    h.bodies.set('synthetic-a', fixture(end));
    h.provider.getActivityGroupSnapshot = async () => { groupReads++; throw new Error('Group failed'); };
    assert.equal((await h.read()).error, 'Group failed');
    await h.read(); assert.equal(groupReads, 1);
    now += 61000; await h.read(); assert.equal(groupReads, 2);
    now += 70000; assert.equal((await h.read()).activity.available, false); assert.equal(groupReads, 2);
    const unknown = harness(); await unknown.read(); now += 1000000;
    assert.equal((await unknown.read()).activity.available, true); assert.equal(unknown.counts.list, 2);
    assert.equal((await unknown.read('synthetic-b')).activity.available, true);
  } finally { Date.now = realNow; }
});

test('Group UID mismatch and missing payload are errors, not retirement', async () => {
  for (const payload of [null, { uid: 'wrong' }, { uid: 'MugeUI' }]) {
    const h = harness(); const root = fixture(); root.payload = payload;
    h.bodies.set('synthetic-a', root);
    const reply = await h.read(); assert.equal(reply.ok, false); assert.equal(reply.status, 502); assert.match(reply.error, /规则/); assert.equal(reply.activity, undefined);
  }
});

test('connection lookup failures are caught and disconnect across await does not read the next stage', async () => {
  const h = harness(); h.provider.getStatus = () => { throw new Error('status failed'); };
  assert.equal((await h.read()).error, 'status failed'); assert.equal(h.counts.list, 0);
  for (const stage of ['running', 'list']) {
    const x = harness(); let online = true;
    x.provider.getStatus = () => ({ connection: { connected: online } });
    if (stage === 'running') x.provider.isAccountRunning = async () => { online = false; return true; };
    else x.provider.getActivityDiscoveryList = async () => { online = false; return [fixture()]; };
    assert.equal((await x.read()).ok, false);
    assert.equal(x.counts.group, 0); assert.equal(x.counts.list, 0);
  }
});

test('successful Group deadline is remembered even when List deadline is unknown and Group already ended', async () => {
  const h = harness(); let reads = 0;
  h.provider.getActivityGroupSnapshot = async () => { reads++; return fixture(Math.floor(Date.now() / 1000) - 1); };
  assert.equal((await h.read()).activity.available, false);
  assert.equal((await h.read()).activity.available, false);
  assert.equal(reads, 1); assert.equal(h.counts.list, 1); assert.equal(h.counts.running, 1);
});


test('List newly known cutoff reaches Group error responses without changing error classification', async () => {
  const h = harness(); const end = Math.floor(Date.now() / 1000) + 60;
  h.bodies.set('synthetic-a', fixture(end));
  h.provider.getActivityGroupSnapshot = async () => { throw new Error('group read failed'); };
  const first = await h.read(); assert.equal(first.status, 502); assert.equal(first.error, 'group read failed');
  assert.equal(first.headers['x-activity-end-time'], String(end));
  const cached = await h.read(); assert.equal(cached.headers['x-activity-end-time'], String(end));
});

test('real shared error mapper keeps expected-200 and unexpected-500 while carrying cutoff', async () => {
  const { createAdminRouteHelpers } = require('../src/controllers/admin-route-helpers');
  for (const [message, status] of [['API Timeout', 200], ['ordinary failure', 500]]) {
    const h = harness(createAdminRouteHelpers({}).sendProviderError); const end = Math.floor(Date.now() / 1000) + 60;
    h.bodies.set('synthetic-a', fixture(end)); h.provider.getActivityGroupSnapshot = async () => { throw new Error(message); };
    const reply = await h.read(); assert.equal(reply.status, status); assert.equal(reply.ok, false); assert.equal(reply.error, message);
    assert.equal(reply.headers['x-activity-end-time'], String(end));
  }
});
