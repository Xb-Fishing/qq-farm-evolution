'use strict';
// 丢失协作上下文的真凭据恢复（2026-10-07 Stage A 回归）：
// - normalizePersistedState 对「外层已失败、协作对象还挂 running」的字段保留式降级：
//   只改 phase/status/activeAgent，checkpoint/预算/复核意见/任务身份原样保留（旧实现
//   整体抹成 3 键，父进程重启后续接凭据永久丢失）。
// - reconcileLostCollaboration 只在协作对象存在但凭据缺失时，按最新优先有界扫描
//   runner journal 并做全量双侧身份核验：任一 gate 失败即停止扫描（更旧条目不降级
//   采信）；全部通过才恢复 failed 协作对象（recoveredFromJournal 追溯标记，绝不
//   伪造 approve/complete）。gate 覆盖：HEAD/角色/journal 状态/checkpoint 形状/
//   任务身份逐字段（prompt 摘要/反馈水位/GitHub 摘要/名额日期）/当前工作区实测
//   （越权脏文件/内容/权限/暂存/整体指纹）。
// - 恢复出的 checkpoint 仍受既有 runner validateResumeInput 独立实测合同约束。
// 夹具：真实 git 仓库 + 真实共享 worktree inspector 生成指纹（非手写假哈希）。
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { test } = require('node:test');
const { normalizePersistedState, reconcileLostCollaboration, buildCachedActivityContext } = require('../src/services/activity-evolver');
const { inspectWorktree } = require('../src/services/evolution-worktree');

const PROMPT = 'Original fixture prompt';
const PROMPT_DIGEST = crypto.createHash('sha256').update(PROMPT).digest('hex');
const FEEDBACK_AT = 1700000000000;
const QUOTA_DATE = '2026-10-04';
const GITHUB_D = 'c'.repeat(64);
const PLAN_D = 'd'.repeat(64);

test('字段保留式降级：interrupted 后 checkpoint/预算/身份证据不被整体抹掉', () => {
  const checkpoint = {
    version: 1, kind: 'in_run', baselineHead: 'a'.repeat(40), patchHead: '', roundId: 'r1',
    taskIdentity: { task: 'safety', promptDigest: PROMPT_DIGEST, feedbackThroughAt: FEEDBACK_AT,
      activityPlanDigest: PLAN_D, githubBatchDigest: GITHUB_D, quotaDate: QUOTA_DATE,
      automatic: true, combinedDaily: true },
    allowedFiles: ['core/src/example.js'], approvedScope: ['core/src/example.js'],
    acceptanceChecks: ['example behavior'], baselineChecks: [],
    fileFingerprints: { 'core/src/example.js': '0'.repeat(64) },
    worktreeFingerprint: '1'.repeat(64), verifiedFingerprint: '', verifiedChecks: '',
    completed: [{ phase: 'research', decision: 'researched' }], counters: {}, auditCounters: {},
  };
  const state = normalizePersistedState({
    status: 'failed', lastTask: 'safety', dualAgentEnabled: true,
    mainAgent: 'codex', subAgent: 'claude',
    collaboration: {
      status: 'running', phase: 'review', activeAgent: 'codex',
      checkpoint, recoveryAttempt: 1, recoveryLimit: 2, reviewFeedback: '旧复核意见保持原样',
      lastFailure: { code: 'cli_exit', phase: 'review', agent: 'codex', exitCode: 1, recoverable: true },
      decision: '', completedAt: 0, head: '',
    },
  });
  // 只降级运行态三键；凭据、预算、意见、失败史全部原样保留。
  assert.equal(state.collaboration.status, 'failed');
  assert.equal(state.collaboration.phase, 'failed');
  assert.equal(state.collaboration.activeAgent, '');
  assert.deepEqual(state.collaboration.checkpoint, checkpoint);
  assert.equal(state.collaboration.recoveryAttempt, 1);
  assert.equal(state.collaboration.recoveryLimit, 2);
  assert.match(state.collaboration.reviewFeedback, /旧复核意见/);
  assert.equal(state.collaboration.lastFailure.code, 'cli_exit');
});

