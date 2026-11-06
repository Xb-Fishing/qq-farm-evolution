const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { test, after } = require('node:test');
const tempRoot = path.resolve(os.tmpdir());
const prefix = path.resolve(tempRoot, 'farm-main-workflow-');
assert.ok(prefix.startsWith(tempRoot + path.sep));
const root = fs.mkdtempSync(prefix);
process.env.FARM_DATA_DIR = root;
const { runMainOwnedWorkflow } = require('../src/services/evolution-main-workflow');
const { createTeamError } = require('../src/services/evolution-team');
const sourceFiles = [__filename, '../src/services/evolution-main-workflow.js', '../scripts/run-evolution-team.js',
    '../src/services/evolution-team.js'].map(file => path.resolve(__dirname, file));
const fingerprint = () => sourceFiles.map(file => ({ file, mode: fs.statSync(file).mode & 0o777,
    hash: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') }));
const before = fingerprint();
after(() => {
    try { fs.rmSync(root, { recursive: true, force: true }); }
    finally { assert.deepEqual(fingerprint(), before); }
});
const HEAD = 'a'.repeat(40);
const FILE = 'core/src/example.js';
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
let number = 0;
function fixture() {
    const directory = path.resolve(root, `case-${++number}`);
    assert.ok(directory.startsWith(root + path.sep));
    fs.mkdirSync(directory);
    const files = new Map([[FILE, 'original']]);
    const original = new Map(files);
    let head = HEAD;
    let handler;
    let closed = 0;
    let commits = 0;
    let verifies = 0;
    const checkpoints = [];
    const progress = [];
    const f = {
        directory, files, checkpoints, progress,
        plan: { summary: 'Change one exact caller', allowedFiles: [FILE], acceptanceChecks: ['caller behavior'], baselineChecks: [] },
        call: (name, args = {}, context = {}) => handler(name, args, context),
        edit: (file, text) => files.set(file, text),
        get closed() { return closed; }, get commits() { return commits; }, get verifies() { return verifies; },
        moveHead: () => { head = 'c'.repeat(40); },
    };
    f.options = {
        settings: { mainAgent: 'codex', subAgent: 'claude' }, prompt: 'task', baseCommit: HEAD,
        task: 'activity', dataDir: directory, logDir: path.join(directory, 'logs'), runId: 'fixture', roundId: 'round',
        inspect: async () => {
            const changed = [...new Set([...files.keys(), ...original.keys()])].filter(file => files.get(file) !== original.get(file));
            return { head, files: changed, dirty: !!changed.length, fingerprint: sha(JSON.stringify([...files])),
                fileFingerprints: Object.fromEntries(changed.map(file => [file, sha(files.get(file) || '')])) };
        },
        verify: async () => { verifies += 1; return { fingerprint: 'd'.repeat(64), checkedAt: 1,
            checks: ['backend', 'frontend'], countercheck: { state: 'not_required', checks: [] } }; },
        commit: async () => { commits += 1; return 'b'.repeat(40); },
        onCheckpoint: async value => checkpoints.push(JSON.parse(JSON.stringify(value))),
        onProgress: async (phase, agent, details) => progress.push({ phase, agent, ...details }),
        createBridge: async options => { handler = options.handler; return {
            mcp: { command: 'fixture', args: [] }, close: async () => { closed += 1; },
        }; },
        runWorker: async () => ({ decision: 'no_change', summary: 'Nothing changed' }),
        runMain: async () => { throw new Error('assign a Main test'); },
    };
    return f;
}
async function accept(f, decision = 'approve') {
    assert.equal((await f.call('verify_candidate')).isError, false);
    const seal = await f.call('accept_result', { decision, summary: 'Main checked actual results', lessons: [], feedbackReviewed: false, githubResolutions: [] });
    assert.equal(seal.isError, false);
    return { decision: JSON.parse(seal.content[0].text).decision, summary: 'Main finished' };
}
function deferred() {
    let resolve; let reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

test('clean candidates cannot bypass the eight-area zero-change audit by asking for approve', async () => {
    const f = fixture(); f.options.requireNoChangeAudit = true;
    const file = path.resolve(f.directory, 'zero-change-evidence.json');
    assert.ok(file.startsWith(f.directory + path.sep)); fs.writeFileSync(file, '{}');
    const audit = require('../src/services/evolution-no-change-audit');
    f.options.runMain = async ({ prompt }) => {
        assert.match(prompt, /review_no_change/);
        await f.call('verify_candidate');
        const args = { decision: 'approve', summary: 'Clean candidate', lessons: [], feedbackReviewed: false, githubResolutions: [] };
        assert.equal(JSON.parse((await f.call('accept_result', args)).content[0].text).state, 'no_change_audit_required');
        const checked = await f.call('review_no_change', { checks: audit.AREAS.map(area => ({ area, status: 'checked',
            conclusion: 'Bounded source evidence checked', evidencePaths: [file] })) });
        assert.equal(checked.isError, false);
        assert.equal((await f.call('accept_result', args)).isError, false);
        return { decision: 'no_change', summary: 'Eight areas actually recorded' };
    };
    assert.equal((await runMainOwnedWorkflow(f.options)).decision, 'no_change');
});

function investigationFixture(f, question = 'Uncertain natural failure') {
    const file = path.resolve(f.directory, 'investigation-evidence.json');
    assert.ok(file.startsWith(f.directory + path.sep)); fs.writeFileSync(file, '{"observed":true}');
    return { area: 'uncertain_incidents', status: 'monitoring', conclusion: 'Investigated; natural response still missing', evidencePaths: [file],
        followup: { question, ruledOut: ['Known offline guard excluded'], missing: 'First failing natural response',
            signal: 'Existing runtime error event', resolveWhen: 'Identify the stage and verify its fix',
            mechanism: 'daily_log_review', nextCheckAt: Date.now() + 86400000 } };
}

test('repair rounds cannot clear pending feedback; failed or unpublished resolutions retain investigations', async () => {
    const audit = require('../src/services/evolution-no-change-audit');
    for (const ending of ['interrupted', 'accepted', 'commit_failed']) {
        const f = fixture(); f.options.requireNoChangeAudit = true;
        const question = investigationFixture(f);
        if (ending === 'commit_failed') f.options.commit = async () => { throw createTeamError('publish_failed'); };
        f.options.runMain = async () => {
            await f.call('approve_plan', f.plan); f.edit(FILE, 'fixed candidate');
            await f.call('record_investigation', question);
            const pending = audit.getInvestigationFollowups(f.directory).pending[0];
            await f.call('verify_candidate');
            const proposal = await f.call('review_investigation', { id: pending.id, status: 'resolved',
                conclusion: 'Candidate has a tested repair, publication still needed', evidencePaths: question.evidencePaths });
            assert.equal(JSON.parse(proposal.content[0].text).status, 'resolution_proposed');
            assert.equal(audit.getInvestigationFollowups(f.directory).pending.length, 1);
            if (ending === 'interrupted') throw createTeamError('cli_exit');
            const args = { decision: 'approve', summary: 'Partial repair; followup retained', lessons: [], githubResolutions: [] };
            assert.equal(JSON.parse((await f.call('accept_result', { ...args, feedbackReviewed: true })).content[0].text).state, 'investigations_pending');
            assert.equal((await f.call('accept_result', { ...args, feedbackReviewed: false })).isError, false);
            return { decision: 'approve', summary: args.summary };
        };
        if (ending === 'accepted') assert.equal((await runMainOwnedWorkflow(f.options)).feedbackReviewed, false);
        else await assert.rejects(runMainOwnedWorkflow(f.options));
        assert.equal(audit.getInvestigationFollowups(f.directory).pending.length, 1, ending);
    }
});

test('clean baseline resolutions finalize only after Main returns a matching accepted result', async () => {
    const audit = require('../src/services/evolution-no-change-audit');
    for (const abortAfterSeal of [true, false]) {
        const f = fixture(); f.options.requireNoChangeAudit = true;
        const question = investigationFixture(f);
        f.options.runMain = async () => {
            await f.call('record_investigation', question);
            const pending = audit.getInvestigationFollowups(f.directory).pending[0];
            await f.call('verify_candidate');
            await f.call('review_investigation', { id: pending.id, status: 'resolved', conclusion: 'Current unchanged baseline evidence explains the incident', evidencePaths: question.evidencePaths });
            await f.call('review_no_change', { checks: audit.AREAS.map(area => ({ area, status: 'checked', conclusion: 'Actual source snapshot checked', evidencePaths: question.evidencePaths })) });
            assert.equal((await f.call('accept_result', { decision: 'no_change', summary: 'Clean baseline investigation complete', lessons: [], githubResolutions: [], feedbackReviewed: true })).isError, false);
            assert.equal(audit.getInvestigationFollowups(f.directory).pending.length, 1, 'seal alone is not finalization');
            if (abortAfterSeal) throw createTeamError('cli_exit');
            return { decision: 'no_change', summary: 'Accepted baseline confirmed' };
        };
        if (abortAfterSeal) await assert.rejects(runMainOwnedWorkflow(f.options));
        else assert.equal((await runMainOwnedWorkflow(f.options)).feedbackReviewed, true);
        assert.equal(audit.getInvestigationFollowups(f.directory).pending.length, abortAfterSeal ? 1 : 0);
    }
});

test('changing a proposed resolution back to monitoring cancels it and permits truthful partial acceptance', async () => {
    const audit = require('../src/services/evolution-no-change-audit');
    for (const via of ['review', 'registration', 'registration_whitespace', 'audit']) {
        const f = fixture(); f.options.requireNoChangeAudit = true;
        const question = investigationFixture(f);
        f.options.runMain = async () => {
            await f.call('record_investigation', question);
            const pending = audit.getInvestigationFollowups(f.directory).pending[0];
            await f.call('verify_candidate');
            await f.call('review_investigation', { id: pending.id, status: 'resolved', conclusion: 'Initial resolution hypothesis', evidencePaths: question.evidencePaths });
            if (via === 'review') await f.call('review_investigation', { id: pending.id, status: 'monitoring',
                conclusion: 'Further inspection requires a natural event', evidencePaths: question.evidencePaths, nextCheckAt: Date.now() + 2 * 86400000 });
            if (via === 'registration') await f.call('record_investigation', question);
            if (via === 'registration_whitespace') await f.call('record_investigation', { ...question,
                followup: { ...question.followup, question: `  ${question.followup.question}  ` } });
            await f.call('review_no_change', { checks: audit.AREAS.map(area => area === question.area && via === 'audit' ? question
                : { area, status: 'checked', conclusion: 'Current source checked', evidencePaths: question.evidencePaths }) });
            assert.equal((await f.call('accept_result', { decision: 'no_change', summary: 'No code change; monitoring continues',
                lessons: [], githubResolutions: [], feedbackReviewed: false })).isError, false);
            return { decision: 'no_change', summary: 'Monitoring continues' };
        };
        const result = await runMainOwnedWorkflow(f.options);
        assert.equal(result.feedbackReviewed, false);
        assert.match(result.mainSummary, /1项调查未结案/);
        assert.equal(audit.getInvestigationFollowups(f.directory).pending.length, 1, via);
    }
});

test('a large overdue backlog remains readable without preventing Main startup', async () => {
    const f = fixture(); f.options.requireNoChangeAudit = true;
    const audit = require('../src/services/evolution-no-change-audit');
    const now = Date.now() - 86400000;
    for (let i = 0; i < 30; i += 1) {
        const question = investigationFixture(f, `${i} ${'evidence gap '.repeat(130)}`);
        audit.recordInvestigation({ ...question, dataDir: f.directory, sourceRoot: f.directory, now, runId: 'old-run',
            fingerprint: 'a'.repeat(64), followup: { ...question.followup, nextCheckAt: now + 1000 } });
    }
    let started = false;
    f.options.runMain = async ({ prompt }) => {
        started = true; assert.ok(prompt.length < 48 * 1024);
        assert.match(prompt, /"dueCount":30/);
        const reply = JSON.parse((await f.call('status')).content[0].text);
        const status = reply.artifact ? JSON.parse(fs.readFileSync(reply.artifact, 'utf8')) : reply;
        assert.equal(status.investigations.due.length, 30);
        throw createTeamError('cli_exit');
    };
    await assert.rejects(runMainOwnedWorkflow(f.options));
    assert.equal(started, true);
    assert.equal(audit.getInvestigationFollowups(f.directory).due.length, 30);
});

test('required independent issue reader cannot be replaced by ordinary research or a success claim', async () => {
    const f = fixture();
    f.options.requireExternalReview = true;
    f.options.runMain = async () => {
        await f.call('delegate_worker', { instruction: 'Ordinary research', readOnly: true });
        await f.call('verify_candidate');
        const rejected = await f.call('accept_result', { decision: 'no_change', summary: 'Claim success', externalReviewAcknowledged: true });
        assert.equal(JSON.parse(rejected.content[0].text).state, 'external_review_required');
        const missing = await f.call('delegate_worker', { instruction: 'No actual report', readOnly: true, purpose: 'external_issues' });
        assert.equal(missing.isError, true);
        f.options.runWorker = async () => ({ decision: 'no_change', summary: 'not used' });
        throw createTeamError('cli_exit');
    };
    await assert.rejects(runMainOwnedWorkflow(f.options));
    assert.equal(f.commits, 0);
});

test('actual independent report needs Main acknowledgment and stays incomplete when sources unavailable', async () => {
    const f = fixture();
    f.options.requireExternalReview = true;
    f.options.runWorker = async ({ prompt }) => {
        const evidenceFile = prompt.match(/仅可将本任务证据写入 (.*?)。/)[1];
        assert.ok(path.resolve(evidenceFile).startsWith(f.directory + path.sep));
        fs.writeFileSync(evidenceFile, JSON.stringify({ state: 'unavailable', summary: 'Source unavailable', findings: [], gaps: ['GitHub source unavailable'] }), { mode: 0o600 });
        return { decision: 'no_change', summary: 'Incomplete evidence kept' };
    };
    f.options.runMain = async ({ prompt }) => {
        assert.match(prompt, /purpose="external_issues"/);
        assert.equal((await f.call('delegate_worker', { instruction: 'Independent issues', readOnly: true, purpose: 'external_issues' })).isError, false);
        await f.call('verify_candidate');
        const args = { decision: 'no_change', summary: 'No change; external source unavailable', lessons: [], feedbackReviewed: false, githubResolutions: [] };
        assert.equal((await f.call('accept_result', args)).isError, true);
        assert.equal((await f.call('accept_result', { ...args, externalReviewAcknowledged: true })).isError, false);
        const status = JSON.parse((await f.call('status')).content[0].text);
        assert.equal(status.externalReview.state, 'unavailable');
        assert.deepEqual(status.externalReview.gaps, ['GitHub source unavailable']);
        return { decision: 'no_change', summary: args.summary };
    };
    const result = await runMainOwnedWorkflow(f.options);
    assert.equal(result.decision, 'no_change');
});

test('source-cited external findings require Main local comparison and become stale after candidate edits', async () => {
    const f = fixture();
    f.options.requireExternalReview = true;
    const knowledge = require('../src/services/evolution-knowledge');
    knowledge.ingestKnowledge({ dataDir: f.directory, documents: [{ repo: 'fixture/example', kind: 'issue', number: 1,
        title: 'scheduler', text: 'duplicate scheduling', state: 'open', updatedAt: '2026-01-01T00:00:00Z', commentsComplete: true }] });
    const doc = knowledge.queryKnowledge({ dataDir: f.directory, query: 'scheduler' }).results[0];
    f.options.runWorker = async ({ prompt }) => {
        const file = prompt.match(/仅可将本任务证据写入 (.*?)。/)[1];
        assert.ok(path.resolve(file).startsWith(f.directory + path.sep));
        fs.writeFileSync(file, JSON.stringify({ state: 'complete', summary: 'Read the sampled issue and local caller', gaps: [],
            findings: [{ id: doc.id, sourceHash: doc.sourceHash, disposition: 'not_affected', localEvidence: FILE, conclusion: 'Caller is different' }] }), { mode: 0o600 });
        return { decision: 'no_change', summary: 'Actual cited report' };
    };
    f.options.runMain = async () => {
        await f.call('approve_plan', f.plan);
        await f.call('delegate_worker', { instruction: 'Read cached issue', readOnly: true, purpose: 'external_issues' });
        await f.call('verify_candidate');
        const args = { decision: 'no_change', summary: 'Main acceptance', lessons: [], feedbackReviewed: false, githubResolutions: [], externalReviewAcknowledged: true };
        assert.equal(JSON.parse((await f.call('accept_result', args)).content[0].text).state, 'external_review_unadopted');
        await f.call('record_knowledge_review', { id: doc.id, sourceHash: doc.sourceHash, disposition: 'not_affected', localEvidence: FILE, conclusion: 'Main checked actual caller' });
        assert.equal((await f.call('accept_result', args)).isError, false);
        f.edit(FILE, 'later source');
        await f.call('verify_candidate');
        assert.equal(JSON.parse((await f.call('accept_result', { ...args, decision: 'approve' })).content[0].text).state, 'external_review_required');
        throw createTeamError('cli_exit');
    };
    await assert.rejects(runMainOwnedWorkflow(f.options));
    assert.equal(f.commits, 0);
});

test('known unread comments cannot be hidden by a complete report, while explicit partial findings remain usable', async () => {
    const f = fixture(); f.options.requireExternalReview = true;
    const knowledge = require('../src/services/evolution-knowledge');
    knowledge.ingestKnowledge({ dataDir: f.directory, documents: [{ repo: 'fixture/example', kind: 'issue', number: 1,
        title: 'scheduler', text: 'report', state: 'open', updatedAt: '2026-01-01T00:00:00Z', commentCount: 5, commentsComplete: false }] });
    const doc = knowledge.queryKnowledge({ dataDir: f.directory, query: 'scheduler' }).results[0];
    const finding = { id: doc.id, sourceHash: doc.sourceHash, disposition: 'pending', localEvidence: FILE, conclusion: 'Five comments unread' };
    let partial = false;
    f.options.runWorker = async ({ prompt }) => {
        const file = prompt.match(/仅可将本任务证据写入 (.*?)。/)[1];
        assert.ok(path.resolve(file).startsWith(f.directory + path.sep));
        fs.writeFileSync(file, JSON.stringify({ state: partial ? 'partial' : 'complete', summary: 'Issue compared with caller', findings: [finding], gaps: partial ? ['Five comments unread'] : [] }), { mode: 0o600 });
        return { decision: 'no_change', summary: 'Reader result' };
    };
    f.options.runMain = async () => {
        const args = { instruction: 'Read current issue', readOnly: true, purpose: 'external_issues' };
        assert.equal((await f.call('delegate_worker', args)).isError, true);
        partial = true;
        assert.equal((await f.call('delegate_worker', args)).isError, false);
        await f.call('record_knowledge_review', finding);
        await f.call('verify_candidate');
        assert.equal((await f.call('accept_result', { decision: 'no_change', summary: 'No local defect proven; unread comments retained',
            lessons: [], feedbackReviewed: false, githubResolutions: [], externalReviewAcknowledged: true })).isError, false);
        return { decision: 'no_change', summary: 'Known evidence gap preserved' };
    };
    const result = await runMainOwnedWorkflow(f.options);
    assert.equal(result.decision, 'no_change');
});
async function within(promise) {
    let timer;
    try {
        return await Promise.race([promise, new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('missing explicit research readiness')), 3000);
        })]);
    } finally { clearTimeout(timer); }
}
async function researchReady(ready, calls) {
    let started = false;
    const actualReady = ready.then(() => { started = true; });
    await within(Promise.race([actualReady, ...calls.map(call => call.then(reply => {
        if (!started) assert.equal(reply.isError, false, 'parallel read-only research must start instead of returning busy');
        return actualReady;
    }))]));
}

