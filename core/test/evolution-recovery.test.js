const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { test } = require('node:test');
const {
  runTeamWorkflow, createTeamError, normalizeTeamFailure, parseStageResult, buildStageSchema,
} = require('../src/services/evolution-team');
const { describeTeamFailure, previousTeamFailure, markEvolutionAppliedAfterRestart,
  evolutionNotificationTitle, normalizePersistedState } = require('../src/services/activity-evolver');

function setup() {
  const files = {};
  const calls = [];
  const counts = {};
  const prompts = [];
  let verified = 0;
  let committed = 0;
  let onStage = () => null;
  let onVerify = () => {};
  const deps = {
    settings: { mainAgent: 'codex', subAgent: 'claude' }, prompt: 'isolated task',
    inspect: async () => ({ head: 'a'.repeat(40), dirty: !!Object.keys(files).length,
      files: Object.keys(files), fileFingerprints: { ...files }, fingerprint: JSON.stringify(files) }),
    onProgress: async (phase, agent, details) => calls.push({ phase, agent, ...details }),
    runStage: async (phase, agent, prompt) => {
      counts[phase] = (counts[phase] || 0) + 1;
      prompts.push(prompt);
      const override = onStage(phase, counts[phase]);
      if (override) return phase === 'plan'
        ? { allowedFiles: override.decision === 'approve' ? ['core/src/example.js', 'docs/HANDOFF.md'] : [],
            acceptanceChecks: override.decision === 'approve' ? ['fixture behavior is correct'] : [], ...override } : override;
      return { decision: { research: 'researched', revise_plan: 'researched', plan: 'no_change', implement: 'implemented', review: 'approve',
        diagnose: 'repair', repair: 'no_change', repair_review: 'approve' }[phase],
      summary: 'verified fixture', ...(phase === 'diagnose' ? { allowedFiles: [] } : {}),
        ...(phase === 'plan' ? { allowedFiles: [], acceptanceChecks: [] } : {}) };
    },
    verify: async (options) => { verified += 1; await onVerify(verified, options); },
    commit: async () => { committed += 1; return 'b'.repeat(40); },
  };
  return { deps, files, calls, counts, prompts, stages: fn => { onStage = fn; }, validation: fn => { onVerify = fn; },
    verified: () => verified, committed: () => committed };
}

test('资料交接格式失败由主 Agent 诊断、子 Agent 修复、主 Agent 验收后再继续', async () => {
  const f = setup();
  f.stages((phase, count) => {
    if (phase === 'research' && count === 1) throw createTeamError('invalid_output');
  });
  const result = await runTeamWorkflow(f.deps);
  assert.equal(result.decision, 'no_change');
  assert.equal(result.recoveryAttempt, 1);
  assert.deepEqual(f.calls.map(call => [call.phase, call.agent]), [
    ['research', 'claude'], ['diagnose', 'codex'], ['repair', 'claude'], ['repair_review', 'codex'],
    ['research', 'claude'], ['plan', 'codex'],
  ]);
  assert.equal(f.committed(), 0);
});

test('上一轮失败后的重试先诊断，不从研究阶段盲目重跑', async () => {
  const f = setup();
  f.deps.initialFailure = normalizeTeamFailure({ code: 'invalid_output' }, 'research', 'claude');
  const result = await runTeamWorkflow(f.deps);
  assert.equal(f.calls[0].phase, 'diagnose');
  assert.equal(f.calls[1].phase, 'repair');
  assert.equal(f.calls[2].phase, 'repair_review');
  assert.equal(result.recoveryAttempt, 1);
});

test('测试失败的修复必须限制文件、重新测试、验收并最终复核后才提交', async () => {
  const f = setup();
  const code = 'core/src/example.js';
  const doc = 'docs/HANDOFF.md';
  f.stages((phase) => {
    if (phase === 'plan') return { decision: 'approve', summary: 'repair example' };
    if (phase === 'implement') { f.files[code] = 'broken'; f.files[doc] = 'first'; }
    if (phase === 'diagnose') return { decision: 'repair', summary: 'correct assertion', allowedFiles: [code, doc] };
    if (phase === 'repair') {
      f.files[code] = 'fixed'; f.files[doc] = 'second';
      return { decision: 'implemented', summary: 'fixed example' };
    }
  });
  f.validation((count) => { if (count === 1) throw createTeamError('verification_failed'); });
  const result = await runTeamWorkflow(f.deps);
  assert.equal(result.decision, 'approve');
  assert.equal(f.verified(), 2);
  assert.equal(f.committed(), 1);
  assert.equal(f.counts.repair_review, 1);
  assert.equal(f.counts.review, 1);
  assert.ok(f.calls.findIndex(x => x.phase === 'repair_review') < f.calls.findIndex(x => x.phase === 'review'));
});

