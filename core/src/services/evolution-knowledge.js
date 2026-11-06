/** Private retrieval corpus. External text is evidence, never executable instructions. */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const { readPrivateConfig } = require('./private-config');

const FILE = 'index.json';
const MAX_TEXT_BYTES = 128 * 1024;
const MAX_DOCUMENTS = 600;
const DISPOSITIONS = new Set(['affected', 'not_affected', 'pending', 'adopted', 'rejected']);
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const validSha = value => typeof value === 'string' && /^[a-f\d]{40}$/.test(value);
function repoName(value) {
    if (typeof value !== 'string' || !/^[a-z\d][a-z\d-]{0,38}\/[\w.-]{1,100}$/i.test(value)) throw new Error('invalid_repository');
    const name = value.toLowerCase();
    if (name.split('/').some(part => ['.', '..', '__proto__', 'constructor', 'prototype'].includes(part))) throw new Error('invalid_repository');
    return name;
}
function sourcePath(value) {
    if (typeof value !== 'string' || !value || value.length > 500 || (value.includes('\\') || [...value].some(char => char.charCodeAt(0) < 32))
        || value.startsWith('/') || value.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('invalid_source_path');
    return value;
}
function resolveKnowledgeDir(options = {}) {
    const dataDir = path.resolve(options.dataDir || process.env.FARM_DATA_DIR || path.join(__dirname, '..', '..', 'data'));
    const config = readPrivateConfig({ file: process.env.FARM_PRIVATE_CONFIG_FILE || path.join(dataDir, 'private-config.json') });
    return path.resolve(options.knowledgeDir || process.env.FARM_EVOLUTION_KNOWLEDGE_DIR
        || config.evolutionKnowledgeDir || path.join(dataDir, 'evolution-knowledge'));
}
function safeFile(root, name) {
    const target = path.resolve(root, name);
    if (path.dirname(target) !== path.resolve(root)) throw new Error('path_escape');
    if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) throw new Error('symlink_file');
    return target;
}
function emptyIndex() { return { version: 1, documents: {}, repositories: {}, updatedAt: 0 }; }
function readIndex(options) {
    const root = resolveKnowledgeDir(options);
    const file = safeFile(root, FILE);
    if (!fs.existsSync(file)) return emptyIndex();
    if (fs.statSync(file).size > 90 * 1024 * 1024) throw new Error('index_size_limit');
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (value.version !== 1 || !value.documents || !value.repositories) throw new Error('invalid_index');
    return value;
}
function processStart(pid) {
    try {
        const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
        return stat.slice(stat.lastIndexOf(')') + 2).split(/\s+/)[19] || '';
    } catch { return ''; }
}
function sameDirectory(left, right) { return left.dev === right.dev && left.ino === right.ino; }
function acquireWriteLock(root) {
    const lock = safeFile(root, '.write-lock');
    const ownerName = `owner-${crypto.randomUUID()}.json`;
    const owner = { pid: process.pid, start: processStart(process.pid), host: os.hostname() };
    for (let attempt = 0; attempt < 2; attempt += 1) {
        try { fs.mkdirSync(lock, { mode: 0o700 }); } catch (error) {
            if (error.code !== 'EEXIST' || attempt) throw new Error('knowledge_locked');
            const entries = fs.readdirSync(lock);
            if (!entries.length && Date.now() - fs.statSync(lock).mtimeMs > 60000) {
                // rmdir is atomic and refuses a directory in which a live owner has appeared.
                fs.rmdirSync(lock);
                continue;
            }
            if (entries.length !== 1 || !/^owner-[a-f\d-]+\.json$/.test(entries[0])) throw new Error('knowledge_locked');
            const oldFile = path.join(lock, entries[0]);
            const old = JSON.parse(fs.readFileSync(oldFile, 'utf8'));
            if (!Number.isSafeInteger(old.pid) || old.pid < 1 || old.host !== os.hostname()) throw new Error('knowledge_locked');
            let dead = false;
            try { process.kill(old.pid, 0); } catch (cause) { dead = cause.code === 'ESRCH'; }
            const start = processStart(old.pid);
            if (old.start && start && old.start !== start) dead = true;
            if (!dead) throw new Error('knowledge_locked');
            // The unique owner filename prevents a second reclaimer from unlinking a new lock.
            // If another reclaimer wins, unlink fails; never proceed to rmdir in that case.
            fs.unlinkSync(oldFile);
            fs.rmdirSync(lock);
            continue;
        }
        const identity = fs.statSync(lock);
        const ownerFile = path.join(lock, ownerName);
        fs.writeFileSync(ownerFile, JSON.stringify(owner), { flag: 'wx', mode: 0o600 });
        if (!sameDirectory(identity, fs.statSync(lock))) {
            fs.rmSync(ownerFile, { force: true });
            throw new Error('knowledge_lock_changed');
        }
        return () => {
            if (!fs.existsSync(lock) || !sameDirectory(identity, fs.statSync(lock))) return;
            fs.unlinkSync(ownerFile);
            fs.rmdirSync(lock);
        };
    }
    throw new Error('knowledge_locked');
}
function updateIndex(options, operation) {
    const root = resolveKnowledgeDir(options);
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    const release = acquireWriteLock(root);
    const temp = safeFile(root, `index.${crypto.randomUUID()}.tmp`);
    try {
        const index = readIndex(options);
        const value = operation(index);
        index.updatedAt = options.now ?? Date.now();
        fs.writeFileSync(temp, JSON.stringify(index), { mode: 0o600 });
        fs.renameSync(temp, safeFile(root, FILE));
        return value;
    } finally {
        fs.rmSync(temp, { force: true });
        release();
    }
}
function normalizeDocument(input, now) {
    const repo = repoName(input.repo);
    const kind = input.kind;
    if (!['issue', 'code'].includes(kind)) throw new Error('invalid_document_kind');
    if (typeof input.text !== 'string' || Buffer.byteLength(input.text) > MAX_TEXT_BYTES || input.text.includes('\0')) throw new Error('invalid_document_text');
    const title = String(input.title || '').slice(0, 1000);
    let source;
    if (kind === 'issue') {
        if (!Number.isSafeInteger(input.number) || input.number < 1 || !['open', 'closed'].includes(input.state)
            || !Number.isFinite(Date.parse(input.updatedAt))) throw new Error('invalid_issue');
        const comments = (input.comments || []).map(comment => {
            if (!Number.isSafeInteger(comment.id) || comment.id < 1 || !Number.isFinite(Date.parse(comment.updatedAt))
                || typeof comment.text !== 'string' || Buffer.byteLength(comment.text) > MAX_TEXT_BYTES) throw new Error('invalid_comment');
            return { id: comment.id, updatedAt: comment.updatedAt, text: comment.text };
        }).slice(0, 1000);
        source = { number: input.number, state: input.state, updatedAt: input.updatedAt,
            commentCount: Number.isSafeInteger(input.commentCount) ? input.commentCount : comments.length,
            commentsComplete: input.commentsComplete === true, comments, commentsStale: input.commentsStale === true,
            commentsNextPage: Number.isInteger(input.commentsNextPage) ? Math.max(1, Math.min(11, input.commentsNextPage)) : 1,
            commentsFetchedAt: Number.isFinite(input.commentsFetchedAt) ? input.commentsFetchedAt : 0 };
        if (source.commentCount !== comments.length) source.commentsComplete = false;
    } else {
        if (!validSha(input.sha)) throw new Error('invalid_source_sha');
        source = { path: sourcePath(input.path), sha: input.sha };
    }
    if (Buffer.byteLength(JSON.stringify(source)) + Buffer.byteLength(input.text) > MAX_TEXT_BYTES) throw new Error('document_size_limit');
    const id = hash(`${repo}\n${kind}\n${kind === 'issue' ? source.number : source.path}`);
    const revisionSource = { ...source };
    delete revisionSource.commentsFetchedAt;
    delete revisionSource.commentsNextPage;
    const sourceHash = hash(JSON.stringify({ repo, kind, title, text: input.text, ...revisionSource }));
    return { id, repo, kind, title, text: input.text, ...source, sourceHash, fetchedAt: now,
        citation: kind === 'issue' ? `${repo}#${source.number}`
            : `${repo}@${source.sha}:${source.path}` };
}
function putDocuments(index, documents, now) {
    let changed = 0;
    for (const input of documents) {
        const doc = normalizeDocument(input, now);
        const previous = index.documents[doc.id];
        if (previous?.sourceHash === doc.sourceHash) doc.review = previous.review;
        else changed += 1;
        index.documents[doc.id] = doc;
        index.repositories[doc.repo] ||= { pending: ['discovery_not_collected'], lastAttemptAt: 0 };
    }
    const docs = Object.values(index.documents).sort((a, b) => b.fetchedAt - a.fetchedAt || a.id.localeCompare(b.id));
    const unresolved = docs.filter(doc => !doc.review || ['pending', 'affected'].includes(doc.review.disposition));
    if (unresolved.length > MAX_DOCUMENTS) throw new Error('knowledge_capacity_pending_review');
    const retained = new Set(unresolved.map(doc => doc.id));
    index.documents = Object.fromEntries([...unresolved, ...docs.filter(doc => !retained.has(doc.id))]
        .slice(0, MAX_DOCUMENTS).map(doc => [doc.id, doc]));
    return changed;
}
function ingestKnowledge(options) {
    if (!Array.isArray(options.documents) || options.documents.length > MAX_DOCUMENTS) throw new Error('invalid_documents');
    // Validate the complete transaction before creating directories or writing any data.
    const now = options.now ?? Date.now();
    options.documents.forEach(doc => normalizeDocument(doc, now));
    const changed = updateIndex(options, index => putDocuments(index, options.documents, now));
    return { ...getKnowledgeSummary(options), changed };
}
function recordKnowledgeReview(options) {
    if (!/^[a-f\d]{64}$/.test(options.id || '') || !/^[a-f\d]{64}$/.test(options.sourceHash || '')
        || !DISPOSITIONS.has(options.disposition) || typeof options.localEvidence !== 'string' || !options.localEvidence.trim()
        || options.localEvidence.length > 4000 || typeof options.conclusion !== 'string' || options.conclusion.length > 4000) throw new Error('invalid_review');
    return updateIndex(options, (index) => {
        const doc = index.documents[options.id];
        if (!doc || doc.sourceHash !== options.sourceHash
            || (doc.kind === 'code' && index.repositories[doc.repo]?.sha && index.repositories[doc.repo].sha !== doc.sha)) throw new Error('source_changed');
        doc.review = { sourceHash: options.sourceHash, disposition: options.disposition, localEvidence: options.localEvidence,
            conclusion: options.conclusion, reviewedAt: options.now ?? Date.now(),
            localSourceFingerprint: /^[a-f\d]{64}$/.test(options.localSourceFingerprint || '') ? options.localSourceFingerprint : '' };
        return doc.review;
    });
}
function getKnowledgeDocument(options = {}) {
    if (!/^[a-f\d]{64}$/.test(options.id || '')) throw new Error('invalid_document_id');
    return readIndex(options).documents[options.id] || null;
}
function getKnowledgeSummary(options = {}) {
    let index;
    try { index = readIndex(options); } catch {
        return { state: 'unavailable', reason: 'invalid_index', knowledgeDir: resolveKnowledgeDir(options),
            indexFile: path.join(resolveKnowledgeDir(options), FILE), documentCount: 0, reviewedCount: 0, pending: [], repositories: [] };
    }
    const documents = Object.values(index.documents);
    const repositories = Object.entries(index.repositories).map(([repo, record]) => ({ repo, ...record }));
    const pending = repositories.flatMap(item => (item.pending || []).map(reason => ({ repo: item.repo, reason })));
    for (const doc of documents.filter(doc => doc.kind === 'issue' && !doc.commentsComplete)) {
        if (!pending.some(item => item.repo === doc.repo && item.reason === `issue_${doc.number}_comments_pending`)) {
            pending.push({ repo: doc.repo, reason: `issue_${doc.number}_comments_pending` });
        }
    }
    return { state: !documents.length ? 'unavailable' : pending.length ? 'partial' : 'available',
        knowledgeDir: resolveKnowledgeDir(options), indexFile: path.join(resolveKnowledgeDir(options), FILE),
        updatedAt: index.updatedAt, documentCount: documents.length,
        issueCount: documents.filter(doc => doc.kind === 'issue').length, codeCount: documents.filter(doc => doc.kind === 'code').length,
        reviewedCount: documents.filter(doc => doc.review?.sourceHash === doc.sourceHash && doc.review.disposition !== 'pending'
            && (doc.kind !== 'code' || !index.repositories[doc.repo]?.sha || index.repositories[doc.repo].sha === doc.sha)).length,
        pendingReview: documents.filter(doc => doc.review?.sourceHash !== doc.sourceHash || ['pending', 'affected'].includes(doc.review?.disposition))
            .map(doc => ({ id: doc.id, sourceHash: doc.sourceHash, repo: doc.repo, kind: doc.kind, title: doc.title })).slice(0, 40),
        repositories, pending, scope: 'bounded sampled sources; collection is not review' };
}
function tokens(text) {
    const output = String(text).toLowerCase().match(/[a-z\d_]{2,}/g) || [];
    for (const run of String(text).match(/[\u3400-\u9FFF]+/g) || []) {
        if (run.length === 1) output.push(run);
        for (let i = 0; i < run.length - 1; i += 1) output.push(run.slice(i, i + 2));
    }
    return output;
}
function queryKnowledge(options = {}) {
    const index = readIndex(options);
    const query = [...new Set(tokens(String(options.query || '').slice(0, 8000)))];
    const docs = Object.values(index.documents);
    const allTerms = docs.map(doc => tokens(`${doc.title} ${doc.title} ${doc.text} ${(doc.comments || []).map(c => c.text).join(' ')}`));
    const average = allTerms.reduce((sum, terms) => sum + terms.length, 0) / Math.max(1, docs.length);
    const frequencies = new Map(query.map(term => [term, allTerms.filter(terms => terms.includes(term)).length]));
    let room = Math.max(500, Math.min(30000, Number(options.maxChars) || 12000));
    const now = options.now ?? Date.now();
    const ranked = docs.map((doc, i) => {
        const counts = new Map();
        for (const term of allTerms[i]) counts.set(term, (counts.get(term) || 0) + 1);
        const score = query.reduce((sum, term) => {
            const count = counts.get(term) || 0;
            const df = frequencies.get(term);
            return sum + Math.log(1 + (docs.length - df + 0.5) / (df + 0.5)) * count * 2.2
                / (count + 1.2 * (0.25 + 0.75 * allTerms[i].length / Math.max(1, average)));
        }, 0);
        return { doc, score };
    }).filter(item => item.score > 0).sort((a, b) => b.score - a.score || b.doc.fetchedAt - a.doc.fetchedAt);
    const results = [];
    for (const { doc, score } of ranked.slice(0, Math.min(20, Math.max(1, Number(options.limit) || 8)))) {
        if (room <= 0) break;
        const fullText = `${doc.title}\n${doc.text}\n${(doc.comments || []).map(c => `comment ${c.id}: ${c.text}`).join('\n')}`;
        const lowerText = fullText.toLowerCase();
        const bestTerm = query.filter(term => lowerText.includes(term)).sort((a, b) => frequencies.get(a) - frequencies.get(b))[0];
        const offset = bestTerm ? Math.max(0, lowerText.indexOf(bestTerm) - 250) : 0;
        const text = fullText.slice(offset, offset + Math.min(room, 2500));
        room -= text.length;
        const coverage = index.repositories[doc.repo];
        const checkedAt = doc.kind === 'code' && coverage?.sha === doc.sha ? coverage.headCheckedAt || doc.fetchedAt : doc.fetchedAt;
        const stale = now - checkedAt > 86400000 || (coverage?.pending || []).some(value => /unavailable|failed/.test(value))
            || (doc.kind === 'code' && coverage?.sha && coverage.sha !== doc.sha);
        results.push({ id: doc.id, repo: doc.repo, kind: doc.kind, sourceHash: doc.sourceHash, citation: doc.citation,
            sha: doc.sha, path: doc.path, number: doc.number, updatedAt: doc.updatedAt, state: doc.state, fetchedAt: doc.fetchedAt,
            commentsComplete: doc.commentsComplete, commentsStale: doc.commentsStale, commentsFetchedAt: doc.commentsFetchedAt, review: doc.review || null, freshness: stale ? 'stale' : 'fresh',
            score, text, excerptStart: offset, excerptEnd: offset + text.length, excerptTruncated: text.length < fullText.length });
    }
    return { results, summary: getKnowledgeSummary(options), untrusted: true };
}
function issueDocument(repo, issue, comments = [], complete = false) {
    return { repo, kind: 'issue', number: issue.number, title: issue.title || '', text: issue.body || '',
        state: issue.state, updatedAt: issue.updated_at, commentCount: issue.comments || 0,
        commentsComplete: complete || !issue.comments,
        comments: comments.map(c => ({ id: c.id, updatedAt: c.updated_at || c.created_at, text: c.body || '' })) };
}
function selectRepositories(candidates, seeds, index) {
    const found = new Map();
    for (const candidate of candidates) {
        try {
            const repo = repoName(candidate.ownerRepo);
            if (candidate.stars > 10 || seeds.includes(repo)) found.set(repo, { ...candidate, ownerRepo: repo });
        } catch { /* Untrusted metadata is not a filesystem name. */ }
    }
    for (const repo of seeds) if (!found.has(repo)) found.set(repo, { ownerRepo: repo, sha: '', updatedAt: '' });
    return [...found.values()].sort((a, b) => (index.repositories[a.ownerRepo]?.lastAttemptAt || 0)
        - (index.repositories[b.ownerRepo]?.lastAttemptAt || 0) || String(b.updatedAt).localeCompare(String(a.updatedAt))).slice(0, 4);
}
/** All GETs share the caller's budget/deadline. No credential, URL fetch or execution from source text. */
async function collectKnowledge(options) {
    const { get, remaining = () => 0, candidates = [], seeds = [], now = Date.now() } = options;
    const initial = readIndex(options);
    const selected = selectRepositories(candidates, seeds, initial);
    for (const item of selected) {
        const repo = item.ownerRepo;
        const previous = initial.repositories[repo] || {};
        const coverage = { ...previous, pending: [], sha: validSha(item.sha) ? item.sha : previous.sha || '' };
        if (validSha(item.sha)) coverage.headCheckedAt = now;
        const documents = [];
        // Resume unfinished source reading before another batch of changing issue comments.
        const codeFirst = !!previous.issueCheckedAt && (previous.codeSha !== coverage.sha || !previous.codeComplete);
        async function hydrateCode() {
            if (!validSha(item.sha) && remaining() > 0) {
                const commits = await get(`/repos/${repo}/commits?per_page=1`);
                if (validSha(commits?.[0]?.sha)) { coverage.sha = commits[0].sha; coverage.headCheckedAt = now; }
                else coverage.pending.push('head_unavailable');
            }
            if (coverage.sha && (coverage.codeSha !== coverage.sha || !coverage.codeComplete)) {
                let tree = coverage.treeSha === coverage.sha ? coverage.paths : null;
                if (!tree && remaining() > 0) {
                    const body = await get(`/repos/${repo}/git/trees/${coverage.sha}?recursive=1`);
                    if (Array.isArray(body?.tree)) {
                        tree = body.tree.filter(entry => entry.type === 'blob' && entry.size <= MAX_TEXT_BYTES
                            && /\.(?:md|js|ts|vue|py|json)$/i.test(entry.path) && !/(?:^|\/)(?:node_modules|vendor|dist|proto)(?:\/|$)/i.test(entry.path))
                            .map(entry => { try { return sourcePath(entry.path); } catch { return ''; } }).filter(Boolean);
                        const readme = tree.find(name => /^readme\.md$/i.test(name));
                        const source = tree.find(name => !/\.(?:md|json)$/i.test(name) && /schedul|automat|activity|farm/i.test(name));
                        tree = [...new Set([readme, source].filter(Boolean))];
                        coverage.paths = tree; coverage.treeSha = coverage.sha;
                        coverage.treeTruncated = body.truncated === true;
                    } else coverage.pending.push('code_tree_unavailable');
                }
                for (const file of tree || []) {
                    const id = hash(`${repo}\ncode\n${file}`);
                    if (initial.documents[id]?.sha === coverage.sha) continue;
                    if (remaining() <= 0) { coverage.pending.push(`code_pending:${file}`); continue; }
                    const body = await get(`/repos/${repo}/contents/${file.split('/').map(encodeURIComponent).join('/')}?ref=${coverage.sha}`);
                    if (body?.type !== 'file' || body.encoding !== 'base64' || body.size > MAX_TEXT_BYTES || typeof body.content !== 'string'
                        || body.content.length > MAX_TEXT_BYTES * 1.5) { coverage.pending.push(`code_unavailable:${file}`); continue; }
                    const text = Buffer.from(body.content, 'base64').toString('utf8');
                    try { documents.push(normalizeDocument({ repo, kind: 'code', sha: coverage.sha, path: file, title: file, text }, now)); }
                    catch { coverage.pending.push(`code_invalid:${file}`); }
                }
                if (!tree?.length) coverage.pending.push('code_paths_pending');
                if (tree?.length && !tree.some(file => !/\.(?:md|json)$/i.test(file))) coverage.pending.push('code_source_not_found');
                if (coverage.treeTruncated) coverage.pending.push('code_tree_truncated');
                coverage.codeComplete = !!tree?.length && !coverage.treeTruncated && tree.some(file => !/\.(?:md|json)$/i.test(file)) && tree.every(file => initial.documents[hash(`${repo}\ncode\n${file}`)]?.sha === coverage.sha
                    || documents.some(doc => doc.kind === 'code' && doc.path === file));
                if (coverage.codeComplete) { coverage.codeSha = coverage.sha; coverage.codeCheckedAt = now; }
            } else if (!coverage.sha) coverage.pending.push('head_pending');
        }
        if (codeFirst) await hydrateCode();
        let latestIssues = null;
        if (remaining() > 0) {
            coverage.lastAttemptAt = now;
            // Alternate newest issues and bounded older pages, retaining unresolved sources.
            const page = previous.scanOlderNext ? previous.nextIssuePage || 2 : 1;
            const body = await get(`/search/issues?q=${encodeURIComponent(`repo:${repo} is:issue`)}&sort=updated&order=desc&per_page=10&page=${page}`);
            if (Array.isArray(body?.items) && body.incomplete_results !== true) {
                latestIssues = body.items.filter(issue => !issue.pull_request).slice(0, 10);
                coverage.issueCheckedAt = now;
                coverage.issueSampleSize = latestIssues.length;
                coverage.issuePage = page;
                coverage.scanOlderNext = page === 1 && body.total_count > 10;
                coverage.nextIssuePage = page > 1 ? (page * 10 < Math.min(100, body.total_count) ? page + 1 : 2) : previous.nextIssuePage || 2;
                coverage.issuesTruncated = body.total_count > latestIssues.length;
                if (coverage.issuesTruncated) coverage.pending.push('issues_beyond_recent_sample');
                for (const issue of latestIssues) {
                    const id = hash(`${repo}\nissue\n${issue.number}`);
                    const old = initial.documents[id];
                    const unchanged = old && old.updatedAt === issue.updated_at && old.commentCount === (issue.comments || 0)
                        && old.text === (issue.body || '') && old.title === (issue.title || '') && old.state === issue.state;
                    let comments = old && issue.comments ? old.comments.map(c => ({ id: c.id, updated_at: c.updatedAt, body: c.text })) : [];
                    let complete = unchanged && old.commentsComplete;
                    let commentsStale = !!issue.comments && !!old?.comments?.length && (!unchanged || old.commentsStale === true);
                    let commentsFetchedAt = old?.commentsFetchedAt || 0;
                    let commentsNextPage = unchanged && !old.commentsStale ? old.commentsNextPage || 1 : 1;
                    if (issue.comments && !complete && commentsNextPage <= 10 && remaining() > 3) {
                        const result = await get(`/repos/${repo}/issues/${issue.number}/comments?per_page=100&page=${commentsNextPage}`);
                        if (Array.isArray(result)) {
                            const merged = commentsNextPage === 1 ? result : [...comments, ...result];
                            comments = [...new Map(merged.map(comment => [comment.id, comment])).values()];
                            complete = comments.length === issue.comments;
                            if (result.length) commentsNextPage += 1;
                            commentsStale = false; commentsFetchedAt = now;
                        }
                    }
                    if (issue.comments && !complete) coverage.pending.push(`issue_${issue.number}_comments_pending`);
                    if (issue.comments > 1000) coverage.pending.push(`issue_${issue.number}_comments_limit`);
                    try { documents.push({ ...issueDocument(repo, issue, comments, complete), commentsStale, commentsFetchedAt, commentsNextPage }); }
                    catch { coverage.pending.push(`issue_${issue.number}_invalid`); }
                }
            } else coverage.pending.push('issues_unavailable');
        } else coverage.pending.push('issues_budget_pending');
        if (!codeFirst) await hydrateCode();
        // Invalid source bodies stay pending; do not drop a previous valid version.
        const valid = documents.filter(doc => { try { normalizeDocument(doc, now); return true; } catch { coverage.pending.push('document_invalid'); return false; } });
        updateIndex(options, index => {
            putDocuments(index, valid, now);
            index.repositories[repo] = coverage;
            const entries = Object.entries(index.repositories).sort((a, b) => b[1].lastAttemptAt - a[1].lastAttemptAt);
            index.repositories = Object.fromEntries(entries.slice(0, 40));
        });
    }
    return getKnowledgeSummary(options);
}

module.exports = { resolveKnowledgeDir, getKnowledgeDocument, getKnowledgeSummary, queryKnowledge, ingestKnowledge, recordKnowledgeReview,
    collectKnowledge, issueDocument };
