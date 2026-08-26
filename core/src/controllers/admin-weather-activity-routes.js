const {
  getAuthorizedAccountId,
  requireConnectedAccount,
} = require('./admin-activity-route-helpers');

function registerAdminWeatherActivityRoutes({
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

  app.get('/api/activity/weather', async (req, res) => {
    const accountId = getAuthorizedAccountId(req, res, routeContext);
    if (!accountId) return;

    try {
      if (!requireConnectedAccount(res, provider, accountId, '获取雨落成诗失败: 账号未运行'))
        return;
      res.json({ ok: true, activity: await provider.getWeatherActivity(accountId) });
    } catch (err) {
      sendProviderError(res, err);
    }
  });
}

module.exports = { registerAdminWeatherActivityRoutes };
