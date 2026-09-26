const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// 诊断日志验收（2026-09-26 mischief-diagnosis）：全部内存态/替身测试，
// 无真实网络与游戏写请求。目标：有在线证据却无捣乱效果时能准确定位关卡。
process.env.FARM_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fab-diag-'));
process.env.FARM_ACCOUNT_ID = 'diag-test-acct';

const autoBad = require('../src/services/friend-auto-bad');
const friendActivity = require('../src/services/friend-activity');
const utils = require('../src/utils/utils');

const deps = autoBad.__depsForTests;
let fakeNow = Date.now();
const restores = [];

// 额度日闸门替身（真实持久化语义由 friend-auto-bad-quota.test.js 覆盖）：
// 每次 stub 新建，用例间零磁盘、零泄漏
function makeFakeQuota() {
  let gate = null;
  return {
    activePause: () => gate,
    resumeDelayMs: () => (gate ? 3_600_000 : 0),
    pause: reason => {
      if (gate) return null;
      gate = { dayKey: 'test-day', reason, resumeAt: Date.now() + 3_600_000 };
      return gate;
    },
    resumeIfNewDay: () => (gate ? (gate = null, true) : false),
  };
}

function stub(overrides = {}) {
  const base = {
    now: () => fakeNow,
    gids: () => [303],
    myGid: () => 1,
    connected: () => true,
    badRemaining: () => 50,
    quota: makeFakeQuota(),
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

function hookLog() {
  const events = [];
  utils.setLogHook((_tag, _msg, _isWarn, meta) => {
    if (meta && String(meta.event).startsWith('auto_bad')) events.push(meta);
  });
  return events;
}

function setup(overrides = {}) {
  autoBad.stopAutoBadLoop(); // 清会话/定时器/诊断缓存
  friendActivity.resetForTest();
  fakeNow = Date.now();
  stub(overrides);
  autoBad.startAutoBadLoop();
  return overrides;
}

/** 注入一次新鲜在线证据并推进到证据唤醒之后。 */
async function wake(gid, source = 'at_home') {
  friendActivity.recordActivity(gid, fakeNow, source, 't');
  fakeNow += 2_000;
  await autoBad.runTickBody();
}

test.afterEach(() => {
  while (restores.length) restores.pop()();
  autoBad.stopAutoBadLoop();
  friendActivity.resetForTest();
  utils.setLogHook(null);
});

test('启动 lifecycle：一条 auto_bad_lifecycle，含 accountId/armed/selectedCount，无名单内容', async () => {
  const events = hookLog();
  setup({ gids: () => [303, 304] });
  const life = events.filter(e => e.event === 'auto_bad_lifecycle');
  assert.equal(life.length, 1, '启动恰好一条 lifecycle');
  assert.equal(life[0].accountId, 'diag-test-acct');
  assert.equal(life[0].armed, true);
  assert.equal(life[0].selectedCount, 2);
  assert.ok(!JSON.stringify(life[0]).includes('303'), '不得输出名单内容');
});

test('证据→dispatch→result 全链路：字段齐全、昵称正确、result 保留真实计数', async () => {
  const events = hookLog();
  setup({
    visit: async () => ({ entered: true, online: true, bug: 2, weed: 1 }),
  });
  friendActivity.noteFriendName(303, '合成昵称甲'); // setup 内 resetForTest 之后喂名
  await wake(303);
  const ev = stage => events.find(e => e.stage === stage);
  const evidence = ev('evidence');
  assert.ok(evidence, 'evidence 关卡可见');
  assert.equal(evidence.accountId, 'diag-test-acct');
  assert.equal(evidence.friendGid, 303);
  assert.equal(evidence.friendName, '合成昵称甲');
  assert.equal(evidence.reason, 'at_home');
  assert.ok(ev('dispatch'), 'dispatch 关卡可见');
  const result = ev('result');
  assert.ok(result, 'result 关卡可见');
  assert.equal(result.event, 'auto_bad_decision');
  assert.equal(result.reason, 'done');
  assert.equal(result.bug, 2);
  assert.equal(result.weed, 1);
  assert.equal(result.entered, true);
  assert.equal(result.online, true);
  assert.equal(autoBad.getSessionStateForTests(303).done, true, '通过时行为不变');
});

test('无昵称回退 GID：诊断日志 friendName 缺失回退 GID:gid', async () => {
  const events = hookLog();
  setup({ visit: async () => ({ entered: true, online: true, bug: 1, weed: 0 }) });
  await wake(303); // 无缓存昵称
  const result = events.find(e => e.stage === 'result');
  assert.ok(result);
  assert.equal(result.friendName, 'GID:303', '缺失回退 GID');
});

test('节流：同目标同关卡同原因 5min 内只报一次，不同原因/目标首报可见', async () => {
  const events = hookLog();
  setup({
    gids: () => [303, 304],
    visit: async () => ({ entered: false, online: false, bug: 0, weed: 0, reason: 'enter_failed' }),
  });
  await wake(303);
  await wake(304);
  // enter_failed → 退避：后续 tick 的 backoff 关卡节流验证
  for (let i = 0; i < 5; i++) {
    fakeNow += 10_000;
    await autoBad.runTickBody();
  }
  const backoff = events.filter(e => e.stage === 'session' && e.reason === 'backoff');
  assert.equal(backoff.length, 2, '每目标首报各一条（303/304 互不吞）');
  assert.deepEqual(backoff.map(e => e.friendGid).sort(), [303, 304]);
  assert.ok(Number.isInteger(backoff[0].remainingMs), '退避带剩余毫秒整数');
  // 同目标再 tick：5min 内同关卡同原因不再刷
  for (let i = 0; i < 3; i++) {
    fakeNow += 10_000;
    await autoBad.runTickBody();
  }
  assert.equal(events.filter(e => e.stage === 'session' && e.reason === 'backoff').length, 2,
    '重复状态 5min 一次');
  // result 不节流：每次真实动作一条（退避到期后再执行）
  fakeNow = autoBad.getSessionStateForTests(303).nextAt + 1;
  friendActivity.recordActivity(303, fakeNow, 'at_home', 't');
  fakeNow += 2_000;
  await autoBad.runTickBody();
  const results = events.filter(e => e.stage === 'result' && e.friendGid === 303);
  assert.equal(results.length, 2, 'result 按实际动作一条');
  assert.equal(results[1].reason, 'enter_failed', '进门失败不假报成功');
  assert.equal(results[1].reasonDetail, 'enter_failed', '白名单内原因码透传');
  assert.equal(results[1].entered, false);
});

test('result 原因码白名单：非固定码不透传，防原文泄露', async () => {
  const events = hookLog();
  setup({
    visit: async () => ({ entered: true, online: true, bug: 0, weed: 0, reason: 'server said boom 127.0.0.1' }),
  });
  await wake(303);
  const result = events.find(e => e.stage === 'result');
  assert.ok(!result.reasonDetail, '白名单外原因码不进日志');
});

test('主要守卫阻断：paused/cap/checking/removed 各归因到具体关卡', async () => {
  for (const [key, value, reason] of [
    ['paused', true, 'paused'],
    ['checking', true, 'checking'],
    ['badRemaining', 0, 'cap'],
  ]) {
    const events = hookLog();
    autoBad.stopAutoBadLoop();
    friendActivity.resetForTest();
    const overrides = { visit: async () => ({ entered: true, online: true, bug: 1, weed: 0 }) };
    overrides[key] = () => value;
    stub(overrides);
    autoBad.startAutoBadLoop();
    friendActivity.recordActivity(303, fakeNow, 'at_home', 't');
    fakeNow += 2_000;
    await autoBad.runTickBody();
    const blocked = events.find(e => e.event === 'auto_bad_blocked' && e.reason === reason);
    assert.ok(blocked, `${key} 应归因 ${reason}（实际 ${JSON.stringify(events.filter(e => e.event === 'auto_bad_blocked'))}）`);
    assert.equal(blocked.accountId, 'diag-test-acct');
    assert.equal(blocked.friendGid, 303, '有有效已选目标才报目标阻断');
    autoBad.stopAutoBadLoop();
  }
  // removed：证据建会话后移出名单
  const events = hookLog();
  const base = setup({ visit: async () => ({ entered: true, online: true, bug: 1, weed: 0 }) });
  await wake(303);
  deps.gids = () => [];
  await autoBad.runTickBody();
  assert.ok(events.some(e => e.reason === 'removed' && e.friendGid === 303), 'removed 归因可见');
  deps.gids = base.gids;
});

test('空 tick 不刷全表：无会话时守卫阻断零目标级 blocked 日志', async () => {
  const events = hookLog();
  setup({
    gids: () => [303, 304, 305],
    paused: () => true,
    visit: async () => ({ entered: true, online: true, bug: 1, weed: 0 }),
  });
  for (let i = 0; i < 3; i++) await autoBad.runTickBody();
  assert.equal(events.filter(e => e.friendGid).length, 0, '无会话不报目标阻断');
});

test('makeGuard 中途翻转：守卫首拒归因 + result aborted 可见、部分成功计数保留', async () => {
  const events = hookLog();
  setup({
    visit: (friend, tally, myGid, opts) => {
      // 模拟进门后守卫翻转：guard 首拒应记录 paused，visit 返回部分成功+aborted
      deps.paused = () => true;
      const ok = opts.guard();
      deps.paused = () => false;
      assert.equal(ok, false, '守卫判定语义不变');
      return Promise.resolve({ entered: true, online: true, bug: 1, weed: 0, reason: 'weed_aborted', aborted: true });
    },
  });
  await wake(303);
  const guard = events.find(e => e.stage === 'guard' && e.reason === 'paused');
  assert.ok(guard, 'guard 首拒应按相同节流归因 paused');
  const result = events.find(e => e.stage === 'result');
  assert.equal(result.reason, 'done', '部分成功也算 done（≥1 真实成功）');
  assert.equal(result.bug, 1, '真实计数保留');
  assert.equal(result.partial, true, 'aborted 部分成功标记');
  assert.equal(result.reasonDetail, 'weed_aborted', '白名单单项原因码透传');
  assert.equal(autoBad.getSessionStateForTests(303).done, true);
});

test('stale_evidence 关卡：证据过期未动作时归因可见', async () => {
  const events = hookLog();
  setup({ visit: async () => ({ entered: true, online: true, bug: 1, weed: 0 }) });
  friendActivity.recordActivity(303, fakeNow, 'at_home', 't'); // 建会话
  fakeNow += 60_000; // 证据超 10s 窗口
  await autoBad.runTickBody();
  assert.ok(events.some(e => e.stage === 'guard' && e.reason === 'stale_evidence' && e.friendGid === 303));
});

test('stop 清诊断缓存：重启动后同目标同原因首报重新可见', async () => {
  let events = hookLog();
  const base = setup({ visit: async () => ({ entered: true, online: true, bug: 1, weed: 0 }) });
  await wake(303); // done
  friendActivity.recordActivity(303, fakeNow, 'at_home', 't');
  fakeNow += 2_000;
  await autoBad.runTickBody();
  const doneCount = () => events.filter(e => e.stage === 'session' && e.reason === 'done').length;
  assert.equal(doneCount(), 1, 'done 状态首报一条');
  // 重复 done 证据：节流不再报
  friendActivity.recordActivity(303, fakeNow, 'at_home', 't');
  fakeNow += 2_000;
  await autoBad.runTickBody();
  assert.equal(doneCount(), 1, '5min 内同状态不重复');
  // stop/start：会话与诊断缓存都清空；重建 done 后同状态首报重新可见
  autoBad.stopAutoBadLoop();
  autoBad.startAutoBadLoop();
  events = hookLog();
  await wake(303); // 重建会话并完成
  friendActivity.recordActivity(303, fakeNow, 'at_home', 't');
  fakeNow += 2_000;
  await autoBad.runTickBody();
  assert.equal(events.filter(e => e.stage === 'session' && e.reason === 'done').length, 1,
    'stop 清缓存后首报重新可见');
  deps.gids = base.gids;
});

test('friend_activity_evidence 带 accountId 关联元数据（不改在线源/判定）', () => {
  friendActivity.resetForTest();
  const seen = [];
  utils.setLogHook((_t, _m, _w, meta) => {
    if (meta && meta.event === 'friend_activity_evidence') seen.push(meta);
  });
  try {
    friendActivity.recordActivity(901, Date.now(), 'at_home', 't');
    assert.equal(seen.length, 1);
    assert.equal(seen[0].accountId, 'diag-test-acct');
    assert.equal(seen[0].friendGid, 901);
    assert.equal(friendActivity.isFriendOnlineRecently(901), true, '在线判定不变');
  } finally {
    friendActivity.resetForTest();
  }
});
