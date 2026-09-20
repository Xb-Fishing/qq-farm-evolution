const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { test } = require('node:test');
const {
  normalizeAgentSettings, validateAgentSettings, parseStageResult,
  teamJournalPath, readTeamJournal, isTeamResultApproved, runTeamWorkflow,
} = require('../src/services/evolution-team');
const { normalizePersistedState, normalizeActiveRun } = require('../src/services/activity-evolver');
const { requireEvolutionConfigAdmin } = require('../src/controllers/admin-activity-update-routes');

test('主子 Agent 配置写入同时要求有效会话与管理员角色', () => {
  for (const role of ['user', undefined, 'admin', 'super_admin']) {
    let continued = false;
    let status = 200;
    const res = { status(code) { status = code; return this; }, json() {} };
    requireEvolutionConfigAdmin({ currentUser: { role } }, res, () => { continued = true; });
    assert.equal(continued, role === 'admin' || role === 'super_admin');
    assert.equal(status, continued ? 200 : 403);
  }
});

test('旧单执行器配置保留，主子 Agent 可独立选择并同步旧字段', () => {
  assert.deepEqual(normalizeAgentSettings({ agent: 'codex' }), {
    dualAgentEnabled: false, mainAgent: 'codex', subAgent: 'claude', defaultAgent: 'codex', agent: 'codex',
  });
  const value = normalizePersistedState({ defaultAgent: 'claude', mainAgent: 'codex', subAgent: 'claude', dualAgentEnabled: true });
  assert.equal(value.defaultAgent, 'codex');
  assert.equal(value.agent, 'codex');
  assert.equal(value.dualAgentEnabled, true);
  const disabled = validateAgentSettings({ dualAgentEnabled: false }, value);
  assert.equal(disabled.settings.subAgent, 'claude');
  assert.equal(disabled.settings.mainAgent, 'codex');
  assert.equal(validateAgentSettings({ mainAgent: 'other' }, value).ok, false);
  assert.equal(validateAgentSettings({ subAgent: 'other' }, value).ok, false);
  assert.equal(validateAgentSettings({ dualAgentEnabled: 'false' }, value).ok, false);
  assert.equal(validateAgentSettings(null, value).ok, false);
  assert.equal(value.dualAgentEnabled, true);
});

test('交接只接受阶段决策和脱敏摘要，不把任意退出文本当批准', () => {
  assert.throws(() => parseStageResult('looks good', 'plan', new Set()), /JSON/);
  assert.throws(() => parseStageResult('{"decision":"approve","summary":""}', 'plan', new Set()), { code: 'invalid_decision' });
  assert.throws(() => parseStageResult('{"decision":"approve","summary":"ok"}', 'research', new Set()), /决策/);
  const result = parseStageResult(JSON.stringify({ decision: 'approve', summary: 'private-person code path' }), 'review', new Set(['private-person']));
  assert.equal(result.summary, '[PRIVATE] code path');
  assert.throws(() => parseStageResult(JSON.stringify({ decision: 'approve', summary: ['person', '@', 'example.org'].join('') }), 'review', new Set()), { code: 'private_handoff' });
});

function workflowFixture(overrides = {}) {
  const calls = [];
  let tree = { head: 'a'.repeat(40), fingerprint: 'clean', dirty: false, files: [], fileFingerprints: {} };
  const settings = { mainAgent: 'codex', subAgent: 'claude', dualAgentEnabled: true };
  const deps = {
    settings, prompt: '任务与回归约束',
    inspect: async () => ({ ...tree }),
    onProgress: async (phase, agent) => calls.push([phase, agent]),
    runStage: async (phase, agent, prompt) => {
      assert.ok(prompt.indexOf('完整读取 docs/HANDOFF.md') < prompt.indexOf('双 Agent 阶段契约'));
      if (phase === 'research') {
        assert.match(prompt, /六组查询/);
        assert.match(prompt, /本机私有参考配置/);
        assert.match(prompt, /新候选/);
        assert.match(prompt, /不要执行外部脚本/);
      }
      if (phase === 'implement') {
        assert.match(prompt, /approved scope/);
        tree = { ...tree, dirty: true, fingerprint: 'implementation',
          files: ['core/src/example.js', 'docs/HANDOFF.md'],
          fileFingerprints: { 'core/src/example.js': 'changed', 'docs/HANDOFF.md': 'recorded' } };
      }
      return { decision: { research: 'researched', revise_plan: 'researched', plan: 'approve', implement: 'implemented', review: 'approve' }[phase], summary: 'approved scope',
        ...(phase === 'plan' ? { allowedFiles: ['core/src/example.js', 'docs/HANDOFF.md'], acceptanceChecks: ['example behavior verified'] } : {}) };
    },
    verify: async () => calls.push(['tests']),
    commit: async () => { calls.push(['git-commit']); return 'b'.repeat(40); },
    ...overrides,
  };
  return { calls, deps, setTree: fields => { tree = { ...tree, ...fields }; } };
}

