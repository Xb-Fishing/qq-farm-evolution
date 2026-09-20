/** Anonymous public metadata discovery. Repository content remains untrusted and unreviewed. */
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const crypto = require('node:crypto');

const { readPrivateConfig } = require('./private-config');
const VERSION = 2;
const HISTORY_SIZE = 20;
const QUERIES = ['qq-farm', 'qq-farm-bot', 'QQ农场', 'qq farm', '农场助手', 'nqf'];
const FILE = 'evolution-references.json';
const MAX_REQUESTS = 24;
const MAX_BYTES = 512 * 1024;
const REASONS = new Set(['none', 'rate_limited', 'timeout', 'network', 'invalid_response', 'budget_exhausted', 'storage_failed']);
const SEED_STATES = new Set(['available', 'unavailable', 'not_checked']);
const QUERY_STATES = new Set(['succeeded', 'failed', 'not_checked']);
const owns = (value, key) => value && typeof value === 'object' && Object.hasOwn(value, key);

function slug(value) {
    if (typeof value !== 'string' || !/^[a-z\d][a-z\d-]{0,38}\/[\w.-]{1,100}$/i.test(value)) return '';
    const parts = value.toLowerCase().split('/');
    if (parts.some(part => ['.', '..', '__proto__', 'constructor', 'prototype'].includes(part))) return '';
    return parts.join('/');
}
const sha = value => typeof value === 'string' && /^[a-f\d]{40}$/.test(value) ? value : '';
function iso(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) return '';
    const time = Date.parse(value);
    return Number.isFinite(time) ? new Date(time).toISOString() : '';
}
function referenceSeeds(dataDir) {
    const config = readPrivateConfig({ file: process.env.FARM_PRIVATE_CONFIG_FILE || path.join(dataDir, 'private-config.json') });
    return [...new Set((Array.isArray(config.evolutionReferenceRepositories) ? config.evolutionReferenceRepositories : []).map(slug).filter(Boolean))].slice(0, 4);
}
function policyFingerprint(seeds) {
    return crypto.createHash('sha256').update(JSON.stringify([VERSION, seeds, QUERIES, HISTORY_SIZE])).digest('hex');
}
function activitySample(commits, now) {
    if (!Array.isArray(commits)) return {};
    const sample = commits.slice(0, HISTORY_SIZE);
    const dates = sample.map(item => iso(item?.commit?.committer?.date)).filter(Boolean);
    if (dates.length !== sample.length || !dates.length) return {};
    const recent = dates.filter(date => Date.parse(date) >= now - 7 * 86400000 && Date.parse(date) <= now);
    return { sampledCommits: sample.length, recentCommits: recent.length, activeDays: new Set(recent.map(date => date.slice(0, 10))).size,
        activityLimited: sample.length === HISTORY_SIZE };
}
function candidate(value) {
    const ownerRepo = owns(value, 'ownerRepo') && slug(value.ownerRepo);
    if (!ownerRepo) return null;
    const activity = Number.isInteger(value.sampledCommits) && value.sampledCommits > 0 && value.sampledCommits <= HISTORY_SIZE
        && Number.isInteger(value.recentCommits) && value.recentCommits >= 0 && value.recentCommits <= value.sampledCommits
        && Number.isInteger(value.activeDays) && value.activeDays >= 0 && value.activeDays <= Math.min(8, value.recentCommits)
        ? { sampledCommits: value.sampledCommits, recentCommits: value.recentCommits, activeDays: value.activeDays, activityLimited: value.activityLimited === true } : {};
    return { ownerRepo, sha: sha(value.sha), updatedAt: iso(value.updatedAt), ...activity,
        stars: Number.isSafeInteger(value.stars) ? Math.max(0, Math.min(100000000, value.stars)) : 0 };
}
function candidates(values) {
    const found = new Map();
    for (const value of Array.isArray(values) ? values.slice(0, 200) : []) {
        const clean = candidate(value);
        if (clean && !found.has(clean.ownerRepo)) found.set(clean.ownerRepo, clean);
        if (found.size >= 40) break;
    }
    return [...found.values()];
}
function emptyRecord(seeds) {
    return { version: VERSION, policyFingerprint: policyFingerprint(seeds), state: 'unavailable', searchedAt: '', failureReason: 'none',
        queries: QUERIES.map((_, index) => ({ queryId: `q${index + 1}`, state: 'not_checked' })),
        seedStatus: seeds.map(ownerRepo => ({ ownerRepo, state: 'not_checked', sha: '' })),
        candidates: [], seenCandidates: [], newCandidates: [], changedCandidates: [] };
}
function readRecord(dataDir, seeds = referenceSeeds(dataDir)) {
    try {
        const raw = JSON.parse(fs.readFileSync(path.join(dataDir, FILE), 'utf8'));
        if (!raw || ![1, VERSION].includes(raw.version) || !['complete', 'partial', 'unavailable'].includes(raw.state) || !iso(raw.searchedAt)) return null;
        const clean = emptyRecord(seeds);
        clean.policyFingerprint = raw.version === VERSION && raw.policyFingerprint === policyFingerprint(seeds) ? raw.policyFingerprint : '';
        clean.searchedAt = iso(raw.searchedAt);
        clean.failureReason = REASONS.has(raw.failureReason) ? raw.failureReason : 'invalid_response';
        clean.candidates = candidates(raw.candidates);
        clean.seenCandidates = candidates(raw.seenCandidates);
        clean.queries = clean.queries.map((query) => {
            const found = Array.isArray(raw.queries) && raw.queries.find(item => item?.queryId === query.queryId);
            return { ...query, state: QUERY_STATES.has(found?.state) ? found.state : 'not_checked' };
        });
        clean.seedStatus = clean.seedStatus.map((seed) => {
            const found = Array.isArray(raw.seedStatus) && raw.seedStatus.find(item => item?.ownerRepo === seed.ownerRepo);
            return { ...seed, state: SEED_STATES.has(found?.state) ? found.state : 'not_checked', sha: sha(found?.sha) };
        });
        for (const key of ['newCandidates', 'changedCandidates']) {
            clean[key] = [...new Set((Array.isArray(raw[key]) ? raw[key] : []).map(slug).filter(name => name
                && clean.candidates.some(item => item.ownerRepo === name)))].slice(0, 40);
        }
        clean.state = raw.state === 'complete' && !discoveryComplete(clean) ? 'partial' : raw.state;
        return clean;
    } catch { return null; }
}
function discoveryComplete(record) {
    return !!record.policyFingerprint && record.failureReason === 'none' && record.queries.every(item => item.state === 'succeeded')
        && record.seedStatus.every(item => item.state === 'available' && item.sha);
}
function summary(record, cached = false) {
    return { state: record.state, searchedAt: record.searchedAt, failureReason: record.failureReason,
        queriesSucceeded: record.queries.filter(item => item.state === 'succeeded').length,
        candidateCount: record.candidates.length, seedStatus: record.seedStatus,
        newCandidates: record.newCandidates, changedCandidates: record.changedCandidates,
        candidates: record.candidates, activityWindowDays: 7, historySampleSize: HISTORY_SIZE, discoveryComplete: discoveryComplete(record), cached };
}
function getPublicReferenceSummary(dataDir) {
    const seeds = referenceSeeds(dataDir);
    return summary(readRecord(dataDir, seeds) || emptyRecord(seeds));
}
function writeRecord(dataDir, record) {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const temp = path.join(dataDir, `${FILE}.${crypto.randomUUID()}.tmp`);
    try {
        fs.writeFileSync(temp, JSON.stringify(record), { mode: 0o600 });
        fs.renameSync(temp, path.join(dataDir, FILE));
    } finally { fs.rmSync(temp, { force: true }); }
}

