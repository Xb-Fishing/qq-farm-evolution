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
    for (const name of ['activity-evolver', 'privacy-guard', 'evolution-team', 'evolution-validation', 'evolution-countercheck']) {
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
    if (fs.existsSync('core/data/countercheck-required')) fs.writeFileSync('core/test/behavior.test.js', 'require("node:test")("detect old behavior", () => require("node:assert/strict").equal(require("../src/example"), 2));\\n');
  }
  if (phase === 'review' && fs.existsSync('core/data/countercheck-required')) {
    const proof = JSON.parse(fs.readFileSync('core/data/evolution-countercheck.json'));
    if (proof.state !== 'passed' || proof.checks[0].baseline.behaviorFailures !== 1 || proof.checks[0].current.failed !== 0) throw new Error('Coordinator evidence missing');
  }
  const reject = fs.existsSync('core/data/reject-review');
  const decision = { triage: 'triaged', research: 'researched', plan: 'approve', implement: 'implemented', review: reject ? 'reject' : 'approve', diagnose: reject ? 'stop' : 'repair', repair: 'no_change', repair_review: 'approve' }[phase];
  const result = {decision, summary: 'Verified fixture change', ...(phase === 'diagnose' ? {allowedFiles: []} : {}), ...(phase === 'plan' ? {allowedFiles:['core/src/example.js','docs/HANDOFF.md','web/src/example.js','core/test/behavior.test.js'], acceptanceChecks:['example returns expected value'], baselineChecks:fs.existsSync('core/data/countercheck-required')?[{sourceFiles:['core/src/example.js'],testFiles:['core/test/behavior.test.js'],minFailures:1}]:[]} : {}), ...(['plan','review'].includes(phase) ? {feedbackReviewed: true, lessons: []} : {}), ...(phase === 'review' ? {githubResolutions: []} : {})};
  // 读取实际传入的 Schema（claude 内联 / codex 文件），对交接结果做递归结构校验，
  // 不只看 decision 枚举：缺必填字段、多字段、类型/枚举/模式不匹配都在 CLI 侧暴露，
  // 让契约回归（如可选字段重新出现）在此直接失败而不是流入协调进程。
  const validate = (value, schema, where) => {
    if (Array.isArray(schema.anyOf)) {
      if (!schema.anyOf.some(branch => { try { validate(value, branch, where); return true; } catch { return false; } })) throw new Error('schema anyOf failed at ' + where);
      return;
    }
    if (schema.properties) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('schema expected object at ' + where);
      for (const key of schema.required || []) if (!(key in value)) throw new Error('schema missing required ' + where + '.' + key);
      for (const key of Object.keys(value)) {
        if (!schema.properties[key]) throw new Error('schema unexpected ' + where + '.' + key);
        validate(value[key], schema.properties[key], where + '.' + key);
      }
      return;
    }
    const fail = (detail) => { throw new Error('schema ' + detail + ' at ' + where); };
    if (schema.type === 'array') {
      if (!Array.isArray(value)) fail('expected array');
      if (schema.maxItems && value.length > schema.maxItems) fail('maxItems');
      value.forEach((item, index) => validate(item, schema.items, where + '[' + index + ']'));
      return;
    }
    if (schema.type === 'string') {
      if (typeof value !== 'string') fail('expected string');
      if (schema.enum && !schema.enum.includes(value)) fail('enum');
      if (schema.pattern && !new RegExp(schema.pattern).test(value)) fail('pattern');
      if (schema.maxLength && value.length > schema.maxLength) fail('maxLength');
      return;
    }
    if (schema.type === 'integer') {
      if (!Number.isInteger(value) || value < schema.minimum || value > schema.maximum) fail('integer range');
      return;
    }
    if (schema.type === 'boolean') { if (typeof value !== 'boolean') fail('expected boolean'); return; }
    if (schema.type === 'null') { if (value !== null) fail('expected null'); return; }
    fail('unsupported type ' + schema.type);
  };
  const schemaFlag = agent === 'claude' ? '--json-schema' : '--output-schema';
  const schemaIndex = process.argv.indexOf(schemaFlag);
  if (schemaIndex < 0) throw new Error('Missing stage schema');
  const schema = agent === 'claude' ? JSON.parse(process.argv[schemaIndex + 1]) : JSON.parse(fs.readFileSync(process.argv[schemaIndex + 1]));
  if (!schema.properties.decision.enum.includes(decision)) throw new Error('Stage decision outside schema enum');
  validate(result, schema, phase);
  if (agent === 'claude') {
    if (phase === 'research' && fs.existsSync('core/data/invalid-research-once')) {
      fs.unlinkSync('core/data/invalid-research-once');
      process.stdout.write(JSON.stringify({subtype:'success', is_error:false, result:'unstructured report'}));
    } else process.stdout.write(JSON.stringify({subtype:'success', is_error:false, result:'completed', structured_output:result}));
  } else {
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
    const run = (runId, agents = {}) => {
      const input = {
        runId, baseCommit, task: 'safety', prompt: 'Fixture task',
        settings: { mainAgent: 'codex', subAgent: 'claude', dualAgentEnabled: true, ...agents },
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
    assert.equal(fs.readFileSync(path.join(dir, 'core/data/calls.log'), 'utf8'), 'research:claude\nplan:codex\nimplement:claude\nreview:codex\n');
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
    assert.equal(fs.readFileSync(path.join(dir, 'core/data/calls.log'), 'utf8'), 'research:claude\ndiagnose:codex\nrepair:claude\nresearch:claude\nplan:codex\nimplement:claude\nreview:codex\n');
    assert.ok(fs.readdirSync(path.join(dir, 'core/data/logs')).every(file => !file.endsWith('-schema.json')));
    git(['reset', '--hard', baseCommit]);
    write('core/data/touch-web', '1');
    const webVerified = run('web-build');
    assert.equal(webVerified.status, 0, webVerified.stderr);
    assert.equal(fs.readFileSync(path.join(dir, 'web/dist/index.html'), 'utf8'), 'approved UI');
    const built = JSON.parse(fs.readFileSync(path.join(dir, 'core/data/build-location.json')));
    assert.notEqual(built.output, path.join(dir, 'web/dist'));
    assert.equal(fs.existsSync(built.output), false);
    git(['reset', '--hard', baseCommit]);
    write('core/data/countercheck-required', '1');
    const counterchecked = run('countercheck');
    assert.equal(counterchecked.status, 0, counterchecked.stderr);
    const proof = JSON.parse(fs.readFileSync(path.join(dir, 'core/data/evolution-countercheck.json')));
    assert.equal(proof.state, 'passed');
    assert.equal(proof.checks[0].baseline.behaviorFailures, 1);
    assert.equal(proof.checks[0].baseline.otherFailures, 0);
    git(['reset', '--hard', baseCommit]);
    fs.unlinkSync(path.join(dir, 'core/data/countercheck-required'));
    fs.unlinkSync(path.join(dir, 'core/data/touch-web'));
    write('core/data/calls.log', '');
    // 角色反选：主 Agent 走 claude（内联 --json-schema），子 Agent 走 codex
    // （--output-schema 文件）——两种 Schema 传递机制都要通过同一递归结构校验。
    const swapped = run('swapped', { mainAgent: 'claude', subAgent: 'codex' });
    assert.equal(swapped.status, 0, swapped.stderr);
    const swappedHead = git(['rev-parse', 'HEAD']);
    assert.notEqual(swappedHead, baseCommit);
    assert.equal(git(['status', '--porcelain']), '');
    assert.equal(fs.readFileSync(path.join(dir, 'core/data/calls.log'), 'utf8'), 'research:codex\nplan:claude\nimplement:codex\nreview:claude\n');
    assert.equal(isTeamResultApproved(readTeamJournal(path.join(dir, 'core/data/logs'), { runId: 'swapped', baseCommit, agent: 'claude', subAgent: 'codex', dualAgentEnabled: true }), swappedHead), true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// 真实 runner 跨进程续接合同（2026-10-05 复审 R3/R4）：checkpoint 只信 run1 真实
// 落盘的 journal（不手写凭据）；run2 以当前工作区独立实测：同树精确匹配 → 续接
// 跳过 research/plan/implement 直接最终复核提交；任何偏差（额外修改授权内未记录
// 文件、新增授权内未记录文件、仅暂存区变更、mode 变化、HEAD 变化）都在启动任何
// Agent 阶段之前拒绝（calls.log 空、零提交）。
// ---------------------------------------------------------------------------
test('真实 runner 跨进程：run1 真实 checkpoint，run2 按精确合同续接或拒绝', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'farm-team-resume-'));
  const write = (file, data) => {
    // 外穿硬拒：fixture 写入目标解析后必须落在 fixture 内（2026-10-05 覆盖事故教训）。
    const full = path.resolve(dir, file);
    if (full !== dir && !full.startsWith(dir + path.sep)) throw new Error(`fixture_escape:${file}`);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, data);
  };
  const git = args => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
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
  }
  const reject = fs.existsSync('core/data/reject-review');
  const decision = { research: 'researched', plan: 'approve', implement: 'implemented', review: reject ? 'reject' : 'approve', diagnose: 'stop', repair: 'no_change', repair_review: 'approve' }[phase];
  const result = { decision, summary: 'Fixture stage summary',
    ...(phase === 'plan' ? { allowedFiles: ['core/src/example.js', 'docs/HANDOFF.md', 'web/src/example.js', 'core/test/behavior.test.js'], acceptanceChecks: ['example returns expected value'], baselineChecks: [] } : {}),
    ...(['plan', 'review'].includes(phase) ? { feedbackReviewed: true, lessons: [] } : {}),
    ...(phase === 'review' ? { githubResolutions: [] } : {}) };
  if (agent === 'codex') fs.writeFileSync(process.argv[process.argv.indexOf('--output-last-message') + 1], JSON.stringify(result));
  else process.stdout.write(JSON.stringify({ subtype: 'success', is_error: false, result: 'completed', structured_output: result }));
});
`;
  try {
    write('core/scripts/run-evolution-team.js', fs.readFileSync(path.join(__dirname, '../scripts/run-evolution-team.js')));
    for (const name of ['activity-evolver', 'privacy-guard', 'evolution-team']) {
      write(`core/src/services/${name}.js`, `module.exports = require(${JSON.stringify(require.resolve(`../src/services/${name}`))});\n`);
    }
    // 验证/反证只关心续接合同，不重复覆盖真实验证链路（上文真实 fixture 已覆盖）。
    write('core/src/services/evolution-validation.js', 'module.exports.runEvolutionValidation = async () => ({ state: "passed", checks: ["backend"] });\n');
    write('core/src/services/evolution-countercheck.js', 'module.exports.runBaselineChecks = async () => ({ state: "passed", checks: [] });\n');
    write('core/src/services/evolution-references.js', 'module.exports.collectPublicReferences = async () => ({ state: "complete", discoveryComplete: true });\n');
    write('.gitignore', 'core/data/\n');
    write('docs/HANDOFF.md', 'Fixture constraints\n');
    write('core/src/example.js', 'module.exports = 1;\n');
    // 授权内（plan allowedFiles）但 run1 不改动（快照外）的已跟踪文件：
    // 用于"额外修改授权内未记录文件"——UNION 挡不住它，只有精确快照合同能拒。
    write('web/src/example.js', 'export default 1;\n');
    write('core/data/fake-agent', fakeCli);
    fs.chmodSync(path.join(dir, 'core/data/fake-agent'), 0o700);
    fs.mkdirSync(path.join(dir, 'core/data/logs'), { recursive: true });
    git(['init', '-q']);
    git(['config', 'user.name', 'Test']);
    git(['config', 'user.email', ['test', 'users.noreply.github.com'].join('@')]);
    git(['add', '.']);
    git(['commit', '-qm', 'fixture']);
    const baseCommit = git(['rev-parse', 'HEAD']);
    const run = (runId, extra = {}) => {
      const input = {
        runId, baseCommit, task: 'safety', prompt: 'Fixture task',
        settings: { mainAgent: 'codex', subAgent: 'claude', dualAgentEnabled: true },
        bins: { codex: path.join(dir, 'core/data/fake-agent'), claude: path.join(dir, 'core/data/fake-agent') },
        logDir: path.join(dir, 'core/data/logs'), dataDir: path.join(dir, 'core/data'),
        ...extra,
      };
      return spawnSync(process.execPath, ['core/scripts/run-evolution-team.js'], {
        cwd: dir, input: JSON.stringify(input), encoding: 'utf8', timeout: 60_000,
        env: { ...process.env, FARM_DATA_DIR: path.join(dir, 'core/data') },
      });
    };
    const calls = () => fs.readFileSync(path.join(dir, 'core/data/calls.log'), 'utf8');
    // run1：review 一路拒绝到预算耗尽，留下真实 in_run checkpoint（含脏树逐文件快照）。
    write('core/data/reject-review', '1');
    write('core/data/calls.log', '');
    const exhausted = run('reject1');
    assert.equal(exhausted.status, 1, exhausted.stderr);
    assert.equal(git(['rev-parse', 'HEAD']), baseCommit, 'run1 不得提交');
    const journal1 = JSON.parse(fs.readFileSync(path.join(dir, 'core/data/logs/evolve-team-reject1.json'), 'utf8'));
    assert.equal(journal1.terminationCode, 'recovery_exhausted');
    const checkpoint = journal1.checkpoint;
    assert.ok(checkpoint && checkpoint.kind === 'in_run', 'run1 必须留下真实续接凭据');
    assert.deepEqual(Object.keys(checkpoint.fileFingerprints).sort(), ['core/src/example.js', 'docs/HANDOFF.md']);
    assert.ok(/^[0-9a-f]{64}$/.test(checkpoint.worktreeFingerprint));
    // run2：同树合法续接——跳过 research/plan/implement，直接最终复核 + 提交。
    fs.unlinkSync(path.join(dir, 'core/data/reject-review'));
    write('core/data/calls.log', '');
    const resumed = run('resume-ok', { resume: checkpoint });
    assert.equal(resumed.status, 0, resumed.stderr);
    const resumedHead = git(['rev-parse', 'HEAD']);
    assert.notEqual(resumedHead, baseCommit);
    assert.equal(git(['status', '--porcelain']), '');
    assert.equal(calls(), 'review:codex\n', '续接只应跑最终复核，不重开调研/实施');
    const journal2 = readTeamJournal(path.join(dir, 'core/data/logs'), { runId: 'resume-ok', baseCommit, agent: 'codex', subAgent: 'claude', dualAgentEnabled: true });
    assert.equal(isTeamResultApproved(journal2, resumedHead), true);
    // 之后的拒绝用例都从基线重建 run1 留下的那棵脏树（内容/权限逐字节一致）。
    const dirty = () => {
      git(['reset', '--hard', baseCommit]);
      git(['clean', '-fdq']);
      write('core/src/example.js', 'module.exports = 2;\n');
      write('docs/HANDOFF.md', 'Fixture constraints\nVerified implementation\n');
      write('core/data/calls.log', '');
    };
    const rejections = [
      ['rej-extra-modify', 'worktree_changed', () => write('web/src/example.js', 'export default 2;\n')],
      ['rej-extra-untracked', 'worktree_changed', () => write('core/test/behavior.test.js', 'assert(true);\n')],
      ['rej-staging-only', 'worktree_changed', () => {
        git(['add', 'core/src/example.js']);
        write('core/src/example.js', 'module.exports = 1;\n'); // 工作区还原成 HEAD，只剩暂存区差异
      }],
      ['rej-mode-change', 'worktree_changed', () => fs.chmodSync(path.join(dir, 'core/src/example.js'), 0o755)],
      ['rej-head-change', 'head_changed', () => {
        git(['add', 'core/src/example.js', 'docs/HANDOFF.md']);
        git(['commit', '-qm', 'sneaky move']);
      }],
    ];
    for (const [runId, code, mutate] of rejections) {
      dirty();
      mutate();
      const rejected = run(runId, { resume: checkpoint });
      assert.equal(rejected.status, 1, `${runId} 必须失败: ${rejected.stderr}`);
      const journal = JSON.parse(fs.readFileSync(path.join(dir, `core/data/logs/evolve-team-${runId}.json`), 'utf8'));
      assert.equal(journal.failure.code, code, `${runId} 失败类别`);
      assert.equal(journal.phase, 'failed', `${runId} 不应进入任何阶段`);
      assert.equal(calls(), '', `${runId} 必须在启动任何 Agent 阶段前拒绝`);
      if (code === 'worktree_changed') assert.equal(git(['rev-parse', 'HEAD']), baseCommit, `${runId} 不得提交`);
    }
    // 全部拒绝后收尾回到基线，脏树仍在（未被任何 runner reset/stash）。
    dirty();
    // porcelain 首行前导空格是固定列：helper 的整体 trim 会吃掉它（R3 同根 bug），
    // 这里必须用原始输出比对。
    const finalStatus = execFileSync('git', ['status', '--porcelain', '--untracked-files=normal'], { cwd: dir, encoding: 'utf8' });
    assert.deepEqual(finalStatus.split('\n').filter(Boolean).sort(),
      [' M core/src/example.js', ' M docs/HANDOFF.md']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// patch_review 冻结契约（2026-10-04 事故回归）：验收 Schema 刻意最小化（仅
// decision+summary），不复用 review 业务 Schema，修 review 契约的补丁不能被旧
// review Schema 卡死；任何字段变化都需要主 Agent 独立批准。
test('patch_review 验收契约保持冻结：只有 decision 与 summary', () => {
  const { buildStageSchema } = require('../src/services/evolution-team');
  const schema = buildStageSchema('patch_review');
  assert.deepEqual(Object.keys(schema.properties).sort(), ['decision', 'summary']);
  assert.deepEqual([...schema.required].sort(), ['decision', 'summary']);
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual([...schema.properties.decision.enum], ['approve', 'reject']);
  const review = buildStageSchema('review');
  assert.ok(review.properties.githubResolutions && review.properties.lessons, 'review 业务 Schema 独立演化');
});

// worktreeChangeFiles 真实 git 解析回归（R3 Parent 死锁根因）：porcelain 首行
// ' M file' 的前导空格是固定列，绝不能 trim；-z 下重命名取新路径跳过原路径；
// 仅暂存区差异也必须被看见；含空格路径不损坏。
test('worktreeChangeFiles：前导空格、仅暂存、重命名、未跟踪、空格文件名', () => {
  const { worktreeChangeFiles } = require('../src/services/activity-evolver');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'farm-parse-'));
  const write = (file, data) => {
    const full = path.resolve(dir, file);
    if (full !== dir && !full.startsWith(dir + path.sep)) throw new Error(`fixture_escape:${file}`);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, data);
  };
  const git = args => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  try {
    write('core/src/a.js', 'module.exports = 1;\n');
    write('sp ace.js', 'export default 1;\n');
    write('core/src/deep/name.js', 'module.exports = 2;\n');
    git(['init', '-q']);
    git(['config', 'user.name', 'Test']);
    git(['config', 'user.email', ['test', 'users.noreply.github.com'].join('@')]);
    git(['add', '.']);
    git(['commit', '-qm', 'fixture']);
    // 首个且唯一条目是工作区修改：旧 bug 整体 trim 吃掉前导空格 → 'ore/src/a.js'。
    write('core/src/a.js', 'module.exports = 3;\n');
    assert.deepEqual(worktreeChangeFiles(dir), ['core/src/a.js']);
    // 仅暂存区（工作区已还原成 HEAD 内容）：diff HEAD 看不见，必须仍被列出。
    git(['add', 'core/src/a.js']);
    write('core/src/a.js', 'module.exports = 1;\n');
    assert.ok(worktreeChangeFiles(dir).includes('core/src/a.js'), '仅暂存区差异必须被看见');
    // 重命名（-z 第二字段是原路径）：取新路径、不把原路径当独立文件。
    git(['mv', 'sp ace.js', 'renamed.js']);
    const renamed = worktreeChangeFiles(dir);
    assert.ok(renamed.includes('renamed.js'), `rename 新路径应被记录: ${renamed}`);
    assert.ok(!renamed.includes('sp ace.js') && !renamed.includes('sp ace.js\0renamed.js'), '原路径不得混入');
    // 未跟踪文件。
    write('core/src/untracked.js', '');
    assert.ok(worktreeChangeFiles(dir).includes('core/src/untracked.js'));
    assert.equal(worktreeChangeFiles(path.join(dir, 'nonexistent')), null, 'git 失败按不可证明返回 null');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
