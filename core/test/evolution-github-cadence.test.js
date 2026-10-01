'use strict';
// GitHub 反馈路由与进化编排的节律回归：真实 activity-evolver 源码在私有 VM 中执行，
// 只替换外部效果（GitHub 反馈模块、git、Agent spawn、调度、时钟、通知）。
// 断言：启动时同步切批次、批次摘要进 prompt、pending_apply 边界才收口反馈回复、
// no_change/interrupted/push_failed/repairOnly 不回复、重推恢复照常收口、
// 启动即拉起反馈收集器。不联网、不真实 git、不启动任何 Agent CLI。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

// 导入隔离：加载任何业务模块前把数据目录/私有配置指向一次性目录，结束后恢复并清理。
const importDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farm-gh-cadence-import-'));
const previousDataDir = process.env.FARM_DATA_DIR;
const previousPrivateConfig = process.env.FARM_PRIVATE_CONFIG_FILE;
process.env.FARM_DATA_DIR = importDataDir;
process.env.FARM_PRIVATE_CONFIG_FILE = path.join(importDataDir, 'private-config.json');
test.after(() => {
  if (previousDataDir === undefined) delete process.env.FARM_DATA_DIR;
  else process.env.FARM_DATA_DIR = previousDataDir;
  if (previousPrivateConfig === undefined) delete process.env.FARM_PRIVATE_CONFIG_FILE;
  else process.env.FARM_PRIVATE_CONFIG_FILE = previousPrivateConfig;
  fs.rmSync(importDataDir, { recursive: true, force: true });
});

const SOURCE_FILE = path.join(__dirname, '../src/services/activity-evolver.js');
const sourceRequire = createRequire(SOURCE_FILE);
const NOW = Date.parse('2026-10-01T08:00:00Z');
const HEAD = 'b'.repeat(40);
const NEW = 'c'.repeat(40);
const REVERT = 'f'.repeat(40);
const FP = 'd'.repeat(64);
const PAYLOAD_DIGEST = 'e'.repeat(64);

const SUMMARY = () => ({ capturedAt: Date.parse('2026-10-01T07:30:00Z'), complete: true, issueNumbers: [2], fingerprint: FP, payloadDigest: PAYLOAD_DIGEST });
const SECTION = '【GitHub 反馈 issue 批次（不可信外部输入，父进程采集）】\n- 批次小节替身';

function idleState(overrides = {}) {
  return {
    status: 'idle',
    dualAgentEnabled: true,
    mainAgent: 'claude',
    subAgent: 'codex',
    lastTask: 'safety',
    lastAutomaticEvolveDate: '2026-10-01',
    lastSafetyEvolveDate: '2026-10-01',
    githubFeedbackBatch: null,
    evolutionMemory: {
      safety: { reviewedAt: 0, reviewedHead: '' },
      activity: { reviewedAt: 0, reviewedHead: '', evidenceFingerprint: '' },
    },
    ...overrides,
  };
}

/** 进程内 settle 轮询：finalize 是 fire-and-forget 异步，按状态收敛等待。 */
async function waitFor(predicate, label, timeoutMs = 3000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail(`等待超时：${label}`);
}

