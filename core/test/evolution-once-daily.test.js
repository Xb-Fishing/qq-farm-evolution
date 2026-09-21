const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

const importDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farm-once-daily-import-'));
process.env.FARM_DATA_DIR = importDataDir;
process.env.FARM_PRIVATE_CONFIG_FILE = path.join(importDataDir, 'private-config.json');
test.after(() => fs.rmSync(importDataDir, { recursive: true, force: true }));

const SOURCE_FILE = path.join(__dirname, '../src/services/activity-evolver.js');
const sourceRequire = createRequire(SOURCE_FILE);
const FIRST_DAY = '2026-02-10';
const FIRST_TIME = Date.parse('2026-02-09T16:15:00Z');
const HEAD = 'a'.repeat(40);

// Execute the actual service in a private VM. Only external effects and the clock
// are replaced; state normalization, persistence and scheduling remain real.
function harness(t, options = {}) {
    const dataDir = options.dataDir || fs.mkdtempSync(path.join(os.tmpdir(), 'farm-once-daily-'));
    if (!options.dataDir) t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    const clock = options.clock || { now: FIRST_TIME };
    const launches = [];
    const scheduled = [];
    const messages = [];
    let report = options.report || null;
    let launchResult = { ok: true };
    class Clock extends Date {
        constructor(...args) { super(...(args.length ? args : [clock.now])); }
        static now() { return clock.now; }
    }
    const fakeScheduler = {
        setTimeoutTask: (name, delay, callback) => scheduled.push({ name, delay, callback }),
        clear: () => {},
        clearAll: () => {},
    };
    const logger = { info: message => messages.push(message), warn: message => messages.push(message), error: message => messages.push(message) };
    const childProcess = sourceRequire('node:child_process');
    const module = { exports: {} };
    const context = vm.createContext({
        module, exports: module.exports, __dirname: path.dirname(SOURCE_FILE), __filename: SOURCE_FILE,
        Buffer, Date: Clock, URL, console,
        process: { ...process, env: { FARM_DATA_DIR: dataDir, FARM_PRIVATE_CONFIG_FILE: path.join(dataDir, 'private-config.json') } },
        require: (name) => {
            if (name === '../config/runtime-paths') return { getDataFile: file => path.join(dataDir, file) };
            if (name === './logger') return { createModuleLogger: () => logger };
            if (name === './scheduler') return { createScheduler: () => fakeScheduler, getSchedulerRegistrySnapshot: () => [] };
            if (name === './feishu-notify') return { sendFeishuText: async () => {}, isFeishuWebhook: () => false };
            if (name === 'node:child_process') return {
                ...childProcess,
                execSync: command => command === 'git rev-parse HEAD' ? HEAD : '',
                execFileSync: () => { throw new Error('Unexpected external command'); },
                spawn: () => { throw new Error('Unexpected Agent launch'); },
            };
            return sourceRequire(name);
        },
    });
    vm.runInContext(`${fs.readFileSync(SOURCE_FILE, 'utf8')}
module.exports.testAccess = {
    attemptDailyEvolution, isAutomaticQuotaUsed, buildCachedActivityContext,
    settleCombinedActivityMemory, getLocalDateKey, normalizePersistedState,
    checkAndMaybeEvolve, readState, writeState,
    configure: value => { deps = value; },
    setRunning: value => { running = value; },
};`, context, { filename: SOURCE_FILE });
    const service = module.exports.testAccess;
    if (options.state) service.writeState(options.state);
    service.configure({
        now: () => clock.now,
        worktreeChanges: () => '',
        readLatestReport: () => report,
        launchEvolution: (task, payload) => {
            launches.push({ task, payload: JSON.parse(JSON.stringify(payload)), persisted: JSON.parse(JSON.stringify(service.readState())) });
            if (!launchResult.ok) {
                const state = service.readState();
                state.status = 'failed';
                state.lastRunAt = clock.now;
                state.lastSafetyEvolveDate = '';
                service.writeState(state);
            }
            return launchResult;
        },
    });
    const plain = value => JSON.parse(JSON.stringify(value));
    return {
        dataDir, clock, service, launches, scheduled, messages,
        state: () => plain(service.readState()),
        save: value => service.writeState(value),
        attempt: (dateKey = service.getLocalDateKey(clock.now)) => service.attemptDailyEvolution(dateKey),
        setReport: value => { report = value; },
        setLaunchResult: value => { launchResult = value; },
    };
}

