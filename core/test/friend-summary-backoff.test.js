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
function workerEntry(h) {
  const source = fs.readFileSync(path.join(root, 'core/src/core/worker.js'), 'utf8');
  const from = source.indexOf('let stealOverdueStrikes = 0;');
  const to = source.indexOf('function scheduleUnifiedNextTick()', from);
  assert.ok(from > 0 && to > from);
  const b = h.behavior;
  const sandbox = { ...b, Date, Math, process: { env: { FARM_ACCOUNT_ID: 'synthetic-budget-account' } },
    unifiedSchedulerRunning: true, loginReady: true, friendSyncPaused: false, stealTaskRunning: false,
    nextFarmRunAt: h.clock.now + 1e9, nextHelpRunAt: h.clock.now + 1e9, nextStealRunAt: h.clock.now,
    STEAL_IDLE_MS: 60000, OWN_HARVEST_RESERVE_MS: 10000,
    PRIORITY_SUMMARY_FLOOR_MIN_MS: 60000, PRIORITY_SUMMARY_FLOOR_MAX_MS: 120000,
    getPauseRemainMs: () => h.state.pause, markIdleQuietUntil: () => {}, pauseAceReports: () => {}, resumeAceReports: () => {},
    formatIdleRemain: String, log: () => {}, getAutomation: () => h.state.automation,
    ownHarvestDueAt: () => h.state.ownDue, armOwnHarvestGuard: () => {},
    nextScheduledStealAt: () => sandbox.nextStealRunAt,
    getNextStealDueAtMs: () => h.orchestrator.getNextStealDueAtMs(),
    getNextWatchDueAt: h.watch.getNextWatchDueAt, getNextWatchlistStealDueAtMs: h.orchestrator.getNextWatchlistStealDueAtMs,
    mergeDueAt: require('../src/services/steal-schedule').mergeDueAt, armMaturitySentinel: () => {},
    stealRediscoveryDelayMs: () => 60000, checkFriends: h.orchestrator.checkFriends,
    isTransientNetworkError: () => false, runOwnHarvestStrike: async () => {},
    runFarmTick: async () => {}, runHelpTick: async () => {},
  };
  return vm.runInNewContext(`${source.slice(from, to)  }\n;({runUnifiedTick,armStealWake,runStealTick})`, sandbox, { filename: 'worker.js#real-unified-scheduler' });
}
function dueFriend(gid, seconds, extra = {}) {
  return { gid, name: `合成好友${  gid}`, level: 10, plant: { ripe_time_sec: seconds, ...extra } };
}
function seed(h, friends, partial = false) {
  h.orchestrator.applyStealScheduleFromFriends(friends, { myGid: 80001, blacklist: new Set(), partial });
}
function stateOf(h) { return h.orchestrator.getFriendReadStateForTests(); }

test('fixture guarded primitive rejects traversal and symlink ancestors before any create/write; valid writes execute', () => {
  const before = { ...primitiveCounts };
  assert.throws(() => writeFixture('../escape.txt', 'bad'), /escape/);
  assert.throws(() => writeFixture(path.join(root, 'core/src/services/friend-api.js'), 'bad'), /escape/);
  assert.deepEqual(primitiveCounts, before);
  const link = guarded(path.join(fixture, 'escape-link'), fixture);
  primitiveCounts.write++; fs.symlinkSync(root, link);
  const afterLink = { ...primitiveCounts };
  assert.throws(() => writeFixture('escape-link/should-not-exist', 'bad'), /symlink/);
  assert.deepEqual(primitiveCounts, afterLink, 'symlink rejected before primitives');
  const file = writeFixture('valid/data.txt', 'valid');
  assert.equal(fs.readFileSync(file, 'utf8'), 'valid');
  assert.equal(primitiveCounts.create, before.create + 1);
  assert.equal(primitiveCounts.write, before.write + 2);
  assert.deepEqual(fingerprint(), originalFingerprint);
});

