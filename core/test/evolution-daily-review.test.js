const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const isolatedDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farm-daily-review-import-'));
process.env.FARM_DATA_DIR = isolatedDataDir;
process.env.FARM_PRIVATE_CONFIG_FILE = path.join(isolatedDataDir, 'private-config.json');
const privacy = require('../src/services/privacy-guard');
// The tests exercise the real scanner through the learning store, but never read
// real account records or Codex/Claude credential files while collecting terms.
test.mock.method(privacy, 'collectRuntimePrivacyTerms', () => new Set());
const { runTeamWorkflow, createTeamError } = require('../src/services/evolution-team');
const { settleDailyReview } = require('../src/services/activity-evolver');
const { createDailyFeedbackStore } = require('../src/services/daily-feedback');
const { recordApprovedLessons, readLearningSummary } = require('../src/services/evolution-learning');
test.after(() => fs.rmSync(isolatedDataDir, { recursive: true, force: true }));

const BASE = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);
const lesson = rule => ({ topic: 'workflow', rule, evidence: 'regression' });
const masterLesson = lesson('Keep daily feedback until the selected main agent approves its review.');
const childLesson = lesson('A child report alone must not approve feedback cleanup.');

function workflowFixture(stageOverride) {
    const calls = [];
    const files = {};
    let committed = 0;
    const deps = {
        settings: { mainAgent: 'codex', subAgent: 'claude', dualAgentEnabled: true },
        prompt: 'Review anonymous daily feedback with the approved behavioral constraints.',
        dailyBrain: true,
        verifyBaseline: true,
        inspect: async () => ({ head: BASE, dirty: Object.keys(files).length > 0,
            fingerprint: JSON.stringify(files), files: Object.keys(files), fileFingerprints: { ...files } }),
        onProgress: async () => {},
        verify: async () => { calls.push(['verify', 'coordinator']); return { cached: false }; },
        commit: async () => { committed++; calls.push(['commit', 'coordinator']); return HEAD; },
        runStage: async (phase, agent, prompt) => {
            calls.push([phase, agent]);
            const overridden = await stageOverride?.(phase, agent, files, prompt);
            if (overridden) return overridden;
            if (phase === 'implement') files['core/src/example.js'] = 'implemented';
            return {
                decision: { triage: 'triaged', research: 'researched', plan: 'approve', implement: 'implemented',
                    review: 'approve', diagnose: 'repair', repair: 'implemented', repair_review: 'approve' }[phase],
                summary: 'Behavioral review evidence.',
                ...(phase === 'plan' ? { allowedFiles: ['core/src/example.js'], acceptanceChecks: ['Verify observable behavior.'] } : {}),
                ...(phase === 'diagnose' ? { allowedFiles: ['core/src/example.js'] } : {}),
                lessons: agent === 'codex' ? [masterLesson] : [childLesson], feedbackReviewed: true,
            };
        },
    };
    return { deps, calls, files, commits: () => committed };
}

function feedbackFixture(t) {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farm-daily-review-store-'));
    let time = Date.parse('2026-01-05T12:00:00Z');
    const store = createDailyFeedbackStore({ dataDir, now: () => time, revision: HEAD });
    const folder = path.join(dataDir, 'daily-feedback');
    const calls = [];
    const saveLessons = options => {
        calls.push(options);
        return recordApprovedLessons({ ...options, dataDir });
    };
    const recordClick = () => store.record({ kind: 'click', page: 'friends', target: 'button', trace: crypto.randomUUID() });
    recordClick();
    const batch = store.captureBatch();
    assert.ok(batch);
    const state = {
        status: 'pending_apply', dualAgentEnabled: true, mainAgent: 'codex', subAgent: 'claude',
        lastAgent: 'codex', commit: HEAD, feedbackBatch: batch, feedbackCleanupPending: false,
        collaboration: { phase: 'complete', status: 'completed', decision: 'approve', head: HEAD,
            reviewedBy: 'codex', repairOnly: false, feedbackReviewed: true, lessons: [masterLesson] },
    };
    const rows = () => fs.readdirSync(folder).filter(file => file.endsWith('.jsonl'))
        .flatMap(file => fs.readFileSync(path.join(folder, file), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)));
    const settle = (options = {}) => settleDailyReview(state, { head: HEAD, feedback: store, saveLessons, ...options });
    t.after(() => { store.flush(); fs.rmSync(dataDir, { recursive: true, force: true }); });
    return { dataDir, store, folder, calls, state, rows, settle, saveLessons, recordClick,
        advance: (ms = 1) => { time += ms; } };
}

