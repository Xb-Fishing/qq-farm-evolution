/**
 * 好友在线自动捣乱调度（2026-09-26 第二版，Codex 主验收意见落地）。
 *
 * 第一版差异验收发现的六个结构性缺陷与本版修复：
 * 1. 证据响应：不再等 tick 轮询发现 online——订阅 friend-activity 的
 *    onOnlineEvidence（at_home/lands_push/presence_online 已证实在线源），
 *    证据到达即唤醒定时器；仅名单目标响应，stop 取消订阅。零新增游戏请求。
 * 2. 重试风暴：会话带独立 retryNotBefore——新鲜在线证据拉近 nextAt 时
 *    以 retryNotBefore 为下界，零成功的指数退避不会被证据拉回秒级；
 *    failCount 只在真实放成（虫或草 ≥1）后清零。
 * 3. stop/restart 竞态：generation 栅栏——旧代 tick 的迟到写状态、迟到
 *    挂定时器全部作废；与 checkFriends/watchlist 巡田互斥（双方都查
 *    对方的运行标志），避免同时 Enter 串农场。
 * 4. 写动作守卫：进门后、每种写动作（放虫/放草各自）前复查 guard
 *    （暂停/免打扰/静默/额度/让步/名单移除/黑名单/代际失效），翻转即停。
 * 5. 会话语义：done 只在真实放成 ≥1 后置位（虫成功草失败=部分成功，
 *    每项结果与原因码在日志里独立可见，也算完成）；done 后短暂离线
 *    （连续 at_home=false，秒级~分钟级）不重置——本地首见离线观测
 *    持续 ≥3 分钟、或服务端离线时刻确证 ≥3 分钟且晚于本会话完成时刻
 *    才开新会话（对齐旧规则"离线后再上线才新会话"）；在线证据清掉
 *    离线观测时刻；持续在线只续期探测。
 * 6. 发现探测：显式名单是无推送目标唯一可行的在线发现手段，用户定标
 *    收紧到 10-15s/目标，全局单探测节奏（相邻探测进门至少间隔
 *    PROBE_GLOBAL_GAP_MS）分散请求；额度耗尽只停写动作，探测照常
 *    （观察层零写，badRemaining 仅约束放虫草写额度）。
 *
 * 延迟上界（必须诚实）：证据唤醒只在已有可靠在线证据时零排队
 * （0.3-1.5s 出手）；无推送目标靠 10-15s 探测发现，多目标在全局节奏
 * 下依次轮到、且与重点快档/HOT/PREARM/抢收让步共用通信预算——
 * 实际延迟上界不保证零延迟。
 */

const {
  getAutoBadFriendGids,
  getFriendBlacklist,
  getPauseRemainMs,
} = require('../models/store');
const { getUserState, isConnected } = require('../utils/network');
const { toNum, log, randomDelay } = require('../utils/utils');
const {
  stealIsDue,
  stealIsImminent,
  ownHarvestIsDue,
  ownHarvestIsImminent,
  gaussianInt,
} = require('../utils/behavior');
const { inFriendQuietHours } = require('./friend-api');
const { getBadRemainingTimes } = require('./friend-operation-limits');
const friendActivity = require('./friend-activity');
const { visitFriendForAutoBad } = require('./friend-visit');
const { createScheduler } = require('./scheduler');

// 与 friend-orchestrator 的 OWN_HARVEST_RESERVE_MS / watchlist 让步窗口同值
const OWN_HARVEST_RESERVE_MS = 10_000;
const STEAL_IMMINENT_WINDOW_MS = 1_200;

const TICK_MS = 3_000;
const EMPTY_TICK_MS = 30_000;
// 发现探测（用户定标 2026-09-26 收紧）：10-15s/目标进门一次
const PROBE_MIN_MS = 10_000;
const PROBE_MAX_MS = 15_000;
// 全局单探测节奏：相邻两个探测进门至少间隔 2s，多目标在硬预算下分散
const PROBE_GLOBAL_GAP_MS = 2_000;
// 会话完成后：放宽到 5-8 分钟探测离线（持续在线不重复触发）
const DONE_PROBE_MIN_MS = 5 * 60_000;
const DONE_PROBE_MAX_MS = 8 * 60_000;
// 零执行退避：60s 起指数，10 分钟封顶（4 步）；证据唤醒不得越过该下界
const BACKOFF_BASE_MS = 60_000;
const BACKOFF_MAX_MS = 10 * 60_000;
const BACKOFF_MAX_STEPS = 4;
// 新鲜在线证据（at_home/lands_push）命中：拉近到 0.3-1.5s 后处理
const EVIDENCE_DISPATCH_MIN_MS = 300;
const EVIDENCE_DISPATCH_MAX_MS = 1_500;
// 守卫翻转（让步/暂停）中止后的保守重试间隔：不计数、不退避
const ABORT_RETRY_MIN_MS = 5_000;
const ABORT_RETRY_MAX_MS = 15_000;
// 旧规则语义：离线确证 ≥3 分钟后再上线才算新会话
const OFFLINE_RESUME_MS = 3 * 60_000;
// 证据唤醒重挂定时器的延迟
const WAKE_DELAY_MS = 300;

