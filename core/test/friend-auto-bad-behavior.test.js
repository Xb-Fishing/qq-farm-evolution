const { test } = require('node:test');
const assert = require('node:assert/strict');

// 在线自动捣乱（2026-09-26 第三版：纯被动证据触发）行为验收：
// 全部为内存态/替身测试，无真实网络与游戏写请求。
// 用户定标：在线识别是被动 trigger——无新鲜在线证据即零 Enter/Leave/GetAll。
const autoBad = require('../src/services/friend-auto-bad');
const friendActivity = require('../src/services/friend-activity');
const { placeAutoBadItems, visitFriendForAutoBad } = require('../src/services/friend-visit');

const deps = autoBad.__depsForTests;
let fakeNow = Date.now();
const restores = [];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(predicate, timeoutMs, label) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true;
    await sleep(50);
  }
  throw new Error(`waitFor 超时: ${label}`);
}

function stub(overrides = {}) {
  const base = {
    now: () => fakeNow,
    gids: () => [303],
    myGid: () => 1,
    connected: () => true,
    badRemaining: () => 50,
    badPaused: () => false,
    checking: () => false,
    paused: () => false,
    quietHours: () => false,
    blacklist: () => new Set(),
    stealDue: () => false,
    stealImminent: () => false,
    harvestDue: () => false,
    harvestImminent: () => false,
    online: gid => friendActivity.isFriendOnlineRecently(gid, fakeNow),
    friendName: gid => friendActivity.getCachedFriendName(gid),
    visit: async () => ({ entered: true, online: false, bug: 0, weed: 0 }),
    delay: async () => { },
    ...overrides,
  };
  const originals = {};
  for (const [key, value] of Object.entries(base)) {
    originals[key] = deps[key];
    deps[key] = value;
  }
  restores.push(() => {
    for (const [key, value] of Object.entries(originals)) deps[key] = value;
  });
  return base;
}

function setup(overrides = {}) {
  autoBad.stopAutoBadLoop(); // 清会话状态与定时器
  friendActivity.resetForTest();
  fakeNow = Date.now();
  const base = stub(overrides);
  autoBad.startAutoBadLoop(); // 订阅证据：会话只能由在线证据创建
  return base;
}

/** 注入一次新鲜在线证据（at_home 等已证实在线源）并推进到证据唤醒之后。 */
async function wake(gid, source = 'at_home') {
  friendActivity.recordActivity(gid, fakeNow, source, 't');
  fakeNow += 2_000; // 越过证据拉近的 0.3-1.5s
  await autoBad.runTickBody();
}

async function runTicks(n = 1, stepMs = 10_000) {
  for (let i = 0; i < n; i++) {
    await autoBad.runTickBody();
    fakeNow += stepMs;
  }
}

test.afterEach(() => {
  while (restores.length) restores.pop()();
  autoBad.stopAutoBadLoop();
  friendActivity.resetForTest();
});

// ===== 核心验收：无证据零请求 =====

test('无在线证据：长时间推进零访问（全部未开捣乱/无人在线同理）', async () => {
  const visits = [];
  setup({
    gids: () => [303, 304],
    visit: async friend => { visits.push(friend.gid); return { entered: true, online: true, bug: 1, weed: 0 }; },
  });
  await runTicks(10, 60_000); // 10 分钟推进
  assert.equal(visits.length, 0, '无证据不得有任何 Enter/Leave');
  assert.equal(autoBad.sessionCountForTests(), 0, '无证据不得建会话');
});

test('启停与新名单不制造请求：start/名单变更/时间推进均零访问', async () => {
  const visits = [];
  setup({
    visit: async friend => { visits.push(friend.gid); return { entered: true, online: true, bug: 1, weed: 0 }; },
  });
  autoBad.stopAutoBadLoop();
  autoBad.startAutoBadLoop();
  deps.gids = () => [303, 304, 305];
  await runTicks(5, 30_000);
  assert.equal(visits.length, 0, '启停/新名单/时间推进不是发起理由');
});

test('结构收口：不再有 rosterCache/fetchRoster 依赖（名册零拉取）', () => {
  setup();
  assert.equal('rosterCache' in deps, false, '观察层名册缓存依赖应删除');
  assert.equal('fetchRoster' in deps, false, '自动名册拉取依赖应删除');
});

test('陈旧证据零动作：证据过期后 tick 不进门，等下一事件', async () => {
  const visits = [];
  setup({
    visit: async friend => { visits.push(friend.gid); return { entered: true, online: true, bug: 1, weed: 0 }; },
  });
  friendActivity.recordActivity(303, fakeNow, 'at_home', 't'); // 建会话
  fakeNow += 60_000; // 证据超过 10s 新鲜窗口
  await runTicks(3, 5_000);
  assert.equal(visits.length, 0, '陈旧证据不得发起动作');
});

// ===== 证据触发 =====

test('可信在线证据到达才动作：at_home/lands_push/presence_online 均触发', async () => {
  for (const source of ['at_home', 'presence_online']) {
    const visits = [];
    setup({
      visit: async friend => { visits.push(friend.gid); return { entered: true, online: true, bug: 1, weed: 0 }; },
    });
    await wake(303, source);
    assert.equal(visits.length, 1, `${source} 应触发一次动作`);
    assert.equal(visits[0], 303);
  }
});

test('非在线源与非名单目标不触发：summary_drift/last_login/social_item_placed 零动作', async () => {
  for (const source of ['summary_drift', 'last_login', 'social_item_placed']) {
    const visits = [];
    setup({
      visit: async friend => { visits.push(friend.gid); return { entered: true, online: true, bug: 1, weed: 0 }; },
    });
    friendActivity.recordActivity(303, fakeNow, source, 't');
    friendActivity.recordActivity(999, fakeNow, 'at_home', 't'); // 非名单目标
    fakeNow += 2_000;
    await runTicks(2, 5_000);
    assert.equal(visits.length, 0, `${source}/非名单目标不得触发`);
    assert.equal(autoBad.sessionCountForTests(), 0);
  }
});

