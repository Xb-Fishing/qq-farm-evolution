const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

// 背包面板启动就绪拒绝（2026-10-04 启动窗口 500 收口）回归：
// 启动窗口（顶号后 Worker 重注册、协议加载在途）内的面板 GET /api/bag、
// /api/bag/seeds 此前直发 getBagForPanel→getBag()，types.BagRequest 未发布时
// 以无关键字的 TypeError 失败，污染共享 60s 失败冷却，路由按未知错误回 500。
// 现在 worker.js handleApiCall 为 getBag/getBagSeeds 增加运行/登录/连接闸门
// （与好友面板同一固定本地拒绝），admin-route-helpers 将该固定拒绝加入精确
// 白名单（HTTP 200 + ok:false，反馈分类 not_ready）。
// 真实调用链 = 真实背包路由 + 真实路由助手 sendProviderError + 真实反馈中间件
// → 真实 Worker 管理器（fork 消息通道，按请求 ID 配对）→ 从 worker.js 提取的
// 真实 handleApiCall（vm 沙箱）→ 真实 warehouse 面板缓存层，仅在上游传输边界
// （sendMsgAsync）注入可控模拟；协议类型对象按 proto.js 语义从空对象原地发布。

// 独立数据目录：在任何业务模块加载前设置（skill 隔离硬规则）
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bag-panel-readiness-'));
process.env.FARM_DATA_DIR = DATA_DIR;

const { createScheduler, getSchedulerRegistrySnapshot } = require('../src/services/scheduler');
const { createWorkerManager } = require('../src/runtime/worker-manager');
const { registerAdminBagRoutes } = require('../src/controllers/admin-bag-routes');
const { createAdminRouteHelpers } = require('../src/controllers/admin-route-helpers');
const { createFeedbackMiddleware } = require('../src/controllers/admin-feedback-routes');

const workerSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'worker.js'), 'utf8');

// Worker 就绪闸门的固定本地拒绝：断言逐字一致（精确白名单的配对基础）
const PANEL_NOT_READY_ERROR = '账号未就绪（未登录或连接未打开），请稍后重试';

/**
 * 最小可控时钟：warehouse 面板缓存只依赖 Date.now()，直接补丁比
 * node:test MockTimers 更窄（不触碰真实定时器，避免挂起管理器链的
 * api_timeout / watchdog 定时任务）。
 */
function fakeClock(start = Date.now()) {
  const realNow = Date.now;
  let now = start;
  Date.now = () => now;
  return {
    advance(ms) { now += ms; },
    restore() { Date.now = realNow; },
  };
}

// 合成身份：物品 ID 为测试专用常量，不使用本机真实账号数据
const GOLD_ITEM_ID = 1001;

function bagBody(items) {
  return { item_bag: { items } };
}

function mockModule(filename, exports) {
  return { id: filename, filename, loaded: true, exports, paths: [] };
}

function makeType() {
  return {
    create: value => value,
    encode: () => ({ finish: () => Buffer.alloc(0) }),
    decode: body => body,
  };
}

/**
 * 加载真实 warehouse 服务，仅在上游边界注入可控模拟。
 * types 与生产 proto.js 同语义：唯一稳定引用、从空对象开始、加载成功后
 * 原地发布；encode 计数证明未就绪拒绝零 Bag 编码。
 */
