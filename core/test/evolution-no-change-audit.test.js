const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tempRoot = fs.realpathSync(os.tmpdir());
const prefix = path.resolve(tempRoot, 'farm-zero-review-');
assert.equal(path.dirname(prefix), tempRoot);
const root = fs.mkdtempSync(prefix);
process.env.FARM_DATA_DIR = root;
const audit = require('../src/services/evolution-no-change-audit');
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
function fixture() {
    const dataDir = fs.mkdtempSync(path.join(root, 'case-'));
    const evidence = path.resolve(dataDir, 'observations.json');
    assert.ok(evidence.startsWith(dataDir + path.sep));
    fs.writeFileSync(evidence, JSON.stringify({ source: 'synthetic snapshot', observed: true }));
    const checks = audit.AREAS.map(area => ({ area, status: 'checked', conclusion: 'Actual bounded snapshot reviewed', evidencePaths: [evidence] }));
    return { dataDir, sourceRoot: dataDir, checks, evidence, now: 1000000, runId: 'fixture', fingerprint: 'a'.repeat(64) };
}
test('zero-change evidence requires every area and actual files, and later file edits invalidate acceptance', () => {
    const f = fixture();
    assert.throws(() => audit.reviewNoChange({ ...f, checks: f.checks.slice(1) }), /incomplete/);
    assert.throws(() => audit.reviewNoChange({ ...f, checks: f.checks.map((check, i) => i ? check : { ...check, evidencePaths: [] }) }), /evidence_missing/);
    assert.equal(fs.existsSync(path.join(f.dataDir, 'evolution-no-change-audit.json')), false);
    const reviewed = audit.reviewNoChange(f);
    assert.equal(audit.auditStillValid(reviewed, f.fingerprint), true);
    fs.writeFileSync(f.evidence, 'new observation');
    assert.equal(audit.auditStillValid(reviewed, f.fingerprint), false);
    assert.equal(fs.statSync(reviewed.file).mode & 0o777, 0o600);
});
test('uncertain findings require investigated exclusions and a concrete monitoring plan, and survive new rounds and age', () => {
    const f = fixture();
    f.checks[6].status = 'monitoring';
    assert.throws(() => audit.reviewNoChange(f), /investigation_plan_missing/);
    f.checks[6].followup = { question: 'Why did the synthetic action stall?', ruledOut: ['Offline caller ruled out by recorded socket facts'],
        missing: 'First failing natural response', signal: 'Existing operation failure event with stage and byte count',
        resolveWhen: 'Natural failure identifies stage and isolated reproduction passes', mechanism: 'existing_event_log', nextCheckAt: f.now + 1000 };
    const report = audit.reviewNoChange(f);
    assert.equal(report.unresolved, 1);
    const pending = audit.getInvestigationFollowups(f.dataDir, f.now + 30 * 86400000);
    assert.equal(pending.due.length, 1, 'unresolved incidents do not expire with short feedback logs');
    const next = fixture();
    audit.reviewNoChange({ ...next, dataDir: f.dataDir, sourceRoot: next.dataDir, runId: 'next-round' });
    assert.equal(audit.getInvestigationFollowups(f.dataDir).pending.length, 1, 'an unrelated clean review cannot erase the old incident');
    const id = pending.due[0].id;
    audit.reviewInvestigation({ ...f, id, status: 'monitoring', evidencePaths: [f.evidence], conclusion: 'No new natural failure yet; signal is still recorded', nextCheckAt: f.now + 2000 });
    assert.equal(audit.getInvestigationFollowups(f.dataDir, f.now + 1500).due.length, 0);
    const proposal = audit.reviewInvestigation({ ...f, id, status: 'resolved', evidencePaths: [f.evidence], conclusion: 'Actual root cause and passing regression reviewed' });
    assert.equal(audit.getInvestigationFollowups(f.dataDir).pending.length, 1, 'a proposal is not successful acceptance');
    audit.finalizeInvestigations([proposal], f);
    assert.equal(audit.getInvestigationFollowups(f.dataDir).pending.length, 0);
    const stored = JSON.parse(fs.readFileSync(pending.file));
    assert.equal(stored.entries[0].status, 'resolved');
    assert.ok(stored.entries[0].resolution.evidence.length, 'resolution keeps evidence instead of deleting history');
});

test('re-registering an overdue question does not postpone or overwrite the prior investigation', () => {
    const f = fixture();
    const question = { area: 'uncertain_incidents', status: 'monitoring', conclusion: 'Current evidence is insufficient', evidencePaths: [f.evidence],
        followup: { question: 'Unresolved first failure', ruledOut: ['Known offline gate'], missing: 'Natural failure response', signal: 'Existing failure event',
            resolveWhen: 'Identify and verify the failing stage', mechanism: 'daily_log_review', nextCheckAt: f.now + 1000 } };
    audit.recordInvestigation({ ...f, ...question });
    const prior = audit.getInvestigationFollowups(f.dataDir, f.now + 2000).due[0];
    audit.recordInvestigation({ ...f, ...question, now: f.now + 2000, runId: 'later-run', followup: { ...question.followup, nextCheckAt: f.now + 4000 } });
    const actual = audit.getInvestigationFollowups(f.dataDir, f.now + 2000).due[0];
    assert.deepEqual(actual, prior);
    audit.reviewInvestigation({ ...f, id: prior.id, status: 'monitoring', now: f.now + 2000, nextCheckAt: f.now + 4000,
        evidencePaths: [f.evidence], conclusion: 'Explicit recheck: no new matching event; continue existing log review' });
    assert.equal(audit.getInvestigationFollowups(f.dataDir, f.now + 3000).due.length, 0);
    assert.ok(audit.getInvestigationFollowups(f.dataDir).pending[0].lastReview);
});
test('unknown evidence paths and symlinks are rejected without creating a successful audit', () => {
    const f = fixture();
    const link = path.resolve(f.dataDir, 'redirect'); assert.ok(link.startsWith(f.dataDir + path.sep));
    fs.symlinkSync(f.evidence, link);
    f.checks[0].evidencePaths = [link];
    assert.throws(() => audit.reviewNoChange(f), /boundary/);
    assert.equal(fs.existsSync(path.join(f.dataDir, 'evolution-no-change-audit.json')), false);
});
