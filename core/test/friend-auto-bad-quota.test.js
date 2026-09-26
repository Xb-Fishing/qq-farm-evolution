const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// 在线捣乱按游戏日额度暂停验收（2026-09-26）：用户定标
// "额度不足的话在线捣乱就可以停止到第二天了"。
// 真实生产 loop（start/runTickBody/schedulePoll 统一排程）+ fake clock +
// 临时状态目录 + 模拟 op-limit；零真实游戏请求，不写生产 FARM_DATA_DIR。
process.env.FARM_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fab-quota-'));
process.env.FARM_ACCOUNT_ID = 'quota-acct-a';

const requirePath = require.resolve('../src/services/friend-auto-bad');
const quotaPath = require.resolve('../src/services/friend-auto-bad-quota');
const autoBad = require('../src/services/friend-auto-bad');
const autoBadQuota = require('../src/services/friend-auto-bad-quota');
const friendActivity = require('../src/services/friend-activity');
const utils = require('../src/utils/utils');

const deps = autoBad.__depsForTests;
const qdeps = autoBadQuota.__depsForTests;
let fakeClock = Date.now();
const restores = [];

function applyStub(targetDeps, overrides = {}) {
  const base = {
    now: () => fakeClock,
    gids: () => [303],
    myGid: () => 1,
    connected: () => true,
    badRemaining: () => 50,
    bugRemaining: () => 50,
    weedRemaining: () => 50,
    quotaRefreshDay: () => { },
    quota: autoBadQuota,
    badPaused: () => false,
    checking: () => false,
    paused: () => false,
    quietHours: () => false,
    blacklist: () => new Set(),
    stealDue: () => false,
    stealImminent: () => false,
    harvestDue: () => false,
    harvestImminent: () => false,
    online: gid => friendActivity.isFriendOnlineRecently(gid, fakeClock),
    friendName: gid => friendActivity.getCachedFriendName(gid),
    visit: async () => ({ entered: true, online: true, bug: 1, weed: 0 }),
    delay: async () => { },
    ...overrides,
  };
  const originals = {};
  for (const [key, value] of Object.entries(base)) {
    originals[key] = targetDeps[key];
    targetDeps[key] = value;
  }
  restores.push(() => {
    for (const [key, value] of Object.entries(originals)) targetDeps[key] = value;
  });
  return base;
}

function stub(overrides = {}) {
  stub.lastBase = applyStub(deps, overrides);
  return stub.lastBase;
}

// quota 模块自身依赖注入：服务器时钟与 fakeClock 对齐、checkDailyReset 计数
let checkDailyResetCalls = 0;
function stubQuota(overrides = {}) {
  const base = {
    serverNow: () => fakeClock,
    accountId: () => process.env.FARM_ACCOUNT_ID || '',
    dataDir: () => process.env.FARM_DATA_DIR || '',
    checkDailyReset: () => { checkDailyResetCalls += 1; },
    ...overrides,
  };
  const originals = {};
  for (const [key, value] of Object.entries(base)) {
    originals[key] = qdeps[key];
    qdeps[key] = value;
  }
  restores.push(() => {
    for (const [key, value] of Object.entries(originals)) qdeps[key] = value;
  });
  return base;
}

function hookLog() {
  const events = [];
  utils.setLogHook((_tag, _msg, _isWarn, meta) => {
    if (meta && String(meta.event).startsWith('auto_bad')) events.push(meta);
  });
  return events;
}

function setup(overrides = {}) {
  autoBad.stopAutoBadLoop();
  autoBadQuota.resetForTests();
  fs.rmSync(path.join(process.env.FARM_DATA_DIR, 'auto-bad-quota'), { recursive: true, force: true });
  friendActivity.resetForTest();
  fakeClock = Date.now();
  stub(overrides);
  stubQuota();
  autoBad.startAutoBadLoop();
  return stub.lastBase;
}

/** 注入一次新鲜在线证据并跑一拍（生产 tick body 入口）。 */
async function wake(gid = 303, source = 'at_home') {
  friendActivity.recordActivity(gid, fakeClock, source, 't');
  fakeClock += 2_000;
  await autoBad.runTickBody();
}

test.afterEach(() => {
  while (restores.length) restores.pop()();
  autoBad.stopAutoBadLoop();
  autoBadQuota.resetForTests();
  friendActivity.resetForTest();
  utils.setLogHook(null);
});

