const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync, spawnSync } = require('node:child_process');
const { test, after } = require('node:test');
// 隔离整个测试进程，必须先于业务模块加载；写入前核对夹具边界。
const tempRoot = path.resolve(os.tmpdir());
const dataPrefix = path.resolve(tempRoot, 'farm-team-data-');
assert.ok(dataPrefix.startsWith(tempRoot + path.sep));
const suiteDataDir = fs.mkdtempSync(dataPrefix);
const previousDataDir = process.env.FARM_DATA_DIR;
process.env.FARM_DATA_DIR = suiteDataDir;
const sourceFiles = ['../src/services/evolution-team.js', './evolution-team.test.js'].map(file => path.resolve(__dirname, file));
const sourceSnapshot = () => sourceFiles.map(file => ({
  file, mode: fs.statSync(file).mode & 0o777,
  digest: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
}));
const beforeSources = sourceSnapshot();
after(() => {
  try { assert.deepEqual(sourceSnapshot(), beforeSources, '测试成功或失败后源码内容及权限必须相同'); }
  finally {
    assert.ok(path.resolve(suiteDataDir).startsWith(tempRoot + path.sep));
    fs.rmSync(suiteDataDir, { recursive: true, force: true });
    if (previousDataDir === undefined) delete process.env.FARM_DATA_DIR;
    else process.env.FARM_DATA_DIR = previousDataDir;
  }
});
const {
  normalizeAgentSettings, validateAgentSettings, parseStageResult,
  teamJournalPath, readTeamJournal, isTeamResultApproved, runTeamWorkflow,
  createTeamError, normalizeTeamFailure, normalizeCheckpoint,
} = require('../src/services/evolution-team');
const { normalizePersistedState, normalizeActiveRun } = require('../src/services/activity-evolver');
const { requireEvolutionConfigAdmin } = require('../src/controllers/admin-activity-update-routes');

// Reuse the real JSONRPC stdio fixture while keeping the older regression
// scenarios (isolated builds/counterchecks, exact resume and native-ID absence).
function mainOwnedFixtureCli() {
  const { NATIVE_CLI } = require('./evolution-main-runner.test');
  let script = NATIVE_CLI.replace("provider=path.basename(process.argv[1]).includes('claude')?'claude':'codex'", "provider=argv.includes('exec')?'codex':'claude'");
  script = script.replace("const input=fs.readFileSync(0,'utf8');", String.raw`if(argv.includes('resume')||argv.some(arg=>arg==='--resume'||arg.startsWith('--resume='))||argv.includes('app-server'))process.exit(9);
const input=fs.readFileSync(0,'utf8');if(input==='/compact')process.exit(9);`);
  script = script.replace('const emit=value=>', String.raw`append('core/data/calls.log',(main?'main':input.includes('本次是独立外部 issue')?'external':'worker')+':'+provider+'\n');
if(provider==='codex'){
 if(fs.existsSync('core/data/giant-events'))process.stdout.write('x'.repeat(2500000)+'\n');
 if(!fs.existsSync('core/data/no-thread-events'))process.stdout.write(JSON.stringify({type:'thread.started',thread_id:'fixture-native-'+process.pid})+'\n');
 if(fs.existsSync('core/data/drift'))process.stdout.write(JSON.stringify({type:'thread.started',thread_id:'different-output-id'})+'\n');
}
const emit=value=>`);
  const begin = script.indexOf("  const plan=await tool('approve_plan'");
  const end = script.indexOf("  emit({decision:JSON.parse(accepted.content[0].text).decision,summary:'Main completed the one continuous session'});", begin)
    + "  emit({decision:JSON.parse(accepted.content[0].text).decision,summary:'Main completed the one continuous session'});".length;
  assert.ok(begin > 0 && end > begin, 'the strict MCP client has the expected Main task boundary');
  script = script.slice(0, begin) + String.raw`  const existing=JSON.parse((await tool('status')).content[0].text);
  if(!existing.allowedFiles.length){
   const plan=await tool('approve_plan',{summary:'One caller and its regression',allowedFiles:['core/src/example.js','docs/HANDOFF.md','web/src/example.js','core/test/behavior.test.js'],acceptanceChecks:['example returns expected value'],baselineChecks:fs.existsSync('core/data/countercheck-required')?[{sourceFiles:['core/src/example.js'],testFiles:['core/test/behavior.test.js'],minFailures:1}]:[]});if(plan.isError)throw Error(plan.content[0].text);
  }
  if(!existing.changedFiles.length){
   const worker=await tool('delegate_worker',{instruction:'Implement this one caller, retain partial changes on failure',allowedFiles:['core/src/example.js','docs/HANDOFF.md']});
   if(!worker.isError)throw Error('Fixture expected a worker exit failure');
   write('core/data/main-continued.json',JSON.stringify({pid:process.pid,workerFailed:true}));
   write('core/src/example.js','module.exports = 2;\n');append('docs/HANDOFF.md','Main repaired and inspected actual candidate\n');
  }
  if(fs.existsSync('core/data/touch-web'))write('web/src/example.js','export default 2;\n');
  if(fs.existsSync('core/data/countercheck-required'))write('core/test/behavior.test.js','require("node:test")("detect old behavior", () => require("node:assert/strict").equal(require("../src/example"), 2));\n');
  const external=await tool('delegate_worker',{instruction:'Read cached independent issues',readOnly:true,purpose:'external_issues'});if(external.isError)throw Error(external.content[0].text);
  const verified=await tool('verify_candidate');if(verified.isError)throw Error(verified.content[0].text);
  if(fs.existsSync('core/data/countercheck-required')){
   const proof=JSON.parse(fs.readFileSync('core/data/evolution-countercheck.json'));
   if(proof.state!=='passed'||proof.checks[0].baseline.behaviorFailures!==1||proof.checks[0].current.failed!==0)throw Error('Coordinator evidence missing');
  }
  if(fs.existsSync('core/data/reject-review'))throw Error('Synthetic Main withheld acceptance');
  const accepted=await tool('accept_result',{decision:'approve',summary:'Main verified and accepted actual behavior',lessons:[],feedbackReviewed:false,githubResolutions:[],externalReviewAcknowledged:true});if(accepted.isError)throw Error(accepted.content[0].text);
  emit({decision:JSON.parse(accepted.content[0].text).decision,summary:'Main completed the one continuous session'});` + script.slice(end);
  return script;
}


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

