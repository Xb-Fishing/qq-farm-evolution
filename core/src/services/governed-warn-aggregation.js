/**
 * 治理拦截警告聚合（2026-10-13 预算自旋收口）。
 *
 * 背景：一次 60 秒局部自旋曾在固定窗口里产生 400+ 条 budget_total 拦截
 * 警告（摘要读取 + 进门各占大头）。警告本身只是日志形态，但逐条落盘既
 * 刷屏又污染每日反馈分组。本模块只做「同签名有界聚合」，不改任何请求
 * 行为、预算、失败计数或访问结算——日志条数减少不能作为请求减少的证据。
 *
 * 合同（与 friend-orchestrator 生命周期共用同一权威代次）：
 * - 固定入口白名单 × 两个严格预算类别，最多 14 个签名；键与持久状态只
 *   含签名/次数/时间，不保存身份、错误原文或响应内容。
 * - 每个签名首条立即输出；持续突发内每签名每 60 秒至多 1 条含计数的
 *   聚合行；自最后一次出现起连续静默 60 秒后，新突发首条立即输出。
 * - 生命周期复位清表并对齐 friend-orchestrator 的权威代次（本模块不自
 *   增）；迟到旧代次（seq 不等于当前代次）不占新窗口——既不落日志也不
 *   推进任何行的计数/时间。
 * - 只认 network.js 在唯一治理拒绝构造点附加的结构化标记；非治理错误、
 *   未知入口、未知类别一律返回 handled=false，调用方保留原 logWarn 原样。
 */

const { logWarn } = require('../utils/utils');

// 固定入口白名单：两个摘要 catch、QQ 分批 catch、四个既有进门 catch。
const GOVERNED_WARN_ENTRIES = new Set([
    'summary_check',      // friend-orchestrator checkFriends 摘要 catch
    'summary_refresh',    // friend-orchestrator refreshFriendRipeSchedule 摘要 catch
    'qq_batch',           // friend-api fetchQqFriendsByKnownGids 分批 catch
    'enter_visit',        // friend-visit visitFriend 进门 catch
    'enter_steal',        // friend-visit visitFriendForSteal 进门 catch
    'enter_help',         // friend-visit visitFriendForHelp 进门 catch
    'enter_autobad',      // friend-visit visitFriendForAutoBad 进门 catch
]);
// 严格预算类别白名单：请求治理器仅以这两种 reason 拒绝请求。
const GOVERNED_WARN_REASONS = new Set(['budget_total', 'budget_method']);

// 只识别本地严格标记及固定预算类别；不读取错误文案、不依赖传输模块。
function getGovernedRejectionInfo(err) {
    if (!err || typeof err !== 'object' || err.isGovernedRejection !== true) return null;
    const reason = err.governedReason;
    if (typeof reason !== 'string' || !GOVERNED_WARN_REASONS.has(reason)) return null;
    return { reason };
}

const AGGREGATE_EMIT_INTERVAL_MS = 60 * 1000;
const SILENCE_RESET_MS = 60 * 1000;

// signature -> { pending, firstAt, lastAt, lastEmitAt }
const rows = new Map();
let lifecycleSeq = 0;

/**
 * 生命周期复位（friend-orchestrator start/stopFriendCheckLoop 调用）：
 * 清空签名表并对齐权威代次。nextSeq 必须是调用方的权威代次（禁止本模块
 * 自行自增造成失配）；返回对齐后的代次。
 */
function resetGovernedWarnAggregation(nextSeq) {
    if (!Number.isSafeInteger(nextSeq)) {
        return { ok: false, seq: lifecycleSeq };
    }
    rows.clear();
    lifecycleSeq = nextSeq;
    return { ok: true, seq: lifecycleSeq };
}

/** 当前聚合代次（供调用方在访问发起前捕获，供 noteGovernedWarn 核对）。 */
function getGovernedWarnLifecycleSeq() {
    return lifecycleSeq;
}

