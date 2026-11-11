'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Z.-]+)?(?:\+[0-9A-Z.-]+)?$/i;
function parseVersion(bytes) {
    const value = JSON.parse(String(bytes)).version;
    if (typeof value !== 'string' || value.length > 80 || !VERSION.test(value)) throw new Error('program_version_invalid');
    return value;
}
function installedVersion(root) {
    try { return parseVersion(fs.readFileSync(path.join(root, 'core/package.json'), 'utf8')); }
    catch { return null; }
}
function git(root, args, timeout = 30000) {
    return new Promise((resolve, reject) => execFile('git', args, { cwd: root, timeout, encoding: 'utf8', maxBuffer: 256 * 1024,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (error, stdout) => error ? reject(new Error('version_source_unavailable')) : resolve(stdout)));
}
async function targetVersion(root, revision) {
    if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error('version_revision_invalid');
    const object = `${revision}:core/package.json`;
    let bytes;
    try { bytes = await git(root, ['show', object]); }
    catch {
        // Fetch only from the origin whose identity the updater already verified.
        // No worktree, package script, request URL or caller-supplied path is executed.
        await git(root, ['fetch', '--no-tags', 'origin', revision], 60000);
        bytes = await git(root, ['show', object]);
    }
    return parseVersion(bytes);
}
module.exports = { parseVersion, installedVersion, targetVersion };
