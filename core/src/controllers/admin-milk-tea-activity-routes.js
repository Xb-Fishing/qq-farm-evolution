/**
 * 奶茶热销中（S4，2026110100 族）手动操作与显式查询路由
 *
 * - GET 快照走 activityReader 共享缓存（键 = 路由 + 规范化参数 + 账号，账号在末尾；
 *   loader 闭包捕获裸账号——cache-loader-contract 既有约定）。
 * - 显式查询（shop/hireList/workshop/work/rank/sales）仅由面板用户点击触发，
 *   参数白名单在服务层校验；查询结果同样走共享缓存（60s），不自动轮询/翻页。
 * - 写操作成功或「结果未知」都清该账号相关缓存（服务端状态可能已变）；
 *   写前业务拒绝（400 + 固定 SEASON_WISH_MILK_TEA_ 码）保留成功缓存，不算状态变化。
 * - 错误透传：业务前置拒绝 400 + code；普通传输失败/未知异常 502，不自动重试。
 */
const {
  getAuthorizedAccountId,
  requireConnectedAccount,
  sendActivityUnavailable,
} = require('./admin-activity-route-helpers');
const { createActivityReadCache, ACTIVITY_UPSTREAM_CACHE_MS } = require('./activity-read-cache');

const { QUERY_KINDS, MANUAL_ACTIONS } = require('../services/milk-tea-activity');

function normalizeQueryKey(kind, params) {
  const safeParams = params && typeof params === 'object' ? params : {};
  // JSON 序列化（键排序）做缓存键：值含 , = 等字符也不与其它参数组合碰撞
  return `${kind}:${JSON.stringify(safeParams, Object.keys(safeParams).sort())}`;
}

function registerAdminMilkTeaActivityRoutes({
  app,
  provider,
  getAccountIdFromRequest,
  canAccessAccount,
  sendProviderError,
  activityReader = createActivityReadCache({ ttlMs: ACTIVITY_UPSTREAM_CACHE_MS }),
}) {
  const routeContext = {
    getAccountIdFromRequest,
    canAccessAccount,
  };

  app.get('/api/activity/milk-tea', async (req, res) => {
    // 权限检查先于缓存：未授权请求不产生任何上游读取
    const accountId = getAuthorizedAccountId(req, res, routeContext);
    if (!accountId) return;
    try {
      if (!requireConnectedAccount(res, provider, accountId, '获取奶茶热销中失败: 账号未运行'))
        return;
      // 与查询/操作路由同序：连接（零上游）→ 运行态（连接含 login ready）→ 才触达 provider
      const running = await provider.isAccountRunning(accountId);
      if (!running) {
        res.json({ ok: false, error: '获取奶茶热销中失败: 账号未运行' });
        return;
      }
      const result = await activityReader.read(
        `/api/activity/milk-tea:${accountId}`,
        () => provider.getMilkTeaActivity(accountId),
      );
      res.json({
        ok: true,
        activity: result.value,
        upstreamCached: result.upstreamCached,
        upstreamCacheMs: ACTIVITY_UPSTREAM_CACHE_MS,
      });
    }
    catch (err) {
      if (err?.business === true && err.code === 'SEASON_WISH_MILK_TEA_ENDED') {
        res.json({ ok: false, unavailable: true, expired: true, error: '奶茶热销中已过最终截止时间' });
        return;
      }
      if (sendActivityUnavailable(res, err)) return;
      sendProviderError(res, err);
    }
  });

  app.post('/api/activity/milk-tea/query', async (req, res) => {
    const accountId = getAuthorizedAccountId(req, res, routeContext);
    if (!accountId) return;
    const body = req.body || {};
    const kind = String(body.kind || '').trim();
    if (!Object.prototype.hasOwnProperty.call(QUERY_KINDS, kind)) {
      res.status(400).json({ ok: false, error: `未开放的查询类型: ${kind || '(空)'}` });
      return;
    }
    try {
      if (!requireConnectedAccount(res, provider, accountId, '奶茶查询失败: 账号未运行'))
        return;
      const running = await provider.isAccountRunning(accountId);
      if (!running) {
        res.status(409).json({ ok: false, error: '账号未运行，无法执行奶茶查询' });
        return;
      }
      const params = body.params && typeof body.params === 'object' ? body.params : {};
      // 查询参数进入缓存键：同参数 60s 内合并，参数变化不串数据
      const result = await activityReader.read(
        `/api/activity/milk-tea/query:${normalizeQueryKey(kind, params)}:${accountId}`,
        () => provider.queryMilkTeaActivity(accountId, kind, params),
      );
      res.json({ ok: true, ...result.value, upstreamCached: result.upstreamCached });
    }
    catch (err) {
      const businessCode = err && err.business === true && typeof err.code === 'string'
        ? err.code
        : '';
      if (businessCode) {
        res.status(400).json({ ok: false, error: (err && err.message) || '奶茶查询失败', code: businessCode });
        return;
      }
      sendProviderError(res, err);
    }
  });

  app.post('/api/activity/milk-tea/operate', async (req, res) => {
    const accountId = getAuthorizedAccountId(req, res, routeContext);
    if (!accountId) return;
    const body = req.body || {};
    const action = String(body.action || '').trim();
    if (!MANUAL_ACTIONS.has(action)) {
      res.status(400).json({ ok: false, error: `未开放的操作: ${action || '(空)'}` });
      return;
    }
    const input = body.input && typeof body.input === 'object' ? body.input : {};
    try {
      // 与查询路由同序：先连接（零上游）再运行态，最后才触达 provider
      if (!requireConnectedAccount(res, provider, accountId, '奶茶操作失败: 账号未运行'))
        return;
      const running = await provider.isAccountRunning(accountId);
      if (!running) {
        res.status(409).json({ ok: false, error: '账号未运行，无法执行活动操作' });
        return;
      }
      const result = await provider.operateMilkTea(accountId, action, input);
      // 写成功或结果未知：服务端状态可能已变化，清该账号全部奶茶相关缓存
      if (!result || result.outcome === 'unknown' || result.ok === true || (Array.isArray(result.results) && result.results.some(row => row?.success === true))) {
        activityReader.clear(accountId);
      }
      // 写前业务拒绝（400 已由 catch 分支处理）不会走到这里；成功/未知结果原样透传
      res.json({ ok: !!(result && result.ok === true), ...(result || {}) });
    }
    catch (err) {
      const businessCode = err && err.business === true && typeof err.code === 'string'
        ? err.code
        : '';
      res.status(businessCode ? 400 : 502).json({
        ok: false,
        error: (err && err.message) || '活动操作失败',
        ...(businessCode ? { code: businessCode } : {}),
      });
    }
  });
}

module.exports = {
  ACTIVITY_UPSTREAM_CACHE_MS,
  registerAdminMilkTeaActivityRoutes,
};