test('parallel research before approval keeps separate evidence and excludes writers until every reader settles', async () => {
    const f = fixture(); const started = deferred(); const gates = new Map(); const ids = [];
    let saving = 0;
    f.options.onCheckpoint = async value => {
        saving += 1;
        assert.equal(saving, 1, 'checkpoint callbacks never overlap or overwrite newer evidence');
        await new Promise(resolve => setImmediate(resolve));
        f.checkpoints.push(JSON.parse(JSON.stringify(value)));
        saving -= 1;
    };
    f.options.runWorker = async ({ invocationId, prompt, signal, allowedFiles }) => {
        assert.ok(prompt.length <= 6000);
        if (allowedFiles.length) {
            f.edit(FILE, 'approved initial implementation');
            return { decision: 'implemented', summary: 'Only the approved initial write' };
        }
        if (invocationId.startsWith('research-')) {
            assert.match(prompt, /固定版本/); assert.match(prompt, /总 GitHub 请求预算/);
        }
        const gate = deferred(); gates.set(invocationId, gate); ids.push(invocationId);
        const cancelled = () => gate.reject(createTeamError('cli_exit'));
        if (signal.aborted) cancelled();
        else signal.addEventListener('abort', cancelled, { once: true });
        if (ids.length === 2) started.resolve();
        await gate.promise;
        return { decision: 'no_change', summary: `Evidence for ${invocationId}` };
    };
    f.options.runMain = async ({ prompt }) => {
        const first = f.call('delegate_worker', { instruction: 'Compare fixed source A', readOnly: true });
        const second = f.call('delegate_worker', { instruction: 'Inspect independent source B', readOnly: true });
        try {
            await researchReady(started.promise, [first, second]);
            assert.deepEqual(ids, ['research-1', 'research-2']);
            const before = JSON.parse((await f.call('status')).content[0].text);
            assert.equal(before.activeResearch, 2); assert.equal(before.initialWorkerInvoked, false);
            assert.deepEqual(before.allowedFiles, []);
            gates.get('research-2').resolve();
            assert.equal((await second).isError, false);
            for (const [name, args] of [['approve_plan', f.plan], ['delegate_worker', { instruction: 'Cannot write while research runs' }],
                ['verify_candidate', {}], ['accept_result', { decision: 'no_change', summary: 'Cannot seal pending research' }],
                ['record_iteration', { cause: 'Cannot mutate task metadata yet', changes: [], remainingIssues: [], nextStep: 'wait' }]]) {
                assert.equal(JSON.parse((await f.call(name, args)).content[0].text).code, 'busy');
            }
            assert.equal(JSON.parse((await f.call('status')).content[0].text).activeResearch, 1,
                'a completed reader and rejected writers cannot release another reader');
            gates.get('research-1').resolve();
            assert.equal((await first).isError, false);
        } finally { for (const gate of gates.values()) gate.resolve(); }
        assert.match(prompt, /你自主决定是否委派、任务拆分和子 Agent 数量/);
        assert.match(prompt, /你也必须等待所有研究 settle 后再直接修改源码/);
        const researchCheckpoint = f.checkpoints.at(-1);
        assert.equal(researchCheckpoint.mainWorkflow.workerInvocations, 0);
        assert.equal(researchCheckpoint.mainWorkflow.researchInvocations, 2);
        assert.equal(researchCheckpoint.completed.some(item => item.phase === 'implement'), false);
        const evidence = ids.map(id => JSON.parse(fs.readFileSync(path.join(f.directory, 'logs/main-fixture', `${id}-scope.json`))));
        assert.notEqual(evidence[0].evidenceFile, evidence[1].evidenceFile);
        for (const { evidenceFile } of evidence) {
            assert.ok(evidenceFile.startsWith(path.resolve(f.directory, 'logs/main-fixture') + path.sep));
            assert.equal(fs.statSync(evidenceFile).mode & 0o777, 0o600);
        }
        assert.equal((await f.call('approve_plan', f.plan)).isError, false);
        assert.equal((await f.call('delegate_worker', { instruction: 'Perform the one initial write' })).isError, false);
        return accept(f);
    };
    assert.equal((await runMainOwnedWorkflow(f.options)).decision, 'approve');
    assert.equal(f.checkpoints.at(-1).mainWorkflow.workerInvocations, 1);
    assert.equal(f.checkpoints.at(-1).mainWorkflow.researchInvocations, 2);
    const sequences = f.checkpoints.map(value => value.mainWorkflow.memory.sequence);
    assert.deepEqual(sequences, [...sequences].sort((a, b) => a - b));
    assert.equal(f.commits, 1);
});

