const {
  registerAdminWeatherActivityRoutes,
} = require('./admin-weather-activity-routes');
const {
  registerAdminCharityActivityRoutes,
} = require('./admin-charity-activity-routes');
const { registerAdminActivityUpdateRoutes } = require('./admin-activity-update-routes');

function registerAdminActivityRoutes({
  app,
  provider,
  store,
  getAccountIdFromRequest,
  canAccessAccount,
  sendProviderError,
  requireAdminToken,
}) {
  const routeContext = {
    app,
    provider,
    getAccountIdFromRequest,
    canAccessAccount,
    sendProviderError,
  };

  registerAdminCharityActivityRoutes(routeContext);
  registerAdminWeatherActivityRoutes(routeContext);
  registerAdminActivityUpdateRoutes({ app, provider, store, requireAdminToken });
}

module.exports = { registerAdminActivityRoutes };
