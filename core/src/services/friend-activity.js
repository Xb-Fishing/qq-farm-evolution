/**
 * 好友活跃证据（2026-09-22，用户批准的零成本信号）。
 *
 * 两个信号源，全部搭车既有数据、零新增请求：
 * 1. SocialItem.owner_gid + created_at：好友在我（或目标好友）地块放置
 *    黄金虫/足球/鹊羽灵露等社交道具时的操作者+时间戳——进门读地块的
 *    回包里已带，此前被丢弃。
 * 2. 状态隐时钟：好友地块 PlantInfo.dry_time / insect_time 是"变干/生虫
 *    的未来时刻"倒计时——只有主人浇水/除虫才会重置。倒计时突然变远
 *    = 主人刚动过。搭车 inspectFriendLands 的既有快照 diff。
 *
 * 证据只进不发起请求；消费方（重点巡田节奏、面板展示）自行查询。
 * 推送零成本信号用 networkEvents 事件，落地为 per-gid 最近活跃时刻。
 */

const { toNum } = require('../utils/utils');
const { log } = require('../utils/utils');

// gid -> { at, source, detail }；at 为好友活跃的最近证据时刻（墙钟 ms）。
const activityEvidence = new Map();
// 证据保留窗口：超过后视为陈旧，不再算"最近活跃"。
const EVIDENCE_RETENTION_MS = 30 * 60_000;
// 一次倒计时重置至少要延长多久才算"主人动过"（过滤小抖动/时钟校准）。
const IMPLICIT_CLOCK_JUMP_MIN_MS = 5 * 60_000;
const MAX_TRACKED_GIDS = 200;

function recordActivity(gid, at, source, detail = '') {
  const id = toNum(gid);
  if (!id) return;
  const atMs = Number(at) || 0;
  const prev = activityEvidence.get(id);
  if (prev && prev.at >= atMs) return;
  if (activityEvidence.size >= MAX_TRACKED_GIDS && !activityEvidence.has(id)) {
    // 有界：淘汰最旧证据，防止长期运行无限增长。
    let oldestKey = null;
    let oldestAt = Number.POSITIVE_INFINITY;
    for (const [key, value] of activityEvidence) {
      if (value.at < oldestAt) { oldestAt = value.at; oldestKey = key; }
    }
    if (oldestKey != null) activityEvidence.delete(oldestKey);
  }
  activityEvidence.set(id, { at: atMs, source, detail: String(detail || '').slice(0, 120) });
  log('好友', `[重点] GID 活跃证据更新（${source}）`, {
    module: 'friend',
    event: 'friend_activity_evidence',
    friendGid: id,
    source,
    at: atMs,
  });
}

/**
 * 从地块列表提取社交道具信号（自家农场推送 / 好友进门回包共用）。
 * 只认 owner_gid 非自己且 created_at 是"最近"的条目——created_at 落地
 * 时刻即该好友操作时刻。
 */
function noteSocialItems(lands, myGid, now = Date.now()) {
  const my = toNum(myGid);
  for (const land of Array.isArray(lands) ? lands : []) {
    const items = land && land.plant && land.plant.social_items;
    for (const item of Array.isArray(items) ? items : []) {
      const owner = toNum(item && item.owner_gid);
      const createdAtSec = toNum(item && item.created_at);
      if (!owner || owner === my || createdAtSec <= 0) continue;
      const atMs = createdAtSec > 1e12 ? createdAtSec : createdAtSec * 1000;
      // 只记最近 30 分钟内放置的道具；老道具不是"当前活跃"证据。
      if (now - atMs > EVIDENCE_RETENTION_MS) continue;
      recordActivity(owner, atMs, 'social_item_placed', `item ${toNum(item.item_id)}`);
    }
  }
}

/**
 * 状态隐时钟 diff：同一好友地块两次快照，倒计时（变干/生虫时刻）显著
 * 后移 = 主人在两次观察之间浇过水/除过虫。
 * prev/next 为 { dryAtMs, insectAtMs }（0=未知/无）；返回 true 表示有证据。
 */
