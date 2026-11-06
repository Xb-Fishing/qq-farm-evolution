const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const isolation = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-module-'));
process.env.FARM_DATA_DIR = isolation;
process.env.FARM_PRIVATE_CONFIG_FILE = path.join(isolation, 'private-config.json');
const knowledge = require('../src/services/evolution-knowledge');
test.after(() => fs.rmSync(isolation, { recursive: true, force: true }));
const NOW = Date.parse('2026-01-05T12:00:00Z');
const SHA = 'a'.repeat(40);
function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-test-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const dataDir = path.resolve(root, 'runtime');
    const knowledgeDir = path.resolve(root, 'corpus');
    for (const dir of [dataDir, knowledgeDir]) assert.ok(dir.startsWith(`${root}${path.sep}`));
    return { dataDir, knowledgeDir, now: NOW };
}
function issue(overrides = {}) {
    return { repo: 'sample/qq-farm', kind: 'issue', number: 1, state: 'open', updatedAt: '2026-01-05T00:00:00Z',
        title: '种子识别 failure', text: '四格种子占地识别错误，plantSize must be 2. scheduler missed harvest.',
        commentsComplete: true, comments: [], ...overrides };
}
function source(overrides = {}) {
    return { repo: 'sample/qq-farm', kind: 'code', sha: SHA, path: 'src/scheduler.js', title: 'Scheduler',
        text: 'function scheduleHarvest() { /* harvest timer priority */ }', ...overrides };
}

test('Chinese and English retrieval cites fixed sources; repeated ingestion is idempotent and private', (t) => {
    const f = fixture(t);
    const result = knowledge.ingestKnowledge({ ...f, documents: [issue(), source()] });
    assert.equal(result.documentCount, 2);
    assert.equal(knowledge.ingestKnowledge({ ...f, documents: [issue(), source()] }).changed, 0);
    const chinese = knowledge.queryKnowledge({ ...f, query: '四格种子占地' });
    assert.equal(chinese.results[0].number, 1);
    assert.equal(chinese.results[0].citation, 'sample/qq-farm#1');
    const english = knowledge.queryKnowledge({ ...f, query: 'scheduleHarvest' });
    assert.equal(english.results[0].path, 'src/scheduler.js');
    assert.ok(english.results[0].citation.includes(SHA));
    assert.equal(english.results[0].review, null);
    assert.equal(fs.statSync(result.indexFile).mode & 0o777, 0o600);
    assert.equal(fs.statSync(f.knowledgeDir).mode & 0o777, 0o700);
});

test('retrieval returns the actual matching passage even when it occurs late in a source', (t) => {
    const f = fixture(t);
    const text = `${'background detail '.repeat(700)}晚段证据 duplicateharvest`;
    knowledge.ingestKnowledge({ ...f, documents: [issue({ title: 'Long report', text })] });
    const result = knowledge.queryKnowledge({ ...f, query: 'duplicateharvest', maxChars: 800 }).results[0];
    assert.match(result.text, /duplicateharvest/);
    assert.ok(result.excerptStart > 2500);
    assert.equal(result.excerptEnd - result.excerptStart, result.text.length);
});

test('updated issue state and comment versions replace evidence and invalidate only source-bound reviews', (t) => {
    const f = fixture(t);
    knowledge.ingestKnowledge({ ...f, documents: [issue(), source()] });
    const doc = knowledge.queryKnowledge({ ...f, query: '四格种子' }).results[0];
    knowledge.recordKnowledgeReview({ ...f, id: doc.id, sourceHash: doc.sourceHash, disposition: 'affected', localEvidence: 'src/local.js:test', conclusion: 'reproduced' });
    assert.equal(knowledge.getKnowledgeSummary(f).reviewedCount, 1);
    knowledge.ingestKnowledge({ ...f, documents: [issue()] });
    assert.equal(knowledge.getKnowledgeSummary(f).reviewedCount, 1);
    knowledge.ingestKnowledge({ ...f, documents: [issue({ state: 'closed', comments: [{ id: 2, updatedAt: '2026-01-05T01:00:00Z', text: 'Fixed 占地' }], commentCount: 1 })] });
    assert.equal(knowledge.getKnowledgeSummary(f).documentCount, 2);
    const updated = knowledge.queryKnowledge({ ...f, query: '四格种子' }).results[0];
    assert.equal(updated.state, 'closed');
    assert.equal(updated.review, null);
    assert.notEqual(updated.sourceHash, doc.sourceHash);
    assert.throws(() => knowledge.recordKnowledgeReview({ ...f, id: doc.id, sourceHash: doc.sourceHash, disposition: 'adopted', localEvidence: 'test', conclusion: 'x' }), /source_changed/);
});

