const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  nextCredentialKeepaliveDelayMs,
  WX_KEEPALIVE_MIN_MS,
  WX_KEEPALIVE_MAX_MS,
} = require('../src/runtime/auto-code-refresh');
const {
  classifyEvolutionExit,
  normalizePersistedState,
  resolveClaudeBin,
  resolveCodexBin,
  buildEvolutionAgentCommand,
  buildEvolutionAgentEnv,
  formatEvolutionChangeSummary,
  markEvolutionAppliedAfterRestart,
  normalizeEvolutionInstruction,
  normalizeRevisionContext,
  buildRevisionContinuity,
  buildEvolutionGuardrails,
  buildPrompt,
  buildSafetyPrompt,
} = require('../src/services/activity-evolver');

test('微信凭据保活使用 25-35 分钟抖动窗口', () => {
  for (let i = 0; i < 200; i += 1) {
    const delay = nextCredentialKeepaliveDelayMs();
    assert.ok(delay >= WX_KEEPALIVE_MIN_MS);
    assert.ok(delay <= WX_KEEPALIVE_MAX_MS);
  }
});

test('在线账号不再按固定周期换 Code 或重启 Worker', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/runtime/auto-code-refresh.js'), 'utf8');
  const requestBlock = source.slice(
    source.indexOf('async function requestFarmCode'),
    source.indexOf('async function refreshAccountCode'),
  );
  const refreshBlock = source.slice(
    source.indexOf('async function refreshAccountCode'),
    source.indexOf('function armCredentialKeepalive'),
  );
  const scheduleBlock = source.slice(
    source.indexOf('function scheduleAccount'),
    source.indexOf('function rescheduleAll'),
  );
  const keepaliveBlock = source.slice(
    source.indexOf('function armCredentialKeepalive'),
    source.indexOf('function armOfflineCredentialKeepalive'),
  );

  assert.doesNotMatch(requestBlock, /keepWxCredentialAlive/);
  assert.match(refreshBlock, /addOrUpdateAccount\(\{ id: account\.id, code \}\)/);
  assert.doesNotMatch(refreshBlock, /nextAccount\s*=\s*\{\s*\.\.\.account,\s*code\s*\}/);
  assert.doesNotMatch(scheduleBlock, /refreshAccountCode\s*\(\s*accountId\s*,\s*['"]timer['"]/);
  assert.match(scheduleBlock, /armCredentialKeepalive/);
  assert.match(keepaliveBlock, /setTimeoutTask/);
  assert.match(keepaliveBlock, /不换游戏 Code/);
});

test('Worker 每次启动后都会重新挂载凭据保活', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/runtime/worker-manager.js'), 'utf8');
  assert.match(source, /scheduleAccountRefresh\(account\.id\)/);
});

test('安全巡检 SIGTERM/143 归类为中止而不是失败', () => {
  assert.equal(classifyEvolutionExit(143, '', false), 'interrupted');
  assert.equal(classifyEvolutionExit(null, 'SIGTERM', false), 'interrupted');
  assert.equal(classifyEvolutionExit(130, '', false), 'interrupted');
  assert.equal(classifyEvolutionExit(1, '', false), 'failed');
  assert.equal(classifyEvolutionExit(0, '', false), 'no_change');
  assert.equal(classifyEvolutionExit(143, 'SIGTERM', true), 'pending_apply');
  assert.equal(classifyEvolutionExit(0, '', true, false), 'push_failed');
  assert.equal(classifyEvolutionExit(0, '', true, false, true), 'privacy_blocked');
});

test('历史 143 失败状态自动迁移为可重试的中止状态', () => {
  const state = normalizePersistedState({
    status: 'failed',
    lastTask: 'safety',
    lastSafetyEvolveDate: '2026-08-25',
    commit: 'stale-commit',
    summary: '安全巡检执行失败（退出码 143），详见 evolve-safety-2026-08-25.log',
  });

  assert.equal(state.status, 'interrupted');
  assert.equal(state.lastSafetyEvolveDate, '');
  assert.equal(state.commit, '');
  assert.match(state.summary, /历史状态自动修正/);
  assert.match(state.summary, /可重试/);
});

test('中止的活动进化也会清除每日闸门以便重试', () => {
  const state = normalizePersistedState({
    status: 'failed',
    lastTask: 'activity',
    lastEvolveDate: '2026-08-25',
    summary: '活动进化执行失败（退出码 143）',
  });

  assert.equal(state.status, 'interrupted');
  assert.equal(state.lastEvolveDate, '');
});

test('Claude/Codex 可跨 NVM Node 版本解析并生成各自非交互命令', () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'farm-agent-bin-'));
  const claudeBin = path.join(tempHome, '.nvm/versions/node/v18.20.8/bin/claude');
  const codexBin = path.join(tempHome, '.nvm/versions/node/v18.20.8/bin/codex');
  try {
    fs.mkdirSync(path.dirname(claudeBin), { recursive: true });
    fs.writeFileSync(claudeBin, '#!/bin/sh\nexit 0\n');
    fs.writeFileSync(codexBin, '#!/bin/sh\nexit 0\n');
    fs.chmodSync(claudeBin, 0o755);
    fs.chmodSync(codexBin, 0o755);
    assert.equal(resolveClaudeBin({ env: { PATH: '' }, homeDir: tempHome }), claudeBin);
    assert.equal(resolveCodexBin({ env: { PATH: '' }, homeDir: tempHome }), codexBin);

    const claude = buildEvolutionAgentCommand('claude', '审计', { env: { PATH: '' }, homeDir: tempHome });
    assert.deepEqual(claude.args, ['-p', '--dangerously-skip-permissions']);
    assert.equal(claude.stdin, '审计');
    const codex = buildEvolutionAgentCommand('codex', '审计', { env: { PATH: '' }, homeDir: tempHome });
    assert.deepEqual(codex.args, ['exec', '--dangerously-bypass-approvals-and-sandbox', '--color', 'never', '-']);
    assert.equal(codex.stdin, '审计');
  } finally {
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});

