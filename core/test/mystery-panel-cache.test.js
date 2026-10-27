const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

// 神秘商人面板读取缓存（2026-10-03 防封巡检收口）：面板横幅 3 小时固定
// 刷新、商城页挂载与账号切换此前每次都直发 MysteryShopService.GetActiveNPC。
// 现在 Worker 的 getMysteryShop case 走 60s 成功缓存 + 在途合并 + 失败 60s
// 冷却，Buy/Abandon 成功后在服务内部失效（手动购买与自动购买共用写函数）；
// 自动购买 checkAndAutoBuyMysteryShop 仍保持无缓存新鲜读取。
// 真实调用链 = 真实神秘商人路由 → 真实 Worker 管理器（fork 消息通道）→
// 从 worker.js 提取的真实 handleApiCall（vm 沙箱）→ 真实商人服务，
// 仅在上游传输边界（sendMsgAsync）注入可控模拟。

// 独立数据目录：在任何业务模块加载前设置（skill 隔离硬规则）
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mystery-panel-cache-'));
process.env.FARM_DATA_DIR = DATA_DIR;

const { createScheduler } = require('../src/services/scheduler');
const { createWorkerManager } = require('../src/runtime/worker-manager');
const { registerAdminMysteryShopRoutes } = require('../src/controllers/admin-mystery-shop-routes');

const workerSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'worker.js'), 'utf8');

/**
 * 最小可控时钟：商人服务与面板缓存只依赖 Date.now()，直接补丁比
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

// 合成身份：npc/item 均为测试专用 ID，不使用本机真实账号数据
const NPC_ID = 710001;
const ITEM_ID = 60001;

function activeOffer() {
  return {
    active: true,
    npc: {
      npc_id: NPC_ID, item_id: ITEM_ID, item_type: 1, item_count: 2,
      currency_id: 1001, price: 500, original_price: 1000, discount: 50,
      purchased: false,
    },
    start_time: 1000, end_time: 0,
  };
}

function emptyReply() {
  return { active: false, npc: {}, start_time: 0, end_time: 0 };
}

function buyReply() {
  return { reward: { item_id: ITEM_ID, count: 2 }, npc: { purchased: true } };
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
 * 加载真实商人服务，仅在上游边界注入可控模拟。
 * transport.calls 记录全部上游方法；transport.routes 可按方法覆盖；
 * transport.server 模拟服务端状态（Buy/Abandon 成功后报价清空）。
 * automation 经 mock store 按测试改写。
 */