test('invalid source paths and oversized documents fail before creating output', (t) => {
    const f = fixture(t);
    for (const file of ['../escape.js', '/tmp/escape.js', 'src/../escape.js', 'src\\escape.js']) {
        assert.throws(() => knowledge.ingestKnowledge({ ...f, documents: [source({ path: file })] }), /invalid_source_path/);
        assert.equal(fs.existsSync(f.knowledgeDir), false);
    }
    assert.throws(() => knowledge.ingestKnowledge({ ...f, documents: [source({ text: 'a'.repeat(128 * 1024 + 1) })] }), /invalid_document_text/);
    assert.equal(fs.existsSync(f.knowledgeDir), false);
});

test('private index symlinks cannot redirect writes outside the configured root', (t) => {
    const f = fixture(t);
    fs.mkdirSync(f.knowledgeDir);
    const outside = path.join(path.dirname(f.knowledgeDir), 'outside.json');
    fs.writeFileSync(outside, '{}');
    fs.symlinkSync(outside, path.join(f.knowledgeDir, 'index.json'));
    assert.throws(() => knowledge.ingestKnowledge({ ...f, documents: [issue()] }), /symlink_file/);
    assert.equal(fs.readFileSync(outside, 'utf8'), '{}');
});

function githubFixture(f, maxCalls = 7) {
    const calls = [];
    const get = async (apiPath) => {
        assert.ok(calls.length < maxCalls, 'shared budget exceeded');
        calls.push(apiPath);
        if (apiPath.startsWith('/search/issues')) return { total_count: 1, incomplete_results: false, items: [{ number: 1, state: 'open', updated_at: '2026-01-05T00:00:00Z', title: '自动化', body: '种子采集', comments: 1 }] };
        if (apiPath.includes('/comments?')) return [{ id: 2, updated_at: '2026-01-05T01:00:00Z', body: '工作流程' }];
        if (apiPath.includes('/commits?')) return [{ sha: SHA }];
        if (apiPath.includes('/git/trees/')) return { truncated: false, tree: [{ path: 'README.md', type: 'blob', size: 20 }, { path: 'src/scheduler.js', type: 'blob', size: 50 }, { path: '../escape.js', type: 'blob', size: 5 }, { path: 'run.exe', type: 'blob', size: 50 }] };
        if (apiPath.includes('/contents/')) return { type: 'file', encoding: 'base64', size: 50, content: Buffer.from('throw new Error("Do not execute external source")').toString('base64') };
        throw new Error(`unexpected ${apiPath}`);
    };
    return { ...f, candidates: [{ ownerRepo: 'sample/qq-farm', sha: SHA, stars: 14 }], seeds: [], get,
        remaining: () => maxCalls - calls.length, calls };
}

test('comment collection resumes later pages and reaches the latest discussion', async (t) => {
    const f = fixture(t);
    const pages = [];
    for (let day = 0; day < 3; day += 1) {
        const fixture = githubFixture({ ...f, now: NOW + day * 86400000 });
        const request = fixture.get;
        fixture.get = async (apiPath) => {
            if (apiPath.startsWith('/search/issues')) {
                fixture.calls.push(apiPath);
                return { total_count: 1, items: [{ number: 1, state: 'open', updated_at: '2026-01-05T00:00:00Z', title: 'Discussion', body: 'Initial issue', comments: 150 }] };
            }
            if (apiPath.includes('/comments?')) {
                fixture.calls.push(apiPath);
                const page = Number(apiPath.match(/&page=(\d+)/)[1]); pages.push(page);
                return Array.from({ length: page === 1 ? 100 : 50 }, (_, index) => ({ id: (page - 1) * 100 + index + 1,
                    updated_at: '2026-01-05T01:00:00Z', body: page === 2 ? 'Latest discussion fixedlatest' : 'Older discussion' }));
            }
            return request(apiPath);
        };
        await knowledge.collectKnowledge(fixture);
    }
    assert.deepEqual(pages, [1, 2]);
    const result = knowledge.queryKnowledge({ ...f, query: 'fixedlatest' }).results[0];
    assert.equal(result.commentsComplete, true);
    assert.match(result.text, /fixedlatest/);
    assert.equal(knowledge.getKnowledgeDocument({ ...f, id: result.id }).comments.length, 150);
});