test('自动进化只继承运行必需环境且 Prompt 不进入命令行', () => {
  const env = buildEvolutionAgentEnv({
    HOME: '/tmp/example-home',
    PATH: '/usr/bin',
    HTTPS_PROXY: 'http://proxy.invalid',
    VSCODE_GIT_IPC_AUTH_TOKEN: 'must-not-pass',
    CODE_SERVER_HASHED_PASSWORD: 'must-not-pass',
    ANTHROPIC_API_KEY: 'must-not-pass',
  });
  assert.equal(env.HOME, '/tmp/example-home');
  assert.equal(env.HTTPS_PROXY, 'http://proxy.invalid');
  assert.equal(env.GIT_TERMINAL_PROMPT, '0');
  assert.equal(env.GIT_CONFIG_KEY_0, 'core.hooksPath');
  assert.match(env.GIT_CONFIG_VALUE_0, /scripts[\\/]evolution-hooks$/);
  assert.equal(env.VSCODE_GIT_IPC_AUTH_TOKEN, undefined);
  assert.equal(env.CODE_SERVER_HASHED_PASSWORD, undefined);
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
});

test('自动进化执行器状态兼容旧数据并允许持久化 Codex', () => {
  assert.equal(normalizePersistedState({}).defaultAgent, 'claude');
  assert.equal(normalizePersistedState({ agent: 'codex' }).defaultAgent, 'codex');
  const selected = normalizePersistedState({ defaultAgent: 'codex', agent: 'claude' });
  assert.equal(selected.defaultAgent, 'codex');
  assert.equal(selected.agent, 'codex');
  assert.equal(normalizePersistedState({ defaultAgent: 'unknown' }).defaultAgent, 'claude');
});

