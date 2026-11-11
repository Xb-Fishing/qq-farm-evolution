'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const parent = fs.realpathSync(os.tmpdir());
const prefix = path.resolve(parent, 'farm-program-version-'); assert.equal(path.dirname(prefix), parent);
const root = fs.mkdtempSync(prefix); process.env.FARM_DATA_DIR = root;
const version = require('../src/services/program-version');
after(() => fs.rmSync(root, { recursive: true, force: true }));
const safe = (base, relative) => { const file = path.resolve(base, relative); assert.ok(file.startsWith(base + path.sep)); return file; };
const writePackage = (base, value) => { const file = safe(base, 'core/package.json'); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value)); };
const git = (base, args) => cp.execFileSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@invalid', ...args], { cwd: base, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
test('application version is a package version, and invalid values cannot become displayed versions', () => {
  for (const text of ['2.3.1', '2.3.0-rebuild', '3.0.0+build.1']) assert.equal(version.parseVersion(JSON.stringify({ version: text })), text);
  for (const text of ['abc', '01.0.0', '', 'v2.3.1', '1.2', '1.2.3\nprivate']) assert.throws(() => version.parseVersion(JSON.stringify({ version: text })));
});
test('checking an upstream version reads a pinned Git package object, fetching an absent object without executing package scripts', async () => {
  const source = safe(root, 'source'); const client = safe(root, 'client'); fs.mkdirSync(source);
  git(source, ['init', '-q']); writePackage(source, { version: '1.0.0' }); git(source, ['add', '.']); git(source, ['commit', '-qm', 'initial']);
  git(root, ['clone', '--no-local', source, client]);
  const marker = safe(root, 'scripts-must-not-run');
  writePackage(source, { version: '1.1.0', scripts: { postinstall: `touch ${marker}` } }); git(source, ['add', '.']); git(source, ['commit', '-qm', 'next']);
  const next = git(source, ['rev-parse', 'HEAD']);
  assert.equal(await version.targetVersion(client, next), '1.1.0');
  assert.equal(version.installedVersion(client), '1.0.0'); assert.equal(fs.existsSync(marker), false);
  await assert.rejects(version.targetVersion(client, '--unsafe'), /revision_invalid/);
});
test('the public status contains version labels and progress, never repository or commit internals', () => {
  const updater = require('../src/services/program-update');
  const output = updater.publicState({ root: path.resolve(__dirname, '../..'), state: { phase: 'available', currentCommit: 'a'.repeat(40), targetCommit: 'b'.repeat(40), latestVersion: '9.0.0', runId: 'private-run', reason: 'private path', updatedAt: 123 } });
  assert.equal(output.currentVersion, require('../package.json').version); assert.equal(output.latestVersion, '9.0.0'); assert.equal(output.updateAvailable, true);
  for (const field of ['currentCommit', 'targetCommit', 'runId', 'source', 'reason']) assert.equal(field in output, false);
  assert.doesNotMatch(JSON.stringify(output), /private-run|private path/);
});
