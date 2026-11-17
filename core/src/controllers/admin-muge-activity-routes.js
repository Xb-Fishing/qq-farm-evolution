const { getAuthorizedAccountId, requireConnectedAccount } = require('./admin-activity-route-helpers');
const { MUGE_ROOT_ACTIVITY_ID, findRoot, timestamp, unavailable, normalizeMuge } = require('../services/muge-activity');
function registerAdminMugeActivityRoutes(context) {
  const { app, provider, activityReader, sendProviderError } = context;
  // Successful List evidence survives failed reads and cache eviction.
  const deadlines = new Map();
  const expired = accountId => deadlines.has(accountId) && Date.now() / 1000 >= deadlines.get(accountId);
  const ended = accountId => unavailable('活动已结束', deadlines.get(accountId));
  const remember = (accountId, node) => {
    const end = timestamp(node?.endTime);
    if (end != null) deadlines.set(accountId, Math.min(deadlines.get(accountId) ?? end, end));
  };
  app.get('/api/activity/muge', async (req, res) => {
    const accountId = getAuthorizedAccountId(req, res, context);
    if (!accountId) return;
    try {
      if (expired(accountId)) return res.json({ ok: true, activity: ended(accountId) });
      if (!requireConnectedAccount(res, provider, accountId, '账号未连接，暂时无法读取牧歌初启')) return;
      const running = await provider.isAccountRunning(accountId);
      if (expired(accountId)) return res.json({ ok: true, activity: ended(accountId) });
      if (!running) return res.status(409).json({ ok: false, error: '账号未运行' });
      const result = await activityReader.read(`muge:${accountId}`, async () => {
        if (expired(accountId)) return ended(accountId);
        if (provider.getStatus(accountId)?.connection?.connected !== true) throw new Error('账号连接已变化，请稍后刷新');
        const list = await provider.getActivityDiscoveryList(accountId);
        if (expired(accountId)) return ended(accountId);
        const root = findRoot(list);
        if (!root) return unavailable('当前列表未下发活动');
        remember(accountId, root);
        if (expired(accountId)) return ended(accountId);
        if (provider.getStatus(accountId)?.connection?.connected !== true) throw new Error('账号连接已变化，请稍后刷新');
        const snapshot = await provider.getActivityGroupSnapshot(accountId, MUGE_ROOT_ACTIVITY_ID, '');
        if (expired(accountId)) return ended(accountId);
        if (snapshot?.id === MUGE_ROOT_ACTIVITY_ID && snapshot.parentId === 0) remember(accountId, snapshot);
        const activity = normalizeMuge(snapshot);
        remember(accountId, activity);
        if (!activity.available && activity.reason !== '活动已结束') throw new Error(activity.reason);
        return expired(accountId) ? ended(accountId) : { ...activity, endTime: deadlines.get(accountId) ?? activity.endTime };
      });
      return res.json({ ok: true, activity: expired(accountId) ? ended(accountId) : result.value, upstreamCached: result.upstreamCached });
    } catch (error) {
      if (expired(accountId)) return res.json({ ok: true, activity: ended(accountId) });
      // A later Group failure must not hide a newly proven List cutoff from
      // a page whose previous successful rules had no cutoff. Keep the shared
      // error mapper's original body and HTTP classification.
      const endTime = deadlines.get(accountId);
      if (endTime != null && !res.headersSent) res.setHeader('x-activity-end-time', String(endTime));
      sendProviderError(res, error);
    }
  });
}
module.exports = { registerAdminMugeActivityRoutes };
