const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const prefix = path.resolve(fs.realpathSync(os.tmpdir()), 'farm-update-evidence-');
assert.equal(path.dirname(prefix), fs.realpathSync(os.tmpdir()));
const root = fs.mkdtempSync(prefix); process.env.FARM_DATA_DIR = root;
const protectedFiles = ['services/game-update-evidence.js','services/activity-update-monitor.js','core/worker.js','runtime/data-provider.js'].map(f => path.resolve(__dirname, '../src', f));
const fingerprint = () => protectedFiles.map(f => [crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex'), fs.statSync(f).mode]);
const initial = fingerprint();
test.after(() => { assert.deepEqual(fingerprint(), initial); fs.rmSync(root, { recursive: true, force: true }); });
const defer = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function dataDir() { const dir = path.resolve(root, crypto.randomUUID()); assert.ok(dir.startsWith(root + path.sep)); fs.mkdirSync(dir, { mode: 0o700 }); return dir; }
function load(file, mocks, extra = {}) {
  const req = createRequire(file); const module = { exports: {} };
  const context = { module, exports: module.exports, require: name => Object.hasOwn(mocks, name) ? mocks[name] : req(name),
    Buffer, structuredClone, process: { env: { FARM_ACCOUNT_ID: 'synthetic-update' } }, console, ...extra };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), context, { filename: file }); return { service: module.exports, context };
}
function evidenceHarness() {
  const dir = dataDir(); const calls = []; let now = 1800000000000; let connected = true; let conn = {};
  const rows = {
    announcements: { fetchedAt: now, announcements: [{ id: '71001', title: '合成公告', content: '合成正文', detailLoaded: true }] },
    emails: { fetchedAt: now, boxes: { 1: { ok: true, fetchedAt: now, total: 1, claimable: 1, idHashes: ['a'.repeat(64)] }, 2: { ok: true, fetchedAt: now, total: 0, claimable: 0, idHashes: [] } } },
    solarCalendar: { events: [], seasons: [] }, tasks: { task_info: { daily_tasks: [], growth_tasks: [{ id: 9101, is_unlocked: true, total_progress: 1, progress: 1 }] } },
    illustrated: { items: [] }, mall: [],
  };
  const net = { isConnected: () => connected, getWs: () => conn };
  const file = path.resolve(__dirname, '../src/services/game-update-evidence.js');
  const h = load(file, { '../utils/network': net, '../config/runtime-paths': { getDataDir: () => dir } });
  const deps = { now: () => now, ...net, getConnection: net.getWs };
  for (const name of Object.keys(rows)) deps[name] = async () => { calls.push(name); return rows[name]; };
  return { ...h, dir, calls, rows, deps, read: () => h.service.collectGameUpdateEvidence({ deps }), advance: n => { now += n; },
    disconnect: () => { connected = false; }, replace: () => { conn = {}; } };
}
test('bounded collector coalesces six known readers, persists only sanitized facts with private modes and uses source timestamps', async () => {
  const h = evidenceHarness(); const [a, b] = await Promise.all([h.read(), h.read()]);
  assert.equal(h.calls.length, 6); assert.equal(a.factsComplete, true); assert.equal(b.sources.tasks.growth, 1);
  assert.equal(a.status, 'partial_coverage'); assert.equal(a.gaps.length, 3); assert.doesNotMatch(JSON.stringify(a), /合成公告|合成正文/);
  const file = path.join(h.dir, 'game-update-evidence', fs.readdirSync(path.join(h.dir, 'game-update-evidence'))[0]);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  await h.read(); assert.equal(h.calls.length, 6); h.disconnect(); await assert.rejects(h.read()); assert.equal(h.calls.length, 6);
});
test('ordinary failure is not empty success; volatile progress does not change facts and a new mail/catalog does', async () => {
  const h = evidenceHarness(); const first = await h.read(); h.advance(60001); h.rows.tasks.task_info.growth_tasks[0].progress = 0;
  const second = await h.read(); assert.equal(first.semanticHash, second.semanticHash);
  h.advance(60001); h.rows.emails.boxes[1].idHashes.push('b'.repeat(64)); const third = await h.read(); assert.notEqual(second.semanticHash, third.semanticHash);
  h.advance(60001); h.deps.tasks = async () => { throw new Error('private-input-must-not-persist'); };
  const partial = await h.read(); assert.equal(partial.sources.tasks.status, 'error'); assert.equal(partial.factsComplete, false);
  assert.doesNotMatch(JSON.stringify(partial), /private-input/);
});
test('connection replacement stops remaining entries and prevents persistence or cache reuse of late results', async () => {
  const h = evidenceHarness(); const gate = defer(); h.deps.announcements = async () => { h.calls.push('announcements'); await gate.promise; return h.rows.announcements; };
  const read = h.read(); h.replace(); gate.resolve(); await assert.rejects(read);
  assert.equal(h.calls.length, 1); assert.equal(fs.existsSync(path.join(h.dir, 'game-update-evidence')), false);
});
test('default collector uses actual module exports and declared existing strict readers instead of swallowed-error wrappers', async () => {
  const dir = dataDir(); const file = path.resolve(__dirname, '../src/services/game-update-evidence.js'); const calls = []; const conn = {};
  const codec = { create: x => x, encode: () => ({ finish: () => Buffer.from([0]) }), decode: () => ({ items: [], goods_list: [] }) };
  const types = Object.fromEntries(['GetIllustratedListV2Request','GetIllustratedListV2Reply','GetMallListBySlotTypeRequest','GetMallListBySlotTypeResponse','MallGoods'].map(name => [name, codec]));
  const h = load(file, {
    '../config/runtime-paths': { getDataDir: () => dir }, '../utils/proto': { types },
    '../utils/network': { isConnected: () => true, getWs: () => conn, sendMsgAsync: async (service, method) => { calls.push(method); return { body: Buffer.alloc(0) }; } },
    './official-announcements': { getOfficialAnnouncements: async () => ({ fetchedAt: Date.now(), announcements: [] }) },
    './email': { getEmailSnapshot: async () => ({ fetchedAt: Date.now(), boxes: { 1: { ok: true, idHashes: [] }, 2: { ok: true, idHashes: [] } } }) },
    './solar-calendar': { getSolarCalendar: async () => ({ events: [], seasons: [] }) }, './task': { getTaskInfo: async () => ({ task_info: {} }) },
  });
  const value = await h.service.collectGameUpdateEvidence(); assert.equal(value.factsComplete, true);
  assert.deepEqual(calls, ['GetIllustratedListV2', 'GetMallListBySlotType']);
});
function monitorHarness() {
  const dir = dataDir(); const callbacks = []; let now = 1800000000000; let reads = 0;
  class Clock extends Date { static now() { return now; } }
  const file = path.resolve(__dirname, '../src/services/activity-update-monitor.js');
  const h = load(file, { '../config/runtime-paths': { getDataFile: name => path.join(dir, name) } }, {
    Date: Clock, setTimeout: (fn, delay) => { const handle = { fn, delay, cancelled: false, unref() {} }; callbacks.push(handle); return handle; }, clearTimeout: handle => { handle.cancelled = true; },
  });
  const online = { available: true, activities: [{ id: 91001, endTime: (now + 10000) / 1000 }], groups: [], unknownActivityIds: [], gameUpdateEvidence: { factsComplete: true, semanticHash: 'a'.repeat(64) } };
  h.service.startActivityUpdateMonitor({ knownActivityIds: [91001], onlineScanner: async () => { reads++; return online; } });
  return { ...h, dir, callbacks, online, now: () => now, setNow: value => { now = value; }, reads: () => reads };
}
test('expiry wakes at the exact boundary; premature, replaced and stopped callbacks cause no probes', async () => {
  const h = monitorHarness(); await h.service.runActivityUpdateScan(); const early = h.callbacks.at(-1);
  h.setNow(h.now() + 2000); await early.fn(); assert.equal(h.reads(), 1); assert.equal(h.callbacks.at(-1).delay, 8000);
  const stale = h.callbacks.at(-1); h.online.activities[0].endTime += 10; h.service.armEndTimeReview({ online: h.online });
  await stale.fn(); assert.equal(h.reads(), 1);
  const due = h.callbacks.at(-1); h.setNow(h.online.activities[0].endTime * 1000); await due.fn(); assert.equal(h.reads(), 2);
  assert.deepEqual(Array.from(h.service.getActivityUpdateState().report.endedActivityIds), [91001]);
  h.service.stopActivityUpdateMonitor(); assert.equal(h.service.getActivityUpdateState().nextEndTimeReviewAt, 0);
});
test('stable game changes persist unreviewed across ordinary scans, failures and reload; long deadline is bounded', async () => {
  const h = monitorHarness(); await h.service.runActivityUpdateScan();
  h.online.gameUpdateEvidence.semanticHash = 'b'.repeat(64); await h.service.runActivityUpdateScan();
  let value = h.service.readSavedDigest(); assert.equal(value.unreviewed.filter(row => row.kind === 'game_facts').length, 2);
  h.online.available = false; await h.service.runActivityUpdateScan(); value = h.service.readSavedDigest(); assert.equal(value.unreviewed.length, 2);
  assert.equal(fs.statSync(path.join(h.dir, 'activity-update-digest.json')).mode & 0o777, 0o600);
  h.online.available = true; h.online.activities[0].endTime = (h.now() + 2 ** 32) / 1000;
  h.service.armEndTimeReview({ online: h.online }); assert.equal(h.callbacks.at(-1).delay, 2 ** 31 - 1);
  h.service.stopActivityUpdateMonitor();
});
test('authorized routes and real provider/Worker switch keep snapshots read-only, gate disconnected accounts and pass sufficient IPC timeout', async () => {
  const handlers = new Map(); const calls = []; let allowed = true; let connected = true;
  const provider = { getStatus: () => ({ connection: { connected } }), getEmailSnapshot: async id => { calls.push(id); return { boxes: {} }; }, getGameUpdateEvidence: async () => ({ sources: {} }) };
  require('../src/controllers/admin-game-update-routes').registerAdminGameUpdateRoutes({ app: { get: (p, f) => handlers.set(p, f) }, provider,
    getAccountIdFromRequest: req => req.account, canAccessAccount: () => allowed, sendProviderError: (_res, e) => { throw e; } });
  const res = { code: 200, status(code) { this.code = code; return this; }, json(value) { this.value = value; return this; } };
  allowed = false; await handlers.get('/api/activity/emails')({ account: 'fixture' }, res); assert.equal(res.code, 403); assert.equal(calls.length, 0);
  allowed = true; connected = false; await handlers.get('/api/activity/emails')({ account: 'fixture' }, res); assert.equal(calls.length, 0);
  connected = true; await handlers.get('/api/activity/emails')({ account: 'fixture' }, res); assert.equal(calls.length, 1);
  const { createDataProvider } = require('../src/runtime/data-provider'); const ipc = [];
  const adapter = createDataProvider({ getAccounts: () => ({ accounts: [{ id: 'fixture' }] }), callWorkerApi: (...args) => { ipc.push(args); return {}; } });
  adapter.getGameUpdateEvidence('fixture'); adapter.getEmailSnapshot('fixture');
  assert.equal(ipc[0].at(-1)._timeoutMs, 120000); assert.equal(ipc[1].at(-1)._timeoutMs, 30000);
  const worker = fs.readFileSync(path.resolve(__dirname, '../src/core/worker.js'), 'utf8'); const start = worker.indexOf('async function handleApiCall(msg)'); const end = worker.indexOf('// ==================== 每日礼包总览', start);
  const replies = []; const context = vm.createContext({ FRIEND_PANEL_ENTRY_METHODS: new Set(), BAG_PANEL_ENTRY_METHODS: new Set(), isRunning: true, loginReady: true, getWs: () => ({ readyState: 1 }),
    require: name => name === '../services/email' ? { getEmailSnapshot: async () => ({ source: 'fixture-mail' }) } : { collectGameUpdateEvidence: async () => ({ source: 'fixture-update' }) },
    sendToMaster: value => replies.push(value), collectPetDiaryErrorMeta: () => null });
  const handle = vm.runInContext(`${worker.slice(start, end)  }\n;handleApiCall`, context);
  await handle({ id: 'one', method: 'getEmailSnapshot', args: [] }); assert.equal(replies.at(-1).result.source, 'fixture-mail');
  await handle({ id: 'two', method: 'getGameUpdateEvidence', args: [] }); assert.equal(replies.at(-1).result.source, 'fixture-update');
  context.loginReady = false; await handle({ id: 'three', method: 'getEmailSnapshot', args: [] }); assert.ok(replies.at(-1).error);
});

