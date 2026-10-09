'use strict';
// 自主策略（evolution-autonomy.js + activity-evolver 调度层）回归：
// - 纯决策：planAutonomy 各状态的动作/kind、退避与抖动界、通知去重、目标键稳定
//   （reason 文本/复核意见措辞变化不换目标；新提交才是新目标）。
// - 真实调度（2026-10-05 复审 R4 错配回归）：不安全脏树等条件的连续两跳必须排
//   真实未来 timer（读 scheduler registry 的 autonomy_rework.nextRunAt，不信
//   state 字段或手写 fake timer），间隔随 attempt 增长、不启动 Agent、不改仓库；
//   重启按剩余时间续等（不延长不归零）；复核意见措辞变化不把延迟打成 0；开关
//   关闭撤销 timer、重开不穿越授权立即执行；验证门缺失只 defer 不启动停服；
//   API 不泄露私有上下文（originalPrompt/checkpoint/批次）。
// 调度用例在子进程里跑：把 activity-evolver 源码拷进隔离 git 仓库（依赖经
// re-export shim 指回真实模块，scheduler 同实例 ⇒ registry 可读），REPO_ROOT
// 因此指向 fixture，git/工作区状态完全受控；结束必须 process.exit（真实 timer）。
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { test } = require('node:test');
const {
  normalizeAutonomy, computeReworkDelayMs, reworkKey, autonomyTargetKey,
  shouldNotify, planAutonomy, continuationCheckpoint, NO_PROGRESS_DIAGNOSIS_ATTEMPTS,
} = require('../src/services/evolution-autonomy');

const CANDIDATE_ROOT = path.join(__dirname, '..', '..');
const MIN = 60 * 1000;

test('退避间隔 10min×次数封顶 60min 加有界抖动；目标键只认任务不认措辞', () => {
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    const delay = computeReworkDelayMs(attempt);
    const base = Math.min(attempt, 6) * 10 * MIN;
    assert.ok(delay >= base && delay <= base + 90 * 1000, `attempt ${attempt}: ${delay}`);
  }
  assert.ok(computeReworkDelayMs(50) <= 60 * MIN + 90 * 1000);
  const task = {
    lastTask: 'safety', commit: '', autonomy: { originalPrompt: 'Original fixture prompt' },
    collaboration: { failure: { code: 'review_rejected', phase: 'review' }, reviewFeedback: 'Synthetic candidate needs revised acceptance' },
  };
  const target = autonomyTargetKey(task, 'rework');
  // 失败类别、reason 文本、复核意见措辞变化都不换目标。
  assert.equal(autonomyTargetKey({ ...task, status: 'interrupted' }, 'rework'), target);
  assert.equal(autonomyTargetKey({
    ...task,
    collaboration: { failure: { code: 'worktree_changed', phase: 'commit' }, reviewFeedback: '完全不同的意见措辞' },
  }, 'rework'), target);
  // 新原任务（换 prompt）/新待应用提交才是新目标。
  assert.notEqual(autonomyTargetKey({ ...task, autonomy: { originalPrompt: 'Another task' } }, 'rework'), target);
  assert.equal(autonomyTargetKey({ ...task, commit: 'abc123' }, 'apply'), 'apply@abc123');
  assert.notEqual(autonomyTargetKey({ ...task, commit: 'def456' }, 'apply'), 'apply@abc123');
  // 通知去重独立于目标键：同 reason 6 小时内不重复外呼。
  const now = Date.now();
  assert.equal(shouldNotify({ notifiedKey: 'wait:x', notifiedAt: now - MIN }, 'wait:x', now), false);
  assert.equal(shouldNotify({ notifiedKey: 'wait:x', notifiedAt: now - 7 * 60 * MIN }, 'wait:x', now), true);
  assert.equal(shouldNotify({ notifiedKey: 'wait:x', notifiedAt: now }, 'wait:y', now), true);
  assert.equal(normalizeAutonomy({ deferredTarget: 'x'.repeat(300) }).deferredTarget.length, 200);
  assert.ok(reworkKey(task).includes('review_rejected'));
});

test('planAutonomy：开关与状态到动作的映射（纯决策，无副作用）', () => {
  const base = { autonomousEvolutionEnabled: true };
  assert.deepEqual(planAutonomy({ ...base, status: 'idle' }, {}), { action: 'none', reason: 'idle' });
  assert.deepEqual(planAutonomy({ status: 'pending_apply', commit: 'c1' }, {}), { action: 'none', reason: 'disabled' });
  assert.deepEqual(planAutonomy({ ...base, status: 'pending_apply' }, {}), { action: 'none', reason: 'missing-commit' });
  assert.deepEqual(planAutonomy({ ...base, status: 'pending_apply', commit: 'c1' }, {}), { action: 'apply', strict: true });
  assert.deepEqual(planAutonomy({ ...base, status: 'applying' }, {}), { action: 'none', reason: 'applying' });
  assert.deepEqual(planAutonomy({ ...base, status: 'applied' }, {}), { action: 'none', reason: 'applied' });
  assert.deepEqual(planAutonomy({ ...base, status: 'push_failed' }, {}), { action: 'none', reason: 'push-retry-owned' });
  assert.deepEqual(planAutonomy({ ...base, status: 'privacy_blocked' }, {}), { action: 'none', reason: 'privacy-blocked' });
  assert.deepEqual(planAutonomy({ ...base, status: 'privacy_blocked_local' }, {}), { action: 'wait', reason: 'privacy-blocked-local' });
  // 手动轮失败留给用户；自动轮继续收口。
  assert.deepEqual(planAutonomy({ ...base, status: 'failed', lastRunAutomatic: false }, {}), { action: 'none', reason: 'manual-run' });
  const auto = { ...base, status: 'failed', lastRunAutomatic: true };
  assert.equal(planAutonomy(auto, {}).action, 'launch');
  // applied + repairOnly：有续接上下文才 continue，否则条件等待。
  const applied = { ...base, status: 'applied', collaboration: { repairOnly: true }, autonomy: {} };
  assert.deepEqual(planAutonomy(applied, {}), { action: 'wait', reason: 'missing-continuation' });
  const continuation = { task: 'safety', automatic: true, combinedDaily: true, activityPlan: { newUnknown: [7] } };
  assert.deepEqual(planAutonomy({ ...applied, autonomy: { continuation } }, {}),
    { action: 'launch', kind: 'continue', payload: normalizeAutonomy({ continuation }).continuation });
  // 返工启动判定：脏文件越权 → wait；授权内 → resume；干净树 + 已记录指纹 → fresh。
  const blocked = { ...base, status: 'review_blocked', collaboration: { checkpoint: { allowedFiles: ['core/src/a.js'] } } };
  assert.deepEqual(planAutonomy(blocked, { worktreeFiles: () => ['core/src/b.js'] }),
    { action: 'wait', reason: 'dirty-worktree' });
  assert.equal(planAutonomy(blocked, { worktreeFiles: () => ['core/src/a.js'] }).kind, 'resume');
  assert.equal(planAutonomy({ ...blocked, collaboration: { checkpoint: { allowedFiles: [], fileFingerprints: { 'core/src/a.js': 'x' } } } },
    { worktreeFiles: () => [] }).kind, 'fresh');
  // continuationCheckpoint 只在 applied+repairOnly+有提交时成立，并钉死 patchHead。
  assert.equal(continuationCheckpoint({ status: 'pending_apply' }), null);
  assert.deepEqual(continuationCheckpoint({ status: 'applied', commit: 'patch1', collaboration: { repairOnly: true, checkpoint: { allowedFiles: ['a'] } } }),
    { allowedFiles: ['a'], kind: 'post_apply', patchHead: 'patch1' });
  assert.ok(NO_PROGRESS_DIAGNOSIS_ATTEMPTS >= 2);
});

