const fetch = require('node-fetch');
const { createScheduler } = require('../services/scheduler');
const wxLoginAdapter = require('../services/wx-login-adapter');

const WX_KEEPALIVE_MIN_MS = 25 * 60000;
const WX_KEEPALIVE_MAX_MS = 35 * 60000;

function nextCredentialKeepaliveDelayMs() {
  return WX_KEEPALIVE_MIN_MS
    + Math.floor(Math.random() * (WX_KEEPALIVE_MAX_MS - WX_KEEPALIVE_MIN_MS + 1));
}

function createAutoCodeRefreshService(deps) {
  const {
    store,
    getAccounts,
    addOrUpdateAccount,
    resolveWorkerControls,
    log,
    addAccountLog,
  } = deps;

  const scheduler = createScheduler('auto_code_refresh');
  const recoveryState = new Map();
  const keepaliveGeneration = new Map();
  const MAX_DAILY_RECOVERIES = 5;
  const MAX_CONSECUTIVE_FAILURES = 3;

  function getRecoveryState(accountId) {
    const date = new Date().toISOString().slice(0, 10);
    const current = recoveryState.get(String(accountId));
    if (!current || current.date !== date) {
      const fresh = { date, attempts: 0, failures: 0 };
      recoveryState.set(String(accountId), fresh);
      return fresh;
    }
    return current;
  }

  function isRecoveryReason(reason) {
    return ['ws_400', 'kickout:', 'ws_reconnect_failed:', 'refresh_failed']
      .some(prefix => String(reason || '').includes(prefix));
  }

  function getTaskName(accountId) {
    return `refresh_${  String(accountId || '')}`;
  }

  function getKeepaliveTaskName(accountId) {
    return `wx_keepalive_${String(accountId || '')}`;
  }

  function findAccount(accountId) {
    const data = getAccounts();
    const accounts = Array.isArray(data && data.accounts) ? data.accounts : [];
    return accounts.find(acc => String(acc.id) === String(accountId));
  }

  function normalizeConfig(accountId) {
    const cfg = store.getAutoCodeRefresh ? store.getAutoCodeRefresh(accountId) : null;
    return {
      enabled: cfg && cfg.enabled === true,
      intervalMinutes: Math.max(1, Math.min(1440, Number(cfg && cfg.intervalMinutes) || 60)),
    };
  }

  function getWxConfig() {
    return store.getGlobalWxConfig ? store.getGlobalWxConfig() : {};
  }

  async function requestFarmCode(account, wxConfig) {
    const wxid = String(account && account.wxid || '').trim();
    if (!wxid) throw new Error('账号缺少 wxid，无法自动刷新 Code');

    const apiKey = String(wxConfig.apiKey || '').trim();
    const appId = String(wxConfig.appId || 'wx5306c5978fdb76e4').trim();

    // 先直接用当前 loginBuffer 换短时效 Code。issueFarmCode 自己会在
    // ManualAuth rejected 时才尝试 refreshtoken 续期；不要每次启动/恢复前强制
    // 刷 loginBuffer，否则刷新端偶发 40188 会挡住仍然有效的现有凭证。
    if (account.loginBuffer) {
      const local = await wxLoginAdapter.getFarmCode(wxid, { accountId: account.id });
      if (local.Success && local.Data && local.Data.code) return String(local.Data.code);
      throw new Error(local.Message || '进程内获取 Code 失败');
    }

    if (apiKey) {
      const proxyApiUrl = String(wxConfig.proxyApiUrl || 'https://code.z74d.top/api').trim();
      const targetUrl = `${proxyApiUrl  }?api_key=${  encodeURIComponent(apiKey)  }&action=jslogin`;
      const response = await fetch(targetUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wxid, appid: appId }),
      });
      const data = await response.json();
      if (data && data.code === 0 && data.data && data.data.code) return String(data.data.code);
      throw new Error(data && data.msg ? data.msg : '代理获取 Code 失败');
    }

    const apiBase = String(wxConfig.apiBase || 'https://code.z74d.top/api').trim();
    const response = await fetch(`${apiBase  }/Wxapp/JSLogin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ Wxid: wxid, Appid: appId }),
    });
    const data = await response.json();
    if (data && data.Success && data.Data && data.Data.code) return String(data.Data.code);
    const msg = data && data.Data && data.Data.jsapiBaseresponse && data.Data.jsapiBaseresponse.errmsg
      ? data.Data.jsapiBaseresponse.errmsg
      : data && data.Message ? data.Message : '获取 Code 失败';
    throw new Error(msg);
  }

  async function refreshAccountCode(accountId, reason = 'timer') {
    const account = findAccount(accountId);
    if (!account) return false;
    if (store.isAccountAutoLogin && !store.isAccountAutoLogin(account) && reason !== 'manual_start') {
      return false;
    }

    const recovery = isRecoveryReason(reason) ? getRecoveryState(accountId) : null;
    if (recovery && (recovery.attempts >= MAX_DAILY_RECOVERIES
      || recovery.failures >= MAX_CONSECUTIVE_FAILURES)) {
      addAccountLog('auto_relogin_blocked', '自动重登已熔断，请检查网络或重新扫码',
        account.id, account.name, { reason, ...recovery });
      return false;
    }
    if (recovery) recovery.attempts += 1;

    const wxConfig = getWxConfig();
    if (wxConfig.enabled === false && !account.loginBuffer) {
      log('系统', '自动刷新 Code 跳过: 微信登录未启用', {
        accountId: String(accountId),
        accountName: account.name,
      });
      return false;
    }

    try {
      const code = await requestFarmCode(account, wxConfig);
      const nextAccount = { ...account, code };
      addOrUpdateAccount(nextAccount);

      const controls = typeof resolveWorkerControls === 'function' ? (resolveWorkerControls() || {}) : {};
      if (typeof controls.restartWorker === 'function') controls.restartWorker(nextAccount);

      addAccountLog('auto_code_refresh', `自动刷新 Code 成功，已重启账号: ${  account.name}`,
        account.id, account.name, { reason });
      log('系统', `自动刷新 Code 成功: ${  account.name}`, {
        accountId: String(account.id),
        accountName: account.name,
      });
      if (recovery) recovery.failures = 0;
      return true;
    } catch (err) {
      if (recovery) recovery.failures += 1;
      addAccountLog('auto_code_refresh_failed', `自动刷新 Code 失败: ${  err.message}`,
        account.id, account.name, { reason });
      log('错误', `自动刷新 Code 失败: ${  account.name  } - ${  err.message}`, {
        accountId: String(account.id),
        accountName: account.name,
      });
      return false;
    }
  }

  function scheduleAccount(accountId) {
    const accountKey = String(accountId || '');
    const generation = (keepaliveGeneration.get(accountKey) || 0) + 1;
    keepaliveGeneration.set(accountKey, generation);
    const cfg = normalizeConfig(accountId);
    const taskName = getTaskName(accountId);
    scheduler.clear(taskName);
    scheduler.clear(getKeepaliveTaskName(accountId));
    // 手动/自动启动账号时，取消待执行的被踢接管倒计时，避免稍后多余的重启
    scheduler.clear(`relogin_${String(accountId || '')}`);

    const account = findAccount(accountId);
    if (account && store.isAccountAutoLogin && !store.isAccountAutoLogin(account)) {
      return;
    }
    if (!account || !String(account.wxid || '').trim()) {
      log('系统', '自动刷新 Code 未启动: 账号缺少 wxid', {
        accountId: String(accountId),
        accountName: account && account.name || '',
      });
      return;
    }

    if (account.loginBuffer && account.refreshtoken) {
      const scheduleNextKeepalive = () => {
        if (keepaliveGeneration.get(accountKey) !== generation) return;
        scheduler.setTimeoutTask(getKeepaliveTaskName(accountId), nextCredentialKeepaliveDelayMs(), async () => {
          if (keepaliveGeneration.get(accountKey) !== generation) return;
          const latest = findAccount(accountId);
          if (!latest) return;
          try {
            const result = await wxLoginAdapter.keepWxCredentialAlive(latest);
            if (!result.Success) {
              log('错误', `微信凭证保活失败（当前游戏连接不重启）: ${latest.name} - ${result.Message || '未知错误'}`, {
                accountId: String(accountId), accountName: latest.name,
              });
            }
          } finally {
            // 滚动凭据保活只更新 loginBuffer/token，不换游戏 Code、不重启在线 Worker。
            scheduleNextKeepalive();
          }
        });
      };
      scheduleNextKeepalive();
      log('系统', `微信登录凭据保活已启用: ${account.name}，约 25-35 分钟一次（在线不换 Code）`, {
        accountId: String(accountId), accountName: account.name,
      });
    }

    // 旧版在这里每隔 intervalMinutes 主动换 Code 并重启 Worker，会人为制造周期掉线。
    // 现在该配置只控制真实断线后的自动恢复间隔；在线会话只走上面的凭据保活。
    if (cfg.enabled) {
      log('系统', `断线自动恢复已启用: ${account.name}，失败后约 ${cfg.intervalMinutes} 分钟重试`, {
        accountId: String(accountId),
        accountName: account.name,
      });
    }
  }

  function rescheduleAll() {
    scheduler.clearAll();
    const data = getAccounts();
    const accounts = Array.isArray(data && data.accounts) ? data.accounts : [];
    for (const account of accounts) {
      scheduleAccount(account.id);
    }
  }

  function stopAccount(accountId) {
    const accountKey = String(accountId || '');
    keepaliveGeneration.set(accountKey, (keepaliveGeneration.get(accountKey) || 0) + 1);
    scheduler.clear(getTaskName(accountId));
    scheduler.clear(getKeepaliveTaskName(accountId));
    scheduler.clear(`relogin_${String(accountId || '')}`);
  }

  // ── 被踢下线后的接管监控 ──
  // 协议上无法被动感知"另一端已退出"，只能定时重登试探。
  // 退避递增：5min → 30min → 1h → 3h → 3h…（同一天内累计，防反复顶号拉锯）
  const KICKOUT_BACKOFF_STEPS_MS = [
    5 * 60000,
    30 * 60000,
    60 * 60000,
    3 * 60 * 60000,
  ];

  function kickoutBackoffMs(attemptIndex) {
    const idx = Math.max(0, Number(attemptIndex) || 0);
    const step = Math.min(idx, KICKOUT_BACKOFF_STEPS_MS.length - 1);
    return KICKOUT_BACKOFF_STEPS_MS[step];
  }

  /** 自定义重登延迟是否生效：设置了延迟且在有效期内（有效期留空 = 一直生效直到手动清除） */
  function isKickoutOverrideActive(cfg, now = Date.now()) {
    const delayMinutes = Number(cfg && cfg.delayMinutes) || 0;
    if (delayMinutes <= 0) return false;
    const validUntilRaw = String(cfg && cfg.validUntil || '').trim();
    if (!validUntilRaw) return true;
    const validUntilTs = Date.parse(validUntilRaw);
    return Number.isFinite(validUntilTs) && validUntilTs > now;
  }

  /**
   * 计算被踢后重登延迟：自定义生效时用自定义值，否则默认递增退避。
   * @param {{ delayMinutes?: number, validUntil?: string }} cfg
   * @param {number} attemptIndex 已发生的接管次数
   * @param {number} now 当前时间戳（便于测试注入）
   */
  function resolveKickoutDelayMs(cfg, attemptIndex, now = Date.now()) {
    return isKickoutOverrideActive(cfg, now)
      ? Number(cfg.delayMinutes) * 60000
      : kickoutBackoffMs(attemptIndex);
  }

  function formatBackoff(ms) {
    const min = Math.round(ms / 60000);
    return min >= 60 ? `${Math.round((min / 60) * 10) / 10} 小时` : `${min} 分钟`;
  }

  /**
   * 被其他终端踢下线后的自动接管调度。
   * @param {string} accountId
   * @param {string} reason
   * @param {number} sessionMs 被踢前本次会话持续时长（毫秒，仅用于日志）
   * @returns {boolean} 是否已排程
   */
  function scheduleKickoutRelogin(accountId, reason = 'kickout', sessionMs = 0) {
    const account = findAccount(accountId);
    if (!account || !account.loginBuffer) return false;
    if (store.isAccountAutoLogin && !store.isAccountAutoLogin(account)) return false;
    const recovery = getRecoveryState(accountId);
    if (recovery.attempts >= MAX_DAILY_RECOVERIES
      || recovery.failures >= MAX_CONSECUTIVE_FAILURES) {
      return false; // 交给调用方走原 scheduleRelogin（含熔断提示）
    }

    const key = String(accountId);
    // attempts 是已发起的接管次数（本次尚未计入）；默认第 1 次退 5 分钟逐级拉长，
    // 面板设置了自定义延迟且在有效期内则固定用自定义值
    const kickCfg = typeof store.getKickoutRelogin === 'function' ? store.getKickoutRelogin(accountId) : null;
    const customActive = isKickoutOverrideActive(kickCfg);
    const delayMs = resolveKickoutDelayMs(kickCfg, recovery.attempts);
    const delayDesc = `${customActive ? '自定义 ' : ''}${formatBackoff(delayMs)}`;

    const taskName = `relogin_${key}`;
    scheduler.clear(taskName);
    scheduler.setTimeoutTask(taskName, delayMs, () => {
      refreshAccountCode(accountId, reason);
    });
    log('系统', `账号 ${account.name} 被其他终端登录踢下线，${delayDesc}后自动尝试接管（今日第 ${recovery.attempts + 1} 次）`, {
      accountId: key, accountName: account.name, reason,
      sessionMs, delayMs, attempt: recovery.attempts + 1, custom: customActive,
    });
    addAccountLog('kickout_relogin_scheduled',
      `被踢下线，${delayDesc}后自动尝试接管（今日第 ${recovery.attempts + 1} 次）`,
      account.id, account.name, { reason, sessionMs, delayMs, attempt: recovery.attempts + 1, custom: customActive });
    return true;
  }

  function scheduleRelogin(accountId, reason = 'offline') {
    const cfg = normalizeConfig(accountId);
    if (!cfg.enabled) return false;
    const account = findAccount(accountId);
    if (!account || !account.loginBuffer) return false;
    if (store.isAccountAutoLogin && !store.isAccountAutoLogin(account)) return false;
    const recovery = getRecoveryState(accountId);
    if (recovery.attempts >= MAX_DAILY_RECOVERIES
      || recovery.failures >= MAX_CONSECUTIVE_FAILURES) {
      addAccountLog('auto_relogin_blocked', '自动重登次数已达上限，请检查网络或重新扫码',
        account.id, account.name, { reason, ...recovery });
      return false;
    }
    const taskName = `relogin_${String(accountId || '')}`;
    scheduler.clear(taskName);
    scheduler.setTimeoutTask(taskName, cfg.intervalMinutes * 60000, () => {
      refreshAccountCode(accountId, reason);
    });
    log('系统', `账号 ${account.name} 将在 ${cfg.intervalMinutes} 分钟后自动刷新凭证并重登`, {
      accountId: String(accountId), accountName: account.name, reason,
    });
    return true;
  }

  return {
    refreshAccountCode,
    scheduleAccount,
    rescheduleAll,
    stopAccount,
    scheduleRelogin,
    scheduleKickoutRelogin,
    isKickoutOverrideActive,
    resolveKickoutDelayMs,
  };
}

module.exports = {
  createAutoCodeRefreshService,
  nextCredentialKeepaliveDelayMs,
  WX_KEEPALIVE_MIN_MS,
  WX_KEEPALIVE_MAX_MS,
};
