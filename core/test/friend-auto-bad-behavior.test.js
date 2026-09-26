const { test } = require('node:test');
const assert = require('node:assert/strict');

// 在线自动捣乱重构（2026-09-26）行为验收：
// 全部为内存态/替身测试，无真实网络与游戏写请求。
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
    online: () => false,
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
  fakeNow = Date.now();
  return stub(overrides);
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
});

test('doHelp 关闭/帮助经验上限不牵连：显式名单目标仍执行且真实放成才 done', async () => {
  // 调度不读取 friend_help/friend_bad 开关与帮助经验状态（结构独立），
  // 行为上验证守卫全放行时执行并置 done
  const visits = [];
  setup({
    visit: async (friend, tally, myGid, opts) => {
      visits.push({ gid: friend.gid, opts: { ...opts } });
      return { entered: true, online: true, bug: 1, weed: 2 };
    },
  });
  await runTicks(2); // 第 1 拍编入+错开，第 2 拍执行
  assert.equal(visits.length, 1, '目标应被访问一次');
  assert.equal(visits[0].gid, 303);
  assert.equal(visits[0].opts.allowPlace, true);
  assert.equal(typeof visits[0].opts.guard, 'function', '调度必须传写动作守卫');
  const session = autoBad.getSessionStateForTests(303);
  assert.equal(session.done, true, '真实放成后才置 done');
});

test('无在线证据零捣乱：探测观察到不在场→不放置、不消耗、回到发现节奏', async () => {
  const visits = [];
  setup({
    visit: async (friend, tally, myGid, opts) => {
      visits.push({ opts: { ...opts } });
      return { entered: true, online: false, bug: 0, weed: 0, reason: 'not_online' };
    },
  });
  await runTicks(2);
  assert.equal(visits.length, 1);
  const session = autoBad.getSessionStateForTests(303);
  assert.equal(session.done, false);
  const wait = session.nextAt - fakeNow;
  assert.ok(wait >= 0 && wait <= autoBad.PROBE_MAX_MS,
    `发现节奏应在 10-15s（实际 ${wait}ms）`);
});

test('持续在线不重复：done 后再探测在线只续期探测，不再放', async () => {
  const visits = [];
  setup({
    visit: async (friend, tally, myGid, opts) => {
      visits.push({ opts: { ...opts } });
      return visits.length === 1
        ? { entered: true, online: true, bug: 1, weed: 0 }
        : { entered: true, online: true, bug: 0, weed: 0, reason: 'session_done' };
    },
  });
  await runTicks(2);
  assert.equal(autoBad.getSessionStateForTests(303).done, true);
  fakeNow += autoBad.DONE_PROBE_MAX_MS + 5_000; // 越过 done 放宽探测间隔
  await runTicks(1, 1_000);
  assert.equal(visits.length, 2, 'done 后仍探测（观察离线）');
  assert.equal(visits[1].opts.allowPlace, false, 'done 后不得再放置');
  assert.equal(autoBad.getSessionStateForTests(303).done, true, '持续在线 done 保持');
  const wait = autoBad.getSessionStateForTests(303).nextAt - fakeNow;
  assert.ok(wait >= autoBad.DONE_PROBE_MIN_MS - 2_000 && wait <= autoBad.DONE_PROBE_MAX_MS,
    `done 探测节奏 5-8min（实际 ${wait}ms）`);
});

test('离线后再上线可重置：服务端确证 ≥3 分钟且晚于完成时刻 → done 复位、重新执行', async () => {
  const visits = [];
  setup({
    visit: async () => {
      visits.push({});
      if (visits.length === 1) return { entered: true, online: true, bug: 1, weed: 0 };
      // 离线探测：服务端下发 4 分钟前的 last_online（离线发生在 done 之后）
      if (visits.length === 2) return { entered: true, online: false, bug: 0, weed: 0, offlineSinceMs: fakeNow - 4 * 60_000 };
      return { entered: true, online: true, bug: 1, weed: 0 };
    },
  });
  await runTicks(2);
  assert.equal(autoBad.getSessionStateForTests(303).done, true);
  const doneAt = fakeNow;
  fakeNow += autoBad.DONE_PROBE_MAX_MS + 5_000; // done 后 8min+ 才探测离线
  assert.ok(fakeNow - 4 * 60_000 > doneAt, '测试前提：离线时刻应晚于 done 时刻');
  await runTicks(1, 1_000); // 观察到确证长离线
  assert.equal(autoBad.getSessionStateForTests(303).done, false, '确证离线应复位会话');
  fakeNow += autoBad.PROBE_MAX_MS + 1_000; // 越过发现探测间隔，好友再上线
  await runTicks(1, 1_000);
  assert.equal(visits.length, 3, '再上线应重新执行');
  assert.equal(autoBad.getSessionStateForTests(303).done, true);
});

