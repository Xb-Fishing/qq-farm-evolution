const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const isolatedDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farm-feedback-import-'));
process.env.FARM_DATA_DIR = isolatedDataDir;
const { createDailyFeedbackStore, RETENTION_MS } = require('../src/services/daily-feedback');
test.after(() => fs.rmSync(isolatedDataDir, { recursive: true, force: true }));

function fixture(t, options = {}) {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farm-feedback-store-'));
    let time = Date.parse('2026-01-05T12:00:00Z');
    const store = createDailyFeedbackStore({ dataDir, now: () => time, ...options });
    t.after(() => { store.flush(); fs.rmSync(dataDir, { recursive: true, force: true }); });
    const files = () => {
        const folder = path.join(dataDir, 'daily-feedback');
        return fs.existsSync(folder) ? fs.readdirSync(folder).filter(file => file.endsWith('.jsonl')).sort() : [];
    };
    const rows = () => files().flatMap(file => fs.readFileSync(path.join(dataDir, 'daily-feedback', file), 'utf8')
        .trim().split('\n').filter(Boolean).map(line => JSON.parse(line)));
    return { dataDir, store, files, rows, time: () => time, setTime: value => { time = value; } };
}

const click = trace => ({ kind: 'click', page: 'activity', target: 'button', trace });
const request = (trace, outcome) => ({ kind: 'request', trace, action: 'POST /api/activity/operate', outcome,
    durationMs: 12, httpStatus: 200 });

test('multiple clicks retain distinct traces and observable request outcomes without inventing completion', (t) => {
    const f = fixture(t);
    const first = crypto.randomUUID();
    const second = crypto.randomUUID();
    assert.equal(f.store.record(click(first)), true);
    assert.equal(f.store.record(click(second)), true);
    f.store.record(request(first, 'failed'));
    f.store.record(request(second, 'accepted'));
    f.store.record(request(second, 'succeeded'));
    const snapshot = f.store.snapshot({ force: true });
    assert.deepEqual(snapshot.counts, { clicks: 2, requests: 3, failures: 1, accepted: 1, runtimeErrors: 0, clientErrors: 0 });
    assert.deepEqual(f.rows().filter(row => row.trace === first).map(row => row.outcome), ['observed', 'failed']);
    assert.deepEqual(f.rows().filter(row => row.trace === second).map(row => row.outcome), ['observed', 'accepted', 'succeeded']);
    assert.match(snapshot.coverageNote, /未点击|未.*验证/);
});

test('disk schema is allowlisted and rejects raw addresses, identifiers, credentials and prototype keys', (t) => {
    const f = fixture(t, { revision: 'a'.repeat(40) });
    const trace = crypto.randomUUID();
    const privateValue = ['private', 'fixture', 'value'].join('-');
    const address = ['https:', '', 'untrusted.invalid', privateValue].join('/');
    const extra = JSON.parse('{"__proto__":{"polluted":true},"constructor":"malicious"}');
    Object.assign(extra, { message: privateValue, body: { password: privateValue }, token: privateValue, url: address,
        accountId: privateValue, params: { id: privateValue }, query: privateValue });
    f.store.record({ ...click(trace), ...extra, at: 1, outcome: 'succeeded' });
    f.store.record({ ...request(trace, 'partial'), ...extra, successCount: 2, failedCount: 1, changedCount: 3, itemCount: 4 });
    f.store.record({ kind: 'client_error', page: 'activity', category: 'script_error', trace, ...extra });
    f.store.record({ kind: 'runtime', domain: 'network', category: 'runtime_error', trace, ...extra });
    for (const invalid of [
        { ...click(trace), page: 'constructor' }, { ...click(trace), target: '__proto__' },
        { kind: 'runtime', category: 'toString' }, { kind: 'client_error', category: address },
        { ...request(trace, 'failed'), action: address },
        { ...request(trace, 'failed'), action: 'GET /api/items?private=value' },
    ]) assert.equal(f.store.record(invalid), false);
    f.store.flush();
    const rows = f.rows();
    assert.equal(rows.length, 4);
    const keys = {
        click: ['at', 'kind', 'revision', 'trace', 'page', 'target', 'outcome'],
        request: ['at', 'kind', 'revision', 'trace', 'action', 'outcome', 'durationMs', 'httpStatus', 'successCount', 'failedCount', 'changedCount', 'itemCount'],
        client_error: ['at', 'kind', 'revision', 'trace', 'category', 'domain', 'page', 'outcome'],
        runtime: ['at', 'kind', 'revision', 'trace', 'category', 'domain', 'outcome'],
    };
    for (const row of rows) {
        assert.deepEqual(Object.keys(row).sort(), keys[row.kind].sort());
        assert.equal(row.at, f.time());
        assert.equal(row.revision, 'a'.repeat(40));
    }
    const persisted = JSON.stringify(rows);
    for (const forbidden of [privateValue, address, '__proto__', 'constructor', 'password', 'polluted']) {
        assert.equal(persisted.includes(forbidden), false, forbidden);
    }
    assert.equal(Object.prototype.polluted, undefined);
    for (const file of f.files()) assert.equal(fs.statSync(path.join(f.dataDir, 'daily-feedback', file)).mode & 0o777, 0o600);
});