// in_run 基线漂移路由（2026-10-05 Main 附录）。已观察到的状态：原任务 in_run
// checkpoint 钉在旧 HEAD（completed diagnose/repair、filesFingerprints={} 零写入、
// 验证失败、无脏候选）；在隔离仓库的新 HEAD 上做策略回归，实证旧 planReworkLaunch
// 对「干净树 + 空指纹」选 resume 而 runner 会按 baselineHead !== baseCommit 判
// head_changed 拒绝（隔离反例，非线上重复观测）。新合同：只有 worktreeFiles
// 实证 [] 且 gitHead 实证非空且异于 in_run baselineHead 才选 fresh（走 Parent
// 既有 fresh 重试，批次/任务身份保留，重新经过主 Agent 诊断（适用时）/研究和
// 方案批准链，不沿用旧批准）；脏树永不弃凭据/换范围/选 fresh；post_apply 语义
// 不变；gitHead 未注入或为空 = 无证明，保守 resume 交 runner 实测拒绝。
test('planReworkLaunch：干净树+in_run 基线漂移选 fresh；同 HEAD resume；脏树不弃候选；post_apply 不变', () => {
  const base = { autonomousEvolutionEnabled: true, status: 'review_blocked', lastRunAutomatic: true };
  const oldHead = 'a'.repeat(40);
  const newHead = 'b'.repeat(40);
  const stale = { ...base, collaboration: { checkpoint: { kind: 'in_run', baselineHead: oldHead,
    allowedFiles: [], fileFingerprints: {}, completed: [{ phase: 'diagnose' }, { phase: 'repair' }] } } };
  // 1) 干净树 + HEAD 已前进（维护发布）→ fresh：真实新基线诊断链，不伪造续接。
  assert.deepEqual(planAutonomy(stale, { worktreeFiles: () => [], gitHead: () => newHead }),
    { action: 'launch', kind: 'fresh', payload: {} });
  // 2) 干净树 + 同 HEAD → resume：凭据仍真实可用，跳过已完成阶段。
  assert.equal(planAutonomy(stale, { worktreeFiles: () => [], gitHead: () => oldHead }).kind, 'resume');
  // 3) gitHead 未注入/为空 = 无证明，不得凭空选 fresh（runner 继续实测拒绝）。
  assert.equal(planAutonomy(stale, { worktreeFiles: () => [] }).kind, 'resume');
  assert.equal(planAutonomy(stale, { worktreeFiles: () => [], gitHead: () => '' }).kind, 'resume');
  // 4) 脏树（授权内）+ HEAD 已漂移：绝不弃 checkpoint/不换范围/不选 fresh——
  //    resume 交 runner，runner 的 head_changed 拒绝保留候选等待人工/发布收口。
  const dirty = { ...stale, collaboration: { checkpoint: { kind: 'in_run', baselineHead: oldHead,
    allowedFiles: ['core/src/a.js'], fileFingerprints: {}, completed: [] } } };
  assert.equal(planAutonomy(dirty, { worktreeFiles: () => ['core/src/a.js'], gitHead: () => newHead }).kind, 'resume');
  // 脏树越权照旧 wait（未被漂移规则改变）。
  assert.deepEqual(planAutonomy(dirty, { worktreeFiles: () => ['core/src/zz.js'], gitHead: () => newHead }),
    { action: 'wait', reason: 'dirty-worktree' });
  // 5) post_apply：patchHead 精确匹配语义不参与基线漂移 fresh（只按原规则 resume）。
  const postApply = { ...base, collaboration: { checkpoint: { kind: 'post_apply', baselineHead: oldHead,
    patchHead: oldHead, allowedFiles: [], fileFingerprints: {} } } };
  assert.equal(planAutonomy(postApply, { worktreeFiles: () => [], gitHead: () => newHead }).kind, 'resume');
  // 6) 既有规则不回退：干净树 + 非空 fileFingerprints（半成品已被收走）仍 fresh。
  const collected = { ...base, collaboration: { checkpoint: { kind: 'in_run', baselineHead: newHead,
    allowedFiles: [], fileFingerprints: { 'core/src/a.js': 'x' } } } };
  assert.equal(planAutonomy(collected, { worktreeFiles: () => [], gitHead: () => newHead }).kind, 'fresh');
});

// 隔离仓库里的真实调度子进程：拷贝 Parent 源码 + 依赖 re-export shim（与 Main 的
// Parent+CLI 复核 harness 同构），REPO_ROOT 落在 fixture，git 状态受控。
const CHILD_SOURCE = [
  'const fs = require("node:fs");',
  'const os = require("node:os");',
  'const path = require("node:path");',
  'const crypto = require("node:crypto");',
  'const assert = require("node:assert/strict");',
  'const { execFileSync } = require("node:child_process");',
  'const candidate = process.argv[2];',
  'const phase = process.argv[3];',
  'const dir = fs.mkdtempSync(path.join(os.tmpdir(), "farm-autonomy-live-"));',
  'const write = (file, data) => {',
  '  const full = path.resolve(dir, file);',
  '  // 外穿硬拒：相对 ..、绝对路径或解析后落在 fixture 之外的写入目标，必须在写任何',
  '  // 数据前抛错（曾因 relative 基准选错把候选真实源码覆盖成 shim，2026-10-05）。',
  '  if (full !== dir && !full.startsWith(dir + path.sep)) throw new Error("fixture_escape:" + file);',
  '  fs.mkdirSync(path.dirname(full), { recursive: true }); fs.writeFileSync(full, data);',
  '};',
  'const git = args => execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();',
  'const parentFile = "core/src/services/activity-evolver.js";',
  'const parentText = fs.readFileSync(path.join(candidate, parentFile), "utf8");',
  'write(parentFile, parentText);',
  'for (const match of parentText.matchAll(/require\\([\'"](\\.[^\'"]+)[\'"]\\)/g)) {',
  '  const actual = require.resolve(path.resolve(path.dirname(path.join(candidate, parentFile)), match[1]));',
  '  // shim 落点镜像候选仓内相对路径（基准=candidate，绝不能是 fixture dir，否则',
  '  // path.relative 产生 ../../data/... 让 write 回到真实源）；越出候选仓的依赖直接拒。',
  '  const relative = path.relative(candidate, actual);',
  '  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("unexpected_dependency:" + match[1]);',
  '  write(relative, "module.exports=require(" + JSON.stringify(actual) + ");\\n");',
  '}',
  'write(".gitignore", "core/data/\\ntmp/\\n");',
  'write("docs/HANDOFF.md", "Fixture constraints\\n");',
  'write("core/src/example.js", "module.exports = 1;\\n");',
  'write("core/test/example.test.js", "require(\\"node:assert/strict\\").ok([1,2].includes(require(\\"../src/example\\")));\\n");',
  'git(["init", "-q"]);',
  'git(["config", "user.name", "Autonomy fixture"]);',
  'git(["config", "user.email", "fixture@users.noreply.github.com"]);',
  'git(["add", "."]);',
  'git(["commit", "-qm", "fixture"]);',
  'const base = git(["rev-parse", "HEAD"]);',
  'process.env.FARM_DATA_DIR = path.join(dir, "core/data");',
  'write("core/data/.keep", "");',
  '// 未授权脏文件：没有任何 checkpoint 授权过它（仅 main 阶段需要脏树；persist/',
  '// newbaseline 阶段要求干净树）。',
  'if (phase === "main") write("unauthorized.txt", "local edit\\n");',
  'const statePath = path.join(dir, "core/data/activity-evolve-state.json");',
  'const prompt = "Original fixture prompt";',
  'const target = "rework@safety|" + crypto.createHash("sha256").update(prompt).digest("hex").slice(0, 16) + "|";',
  'const writeState = value => write("core/data/activity-evolve-state.json", JSON.stringify(value, null, 2));',
  'const readState = () => JSON.parse(fs.readFileSync(statePath, "utf8"));',
  'const blockedState = autonomy => ({',
  '  status: "review_blocked", lastTask: "safety", lastRunAutomatic: true, autonomousEvolutionEnabled: true,',
  '  collaboration: { status: "failed", phase: "failed",',
  '    failure: { code: "review_rejected", phase: "review", recoverable: true },',
  '    reviewFeedback: "Synthetic candidate needs revised acceptance", checkpoint: null },',
  '  autonomy: Object.assign({ originalPrompt: prompt, roundId: "r1" }, autonomy || {}),',
  '});',
  'const service = require(path.join(dir, parentFile));',
  'const { getSchedulerRegistrySnapshot } = require(path.join(candidate, "core/src/services/scheduler.js"));',
  'const nextAutonomyRunAt = () => {',
  '  const scheduler = getSchedulerRegistrySnapshot("activity_evolver").schedulers[0];',
  '  const task = (scheduler && scheduler.tasks || []).find(item => item.name === "autonomy_rework");',
  '  return task ? task.nextRunAt : 0;',
  '};',
  'const out = { phase };',
  '(async () => {',
  '  if (phase === "persist") {',
  '    // 期限持久化缺陷（2026-10-05 Main 终检）：失败退避调度（无既有 nextReworkAt）',
  '    // 的正延迟此前只进 registry 不落盘——重启重排整段间隔、UI 无截止时刻。',
  '    writeState(blockedState({ deferredTarget: target, reworkAttempts: 1, nextReworkAt: 0 }));',
  '    const t0 = Date.now();',
  '    out.delay = service.scheduleAutonomyFromState();',
  '    out.registryIn = nextAutonomyRunAt() - t0;',
  '    out.persistedIn = readState().autonomy.nextReworkAt - t0;',
  '    const counters = readState().autonomy;',
  '    out.countersKept = counters.reworkAttempts === 1 && counters.deferredTarget === target;',
  '    out.repoClean = git(["status", "--porcelain"]) === "";',
  '    // 重启语义（同进程再调度 = 新进程读同一状态文件）：按剩余时间续等，',
  '    // 不延长成新整段、不归零、不清计数。',
  '    out.rescheduleDelay = service.scheduleAutonomyFromState();',
  '    out.rescheduleAttempts = readState().autonomy.reworkAttempts;',
  '    // 同基线关/开：未来期限必须原样保留，不得被任何立即通道跳过。',
  '    service.setAutonomousEvolution(false);',
  '    out.toggleOffTimerCleared = nextAutonomyRunAt() === 0;',
  '    const deadlineOff = readState().autonomy.nextReworkAt;',
  '    service.setAutonomousEvolution(true);',
  '    out.reopenIn = nextAutonomyRunAt() - Date.now();',
  '    out.deadlinePreservedAcrossToggle = readState().autonomy.nextReworkAt === deadlineOff;',
  '    process.stdout.write(JSON.stringify(out));',
  '    return;',
  '  }',
  '  if (phase === "newbaseline") {',
  '    // 已接受维护部署：前进 HEAD + 干净树 + in_run 凭据基线 != HEAD → fresh 立即',
  '    // 一跳装载新代码；旧失败退避（未来 20min 期限）不得推迟。fixture 无',
  '    // origin/main，0 延迟 timer 触发的 runAutonomyStep 会诚实 launch 失败 defer',
  '    // （launch:* 键）——随后调度必须尊重退避（立即通道不得变成紧循环）。',
  '    write("core/src/deployed.js", "module.exports = 2;\\n");',
  '    git(["add", "."]);',
  '    git(["commit", "-qm", "accepted maintenance deployment"]);',
  '    writeState({ status: "review_blocked", lastTask: "safety", lastRunAutomatic: true,',
  '      autonomousEvolutionEnabled: true,',
  '      collaboration: { status: "failed", phase: "failed",',
  '        failure: { code: "verification_failed", phase: "verify", recoverable: true },',
  '        checkpoint: { kind: "in_run", baselineHead: base, allowedFiles: [], fileFingerprints: {} } },',
  '      autonomy: { originalPrompt: prompt, roundId: "r1", deferredTarget: target,',
  '        reworkAttempts: 1, nextReworkAt: Date.now() + 20 * 60 * 1000 } });',
  '    out.freshDelay = service.scheduleAutonomyFromState();',
  '    out.freshRegistryImmediate = nextAutonomyRunAt() > 0 && nextAutonomyRunAt() - Date.now() <= 2000;',
  '    out.repoClean = git(["status", "--porcelain"]) === "";',
  '    await new Promise(resolve => setTimeout(resolve, 500));',
  '    const after = readState();',
  '    out.launchDeferred = String(after.autonomy.lastReworkKey || "").startsWith("launch:");',
  '    out.afterFailDelay = service.scheduleAutonomyFromState();',
  '    out.countersKept = after.autonomy.reworkAttempts >= 2;',
  '    out.noAgentRun = !after.activeRun;',
  '    out.checkpointPreserved = !!after.collaboration.checkpoint',
  '      && after.collaboration.checkpoint.baselineHead === base;',
  '    process.stdout.write(JSON.stringify(out));',
  '    return;',
  '  }',
  '  if (phase === "restart") {',
  '    // 重启续等：持久 nextReworkAt 还剩 ~5min，同目标 ⇒ 按剩余排，不延长不归零。',
  '    writeState(blockedState({ deferredTarget: target, reworkAttempts: 3, nextReworkAt: Date.now() + 5 * 60 * 1000 }));',
  '    out.restartDelay = service.scheduleAutonomyFromState();',
  '    out.restartRegistryIn = nextAutonomyRunAt() - Date.now();',
  '    process.stdout.write(JSON.stringify(out));',
  '    return;',
  '  }',
  '  writeState(blockedState());',
  '  const headBefore = git(["rev-parse", "HEAD"]);',
  '  const treeBefore = git(["status", "--porcelain"]);',
  '  // 首次接管（无 defer 记录）允许立即一跳。',
  '  out.firstDelay = service.scheduleAutonomyFromState();',
  '  await service.runAutonomyStep();',
  '  let state = readState();',
  '  assert.equal(state.status, "review_blocked");',
  '  assert.equal(state.autonomy.reworkAttempts, 1);',
  '  assert.equal(state.autonomy.deferredTarget, target);',
  '  const hop1 = nextAutonomyRunAt() - Date.now();',
  '  out.hop1RegistryIn = hop1;',
  '  // 第二跳：同目标真实退避增长（10min 档 → 20min 档），期间不启动 Agent 不改仓库。',
  '  await service.runAutonomyStep();',
  '  state = readState();',
  '  assert.equal(state.autonomy.reworkAttempts, 2);',
  '  assert.equal(state.autonomy.preferDiagnosis, true);',
  '  const hop2 = nextAutonomyRunAt() - Date.now();',
  '  out.hop2RegistryIn = hop2;',
  '  out.repoUntouched = git(["rev-parse", "HEAD"]) === headBefore && git(["status", "--porcelain"]) === treeBefore',
  '    && fs.readFileSync(path.join(dir, "unauthorized.txt"), "utf8") === "local edit\\n";',
  '  out.noAgentRun = state.status === "review_blocked" && !state.activeRun;',
  '  // 复核意见措辞变化（reworkKey 摘要变）不得把延迟打成 0。',
  '  const beforeWording = readState();',
  '  beforeWording.collaboration.reviewFeedback = "完全不同的意见措辞";',
  '  beforeWording.collaboration.failure = { code: "worktree_changed", phase: "commit", recoverable: true };',
  '  writeState(beforeWording);',
  '  out.wordingChangeDelay = service.scheduleAutonomyFromState();',
  '  // 开关关闭撤销真实 timer；重开不穿越授权（仍按剩余退避，不立即拉模型）。',
  '  service.setAutonomousEvolution(false);',
  '  out.timerClearedOnDisable = nextAutonomyRunAt() === 0;',
  '  out.toggleOffSummaryKept = readState().summary.includes("自主进化已关闭");',
  '  const reopened = service.setAutonomousEvolution(true);',
  '  out.reopenImmediate = false;',
  '  out.reopenDelay = nextAutonomyRunAt() - Date.now();',
  '  out.reopenOk = reopened.ok === true;',
  '  // 验证门缺失：pending_apply 的自主应用在停服前 defer，不启动任何重启。',
  '  writeState({ status: "pending_apply", commit: base, lastTask: "safety", autonomousEvolutionEnabled: true,',
  '    dualAgentEnabled: true, collaboration: { status: "completed", phase: "complete", head: base, decision: "approve" },',
  '    autonomy: { originalPrompt: prompt } });',
  '  await service.runAutonomyStep();',
  '  state = readState();',
  '  out.validationDeferKey = state.autonomy.notifiedKey;',
  '  out.validationApplyAttempts = state.autonomy.applyAttempts;',
  '  out.validationStillPending = state.status === "pending_apply";',
  '  // API 隐私：公开状态不带原 prompt/续接计划/checkpoint。',
  '  state.candidateTaskRoot = path.join(dir, "tmp/private-task");',
  '  state.agentSessionId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";',
  '  state.activeRun = { runId: "private-status", baseCommit: base, taskRoot: state.candidateTaskRoot };',
  '  writeState(state);',
  '  const publicState = service.getEvolveState();',
  '  out.leaksOriginalPrompt = Object.hasOwn(publicState.autonomy || {}, "originalPrompt");',
  '  out.leaksCheckpoint = publicState.collaboration ? Object.hasOwn(publicState.collaboration, "checkpoint") && publicState.collaboration.checkpoint !== null : false;',
  '  assert.equal(Object.hasOwn(publicState, "candidateTaskRoot"), false);',
  '  assert.equal(Object.hasOwn(publicState.activeRun || {}, "taskRoot"), false);',
  '  assert.equal(Object.hasOwn(publicState, "agentSessionId"), false);',
  '  process.stdout.write(JSON.stringify(out));',
  // 真实 10min timer 会让事件循环挂着：跑完必须显式退出（spawnSync 才能返回）。',
  '})().then(() => process.exit(0)).catch(error => { process.stderr.write(String(error && error.stack || error)); process.exit(1); });',
].join('\n');