test('actual business gate drains a pending evidence read without adding a persistent state domain', async () => {
  const business = require('../src/services/business-state');
  const { createBusinessGate } = require('../src/runtime/business-gate');
  const gate = createBusinessGate('synthetic-evidence-epoch'); gate.activate(); business.setBusinessGate(gate);
  const before = Object.keys(business.snapshotBusinessState().domains).length;
  const h = evidenceHarness(); const pause = defer();
  h.deps.announcements = async () => { await pause.promise; return h.rows.announcements; };
  const file = path.resolve(__dirname, '../src/services/game-update-evidence.js');
  const loaded = load(file, { '../utils/network': {}, '../config/runtime-paths': { getDataDir: () => h.dir } },
    { process: { env: { FARM_ACCOUNT_ID: 'synthetic-update', FARM_SESSION_BUSINESS: '1' } } });
  try {
    const read = loaded.service.collectGameUpdateEvidence({ deps: h.deps });
    assert.equal(gate.active, 1);
    let drained = false; const drain = gate.quiesce(5000).then(() => { drained = true; });
    await Promise.resolve(); assert.equal(drained, false);
    pause.resolve(); await read; await drain; assert.equal(gate.active, 0);
    assert.equal(Object.keys(business.snapshotBusinessState().domains).length, before);
  } finally { pause.resolve(); gate.retire(); business.setBusinessGate(null); }
});