test('invalid trace cannot associate events; primitive counters are bounded safely', (t) => {
    const f = fixture(t, { revision: 'not-a-revision' });
    f.store.record({ ...request('malformed-trace', 'partial'), durationMs: Infinity, httpStatus: 999,
        successCount: -4, failedCount: 2.8, changedCount: Number.MAX_VALUE, itemCount: 'private-value' });
    f.store.record({ ...click('constructor'), trace: { injected: true } });
    f.store.flush();
    const [row, observed] = f.rows();
    assert.equal(Object.hasOwn(row, 'trace'), false);
    assert.equal(Object.hasOwn(observed, 'trace'), false);
    assert.equal(Object.hasOwn(row, 'revision'), false);
    assert.deepEqual([row.durationMs, row.httpStatus, row.successCount, row.failedCount, row.changedCount], [0, 599, 0, 2, 1000000]);
    assert.equal(Object.hasOwn(row, 'itemCount'), false);
});

test('daily files rotate and the summary only counts the last 24 hours', (t) => {
    const f = fixture(t);
    const firstAt = f.time();
    f.store.record(click(crypto.randomUUID()));
    f.store.flush();
    f.setTime(firstAt + 12 * 60 * 60 * 1000);
    f.store.record(request(crypto.randomUUID(), 'failed'));
    f.store.flush();
    assert.equal(f.files().length, 2);
    f.setTime(firstAt + 24 * 60 * 60 * 1000 + 1);
    f.store.record(click(crypto.randomUUID()));
    const summary = f.store.snapshot({ force: true });
    assert.equal(summary.counts.clicks, 1);
    assert.equal(summary.counts.requests, 1);
    assert.equal(summary.counts.failures, 1);
    assert.equal(summary.windowHours, 24);
    assert.equal(f.rows().length, 2);
    const saved = JSON.parse(fs.readFileSync(path.join(f.dataDir, 'daily-feedback-summary.json'), 'utf8'));
    assert.deepEqual(saved.counts, summary.counts);
    assert.equal(JSON.stringify(saved).includes('trace'), false);
});

test('records older than 24 hours are physically removed while newer records remain', (t) => {
    const f = fixture(t);
    const firstAt = f.time();
    f.store.record(click(crypto.randomUUID()));
    f.store.flush();
    f.setTime(firstAt + 12 * 60 * 60 * 1000);
    f.store.record(request(crypto.randomUUID(), 'succeeded'));
    f.store.flush();
    f.setTime(firstAt + RETENTION_MS + 1);
    f.store.snapshot({ force: true });
    assert.equal(f.rows().some(row => row.at === firstAt), false);
    assert.equal(f.rows().length, 1);
});

