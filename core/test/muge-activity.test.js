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
// Exercise the authenticated controller without a listening socket.
function harness() {
  const app = express();
  let reads = 0;
  const provider = {
    getStatus: () => ({ connection: { connected: true } }),
    getGamePanelReadScope: () => 'synthetic-epoch',
    isAccountRunning: async () => true,
    getMugeActivity: async id => {
      assert.match(id, /^synthetic-/); reads++;
      return { ok: true, activity: service.normalizeMuge(fixture()) };
    },
    operateMuge: async () => ({ ok: true, rewards: [{ id: '80021', count: '1' }] }),
  };
  app.use((req, res, next) => { if (!req.user) return res.status(401).json({ ok: false }); next(); });
  registerAdminMugeActivityRoutes({ app, provider, activityReader: createActivityReadCache(),
    getAccountIdFromRequest: req => req.headers['x-account-id'], canAccessAccount: req => req.user?.allowed === true,
    sendProviderError: (res, error) => res.status(502).json({ ok: false, error: error.message }) });
  const request = ({ id = 'synthetic-a', user = { allowed: true }, body } = {}) => new Promise((resolve, reject) => {
    const method = body ? 'POST' : 'GET';
    const url = body ? '/api/activity/muge/operate' : '/api/activity/muge';
    const req = { method, url, headers: { 'x-account-id': id }, user, body };
    const res = { statusCode: 200, setHeader(key, value) { this.headers ||= {}; this.headers[key] = value; },
      getHeader(key) { return this.headers?.[key]; }, end() {}, status(n) { this.statusCode = n; return this; },
      json(value) { resolve({ status: this.statusCode, headers: this.headers || {}, ...value }); return this; } };
    app._router.handle(req, res, reject);
  });
  return { provider, request, reads: () => reads };
}

test('activity route guards GET and POST, coalesces by account and session, and clears old state after mutation', async () => {
  const h = harness();
  assert.equal((await h.request({ user: null })).status, 401);
  assert.equal((await h.request({ user: { allowed: false }, body: { action: 'claimCelebration' } })).status, 403);
  h.provider.getStatus = () => null;
  assert.equal((await h.request()).ok, false);
  assert.equal(h.reads(), 0);
  h.provider.getStatus = () => ({ connection: { connected: true } });
  const requests = await Promise.all([h.request(), h.request(), h.request()]);
  assert.ok(requests.every(result => result.ok && result.activity.available));
  assert.equal(h.reads(), 1);
  assert.equal((await h.request({ body: { action: 'claimCelebration' } })).rewards[0].id, '80021');
  await h.request();
  await h.request({ id: 'synthetic-b' });
  h.provider.getGamePanelReadScope = () => 'next-epoch';
  await h.request();
  assert.equal(h.reads(), 4);
});

test('a confirmed cutoff survives later failures and prevents writes after expiry', async t => {
  const at = Date.now();
  let now = at;
  t.mock.method(Date, 'now', () => now);
  const h = harness();
  const end = Math.floor(at / 1000) + 100;
  h.provider.getMugeActivity = async () => ({ ok: true, activity: service.normalizeMuge(fixture(end)) });
  assert.equal((await h.request()).activity.endTime, end);
  now = at + 65000;
  h.provider.getMugeActivity = async () => { throw new Error('network'); };
  const failed = await h.request();
  assert.equal(failed.error, 'network');
  assert.equal(failed.headers['x-activity-end-time'], String(end));
  now = at + 105000;
  h.provider.operateMuge = async () => assert.fail('expired operation reached worker');
  assert.equal((await h.request()).activity.available, false);
  assert.equal((await h.request({ body: { action: 'claimFriends' } })).code, 'MUGE_UNAVAILABLE');
});

