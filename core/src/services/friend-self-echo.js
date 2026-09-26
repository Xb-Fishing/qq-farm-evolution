/**
 * 好友农场自回声识别（2026-09-26，纯内存，无新增 RPC/轮询）。
 *
 * 目的：我们自己对好友农场的写操作（放虫/放草/偷/帮忙浇水除草除虫）会
 * 触发服务器 LandsNotify 推送。这些"自己造成的变化"被 worker 当成外部
 * 活跃证据（lands_push/fastLane/poll 拉近）会虚增好友活跃度。
 *
 * 铁原则（主 Agent 2026-09-26 两轮审核口径）：
 * 1. 仅含历史自己的 owner/stealer **绝不**构成回声证据——那是历史状态。
 *    回声必须有：本次写操作 ticket（pending 或已确认）+ ticket 登记时
 *    冻结的写前完整 LandInfo 基线，且完整语义差异全部落在该操作允许
 *    变化的精确 plant 路径内；confirmed 还要求推送与回包逐地块状态完全
 *    相等。LandInfo 外层（buff/level/未知新增字段）任何变化一律放行。
 * 2. 不确定一律放行：无写前基线（即使回包确认）、字段缺省、phases 无法
 *    确证、快照可偷/新成熟/阶段按时间可能跨入成熟——全部照常触发，
 *    宁误报外部活跃，不漏报真实好友动作/成熟竞速。
 * 3. 消费有界：每 ticket 每地块只吸收 1 次推送；TTL 短；纯内存，
 *    stop 清零且 ticket 序号单调不复用，旧回包不能污染新 ticket。
 */

const { toNum } = require('../utils/utils');

// ===== 有界性参数 =====
const PENDING_TTL_MS = 20_000;        // 写请求发出→回包确认前的等待窗
const CONFIRMED_TTL_MS = 30_000;      // 回包确认后可吸收迟到回声的窗
const BASELINE_TTL_MS = 10 * 60_000;  // Enter/push 基线保鲜期
const MAX_TICKETS = 200;              // 全局 ticket 上限（超出即剪最老，保守放行）
const MAX_BASELINE_HOSTS = 64;        // 基线好友上限（粗 LRU）
const MAX_BASELINE_LANDS_PER_HOST = 64; // 单好友地块基线上限
const ECHO_BUDGET_PER_LAND = 1;       // 每 ticket 每地块最多吸收的推送次数
// 跨成熟保护余量：写前采样后到判定时，成熟墙钟落在这段内的按"可能已跨
// 入成熟"保守放行（不改变任何成熟计算本身，只影响是否吞推送）。
const MATURITY_GUARD_SLACK_MS = 60_000;

// 早到回声（push 先于 RPC 回包）白名单。Water/WeedOut/Insecticide 无
// actor 正证据原则上早到不拦；纯差异检测仍统一实现，供 confirmed 分支
// 与未来证据充分的场景复用（早到路径保持只对下列操作开放）。
const EARLY_ECHO_OPS = new Set(['PutInsects', 'PutWeeds', 'Harvest']);
// confirmed（迟到回声）分支开放全部操作：回包逐地块状态 + 纯操作差异。
const CONFIRMED_ECHO_OPS = new Set([
  'PutInsects', 'PutWeeds', 'Harvest',
  'WaterLand', 'WeedOut', 'Insecticide',
]);

// 已知集合语义字段（顺序无关，可排序比较）。其它数组一律保序——排序
// 未知有序数组会抹掉真实变化。
const SET_FIELDS = new Set(['weed_owners', 'insect_owners', 'stealers']);

// PlantPhase（config）：6=MATURE。成熟判定不自创映射，统一走现有
// farm-land-analyzer.getCurrentPhase（phases 是"当前+后续"时间表，第一条
// 才是当前阶段——遍历命中 phase=6 会把正常生长中作物误判成熟）。
const { PlantPhase } = require('../config/config');