// ---------------------------------------------------------------------------
// reconcileLostCollaboration：真实 git 夹具 + 共享 inspector 的真实指纹。
// ---------------------------------------------------------------------------

function buildFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'farm-journal-recovery-'));
  const write = (file, data) => {
    const full = path.resolve(dir, file);
    if (full !== dir && !full.startsWith(dir + path.sep)) throw new Error(`fixture_escape:${file}`);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, data);
  };
  const git = args => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  write('.gitignore', 'core/data/\n');
  write('core/src/example.js', 'module.exports = 1;\n');
  git(['init', '-q']);
  git(['config', 'user.name', 'Recovery fixture']);
  git(['config', 'user.email', ['fixture', 'users.noreply.github.com'].join('@')]);
  git(['add', '.']);
  git(['commit', '-qm', 'fixture']);
  return { dir, write, git };
}

function makeState() {
  return {
    dualAgentEnabled: true, mainAgent: 'codex', subAgent: 'claude',
    status: 'failed', lastTask: 'safety', lastRunAutomatic: true, combinedDaily: true,
    feedbackBatch: { throughAt: FEEDBACK_AT },
    autonomy: { originalPrompt: PROMPT, quotaDate: QUOTA_DATE,
      githubBatchDigest: GITHUB_D, activityPlanDigest: PLAN_D },
    collaboration: { status: 'failed', phase: 'failed',
      failure: { code: 'worktree_changed', phase: 'verify', recoverable: true } },
    summary: 'fixture run interrupted',
  };
}

// 与 runner 落盘形态一致的 in_run checkpoint：指纹全部来自当前工作区真实实测。
function realCheckpoint(dir, head, overrides = {}) {
  const now = inspectWorktree(dir);
  return {
    version: 1, kind: 'in_run', baselineHead: head, patchHead: '', roundId: 'r1',
    taskIdentity: { task: 'safety', promptDigest: PROMPT_DIGEST, feedbackThroughAt: FEEDBACK_AT,
      activityPlanDigest: PLAN_D, githubBatchDigest: GITHUB_D, quotaDate: QUOTA_DATE,
      automatic: true, combinedDaily: true },
    allowedFiles: [...now.files], approvedScope: [...now.files],
    acceptanceChecks: [], baselineChecks: [],
    fileFingerprints: { ...now.fileFingerprints },
    worktreeFingerprint: now.fingerprint, verifiedFingerprint: '', verifiedChecks: '',
    completed: [{ phase: 'research', decision: 'researched' }, { phase: 'plan', decision: 'approve' }],
    counters: {}, auditCounters: {},
    ...overrides,
  };
}

function makeJournal(runId, head, checkpoint, patches = {}) {
  return JSON.stringify({
    runId, baseCommit: head, mainAgent: 'codex', subAgent: 'claude',
    phase: 'review', status: 'failed', activeAgent: '', decision: '',
    recoveryAttempt: 1, head: '',
    failure: { code: 'worktree_changed', phase: 'verify', agent: 'codex', recoverable: true },
    lastFailure: { code: 'worktree_changed', phase: 'verify', agent: 'codex', recoverable: true },
    checkpoint, ...patches,
  });
}