test('failed research preserves implementation and validation while Main must explicitly accept its later evidence', async () => {
    const f = fixture();
    f.options.runWorker = async ({ allowedFiles }) => {
        if (!allowedFiles.length) throw createTeamError('cli_exit', { exitCode: 1 });
        f.edit(FILE, 'actual worker change');
        return { decision: 'implemented', summary: 'The completed initial implementation' };
    };
    f.options.runMain = async () => {
        const failed = await f.call('delegate_worker', { instruction: 'Report a missing reference honestly', readOnly: true });
        assert.equal(failed.isError, true);
        assert.equal(JSON.parse(failed.content[0].text).state, 'research_failed');
        const before = JSON.parse((await f.call('status')).content[0].text);
        assert.equal(before.initialWorkerInvoked, false); assert.equal(before.lastFailure, null);
        await f.call('approve_plan', f.plan);
        assert.equal((await f.call('delegate_worker', { instruction: 'Write the approved implementation' })).isError, false);
        await accept(f);
        const sealed = f.checkpoints.at(-1);
        assert.equal((await f.call('delegate_worker', { instruction: 'An optional later comparison fails', readOnly: true })).isError, true);
        const after = f.checkpoints.at(-1);
        assert.deepEqual(after.completed, sealed.completed);
        assert.equal(after.validationDigest, sealed.validationDigest);
        assert.equal(after.lastFailure, sealed.lastFailure);
        assert.equal(after.mainWorkflow.workerInvocations, 1);
        assert.equal(after.mainWorkflow.researchInvocations, 2);
        const resealed = await f.call('accept_result', { decision: 'approve', summary: 'Main reviewed the failed optional research and retained the verified change' });
        assert.equal(resealed.isError, false, 'unchanged source validation is reusable for a fresh Main acceptance');
        return { decision: JSON.parse(resealed.content[0].text).decision, summary: 'Main explicitly accepted the complete evidence' };
    };
    assert.equal((await runMainOwnedWorkflow(f.options)).decision, 'approve');
    assert.equal(f.verifies, 1); assert.equal(f.commits, 1);
});