// ===== 全好友观察层（2026-09-26 用户定标：在线检测面向全部好友）=====
// 只读采样：Enter 回包即 presence 证据（allowPlace=false 零写），为未开启
// autoBad 的好友生产在线证据；autoBad 开启者仍走上面 10-15s 快档 + 证据唤醒，
// 观察层只是兜底覆盖（含 quota 耗尽/done 时快档停摆的目标）。
// 全局硬限速（第二轮审查定稿）：所有"无新鲜在线证据、需先 Enter 探明"的
// 盲探测——动作档与观察层共用同一个 5s 派发槽，在实际发起处占槽，
// 一次 tick 至多一个盲 Enter；已知新鲜证据的动作唤醒可优先（不占盲槽，
// 但仍受串行锁/每目标节奏/退避约束）。scheduleProbe 的未来错峰不冒充
// 发起限速。
const OBSERVE_GLOBAL_GAP_MS = 5_000;
// 已有新鲜真实观测（动作快档或观察层刚 Enter 过）的目标本轮跳过——
// 跳过只推进游标，绝不伪更新 lastProbeAt（否则永不重采）
const OBSERVE_FRESH_SKIP_MS = 10_000;
// 观察进门失败额外退避（叠加在全局间隔上）
const OBSERVE_FAIL_EXTRA_MS = 5_000;
// 名册有界刷新：冷缓存/长期无人刷新时最多 30min 强制拉一次；失败 5min 退避重试
const ROSTER_REFRESH_MS = 30 * 60_000;
const ROSTER_FAIL_RETRY_MS = 5 * 60_000;

const scheduler = createScheduler('friend-auto-bad');
let armed = false;
// 实际串行锁：一次只允许一个调度体在途（跨代也要串行——旧代 in-flight
// 的 Enter 未返回前，新代不得再发 Enter，否则并发进门串农场）
let inFlightBody = Promise.resolve();
// 在途票据计数：入队即 +1、自身 finally -1（stop/start 不伪清）。
// 只要还有排队或正在执行的调度体未 settle，isAutoBadRunning 就为 true
let pendingBodies = 0;
// stop/restart 栅栏：旧代 tick 不得写状态/挂定时器
let generation = 0;
// gid -> { done, doneAt, offlineObservedAt, failCount, nextAt, retryNotBefore }
const autoBadSessions = new Map();
// 全局探测节奏游标：下一个探测进门最早可排的时刻
let nextProbeSlotAt = 0;
// ===== 观察层状态（stop 一并清零，账号/代次间不残留）=====
// gid -> 上次真实 Enter 发起时刻（动作快档与观察层共用，防重复进门）
const lastProbeAt = new Map();
// 稳定 gid 后继游标：上一次派发观察的目标 gid（0=从头开始）。按 gid 找
// 后继而非数组下标——名单重排/新增低 ID/删除当前 ID 都不饿死任何好友
let observeCursorGid = 0;
// 动作档同规则游标：5s 盲槽下一 tick 只派发一个，名单头部目标不得
// 持续抢占排在后面的到期目标
let actionCursorGid = 0;
// 跨组公平（第三轮审查）：连续盲动作探测计数——每最多 2 次盲动作探测后，
// 下一个盲槽必须让给普通名册观察（observe 派发时清零）。已有真实在线
// 证据的动作唤醒不受此限（不占盲槽）。防止多个持续离线的 autoBad 目标
// 占尽每个 5s 槽把普通好友饿死。
let blindActionsSinceObserve = 0;
// 下一个盲 Enter 最早可发起时刻（动作盲探测与观察共用，硬间隔 ≥5s）
let nextBlindEnterAt = 0;
// 名册（全部好友 gid，升序去重）与其刷新状态
let rosterGids = [];
let rosterFetchedAt = 0;
let rosterRetryNotBefore = 0;
// friend-activity 在线证据订阅取消函数（stop 时必须取消）
let unsubscribeOnlineEvidence = null;