test('最终复核拒绝后修复，仍须重新走最终复核，不能用修复验收替代', async () => {
  const f = setup();
  const file = 'core/src/example.js';
  f.stages((phase, count) => {
    if (phase === 'plan') return { decision: 'approve', summary: 'change example' };
    if (phase === 'implement') f.files[file] = 'first';
    if (phase === 'review' && count === 1) return { decision: 'reject', summary: 'needs correction' };
    if (phase === 'diagnose') return { decision: 'repair', summary: 'correct example', allowedFiles: [file] };
    if (phase === 'repair') { f.files[file] = 'second'; return { decision: 'implemented', summary: 'corrected' }; }
  });
  await runTeamWorkflow(f.deps);
  assert.equal(f.counts.review, 2);
  assert.equal(f.counts.repair_review, 1);
  assert.equal(f.verified(), 2);
  assert.equal(f.committed(), 1);
});

test('重复失败全流程最多诊断修复两次，不生成提交', async () => {
  const f = setup();
  f.stages((phase) => { if (phase === 'research') throw createTeamError('invalid_output'); });
  await assert.rejects(runTeamWorkflow(f.deps), { code: 'recovery_exhausted' });
  assert.equal(f.counts.diagnose, 2);
  assert.equal(f.counts.repair, 2);
  assert.equal(f.counts.repair_review, 2);
  assert.equal(f.counts.research, 3);
  assert.equal(f.committed(), 0);
});

test('主 Agent 诊断停止后不调用子 Agent 修复', async () => {
  const f = setup();
  f.stages((phase) => {
    if (phase === 'research') throw createTeamError('cli_exit', { exitCode: 1 });
    if (phase === 'diagnose') return { decision: 'stop', summary: 'requires local configuration', allowedFiles: [] };
  });
  await assert.rejects(runTeamWorkflow(f.deps), { code: 'diagnosis_stopped' });
  assert.equal(f.counts.repair, undefined);
  assert.equal(f.committed(), 0);
});

test('子 Agent 超范围修改，即使同时报 CLI 错误也不能进入下一次修复', async () => {
  const f = setup();
  f.stages((phase) => {
    if (phase === 'research') throw createTeamError('invalid_output');
    if (phase === 'diagnose') return { decision: 'repair', summary: 'fix specified file', allowedFiles: ['core/src/allowed.js'] };
    if (phase === 'repair') { f.files['core/src/unapproved.js'] = 'changed'; throw createTeamError('cli_exit'); }
  });
  await assert.rejects(runTeamWorkflow(f.deps), { code: 'repair_scope' });
  assert.equal(f.counts.diagnose, 1);
  assert.equal(f.counts.repair_review, undefined);
  assert.equal(f.committed(), 0);
});

test('编排修复独立验证和复核后待应用，不用仍在运行的旧编排反复重试', async () => {
  const f = setup();
  const file = 'core/scripts/run-evolution-team.js';
  f.stages((phase, count) => {
    if (phase === 'research' && count === 1) throw createTeamError('invalid_output');
    if (phase === 'diagnose') return { decision: 'repair', summary: 'fix output contract', allowedFiles: [file, 'docs/HANDOFF.md'] };
    if (phase === 'repair') {
      f.files[file] = 'fixed'; f.files['docs/HANDOFF.md'] = 'recorded';
      return { decision: 'implemented', summary: 'fixed contract' };
    }
  });
  const result = await runTeamWorkflow(f.deps);
  assert.equal(result.decision, 'approve');
  assert.equal(result.repairOnly, true);
  assert.deepEqual(result.reviewedOrchestrationFiles, [file]);
  assert.equal(f.counts.implement, undefined);
  assert.equal(f.counts.research, 1);
  assert.equal(f.counts.plan, undefined);
  assert.equal(f.counts.review, 1);
  assert.equal(f.verified(), 1);
});

test('仅应用编排修复不能清理原巡检问题，下一轮先核对恢复条件', () => {
  const failure = normalizeTeamFailure({ code: 'invalid_output' }, 'research', 'claude');
  const batch = [{ type: 'slowdown', count: 1 }];
  const applied = markEvolutionAppliedAfterRestart({ status: 'applying', dualAgentEnabled: true,
    collaboration: { repairOnly: true, lastFailure: failure }, runtimeIssueBatch: batch });
  assert.equal(applied.acknowledgeIssues, false);
  assert.deepEqual(applied.state.runtimeIssueBatch, batch);
  assert.match(applied.state.summary, /原巡检将继续/);
  assert.equal(previousTeamFailure(applied.state).code, 'invalid_output');
  assert.equal(markEvolutionAppliedAfterRestart({ status: 'applying', collaboration: { repairOnly: false } }).acknowledgeIssues, true);
});

