const activity = require('../services/activity');
const {
  getActivityUpdateState,
  runActivityUpdateScan,
  startActivityUpdateMonitor,
} = require('../services/activity-update-monitor');
const activityEvolver = require('../services/activity-evolver');

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
    const newestKnownId = known.size ? Math.max(...known) : 0;
    const unknown = activities.filter(item => Number(item.id) > newestKnownId && !known.has(Number(item.id)));
    const groups = [];
    for (const item of unknown.slice(0, 20)) {
      try {
        groups.push(await provider.getActivityGroupSnapshot(account.id, item.id, ''));
      } catch (error) {
        groups.push({ id: item.id, title: item.title, error: error.message || String(error) });
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
    const result = activityEvolver.runEvolutionNow(task);
    if (!result.ok) return res.status(400).json({ ok: false, error: result.error });
    res.json({ ok: true, evolve: activityEvolver.getEvolveState() });
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

module.exports = { registerAdminActivityUpdateRoutes };
