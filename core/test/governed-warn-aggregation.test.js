const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');
const root = path.resolve(__dirname, '../..');
const tempRoot = fs.realpathSync(os.tmpdir());
const primitiveCounts = { create: 0, write: 0, remove: 0 };
let fixture = '';
function guarded(target, base) {
  const resolved = path.resolve(target);
  const allowed = path.resolve(base);
  if (resolved !== allowed && !resolved.startsWith(allowed + path.sep)) throw new Error('fixture escape');
  for (let current = resolved; ; current = path.dirname(current)) {
    try { if (fs.lstatSync(current).isSymbolicLink()) throw new Error('fixture symlink'); }
    catch (err) { if (err.code !== 'ENOENT') throw err; }
    if (current === path.dirname(current)) break;
  }
  return resolved;
}
function createFixture() {
  const prefix = guarded(path.join(tempRoot, 'farm-summary-proof-'), tempRoot);
  if (prefix === root || prefix.startsWith(root + path.sep)) throw new Error('fixture in source');
  primitiveCounts.create++;
  return fs.mkdtempSync(prefix);
}
fixture = createFixture();
process.env.FARM_DATA_DIR = fixture;
process.env.FARM_ACCOUNT_ID = 'synthetic-budget-account';
function writeFixture(relative, text) {
  const target = guarded(path.resolve(fixture, relative), fixture);
  primitiveCounts.create++;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  primitiveCounts.write++;
  fs.writeFileSync(target, text);
  return target;
}
function removeFixture() {
  const target = guarded(fixture, fixture);
  primitiveCounts.remove++;
  fs.rmSync(target, { recursive: true, force: true });
}
const protectedPaths = [
  'core/src/services/friend-api.js', 'core/src/services/friend-orchestrator.js',
  'core/src/services/friend-visit.js', 'core/src/services/governed-warn-aggregation.js',
  'core/src/utils/network.js', 'core/src/core/worker.js', 'core/src/services/farm.js',
  'core/test/friend-summary-backoff-baseline.test.js', 'core/test/friend-summary-backoff.test.js',
  'core/test/governed-warn-aggregation-baseline.test.js', 'core/test/governed-warn-aggregation.test.js',
];
function fingerprint() {
  return Object.fromEntries(protectedPaths.map(rel => {
    const file = path.resolve(root, rel);
    const stat = fs.statSync(file);
    return [rel, [crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'), stat.mode & 0o777, stat.size]];
  }));
}
const originalFingerprint = fingerprint();
const liveHarnesses = new Set();
test.after(() => {
  try { for (const h of liveHarnesses) h.close(); }
  finally {
    try { removeFixture(); }
    finally { assert.deepEqual(fingerprint(), originalFingerprint, 'final source, mode and size fingerprint'); }
  }
});
const realUtils = require('../src/utils/utils');
const realNetwork = require('../src/utils/network');
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const flush = () => new Promise(resolve => setImmediate(resolve));
const governed = (reason = 'budget_total', marker = true) => Object.assign(new Error('synthetic budget refusal'), {
  isGovernedRejection: marker, governedReason: reason,
});
function makeHarness(t, options = {}) {
  const clock = { now: 1_800_000_000_000 };
  t.mock.method(Date, 'now', () => clock.now);
  t.mock.method(Math, 'random', () => 0.5);
  const state = {
    automation: { friend: true, friend_steal: true, friend_help: false, friend_bad: false, farm: true, harvest: true },
    known: [81001], priorities: [], connected: true, pause: 0, quiet: false,
    canOperate: true, ownDue: 0, summaryMode: 'budget', friends: [],
    visits: [], attempts: [], sends: [], composites: [], logs: [], records: [], delays: [], tasks: new Map(),
    enterMode: 'empty', enterGate: null, summaryGate: null, summaryHandler: null,
    stealHandler: null, analyzer: null, harvests: [], remoteCan: true,
  };
  const codec = {
    create: input => input,
    encode: input => ({ finish: () => Buffer.from(JSON.stringify(input)) }),
    decode: body => body.fixtureReply || {},
  };
  const types = Object.fromEntries([
    'GetGameFriendsRequest', 'GetAllFriendsReply', 'SyncAllRequest', 'SyncAllReply',
    'GetAllFriendsRequest', 'VisitEnterRequest', 'VisitEnterReply', 'VisitLeaveRequest',
    'CheckCanOperateRequest', 'CheckCanOperateReply', 'BatchBasicInfoRequest', 'BatchBasicInfoReply',
  ].map(name => [name, codec]));
  const network = { ...realNetwork, isConnected: () => state.connected,
    getUserState: () => ({ gid: 80001, accountId: 'synthetic-budget-account' }),
    networkEvents: new EventEmitter(), sendMsgAsync: async (service, method, payload) => {
      const input = JSON.parse(Buffer.from(payload).toString());
      state.attempts.push({ service, method, input, at: clock.now });
      let reply;
      if (['GetGameFriends', 'SyncAll', 'GetAll'].includes(method)) {
        if (state.summaryHandler) reply = await state.summaryHandler(method, input);
        else if (state.summaryGate) reply = await state.summaryGate.promise;
        else if (state.summaryMode === 'budget') throw governed();
        else if (state.summaryMode === 'ordinary') throw new Error('synthetic ordinary failure');
        else reply = { game_friends: state.friends };
      } else if (method === 'Enter') {
        state.visits.push({ gid: realUtils.toNum(input.host_gid), at: clock.now });
        if (state.enterGate) reply = await state.enterGate.promise;
        else if (state.enterMode === 'budget') throw governed();
        else if (state.enterMode === 'ordinary') throw new Error('synthetic enter failure');
        else reply = { lands: [], at_home: false };
      } else if (method === 'CheckCanOperate') reply = { can_operate: state.remoteCan, can_steal_num: 2 };
      else if (method === 'Leave') reply = {};
      else throw new Error(`unexpected mock transport method ${  method}`);
      state.sends.push({ method, at: clock.now });
      const body = Buffer.alloc(0);
      body.fixtureReply = reply;
      return { body };
    },
  };
  const config = require('../src/config/config');
  const configStub = { ...config, CONFIG: { ...config.CONFIG, platform: options.platform || 'wechat' } };
  const store = {
    isAutomationOn: key => !!state.automation[key], getAutomation: () => state.automation,
    getFriendBlacklist: () => [], getPlantBlacklist: () => [], getWatchlistFriendGids: () => state.priorities,
    getWatchlistResetMeta: () => ({}), getAutoAcceptFriendMinLevel: () => 0,
    getKnownFriendGids: () => state.known, applyConfigSnapshot: patch => { if (patch.knownFriendGids) state.known = patch.knownFriendGids; },
    getFriendBadRetryDate: () => '', readFriendDogInfoCache: () => ({ 81999: {} }),
    getPauseRemainMs: () => state.pause, getFriendQuietHours: () => ({ enabled: state.quiet, start: '00:00', end: '00:00' }), removeFriendFromCache: () => {},
  };
  const utils = { ...realUtils, log: (tag, message, meta) => state.logs.push({ tag, message, ...meta }),
    logWarn: (tag, message, meta) => state.logs.push({ tag, message, warn: true, ...meta }),
    randomDelay: async (min, max) => { state.delays.push([min, max]); }, sleep: async () => {},
    getServerTimeSec: () => clock.now / 1000,
  };
  const schedulers = [];
  const scheduler = { createScheduler: _name => {
    const tasks = new Map(); schedulers.push(tasks);
    return { setTimeoutTask: (key, delay, fn) => tasks.set(key, { delay, fn }),
      setIntervalTask: (key, delay, fn) => tasks.set(key, { delay, fn }), clear: key => tasks.delete(key),
      clearAll: () => tasks.clear(), has: key => tasks.has(key) };
  } };
  const governor = { getBreakerState: () => ({ active: false }), setContentionMode: () => {}, setUrgentMode: () => {}, setWatchMode: () => {} };
  const activity = new Proxy({ noteEnterPresence: () => ({ onlineEdge: false }), resolveFriendDisplayName: (_gid, name) => name },
    { get: (obj, key) => obj[key] || (() => false) });
  const limits = {
    checkDailyReset: () => {}, canOperate: () => state.canOperate, canOperateBad: () => false,
    getCanGetHelpExp: () => true, getHelpAutoDisabledByLimit: () => false, updateOperationLimits: () => {},
    getRemainingTimes: () => state.canOperate ? 99 : 0, getBadRemainingTimes: () => 99,
    canGetExpByCandidates: () => true, setCanGetHelpExp: () => {},
    stealHarvest: async (gid, lands) => {
      state.harvests.push({ gid, lands: [...lands], at: clock.now });
      if (state.stealHandler) return state.stealHandler(gid, lands);
      return { items: [] };
    }, sumHarvestItemCount: () => ({ total: 1, detail: '合成果实×1' }),
  };
  const analyzer = {
    setFriendsListCache: () => {}, fetchFriendsDogInfo: async () => {}, getFriendsList: async () => [],
    analyzeFriendLands: () => state.analyzer || { stealable: [], stealableInfo: [], waterable: [], weedy: [], insecty: [] },
  };
  const overrides = new Map();
  for (const [rel, exp] of Object.entries({
    'utils/network': network, 'utils/utils': utils, 'utils/proto': { types }, 'models/store': store,
    'config/config': configStub, 'services/scheduler': scheduler, 'services/request-governor': governor,
    'services/farm': { setOperationLimitsCallback: () => {} },
    'services/friend-operation-limits': limits, 'services/friend-land-analyzer': analyzer,
    'services/farm-land-analyzer': { getCurrentPhase: () => ({ phase: config.PlantPhase.MATURE }) },
    'services/friend-activity': activity, 'services/daily-events': { recordEvent: (...args) => state.records.push(args) },
    'services/stats': { recordOperation: (...args) => state.records.push(args) },
    'services/warehouse': { sellAllFruits: async () => {} },
    'services/interact': { getInteractRecords: async () => [] },
    'services/friend-auto-bad': { isAutoBadRunning: () => false, startAutoBadLoop: () => {}, stopAutoBadLoop: () => {} },
    'services/friend-self-echo': { recordLandsBaseline: () => {} },
  })) overrides.set(path.join(root, 'core/src', `${rel  }.js`), exp);
  const modules = new Map();
  const realVmNames = new Set(['friend-api', 'friend-orchestrator', 'friend-visit', 'governed-warn-aggregation', 'fertilizer-watch', 'steal-schedule', 'behavior']);
  function load(file) {
    if (overrides.has(file)) return overrides.get(file);
    if (modules.has(file)) return modules.get(file).exports;
    const request = createRequire(file);
    const mod = { exports: {} }; modules.set(file, mod);
    const localRequire = rel => {
      const resolved = request.resolve(rel);
      if (overrides.has(resolved)) return overrides.get(resolved);
      if (realVmNames.has(path.basename(resolved, '.js')) && resolved.startsWith(root + path.sep)) return load(resolved);
      return request(rel);
    };
    const source = fs.readFileSync(file, 'utf8');
    const wrapper = vm.runInThisContext(`(function(require,module,exports,__filename,__dirname){${  source  }\n})`, { filename: file });
    wrapper(localRequire, mod, mod.exports, file, path.dirname(file));
    return mod.exports;
  }
  const api = load(path.join(root, 'core/src/services/friend-api.js'));
  const realGetAll = api.getAllFriends;
  api.getAllFriends = async (...args) => { state.composites.push({ at: clock.now, force: !!args[0] }); return realGetAll(...args); };
  const visit = load(path.join(root, 'core/src/services/friend-visit.js'));
  const watch = load(path.join(root, 'core/src/services/fertilizer-watch.js'));
  const behavior = load(path.join(root, 'core/src/utils/behavior.js'));
  const orchestrator = load(path.join(root, 'core/src/services/friend-orchestrator.js'));
  const aggregationPath = path.join(root, 'core/src/services/governed-warn-aggregation.js');
  const aggregation = fs.existsSync(aggregationPath) ? load(aggregationPath) : null;
  const h = { clock, state, api, visit, watch, behavior, orchestrator, aggregation, types, load,
    close() {
      try { orchestrator.stopFriendCheckLoop(); }
      finally { watch.resetFertilizerWatchForTests(); for (const tasks of schedulers) tasks.clear(); liveHarnesses.delete(h); }
    },
  };
  liveHarnesses.add(h);
  t.after(() => h.close());
  return h;
}
function stateOf(h) { return h.orchestrator.getFriendReadStateForTests(); }

test('guarded fixture operations reject traversal and symlink escape before primitive calls and perform valid writes', () => {
  const before = { ...primitiveCounts };
  assert.throws(() => writeFixture('../forbidden.txt', 'no'), /escape/);
  assert.deepEqual(primitiveCounts, before);
  const link = guarded(path.join(fixture, 'warn-escape-link'), fixture);
  primitiveCounts.write++; fs.symlinkSync(root, link);
  const linked = { ...primitiveCounts };
  assert.throws(() => writeFixture('warn-escape-link/forbidden.txt', 'no'), /symlink/);
  assert.deepEqual(primitiveCounts, linked);
  const valid = writeFixture('valid-warn/item.txt', 'yes');
  assert.equal(fs.readFileSync(valid, 'utf8'), 'yes');
  assert.equal(primitiveCounts.create, before.create + 1);
  assert.equal(primitiveCounts.write, before.write + 2);
});

test('fixed seven entries times two strict categories cap 14 signatures without identity or error text', t => {
  const h = makeHarness(t); const a = h.aggregation;
  const entries = [...a.GOVERNED_WARN_ENTRIES]; const reasons = [...a.GOVERNED_WARN_REASONS];
  assert.equal(entries.length, 7); assert.equal(reasons.length, 2);
  for (const entry of entries) for (const reason of reasons) {
    const result = a.noteGovernedWarn(entry, reason, { now: h.clock.now, gid: 81001, message: 'not retained' });
    assert.equal(result.mode, 'first');
  }
  for (let i = 0; i < 100; i++) {
    assert.equal(a.noteGovernedWarn(`unlisted-${  i}`, 'budget_total').handled, false);
    assert.equal(a.noteGovernedWarn('enter_visit', `unknown-${  i}`).handled, false);
  }
  const rows = a.getGovernedWarnRowsForTests();
  assert.equal(Object.keys(rows).length, 14);
  assert.equal(h.state.logs.filter(r => r.event === 'governed_warn_aggregated').length, 14);
  for (const row of Object.values(rows)) assert.deepEqual(Object.keys(row).sort(), ['firstAt', 'lastAt', 'lastEmitAt', 'pending']);
  assert.ok(!JSON.stringify(rows).includes('81001'));
  assert.ok(!JSON.stringify(rows).includes('not retained'));
});

test('per-signature first warning immediate, accurate 60-second rolling burst and silence measured from last occurrence', t => {
  const h = makeHarness(t); const a = h.aggregation; const start = h.clock.now;
  assert.equal(a.noteGovernedWarn('enter_steal', 'budget_total').mode, 'first');
  h.clock.now = start + 59000;
  assert.equal(a.noteGovernedWarn('enter_steal', 'budget_total').mode, 'suppressed');
  h.clock.now = start + 60000;
  assert.equal(a.noteGovernedWarn('enter_steal', 'budget_total').mode, 'aggregated');
  assert.deepEqual(h.state.logs.map(r => r.count), [1, 2]);
  h.clock.now = start + 61000;
  assert.equal(a.noteGovernedWarn('enter_steal', 'budget_total').mode, 'suppressed');
  h.clock.now = start + 119999;
  assert.equal(a.noteGovernedWarn('enter_steal', 'budget_total').mode, 'suppressed');
  h.clock.now = start + 120000;
  assert.equal(a.noteGovernedWarn('enter_steal', 'budget_total').mode, 'aggregated');
  assert.deepEqual(h.state.logs.map(r => r.count), [1, 2, 3]);
  h.clock.now = start + 180000;
  assert.equal(a.noteGovernedWarn('enter_steal', 'budget_total').mode, 'first', '60 seconds of actual silence starts a fresh burst immediately');
  assert.equal(h.state.logs.at(-1).count, 1);
});

for (const [method, entry] of [
  ['visitFriend', 'enter_visit'], ['visitFriendForSteal', 'enter_steal'],
  ['visitFriendForHelp', 'enter_help'], ['visitFriendForAutoBad', 'enter_autobad'],
]) test(`real ${  method  } catch aggregates without changing attempts, settle or normal failures`, async t => {
  const h = makeHarness(t); h.state.enterMode = 'budget';
  const tally = { steal: 0, water: 0, weed: 0, bug: 0, putBug: 0, putWeed: 0 };
  for (let i = 0; i < 10; i++) {
    const result = await h.visit[method]({ gid: 81001 + i, name: `合成好友${  i}` }, tally, 80001, 'synthetic-budget-account');
    assert.equal(result.entered, false); h.clock.now += 100;
  }
  assert.equal(h.state.visits.length, 10); assert.equal(h.state.sends.length, 0);
  assert.equal(h.state.logs.filter(r => r.warn).length, 1);
  assert.equal(h.state.logs[0].entry, entry);
  assert.deepEqual(tally, { steal: 0, water: 0, weed: 0, bug: 0, putBug: 0, putWeed: 0 });
  h.state.enterMode = 'ordinary';
  for (let i = 0; i < 3; i++) await h.visit[method]({ gid: 81001, name: '合成好友' }, tally, 80001, 'synthetic-budget-account');
  assert.equal(h.state.visits.length, 13); assert.equal(h.state.logs.filter(r => r.warn).length, 4);
  assert.ok(h.state.logs.slice(-3).every(r => r.message.includes('synthetic enter failure')));
});

test('real QQ batch and two summary catch signatures have bounded warnings and independent internal attempt counts', async t => {
  const h = makeHarness(t, { platform: 'qq' });
  h.state.known = Array.from({ length: 70 }, (_, i) => 84001 + i);
  for (let i = 0; i < 5; i++) {
    await h.orchestrator.refreshFriendRipeSchedule({ force: true }); h.clock.now += 100;
  }
  assert.equal(h.state.composites.length, 5);
  assert.equal(h.state.attempts.length, 20); assert.equal(h.state.sends.length, 0);
  assert.deepEqual(h.state.logs.filter(r => r.warn).map(r => r.entry), ['qq_batch', 'summary_refresh']);
  h.clock.now = stateOf(h).gate.blockedUntil;
  await h.orchestrator.checkFriends({ onlySteal: true });
  const warnings = h.state.logs.filter(r => r.warn);
  assert.ok(warnings.some(r => r.entry === 'summary_check'));
  assert.equal(h.state.composites.length, 6); assert.equal(h.state.attempts.length, 24);
});

test('mixed rebuilt QQ errors keep original ordinary warning and independently aggregate actual structured categories', async t => {
  const h = makeHarness(t, { platform: 'qq' });
  h.state.summaryHandler = method => {
    if (method === 'GetGameFriends') throw governed('budget_total');
    if (method === 'SyncAll') throw governed('budget_method');
    throw new Error('ordinary GetAll synthetic');
  };
  await h.orchestrator.refreshFriendRipeSchedule({ force: true });
  const warnings = h.state.logs.filter(r => r.warn);
  assert.ok(warnings.some(r => r.event === 'governed_warn_aggregated' && r.reason === 'budget_total'));
  assert.ok(warnings.some(r => r.event === 'governed_warn_aggregated' && r.reason === 'budget_method'));
  assert.ok(warnings.some(r => !r.event && r.message.includes('ordinary GetAll synthetic')));
  assert.equal(stateOf(h).gate.level, 1);
  assert.equal(h.state.attempts.length, 3);
});

test('ordinary governance-looking text and forged boolean/category keep real warning in existing catches', async t => {
  const h = makeHarness(t);
  const errors = [new Error('请求被治理器拦截(budget_total)'), governed('budget_total', 1), governed('unknown')];
  for (const error of errors) {
    h.state.summaryHandler = () => { throw error; };
    await h.orchestrator.refreshFriendRipeSchedule({ force: true });
  }
  assert.equal(h.state.logs.filter(r => r.warn).length, 3);
  assert.equal(h.state.logs.filter(r => r.event === 'governed_warn_aggregated').length, 0);
  assert.deepEqual(h.aggregation.getGovernedWarnRowsForTests(), {});
  assert.equal(stateOf(h).gate.level, 0);
});

test('strict marker helper requires true boolean and known category; does not mutate errors', t => {
  const h = makeHarness(t); const reader = h.aggregation.getGovernedRejectionInfo;
  assert.deepEqual(reader(governed()), { reason: 'budget_total' });
  assert.deepEqual(reader(governed('budget_method')), { reason: 'budget_method' });
  for (const error of [null, 'budget_total', new Error('治理器拦截'), governed('unknown'), governed('budget_total', 'true')]) assert.equal(reader(error), null);
  const error = governed(); const before = Object.getOwnPropertyDescriptors(error);
  reader(error); assert.deepEqual(Object.getOwnPropertyDescriptors(error), before);
});

test('real lifecycle resets warnings and late old Enter cannot consume next burst window', async t => {
  const h = makeHarness(t); const pending = deferred(); h.state.enterGate = pending;
  const tally = { steal: 0, water: 0, weed: 0, bug: 0, putBug: 0, putWeed: 0 };
  const old = h.visit.visitFriendForSteal({ gid: 81001, name: '合成好友' }, tally, 80001, 'synthetic-budget-account');
  await flush();
  h.orchestrator.stopFriendCheckLoop(); h.orchestrator.startFriendCheckLoop({ externalScheduler: true });
  const seq = h.aggregation.getGovernedWarnLifecycleSeq();
  const before = h.aggregation.getGovernedWarnRowsForTests();
  pending.reject(governed()); await old;
  assert.deepEqual(h.aggregation.getGovernedWarnRowsForTests(), before);
  assert.equal(h.state.logs.filter(r => r.warn).length, 0);
  h.state.enterGate = null; h.state.enterMode = 'budget';
  await h.visit.visitFriendForSteal({ gid: 81001, name: '合成好友' }, tally, 80001, 'synthetic-budget-account');
  assert.equal(h.state.logs.filter(r => r.warn).length, 1);
  const rows = h.aggregation.getGovernedWarnRowsForTests();
  assert.equal(h.aggregation.noteGovernedWarn('enter_steal', 'budget_total', { seq: seq - 1 }).mode, 'stale');
  assert.deepEqual(h.aggregation.getGovernedWarnRowsForTests(), rows);
  h.orchestrator.stopFriendCheckLoop();
  assert.deepEqual(h.aggregation.getGovernedWarnRowsForTests(), {});
});