test('shared exact deadlines use 2-4,4-8,8-16,20-30 seconds with no sliding skips or success timestamp', async t => {
  const h = makeHarness(t);
  const bands = [[2000, 4000], [4000, 8000], [8000, 16000], [20000, 30000], [20000, 30000]];
  for (let i = 0; i < bands.length; i++) {
    const at = h.clock.now;
    await h.orchestrator.checkFriends({ onlySteal: true });
    const snapshot = stateOf(h).gate;
    assert.equal(snapshot.level, Math.min(i + 1, 4));
    assert.ok(snapshot.blockedUntil - at >= bands[i][0] && snapshot.blockedUntil - at <= bands[i][1]);
    const attempts = h.state.attempts.length;
    h.clock.now = snapshot.blockedUntil - 1;
    await h.orchestrator.checkFriends({ onlySteal: true });
    await h.orchestrator.refreshFriendRipeSchedule();
    assert.equal(h.state.attempts.length, attempts);
    assert.deepEqual(stateOf(h).gate, snapshot, 'skip neither extends deadline nor writes success time');
    h.clock.now = snapshot.blockedUntil;
  }
  assert.equal(h.state.composites.length, 5);
  assert.equal(h.state.attempts.length, 5);
  assert.equal(h.state.sends.length, 0);
});

test('force makes one protected composite attempt; normal error neutral and clean complete success resets gate', async t => {
  const h = makeHarness(t);
  await h.orchestrator.checkFriends({ onlySteal: true });
  const denied = stateOf(h).gate;
  h.state.summaryMode = 'ordinary';
  await h.orchestrator.refreshFriendRipeSchedule({ force: true });
  assert.equal(h.state.composites.length, 2);
  assert.deepEqual(stateOf(h).gate, denied);
  h.state.summaryMode = 'success'; h.state.friends = [dueFriend(81001, 3600)];
  await h.orchestrator.refreshFriendRipeSchedule({ force: true });
  assert.equal(h.state.composites.length, 3);
  assert.deepEqual(stateOf(h).gate, { level: 0, blockedUntil: 0, lastCleanSuccessAt: h.clock.now });
  h.state.connected = false;
  await h.orchestrator.refreshFriendRipeSchedule({ force: true });
  assert.equal(h.state.composites.length, 3, 'force retains connection protection');
  h.state.connected = true; h.behavior.markOwnHarvestDueAt(h.clock.now + 9999);
  await h.orchestrator.refreshFriendRipeSchedule({ force: true });
  assert.equal(h.state.composites.length, 3, 'force retains own last-ten-seconds protection');
});

test('QQ partial neutral vs governed partial, multiple swallowed refusals advance only one level, fallback success honest', async t => {
  const h = makeHarness(t, { platform: 'qq' });
  const known = Array.from({ length: 105 }, (_, i) => 83001 + i);
  h.state.known = known;
  let batch = 0;
  h.state.summaryHandler = method => {
    if (method === 'GetGameFriends' && ++batch === 1) return { game_friends: [dueFriend(83001, 100)] };
    throw new Error('ordinary failed batch');
  };
  await h.orchestrator.refreshFriendRipeSchedule({ force: true });
  assert.equal(stateOf(h).gate.level, 0);
  assert.equal(stateOf(h).gate.lastCleanSuccessAt, 0, 'ordinary partial is neutral');
  h.state.known = known; batch = 0;
  h.state.summaryHandler = method => {
    if (method === 'GetGameFriends' && ++batch === 1) return { game_friends: [dueFriend(83001, 100)] };
    throw governed();
  };
  await h.orchestrator.refreshFriendRipeSchedule({ force: true });
  assert.equal(stateOf(h).gate.level, 1, 'two swallowed refusals advance one composite level');
  h.state.known = known;
  h.state.summaryHandler = method => { if (method === 'SyncAll') return { game_friends: [dueFriend(83001, 100)] }; throw governed(); };
  await h.orchestrator.refreshFriendRipeSchedule({ force: true });
  assert.equal(stateOf(h).gate.level, 2, 'successful fallback retains governed provenance');
  assert.equal(h.state.composites.length, 3);
  assert.equal(h.state.attempts.length, 10);
  assert.equal(h.state.sends.length, 3);
});

for (const platform of ['qq', 'wechat']) test(`${platform  } actual composite observer reports exactly once on success, failure and encoder-before-send failure`, async t => {
  const h = makeHarness(t, { platform });
  const observations = [];
  h.state.summaryMode = 'success'; h.state.friends = [dueFriend(81001, 100)];
  const result = await h.api.getAllFriends(false, obs => observations.push(obs));
  assert.equal(result.game_friends[0].gid, 81001);
  assert.equal(observations.length, 1); assert.equal(observations[0].ok, true); assert.equal(observations[0].attempts, 1);
  h.state.summaryMode = 'ordinary';
  await assert.rejects(h.api.getAllFriends(false, obs => observations.push(obs)), /synthetic ordinary failure/);
  assert.equal(observations.length, 2); assert.equal(observations[1].ok, false);
  assert.equal(observations[1].governedRejection, false);
  const attempts = h.state.attempts.length;
  delete h.types[platform === 'qq' ? 'GetGameFriendsRequest' : 'GetAllFriendsRequest'];
  await assert.rejects(h.api.getAllFriends(false, obs => observations.push(obs)), /接口类型未加载/);
  assert.equal(observations.length, 3); assert.equal(observations[2].attempts, 0);
  assert.equal(h.state.attempts.length, attempts, 'pre-encoding failure has zero transport calls');
});