test('失败元信息不透传原错误、凭据、地址或任意未知字段', async () => {
  const f = setup();
  const privateText = ['private', 'credential', 'fixture'].join('-');
  f.stages((phase, count) => {
    if (phase === 'research' && count === 1) {
      const error = createTeamError('cli_exit', { exitCode: 1 });
      error.message = privateText;
      error.stderr = privateText;
      throw error;
    }
  });
  await runTeamWorkflow(f.deps);
  assert.ok(!JSON.stringify(f.calls).includes(privateText));
  assert.ok(!f.prompts.join('\n').includes(privateText));
  assert.match(describeTeamFailure({ failure: normalizeTeamFailure({ code: 'invalid_output' }, 'research', 'claude'), recoveryAttempt: 2 }), /Claude 资料检索.*JSON.*2\/2/);
});

test('修复范围不能包含隐私控制、认证文件或路径穿越', () => {
  for (const file of ['.gitignore', 'core/src/services/privacy-guard.js', 'core/src/services/local-privacy-terms.js',
    'core/src/services/evolution-learning.js', 'core/src/services/evolution-validation.js', 'core/src/services/daily-feedback.js',
    'core/src/services/evolution-references.js', 'core/src/controllers/admin-feedback-routes.js', 'web/src/utils/daily-feedback.ts',
    'docs/../outside', 'docs/.codex/auth.json', 'docs/private-config.json']) {
    assert.throws(() => parseStageResult(JSON.stringify({ decision: 'repair', summary: 'bad scope', allowedFiles: [file] }), 'diagnose', new Set()), { code: 'repair_scope' });
  }
  assert.throws(() => parseStageResult('done {"decision":"approve","summary":"ok"}', 'review', new Set()), { code: 'invalid_output' });
  assert.deepEqual(buildStageSchema('diagnose').required, ['decision', 'summary', 'allowedFiles']);
});

test('隐私拦截、终止信号与只读越权不能用自动修复绕开', async () => {
  for (const error of [createTeamError('private_handoff'), createTeamError('cli_exit', { signal: 'SIGTERM' })]) {
    const f = setup();
    f.stages(() => { throw error; });
    await assert.rejects(runTeamWorkflow(f.deps));
    assert.equal(f.counts.diagnose, undefined);
  }
});

