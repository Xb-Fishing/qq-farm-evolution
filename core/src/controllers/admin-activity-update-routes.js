const activity = require('../services/activity');
const {
  getActivityUpdateState,
  MANUAL_SCAN_UPSTREAM_CACHE_MS,
  runActivityUpdateScan,
  startActivityUpdateMonitor,
} = require('../services/activity-update-monitor');
const activityEvolver = require('../services/activity-evolver');

const NON_FAILURE_EVOLUTION_START_REASONS = new Set([
  'busy',
  'blocked',
  'deferred',
  'report_unavailable',
  'no_candidates',
]);

function selectUnknownOnlineActivities(activities, knownIds) {
  const known = new Set((knownIds || []).map(Number));
  const seen = new Set();
  return (activities || []).filter((item) => {
    const id = Number(item?.id);
    if (!Number.isFinite(id) || id <= 0 || known.has(id) || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function selectActivitySnapshotRoots(activities, candidates) {
  const byId = new Map((activities || []).map(item => [Number(item?.id), item]));
  const roots = new Map();
  for (const candidate of candidates || []) {
    let current = candidate;
    const seen = new Set();
    while (Number(current?.parentId) > 0 && !seen.has(Number(current?.id))) {
      seen.add(Number(current?.id));
      const parent = byId.get(Number(current.parentId));
      if (!parent) break;
      current = parent;
    }
    const rootId = Number(current?.id);
    if (rootId > 0 && !roots.has(rootId)) roots.set(rootId, current);
  }
  return [...roots.values()].slice(0, 20);
}

function selectKnownActivityReviewRoots(activities, knownIds, nowSeconds = Math.floor(Date.now() / 1000)) {
  const known = new Set((knownIds || []).map(Number));
  return (activities || [])
    .filter((item) => {
      const id = Number(item?.id);
      const parentId = Number(item?.parentId) || 0;
      const startTime = Number(item?.startTime) || 0;
      const endTime = Number(item?.endTime) || 0;
      return id > 0
        && known.has(id)
        && parentId === 0
        && item?.visible !== false
        && (!startTime || startTime <= nowSeconds)
        && (!endTime || endTime >= nowSeconds);
    })
    .sort((a, b) => Number(b?.enabled) - Number(a?.enabled) || Number(b?.endTime) - Number(a?.endTime))
    .slice(0, 4);
}

function buildEvolutionStartResponse(result, evolve) {
  if (result?.ok) {
    return { statusCode: 200, body: { ok: true, started: true, evolve } };
  }
  const reason = String(result?.reason || 'failed');
  const message = String(result?.error || '启动进化失败');
  if (NON_FAILURE_EVOLUTION_START_REASONS.has(reason)) {
    return {
      statusCode: 200,
      body: { ok: true, started: false, reason, message, evolve },
    };
  }
  return {
    statusCode: 400,
    body: { ok: false, reason, error: message },
  };
}

function registerAdminActivityUpdateRoutes({ app, provider, store, requireAdminToken }) {
  const knownActivityIds = Object.entries(activity)
    .filter(([key, value]) => key.endsWith('_ACTIVITY_ID') && Number.isFinite(Number(value)))
    .map(([, value]) => Number(value));
  const scanOnlineActivities = async (knownIds) => {
    const accounts = provider.getAccounts()?.accounts || [];
    const account = accounts.find((item) => {
      if (!item.running || !provider.isAccountRunning(item.id)) return false;
      const status = provider.getStatus(item.id);
      return !!status?.connection?.connected;
    });
    if (!account) {
      return {
        available: false,
        error: '没有已连接账号，暂时无法调用 ActivityService.List',
        activities: [],
        groups: [],
        unknownActivityIds: [],
      };
    }

    const activities = await provider.getActivityDiscoveryList(account.id);
    // 活动 ID 是内容批次标识，不保证按开放日期单调递增。例如服务端可能在 8 月
    // 才开放 7 月批次 ID；在线 List 已经是权威发现源，不能再用历史最大 ID 过滤。
    const unknown = selectUnknownOnlineActivities(activities, knownIds);
    const groups = [];
    // 只读取 List 已明确下发的活动根节点。子节点随根 GetGroup 一次返回，禁止按
    // 日期枚举未发布 ID，也禁止逐个对子节点做试探请求，避免命中风控诱导接口。
    for (const item of selectActivitySnapshotRoots(activities, unknown)) {
      try {
        groups.push({
          ...await provider.getActivityGroupSnapshot(account.id, item.id, ''),
          reviewKind: 'candidate',
        });
      } catch (error) {
        groups.push({ id: item.id, title: item.title, reviewKind: 'candidate', error: error.message || String(error) });
      }
    }
    // 每 30 分钟的既有活动扫描顺带复核最多 4 个当前活动根节点。这样活动 ID
    // 已登记后，活动说明、玩法和 UI 完整性仍有证据可供每日 Agent 检查；不会对
    // 每个子节点逐个请求，也不会改变任何活动状态。
    const reviewRoots = selectKnownActivityReviewRoots(activities, knownIds);
    const groupedIds = new Set(groups.map(item => Number(item?.id)));
    for (const item of reviewRoots) {
      if (groupedIds.has(Number(item.id))) continue;
      try {
        groups.push({
          ...await provider.getActivityGroupSnapshot(account.id, item.id, ''),
          reviewKind: 'known-active',
        });
      } catch (error) {
        groups.push({ id: item.id, title: item.title, reviewKind: 'known-active', error: error.message || String(error) });
      }
    }
    // 每轮既有低频活动扫描只补一次 Bag，报告保留匿名识别缺口。
    // Worker 内同一份 Bag 同时生成详情和种子列表，避免跨回包数量漂移。
    let seedRecognition = { available: false, issues: [] };
    try {
      const bag = await provider.getBag(account.id);
      if (bag?.seedRecognition) seedRecognition = bag.seedRecognition;
    } catch { /* 无库存证据不等于没有识别缺口。 */ }
    return {
      available: true,
      seedRecognition,
      accountName: account.name || account.nick || '在线账号',
      scannedAt: Date.now(),
      activities,
      groups,
      checkedActivityIds: reviewRoots.map(item => Number(item.id)),
      probes: {
        attempted: 0,
        candidates: 0,
        matched: 0,
        activityGroups: 0,
        disabledReason: '禁止枚举未由 ActivityService.List 下发的活动 ID',
      },
      unknownActivityIds: unknown.map(item => Number(item.id)),
    };
  };
  startActivityUpdateMonitor({
    knownActivityIds,
    onlineScanner: scanOnlineActivities,
    localScanEnabled: String(process.env.ACTIVITY_LOCAL_SCAN_ENABLED || '').toLowerCase() === 'true',
    // 每次扫描后把报告交给进化服务：发现新活动/活动结束时每日最多触发一次代码进化
    onReport: report => activityEvolver.checkAndMaybeEvolve(report),
  });
  activityEvolver.startActivityEvolver({ store });

  app.get('/api/activity/update/status', requireAdminToken, (req, res) => {
    res.json({
      ok: true,
      ...getActivityUpdateState(),
      upstreamCacheMs: MANUAL_SCAN_UPSTREAM_CACHE_MS,
      evolve: activityEvolver.getEvolveState(),
    });
  });

  app.post('/api/activity/update/scan', requireAdminToken, async (req, res) => {
    try {
      const previousScannedAt = Number(getActivityUpdateState().report?.scannedAt) || 0;
      const report = await runActivityUpdateScan({ maxAgeMs: MANUAL_SCAN_UPSTREAM_CACHE_MS });
      res.json({
        ok: true,
        report,
        ...getActivityUpdateState(),
        upstreamCached: previousScannedAt > 0 && Number(report?.scannedAt) === previousScannedAt,
        upstreamCacheMs: MANUAL_SCAN_UPSTREAM_CACHE_MS,
        evolve: activityEvolver.getEvolveState(),
      });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message || '活动更新扫描失败' });
    }
  });

  app.post('/api/activity/update/evolve', requireAdminToken, (req, res) => {
    const task = String(req.query.task || req.body?.task || 'activity') === 'safety' ? 'safety' : 'activity';
    const force = task === 'activity'
      && ['1', 'true'].includes(String(req.query.force ?? req.body?.force ?? '').toLowerCase());
    const result = activityEvolver.runEvolutionNow(task, { force });
    const response = buildEvolutionStartResponse(result, activityEvolver.getEvolveState());
    res.status(response.statusCode).json(response.body);
  });

  app.post('/api/activity/update/agent', requireAdminToken, (req, res) => {
    const result = activityEvolver.setEvolutionAgent(req.body?.agent);
    if (!result.ok) return res.status(400).json({ ok: false, error: result.error });
    res.json({ ok: true, evolve: activityEvolver.getEvolveState() });
  });

  app.post('/api/activity/update/instruction', requireAdminToken, (req, res) => {
    const result = activityEvolver.setEvolutionInstruction(req.body?.instruction);
    if (!result.ok) return res.status(400).json({ ok: false, error: result.error });
    res.json({ ok: true, evolve: activityEvolver.getEvolveState() });
  });

  app.post('/api/activity/update/revise', requireAdminToken, async (req, res) => {
    const result = await activityEvolver.reviseEvolution(req.body?.instruction);
    if (!result.ok) return res.status(400).json({ ok: false, error: result.error, reverted: result.reverted });
    res.json({ ok: true, ...result, evolve: activityEvolver.getEvolveState() });
  });

  app.post('/api/activity/update/notify-test', requireAdminToken, async (req, res) => {
    try {
      const { sendFeishuText } = require('../services/feishu-notify');
      await sendFeishuText('农场 bot 通知', '面板「发送测试通知」按钮触发：飞书通道正常 ✅');
      res.json({ ok: true });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message || '通知发送失败' });
    }
  });

  app.post('/api/activity/update/apply', requireAdminToken, (req, res) => {
    const result = activityEvolver.applyEvolution();
    if (!result.ok) return res.status(400).json({ ok: false, error: result.error });
    res.json({ ok: true, evolve: activityEvolver.getEvolveState() });
  });
}

module.exports = {
  buildEvolutionStartResponse,
  registerAdminActivityUpdateRoutes,
  selectKnownActivityReviewRoots,
  selectActivitySnapshotRoots,
  selectUnknownOnlineActivities,
};
