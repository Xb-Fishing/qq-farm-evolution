const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const parent = fs.realpathSync(os.tmpdir());
const prefix = path.resolve(parent, 'farm-update-entry-'); assert.equal(path.dirname(prefix), parent);
const root = fs.mkdtempSync(prefix); process.env.FARM_DATA_DIR = root; process.env.FARM_PRIVATE_CONFIG_FILE = path.join(root, 'private-config.json');
const digest = require('../src/services/game-update-digest');
const HEAD = 'a'.repeat(40); const TIME = Date.parse('2026-02-09T16:15:00Z'); const DAY = '2026-02-10';
const source = path.resolve(__dirname, '../src/services/activity-evolver.js'); const sourceRequire = createRequire(source);
const original = crypto.createHash('sha256').update(fs.readFileSync(source)).digest('hex');
test.after(() => { assert.equal(crypto.createHash('sha256').update(fs.readFileSync(source)).digest('hex'), original); fs.rmSync(root, { recursive: true, force: true }); });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function fixture(options = {}) {
  const dir = path.resolve(root, crypto.randomUUID()); assert.ok(dir.startsWith(root + path.sep)); fs.mkdirSync(dir, { mode: 0o700 });
  const tasks = new Map(); const launches = []; const notifications = []; const clock = { now: TIME };
  class Clock extends Date { constructor(...args) { super(...(args.length ? args : [clock.now])); } static now() { return clock.now; } }
  const scheduler = { setTimeoutTask: (name, delay, callback) => { tasks.set(name, { callback, delay }); }, clear: name => tasks.delete(name), clearAll: () => tasks.clear() };
  const module = { exports: {} };
  vm.runInNewContext(`${fs.readFileSync(source, 'utf8')  }\nmodule.exports.access={readState,writeState,prepareDailyEvolution,pendingGameUpdateEvent,captureReviewBatch,capturedCombinedDaily,configure:value=>{deps=value;},setRunning:value=>{running=value;}};`, {
    module, exports: module.exports, __dirname: path.dirname(source), __filename: source, Date: Clock, Buffer, URL, console,
    process: { ...process, env: { FARM_DATA_DIR: dir, FARM_PRIVATE_CONFIG_FILE: path.join(dir, 'private-config.json') } },
    require: name => {
      if (name === '../config/runtime-paths') return { getDataFile: file => path.join(dir, file) };
      if (name === './logger') return { createModuleLogger: () => ({ info() {}, warn() {}, error() {} }) };
      if (name === './scheduler') return { createScheduler: () => scheduler, getSchedulerRegistrySnapshot: () => ({ schedulers: [] }) };
      if (name === './feishu-notify') return { sendFeishuText: async (...args) => notifications.push(args), isFeishuWebhook: () => false };
      if (name === 'node:child_process') return { ...sourceRequire(name), execSync: () => HEAD, execFileSync: (bin, args) => {
        if (bin === 'git' && args[0] === 'rev-parse') return HEAD;
        if (bin === 'git' && args[0] === 'status') return '';
        throw new Error('Unexpected external command');
      }, spawn: () => { throw new Error('Unexpected actual Agent spawn'); } };
      return sourceRequire(name);
    },
  }, { filename: source });
  const access = module.exports.access;
  access.writeState({ status: 'idle', evolutionEnabled: true, autonomousEvolutionEnabled: options.autonomous === true,
    lastAutomaticEvolveDate: options.dailyUnused ? '' : DAY, lastRunAt: 0, lastRunAutomatic: false, commit: '' });
  let calls = 0; let launchResult = { ok: true };
  const deps = { now: () => clock.now, worktreeChanges: () => '', readLatestReport: () => null,
    prepareGameUpdateReview: async () => { calls++; return options.prepare ? options.prepare() : { status: 'partial_coverage' }; },
    launchEvolution: (task, payload) => {
      launches.push({ task, payload, persisted: access.readState() });
      if (!launchResult.ok) {
        const value = access.readState(); value.status = 'failed'; value.autonomy.originalPrompt = 'synthetic captured original scope'; access.writeState(value);
      }
      return launchResult;
    } };
  return { service: module.exports, access, dir, tasks, launches, notifications, clock,
    reads: () => calls, start: () => module.exports.startActivityEvolver(deps), configure: () => access.configure(deps),
    setLaunchResult: result => { launchResult = result; },
    add: (kind = 'announcements') => digest.recordUpdateDigest(dir, { scannedAt: clock.now,
      online: { gameUpdateEvidence: { sources: { [kind]: { status: 'ok', factsHash: 'b'.repeat(64) } } } } }, 'synthetic') };
}

