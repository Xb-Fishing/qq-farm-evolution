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
  'write(".gitignore", "core/data/\\n");',
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
  '// 未授权脏文件：没有任何 checkpoint 授权过它。',
  'write("unauthorized.txt", "local edit\\n");',
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
  '  const publicState = service.getEvolveState();',
  '  out.leaksOriginalPrompt = Object.hasOwn(publicState.autonomy || {}, "originalPrompt");',
  '  out.leaksCheckpoint = publicState.collaboration ? Object.hasOwn(publicState.collaboration, "checkpoint") && publicState.collaboration.checkpoint !== null : false;',
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