test('bounded disk usage reports dropped observations and resumes on a new day', (t) => {
    const maxDayBytes = 420;
    const f = fixture(t, { maxDayBytes });
    for (let index = 0; index < 20; index += 1) f.store.record(click(crypto.randomUUID()));
    const summary = f.store.snapshot({ force: true });
    const stored = f.rows().length;
    assert.equal(stored > 0 && stored < 20, true);
    assert.equal(summary.dropped, 20 - stored);
    assert.equal(fs.statSync(path.join(f.dataDir, 'daily-feedback', f.files()[0])).size <= maxDayBytes, true);
    f.setTime(f.time() + 24 * 60 * 60 * 1000);
    f.store.record(click(crypto.randomUUID()));
    f.store.flush();
    assert.equal(f.rows().length, stored + 1);
});

test('write failures never throw into callers and retain pending observations', (t) => {
    const dataDir = path.join(isolatedDataDir, `blocked-${crypto.randomUUID()}`);
    fs.writeFileSync(dataDir, 'file blocks the data directory');
    const store = createDailyFeedbackStore({ dataDir });
    t.after(() => store.flush());
    assert.doesNotThrow(() => store.record(click(crypto.randomUUID())));
    assert.doesNotThrow(() => store.flush());
    const summary = store.snapshot({ force: true });
    assert.equal(summary.dropped, 0);
    assert.equal(summary.pending, 1);
    assert.equal(summary.unreadableFiles > 0, true);
});

test('summary tolerates malformed lines and ignores future, unknown or injected events', (t) => {
    const f = fixture(t);
    f.store.record(click(crypto.randomUUID()));
    f.store.flush();
    const file = path.join(f.dataDir, 'daily-feedback', f.files()[0]);
    fs.appendFileSync(file, ['{bad-json',
        JSON.stringify({ at: f.time() + 1, ...click(crypto.randomUUID()) }),
        JSON.stringify({ at: f.time(), kind: 'constructor', message: 'private-fixture' }),
        JSON.stringify({ at: f.time(), kind: 'client_error', category: 'constructor' }), '',
    ].join('\n'));
    const summary = f.store.snapshot({ force: true });
    assert.equal(summary.counts.clicks, 1);
    assert.equal(summary.unreadableFiles, 1);
    assert.equal(JSON.stringify(summary).includes('private-fixture'), false);
});


test('retention filters exact event timestamps across UTC days and removes empty old files', (t) => {
    const f = fixture(t);
    const cutoff = Date.parse('2026-01-05T00:30:00Z');
    for (const time of [cutoff - 1, cutoff, cutoff + 1]) {
        f.setTime(time);
        f.store.record(click(crypto.randomUUID()));
        f.store.flush();
    }
    f.setTime(cutoff + RETENTION_MS);
    f.store.record(request(crypto.randomUUID(), 'failed'));
    const summary = f.store.snapshot();
    assert.deepEqual(f.rows().map(row => row.at), [cutoff, cutoff + 1, cutoff + RETENTION_MS]);
    assert.equal(summary.counts.clicks, 2);
    assert.equal(summary.counts.failures, 1);
    assert.equal(f.files().length, 2);
    f.setTime(f.time() + 2);
    assert.equal(f.store.snapshot().counts.clicks, 0);
    assert.equal(f.files().length, 1);
});

test('acceptance acknowledges only the captured watermark and updates the persisted summary immediately', (t) => {
    const f = fixture(t);
    f.store.record(request(crypto.randomUUID(), 'failed'));
    const batch = f.store.captureBatch();
    assert.deepEqual(batch, { throughAt: f.time() });
    assert.equal(f.rows().length, 1);
    f.setTime(f.time() + 1);
    f.store.record(click(crypto.randomUUID()));
    assert.equal(f.store.acknowledgeBatch(batch), true);
    assert.deepEqual(f.rows().map(row => row.outcome), ['observed']);
    const saved = JSON.parse(fs.readFileSync(path.join(f.dataDir, 'daily-feedback-summary.json'), 'utf8'));
    assert.equal(saved.counts.clicks, 1);
    assert.equal(saved.counts.failures, 0);
    assert.equal(f.store.snapshot().counts.clicks, 1);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.dataDir, 'daily-feedback', '.acknowledged.json'), 'utf8')),
        { version: 1, throughAt: batch.throughAt });
});

