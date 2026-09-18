const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// 好友面板入口就绪与并发合并回归（2026-09-18 启动竞态修复）：
//
// 1) 真实执行生产入口逻辑：从 worker.js 提取真实的 handleApiCall 与
//    FRIEND_PANEL_ENTRY_METHODS，放进 vm 沙箱并注入依赖（isRunning/loginReady/
//    ws/sendToMaster + 真实 friend-land-analyzer / friend-orchestrator 链）。
//    「协议未加载 / 加载失败 / 已加载未登录 / ws 关闭 / 已停止」五种状态下，
//    普通与强制 getFriends、fetchFriendsDogInfo、syncFriendsFromGids 都及时
//    返回本地错误——零上游调用、不设置好友同步暂停（真实链路上游用永不
//    自动兑现的 deferred 模拟：删掉闸门 return 的变异会让链路打到上游并
//    设置暂停，被下面的断言直接抓住）。
//    状态与真实 worker 的对应：startBot 先置 isRunning 再 await loadProto，
//    协议未加载/加载失败时 loginReady 恒为 false；登录在途 ws OPEN 而
//    loginReady=false；断线窗口 ws CLOSED 而 loginReady 可能仍为 true。
// 2) friend-api 微信列表分支补请求/响应类型守卫：协议类型未加载时编码前
//    明确失败，零上游请求。
// 3) friend-land-analyzer getFriendsList 增加同代在途合并：并发读取共享一次
//    上游；失败释放在途引用、不缓存空数组；外部清缓存/替换缓存（代次变化）
//    隔离旧代在途结果，两种完成顺序都不污染新缓存；底层 getAllFriends
//    （核心巡查/到点偷菜路径）保持独立不进缓存。

const workerSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'worker.js'), 'utf8');
const orchestratorSrc = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'services', 'friend-orchestrator.js'), 'utf8');

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

/** 等待一个宏任务节拍，让所有微任务（含面板链路进入上游）落地。 */
function tick() {
  return new Promise(resolve => setImmediate(resolve));
}

// ==================== 1. 真实 handleApiCall 执行（vm 提取 + 依赖注入） ====================

/**
 * 加载真实的好友面板服务链：真实 friend-land-analyzer + 真实 friend-orchestrator，
 * 上游边界（getAllFriends）替换为手动控制的 deferred 记录器。
 */
