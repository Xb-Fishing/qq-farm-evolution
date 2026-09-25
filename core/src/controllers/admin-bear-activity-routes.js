const {
  getAuthorizedAccountId,
  requireConnectedAccount,
  sendActivityUnavailable,
} = require('./admin-activity-route-helpers');
const { createActivityReadCache, ACTIVITY_UPSTREAM_CACHE_MS } = require('./activity-read-cache');


function registerAdminBearActivityRoutes({
  app,
  provider,
  getAccountIdFromRequest,
  canAccessAccount,
  sendProviderError,
  activityReader = createActivityReadCache({ ttlMs: ACTIVITY_UPSTREAM_CACHE_MS }),
}) {
  const routeContext = {
    getAccountIdFromRequest,
    canAccessAccount,
  };

  app.get('/api/activity/bear', async (req, res) => {
    const accountId = getAuthorizedAccountId(req, res, routeContext);
    if (!accountId) return;

    try {
      if (!requireConnectedAccount(res, provider, accountId, '获取S3 萌宠失败: 账号未运行'))
        return;
      // 缓存键带路由名，与 season 两组活动隔离（同一账号下三组面板互不串数据）。
      const result = await activityReader.read(
        `/api/activity/bear:${accountId}`,
        () => provider.getBearActivity(accountId),
      );
      res.json({
        ok: true,
        activity: result.value,
        upstreamCached: result.upstreamCached,
        upstreamCacheMs: ACTIVITY_UPSTREAM_CACHE_MS,
      });
    } catch (err) {
      if (sendActivityUnavailable(res, err)) return;
      sendProviderError(res, err);
    }
  });
}

module.exports = {
  ACTIVITY_UPSTREAM_CACHE_MS,
  registerAdminBearActivityRoutes,
};