test('later research cannot reuse a seal made before Main evaluated that research', async () => {
    for (const failedResearch of [false, true]) {
        const f = fixture();
        f.options.runWorker = async () => {
            if (failedResearch) throw createTeamError('cli_exit');
            return { decision: 'no_change', summary: 'Later source evidence needs Main judgment' };
        };
        f.options.runMain = async () => {
            const stale = await accept(f, 'no_change');
            const research = await f.call('delegate_worker', { instruction: 'Research after the old seal', readOnly: true });
            assert.equal(research.isError, failedResearch);
            assert.equal(JSON.parse(research.content[0].text).acceptanceRequired, true);
            return stale;
        };
        await assert.rejects(runMainOwnedWorkflow(f.options), { code: 'review_rejected' });
        assert.equal(f.verifies, 1); assert.equal(f.commits, 0);
    }
});

test('cancelling one research returns its failure without releasing a still-running sibling or implementation permission', async () => {
    const f = fixture(); const started = deferred(); const release = deferred(); const cancel = new AbortController(); let readers = 0;
    f.options.runWorker = async ({ signal, invocationId }) => {
        readers += 1; if (readers === 2) started.resolve();
        if (invocationId === 'research-1') await new Promise((_, reject) => {
            const cancelled = () => reject(createTeamError('cli_exit'));
            if (signal.aborted) cancelled();
            else signal.addEventListener('abort', cancelled, { once: true });
        });
        else await release.promise;
        return { decision: 'no_change', summary: 'Independent sibling evidence' };
    };
    f.options.runMain = async () => {
        const first = f.call('delegate_worker', { instruction: 'This query is cancelled', readOnly: true }, { signal: cancel.signal });
        const second = f.call('delegate_worker', { instruction: 'This independent query continues', readOnly: true });
        try {
            await researchReady(started.promise, [first, second]); cancel.abort();
            assert.equal((await first).isError, true);
            const status = JSON.parse((await f.call('status')).content[0].text);
            assert.equal(status.activeResearch, 1); assert.equal(status.initialWorkerInvoked, false); assert.equal(status.lastFailure, null);
            assert.equal(JSON.parse((await f.call('approve_plan', f.plan)).content[0].text).code, 'busy');
            assert.equal(JSON.parse((await f.call('accept_result', { decision: 'no_change', summary: 'Cannot seal a sibling task' })).content[0].text).code, 'busy');
            release.resolve(); assert.equal((await second).isError, false);
        } finally { cancel.abort(); release.resolve(); }
        return accept(f, 'no_change');
    };
    assert.equal((await runMainOwnedWorkflow(f.options)).decision, 'no_change');
    assert.equal(f.checkpoints.at(-1).mainWorkflow.workerInvocations, 0);
});

