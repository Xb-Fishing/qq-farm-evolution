/**
 * 请求治理：画像 + 硬预算 + 异常降速（防封号通信层护栏）
 *
 * sendMsgAsync 是所有游戏 RPC 的唯一出口，这里统一过闸：
 * - 画像：按 service.method 计数（成功/失败），喂每日安全巡检
 * - 硬预算：滑动 60s 窗口总请求/单接口上限，超限丢弃非白名单请求
 * - 异常降速：短窗内错误过多 → 通知调度器放慢普通巡查，不冻结成熟抢收
 * 纯保守护栏，不做任何协议层伪装。
 */

const WINDOW_MS = 60 * 1000;
// 预算从 40/15 放宽到 80/30：正常多账号巡查 + 收获 + ACE 上报的合理峰值
// 不该被拦，预算只削真正的异常风暴
const TOTAL_LIMIT = Number(process.env.FARM_REQUEST_LIMIT_60S) || 80;
const PER_METHOD_LIMIT = Number(process.env.FARM_REQUEST_METHOD_LIMIT_60S) || 30;
// 白名单：防封兜底与核心链路的关键请求不受预算限制（仍计入画像）
// AntiData 是官方客户端固定节奏的 ACE 风控上报；心跳是 userpb.UserService.Heartbeat
const WHITELIST = new Set([
    'gamepb.userpb.UserService.Heartbeat',
    'gamepb.gatepb.GateService.Login',
    'gamepb.acepb.AceService.AntiData',
]);
// 施肥 HOT / 成熟竞速涉及的接口。它们仍计入请求画像，并沿用既有频率门控
// （Harvest/Steal 的核心链白名单不变）；但短窗口内“别人先偷了/重复离场/
// 状态刚变化”等预期失败不能累计成整号异常降速。
const WATCHMODE_METHODS = new Set([
    'gamepb.visitpb.VisitService.Enter',
    'gamepb.plantpb.PlantService.AllLands',
]);
const WATCH_FAILURE_EXEMPT_METHODS = new Set([
    ...WATCHMODE_METHODS,
    'gamepb.visitpb.VisitService.Leave',
    'gamepb.plantpb.PlantService.CheckCanOperate',
    'gamepb.plantpb.PlantService.Harvest',
]);
// 施肥 HOT 窗口内放宽倍数：目标接口单项 ×3、总量 ×1.5，仍兜底异常风暴。
const WATCHMODE_BOOST = Number(process.env.FARM_WATCHMODE_BOOST) || 3;
// 施肥 HOT 到期时刻；0 = 无窗口。只有 fertilizer-watch 确认施肥趋势后设置。
let watchModeUntil = 0;
// 成熟/偷菜竞争只豁免预期业务失败，不放宽 Enter/AllLands 门限。
let contentionModeUntil = 0;

/** 进入/退出施肥 HOT 窗口（确认出现施肥趋势后调用） */
function setWatchMode(active, untilMs = 0) {
    watchModeUntil = active ? Math.max(watchModeUntil, Number(untilMs) || 0) : 0;
}

function watchModeActive(now = Date.now()) {
    return now < watchModeUntil;
}

/** 成熟竞速宽限：仅隔离预期业务失败，不提高请求频率。 */
function setContentionMode(active, untilMs = 0) {
    contentionModeUntil = active
        ? Math.max(contentionModeUntil, Number(untilMs) || 0)
        : 0;
}

function contentionModeActive(now = Date.now()) {
    return now < contentionModeUntil;
}
// 偷菜相关（放行：错过成熟窗口的代价是核心收益，且总量天然有限）
const STEAL_WHITELIST_RE = /Harvest|Steal/;
// 异常降速：15 分钟窗口内 ≥12 次失败 → 普通巡查降速 5-10 分钟。
// 不再整号熔断；自己收获、好友到点抢收、施肥 HOT 和心跳继续按各自护栏运行。
const BREAKER_ERR_LIMIT = Number(process.env.FARM_BREAKER_ERR_LIMIT) || 12;
const BREAKER_WINDOW_MS = 15 * 60 * 1000;
const SLOWDOWN_MIN_MS = 5 * 60 * 1000;
const SLOWDOWN_MAX_MS = 10 * 60 * 1000;
const SLOWDOWN_RECOMMENDED_DELAY_MS = 90 * 1000;

const windowEvents = [];   // { at, key, ok }
const errEvents = [];      // { at, key }
let slowdownUntil = 0;
let slowdownCount = 0;
let droppedTotal = 0;

function pruneWindow(now) {
    while (windowEvents.length && now - windowEvents[0].at > WINDOW_MS) windowEvents.shift();
    while (errEvents.length && now - errEvents[0].at > BREAKER_WINDOW_MS) errEvents.shift();
}

function methodKey(serviceName, methodName) {
    return `${String(serviceName || '')}.${String(methodName || '')}`;
}

/**
 * 发送前过闸。返回 { allowed, reason }。
 * allowed=false 时调用方应静默跳过（返回错误让既有 catch 路径处理）。
 */