function noteImplicitClock(gid, prev, next, observedAtMs = Date.now()) {
  const id = toNum(gid);
  if (!id || !prev || !next) return false;
  let jumped = false;
  let detail = '';
  if (prev.dryAtMs > 0 && next.dryAtMs > prev.dryAtMs + IMPLICIT_CLOCK_JUMP_MIN_MS) {
    jumped = true;
    detail = `dry ${Math.round((next.dryAtMs - prev.dryAtMs) / 60000)}m`;
  }
  if (prev.insectAtMs > 0 && next.insectAtMs > prev.insectAtMs + IMPLICIT_CLOCK_JUMP_MIN_MS) {
    jumped = true;
    detail = detail ? `${detail} insect` : `insect ${Math.round((next.insectAtMs - prev.insectAtMs) / 60000)}m`;
  }
  if (!jumped) return false;
  // 主人操作发生在 (上次观察, 本次观察) 之间，取保守下界=上次观察时刻。
  const prevEvidence = activityEvidence.get(id);
  const lowerBound = prevEvidence && prevEvidence.at > prev.observedAtMs
    ? prevEvidence.at
    : prev.observedAtMs || observedAtMs;
  recordActivity(id, Math.min(lowerBound, observedAtMs), 'implicit_clock', detail);
  return true;
}

/**
 * 好友摘要漂移（2026-09-22，调研结论落地）：gold/level/tags 只有本人操作
 * 能改变（收菜卖钱/消费/升级），是归因最强的"好友刚在线"信号——对比作物
 * 状态字段离线也会自然变化。搭车既有 GetAll 摘要轮询做 diff，零新增请求。
 * 首次观察只建基线；变化即记一次活跃证据。
 */
const summaryBaselines = new Map();

function noteSummaryDrift(friends, myGid, now = Date.now()) {
  const my = toNum(myGid);
  for (const friend of Array.isArray(friends) ? friends : []) {
    const gid = toNum(friend && friend.gid);
    if (!gid || gid === my) continue;
    const tags = friend.tags || {};
    const state = [
      toNum(friend.gold),
      toNum(friend.level),
      toNum(tags.is_new),
      toNum(tags.is_follow),
    ].join('|');
    const prev = summaryBaselines.get(gid);
    summaryBaselines.set(gid, state);
    if (!prev || prev === state) continue;
    recordActivity(gid, now, 'summary_drift', `${prev} -> ${state}`);
  }
}

/**
 * 好友摘要 last_login（field 19，2026-09-22 调研：公开参考项目 2 与另一
 * 外部参考仓库双方独立逆向确认存在）：服务端如果填值，值变化（重新登录）就是官方
 * 口径的"好友刚上线"。搭车 GetAll 摘要 diff；服务端不填值时恒 0，
 * 自然无事件，零误报。
 */
const lastLoginBaselines = new Map();

function noteLastLogin(friends, myGid, now = Date.now()) {
  const my = toNum(myGid);
  for (const friend of Array.isArray(friends) ? friends : []) {
    const gid = toNum(friend && friend.gid);
    const value = toNum(friend && friend.last_login);
    if (!gid || gid === my) continue;
    const prev = lastLoginBaselines.get(gid) ?? null;
    lastLoginBaselines.set(gid, value);
    if (prev == null || prev === value) continue;
    const atMs = value > 1e12 ? value : value > 1e9 ? value * 1000 : now;
    recordActivity(gid, Math.min(atMs, now), 'last_login_change', `${prev} -> ${value}`);
  }
}

/** 该好友是否有未过期的活跃证据（默认 30 分钟窗口）。 */
function isFriendActiveRecently(gid, now = Date.now(), windowMs = EVIDENCE_RETENTION_MS) {
  const evidence = activityEvidence.get(toNum(gid));
  return !!evidence && now - evidence.at <= windowMs;
}

// 在线快档窗口：at_home 证据只在上次进门时有效，快档轮询每 ~1s 会刷新它；
// 好友离开后证据停止刷新，窗口一过快档自动衰减回普通节奏（自稳定，无需
// 显式"离线"事件）。90s = 容忍 45-75s 慢档打进一次门 + 网络抖动。
const AT_HOME_FRESH_MS = 90 * 1000;

/** 好友是否"此刻在自己农场里"（最近一次进门 at_home=true 且未过期）。 */
function isFriendAtHomeRecently(gid, now = Date.now(), windowMs = AT_HOME_FRESH_MS) {
  const evidence = activityEvidence.get(toNum(gid));
  return !!evidence && evidence.source === 'at_home' && now - evidence.at <= windowMs;
}