test('issue scanning alternates recent and older pages without discarding previous issues', async (t) => {
    const f = fixture(t); const pages = [];
    for (let day = 0; day < 4; day += 1) {
        const fixture = githubFixture({ ...f, now: NOW + day * 86400000 });
        const request = fixture.get;
        fixture.get = async apiPath => {
            if (!apiPath.startsWith('/search/issues')) return request(apiPath);
            fixture.calls.push(apiPath);
            const page = Number(apiPath.match(/&page=(\d+)/)[1]); pages.push(page);
            return { total_count: 30, items: [{ number: page, state: 'open', updated_at: '2026-01-05T00:00:00Z', title: 'Sample', body: 'scheduler', comments: 0 }] };
        };
        await knowledge.collectKnowledge(fixture);
    }
    assert.deepEqual(pages, [1, 2, 1, 3]);
    assert.equal(knowledge.getKnowledgeSummary(f).issueCount, 3);
});

test('collector imports full issues, comments and fixed-SHA source as text, reuses unchanged code', async (t) => {
    const f = fixture(t);
    const first = githubFixture(f);
    const result = await knowledge.collectKnowledge(first);
    assert.equal(result.issueCount, 1);
    assert.equal(result.codeCount, 2);
    assert.equal(result.state, 'available');
    assert.ok(first.calls.filter(p => p.includes('/contents/')).every(p => p.endsWith(`ref=${SHA}`)));
    const next = githubFixture({ ...f, now: NOW + 86400000 });
    const second = await knowledge.collectKnowledge(next);
    assert.equal(second.documentCount, 3);
    assert.equal(next.calls.length, 1);
});

test('budget clipping, incomplete search and network failure preserve old evidence and pending state', async (t) => {
    const f = fixture(t);
    await knowledge.collectKnowledge(githubFixture(f));
    const before = knowledge.queryKnowledge({ ...f, query: '种子采集' }).results[0].sourceHash;
    const failed = await knowledge.collectKnowledge({ ...f, now: NOW + 86400000,
        candidates: [{ ownerRepo: 'sample/qq-farm', sha: SHA, stars: 14 }], get: async () => null, remaining: () => 1 });
    assert.equal(failed.documentCount, 3);
    assert.equal(failed.state, 'partial');
    assert.equal(knowledge.queryKnowledge({ ...f, query: '种子采集' }).results[0].sourceHash, before);
    assert.equal(knowledge.queryKnowledge({ ...f, query: '种子采集' }).results[0].freshness, 'stale');
    const partial = githubFixture({ ...f, now: NOW + 2 * 86400000 }, 1);
    partial.get = async (apiPath) => { partial.calls.push(apiPath); return { incomplete_results: true, items: [] }; };
    assert.equal((await knowledge.collectKnowledge(partial)).state, 'partial');
});

test('recent sampling and unread comments are explicit; ten-star projects excluded and pending work rotates', async (t) => {
    const f = fixture(t);
    const options = githubFixture(f, 1);
    options.candidates = [10, 14, 20].map((stars, i) => ({ ownerRepo: `sample-${i}/qq-farm`, stars, sha: SHA, updatedAt: `2026-01-0${5 - i}` }));
    options.get = async (apiPath) => { options.calls.push(apiPath); return { total_count: 11, items: [{ number: 1, state: 'open', updated_at: '2026-01-05T00:00:00Z', title: '种子', body: '', comments: 2 }] }; };
    const first = await knowledge.collectKnowledge(options);
    assert.equal(first.repositories.some(row => row.repo === 'sample-0/qq-farm'), false);
    assert.ok(first.pending.some(row => row.reason === 'issues_beyond_recent_sample'));
    assert.ok(first.pending.some(row => row.reason === 'issue_1_comments_pending'));
    const nextCalls = [];
    await knowledge.collectKnowledge({ ...options, now: NOW + 86400000, get: async p => { nextCalls.push(p); return { items: [], total_count: 0 }; }, remaining: () => 1 - nextCalls.length });
    assert.match(decodeURIComponent(nextCalls[0]), /repo:sample-2\/qq-farm/);
});