test('daily Codex triage precedes Claude research; no-change publishes only the main plan lessons', async () => {
    const f = workflowFixture(phase => phase === 'plan' ? {
        decision: 'no_change', summary: 'Feedback reviewed; existing logic satisfies the observations.',
        allowedFiles: [], acceptanceChecks: [], lessons: [masterLesson], feedbackReviewed: true,
    } : null);
    const result = await runTeamWorkflow(f.deps);
    assert.deepEqual(f.calls, [['verify', 'coordinator'], ['triage', 'codex'], ['research', 'claude'], ['plan', 'codex']]);
    assert.equal(result.decision, 'no_change');
    assert.equal(result.head, BASE);
    assert.equal(result.feedbackReviewed, true);
    assert.deepEqual(result.lessons, [masterLesson]);
    assert.equal(f.commits(), 0);
});

test('final main review supersedes plan and child reports for lessons and cleanup authority', async () => {
    const finalLesson = lesson('Use the final reviewed candidate rather than intermediate reports.');
    const f = workflowFixture(phase => phase === 'review' ? {
        decision: 'approve', summary: 'The code passes; some daily observations still need investigation.',
        lessons: [finalLesson], feedbackReviewed: false,
    } : null);
    const result = await runTeamWorkflow(f.deps);
    assert.equal(result.decision, 'approve');
    assert.equal(result.feedbackReviewed, false);
    assert.deepEqual(result.lessons, [finalLesson]);
    assert.equal(f.commits(), 1);
    assert.deepEqual(f.calls.slice(-4), [['implement', 'claude'], ['verify', 'coordinator'], ['review', 'codex'], ['commit', 'coordinator']]);
});

test('rejected main reviews never return approved lessons or commit a candidate', async () => {
    const f = workflowFixture(phase => phase === 'review' ? {
        decision: 'reject', summary: 'A required behavior remains unverified.', lessons: [masterLesson], feedbackReviewed: true,
    } : null);
    await assert.rejects(runTeamWorkflow(f.deps), error => {
        assert.equal(error.code, 'recovery_exhausted');
        assert.equal(error.feedbackReviewed, undefined);
        assert.equal(error.lessons, undefined);
        return true;
    });
    assert.equal(f.calls.filter(([phase]) => phase === 'review').length, 3);
    assert.equal(f.commits(), 0);
});

test('repair-only orchestration approval cannot claim the original feedback or export lessons', async () => {
    const repairedFile = 'core/scripts/run-evolution-team.js';
    const f = workflowFixture((phase, _agent, files) => {
        if (phase === 'research') throw createTeamError('invalid_output');
        if (phase === 'diagnose') return { decision: 'repair', summary: 'Repair the handoff contract.', allowedFiles: [repairedFile] };
        if (phase === 'repair') files[repairedFile] = 'repaired';
        return null;
    });
    const result = await runTeamWorkflow(f.deps);
    assert.equal(result.decision, 'approve');
    assert.equal(result.repairOnly, true);
    assert.equal(result.feedbackReviewed, false);
    assert.deepEqual(result.lessons, []);
    assert.equal(f.calls.some(([phase]) => phase === 'plan'), false);
    assert.equal(f.commits(), 1);
});

test('approved daily settlement saves real lessons and physically clears only the reviewed watermark', t => {
    const f = feedbackFixture(t);
    const cutoff = f.state.feedbackBatch.throughAt;
    f.advance();
    f.recordClick();
    assert.equal(f.store.flush(), true);
    assert.equal(f.rows().length, 2);
    assert.equal(f.settle(), true);
    assert.equal(f.state.feedbackBatch, null);
    assert.equal(f.state.feedbackCleanupPending, false);
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].mainAgent, 'codex');
    assert.equal(f.calls[0].writerAgent, 'codex');
    assert.equal(readLearningSummary(f.dataDir).count, 1);
    assert.deepEqual(f.rows().map(row => row.at), [cutoff + 1]);
    assert.equal(f.settle(), true);
    assert.equal(f.calls.length, 1, 'receipt prevents duplicate knowledge persistence');
    assert.equal(f.rows().length, 1);
});