test('another store cannot resurrect acknowledged events that were buffered before acceptance', (t) => {
    const f = fixture(t);
    const other = createDailyFeedbackStore({ dataDir: f.dataDir, now: f.time });
    t.after(() => other.flush());
    other.record(request(crypto.randomUUID(), 'failed'));
    f.store.record(click(crypto.randomUUID()));
    const batch = f.store.captureBatch();
    f.setTime(f.time() + 1);
    other.record(request(crypto.randomUUID(), 'succeeded'));
    assert.equal(f.store.acknowledgeBatch(batch), true);
    assert.equal(other.flush(), true);
    assert.deepEqual(f.rows().map(row => row.outcome), ['succeeded']);
    const reloaded = createDailyFeedbackStore({ dataDir: f.dataDir, now: f.time });
    assert.equal(reloaded.snapshot().counts.requests, 1);
    assert.equal(reloaded.snapshot().counts.failures, 0);
});

test('failed review retains captured feedback until its 24 hour expiry without fabricating success', (t) => {
    const f = fixture(t);
    f.store.record(request(crypto.randomUUID(), 'failed'));
    const batch = f.store.captureBatch();
    // A review failure never invokes acknowledgeBatch.
    f.setTime(batch.throughAt + RETENTION_MS - 1);
    assert.equal(f.store.snapshot().counts.failures, 1);
    assert.equal(f.rows()[0].outcome, 'failed');
    f.setTime(batch.throughAt + RETENTION_MS + 1);
    assert.equal(f.store.snapshot().counts.failures, 0);
    assert.deepEqual(f.files(), []);
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.dataDir, 'daily-feedback-summary.json'), 'utf8')).counts.requests, 0);
});

test('lock contention is nonblocking, preserves buffered writes and defers capture and acknowledgement', (t) => {
    const f = fixture(t);
    assert.equal(f.store.flush(), true);
    const lock = path.join(f.dataDir, 'daily-feedback', '.write.lock');
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, nonce: crypto.randomUUID() }), { mode: 0o600 });
    f.store.record(click(crypto.randomUUID()));
    assert.equal(f.store.flush(), false);
    assert.equal(f.store.captureBatch(), null);
    assert.equal(f.store.acknowledgeBatch({ throughAt: f.time() }), false);
    const unavailable = f.store.snapshot();
    assert.equal(unavailable.pending, 1);
    assert.equal(unavailable.dropped, 0);
    assert.equal(f.rows().length, 0);
    fs.unlinkSync(lock);
    assert.equal(f.store.flush(), true);
    assert.equal(f.store.snapshot().counts.clicks, 1);
    assert.equal(f.rows().length, 1);
    assert.equal(fs.existsSync(lock), false);
});

test('future or malformed acknowledgement cannot erase events and corrupt watermarks do not delete history', (t) => {
    const f = fixture(t);
    f.store.record(click(crypto.randomUUID()));
    f.store.flush();
    for (const batch of [null, {}, { throughAt: 'future' }, { throughAt: Infinity }, { throughAt: -1 }, { throughAt: f.time() + 1 }]) {
        assert.equal(f.store.acknowledgeBatch(batch), false);
    }
    const watermark = path.join(f.dataDir, 'daily-feedback', '.acknowledged.json');
    for (const text of ['{bad-json', '{}', JSON.stringify({ version: 1, throughAt: f.time() + 1000 })]) {
        fs.writeFileSync(watermark, text);
        assert.equal(f.store.snapshot().counts.clicks, 1);
        assert.equal(f.rows().length, 1);
    }
});

