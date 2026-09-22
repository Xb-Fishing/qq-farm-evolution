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

/** 该好友是否有未过期的活跃证据（默认 30 分钟窗口）。 */
function isFriendActiveRecently(gid, now = Date.now(), windowMs = EVIDENCE_RETENTION_MS) {
  const evidence = activityEvidence.get(toNum(gid));
  return !!evidence && now - evidence.at <= windowMs;
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
}

module.exports = {
  EVIDENCE_RETENTION_MS,
  recordActivity,
  noteSocialItems,
  noteImplicitClock,
  noteSummaryDrift,
  isFriendActiveRecently,
  getActivityEvidenceSummary,
  resetForTest,
};