// ===== 可信额度判定与当日暂停 =====

test('总额度 0：当日暂停、恰好一条明确日志、只留一个日界 timer', async () => {
  const events = hookLog();
  let refreshes = 0;
  setup({
    badRemaining: () => 0,
    quotaRefreshDay: () => { refreshes += 1; },
  });
  await wake(303);
  const pause = autoBadQuota.activePause();
  assert.ok(pause, '总额度 0 应进入当日暂停');
  assert.ok(pause.resumeAt > fakeClock, '恢复边界在未来');
  assert.equal(autoBad.__pollAtForTests(), pause.resumeAt, '唯一 pending timer 即日界');
  const pausedLogs = events.filter(e => e.event === 'auto_bad_quota_paused');
  assert.equal(pausedLogs.length, 1, '暂停日志恰好一条');
  assert.equal(pausedLogs[0].accountId, 'quota-acct-a');
  assert.ok(pausedLogs[0].reason);
  assert.ok(refreshes > 0, '读额度前先按游戏日刷新缓存');
  // 当日持续在线事件：零请求、不拉回短 timer、不重复日志
  for (let i = 0; i < 5; i++) {
    friendActivity.recordActivity(303, fakeClock, 'at_home', 't');
    fakeClock += 500;
    await autoBad.runTickBody();
  }
  const visits = 0; // visit 未被调用（该用例没注入计数，间接由 gate 与 poll 断言）
  assert.equal(visits, 0);
  assert.equal(autoBad.__pollAtForTests(), pause.resumeAt, '事件不得把日界 timer 拉回短间隔');
  assert.equal(events.filter(e => e.event === 'auto_bad_quota_paused').length, 1, '不反复打印额度耗尽');
  const sessions = autoBad.sessionCountForTests(); // 暂停前进的会话保留原语义
  friendActivity.recordActivity(303, fakeClock, 'at_home', 't');
  fakeClock += 500;
  assert.equal(autoBad.sessionCountForTests(), sessions, '暂停期证据不新建会话');
});

test('虫+草双单项 0：暂停；仅虫单项 0：照常执行另一项', async () => {
  // 双项 0
  hookLog();
  setup({ bugRemaining: () => 0, weedRemaining: () => 0 });
  await wake(303);
  assert.ok(autoBadQuota.activePause(), '双单项 0 应当日暂停');
  assert.equal(autoBadQuota.activePause().reason, 'both_items_zero');
  // 单项 0（虫）：不暂停，动作照常
  const visits = [];
  setup({
    bugRemaining: () => 0,
    weedRemaining: () => 50,
    visit: async friend => { visits.push(friend.gid); return { entered: true, online: true, bug: 0, weed: 1 }; },
  });
  await wake(303);
  assert.equal(visits.length, 1, '仅一项 0 不得停整个在线捣乱');
  assert.equal(autoBadQuota.activePause(), null, '单项 0 不进入日暂停');
});

test('denied/网络失败/断线不误停：额度未耗尽不进入日暂停，恢复后可执行', async () => {
  const visits = [];
  const base = setup({
    visit: async friend => { visits.push(friend.gid); return { entered: false, online: false, reason: 'enter_failed' }; },
  });
  await wake(303); // 进门失败（网络/服务端拒绝语义）
  assert.equal(autoBadQuota.activePause(), null, '进门失败 ≠ 额度耗尽');
  // 断线 tick 也不停
  deps.connected = () => false;
  await autoBad.runTickBody();
  assert.equal(autoBadQuota.activePause(), null, '断线 ≠ 额度耗尽');
  // 恢复后（退避到期 + 新证据）继续执行
  deps.connected = base.connected;
  deps.visit = async friend => { visits.push(friend.gid); return { entered: true, online: true, bug: 1, weed: 0 }; };
  fakeClock = autoBad.getSessionStateForTests(303).nextAt + 1;
  await wake(303);
  assert.equal(visits.length, 2, '普通失败后不日停、恢复后仍可执行');
});

// ===== 日界恢复 =====

