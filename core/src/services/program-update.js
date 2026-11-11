'use strict';
// Version updates have their own lifecycle and proof directory. They never grant
// approval to a daily evolution batch or clear its feedback.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const { getDataDir } = require('../config/runtime-paths');
const pub = require('./evolution-publish');
const validation = require('./evolution-validation');
const { resolveKnowledgeDir } = require('./evolution-knowledge');
const versions = require('./program-version');
const ROOT = path.resolve(__dirname, '../../..');
const STATE = 'program-update.json';
const LOCK = 'program-update-lock';
const checks = new Map();
const ACTIVE = new Set(['queued', 'fetching', 'dependencies', 'validating', 'overlay', 'preparing', 'applying']);
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
function put(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)  }\n`, { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, file);
}
function starttime(pid) {
    try { const s = fs.readFileSync(`/proc/${pid}/stat`, 'utf8'); return s.slice(s.lastIndexOf(')') + 2).split(/\s+/)[19]; }
    catch { return ''; }
}
function identityLive(pid, expected) {
    if (!Number.isSafeInteger(pid) || pid < 1 || !/^\d+$/.test(String(expected || ''))) return false;
    try {
        const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
        const fields = stat.slice(stat.lastIndexOf(')') + 2).split(/\s+/);
        return fields[19] === expected && !['Z', 'X'].includes(fields[0]);
    } catch { return false; }
}
function lockHeld(dataDir) { return fs.existsSync(path.join(dataDir, LOCK)); }
function acquire(dataDir, runId) {
    const lock = path.join(dataDir, LOCK);
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    try { fs.mkdirSync(lock, { mode: 0o700 }); } catch { throw new Error('update_busy'); }
    put(path.join(lock, 'owner.json'), { runId, pid: process.pid, starttime: starttime(process.pid), host: os.hostname() });
}
function release(dataDir, runId) {
    const lock = path.join(dataDir, LOCK);
    if (read(path.join(lock, 'owner.json')).runId !== runId) throw new Error('update_lock_changed');
    fs.unlinkSync(path.join(lock, 'owner.json')); fs.rmdirSync(lock);
}
function assertTrustedOrigin(root) {
    const origin = cp.execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    if (!['git@github.com:Xb-Fishing/qq-farm-evolution.git', 'https://github.com/Xb-Fishing/qq-farm-evolution.git',
        'https://github.com/Xb-Fishing/qq-farm-evolution'].includes(origin)) throw new Error('untrusted_update_source');
}
function busyEvolution(dataDir) {
    try { const s = read(path.join(dataDir, 'activity-evolve-state.json'));
        return !!s.activeRun || ['running', 'revising', 'pending_apply', 'applying', 'push_failed', 'review_blocked', 'privacy_blocked_local'].includes(s.status);
    } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
function paneFor(pid) {
    const lines = cp.execFileSync('tmux', ['list-panes', '-a', '-F', '#{pane_id} #{pane_pid}'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    for (const line of lines.trim().split('\n')) {
        const [pane, ancestor] = line.split(/\s+/); let at = pid;
        for (let n = 0; at > 1 && n < 64; n++) {
            if (at === Number(ancestor)) return pane;
            const s = fs.readFileSync(`/proc/${at}/stat`, 'utf8'); at = Number(s.slice(s.lastIndexOf(')') + 2).split(/\s+/)[1]);
        }
    }
    throw new Error('update_requires_existing_tmux');
}
function safeState(dataDir = getDataDir(), root = ROOT) {
    let s;
    try { s = read(path.join(dataDir, STATE)); } catch (e) { if (e.code !== 'ENOENT') throw e; s = { phase: 'idle' }; }
    const helperAlive = s.workerHost === os.hostname() && identityLive(s.helperPid, s.helperStarttime);
    if (ACTIVE.has(s.phase) && s.workerPid && s.workerHost === os.hostname() && !identityLive(s.workerPid, s.workerStarttime) && !helperAlive) {
        // Recover only this exact completed transaction in its actual new manager.
        try {
            const receipt = read(path.join(dataDir, 'evolution-apply-receipt.json'));
            const approved = read(path.join(dataDir, 'evolution-approved-runtime.json'));
            if (s.phase === 'applying' && receipt.phase === 'ready' && receipt.programUpdateId === s.runId
                && receipt.expectedHead === s.targetCommit && receipt.oldPid === s.botPid && receipt.oldStarttime === s.botStarttime
                && receipt.newPid === process.pid && receipt.newStarttime === starttime(process.pid)
                && approved.target?.runId === s.runId && approved.target?.commit === s.targetCommit
                && approved.target?.runtimeRoot === ROOT && currentCommit() === s.targetCommit
                && approved.process?.newPid === process.pid && approved.process?.newStarttime === receipt.newStarttime && approved.validation?.state === 'passed'
                && approved.validation?.fingerprint === approved.target?.sourceFingerprint
                && pub.verifyRunningRuntime({ record: approved.target, repoRoot: ROOT, cwd: path.join(ROOT, 'core'), entry: path.join(ROOT, 'core/client.js'), dataDir }).ok
                && receipt.sessionPreservation?.verified === true
                && receipt.sessionPreservation.outcomes?.every(item => item.state === 'preserved')) {
                s = { ...s, phase: 'applied', currentCommit: s.targetCommit, connectionPreserved: true, reason: '更新完成，已核对本轮正式回执', updatedAt: Date.now() };
                put(path.join(dataDir, STATE), s);
                if (lockHeld(dataDir) && read(path.join(dataDir, LOCK, 'owner.json')).runId === s.runId) release(dataDir, s.runId);
                return safeState(dataDir, root);
            }
        } catch { /* An absent/mismatched receipt cannot prove success. */ }
        // Never trust a previous ready receipt or restart an interrupted update.
        s = { ...s, phase: 'interrupted', reason: '更新进程已退出；旧版本及日志保留，可重新检查更新', updatedAt: Date.now() };
        put(path.join(dataDir, STATE), s);
        if (lockHeld(dataDir) && read(path.join(dataDir, LOCK, 'owner.json')).runId === s.runId) release(dataDir, s.runId);
    }
    let running;
    try { running = currentCommit(root); }
    catch { return { phase: 'unavailable', currentCommit: '', targetCommit: '', source: 'origin/main', reason: '当前部署没有可读取的 Git 版本，请按现有部署方式更新。' }; }
    // Historical checks/transactions keep their original baseline on disk. The
    // status shown to a user always describes this actual running source root.
    const staleCheck = ['idle', 'current', 'available', 'applied'].includes(s.phase) && s.currentCommit && s.currentCommit !== running;
    return { phase: staleCheck ? 'idle' : s.phase, runId: s.runId || '', currentCommit: running, targetCommit: staleCheck ? '' : s.targetCommit || '',
        updatedAt: staleCheck ? 0 : s.updatedAt || 0, latestVersion: staleCheck ? null : s.latestVersion || null, reason: staleCheck ? '程序版本已变化，请重新检查上游新版本。' : s.reason || '', connectionPreserved: s.connectionPreserved === true, source: 'origin/main' };
}
function currentCommit(root = ROOT) { return cp.execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
function remoteHeadAsync(root) {
    return new Promise((resolve, reject) => cp.execFile('git', ['ls-remote', 'origin', 'refs/heads/main'],
        { cwd: root, timeout: 30000, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (error, stdout) => {
            const commit = String(stdout || '').trim().split(/\s+/)[0];
            if (error || !/^[a-f0-9]{40}$/.test(commit)) reject(new Error('remote_unreadable'));
            else resolve(commit);
        }));
}
async function check({ root = ROOT, dataDir = getDataDir(), readRemoteHead = remoteHeadAsync, readTargetVersion = versions.targetVersion } = {}) {
    assertTrustedOrigin(root);
    const status = safeState(dataDir, root);
    if (ACTIVE.has(status.phase)) return status;
    const key = path.resolve(dataDir);
    const token = Symbol('check'); checks.set(key, token);
    const snapshot = () => { try { return fs.readFileSync(path.join(dataDir, STATE), 'utf8'); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
    const original = snapshot();
    const changed = () => checks.get(key) !== token || snapshot() !== original;
    try {
        const targetCommit = await readRemoteHead(root);
        if (changed()) return safeState(dataDir, root);
        const latestVersion = await readTargetVersion(root, targetCommit);
        versions.parseVersion(JSON.stringify({ version: latestVersion }));
        if (changed()) return safeState(dataDir, root);
        const s = { phase: targetCommit === currentCommit(root) ? 'current' : 'available', currentCommit: currentCommit(root), targetCommit, latestVersion, updatedAt: Date.now() };
        put(path.join(dataDir, STATE), s);
        return safeState(dataDir, root);
    } finally { if (checks.get(key) === token) checks.delete(key); }
}
function publicState({ dataDir = getDataDir(), root = ROOT, state } = {}) {
    const status = state || safeState(dataDir, root);
    const currentVersion = versions.installedVersion(root);
    let latestVersion = null;
    try { latestVersion = versions.parseVersion(JSON.stringify({ version: status.latestVersion })); } catch {}
    const messages = { current: '已是最新版本', applied: '更新完成', failed: '更新未完成，请查看运行日志后重试。',
        interrupted: '更新已中断，请重新检查。', unavailable: '当前部署方式不支持后台更新，请按原部署方式更新。' };
    return { phase: currentVersion ? status.phase : 'unavailable', currentVersion,
        latestVersion,
        updateAvailable: !!currentVersion && !!latestVersion && status.phase === 'available' && !!status.targetCommit && status.targetCommit !== status.currentCommit,
        updatedAt: status.updatedAt || 0, message: currentVersion ? messages[status.phase] || '' : messages.unavailable };
}
function begin({ root = ROOT, dataDir = getDataDir(), spawn = cp.spawn, resolvePane = paneFor } = {}) {
    assertTrustedOrigin(root); safeState(dataDir, root);
    const previous = read(path.join(dataDir, STATE));
    let versionReady = false;
    try { versionReady = !!versions.parseVersion(JSON.stringify({ version: previous.latestVersion })); } catch {}
    if (!versionReady || previous.phase !== 'available' || previous.currentCommit !== currentCommit(root)) throw new Error('check_update_first');
    const runId = `program-${Date.now()}-${crypto.randomUUID()}`;
    acquire(dataDir, runId);
    try {
        if (busyEvolution(dataDir)) throw new Error('evolution_busy');
        const tmuxTarget = resolvePane(process.pid);
        const artifactsRoot = path.join(resolveKnowledgeDir({ dataDir }), 'program-updates', runId);
        fs.mkdirSync(artifactsRoot, { recursive: true, mode: 0o700 });
        const state = { version: 1, ...previous, phase: 'queued', runId, root, dataDir, artifactsRoot, tmuxTarget,
            workerPid: process.pid, workerStarttime: starttime(process.pid), workerHost: os.hostname(),
            botPid: process.pid, botStarttime: starttime(process.pid), adminPort: Number(process.env.ADMIN_PORT) || 3007, updatedAt: Date.now() };
        put(path.join(dataDir, STATE), state);
        const fd = fs.openSync(path.join(artifactsRoot, 'worker.log'), 'a', 0o600);
        let child;
        try { child = spawn(process.execPath, [path.join(root, 'core/scripts/program-update-worker.js'), dataDir, runId], {
            cwd: root, detached: true, stdio: ['ignore', fd, fd], env: { ...process.env, NODE_OPTIONS: '' },
        }); } finally { fs.closeSync(fd); }
        child.once('spawn', () => {
            const current = read(path.join(dataDir, STATE));
            if (current.runId === runId && current.phase === 'queued') put(path.join(dataDir, STATE), { ...current,
                workerPid: child.pid, workerStarttime: starttime(child.pid), workerHost: os.hostname() });
        });
        const failQueued = () => {
            const s = read(path.join(dataDir, STATE));
            if (s.runId === runId && s.phase === 'queued') { put(path.join(dataDir, STATE), { ...s, phase: 'failed', reason: '更新准备进程启动失败' }); release(dataDir, runId); }
        };
        child.once('error', failQueued);
        child.once('exit', failQueued);
        child.unref();
        return safeState(dataDir, root);
    } catch (error) { release(dataDir, runId); throw error; }
}
function offlineEnv(env = process.env) {
    return Object.fromEntries(Object.entries({ ...env, NODE_OPTIONS: '' }).filter(([key]) => !/^(?:FARM_|QQ_|BARK_)/.test(key)));
}
function validationEnv({ owner, taskRoot, artifactsRoot }) {
    const env = { ...offlineEnv(), CAPTURE_PROXY_BIND: '127.0.0.1', FARM_SESSION_LOG_DIR: path.join(artifactsRoot, 'session-host-logs') };
    const registered = path.join(owner, 'tmp/local-bark-reminder');
    if (fs.existsSync(registered)) {
        const root = fs.realpathSync(registered);
        require('./program-update-overlay').verifyPackage(root);
        const preload = path.join(root, 'preload.cjs');
        const profile = require(preload).configureEvolutionFixtures(taskRoot);
        if (!profile.passed) throw new Error('private_fixture_profile_unavailable');
        Object.assign(env, { TMPDIR: profile.root, FARM_LOG_HISTORY_TEST_DIR: profile.root, FARM_PRIVATE_BARK_PRELOAD_TEMPLATE: preload });
    }
    return env;
}
function makeExecutor(logDir, onBuild) {
    let sequence = 0;
    return async (bin, args, options) => {
        if (args.includes('build') && args.includes('--outDir')) {
            const stats = path.join(options.cwd, 'stats.html');
            if (!fs.existsSync(stats)) { try { fs.lstatSync(stats); } catch { fs.symlinkSync(path.join(logDir, 'visualizer-stats.html'), stats); } }
            else if (!fs.lstatSync(stats).isSymbolicLink()) throw new Error('build_stats_destination_occupied');
        }
        const fd = fs.openSync(path.join(logDir, `${++sequence}-validation.log`), 'a', 0o600);
        try { await new Promise((resolve, reject) => {
            const child = cp.spawn(bin, args, { ...options, stdio: ['ignore', fd, fd] });
            child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error('validation_failed')));
        }); } finally { fs.closeSync(fd); }
        if (args.includes('build') && args.includes('--outDir') && onBuild) onBuild(args[args.indexOf('--outDir') + 1]);
    };
}
function linkDependencies(source, target) {
    for (const relative of ['node_modules', 'core/node_modules', 'web/node_modules']) {
        const from = path.join(source, relative); const to = path.join(target, relative);
        if (!fs.existsSync(from)) continue;
        if (fs.existsSync(to) || (() => { try { return fs.lstatSync(to).isSymbolicLink(); } catch { return false; } })()) {
            if (!fs.lstatSync(to).isSymbolicLink()) throw new Error('dependency_destination_not_link'); fs.unlinkSync(to);
        }
        fs.symlinkSync(fs.realpathSync(from), to, 'dir');
    }
}
async function runWorker(dataDir, runId) {
    let state = read(path.join(dataDir, STATE));
    if (state.runId !== runId || state.phase !== 'queued' || read(path.join(dataDir, LOCK, 'owner.json')).runId !== runId) throw new Error('stale_update_worker');
    const set = (phase, fields = {}) => {
        if (read(path.join(dataDir, STATE)).runId !== runId) throw new Error('stale_update_worker');
        state = { ...state, ...fields, phase, updatedAt: Date.now() }; put(path.join(dataDir, STATE), state);
    };
    set('fetching', { workerPid: process.pid, workerStarttime: starttime(process.pid), workerHost: os.hostname() });
    put(path.join(dataDir, LOCK, 'owner.json'), { runId, pid: process.pid, starttime: starttime(process.pid), host: os.hostname() });
    try {
        if (busyEvolution(dataDir)) throw new Error('evolution_busy');
        assertTrustedOrigin(state.root);
        if (currentCommit(state.root) !== state.currentCommit || starttime(state.botPid) !== state.botStarttime) throw new Error('running_version_changed');
        const owner = pub.ownerStorageRoot(dataDir, state.root);
        const proofDir = path.join(state.artifactsRoot, 'proof'); fs.mkdirSync(proofDir, { recursive: true, mode: 0o700 });
        const priorHold = pub.readHoldManifest(dataDir);
        const hold = priorHold && pub.verifyHoldUnchanged(owner, priorHold).ok ? priorHold : pub.buildHoldManifest(owner);
        pub.recordHoldManifest(proofDir, hold);
        const provenance = pub.createTaskWorkspace({ repoRoot: owner, dataDir: proofDir, runId });
        if (provenance.publicBase !== state.targetCommit) throw new Error('upstream_changed_check_again');
        const taskRoot = provenance.taskRoot;
        // Always install the target's frozen graph in an isolated directory. Neither
        // retained root files nor the existing host's dependencies are replaced.
        set('dependencies', { proofDir, taskRoot });
        for (const relative of ['node_modules', 'core/node_modules', 'web/node_modules']) {
            const file = path.join(taskRoot, relative); try { if (fs.lstatSync(file).isSymbolicLink()) fs.unlinkSync(file); } catch (e) { if (e.code !== 'ENOENT') throw e; }
        }
        const depRoot = path.join(state.artifactsRoot, 'dependencies'); fs.mkdirSync(depRoot, { mode: 0o700 });
        for (const file of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'core/package.json', 'web/package.json']) {
            const out = path.join(depRoot, file); fs.mkdirSync(path.dirname(out), { recursive: true }); fs.copyFileSync(path.join(taskRoot, file), out);
        }
        await makeExecutor(state.artifactsRoot)('pnpm', ['install', '--frozen-lockfile', '--ignore-scripts'], { cwd: depRoot, env: offlineEnv() });
        linkDependencies(depRoot, taskRoot);
        const execute = makeExecutor(proofDir);
        set('validating');
        await validation.runEvolutionValidation({ repoRoot: taskRoot, dataDir: proofDir, execute, env: validationEnv({ owner, taskRoot, artifactsRoot: state.artifactsRoot }), force: true });
        set('overlay');
        const overlay = await require('./program-update-overlay').prepareOverlay({ owner, taskRoot, artifactsRoot: state.artifactsRoot, executeFactory: makeExecutor });
        set('preparing');
        const runtime = pub.prepareRuntimeWorkspace({ repoRoot: owner, runId, commit: state.targetCommit, dataDir: proofDir, validatedSourceRoot: taskRoot });
        linkDependencies(depRoot, runtime.runtimeRoot);
        const dataLink = path.join(runtime.runtimeRoot, 'core/data');
        if (!fs.lstatSync(dataLink).isSymbolicLink()) throw new Error('runtime_data_not_link');
        fs.unlinkSync(dataLink); fs.symlinkSync(dataDir, dataLink, 'dir');
        if (!pub.verifyHoldUnchanged(owner, hold).ok) throw new Error('retained_source_changed');
        const target = { runId, commit: state.targetCommit, runtimeRoot: runtime.runtimeRoot, sourceFingerprint: runtime.logicFingerprint, holdDigest: pub.holdDigest(hold), createdAt: Date.now() };
        pub.recordApplyTarget(proofDir, target);
        const sharedProofBackup = path.join(proofDir, 'previous-shared-records.json');
        const names = ['evolution-workspace.json', 'evolution-holds.json', 'evolution-validation.json', 'evolution-apply-target.json'];
        put(sharedProofBackup, Object.fromEntries(names.map(name => [name, fs.existsSync(path.join(dataDir, name)) ? fs.readFileSync(path.join(dataDir, name), 'utf8') : null])));
        set('applying', { target, overlay, sharedProofBackup });
        for (const name of names) put(path.join(dataDir, name), read(path.join(proofDir, name)));
        const script = path.join(state.root, 'core/scripts/evolution-apply-process.js');
        await new Promise((resolve, reject) => {
            const fd = fs.openSync(path.join(state.artifactsRoot, 'apply.log'), 'a', 0o600);
            const helper = cp.spawn(process.execPath, [script, '--bot-pid', String(state.botPid), '--bot-starttime', state.botStarttime,
                '--expected-head', state.targetCommit, '--tmux-target', state.tmuxTarget, '--data-dir', dataDir,
                '--admin-port', String(state.adminPort), '--node-bin-dir', path.dirname(process.execPath), '--target-root', runtime.runtimeRoot,
                '--program-update', runId, '--proof-dir', proofDir], { cwd: state.root, stdio: ['ignore', fd, fd], env: { ...process.env, NODE_OPTIONS: '' } });
            fs.closeSync(fd);
            helper.once('spawn', () => set('applying', { helperPid: helper.pid, helperStarttime: starttime(helper.pid) }));
            helper.once('error', reject); helper.once('exit', code => code === 0 ? resolve() : reject(new Error('apply_failed')));
        });
        const receipt = read(path.join(dataDir, 'evolution-apply-receipt.json'));
        if (receipt.phase !== 'ready' || receipt.expectedHead !== state.targetCommit || receipt.oldPid !== state.botPid
            || receipt.oldStarttime !== state.botStarttime || receipt.programUpdateId !== runId
            || receipt.sessionPreservation?.outcomes?.some(item => item.state !== 'preserved')) throw new Error('apply_receipt_mismatch');
        set('applied', { currentCommit: state.targetCommit, connectionPreserved: true, reason: '更新完成，原游戏连接已核验保留' });
    } catch (error) {
        // Raw child output stays in the private log; the API exposes stable stages.
        let receipt;
        try { receipt = read(path.join(dataDir, 'evolution-apply-receipt.json')); } catch {}
        if (state.sharedProofBackup && (!receipt || receipt.programUpdateId !== runId || receipt.phase === 'rolled_back')) restoreSharedProof(dataDir, state);
        fs.appendFileSync(path.join(state.artifactsRoot, 'worker.log'), `${JSON.stringify({ phase: state.phase, error: String(error.message).slice(0, 300) })  }\n`);
        set('failed', { reason: receipt?.programUpdateId === runId && receipt.phase === 'rolled_back'
            ? '更新未完成，已核验恢复原版本及原游戏连接' : `更新未完成（${state.phase}），当前运行状态和详细记录已保留` });
        throw error;
    } finally { release(dataDir, runId); }
}
function assertCandidate({ dataDir, runId, proofDir, expectedHead, botPid, botStarttime }) {
    const s = read(path.join(dataDir, STATE));
    if (s.runId !== runId || s.phase !== 'applying' || s.proofDir !== proofDir || s.targetCommit !== expectedHead
        || s.botPid !== botPid || s.botStarttime !== botStarttime || read(path.join(dataDir, LOCK, 'owner.json')).runId !== runId) throw new Error('update_certificate_mismatch');
    for (const name of ['evolution-workspace.json', 'evolution-holds.json', 'evolution-validation.json', 'evolution-apply-target.json']) {
        if (sha(JSON.stringify(read(path.join(proofDir, name)))) !== sha(JSON.stringify(read(path.join(dataDir, name))))) throw new Error('update_proof_drift');
    }
    require('./program-update-overlay').verifyOverlay(s.overlay);
    return s;
}
function restoreSharedProof(dataDir, state) {
    const previous = read(state.sharedProofBackup);
    for (const name of ['evolution-workspace.json', 'evolution-holds.json', 'evolution-validation.json', 'evolution-apply-target.json']) {
        if (previous[name] === null) fs.rmSync(path.join(dataDir, name), { force: true });
        else put(path.join(dataDir, name), JSON.parse(previous[name]));
    }
}
module.exports = { publicState, validationEnv, offlineEnv, restoreSharedProof, check, begin, safeState, runWorker, lockHeld, assertTrustedOrigin, assertCandidate, starttime, put, read, makeExecutor, linkDependencies };