// 候选仓指纹：child 只许读，不许改——夹具再出外穿/误写，这里立即失败而不是静默损坏源码。
function candidateFingerprint() {
  const hash = crypto.createHash('sha256');
  hash.update(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: CANDIDATE_ROOT, encoding: 'utf8' }));
  hash.update(execFileSync('git', ['status', '--porcelain', '-z'], { cwd: CANDIDATE_ROOT, encoding: 'utf8' }));
  for (const file of ['core/src/services/activity-evolver.js', 'core/src/services/evolution-autonomy.js',
    'core/src/services/evolution-team.js', 'core/src/services/scheduler.js']) {
    hash.update(fs.readFileSync(path.join(CANDIDATE_ROOT, file)));
  }
  return hash.digest('hex');
}

function runChild(phase) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'farm-autonomy-child-'));
  const before = candidateFingerprint();
  try {
    const script = path.join(dir, 'child.cjs');
    fs.writeFileSync(script, CHILD_SOURCE);
    const child = spawnSync(process.execPath, [script, CANDIDATE_ROOT, phase],
      { encoding: 'utf8', timeout: 120_000, env: { ...process.env, FARM_DATA_DIR: dir } });
    return { status: child.status, stdout: child.stdout, stderr: child.stderr,
      candidateUntouched: candidateFingerprint() === before };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('真实 scheduler registry：不安全脏树两跳退避增长、措辞变化不归零、开关不穿越', () => {
  const child = runChild('main');
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.candidateUntouched, true, '子进程不得改动候选仓源码或工作区');
  const out = JSON.parse(child.stdout.trim().split('\n').pop());
  assert.equal(out.firstDelay, 0, '首次接管允许立即一跳');
  assert.ok(out.hop1RegistryIn >= 10 * MIN && out.hop1RegistryIn <= 10 * MIN + 90 * 1000 + 2000,
    `hop1 应排 ~10min 真实未来 timer，实际 ${out.hop1RegistryIn}`);
  assert.ok(out.hop2RegistryIn >= 20 * MIN && out.hop2RegistryIn <= 20 * MIN + 90 * 1000 + 2000,
    `hop2 应随 attempt 增长到 ~20min，实际 ${out.hop2RegistryIn}`);
  assert.ok(out.hop2RegistryIn > out.hop1RegistryIn);
  assert.equal(out.repoUntouched, true, '条件等待不得修改仓库');
  assert.equal(out.noAgentRun, true, '条件等待不得启动 Agent');
  assert.ok(out.wordingChangeDelay > 5 * MIN, `意见措辞变化后延迟不得归零，实际 ${out.wordingChangeDelay}`);
  assert.equal(out.timerClearedOnDisable, true, '关闭自主必须撤销真实 timer');
  assert.equal(out.toggleOffSummaryKept, true);
  assert.equal(out.reopenOk, true);
  assert.ok(out.reopenDelay > 5 * MIN, `重开不得穿越授权立即执行，实际 ${out.reopenDelay}`);
  assert.match(out.validationDeferKey, /^apply-validation-/, '验证记录缺失应按 validation-* 键 defer');
  assert.equal(out.validationApplyAttempts, 1);
  assert.equal(out.validationStillPending, true, '验证门未过必须保持待应用，不启动停服');
  assert.equal(out.leaksOriginalPrompt, false);
  assert.equal(out.leaksCheckpoint, false);
});

