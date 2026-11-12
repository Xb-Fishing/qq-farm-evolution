'use strict';
// Published application installation helpers; developer regression is separate.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const json = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
const digest = value => hash(JSON.stringify(stable(value)));
const contexts = ['', 'core', 'web'];
const fields = ['name', 'dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'peerDependenciesMeta',
    'bundledDependencies', 'bundleDependencies', 'pnpm', 'overrides', 'resolutions', 'packageManager', 'engines', 'os', 'cpu'];
function installationInput(root) {
    const packages = contexts.map(context => {
        const manifest = json(path.join(root, context, 'package.json'));
        return [context, Object.fromEntries(fields.filter(key => Object.hasOwn(manifest, key)).map(key => [key, manifest[key]]))];
    });
    const files = ['pnpm-lock.yaml', 'pnpm-workspace.yaml', '.npmrc', 'core/.npmrc', 'web/.npmrc', '.pnpmfile.cjs', '.pnpmfile.js'].map(file => {
        try { return [file, hash(fs.readFileSync(path.join(root, file)))]; }
        catch (error) { if (error.code === 'ENOENT') return [file, null]; throw error; }
    });
    if (!files[0][1]) throw new Error('dependency_lock_missing');
    return digest({ packages, files });
}
function reusableDependencies(sourceRoot, targetRoot) {
    try {
        const roots = contexts.map(context => [context, fs.realpathSync(path.join(sourceRoot, context, 'node_modules'))]);
        const identity = { input: installationInput(sourceRoot), roots };
        return identity.input === installationInput(targetRoot) ? { reused: true, identity, sourceRoot } : { reused: false };
    } catch { return { reused: false }; }
}
function recordPublishedRelease({ dataDir, sourceRoot, commit, runId }) {
    const fingerprint = require('./evolution-validation').logicSnapshot(sourceRoot).fingerprint;
    const value = { version: 1, kind: 'published-release', state: 'published', runId, commit,
        sourceRoot: path.resolve(sourceRoot), fingerprint, recordedAt: Date.now(), checks: [] };
    const file = path.join(dataDir, 'program-update-release.json');
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const temporary = `${file  }.${  crypto.randomUUID()  }.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 }); fs.renameSync(temporary, file);
    return value;
}
function publishedRelease(dataDir, sourceRoot, commit) {
    const value = json(path.join(dataDir, 'program-update-release.json'));
    if (value.version !== 1 || value.kind !== 'published-release' || value.state !== 'published'
        || value.sourceRoot !== path.resolve(sourceRoot) || value.commit !== commit
        || value.fingerprint !== require('./evolution-validation').logicSnapshot(sourceRoot).fingerprint) throw new Error('published_release_changed');
    return value;
}

module.exports = { installationInput, reusableDependencies, recordPublishedRelease, publishedRelease, digest };
