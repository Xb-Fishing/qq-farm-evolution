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
  // 塞满 200 条 + 1 条新的，最旧的应被淘汰。时间戳用严格递减的秒
  // （原版 now-index 毫秒跨秒边界会导致"最旧"随 now%1000 漂移，~20% 概率 flaky）。
  for (let index = 0; index < 201; index++) {
    noteSocialItems([
      { id: 10, plant: { social_items: [
        // gid 1000+index，放置时刻 = base+index 秒（index 大=更晚放置）
        { item_id: 1, owner_gid: 1000 + index, created_at: Math.floor(now / 1000) + index },
      ] } },
    ], 1, now + 201_000);
  }
  const summary = getActivityEvidenceSummary(now + 201_000);
  assert.ok(summary.length <= 200);
  // gid 1000（最早放置的）应已被淘汰，gid 1200（最后放置）仍在。
  assert.equal(isFriendActiveRecently(1000, now + 201_000), false);
  assert.equal(isFriendActiveRecently(1200, now + 201_000), true);
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

// 2026-09-22 深度调研落地：GameFriend field 19（last_login）。值变化=重新
// 登录=刚上线；服务端不填值时恒 0 无事件（零误报）。
test('last_login change records activity; unfilled field stays silent', () => {
  const activity = require('../src/services/friend-activity');
  activity.resetForTest();
  const now = Date.now();
  // 服务端不填值：两次都是 0，无事件
  activity.noteLastLogin([{ gid: 7, last_login: 0 }], 1, now);
  activity.noteLastLogin([{ gid: 7, last_login: 0 }], 1, now + 60_000);
  assert.equal(activity.isFriendActiveRecently(7, now + 60_000), false);
  // 秒级 epoch：值更新 → 事件，证据时刻=新值
  const freshLoginSec = Math.floor(now / 1000); // 刚刚
  activity.noteLastLogin([{ gid: 7, last_login: freshLoginSec }], 1, now + 120_000);
  assert.equal(activity.isFriendActiveRecently(7, now + 120_000), true);
  // 自己不算
  activity.resetForTest();
  activity.noteLastLogin([{ gid: 1, last_login: 100 }], 1, now);
  activity.noteLastLogin([{ gid: 1, last_login: 200 }], 1, now + 1000);
  assert.equal(activity.isFriendActiveRecently(1, now + 1000), false);
});

// 在线快档信号（2026-09-22 at_home 实测成立）：source=at_home 且新鲜才算在线
test('isFriendAtHomeRecently tracks at_home evidence freshness', () => {
  const activity = require('../src/services/friend-activity');
  activity.resetForTest();
  const now = Date.now();
  // 无证据 → 不在线
  assert.equal(activity.isFriendAtHomeRecently(9, now), false);
  // at_home 证据 30 秒前 → 在线
  activity.recordActivity(9, now - 30_000, 'at_home', 'host in farm');
  assert.equal(activity.isFriendAtHomeRecently(9, now), true);
  // at_home 证据 2 分钟前 → 衰减（好友已离开的判定窗口 90s）
  assert.equal(activity.isFriendAtHomeRecently(9, now + 120_000), false);
  // 其他来源的活跃证据不算在线
  activity.recordActivity(10, now - 10_000, 'last_online', 'x');
  assert.equal(activity.isFriendAtHomeRecently(10, now), false);
  assert.equal(activity.isFriendActiveRecently(10, now), true);
  // 面板访问器
  const info = activity.getFriendActivity(9, now);
  assert.equal(info.online, true);
  assert.equal(info.source, 'at_home');
});

// 上线上升沿：只在上线的第一次观测触发（今日事件去重基础）
test('noteAtHomeEdge fires only on offline-to-online transition', () => {
  const activity = require('../src/services/friend-activity');
  activity.resetForTest();
  assert.equal(activity.noteAtHomeEdge(9, true), true, '首次在线=上升沿');
  assert.equal(activity.noteAtHomeEdge(9, true), false, '持续在线不重复');
  assert.equal(activity.noteAtHomeEdge(9, false), false);
  assert.equal(activity.noteAtHomeEdge(9, true), true, '离线后再上线=新上升沿');
});

// 批量在场状态机（2026-09-22 调研落地）：last_online 出现/消失的边沿
// = 下线/上线事件；首次建基线不触发；isFriendOnlineRecently 覆盖两路在线源
test('notePresenceFromBatch fires on last_online appearance/disappearance edges', () => {
  const activity = require('../src/services/friend-activity');
  activity.resetForTest();
  const now = Date.now();
  // 首次观测（离线态，last_online 有值）：建基线无事件
  assert.equal(activity.notePresenceFromBatch(11, 1_790_000_000, now), null);
  // 字段消失 → 上线
  assert.equal(activity.notePresenceFromBatch(11, 0, now + 30_000), 'online');
  assert.equal(activity.isFriendOnlineRecently(11, now + 30_000), true);
  // 字段重新出现 → 下线（证据时刻=新时间戳）
  const leaveSec = Math.floor((now + 120_000) / 1000);
  assert.equal(activity.notePresenceFromBatch(11, leaveSec, now + 120_000), 'offline');
  assert.equal(activity.isFriendOnlineRecently(11, now + 120_000), false, '下线后在线信号失效');
  assert.equal(activity.isFriendActiveRecently(11, now + 120_000), true, '仍算活跃（30 分钟窗）');
  // 持续离线无事件
  assert.equal(activity.notePresenceFromBatch(11, leaveSec, now + 150_000), null);
});

// 2026-09-23 定标：lands_push 也是在线源，断流 10 秒即放缓
test('isFriendOnlineRecently covers lands_push with 10s window', () => {
  const activity = require('../src/services/friend-activity');
  activity.resetForTest();
  const now = Date.now();
  activity.recordActivity(21, now, 'lands_push', '3 lands');
  assert.equal(activity.isFriendOnlineRecently(21, now + 5_000), true, '推送后 5 秒在线');
  assert.equal(activity.isFriendOnlineRecently(21, now + 11_000), false, '断流 11 秒放缓');
  // 非在线源（摘要漂移）不算在线
  activity.recordActivity(22, now, 'summary_drift', 'x');
  assert.equal(activity.isFriendOnlineRecently(22, now), false);
});