test('没有重点标记也能触发：普通名单目标（非 watchlist）证据即动作', async () => {
  const visits = [];
  setup({
    gids: () => [303], // 与重点/watchlist 无关的显式 autoBad 名单
    visit: async friend => { visits.push(friend.gid); return { entered: true, online: true, bug: 2, weed: 1 }; },
  });
  await wake(303, 'presence_online');
  assert.equal(visits.length, 1);
  assert.equal(autoBad.getSessionStateForTests(303).done, true, '真实放成才 done');
});

test('守卫传给写动作：guard 是函数且 allowPlace=true', async () => {
  const visits = [];
  setup({
    visit: async (friend, tally, myGid, opts) => {
      visits.push({ gid: friend.gid, opts: { ...opts } });
      return { entered: true, online: true, bug: 1, weed: 0 };
    },
  });
  await wake(303);
  assert.equal(visits.length, 1);
  assert.equal(typeof visits[0].opts.guard, 'function', '调度必须传写动作守卫');
  assert.equal(visits[0].opts.allowPlace, true);
});

test('多事件不双发：连续多次证据只执行一次（done 后证据不重放）', async () => {
  const visits = [];
  setup({
    visit: async friend => { visits.push(friend.gid); return { entered: true, online: true, bug: 1, weed: 0 }; },
  });
  friendActivity.recordActivity(303, fakeNow, 'at_home', 't');
  friendActivity.recordActivity(303, fakeNow + 100, 'presence_online', 't');
  friendActivity.recordActivity(303, fakeNow + 200, 'at_home', 't');
  fakeNow += 2_000;
  await runTicks(3, 5_000);
  assert.equal(visits.length, 1, '多事件合并为一次执行');
  // done 后持续在线证据：不重复执行
  friendActivity.recordActivity(303, fakeNow, 'at_home', 't');
  fakeNow += 2_000;
  await runTicks(2, 5_000);
  assert.equal(visits.length, 1, 'done 后持续证据不得重复动作');
});

test('多目标公平轮转：同时有证据时串行全访问不漏', async () => {
  const visits = [];
  setup({
    gids: () => [303, 304, 305],
    visit: async friend => { visits.push(friend.gid); return { entered: true, online: true, bug: 1, weed: 0 }; },
  });
  for (const gid of [303, 304, 305]) friendActivity.recordActivity(gid, fakeNow, 'at_home', 't');
  fakeNow += 2_000;
  // 真实派发错峰（≥DISPATCH_GAP_MS）：三拍逐个串行访问，不漏不双发
  for (let i = 0; i < 3; i++) {
    friendActivity.recordActivity(303, fakeNow, 'at_home', 't');
    friendActivity.recordActivity(304, fakeNow, 'at_home', 't');
    friendActivity.recordActivity(305, fakeNow, 'at_home', 't');
    await autoBad.runTickBody();
    fakeNow += 3_000;
  }
  assert.deepEqual(visits.sort(), [303, 304, 305], '串行全覆盖');
  assert.equal(visits.length, 3, '每目标恰好一次');
});

test('lands_push 只是地块变化证据：记活跃但不点亮 online、不触发 autoBad（农场变化≠主人上线）', async () => {
  const visits = [];
  setup({
    visit: async friend => { visits.push(friend.gid); return { entered: true, online: true, bug: 1, weed: 0 }; },
  });
  friendActivity.recordActivity(303, fakeNow, 'lands_push', 't');
  assert.equal(friendActivity.isFriendActiveRecently(303, fakeNow), true, '仍是活跃证据');
  assert.equal(friendActivity.isFriendOnlineRecently(303, fakeNow), false, '不得点亮 online');
  fakeNow += 2_000;
  await runTicks(3, 5_000);
  assert.equal(autoBad.sessionCountForTests(), 0, 'lands_push 不得建会话');
  assert.equal(visits.length, 0, 'lands_push 不得触发动作');
});

// ===== 守卫：触发后翻转零写 =====

test('触发后暂停/断线/名单移除/额度耗尽：零访问', async () => {
  for (const [key, value] of [
    ['paused', true], ['quietHours', true], ['checking', true],
    ['badPaused', true], ['harvestDue', true], ['stealDue', true],
    ['connected', false], ['badRemaining', 0],
  ]) {
    const visits = [];
    autoBad.stopAutoBadLoop();
    friendActivity.resetForTest();
    const overrides = { visit: async friend => { visits.push(friend.gid); return { entered: true, online: true, bug: 1, weed: 0 }; } };
    overrides[key] = typeof value === 'boolean' ? () => value : () => value;
    stub(overrides);
    autoBad.startAutoBadLoop();
    friendActivity.recordActivity(303, fakeNow, 'at_home', 't');
    fakeNow += 2_000;
    await autoBad.runTickBody();
    assert.equal(visits.length, 0, `${key}=${value} 应挡住访问`);
    autoBad.stopAutoBadLoop();
  }
});

test('名单移除即清会话；证据到达时已移出名单则不建会话', async () => {
  const visits = [];
  const base = setup({
    visit: async friend => { visits.push(friend.gid); return { entered: true, online: true, bug: 1, weed: 0 }; },
  });
  await wake(303);
  assert.equal(autoBad.sessionCountForTests(), 1);
  deps.gids = () => [];
  await autoBad.runTickBody();
  assert.equal(autoBad.sessionCountForTests(), 0, '移出名单应清理会话');
  friendActivity.recordActivity(303, fakeNow, 'at_home', 't');
  fakeNow += 2_000;
  await autoBad.runTickBody();
  assert.equal(autoBad.sessionCountForTests(), 0, '已移出名单的证据不建会话');
  assert.equal(visits.length, 1);
  deps.gids = base.gids;
});