test('observer exceptions preserve original direct success and original failure object; QQ fallback error reconstruction and order unchanged', async t => {
  const h = makeHarness(t);
  h.state.summaryMode = 'success';
  assert.deepEqual(await h.api.getAllFriends(false, () => { throw new Error('callback'); }), { game_friends: [] });
  const original = new Error('transport original'); h.state.summaryHandler = () => { throw original; };
  let captured;
  try { await h.api.getAllFriends(false, () => { throw new Error('callback'); }); } catch (err) { captured = err; }
  assert.equal(captured, original);
  const q = makeHarness(t, { platform: 'qq' }); const observations = [];
  await assert.rejects(q.api.getAllFriends(false, obs => observations.push(obs)), /^Error: SyncAll: synthetic budget refusal \| GetAll: synthetic budget refusal$/);
  assert.deepEqual(q.state.attempts.map(r => r.method), ['GetGameFriends', 'SyncAll', 'GetAll']);
  assert.equal(observations.length, 1); assert.equal(observations[0].attempts, 3);
  assert.equal(observations[0].governedRejection, true);
});

test('interleaved independent reads never attribute unrelated refusal to clean orchestrator success', async t => {
  const h = makeHarness(t); const slow = deferred(); let calls = 0;
  h.state.summaryHandler = () => { if (++calls === 1) return slow.promise; throw governed(); };
  const planned = h.orchestrator.refreshFriendRipeSchedule({ force: true });
  await flush();
  const otherObservations = [];
  await assert.rejects(h.api.getAllFriends(false, obs => otherObservations.push(obs)));
  slow.resolve({ game_friends: [dueFriend(81001, 100)] }); await planned;
  assert.equal(stateOf(h).gate.level, 0);
  assert.equal(stateOf(h).gate.lastCleanSuccessAt, h.clock.now);
  assert.equal(otherObservations[0].governedRejection, true);
  assert.equal(h.state.composites.length, 2); assert.equal(h.state.attempts.length, 2); assert.equal(h.state.sends.length, 1);
});

test('unrelated full success cannot clear current refusal and interleaved ordinary outcome remains neutral', async t => {
  const h = makeHarness(t); const slow = deferred(); let calls = 0;
  h.state.summaryHandler = () => { if (++calls === 1) return slow.promise; throw governed(); };
  const unrelated = h.api.getAllFriends(); await flush();
  await h.orchestrator.checkFriends({ onlySteal: true }); const gate = stateOf(h).gate;
  slow.resolve({ game_friends: [] }); await unrelated;
  assert.deepEqual(stateOf(h).gate, gate);
  h.state.summaryHandler = () => { throw new Error('请求被治理器拦截(budget_total) synthetic text'); };
  await h.orchestrator.refreshFriendRipeSchedule({ force: true });
  assert.deepEqual(stateOf(h).gate, gate, 'governance-looking ordinary text is not provenance');
});

for (const [name, err] of [
  ['text', new Error('请求被治理器拦截(budget_total)')],
  ['nonboolean marker', governed('budget_total', 'true')],
  ['unknown category', governed('arbitrary')],
]) test(`strict governor marker rejects spoof: ${  name}`, async t => {
  const h = makeHarness(t); const observed = [];
  h.state.summaryHandler = () => { throw err; };
  await assert.rejects(h.api.getAllFriends(false, obs => observed.push(obs)));
  assert.equal(observed[0].governedRejection, false);
  await h.orchestrator.checkFriends({ onlySteal: true });
  assert.equal(stateOf(h).gate.level, 0);
});

