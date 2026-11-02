const { getAuthorizedAccountId, requireConnectedAccount } = require('./admin-activity-route-helpers');
const { getUpdateCatalog: readLocalUpdateCatalog } = require('../services/update-catalog');

function registerAdminGameUpdateRoutes(context) {
  const { app, provider, getAccountIdFromRequest, canAccessAccount, sendProviderError } = context;
  const routeContext = { getAccountIdFromRequest, canAccessAccount };

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
        note: '本地目录：当前持有/激活状态未知，官方只读路径未取得，不含任何游戏写入口',
      });
    } catch (error) {
      res.status(500).json({ ok: false, error: error?.message || '本地藏品目录读取失败' });
    }
  });
}

module.exports = { registerAdminGameUpdateRoutes, readLocalUpdateCatalog };