test('黑名单与自身排除仍生效', async () => {
  const visits = [];
  setup({
    gids: () => [1, 202, 303],
    myGid: () => 1,
    blacklist: () => new Set([202]),
    visit: async friend => { visits.push(friend.gid); return { entered: true, online: true, bug: 1, weed: 0 }; },
  });
  for (const gid of [1, 202, 303]) friendActivity.recordActivity(gid, fakeNow, 'at_home', 't');
  fakeNow += 2_000;
  await autoBad.runTickBody();
  assert.deepEqual(visits, [303], '自身与黑名单目标不访问');
});

test('抢收/自己收获让步：守卫期内零访问，恢复后可执行', async () => {
  const visits = [];
  const base = setup({
    visit: async friend => { visits.push(friend.gid); return { entered: true, online: true, bug: 1, weed: 0 }; },
  });
  friendActivity.recordActivity(303, fakeNow, 'at_home', 't');
  fakeNow += 2_000;
  deps.stealDue = () => true;
  await autoBad.runTickBody();
  assert.equal(visits.length, 0, '让步期间不得访问');
  deps.stealDue = base.stealDue;
  await autoBad.runTickBody();
  assert.equal(visits.length, 1, '恢复后应执行');
});

// ===== 会话语义：done / 复位 =====

test('沉默不重置 done：无任何观测长时间推进，done 保持', async () => {
  const visits = [];
  setup({
    visit: async friend => { visits.push(friend.gid); return { entered: true, online: true, bug: 1, weed: 0 }; },
  });
  await wake(303);
  assert.equal(autoBad.getSessionStateForTests(303).done, true);
  await runTicks(5, 30 * 60_000); // 2.5 小时沉默
  assert.equal(autoBad.getSessionStateForTests(303).done, true, '沉默不得当离线复位');
  assert.equal(visits.length, 1);
});

test('缺 at_home 字段的进门回包不当明确离场：done 保持', async () => {
  const visits = [];
  setup({
    visit: async friend => { visits.push(friend.gid); return { entered: true, online: true, bug: 1, weed: 0 }; },
  });
  await wake(303);
  // 既有访问路径带回包但缺 at_home 字段（protobuf 缺省）：不是明确 false
  friendActivity.noteEnterPresence(303, { basic: { last_online: 0 }, lands: [] }, fakeNow);
  await runTicks(2, 5_000);
  assert.equal(autoBad.getSessionStateForTests(303).done, true, '缺字段不得复位');
  assert.equal(visits.length, 1);
});

test('短暂离场（显式 at_home=false，<3 分钟）不复位 done', async () => {
  const visits = [];
  setup({
    visit: async friend => { visits.push(friend.gid); return { entered: true, online: true, bug: 1, weed: 0 }; },
  });
  await wake(303);
  friendActivity.noteEnterPresence(303, { at_home: false, basic: { last_online: 0 }, lands: [] }, fakeNow);
  friendActivity.noteEnterPresence(303, { at_home: false, basic: { last_online: 0 }, lands: [] }, fakeNow + 30_000);
  await runTicks(2, 5_000);
  assert.equal(autoBad.getSessionStateForTests(303).done, true, '3 分钟内短暂离场不得复位');
});

test('远古 last_online 不复位刚成功的会话：done 保持', async () => {
  setup({
    visit: async () => ({ entered: true, online: true, bug: 1, weed: 0 }),
  });
  await wake(303);
  const doneAt = fakeNow;
  friendActivity.noteEnterPresence(303, {
    at_home: false,
    basic: { last_online: Math.floor((doneAt - 3_600_000) / 1000) }, // 1 小时前
    lands: [],
  }, fakeNow);
  await runTicks(2, 5_000);
  assert.equal(autoBad.getSessionStateForTests(303).done, true,
    '远古 last_online 不得让刚完成的会话复位');
});

test('明确离场（服务端确证 ≥3 分钟且晚于 done）后新在线事件可重置并再执行', async () => {
  const visits = [];
  setup({
    visit: async friend => {
      visits.push(friend.gid);
      return { entered: true, online: true, bug: 1, weed: 0 };
    },
  });
  await wake(303);
  assert.equal(autoBad.getSessionStateForTests(303).done, true);
  const doneAt = fakeNow;
  fakeNow += 10 * 60_000; // 10 分钟后既有访问观察到明确离场
  friendActivity.noteEnterPresence(303, {
    at_home: false,
    basic: { last_online: Math.floor((doneAt + 4 * 60_000) / 1000) }, // done 后 4 分钟离线
    lands: [],
  }, fakeNow);
  assert.equal(autoBad.getSessionStateForTests(303).done, false, '确证离线应复位会话');
  // 好友再上线（新的在线事件）：重新执行一次
  await wake(303, 'presence_online');
  assert.equal(visits.length, 2, '复位后新在线事件应再执行一次');
  assert.equal(autoBad.getSessionStateForTests(303).done, true);
});

test('单次显式离场 + 长时间沉默：done 保持（沉默不是持续离线的证据）', async () => {
  const visits = [];
  setup({
    visit: async friend => { visits.push(friend.gid); return { entered: true, online: true, bug: 1, weed: 0 }; },
  });
  await wake(303);
  assert.equal(autoBad.getSessionStateForTests(303).done, true);
  friendActivity.noteEnterPresence(303, { at_home: false, basic: { last_online: 0 }, lands: [] }, fakeNow);
  await runTicks(5, 10 * 60_000); // 50 分钟沉默，无任何观测
  assert.equal(autoBad.getSessionStateForTests(303).done, true, '单次 false + 沉默不得复位');
  assert.equal(visits.length, 1);
});

