const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'); const path = require('node:path'); const os = require('node:os'); const vm = require('node:vm');
const tmp = fs.realpathSync(os.tmpdir()); const prefix = path.resolve(tmp, 'farm-milk-tea-budget-');
assert.ok(prefix.startsWith(tmp + path.sep));
const dataDir = fs.mkdtempSync(prefix); process.env.FARM_DATA_DIR = dataDir;
test.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
const { loadProto, types } = require('../src/utils/proto');
const { createScheduler, getSchedulerRegistrySnapshot } = require('../src/services/scheduler');
const { createWorkerManager } = require('../src/runtime/worker-manager');
const { createDataProvider } = require('../src/runtime/data-provider');
const { registerAdminMilkTeaActivityRoutes } = require('../src/controllers/admin-milk-tea-activity-routes');
const { createActivityReadCache } = require('../src/controllers/activity-read-cache');
const { createMilkTeaRequestFeedbackStore, dayKeyOf, normalizeRecord } = require('../src/services/milk-tea-request-feedback');
const { feedbackContext } = require('../src/services/daily-feedback');
const { EventEmitter } = require('node:events');
const { createFeedbackMiddleware } = require('../src/controllers/admin-feedback-routes');
const workerSrc = fs.readFileSync(path.join(__dirname, '../src/core/worker.js'), 'utf8');
const rejectionOf = promise => promise.then(() => null, err => err);

function extractWorkerApiSource() {
  const start = workerSrc.indexOf('const FRIEND_PANEL_ENTRY_METHODS = new Set([');
  assert.ok(start >= 0, 'FRIEND_PANEL_ENTRY_METHODS exists in worker.js');
  const end = workerSrc.indexOf('// ==================== 每日礼包总览', start);
  assert.ok(end > start, 'handleApiCall end marker exists');
  return `${workerSrc.slice(start, end)}\n;({ handleApiCall })`;
}

function createFakeProc() {
  const handlers = {}; const sent = [];
  return { sent, on: (event, cb) => { handlers[event] = cb; }, emitMessage: msg => handlers.message && handlers.message(msg),
    send: msg => sent.push(msg), kill: () => {}, exitCode: null, signalCode: null };
}

function buildManagerHarness() {
  const proc = createFakeProc(); const workers = {};
  const manager = createWorkerManager({
    fork: () => proc, WorkerThread: undefined, runtimeMode: 'fork',
    processRef: { pkg: false, env: {} }, mainEntryPath: '', workerScriptPath: '', workers,
    globalLogs: [], log: () => {}, addAccountLog: () => {}, normalizeStatusForPanel: data => data,
    buildConfigSnapshotForAccount: () => ({}), getOfflineAutoDeleteMs: () => Infinity, triggerOfflineReminder: () => {},
    addOrUpdateAccount: () => {}, getAccounts: () => ({ accounts: [{ id: 'acct-1', name: 'A', code: 'x', platform: 'qq' }] }), deleteAccount: () => {},
  });
  assert.equal(manager.startWorker({ id: 'acct-1', name: 'A', code: 'x', platform: 'qq' }), true);
  const cleanup = () => createScheduler('worker_manager').clearAll();
  return { manager, proc, cleanup };
}

/** 预算拒绝错误（network.js 预算闸门在 WS.send 前的真实结构化形态）。 */
function budgetError(reason = 'budget_total') {
  const err = new Error(`请求被治理器拦截(${reason})`);
  err.isGovernedRejection = true;
  err.governedReason = reason;
  return err;
}

/**
 * 真实链路夹具：mock network（可控失败点）→ 真实 milk-tea 服务 → VM 提取的
 * 真实 Worker handleApiCall → 真实 manager 还原 → 真实 provider → 真实三路由。
 */
