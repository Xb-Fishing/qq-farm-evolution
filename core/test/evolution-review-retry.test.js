'use strict';
// review_blocked 人工重试出口回归（2026-09-26 死锁修复）：真实 activity-evolver 源码在
// 私有 VM 中执行，只替换外部效果（时钟、git、Agent spawn、调度、日志）；状态持久化、
// 名额语义、BLOCKING_STATUSES 守卫、combinedDaily payload 构造全部走真实代码。
// 不启动外部 Agent、不做真实 git 操作、不发游戏请求。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

const importDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farm-review-retry-import-'));
process.env.FARM_DATA_DIR = importDataDir;
process.env.FARM_PRIVATE_CONFIG_FILE = path.join(importDataDir, 'private-config.json');
test.after(() => fs.rmSync(importDataDir, { recursive: true, force: true }));

const SOURCE_FILE = path.join(__dirname, '../src/services/activity-evolver.js');
const sourceRequire = createRequire(SOURCE_FILE);
const NOW = Date.parse('2026-09-26T03:00:00Z');
const HEAD = 'b7efdf35'.padEnd(40, '0').slice(0, 40);
const ORIGIN = HEAD;

const REVIEW_BLOCKED_BASE = () => ({
  status: 'review_blocked',
  dualAgentEnabled: true,
  mainAgent: 'claude',
  subAgent: 'codex',
  lastTask: 'safety',
  lastAutomaticEvolveDate: '2026-09-26',
  commit: '',
  privacyBlockedCommit: '',
  logFile: '/tmp/evolve-safety-claude-2026-09-26.log',
  summary: '安全巡检未完成：主 Agent 最终复核阶段：共享树在只读 plan 期间发生并行变化，验收阻断',
  collaboration: {
    phase: 'failed',
    status: 'failed',
    activeAgent: 'claude',
    failure: { code: 'readonly_changed', label: '只读阶段修改了工作树', phase: 'plan', agent: 'claude' },
    reviewFeedback: 'plan 阶段声明只读但工作树被改',
  },
  evolutionMemory: {
    safety: { reviewedAt: 0, reviewedHead: '' },
    activity: { reviewedAt: 0, reviewedHead: '', evidenceFingerprint: '' },
  },
});

const REPORT = () => ({
  status: 'up-to-date',
  unknownActivityIds: [],
  endedActivityIds: [],
  online: {
    available: true,
    checkedActivityIds: [2026090100, 2026090900, 2026092400],
    groups: [{ id: 2026090100, title: '萌宠赛季' }],
    activities: [],
    seedRecognition: { available: true, issues: [] },
  },
});

