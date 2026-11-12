'use strict';
// Rebuild the owner's explicitly registered private differences. A conflict or
// unprovable asset fails before stopping the current manager.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const { logicSnapshot, runEvolutionValidation } = require('./evolution-validation');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function read(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function within(root, relative) {
    if (typeof relative !== 'string' || !relative || path.isAbsolute(relative) || relative.split(/[\\/]/).some(p => !p || p === '.' || p === '..')) throw new Error('overlay_path_invalid');
    const target = path.resolve(root, relative);
    if (!target.startsWith(path.resolve(root) + path.sep)) throw new Error('overlay_path_invalid');
    return target;
}
function walk(root, prefix = '') {
    return fs.readdirSync(path.join(root, prefix), { withFileTypes: true }).filter(e => !e.name.startsWith('.fuse')).flatMap(e => {
        const file = path.join(prefix, e.name);
        if (e.isDirectory()) return walk(root, file);
        if (!e.isFile()) throw new Error('overlay_non_regular');
        return [file];
    });
}
function verifyPackage(root) {
    const manifestFile = path.join(root, 'manifest.json');
    const manifest = read(manifestFile);
    if (manifest.version !== 1 || manifest.localOnly !== true || !Array.isArray(manifest.modules) || !Array.isArray(manifest.assets)) throw new Error('overlay_manifest_invalid');
    for (const entry of [...manifest.modules.map(m => ({ file: m.override, sha256: m.sha256 })), ...manifest.assets,
        { file: 'acceptance.json', sha256: manifest.acceptanceSha256 }, { file: 'preload.cjs', sha256: manifest.privatePreloadSha256 }]) {
        const full = within(root, entry.file);
        if (!fs.lstatSync(full).isFile() || fs.realpathSync(full) !== full || sha(fs.readFileSync(full)) !== entry.sha256) throw new Error('overlay_content_drift');
    }
    const acceptance = read(path.join(root, 'acceptance.json'));
    const full = acceptance.state === 'passed' && acceptance.checks?.join(',') === 'backend,frontend';
    const release = acceptance.kind === 'published-release' && acceptance.state === 'published';
    if ((!full && !release) || acceptance.fingerprint !== manifest.sourceFingerprint) throw new Error('overlay_acceptance_invalid');
    return { manifest, digest: sha(fs.readFileSync(manifestFile)) };
}
function verifyOverlay(record) {
    if (!record) return;
    const digest = root => record.installOnly ? sha(fs.readFileSync(path.join(root, 'manifest.json'))) : verifyPackage(root).digest;
    if (fs.realpathSync(record.link) !== record.previousRoot || digest(record.previousRoot) !== record.previousDigest
        || digest(record.root) !== record.digest) throw new Error('overlay_changed');
}
function verifySourceSnapshots(old) {
    if (logicSnapshot(old.privateSourceRoot).fingerprint !== old.sourceFingerprint) throw new Error('overlay_private_source_drift');
    const publicHead = cp.execFileSync('git', ['rev-parse', 'HEAD'], { cwd: old.publicBaseSourceRoot, encoding: 'utf8' }).trim();
    if (publicHead !== old.baselineHead || cp.execFileSync('git', ['status', '--porcelain', '--untracked-files=normal'], { cwd: old.publicBaseSourceRoot, encoding: 'utf8' }).trim()) throw new Error('overlay_public_source_drift');
}
async function prepareOverlay({ owner, taskRoot, artifactsRoot, executeFactory, installOnly = false, runId = '', dataDir = '' }) {
    const link = path.join(owner, 'tmp/local-bark-reminder');
    if (!fs.existsSync(link)) {
        // An active private preload without the registered contract cannot be dropped.
        if (process.env.FARM_LOCAL_BARK_WEB_DIST || /local-bark-reminder/.test(process.env.NODE_OPTIONS || '')) throw new Error('overlay_registration_missing');
        return null;
    }
    const previousRoot = fs.realpathSync(link);
    const { manifest: old, digest: previousDigest } = verifyPackage(previousRoot);
    if (!old.privateSourceRoot || !old.publicBaseSourceRoot || !Array.isArray(old.privateFiles)) throw new Error('overlay_source_missing');
    verifySourceSnapshots(old);
    const head = cp.execFileSync('git', ['rev-parse', 'HEAD'], { cwd: taskRoot, encoding: 'utf8' }).trim();
    if (installOnly && dataDir) {
        let prepared;
        try { prepared = read(path.join(dataDir, 'program-update-private-build.json')); } catch { prepared = null; }
        if (prepared?.commit === head && prepared.previousRoot === previousRoot && prepared.previousDigest === previousDigest) {
            const built = verifyPackage(prepared.root); verifySourceSnapshots(built.manifest);
            if (built.digest !== prepared.digest || built.manifest.baselineHead !== head) throw new Error('prepared_bundle_changed');
            return { link, previousRoot, previousDigest, root: prepared.root, digest: built.digest,
                privateFingerprint: built.manifest.sourceFingerprint, installOnly: true, prepared: true,
            };
        }
    }
    const privateRoot = path.join(path.dirname(taskRoot), 'private');
    cp.execFileSync('git', ['worktree', 'add', '--detach', privateRoot, head], { cwd: taskRoot, stdio: 'pipe' });
    const checkDir = path.join(artifactsRoot, 'private-validation'); fs.mkdirSync(checkDir, { mode: 0o700 });
    const isolatedData = path.join(checkDir, 'resource-data'); fs.mkdirSync(isolatedData, { mode: 0o700 });
    require('./evolution-publish').wireRuntimeResources(owner, privateRoot, isolatedData);
    require('./program-update').linkDependencies(taskRoot, privateRoot);
    for (const file of old.privateFiles) {
        const target = within(privateRoot, file); const base = within(old.publicBaseSourceRoot, file); const source = within(old.privateSourceRoot, file);
        if (!fs.lstatSync(source).isFile()) throw new Error('overlay_source_invalid');
        fs.mkdirSync(path.dirname(target), { recursive: true });
        const privateBytes = fs.readFileSync(source);
        if (!fs.existsSync(base)) {
            if (fs.existsSync(target) && !fs.readFileSync(target).equals(privateBytes)) throw new Error('overlay_add_conflict');
            fs.writeFileSync(target, privateBytes);
        } else if (fs.existsSync(target) && fs.readFileSync(target).equals(fs.readFileSync(base))) fs.writeFileSync(target, privateBytes);
        else {
            // git merge-file has no hooks or external merge drivers.
            const merged = cp.spawnSync('git', ['merge-file', '-p', target, base, source], { encoding: null, maxBuffer: 8 * 1024 * 1024 });
            if (merged.status !== 0) throw new Error('overlay_rebase_conflict');
            fs.writeFileSync(target, merged.stdout);
        }
        fs.chmodSync(target, fs.statSync(source).mode & 0o777);
    }
    verifySourceSnapshots(old);
    const dist = path.join(checkDir, 'packaged-web-dist');
    let reused = false;
    let result;
    if (installOnly) {
        const env = { ...require('./program-update').offlineEnv(), PATH: path.dirname(process.execPath) + path.delimiter + process.env.PATH };
        const changes = cp.execFileSync('git', ['diff', '--name-only', '-z', old.baselineHead, head], { cwd: taskRoot, encoding: 'utf8' }).split('\0').filter(Boolean);
        const buildNeeded = changes.some(file => file.startsWith('web/') || ['core/package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'docs/CHANGELOG.md'].includes(file));
        if (buildNeeded) await executeFactory(checkDir)('npm', ['run', 'build', '--', '--outDir', dist, '--emptyOutDir'], { cwd: path.join(privateRoot, 'web'), env });
        reused = !buildNeeded;
        result = require('./program-update-cache').recordPublishedRelease({ dataDir: checkDir, sourceRoot: privateRoot, commit: head, runId });
    } else {
        result = await runEvolutionValidation({ repoRoot: privateRoot, dataDir: checkDir, force: true,
            env: require('./program-update').validationEnv({ owner, taskRoot: privateRoot, artifactsRoot: checkDir }), execute: executeFactory(checkDir, out => fs.cpSync(out, dist, { recursive: true })) });
    }
    const root = path.join(artifactsRoot, `overlay-${head.slice(0, 12)}`); fs.mkdirSync(root, { mode: 0o700 });
    const put = (relative, bytes) => { const target = within(root, relative); fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 }); fs.writeFileSync(target, bytes, { mode: 0o600 }); };
    const modules = old.modules.map(m => {
        const bytes = fs.readFileSync(within(privateRoot, m.file)); put(m.override, bytes);
        return { ...m, sha256: sha(bytes), baselineSha256: sha(fs.readFileSync(within(taskRoot, m.file))) };
    });
    // Old hashed chunks remain available to already open tabs until their reload.
    for (const asset of old.assets) put(asset.file, fs.readFileSync(within(previousRoot, asset.file)));
    if (!reused) for (const file of walk(dist)) put(path.join('web-dist', file), fs.readFileSync(path.join(dist, file)));
    const acceptance = fs.readFileSync(path.join(checkDir, installOnly ? 'program-update-release.json' : 'evolution-validation.json'));
    put('acceptance.json', acceptance);
    const preload = fs.readFileSync(path.join(previousRoot, 'preload.cjs'));
    put('preload.cjs', preload);
    fs.mkdirSync(path.join(root, 'session-host-logs'), { mode: 0o700 });
    const assets = walk(path.join(root, 'web-dist')).map(file => ({ file: path.join('web-dist', file), sha256: sha(fs.readFileSync(path.join(root, 'web-dist', file))) }));
    put('manifest.json', JSON.stringify({ version: 1, localOnly: true, baselineHead: head, sourceFingerprint: result.fingerprint,
        modules, assets, acceptanceSha256: sha(acceptance), privatePreloadSha256: sha(preload), privateFiles: old.privateFiles,
        privateSourceRoot: privateRoot, publicBaseSourceRoot: taskRoot, preparedAt: Date.now() }, null, 2));
    const record = { link, previousRoot, previousDigest, root, digest: verifyPackage(root).digest, privateFingerprint: result.fingerprint, validationReused: reused, installOnly };
    verifyOverlay(record);
    return record;
}
function pinEnvironment(env, record, useNew) {
    if (!record) return { ...env };
    const root = useNew ? record.root : record.previousRoot;
    const pinned = { ...env };
    pinned.NODE_OPTIONS = String(env.NODE_OPTIONS || '').split(record.link).join(root).split(record.previousRoot).join(root);
    if (!pinned.NODE_OPTIONS.includes(path.join(root, 'preload.cjs'))) throw new Error('overlay_preload_not_active');
    pinned.FARM_LOCAL_BARK_WEB_DIST = path.join(root, 'web-dist');
    return pinned;
}
function restoreOverlay(record) {
    if (!record) return;
    const current = fs.realpathSync(record.link);
    if (verifyPackage(record.previousRoot).digest !== record.previousDigest) throw new Error('overlay_rollback_unproven');
    if (current === record.previousRoot) return;
    if (current !== record.root) throw new Error('overlay_rollback_unproven');
    const temporary = `${record.link}.${crypto.randomUUID()}.restore`;
    fs.symlinkSync(record.previousRoot, temporary, 'dir'); fs.renameSync(temporary, record.link);
    if (fs.realpathSync(record.link) !== record.previousRoot) throw new Error('overlay_rollback_unproven');
}
function commitOverlay(record) {
    if (!record) return;
    verifyOverlay(record);
    const temporary = `${record.link}.${crypto.randomUUID()}.next`;
    fs.symlinkSync(record.root, temporary, 'dir'); fs.renameSync(temporary, record.link);
}
module.exports = { verifySourceSnapshots, prepareOverlay, verifyOverlay, verifyPackage, pinEnvironment, commitOverlay, restoreOverlay };
