const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const { normalizeBaselineChecks, runBaselineChecks, getCountercheckSummary } = require('../src/services/evolution-countercheck');

const SOURCE = 'core/src/value.js';
const TEST = 'core/test/value.test.js';
const SPEC = { sourceFiles: [SOURCE], testFiles: [TEST], minFailures: 1 };
const TEST_BODY = "const test = require('node:test'); const assert = require('node:assert/strict'); test('current behavior', () => assert.equal(require('../src/value'), 1));\n";

function fixture(t, { oldSource = 'module.exports = 0;\n', testBody = TEST_BODY, extra = {} } = {}) {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'farm-countercheck-test-'));
    t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
    const write = (file, content) => {
        fs.mkdirSync(path.dirname(path.join(repoRoot, file)), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, file), content);
    };
    const git = args => execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    git(['init', '--quiet']);
    write('.gitignore', 'core/data/\nweb/dist/\nnode_modules/\ntmp/\n');
    write(SOURCE, oldSource);
    write(TEST, '// Historical tests must be replaced with the current tests.\n');
    write('core/package.json', '{"type":"commonjs"}\n');
    write('core/package-lock.json', '{"lockfileVersion":3}\n');
    for (const [file, content] of Object.entries(extra)) write(file, content);
    git(['add', '.']);
    git(['-c', 'user.name=Test', '-c', 'user.email=test@users.noreply.github.com', 'commit', '--quiet', '-m', 'fixture']);
    const baseCommit = git(['rev-parse', 'HEAD']).trim();
    write(SOURCE, 'module.exports = 1;\n');
    write(TEST, testBody);
    write('core/data/local-only.json', 'private fixture value');
    write('web/dist/index.html', 'live frontend');
    const dataDir = path.join(repoRoot, 'core/data');
    return { repoRoot, dataDir, write, git, options: { repoRoot, dataDir, baseCommit, checks: [SPEC] } };
}

function assertCleanTemporary(f) {
    assert.deepEqual(fs.readdirSync(f.dataDir).sort(), ['evolution-countercheck.json', 'local-only.json']);
    assert.equal(fs.readFileSync(path.join(f.repoRoot, 'web/dist/index.html'), 'utf8'), 'live frontend');
}

test('normalizes bounded explicit scopes and preserves optional compatibility', () => {
    assert.deepEqual(normalizeBaselineChecks(), []);
    assert.deepEqual(normalizeBaselineChecks([]), []);
    assert.deepEqual(normalizeBaselineChecks([SPEC]), [SPEC]);
    for (const value of [null, {}, [null], [{ ...SPEC, command: 'anything' }],
        Array.from({ length: 5 }, () => SPEC), [{ ...SPEC, sourceFiles: [] }],
        { ...SPEC }, [{ ...SPEC, minFailures: 0 }], [{ ...SPEC, minFailures: 101 }],
        [{ ...SPEC, minFailures: 1.5 }], [{ ...SPEC, minFailures: '1' }],
        [{ ...SPEC, sourceFiles: Array.from({ length: 13 }, (_, index) => `core/src/file${index}.js`) }],
        [{ ...SPEC, testFiles: Array.from({ length: 9 }, (_, index) => `core/test/file${index}.test.js`) }],
        [{ ...SPEC, sourceFiles: [SOURCE, SOURCE] }],
    ]) assert.throws(() => normalizeBaselineChecks(value), { code: 'EVOLUTION_COUNTERCHECK_INVALID_CHECKS' });
    for (const file of ['../core/src/value.js', '/core/src/value.js', 'core/src/../value.js',
        'core/src/.hidden/value.js', 'core/src/-flag.js', 'core\\src\\value.js',
        'core/src/value.js\n', 'core/src/value.js;echo', 'core/src/', 'core/test/value.test.js', 'web/src/test/value.js', 'core/src/value.test.js']) {
        assert.throws(() => normalizeBaselineChecks([{ ...SPEC, sourceFiles: [file] }]), { code: 'EVOLUTION_COUNTERCHECK_INVALID_CHECKS' });
    }
    assert.throws(() => normalizeBaselineChecks([{ ...SPEC, testFiles: ['core/test/sub/value.test.js'] }]), { code: 'EVOLUTION_COUNTERCHECK_INVALID_CHECKS' });
});