test('两次显式离场观测跨度 ≥3 分钟才复位；在线证据清首见重算；复位后新在线事件再执行', async () => {
  const visits = [];
  setup({
    visit: async friend => { visits.push(friend.gid); return { entered: true, online: true, bug: 1, weed: 0 }; },
  });
  await wake(303);
  assert.equal(autoBad.getSessionStateForTests(303).done, true);
  // 第一次显式 false：记首见，不复位
  friendActivity.noteEnterPresence(303, { at_home: false, basic: { last_online: 0 }, lands: [] }, fakeNow);
  fakeNow += 60_000;
  friendActivity.noteEnterPresence(303, { at_home: false, basic: { last_online: 0 }, lands: [] }, fakeNow);
  await autoBad.runTickBody();
  assert.equal(autoBad.getSessionStateForTests(303).done, true, '跨度 1 分钟不得复位');
  // 中途在线证据：清掉首见时刻，重新计时
  friendActivity.recordActivity(303, fakeNow, 'at_home', 't');
  fakeNow += 60_000;
  friendActivity.noteEnterPresence(303, { at_home: false, basic: { last_online: 0 }, lands: [] }, fakeNow);
  fakeNow += autoBad.OFFLINE_RESUME_MS + 10_000;
  friendActivity.noteEnterPresence(303, { at_home: false, basic: { last_online: 0 }, lands: [] }, fakeNow);
  await autoBad.runTickBody();
  assert.equal(autoBad.getSessionStateForTests(303).done, false, '跨度 ≥3 分钟的两次显式 false 应复位');
  // 复位后新在线事件：再执行一次
  await wake(303, 'presence_online');
  assert.equal(visits.length, 2, '复位后新在线事件应再执行');
  assert.equal(autoBad.getSessionStateForTests(303).done, true);
});

// ===== 退避与失败 =====

test('进门失败不消耗机会且有界退避：60s 起指数、10min 封顶、证据不穿透退避', async () => {
  let attempts = 0;
  setup({
    visit: async () => { attempts += 1; return { entered: false, online: false, reason: 'enter_failed' }; },
  });
  await wake(303);
  assert.equal(attempts, 1);
  assert.equal(autoBad.getSessionStateForTests(303).done, false);
  const waits = [];
  for (let i = 0; i < 5; i++) {
    fakeNow = autoBad.getSessionStateForTests(303).nextAt + 1;
    friendActivity.recordActivity(303, fakeNow, 'at_home', 't'); // 退避期内新证据
    await autoBad.runTickBody();
    fakeNow += 10_000;
    waits.push(autoBad.getSessionStateForTests(303).nextAt - fakeNow);
  }
  assert.equal(attempts, 6);
  assert.ok(waits.every(w => w >= autoBad.BACKOFF_BASE_MS - 10_000), `退避下界（实际 ${waits}）`);
  assert.ok(waits.every(w => w <= autoBad.BACKOFF_MAX_MS), `退避封顶（实际 ${waits}）`);
});

test('在线但零执行：退避计满，退避到期后恢复执行', async () => {
  let attempts = 0;
  setup({
    visit: async () => { attempts += 1; return { entered: true, online: true, bug: 0, weed: 0 }; },
  });
  await wake(303);
  const deadline = autoBad.getSessionStateForTests(303).retryNotBefore;
  assert.ok(deadline > fakeNow, '零成功应有退避 deadline');
  for (let i = 0; i < 3; i++) {
    fakeNow += 5_000;
    friendActivity.recordActivity(303, fakeNow, 'at_home', 't');
    await autoBad.runTickBody();
  }
  assert.equal(attempts, 1, '退避期内证据与 tick 都不得重试');
  assert.ok(autoBad.getSessionStateForTests(303).nextAt >= deadline);
  fakeNow = deadline + 3_000;
  friendActivity.recordActivity(303, fakeNow, 'at_home', 't');
  await autoBad.runTickBody();
  assert.equal(attempts, 2, '退避到期且有新鲜证据后应恢复执行');
});

// ===== 串行锁 / 在途票据 / 启停互斥 =====

test('真实串行锁：证据唤醒不另起并发进门，跨 stop/start 并发 ≤1，旧代迟到结果作废', async () => {
  let active = 0;
  let maxActive = 0;
  let resolveVisit = null;
  let firstVisit = true;
  setup({
    now: () => Date.now(),
    // 首次进门挂起（测试旧代在途）；后续进门立即 settle，防新代派发死锁
    visit: () => new Promise(resolve => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      if (firstVisit) {
        firstVisit = false;
        resolveVisit = () => {
          active -= 1;
          resolve({ entered: true, online: true, bug: 2, weed: 0 });
        };
      } else {
        active -= 1;
        resolve({ entered: true, online: true, bug: 0, weed: 0 });
      }
    }),
  });
  friendActivity.recordActivity(303, Date.now(), 'at_home', 't');
  await waitFor(() => resolveVisit !== null, 6_000, '首拍应开始进门');
  // 进门在途：当前 Enter 的 noteEnterPresence 同步触发的短定时器不得另起并发体
  friendActivity.recordActivity(303, Date.now(), 'lands_push', 't');
  await sleep(700);
  assert.equal(maxActive, 1, '在途 Enter 未 settle 前不得另起并发进门');
  assert.equal(autoBad.isAutoBadRunning(), true);
  // stop 不假装旧网络完成；start 新代后调度体在串行锁后排队
  autoBad.stopAutoBadLoop();
  assert.equal(autoBad.isAutoBadRunning(), true, 'stop 后旧代在途仍应如实报告运行中');
  autoBad.startAutoBadLoop();
  const queued = autoBad.runTickBody();
  friendActivity.recordActivity(303, Date.now(), 'at_home', 't');
  await sleep(300);
  assert.equal(maxActive, 1, '跨 stop/start 并发进门仍 ≤1');
  resolveVisit(); // 旧代 settle：迟到成功结果被代际栅栏拦下
  await queued;
  assert.equal(autoBad.getSessionStateForTests(303).done, false,
    '旧代迟到结果不得写入新会话状态');
  autoBad.stopAutoBadLoop();
});

