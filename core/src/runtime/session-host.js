const fs = require('node:fs'); const path = require('node:path'); const net = require('node:net'); const crypto = require('node:crypto');
const { framed } = require('./session-rpc');
const { createSessionHostCore, sessionError } = require('./session-host-core');
const { SESSION_CONTRACT_VERSION, validateBusinessTarget, resolveBusinessTarget } = require('./session-contract');
const { pathsFor, privateJson, atomicJson, secureDirectory, processStarttime, processIsLive, socketIdentity, bindingIdentity } = require('./session-registry');
const { createLifecycleJournal } = require('./session-lifecycle-journal');
const { decode } = require('./session-codec');

function ownsKernelLock(file) {
  const inode = fs.statSync(file, { bigint: true }).ino.toString();
  return fs.readFileSync('/proc/locks', 'utf8').split('\n').some(line => {
    const columns = line.trim().split(/\s+/);
    return columns[1] === 'FLOCK' && columns[3] === 'WRITE' && columns[4] === String(process.pid) && columns[5]?.endsWith(`:${inode}`);
  });
}
function sameCapability(a, b) {
  return /^[a-f0-9]{64}$/.test(String(a || '')) && crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}
async function startSessionHost({ bootstrap, game, createBusiness, validateTarget, requireKernelLock = true, onClose = () => {} }) {
  const expected = pathsFor(bootstrap.dataDir, bootstrap.account.id);
  for (const [key, value] of Object.entries(expected)) if (bootstrap.paths[key] !== value) throw sessionError('SESSION_PATH_MISMATCH');
  secureDirectory(expected.directory, false); secureDirectory(expected.socketRoot, false);
  if (requireKernelLock && !ownsKernelLock(expected.lock)) throw sessionError('SESSION_KERNEL_LOCK_MISSING');
  let existing;
  try { existing = privateJson(expected.descriptor); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (existing?.starttime && processIsLive(existing.pid, existing.starttime)) throw sessionError('SESSION_HOST_ALREADY_EXISTS');
  const staleSocket = fs.lstatSync(expected.socketPath, { throwIfNoEntry: false });
  if (staleSocket) {
    if (!staleSocket.isSocket() || staleSocket.isSymbolicLink() || staleSocket.uid !== process.getuid()) throw sessionError('SESSION_SOCKET_UNVERIFIABLE');
    const listening = fs.readFileSync('/proc/net/unix', 'utf8').split('\n').some(line => line.trim().split(/\s+/)[7] === expected.socketPath);
    if (listening) throw sessionError('SESSION_SOCKET_ALREADY_LIVE');
    fs.unlinkSync(expected.socketPath);
  }
  const identity = { hostId: bootstrap.hostId, pid: process.pid, starttime: processStarttime(process.pid),
    sourceRoot: bootstrap.sourceRoot, sourceCommit: bootstrap.sourceCommit, sourceFingerprint: bootstrap.sourceFingerprint || '',
    accountId: String(bootstrap.account.id), binding: bindingIdentity(bootstrap.account), contractVersion: SESSION_CONTRACT_VERSION };
  const core = createSessionHostCore({ identity, game, createBusiness, validateTarget });
  const lifecycle = createLifecycleJournal({ dataDir: bootstrap.dataDir, account: bootstrap.account, identity });
  const peers = new Set(); const apiOwners = new Map(); let apiSequence = 0; let closing;
  const cleanupTimers = new Set();
  const isAlive = value => processStarttime(value.pid) === value.starttime;
  function event(peer, message) { if (peer.authenticated && !peer.socket.destroyed) { try { peer.write({ kind: 'event', message }); } catch { peer.socket.destroy(); } } }
  function broadcast(message) { for (const peer of peers) event(peer, message); }
  core.events.on('master', envelope => {
    const message = envelope.message;
    if (message?.type === 'api_response') {
      const owner = apiOwners.get(message.id); apiOwners.delete(message.id);
      if (owner) event(owner.peer, { ...envelope, message: { ...message, id: owner.originalId } });
    } else broadcast(envelope);
  });
  core.events.on('business-ready', facts => broadcast({ type: 'session_business_ready', facts }));
  core.events.on('business-error', envelope => broadcast({ type: 'session_business_error', ...envelope }));
  core.events.on('game-event', envelope => {
    if (!['login_ready', 'disconnect', 'kickout', 'ws_error', 'reconnect_failed'].includes(envelope.name)) return;
    let args = [];
    try { args = decode(envelope.args); } catch { /* No raw body enters lifecycle evidence. */ }
    const detail = envelope.name === 'kickout' ? { otherTerminal: args[0]?.reason === '已在其他终端登录',
      reason: args[0]?.reason === '已在其他终端登录' ? '已在其他终端登录' : '其他原因' }
      : envelope.name === 'ws_error' ? { code: Number(args[0]?.code) || 0 } : {};
    let row;
    try { row = lifecycle.append(envelope.name, envelope.facts.game, detail); }
    catch { core.revoke('生命周期证据保存失败').catch(() => {}); return; }
    broadcast({ type: 'session_lifecycle', event: row, facts: envelope.facts });
    // These deadlines belong to the physical session and survive any business
    // swap. They may never be copied onto a later connection epoch.
    if (envelope.name === 'kickout' || envelope.name === 'reconnect_failed'
      || (envelope.name === 'ws_error' && detail.code === 400)) {
      const epoch = envelope.facts.game.connectionEpoch;
      const timer = setTimeout(() => {
        cleanupTimers.delete(timer);
        if (core.facts().game.connectionEpoch === epoch) close().catch(() => {});
      }, envelope.name === 'reconnect_failed' ? 0 : 500);
      cleanupTimers.add(timer);
    }
  });
  const server = net.createServer(socket => {
    if (peers.size >= 16 || closing) { socket.destroy(); return; }
    const peer = { socket, authenticated: false, managerId: '', pending: 0 }; peers.add(peer);
    socket.setTimeout(15000, () => socket.destroy()); socket.on('error', () => {});
    socket.on('close', () => {
      peers.delete(peer); if (peer.managerId) core.detachManager(peer.managerId);
      for (const [id, owner] of apiOwners) if (owner.peer === peer) apiOwners.delete(id);
    });
    peer.write = framed(socket, async message => {
      if (message?.kind !== 'request' || !Number.isSafeInteger(message.id) || message.id < 1 || peer.pending >= 32) {
        socket.destroy(); return;
      }
      peer.pending++;
      let closeAfter = false;
      try {
        let result;
        if (!peer.authenticated) {
          if (message.method !== 'hello' || message.args?.hostId !== identity.hostId
            || !sameCapability(message.args?.capability, bootstrap.capability)) throw sessionError('SESSION_AUTHENTICATION_FAILED');
          peer.authenticated = true; socket.setTimeout(0); result = identity;
        } else if (message.method === 'hello') result = identity;
        else if (message.method === 'status') result = { facts: core.facts(), status: core.lastMasterStatus(), lifecycle: lifecycle.read() };
        else if (message.method === 'claim') {
          const manager = message.args?.manager;
          result = core.claimManager(manager, isAlive); peer.managerId = manager.id;
        } else if (message.method === 'detach') {
          core.detachManager(peer.managerId); peer.managerId = ''; result = true;
        } else if (message.method === 'revoke') { result = await core.revoke('账号停止'); closeAfter = true; }
        else {
          if (!peer.managerId || core.manager?.id !== peer.managerId || !isAlive(core.manager)) throw sessionError('SESSION_MANAGER_NOT_ATTACHED');
          if (message.method === 'attach') result = await core.attach(message.args?.target, message.args?.config || {});
          else if (message.method === 'send') {
            let payload = message.args?.message;
            if (!['api_call', 'config_sync', 'watchdog_ping'].includes(payload?.type)) throw sessionError('SESSION_MESSAGE_UNSUPPORTED');
            if (payload.type === 'api_call') {
              if (apiOwners.size >= 128) throw sessionError('SESSION_API_QUEUE_FULL');
              const forwardedId = `${identity.hostId}:${++apiSequence}`;
              apiOwners.set(forwardedId, { peer, originalId: payload.id }); payload = { ...payload, id: forwardedId };
              try { result = await core.dispatch(payload); } catch (error) { apiOwners.delete(forwardedId); throw error; }
            } else result = await core.dispatch(payload);
          } else throw sessionError('SESSION_METHOD_UNSUPPORTED');
        }
        peer.write({ kind: 'response', id: message.id, value: result });
      } catch (error) {
        const safe = typeof error.code === 'string' && /^SESSION_[A-Z_]+$/.test(error.code) ? error : sessionError('SESSION_CONTROL_FAILED');
        try { peer.write({ kind: 'response', id: message.id, error: safe }); } catch { socket.destroy(); }
        if (!peer.authenticated) socket.end();
      } finally {
        peer.pending--; if (closeAfter) queueMicrotask(() => close());
      }
    });
  });
  server.on('error', () => {});
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(expected.socketPath, resolve); });
  fs.chmodSync(expected.socketPath, 0o600);
  const socketInode = socketIdentity(process.pid, identity.starttime, expected.socketPath);
  if (!socketInode) { await new Promise(resolve => server.close(resolve)); throw sessionError('SESSION_SOCKET_OWNERSHIP_FAILED'); }
  const descriptor = { version: 1, ...identity, socketPath: expected.socketPath, socketInode, capability: bootstrap.capability };
  atomicJson(expected.descriptor, descriptor);
  core.events.on('business-pins', roots => {
    descriptor.businessRoots = [...new Set(roots)];
    atomicJson(expected.descriptor, descriptor);
  });
  async function close() {
    if (closing) return closing;
    closing = (async () => {
      try { if (!core.revoked) await core.revoke(); }
      finally {
        for (const timer of cleanupTimers) clearTimeout(timer); cleanupTimers.clear();
        for (const peer of peers) { event(peer, { type: 'session_exit' }); peer.socket.end(); }
        await new Promise(resolve => server.close(resolve));
        try { if (privateJson(expected.descriptor).hostId === identity.hostId) fs.unlinkSync(expected.descriptor); } catch {}
        game.dispose?.(); onClose();
      }
    })();
    return closing;
  }
  return { core, descriptor, close, receiveMaster: message => core.receiveMaster(message) };
}