// 生产依赖（core/test 注入替身用；字段即调度必须遵守的守卫全集）
const deps = {
  now: () => Date.now(),
  gids: () => (getAutoBadFriendGids(process.env.FARM_ACCOUNT_ID || '') || []).map(toNum).filter(Boolean),
  myGid: () => getUserState().gid,
  connected: () => isConnected(),
  badRemaining: () => getBadRemainingTimes(),
  badPaused: () => require('./friend-orchestrator').isFriendBadPaused(),
  // 与 checkFriends/watchlist 巡田互斥：任一在途即让出（防同时 Enter 串农场）
  checking: () => require('./friend-orchestrator').isFriendVisitBusy(),
  paused: () => getPauseRemainMs(process.env.FARM_ACCOUNT_ID || '') > 0,
  quietHours: () => inFriendQuietHours(),
  blacklist: () => new Set(getFriendBlacklist(process.env.FARM_ACCOUNT_ID || '')),
  stealDue: () => stealIsDue(),
  stealImminent: () => stealIsImminent(STEAL_IMMINENT_WINDOW_MS),
  harvestDue: () => ownHarvestIsDue(),
  harvestImminent: () => ownHarvestIsImminent(OWN_HARVEST_RESERVE_MS),
  online: gid => friendActivity.isFriendOnlineRecently(gid),
  visit: (friend, tally, myGid, options) => visitFriendForAutoBad(friend, tally, myGid, options),
  delay: (min, max) => randomDelay(min, max),
  // 观察层名册（第三轮审查定稿）：消费 friend-api 只读名册快照
  // （getAllFriends 真实成功出口记录，失败不写快照）：
  //  - null  = 从未成功拉取过 → 允许有界强制拉取
  //  - []    = 权威空表（好友全部删除）→ 清空名册，绝不继续探测旧人
  //  - 数组  = 上次真实成功时的权威快照（后台任何 getAllFriends 成功即时更新）
  // 不再用 land-analyzer 的 UI 缓存——它无法区分"刷新失败沿用旧缓存"与
  // "刷新成功"，会把失败当成功推迟 30 分钟。
  rosterCache: () => {
    const { getRosterSnapshot } = require('./friend-api');
    const snap = getRosterSnapshot();
    return snap ? snap.gids : null;
  },
  // 强制拉取名册：getAllFriends 失败会 throw → 走退避，不会误报成功
  fetchRoster: async () => {
    const { getAllFriends, getRosterSnapshot } = require('./friend-api');
    await getAllFriends();
    const snap = getRosterSnapshot();
    return snap ? snap.gids : null;
  },
};

function backoffMs(failCount) {
  return Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (Math.max(0, failCount) - 1));
}

function getSession(gid) {
  let session = autoBadSessions.get(gid);
  if (!session) {
    // 初次编入按名单规模错开，避免多目标同拍进门
    session = { done: false, doneAt: 0, offlineObservedAt: 0, failCount: 0, nextAt: 0, retryNotBefore: 0 };
    autoBadSessions.set(gid, session);
  }
  return session;
}

/** 探测类排程统一走全局单探测节奏（相邻探测进门至少间隔 GAP）。 */
function scheduleProbe(session, now, minMs, maxMs) {
  const at = now + gaussianInt(minMs, maxMs);
  const slot = Math.max(at, nextProbeSlotAt);
  nextProbeSlotAt = slot + PROBE_GLOBAL_GAP_MS;
  session.nextAt = slot;
}

/** 证据拉近：只提前不推迟，且不得越过失败退避下界 retryNotBefore。 */
function pullByEvidence(session, now) {
  const pull = Math.max(session.retryNotBefore || 0,
    now + gaussianInt(EVIDENCE_DISPATCH_MIN_MS, EVIDENCE_DISPATCH_MAX_MS));
  if (pull < session.nextAt) session.nextAt = pull;
}

function tickDelayMs(now) {
  let earliest = 0;
  for (const session of autoBadSessions.values()) {
    if (session.nextAt > now && (!earliest || session.nextAt < earliest)) earliest = session.nextAt;
  }
  // 观察层节奏也参与最早唤醒计算（受 EMPTY_TICK_MS 上限约束）：
  // 槽位空闲即 500ms 后再试（名册在但全被新鲜跳过时按最近过期时刻醒，
  // 不空转 30s 也不把"未探测"当成功长睡）
  if (rosterGids.length > 0) {
    let observeNext = nextBlindEnterAt > now ? nextBlindEnterAt : now + 500;
    for (const gid of rosterGids) {
      const freshUntil = (lastProbeAt.get(gid) || 0) + OBSERVE_FRESH_SKIP_MS;
      if (freshUntil > now && freshUntil < observeNext) observeNext = freshUntil;
    }
    if (!earliest || observeNext < earliest) earliest = observeNext;
  }
  if (!earliest) return EMPTY_TICK_MS;
  return Math.min(EMPTY_TICK_MS, Math.max(500, earliest - now));
}