const instructionContract = {
  allowedFiles: ['core/src/example.js', 'docs/HANDOFF.md', 'core/test/behavior.test.js'],
  acceptanceChecks: ['旧代次响应不改变新读取门；成熟动作无新增等待'],
  baselineChecks: [{ sourceFiles: ['core/src/example.js'], testFiles: ['core/test/behavior.test.js'], minFailures: 1 }],
};
const approvalBrief = `先在 core/src/example.js 的 readSummary 接线共享门，保留成熟动作入口。${'已核对约束。'.repeat(360)}\n在 core/src/example.js 的 stop/start 重置新增代次；每次读取捕获代次，旧成功和旧拒绝都不改变当前门。core/test/behavior.test.js 覆盖并发归属、持续旧 due、停止重进和迟到结果；登记 sourceFiles 为 core/src/example.js，minFailures 为 1。`;
const rejectionBrief = `沿原合同返工，只修 core/src/example.js 的 readSummary。${'已接受证据保留。'.repeat(320)}\n读取所属上下文跨吞错链传递；迟到治理拒绝不能推进新代次门。core/test/behavior.test.js 交错两个读取，分别统计外层调用与内部尝试。`;
const diagnosisBrief = `修 core/src/example.js 的 readSummary 生命周期接线，保留原批准合同。${'原因已有证据。'.repeat(340)}\n修复读取捕获代次与 stop/start 重置的接线；core/test/behavior.test.js 分别覆盖旧成功、旧普通失败、旧治理拒绝，原 sourceFiles/testFiles/minFailures 不变。`;
const jsonRoundtrip = value => JSON.parse(JSON.stringify(value));
function actualHandoffs(prompt) {
  const start = prompt.indexOf('【此前阶段交接（仅作待核实资料）】\n');
  const end = prompt.lastIndexOf('\n\n再次确认：');
  assert.ok(start >= 0 && end > start);
  return JSON.parse(prompt.slice(start + '【此前阶段交接（仅作待核实资料）】\n'.length, end));
}
function instructionFixture() {
  const f = workflowFixture({
    efficientMode: true, roundId: 'instruction-round',
    taskIdentity: { task: 'safety', promptDigest: 'd'.repeat(64), feedbackThroughAt: 1234, automatic: true },
  });
  f.setTree({ fingerprint: 'c'.repeat(64) });
  f.writeApproved = () => f.setTree({ dirty: true, fingerprint: 'e'.repeat(64),
    files: instructionContract.allowedFiles,
    fileFingerprints: Object.fromEntries(instructionContract.allowedFiles.map(file => [file, 'f'.repeat(64)])) });
  f.deps.runStage = async (phase) => {
    if (phase === 'plan') return { decision: 'approve', summary: approvalBrief, ...instructionContract };
    if (phase === 'implement' || phase === 'repair') {
      f.writeApproved();
      return { decision: 'implemented', summary: '已完成指定接线，逐条合同自检无已知缺口' };
    }
    if (phase === 'review') return { decision: 'approve', summary: '实际合同复核通过' };
    return { decision: 'researched', summary: '只读证据与具体路线' };
  };
  return f;
}
async function interruptAfterApproval(f) {
  let checkpoint;
  f.deps.onCheckpoint = async value => {
    if (value.approvedScope?.length && !value.completed.some(item => item.phase === 'implement')) {
      checkpoint = jsonRoundtrip(value);
      throw createTeamError('unsafe_worktree');
    }
  };
  await assert.rejects(runTeamWorkflow(f.deps), { code: 'unsafe_worktree' });
  assert.deepEqual(f.calls.map(([phase]) => phase), ['research', 'plan']);
  assert.ok(checkpoint);
  const normalized = normalizeCheckpoint(checkpoint);
  assert.ok(normalized, '凭据来自实际批准及协调持久化，不手造批准');
  assert.deepEqual(normalized.approvedScope, [...instructionContract.allowedFiles].sort());
  assert.deepEqual(normalized.acceptanceChecks, instructionContract.acceptanceChecks);
  assert.deepEqual(normalized.baselineChecks, instructionContract.baselineChecks);
  return normalized;
}
function assertResumedContract(handoffs) {
  const approval = handoffs.find(item => item.phase === 'plan' && item.decision === 'approve');
  assert.equal(approval.summary, approvalBrief);
  const resumed = handoffs.find(item => item.phase === 'resume');
  assert.deepEqual(resumed.allowedFiles, [...instructionContract.allowedFiles].sort());
  assert.deepEqual(resumed.acceptanceChecks, instructionContract.acceptanceChecks);
  assert.deepEqual(resumed.baselineChecks, instructionContract.baselineChecks);
}

test('真实批准中断→checkpoint roundtrip→实施及返工收到两千字后的完整接线和原合同', async () => {
  assert.ok(approvalBrief.indexOf('stop/start') > 2000);
  assert.ok(rejectionBrief.indexOf('读取所属上下文') > 2000);
  const f = instructionFixture();
  const checkpoint = await interruptAfterApproval(f);
  assert.equal(checkpoint.completed.find(item => item.phase === 'plan').summary, approvalBrief);
  assert.deepEqual(normalizeCheckpoint(jsonRoundtrip(checkpoint)), checkpoint);
  const stage = f.deps.runStage;
  const records = [];
  let reviews = 0;
  f.deps.onCheckpoint = async value => records.push(jsonRoundtrip(value));
  f.deps.runStage = async (phase, agent, prompt) => {
    if (phase === 'implement' || phase === 'repair') assertResumedContract(actualHandoffs(prompt));
    if (phase === 'repair') {
      const handoffs = actualHandoffs(prompt);
      assert.equal(handoffs.find(item => item.phase === 'review' && item.decision === 'reject').summary, rejectionBrief);
      assert.equal(handoffs.findLast(item => item.phase === 'diagnose').summary, rejectionBrief);
    }
    if (phase === 'review' && ++reviews === 1) return { decision: 'reject', summary: rejectionBrief };
    return stage(phase, agent, prompt);
  };
  f.deps.verify = async contract => assert.deepEqual(contract.baselineChecks, instructionContract.baselineChecks);
  const result = await runTeamWorkflow({ ...f.deps, resume: jsonRoundtrip(checkpoint) });
  assert.equal(result.decision, 'approve');
  assert.equal(result.reviewRecoveryAttempt, 1);
  assert.equal(result.runtimeRecoveryAttempt, 0);
  assert.equal(result.planRevision, 0);
  assert.equal(result.reviewFeedback, '', '真实最终验收批准取代先前拒绝意见');
  const rejected = records.find(value => value.completed.some(item => item.phase === 'review' && item.decision === 'reject'));
  assert.equal(normalizeCheckpoint(rejected).completed.find(item => item.phase === 'review').summary, rejectionBrief);
  assert.equal(normalizeCheckpoint(rejected).reviewFeedback, rejectionBrief, '真实未决最终拒绝不能因 plan 已批准而清除');
  assert.equal(records.at(-1).reviewFeedback, '');
  assert.equal(f.calls.filter(([phase]) => phase === 'git-commit').length, 1);
});

