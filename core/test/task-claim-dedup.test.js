// 任务领取按批去重：daily 回退/growth/主线合并及旧胶囊 pending 中的同一任务ID
// 只发一次 ClaimTaskReward；无效ID写前排除；去重仅作用本批，不影响后续快照。
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter } = require('node:events');

// 独立数据目录与合成身份：必须在首次加载业务模块之前设置。
const FIXTURE_PREFIX = 'task-claim-dedup-fixture-';
const prefix = path.resolve(os.tmpdir(), FIXTURE_PREFIX);
assert.equal(path.dirname(prefix), fs.realpathSync(os.tmpdir()));
const dataDir = fs.mkdtempSync(prefix);
process.env.FARM_DATA_DIR = dataDir;
process.env.FARM_ACCOUNT_ID = 'synthetic-task-claim-dedup';
after(() => {
  // 清理守卫：只删除本文件自己创建的 mkdtemp 目录。
  if (path.dirname(dataDir) === fs.realpathSync(os.tmpdir())
    && path.basename(dataDir).startsWith(FIXTURE_PREFIX)) {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

const { loadProto, types } = require('../src/utils/proto');
before(loadProto);

const store = require('../src/models/store');
const realUtils = require('../src/utils/utils');

const PATHS = {
  network: require.resolve('../src/utils/network'),
  scheduler: require.resolve('../src/services/scheduler'),
  stats: require.resolve('../src/services/stats'),
  utils: require.resolve('../src/utils/utils'),
  task: require.resolve('../src/services/task'),
  warehouse: require.resolve('../src/services/warehouse'),
  observability: require.resolve('../src/services/automation-observability'),
};

const REPLY_BY_METHOD = {
  TaskInfo: 'TaskInfoReply',
  ClaimTaskReward: 'ClaimTaskRewardReply',
  ClaimAllRewardsV2: 'ClaimAllRewardsV2Reply',
  Bag: 'BagReply',
};

// 真实 protobuf 编解码：请求由服务编码后在此解码校验，回复由真实 bytes 解码。
function taskEntry(id, overrides = {}) {
  return Object.assign({
    id, progress: 5, total_progress: 5, is_unlocked: true, is_claimed: false,
    task_type: 2, desc: `任务#${id}`, share_multiple: 0, rewards: [{ id: 1001, count: 10 }],
  }, overrides);
}

function encodeTaskInfoReply(info) {
  return types.TaskInfoReply.encode(types.TaskInfoReply.create({ task_info: info })).finish();
}

function decodedNotify(info) {
  const body = types.TaskInfoNotify.encode(types.TaskInfoNotify.create({ task_info: info })).finish();
  return types.TaskInfoNotify.decode(body).task_info;
}

// formatTask 输出形状的旧胶囊 pending 行（不依赖生产导出）。
function formattedTask(id, category, shareMultiple = 0) {
  return {
    id, desc: `任务#${id}`, category, progress: 5, totalProgress: 5,
    isClaimed: false, isUnlocked: true, shareMultiple, rewards: [{ id: 1001, count: 10 }], canClaim: true,
  };
}

/**
 * 安装隔离 mock（网络/调度器/日志/睡眠/stats）并重新加载真实 task 服务模块。
 * send(entry) 返回 { body } 指定响应字节、抛错模拟请求失败；默认返回空回复。
 */
function installHarness(opts = {}) {
  const events = new EventEmitter();
  const timers = new Map();
  const bound = new Map();
  const sent = [];
  const logs = [];
  const operations = [];
  const watched = [PATHS.network, PATHS.scheduler, PATHS.stats, PATHS.utils, PATHS.task];
  const oldEntries = watched.map((name) => [name, require.cache[name]]);

  require.cache[PATHS.network] = { exports: {
    isConnected: () => opts.connected !== false,
    networkEvents: events,
    sendMsgAsync: async (service, method, body) => {
      const entry = { service, method, request: method === 'ClaimTaskReward' ? types.ClaimTaskRewardRequest.decode(body) : null };
      sent.push(entry);
      const out = opts.send ? opts.send(entry) : null;
      if (out instanceof Error) throw out;
      if (out && out.body) return { body: out.body };
      const type = REPLY_BY_METHOD[method];
      if (!type) throw new Error(`测试未预期的请求方法: ${method}`);
      return { body: types[type].encode(types[type].create({})).finish() };
    },
  } };
  require.cache[PATHS.scheduler] = { exports: { createScheduler: () => ({
    clearAll: () => timers.clear(),
    setTimeoutTask: (name, delay, fn) => timers.set(name, { delay, fn }),
    bindTimeoutTask: (name, fn) => bound.set(name, fn),
  }) } };
  require.cache[PATHS.utils] = { exports: Object.assign({}, realUtils, {
    log: (tag, message, meta) => logs.push({ tag, message, meta }),
    logWarn: (tag, message, meta) => logs.push({ tag, message, meta, warn: true }),
    sleep: async () => {},
  }) };
  require.cache[PATHS.stats] = { exports: { recordOperation: (op, count) => operations.push({ op, count }) } };
  delete require.cache[PATHS.task];
  delete require.cache[PATHS.warehouse];
  delete require.cache[PATHS.observability];
  const service = require(PATHS.task);

  const restore = () => {
    try { service.cleanupTaskSystem(); } catch { /* 已清理时忽略 */ }
    for (const [name, value] of oldEntries) {
      if (value) require.cache[name] = value; else delete require.cache[name];
    }
    delete require.cache[PATHS.warehouse];
    delete require.cache[PATHS.observability];
    disableQuiet();
  };
  return { service, events, timers, bound, sent, logs, operations, restore };
}

const enable = () => store.applyConfigSnapshot({ automation: { task: true } }, { persist: false });
const disable = () => store.applyConfigSnapshot({ automation: { task: false } }, { persist: false });
const pause = (value) => store.applyConfigSnapshot(
  { friendQuietHours: { idleProtectionEnabled: false, pauseUntil: value ? new Date(Date.now() + 600000).toISOString() : '' } },
  { persist: false });
const disableQuiet = () => pause(false);

const claimIds = (h) => h.sent
  .filter((entry) => entry.method === 'ClaimTaskReward')
  .map((entry) => realUtils.toNum(entry.request.id));
const claimRequests = (h) => h.sent.filter((entry) => entry.method === 'ClaimTaskReward');
const byEvent = (h, event, extra = {}) => h.logs.filter((l) => l.meta && l.meta.event === event
  && Object.entries(extra).every(([key, value]) => l.meta[key] === value));

test('scan dedups candidates merged across daily/growth/main and inside one array, keeping distinct tasks, daily labels and encoded share multiplier', async () => {
  const info = {
    daily_tasks: [],
    growth_tasks: [taskEntry(500001, { task_type: 1 })],
    tasks: [
      taskEntry(200019),
      taskEntry(200020, { share_multiple: 2 }),
      taskEntry(200021),
      taskEntry(200019), // 数组内重复
      taskEntry(500001, { task_type: 1 }), // 与 growth 交叉重复
      taskEntry(600001, { task_type: 0 }),
    ],
    actives: [],
  };
  const h = installHarness({ send: (entry) => (entry.method === 'TaskInfo' ? { body: encodeTaskInfoReply(info) } : null) });
  try {
    enable(); disableQuiet();
    await h.service.checkAndClaimTasks();

    const ids = claimIds(h);
    assert.deepEqual(ids.sort((a, b) => a - b), [200019, 200020, 200021, 500001, 600001]); // 每个有效ID只发一次

    const claims = claimRequests(h);
    const shared = claims.find((entry) => realUtils.toNum(entry.request.id) === 200020);
    assert.equal(shared.request.do_shared, true); // share_multiple 实际编码进请求
    assert.ok(claims.filter((entry) => realUtils.toNum(entry.request.id) !== 200020)
      .every((entry) => entry.request.do_shared === false));

    const scan = byEvent(h, '扫描任务', { result: 'ok' }).filter((l) => !l.meta.scope);
    assert.equal(scan.length, 1);
    assert.equal(scan[0].meta.count, 5); // 扫描日志按唯一候选计数
    const dailyScan = byEvent(h, '扫描任务', { scope: 'daily' });
    assert.equal(dailyScan.length, 1);
    assert.equal(dailyScan[0].meta.count, 3);

    const okClaims = byEvent(h, '领取任务', { result: 'ok' });
    assert.equal(okClaims.filter((l) => l.message.includes('领取(每日任务)')).length, 3); // daily 分类保留
    assert.equal(okClaims.filter((l) => l.message.includes('领取(成长任务)')).length, 1);
    assert.equal(okClaims.filter((l) => l.message.includes('领取(任务)')).length, 1);
    assert.equal(h.sent.filter((entry) => entry.method === 'ClaimDailyReward').length, 0); // 活跃奖励未被触发
  } finally { h.restore(); }
});

test('taskInfoNotify push routes through the named debounce timer and claims duplicated rows once', async () => {
  const info = {
    daily_tasks: [taskEntry(200019)],
    growth_tasks: [taskEntry(200019)], // 跨分类重复
    tasks: [taskEntry(200019), taskEntry(200021), taskEntry(200021)], // 数组内重复
    actives: [],
  };
  const h = installHarness({});
  try {
    enable(); disableQuiet();
    h.service.initTaskSystem();
    assert.equal(h.timers.get('task_init_bootstrap').delay, 15000); // 初始引导定时器不变

    h.events.emit('taskInfoNotify', decodedNotify(info));
    const timer = h.timers.get('task_claim_debounce');
    assert.equal(timer.delay, 5000); // 具名去抖定时器
    const plan = byEvent(h, '领取任务', { result: 'plan' });
    assert.equal(plan.length, 1);
    assert.equal(plan[0].meta.count, 2); // 计划日志按唯一候选计数

    await timer.fn();
    assert.deepEqual(claimIds(h).sort((a, b) => a - b), [200019, 200021]);
    assert.equal(h.sent.filter((entry) => entry.method === 'ClaimDailyReward').length, 0);
  } finally { h.restore(); }
});

test('business rejection, thrown timeout and unknown result do not resend duplicate rows while independent tasks still claim', async () => {
  const info = {
    daily_tasks: [],
    tasks: [
      taskEntry(700001), taskEntry(700001), // 业务拒绝
      taskEntry(700002), taskEntry(700002), // 超时异常
      taskEntry(700003), taskEntry(700003), // 未知结果（回复不可解码）
      taskEntry(700004), // 独立任务正常领取
    ],
    actives: [],
  };
  const h = installHarness({ send: (entry) => {
    if (entry.method === 'TaskInfo') return { body: encodeTaskInfoReply(info) };
    if (entry.method !== 'ClaimTaskReward') return null;
    const id = realUtils.toNum(entry.request.id);
    if (id === 700001) throw Object.assign(new Error('服务器业务失败: ClaimTaskReward'), { isServerBusinessError: true });
    if (id === 700002) throw new Error('请求超时: ClaimTaskReward');
    if (id === 700003) return { body: Buffer.from([0x0F]) }; // 非法 wire type，解码抛错
    return null;
  } });
  try {
    enable(); disableQuiet();
    await h.service.checkAndClaimTasks();

    assert.deepEqual(claimIds(h).sort((a, b) => a - b), [700001, 700002, 700003, 700004]); // 每ID仅一次尝试
    assert.equal(byEvent(h, '领取任务', { result: 'ok', taskId: 700004 }).length, 1); // 独立任务仍成功
    assert.equal(h.operations.filter((op) => op.op === 'taskClaim').length, 1);
    assert.equal(byEvent(h, '任务领奖异常').length, 3); // 三类失败各一次告警，重复行不补发
  } finally { h.restore(); }
});

test('zero, negative and unsafe ids are excluded before any claim write', async () => {
  const info = {
    daily_tasks: [],
    tasks: [taskEntry(0), taskEntry(-5), taskEntry(2 ** 53), taskEntry(800001)],
    actives: [],
  };
  const h = installHarness({ send: (entry) => (entry.method === 'TaskInfo' ? { body: encodeTaskInfoReply(info) } : null) });
  try {
    enable(); disableQuiet();
    await h.service.checkAndClaimTasks();
    assert.deepEqual(claimIds(h), [800001]); // 无效ID零写，有效任务不受影响
    assert.equal(byEvent(h, '扫描任务', { result: 'ok' }).filter((l) => !l.meta.scope)[0].meta.count, 1);
  } finally { h.restore(); }
});

test('dedup is per batch only: fresh scans reclaim the same id; automation off, quiet and cleanup keep zero writes and re-init recovers', async () => {
  const info = () => ({ daily_tasks: [taskEntry(900001)], growth_tasks: [], tasks: [taskEntry(900001)], actives: [] });
  const h = installHarness({ send: (entry) => (entry.method === 'TaskInfo' ? { body: encodeTaskInfoReply(info()) } : null) });
  const countId = (id) => claimIds(h).filter((v) => v === id).length;
  try {
    enable(); disableQuiet();
    h.service.initTaskSystem(); // 挂接真实推送监听（初始引导定时器不主动触发）
    await h.service.checkAndClaimTasks();
    await h.service.checkAndClaimTasks(); // 两次新鲜快照同ID仍可再次领取
    assert.equal(countId(900001), 2);

    disable(); // 业务开关关闭：扫描与推送均零写
    const beforeOff = h.sent.length;
    await h.service.checkAndClaimTasks();
    h.events.emit('taskInfoNotify', decodedNotify(info()));
    assert.equal(h.sent.length, beforeOff);
    assert.ok(!h.timers.has('task_claim_debounce'));
    enable();

    pause(true); // 免打扰：pending 保留但定时器不发送
    h.events.emit('taskInfoNotify', decodedNotify(info()));
    const quietTimer = h.timers.get('task_claim_debounce');
    await quietTimer.fn();
    assert.equal(h.sent.length, beforeOff);
    assert.ok(h.timers.get('task_claim_debounce').delay >= 5000); // 顺延而非发送
    pause(false);

    h.service.cleanupTaskSystem(); // 清 pending 与全部定时器
    assert.equal(h.timers.size, 0);
    await quietTimer.fn(); // 旧定时器句柄消费空 pending
    assert.equal(h.sent.length, beforeOff);
    h.events.emit('taskInfoNotify', decodedNotify(info()));
    assert.ok(!h.timers.has('task_claim_debounce')); // 监听已摘除

    h.service.initTaskSystem(); // 再次 init 恢复监听与消费
    h.events.emit('taskInfoNotify', decodedNotify(info()));
    await h.timers.get('task_claim_debounce').fn();
    assert.equal(countId(900001), 3); // 新一轮同ID仅一次
  } finally { h.restore(); }
});

test('capsule-restored legacy pending list with duplicate rows is consumed with dedup', async () => {
  process.env.FARM_SESSION_BUSINESS = '1'; // wrapBusinessFunction 无 gate 时为 identity
  const h = installHarness({});
  try {
    enable(); disableQuiet();
    const { snapshotBusinessState, restoreBusinessState, bindBusinessState } = require('../src/services/business-state');
    const snapshot = snapshotBusinessState(); // 此刻仅 task 域注册（warehouse 未加载）
    const domain = snapshot.domains['services/task.js'];
    assert.ok(domain);
    // 模拟旧代码写入的胶囊：pending 内同ID重复行。
    domain.value.taskSystemInitialized = true;
    domain.value.pendingTaskClaim = {
      hasClaimable: true,
      actives: [],
      claimable: [formattedTask(950001, 'daily'), formattedTask(950001, 'main'), formattedTask(950002, 'main')],
    };
    restoreBusinessState(snapshot); // 真实胶囊 restore 赋值
    bindBusinessState(); // 真实 bind 重新挂接具名定时器
    assert.equal(h.events.listenerCount('taskInfoNotify'), 1);

    const timerFn = h.bound.get('task_claim_debounce');
    assert.equal(typeof timerFn, 'function');
    await timerFn();
    assert.deepEqual(claimIds(h).sort((a, b) => a - b), [950001, 950002]); // 消费时同样去重
  } finally {
    h.restore();
    delete process.env.FARM_SESSION_BUSINESS;
  }
});
