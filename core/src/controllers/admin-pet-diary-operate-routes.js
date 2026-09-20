/**
 * 萌宠成长日记（S3）手动操作路由
 *
 * 写操作仅由面板手动触发（不做自动任务）；成功后清除只读缓存，
 * 面板立即重新读取最新活动状态。错误透传给前端（业务码 + 消息），
 * 服务端不做自动重试。
 */
const { createActivityReadCache, ACTIVITY_UPSTREAM_CACHE_MS } = require('./activity-read-cache');

const { OPERATIONS } = require('../services/pet-diary-operate');

// 手动模式开放的操作白名单（夺宝/好友交互暂不开放）
const MANUAL_ACTIONS = new Set(Object.keys(OPERATIONS));

function registerAdminPetDiaryOperateRoutes({
  app,
  provider,
  getAccountIdFromRequest,
  canAccessAccount,
  activityReader = createActivityReadCache({ ttlMs: ACTIVITY_UPSTREAM_CACHE_MS }),
}) {
  const routeContext = {
    getAccountIdFromRequest,
    canAccessAccount,
  };

  function getAuthorizedAccountId(req, res) {
    const accountId = routeContext.getAccountIdFromRequest(req);
    if (!accountId) return '';
    if (!routeContext.canAccessAccount(req, accountId)) {
      res.status(403).json({ ok: false, error: '无权访问该账号' });
      return '';
    }
    return accountId;
  }

  app.post('/api/activity/pet-diary/operate', async (req, res) => {
    const accountId = getAuthorizedAccountId(req, res);
    if (!accountId) return;

    const action = String((req.body || {}).action || '').trim();
    if (!MANUAL_ACTIONS.has(action)) {
      res.status(400).json({ ok: false, error: `未开放的操作: ${action || '(空)'}` });
      return;
    }
    const input = (req.body || {}).input || {};

    try {
      const providerRunning = await provider.isAccountRunning(accountId);
      if (!providerRunning) {
        res.status(409).json({ ok: false, error: '账号未运行，无法执行活动操作' });
        return;
      }
      const result = await provider.operatePetDiary(accountId, action, input);
      // 操作已改变服务端状态，清除只读缓存让面板拉新
      activityReader.clear(accountId);
      res.json({ ok: true, ...result });
    } catch (err) {
      // 业务前置拒绝（元数据经 Worker 管理通道还原）返回 400 + 固定 code；
      // 普通传输失败或未知异常仍为 502，不按错误文字猜业务类型，不改成成功
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

module.exports = { registerAdminPetDiaryOperateRoutes };
