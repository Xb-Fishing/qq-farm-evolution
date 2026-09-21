/** Coordinator-owned counterexamples, executed without modifying the shared worktree. */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync, spawn } = require('node:child_process');

const VERSION = 1;
const CACHE_FILE = 'evolution-countercheck.json';
const MAX_OUTPUT = 512 * 1024;
const TIMEOUT_MS = 120_000;
const COUNTS = ['total', 'passed', 'failed', 'skipped', 'todo', 'behaviorFailures', 'otherFailures', 'propagatedFailures'];

function fail(category) {
    const error = new Error(`Evolution countercheck failed: ${category}`);
    error.code = `EVOLUTION_COUNTERCHECK_${category.toUpperCase()}`;
    return error;
}

function safeRelative(file) {
    return typeof file === 'string' && file.length <= 240
        && file.split('/').every(part => /^\w[\w.-]*$/.test(part));
}

function normalizeBaselineChecks(value) {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > 4) throw fail('invalid_checks');
    return value.map((check) => {
        if (!check || typeof check !== 'object' || Array.isArray(check)
            || Object.keys(check).some(key => !['sourceFiles', 'testFiles', 'minFailures'].includes(key))) throw fail('invalid_checks');
        const files = (input, limit, pattern) => {
            if (!Array.isArray(input) || !input.length || input.length > limit
                || input.some(file => !safeRelative(file) || !pattern.test(file))
                || new Set(input).size !== input.length) throw fail('invalid_checks');
            return [...input].sort();
        };
        const sourceFiles = files(check.sourceFiles, 12, /^(?:core|web)\/src\/.+\.\w+$/);
        if (sourceFiles.some(file => /\/(?:tests?|__tests__)\/|\.(?:test|spec)\.[^.]+$/.test(file))) throw fail('invalid_checks');
        const testFiles = files(check.testFiles, 8, /^core\/test\/[^/]+\.test\.js$/);
        if (!Number.isInteger(check.minFailures) || check.minFailures < 1 || check.minFailures > 100) throw fail('invalid_checks');
        return { sourceFiles, testFiles, minFailures: check.minFailures };
    });
}

function git(repoRoot, args, encoding = 'utf8') {
    return execFileSync('git', args, {
        cwd: repoRoot, encoding, timeout: 15_000, maxBuffer: 64 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
    });
}

function allowedSnapshotFile(file) {
    if (!safeRelative(file)) return false;
    if (/^(?:core\/data|web\/dist|logs?|tmp|temp|coverage|dist)(?:\/|$)/.test(file)) return false;
    if (/(?:^|\/)node_modules(?:\/|$)/.test(file)) return false;
    if (/\.(?:log|env|pem|key)$/i.test(file)) return false;
    return true;
}

