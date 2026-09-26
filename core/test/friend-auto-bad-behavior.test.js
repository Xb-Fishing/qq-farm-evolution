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
    // 观察层名册默认为空：既有用例不受全好友采样影响，观察专项再覆盖
    rosterCache: () => [],
    fetchRoster: async () => [],
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

test('每日额度耗尽：动作档零请求；观察层仍采样普通+已开启好友且 put 计数为 0（2026-09-26 新职责）', async () => {
  const visits = [];
  const put = { bug: 0, weed: 0 }; // 计数 spy：生产 helper 会 catch 写异常，throw 不能证明未调用
  setup({
    badRemaining: () => 0,
    gids: () => [303],
    rosterCache: () => [303, 404],
    visit: async (friend, tally, myGid, options) => {
      const r = await visitFriendForAutoBad(friend, tally, myGid, {
        ...options,
        impl: {
          enter: async () => ({ at_home: true, basic: { last_online: 0 }, lands: [{ id: 1 }] }),
          leave: async () => { },
          analyze: () => ({ canPutBug: [11], canPutWeed: [12] }),
          place: {
            badRemaining: () => 0, remainingFor: () => 0,
            checkCanOperate: async () => ({ canOperate: true }),
            putInsects: async () => { put.bug += 1; },
            putWeeds: async () => { put.weed += 1; },
          },
        },
      });
      visits.push({ gid: friend.gid, allowPlace: options.allowPlace });
      return r;
    },
  });
  await runTicks(5, 16_000);
  // 动作档被 80 预算闸拦下：不存在任何 allowPlace≠false 的动作通道访问
  assert.equal(visits.filter(v => v.allowPlace !== false).length, 0, '额度耗尽动作档零探测');
  // 303（已开启 autoBad）与 404（普通好友）都被观察层覆盖，全走零写通道
  for (const gid of [303, 404]) {
    const observed = visits.filter(v => v.gid === gid && v.allowPlace === false);
    assert.ok(observed.length >= 1, `额度耗尽观察层仍采样好友 ${gid}`);
  }
  assert.equal(put.bug, 0, '观察路径零放虫（put 计数）');
  assert.equal(put.weed, 0, '观察路径零放草（put 计数）');
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
  // 盲探测全局 5s 派发槽（第二轮审查）：一次 tick 至多一个盲 Enter，
  // 多目标同时到期也不集中进门——4 拍（步长盖过 15s 探测上界）内串行全覆盖
  await runTicks(4, 16_000);
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

test('在线捣乱进门 at_home 解码四态：缺字段/显式false/显式true/仅其它在线证据', async () => {
  // protobuf 原型缺省 false 不能当"下发过 false"：atHomeDecoded 只认
  // 回包里真的存在 at_home 字段；缺字段时 atHome=null，不伪称在场/不在场。
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

    // 4) 缺 at_home 字段但 10s 窗口内已有其它已证实在线证据：
    //    online=true（合并口径）而 atHome 仍 null（本次未解码）
    friendActivity.resetForTest();
    friendActivity.recordActivity(701, Date.now(), 'lands_push', 'test');
    r = await mk({ basic: { last_online: 0 }, lands: [{ id: 1 }] });
    assert.equal(r.atHomeDecoded, false);
    assert.equal(r.atHome, null, '合并在线证据不得伪称本次解码在场位');
    assert.equal(r.online, true, '其它在线证据仍构成在线');
  } finally {
    friendActivity.resetForTest();
  }
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
    fakeNow += 6_000; // B 的重试同样走 5s 盲探测槽：失败不突发（同步推进，B 微任务启动前生效）
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
  await runTicks(8, 3_000); // 初次错开进门 + 观察不在场 → 全部转探测节奏（5s 盲槽下逐个轮到）
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


// ===== 全好友观察层（2026-09-26 用户定标：在线检测面向全部好友）=====

test('普通好友被轮转采样且零写；autoBad 空名单时观察层照常工作', async () => {
  const visits = [];
  setup({
    gids: () => [],
    rosterCache: () => [301, 302, 303],
    visit: async (friend, tally, myGid, options) => {
      visits.push({ gid: friend.gid, allowPlace: options.allowPlace });
      return { entered: true, online: false, bug: 0, weed: 0 };
    },
  });
  await runTicks(4, 10_000); // 每 tick 最多一个观察，4 tick 覆盖 3 目标
  const gidsSeen = visits.map(v => v.gid);
  assert.ok(gidsSeen.includes(301) && gidsSeen.includes(302) && gidsSeen.includes(303),
    '全部普通好友都被采样（轮转覆盖）');
  assert.ok(visits.every(v => v.allowPlace === false), '观察必须零写通道');
  assert.ok(visits.length <= 4, '一次 tick 最多一个观察');
});

test('观察不影响动作档会话：done/failCount 不被读 probe 改动', async () => {
  const actionVisits = [];
  setup({
    gids: () => [303],
    rosterCache: () => [303, 404],
    visit: async (friend, tally, myGid, options) => {
      actionVisits.push({ gid: friend.gid, allowPlace: options.allowPlace });
      if (options.allowPlace !== false) return { entered: true, online: true, bug: 2, weed: 1 };
      return { entered: true, online: false, bug: 0, weed: 0 };
    },
  });
  await runTicks(2);
  const afterAction = autoBad.getSessionStateForTests(303);
  assert.equal(afterAction.done, true, '动作会话完成');
  await runTicks(3, 10_000);
  const afterObserve = autoBad.getSessionStateForTests(303);
  assert.equal(afterObserve.done, true, '观察不重置 done');
  assert.equal(afterObserve.failCount, 0, '观察不累计失败退避');
  // 303 的观察采样也发生（覆盖 quota/done 时快档停摆的目标）
  assert.ok(actionVisits.some(v => v.gid === 303 && v.allowPlace === false),
    'autoBad 目标也被观察层兜底覆盖');
});

test('全局硬间隔：相邻观察实际发起间隔 >= 5000ms，多逾期不突发', async () => {
  const times = [];
  setup({
    gids: () => [],
    rosterCache: () => [501, 502, 503, 504, 505],
    visit: async (friend) => { times.push({ gid: friend.gid, at: fakeNow }); return { entered: true, online: false }; },
  });
  // 单 tick 内即使全员到期也只发起一个
  await autoBad.runTickBody();
  assert.equal(times.length, 1, '一次 tick 最多一个观察（批量到期不突发）');
  // 3s 步进：间隔不足 5s，不发起
  fakeNow += 3_000;
  await autoBad.runTickBody();
  assert.equal(times.length, 1, '硬间隔内不发起');
  // 再 +3s（累计 6s）：可发起
  fakeNow += 3_000;
  await autoBad.runTickBody();
  assert.equal(times.length, 2, '间隔满足后发起');
  for (let i = 1; i < times.length; i++) {
    assert.ok(times[i].at - times[i - 1].at >= 5_000, '相邻观察发起间隔 >= 5s');
  }
});

test('公平轮转：排序后继游标，动态新增低 ID 不饿死老好友', async () => {
  let roster = [300, 400, 500];
  const seen = [];
  setup({
    gids: () => [],
    rosterCache: () => roster,
    visit: async (friend) => { seen.push(friend.gid); return { entered: true, online: false }; },
  });
  for (let i = 0; i < 3; i++) { await autoBad.runTickBody(); fakeNow += 10_000; }
  assert.deepEqual(seen.slice(0, 3).sort(), [300, 400, 500], '首轮全员覆盖');
  // 游标推进中途插入低 ID：老好友仍按轮转采到
  roster = [100, 300, 400, 500];
  for (let i = 0; i < 4; i++) { await autoBad.runTickBody(); fakeNow += 10_000; }
  const tail = seen.slice(3);
  for (const gid of [300, 400, 500]) {
    assert.ok(tail.includes(gid), `动态名单后老好友 ${gid} 仍被采样`);
  }
  assert.ok(tail.includes(100), '新好友也进入轮转');
});

test('10s 内已有真实观测（动作档刚进门）的目标跳过；跳过不伪更新观测时刻', async () => {
  const visits = [];
  setup({
    gids: () => [303],
    rosterCache: () => [303, 606],
    visit: async (friend, tally, myGid, options) => {
      visits.push({ gid: friend.gid, at: fakeNow, observe: options.allowPlace === false });
      if (options.allowPlace !== false) return { entered: true, online: true, bug: 2, weed: 1 };
      return { entered: true, online: false, bug: 0, weed: 0 };
    },
  });
  // 第 1 拍：动作档仅编入，观察层先采 303（真实首观测，占盲槽）；
  // 第 2 拍：动作档进门 303（lastProbeAt 刚更新并占槽，同拍观察层无槽位）；
  // 第 3 拍（+6s 槽空出）：观察层采 606（303 在 10s 新鲜窗口内被跳过）
  await runTicks(2);
  const obs303 = () => visits.filter(v => v.gid === 303 && v.observe).length;
  assert.equal(obs303(), 1, '到目前恰好一次观察（动作刚进门不重复采）');
  assert.ok(visits.some(v => v.gid === 303 && !v.observe), '动作档已进门');
  fakeNow += 6_000;
  await autoBad.runTickBody();
  assert.equal(obs303(), 1, '10s 内刚进门的目标本轮跳过');
  assert.ok(visits.some(v => v.gid === 606), '跳过不阻塞其他目标采样');
  fakeNow += 11_000; // 超过新鲜窗口后 303 会被观察层再次覆盖
  await autoBad.runTickBody();
  assert.ok(obs303() >= 2, '新鲜窗口过后目标重新可采（跳过不得伪更新为永久跳过）');
});

test('共同守卫拦观察：全局暂停/静默/互斥/让步时观察也停', async () => {
  for (const key of ['paused', 'quietHours', 'checking', 'stealDue', 'harvestImminent']) {
    const visits = [];
    setup({
      gids: () => [],
      rosterCache: () => [707],
      visit: async () => { visits.push({}); return { entered: true, online: false }; },
    });
    deps[key] = () => true;
    restores.push(() => { });
    await autoBad.runTickBody();
    assert.equal(visits.length, 0, `${key} 时观察零请求`);
    deps[key] = () => false;
  }
});

test('stop 清观察状态；stop 后在途观察迟到结果不写状态', async () => {
  const visits = [];
  setup({
    gids: () => [],
    rosterCache: () => [808],
    visit: async (friend) => {
      visits.push(friend.gid);
      autoBad.stopAutoBadLoop(); // 在途观察完成前 stop（升代次）
      return { entered: true, online: false };
    },
  });
  await autoBad.runTickBody();
  assert.equal(visits.length, 1);
  const st = autoBad.__observeStateForTests();
  assert.equal(st.rosterGids.length, 0, 'stop 清空名册');
  assert.equal(st.nextBlindEnterAt, 0, 'stop 清空观察槽位');
});

test('名册冷读失败退避后恢复：fetchRoster 失败不崩、成功后采样', async () => {
  setup({ gids: () => [] }); // 安装基础替身（connected/myGid 等真实默认在测试环境不可用）
  friendActivity.resetForTest();
  const visits = [];
  let failFirst = true;
  deps.rosterCache = () => null; // 冷缓存（三态契约：null=未知，[]=权威空表）
  deps.fetchRoster = async () => {
    if (failFirst) { failFirst = false; throw new Error('cold read fail'); }
    return [909]; // 成功返回权威 gid 数组（null=失败）
  };
  autoBad.startAutoBadLoop();
  await autoBad.runTickBody(); // 首拍：冷读失败（退避占位，不崩）
  await sleep(100);
  assert.equal(autoBad.__observeStateForTests().rosterGids.length, 0, '失败不落名册');
  // 退避窗口内不重试
  fakeNow += 3_000;
  await autoBad.runTickBody();
  await sleep(100);
  assert.equal(autoBad.__observeStateForTests().rosterGids.length, 0, '退避窗口内不重试');
  // 越过 5min 退避后重试成功，采样恢复
  fakeNow += 6 * 60_000;
  deps.visit = async (friend) => { visits.push(friend.gid); return { entered: true, online: false }; };
  await autoBad.runTickBody();
  await sleep(100);
  assert.deepEqual(autoBad.__observeStateForTests().rosterGids, [909], '重试成功落名册');
  await autoBad.runTickBody();
  await sleep(100);
  assert.deepEqual(visits, [909], '名册恢复后观察采样恢复');
  autoBad.stopAutoBadLoop();
  friendActivity.resetForTest();
});

test('真实 getter 接线：friend-api 名册快照（成功出口记录，失败不写）', () => {
  const friendApi = require('../src/services/friend-api');
  // 1) getAllFriends 的全部成功出口都必须接线快照记录（源码级验证，防真实链路漏挂）
  const src = require('fs').readFileSync(require.resolve('../src/services/friend-api'), 'utf8');
  const body = src.slice(src.indexOf('async function getAllFriends('), src.indexOf('/** Get pending friend applications'));
  const exits = (body.match(/buildFriendReply\((?:known|fallback)Friends\)|GetAllFriendsReply\.decode\(body\)/g) || []).length;
  const records = (body.match(/recordRosterReply\(/g) || []).length;
  assert.equal(exits, 3, 'getAllFriends 三个成功出口（QQ 新接口/QQ 兜底/WeChat）');
  assert.equal(exits, records, '每个成功出口必须记录快照');
  // 2) 真实归一化行为：字符串 gid/重复项去重排序；空数组=权威空表非未知
  const snap1 = friendApi.recordRosterReply([{ gid: 111 }, { gid: '222' }, { gid: 111 }]);
  assert.deepEqual(snap1.gids, [111, 222], '字符串 gid 归一化、去重、排序');
  assert.ok(snap1.at > 0, '快照带真实成功时刻');
  const snap2 = friendApi.recordRosterReply([]);
  assert.deepEqual(snap2.gids, [], '空回包=权威空表（不是未知）');
  // 3) deps.rosterCache 真实接线：读快照而非自造数据
  assert.deepEqual(deps.rosterCache(), [], 'deps.rosterCache 消费 friend-api 快照');
  // 4) 回包对象形（game_friends）同样进快照
  friendApi.recordRosterReply({ game_friends: [{ gid: 333 }] });
  assert.deepEqual(deps.rosterCache(), [333], 'reply 形回包进入快照');
});

test('盲探测集中到期不突发：动作多目标 + 大名册同 tick 至多一个盲 Enter', async () => {
  const visits = [];
  const bigRoster = Array.from({ length: 12 }, (_, i) => 900 + i);
  setup({
    gids: () => [303, 304],
    rosterCache: () => bigRoster,
    visit: async (friend, tally, myGid, options) => {
      visits.push({ gid: friend.gid, at: fakeNow, observe: options.allowPlace === false });
      return { entered: true, online: false };
    },
  });
  // 预置全部动作目标到期（模拟批量到期），观察名册同样全到期
  await autoBad.runTickBody(); // 第 1 拍编入
  fakeNow = autoBad.getSessionStateForTests(303).nextAt + 20_000;
  fakeNow = Math.max(fakeNow, autoBad.getSessionStateForTests(304).nextAt + 20_000);
  for (let t = 0; t < 6; t++) {
    await autoBad.runTickBody();
    const thisTick = visits.filter(v => v.at === fakeNow);
    assert.ok(thisTick.length <= 1, `单 tick 盲 Enter 至多一个（第 ${t} 拍实际 ${thisTick.length}）`);
    fakeNow += 6_000; // 越过 5s 槽
  }
  assert.ok(visits.length >= 5, '槽位轮转下持续推进采样');
});

test('名册权威空表（缓存 []）：清空旧名册，不再探测已删除好友', async () => {
  const visits = [];
  let roster = [977];
  setup({
    gids: () => [],
    rosterCache: () => roster,
    visit: async (friend) => { visits.push(friend.gid); return { entered: true, online: false }; },
  });
  await autoBad.runTickBody();
  assert.deepEqual(visits, [977], '有名册时正常采样');
  fakeNow += 6_000;
  roster = []; // 权威空表：好友全部删除
  await autoBad.runTickBody();
  fakeNow += 6_000;
  await autoBad.runTickBody();
  assert.deepEqual(visits, [977], '空表后不再探测旧好友（[] 不是未知，是删除）');
});

test('已知新鲜证据的动作唤醒不占盲槽：同 tick 观察仍可派发', async () => {
  const visits = [];
  setup({
    gids: () => [303],
    rosterCache: () => [404],
    online: gid => gid === 303, // 仅动作目标有新鲜在线证据（证据唤醒优先通道；404 无证据走观察）
    visit: async (friend, tally, myGid, options) => {
      visits.push({ gid: friend.gid, observe: options.allowPlace === false, at: fakeNow });
      return { entered: true, online: true, bug: 1, weed: 0 };
    },
  });
  await autoBad.runTickBody(); // 编入
  fakeNow += 20_000; // 越过错峰
  await autoBad.runTickBody();
  // 同一拍内：动作 303（证据优先，不占盲槽）+ 观察 404（盲槽仍空闲可用）
  assert.ok(visits.some(v => v.gid === 303 && !v.observe), '证据唤醒的动作先派发');
  assert.ok(visits.some(v => v.gid === 404 && v.observe), '动作未占盲槽，观察同拍仍可派发');
});

test('观察守卫在 Enter 在途翻转：暂停/黑名单变更 → aborted 零写且 Leave', async () => {
  const visits = [];
  let guardFlip = false;
  setup({
    gids: () => [],
    rosterCache: () => [987],
    visit: (friend, tally, myGid, options) => visitFriendForAutoBad(friend, tally, myGid, {
      ...options,
      impl: {
        enter: async () => { guardFlip = true; return { at_home: true, basic: { last_online: 0 }, lands: [{ id: 1 }] }; },
        leave: async () => { visits.push('leave'); },
        analyze: () => ({ canPutBug: [11], canPutWeed: [12] }),
        place: {
          badRemaining: () => 50, remainingFor: () => 50,
          checkCanOperate: async () => ({ canOperate: true }),
          putInsects: async () => { visits.push('putBug'); },
          putWeeds: async () => { visits.push('putWeed'); },
        },
      },
    }),
  });
  // 观察守卫由调度传入；Enter 返回瞬间翻转暂停 → guard false
  const origPaused = deps.paused;
  deps.paused = () => guardFlip; // Enter 之后（guard 复查时）才变 true
  restores.push(() => { });
  await autoBad.runTickBody();
  deps.paused = origPaused;
  assert.deepEqual(visits, ['leave'], '守卫翻转即 Leave，零 put');
});

// ===== 第三轮审查收口用例 =====

test('跨组公平：多个持续离线 autoBad 目标占槽时，普通好友在有限槽内全部被采样', async () => {
  const visits = [];
  setup({
    gids: () => [303, 304, 305], // 三个 autoBad 目标持续离线、10-15s 反复到期
    rosterCache: () => [404, 505], // 两个普通好友
    visit: async (friend, tally, myGid, options) => {
      visits.push({ gid: friend.gid, observe: options.allowPlace === false });
      if (options.allowPlace === false) return { entered: true, online: false };
      return { entered: true, online: false }; // 动作探测也观察到不在场
    },
  });
  // 模拟持续混合场景：每拍 6s（越过 5s 槽），26 拍 ≈ 156s
  for (let t = 0; t < 26; t++) { await autoBad.runTickBody(); fakeNow += 6_000; }
  for (const gid of [404, 505]) {
    assert.ok(visits.some(v => v.gid === gid && v.observe),
      `普通好友 ${gid} 必须在有限槽内被观察采样（2:1 公平让位）`);
  }
  assert.ok(visits.some(v => v.gid === 303 && !v.observe), 'autoBad 目标仍持续被动作探测');
});

test('盲槽被占不挡后面的已知在线目标（break→continue 收口）', async () => {
  const visits = [];
  setup({
    gids: () => [303, 304],
    online: gid => gid === 304, // 304 有新鲜在线证据
    visit: async (friend, tally, myGid, options) => {
      visits.push({ gid: friend.gid, at: fakeNow, observe: options.allowPlace === false });
      if (friend.gid === 304) return { entered: true, online: true, bug: 1, weed: 0 };
      return { entered: true, online: false };
    },
  });
  await autoBad.runTickBody(); // 编入
  fakeNow = Math.max(...[303, 304].map(g => autoBad.getSessionStateForTests(g).nextAt)) + 20_000;
  await autoBad.runTickBody();
  // 303（盲）先派发并占槽；304（已知在线）必须同拍仍被派发，不被槽位挡住
  assert.ok(visits.some(v => v.gid === 303 && !v.observe), '盲探测派发并占槽');
  assert.ok(visits.some(v => v.gid === 304 && !v.observe), '排在后面的已知在线目标同拍仍可动作');
});

test('既有巡查新鲜在线证据的目标不被观察层重复 Enter（跳过不伪更新）', async () => {
  const visits = [];
  let onlineGids = new Set([404]); // 既有巡查刚确认 404 在线（10s 窗口内）
  setup({
    gids: () => [],
    rosterCache: () => [404, 505],
    online: gid => onlineGids.has(gid),
    visit: async (friend) => { visits.push(friend.gid); return { entered: true, online: false }; },
  });
  await autoBad.runTickBody();
  assert.deepEqual(visits, [505], '有新鲜在线证据的 404 被跳过，观察 505');
  onlineGids = new Set(); // 证据过期后 404 也会被采样（未伪更新）
  fakeNow += 6_000;
  await autoBad.runTickBody();
  assert.ok(visits.includes(404), '证据过期后 404 恢复可采');
});

test('名册刷新失败语义：fetchRoster throw → 退避占位、旧名册沿用、不误报成功', async () => {
  autoBad.stopAutoBadLoop();
  friendActivity.resetForTest();
  setup({ gids: () => [] });
  deps.rosterCache = () => null; // 冷（无快照）
  let fail = true;
  deps.fetchRoster = async () => { if (fail) throw new Error('rpc fail'); return [606]; };
  autoBad.startAutoBadLoop();
  await autoBad.runTickBody();
  await sleep(100);
  assert.equal(autoBad.__observeStateForTests().rosterGids.length, 0, '失败不落名册');
  fakeNow += 6 * 60_000; // 越过 5min 退避
  deps.rosterCache = () => [707]; // 其他路径 getAllFriends 成功 → 快照可用
  await autoBad.runTickBody();
  await sleep(100);
  assert.deepEqual(autoBad.__observeStateForTests().rosterGids, [707], '快照权威更新即时采用');
  // 快照采纳后 30min 内即使过退避位也不再重复强制拉取（有界）
  fakeNow += 6 * 60_000;
  fail = false;
  await autoBad.runTickBody();
  await sleep(100);
  assert.equal(autoBad.__observeStateForTests().rosterGids.length, 1, '名册保持单一来源');
  autoBad.stopAutoBadLoop();
  friendActivity.resetForTest();
});

test('friend_observe_sample 字段口径：onlineEvidence=合并证据，atHome=本次解码在场位（未解码为 null）', async () => {
  // 主审修正 2：online 合并了 at_home 与 10s 窗口其它在线证据，
  // 日志不得把"其它活跃证据"伪称"本次农场在场位=true"。
  const samples = [];
  const utils = require('../src/utils/utils');
  utils.setLogHook((_tag, _msg, _isWarn, meta) => {
    if (meta && meta.event === 'friend_observe_sample') samples.push(meta);
  });
  try {
    let call = 0;
    setup({
      gids: () => [], // 只跑观察层
      rosterCache: () => [801],
      visit: async () => {
        call += 1;
        return call === 1
          // 合并证据在线（online=true）但本次 Enter 解码 at_home=false
          ? { entered: true, online: true, bug: 0, weed: 0, atHome: false, atHomeDecoded: true }
          // 同样在线但本次回包未解码在场位
          : { entered: true, online: true, bug: 0, weed: 0, atHome: false, atHomeDecoded: false };
      },
    });
    await autoBad.runTickBody();
    await sleep(100);
    fakeNow += 60_000; // 越过盲槽硬间隔与新鲜跳过窗口
    await autoBad.runTickBody();
    await sleep(100);
    assert.equal(samples.length, 2, '两拍各一条采样日志');
    const [s1, s2] = samples;
    assert.equal(s1.onlineEvidence, true, '在线证据字段独立记录');
    assert.equal(s1.atHome, false, '本次解码 at_home=false 不得因合并证据被改写为 true');
    assert.equal(s1.atHomeSeen, true, '解码标志随 at_home 字段存在性记录（键名避开脱敏正则）');
    assert.equal(typeof s1.accountId, 'string', '观察日志带 accountId 区分账号');
    assert.equal(s1.result, 'ok');
    assert.equal(s2.atHome, null, '未解码到场位时 atHome=null，不伪称在场/不在场');
    assert.equal(s2.onlineEvidence, true);
    // 无原始包/凭据入日志：字段白名单
    const allowed = new Set(['module', 'event', 'accountId', 'result', 'friendGid', 'reason', 'onlineEvidence', 'atHomeSeen', 'atHome', 'sampledAt', 'tag']);
    for (const s of samples) {
      for (const key of Object.keys(s)) assert.ok(allowed.has(key), `日志出现白名单外字段 ${key}`);
    }
  } finally {
    utils.setLogHook(null);
  }
});

test('跨组公平让位仅在有合格观察候选时生效：名册全为黑名单时盲动作不被 streak>=2 永久挡死', async () => {
  // 主审自查项：rosterGids 非空但观察层无合格候选（全黑名单）时，
  // 让位等于盲动作永久停摆；也不能靠伪更新 lastProbeAt 解锁。
  const visits = [];
  setup({
    gids: () => [303, 304],
    rosterCache: () => [999], // 名册非空但唯一成员在黑名单 → 观察层无候选
    blacklist: () => new Set([999]),
    visit: async (friend) => {
      visits.push(friend.gid);
      return { entered: true, online: false, bug: 0, weed: 0, reason: 'not_online' };
    },
  });
  for (let i = 0; i < 5; i++) {
    await autoBad.runTickBody();
    fakeNow = Math.max(
      autoBad.getSessionStateForTests(303).nextAt,
      autoBad.getSessionStateForTests(304).nextAt) + 20_000; // 越过节奏与 5s 盲槽
  }
  assert.ok(visits.length >= 4,
    `名册无合格候选时盲动作探测必须持续派发（实际 ${visits.length} 次）`);
});
