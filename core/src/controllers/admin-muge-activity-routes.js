const { getAuthorizedAccountId, requireConnectedAccount } = require('./admin-activity-route-helpers');
const { timestamp, unavailable } = require('../services/muge-activity');

function registerAdminMugeActivityRoutes(context) {
  const { app, provider, activityReader, sendProviderError } = context;
  const deadlines = new Map();
  const expired = id => deadlines.has(id) && Date.now() / 1000 >= deadlines.get(id);
  const ended = id => ({ ...unavailable('活动已结束', deadlines.get(id)), personal: null });
  const cacheKey = (id, scope) => `muge:${id}:${scope}`;
  function remember(id, activity) {
    const end = timestamp(activity?.endTime);
    if (end != null) deadlines.set(id, Math.min(deadlines.get(id) ?? end, end));
    return expired(id) ? ended(id) : activity;
  }
  function stillCurrent(req, id, scope) {
    return context.getAccountIdFromRequest(req) === id && context.canAccessAccount(req, id)
      && provider.getStatus(id)?.connection?.connected === true && provider.getGamePanelReadScope(id) === scope;
  }

  app.get('/api/activity/muge', async (req, res) => {
    const id = getAuthorizedAccountId(req, res, context);
    if (!id) return;
    try {
      if (expired(id)) return res.json({ ok: true, activity: ended(id) });
      if (!requireConnectedAccount(res, provider, id, '账号未连接，暂时无法读取牧歌初启')) return;
      const running = await provider.isAccountRunning(id);
      if (expired(id)) return res.json({ ok: true, activity: ended(id) });
      if (!running) return res.status(409).json({ ok: false, error: '账号未运行' });
      const scope = provider.getGamePanelReadScope(id);
      if (!scope) throw new Error('账号连接已变化，请稍后刷新');
      const result = await activityReader.read(cacheKey(id, scope), async () => {
        if (expired(id)) return ended(id);
        if (!stillCurrent(req, id, scope)) throw new Error('账号连接已变化，请稍后刷新');
        const result = await provider.getMugeActivity(id);
        if (!stillCurrent(req, id, scope)) throw new Error('账号连接已变化，请稍后刷新');
        if (result?.ok !== true || !result.activity) throw new Error(result?.error || '牧歌初启响应无效');
        return remember(id, result.activity);
      });
      if (!stillCurrent(req, id, scope)) throw new Error('账号连接已变化，请稍后刷新');
      return res.json({ ok: true, activity: remember(id, result.value), upstreamCached: result.upstreamCached });
    } catch (error) {
      if (expired(id)) return res.json({ ok: true, activity: ended(id) });
      const endTime = deadlines.get(id);
      if (endTime != null && !res.headersSent) res.setHeader('x-activity-end-time', String(endTime));
      return sendProviderError(res, error);
    }
  });

  app.post('/api/activity/muge/operate', async (req, res) => {
    const id = getAuthorizedAccountId(req, res, context);
    if (!id) return;
    try {
      if (expired(id)) return res.status(409).json({ ok: false, code: 'MUGE_UNAVAILABLE', error: '活动已结束' });
      if (!requireConnectedAccount(res, provider, id, '账号未连接，暂时无法操作牧歌初启')) return;
      const scope = provider.getGamePanelReadScope(id);
      if (!scope || !await provider.isAccountRunning(id) || !stillCurrent(req, id, scope))
        return res.status(409).json({ ok: false, code: 'MUGE_SESSION_CHANGED', error: '账号连接已变化，请稍后刷新' });
      const key = cacheKey(id, scope);
      activityReader.clear(key);
      try {
        const result = await provider.operateMuge(id, req.body?.action, req.body?.input);
        if (!stillCurrent(req, id, scope))
          return res.status(409).json({ ok: false, code: 'MUGE_RESULT_UNKNOWN', error: '账号连接已变化，请刷新核对活动状态' });
        if (result?.activity) result.activity = remember(id, result.activity);
        return result?.ok === true ? res.json(result) : res.status(409).json(result || { ok: false, error: '牧歌初启响应无效' });
      } finally {
        activityReader.clear(key);
      }
    } catch (error) {
      return sendProviderError(res, error);
    }
  });
}

module.exports = { registerAdminMugeActivityRoutes };
