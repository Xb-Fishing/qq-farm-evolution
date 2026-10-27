const path = require('node:path');
const fs = require('node:fs');
const publication = require('../services/evolution-publish');
const { privateJson, sourceCommit } = require('./session-registry');

const SESSION_CONTRACT_VERSION = 1;
function acceptedRecords(dataDir) {
  let approved;
  try { approved = privateJson(path.join(dataDir, 'evolution-approved-runtime.json'))?.target; } catch {}
  return [publication.readApplyTarget(dataDir), approved].filter(Boolean);
}
function resolveBusinessTarget({ runtimeRoot, dataDir, hostSourceRoot = runtimeRoot }) {
  const root = fs.realpathSync(runtimeRoot); const commit = sourceCommit(root);
  const record = acceptedRecords(dataDir).find(record => record.runtimeRoot === root && record.commit === commit);
  if (!record) throw new Error('Business target not accepted');
  return validateBusinessTarget({ target: { ...record, contractVersion: SESSION_CONTRACT_VERSION }, dataDir, hostSourceRoot });
}
function validateBusinessTarget({ target, dataDir, hostSourceRoot }) {
  if (target?.contractVersion !== SESSION_CONTRACT_VERSION || !target.runtimeRoot || !target.commit || !target.sourceFingerprint)
    throw new Error('Business target contract unavailable');
  const root = fs.realpathSync(target.runtimeRoot);
  if (root !== path.resolve(target.runtimeRoot) || publication.realCommonDir(root) !== publication.realCommonDir(hostSourceRoot))
    throw new Error('Business target repository mismatch');
  const records = acceptedRecords(dataDir);
  const record = records.find(record => record.runtimeRoot === root && record.commit === target.commit
    && record.sourceFingerprint === target.sourceFingerprint);
  if (!record || sourceCommit(root) !== target.commit) throw new Error('Business target not accepted');
  const result = publication.verifyRunningRuntime({ record, repoRoot: root, cwd: path.join(root, 'core'),
    entry: path.join(root, 'core/client.js'), dataDir });
  if (!result.ok) throw new Error('Business target validation changed');
  return { ...target, runtimeRoot: root };
}
module.exports = { SESSION_CONTRACT_VERSION, validateBusinessTarget, resolveBusinessTarget };

function defaultSessionMode({ runtimeRoot, dataDir, platform = process.platform, packaged = false }) {
  if (platform !== 'linux' || packaged) return 'thread';
  const root = fs.realpathSync(runtimeRoot);
  if (!acceptedRecords(dataDir).some(record => record.runtimeRoot === root)) return 'thread';
  resolveBusinessTarget({ runtimeRoot: root, dataDir });
  return 'persistent';
}
module.exports.defaultSessionMode = defaultSessionMode;
