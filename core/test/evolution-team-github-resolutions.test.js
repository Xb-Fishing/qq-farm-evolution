'use strict';
// GitHub 反馈 issue 结论映射回归（evolution-team）。
// 基线对照声明：sourceFiles=['core/src/services/evolution-team.js'],
// testFiles=['core/test/evolution-team-github-resolutions.test.js'], minFailures=1。
// 本文件只使用旧基线已存在的 evolution-team 导出（parseStageResult / buildStageSchema /
// readTeamJournal / runTeamWorkflow / teamJournalPath）：旧实现丢掉 githubResolutions 时，
// 下方「基线对照点」断言给出真实的行为失败（AssertionError），绝不出现
// TypeError / 导入缺失模块 / 旧导出上不存在的属性访问充当反证。
// normalizeGithubResolutions 的独立单元断言在 evolution-github-feedback.test.js
// （该文件依赖新模块，不在旧源码对照范围内）。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// 导入隔离：在加载任何业务模块之前，把数据目录/私有配置指向一次性目录；
// 结束后恢复并清理，绝不把全局变量泄漏给其他测试进程或真实数据目录。
const importDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farm-team-gh-import-'));
const previousDataDir = process.env.FARM_DATA_DIR;
const previousPrivateConfig = process.env.FARM_PRIVATE_CONFIG_FILE;
process.env.FARM_DATA_DIR = importDataDir;
process.env.FARM_PRIVATE_CONFIG_FILE = path.join(importDataDir, 'none.json');
test.after(() => {
  if (previousDataDir === undefined) delete process.env.FARM_DATA_DIR;
  else process.env.FARM_DATA_DIR = previousDataDir;
  if (previousPrivateConfig === undefined) delete process.env.FARM_PRIVATE_CONFIG_FILE;
  else process.env.FARM_PRIVATE_CONFIG_FILE = previousPrivateConfig;
  fs.rmSync(importDataDir, { recursive: true, force: true });
});

const {
  parseStageResult, buildStageSchema, readTeamJournal, runTeamWorkflow, teamJournalPath,
} = require('../src/services/evolution-team');

const HEAD = 'b'.repeat(40);
const FP = 'd'.repeat(64);
const RESOLUTIONS = [
  { issue: 2, status: 'fixed', fingerprint: FP, note: '启动崩溃已修复' },
  { issue: 7, status: 'in_progress' },
];
// readTeamJournal 只按字段校验，不需要进化器的 normalizeActiveRun（避免拖入 activity-evolver）。
const ACTIVE = { runId: 'run-gh', baseCommit: HEAD, agent: 'codex', subAgent: 'claude', dualAgentEnabled: true };