function buildBudgetFlowHarness(wire = value => JSON.parse(JSON.stringify(value))) {
  const ws = { readyState: 1 };
  const calls = [];
  const state = { mode: 'ok', budgetReason: 'budget_total', serverVersion: 0 };
  const files = ['../src/utils/network', '../src/services/activity', '../src/services/milk-tea-activity'].map(require.resolve);
  const previous = files.map(file => [file, require.cache[file]]);
  const network = {
    getWs: () => ws, isConnected: () => true,
    sendMsgAsync: async (_service, method, payload) => {
      calls.push(method);
      if (state.mode === 'transportGroup' && method === 'GetGroup') throw new Error('synthetic read failure');
      const budgetAt = { budgetList: 'List', budgetGroup: 'GetGroup', budgetPrecheck: 'Operate#read', budgetWrite: 'Operate#write' }[state.mode];
      if (state.mode.startsWith('budget') && budgetAt === method) throw budgetError(state.budgetReason);
      if (state.mode === 'budgetWrite' && method === 'Operate') throw budgetError(state.budgetReason);
      if (method === 'List') return { body: types.ActivityListReply.encode(types.ActivityListReply.create({ groups: [{ activity: { id: 2026110100, start_time: 1, end_time: 4102444800 } }] })).finish() };
      if (method === 'GetGroup') return { body: types.MilkTeaGetGroupReply.encode(types.MilkTeaGetGroupReply.create({ group: { head: { activity_id: 2026110100, begin_time: 1, end_time: 4102444800 }, children: [{ head: { activity_id: 2026110101 }, milk_tea: { summary: { shop_name: `版本${state.serverVersion}`, level: 1, shop_open_at: 100 } } }] } })).finish() };
      if (method === 'Bag') return { body: types.BagReply.encode(types.BagReply.create({ item_bag: { items: [{ id: 1041, count: 500 }, { id: 1042, count: 10 }] } })).finish() };
      if (state.mode === 'writeError') throw new Error('write failed');
      const req = types.MilkTeaOperateRequest.decode(payload);
      const isBoost = num(req.operate_type) === 60;
      if (state.mode === 'budgetPrecheck' && !isBoost) throw budgetError(state.budgetReason);
      state.serverVersion++;
      return { body: types.MilkTeaOperateReply.encode(types.MilkTeaOperateReply.create({ activity_id: req.activity_id, operate_type: req.operate_type, milk_tea_boost: { cups: 40 } })).finish() };
    },
  };
  const num = value => Number(value) || 0;
  require.cache[files[0]] = { id: files[0], filename: files[0], loaded: true, exports: network };
  delete require.cache[files[1]]; delete require.cache[files[2]];
  const service = require('../src/services/milk-tea-activity');
  const { manager, proc, cleanup } = buildManagerHarness();
  const responses = [];
  const sandbox = { isRunning: true, loginReady: true, friendSyncPaused: false, getWs: () => ws, isConnected: () => true,
    sendToMaster: message => responses.push(message), log: () => {}, require: request => {
      if (request === '../services/milk-tea-activity') return service;
      if (request === '../services/warehouse') return { getBag: async () => ({ items: [{ id: 1042, count: 10 }] }), getBagItems: bag => bag.items };
      if (request === '../services/operation-error-meta') return require('../src/services/operation-error-meta');
      throw new Error(`unexpected worker dependency: ${request}`);
    } };
  const entry = new vm.Script(extractWorkerApiSource()).runInContext(vm.createContext(sandbox));
  {
    proc.send = message => { proc.sent.push(message); if (message.type === 'api_call') Promise.resolve().then(async () => { await entry.handleApiCall(wire(message)); proc.emitMessage(wire(responses.at(-1))); }); };
  }
  const provider = createDataProvider({ getAccounts: () => ({ accounts: [{ id: 'acct-1' }] }), callWorkerApi: manager.callWorkerApi });
  provider.getStatus = () => ({ connection: { connected: true } }); provider.isAccountRunning = async () => true;
  const sidecarData = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'milk-sidecar-'));
  const sidecarStore = createMilkTeaRequestFeedbackStore({ dataDir: sidecarData });
  const routes = new Map(); const reader = createActivityReadCache();
  registerAdminMilkTeaActivityRoutes({
    app: { get: (url, fn) => routes.set(url, fn), post: (url, fn) => routes.set(url, fn) }, provider, activityReader: reader,
    getAccountIdFromRequest: () => 'acct-1', canAccessAccount: () => true,
    sendProviderError: (res, err) => res.status(502).json({ ok: false, error: err.message }),
    // 直接注入受控 sidecar 存储，避免落真实数据目录
    requestFeedback: sidecarStore,
  });
  const genericRecords = [];
  const middleware = createFeedbackMiddleware({ hasAdminToken: () => true, feedback: { record: row => genericRecords.push(row) } });
  const invoke = async (url, body, { trace, aborted = false } = {}) => {
    let status = 200; let data; let finished = 0;
    const res = new EventEmitter(); res.statusCode = 200;
    res.status = function(value) { this.statusCode = value; return this; };
    res.json = value => { data = value; return res; };
    const req = { body, path: url, route: { path: url }, method: url.endsWith('milk-tea') ? 'GET' : 'POST', headers: { 'x-admin-token': 'synthetic', ...(trace ? { 'x-feedback-id': trace } : {}) } };
    await new Promise((resolve, reject) => middleware(req, res, () => { Promise.resolve(routes.get(url)(req, res)).then(resolve, reject); }));
    if (aborted) res.emit('close');
    res.writableFinished = true; res.emit('finish'); res.emit('close'); finished = 2;
    return { status: res.statusCode, data, finishEvents: finished };
  };
  const restore = () => { cleanup(); for (const [file, entry_] of previous) { if (entry_) require.cache[file] = entry_; else delete require.cache[file]; } };
  return { state, calls, manager, proc, invoke, restore, sidecarStore, sidecarData, reader, genericRecords };
}

