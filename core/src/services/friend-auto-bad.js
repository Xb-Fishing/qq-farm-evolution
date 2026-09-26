/**
 * 好友在线自动捣乱调度（2026-09-26 第三版：纯被动证据触发）。
 *
 * 用户最终定标（覆盖此前"全好友观察采样/主动进门探测在线"方案）：
 * 在线识别是被动 trigger——只消费既有可信在线证据
 * （friend-activity.onOnlineEvidence：at_home/lands_push/presence_online），
 * 收到新鲜证据才更新在线并唤醒独立在线捣乱。零盲探测：
 *  1. 不再 runObservePass/自动名册拉取/5s 全好友观察（friend_observe_sample 已删）；
 *  2. autoBad 名标的 10-15s 无证据盲探测、done 后 5-8min 读离线探测全部停止——
 *     没有新鲜在线证据即零 Enter/Leave/GetAll，启停/新名单/时间推进都不制造请求；
 *  3. 批量 presence 轮询保持禁用，不新增任何 RPC，不猜推送 schema。
 *
 * 会话重置不凭信号沉默当离线：订阅 friend-activity.onPresenceObservation
 * （纯内存，仅消费既有进门回包 noteEnterPresence；缺 at_home 字段不当明确
 * 离场），显式 at_home=false 才记离场观测，沿用旧规则"本地首见离线 ≥3 分钟、
 * 或服务端 last_online 确证 ≥3 分钟且晚于 doneAt"才复位 done；确认用本地
 * 状态定时器复查，零 RPC。沉默（无证据）永不重置 done。
 *
 * 保留第二版的全部结构性守卫：证据拉近以 retryNotBefore 为下界（退避不被
 * 每次证据打穿）、stop/restart 代次栅栏、跨代串行锁与在途票据、进门后与
 * 每种写动作前复查 guard（暂停/免打扰/静默/额度/让步/名单移除/黑名单）、
 * 部分成功也算 done、多目标游标轮转公平。自己 visit 产生的 at_home 证据
 * 会再次唤醒，但串行锁 + done/退避语义保证不重放动作。
 *
 * 延迟上界（诚实）：只有既有访问（收菜/偷菜/重点巡田/手动访问/页面通道）
 * 顺便产出证据时才有秒级出手；无人访问即无人出手——这是用户定标的取舍。
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
// 零执行退避：60s 起指数，10 分钟封顶（4 步）；证据唤醒不得越过该下界
const BACKOFF_BASE_MS = 60_000;
const BACKOFF_MAX_MS = 10 * 60_000;
const BACKOFF_MAX_STEPS = 4;
// 新鲜在线证据（at_home/lands_push/presence_online）命中：拉近到 0.3-1.5s 后处理
const EVIDENCE_DISPATCH_MIN_MS = 300;
const EVIDENCE_DISPATCH_MAX_MS = 1_500;
// 守卫翻转（让步/暂停）中止后的保守重试间隔：不计数、不退避
const ABORT_RETRY_MIN_MS = 5_000;
const ABORT_RETRY_MAX_MS = 15_000;
// 旧规则语义：离线确证 ≥3 分钟后再上线才算新会话
const OFFLINE_RESUME_MS = 3 * 60_000;
// 证据唤醒重挂定时器的延迟
const WAKE_DELAY_MS = 300;
// 真实派发错峰：相邻两次 Enter 至少间隔（多目标同拍有证据不突发）
const DISPATCH_GAP_MS = 2_000;

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
// 会话只能由在线证据创建（handleOnlineEvidence）：无证据 = 无会话 = 无请求
const autoBadSessions = new Map();
// 动作档游标：多目标同时有证据时按 gid 后继轮转，名单头部不得持续抢占
let actionCursorGid = 0;
// 上一次真实派发 Enter 的时刻（错峰下界）
let lastDispatchAt = 0;
// friend-activity 订阅取消函数（stop 时必须取消）
let unsubscribeOnlineEvidence = null;
let unsubscribePresence = null;

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
  friendName: gid => friendActivity.getCachedFriendName(gid),
  visit: (friend, tally, myGid, options) => visitFriendForAutoBad(friend, tally, myGid, options),
  delay: (min, max) => randomDelay(min, max),
};

function backoffMs(failCount) {
  return Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (Math.max(0, failCount) - 1));
}

function getSession(gid) {
  let session = autoBadSessions.get(gid);
  if (!session) {
    session = { done: false, doneAt: 0, offlineObservedAt: 0, failCount: 0, nextAt: 0, retryNotBefore: 0 };
    autoBadSessions.set(gid, session);
  }
  return session;
}

/** 证据拉近：只提前不推迟，且不得越过失败退避下界 retryNotBefore。 */
function pullByEvidence(session, now) {
  const pull = Math.max(session.retryNotBefore || 0,
    now + gaussianInt(EVIDENCE_DISPATCH_MIN_MS, EVIDENCE_DISPATCH_MAX_MS));
  if (pull < session.nextAt) session.nextAt = pull;
}

