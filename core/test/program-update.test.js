'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const temp = fs.realpathSync(os.tmpdir());
const prefix = path.resolve(temp, 'program-update-'); assert.equal(path.dirname(prefix), temp);
const root = fs.mkdtempSync(prefix); process.env.FARM_DATA_DIR = root;
const updater = require('../src/services/program-update');
const overlay = require('../src/services/program-update-overlay');
const recovery = require('../src/services/program-update-recovery');
after(() => fs.rmSync(root, { recursive: true, force: true }));
let sequence = 0;
function fixture() {
    const dir = path.resolve(root, `case-${++sequence}`); assert.equal(path.dirname(dir), root);
    fs.mkdirSync(dir); return dir;
}
function put(dir, file, data) { const target = path.resolve(dir, file); assert.ok(target.startsWith(dir + path.sep)); updater.put(target, data); return target; }
test('update source accepts only the fixed owner repository; arbitrary branches, shell URLs and other repositories fail', () => {
    const dir = fixture(); cp.execFileSync('git', ['init', '-q', dir]);
    cp.execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:Xb-Fishing/qq-farm-evolution.git'], { cwd: dir });
    assert.doesNotThrow(() => updater.assertTrustedOrigin(dir));
    for (const url of ['https://github.com/other/repository.git', 'ext::danger', '/tmp/arbitrary', 'https://github.com/Xb-Fishing/qq-farm-evolution.git#other']) {
        cp.execFileSync('git', ['remote', 'set-url', 'origin', url], { cwd: dir }); assert.throws(() => updater.assertTrustedOrigin(dir), /untrusted/);
    }
});
test('version operations require an administrator; no request URL or shell body is forwarded', async () => {
    const routes = [];
    const app = { get: (url, ...handlers) => routes.push({ url, handlers }), post: (url, ...handlers) => routes.push({ url, handlers }) };
    const auth = () => {}; const superRole = () => {};
    require('../src/controllers/admin-super-admin-routes').registerAdminSuperAdminRoutes({ app, requireAdminToken: auth, requireSuperAdminRole: superRole });
    const updates = routes.filter(r => r.url.includes('program-update'));
    assert.equal(updates.length, 6);
    for (const route of updates) {
        assert.equal(route.handlers[0], auth);
        for (const role of ['admin', 'super_admin']) { let passed = false; route.handlers[1]({ currentUser: { role } }, {}, () => { passed = true; }); assert.equal(passed, true); }
    }
    const original = updater.begin; let args;
    updater.begin = (...provided) => { args = provided; return { phase: 'queued' }; };
    try {
        let result;
        updates.find(r => r.url.endsWith('/install')).handlers[2]({ body: { url: 'untrusted', command: 'danger', path: '/elsewhere' } }, { json: value => { result = value; } });
        assert.deepEqual(args, []); assert.equal(result.ok, true);
    } finally { updater.begin = original; }
});