test('private CLI imports and retrieves existing raw documents without a network dependency', (t) => {
    const f = fixture(t);
    const input = path.join(path.dirname(f.dataDir), 'documents.json');
    fs.writeFileSync(input, JSON.stringify([issue()]));
    const cli = path.resolve(__dirname, '../scripts/evolution-knowledge.js');
    execFileSync(process.execPath, [cli, 'import', '--data-dir', f.dataDir, '--knowledge-dir', f.knowledgeDir, '--file', input]);
    const result = JSON.parse(execFileSync(process.execPath, [cli, 'query', '--data-dir', f.dataDir, '--knowledge-dir', f.knowledgeDir, '--query', '四格种子'], { encoding: 'utf8' }));
    assert.equal(result.results[0].number, 1);
});


test('an issue update retains unread old comments with their stale watermark and invalidates review', async (t) => {
    const f = fixture(t);
    await knowledge.collectKnowledge(githubFixture(f));
    const prior = knowledge.queryKnowledge({ ...f, query: '种子采集' }).results[0];
    knowledge.recordKnowledgeReview({ ...f, id: prior.id, sourceHash: prior.sourceHash, disposition: 'not_affected', localEvidence: 'local behavior test', conclusion: 'verified old source' });
    const update = githubFixture({ ...f, now: NOW + 86400000 });
    update.get = async apiPath => {
        update.calls.push(apiPath);
        if (apiPath.startsWith('/search/issues')) return { total_count: 1, items: [{ number: 1, state: 'closed', updated_at: '2026-01-06T00:00:00Z', title: '自动化新版', body: '种子采集更新', comments: 2 }] };
        if (apiPath.includes('/comments?')) return null;
        throw new Error('unexpected request');
    };
    await knowledge.collectKnowledge(update);
    const current = knowledge.getKnowledgeDocument({ ...f, id: prior.id });
    assert.equal(current.state, 'closed');
    assert.equal(current.comments[0].text, '工作流程');
    assert.equal(current.commentsStale, true);
    assert.equal(current.commentsFetchedAt, NOW);
    assert.equal(current.commentsComplete, false);
    assert.equal(current.review, undefined);
    assert.notEqual(current.sourceHash, prior.sourceHash);
});

test('unfinished code resumes before another issue scan and consumes the bounded next-round content budget', async (t) => {
    const f = fixture(t);
    const first = githubFixture(f, 2);
    await knowledge.collectKnowledge(first);
    assert.equal(knowledge.getKnowledgeSummary(f).codeCount, 0);
    const second = githubFixture({ ...f, now: NOW + 86400000 }, 2);
    const result = await knowledge.collectKnowledge(second);
    assert.equal(result.codeCount, 2);
    assert.equal(second.calls.length, 2);
    assert.ok(second.calls.every(apiPath => apiPath.includes('/contents/')));
    assert.ok(result.pending.some(item => item.reason === 'issues_budget_pending'));
});

test('dead owner locks recover without removing live owner locks or changing the existing corpus', (t) => {
    const f = fixture(t);
    knowledge.ingestKnowledge({ ...f, documents: [issue()] });
    const lock = path.join(f.knowledgeDir, '.write-lock');
    fs.mkdirSync(lock);
    const ownerFile = path.join(lock, 'owner-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.json');
    const childPid = Number(execFileSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }));
    fs.writeFileSync(ownerFile, JSON.stringify({ pid: childPid, host: os.hostname(), start: '' }));
    assert.equal(knowledge.ingestKnowledge({ ...f, documents: [source()] }).documentCount, 2);
    assert.equal(fs.existsSync(lock), false);
    fs.mkdirSync(lock);
    fs.writeFileSync(ownerFile, JSON.stringify({ pid: process.pid, host: os.hostname(), start: '' }));
    const before = fs.readFileSync(path.join(f.knowledgeDir, 'index.json'));
    assert.throws(() => knowledge.ingestKnowledge({ ...f, documents: [issue({ text: 'cannot write' })] }), /knowledge_locked/);
    assert.deepEqual(fs.readFileSync(path.join(f.knowledgeDir, 'index.json')), before);
    assert.equal(fs.existsSync(ownerFile), true);
});
