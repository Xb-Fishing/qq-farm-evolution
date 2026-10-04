'use strict';

/**
 * 自助重新扫码的服务端保存流程。
 *
 * 面板 POST /api/accounts 的扫码保存语义保持不动；这里为服务端守望
 * （浏览器切后台后由服务端完成扫码）抽出同一条受保护的保存链：
 *
 * 2026-10-04 凭据优先重排（授权后农场未登录事故）：已确认的完整长凭据
 * （loginBuffer/access/refresh，仅来自 adapter.peek 的已确认会话，绝不信
 * 「已扫未确认」）先在任何 await 之前同步捕获，并第一时间在既有账号锁内
 * 落盘 + 作废旧 Code/旧任务——后续换码失败、本地扫码会话 5 分钟到期都
 * 不再丢掉这份已确认授权。真实接受扫码（noteAcceptedScan，代次推进）也
 * 以凭据成功落盘为前提，只发生一次（同一会话的并发重复完成在锁上串行化，
 * 孪生完成不再二次推进代次）。
 *
 * 农场 Code 一律用「已持久化的当前凭据」显式 accountId + 独立手动意图键
 * 换发（不依赖已消费/到期的扫码会话，也不与自动保活在途请求共享 Promise）：
 * 完成链与显式「重试登录农场」共用同一条尾部，每次都换全新 Code，绝不假
 * 设旧一次性 Code 仍有效。isCurrent 守卫在每个 await 之后、每个副作用之前
 * 复验，并且作为作用域守卫传入 adapter.getFarmCode（锁内与每次凭据落盘前
 * 复查）——迟到的旧会话/旧重试不能保存、不能换码、不能重启、不能覆盖新
 * 扫码，也不能把新授权的持久检查点改写成或清除成自己的。
 *
 * 持久检查点（wx-login-reminder.scanCheckpoints）绑定真实扫码代次：凭据
 * 落盘后写「授权已保存/登录未收口」，Code 换成且启动提交被接受才收口；
 * 换码临时失败/启动被拒或失败时保留检查点（阶段码 + 短错误）并沿既有
 * scheduleRelogin 挂自动恢复排程（原 intervalMinutes 节奏 + 每日 5 次/
 * 连续失败 3 次的既有预算与退避，只接线不改节奏；预算耗尽即熔断，保留
 * 真实的手动重试入口），显式重试在二维码过期、进程重启后仍可用。启动
 * 结果如实透传（false/排队≠农场在线）。
 */

const adapter = require('./wx-login-adapter');

let providerRef = null;

// 同一会话的并发完成 singleflight：flightKey = accountId|sessionId|owner|openid。
// 判定只认「会话身份」，绝不比对某个凭据字段是否相同——新一轮已确认扫码
// 完全可能返回与上一轮相同的 loginBuffer（但 refresh/access 已更新），按
// buffer 判等会把真实的新扫码误杀成孪生（2026-10-04 反例）。并发孪生在此
// 让位（不重复保存/接受/启动）；顺序重放由真实 adapter 的「会话已消费」
// 拒绝，不引入任何持久元数据。
const inFlightCompletions = new Map();

/** runtime-engine 创建 dataProvider 后绑定，服务端守望复用与面板相同的动作。 */
function bindRescanProvider(provider) {
  providerRef = provider;
}

function readAccount(accountId) {
  const { getAccounts } = require('../models/store');
  const data = getAccounts();
  const accounts = Array.isArray(data && data.accounts) ? data.accounts : [];
  return accounts.find(acc => String(acc && acc.id) === String(accountId)) || null;
}

function ensureAccountMatches(account, ownerName, targetOpenid) {
  if (!account) return '目标账号不存在或已删除';
  if (String(account.username || '') !== ownerName) return '扫码会话与账号属主不匹配';
  if (String(account.wxid || '') !== targetOpenid) {
    return '扫码微信与账号当前绑定的微信不一致，已取消保存（如需换绑请在面板编辑账号）';
  }
  return '';
}

function supersededError() {
  const error = new Error('superseded');
  error.superseded = true;
  return error;
}

/** 短诊断错误：截断到安全长度（不含 token/URL 的原文由调用方拼装）。 */
function shortError(error) {
  return String((error && error.message) || error || '').slice(0, 120);
}

