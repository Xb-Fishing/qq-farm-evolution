const { getAuthorizedAccountId, requireConnectedAccount } = require('./admin-activity-route-helpers');
function registerAdminRanchRoutes(context) {
  const { app, provider, activityReader, sendProviderError } = context;
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
    if (!['animals', 'shop', 'tasks'].includes(view) || !['5', '6'].includes(shop)) return res.status(400).json({ ok: false, error: '牧场页面或商店参数无效' });
    const key = `ranch:${view}:${shop}:${id}`;
    try {
      const result = await activityReader.read(key, () => provider.getRanchState(id, view, shop));
      const recoveryRequired = result.value?.ok === true
        ? result.value.data?.sceneRecoveryRequired : result.value?.sceneRecoveryRequired;
      if (recoveryRequired === true) activityReader.clear(key);
      return respond(res, { ...result.value, upstreamCached: result.upstreamCached });
    } catch (error) { return sendProviderError(res, error); }
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
  app.post('/api/ranch/acknowledge', async (req, res) => {
    const id = await account(req, res); if (!id) return;
    try { const result = await provider.acknowledgeRanch(id, req.body?.operationId); activityReader.clear(id); return respond(res, result); }
    catch (error) { return sendProviderError(res, error); }
  });
}
module.exports = { registerAdminRanchRoutes };
