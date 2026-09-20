const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { loadProto, types } = require('../src/utils/proto');
const { toNum } = require('../src/utils/utils');
const { createScheduler, getSchedulerRegistrySnapshot } = require('../src/services/scheduler');
const { createWorkerManager } = require('../src/runtime/worker-manager');
const { registerAdminPetDiaryOperateRoutes } = require('../src/controllers/admin-pet-diary-operate-routes');
const { registerAdminBearActivityRoutes } = require('../src/controllers/admin-bear-activity-routes');
const { createActivityReadCache } = require('../src/controllers/activity-read-cache');

// 萌宠手动操作业务错误跨 Worker 传递回归（2026-09-20 修复）：
// 真实调用链 = 真实 pet-diary-operate 服务（仅模拟游戏传输边界 sendMsgAsync）
// → 从 worker.js 提取的真实 handleApiCall（vm 沙箱，本地消息通道按
// JSON 序列化往返 / structuredClone 两种 Worker 传输形态模拟）
// → 真实 createWorkerManager 的 api_response 错误重建
// → 真实活动路由。业务前置拒绝必须得到 HTTP 400 + ok:false + 固定 code +
// 原有提示；普通传输失败（List / GetGroup / Operate 三处分别覆盖）仍是 502，
// 不伪造业务码，失败零自动重试、不切换接口；跨层成功使读写路由共享的
// 真实活动缓存失效，迟到旧读取不能回写缓存。

const workerSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'worker.js'), 'utf8');

function mockModule(filename, exports) {
  return { id: filename, filename, loaded: true, exports, paths: [] };
}

/** 捕获 promise 的拒绝值（assert.rejects 不返回错误对象）。 */
async function rejectionOf(promise) {
  return promise.then(() => null, err => err);
}

const PET_DIARY_GROUP_ID = 2026090100;
const PET_DIARY_PLAY_ID = 2026090101;
const PET_DIARY_SEEDS_ID = 2026090102;
const PET_DIARY_SHOP_ID = 2026090103;

const nowSec = () => Math.floor(Date.now() / 1000);

/** GetGroup 回包：可覆盖 nurture/feed/hunt/seeds/shop 子节点内容。 */
function buildGroupReply(overrides = {}) {
  const start = nowSec() - 3600;
  const end = nowSec() + 86400;
  const head = { id: PET_DIARY_PLAY_ID, start_time: start, end_time: end };
  const group = types.PetDiaryGetGroupReply.create({
    group: {
      head: { id: PET_DIARY_GROUP_ID, start_time: start, end_time: end },
      children: [
        {
          head,
          pet_treasure_hunt: {
            nurture: { cg_played: true, stage: 2, growth: 7000, dog_granted: false,
              ...(overrides.nurture || {}) },
            feed: { feed_count: 3 },
            hunt: { treasure_count: 1, treasure_cost: [{ id: 1028, count: 700 }] },
            ...(overrides.petState || {}),
            plunder: { plunder_compensation_count: 0, ...(overrides.plunder || {}) },
            story: { stories: [{ order: 1, unlocked: true, claimed: false }] },
          },
        },
        {
          head: { id: PET_DIARY_SEEDS_ID, start_time: start, end_time: end },
          mega_event: { rewards: overrides.seedRewards
            || [{ unlock_day: 1, unlocked: true, claimable: true, claimed: false }] },
        },
        {
          head: { id: PET_DIARY_SHOP_ID, start_time: start, end_time: end },
          shop: { goods: overrides.shopGoods || [] },
        },
      ],
    },
  });
  return types.PetDiaryGetGroupReply.encode(group).finish();
}

function buildListReply(listed = true, end = 0) {
  return types.ActivityListReply.encode(types.ActivityListReply.create({
    groups: listed ? [{ activity: { id: PET_DIARY_GROUP_ID, end_time: end } }] : [],
  })).finish();
}