// 调度期限持久化 + 新基线立即 fresh（真实 Parent scheduler registry + 真实 git
// 子进程夹具，非 fake dueAt 元数据）：registry 与持久 nextReworkAt 必须一致；
// 重启按剩余续等；同基线关开不跳期限；干净新基线 fresh 立即一跳且不伪造任何
// 审批/checkpoint，launch 失败后立即通道退回普通退避（防紧循环）。
test('scheduleAutonomyFromState：正延迟期限落盘、剩余续等、关开保留、新基线立即 fresh', () => {
  const persist = runChild('persist');
  assert.equal(persist.status, 0, persist.stderr);
  assert.equal(persist.candidateUntouched, true, '子进程不得改动候选仓源码或工作区');
  const p = JSON.parse(persist.stdout.trim().split('\n').pop());
  assert.ok(p.delay >= 10 * MIN && p.delay <= 10 * MIN + 90 * 1000 + 2000,
    `失败退避首跳应排 ~10min，实际 ${p.delay}`);
  assert.ok(p.persistedIn >= 10 * MIN, `真实期限必须落盘（nextReworkAt 未来），实际 ${p.persistedIn}`);
  assert.ok(Math.abs(p.registryIn - p.persistedIn) < 5000,
    `registry 与持久期限必须一致：registry ${p.registryIn} vs 持久 ${p.persistedIn}`);
  assert.equal(p.countersKept, true, '期限落盘不得重置计数/目标键');
  assert.equal(p.repoClean, true);
  assert.ok(p.rescheduleDelay > 5 * MIN && p.rescheduleDelay <= p.delay,
    `重启（再调度）按剩余续等不延长：${p.rescheduleDelay} vs 首跳 ${p.delay}`);
  assert.equal(p.rescheduleAttempts, 1, '续等不清计数');
  assert.equal(p.toggleOffTimerCleared, true, '关闭必须撤销真实 timer');
  assert.ok(p.reopenIn > 5 * MIN, `同基线重开不得跳过既有未来期限，实际 ${p.reopenIn}`);
  assert.equal(p.deadlinePreservedAcrossToggle, true, '关开不得改写持久期限');

  const nb = runChild('newbaseline');
  assert.equal(nb.status, 0, nb.stderr);
  assert.equal(nb.candidateUntouched, true, '子进程不得改动候选仓源码或工作区');
  const n = JSON.parse(nb.stdout.trim().split('\n').pop());
  assert.equal(n.freshDelay, 0, `干净新基线 fresh 必须立即（不背旧退避），实际 ${n.freshDelay}`);
  assert.equal(n.freshRegistryImmediate, true, 'registry 必须排出立即执行');
  assert.equal(n.repoClean, true);
  assert.equal(n.launchDeferred, true, 'fixture 无 origin 时 launch 必须诚实失败 defer');
  assert.ok(n.afterFailDelay > 5 * MIN, `launch 失败后的调度必须尊重退避（防紧循环），实际 ${n.afterFailDelay}`);
  assert.equal(n.countersKept, true, '立即通道保留计数/失败史');
  assert.equal(n.noAgentRun, true, '不得启动真实 Agent');
  assert.equal(n.checkpointPreserved, true, '不得伪造/改写 checkpoint 审批状态');
});

test('重启按剩余退避续等：不延长成新整段、不归零', () => {
  const child = runChild('restart');
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.candidateUntouched, true, '子进程不得改动候选仓源码或工作区');
  const out = JSON.parse(child.stdout.trim().split('\n').pop());
  assert.ok(out.restartDelay > 4 * MIN && out.restartDelay <= 5 * MIN + 5000,
    `重启应续等剩余 ~5min，实际 ${out.restartDelay}`);
  assert.ok(out.restartRegistryIn > 4 * MIN && out.restartRegistryIn <= 5 * MIN + 5000,
    `registry 应挂同一剩余时间，实际 ${out.restartRegistryIn}`);
});

