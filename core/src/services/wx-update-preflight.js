const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PREFLIGHT_REASONS = Object.freeze({
  cancelled: '更新准备已取消，当前服务保留',
  unavailable: '微信账号暂时无法重新登录，当前连接保留',
  account_changed: '账号或凭据已变更，本次更新准备作废',
  unknown_connection: '微信连接状态尚未确认，当前服务保留',
  expired: '登录交接记录已过期，当前服务保留',
  timeout: '微信登录准备超时，当前服务保留',
  disconnected: '更新准备通道已断开，当前服务保留',
  rejected: '微信登录交接校验未通过，当前服务保留',
  legacy: '旧运行版本无法交接在线或未知的微信连接，当前服务保留',
});
function preflightError(code) {
  const reasonCode = Object.hasOwn(PREFLIGHT_REASONS, code) ? code : 'rejected';
  return Object.assign(new Error(PREFLIGHT_REASONS[reasonCode]), { wxUpdateReason: reasonCode });
}

function requestParent(processRef, request, timeoutMs = 35000) {
  return new Promise((resolve, reject) => {
    let timer;
    const clear = () => { clearTimeout(timer); processRef.off('message', onMessage); processRef.off('disconnect', onDisconnect); };
    const fail = (code) => {
      clear();
      if (processRef.connected !== false) {
        try { processRef.send({ ...request, type: 'wx_restart_cancel' }, () => {}); } catch { /* disconnected */ }
      }
      reject(preflightError(code));
    };
    const onDisconnect = () => fail('disconnected');
    const onMessage = message => {
      if (message?.type !== 'wx_restart_response' || message.requestId !== request.requestId
        || message.action !== request.action || message.nonce !== request.nonce
        || message.targetCommit !== request.targetCommit) return;
      if (message.ok !== true) return fail(message.reasonCode);
      clear(); resolve(message);
    };
    processRef.on('message', onMessage); processRef.once('disconnect', onDisconnect);
    timer = setTimeout(() => fail('timeout'), timeoutMs);
    try { processRef.send(request, error => { if (error) fail('disconnected'); }); } catch { fail('disconnected'); }
  });
}

// Legacy initial migration has no IPC. Prove through the authenticated live
// provider that it will not terminate a working WX connection; unknown fails closed.
async function legacyHasNoLiveWx({ dataDir, adminPort, fetchImpl = fetch }) {
  let accounts;
  try { accounts = JSON.parse(fs.readFileSync(path.join(dataDir, 'accounts.json'), 'utf8')).accounts; }
  catch (error) { if (error.code === 'ENOENT') return true; return false; }
  if (!Array.isArray(accounts)) return false;
  const wx = accounts.filter(a => a?.platform === 'wx');
  if (!wx.length) return true;
  try {
    const sessions = JSON.parse(fs.readFileSync(path.join(dataDir, 'admin-sessions.json'), 'utf8'));
    const session = sessions.findLast(s => ['admin', 'super_admin'].includes(s.user?.role)
      && (!s.expiresAt || Number(s.expiresAt) > Date.now()));
    if (!session?.token) return false;
    for (const account of wx) {
      const response = await fetchImpl(`http://127.0.0.1:${adminPort}/api/status`, {
        headers: { 'x-admin-token': session.token, 'x-account-id': String(account.id) }, signal: AbortSignal.timeout(10000),
      });
      const body = await response.json();
      if (!response.ok || body.ok !== true || body.data?.connection?.connected !== false) return false;
    }
    return true;
  } catch { return false; }
}

async function prepareUpdatePreflight({ processRef = process, targetCommit, oldPid, oldStartTicks,
  dataDir, adminPort, timeoutMs }) {
  if (!processRef.connected || typeof processRef.send !== 'function') {
    if (!await legacyHasNoLiveWx({ dataDir, adminPort }))
      throw preflightError('legacy');
    return { file: '', env: {}, validate: () => legacyHasNoLiveWx({ dataDir, adminPort }) };
  }
  const nonce = crypto.randomUUID();
  const request = action => ({ type: 'wx_restart_request', action, nonce, targetCommit, oldPid, oldStartTicks,
    requestId: crypto.randomUUID() });
  const prepared = await requestParent(processRef, request('prepare'), timeoutMs);
  const handoff = prepared.handoff;
  const now = Date.now();
  if (!handoff || handoff.version !== 1 || handoff.nonce !== nonce || handoff.targetCommit !== targetCommit
    || handoff.oldPid !== oldPid || handoff.oldStartTicks !== oldStartTicks || !Array.isArray(handoff.accounts)
    || handoff.createdAt > now + 1000 || handoff.expiresAt <= now || handoff.expiresAt > handoff.createdAt + 90000)
    throw preflightError('expired');
  const directory = path.join(dataDir, 'wx-restart-handoffs');
  if (fs.existsSync(directory) && fs.lstatSync(directory).isSymbolicLink()) throw new Error('交接目录不可用');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (fs.realpathSync(directory) !== path.resolve(directory)) throw new Error('交接目录不可用');
  const file = path.join(directory, `${nonce}.json`);
  fs.writeFileSync(file, JSON.stringify(handoff), { mode: 0o600, flag: 'wx' });
  return { file, env: { FARM_WX_RESTART_HANDOFF_FILE: file, FARM_WX_RESTART_TARGET_COMMIT: targetCommit,
    FARM_WX_RESTART_NONCE: nonce },
  validate: async () => {
    if (handoff.expiresAt <= Date.now()) throw preflightError('expired');
    const response = await requestParent(processRef, { ...request('validate'), handoff }, timeoutMs);
    if (handoff.expiresAt <= Date.now()) throw preflightError('expired');
    return response.ok === true;
  } };
}

module.exports = { prepareUpdatePreflight, legacyHasNoLiveWx, requestParent, PREFLIGHT_REASONS, preflightError };