test('failed automatic launch consumes the persisted day before launch and is not retried after restart', (t) => {
    const f = harness(t);
    f.setLaunchResult({ ok: false, reason: 'fixture_failure' });
    assert.equal(f.attempt().ok, false);
    assert.equal(f.launches.length, 1);
    assert.equal(f.launches[0].persisted.lastAutomaticEvolveDate, FIRST_DAY);
    assert.equal(f.state().status, 'failed');
    assert.equal(f.state().lastAutomaticEvolveDate, FIRST_DAY);
    f.attempt();
    assert.equal(f.launches.length, 1);
    assert.equal(f.scheduled.length, 0, 'failure must not schedule another automatic Agent run');
    const restarted = harness(t, { dataDir: f.dataDir, clock: f.clock });
    restarted.attempt();
    assert.equal(restarted.launches.length, 0);
    assert.equal(restarted.state().lastAutomaticEvolveDate, FIRST_DAY);
});

test('automatic quota reopens at the next Beijing midnight and ignores an expired callback date', (t) => {
    const f = harness(t);
    f.attempt();
    f.clock.now = Date.parse('2026-02-10T15:59:59.999Z');
    assert.equal(f.service.getLocalDateKey(f.clock.now), FIRST_DAY);
    f.attempt();
    assert.equal(f.launches.length, 1);
    f.clock.now += 1;
    assert.equal(f.service.getLocalDateKey(f.clock.now), '2026-02-11');
    f.attempt(FIRST_DAY);
    assert.equal(f.launches.length, 1);
    f.attempt();
    assert.equal(f.launches.length, 2);
    assert.equal(f.state().lastAutomaticEvolveDate, '2026-02-11');
});

test('explicit manual dates and recent manual timestamps do not consume an unused automatic quota', (t) => {
    const f = harness(t, { state: {
        status: 'no_change', lastAutomaticEvolveDate: '', lastManualRunDate: FIRST_DAY,
        lastSafetyEvolveDate: FIRST_DAY, lastEvolveDate: FIRST_DAY, lastRunAt: FIRST_TIME,
    } });
    for (const lastManualRunDate of ['', '2026-02-09', FIRST_DAY]) {
        const explicitState = f.service.normalizePersistedState({
            lastAutomaticEvolveDate: '', lastManualRunDate,
            lastSafetyEvolveDate: FIRST_DAY, lastEvolveDate: FIRST_DAY, lastRunAt: FIRST_TIME,
        }, FIRST_TIME);
        assert.equal(f.service.isAutomaticQuotaUsed(explicitState, FIRST_DAY, FIRST_TIME), false,
            'an explicit automatic field must not infer quota from unrelated run timestamps');
    }
    assert.equal(f.service.isAutomaticQuotaUsed(f.state(), FIRST_DAY, FIRST_TIME), false);
    f.attempt();
    assert.equal(f.launches.length, 1);
    assert.equal(f.state().lastManualRunDate, FIRST_DAY);
    assert.equal(f.state().lastAutomaticEvolveDate, FIRST_DAY);
    const updated = f.state();
    updated.lastManualRunDate = FIRST_DAY;
    updated.lastRunAt += 1000;
    updated.lastSafetyEvolveDate = '';
    f.save(updated);
    f.attempt();
    assert.equal(f.launches.length, 1, 'a later manual run cannot erase the automatic quota');
});

test('legacy successful and failed runs migrate their historical date before later manual runs', (t) => {
    const f = harness(t);
    for (const legacy of [
        { status: 'no_change', lastSafetyEvolveDate: FIRST_DAY, lastRunAt: 0 },
        { status: 'failed', lastEvolveDate: FIRST_DAY, lastRunAt: 0 },
        { status: 'failed', lastSafetyEvolveDate: '', lastEvolveDate: '', lastRunAt: FIRST_TIME },
    ]) {
        const migrated = f.service.normalizePersistedState(legacy, FIRST_TIME);
        assert.equal(migrated.lastAutomaticEvolveDate, FIRST_DAY);
        migrated.lastManualRunDate = FIRST_DAY;
        migrated.lastRunAt = FIRST_TIME + 1;
        f.save(migrated);
        assert.equal(f.service.isAutomaticQuotaUsed(f.state(), FIRST_DAY, FIRST_TIME), true);
        f.attempt();
    }
    assert.equal(f.launches.length, 0);
});

