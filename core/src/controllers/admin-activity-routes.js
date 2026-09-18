const { registerAdminBearActivityRoutes } = require('./admin-bear-activity-routes');
const { registerAdminPetDiaryOperateRoutes } = require('./admin-pet-diary-operate-routes');
const { registerAdminActivityUpdateRoutes } = require('./admin-activity-update-routes');
const { createActivityReadCache } = require('./activity-read-cache');

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
    activityReader: createActivityReadCache(),
  };

  registerAdminBearActivityRoutes(routeContext);
  registerAdminPetDiaryOperateRoutes(routeContext);
  registerAdminActivityUpdateRoutes({ app, provider, store, requireAdminToken });
}

module.exports = { registerAdminActivityRoutes };