function harness(t, options = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farm-review-retry-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const git = { head: HEAD, originMain: ORIGIN, dirty: '', ...options.git };
  const clock = { now: NOW };
  const launches = [];
  const spawns = [];
  const messages = [];
  const report = 'report' in options ? options.report : REPORT();
  if (report) {
    fs.mkdirSync(path.dirname(path.join(dataDir, 'activity-update-report.json')), { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'activity-update-report.json'), JSON.stringify(report));
  }
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [clock.now])); }
    static now() { return clock.now; }
  }
  const fakeScheduler = {
    setTimeoutTask: () => {},
    clear: () => {},
    clearAll: () => {},
  };
  const logger = { info: m => messages.push(m), warn: m => messages.push(m), error: m => messages.push(m) };
  const childProcess = sourceRequire('node:child_process');
  const fakeChild = () => ({
    pid: 4321,
    stdin: { on() {}, end(body) { spawns[spawns.length - 1].stdin = String(body); } },
    unref() {},
    once() {},
  });
  const module = { exports: {} };
  const context = vm.createContext({
    module, exports: module.exports, __dirname: path.dirname(SOURCE_FILE), __filename: SOURCE_FILE,
    Buffer, Date: Clock, URL, console, crypto, process,
    require: (name) => {
      if (name === '../config/runtime-paths') return { getDataFile: file => path.join(dataDir, file) };
      if (name === './logger') return { createModuleLogger: () => logger };
      if (name === './scheduler') return { createScheduler: () => fakeScheduler, getSchedulerRegistrySnapshot: () => [] };
      if (name === './feishu-notify') return { sendFeishuText: async () => {}, isFeishuWebhook: () => false };
      if (name === 'node:child_process') {
        spawns.push({ bin: '', args: null });
        return {
          ...childProcess,
          execSync: command => (command.startsWith('git status') ? git.dirty : git.head),
          execFileSync: (cmd, args) => {
            if (cmd === 'git' && args[0] === 'rev-parse') {
              if (args[1] === 'origin/main') return `${git.originMain}\n`;
              if (args[1] === 'HEAD') return `${git.head}\n`;
            }
            // launch 信任脏树门走 worktreeChangeFiles（porcelain -z / NUL 分隔）：
            // 与 execSync 的可读 porcelain 同源，这里按 -z 约定转换。
            if (cmd === 'git' && args[0] === 'status') {
              return git.dirty ? `${git.dirty.split('\n').join('\0')}\0` : '';
            }
            throw new Error(`Unexpected execFileSync: ${cmd} ${args && args.join(' ')}`);
          },
          spawn: (bin, args) => { spawns[spawns.length - 1].bin = bin; spawns[spawns.length - 1].args = args; return fakeChild(); },
        };
      }
      return sourceRequire(name);
    },
  });
  vm.runInContext(`${fs.readFileSync(SOURCE_FILE, 'utf8')}
module.exports.testAccess = {
    retryReviewBlockedEvolution, launchEvolution, readState, writeState,
    configure: value => { deps = value; },
    setRunning: value => { running = value; },
};`, context, { filename: SOURCE_FILE });
  const service = module.exports.testAccess;
  if (options.state) service.writeState(options.state);
  service.configure(options.deps || {});
  return { service, dataDir, launches, spawns, messages, git, readRaw: () => {
    try { return JSON.parse(fs.readFileSync(path.join(dataDir, 'activity-evolve-state.json'), 'utf8')); }
    catch { return null; }
  } };
}

test('review_blocked 且干净同步：真实 launchEvolution 启动新轮综合巡检', (t) => {
  const f = harness(t, { state: REVIEW_BLOCKED_BASE() });
  const result = f.service.retryReviewBlockedEvolution();
  assert.equal(result.ok, true);
  const state = f.service.readState();
  assert.equal(state.status, 'running');
  assert.equal(state.lastTask, 'safety');
  // 旧失败只归档，不进 recover；新轮从 research 重新开始
  assert.equal(state.collaboration.phase, 'research');
  assert.equal(state.lastReviewBlockedFailure.code, 'readonly_changed');
  assert.equal(state.lastReviewBlockedFailure.phase, 'plan');
  assert.equal(state.lastReviewBlockedFailure.reviewFeedback, 'plan 阶段声明只读但工作树被改');
  assert.match(state.lastReviewBlockedFailure.summary, /验收阻断/);
  assert.ok(state.lastReviewBlockedFailure.logFile, '归档保留日志定位');
  // 自动名额语义保留：已消费不动，也不额外消费；手动日期按手动轮记录
  assert.equal(state.lastAutomaticEvolveDate, '2026-09-26');
  assert.equal(state.lastManualRunDate, '2026-09-26');
  // 反馈不清理：无反馈事件时水位为空是真实语义；学习回执清空待新审批
  assert.equal(state.feedbackCleanupPending, false);
  assert.equal(state.learningReceipt, '');
  // 双 Agent 编排入口收到 initialFailure=null：旧 readonly_changed 不送入 recover
  assert.equal(f.spawns.length, 1);
  const payload = JSON.parse(f.spawns[0].stdin);
  assert.equal(payload.initialFailure, null);
  assert.equal(payload.task, 'safety');
  assert.ok(payload.prompt.includes('缓存活动增量上下文'));
  assert.ok(payload.prompt.includes('2026090100'), '当前活动根进入复核上下文');
});