/** 惰性加载现有 helper（不改原 helper；加载失败时返回 null = 无法确证）。 */
function getAnalyzer() {
  try {
    const analyzer = require('./farm-land-analyzer');
    return typeof analyzer.getCurrentPhase === 'function' ? analyzer : null;
  } catch {
    return null;
  }
}

/**
 * 用现有 analyzer 判定快照"采样时刻"的当前阶段与是否成熟。
 * 返回 { phase, mature }；无法确证返回 null。
 */
function phaseStateAtSnapshot(plant) {
  const phases = plant && Array.isArray(plant.phases) ? plant.phases : null;
  if (!phases || phases.length === 0) return null;
  const analyzer = getAnalyzer();
  if (!analyzer) return null;
  try {
    const cur = analyzer.getCurrentPhase(phases, false, '', toNum(plant.id));
    if (!cur) return null;
    const phase = toNum(cur.phase);
    if (phase === PlantPhase.UNKNOWN) return null;
    return { phase, mature: phase === PlantPhase.MATURE, dead: phase === PlantPhase.DEAD };
  } catch {
    return null;
  }
}

/** 成熟墙钟：官方语义取 phases 末条 begin_time（秒）。无法确证返回 0。 */
function matureDeadlineSec(plant) {
  const phases = plant && Array.isArray(plant.phases) ? plant.phases : null;
  if (!phases || phases.length === 0) return 0;
  const { toTimeSec } = require('../utils/utils');
  return toTimeSec(phases[phases.length - 1].begin_time);
}

// ===== 状态（纯内存） =====
/** hostGid -> Map<landId, { norm, at }> */
const baselines = new Map();
/** ticketId -> ticket */
const tickets = new Map();
let ticketSeq = 0;      // 单调递增，stop 不重置——旧回包 confirm 查无此票
let generation = 0;     // stop() 递增，防御性代次标记
let echoAbsorbedTotal = 0;

// ===== 规范化 =====

/** Long（protobufjs，low/high）→ 精确十进制字符串（BigInt 位运算，尊重 unsigned）。 */
function longToBigStr(v) {
  const low = BigInt(v.low >>> 0);
  const high = BigInt(v.unsigned ? v.high >>> 0 : v.high | 0);
  return String((high << 32n) | low);
}

/** 安全 BigInt：缺省/不可解析返回 null（不得让 tracker 异常逃逸吞掉整条真推送）。 */
function bigOrNull(v) {
  if (v === null || v === undefined) return null;
  try {
    return BigInt(v);
  } catch {
    return null;
  }
}

function isLong(v) {
  return !!v && typeof v === 'object' &&
    typeof v.low === 'number' && typeof v.high === 'number';
}

/**
 * 标量规范化：Long/整数 → 精确十进制字符串（数值与 Long 形式同义）；
 * 其余原样。不做未知字段默认值猜测——缺省(undefined→null)与任何显式值
 * 都视为差异（保守放行）。
 */
function normScalar(v) {
  if (isLong(v)) return longToBigStr(v);
  if (typeof v === 'number' && Number.isInteger(v)) return String(BigInt(v));
  return v;
}

/**
 * 递归规范化：Long→精确字符串、undefined/null→null、SET_FIELDS 三个
 * 已知集合字段排序、其余数组保序、对象键排序。未知/新增字段原样保留，
 * 任何新增字段差异都会被比较发现。
 */
function normValue(v, key) {
  if (v === undefined || v === null) return null;
  if (isLong(v)) return longToBigStr(v);
  if (typeof v === 'number' && Number.isInteger(v)) return String(BigInt(v));
  if (Array.isArray(v)) {
    const items = v.map(x => normValue(x));
    if (items.length === 0) return null; // 空数组与缺省同义（解码侧物化空容器）
    return key && SET_FIELDS.has(key) ? items.slice().sort() : items;
  }
  if (typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v).sort()) {
      const nv = normValue(v[k], k);
      if (nv === null) continue; // 显式空/缺省键与键不存在同义
      out[k] = nv;
    }
    if (Object.keys(out).length === 0) return null; // 空对象与缺省同义
    return out;
  }
  return v;
}

