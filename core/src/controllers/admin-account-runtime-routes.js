function registerAdminAccountRuntimeRoutes({
  app,
  provider,
  resolveAccountReference,
  canAccessAccount,
}) {
  // 直接登录：凭据刷新（refreshtoken→loginBuffer）+ 换新 Code + 重启，全程
  // 不需要微信扫码。refreshtoken 失效时才需要人工扫码（错误信息如实返回）。
  app.post("/api/accounts/:id/relogin", async (req, res) => {
    try {
      const accountId = resolveAccountReference(req.params.id);
      if (!canAccessAccount(req, accountId)) {
        return res.status(403).json({ ok: false, error: "无权访问此账号" });
      }

      const refreshed = await provider.refreshAccountCode(accountId, "manual_relogin");
      // provider 返回 { ok }，旧代码按对象真值判断导致失败也报"直接登录成功"，
      // 用户永远等不到扫码入口。必须按 ok 字段判断。
      if (!refreshed || refreshed.ok !== true) {
        const store = require("../models/store");
        const data = typeof store.getAccounts === "function" ? store.getAccounts() : {};
        const account = (Array.isArray(data.accounts) ? data.accounts : [])
          .find(item => String(item.id) === String(accountId));
        const needScan = !account || !account.refreshtoken;
        return res.status(409).json({
          ok: false,
          needScan,
          error: needScan ? "账号缺少刷新凭证，需扫码重新授权" : "直接登录失败，请查看账号日志（凭证可能已失效，需扫码重新授权）",
        });
      }

      res.json({ ok: true });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.post("/api/accounts/:id/start", async (req, res) => {
    try {
      const accountId = resolveAccountReference(req.params.id);
      if (!canAccessAccount(req, accountId)) {
        return res.status(403).json({ ok: false, error: "无权访问此账号" });
      }

      const started = await provider.startAccount(accountId);
      if (!started) {
        return res.status(404).json({ ok: false, error: "Account not found" });
      }

      res.json({ ok: true });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.post("/api/accounts/:id/stop", (req, res) => {
    try {
      const accountId = resolveAccountReference(req.params.id);
      if (!canAccessAccount(req, accountId)) {
        return res.status(403).json({ ok: false, error: "无权访问此账号" });
      }

      const stopped = provider.stopAccount(accountId);
      if (!stopped) {
        return res.status(404).json({ ok: false, error: "Account not found" });
      }

      res.json({ ok: true });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.post("/api/accounts/:id/hold-offline", (req, res) => {
    try {
      const accountId = resolveAccountReference(req.params.id);
      if (!canAccessAccount(req, accountId)) {
        return res.status(403).json({ ok: false, error: "无权访问此账号" });
      }

      const held = provider.holdAccountOffline(accountId);
      if (!held) {
        return res.status(404).json({ ok: false, error: "Account not found" });
      }

      res.json({ ok: true });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.post("/api/accounts/:id/restart", (req, res) => {
    try {
      const accountId = resolveAccountReference(req.params.id);
      if (!canAccessAccount(req, accountId)) {
        return res.status(403).json({ ok: false, error: "无权访问此账号" });
      }

      // 静默期间手动重启 = 立即恢复全部功能
      const store = require("../models/store");
      store.applyConfigSnapshot(
        { friendQuietHours: { pauseUntil: "" } },
        { accountId }
      );

      const restarted = provider.restartAccount(accountId);
      // provider 约定：true/false = 同步 startWorker 结果；undefined = 重启已排队
      // （等旧进程退出后拉起）。undefined 是「已提交、排队中」，不是 404——
      // 按真假判断会把排队误报成 Account not found；回执须明确未连接，不冒充成功启动。
      if (restarted === undefined) {
        return res.status(202).json({
          ok: true,
          queued: true,
          started: false,
          error: "重启已排队：等待旧进程退出后自动拉起",
        });
      }
      if (!restarted) {
        return res.status(404).json({ ok: false, error: "Account not found" });
      }

      res.json({ ok: true });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });
}

module.exports = { registerAdminAccountRuntimeRoutes };