test('executes real current and old behavior, retaining only safe evidence and leaving the worktree untouched', async (t) => {
    const f = fixture(t);
    const before = f.git(['diff', '--binary']);
    const result = await runBaselineChecks(f.options);
    assert.equal(result.state, 'passed');
    assert.equal(result.cached, false);
    assert.equal(result.baseCommit, f.options.baseCommit);
    assert.equal(result.checks[0].current.total, 1);
    assert.equal(result.checks[0].current.passed, 1);
    assert.equal(result.checks[0].baseline.behaviorFailures, 1);
    assert.equal(result.checks[0].baseline.otherFailures, 0);
    assert.match(result.digest, /^[a-f0-9]{64}$/);
    assert.equal(f.git(['diff', '--binary']), before);
    assertCleanTemporary(f);
    const record = fs.readFileSync(path.join(f.dataDir, 'evolution-countercheck.json'), 'utf8');
    assert.equal(record.includes(f.repoRoot), false);
    assert.equal(record.includes('Expected values'), false);
    assert.equal(record.includes('current behavior'), false);
    assert.equal(record.includes('private fixture value'), false);
    assert.equal(fs.statSync(path.join(f.dataDir, 'evolution-countercheck.json')).mode & 0o777, 0o600);
});

test('reuses successful evidence and invalidates it for source, tests, dependencies and malformed records', async (t) => {
    const f = fixture(t);
    let previous = await runBaselineChecks(f.options);
    assert.equal((await runBaselineChecks(f.options)).cached, true);
    f.write('docs/HANDOFF.md', 'Evidence notes must not invalidate code results.\n');
    assert.equal((await runBaselineChecks(f.options)).cached, true);
    for (const [file, content] of [[SOURCE, 'module.exports = 1; // changed\n'],
        [TEST, `${TEST_BODY}// changed\n`], ['core/package-lock.json', '{"lockfileVersion":3,"version":"1"}\n']]) {
        f.write(file, content);
        const next = await runBaselineChecks(f.options);
        assert.equal(next.cached, false);
        assert.notEqual(next.fingerprint, previous.fingerprint);
        previous = next;
    }
    const cacheFile = path.join(f.dataDir, 'evolution-countercheck.json');
    const record = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    record.checks[0].baseline.behaviorFailures = 900;
    fs.writeFileSync(cacheFile, JSON.stringify(record));
    assert.equal(getCountercheckSummary(f.dataDir).state, 'unknown');
    assert.equal((await runBaselineChecks(f.options)).cached, false);
    assertCleanTemporary(f);
});

test('rejects a baseline which also passes instead of treating exit success as a counterexample', async (t) => {
    const f = fixture(t, { oldSource: 'module.exports = 1; // no behavioral defect\n' });
    await assert.rejects(runBaselineChecks(f.options), { code: 'EVOLUTION_COUNTERCHECK_BASELINE_INCONCLUSIVE' });
    assert.equal(getCountercheckSummary(f.dataDir).state, 'failed');
    await assert.rejects(runBaselineChecks(f.options), { code: 'EVOLUTION_COUNTERCHECK_BASELINE_INCONCLUSIVE' });
    assertCleanTemporary(f);
});

test('does not count baseline import errors, syntax errors or explicit throws as behavior evidence', async (t) => {
    for (const oldSource of ["module.exports = require('./does-not-exist');\n", 'module.exports = ;\n', "throw new Error('fixture error');\n"]) {
        const f = fixture(t, { oldSource });
        await assert.rejects(runBaselineChecks(f.options), { code: 'EVOLUTION_COUNTERCHECK_BASELINE_INCONCLUSIVE' });
        const summary = getCountercheckSummary(f.dataDir);
        assert.equal(summary.checks[0].baseline.behaviorFailures, 0);
        assert.equal(summary.checks[0].baseline.otherFailures, 1);
        assertCleanTemporary(f);
    }
});

test('rejects current failure, skipped tests and todo tests even when the process succeeds', async (t) => {
    for (const body of [TEST_BODY.replace('1));', '2));'),
        `${TEST_BODY}test.skip('not run', () => {});\n`, `${TEST_BODY}test.todo('not verified');\n`]) {
        const f = fixture(t, { testBody: body });
        await assert.rejects(runBaselineChecks(f.options), { code: 'EVOLUTION_COUNTERCHECK_CURRENT_FAILED' });
        assertCleanTemporary(f);
    }
});