function tickDelayMs(now) {
  let earliest = 0;
  let hasDue = false;
  for (const [gid, session] of autoBadSessions.entries()) {
    if (session.done) continue;
    if (session.nextAt > now) {
      if (!earliest || session.nextAt < earliest) earliest = session.nextAt;
    } else if (deps.online(gid)) {
      // 已到期且证据仍新鲜（因 dispatchGap/守卫未出手）：按有效约束醒，不睡 30s
      hasDue = true;
    }
  }
  let target = earliest;
  if (hasDue) {
    const gapDue = lastDispatchAt ? lastDispatchAt + DISPATCH_GAP_MS : 0;
    const effective = Math.max(now + 500, gapDue); // ≥500ms 下界防热循环
    if (!target || effective < target) target = effective;
  }
  // 无未来到期（纯证据驱动，无探测节奏）：睡满空档——证据到达会重挂短定时器
  if (!target) return EMPTY_TICK_MS;
  return Math.min(EMPTY_TICK_MS, Math.max(500, target - now));
}

/** 会话目标的写动作守卫：进门后与每种写动作前都要复查。
 * connected 与新鲜在线证据也纳入：进门/远程 check 可能延迟超过 10s
 * 在线窗口，写前必须复验证据未过期。 */
function makeGuard(gid, gen) {
  return () => gen === generation
    && deps.connected()
    && deps.online(gid)
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
  if (!myGid || !deps.connected()) return;
  // 共同守卫：全局暂停、免打扰、静默时段、与 checkFriends/watchlist 互斥、
  // 抢收/自收让步
  if (deps.paused() || deps.quietHours()) return;
  if (deps.checking()) return;
  if (deps.stealDue() || deps.stealImminent() || deps.harvestDue() || deps.harvestImminent()) return;
  // 写侧条件：捣乱暂停、名单为空、额度耗尽 → 零请求（无观察层兜底）
  if (gids.length === 0 || deps.badPaused() || deps.badRemaining() <= 0) return;
  await runActionPass(gen, now, gids, myGid, deps.blacklist());
}