/**
 * 登记一次治理拦截警告。
 * 返回 { handled, mode }：
 * - handled=false：入口/类别不在白名单或标记不严格 → 调用方保留原 logWarn。
 * - handled=true, mode='first'：新突发首条，本模块已立即输出。
 * - handled=true, mode='aggregated'：突发内到达 60 秒聚合点，已输出计数行。
 * - handled=true, mode='suppressed'：突发内未到聚合点，静默计数不输出。
 * - handled=true, mode='stale'：旧代次迟到（seq 不等于当前代次），不占新窗口。
 */
function noteGovernedWarn(entry, reason, options = {}) {
    try {
        if (!GOVERNED_WARN_ENTRIES.has(entry)) return { handled: false, mode: 'rejected_entry' };
        if (!GOVERNED_WARN_REASONS.has(reason)) return { handled: false, mode: 'rejected_reason' };
        const seq = options.seq;
        if (seq !== undefined) {
            if (!Number.isSafeInteger(seq) || seq !== lifecycleSeq) {
                return { handled: true, mode: 'stale' };
            }
        }
        const now = Number.isFinite(options.now) ? options.now : Date.now();
        const signature = `${entry}|${reason}`;
        let row = rows.get(signature);
        if (!row) {
            row = { pending: 0, firstAt: now, lastAt: now, lastEmitAt: null };
            rows.set(signature, row);
        }
        const sincePrevOccurrence = now - row.lastAt;
        row.pending += 1;
        row.lastAt = now;
        // 静默 60 秒后的新突发首条（或本窗口首条）立即输出。
        if (row.lastEmitAt === null || sincePrevOccurrence >= SILENCE_RESET_MS) {
            row.lastEmitAt = now;
            const count = row.pending;
            row.pending = 0;
            row.firstAt = now;
            emitGovernedWarn(entry, reason, count, 'first', now);
            return { handled: true, mode: 'first' };
        }
        // 持续突发：每签名每 60 秒至多一条含计数的聚合行。
        if (now - row.lastEmitAt >= AGGREGATE_EMIT_INTERVAL_MS) {
            row.lastEmitAt = now;
            const count = row.pending;
            row.pending = 0;
            emitGovernedWarn(entry, reason, count, 'aggregated', now);
            return { handled: true, mode: 'aggregated' };
        }
        return { handled: true, mode: 'suppressed' };
    } catch {
        // 聚合自身故障不得改变调用方行为：按未处理回落原日志。
        return { handled: false, mode: 'aggregation_error' };
    }
}

function emitGovernedWarn(entry, reason, count, mode, now) {
    logWarn('好友',
        `通信预算拦截聚合：入口=${entry} 类别=${reason} 本段${count}次（${mode === 'first' ? '新突发首条' : '60秒聚合'}）`,
        {
            module: 'friend',
            event: 'governed_warn_aggregated',
            result: 'warn',
            entry,
            reason,
            count,
            mode,
            at: now,
        });
}

/** 仅测试用：读取签名表快照（生产路径不调用）。 */
function getGovernedWarnRowsForTests() {
    const snapshot = {};
    for (const [signature, row] of rows.entries()) {
        snapshot[signature] = { ...row };
    }
    return snapshot;
}

/** 仅测试用：重置全部状态（生产生命周期用 resetGovernedWarnAggregation）。 */
function resetGovernedWarnAggregationForTests() {
    rows.clear();
    lifecycleSeq = 0;
}

module.exports = {
    getGovernedRejectionInfo,
    GOVERNED_WARN_ENTRIES: new Set(GOVERNED_WARN_ENTRIES),
    GOVERNED_WARN_REASONS: new Set(GOVERNED_WARN_REASONS),
    resetGovernedWarnAggregation,
    getGovernedWarnLifecycleSeq,
    noteGovernedWarn,
    getGovernedWarnRowsForTests,
    resetGovernedWarnAggregationForTests,
};