// ---------------------------------------------------------------------------
// Legacy 自主续接（2026-10-05 上线前检查）：旧格式 review_blocked 状态（无
// checkpoint、无 autonomy 链条字段、failure=diagnosis_stopped + lastFailure=
// cli_exit review）由 runAutonomyStep 接管时，必须走 retryReviewBlocked 的自主
// 模式：真实 Parent+runner+CLI 全链路（不 stub launch），首跳 = 主 Agent 新诊断
// 旧底层失败（diagnose:codex 先行），随后走全新 plan 批准链合法写入；原
// feedback 水位/名额日期/GitHub 批次摘要全程保持（runner journal 的 taskIdentity
// 是 Parent 实际喂入的持久凭据），不另记手动日期、不重采批次、发布到远端后
// pending_apply。人工按钮无参语义由 evolution-review-retry 既有用例守护。
// ---------------------------------------------------------------------------
const LEGACY_CHILD_SOURCE = [
  'const fs = require("node:fs");',
  'const os = require("node:os");',
  'const path = require("node:path");',
  'const assert = require("node:assert/strict");',
  'const { execFileSync } = require("node:child_process");',
  'const candidate = process.argv[2];',
  // 夹具内环境隔离（2026-10-05 真实失败，仅本进程）：生产 runner 经 GIT_CONFIG_*
  // 注入 core.hooksPath=进化 pre-push（agent 推送被真 hook 拒绝：'automatic
  // evolution agents cannot push'）。测试进程若继承该注入，夹具对本地 bare 的一切
  // git push（初始化与 Parent 隐私门发布）都会被拒。先记录注入形态再删除——
  // 隔离边界=本合成夹具进程，绝不改测试进程/全局 env 或 hooks 本体。
  'const injectedHook = process.env.GIT_CONFIG_VALUE_0 || "";',
  'for (const key of Object.keys(process.env)) {',
  '  if (/^GIT_CONFIG_(COUNT|KEY_\\d+|VALUE_\\d+)$/.test(key)) delete process.env[key];',
  '}',
  'const envClean = !process.env.GIT_CONFIG_COUNT;',
  'const dir = fs.mkdtempSync(path.join(os.tmpdir(), "farm-autonomy-legacy-"));',
  'let externalBare = null;',
  'const write = (file, data, mode) => {',
  '  const full = path.resolve(dir, file);',
  '  // 外穿硬拒：解析后落在 fixture 之外的写入目标，必须在写任何数据前抛错。',
  '  if (full !== dir && !full.startsWith(dir + path.sep)) throw new Error("fixture_escape:" + file);',
  '  fs.mkdirSync(path.dirname(full), { recursive: true }); fs.writeFileSync(full, data, { mode: mode || 0o600 });',
  '};',
  'const git = args => execFileSync("git", args, { cwd: dir, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();',
  'const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));',
  'async function wait(predicate, label) {',
  '  for (let i = 0; i < 400; i++) { const value = predicate(); if (value) return value; await sleep(150); }',
  '  throw new Error("timeout_" + label);',
  '}',
  // 真实 Parent 源码 + re-export shim（依赖指回候选仓真实模块；scheduler 同实例）。
  'const parentFile = "core/src/services/activity-evolver.js";',
  'const parentText = fs.readFileSync(path.join(candidate, parentFile), "utf-8");',
  'write(parentFile, parentText);',
  'for (const match of parentText.matchAll(/require\\([\'"](\\.[^\'"]+)[\'"]\\)/g)) {',
  '  const actual = require.resolve(path.resolve(path.dirname(path.join(candidate, parentFile)), match[1]));',
  '  const relative = path.relative(candidate, actual);',
  '  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("unexpected_dependency:" + match[1]);',
  '  write(relative, "module.exports=require(" + JSON.stringify(actual) + ");\\n");',
  '}',
  'write("core/scripts/run-evolution-team.js", fs.readFileSync(path.join(candidate, "core/scripts/run-evolution-team.js")));',
  // runner 独有依赖：countercheck 用真实模块；references 需要脱敏发现桩（不联网）。
  'write("core/src/services/evolution-countercheck.js", "module.exports=require("',
  '  + JSON.stringify(path.join(candidate, "core/src/services/evolution-countercheck.js")) + ");\\n");',
  'write("core/src/services/evolution-references.js", "module.exports={...require("',
  '  + JSON.stringify(path.join(candidate, "core/src/services/evolution-references.js"))',
  '  + "),collectPublicReferences:async()=>({state:\\"complete\\",discoveryComplete:true})};\\n");',
  // runner 现也依赖原生会话登记模块（Parent 的 evolution-worktree 已被上方
  // 相对依赖正则自动 shim；evolution-sessions 只有 runner 引用，需显式 shim）。
  'write("core/src/services/evolution-sessions.js", "module.exports=require("',
  '  + JSON.stringify(path.join(candidate, "core/src/services/evolution-sessions.js")) + ");\\n");',
  'write(".gitignore", "core/data/\\ntmp/\\n");',
  'write("docs/HANDOFF.md", "Fixture constraints\\n");',
  'write("core/src/example.js", "module.exports = 1;\\n");',
  'write("core/test/example.test.js", "require(\\"node:test\\")(\\"fixture\\",()=>require(\\"node:assert/strict\\").ok([1,2].includes(require(\\"../src/example\\"))));\\n");',
  // 真实 CLI 桩：initialFailure 恢复链 diagnose→repair→repair_review 后全新
  // research→plan→implement→review；plan 给出真实批准范围，implement 真实写文件。
  'const callsLog = path.join(dir, "core/data/calls.log");',
  'const cli = `#!/usr/bin/env node',
  'const fs=require("node:fs");',
  'const SESSION={claude:"aaaa1111-2222-3333-4444-555566667777",codex:"bbbb8888-9999-aaaa-bbbb-ccccddddeeee"};',
  'if(process.argv[2]==="app-server"){let buffer="";process.stdin.setEncoding("utf8");',
  'process.stdin.on("data",chunk=>{buffer+=chunk;let index;',
  'while((index=buffer.indexOf("\\\\n"))>=0){const line=buffer.slice(0,index);buffer=buffer.slice(index+1);',
  'if(!line)continue;let value;try{value=JSON.parse(line);}catch{continue;}',
  'if(value.id===undefined||!value.method)continue;',
  'const reply=result=>process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:value.id,result})+"\\\\n");',
  'if(value.method==="thread/read"||value.method==="thread/resume")reply({thread:{id:value.params.threadId}});',
  'else if(value.method==="thread/compact/start"){reply({});',
  'for(const method of ["item/started","item/completed"])process.stdout.write(JSON.stringify({jsonrpc:"2.0",method,params:{threadId:value.params.threadId,item:{type:"contextCompaction"}}})+"\\\\n");',
  '}else reply({});}});return;}',
  'let prompt="";',
  'process.stdin.setEncoding("utf8");',
  'process.stdin.on("data",c=>prompt+=c);',
  'process.stdin.on("end",()=>{',
  ' if(prompt==="/compact"){',
  '  process.stdout.write(JSON.stringify({type:"system",subtype:"compact_boundary",session_id:SESSION.claude})+"\\\\n");',
  '  process.stdout.write(JSON.stringify({type:"result",subtype:"success",is_error:false,session_id:SESSION.claude})+"\\\\n");return;}',
  ' const phase=prompt.match(/只完成 (\\\\w+) 阶段/)[1];',
  // Stage C：Agent CLI 的 cwd 是隔离任务工作区（其 core/data 不在提交里），
  // 调用流水必须写回 fixture 的绝对路径，测试侧才能读到完整批准链。
  // eslint-disable-next-line no-template-curly-in-string
  ' fs.appendFileSync(${JSON.stringify(callsLog)},phase+":"+(process.argv.includes("exec")?"codex":"claude")+"\\\\n");',
  ' const decisions={research:"researched",revise_plan:"researched",plan:"approve",implement:"implemented",review:"approve",diagnose:"repair",repair:"no_change",repair_review:"approve",patch_review:"approve"};',
  ' const result={decision:decisions[phase],summary:"Legacy synthetic stage"};',
  ' if(phase==="plan"){result.allowedFiles=["core/src/example.js","docs/HANDOFF.md"];result.acceptanceChecks=["example stays within synthetic values"];result.baselineChecks=[];}',
  ' if(phase==="diagnose")result.allowedFiles=[];',
  ' if(["plan","review"].includes(phase)){result.feedbackReviewed=false;result.lessons=[];}',
  ' if(phase==="review")result.githubResolutions=[];',
  ' if(phase==="implement"){fs.writeFileSync("core/src/example.js","module.exports = 2;\\\\n");fs.appendFileSync("docs/HANDOFF.md","B2 chain update\\\\n");}',
  ' if(process.argv.includes("exec")){',
  '  if(process.argv.includes("--json"))process.stdout.write(JSON.stringify({type:"thread.started",thread_id:SESSION.codex})+"\\\\n");',
  '  fs.writeFileSync(process.argv[process.argv.indexOf("--output-last-message")+1],JSON.stringify(result));}',
  ' else process.stdout.write(JSON.stringify({subtype:"success",is_error:false,session_id:SESSION.claude,structured_output:result}));',
  '});`;',
'write("core/data/fake-cli", cli, 0o700);',
  'git(["init", "-q", "-b", "main"]);',
  'git(["config", "user.name", "Legacy autonomy fixture"]);',
  'git(["config", "user.email", "fixture@users.noreply.github.com"]);',
  'git(["add", "."]);',
  'git(["commit", "-qm", "fixture"]);',
  // 远端 bare 放 fixture 目录外（不落在被测工作树里）。
  'const bareHere = path.join(dir, "remote.git");',
  'execFileSync("git", ["init", "--bare", "-q", bareHere]);',
  'externalBare = path.join(os.tmpdir(), "farm-autonomy-legacy-bare-" + path.basename(dir));',
  'fs.renameSync(bareHere, externalBare);',
  'git(["remote", "add", "origin", externalBare]);',
  'git(["push", "-q", "-u", "origin", "main"]);',
  // 旧格式状态：无 checkpoint、无 autonomy 链条字段（真实 Root 2026-10-05 形态）。
  'const legacyThroughAt = Date.now() - 3600_000;',
  'const legacyGithub = { capturedAt: Date.now() - 7200_000, complete: true, issueNumbers: [101],',
  '  fingerprint: "a".repeat(64), payloadDigest: "b".repeat(64) };',
  'const statePath = path.join(dir, "core/data/activity-evolve-state.json");',
  'write(statePath, JSON.stringify({',
  '  status: "review_blocked", lastTask: "safety", lastRunAutomatic: true,',
  '  autonomousEvolutionEnabled: true, dualAgentEnabled: true, mainAgent: "codex", subAgent: "claude",',
  '  lastAutomaticEvolveDate: "2026-10-04", lastManualRunDate: "",',
  '  feedbackBatch: { throughAt: legacyThroughAt }, githubFeedbackBatch: legacyGithub,',
  '  collaboration: { status: "failed", phase: "failed",',
  '    failure: { code: "diagnosis_stopped", phase: "diagnose", agent: "codex", recoverable: false },',
  '    lastFailure: { code: "cli_exit", phase: "review", agent: "codex", exitCode: 1, recoverable: true },',
  '    reviewFeedback: "旧复核意见：示例候选未满足验收合同，保持原样", checkpoint: null },',
  '}));',
  'process.env.FARM_DATA_DIR = path.join(dir, "core/data");',
  'delete process.env.FARM_PRIVATE_CONFIG_FILE;',
  'process.env.CODEX_BIN = path.join(dir, "core/data/fake-cli");',
  'process.env.CLAUDE_BIN = path.join(dir, "core/data/fake-cli");',
  'const service = require(path.join(dir, parentFile));',
  'const out = { legacyThroughAt, injectedHook, envClean };',
  '(async () => {',
  '  await service.runAutonomyStep();',
  '  const state = await wait(() => {',
  '    const value = JSON.parse(fs.readFileSync(statePath, "utf-8"));',
  '    return value.status === "pending_apply" && !value.activeRun ? value : false;',
  '  }, "pending_apply");',
  // 拿到结果立即关自主（撤定时器，绝不让后续 apply 步骤在测试环境里跑停服助手）。
  '  service.setAutonomousEvolution(false);',
  '  out.status = state.status;',
  '  out.calls = fs.readFileSync(path.join(dir, "core/data/calls.log"), "utf-8").trim().split("\\n");',
  '  out.firstCall = out.calls[0];',
  '  out.feedbackThroughAt = state.feedbackBatch ? state.feedbackBatch.throughAt : 0;',
  '  out.lastAutomaticEvolveDate = state.lastAutomaticEvolveDate;',
  '  out.lastManualRunDate = state.lastManualRunDate;',
  '  out.autonomyQuotaDate = state.autonomy ? state.autonomy.quotaDate : "";',
  '  out.githubPreserved = state.githubFeedbackBatch',
  '    && state.githubFeedbackBatch.issueNumbers.join(",") === "101"',
  '    && state.githubFeedbackBatch.fingerprint === "a".repeat(64);',
  '  out.archivedCode = state.lastReviewBlockedFailure ? state.lastReviewBlockedFailure.code : "";',
  '  out.archivedFeedback = state.lastReviewBlockedFailure ? state.lastReviewBlockedFailure.reviewFeedback : "";',
  '  out.commit = state.commit;',
  '  out.published = git(["ls-remote", "origin", "refs/heads/main"]).split(/\\s+/)[0];',
  '  out.cleanTree = git(["status", "--porcelain"]) === "";',
  // runner journal 的 taskIdentity 是 Parent 实际喂入的持久凭据（不是自报）。
  '  const journals = fs.readdirSync(path.join(dir, "core/data/logs"))',
  '    .filter(file => /^evolve-team-[\\w-]+\\.json$/.test(file));',
  '  assert.equal(journals.length, 1);',
  '  const journal = JSON.parse(fs.readFileSync(path.join(dir, "core/data/logs", journals[0]), "utf-8"));',
  '  out.taskIdentity = journal.taskIdentity || journal.checkpoint?.taskIdentity || null;',
  '  const publicState = service.getEvolveState();',
  '  out.leaksOriginalPrompt = Object.hasOwn(publicState.autonomy || {}, "originalPrompt");',
  '  out.leaksCheckpoint = publicState.collaboration ? publicState.collaboration.checkpoint != null : false;',
  // 人工按钮无参语义不变：自主 opts 不影响手动调用签名（无参可正常调用并被前置门拦截）。
  '  out.manualCallStillWorks = service.retryReviewBlockedEvolution().ok === false;',
  '  process.stdout.write(JSON.stringify(out));',
  // 真实 timer 会挂住事件循环：断言完成后必须显式退出。
  '})().then(() => { fs.rmSync(externalBare, { recursive: true, force: true }); process.exit(0); })',
  '  .catch(error => { try { fs.rmSync(externalBare, { recursive: true, force: true }); } catch {}',
  '    process.stderr.write(String(error && error.stack || error)); process.exit(1); });',
].join('\n');