test('Claude 检索/实施，Codex 批准/复核，验证通过后才提交', async () => {
  const { deps, calls } = workflowFixture();
  const result = await runTeamWorkflow(deps);
  assert.equal(result.decision, 'approve');
  assert.deepEqual(calls, [
    ['research', 'claude'], ['plan', 'codex'], ['implement', 'claude'], ['verify', ''],
    ['tests'], ['review', 'codex'], ['commit', ''], ['git-commit'],
  ]);
});

test('角色反选时按用户选择执行，不写死 Codex 主 Agent', async () => {
  const { deps, calls } = workflowFixture({ settings: { mainAgent: 'claude', subAgent: 'codex' } });
  await runTeamWorkflow(deps);
  assert.deepEqual(calls[0], ['research', 'codex']);
  assert.deepEqual(calls[1], ['plan', 'claude']);
  assert.deepEqual(calls[2], ['implement', 'codex']);
});

test('主 Agent 确认零改动时不启动实施、不制造提交', async () => {
  const f = workflowFixture();
  const runStage = f.deps.runStage;
  f.deps.runStage = async (...args) => args[0] === 'plan'
    ? { decision: 'no_change', summary: '当前实现已经满足要求', allowedFiles: [], acceptanceChecks: [] } : runStage(...args);
  assert.equal((await runTeamWorkflow(f.deps)).decision, 'no_change');
  assert.deepEqual(f.calls, [['research', 'claude'], ['plan', 'codex']]);
});

for (const blockedPhase of ['research', 'plan', 'implement', 'verify', 'review']) {
  test(`${blockedPhase} 失败或被拒绝时不得进入提交`, async () => {
    const f = workflowFixture();
    const runStage = f.deps.runStage;
    f.deps.runStage = async (...args) => {
      if (args[0] !== blockedPhase) return runStage(...args);
      if (['plan', 'review'].includes(blockedPhase)) return { decision: 'reject', summary: '未通过' };
      throw new Error('CLI interrupted');
    };
    if (blockedPhase === 'verify') f.deps.verify = async () => { throw new Error('test failed'); };
    await assert.rejects(runTeamWorkflow(f.deps));
    assert.ok(!f.calls.some(([phase]) => phase === 'git-commit'));
    if (blockedPhase === 'plan') assert.ok(!f.calls.some(([phase]) => phase === 'implement'));
  });
}

test('只读阶段越权改文件或 Agent 提前创建提交均会停止', async () => {
  for (const fields of [{ fingerprint: 'edited', dirty: true }, { head: 'c'.repeat(40) }]) {
    const f = workflowFixture();
    f.deps.runStage = async () => {
      f.setTree(fields);
      return { decision: 'researched', summary: 'claimed success' };
    };
    await assert.rejects(runTeamWorkflow(f.deps), error => ['readonly_changed', 'head_changed'].includes(error.code));
    assert.equal(f.calls.length, 1);
  }
});

test('测试或复核期间工作区被改动，原批准不可复用', async () => {
  const f = workflowFixture();
  f.deps.verify = async () => f.setTree({ fingerprint: 'changed-during-tests' });
  await assert.rejects(runTeamWorkflow(f.deps), { code: 'worktree_changed' });
  assert.ok(!f.calls.some(([phase]) => phase === 'git-commit'));
});