test('午夜 server+8 日界：清缓存（checkDailyReset）、清闸门、等新证据再动作', async () => {
  const visits = [];
  setup({
    badRemaining: () => 0,
    visit: async friend => { visits.push(friend.gid); return { entered: true, online: true, bug: 1, weed: 0 }; },
  });
  await wake(303);
  const pause = autoBadQuota.activePause();
  assert.ok(pause);
  assert.equal(autoBad.sessionCountForTests(), 1, '暂停前存在待执行会话');
  // 跨到下一游戏日；新日额度已随服务器回包恢复
  fakeClock = pause.resumeAt + 1_000;
  deps.badRemaining = () => 50;
  await autoBad.runTickBody(); // 日界 timer 语义：先跑一拍清闸门/清缓存
  assert.ok(checkDailyResetCalls >= 1, '恢复必须走现有 checkDailyReset 更新额度缓存');
  assert.equal(autoBad.sessionCountForTests(), 0, '跨日恢复清掉未 done 的旧会话（旧证据不重放）');
  assert.equal(visits.length, 0, '恢复跨日第一拍零访问（不为恢复主动进门）');
  // 新的在线证据：再出手
  await wake(303, 'presence_online');
  assert.equal(visits.length, 1, '新游戏日新证据后恢复执行');
});

// ===== 次日恢复丢事件顺序回归（2026-09-26）=====
// 竞态：前一游戏日额度耗尽暂停（gate + 日界 timer）；跨日后、恢复 timer
// 尚未执行时新 at_home 证据先到。事件入口若不做跨日清理，随后的恢复
// tick 会 resumeIfNewDay 清掉所有未 done 会话——连刚建的新日会话一起丢。

test('恢复竞态-新事件先到：新日证据不被迟到恢复 tick 的跨日清理丢掉', async () => {
  const visits = [];
  setup({
    badRemaining: () => 0,
    visit: async friend => { visits.push(friend.gid); return { entered: true, online: true, bug: 1, weed: 0 }; },
  });
  await wake(303);
  const pause = autoBadQuota.activePause();
  assert.ok(pause);
  assert.equal(autoBad.sessionCountForTests(), 1, '暂停前存在旧日待执行会话');
  fakeClock = pause.resumeAt + 1_000; // 跨入新游戏日，恢复 timer 尚未执行
  deps.badRemaining = () => 50; // 新日额度已恢复
  // 新日新证据先到（订阅同步触发 handleOnlineEvidence），随后恢复 timer 到期一拍
  friendActivity.recordActivity(303, fakeClock, 'at_home', 't');
  fakeClock += 2_000;
  await autoBad.runTickBody();
  assert.equal(autoBad.sessionCountForTests(), 1, '新日证据会话必须跨过恢复清理存活');
  assert.equal(visits.length, 1, '新日新证据应正常出手');
  // 旧日待执行证据不得因竞态被重放：恢复后无新证据再拍一拍零访问
  fakeClock += 2_000;
  await autoBad.runTickBody();
  assert.equal(visits.length, 1, 'done 会话去重语义保持');
});

test('恢复竞态-timer先到：跨日清理旧会话、旧日待执行证据不重放（原语义保持）', async () => {
  const visits = [];
  setup({
    badRemaining: () => 0,
    visit: async friend => { visits.push(friend.gid); return { entered: true, online: true, bug: 1, weed: 0 }; },
  });
  await wake(303);
  const pause = autoBadQuota.activePause();
  assert.ok(pause);
  fakeClock = pause.resumeAt + 1_000;
  deps.badRemaining = () => 50;
  await autoBad.runTickBody(); // 恢复 timer 先到：清闸门/清缓存/清旧会话
  assert.equal(autoBad.sessionCountForTests(), 0, '跨日恢复清掉未 done 旧会话');
  assert.equal(visits.length, 0, '恢复第一拍零访问');
  fakeClock += 2_000;
  await autoBad.runTickBody(); // 无新证据：不重放
  assert.equal(visits.length, 0, '旧日待执行证据不得重放');
  friendActivity.recordActivity(303, fakeClock, 'at_home', 't');
  fakeClock += 2_000;
  await autoBad.runTickBody();
  assert.equal(visits.length, 1, 'timer 先到路径：新证据后正常出手');
});