test('cached report 的活动增量覆盖当前活动根 reviewIds，无报告时如实记录不可用', (t) => {
  const withPlan = harness(t, {
    state: REVIEW_BLOCKED_BASE(),
    deps: { launchEvolution: (task, payload) => { f.launches.push({ task, payload }); return { ok: true }; } },
  });
  const f = withPlan;
  f.service.retryReviewBlockedEvolution();
  assert.deepEqual(f.launches.map(l => l.task), ['safety']);
  const payload = f.launches[0].payload;
  assert.equal(payload.manualReviewRetry, true);
  assert.equal(payload.combinedDaily, true);
  assert.notEqual(payload.automatic, true, '重试轮不消费自动名额');
  assert.deepEqual(JSON.parse(JSON.stringify(payload.activityPlan.reviewIds)), [2026090100, 2026090900, 2026092400]);
  assert.ok(payload.report);

  const noReport = harness(t, {
    state: REVIEW_BLOCKED_BASE(),
    report: null,
    deps: { launchEvolution: (task, payload) => { noReport.launches.push({ task, payload }); return { ok: true }; } },
  });
  noReport.service.retryReviewBlockedEvolution();
  const retry = noReport.launches[0].payload;
  assert.equal(retry.report, null);
  assert.equal(retry.activityPlan, null);
  assert.equal(noReport.service.readState().evolutionMemory.activity.reviewedAt, 0, '不得伪造活动已审时间');
});

test('前置失败只拒绝不改状态：dirty / 未同步 / 缺 origin / 待审候选 / 其它状态', (t) => {
  const cases = [
    { name: 'dirty', git: { dirty: '?? core/tmp.txt\n M web/src/x.vue' } },
    { name: 'unsynced', git: { originMain: 'f'.repeat(40) } },
    { name: 'missing_origin', git: { originMain: '' } },
    { name: 'candidate_commit', state: { ...REVIEW_BLOCKED_BASE(), commit: HEAD } },
    { name: 'candidate_privacy', state: { ...REVIEW_BLOCKED_BASE(), privacyBlockedCommit: HEAD } },
    { name: 'pending_apply', state: { ...REVIEW_BLOCKED_BASE(), status: 'pending_apply', commit: HEAD } },
    { name: 'push_failed', state: { ...REVIEW_BLOCKED_BASE(), status: 'push_failed' } },
    { name: 'running_status', state: { ...REVIEW_BLOCKED_BASE(), status: 'running' } },
    { name: 'idle', state: { ...REVIEW_BLOCKED_BASE(), status: 'idle' } },
  ];
  for (const item of cases) {
    const f = harness(t, { git: item.git, state: item.state });
    const before = f.readRaw();
    const result = f.service.retryReviewBlockedEvolution();
    assert.equal(result.ok, false, item.name);
    assert.ok(result.error, item.name);
    assert.deepEqual(f.readRaw(), before, `${item.name}: 拒绝路径不得写状态`);
    assert.equal(f.spawns.filter(s => s.bin).length, 0, `${item.name}: 不得启动 Agent`);
  }
});

test('并发防重：running 期间第二次重试直接 busy，不重复启动', (t) => {
  const f = harness(t, { state: REVIEW_BLOCKED_BASE() });
  assert.equal(f.service.retryReviewBlockedEvolution().ok, true);
  const again = f.service.retryReviewBlockedEvolution();
  assert.equal(again.ok, false);
  assert.equal(again.reason, 'busy');
  assert.equal(f.spawns.length, 1);
});

test('BLOCKING_STATUSES 守卫不变：不带 manualReviewRetry 的任何调用仍被 review_blocked 拦截', (t) => {
  const blocked = harness(t, { state: REVIEW_BLOCKED_BASE() });
  for (const payload of [{}, { combinedDaily: true }, { automatic: true }, { manualReviewRetry: false }]) {
    const result = blocked.service.launchEvolution('safety', payload);
    assert.equal(result.ok, false, JSON.stringify(payload));
    assert.equal(result.reason, 'blocked');
  }
  assert.equal(blocked.service.readState().status, 'review_blocked');
  assert.equal(blocked.spawns.filter(s => s.bin).length, 0);

  // manualReviewRetry 也放不开其它阻断状态（如 pending_apply）
  const pending = harness(t, { state: { ...REVIEW_BLOCKED_BASE(), status: 'pending_apply', commit: HEAD } });
  const result = pending.service.launchEvolution('safety', { manualReviewRetry: true });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'blocked');
  assert.equal(pending.spawns.filter(s => s.bin).length, 0);
});