function publicRequest(apiPath, { signal } = {}) {
    return new Promise((resolve, reject) => {
        const req = https.get({ hostname: 'api.github.com', port: 443, path: apiPath, signal,
            headers: { 'user-agent': 'farm-evolution-public-research', accept: 'application/vnd.github+json' },
        }, (res) => {
            const chunks = [];
            let bytes = 0;
            res.on('data', (chunk) => {
                bytes += chunk.length;
                if (bytes > MAX_BYTES) { req.destroy(new Error('invalid_response')); return; }
                chunks.push(chunk);
            });
            res.on('error', reject);
            res.on('end', () => {
                if (res.statusCode !== 200) return resolve({ statusCode: res.statusCode, body: null });
                try { resolve({ statusCode: 200, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }); }
                catch { reject(new Error('invalid_response')); }
            });
        });
        req.setTimeout(4000, () => req.destroy(new Error('timeout')));
        req.on('error', reject);
    });
}

function fromMetadata(value) {
    if (!value || value.private !== false || !owns(value, 'full_name')) return null;
    return candidate({ ownerRepo: value.full_name, updatedAt: value.pushed_at || value.updated_at, stars: value.stargazers_count });
}
function relevant(value) {
    const name = typeof value?.name === 'string' ? value.name : '';
    const description = typeof value?.description === 'string' ? value.description.slice(0, 1000) : '';
    return /qq.*farm|farm.*qq|nqf|农场/i.test(name) || /qq\s*农场|qq[ -]*farm/i.test(description);
}