function buildOperateReply(req, replyInput = {}) {
  const decoded = types.PetDiaryOperateRequest.decode(req);
  const reply = types.PetDiaryOperateReply.create({
    activity_id: decoded.activity_id,
    operate_type: decoded.operate_type,
    pet_treasure_hunt_draw: { rewards: [{ id: 1029, count: 5 }] },
    pet_treasure_hunt_feed: { rewards: [] },
    mega_event_claim_all: { awards: [{ id: 29004, count: 1 }] },
    ...replyInput,
  });
  return types.PetDiaryOperateReply.encode(reply).finish();
}

/**
 * 加载真实 pet-diary-operate 服务，仅在上游边界（sendMsgAsync）注入可控模拟。
 * transport.routes: { List: async () => body, GetGroup: ..., Operate: (payload) => body }
 * 每次调用都会记录到 transport.calls。
 */
async function loadRealPetDiaryService(handler) {
  await loadProto();
  const servicePath = require.resolve('../src/services/pet-diary-operate');
  const networkPath = require.resolve('../src/utils/network');
  const previous = new Map([networkPath].map(p => [p, require.cache[p]]));

  const transport = {
    calls: [],
    services: [],
    routes: {
      List: () => ({ body: buildListReply() }),
      GetGroup: () => ({ body: buildGroupReply() }),
      Operate: payload => ({ body: buildOperateReply(payload) }),
    },
  };
  require.cache[networkPath] = mockModule(networkPath, {
    sendMsgAsync: async (service, method, payload) => {
      transport.calls.push(method);
      transport.services.push(service);
      const route = transport.routes[method];
      if (!route) throw new Error(`unexpected upstream method ${method}`);
      return route(payload);
    },
  });
  delete require.cache[servicePath];
  try {
    return await handler(require(servicePath), transport);
  } finally {
    delete require.cache[servicePath];
    for (const [file, entry] of previous) {
      if (entry === undefined) delete require.cache[file];
      else require.cache[file] = entry;
    }
  }
}

/** 从 worker.js 提取真实管理入口：入口集合 + 业务错误元数据收集 + 完整 handleApiCall。 */
function extractWorkerApiSource() {
  const start = workerSrc.indexOf('const FRIEND_PANEL_ENTRY_METHODS = new Set([');
  assert.ok(start >= 0, 'FRIEND_PANEL_ENTRY_METHODS exists in worker.js');
  const end = workerSrc.indexOf('// ==================== 每日礼包总览', start);
  assert.ok(end > start, 'handleApiCall end marker exists');
  return `${workerSrc.slice(start, end)}\n;({ handleApiCall, collectPetDiaryErrorMeta })`;
}

/**
 * 把真实 handleApiCall 放进 vm 沙箱执行：require 只允许映射到真实
 * pet-diary 服务与测试仓库桩；sendToMaster 捕获 api_response。
 */
function buildWorkerEntry({ service, warehouse, activity }) {
  const responses = [];
  const sandbox = {
    isRunning: true,
    loginReady: true,
    getWs: () => ({ readyState: 1 }),
    sendToMaster: message => responses.push(message),
    log: () => {},
    friendSyncPaused: false,
    require: request => {
      if (request === '../services/pet-diary-operate') return service;
      if (request === '../services/warehouse') return warehouse;
      if (request === '../services/activity') return activity;
      throw new Error(`unexpected require from handleApiCall: ${request}`);
    },
  };
  const script = new vm.Script(extractWorkerApiSource(), { filename: 'worker.js#api-entry' });
  const { handleApiCall } = script.runInContext(vm.createContext(sandbox));
  return { handleApiCall, responses };
}

/** 假 Worker 进程：send 记录消息，message 处理器由管理器注册。 */
function createFakeProc() {
  const handlers = {};
  const sent = [];
  return {
    sent,
    on: (event, cb) => { handlers[event] = cb; },
    emitMessage: msg => handlers.message && handlers.message(msg),
    send: msg => sent.push(msg),
    kill: () => {},
    exitCode: null,
    signalCode: null,
  };
}