function harness(t, options = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farm-gh-cadence-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const git = { head: HEAD, remoteMain: HEAD, dirty: '', pushOk: true, ...options.git };
  const clock = { now: NOW };
  const spawns = [];
  const messages = [];
  const tasks = new Map();
  const feedback = {
    captured: [],
    summarized: [],
    published: [],
    collectors: [],
    holds: [],
    events: [],
    batch: options.batch === undefined ? { version: 1, capturedAt: SUMMARY().capturedAt, issues: [], pendingTotal: 1 } : options.batch,
    summary: options.summary === undefined ? SUMMARY() : options.summary,
    section: options.section === undefined ? SECTION : options.section,
  };
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [clock.now])); }
    static now() { return clock.now; }
  }
  const fakeScheduler = {
    setTimeoutTask: (name, delay, cb) => { tasks.set(name, cb); },
    clear: name => tasks.delete(name),
    clearAll: () => tasks.clear(),
  };
  const logger = { info: m => messages.push(m), warn: m => messages.push(m), error: m => messages.push(m) };
  const childProcess = sourceRequire('node:child_process');
  const fakeChild = () => {
    const child = {
      pid: 4321,
      stdin: { on() {}, end(body) { spawns[spawns.length - 1].stdin = String(body); } },
      unref() {},
      once(event, handler) { if (event === 'exit') spawns[spawns.length - 1].onExit = handler; },
    };
    return child;
  };
  const realPrivacy = sourceRequire('./privacy-guard');
  // promisify(execFile) 依赖真实 execFile 的 custom promisify 符号产出 {stdout,stderr}：
  // 替身必须带上同一符号，否则 remoteMainHead 拿到裸字符串。
  const customPromisify = Symbol.for('nodejs.util.promisify.custom');
  const fakeExecFile = (cmd, args, opts, cb) => {
    if (cmd === 'git' && args[0] === 'ls-remote') { cb(null, `${git.remoteMain}\trefs/heads/main\n`, ''); return; }
    if (cmd === 'git' && args[0] === 'push') {
      if (git.pushOk) { git.remoteMain = git.head; cb(null, '', ''); } else cb(new Error('push rejected'), '', 'push rejected');
      return;
    }
    if (cmd === 'git' && args[0] === 'revert') { feedback.events.push('revert'); git.head = REVERT; cb(null, '', ''); return; }
    cb(new Error(`Unexpected execFile: ${cmd} ${(args || []).join(' ')}`));
  };
  fakeExecFile[customPromisify] = (cmd, args, opts) => new Promise((resolve, reject) => {
    fakeExecFile(cmd, args, opts, (error, stdout, stderr) => {
      if (error) reject(Object.assign(error, { stdout, stderr }));
      else resolve({ stdout, stderr });
    });
  });
  const module = { exports: {} };
  const context = vm.createContext({
    module, exports: module.exports, __dirname: path.dirname(SOURCE_FILE), __filename: SOURCE_FILE,
    Buffer, Date: Clock, URL, console, crypto, process,
    require: (name) => {
      if (name === './evolution-github-feedback') {
        return {
          captureFeedbackBatch: (...args) => { feedback.captured.push(args); return feedback.batch; },
          summarizeBatch: batch => { feedback.summarized.push(batch); return feedback.summary; },
          buildGithubFeedbackSection: batch => (batch ? feedback.section : ''),
          handlePublishedEvolution: payload => { feedback.published.push(payload); return Promise.resolve({ ok: true, enqueued: 0 }); },
          holdGithubFeedbackForRevision: payload => {
            feedback.holds.push(payload);
            feedback.events.push('hold');
            return Promise.resolve({ ok: true, heldCount: 1 });
          },
          startGithubFeedbackCollector: (...args) => { feedback.collectors.push(args); return { ok: true, started: true }; },
          stopGithubFeedbackCollector: () => {},
        };
      }
      if (name === '../config/runtime-paths') return { getDataFile: file => path.join(dataDir, file) };
      if (name === './logger') return { createModuleLogger: () => logger };
      if (name === './scheduler') return { createScheduler: () => fakeScheduler, getSchedulerRegistrySnapshot: () => [] };
      if (name === './feishu-notify') return { sendFeishuText: async () => {}, isFeishuWebhook: () => false };
      if (name === './privacy-guard') return { ...realPrivacy, auditGitRange: () => ({ ok: true, findings: [] }) };
      if (name === 'node:child_process') {
        spawns.push({ bin: '', args: null, stdin: '', onExit: null });
        return {
          ...childProcess,
          execSync: command => (command.startsWith('git status') ? git.dirty : `${git.head}\n`),
          execFileSync: (cmd, args) => {
            if (cmd === 'git' && args[0] === 'rev-parse') {
              if (args[1] === 'origin/main') return `${git.remoteMain}\n`;
              if (args[1] === 'HEAD') return `${git.head}\n`;
            }
            if (cmd === 'git' && args[0] === 'show') return '修复 GitHub 反馈启动崩溃\n';
            if (cmd === 'git' && args[0] === 'diff') return '1\t1\tcore/src/example.js\n';
            if (cmd === 'git' && args[0] === 'merge-base') return '';
            if (cmd === 'git' && args[0] === 'reset') { git.head = args[2]; return ''; }
            throw new Error(`Unexpected execFileSync: ${cmd} ${(args || []).join(' ')}`);
          },
          execFile: fakeExecFile,
          spawn: (bin, args) => { spawns[spawns.length - 1].bin = bin; spawns[spawns.length - 1].args = args; return fakeChild(); },
        };
      }
      return sourceRequire(name);
    },
  });
  vm.runInContext(`${fs.readFileSync(SOURCE_FILE, 'utf8')}
module.exports.testAccess = {
    launchEvolution, readState, writeState, startActivityEvolver, finalizeRecoveredEvolution, reviseEvolution,
    configure: value => { deps = value; },
    setRunning: value => { running = value; },
};`, context, { filename: SOURCE_FILE });
  const service = module.exports.testAccess;
  // 调度任务在测试域触发（VM 内看不到本闭包的 tasks）。
  service.runScheduled = name => { const cb = tasks.get(name); if (cb) return cb(); };
  if (options.state) service.writeState(options.state);
  service.configure(options.deps || {});
  return {
    service, dataDir, spawns, messages, git, feedback, tasks,
    readRaw: () => {
      try { return JSON.parse(fs.readFileSync(path.join(dataDir, 'activity-evolve-state.json'), 'utf8')); }
      catch { return null; }
    },
    launch: (task = 'safety', payload = {}) => service.launchEvolution(task, payload),
    completeRun: async function exitWith({ code = 0, signal = '' } = {}) {
      const run = this.spawns.find(item => item.onExit);
      assert.ok(run, '必须先启动 Agent 才能模拟退出');
      const handler = run.onExit;
      run.onExit = null;
      handler(code, signal);
      await waitFor(() => this.readRaw()?.status && this.readRaw().status !== 'running', 'finalize 收口');
      return this.readRaw();
    },
    writeJournal(runId, patch = {}) {
      const file = path.join(this.dataDir, 'logs', `evolve-team-${runId}.json`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({
        runId, baseCommit: HEAD, mainAgent: 'claude', subAgent: 'codex',
        phase: 'complete', status: 'completed', activeAgent: '', head: NEW, decision: 'approve',
        githubResolutions: [{ issue: 2, status: 'fixed', fingerprint: FP, note: '启动崩溃已修复' }],
        ...patch,
      }));
      return file;
    },
  };
}