function loadWarehouseFixture() {
  const servicePath = require.resolve('../src/services/warehouse');
  const gameConfigPath = require.resolve('../src/config/gameConfig');
  const storePath = require.resolve('../src/models/store');
  const networkPath = require.resolve('../src/utils/network');
  const protoPath = require.resolve('../src/utils/proto');
  const utilsPath = require.resolve('../src/utils/utils');
  const statusPath = require.resolve('../src/services/status');
  const auditPath = require.resolve('../src/services/seed-catalog-audit');
  const paths = [servicePath, gameConfigPath, storePath, networkPath,
    protoPath, utilsPath, statusPath, auditPath];
  const previous = new Map(paths.map(file => [file, require.cache[file]]));

  const transport = {
    calls: [],
    server: { bag: bagBody([{ id: GOLD_ITEM_ID, count: 5 }]) },
    routes: {},
  };
  transport.routes.Bag = () => ({ body: transport.server.bag });

  const counters = { encode: 0, decode: 0 };

  // 协议类型：唯一稳定空引用，publishProtocols 原地发布（模拟 loadProto 成功）
  const types = {};
  const bagRequestType = makeType();
  const originalEncode = bagRequestType.encode;
  bagRequestType.encode = value => {
    counters.encode += 1;
    return originalEncode(value);
  };
  const bagReplyType = makeType();
  const originalDecode = bagReplyType.decode;
  bagReplyType.decode = body => {
    counters.decode += 1;
    if (body && body.__failDecode) throw new Error('bag reply decode failed');
    return originalDecode(body);
  };

  require.cache[gameConfigPath] = mockModule(gameConfigPath, {
    getFruitName: () => '',
    getPlantByFruitId: () => null,
    getPlantBySeedId: () => null,
    getItemById: () => null,
    getItemImageById: () => '',
    getSeedLevel: () => 1,
    getSeedImageBySeedId: () => '',
    getSeedImageByName: () => null,
    getPlantImageByPhase: () => '',
    isSeedItem: () => false,
  });
  require.cache[storePath] = mockModule(storePath, { isAutomationOn: () => false });
  require.cache[networkPath] = mockModule(networkPath, {
    sendMsgAsync: async (service, method) => {
      transport.calls.push(method);
      const route = transport.routes[method];
      if (!route) throw new Error(`unexpected rpc ${method}`);
      return route();
    },
    networkEvents: { on: () => {}, off: () => {} },
    getUserState: () => ({ gold: 0, exp: 0 }),
  });
  require.cache[protoPath] = mockModule(protoPath, { types });
  require.cache[utilsPath] = mockModule(utilsPath, {
    toLong: value => value,
    toNum: value => Number(value) || 0,
    log: () => {},
    logWarn: () => {},
    sleep: async () => {},
  });
  require.cache[statusPath] = mockModule(statusPath, { updateStatusGold: () => {} });
  require.cache[auditPath] = mockModule(auditPath, {
    auditBagSeedCoverage: () => ({ issues: [] }),
  });
  delete require.cache[servicePath];

  return {
    service: require(servicePath),
    transport,
    counters,
    /** 协议加载成功：原地发布消息类型（引用不变，语义同 proto.js） */
    publishProtocols() {
      types.BagRequest = bagRequestType;
      types.BagReply = bagReplyType;
    },
    restore() {
      for (const file of paths) {
        if (previous.get(file)) require.cache[file] = previous.get(file);
        else delete require.cache[file];
      }
    },
  };
}

/** 从 worker.js 提取真实管理入口（与 worker-api-error 测试同一切片边界）。 */
function extractWorkerApiSource() {
  const start = workerSrc.indexOf('const FRIEND_PANEL_ENTRY_METHODS = new Set([');
  assert.ok(start >= 0, 'FRIEND_PANEL_ENTRY_METHODS exists in worker.js');
  const end = workerSrc.indexOf('// ==================== 每日礼包总览', start);
  assert.ok(end > start, 'handleApiCall end marker exists');
  return `${workerSrc.slice(start, end)}\n;({ handleApiCall })`;
}

/**
 * 真实 handleApiCall 进 vm 沙箱：就绪状态可变（沙箱对象即全局，属性
 * 读写直通），require 只映射到真实 warehouse 服务；sendToMaster 捕获
 * api_response 并按请求 ID 分发（并发响应可能交错，靠 ID 配对）。
 */