/** 观察目标的只读守卫：与写动作守卫分离——不含 autoBad 开关/写额度/
 * done 等写侧条件；stop/restart、断线、暂停/quiet、黑名单变更、
 * 抢收/自收让步在 Enter 在途时要能拦下后续行为。 */
function makeObserveGuard(gid, gen) {
  return () => gen === generation
    && deps.connected()
    && !deps.paused() && !deps.quietHours()
    && !deps.checking()
    && !deps.stealDue() && !deps.stealImminent()
    && !deps.harvestDue() && !deps.harvestImminent()
    && gid !== deps.myGid()
    && !deps.blacklist().has(gid);
}

/** 会话目标的写动作守卫：进门后与每种写动作前都要复查。 */
function makeGuard(gid, gen) {
  return () => gen === generation
    && !deps.badPaused() && !deps.paused() && !deps.quietHours()
    && deps.badRemaining() > 0
    && !deps.stealDue() && !deps.stealImminent()
    && !deps.harvestDue() && !deps.harvestImminent()
    && deps.gids().includes(gid)
    && gid !== deps.myGid()
    && !deps.blacklist().has(gid);
}

/** 单次调度体（无定时器副作用），tick 与测试共用。gen 用于栅栏检查。
 * 真实串行锁：跨 stop/start 也要等上一个 in-flight visit settle 才发下一
 * 个 Enter（并发进门会串农场）；锁的释放跟着实际执行的那一代走。 */
async function runTickBody(gen = generation) {
  const prior = inFlightBody;
  let releasePrior;
  inFlightBody = new Promise(resolve => { releasePrior = resolve; });
  pendingBodies += 1; // 排队即占票据：等锁阶段也在途
  try {
    await prior.catch(() => { }); // 旧代 visit 未 settle 前不得另起 Enter
    await tickBodyInner(gen);
  } finally {
    pendingBodies -= 1; // 各自 finally 只减自己的票据，锁必然释放
    releasePrior();
  }
}

/** 动作档（原 tickBodyInner 主体）：名单目标探测/放虫草。返回 true 表示
 * 代次栅栏命中，调用方不得再跑观察层。 */