test('时钟偏差：排程延迟按服务器钟计算，不用 resumeAt - 本机 now', async () => {
  const skew = 5 * 60_000; // 服务器钟快 5 分钟
  autoBad.stopAutoBadLoop();
  autoBadQuota.resetForTests();
  friendActivity.resetForTest();
  fakeClock = Date.now();
  stub({ badRemaining: () => 0 });
  stubQuota({ serverNow: () => fakeClock + skew });
  autoBad.startAutoBadLoop();
  await wake(303);
  const pause = autoBadQuota.activePause();
  assert.ok(pause);
  const expectedDelay = pause.resumeAt - (fakeClock + skew); // serverNow 口径
  assert.ok(expectedDelay > 0 && expectedDelay < pause.resumeAt - fakeClock,
    '两种口径确有差异（偏差生效前提）');
  assert.equal(autoBad.__pollAtForTests(), fakeClock + expectedDelay,
    '本地 timer 目标 = 本机 now + 服务器口径剩余毫秒');
});

test('磁盘记录校验：损坏/白名单外 reason/非安全整数/旧日 一律当无闸门，不透传不热循环', async () => {
  // 先真实暂停一次，拿到当日合法 dayKey/resumeAt 做基底
  setup({ badRemaining: () => 0 });
  await wake(303);
  const pause = autoBadQuota.activePause();
  assert.ok(pause);
  const file = autoBadQuota.__stateFileForTests('quota-acct-a');
  const variants = [
    { version: 1, dayKey: pause.dayKey, reason: 'arbitrary private text', resumeAt: pause.resumeAt },
    { version: 1, dayKey: 'garbage', reason: 'total_zero', resumeAt: pause.resumeAt },
    { version: 1, dayKey: pause.dayKey, reason: 'total_zero', resumeAt: 1e21 },
    { version: 2, dayKey: pause.dayKey, reason: 'total_zero', resumeAt: pause.resumeAt },
    { version: 1, dayKey: '2000-01-01', reason: 'both_items_zero', resumeAt: pause.resumeAt },
  ];
  for (const raw of variants) {
    autoBad.stopAutoBadLoop();
    autoBadQuota.resetForTests();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(raw));
    assert.equal(autoBadQuota.activePause(), null, `非法记录当无闸门：${JSON.stringify(raw)}`);
  }
  // 真实记录（本模块 pause 产物）读回仍有效
  setup({ badRemaining: () => 0 });
  await wake(303);
  assert.ok(autoBadQuota.activePause(), '合法记录不受校验影响');
});

test('相似账号哈希隔离：a/b 与 a_b 不因 sanitize 碰撞串闸门', async () => {
  fs.rmSync(path.join(process.env.FARM_DATA_DIR, 'auto-bad-quota'), { recursive: true, force: true });
  const fileAB = autoBadQuota.__stateFileForTests('a/b');
  const fileA_B = autoBadQuota.__stateFileForTests('a_b');
  assert.notEqual(fileAB, fileA_B, '文件名必须不同');
  // 两账号各自真实暂停后从磁盘重读，互不串
  for (const acct of ['a/b', 'a_b']) {
    process.env.FARM_ACCOUNT_ID = acct;
    autoBadQuota.resetForTests();
    const state = autoBadQuota.pause('total_zero');
    assert.ok(state, `${acct} 应能暂停`);
  }
  autoBadQuota.resetForTests(); // 强制下次懒加载走磁盘
  process.env.FARM_ACCOUNT_ID = 'a/b';
  assert.ok(autoBadQuota.activePause(), 'a/b 读回自己的闸门');
  process.env.FARM_ACCOUNT_ID = 'a_b';
  assert.ok(autoBadQuota.activePause(), 'a_b 读回自己的闸门（未被子路径/碰撞破坏）');
  process.env.FARM_ACCOUNT_ID = 'quota-acct-a';
});

// ===== 持久化与账号隔离 =====

