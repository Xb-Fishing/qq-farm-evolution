const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { test } = require('node:test');
const {
  normalizeAgentSettings, validateAgentSettings, parseStageResult,
  teamJournalPath, readTeamJournal, isTeamResultApproved, runTeamWorkflow,
  createTeamError, normalizeTeamFailure,
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
      const contextIndex = prompt.indexOf('【待协调进程注入当前 HANDOFF 有界摘录】');
      assert.ok(contextIndex >= 0 && contextIndex < prompt.indexOf('双 Agent 阶段契约'));
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
    for (const name of ['activity-evolver', 'privacy-guard', 'evolution-team', 'evolution-validation', 'evolution-countercheck', 'evolution-sessions', 'evolution-worktree']) {
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
// 原生会话感知夹具 CLI：codex app-server 子协议（thread/read→resume→compact/start
// + item/started/completed contextCompaction）、claude 原生 /compact（compact_boundary
// + 成功 result）、首轮 session_id/thread.started 捕获与 resume 参数接受。
const SESSION = { claude: 'aaaa1111-2222-3333-4444-555566667777', codex: 'bbbb8888-9999-aaaa-bbbb-ccccddddeeee' };
if (process.argv[2] === 'app-server') {
  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\\n')) >= 0) {
      const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
      if (!line) continue;
      let value; try { value = JSON.parse(line); } catch { continue; }
      if (value.id === undefined || !value.method) continue;
      const reply = result => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: value.id, result }) + '\\n');
      if (value.method === 'thread/read' || value.method === 'thread/resume') {
        fs.appendFileSync('core/data/appserver.log', value.method + '\\n');
        reply({ thread: { id: value.params.threadId } });
      } else if (value.method === 'thread/compact/start') {
        fs.appendFileSync('core/data/appserver.log', 'thread/compact/start\\n');
        reply({});
        for (const method of ['item/started', 'item/completed']) {
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method, params: { threadId: value.params.threadId, item: { type: 'contextCompaction' } } }) + '\\n');
        }
      } else reply({});
    }
  });
  return;
}
let prompt = '';
process.stdin.on('data', c => { prompt += c; });
process.stdin.on('end', () => {
  const agent = process.argv.includes('exec') ? 'codex' : 'claude';
  // 实测参数合同：该 codex 二进制的 exec resume 子命令不支持 --color（仅 exec 有）；
  // claude print/stream-json 模式必须带 --verbose 才输出事件流。
  if (agent === 'codex' && process.argv.includes('resume') && process.argv.includes('--color')) process.exit(2);
  if (prompt === '/compact') {
    if (!process.argv.includes('--verbose')) process.exit(2);
    process.stdout.write(JSON.stringify({ type: 'system', subtype: 'compact_boundary', session_id: SESSION.claude }) + '\\n');
    process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, session_id: SESSION.claude }) + '\\n');
    return;
  }
  const phase = prompt.match(/只完成 (\\w+) 阶段/)[1];
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
      process.stdout.write(JSON.stringify({subtype:'success', is_error:false, session_id: SESSION.claude, result:'unstructured report'}));
    } else process.stdout.write(JSON.stringify({subtype:'success', is_error:false, session_id: SESSION.claude, result:'completed', structured_output:result}));
  } else {
    if (process.argv.includes('--json')) {
      process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: SESSION.codex }) + '\\n');
    }
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
const SESSION = { claude: 'aaaa1111-2222-3333-4444-555566667777', codex: 'bbbb8888-9999-aaaa-bbbb-ccccddddeeee' };
if (process.argv[2] === 'app-server') {
  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\\n')) >= 0) {
      const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
      if (!line) continue;
      let value; try { value = JSON.parse(line); } catch { continue; }
      if (value.id === undefined || !value.method) continue;
      const reply = result => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: value.id, result }) + '\\n');
      if (value.method === 'thread/read' || value.method === 'thread/resume') reply({ thread: { id: value.params.threadId } });
      else if (value.method === 'thread/compact/start') {
        reply({});
        for (const method of ['item/started', 'item/completed']) {
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method, params: { threadId: value.params.threadId, item: { type: 'contextCompaction' } } }) + '\\n');
        }
      } else reply({});
    }
  });
  return;
}
let prompt = '';
process.stdin.on('data', c => { prompt += c; });
process.stdin.on('end', () => {
  const agent = process.argv.includes('exec') ? 'codex' : 'claude';
  // 实测参数合同：该 codex 二进制的 exec resume 子命令不支持 --color（仅 exec 有）；
  // claude print/stream-json 模式必须带 --verbose 才输出事件流。
  if (agent === 'codex' && process.argv.includes('resume') && process.argv.includes('--color')) process.exit(2);
  if (prompt === '/compact') {
    if (!process.argv.includes('--verbose')) process.exit(2);
    process.stdout.write(JSON.stringify({ type: 'system', subtype: 'compact_boundary', session_id: SESSION.claude }) + '\\n');
    process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, session_id: SESSION.claude }) + '\\n');
    return;
  }
  const phase = prompt.match(/只完成 (\\w+) 阶段/)[1];
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
  if (agent === 'codex') {
    if (process.argv.includes('--json')) process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: SESSION.codex }) + '\\n');
    fs.writeFileSync(process.argv[process.argv.indexOf('--output-last-message') + 1], JSON.stringify(result));
  } else process.stdout.write(JSON.stringify({ subtype: 'success', is_error: false, session_id: SESSION.claude, result: 'completed', structured_output: result }));
});
`;
  try {
    write('core/scripts/run-evolution-team.js', fs.readFileSync(path.join(__dirname, '../scripts/run-evolution-team.js')));
    for (const name of ['activity-evolver', 'privacy-guard', 'evolution-team', 'evolution-sessions', 'evolution-worktree']) {
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

// 空写入范围后的新验证失败必须真实重新诊断（2026-10-05 真实失败路由缺陷）：
// scopedValidationRepair 旧实现把 approvedScope=[] 当真值，只读零文件修复后的
// verification_failed 被静默路由回同一空范围——永远无法修复。新合同：无写入
// 范围时的验证失败必须由主 Agent 真实诊断并批准最小受影响文件；不自动扩范围，
// 不把 stop 翻成 approve，最终只走一次业务复核。
test('初始 CLI 失败→只读修复→验证失败：必须新诊断给出写入范围后才修复提交', async () => {
  const calls = [];
  const files = {};
  let committed = 0;
  let diagnoseCount = 0;
  let diagnoseScope = [];
  const deps = {
    settings: { mainAgent: 'codex', subAgent: 'claude', dualAgentEnabled: true },
    prompt: 'fixture task', efficientMode: true, verifyBaseline: true,
    initialFailure: normalizeTeamFailure({ code: 'cli_exit', exitCode: 1 }, 'research', 'claude'),
    inspect: async () => ({ head: 'a'.repeat(40), dirty: Object.keys(files).length > 0,
      fingerprint: JSON.stringify(files), files: Object.keys(files), fileFingerprints: { ...files } }),
    onProgress: async () => {},
    runStage: async (phase, agent) => {
      calls.push([phase, agent]);
      if (phase === 'diagnose') {
        diagnoseCount += 1;
        diagnoseScope = diagnoseCount === 1 ? [] : ['core/src/example.js'];
        return diagnoseCount === 1
          ? { decision: 'repair', summary: '先只读核对验证失败', allowedFiles: [] }
          : { decision: 'repair', summary: '批准最小受影响文件的写入范围', allowedFiles: diagnoseScope };
      }
      if (phase === 'repair') {
        if (diagnoseScope.length) files['core/src/example.js'] = 'fixed';
        return { decision: diagnoseScope.length ? 'implemented' : 'no_change',
          summary: diagnoseScope.length ? 'fixed real file' : 'readonly verified' };
      }
      if (phase === 'plan') return { decision: 'approve', summary: 'approved scope',
        allowedFiles: ['core/src/example.js'], acceptanceChecks: ['example behavior'] };
      if (phase === 'implement') { files['core/src/example.js'] = 'implemented'; return { decision: 'implemented', summary: 'implemented' }; }
      if (phase === 'review') return { decision: 'approve', summary: 'final review', githubResolutions: [] };
      return { decision: 'researched', summary: 'researched' };
    },
    // 文件未被真正修复前，验证始终失败——空范围循环必须被真实诊断打破。
    verify: async () => { if (!files['core/src/example.js']) throw createTeamError('verification_failed'); },
    commit: async () => { committed += 1; return 'b'.repeat(40); },
  };
  const result = await runTeamWorkflow(deps);
  assert.equal(result.decision, 'approve');
  assert.deepEqual(calls.map(call => call[0]), [
    'diagnose', 'repair', 'diagnose', 'repair', 'research', 'plan', 'implement', 'review',
  ]);
  assert.equal(diagnoseCount, 2, '第二次验证失败必须触发新的主 Agent 诊断（不得复用空范围）');
  assert.equal(calls.filter(([phase]) => phase === 'review').length, 1, '最终业务复核只走一次');
  assert.equal(calls.some(([phase]) => phase === 'repair_review' || phase === 'patch_review'), false);
  assert.equal(committed, 1);
});

// ---------------------------------------------------------------------------
// Fresh stages accept valid outputs independently of native IDs.
test('真实 runner：大事件、无原生 ID 与失败恢复均使用独立新会话', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'farm-team-session-'));
  const write = (file, data) => {
    const full = path.resolve(dir, file);
    if (full !== dir && !full.startsWith(dir + path.sep)) throw new Error(`fixture_escape:${file}`);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, data);
  };
  const git = args => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const fakeCli = `#!/usr/bin/env node