function loadRealFriendPanelChain() {
  const analyzerPath = require.resolve('../src/services/friend-land-analyzer');
  const orchestratorPath = require.resolve('../src/services/friend-orchestrator');
  const friendApiPath = require.resolve('../src/services/friend-api');
  const networkPath = require.resolve('../src/utils/network');
  const storePath = require.resolve('../src/models/store');
  const fertilizerPath = require.resolve('../src/services/fertilizer-watch');
  const farmLandAnalyzerPath = require.resolve('../src/services/farm-land-analyzer');
  const farmPath = require.resolve('../src/services/farm');
  const governorPath = require.resolve('../src/services/request-governor');
  const friendOperationLimitsPath = require.resolve('../src/services/friend-operation-limits');
  const friendVisitPath = require.resolve('../src/services/friend-visit');
  const warehousePath = require.resolve('../src/services/warehouse');
  const paths = [analyzerPath, orchestratorPath, friendApiPath, networkPath, storePath,
    fertilizerPath, farmLandAnalyzerPath, farmPath, governorPath,
    friendOperationLimitsPath, friendVisitPath, warehousePath];
  const previous = new Map(paths.map(file => [file, require.cache[file]]));

  // 上游边界：真实链路最终调用的 getAllFriends，永不自动兑现
  const upstream = { calls: 0, forces: [], pending: [] };
  const getAllFriends = forceRefresh => {
    upstream.calls += 1;
    upstream.forces.push(forceRefresh === true);
    return new Promise((resolve, reject) => {
      upstream.pending.push({ resolve, reject });
    });
  };

  require.cache[friendApiPath] = mockModule(friendApiPath, {
    getAllFriends,
    extractReplyFriends: reply => (Array.isArray(reply && reply.game_friends)
      ? reply.game_friends : []),
    inFriendQuietHours: () => false,
    postToMaster: () => true,
    normalizeFriendGids: rawGids => {
      const result = [];
      for (const raw of Array.isArray(rawGids) ? rawGids : []) {
        const num = Number(raw) || 0;
        if (num > 0 && !result.includes(num)) result.push(num);
      }
      return result;
    },
    acceptFriends: async () => ({}),
    getApplications: async () => ({}),
    clearAllInvalidKnownFriendGidCooldown: () => {},
    enterFriendFarm: async () => ({ lands: [] }),
    leaveFriendFarm: async () => {},
    getDogName: () => '',
    handleFriendEnterError: () => ({ handled: false }),
    delFriend: async () => ({ ok: true }),
  });
  require.cache[networkPath] = mockModule(networkPath, {
    getUserState: () => ({ gid: 4321 }),
    isConnected: () => true,
    networkEvents: { on: () => {}, off: () => {} },
    sendMsgAsync: async () => { throw new Error('unexpected direct network call'); },
  });
  require.cache[storePath] = mockModule(storePath, {
    isAutomationOn: () => true,
    getFriendBlacklist: () => [],
    getWatchlistFriendGids: () => [],
    getAutoAcceptFriendMinLevel: () => 0,
    getKnownFriendGids: () => [],
    applyConfigSnapshot: () => {},
    getFriendBadRetryDate: () => null,
    readFriendDogInfoCache: () => null,
    writeFriendDogInfoCache: () => {},
    getPauseRemainMs: () => 0,
    getFriendQuietHours: () => ({}),
    getPlantBlacklist: () => [],
    removeFriendFromCache: () => {},
  });
  require.cache[fertilizerPath] = mockModule(fertilizerPath, {
    noteFriendSummaries: () => {},
    getDueWatchFriends: () => [],
    getNextWatchDueAt: () => 0,
    unwatchFriend: () => {},
    watchFriend: () => {},
    setPriorityGids: () => {},
    isPriorityGid: () => false,
    isFertilizerHot: () => false,
    getNextKnownFriendRipeEntry: () => null,
    inspectFriendLands: () => {},
    getFriendRipeSnapshot: () => null,
  });
  require.cache[farmLandAnalyzerPath] = mockModule(farmLandAnalyzerPath, {
    getCurrentPhase: () => null,
    buildLandMap: () => new Map(),
    getDisplayLandContext: () => ({
      sourceLand: null, occupiedByMaster: false, masterLandId: 0, occupiedLandIds: [],
    }),
    isOccupiedSlaveLand: () => false,
    getQixiDewStatus: () => null,
  });
  require.cache[farmPath] = mockModule(farmPath, {
    setOperationLimitsCallback: () => {},
  });
  require.cache[governorPath] = mockModule(governorPath, {
    getBreakerState: () => ({ active: false }),
  });
  require.cache[friendOperationLimitsPath] = mockModule(friendOperationLimitsPath, {
    checkDailyReset: () => {},
    canOperate: () => true,
    canOperateBad: () => true,
    getCanGetHelpExp: () => true,
    getHelpAutoDisabledByLimit: () => false,
    updateOperationLimits: () => {},
  });
  require.cache[friendVisitPath] = mockModule(friendVisitPath, {
    visitFriend: async () => ({}),
    visitFriendForSteal: async () => ({}),
    visitFriendForHelp: async () => ({}),
  });
  require.cache[warehousePath] = mockModule(warehousePath, {
    sellAllFruits: async () => ({}),
  });

  const previousAccountId = process.env.FARM_ACCOUNT_ID;
  process.env.FARM_ACCOUNT_ID = 'friends-panel-readiness-test';
  delete require.cache[analyzerPath];
  delete require.cache[orchestratorPath];
  const analyzer = require(analyzerPath);
  const orchestrator = require(orchestratorPath);
  return {
    analyzer,
    orchestrator,
    upstream,
    restore() {
      if (previousAccountId === undefined) delete process.env.FARM_ACCOUNT_ID;
      else process.env.FARM_ACCOUNT_ID = previousAccountId;
      delete require.cache[analyzerPath];
      delete require.cache[orchestratorPath];
      for (const file of paths) {
        if (previous.get(file)) require.cache[file] = previous.get(file);
        else delete require.cache[file];
      }
    },
  };
}