test('远古 last_online 不复位刚成功的会话：offlineSince 早于 done 时刻 → done 保持', async () => {
  const visits = [];
  setup({
    visit: async () => {
      visits.push({});
      if (visits.length === 1) return { entered: true, online: true, bug: 1, weed: 0 };
      // 服务端下发的 last_online 是 1 小时前的远古时刻（早于 done）
      return { entered: true, online: false, bug: 0, weed: 0, offlineSinceMs: fakeNow - 3_600_000 };
    },
  });
  await runTicks(2);
  assert.equal(autoBad.getSessionStateForTests(303).done, true);
  fakeNow += autoBad.DONE_PROBE_MAX_MS + 5_000;
  await runTicks(1, 1_000);
  assert.equal(autoBad.getSessionStateForTests(303).done, true,
    '远古 last_online 不得让刚完成的会话复位');
});

test('进门失败不消耗机会且有界退避：60s 起指数、10min 封顶、不热循环', async () => {
  let attempts = 0;
  setup({
    visit: async () => { attempts += 1; return { entered: false, online: false, reason: 'enter_failed' }; },
  });
  await runTicks(2);
  assert.equal(attempts, 1);
  assert.equal(autoBad.getSessionStateForTests(303).done, false);
  const waits = [];
  for (let i = 0; i < 5; i++) {
    fakeNow += autoBad.getSessionStateForTests(303).nextAt - fakeNow + 1;
    await autoBad.runTickBody();
    fakeNow += 10_000;
    waits.push(autoBad.getSessionStateForTests(303).nextAt - fakeNow);
  }
  // 单拍内只试一次（不热循环），退避有下界与封顶
  assert.equal(attempts, 6);
  assert.ok(waits.every(w => w >= autoBad.BACKOFF_BASE_MS - 10_000), `退避下界（实际 ${waits}）`);
  assert.ok(waits.every(w => w <= autoBad.BACKOFF_MAX_MS), `退避封顶（实际 ${waits}）`);
});

test('抢收/自己收获让步：守卫期内零访问、会话不动，恢复后可执行', async () => {
  const visits = [];
  const base = setup({
    visit: async () => { visits.push({}); return { entered: true, online: true, bug: 1, weed: 0 }; },
  });
  await runTicks(1);
  // 进入到期窗口但被收获让步挡住
  fakeNow += 10_000;
  deps.stealDue = () => true;
  await autoBad.runTickBody();
  assert.equal(visits.length, 0, '让步期间不得访问');
  assert.equal(autoBad.getSessionStateForTests(303).done, false, '让步不消耗机会');
  deps.stealDue = base.stealDue;
  await autoBad.runTickBody();
  assert.equal(visits.length, 1, '恢复后应执行');
});

test('每日额度耗尽：连探测进门都不发（零请求）', async () => {
  const visits = [];
  setup({
    badRemaining: () => 0,
    visit: async () => { visits.push({}); return { entered: true, online: true, bug: 0, weed: 0 }; },
  });
  await runTicks(3);
  assert.equal(visits.length, 0);
});

test('黑名单与自身排除仍生效', async () => {
  const visits = [];
  setup({
    gids: () => [1, 202, 303],
    myGid: () => 1,
    blacklist: () => new Set([202]),
    visit: async (friend) => { visits.push(friend.gid); return { entered: true, online: false }; },
  });
  await runTicks(2);
  assert.deepEqual(visits, [303]);
});

