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
// gid -> { at, source }：已证实在线信号（at_home/lands_push/presence_online）
// 独立成层（2026-09-26 验收修复）：活跃表会被 summary_drift/interact_record
// 等非在线源按 now 覆盖，若在线判定共用活跃表，后到的"好友刚活跃"证据会把
// 3 秒前的 at_home 在线信号顶掉。在线层只收已证实在线源，永不被非在线源覆盖。
const onlineEvidence = new Map();
// 已证实在线源只认 at_home（进门回包在场位）与 presence_online（批量在场
// 感知，轮询保持禁用，只消费既有回包）。lands_push（LandsNotify 推送）
// 2026-09-26 协议审查剔除：proto 只有 lands 与 host_gid，无操作者/主人
// 在线字段，且可由被放虫/放草/偷菜触发——农场变化 ≠ 主人上线，
// 保留为普通活跃/地块变化证据（收菜快通道语义不变）。
const ONLINE_SOURCES = new Set(['at_home', 'presence_online']);
// 同毫秒多源并发（进门回包与推送同拍）时保留更可靠的在线源
const ONLINE_SOURCE_PRIORITY = { at_home: 3, presence_online: 1 };
// 在线证据订阅（调度方事件唤醒用）：只推已证实在线源，返回取消函数。
const onlineEvidenceListeners = new Set();
function notifyOnlineEvidence(gid, at, source) {
  for (const listener of onlineEvidenceListeners) {
    try {
      listener(gid, at, source);
    } catch (err) {
      log('好友', `在线证据订阅回调异常: ${err && err.message}`, {
        module: 'friend', event: 'online_evidence_listener_error', result: 'error',
      });
    }
  }
}
// ===== 运行时好友昵称只读名册（2026-09-26 用户定标）=====
// 复用已成功获取的数据建立：好友列表回包（friend-api.recordRosterReply 惰性
// 喂入 remark>name）与进门回包 EnterReply.basic.name（noteEnterPresence 喂入）。
// 只读内存表，绝不为补名另查游戏 API。未知回退 GID 由调用方处理。
const friendNames = new Map();
function noteFriendName(gid, name) {
  const id = toNum(gid);
  const value = String(name || '').trim().slice(0, 60);
  if (!id || !value) return;
  // 后到覆盖：改名即时生效；更新时重排保持 LRU 淘汰语义
  if (friendNames.has(id)) friendNames.delete(id);
  else if (friendNames.size >= MAX_TRACKED_GIDS) {
    friendNames.delete(friendNames.keys().next().value); // 有界：淘汰最旧
  }
  friendNames.set(id, value);
}
function getCachedFriendName(gid) {
  return friendNames.get(toNum(gid)) || '';
}
// GID 占位识别（2026-09-26 主审 7）：入参 name 经常已是 `GID:123` 占位且
// truthy——不能因为占位非空就放弃刚取得的真昵称
const GID_PLACEHOLDER_RE = /^GID:\d+$/;
/** 展示名解析：真名优先；占位/空回退运行时昵称，仍无则 GID。 */
function resolveFriendDisplayName(gid, name) {
  const raw = String(name || '').trim();
  if (raw && !GID_PLACEHOLDER_RE.test(raw)) return raw;
  const id = toNum(gid);
  return getCachedFriendName(id) || raw || `GID:${id}`;
}

// 被动在场观测订阅（2026-09-26 纯内存，零新增 RPC）：既有进门回包经
// noteEnterPresence 分发 { atHomeDecoded, atHome, lastOnlineMs }；缺
// at_home 字段时 atHomeDecoded=false，消费方不得当明确离场。
const presenceListeners = new Set();
function notifyPresenceObservation(gid, at, payload) {
  for (const listener of presenceListeners) {
    try {
      listener(gid, at, payload);
    } catch {
      // 固定原因码：私有错误内容不进用户日志
      log('好友', '在场观测订阅回调异常', {
        module: 'friend', event: 'presence_listener_error', result: 'error',
        reason: 'listener_error',
      });
    }
  }
}
const EVIDENCE_RETENTION_MS = 30 * 60_000;
// 一次倒计时重置至少要延长多久才算"主人动过"（过滤小抖动/时钟校准）。
const IMPLICIT_CLOCK_JUMP_MIN_MS = 5 * 60_000;
const MAX_TRACKED_GIDS = 200;