/** 从 worker.js 源码提取真实面板入口：入口集合 + 完整 handleApiCall。 */
function extractWorkerEntrySource() {
  const setStart = workerSrc.indexOf('const FRIEND_PANEL_ENTRY_METHODS = new Set([');
  assert.ok(setStart >= 0, 'FRIEND_PANEL_ENTRY_METHODS declaration exists in worker.js');
  const setEnd = workerSrc.indexOf(']);', setStart) + ']);'.length;
  const fnStart = workerSrc.indexOf('async function handleApiCall', setEnd);
  assert.ok(fnStart > setEnd, 'handleApiCall exists after the entry set');
  const fnEnd = workerSrc.indexOf('// ==================== 每日礼包总览', fnStart);
  assert.ok(fnEnd > fnStart, 'handleApiCall end marker exists');
  return `${workerSrc.slice(setStart, setEnd)}\n${workerSrc.slice(fnStart, fnEnd)}\n;({ handleApiCall })`;
}

/**
 * 把（可能被变异的）入口源码放进 vm 沙箱执行，注入依赖。
 * isRunning / loginReady / friendSyncPaused 是沙箱属性：函数每次调用都读
 * 当前值，测试与真实代码共享同一个暂停变量。
 */
function buildWorkerEntry({ chain, isRunning, loginReady, ws, source = extractWorkerEntrySource() }) {
  const responses = [];
  const logs = [];
  const sandbox = {
    isRunning,
    loginReady,
    getWs: () => ws,
    sendToMaster: message => responses.push(message),
    log: (scope, message, meta) => logs.push({ scope, message, meta }),
    friendSyncPaused: false,
    getFriendsList: chain.analyzer.getFriendsList,
    fetchFriendsDogInfo: chain.analyzer.fetchFriendsDogInfo,
    syncFriendsFromGids: chain.orchestrator.syncFriendsFromGids,
    require: () => { throw new Error('unexpected require from handleApiCall in test'); },
  };
  const script = new vm.Script(source, { filename: 'worker.js#friends-panel-entry' });
  const { handleApiCall } = script.runInContext(vm.createContext(sandbox));
  return { handleApiCall, responses, logs, sandbox };
}

const NOT_READY_STATES = [
  // 协议未加载：startBot 已置 isRunning=true，loadProto 仍在途，未连接
  { name: '协议未加载（启动窗口）', isRunning: true, loginReady: false, ws: null },
  // 协议加载失败：loadProto 抛出后 loginReady 恒为 false，ws 未建立
  { name: '协议加载失败（启动中断）', isRunning: true, loginReady: false, ws: null },
  // 协议已就绪、WS 已打开，但 LoginReply 未回（登录在途）
  { name: '已加载未登录（登录在途）', isRunning: true, loginReady: false, ws: { readyState: 1 } },
  // 断线竞态窗口：登录态尚未被 disconnect 处理器清零而连接已关闭
  { name: 'ws 已关闭（断线窗口）', isRunning: true, loginReady: true, ws: { readyState: 3 } },
  // stopBot 之后：isRunning/loginReady 均为 false
  { name: '已停止', isRunning: false, loginReady: false, ws: { readyState: 3 } },
];

const PANEL_ENTRIES = [
  { method: 'getFriends', args: [false], label: 'getFriends 普通' },
  { method: 'getFriends', args: [true], label: 'getFriends 强制' },
  { method: 'fetchFriendsDogInfo', args: [], label: 'fetchFriendsDogInfo' },
  { method: 'syncFriendsFromGids', args: [[7001]], label: 'syncFriendsFromGids' },
];

test('未就绪状态矩阵：三个好友面板入口（普通/强制）及时本地错误、零上游、不设同步暂停', async () => {
  for (const state of NOT_READY_STATES) {
    // 每个状态一条全新真实链：analyzer 模块状态（缓存/在途/代次）互相隔离
    const chain = loadRealFriendPanelChain();
    try {
      for (const entry of PANEL_ENTRIES) {
        chain.upstream.calls = 0;
        const workerEntry = buildWorkerEntry({
          chain,
          isRunning: state.isRunning,
          loginReady: state.loginReady,
          ws: state.ws,
        });
        const requestId = `${state.name}/${entry.label}`;
        workerEntry.handleApiCall({ id: requestId, method: entry.method, args: entry.args });

        // 及时收口：两个宏任务节拍内必须收到本地响应（上游 deferred 永不自动兑现，
        // 删掉闸门 return 的变异不会在这里产生任何响应）
        await tick();
        await tick();
        const label = `${state.name} × ${entry.label}`;
        assert.equal(workerEntry.responses.length, 1, `${label}: 恰好一条本地响应`);
        const response = workerEntry.responses[0];
        assert.equal(response.type, 'api_response', `${label}: 按既有响应结构返回`);
        assert.equal(response.id, requestId, `${label}: 响应回带请求 id`);
        assert.match(response.error, /账号未就绪/, `${label}: 本地错误`);
        assert.strictEqual(response.result, null, `${label}: 不返回半成品结果`);
        assert.equal(chain.upstream.calls, 0, `${label}: 零上游调用`);
        assert.equal(workerEntry.sandbox.friendSyncPaused, false,
          `${label}: 未设置好友同步暂停`);
        assert.equal(chain.analyzer.getFriendsListCache(), null,
          `${label}: 面板缓存未被未就绪调用触碰`);
      }
    } finally {
      chain.restore();
    }
  }
});

