const { getDailyFeedback, feedbackContext, newFeedbackTrace, TRACE_RE } = require('../services/daily-feedback');

function failureReason(value) {
  const text = typeof value === 'string' ? value.slice(0, 1000) : '';
  if (/timeout|timed out|超时/i.test(text)) return 'timeout';
  if (/未运行|未就绪|未登录|not ready|not running/i.test(text)) return 'not_ready';
  if (/无权|权限|unauthorized|forbidden/i.test(text)) return 'permission';
  if (/不足|余额|not enough|insufficient/i.test(text)) return 'insufficient_resources';
  if (/参数|缺少|未开放|invalid input|missing/i.test(text)) return 'invalid_input';
  if (/网络|连接|network|connection/i.test(text)) return 'network';
  return 'unknown';
}

function requestOutcome(status, body, aborted) {
  if (aborted) return 'aborted';
  if (status >= 400 || body?.ok === false || body?.success === false) return status >= 400 && status < 500 ? 'rejected' : 'failed';
  const data = body?.data;
  if (data?.ok === false || data?.success === false) return 'failed';
  if ((Number(data?.failedCount) || Number(data?.failed)) > 0) return 'partial';
  if (status === 202 || body?.started === true || data?.started === true) return 'accepted';
  return 'succeeded';
}

function createFeedbackMiddleware({ hasAdminToken, feedback = getDailyFeedback() }) {
  return (req, res, next) => {
    if (!req.path.startsWith('/api/') || req.path.startsWith('/api/diagnostics/')) return next();
    if (!hasAdminToken(String(req.headers['x-admin-token'] || ''))) return next();
    const incoming = req.headers['x-feedback-id'];
    const linkedClick = typeof incoming === 'string' && TRACE_RE.test(incoming);
    const trace = linkedClick ? incoming : newFeedbackTrace();
    const startedAt = Date.now();
    let body;
    let finished = false;
    const originalJson = res.json;
    res.json = function (value) {
      // Keep only primitive result flags/counters; no response objects retained.
      body = { data: {} };
      body.reason = failureReason(value?.error || value?.data?.error);
      for (const key of ['ok', 'success', 'started']) {
        if (typeof value?.[key] === 'boolean') body[key] = value[key];
      }
      for (const key of ['ok', 'success', 'started', 'failedCount', 'failed', 'successCount', 'changedCount', 'itemCount']) {
        const field = value?.data?.[key];
        if (typeof field === 'boolean' || Number.isFinite(field)) body.data[key] = field;
      }
      return originalJson.call(this, value);
    };
    const finish = aborted => {
      if (finished) return;
      finished = true;
      try {
        const route = req.route?.path;
        if (typeof route !== 'string') return;
        const outcome = requestOutcome(res.statusCode, body, aborted);
        // Record every write, every request connected to a click, and every failed read.
        // Quiet successful polling is not user feedback and would obscure actual clicks.
        if (['GET', 'HEAD'].includes(req.method) && !linkedClick && outcome === 'succeeded') return;
        feedback.record({ kind: 'request', action: `${req.method} ${route}`, trace, outcome,
          reason: ['failed', 'rejected', 'partial'].includes(outcome) ? body?.reason || 'unknown' : undefined,
          operation: ['/api/activity/pet-diary/operate', '/api/farm/operate', '/api/friends/:gid/operate'].includes(route)
            ? req.body?.action || req.body?.opType : undefined,
          httpStatus: res.statusCode, durationMs: Date.now() - startedAt, ...Object.fromEntries(
            ['successCount', 'failedCount', 'changedCount', 'itemCount'].filter(key => Number.isFinite(body?.data?.[key])).map(key => [key, body.data[key]])),
        });
      } catch { /* Observability never changes the request result. */ }
    };
    res.once('finish', () => finish(false));
    res.once('close', () => finish(!res.writableFinished));
    feedbackContext.run({ trace }, next);
  };
}

function registerAdminFeedbackRoutes({ app, requireAdminToken, feedback = getDailyFeedback() }) {
  const windows = new Map();
  app.post('/api/diagnostics/feedback', requireAdminToken, (req, res) => {
    const entries = req.body?.events;
    if (!Array.isArray(entries) || entries.length > 50) return res.status(400).json({ ok: false });
    const now = Date.now();
    const token = req.adminToken;
    if (windows.size > 1000) for (const [key, value] of windows) if (now - value.at >= 60000) windows.delete(key);
    const window = windows.get(token) || { at: now, count: 0 };
    if (now - window.at >= 60000) { window.at = now; window.count = 0; }
    window.count += entries.length;
    windows.set(token, window);
    if (window.count > 600) return res.status(429).json({ ok: false });
    let accepted = 0;
    for (const item of entries) {
      if (item && ['click', 'client_error'].includes(item.kind)) {
        // Client input cannot forge backend request results or server runtime errors.
        const event = { kind: item.kind, page: item.page, target: item.target, category: item.category, trace: item.trace };
        try { if (feedback.record(event)) accepted += 1; } catch {}
      }
    }
    res.json({ ok: true, accepted });
  });
}
module.exports = { createFeedbackMiddleware, registerAdminFeedbackRoutes, requestOutcome };