test('acknowledgement is monotonic, removes malformed lines and keeps unrelated local data', (t) => {
    const f = fixture(t);
    const unrelated = path.join(f.dataDir, 'runtime-issues.json');
    fs.writeFileSync(unrelated, 'unchanged');
    f.store.record(click(crypto.randomUUID()));
    const batch = f.store.captureBatch();
    const folder = path.join(f.dataDir, 'daily-feedback');
    fs.writeFileSync(path.join(folder, 'notes.txt'), 'unchanged');
    fs.appendFileSync(path.join(folder, f.files()[0]), '{broken-json\n');
    assert.equal(f.store.acknowledgeBatch(batch), true);
    assert.deepEqual(f.files(), []);
    assert.equal(f.store.acknowledgeBatch({ throughAt: batch.throughAt - 1000 }), true);
    assert.equal(JSON.parse(fs.readFileSync(path.join(folder, '.acknowledged.json'), 'utf8')).throughAt, batch.throughAt);
    assert.equal(fs.readFileSync(unrelated, 'utf8'), 'unchanged');
    assert.equal(fs.readFileSync(path.join(folder, 'notes.txt'), 'utf8'), 'unchanged');
    assert.equal(fs.statSync(folder).mode & 0o777, 0o700);
    for (const file of [path.join(folder, '.acknowledged.json'), path.join(f.dataDir, 'daily-feedback-summary.json')]) {
        assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    }
    assert.deepEqual(fs.readdirSync(folder).sort(), ['.acknowledged.json', 'notes.txt']);
});

test('lock, watermark, daily file and directory symlinks cannot write outside private storage', (t) => {
    const f = fixture(t);
    f.store.flush();
    const external = path.join(f.dataDir, 'external.txt');
    fs.writeFileSync(external, 'unchanged');
    const folder = path.join(f.dataDir, 'daily-feedback');
    for (const name of ['.write.lock', '.acknowledged.json', '2026-01-05.jsonl']) {
        const link = path.join(folder, name);
        fs.symlinkSync(external, link);
        if (name === '.acknowledged.json') assert.equal(f.store.acknowledgeBatch({ throughAt: f.time() }), false);
        else {
            f.store.record(click(crypto.randomUUID()));
            assert.equal(f.store.flush(), false);
        }
        assert.equal(fs.readFileSync(external, 'utf8'), 'unchanged');
        assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
        fs.unlinkSync(link);
    }
    f.store.flush();
    const linkedDir = path.join(f.dataDir, 'linked');
    fs.symlinkSync(folder, linkedDir);
    const linked = createDailyFeedbackStore({ dataDir: linkedDir, now: f.time });
    linked.record(click(crypto.randomUUID()));
    assert.equal(linked.flush(), false);
    assert.equal(fs.existsSync(path.join(folder, 'daily-feedback')), false);
});

test('shared daily capacity and bounded buffers remain enforced during contention', (t) => {
    const f = fixture(t, { maxDayBytes: 420 });
    f.store.flush();
    const lock = path.join(f.dataDir, 'daily-feedback', '.write.lock');
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, nonce: crypto.randomUUID() }), { mode: 0o600 });
    for (let index = 0; index < 2000; index += 1) assert.equal(f.store.record(click(crypto.randomUUID())), true);
    assert.equal(f.store.record(click(crypto.randomUUID())), false);
    assert.equal(f.store.snapshot().pending, 2000);
    fs.unlinkSync(lock);
    assert.equal(f.store.flush(), true);
    const other = createDailyFeedbackStore({ dataDir: f.dataDir, now: f.time, maxDayBytes: 420 });
    other.record(click(crypto.randomUUID()));
    assert.equal(other.flush(), true);
    assert.equal(fs.statSync(path.join(f.dataDir, 'daily-feedback', f.files()[0])).size <= 420, true);
    assert.equal(f.store.snapshot().dropped + other.snapshot().dropped + f.rows().length, 2002);
});