function isLogicFile(file) {
    if (/^(?:core\/(?:src|test|scripts)|web\/(?:src|public)|scripts)\//.test(file)) return true;
    if (/^(?:core\/|web\/)?[^/]+\.(?:[cm]?js|[cm]?ts|json|ya?ml|sh|html)$/.test(file)) return true;
    return /^(?:core\/|web\/)?(?:yarn\.lock|bun\.lockb?)$/.test(file);
}

function assertNoSymlink(repoRoot, file) {
    let location = repoRoot;
    for (const part of file.split('/')) {
        location = path.join(location, part);
        try {
            if (fs.lstatSync(location).isSymbolicLink()) throw fail('unsafe_source');
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
        }
    }
}

function snapshot(repoRoot) {
    const files = [...new Set(git(repoRoot, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'])
        .split('\0').filter(file => file && allowedSnapshotFile(file)))].sort();
    const hash = crypto.createHash('sha256');
    hash.update(`${VERSION}\0${process.version}\0${process.platform}\0${process.arch}\0`);
    const existingFiles = [];
    for (const file of files) {
        assertNoSymlink(repoRoot, file);
        const logical = isLogicFile(file);
        if (logical) hash.update(`${file}\0`);
        let stat;
        try { stat = fs.lstatSync(path.join(repoRoot, file)); } catch (error) {
            if (error.code !== 'ENOENT') throw error;
            if (logical) hash.update('deleted\0');
            continue;
        }
        if (!stat.isFile()) throw fail('unsafe_source');
        if (logical) {
            const content = fs.readFileSync(path.join(repoRoot, file));
            hash.update(`${stat.mode & 0o777}\0${content.length}\0`);
            hash.update(content);
        }
        existingFiles.push(file);
    }
    return { files: existingFiles, fingerprint: hash.digest('hex') };
}

function digest(value) {
    return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function validCounts(value) {
    return value && COUNTS.every(key => Number.isSafeInteger(value[key]) && value[key] >= 0)
        && value.total === value.passed + value.failed
        && value.failed === value.behaviorFailures + value.otherFailures + value.propagatedFailures
        && Array.isArray(value.failures) && value.failures.length <= 100
        && value.failures.every(item => /^test-[a-f0-9]{16}$/.test(item.test)
            && ['behavior', 'other', 'propagated'].includes(item.classification));
}

function positive(value) {
    return validCounts(value) && value.total > 0 && value.passed === value.total
        && value.failed === 0 && value.skipped === 0 && value.todo === 0;
}

function negative(value, current, minFailures) {
    return validCounts(value) && value.total === current.total
        && value.behaviorFailures >= minFailures && value.otherFailures === 0
        && value.skipped === 0 && value.todo === 0;
}

function readRecord(dataDir) {
    try {
        const value = JSON.parse(fs.readFileSync(path.join(dataDir, CACHE_FILE), 'utf8'));
        if (value.version !== VERSION || !['passed', 'failed', 'running'].includes(value.state)
            || !Number.isSafeInteger(value.checkedAt) || !/^[a-f0-9]{64}$/.test(value.fingerprint)
            || !/^[a-f0-9]{40}$/.test(value.baseCommit) || !/^[a-f0-9]{64}$/.test(value.key)) return null;
        const { digest: recordedDigest, ...body } = value;
        if (digest(body) !== recordedDigest) return null;
        if (!Array.isArray(value.checks)) return null;
        const specs = normalizeBaselineChecks(value.checks.map(({ sourceFiles, testFiles, minFailures }) => ({ sourceFiles, testFiles, minFailures })));
        if (value.state === 'passed' && (!specs.length || value.checks.some(check => !positive(check.current)
            || !negative(check.baseline, check.current, check.minFailures)))) return null;
        return value;
    } catch { return null; }
}

function getCountercheckSummary(dataDir) {
    const value = readRecord(dataDir);
    if (!value) return { state: 'unknown', checkedAt: 0, checks: [] };
    return {
        state: value.state, checkedAt: value.checkedAt, baseCommit: value.baseCommit,
        fingerprint: value.fingerprint, digest: value.digest,
        checks: value.checks.map(check => ({
            sourceFiles: [...check.sourceFiles], testFiles: [...check.testFiles], minFailures: check.minFailures,
            ...(check.current ? { current: safeCounts(check.current) } : {}),
            ...(check.baseline ? { baseline: safeCounts(check.baseline) } : {}),
        })),
    };
}

function safeCounts(value) {
    if (!validCounts(value)) throw fail('invalid_report');
    return Object.fromEntries([...COUNTS.map(key => [key, value[key]]), ['failures', value.failures.map(({ test, classification }) => ({ test, classification }))]]);
}

function writeRecord(dataDir, body) {
    const record = { version: VERSION, ...body };
    record.digest = digest(record);
    const temporary = path.join(dataDir, `${CACHE_FILE}.${crypto.randomUUID()}.tmp`);
    try {
        fs.writeFileSync(temporary, `${JSON.stringify(record)}\n`, { mode: 0o600 });
        fs.renameSync(temporary, path.join(dataDir, CACHE_FILE));
    } finally { fs.rmSync(temporary, { force: true }); }
    return record;
}

function runNode(args, options) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
        let outputSize = 0;
        let reason = '';
        const stop = (category) => {
            if (reason) return;
            reason = category;
            try {
                if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
                else child.kill('SIGKILL');
            } catch {}
        };
        const timer = setTimeout(() => stop('timeout'), TIMEOUT_MS);
        const interrupted = () => stop('interrupted');
        process.once('SIGTERM', interrupted);
        process.once('SIGINT', interrupted);
        const cleanup = () => {
            clearTimeout(timer);
            process.removeListener('SIGTERM', interrupted);
            process.removeListener('SIGINT', interrupted);
            if (process.platform !== 'win32' && child.pid) {
                try { process.kill(-child.pid, 'SIGKILL'); } catch {}
            }
        };
        for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk) => {
            outputSize += chunk.length;
            if (outputSize > MAX_OUTPUT) stop('output_limit');
        });
        child.once('error', () => { cleanup(); reject(fail('execution')); });
        child.once('close', (code, signal) => {
            cleanup();
            if (reason || signal) reject(fail(reason || 'execution'));
            else resolve(code);
        });
    });
}