async function runActionPass(gen, now, gids, myGid, blacklist) {
  // gid 后继轮转起点：与观察层同规则，低 gid 不得在盲槽模式下饿死他人
  const ordered = gids.filter(g => g > actionCursorGid).concat(gids.filter(g => g <= actionCursorGid));
  for (const gid of ordered) {
      if (gen !== generation) return; // stop/restart 栅栏：旧代不得继续写
      if (gid === myGid || blacklist.has(gid)) continue;
      const session = getSession(gid);
      if (!session.nextAt) {
        session.nextAt = now + gaussianInt(500, 500 + 1_500 * Math.min(gids.length, 10));
      }
      // 新鲜在线证据 → 拉近处理（受 retryNotBefore 下界约束，见 pullByEvidence）
      if (!session.done && session.nextAt > now && deps.online(gid)) {
        pullByEvidence(session, now);
      }
      if (session.nextAt > now) continue;
      // 抢收/自己收获让步：不消耗机会，下轮再试
      if (deps.stealDue() || deps.harvestImminent()) break;

      // 盲探测全局派发槽（第二轮审查）：无新鲜在线证据、需先 Enter 探明
      // 的目标在实际发起处占 5s 槽，一次 tick 至多一个盲 Enter——
      // 初始列表/批量到期/失败重排都不允许集中进门。已知新鲜在线证据
      // 的动作唤醒优先（不占盲槽），但仍串行、仍受每目标节奏与退避约束。
      // 槽被占时 continue 而非 break：排在后面的已知在线目标仍可优先动作。
      const blindEnter = !deps.online(gid);
      if (blindEnter && now < nextBlindEnterAt) continue;
      // 跨组公平（第三轮审查）：连续 2 次盲动作探测后，本拍盲动作让位，
      // 把下一个 5s 槽留给观察层（防多个离线 autoBad 目标饿死普通好友）；
      // 名册为空时无竞争组，不启用让位。已知在线证据的动作不受此限
      // 跨组公平让位仅在观察层此刻真有合格候选（非自身/黑名单/10s 新鲜/
      // 已有在线证据，与 runObservePass 跳过口径一致）时生效——名册全部
      // 不合格时让位等于盲动作被 streak>=2 永久挡死（不靠伪更新
      // lastProbeAt 解锁）。已知在线证据的动作不受此限
      if (blindEnter && blindActionsSinceObserve >= 2
        && observeHasCandidate(deps.now(), myGid, deps.blacklist())) continue;

      const dispatchNow = deps.now();
      const tally = { steal: 0, water: 0, weed: 0, bug: 0, putBug: 0, putWeed: 0 };
      lastProbeAt.set(gid, dispatchNow); // 动作档真实发起：观察层据此 10s 内跳过
      actionCursorGid = gid; // 派发后游标推进到本目标，下轮从后继开始
      if (blindEnter) {
        nextBlindEnterAt = dispatchNow + OBSERVE_GLOBAL_GAP_MS;
        blindActionsSinceObserve += 1;
      }
      const result = await deps.visit({ gid, name: `GID:${gid}` }, tally, myGid,
        { allowPlace: !session.done, guard: makeGuard(gid, gen) });
      const visitedAt = deps.now();
      if (gen !== generation) return; // 停止/重启后旧结果作废，不写状态

      // 先结算真实成功：守卫中途翻转（aborted）不得丢掉已放成的虫/草，
      // 已成功 ≥1 即完成本会话，恢复后绝不重放
      const placed = (result.bug || 0) + (result.weed || 0);
      if (placed > 0) {
        session.done = true;
        session.doneAt = visitedAt;
        session.offlineObservedAt = 0; // 成功即清离线观测
        session.failCount = 0; // 只有真实成功才清退避计数
        scheduleProbe(session, visitedAt, DONE_PROBE_MIN_MS, DONE_PROBE_MAX_MS);
        log('好友', `在线自动捣乱会话完成（放虫${result.bug}/放草${result.weed}）`, {
          module: 'friend',
          event: 'auto_bad_session_done',
          friendGid: gid,
          putBug: result.bug,
          putWeed: result.weed,
          ...(result.aborted ? { partial: true } : {}),
        });
      }
      if (result.aborted) {
        // 守卫翻转（让步/暂停/移出名单/代际失效）中止：不计数、不退避。
        // 已有成功则会话已按上面完成；零成功才短间隔重试（守卫恢复即继续）
        if (placed === 0) {
          session.nextAt = visitedAt + gaussianInt(ABORT_RETRY_MIN_MS, ABORT_RETRY_MAX_MS);
        }
        continue;
      }
      if (!result.entered) {
        // 进门失败：退避，不消耗机会
        session.failCount = Math.min(BACKOFF_MAX_STEPS, session.failCount + 1);
        session.retryNotBefore = session.nextAt = visitedAt + backoffMs(session.failCount);
        continue;
      }
      if (!result.online) {
        // 探测观察到不在场。done 会话不因短暂离线重置（旧规则：离线确证
        // ≥3 分钟后才算新会话）。两条确证路径，任一成立才复位：
        //  a) 本地首见离线时刻 offlineObservedAt 距今 ≥3 分钟；
        //  b) 服务端离线时刻 offlineSince 确证 ≥3 分钟，且离线发生在本会话
        //     完成之后（doneAt）——远古 last_online 不能让刚成功的会话复位
        if (!session.offlineObservedAt) session.offlineObservedAt = visitedAt;
        const locallyConfirmed = visitedAt - session.offlineObservedAt >= OFFLINE_RESUME_MS;
        const offlineSince = Number(result.offlineSinceMs) || 0;
        const serverConfirmed = offlineSince > 0
          && visitedAt - offlineSince >= OFFLINE_RESUME_MS
          && (!session.doneAt || offlineSince >= session.doneAt);
        if (!session.done || locallyConfirmed || serverConfirmed) {
          session.done = false;
          session.doneAt = 0;
          session.offlineObservedAt = 0;
          session.failCount = 0;
          scheduleProbe(session, visitedAt, PROBE_MIN_MS, PROBE_MAX_MS);
        } else {
          scheduleProbe(session, visitedAt, DONE_PROBE_MIN_MS, DONE_PROBE_MAX_MS);
        }
        continue;
      }
      session.offlineObservedAt = 0; // 真实在线证据清掉离线观测时刻
      if (session.done) {
        if (placed > 0) {
          // 本次刚放成：多目标分散后再继续
          await deps.delay(800, 1500);
          if (gen !== generation) return;
        } else {
          // 会话早已完成且持续在线：不重复触发，保持放宽探测
          scheduleProbe(session, visitedAt, DONE_PROBE_MIN_MS, DONE_PROBE_MAX_MS);
        }
        continue;
      }
      // 在线但零执行（无地块/单项额度/服务端拒绝）：不消耗 done 机会，
      // 计入指数退避；证据唤醒不得越过 retryNotBefore（防重试风暴）
      session.failCount = Math.min(BACKOFF_MAX_STEPS, session.failCount + 1);
      session.retryNotBefore = session.nextAt = visitedAt + backoffMs(session.failCount);
  }
  return false;
}