test('在途票据计数：排队即占票据，全 settle 才 false（含 stop/start 不伪造空闲）', async () => {
  let resolveVisit = null;
  setup({
    visit: () => new Promise(resolve => {
      resolveVisit = () => resolve({ entered: true, online: true, bug: 1, weed: 0 });
    }),
  });
  friendActivity.recordActivity(303, fakeNow, 'at_home', 't');
  fakeNow += 2_000;
  const a = autoBad.runTickBody(); // 排队即占票据
  assert.equal(autoBad.isAutoBadRunning(), true, '测试入口在途也不得误报空闲');
  try {
    await sleep(50);
    assert.ok(resolveVisit, '应已开始进门');
    autoBad.stopAutoBadLoop();
    assert.equal(autoBad.isAutoBadRunning(), true, 'stop 不得伪造空闲');
    autoBad.startAutoBadLoop();
    assert.equal(autoBad.isAutoBadRunning(), true, 'start 后旧体在途仍不空闲');
    resolveVisit();
    await a;
    assert.equal(autoBad.isAutoBadRunning(), false, 'pending 全 settle 才空闲');
  } finally {
    if (resolveVisit) resolveVisit();
    await a.catch(() => { });
  }
});

// ===== 部分成功 =====

test('部分成功+暂停中止：已放成的虫不丢、会话完成、恢复后不重放', async () => {
  friendActivity.resetForTest();
  const puts = { bug: 0, weed: 0 };
  const base = setup({
    visit: (friend, tally, myGid, opts) => visitFriendForAutoBad(friend, tally, myGid, {
      ...opts,
      impl: {
        enter: async () => ({ at_home: true, basic: { last_online: 0 }, lands: [{ id: 1 }, { id: 2 }] }),
        leave: async () => { },
        analyze: () => ({ canPutBug: [11], canPutWeed: [21] }),
        place: {
          badRemaining: () => 50,
          remainingFor: () => 50,
          checkCanOperate: async () => ({ canOperate: true }),
          // 虫放成的瞬间全局暂停翻转 → 草必须在 put 前被 guard 拦下
          putInsects: async (gid, targets) => {
            puts.bug += targets.length;
            deps.paused = () => true;
            return { ok: targets.length };
          },
          putWeeds: async () => { puts.weed += 1; return { ok: 1 }; },
        },
      },
    }),
  });
  friendActivity.recordActivity(303, fakeNow, 'at_home', 't');
  fakeNow += 2_000;
  await autoBad.runTickBody();
  assert.equal(puts.bug, 1, '虫应放成');
  assert.equal(puts.weed, 0, '暂停翻转后草零写');
  const s = autoBad.getSessionStateForTests(303);
  assert.equal(s.done, true, '部分成功（虫 1 草 0）也会话完成，不丢成功');
  // 恢复 + 长时间推进 + 持续在线证据：不得重放已成功的虫
  deps.paused = base.paused;
  friendActivity.recordActivity(303, fakeNow, 'at_home', 't');
  fakeNow += 2_000;
  await runTicks(2, 5_000);
  assert.equal(puts.bug, 1, '恢复后不得重放虫');
  assert.equal(puts.weed, 0);
});

// ===== 昵称 =====

test('运行时昵称：有缓存用昵称，缺失回退 GID，改名即时更新，不为补名增请求', async () => {
  friendActivity.resetForTest();
  const seen = [];
  setup({
    gids: () => [303, 304],
    visit: async friend => { seen.push({ gid: friend.gid, name: friend.name }); return { entered: true, online: true, bug: 1, weed: 0 }; },
  });
  friendActivity.noteFriendName(303, '合成昵称甲');
  await wake(303); // 有昵称
  await wake(304); // 无昵称 → GID 回退
  friendActivity.noteFriendName(303, '合成昵称乙'); // 改名
  autoBad.stopAutoBadLoop();
  autoBad.startAutoBadLoop();
  friendActivity.recordActivity(304, fakeNow, 'at_home', 't');
  fakeNow += 2_000;
  // 304 已 done，不会再访；改名验证改走 303：先复位再触发
  friendActivity.noteEnterPresence(303, { at_home: false, basic: { last_online: Math.floor(fakeNow / 1000) - 240 } }, fakeNow);
  const s = autoBad.getSessionStateForTests(303);
  assert.equal(s.done, false, '服务端确证离线应复位 303');
  await wake(303, 'presence_online');
  const names303 = seen.filter(v => v.gid === 303).map(v => v.name);
  assert.deepEqual(names303, ['合成昵称甲', '合成昵称乙'], '昵称即时更新');
  assert.equal(seen.find(v => v.gid === 304).name, 'GID:304', '缺失回退 GID');
  // 不为补名增请求：每次证据至多一次 visit
  assert.equal(seen.length, 3, '昵称解析零额外请求');
});

test('friend_activity_evidence 文案：用运行时昵称，无 [重点] 前缀，未知回退 GID', () => {
  friendActivity.resetForTest();
  const utils = require('../src/utils/utils');
  const messages = [];
  utils.setLogHook((_tag, msg, _isWarn, meta) => {
    if (meta && meta.event === 'friend_activity_evidence') messages.push({ msg, meta });
  });
  try {
    friendActivity.noteFriendName(501, '合成好友丙');
    friendActivity.recordActivity(501, Date.now(), 'at_home', 't');
    friendActivity.recordActivity(502, Date.now(), 'lands_push', 't');
    assert.equal(messages.length, 2);
    assert.ok(messages[0].msg.includes('合成好友丙'), '有昵称用昵称');
    assert.ok(!messages[0].msg.includes('[重点]'), '不得有 [重点] 误导前缀');
    assert.ok(messages[1].msg.includes('GID:502'), '未知回退 GID');
    assert.ok(!messages[1].msg.includes('[重点]'));
    // 字段白名单：无原始包/凭据
    const allowed = new Set(['module', 'event', 'friendGid', 'source', 'at', 'tag']);
    for (const m of messages) {
      for (const key of Object.keys(m.meta)) assert.ok(allowed.has(key), `白名单外字段 ${key}`);
    }
  } finally {
    utils.setLogHook(null);
    friendActivity.resetForTest();
  }
});

