'use strict';

/**
 * 自助重新扫码的服务端保存流程。
 *
 * 面板 POST /api/accounts 的扫码保存语义保持不动；这里为服务端守望
 * （浏览器切后台后由服务端完成扫码）抽出同一条受保护的保存链：
 * wxid 必须匹配目标账号 → 先用属主扫码会话换发新农场 code（账号锁外，
 * 同面板 jslogin 流程）→ 账号锁内重读会话并保存完整长凭据与新 code →
 * 失效旧凭据任务代次 → 持久化成功后才消费会话 → 按既有重扫语义启动/替换。
 * isCurrent 守卫在换码前/换码后/锁内落盘前/启动前各验一次，迟到的旧
 * 会话不能保存、不能重启、不能覆盖新扫码。不绕过也不复制凭据保护，
 * 全部复用 wx-login-adapter 的原语。
 */

const adapter = require('./wx-login-adapter');

let providerRef = null;

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

async function completeOwnedWxRescan({ accountId, sessionId, openid, owner, isCurrent, provider, reminder }) {
  const key = String(accountId || '');
  const sessionKey = String(sessionId || '');
  const targetOpenid = String(openid || '').trim();
  const ownerName = String(owner || '').trim();
  if (!key || !sessionKey || !targetOpenid || !ownerName) {
    return { ok: false, error: '参数不完整' };
  }
  // 守卫失败 = 已被更新的扫码/请求/删除取代：不写、不存、不启动、不改状态。
  const guard = typeof isCurrent === 'function' ? isCurrent : (() => true);
  const runtimeProvider = provider || providerRef;
  if (!runtimeProvider || typeof runtimeProvider.isAccountRunning !== 'function') {
    return { ok: false, error: '服务端尚未接入账号运行时，无法完成保存' };
  }
  if (!guard()) return { ok: false, superseded: true };

  // 锁前初查：账号仍在、仍属该用户、wxid 未变。后续在锁内再验一次。
  const mismatch = ensureAccountMatches(readAccount(key), ownerName, targetOpenid);
  if (mismatch) return { ok: false, error: mismatch };

  // 先换发新农场 code（保存的必须是新 code，不能拿账号里的旧 code 重启）。
  // 与面板一致：用属主扫码会话、在账号锁外调用；只尝试一次，临时失败把
  // 已确认的一次性 OAuth 检查点留给显式「重试完成登录」，不自动循环。
  let fresh;
  try {
    fresh = await adapter.getFarmCode(targetOpenid, { sessionId: sessionKey, owner: ownerName });
  } catch (error) {
    return { ok: false, retryable: true, error: `换取农场码失败: ${(error && error.message) || error}` };
  }
  if (!fresh || fresh.Success !== true || !(fresh.Data && fresh.Data.code)) {
    const message = String((fresh && fresh.Message) || '未知错误');
    if (adapter.isDefinitiveWxCredentialError(message)) {
      return { ok: false, error: `换取农场码失败（授权已失效，请重新发送二维码）: ${message}` };
    }
    return { ok: false, retryable: true, error: `换取农场码失败: ${message}` };
  }
  const freshCode = String(fresh.Data.code);
  if (!guard()) return { ok: false, superseded: true };

  let savedAccount = null;
  try {
    savedAccount = await adapter.withAccountCredentialLock(targetOpenid, key, () => {
      if (!guard()) { const supersededError = new Error('superseded'); supersededError.superseded = true; throw supersededError; }
      const account = readAccount(key);
      const lockedMismatch = ensureAccountMatches(account, ownerName, targetOpenid);
      if (lockedMismatch) throw new Error(lockedMismatch);
      // 锁内重读会话：getFarmCode 可能在会话内轮换过凭据，取最新一份。
      const pending = adapter.peekPendingWxInfo(sessionKey, targetOpenid, ownerName);
      if (!pending) throw new Error('扫码会话无效或已过期，请重新扫码');

      const { addOrUpdateAccount } = require('../models/store');
      const saved = addOrUpdateAccount({
        id: key,
        platform: 'wx',
        wxid: targetOpenid,
        code: freshCode,
        loginBuffer: pending.loginBuffer,
        refreshtoken: pending.refreshtoken,
        accesstoken: pending.accesstoken,
        wxCredentialExpiresAt: pending.wxCredentialExpiresAt,
        wxCredentialExpiresIn: pending.wxCredentialExpiresIn,
        wxRefreshTokenObservedAt: pending.wxRefreshTokenObservedAt,
        wxCredentialLastSuccessAt: pending.wxCredentialLastSuccessAt,
        avatar: pending.avatar || account.avatar || '',
        wxDefaultsApplied: true,
      });
      if (typeof runtimeProvider.invalidateAccountCredentialTasks === 'function') {
        // 保存成功、释放锁前拦截旧凭据的迟到异步任务。
        runtimeProvider.invalidateAccountCredentialTasks(key);
      }
      return saved;
    });
  } catch (error) {
    if (error && error.superseded) return { ok: false, superseded: true };
    return { ok: false, error: (error && error.message) || '保存扫码凭据失败' };
  }

  // 持久化成功后才消费一次性会话，避免保存失败后二维码被误吞。
  adapter.consumePendingWxInfo(sessionKey, targetOpenid, ownerName);

  const reminderService = reminder
    || require('./wx-login-reminder').getSharedWxLoginReminder();
  try { reminderService.noteSessionConsumed(sessionKey, key); } catch { /* 状态展示失败不影响保存 */ }
  // 新授权已接受：递增扫码代次并清除待重扫/已提醒状态。
  try { await reminderService.noteAcceptedScan(key, { keepSessionId: sessionKey }); } catch { /* 提醒状态失败不影响保存 */ }

  // 启动/重启前再验一次守卫：迟到的旧会话不能动新的运行态。
  if (!guard()) return { ok: true, started: false, superseded: true, savedAccount };
  const wasRunning = runtimeProvider.isAccountRunning(key);
  try {
    if (wasRunning) {
      await runtimeProvider.restartAccount(key);
    } else {
      if (typeof runtimeProvider.saveAutoCodeRefresh === 'function') {
        await runtimeProvider.saveAutoCodeRefresh(key, { enabled: true, intervalMinutes: 60 });
      }
      if (!guard()) return { ok: true, started: false, superseded: true, savedAccount };
      const activated = typeof runtimeProvider.startAccountFromSavedWxCode === 'function'
        ? await runtimeProvider.startAccountFromSavedWxCode(key, freshCode)
        : await runtimeProvider.startAccount(key);
      if (activated === false) return { ok: true, started: false, error: '新授权已保存，请在概览检查账号启动状态' };
    }
  } catch (error) {
    // 保存是事实；启动失败如实带回，不冒充成功启动。
    return { ok: true, started: false, error: `凭据已保存，账号启动失败: ${(error && error.message) || error}` };
  }
  return { ok: true, started: true, savedAccount };
}

module.exports = { bindRescanProvider, completeOwnedWxRescan };
