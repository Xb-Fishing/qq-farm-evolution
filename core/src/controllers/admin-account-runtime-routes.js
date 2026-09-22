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
      if (!refreshed) {
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