/** 动作档：只处理"有新鲜在线证据且未完成"的名单目标。 */
async function runActionPass(gen, now, gids, myGid, blacklist) {
  // gid 后继轮转：多目标同拍有证据时也不饿死排在后面的目标
  const ordered = gids.filter(g => g > actionCursorGid).concat(gids.filter(g => g <= actionCursorGid));
  for (const gid of ordered) {
    if (gen !== generation) return; // stop/restart 栅栏：旧代不得继续写
    if (gid === myGid || blacklist.has(gid)) continue;
    const session = autoBadSessions.get(gid);
    if (!session) continue; // 无会话 = 从未有在线证据：绝不主动进门
    if (session.done) continue; // 已完成会话不重放（等被动离场确证复位）
    if (session.nextAt > now) continue;
    // 发起前复验新鲜证据（10s 窗口）与整体守卫：进门/远程 check 可能延迟
    // 超窗口；其它目标不得沿用 tick 入口的旧守卫快照
    if (!deps.online(gid)) continue;
    if (!deps.connected() || deps.paused() || deps.quietHours() || deps.checking()) return;
    // 抢收/自己收获让步：不消耗机会，下轮再试
    if (deps.stealDue() || deps.harvestImminent()) break;
    // 真实派发错峰（有界）：相邻 Enter 至少间隔 DISPATCH_GAP_MS，
    // 多目标同拍有证据也不突发
    if (lastDispatchAt && now - lastDispatchAt < DISPATCH_GAP_MS) break;

    const tally = { steal: 0, water: 0, weed: 0, bug: 0, putBug: 0, putWeed: 0 };
    actionCursorGid = gid; // 派发后游标推进到本目标，下轮从后继开始
    lastDispatchAt = now;
    const label = deps.friendName(gid) || `GID:${gid}`;
    const result = await deps.visit({ gid, name: label }, tally, myGid,
      { allowPlace: true, guard: makeGuard(gid, gen) });
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
      session.nextAt = 0;
      // 进门可能刚取得真昵称（EnterReply.basic.name 进运行时名册）：重新解析
      const labelAfter = deps.friendName(gid) || label;
      log('好友', `在线自动捣乱会话完成 ${labelAfter}（放虫${result.bug}/放草${result.weed}）`, {
        module: 'friend',
        event: 'auto_bad_session_done',
        friendGid: gid,
        putBug: result.bug,
        putWeed: result.weed,
        ...(result.aborted ? { partial: true } : {}),
      });
      // 多目标分散后再继续
      await deps.delay(800, 1500);
      if (gen !== generation) return;
      continue;
    }
    if (result.aborted) {
      // 守卫翻转（让步/暂停/移出名单/代际失效）中止：不计数、不退避，
      // 短间隔重试（守卫恢复 + 证据仍在时继续）
      session.nextAt = visitedAt + gaussianInt(ABORT_RETRY_MIN_MS, ABORT_RETRY_MAX_MS);
      continue;
    }
    if (!result.entered) {
      // 进门失败：退避，不消耗机会
      session.failCount = Math.min(BACKOFF_MAX_STEPS, session.failCount + 1);
      session.retryNotBefore = session.nextAt = visitedAt + backoffMs(session.failCount);
      continue;
    }
    if (!result.online) {
      // 探测观察到不在场：离线观测由 presence 订阅（noteEnterPresence）统一
      // 结算，这里不再排任何探测；等下一在线证据唤醒
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
      schedulePoll(tickDelayMs(deps.now()));
    }
  }
}

/**
 * 在线证据到达即唤醒（被动 trigger 核心）：只响应名单内目标；不新增任何
 * 游戏请求。无会话（首次证据）即建会话并拉近；退避锁内（retryNotBefore
 * 未到）的目标拉近被 pullByEvidence 的下界挡住，新证据不能穿透退避。
 * done 会话不拉近（不重放），但在线证据否定"离场观测"，清 offlineObservedAt。
 */
function handleOnlineEvidence(gid) {
  if (!armed) return;
  const id = toNum(gid);
  if (!id || !deps.gids().includes(id)) return; // 仅名单目标（全好友证据照收，动作只看名单）
  const session = getSession(id);
  session.offlineObservedAt = 0; // 在线证据否定离场观测
  if (session.done) return; // done 只更新离场观测，不反复空唤醒
  pullByEvidence(session, deps.now());
  schedulePoll(WAKE_DELAY_MS);
}

/** 统一排程入口（start/tick finally/证据唤醒都走这里）：维护真实到期时刻
 * pollTimerAt，后到的事件/收尾排程不得推迟已有更早唤醒（只提前不推迟）；
 * 连续事件（间隔 < 已排延迟）不得互相推迟成无限延后。tick/runTickBody
 * 自带串行锁，当前 Enter 未 settle 时不会另起并发进门；自己 visit 产生的
 * at_home 证据同样走这里，串行锁 + done/退避语义保证不重放不并发。 */
let pollTimerAt = 0;
function schedulePoll(delayMs) {
  const now = deps.now();
  const at = now + Math.max(0, delayMs);
  if (pollTimerAt && pollTimerAt <= at) return; // 已有更早的排程在途：合并
  pollTimerAt = at;
  scheduler.clear('auto_bad_poll');
  scheduler.setTimeoutTask('auto_bad_poll', at - now, () => {
    pollTimerAt = 0; // 回调运行即清真实 pending 标记
    tick();
  });
}

/** 复位已完成的会话（明确离场确证后）：等待下一次在线证据再出手。 */
function resetDoneSession(session) {
  session.done = false;
  session.doneAt = 0;
  session.offlineObservedAt = 0;
  session.failCount = 0;
  session.nextAt = 0;
}