test('占位昵称解析：入参 name=GID 占位时优先刚取得的真昵称（真实 visit 回包端到端）', async () => {
  friendActivity.resetForTest();
  // 真实 visitFriendForAutoBad：进门前入参 name 是 GID 占位，回包 basic.name
  // 取得真昵称后，上线提示的展示名应显示真昵称而非占位
  await visitFriendForAutoBad({ gid: 801, name: 'GID:801' }, { putBug: 0, putWeed: 0 }, 1, {
    impl: {
      enter: async () => ({ at_home: true, basic: { name: '合成真名戊', last_online: 0 }, lands: [] }),
      leave: async () => { },
      analyze: () => ({ canPutBug: [], canPutWeed: [] }),
    },
  });
  assert.equal(friendActivity.getCachedFriendName(801), '合成真名戊', '回包昵称进运行时名册');
  assert.equal(friendActivity.resolveFriendDisplayName(801, 'GID:801'), '合成真名戊',
    '占位入参必须让位给刚取得的真昵称');
  assert.equal(friendActivity.resolveFriendDisplayName(801, ''), '合成真名戊', '空入参回退昵称');
  assert.equal(friendActivity.resolveFriendDisplayName(802, 'GID:802'), 'GID:802', '无昵称回退占位/GID');
  assert.equal(friendActivity.resolveFriendDisplayName(802, '合成入参己'), '合成入参己', '真入参优先');
  friendActivity.resetForTest();
});

test('noteEnterPresence 喂昵称：BasicInfo.name 进运行时名册并供上线提示回退', () => {
  friendActivity.resetForTest();
  friendActivity.noteEnterPresence(601, { at_home: true, basic: { name: '合成进门丁', last_online: 0 }, lands: [] });
  assert.equal(friendActivity.getCachedFriendName(601), '合成进门丁');
  assert.equal(friendActivity.getCachedFriendName(602), '', '未知好友空串回退');
  friendActivity.resetForTest();
});

test('onPresenceObservation：分发在场观测，缺 at_home 字段 atHomeDecoded=false', () => {
  friendActivity.resetForTest();
  const obs = [];
  const un = friendActivity.onPresenceObservation((gid, at, payload) => obs.push({ gid, at, ...payload }));
  try {
    const t = Date.now();
    friendActivity.noteEnterPresence(701, { at_home: true, basic: { last_online: 0 }, lands: [] }, t);
    friendActivity.noteEnterPresence(701, { basic: { last_online: 0 }, lands: [] }, t + 1_000);
    const offlineSec = Math.floor(t / 1000) - 42; // 真实 epoch 秒级 last_online
    friendActivity.noteEnterPresence(701, { at_home: false, basic: { last_online: offlineSec }, lands: [] }, t + 2_000);
    assert.equal(obs.length, 3);
    assert.deepEqual(obs[0], { gid: 701, at: t, atHomeDecoded: true, atHome: true, lastOnlineMs: 0 });
    assert.equal(obs[1].atHomeDecoded, false, '缺字段未解码');
    assert.equal(obs[2].atHomeDecoded, true);
    assert.equal(obs[2].atHome, false);
    assert.equal(obs[2].lastOnlineMs, offlineSec * 1000, '秒级 last_online 转 ms 供离线确证');
  } finally {
    un();
    friendActivity.resetForTest();
  }
});

// ===== placeAutoBadItems：虫草独立、零 cap 零请求 =====

const analysis = { canPutBug: [11, 12, 13], canPutWeed: [21, 22, 23] };

function makeImpl({ bugDenied = false, bugResult = { ok: 2 }, weedResult = { ok: 1 }, bugThrows = false } = {}) {
  const calls = { check: [], putBug: 0, putWeed: 0 };
  return {
    calls,
    badRemaining: () => 50,
    remainingFor: () => 50,
    checkCanOperate: async (gid, opId) => { calls.check.push(opId); return { canOperate: opId !== 10005 || !bugDenied }; },
    putInsects: async () => { calls.putBug += 1; if (bugThrows) throw new Error('bug down'); return bugResult; },
    putWeeds: async () => { calls.putWeed += 1; return weedResult; },
  };
}

test('总额度为 0：零请求，固定原因 cap_zero', async () => {
  const impl = makeImpl();
  impl.badRemaining = () => 0;
  const tally = { putBug: 0, putWeed: 0 };
  const result = await placeAutoBadItems(303, analysis, tally, impl);
  assert.equal(result.bug + result.weed, 0);
  assert.deepEqual(result.reasons, ['cap_zero']);
  assert.equal(impl.calls.check.length + impl.calls.putBug + impl.calls.putWeed, 0, '零请求');
});

test('单项额度为 0：该项零请求零 slice，另一项照常', async () => {
  const impl = makeImpl();
  impl.remainingFor = (opId) => (opId === 10005 ? 0 : 50); // 虫额度 0
  const tally = { putBug: 0, putWeed: 0 };
  const result = await placeAutoBadItems(303, analysis, tally, impl);
  assert.equal(result.weed, 1, '草不受虫额度影响');
  assert.equal(result.bug, 0);
  assert.ok(result.reasons.includes('bug_cap_zero'));
  assert.equal(impl.calls.putBug, 0, '虫零请求');
  assert.equal(impl.calls.putWeed, 1);
});

test('虫被拒/抛错不阻断草：独立结果与原因码', async () => {
  for (const variant of [{ bugDenied: true }, { bugThrows: true }]) {
    const impl = makeImpl(variant);
    const tally = { putBug: 0, putWeed: 0 };
    const result = await placeAutoBadItems(303, analysis, tally, impl);
    assert.equal(result.weed, 1, `草应成功（${JSON.stringify(variant)}）`);
    assert.equal(tally.putWeed, 1);
    assert.equal(result.bug, 0);
    assert.ok(result.reasons.some(r => r.startsWith('bug_')), `虫失败应有原因码（${result.reasons}）`);
  }
});