test('review 阶段交接保留并校验 githubResolutions；无效映射按决策无效拒绝', () => {
  const parsed = parseStageResult(JSON.stringify({
    decision: 'approve', summary: '复核通过', feedbackReviewed: true, lessons: [],
    githubResolutions: RESOLUTIONS,
  }), 'review', new Set());
  // 基线对照点：旧实现 review 解析结果不带 githubResolutions，此断言行为化失败。
  assert.ok(Array.isArray(parsed.githubResolutions), 'review 交接必须保留 githubResolutions 数组');
  assert.deepEqual(parsed.githubResolutions, RESOLUTIONS);

  // 映射只属于 review；其他阶段出现该字段被忽略，不进交接。
  const research = parseStageResult(JSON.stringify({ decision: 'researched', summary: 'ok', githubResolutions: RESOLUTIONS }), 'research', new Set());
  assert.equal(Object.hasOwn(research, 'githubResolutions'), false);

  for (const bad of [
    { decision: 'approve', summary: 'ok', githubResolutions: [{ issue: 2, status: 'merged' }] },
    { decision: 'approve', summary: 'ok', githubResolutions: 'fixed' },
    { decision: 'approve', summary: 'ok', githubResolutions: [{ issue: 2 }] },
    { decision: 'approve', summary: 'ok', githubResolutions: [{ issue: 2, status: 'fixed' }] },
    // fixed 不允许用 null 指纹冒充（新契约下 null 只属于非 fixed）。
    { decision: 'approve', summary: 'ok', githubResolutions: [{ issue: 2, status: 'fixed', fingerprint: null, note: '' }] },
    // 非 hex / 非法长度指纹一律拒绝，即使状态不是 fixed。
    { decision: 'approve', summary: 'ok', githubResolutions: [{ issue: 2, status: 'in_progress', fingerprint: 'zz', note: '' }] },
    { decision: 'approve', summary: 'ok', githubResolutions: [{ issue: 2, status: 'in_progress', fingerprint: FP.slice(0, 63), note: '' }] },
  ]) {
    assert.throws(() => parseStageResult(JSON.stringify(bad), 'review', new Set()), { code: 'invalid_decision' },
      JSON.stringify(bad));
  }

  // 新契约完整形式：空批次、非 fixed 的 null 指纹 + 空 note 均为合法输出，
  // 解析侧归一为历史形状（省略空值字段），历史省略字段形式继续兼容。
  const emptyBatch = parseStageResult(JSON.stringify({
    decision: 'approve', summary: 'ok', githubResolutions: [],
  }), 'review', new Set());
  assert.deepEqual(emptyBatch.githubResolutions, []);
  const strictForm = parseStageResult(JSON.stringify({
    decision: 'approve', summary: 'ok',
    githubResolutions: [
      { issue: 2, status: 'fixed', fingerprint: FP, note: '启动崩溃已修复' },
      { issue: 7, status: 'in_progress', fingerprint: null, note: '' },
    ],
  }), 'review', new Set());
  assert.deepEqual(strictForm.githubResolutions, [
    { issue: 2, status: 'fixed', fingerprint: FP, note: '启动崩溃已修复' },
    { issue: 7, status: 'in_progress' },
  ]);
  const legacyOmitted = parseStageResult(JSON.stringify({
    decision: 'approve', summary: 'ok',
    githubResolutions: [{ issue: 9, status: 'wont_fix', note: '不采纳' }],
  }), 'review', new Set());
  assert.deepEqual(legacyOmitted.githubResolutions, [{ issue: 9, status: 'wont_fix', note: '不采纳' }]);

  // note 过隐私检查：命中运行时隐私词被替换（先断言数组存在，避免旧代码上 TypeError）。
  const sanitized = parseStageResult(JSON.stringify({
    decision: 'approve', summary: 'ok', githubResolutions: [{ issue: 2, status: 'fixed', fingerprint: FP, note: 'account zhang-san crashed' }],
  }), 'review', new Set(['zhang-san']));
  assert.ok(Array.isArray(sanitized.githubResolutions), '基线对照点：review 交接必须保留映射');
  assert.equal(sanitized.githubResolutions[0].note.includes('zhang-san'), false);
});

test('review 阶段 schema 契约：数组必填、条目四字段齐全、fingerprint 可 null 且 64hex 严格', () => {
  const reviewSchema = buildStageSchema('review');
  // 基线对照点：旧 schema 没有 githubResolutions，此断言行为化失败。
  assert.ok(reviewSchema.properties.githubResolutions, 'review schema 必须声明 githubResolutions');
  // 结构化输出契约：声明了属性就必须必填（无结论输出空数组，不允许省略字段）。
  assert.ok(reviewSchema.required.includes('githubResolutions'), 'githubResolutions 必须列入顶层必填');
  const items = reviewSchema.properties.githubResolutions.items;
  assert.equal(items.additionalProperties, false);
  assert.deepEqual([...items.required].sort(), ['fingerprint', 'issue', 'note', 'status'], '条目四字段必须全部必填');
  assert.equal(items.properties.status.enum.includes('fixed'), true);
  const branches = items.properties.fingerprint.anyOf;
  assert.equal(branches.some(branch => branch.type === 'string' && branch.pattern === '^[0-9a-f]{64}$'), true,
    '字符串指纹分支必须保持 64 位十六进制严格校验');
  assert.equal(branches.some(branch => branch.type === 'null'), true, '非 fixed 结论必须能用 null 指纹');
  assert.equal(Object.hasOwn(items.properties, 'revision'), false, '映射不暴露提交哈希字段');
  assert.equal(Object.hasOwn(buildStageSchema('plan').properties, 'githubResolutions'), false);
});