// proto3 声明默认值（解码侧缺省字段不下发）：缺省与显式默认值必须同义，
// 否则真实回包/推送永远比不平。只对已知 PlantInfo 字段生效，未知字段
// 一律不猜默认值（缺省差异保守放行）。
const PLANT_DEFAULTS = {
  id: 0, name: '', season: 0, dry_num: 0, stole_num: 0,
  fruit_id: 0, fruit_num: 0, grow_sec: 0, stealable: false,
  left_inorc_fert_times: 0, left_fruit_num: 0, steal_intimacy_level: 0,
  is_nudged: false,
  weed_owners: [], insect_owners: [], stealers: [],
  mutant_config_ids: [], social_items: [], phases: [],
};

function normalizeLand(land) {
  const src = land;
  if (src && typeof src === 'object' && !Array.isArray(src) &&
      src.plant && typeof src.plant === 'object' && !Array.isArray(src.plant)) {
    const plant = { ...src.plant };
    for (const k of Object.keys(PLANT_DEFAULTS)) {
      if (!(k in plant)) plant[k] = PLANT_DEFAULTS[k];
    }
    return normValue({ ...src, plant });
  }
  return normValue(src);
}

/** 规范化后深度相等（键有序；集合数组有序、其余数组保序，可比较字符串）。 */
function sameNorm(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** 集合列表（规范化后字符串数组）新增且仅新增 selfGid。 */
function gainsOnlySelf(baseList, newList, selfGid) {
  const base = new Set(Array.isArray(baseList) ? baseList : []);
  const next = new Set(Array.isArray(newList) ? newList : []);
  const selfKey = normScalar(selfGid);
  if (base.has(selfKey) || !next.has(selfKey)) return false;
  if (next.size !== base.size + 1) return false;
  for (const v of next) {
    if (!base.has(v) && v !== selfKey) return false;
  }
  return true;
}

/** 集合列表被清空（且之前非空）——帮忙除草/除虫后的期望形态。 */
function clearedSet(baseList, newList) {
  const base = Array.isArray(baseList) ? baseList : [];
  const next = Array.isArray(newList) ? newList : [];
  return base.length > 0 && next.length === 0;
}

/**
 * 完整 LandInfo 比较：除精确允许的 plant 路径外，外层（id/buff/level/
 * is_shared/未知新增字段…）与 plant 其余子字段必须逐字节一致；允许路径
 * 上的取值还必须符合该操作的语义（详见各分支），不满足即放行。
 */
function isPureOperationDiff(op, base, pushed, selfGid) {
  if (!base || !pushed) return false;

  const basePlant = base.plant || {};
  const pushedPlant = pushed.plant || {};

  const stripPlant = (plant, keys) => {
    const out = {};
    for (const k of Object.keys(plant)) {
      if (!keys.includes(k)) out[k] = plant[k];
    }
    return out;
  };
  const restSame = (keys) =>
    sameNorm(
      { ...base, plant: stripPlant(basePlant, keys) },
      { ...pushed, plant: stripPlant(pushedPlant, keys) }
    );

  if (op === 'PutInsects') {
    return restSame(['insect_owners']) &&
      gainsOnlySelf(basePlant.insect_owners, pushedPlant.insect_owners, selfGid);
  }
  if (op === 'PutWeeds') {
    return restSame(['weed_owners']) &&
      gainsOnlySelf(basePlant.weed_owners, pushedPlant.weed_owners, selfGid);
  }
  if (op === 'Harvest') {
    const keys = ['stealers', 'stole_num', 'left_fruit_num'];
    if (!restSame(keys)) return false;
    if (!gainsOnlySelf(basePlant.stealers, pushedPlant.stealers, selfGid)) return false;
    const stoleBefore = bigOrNull(basePlant.stole_num);
    const stoleAfter = bigOrNull(pushedPlant.stole_num);
    const leftBefore = bigOrNull(basePlant.left_fruit_num);
    const leftAfter = bigOrNull(pushedPlant.left_fruit_num);
    // 计数证据不足（字段缺省/未知）时不拦——不确定就保留。
    if (stoleBefore === null || stoleAfter === null ||
        leftBefore === null || leftAfter === null) return false;
    return stoleAfter > stoleBefore && leftAfter < leftBefore;
  }
  if (op === 'WaterLand') {
    // 纯浇水：仅 dry_num 下降到合法非负值，其它一切不变。
    if (!restSame(['dry_num'])) return false;
    const before = bigOrNull(basePlant.dry_num);
    const after = bigOrNull(pushedPlant.dry_num);
    if (before === null || after === null) return false;
    return after >= 0n && after < before;
  }
  if (op === 'WeedOut') {
    return restSame(['weed_owners']) &&
      clearedSet(basePlant.weed_owners, pushedPlant.weed_owners);
  }
  if (op === 'Insecticide') {
    return restSame(['insect_owners']) &&
      clearedSet(basePlant.insect_owners, pushedPlant.insect_owners);
  }
  return false;
}

/**
 * 成熟保护：成熟墙钟（phases 末条 begin_time，服务器时钟口径）落在保护
 * 余量内、已跨入成熟、阶段无法确证、或成熟相关状态翻转 → 一律放行。
 * 唯一例外：Harvest 回声——写前采样时刻就已成熟、当前仍成熟，且差异
 * 只增加自己 stealer（由 isPureOperationDiff 把关），允许过滤。
 * 返回 true = 存在成熟相关风险，必须放行。
 */
function maturityRisk(op, beforeNorm, pushedNorm, nowMs) {
  const pushedPlant = pushedNorm && pushedNorm.plant;
  const beforePlant = beforeNorm && beforeNorm.plant;
  if (!pushedPlant || !beforePlant) return true; // 无完整前后语义，无从确证

  const pushedState = phaseStateAtSnapshot(pushedPlant);
  if (!pushedState) return true; // phases 无法确证，保守不吞

  // 非偷操作：快照可偷优先保留（偷菜竞速链依赖推送触发）。
  if (op !== 'Harvest' && pushedPlant.stealable === true) return true;

  const { getServerTimeSec } = require('../utils/utils');
  const serverNowSec = getServerTimeSec() > 0 ? getServerTimeSec() : Math.floor(nowMs / 1000);

  if (pushedState.mature || pushedState.dead) {
    if (op !== 'Harvest') return true; // 放虫/放草/帮忙只允许过滤生长中快照
    // Harvest：写前采样时刻必须同样已成熟（同一茬、非本次跨入成熟）。
    const beforeState = phaseStateAtSnapshot(beforePlant);
    if (!beforeState || !beforeState.mature) return true;
    return false;
  }

  // 生长中快照不可能是 Harvest 回声（偷只发生在成熟地）。
  if (op === 'Harvest') return true;

  // 当前生长中：写前也必须生长中（不能是成熟/枯死/未知翻转）。
  const beforeState = phaseStateAtSnapshot(beforePlant);
  if (!beforeState || beforeState.mature || beforeState.dead) return true;

  // phase 字节不变但时间推进可能跨成熟：成熟墙钟必须明确在保护余量之外。
  const deadlineSec = matureDeadlineSec(beforePlant);
  if (deadlineSec <= 0) return true; // 无墙钟，无法确证
  if ((deadlineSec - serverNowSec) * 1000 <= MATURITY_GUARD_SLACK_MS) return true;
  return false;
}

// ===== 清理 =====

function pruneTickets(now = Date.now()) {
  for (const [id, t] of tickets) {
    const ttl = t.state === 'confirmed' ? CONFIRMED_TTL_MS : PENDING_TTL_MS;
    if (now - t.at > ttl) tickets.delete(id);
  }
  while (tickets.size > MAX_TICKETS) {
    let oldest = null;
    for (const [id, t] of tickets) {
      if (!oldest || t.at < oldest.t.at) oldest = { id, t };
    }
    if (!oldest) break;
    tickets.delete(oldest.id);
  }
}

function pruneBaselines(now = Date.now()) {
  for (const [host, landMap] of baselines) {
    for (const [landId, s] of landMap) {
      if (now - s.at > BASELINE_TTL_MS) landMap.delete(landId);
    }
    while (landMap.size > MAX_BASELINE_LANDS_PER_HOST) {
      let oldestId = null;
      let oldestAt = Infinity;
      for (const [landId, s] of landMap) {
        if (s.at < oldestAt) { oldestAt = s.at; oldestId = landId; }
      }
      if (oldestId === null) break;
      landMap.delete(oldestId);
    }
    if (landMap.size === 0) baselines.delete(host);
  }
  while (baselines.size > MAX_BASELINE_HOSTS) {
    let oldestHost = null;
    let oldestAt = Infinity;
    for (const [host, landMap] of baselines) {
      for (const s of landMap.values()) {
        if (s.at < oldestAt) { oldestAt = s.at; oldestHost = host; }
      }
    }
    if (oldestHost === null) break;
    baselines.delete(oldestHost);
  }
}

// ===== 对外 API =====

/** Enter 回包 / 已接收 push：记录该好友地块的完整语义基线。 */
function recordLandsBaseline(hostGid, lands, now = Date.now()) {
  const host = toNum(hostGid);
  const list = Array.isArray(lands) ? lands : [];
  if (!host || list.length === 0) return;
  let landMap = baselines.get(host);
  if (!landMap) {
    landMap = new Map();
    baselines.set(host, landMap);
  }
  for (const land of list) {
    const landId = toNum(land && land.id);
    if (!landId) continue; // 基线必须带真实地块 id，否则丢弃
    landMap.set(landId, { norm: normalizeLand(land), at: now });
  }
  pruneBaselines(now);
}

/**
 * 写操作发请求前登记 pending ticket，并**冻结**写前基线与采样时刻。
 * 没有写前基线的地块永不抑制（即使后续回包确认）。
 * 返回 ticketId（0 = 无有效内容，不登记）。
 */
function registerPendingWrite(op, hostGid, landIds, now = Date.now()) {
  const host = toNum(hostGid);
  const ids = (Array.isArray(landIds) ? landIds : [landIds])
    .map(toNum).filter(x => x > 0);
  pruneTickets(now);
  if (!host || ids.length === 0) return 0;
  const id = ++ticketSeq;
  const landMap = baselines.get(host);
  const beforeByLand = new Map();
  for (const landId of ids) {
    const snap = landMap && landMap.get(landId);
    if (snap && now - snap.at <= BASELINE_TTL_MS) {
      beforeByLand.set(landId, { norm: snap.norm, at: snap.at });
    }
  }
  tickets.set(id, {
    id,
    generation,
    op,
    hostGid: host,
    landIds: ids,
    state: 'pending',
    at: now,                 // TTL 起算
    sampleAt: now,           // 成熟推算用的写前采样时刻
    // landId -> 冻结的写前规范化基线（缺失 = 无证据，永不抑制）
    beforeByLand,
    // landId -> 回包确认的规范化后地块状态
    postByLand: new Map(),
    // landId -> 已吸收的推送次数
    absorbed: new Map(),
  });
  return id;
}

/**
 * RPC 成功回包确认：只登记回包里实际出现的地块（协议字段是 reply.land，
 * repeated）。回包缺地块/空回包 = 无证据，不确认也不抑制（该地块推送照常
 * 放行）。stop 之后到达的旧回包查无此票，自然失效（序号不复用）。
 */
function confirmWrite(ticketId, replyLands, now = Date.now()) {
  const t = tickets.get(ticketId);
  if (!t || t.generation !== generation) return;
  const list = Array.isArray(replyLands) ? replyLands : [];
  for (const land of list) {
    const landId = toNum(land && land.id);
    if (!landId || !t.landIds.includes(landId)) continue;
    t.postByLand.set(landId, normalizeLand(land));
  }
  if (t.postByLand.size > 0) {
    t.state = 'confirmed';
    t.at = now; // 确认时刻起算 CONFIRMED_TTL
  } else {
    // 成功但无逐地块证据：撤销，不得当证据用。
    tickets.delete(ticketId);
  }
}

/** 失败/超时/单地块部分失败：立即撤销 ticket，不得抑制后续推送。 */
function revokeWrite(ticketId) {
  tickets.delete(ticketId);
}

/**
 * 分类一条 LandsNotify 推送里的地块（用 ticket 冻结的写前基线，不吃
 * 后续 push/Enter 刷新的全局基线）。返回 { echoLands, externalLands,
 * echoCount }（原对象引用，便于 worker 分流）。selfGid 未知（0）时全外部。
 */
function classifyPushLands(hostGid, lands, selfGid, now = Date.now()) {
  const host = toNum(hostGid);
  const list = Array.isArray(lands) ? lands : [];
  const self = toNum(selfGid);
  const echoLands = [];
  const externalLands = [];
  pruneTickets(now);
  pruneBaselines(now);

  for (const land of list) {
    let isEcho = false;
    const landId = toNum(land && land.id);
    if (host && self && landId) {
      const pushedNorm = normalizeLand(land);
      for (const t of tickets.values()) {
        if (t.hostGid !== host || !t.landIds.includes(landId)) continue;
        const absorbed = t.absorbed.get(landId) || 0;
        if (absorbed >= ECHO_BUDGET_PER_LAND) continue;

        // 写前基线必须来自本 ticket 冻结快照；没有就永不抑制。
        const before = t.beforeByLand.get(landId);
        if (!before) continue;

        // 成熟保护优先：可偷/新成熟/可能已跨成熟墙钟 → 放行。
        if (maturityRisk(t.op, before.norm, pushedNorm, now)) continue;

        let matched = false;
        if (t.state === 'confirmed' && CONFIRMED_ECHO_OPS.has(t.op)) {
          // 迟到回声：推送与同 ticket 已确认的逐地块回包状态完全相等，
          // 且写前→回包差异本身也是该操作的纯差异（回包可能同时携带
          // 好友成熟/施肥状态，不能只看字节相等就吞）。
          const post = t.postByLand.get(landId);
          matched = !!post && sameNorm(post, pushedNorm) &&
            isPureOperationDiff(t.op, before.norm, post, self);
        } else if (t.state === 'pending' && EARLY_ECHO_OPS.has(t.op)) {
          // 早到回声：仅放虫/放草/偷；推送相对冻结写前基线必须是纯自差异。
          matched = isPureOperationDiff(t.op, before.norm, pushedNorm, self);
        }
        if (matched) {
          t.absorbed.set(landId, absorbed + 1);
          isEcho = true;
          break;
        }
      }
    }
    if (isEcho) echoLands.push(land);
    else externalLands.push(land);
  }

  if (echoLands.length > 0) echoAbsorbedTotal += echoLands.length;
  return { echoLands, externalLands, echoCount: echoLands.length };
}

/** 受控状态观测（日志/测试用，不含 gid 明细）。 */
function stats() {
  return {
    baselineHosts: baselines.size,
    tickets: tickets.size,
    echoAbsorbedTotal,
  };
}

/** 停止/重启清理：全部丢弃；代次+1 防旧回包污染新 ticket。 */
function stop() {
  baselines.clear();
  tickets.clear();
  generation++;
  echoAbsorbedTotal = 0;
}

/** 仅测试用。 */
function resetForTest() {
  stop();
}

module.exports = {
  PENDING_TTL_MS,
  CONFIRMED_TTL_MS,
  BASELINE_TTL_MS,
  ECHO_BUDGET_PER_LAND,
  MATURITY_GUARD_SLACK_MS,
  recordLandsBaseline,
  registerPendingWrite,
  confirmWrite,
  revokeWrite,
  classifyPushLands,
  stats,
  stop,
  resetForTest,
  // 导出仅供测试直接验证规范化/纯差异/成熟保护
  normalizeLand,
  isPureOperationDiff,
  maturityRisk,
  phaseStateAtSnapshot,
  matureDeadlineSec,
  longToBigStr,
};