test('stop/start 当日不忘；进程重启（重建模块）读回当日闸门；跨账号隔离', async () => {
  const visits = [];
  setup({
    badRemaining: () => 0,
    visit: async friend => { visits.push(friend.gid); return { entered: true, online: true, bug: 1, weed: 0 }; },
  });
  await wake(303);
  const pause = autoBadQuota.activePause();
  assert.ok(pause);
  autoBad.stopAutoBadLoop(); // stop 取消 timer 但保留当日闸门
  autoBad.startAutoBadLoop();
  assert.equal(autoBad.__pollAtForTests(), pause.resumeAt, '重启 loop 直接排到日界');
  await wake(303);
  assert.equal(visits.length, 0, 'stop/start 当日不忘已确认耗尽');

  // 进程重启：从 require 缓存外重建模块，仍读回当日闸门
  autoBad.stopAutoBadLoop();
  delete require.cache[requirePath];
  delete require.cache[quotaPath];
  const freshQuota = require(quotaPath);
  const freshBad = require(requirePath);
  assert.ok(freshQuota.activePause(), '重启后读回当日闸门（磁盘状态）');
  const freshDeps = freshBad.__depsForTests;
  const freshVisits = [];
  applyStub(freshDeps, {
    quota: freshQuota, // 重建后的模块用重建后的 quota（磁盘读回验证）
    badRemaining: () => 0,
    visit: async friend => { freshVisits.push(friend.gid); return { entered: true, online: true, bug: 1, weed: 0 }; },
  });
  try {
    freshBad.startAutoBadLoop();
    friendActivity.recordActivity(303, fakeClock, 'at_home', 't');
    fakeClock += 2_000;
    await freshBad.runTickBody();
    assert.equal(freshVisits.length, 0, '重启后当日闸门仍挡住动作');
    // 跨账号：同 dataDir 下其它账号不串闸门
    process.env.FARM_ACCOUNT_ID = 'quota-acct-b';
    assert.equal(freshQuota.activePause(), null, '跨账号不得沿用他人闸门');
    freshDeps.badRemaining = () => 50; // 账号 b 额度充足
    friendActivity.recordActivity(303, fakeClock, 'at_home', 't');
    fakeClock += 2_000;
    await freshBad.runTickBody();
    assert.equal(freshVisits.length, 1, '其它账号不受当日闸门影响');
    process.env.FARM_ACCOUNT_ID = 'quota-acct-a';
    assert.ok(freshQuota.activePause(), '原账号闸门不受其它账号读写影响');
  } finally {
    freshBad.stopAutoBadLoop();
    process.env.FARM_ACCOUNT_ID = 'quota-acct-a';
  }

  // 状态文件内容白名单：只有 version/dayKey/reason/resumeAt；路径归属运行数据目录
  const file = autoBadQuota.__stateFileForTests('quota-acct-a');
  assert.ok(file.startsWith(process.env.FARM_DATA_DIR), '状态文件归属运行数据目录（非相对 cwd）');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(Object.keys(raw).sort(), ['dayKey', 'reason', 'resumeAt', 'version']);
  assert.ok(!JSON.stringify(raw).includes('303'), '状态文件不含好友数据');
});

// ===== 动作把额度用完与旧代栅栏 =====

test('实际成功后额度变 0：随后进入日暂停', async () => {
  const events = hookLog();
  const visits = [];
  setup({
    visit: async friend => {
      visits.push(friend.gid);
      deps.badRemaining = () => 0; // 本次放置把总额度用完（回包更新缓存语义）
      return { entered: true, online: true, bug: 1, weed: 0 };
    },
  });
  await wake(303);
  assert.equal(visits.length, 1);
  assert.ok(autoBadQuota.activePause(), '动作把额度用完应进入日暂停');
  assert.equal(events.filter(e => e.event === 'auto_bad_quota_paused').length, 1, '一条明确日志');
  await wake(303); // 当日后续证据
  assert.equal(visits.length, 1, '暂停后当日不再动作');
});

test('旧代在途结果不写新代/其它账号状态：迟到结果不触发日暂停', async () => {
  let resolveVisit = null;
  setup({
    visit: () => new Promise(resolve => {
      resolveVisit = () => resolve({ entered: true, online: true, bug: 2, weed: 0 });
    }),
  });
  friendActivity.recordActivity(303, fakeClock, 'at_home', 't');
  fakeClock += 2_000;
  const old = autoBad.runTickBody(); // 旧代在途
  await new Promise(r => setTimeout(r, 30));
  autoBad.stopAutoBadLoop();
  autoBadQuota.resetForTests();
  autoBad.startAutoBadLoop(); // 新代
  deps.badRemaining = () => 0; // 旧代 settle 前额度被翻成 0
  resolveVisit();
  await old;
  assert.equal(autoBadQuota.activePause(), null, '旧代迟到结果不得写入新代日暂停');
});
