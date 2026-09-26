const { test, mock } = require('node:test');
const assert = require('node:assert/strict');

// 排程统一入口（schedulePoll）行为验收：真实生产调度体（startAutoBadLoop
// 驱动的 tick/start/证据唤醒定时器）+ 可控假 clock（deps.now）与
// node:test mock timers（控制生产 scheduler 的 setTimeout）+ deferred visit。
// 覆盖并发阻断：A 在途失败退避的 tick finally 不得吞掉 B 已排的更早证据
// 唤醒；连续 <300ms 事件不无限推迟；stop 清定时器、旧代不回填。
// 全部内存态，无真实网络与游戏请求。

const autoBad = require('../src/services/friend-auto-bad');
const friendActivity = require('../src/services/friend-activity');
const { getSchedulerRegistrySnapshot } = require('../src/services/scheduler');

const deps = autoBad.__depsForTests;
const A = 101;
const B = 102;

let fakeNow = Date.now();
const flush = () => new Promise(resolve => setImmediate(resolve));

/** 推进假时钟并同时推进 mock 定时器，再冲刷微任务 */
async function advance(ms) {
  fakeNow += ms;
  mock.timers.tick(ms);
  await flush();
  await flush();
}

/** deferred visit：记录每次派发的 gid 与时刻，手动 resolve 模拟回包 */
function makeVisitDeferred() {
  const calls = [];
  const visit = friend => new Promise(resolve => {
    calls.push({ gid: friend.gid, at: fakeNow, resolve });
  });
  return { calls, visit };
}

function setup(overrides = {}) {
  autoBad.stopAutoBadLoop();
  friendActivity.resetForTest();
  fakeNow = Date.now();
  const originals = {};
  const base = {
    now: () => fakeNow,
    gids: () => [A, B],
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
    friendName: gid => `GID:${gid}`,
    visit: async () => ({ entered: true, online: true, bug: 0, weed: 0 }),
    delay: async () => { },
    ...overrides,
  };
  for (const [key, value] of Object.entries(base)) {
    originals[key] = deps[key];
    deps[key] = value;
  }
  return () => {
    for (const [key, value] of Object.entries(originals)) deps[key] = value;
  };
}

/** 每个测试的公共骨架：mock timers + deps 替身 + 结束还原 */
function withVm(overrides, fn) {
  return async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const restore = setup(overrides);
    autoBad.startAutoBadLoop();
    try {
      await fn();
    } finally {
      autoBad.stopAutoBadLoop();
      restore();
      mock.timers.reset();
    }
  };
}

test('A 在途失败退避的 tick finally 不得吞掉 B 的更早证据唤醒', withVm({}, async () => {
  const { calls, visit } = makeVisitDeferred();
  deps.visit = visit;

  // A 收证据 → 唤醒后派发 A（挂起不返回）
  friendActivity.recordActivity(A, fakeNow, 'at_home', 't');
  await advance(3_000);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].gid, A);
  const dispatchAt = fakeNow;

  // A 在途期间 B 收到新证据（排 +300ms 唤醒），随后 A 失败/零写进退避
  friendActivity.recordActivity(B, fakeNow, 'at_home', 't');
  await advance(100);
  calls[0].resolve({ entered: true, online: true, bug: 0, weed: 0 });
  await advance(3_500); // 远小于 30s 空档：B 必须在此窗口内被派发
  assert.ok(calls.length >= 2, `B 未被及时派发（calls=${calls.length}）`);
  assert.equal(calls[1].gid, B);
  assert.ok(fakeNow - dispatchAt < 10_000, 'B 的派发被推迟到了 30s 空档之后');
  calls[1].resolve({ entered: true, online: true, bug: 1, weed: 0 });
  await advance(2_000);
}));

test('空闲 30s 空档内新证据事件仍能唤醒并及时派发', withVm({}, async () => {
  const { calls, visit } = makeVisitDeferred();
  deps.visit = visit;

  await advance(35_000); // 无会话：纯空转，零请求
  assert.equal(calls.length, 0);
  friendActivity.recordActivity(A, fakeNow, 'at_home', 't');
  await advance(3_000); // 唤醒 + 派发窗口（远小于 30s）
  assert.equal(calls.length, 1);
  assert.equal(calls[0].gid, A);
  calls[0].resolve({ entered: true, online: true, bug: 1, weed: 0 });
  await advance(2_000);
}));

test('连续 <300ms 事件不得互相推迟成无限延后', withVm({}, async () => {
  const { calls, visit } = makeVisitDeferred();
  deps.visit = visit;

  friendActivity.recordActivity(A, fakeNow, 'at_home', 't');
  const firstAt = fakeNow;
  for (let i = 0; i < 10; i++) {
    await advance(100);
    friendActivity.recordActivity(A, fakeNow, 'at_home', 't');
  }
  await advance(3_000); // 首个唤醒 +300ms 就应触发，事件流不得推迟它
  assert.ok(calls.length >= 1, '连续事件把唤醒推迟成了无限延后');
  assert.ok(fakeNow - firstAt < 5_000, '首个唤醒被事件流显著推迟');
  calls[0].resolve({ entered: true, online: true, bug: 1, weed: 0 });
  await advance(2_000);
}));

test('stop 清定时器：唤醒在途时停止后不再派发', withVm({}, async () => {
  const { calls, visit } = makeVisitDeferred();
  deps.visit = visit;

  friendActivity.recordActivity(A, fakeNow, 'at_home', 't'); // 已排 +300ms 唤醒
  autoBad.stopAutoBadLoop();
  await advance(60_000);
  assert.equal(calls.length, 0);
  const snap = getSchedulerRegistrySnapshot('friend-auto-bad');
  assert.equal(snap.schedulers[0].taskCount, 0, 'stop 后命名空间残留定时器');
}));

test('旧代在途 visit 迟到返回不回填状态/不重挂定时器', withVm({}, async () => {
  const { calls, visit } = makeVisitDeferred();
  deps.visit = visit;

  friendActivity.recordActivity(A, fakeNow, 'at_home', 't');
  await advance(3_000);
  assert.equal(calls.length, 1);

  autoBad.stopAutoBadLoop();
  autoBad.startAutoBadLoop(); // 新代：会话清空
  assert.equal(autoBad.sessionCountForTests(), 0);
  calls[0].resolve({ entered: true, online: true, bug: 2, weed: 0 }); // 旧代成功迟到
  await advance(35_000);
  assert.equal(calls.length, 1, '旧代结果触发了新派发');
  assert.equal(autoBad.sessionCountForTests(), 0, '旧代结果回填了会话状态');
}));