test('requires the agreed failure minimum and the same test total', async (t) => {
    const f = fixture(t);
    await assert.rejects(runBaselineChecks({ ...f.options, checks: [{ ...SPEC, minFailures: 2 }] }), { code: 'EVOLUTION_COUNTERCHECK_BASELINE_INCONCLUSIVE' });
    const dynamic = fixture(t, { testBody: `${TEST_BODY}if (require('../src/value') === 0) test('extra baseline test', () => assert.equal(0, 1));\n` });
    await assert.rejects(runBaselineChecks(dynamic.options), { code: 'EVOLUTION_COUNTERCHECK_BASELINE_INCONCLUSIVE' });
});

test('recognizes nested assertion causes while keeping propagated parent failures separate', async (t) => {
    const f = fixture(t, { testBody: "const test = require('node:test'); const assert = require('node:assert/strict'); test('group', async t => { await t.test('child', () => assert.equal(require('../src/value'), 1)); });\n" });
    const result = await runBaselineChecks(f.options);
    assert.equal(result.checks[0].baseline.total, 2);
    assert.equal(result.checks[0].baseline.behaviorFailures, 1);
    assert.equal(result.checks[0].baseline.propagatedFailures, 1);
    assert.equal(result.checks[0].baseline.otherFailures, 0);
});

test('uses only requested old sources while retaining current other sources and fixtures', async (t) => {
    const f = fixture(t, {
        extra: { 'core/src/other.js': 'module.exports = 0;\n', 'core/src/data/fixture.json': '{"value":1}\n' },
        testBody: `${TEST_BODY}test('current other source', () => assert.equal(require('../src/other'), 1)); test('source fixture', () => assert.equal(require('../src/data/fixture.json').value, 1));\n`,
    });
    f.write('core/src/other.js', 'module.exports = 1;\n');
    const result = await runBaselineChecks(f.options);
    assert.equal(result.checks[0].baseline.behaviorFailures, 1);
    assert.equal(result.checks[0].baseline.passed, 2);
});

test('isolates current and baseline runtime artifacts and does not pass provider environment variables', async (t) => {
    const f = fixture(t, { testBody: `${TEST_BODY}
const fs = require('node:fs'); const path = require('node:path');
test('private isolation', () => {
    assert.equal(fs.existsSync(path.join(process.cwd(), 'data/local-only.json')), false);
    assert.equal(fs.existsSync(path.join(process.cwd(), '../web/dist/index.html')), false);
    assert.equal(process.env.COUNTERCHECK_PRIVATE, undefined);
    const git = require('node:child_process').spawnSync('git', ['rev-parse', '--show-toplevel'], {cwd: process.cwd(), encoding: 'utf8'});
    assert.notEqual(git.status, 0);
    assert.equal(fs.existsSync(process.env.FARM_DATA_DIR), false);
    fs.mkdirSync(process.env.FARM_DATA_DIR, {recursive: true});
    fs.writeFileSync(path.join(process.env.FARM_DATA_DIR, 'fixture.txt'), 'isolated');
    fs.writeFileSync(path.join(process.cwd(), 'created-by-test.txt'), 'isolated');
});\n` });
    const result = await runBaselineChecks({ ...f.options, env: { ...process.env, COUNTERCHECK_PRIVATE: 'fixture value' } });
    assert.equal(result.checks[0].baseline.behaviorFailures, 1);
    assert.equal(result.checks[0].baseline.passed, 1);
    assert.equal(fs.existsSync(path.join(f.repoRoot, 'core/created-by-test.txt')), false);
    assertCleanTemporary(f);
});

test('rejects changes to the real worktree while the coordinator is running', async (t) => {
    const f = fixture(t);
    const result = runBaselineChecks(f.options);
    f.write('core/src/concurrent.js', 'module.exports = 1;\n');
    await assert.rejects(result, { code: 'EVOLUTION_COUNTERCHECK_SOURCE_CHANGED' });
    assert.equal(getCountercheckSummary(f.dataDir).state, 'failed');
    assertCleanTemporary(f);
});

