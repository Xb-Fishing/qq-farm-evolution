const { registerAdminMilkTeaActivityRoutes } = require('./admin-milk-tea-activity-routes');
const { registerAdminActivityUpdateRoutes } = require('./admin-activity-update-routes');
const { registerAdminOfficialAnnouncementRoutes } = require('./admin-official-announcement-routes');
const { createActivityReadCache } = require('./activity-read-cache');

// S3 萌宠（bear/pet-diary）与秋祈良愿/快乐不独享（season/wish-operate）已随 S4 轮换
// 下架（2026-10-15 退役）：四组读写路由不再注册，provider/Worker 转发已断开，
// 旧公开服务入口改为发包前固定拒绝；路由模块文件保留作历史证据，不再加载。
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

  registerAdminMilkTeaActivityRoutes(routeContext);
  registerAdminOfficialAnnouncementRoutes(routeContext);
  registerAdminActivityUpdateRoutes({ app, provider, store, requireAdminToken });
}

module.exports = { registerAdminActivityRoutes };