async function tickBodyInner(gen) {
  const now = deps.now();
  const gids = deps.gids();
  // 配置收缩：清理已移除目标的会话状态
  for (const gid of [...autoBadSessions.keys()]) {
    if (!gids.includes(gid)) autoBadSessions.delete(gid);
  }
  const myGid = deps.myGid();
  if (!myGid || !deps.connected()) return;
  // 共同守卫（动作与观察同守）：全局暂停、免打扰、静默时段、与
  // checkFriends/watchlist 互斥、抢收/自收让步。观察层只读不消耗任何
  // 写额度——badRemaining=0/badPaused/名单为空时观察仍继续（零写），
  // 动作档自己的 80 预算闸在 runActionPass 前。
  if (deps.paused() || deps.quietHours()) return;
  if (deps.checking()) return;
  if (deps.stealDue() || deps.stealImminent() || deps.harvestDue() || deps.harvestImminent()) return;

  const blacklist = deps.blacklist();
  // 动作档：捣乱暂停、名单为空或额度耗尽时无动作（零写请求），
  // 但下面的观察层继续（只读）。badRemaining 是每日放虫草写额度，只限写，
  // 不挡只读检测；读与写的实际通信量都继续受既有网络治理层约束
  if (gids.length > 0 && !deps.badPaused() && deps.badRemaining() > 0) {
    if (await runActionPass(gen, now, gids, myGid, blacklist)) return;
  }
  await runObservePass(gen, myGid);
}

/** 名册维护（三态契约，见 deps.rosterCache 注释）：
 * 缓存权威快照（含空表）直接采用；未知或超过 30min 无权威更新时
 * 有界强制拉取，失败 5min 退避重试（冷读失败不会永远不重试）；
 * 拉取在途先占退避位防重复触发，stop 后迟到回填被代次栅栏拦下。 */
function refreshRoster(now) {
  const cached = typeof deps.rosterCache === 'function' ? deps.rosterCache() : null;
  if (Array.isArray(cached)) {
    // 权威快照（空数组=好友全部删除，同样采纳——绝不继续探测删掉的旧人）
    rosterGids = cached;
    if (!rosterFetchedAt) rosterFetchedAt = now;
    if (now - rosterFetchedAt < ROSTER_REFRESH_MS) return;
    // 权威快照过老（30min 无人刷新）：走下面有界强制拉取
  }
  if (!armed || typeof deps.fetchRoster !== 'function' || now < rosterRetryNotBefore) return;
  // 先占退避位再发起：异步在途期间 tick 不会重复触发拉取
  const gen = generation;
  rosterRetryNotBefore = now + ROSTER_FAIL_RETRY_MS;
  deps.fetchRoster().then((list) => {
    if (gen !== generation) return; // stop 后迟到结果不写状态
    if (Array.isArray(list)) {
      rosterGids = list;
      rosterFetchedAt = deps.now();
      rosterRetryNotBefore = rosterFetchedAt + ROSTER_REFRESH_MS;
    }
    // null=读取失败：退避位已占位，期间旧名册继续用
  }).catch(() => {
    // 失败退避：rosterRetryNotBefore 已占位
  });
}

/** 观察层此刻是否存在合格候选：与 runObservePass 的逐项跳过条件同口径
 * （自身/黑名单/10s 内新鲜真实观测/已有在线证据）。跨组公平让位据此
 * 判断，避免名册全不合格时盲动作被永久挡死。 */
function observeHasCandidate(now, myGid, blacklist) {
  if (rosterGids.length === 0) return false;
  if (now < nextBlindEnterAt) return false; // 槽忙时观察同样派不出去，无需让位
  return rosterGids.some(gid => gid !== myGid && !blacklist.has(gid)
    && now - (lastProbeAt.get(gid) || 0) >= OBSERVE_FRESH_SKIP_MS
    && !deps.online(gid));
}

/** 稳定 gid 后继：从 cursorGid 之后找第一个合格目标（绕回到最小 gid）。
 * 跳过（自身/黑名单/10s 内新鲜真实观测）只发生在本轮扫描内，
 * 绝不伪更新 lastProbeAt；派发成功才推进 cursorGid。 */