test('snapshot full/partial/empty semantics retain absolute evidence without renewing it on failed or skipped reads', async t => {
  const h = makeHarness(t); h.state.summaryMode = 'success';
  h.state.friends = [dueFriend(81001, 10), dueFriend(81002, 20)];
  await h.orchestrator.refreshFriendRipeSchedule({ force: true });
  const first = stateOf(h).actionCache;
  seed(h, [dueFriend(81001, 30)], true);
  const partial = stateOf(h).actionCache;
  assert.equal(partial.find(r => r.gid === 81002).dueAt, first.find(r => r.gid === 81002).dueAt);
  const before = partial.map(r => ({ ...r }));
  h.state.summaryMode = 'budget'; await h.orchestrator.checkFriends({ onlySteal: true });
  await h.orchestrator.checkFriends({ onlySteal: true });
  assert.deepEqual(stateOf(h).actionCache, before);
  h.state.summaryMode = 'success'; h.state.friends = [];
  await h.orchestrator.refreshFriendRipeSchedule({ force: true });
  assert.deepEqual(stateOf(h).actionCache, [], 'authoritative empty clears all cached targets');
});

test('steal-count-only, staggered and newly due cache targets dispatch through actual visit without summary gate wait', async t => {
  const h = makeHarness(t); h.state.enterMode = 'budget';
  seed(h, [dueFriend(81001, 1), dueFriend(81002, 2), dueFriend(81003, 0, { steal_plant_num: 2 })]);
  for (const gid of [81001, 81002, 81003]) h.watch.unwatchFriend(gid);
  await h.orchestrator.checkFriends({ onlySteal: true });
  assert.equal(h.state.visits[0].gid, 81003, 'count-only target immediately visited');
  assert.equal(h.state.composites.length, 1);
  h.clock.now += 1100;
  await h.orchestrator.checkFriends({ onlySteal: true });
  assert.ok(h.state.visits.some(r => r.gid === 81001 && r.at === h.clock.now));
  h.clock.now += 1000;
  await h.orchestrator.checkFriends({ onlySteal: true });
  assert.ok(h.state.visits.some(r => r.gid === 81002 && r.at === h.clock.now));
  assert.equal(h.state.composites.length, 1, 'all targets bypass only the summary gate');
});

test('cache-plus-fresh same round deduplicates and keeps priority, level and stable ties', async t => {
  const h = makeHarness(t); h.state.priorities = [81003]; h.state.enterMode = 'budget';
  const friends = [
    { ...dueFriend(81001, 0, { steal_plant_num: 1 }), level: 20 },
    { ...dueFriend(81002, 0, { steal_plant_num: 1 }), level: 20 },
    { ...dueFriend(81003, 0, { steal_plant_num: 1 }), level: 1 },
    { ...dueFriend(81004, 0, { steal_plant_num: 1 }), level: 30 },
  ];
  seed(h, friends); h.state.summaryMode = 'success'; h.state.friends = friends;
  await h.orchestrator.checkFriends({ onlySteal: true });
  assert.deepEqual(h.state.visits.map(r => r.gid), [81003, 81004, 81001, 81002]);
  assert.equal(h.state.composites.length, 1);
});

for (const mode of ['onlyHelp', 'onlyBad', 'stealDisabled', 'onlySteal']) test(`cache dispatch respects existing mode ${  mode}`, async t => {
  const h = makeHarness(t); h.state.enterMode = 'budget';
  seed(h, [dueFriend(81001, 0, { steal_plant_num: 1 })]);
  if (mode === 'stealDisabled' || mode === 'onlySteal') h.state.automation.friend_steal = false;
  await h.orchestrator.checkFriends(mode === 'stealDisabled' ? {} : { [mode]: true });
  assert.equal(h.state.visits.length, mode === 'onlySteal' ? 1 : 0);
});

test('actual failed Enter retains evidence, actual empty land and already stolen confirm removal', async t => {
  const h = makeHarness(t);
  seed(h, [dueFriend(81001, 0, { steal_plant_num: 2 })]);
  h.state.enterMode = 'ordinary'; await h.orchestrator.checkFriends({ onlySteal: true });
  assert.equal(stateOf(h).actionCache.length, 1);
  h.state.enterMode = 'empty'; await h.orchestrator.checkFriends({ onlySteal: true });
  assert.equal(stateOf(h).actionCache.length, 0);
  seed(h, [dueFriend(81002, 0, { steal_plant_num: 2 })]);
  h.state.enterGate = deferred(); const checking = h.orchestrator.checkFriends({ onlySteal: true }); await flush();
  h.state.enterGate.resolve({ lands: [{ id: 1, plant: { id: 1, phases: [], stealable: false } }] }); await checking;
  assert.equal(stateOf(h).actionCache.length, 0, 'successful already-stolen observation clears');
});

