const { getAuthorizedAccountId, requireConnectedAccount } = require('./admin-activity-route-helpers');
const RANCH_VIEWS = ['animals', 'shop', 'tasks'];
const RANCH_SHOPS = ['5', '6'];
const validQuoteId = id => typeof id === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id);

function registerAdminRanchRoutes(context) {
  const { app, provider, activityReader, sendProviderError } = context;
  const readScopes = new Map();
  const stateKey = (id, scope, view, shop) => `ranch:${view}:${shop}:${scope}:${id}`;
  function clearScope(id, entry) {
    if (!entry || readScopes.get(id) !== entry) return;
    readScopes.delete(id);
    for (const view of RANCH_VIEWS) {
      for (const shop of RANCH_SHOPS) activityReader.clear(stateKey(id, entry.scope, view, shop));
    }
  }
  function readScope(id) {
    try {
      const scope = provider.getGamePanelReadScope(id);
      return typeof scope === 'string' && scope.length > 0 ? scope : null;
    } catch { return null; }
  }
  const stillAuthorized = (req, id) => context.getAccountIdFromRequest(req) === id && context.canAccessAccount(req, id);
  const denyAccess = res => res.status(403).json({ ok: false, error: '无权访问此账号' });
  const unavailable = res => res.status(409).json({ ok: false, error: '账号连接或业务状态已变化，请重新读取牧场' });
  async function account(req, res, needsConnection = true) {
    const id = getAuthorizedAccountId(req, res, context);
    if (!id || (needsConnection && !requireConnectedAccount(res, provider, id, '账号未连接，暂时无法读取牧场'))) return '';
    if (!await provider.isAccountRunning(id)) { res.status(409).json({ ok: false, error: '账号未运行' }); return ''; }
    return id;
  }
  const respond = (res, result) => result?.ok === true ? res.json(result)
    : res.status(result?.code === 'RANCH_READ_FAILED' ? 502 : 409).json(result || { ok: false, error: '牧场响应无效' });
  app.get('/api/ranch/automation', async (req, res) => {
    const id = await account(req, res, false); if (!id) return;
    try { return respond(res, await provider.getRanchAutomation(id)); }
    catch (error) { return sendProviderError(res, error); }
  });
  app.post('/api/ranch/automation', async (req, res) => {
    const id = await account(req, res, false); if (!id) return;
    try { return respond(res, await provider.setRanchAutomation(id, req.body)); }
    catch (error) { return sendProviderError(res, error); }
  });
  app.get('/api/ranch/state', async (req, res) => {
    const id = await account(req, res); if (!id) return;
    const view = String(req.query?.view || 'animals'); const shop = String(req.query?.shopId || '5');
    if (!RANCH_VIEWS.includes(view) || !RANCH_SHOPS.includes(shop)) return res.status(400).json({ ok: false, error: '牧场页面或商店参数无效' });
    if (!stillAuthorized(req, id)) return denyAccess(res);
    const scope = readScope(id);
    let entry = readScopes.get(id);
    if (entry?.scope !== scope) {
      clearScope(id, entry);
      if (!scope) return unavailable(res);
      entry = { scope };
      readScopes.set(id, entry);
    }
    const key = stateKey(id, scope, view, shop);
    function currentScope() {
      if (readScopes.get(id) !== entry) return false;
      if (readScope(id) === scope) return true;
      clearScope(id, entry);
      return false;
    }
    try {
      const result = await activityReader.read(key, async () => {
        // The cache dispatches the loader in a later microtask.
        if (!currentScope()) throw new Error('牧场连接已变化');
        if (!stillAuthorized(req, id)) {
          activityReader.clear(key);
          throw new Error('无权访问此账号');
        }
        try { return await provider.getRanchState(id, view, shop); }
        finally { currentScope(); }
      });
      if (!stillAuthorized(req, id)) return denyAccess(res);
      if (!currentScope()) return unavailable(res);
      const recoveryRequired = result.value?.ok === true
        ? result.value.data?.sceneRecoveryRequired : result.value?.sceneRecoveryRequired;
      if (recoveryRequired === true) activityReader.clear(key);
      return respond(res, { ...result.value, upstreamCached: result.upstreamCached });
    } catch (error) {
      if (!stillAuthorized(req, id)) return denyAccess(res);
      if (!currentScope()) return unavailable(res);
      return sendProviderError(res, error);
    }
  });
  app.post('/api/ranch/prepare', async (req, res) => {
    const id = await account(req, res); if (!id) return;
    try {
      const result = await provider.prepareRanchAction(id, req.body?.action, req.body?.input || {});
      if (!result?.ok) activityReader.clear(id);
      return respond(res, result);
    } catch (error) { return sendProviderError(res, error); }
  });
  app.post('/api/ranch/operate', async (req, res) => {
    const id = await account(req, res); if (!id) return;
    const quoteId = req.body?.quoteId;
    if (typeof quoteId !== 'string' || !/^[a-f0-9-]{36}$/.test(quoteId)) return res.status(400).json({ ok: false, error: '确认记录无效' });
    let finished = false;
    const cancel = () => {
      if (!finished && !res.writableEnded) void Promise.resolve(provider.cancelRanchAction(id, quoteId)).catch(() => {});
    };
    req.on?.('aborted', cancel); res.on?.('close', cancel);
    try {
      const result = await provider.operateRanch(id, quoteId);
      activityReader.clear(id);
      if (!res.destroyed) return respond(res, result);
    } catch (error) { if (!res.destroyed) return sendProviderError(res, error); }
    finally { finished = true; req.off?.('aborted', cancel); res.off?.('close', cancel); }
  });
  app.post('/api/ranch/reconcile-feed', async (req, res) => {
    const id = await account(req, res); if (!id) return;
    const receiptId = req.body?.operationId;
    if (typeof receiptId !== 'string' || !/^[a-f0-9-]{36}$/.test(receiptId))
      return res.status(400).json({ ok: false, error: '牧草单据无效' });
    try { return respond(res, await provider.acknowledgeRanch(id, { feedReceiptId: receiptId })); }
    catch (error) { return sendProviderError(res, error); }
  });
  app.post('/api/ranch/cancel', async (req, res) => {
    const id = await account(req, res, false); if (!id) return;
    if (!stillAuthorized(req, id)) return denyAccess(res);
    const quoteId = req.body?.quoteId;
    if (!validQuoteId(quoteId)) return res.status(400).json({ ok: false, error: '确认记录无效' });
    try {
      const result = await provider.cancelRanchAction(id, quoteId);
      if (result?.ok !== true) return respond(res, result);
      if (result.data?.cancelled !== true) return res.status(409).json({ ok: false, error: '无法取消这条牧场确认记录' });
      activityReader.clear(id);
      return respond(res, result);
    } catch (error) { return sendProviderError(res, error); }
  });
  app.post('/api/ranch/acknowledge', async (req, res) => {
    const id = await account(req, res); if (!id) return;
    try { const result = await provider.acknowledgeRanch(id, req.body?.operationId); activityReader.clear(id); return respond(res, result); }
    catch (error) { return sendProviderError(res, error); }
  });
}
module.exports = { registerAdminRanchRoutes };