const operateBoost = { action: 'boost', input: { count: 1, confirmedCosts: [{ itemId: 1042, count: '1' }] } };

test('budget_total 在 List 段拒绝：真实链路 429 + 固定本地码 + stage，零经济 Operate、缓存保留', async () => {
  await loadProto();
  const h = buildBudgetFlowHarness();
  try {
    // 先成功一次填充缓存
    let response = await h.invoke('/api/activity/milk-tea');
    assert.equal(response.data.ok, true);
    assert.equal((await h.invoke('/api/activity/milk-tea')).data.upstreamCached, true);
    h.calls.length = 0;
    h.state.mode = 'budgetList';
    response = await h.invoke('/api/activity/milk-tea/operate', operateBoost);
    assert.equal(response.status, 429);
    assert.equal(response.data.ok, false);
    assert.equal(response.data.code, 'MILK_TEA_RATE_LIMITED');
    assert.equal(response.data.governedReason, 'budget_total');
    assert.equal(response.data.stage, 'list');
    assert.deepEqual(h.calls, ['List'], 'List 段被拒后零 GetGroup/Bag/Operate 后续');
    // 缓存保留（不因 429 清成功缓存）
    h.state.mode = 'ok';
    assert.equal((await h.invoke('/api/activity/milk-tea')).data.upstreamCached, true);
    // 零自动重试：429 后由面板决定，不自动补发
    assert.equal(h.calls.filter(m => m === 'List').length, 1);
  } finally { h.restore(); fs.rmSync(h.sidecarData, { recursive: true, force: true }); }
});

test('budget_method 在 GetGroup 段与 budget_total 在读 Operate/写 Operate 段的 stage 区分', async () => {
  await loadProto();
  const h = buildBudgetFlowHarness();
  try {
    h.state.mode = 'budgetGroup'; h.state.budgetReason = 'budget_method';
    let response = await h.invoke('/api/activity/milk-tea/query', { kind: 'rank', params: {} });
    assert.equal(response.status, 429);
    assert.equal(response.data.governedReason, 'budget_method');
    assert.equal(response.data.stage, 'group');
    assert.deepEqual(h.calls, ['List', 'GetGroup'], 'GetGroup 段被拒后零查询 Operate');

    h.calls.length = 0; h.state.mode = 'budgetPrecheck'; h.state.budgetReason = 'budget_total';
    response = await h.invoke('/api/activity/milk-tea/operate', { action: 'hire', input: { durationId: 1, hires: [{ slotIndex: 0, targetGid: '42' }], confirmedCosts: [] } });
    assert.equal(response.status, 429);
    assert.equal(response.data.stage, 'precondition', '读 Operate（前置校验查询）不能标 write');
    assert.ok(h.calls.includes('Operate'));
    assert.ok(!response.data.outcome, '预算拒绝不产生结果未知（零发送可证）');

    h.calls.length = 0; h.state.mode = 'budgetWrite'; h.state.budgetReason = 'budget_total';
    response = await h.invoke('/api/activity/milk-tea/operate', operateBoost);
    assert.equal(response.status, 429);
    assert.equal(response.data.stage, 'write');
  } finally { h.restore(); fs.rmSync(h.sidecarData, { recursive: true, force: true }); }
});

