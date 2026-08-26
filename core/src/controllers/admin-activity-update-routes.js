const activity = require('../services/activity');
const {
  getActivityUpdateState,
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
  const MAX_DATE_PROBES_PER_SCAN = 6;
  const knownActivityIds = Object.entries(activity)
    .filter(([key, value]) => key.endsWith('_ACTIVITY_ID') && Number.isFinite(Number(value)))
    .map(([, value]) => Number(value));
  const buildDateProbeIds = (days = 3, slots = 10) => {
    const ids = [];
    const now = new Date();
    for (let offset = 0; offset <= days; offset += 1) {
      const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset);
      const prefix = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`;
      for (let slot = 0; slot < slots; slot += 1) ids.push(Number(`${prefix}${String(slot).padStart(2, '0')}`));
    }
    return ids;
  };
  const selectRotatingProbeIds = (ids, now = Date.now()) => {
    const candidates = [...new Set((ids || []).map(Number).filter(id => id > 0))];
    if (candidates.length <= MAX_DATE_PROBES_PER_SCAN) return candidates;
    // 活动 List 是主发现链；日期 ID 只是兜底。每 30 分钟轮换一小段，避免一次连续
    // 枚举 40-50 个未发布 ID，数小时内仍能覆盖全部候选。
    const bucket = Math.floor(now / (30 * 60 * 1000));
    const start = (bucket * MAX_DATE_PROBES_PER_SCAN) % candidates.length;
    return Array.from(
      { length: MAX_DATE_PROBES_PER_SCAN },
      (_, index) => candidates[(start + index) % candidates.length]
    );
  };
  const scanOnlineActivities = async (knownIds, localReport = null) => {
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
    const known = new Set((knownIds || []).map(Number));
    // 活动 ID 是内容批次标识，不保证按开放日期单调递增。例如服务端可能在 8 月
    // 才开放 7 月批次 ID；在线 List 已经是权威发现源，不能再用历史最大 ID 过滤。
    const unknown = selectUnknownOnlineActivities(activities, knownIds);
    const groups = [];
    for (const item of unknown.slice(0, 20)) {
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
    const listedIds = new Set(activities.map(item => Number(item.id)));
    const probeIds = [...new Set([
      ...buildDateProbeIds(),
      ...(localReport?.unknownActivityIds || []).map(Number),
    ])].filter(id => id > 0 && !known.has(id) && !listedIds.has(id));
    const selectedProbeIds = selectRotatingProbeIds(probeIds);
    const probeGroups = [];
    for (const id of selectedProbeIds) {
      try {
        const snapshot = await provider.getActivityGroupSnapshot(account.id, id, '');
        if (Number(snapshot?.id) === id && (snapshot.title || snapshot.children?.length)) {
          probeGroups.push({ ...snapshot, discoverySource: 'GetGroup probe' });
        }
      } catch {
        // 未发布 ID 返回业务错误属于正常探测结果。
      }
    }
    const probeById = new Map(probeGroups.map(item => [Number(item.id), { ...item, children: [...(item.children || [])] }]));
    const probeRoots = [];
    for (const item of probeById.values()) {
      const parent = probeById.get(Number(item.parentId));
      if (parent) {
        if (!parent.children.some(child => Number(child.id) === Number(item.id))) parent.children.push(item);
      } else {
        probeRoots.push(item);
      }
    }
    groups.push(...probeRoots);
    const unknownIds = [...new Set([
      ...unknown.map(item => Number(item.id)),
      ...probeRoots.map(item => Number(item.id)),
    ])];
    return {
      available: true,
      accountName: account.name || account.nick || '在线账号',
      scannedAt: Date.now(),
      activities,
      groups,
      checkedActivityIds: reviewRoots.map(item => Number(item.id)),
      probes: {
        attempted: selectedProbeIds.length,
        candidates: probeIds.length,
        matched: probeGroups.length,
        activityGroups: probeRoots.length,
      },
      unknownActivityIds: unknownIds,
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
    res.json({ ok: true, ...getActivityUpdateState(), evolve: activityEvolver.getEvolveState() });
  });

  app.post('/api/activity/update/scan', requireAdminToken, async (req, res) => {
    try {
      const report = await runActivityUpdateScan();
      res.json({ ok: true, report, ...getActivityUpdateState(), evolve: activityEvolver.getEvolveState() });
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
  selectUnknownOnlineActivities,
};