test('actual daily callback waits for preparation, coalesces same-day requests and consumes quota only at launch', async () => {
  const gate = deferred(); const f = fixture({ dailyUnused: true, prepare: () => gate.promise }); f.start();
  const pending = f.tasks.get('daily_evolution').callback(); await Promise.resolve();
  assert.equal(f.reads(), 1); assert.equal(f.launches.length, 0); assert.equal(f.access.readState().lastAutomaticEvolveDate, '');
  const duplicate = f.service.prepareDailyEvolution(DAY); gate.resolve({ status: 'partial_coverage' }); await Promise.all([pending, duplicate]);
  assert.equal(f.launches.length, 1); assert.equal(f.launches[0].payload.automatic, true); assert.equal(f.launches[0].payload.combinedDaily, true);
  assert.equal(f.launches[0].persisted.lastAutomaticEvolveDate, DAY); assert.equal(f.reads(), 1);
});
test('switching evolution off and back on invalidates the old awaited preparation without spending its day', async () => {
  const gate = deferred(); const f = fixture({ dailyUnused: true, prepare: () => gate.promise }); f.start();
  const pending = f.tasks.get('daily_evolution').callback(); await Promise.resolve();
  f.service.setEvolutionEnabled(false); f.service.setEvolutionEnabled(true); gate.resolve({ status: 'partial_coverage' }); await pending;
  assert.equal(f.launches.length, 0); assert.equal(f.access.readState().lastAutomaticEvolveDate, '');
});
test('startup catchup stops before reads when disabled, including its previously registered callback', async () => {
  const f = fixture({ dailyUnused: true }); f.start(); const callback = f.tasks.get('daily_automatic_catchup').callback;
  f.service.setEvolutionEnabled(false); await callback(); assert.equal(f.reads(), 0); assert.equal(f.launches.length, 0);
});
test('non-activity bulletin event enters genuine automatic native path, independent of used daily quota', async () => {
  const f = fixture({ autonomous: true }); f.add(); f.start();
  await f.tasks.get('game_update_evolution_event').callback();
  assert.equal(f.launches.length, 1); assert.equal(f.launches[0].task, 'safety'); assert.equal(f.launches[0].payload.automatic, true);
  assert.equal(f.launches[0].payload.combinedDaily, false); assert.equal(f.launches[0].persisted.lastRunAutomatic, true);
  assert.equal(f.access.readState().lastAutomaticEvolveDate, DAY); assert.equal(digest.readUpdateDigest(f.dir).unreviewed.length, 1);
});
test('ordinary mail/growth progress stays available to daily review without spawning an independent code update', () => {
  const f = fixture({ autonomous: true }); f.add('emails'); f.start(); assert.equal(f.tasks.has('game_update_evolution_event'), false);
  assert.equal(digest.readUpdateDigest(f.dir).unreviewed.length, 1);
});
test('event preparation canceled by autonomous off/on cannot launch its old callback', async () => {
  const gate = deferred(); const f = fixture({ autonomous: true, prepare: () => gate.promise }); f.add(); f.start();
  const pending = f.tasks.get('game_update_evolution_event').callback(); await Promise.resolve();
  f.service.setAutonomousEvolution(false); f.service.setAutonomousEvolution(true); gate.resolve({ status: 'partial_coverage' }); await pending;
  assert.equal(f.launches.length, 0);
});
test('failed event retains automatic identity and native backoff rather than becoming an unrelated manual run', async () => {
  const f = fixture({ autonomous: true }); f.add(); f.start(); f.setLaunchResult({ ok: false, reason: 'synthetic_capacity' });
  await f.tasks.get('game_update_evolution_event').callback();
  const value = f.access.readState(); assert.equal(value.status, 'failed'); assert.equal(value.lastRunAutomatic, true);
  assert.equal(value.autonomy.originalPrompt, 'synthetic captured original scope'); assert.equal(digest.readUpdateDigest(f.dir).unreviewed.length, 1);
  const { planAutonomy } = require('../src/services/evolution-autonomy');
  const plan = planAutonomy(value, { now: TIME, gitHead: () => HEAD, worktreeFiles: () => [] }); assert.notEqual(plan.reason, 'manual-run');
});
test('already dispatched immutable event is not restarted even though its unreviewed facts remain', () => {
  const f = fixture({ autonomous: true }); f.add(); const batch = digest.captureUpdateBatch(f.dir);
  digest.markUpdateBatchDispatched(f.dir, batch, 'synthetic-native-run'); f.start();
  assert.equal(f.tasks.has('game_update_evolution_event'), false); assert.equal(digest.readUpdateDigest(f.dir).unreviewed.length, 1);
});

