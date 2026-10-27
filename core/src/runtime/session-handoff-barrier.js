const fs = require('node:fs'); const path = require('node:path');
const { processStarttime, processIsLive, privateJson, atomicJson, secureDirectory } = require('./session-registry');
const fileAt = dataDir => path.join(path.resolve(dataDir), 'persistent-sessions', 'update-barrier.json');
function readSessionBarrier(dataDir) {
  try {
    const value = privateJson(fileAt(dataDir));
    if (value.version !== 1 || !value.nonce || value.expiresAt <= Date.now()
      || !processIsLive(value.ownerPid, value.ownerStarttime)
      || !processIsLive(value.blockedPid, value.blockedStarttime)) return null;
    return value;
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
function beginSessionBarrier({ dataDir, nonce, blockedPid, blockedStarttime, expiresAt }) {
  if (!nonce || !blockedPid || !processIsLive(blockedPid, blockedStarttime)) throw new Error('Session barrier identity changed');
  const file = fileAt(dataDir); secureDirectory(path.dirname(file));
  const existing = readSessionBarrier(dataDir);
  if (existing && (existing.nonce !== nonce || existing.blockedPid !== blockedPid)) throw new Error('Another session handoff is active');
  const value = existing || { version: 1, nonce, blockedPid, blockedStarttime,
    ownerPid: process.pid, ownerStarttime: processStarttime(process.pid), createdAt: Date.now(),
    expiresAt: Math.min(Number(expiresAt) || Date.now() + 90000, Date.now() + 90000) };
  atomicJson(file, value); return value;
}
function assertSessionCreationAllowed(dataDir, pid = process.pid, starttime = processStarttime(pid)) {
  const barrier = readSessionBarrier(dataDir);
  if (barrier && barrier.blockedPid === pid && barrier.blockedStarttime === starttime)
    throw Object.assign(new Error('Management handoff is in progress'), { code: 'SESSION_HANDOFF_IN_PROGRESS' });
}
function releaseSessionBarrier(dataDir, nonce) {
  const file = fileAt(dataDir);
  try { if (privateJson(file).nonce === nonce) fs.unlinkSync(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
module.exports = { readSessionBarrier, beginSessionBarrier, assertSessionCreationAllowed, releaseSessionBarrier };