test('a confirmed dead owner lock recovers without stealing a live owner or disclosing lock metadata', (t) => {
    const f = fixture(t);
    f.store.flush();
    const deadPid = Number(execFileSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }));
    assert.throws(() => process.kill(deadPid, 0), { code: 'ESRCH' });
    const lock = path.join(f.dataDir, 'daily-feedback', '.write.lock');
    const nonce = crypto.randomUUID();
    fs.writeFileSync(lock, JSON.stringify({ pid: deadPid, nonce }), { mode: 0o600 });
    f.store.record(click(crypto.randomUUID()));
    assert.equal(f.store.flush(), true);
    assert.equal(fs.existsSync(lock), false);
    const summary = f.store.snapshot();
    assert.equal(summary.counts.clicks, 1);
    assert.equal(JSON.stringify(summary).includes(nonce), false);
    assert.equal(Object.hasOwn(summary, 'pid'), false);
    fs.writeFileSync(lock, '{broken-lock');
    f.store.record(click(crypto.randomUUID()));
    assert.equal(f.store.flush(), false);
    assert.equal(fs.readFileSync(lock, 'utf8'), '{broken-lock');
    fs.unlinkSync(lock);
    assert.equal(f.store.flush(), true);
    assert.equal(f.store.snapshot().counts.clicks, 2);
});

test('small worker flush appends to a large day file without reading or replacing its existing records', (t) => {
    const f = fixture(t);
    f.store.flush();
    const file = path.join(f.dataDir, 'daily-feedback', '2026-01-05.jsonl');
    const original = `${JSON.stringify({ at: f.time(), kind: 'click', page: 'activity', target: 'button', outcome: 'observed' })}\n`.repeat(20000);
    fs.writeFileSync(file, original, { mode: 0o600 });
    const before = fs.statSync(file);
    const readFile = fs.readFileSync;
    let readBytes = 0;
    const readSpy = t.mock.method(fs, 'readFileSync', function (...args) {
        const contents = readFile.apply(this, args);
        readBytes += Buffer.byteLength(contents);
        return contents;
    });
    f.store.record(request(crypto.randomUUID(), 'failed'));
    assert.equal(f.store.flush(), true);
    readSpy.mock.restore();
    const after = fs.statSync(file);
    assert.equal(after.ino, before.ino, 'append must preserve the existing file');
    assert.equal(readBytes < 2048, true, 'hot-path flush only reads small metadata, never historical rows');
    assert.equal(after.size - before.size < 1024, true);
    const contents = fs.readFileSync(file, 'utf8');
    assert.equal(contents.slice(0, original.length), original);
    assert.equal(JSON.parse(contents.slice(original.length)).outcome, 'failed');
    f.setTime(f.time() + RETENTION_MS + 1);
    assert.equal(f.store.snapshot({ force: true }).counts.clicks, 0);
    assert.deepEqual(f.files(), []);
});

test('append keeps new records intact after a truncated legacy line and snapshot removes the malformed row', (t) => {
    const f = fixture(t);
    f.store.flush();
    const file = path.join(f.dataDir, 'daily-feedback', '2026-01-05.jsonl');
    fs.writeFileSync(file, '{truncated', { mode: 0o600 });
    f.store.record(click(crypto.randomUUID()));
    assert.equal(f.store.flush(), true);
    assert.equal(f.store.snapshot({ force: true }).counts.clicks, 1);
    assert.equal(f.rows().length, 1);
});

test('snapshots cache for ten seconds but local observations, acknowledgement and exact expiry refresh them', (t) => {
    const f = fixture(t);
    f.store.record(click(crypto.randomUUID()));
    const first = f.store.snapshot();
    const other = createDailyFeedbackStore({ dataDir: f.dataDir, now: f.time });
    other.record(click(crypto.randomUUID()));
    other.flush();
    f.setTime(f.time() + 9999);
    assert.equal(f.store.snapshot(), first);
    f.setTime(f.time() + 1);
    assert.equal(f.store.snapshot().counts.clicks, 2);
    f.store.record(click(crypto.randomUUID()));
    assert.equal(f.store.snapshot().counts.clicks, 3);
    const batch = f.store.captureBatch();
    f.store.acknowledgeBatch(batch);
    assert.equal(f.store.snapshot().counts.clicks, 0);
    f.setTime(f.time() + 1);
    f.store.record(click(crypto.randomUUID()));
    f.store.flush();
    f.setTime(f.time() + RETENTION_MS);
    assert.equal(f.store.snapshot().counts.clicks, 1);
    f.setTime(f.time() + 1);
    assert.equal(f.store.snapshot().counts.clicks, 0, 'cached counts must not outlive their earliest event');
});