function loadMysteryFixture() {
  const servicePath = require.resolve('../src/services/mystery-shop');
  const gameConfigPath = require.resolve('../src/config/gameConfig');
  const storePath = require.resolve('../src/models/store');
  const networkPath = require.resolve('../src/utils/network');
  const protoPath = require.resolve('../src/utils/proto');
  const utilsPath = require.resolve('../src/utils/utils');
  const paths = [servicePath, gameConfigPath, storePath, networkPath,
    protoPath, utilsPath];
  const previous = new Map(paths.map(file => [file, require.cache[file]]));

  const transport = {
    calls: [],
    server: { offer: activeOffer(), automation: {} },
    routes: {},
  };
  transport.routes.GetActiveNPC = () => ({ body: transport.server.offer });
  transport.routes.Buy = () => {
    transport.server.offer = emptyReply();
    return { body: buyReply() };
  };
  transport.routes.Abandon = () => {
    transport.server.offer = emptyReply();
    return { body: {} };
  };

  require.cache[gameConfigPath] = mockModule(gameConfigPath, {
    getItemById: () => null,
    getItemImageById: () => '',
  });
  require.cache[storePath] = mockModule(storePath, {
    getAutomation: () => transport.server.automation,
  });
  require.cache[networkPath] = mockModule(networkPath, {
    sendMsgAsync: async (service, method) => {
      transport.calls.push(method);
      const route = transport.routes[method];
      if (!route) throw new Error(`unexpected rpc ${method}`);
      return route();
    },
  });
  const replyType = makeType();
  replyType.decode = body => {
    if (body && body.__failDecode) throw new Error('mystery reply decode failed');
    return body;
  };
  require.cache[protoPath] = mockModule(protoPath, {
    types: {
      GetActiveMysteryNPCRequest: makeType(),
      GetActiveMysteryNPCReply: replyType,
      BuyMysteryShopRequest: makeType(),
      BuyMysteryShopReply: makeType(),
      AbandonMysteryShopRequest: makeType(),
      AbandonMysteryShopReply: makeType(),
    },
  });
  require.cache[utilsPath] = mockModule(utilsPath, {
    toNum: value => Number(value) || 0,
    log: () => {},
    logWarn: () => {},
  });
  delete require.cache[servicePath];

  return {
    service: require(servicePath),
    transport,
    setAutomation(value) { transport.server.automation = value; },
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

function buildWorkerEntry(service) {
  const responses = [];
  const listeners = new Set();
  const sandbox = {
    isRunning: true,
    loginReady: true,
    getWs: () => ({ readyState: 1 }),
    sendToMaster: message => {
      responses.push(message);
      // 并发 handleApiCall 的响应可能交错，按请求 ID 配对分发
      for (const fn of listeners) fn(message);
    },
    log: () => {},
    friendSyncPaused: false,
    require: request => {
      if (request === '../services/mystery-shop') return service;
      throw new Error(`unexpected require from handleApiCall: ${request}`);
    },
  };
  const script = new vm.Script(extractWorkerApiSource(), { filename: 'worker.js#api-entry' });
  const { handleApiCall } = script.runInContext(vm.createContext(sandbox));
  return {
    handleApiCall,
    responses,
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

/** 组装完整真实链：商人服务 → Worker 入口 → 管理器 → 神秘商人路由。 */
function buildAdminChain({ service, connected = true } = {}) {
  const workerEntry = buildWorkerEntry(service);
  const { manager, proc, cleanup } = buildManagerHarness();

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
          await workerEntry.handleApiCall(msg);
        } finally {
          workerEntry.removeListener(onSend);
        }
        if (response) proc.emitMessage(response);
      });
    }
  };

  const provider = {
    getStatus: () => ({ connection: { connected } }),
    getMysteryShop: accountId => manager.callWorkerApi(accountId, 'getMysteryShop'),
    buyMysteryShopGoods: (accountId, npcId) =>
      manager.callWorkerApi(accountId, 'buyMysteryShopGoods', npcId),
    abandonMysteryShop: accountId =>
      manager.callWorkerApi(accountId, 'abandonMysteryShop'),
  };
  const routes = new Map();
  const app = {
    get: (url, handler) => routes.set(url, handler),
    post: (url, handler) => routes.set(url, handler),
  };
  registerAdminMysteryShopRoutes({
    app,
    provider,
    getAccountIdFromRequest: () => 'acct-1',
    canAccessAccount: () => true,
    sendProviderError: (_res, err) => { throw err; },
  });

  async function invoke(url, body = {}) {
    let status = 200;
    let payload;
    const res = {
      status(code) { status = code; return res; },
      json(data) { payload = data; },
    };
    await routes.get(url)({ body }, res);
    return { status, payload };
  }

  const readMystery = () => invoke('/api/shop/mystery');
  const buyMystery = () => invoke('/api/shop/mystery/buy', { npcId: NPC_ID });
  const abandonMystery = () => invoke('/api/shop/mystery/abandon');

  return { manager, proc, cleanup, invoke, readMystery, buyMystery, abandonMystery };
}

const readCount = transport => transport.calls.filter(c => c === 'GetActiveNPC').length;
const buyCount = transport => transport.calls.filter(c => c === 'Buy').length;
const abandonCount = transport => transport.calls.filter(c => c === 'Abandon').length;