/**
 * 用「已持久化的当前凭据」换发全新农场 Code 并按既有语义启动/重连。
 * 完成链与显式重试共用：重试不再依赖一次性扫码会话，也不得重放 OAuth
 * 确认/重发二维码/推进扫码代次。返回 { ok, started, error?, stage? }；
 * stage 为固定诊断码（无 token/路径/原始报文）。
 *
 * 检查点收口时机：Code 换成且启动提交被接受（startWorker true / 重启提交
 * 或排队）才清除；被拒/异常保留 start_pending 检查点供显式重试。
 */
async function startSavedWxScanAccount({ accountId, provider, reminder, isCurrent, generation }) {
  const key = String(accountId || '');
  const guard = typeof isCurrent === 'function' ? isCurrent : (() => true);
  // 入口守卫：已被更新的扫码/请求取代的重试，不读账号、不发任何原生请求。
  if (!guard()) return { ok: false, superseded: true };
  const runtimeProvider = provider || providerRef;
  if (!key || !runtimeProvider || typeof runtimeProvider.isAccountRunning !== 'function') {
    return { ok: false, error: '服务端尚未接入账号运行时，无法完成登录', stage: 'runtime_missing' };
  }
  const account = readAccount(key);
  const openid = String(account && account.wxid || '');
  const ownerName = String(account && account.username || '').trim();
  if (!account || String(account.platform || '') !== 'wx' || !openid || !account.loginBuffer) {
    return { ok: false, error: '账号缺少已保存的微信凭据，请重新扫码', stage: 'credentials_missing' };
  }
  if (!guard()) return { ok: false, superseded: true };

  const reminderService = reminder
    || require('./wx-login-reminder').getSharedWxLoginReminder();
  // 检查点只更新自己代次的阶段/错误（迟到旧任务不能改写新授权的检查点）；
  // 属主/微信/守卫显式绑定，临界区内复验后才写入/清除。
  const markPending = async (stage, error) => {
    if (!reminderService || typeof reminderService.noteScanCodePending !== 'function') return;
    try {
      await reminderService.noteScanCodePending(key, {
        generation, stage, error: shortError(error),
        owner: ownerName, wxid: openid, guard,
      });
    } catch { /* 状态展示失败不影响主流程 */ }
  };
  const resolveCheckpoint = async () => {
    if (!reminderService || typeof reminderService.noteScanCodeResolved !== 'function') return;
    try {
      await reminderService.noteScanCodeResolved(key, {
        generation, owner: ownerName, wxid: openid, guard,
      });
    } catch { /* 同上 */ }
  };
  // 授权已保存但换码/启动未收口 → 沿既有 scheduleRelogin 挂自动恢复排程
  // （原 intervalMinutes 节奏 + 每日 5 次/连续失败 3 次的既有预算与退避，
  // 只接线不改节奏）。预算耗尽/被熔断/运行时未接线时如实不排，保留真实的
  // 手动「重试登录农场」入口（不重置预算）。成功上线后由 runtime 在
  // 连接态同步时解检查点（那条路径不经过这里）。
  const scheduleRecovery = (reason) => {
    if (!guard()) return;
    try {
      if (typeof runtimeProvider.scheduleRescanRecovery === 'function') {
        runtimeProvider.scheduleRescanRecovery(key, reason);
      }
    } catch { /* 恢复排程失败不影响如实返回 */ }
  };

  // 显式 accountId + 独立手动意图键：不与自动保活在途请求共享 Promise；
  // guard 作为作用域守卫传入（锁内与每次凭据落盘前都会复查）。
  let fresh;
  try {
    fresh = await adapter.getFarmCode(openid, { accountId: key, intentKey: 'rescan', guard });
  } catch (error) {
    if (!guard()) return { ok: false, superseded: true };
    // 凭据已持久化：临时失败保留检查点 + 沿既有重登预算挂自动恢复排程。
    await markPending('code_pending', `换取农场码失败: ${shortError(error)}`);
    scheduleRecovery('code_temporary');
    return { ok: false, retryable: true, stage: 'code_temporary',
      error: `换取农场码失败: ${(error && error.message) || error}` };
  }
  // await 之后先复查守卫再看结果：被取代的旧请求不得据此更新检查点。
  if (!guard() || !fresh || fresh.superseded === true) return { ok: false, superseded: true };
  if (fresh.Success !== true || !(fresh.Data && fresh.Data.code)) {
    const message = String((fresh && fresh.Message) || '未知错误');
    if (adapter.isDefinitiveWxCredentialError(message)) {
      // 授权已被服务端明确拒绝：检查点收口为终态，引导重新扫码，不自动重试。
      await resolveCheckpoint();
      return { ok: false, stage: 'code_definitive',
        error: `换取农场码失败（授权已失效，请重新发送二维码）: ${message}` };
    }
    await markPending('code_pending', `换取农场码失败: ${message}`);
    scheduleRecovery('code_temporary');
    return { ok: false, retryable: true, stage: 'code_temporary', error: `换取农场码失败: ${message}` };
  }
  const freshCode = String(fresh.Data.code);
  if (!guard()) {
    await markPending('code_pending', '');
    return { ok: false, superseded: true };
  }

  // 新 Code 在账号锁内落盘：迟到的旧会话/旧重试不得覆盖新扫码的 Code。
  try {
    await adapter.withAccountCredentialLock(openid, key, () => {
      if (!guard()) throw supersededError();
      const locked = readAccount(key);
      if (!locked || String(locked.wxid || '') !== openid) {
        throw new Error('账号绑定已变化，本次扫码结果已作废');
      }
      const { addOrUpdateAccount } = require('../models/store');
      addOrUpdateAccount({ id: key, code: freshCode });
    });
  } catch (error) {
    if (error && error.superseded) return { ok: false, superseded: true };
    await markPending('code_pending', `保存农场码失败: ${shortError(error)}`);
    scheduleRecovery('code_save_failed');
    return { ok: false, retryable: true, stage: 'code_save_failed', error: (error && error.message) || '保存农场码失败' };
  }

  // 启动/重连前再验一次守卫：迟到的旧会话不能动新的运行态。
  if (!guard()) {
    await markPending('code_pending', '');
    return { ok: false, superseded: true };
  }
  const wasRunning = runtimeProvider.isAccountRunning(key);
  try {
    if (wasRunning) {
      const restarted = await runtimeProvider.restartAccount(key);
      if (!guard()) return { ok: false, superseded: true };
      // literal false = 运行时明确拒绝重启，如实上报并保留检查点（可重试）；
      // undefined = 重启已排队（已提交重连，等旧进程退出后拉起）——提交被
      // 接受即收口检查点，但排队本身不是「农场已在线」。
      if (restarted === false) {
        await markPending('start_pending', '新授权已保存，重新连接账号被拒绝，请在概览检查账号状态');
        scheduleRecovery('restart_refused');
        return { ok: true, started: false, stage: 'restart_refused',
          error: '新授权已保存，重新连接账号被拒绝，请在概览检查账号状态' };
      }
      await resolveCheckpoint();
      return { ok: true, started: true, stage: restarted === true ? 'restart_submitted' : 'restart_queued' };
    }
    if (!guard()) return { ok: false, superseded: true };
    const activated = typeof runtimeProvider.startAccountFromSavedWxCode === 'function'
      ? await runtimeProvider.startAccountFromSavedWxCode(key, freshCode)
      : await runtimeProvider.startAccount(key);
    if (!guard()) return { ok: false, superseded: true };
    if (activated === false) {
      // 保存是事实、启动被拒：检查点保留（start_pending）+ 恢复排程，供重试。
      await markPending('start_pending', '新授权已保存，请在概览检查账号启动状态');
      scheduleRecovery('start_refused');
      return { ok: true, started: false, stage: 'start_refused',
        error: '新授权已保存，请在概览检查账号启动状态' };
    }
    await resolveCheckpoint();
    return { ok: true, started: true, stage: 'start_submitted' };
  } catch (error) {
    if (!guard()) return { ok: false, superseded: true };
    // 保存是事实；启动失败如实带回，不冒充成功启动；检查点保留 + 恢复排程。
    await markPending('start_pending', `凭据已保存，账号启动失败: ${shortError(error)}`);
    scheduleRecovery('start_failed');
    return { ok: true, started: false, stage: 'start_failed',
      error: `凭据已保存，账号启动失败: ${(error && error.message) || error}` };
  }
}

