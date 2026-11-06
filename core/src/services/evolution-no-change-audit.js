/** Evidence for zero-change decisions and durable, next-round investigation follow-ups. */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const AREAS = ['external_updates', 'interface_compatibility', 'retired_activities', 'planting',
    'runtime_logs', 'problem_analysis', 'uncertain_incidents', 'usability'];
const FOLLOWUPS = 'evolution-investigation-followups.json';
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const inside = (file, root) => file === root || file.startsWith(root + path.sep);
function text(value, limit = 2000) {
    if (typeof value !== 'string' || !value.trim() || value.length > limit) throw new Error('invalid_audit_text');
    return value.trim();
}
function evidenceFiles(paths, { dataDir, sourceRoot = process.cwd(), knowledgeDir }) {
    if (!Array.isArray(paths) || !paths.length || paths.length > 8) throw new Error('audit_evidence_missing');
    const roots = [dataDir, sourceRoot, knowledgeDir].filter(Boolean).filter(root => fs.existsSync(root)).map(root => fs.realpathSync(root));
    return paths.map(file => {
        const full = path.resolve(sourceRoot, text(file, 1000));
        const real = fs.realpathSync(full);
        const stat = fs.lstatSync(full);
        if (!stat.isFile() || !roots.some(root => inside(real, root)) || stat.size > 512 * 1024) throw new Error('audit_evidence_boundary');
        return { file: real, sha256: hash(fs.readFileSync(real)) };
    });
}
function fileAt(dataDir, name) {
    const file = path.resolve(dataDir, name);
    if (path.dirname(file) !== path.resolve(dataDir)) throw new Error('audit_path_escape');
    if (fs.existsSync(file) && !fs.lstatSync(file).isFile()) throw new Error('audit_not_regular');
    return file;
}
function readFollowups(dataDir) {
    const file = fileAt(dataDir, FOLLOWUPS);
    if (!fs.existsSync(file)) return { version: 1, entries: [] };
    const store = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (store.version !== 1 || !Array.isArray(store.entries)) throw new Error('invalid_followup_store');
    return store;
}
function write(dataDir, name, value) {
    const file = fileAt(dataDir, name);
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const temp = `${file}.${crypto.randomUUID()}.tmp`;
    try {
        fs.writeFileSync(temp, JSON.stringify(value, null, 2), { flag: 'wx', mode: 0o600 });
        fs.renameSync(temp, file);
    } finally { fs.rmSync(temp, { force: true }); }
    return file;
}
function getInvestigationFollowups(dataDir, now = Date.now()) {
    const pending = readFollowups(dataDir).entries.filter(entry => entry.status === 'pending');
    return { file: fileAt(dataDir, FOLLOWUPS), pending, due: pending.filter(entry => entry.nextCheckAt <= now),
        mechanism: 'Existing daily evolution reads these records; no extra game requests or polling is created.' };
}
function normalizeCheck(check, options) {
    const now = options.now ?? Date.now();
        if (!AREAS.includes(check.area) || !['checked', 'monitoring', 'blocked'].includes(check.status)) throw new Error('invalid_audit_area');
        const result = { area: check.area, status: check.status, conclusion: text(check.conclusion), evidence: evidenceFiles(check.evidencePaths, options) };
        if (check.status !== 'checked') {
            const followup = check.followup || {};
            if (!['daily_log_review', 'existing_event_log', 'owner_evidence'].includes(followup.mechanism)
                || !Number.isSafeInteger(followup.nextCheckAt) || followup.nextCheckAt <= now || followup.nextCheckAt > now + 8 * 86400000
                || !Array.isArray(followup.ruledOut) || !followup.ruledOut.length || followup.ruledOut.length > 8) throw new Error('investigation_plan_missing');
            result.followup = { question: text(followup.question), ruledOut: followup.ruledOut.map(value => text(value)),
                missing: text(followup.missing), signal: text(followup.signal), resolveWhen: text(followup.resolveWhen),
                mechanism: followup.mechanism, nextCheckAt: followup.nextCheckAt };
        }
        return result;
}
function retainFollowups(normalized, { dataDir, fingerprint, runId, now = Date.now() }) {
    const store = readFollowups(dataDir);
    for (const check of normalized.filter(check => check.followup)) {
        const id = hash(`${check.area}\n${check.followup.question}`);
        const previous = store.entries.find(entry => entry.id === id);
        // Re-registering a question is not a recheck. Preserve the due deadline
        // and evidence until review_investigation explicitly records new work.
        if (previous?.status === 'pending') continue;
        const entry = { id, area: check.area, ...check.followup, evidence: check.evidence, status: 'pending',
            firstSeenAt: previous?.firstSeenAt || now, updatedAt: now, fingerprint, runId,
            history: [...(previous?.history || []), ...(previous?.resolution ? [previous.resolution] : [])].slice(-20) };
        store.entries = [...store.entries.filter(item => item.id !== id), entry];
    }
    const unresolved = store.entries.filter(entry => entry.status === 'pending');
    if (unresolved.length > 200) throw new Error('followup_review_required');
    store.entries = [...unresolved, ...store.entries.filter(entry => entry.status !== 'pending').slice(-200)];
    write(dataDir, FOLLOWUPS, store);
}
function recordInvestigation(options) {
    if (!/^[a-f\d]{64}$/.test(options.fingerprint || "") || options.status === "checked") throw new Error("invalid_investigation");
    const checked = normalizeCheck(options, options);
    retainFollowups([checked], options);
    return getInvestigationFollowups(options.dataDir, options.now);
}
function reviewNoChange(options) {
    const { dataDir, checks, fingerprint, runId, now = Date.now() } = options;
    if (!/^[a-f\d]{64}$/.test(fingerprint || '') || !Array.isArray(checks) || checks.length !== AREAS.length
        || new Set(checks.map(check => check.area)).size !== AREAS.length) throw new Error('no_change_audit_incomplete');
    const normalized = checks.map(check => normalizeCheck(check, options));
    // Validate every source/plan before updating durable state. Parent task ownership
    // serializes these synchronous writes; unresolved entries have no age-based expiry.
    retainFollowups(normalized, options);
    const audit = { version: 1, runId, fingerprint, reviewedAt: now, checks: normalized,
        unresolved: normalized.filter(check => check.status !== 'checked').length };
    const file = write(dataDir, 'evolution-no-change-audit.json', audit);
    return { ...audit, file, digest: hash(JSON.stringify(audit)), followups: getInvestigationFollowups(dataDir, now) };
}
function auditStillValid(audit, fingerprint) {
    if (!audit || audit.fingerprint !== fingerprint) return false;
    try {
        return audit.checks.every(check => check.evidence.every(source => fs.lstatSync(source.file).isFile()
            && hash(fs.readFileSync(source.file)) === source.sha256));
    } catch { return false; }
}
function reviewInvestigation(options) {
    const store = readFollowups(options.dataDir);
    const entry = store.entries.find(item => item.id === options.id && item.status === 'pending');
    if (!entry) throw new Error('investigation_not_pending');
    const resolution = { conclusion: text(options.conclusion), evidence: evidenceFiles(options.evidencePaths, options),
        fingerprint: options.fingerprint, reviewedAt: options.now ?? Date.now() };
    if (options.status === 'resolved') {
        // A tool call is only a proposal. An interrupted/unpublished repair must
        // leave the durable incident pending for the next Main.
        return { id: entry.id, status: 'resolution_proposed', priorDigest: hash(JSON.stringify(entry)), resolution };
    } else if (options.status === 'monitoring' && Number.isSafeInteger(options.nextCheckAt)
        && options.nextCheckAt > resolution.reviewedAt && options.nextCheckAt <= resolution.reviewedAt + 8 * 86400000) {
        entry.nextCheckAt = options.nextCheckAt; entry.lastReview = resolution;
    } else throw new Error('invalid_investigation_review');
    write(options.dataDir, FOLLOWUPS, store);
    return { id: entry.id, status: entry.status, resolution };
}
function resolutionStillValid(proposal, { dataDir, fingerprint }) {
    try {
        const entry = readFollowups(dataDir).entries.find(item => item.id === proposal.id && item.status === 'pending');
        return !!entry && proposal.status === 'resolution_proposed' && proposal.resolution.fingerprint === fingerprint
            && proposal.priorDigest === hash(JSON.stringify(entry)) && proposal.resolution.evidence.every(source =>
                fs.lstatSync(source.file).isFile() && hash(fs.readFileSync(source.file)) === source.sha256);
    } catch { return false; }
}
function finalizeInvestigations(proposals, options) {
    // Called only after a successful clean-baseline Main has returned its sealed
    // decision. Dirty candidate fixes wait for a later published-baseline recheck.
    if (!proposals.every(proposal => resolutionStillValid(proposal, options))) throw new Error('investigation_resolution_stale');
    const store = readFollowups(options.dataDir);
    for (const proposal of proposals) {
        const entry = store.entries.find(item => item.id === proposal.id);
        entry.status = 'resolved'; entry.resolution = { ...proposal.resolution, resolvedAt: options.now ?? Date.now() };
    }
    write(options.dataDir, FOLLOWUPS, store);
}

module.exports = { AREAS, reviewNoChange, auditStillValid, getInvestigationFollowups, reviewInvestigation, recordInvestigation,
    resolutionStillValid, finalizeInvestigations };
