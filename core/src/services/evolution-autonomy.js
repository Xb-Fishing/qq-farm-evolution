'use strict';
// 进化自主策略（纯决策模块，默认关闭）：只判定「下一步该做什么」，不写状态、
// 不调度、不碰凭据；副作用由 activity-evolver 注入执行，便于离线测试。
// 语义合同（2026-10-05 批准）：
// - 开关关闭 = 旧行为（一切等管理员点重试/应用）。
// - 开启后：pending_apply 自动应用（自动轮严格 HEAD===已审提交 + 远端同提交）；
//   repairOnly 应用后新进程续接原任务（保留原反馈批次，不占第二个每日名额）；
//   失败/验收未通过进入持久退避返工（10min 递增至 60min + 抖动），重复无进展
//   改走真实 diagnose，不空转旧 review 意见；缺条件（隐私/HEAD/范围/鉴权）保持
//   pending 并去重通知，绝不伪造通过、不强停 Main、不碰凭据。
const crypto = require('node:crypto');

const REWORK_DELAY_BASE_MS = 10 * 60 * 1000;
const REWORK_DELAY_MAX_MS = 60 * 60 * 1000;
const REWORK_JITTER_MS = 90 * 1000;
// 连续同键无进展达到该次数后，续接轮强制 preferDiagnosis（主 Agent 真实重新诊断）。
const NO_PROGRESS_DIAGNOSIS_ATTEMPTS = 2;
const NOTIFY_DEDUPE_MS = 6 * 60 * 60 * 1000;

function normalizeAutonomy(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const continuation = source.continuation && typeof source.continuation === 'object'
    && !Array.isArray(source.continuation) ? source.continuation : null;
  const planIds = ids => [...new Set((Array.isArray(ids) ? ids : []).map(Number).filter(id => id > 0))].slice(0, 200);
  return {
    reworkAttempts: Math.max(0, Math.min(50, Math.floor(Number(source.reworkAttempts) || 0))),
    lastReworkKey: String(source.lastReworkKey || '').slice(0, 200),
    lastReworkAt: Math.max(0, Math.floor(Number(source.lastReworkAt) || 0)),
    // 应用尝试独立计数（键=apply@<commit>）：同一待应用提交的真实失败次数决定
    // 重试退避增长；换新提交即换新键，从 0 重新计。
    applyAttempts: Math.max(0, Math.min(50, Math.floor(Number(source.applyAttempts) || 0))),
    lastApplyKey: String(source.lastApplyKey || '').slice(0, 200),
    // 退避目标键（2026-10-05 复审 R4）：defer 写入与 schedule 比对必须由同一函数
    // 产生。此前 defer 写 reason 键（wait:dirty-worktree 等），schedule 却比对
    // reworkKey(state)（状态+失败类别+意见摘要）——永不相等 → remaining/attempts
    // 归零、条件等待紧循环而 UI 显示十分钟。目标键只认"同一已审任务"：reason
    // 文本、失败类别、复核意见措辞变化都不换目标，不重置退避。
    deferredTarget: String(source.deferredTarget || '').slice(0, 200),
    // 退避触发时刻（持久）：重启后按剩余时间续等，不重置成新的整段延迟。
    nextReworkAt: Math.max(0, Math.floor(Number(source.nextReworkAt) || 0)),
    preferDiagnosis: source.preferDiagnosis === true,
    // 原始任务上下文（私有 0600，只进 core/data 状态文件，永不入 git）：原 prompt
    // 全文供续接轮做前缀身份核实；活动计划沿用原批次，不重算替换。
    originalPrompt: typeof source.originalPrompt === 'string' ? source.originalPrompt.slice(0, 400_000) : '',
    // 返工轮 id：同轮（含崩溃恢复）预算连续；退避后新轮换新 id 才重置有界预算。
    roundId: String(source.roundId || '').slice(0, 100),
    // 链条身份摘要：原 github 批次/活动计划/自动名额日期，续接轮不得漂移。
    quotaDate: /^\d{4}-\d{2}-\d{2}$/.test(String(source.quotaDate || '')) ? String(source.quotaDate) : '',
    githubBatchDigest: /^[0-9a-f]{64}$/i.test(String(source.githubBatchDigest || '')) ? String(source.githubBatchDigest) : '',
    activityPlanDigest: /^[0-9a-f]{64}$/i.test(String(source.activityPlanDigest || '')) ? String(source.activityPlanDigest) : '',
    continuation: continuation ? {
      task: continuation.task === 'activity' ? 'activity' : 'safety',
      automatic: continuation.automatic === true,
      combinedDaily: continuation.combinedDaily === true,
      ...(continuation.activityPlan && typeof continuation.activityPlan === 'object'
        && !Array.isArray(continuation.activityPlan)
        ? { activityPlan: {
          newUnknown: planIds(continuation.activityPlan.newUnknown),
          newEnded: planIds(continuation.activityPlan.newEnded),
          reviewIds: planIds(continuation.activityPlan.reviewIds),
          fingerprint: /^[0-9a-f]{64}$/i.test(String(continuation.activityPlan.fingerprint || ''))
            ? String(continuation.activityPlan.fingerprint) : '',
        } }
        : {}),
    } : null,
    notifiedKey: String(source.notifiedKey || '').slice(0, 200),
    notifiedAt: Math.max(0, Math.floor(Number(source.notifiedAt) || 0)),
  };
}