test('启动即拉起反馈收集器；launchEvolution 同步切批次并把批次小节注入 prompt', async (t) => {
  const f = harness(t, { state: idleState() });
  f.service.startActivityEvolver();
  assert.equal(f.feedback.collectors.length, 1, '进化器启动时启动 GitHub 反馈收集器');

  const launched = f.launch('safety', {});
  assert.equal(launched.ok, true);
  assert.equal(f.feedback.captured.length, 1, '批次在启动路径同步切出（无网络）');
  assert.equal(f.feedback.summarized.length, 1);
  const state = f.readRaw();
  assert.deepEqual(state.githubFeedbackBatch, SUMMARY(), '批次摘要进运行状态（旧实现在此字段缺失）');
  const payload = JSON.parse(f.spawns[0].stdin);
  assert.ok(payload.prompt.includes(SECTION), '反馈小节进入 Agent prompt');
  assert.equal(payload.task, 'safety');
});

test('未启用/无批次时不注入小节也不虚构批次：prompt 与状态保持干净', async (t) => {
  const f = harness(t, { state: idleState(), batch: null, summary: null, section: '' });
  assert.equal(f.launch('safety', {}).ok, true);
  assert.equal(f.readRaw().githubFeedbackBatch, null);
  const payload = JSON.parse(f.spawns[0].stdin);
  assert.equal(payload.prompt.includes('【GitHub 反馈 issue 批次'), false);
});