test('failed initial implementation still permits read-only help while Main retains all write repairs', async () => {
    const f = fixture();
    f.options.runWorker = async ({ allowedFiles }) => {
        if (!allowedFiles.length) return { decision: 'no_change', summary: 'Read the exact failed caller' };
        f.edit(FILE, 'partial write'); throw createTeamError('cli_exit', { exitCode: 1 });
    };
    f.options.runMain = async () => {
        await f.call('approve_plan', f.plan);
        assert.equal((await f.call('delegate_worker', { instruction: 'Initial implementation fails' })).isError, true);
        const prior = JSON.parse((await f.call('status')).content[0].text).lastFailure;
        assert.equal((await f.call('delegate_worker', { instruction: 'Read evidence for Main to repair', readOnly: true })).isError, false);
        assert.deepEqual(JSON.parse((await f.call('status')).content[0].text).lastFailure, prior);
        const refused = await f.call('delegate_worker', { instruction: 'Cannot delegate a write repair' });
        assert.equal(JSON.parse(refused.content[0].text).code, 'main_repair_required');
        f.edit(FILE, 'Main repaired after reading the evidence');
        return accept(f);
    };
    assert.equal((await runMainOwnedWorkflow(f.options)).decision, 'approve');
});

test('research counts survive recovery without manufacturing an implementation stage or consuming its write', async () => {
    const f = fixture(); const ids = [];
    f.options.runWorker = async ({ invocationId }) => { ids.push(invocationId); return { decision: 'no_change', summary: 'Actual bounded source reading' }; };
    f.options.runMain = async () => {
        assert.equal((await f.call('delegate_worker', { instruction: 'One initial read', readOnly: true })).isError, false);
        throw createTeamError('cli_exit');
    };
    await assert.rejects(runMainOwnedWorkflow(f.options), { code: 'cli_exit' });
    const { normalizeCheckpoint } = require('../src/services/evolution-team');
    const checkpoint = normalizeCheckpoint(f.checkpoints.at(-1));
    assert.equal(checkpoint.mainWorkflow.researchInvocations, 1);
    assert.equal(checkpoint.mainWorkflow.workerInvocations, 0); assert.equal(checkpoint.mainWorkflow.initialWorkerInvoked, false);
    f.options.resume = checkpoint; f.options.runId = 'research-recovered'; f.options.roundId = 'another-round';
    f.options.runMain = async () => {
        assert.equal((await f.call('delegate_worker', { instruction: 'Read another exact source', readOnly: true })).isError, false);
        await f.call('approve_plan', f.plan);
        assert.equal((await f.call('delegate_worker', { instruction: 'Initial write remains available' })).isError, false);
        assert.equal((await f.call('delegate_worker', { instruction: 'Research is still available after implementation', readOnly: true })).isError, false);
        assert.equal(JSON.parse((await f.call('delegate_worker', { instruction: 'Second write remains forbidden' })).content[0].text).code,
            'main_repair_required');
        return accept(f, 'no_change');
    };
    assert.equal((await runMainOwnedWorkflow(f.options)).decision, 'no_change');
    assert.deepEqual(ids, ['research-1', 'research-2', 'worker-1', 'research-3']);
});