test('新鲜在线证据即刻拉近：不等发现探测到期', async () => {
  const visits = [];
  setup({
    visit: async (friend) => { visits.push(friend.gid); return { entered: true, online: true, bug: 1, weed: 0 }; },
  });
  await autoBad.runTickBody(); // 编入+错开（nextAt 在未来，不推进时钟）
  assert.ok(autoBad.getSessionStateForTests(303).nextAt > fakeNow, '错开排程应在未来');
  deps.online = () => true; // 外部路径产出 at_home/lands_push 证据
  await autoBad.runTickBody();
  const pulled = autoBad.getSessionStateForTests(303).nextAt - fakeNow;
  assert.ok(pulled <= 1_500, `证据命中应拉近到 ≤1.5s（实际 ${pulled}ms）`);
  fakeNow += 2_000;
  await autoBad.runTickBody();
  assert.deepEqual(visits, [303], '证据命中后应立即执行');
});

test('多目标分散调度：串行全访问，不漏', async () => {
  const visits = [];
  setup({
    gids: () => [303, 304, 305],
    visit: async (friend) => { visits.push(friend.gid); return { entered: true, online: false }; },
  });
  await runTicks(2, 10_000);
  assert.deepEqual(visits.sort(), [303, 304, 305]);
});

test('配置收缩与停止：移出名单即清会话，stop 清一切', async () => {
  const base = setup();
  await runTicks(1);
  assert.equal(autoBad.sessionCountForTests(), 1);
  deps.gids = () => [];
  await autoBad.runTickBody();
  assert.equal(autoBad.sessionCountForTests(), 0, '移出名单应清理会话');
  deps.gids = base.gids;
  await runTicks(1);
  assert.equal(autoBad.sessionCountForTests(), 1);
  autoBad.startAutoBadLoop();
  assert.equal(autoBad.isAutoBadLoopArmed(), true);
  autoBad.stopAutoBadLoop();
  assert.equal(autoBad.isAutoBadLoopArmed(), false);
  assert.equal(autoBad.sessionCountForTests(), 0);
});