function buildManagerHarness() {
  const proc = createFakeProc();
  const workers = {};
  const globalLogs = [];
  const manager = createWorkerManager({
    fork: () => proc,
    WorkerThread: undefined,
    runtimeMode: 'fork',
    processRef: { pkg: false, env: {} },
    mainEntryPath: '',
    workerScriptPath: '',
    workers,
    globalLogs,
    log: () => {},
    addAccountLog: () => {},
    normalizeStatusForPanel: data => data,
    buildConfigSnapshotForAccount: () => ({}),
    getOfflineAutoDeleteMs: () => Infinity,
    triggerOfflineReminder: () => {},
    addOrUpdateAccount: () => {},
    getAccounts: () => ({ accounts: [{ id: 'acct-1', name: 'A', code: 'x', platform: 'qq' }] }),
    deleteAccount: () => {},
  });
  assert.equal(manager.startWorker({ id: 'acct-1', name: 'A', code: 'x', platform: 'qq' }), true);
  const cleanup = () => createScheduler('worker_manager').clearAll();
  return { manager, proc, cleanup };
}

const TRANSPORTS = {
  'JSON 序列化往返（fork 模式）': {
    in: msg => JSON.parse(JSON.stringify(msg)),
    out: msg => JSON.parse(JSON.stringify(msg)),
  },
  'structuredClone（thread 模式）': {
    in: msg => structuredClone(msg),
    out: msg => structuredClone(msg),
  },
};

/** 组装完整真实链：服务 → Worker 入口 → 管理器 → 活动路由。 */
async function buildCrossLayerChain({ service, transportMode, activityModule, activityReader }) {
  const warehouse = {
    getBag: async () => ({}),
    getBagItems: () => [{ id: 1028, count: 100000 }],
  };
  const workerEntry = buildWorkerEntry({ service, warehouse, activity: activityModule });
  const { manager, proc, cleanup } = buildManagerHarness();
  const transport = TRANSPORTS[transportMode];

  proc.send = msg => {
    proc.sent.push(msg);
    if (msg.type === 'api_call') {
      Promise.resolve().then(async () => {
        await workerEntry.handleApiCall(transport.in(msg));
        proc.emitMessage(transport.out(workerEntry.responses[workerEntry.responses.length - 1]));
      });
    }
  };

  const provider = {
    isAccountRunning: async () => true,
    operatePetDiary: (accountId, action, input) =>
      manager.callWorkerApi(accountId, 'operatePetDiary', action, input),
  };
  const routes = new Map();
  const app = {
    get: (url, handler) => routes.set(url, handler),
    post: (url, handler) => routes.set(url, handler),
  };
  if (activityReader) {
    // 读路由同样经真实 Worker 管理通道，并与写路由共享同一 activityReader
    provider.getStatus = () => ({ connection: { connected: true } });
    provider.getBearActivity = accountId => manager.callWorkerApi(accountId, 'getBearActivity');
    registerAdminBearActivityRoutes({
      app,
      provider,
      getAccountIdFromRequest: () => 'acct-1',
      canAccessAccount: () => true,
      sendProviderError: (_res, err) => { throw err; },
      activityReader,
    });
  }
  registerAdminPetDiaryOperateRoutes({
    app,
    provider,
    getAccountIdFromRequest: () => 'acct-1',
    canAccessAccount: () => true,
    ...(activityReader ? { activityReader } : {}),
  });

  async function invoke(url, body) {
    let status = 200;
    let payload;
    const res = {
      status(code) { status = code; return res; },
      json(data) { payload = data; },
    };
    await routes.get(url)({ body }, res);
    return { status, payload };
  }

  async function operate(action, input = {}) {
    return invoke('/api/activity/pet-diary/operate', { action, input });
  }

  async function readBear() {
    return invoke('/api/activity/bear', {});
  }

  return { manager, proc, cleanup, operate, readBear, workerEntry };
}

/** 单一场景：给出 pet-diary 服务与上游传输模拟，跑完整链路。 */
async function runCrossLayer({ transportMode, configureTransport }) {
  return loadRealPetDiaryService(async (service, transport) => {
    configureTransport(transport);
    const chain = await buildCrossLayerChain({ service, transportMode });
    return { chain, transport };
  });
}