async function runObservePass(gen, myGid) {
  const now = deps.now();
  refreshRoster(now);
  if (rosterGids.length === 0) return;
  if (now < nextBlindEnterAt) return;
  if (gen !== generation) return;
  // 动作档可能刚 await 过：发起前用**当前**状态复查（黑名单取新快照而非
  // 动作档开始时的旧引用；含断线复查）。不查 badRemaining/badPaused——
  // 观察只读，不受写侧条件拦截
  if (!deps.connected() || deps.paused() || deps.quietHours() || deps.checking()
    || deps.stealDue() || deps.stealImminent()
    || deps.harvestDue() || deps.harvestImminent()) return;
  const blacklist = deps.blacklist();
  const start = observeCursorGid;
  const order = rosterGids.filter(g => g > start).concat(rosterGids.filter(g => g <= start));
  for (const gid of order) {
    if (gid === myGid || blacklist.has(gid)) continue;
    // 10s 内已有真实观测（本模块 Enter 或既有巡查/快档的在线证据）跳过——
    // 重点/普通巡查刚确认在线的目标不重复 Enter；跳过不伪更新 lastProbeAt
    if (now - (lastProbeAt.get(gid) || 0) < OBSERVE_FRESH_SKIP_MS) continue;
    if (deps.online(gid)) continue;
    // 真实发起：占盲探测全局槽 + 记真实观测时刻（动作档 dispatch 处同样记录）
    const dispatchNow = deps.now();
    nextBlindEnterAt = dispatchNow + OBSERVE_GLOBAL_GAP_MS;
    lastProbeAt.set(gid, dispatchNow);
    observeCursorGid = gid;
    blindActionsSinceObserve = 0; // 跨组公平计数复位：观察拿到了槽
    const tally = { steal: 0, water: 0, weed: 0, bug: 0, putBug: 0, putWeed: 0 };
    // 独立只读守卫：Enter 在途期间 stop/断线/暂停/黑名单变更可拦后续行为
    const result = await deps.visit({ gid, name: `GID:${gid}` }, tally, myGid,
      { allowPlace: false, guard: makeObserveGuard(gid, gen) });
    const doneAt = deps.now();
    if (gen !== generation) return; // 旧代迟到结果不写任何状态
    // 观察进门失败额外退避（叠加全局间隔）；成功从完成时刻重计硬间隔
    nextBlindEnterAt = Math.max(nextBlindEnterAt,
      doneAt + (result && result.entered ? OBSERVE_GLOBAL_GAP_MS : OBSERVE_GLOBAL_GAP_MS + OBSERVE_FAIL_EXTRA_MS));
    // 采样结果日志（第三轮审查，用户手机自测线索）：只记本机受控
    // gid 关联、是否取得在线证据与固定原因码。onlineEvidence 是合并口径
    // （本次 at_home + 10s 窗口内其它已证实在线证据），不等于"本次农场
    // 在场"；本次 Enter 回包实际解码出的在场位单独记 atHome，
    // atHomeDecoded=false 时 atHome=null（未解码，不伪称在场/不在场）。
    // 每 5s 盲槽至多一条，跳过的 tick 不刷。
    const entered = !!(result && result.entered);
    const onlineEvidence = !!(result && result.online);
    const atHomeDecoded = !!(result && result.atHomeDecoded);
    const atHome = atHomeDecoded ? !!(result && result.atHome) : null;
    // 文案只描述本次采样（单目标），GID 方便用户关联具体目标；
    // 不声称离线——缺字段=未返回在场标志，显式 false=本次未取得在场证据
    const atHomeText = !atHomeDecoded ? '未返回在场标志'
      : atHome ? '目标在场' : '本次未取得在场证据';
    log('好友', `全好友观察采样 GID:${gid} → ${entered
      ? `${atHomeText}（在线证据: ${onlineEvidence ? '有' : '无'}）`
      : '进门失败'}`, {
      module: 'friend',
      event: 'friend_observe_sample',
      accountId: String(process.env.FARM_ACCOUNT_ID || ''), // 本机合并日志区分观察账号（运行时取值）
      result: entered ? (onlineEvidence ? 'ok' : 'zero') : 'error',
      friendGid: gid,
      reason: (result && result.reason) || null,
      onlineEvidence,
      // 键名避开 logger 敏感字正则（*code* 会被整值 REDACTED）
      atHomeSeen: atHomeDecoded,
      atHome,
      sampledAt: doneAt,
    });
    return; // 一次 tick 最多一个观察
  }
}

