const { registerAdminRanchRoutes } = require('./admin-ranch-routes');
const { registerAdminMugeActivityRoutes } = require('./admin-muge-activity-routes');
const { registerAdminActivityUpdateRoutes } = require('./admin-activity-update-routes');
const { registerAdminOfficialAnnouncementRoutes } = require('./admin-official-announcement-routes');
const { createActivityReadCache } = require('./activity-read-cache');
const { registerAdminSolarCalendarRoutes } = require('./admin-solar-calendar-routes');
const { registerAdminGameUpdateRoutes } = require('./admin-game-update-routes');
const { getAuthorizedAccountId, requireConnectedAccount } = require('./admin-activity-route-helpers');
const { sweetPotatoOutsideWindow } = require('../services/activity');

function registerSweetPotatoRoute(context) {
  const { app, provider, activityReader, getAccountIdFromRequest, canAccessAccount, sendProviderError } = context;
  app.get('/api/activity/sweet-potato', async (req, res) => {
    const accountId = getAuthorizedAccountId(req, res, context);
    if (!accountId) return;
    const sendActivity = (activity, upstreamCached = false) => {
      if (!res.headersSent && !res.writableEnded && !res.destroyed)
        return res.json({ ok: true, accountId, activity, upstreamCached });
    };
    const sameAccount = () => getAccountIdFromRequest(req) === accountId && canAccessAccount(req, accountId);
    let key;
    try {
      const outside = sweetPotatoOutsideWindow();
      if (outside) return sendActivity(outside);
      if (!requireConnectedAccount(res, provider, accountId, '账号未连接，暂时无法读取以薯换福')) return;
      const scope = provider.getGamePanelReadScope(accountId);
      if (!scope) throw new Error('账号连接已变化，请重新读取');
      const socketScope = await provider.getSweetPotatoReadScope(accountId);
      if (!Number.isSafeInteger(socketScope) || socketScope <= 0)
        throw new Error('账号连接已变化，请重新读取');
      key = `sweet-potato:${JSON.stringify([accountId, scope, socketScope])}`;
      function checkCurrent() {
        try {
          if (!sameAccount()) throw new Error('账号授权已变化，请重新读取');
          const outside = sweetPotatoOutsideWindow();
          if (outside) {
            activityReader.clear(key);
            return outside;
          }
          if (provider.getGamePanelReadScope(accountId) !== scope)
            throw new Error('账号连接已变化，请重新读取');
          return null;
        } catch (error) {
          activityReader.clear(key);
          throw error;
        }
      }
      const initial = checkCurrent();
      if (initial) return sendActivity(initial);
      let result, readError;
      try {
        result = await activityReader.read(key, async () => {
          const outside = checkCurrent();
          if (outside) return outside;
          const activity = await provider.getSweetPotatoActivity(accountId, socketScope);
          const expired = checkCurrent();
          if (expired) return expired;
          if (!['available', 'unknown', 'unavailable'].includes(activity?.status))
            throw new Error('以薯换福响应无效');
          return activity;
        });
      } catch (error) {
        readError = error || new Error('以薯换福读取失败');
      }
      const beforeScopeRead = checkCurrent();
      if (beforeScopeRead) return sendActivity(beforeScopeRead);
      const currentSocketScope = await provider.getSweetPotatoReadScope(accountId);
      const expired = checkCurrent();
      if (expired) return sendActivity(expired);
      if (currentSocketScope !== socketScope) {
        activityReader.clear(key);
        throw new Error('账号连接已变化，请重新读取');
      }
      if (readError) throw readError;
      return sendActivity(result.value, result.upstreamCached);
    } catch (error) {
      if (!sameAccount()) return sendProviderError(res, new Error('账号授权已变化，请重新读取'));
      const outside = sweetPotatoOutsideWindow();
      if (outside) {
        if (key) activityReader.clear(key);
        return sendActivity(outside);
      }
      return sendProviderError(res, error);
    }
  });
}

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

  registerAdminMugeActivityRoutes(routeContext);
  registerSweetPotatoRoute(routeContext);
  registerAdminRanchRoutes(routeContext);
  registerAdminSolarCalendarRoutes(routeContext);
  registerAdminOfficialAnnouncementRoutes(routeContext);
  registerAdminGameUpdateRoutes(routeContext);
  registerAdminActivityUpdateRoutes({ app, provider, store, requireAdminToken });
}

module.exports = { registerAdminActivityRoutes };