const fs = require('node:fs');
const SESSION = { claude: 'aaaa1111-2222-3333-4444-555566667777', codex: 'bbbb8888-9999-aaaa-bbbb-ccccddddeeee' };
const DRIFT = 'dddd7777-8888-9999-aaaa-bbbbccccdddd';
const mode = f => fs.existsSync(f);
if (process.argv[2] === 'app-server' || process.argv.includes('resume') || process.argv.includes('--resume')) process.exit(9);
let prompt = '';
process.stdin.on('data', c => { prompt += c; });
process.stdin.on('end', () => {
  const agent = process.argv.includes('exec') ? 'codex' : 'claude';
  if (prompt === '/compact' || process.env.DISABLE_AUTO_COMPACT !== '1') process.exit(9);
  const phase = prompt.match(/只完成 (\\w+) 阶段/)[1];
  fs.appendFileSync('core/data/calls.log', phase + ':' + agent + '\\n');
  if (phase === 'implement') {
    fs.writeFileSync('core/src/example.js', 'module.exports = 2;\\n');
    fs.appendFileSync('docs/HANDOFF.md', 'Verified implementation\\n');
  }
  const decision = { research: 'researched', plan: 'approve', implement: 'implemented', review: 'approve', diagnose: 'repair', repair: 'no_change', repair_review: 'approve' }[phase];
  const result = { decision, summary: 'Fixture stage summary',
    ...(phase === 'diagnose' ? { allowedFiles: [] } : {}),
    ...(phase === 'plan' ? { allowedFiles: ['core/src/example.js', 'docs/HANDOFF.md'], acceptanceChecks: ['example returns expected value'], baselineChecks: [] } : {}),
    ...(['plan', 'review'].includes(phase) ? { feedbackReviewed: true, lessons: [] } : {}),
    ...(phase === 'review' ? { githubResolutions: [] } : {}) };
  if (agent === 'codex') {
    if (mode('core/data/giant-events')) process.stdout.write('x'.repeat(2500000) + '\\n');
    const resumeIndex = process.argv.indexOf('resume');
    if (resumeIndex >= 0) {
      if (process.argv[resumeIndex + 1] !== SESSION.codex) process.exit(3);
      fs.appendFileSync('core/data/resume.log', process.argv[resumeIndex + 1] + '\\n');
    }
    if (mode('core/data/plan-fail-once') && resumeIndex < 0) {
      process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: SESSION.codex }) + '\\n');
      fs.unlinkSync('core/data/plan-fail-once');
      process.exit(1);
    }
    if (mode('core/data/drift')) {
      process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: SESSION.codex }) + '\\n');
      process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: DRIFT }) + '\\n');
    } else if (!mode('core/data/no-thread-events') && process.argv.includes('--json')) {
      process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: SESSION.codex }) + '\\n');
    }
    fs.writeFileSync(process.argv[process.argv.indexOf('--output-last-message') + 1], JSON.stringify(result));
  } else process.stdout.write(JSON.stringify({ subtype: 'success', is_error: false, session_id: SESSION.claude, result: 'completed', structured_output: result }));
});
`;
  try {
    write('core/scripts/run-evolution-team.js', fs.readFileSync(path.join(__dirname, '../scripts/run-evolution-team.js')));
    for (const name of ['activity-evolver', 'privacy-guard', 'evolution-team', 'evolution-sessions', 'evolution-worktree']) {
      write(`core/src/services/${name}.js`, `module.exports = require(${JSON.stringify(require.resolve(`../src/services/${name}`))});\n`);
    }
    write('core/src/services/evolution-validation.js', 'module.exports.runEvolutionValidation = async () => ({ state: "passed", checks: ["backend"] });\n');
    write('core/src/services/evolution-countercheck.js', 'module.exports.runBaselineChecks = async () => ({ state: "passed", checks: [] });\n');
    write('core/src/services/evolution-references.js', 'module.exports.collectPublicReferences = async () => ({ state: "complete", discoveryComplete: true });\n');
    write('.gitignore', 'core/data/\n');
    write('docs/HANDOFF.md', 'Fixture constraints\n');
    write('core/src/example.js', 'module.exports = 1;\n');
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
        cwd: dir, input: JSON.stringify(input), encoding: 'utf8', timeout: 90_000,
        env: { ...process.env, FARM_DATA_DIR: path.join(dir, 'core/data') },
      });
    };
    const journalOf = runId => JSON.parse(fs.readFileSync(path.join(dir, `core/data/logs/evolve-team-${runId}.json`), 'utf8'));
    const registryFile = path.join(dir, 'core/data/evolution-sessions/registry.json');
    // S1：单条 2.5MB 事件不杀进程——后续 thread.started 仍被解析，运行照常完成。
    write('core/data/giant-events', '1');
    const giant = run('giant');
    assert.equal(giant.status, 0, giant.stderr);
    assert.notEqual(git(['rev-parse', 'HEAD']), baseCommit, '大事件不得阻止正常提交');
    fs.unlinkSync(path.join(dir, 'core/data/giant-events'));
    git(['reset', '--hard', baseCommit]);
    git(['clean', '-fdq']);
    assert.ok(!fs.existsSync(registryFile), 'fresh 不写原生登记');

    for (const [runId, marker] of [['drift', 'drift'], ['noid', 'no-thread-events']]) {
      write(`core/data/${  marker}`, '1');
      const result = run(runId);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(journalOf(runId).status, 'completed');
      assert.notEqual(git(['rev-parse', 'HEAD']), baseCommit);
      assert.ok(!fs.existsSync(registryFile));
      fs.unlinkSync(path.join(dir, `core/data/${  marker}`));
      git(['reset', '--hard', baseCommit]);
      git(['clean', '-fdq']);
    }
    write('core/data/calls.log', '');
    write('core/data/plan-fail-once', '1');
    const failonce = run('failonce');
    assert.equal(failonce.status, 0, failonce.stderr);
    assert.notEqual(git(['rev-parse', 'HEAD']), baseCommit);
    assert.ok(!fs.existsSync(registryFile));
    assert.ok(!fs.existsSync(path.join(dir, 'core/data/resume.log')));
    assert.ok(!fs.readdirSync(path.join(dir, 'core/data/logs')).some(file => /-schema\.json$/.test(file)));
    const failonceJournal = journalOf('failonce');
    assert.equal(failonceJournal.lastFailure.code, 'cli_exit', '首轮失败按执行失败真实记录');
    assert.ok(failonceJournal.recoveryAttempt >= 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// executeStreaming（2026-10-07 R6）：丢弃模式内存有界 + 后续有效事件照常解析 +
// onLine 异常时先有界清杀自己启动的子进程、等真实退出后才 reject（候选 id 已在
// 调用方手中保留）。直接驱动导出的真实实现（非手写探针等价物）。
// ---------------------------------------------------------------------------
const { executeStreaming } = require('../scripts/run-evolution-team');

test('executeStreaming：多块无换行超限流有界丢弃，换行后有效事件/最终消息照常解析', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'farm-stream-'));
  try {
    // 夹具 CLI：先正常行，再 3×600KB 无换行块（累计 >1MB 触发丢弃模式），
    // 换行后发两条有效事件；再来 1.2MB 无换行块（二次进入丢弃模式），换行后
    // 发最终消息行；退出码 0。若实现仍在缓冲无换行字节，事件顺序/完成语义都会破。
    const script = `
      process.stdin.resume();
      process.stdin.on('end', () => {
        const out = (s) => process.stdout.write(s);
        out('{"seq":0}\\n');
        for (const filler of ['A', 'B', 'C']) out(filler.repeat(600000));
        out('\\n{"seq":1}\\n{"seq":2}\\n');
        out('D'.repeat(1200000));
        out('\\n');
        out('{"seq":3,"final":true}\\n');
      });
    `;
    const seen = [];
    await executeStreaming(process.execPath, ['-e', script], {
      cwd: dir, env: process.env, eventLog: path.join(dir, 'events.log'),
      onLine: (line) => {
        seen.push(JSON.parse(line).seq);
      },
    });
    assert.deepEqual(seen, [0, 1, 2, 3], '超限丢弃不得吞掉换行后的有效事件与最终消息');
    const stat = fs.statSync(path.join(dir, 'events.log'));
    assert.equal(stat.mode & 0o777, 0o600, '原始事件流日志必须 0600');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('executeStreaming：onLine 异常先清杀子进程等真实退出再 reject；候选源保留', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'farm-stream-fail-'));
  const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
  try {
    // 夹具 CLI：落盘自己的 pid，发首条原生事件（候选 id 来源），2 秒后发漂移事件，
    // 然后挂住不退出——验证 TERM 清杀而不是放任残留。
    const script = `
      const fs = require('node:fs');
      const pidFile = process.argv[process.argv.length - 1];
      process.stdin.resume();
      process.stdin.on('end', () => {
        fs.writeFileSync(pidFile, String(process.pid));
        process.stdout.write('{"id":"aaaa1111-2222-3333-4444-555566667777"}\\n');
        setTimeout(() => process.stdout.write('{"id":"bbbb8888-9999-aaaa-bbbb-ccccddddeeee"}\\n'), 200);
        setInterval(() => {}, 1000);
      });
    `;
    const pidFile = path.join(dir, 'cli.pid');
    let candidate = '';
    const started = Date.now();
    await assert.rejects(
      executeStreaming(process.execPath, ['-e', script, pidFile], {
        cwd: dir, env: process.env,
        onLine: (line) => {
          const value = JSON.parse(line);
          if (!value.id) return;
          if (!candidate) { candidate = value.id; return; }
          if (value.id !== candidate) throw Object.assign(new Error('drift'), { code: 'session_failed' });
        },
      }),
      (error) => error.code === 'session_failed',
    );
    // 候选源在 reject 前已保留在调用方（重试续接依据），且 settle 时子进程已死。
    assert.equal(candidate, 'aaaa1111-2222-3333-4444-555566667777');
    const cliPid = Number(fs.readFileSync(pidFile, 'utf8'));
    assert.equal(alive(cliPid), false, 'reject 前必须已真实杀死自己启动的子进程');
    assert.ok(Date.now() - started < 8000, '清杀必须有界（8s 硬上限内 settle）');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
