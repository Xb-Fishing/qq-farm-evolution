const { getAuthorizedAccountId, requireConnectedAccount } = require('./admin-activity-route-helpers');
const { getUpdateCatalog: readLocalUpdateCatalog } = require('../services/update-catalog');
const { createActivityReadCache } = require('./activity-read-cache');

function registerAdminGameUpdateRoutes(context) {
  const { app, provider, getAccountIdFromRequest, canAccessAccount, sendProviderError } = context;
  const routeContext = { getAccountIdFromRequest, canAccessAccount };
  const panelReads = createActivityReadCache();
  const panelScopes = new Map();
  for (const [kind, method] of [['dog-state', 'getDogReadPanel'], ['collection-state', 'getCollectionReadPanel']]) {
    app.get(`/api/activity/${kind}`, async (req, res) => {
      const accountId = getAuthorizedAccountId(req, res, routeContext);
      if (!accountId) return;
      try {
        if (!requireConnectedAccount(res, provider, accountId, '账号未连接，暂时无法读取游戏状态')) return;
        const scope = provider.getGamePanelReadScope(accountId), slot = `${kind}:${accountId}`, key = `${kind}:${scope}`;
        const previous = panelScopes.get(slot);
        if (previous && previous !== key) panelReads.clear(previous);
        panelScopes.set(slot, key);
        const current = () => panelScopes.get(slot) === key && provider.getGamePanelReadScope(accountId) === scope;
        const result = await panelReads.read(key, async () => {
          const value = await provider[method](accountId);
          if (!current()) throw new Error('账号或连接已变化，请重新读取');
          return value;
        });
        if (!current()) throw new Error('账号或连接已变化，请重新读取');
        res.json({ ok: true, state: result.value, upstreamCached: result.upstreamCached });
      } catch (error) { sendProviderError(res, error); }
    });
  }

  app.get('/api/activity/emails', async (req, res) => {
    const accountId = getAuthorizedAccountId(req, res, routeContext);
    if (!accountId) return;
    try {
      if (!requireConnectedAccount(res, provider, accountId, '账号未连接，暂时无法读取邮箱快照')) return;
      const snapshot = await provider.getEmailSnapshot(accountId, {});
      res.json({ ok: true, snapshot });
    } catch (error) {
      sendProviderError(res, error);
    }
  });

  app.get('/api/activity/game-update-evidence', async (req, res) => {
    const accountId = getAuthorizedAccountId(req, res, routeContext);
    if (!accountId) return;
    try {
      if (!requireConnectedAccount(res, provider, accountId, '账号未连接，暂时无法采集更新证据')) return;
      const evidence = await provider.getGameUpdateEvidence(accountId, {});
      res.json({ ok: true, evidence });
    } catch (error) {
      sendProviderError(res, error);
    }
  });

  app.get('/api/activity/game-update-catalog', async (req, res) => {
    const accountId = getAuthorizedAccountId(req, res, routeContext);
    if (!accountId) return;
    try {
      const catalog = readLocalUpdateCatalog();
      res.json({
        ok: true,
        catalog,
        localOnly: true,
        ownership: 'unknown',
        activation: 'unknown',
        note: '本地目录不含账号实时持有、星级和展台；请使用手动只读状态查询，未接入新游戏写入口',
      });
    } catch (error) {
      res.status(500).json({ ok: false, error: error?.message || '本地藏品目录读取失败' });
    }
  });
}

module.exports = { registerAdminGameUpdateRoutes, readLocalUpdateCatalog };