async function bootstrapHost() {
  const file = process.env.FARM_SESSION_BOOTSTRAP;
  if (!file || process.env.FARM_SESSION_ROLE !== 'host') throw sessionError('SESSION_BOOTSTRAP_MISSING');
  const directory = path.resolve(process.env.FARM_DATA_DIR || '', 'persistent-sessions');
  if (path.dirname(path.resolve(file)) !== directory) throw sessionError('SESSION_BOOTSTRAP_PATH');
  secureDirectory(directory, false);
  const bootstrap = privateJson(file); const paths = pathsFor(bootstrap.dataDir, bootstrap.account.id);
  if (path.dirname(file) !== paths.directory || !/^bootstrap-[a-f0-9-]+\.json$/.test(path.basename(file))) throw sessionError('SESSION_BOOTSTRAP_PATH');
  secureDirectory(paths.directory, false); secureDirectory(paths.socketRoot, false);
  if (!ownsKernelLock(paths.lock)) throw sessionError('SESSION_KERNEL_LOCK_MISSING');
  require('./session-handoff-barrier').assertSessionCreationAllowed(bootstrap.dataDir, bootstrap.managerPid, bootstrap.managerStarttime);
  const admitted = resolveBusinessTarget({ runtimeRoot: bootstrap.sourceRoot, dataDir: bootstrap.dataDir });
  if (bootstrap.sourceCommit !== admitted.commit || bootstrap.sourceFingerprint !== admitted.sourceFingerprint)
    throw sessionError('SESSION_SOURCE_CHANGED');
  const { createSessionGameAdapter } = require('./session-game-adapter');
  let running; let revocationRequested = false; const early = [];
  const game = await createSessionGameAdapter({ account: bootstrap.account,
    onMaster: message => { if (running) running.receiveMaster(message); else early.push(message); },
    onRevoked: () => { if (running) running.close().catch(() => process.exit(1)); else revocationRequested = true; },
  });
  running = await startSessionHost({ bootstrap, game,
    createBusiness: options => require('./session-business-runtime').createSessionBusinessRuntime(options),
    validateTarget: target => validateBusinessTarget({ target, dataDir: bootstrap.dataDir, hostSourceRoot: bootstrap.sourceRoot }),
    onClose: () => setTimeout(() => process.exit(0), 25),
  });
  for (const message of early) running.receiveMaster(message);
  fs.unlinkSync(file);
  if (revocationRequested) await running.close();
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => running.close().catch(() => process.exit(1)));
}
if (require.main === module) bootstrapHost().catch(() => { process.stderr.write('session_host_start_failed\n'); process.exit(1); });
module.exports = { startSessionHost, ownsKernelLock };
