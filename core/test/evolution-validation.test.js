const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { runEvolutionValidation, getValidationSummary } = require('../src/services/evolution-validation');

function fixture(t, frontend = true) {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'farm-validation-test-'));
    const dataDir = path.join(repoRoot, 'core/data');
    const write = (file, content) => {
        fs.mkdirSync(path.dirname(path.join(repoRoot, file)), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, file), content);
    };
    execFileSync('git', ['init', '--quiet'], { cwd: repoRoot });
    write('.gitignore', 'core/data/\nweb/dist/\nnode_modules/\n');
    write('core/src/service.js', 'module.exports = true;\n');
    write('core/test/service.test.js', '// isolated test fixture\n');
    write('core/package.json', '{}\n');
    write('core/package-lock.json', '{"lockfileVersion":3}\n');
    if (frontend) {
        write('web/package.json', '{}\n');
        write('web/src/app.ts', 'export const app = true;\n');
        write('web/tsconfig.json', '{}\n');
        write('web/dist/index.html', 'live frontend');
    }
    execFileSync('git', ['add', '.'], { cwd: repoRoot });
    const calls = [];
    const execute = async (bin, args, options) => {
        calls.push({ bin, args, options });
        const index = args.indexOf('--outDir');
        if (index >= 0) {
            fs.mkdirSync(args[index + 1], { recursive: true });
            fs.writeFileSync(path.join(args[index + 1], 'index.html'), 'candidate frontend');
        }
        return { stdout: 'private output must never be persisted', code: 0 };
    };
    const options = { repoRoot, dataDir, execute, env: { FIXTURE_ENV: 'yes' } };
    t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
    return { repoRoot, dataDir, write, calls, execute, options };
}

test('runs complete backend, typecheck and isolated build once; reuses the same logic across days', async (t) => {
    const f = fixture(t);
    const now = Date.now;
    let clock = Date.parse('2026-01-01T00:00:00Z');
    t.mock.method(Date, 'now', () => clock);
    const first = await runEvolutionValidation(f.options);
    assert.equal(first.cached, false);
    assert.equal(f.calls.length, 3);
    assert.deepEqual(first.checks, ['backend', 'frontend']);
    assert.deepEqual(f.calls[0].args, ['--test', '--test-concurrency=1', 'test/service.test.js']);
    assert.equal(f.calls[0].bin, process.execPath);
    assert.equal(f.calls[0].options.cwd, path.join(f.repoRoot, 'core'));
    assert.deepEqual(f.calls[1].args, ['exec', '--no', '--', 'vue-tsc', '-b']);
    assert.equal(f.calls[2].args.includes('build'), true);
    clock += 4 * 24 * 60 * 60 * 1000;
    const second = await runEvolutionValidation(f.options);
    assert.equal(second.cached, true);
    assert.equal(second.checkedAt, first.checkedAt);
    assert.equal(f.calls.length, 3);
    assert.equal(getValidationSummary(f.dataDir).state, 'passed');
    assert.equal(fs.statSync(path.join(f.dataDir, 'evolution-validation.json')).mode & 0o777, 0o600);
    t.mock.restoreAll();
    assert.equal(Date.now, now);
});

test('source, test, lock, config, new and deleted logic files invalidate; documentation does not', async (t) => {
    const f = fixture(t);
    let previous = await runEvolutionValidation(f.options);
    f.write('docs/notes.md', 'new explanation');
    f.write('README.md', 'new explanation');
    assert.equal((await runEvolutionValidation(f.options)).cached, true);
    for (const file of ['core/src/service.js', 'core/test/service.test.js', 'core/package-lock.json',
        'web/src/app.ts', 'web/tsconfig.json', 'scripts/check.sh', 'pnpm-lock.yaml', 'core/src/new.js',
        'core/src/data/rules.json', 'core/test/fixtures/input.txt']) {
        f.write(file, `changed ${file}`);
        const next = await runEvolutionValidation(f.options);
        assert.equal(next.cached, false, file);
        assert.notEqual(next.fingerprint, previous.fingerprint, file);
        previous = next;
    }
    fs.unlinkSync(path.join(f.repoRoot, 'core/src/service.js'));
    assert.equal((await runEvolutionValidation(f.options)).cached, false);
    fs.unlinkSync(path.join(f.repoRoot, 'core/src/new.js'));
    assert.equal((await runEvolutionValidation(f.options)).cached, false);
    f.write('core/data/private.js', 'ignored runtime changes');
    assert.equal((await runEvolutionValidation(f.options)).cached, true);
});

test('build output and test data stay private and temporary; live frontend remains intact', async (t) => {
    const f = fixture(t);
    await runEvolutionValidation(f.options);
    const build = f.calls[2];
    const outDir = build.args[build.args.indexOf('--outDir') + 1];
    assert.equal(path.relative(f.dataDir, outDir).startsWith('evolution-validation-'), true);
    assert.equal(fs.existsSync(outDir), false);
    assert.equal(fs.existsSync(f.calls[0].options.env.FARM_DATA_DIR), false);
    assert.equal(f.calls[0].options.env.FIXTURE_ENV, 'yes');
    assert.equal(fs.readFileSync(path.join(f.repoRoot, 'web/dist/index.html'), 'utf8'), 'live frontend');
    assert.deepEqual(fs.readdirSync(f.dataDir), ['evolution-validation.json']);
    const record = fs.readFileSync(path.join(f.dataDir, 'evolution-validation.json'), 'utf8');
    assert.equal(record.includes(f.repoRoot), false);
    assert.equal(record.includes('private output'), false);
});