test('无地块：零请求，固定原因', async () => {
  const impl = makeImpl();
  const tally = { putBug: 0, putWeed: 0 };
  const result = await placeAutoBadItems(303, { canPutBug: [], canPutWeed: [] }, tally, impl);
  assert.deepEqual(result.reasons.sort(), ['no_bug_plots', 'no_weed_plots']);
  assert.equal(impl.calls.check.length + impl.calls.putBug + impl.calls.putWeed, 0);
});

test('虫远程检查抛错：固定原因码、不阻断草', async () => {
  const impl = makeImpl();
  impl.checkCanOperate = async (gid, opId) => {
    if (opId === 10005) throw new Error('bug check down');
    return { canOperate: true };
  };
  const tally = { putBug: 0, putWeed: 0 };
  const result = await placeAutoBadItems(303, analysis, tally, impl);
  assert.equal(result.weed, 1, '虫检查抛错不得阻断草');
  assert.ok(result.reasons.includes('bug_error'), `固定原因码（实际 ${result.reasons}）`);
  assert.equal(result.bug, 0);
});

test('进入成功后放置异常也保证 Leave（finally）', async () => {
  friendActivity.resetForTest();
  let left = 0;
  const result = await visitFriendForAutoBad({ gid: 303, name: 'x' }, { putBug: 0, putWeed: 0 }, 1, {
    impl: {
      enter: async () => ({ at_home: true, basic: { last_online: 0 }, lands: [{ id: 1 }] }),
      leave: async () => { left += 1; },
      analyze: () => ({ canPutBug: [11], canPutWeed: [] }),
      place: {
        badRemaining: () => 50,
        remainingFor: () => 50,
        checkCanOperate: async () => { throw new Error('boom'); },
        putInsects: async () => ({ ok: 1 }),
        putWeeds: async () => ({ ok: 1 }),
      },
    },
  });
  assert.equal(left, 1, '任何放置异常后必须 Leave 一次');
  assert.equal(result.entered, true);
  assert.ok((result.reason || '').includes('bug_error'));
  friendActivity.resetForTest();
});

test('远程 check 完成后、put 前重查 guard：等待期间暂停 → 零写', async () => {
  let guardOk = true;
  let releaseBugCheck;
  const impl = makeImpl();
  impl.checkCanOperate = (gid, opId) => (opId === 10005
    ? new Promise(resolve => { releaseBugCheck = () => resolve({ canOperate: true }); })
    : async () => ({ canOperate: true }));
  impl.putInsects = async () => { throw new Error('must not put bug'); };
  const tally = { putBug: 0, putWeed: 0 };
  const pending = placeAutoBadItems(303, analysis, tally, { ...impl, guard: () => guardOk });
  await sleep(50); // 虫的远程 check 挂起中
  guardOk = false; // 等待期间守卫翻转（暂停/stop/移出名单）
  releaseBugCheck();
  const result = await pending;
  assert.equal(result.bug, 0, 'check 后 put 前守卫翻转必须零写');
  assert.ok(result.reasons.includes('bug_aborted'));
  assert.equal(result.aborted, true);
  assert.equal(impl.calls.putWeed, 0, '守卫翻转后草也零写');
});

// ===== noteEnterPresence：证据生产一致性 =====

test('陈旧/缺省 last_online 不覆盖同次 at_home 证据；真实离线才覆盖', () => {
  friendActivity.resetForTest();
  const gid = 303;
  const t0 = Date.now();
  const first = friendActivity.noteEnterPresence(gid, { at_home: true, lands: [] }, t0);
  assert.equal(first.atHome, true);
  assert.equal(first.onlineEdge, true, '首次 at_home 是上升沿');
  assert.equal(friendActivity.isFriendAtHomeRecently(gid, t0 + 1_000), true);
  assert.equal(friendActivity.isFriendOnlineRecently(gid, t0 + 1_000), true);

  // 缺省 last_online=0（字段不下发）：不得当离线时刻，也不得当在线
  friendActivity.noteEnterPresence(gid, { at_home: false, basic: { last_online: 0 }, lands: [] }, t0 + 2_000);
  assert.equal(friendActivity.isFriendAtHomeRecently(gid, t0 + 3_000), true, 'at_home 证据不得被缺省 0 覆盖');

  // 陈旧历史 last_online（1 小时前）：不覆盖更新的 at_home
  friendActivity.noteEnterPresence(gid, { at_home: false, basic: { last_online: Math.floor(t0 / 1000) - 3600 }, lands: [] }, t0 + 4_000);
  assert.equal(friendActivity.isFriendAtHomeRecently(gid, t0 + 5_000), true, '陈旧 last_online 不得覆盖 at_home');

  // 真实离线（刚刚）：覆盖为离线
  friendActivity.noteEnterPresence(gid, { at_home: false, basic: { last_online: Math.floor(t0 / 1000) + 6 }, lands: [] }, t0 + 7_000);
  assert.equal(friendActivity.isFriendAtHomeRecently(gid, t0 + 8_000), false, '真实离线应覆盖');
});

test('noteEnterPresence 时间单位与返回值：秒级 last_online → 墙钟 ms', () => {
  friendActivity.resetForTest();
  const t0 = Date.now();
  const sec = Math.floor(t0 / 1000) - 60;
  const r = friendActivity.noteEnterPresence(701, { at_home: false, basic: { last_online: sec }, lands: [] }, t0);
  assert.equal(r.atHome, false);
  assert.equal(r.lastOnlineMs, sec * 1000, '秒级 epoch 应转 ms');
  const r2 = friendActivity.noteEnterPresence(701, { at_home: false, basic: { last_online: t0 - 30_000 }, lands: [] }, t0 + 1_000);
  assert.equal(r2.lastOnlineMs, t0 - 30_000, 'ms 级应原样返回');
  const r3 = friendActivity.noteEnterPresence(701, { at_home: true, basic: { last_online: 123 }, lands: [] }, t0 + 2_000);
  assert.equal(r3.atHome, true);
  assert.equal(r3.lastOnlineMs, 0);
  friendActivity.resetForTest();
});