test('interrupted work is recovered only by exact same-host dead process identity, never by elapsed time', () => {
    const dir = fixture();
    put(dir, 'program-update.json', { phase: 'validating', currentCommit: 'a'.repeat(40), targetCommit: 'b'.repeat(40), runId: 'one', workerPid: process.pid, workerStarttime: updater.starttime(process.pid), workerHost: os.hostname() });
    put(dir, 'program-update-lock/owner.json', { runId: 'one' });
    assert.equal(updater.safeState(dir).phase, 'validating'); assert.equal(updater.lockHeld(dir), true);
    const state = updater.read(path.join(dir, 'program-update.json'));
    put(dir, 'program-update.json', { ...state, workerStarttime: 'not-the-current-process' });
    assert.equal(updater.safeState(dir).phase, 'interrupted'); assert.equal(updater.lockHeld(dir), false);
});
test('candidate proof binds every shared record, run, commit and old process before applying', () => {
    const dir = fixture(); const proof = path.join(dir, 'proof');
    const state = { runId: 'one', phase: 'applying', proofDir: proof, targetCommit: 'b'.repeat(40), botPid: 321, botStarttime: '123' };
    put(dir, 'program-update.json', state); put(dir, 'program-update-lock/owner.json', { runId: 'one' });
    for (const name of ['evolution-workspace.json', 'evolution-holds.json', 'evolution-validation.json', 'evolution-apply-target.json']) {
        put(dir, name, { actual: name }); put(proof, name, { actual: name });
    }
    const args = { dataDir: dir, runId: 'one', proofDir: proof, expectedHead: state.targetCommit, botPid: 321, botStarttime: '123' };
    assert.doesNotThrow(() => updater.assertCandidate(args));
    assert.throws(() => updater.assertCandidate({ ...args, botStarttime: '124' }), /certificate/);
    put(dir, 'evolution-validation.json', { different: true });
    assert.throws(() => updater.assertCandidate(args), /proof_drift/);
});
test('private overlay baseline is pinned separately for candidate and rollback; absent preload fails closed', () => {
    const record = { link: '/owner/tmp/local-bark-reminder', previousRoot: '/private/old', root: '/private/new' };
    const old = { NODE_OPTIONS: '--require /owner/tmp/local-bark-reminder/preload.cjs --trace-warnings', OTHER: 'original value' };
    const candidate = overlay.pinEnvironment(old, record, true); const rollback = overlay.pinEnvironment(old, record, false);
    assert.match(candidate.NODE_OPTIONS, /\/private\/new\/preload.cjs/); assert.match(rollback.NODE_OPTIONS, /\/private\/old\/preload.cjs/);
    assert.equal(candidate.OTHER, old.OTHER); assert.equal(old.NODE_OPTIONS.includes('/private/new'), false);
    assert.throws(() => overlay.pinEnvironment({ NODE_OPTIONS: '' }, record, true), /not_active/);
});
test('recovery checks source and process ownership before stopping anything, and requires old business plus physical connection proof', async () => {
    for (const scenario of ['success', 'exited_process', 'missing_before_start_sample', 'found_live_target', 'found_foreign_target', 'source_drift', 'foreign_process', 'reconnected', 'unhealthy']) {
        const dir = fixture(); const backup = put(dir, 'previous.json', Object.fromEntries(['evolution-workspace.json', 'evolution-holds.json', 'evolution-validation.json', 'evolution-apply-target.json'].map(n => [n, null])));
        let stopped = 0; let restarted = 0;
        const api = { panePidOf: () => 1, processStarttime: pid => scenario === 'missing_before_start_sample' && pid === 12 ? '' : 'start', logicSnapshot: () => ({ fingerprint: scenario === 'source_drift' ? 'drift' : 'old' }),
            collectProcesses: () => new Map(), isDescendantOf: () => !['foreign_process', 'found_foreign_target'].includes(scenario), aliveNonZombie: pid => scenario !== 'exited_process' || pid !== 12,
            stopBotTree: async (_pid, _start, _table, sessions) => { assert.deepEqual(sessions, [{ pid: 33 }]); stopped++; },
            waitFor: async predicate => predicate(), portFree: () => true, paneAcceptingCommands: () => true,
            sendRestart: () => { restarted++; }, findRestartedBot: () => 22, holdsSocket: () => true, listeningInodes: () => new Set(),
            healthOk: async () => scenario !== 'unhealthy', verifySessions: async args => { assert.equal(args.expectedBusinessCommit, 'oldCommit'); return { ok: true, outcomes: [{ state: 'preserved' }] }; },
            verifyPhysical: async () => scenario !== 'reconnected', targetArgv: ['node', 'new.js'] };
        const args = { context: { argv: ['node', 'old.js'], adminPort: 1 }, contextFile: path.join(dir, 'context.json'), updateState: { sharedProofBackup: backup },
            dataDir: dir, panePid: 1, paneStart: 'start', tmuxTarget: '%1', botPid: 11, newPid: scenario.startsWith('found_') ? 0 : 12, newStart: scenario === 'missing_before_start_sample' || scenario.startsWith('found_') ? '' : 'start', sessions: [{ pid: 33 }], physicalProof: [], oldFingerprint: 'old', oldRoot: dir, oldCommit: 'oldCommit', api };
        if (['success', 'exited_process', 'missing_before_start_sample', 'found_live_target'].includes(scenario)) { const result = await recovery.recover(args); assert.equal(result.newPid, 22); assert.equal(stopped, ['success', 'found_live_target'].includes(scenario) ? 1 : 0); assert.equal(restarted, 1); }
        else { await assert.rejects(recovery.recover(args)); if (['source_drift', 'foreign_process', 'found_foreign_target'].includes(scenario)) assert.equal(stopped, 0); }
    }
});

