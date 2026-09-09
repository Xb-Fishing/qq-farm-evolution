const {
  getAuthorizedAccountId,
  requireConnectedAccount,
  sendActivityUnavailable,
} = require('./admin-activity-route-helpers');
const { createActivityReadCache } = require('./admin-weather-activity-routes');

const CHARITY_ACTIVITY_UPSTREAM_CACHE_MS = 60 * 1000;

function registerAdminCharityActivityRoutes({
  app,
  provider,
  getAccountIdFromRequest,
  canAccessAccount,
  sendProviderError,
}) {
  const routeContext = {
    getAccountIdFromRequest,
    canAccessAccount,
  };
  const activityReader = createActivityReadCache({ ttlMs: CHARITY_ACTIVITY_UPSTREAM_CACHE_MS });

  app.get('/api/activity/charity', async (req, res) => {
    const accountId = getAuthorizedAccountId(req, res, routeContext);
    if (!accountId) return;

    try {
      if (!requireConnectedAccount(res, provider, accountId, '获取公益小红花失败: 账号未运行'))
        return;
      const result = await activityReader.read(
        accountId,
        () => provider.getCharityActivity(accountId),
      );
      res.json({
        ok: true,
        activity: result.value,
        upstreamCached: result.upstreamCached,
        upstreamCacheMs: CHARITY_ACTIVITY_UPSTREAM_CACHE_MS,
      });
    } catch (err) {
      if (sendActivityUnavailable(res, err)) return;
      sendProviderError(res, err);
    }
  });
}

module.exports = {
  CHARITY_ACTIVITY_UPSTREAM_CACHE_MS,
  registerAdminCharityActivityRoutes,
};