// at_home 上升沿检测（好友从离线变为在线的瞬间）：今日事件只记上线一次，
// 不记持续在线期间的每次刷新。进程重启后首个观测若为在线也会记一次
// （状态表内存态，不落盘——今日事件本身就是当日语义）。
const atHomeStates = new Map();

function noteAtHomeEdge(gid, atHome) {
  const id = toNum(gid);
  if (!id) return false;
  const prev = atHomeStates.get(id) === true;
  atHomeStates.set(id, atHome === true);
  return atHome === true && !prev;
}

/**
 * 批量在场状态机（2026-09-22 调研落地）：BatchGetBasicInfo 的
 * BasicInfo.last_online 在线时不下发（0）、离线时=离线时刻（秒）。
 * 字段消失/出现的边沿 = 上线/下线事件——精确 trigger，无需进门。
 * 返回 'online' | 'offline' | null（null=首次建基线或无变化）。
 */
const presenceStates = new Map(); // gid -> { online, lastOnlineSec }

function notePresenceFromBatch(gid, lastOnlineSec, now = Date.now()) {
  const id = toNum(gid);
  if (!id) return null;
  const sec = toNum(lastOnlineSec);
  const online = !(sec > 0);
  const prev = presenceStates.get(id);
  presenceStates.set(id, { online, lastOnlineSec: sec });
  if (!prev) return null; // 首次观测只建基线
  if (online && !prev.online) {
    recordActivity(id, now, 'presence_online', 'batch last_online cleared');
    return 'online';
  }
  if (!online && prev.online) {
    const atMs = sec > 1e12 ? sec : sec > 1e9 ? sec * 1000 : now;
    recordActivity(id, Math.min(atMs, now), 'last_online', String(sec));
    return 'offline';
  }
  return null;
}

/**
 * 在线信号是否新鲜（供 1s 快档判定）。2026-09-23 用户定标：动作/在场断流
 * 10 秒即视为离场放缓——窗口从 90s 收紧，且 lands_push（好友农场变化推送）
 * 也是在线源：好友不需要"进农场场景"（at_home），只要有动作就算在线。
 * at_home 在 1s 巡访中每秒刷新，所以人在农场时会持续保持快档。
 */
const ONLINE_SIGNAL_FRESH_MS = 10 * 1000;
const ONLINE_SOURCES = new Set(['at_home', 'lands_push', 'presence_online']);

function isFriendOnlineRecently(gid, now = Date.now(), windowMs = ONLINE_SIGNAL_FRESH_MS) {
  const evidence = activityEvidence.get(toNum(gid));
  if (!evidence) return false;
  if (!ONLINE_SOURCES.has(evidence.source)) return false;
  return now - evidence.at <= windowMs;
}

/** 单个好友的最新活跃证据（面板展示用）。 */
function getFriendActivity(gid, now = Date.now()) {
  const evidence = activityEvidence.get(toNum(gid));
  if (!evidence) return null;
  return {
    at: evidence.at,
    source: evidence.source,
    detail: evidence.detail,
    online: isFriendAtHomeRecently(gid, now),
    recent: isFriendActiveRecently(gid, now),
  };
}

/** 面板/巡检用：最近活跃证据摘要（匿名 gid）。 */
function getActivityEvidenceSummary(now = Date.now()) {
  const list = [];
  for (const [gid, evidence] of activityEvidence) {
    if (now - evidence.at > EVIDENCE_RETENTION_MS) {
      activityEvidence.delete(gid);
      continue;
    }
    list.push({ gid, at: evidence.at, source: evidence.source, detail: evidence.detail });
  }
  return list.sort((a, b) => b.at - a.at);
}

function resetForTest() {
  activityEvidence.clear();
  summaryBaselines.clear();
  lastLoginBaselines.clear();
  atHomeStates.clear();
  presenceStates.clear();
}

module.exports = {
  EVIDENCE_RETENTION_MS,
  AT_HOME_FRESH_MS,
  recordActivity,
  noteSocialItems,
  noteImplicitClock,
  noteSummaryDrift,
  noteLastLogin,
  isFriendActiveRecently,
  isFriendAtHomeRecently,
  isFriendOnlineRecently,
  noteAtHomeEdge,
  notePresenceFromBatch,
  getFriendActivity,
  getActivityEvidenceSummary,
  resetForTest,
};
