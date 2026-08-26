const {
  registerAdminHeluActivityRoutes,
} = require("./admin-helu-activity-routes");
const {
  registerAdminNanguaActivityRoutes,
} = require("./admin-nangua-activity-routes");
const {
  registerAdminWeatherActivityRoutes,
} = require('./admin-weather-activity-routes');
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

  registerAdminNanguaActivityRoutes(routeContext);
  registerAdminHeluActivityRoutes(routeContext);
  registerAdminWeatherActivityRoutes(routeContext);
  registerAdminActivityUpdateRoutes({ app, provider, store, requireAdminToken });
}

module.exports = { registerAdminActivityRoutes };
