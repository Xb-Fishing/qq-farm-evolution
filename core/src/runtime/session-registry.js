const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const { SessionRpcClient } = require('./session-rpc');

const hash = value => crypto.createHash('sha256').update(String(value)).digest('hex');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function processStarttime(pid) {
  if (!Number.isSafeInteger(Number(pid)) || Number(pid) <= 0) return '';
  try { return fs.readFileSync(`/proc/${Number(pid)}/stat`, 'utf8').split(') ').at(-1).split(' ')[19] || ''; }
  catch { return ''; }
}
function processIsLive(pid, starttime = processStarttime(pid)) {
  if (!starttime || processStarttime(pid) !== starttime) return false;
  try { return !['Z', 'X'].includes(fs.readFileSync(`/proc/${Number(pid)}/stat`, 'utf8').split(') ').at(-1).split(' ')[0]); }
  catch { return false; }
}
function lockIsHeld(file) {
  try {
    const inode = fs.statSync(file, { bigint: true }).ino.toString();
    return fs.readFileSync('/proc/locks', 'utf8').split('\n').some(line => {
      const columns = line.trim().split(/\s+/);
      return columns[1] === 'FLOCK' && columns[3] === 'WRITE' && columns[5]?.endsWith(`:${inode}`)
        && processIsLive(Number(columns[4]));
    });
  } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
function bindingIdentity(account) {
  return hash(JSON.stringify([String(account.id), account.username || String(account.ownerId || account.userId || ''), account.platform || '',
    account.wxid || '', account.sessionGeneration || '']));
}
function secureDirectory(directory, create = true) {
  const absolute = path.resolve(directory);
  let current = path.parse(absolute).root;
  for (const part of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    let stat;
    try { stat = fs.lstatSync(current); }
    catch (error) {
      if (error.code !== 'ENOENT' || !create) throw error;
      try { fs.mkdirSync(current, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
      stat = fs.lstatSync(current);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Private session directory unavailable');
  }
  const stat = fs.lstatSync(absolute);
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(absolute) !== absolute
    || (typeof process.getuid === 'function' && stat.uid !== process.getuid()) || (stat.mode & 0o077))
    throw new Error('Private session directory unavailable');
  return absolute;
}
function pathsFor(dataDir, accountId) {
  const key = hash(accountId).slice(0, 24);
  const directory = path.join(path.resolve(dataDir), 'persistent-sessions');
  const tag = `qfs-${hash(`${process.getuid?.() || 0}:${path.resolve(dataDir)}`).slice(0, 20)}`;
  let socketRoot = path.join(os.tmpdir(), tag);
  if (Buffer.byteLength(path.join(socketRoot, `${key}.sock`)) > 100) socketRoot = path.join('/tmp', tag);
  return { directory, socketRoot, descriptor: path.join(directory, `${key}.json`),
    lock: path.join(directory, `${key}.lock`), socketPath: path.join(socketRoot, `${key}.sock`) };
}
function privateJson(file) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || (stat.mode & 0o077) || stat.size > 1024 * 1024
      || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) throw new Error('Invalid private session record');
    return JSON.parse(fs.readFileSync(fd, 'utf8'));
  } finally { fs.closeSync(fd); }
}
function atomicJson(file, value) {
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  let fd;
  try {
    fd = fs.openSync(temporary, 'wx', 0o600); fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd);
    fs.closeSync(fd); fd = undefined; fs.renameSync(temporary, file);
  } finally { if (fd !== undefined) fs.closeSync(fd); try { fs.unlinkSync(temporary); } catch {} }
}
function sourceCommit(root) {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', timeout: 10000,
    stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function socketIdentity(pid, starttime, socketPath) {
  if (!starttime || processStarttime(pid) !== starttime) return '';
  try {
    const stat = fs.lstatSync(socketPath);
    if (!stat.isSocket() || stat.isSymbolicLink() || (stat.mode & 0o077)
      || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) return '';
    const line = fs.readFileSync('/proc/net/unix', 'utf8').split('\n').map(row => row.trim().split(/\s+/))
      .find(columns => columns[7] === socketPath && columns[3] === '00010000' && columns[4] === '0001' && columns[5] === '01');
    if (!line || !/^\d+$/.test(line[6])) return '';
    const inode = line[6];
    const owns = fs.readdirSync(`/proc/${pid}/fd`).some(name => {
      try { return fs.readlinkSync(`/proc/${pid}/fd/${name}`) === `socket:[${inode}]`; } catch { return false; }
    });
    return owns && processStarttime(pid) === starttime ? inode : '';
  } catch { return ''; }
}
function descriptorFor(dataDir, account) {
  const paths = pathsFor(dataDir, account.id);
  let value;
  try {
    secureDirectory(paths.directory, false); secureDirectory(paths.socketRoot, false);
    value = privateJson(paths.descriptor);
    if (value.version !== 1 || value.accountId !== String(account.id) || value.socketPath !== paths.socketPath
      || value.binding !== bindingIdentity(account) || !/^[a-f0-9]{64}$/.test(value.capability || '')
      || !value.hostId || !value.starttime || !processIsLive(value.pid, value.starttime))
      return { state: 'stale', descriptor: value, paths };
    if (typeof value.sourceRoot !== 'string' || fs.realpathSync(value.sourceRoot) !== value.sourceRoot
      || !/^[a-f0-9]{64}$/.test(value.sourceFingerprint || '') || sourceCommit(value.sourceRoot) !== value.sourceCommit
      || require('../services/evolution-validation').logicSnapshot(value.sourceRoot).fingerprint !== value.sourceFingerprint)
      return { state: 'unknown', paths };
    const argv = fs.readFileSync(`/proc/${value.pid}/cmdline`, 'utf8').split('\0');
    if (argv[1] !== path.join(value.sourceRoot, 'core/src/runtime/session-host.js')) return { state: 'unknown', paths };
    if (!value.socketInode || socketIdentity(value.pid, value.starttime, value.socketPath) !== value.socketInode)
      return { state: 'unknown', paths };
    return { state: 'present', descriptor: value, paths };
  } catch (error) {
    if (error.code !== 'ENOENT' || value || lockIsHeld(paths.lock)) return { state: 'unknown', paths };
    return { state: 'absent', paths };
  }
}
async function connectSession(dataDir, account) {
  const found = descriptorFor(dataDir, account);
  if (found.state !== 'present') return found;
  const client = new SessionRpcClient(found.descriptor);
  try {
    const hello = await client.connect(); const again = descriptorFor(dataDir, account);
    if (again.state !== 'present' || again.descriptor.hostId !== found.descriptor.hostId
      || again.descriptor.socketInode !== found.descriptor.socketInode) throw new Error('Session identity changed');
    return { ...found, client, hello };
  }
  catch { client.close(); return { ...found, state: 'unknown' }; }
}
async function ensureSession({ dataDir, account, sourceRoot, logDir }) {
  if (process.platform !== 'linux') throw new Error('Persistent sessions require Linux process identity');
  const paths = pathsFor(dataDir, account.id);
  secureDirectory(paths.directory); secureDirectory(paths.socketRoot);
  let found = await connectSession(dataDir, account);
  if (found.state === 'present') return found;
  if (found.state === 'stale' && processIsLive(found.descriptor?.pid, found.descriptor?.starttime))
    throw new Error('Previous account session must be closed before reauthorization');
  if (found.state === 'unknown') throw new Error('Existing account session could not be verified');
  require('./session-handoff-barrier').assertSessionCreationAllowed(dataDir);
  const admitted = require('./session-contract').resolveBusinessTarget({ runtimeRoot: sourceRoot, dataDir });
  // A kernel lock stays held by the host throughout its lifetime. Never unlink
  // the lock; stale descriptor/socket cleanup belongs to its exclusive holder.
  let fd;
  try {
    fd = fs.openSync(paths.lock, fs.constants.O_CREAT | fs.constants.O_RDWR | fs.constants.O_NOFOLLOW, 0o600);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || (stat.mode & 0o077) || stat.uid !== process.getuid()) throw new Error('Invalid session lock');
  } finally { if (fd !== undefined) fs.closeSync(fd); }
  const bootstrap = path.join(paths.directory, `bootstrap-${crypto.randomUUID()}.json`);
  const output = secureDirectory(logDir || path.join(dataDir, 'logs', 'session-hosts'));
  atomicJson(bootstrap, { version: 1, account, sourceRoot, sourceCommit: admitted.commit, sourceFingerprint: admitted.sourceFingerprint, dataDir: path.resolve(dataDir),
    hostId: crypto.randomUUID(), capability: crypto.randomBytes(32).toString('hex'), paths,
    managerPid: process.pid, managerStarttime: processStarttime(process.pid) });
  let child;
  try {
    fd = fs.openSync(path.join(output, `${hash(account.id).slice(0, 24)}.log`), fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600);
    try {
      child = spawn('/usr/bin/flock', ['-n', '-E', '73', '-F', paths.lock, process.execPath, path.join(sourceRoot, 'core/src/runtime/session-host.js')], {
        cwd: path.join(sourceRoot, 'core'), detached: true, stdio: ['ignore', fd, fd],
        env: { ...process.env, FARM_DATA_DIR: path.resolve(dataDir), FARM_SESSION_BOOTSTRAP: bootstrap,
          FARM_ACCOUNT_ID: String(account.id), FARM_SESSION_ROLE: 'host', FARM_SESSION_BUSINESS: '' },
      });
    } finally { fs.closeSync(fd); fd = undefined; }
    let launchError = false; child.once('error', () => { launchError = true; }); child.unref();
    for (let i = 0; i < 200; i++) {
      await delay(50); found = await connectSession(dataDir, account);
      if (found.state === 'present') return found;
      if (launchError || (child.exitCode !== null && child.exitCode !== 73)) break;
    }
    // An unknown startup result never authorizes releasing the live host lock
    // or replaying operations. A later caller must authenticate the same host.
    throw new Error('Account session host did not become ready');
  } finally {
    try { fs.unlinkSync(bootstrap); } catch {}
  }
}
module.exports = { processStarttime, processIsLive, lockIsHeld, bindingIdentity, secureDirectory, pathsFor, privateJson,
  atomicJson, sourceCommit, socketIdentity, descriptorFor, connectSession, ensureSession };