test('Main exit cancels and waits for every concurrent research worker before closing its bridge', async () => {
    for (const exit of ['throws', 'returns']) {
        const f = fixture(); const started = deferred(); let active = 0; let exited = 0;
        f.options.runWorker = ({ signal }) => new Promise((_, reject) => {
            active += 1;
            if (active === 2) started.resolve();
            const cancelled = () => setImmediate(() => {
                active -= 1; exited += 1; reject(createTeamError('cli_exit'));
            });
            if (signal.aborted) cancelled();
            else signal.addEventListener('abort', cancelled, { once: true });
        });
        const bridge = f.options.createBridge;
        f.options.createBridge = async options => {
            const created = await bridge(options);
            return { ...created, close: async () => {
                assert.equal(active, 0); assert.equal(exited, 2); await created.close();
            } };
        };
        f.options.runMain = async () => {
            const first = f.call('delegate_worker', { instruction: 'Pending source A', readOnly: true });
            const second = f.call('delegate_worker', { instruction: 'Pending source B', readOnly: true });
            await researchReady(started.promise, [first, second]);
            if (exit === 'throws') throw createTeamError('cli_exit');
            return { decision: 'no_change', summary: 'Cannot end a run with pending readers' };
        };
        await assert.rejects(runMainOwnedWorkflow(f.options), { code: exit === 'throws' ? 'cli_exit' : 'unsafe_worktree' });
        assert.equal(active, 0); assert.equal(exited, 2); assert.equal(f.closed, 1); assert.equal(f.commits, 0);
        assert.equal(f.checkpoints.at(-1).mainWorkflow.researchInvocations, 2);
        assert.equal(f.checkpoints.at(-1).mainWorkflow.workerInvocations, 0);
    }
});

test('one Main receives a worker CLI failure, repairs its scope directly, validates and accepts', async () => {
    const f = fixture();
    let mainCalls = 0;
    f.options.runWorker = async () => { f.edit(FILE, 'partial'); throw createTeamError('cli_exit', { exitCode: 1 }); };
    f.options.runMain = async () => {
        mainCalls += 1;
        assert.equal((await f.call('approve_plan', f.plan)).isError, false);
        assert.equal((await f.call('delegate_worker', { instruction: 'Fix the caller', allowedFiles: [FILE] })).isError, true);
        assert.equal(f.files.get(FILE), 'partial');
        f.edit(FILE, 'Main repaired');
        return accept(f);
    };
    const result = await runMainOwnedWorkflow(f.options);
    assert.equal(result.decision, 'approve');
    assert.equal(mainCalls, 1); assert.equal(f.commits, 1); assert.equal(f.verifies, 1); assert.equal(f.closed, 1);
    assert.ok(f.progress.every(item => item.agent === 'codex'), 'Main remains the only active owner');
    assert.equal(f.progress.some(item => item.phase === 'repair' || item.phase === 'diagnose'), false);
});

test('missing approval cannot delegate writes; Main may verify a real clean no_change', async () => {
    const f = fixture();
    f.options.runWorker = async () => { assert.fail('unapproved worker must not start'); };
    f.options.runMain = async () => {
        assert.equal((await f.call('delegate_worker', { instruction: 'write' })).isError, true);
        return accept(f, 'no_change');
    };
    assert.equal((await runMainOwnedWorkflow(f.options)).decision, 'no_change');
    assert.equal(f.commits, 0);
});

test('any edit after verification/seal prevents commit and leaves the draft', async () => {
    const f = fixture();
    f.options.runMain = async () => {
        await f.call('approve_plan', f.plan);
        f.edit(FILE, 'first candidate');
        const final = await accept(f);
        f.edit(FILE, 'late candidate');
        return final;
    };
    await assert.rejects(runMainOwnedWorkflow(f.options), { code: 'worktree_changed' });
    assert.equal(f.commits, 0); assert.equal(f.files.get(FILE), 'late candidate'); assert.equal(f.closed, 1);
});

test('context and worker replies are bounded while the full original task stays private', async () => {
    const f = fixture();
    const wholeTask = `【真实原任务】\n${'large private task evidence\n'.repeat(5000)}`;
    f.options.prompt = wholeTask;
    f.options.handoffDirective = 'CURRENT HANDOFF ONCE';
    f.options.runWorker = async ({ prompt }) => {
        assert.ok(prompt.length <= 6000);
        return { decision: 'implemented', summary: 'evidence '.repeat(2500) };
    };
    f.options.runMain = async ({ prompt }) => {
        assert.ok(prompt.length <= 48 * 1024);
        assert.equal(prompt.split('CURRENT HANDOFF ONCE').length - 1, 1);
        const status = JSON.parse((await f.call('status')).content[0].text);
        assert.equal(fs.readFileSync(status.originalTask, 'utf8'), wholeTask);
        assert.equal(fs.statSync(status.originalTask).mode & 0o777, 0o600);
        assert.equal(fs.statSync(path.dirname(status.originalTask)).mode & 0o777, 0o700);
        await f.call('approve_plan', f.plan);
        const worker = await f.call('delegate_worker', { instruction: 'i'.repeat(6000), allowedFiles: [FILE] });
        assert.equal(worker.isError, false);
        assert.ok(worker.content[0].text.length <= 6000);
        const full = JSON.parse(fs.readFileSync(JSON.parse(worker.content[0].text).artifact, 'utf8'));
        assert.ok(full.summary.length > 6000);
        assert.equal(fs.readFileSync(path.join(f.directory, 'logs/main-fixture/worker-1-instruction.txt'), 'utf8').length, 6000);
        return accept(f, 'no_change');
    };
    assert.equal((await runMainOwnedWorkflow(f.options)).decision, 'no_change');
});