function recordActivity(gid, at, source, detail = '') {
  const id = toNum(gid);
  if (!id) return;
  const atMs = Number(at) || 0;
  // 在线层独立结算，先于活跃表的"只保留更新时刻"早退——同毫秒更高
  // 优先级在线源（at_home > lands_push > presence_online）仍要胜出并通知
  if (ONLINE_SOURCES.has(source)) {
    const prevOnline = onlineEvidence.get(id);
    const better = !prevOnline
      || atMs > prevOnline.at
      || (atMs === prevOnline.at
        && (ONLINE_SOURCE_PRIORITY[source] || 0) > (ONLINE_SOURCE_PRIORITY[prevOnline.source] || 0));
    if (better) {
      // 有界：与活跃表同容量上限，淘汰最旧，防长期运行无限增长
      if (!prevOnline && onlineEvidence.size >= MAX_TRACKED_GIDS) {
        let oldestOnlineKey = null;
        let oldestOnlineAt = Number.POSITIVE_INFINITY;
        for (const [key, value] of onlineEvidence) {
          if (value.at < oldestOnlineAt) { oldestOnlineAt = value.at; oldestOnlineKey = key; }
        }
        if (oldestOnlineKey != null) onlineEvidence.delete(oldestOnlineKey);
      }
      onlineEvidence.set(id, { at: atMs, source });
      notifyOnlineEvidence(id, atMs, source);
    }
  }
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
  // 运行时昵称（2026-09-26 用户定标）：证据适用于全好友，删除 [重点] 误导
  // 前缀；有缓存昵称用昵称，未知回退 GID，绝不为补名另查游戏 API
  log('好友', `好友活跃证据更新 ${getCachedFriendName(id) || `GID:${id}`}（${source}）`, {
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
 * 在线信号是否新鲜（供 1s 快档/在线捣乱调度判定）。2026-09-23 用户定标：
 * 动作/在场断流 10 秒即视为离场放缓。2026-09-26 起读独立在线层（只收
 * 已证实在线源 at_home/presence_online；lands_push 只是地块变化证据，
 * 不再算在线源），非在线活跃证据覆盖活跃表不影响在线判定。
 */
const ONLINE_SIGNAL_FRESH_MS = 10 * 1000;

function isFriendOnlineRecently(gid, now = Date.now(), windowMs = ONLINE_SIGNAL_FRESH_MS) {
  const evidence = onlineEvidence.get(toNum(gid));
  if (!evidence) return false;
  return now - evidence.at <= windowMs;
}

/** 订阅已证实在线证据（at_home/lands_push/presence_online）。返回取消函数。 */
function onOnlineEvidence(listener) {
  if (typeof listener !== 'function') return () => { };
  onlineEvidenceListeners.add(listener);
  return () => onlineEvidenceListeners.delete(listener);
}

/** 订阅被动在场观测（既有进门回包，零新增 RPC）。返回取消函数。 */
function onPresenceObservation(listener) {
  if (typeof listener !== 'function') return () => { };
  presenceListeners.add(listener);
  return () => presenceListeners.delete(listener);
}

/** 单个好友的最新活跃证据（面板展示用）。 */
function getFriendActivity(gid, now = Date.now()) {
  const evidence = activityEvidence.get(toNum(gid));
  if (!evidence) return null;
  return {
    at: evidence.at,
    source: evidence.source,
    detail: evidence.detail,
    // 2026-09-26 验收定标：面板 online 与调度用的可靠在线证据同口径
    // （10 秒窗口内 at_home/lands_push/presence_online），atHome 单独保留
    online: isFriendOnlineRecently(gid, now),
    atHome: isFriendAtHomeRecently(gid, now),
    recent: isFriendActiveRecently(gid, now),
  };
}

/** 面板/巡检用：最近活跃证据摘要（匿名 gid）。 */
function getActivityEvidenceSummary(now = Date.now()) {
  const list = [];
  for (const [gid, evidence] of activityEvidence) {
    if (now - evidence.at > EVIDENCE_RETENTION_MS) {
      activityEvidence.delete(gid);
      onlineEvidence.delete(gid); // 在线层同步过期清理
      continue;
    }
    list.push({ gid, at: evidence.at, source: evidence.source, detail: evidence.detail });
  }
  return list.sort((a, b) => b.at - a.at);
}

/**
 * 进门回包的在场信号统一入口（visitFriend / visitFriendForSteal /
 * visitFriendForHelp / 在线捣乱探测共用）：at_home=true 是唯一真·实时在线
 * 信号；last_online>0 才是有效离线时刻——缺省 0 既不当离线时刻也不当在线，
 * 读取路径必须是 enterReply.basic.last_online。recordActivity 只保留更新的
 * 时刻，陈旧历史 last_online 不会覆盖更新的 at_home 证据；在线层独立后
 * 非在线活跃证据也覆不掉在线信号。
 * 返回 { atHome, onlineEdge, lastOnlineMs }：onlineEdge=at_home 上升沿
 * （今日只记一次）；lastOnlineMs=离线时刻（墙钟 ms，0=未知/不下发）。
 */
function noteEnterPresence(gid, enterReply, now = Date.now()) {
  const id = toNum(gid);
  if (!id) return { atHome: false, onlineEdge: false, lastOnlineMs: 0 };
  const atHome = !!(enterReply && enterReply.at_home);
  // 回包里真的下发了 at_home 字段才算解码（protobuf 缺省 false 不当明确 false）
  const atHomeDecoded = Object.prototype.hasOwnProperty.call(enterReply || {}, 'at_home');
  let onlineEdge = false;
  if (atHome) {
    onlineEdge = noteAtHomeEdge(id, true);
  } else {
    noteAtHomeEdge(id, false);
  }
  let lastOnlineMs = 0;
  try {
    // 进门回包自带好友昵称（BasicInfo.name）：喂运行时名册（零新增请求）
    noteFriendName(id, enterReply && enterReply.basic && enterReply.basic.name);
    if (atHome) {
      recordActivity(id, now, 'at_home', 'host in farm');
    } else {
      const sec = toNum(enterReply && enterReply.basic && enterReply.basic.last_online);
      if (sec > 0) {
        lastOnlineMs = sec > 1e12 ? sec : sec > 1e9 ? sec * 1000 : now;
        recordActivity(id, Math.min(lastOnlineMs, now), 'last_online', String(sec));
      }
    }
  } catch { /* 证据记录失败不影响进门主流程 */ }
  // 被动在场观测分发（纯内存）：消费方自行过滤 atHomeDecoded=false
  notifyPresenceObservation(id, now, { atHomeDecoded, atHome, lastOnlineMs });
  return { atHome, onlineEdge, lastOnlineMs };
}

function resetForTest() {
  activityEvidence.clear();
  onlineEvidence.clear();
  summaryBaselines.clear();
  lastLoginBaselines.clear();
  atHomeStates.clear();
  presenceStates.clear();
  friendNames.clear();
  presenceListeners.clear();
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
  onOnlineEvidence,
  onPresenceObservation,
  noteFriendName,
  getCachedFriendName,
  resolveFriendDisplayName,
  noteAtHomeEdge,
  noteEnterPresence,
  notePresenceFromBatch,
  getFriendActivity,
  getActivityEvidenceSummary,
  resetForTest,
};
