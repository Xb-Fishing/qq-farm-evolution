const { getAuthorizedAccountId, requireConnectedAccount } = require('./admin-activity-route-helpers');

const READS = new Set(['quote', 'records', 'catalog', 'plots', 'automation']);
const WRITES = new Set(['seeds', 'sale', 'exchange', 'dividend', 'plantCrop', 'harvestCrop', 'automation-settings']);

function sweetPotatoCacheKey(id, scope, socket) {
  return `sweet-potato:${JSON.stringify([id, scope, socket])}`;
}

function registerAdminSweetPotatoTradeRoutes(context) {
  const { app, provider, activityReader, canAccessAccount, getAccountIdFromRequest, sendProviderError } = context;
  function handler(actions, writing = false) {
    return async (req, res) => {
      const id = getAuthorizedAccountId(req, res, context);
      if (!id) return;
      const action = req.params.action;
      if (!actions.has(action)) return res.status(404).json({ ok: false, error: '该活动操作不可用' });
      if (!requireConnectedAccount(res, provider, id, '账号未连接，暂时无法操作以薯换福')) return;
      try {
        const scope = provider.getGamePanelReadScope(id);
        const stillCurrent = () => getAccountIdFromRequest(req) === id && canAccessAccount(req, id)
          && provider.getGamePanelReadScope(id) === scope;
        if (!scope || !stillCurrent()) throw new Error('账号或连接已变化，请重新读取活动');
        const socket = await provider.getSweetPotatoReadScope(id);
        if (!Number.isSafeInteger(socket) || socket <= 0 || !stillCurrent())
          throw new Error('账号或连接已变化，请重新读取活动');
        let result;
        try {
          result = await provider.runSweetPotatoTrade(id, action, writing ? req.body : req.query, socket);
        } finally {
          if (writing) activityReader.clear(sweetPotatoCacheKey(id, scope, socket));
        }
        if (!stillCurrent()) throw new Error('账号或连接已变化，请核对活动状态');
        res.json({ ok: true, accountId: id, result });
      } catch (error) {
        sendProviderError(res, error);
      }
    };
  }
  app.get('/api/activity/sweet-potato/trade/:action', handler(READS));
  app.post('/api/activity/sweet-potato/trade/:action', handler(WRITES, true));
}

module.exports = { registerAdminSweetPotatoTradeRoutes, sweetPotatoCacheKey };