test.after(() => {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

// ==================== 1. 并发合并 + 60 秒成功缓存边界 ====================

test('面板三次并发读取合并为一次上游，60 秒内命中、到期仅新增一次（活跃商品）', { timeout: 5000 }, async () => {
  const fixture = loadMysteryFixture();
  const chain = buildAdminChain({ service: fixture.service });
  const clock = fakeClock();
  try {
    const [r1, r2, r3] = await Promise.all([
      chain.readMystery(), chain.readMystery(), chain.readMystery(),
    ]);
    for (const r of [r1, r2, r3]) {
      assert.equal(r.status, 200);
      assert.equal(r.payload.ok, true);
    }
    assert.deepEqual(r1.payload.data, r2.payload.data);
    assert.deepEqual(r1.payload.data, r3.payload.data);
    // 三次管理入口派发各自到达 Worker，但上游只读一次（合并发生在服务内）
    assert.equal(chain.proc.sent.filter(m => m.type === 'api_call').length, 3);
    assert.equal(readCount(fixture.transport), 1);

    // 缓存命中：完成后再次读取不再穿透上游
    const hit = await chain.readMystery();
    assert.equal(hit.payload.ok, true);
    assert.equal(readCount(fixture.transport), 1);

    // 原返回字段与原始读取完全一致
    const data = hit.payload.data;
    assert.equal(data.active, true);
    assert.equal(data.npcId, NPC_ID);
    assert.equal(data.itemId, ITEM_ID);
    assert.equal(data.itemName, `物品${ITEM_ID}`);
    assert.equal(data.itemCount, 2);
    assert.equal(data.currencyId, 1001);
    assert.equal(data.currencyName, '金币');
    assert.equal(data.price, 500);
    assert.equal(data.originalPrice, 1000);
    assert.equal(data.discount, 50);
    assert.equal(data.purchased, false);
    assert.equal(data.startTime, 1000);
    assert.equal(data.endTime, 0);

    // 不足 60 秒：不新增请求
    clock.advance(59_999);
    await chain.readMystery();
    assert.equal(readCount(fixture.transport), 1);

    // 达到 60 秒：仅新增一次读取
    clock.advance(1);
    const expired = await chain.readMystery();
    assert.equal(expired.payload.ok, true);
    assert.equal(expired.payload.data.active, true);
    assert.equal(readCount(fixture.transport), 2);
  } finally {
    clock.restore();
    chain.cleanup();
    fixture.restore();
  }
});

test('无活跃商品结果同样合并并发并按 60 秒边界缓存', { timeout: 5000 }, async () => {
  const fixture = loadMysteryFixture();
  fixture.transport.server.offer = emptyReply();
  const chain = buildAdminChain({ service: fixture.service });
  const clock = fakeClock();
  try {
    const reads = await Promise.all([
      chain.readMystery(), chain.readMystery(), chain.readMystery(),
    ]);
    for (const r of reads) {
      assert.equal(r.status, 200);
      assert.equal(r.payload.ok, true);
      assert.equal(r.payload.data.active, false);
    }
    assert.equal(readCount(fixture.transport), 1);

    await chain.readMystery();
    assert.equal(readCount(fixture.transport), 1);

    clock.advance(60_000);
    await chain.readMystery();
    assert.equal(readCount(fixture.transport), 2);
    // 失败不能伪装成空商品：这里缓存的是真实空结果（ok:true），与失败拒绝区分
    const again = await chain.readMystery();
    assert.equal(again.payload.ok, true);
  } finally {
    clock.restore();
    chain.cleanup();
    fixture.restore();
  }
});

// ==================== 2. 上游失败 60 秒冷却，无重试风暴 ====================

test('上游传输失败首轮只尝试一次，冷却期内面板读取零新增上游请求', { timeout: 5000 }, async () => {
  const fixture = loadMysteryFixture();
  fixture.transport.routes.GetActiveNPC = () => { throw new Error('upstream transport down'); };
  const chain = buildAdminChain({ service: fixture.service });
  const clock = fakeClock();
  try {
    // 并发调用共同失败，且只尝试一次
    const results = await Promise.allSettled([
      chain.readMystery(), chain.readMystery(), chain.readMystery(),
    ]);
    for (const r of results) assert.equal(r.status, 'rejected');
    assert.match(results[0].reason.message, /upstream transport down/);
    assert.equal(readCount(fixture.transport), 1);

    // 冷却期内连续读取：拒绝且不新增上游请求
    await assert.rejects(chain.readMystery(), /冷却/);
    await assert.rejects(chain.readMystery(), /冷却/);
    assert.equal(readCount(fixture.transport), 1);

    // 空转时间推移本身不产生后台重试
    clock.advance(30_000);
    assert.equal(readCount(fixture.transport), 1);
    clock.advance(29_999);
    assert.equal(readCount(fixture.transport), 1);

    // 冷却到期：允许一次新读取并成功（失败不能被缓存成假成功或空商品）
    fixture.transport.routes.GetActiveNPC = () => ({ body: fixture.transport.server.offer });
    clock.advance(1);
    const recovered = await chain.readMystery();
    assert.equal(recovered.status, 200);
    assert.equal(recovered.payload.ok, true);
    assert.equal(recovered.payload.data.active, true);
    assert.equal(readCount(fixture.transport), 2);
  } finally {
    clock.restore();
    chain.cleanup();
    fixture.restore();
  }
});

test('解码失败与传输失败同样进入冷却，失败不会变成成功或空商品', { timeout: 5000 }, async () => {
  const fixture = loadMysteryFixture();
  fixture.transport.routes.GetActiveNPC = () => ({ body: { __failDecode: true } });
  const chain = buildAdminChain({ service: fixture.service });
  const clock = fakeClock();
  try {
    await assert.rejects(chain.readMystery(), /decode failed/);
    assert.equal(readCount(fixture.transport), 1);

    clock.advance(59_999);
    await assert.rejects(chain.readMystery(), /冷却/);
    assert.equal(readCount(fixture.transport), 1);

    clock.advance(1);
    fixture.transport.routes.GetActiveNPC = () => ({ body: { __failDecode: true } });
    await assert.rejects(chain.readMystery(), /decode failed/);
    assert.equal(readCount(fixture.transport), 2);
  } finally {
    clock.restore();
    chain.cleanup();
    fixture.restore();
  }
});

// ==================== 3. 写后失效（购买 / 请离） ====================

test('购买成功后面板缓存失效，下一次读取重新穿透并拿到新状态', { timeout: 5000 }, async () => {
  const fixture = loadMysteryFixture();
  const chain = buildAdminChain({ service: fixture.service });
  try {
    const warm = await chain.readMystery();
    assert.equal(warm.payload.data.active, true);
    assert.equal(readCount(fixture.transport), 1);

    const buy = await chain.buyMystery();
    assert.equal(buy.status, 200);
    assert.equal(buy.payload.ok, true);
    assert.equal(buy.payload.data.purchased, true);
    assert.equal(buy.payload.data.reward.itemId, ITEM_ID);
    assert.equal(buyCount(fixture.transport), 1);
    assert.equal(readCount(fixture.transport), 1);

    // 失效后重新穿透：服务端已清空报价
    const after = await chain.readMystery();
    assert.equal(after.payload.ok, true);
    assert.equal(after.payload.data.active, false);
    assert.equal(readCount(fixture.transport), 2);

    // 新状态入缓存：再次读取命中
    await chain.readMystery();
    assert.equal(readCount(fixture.transport), 2);
  } finally {
    chain.cleanup();
    fixture.restore();
  }
});

test('请离成功同样失效面板缓存，重新穿透一次后命中新缓存', { timeout: 5000 }, async () => {
  const fixture = loadMysteryFixture();
  const chain = buildAdminChain({ service: fixture.service });
  try {
    await chain.readMystery();
    assert.equal(readCount(fixture.transport), 1);

    const abandon = await chain.abandonMystery();
    assert.equal(abandon.status, 200);
    assert.equal(abandon.payload.ok, true);
    assert.deepEqual(abandon.payload.data, { abandoned: true });
    assert.equal(abandonCount(fixture.transport), 1);

    const after = await chain.readMystery();
    assert.equal(after.payload.data.active, false);
    assert.equal(readCount(fixture.transport), 2);

    await chain.readMystery();
    assert.equal(readCount(fixture.transport), 2);
  } finally {
    chain.cleanup();
    fixture.restore();
  }
});

// ==================== 4. 自动购买不受面板缓存/冷却影响 ====================

test('自动检查保持新鲜读取：禁用零请求，货币不允许只读不买，允许时新鲜读+购买并失效面板缓存', { timeout: 5000 }, async () => {
  const fixture = loadMysteryFixture();
  const chain = buildAdminChain({ service: fixture.service });
  try {
    // 禁用：零请求
    fixture.setAutomation({ mystery_shop_auto_buy: false });
    const disabled = await fixture.service.checkAndAutoBuyMysteryShop();
    assert.deepEqual(disabled, { skipped: true, reason: 'disabled' });
    assert.equal(fixture.transport.calls.length, 0);

    // 货币不允许：一次读取、零购买
    fixture.setAutomation({
      mystery_shop_auto_buy: true,
      mystery_shop_allow_gold: false,
    });
    const notAllowed = await fixture.service.checkAndAutoBuyMysteryShop();
    assert.equal(notAllowed.skipped, true);
    assert.equal(notAllowed.reason, 'currency_not_allowed');
    assert.equal(readCount(fixture.transport), 1);
    assert.equal(buyCount(fixture.transport), 0);

    // 允许：先预热面板缓存，自动检查仍做新鲜读取并购买，成交后面板缓存失效
    fixture.setAutomation({
      mystery_shop_auto_buy: true,
      mystery_shop_allow_gold: true,
    });
    const warm = await chain.readMystery();
    assert.equal(warm.payload.data.active, true);
    assert.equal(readCount(fixture.transport), 2);

    const auto = await fixture.service.checkAndAutoBuyMysteryShop();
    assert.equal(auto.skipped, undefined);
    assert.equal(auto.purchased, true);
    assert.equal(auto.offer.npcId, NPC_ID);
    assert.equal(readCount(fixture.transport), 3, '自动检查未被面板缓存挡住');
    assert.equal(buyCount(fixture.transport), 1);

    const afterBuy = await chain.readMystery();
    assert.equal(afterBuy.payload.data.active, false);
    assert.equal(readCount(fixture.transport), 4, '自动买成交后面板缓存已失效');

    // 面板失败冷却不影响自动检查的新鲜读取（先请离失效缓存，使下次读取真正穿透）
    await chain.abandonMystery();
    let failNextRead = true;
    const realRoute = fixture.transport.routes.GetActiveNPC;
    fixture.transport.routes.GetActiveNPC = () => {
      if (failNextRead) {
        failNextRead = false;
        throw new Error('panel read upstream down');
      }
      return realRoute();
    };
    await assert.rejects(chain.readMystery(), /panel read upstream down/);
    assert.equal(readCount(fixture.transport), 5);
    await assert.rejects(chain.readMystery(), /冷却/);
    assert.equal(readCount(fixture.transport), 5);

    const autoAfterCooldown = await fixture.service.checkAndAutoBuyMysteryShop();
    assert.equal(autoAfterCooldown.skipped, true);
    assert.equal(autoAfterCooldown.reason, 'inactive');
    assert.equal(readCount(fixture.transport), 6, '冷却只约束面板，不约束自动检查');
    assert.equal(buyCount(fixture.transport), 1);
  } finally {
    chain.cleanup();
    fixture.restore();
  }
});

// ==================== 5. 写失败不扰动缓存/冷却；成功写入解除冷却 ====================

test('购买或请离抛错保留原语义，不清除有效缓存或失败冷却；成功写入解除冷却', { timeout: 5000 }, async () => {
  const fixture = loadMysteryFixture();
  const chain = buildAdminChain({ service: fixture.service });
  try {
    // 预热缓存
    await chain.readMystery();
    assert.equal(readCount(fixture.transport), 1);

    // 购买传输失败：错误原样透出，仍有效的面板缓存不被清除
    fixture.transport.routes.Buy = () => { throw new Error('buy transport down'); };
    await assert.rejects(chain.buyMystery(), /buy transport down/);
    const hitAfterFailedBuy = await chain.readMystery();
    assert.equal(hitAfterFailedBuy.payload.ok, true);
    assert.equal(hitAfterFailedBuy.payload.data.active, true);
    assert.equal(readCount(fixture.transport), 1);

    // 面板读取失败进入冷却（先请离成功失效缓存，使失败读取真正穿透）
    await chain.abandonMystery();
    fixture.transport.routes.GetActiveNPC = () => { throw new Error('read upstream down'); };
    await assert.rejects(chain.readMystery(), /read upstream down/);
    assert.equal(readCount(fixture.transport), 2);

    // 请离失败：不清除失败冷却（仍拒绝且零新增上游读取）
    fixture.transport.routes.Abandon = () => { throw new Error('abandon transport down'); };
    await assert.rejects(chain.abandonMystery(), /abandon transport down/);
    await assert.rejects(chain.readMystery(), /冷却/);
    assert.equal(readCount(fixture.transport), 2);

    // 成功写入同时解除失败冷却：下一次面板读取立即可获取新状态
    fixture.transport.server.offer = emptyReply();
    fixture.transport.routes.GetActiveNPC = () => ({ body: fixture.transport.server.offer });
    fixture.transport.routes.Buy = () => ({ body: buyReply() });
    const buy = await chain.buyMystery();
    assert.equal(buy.payload.ok, true);
    const immediate = await chain.readMystery();
    assert.equal(immediate.status, 200);
    assert.equal(immediate.payload.ok, true);
    assert.equal(immediate.payload.data.active, false);
    assert.equal(readCount(fixture.transport), 3);
  } finally {
    chain.cleanup();
    fixture.restore();
  }
});

// ==================== 6. 路由前置拒绝零 Worker 读取 ====================

test('离线前置拒绝与权限拒绝均零 Worker 读取', { timeout: 5000 }, async () => {
  const workerReads = { count: 0 };

  // 离线前置拒绝：本地连接状态判定，不触达 Worker
  {
    const routes = new Map();
    const app = {
      get: (url, handler) => routes.set(url, handler),
      post: (url, handler) => routes.set(url, handler),
    };
    registerAdminMysteryShopRoutes({
      app,
      provider: {
        getStatus: () => ({ connection: { connected: false } }),
        getMysteryShop: () => { workerReads.count += 1; return {}; },
      },
      getAccountIdFromRequest: () => 'acct-1',
      canAccessAccount: () => true,
      sendProviderError: (_res, err) => { throw err; },
    });
    let status = 200;
    let payload;
    const res = {
      status(code) { status = code; return res; },
      json(data) { payload = data; },
    };
    await routes.get('/api/shop/mystery')({ body: {} }, res);
    assert.equal(status, 200);
    assert.equal(payload.ok, false);
    assert.match(payload.error, /账号未运行/);
    assert.equal(workerReads.count, 0);
  }

  // 权限拒绝：403，零 Worker 读取
  {
    const routes = new Map();
    const app = {
      get: (url, handler) => routes.set(url, handler),
      post: (url, handler) => routes.set(url, handler),
    };
    registerAdminMysteryShopRoutes({
      app,
      provider: {
        getStatus: () => ({ connection: { connected: true } }),
        getMysteryShop: () => { workerReads.count += 1; return {}; },
      },
      getAccountIdFromRequest: () => 'acct-1',
      canAccessAccount: () => false,
      sendProviderError: (_res, err) => { throw err; },
    });
    let status = 200;
    let payload;
    const res = {
      status(code) { status = code; return res; },
      json(data) { payload = data; },
    };
    await routes.get('/api/shop/mystery')({ body: {} }, res);
    assert.equal(status, 403);
    assert.equal(payload.ok, false);
    assert.match(payload.error, /无权访问/);
    assert.equal(workerReads.count, 0);
  }
});

// ==================== 7. Worker 接线范围自检 ====================

test('Worker 接线仅限 getMysteryShop case 改接面板函数', () => {
  const caseStart = workerSrc.indexOf("case 'getMysteryShop':");
  assert.ok(caseStart >= 0, "case 'getMysteryShop' exists");
  const caseEnd = workerSrc.indexOf("case '", caseStart + 10);
  const block = workerSrc.slice(caseStart, caseEnd);
  assert.match(block, /getMysteryShopForPanel\(\)/);
  assert.ok(!/await\s+getActiveMysteryShop\(\)/.test(block),
    '面板 case 不得直调原始读取');

  // 购买与请离 case 编码保持原函数
  const buyStart = workerSrc.indexOf("case 'buyMysteryShopGoods':");
  const buyEnd = workerSrc.indexOf("case '", buyStart + 10);
  assert.ok(workerSrc.slice(buyStart, buyEnd).includes('buyMysteryShopGoods'));
  const abandonStart = workerSrc.indexOf("case 'abandonMysteryShop':");
  const abandonEnd = workerSrc.indexOf("case '", abandonStart + 10);
  assert.ok(workerSrc.slice(abandonStart, abandonEnd).includes('abandonMysteryShop'));

  // 自动购买链保持原始新鲜读取（调度侧仍直调 checkAndAutoBuyMysteryShop）
  assert.ok(workerSrc.includes("require('../services/mystery-shop')"));
});