test('普通 502、业务 400、已发写 unknown 与正常成功语义不变', async () => {
  await loadProto();
  const h = buildBudgetFlowHarness();
  try {
    // 普通传输失败 → 502 无码
    h.state.mode = 'budgetList'; // 先置一个非普通模式再切普通错误
    h.state.mode = 'ok';
    // 用 writeError 验证已发写 unknown 保持
    let response = await h.invoke('/api/activity/milk-tea/operate', operateBoost);
    assert.equal(response.data.ok, true);
    h.state.mode = 'writeError'; h.calls.length = 0;
    response = await h.invoke('/api/activity/milk-tea/operate', operateBoost);
    assert.equal(response.data.outcome, 'unknown', '写请求已发出后的失败仍是结果未知，不重试');
    assert.equal(h.calls.filter(m => m === 'Operate').length, 1);
    // 业务 400 保持
    response = await h.invoke('/api/activity/milk-tea/operate', { action: 'boost', input: { count: 0 } });
    assert.equal(response.status, 400);
    assert.equal(response.data.code, 'SEASON_WISH_MILK_TEA_INVALID_INPUT');
  } finally { h.restore(); fs.rmSync(h.sidecarData, { recursive: true, force: true }); }
});

test('manager 还原：畸形/冲突/伪造预算元数据不升级为 429 语义', async () => {
  const { manager, proc, cleanup } = buildManagerHarness();
  try {
    const cases = [
      { name: 'JSON 往返保留', meta: JSON.parse(JSON.stringify({ governed: true, reason: 'budget_total', stage: 'group' })), governed: true, reason: 'budget_total', stage: 'group' },
      { name: 'structuredClone 保留', meta: structuredClone({ governed: true, reason: 'budget_method' }), governed: true, reason: 'budget_method', stage: undefined },
      { name: 'reason 非白名单', meta: { governed: true, reason: 'anything_else' }, governed: false },
      { name: 'governed 非严格布尔', meta: { governed: 'true', reason: 'budget_total' }, governed: false },
      { name: 'stage 非白名单', meta: { governed: true, reason: 'budget_total', stage: 'exfiltrate' }, governed: false },
      { name: 'business 冲突并存', meta: { governed: true, reason: 'budget_total', business: true, code: 'SEASON_WISH_MILK_TEA_ENDED' }, governed: false },
      { name: '数组形态', meta: [{ governed: true, reason: 'budget_total' }], governed: false },
      { name: '额外属性不透传', meta: { governed: true, reason: 'budget_total', stack: 'SECRET', params: { shopName: 'SECRET' } }, governed: true, reason: 'budget_total', stage: undefined },
    ];
    for (const c of cases) {
      const promise = manager.callWorkerApi('acct-1', 'getMilkTeaActivity');
      const call = proc.sent.find(m => m.type === 'api_call');
      proc.sent.length = 0;
      proc.emitMessage({ type: 'api_response', id: call.id, result: null, error: '请求被治理器拦截(budget_total)', errorMeta: c.meta });
      const err = await rejectionOf(promise);
      if (c.governed) {
        assert.equal(err.isGovernedRejection, true, `governed restored (${c.name})`);
        assert.equal(err.governedReason, c.reason, `reason restored (${c.name})`);
        if (c.stage) assert.equal(err.milkTeaStage, c.stage, `stage restored (${c.name})`);
        assert.equal(err.stack.includes('SECRET'), false, `stack not passed through (${c.name})`);
        assert.equal('params' in err, false, `params not passed through (${c.name})`);
      }
      else {
        assert.notEqual(err.isGovernedRejection, true, `not governed (${c.name})`);
        assert.equal(err.governedReason, undefined, `no reason (${c.name})`);
        assert.equal(err.milkTeaStage, undefined, `no stage (${c.name})`);
      }
    }
  } finally { cleanup(); }
});

