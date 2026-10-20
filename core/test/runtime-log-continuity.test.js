const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const parent = fs.realpathSync(process.env.FARM_LOG_HISTORY_TEST_DIR || os.tmpdir());
const prefix = path.resolve(parent, 'panel-log-continuity-');
assert.equal(path.dirname(prefix), parent);
const root = fs.mkdtempSync(prefix);
process.env.FARM_DATA_DIR = root;
after(() => fs.rmSync(root, { recursive: true, force: true }));
const { createRuntimeState } = require('../src/runtime/runtime-state');
const { createDataProvider } = require('../src/runtime/data-provider');
const { createWorkerManager } = require('../src/runtime/worker-manager');
const { createScheduler } = require('../src/services/scheduler');
const { createRuntimeLogHistory, FILENAME, MAX_FILE_BYTES } = require('../src/runtime/runtime-log-history');

function fixture(name) {
    const directory = path.resolve(root, name);
    assert.equal(path.dirname(directory), root);
    fs.mkdirSync(directory, { mode: 0o700 });
    process.env.FARM_DATA_DIR = directory;
    return directory;
}
const accounts = [{ id: 'synthetic-one', name: 'Example one', code: 'synthetic' }, { id: 'synthetic-two', name: 'Example two' }];
const state = () => createRuntimeState({ store: {}, operationKeys: [] });
const provider = current => createDataProvider({ ...current, getAccounts: () => ({ accounts }), store: {} });

test('real runtime/provider reload preserves prior log timestamps, account actions and search without replaying effects', () => {
    const directory = fixture('management-reload');
    const first = state();
    first.log('系统', 'before management update', { accountId: 'synthetic-one', module: 'farm', event: 'harvest_done' });
    first.addAccountLog('start', 'existing account action', 'synthetic-one', 'Example one');
    const old = provider(first).getLogs('synthetic-one')[0];
    const bytes = fs.existsSync(path.join(directory, FILENAME)) ? fs.readFileSync(path.join(directory, FILENAME)) : null;
    const second = state();
    const restored = provider(second).getLogs('synthetic-one', { keyword: 'management harvest_done', module: 'farm' });
    assert.equal(restored.length, 1, 'new management must replay the prior panel history');
    assert.equal(restored[0].ts, old.ts);
    assert.equal(restored[0].time, old.time);
    assert.equal(provider(second).getAccountLogs(20)[0]?.action, 'start');
    assert.deepEqual(fs.readFileSync(path.join(directory, FILENAME)), bytes, 'recovery itself never emits new logs');
    assert.deepEqual(Object.keys(second.workers), [], 'reading history cannot start a game account');
});

test('actual Worker message handler persists its account-scoped log for the next management instance', () => {
    fixture('worker-relay');
    const first = state();
    const proc = new EventEmitter(); proc.send = () => {}; proc.kill = () => {};
    const manager = createWorkerManager({
        ...first, fork: () => proc, runtimeMode: 'fork', processRef: { env: {}, pkg: false },
        mainEntryPath: '', workerScriptPath: '', normalizeStatusForPanel: value => value,
        buildConfigSnapshotForAccount: () => ({}), getOfflineAutoDeleteMs: () => Infinity,
        triggerOfflineReminder() {}, addOrUpdateAccount() {}, getAccounts: () => ({ accounts }), deleteAccount() {},
    });
    try {
        assert.equal(manager.startWorker(accounts[0]), true);
        proc.emit('message', { type: 'log', data: { time: '2001-02-03 04:05:06', tag: '农场', msg: 'worker result before update', isWarn: true, meta: { module: 'farm', event: 'known_result' } } });
        const old = provider(first).getLogs('synthetic-one').find(row => row.msg === 'worker result before update');
        const restored = provider(state()).getLogs('synthetic-one', { event: 'known_result', isWarn: 'true' });
        assert.equal(restored.length, 1, 'Worker relay must use the shared durable append path');
        assert.equal(restored[0].time, old.time); assert.equal(restored[0].ts, old.ts);
        assert.equal(restored[0].accountId, 'synthetic-one');
        assert.equal(provider(state()).getLogs('synthetic-two').length, 0);
    } finally { createScheduler('worker_manager').clearAll(); }
});

test('per-account and all clears remain cleared after reload while later logs survive', () => {
    fixture('explicit-clear');
    const first = state();
    for (const account of accounts) {
        first.log('系统', `old ${account.id}`, { accountId: account.id });
        first.addAccountLog('existing', 'old action', account.id, account.name);
    }
    provider(first).clearLogs('synthetic-one');
    const second = state();
    assert.equal(provider(second).getLogs('synthetic-one').length, 0);
    assert.equal(provider(second).getLogs('synthetic-two').length, 1);
    assert.deepEqual(second.accountLogs.map(row => row.accountId), ['synthetic-two']);
    provider(second).clearLogs('all');
    const third = state(); assert.equal(third.globalLogs.length, 0); assert.equal(third.accountLogs.length, 0);
    third.log('系统', 'after explicit clear', { accountId: 'synthetic-one' });
    assert.deepEqual(provider(state()).getLogs('synthetic-one').map(row => row.msg), ['after explicit clear']);
});

