const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

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
    assert.equal(f.rows().length, 3);
    const saved = JSON.parse(fs.readFileSync(path.join(f.dataDir, 'daily-feedback-summary.json'), 'utf8'));
    assert.deepEqual(saved.counts, summary.counts);
    assert.equal(JSON.stringify(saved).includes('trace'), false);
});

test('records older than 72 hours are physically removed while newer records remain', (t) => {
    const f = fixture(t);
    const firstAt = f.time();
    f.store.record(click(crypto.randomUUID()));
    f.store.flush();
    f.setTime(firstAt + 2 * 24 * 60 * 60 * 1000);
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

test('write failures never throw into callers and leave collection loss visible', (t) => {
    const dataDir = path.join(isolatedDataDir, `blocked-${crypto.randomUUID()}`);
    fs.writeFileSync(dataDir, 'file blocks the data directory');
    const store = createDailyFeedbackStore({ dataDir });
    t.after(() => store.flush());
    assert.doesNotThrow(() => store.record(click(crypto.randomUUID())));
    assert.doesNotThrow(() => store.flush());
    const summary = store.snapshot({ force: true });
    assert.equal(summary.dropped, 1);
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
