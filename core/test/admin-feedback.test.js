const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');

const isolatedDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farm-feedback-http-import-'));
process.env.FARM_DATA_DIR = isolatedDataDir;
const { createDailyFeedbackStore } = require('../src/services/daily-feedback');
const { createFeedbackMiddleware, registerAdminFeedbackRoutes } = require('../src/controllers/admin-feedback-routes');
test.after(() => fs.rmSync(isolatedDataDir, { recursive: true, force: true }));

async function fixture(t) {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farm-feedback-http-'));
    const feedback = createDailyFeedbackStore({ dataDir });
    const app = express();
    app.use(express.json());
    const hasAdminToken = value => value === 'test-admin';
    const requireAdminToken = (req, res, next) => {
        if (!hasAdminToken(req.headers['x-admin-token'])) return res.status(401).json({ ok: false });
        req.adminToken = req.headers['x-admin-token'];
        next();
    };
    app.use(createFeedbackMiddleware({ hasAdminToken, feedback }));
    registerAdminFeedbackRoutes({ app, requireAdminToken, feedback });
    const server = http.createServer(app);
    await new Promise(resolve => server.listen(0, resolve));
    const call = (route, { method = 'GET', body, headers = {}, authenticated = true } = {}) => new Promise((resolve, reject) => {
        const req = http.request({ hostname: 'localhost', port: server.address().port, path: route, method,
            headers: { ...(authenticated ? { 'x-admin-token': 'test-admin' } : {}),
                ...(body ? { 'content-type': 'application/json' } : {}), ...headers } }, (res) => {
            let text = '';
            res.on('data', chunk => { text += chunk; });
            res.on('end', () => resolve({ status: res.statusCode, text, body: text.startsWith('{') ? JSON.parse(text) : undefined }));
        });
        req.on('error', reject);
        req.end(body ? JSON.stringify(body) : undefined);
    });
    const rows = () => {
        feedback.flush();
        const folder = path.join(dataDir, 'daily-feedback');
        return fs.existsSync(folder) ? fs.readdirSync(folder).filter(file => file.endsWith('.jsonl'))
            .flatMap(file => fs.readFileSync(path.join(folder, file), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))) : [];
    };
    t.after(async () => {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
        feedback.flush();
        fs.rmSync(dataDir, { recursive: true, force: true });
    });
    return { app, server, feedback, rows, call };
}

test('real HTTP responses distinguish semantic failure, accepted work, partial results and errors', async (t) => {
    const f = await fixture(t);
    const responses = {
        success: [200, { ok: true, data: { successCount: 2, changedCount: 1 } }, 'succeeded'],
        failure: [200, { ok: false, error: 'private-error-fixture' }, 'failed'],
        nested: [200, { ok: true, data: { success: false } }, 'failed'],
        accepted: [202, { ok: true, data: { started: true } }, 'accepted'],
        started: [200, { ok: true, started: true }, 'accepted'],
        partial: [200, { ok: true, data: { successCount: 2, failedCount: 1 } }, 'partial'],
        rejected: [400, { error: 'private-error-fixture' }, 'rejected'],
        crashed: [500, { error: 'private-error-fixture' }, 'failed'],
    };
    for (const [name, [status, body]] of Object.entries(responses)) {
        f.app.post(`/api/${name}`, (req, res) => res.status(status).json(body));
    }
    for (const name of Object.keys(responses)) await f.call(`/api/${name}`, { method: 'POST' });
    const rows = f.rows();
    assert.equal(rows.length, Object.keys(responses).length);
    for (const [name, [, , outcome]] of Object.entries(responses)) {
        assert.equal(rows.find(row => row.action === `POST /api/${name}`).outcome, outcome, name);
    }
    assert.equal(rows.find(row => row.action === 'POST /api/success').changedCount, 1);
    assert.equal(rows.find(row => row.action === 'POST /api/partial').failedCount, 1);
    assert.equal(JSON.stringify(rows).includes('private-error-fixture'), false);
});

test('clicks correlate using valid UUID only and records contain the route template rather than private request data', async (t) => {
    const f = await fixture(t);
    f.app.post('/api/items/:item', (req, res) => res.json({ ok: true, data: { successCount: 1, privateField: req.body.privateField } }));
    const trace = crypto.randomUUID();
    await f.call('/api/diagnostics/feedback', { method: 'POST', body: { events: [{ kind: 'click', page: 'bag', target: 'button', trace }] } });
    await f.call('/api/items/private-item?search=private-query', { method: 'POST',
        headers: { 'x-feedback-id': trace }, body: { privateField: 'private-body' } });
    const rows = f.rows();
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map(row => row.trace), [trace, trace]);
    assert.equal(rows[1].action, 'POST /api/items/:item');
    for (const forbidden of ['private-item', 'private-query', 'private-body', 'test-admin', 'diagnostics']) {
        assert.equal(JSON.stringify(rows).includes(forbidden), false, forbidden);
    }
    await f.call('/api/items/another-private-item', { method: 'POST', headers: { 'x-feedback-id': 'private-invalid-trace' } });
    const invalid = f.rows().at(-1);
    assert.notEqual(invalid.trace, 'private-invalid-trace');
    assert.match(invalid.trace, /^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/);
});

