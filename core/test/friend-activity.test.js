const test = require('node:test');
const assert = require('node:assert/strict');

const {
  noteSocialItems,
  isFriendActiveRecently,
  getActivityEvidenceSummary,
  resetForTest,
} = require('../src/services/friend-activity');

test('社交道具信号：非我 owner + 30 分钟内 created_at 记录活跃', () => {
  resetForTest();
  const now = Date.now();
  const myGid = 1;
  noteSocialItems([
    { id: 10, plant: { social_items: [
      { item_id: 301101, owner_gid: 555, created_at: Math.floor(now / 1000) - 300 },
      // 自己放的：忽略
      { item_id: 301101, owner_gid: myGid, created_at: Math.floor(now / 1000) },
      // 1 小时前的老道具：不是当前活跃证据
      { item_id: 301102, owner_gid: 666, created_at: Math.floor(now / 1000) - 3600 },
    ] } },
  ], myGid, now);

  assert.equal(isFriendActiveRecently(555, now), true);
  assert.equal(isFriendActiveRecently(myGid, now), false);
  assert.equal(isFriendActiveRecently(666, now), false, '陈旧道具不算活跃');

  const summary = getActivityEvidenceSummary(now);
  assert.equal(summary.length, 1);
  assert.equal(summary[0].gid, 555);
  assert.equal(summary[0].source, 'social_item_placed');
});

test('活跃证据 30 分钟后过期', () => {
  resetForTest();
  const now = Date.now();
  noteSocialItems([
    { id: 10, plant: { social_items: [
      { item_id: 301101, owner_gid: 777, created_at: Math.floor(now / 1000) },
    ] } },
  ], 1, now);
  assert.equal(isFriendActiveRecently(777, now), true);
  assert.equal(isFriendActiveRecently(777, now + 31 * 60_000), false);
});

test('隐时钟：倒计时显著后移记为 owner 活跃，小幅抖动忽略', () => {
  resetForTest();
  const now = Date.now();
  // 通过 fertilizer-watch 的公开入口验证集成：inspectFriendLands 的
  // weakReasons owner_watered_recently 分支。这里直接测记录语义。
  const { recordActivity } = require('../src/services/friend-activity');
  recordActivity(888, now - 120_000, 'implicit_clock', 'dry 10m');
  assert.equal(isFriendActiveRecently(888, now), true);
  assert.equal(isFriendActiveRecently(999, now), false, '无证据好友为否');
});

test('有界：超容量时淘汰最旧证据', () => {
  resetForTest();
  const now = Date.now();
  // 塞满 200 条 + 1 条新的，最旧的应被淘汰。
  for (let index = 0; index < 201; index++) {
    noteSocialItems([
      { id: 10, plant: { social_items: [
        { item_id: 1, owner_gid: 1000 + index, created_at: Math.floor((now - index) / 1000) },
      ] } },
    ], 1, now);
  }
  const summary = getActivityEvidenceSummary(now);
  assert.ok(summary.length <= 200);
  // gid 1000（最早放置的）应已被淘汰，gid 1200 仍在。
  assert.equal(isFriendActiveRecently(1000, now), false);
  assert.equal(isFriendActiveRecently(1200, now), true);
});

test('inspectFriendLands 隐时钟集成：dry 倒计时后移触发 owner 活跃记录', () => {
  resetForTest();
  // 用 fertilizer-watch 的真实入口验证：同一茬 dryAt 后移 >5 分钟。
  const fw = require('../src/services/fertilizer-watch');
  const now = Date.now();
  const future = (sec) => Math.floor(now / 1000) + sec;
  const mkLand = (drySec) => ({
    id: 10,
    plant: {
      id: 100,
      phases: [
        { phase: 2, begin_time: future(-3600), dry_time: drySec },
      ],
      is_nudged: false,
    },
  });
  // 第一次观察：dry 在 +600s。
  fw.inspectFriendLands(4242, '测试好友', [mkLand(future(600))], now, {});
  // 第二次观察：同茬 dry 后移到 +1800s（主人浇过水）。
  fw.inspectFriendLands(4242, '测试好友', [mkLand(future(1800))], now + 60_000, {});
  assert.equal(isFriendActiveRecently(4242, now + 61_000), true, '主人浇水证据应被记录');
  const summary = getActivityEvidenceSummary(now + 61_000);
  const entry = summary.find(item => item.gid === 4242);
  assert.ok(entry, '应有 4242 的证据');
  assert.equal(entry.source, 'implicit_clock');
});

// 2026-09-22 调研落地：gold/level/tags 只有本人操作能变，是"好友刚在线"
// 的最强归因信号。首次建基线不报，变化必报，静默不报。
test('summary drift records activity only when gold/level/tags change', () => {
  const activity = require('../src/services/friend-activity');
  activity.resetForTest();
  const now = Date.now();
  const friend = (gold, level, tags) => ({ gid: 42, gold, level, tags });
  // 首次观察：只建基线
  activity.noteSummaryDrift([friend(1000, 10, { is_new: 0, is_follow: 1 })], 1, now);
  assert.equal(activity.isFriendActiveRecently(42, now), false);
  // 静默：无变化
  activity.noteSummaryDrift([friend(1000, 10, { is_new: 0, is_follow: 1 })], 1, now + 60_000);
  assert.equal(activity.isFriendActiveRecently(42, now + 60_000), false);
  // gold 变化（收菜卖钱）→ 活跃
  activity.noteSummaryDrift([friend(1500, 10, { is_new: 0, is_follow: 1 })], 1, now + 120_000);
  assert.equal(activity.isFriendActiveRecently(42, now + 120_000), true);
  // 自己不算
  activity.resetForTest();
  activity.noteSummaryDrift([{ gid: 1, gold: 1, level: 1 }], 1, now);
  activity.noteSummaryDrift([{ gid: 1, gold: 2, level: 1 }], 1, now + 1000);
  assert.equal(activity.isFriendActiveRecently(1, now + 1000), false);
});