function privateDataDir(repoRoot, dataDir) {
    const relative = path.relative(repoRoot, path.join(dataDir, CACHE_FILE));
    if (!relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) {
        try { git(repoRoot, ['check-ignore', '--quiet', '--', relative]); } catch { throw fail('unsafe_data_dir'); }
    }
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
}

async function executeBaselineChecks({ repoRoot, dataDir, baseCommit, checks, env = process.env }) {
    checks = normalizeBaselineChecks(checks);
    if (!checks.length) return { state: 'not_required', cached: false, checks: [] };
    if (typeof baseCommit !== 'string' || !/^[a-f0-9]{40}$/.test(baseCommit)) throw fail('invalid_base');
    repoRoot = fs.realpathSync(repoRoot);
    dataDir = path.resolve(dataDir);
    privateDataDir(repoRoot, dataDir);
    try { git(repoRoot, ['merge-base', '--is-ancestor', baseCommit, 'HEAD']); } catch { throw fail('invalid_base'); }
    const baseTree = git(repoRoot, ['ls-tree', '-rz', baseCommit]).split('\0').filter(Boolean);
    if (baseTree.some(line => !/^100(?:644|755) blob /.test(line))) throw fail('unsafe_base');
    const baseFiles = new Set(baseTree.map(line => line.slice(line.indexOf('\t') + 1)));
    const before = snapshot(repoRoot);
    const baselineContents = new Map();
    for (const check of checks) {
        for (const file of [...check.sourceFiles, ...check.testFiles]) {
            if (!before.files.includes(file)) throw fail('invalid_scope');
        }
        for (const file of check.sourceFiles) {
            const content = baseFiles.has(file) ? git(repoRoot, ['show', `${baseCommit}:${file}`], null) : null;
            if (content && content.equals(fs.readFileSync(path.join(repoRoot, file)))) throw fail('unchanged_scope');
            baselineContents.set(file, content);
        }
    }
    const key = digest({ version: VERSION, fingerprint: before.fingerprint, baseCommit, checks, node: process.version });
    const cached = readRecord(dataDir);
    if (cached?.state === 'passed' && cached.key === key) return { ...getCountercheckSummary(dataDir), cached: true };
    const evidence = checks.map(check => ({ ...check }));
    const record = state => ({ state, checkedAt: Date.now(), fingerprint: before.fingerprint, baseCommit, key, checks: evidence });
    writeRecord(dataDir, record('running'));
    let temporary;
    try {
        temporary = fs.mkdtempSync(path.join(dataDir, 'evolution-countercheck-'));
        fs.chmodSync(temporary, 0o700);
        const reporter = path.join(temporary, 'reporter.cjs');
        fs.copyFileSync(path.join(__dirname, '../../scripts/countercheck-reporter.cjs'), reporter);
        const template = path.join(temporary, 'snapshot');
        for (const file of before.files) {
            const destination = path.join(template, file);
            fs.mkdirSync(path.dirname(destination), { recursive: true });
            fs.copyFileSync(path.join(repoRoot, file), destination);
        }
        for (let index = 0; index < checks.length; index += 1) {
            const check = checks[index];
            const runEnv = Object.fromEntries(['PATH', 'LANG', 'LC_ALL', 'TZ'].filter(key => typeof env[key] === 'string').map(key => [key, env[key]]));
            const execute = async (stage) => {
                const isolated = path.join(temporary, `check-${index}-${stage}`);
                fs.cpSync(template, isolated, { recursive: true });
                for (const prefix of ['', 'core', 'web']) {
                    const modules = path.join(repoRoot, prefix, 'node_modules');
                    if (fs.existsSync(modules)) {
                        fs.mkdirSync(path.join(isolated, prefix), { recursive: true });
                        fs.symlinkSync(fs.realpathSync(modules), path.join(isolated, prefix, 'node_modules'), 'dir');
                    }
                }
                if (stage === 'baseline') {
                    for (const file of check.sourceFiles) {
                        const content = baselineContents.get(file);
                        if (content === null) fs.rmSync(path.join(isolated, file));
                        else fs.writeFileSync(path.join(isolated, file), content);
                    }
                }
                Object.assign(runEnv, {
                    HOME: temporary, TMPDIR: temporary, GIT_CEILING_DIRECTORIES: temporary,
                    FARM_DATA_DIR: path.join(temporary, `runtime-${index}-${stage}`),
                });
                const reportFile = path.join(temporary, `${index}-${stage}.json`);
                const code = await runNode(['--test', '--test-concurrency=1', '--test-reporter', reporter,
                    '--test-reporter-destination', reportFile, ...check.testFiles.map(file => file.slice('core/'.length))], {
                    cwd: path.join(isolated, 'core'), env: runEnv,
                });
                let result;
                try {
                    if (fs.statSync(reportFile).size > MAX_OUTPUT) throw fail('output_limit');
                    result = safeCounts(JSON.parse(fs.readFileSync(reportFile, 'utf8')));
                } catch { throw fail('invalid_report'); }
                return { code, result };
            };
            const current = await execute('current');
            if (current.code !== 0 || !positive(current.result)) throw fail('current_failed');
            evidence[index].current = current.result;
            const baseline = await execute('baseline');
            evidence[index].baseline = baseline.result;
            if (baseline.code !== 1 || !negative(baseline.result, current.result, check.minFailures)) throw fail('baseline_inconclusive');
        }
        if (snapshot(repoRoot).fingerprint !== before.fingerprint) throw fail('source_changed');
        fs.rmSync(temporary, { recursive: true, force: true });
        temporary = null;
        writeRecord(dataDir, record('passed'));
        return { ...getCountercheckSummary(dataDir), cached: false };
    } catch (error) {
        let category = (error.code || '').startsWith('EVOLUTION_COUNTERCHECK_') ? error.code.slice('EVOLUTION_COUNTERCHECK_'.length).toLowerCase() : 'execution';
        try { if (snapshot(repoRoot).fingerprint !== before.fingerprint) category = 'source_changed'; } catch { category = 'source_changed'; }
        try { writeRecord(dataDir, { ...record('failed'), failure: category }); } catch {}
        throw fail(category);
    } finally {
        if (temporary) fs.rmSync(temporary, { recursive: true, force: true });
    }
}

async function runBaselineChecks(options) {
    try { return await executeBaselineChecks(options); } catch (error) {
        if (/^EVOLUTION_COUNTERCHECK_[A-Z_]+$/.test(error.code || '')) throw error;
        throw fail('setup_failed');
    }
}

module.exports = { normalizeBaselineChecks, runBaselineChecks, getCountercheckSummary };
