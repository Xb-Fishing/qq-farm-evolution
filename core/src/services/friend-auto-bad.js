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
 *    PROBE_GLOBAL_GAP_MS）分散请求；额度耗尽连探测也停（零请求）。
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
  if (!earliest) return EMPTY_TICK_MS;
  return Math.min(EMPTY_TICK_MS, Math.max(500, earliest - now));
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

async function tickBodyInner(gen) {
  const now = deps.now();
  const gids = deps.gids();
  // 配置收缩：清理已移除目标的会话状态
  for (const gid of [...autoBadSessions.keys()]) {
    if (!gids.includes(gid)) autoBadSessions.delete(gid);
  }
  const myGid = deps.myGid();
  if (gids.length === 0 || !myGid || !deps.connected()) return;
  // 名单是显式选择，不受全局帮助/捣乱开关与帮助经验上限牵连；
  // 全局暂停、免打扰、静默时段、每日额度仍生效（额度耗尽连探测也停）
  if (deps.badPaused() || deps.paused() || deps.quietHours()) return;
  if (deps.badRemaining() <= 0) return;
  if (deps.checking()) return;
  if (deps.stealDue() || deps.stealImminent() || deps.harvestDue() || deps.harvestImminent()) return;

  const blacklist = deps.blacklist();
  for (const gid of gids) {
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

      const tally = { steal: 0, water: 0, weed: 0, bug: 0, putBug: 0, putWeed: 0 };
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
  // 常量暴露给测试断言边界
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