test('only the main-process singleton schedules minute maintenance; account workers only append', (t) => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farm-feedback-maintenance-'));
    t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    const script = `
        const intervals = [];
        global.setInterval = (callback, delay) => { intervals.push(delay); return { unref() {} }; };
        require(${JSON.stringify(require.resolve('../src/services/daily-feedback'))}).getDailyFeedback();
        process.stdout.write(JSON.stringify(intervals));
    `;
    for (const [account, expected] of [['', [60000]], ['isolated-worker', []]]) {
        const output = execFileSync(process.execPath, ['-e', script], { encoding: 'utf8',
            env: { ...process.env, FARM_DATA_DIR: dataDir, FARM_ACCOUNT_ID: account } });
        assert.deepEqual(JSON.parse(output), expected);
    }
});

test('priority monitoring health is anonymous, strictly categorized and summarized by outcome and cadence', (t) => {
    const f = fixture(t);
    const event = { kind: 'monitor', category: 'priority_poll', outcome: 'succeeded', mode: 'baseline', nextDelayMs: 30000 };
    f.store.record({ ...event, trace: crypto.randomUUID(), gid: 'private-fixture', name: 'private-fixture', message: 'private-fixture' });
    f.store.record({ ...event, mode: 'observation', nextDelayMs: 1000 });
    f.store.record({ ...event, outcome: 'failed', mode: 'observation', nextDelayMs: 10000000 });
    for (const invalid of [{ category: 'unknown' }, { mode: 'unknown' }, { outcome: 'accepted' }, { nextDelayMs: Infinity }]) {
        assert.equal(f.store.record({ ...event, ...invalid }), false);
    }
    const summary = f.store.snapshot();
    assert.deepEqual(summary.monitor, { attempts: 3, successes: 2, failures: 1, observation: 2, baseline: 1 });
    assert.deepEqual(Object.keys(summary.counts).sort(), ['accepted', 'clicks', 'clientErrors', 'failures', 'requests', 'runtimeErrors']);
    assert.equal(summary.groups.find(group => group.key === 'priority_poll:observation').failures, 1);
    const rows = f.rows();
    assert.deepEqual(Object.keys(rows[0]).sort(), ['at', 'category', 'kind', 'mode', 'nextDelayMs', 'outcome']);
    assert.equal(rows[2].nextDelayMs, 3600000);
    assert.equal(JSON.stringify(rows).includes('private-fixture'), false);
    assert.equal(JSON.stringify(summary).includes('private-fixture'), false);
});

test('real logger routes anonymous priority health into feedback without duplicating failures', (t) => {
    const f = fixture(t);
    const { execFileSync } = require('node:child_process');
    const script = `
      const logger = require(process.argv[1]).createModuleLogger('core');
      logger.info('fixed monitoring health', {module:'friend',event:'priority_poll_health',result:'ok',mode:'observation',nextDelayMs:60000});
      logger.info('fixed monitoring health', {module:'friend',event:'priority_poll_health',result:'failed',mode:'baseline',nextDelayMs:360000});
      const feedback = require(process.argv[2]).getDailyFeedback();
      process.stdout.write('TEST_RESULT:' + JSON.stringify(feedback.snapshot({force:true})) + '\\n');
    `;
    const output = execFileSync(process.execPath, ['-e', script, require.resolve('../src/services/logger'), require.resolve('../src/services/daily-feedback')], {
        env: { ...process.env, FARM_DATA_DIR: f.dataDir }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    const line = output.split('\n').find(row => row.startsWith('TEST_RESULT:'));
    const summary = JSON.parse(line.slice('TEST_RESULT:'.length));
    assert.deepEqual(summary.monitor, { attempts: 2, successes: 1, failures: 1, observation: 1, baseline: 1 });
    assert.equal(summary.counts.failures, 1);
    assert.equal(summary.counts.runtimeErrors, 0);
});