test('reward opportunities include task-active milestones, illustrated level rewards and calendar seasons', async () => {
  const h = evidenceHarness(); h.rows.tasks = { task_info: { actives: [{ type: 1, rewards: [{ point_id: 99001, status: 2 }] }] } };
  h.rows.illustrated = { items: [], has_level_reward: true }; h.rows.solarCalendar = { events: [], seasons: [{ id: 9001, canClaim: true }] };
  const value = await h.read(); assert.equal(value.sources.tasks.activeClaimable, 1); assert.equal(value.sources.tasks.claimable, 1);
  assert.equal(value.sources.illustrated.levelClaimable, 1); assert.equal(value.sources.illustrated.claimable, 1);
  assert.equal(value.sources.solarCalendar.seasonClaimable, 1); assert.equal(value.sources.solarCalendar.claimable, 1);
});
test('aggregate read budget stops starting later RPC chains instead of timing out an orphan sequence', async () => {
  const h = evidenceHarness();
  for (const name of Object.keys(h.rows)) h.deps[name] = async () => { h.calls.push(name); h.advance(20000); return h.rows[name]; };
  const value = await h.read(); assert.equal(h.calls.length, 4); assert.equal(value.sources.illustrated.errorClass, 'read_budget_exhausted');
  assert.equal(value.sources.mall.errorClass, 'read_budget_exhausted'); assert.equal(value.factsComplete, false);
});
test('stop or replacement while scanner is pending cannot publish old results or resurrect timers', async () => {
  const h = monitorHarness(); const gate = defer(); let published = 0;
  h.service.startActivityUpdateMonitor({ knownActivityIds: [91001], onlineScanner: async () => { await gate.promise; return h.online; }, onReport: () => published++ });
  const pending = h.service.runActivityUpdateScan(); await Promise.resolve(); h.service.stopActivityUpdateMonitor(); gate.resolve();
  await assert.rejects(pending, error => error.code === 'SCAN_CANCELLED'); assert.equal(published, 0);
  assert.equal(h.service.getActivityUpdateState().nextScanAt, 0); assert.equal(h.service.getActivityUpdateState().nextEndTimeReviewAt, 0);
});

test('same solar event detects question/reward/window updates but ignores claim and quiz progress', async () => {
  const h = evidenceHarness();
  h.rows.solarCalendar.events = [{ id: 403, name: '立冬', question: '问题甲', options: ['甲', '乙'], startTime: 100, endTime: 200, rewards: [{ id: 1002, count: '200' }] }];
  const first = await h.read();
  h.advance(60001); h.rows.solarCalendar.events[0].directClaimed = true;
  h.rows.solarCalendar.events[0].canClaim = false;
  const progress = await h.read(); assert.equal(first.semanticHash, progress.semanticHash);
  h.advance(60001); h.rows.solarCalendar.events[0].rewards[0].count = '300';
  const reward = await h.read(); assert.notEqual(progress.semanticHash, reward.semanticHash);
  h.advance(60001); h.rows.solarCalendar.events[0].question = '问题乙';
  const question = await h.read(); assert.notEqual(reward.semanticHash, question.semanticHash);
  h.advance(60001); h.rows.solarCalendar.events[0].endTime = 300;
  assert.notEqual(question.semanticHash, (await h.read()).semanticHash);
});
