'use strict';
/**
 * 跨 Worker 传输的操作错误元数据（无状态白名单校验，2026-10-30 奶茶 502 定位修复）。
 *
 * 旧通道只回传 error 字符串：network.js 预算闸门在 WS.send 前抛出的结构化拒绝
 * （isGovernedRejection + governedReason）与调用阶段在 Worker→manager 一跳全部
 * 丢失，路由层只能统一 502。本文件只做三件事，全部白名单、零状态、零序列化
 * 任意属性：
 * 1. 严格「本地预算零发送」拒绝校验（budget_total/budget_method，且不与
 *    business/服务端业务码/结果未知标记冲突）——只有结构上可证未交给传输层的
 *    拒绝才允许升级为 429 语义，普通错误一律维持原样；
 * 2. 有限 stage（list/group/precondition/write）校验：由 milk-tea 服务在真实
 *    读取/写入点附着，读 Operate 不允许标 write；
 * 3. 严格服务端业务错误校验（真布尔标记 + 非零十进制整数码）——好友预检查
 *    的兼容放行判定与诊断分类共用，不放宽到文案匹配。
 */

const BUDGET_REASONS = new Set(['budget_total', 'budget_method']);
const BUDGET_STAGES = new Set(['list', 'group', 'precondition', 'write']);

/** 严格本地预算拒绝：null = 不是（含任何冲突标记的普通/业务/未知错误）。 */
function strictBudgetRejection(error) {
  if (!error || typeof error !== 'object') return null;
  if (error.isGovernedRejection !== true || !BUDGET_REASONS.has(error.governedReason)) return null;
  // 与 business / 服务端业务码 / 结果未知任一并存即不可证明零发送，不认。
  if ((error.business !== undefined && error.business !== false) || (error.isServerBusinessError !== undefined && error.isServerBusinessError !== false)) return null;
  if (error.serverErrorCode != null || (error.unknown !== undefined && error.unknown !== false) || error.code != null) return null;
  const stage = BUDGET_STAGES.has(error.milkTeaStage) ? error.milkTeaStage : '';
  return { reason: error.governedReason, ...(stage ? { stage } : {}) };
}

/** Worker 收集侧：仅白名单字段，任何附加属性（stack/cause/参数）不进入元数据。 */
function collectOperationErrorMeta(error) {
  const rejection = strictBudgetRejection(error);
  if (rejection) return { governed: true, ...rejection };
  return BUDGET_STAGES.has(error?.milkTeaStage) ? { stage: error.milkTeaStage } : null;
}

/** manager 还原侧：IPC 值原样来自不可信通道，逐字段重新白名单校验。 */
function normalizeOperationErrorMeta(meta) {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return null;
  if (meta.governed === undefined && meta.reason === undefined) {
    return BUDGET_STAGES.has(meta.stage) ? { stage: meta.stage } : null;
  }
  if (meta.governed !== true || !BUDGET_REASONS.has(meta.reason)) return null;
  if ((meta.business !== undefined && meta.business !== false) || (meta.isServerBusinessError !== undefined && meta.isServerBusinessError !== false) || meta.serverErrorCode != null || meta.code != null || (meta.unknown !== undefined && meta.unknown !== false)) return null;
  if (meta.stage !== undefined && !BUDGET_STAGES.has(meta.stage)) return null;
  return { governed: true, reason: meta.reason, ...(BUDGET_STAGES.has(meta.stage) ? { stage: meta.stage } : {}) };
}

/** 把校验通过的元数据还原到 manager 侧重建的 Error 上；失败返回 null 不改错误。 */
function applyOperationErrorMeta(error, meta) {
  const normalized = normalizeOperationErrorMeta(meta);
  if (!normalized || !error || typeof error !== 'object') return null;
  if (normalized.governed === true) {
    error.isGovernedRejection = true;
    error.governedReason = normalized.reason;
  }
  if (normalized.stage) error.milkTeaStage = normalized.stage;
  return normalized;
}

/**
 * 严格服务端业务错误（network.js 唯一构造点的结构化标记）：
 * 必须 isServerBusinessError === true 且 serverErrorCode 为非零十进制整数
 * （number 或全数字字符串；"0x10"/"1e2"/" 42"/小数/超安全整数一律不认）。
 */
function strictServerBusinessError(error) {
  if (!error || typeof error !== 'object' || error.isServerBusinessError !== true || error.isGovernedRejection === true || error.unknown === true) return null;
  const raw = error.serverErrorCode;
  const parsed = typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : raw;
  if (typeof parsed !== 'number' || !Number.isSafeInteger(parsed) || parsed <= 0) return null;
  return { code: parsed };
}

module.exports = {
  strictBudgetRejection,
  collectOperationErrorMeta,
  normalizeOperationErrorMeta,
  applyOperationErrorMeta,
  strictServerBusinessError,
  BUDGET_STAGES: [...BUDGET_STAGES],
};
