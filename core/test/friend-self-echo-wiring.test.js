const { test } = require('node:test');
const assert = require('node:assert/strict');

/**
 * 自回声票据流接线测试（2026-09-26）。
 * Producer：真实 friend-operation-limits 写函数 + 注入替身 sendMsgAsync
 *（不真实游戏写），验证 register/confirm/revoke 票据流。
 * Consumer：真实 worker.onFriendLandsChanged（替身只替换 I/O 依赖），
 * 验证缓存合并保留、纯自回声不激活外部 trigger、真实变化保留。
 */

// ===== 在加载被测模块前注入替身（不真实网络/不加延迟定时器） =====
const networkPath = require.resolve('../src/utils/network');
const utilsPath = require.resolve('../src/utils/utils');
const realUtils = require('../src/utils/utils');

let rpcHandler = null; // (method, payload) => Promise<{body}>

const networkStub = {
  getUserState: () => networkStub.__state,
  sendMsgAsync: async (service, method, payload) => rpcHandler(service, method, payload),
  __state: { gid: 0, name: '', level: 0, gold: 0, exp: 0 },
};

require.cache[networkPath] = {
  id: networkPath, filename: networkPath, loaded: true, exports: networkStub,
};
require.cache[utilsPath] = {
  id: utilsPath, filename: utilsPath, loaded: true,
  exports: {
    ...realUtils,
    sleep: async () => {},
    randomDelay: async () => {},
  },
};

const limits = require('../src/services/friend-operation-limits');
const echo = require('../src/services/friend-self-echo');
const { types, loadProto } = require('../src/utils/proto');

const HOST = 9201;
const SELF = 888;
const FRIEND = 556;

function growingPlant() {
  const nowSec = Math.floor(Date.now() / 1000);
  return {
    id: 1001, name: '测试作物',
    phases: [
      { phase: 2, begin_time: nowSec - 120, phase_id: 2 },
      { phase: 6, begin_time: nowSec + 7200, phase_id: 19 },
    ],
    season: 1, dry_num: 2, stole_num: 0, fruit_id: 20001, fruit_num: 30,
    weed_owners: [FRIEND], insect_owners: [FRIEND], stealers: [],
    grow_sec: 3600, stealable: false, left_inorc_fert_times: 3,
    left_fruit_num: 30, social_items: [],
  };
}
function growLand(id) {
  return { id, unlocked: true, level: 1, plant: growingPlant() };
}
function clone(x) { return JSON.parse(JSON.stringify(x)); }

test.before(async () => {
  await loadProto();
});

test('producer：putWeedsDetailed 成功回包确认 → 迟到纯回声可拦', async () => {
  echo.resetForTest();
  const land = growLand(1);
  echo.recordLandsBaseline(HOST, [land], Date.now());
  const post = clone(land);
  post.plant.weed_owners = [FRIEND, SELF]; // 放草 = owner 列表新增自己
  rpcHandler = async () => ({
    body: types.PutWeedsReply.encode(
      types.PutWeedsReply.create({ land: [post], operation_limits: [] })
    ).finish(),
  });
  const result = await limits.putWeedsDetailed(HOST, [1]);
  assert.equal(result.ok, 1);
  assert.equal(result.failed.length, 0);
  // 回包确认后的迟到推送（与回包逐地块一致 + 纯 WeeOut 差异）
  const v = echo.classifyPushLands(HOST, [clone(post)], SELF, Date.now());
  assert.equal(v.echoCount, 1, '真实生产写函数确认的票据应吸收迟到纯回声');
});

test('producer：putInsectsDetailed 在途 pending → 早于回包的纯回声可拦', async () => {
  echo.resetForTest();
  const land = growLand(2);
  echo.recordLandsBaseline(HOST, [land], Date.now());
  const earlyPush = clone(land);
  earlyPush.plant.insect_owners = [FRIEND, SELF];

  let resolveRpc;
  rpcHandler = () => new Promise(resolve => { resolveRpc = resolve; });
  const inflight = limits.putInsectsDetailed(HOST, [2]);
  await new Promise(r => setImmediate(r)); // 让 RPC 已发出、未回包

  const v = echo.classifyPushLands(HOST, [earlyPush], SELF, Date.now());
  assert.equal(v.echoCount, 1, 'pending 票据 + 纯自差异早到推送应被吸收');

  const post = clone(earlyPush);
  resolveRpc({
    body: types.PutInsectsReply.encode(
      types.PutInsectsReply.create({ land: [post], operation_limits: [] })
    ).finish(),
  });
  assert.equal((await inflight).ok, 1);
});

test('producer：RPC 失败撤销票据 → 后续纯回声放行', async () => {
  echo.resetForTest();
  const land = growLand(3);
  echo.recordLandsBaseline(HOST, [land], Date.now());
  rpcHandler = async () => { throw new Error('code=1001046 已放过'); };
  const result = await limits.putInsectsDetailed(HOST, [3]);
  assert.equal(result.ok, 0);
  const push = clone(land);
  push.plant.insect_owners = [FRIEND, SELF];
  const v = echo.classifyPushLands(HOST, [push], SELF, Date.now());
  assert.equal(v.echoCount, 0, '失败票据不得抑制后续推送');
});

test('producer：helpWater 成功回包确认纯浇水差异', async () => {
  echo.resetForTest();
  const land = growLand(4);
  echo.recordLandsBaseline(HOST, [land], Date.now());
  const post = clone(land);
  post.plant.dry_num = 0;
  rpcHandler = async () => ({
    body: types.WaterLandReply.encode(
      types.WaterLandReply.create({ land: [post], operation_limits: [] })
    ).finish(),
  });
  const reply = await limits.helpWater(HOST, [4]);
  assert.ok(Array.isArray(reply.land));
  const v = echo.classifyPushLands(HOST, [clone(post)], SELF, Date.now());
  assert.equal(v.echoCount, 1, '已确认纯浇水回声应被吸收');
});