test('就绪状态：闸门放行，真实链路执行且同步暂停按既有语义设置并释放', async () => {
  const chain = loadRealFriendPanelChain();
  try {
    const workerEntry = buildWorkerEntry({
      chain, isRunning: true, loginReady: true, ws: { readyState: 1 },
    });
    const call = workerEntry.handleApiCall({
      id: 'ready/forced-getFriends', method: 'getFriends', args: [true],
    });
    await tick();
    assert.equal(chain.upstream.calls, 1, '就绪的强制调用进入真实链路');
    assert.equal(workerEntry.sandbox.friendSyncPaused, true,
      '真实同步操作仍按既有语义暂停自动化');
    assert.equal(workerEntry.responses.length, 0, '响应等待真实上游完成');

    chain.upstream.pending[0].resolve({ game_friends: [{ gid: 888, name: 'Friend-888', level: 5 }] });
    await call;
    assert.equal(workerEntry.sandbox.friendSyncPaused, false, '同步完成后暂停释放');
    assert.equal(workerEntry.responses.length, 1);
    const response = workerEntry.responses[0];
    assert.strictEqual(response.error, null);
    assert.ok(Array.isArray(response.result), '面板拿到真实列表');
    assert.equal(response.result.length, 1);
    assert.equal(response.result[0].gid, 888);

    // 上游结果已入缓存：随后的普通读取命中缓存，零上游
    chain.upstream.calls = 0;
    await workerEntry.handleApiCall({ id: 'ready/normal-getFriends', method: 'getFriends', args: [false] });
    assert.equal(chain.upstream.calls, 0, '就绪的普通读取命中缓存零上游');
  } finally {
    chain.restore();
  }
});

test('变异杀灭：删掉就绪闸门的 return 后，上游调用与同步暂停立即暴露', async () => {
  // 证明上面的矩阵断言能杀死「删掉闸门 return 仍继续执行」的变异：
  // 在提取的真实源码上精确移除闸门 return，观察行为差异。
  const source = extractWorkerEntrySource();
  const anchor = source.indexOf('账号未就绪');
  const returnAt = source.indexOf('return;', anchor);
  assert.ok(anchor >= 0 && returnAt > anchor, 'gate return located in extracted source');
  const mutated = source.slice(0, returnAt) + source.slice(returnAt + 'return;'.length);
  assert.notEqual(mutated, source, 'mutation removes the gate return');

  const chain = loadRealFriendPanelChain();
  try {
    const workerEntry = buildWorkerEntry({
      chain,
      isRunning: true,
      loginReady: false,          // 已加载未登录（登录在途）
      ws: { readyState: 1 },
      source: mutated,
    });
    const call = workerEntry.handleApiCall({
      id: 'mutant/forced-getFriends', method: 'getFriends', args: [true],
    });
    await tick();
    await tick();
    // 变异行为：本地错误之外链路继续执行——打到上游并设置同步暂停，
    // 这两个可观测信号正是矩阵断言（零上游/不设暂停）会失败的点
    assert.equal(chain.upstream.calls, 1,
      'mutant reaches the upstream (matrix zero-upstream assertion fails)');
    assert.equal(workerEntry.sandbox.friendSyncPaused, true,
      'mutant sets the sync pause (matrix no-pause assertion fails)');

    // 收口变异调用，避免悬挂的测试 Promise
    chain.upstream.pending[0].resolve({ game_friends: [] });
    await call;
  } finally {
    chain.restore();
  }
});