test('Main inherits all 29 files and 20 checks and preserves a partial direct edit across a crash', async () => {
    const f = fixture();
    f.plan.allowedFiles = [FILE, ...Array.from({ length: 28 }, (_, index) => `core/src/approved-${index}.js`)];
    f.plan.acceptanceChecks = Array.from({ length: 20 }, (_, index) => `Original contract check ${index}`);
    f.options.runMain = async () => {
        await f.call('approve_plan', f.plan);
        f.edit(FILE, 'partial direct edit');
        throw createTeamError('cli_exit', { exitCode: 1 });
    };
    await assert.rejects(runMainOwnedWorkflow(f.options), { code: 'cli_exit' });
    const checkpoint = f.checkpoints.at(-1);
    assert.deepEqual(checkpoint.approvedScope, [...f.plan.allowedFiles].sort());
    assert.deepEqual(checkpoint.acceptanceChecks, f.plan.acceptanceChecks);
    assert.equal(checkpoint.fileFingerprints[FILE], sha('partial direct edit'));
    assert.equal(checkpoint.verifiedFingerprint, '');
    f.options.resume = checkpoint;
    f.options.runWorker = async () => { assert.fail('existing contract does not require another worker/research stage'); };
    f.options.runMain = async ({ prompt }) => {
        assert.ok(prompt.includes('Original contract check 19') && prompt.includes('approved-27.js'));
        const weakened = { ...f.plan, acceptanceChecks: ['weakened'] };
        assert.equal((await f.call('approve_plan', weakened)).isError, true);
        assert.equal((await f.call('approve_plan', { ...f.plan, allowedFiles: [FILE] })).isError, true, 'a prior draft scope cannot be silently narrowed');
        f.edit(FILE, 'complete direct edit');
        return accept(f);
    };
    const result = await runMainOwnedWorkflow(f.options);
    assert.equal(result.decision, 'approve');
    assert.deepEqual(f.checkpoints.at(-1).taskIdentity, checkpoint.taskIdentity);
    assert.deepEqual(f.checkpoints.at(-1).acceptanceChecks, checkpoint.acceptanceChecks);
    assert.equal(f.commits, 1);
});

test('read-only worker mutations and unapproved files remain blocked without rolling back drafts', async () => {
    for (const readOnly of [false, true]) {
        const f = fixture();
        f.options.runWorker = async () => {
            f.edit(readOnly ? FILE : 'core/src/other.js', 'must remain visible');
            return { decision: 'implemented', summary: 'claimed change' };
        };
        f.options.runMain = async () => {
            if (!readOnly) await f.call('approve_plan', f.plan);
            const worker = await f.call('delegate_worker', { instruction: 'one task', readOnly, allowedFiles: readOnly ? [] : [FILE] });
            assert.equal(worker.isError, true);
            return { decision: 'no_change', summary: 'not a valid approval' };
        };
        await assert.rejects(runMainOwnedWorkflow(f.options), { code: readOnly ? 'readonly_changed' : 'repair_scope' });
        assert.equal(f.commits, 0);
        assert.equal(f.files.get(readOnly ? FILE : 'core/src/other.js'), 'must remain visible');
    }
});

test('mutating tools exclude concurrency; a Main failure aborts and waits for its worker before closing', async () => {
    const f = fixture();
    let workerExited = false;
    let started;
    const ready = new Promise(resolve => { started = resolve; });
    f.options.runWorker = ({ signal }) => new Promise((_, reject) => {
        started();
        signal.addEventListener('abort', () => { workerExited = true; reject(createTeamError('cli_exit')); }, { once: true });
    });
    f.options.runMain = async () => {
        await f.call('approve_plan', f.plan);
        void f.call('delegate_worker', { instruction: 'wait for cancellation', allowedFiles: [FILE] });
        await ready;
        const research = await f.call('delegate_worker', { instruction: 'Cannot research a moving write candidate', readOnly: true });
        assert.equal(JSON.parse(research.content[0].text).code, 'busy');
        const competing = await f.call('verify_candidate');
        assert.equal(JSON.parse(competing.content[0].text).code, 'busy');
        throw createTeamError('cli_exit', { exitCode: 1 });
    };
    await assert.rejects(runMainOwnedWorkflow(f.options), { code: 'cli_exit' });
    assert.equal(workerExited, true);
    assert.equal(f.closed, 1);
    assert.equal(f.commits, 0);
});

test('dirty no_change and incomplete coordinator evidence never create a seal', async () => {
    for (const badEvidence of [false, true]) {
        const f = fixture();
        if (badEvidence) f.options.verify = async () => ({ countercheck: { state: 'not_required' } });
        f.options.runMain = async () => {
            await f.call('approve_plan', f.plan);
            f.edit(FILE, 'real draft');
            const verified = await f.call('verify_candidate');
            if (badEvidence) assert.equal(verified.isError, true);
            const rejected = await f.call('accept_result', { decision: 'no_change', summary: 'ignore a draft' });
            assert.equal(rejected.isError, true);
            return { decision: 'no_change', summary: 'cannot approve' };
        };
        await assert.rejects(runMainOwnedWorkflow(f.options), { code: 'review_rejected' });
        assert.equal(f.commits, 0); assert.equal(f.files.get(FILE), 'real draft');
    }
});

test('the first worker call remains consumed across rounds; all later repairs belong to Main', async () => {
    const f = fixture();
    f.options.runMain = async () => {
        await f.call('approve_plan', f.plan);
        assert.equal((await f.call('delegate_worker', { instruction: 'Implement the first draft' })).isError, false);
        assert.equal(JSON.parse((await f.call('delegate_worker', { instruction: 'Cannot delegate a second task' })).content[0].text).code,
            'main_repair_required');
        throw createTeamError('cli_exit');
    };
    await assert.rejects(runMainOwnedWorkflow(f.options), { code: 'cli_exit' });
    const checkpoint = f.checkpoints.at(-1);
    const { normalizeCheckpoint } = require('../src/services/evolution-team');
    assert.equal(normalizeCheckpoint(checkpoint).mainWorkflow.workerInvocations, 1);
    f.options.resume = checkpoint;
    f.options.roundId = 'next-round';
    f.options.runId = 'next-session';
    f.options.runMain = async () => {
        assert.equal((await f.call('delegate_worker', { instruction: 'Only read the retained candidate after recovery', readOnly: true })).isError, false);
        const refused = await f.call('delegate_worker', { instruction: 'Cannot delegate repairs after a round change' });
        assert.equal(JSON.parse(refused.content[0].text).code, 'main_repair_required');
        f.edit(FILE, 'Main still owns its small authorized repair');
        return accept(f);
    };
    assert.equal((await runMainOwnedWorkflow(f.options)).decision, 'approve');
});

test('unproven child cleanup blocks the whole Main and remains blocked after normalization', async () => {
    const f = fixture();
    f.options.runWorker = async () => { throw createTeamError('unsafe_worktree'); };
    f.options.runMain = async () => {
        await f.call('approve_plan', f.plan);
        assert.equal((await f.call('delegate_worker', { instruction: 'Unsafe cleanup must stop this run' })).isError, true);
        return { decision: 'approve', summary: 'Cannot override unsafe child ownership' };
    };
    await assert.rejects(runMainOwnedWorkflow(f.options), { code: 'unsafe_worktree' });
    const { normalizeCheckpoint } = require('../src/services/evolution-team');
    const checkpoint = normalizeCheckpoint(f.checkpoints.at(-1));
    assert.equal(checkpoint.mainWorkflow.blocked, 'unsafe_worktree');
    f.options.resume = checkpoint;
    f.options.runMain = async () => { assert.fail('an unproven writer cannot be bypassed by a fresh Main'); };
    await assert.rejects(runMainOwnedWorkflow(f.options), { code: 'unsafe_worktree' });
    assert.equal(f.commits, 0);
});