// ===== Consumer：worker.onFriendLandsChanged 真实接线 =====
const workerPath = require.resolve('../src/core/worker');
const fwPath = require.resolve('../src/services/fertilizer-watch');
const faPath = require.resolve('../src/services/friend-activity');
const friendPath = require.resolve('../src/services/friend');
const fvPath = require.resolve('../src/services/friend-visit');

function stubModule(p, exportsObj) {
  require.cache[p] = { id: p, filename: p, loaded: true, exports: exportsObj };
}

let inspectCalls, activityCalls, pullCalls, fastLaneCalls;

function installWorkerStubs() {
  inspectCalls = []; activityCalls = []; pullCalls = []; fastLaneCalls = [];
  stubModule(fwPath, {
    inspectFriendLands: (...args) => { inspectCalls.push(args); return { ripeAt: 0, growing: false }; },
    getNextWatchDueAt: () => 0,
    getDueWatchFriends: () => [],
  });
  stubModule(faPath, {
    recordActivity: (...args) => { activityCalls.push(args); },
    noteFriendName: () => {},
  });
  stubModule(friendPath, {
    pullWatchlistPollToNow: (...args) => { pullCalls.push(args); },
    getNextStealDueAtMs: () => 0,
    getNextWatchlistStealDueAtMs: () => 0,
  });
  stubModule(fvPath, {
    fastLaneSteal: (...args) => { fastLaneCalls.push(args); },
  });
  delete require.cache[workerPath];
}

async function withWorker(fn) {
  installWorkerStubs();
  const worker = require('../src/core/worker');
  networkStub.__state.gid = SELF;
  try {
    await fn(worker);
  } finally {
    networkStub.__state.gid = 0;
  }
}

test('consumer：纯自回声推送 → 缓存合并保留，外部 trigger 不激活', async () => {
  await withWorker((worker) => {
    echo.resetForTest();
    const land = growLand(11);
    echo.recordLandsBaseline(HOST, [land], Date.now());
    echo.registerPendingWrite('PutInsects', HOST, [11], Date.now());
    const push = clone(land);
    push.plant.insect_owners = [FRIEND, SELF];

    worker.onFriendLandsChanged({ hostGid: HOST, lands: [push] });

    assert.equal(inspectCalls.length, 1, '缓存合并必须照常执行');
    assert.equal(inspectCalls[0][0], HOST);
    assert.equal(inspectCalls[0][2].length, 1, '推送地块全部进入 partial 合并');
    assert.ok(inspectCalls[0][4] && inspectCalls[0][4].partial === true);
    assert.equal(activityCalls.length, 0, '自回声不得记外部活跃');
    assert.equal(pullCalls.length, 0, '自回声不得拉近巡田');
    assert.equal(fastLaneCalls.length, 0, '自回声不得进快车道');
  });
});

test('consumer：真实变化推送 → 外部 trigger 链完整保留', async () => {
  await withWorker((worker) => {
    echo.resetForTest();
    const land = growLand(12);
    const push = clone(land);
    push.plant.left_inorc_fert_times = 1; // 好友施肥

    worker.onFriendLandsChanged({ hostGid: HOST, lands: [push] });

    assert.equal(inspectCalls.length, 1);
    assert.equal(activityCalls.length, 1, '真实变化必须记活跃');
    assert.ok(String(activityCalls[0][3]).includes('1 lands changed'));
    assert.equal(pullCalls.length, 1);
    assert.equal(fastLaneCalls.length, 1);
    assert.equal(fastLaneCalls[0][1].length, 1, '非回声地块交快车道');
  });
});

test('consumer：混合通知只把非回声地块交旧 trigger 链', async () => {
  await withWorker((worker) => {
    echo.resetForTest();
    const now = Date.now();
    const landA = growLand(21);
    const landB = growLand(22);
    echo.recordLandsBaseline(HOST, [landA, landB], now);
    echo.registerPendingWrite('PutInsects', HOST, [21], now);
    const pushA = clone(landA);
    pushA.plant.insect_owners = [FRIEND, SELF];
    const pushB = clone(landB);
    pushB.plant.left_inorc_fert_times = 2;

    worker.onFriendLandsChanged({ hostGid: HOST, lands: [pushA, pushB] });

    assert.equal(inspectCalls.length, 1);
    assert.equal(inspectCalls[0][2].length, 2, '全部地块都进缓存合并');
    assert.equal(activityCalls.length, 1);
    assert.ok(String(activityCalls[0][3]).includes('1 lands changed'),
      '活跃证据只按非回声地块计数');
    assert.equal(fastLaneCalls.length, 1);
    assert.equal(fastLaneCalls[0][1].length, 1, '只有非回声地块进快车道');
  });
});

test('consumer：tracker 异常 fail-open，真推送不丢', async () => {
  await withWorker((worker) => {
    echo.resetForTest();
    // 破坏 classifyPushLands 让 tracker 抛错
    const orig = echo.classifyPushLands;
    echo.classifyPushLands = () => { throw new Error('tracker boom'); };
    const push = clone(growLand(31));
    try {
      worker.onFriendLandsChanged({ hostGid: HOST, lands: [push] });
      assert.equal(inspectCalls.length, 1, 'fail-open 下缓存合并仍执行');
      assert.equal(activityCalls.length, 1, 'fail-open 必须走原始 lands 触发');
      assert.equal(fastLaneCalls.length, 1);
      assert.equal(fastLaneCalls[0][1].length, 1);
    } finally {
      echo.classifyPushLands = orig;
    }
  });
});