test('重试路径仍走启动硬门：工作区变脏时按既有语义延期，不伪称通过', (t) => {
  const f = harness(t, { state: REVIEW_BLOCKED_BASE() });
  f.git.dirty = 'M core/src/x.js';
  const result = f.service.launchEvolution('safety', { manualReviewRetry: true, combinedDaily: true });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'deferred');
  const state = f.service.readState();
  assert.equal(state.status, 'deferred');
  assert.equal(f.spawns.filter(s => s.bin).length, 0);
});

test('指纹相同（shouldRun=false）时显式重试仍注入活动复核，且归档不被重复失败启动清空', (t) => {
  const realEvolver = require('../src/services/activity-evolver');
  // 活动指纹与上次已审一致、无新增/结束、无路径变化：常规每日计划 shouldRun=false
  const fingerprint = realEvolver.activityEvidenceFingerprint(REPORT());
  const state = {
    ...REVIEW_BLOCKED_BASE(),
    evolutionMemory: {
      safety: { reviewedAt: 0, reviewedHead: '' },
      activity: { reviewedAt: NOW - 3600_000, reviewedHead: HEAD, evidenceFingerprint: fingerprint },
    },
  };
  const launches = [];
  let launchResult = { ok: true };
  const f = harness(t, {
    state,
    deps: {
      launchEvolution: (task, payload) => { launches.push({ task, payload }); return launchResult; },
    },
  });
  // 第一次重试启动失败（如 CLI 缺失）：状态、collaboration、归档全部保留
  launchResult = { ok: false, reason: 'missing_cli', error: '找不到 CLI' };
  const failed = f.service.retryReviewBlockedEvolution();
  assert.equal(failed.ok, false);
  const afterFail = f.service.readState();
  assert.equal(afterFail.status, 'review_blocked');
  assert.equal(afterFail.collaboration.failure.code, 'readonly_changed');
  assert.equal(afterFail.collaboration.reviewFeedback, 'plan 阶段声明只读但工作树被改');
  assert.equal(afterFail.lastReviewBlockedFailure.code, 'readonly_changed', '启动失败不覆盖归档');

  // 第二次重试成功：指纹未变也必须包含当前活动根复核
  launchResult = { ok: true };
  assert.equal(f.service.retryReviewBlockedEvolution().ok, true);
  const payload = launches.at(-1).payload;
  assert.deepEqual(JSON.parse(JSON.stringify(payload.activityPlan.reviewIds)), [2026090100, 2026090900, 2026092400]);
  assert.equal(payload.activityPlan.shouldRun, true, '下游 shouldRun 与显式复核口径一致');
  assert.equal(payload.activityPlan.evidenceChanged, false, '不伪造指纹变化');
  // 上下文构建与收口结算不吃 shouldRun=false 的哑弹：复核 ID 与结算口径都覆盖
  const context = realEvolver.buildCachedActivityContext({ activityPlan: payload.activityPlan, reportAvailable: true });
  assert.match(context, /需复核的已登记活动 ID：2026090100、2026090900、2026092400/);
  const settled = realEvolver.settleCombinedActivityMemory(
    { handledUnknownIds: [], handledEndedIds: [], pendingActivity: null, evolutionMemory: state.evolutionMemory },
    { newUnknown: [], newEnded: [], fingerprint, head: HEAD },
  );
  assert.equal(settled.evolutionMemory.activity.evidenceFingerprint, fingerprint);
  assert.ok(settled.evolutionMemory.activity.reviewedAt > state.evolutionMemory.activity.reviewedAt);
});
