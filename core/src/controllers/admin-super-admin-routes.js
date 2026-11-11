function registerAdminSuperAdminRoutes({
  app,
  store,
  userStore,
  logger,
  requireAdminToken,
  requireSuperAdminRole,
  requireDangerConfirmation,
  checkAccountLimit,
}) {
  const updater = require('../services/program-update');
  const requireStatusViewer = (req, res, next) => {
    if (!['admin', 'super_admin'].includes(req.currentUser?.role)) return res.status(403).json({ ok: false, error: '需要管理员权限' });
    next();
  };
  for (const prefix of ['/api/admin/program-update', '/api/super-admin/program-update']) {
    app.get(prefix, requireAdminToken, requireStatusViewer, (_req, res) => {
      try { res.json({ ok: true, update: updater.publicState(), access: { canUpdate: true } }); }
      catch { res.status(500).json({ ok: false, error: '无法读取版本更新状态' }); }
    });
    app.post(`${prefix}/check`, requireAdminToken, requireStatusViewer, async (_req, res) => {
      try { res.json({ ok: true, update: updater.publicState({ state: await updater.check() }) }); }
      catch { res.status(409).json({ ok: false, error: '版本检查失败，请稍后重试' }); }
    });
    app.post(`${prefix}/install`, requireAdminToken, requireStatusViewer, (_req, res) => {
      try { res.json({ ok: true, update: updater.publicState({ state: updater.begin() }) }); }
      catch { res.status(409).json({ ok: false, error: '暂不能更新，请先检查版本并等待当前任务结束' }); }
    });
  }
  app.post(
    "/api/super-admin/clear-data",
    requireAdminToken,
    requireSuperAdminRole,
    (req, res) => {
      try {
        if (!requireDangerConfirmation(req, res, "CLEAR_ALL_DATA")) return;
        const result = userStore.clearAllData();
        logger.warn("超级管理员清空全部数据", {
          admin: req.currentUser?.username || "",
          confirmation: "CLEAR_ALL_DATA",
          executed: !!result.ok,
        });
        result.requiredConfirmation = "CLEAR_ALL_DATA";
        result.executed = !!result.ok;
        res.json(result);
      } catch (error) {
        res.status(500).json({ ok: false, error: error.message });
      }
    },
  );

  app.get(
    "/api/super-admin/anti-resale-config",
    requireAdminToken,
    requireSuperAdminRole,
    (req, res) => {
      try {
        res.json({ ok: true, config: store.getAntiResaleConfig() });
      } catch (error) {
        res.status(500).json({ ok: false, error: error.message });
      }
    },
  );

  app.post(
    "/api/super-admin/anti-resale-config",
    requireAdminToken,
    requireSuperAdminRole,
    (req, res) => {
      try {
        if (!requireDangerConfirmation(req, res, "UPDATE_ANTI_RESALE_CONFIG")) {
          return;
        }

        const config = store.setAntiResaleConfig(req.body);
        logger.warn("更新防倒卖配置", {
          admin: req.currentUser?.username || "",
          accountLimitEnabled: config?.accountLimitEnabled === true,
          accountLimitThreshold: config?.accountLimitThreshold,
          confirmation: "UPDATE_ANTI_RESALE_CONFIG",
        });
        res.json({ ok: true, config });
      } catch (error) {
        res.status(500).json({ ok: false, error: error.message });
      }
    },
  );

  app.post(
    "/api/super-admin/check-account-limit",
    requireAdminToken,
    requireSuperAdminRole,
    (req, res) => {
      try {
        const result = checkAccountLimit("manual");
        logger.warn("手动检查账号数量上限", {
          admin: req.currentUser?.username || "",
          ok: result?.ok === true,
          triggered: result?.triggered === true,
          runningCount: result?.runningCount,
          threshold: result?.threshold,
          destructiveActionBlocked: true,
        });
        if (!result.ok) return res.status(500).json(result);
        result.executed = false;
        result.destructiveActionBlocked = true;
        result.requiredConfirmation = "ACCOUNT_LIMIT_OVERRIDE";
        if (result.triggered) {
          result.message = `${result.message  }，当前版本仅告警，不再自动清空账号`;
        }
        res.json(result);
      } catch (error) {
        res.status(500).json({ ok: false, error: error.message });
      }
    },
  );
}

module.exports = { registerAdminSuperAdminRoutes };