// ==================== 1. 业务拒绝：400 + 固定 code + 原有提示 ====================

for (const modeName of Object.keys(TRANSPORTS)) {
  test(`业务前置拒绝跨层得到 400 + 固定 code（${modeName}）`, { timeout: 5000 }, async () => {
    // 投喂在成年段被拒：业务拒绝发生在 Operate 编码/写请求之前
    const { chain, transport } = await runCrossLayer({
      transportMode: modeName,
      configureTransport: t => {
        t.routes.GetGroup = () => ({ body: buildGroupReply({ nurture: { stage: 2 } }) });
      },
    });
    try {
      const { status, payload } = await chain.operate('feed');
      assert.equal(status, 400);
      assert.equal(payload.ok, false);
      assert.equal(payload.code, 'PET_DIARY_INVALID_STAGE');
      assert.equal(payload.error, '比熊当前阶段不可投喂');
      // 前置拒绝：只发生必要状态读取（List + GetGroup），零 Operate 编码/写请求
      assert.deepEqual(transport.calls, ['List', 'GetGroup']);
      assert.equal(chain.proc.sent.filter(m => m.type === 'api_call').length, 1);
    } finally {
      chain.cleanup();
    }
  });
}

// ==================== 2. 普通传输失败：502，不伪造业务码 ====================

for (const modeName of Object.keys(TRANSPORTS)) {
  test(`传输失败跨层仍为 502，无业务码，零重试（List 读取，${modeName}）`, { timeout: 5000 }, async () => {
    const { chain, transport } = await runCrossLayer({
      transportMode: modeName,
      configureTransport: t => {
        t.routes.List = () => { throw new Error('upstream transport down'); };
      },
    });
    try {
      const { status, payload } = await chain.operate('draw');
      assert.equal(status, 502);
      assert.equal(payload.ok, false);
      assert.equal(payload.code, undefined);
      assert.equal(payload.error, 'upstream transport down');
      // 失败零自动重试：只派发了一次 api_call
      assert.deepEqual(transport.calls, ['List']);
      assert.ok(transport.services.every(s => s === 'gamepb.activitypb.ActivityService'));
      assert.equal(chain.proc.sent.filter(m => m.type === 'api_call').length, 1);
    } finally {
      chain.cleanup();
    }
  });
}

for (const modeName of Object.keys(TRANSPORTS)) {
  test(`GetGroup 读取失败跨层仍为 502，无业务码，零重试，不切换接口（${modeName}）`, { timeout: 5000 }, async () => {
    const { chain, transport } = await runCrossLayer({
      transportMode: modeName,
      configureTransport: t => {
        t.routes.GetGroup = () => { throw new Error('group read failed'); };
      },
    });
    try {
      const { status, payload } = await chain.operate('draw');
      assert.equal(status, 502);
      assert.equal(payload.ok, false);
      assert.equal(payload.code, undefined);
      assert.equal(payload.error, 'group read failed');
      // 状态读取失败：零写请求（未到达 Operate）、零重试，全部调用仍在原接口
      assert.deepEqual(transport.calls, ['List', 'GetGroup']);
      assert.ok(transport.services.every(s => s === 'gamepb.activitypb.ActivityService'));
      assert.equal(chain.proc.sent.filter(m => m.type === 'api_call').length, 1);
    } finally {
      chain.cleanup();
    }
  });
}

for (const modeName of Object.keys(TRANSPORTS)) {
  test(`Operate 写请求传输失败跨层 502：写请求已尝试恰好一次、无重试（${modeName}）`, { timeout: 5000 }, async () => {
    const { chain, transport } = await runCrossLayer({
      transportMode: modeName,
      configureTransport: t => {
        t.routes.Operate = () => { throw new Error('operate send failed'); };
      },
    });
    try {
      const { status, payload } = await chain.operate('draw');
      assert.equal(status, 502);
      assert.equal(payload.ok, false);
      assert.equal(payload.code, undefined);
      assert.equal(payload.error, 'operate send failed');
      // 写请求已发送且恰好尝试一次（List+GetGroup 前置读取 + 一次 Operate），
      // 失败零自动重试、不切换接口
      assert.deepEqual(transport.calls, ['List', 'GetGroup', 'Operate']);
      assert.ok(transport.services.every(s => s === 'gamepb.activitypb.ActivityService'));
      assert.equal(chain.proc.sent.filter(m => m.type === 'api_call').length, 1);
    } finally {
      chain.cleanup();
    }
  });
}

