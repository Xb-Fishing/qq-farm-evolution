/** Private, content-addressed evidence for the complete offline regression suite. */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const CACHE_FILE = 'evolution-validation.json';
const VERSION = 1;
const STATES = new Set(['running', 'passed', 'failed']);

function validationError(category) {
    const error = new Error(`Evolution validation failed: ${category}`);
    error.code = `EVOLUTION_VALIDATION_${category.toUpperCase()}`;
    return error;
}

function git(repoRoot, args) {
    return execFileSync('git', args, {
        cwd: repoRoot, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
    });
}

function isLogicFile(file) {
    if (/^(?:core\/data|web\/dist|node_modules|logs?|tmp|temp|coverage|\.git)\//.test(file)) return false;
    if (/(?:^|\/)node_modules\//.test(file)) return false;
    if (/^(?:core\/(?:src|test|scripts)|web\/(?:src|public)|scripts)\//.test(file)) return true;
    if (/^(?:core\/|web\/)?[^/]+\.(?:[cm]?js|[cm]?ts|json|ya?ml|sh|html)$/.test(file)) return true;
    return /^(?:core\/|web\/)?(?:\.npmrc|\.nvmrc|\.node-version|\.gitignore|yarn\.lock|bun\.lockb?)$/.test(file);
}

function logicSnapshot(repoRoot) {
    const files = [...new Set(git(repoRoot, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'])
        .split('\0').filter(file => file && isLogicFile(file)))].sort();
    const hash = crypto.createHash('sha256');
    hash.update(`validation:${VERSION}\0node:${process.version}\0platform:${process.platform}:${process.arch}\0`);
    const tests = [];
    for (const file of files) {
        hash.update(`${Buffer.byteLength(file)}:${file}\0`);
        let stat;
        try { stat = fs.lstatSync(path.join(repoRoot, file)); } catch (error) {
            if (error.code !== 'ENOENT') throw error;
            hash.update('deleted\0');
            continue;
        }
        if (!stat.isFile() && !stat.isSymbolicLink()) throw validationError('unsupported_source');
        hash.update(`mode:${stat.mode & 0o777}\0`);
        if (stat.isSymbolicLink()) hash.update(`link:${fs.readlinkSync(path.join(repoRoot, file))}\0`);
        const content = fs.readFileSync(path.join(repoRoot, file));
        hash.update(`${content.length}:`);
        hash.update(content);
        hash.update('\0');
        if (/^core\/test\/[^/]+\.test\.js$/.test(file)) tests.push(file.slice('core/'.length));
    }
    return { fingerprint: hash.digest('hex'), tests };
}

function readRecord(dataDir) {
    try {
        const value = JSON.parse(fs.readFileSync(path.join(dataDir, CACHE_FILE), 'utf8'));
        if (value.version !== VERSION || !STATES.has(value.state)
            || !Number.isSafeInteger(value.checkedAt) || value.checkedAt <= 0
            || !(/^[a-f0-9]{64}$/.test(value.fingerprint) || (value.state !== 'passed' && value.fingerprint === ''))
            || !Array.isArray(value.checks)
            || value.checks.some(check => check !== 'backend' && check !== 'frontend')
            || !['', 'backend', 'backend,frontend'].includes(value.checks.join(','))) return null;
        return {
            state: value.state, checkedAt: value.checkedAt,
            fingerprint: value.fingerprint, checks: [...value.checks],
        };
    } catch {
        return null;
    }
}

function getValidationSummary(dataDir) {
    return readRecord(dataDir) || { state: 'unknown', checkedAt: 0, fingerprint: '', checks: [] };
}

function writeRecord(dataDir, record) {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const tempFile = path.join(dataDir, `${CACHE_FILE}.${crypto.randomUUID()}.tmp`);
    try {
        fs.writeFileSync(tempFile, `${JSON.stringify({ version: VERSION, ...record })}\n`, { mode: 0o600 });
        fs.renameSync(tempFile, path.join(dataDir, CACHE_FILE));
    } finally {
        fs.rmSync(tempFile, { force: true });
    }
}

function assertPrivateDataDir(repoRoot, dataDir) {
    const relative = path.relative(repoRoot, path.join(dataDir, CACHE_FILE));
    if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return;
    git(repoRoot, ['check-ignore', '--quiet', '--', relative]);
}

/** execute must reject on process failure; raw command output is never retained here. */
async function runEvolutionValidation({ repoRoot, dataDir, execute, env = process.env, force = false }) {
    let fingerprint = '';
    let tempDir;
    let privateDataDir = false;
    let category = 'setup_failed';
    const checks = [];
    try {
        if (typeof execute !== 'function') throw validationError(category);
        repoRoot = path.resolve(repoRoot);
        dataDir = path.resolve(dataDir);
        assertPrivateDataDir(repoRoot, dataDir);
        privateDataDir = true;
        const snapshot = logicSnapshot(repoRoot);
        fingerprint = snapshot.fingerprint;
        const hasFrontend = fs.existsSync(path.join(repoRoot, 'web/package.json'));
        const expectedChecks = hasFrontend ? ['backend', 'frontend'] : ['backend'];
        if (!snapshot.tests.length) throw validationError('tests_missing');
        const cached = readRecord(dataDir);
        if (!force && cached && cached.state === 'passed' && cached.fingerprint === fingerprint
            && cached.checks.join(',') === expectedChecks.join(',')) {
            return { cached: true, fingerprint, checkedAt: cached.checkedAt, checks: cached.checks };
        }
        // Invalidate any prior success before starting; abrupt termination cannot reuse it.
        writeRecord(dataDir, { state: 'running', checkedAt: Date.now(), fingerprint, checks });
        tempDir = fs.mkdtempSync(path.join(dataDir, 'evolution-validation-'));
        const runEnv = { ...env, FARM_DATA_DIR: path.join(tempDir, 'runtime') };
        const run = async (bin, args, cwd) => {
            const result = await execute(bin, args, { cwd, env: runEnv });
            if (result && ((result.code !== undefined && result.code !== 0)
                || (result.exitCode !== undefined && result.exitCode !== 0) || result.signal)) {
                throw validationError(category);
            }
        };
        category = 'backend_failed';
        await run(process.execPath, ['--test', '--test-concurrency=1', ...snapshot.tests], path.join(repoRoot, 'core'));
        checks.push('backend');
        if (hasFrontend) {
            const webDir = path.join(repoRoot, 'web');
            category = 'frontend_types_failed';
            await run('npm', ['exec', '--no', '--', 'vue-tsc', '-b'], webDir);
            category = 'frontend_build_failed';
            const outDir = path.join(tempDir, 'web-dist');
            await run('npm', ['exec', '--no', '--', 'vite', 'build', '--outDir', outDir, '--emptyOutDir'], webDir);
            if (!fs.statSync(path.join(outDir, 'index.html')).isFile()) throw validationError(category);
            checks.push('frontend');
        }
        category = 'source_changed';
        if (logicSnapshot(repoRoot).fingerprint !== fingerprint) throw validationError(category);
        category = 'cleanup_failed';
        fs.rmSync(tempDir, { recursive: true, force: true });
        tempDir = null;
        category = 'cache_write_failed';
        const checkedAt = Date.now();
        writeRecord(dataDir, { state: 'passed', checkedAt, fingerprint, checks });
        return { cached: false, fingerprint, checkedAt, checks };
    } catch (error) {
        if (error.code === 'EVOLUTION_VALIDATION_TESTS_MISSING') category = 'tests_missing';
        if (privateDataDir) {
            try { writeRecord(dataDir, { state: 'failed', checkedAt: Date.now(), fingerprint, checks, failure: category }); } catch {}
        }
        throw validationError(category);
    } finally {
        if (tempDir) {
            try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
        }
    }
}

module.exports = { runEvolutionValidation, getValidationSummary };