test('在线层独立：非在线活跃源不覆盖在线信号；同毫秒高优先级源胜出', () => {
  friendActivity.resetForTest();
  const t = Date.now();
  const notified = [];
  const un = friendActivity.onOnlineEvidence((gid, at, source) => notified.push(source));
  try {
    friendActivity.recordActivity(801, t, 'at_home', 'x');
    friendActivity.recordActivity(801, t + 1_000, 'summary_drift', 'y');
    assert.equal(friendActivity.isFriendOnlineRecently(801, t + 5_000), true,
      '10s 窗内 at_home 在线信号不得被 summary_drift 覆盖');
    friendActivity.recordActivity(802, t, 'presence_online', 'x');
    assert.equal(notified[notified.length - 1], 'presence_online');
    friendActivity.recordActivity(802, t, 'at_home', 'x');
    assert.equal(notified[notified.length - 1], 'at_home', '同毫秒高优先级在线源应胜出');
  } finally {
    un();
    friendActivity.resetForTest();
  }
});

// require-cache 替换 friend-api，让 visitFriend/visitFriendForSteal 的进门
// 走替身——验证"所有进门路径（含空土地）先记录 presence 再早退"的真实行为
function withFriendApiStub(stubApi, fn) {
  const apiPath = require.resolve('../src/services/friend-api');
  const visitPath = require.resolve('../src/services/friend-visit');
  const origApi = require.cache[apiPath];
  const origVisit = require.cache[visitPath];
  require.cache[apiPath] = { id: apiPath, filename: apiPath, loaded: true, exports: stubApi };
  delete require.cache[visitPath];
  try {
    return fn(require(visitPath));
  } finally {
    if (origVisit) require.cache[visitPath] = origVisit;
    else delete require.cache[visitPath];
    if (origApi) require.cache[apiPath] = origApi;
    else delete require.cache[apiPath];
  }
}

test('所有进门路径（含空土地）先记录 presence 再早退', async () => {
  friendActivity.resetForTest();
  const tally = () => ({ steal: 0, water: 0, weed: 0, bug: 0, putBug: 0, putWeed: 0 });
  const api = {
    enterFriendFarm: async _gid => ({ at_home: true, basic: { last_online: 0 }, lands: [] }),
    leaveFriendFarm: async () => { },
    checkCanOperateRemote: async () => ({ canOperate: true }),
    handleFriendEnterError: () => ({ handled: false }),
  };
  await withFriendApiStub(api, async visit => {
    const r1 = await visit.visitFriend({ gid: 601, name: 'A' }, tally(), 1, '');
    assert.equal(r1.entered, true);
    assert.equal(friendActivity.isFriendOnlineRecently(601), true,
      'visitFriend 空土地早退前必须有 at_home 在线证据');
    const r2 = await visit.visitFriendForSteal({ gid: 602, name: 'B' }, tally(), 1, '');
    assert.equal(r2.entered, true);
    assert.equal(friendActivity.isFriendOnlineRecently(602), true,
      'visitFriendForSteal 空土地早退前必须有在线证据');
  });
  friendActivity.resetForTest();
});

test('在线捣乱进门 at_home 解码四态：缺字段/显式false/显式true/仅其它在线证据', async () => {
  const mk = (enterReply) => {
    let left = 0;
    const promise = visitFriendForAutoBad({ gid: 701, name: 'x' }, { putBug: 0, putWeed: 0 }, 1, {
      impl: {
        enter: async () => enterReply,
        leave: async () => { left += 1; },
        analyze: () => ({ canPutBug: [], canPutWeed: [] }),
      },
    });
    return promise.then(r => ({ ...r, left }));
  };
  try {
    // 1) 缺 at_home 字段：未解码，atHome=null、online 仅看其它证据（无→false）
    friendActivity.resetForTest();
    let r = await mk({ basic: { last_online: 0 }, lands: [{ id: 1 }] });
    assert.equal(r.entered, true);
    assert.equal(r.atHomeDecoded, false, '缺 at_home 字段：未解码');
    assert.equal(r.atHome, null, '缺字段不下结论');
    assert.equal(r.online, false, '无其它在线证据时不判在线');
    assert.equal(r.left, 1);

    // 2) 显式 at_home=false：已解码且本次未取得在场证据（不声称离线）
    friendActivity.resetForTest();
    r = await mk({ at_home: false, basic: { last_online: 0 }, lands: [{ id: 1 }] });
    assert.equal(r.atHomeDecoded, true);
    assert.equal(r.atHome, false, '显式 false 是解码出的在场位');
    assert.equal(r.online, false, '本次未取得在场证据');

    // 3) 显式 at_home=true：解码且在线
    friendActivity.resetForTest();
    r = await mk({ at_home: true, basic: { last_online: 0 }, lands: [{ id: 1 }] });
    assert.equal(r.atHomeDecoded, true);
    assert.equal(r.atHome, true);
    assert.equal(r.online, true, 'at_home=true 即在线');

    // 4) 缺 at_home 字段但 10s 窗口内已有其它已证实在线证据
    friendActivity.resetForTest();
    friendActivity.recordActivity(701, Date.now(), 'presence_online', 'test');
    r = await mk({ basic: { last_online: 0 }, lands: [{ id: 1 }] });
    assert.equal(r.atHomeDecoded, false);
    assert.equal(r.atHome, null, '合并在线证据不得伪称本次解码在场位');
    assert.equal(r.online, true, '其它在线证据仍构成在线');
  } finally {
    friendActivity.resetForTest();
  }
});