test('failed forced validation invalidates prior success; retries and cleans failed build output', async (t) => {
    const f = fixture(t);
    await runEvolutionValidation(f.options);
    const fail = async (bin, args, options) => {
        await f.execute(bin, args, options);
        if (args.includes('vite')) throw new Error('private credential and path in raw failure');
    };
    await assert.rejects(runEvolutionValidation({ ...f.options, execute: fail, force: true }), {
        message: 'Evolution validation failed: frontend_build_failed',
    });
    const summary = getValidationSummary(f.dataDir);
    assert.equal(summary.state, 'failed');
    assert.deepEqual(summary.checks, ['backend']);
    const record = fs.readFileSync(path.join(f.dataDir, 'evolution-validation.json'), 'utf8');
    assert.equal(record.includes('private credential'), false);
    assert.deepEqual(fs.readdirSync(f.dataDir), ['evolution-validation.json']);
    assert.equal((await runEvolutionValidation(f.options)).cached, false);
    assert.equal(f.calls.length, 9);
});

test('backend process failure or interruption never caches success and stops later checks', async (t) => {
    const f = fixture(t);
    for (const outcome of [{ code: 2 }, { exitCode: 1 }, { signal: 'SIGTERM' }]) {
        let calls = 0;
        await assert.rejects(runEvolutionValidation({
            ...f.options, execute: async () => { calls += 1; return outcome; },
        }), { code: 'EVOLUTION_VALIDATION_BACKEND_FAILED' });
        assert.equal(calls, 1);
        assert.equal(getValidationSummary(f.dataDir).state, 'failed');
    }
    assert.equal((await runEvolutionValidation(f.options)).cached, false);
});

test('source mutation during execution refuses to cache the tested version', async (t) => {
    const f = fixture(t);
    await assert.rejects(runEvolutionValidation({
        ...f.options,
        execute: async (...args) => {
            const result = await f.execute(...args);
            f.write('core/src/service.js', 'source changed during execution');
            return result;
        },
    }), { code: 'EVOLUTION_VALIDATION_SOURCE_CHANGED' });
    assert.equal(getValidationSummary(f.dataDir).state, 'failed');
    assert.equal((await runEvolutionValidation(f.options)).cached, false);
});

test('malformed, incomplete or interrupted cache is not evidence of success', async (t) => {
    const f = fixture(t);
    assert.deepEqual(getValidationSummary(f.dataDir), { state: 'unknown', checkedAt: 0, fingerprint: '', checks: [] });
    await runEvolutionValidation(f.options);
    const valid = JSON.parse(fs.readFileSync(path.join(f.dataDir, 'evolution-validation.json'), 'utf8'));
    for (const invalid of ['{', { ...valid, checks: [] }, { ...valid, checks: ['frontend', 'backend'] },
        { ...valid, fingerprint: 'bad' }, { ...valid, checkedAt: 'yesterday' }, { ...valid, checks: [['backend']] },
        { ...valid, state: 'running' }, { ...valid, version: 0 }]) {
        f.write('core/data/evolution-validation.json', typeof invalid === 'string' ? invalid : JSON.stringify(invalid));
        assert.equal((await runEvolutionValidation(f.options)).cached, false);
    }
});

test('backend-only repositories work, but absent tests or missing build artifact fail closed', async (t) => {
    const backend = fixture(t, false);
    assert.deepEqual((await runEvolutionValidation(backend.options)).checks, ['backend']);
    assert.equal(backend.calls.length, 1);
    fs.unlinkSync(path.join(backend.repoRoot, 'core/test/service.test.js'));
    await assert.rejects(runEvolutionValidation(backend.options), { code: 'EVOLUTION_VALIDATION_TESTS_MISSING' });
    const frontend = fixture(t);
    await assert.rejects(runEvolutionValidation({ ...frontend.options, execute: async () => ({ code: 0 }) }), {
        code: 'EVOLUTION_VALIDATION_FRONTEND_BUILD_FAILED',
    });
});

test('Node version change invalidates successful evidence; explicit force runs again', async (t) => {
    const f = fixture(t);
    await runEvolutionValidation(f.options);
    const descriptor = Object.getOwnPropertyDescriptor(process, 'version');
    try {
        Object.defineProperty(process, 'version', { ...descriptor, value: `${process.version}-fixture` });
        assert.equal((await runEvolutionValidation(f.options)).cached, false);
    } finally {
        Object.defineProperty(process, 'version', descriptor);
    }
    assert.equal((await runEvolutionValidation(f.options)).cached, false);
    assert.equal((await runEvolutionValidation({ ...f.options, force: true })).cached, false);
    assert.equal(f.calls.length, 12);
});

test('cache must remain outside tracked public paths', async (t) => {
    const f = fixture(t);
    await assert.rejects(runEvolutionValidation({ ...f.options, dataDir: path.join(f.repoRoot, 'public-cache') }), {
        code: 'EVOLUTION_VALIDATION_SETUP_FAILED',
    });
    assert.equal(f.calls.length, 0);
    assert.equal(fs.existsSync(path.join(f.repoRoot, 'public-cache')), false);
});