function buildWorkerEntry(service) {
  const responses = [];
  const listeners = new Set();
  const sandbox = {
    isRunning: true,
    loginReady: false,
    ws: null,
    getWs: () => sandbox.ws,
    sendToMaster: message => {
      responses.push(message);
      for (const fn of listeners) fn(message);
    },
    log: () => {},
    friendSyncPaused: false,
    require: request => {
      if (request === '../services/warehouse') return service;
      throw new Error(`unexpected require from handleApiCall: ${request}`);
    },
  };
  const script = new vm.Script(extractWorkerApiSource(), { filename: 'worker.js#api-entry' });
  const { handleApiCall } = script.runInContext(vm.createContext(sandbox));
  return {
    handleApiCall,
    responses,
    sandbox,
    setReadiness({ isRunning, loginReady, ws }) {
      if (isRunning !== undefined) sandbox.isRunning = isRunning;
      if (loginReady !== undefined) sandbox.loginReady = loginReady;
      if (ws !== undefined) sandbox.ws = ws;
    },
    addListener: fn => listeners.add(fn),
    removeListener: fn => listeners.delete(fn),
  };
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

/** 反馈记录桩：只落在测试内存，绝不写生产反馈。 */
function makeFeedbackRecorder() {
  const entries = [];
  return {
    entries,
    record: entry => {
      entries.push(entry);
      return true;
    },
  };
}

/** 组装完整真实链：warehouse → Worker 入口 → 管理器 → 背包路由 + 反馈中间件。 */
function buildAdminChain({ service, transportMode = 'JSON 序列化往返（fork 模式）' } = {}) {
  const workerEntry = buildWorkerEntry(service);
  const { manager, proc, cleanup } = buildManagerHarness();
  const transport = TRANSPORTS[transportMode];

  proc.send = msg => {
    proc.sent.push(msg);
    if (msg.type === 'api_call') {
      Promise.resolve().then(async () => {
        // 每次 handleApiCall 恰好回一条同 ID 响应；按 ID 过滤避免并发交错串单
        let response = null;
        const onSend = message => {
          if (message && message.id === msg.id) response = message;
        };
        workerEntry.addListener(onSend);
        try {
          await workerEntry.handleApiCall(transport.in(msg));
        } finally {
          workerEntry.removeListener(onSend);
        }
        if (response) proc.emitMessage(transport.out(response));
      });
    }
  };

  const provider = {
    getBag: accountId => manager.callWorkerApi(accountId, 'getBag'),
    getBagSeeds: accountId => manager.callWorkerApi(accountId, 'getBagSeeds'),
  };

  const feedback = makeFeedbackRecorder();
  const helpers = createAdminRouteHelpers({
    store: {},
    userStore: {},
    logger: { warn: () => {}, error: () => {} },
    getProvider: () => null,
  });
  const feedbackMiddleware = createFeedbackMiddleware({
    hasAdminToken: token => token === 'bag-panel-readiness-test',
    feedback,
  });

  const routes = new Map();
  const app = {
    get: (url, handler) => routes.set(url, handler),
    post: (url, handler) => routes.set(url, handler),
  };
  registerAdminBagRoutes({
    app,
    provider,
    emitRealtimeLog: () => {},
    getAccountIdFromRequest: () => 'acct-1',
    canAccessAccount: () => true,
    sendProviderError: helpers.sendProviderError,
  });

  function makeRes() {
    const onceListeners = {};
    const res = {
      statusCode: 200,
      headersSent: false,
      writableEnded: false,
      destroyed: false,
      writableFinished: true,
      locals: {},
      payload: undefined,
      status(code) { res.statusCode = code; return res; },
      json(data) { res.payload = data; res.headersSent = true; },
      once(event, cb) { (onceListeners[event] = onceListeners[event] || []).push(cb); },
      finish() {
        for (const cb of onceListeners.finish || []) cb();
        for (const cb of onceListeners.close || []) cb();
      },
    };
    return res;
  }

  /** 经真实反馈中间件 → 真实背包路由发起一次 GET（含 res.json 包装与 finish 记录） */
  async function invokeGet(url) {
    const res = makeRes();
    const req = {
      method: 'GET',
      path: url,
      url,
      headers: { 'x-admin-token': 'bag-panel-readiness-test' },
      body: {},
      route: { path: url },
    };
    await new Promise(resolve => {
      feedbackMiddleware(req, res, () => {
        Promise.resolve(routes.get(url)(req, res)).then(resolve, resolve);
      });
    });
    res.finish();
    return res;
  }

  const readBag = () => invokeGet('/api/bag');
  const readBagSeeds = () => invokeGet('/api/bag/seeds');

  const apiCallsSent = () => proc.sent.filter(m => m.type === 'api_call');
  const bagUpstreamCalls = fixtureTransport =>
    fixtureTransport.calls.filter(m => m === 'Bag').length;
  const leftoverApiTimers = () => {
    const snapshot = getSchedulerRegistrySnapshot('worker_manager');
    return snapshot.schedulers[0].tasks
      .map(t => t.name).filter(name => name.startsWith('api_timeout_'));
  };

  return {
    manager, proc, cleanup, workerEntry, feedback,
    readBag, readBagSeeds, apiCallsSent, bagUpstreamCalls, leftoverApiTimers,
  };
}

// 未就绪状态矩阵（状态语义与真实 Worker 对齐，见 friends-panel-readiness）：
// startBot 先置 isRunning 再 await loadProto；协议未加载/加载失败时
// loginReady 恒为 false；协议已发布但登录在途 ws OPEN 而 loginReady=false；
// 断线窗口 ws CLOSED 而 loginReady 可能仍为 true；stopBot 后两者皆 false。
const NOT_READY_STATES = [
  { name: '协议未加载（启动窗口）', publish: false, isRunning: true, loginReady: false, ws: null },
  { name: '协议加载失败（启动中断）', publish: false, isRunning: true, loginReady: false, ws: null },
  { name: '已加载未登录（登录在途）', publish: true, isRunning: true, loginReady: false, ws: { readyState: 1 } },
  { name: 'ws 已关闭（断线窗口）', publish: true, isRunning: true, loginReady: true, ws: { readyState: 3 } },
  { name: '已停止', publish: true, isRunning: false, loginReady: false, ws: { readyState: 3 } },
];

const BAG_PANEL_ENTRIES = [
  { name: 'getBag', read: chain => chain.readBag() },
  { name: 'getBagSeeds', read: chain => chain.readBagSeeds() },
];

test.after(() => {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

// ==================== 1. 未就绪矩阵：固定本地拒绝跨层 200 + not_ready ====================

test('未就绪状态矩阵：两个背包入口跨层 200 + ok:false + 固定拒绝，零上游/零编码/零暂停', { timeout: 5000 }, async () => {
  for (const state of NOT_READY_STATES) {
    const fixture = loadWarehouseFixture();
    if (state.publish) fixture.publishProtocols();
    const chain = buildAdminChain({ service: fixture.service });
    try {
      for (const entry of BAG_PANEL_ENTRIES) {
        fixture.transport.calls.length = 0;
        fixture.counters.encode = 0;
        fixture.counters.decode = 0;
        chain.proc.sent.length = 0;
        const feedbackBefore = chain.feedback.entries.length;

        chain.workerEntry.setReadiness({
          isRunning: state.isRunning,
          loginReady: state.loginReady,
          ws: state.ws,
        });
        const res = await entry.read(chain);
        const label = `${state.name} × ${entry.name}`;

        // 跨层语义：HTTP 200 + ok:false + 逐字一致的固定拒绝（精确白名单配对）
        assert.equal(res.statusCode, 200, `${label}: HTTP 200`);
        assert.equal(res.payload.ok, false, `${label}: ok:false`);
        assert.equal(res.payload.error, PANEL_NOT_READY_ERROR, `${label}: 固定本地拒绝逐字一致`);

        // 反馈仍记 FAILURE（不因 200 而记成功），分类 not_ready
        const recorded = chain.feedback.entries.slice(feedbackBefore);
        assert.equal(recorded.length, 1, `${label}: 反馈恰好记录一条`);
        assert.equal(recorded[0].outcome, 'failed', `${label}: 反馈结果为 failed`);
        assert.equal(recorded[0].reason, 'not_ready', `${label}: 反馈分类 not_ready`);
        assert.equal(recorded[0].httpStatus, 200, `${label}: 反馈记录原始状态码`);

        // 零上游、零 Bag 编码、零解码；恰好一次派发（无重试）
        assert.equal(fixture.transport.calls.length, 0, `${label}: 零上游请求`);
        assert.equal(fixture.counters.encode, 0, `${label}: 零 Bag 编码`);
        assert.equal(fixture.counters.decode, 0, `${label}: 零 Bag 解码`);
        assert.equal(chain.apiCallsSent().length, 1, `${label}: 恰好一次 api_call 派发`);

        // 不设置好友同步暂停；未就绪响应即时返回（无上游 deferred 可等）
        assert.equal(chain.workerEntry.sandbox.friendSyncPaused, false,
          `${label}: 不设置好友同步暂停`);
        assert.deepEqual(chain.leftoverApiTimers(), [], `${label}: 无遗留超时任务`);
      }
    } finally {
      chain.cleanup();
      fixture.restore();
    }
  }
});

// ==================== 2. 两种传输形态 + 并发按请求 ID 配对 ====================

for (const modeName of Object.keys(TRANSPORTS)) {
  test(`未就绪并发读取按 ID 配对、无串单/无重复完成（${modeName}）`, { timeout: 5000 }, async () => {
    const fixture = loadWarehouseFixture();
    const chain = buildAdminChain({ service: fixture.service, transportMode: modeName });
    try {
      // 协议未加载 + 登录在途：两个入口并发请求
      const [bag, seeds] = await Promise.all([chain.readBag(), chain.readBagSeeds()]);

      for (const res of [bag, seeds]) {
        assert.equal(res.statusCode, 200);
        assert.equal(res.payload.ok, false);
        assert.equal(res.payload.error, PANEL_NOT_READY_ERROR);
      }
      // 两条独立 api_call（不同请求 ID）、零上游、反馈两条 not_ready
      const calls = chain.apiCallsSent();
      assert.equal(calls.length, 2, '两个并发请求各派发一次');
      assert.notEqual(calls[0].id, calls[1].id, '并发请求 ID 不同');
      assert.equal(fixture.transport.calls.length, 0, '零上游请求');
      assert.deepEqual(chain.leftoverApiTimers(), [], '无遗留超时任务');
      const reasons = chain.feedback.entries
        .filter(e => e.outcome === 'failed').map(e => e.reason);
      assert.deepEqual(reasons, ['not_ready', 'not_ready'], '两条并发拒绝均记 not_ready');
    } finally {
      chain.cleanup();
      fixture.restore();
    }
  });
}

// ==================== 3. 启动窗口拒绝不设失败冷却：就绪后立即可读 ====================

test('启动窗口连续拒绝后：协议发布+登录+连接就绪即可成功，两入口并发共享恰好一次上游读取', { timeout: 5000 }, async () => {
  const fixture = loadWarehouseFixture();
  const chain = buildAdminChain({ service: fixture.service });
  const clock = fakeClock();
  try {
    // 启动窗口：连续四次拒绝（两入口交替，含 JSON 通道默认形态）
    for (const entry of [chain.readBag, chain.readBagSeeds, chain.readBag, chain.readBagSeeds]) {
      const res = await entry();
      assert.equal(res.statusCode, 200);
      assert.equal(res.payload.ok, false);
      assert.equal(res.payload.error, PANEL_NOT_READY_ERROR);
    }
    assert.equal(fixture.transport.calls.length, 0, '启动窗口零上游');
    assert.equal(chain.feedback.entries.length, 4, '四次拒绝均入反馈');
    assert.ok(chain.feedback.entries.every(e => e.reason === 'not_ready'));

    // 恢复：协议原地发布 + 登录就绪 + 连接打开；时钟不前进（仍在原 60s 窗口内）
    fixture.publishProtocols();
    chain.workerEntry.setReadiness({ isRunning: true, loginReady: true, ws: { readyState: 1 } });

    const [bag, seeds] = await Promise.all([chain.readBag(), chain.readBagSeeds()]);
    assert.equal(bag.statusCode, 200, '就绪后 getBag 立即成功（未进失败冷却）');
    assert.equal(bag.payload.ok, true);
    assert.equal(seeds.statusCode, 200, '就绪后 getBagSeeds 立即成功');
    assert.equal(seeds.payload.ok, true);

    // 拒绝不写失败冷却的硬证据：零时钟推进下两入口并发只发生一次真实上游读取
    assert.equal(fixture.transport.calls.filter(m => m === 'Bag').length, 1,
      '并发 getBag/getBagSeeds 共享恰好一次上游读取');
    assert.equal(fixture.counters.encode, 1, '恰好一次 Bag 编码');
    assert.ok(Array.isArray(bag.payload.data.items), '背包详情结果结构保留');

    // 成功读取（GET succeeded）不写入反馈：反馈仍只有 4 条启动拒绝
    assert.equal(chain.feedback.entries.length, 4, '成功轮询不进反馈');
    assert.deepEqual(chain.leftoverApiTimers(), [], '无遗留超时任务');
  } finally {
    clock.restore();
    chain.cleanup();
    fixture.restore();
  }
});

// ==================== 4. 就绪后的真实失败：500 与原失败语义保留 ====================

test('就绪后上游传输失败仍为 500 + 原分类，60s 冷却内零新增上游且不降级为 not_ready', { timeout: 5000 }, async () => {
  const fixture = loadWarehouseFixture();
  fixture.publishProtocols();
  fixture.transport.routes.Bag = () => { throw new Error('upstream transport down'); };
  const chain = buildAdminChain({ service: fixture.service });
  const clock = fakeClock();
  try {
    chain.workerEntry.setReadiness({ isRunning: true, loginReady: true, ws: { readyState: 1 } });

    const first = await chain.readBag();
    assert.equal(first.statusCode, 500, '真实上游失败保持 500');
    assert.equal(first.payload.ok, false);
    assert.match(first.payload.error, /upstream transport down/);
    assert.equal(fixture.transport.calls.length, 1, '首轮只尝试一次');
    const failedEntries = chain.feedback.entries.filter(e => e.outcome === 'failed');
    assert.equal(failedEntries.length, 1);
    assert.equal(failedEntries[0].reason, 'unknown', '无关键字错误保持 unknown 分类');

    // 60s 失败冷却：冷却提示同样 500（不按「冷却」关键词降级），零新增上游
    for (let i = 0; i < 3; i += 1) {
      const cooldown = await chain.readBag();
      assert.equal(cooldown.statusCode, 500, `冷却读取 #${i + 1} 保持 500`);
      assert.equal(cooldown.payload.ok, false);
      assert.match(cooldown.payload.error, /背包读取冷却中/);
    }
    assert.equal(fixture.transport.calls.length, 1, '冷却期内零新增上游');
    const cooldownEntries = chain.feedback.entries.filter(e => e.outcome === 'failed');
    assert.equal(cooldownEntries.length, 4, '冷却拒绝同样入反馈');
    assert.ok(cooldownEntries.every(e => e.reason !== 'not_ready'),
      '冷却拒绝不得被分类为 not_ready');

    // 空转时间推移不产生后台重试；冷却到期允许一次新读取
    clock.advance(30_000);
    assert.equal(fixture.transport.calls.length, 1);
    clock.advance(29_999);
    assert.equal(fixture.transport.calls.length, 1);
    clock.advance(1);
    const retried = await chain.readBag();
    assert.equal(retried.statusCode, 500, '到期后的真实失败仍是 500');
    assert.match(retried.payload.error, /upstream transport down/);
    assert.equal(fixture.transport.calls.length, 2, '到期后恰好一次新读取');
  } finally {
    clock.restore();
    chain.cleanup();
    fixture.restore();
  }
});

test('就绪后解码失败仍为 500，同样进入 60s 冷却且零额外上游', { timeout: 5000 }, async () => {
  const fixture = loadWarehouseFixture();
  fixture.publishProtocols();
  fixture.transport.routes.Bag = () => ({ body: { __failDecode: true } });
  const chain = buildAdminChain({ service: fixture.service });
  const clock = fakeClock();
  try {
    chain.workerEntry.setReadiness({ isRunning: true, loginReady: true, ws: { readyState: 1 } });

    const first = await chain.readBagSeeds();
    assert.equal(first.statusCode, 500, '解码失败保持 500');
    assert.match(first.payload.error, /bag reply decode failed/);
    assert.equal(fixture.transport.calls.length, 1);

    clock.advance(59_999);
    const cooldown = await chain.readBagSeeds();
    assert.equal(cooldown.statusCode, 500, '解码失败后的冷却拒绝保持 500');
    assert.match(cooldown.payload.error, /背包读取冷却中/);
    assert.equal(fixture.transport.calls.length, 1, '冷却期内零新增上游');
    assert.deepEqual(chain.leftoverApiTimers(), [], '无遗留超时任务');
  } finally {
    clock.restore();
    chain.cleanup();
    fixture.restore();
  }
});

// ==================== 5. 路由助手精确白名单（单元边界） ====================

test('sendProviderError 只逐字接受固定就绪拒绝：既有预期错误保留，相似错误仍 500', () => {
  const helpers = createAdminRouteHelpers({
    store: {},
    userStore: {},
    logger: { warn: () => {}, error: () => {} },
    getProvider: () => null,
  });

  function run(message) {
    let status = 200;
    let payload;
    const res = {
      statusCode: 200,
      headersSent: false,
      writableEnded: false,
      destroyed: false,
      locals: {},
      status(code) { status = code; return res; },
      json(data) { payload = data; },
    };
    helpers.sendProviderError(res, new Error(message));
    return { status, payload };
  }

  // 固定就绪拒绝：精确命中 → 200 + ok:false
  const ready = run(PANEL_NOT_READY_ERROR);
  assert.equal(ready.status, 200, '固定就绪拒绝 200');
  assert.equal(ready.payload.ok, false);
  assert.equal(ready.payload.error, PANEL_NOT_READY_ERROR);

  // 既有预期错误语义保留
  assert.equal(run('账号未运行').status, 200, '账号未运行 保留 200');
  assert.equal(run('API Timeout').status, 200, 'API Timeout 保留 200');

  // 相似但不一致的错误：一律保持 500（不按关键词放宽）
  for (const message of [
    `${PANEL_NOT_READY_ERROR} `,                       // 多一个尾随空格
    `  ${PANEL_NOT_READY_ERROR}`,                       // 多一个前导空格
    '账号未就绪（未登录或连接未打开）请稍后重试',          // 缺少逗号
    '账号未就绪(未登录或连接未打开)，请稍后重试',          // 半角括号
    '账号未就绪（未登录或连接未打开），请稍后再试',          // 尾字不同
    '账号未就绪，请稍后重试',                              // 概括变体
    '背包读取冷却中，请稍后再试',                          // 失败冷却不得降级
    'upstream transport down',                          // 真实上游失败
  ]) {
    const result = run(message);
    assert.equal(result.status, 500, `相似错误保持 500: ${message}`);
    assert.equal(result.payload.ok, false);
  }
});

// ==================== 6. 就绪成功路径：共享 60s 缓存/在途合并/到期重读 ====================

test('就绪成功路径保留共享 60s 缓存、在途合并与到期重读；种植读取保持新鲜', { timeout: 5000 }, async () => {
  const fixture = loadWarehouseFixture();
  fixture.publishProtocols();
  const chain = buildAdminChain({ service: fixture.service });
  const clock = fakeClock();
  try {
    chain.workerEntry.setReadiness({ isRunning: true, loginReady: true, ws: { readyState: 1 } });

    // 预热：一次上游读取，两入口共享同一缓存对象
    const warm = await chain.readBag();
    assert.equal(warm.payload.ok, true);
    const hit = await chain.readBagSeeds();
    assert.equal(hit.payload.ok, true);
    assert.equal(fixture.transport.calls.filter(m => m === 'Bag').length, 1,
      '两入口共享一次上游读取');

    // 不足 60s：不新增请求
    clock.advance(59_999);
    await chain.readBag();
    assert.equal(fixture.transport.calls.length, 1);

    // 到期后并发三读（bag+bag+seeds）：在途合并为一次上游
    clock.advance(1);
    const concurrent = await Promise.all([chain.readBag(), chain.readBag(), chain.readBagSeeds()]);
    for (const res of concurrent) {
      assert.equal(res.statusCode, 200);
      assert.equal(res.payload.ok, true);
    }
    assert.equal(fixture.transport.calls.length, 2, '到期后在途合并只新增一次上游');

    // 种植路径 getBagSeeds（无缓存新鲜读取）：每次直读上游，不进面板缓存
    await fixture.service.getBagSeeds();
    await fixture.service.getBagSeeds();
    assert.equal(fixture.transport.calls.length, 4, '种植读取两次各一次上游');
    assert.deepEqual(chain.leftoverApiTimers(), [], '无遗留超时任务');
  } finally {
    clock.restore();
    chain.cleanup();
    fixture.restore();
  }
});

// ==================== 7. Worker 接线范围自检 ====================

test('就绪闸门接线范围：背包两入口单独成集合，好友三入口与同步暂停语义不变', () => {
  const bagSetStart = workerSrc.indexOf('const BAG_PANEL_ENTRY_METHODS = new Set([');
  assert.ok(bagSetStart >= 0, 'BAG_PANEL_ENTRY_METHODS exists in worker.js');
  const bagSetEnd = workerSrc.indexOf(']);', bagSetStart) + ']);'.length;
  const bagSet = workerSrc.slice(bagSetStart, bagSetEnd);
  assert.match(bagSet, /'getBag'/);
  assert.match(bagSet, /'getBagSeeds'/);
  assert.doesNotMatch(bagSet, /getFriends|fetchFriendsDogInfo|syncFriendsFromGids/,
    '背包集合不得混入好友入口');

  // 好友面板三入口保持原集合（不因背包收口扩散）
  const friendSetStart = workerSrc.indexOf('const FRIEND_PANEL_ENTRY_METHODS = new Set([');
  const friendSetEnd = workerSrc.indexOf(']);', friendSetStart) + ']);'.length;
  const friendSet = workerSrc.slice(friendSetStart, friendSetEnd);
  assert.match(friendSet, /'getFriends'/);
  assert.match(friendSet, /'fetchFriendsDogInfo'/);
  assert.match(friendSet, /'syncFriendsFromGids'/);
  assert.doesNotMatch(friendSet, /'getBag'/, '好友集合不得混入背包入口');

  // 闸门条件同时挂两个集合；isFriendSync 三入口判定不含背包方法
  const fnStart = workerSrc.indexOf('async function handleApiCall', friendSetEnd);
  const fnEnd = workerSrc.indexOf('// ==================== 每日礼包总览', fnStart);
  const handleApiCallSrc = workerSrc.slice(fnStart, fnEnd);
  const gateAt = handleApiCallSrc.indexOf('账号未就绪');
  assert.ok(gateAt >= 0, '固定就绪拒绝仍在闸门内');
  const gateBlock = handleApiCallSrc.slice(0, gateAt);
  assert.match(gateBlock, /FRIEND_PANEL_ENTRY_METHODS\.has\(method\)/);
  assert.match(gateBlock, /BAG_PANEL_ENTRY_METHODS\.has\(method\)/);

  const syncStart = handleApiCallSrc.indexOf('const isFriendSync');
  const syncEnd = handleApiCallSrc.indexOf(';', syncStart);
  const syncExpr = handleApiCallSrc.slice(syncStart, syncEnd);
  assert.doesNotMatch(syncExpr, /getBag/, '背包读取不进入好友同步暂停语义');

  // 收益链调度路径不得引用背包就绪集合
  for (const [marker, endMarker] of [
    ['async function runOwnHarvestStrike', '// ==================== 好友成熟哨兵'],
    ['async function runStealTick', '// ==================== 统一调度器'],
    ['async function runUnifiedTick', 'function scheduleUnifiedNextTick'],
  ]) {
    const start = workerSrc.indexOf(marker);
    assert.ok(start >= 0, `${marker} exists`);
    const body = workerSrc.slice(start, workerSrc.indexOf(endMarker, start));
    assert.doesNotMatch(body, /BAG_PANEL_ENTRY_METHODS/,
      `${marker} must not consult the bag panel readiness gate`);
  }
});