test('90-second grace keeps original evidence after repeated refusal, skips and retryNeeded', async t => {
  const h = makeHarness(t); h.state.enterMode = 'budget';
  seed(h, [dueFriend(81001, 0, { steal_plant_num: 1 })]);
  const since = stateOf(h).actionCache[0].stealableSince;
  await h.orchestrator.checkFriends({ onlySteal: true });
  h.clock.now = since + 90000;
  await h.orchestrator.checkFriends({ onlySteal: true });
  assert.equal(h.state.visits.length, 2, 'grace endpoint included');
  h.clock.now += 1;
  await h.orchestrator.checkFriends({ onlySteal: true });
  assert.equal(h.state.visits.length, 2, 'expired evidence does not dispatch or renew');
});

for (const oldResult of ['success', 'ordinary', 'governed']) test(`real stop/start fences late old ${  oldResult  } summary, warning, cache and finally ownership`, async t => {
  const h = makeHarness(t); const old = deferred();
  h.state.summaryHandler = () => old.promise;
  const oldRun = h.orchestrator.checkFriends({ onlySteal: true }); await flush();
  h.orchestrator.stopFriendCheckLoop(); h.orchestrator.startFriendCheckLoop({ externalScheduler: true });
  h.state.summaryHandler = () => { throw governed(); };
  await h.orchestrator.checkFriends({ onlySteal: true });
  const before = stateOf(h); const warningBefore = h.aggregation.getGovernedWarnRowsForTests();
  const newGate = deferred(); h.state.summaryHandler = () => newGate.promise;
  const newRun = h.orchestrator.refreshFriendRipeSchedule({ force: true }); await flush();
  const owner = stateOf(h).checkingPlaceholder;
  if (oldResult === 'success') old.resolve({ game_friends: [dueFriend(81001, 0, { steal_plant_num: 5 })] });
  else old.reject(oldResult === 'governed' ? governed() : new Error('old ordinary'));
  await oldRun;
  const after = stateOf(h);
  assert.deepEqual(after.gate, before.gate); assert.deepEqual(after.actionCache, before.actionCache);
  assert.deepEqual(h.aggregation.getGovernedWarnRowsForTests(), warningBefore);
  assert.deepEqual(after.checkingPlaceholder, owner, 'old finally cannot release new owner');
  assert.equal(h.state.visits.length, 0, 'late old summary starts zero visit');
  newGate.resolve({ game_friends: [] }); await newRun;
});

test('cached visit in flight remains exclusive across actual stop/start and cannot settle new cache', async t => {
  const h = makeHarness(t);
  seed(h, [dueFriend(81001, 0, { steal_plant_num: 1 })]);
  const enter = deferred(); h.state.enterGate = enter;
  const run = h.orchestrator.checkFriends({ onlySteal: true }); await flush();
  assert.equal(stateOf(h).checkingPlaceholder.phase, 'visit');
  h.orchestrator.stopFriendCheckLoop(); h.orchestrator.startFriendCheckLoop({ externalScheduler: true });
  seed(h, [dueFriend(81002, 20)]); const before = stateOf(h).actionCache;
  await h.orchestrator.checkFriends({ onlySteal: true });
  await h.orchestrator.refreshFriendRipeSchedule({ force: true });
  assert.equal(h.state.visits.length, 1); assert.equal(h.state.composites.length, 0, 'in-flight farm session stays exclusive');
  enter.resolve({ lands: [] }); await run;
  assert.deepEqual(stateOf(h).actionCache, before, 'old visit cannot settle new cache');
});

test('own last-ten-second protection and real unified pause prevent new friend reads and visits', async t => {
  const h = makeHarness(t); seed(h, [dueFriend(81001, 0, { steal_plant_num: 2 })]);
  h.state.ownDue = h.clock.now + 9999; h.behavior.markOwnHarvestDueAt(h.state.ownDue);
  const worker = workerEntry(h); await worker.runUnifiedTick();
  await h.orchestrator.checkFriends({ onlySteal: true });
  assert.equal(h.state.composites.length, 0); assert.equal(h.state.visits.length, 0);
  h.state.ownDue = 0; h.behavior.markOwnHarvestDueAt(0); h.state.pause = 60000;
  await worker.runUnifiedTick();
  assert.equal(h.state.composites.length, 0); assert.equal(h.state.visits.length, 0);
});

test('existing quiet-hour help protection retains explicit steal path and quotas', async t => {
  const h = makeHarness(t); h.state.canOperate = false;
  seed(h, [dueFriend(81001, 0, { steal_plant_num: 1 })]);
  await h.orchestrator.checkFriends({ onlySteal: true });
  assert.equal(h.state.visits.length, 0, 'quota guard precedes cache visit');
  h.state.canOperate = true; h.state.enterMode = 'budget';
  await h.orchestrator.checkFriends({ onlySteal: true });
  assert.equal(h.state.visits.length, 1, 'due target still dispatches during active summary gate');
});