test('an unchanged installed overlay cannot authorize mutated private or public merge sources', () => {
    const dir = fixture(); const publicRoot = path.join(dir, 'public'); const privateRoot = path.join(dir, 'private');
    fs.mkdirSync(publicRoot); fs.mkdirSync(privateRoot);
    const git = (where, args) => cp.execFileSync('git', args, { cwd: where, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    for (const where of [publicRoot, privateRoot]) {
        git(where, ['init', '-q']); fs.mkdirSync(path.join(where, 'core/src'), { recursive: true });
        const file = path.resolve(where, 'core/src/example.js'); assert.ok(file.startsWith(where + path.sep)); fs.writeFileSync(file, 'module.exports=1;');
        git(where, ['add', '.']); git(where, ['-c', 'user.name=fixture', '-c', 'user.email=fixture@invalid', 'commit', '-qm', 'base']);
    }
    const state = { privateSourceRoot: privateRoot, publicBaseSourceRoot: publicRoot, baselineHead: git(publicRoot, ['rev-parse', 'HEAD']), sourceFingerprint: require('../src/services/evolution-validation').logicSnapshot(privateRoot).fingerprint };
    assert.doesNotThrow(() => overlay.verifySourceSnapshots(state));
    const privateFile = path.join(privateRoot, 'core/src/example.js'); fs.writeFileSync(privateFile, 'module.exports=2;');
    assert.throws(() => overlay.verifySourceSnapshots(state), /private_source_drift/);
    fs.writeFileSync(privateFile, 'module.exports=1;');
    fs.writeFileSync(path.join(publicRoot, 'core/src/example.js'), 'module.exports=3;');
    assert.throws(() => overlay.verifySourceSnapshots(state), /public_source_drift/);
});

test('a worker that exits before its first stage releases only its own queued lock', async () => {
    const dir = fixture(); const repo = path.join(dir, 'repo'); fs.mkdirSync(repo);
    cp.execFileSync('git', ['init', '-q', repo]); cp.execFileSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@invalid', 'commit', '--allow-empty', '-qm', 'fixture'], { cwd: repo }); cp.execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:Xb-Fishing/qq-farm-evolution.git'], { cwd: repo });
    const data = path.join(dir, 'data'); fs.mkdirSync(data);
    put(data, 'private-config.json', { evolutionKnowledgeDir: path.join(dir, 'artifacts') });
    put(data, 'program-update.json', { phase: 'available', currentCommit: cp.execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(), targetCommit: 'b'.repeat(40), latestVersion: '1.1.0' });
    const { EventEmitter } = require('node:events'); const child = new EventEmitter(); child.unref = () => {};
    updater.begin({ root: repo, dataDir: data, resolvePane: () => '%fixture', spawn: () => child });
    assert.equal(updater.lockHeld(data), true);
    child.emit('exit', 1);
    assert.equal(updater.safeState(data).phase, 'failed'); assert.equal(updater.lockHeld(data), false);
});
test('offline validation does not inherit live account, private config or preload environment', () => {
  const env = updater.offlineEnv({ PATH: '/synthetic/bin', FARM_PRIVATE_CONFIG_FILE: '/private/live.json', FARM_SESSION_BUSINESS: '1', QQ_PASSWORD: 'secret', BARK_URL: 'private', NODE_OPTIONS: '--require /live/preload.cjs' });
  assert.deepEqual(env, { PATH: '/synthetic/bin', NODE_OPTIONS: '' });
});
test('a live proven helper keeps the update mutex even after its preparation worker exits', () => {
    const dir = fixture();
    put(dir, 'program-update.json', { phase: 'applying', currentCommit: 'a'.repeat(40), targetCommit: 'b'.repeat(40), runId: 'one',
        workerPid: process.pid, workerStarttime: 'exited-worker', workerHost: os.hostname(), helperPid: process.pid, helperStarttime: updater.starttime(process.pid) });
    put(dir, 'program-update-lock/owner.json', { runId: 'one' });
    assert.equal(updater.safeState(dir).phase, 'applying'); assert.equal(updater.lockHeld(dir), true);
});