test('旧版仅日志记录的 JSON 失败可迁移为下一轮诊断线索', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'farm-legacy-failure-'));
  try {
    const script = `
      const fs = require('node:fs');
      const path = require('node:path');
      const { previousTeamFailure } = require(process.argv[1]);
      const logs = path.join(process.env.FARM_DATA_DIR, 'logs');
      fs.mkdirSync(logs, { recursive: true });
      const logFile = path.join(logs, 'evolve-safety-codex-2026-09-19.log');
      fs.writeFileSync(logFile, '[team] research claude\\nTeam evolution failed: research 未返回有效 JSON 交接结果\\n');
      const result = previousTeamFailure({ status: 'failed', dualAgentEnabled: true, mainAgent: 'codex', subAgent: 'claude', logFile });
      process.stdout.write(JSON.stringify(result));
    `;
    const output = execFileSync(process.execPath, ['-e', script, require.resolve('../src/services/activity-evolver')], {
      env: { ...process.env, FARM_DATA_DIR: dir }, encoding: 'utf8',
    });
    const result = JSON.parse(output);
    assert.equal(result.code, 'invalid_output');
    assert.equal(result.phase, 'research');
    assert.equal(result.agent, 'claude');
    assert.equal(result.recoverable, true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('终止或人工配置问题解决后不会被上一轮失败永久锁死', () => {
  const state = { status: 'failed', dualAgentEnabled: true };
  assert.equal(previousTeamFailure({ ...state, collaboration: { failure: { code: 'cli_exit', signal: 'SIGTERM' } } }), null);
  const resumed = previousTeamFailure({ ...state, collaboration: {
    failure: { code: 'diagnosis_stopped' }, lastFailure: { code: 'cli_exit', phase: 'research', agent: 'claude' },
  } });
  assert.equal(resumed.code, 'cli_exit');
  assert.equal(resumed.phase, 'research');
});

test('旧格式恢复、方案返修不会耗尽真正的验收返工额度', async () => {
  const f = setup();
  f.stages((phase, count) => {
    if (phase === 'research' && count === 1) throw createTeamError('invalid_output');
    if (phase === 'plan') return { decision: count === 1 ? 'reject' : 'approve', summary: 'include real behavior checks' };
    if (phase === 'implement') f.files['core/src/example.js'] = 'incomplete';
    if (phase === 'review' && count === 1) return { decision: 'reject', summary: 'exercise the actual pending request' };
    if (phase === 'repair' && f.counts.implement) {
      f.files['core/src/example.js'] = 'fixed';
      return { decision: 'implemented', summary: 'behavior verified' };
    }
  });
  const result = await runTeamWorkflow(f.deps);
  assert.equal(result.runtimeRecoveryAttempt, 1);
  assert.equal(result.reviewRecoveryAttempt, 1);
  assert.equal(result.planRevision, 1);
  assert.equal(f.counts.revise_plan, 1);
  assert.equal(f.counts.diagnose, 1); // 验收意见由主 Agent 已给出，直接在批准范围内返工。
  assert.equal(f.committed(), 1);
  assert.ok(f.prompts.some(prompt => prompt.includes('exercise the actual pending request')));
});

test('反复拒绝的方案只读修订两次，始终不能提前实施', async () => {
  const f = setup();
  f.stages(phase => phase === 'plan' ? { decision: 'reject', summary: 'proposal lacks evidence' } : null);
  await assert.rejects(runTeamWorkflow(f.deps), (error) => {
    assert.equal(error.code, 'plan_exhausted');
    assert.equal(error.recoveryInfo.planRevision, 2);
    assert.equal(error.recoveryInfo.reviewFeedback, 'proposal lacks evidence');
    return true;
  });
  assert.equal(f.counts.plan, 3);
  assert.equal(f.counts.revise_plan, 2);
  assert.equal(f.counts.implement, undefined);
  assert.equal(f.counts.repair, undefined);
  assert.equal(f.committed(), 0);
});

test('已批准方案的文件边界约束普通实施，不能等最终验收才发现越权', async () => {
  const f = setup();
  f.stages((phase) => {
    if (phase === 'plan') return { decision: 'approve', summary: 'only fix the approved example' };
    if (phase === 'implement') f.files['core/src/outside.js'] = 'unapproved';
  });
  await assert.rejects(runTeamWorkflow(f.deps), { code: 'repair_scope' });
  assert.equal(f.committed(), 0);
});

test('真正验收拒绝携带具体反馈，不能冒充隐私扫描命中', () => {
  const state = normalizePersistedState({ status: 'privacy_blocked_local', commit: '', privacyFindings: [],
    collaboration: { failure: { code: 'review_rejected' } } });
  assert.equal(state.status, 'review_blocked');
  assert.match(evolutionNotificationTitle('safety', state.status), /验收未通过/);
  assert.doesNotMatch(evolutionNotificationTitle('safety', state.status), /隐私/);
  assert.match(evolutionNotificationTitle('safety', 'privacy_blocked'), /隐私/);
  assert.equal(normalizePersistedState({ status: 'privacy_blocked_local', privacyFindings: ['secret finding'],
    collaboration: { failure: { code: 'review_rejected' } } }).status, 'privacy_blocked_local');
});

test('方案输出必须包含明确文件范围和行为验收合同', () => {
  const plan = { decision: 'approve', summary: 'fix the local race', allowedFiles: ['core/src/example.js', 'docs/HANDOFF.md'],
    acceptanceChecks: ['unready requests return without any upstream call'] };
  assert.deepEqual(parseStageResult(JSON.stringify(plan), 'plan', new Set()), { ...plan, feedbackReviewed: false, lessons: [] });
  assert.throws(() => parseStageResult(JSON.stringify({ ...plan, acceptanceChecks: [] }), 'plan', new Set()), { code: 'invalid_decision' });
  assert.deepEqual(buildStageSchema('plan').required, ['decision', 'summary', 'allowedFiles', 'acceptanceChecks', 'feedbackReviewed', 'lessons']);
});

test('干净工作区每日巡检先验证当前逻辑，零改动也不能跳过验证', async () => {
  const f = setup();
  f.deps.verifyBaseline = true;
  const result = await runTeamWorkflow(f.deps);
  assert.equal(result.decision, 'no_change');
  assert.equal(f.verified(), 1);
  assert.equal(f.calls[0].phase, 'verify');
  assert.equal(f.calls[1].phase, 'research');
  assert.equal(f.committed(), 0);
});

test('首次逻辑验证失败交主 Agent 诊断、子 Agent 修复、验收后再巡查', async () => {
  const f = setup();
  f.deps.verifyBaseline = true;
  f.validation(count => { if (count === 1) throw createTeamError('verification_failed'); });
  const result = await runTeamWorkflow(f.deps);
  assert.equal(result.decision, 'no_change');
  assert.equal(f.verified(), 2);
  assert.equal(f.counts.diagnose, 1);
  assert.equal(f.counts.repair, 1);
  assert.equal(f.counts.repair_review, 1);
  assert.ok(f.calls.findIndex(x => x.phase === 'repair_review') < f.calls.findIndex(x => x.phase === 'research'));
});