test('finalize pending_apply（双 Agent）：exact 批次摘要 + 已发布提交 + journal 映射一起进收口', async (t) => {
  const f = harness(t, { state: idleState() });
  f.launch('safety', {});
  const runId = f.readRaw().activeRun.runId;
  // Agent 完成：产生提交 + 主 Agent approve journal（含 fixed 指纹映射）。
  f.git.head = NEW;
  f.writeJournal(runId);
  const state = await f.completeRun({ code: 0 });
  assert.equal(state.status, 'pending_apply');
  assert.equal(state.commit, NEW);
  await waitFor(() => f.feedback.published.length > 0, 'handlePublishedEvolution 异步收口');
  const published = f.feedback.published[0];
  assert.equal(published.status, 'pending_apply');
  assert.equal(published.commit, NEW, '用实际发布的提交收口，不预测哈希');
  assert.equal(published.dualAgentEnabled, true);
  assert.equal(published.mainAgent, 'claude');
  assert.deepEqual(JSON.parse(JSON.stringify(published.batchSummary)), SUMMARY(), '收口批次必须与启动时切出的不可变批次一致');
  assert.deepEqual(published.journal.githubResolutions, [{ issue: 2, status: 'fixed', fingerprint: FP, note: '启动崩溃已修复' }]);
  assert.match(published.changeSummary, /修复 GitHub 反馈启动崩溃/);
  // 重复 finalize 不二次收口。
  await f.completeRun({ code: 0 }).catch(() => null);
  assert.equal(f.feedback.published.length, 1);
});

test('no_change / interrupted / push_failed / repairOnly 一律不回复 issue', async (t) => {
  // no_change：无提交、退出 0（单 Agent，无 journal 需求）。
  const noChange = harness(t, { state: idleState({ dualAgentEnabled: false }) });
  noChange.launch('safety', {});
  const noChangeState = await noChange.completeRun({ code: 0 });
  assert.equal(noChangeState.status, 'no_change');
  assert.equal(noChange.feedback.published.length, 0);

  // interrupted：信号中止，无提交。
  const interrupted = harness(t, { state: idleState({ dualAgentEnabled: false }) });
  interrupted.launch('safety', {});
  const interruptedState = await interrupted.completeRun({ code: null, signal: 'SIGTERM' });
  assert.equal(interruptedState.status, 'interrupted');
  assert.equal(interrupted.feedback.published.length, 0);

  // push_failed：有提交但推送失败 → 不回复；自动重推成功后按 pending_apply 收口。
  const pushFailed = harness(t, { state: idleState({ dualAgentEnabled: false }), git: { pushOk: false } });
  pushFailed.launch('safety', {});
  const runId = pushFailed.readRaw().activeRun.runId;
  pushFailed.git.head = NEW;
  const failedState = await pushFailed.completeRun({ code: 0 });
  assert.equal(failedState.status, 'push_failed');
  assert.equal(pushFailed.feedback.published.length, 0, '未发布绝不回复 issue');
  assert.ok(pushFailed.tasks.has('github_push_retry'), '推送失败调度自动重推');

  pushFailed.git.pushOk = true; // 网络恢复
  pushFailed.git.remoteMain = HEAD; // 重推前远端仍是旧头
  await pushFailed.service.runScheduled('github_push_retry');
  await waitFor(() => pushFailed.readRaw().status === 'pending_apply', '重推收口');
  await waitFor(() => pushFailed.feedback.published.length > 0, '重推成功后进入反馈收口');
  assert.equal(pushFailed.feedback.published[0].commit, NEW);
  assert.equal(pushFailed.feedback.published[0].batchSummary.fingerprint, FP);
  void runId;

  // repairOnly：编排修复轮即使 pending_apply 也不带原巡检结论，不回复。
  const repairOnly = harness(t, { state: idleState() });
  repairOnly.launch('safety', {});
  const repairRunId = repairOnly.readRaw().activeRun.runId;
  repairOnly.git.head = NEW;
  repairOnly.writeJournal(repairRunId, { repairOnly: true, githubResolutions: [] });
  const repairState = await repairOnly.completeRun({ code: 0 });
  assert.equal(repairState.status, 'pending_apply');
  assert.match(repairState.summary, /编排故障修复/);
  assert.equal(repairOnly.feedback.published.length, 0, 'repairOnly 没有原巡检结论，不回复 issue');
});