test('真实诊断和修复中断后，续接 repair 保留详细接线、批准合同及同轮剩余预算', async () => {
  assert.ok(diagnosisBrief.indexOf('修复读取捕获代次') > 2000);
  const f = instructionFixture();
  const approved = await interruptAfterApproval(f);
  let repaired;
  let interrupted = false;
  const stage = f.deps.runStage;
  f.deps.runStage = async (phase, agent, prompt) => phase === 'diagnose'
    ? { decision: 'repair', summary: diagnosisBrief, allowedFiles: instructionContract.allowedFiles }
    : stage(phase, agent, prompt);
  f.deps.onCheckpoint = async value => {
    if (!interrupted && value.completed.some(item => item.phase === 'repair')) {
      interrupted = true;
      repaired = jsonRoundtrip(value);
      throw createTeamError('unsafe_worktree');
    }
  };
  const initialFailure = normalizeTeamFailure(createTeamError('cli_exit'), 'implement', 'claude');
  await assert.rejects(runTeamWorkflow({ ...f.deps, resume: approved, initialFailure }), { code: 'unsafe_worktree' });
  const checkpoint = normalizeCheckpoint(jsonRoundtrip(repaired));
  assert.ok(checkpoint);
  assert.equal(checkpoint.completed.find(item => item.phase === 'diagnose').summary, diagnosisBrief);
  assert.equal(checkpoint.counters.runtimeRecoveryAttempt, 1);
  f.deps.onCheckpoint = async () => {};
  let repairRan = false;
  f.deps.runStage = async (phase, agent, prompt) => {
    const handoffs = actualHandoffs(prompt);
    if (phase === 'diagnose' || phase === 'repair') {
      assertResumedContract(handoffs);
      assert.equal(handoffs.find(item => item.phase === 'diagnose').summary, diagnosisBrief);
    }
    if (phase === 'diagnose') return { decision: 'repair', summary: '按已注入的详细诊断指令处理同一接线，范围不变', allowedFiles: instructionContract.allowedFiles };
    if (phase === 'repair') repairRan = true;
    return stage(phase, agent, prompt);
  };
  f.deps.verify = async contract => assert.deepEqual(contract.baselineChecks, instructionContract.baselineChecks);
  const result = await runTeamWorkflow({ ...f.deps, resume: checkpoint, initialFailure });
  assert.equal(result.decision, 'approve');
  assert.equal(repairRan, true);
  assert.equal(result.runtimeRecoveryAttempt, 2, '同轮续接继续计数，不能刷新预算');
  assert.equal(result.reviewRecoveryAttempt, 0);
});

test('拒绝的具体路线仅进入只读 revise_plan，未经后来批准不能实施或获得文件权限', async () => {
  for (const writesDuringRevision of [false, true]) {
    const f = instructionFixture();
    const records = [];
    const stage = f.deps.runStage;
    let plans = 0;
    f.deps.onCheckpoint = async value => records.push(jsonRoundtrip(value));
    const rejectedSummary = `${rejectionBrief}\n仅作只读修订方向：core/src/unapproved.js 需进一步核对，本次不授权。`;
    f.deps.runStage = async (phase, agent, prompt) => {
      if (phase === 'plan' && ++plans === 1) return { decision: 'reject', summary: rejectedSummary, allowedFiles: [], acceptanceChecks: [], baselineChecks: [] };
      if (phase === 'revise_plan') {
        assert.equal(f.calls.some(([name]) => name === 'implement'), false);
        assert.equal(actualHandoffs(prompt).find(item => item.phase === 'plan').summary, rejectedSummary);
        const checkpoint = normalizeCheckpoint(records.at(-1));
        assert.ok(checkpoint);
        assert.equal(checkpoint.completed.find(item => item.phase === 'plan').summary, rejectedSummary);
        assert.deepEqual(checkpoint.allowedFiles, []);
        assert.deepEqual(checkpoint.approvedScope, []);
        if (writesDuringRevision) f.writeApproved();
        return { decision: 'researched', summary: '仅修订指定路线及测试登记' };
      }
      return stage(phase, agent, prompt);
    };
    if (writesDuringRevision) {
      await assert.rejects(runTeamWorkflow(f.deps), { code: 'readonly_changed' });
      assert.equal(f.calls.some(([name]) => name === 'implement' || name === 'git-commit'), false);
    } else {
      const result = await runTeamWorkflow(f.deps);
      assert.equal(result.decision, 'approve');
      assert.equal(result.planRevision, 1);
      assert.deepEqual(f.calls.slice(0, 5).map(([name]) => name), ['research', 'plan', 'revise_plan', 'plan', 'implement']);
      assert.equal(records.some(value => value.allowedFiles.includes('core/src/unapproved.js')), false);
    }
  }
});

test('方案拒绝→真实批准→CLI 失败不再报告旧拒绝；旧 checkpoint 续接保留授权及恢复预算', async () => {
  const f = instructionFixture();
  const stage = f.deps.runStage;
  const planRefusal = '暂不批准；只读修订 core/src/example.js 的读取归属接线';
  const records = [];
  const progress = [];
  const originalProgress = f.deps.onProgress;
  let plans = 0;
  f.deps.onCheckpoint = async value => records.push(jsonRoundtrip(value));
  f.deps.onProgress = async (phase, agent, details) => {
    progress.push({ phase, ...details });
    await originalProgress(phase, agent, details);
  };
  f.deps.runStage = async (phase, agent, prompt) => {
    if (phase === 'plan' && ++plans === 1) return {
      decision: 'reject', summary: planRefusal, allowedFiles: [], acceptanceChecks: [], baselineChecks: [],
    };
    if (phase === 'implement' || phase === 'repair') {
      assert.ok(actualHandoffs(prompt).some(item => item.phase === 'plan' && item.decision === 'reject'
        && item.summary === planRefusal), '原拒绝仍是历史证据，不作为当前阻断意见');
      throw createTeamError('cli_exit', { exitCode: 1 });
    }
    if (phase === 'diagnose') return { decision: 'repair', summary: diagnosisBrief, allowedFiles: instructionContract.allowedFiles };
    return stage(phase, agent, prompt);
  };
  let failure;
  await assert.rejects(runTeamWorkflow(f.deps), error => {
    failure = error;
    return error.code === 'recovery_exhausted' && error.failure.code === 'cli_exit';
  });
  assert.equal(failure.recoveryInfo.reviewFeedback, '');
  assert.equal(failure.recoveryInfo.runtimeRecoveryAttempt, 2);
  assert.equal(failure.recoveryInfo.reviewRecoveryAttempt, 0);
  assert.equal(failure.recoveryInfo.planRevision, 1);
  assert.ok(progress.filter(item => ['implement', 'diagnose', 'repair'].includes(item.phase))
    .every(item => item.reviewFeedback === ''));
  const checkpoint = records.at(-1);
  assert.equal(checkpoint.reviewFeedback, '');
  assert.equal(checkpoint.completed.find(item => item.phase === 'plan').decision, 'approve');
  assert.deepEqual(checkpoint.approvedScope, [...instructionContract.allowedFiles].sort());
  assert.deepEqual(checkpoint.acceptanceChecks, instructionContract.acceptanceChecks);
  assert.deepEqual(checkpoint.baselineChecks, instructionContract.baselineChecks);
  assert.equal(f.calls.some(([phase]) => phase === 'review' || phase === 'git-commit'), false);

  // 仅模拟旧版留下的冗余意见，所有授权/身份/预算均沿用实际协调记录。
  const legacy = { ...jsonRoundtrip(checkpoint), reviewFeedback: planRefusal };
  const normalized = normalizeCheckpoint(legacy);
  assert.ok(normalized);
  assert.equal(normalized.reviewFeedback, '');
  assert.deepEqual(normalized.counters, checkpoint.counters);
  assert.deepEqual(normalized.approvedScope, checkpoint.approvedScope);
  f.deps.runStage = async (phase, agent, prompt) => {
    if (phase === 'implement') assertResumedContract(actualHandoffs(prompt));
    return stage(phase, agent, prompt);
  };
  f.deps.verify = async contract => assert.deepEqual(contract.baselineChecks, instructionContract.baselineChecks);
  const resumed = await runTeamWorkflow({ ...f.deps, resume: legacy, initialReviewFeedback: planRefusal });
  assert.equal(resumed.decision, 'approve');
  assert.equal(resumed.reviewFeedback, '');
  assert.equal(resumed.runtimeRecoveryAttempt, 2, '真实同轮预算不能因失效展示意见而重置');
  assert.equal(resumed.reviewRecoveryAttempt, 0);
  assert.equal(resumed.planRevision, 1);
  assert.equal(records.at(-1).reviewFeedback, '');
});