// 夹具 spawn 环境隔离（只构造合成 env，绝不改 process.env）：先剥离测试进程
// 可能继承的 GIT_CONFIG_*（Main 协调器环境实测存在），再显式注入生产 runner 的
// 真实形态（core.hooksPath 指向真实 evolution-hooks 目录的只读引用，hooks 本体
// 不修改、不推真实远端）——证明夹具在 hook 注入环境下仍能完成 Parent→CLI→bare
// 的合法发布，而非碰巧 ambient 干净。
function isolatedHookInjectedEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^GIT_CONFIG_(?:COUNT|KEY_\d+|VALUE_\d+)$/.test(key)) delete env[key];
  }
  env.GIT_CONFIG_COUNT = '1';
  env.GIT_CONFIG_KEY_0 = 'core.hooksPath';
  env.GIT_CONFIG_VALUE_0 = path.join(CANDIDATE_ROOT, 'scripts', 'evolution-hooks');
  return env;
}

function runLegacyChild(capturedPlan = false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'farm-autonomy-legacy-runner-'));
  const before = candidateFingerprint();
  try {
    const script = path.join(dir, 'legacy-child.cjs');
    const source = capturedPlan ? LEGACY_CHILD_SOURCE.replace(
      'feedbackBatch: { throughAt: legacyThroughAt }, githubFeedbackBatch: legacyGithub,',
      'feedbackBatch: { throughAt: legacyThroughAt }, githubFeedbackBatch: legacyGithub, autonomy: { activityPlan: { shouldRun: true, newEnded: [81], reviewIds: [91], fingerprint: "a".repeat(64) }, activityPlanDigest: "b".repeat(64) }, pendingActivity: { newUnknown: [], newEnded: [81], updatedAt: Date.now() },')
      .replace('const publicState = service.getEvolveState();', 'out.capturedPlanPreserved = state.autonomy.activityPlan?.newEnded?.includes(81); out.activitySettled = !!state.evolutionMemory?.activity?.reviewedAt && !state.pendingActivity; out.retainedActivityIdentity = state.autonomy.activityPlanDigest; const publicState = service.getEvolveState();') : LEGACY_CHILD_SOURCE;
    fs.writeFileSync(script, source);
    const child = spawnSync(process.execPath, [script, CANDIDATE_ROOT],
      { encoding: 'utf-8', timeout: 180_000, env: { ...isolatedHookInjectedEnv(), FARM_DATA_DIR: dir } });
    return { status: child.status, stdout: child.stdout, stderr: child.stderr,
      candidateUntouched: candidateFingerprint() === before };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('legacy review_blocked 自主接管：真实 Parent+runner 首跳新诊断，批次/水位/名额身份全程保持', () => {
  // 注入守卫必须留在夹具之外：测试进程 env 前后一致（隔离只发生在合成夹具内）。
  const guardBefore = { count: process.env.GIT_CONFIG_COUNT,
    key: process.env.GIT_CONFIG_KEY_0, value: process.env.GIT_CONFIG_VALUE_0 };
  const child = runLegacyChild();
  // 失败也必须先证候选仓未被动过（指纹断言先于结果断言）。
  assert.equal(child.candidateUntouched, true, '子进程不得改动候选仓源码或工作区（含失败路径）');
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual({ count: process.env.GIT_CONFIG_COUNT,
    key: process.env.GIT_CONFIG_KEY_0, value: process.env.GIT_CONFIG_VALUE_0 }, guardBefore,
  '夹具隔离不得改写测试进程/全局环境（进化 pre-push 守卫在夹具外原样保留）');
  const out = JSON.parse(child.stdout.trim().split('\n').pop());
  assert.ok(String(out.injectedHook).includes('evolution-hooks'),
    '子进程必须真实运行在生产形态的 hook 注入环境下');
  assert.equal(out.envClean, true, '夹具进程内的 GIT_CONFIG_* 必须在首个 git 调用前隔离');
  // 首跳 = 主 Agent 对旧底层失败（cli_exit review，diagnosis_stopped 回退）的
  // 真实新诊断，不是 research 盲跑，也不是把旧 stop 翻成 approve。
  assert.equal(out.firstCall, 'diagnose:codex');
  for (const stage of ['research', 'plan', 'implement', 'review']) {
    assert.ok(out.calls.some(call => call.startsWith(`${stage}:`)),
      `无旧 checkpoint 的 legacy 轮必须走全新批准链（缺 ${stage}）：${out.calls}`);
  }
  assert.equal(out.status, 'pending_apply');
  assert.equal(out.published, out.commit, '真实提交必须已发布到远端');
  assert.equal(out.cleanTree, true);
  // 原批次/水位/名额身份：不重采、不覆盖、不占新名额、不记手动日期。
  assert.equal(out.feedbackThroughAt, out.legacyThroughAt, 'feedback 水位必须保持原值');
  assert.equal(out.lastAutomaticEvolveDate, '2026-10-04', '原自动名额日期不得改写');
  assert.equal(out.lastManualRunDate, '', '自主接管不得另记手动日期');
  assert.equal(out.autonomyQuotaDate, '2026-10-04', '链条名额身份沿用原自动名额日期');
  assert.equal(out.githubPreserved, true, 'GitHub 批次摘要不得被新采集覆盖');
  assert.equal(out.archivedCode, 'diagnosis_stopped', '旧失败归档保留原结论');
  assert.match(out.archivedFeedback, /旧复核意见/);
  // Parent 实际喂入 runner 的任务身份（runner journal 持久凭据）与状态一致。
  assert.ok(out.taskIdentity, 'runner journal 必须落盘 taskIdentity');
  assert.equal(out.taskIdentity.feedbackThroughAt, out.legacyThroughAt);
  assert.equal(out.taskIdentity.quotaDate, '2026-10-04');
  assert.equal(out.taskIdentity.automatic, true);
  assert.equal(out.taskIdentity.combinedDaily, true);
  assert.equal(out.leaksOriginalPrompt, false);
  assert.equal(out.leaksCheckpoint, false);
  assert.equal(out.manualCallStillWorks, true, '人工按钮无参调用语义保持（busy 前置门）');
});

// ---------------------------------------------------------------------------
// B2 已提交候选的 Parent 级应用合同（2026-10-07 Main 拒审）：真实 Parent + 真实
// runner + bare 远端走完整链路到 pending_apply（候选提交发生在任务工作区），然后：
// - 任务区 HEAD 漂移（未审叠提交）→ verifyTaskWorkspace 对照受信已审提交如实拒绝，
//   绝不回退按（脏）原库部署；绑定不符同理；
// - 原库保持脏（真实保留物形态）时应用继续：prepareRuntimeWorkspace 在属主根下
//   建运行时区 + recordApplyTarget 落私有记录，helper 只在「进程启动」这一副作用
//   边界被桩替换（前置全部门真实执行）；
// - markEvolutionAppliedAfterRestart 从错误根（原库）运行 → runtime_root_mismatch
//   如实退回 pending_apply，绝不把健康旧源进程标记为已应用。
// 子进程整体跑在真实 tmux pane 里（resolveTmuxPaneForProcess 实测可解析）。
// ---------------------------------------------------------------------------
const B2_CHILD_SOURCE = [
  'const fs = require("node:fs");',
  'const os = require("node:os");',
  'const path = require("node:path");',
  'const assert = require("node:assert/strict");',
  'const { execFileSync } = require("node:child_process");',
  'const candidate = process.argv[2];',
  'const injectedHook = process.env.GIT_CONFIG_VALUE_0 || "";',
  'for (const key of Object.keys(process.env)) {',
  '  if (/^GIT_CONFIG_(COUNT|KEY_\\d+|VALUE_\\d+)$/.test(key)) delete process.env[key];',
  '}',
  'const dir = fs.mkdtempSync(path.join(os.tmpdir(), "farm-b2-apply-"));',
  'let externalBare = null;',
  'const write = (file, data, mode) => {',
  '  const full = path.resolve(dir, file);',
  '  if (full !== dir && !full.startsWith(dir + path.sep)) throw new Error("fixture_escape:" + file);',
  '  fs.mkdirSync(path.dirname(full), { recursive: true }); fs.writeFileSync(full, data, { mode: mode || 0o600 });',
  '};',
  'const git = args => execFileSync("git", args, { cwd: dir, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();',
  'const gitIn = (root, args) => execFileSync("git", args, { cwd: root, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();',
  'const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));',
  'async function wait(predicate, label) {',
  '  for (let i = 0; i < 600; i++) { const value = predicate(); if (value) return value; await sleep(150); }',
  '  throw new Error("timeout_" + label);',
  '}',
  'const parentFile = "core/src/services/activity-evolver.js";',
  'const parentText = fs.readFileSync(path.join(candidate, parentFile), "utf-8");',
  'write(parentFile, parentText);',
  'for (const match of parentText.matchAll(/require\\([\'"](\\.[^\'"]+)[\'"]\\)/g)) {',
  '  const actual = require.resolve(path.resolve(path.dirname(path.join(candidate, parentFile)), match[1]));',
  '  const relative = path.relative(candidate, actual);',
  '  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("unexpected_dependency:" + match[1]);',
  '  write(relative, "module.exports=require(" + JSON.stringify(actual) + ");\\n");',
  '}',
  'write("core/scripts/run-evolution-team.js", fs.readFileSync(path.join(candidate, "core/scripts/run-evolution-team.js")));',
  'write("core/src/services/evolution-countercheck.js", "module.exports=require("',
  '  + JSON.stringify(path.join(candidate, "core/src/services/evolution-countercheck.js")) + ");\\n");',
  'write("core/src/services/evolution-references.js", "module.exports={...require("',
  '  + JSON.stringify(path.join(candidate, "core/src/services/evolution-references.js"))',
  '  + "),collectPublicReferences:async()=>({state:\\"complete\\",discoveryComplete:true})};\\n");',
  'write("core/src/services/evolution-sessions.js", "module.exports=require("',
  '  + JSON.stringify(path.join(candidate, "core/src/services/evolution-sessions.js")) + ");\\n");',
  // 副作用边界桩：真实 helper 的进程启动（停服/重启）不在本用例范围——前置门
  // （候选绑定/任务区核验/验证记录/运行时区准备/私有记录）全部真实执行。
  'const applyArgsLog = path.join(dir, "core/data/apply-args.jsonl");',
  'write("core/scripts/evolution-apply-process.js",',
  '  "#!/usr/bin/env node\\n" +',
  '  "const fs=require(\'node:fs\');const path=require(\'node:path\');" +',
  '  "const dataDir=path.resolve(process.argv[process.argv.indexOf(\'--data-dir\')+1]);" +',
  '  "fs.appendFileSync(path.join(dataDir,\'apply-args.jsonl\'),JSON.stringify(process.argv.slice(2))+\\"\\\\n\\");\\n");',
  'write(".gitignore", "core/data/\\ntmp/\\n");',
  'write("docs/HANDOFF.md", "Fixture constraints\\n");',
  'write("core/src/example.js", "module.exports = 1;\\n");',
  'write("core/test/example.test.js", "require(\\"node:test\\")(\\"fixture\\",()=>require(\\"node:assert/strict\\").ok([1,2].includes(require(\\"../src/example\\"))));\\n");',
  'const callsLog = path.join(dir, "core/data/calls.log");',
  'const cli = `#!/usr/bin/env node',
  'const fs=require("node:fs");',
  'const SESSION={claude:"aaaa1111-2222-3333-4444-555566667777",codex:"bbbb8888-9999-aaaa-bbbb-ccccddddeeee"};',
  'if(process.argv[2]==="app-server"){let buffer="";process.stdin.setEncoding("utf8");',
  'process.stdin.on("data",chunk=>{buffer+=chunk;let index;',
  'while((index=buffer.indexOf("\\\\n"))>=0){const line=buffer.slice(0,index);buffer=buffer.slice(index+1);',
  'if(!line)continue;let value;try{value=JSON.parse(line);}catch{continue;}',
  'if(value.id===undefined||!value.method)continue;',
  'const reply=result=>process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:value.id,result})+"\\\\n");',
  'if(value.method==="thread/read"||value.method==="thread/resume")reply({thread:{id:value.params.threadId}});',
  'else if(value.method==="thread/compact/start"){reply({});',
  'for(const method of ["item/started","item/completed"])process.stdout.write(JSON.stringify({jsonrpc:"2.0",method,params:{threadId:value.params.threadId,item:{type:"contextCompaction"}}})+"\\\\n");',
  '}else reply({});}});return;}',
  'let prompt="";',
  'process.stdin.setEncoding("utf8");',
  'process.stdin.on("data",c=>prompt+=c);',
  'process.stdin.on("end",()=>{',
  ' if(prompt==="/compact"){',
  '  process.stdout.write(JSON.stringify({type:"system",subtype:"compact_boundary",session_id:SESSION.claude})+"\\\\n");',
  '  process.stdout.write(JSON.stringify({type:"result",subtype:"success",is_error:false,session_id:SESSION.claude})+"\\\\n");return;}',
  ' const phase=prompt.match(/只完成 (\\\\w+) 阶段/)[1];',
  // Stage C：Agent CLI 的 cwd 是隔离任务工作区（其 core/data 不在提交里），
  // 调用流水必须写回 fixture 的绝对路径，测试侧才能读到完整批准链。
  // eslint-disable-next-line no-template-curly-in-string
  ' fs.appendFileSync(${JSON.stringify(callsLog)},phase+":"+(process.argv.includes("exec")?"codex":"claude")+"\\\\n");',
  ' const decisions={research:"researched",revise_plan:"researched",plan:"approve",implement:"implemented",review:"approve",diagnose:"repair",repair:"no_change",repair_review:"approve",patch_review:"approve"};',
  ' const result={decision:decisions[phase],summary:"B2 synthetic stage"};',
  ' if(phase==="plan"){result.allowedFiles=["core/src/example.js","docs/HANDOFF.md"];result.acceptanceChecks=["example stays within synthetic values"];result.baselineChecks=[];}',
  ' if(phase==="diagnose")result.allowedFiles=[];',
  ' if(["plan","review"].includes(phase)){result.feedbackReviewed=false;result.lessons=[];}',
  ' if(phase==="review")result.githubResolutions=[];',
  ' if(phase==="implement"){fs.writeFileSync("core/src/example.js","module.exports = 2;\\\\n");fs.appendFileSync("docs/HANDOFF.md","B2 chain update\\\\n");}',
  ' if(process.argv.includes("exec")){',
  '  if(process.argv.includes("--json"))process.stdout.write(JSON.stringify({type:"thread.started",thread_id:SESSION.codex})+"\\\\n");',
  '  fs.writeFileSync(process.argv[process.argv.indexOf("--output-last-message")+1],JSON.stringify(result));}',
  ' else process.stdout.write(JSON.stringify({subtype:"success",is_error:false,session_id:SESSION.claude,structured_output:result}));',
  '});`;',
'write("core/data/fake-cli", cli, 0o700);',
  'git(["init", "-q", "-b", "main"]);',
  'git(["config", "user.name", "B2 apply fixture"]);',
  'git(["config", "user.email", "fixture@users.noreply.github.com"]);',
  'git(["add", "."]);',
  'git(["commit", "-qm", "fixture"]);',
  'const bareHere = path.join(dir, "remote.git");',
  'execFileSync("git", ["init", "--bare", "-q", "-b", "main", bareHere]);',
  'externalBare = path.join(os.tmpdir(), "farm-b2-bare-" + path.basename(dir));',
  'fs.renameSync(bareHere, externalBare);',
  'git(["remote", "add", "origin", externalBare]);',
  'git(["push", "-q", "-u", "origin", "main"]);',
  'const statePath = path.join(dir, "core/data/activity-evolve-state.json");',
  'const prompt = "B2 fixture prompt";',
  'write(statePath, JSON.stringify({',
  '  status: "review_blocked", lastTask: "safety", lastRunAutomatic: true,',
  '  autonomousEvolutionEnabled: true, dualAgentEnabled: true, mainAgent: "codex", subAgent: "claude",',
  '  lastAutomaticEvolveDate: "2026-10-06", lastManualRunDate: "",',
  '  feedbackBatch: { throughAt: Date.now() - 3600_000 },',
  '  collaboration: { status: "failed", phase: "failed",',
  '    failure: { code: "diagnosis_stopped", phase: "diagnose", agent: "codex", recoverable: false },',
  '    lastFailure: { code: "cli_exit", phase: "review", agent: "codex", exitCode: 1, recoverable: true },',
  '    reviewFeedback: "旧复核意见", checkpoint: null },',
  '}));',
  'process.env.FARM_DATA_DIR = path.join(dir, "core/data");',
  'delete process.env.FARM_PRIVATE_CONFIG_FILE;',
  'process.env.CODEX_BIN = path.join(dir, "core/data/fake-cli");',
  'process.env.CLAUDE_BIN = path.join(dir, "core/data/fake-cli");',
  'const service = require(path.join(dir, parentFile));',
  'const publish = require(path.join(candidate, "core/src/services/evolution-publish.js"));',
  'const { logicSnapshot } = require(path.join(candidate, "core/src/services/evolution-validation.js"));',
  'const out = { injectedHook };',
  '(async () => {',
  '  await service.runAutonomyStep();',
  '  // 链路收口 pending_apply 后自主应用定时器（delay 0）在同一进程内立即触发——',
  '  // 这是生产行为，不赌观测时序：直接等自主应用真实发生（applying/autonomous）。',
  '  const dataDir = path.join(dir, "core/data");',
  '  const auto = await wait(() => {',
  '    const value = JSON.parse(fs.readFileSync(statePath, "utf-8"));',
  '    return value.status === "applying" && value.applyingSource === "autonomous" ? value : false;',
  '  }, "autonomous apply");',
  '  await wait(() => fs.existsSync(applyArgsLog), "helper 桩落盘");',
  '  service.setAutonomousEvolution(false);',
  '  out.candidateTaskRoot = auto.candidateTaskRoot || "";',
  '  out.commit = auto.commit;',
  '  out.published = gitIn(dir, ["ls-remote", "origin", "refs/heads/main"]).split(/\\s+/)[0];',
  '  assert.ok(out.candidateTaskRoot.startsWith(path.join(dir, "tmp/evolution-workspaces")));',
  '  assert.equal(out.published, out.commit);',
  '  const readStateNow = () => JSON.parse(fs.readFileSync(statePath, "utf-8"));',
  '  const writeStateNow = value => fs.writeFileSync(statePath, JSON.stringify(value, null, 2));',
  '  const argsLines = () => fs.readFileSync(applyArgsLog, "utf-8").trim().split("\\n").filter(Boolean);',
  '  // 重启收口反例（B3）：自主应用后本进程不在运行时根上 → runtime_root_mismatch',
  '  // 如实退回 pending_apply（生产启动路径把返回态写回盘，这里按同一合同写回）。',
  '  const restart = service.markEvolutionAppliedAfterRestart(readStateNow());',
  '  out.autoRestartRejected = restart.state.status === "pending_apply"',
  '    && /runtime_root_mismatch/.test(restart.state.summary || "");',
  '  writeStateNow(restart.state);',
  '  out.bouncedToPending = readStateNow().status === "pending_apply";',
  '  // 反例 1：任务区叠未审提交 → HEAD 漂移，对照受信已审提交拒绝；绝不回退脏原库。',
  '  fs.writeFileSync(path.join(out.candidateTaskRoot, "core/src/unreviewed.js"), "x\\n");',
  '  gitIn(out.candidateTaskRoot, ["add", "."]);',
  '  gitIn(out.candidateTaskRoot, ["commit", "-qm", "unreviewed extra"]);',
  '  const drifted = service.applyEvolution("manual");',
  '  out.driftRejected = drifted.ok === false && /隔离任务区不可证明（task_head_drifted）/.test(drifted.error);',
  '  out.driftKeptPending = readStateNow().status === "pending_apply";',
  '  out.noSpawnOnDrift = argsLines().length === 1;',
  '  gitIn(out.candidateTaskRoot, ["reset", "-q", "--hard", out.commit]);',
  '  // 反例 2：candidateTaskRoot 绑定不符 → 登记缺失/不符拒绝，同样不回退原库。',
  '  const tampered = readStateNow();',
  '  tampered.candidateTaskRoot = "/elsewhere/task";',
  '  writeStateNow(tampered);',
  '  const mismatch = service.applyEvolution("manual");',
  '  out.mismatchRejected = mismatch.ok === false && /任务区登记缺失或不符/.test(mismatch.error);',
  '  out.noSpawnOnMismatch = argsLines().length === 1;',
  '  // 恢复真实绑定 + 原库保留物（脏树）+ 真实验证记录。',
  '  const restored = readStateNow();',
  '  restored.candidateTaskRoot = out.candidateTaskRoot;',
  '  writeStateNow(restored);',
  '  fs.writeFileSync(path.join(dir, "core/src/dirty-hold.js"), "module.exports = \'hold\';\\n");',
  '  fs.appendFileSync(path.join(dir, "core/src/example.js"), "// dirty hold\\n");',
  '  out.rootDirtyBefore = gitIn(dir, ["status", "--porcelain"]) !== "";',
  '  fs.writeFileSync(path.join(dataDir, "evolution-validation.json"), JSON.stringify({',
  '    version: 1, state: "passed", checkedAt: Date.now(),',
  '    fingerprint: logicSnapshot(out.candidateTaskRoot).fingerprint, checks: ["backend"] }));',
  '  // 正例（重启退回后的再次应用）：原库脏 + 同一提交 → 既有运行时区幂等复用，',
  '  // 不因 runtime_workspace_exists 卡死，私有记录与内容指纹保持一致。',
  '  const applied = service.applyEvolution("manual");',
  '  out.applyOk = applied.ok === true;',
  '  out.applyError = applied.error || "";',
  '  await wait(() => argsLines().length >= 2, "second helper 桩落盘");',
  '  const lines = argsLines();',
  '  out.spawnCount = lines.length;',
  '  const autoArgs = JSON.parse(lines[0]);',
  '  out.autoHelperHead = autoArgs[autoArgs.indexOf("--expected-head") + 1] || "";',
  '  const args = JSON.parse(lines[lines.length - 1]);',
  '  const targetRoot = args[args.indexOf("--target-root") + 1] || "";',
  '  out.helperExpectedHead = args[args.indexOf("--expected-head") + 1] || "";',
  '  out.runtimeUnderOwner = targetRoot.startsWith(path.join(dir, "tmp/evolution-workspaces"))',
  '    && /runtime-[0-9a-f]{12}$/.test(targetRoot);',
  '  const record = publish.readApplyTarget(dataDir);',
  '  out.recordMatches = !!record && record.commit === out.commit && record.runtimeRoot === targetRoot',
  '    && /^[0-9a-f]{64}$/.test(record.sourceFingerprint || "")',
  '    && record.sourceFingerprint === logicSnapshot(targetRoot).fingerprint;',
  '  const after = readStateNow();',
  '  out.statusApplying = after.status === "applying" && after.applyingSource === "manual";',
  '  out.rootStillDirty = fs.readFileSync(path.join(dir, "core/src/dirty-hold.js"), "utf-8") === "module.exports = \'hold\';\\n"',
  '    && fs.readFileSync(path.join(dir, "core/src/example.js"), "utf-8").endsWith("// dirty hold\\n");',
  '  fs.writeFileSync(process.argv[3] || path.join(dir, "result.json"), JSON.stringify(out));',
  '})().then(() => { try { fs.rmSync(externalBare, { recursive: true, force: true }); } catch {} process.exit(0); })',
  '  .catch(error => { try { fs.rmSync(externalBare, { recursive: true, force: true }); } catch {}',
  '    process.stderr.write(String(error && error.stack || error)); process.exit(1); });',
].join('\n');

function runB2Child() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'farm-b2-runner-'));
  const before = candidateFingerprint();
  const session = `farmb2${process.pid}${Date.now().toString(36)}`;
  const outFile = path.join(dir, 'result.json');
  const errFile = path.join(dir, 'err.log');
  const shq = value => `'${String(value).replace(/'/g, `'\\''`)}'`;
  try {
    const script = path.join(dir, 'b2-child.cjs');
    fs.writeFileSync(script, B2_CHILD_SOURCE);
    // 子进程必须长在真实 tmux pane 里：resolveTmuxPaneForProcess 才能解析本进程；
    // 结果文件路径显式传参（子进程自己的 fixture 目录是它私有的 mkdtemp）。
    // tmux pane 继承的是 server 环境（不是 client 的 env），所以生产 hooksPath
    // 注入走命令前缀环境变量（与 legacy 子进程同构：先剥离再注入真实形态）。
    const hookEnv = isolatedHookInjectedEnv();
    const hookPrefix = ['GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0']
      .map(key => `${key}=${shq(hookEnv[key])}`).join(' ');
    execFileSync('tmux', ['-f', '/dev/null', 'new-session', '-d', '-s', session, '-c', dir,
      '-x', '200', '-y', '50', 'sh', '-c',
      `${hookPrefix} ${shq(process.execPath)} ${shq(script)} ${shq(CANDIDATE_ROOT)} ${shq(outFile)} >${shq(path.join(dir, 'out.log'))} 2>${shq(errFile)}`],
    { stdio: 'ignore' });
    const done = spawnSync('sh', ['-c',
      `for i in $(seq 1 240); do [ -s ${shq(outFile)} ] && exit 0; tmux has-session -t ${shq(session)} 2>/dev/null || exit 0; sleep 0.5; done; exit 1`],
    { encoding: 'utf8', timeout: 130_000 });
    return {
      ok: done.status === 0,
      out: fs.existsSync(outFile) ? fs.readFileSync(outFile, 'utf8') : '',
      stderr: fs.existsSync(errFile) ? fs.readFileSync(errFile, 'utf8') : '',
      candidateUntouched: candidateFingerprint() === before,
    };
  } finally {
    try { execFileSync('tmux', ['kill-session', '-t', session], { stdio: 'ignore' }); } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('B2 已提交候选：真实 Parent 全链到 pending_apply 后，漂移拒绝、原库脏照常应用、错误根重启如实退回', () => {
  const child = runB2Child();
  assert.equal(child.candidateUntouched, true, '子进程不得改动候选仓源码或工作区');
  assert.ok(child.ok, `tmux 子进程应完成（轮询退出码异常），stderr 尾部：${child.stderr.slice(-400)}`);
  assert.ok(child.out.trim(), `子进程必须写出结果文件，stderr 尾部：${child.stderr.slice(-400)}`);
  const out = JSON.parse(child.out.trim().split('\n').pop());
  assert.ok(String(out.injectedHook).includes('evolution-hooks'), '必须在生产 hook 注入环境下运行');
  assert.equal(out.published, out.commit, '候选必须已发布到远端');
  assert.equal(out.autoRestartRejected, true, '自主应用后错误根上的重启收口必须如实退回');
  assert.equal(out.bouncedToPending, true, '退回态落盘后回到待应用');
  assert.equal(out.driftRejected, true, `未审叠提交必须被拒：${out.applyError}`);
  assert.equal(out.driftKeptPending, true, '拒绝后保持待应用');
  assert.equal(out.noSpawnOnDrift, true, '拒绝路径绝不能再启动应用进程');
  assert.equal(out.mismatchRejected, true, 'candidateTaskRoot 绑定不符必须被拒');
  assert.equal(out.noSpawnOnMismatch, true);
  assert.equal(out.rootDirtyBefore, true, '应用前原库应保持脏（真实保留物形态）');
  assert.equal(out.applyOk, true, `重启退回后同提交再次应用必须成功（运行时区幂等复用）：${out.applyError}`);
  assert.equal(out.spawnCount, 2, '自主应用 + 重启退回后的手动再应用各启动一次');
  assert.equal(out.autoHelperHead, out.commit, '自主应用 helper 期望提交 = 已审提交（严格同提交）');
  assert.equal(out.helperExpectedHead, out.commit, '手动再应用 helper 期望提交 = 已审提交');
  assert.equal(out.runtimeUnderOwner, true, '运行时区必须挂在属主根工作区边界内');
  assert.equal(out.recordMatches, true, '私有应用目标记录与运行时区/内容指纹一致');
  assert.equal(out.statusApplying, true);
  assert.equal(out.rootStillDirty, true, '应用启动后原库保留物仍逐字节未动');
});


test('real Parent and fresh runner retain and settle a captured activity plan when current report is unavailable', () => {
  const child = runLegacyChild(true);
  assert.equal(child.candidateUntouched, true);
  assert.equal(child.status, 0, child.stderr);
  const out = JSON.parse(child.stdout.trim().split('\n').pop());
  assert.equal(out.capturedPlanPreserved, true);
  assert.equal(out.activitySettled, true);
  assert.equal(out.retainedActivityIdentity, 'b'.repeat(64));
  assert.equal(out.taskIdentity.activityPlanDigest, 'b'.repeat(64));
  assert.equal(out.feedbackThroughAt, out.legacyThroughAt);
  assert.equal(out.lastAutomaticEvolveDate, '2026-10-04');
  assert.equal(out.leaksOriginalPrompt, false);
  assert.equal(out.leaksCheckpoint, false);
});
