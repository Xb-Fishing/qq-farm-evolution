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
  // Program-update rejections expose only this fixed whitelist: a stable reason
  // code plus actionable guidance. The caught error is a lookup key and nothing
  // else; raw messages, paths, addresses and request data never reach the
  // response body or the log record.
  const UPDATE_FAILURES = new Map([
    ['check_update_first', '请先点击“检查新版本”确认有可用更新，再安装。'],
    ['evolution_busy', '有自动化任务尚未结束，请等任务结束后再手动安装更新。'],
    ['update_busy', '已有一次更新正在进行，请等待本次更新完成。'],
    ['update_requires_existing_tmux', '无法确认程序所在的原 tmux 窗格，已停止自动更新；请保持当前服务运行，按原部署方式更新，不要另开新实例。'],
    ['untrusted_update_source', '程序来源不在受信任名单内，已停止自动更新；请核对当前部署的来源仓库。'],
    ['remote_unreadable', '暂时无法读取上游版本信息，请检查当前部署的 Git 访问后，再手动检查新版本。'],
    ['unknown', '无法确认本次操作结果，请保留当前服务，先刷新状态并查看本机日志，不要重复安装。'],
  ]);
  const rejectUpdateAction = (res, action, error) => {
    let reason = 'unknown';
    try {
      const message = error?.message;
      if (typeof message === 'string' && UPDATE_FAILURES.has(message)) reason = message;
    } catch { /* Even a malformed exception must use the fixed fallback. */ }
    try {
      logger?.warn('程序更新请求处理失败', { module: 'program-update', event: 'update_action_failed', action, failureReason: reason });
    } catch { /* A broken or absent log sink must not change the HTTP result. */ }
    res.status(409).json({ ok: false, reason, error: UPDATE_FAILURES.get(reason) });
  };
  for (const prefix of ['/api/admin/program-update', '/api/super-admin/program-update']) {
    app.get(prefix, requireAdminToken, requireStatusViewer, (_req, res) => {
      try { res.json({ ok: true, update: updater.publicState(), access: { canUpdate: true } }); }
      catch { res.status(500).json({ ok: false, error: '无法读取版本更新状态' }); }
    });
    app.post(`${prefix}/check`, requireAdminToken, requireStatusViewer, async (_req, res) => {
      try { res.json({ ok: true, update: updater.publicState({ state: await updater.check() }) }); }
      catch (error) { rejectUpdateAction(res, 'check', error); }
    });
    app.post(`${prefix}/install`, requireAdminToken, requireStatusViewer, (_req, res) => {
      try { res.json({ ok: true, update: updater.publicState({ state: updater.begin() }) }); }
      catch (error) { rejectUpdateAction(res, 'install', error); }
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