/** 退避：10min * 次数封顶 60min，加有界抖动；次数不因重启清零（持久在 state）。 */
function computeReworkDelayMs(attempt) {
  const step = Math.max(1, Math.min(50, Math.floor(Number(attempt) || 1)));
  return Math.min(REWORK_DELAY_BASE_MS * step, REWORK_DELAY_MAX_MS)
    + Math.floor(Math.random() * REWORK_JITTER_MS);
}

/** 无进展判定键：同状态 + 同失败类别/阶段 + 同待应用提交 + 同复核意见摘要。 */
function reworkKey(state) {
  const failure = state?.collaboration?.failure || {};
  const feedback = String(state?.collaboration?.reviewFeedback || '');
  const digest = crypto.createHash('sha256').update(feedback).digest('hex').slice(0, 16);
  return [state?.status || '', failure.code || '', failure.phase || '', state?.commit || '', digest].join('|');
}

/**
 * 退避目标键（2026-10-05 复审 R4）：defer 落盘与 schedule 比对共用，同一任务
 * 必须产出同一字符串。apply = 待应用提交（哈希钉死）；rework = 原任务身份
 * （任务类型 + 原 prompt 摘要 + 相关提交）。失败类别/reason 文本/复核意见措辞
 * 变化不改变目标——同一已审任务的连续失败共享退避计数；新提交/新任务才是新
 * 目标（立即执行一次）。缺原 prompt 的旧状态退化到 lastTask+commit，只可能
 * 更保守（多退避），绝不会把等待变成立即拉模型。
 */
function autonomyTargetKey(state, action = 'rework') {
  if (action === 'apply') return `apply@${String(state?.commit || '')}`;
  const autonomy = state?.autonomy || {};
  const prompt = typeof autonomy.originalPrompt === 'string' ? autonomy.originalPrompt : '';
  const promptDigest = prompt
    ? crypto.createHash('sha256').update(prompt).digest('hex').slice(0, 16) : '';
  return `rework@${state?.lastTask || 'task'}|${promptDigest}|${String(state?.commit || '')}`;
}

/** 通知去重：同键 6 小时内不重复外呼；键变化或超时才再次提醒。 */
function shouldNotify(autonomy, key, now) {
  const record = normalizeAutonomy(autonomy);
  return record.notifiedKey !== key || now - record.notifiedAt > NOTIFY_DEDUPE_MS;
}

/**
 * 判定当前状态的自主动作。deps 注入 git/工作区实测（默认 no-op，纯单测可省略）：
 * { gitHead()?, worktreeFiles()?, now? }；worktreeFiles() 返回当前变更文件数组
 * （空数组=干净），未注入时按无工作区知识处理（凭据交给 runner 实测）。
 * 返回：
 * - { action: 'none', reason }        无事可做（关闭/已完成/需用户输入的拒绝等）
 * - { action: 'wait', reason }        条件未满足（工作区未收口等），按退避再查，不启动
 * - { action: 'apply', strict }       pending_apply 自动应用；strict=自动轮要求 HEAD===已审提交
 * - { action: 'launch', kind, payload } kind: 'continue'=repairOnly 应用后续接；
 *                                      'resume'=有 checkpoint 的原任务续接（跳过已完成调研）；
 *                                      'fresh'=无 checkpoint 的新基线诊断续跑（review_blocked
 *                                      走既有 retryReviewBlockedEvolution 语义，failed/interrupted
 *                                      走 initialFailure 诊断）
 */
function planAutonomy(state, deps = {}) {
  if (!state || state.autonomousEvolutionEnabled !== true) return { action: 'none', reason: 'disabled' };
  switch (state.status) {
    case 'pending_apply':
      if (!state.commit) return { action: 'none', reason: 'missing-commit' };
      // 自主应用一律严格同提交（不分候选手动/自动来源）：内容以提交哈希钉死，
      // HEAD 漂移即拒；祖先包含语义只属于人工按钮路径。
      return { action: 'apply', strict: true };
    case 'applying':
      return { action: 'none', reason: 'applying' };
    case 'applied':
      if (state.collaboration?.repairOnly) {
        const continuation = normalizeAutonomy(state.autonomy).continuation;
        if (continuation) return { action: 'launch', kind: 'continue', payload: continuation };
        return { action: 'wait', reason: 'missing-continuation' };
      }
      return { action: 'none', reason: 'applied' };
    case 'review_blocked':
    case 'failed':
    case 'interrupted':
    case 'deferred': {
      // 手动轮的失败留给用户处置（无自动身份可续）；自动轮继续收口到完成。
      // review_blocked 的手动重试另有入口，这里只在开关开启时接管返工。
      if (state.status !== 'review_blocked' && state.status !== 'deferred'
        && state.lastRunAutomatic !== true) return { action: 'none', reason: 'manual-run' };
      return planReworkLaunch(state, deps);
    }
    case 'push_failed':
      // 既有 schedulePushRetry 负责重推；成功转 pending_apply 后由本策略接管应用。
      // 重推定时器自身保证失败也持久退避重排（开启时），不会零复查停推。
      return { action: 'none', reason: 'push-retry-owned' };
    case 'privacy_blocked':
      // 隐私命中需要人工核对/拒绝重做路径，不自动改库。
      return { action: 'none', reason: 'privacy-blocked' };
    case 'privacy_blocked_local':
      // 本地阻断是定义好的条件等待（HEAD/工作区收口即自愈）：按退避周期复查条件，
      // 绝不 reset/stash/改库；条件恢复由 runAutonomyStep 的 reconcile 复核兑现。
      return { action: 'wait', reason: 'privacy-blocked-local' };
    default:
      return { action: 'none', reason: state.status || 'unknown' };
  }
}

