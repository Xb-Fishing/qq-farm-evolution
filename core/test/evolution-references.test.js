const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { collectPublicReferences, getPublicReferenceSummary } = require('../src/services/evolution-references');

const SEEDS = ['xxxscarlxrd404/qq-farm-bot', 'liyangpengs/qq-farm-bot'];
const DAY = 86400000;
const NOW = Date.parse('2026-01-05T12:00:00Z');
const metadata = (fullName, extra = {}) => ({ full_name: fullName, name: fullName.split('/')[1], private: false,
    pushed_at: '2026-01-05T00:00:00Z', stargazers_count: 7, ...extra });

function fixture(t) {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farm-reference-test-'));
    t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    const calls = [];
    let items = [metadata('sample/qq-farm-bot')];
    let revision = 'a'.repeat(40);
    const request = async (apiPath) => {
        calls.push(apiPath);
        if (apiPath.startsWith('/search/')) return { statusCode: 200, body: { items } };
        if (apiPath.endsWith('/commits?per_page=1')) return { statusCode: 200, body: [{ sha: revision }] };
        return { statusCode: 200, body: metadata(apiPath.slice('/repos/'.length)) };
    };
    return { dataDir, calls, request, options: { dataDir, now: NOW, request },
        setItems: value => { items = value; }, setRevision: value => { revision = value; },
        persisted: () => fs.readFileSync(path.join(dataDir, 'evolution-references.json'), 'utf8') };
}

test('checks both seeds and six broad query groups, deduplicates and records metadata without claiming review', async (t) => {
    const f = fixture(t);
    const result = await collectPublicReferences(f.options);
    assert.equal(result.state, 'complete');
    assert.equal(result.discoveryComplete, true);
    assert.equal(result.queriesSucceeded, 6);
    assert.equal(result.candidateCount, 3);
    assert.deepEqual(result.newCandidates, ['sample/qq-farm-bot']);
    assert.deepEqual(f.calls.slice(0, 4), SEEDS.flatMap(name => [`/repos/${name}`, `/repos/${name}/commits?per_page=1`]));
    const searches = f.calls.filter(value => value.startsWith('/search/'));
    assert.equal(new Set(searches).size, 6);
    assert.equal(searches.filter(value => value.includes('sort=stars')).length, 3);
    assert.equal(searches.filter(value => value.includes('sort=updated')).length, 3);
    assert.equal(searches.every(value => value.endsWith('per_page=10')), true);
    assert.equal(f.calls.length, 11);
    assert.equal(result.candidates.every(item => /^[a-f\d]{40}$/.test(item.sha)), true);
    assert.doesNotMatch(f.persisted(), /reviewed|https?:|description|full_name|README/i);
    assert.equal(fs.statSync(path.join(f.dataDir, 'evolution-references.json')).mode & 0o777, 0o600);
});

test('same-day success is reused, but next-day searches find new repositories and changed SHAs', async (t) => {
    const f = fixture(t);
    await collectPublicReferences(f.options);
    assert.equal((await collectPublicReferences({ ...f.options, now: NOW + 1000 })).cached, true);
    assert.equal(f.calls.length, 11);
    f.setItems([metadata('sample/qq-farm-bot'), metadata('new-project/qq-farm')]);
    f.setRevision('b'.repeat(40));
    const second = await collectPublicReferences({ ...f.options, now: NOW + DAY });
    assert.equal(second.cached, false);
    assert.deepEqual(second.newCandidates, ['new-project/qq-farm']);
    assert.deepEqual(second.changedCandidates.sort(), [...SEEDS, 'sample/qq-farm-bot'].sort());
    assert.equal(f.calls.filter(value => value.startsWith('/search/')).length, 12);
    const third = await collectPublicReferences({ ...f.options, now: NOW + 2 * DAY });
    assert.equal(third.queriesSucceeded, 6);
    assert.deepEqual(third.changedCandidates, []);
    assert.deepEqual(third.newCandidates, []);
});

test('rate limits immediately stop requests and cannot be reported complete or retried the same day', async (t) => {
    const f = fixture(t);
    let calls = 0;
    const request = async apiPath => ++calls === 5 ? { statusCode: 429, body: { message: 'private-error' } } : f.request(apiPath);
    const first = await collectPublicReferences({ ...f.options, request });
    assert.equal(calls, 5);
    assert.equal(first.state, 'partial');
    assert.equal(first.discoveryComplete, false);
    assert.equal(first.failureReason, 'rate_limited');
    assert.equal((await collectPublicReferences({ ...f.options, request })).cached, true);
    assert.equal(calls, 5);
    assert.equal(f.persisted().includes('private-error'), false);
    const unavailable = await collectPublicReferences({ ...f.options, now: NOW + DAY,
        request: async () => ({ statusCode: 403, body: null }) });
    assert.equal(unavailable.state, 'unavailable');
    assert.equal(unavailable.failureReason, 'rate_limited');
});

test('timeouts and malformed responses remain partial and never store original errors', async (t) => {
    const f = fixture(t);
    let calls = 0;
    const result = await collectPublicReferences({ ...f.options, request: async (apiPath) => {
        calls += 1;
        if (calls === 5) throw new Error('timeout');
        return f.request(apiPath);
    } });
    assert.equal(result.state, 'partial');
    assert.equal(result.failureReason, 'timeout');
    assert.equal(result.queriesSucceeded, 5);
    const next = await collectPublicReferences({ ...f.options, now: NOW + DAY,
        request: async () => ({ statusCode: 302, body: { location: 'private-redirect' } }) });
    assert.equal(next.state, 'unavailable');
    assert.equal(next.discoveryComplete, false);
    assert.equal(f.persisted().includes('private-redirect'), false);
});

