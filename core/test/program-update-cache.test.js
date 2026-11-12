'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const parent = fs.realpathSync(os.tmpdir());
const temporary = fs.mkdtempSync(path.join(parent, 'farm-install-cache-'));
process.env.FARM_DATA_DIR = path.join(temporary, 'isolated-import');
process.env.FARM_PRIVATE_CONFIG_FILE = path.join(temporary, 'missing-config.json');
const updater = require('../src/services/program-update');
const overlay = require('../src/services/program-update-overlay');
const validation = require('../src/services/evolution-validation');
after(() => fs.rmSync(temporary, { recursive: true, force: true }));
let sequence = 0;
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function put(root, relative, bytes) {
    const file = path.resolve(root, relative); assert.ok(file.startsWith(path.resolve(root) + path.sep));
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); return file;
}
const json = (root, relative, value) => put(root, relative, JSON.stringify(value));
function fixture() {
    const dir = path.resolve(temporary, `case-${++sequence}`); assert.equal(path.dirname(dir), temporary); fs.mkdirSync(dir);
    const root = path.join(dir, 'repo'); fs.mkdirSync(root);
    const git = (args, cwd = root) => cp.execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    git(['init', '-q']); git(['config', 'user.name', 'fixture']); git(['config', 'user.email', 'fixture@invalid']);
    put(root, '.gitignore', '/node_modules\n/core/node_modules\n/web/node_modules\ntmp/\n');
    for (const context of ['', 'core', 'web']) json(root, path.join(context, 'package.json'), { name: context || 'root', version: '1.0.0', dependencies: { demo: '1.0.0' } });
    put(root, 'pnpm-lock.yaml', 'synthetic-lock-v1\n'); put(root, 'pnpm-workspace.yaml', 'packages:\n  - core\n  - web\n');
    put(root, 'core/src/example.js', 'module.exports=1;\n'); put(root, 'core/test/example.test.js', '// synthetic accepted test\n');
    put(root, 'web/src/example.js', 'export default 1;\n'); put(root, 'docs/CHANGELOG.md', 'Synthetic release\n');
    git(['add', '.']); git(['commit', '-qm', 'synthetic']); const commit = git(['rev-parse', 'HEAD']);
    const dependencies = path.join(dir, 'dependencies'); fs.mkdirSync(dependencies);
    const packageRoot = path.join(dependencies, 'node_modules/.pnpm/demo@1.0.0/node_modules/demo');
    json(packageRoot, 'package.json', { name: 'demo', version: '1.0.0', main: 'index.js' }); put(packageRoot, 'index.js', 'module.exports=1;');
    put(dependencies, 'node_modules/.pnpm/lock.yaml', 'synthetic-lock-v1\n');
    for (const context of ['', 'core', 'web']) {
        const modules = path.join(dependencies, context, 'node_modules'); fs.mkdirSync(modules, { recursive: true }); fs.symlinkSync(packageRoot, path.join(modules, 'demo'), 'dir');
    }
    updater.linkDependencies(dependencies, root);
    const worktree = relative => { const target = path.resolve(dir, relative); assert.ok(target.startsWith(dir + path.sep)); fs.mkdirSync(path.dirname(target), { recursive: true }); git(['worktree', 'add', '-q', '--detach', target, commit]); updater.linkDependencies(root, target); return target; };
    const data = path.join(dir, 'data'); fs.mkdirSync(data);
    return { dir, root, git, commit, dependencies, packageRoot, worktree, data };
}
test('dependency preparation reuses installed graph across own version bumps, while changed lock or dependency field really invokes frozen install', async () => {
    for (const change of ['none', 'version', 'lock', 'dependency', 'hook']) {
        const f = fixture(); const target = f.worktree('target'); const artifactsRoot = path.join(f.dir, 'artifacts'); fs.mkdirSync(artifactsRoot);
        if (change === 'version') for (const context of ['', 'core', 'web']) { const file = path.join(target, context, 'package.json'); const d = JSON.parse(fs.readFileSync(file)); d.version = '2.0.0'; fs.writeFileSync(file, JSON.stringify(d)); }
        if (change === 'hook') put(target, '.pnpmfile.cjs', 'module.exports={hooks:{}};\n');
        if (change === 'lock') fs.appendFileSync(path.join(target, 'pnpm-lock.yaml'), '# changed\n');
        if (change === 'dependency') { const file = path.join(target, 'core/package.json'); const d = JSON.parse(fs.readFileSync(file)); d.dependencies.demo = '2.0.0'; fs.writeFileSync(file, JSON.stringify(d)); }
        let installs = 0;
        const result = await updater.prepareDependencies({ sourceRoot: f.root, taskRoot: target, artifactsRoot, execute: async (command, args, options) => {
            installs++; assert.equal(command, 'pnpm'); assert.deepEqual(args, ['install', '--frozen-lockfile', '--ignore-scripts']);
            assert.equal(options.cwd, path.join(artifactsRoot, 'dependencies'));
            if (change === 'hook') assert.equal(fs.readFileSync(path.join(options.cwd, '.pnpmfile.cjs'), 'utf8'), fs.readFileSync(path.join(target, '.pnpmfile.cjs'), 'utf8'));
            updater.linkDependencies(f.dependencies, options.cwd);
        } });
        assert.equal(result.reused, ['none', 'version'].includes(change)); assert.equal(installs, result.reused ? 0 : 1);
        assert.equal(fs.realpathSync(path.join(target, 'core/node_modules')), fs.realpathSync(path.join(f.dependencies, 'core/node_modules')));
    }
});
function privateFixture(f) {
    const prior = f.worktree('prior-private'); put(prior, 'core/src/example.js', 'module.exports=2;\n');
    const packageRoot = path.join(f.dir, 'overlay'); fs.mkdirSync(packageRoot);
    const fingerprint = validation.logicSnapshot(prior).fingerprint;
    const acceptance = JSON.stringify({ version: 1, state: 'passed', checkedAt: 1000, fingerprint, checks: ['backend', 'frontend'] });
    const preload = `module.exports={configureEvolutionFixtures:()=>({passed:true,root:${JSON.stringify(f.dir)}})};`;
    const override = fs.readFileSync(path.join(prior, 'core/src/example.js'));
    put(packageRoot, 'modules/example.js', override); put(packageRoot, 'acceptance.json', acceptance); put(packageRoot, 'preload.cjs', preload);
    put(packageRoot, 'web-dist/index.html', '<html>private verified</html>'); put(packageRoot, 'web-dist/assets/app.js', 'private verified');
    const manifest = { version: 1, localOnly: true, baselineHead: f.commit, sourceFingerprint: fingerprint,
        modules: [{ file: 'core/src/example.js', override: 'modules/example.js', sha256: sha(override), baselineSha256: sha(fs.readFileSync(path.join(f.root, 'core/src/example.js'))) }],
        assets: ['web-dist/index.html', 'web-dist/assets/app.js'].map(file => ({ file, sha256: sha(fs.readFileSync(path.join(packageRoot, file))) })),
        acceptanceSha256: sha(acceptance), privatePreloadSha256: sha(preload), privateSourceRoot: prior, publicBaseSourceRoot: f.root, privateFiles: ['core/src/example.js'] };
    json(packageRoot, 'manifest.json', manifest);
    fs.mkdirSync(path.join(f.root, 'tmp'), { recursive: true }); fs.symlinkSync(packageRoot, path.join(f.root, 'tmp/local-bark-reminder'), 'dir');
    fs.appendFileSync(path.join(f.root, '.git/info/exclude'), '\n/docs/HANDOFF.md\n/docs/skills\n/core/docs/skills\n');
    put(f.root, 'docs/HANDOFF.md', 'Synthetic private maintenance constraints\n'); put(f.root, 'docs/skills/synthetic/SKILL.md', 'Synthetic local-only rule');
    return { prior, packageRoot, fingerprint, acceptance };
}
test('release overlay keeps local resources isolated and applies without regression', async () => {
    const f = fixture(); privateFixture(f); const target = f.worktree('candidate/task'); const artifactsRoot = path.join(f.dir, 'artifacts'); fs.mkdirSync(artifactsRoot);
    let commands = 0; const before = process.umask(0o077); let result;
    try { result = await overlay.prepareOverlay({ owner: f.root, taskRoot: target, artifactsRoot,
        installOnly: true, runId: 'direct-release', executeFactory: (_logDir, onBuild) => async (_command, args) => { commands++; if (args.includes('--outDir')) { const out = args[args.indexOf('--outDir') + 1]; put(out, 'index.html', '<html>unexpected rebuilt output</html>'); if (onBuild) onBuild(out); } } }); }
    finally { process.umask(before); }
    assert.equal(result.validationReused, true); assert.equal(commands, 0);
    const manifest = overlay.verifyPackage(result.root).manifest;
    assert.equal(manifest.sourceFingerprint, validation.logicSnapshot(manifest.privateSourceRoot).fingerprint); assert.equal(manifest.publicBaseSourceRoot, target);
    assert.equal(JSON.parse(fs.readFileSync(path.join(result.root, 'acceptance.json'))).state, 'published');
    assert.equal(fs.readFileSync(path.join(result.root, 'web-dist/index.html'), 'utf8'), '<html>private verified</html>');
    const privateRoot = manifest.privateSourceRoot;
    assert.equal(fs.realpathSync(path.join(privateRoot, 'docs/HANDOFF.md')), fs.realpathSync(path.join(f.root, 'docs/HANDOFF.md')));
    assert.equal(fs.readFileSync(path.join(privateRoot, 'docs/HANDOFF.md'), 'utf8'), 'Synthetic private maintenance constraints\n');
    assert.equal(fs.realpathSync(path.join(privateRoot, 'docs/skills')), fs.realpathSync(path.join(f.root, 'docs/skills')));
    assert.equal(fs.realpathSync(path.join(privateRoot, 'core/data')), fs.realpathSync(path.join(artifactsRoot, 'private-validation/resource-data')));
    assert.equal(f.git(['ls-files', '--', 'docs/HANDOFF.md', 'docs/skills', 'core/data'], privateRoot), '');
});
test('private source changes execute the real full-validation branch; merge conflict refuses before running commands', async () => {
    for (const conflict of [false, true]) {
        const f = fixture(); privateFixture(f); const target = f.worktree('candidate/task'); const artifactsRoot = path.join(f.dir, 'artifacts'); fs.mkdirSync(artifactsRoot);
        put(target, conflict ? 'core/src/example.js' : 'web/src/example.js', conflict ? 'module.exports=3;\n' : 'export default 3;\n');
        f.git(['add', '.'], target); f.git(['commit', '-qm', 'synthetic changed target'], target);
        const commands = [];
        const prepare = () => overlay.prepareOverlay({ owner: f.root, taskRoot: target, artifactsRoot, executeFactory: (_logDir, onBuild) => async (command, args, options) => {
            commands.push({ command, args });
            assert.ok(options.cwd.endsWith('/private/core') || options.cwd.endsWith('/private/web'));
            if (args.includes('--outDir')) { const out = args[args.indexOf('--outDir') + 1]; put(out, 'index.html', '<html>fresh private</html>'); if (onBuild) onBuild(out); }
        } });
        if (conflict) { await assert.rejects(prepare(), /overlay_rebase_conflict/); assert.equal(commands.length, 0); }
        else { const result = await prepare(); assert.equal(result.validationReused, false); assert.equal(commands.filter(call => call.args.includes('--test')).length, 1);
            assert.equal(commands.filter(call => call.args.includes('--outDir')).length, 1); assert.equal(overlay.verifyPackage(result.root).manifest.baselineHead, f.git(['rev-parse', 'HEAD'], target)); }
    }
});
test('public lifecycle contract runs in an isolated public layout with no local HANDOFF or skills', () => {
    const f = fixture(); const publicRoot = path.join(f.dir, 'public-only'); fs.mkdirSync(publicRoot);
    const sourceRoot = path.resolve(__dirname, '..', '..');
    put(publicRoot, 'core/test/session-lifecycle.test.js', fs.readFileSync(path.join(__dirname, 'session-lifecycle.test.js')));
    fs.symlinkSync(path.join(sourceRoot, 'core/src'), path.join(publicRoot, 'core/src'), 'dir');
    fs.symlinkSync(path.join(sourceRoot, 'core/node_modules'), path.join(publicRoot, 'core/node_modules'), 'dir');
    fs.mkdirSync(path.join(publicRoot, 'web')); fs.symlinkSync(path.join(sourceRoot, 'web/src'), path.join(publicRoot, 'web/src'), 'dir');
    assert.equal(fs.existsSync(path.join(publicRoot, 'docs/HANDOFF.md')), false);
    const result = cp.spawnSync(process.execPath, ['--test', '--test-name-pattern=自动进化.*父进程', path.join(publicRoot, 'core/test/session-lifecycle.test.js')], {
        cwd: publicRoot, env: { ...process.env, NODE_TEST_CONTEXT: undefined, NODE_OPTIONS: '', FARM_DATA_DIR: path.join(f.dir, 'public-test-data'), FARM_PRIVATE_CONFIG_FILE: path.join(f.dir, 'no-private-config.json') }, encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /# pass 1\b/);
});

test('the real update worker applies a published release without any acceptance cache or regression runner', async () => {
    const f = fixture();
    fs.appendFileSync(path.join(f.root, '.gitignore'), '\n/core/data/\n');
    f.git(['add', '.']); f.git(['commit', '-qm', 'synthetic data boundary']);
    f.git(['remote', 'add', 'origin', 'https://github.com/Xb-Fishing/qq-farm-evolution.git']);
    const baseline = f.git(['rev-parse', 'HEAD']); const runId = 'cache-worker';
    const taskRoot = path.join(f.root, 'tmp/evolution-workspaces', runId, 'task');
    fs.mkdirSync(path.dirname(taskRoot), { recursive: true }); f.git(['worktree', 'add', '-q', '--detach', taskRoot, baseline]);
    updater.linkDependencies(f.root, taskRoot);
    put(taskRoot, 'core/src/example.js', 'module.exports=7;\n');
    f.git(['add', '.'], taskRoot); f.git(['commit', '-qm', 'synthetic target'], taskRoot);
    const commit = f.git(['rev-parse', 'HEAD'], taskRoot);
    const acceptedRuntime = path.join(f.dir, 'accepted-runtime');
    f.git(['worktree', 'add', '-q', '--detach', acceptedRuntime, commit]); updater.linkDependencies(f.root, acceptedRuntime);
    const publish = require('../src/services/evolution-publish');
    const inspector = require('../src/services/evolution-worktree');
    const provenance = { runId, taskRoot, publicBase: commit, headAtCreation: commit,
        repoRootReal: f.root, commonDir: publish.realCommonDir(f.root), createdAt: Date.now() };

    const artifactsRoot = path.join(f.dir, 'artifacts'); fs.mkdirSync(artifactsRoot);
    const starttime = updater.starttime(process.pid);
    json(f.data, 'program-update.json', { phase: 'queued', runId, root: f.root, currentCommit: baseline,
        targetCommit: commit, botPid: process.pid, botStarttime: starttime, artifactsRoot, tmuxTarget: '%synthetic' });
    json(f.data, 'program-update-lock/owner.json', { runId });
    const inspected = inspector.inspectWorktree(f.root);
    const hold = { version: 1, repoRootReal: f.root, commonDir: provenance.commonDir,
        publicBase: { head: baseline, remoteMain: commit }, worktree: { ...inspected } };
    const original = { create: publish.createTaskWorkspace, build: publish.buildHoldManifest,
        overlay: overlay.prepareOverlay, spawn: cp.spawn };
    const commands = [];
    const retainedFingerprint = validation.logicSnapshot(f.root).fingerprint;
    try {
        publish.buildHoldManifest = owner => { assert.equal(owner, f.root); return hold; };
        publish.createTaskWorkspace = ({ repoRoot, dataDir, runId: requested }) => {
            assert.equal(repoRoot, f.root); assert.equal(requested, runId);
            publish.recordProvenance(dataDir, provenance); return provenance;
        };
        overlay.prepareOverlay = async ({ owner, taskRoot: target }) => {
            assert.equal(owner, f.root); assert.equal(target, taskRoot); return null;
        };
        cp.spawn = (command, args) => {
            commands.push({ command, args }); assert.equal(command, process.execPath);
            assert.ok(args[0].endsWith('/core/scripts/evolution-apply-process.js'), 'only the application helper may execute');
            const child = new (require('node:events').EventEmitter)(); child.pid = process.pid;
            process.nextTick(() => {
                child.emit('spawn');
                json(f.data, 'evolution-apply-receipt.json', { phase: 'ready', expectedHead: commit,
                    oldPid: process.pid, oldStarttime: starttime, programUpdateId: runId,
                    sessionPreservation: { outcomes: [{ state: 'preserved' }] } });
                child.emit('exit', 0);
            });
            return child;
        };
        await updater.runWorker(f.data, runId);
    } finally {
        publish.createTaskWorkspace = original.create; publish.buildHoldManifest = original.build;
        overlay.prepareOverlay = original.overlay; cp.spawn = original.spawn;
    }
    const state = JSON.parse(fs.readFileSync(path.join(f.data, 'program-update.json')));
    assert.equal(state.phase, 'applied'); assert.equal(state.dependenciesReused, true);
    assert.equal(state.installOnly, true);
    const release = JSON.parse(fs.readFileSync(path.join(f.data, 'program-update-release.json')));
    assert.equal(release.state, 'published'); assert.deepEqual(release.checks, []);
    assert.equal(fs.existsSync(path.join(f.data, 'evolution-validation.json')), false);
    assert.equal(state.connectionPreserved, true); assert.equal(commands.length, 1);
    assert.equal(fs.existsSync(path.join(artifactsRoot, 'dependencies')), false);
    assert.equal(fs.existsSync(path.join(artifactsRoot, 'proof/1-validation.log')), false);
    assert.equal(fs.existsSync(path.join(f.data, 'program-update-lock')), false);
    assert.equal(validation.logicSnapshot(f.root).fingerprint, retainedFingerprint);
});

test('a generated bundle directory link stays excluded in an ordinary public checkout', () => {
    const f = fixture();
    put(f.root, '.gitignore', fs.readFileSync(path.resolve(__dirname, '../../.gitignore')));
    f.git(['add', '.gitignore']); f.git(['commit', '-qm', 'synthetic output ignore boundary']);
    const bundle = path.join(f.dir, 'verified-dist'); put(bundle, 'index.html', '<html>verified output</html>');
    fs.symlinkSync(bundle, path.join(f.root, 'web/dist'), 'dir');
    assert.equal(f.git(['status', '--porcelain', '--untracked-files=all']).includes('web/dist'), false);
    assert.equal(f.git(['ls-files', '--', 'web/dist']), '');
    assert.doesNotThrow(() => f.git(['check-ignore', '--quiet', 'web/dist']));
});

test('release installation has no validation fallback and consumes an already prepared local bundle directly', async () => {
    const f = fixture(); privateFixture(f);
    const target = f.worktree('candidate/task'); const artifactsRoot = path.join(f.dir, 'artifacts'); fs.mkdirSync(artifactsRoot);
    let commands = 0;
    const record = await overlay.prepareOverlay({ owner: f.root, taskRoot: target, artifactsRoot, installOnly: true,
        runId: 'release-install', executeFactory: () => async () => { commands++; } });
    assert.equal(commands, 0);
    const built = overlay.verifyPackage(record.root);
    const receipt = JSON.parse(fs.readFileSync(path.join(record.root, 'acceptance.json')));
    assert.equal(receipt.kind, 'published-release'); assert.equal(receipt.state, 'published'); assert.deepEqual(receipt.checks, []);
    assert.equal(fs.existsSync(path.join(artifactsRoot, 'private-validation/evolution-validation.json')), false);
    json(f.data, 'program-update-private-build.json', { commit: f.commit, previousRoot: record.previousRoot,
        previousDigest: record.previousDigest, root: record.root, digest: built.digest });
    const ready = await overlay.prepareOverlay({ owner: f.root, taskRoot: target, dataDir: f.data,
        artifactsRoot: path.join(f.dir, 'another-attempt'), installOnly: true, runId: 'release-again',
        executeFactory: () => async () => { throw new Error('must not execute validation or build'); } });
    assert.equal(ready.prepared, true); assert.equal(ready.root, record.root);
});
