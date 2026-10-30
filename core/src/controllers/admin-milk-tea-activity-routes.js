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
 * - 严格本地预算拒绝（budget_total/method，零发送可证）→ 429 + 固定本地码，
 *   缓存保留、零重试（2026-10-30 奶茶 502 定位修复）；三路由 finish/close
 *   各落一行白名单 sidecar 诊断（milk-tea-request-feedback，trace 关联）。
 */
const {
  getAuthorizedAccountId,
  requireConnectedAccount,
  sendActivityUnavailable,
} = require('./admin-activity-route-helpers');
const { createActivityReadCache, ACTIVITY_UPSTREAM_CACHE_MS } = require('./activity-read-cache');
const { strictBudgetRejection } = require('../services/operation-error-meta');
const { beginMilkTeaRequestFeedback } = require('../services/milk-tea-request-feedback');

const { QUERY_KINDS, MANUAL_ACTIONS } = require('../services/milk-tea-activity');

// 严格本地预算拒绝（budget_total/budget_method，零发送可证）→ 429 + 固定本地码。
// 与服务端业务码（400）区分；缓存保留、不自动重试。普通错误仍走 502。
const MILK_TEA_RATE_LIMIT_CODE = 'MILK_TEA_RATE_LIMITED';
const MILK_TEA_RATE_LIMIT_MESSAGE = '请求过于频繁（本地发送预算已满，本次请求未发出），请稍后再试';