test('an absent helper with an empty start time never proves liveness', () => {
    const dir = fixture();
    put(dir, 'program-update.json', { phase: 'applying', currentCommit: 'a'.repeat(40), targetCommit: 'b'.repeat(40), runId: 'empty-start',
        workerPid: process.pid, workerStarttime: 'exited-worker', workerHost: os.hostname(), helperPid: 2147483647, helperStarttime: '' });
    put(dir, 'program-update-lock/owner.json', { runId: 'empty-start' });
    assert.equal(updater.safeState(dir).phase, 'interrupted'); assert.equal(updater.lockHeld(dir), false);
});
test('rollback revalidates the old package even when its link was never switched, and restores only its own new link', () => {
    const dir = fixture(); const old = path.join(dir, 'old'); const next = path.join(dir, 'new');
    const hash = bytes => require('node:crypto').createHash('sha256').update(bytes).digest('hex');
    for (const target of [old, next]) {
        assert.equal(path.dirname(target), dir); fs.mkdirSync(target);
        const acceptance = JSON.stringify({ state: 'passed', fingerprint: 'a'.repeat(64), checks: ['backend', 'frontend'] });
        for (const [name, bytes] of [['acceptance.json', acceptance], ['preload.cjs', 'module.exports={};']]) {
            const file = path.resolve(target, name); assert.equal(path.dirname(file), target); fs.writeFileSync(file, bytes);
        }
        put(target, 'manifest.json', { version: 1, localOnly: true, sourceFingerprint: 'a'.repeat(64), modules: [], assets: [],
            acceptanceSha256: hash(acceptance), privatePreloadSha256: hash('module.exports={};') });
    }
    const link = path.resolve(dir, 'registered'); assert.equal(path.dirname(link), dir); fs.symlinkSync(old, link, 'dir');
    const record = { link, previousRoot: old, root: next, previousDigest: overlay.verifyPackage(old).digest, digest: overlay.verifyPackage(next).digest };
    assert.doesNotThrow(() => overlay.restoreOverlay(record));
    fs.unlinkSync(link); fs.symlinkSync(next, link, 'dir'); overlay.restoreOverlay(record); assert.equal(fs.realpathSync(link), old);
    fs.appendFileSync(path.join(old, 'manifest.json'), ' ');
    assert.throws(() => overlay.restoreOverlay(record), /rollback_unproven/);
});

test('version checks report no update and never overwrite an update that began during the remote lookup', async () => {
    const dir = fixture();
    cp.execFileSync('git', ['init', '-q', dir]);
    const file = path.resolve(dir, 'package.json'); assert.equal(path.dirname(file), dir); fs.writeFileSync(file, '{}');
    cp.execFileSync('git', ['add', '.'], { cwd: dir });
    cp.execFileSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@invalid', 'commit', '-qm', 'base'], { cwd: dir });
    cp.execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:Xb-Fishing/qq-farm-evolution.git'], { cwd: dir });
    const head = cp.execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
    const dataDir = path.join(dir, 'data');
    put(dataDir, 'program-update.json', { phase: 'idle', currentCommit: head });
    assert.equal((await updater.check({ root: dir, dataDir, readRemoteHead: async () => head, readTargetVersion: async () => '1.0.0' })).phase, 'current');
    let finish;
    const pending = updater.check({ root: dir, dataDir, readRemoteHead: () => new Promise(resolve => { finish = resolve; }), readTargetVersion: async () => '1.0.0' });
    put(dataDir, 'program-update.json', { phase: 'validating', currentCommit: head, targetCommit: 'c'.repeat(40), runId: 'another' });
    finish('b'.repeat(40));
    assert.equal((await pending).phase, 'validating');
    assert.equal(updater.read(path.join(dataDir, 'program-update.json')).targetCommit, 'c'.repeat(40));
});

test('status projects the actual running revision and invalidates stale latest-version checks without rewriting transaction history', () => {
    const dir = fixture();
    cp.execFileSync('git', ['init', '-q', dir]);
    cp.execFileSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@invalid', 'commit', '--allow-empty', '-qm', 'current deployed source'], { cwd: dir });
    const head = cp.execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
    const dataDir = path.join(dir, 'data');
    put(dataDir, 'program-update.json', { phase: 'current', currentCommit: 'a'.repeat(40), targetCommit: 'a'.repeat(40), updatedAt: 12 });
    const status = updater.safeState(dataDir, dir);
    assert.equal(status.currentCommit, head); assert.equal(status.targetCommit, ''); assert.equal(status.phase, 'idle');
    assert.equal(updater.read(path.join(dataDir, 'program-update.json')).currentCommit, 'a'.repeat(40));
});