test('重启恢复只信本轮、同基线、同角色、同 HEAD 的完成凭据', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'farm-team-journal-'));
  const active = normalizeActiveRun({
    runId: 'test-run', baseCommit: 'a'.repeat(40), agent: 'codex', subAgent: 'claude', dualAgentEnabled: true,
  });
  const data = {
    runId: active.runId, baseCommit: active.baseCommit, mainAgent: 'codex', subAgent: 'claude',
    phase: 'complete', status: 'completed', activeAgent: '', head: 'b'.repeat(40), decision: 'approve',
    recoveryAttempt: 1,
    reviewedOrchestrationFiles: ['core/scripts/run-evolution-team.js', 'core/src/services/privacy-guard.js'],
  };
  try {
    assert.equal(readTeamJournal(dir, active), null);
    const file = teamJournalPath(dir, active.runId);
    fs.writeFileSync(file, JSON.stringify(data));
    assert.equal(isTeamResultApproved(readTeamJournal(dir, active), data.head), true);
    assert.deepEqual(readTeamJournal(dir, active).reviewedOrchestrationFiles, ['core/scripts/run-evolution-team.js']);
    assert.equal(readTeamJournal(dir, active).recoveryAttempt, 1);
    assert.equal(isTeamResultApproved(readTeamJournal(dir, active), 'c'.repeat(40)), false);
    for (const patch of [{ runId: 'old-run' }, { baseCommit: 'c'.repeat(40) }, { mainAgent: 'claude' }, { subAgent: 'codex' }, { phase: 'review', status: 'running' }, { status: 'failed' }, { decision: 'no_change' }]) {
      fs.writeFileSync(file, JSON.stringify({ ...data, ...patch }));
      assert.equal(isTeamResultApproved(readTeamJournal(dir, active), data.head), false);
    }
    fs.writeFileSync(file, JSON.stringify({ ...data, decision: 'no_change', head: active.baseCommit }));
    assert.equal(isTeamResultApproved(readTeamJournal(dir, active), active.baseCommit), true);
    fs.writeFileSync(file, '{partial');
    assert.equal(readTeamJournal(dir, active), null);
    assert.throws(() => teamJournalPath(dir, '../outside'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('配置 API 的服务方法持久化角色，旧入口兼容且执行中不可切换', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'farm-team-config-'));
  try {
    const script = `
      const assert = require('node:assert/strict');
      const fs = require('node:fs');
      const path = require('node:path');
      const service = require(process.argv[1]);
      assert.equal(service.setEvolutionAgents({ mainAgent: 'codex', subAgent: 'claude', dualAgentEnabled: true }).ok, true);
      assert.equal(service.getEvolveState().dualAgentEnabled, true);
      assert.equal(service.setEvolutionAgent('claude').ok, true);
      assert.equal(service.getEvolveState().mainAgent, 'claude');
      const file = path.join(process.env.FARM_DATA_DIR, 'activity-evolve-state.json');
      const state = JSON.parse(fs.readFileSync(file));
      assert.equal(state.subAgent, 'claude');
      for (const status of ['running', 'revising', 'applying']) {
        fs.writeFileSync(file, JSON.stringify({ ...state, status, lastRunAt: Date.now() }));
        assert.equal(service.setEvolutionAgents({ mainAgent: 'codex' }).ok, false);
        assert.equal(JSON.parse(fs.readFileSync(file)).mainAgent, 'claude');
      }
    `;
    execFileSync(process.execPath, ['-e', script, require.resolve('../src/services/activity-evolver')], {
      env: { ...process.env, FARM_DATA_DIR: dir }, stdio: 'pipe',
    });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('隔离 Git 仓库跑真实协调进程：CLI 交接、独立测试、复核、提交与拒绝收口', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'farm-team-runner-'));
  const write = (file, text) => {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), text);
  };
  const git = args => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  try {
    write('core/scripts/run-evolution-team.js', fs.readFileSync(path.join(__dirname, '../scripts/run-evolution-team.js')));
    for (const name of ['activity-evolver', 'privacy-guard', 'evolution-team', 'evolution-validation']) {
      write(`core/src/services/${name}.js`, `module.exports = require(${JSON.stringify(require.resolve(`../src/services/${name}`))});`);
    }
    write('core/src/services/evolution-references.js', 'module.exports.collectPublicReferences = async () => ({state:"complete", discoveryComplete:true});\n');
    write('.gitignore', 'core/data/\nweb/dist/\nweb/node_modules/\n');
    write('docs/HANDOFF.md', 'Fixture constraints\n');
    write('core/src/example.js', 'module.exports = 1;\n');
    write('core/test/example.test.js', 'require("node:assert/strict").ok([1, 2].includes(require("../src/example")));\n');
    write('web/src/example.js', 'export default 1;\n');
    write('web/package.json', JSON.stringify({ scripts: { build: 'node build.cjs' } }));
    write('web/build.cjs', `
      const fs = require('node:fs');
      const output = process.argv[process.argv.indexOf('--outDir') + 1];
      if (!output || output === process.argv[0]) throw new Error('Expected isolated output');
      fs.mkdirSync(output, { recursive: true });
      fs.writeFileSync(require('node:path').join(output, 'index.html'), 'candidate UI');
      fs.writeFileSync('../core/data/build-location.json', JSON.stringify({ output }));
    `);
    write('web/node_modules/.bin/vue-tsc', '#!/usr/bin/env node\n');
    write('web/node_modules/.bin/vite', '#!/usr/bin/env node\nrequire("../../build.cjs");\n');
    fs.chmodSync(path.join(dir, 'web/node_modules/.bin/vue-tsc'), 0o700);
    fs.chmodSync(path.join(dir, 'web/node_modules/.bin/vite'), 0o700);
    write('web/dist/index.html', 'approved UI');
    const fakeCli = `#!/usr/bin/env node
const fs = require('node:fs');
let prompt = '';
process.stdin.on('data', c => { prompt += c; });
process.stdin.on('end', () => {
  const phase = prompt.match(/只完成 (\\w+) 阶段/)[1];
  const agent = process.argv.includes('exec') ? 'codex' : 'claude';
  fs.appendFileSync('core/data/calls.log', phase + ':' + agent + '\\n');
  if (phase === 'implement') {
    fs.writeFileSync('core/src/example.js', 'module.exports = 2;\\n');
    fs.appendFileSync('docs/HANDOFF.md', 'Verified implementation\\n');
    if (fs.existsSync('core/data/touch-web')) fs.writeFileSync('web/src/example.js', 'export default 2;\\n');
  }
  const reject = fs.existsSync('core/data/reject-review');
  const decision = { triage: 'triaged', research: 'researched', plan: 'approve', implement: 'implemented', review: reject ? 'reject' : 'approve', diagnose: reject ? 'stop' : 'repair', repair: 'no_change', repair_review: 'approve' }[phase];
  const result = {decision, summary: 'Verified fixture change', ...(phase === 'diagnose' ? {allowedFiles: []} : {}), ...(phase === 'plan' ? {allowedFiles:['core/src/example.js','docs/HANDOFF.md','web/src/example.js'], acceptanceChecks:['example returns expected value']} : {})};
  if (agent === 'claude') {
    const schemaIndex = process.argv.indexOf('--json-schema');
    if (schemaIndex < 0 || !JSON.parse(process.argv[schemaIndex + 1]).properties.decision.enum.includes(decision)) throw new Error('Missing stage schema');
    if (phase === 'research' && fs.existsSync('core/data/invalid-research-once')) {
      fs.unlinkSync('core/data/invalid-research-once');
      process.stdout.write(JSON.stringify({subtype:'success', is_error:false, result:'unstructured report'}));
    } else process.stdout.write(JSON.stringify({subtype:'success', is_error:false, result:'completed', structured_output:result}));
  } else {
    const schemaIndex = process.argv.indexOf('--output-schema');
    if (schemaIndex < 0 || !JSON.parse(fs.readFileSync(process.argv[schemaIndex + 1])).properties.decision.enum.includes(decision)) throw new Error('Missing stage schema');
    fs.writeFileSync(process.argv[process.argv.indexOf('--output-last-message') + 1], JSON.stringify(result));
  }
});
`;
    write('core/data/fake-agent', fakeCli);
    fs.chmodSync(path.join(dir, 'core/data/fake-agent'), 0o700);
    fs.mkdirSync(path.join(dir, 'core/data/logs'), { recursive: true });
    git(['init', '-q']);
    git(['config', 'user.name', 'Test']);
    git(['config', 'user.email', ['test', 'users.noreply.github.com'].join('@')]);
    git(['add', '.']);
    git(['commit', '-qm', 'fixture']);
    const baseCommit = git(['rev-parse', 'HEAD']);
    const run = (runId) => {
      const input = {
        runId, baseCommit, task: 'safety', prompt: 'Fixture task',
        settings: { mainAgent: 'codex', subAgent: 'claude', dualAgentEnabled: true },
        bins: { codex: path.join(dir, 'core/data/fake-agent'), claude: path.join(dir, 'core/data/fake-agent') },
        logDir: path.join(dir, 'core/data/logs'), dataDir: path.join(dir, 'core/data'),
      };
      return spawnSync(process.execPath, ['core/scripts/run-evolution-team.js'], {
        cwd: dir, input: JSON.stringify(input), encoding: 'utf8', timeout: 20000,
        env: { ...process.env, FARM_DATA_DIR: path.join(dir, 'core/data') },
      });
    };
    const success = run('success');
    assert.equal(success.status, 0, success.stderr);
    const head = git(['rev-parse', 'HEAD']);
    assert.notEqual(head, baseCommit);
    assert.equal(git(['status', '--porcelain']), '');
    const active = { runId: 'success', baseCommit, agent: 'codex', subAgent: 'claude', dualAgentEnabled: true };
    assert.equal(isTeamResultApproved(readTeamJournal(path.join(dir, 'core/data/logs'), active), head), true);
    assert.match(success.stdout, /# pass 1/);
    assert.equal(fs.readFileSync(path.join(dir, 'core/data/calls.log'), 'utf8'), 'triage:codex\nresearch:claude\nplan:codex\nimplement:claude\nreview:codex\n');
    // 此 reset 只操作测试创建的临时仓库。
    git(['reset', '--hard', baseCommit]);
    write('core/data/reject-review', '1');
    const rejected = run('reject');
    assert.equal(rejected.status, 1);
    assert.equal(git(['rev-parse', 'HEAD']), baseCommit);
    assert.notEqual(git(['status', '--porcelain']), '');
    assert.equal(isTeamResultApproved(readTeamJournal(path.join(dir, 'core/data/logs'), { ...active, runId: 'reject' }), baseCommit), false);
    git(['reset', '--hard', baseCommit]);
    fs.unlinkSync(path.join(dir, 'core/data/reject-review'));
    write('core/data/calls.log', '');
    write('core/data/invalid-research-once', '1');
    const recovered = run('recovered');
    assert.equal(recovered.status, 0, recovered.stderr);
    const recoveredHead = git(['rev-parse', 'HEAD']);
    const journal = readTeamJournal(path.join(dir, 'core/data/logs'), { ...active, runId: 'recovered' });
    assert.equal(journal.recoveryAttempt, 1);
    assert.equal(journal.lastFailure.code, 'invalid_output');
    assert.equal(isTeamResultApproved(journal, recoveredHead), true);
    assert.equal(fs.readFileSync(path.join(dir, 'core/data/calls.log'), 'utf8'), 'triage:codex\nresearch:claude\ndiagnose:codex\nrepair:claude\nrepair_review:codex\nresearch:claude\nplan:codex\nimplement:claude\nreview:codex\n');
    assert.ok(fs.readdirSync(path.join(dir, 'core/data/logs')).every(file => !file.endsWith('-schema.json')));
    git(['reset', '--hard', baseCommit]);
    write('core/data/touch-web', '1');
    const webVerified = run('web-build');
    assert.equal(webVerified.status, 0, webVerified.stderr);
    assert.equal(fs.readFileSync(path.join(dir, 'web/dist/index.html'), 'utf8'), 'approved UI');
    const built = JSON.parse(fs.readFileSync(path.join(dir, 'core/data/build-location.json')));
    assert.notEqual(built.output, path.join(dir, 'web/dist'));
    assert.equal(fs.existsSync(built.output), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