/** request(path, {signal}) returns {statusCode, body}; injected requests must not retain private data. */
async function collectPublicReferences({ dataDir, now = Date.now(), request = publicRequest }) {
    const seeds = referenceSeeds(dataDir);
    const previous = readRecord(dataDir, seeds);
    const searchedAt = new Date(now).toISOString();
    if (previous && previous.policyFingerprint === policyFingerprint(seeds) && previous.searchedAt.slice(0, 10) === searchedAt.slice(0, 10)) {
        try { writeRecord(dataDir, previous); } catch {}
        return summary(previous, true);
    }
    const record = emptyRecord(seeds);
    record.searchedAt = searchedAt;
    const seen = new Map((previous?.seenCandidates || previous?.candidates || []).map(item => [item.ownerRepo, item]));
    const found = new Map();
    const deadline = Date.now() + 45000;
    let calls = 0;
    let stopped = false;
    async function get(apiPath) {
        if (stopped) return null;
        const remaining = deadline - Date.now();
        if (calls >= MAX_REQUESTS || remaining <= 0) {
            record.failureReason = 'budget_exhausted'; stopped = true; return null;
        }
        calls += 1;
        const controller = new AbortController();
        let timer;
        try {
            const response = await Promise.race([
                Promise.resolve().then(() => request(apiPath, { signal: controller.signal })),
                new Promise((resolve, reject) => {
                    timer = setTimeout(() => { controller.abort(); reject(new Error('timeout')); }, Math.min(4000, remaining));
                }),
            ]);
            if ([403, 429].includes(response?.statusCode)) {
                record.failureReason = 'rate_limited'; stopped = true; return null;
            }
            if (response?.statusCode !== 200 || !response.body || typeof response.body !== 'object') {
                record.failureReason = 'invalid_response'; return null;
            }
            return response.body;
        } catch (error) {
            record.failureReason = error?.message === 'timeout' || error?.name === 'AbortError' ? 'timeout'
                : error?.message === 'invalid_response' ? 'invalid_response' : 'network';
            return null;
        } finally { clearTimeout(timer); }
    }
    for (const seed of record.seedStatus) {
        if (stopped) break;
        const metadata = fromMetadata(await get(`/repos/${seed.ownerRepo}`));
        const commits = await get(`/repos/${seed.ownerRepo}/commits?per_page=${HISTORY_SIZE}`);
        seed.sha = Array.isArray(commits) ? sha(commits[0]?.sha) : '';
        seed.state = metadata?.ownerRepo === seed.ownerRepo && seed.sha ? 'available' : 'unavailable';
        if (metadata?.ownerRepo === seed.ownerRepo) found.set(seed.ownerRepo, { ...metadata, sha: seed.sha, ...activitySample(commits, now) });
        if (!stopped && seed.state !== 'available' && record.failureReason === 'none') record.failureReason = 'invalid_response';
    }
    for (const [index, query] of QUERIES.entries()) {
        if (stopped) break;
        const body = await get(`/search/repositories?q=${encodeURIComponent(query)}&sort=updated&order=desc&per_page=10`);
        const valid = Array.isArray(body?.items) && body.incomplete_results !== true;
        record.queries[index].state = valid ? 'succeeded' : 'failed';
        if (!valid && !stopped && record.failureReason === 'none') record.failureReason = 'invalid_response';
        for (const item of Array.isArray(body?.items) ? body.items.slice(0, 10) : []) {
            const clean = relevant(item) && fromMetadata(item);
            if (clean && !found.has(clean.ownerRepo)) {
                found.set(clean.ownerRepo, clean);
                if (found.size > 40) {
                    const oldest = [...found.values()].filter(item => !seeds.includes(item.ownerRepo))
                        .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt) || a.stars - b.stars)[0];
                    found.delete(oldest.ownerRepo);
                }
            }
        }
    }
    const extra = [...found.values()].filter(item => !seeds.includes(item.ownerRepo))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || (b.recentCommits || 0) - (a.recentCommits || 0) || b.stars - a.stars);
    for (const item of extra.slice(0, Math.max(0, MAX_REQUESTS - calls))) {
        if (stopped) break;
        const commits = await get(`/repos/${item.ownerRepo}/commits?per_page=${HISTORY_SIZE}`);
        item.sha = Array.isArray(commits) ? sha(commits[0]?.sha) : '';
        Object.assign(item, activitySample(commits, now));
        if (!item.sha && !stopped && record.failureReason === 'none') record.failureReason = 'invalid_response';
    }
    extra.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || (b.recentCommits || 0) - (a.recentCommits || 0) || b.stars - a.stars);
    record.candidates = [...seeds.map(name => found.get(name)).filter(Boolean), ...extra];
    record.candidates = record.candidates.map(candidate).filter(Boolean);
    record.newCandidates = extra.filter(item => !seen.has(item.ownerRepo)).map(item => item.ownerRepo);
    record.changedCandidates = record.candidates.filter(item => item.sha && seen.get(item.ownerRepo)?.sha
        && item.sha !== seen.get(item.ownerRepo).sha).map(item => item.ownerRepo);
    record.seenCandidates = candidates([...record.candidates.map(item => ({
        ...item, sha: item.sha || seen.get(item.ownerRepo)?.sha || '',
    })), ...seen.values()]);
    record.state = discoveryComplete(record) ? 'complete' : found.size || record.queries.some(item => item.state === 'succeeded') ? 'partial' : 'unavailable';
    try { writeRecord(dataDir, record); } catch {
        record.failureReason = 'storage_failed'; record.state = record.candidates.length ? 'partial' : 'unavailable';
    }
    return summary(record);
}

module.exports = { collectPublicReferences, getPublicReferenceSummary };