async function tick() {
  const gen = generation;
  if (!armed || gen !== generation) return;
  try {
    await runTickBody(gen);
  } catch {
    // 调度异常只记固定原因码（不透传 raw err，防日志泄露），状态保持下轮重试
    log('好友', '在线自动捣乱调度异常', {
      module: 'friend',
      event: 'auto_bad_tick_error',
      result: 'error',
      reason: 'tick_error',
    });
  } finally {
    if (armed && gen === generation) {
      scheduler.setTimeoutTask('auto_bad_poll', tickDelayMs(deps.now()), () => tick());
    }
  }
}

/**
 * 在线证据到达即唤醒（2026-09-26 验收核心修复）：不再等 tick 轮询。
 * 只响应名单内、未完成的目标；不新增任何游戏请求。
 * 无会话（首次编入）或 nextAt 已到期的目标也要唤醒——否则要等最长
 * 30s 的空档定时器；退避锁内（retryNotBefore 未到）的目标拉近被
 * pullByEvidence 的下界挡住，新证据不能穿透退避。
 */
function handleOnlineEvidence(gid) {
  if (!armed) return;
  const id = toNum(gid);
  if (!deps.gids().includes(id)) return; // 仅名单目标
  const session = autoBadSessions.get(id);
  if (session && session.done) return; // 已完成会话不再出手
  if (session) {
    session.offlineObservedAt = 0; // 在线证据清掉离线观测时刻
    pullByEvidence(session, deps.now());
  }
  // 重挂短定时器（旧长定时器被覆盖）；tick/runTickBody 自带串行锁，
  // 当前 Enter 未 settle 时不会另起并发进门
  scheduler.clear('auto_bad_poll');
  scheduler.setTimeoutTask('auto_bad_poll', WAKE_DELAY_MS, () => tick());
}

function startAutoBadLoop() {
  if (armed) return;
  armed = true;
  generation += 1;
  if (!unsubscribeOnlineEvidence) {
    unsubscribeOnlineEvidence = friendActivity.onOnlineEvidence(handleOnlineEvidence);
  }
  scheduler.setTimeoutTask('auto_bad_poll', TICK_MS, () => tick());
}

function stopAutoBadLoop() {
  // 先升代际再清：旧代 in-flight visit 的迟到写全部被栅栏拦下。
  // pendingBodies 不清零——stop 不假装旧网络请求已完成，等旧代
  // visit 真正 settle 时由它自己的 finally 释放（isAutoBadRunning 如实
  // 报告在途，orchestrator 侧互斥不提前放行）
  generation += 1;
  armed = false;
  autoBadSessions.clear();
  nextProbeSlotAt = 0;
  // 观察层状态一并清零：账号/代次间不残留游标、名册与真实观测时刻
  lastProbeAt.clear();
  observeCursorGid = 0;
  actionCursorGid = 0;
  blindActionsSinceObserve = 0;
  nextBlindEnterAt = 0;
  rosterGids = [];
  rosterFetchedAt = 0;
  rosterRetryNotBefore = 0;
  if (unsubscribeOnlineEvidence) {
    unsubscribeOnlineEvidence();
    unsubscribeOnlineEvidence = null;
  }
  scheduler.clearAll();
}

module.exports = {
  runTickBody,
  startAutoBadLoop,
  stopAutoBadLoop,
  isAutoBadLoopArmed: () => armed,
  // 在途 = 有排队或正在执行的调度体未 settle（含 stop 后旧代 visit 收尾阶段）
  isAutoBadRunning: () => pendingBodies > 0,
  getSessionStateForTests: gid => ({ ...(autoBadSessions.get(toNum(gid)) || { done: false, failCount: 0, nextAt: 0, retryNotBefore: 0 }) }),
  sessionCountForTests: () => autoBadSessions.size,
  // 强制下一拍到期（仅测试：模拟证据把探测拉到秒级的短间隔离线观测）
  __setNextAtForTests: (gid, at) => { const s = autoBadSessions.get(toNum(gid)); if (s) s.nextAt = at; },
  __depsForTests: deps,
  __observeStateForTests: () => ({
    cursorGid: observeCursorGid,
    nextBlindEnterAt,
    rosterGids: [...rosterGids],
    lastProbeAt: Object.fromEntries(lastProbeAt),
  }),
  // 常量暴露给测试断言边界
  OBSERVE_GLOBAL_GAP_MS,
  OBSERVE_FRESH_SKIP_MS,
  PROBE_MIN_MS,
  PROBE_MAX_MS,
  PROBE_GLOBAL_GAP_MS,
  DONE_PROBE_MIN_MS,
  DONE_PROBE_MAX_MS,
  BACKOFF_BASE_MS,
  BACKOFF_MAX_MS,
  OFFLINE_RESUME_MS,
  EVIDENCE_DISPATCH_MAX_MS,
};