test('用户修改要求持久化并注入每轮进化提示词', () => {
  const instruction = normalizeEvolutionInstruction('  保持当前偷菜策略\r\n不要恢复整号熔断  ');
  assert.equal(instruction, '保持当前偷菜策略\n不要恢复整号熔断');
  assert.equal(normalizePersistedState({ userInstruction: instruction }).userInstruction, instruction);
  assert.equal(normalizeEvolutionInstruction('x'.repeat(5000)).length, 4000);

  const prompt = buildSafetyPrompt(instruction);
  assert.match(prompt, /用户保存的修改要求/);
  assert.match(prompt, /保持当前偷菜策略/);
  assert.match(prompt, /不要恢复整号熔断/);
});

test('活动与安全进化共用历史踩坑回归硬门', () => {
  const guardrails = buildEvolutionGuardrails();
  assert.match(guardrails, /第一项操作必须是从头到尾完整读取 docs\/HANDOFF\.md/);
  assert.match(guardrails, /HANDOFF\.md 不只是说明文档，而是回归约束清单/);
  assert.match(guardrails, /禁止恢复整号熔断/);
  assert.match(guardrails, /自己成熟到点 Harvest/);
  assert.match(guardrails, /好友到点偷菜/);
  assert.match(guardrails, /重点用户 PREARM\/HOT/);
  assert.match(guardrails, /踩坑注意点/);
  assert.match(guardrails, /允许完全不改代码、不改 HANDOFF、不生成提交/);
  assert.match(guardrails, /GitHub 零个人信息|隐私与推送硬门/);
  assert.match(guardrails, /严禁执行 git push/);

  const safetyPrompt = buildSafetyPrompt();
  assert.match(safetyPrompt, /没有可靠证据支持的可修项/);
  assert.doesNotMatch(safetyPrompt, /没有可修的就只更新 HANDOFF/);
});

test('拒绝重做继承上一轮提交、日志和变更摘要', () => {
  const context = normalizeRevisionContext({
    commit: '1234567890abcdef',
    task: 'safety',
    logFile: '/tmp/evolve-safety-codex.log',
    summary: '上一轮待应用',
    changeSummary: '修改了请求治理',
    rejectedAt: 123,
  });
  assert.equal(context.task, 'safety');
  assert.equal(normalizePersistedState({ revisionContext: context }).revisionContext.commit, context.commit);

  const continuity = buildRevisionContinuity(context);
  assert.match(continuity, /不是从零开始的新任务/);
  assert.match(continuity, /git show --stat 1234567890abcdef/);
  assert.match(continuity, /evolve-safety-codex\.log/);
  assert.match(continuity, /修改了请求治理/);

  const prompt = buildSafetyPrompt('保留当前策略', context);
  assert.ok(prompt.indexOf('执行顺序硬门') < prompt.indexOf('拒绝重做的连续上下文'));
  assert.ok(prompt.indexOf('执行顺序硬门') < prompt.indexOf('【目标】'));
  const activityPrompt = buildPrompt({ online: { activities: [], groups: [] } }, [], [], '保留当前策略', context);
  assert.ok(activityPrompt.indexOf('执行顺序硬门') < activityPrompt.indexOf('【任务】'));
  assert.match(activityPrompt, /git show --stat 1234567890abcdef/);
});

test('飞书进化通知摘要列出提交说明、文件和增删行数', () => {
  const summary = formatEvolutionChangeSummary(
    '安全巡检: 降低重复请求',
    '12\t3\tcore/src/core/worker.js\n4\t1\tdocs/HANDOFF.md\n-\t-\tweb/public/demo.png\n',
    '1234567890abcdef',
  );
  assert.match(summary, /修改内容：安全巡检: 降低重复请求/);
  assert.match(summary, /3 个文件，新增 16 行，删除 4 行/);
  assert.match(summary, /core\/src\/core\/worker\.js（\+12\/-3）/);
  assert.match(summary, /web\/public\/demo\.png（二进制文件）/);
});