test('valid pre-enter reply is reused once and actual CheckCanOperate/batch per-land fallback preserved', async t => {
  const h = makeHarness(t); const now = h.clock.now;
  const lands = [1, 2].map(id => ({ id, plant: { id: 1, stealable: true, steal_num: 1, phases: [{ phase: 4 }] } }));
  h.state.analyzer = { stealable: [1, 2], stealableInfo: [{ landId: 1, name: '合成果实' }, { landId: 2, name: '合成果实' }] };
  h.state.stealHandler = (_gid, ids) => { if (ids.length > 1) throw new Error('expected batch competition'); return {}; };
  const tally = { steal: 0, water: 0, weed: 0, bug: 0, putBug: 0, putWeed: 0 };
  const result = await h.visit.visitFriendForSteal({ gid: 81001, name: '合成好友' }, tally, 80001, 'synthetic-budget-account',
    { preEnter: { gid: 81001, enteredAt: now, epochAtSend: 7, enterReply: { lands } } });
  assert.equal(h.state.visits.length, 0, 'no second Enter');
  assert.equal(h.state.attempts.filter(r => r.method === 'CheckCanOperate').length, 1);
  assert.deepEqual(h.state.harvests.map(r => r.lands), [[1, 2], [1], [2]]);
  assert.equal(tally.steal, 2); assert.equal(result.enterOutcome, 'reused'); assert.equal(result.enterEpoch, 7);
});

test('actual quiet-hour predicate blocks help and preserves cache steal while summary gate remains active', async t => {
  const h = makeHarness(t); h.state.quiet = true;
  await h.orchestrator.checkFriends({ onlyHelp: true });
  assert.equal(h.state.composites.length, 0);
  seed(h, [dueFriend(81001, 0, { steal_plant_num: 1 })]); h.state.enterMode = 'budget';
  await h.orchestrator.checkFriends({ onlySteal: true });
  assert.equal(h.state.visits.length, 1); assert.equal(h.state.composites.length, 1);
});

test('precise land wall clock survives missing and zero summary maturity and dispatches during gate', async t => {
  const h = makeHarness(t); const due = h.clock.now + 2000; const sec = h.clock.now / 1000;
  h.watch.inspectFriendLands(81001, '合成好友', [{ id: 1, plant: { id: 100, phases: [{ begin_time: sec - 100 }, { begin_time: sec + 2 }] } }]);
  const lands = h.watch.getFriendRipeSnapshot(81001); assert.equal(lands.dueAt, due); assert.equal(lands.source, 'lands');
  seed(h, [{ gid: 81001, name: '合成好友', plant: {} }]);
  assert.equal(h.watch.getFriendRipeSnapshot(81001).dueAt, due);
  seed(h, [dueFriend(81001, 0)]);
  assert.equal(h.watch.getFriendRipeSnapshot(81001).dueAt, due);
  await h.orchestrator.checkFriends({ onlySteal: true }); h.state.enterMode = 'budget';
  h.clock.now = due; await h.orchestrator.checkFriends({ onlySteal: true });
  assert.ok(h.state.visits.some(r => r.gid === 81001 && r.at === due));
  assert.equal(h.state.composites.length, 1);
});

for (const mode of ['prearm', 'hot']) test(`actual ${  mode.toUpperCase()  } watcher dispatch adds zero summary wait during refusal gate`, async t => {
  const h = makeHarness(t);
  await h.orchestrator.checkFriends({ onlySteal: true }); const gate = stateOf(h).gate;
  h.watch.watchFriend(81001, '合成好友', { now: h.clock.now, ripeAt: h.clock.now + 1000, mode, reason: 'synthetic trusted evidence' });
  const due = h.watch.getNextWatchDueAt();
  assert.ok(due > 0 && due <= gate.blockedUntil);
  h.state.enterMode = 'budget'; h.clock.now = due;
  await h.orchestrator.checkFriends({ onlySteal: true });
  assert.equal(h.state.visits.length, 1); assert.equal(h.state.visits[0].at, due);
  assert.equal(h.state.composites.length, 1);
  assert.deepEqual(stateOf(h).gate, gate);
});