test('rejects unchanged, missing and unsafe scopes, non-ancestor baselines and publishable evidence locations', async (t) => {
    const f = fixture(t);
    for (const baseCommit of ['HEAD', `${f.options.baseCommit}:core`, '0'.repeat(40)]) {
        await assert.rejects(runBaselineChecks({ ...f.options, baseCommit }), { code: 'EVOLUTION_COUNTERCHECK_INVALID_BASE' });
    }
    await assert.rejects(runBaselineChecks({ ...f.options, dataDir: path.join(f.repoRoot, 'evidence') }), { code: 'EVOLUTION_COUNTERCHECK_UNSAFE_DATA_DIR' });
    await assert.rejects(runBaselineChecks({ ...f.options, checks: [{ ...SPEC, sourceFiles: ['core/src/missing.js'] }] }), { code: 'EVOLUTION_COUNTERCHECK_INVALID_SCOPE' });
    f.write(SOURCE, 'module.exports = 0;\n');
    await assert.rejects(runBaselineChecks(f.options), { code: 'EVOLUTION_COUNTERCHECK_UNCHANGED_SCOPE' });
    fs.unlinkSync(path.join(f.repoRoot, SOURCE));
    fs.symlinkSync(path.join(f.repoRoot, TEST), path.join(f.repoRoot, SOURCE));
    await assert.rejects(runBaselineChecks(f.options), { code: 'EVOLUTION_COUNTERCHECK_UNSAFE_SOURCE' });
});

test('rejects symlinks in the historical Git tree', async (t) => {
    const f = fixture(t);
    fs.symlinkSync('value.js', path.join(f.repoRoot, 'core/src/link.js'));
    f.git(['add', 'core/src/link.js']);
    f.git(['-c', 'user.name=Test', '-c', 'user.email=test@users.noreply.github.com', 'commit', '--quiet', '-m', 'symlink fixture']);
    const baseCommit = f.git(['rev-parse', 'HEAD']).trim();
    await assert.rejects(runBaselineChecks({ ...f.options, baseCommit }), { code: 'EVOLUTION_COUNTERCHECK_UNSAFE_BASE' });
});

test('empty optional checks require no repository access or persisted success', async () => {
    assert.deepEqual(await runBaselineChecks({ checks: undefined }), { state: 'not_required', cached: false, checks: [] });
});

test('coordinator interruption kills its running test group and never leaves success evidence', { timeout: 15_000 }, async (t) => {
    const f = fixture(t, { testBody: `const test = require('node:test'); const fs = require('node:fs'); const path = require('node:path');
test('wait for coordinator', async () => {
    fs.mkdirSync(process.env.FARM_DATA_DIR, {recursive: true});
    fs.writeFileSync(path.join(process.env.FARM_DATA_DIR, 'pid'), String(process.pid));
    await new Promise(resolve => setTimeout(resolve, 60_000));
});\n` });
    const modulePath = require.resolve('../src/services/evolution-countercheck');
    const script = `require(${JSON.stringify(modulePath)}).runBaselineChecks(${JSON.stringify(f.options)}).then(() => process.stdout.write('unexpected success'), error => process.stdout.write(error.code));`;
    const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
    t.after(() => child.kill('SIGKILL'));
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', () => {});
    const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
    let testPid = 0;
    const deadline = Date.now() + 5000;
    while (!testPid && Date.now() < deadline) {
        for (const entry of fs.readdirSync(f.dataDir)) {
            if (!entry.startsWith('evolution-countercheck-')) continue;
            try { testPid = Number(fs.readFileSync(path.join(f.dataDir, entry, 'runtime-0-current/pid'), 'utf8')); } catch {}
        }
        if (!testPid) await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.ok(testPid > 0);
    child.kill('SIGTERM');
    const exit = await exited;
    assert.equal(exit.code, 0);
    assert.equal(output, 'EVOLUTION_COUNTERCHECK_INTERRUPTED');
    assert.equal(getCountercheckSummary(f.dataDir).state, 'failed');
    let stopped = false;
    try { process.kill(testPid, 0); } catch (error) { stopped = error.code === 'ESRCH'; }
    if (!stopped && process.platform === 'linux') {
        try { stopped = /\) Z /.test(fs.readFileSync(`/proc/${testPid}/stat`, 'utf8')); } catch (error) { stopped = error.code === 'ENOENT'; }
    }
    assert.equal(stopped, true);
    assertCleanTemporary(f);
});