test('应用进化重启后从 applying 收口为 applied', () => {
  const result = markEvolutionAppliedAfterRestart({
    status: 'applying',
    commit: '1234567890abcdef',
  });
  assert.equal(result.changed, true);
  assert.equal(result.state.status, 'applied');
  assert.match(result.state.summary, /12345678/);
  assert.equal(markEvolutionAppliedAfterRestart({ status: 'pending_apply' }).changed, false);
});

test('应用进化只复用既有 farm tmux pane', () => {
  const script = fs.readFileSync(path.join(__dirname, '../../scripts/apply-evolution.sh'), 'utf8');
  assert.match(script, /FARM_TMUX_TARGET:-farm:0\.0/);
  assert.match(script, /tmux display-message/);
  assert.match(script, /tmux send-keys/);
  assert.doesNotMatch(script, /tmux new(?:-session)?/);
  assert.doesNotMatch(script, /nohup bash start\.sh/);
});

test('自动进化子进程的 Git hook 明确拒绝直接推送', () => {
  const hook = path.join(__dirname, '../../scripts/evolution-hooks/pre-push');
  const source = fs.readFileSync(hook, 'utf8');
  assert.ok((fs.statSync(hook).mode & 0o111) !== 0);
  assert.match(source, /parent privacy gate owns GitHub uploads/);
  assert.match(source, /exit 1/);
});

test('安全巡检在人工改动未提交时安全延期', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/services/activity-evolver.js'), 'utf8');
  assert.match(source, /git status --porcelain --untracked-files=normal/);
  assert.doesNotMatch(source, /--untracked-files=no['"]/);
  assert.match(source, /deferred\.status = 'deferred'/);
  assert.match(source, /为避免自动 agent 覆盖工作区/);
});

test('自动进化强制更新 HANDOFF 并由父进程隐私扫描后推送 GitHub', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/services/activity-evolver.js'), 'utf8');
  const handoff = fs.readFileSync(path.join(__dirname, '../../docs/HANDOFF.md'), 'utf8');
  const panel = fs.readFileSync(path.join(__dirname, '../../web/src/components/admin/AdminActivityUpdatePanel.vue'), 'utf8');

  assert.match(source, /严禁执行 git push/g);
  assert.match(source, /auditGitRange/);
  assert.match(source, /privacy_blocked/);
  assert.match(source, /buildEvolutionAgentEnv/);
  assert.match(source, /child\.stdin\.end\(agentCommand\.stdin\)/);
  assert.match(source, /\['ls-remote', 'origin', 'refs\/heads\/main'\]/);
  assert.match(source, /\['push', 'origin', 'HEAD:main'\]/);
  assert.match(source, /push_failed/);
  assert.match(source, /function schedulePushRetry/);
  assert.match(source, /gitHead\(\) !== commit/);
  assert.match(handoff, /每轮改动必须同步更新 `docs\/HANDOFF\.md`/);
  assert.match(handoff, /每轮改动测试通过后必须上传 GitHub/);
  assert.match(handoff, /HANDOFF 是回归约束/);
  assert.match(source, /function reviseEvolution/);
  assert.match(source, /gitHead\(\) !== state\.commit/);
  assert.match(source, /\['revert', '--no-edit', rejectedCommit\]/);
  assert.match(panel, /拒绝本次并按要求重做（当前无待应用提交）/);
  assert.doesNotMatch(panel, /v-if="evolve\?\.status === 'pending_apply'"/);
});

test('每日安全巡检和轻量活动核对顺序执行且失败只重试一次', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/services/activity-evolver.js'), 'utf8');
  assert.match(source, /function scheduleDailyActivityFollowup/);
  assert.match(source, /function scheduleDailySafetyRetry/);
  assert.match(source, /MAX_DAILY_FAILURE_RETRIES = 1/);
  assert.match(source, /payload\.dailyFollowup/);
  assert.match(source, /Bot 错过窗口或中途重启时补当天 safety/);
  assert.doesNotMatch(source, /else if \(state\.lastEvolveDate !== getLocalDateKey\(\)\)/);
  assert.match(source, /task !== 'safety' && COMPLETED_STATUSES\.has\(outcome\)/);
});