test('就绪闸门只作用于面板 RPC，不进入任何收益链调度路径', () => {
  for (const [marker, endMarker] of [
    ['async function runOwnHarvestStrike', '// ==================== 好友成熟哨兵'],
    ['async function runStealTick', '// ==================== 统一调度器'],
    ['async function runUnifiedTick', 'function scheduleUnifiedNextTick'],
  ]) {
    const start = workerSrc.indexOf(marker);
    assert.ok(start >= 0, `${marker} exists`);
    const end = workerSrc.indexOf(endMarker, start);
    const body = workerSrc.slice(start, end);
    assert.doesNotMatch(body, /FRIEND_PANEL_ENTRY_METHODS/,
      `${marker} must not consult the panel readiness gate`);
    assert.doesNotMatch(body, /loginReady \|\| !ws/, `${marker} keeps its own pace`);
  }
});

test('核心巡查/成熟墙钟刷新仍直接调用 getAllFriends，不进入面板好友列表缓存', () => {
  const start = orchestratorSrc.indexOf('async function refreshFriendRipeSchedule');
  const end = orchestratorSrc.indexOf('function formatWatchlistRemain', start);
  const body = orchestratorSrc.slice(start, end);
  assert.match(body, /await getAllFriends\(\)/);
  assert.doesNotMatch(body, /getFriendsList/);
});

// ==================== 2. friend-api 微信分支类型守卫（行为） ====================

function loadFriendApi({ types, sendMsgAsync }) {
  const servicePath = require.resolve('../src/services/friend-api');
  const networkPath = require.resolve('../src/utils/network');
  const protoPath = require.resolve('../src/utils/proto');
  const storePath = require.resolve('../src/models/store');
  const interactPath = require.resolve('../src/services/interact');
  const paths = [servicePath, networkPath, protoPath, storePath, interactPath];
  const previous = new Map(paths.map(file => [file, require.cache[file]]));

  require.cache[networkPath] = mockModule(networkPath, {
    sendMsgAsync,
    networkEvents: { on: () => {}, off: () => {} },
  });
  require.cache[protoPath] = mockModule(protoPath, { types });
  require.cache[storePath] = mockModule(storePath, {
    getKnownFriendGids: () => [],
    applyConfigSnapshot: () => {},
    getFriendBlacklist: () => [],
    removeFriendFromCache: () => {},
  });
  require.cache[interactPath] = mockModule(interactPath, {
    getInteractRecords: async () => [],
  });
  delete require.cache[servicePath];

  const { CONFIG } = require('../src/config/config');
  const previousPlatform = CONFIG.platform;
  CONFIG.platform = 'wx';
  return {
    service: require(servicePath),
    restore() {
      CONFIG.platform = previousPlatform;
      delete require.cache[servicePath];
      for (const file of paths) {
        if (previous.get(file)) require.cache[file] = previous.get(file);
        else delete require.cache[file];
      }
    },
  };
}

test('微信分支缺少消息类型时编码前明确失败，零上游请求', async () => {
  const calls = [];
  const { service, restore } = loadFriendApi({
    types: {}, // 协议类型未加载（启动窗口/加载失败）
    sendMsgAsync: async (...args) => { calls.push(args); return { body: {} }; },
  });
  try {
    await assert.rejects(service.getAllFriends(), /GetAll 接口类型未加载/);
    await assert.rejects(service.getAllFriends(true), /GetAll 接口类型未加载/);
    assert.equal(calls.length, 0, 'no upstream request leaves the worker');
  } finally {
    restore();
  }
});

test('类型齐备时微信分支正常直发 GetAll；底层读取保持独立（不加等待/缓存）', async () => {
  const calls = [];
  const reply = { game_friends: [{ gid: 11, name: 'A' }] };
  const types = {
    GetAllFriendsRequest: makeType(),
    GetAllFriendsReply: { ...makeType(), decode: () => reply },
  };
  const { service, restore } = loadFriendApi({
    types,
    sendMsgAsync: async (service_, method) => {
      calls.push([service_, method]);
      return { body: {} };
    },
  });
  try {
    const result = await service.getAllFriends();
    assert.deepEqual(calls, [['gamepb.friendpb.FriendService', 'GetAll']]);
    assert.equal(result.game_friends.length, 1);

    // 收益链读取（核心巡查/到点偷菜）直接调用 getAllFriends：并发两次 = 两次
    // 独立上游请求，不进入面板在途合并或缓存
    await Promise.all([service.getAllFriends(), service.getAllFriends()]);
    assert.equal(calls.length, 3, 'underlying revenue-path reads stay independent');
  } finally {
    restore();
  }
});

