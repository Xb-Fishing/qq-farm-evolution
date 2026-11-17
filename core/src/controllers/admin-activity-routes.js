const { registerAdminFriendRecallActivityRoutes } = require('./admin-friend-recall-activity-routes');
const { registerAdminMugeActivityRoutes } = require('./admin-muge-activity-routes');
const { registerAdminActivityUpdateRoutes } = require('./admin-activity-update-routes');
const { registerAdminOfficialAnnouncementRoutes } = require('./admin-official-announcement-routes');
const { createActivityReadCache } = require('./activity-read-cache');
const { registerAdminSolarCalendarRoutes } = require('./admin-solar-calendar-routes');
const { registerAdminGameUpdateRoutes } = require('./admin-game-update-routes');

// 已结束奶茶的专属路由同样不再注册；当前规则、节令和通用更新保持。
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

  registerAdminFriendRecallActivityRoutes(routeContext);
  registerAdminMugeActivityRoutes(routeContext);
  registerAdminSolarCalendarRoutes(routeContext);
  registerAdminOfficialAnnouncementRoutes(routeContext);
  registerAdminGameUpdateRoutes(routeContext);
  registerAdminActivityUpdateRoutes({ app, provider, store, requireAdminToken });
}

module.exports = { registerAdminActivityRoutes };