test('方案拒绝后真实 no_change 清除当前拒绝意见，不增加实施或提交', async () => {
  const f = instructionFixture();
  const stage = f.deps.runStage;
  const records = [];
  let plans = 0;
  f.deps.onCheckpoint = async value => records.push(jsonRoundtrip(value));
  f.deps.runStage = async (phase, agent, prompt) => {
    if (phase === 'plan') return plans++ === 0
      ? { decision: 'reject', summary: '尚缺只读行为证据', allowedFiles: [], acceptanceChecks: [], baselineChecks: [] }
      : { decision: 'no_change', summary: '指定证据核实无需改动', allowedFiles: [], acceptanceChecks: [], baselineChecks: [] };
    return stage(phase, agent, prompt);
  };
  const result = await runTeamWorkflow(f.deps);
  assert.equal(result.decision, 'no_change');
  assert.equal(result.reviewFeedback, '');
  assert.equal(result.planRevision, 1);
  assert.equal(result.runtimeRecoveryAttempt, 0);
  assert.equal(records.at(-1).reviewFeedback, '');
  assert.equal(normalizeCheckpoint(records.at(-1)).reviewFeedback, '');
  assert.equal(f.calls.some(([phase]) => phase === 'implement' || phase === 'git-commit'), false);
});

test('真实 journal 读取以当前有效批准凭据清理旧方案意见，保留未决或当前外层复核拒绝', async () => {
  const f = instructionFixture();
  const approved = await interruptAfterApproval(f);
  const active = normalizeActiveRun({
    runId: 'legacy-feedback', baseCommit: approved.baselineHead,
    agent: 'codex', subAgent: 'claude', dualAgentEnabled: true,
  });
  const journalDir = path.resolve(suiteDataDir, 'legacy-journal');
  assert.ok(journalDir.startsWith(path.resolve(suiteDataDir) + path.sep));
  const journalFile = path.resolve(teamJournalPath(journalDir, active.runId));
  assert.ok(journalFile.startsWith(journalDir + path.sep));
  fs.mkdirSync(journalDir, { recursive: true });
  const oldRefusal = '暂不批准，先修订旧方案';
  const currentRefusal = '最终验收未通过，当前读取失败分支没有行为证据';
  const journal = {
    runId: active.runId, baseCommit: active.baseCommit, mainAgent: 'codex', subAgent: 'claude',
    phase: 'failed', status: 'failed', activeAgent: '', head: active.baseCommit,
    failure: normalizeTeamFailure(createTeamError('cli_exit'), 'implement', 'claude'),
    reviewFeedback: oldRefusal, checkpoint: { ...approved, reviewFeedback: oldRefusal },
  };
  const read = fields => {
    assert.ok(path.resolve(journalFile).startsWith(journalDir + path.sep));
    fs.writeFileSync(journalFile, JSON.stringify({ ...journal, ...fields }), { mode: 0o600 });
    const result = readTeamJournal(journalDir, active);
    assert.ok(result);
    assert.equal(isTeamResultApproved(result, active.baseCommit), false, '清理展示意见不代表任务验收成功');
    return result;
  };
  try {
    const legacy = read({});
    assert.equal(legacy.reviewFeedback, '');
    assert.equal(legacy.checkpoint.reviewFeedback, '');
    assert.equal(legacy.failure.code, 'cli_exit');
    assert.deepEqual(legacy.checkpoint.approvedScope, approved.approvedScope);
    assert.deepEqual(legacy.checkpoint.counters, approved.counters);
    for (const checkpoint of [null, { version: 1 }, { ...approved, baselineHead: 'b'.repeat(40) }]) {
      assert.equal(read({ checkpoint }).reviewFeedback, oldRefusal, '无效/缺失/不属于当前基线的凭据不能推定批准');
    }
    assert.equal(read({
      failure: normalizeTeamFailure(createTeamError('review_rejected'), 'review', 'codex'),
      reviewFeedback: currentRefusal,
    }).reviewFeedback, currentRefusal, '外层真实最新复核拒绝不能被较早的批准凭据吞掉');

    const stage = f.deps.runStage;
    const records = [];
    f.deps.onCheckpoint = async value => records.push(jsonRoundtrip(value));
    f.deps.runStage = async (phase, agent, prompt) => {
      if (phase === 'review') return { decision: 'reject', summary: currentRefusal };
      if (phase === 'repair') throw createTeamError('cli_exit');
      if (phase === 'diagnose') return { decision: 'repair', summary: diagnosisBrief, allowedFiles: instructionContract.allowedFiles };
      return stage(phase, agent, prompt);
    };
    let failure;
    await assert.rejects(runTeamWorkflow({ ...f.deps, resume: approved }), error => {
      failure = error;
      return error.code === 'recovery_exhausted';
    });
    const rejected = read({ checkpoint: records.at(-1), failure: failure.failure, reviewFeedback: currentRefusal });
    assert.equal(rejected.reviewFeedback, currentRefusal);
    assert.equal(rejected.checkpoint.reviewFeedback, currentRefusal);
    assert.equal(rejected.checkpoint.completed.find(item => item.phase === 'review').decision, 'reject');
    assert.equal(rejected.failure.code, 'cli_exit', '后续执行失败不掩盖仍未解决的真实复核拒绝');
  } finally {
    assert.ok(path.resolve(journalDir).startsWith(path.resolve(suiteDataDir) + path.sep));
    fs.rmSync(journalDir, { recursive: true, force: true });
  }
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

test('隔离 Git 仓库跑真实协调进程：单 Main 工具回执、独立验证、验收后提交与拒绝收口', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'farm-team-runner-'));
  const write = (file, text) => {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), text);
  };
  const git = args => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  try {
    write('core/scripts/run-evolution-team.js', fs.readFileSync(path.join(__dirname, '../scripts/run-evolution-team.js')));
    write('core/scripts/run-evolution-main-mcp.js', fs.readFileSync(path.join(__dirname, '../scripts/run-evolution-main-mcp.js')));
    write('core/scripts/evolution-apply-process.js', `module.exports = require(${JSON.stringify(require.resolve('../scripts/evolution-apply-process'))});`);
    for (const name of ['evolution-main-workflow', 'evolution-main-mcp']) {
      write(`core/src/services/${name}.js`, `module.exports = require(${JSON.stringify(require.resolve(`../src/services/${name}`))});`);
    }
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
    const fakeCli = mainOwnedFixtureCli();
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
    assert.equal(fs.readFileSync(path.join(dir, 'core/data/calls.log'), 'utf8'), 'main:codex\nworker:claude\nexternal:claude\n');
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
    assert.equal(journal.lastFailure.code, 'cli_exit');
    assert.equal(isTeamResultApproved(journal, recoveredHead), true);
    assert.equal(fs.readFileSync(path.join(dir, 'core/data/calls.log'), 'utf8'), 'main:codex\nworker:claude\nexternal:claude\n');
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
    // 角色反选：持续 Main 走 claude（内联 schema），工具走 codex（schema 文件）；
    // 保留设置选择与真实 MCP 回执链，绝不写死 provider。
    const swapped = run('swapped', { mainAgent: 'claude', subAgent: 'codex' });
    assert.equal(swapped.status, 0, swapped.stderr);
    const swappedHead = git(['rev-parse', 'HEAD']);
    assert.notEqual(swappedHead, baseCommit);
    assert.equal(git(['status', '--porcelain']), '');
    assert.equal(fs.readFileSync(path.join(dir, 'core/data/calls.log'), 'utf8'), 'main:claude\nworker:codex\nexternal:codex\n');
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
  const fakeCli = mainOwnedFixtureCli();
  try {
    write('core/scripts/run-evolution-team.js', fs.readFileSync(path.join(__dirname, '../scripts/run-evolution-team.js')));
    write('core/scripts/run-evolution-main-mcp.js', fs.readFileSync(path.join(__dirname, '../scripts/run-evolution-main-mcp.js')));
    write('core/scripts/evolution-apply-process.js', `module.exports = require(${JSON.stringify(require.resolve('../scripts/evolution-apply-process'))});`);
    for (const name of ['evolution-main-workflow', 'evolution-main-mcp']) {
      write(`core/src/services/${name}.js`, `module.exports = require(${JSON.stringify(require.resolve(`../src/services/${name}`))});`);
    }
    for (const name of ['activity-evolver', 'privacy-guard', 'evolution-team', 'evolution-sessions', 'evolution-worktree']) {
      write(`core/src/services/${name}.js`, `module.exports = require(${JSON.stringify(require.resolve(`../src/services/${name}`))});\n`);
    }
    // 验证/反证只关心续接合同，不重复覆盖真实验证链路（上文真实 fixture 已覆盖）。
    write('core/src/services/evolution-validation.js', `module.exports.runEvolutionValidation = async ({repoRoot}) => ({ state: 'passed', fingerprint: require(${JSON.stringify(require.resolve('../src/services/evolution-validation'))}).logicSnapshot(repoRoot).fingerprint, checks: ['backend','frontend'], checkedAt: Date.now() });\n`);
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
    // run1：Main 未封存候选即退出，留下真实 in_run checkpoint（含脏树逐文件快照）。
    write('core/data/reject-review', '1');
    write('core/data/calls.log', '');
    const exhausted = run('reject1');
    assert.equal(exhausted.status, 1, exhausted.stderr);
    assert.equal(git(['rev-parse', 'HEAD']), baseCommit, 'run1 不得提交');
    const journal1 = JSON.parse(fs.readFileSync(path.join(dir, 'core/data/logs/evolve-team-reject1.json'), 'utf8'));
    assert.equal(journal1.failure.code, 'cli_exit', 'Main 未封存结果即退出，真实保留失败而不重开独立复核会话');
    const checkpoint = journal1.checkpoint;
    assert.ok(checkpoint && checkpoint.kind === 'in_run', 'run1 必须留下真实续接凭据');
    assert.deepEqual(Object.keys(checkpoint.fileFingerprints).sort(), ['core/src/example.js', 'docs/HANDOFF.md']);
    assert.ok(/^[0-9a-f]{64}$/.test(checkpoint.worktreeFingerprint));
    // run2：同树合法续接——新 Main 继承原合同，重新验证后封存，不重复委派实施。
    fs.unlinkSync(path.join(dir, 'core/data/reject-review'));
    write('core/data/calls.log', '');
    const resumed = run('resume-ok', { resume: checkpoint });
    assert.equal(resumed.status, 0, resumed.stderr);
    const resumedHead = git(['rev-parse', 'HEAD']);
    assert.notEqual(resumedHead, baseCommit);
    assert.equal(git(['status', '--porcelain']), '');
    assert.equal(calls(), 'main:codex\nexternal:claude\n', '续接Main重新核对独立issue证据，不重新委派实施');
    const journal2 = readTeamJournal(path.join(dir, 'core/data/logs'), { runId: 'resume-ok', baseCommit, agent: 'codex', subAgent: 'claude', dualAgentEnabled: true });
    assert.equal(isTeamResultApproved(journal2, resumedHead), true);
    // 之后的拒绝用例都从基线重建 run1 留下的那棵脏树（内容/权限逐字节一致）。
    const dirty = () => {
      git(['reset', '--hard', baseCommit]);
      git(['clean', '-fdq']);
      write('core/src/example.js', 'module.exports = 2;\n');
      write('docs/HANDOFF.md', 'Fixture constraints\nWorker partial\nMain repaired and inspected actual candidate\n');
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
// 实施中途崩溃的空范围只读修复（2026-10-15 journal：implement/cli_exit 后诊断返回
// 空范围）。旧实现在 recover 里无条件 approvedScope=allowedFiles，把原批准范围清成空：
// 重试实施必然 repair_scope，半成品树还会被提前 verifyCurrent 当验证失败处理。修复后
// 五条件同时成立才保留原范围并直接返回（跳过提前验证），完成后的真实验证不减免。
const emptyDiagnosis = { decision: 'repair', summary: '空范围只读核对后按原批准范围继续实施', allowedFiles: [] };
const cliExit = (phase = 'implement') => normalizeTeamFailure(createTeamError('cli_exit', { exitCode: 1 }), phase, 'claude');

test('实施中途 CLI 崩溃→空范围只读修复保留原批准范围→重新实施后完整验证', async () => {
  for (const halfDone of [false, true]) {
    const f = instructionFixture();
    const stage = f.deps.runStage;
    const records = [];
    let attempts = 0;
    const verifyContracts = [];
    f.deps.onCheckpoint = async value => records.push(jsonRoundtrip(value));
    f.deps.runStage = async (phase, agent, prompt) => {
      if (phase === 'diagnose') return { ...emptyDiagnosis };
      if (phase === 'implement') {
        attempts += 1;
        assert.equal(actualHandoffs(prompt).find(item => item.phase === 'plan' && item.decision === 'approve').summary, approvalBrief);
        if (attempts === 1) {
          if (halfDone) f.setTree({ dirty: true, fingerprint: 'half',
            files: [instructionContract.allowedFiles[0]],
            fileFingerprints: { [instructionContract.allowedFiles[0]]: 'a'.repeat(64) } });
          throw createTeamError('cli_exit', { exitCode: 1 });
        }
      }
      if (phase === 'repair') return { decision: 'no_change', summary: '只读核对完成，原实施授权继续有效' };
      return stage(phase, agent, prompt);
    };
    f.deps.verify = async contract => verifyContracts.push(jsonRoundtrip(contract));
    const result = await runTeamWorkflow(f.deps);
    assert.equal(result.decision, 'approve');
    assert.equal(result.runtimeRecoveryAttempt, 1);
    assert.equal(result.reviewRecoveryAttempt, 0);
    assert.deepEqual(f.calls.map(([phase]) => phase), ['research', 'plan', 'implement', 'diagnose', 'repair',
      'implement', 'verify', 'review', 'commit', 'git-commit']);
    const implementIndexes = f.calls.map(([phase], index) => [phase, index]).filter(([phase]) => phase === 'implement');
    assert.equal(implementIndexes.length, 2);
    assert.ok(f.calls.slice(implementIndexes[0][1] + 1, implementIndexes[1][1])
      .every(([phase]) => !['verify', 'tests', 'review', 'commit'].includes(phase)), '实施完成前不得对干净树或半成品提前验证');
    assert.deepEqual(verifyContracts.map(contract => contract.baselineChecks), [instructionContract.baselineChecks],
      '最终验证收到原反证合同');
    const afterRepair = normalizeCheckpoint(records.find(value => value.completed.some(item => item.phase === 'repair')));
    assert.ok(afterRepair);
    assert.deepEqual(afterRepair.approvedScope, [...instructionContract.allowedFiles].sort(), '空范围只读诊断不得清掉原批准范围');
    assert.deepEqual(afterRepair.baselineChecks, instructionContract.baselineChecks);
    assert.deepEqual(afterRepair.acceptanceChecks, instructionContract.acceptanceChecks);
    assert.equal(afterRepair.completed.some(item => item.phase === 'implement'), false, '未登记 implement 完成');
    assert.equal(afterRepair.counters.runtimeRecoveryAttempt, 1);
  }
});

test('只读修复收口后的检查点可同轮续接：原范围、合同、反证与剩余预算完整保留', async () => {
  const f = instructionFixture();
  const stage = f.deps.runStage;
  let captured;
  let interrupted = false;
  let attempts = 0;
  f.deps.onCheckpoint = async value => {
    if (!interrupted && value.completed.some(item => item.phase === 'repair')) {
      interrupted = true;
      captured = jsonRoundtrip(value);
      throw createTeamError('unsafe_worktree');
    }
  };
  f.deps.runStage = async (phase, agent, prompt) => {
    if (phase === 'diagnose') return { ...emptyDiagnosis };
    if (phase === 'implement' && ++attempts === 1) throw createTeamError('cli_exit', { exitCode: 1 });
    if (phase === 'repair') return { decision: 'no_change', summary: '只读核对完成' };
    return stage(phase, agent, prompt);
  };
  await assert.rejects(runTeamWorkflow(f.deps), { code: 'unsafe_worktree' });
  const checkpoint = normalizeCheckpoint(captured);
  assert.ok(checkpoint);
  assert.deepEqual(checkpoint.approvedScope, [...instructionContract.allowedFiles].sort());
  assert.deepEqual(checkpoint.acceptanceChecks, instructionContract.acceptanceChecks);
  assert.deepEqual(checkpoint.baselineChecks, instructionContract.baselineChecks);
  assert.equal(checkpoint.counters.runtimeRecoveryAttempt, 1);
  assert.equal(checkpoint.completed.some(item => item.phase === 'implement'), false);
  const verifyContracts = [];
  const callsBeforeResume = f.calls.length;
  f.deps.onCheckpoint = async () => {};
  f.deps.verify = async contract => verifyContracts.push(jsonRoundtrip(contract));
  f.deps.runStage = async (phase, agent, prompt) => {
    if (phase === 'diagnose') return { ...emptyDiagnosis };
    if (phase === 'implement' || phase === 'repair') assertResumedContract(actualHandoffs(prompt));
    if (phase === 'repair') return { decision: 'no_change', summary: '只读核对完成' };
    return stage(phase, agent, prompt);
  };
  const result = await runTeamWorkflow({ ...f.deps, resume: jsonRoundtrip(checkpoint), initialFailure: cliExit() });
  assert.equal(result.decision, 'approve');
  assert.equal(result.runtimeRecoveryAttempt, 2, '同轮续接真实消耗剩余恢复次数');
  assert.deepEqual(verifyContracts.map(contract => contract.baselineChecks), [instructionContract.baselineChecks]);
  assert.equal(f.calls.filter(([phase]) => phase === 'research').length, 1, '不重复 research');
  assert.equal(f.calls.filter(([phase]) => phase === 'plan').length, 1, '不重复 plan');
  assert.deepEqual(f.calls.slice(callsBeforeResume).map(([phase]) => phase),
    ['diagnose', 'repair', 'implement', 'verify', 'review', 'commit', 'git-commit']);
});

test('空范围 repair 自身再次崩溃后成功：原范围保留、恢复次数真实消耗且有界', async () => {
  const f = instructionFixture();
  const stage = f.deps.runStage;
  const records = [];
  let repairs = 0;
  let attempts = 0;
  f.deps.onCheckpoint = async value => records.push(jsonRoundtrip(value));
  f.deps.runStage = async (phase, agent, prompt) => {
    if (phase === 'diagnose') return { ...emptyDiagnosis };
    if (phase === 'implement' && ++attempts === 1) throw createTeamError('cli_exit', { exitCode: 1 });
    if (phase === 'repair' && ++repairs === 1) throw createTeamError('cli_exit', { exitCode: 1 });
    if (phase === 'repair') return { decision: 'no_change', summary: '只读核对完成' };
    return stage(phase, agent, prompt);
  };
  const result = await runTeamWorkflow(f.deps);
  assert.equal(result.decision, 'approve');
  assert.equal(result.runtimeRecoveryAttempt, 2, '两次恢复真实计数');
  assert.deepEqual(normalizeCheckpoint(records.at(-1)).approvedScope, [...instructionContract.allowedFiles].sort());

  const bounded = instructionFixture();
  const boundedStage = bounded.deps.runStage;
  bounded.deps.runStage = async (phase, agent, prompt) => {
    if (phase === 'diagnose') return { ...emptyDiagnosis };
    if (phase === 'implement' || phase === 'repair') throw createTeamError('cli_exit', { exitCode: 1 });
    return boundedStage(phase, agent, prompt);
  };
  await assert.rejects(runTeamWorkflow(bounded.deps), error => error.code === 'recovery_exhausted' && error.failure.code === 'cli_exit');
  assert.ok(bounded.calls.every(([phase]) => !['verify', 'review', 'commit'].includes(phase)));
});

test('越权路径继续拒绝：空范围 repair 写文件、实施越权写、HEAD 变化均不得验证或提交', async () => {
  for (const variant of ['readonly-write', 'implement-out-of-scope', 'head-changed']) {
    const f = instructionFixture();
    const stage = f.deps.runStage;
    f.deps.runStage = async (phase, agent, prompt) => {
      if (phase === 'diagnose') return { ...emptyDiagnosis };
      if (phase === 'implement' && variant !== 'readonly-write') {
        if (variant === 'implement-out-of-scope') f.setTree({ dirty: true, fingerprint: 'out-of-scope',
          files: ['core/src/unapproved.js'], fileFingerprints: { 'core/src/unapproved.js': 'x'.repeat(64) } });
        if (variant === 'head-changed') f.setTree({ head: 'c'.repeat(40) });
        if (variant === 'implement-out-of-scope') return { decision: 'implemented', summary: '越权写入' };
        throw createTeamError('cli_exit', { exitCode: 1 });
      }
      if (phase === 'implement') throw createTeamError('cli_exit', { exitCode: 1 });
      if (phase === 'repair' && variant === 'readonly-write') {
        f.writeApproved();
        return { decision: 'no_change', summary: '声称只读' };
      }
      if (phase === 'repair') return { decision: 'no_change', summary: '只读核对完成' };
      return stage(phase, agent, prompt);
    };
    await assert.rejects(runTeamWorkflow(f.deps), { code: variant === 'head-changed' ? 'head_changed' : 'repair_scope' });
    assert.ok(f.calls.every(([phase]) => !['verify', 'review', 'commit'].includes(phase)), `${variant} 不得进入验证或提交`);
  }
});

test('没有批准方案或失败不属于实施阶段时不保留范围：原验证恢复路径保持', async () => {
  // ① 初始失败来自 implement 但没有任何 plan 批准凭据（独立维护入口形状）。
  {
    const files = {};
    const calls = [];
    const records = [];
    const deps = {
      settings: { mainAgent: 'codex', subAgent: 'claude', dualAgentEnabled: true },
      prompt: 'fixture task', efficientMode: true, roundId: 'no-plan-round',
      taskIdentity: { task: 'safety', promptDigest: 'e'.repeat(64), feedbackThroughAt: 1, automatic: true },
      initialFailure: cliExit(),
      inspect: async () => ({ head: 'a'.repeat(40), dirty: Object.keys(files).length > 0,
        fingerprint: JSON.stringify(files), files: Object.keys(files), fileFingerprints: { ...files } }),
      onProgress: async (phase, agent) => calls.push([phase, agent]),
      onCheckpoint: async value => records.push(jsonRoundtrip(value)),
      runStage: async (phase) => {
        if (phase === 'diagnose') return { ...emptyDiagnosis };
        if (phase === 'repair') return { decision: 'no_change', summary: '只读核对' };
        if (phase === 'plan') return { decision: 'approve', summary: 'approved scope',
          allowedFiles: ['core/src/example.js'], acceptanceChecks: ['example behavior'] };
        if (phase === 'implement') { files['core/src/example.js'] = 'implemented'; return { decision: 'implemented', summary: 'done' }; }
        if (phase === 'review') return { decision: 'approve', summary: 'final review' };
        return { decision: 'researched', summary: 'researched' };
      },
      verify: async () => calls.push(['tests']),
      commit: async () => 'b'.repeat(40),
    };
    const result = await runTeamWorkflow(deps);
    assert.equal(result.decision, 'approve');
    assert.deepEqual(calls.map(call => call[0]), ['diagnose', 'repair', 'research', 'plan', 'implement', 'verify', 'tests', 'review', 'commit']);
    const afterRepair = normalizeCheckpoint(records.find(value => value.completed.some(item => item.phase === 'repair')));
    assert.ok(afterRepair);
    assert.deepEqual(afterRepair.approvedScope, [], '没有批准方案时空范围诊断不产生任何保留范围');
  }
  // ② 实施已完成后的验证类失败：不进入延期分支，验证真实重跑。
  {
    const f = instructionFixture();
    const stage = f.deps.runStage;
    const records = [];
    let verifyCalls = 0;
    f.deps.onCheckpoint = async value => records.push(jsonRoundtrip(value));
    f.deps.verify = async contract => {
      verifyCalls += 1;
      assert.deepEqual(contract.baselineChecks, instructionContract.baselineChecks);
      if (verifyCalls === 1) throw createTeamError('cli_exit', { exitCode: 1 });
    };
    f.deps.runStage = async (phase, agent, prompt) => {
      if (phase === 'diagnose') return { ...emptyDiagnosis };
      if (phase === 'repair') return { decision: 'no_change', summary: '只读核对完成' };
      return stage(phase, agent, prompt);
    };
    const result = await runTeamWorkflow(f.deps);
    assert.equal(result.decision, 'approve');
    assert.equal(verifyCalls, 2, '验证失败后必须重新真实验证，不能被延期分支跳过');
    const afterRepair = normalizeCheckpoint(records.find(value => value.completed.some(item => item.phase === 'repair')));
    assert.ok(afterRepair);
    assert.deepEqual(afterRepair.approvedScope, [], '验证阶段失败维持原范围更新行为');
  }
});

test('实施续接后的最终验证失败与最终复核拒绝不被空范围修复跳过', async () => {
  const f = instructionFixture();
  const stage = f.deps.runStage;
  let attempts = 0;
  let repairs = 0;
  let verifyCalls = 0;
  let reviews = 0;
  const repairHandoffs = [];
  f.deps.verify = async contract => {
    verifyCalls += 1;
    assert.deepEqual(contract.baselineChecks, instructionContract.baselineChecks);
    if (verifyCalls === 1) throw createTeamError('verification_failed');
  };
  f.deps.runStage = async (phase, agent, prompt) => {
    if (phase === 'diagnose') return { ...emptyDiagnosis };
    if (phase === 'implement' && ++attempts === 1) throw createTeamError('cli_exit', { exitCode: 1 });
    if (phase === 'repair') {
      repairHandoffs.push(actualHandoffs(prompt));
      if (++repairs === 1) return { decision: 'no_change', summary: '只读核对完成' };
    }
    if (phase === 'review' && ++reviews === 1) return { decision: 'reject', summary: rejectionBrief };
    return stage(phase, agent, prompt);
  };
  const result = await runTeamWorkflow(f.deps);
  assert.equal(result.decision, 'approve');
  assert.equal(verifyCalls, 2, '实施完成后的真实验证必须执行');
  assert.equal(reviews, 2);
  assert.equal(result.runtimeRecoveryAttempt, 1);
  assert.equal(result.reviewRecoveryAttempt, 2);
  assert.equal(result.reviewFeedback, '');
  const late = repairHandoffs.at(-1);
  assert.equal(late.find(item => item.phase === 'review' && item.decision === 'reject').summary, rejectionBrief);
  assert.equal(late.findLast(item => item.code === 'review_rejected' && item.attempt)?.reviewFeedback, rejectionBrief,
    '未决最终拒绝随失败交接保留到返工');
});

test('独立维护入口：真实 diagnose 批准编排文件→repair 补丁→验证收到精确编排授权→唯一 patch_review', async () => {
  const files = {};
  const calls = [];
  const verifyContracts = [];
  const deps = {
    settings: { mainAgent: 'codex', subAgent: 'claude', dualAgentEnabled: true },
    prompt: 'maintenance task', efficientMode: true,
    initialFailure: cliExit(),
    inspect: async () => ({ head: 'a'.repeat(40), dirty: Object.keys(files).length > 0,
      fingerprint: JSON.stringify(files), files: Object.keys(files), fileFingerprints: { ...files } }),
    onProgress: async (phase, agent) => calls.push([phase, agent]),
    runStage: async (phase) => {
      if (phase === 'diagnose') return { decision: 'repair', summary: '修复恢复编排',
        allowedFiles: ['core/src/services/evolution-team.js', 'core/test/evolution-team.test.js', 'docs/HANDOFF.md'] };
      if (phase === 'repair') {
        files['core/src/services/evolution-team.js'] = 'patched';
        files['core/test/evolution-team.test.js'] = 'patched';
        files['docs/HANDOFF.md'] = 'patched';
        return { decision: 'implemented', summary: '编排补丁完成' };
      }
      if (phase === 'patch_review') return { decision: 'approve', summary: '补丁验收通过' };
      throw new Error(`unexpected phase ${phase}`);
    },
    verify: async contract => verifyContracts.push(jsonRoundtrip(contract)),
    commit: async () => 'b'.repeat(40),
  };
  const result = await runTeamWorkflow(deps);
  assert.equal(result.decision, 'approve');
  assert.equal(result.repairOnly, true);
  assert.deepEqual(calls.map(call => call[0]), ['diagnose', 'repair', 'verify', 'patch_review', 'commit']);
  assert.ok(calls.every(([phase]) => !['research', 'plan', 'implement', 'review', 'repair_review'].includes(phase)),
    '业务 research/implement/review 不借维护补丁完成');
  assert.deepEqual(verifyContracts, [{ reviewedOrchestrationFiles: ['core/src/services/evolution-team.js'],
    baselineChecks: [], baseCommit: 'a'.repeat(40) }], '验证收到精确编排授权与空基线反证');
  assert.deepEqual(result.reviewedOrchestrationFiles, ['core/src/services/evolution-team.js']);
  assert.deepEqual(result.lessons, []);
  assert.deepEqual(result.githubResolutions, []);
  assert.equal(result.feedbackReviewed, false, '仅修复编排时反馈复核保持 false');
});

// ---------------------------------------------------------------------------
// Fresh stages accept valid outputs independently of native IDs.
test('真实 runner：大事件及无原生 ID 不影响单 Main，工具失败回同一 Main 完成', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'farm-team-session-'));
  const write = (file, data) => {
    const full = path.resolve(dir, file);
    if (full !== dir && !full.startsWith(dir + path.sep)) throw new Error(`fixture_escape:${file}`);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, data);
  };
  const git = args => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const fakeCli = mainOwnedFixtureCli();
  try {
    write('core/scripts/run-evolution-team.js', fs.readFileSync(path.join(__dirname, '../scripts/run-evolution-team.js')));
    write('core/scripts/run-evolution-main-mcp.js', fs.readFileSync(path.join(__dirname, '../scripts/run-evolution-main-mcp.js')));
    write('core/scripts/evolution-apply-process.js', `module.exports = require(${JSON.stringify(require.resolve('../scripts/evolution-apply-process'))});`);
    for (const name of ['evolution-main-workflow', 'evolution-main-mcp']) {
      write(`core/src/services/${name}.js`, `module.exports = require(${JSON.stringify(require.resolve(`../src/services/${name}`))});`);
    }
    for (const name of ['activity-evolver', 'privacy-guard', 'evolution-team', 'evolution-sessions', 'evolution-worktree']) {
      write(`core/src/services/${name}.js`, `module.exports = require(${JSON.stringify(require.resolve(`../src/services/${name}`))});\n`);
    }
    write('core/src/services/evolution-validation.js', `module.exports.runEvolutionValidation = async ({repoRoot}) => ({ state: 'passed', fingerprint: require(${JSON.stringify(require.resolve('../src/services/evolution-validation'))}).logicSnapshot(repoRoot).fingerprint, checks: ['backend','frontend'], checkedAt: Date.now() });\n`);
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
    const failonce = run('failonce');
    assert.equal(failonce.status, 0, failonce.stderr);
    assert.notEqual(git(['rev-parse', 'HEAD']), baseCommit);
    assert.ok(!fs.existsSync(registryFile));
    assert.ok(!fs.existsSync(path.join(dir, 'core/data/resume.log')));
    assert.ok(!fs.readdirSync(path.join(dir, 'core/data/logs')).some(file => /-schema\.json$/.test(file)));
    const failonceJournal = journalOf('failonce');
    assert.equal(failonceJournal.lastFailure.code, 'cli_exit', '首轮失败按执行失败真实记录');
    assert.ok(failonceJournal.recoveryAttempt >= 1);
    assert.equal(fs.readFileSync(path.join(dir, 'core/data/calls.log'), 'utf8'), 'main:codex\nworker:claude\nexternal:claude\n', '工具失败由同一 Main 处理，不重开独立审批会话');
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