/**
 * 显式「重试登录农场」的落点：授权已持久化（完成链换码临时失败、或启动
 * 失败、或进程重启后从持久检查点恢复）时，用当前凭据再换一次新 Code 并
 * 启动。不重发二维码、不重放 OAuth 确认、不推进扫码代次。
 */
function retrySavedWxScanLogin({ accountId, provider, reminder, isCurrent, generation }) {
  return startSavedWxScanAccount({ accountId, provider, reminder, isCurrent, generation });
}

async function completeOwnedWxRescan({ accountId, sessionId, openid, owner, isCurrent, provider, reminder }) {
  const key = String(accountId || '');
  const sessionKey = String(sessionId || '');
  const targetOpenid = String(openid || '').trim();
  const ownerName = String(owner || '').trim();
  if (!key || !sessionKey || !targetOpenid || !ownerName) {
    return { ok: false, error: '参数不完整', stage: 'bad_request' };
  }
  // 守卫失败 = 已被更新的扫码/请求/删除取代：不写、不存、不启动、不改状态。
  const guard = typeof isCurrent === 'function' ? isCurrent : (() => true);
  if (!guard()) return { ok: false, superseded: true };
  const runtimeProvider = provider || providerRef;
  if (!runtimeProvider || typeof runtimeProvider.isAccountRunning !== 'function') {
    return { ok: false, error: '服务端尚未接入账号运行时，无法完成保存', stage: 'runtime_missing' };
  }

  // 锁前初查：账号仍在、仍属该用户、wxid 未变。后续在锁内再验一次。
  const mismatch = ensureAccountMatches(readAccount(key), ownerName, targetOpenid);
  if (mismatch) return { ok: false, error: mismatch, stage: 'binding_mismatch' };

  // 同步捕获已确认的完整长凭据检查点（peek 只认带 loginBuffer 的已确认会话，
  // 「已扫未确认」不算）。在任何 await 之前完成：后续换码等待/账号锁排队让
  // 本地扫码会话过期，也不能丢掉这份人工确认过的授权。
  const checkpoint = adapter.peekPendingWxInfo(sessionKey, targetOpenid, ownerName);
  if (!checkpoint || !String(checkpoint.loginBuffer || '')) {
    return { ok: false, stage: 'unconfirmed', error: '扫码会话未确认或已过期，请重新扫码' };
  }

  // 第一优先级：在既有账号锁内持久化完整长凭据 + 作废旧 Code（绝不拿旧码
  // 启动新授权）与旧凭据任务 + 消费一次性会话。同一会话的并发完成先经
  // singleflight 让位（见 inFlightCompletions）；保存失败 = 未接受本次扫码
  // （不消费、不假报接受）。
  const flightKey = `${key}|${sessionKey}|${ownerName}|${targetOpenid}`;
  if (inFlightCompletions.has(flightKey)) return { ok: false, superseded: true };
  inFlightCompletions.set(flightKey, true);
  try {
    await adapter.withAccountCredentialLock(targetOpenid, key, () => {
      if (!guard()) throw supersededError();
      const account = readAccount(key);
      const lockedMismatch = ensureAccountMatches(account, ownerName, targetOpenid);
      if (lockedMismatch) throw new Error(lockedMismatch);
      const liveSession = adapter.peekPendingWxInfo(sessionKey, targetOpenid, ownerName);
      // 锁内 fresher peek 仍在就以它为准；会话在排队等锁期间自然到期/被消费
      // 后 peek 不到时，退回入口在任何 await 之前同步捕获的已确认 grant——
      // 排队/TTL 不丢人工确认过的授权。取消/新请求栅栏不因此放宽：guard 与
      // 账号绑定已在锁内复查。
      const grant = liveSession && String(liveSession.loginBuffer || '')
        ? liveSession : checkpoint;
      const { addOrUpdateAccount } = require('../models/store');
      addOrUpdateAccount({
        id: key,
        platform: 'wx',
        wxid: targetOpenid,
        code: '',
        loginBuffer: grant.loginBuffer,
        refreshtoken: grant.refreshtoken,
        accesstoken: grant.accesstoken,
        wxCredentialExpiresAt: grant.wxCredentialExpiresAt,
        wxCredentialExpiresIn: grant.wxCredentialExpiresIn,
        wxRefreshTokenObservedAt: grant.wxRefreshTokenObservedAt,
        wxCredentialLastSuccessAt: grant.wxCredentialLastSuccessAt,
        avatar: grant.avatar || account.avatar || '',
        autoLogin: true,
        wxDefaultsApplied: true,
      });
      if (typeof runtimeProvider.invalidateAccountCredentialTasks === 'function') {
        runtimeProvider.invalidateAccountCredentialTasks(key);
      }
      // 过期会话的 consume 是尽力清理（可能已无效），不作为保存依据。
      adapter.consumePendingWxInfo(sessionKey, targetOpenid, ownerName);
    });
  } catch (error) {
    if (error && error.superseded) return { ok: false, superseded: true };
    return { ok: false, stage: 'credential_save_failed', error: (error && error.message) || '保存扫码凭据失败' };
  } finally {
    inFlightCompletions.delete(flightKey);
  }

  // 凭据已落盘 = 真实接受本次扫码。此后每个副作用之前都复查守卫与账号
  // 绑定：迟到的旧完成不得取消新二维码（noteAcceptedScan 对非当前会话的
  // keepSessionId 完成自会拒收）、不得把新代次的检查点写成自己的。
  if (!guard()) return { ok: false, superseded: true };
  const postLockMismatch = ensureAccountMatches(readAccount(key), ownerName, targetOpenid);
  if (postLockMismatch) {
    return { ok: false, stage: 'binding_mismatch', error: postLockMismatch };
  }
  const reminderService = reminder
    || require('./wx-login-reminder').getSharedWxLoginReminder();
  try { reminderService.noteSessionConsumed(sessionKey, key); } catch { /* 状态展示失败不影响保存 */ }
  // noteAcceptedScan：显式携带属主/微信/守卫绑定，临界区内复验通过才推进
  // 代次并返回新代次；已被更新请求取代则返回 false（不取消新请求、不推进
  // 代次，也不伪报已接受）。
  const accepted = await reminderService.noteAcceptedScan(key, {
    keepSessionId: sessionKey,
    owner: ownerName,
    wxid: targetOpenid,
    guard,
  });
  if (accepted === false) return { ok: false, superseded: true };
  const scanGeneration = Number.isFinite(Number(accepted)) && Number(accepted) > 0
    ? Number(accepted) : undefined;
  if (!guard()) return { ok: false, superseded: true };
  if (typeof reminderService.noteScanCodePending === 'function') {
    try {
      await reminderService.noteScanCodePending(key, {
        generation: scanGeneration, stage: 'code_pending', error: '',
        owner: ownerName, wxid: targetOpenid, guard,
      });
    } catch { /* 检查点写失败不阻断登录 */ }
  }
  if (typeof runtimeProvider.saveAutoCodeRefresh === 'function') {
    if (!guard()) return { ok: false, superseded: true };
    const { getAutoCodeRefresh } = require('../models/store');
    const current = (typeof getAutoCodeRefresh === 'function' ? getAutoCodeRefresh(key) : null) || {};
    try {
      await runtimeProvider.saveAutoCodeRefresh(key, { enabled: true, intervalMinutes: current.intervalMinutes || 60 });
    } catch { /* 调度重挂失败不阻断登录 */ }
  }

  // 从已持久化的当前凭据换发全新 Code 并启动/重连（与显式重试共用尾部）。
  // 临时失败时凭据已安全落盘：持久检查点 + scheduleRescanRecovery 沿既有
  // 重登预算排程自动接管；预算耗尽时保留显式手动重试。
  return startSavedWxScanAccount({
    accountId: key, provider: runtimeProvider, reminder: reminderService,
    isCurrent: guard, generation: scanGeneration,
  });
}

module.exports = { bindRescanProvider, completeOwnedWxRescan, retrySavedWxScanLogin };