test('全局暂停/免打扰/静默时段/巡查互斥守卫：零访问', async () => {
  for (const key of ['badPaused', 'paused', 'quietHours', 'checking', 'harvestDue']) {
    const visits = [];
    autoBad.stopAutoBadLoop();
    stub({ [key]: () => true, visit: async () => { visits.push({}); return { entered: true, online: true, bug: 1, weed: 0 }; } });
    await runTicks(2);
    assert.equal(visits.length, 0, `${key} 应挡住访问`);
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

// ===== 2026-09-26 终验收补充 =====

test('noteEnterPresence 时间单位与返回值：秒级 last_online → 墙钟 ms', () => {
  friendActivity.resetForTest();
  const t0 = Date.now();
  const sec = Math.floor(t0 / 1000) - 60;
  const r = friendActivity.noteEnterPresence(701, { at_home: false, basic: { last_online: sec }, lands: [] }, t0);
  assert.equal(r.atHome, false);
  assert.equal(r.lastOnlineMs, sec * 1000, '秒级 epoch 应转 ms');
  // ms 级时间戳直传
  const r2 = friendActivity.noteEnterPresence(701, { at_home: false, basic: { last_online: t0 - 30_000 }, lands: [] }, t0 + 1_000);
  assert.equal(r2.lastOnlineMs, t0 - 30_000, 'ms 级应原样返回');
  // at_home 时离线时刻为 0
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
    // 后到 1 秒的 summary_drift（活跃源，非在线源）不得影响在线判定
    friendActivity.recordActivity(801, t + 1_000, 'summary_drift', 'y');
    assert.equal(friendActivity.isFriendOnlineRecently(801, t + 5_000), true,
      '10s 窗内 at_home 在线信号不得被 summary_drift 覆盖');
    // 同毫秒：presence_online 先到，at_home 后到 → at_home（更可靠）胜出并通知
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
  await runTicks(2); // 编入 + 执行
  assert.equal(puts.bug, 1, '虫应放成');
  assert.equal(puts.weed, 0, '暂停翻转后草零写');
  const s = autoBad.getSessionStateForTests(303);
  assert.equal(s.done, true, '部分成功（虫 1 草 0）也会话完成，不丢成功');
  // 恢复 + 长时间推进：不得重放已成功的虫（allowPlace=false）
  deps.paused = base.paused;
  fakeNow += autoBad.DONE_PROBE_MAX_MS + 5_000;
  await autoBad.runTickBody();
  assert.equal(puts.bug, 1, '恢复后不得重放虫');
  assert.equal(puts.weed, 0);
  friendActivity.resetForTest();
});

test('证据唤醒：无会话目标秒级唤醒，不等 30s 空档定时器', async () => {
  friendActivity.resetForTest();
  const visits = [];
  setup({ now: () => Date.now(), visit: async () => { visits.push(Date.now()); return { entered: true, online: false }; } });
  const t0 = Date.now();
  autoBad.startAutoBadLoop();
  friendActivity.recordActivity(303, Date.now(), 'at_home', 't'); // 尚无会话
  await waitFor(() => visits.length > 0, 5_000, '无会话也应及时唤醒进门');
  assert.ok(visits[0] - t0 <= 4_000, `唤醒应秒级（实际 ${visits[0] - t0}ms）`);
  autoBad.stopAutoBadLoop();
  friendActivity.resetForTest();
});

test('可靠在线源（lands_push/presence_online）唤醒；非在线源与非名单目标不唤醒', async () => {
  for (const source of ['lands_push', 'presence_online']) {
    friendActivity.resetForTest();
    setup({ now: () => Date.now(), visit: async () => ({ entered: true, online: false }) });
    autoBad.startAutoBadLoop();
    friendActivity.recordActivity(303, Date.now(), source, 't');
    await sleep(700);
    assert.equal(autoBad.sessionCountForTests(), 1, `${source} 应唤醒建会话`);
    autoBad.stopAutoBadLoop();
    friendActivity.resetForTest();
  }
  for (const source of ['summary_drift', 'last_login', 'social_item_placed']) {
    friendActivity.resetForTest();
    setup({ now: () => Date.now(), visit: async () => ({ entered: true, online: false }) });
    autoBad.startAutoBadLoop();
    friendActivity.recordActivity(303, Date.now(), source, 't');
    friendActivity.recordActivity(999, Date.now(), 'at_home', 't'); // 非名单目标
    await sleep(700);
    assert.equal(autoBad.sessionCountForTests(), 0, `${source}/非名单目标不得唤醒`);
    autoBad.stopAutoBadLoop();
    friendActivity.resetForTest();
  }
});

test('证据唤醒不得穿透退避：deadline 不提前、不无限延后、期内零进门', async () => {
  friendActivity.resetForTest();
  let attempts = 0;
  setup({
    visit: async () => { attempts += 1; return { entered: true, online: true, bug: 0, weed: 0 }; },
  });
  await runTicks(2);
  const deadline = autoBad.getSessionStateForTests(303).retryNotBefore;
  assert.ok(deadline > fakeNow, '零成功应有退避 deadline');
  autoBad.startAutoBadLoop(); // 订阅证据唤醒
  for (let i = 0; i < 3; i++) {
    friendActivity.recordActivity(303, fakeNow + i * 1_000, 'at_home', 't');
  }
  await sleep(400); // 唤醒 tick 已跑过（真实定时器 300ms）
  const s = autoBad.getSessionStateForTests(303);
  assert.ok(s.nextAt >= deadline, `证据不得提前退避 deadline（${s.nextAt} < ${deadline}）`);
  assert.ok(s.nextAt <= deadline, '也不得无限延后（退避到期即解锁）');
  assert.equal(attempts, 1, '退避期内零新进门');
  autoBad.stopAutoBadLoop();
  friendActivity.resetForTest();
});

test('tick 内持续在线证据同样不提前退避 deadline，到期恢复执行', async () => {
  let attempts = 0;
  setup({
    online: () => true, // 每轮 tick 都有"新鲜证据"
    visit: async () => { attempts += 1; return { entered: true, online: true, bug: 0, weed: 0 }; },
  });
  await runTicks(2);
  const deadline = autoBad.getSessionStateForTests(303).retryNotBefore;
  for (let i = 0; i < 3; i++) {
    fakeNow += 5_000;
    await autoBad.runTickBody();
  }
  assert.equal(attempts, 1, '退避期内 tick 也不得重试');
  assert.ok(autoBad.getSessionStateForTests(303).nextAt >= deadline);
  fakeNow = deadline + 3_000;
  await autoBad.runTickBody();
  assert.equal(attempts, 2, '退避到期后应恢复执行');
});

test('真实串行锁：证据唤醒不另起并发进门，跨 stop/start 并发 ≤1，旧代迟到结果作废', async () => {
  friendActivity.resetForTest();
  let active = 0;
  let maxActive = 0;
  let resolveVisit = null;
  setup({
    now: () => Date.now(),
    visit: () => new Promise(resolve => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      resolveVisit = () => {
        active -= 1;
        resolve({ entered: true, online: true, bug: 2, weed: 0 });
      };
    }),
  });
  autoBad.startAutoBadLoop();
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
  friendActivity.resetForTest();
});

test('在途票据计数：同代两个排队体，A settle 后 B 未完成时 isAutoBadRunning 仍 true；全 settle 才 false', async () => {
  friendActivity.resetForTest();
  let settleA = null; // A 以 visit 抛错 settle：不写 nextAt，B 到期后可真实进门
  let settleB = null;
  setup({
    gids: () => [303],
    visit: () => new Promise((resolve, reject) => {
      if (!settleA) settleA = reject;
      else settleB = resolve;
    }),
  });
  await autoBad.runTickBody(); // 初始化会话（nextAt 在未来）
  fakeNow = autoBad.getSessionStateForTests(303).nextAt + 1; // 越过 nextAt 到期
  const a = autoBad.runTickBody(); // A 开始进门（deferred，不 await）
  a.catch(() => { }); // A 将以异常 settle（模拟 visit 失败）
  assert.equal(autoBad.isAutoBadRunning(), true, 'A 在途应报告运行中');
  try {
    await sleep(50);
    assert.ok(settleA, 'A 应已开始进门');
    const b = autoBad.runTickBody(); // 同代 B 排队（等 A 释放串行锁）
    assert.equal(autoBad.isAutoBadRunning(), true, 'B 排队中也应报告运行中');
    settleA(new Error('simulated visit failure')); // A settle，B 接管串行锁
    await sleep(50);
    assert.ok(settleB, 'B 应接管并真实进门');
    assert.equal(autoBad.isAutoBadRunning(), true, 'A 已释放、B 尚未完成时仍应报告运行中');
    settleB({ entered: true, online: true, bug: 1, weed: 0 }); // B settle
    await Promise.allSettled([a, b]);
    assert.equal(autoBad.isAutoBadRunning(), false, '全部 settle 后才空闲');
  } finally {
    // 已 settle 的 promise 再 settle 是 no-op：兜底释放 deferred，防污染串行锁
    try { settleA && settleA(new Error('cleanup')); } catch { }
    try { settleB && settleB({ entered: true, online: true, bug: 1, weed: 0 }); } catch { }
  }
});

test('在途票据计数：stop/start 不伪造空闲，pending 全 settle 才 false（含测试入口）', async () => {
  friendActivity.resetForTest();
  let resolveVisit = null;
  setup({
    gids: () => [303],
    visit: () => new Promise(resolve => {
      resolveVisit = () => resolve({ entered: true, online: true, bug: 1, weed: 0 });
    }),
  });
  await autoBad.runTickBody(); // 初始化会话
  fakeNow = autoBad.getSessionStateForTests(303).nextAt + 1;
  let released = false;
  const release = () => { if (resolveVisit && !released) { released = true; resolveVisit(); } };
  const a = autoBad.runTickBody(); // 测试入口：排队即占票据，不得误报空闲
  assert.equal(autoBad.isAutoBadRunning(), true, '测试入口在途也不得误报空闲');
  try {
    await sleep(50);
    assert.ok(resolveVisit, '首拍应已开始进门');
    autoBad.stopAutoBadLoop();
    assert.equal(autoBad.isAutoBadRunning(), true, 'stop 不得伪造空闲');
    autoBad.startAutoBadLoop();
    assert.equal(autoBad.isAutoBadRunning(), true, 'start 后旧体在途仍不空闲');
    release();
    await a;
    assert.equal(autoBad.isAutoBadRunning(), false, 'pending 全 settle 才空闲');
  } finally {
    release();
  }
  autoBad.stopAutoBadLoop();
});

test('多目标探测全局错峰：相邻探测进门间隔 ≥ PROBE_GLOBAL_GAP_MS', async () => {
  setup({
    gids: () => [303, 304, 305],
    visit: async () => ({ entered: true, online: false, offlineSinceMs: 0 }),
  });
  await runTicks(4, 3_000); // 初次错开进门 + 观察不在场 → 全部转探测节奏
  const slots = [303, 304, 305].map(g => autoBad.getSessionStateForTests(g).nextAt).sort((a, b) => a - b);
  for (let i = 1; i < slots.length; i++) {
    assert.ok(slots[i] - slots[i - 1] >= autoBad.PROBE_GLOBAL_GAP_MS,
      `相邻探测应全局错峰 ≥${autoBad.PROBE_GLOBAL_GAP_MS}ms（实际 ${slots}）`);
  }
});

test('两次短暂离线（10-30s）不复位 done；本地持续 ≥3 分钟离线后再上线可新一次', async () => {
  const visits = [];
  setup({
    visit: async (friend, tally, myGid, opts) => {
      visits.push({ opts: { ...opts } });
      return visits.length === 1
        ? { entered: true, online: true, bug: 1, weed: 0 }
        : { entered: true, online: false, bug: 0, weed: 0, offlineSinceMs: 0 };
    },
  });
  await runTicks(2);
  assert.equal(autoBad.getSessionStateForTests(303).done, true);
  const forceProbe = () => autoBad.__setNextAtForTests(303, fakeNow - 1);
  // 第一次短暂离线（30s 后的下一拍，模拟证据拉近的探测）：记首见时刻，done 保持
  fakeNow += 30_000;
  forceProbe();
  await autoBad.runTickBody();
  assert.equal(autoBad.getSessionStateForTests(303).done, true, '第一次短暂离线不得复位');
  // 第二次仍在 3 分钟内：本地未确证，done 保持
  fakeNow += 30_000;
  forceProbe();
  await autoBad.runTickBody();
  assert.equal(autoBad.getSessionStateForTests(303).done, true, '3 分钟内第二次离线不得复位');
  // 持续 ≥3 分钟后仍观察到不在场：本地确证 → 复位
  fakeNow += autoBad.OFFLINE_RESUME_MS + 30_000;
  forceProbe();
  await autoBad.runTickBody();
  assert.equal(autoBad.getSessionStateForTests(303).done, false, '持续 ≥3 分钟离线应复位');
  // 再上线：可重新执行一次（复位后的探测受全局节奏游标影响，直接强制到期）
  fakeNow += autoBad.PROBE_MAX_MS + 1_000;
  autoBad.__setNextAtForTests(303, fakeNow - 1);
  let executed = false;
  deps.visit = async () => { executed = true; return { entered: true, online: true, bug: 1, weed: 0 }; };
  await autoBad.runTickBody();
  assert.equal(executed, true, '复位后再上线应重新执行');
});

test('在线观测清掉离线首见时刻：离线→在线→离线，时钟重算', async () => {
  const visits = [];
  setup({
    visit: async () => {
      visits.push({});
      if (visits.length === 1) return { entered: true, online: true, bug: 1, weed: 0 };
      if (visits.length === 2) return { entered: true, online: false, offlineSinceMs: 0 };
      if (visits.length === 3) return { entered: true, online: true, bug: 0, weed: 0 };
      return { entered: true, online: false, offlineSinceMs: 0 };
    },
  });
  await runTicks(2);
  assert.equal(autoBad.getSessionStateForTests(303).done, true);
  const forceProbe = () => autoBad.__setNextAtForTests(303, fakeNow - 1);
  fakeNow += 2 * 60_000; // 离线观测 1（首见时刻记于此）
  forceProbe();
  await autoBad.runTickBody();
  fakeNow += 10_000; // 又在线：清掉离线首见时刻
  forceProbe();
  await autoBad.runTickBody();
  fakeNow += 2 * 60_000; // 再离线：距首见已 4 分钟，但在线已清零重算 → 不复位
  forceProbe();
  await autoBad.runTickBody();
  assert.equal(autoBad.getSessionStateForTests(303).done, true, '在线证据清零后离线时长应重算');
});
