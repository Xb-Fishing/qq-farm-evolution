const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

function nonRuntimeFile(file) {
  // The login update log imports this document into the frontend bundle.
  if (file === 'docs/CHANGELOG.md') return false;
  return /^(?:core\/test\/|(?:core\/)?docs\/)/.test(file)
    || /^(?:README(?:\.[^/]*)?|LICENSE(?:\.[^/]*)?|AGENTS\.md)$/.test(file);
}

function sourceFiles(root) {
  return execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).split('\0').filter(Boolean);
}

function fileIdentity(root, file) {
  const absolute = path.resolve(root, file);
  if (!absolute.startsWith(path.resolve(root) + path.sep)) throw new Error('invalid_source_path');
  const stat = fs.lstatSync(absolute);
  if (!stat.isFile() && !stat.isSymbolicLink()) throw new Error('unsupported_source');
  const body = stat.isSymbolicLink() ? fs.readlinkSync(absolute) : fs.readFileSync(absolute);
  return `${stat.mode & 0o777}:${stat.isSymbolicLink() ? 'link' : 'file'}:${crypto.createHash('sha256').update(body).digest('hex')}`;
}

// Conservative: every tracked file outside the explicit documentation/test
// allowlist participates, including dependencies, configuration and web assets.
function inspectDeploymentImpact(runningRoot, targetRoot) {
  const prior = new Set(sourceFiles(runningRoot));
  const next = new Set(sourceFiles(targetRoot));
  const changed = [];
  const hash = crypto.createHash('sha256');
  for (const file of [...new Set([...prior, ...next])].sort()) {
    const left = prior.has(file) ? fileIdentity(runningRoot, file) : '';
    const right = next.has(file) ? fileIdentity(targetRoot, file) : '';
    if (left !== right) changed.push(file);
    if (!nonRuntimeFile(file)) hash.update(`${file}\0${right}\0`);
  }
  return { equivalent: changed.every(nonRuntimeFile), changedFiles: changed,
    productionFingerprint: hash.digest('hex') };
}

module.exports = { inspectDeploymentImpact };
