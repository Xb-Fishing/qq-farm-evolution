const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const root = fs.mkdtempSync(path.join(path.resolve(os.tmpdir()), 'farm-runtime-modes-'));
process.env.FARM_DATA_DIR = path.join(root, 'import-data');
const publish = require('../src/services/evolution-publish');
const { logicSnapshot, runEvolutionValidation } = require('../src/services/evolution-validation');
const protectedFiles = [__filename, require.resolve('../src/services/evolution-publish')];
const snapshot = () => protectedFiles.map(file => ({ file, mode: fs.statSync(file).mode & 0o777,
    sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') }));
const before = snapshot();
const bounded = (dir, file) => {
    const target = path.resolve(dir, file);
    if (target !== dir && !target.startsWith(dir + path.sep)) throw new Error('fixture_escape');
    return target;
};
test.after(() => {
    try { fs.rmSync(bounded(root, '.'), { recursive: true, force: true }); }
    finally { assert.deepEqual(snapshot(), before); }
});
let sequence = 0;
async function fixture(t) {
    const dir = bounded(root, `case-${++sequence}`); fs.mkdirSync(dir);
    const write = (relative, body) => { const file = bounded(dir, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, body); };
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (/^GIT_CONFIG_(?:COUNT|KEY_\d+|VALUE_\d+)$/.test(key)) delete env[key];
    const git = (args, cwd = dir) => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    write('.gitignore', 'tmp/\ncore/data/\n');
    write('core/src/example.js', 'module.exports = 1;\n');
    write('core/test/example.test.js', 'require("node:assert/strict").equal(require("../src/example"),1);\n');
    git(['init', '-q']); git(['config', 'user.name', 'Fixture']); git(['config', 'user.email', 'fixture@users.noreply.github.com']);
    git(['add', '.']); git(['commit', '-qm', 'fixture']);
    const commit = git(['rev-parse', 'HEAD']); const runId = 'verified-mode-task';
    const taskRoot = bounded(dir, `tmp/evolution-workspaces/${runId}/task`);
    fs.mkdirSync(path.dirname(taskRoot), { recursive: true }); git(['worktree', 'add', '--detach', taskRoot, commit]);
    fs.chmodSync(path.join(taskRoot, 'core/src/example.js'), 0o640);
    const dataDir = bounded(dir, 'core/data'); fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    publish.recordProvenance(dataDir, { runId, taskRoot, publicBase: commit, headAtCreation: commit,
        repoRootReal: dir, commonDir: publish.realCommonDir(dir), createdAt: Date.now() });
    const validation = await runEvolutionValidation({ repoRoot: taskRoot, dataDir,
        env: { PATH: path.dirname(process.execPath) + path.delimiter + process.env.PATH },
        execute: async (bin, args, options) => { execFileSync(bin, args, { ...options, stdio: 'pipe' }); return { exitCode: 0 }; } });
    t.after(() => fs.rmSync(bounded(root, path.basename(dir)), { recursive: true, force: true }));
    return { dir, dataDir, taskRoot, commit, validation,
        args: { repoRoot: dir, runId, commit, dataDir, options: { env }, validatedSourceRoot: taskRoot } };
}

test('an umask-077 checkout and an existing failed runtime match the actual validated task modes', async t => {
    const f = await fixture(t);
    const oldMask = process.umask(0o077);
    let runtime;
    try { runtime = publish.prepareRuntimeWorkspace(f.args); } finally { process.umask(oldMask); }
    assert.equal(runtime.logicFingerprint, f.validation.fingerprint);
    assert.equal(fs.statSync(path.join(runtime.runtimeRoot, 'core/src/example.js')).mode & 0o777, 0o640);
    const sourceBefore = logicSnapshot(f.taskRoot).fingerprint;
    const file = path.join(runtime.runtimeRoot, 'core/src/example.js'); fs.chmodSync(file, 0o600);
    assert.notEqual(logicSnapshot(runtime.runtimeRoot).fingerprint, f.validation.fingerprint);
    const again = publish.prepareRuntimeWorkspace(f.args);
    assert.equal(again.logicFingerprint, f.validation.fingerprint);
    assert.equal(logicSnapshot(f.taskRoot).fingerprint, sourceBefore);
    assert.equal(fs.statSync(path.join(f.dataDir, 'evolution-validation.json')).mode & 0o777, 0o600);
});

test('missing validation rejects before runtime creation or chmod; valid sources still execute guarded writes', async t => {
    const f = await fixture(t);
    const record = path.join(f.dataDir, 'evolution-validation.json'); const bytes = fs.readFileSync(record);
    fs.unlinkSync(record);
    const originalMkdir = fs.mkdirSync; const originalChmod = fs.fchmodSync;
    let creates = 0; let modes = 0;
    try {
        fs.mkdirSync = (...args) => { creates += 1; return originalMkdir(...args); };
        fs.fchmodSync = (...args) => { modes += 1; return originalChmod(...args); };
        assert.throws(() => publish.prepareRuntimeWorkspace(f.args), { code: 'publish_failed' });
        assert.equal(creates, 0); assert.equal(modes, 0);
        fs.writeFileSync(record, bytes, { mode: 0o600 });
        const runtime = publish.prepareRuntimeWorkspace(f.args);
        assert.equal(runtime.logicFingerprint, f.validation.fingerprint);
        assert.ok(creates > 0); assert.ok(modes > 0);
    } finally { fs.mkdirSync = originalMkdir; fs.fchmodSync = originalChmod; }
});

test('unregistered sources and dirty runtime content are rejected without altering the trusted task', async t => {
    const f = await fixture(t);
    assert.throws(() => publish.prepareRuntimeWorkspace({ ...f.args, validatedSourceRoot: f.dir }), { code: 'publish_failed' });
    const runtime = publish.prepareRuntimeWorkspace(f.args);
    const sourceBefore = logicSnapshot(f.taskRoot).fingerprint;
    const file = path.join(runtime.runtimeRoot, 'core/src/example.js'); fs.writeFileSync(file, 'module.exports=99;\n');
    assert.throws(() => publish.prepareRuntimeWorkspace(f.args), { code: 'publish_failed' });
    assert.equal(fs.readFileSync(file, 'utf8'), 'module.exports=99;\n');
    assert.equal(logicSnapshot(f.taskRoot).fingerprint, sourceBefore);
});
