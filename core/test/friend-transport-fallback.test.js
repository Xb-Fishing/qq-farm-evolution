'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto'), vm = require('node:vm');
const temp = fs.realpathSync(os.tmpdir()), repo = path.resolve(__dirname, '../..');
assert.ok(temp !== repo && !temp.startsWith(repo + path.sep));
const prefix = path.resolve(temp, 'friend-transport-'); assert.equal(path.dirname(prefix), temp);
const data = fs.mkdtempSync(prefix); process.env.FARM_DATA_DIR = data;
const files = ['../src/services/friend-visit.js', '../src/services/friend-api.js'].map(f => path.resolve(__dirname, f));
const fingerprints = () => files.map(f => [fs.statSync(f).mode, crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')]);
const original = fingerprints();
test.after(() => { assert.deepEqual(fingerprints(), original); fs.rmSync(data, { recursive: true, force: true }); });
const biz = code => Object.assign(new Error('synthetic refusal'), { isServerBusinessError: true, serverErrorCode: code });
const transport = kind => Object.assign(new Error('synthetic failure'), kind === 'budget' ? { isGovernedRejection: true, governedReason: 'budget_total' } : kind === 'epoch' ? { code: 'SESSION_EPOCH_RETIRED' } : {});
function fixture(outcomes = [], flags = {}) {
  const calls = [], records = [], logs = [], saved = new Map();
  let lands = [11, 12, 13], entered = 0;
  const install = (name, exports) => { const file = require.resolve(name); if (!saved.has(file)) saved.set(file, require.cache[file]); require.cache[file] = { id: file, filename: file, loaded: true, exports }; };
  const utils = { toNum: n => Number(n) || 0, log: (...args) => { if (flags.logThrows && args[2]?.event === 'friend_visit_failure') throw Error('synthetic diagnostic sink'); logs.push(args); }, logWarn() {}, randomDelay: async () => {}, sleep: async () => {} };
  install('../src/utils/utils', utils);
  install('../src/config/config', { PlantPhase: { MATURE: 4 } });
  install('../src/models/store', { getPlantBlacklist: () => [], isAutomationOn: key => (key === 'friend_steal' && flags.steal !== false) || flags.help && key === 'friend_help' || flags.bad && key === 'friend_bad', getPauseRemainMs: () => 0 });
  install('../src/utils/network', { getUserState: () => ({ gid: 7 }) });
  install('../src/services/governed-warn-aggregation', { getGovernedRejectionInfo: () => null, getGovernedWarnLifecycleSeq: () => 1, noteGovernedWarn: () => ({ handled: false }) });
  install('../src/utils/behavior', { stealIsDue: () => false });
  install('../src/services/stats', { recordOperation: (...x) => records.push(x) });
  install('../src/services/daily-events', { recordEvent() {} });
  install('../src/services/warehouse', { sellAllFruits: async () => calls.push('sell') });
  install('../src/services/friend-api', {
    enterFriendFarm: async () => { entered++; calls.push('enter'); return { lands: lands.map(id => ({ id, plant: { id: 40001, stealable: true, phases: [{ phase: 4 }], steal_num: 3 } })) }; },
    leaveFriendFarm: async () => calls.push('leave'), checkCanOperateRemote: async () => { calls.push('precheck'); return flags.deferred ? { canOperate: false, canStealNum: 0, deferred: true } : { canOperate: true, canStealNum: 0 }; }, handleFriendEnterError: () => ({ handled: false }),
  });
  install('../src/services/fertilizer-watch', { inspectFriendLands: () => ({ ripeAt: 0 }), unwatchFriend() {}, isPriorityGid: () => false });
  install('../src/services/friend-activity', { noteEnterPresence: () => ({ onlineEdge: false }) });
  install('../src/services/farm-land-analyzer', { getCurrentPhase: () => ({ phase: 4 }) });
  install('../src/services/friend-land-analyzer', { analyzeFriendLands: () => ({ stealable: [...lands], stealableInfo: lands.map(landId => ({ landId, name: 'synthetic crop' })), needWeed: [31], needBug: [32], needWater: [33], canPutBug: [34], canPutWeed: [35] }) });
  const write = async (_gid, ids) => { calls.push([...ids]); const value = outcomes.shift(); if (value instanceof Error) throw value; if (value?.then) return value; return value || { qty: ids.length * 2 }; };
  install('../src/services/friend-operation-limits', { stealHarvest: write, sumHarvestItemCount: r => ({ total: r.qty, detail: 'synthetic crop' }), getCanGetHelpExp: () => true, setCanGetHelpExp() {}, canGetExpByCandidates: () => true,
    helpWeed: async () => { calls.push('help'); if (flags.helpError) throw flags.helpError; }, helpWater: async () => { calls.push('help'); }, helpInsecticide: async () => { calls.push('help'); }, getBadRemainingTimes: () => 20, getRemainingTimes: () => 20, BAD_DAILY_LIMIT: 20,
    putInsectsDetailed: async () => { calls.push('bad'); return { ok: 1 }; }, putWeedsDetailed: async () => { calls.push('bad'); return { ok: 1 }; } });
  const source = require.resolve('../src/services/friend-visit'); saved.set(source, require.cache[source]); delete require.cache[source]; const service = require(source);
  const tally = { steal: 0, weed: 0, bug: 0, water: 0, putBug: 0, putWeed: 0 };
  return { service, tally, calls, records, logs, setLands: ids => { lands = ids; }, get entered() { return entered; },
    run: mode => service[mode]({ gid: 42, name: 'synthetic friend' }, tally, 7, 'synthetic-owner'),
    restore() { for (const [file, previous] of saved) { if (previous) require.cache[file] = previous; else delete require.cache[file]; } } };
}
for (const mode of ['visitFriend', 'visitFriendForSteal']) {
  test(`${mode}: transport/epoch/budget batch failure never replays singles or advances other writes`, async () => {
    for (const kind of ['timeout', 'epoch', 'budget']) {
      const h = fixture([transport(kind)], { help: true, bad: true });
      try { const result = await h.run(mode); assert.deepEqual(h.calls.filter(Array.isArray), [[11, 12, 13]]); assert.equal(result.retryNeeded, true); assert.equal(h.tally.steal, 0); assert.ok(!h.calls.includes('help') && !h.calls.includes('bad')); assert.equal(h.calls.at(-1), 'leave'); } finally { h.restore(); }
    }
  });
  test(`${mode}: confirmed business fallback continues contention, partial transport retains accounting and due`, async () => {
    const h = fixture([biz(12345), { qty: 4 }, transport('timeout')], { help: true, bad: true });
    try {
      const result = await h.run(mode); assert.deepEqual(h.calls.filter(Array.isArray), [[11, 12, 13], [11], [12]]); assert.equal(result.retryNeeded, true); assert.equal(result.acted, true); assert.equal(h.tally.steal, 1); assert.deepEqual(h.records, [['steal', 4]]); assert.ok(!h.calls.includes('help') && !h.calls.includes('bad'));
      // The existing due result consumer must preserve both evidence caches.
      const source = fs.readFileSync(path.resolve(__dirname, '../src/services/friend-orchestrator.js'), 'utf8');
      const extract = name => { const a = source.indexOf(`function ${name}(`), b = source.indexOf('\n}\n', a); assert.ok(a >= 0 && b > a); return source.slice(a, b + 2); };
      const due = new Map([[42, 100]]), action = new Map([[42, { dueAt: 100 }]]);
      const sandbox = { friendReadLifecycleSeq: 1, toNum: Number, Date, friendSummaryDueByGid: due, summaryDueActionCache: action, recomputeFriendSummaryClocks() {}, getWatchlistFriendGids: () => [], process: { env: {} }, watchlistPollRipeAt: new Map(), watchlistPollNextAt: new Map(), nextWatchlistPollDelayMs: () => 1 };
      vm.runInNewContext(extract('settleSummaryDueActionCacheAfterVisit') + '\n' + extract('applyStealVisitResult') + '\nthis.apply=applyStealVisitResult;', sandbox);
      sandbox.apply(42, result, 100); assert.equal(due.has(42), true); assert.equal(action.has(42), true);
      h.calls.length = 0; h.setLands([12, 13]); const recovered = await h.run(mode);
      assert.equal(h.entered, 2); assert.deepEqual(h.calls.filter(Array.isArray), [[12, 13]]); assert.equal(recovered.acted, true); assert.equal(h.records.filter(x => x[0] === 'steal').length, 2); assert.equal(h.tally.steal, 3);
    } finally { h.restore(); }
  });
  test(`${mode}: business single refusal preserves ordinary fallback; malformed markers stop`, async () => {
    const h = fixture([biz(12345), biz(12346), { qty: 2 }, { qty: 2 }]);
    try { const result = await h.run(mode); assert.deepEqual(h.calls.filter(Array.isArray), [[11, 12, 13], [11], [12], [13]]); assert.equal(h.tally.steal, 2); assert.notEqual(result.retryNeeded, true); } finally { h.restore(); }
    for (const error of [Object.assign(Error('synthetic'), { isServerBusinessError: 'true', serverErrorCode: 1 }), biz(0), biz('0x10'), Object.assign(biz(1), { unknown: true })]) {
      const bad = fixture([error]); try { await bad.run(mode); assert.equal(bad.calls.filter(Array.isArray).length, 1); } finally { bad.restore(); }
    }
  });
  test(`${mode}: deferred precheck performs zero writes, keeps due and cleanup`, async () => { const h = fixture([], { deferred: true, help: true, bad: true }); try { const result = await h.run(mode); assert.equal(result.retryNeeded, true); assert.equal(h.calls.filter(Array.isArray).length, 0); assert.deepEqual(h.calls, ['enter', 'precheck', 'leave']); } finally { h.restore(); } });
}
test('anonymous diagnostic failures are bounded, safe, and do not suppress confirmed business fallback', async () => {
  const h = fixture([biz(12345), {}, transport('timeout')]);
  try { await h.run('visitFriend'); const rows = h.logs.filter(x => x[2]?.event === 'friend_visit_failure').map(x => x[2]); assert.ok(rows.length > 0 && rows.length <= 3); assert.equal(new Set(rows.map(x => x.visitTrace)).size, 1); assert.match(rows[0].targetRef, /^[0-9a-f]{16}$/); assert.doesNotMatch(JSON.stringify(rows), /synthetic friend|gid|synthetic failure|stack/); } finally { h.restore(); }
});

test('diagnostic sink failure cannot stop confirmed successes; per-process diagnostic volume stays bounded', async () => {
  const sink = fixture([biz(1), { qty: 2 }, { qty: 2 }, { qty: 2 }], { logThrows: true });
  try { assert.equal((await sink.run('visitFriend')).acted, true); assert.equal(sink.tally.steal, 3); } finally { sink.restore(); }
  const bounded = fixture(Array.from({ length: 150 }, () => transport('timeout')));
  try { for (let i = 0; i < 150; i++) await bounded.run('visitFriend'); assert.equal(bounded.logs.filter(x => x[2]?.event === 'friend_visit_failure').length, 128); assert.equal(bounded.calls.filter(Array.isArray).length, 150); } finally { bounded.restore(); }
});

test('generic visit stops remaining help and bad writes after a non-business help failure', async () => {
 const h = fixture([], { steal: false, help: true, bad: true, helpError: transport('timeout') });
 try { const result = await h.run('visitFriend'); assert.equal(result.retryNeeded, true); assert.deepEqual(h.calls, ['enter', 'precheck', 'help', 'leave']); } finally { h.restore(); }
});

test('help-only visit stops at the same non-business batch boundary and retains fresh-read scheduling', async () => {
 const h = fixture([], { steal: false, help: true, bad: true, helpError: transport('timeout') });
 try { const result = await h.run('visitFriendForHelp'); assert.equal(result.retryNeeded, true); assert.deepEqual(h.calls, ['enter', 'precheck', 'help', 'leave']); } finally { h.restore(); }
});