/**
 * 被动离场观测（纯内存，零 RPC）：既有进门回包（本模块自己的动作、
 * 收菜/偷菜/帮助/手动访问）经 friend-activity.noteEnterPresence 分发，
 * 签名 (gid, at, obs)。缺 at_home 字段不当明确离场、完全不推进；
 * 信号沉默不是持续离线的证据——不复用"单次 false + 定时器到点复位"。
 * 复位仅两条确证路径：
 *  a) 两次显式 at_home=false 观测，跨度 ≥3 分钟（本地确证持续离场）；
 *     在线证据（handleOnlineEvidence）清掉首见时刻，重新计时；
 *  b) 服务端 last_online 确证 ≥3 分钟且晚于 doneAt（远古 last_online
 *     不能复位刚成功的会话）。
 */
function handlePresenceObservation(gid, at, obs) {
  if (!armed) return;
  const id = toNum(gid);
  if (!id || !deps.gids().includes(id)) return;
  const session = autoBadSessions.get(id);
  if (!session || !session.done) return; // 未完成会话无"复位"语义
  if (!(obs && obs.atHomeDecoded && obs.atHome === false)) return; // 缺字段不推进
  const now = deps.now();
  const offlineSinceMs = Number(obs.lastOnlineMs) || 0;
  // b) 服务端确证
  const serverConfirmed = offlineSinceMs > 0
    && now - offlineSinceMs >= OFFLINE_RESUME_MS
    && (!session.doneAt || offlineSinceMs >= session.doneAt);
  if (serverConfirmed) {
    resetDoneSession(session);
    log('好友', `在线自动捣乱会话复位 ${deps.friendName(id) || `GID:${id}`}（服务端确证离线）`, {
      module: 'friend',
      event: 'auto_bad_session_reset',
      friendGid: id,
      reason: 'server_offline_confirmed',
    });
    return;
  }
  // a) 两次显式 false 跨度 ≥3 分钟才本地确证；单次 false 只记首见时刻
  if (!session.offlineObservedAt) {
    session.offlineObservedAt = now;
    return;
  }
  if (now - session.offlineObservedAt >= OFFLINE_RESUME_MS) {
    resetDoneSession(session);
    log('好友', `在线自动捣乱会话复位 ${deps.friendName(id) || `GID:${id}`}（两次显式离场观测跨度 ≥3 分钟）`, {
      module: 'friend',
      event: 'auto_bad_session_reset',
      friendGid: id,
      reason: 'local_offline_confirmed',
    });
  }
}

function startAutoBadLoop() {
  if (armed) return;
  armed = true;
  generation += 1;
  if (!unsubscribeOnlineEvidence) {
    unsubscribeOnlineEvidence = friendActivity.onOnlineEvidence(handleOnlineEvidence);
  }
  if (!unsubscribePresence) {
    unsubscribePresence = friendActivity.onPresenceObservation(handlePresenceObservation);
  }
  schedulePoll(TICK_MS);
}

function stopAutoBadLoop() {
  // 先升代际再清：旧代 in-flight visit 的迟到写全部被栅栏拦下。
  // pendingBodies 不清零——stop 不假装旧网络请求已完成，等旧代
  // visit 真正 settle 时由它自己的 finally 释放（isAutoBadRunning 如实
  // 报告在途，orchestrator 侧互斥不提前放行）
  generation += 1;
  armed = false;
  autoBadSessions.clear();
  actionCursorGid = 0;
  lastDispatchAt = 0;
  pollTimerAt = 0;
  if (unsubscribeOnlineEvidence) {
    unsubscribeOnlineEvidence();
    unsubscribeOnlineEvidence = null;
  }
  if (unsubscribePresence) {
    unsubscribePresence();
    unsubscribePresence = null;
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
  // 强制下一拍到期（仅测试：模拟证据把处理拉到秒级的短间隔离线观测）
  __setNextAtForTests: (gid, at) => { const s = autoBadSessions.get(toNum(gid)); if (s) s.nextAt = at; },
  __depsForTests: deps,
  // 常量暴露给测试断言边界
  BACKOFF_BASE_MS,
  BACKOFF_MAX_MS,
  OFFLINE_RESUME_MS,
  EVIDENCE_DISPATCH_MAX_MS,
};