test('actual visit retryNeeded retains original 90-second evidence and future land observation updates wall clock', async t => {
  const h = makeHarness(t); const sec = h.clock.now / 1000;
  seed(h, [dueFriend(81001, 0, { steal_plant_num: 1 })]); const first = stateOf(h).actionCache[0];
  h.state.analyzer = { stealable: [1], stealableInfo: [{ landId: 1, name: '合成果实' }] };
  h.state.stealHandler = () => { throw new Error('expected competition'); };
  const enter = deferred(); enter.resolve({ lands: [{ id: 1, plant: { id: 100, stealable: true, steal_num: 1, phases: [{ begin_time: sec - 10 }, { begin_time: sec - 1 }] } }] });
  h.state.enterGate = enter;
  await h.orchestrator.checkFriends({ onlySteal: true });
  assert.equal(stateOf(h).actionCache[0].stealableSince, first.stealableSince);
  h.clock.now += 1000; await h.orchestrator.checkFriends({ onlySteal: true });
  assert.equal(stateOf(h).actionCache[0].stealableSince, first.stealableSince, 'retry failure never renews grace');
  assert.equal(h.state.harvests.length, 4, 'each attempt preserves failed batch and per-land fallback');
  const future = deferred(); future.resolve({ lands: [{ id: 1, plant: { id: 100, phases: [{ begin_time: sec - 10 }, { begin_time: sec + 600 }] } }] });
  h.state.enterGate = future; h.state.analyzer = null;
  await h.orchestrator.checkFriends({ onlySteal: true });
  assert.equal(stateOf(h).actionCache[0].dueAt, (sec + 600) * 1000);
  assert.equal(stateOf(h).actionCache[0].stealableSince, 0);
});

test('real own absolute timer chain starts harvest at maturity plus 30-80ms despite active summary gate', async t => {
  const h = makeHarness(t); await h.orchestrator.checkFriends({ onlySteal: true });
  const summaryCalls = h.state.composites.length; const start = h.clock.now;
  h.state.ownDue = start + 2000;
  const src = fs.readFileSync(path.join(root, 'core/src/core/worker.js'), 'utf8');
  const from = src.indexOf('const OWN_HARVEST_RESERVE_MS = 10_000;');
  const to = src.indexOf('// ==================== 好友成熟哨兵', from);
  assert.ok(from >= 0 && to > from);
  const tasks = new Map(); const calls = [];
  const sandbox = { Date, Math, ...h.behavior, loginReady: true, friendSyncPaused: false,
    workerScheduler: { clear: key => tasks.delete(key), has: key => tasks.has(key), setTimeoutTask: (key, delay, fn) => tasks.set(key, { delay, fn }) },
    getAutomation: () => h.state.automation, ownHarvestDueAt: () => h.state.ownDue,
    pauseRemainMsNow: () => h.state.pause, getWs: () => ({ readyState: 1 }), log: () => {}, armStealWake: () => {},
    harvestOwnAtMaturity: async () => { calls.push(h.clock.now); h.state.ownDue = 0; return { harvestedCount: 1 }; },
  };
  const entry = vm.runInNewContext(`${src.slice(from, to)  }\n;({armOwnHarvestGuard,clearOwnHarvestGuard})`, sandbox, { filename: 'worker.js#actual-own-timer' });
  try {
    entry.armOwnHarvestGuard(); const task = tasks.get('own_harvest_guard');
    assert.ok(task.delay >= 2030 && task.delay <= 2080);
    h.clock.now = start + task.delay; tasks.delete('own_harvest_guard'); await task.fn();
    assert.deepEqual(calls, [h.clock.now]); assert.equal(h.state.composites.length, summaryCalls);
    assert.equal(tasks.size, 0, 'completed timer chain leaves no task');
  } finally { entry.clearOwnHarvestGuard(true); tasks.clear(); }
});

function realGovernedSender(governor, state) {
  const src = fs.readFileSync(path.join(root, 'core/src/utils/network.js'), 'utf8');
  const from = src.indexOf('function sendMsgAsync('); const to = src.indexOf('// ============ 消息处理', from);
  assert.ok(from > 0 && to > from);
  const timers = new Map();
  const sandbox = { requestGovernor: governor, GOVERNED_BUDGET_REASONS: new Set(['budget_total', 'budget_method']),
    ws: { readyState: 1 }, WebSocket: { OPEN: 1 }, pendingCallbacks: new Map(), clientSeq: 1, Date,
    networkScheduler: { setTimeoutTask: (key, delay, fn) => timers.set(key, { delay, fn }), clear: key => timers.delete(key) },
    isConnected: () => true, sendMsg: async (_service, method, _body, callback) => {
      state.actualSends.push(method); callback(null, Buffer.alloc(0), {}); return true;
    },
  };
  const send = vm.runInNewContext(`${src.slice(from, to)  }\n;sendMsgAsync`, sandbox, { filename: 'network.js#actual-governor-constructor' });
  return { send, timers };
}