test('全阶段 schema 结构契约：封闭对象必填覆盖全部声明属性（防结构化输出契约回归）', () => {
  const walk = (node, where) => {
    if (Array.isArray(node.anyOf)) {
      node.anyOf.forEach((branch, index) => walk(branch, `${where}.anyOf[${index}]`));
      return;
    }
    if (node.properties) {
      // 基线对照点：旧 review 条目 required 缺 fingerprint/note、顶层缺 githubResolutions，
      // 以下断言以真实 AssertionError 失败，不用缺失属性访问冒充。
      assert.equal(node.additionalProperties, false, `${where} 必须封闭额外属性`);
      assert.deepEqual([...(node.required || [])].sort(), Object.keys(node.properties).sort(),
        `${where} 的必填必须覆盖全部声明属性`);
      for (const [key, sub] of Object.entries(node.properties)) walk(sub, `${where}.${key}`);
    }
    if (node.items) walk(node.items, `${where}[]`);
  };
  for (const phase of ['triage', 'research', 'revise_plan', 'plan', 'implement', 'review', 'diagnose', 'repair', 'repair_review', 'patch_review']) {
    walk(buildStageSchema(phase), phase);
  }
});

test('journal 读取：仅最终 approve 保留映射；无效映射与拒绝轮一律清空', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'farm-team-gh-'));
  try {
    const data = {
      runId: ACTIVE.runId, baseCommit: ACTIVE.baseCommit, mainAgent: 'codex', subAgent: 'claude',
      phase: 'complete', status: 'completed', activeAgent: '', head: 'c'.repeat(40), decision: 'approve',
    };
    const file = teamJournalPath(dir, ACTIVE.runId);
    fs.writeFileSync(file, JSON.stringify({ ...data, githubResolutions: RESOLUTIONS }));
    const approved = readTeamJournal(dir, ACTIVE);
    assert.ok(approved, 'approve 轮 journal 可读');
    assert.ok(Array.isArray(approved.githubResolutions), '基线对照点：journal 读取必须保留映射');
    assert.deepEqual(approved.githubResolutions, RESOLUTIONS);

    for (const patch of [
      { decision: 'no_change', head: HEAD }, // no_change 轮语义：没有新提交，head 回到基线
      { status: 'failed' },
      { githubResolutions: [{ issue: 2, status: 'merged' }] },
      { githubResolutions: 'fixed' },
      { githubResolutions: [{ issue: 2, status: 'fixed' }] }, // fixed 缺指纹 → 无效清空
    ]) {
      fs.writeFileSync(file, JSON.stringify({ ...data, ...patch }));
      const journal = readTeamJournal(dir, ACTIVE);
      assert.ok(journal, JSON.stringify(patch));
      assert.deepEqual(journal.githubResolutions, [], JSON.stringify(patch));
    }
    // note 中无法脱敏的隐私文本被清空，映射本身保留。
    fs.writeFileSync(file, JSON.stringify({
      ...data,
      githubResolutions: [{ issue: 2, status: 'fixed', fingerprint: FP, note: ['person', '@', 'example.invalid'].join('') }],
    }));
    assert.equal(readTeamJournal(dir, ACTIVE).githubResolutions[0].note, '');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

function workflowFixture(overrides = {}) {
  const calls = [];
  let tree = { head: HEAD, fingerprint: 'clean', dirty: false, files: [], fileFingerprints: {} };
  const settings = { mainAgent: 'codex', subAgent: 'claude', dualAgentEnabled: true };
  const deps = {
    settings, prompt: '任务与回归约束',
    inspect: async () => ({ ...tree }),
    onProgress: async (phase, agent) => calls.push([phase, agent]),
    runStage: async (phase) => {
      if (phase === 'implement') {
        tree = { ...tree, dirty: true, fingerprint: 'implementation',
          files: ['core/src/example.js', 'docs/HANDOFF.md'],
          fileFingerprints: { 'core/src/example.js': 'changed', 'docs/HANDOFF.md': 'recorded' } };
      }
      return { decision: { research: 'researched', revise_plan: 'researched', plan: 'approve', implement: 'implemented', review: 'approve', patch_review: 'approve' }[phase], summary: 'approved scope',
        ...(phase === 'plan' ? { allowedFiles: ['core/src/example.js', 'docs/HANDOFF.md'], acceptanceChecks: ['example behavior verified'] } : {}),
        ...(phase === 'review' ? { feedbackReviewed: true, lessons: [], githubResolutions: RESOLUTIONS } : {}) };
    },
    verify: async () => calls.push(['tests']),
    commit: async () => { calls.push(['git-commit']); return 'c'.repeat(40); },
    ...overrides,
  };
  return { calls, deps, setTree: fields => { tree = { ...tree, ...fields }; } };
}

test('工作流：最终复核的映射随 approve 结果发布；no_change 与 repairOnly 轮不发布', async () => {
  const normal = workflowFixture();
  const result = await runTeamWorkflow(normal.deps);
  assert.equal(result.decision, 'approve');
  // 基线对照点：旧工作流结果不带 githubResolutions，此断言行为化失败。
  assert.ok(Array.isArray(result.githubResolutions), '工作流结果必须带 githubResolutions');
  assert.deepEqual(result.githubResolutions, RESOLUTIONS, '主 Agent 最终复核的 per-issue 结论进入结果');

  const noChange = workflowFixture();
  const planStage = noChange.deps.runStage;
  noChange.deps.runStage = async (...args) => args[0] === 'plan'
    ? { decision: 'no_change', summary: '无需改动', allowedFiles: [], acceptanceChecks: [], githubResolutions: RESOLUTIONS }
    : planStage(...args);
  const noChangeResult = await runTeamWorkflow(noChange.deps);
  assert.equal(noChangeResult.decision, 'no_change');
  assert.deepEqual(noChangeResult.githubResolutions, [], 'no_change 轮没有修复，不得携带 fixed 结论');
});

test('编排修复轮（requiresApply）：即使最终复核输出映射，结果仍不带反馈结论', async () => {
  const f = workflowFixture();
  const baseRunStage = f.deps.runStage;
  let verifyAttempts = 0;
  f.deps.verify = async () => {
    verifyAttempts += 1;
    if (verifyAttempts === 1) throw Object.assign(new Error('test failed'), { code: 'verification_failed' });
    f.calls.push(['tests']);
  };
  f.deps.runStage = async (phase, agent, prompt) => {
    if (phase === 'diagnose') {
      return { decision: 'repair', summary: '修复编排文件', allowedFiles: ['core/scripts/run-evolution-team.js'] };
    }
    if (phase === 'repair') {
      f.setTree({
        dirty: true, fingerprint: 'repaired',
        files: ['core/src/example.js', 'docs/HANDOFF.md', 'core/scripts/run-evolution-team.js'],
        fileFingerprints: {
          'core/src/example.js': 'changed', 'docs/HANDOFF.md': 'recorded',
          'core/scripts/run-evolution-team.js': 'patched',
        },
      });
      return { decision: 'implemented', summary: '编排修复完成' };
    }
    if (phase === 'repair_review') return { decision: 'approve', summary: '修复验收通过' };
    return baseRunStage(phase, agent, prompt);
  };
  const result = await runTeamWorkflow({ ...f.deps, efficientMode: false });
  assert.equal(result.repairOnly, true);
  assert.equal(result.decision, 'approve');
  assert.deepEqual(result.githubResolutions, [], 'repairOnly 轮没有完成原巡检，不得发布 fixed 结论');
  assert.ok(f.calls.some(([phase]) => phase === 'repair_review'), 'legacy 路径含修复验收');
});
