const { prepareMengkaNtAccount } = require('./mengka-nt-bridge');

function createLogQuery(query) {
  return {
    limit: Number.parseInt(query.limit) || 100,
    tag: query.tag || "",
    module: query.module || "",
    event: query.event || "",
    keyword: query.keyword || "",
    isWarn: query.isWarn,
    timeFrom: query.timeFrom || "",
    timeTo: query.timeTo || "",
  };
}

function isAdminUser(user) {
  return user && (user.role === "admin" || user.role === "super_admin");
}

function hasWxRefreshIdentity(account) {
  return !!String((account && account.wxid) || "").trim();
}

const PROTECTED_WX_CREDENTIAL_FIELDS = [
  "loginBuffer",
  "refreshtoken",
  "accesstoken",
  "refreshToken",
  "accessToken",
  "wxCredentialExpiresAt",
  "wxCredentialExpiresIn",
  "wxRefreshTokenObservedAt",
  "wxCredentialLastSuccessAt",
];

function stripProtectedWxCredentials(source) {
  const result = { ...(source && typeof source === "object" ? source : {}) };
  for (const field of PROTECTED_WX_CREDENTIAL_FIELDS) delete result[field];
  return result;
}

const CLIENT_VERSION_RE = /^\d+(?:\.\d+){2,4}_\d{8}$/;

function parseOfficialGatewayUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "wss:"
    || url.hostname !== "gate-obt.nqf.qq.com"
    || url.pathname !== "/prod/ws") return null;
  const code = String(url.searchParams.get("code") || "").trim();
  const clientVersion = String(url.searchParams.get("ver") || "").trim();
  if (!code || !CLIENT_VERSION_RE.test(clientVersion)) return null;
  return { code, clientVersion };
}

function syncGatewayClientVersion(gateway, store, updateRuntimeConfig) {
  if (!gateway || !store || typeof store.getSystemConfig !== "function") return false;
  const currentSystemConfig = store.getSystemConfig() || {};
  if (String(currentSystemConfig.clientVersion || "") === gateway.clientVersion) return false;
  const savedSystemConfig = store.setSystemConfig({
    ...currentSystemConfig,
    clientVersion: gateway.clientVersion,
  });
  if (savedSystemConfig && typeof updateRuntimeConfig === "function") {
    updateRuntimeConfig(savedSystemConfig);
  }
  return !!savedSystemConfig;
}

