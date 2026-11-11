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
  app.get('/api/super-admin/investigations', requireAdminToken, requireSuperAdminRole, (_req, res) => {
    try {
      const dataDir = require('../config/runtime-paths').getDataDir();
      const { pending } = require('../services/evolution-no-change-audit').getInvestigationFollowups(dataDir);
      res.json({ ok: true, investigations: pending.map(entry => ({ id: entry.id, area: entry.area,
        question: String(entry.question || '').slice(0, 2000), missing: String(entry.lastReview?.remaining ?? entry.missing ?? '').slice(0, 2000),
        ruledOut: (entry.ruledOut || []).slice(0, 8), nextCheckAt: entry.nextCheckAt,
        lastCheckedAt: entry.lastReview?.reviewedAt || 0, conclusion: String(entry.lastReview?.conclusion || '').slice(0, 2000),
        verification: entry.lastReview?.verification || null, needsOwner: entry.mechanism === 'owner_evidence' })) });
    } catch { res.status(500).json({ ok: false, error: '调查记录暂时不可读' }); }
  });
  app.get('/api/super-admin/program-update', requireAdminToken, requireSuperAdminRole, (_req, res) => {
    try { res.json({ ok: true, update: updater.safeState() }); }
    catch { res.status(500).json({ ok: false, error: '无法读取版本更新状态' }); }
  });
  app.post('/api/super-admin/program-update/check', requireAdminToken, requireSuperAdminRole, async (_req, res) => {
    try { res.json({ ok: true, update: await updater.check() }); }
    catch { res.status(409).json({ ok: false, error: '版本检查失败，请检查可信来源与网络连接' }); }
  });
  app.post('/api/super-admin/program-update/install', requireAdminToken, requireSuperAdminRole, (_req, res) => {
    try { res.json({ ok: true, update: updater.begin() }); }
    catch { res.status(409).json({ ok: false, error: '暂不能更新，请先检查新版本并等待进化或更新任务结束' }); }
  });
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