// ==================== 3. 成功：200 + 原有结果结构，一次写操作 ====================

for (const modeName of Object.keys(TRANSPORTS)) {
  test(`跨层成功返回原有结果与奖励结构，写请求只有一次（${modeName}）`, { timeout: 5000 }, async () => {
    const { chain, transport } = await runCrossLayer({
      transportMode: modeName,
      configureTransport: () => {},
    });
    try {
      const { status, payload } = await chain.operate('draw');
      assert.equal(status, 200);
      assert.equal(payload.ok, true);
      assert.equal(payload.action, 'draw');
      assert.equal(payload.rewards.length, 1);
      assert.equal(payload.message, '操作成功，请刷新查看最新状态');
      assert.deepEqual(transport.calls, ['List', 'GetGroup', 'Operate']);
    } finally {
      chain.cleanup();
    }
  });
}

// ==================== 4. 元数据传输形态与畸形防护（管理器层） ====================

test('元数据两种传输形态保留；畸形/超长/非标量不当业务拒绝；额外属性不透传', { timeout: 5000 }, async () => {
  const { manager, proc, cleanup } = buildManagerHarness();
  try {
    const cases = [
      {
        name: 'JSON 往返保留',
        meta: JSON.parse(JSON.stringify({ business: true, code: 'PET_DIARY_LIMIT' })),
        expectBusiness: true,
        expectCode: 'PET_DIARY_LIMIT',
      },
      {
        name: 'structuredClone 保留',
        meta: structuredClone({ business: true, code: 'PET_DIARY_ALREADY' }),
        expectBusiness: true,
        expectCode: 'PET_DIARY_ALREADY',
      },
      {
        name: '旧式仅 error 字符串',
        meta: undefined,
        expectBusiness: false,
      },
      {
        name: '缺失 business',
        meta: { code: 'PET_DIARY_LIMIT' },
        expectBusiness: false,
      },
      {
        name: 'business 非严格布尔',
        meta: { business: 'true', code: 'PET_DIARY_LIMIT' },
        expectBusiness: false,
      },
      {
        name: 'code 非字符串',
        meta: { business: true, code: 42 },
        expectBusiness: false,
      },
      {
        name: 'code 超长',
        meta: { business: true, code: `PET_DIARY_${'A'.repeat(200)}` },
        expectBusiness: false,
      },
      {
        name: 'code 前缀不符',
        meta: { business: true, code: 'SOMETHING_ELSE' },
        expectBusiness: false,
      },
      {
        name: '数组形态',
        meta: [{ business: true, code: 'PET_DIARY_LIMIT' }],
        expectBusiness: false,
      },
      {
        name: '额外属性不透传',
        meta: {
          business: true, code: 'PET_DIARY_LIMIT',
          stack: 'SECRET_STACK', cause: { secret: true }, extra: ['x'],
        },
        expectBusiness: true,
        expectCode: 'PET_DIARY_LIMIT',
      },
    ];
    for (const c of cases) {
      const promise = manager.callWorkerApi('acct-1', 'operatePetDiary', 'feed', {});
      const call = proc.sent.find(m => m.type === 'api_call');
      assert.ok(call, `api_call dispatched (${c.name})`);
      proc.sent.length = 0;
      proc.emitMessage({
        type: 'api_response', id: call.id, result: null,
        error: '业务拒绝', errorMeta: c.meta,
      });
      const err = await rejectionOf(promise);
      if (c.expectBusiness) {
        assert.equal(err.business, true, `business restored (${c.name})`);
        assert.equal(err.code, c.expectCode, `code restored (${c.name})`);
        assert.equal(err.stack.includes('SECRET_STACK'), false, `stack not passed through (${c.name})`);
        assert.equal('cause' in err, false, `cause not passed through (${c.name})`);
        assert.equal('extra' in err, false, `extra props not passed through (${c.name})`);
      } else {
        assert.notEqual(err.business, true, `not business (${c.name})`);
        assert.equal(err.code, undefined, `no code (${c.name})`);
      }
    }
  } finally {
    cleanup();
  }
});