function sendBudgetRejection(res, err, feedback) {
  const rejection = strictBudgetRejection(err);
  if (!rejection) return false;
  feedback.set({ outcome: 'budget', code: MILK_TEA_RATE_LIMIT_CODE, governedReason: rejection.reason, ...(rejection.stage ? { stage: rejection.stage } : {}) });
  res.status(429).json({
    ok: false,
    error: MILK_TEA_RATE_LIMIT_MESSAGE,
    code: MILK_TEA_RATE_LIMIT_CODE,
    governedReason: rejection.reason,
    ...(rejection.stage ? { stage: rejection.stage } : {}),
  });
  return true;
}

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
  requestFeedback,
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
    const feedback = beginMilkTeaRequestFeedback(res, { route: 'snapshot' }, requestFeedback ? { store: requestFeedback } : undefined);
    try {
      if (!requireConnectedAccount(res, provider, accountId, '获取奶茶热销中失败: 账号未运行')) {
        feedback.set({ outcome: 'not_ready' });
        return;
      }
      // 与查询/操作路由同序：连接（零上游）→ 运行态（连接含 login ready）→ 才触达 provider
      const running = await provider.isAccountRunning(accountId);
      if (!running) {
        feedback.set({ outcome: 'not_ready' });
        res.json({ ok: false, error: '获取奶茶热销中失败: 账号未运行' });
        return;
      }
      const result = await activityReader.read(
        `/api/activity/milk-tea:${accountId}`,
        () => provider.getMilkTeaActivity(accountId),
      );
      feedback.set({ outcome: 'succeeded' });
      res.json({
        ok: true,
        activity: result.value,
        upstreamCached: result.upstreamCached,
        upstreamCacheMs: ACTIVITY_UPSTREAM_CACHE_MS,
      });
    }
    catch (err) {
      if (err?.business === true && err.code === 'SEASON_WISH_MILK_TEA_ENDED') {
        feedback.set({ outcome: 'business', code: err.code });
        res.json({ ok: false, unavailable: true, expired: true, error: '奶茶热销中已过最终截止时间' });
        return;
      }
      if (sendBudgetRejection(res, err, feedback)) return;
      if (sendActivityUnavailable(res, err)) {
        feedback.set({ outcome: 'unavailable' });
        return;
      }
      feedback.set({ outcome: 'transport', ...(err?.milkTeaStage ? { stage: err.milkTeaStage } : {}) });
      sendProviderError(res, err);
    }
  });

  app.post('/api/activity/milk-tea/query', async (req, res) => {
    const accountId = getAuthorizedAccountId(req, res, routeContext);
    if (!accountId) return;
    const body = req.body || {};
    const kind = String(body.kind || '').trim();
    const feedback = beginMilkTeaRequestFeedback(res, { route: 'query', ...(Object.prototype.hasOwnProperty.call(QUERY_KINDS, kind) ? { action: kind } : {}) }, requestFeedback ? { store: requestFeedback } : undefined);
    if (!Object.prototype.hasOwnProperty.call(QUERY_KINDS, kind)) {
      feedback.set({ outcome: 'rejected_input' });
      res.status(400).json({ ok: false, error: `未开放的查询类型: ${kind || '(空)'}` });
      return;
    }
    try {
      if (!requireConnectedAccount(res, provider, accountId, '奶茶查询失败: 账号未运行')) {
        feedback.set({ outcome: 'not_ready' });
        return;
      }
      const running = await provider.isAccountRunning(accountId);
      if (!running) {
        feedback.set({ outcome: 'not_ready' });
        res.status(409).json({ ok: false, error: '账号未运行，无法执行奶茶查询' });
        return;
      }
      const params = body.params && typeof body.params === 'object' ? body.params : {};
      // 查询参数进入缓存键：同参数 60s 内合并，参数变化不串数据
      const result = await activityReader.read(
        `/api/activity/milk-tea/query:${normalizeQueryKey(kind, params)}:${accountId}`,
        () => provider.queryMilkTeaActivity(accountId, kind, params),
      );
      feedback.set({ outcome: 'succeeded' });
      res.json({ ok: true, ...result.value, upstreamCached: result.upstreamCached });
    }
    catch (err) {
      if (sendBudgetRejection(res, err, feedback)) return;
      const businessCode = err && err.business === true && typeof err.code === 'string'
        ? err.code
        : '';
      if (businessCode) {
        feedback.set({ outcome: 'business', code: businessCode, ...(err.milkTeaStage ? { stage: err.milkTeaStage } : {}) });
        res.status(400).json({ ok: false, error: (err && err.message) || '奶茶查询失败', code: businessCode });
        return;
      }
      feedback.set({ outcome: 'transport', ...(err?.milkTeaStage ? { stage: err.milkTeaStage } : {}) });
      sendProviderError(res, err);
    }
  });

  app.post('/api/activity/milk-tea/operate', async (req, res) => {
    const accountId = getAuthorizedAccountId(req, res, routeContext);
    if (!accountId) return;
    const body = req.body || {};
    const action = String(body.action || '').trim();
    const feedback = beginMilkTeaRequestFeedback(res, { route: 'operate', ...(MANUAL_ACTIONS.has(action) ? { action } : {}) }, requestFeedback ? { store: requestFeedback } : undefined);
    if (!MANUAL_ACTIONS.has(action)) {
      feedback.set({ outcome: 'rejected_input' });
      res.status(400).json({ ok: false, error: `未开放的操作: ${action || '(空)'}` });
      return;
    }
    const input = body.input && typeof body.input === 'object' ? body.input : {};
    try {
      // 与查询路由同序：先连接（零上游）再运行态，最后才触达 provider
      if (!requireConnectedAccount(res, provider, accountId, '奶茶操作失败: 账号未运行')) {
        feedback.set({ outcome: 'not_ready' });
        return;
      }
      const running = await provider.isAccountRunning(accountId);
      if (!running) {
        feedback.set({ outcome: 'not_ready' });
        res.status(409).json({ ok: false, error: '账号未运行，无法执行活动操作' });
        return;
      }
      const result = await provider.operateMilkTea(accountId, action, input);
      // 写成功或结果未知：服务端状态可能已变化，清该账号全部奶茶相关缓存
      if (!result || result.outcome === 'unknown' || result.ok === true || (Array.isArray(result.results) && result.results.some(row => row?.success === true))) {
        activityReader.clear(accountId);
      }
      // 写前业务拒绝（400 已由 catch 分支处理）不会走到这里；成功/未知结果原样透传
      feedback.set({ outcome: result?.outcome === 'unknown' ? 'unknown_write' : result?.ok === true ? 'succeeded' : 'partial' });
      res.json({ ok: !!(result && result.ok === true), ...(result || {}) });
    }
    catch (err) {
      if (sendBudgetRejection(res, err, feedback)) return;
      const businessCode = err && err.business === true && typeof err.code === 'string'
        ? err.code
        : '';
      if (businessCode === 'SEASON_WISH_MILK_TEA_CANDIDATE_CHANGED') activityReader.clear(accountId);
      feedback.set({
        outcome: businessCode ? 'business' : 'transport',
        ...(businessCode ? { code: businessCode } : {}),
        ...(err && err.milkTeaStage ? { stage: err.milkTeaStage } : {}),
      });
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
