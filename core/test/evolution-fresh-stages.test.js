const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync, spawnSync } = require('node:child_process');
const { test, after } = require('node:test');
const priorDataDir = process.env.FARM_DATA_DIR;
const importDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farm-fresh-import-'));
process.env.FARM_DATA_DIR = importDataDir;
const protectedSources = [__filename, require.resolve('../src/services/evolution-sessions'), require.resolve('../src/services/evolution-learning')];
const sourceFingerprint = () => protectedSources.map(file => [file,
  crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'), fs.lstatSync(file).mode & 0o777]);
const originalSources = sourceFingerprint();
after(() => {
  try { assert.deepEqual(sourceFingerprint(), originalSources); }
  finally {
    if (priorDataDir === undefined) delete process.env.FARM_DATA_DIR;
    else process.env.FARM_DATA_DIR = priorDataDir;
    fs.rmSync(importDataDir, { recursive: true, force: true });
  }
});

// 全新会话政策（owner 2026-10-09）聚焦行为测试：
// 1) buildFreshHandoffContext：有界摘录 + 钉选硬约束（超大尾部也不丢）+ 省略
//    告知 + 标题锚点；绝不宣称"已读/沿用快照"；缺失文档如实 missing。
// 2) 交替 invalid_decision 根因复现：journal 里 in_run 且 completed=[] 的凭据
//    在读取侧不再作为续接凭据提供（走 fresh）；runner 直接收到同形状凭据仍按
//    invalid_decision 拒绝（身份检查未放宽）。
// 3) 私有技能材料化：仅已批准经验生成、固定主题名、0700/0600、篡改重生成、
//    失焦回收、空权威零脚手架、敏感条目不落盘、符号链接拒绝、上下文注入。
// 4) 真实 runner 端到端（严格假 CLI + 真 stdio MCP）：每轮一个 fresh Main，
//    Sub 是该 Main 的工具；污染 legacy 登记不影响工作。两 provider 反选和同
//    provider 均检查原生调用无 resume/app-server、Main 持续接回并修正。

const sessions = require('../src/services/evolution-sessions');
const learning = require('../src/services/evolution-learning');
const { readTeamJournal } = require('../src/services/evolution-team');

function makeCheckpoint({ completed = [{ phase: 'research', decision: 'researched', summary: 'done' }], baselineHead, kind = 'in_run' } = {}) {
  return {
    version: 1,
    kind,
    baselineHead,
    patchHead: '',
    roundId: '2026-10-09-fixture',
    taskIdentity: {
      task: 'safety',
      promptDigest: 'a'.repeat(64),
      feedbackThroughAt: 0,
      activityPlanDigest: '',
      githubBatchDigest: '',
      quotaDate: '',
      automatic: false,
      combinedDaily: false,
    },
    allowedFiles: [],
    approvedScope: [],
    acceptanceChecks: [],
    baselineChecks: [],
    fileFingerprints: {},
    worktreeFingerprint: '',
    verifiedFingerprint: '',
    counters: {},
    auditCounters: {},
    completed,
  };
}

// ---- 1) 有界 fresh 上下文 ----

test('buildFreshHandoffContext：有界、钉选硬约束、省略告知与锚点、缺失如实', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'farm-fresh-ctx-'));
  try {
    const handoffFile = path.join(dir, 'HANDOFF.md');
    // 缺失：mode=missing，不伪造上下文。
    const missing = sessions.buildFreshHandoffContext({ handoffFile });
    assert.equal(missing.mode, 'missing');
    assert.match(missing.directive, /不存在或不可读/);
    assert.ok(!missing.sourceSha256);

    // 超大尾部（远超 40KB 预算）：钉选章节仍完整在场。
    const filler = Array.from({ length: 200 }, (_, i) => `## 历史章节 ${i}\nFILLER-${i} ${'x'.repeat(400)}`).join('\n');
    fs.writeFileSync(handoffFile, [
      '## 当前执行策略',
      '自动进化一律独立 fresh CLI 会话。',
      '## 用户硬约束',
      '禁止恢复整号熔断；禁止把内网地址写入受跟踪文件。',
      filler,
    ].join('\n'));
    const ctx = sessions.buildFreshHandoffContext({ handoffFile });
    assert.equal(ctx.mode, 'excerpt');
    assert.ok(Buffer.byteLength(ctx.directive, 'utf8') <= 48 * 1024, '摘录必须保持在 32–48KB 有界区间');
    assert.match(ctx.directive, /全新会话/);
    assert.match(ctx.directive, /# 当前执行策略/);
    assert.match(ctx.directive, /# 用户硬约束/);
    assert.match(ctx.directive, /禁止恢复整号熔断/);
    assert.match(ctx.directive, /本摘录已省略 \d+ 个更早章节/);
    assert.match(ctx.directive, /章节标题锚点/);
    assert.match(ctx.directive, /- ## 历史章节 0\b/);
    // 绝不向新会话宣称"已完整读取/无需重读"；被省略章节的正文绝不混入摘录。
    assert.doesNotMatch(ctx.directive, /已完整读取|无需重读|视为已读/);
    assert.doesNotMatch(ctx.directive, /FILLER-0\b/);

    // 预算极小：钉选章节仍不截断（约束永不静默丢弃）。
    assert.throws(() => sessions.buildFreshHandoffContext({ handoffFile, maxBytes: 10 }),
      error => error.code === 'missing_handoff');
    fs.appendFileSync(handoffFile, `\n## 巨大最新章节\n${  '历史'.repeat(30000)  }当前尾部证据`);
    const tail = sessions.buildFreshHandoffContext({ handoffFile });
    assert.match(tail.directive, /当前尾部证据/);
    assert.match(tail.directive, /正文已截断/);
    assert.ok(Buffer.byteLength(tail.directive) <= 40 * 1024);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---- 2) 交替 invalid_decision 复现 ----

test('journal 读取侧丢弃空 completed 的 in_run 凭据；runner 身份检查保持拒绝', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'farm-alt-fail-'));
  const logDir = path.join(dir, 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  try {
    const head = 'c'.repeat(40);
    const writeJournal = (runId, checkpoint) => fs.writeFileSync(
      path.join(logDir, `evolve-team-${runId}.json`),
      JSON.stringify({ runId, baseCommit: head, mainAgent: 'claude', subAgent: 'codex',
        phase: 'failed', status: 'failed', activeAgent: '', head, checkpoint }),
    );
    const active = { dualAgentEnabled: true, runId: 'alt-empty', baseCommit: head, agent: 'claude', subAgent: 'codex' };

    // 真实故障形状（2026-10-09 evolve-team-1791513882423）：research 未完成即失败，
    // in_run + completed=[]。读取侧不得再把它当续接凭据。
    writeJournal('alt-empty', makeCheckpoint({ completed: [], baselineHead: head }));
    const dropped = readTeamJournal(logDir, active);
    assert.ok(dropped, 'journal 本身仍应被读取');
    assert.equal(dropped.checkpoint, null, '空 completed 的 in_run 凭据不再是续接凭据');

    // 对照：completed 非空的真实凭据保留（身份检查语义不变）。
    writeJournal('alt-real', makeCheckpoint({ baselineHead: head }));
    const kept = readTeamJournal(logDir, { ...active, runId: 'alt-real' });
    assert.equal(kept.checkpoint.kind, 'in_run');
    assert.equal(kept.checkpoint.completed.length, 1);

    // runner 侧（隔离子进程，真实 git 仓库内直接实测）：直接传入空 completed 的
    // in_run 凭据仍按 invalid_decision 拒绝——修复只改变凭据供给，不放宽校验。
    // runner 固定按自身路径推导 repoRoot，故把脚本与依赖 shim 复制进 fixture 再 require。
    const write = (file, text) => {
      fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      fs.writeFileSync(path.join(dir, file), text);
    };
    write('core/scripts/run-evolution-team.js', fs.readFileSync(path.join(__dirname, '../scripts/run-evolution-team.js')));
    write('core/scripts/run-evolution-main-mcp.js', fs.readFileSync(path.join(__dirname, '../scripts/run-evolution-main-mcp.js')));
    write('core/scripts/evolution-apply-process.js', `module.exports = require(${JSON.stringify(require.resolve('../scripts/evolution-apply-process'))});`);
    for (const name of ['evolution-main-workflow', 'evolution-main-mcp']) {
      write(`core/src/services/${name}.js`, `module.exports = require(${JSON.stringify(require.resolve(`../src/services/${name}`))});`);
    }
    for (const name of ['activity-evolver', 'privacy-guard', 'evolution-team', 'evolution-validation', 'evolution-countercheck', 'evolution-sessions', 'evolution-worktree']) {
      write(`core/src/services/${name}.js`, `module.exports = require(${JSON.stringify(require.resolve(`../src/services/${name}`))});`);
    }
    write('core/src/services/evolution-references.js', 'module.exports.collectPublicReferences = async () => ({});\n');
    write('docs/HANDOFF.md', '# fixture\n');
    write('.gitignore', 'logs/\n');
    execFileSync('git', ['init', '-q'], { cwd: dir });
    execFileSync('git', ['config', 'user.name', 'T'], { cwd: dir });
    execFileSync('git', ['config', 'user.email', ['test', 'users.noreply.github.com'].join('@')], { cwd: dir });
    execFileSync('git', ['add', '.'], { cwd: dir });
    execFileSync('git', ['commit', '-qm', 'base'], { cwd: dir });
    const realHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
    const checkpoint = makeCheckpoint({ completed: [], baselineHead: realHead });
    const probe = spawnSync(process.execPath, ['-e', `
      const { validateResumeInput } = require('./core/scripts/run-evolution-team.js');
      try { validateResumeInput(${JSON.stringify(checkpoint)}, ${JSON.stringify(realHead)}); process.exit(0); }
      catch (error) { process.stderr.write(String(error.code || error.message)); process.exit(3); }
    `], { cwd: dir, encoding: 'utf8', timeout: 30000 });
    assert.equal(probe.status, 3, probe.stderr);
    assert.match(probe.stderr, /invalid_decision/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---- 3) 私有技能材料化 ----

test('材料化：仅已批准主题、固定命名、0700/0600、篡改重生成、失焦回收、空权威零脚手架', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'farm-skills-'));
  try {
    // 空权威：不生成任何文件，也不保留旧产物。
    const empty = learning.materializeApprovedSkills(dir);
    assert.deepEqual(empty.topics, []);
    assert.ok(!fs.existsSync(path.join(dir, 'evolution-skills')));

    const record = lessons => learning.recordApprovedLessons({
      dataDir: dir, lessons, mainAgent: 'claude', writerAgent: 'claude', commit: 'd'.repeat(40),
    });
    record([{ topic: 'workflow', rule: '阶段提示一律 fresh CLI 注入', evidence: 'regression' }]);
    let index = learning.materializeApprovedSkills(dir);
    assert.deepEqual(index.topics.map(item => item.topic), ['workflow']);
    const file = path.join(dir, 'evolution-skills', 'farm-evolution-workflow', 'SKILL.md');
    const content = fs.readFileSync(file, 'utf8');
    assert.match(content, /^---\nname: farm-evolution-workflow\ndescription: \S[^\n]*\n---/);
    assert.match(content, /阶段提示一律 fresh CLI 注入/);
    assert.match(content, /不是新授权/);
    assert.equal(fs.statSync(path.join(dir, 'evolution-skills')).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(dir, 'evolution-skills', 'farm-evolution-workflow')).mode & 0o777, 0o700);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    const recordedSha = index.topics[0].sha256;
    const crypto = require('node:crypto');
    assert.equal(crypto.createHash('sha256').update(content).digest('hex'), recordedSha);

    // 篡改：下次材料化按权威记录重生成。
    fs.chmodSync(file, 0o644);
    fs.chmodSync(path.join(dir, 'evolution-skills', 'index.json'), 0o644);
    learning.materializeApprovedSkills(dir);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.join(dir, 'evolution-skills', 'index.json')).mode & 0o777, 0o600);
    fs.writeFileSync(file, 'tampered');
    index = learning.materializeApprovedSkills(dir);
    assert.equal(fs.readFileSync(file, 'utf8'), content, '篡改产物被权威渲染覆盖');

    // 追加主题 + 失焦回收：权威记录换成只剩 privacy（合法形状）后，
    // 无经验主题目录必须被回收（recording 合并语义不会删旧经验，故直接改权威 JSON）。
    fs.writeFileSync(path.join(dir, 'evolution-learning.json'), JSON.stringify({ version: 1, updatedAt: 2, count: 1, lessons: [
      { topic: 'privacy', rule: '原始日志不进受跟踪文件', evidence: 'runtime_feedback',
        mainAgent: 'claude', commit: 'd'.repeat(40), updatedAt: 2 },
    ] }));
    index = learning.materializeApprovedSkills(dir);
    assert.deepEqual(index.topics.map(item => item.topic), ['privacy']);
    assert.ok(!fs.existsSync(path.join(dir, 'evolution-skills', 'farm-evolution-workflow')), '无经验主题目录被回收');
    assert.ok(fs.existsSync(path.join(dir, 'evolution-skills', 'farm-evolution-privacy', 'SKILL.md')));

    // 敏感/非法条目（手工写坏权威 JSON）绝不成为技能：整体按空权威处理并清产物。
    fs.writeFileSync(path.join(dir, 'evolution-learning.json'), `{"version":1,"lessons":[{"topic":"../../escape","rule":"x","evidence":"regression","mainAgent":"claude","commit":"${'d'.repeat(40)}","updatedAt":1}]}`);
    index = learning.materializeApprovedSkills(dir);
    assert.deepEqual(index.topics, [], '非法权威记录不产出技能');
    assert.ok(!fs.existsSync(path.join(dir, 'evolution-skills', 'farm-evolution-privacy')));

    // 符号链接逃逸：skills 根为符号链接时拒绝且不穿透（源目录不变）。
    const outside = path.join(dir, 'outside');
    fs.mkdirSync(outside);
    fs.chmodSync(outside, 0o755);
    const outsideMode = fs.statSync(outside).mode & 0o777;
    fs.symlinkSync(outside, path.join(dir, 'evolution-skills'));
    learning.recordApprovedLessons({
      dataDir: dir, lessons: [{ topic: 'workflow', rule: 'again', evidence: 'source_review' }],
      mainAgent: 'claude', writerAgent: 'claude', commit: 'd'.repeat(40),
    });
    assert.throws(() => learning.materializeApprovedSkills(dir),
      error => error.code === 'EVOLUTION_LEARNING_ESCAPE');
    assert.deepEqual(fs.readdirSync(outside), [], '拒绝时未穿透写入符号链接目标');
    assert.equal(fs.statSync(outside).mode & 0o777, outsideMode);

    // 上下文注入：已批准规则 + 技能路径同时出现（材料化恢复正常后）。
    fs.rmSync(path.join(dir, 'evolution-skills'));
    const context = learning.buildLearningContext(dir);
    assert.match(context, /again/);
    assert.match(context, /evolution-skills\/farm-evolution-workflow\/SKILL\.md/);
    assert.match(context, /不构成新授权/);
    assert.ok(context.includes(path.join(dir, 'evolution-skills', 'farm-evolution-workflow', 'SKILL.md')));
    record([{ topic: 'fertilizer_watch', rule: '单目标时钟', evidence: 'regression' }]);
    const fertilizer = learning.materializeApprovedSkills(dir).topics.find(item => item.topic === 'fertilizer_watch');
    assert.ok(fertilizer.file.includes('farm-evolution-fertilizer-watch'));
    assert.match(fs.readFileSync(path.join(dir, fertilizer.file), 'utf8'), /name: farm-evolution-fertilizer-watch\n/);
    record(Array.from({length: 8}, (_, i) => ({topic: 'verification', rule: `验收规则 ${i}`, evidence: 'regression'})));
    record([{topic: 'verification', rule: '验收规则 8', evidence: 'regression'}]);
    const all = learning.materializeApprovedSkills(dir).topics.find(item => item.topic === 'verification');
    assert.equal(all.rules, 9);
    assert.match(fs.readFileSync(path.join(dir, all.file), 'utf8'), /验收规则 8/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---- 4) 真实 runner 端到端：fresh CLI、污染 registry、同 provider、轮内恢复 ----

test('真实 runner：污染 legacy registry 不影响单 Main 及内嵌工具；两 provider 反选与同 provider 均 fresh', t => {
  const { NATIVE_CLI, createRunnerFixture } = require('./evolution-main-runner.test');
  const f = createRunnerFixture(t);
  const cli = NATIVE_CLI.replace("const main=!!config.farm_evolution", String.raw`const learnedLine=input.split('\n').find(line=>line.startsWith('- 协作流程与阶段契约'));
const learnedRuleRead=!!learnedLine&&fs.readFileSync(learnedLine.slice(learnedLine.indexOf('：')+1),'utf8').includes('验证后才应用');
write('core/data/prompt-'+process.pid+'.json',JSON.stringify({learnedRuleRead,input,contextCopies:input.split('以下是协调进程从 docs/HANDOFF.md 确定性摘出的有界当前上下文').length-1}));
const main=!!config.farm_evolution`);
  for (const agent of ['codex', 'claude']) {
    f.write(`core/data/fake-${agent}`, cli); fs.chmodSync(f.target(`core/data/fake-${agent}`), 0o700);
  }
  f.write('core/data/evolution-sessions/registry.json', '{corrupt');
  fs.mkdirSync(f.target('core/data/evolution-sessions/main'), { recursive: true });
  learning.recordApprovedLessons({ dataDir: f.target('core/data'), mainAgent: 'claude', writerAgent: 'claude',
    commit: f.baseCommit, lessons: [{ topic: 'workflow', rule: '验证后才应用', evidence: 'regression' }] });
  const learnedContext = learning.buildLearningContext(f.target('core/data'));
  for (const settings of [{ mainAgent: 'codex', subAgent: 'claude', dualAgentEnabled: true },
    { mainAgent: 'claude', subAgent: 'codex', dualAgentEnabled: true },
    { mainAgent: 'claude', subAgent: 'claude', dualAgentEnabled: true }]) {
    f.git(['reset', '--hard', f.baseCommit]); f.write('core/data/native-calls.jsonl', '');
    const result = f.run(settings, { runId: `fresh-${settings.mainAgent}-${settings.subAgent}`,
      prompt: `【待协调进程注入当前 HANDOFF 有界摘录】\nFixture task\n${learnedContext}`,
      initialFailure: { code: 'cli_exit', phase: 'research', agent: settings.subAgent } });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    const calls = fs.readFileSync(f.target('core/data/native-calls.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.equal(calls.length, 3, '一个新 Main、一次写实施和额外独立外部issue核查');
    assert.equal(calls.filter(call => call.kind === 'external').length, 1);
    const main = calls.find(call => call.kind === 'main'); const worker = calls.find(call => call.kind === 'worker');
    assert.equal(main.provider, settings.mainAgent); assert.equal(worker.provider, settings.subAgent);
    for (const call of calls) {
      assert.ok(!call.argv.some(arg => arg === 'resume' || arg === '--resume' || arg.startsWith('--resume=')), '不续接历史 native 会话');
      assert.ok(!call.argv.includes('app-server'));
    }
    const context = JSON.parse(fs.readFileSync(f.target(`core/data/prompt-${main.pid}.json`)));
    assert.equal(context.learnedRuleRead, true, '当前 Main 实际读取注入的已批准经验规则');
    assert.equal(context.contextCopies, 1, '持续主会话只注入一份有界 HANDOFF');
    assert.match(context.input, /持续主 Agent|全新会话/); assert.match(context.input, /有界当前上下文/);
    assert.ok(worker.promptLength <= 6000, 'Sub 只收到这一项任务的有界指令');
    const continued = JSON.parse(fs.readFileSync(f.target('core/data/main-continued.json')));
    assert.equal(continued.pid, main.pid, '工具失败仍回到同一 Main，由 Main 直接修正');
    assert.equal(continued.workerFailed, true);
    const journal = JSON.parse(fs.readFileSync(f.target(`core/data/logs/evolve-team-fresh-${settings.mainAgent}-${settings.subAgent}.json`)));
    assert.equal(journal.status, 'completed'); assert.equal(journal.orchestration, 'main-owned');
    const committed = f.git(['show', '--name-only', '--format=', 'HEAD']).split('\n').filter(Boolean);
    assert.deepEqual(committed, ['core/src/example.js']);
    assert.equal(fs.readFileSync(f.target('core/data/evolution-sessions/registry.json'), 'utf8'), '{corrupt');
    assert.ok(fs.existsSync(f.target('core/data/evolution-sessions/main')));
  }
});