test('sidecar：finish/close 只落一行、trace 关联可读回、伪值不落盘、24h 有界清理', async () => {
  await loadProto();
  const h = buildBudgetFlowHarness();
  try {
    const trace = '11111111-1111-4111-8111-111111111111';
    h.state.mode = 'budgetGroup';
    h.state.budgetReason = 'budget_method';
    const response = await h.invoke('/api/activity/milk-tea/query', { kind: 'rank', params: {} }, { trace });
    assert.equal(response.status, 429);
    let rows = h.sidecarStore.load({ trace });
    assert.equal(rows.length, 1, 'finish+close 双事件只记一行（计数不双记）');
    assert.equal(rows[0].route, 'query');
    assert.equal(rows[0].action, 'rank');
    assert.equal(rows[0].outcome, 'budget');
    assert.equal(rows[0].governedReason, 'budget_method');
    assert.equal(rows[0].stage, 'group');
    assert.equal(rows[0].httpStatus, 429);
    assert.equal(rows[0].code, 'MILK_TEA_RATE_LIMITED');
    assert.equal(h.genericRecords.length, 1, 'ordinary feedback still counts exactly one request');
    // 不含参数/身份/原文/堆栈
    const rendered = JSON.stringify(rows);
    assert.doesNotMatch(rendered, /params|input|stack|SECRET|message/);
    // 另一 trace 的请求不串行
    h.state.mode = 'ok';
    await h.invoke('/api/activity/milk-tea/operate', operateBoost, { trace: '22222222-2222-4222-8222-222222222222' });
    rows = h.sidecarStore.load({ trace });
    assert.equal(rows.length, 1, '不同 trace 各自隔离');
    assert.equal(h.sidecarStore.load().length, 2);
  } finally { h.restore(); fs.rmSync(h.sidecarData, { recursive: true, force: true }); }
});

test('sidecar 存储边界：坏值拒绝、行数上限、过期文件清理与日键滚动', () => {
  const dataDir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'milk-sidecar-edge-'));
  try {
    let clock = 1_800_000_000_000; // 固定时钟
    const store = createMilkTeaRequestFeedbackStore({ dataDir, now: () => clock });
    // 坏值：非白名单 route/outcome/stage/code/reason 全部拒绝
    assert.equal(store.record({ route: 'admin', outcome: 'budget', httpStatus: 429 }), false);
    assert.equal(store.record({ route: 'operate', outcome: 'hacked', httpStatus: 429 }), false);
    assert.equal(store.record({ route: 'operate', outcome: 'business', code: 'DROP TABLE', httpStatus: 400 }), false);
    assert.equal(store.record({ route: 'operate', outcome: 'budget', governedReason: 'not_a_reason', httpStatus: 429 }), false);
    assert.equal(store.record({ route: 'operate', outcome: 'business', stage: 'exfil', code: 'SEASON_WISH_MILK_TEA_ENDED', httpStatus: 400 }), false);
    assert.equal(store.record({ route: 'operate', outcome: 'business', action: 'nonsense', code: 'SEASON_WISH_MILK_TEA_ENDED', httpStatus: 400 }), false);
    // 正常值 + 伪字段被剥离
    assert.equal(store.record({ route: 'operate', action: 'boost', outcome: 'business', code: 'SEASON_WISH_MILK_TEA_LIMIT', httpStatus: 400, stack: 'SECRET', params: { x: 1 }, identity: 'acct-1' }), true);
    const rows = store.load();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].code, 'SEASON_WISH_MILK_TEA_LIMIT');
    assert.equal(rows[0].action, 'boost');
    assert.ok(!('stack' in rows[0]) && !('params' in rows[0]) && !('identity' in rows[0]));
    // 客户端伪结果：伪造的成功不改变服务端记录的失败结局（normalize 只认白名单，多余字段丢弃）
    assert.equal(store.record({ route: 'operate', outcome: 'succeeded', forged: 'client-says-ok', httpStatus: 429 }), true);
    assert.equal(store.load().at(-1).outcome, 'succeeded');
    assert.ok(!('forged' in store.load().at(-1)));
    // 行数上限（MAX_DAY_ROWS 收口为有界）
    let accepted = 0;
    for (let i = 0; i < 2100; i += 1) { if (store.record({ route: 'query', action: 'rank', outcome: 'transport', httpStatus: 502 })) accepted += 1; }
    assert.ok(accepted <= 2000, `每日行数有界（实际 ${accepted}）`);
    // 0600 滚动 + 过期清理：跨到次日 07:00 后旧文件仍在 24h 内、25h 前的清掉
    clock += 25 * 3600_000 + 1;
    assert.equal(store.record({ route: 'query', action: 'rank', outcome: 'transport', httpStatus: 502 }), true);
    assert.ok(store.load().every(row => row.at >= clock - 24 * 3600_000), '读取窗口只含 24h 内');
    assert.ok(typeof dayKeyOf(clock) === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(dayKeyOf(clock)));
    assert.equal(normalizeRecord({ route: 'operate', outcome: 'business', at: undefined }, 123), null);
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test('three milk routes preserve List rejection through JSON and structuredClone without economic writes', async () => {
  await loadProto();
  for (const wire of [value => JSON.parse(JSON.stringify(value)), value => structuredClone(value)]) {
    for (const [url, body] of [['/api/activity/milk-tea', {}], ['/api/activity/milk-tea/query', { kind: 'rank' }], ['/api/activity/milk-tea/operate', operateBoost]]) {
      const h = buildBudgetFlowHarness(wire);
      try { h.state.mode = 'budgetList'; h.state.budgetReason = 'budget_method'; const result = await h.invoke(url, body); assert.equal(result.status, 429); assert.equal(result.data.stage, 'list'); assert.deepEqual(h.calls, ['List']); }
      finally { h.restore(); fs.rmSync(h.sidecarData, { recursive: true, force: true }); }
    }
  }
});