const codec = require('../src/services/muge-codec');
const { createMugeGameplay } = require('../src/services/muge-gameplay');
function gameFixture() {
  const at = 1800000000;
  const head = (id, parent_id) => ({ id, parent_id, title: '牧歌初启', start_time: at - 60, end_time: at + 3600, status: 1 });
  const reward = { id: '80021', count: '1' };
  const tier = { id: '1', threshold: '5', status: 2, rewards: [reward] };
  const group = { head: { ...head('2026111700', '0'), payload: JSON.stringify(fixture().payload) },
    children: [{ head: head('2026111702', '2026111700'), celebration: { total: '9007199254740993', tiers: [tier] } },
      { head: head('2026111703', '2026111700'), friends: { counted: [{ gid: '60001' }], tiers: [] } },
      { head: head('2026111704', '2026111700'), handbook: { tiers: [], points: '9', tasks: [
        { id: '5', progress: '1', target: '2', status: 1, description: '抚摸好友的小鸭子', unlock_day: '0', rewards: [reward] },
      ] } },
      { head: head('2026111705', '2026111700'), survey: { answers: {}, personality_id: '0', settle_count: '0' } }],
  };
  const file = () => path.join(privateDir, crypto.randomUUID() + '.json');
  const ledger = file();
  const logs = [];
  const calls = [];
  const ws = {};
  const network = {
    getWs: () => ws, isConnected: () => true,
    async sendMsgAsync(service, method, wire) {
      assert.equal(service, 'gamepb.activitypb.ActivityService');
      calls.push(method);
      if (method === 'List') {
        assert.equal(codec.decode('ListRequest', wire).game_scene_id, 1);
        return { body: codec.encode('ListReply', { groups: [group] }) };
      }
      const operation = codec.decode('Operation', wire);
      if (f.reject) throw f.reject;
      const child = group.children.find(node => node.head.id === operation.id);
      if (operation.cmd === '85') {
        assert.equal(operation.celebration.target, '0');
        tier.status = 3;
        return { body: codec.encode('Receipt', { id: operation.id, cmd: operation.cmd, state: child,
          celebration: { claimed_ids: ['1'], awards: [reward] } }) };
      }
      if (operation.cmd === '86') {
        const save = operation.save;
        child.survey.answers = save.clear ? {} : Object.fromEntries(Object.entries(save.answers).map(([id, value]) => [codec.decimalKey(id), value]));
        return { body: codec.encode('Receipt', { id: operation.id, cmd: operation.cmd, state: child, save: {} }) };
      }
      if (operation.cmd === '87') {
        child.survey.settle_count = String(Number(child.survey.settle_count) + 1);
        child.survey.personality_id = '2';
        return { body: codec.encode('Receipt', { id: operation.id, cmd: operation.cmd, state: child, settle: { personality_id: '2' } }) };
      }
      assert.fail('unexpected operation');
    },
  };
  const make = () => createMugeGameplay({ network, file: () => ledger, now: () => at, log: (...args) => logs.push(args) });
  const f = { game: make(), make, calls, logs, group, tier };
  return f;
}

test('real Muge service reads confirmed fields, redacts counted friends, and auto claims one eligible reward', async () => {
  const f = gameFixture();
  const board = await f.game.read();
  assert.equal(board.personal.celebration.total, '9007199254740993');
  assert.equal(board.personal.friends.count, 1);
  assert.doesNotMatch(JSON.stringify(board.personal.friends), /60001/);
  assert.match(board.personal.handbook.tasks[0].description, /小鸭子/);
  await f.game.automate();
  assert.equal(f.calls.filter(call => call === 'Operate').length, 0);
  await f.game.operate('setAutomation', { enabled: true });
  await f.game.automate();
  assert.equal(f.calls.filter(call => call === 'Operate').length, 1);
  const result = await f.game.read();
  assert.equal(result.personal.celebration.tiers[0].status, 3);
  assert.equal(f.logs[0][2][0].name, '无机罐头（1小时）');
  await assert.rejects(f.game.operate('claimCelebration'), { code: 'MUGE_NOT_CLAIMABLE' });
});

test('unknown Muge reward blocks same claim across replacement until fresh status shows it claimed', async () => {
  const f = gameFixture();
  f.reject = new Error('synthetic timeout');
  await assert.rejects(f.game.operate('claimCelebration'), { code: 'MUGE_RESULT_UNKNOWN' });
  f.reject = null;
  await assert.rejects(f.make().operate('claimCelebration'), { code: 'MUGE_RESULT_UNKNOWN' });
  assert.equal(f.calls.filter(call => call === 'Operate').length, 1);
  f.tier.status = 3;
  assert.deepEqual((await f.make().read()).pendingActions, []);
  assert.equal(f.logs.length, 0);
});

test('personality answers validate and settle against returned detail before restoring the page', async () => {
  const f = gameFixture();
  await assert.rejects(f.game.operate('finishSurvey', { answers: { 1: 5 } }), { code: 'MUGE_INVALID_ARGUMENT' });
  const board = await f.game.read();
  const answers = Object.fromEntries(board.questions.map(q => [q.id, q.options[0].value]));
  const done = await f.game.operate('finishSurvey', { answers });
  assert.equal(done.activity.personal.personality.personalityId, 2);
  assert.equal(done.activity.personal.personality.settleCount, '1');
  assert.deepEqual(done.activity.personal.personality.answers, answers);
  const reset = await f.game.operate('resetSurvey');
  assert.deepEqual(reset.activity.personal.personality.answers, {});
});