test('a torn tail is separated from subsequent writes and recovered content stays private', () => {
    const directory = fixture('torn-tail');
    const first = state();
    first.log('系统', 'first durable row', { accountId: 'synthetic-one', token: 'synthetic-private-value' });
    const filename = path.join(directory, FILENAME);
    fs.appendFileSync(filename, '{"kind":"runtime",');
    first.log('系统', 'valid row after torn tail', { accountId: 'synthetic-one' });
    const restored = provider(state()).getLogs('synthetic-one');
    assert.equal(restored.length, 2);
    assert.equal(restored[1].msg, 'valid row after torn tail');
    assert.ok(!fs.readFileSync(filename, 'utf8').includes('synthetic-private-value'));
    assert.equal(fs.statSync(filename).mode & 0o777, 0o600);
});

test('history and compaction are bounded and preserve the newest records', () => {
    const directory = fixture('bounded-history'); const rows = []; const actions = [];
    const history = createRuntimeLogHistory({ globalLogs: rows, accountLogs: actions });
    for (let i = 0; i < 2005; i++) {
        const entry = { ts: 1000 + i, time: String(i), msg: `row ${i}`, accountId: 'synthetic-one', meta: {} };
        rows.push(entry); if (rows.length > 2000) rows.shift();
        assert.equal(history.recordRuntime(entry), true);
    }
    const filename = path.join(directory, FILENAME);
    fs.truncateSync(filename, MAX_FILE_BYTES);
    const entry = { ts: 4000, msg: 'newest after compaction', accountId: 'synthetic-one', meta: {} };
    rows.push(entry); rows.shift(); assert.equal(history.recordRuntime(entry), true);
    assert.ok(fs.statSync(filename).size < MAX_FILE_BYTES);
    const restored = provider(state()).getLogs('synthetic-one', { limit: 2000 });
    assert.equal(restored.length, 2000); assert.equal(restored.at(-1).msg, entry.msg);
});

test('an unsafe history target cannot change an outside file or stop runtime log delivery', () => {
    const directory = fixture('unsafe-target');
    const outside = path.resolve(root, 'outside-fixture.txt'); assert.equal(path.dirname(outside), root);
    fs.writeFileSync(outside, 'keep outside fixture', { mode: 0o640 });
    fs.symlinkSync(outside, path.join(directory, FILENAME));
    const first = state();
    assert.doesNotThrow(() => first.log('系统', 'still visible', { accountId: 'synthetic-one' }));
    assert.equal(provider(first).getLogs('synthetic-one').length, 1);
    assert.throws(() => provider(first).clearLogs('all'), /日志清除未能保存/);
    assert.equal(provider(first).getLogs('synthetic-one').length, 1, 'failed persistence must retain the current view');
    assert.equal(fs.readFileSync(outside, 'utf8'), 'keep outside fixture');
    assert.equal(fs.statSync(outside).mode & 0o777, 0o640);
});

test('clear persistence failure rolls back both arrays and a later successful retry stays cleared', () => {
    const directory = fixture('clear-transaction');
    const current = state();
    for (const account of accounts) {
        current.log('系统', 'retain on failed clear', { accountId: account.id });
        current.addAccountLog('existing', 'retain action', account.id, account.name);
    }
    const filename = path.join(directory, FILENAME);
    const originalFile = fs.existsSync(filename) ? fs.readFileSync(filename) : null;
    const runtime = [...current.globalLogs]; const actions = [...current.accountLogs];
    for (const scope of ['synthetic-one', 'all']) for (const throws of [false, true]) {
        const api = provider({ ...current, persistLogHistory: () => { if (throws) throw new Error('synthetic write failure'); return false; } });
        assert.throws(() => api.clearLogs(scope), /日志清除未能保存/);
        assert.deepEqual(current.globalLogs, runtime); assert.deepEqual(current.accountLogs, actions);
        assert.deepEqual(fs.readFileSync(filename), originalFile);
    }
    provider(current).clearLogs('synthetic-one');
    const restored = state();
    assert.equal(provider(restored).getLogs('synthetic-one').length, 0);
    assert.equal(provider(restored).getLogs('synthetic-two').length, 1);
    assert.deepEqual(restored.accountLogs.map(row => row.accountId), ['synthetic-two']);
});