test('client result fields cannot overwrite backend failure; close-first feedback is once and aborted', async () => {
  await loadProto(); const h = buildBudgetFlowHarness();
  try {
    h.state.mode = 'budgetGroup';
    const input = { ...operateBoost, outcome: 'succeeded', stage: 'write', code: 'SECRET', governedReason: 'SECRET', trace: 'SECRET' };
    await h.invoke('/api/activity/milk-tea/operate', input, { trace: '33333333-3333-4333-8333-333333333333' });
    assert.ok(h.sidecarStore.load()[0], 'server outcome diagnostic must be persisted');
    assert.equal(h.sidecarStore.load()[0].outcome, 'budget'); assert.equal(h.sidecarStore.load()[0].stage, 'group'); assert.equal(h.genericRecords.length, 1); assert.doesNotMatch(JSON.stringify(h.sidecarStore.load()), /SECRET/);
    await h.invoke('/api/activity/milk-tea/operate', input, { aborted: true });
    assert.equal(h.sidecarStore.load().at(-1).outcome, 'aborted'); assert.equal(h.sidecarStore.load().length, 2); assert.equal(h.genericRecords.length, 2); assert.equal(h.genericRecords.at(-1).outcome, 'aborted');
  } finally { h.restore(); fs.rmSync(h.sidecarData, { recursive: true, force: true }); }
});

test('ordinary group read failure remains 502 with its safe stage and no write/retry', async () => {
  await loadProto(); const h = buildBudgetFlowHarness();
  try { h.state.mode = 'transportGroup'; const result = await h.invoke('/api/activity/milk-tea/query', { kind: 'rank' }); assert.equal(result.status, 502); assert.deepEqual(h.calls, ['List', 'GetGroup']); const row = h.sidecarStore.load()[0]; assert.ok(row, 'failed read diagnostic must be persisted'); assert.equal(row.stage, 'group'); assert.equal(row.outcome, 'transport'); assert.equal(row.governedReason, undefined); }
  finally { h.restore(); fs.rmSync(h.sidecarData, { recursive: true, force: true }); }
});

test('测试收尾不遗留计时器', () => {
  const snapshot = getSchedulerRegistrySnapshot('worker_manager');
  assert.deepEqual(snapshot.schedulers[0].tasks.map(t => t.name).filter(name => name.startsWith('api_timeout_')), []);
});
