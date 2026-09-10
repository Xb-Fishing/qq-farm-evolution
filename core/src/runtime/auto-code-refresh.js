const fetch = require('node-fetch');
const { createScheduler } = require('../services/scheduler');
const wxLoginAdapter = require('../services/wx-login-adapter');

const WX_KEEPALIVE_AHEAD_MIN_MS = 35 * 60000;
const WX_KEEPALIVE_AHEAD_MAX_MS = 45 * 60000;
const WX_KEEPALIVE_MIGRATION_MIN_MS = 2000;
const WX_KEEPALIVE_MIGRATION_MAX_MS = 8000;
const WX_KEEPALIVE_RETRY_BASE_MS = 5 * 60000;
const WX_KEEPALIVE_RETRY_MAX_MS = 20 * 60000;
const WX_KEEPALIVE_TERMINAL_RECHECK_MS = 6 * 60 * 60000;

function randomDelayBetween(minMs, maxMs, random = Math.random) {
  const low = Math.max(0, Math.floor(Number(minMs) || 0));
  const high = Math.max(low, Math.floor(Number(maxMs) || low));
  return low + Math.floor(random() * (high - low + 1));
}

/**
 * 按服务端 expires_in 提前 35-45 分钟续期。旧账号没有有效期时只迁移一次；
 * 临时失败用受控退避补刷，明确失效则低频复查，避免刷新风暴。
 */
function nextCredentialKeepaliveDelayMs(account = {}, options = {}) {
  const reason = String(options.reason || 'normal');
  const random = typeof options.random === 'function' ? options.random : Math.random;
  if (reason === 'retry') {
    const failures = Math.max(1, Number(options.failureCount) || 1);
    const base = Math.min(WX_KEEPALIVE_RETRY_MAX_MS,
      WX_KEEPALIVE_RETRY_BASE_MS * (2 ** Math.min(2, failures - 1)));
    return base + randomDelayBetween(0, 60000, random);
  }
  if (reason === 'definitive') {
    return WX_KEEPALIVE_TERMINAL_RECHECK_MS + randomDelayBetween(0, 30 * 60000, random);
  }

  const now = Number(options.now) || Date.now();
  const expiresAt = Number(account && account.wxCredentialExpiresAt) || 0;
  if (expiresAt <= 0) {
    return randomDelayBetween(WX_KEEPALIVE_MIGRATION_MIN_MS, WX_KEEPALIVE_MIGRATION_MAX_MS, random);
  }
  const ahead = randomDelayBetween(WX_KEEPALIVE_AHEAD_MIN_MS, WX_KEEPALIVE_AHEAD_MAX_MS, random);
  const delay = expiresAt - now - ahead;
  return delay > 0
    ? Math.floor(delay)
    : randomDelayBetween(WX_KEEPALIVE_MIGRATION_MIN_MS, WX_KEEPALIVE_MIGRATION_MAX_MS, random);
}