// ==================== 3. 好友列表在途合并与代次隔离（行为） ====================

function makeDeferredGetAllFriends() {
  const state = { calls: 0, pending: [] };
  const getAllFriends = () => {
    state.calls += 1;
    return new Promise((resolve, reject) => {
      state.pending.push({ resolve, reject });
    });
  };
  return { state, getAllFriends };
}

function loadAnalyzer({ getAllFriends, ripeSnapshot = null, enterFriendFarm }) {
  const servicePath = require.resolve('../src/services/friend-land-analyzer');
  const friendApiPath = require.resolve('../src/services/friend-api');
  const networkPath = require.resolve('../src/utils/network');
  const storePath = require.resolve('../src/models/store');
  const fertilizerPath = require.resolve('../src/services/fertilizer-watch');
  const farmLandAnalyzerPath = require.resolve('../src/services/farm-land-analyzer');
  const paths = [servicePath, friendApiPath, networkPath, storePath,
    fertilizerPath, farmLandAnalyzerPath];
  const previous = new Map(paths.map(file => [file, require.cache[file]]));

  require.cache[friendApiPath] = mockModule(friendApiPath, {
    getAllFriends,
    enterFriendFarm: enterFriendFarm || (async () => ({ lands: [] })),
    leaveFriendFarm: async () => {},
    getDogName: () => '',
    handleFriendEnterError: () => ({ handled: false }),
  });
  require.cache[networkPath] = mockModule(networkPath, {
    getUserState: () => ({ gid: 4321 }),
    networkEvents: { on: () => {}, off: () => {} },
    sendMsgAsync: async () => { throw new Error('unexpected upstream call'); },
  });
  require.cache[storePath] = mockModule(storePath, {
    getPlantBlacklist: () => [],
    getFriendBlacklist: () => [],
    readFriendDogInfoCache: () => null,
    writeFriendDogInfoCache: () => {},
  });
  require.cache[fertilizerPath] = mockModule(fertilizerPath, {
    inspectFriendLands: () => {},
    getFriendRipeSnapshot: gid => (ripeSnapshot ? ripeSnapshot(gid) : null),
  });
  require.cache[farmLandAnalyzerPath] = mockModule(farmLandAnalyzerPath, {
    getCurrentPhase: () => null,
    buildLandMap: () => new Map(),
    getDisplayLandContext: () => ({
      sourceLand: null, occupiedByMaster: false, masterLandId: 0, occupiedLandIds: [],
    }),
    isOccupiedSlaveLand: () => false,
    getQixiDewStatus: () => null,
  });
  delete require.cache[servicePath];
  const previousAccountId = process.env.FARM_ACCOUNT_ID;
  process.env.FARM_ACCOUNT_ID = 'friends-panel-readiness-test';
  return {
    service: require(servicePath),
    restore() {
      if (previousAccountId === undefined) delete process.env.FARM_ACCOUNT_ID;
      else process.env.FARM_ACCOUNT_ID = previousAccountId;
      delete require.cache[servicePath];
      for (const file of paths) {
        if (previous.get(file)) require.cache[file] = previous.get(file);
        else delete require.cache[file];
      }
    },
  };
}

const replyWithGids = gids => ({ game_friends: gids.map(gid => ({ gid, name: `F${gid}`, level: 3 })) });

test('并发好友列表请求（普通+强制混合）只触发一次上游读取并共享结果', async () => {
  const { state, getAllFriends } = makeDeferredGetAllFriends();
  const ripeAt = Date.now() + 5000;
  const { service, restore } = loadAnalyzer({
    getAllFriends,
    ripeSnapshot: gid => (gid === 22 ? { dueAt: ripeAt, source: 'lands' } : null),
  });
  try {
    const pending = [
      service.getFriendsList(true),
      service.getFriendsList(true),
      service.getFriendsList(false),
    ];
    assert.equal(state.calls, 1, 'concurrent panel reads share one upstream call');
    state.pending[0].resolve(replyWithGids([11, 22, 4321]));
    const results = await Promise.all(pending);
    for (const list of results) {
      assert.deepEqual(list.map(f => f.gid), [11, 22], 'self gid filtered, shared result');
    }
    // 精确成熟墙钟合并逻辑保留：已读地块墙钟并进好友条目
    assert.equal(results[0].find(f => f.gid === 22).plant.ripeAt, ripeAt);
    assert.equal(results[0].find(f => f.gid === 22).plant.timeSource, 'lands');
    assert.equal(results[0].find(f => f.gid === 11).plant, null);

    // 完成值缓存生效：后续非强制读取零上游
    const cached = await service.getFriendsList(false);
    assert.equal(cached.length, 2);
    assert.equal(state.calls, 1);
  } finally {
    restore();
  }
});

