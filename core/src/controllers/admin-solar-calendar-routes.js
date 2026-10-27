const { getAuthorizedAccountId, requireConnectedAccount } = require('./admin-activity-route-helpers');
function registerAdminSolarCalendarRoutes(context) {
  const { app, provider, activityReader, sendProviderError } = context;
  for (const write of [false, true]) app[write ? 'post' : 'get']('/api/activity/festival', async (req, res) => {
    const accountId = getAuthorizedAccountId(req, res, context);
    if (!accountId || !requireConnectedAccount(res, provider, accountId, '账号未连接，暂时无法读取节日签到')) return;
    try {
      if (!await provider.isAccountRunning(accountId)) return res.status(409).json({ ok: false, error: '账号未运行' });
      if (!write) {
        const result = await activityReader.read(`/api/activity/festival:${accountId}`, () => provider.getSolarCalendar(accountId));
        return res.json({ ok: true, calendar: result.value, upstreamCached: result.upstreamCached });
      }
      const result = await provider.operateSolarCalendar(accountId, req.body?.action, req.body?.input || {});
      activityReader.clear(accountId);
      res.json(result);
    } catch (error) {
      if (error?.business) return res.status(400).json({ ok: false, error: error.message, code: error.code });
      sendProviderError(res, error);
    }
  });
}
module.exports = { registerAdminSolarCalendarRoutes };