// ==================== 5. 请求关联：并发、乱序、超时迟到、重复 ====================

test('并发/乱序/重复响应不串单；超时后迟到响应无副作用；成功响应原样返回', { timeout: 5000 }, async () => {
  const { manager, proc, cleanup } = buildManagerHarness();
  try {
    // 成功响应原样返回
    const ok = manager.callWorkerApi('acct-1', 'operatePetDiary', 'draw', {});
    const call1 = proc.sent.find(m => m.type === 'api_call');
    proc.sent.length = 0;
    proc.emitMessage({ type: 'api_response', id: call1.id, result: { action: 'draw', rewards: [1] } });
    assert.deepEqual(await ok, { action: 'draw', rewards: [1] });

    // 并发 + 乱序响应
    const pA = manager.callWorkerApi('acct-1', 'operatePetDiary', 'feed', {});
    const pB = manager.callWorkerApi('acct-1', 'operatePetDiary', 'seeds', {});
    const [callA, callB] = proc.sent.filter(m => m.type === 'api_call');
    proc.sent.length = 0;
    proc.emitMessage({ type: 'api_response', id: callB.id, result: { which: 'B' } });
    proc.emitMessage({ type: 'api_response', id: callA.id, result: { which: 'A' } });
    assert.deepEqual(await pB, { which: 'B' });
    assert.deepEqual(await pA, { which: 'A' });

    // 重复响应：第二次为 no-op，不重复完成、不抛错
    proc.emitMessage({ type: 'api_response', id: callA.id, result: { which: 'A-dup' } });
    proc.emitMessage({ type: 'api_response', id: callB.id, error: 'dup error' });

    // 超时后迟到响应
    const late = manager.callWorkerApi('acct-1', 'operatePetDiary', 'compensation', { _timeoutMs: 5 });
    const callLate = proc.sent.find(m => m.type === 'api_call');
    proc.sent.length = 0;
    await assert.rejects(late, /API Timeout/);
    await new Promise(resolve => setTimeout(resolve, 20));
    proc.emitMessage({ type: 'api_response', id: callLate.id, result: { late: true } });
    proc.emitMessage({ type: 'api_response', id: callLate.id, error: 'late error' });

    // 完成请求不遗留计时器
    const snapshot = getSchedulerRegistrySnapshot('worker_manager');
    const leftover = snapshot.schedulers[0].tasks
      .map(t => t.name).filter(name => name.startsWith('api_timeout_'));
    assert.deepEqual(leftover, []);
  } finally {
    cleanup();
  }
});

// ==================== 6. 旧式 error 字符串响应仍正常拒绝 ====================

test('旧式仅含 error 字符串的响应仍正常拒绝为普通 Error', { timeout: 5000 }, async () => {
  const { manager, proc, cleanup } = buildManagerHarness();
  try {
    const promise = manager.callWorkerApi('acct-1', 'operatePetDiary', 'story', { order: 1 });
    const call = proc.sent.find(m => m.type === 'api_call');
    proc.emitMessage({
      type: 'api_response', id: call.id, result: null, error: '账号未就绪（未登录或连接未打开），请稍后重试',
    });
    const err = await rejectionOf(promise);
    assert.match(err.message, /账号未就绪/);
    assert.notEqual(err.business, true);
    assert.equal(err.code, undefined);
  } finally {
    cleanup();
  }
});

// ==================== 7. 成功操作使读写路由共享的真实缓存失效 ====================

