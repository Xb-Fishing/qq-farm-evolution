const {
  getAuthorizedAccountId,
  requireConnectedAccount,
  sendActivityUnavailable,
} = require('./admin-activity-route-helpers');
const { ACTIVITY_UPSTREAM_CACHE_MS } = require('./activity-read-cache');


// 秋祈良愿与快乐不独享共用一套说明驱动只读路由；两组活动当前均无写操作证据。
function registerAdminSeasonActivityRoutes({
  app,
  provider,
  getAccountIdFromRequest,
  canAccessAccount,
  sendProviderError,
  activityReader,
}) {
  const routeContext = {
    getAccountIdFromRequest,
    canAccessAccount,
  };

  const registerReadRoute = ({ path, label, read }) => {
    app.get(path, async (req, res) => {
      const accountId = getAuthorizedAccountId(req, res, routeContext);
      if (!accountId) return;

      try {
        if (!requireConnectedAccount(res, provider, accountId, `获取${label}失败: 账号未运行`))
          return;
        const result = await activityReader.read(accountId, read);
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
  };

  registerReadRoute({
    path: '/api/activity/wish',
    label: '秋祈良愿',
    read: (accountId) => provider.getWishActivity(accountId),
  });
  registerReadRoute({
    path: '/api/activity/happy-share',
    label: '快乐不独享',
    read: (accountId) => provider.getHappyShareActivity(accountId),
  });
}

module.exports = { registerAdminSeasonActivityRoutes };