test('reconcileLostCollaboration：真实 journal 全量核验通过才恢复凭据，且仍是 failed', () => {
  const { dir, write, git } = buildFixture();
  try {
    const logDir = path.join(dir, 'core/data/logs');
    fs.mkdirSync(logDir, { recursive: true });
    // 与凭据快照一致的脏树（授权内两个文件：改写 + 新增）。
    write('core/src/example.js', 'module.exports = 2;\n');
    write('core/test/behavior.js', 'assert(true);\n');
    const head = git(['rev-parse', 'HEAD']);
    const checkpoint = realCheckpoint(dir, head);
    fs.writeFileSync(path.join(logDir, 'evolve-team-recovery1.json'), makeJournal('recovery1', head, checkpoint));

    const state = reconcileLostCollaboration(makeState(), { repoRoot: dir, logDir });
    // 恢复成功：真实凭据 + 预算 + 失败史 + 追溯标记；绝不伪造批准/完成。
    assert.equal(state.collaboration.status, 'failed');
    assert.equal(state.collaboration.phase, 'failed');
    assert.equal(state.collaboration.activeAgent, '');
    assert.equal(state.collaboration.recoveredFromJournal, true);
    assert.equal(state.collaboration.decision, '', 'journal 只证明凭据，不得伪造批准');
    assert.equal(state.collaboration.recoveryAttempt, 1);
    assert.equal(state.collaboration.checkpoint.kind, 'in_run');
    assert.equal(state.collaboration.checkpoint.baselineHead, head);
    assert.deepEqual(state.collaboration.checkpoint.fileFingerprints, checkpoint.fileFingerprints);
    assert.match(state.summary, /核验恢复协作上下文/);

    // 既有 runner 合同独立实测：恢复出的 checkpoint 仍可被 validateResumeInput 接受。
    // （此处直接以共享 inspector 等价验证同树合同；runner 侧独立实测由
    // evolution-team.test.js 的真实跨进程续接用例覆盖。）
    const now = inspectWorktree(dir);
    assert.deepEqual(Object.keys(now.fileFingerprints).sort(), Object.keys(checkpoint.fileFingerprints).sort());
    assert.equal(now.fingerprint, checkpoint.worktreeFingerprint);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('reconcileLostCollaboration：任一 gate 不符即不采信（无 fallback、无伪造）', () => {
  const { dir, write, git } = buildFixture();
  try {
    const logDir = path.join(dir, 'core/data/logs');
    fs.mkdirSync(logDir, { recursive: true });
    const base = git(['rev-parse', 'HEAD']);
    const head = base;
    // 每个用例从同一棵基线树出发。
    const dirtyTree = () => {
      execFileSync('git', ['reset', '--hard', head], { cwd: dir, stdio: 'ignore' });
      execFileSync('git', ['clean', '-fdq'], { cwd: dir, stdio: 'ignore' });
      write('core/src/example.js', 'module.exports = 2;\n');
      write('core/test/behavior.js', 'assert(true);\n');
    };
    dirtyTree();
    const journalFile = name => path.join(logDir, `evolve-team-${name}.json`);
    const identityPatch = (field, value) => ({ taskIdentity: { ...realCheckpoint(dir, head).taskIdentity, [field]: value } });

    const cases = [
      ['wrong-head', () => fs.writeFileSync(journalFile('g1'), makeJournal('g1', 'e'.repeat(40), realCheckpoint(dir, head)))],
      ['wrong-role', () => fs.writeFileSync(journalFile('g2'), makeJournal('g2', head, realCheckpoint(dir, head), { mainAgent: 'claude' }))],
      ['journal-completed', () => fs.writeFileSync(journalFile('g3'), makeJournal('g3', head, realCheckpoint(dir, head), { status: 'completed' }))],
      ['prompt-digest', () => fs.writeFileSync(journalFile('g4'), makeJournal('g4', head,
        realCheckpoint(dir, head, identityPatch('promptDigest', crypto.createHash('sha256').update('Another task').digest('hex')))))],
      ['feedback-through-at', () => fs.writeFileSync(journalFile('g5'), makeJournal('g5', head,
        realCheckpoint(dir, head, identityPatch('feedbackThroughAt', FEEDBACK_AT + 1))))],
      ['github-digest', () => fs.writeFileSync(journalFile('g6'), makeJournal('g6', head,
        realCheckpoint(dir, head, identityPatch('githubBatchDigest', '9'.repeat(64)))))],
      ['quota-date', () => fs.writeFileSync(journalFile('g7'), makeJournal('g7', head,
        realCheckpoint(dir, head, identityPatch('quotaDate', '2026-10-05'))))],
      ['checkpoint-shape', () => fs.writeFileSync(journalFile('g8'), makeJournal('g8', head,
        realCheckpoint(dir, head, { version: 2 })))],
      ['fingerprint', () => fs.writeFileSync(journalFile('g9'), makeJournal('g9', head,
        realCheckpoint(dir, head, { worktreeFingerprint: 'f'.repeat(64) })))],
      ['foreign-dirty-file', () => write('core/src/unauthorized.js', 'module.exports = 1;\n')],
      ['content-drift', () => write('core/src/example.js', 'module.exports = 3;\n')],
      ['mode-drift', () => fs.chmodSync(path.join(dir, 'core/src/example.js'), 0o755)],
      ['staging-drift', () => { execFileSync('git', ['add', 'core/src/example.js'], { cwd: dir, stdio: 'ignore' }); write('core/src/example.js', 'module.exports = 1;\n'); }],
      ['invalid-json', () => fs.writeFileSync(journalFile('g14'), '{partial')],
    ];
    for (const [label, mutate] of cases) {
      // 每例重建干净日志目录与基线脏树，互不串扰。
      fs.rmSync(logDir, { recursive: true, force: true });
      fs.mkdirSync(logDir, { recursive: true });
      dirtyTree();
      mutate();
      const state = reconcileLostCollaboration(makeState(), { repoRoot: dir, logDir });
      assert.equal(state.collaboration.checkpoint, undefined, `${label}：不得采信凭据`);
      assert.equal(state.collaboration.recoveredFromJournal, undefined, `${label}：不得标记恢复`);
      assert.equal(state.collaboration.status, 'failed');
      assert.doesNotMatch(state.summary || '', /核验恢复/, `${label}：不得声称已恢复`);
    }

    // 最新条目损坏/身份不符 ⇒ 停止扫描：更旧的完全匹配 journal 也不得降级采信。
    fs.rmSync(logDir, { recursive: true, force: true });
    fs.mkdirSync(logDir, { recursive: true });
    dirtyTree();
    const older = path.join(logDir, 'evolve-team-old-match.json');
    fs.writeFileSync(older, makeJournal('old-match', head, realCheckpoint(dir, head)));
    const olderTime = new Date(Date.now() - 2000);
    fs.utimesSync(older, olderTime, olderTime);
    for (const [label, newer] of [
      ['newer-corrupt', '{partial'],
      ['newer-wrong-head', makeJournal('newer-miss', 'e'.repeat(40), realCheckpoint(dir, head))],
    ]) {
      const file = path.join(logDir, label === 'newer-corrupt' ? 'evolve-team-newer-corrupt.json' : 'evolve-team-newer-miss.json');
      fs.writeFileSync(file, newer);
      fs.utimesSync(file, new Date(), new Date());
      const state = reconcileLostCollaboration(makeState(), { repoRoot: dir, logDir });
      assert.equal(state.collaboration.checkpoint, undefined, `${label}：更旧匹配条目不得被降级采信`);
    }

    // 前置守卫：凭据还在 / 协作已完成 / 状态不在恢复集合 ⇒ 原样返回，不进扫描。
    dirtyTree();
    fs.rmSync(logDir, { recursive: true, force: true });
    fs.mkdirSync(logDir, { recursive: true });
    fs.writeFileSync(journalFile('still-there'), makeJournal('still-there', head, realCheckpoint(dir, head)));
    const withCp = makeState();
    withCp.collaboration.checkpoint = realCheckpoint(dir, head);
    assert.equal(reconcileLostCollaboration(withCp, { repoRoot: dir, logDir }).collaboration.recoveredFromJournal, undefined);
    const completed = makeState();
    completed.collaboration.status = 'completed';
    completed.collaboration.decision = 'approve';
    assert.equal(reconcileLostCollaboration(completed, { repoRoot: dir, logDir }).collaboration.recoveredFromJournal, undefined);
    const idle = makeState();
    idle.status = 'idle';
    assert.equal(reconcileLostCollaboration(idle, { repoRoot: dir, logDir }).collaboration.recoveredFromJournal, undefined);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// B4 形状回归（2026-10-07 Main 拒审）：runner 会为各阶段落
// evolve-team-<runId>-<phase>-schema.json / .log / -events.log 等中断产物，名字
// 同样匹配 /^evolve-team-[\w-]{1,100}\.json$/——旧过滤把它们当 journal 参与排序，
// 更新的 schema 产物（内容不是 journal）让真实恢复失败（recovered:false 反例）。
// 只有「已知非 journal 的阶段 schema 后缀」在排序前被剔除，其余合同不变。
test('更新的中断 schema 产物不遮挡真实 journal：仍按最新真实 journal 恢复', () => {
  const { dir, write, git } = buildFixture();
  try {
    const logDir = path.join(dir, 'core/data/logs');
    fs.mkdirSync(logDir, { recursive: true });
    write('core/src/example.js', 'module.exports = 2;\n');
    write('core/test/behavior.js', 'assert(true);\n');
    const head = git(['rev-parse', 'HEAD']);
    const journalFile = path.join(logDir, 'evolve-team-realrun.json');
    fs.writeFileSync(journalFile, makeJournal('realrun', head, realCheckpoint(dir, head)));
    const journalTime = new Date(Date.now() - 5000);
    fs.utimesSync(journalFile, journalTime, journalTime);
    // 更新的中断阶段产物：-schema.json（真实形状：JSON 但不是 journal）、同名
    // 阶段日志与事件日志。它们都不参与 journal 排序/核验。
    fs.writeFileSync(path.join(logDir, 'evolve-team-realrun-review-schema.json'),
      JSON.stringify({ stage: 'review', shape: 'output-schema', interrupted: true }));
    fs.writeFileSync(path.join(logDir, 'evolve-team-realrun-review.log'), 'stream...\n');
    fs.writeFileSync(path.join(logDir, 'evolve-team-realrun-review-events.log'), '{"type":"item"}\n');
    for (const name of ['evolve-team-realrun-review-schema.json', 'evolve-team-realrun-review.log',
      'evolve-team-realrun-review-events.log']) fs.utimesSync(path.join(logDir, name), new Date(), new Date());

    const state = reconcileLostCollaboration(normalizePersistedState(makeState()), { repoRoot: dir, logDir });
    assert.equal(state.collaboration.recoveredFromJournal, true,
      '更新的 -schema.json 阶段产物不得遮挡真实 journal 的恢复');
    assert.equal(state.collaboration.checkpoint.kind, 'in_run');
    assert.equal(state.collaboration.checkpoint.baselineHead, head);
    assert.equal(state.collaboration.status, 'failed', '恢复后仍是 failed/unapproved');
    // 反例守卫不回退：真正更新的「journal 形状」损坏文件仍然停止降级采信。
    fs.rmSync(logDir, { recursive: true, force: true });
    fs.mkdirSync(logDir, { recursive: true });
    fs.writeFileSync(journalFile, makeJournal('realrun', head, realCheckpoint(dir, head)));
    fs.utimesSync(journalFile, journalTime, journalTime);
    fs.writeFileSync(path.join(logDir, 'evolve-team-newer-broken.json'), '{partial');
    const blocked = reconcileLostCollaboration(normalizePersistedState(makeState()), { repoRoot: dir, logDir });
    assert.equal(blocked.collaboration.checkpoint, undefined, '更新的损坏 journal 仍必须停止扫描（fail-closed）');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// combinedDaily 缺位推导（2026-10-07 R6，Parent 形状回归）：
// 旧启动只把综合巡检位写进 activeRun（收口即清），顶层 combinedDaily 从未落盘——
// 缺位 ≠ false。legacy 推导只在 reconcileLostCollaboration 内凭「原 prompt 含
// buildCachedActivityContext 的精确内部标题」+ journal 身份逐字段比对成立；显式
// false 或证据不符一律拒绝。夹具不发明已存在的 state.combinedDaily。
// ---------------------------------------------------------------------------

test('combinedDaily 缺位推导：精确内部标记可推导 true，显式 false / 证据不符拒绝', () => {
  const { dir, write, git } = buildFixture();
  try {
    const logDir = path.join(dir, 'core/data/logs');
    fs.mkdirSync(logDir, { recursive: true });
    write('core/src/example.js', 'module.exports = 2;\n');
    const head = git(['rev-parse', 'HEAD']);
    // 精确内部标记来自真实导出函数产物首行（只有 combinedDaily=true 的启动才注入）。
    const cachedHeader = buildCachedActivityContext({}).split('\n')[0];
    const legacyPrompt = `safety prompt body\n\n${cachedHeader}\n- report line`;
    const legacyDigest = crypto.createHash('sha256').update(legacyPrompt).digest('hex');
    const identity = { task: 'safety', promptDigest: legacyDigest, feedbackThroughAt: FEEDBACK_AT,
      activityPlanDigest: PLAN_D, githubBatchDigest: GITHUB_D, quotaDate: QUOTA_DATE,
      automatic: true, combinedDaily: true };
    const journalCheckpoint = realCheckpoint(dir, head, { taskIdentity: identity });
    const legacyRaw = overrides => ({
      dualAgentEnabled: true, mainAgent: 'codex', subAgent: 'claude',
      status: 'failed', lastTask: 'safety', lastRunAutomatic: true,
      feedbackBatch: { throughAt: FEEDBACK_AT },
      autonomy: { originalPrompt: legacyPrompt, quotaDate: QUOTA_DATE,
        githubBatchDigest: GITHUB_D, activityPlanDigest: PLAN_D },
      collaboration: { status: 'failed', phase: 'failed',
        failure: { code: 'worktree_changed', phase: 'verify', recoverable: true } },
      summary: 'legacy run lost collaboration', ...overrides,
    });
    // Parent 形状：真实启动链路 = normalizePersistedState 先行，再进恢复。
    const runReconcile = (raw) => {
      fs.rmSync(logDir, { recursive: true, force: true });
      fs.mkdirSync(logDir, { recursive: true });
      fs.writeFileSync(path.join(logDir, 'evolve-team-legacy1.json'), makeJournal('legacy1', head, journalCheckpoint));
      return reconcileLostCollaboration(normalizePersistedState(raw()), { repoRoot: dir, logDir });
    };

    // ① 缺位 + 原 prompt 含精确标题 + journal 身份一致 ⇒ 推导 true，恢复成功，
    //    且恢复后仍是 failed（绝不借 checkpoint 翻成已批准/完成）。
    const recovered = runReconcile(() => legacyRaw());
    assert.equal(Object.hasOwn(recovered, 'combinedDaily'), false,
      'normalizePersistedState 不得发明顶层 combinedDaily 键（缺位语义靠 hasOwn）');
    assert.equal(recovered.collaboration.recoveredFromJournal, true, '缺位+标题 ⇒ 推导 true 且身份核对通过');
    assert.equal(recovered.collaboration.status, 'failed');
    assert.equal(recovered.collaboration.decision, '', '恢复保留 failed/unapproved，不伪造批准');

    // ② 缺位但原 prompt 无标题（纯安全轮）⇒ 推导 false，与 journal true 不符 ⇒ 拒绝。
    const plainPrompt = 'safety prompt body without cached context';
    const plainRaw = legacyRaw();
    plainRaw.autonomy = { originalPrompt: plainPrompt, quotaDate: QUOTA_DATE,
      githubBatchDigest: GITHUB_D, activityPlanDigest: PLAN_D };
    const rejectedPlain = runReconcile(() => plainRaw);
    assert.equal(rejectedPlain.collaboration.checkpoint, undefined, '缺位+无标题 ⇒ 推导 false，journal true 不匹配即拒绝');

    // ③ 显式 false：即使原 prompt 含标题也必须拒绝（显式值不被推导覆盖）。
    const explicitFalse = runReconcile(() => legacyRaw({ combinedDaily: false }));
    assert.equal(explicitFalse.combinedDaily, false);
    assert.equal(explicitFalse.collaboration.checkpoint, undefined, '显式 false 与 journal true 不符 ⇒ 拒绝');

    // ④ journal 记录 combinedDaily=false：含标题的缺位状态推导 true ⇒ 不匹配拒绝。
    const falseIdentityCheckpoint = realCheckpoint(dir, head, { taskIdentity: { ...identity, combinedDaily: false } });
    fs.rmSync(logDir, { recursive: true, force: true });
    fs.mkdirSync(logDir, { recursive: true });
    fs.writeFileSync(path.join(logDir, 'evolve-team-legacy1.json'), makeJournal('legacy1', head, falseIdentityCheckpoint));
    const rejectedJournal = reconcileLostCollaboration(normalizePersistedState(legacyRaw()), { repoRoot: dir, logDir });
    assert.equal(rejectedJournal.collaboration.checkpoint, undefined, 'journal false vs 推导 true ⇒ 拒绝');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