/**
 * 返工启动判定（review_blocked/failed/interrupted/deferred 共用）：
 * - 脏文件全部落在续接凭据授权 UNION 内 → resume（runner 对当前工作区逐文件
 *   指纹独立实测；最常见的 review_rejected 留下的改动因此可以返工而不是永远延期）。
 * - 无凭据或越权脏文件 → wait（绝不 reset/stash）。
 * - 干净树但凭据记录过已验证指纹（in_run）→ 半成品已被提交/收走，凭据失效，
 *   走 fresh 真实重跑；干净树 + 无指纹记录 → resume 跳过已完成 research/plan。
 * - 无凭据 → fresh（review_blocked 走 retryReviewBlocked 语义，其余走诊断入口）。
 */
function planReworkLaunch(state, deps) {
  const checkpoint = state.collaboration?.checkpoint || null;
  const allowed = Array.isArray(checkpoint?.allowedFiles) ? checkpoint.allowedFiles : [];
  const rawFiles = typeof deps.worktreeFiles === 'function' ? deps.worktreeFiles() : undefined;
  const files = Array.isArray(rawFiles) ? rawFiles : null;
  if (files && files.length) {
    if (!checkpoint || !allowed.length || !files.every(file => allowed.includes(file))) {
      return { action: 'wait', reason: 'dirty-worktree' };
    }
    return { action: 'launch', kind: 'resume', payload: {} };
  }
  if (files && !files.length && checkpoint && checkpoint.kind !== 'post_apply'
    && Object.keys(checkpoint.fileFingerprints || {}).length) {
    return { action: 'launch', kind: 'fresh', payload: {} };
  }
  // in_run 基线漂移（2026-10-05 Main 附录）：原任务凭据钉在旧 HEAD（如零写入
  // 验证失败轮）；基线一旦前进而凭据未跟上，旧逻辑对「干净树+空指纹」一律
  // resume，runner 会按 baselineHead !== baseCommit 判 head_changed 拒绝（隔离
  // 反例实证旧路由 resume vs 期望 fresh）。只有两侧都实证（worktreeFiles 证明
  // 干净 + gitHead 非空且异于凭据基线）才选 fresh（Parent 既有 fresh 重试保留
  // 批次/任务身份，重新经过主 Agent 诊断（适用时）/研究和方案批准链，不沿用旧
  // 批准、不伪造续接）；脏树已在上文返回，永不弃凭据/换范围；gitHead 未注入或
  // 为空 = 无证明，保守 resume 交 runner 实测拒绝。post_apply（patchHead 精确
  // 匹配）不参与此判定。
  if (files && !files.length && checkpoint && checkpoint.kind !== 'post_apply') {
    const head = typeof deps.gitHead === 'function' ? String(deps.gitHead() || '') : '';
    if (head && checkpoint.baselineHead && head !== checkpoint.baselineHead) {
      return { action: 'launch', kind: 'fresh', payload: {} };
    }
  }
  return checkpoint
    ? { action: 'launch', kind: 'resume', payload: {} }
    : { action: 'launch', kind: 'fresh', payload: {} };
}

/**
 * repairOnly 应用后的续接凭据：协调进程 checkpoint 原样保留（授权 UNION、已完成
 * 阶段、原任务身份），kind 转为 post_apply 并补 patchHead=已应用提交。真伪仍由
 * runner 以当前工作区独立实测（干净树 + patchHead/baselineHead 均为 HEAD 祖先）。
 */
function continuationCheckpoint(state) {
  if (!state || state.status !== 'applied' || !state.collaboration?.repairOnly
    || !state.collaboration?.checkpoint || !state.commit) return null;
  return { ...state.collaboration.checkpoint, kind: 'post_apply', patchHead: state.commit };
}

module.exports = {
  REWORK_DELAY_BASE_MS, REWORK_DELAY_MAX_MS, NO_PROGRESS_DIAGNOSIS_ATTEMPTS,
  normalizeAutonomy, computeReworkDelayMs, reworkKey, autonomyTargetKey, shouldNotify, planAutonomy, continuationCheckpoint,
};
