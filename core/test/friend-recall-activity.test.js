const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const tempRoot = fs.realpathSync(os.tmpdir());
const fixturePrefix = path.join(tempRoot, 'friend-recall-route-');
assert.ok(fixturePrefix.startsWith(tempRoot + path.sep));
assert.ok(!tempRoot.startsWith(path.resolve(__dirname, '../..') + path.sep));
const privateDir = fs.mkdtempSync(fixturePrefix);
assert.ok(fs.realpathSync(privateDir).startsWith(fs.realpathSync(os.tmpdir()) + path.sep));
process.env.FARM_DATA_DIR = privateDir;
const sources = ['services/friend-recall-activity.js', 'controllers/admin-friend-recall-activity-routes.js', 'controllers/admin-activity-routes.js', 'services/activity.js', '../test/friend-recall-activity.test.js', '../test/friend-recall-panel.test.js'].map(p => path.resolve(__dirname, '../src', p));
const fingerprint = p => [fs.statSync(p).mode, crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')];
const before = sources.map(fingerprint);
test.after(() => {
  try { assert.deepEqual(sources.map(fingerprint), before); }
  finally { fs.rmSync(privateDir, { recursive: true, force: true }); }
});
const service = require('../src/services/friend-recall-activity');
const { registerAdminFriendRecallActivityRoutes } = require('../src/controllers/admin-friend-recall-activity-routes');
const { createActivityReadCache } = require('../src/controllers/activity-read-cache');
const express = require('express');
function fixture(endTime = null) {
  return { id: 2026111800, parentId: 0, enabled: false, title: '故友重逢', endTime, children: [{ id: 2026111801, parentId: 2026111800, type: 11, payload: {
    uid: 'FriendRecallUI', tips: { txt: ['<b>召回前10人</b>', '30天冷却', '互动上限10次', '邮件补发'] }, buffTips: { txt: ['回归礼包', '互动上限15次'] }, recalledTips: { title: '召回记录', desc: '前10位好友' }, buffList: [{ name: '经验提升', desc: '<b>额外经验</b>', id: 'secret', icon_path: 'secret' }], accountName: 'secret',
  } }] };
}
test('pure DTO validates identity, payload and unknown numeric state; enabled=false remains available', () => {
  const dto = service.normalizeFriendRecall(fixture());
  assert.equal(dto.available, true); assert.equal(dto.personal, null); assert.equal(dto.endTime, null);
  assert.equal(dto.sections.length, 5); assert.doesNotMatch(JSON.stringify(dto), /secret|<b>|icon_path|accountName/);
  for (const mutate of [r => r.id++, r => r.parentId++, r => r.children[0].id++, r => r.children[0].parentId++, r => r.children[0].type++, r => r.children[0].payload.uid = 'wrong', r => r.children[0].payload = null, r => r.children[0].payload.tips.txt = []]) {
    const root = fixture(); mutate(root); assert.equal(service.normalizeFriendRecall(root).available, false);
  }
  assert.equal(service.normalizeFriendRecall(null).available, false);
  assert.throws(() => service.findRoot({}), /格式/);
  assert.equal(service.findRoot([]), null);
  for (const value of [null, undefined, '', false, {}, -1, 0]) assert.equal(service.timestamp(value), null);
});
// Real Express registration and middleware; transport is intercepted without opening a socket.
function harness() {
  const app = express();
  const counts = { list: 0, group: 0, running: 0 };
  const bodies = new Map();
  const provider = {
    getStatus: () => ({ connection: { connected: true } }),
    isAccountRunning: async () => { counts.running++; return true; },
    getActivityDiscoveryList: async id => { assert.match(id, /^synthetic-/); counts.list++; return [bodies.get(id) || fixture()]; },
    getActivityGroupSnapshot: async (id, root, uid) => { assert.match(id, /^synthetic-/); assert.equal(root, 2026111800); assert.equal(uid, ''); counts.group++; return bodies.get(id) || fixture(); },
  };
  app.use((req, res, next) => { if (!req.user) return res.status(401).json({ ok: false }); next(); });
  registerAdminFriendRecallActivityRoutes({ app, provider, activityReader: createActivityReadCache(), getAccountIdFromRequest: req => req.headers['x-account-id'], canAccessAccount: req => req.user?.allowed === true, sendProviderError: (res, error) => res.status(502).json({ ok: false, error: error.message }) });
  const handler = app._router;
  const read = (id = 'synthetic-a', user = { allowed: true }) => new Promise((resolve, reject) => {
    const req = { method: 'GET', url: '/api/activity/friend-recall', headers: { 'x-account-id': id }, user };
    const res = { statusCode: 200, setHeader() {}, getHeader() {}, end() {}, status(n) { this.statusCode = n; return this; }, json(body) { resolve({ status: this.statusCode, ...body }); return this; } };
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
  for (const payload of [null, { uid: 'wrong' }, { uid: 'FriendRecallUI' }]) {
    const h = harness(); const root = fixture(); root.children[0].payload = payload;
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

test('child cutoff is effective and retained, while the three rule groups do not duplicate full rule sheets', async () => {
  const root = fixture(); root.startTime = 100; root.children[0].startTime = 200;
  root.endTime = 400; root.children[0].endTime = 300;
  const dto = service.normalizeFriendRecall(root, 250);
  assert.equal(dto.startTime, 200); assert.equal(dto.endTime, 300);
  assert.equal(service.normalizeFriendRecall(root, 300).available, false);
  assert.ok(dto.sections.find(row => row.key === 'recall').lines.every(line => !/互动|邮件/.test(line)));
  assert.ok(dto.sections.find(row => row.key === 'return').lines.every(line => !/互动|邮件/.test(line)));
  const h = harness(); const now = Math.floor(Date.now() / 1000);
  const liveRoot = fixture(now + 60); liveRoot.children[0].endTime = now - 1;
  h.bodies.set('synthetic-a', liveRoot);
  assert.equal((await h.read()).activity.endTime, now - 1);
  const count = { ...h.counts }; await h.read(); assert.deepEqual(h.counts, count);
});

test('successful Group deadline is remembered even when List deadline is unknown and Group already ended', async () => {
  const h = harness(); let reads = 0;
  h.provider.getActivityGroupSnapshot = async () => { reads++; return fixture(Math.floor(Date.now() / 1000) - 1); };
  assert.equal((await h.read()).activity.available, false);
  assert.equal((await h.read()).activity.available, false);
  assert.equal(reads, 1); assert.equal(h.counts.list, 1); assert.equal(h.counts.running, 1);
});

test('production flat List child cutoff prevents Group even when Group omits its cutoff', async () => {
  const now = Math.floor(Date.now() / 1000);
  const h = harness();
  const root = { ...fixture(now + 3600), children: undefined };
  const child = { ...fixture().children[0], endTime: now - 1 };
  h.provider.getActivityDiscoveryList = async () => [root, child];
  h.provider.getActivityGroupSnapshot = async () => { h.counts.group++; return fixture(now + 3600); };
  const reply = await h.read();
  assert.equal(reply.activity.available, false);
  assert.equal(reply.activity.endTime, child.endTime);
  assert.equal(h.counts.group, 0);
  for (const change of [row => row.id++, row => row.parentId++, row => row.type++, row => row.payload = { uid: 'wrong' }]) {
    const x = harness(); const invalid = { ...child }; change(invalid);
    x.provider.getActivityDiscoveryList = async () => [root, invalid];
    assert.equal((await x.read()).activity.available, true);
    assert.equal(x.counts.group, 1, 'wrong identity cannot authorize premature retirement');
  }
});

test('production flat List child cutoff survives a failed Group and cache expiry', async () => {
  const realNow = Date.now; let now = 2000000000000; Date.now = () => now;
  try {
    const h = harness(); const child = { ...fixture().children[0], endTime: now / 1000 + 30 };
    h.provider.getActivityDiscoveryList = async () => { h.counts.list++; return [{ ...fixture(), children: undefined }, child]; };
    h.provider.getActivityGroupSnapshot = async () => { h.counts.group++; throw new Error('Group failed'); };
    assert.equal((await h.read()).error, 'Group failed');
    const before = { ...h.counts }; now += 61000;
    const next = await h.read();
    assert.equal(next.activity?.available, false);
    assert.equal(next.activity.endTime, child.endTime);
    assert.deepEqual(h.counts, before, 'known child expiry means zero new running/List/Group reads');
  } finally { Date.now = realNow; }
});