function recordEvolutionIssue(type, level) {
  try {
    require('../services/evolution-issue-inbox').recordRuntimeIssue(type, level);
  } catch { /* 进化线索记录失败不能影响登录或保活 */ }
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
  const keepCredentialAlive = typeof deps.keepWxCredentialAlive === 'function'
    ? deps.keepWxCredentialAlive
    : wxLoginAdapter.keepWxCredentialAlive;
  const getCredentialKeepaliveDelayMs = typeof deps.getCredentialKeepaliveDelayMs === 'function'
    ? deps.getCredentialKeepaliveDelayMs
    : nextCredentialKeepaliveDelayMs;

  const scheduler = createScheduler('auto_code_refresh');
  const recoveryState = new Map();
  const keepaliveGeneration = new Map();
  const definitiveCredentialFailures = new Map();
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

  function isDefinitiveCredentialFailure(error) {
    return typeof wxLoginAdapter.isDefinitiveWxCredentialError === 'function'
      && wxLoginAdapter.isDefinitiveWxCredentialError(error && error.message ? error.message : error);
  }

  function isCredentialBlocked(accountId) {
    const blockedToken = definitiveCredentialFailures.get(String(accountId || ''));
    if (!blockedToken) return false;
    const account = findAccount(accountId);
    if (!account || String(account.refreshtoken || '') === blockedToken) return true;
    definitiveCredentialFailures.delete(String(accountId || ''));
    return false;
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
    let account = findAccount(accountId);
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
      // Bot 停止超过一个凭据周期后，不能先拿已经过期的 loginBuffer 去启动
      // Worker。先滚动长凭据，成功后再申请游戏 Code，确保重启跨日也不需要扫码。
      const expiresAt = Number(account.wxCredentialExpiresAt) || 0;
      const credentialNearExpiry = expiresAt <= 0 || expiresAt <= Date.now() + WX_KEEPALIVE_AHEAD_MAX_MS;
      if (credentialNearExpiry && account.loginBuffer && account.refreshtoken) {
        const keptAlive = await keepCredentialAlive(account);
        if (keptAlive && keptAlive.Success) account = findAccount(accountId) || account;
      }
      const code = await requestFarmCode(account, wxConfig);
      // 只写本轮生成的 Code；断线保活可能刚刚滚动过 loginBuffer/token，
      // 不能用函数开头读取的旧 account 快照把新长凭据覆盖回去。
      addOrUpdateAccount({ id: account.id, code });
      const nextAccount = findAccount(accountId) || { ...account, code };

      const controls = typeof resolveWorkerControls === 'function' ? (resolveWorkerControls() || {}) : {};
      if (typeof controls.restartWorker === 'function') controls.restartWorker(nextAccount);

      addAccountLog('auto_code_refresh', `自动刷新 Code 成功，已重启账号: ${  account.name}`,
        account.id, account.name, { reason });
      log('系统', `自动刷新 Code 成功: ${  account.name}`, {
        accountId: String(account.id),
        accountName: account.name,
      });
      if (recovery) recovery.failures = 0;
      definitiveCredentialFailures.delete(String(accountId));
      return true;
    } catch (err) {
      if (recovery) recovery.failures += 1;
      if (isDefinitiveCredentialFailure(err)) {
        definitiveCredentialFailures.set(String(accountId), String(account.refreshtoken || ''));
        addAccountLog('auto_relogin_blocked', '微信授权已明确失效，请重新扫码后再继续自动登录',
          account.id, account.name, { reason });
      }
      recordEvolutionIssue('code_refresh_failed', 'error');
      addAccountLog('auto_code_refresh_failed', `自动刷新 Code 失败: ${  err.message}`,
        account.id, account.name, { reason });
      log('错误', `自动刷新 Code 失败: ${  account.name  } - ${  err.message}`, {
        accountId: String(account.id),
        accountName: account.name,
      });
      return false;
    }
  }

  /**
   * 持续滚动微信长凭据；只更新 loginBuffer/token，不申请游戏 Code、不启动 Worker。
   * mode 仅用于日志区分在线和断线等待；两种状态都按持久化的服务端有效期续期。
   */
  function armCredentialKeepalive(accountId, generation, mode = 'online') {
    const accountKey = String(accountId || '');
    const taskName = getKeepaliveTaskName(accountId);
    scheduler.clear(taskName);

    const account = findAccount(accountId);
    if (!account || !account.loginBuffer || !account.refreshtoken) return false;
    if (store.isAccountAutoLogin && !store.isAccountAutoLogin(account)) return false;

    let consecutiveFailures = 0;
    const scheduleNextKeepalive = (reason = 'normal') => {
      if (keepaliveGeneration.get(accountKey) !== generation) return;
      const scheduledAccount = findAccount(accountId);
      if (!scheduledAccount || !scheduledAccount.loginBuffer || !scheduledAccount.refreshtoken) return;
      const delayMs = getCredentialKeepaliveDelayMs(scheduledAccount, {
        reason,
        failureCount: consecutiveFailures,
        now: Date.now(),
      });
      scheduler.setTimeoutTask(taskName, delayMs, async () => {
        if (keepaliveGeneration.get(accountKey) !== generation) return;
        const latest = findAccount(accountId);
        if (!latest || !latest.loginBuffer || !latest.refreshtoken) return;
        let nextReason = 'normal';
        try {
          const result = await keepCredentialAlive(latest);
          if (!result.Success) {
            consecutiveFailures += 1;
            nextReason = result.definitive === true ? 'definitive' : 'retry';
            recordEvolutionIssue('credential_keepalive_failed', 'warn');
            const stateLabel = mode === 'offline' ? '断线等待期间' : '当前游戏连接不重启';
            log('错误', `微信凭证保活失败（${stateLabel}）: ${latest.name} - ${result.Message || '未知错误'}`, {
              accountId: accountKey, accountName: latest.name,
            });
          } else {
            consecutiveFailures = 0;
          }
        } catch {
          consecutiveFailures += 1;
          nextReason = 'retry';
          recordEvolutionIssue('credential_keepalive_failed', 'warn');
          log('错误', `微信凭证保活异常（将受控重试）: ${latest.name}`, {
            accountId: accountKey, accountName: latest.name,
          });
        } finally {
          // 明确失效（如 40188 invalid scope）只能由重新扫码恢复，停止定时器，
          // 避免每隔数小时重复请求同一份已终止授权。重新扫码后 scheduleAccount
          // 会用新凭据重新挂载保活。
          if (nextReason !== 'definitive') scheduleNextKeepalive(nextReason);
        }
      });
    };

    scheduleNextKeepalive();
    const modeLabel = mode === 'offline' ? '断线等待保活' : '在线保活';
    log('系统', `微信登录凭据${modeLabel}已启用: ${account.name}，按有效期提前 35-45 分钟续期（不换游戏 Code）`, {
      accountId: accountKey, accountName: account.name, mode,
    });
    return true;
  }

  function armOfflineCredentialKeepalive(accountId) {
    const accountKey = String(accountId || '');
    const generation = (keepaliveGeneration.get(accountKey) || 0) + 1;
    keepaliveGeneration.set(accountKey, generation);
    return armCredentialKeepalive(accountId, generation, 'offline');
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

    armCredentialKeepalive(accountId, generation, 'online');

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
      Promise.resolve(refreshAccountCode(accountId, reason)).then((ok) => {
        // 换 Code 失败时不能把这次定时任务消费掉，否则账号会永久停在离线状态。
        // 由统一熔断规则决定是否继续排程，成功后 startWorker 会清理旧任务。
        if (!ok && !isCredentialBlocked(accountId)) scheduleKickoutRelogin(accountId, reason, sessionMs);
      }).catch(() => {
        if (!isCredentialBlocked(accountId)) scheduleKickoutRelogin(accountId, reason, sessionMs);
      });
    });
    // stopWorker 会先清理在线保活；等待接管期间必须立即重新挂载长凭据保活，
    // 但不能提前申请游戏 Code 或启动 Worker。
    armOfflineCredentialKeepalive(accountId);
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
      Promise.resolve(refreshAccountCode(accountId, reason)).then((ok) => {
        // 失败后继续按原间隔排程，直到每日/连续失败熔断；成功后由
        // scheduleAccount 清掉该任务并重新挂载在线保活。
        if (!ok && !isCredentialBlocked(accountId)) scheduleRelogin(accountId, reason);
      }).catch(() => {
        if (!isCredentialBlocked(accountId)) scheduleRelogin(accountId, reason);
      });
    });
    armOfflineCredentialKeepalive(accountId);
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
  WX_KEEPALIVE_AHEAD_MIN_MS,
  WX_KEEPALIVE_AHEAD_MAX_MS,
  WX_KEEPALIVE_MIGRATION_MIN_MS,
  WX_KEEPALIVE_MIGRATION_MAX_MS,
  WX_KEEPALIVE_RETRY_BASE_MS,
  WX_KEEPALIVE_RETRY_MAX_MS,
  WX_KEEPALIVE_TERMINAL_RECHECK_MS,
};