test('读取失败释放在途引用并返回空数组；失败不缓存，下一次显式请求可恢复', async () => {
  let failing = true;
  const state = { calls: 0 };
  const { service, restore } = loadAnalyzer({
    getAllFriends: async () => {
      state.calls += 1;
      if (failing) throw new Error('请求超时');
      return replyWithGids([33, 44]);
    },
  });
  try {
    // 失败的并发请求也共享一次尝试，各自拿到空数组
    const [a, b] = await Promise.all([service.getFriendsList(true), service.getFriendsList(false)]);
    assert.deepEqual(a, []);
    assert.deepEqual(b, []);
    assert.equal(state.calls, 1);

    // 失败没有缓存空数组：无缓存时非强制读取会再次发起
    failing = false;
    const recovered = await service.getFriendsList(false);
    assert.deepEqual(recovered.map(f => f.gid), [33, 44]);
    assert.equal(state.calls, 2);

    // 成功后的显式强制刷新也正常工作（在途引用已释放）
    await service.getFriendsList(true);
    assert.equal(state.calls, 3);
  } finally {
    restore();
  }
});

test('旧代先完成：结果只返回给等待者，不回填缓存；新代在途时第三次调用共享新请求', async () => {
  const { state, getAllFriends } = makeDeferredGetAllFriends();
  const { service, restore } = loadAnalyzer({ getAllFriends });
  try {
    // 第一代读取挂起，一个并发请求加入
    const first = service.getFriendsList(true);
    const joined = service.getFriendsList(true);
    assert.equal(state.calls, 1);

    // 外部清除缓存 → 代次变化
    service.setFriendsListCache(null);
    // 新请求不共享旧代在途，发起新读取
    const second = service.getFriendsList(true);
    assert.equal(state.calls, 2);

    // 旧代先完成：结果返回给等待者，但不回填缓存
    state.pending[0].resolve(replyWithGids([11, 12]));
    const firstList = await first;
    const joinedList = await joined;
    assert.deepEqual(firstList.map(f => f.gid), [11, 12]);
    assert.deepEqual(joinedList.map(f => f.gid), [11, 12]);
    assert.equal(service.getFriendsListCache(), null,
      '旧代完成不得污染当前缓存（此时缓存仍为空）');

    // 新请求仍在途时第三次调用：缓存为空、同代在途存在 → 共享第二代的
    // 上游请求，不再发第三次
    const third = service.getFriendsList(false);
    assert.equal(state.calls, 2, 'third call joins the still-pending new generation');

    // 第二代完成：第三代共享同一结果，缓存是第二代的结果
    state.pending[1].resolve(replyWithGids([33, 34]));
    const secondList = await second;
    const thirdList = await third;
    assert.deepEqual(secondList.map(f => f.gid), [33, 34]);
    assert.deepEqual(thirdList.map(f => f.gid), [33, 34]);
    assert.deepEqual(service.getFriendsListCache().map(f => f.gid), [33, 34],
      '最终缓存是新一代的结果（旧代未污染）');

    // 缓存生效后，非强制读取零上游
    assert.equal((await service.getFriendsList(false)).length, 2);
    assert.equal(state.calls, 2);
  } finally {
    restore();
  }
});

test('新代先完成：旧代结果晚到不覆盖新缓存；等待者仍拿到各自结果', async () => {
  const { state, getAllFriends } = makeDeferredGetAllFriends();
  const { service, restore } = loadAnalyzer({ getAllFriends });
  try {
    const first = service.getFriendsList(true);
    assert.equal(state.calls, 1);

    service.setFriendsListCache(null);
    const second = service.getFriendsList(true);
    assert.equal(state.calls, 2);

    // 新代先完成：回填缓存
    state.pending[1].resolve(replyWithGids([33, 34]));
    const secondList = await second;
    assert.deepEqual(secondList.map(f => f.gid), [33, 34]);
    assert.deepEqual(service.getFriendsListCache().map(f => f.gid), [33, 34]);

    // 旧代结果晚到：返回给旧等待者，但不覆盖新缓存
    state.pending[0].resolve(replyWithGids([11, 12]));
    const firstList = await first;
    assert.deepEqual(firstList.map(f => f.gid), [11, 12]);
    assert.deepEqual(service.getFriendsListCache().map(f => f.gid), [33, 34],
      '旧代晚到的结果不覆盖新缓存');

    // 非强制读取命中新缓存，零上游
    assert.deepEqual((await service.getFriendsList(false)).map(f => f.gid), [33, 34]);
    assert.equal(state.calls, 2);
  } finally {
    restore();
  }
});