test('real governor and sendMsgAsync marker constructor preserve method/total hard budgets, emergency window and normal slowdown', async t => {
  const h = makeHarness(t); const governor = require('../src/services/request-governor');
  governor.resetForTest(); t.after(() => governor.resetForTest());
  const state = { actualSends: [] }; const sender = realGovernedSender(governor, state);
  for (let i = 0; i < governor.PER_METHOD_LIMIT; i++) governor.recordSent('gamepb.friendpb.FriendService', 'GetAll', true, h.clock.now);
  let err; try { await sender.send('gamepb.friendpb.FriendService', 'GetAll', Buffer.alloc(0)); } catch (error) { err = error; }
  assert.equal(err.isGovernedRejection, true); assert.equal(err.governedReason, 'budget_method');
  assert.deepEqual(h.aggregation.getGovernedRejectionInfo(err), { reason: 'budget_method' });
  assert.equal(state.actualSends.length, 0); assert.equal(sender.timers.size, 0);
  governor.resetForTest();
  for (let i = 0; i < governor.TOTAL_LIMIT; i++) governor.recordSent('synthetic.Service', `Method${  i}`, true, h.clock.now);
  try { await sender.send('gamepb.friendpb.FriendService', 'GetAll', Buffer.alloc(0)); } catch (error) { err = error; }
  assert.equal(err.governedReason, 'budget_total');
  assert.deepEqual(h.aggregation.getGovernedRejectionInfo(err), { reason: 'budget_total' });
  assert.equal(state.actualSends.length, 0);
  governor.setUrgentMode(true, h.clock.now + 10000);
  await sender.send('gamepb.visitpb.VisitService', 'Enter', Buffer.alloc(0));
  assert.deepEqual(state.actualSends, ['Enter']);
  await assert.rejects(sender.send('gamepb.friendpb.FriendService', 'GetAll', Buffer.alloc(0)), /budget_total/);
  assert.deepEqual(state.actualSends, ['Enter'], 'urgent allowance belongs only to established target methods');
  assert.equal(sender.timers.size, 0);
  governor.resetForTest();
  for (let i = 0; i < 15; i++) governor.recordSent('synthetic.Service', 'Flaky', false, h.clock.now + i * 10);
  assert.equal(governor.getBreakerState(h.clock.now + 200).active, true);
  assert.equal(governor.getBreakerState(h.clock.now + 200).hardBlocked, false);
  assert.equal(governor.checkRequest('gamepb.visitpb.VisitService', 'Enter', h.clock.now + 200).allowed, true);
  assert.equal(governor.checkRequest('gamepb.userpb.UserService', 'Heartbeat', h.clock.now + 200).allowed, true);
});

test('unexpected ordinary cached visitor throw reaches original outer warning and aborts round without gate mutation', async t => {
  const h = makeHarness(t); await h.orchestrator.checkFriends({ onlySteal: true });
  const gate = stateOf(h).gate;
  seed(h, [dueFriend(81001, 0, { steal_plant_num: 1 })]);
  const reply = deferred(); reply.resolve({ lands: [{ id: 1, plant: { id: 100, phases: [] } }] }); h.state.enterGate = reply;
  h.state.analyzer = { get stealable() { throw new Error('cached unexpected ordinary exception'); } };
  const result = await h.orchestrator.checkFriends({ onlySteal: true });
  assert.equal(result, false); assert.equal(h.state.visits.length, 1); assert.equal(h.state.composites.length, 1);
  assert.deepEqual(stateOf(h).gate, gate);
  assert.ok(h.state.logs.some(row => row.warn && row.message.includes('cached unexpected ordinary exception')));
  assert.equal(stateOf(h).checkingPlaceholder, null);
});

test('fixture cleanup runs after a deliberate body failure and restores all real loop resources and source fingerprint', async t => {
  const before = fingerprint(); const h = makeHarness(t);
  await assert.rejects((async () => {
    try { h.orchestrator.startFriendCheckLoop({ externalScheduler: true }); throw new Error('deliberate fixture body failure'); }
    finally { h.close(); }
  })(), /deliberate fixture body failure/);
  assert.equal(liveHarnesses.has(h), false); assert.equal(h.orchestrator.isFriendVisitBusy(), false);
  assert.deepEqual(fingerprint(), before);
});