test('actual resume payload preserves the non-daily event bit through the real native task-identity matcher', () => {
  const f = fixture({ autonomous: true }); f.configure();
  const whole = fs.readFileSync(source, 'utf8'); const begin = whole.indexOf('const automaticPayload = {'); const end = whole.indexOf('\n    };', begin);
  assert.ok(begin >= 0 && end > begin); const expression = whole.slice(begin, end + 7).replace('const automaticPayload =', 'result =');
  const state = { combinedDaily: false, gameUpdateEventFingerprint: 'b'.repeat(64) }; const scope = { state, originalTask: 'safety', autonomy: { originalPrompt: 'original-scope', preferDiagnosis: false }, capturedPlan: null, usableReport: false, cachedReport: null, capturedCombinedDaily: f.access.capturedCombinedDaily };
  vm.runInNewContext(expression, scope); assert.equal(scope.result.combinedDaily, false);
  const native = fs.readFileSync(path.resolve(__dirname, '../scripts/run-evolution-team.js'), 'utf8'); const start = native.indexOf('function assertTaskIdentityMatches('); const finish = native.indexOf('\nasync function main(', start);
  const bridge = { createTeamError: code => Object.assign(new Error(code), { code }) }; vm.runInNewContext(`${native.slice(start, finish)  }\nthis.check = assertTaskIdentityMatches;`, bridge);
  const recorded = { task: 'safety', promptDigest: 'original-scope', feedbackThroughAt: 10, activityPlanDigest: '', githubBatchDigest: '', quotaDate: DAY, automatic: true, combinedDaily: false };
  assert.doesNotThrow(() => bridge.check(recorded, { ...recorded, combinedDaily: scope.result.combinedDaily }));
  assert.throws(() => bridge.check(recorded, { ...recorded, combinedDaily: true }), error => error.code === 'invalid_decision');
  assert.equal(f.access.capturedCombinedDaily({ combinedDaily: true }, 'safety'), true);
  assert.equal(f.access.capturedCombinedDaily({ collaboration: { checkpoint: { taskIdentity: { combinedDaily: false } } } }, 'safety'), false);
});
test('legacy resume without an originally captured batch cannot adopt and clear later pending facts', () => {
  const f = fixture(); f.add(); f.configure(); const state = { status: 'no_change', dualAgentEnabled: true, mainAgent: 'codex', lastAgent: 'codex', commit: HEAD,
    autonomy: { originalPrompt: 'older task without a game batch' }, feedbackBatch: null,
    collaboration: { phase: 'complete', status: 'completed', decision: 'no_change', head: HEAD, reviewedBy: 'codex', feedbackReviewed: true, lessons: [] } };
  state.gameUpdateBatch = f.access.captureReviewBatch(state, true); assert.equal(state.gameUpdateBatch, null);
  f.service.settleDailyReview(state, { head: HEAD, feedback: { acknowledgeBatch: () => true }, saveLessons: () => {} });
  assert.equal(digest.readUpdateDigest(f.dir).unreviewed.length, 1);
  assert.equal(f.access.captureReviewBatch(state, false).entries.length, 1);
});