test('failed, private, unpublished, unapproved, stale-head and repair-only candidates do not settle', t => {
    const f = feedbackFixture(t);
    const base = structuredClone(f.state);
    const patches = [
        { status: 'failed' }, { status: 'review_blocked' }, { status: 'privacy_blocked_local' }, { status: 'push_failed' },
        { dualAgentEnabled: false }, { collaboration: { ...base.collaboration, phase: 'review' } },
        { collaboration: { ...base.collaboration, status: 'running' } },
        { collaboration: { ...base.collaboration, decision: 'reject' } },
        { collaboration: { ...base.collaboration, head: 'c'.repeat(40) } },
        { collaboration: { ...base.collaboration, repairOnly: true } },
        { collaboration: { ...base.collaboration, reviewedBy: 'claude' } },
    ];
    for (const patch of patches) {
        Object.assign(f.state, structuredClone(base), patch);
        assert.equal(f.settle(), false, JSON.stringify(patch));
        assert.deepEqual(f.state.feedbackBatch, base.feedbackBatch);
        assert.equal(f.calls.length, 0);
        assert.equal(f.rows().length, 1);
    }
    Object.assign(f.state, structuredClone(base));
    assert.equal(f.settle({ head: 'd'.repeat(40) }), false, 'current HEAD must match the reviewed candidate even when state.commit matches it');
    assert.equal(f.calls.length, 0);
    assert.equal(f.rows().length, 1);
});

test('busy feedback disk retains the batch and retries cleanup without saving the same lessons twice', t => {
    const f = feedbackFixture(t);
    const batch = structuredClone(f.state.feedbackBatch);
    const lock = path.join(f.folder, '.write.lock');
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, nonce: crypto.randomUUID() }));
    assert.equal(f.settle(), false);
    assert.deepEqual(f.state.feedbackBatch, batch);
    assert.equal(f.state.feedbackCleanupPending, true);
    assert.equal(f.calls.length, 1);
    assert.equal(f.rows().length, 1);
    fs.unlinkSync(lock);
    assert.equal(f.settle(), true);
    assert.equal(f.state.feedbackBatch, null);
    assert.equal(f.state.feedbackCleanupPending, false);
    assert.equal(f.calls.length, 1);
    assert.equal(f.rows().length, 0);
});

test('failed knowledge persistence and rejected lesson privacy preserve feedback before cleanup', t => {
    const f = feedbackFixture(t);
    const batch = structuredClone(f.state.feedbackBatch);
    assert.equal(f.settle({ saveLessons: () => { throw new Error('storage unavailable'); } }), false);
    assert.deepEqual(f.state.feedbackBatch, batch);
    assert.equal(f.state.feedbackCleanupPending, true);
    assert.equal(f.rows().length, 1);
    assert.equal(f.state.learningReceipt, undefined);
    f.state.collaboration.lessons = [lesson(['https:', '', 'example.invalid', 'private'].join('/'))];
    assert.equal(f.settle(), false);
    assert.deepEqual(f.state.feedbackBatch, batch);
    assert.equal(f.rows().length, 1);
    assert.equal(readLearningSummary(f.dataDir).count, 0);
    f.state.collaboration.lessons = [masterLesson];
    assert.equal(f.settle(), true);
    assert.equal(f.state.feedbackBatch, null);
    assert.equal(f.rows().length, 0);
});

test('old journals and explicit unfinished feedback retain observations; verified no-change may settle', t => {
    const f = feedbackFixture(t);
    const batch = structuredClone(f.state.feedbackBatch);
    for (const reviewed of [undefined, false]) {
        f.state.collaboration.feedbackReviewed = reviewed;
        assert.equal(f.settle(), true);
        assert.deepEqual(f.state.feedbackBatch, batch);
        assert.equal(f.rows().length, 1);
    }
    f.state.status = 'no_change';
    f.state.commit = '';
    f.state.collaboration.decision = 'no_change';
    f.state.collaboration.feedbackReviewed = true;
    assert.equal(f.settle(), true);
    assert.equal(f.state.feedbackBatch, null);
    assert.equal(f.rows().length, 0);
});