test('跨层成功使读写路由共享的真实活动缓存失效，迟到旧读取不能重新覆盖缓存', { timeout: 5000 }, async () => {
  await loadRealPetDiaryService(async (service, transport) => {
    // 服务端状态由传输层持有：Operate 成功后版本 +1（对应服务端状态变更）。
    // 读路径 = 真实 Worker 管理通道 → 真实 readPetDiaryGroup（同一上游传输
    // 边界读取 List+GetGroup）；写路径 = 真实 runManualPetDiaryAction。
    let serverVersion = 0;
    let firstGetGroupResolve;
    const firstGetGroupGate = new Promise(resolve => { firstGetGroupResolve = resolve; });
    let getGroupCalls = 0;
    transport.routes.GetGroup = () => {
      getGroupCalls += 1;
      if (getGroupCalls === 1) {
        // 读 #1 的快照请求挂起：随后以挂起时刻的旧状态（版本 0）返回
        return firstGetGroupGate.then(
          () => ({ body: buildGroupReply({ plunder: { plunder_compensation_count: 0 } }) }));
      }
      return { body: buildGroupReply({ plunder: { plunder_compensation_count: serverVersion } }) };
    };
    transport.routes.Operate = payload => {
      const body = buildOperateReply(payload);
      serverVersion += 1;
      return { body };
    };

    const activityReader = createActivityReadCache({ ttlMs: 60_000 });
    const activityModule = {
      getBearActivity: async () => {
        const { pet } = await service.readPetDiaryGroup();
        const state = pet && pet.pet_treasure_hunt;
        return { version: toNum(state && state.plunder && state.plunder.plunder_compensation_count) };
      },
    };
    const chain = await buildCrossLayerChain({
      service,
      transportMode: 'JSON 序列化往返（fork 模式）',
      activityModule,
      activityReader,
    });
    try {
      // 读 #1 在途（携带版本 0 的旧快照请求被挂起）
      const read1Promise = chain.readBear();
      await new Promise(resolve => setImmediate(resolve));

      // 操作成功：一次写请求、原有结果与奖励结构
      const operateResult = await chain.operate('draw');
      assert.equal(operateResult.status, 200);
      assert.equal(operateResult.payload.ok, true);
      assert.equal(operateResult.payload.action, 'draw');
      assert.equal(operateResult.payload.rewards.length, 1);
      assert.equal(operateResult.payload.message, '操作成功，请刷新查看最新状态');
      assert.equal(operateResult.payload.operateReplyId, PET_DIARY_PLAY_ID);
      assert.equal(transport.calls.filter(m => m === 'Operate').length, 1);

      // 失效前已在途的旧读取此刻才完成：返回旧状态，但不能回写缓存
      firstGetGroupResolve();
      const read1 = await read1Promise;
      assert.equal(read1.status, 200);
      assert.equal(read1.payload.ok, true);
      assert.equal(read1.payload.activity.version, 0);

      // 下一次读取取得新状态（缓存已被操作成功清除，重新读上游）
      const read2 = await chain.readBear();
      assert.equal(read2.status, 200);
      assert.equal(read2.payload.ok, true);
      assert.equal(read2.payload.activity.version, 1);
      assert.equal(read2.payload.upstreamCached, false);

      // 新状态已入缓存：再读命中本地缓存，不再打上游
      const read3 = await chain.readBear();
      assert.equal(read3.payload.activity.version, 1);
      assert.equal(read3.payload.upstreamCached, true);

      // 上游读取与写请求次数全部精确：无重试、无额外刷新
      assert.deepEqual(transport.calls, [
        'List', 'GetGroup',            // 读 #1（挂起的旧读取）
        'List', 'GetGroup', 'Operate', // 操作前置校验 + 恰好一次写
        'List', 'GetGroup',            // 读 #2（失效后重新读取）
      ]);
      assert.ok(transport.services.every(s => s === 'gamepb.activitypb.ActivityService'));
      assert.equal(chain.proc.sent.filter(m => m.type === 'api_call').length, 3);
    } finally {
      chain.cleanup();
    }
  });
});