test('successful polling without valid click correlation stays quiet; failed reads remain observable', async (t) => {
    const f = await fixture(t);
    f.app.get('/api/poll', (req, res) => res.json({ ok: true }));
    f.app.get('/api/failed-read', (req, res) => res.json({ ok: false }));
    await f.call('/api/poll');
    await f.call('/api/poll', { headers: { 'x-feedback-id': 'invalid-trace' } });
    assert.equal(f.rows().length, 0);
    await f.call('/api/poll', { headers: { 'x-feedback-id': crypto.randomUUID() } });
    await f.call('/api/failed-read');
    assert.equal(f.rows().length, 2);
    assert.equal(f.rows().at(-1).outcome, 'failed');
});

test('unauthenticated callers cannot write; browser input cannot forge backend or runtime events', async (t) => {
    const f = await fixture(t);
    const trace = crypto.randomUUID();
    const events = [
        { kind: 'click', page: 'activity', target: 'button', trace, outcome: 'succeeded', message: 'private-message' },
        { kind: 'client_error', page: 'activity', category: 'vue_error', trace, domain: 'auth', stack: 'private-stack' },
        { kind: 'request', action: 'POST /api/forged', outcome: 'succeeded', trace },
        { kind: 'runtime', category: 'runtime_error', domain: 'system', trace },
        { kind: 'click', page: 'constructor', target: 'button', trace },
    ];
    assert.equal((await f.call('/api/diagnostics/feedback', { method: 'POST', body: { events }, authenticated: false })).status, 401);
    assert.equal(f.rows().length, 0);
    const response = await f.call('/api/diagnostics/feedback', { method: 'POST', body: { events } });
    assert.deepEqual(response.body, { ok: true, accepted: 2 });
    const rows = f.rows();
    assert.deepEqual(rows.map(row => row.kind), ['click', 'client_error']);
    assert.equal(rows[0].outcome, 'observed');
    assert.equal(rows[1].domain, 'system');
    assert.equal(JSON.stringify(rows).includes('private-'), false);
    assert.equal((await f.call('/api/diagnostics/feedback')).status, 404);
    assert.equal(f.rows().length, 2);
});

test('connection abort is observed once and does not pretend the request completed', { timeout: 5000 }, async (t) => {
    const f = await fixture(t);
    let resolveClosed;
    const closed = new Promise(resolve => { resolveClosed = resolve; });
    f.app.post('/api/pending', (req, res) => {
        res.once('close', resolveClosed);
        res.writeHead(200);
        res.write('still pending');
    });
    await new Promise((resolve, reject) => {
        const req = http.request({ hostname: 'localhost', port: f.server.address().port, path: '/api/pending', method: 'POST',
            headers: { 'x-admin-token': 'test-admin' } }, (res) => {
            res.once('data', () => req.destroy());
            res.once('close', resolve);
        });
        req.on('error', error => { if (error.code !== 'ECONNRESET') reject(error); });
        req.end();
    });
    await closed;
    const rows = f.rows();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].outcome, 'aborted');
});

test('normal finish and close cannot duplicate a recorded request and telemetry exceptions do not change HTTP success', async (t) => {
    const f = await fixture(t);
    f.app.post('/api/once', (req, res) => res.json({ ok: true }));
    await f.call('/api/once', { method: 'POST' });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.rows().length, 1);
    const originalRecord = f.feedback.record;
    f.feedback.record = () => { throw new Error('private-write-error'); };
    try {
        assert.equal((await f.call('/api/once', { method: 'POST' })).status, 200);
        assert.deepEqual((await f.call('/api/diagnostics/feedback', { method: 'POST', body: { events: [
            { kind: 'click', page: 'activity', target: 'button' },
        ] } })).body, { ok: true, accepted: 0 });
    } finally {
        f.feedback.record = originalRecord;
    }
    assert.equal(f.rows().length, 1);
});

test('feedback payload limits reject oversized batches without recursive error records', async (t) => {
    const f = await fixture(t);
    const event = { kind: 'click', page: 'activity', target: 'button' };
    assert.equal((await f.call('/api/diagnostics/feedback', { method: 'POST', body: { events: Array.from({ length: 51 }, () => event) } })).status, 400);
    assert.equal((await f.call('/api/diagnostics/feedback', { method: 'POST', body: { events: {} } })).status, 400);
    assert.equal(f.rows().length, 0);
    for (let index = 0; index < 12; index += 1) {
        assert.equal((await f.call('/api/diagnostics/feedback', { method: 'POST', body: { events: Array.from({ length: 50 }, () => event) } })).status, 200);
    }
    assert.equal((await f.call('/api/diagnostics/feedback', { method: 'POST', body: { events: [event] } })).status, 429);
    assert.equal(f.rows().length, 600);
});