test('external metadata and hostile cache fields are reconstructed through strict allowlists', async (t) => {
    const f = fixture(t);
    const forbidden = ['private', 'fixture', 'secret'].join('-');
    f.setItems([
        metadata('sample/qq-farm-bot', { description: forbidden, html_url: forbidden, token: forbidden }),
        metadata('__proto__/qq-farm-bot'), metadata('constructor/qq-farm-bot'),
        metadata(['sample/qq-farm-bot', '?', 'secret', '=', 'value'].join('')), metadata('private/qq-farm-bot', { private: true }),
        metadata('sample/unrelated', { description: forbidden }),
    ]);
    const result = await collectPublicReferences(f.options);
    assert.equal(result.candidateCount, 3);
    assert.equal(f.persisted().includes(forbidden), false);
    assert.equal(f.persisted().includes('__proto__'), false);
    const cached = JSON.parse(f.persisted());
    cached.description = forbidden;
    cached.candidates.push({ ownerRepo: 'prototype/qq-farm-bot', sha: forbidden, stars: 1 });
    cached.candidates[0].token = forbidden;
    cached.candidates[0].sha = forbidden;
    cached.queries.push({ queryId: forbidden, state: forbidden });
    cached.newCandidates.push(forbidden);
    fs.writeFileSync(path.join(f.dataDir, 'evolution-references.json'), JSON.stringify(cached));
    const clean = getPublicReferenceSummary(f.dataDir);
    assert.equal(JSON.stringify(clean).includes(forbidden), false);
    assert.equal(clean.candidateCount, 3);
    assert.equal((await collectPublicReferences(f.options)).cached, true);
    assert.equal(f.persisted().includes(forbidden), false);
    fs.writeFileSync(path.join(f.dataDir, 'evolution-references.json'), '{invalid');
    assert.equal(getPublicReferenceSummary(f.dataDir).state, 'unavailable');
    assert.equal((await collectPublicReferences(f.options)).cached, false);
});

test('large result sets remain bounded to 40 candidates, three extra commits and 16 requests', async (t) => {
    const f = fixture(t);
    let searches = 0;
    const request = async (apiPath) => {
        if (apiPath.startsWith('/search/')) {
            searches += 1;
            f.calls.push(apiPath);
            return { statusCode: 200, body: { items: Array.from({ length: 100 }, (_, index) =>
                metadata(`project-${searches}-${index}/qq-farm-bot`)) } };
        }
        return f.request(apiPath);
    };
    const result = await collectPublicReferences({ ...f.options, request });
    assert.equal(result.candidateCount, 40);
    assert.equal(result.candidates.length, 12);
    assert.equal(f.calls.filter(value => value.includes('/commits?')).length, 5);
    assert.equal(f.calls.length <= 16, true);
    assert.equal(f.calls.length, 13);
});

test('overall time budget stops further work without claiming successful discovery', async (t) => {
    const f = fixture(t);
    let time = NOW;
    t.mock.method(Date, 'now', () => time);
    const result = await collectPublicReferences({ ...f.options, request: async (apiPath) => {
        time += 10000;
        return f.request(apiPath);
    } });
    assert.equal(f.calls.length, 5);
    assert.equal(result.failureReason, 'budget_exhausted');
    assert.equal(result.discoveryComplete, false);
    assert.equal(result.state, 'partial');
});

test('metadata-only discovery honestly reports no new non-seed projects', async (t) => {
    const f = fixture(t);
    f.setItems([]);
    const result = await collectPublicReferences(f.options);
    assert.equal(result.state, 'complete');
    assert.equal(result.candidateCount, 2);
    assert.deepEqual(result.newCandidates, []);
    assert.deepEqual(result.changedCandidates, []);
    assert.equal(result.candidates.every(item => Object.keys(item).sort().join(',') === 'ownerRepo,sha,stars,updatedAt'), true);
});

test('incomplete search responses remain partial while preserving discovered candidates', async (t) => {
    const f = fixture(t);
    const result = await collectPublicReferences({ ...f.options, request: async (apiPath) => {
        const response = await f.request(apiPath);
        if (apiPath.startsWith('/search/')) response.body.incomplete_results = true;
        return response;
    } });
    assert.equal(result.state, 'partial');
    assert.equal(result.discoveryComplete, false);
    assert.equal(result.queriesSucceeded, 0);
    assert.equal(result.candidateCount, 3);
});

test('historical SHA survives a day without a candidate commit lookup and detects later changes', async (t) => {
    const f = fixture(t);
    await collectPublicReferences(f.options);
    f.setItems([metadata('sample/qq-farm-bot'), ...[1, 2, 3].map(index =>
        metadata(`recent-${index}/qq-farm-bot`, { pushed_at: '2026-01-06T00:00:00Z' }))]);
    const second = await collectPublicReferences({ ...f.options, now: NOW + DAY });
    assert.equal(second.candidates.find(item => item.ownerRepo === 'sample/qq-farm-bot').sha, '');
    const seen = JSON.parse(f.persisted()).seenCandidates;
    assert.equal(seen.find(item => item.ownerRepo === 'sample/qq-farm-bot').sha, 'a'.repeat(40));
    f.setItems([metadata('sample/qq-farm-bot')]);
    f.setRevision('b'.repeat(40));
    const third = await collectPublicReferences({ ...f.options, now: NOW + 2 * DAY });
    assert.equal(third.changedCandidates.includes('sample/qq-farm-bot'), true);
    assert.equal(third.newCandidates.includes('sample/qq-farm-bot'), false);
});
