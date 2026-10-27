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

// No aggregation or test-only export is required for these old-code counterexamples.
test('existing steal visit entry aggregates a same-category burst without dropping attempts or settlement', async t => {
  const h = makeHarness(t); h.state.enterMode = 'budget';
  const tally = { steal: 0, water: 0, weed: 0, bug: 0, putBug: 0, putWeed: 0 };
  const results = [];
  for (let i = 0; i < 20; i++) {
    results.push(await h.visit.visitFriendForSteal({ gid: 81001, name: '合成好友' }, tally, 80001, 'synthetic-budget-account'));
    h.clock.now += 100;
  }
  assert.equal(h.state.visits.length, 20, 'aggregation changes no Enter attempt');
  assert.ok(results.every(r => r.entered === false), 'all failed visits settle honestly');
  assert.equal(h.state.logs.filter(r => r.warn).length, 1, 'same signature emits one initial warning');
});

test('existing QQ batch entry aggregates independent batch refusals while retaining fallback order', async t => {
  const h = makeHarness(t, { platform: 'qq' });
  h.state.known = Array.from({ length: 70 }, (_, i) => 82001 + i);
  for (let i = 0; i < 4; i++) { await assert.rejects(h.api.getAllFriends(), /SyncAll:.*GetAll:/); h.clock.now += 100; }
  assert.equal(h.state.attempts.length, 16, 'four composites preserve two batches and two legacy attempts each');
  assert.deepEqual(h.state.attempts.map(r => r.method), Array.from({ length: 4 }, () => ['GetGameFriends', 'GetGameFriends', 'SyncAll', 'GetAll']).flat());
  assert.equal(h.state.logs.filter(r => r.warn).length, 1, 'QQ batch refusals share one bounded signature');
});

test('baseline fixture guard proves zero invalid primitives and actual valid write', () => {
  const before = { ...primitiveCounts };
  assert.throws(() => writeFixture('../forbidden.txt', 'no'), /escape/);
  assert.deepEqual(primitiveCounts, before);
  const link = guarded(path.join(fixture, 'baseline-escape-link'), fixture);
  primitiveCounts.write++; fs.symlinkSync(root, link);
  const linked = { ...primitiveCounts };
  assert.throws(() => writeFixture('baseline-escape-link/forbidden.txt', 'no'), /symlink/);
  assert.deepEqual(primitiveCounts, linked);
  assert.equal(fs.readFileSync(writeFixture('legal/proof.txt', 'yes'), 'utf8'), 'yes');
  assert.equal(primitiveCounts.create, before.create + 1); assert.equal(primitiveCounts.write, before.write + 2);
});