function registerAdminAccountRoutes({
  app,
  provider,
  getIo,
  addOrUpdateAccount,
  deleteAccount,
  findAccountByRef,
  getAccountsForUser,
  getAccountIdFromRequest,
  resolveAccountReference,
  canAccessAccount,
  getAccessibleAccountIdsFromRequest,
  sendProviderError,
  store,
  updateRuntimeConfig,
}) {
  function accountView(req) {
    const currentUser = req.currentUser;
    if (!currentUser) return { accounts: [], nextId: 1 };
    const data = provider.getAccounts();
    const visible = isAdminUser(currentUser) && req.mengkaNtBridge !== true
      ? data.accounts
      : data.accounts.filter(account => account.username === currentUser.username);
    return { ...data, accounts: visible.map(stripProtectedWxCredentials) };
  }

  app.get("/api/accounts", (req, res) => {
    try {
      res.json({ ok: true, data: accountView(req) });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.post("/api/accounts/refresh-wx-codes", async (req, res) => {
    try {
      const currentUser = req.currentUser;
      if (!currentUser) {
        return res.status(401).json({ ok: false, error: "未登录" });
      }
      if (!provider || typeof provider.refreshAccountCode !== "function") {
        return res.status(500).json({ ok: false, error: "自动刷新服务不可用" });
      }

      const allAccounts = getAccountsForUser();
      const accessibleAccounts = isAdminUser(currentUser)
        ? allAccounts
        : allAccounts.filter(
            (account) => account && account.username === currentUser.username,
          );
      const targetAccounts = accessibleAccounts.filter(hasWxRefreshIdentity);

      if (targetAccounts.length === 0) {
        return res.json({
          ok: false,
          error: "没有可刷新的微信账号",
          data: { total: 0, success: 0, failed: 0, skipped: accessibleAccounts.length },
        });
      }

      const results = [];
      for (const account of targetAccounts) {
        try {
          const result = await provider.refreshAccountCode(account.id);
          const success = result && result.ok !== false;
          results.push({
            accountId: account.id,
            name: account.name || account.nick || account.id,
            ok: success,
            error: success ? "" : "刷新失败",
          });
        } catch (error) {
          results.push({
            accountId: account.id,
            name: account.name || account.nick || account.id,
            ok: false,
            error: error.message || "刷新失败",
          });
        }
      }

      const success = results.filter((item) => item.ok).length;
      const failed = results.length - success;
      res.json({
        ok: failed === 0,
        data: {
          total: results.length,
          success,
          failed,
          skipped: accessibleAccounts.length - targetAccounts.length,
          results,
        },
      });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.post("/api/account/remark", (req, res) => {
    try {
      const body = req.body && typeof req.body === "object" ? req.body : {};
      const accountRef =
        body.id || body.accountId || body.uin || req.headers["x-account-id"];
      const account = findAccountByRef(getAccountsForUser(), accountRef);
      const accountId = String(account?.id || "");
      if (!accountId || !canAccessAccount(req, accountId)) {
        return res.status(404).json({ ok: false, error: "Account not found" });
      }

      const remark = String(
        body.remark !== undefined ? body.remark : body.name || "",
      ).trim();
      if (!remark) {
        return res.status(400).json({ ok: false, error: "Missing remark" });
      }

      addOrUpdateAccount({ id: accountId, name: remark });
      if (provider && typeof provider.setRuntimeAccountName === "function") {
        provider.setRuntimeAccountName(accountId, remark);
      }
      if (provider && provider.addAccountLog) {
        provider.addAccountLog("update", `更新账号备注: ${  remark}`, accountId, remark);
      }
      res.json({ ok: true, data: accountView(req) });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.post("/api/accounts", async (req, res) => {
    try {
      const rawBody = req.body && typeof req.body === "object" ? req.body : {};
      let bridgeAccount = null;
      if (req.mengkaNtBridge === true) {
        if (!req.currentUser) return res.status(401).json({ ok: false, error: '未登录' });
        // Authorize before looking up or comparing another account's QQ binding.
        if (rawBody.id && !canAccessAccount(req, resolveAccountReference(rawBody.id))) {
          return res.status(403).json({ ok: false, error: '无权访问此账号' });
        }
        bridgeAccount = prepareMengkaNtAccount(rawBody, getAccountsForUser(), req.currentUser, resolveAccountReference);
        if (bridgeAccount.error) return res.status(bridgeAccount.status).json({ ok: false, error: bridgeAccount.error });
      }
      const body = stripProtectedWxCredentials(bridgeAccount ? bridgeAccount.body : rawBody);
      const gateway = parseOfficialGatewayUrl(body.gatewayUrl);
      if (body.gatewayUrl && !gateway) {
        return res.status(400).json({ ok: false, error: "WebSocket URL 无效或缺少有效的 code/ver" });
      }
      if (gateway) body.code = gateway.code;
      delete body.gatewayUrl;
      const currentUser = req.currentUser;
      const isUpdate = !!body.id;
      const isAdmin = isAdminUser(currentUser);

      if (isUpdate && currentUser && !isAdmin) {
        if (!canAccessAccount(req, resolveAccountReference(body.id))) {
          return res.status(403).json({ ok: false, error: "无权访问此账号" });
        }
        delete body.username;
      }

      const bridgeResponse = state => ({ source: 'mengka_nt', state, startPolicy: 'new_accounts_only' });
      if (bridgeAccount?.existing && bridgeAccount.existing.code === body.code
          && bridgeAccount.existing.name === body.name) {
        return res.json({ ok: true, data: accountView(req), startup: { queued: false, autoRefreshEnabled: false },
          bridge: bridgeResponse('unchanged') });
      }

      const resolvedId = isUpdate ? resolveAccountReference(body.id) : "";
      const nextAccount = isUpdate
        ? { ...body, id: resolvedId || String(body.id) }
        : body;

      const wxScan = Boolean(body.wxSessionId && body.wxid && currentUser && nextAccount.platform === "wx");
      const existingWxScan = isUpdate && wxScan;
      if (body.wxSessionId && (!wxScan || typeof body.code !== "string" || !body.code.trim() || body.code.length > 512)) {
        return res.status(400).json({ ok: false, error: "微信扫码会话或农场登录码无效，请重新扫码" });
      }
      // 扫码凭证只允许由同一登录用户持有的短期会话写入账号。
      if (wxScan) {
        const wxLoginAdapter = require("../services/wx-login-adapter");
        const pending = wxLoginAdapter.peekPendingWxInfo(
          body.wxSessionId,
          body.wxid,
          currentUser.username,
        );
        if (!pending) {
          return res.status(400).json({ ok: false, error: "微信扫码会话无效或已过期，请重新扫码" });
        }
        Object.assign(nextAccount, {
          loginBuffer: pending.loginBuffer,
          refreshtoken: pending.refreshtoken,
          accesstoken: pending.accesstoken,
          wxCredentialExpiresAt: pending.wxCredentialExpiresAt,
          wxCredentialExpiresIn: pending.wxCredentialExpiresIn,
          wxRefreshTokenObservedAt: pending.wxRefreshTokenObservedAt,
          wxCredentialLastSuccessAt: pending.wxCredentialLastSuccessAt,
          avatar: pending.avatar || nextAccount.avatar || "",
          wxDefaultsApplied: true,
        });
      }

      // wxid 换绑后旧账号凭据绝不能继续使用；只有新的扫码会话可以重新写入。
      if (isUpdate) {
        const existing = getAccountsForUser().find(
          (account) => String(account.id) === String(nextAccount.id),
        );
        const wxidChanged = existing
          && Object.hasOwn(body, "wxid")
          && String(existing.wxid || "") !== String(body.wxid || "");
        if (wxidChanged && !body.wxSessionId) {
          Object.assign(nextAccount, {
            loginBuffer: "",
            refreshtoken: "",
            accesstoken: "",
            wxCredentialExpiresAt: 0,
            wxCredentialExpiresIn: 0,
            wxRefreshTokenObservedAt: 0,
            wxCredentialLastSuccessAt: 0,
          });
        }
      }

      let wasRunning = false;
      if (isUpdate && provider.isAccountRunning) {
        wasRunning = provider.isAccountRunning(nextAccount.id);
      }

      let onlyRenaming = false;
      if (isUpdate) {
        const accounts = provider.getAccounts();
        const existing = accounts.accounts.find(
          (account) => account.id === nextAccount.id,
        );
        if (existing) {
          const keys = Object.keys(nextAccount);
          onlyRenaming =
            keys.length === 2 && keys.includes("id") && keys.includes("name");
        }
      }

      if (!isUpdate && currentUser) nextAccount.username = currentUser.username;
      const wxLoginAdapter = require("../services/wx-login-adapter");
      const lookup = id => getAccountsForUser().find(account => String(account.id) === String(id));
      const original = existingWxScan ? lookup(nextAccount.id) : null;
      if (existingWxScan && (!original || original.platform !== "wx" || !canAccessAccount(req, nextAccount.id))) {
        return res.status(original ? 403 : 404).json({ ok: false, error: "无法为此账号保存微信扫码授权" });
      }
      if (existingWxScan) {
        delete nextAccount.username;
        delete nextAccount.autoLogin;
      }
      const originalGeneration = original?.credentialGeneration;
      const originalOwner = original?.username;
      const saveAccount = () => {
        if (bridgeAccount?.existing) {
          const latest = getAccountsForUser().find(account => String(account.id) === String(nextAccount.id));
          if (!latest || latest.platform !== 'qq' || String(latest.qq || latest.uin || '') !== body.qq
              || latest.username !== currentUser.username || !canAccessAccount(req, nextAccount.id)) {
            const error = new Error('账号绑定已变化，请重新读取账号列表后推送');
            error.statusCode = 409;
            throw error;
          }
        }
        if (wxScan) {
          const latest = wxLoginAdapter.peekPendingWxInfo(body.wxSessionId, body.wxid, currentUser.username);
          const current = existingWxScan ? lookup(nextAccount.id) : null;
          if (!latest || (existingWxScan && (!current || current.platform !== "wx" || current.username !== originalOwner
            || current.credentialGeneration !== originalGeneration || !canAccessAccount(req, nextAccount.id)))) {
            const error = new Error("微信扫码会话已过期、已保存或账号已变化，请重新扫码");
            error.statusCode = 409;
            throw error;
          }
          Object.assign(nextAccount, {
            loginBuffer: latest.loginBuffer, refreshtoken: latest.refreshtoken, accesstoken: latest.accesstoken,
            wxCredentialExpiresAt: latest.wxCredentialExpiresAt, wxCredentialExpiresIn: latest.wxCredentialExpiresIn,
            wxRefreshTokenObservedAt: latest.wxRefreshTokenObservedAt, wxCredentialLastSuccessAt: latest.wxCredentialLastSuccessAt,
          });
        }
        if (isUpdate && currentUser && !isAdmin && !bridgeAccount?.existing && !existingWxScan
            && !canAccessAccount(req, nextAccount.id)) {
          const error = new Error("无权访问此账号");
          error.statusCode = 403;
          throw error;
        }
        const saved = addOrUpdateAccount(nextAccount, { newAuthorization: wxScan });
        if (wxScan) wxLoginAdapter.consumePendingWxInfo(body.wxSessionId, body.wxid, currentUser.username);
        if (existingWxScan && typeof provider.invalidateAccountCredentialTasks === "function") {
          // Fence old async completions before the credential lock is released.
          provider.invalidateAccountCredentialTasks(nextAccount.id);
        }
        return saved;
      };
      // Saving new scan credentials must serialize with old in-flight renewal.
      const data = isUpdate
        ? await wxLoginAdapter.withAccountCredentialLock(nextAccount.wxid || '', nextAccount.id, saveAccount)
        : saveAccount();
      const clientVersionUpdated = syncGatewayClientVersion(gateway, store, updateRuntimeConfig);
      const savedScanAccount = existingWxScan ? data.accounts.find(account => String(account.id) === String(nextAccount.id)) : null;
      const scanGeneration = savedScanAccount?.credentialGeneration;
      const isCurrentScan = () => {
        if (!savedScanAccount) return false;
        const current = lookup(nextAccount.id);
        return !!current && current.platform === "wx" && current.username === originalOwner
          && current.wxid === body.wxid && current.code === body.code
          && current.credentialGeneration === scanGeneration
          && canAccessAccount(req, nextAccount.id);
      };
      let reminder;
      let acceptedScanGeneration;
      if (wxScan) {
        const reminderAccountId = isUpdate ? String(nextAccount.id) : String((data.accounts.at(-1) || {}).id || "");
        if (reminderAccountId && (!existingWxScan || isCurrentScan())) {
          try {
            reminder = require("../services/wx-login-reminder").getSharedWxLoginReminder();
            acceptedScanGeneration = await reminder.noteAcceptedScan(reminderAccountId, existingWxScan
              ? { owner: originalOwner, wxid: body.wxid, guard: isCurrentScan } : {});
          } catch { /* 提醒状态更新失败不阻断已保存的扫码 */ }
        }
      }
      if (provider.addAccountLog) {
        const accountId = isUpdate
          ? String(nextAccount.id)
          : String((data.accounts.at(-1) || {}).id || "");
        const name = nextAccount.name || "";
        provider.addAccountLog(
          isUpdate ? "update" : "add",
          (isUpdate ? "更新账号: " : "添加账号: ") + (name || accountId),
          accountId,
          name,
        );
      }

      let autoRefreshEnabled = false;
      let startQueued = false;
      let recoveryQueued = false;
      let retryAvailable = false;
      let startupState;
      if (!isUpdate) {
        const created = data.accounts.at(-1);
        if (created) {
          const isNativeWxScan = created.platform === "wx"
            && created.loginType === "wx_qr"
            && !!body.wxSessionId;
          if (isNativeWxScan && typeof provider.saveAutoCodeRefresh === "function") {
            await provider.saveAutoCodeRefresh(created.id, {
              enabled: true,
              intervalMinutes: 60,
            });
            autoRefreshEnabled = true;
          }
          // 启动微信账号会包含凭证续期和 MMTLS 换 Code，不能阻塞新增账号响应。
          // 账号与刷新策略落盘后立即返回，启动任务在后台继续执行。
          startQueued = true;
          Promise.resolve(provider.startAccount(created.id)).catch((error) => {
            if (provider.addAccountLog) {
              provider.addAccountLog(
                "start_failed",
                `账号 ${created.name || created.id} 后台启动失败: ${error.message || error}`,
                created.id,
                created.name || "",
              );
            }
          });
        }
      } else if (existingWxScan) {
        const held = () => lookup(nextAccount.id)?.autoLogin === false;
        const canStart = () => isCurrentScan() && !held();
        if (!isCurrentScan()) startupState = "superseded";
        else if (held()) startupState = "held_offline";
        else {
          try {
            if (provider.isAccountRunning?.(nextAccount.id)) {
              const restarted = await provider.restartAccount(nextAccount.id, { isCurrent: canStart });
              startQueued = restarted !== false;
            } else {
              if (typeof provider.saveAutoCodeRefresh === "function") {
                await provider.saveAutoCodeRefresh(nextAccount.id, { enabled: true, intervalMinutes: 60 });
                autoRefreshEnabled = true;
              }
              if (isCurrentScan() && !held()) {
                // The panel already exchanged this confirmed scan for a fresh, one-use game code.
                // Launch through the saved-code path instead of trying to refresh it a second time.
                const started = await provider.startAccountFromSavedWxCode?.(nextAccount.id, body.code, scanGeneration);
                startQueued = started === true;
              }
            }
          } catch { /* 已保存的授权必须如实返回，不能当作保存失败重复消费 */ }
          if (!startQueued && canStart() && acceptedScanGeneration) {
            try {
              const checkpoint = await reminder.noteScanCodePending(nextAccount.id, {
                generation: acceptedScanGeneration,
                owner: originalOwner,
                wxid: body.wxid,
                stage: "start_pending",
                error: "微信授权已保存，农场登录提交失败",
                guard: canStart,
              });
              retryAvailable = Boolean(checkpoint);
              if (retryAvailable && canStart()) {
                recoveryQueued = provider.scheduleRescanRecovery?.(nextAccount.id, "start_refused") === true;
              }
            } catch { /* 恢复状态写入失败不改变授权已保存的事实 */ }
          }
          startupState = !isCurrentScan() ? "superseded" : held() ? "held_offline" : startQueued ? "submitted" : "not_started";
          startQueued = startupState === "submitted";
          if (startupState === "not_started") {
            try { provider.addAccountLog?.("start_failed", "新扫码授权已保存，账号启动未提交，请查看登录状态", nextAccount.id, ""); }
            catch { /* 页面仍需要明确的启动结果 */ }
          }
        }
      } else if (wasRunning && !onlyRenaming && !bridgeAccount) {
        await provider.restartAccount(nextAccount.id);
      }

      res.json({
        ok: true,
        data: accountView(req),
        startup: { queued: startQueued, autoRefreshEnabled, ...(startupState && { state: startupState }),
          ...(retryAvailable && startupState === "not_started" && { retryAvailable: true, recoveryQueued }) },
        ...(bridgeAccount ? { bridge: bridgeResponse(isUpdate ? (wasRunning ? 'saved_online' : 'saved_offline') : 'created') } : {}),
        clientVersion: gateway ? gateway.clientVersion : "",
        clientVersionUpdated,
      });
    } catch (error) {
      res.status(error.statusCode || 500).json({ ok: false, error: error.message });
    }
  });

  app.delete("/api/accounts/:id", async (req, res) => {
    try {
      const accountId =
        resolveAccountReference(req.params.id) || String(req.params.id || "");
      if (!canAccessAccount(req, accountId)) {
        return res.status(403).json({ ok: false, error: "无权访问此账号" });
      }

      const accounts = provider.getAccounts();
      const account = findAccountByRef(accounts.accounts || [], req.params.id);
      await provider.stopAccount(accountId);
      deleteAccount(accountId);
      if (provider.addAccountLog) {
        provider.addAccountLog(
          "delete",
          `删除账号: ${  (account && account.name) || req.params.id}`,
          accountId,
          account ? account.name : "",
        );
      }
      res.json({ ok: true, data: accountView(req) });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.get("/api/account-logs", (req, res) => {
    try {
      const limit = Number.parseInt(req.query.limit) || 100;
      const currentUser = req.currentUser;
      const requestedAccountId = getAccountIdFromRequest(req);
      let logs = provider.getAccountLogs ? provider.getAccountLogs(limit) : [];
      if (!Array.isArray(logs)) logs = [];
      if (requestedAccountId) {
        if (!canAccessAccount(req, requestedAccountId)) {
          return res.status(403).json({ ok: false, error: "无权访问此账号" });
        }
        logs = logs.filter((log) => {
          const accountId = String(log.accountId || log.id || "");
          return accountId === requestedAccountId;
        });
      }
      if (currentUser) {
        const accessibleIds = getAccessibleAccountIdsFromRequest(req);
        logs = logs.filter((log) => {
          const accountId = log.accountId || log.id;
          return accessibleIds.includes(accountId);
        });
      }
      res.json(logs);
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.get("/api/logs", (req, res) => {
    const requestedAccountId = (req.query.accountId || "").toString().trim();
    const accountId = requestedAccountId
      ? requestedAccountId === "all"
        ? ""
        : resolveAccountReference(requestedAccountId)
      : getAccountIdFromRequest(req);
    const currentUser = req.currentUser;
    if (!currentUser) {
      return res.status(401).json({ ok: false, error: "未登录" });
    }
    if (accountId && !canAccessAccount(req, accountId)) {
      return res.status(403).json({ ok: false, error: "无权访问此账号" });
    }

    if (!accountId) {
      const accessibleIds = getAccessibleAccountIdsFromRequest(req);
      const mergedLogs = [];
      const query = createLogQuery(req.query);
      for (const accessibleId of accessibleIds) {
        const logs = provider.getLogs(accessibleId, query);
        if (Array.isArray(logs)) mergedLogs.push(...logs);
      }
      mergedLogs.sort((a, b) => (b.time || 0) - (a.time || 0));
      return res.json({ ok: true, data: mergedLogs.slice(0, query.limit) });
    }

    const query = createLogQuery(req.query);
    const logs = provider.getLogs(accountId, query);
    res.json({ ok: true, data: logs });
  });

  app.delete("/api/logs", (req, res) => {
    const accountId = getAccountIdFromRequest(req);
    if (!accountId) {
      return res
        .status(400)
        .json({ ok: false, error: "Missing x-account-id" });
    }
    if (!canAccessAccount(req, accountId)) {
      return res.status(403).json({ ok: false, error: "无权访问此账号" });
    }

    try {
      const data = provider.clearLogs(accountId);
      const io = getIo();
      if (io && provider && typeof provider.getLogs === "function") {
        const accountLogs = provider.getLogs(accountId, { limit: 100 });
        io.to(`account:${  accountId}`).emit("logs:snapshot", {
          accountId,
          logs: Array.isArray(accountLogs) ? accountLogs : [],
        });
        const historicalAccountLogs =
          typeof provider.getAccountLogs === "function"
            ? provider
                .getAccountLogs(300)
                .filter(
                  (log) =>
                    String(log.accountId || log.id || "") === String(accountId),
                )
            : [];
        io.to(`account:${  accountId}`).emit("account-logs:snapshot", {
          accountId,
          logs: historicalAccountLogs,
        });
        const allLogs = provider.getLogs("", { limit: 100 });
        io.to("account:all").emit("logs:snapshot", {
          accountId: "all",
          logs: Array.isArray(allLogs) ? allLogs : [],
        });
        const allHistoricalAccountLogs =
          typeof provider.getAccountLogs === "function"
            ? provider.getAccountLogs(300)
            : [];
        io.to("account:all").emit("account-logs:snapshot", {
          accountId: "all",
          logs: Array.isArray(allHistoricalAccountLogs)
            ? allHistoricalAccountLogs
            : [],
        });
      }
      res.json({ ok: true, data });
    } catch (error) {
      sendProviderError(res, error);
    }
  });
}

module.exports = {
  parseOfficialGatewayUrl,
  registerAdminAccountRoutes,
  stripProtectedWxCredentials,
  syncGatewayClientVersion,
};