test('one Main repairs four distinct verification failures and passes without a two-attempt ceiling', async () => {
    const f = fixture();
    let workers = 0;
    let mains = 0;
    let checks = 0;
    const passed = f.options.verify;
    f.options.runWorker = async () => { workers += 1; f.edit(FILE, 'first worker draft');
        return { decision: 'implemented', summary: 'First implementation handed to Main' }; };
    f.options.verify = async () => {
        checks += 1;
        if (checks <= 4) throw Object.assign(createTeamError('verification_failed'), {
            failureSummary: `specific failing behavior ${checks}`, logFile: `check-${checks}.log` });
        return passed();
    };
    f.options.runMain = async () => {
        mains += 1;
        await f.call('approve_plan', f.plan);
        await f.call('delegate_worker', { instruction: 'Produce the initial implementation' });
        for (let i = 1; i <= 4; i += 1) {
            const failure = await f.call('verify_candidate');
            assert.equal(failure.isError, true);
            const details = JSON.parse(failure.content[0].text);
            assert.equal(details.code, 'verification_failed');
            assert.match(details.summary, new RegExp(`specific failing behavior ${i}`));
            const unchanged = await f.call('verify_candidate');
            assert.equal(JSON.parse(unchanged.content[0].text).code, 'repair_required');
            assert.equal(checks, i, 'identical failed candidates do not rerun the suite without a repair reason');
            f.edit(FILE, `Main correction ${i}`);
            assert.equal((await f.call('record_iteration', { cause: `behavior ${i} was wrong`,
                changes: [`correct caller ${i}`], remainingIssues: i < 4 ? ['next behavior remains'] : [],
                nextStep: 'Verify the corrected candidate' })).isError, false);
            assert.equal((await f.call('delegate_worker', { instruction: 'Try delegating repair again' })).isError, true);
        }
        return accept(f);
    };
    assert.equal((await runMainOwnedWorkflow(f.options)).decision, 'approve');
    assert.equal(mains, 1); assert.equal(workers, 1); assert.equal(checks, 5); assert.equal(f.commits, 1);
    assert.equal(f.checkpoints.at(-1).mainWorkflow.repairIterations, 4);
    assert.equal(f.checkpoints.at(-1).mainWorkflow.verificationAttempts, 5);
});

test('a new native session reads prior failure and Main repair notes across a round change', async () => {
    const f = fixture();
    const good = f.options.verify;
    let failCheck = true;
    f.options.verify = async () => {
        if (failCheck) throw Object.assign(createTeamError('verification_failed'),
            { failureSummary: 'returned ordinary failure loses deadline evidence', logFile: 'actual-failed-check.log' });
        return good();
    };
    f.options.runMain = async () => {
        await f.call('approve_plan', f.plan);
        await f.call('delegate_worker', { instruction: 'Implement once' });
        f.edit(FILE, 'real retained draft');
        assert.equal((await f.call('verify_candidate')).isError, true);
        failCheck = false;
        assert.equal((await f.call('record_iteration', { cause: 'ordinary error clears proven deadline',
            changes: ['preserved cutoff evidence'], remainingIssues: ['add rejected-read case'],
            nextStep: 'Add the rejected-read behavior then verify' })).isError, false);
        throw createTeamError('cli_exit');
    };
    const failure = await runMainOwnedWorkflow(f.options).catch(error => error);
    assert.ok(failure.failure, 'the unresolved verification cause must survive a later Main interruption');
    assert.equal(failure.failure.code, 'verification_failed', 'writing repair memory does not erase the unresolved cause');
    const { normalizeCheckpoint } = require('../src/services/evolution-team');
    const checkpoint = normalizeCheckpoint(f.checkpoints.at(-1));
    assert.ok(checkpoint?.mainWorkflow?.memory, 'memory is retained by the production checkpoint normalizer');
    f.options.resume = checkpoint;
    f.options.roundId = 'new-round'; f.options.runId = 'second-native-session';
    f.options.runWorker = async () => { assert.fail('a session restart must not call Claude again'); };
    f.options.runMain = async ({ prompt }) => {
        assert.match(prompt, /必须先读的逐轮修复记忆/);
        assert.match(prompt, /ordinary error clears proven deadline/);
        const reply = JSON.parse((await f.call('status')).content[0].text);
        assert.ok(reply.repairMemory, 'Main receives the stable memory location');
        const index = JSON.parse(fs.readFileSync(reply.repairMemory.indexFile));
        assert.equal(index.latestFailure.summary, 'returned ordinary failure loses deadline evidence');
        const notes = index.recent.map(entry => JSON.parse(fs.readFileSync(entry.file)));
        const repair = notes.find(entry => entry.kind === 'main_repair');
        assert.ok(repair, 'the full earlier repair event remains readable');
        assert.deepEqual(repair.remainingIssues, ['add rejected-read case']);
        f.edit(FILE, 'deadline and rejected-read behavior repaired');
        return accept(f);
    };
    assert.equal((await runMainOwnedWorkflow(f.options)).decision, 'approve');
    assert.equal(f.checkpoints.at(-1).mainWorkflow.workerInvocations, 1);
});

test('an unchanged environmental retry requires and retains an explicit Main explanation', async () => {
    const f = fixture(); let checks = 0;
    const passed = f.options.verify;
    f.options.verify = async () => { checks += 1; if (checks === 1) throw createTeamError('verification_failed'); return passed(); };
    f.options.runMain = async () => {
        assert.equal((await f.call('verify_candidate')).isError, true);
        assert.equal((await f.call('verify_candidate')).isError, true);
        assert.equal(checks, 1);
        assert.equal((await f.call('record_iteration', { cause: 'fixture child readiness was not reached', changes: [],
            remainingIssues: ['confirm actual child ready record'], nextStep: 'Retry after the ready record exists',
            retryUnchanged: true })).isError, false);
        return accept(f, 'no_change');
    };
    assert.equal((await runMainOwnedWorkflow(f.options)).decision, 'no_change');
    assert.equal(checks, 2);
});