test('scan callbacks only merge pending activity and never launch an Agent', (t) => {
    const f = harness(t, { state: { handledUnknownIds: [11], handledEndedIds: [21], lastAutomaticEvolveDate: FIRST_DAY } });
    const report = { status: 'ok', unknownActivityIds: [11, 12], endedActivityIds: [21, 22] };
    f.service.checkAndMaybeEvolve(report);
    assert.deepEqual(f.state().pendingActivity.newUnknown, [12]);
    assert.deepEqual(f.state().pendingActivity.newEnded, [22]);
    const persisted = fs.readFileSync(path.join(f.dataDir, 'activity-evolve-state.json'), 'utf8');
    f.service.checkAndMaybeEvolve(report);
    assert.equal(fs.readFileSync(path.join(f.dataDir, 'activity-evolve-state.json'), 'utf8'), persisted);
    assert.equal(f.launches.length, 0);
    assert.equal(f.scheduled.length, 0);
});

test('the single daily safety launch carries the cached activity plan and pending context', (t) => {
    const report = {
        status: 'ok', unknownActivityIds: [31], endedActivityIds: [41],
        online: { available: true, checkedActivityIds: [31, 32] },
    };
    const f = harness(t, { report, state: { lastAutomaticEvolveDate: '', pendingActivity: { newUnknown: [33], newEnded: [43], updatedAt: FIRST_TIME } } });
    f.attempt();
    f.attempt();
    assert.equal(f.launches.length, 1);
    const { task, payload } = f.launches[0];
    assert.equal(task, 'safety');
    assert.equal(payload.automatic, true);
    assert.equal(payload.combinedDaily, true);
    assert.deepEqual(payload.report, report);
    assert.deepEqual(payload.activityPlan.newUnknown, [31]);
    assert.deepEqual(payload.activityPlan.newEnded, [41]);
    assert.deepEqual(payload.activityPlan.reviewIds, [31, 32]);
    const context = f.service.buildCachedActivityContext({ activityPlan: payload.activityPlan, pendingActivity: f.state().pendingActivity, reportAvailable: true });
    assert.ok(context.includes('31') && context.includes('33') && context.includes('41') && context.includes('43'));
    assert.ok(context.includes(payload.activityPlan.fingerprint));
    assert.equal(f.scheduled.length, 0);
});

test('missing or unavailable activity reports still permit exactly one safety run without report retries', (t) => {
    for (const report of [null, { status: 'unavailable' }, { status: 'ok', online: { available: false } }]) {
        const f = harness(t, { report });
        f.attempt();
        f.attempt();
        assert.equal(f.launches.length, 1);
        assert.equal(f.launches[0].task, 'safety');
        assert.equal(f.launches[0].payload.combinedDaily, true);
        assert.equal(f.launches[0].payload.report, null);
        assert.equal(f.launches[0].payload.activityPlan, null);
        assert.equal(f.scheduled.length, 0);
        const context = f.service.buildCachedActivityContext({ reportAvailable: false });
        assert.ok(context.includes('不可用'));
        assert.ok(context.includes('不为了等待报告重试'));
    }
});

test('scans arriving during an active round survive settlement of only that rounds reviewed IDs', (t) => {
    const f = harness(t, { state: {
        lastAutomaticEvolveDate: FIRST_DAY, handledUnknownIds: [50], handledEndedIds: [60],
        pendingActivity: { newUnknown: [51], newEnded: [61], updatedAt: FIRST_TIME },
    } });
    f.service.setRunning(true);
    f.clock.now += 1000;
    f.service.checkAndMaybeEvolve({ status: 'ok', unknownActivityIds: [51, 52], endedActivityIds: [61, 62] });
    assert.deepEqual(f.state().pendingActivity.newUnknown, [51, 52]);
    assert.deepEqual(f.state().pendingActivity.newEnded, [61, 62]);
    const latest = f.state();
    const fingerprint = 'b'.repeat(64);
    f.service.settleCombinedActivityMemory(latest, { newUnknown: [51], newEnded: [61], fingerprint, head: HEAD });
    f.save(latest);
    assert.deepEqual(f.state().handledUnknownIds, [50, 51]);
    assert.deepEqual(f.state().handledEndedIds, [60, 61]);
    assert.deepEqual(f.state().pendingActivity.newUnknown, [52]);
    assert.deepEqual(f.state().pendingActivity.newEnded, [62]);
    assert.equal(f.state().pendingActivity.updatedAt, FIRST_TIME + 1000);
    assert.equal(f.state().evolutionMemory.activity.evidenceFingerprint, fingerprint);
    assert.equal(f.state().lastAutomaticEvolveDate, FIRST_DAY);
    assert.equal(f.launches.length, 0);
    f.service.settleCombinedActivityMemory(latest, { newUnknown: [52], newEnded: [62], fingerprint, head: HEAD });
    assert.equal(latest.pendingActivity, null);
});