test('finalizeRecoveredEvolution：主进程重启恢复的已发布提交同样进入反馈收口', async (t) => {
  const state = idleState({
    status: 'running',
    githubFeedbackBatch: SUMMARY(),
    activeRun: {
      runId: 'recovered-run', task: 'safety', agent: 'claude', dualAgentEnabled: false,
      subAgent: '', pid: 1234, launchedAt: NOW - 60000, baseCommit: HEAD,
      logFile: '/tmp/none.log', combinedDaily: false, evidenceFingerprint: '',
    },
  });
  const f = harness(t, { state });
  f.git.head = NEW;
  await f.service.finalizeRecoveredEvolution(f.readRaw().activeRun, 'parent_restart');
  await waitFor(() => f.feedback.published.length > 0, '恢复收口进入反馈回复链路');
  const published = f.feedback.published[0];
  assert.equal(published.status, 'pending_apply');
  assert.equal(published.commit, NEW);
  assert.deepEqual(JSON.parse(JSON.stringify(published.batchSummary)), SUMMARY());
  assert.equal(f.readRaw().status, 'pending_apply');
});

test('启动恢复：已发布的 pending_apply 在重启后幂等补做反馈收口', async (t) => {
  // 进程死在「pending_apply 已落盘、反馈尚未入队」边界：重启必须补收口，不丢回复。
  const journal = {
    runId: 'resume-run', baseCommit: HEAD, mainAgent: 'claude', subAgent: 'codex',
    phase: 'complete', status: 'completed', activeAgent: '', head: NEW, decision: 'approve',
    githubResolutions: [{ issue: 2, status: 'fixed', fingerprint: FP, note: '启动崩溃已修复' }],
  };
  const state = idleState({
    status: 'pending_apply', commit: NEW, githubFeedbackBatch: SUMMARY(), collaboration: journal,
  });
  const f = harness(t, { state });
  assert.equal(f.service.readState().githubFeedbackBatch.payloadDigest, PAYLOAD_DIGEST, '真实状态读取保留已持久化的载荷摘要');
  f.service.startActivityEvolver();
  await waitFor(() => f.feedback.published.length > 0, '启动恢复补已发布完成的收口');
  const published = f.feedback.published[0];
  assert.equal(published.status, 'pending_apply');
  assert.equal(published.commit, NEW, '按实际已发布提交收口');
  assert.equal(published.dualAgentEnabled, true);
  assert.equal(published.mainAgent, 'claude');
  assert.deepEqual(JSON.parse(JSON.stringify(published.batchSummary)), SUMMARY());
  assert.equal(f.readRaw().githubFeedbackBatch.payloadDigest, PAYLOAD_DIGEST, '启动重新落盘后摘要仍完整');
  assert.equal(published.journal.githubResolutions[0].fingerprint, FP);
  // 重启不触发新的进化运行：无 Agent 进程被拉起。
  assert.equal(f.spawns.filter(spawn => spawn.onExit || spawn.args).length, 0, '恢复路径零 Agent 进程');
});

test('push_failed 自愈成功同样补反馈收口（同一发布边界）', async (t) => {
  const journal = {
    runId: 'heal-run', baseCommit: HEAD, mainAgent: 'claude', subAgent: 'codex',
    phase: 'complete', status: 'completed', activeAgent: '', head: NEW, decision: 'approve',
    githubResolutions: [{ issue: 2, status: 'fixed', fingerprint: FP }],
  };
  const state = idleState({
    status: 'push_failed', commit: NEW, githubFeedbackBatch: SUMMARY(), collaboration: journal,
  });
  const f = harness(t, { state, git: { head: NEW, remoteMain: HEAD } });
  assert.equal(f.service.readState().githubFeedbackBatch.payloadDigest, PAYLOAD_DIGEST, '自愈前从真实持久化状态读取载荷摘要');
  f.launch('safety', {});
  await waitFor(() => f.readRaw().status === 'pending_apply' && f.feedback.published.length > 0, '自愈推送成功后补收口');
  const published = f.feedback.published[0];
  assert.equal(published.commit, NEW);
  assert.deepEqual(JSON.parse(JSON.stringify(published.batchSummary)), SUMMARY());
  assert.equal(f.readRaw().githubFeedbackBatch.payloadDigest, PAYLOAD_DIGEST, '自愈收口重新落盘后摘要不丢失');
});