function checkRequest(serviceName, methodName, now = Date.now()) {
    pruneWindow(now);
    const key = methodKey(serviceName, methodName);
    const whitelisted = WHITELIST.has(key) || STEAL_WHITELIST_RE.test(key);
    // 异常阈值只通知上层降低普通巡查节奏，不在这里整号拒绝业务请求。
    // 成熟抢收仍受下面的 60s 总量/单方法硬预算保护。
    if (whitelisted) return { allowed: true, reason: 'whitelist' };

    // 施肥 HOT 内总预算同步放宽（目标好友需要高频往返，80/min 的常规预算
    // 会被盯梢+常规巡查挤满，导致 Enter 被拦、盯哨失明）
    const totalLimit = watchModeActive(now) ? Math.floor(TOTAL_LIMIT * 1.5) : TOTAL_LIMIT;
    if (windowEvents.length >= totalLimit) {
        droppedTotal++;
        return { allowed: false, reason: 'budget_total' };
    }
    // 施肥 HOT 内的进门/读地块放宽单接口限值。
    const methodLimit = WATCHMODE_METHODS.has(key) && watchModeActive(now)
        ? PER_METHOD_LIMIT * WATCHMODE_BOOST
        : PER_METHOD_LIMIT;
    const methodCount = windowEvents.filter(e => e.key === key).length;
    if (methodCount >= methodLimit) {
        droppedTotal++;
        return { allowed: false, reason: 'budget_method' };
    }
    return { allowed: true, reason: 'ok' };
}

/** 发送已放行/白名单请求后登记（ok=是否成功） */
function recordSent(serviceName, methodName, ok, now = Date.now(), options = {}) {
    pruneWindow(now);
    const key = methodKey(serviceName, methodName);
    windowEvents.push({ at: now, key, ok: ok !== false });
    if (ok === false) {
        // 施肥 HOT / 成熟竞速中的目标链路失败不计入异常阈值：它们通常只是状态竞争。
        // 此外，调用方可把明确的只读探测“业务错误”标为 breakerExempt；网络超时、
        // 断线与发送失败不会带这个标记，仍按真实协议异常计数。
        const inContention = WATCH_FAILURE_EXEMPT_METHODS.has(key)
            && (watchModeActive(now) || contentionModeActive(now));
        if (!inContention && options.breakerExempt !== true) {
            errEvents.push({ at: now, key });
            if (errEvents.length >= BREAKER_ERR_LIMIT && now >= slowdownUntil) {
                const slowdown = SLOWDOWN_MIN_MS
                    + Math.floor(Math.random() * (SLOWDOWN_MAX_MS - SLOWDOWN_MIN_MS));
                const failures = [...errEvents.reduce((counts, item) => {
                    counts.set(item.key, (counts.get(item.key) || 0) + 1);
                    return counts;
                }, new Map()).entries()]
                    .map(([method, count]) => ({ method, count }))
                    .sort((left, right) => right.count - left.count);
                slowdownUntil = now + slowdown;
                slowdownCount++;
                errEvents.length = 0;
                if (!process.env.NODE_TEST_CONTEXT) {
                    try {
                        const top = failures.slice(0, 3)
                            .map(item => `${item.method}×${item.count}`)
                            .join(', ');
                        require('./daily-events').recordEvent(
                            process.env.FARM_ACCOUNT_ID || '', 'warn', 'slowdown',
                            `连续失败过多，普通巡查降速 ${Math.round(slowdown / 60000)} 分钟${top ? `（${top}）` : ''}`);
                    } catch { /* 事件记录失败不影响降速 */ }
                }
                return { tripped: false, slowed: true, slowdownMs: slowdown, failures };
            }
        }
    }
    return { tripped: false };
}

/** 手动取消异常降速（保留旧函数名兼容既有面板/API）。 */
function clearBreaker() {
    const wasActive = Date.now() < slowdownUntil;
    slowdownUntil = 0;
    errEvents.length = 0;
    return wasActive;
}

/** 画像：给每日安全巡检的事实输入 */
function getRequestProfile(now = Date.now()) {
    pruneWindow(now);
    const byMethod = new Map();
    for (const e of windowEvents) {
        const item = byMethod.get(e.key) || { count: 0, errCount: 0 };
        item.count++;
        if (!e.ok) item.errCount++;
        byMethod.set(e.key, item);
    }
    const top = [...byMethod.entries()]
        .map(([key, v]) => ({ method: key, ...v }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 12);
    return {
        windowMs: WINDOW_MS,
        totalLimit: TOTAL_LIMIT,
        perMethodLimit: PER_METHOD_LIMIT,
        watchModeActive: watchModeActive(now),
        contentionModeActive: contentionModeActive(now),
        watchModeBoost: WATCHMODE_BOOST,
        windowCount: windowEvents.length,
        droppedTotal,
        slowdownActive: now < slowdownUntil,
        slowdownUntil,
        slowdownCount,
        // 兼容旧画像字段，但明确不存在硬熔断。
        breakerActive: false,
        breakerUntil: 0,
        breakerCount: slowdownCount,
        top,
    };
}

function getBreakerState(now = Date.now()) {
    return {
        active: now < slowdownUntil,
        until: slowdownUntil,
        count: slowdownCount,
        mode: 'slowdown',
        hardBlocked: false,
        recommendedDelayMs: SLOWDOWN_RECOMMENDED_DELAY_MS,
    };
}

/** 测试用：清空全部状态 */
function resetForTest() {
    windowEvents.length = 0;
    errEvents.length = 0;
    slowdownUntil = 0;
    slowdownCount = 0;
    droppedTotal = 0;
    watchModeUntil = 0;
    contentionModeUntil = 0;
}

module.exports = {
    checkRequest,
    recordSent,
    getRequestProfile,
    getBreakerState,
    clearBreaker,
    setWatchMode,
    setContentionMode,
    resetForTest,
    WINDOW_MS,
    TOTAL_LIMIT,
    PER_METHOD_LIMIT,
};