test('administrators can check and install; ordinary users are denied and local investigation routes are absent', async t => {
    const http = require('node:http');
    const app = require('express')();
    const roles = require('../src/controllers/admin-route-helpers').createAdminRouteHelpers({});
    const auth = (req, res, next) => {
        const role = req.headers['x-fixture-role'];
        if (!role) return res.status(401).json({ ok: false });
        req.currentUser = { role }; next();
    };
    const originals = { safeState: updater.safeState, check: updater.check, begin: updater.begin };
    const actions = [];
    updater.safeState = () => ({ phase: 'current', currentCommit: 'b'.repeat(40) });
    updater.check = async () => { actions.push('check'); return { phase: 'current' }; };
    updater.begin = () => { actions.push('install'); return { phase: 'queued' }; };
    t.after(() => Object.assign(updater, originals));
    require('../src/controllers/admin-super-admin-routes').registerAdminSuperAdminRoutes({ app, requireAdminToken: auth, requireSuperAdminRole: roles.requireSuperAdminRole });
    app.use((_req, res) => res.status(404).json({ ok: false }));
    const server = http.createServer(app); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => { server.closeIdleConnections(); server.close(resolve); }));
    const port = server.address().port;
    const request = (pathname, role, method = 'GET') => new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, path: pathname, method, headers: role ? { 'x-fixture-role': role } : {} }, res => {
            let raw = ''; res.on('data', chunk => { raw += chunk; }); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(raw) }));
        }); req.on('error', reject); req.end();
    });
    assert.equal((await request('/api/admin/program-update')).status, 401);
    assert.equal((await request('/api/admin/program-update', 'user')).status, 403);
    assert.equal((await request('/api/admin/investigations', 'user')).status, 404);
    for (const role of ['admin', 'super_admin']) {
        const response = await request('/api/admin/program-update', role);
        assert.equal(response.status, 200); assert.equal(response.body.access.canUpdate, true);
        assert.equal(response.body.update.currentVersion, require('../package.json').version);
        assert.equal('currentCommit' in response.body.update, false); assert.equal('targetCommit' in response.body.update, false);
        assert.equal((await request('/api/admin/investigations', role)).status, 404);
    }
    assert.deepEqual(actions, [], 'metadata reads never dispatch check/install');
    for (const action of ['check', 'install']) {
        assert.equal((await request(`/api/admin/program-update/${action}`, 'user', 'POST')).status, 403);
        assert.equal((await request(`/api/admin/program-update/${action}`, 'admin', 'POST')).status, 200);
        assert.equal((await request(`/api/super-admin/program-update/${  action}`, 'super_admin', 'POST')).status, 200);
    }
    assert.deepEqual(actions, ['check', 'check', 'install', 'install']);
});


test('late checks cannot replace a newer check or a completed update transaction', async () => {
    const dir = fixture(); cp.execFileSync('git', ['init', '-q', dir]);
    cp.execFileSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@invalid', 'commit', '--allow-empty', '-qm', 'base'], { cwd: dir });
    cp.execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:Xb-Fishing/qq-farm-evolution.git'], { cwd: dir });
    const head = cp.execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
    const dataDir = path.join(dir, 'data');
    for (const completed of [false, true]) {
        put(dataDir, 'program-update.json', { phase: 'idle', currentCommit: head });
        let release; let started;
        const entered = new Promise(resolve => { started = resolve; });
        const pending = updater.check({ root: dir, dataDir, readRemoteHead: async () => 'b'.repeat(40),
            readTargetVersion: () => { started(); return new Promise(resolve => { release = resolve; }); } });
        await entered;
        if (completed) put(dataDir, 'program-update.json', { phase: 'applied', runId: 'actual-update', currentCommit: head, targetCommit: head, latestVersion: '2.0.0' });
        else await updater.check({ root: dir, dataDir, readRemoteHead: async () => 'c'.repeat(40), readTargetVersion: async () => '3.0.0' });
        const expected = fs.readFileSync(path.join(dataDir, 'program-update.json'), 'utf8');
        release('1.0.0'); await pending;
        assert.equal(fs.readFileSync(path.join(dataDir, 'program-update.json'), 'utf8'), expected);
    }
});