test('真实状态归一化：非法载荷摘要不能变成有效发布证据', (t) => {
  const f = harness(t, { state: idleState({ githubFeedbackBatch: { ...SUMMARY(), payloadDigest: 'invalid-digest' } }) });
  assert.equal(f.service.readState().githubFeedbackBatch.payloadDigest, '', '非法摘要保持无效，不生成授权摘要');
});

test('启动恢复只补有效发布：失败/未发布/未批准/repairOnly 一律不收口', async (t) => {
  const journal = {
    runId: 'bad-run', baseCommit: HEAD, mainAgent: 'claude', subAgent: 'codex',
    phase: 'complete', status: 'completed', activeAgent: '', head: NEW, decision: 'approve',
    githubResolutions: [{ issue: 2, status: 'fixed', fingerprint: FP }],
  };
  const cases = [
    { name: 'failed 状态', state: idleState({ status: 'failed', commit: NEW, githubFeedbackBatch: SUMMARY(), collaboration: journal }) },
    { name: '无提交', state: idleState({ status: 'pending_apply', commit: '', githubFeedbackBatch: SUMMARY(), collaboration: journal }) },
    { name: '无批次摘要', state: idleState({ status: 'pending_apply', commit: NEW, githubFeedbackBatch: null, collaboration: journal }) },
    { name: 'journal 未批准（head 不符）', state: idleState({ status: 'pending_apply', commit: NEW, githubFeedbackBatch: SUMMARY(), collaboration: { ...journal, head: 'f'.repeat(40) } }) },
    { name: 'repairOnly 轮', state: idleState({ status: 'pending_apply', commit: NEW, githubFeedbackBatch: SUMMARY(), collaboration: { ...journal, repairOnly: true } }) },
  ];
  for (const item of cases) {
    const f = harness(t, { state: item.state });
    f.service.startActivityEvolver();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.feedback.published.length, 0, `${item.name}：不伪造收口`);
  }
});

test('owner 拒绝边界：hold 先于 revert/push 扣下发件箱条目，重做期间零公开回复', async (t) => {
  // pending_apply 的已发布提交被 owner 拒绝：在被等待的 git revert/push 之前必须先
  // 扣下发件箱里该提交的未发送条目，否则远端 main 仍指向旧修复的窗口期内排空循环
  // 会把「已修复」评论发出去。
  const state = idleState({ status: 'pending_apply', commit: NEW, githubFeedbackBatch: SUMMARY() });
  const f = harness(t, { state, git: { head: NEW, remoteMain: NEW } });
  const result = await f.service.reviseEvolution('修复不彻底，按新要求重做');
  assert.equal(result.ok, true, `拒绝重做应成功：${result.error || ''}`);
  assert.equal(JSON.stringify(f.feedback.holds), JSON.stringify([{ commit: NEW, reason: 'owner_reverting' }]),
    '拒绝边界先扣留被拒提交的未发送反馈条目');
  assert.equal(f.feedback.events[0], 'hold', '扣留必须发生在任何 revert/push 之前');
  assert.ok(f.feedback.events.indexOf('revert') > f.feedback.events.indexOf('hold'), 'revert 在扣留之后');
  assert.equal(f.feedback.published.length, 0, '回退/重做期间零公开回复');
  assert.equal(f.git.remoteMain, REVERT, '回退提交已推送远端');
  const finalState = f.readRaw();
  assert.ok(['rejected', 'running', 'revision_failed'].includes(finalState.status),
    `收口状态异常：${finalState.status}`);
});