test('外部替换缓存（非空值）：替换后普通读取直接命中替换值，旧代在途不覆盖', async () => {
  const { state, getAllFriends } = makeDeferredGetAllFriends();
  const { service, restore } = loadAnalyzer({ getAllFriends });
  try {
    const first = service.getFriendsList(true);
    assert.equal(state.calls, 1);

    // 外部替换缓存为非空值 → 代次变化
    const replacement = [{ gid: 99, name: 'Replaced-99', level: 9, plant: null }];
    service.setFriendsListCache(replacement);

    // 非强制读取直接命中替换值：零新上游（旧代仍在途）。缓存命中会重映射
    // 数组以合并最新成熟墙钟快照（既有行为），所以比对内容而不是引用
    const hit = await service.getFriendsList(false);
    assert.deepEqual(hit.map(f => f.gid), [99], 'replacement cache is served');
    assert.equal(state.calls, 1, 'cache hit triggers no upstream call');

    // 旧代完成：不覆盖被替换的缓存
    state.pending[0].resolve(replyWithGids([11, 12]));
    const firstList = await first;
    assert.deepEqual(firstList.map(f => f.gid), [11, 12]);
    assert.deepEqual(service.getFriendsListCache().map(f => f.gid), [99],
      '旧代完成不覆盖外部替换的缓存');

    // 强制刷新仍发起新读取（代次已隔离，不与旧代共享）
    const forced = service.getFriendsList(true);
    assert.equal(state.calls, 2);
    state.pending[1].resolve(replyWithGids([55]));
    assert.deepEqual((await forced).map(f => f.gid), [55]);
  } finally {
    restore();
  }
});

test('fetchFriendsDogInfo 的狗信息缓存写也走代次隔离：在途面板读取完成不覆盖狗信息', async () => {
  // 狗信息合并结果以前直接赋值 friendsListCache（绕过代次守卫），并发在途的
  // 面板列表读取完成后会用无狗信息的结果覆盖它；现在统一走 setFriendsListCache。
  const { state, getAllFriends } = makeDeferredGetAllFriends();
  const { service, restore } = loadAnalyzer({
    getAllFriends,
    // enterFriendFarm 按真实回包结构带 __briefDogInfo（护主犬 90021）
    enterFriendFarm: async () => ({ lands: [], __briefDogInfo: { dogId: 90021 } }),
  });
  try {
    // 面板普通读取在途（第一代）
    const panelRead = service.getFriendsList(false);
    assert.equal(state.calls, 1);

    // 种下含好友 77 的缓存（模拟上一轮面板结果），随后走狗信息合并写：
    // fetchFriendsDogInfo 使用当前缓存，不发好友列表请求，进门拿狗信息后写回
    service.setFriendsListCache([{ gid: 77, name: 'F77', level: 3, plant: null, dogId: 0, dogName: '' }]);
    const dogFetch = service.fetchFriendsDogInfo();
    const dogResult = await dogFetch;
    assert.equal(dogResult.ok, true);
    assert.equal(dogResult.friends[0].dogId, 90021, 'guard dog info merged');
    assert.equal(state.calls, 1, 'dog fetch reuses the cached list, no extra upstream');

    // 面板读取（第一代，代次已被两次写回推进）此刻完成：不得覆盖狗信息缓存
    state.pending[0].resolve(replyWithGids([77]));
    await panelRead;
    const cached = service.getFriendsListCache();
    assert.ok(Array.isArray(cached) && cached.length === 1,
      'dog-merged cache entry survives the concurrent panel read');
    assert.equal(cached[0].gid, 77);
    assert.equal(cached[0].dogId, 90021, 'guard dog info survives in the cache');
  } finally {
    restore();
  }
});
