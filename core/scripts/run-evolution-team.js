/** Detached coordinator. Children share its process group so the existing watchdog owns the whole run. */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const { buildEvolutionAgentCommand, buildEvolutionAgentEnv } = require('../src/services/activity-evolver');
const { collectRuntimePrivacyTerms } = require('../src/services/privacy-guard');
const { runEvolutionValidation } = require('../src/services/evolution-validation');
const { runBaselineChecks } = require('../src/services/evolution-countercheck');
const { collectPublicReferences } = require('../src/services/evolution-references');
const {
  parseStageResult, teamJournalPath, buildStageSchema,
  createTeamError, normalizeTeamFailure, normalizeOrchestrationFiles, safeReviewFeedback,
  normalizeCheckpoint,
} = require('../src/services/evolution-team');
const { buildFreshHandoffContext } = require('../src/services/evolution-sessions');
const { runMainOwnedWorkflow } = require('../src/services/evolution-main-workflow');
const { collectProcesses, isDescendantOf, processStarttime, aliveNonZombie, signalGuarded } = require('./evolution-apply-process');

const repoRoot = path.resolve(__dirname, '../..');

// 阶段所有权由 evolution-team.js 的 workflow 内部决定（与 provider 无关：主/子
// 允许同为 claude 或同为 codex）；fresh 政策下 runner 不再维护阶段→角色映射。

// 私有交接文档（owner 本地 git exclude 忽略，永不入库）。协调进程必须在
// 运行开始时独立于 Git 记录它的存在/非空/内容哈希（只记哈希不记内容），
// 验证时以"本地非空且与开始时相比真实变更"作为交接证据——修复此前只看
// git 差异列表导致 ignored HANDOFF 永远 missing_handoff 的误判。
const HANDOFF_FILE = 'docs/HANDOFF.md';

function isGitIgnored(file, root = repoRoot) {
  try {
    // check-ignore 退出码：0=被忽略（含 .git/info/exclude），1=未忽略。
    // --no-index：即使文件被强制 add 进了索引，也仍按忽略模式判定——被
    // 暂存的私有 HANDOFF 不能因此伪装成"可见文档"绕过私有保护。
    execFileSync('git', ['check-ignore', '--no-index', '--', file], {
      cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    });
    return true;
  } catch (error) {
    // 只认退出码 1（确实未被忽略）；128/其他状态码/无法执行 = 环境不可信。
    if (error && error.status === 1) return false;
    throw createTeamError('unsafe_worktree');
  }
}

/** 运行开始快照：ignored 标记 + 非空内容哈希；不可读/非普通文件一律拒绝。 */
function snapshotPrivateHandoff(root = repoRoot) {
  const snapshot = { ignored: isGitIgnored(HANDOFF_FILE, root), sha256: null };
  const full = path.join(root, HANDOFF_FILE);
  let stat;
  try { stat = fs.lstatSync(full); }
  catch (error) { if (error.code !== 'ENOENT') throw createTeamError('unsafe_worktree'); }
  if (stat) {
    if (stat.isSymbolicLink()) {
      try {
        const common = execFileSync('git', ['rev-parse', '--git-common-dir'], {
          cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
        const ownerRoot = path.dirname(fs.realpathSync(path.resolve(root, common)));
        const canonical = path.join(ownerRoot, HANDOFF_FILE);
        if (!snapshot.ignored || !fs.lstatSync(canonical).isFile()
          || fs.realpathSync(full) !== fs.realpathSync(canonical)) throw createTeamError('unsafe_worktree');
        stat = fs.statSync(full);
      } catch { throw createTeamError('unsafe_worktree'); }
    }
    if (!stat.isFile()) throw createTeamError('unsafe_worktree');
    try {
      const content = fs.readFileSync(full);
      if (content.length > 0) snapshot.sha256 = crypto.createHash('sha256').update(content).digest('hex');
    } catch { throw createTeamError('unsafe_worktree'); }
  }
  return snapshot;
}

/**
 * ignored HANDOFF 的交接证据：当前必须存在、可读、非空，且内容哈希与运行
 * 开始时不同（开始时缺失、现在非空也算真实更新）。被 git 跟踪/可见的
 * HANDOFF 仍走 git 差异列表语义，不进入本判定。
 */
function privateHandoffUpdated(baseline) {
  if (!baseline.ignored) return false;
  const current = snapshotPrivateHandoff();
  return !!current.sha256 && current.sha256 !== baseline.sha256;
}

/**
 * 运行中途忽略状态复核：verify 与 commit 各自重新快照，baseline 的
 * ignored 标记不得漂移（双向）。被忽略的私有文档中途变「可见」= 有人改了
 * exclude/ignore 规则或动过索引（绕私有保护的常见手法）；原本可见的文档
 * 中途变「被忽略」= 想借忽略规则把文档从提交面里藏掉。两者都判不安全。
 */
function assertHandoffVisibilityStable(baseline) {
  if (snapshotPrivateHandoff().ignored !== baseline.ignored) {
    throw createTeamError('unsafe_worktree');
  }
}

const ORCHESTRATION_FILES = new Set([
  'core/scripts/run-evolution-team.js', 'core/src/services/evolution-team.js',
]);
// 隐私控制与 hooks 只能人工审阅修改；编排文件另需主 Agent 验收列入 reviewedOrchestrationFiles。
const PROTECTED_FILES = new Set([
  'core/src/services/evolution-github-issue-review.js',
  'core/src/services/evolution-main-workflow.js', 'core/src/services/evolution-main-mcp.js',
  'core/scripts/run-evolution-main-mcp.js',
  '.gitignore', 'core/src/services/privacy-guard.js', 'core/src/services/local-privacy-terms.js',
  'core/src/services/private-config.js', 'core/src/services/feishu-notify.js',
  'core/src/services/activity-evolver.js',
    'core/src/services/evolution-countercheck.js', 'core/scripts/countercheck-reporter.cjs',
    'core/src/services/evolution-learning.js', 'core/src/services/evolution-validation.js', 'core/src/services/evolution-references.js',
    'core/src/services/daily-feedback.js', 'core/src/controllers/admin-feedback-routes.js',
    'web/src/utils/daily-feedback.ts',
    // 自主策略与应用进程保护属于审批邻接控制文件，常规 Agent 修复不批。
    'core/src/services/evolution-autonomy.js', 'core/scripts/evolution-apply-process.js',
    // 完整性/审批邻接新 helper（2026-10-07 R6 owner 授权）：与 team 侧保护集合同步。
    'core/src/services/evolution-worktree.js', 'core/src/services/evolution-sessions.js',
    'core/src/services/evolution-publish.js',
]);
const PROTECTED_HOOKS_PREFIX = 'scripts/evolution-hooks/';

function isProtectedFile(file) {
  return PROTECTED_FILES.has(file) || file.startsWith(PROTECTED_HOOKS_PREFIX);
}

function git(args) {
  try {
    return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  } catch {
    // git 报错会带本机绝对路径与配置细节，只保留固定错误类别。
    throw createTeamError('unsafe_worktree');
  }
}

// 工作区实测与逐文件指纹（内容+权限+暂存）与协调进程丢失恢复核验共用同一实现。
const { inspectWorktree: inspectWorktreeAt } = require('../src/services/evolution-worktree');

function inspectWorktree() {
  try {
    return inspectWorktreeAt(repoRoot);
  } catch (error) {
    // 共享模块固定抛 unsafe_worktree；保持既有 createTeamError 类别契约。
    if (error?.code === 'unsafe_worktree') throw createTeamError('unsafe_worktree');
    throw error;
  }
}

function execute(bin, args, options = {}) {
  return executeStreaming(bin, args, { ...options, echo: !options.capture });
}

function trackChildTree(child) {
  const owned = new Map();
  const rootStart = processStarttime(child.pid);
  if (rootStart) owned.set(child.pid, rootStart);
  const capture = () => {
    const table = collectProcesses();
    const anchors = [...owned].filter(([pid, start]) => table.get(pid)?.starttime === start).map(([pid]) => pid);
    for (const [pid, stat] of table) {
      if (anchors.some(anchor => isDescendantOf(pid, anchor, table))) owned.set(pid, stat.starttime);
    }
  };
  capture();
  const timer = setInterval(capture, 250);
  timer.unref();
  const live = () => [...owned].filter(([pid, start]) => aliveNonZombie(pid, start));
  return {
    capture,
    stop: () => clearInterval(timer),
    hasLive: () => live().length > 0,
    async terminate() {
      capture();
      if (!rootStart) return false;
      const started = Date.now();
      // Every signal rechecks the recorded PID/starttime; never signal our shared
      // process group, the coordinator or a sibling Main/worker.
      while (Date.now() - started < 8000) {
        capture();
        const active = live();
        if (!active.length) return true;
        const signal = Date.now() - started >= 3000 ? 'SIGKILL' : 'SIGTERM';
        for (const [pid, start] of active.reverse()) signalGuarded(pid, start, signal);
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      return live().length === 0;
    },
  };
}

// Codex --json 事件流执行：stdout 逐行有界解析（thread.started 携带真实线程 id），
// 不整段缓冲——单条超限事件（真实工具输出可达数 MB）只丢弃该事件本身：丢到下一
// 个换行为止（丢弃期间不保留任何字节，内存恒有界），继续解析后续原生线程 id 与
// 最终输出文件，绝不因此杀进程。原始流只落私有 0600 日志；onLine 异常（会话漂移
// 等）先有界 TERM/KILL 清理自己启动的子进程、等它真实退出后才 reject——调用方
// 释放角色锁时不可能还有旧 Agent 进程在写（不吞掉再当成功）。
function executeStreaming(bin, args, options = {}) {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) { reject(createTeamError('cli_exit', { signal: 'SIGTERM' })); return; }
    let child;
    try {
      child = spawn(bin, args, {
        cwd: options.cwd || repoRoot,
        env: options.env || buildEvolutionAgentEnv(),
        stdio: ['pipe', 'pipe', options.logStderr ? 'pipe' : 'inherit'],
      });
    } catch {
      reject(createTeamError('cli_spawn'));
      return;
    }
    const owned = trackChildTree(child);
    let logFd = null;
    if (options.eventLog) {
      try { logFd = fs.openSync(options.eventLog, 'a', 0o600); } catch { logFd = null; }
    }
    const LINE_CAP = 1024 * 1024;
    let buffer = '';
    let discarding = false;
    let spawnFailed = false;
    let rejected = false;
    let stdout = '';
    let timeout = null;
    let idleTimeout = null;
    const onAbort = () => failLine(createTeamError('cli_exit', { signal: 'SIGTERM' }));
    const cleanup = () => { clearTimeout(timeout); clearTimeout(idleTimeout); owned.stop(); options.signal?.removeEventListener('abort', onAbort); };
    const closeLog = () => { if (logFd != null) { try { fs.closeSync(logFd); } catch {} logFd = null; } };
    const failLine = (error) => {
      if (rejected) return;
      rejected = true;
      // Keep the caller stopped until this CLI and every captured descendant has
      // actually exited; an unproven cleanup blocks the whole candidate.
      void owned.terminate().then(stopped => {
        cleanup();
        closeLog();
        const failure = stopped ? (error?.code ? error : createTeamError('output_parse')) : createTeamError('unsafe_worktree');
        if (options.eventLog) failure.logFile = options.eventLog;
        reject(failure);
      }, () => {
        cleanup(); closeLog();
        reject(Object.assign(createTeamError('unsafe_worktree'), options.eventLog ? { logFile: options.eventLog } : {}));
      });
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.timeoutMs > 0) timeout = setTimeout(() => failLine(createTeamError('cli_exit')), options.timeoutMs);
    const activity = () => {
      clearTimeout(idleTimeout);
      if (options.idleTimeoutMs > 0) idleTimeout = setTimeout(() => failLine(Object.assign(createTeamError('cli_exit'),
        { failureSummary: 'Main produced no output within the idle deadline; repair memory and drafts retained.' })), options.idleTimeoutMs);
    };
    activity();
    if (options.signal?.aborted) onAbort();
    child.stdout.setEncoding('utf8');
    if (options.logStderr && child.stderr) {
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', chunk => {
        activity();
        owned.capture();
        if (logFd != null) { try { fs.writeSync(logFd, chunk); } catch {} }
        process.stderr.write(chunk);
      });
    }
    child.stdout.on('data', (chunk) => {
      activity();
      owned.capture();
      if (options.echo) process.stdout.write(chunk);
      if (options.capture) {
        if (Buffer.byteLength(stdout) + Buffer.byteLength(chunk) > 512 * 1024) { failLine(createTeamError('output_limit')); return; }
        stdout += chunk;
      }
      if (logFd != null) { try { fs.writeSync(logFd, chunk); } catch {} }
      if (rejected) return;
      if (discarding) {
        // 丢弃模式：本块内没有换行就整块丢弃（一个字节都不保留）；遇到换行，其
        // 前的尾段属于超限事件一并丢弃，其后的数据恢复正常解析。
        const newline = chunk.indexOf('\n');
        if (newline < 0) return;
        buffer = chunk.slice(newline + 1);
        discarding = false;
      } else buffer += chunk;
      for (;;) {
        const index = buffer.indexOf('\n');
        if (index < 0) break;
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        // 超限整行（单块内自带换行）只丢弃该行，尾部碎片绝不当作事件解释。
        if (line.length > LINE_CAP) continue;
        if (options.onLine) {
          try { options.onLine(line); } catch (error) { failLine(error); return; }
        }
      }
      if (!discarding && buffer.length > LINE_CAP) {
        // 无换行的部分行已超限：进入丢弃模式，内存保持有界。
        discarding = true;
        buffer = '';
      }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(options.stdin || '');
    child.once('error', () => {
      spawnFailed = true;
      cleanup();
      closeLog();
      reject(createTeamError('cli_spawn'));
    });
    child.once('close', (code, signal) => {
      if (spawnFailed || rejected) return;
      if (code !== 0 || signal) { failLine(createTeamError('cli_exit', { exitCode: code, signal })); return; }
      if (owned.hasLive()) {
        void owned.terminate().then(stopped => {
          cleanup(); closeLog();
          if (stopped) resolve(options.capture ? stdout : undefined);
          else reject(createTeamError('unsafe_worktree'));
        }, () => { cleanup(); closeLog(); reject(createTeamError('unsafe_worktree')); });
      } else { cleanup(); closeLog(); resolve(options.capture ? stdout : undefined); }
    });
  });
}

function readVerificationFailureDetails(file) {
  const decoder = new (require("node:string_decoder").StringDecoder)("utf8");
  const failedTests = [];
  const errors = [];
  const counts = {};
  let failedCount = 0;
  let pending = '';
  const line = text => {
    const failed = text.match(/^\s*not ok \d+ - (.+)/);
    if (failed) { failedCount += 1; if (failedTests.length < 24) failedTests.push(failed[1].slice(0, 400)); }
    if (/error TS\d+|^\s*(?:error:|Error:|code: 'ERR_)/.test(text) && errors.length < 8) errors.push(text.trim().slice(0, 400));
    const count = text.match(/^# (tests|pass|fail|skipped) (\d+)$/);
    if (count) counts[count[1]] = Number(count[2]);
  };
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(64 * 1024);
    for (;;) {
      const size = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (!size) break;
      const lines = (pending + decoder.write(buffer.subarray(0, size))).split('\n');
      pending = lines.pop().slice(-8192);
      for (const text of lines) line(text);
    }
    pending += decoder.end();
    if (pending) line(pending);
  } finally { fs.closeSync(fd); }
  return { counts, failedCount, failedTests, errors };
}

// Claude 外层 envelope 成功时优先 structured_output；result 必须是可严格解析的 JSON 文本。
function claudeStageResponse(stdout) {
  const bytes = Buffer.byteLength(stdout);
  let envelope;
  try { envelope = JSON.parse(stdout); } catch {
    process.stderr.write(`[team] claude envelope invalid bytes=${bytes}\n`);
    throw createTeamError('invalid_envelope');
  }
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) throw createTeamError('invalid_envelope');
  if (envelope.is_error || envelope.subtype !== 'success') throw createTeamError('invalid_output');
  if (envelope.structured_output != null) {
    return typeof envelope.structured_output === 'string'
      ? envelope.structured_output : JSON.stringify(envelope.structured_output);
  }
  return typeof envelope.result === 'string' ? envelope.result : JSON.stringify(envelope.result ?? '');
}

function readTeamStageOutput(outputFile) {
  try {
    return fs.readFileSync(outputFile, 'utf8');
  } catch {
    throw createTeamError('missing_result');
  }
}

// 续接凭据的双侧独立校验之 runner 侧：launcher 的判断不算数，以当前工作区实测为准。
// in_run：基线未动、脏文件全部属于授权 UNION，且脏文件集合与凭据逐文件快照的键集
// 完全一致（不多不少）、逐条内容/权限/暂存哈希一致、整体 worktreeFingerprint 一致
// ——全部以当前实测为准，allowedFiles UNION 只证明"曾经授权过"，不能替代候选快照
// （崩溃中途没有实测落盘的脏树不可信）。干净树 + 空快照是合法续接（内容由 HEAD 钉死）。
// post_apply：树必须干净且补丁提交严格就是当前 HEAD（新进程加载/应用的正是它；
// 只验祖先包含会让未审阅的后代提交借道 post_apply 跳过 research/plan）。
function validateResumeInput(value, baseCommit) {
  const checkpoint = normalizeCheckpoint(value);
  if (!checkpoint) throw createTeamError('invalid_decision');
  const now = inspectWorktree();
  if (now.head !== baseCommit) throw createTeamError('head_changed');
  if (checkpoint.kind === 'post_apply') {
    if (now.dirty) throw createTeamError('unsafe_worktree');
    if (!checkpoint.patchHead || checkpoint.patchHead !== now.head) throw createTeamError('head_changed');
    try { git(['merge-base', '--is-ancestor', checkpoint.baselineHead, now.head]); } catch { throw createTeamError('head_changed'); }
    return checkpoint;
  }
  if (checkpoint.baselineHead !== baseCommit) throw createTeamError('head_changed');
  if (checkpoint.kind === 'in_run' && !checkpoint.completed.length) {
    // 什么都没证明的凭据 = 凭据不完整：拒绝续接，按新轮重跑（research 本来也没完成）。
    throw createTeamError('invalid_decision');
  }
  if (now.files.some(file => !checkpoint.allowedFiles.includes(file))) throw createTeamError('unsafe_worktree');
  const recorded = Object.keys(checkpoint.fileFingerprints).sort();
  if (now.files.length || recorded.length || checkpoint.worktreeFingerprint) {
    const exactShape = recorded.length === now.files.length
      && recorded.every((file, index) => file === now.files[index]);
    if (!exactShape) throw createTeamError('worktree_changed');
    for (const [file, digest] of Object.entries(checkpoint.fileFingerprints)) {
      if (now.fileFingerprints[file] !== digest) throw createTeamError('worktree_changed');
    }
    if (checkpoint.worktreeFingerprint !== now.fingerprint) throw createTeamError('worktree_changed');
  }
  return checkpoint;
}

// 任务身份：task + 原始 prompt 摘要（originalPrompt：续接轮可追加新实时证据，但
// 原始任务的 digest 必须核实）+ 反馈批次水位 + GitHub 批次摘要 + 活动计划摘要 +
// 每日名额日期 + 自动/综合标记。任一字段有记录就不允许悄悄换掉。
function buildTaskIdentity(input) {
  return {
    task: input.task === 'activity' ? 'activity' : 'safety',
    promptDigest: crypto.createHash('sha256')
      .update(String(input.originalPrompt ?? input.prompt ?? '')).digest('hex'),
    feedbackThroughAt: Math.max(0, Math.floor(Number(input.feedbackThroughAt) || 0)),
    activityPlanDigest: /^[0-9a-f]{64}$/.test(String(input.activityPlanDigest || ''))
      ? String(input.activityPlanDigest) : '',
    githubBatchDigest: /^[0-9a-f]{64}$/.test(String(input.githubBatchDigest || ''))
      ? String(input.githubBatchDigest) : '',
    quotaDate: /^\d{4}-\d{2}-\d{2}$/.test(String(input.quotaDate || '')) ? String(input.quotaDate) : '',
    automatic: input.automatic === true,
    combinedDaily: input.combinedDaily === true,
  };
}

function assertTaskIdentityMatches(recorded, current) {
  // 逐字段比对：有记录（非空）就必须一致；全部为空的旧凭据才整体放行（不伪造）。
  const mismatches = [
    recorded.task !== current.task,
    !!recorded.promptDigest && recorded.promptDigest !== current.promptDigest,
    recorded.feedbackThroughAt !== current.feedbackThroughAt,
    !!recorded.activityPlanDigest && recorded.activityPlanDigest !== current.activityPlanDigest,
    !!recorded.githubBatchDigest && recorded.githubBatchDigest !== current.githubBatchDigest,
    !!recorded.quotaDate && recorded.quotaDate !== current.quotaDate,
    recorded.automatic !== current.automatic,
    recorded.combinedDaily !== current.combinedDaily,
  ];
  if (mismatches.some(Boolean)) throw createTeamError('invalid_decision');
}

async function main(input) {
  process.umask(0o077);
  const { runId, baseCommit, settings, logDir, bins, prompt, task, dataDir, initialFailure, initialReviewFeedback } = input;
  const journalFile = teamJournalPath(logDir, runId);
  const journal = { runId, baseCommit, mainAgent: settings.mainAgent, subAgent: settings.subAgent,
    orchestration: 'main-owned' };
  const persist = (fields) => {
    Object.assign(journal, fields);
    const temp = `${journalFile}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify(journal)}\n`, { mode: 0o600 });
    fs.renameSync(temp, journalFile);
  };
  const runtimeTerms = collectRuntimePrivacyTerms({ dataDir });
  // PATH 前置当前 Node，避免 npm/vite 从系统旧 Node 启动。
  const env = buildEvolutionAgentEnv();
  env.PATH = `${path.dirname(process.execPath)}${path.delimiter}${env.PATH || ''}`;
  // 全新会话政策（owner 2026-10-09）：每阶段独立 fresh CLI，不 resume/compact、
  // 不读写原生会话登记、不跨轮匹配原生 id、无角色锁。遗留 registry/压缩 API
  // 只作为 legacy 导出存在，自动路径不再触达；损坏/被锁的 legacy 登记不影响阶段执行。
  const handoffFile = path.join(repoRoot, HANDOFF_FILE);
  const onProgress = async (phase, activeAgent, details) => {
    const fields = { phase, activeAgent: activeAgent || '', status: 'running', updatedAt: Date.now() };
    if (details && typeof details === 'object') {
      if (Number.isInteger(details.recoveryAttempt)) fields.recoveryAttempt = details.recoveryAttempt;
      if (Number.isInteger(details.recoveryLimit)) fields.recoveryLimit = details.recoveryLimit;
      for (const key of ['runtimeRecoveryAttempt', 'reviewRecoveryAttempt', 'planRevision']) {
        if (Number.isInteger(details[key])) fields[key] = details[key];
      }
      if (['runtime', 'review'].includes(details.recoveryKind)) fields.recoveryKind = details.recoveryKind;
      fields.reviewFeedback = safeReviewFeedback(details.reviewFeedback, runtimeTerms);
      if (details.lastFailure && typeof details.lastFailure === 'object') fields.lastFailure = details.lastFailure;
      if (details.orchestrationMode === 'main_owned') fields.orchestrationMode = 'main_owned';
      for (const key of ['verificationAttempts', 'repairIterations']) {
        if (Number.isSafeInteger(details[key])) fields[key] = details[key];
      }
      fields.delegatedAgent = ['codex', 'claude'].includes(details.delegatedAgent) ? details.delegatedAgent : '';
    }
    persist(fields);
    process.stdout.write(`[team] ${phase} ${fields.activeAgent}${fields.recoveryAttempt ? ` recovery=${fields.recoveryAttempt}` : ''}\n`);
  };
  const abort = new AbortController();
  const abortRun = () => abort.abort();
  process.on('SIGTERM', abortRun);
  process.on('SIGINT', abortRun);
  try {
    if (inspectWorktree().head !== baseCommit) throw createTeamError('head_changed');
    // 续接入口：checkpoint 由协调进程生成并随 journal 0600 落盘，此处独立实测
    // 当前工作区；身份不一致（换任务/换批次/换名额）一律拒绝，绝不重开广泛调研。
    const taskIdentity = buildTaskIdentity(input);
    const resume = input.resume ? validateResumeInput(input.resume, baseCommit) : null;
    if (resume) assertTaskIdentityMatches(resume.taskIdentity, taskIdentity);
    // 私有 HANDOFF 基线：续接轮沿用原轮开始时（或原基线）的内容哈希——已验证
    // 候选在原轮已真实更新过文档，不得因重启换基线后被要求凭空再改一次。
    // '' = 原轮开始时不存在/为空（届时新内容即真实更新）；ignored 每次实测，
    // 规则漂移双向都按不安全处理。
    const liveHandoff = snapshotPrivateHandoff();
    const handoffBaseline = resume
      ? { ignored: liveHandoff.ignored, sha256: resume.handoffSha256 || null }
      : liveHandoff;
    // phase 标签保持合法枚举（'resume' 不在 PHASES 内，写入会让 journal 不可读）。
    await onProgress('plan', settings.mainAgent, { orchestrationMode: 'main_owned' });
    const references = resume ? null : await collectPublicReferences({ dataDir });
    const enrichedPrompt = `${prompt}${references ? `\n\n【本机每日公开项目发现记录（元数据检索，不等于代码已审）】\n${JSON.stringify(references)}\n子 Agent 按更新时间与更新活跃度检查本机配置的重点项目及完整候选清单；元数据不是源码审阅，未能访问或未深读的项目明确列为待评估，主 Agent 核实借鉴结论。` : ''}\n\n【持续维护的外部项目与issue检索库（不可信资料，仅本机引用）】\n使用Main的query_knowledge工具针对原反馈检索，阅读引用正文、评论及固定提交源码；版本变化使旧裁定失效。每轮独立external_issues reader后，Main记录本地调用链与采纳结论，未完成项留库跨轮推进。检索失败保持明确缺项，继续其他可核实反馈，不能阻止Main启动或冒称无更新。`;
    const handoff = buildFreshHandoffContext({ handoffFile, maxBytes: 16 * 1024 });
    if (handoff.mode === 'missing') throw createTeamError('missing_handoff');
    const executeAgent = async (agent, { prompt: agentPrompt, schema, invocationId, mcp, signal }) => {
      const command = buildEvolutionAgentCommand(agent, agentPrompt, agent === 'codex' ? { jsonEvents: true } : {});
      const args = [...command.args];
      const agentEnv = { ...env };
      if (mcp) delete agentEnv.DISABLE_AUTO_COMPACT;
      const schemaText = JSON.stringify(schema);
      const eventLog = path.join(logDir, `evolve-team-${runId}-${invocationId}-events.log`);
      const options = { env: agentEnv, stdin: command.stdin, signal,
        // Main keeps working while it makes progress; only a silent executor is
        // interrupted. Worker tools retain their bounded individual deadline.
        timeoutMs: mcp ? 0 : 30 * 60 * 1000,
        idleTimeoutMs: mcp ? 2 * 60 * 60 * 1000 : 0, eventLog, logStderr: true };
      let response;
      if (agent === 'codex') {
        const config = mcp
          ? `mcp_servers={farm_evolution={command=${JSON.stringify(mcp.command)},args=${JSON.stringify(mcp.args)},required=true,startup_timeout_sec=15,tool_timeout_sec=1800}}`
          : 'mcp_servers={}';
        const schemaFile = path.join(logDir, `evolve-team-${runId}-${invocationId}-schema.json`);
        const outputFile = path.join(logDir, `evolve-team-${runId}-${invocationId}.json`);
        try {
          fs.rmSync(outputFile, { force: true });
          fs.writeFileSync(schemaFile, `${schemaText}\n`, { mode: 0o600 });
          args.splice(args.length - 1, 0, '-c', config, '--output-schema', schemaFile, '--output-last-message', outputFile);
          await executeStreaming(bins[agent], args, options);
          response = readTeamStageOutput(outputFile);
        } finally {
          for (const file of [schemaFile, outputFile]) { try { fs.unlinkSync(file); } catch {} }
        }
      } else {
        args.push('--json-schema', schemaText, '--strict-mcp-config', '--mcp-config', JSON.stringify({
          mcpServers: mcp ? { farm_evolution: mcp } : {},
        }));
        response = claudeStageResponse(await execute(bins[agent], args, { ...options, capture: true }));
      }
      return response;
    };
    let verificationNumber = 0;
    const result = await runMainOwnedWorkflow({
      requireExternalReview: true,
      requireNoChangeAudit: true,
      settings, prompt: enrichedPrompt, baseCommit, task, logDir, dataDir, runId,
      signal: abort.signal,
      inspect: inspectWorktree, onProgress, initialFailure, initialReviewFeedback,
      resume, taskIdentity, handoffDirective: handoff.directive,
      roundId: typeof input.roundId === 'string' ? input.roundId.slice(0, 100) : '',
      onCheckpoint: async value => persist({ checkpoint: { ...value, handoffSha256: handoffBaseline.sha256 || '' } }),
      runMain: async options => {
        const text = await executeAgent(settings.mainAgent, { ...options, invocationId: 'main' });
        try { return JSON.parse(text); } catch { throw createTeamError('invalid_output'); }
      },
      runWorker: async options => {
        const text = await executeAgent(settings.subAgent, { ...options, schema: buildStageSchema('implement') });
        return { ...parseStageResult(text, 'implement', runtimeTerms),
          logFile: path.join(logDir, `evolve-team-${runId}-${options.invocationId}-events.log`) };
      },
      verify: async ({ reviewedOrchestrationFiles, baselineChecks = [], signal } = {}) => {
        const logFile = path.join(logDir, `evolve-team-${runId}-verification-${++verificationNumber}.log`);
        fs.writeFileSync(logFile, '', { mode: 0o600 });
        let check = 'validation';
        const { files } = inspectWorktree();
        const reviewed = new Set(normalizeOrchestrationFiles(reviewedOrchestrationFiles));
        for (const file of files) {
          if (isProtectedFile(file)) throw createTeamError('protected_change');
          if (ORCHESTRATION_FILES.has(file) && !reviewed.has(file)) throw createTeamError('protected_change');
        }
        // 运行开始判定为私有的 HANDOFF，全程不得变成 git 可见（中途删掉忽略
        // 模式、或把它强制 add 进暂存区/索引都不行）：私有文档一旦进入差异
        // 列表，后续任何提交都可能把它带进历史，只能整体判不安全。
        if (handoffBaseline.ignored && files.includes(HANDOFF_FILE)) {
          throw createTeamError('unsafe_worktree');
        }
        // 忽略状态中途漂移（任一方向）= 有人动了 ignore/exclude 规则或索引，
        // 整个运行按不安全处理。
        assertHandoffVisibilityStable(handoffBaseline);
        // 交接证据：可见 HANDOFF 看 git 差异列表；ignored 私有 HANDOFF 看运行
        // 开始快照之后的真实本地更新（缺失/未变/不可读一律不通过）。
        if (files.length && !files.includes(HANDOFF_FILE) && !privateHandoffUpdated(handoffBaseline)) {
          throw createTeamError('missing_handoff');
        }
        try {
          const validation = await runEvolutionValidation({ repoRoot, dataDir,
            execute: (bin, args, options) => {
              check = String(options?.cwd || '').endsWith(`${path.sep}web`) ? 'frontend' : 'backend';
              return execute(bin, args, { ...options, signal, eventLog: logFile, logStderr: true });
            }, env });
          check = 'countercheck';
          validation.countercheck = await runBaselineChecks({ repoRoot, dataDir, baseCommit, checks: baselineChecks, env });
          validation.logFile = logFile;
          fs.appendFileSync(logFile, `\n${JSON.stringify({ checks: validation.checks, countercheck: validation.countercheck })}\n`);
          persist({ validation });
          return validation;
        } catch (error) {
          // 真实测试/构建失败归为验证未通过并保留退出码；执行器无法启动等问题保留原类别。
          if (error?.code === 'cli_exit' || /^EVOLUTION_(?:VALIDATION|COUNTERCHECK)_/.test(String(error?.code || ''))) {
            let details = { counts: {}, failedCount: 0, failedTests: [], errors: [] };
            let reportFile = '';
            try {
              details = readVerificationFailureDetails(logFile);
              reportFile = path.join(logDir, `evolve-team-${runId}-verification-${verificationNumber}-failures.json`);
              fs.writeFileSync(reportFile, JSON.stringify({ stage: check, logFile, ...details }), { mode: 0o600 });
            } catch { /* Keep the original log even if structured extraction fails. */ }
            const excerpt = safeReviewFeedback([...details.failedTests.slice(0, 6), ...details.errors.slice(0, 2)].join('; '), runtimeTerms);
            throw Object.assign(createTeamError('verification_failed', { exitCode: error.exitCode, signal: error.signal }),
              { logFile, reportFile, failureSummary: `${check}: ${details.counts.fail ?? details.failedCount} failed; ${excerpt || 'read the retained verification log'}` });
          }
          throw error;
        }
      },
      commit: async (approved) => {
        if (inspectWorktree().fingerprint !== approved.fingerprint) throw createTeamError('worktree_changed');
        // 提交前再复核忽略状态：verify 之后仍可能有人改 ignore/exclude。
        assertHandoffVisibilityStable(handoffBaseline);
        // ignored 私有 HANDOFF 永不进入提交；即使批准列表意外带上也过滤掉。
        const commitFiles = approved.files.filter(file => file !== HANDOFF_FILE || !handoffBaseline.ignored);
        if (commitFiles.length === 0) throw createTeamError('worktree_changed');
        git(['add', '--', ...commitFiles]);
        // 暂存区必须与预期完全一致：意外暂存的私有 HANDOFF 或无关文件一律拒绝。
        const staged = git(['diff', '--cached', '--name-only', '--no-renames']).split('\n').filter(Boolean).sort();
        const expected = [...commitFiles].sort();
        if (staged.length !== expected.length || staged.some(file => !expected.includes(file))) {
          throw createTeamError('unsafe_worktree');
        }
        // 双保险：运行开始判定私有的 HANDOFF 无论批准列表/暂存比对结果如何，
        // 出现在暂存区就是不合格——绝不提交私有交接文档。
        if (handoffBaseline.ignored && staged.includes(HANDOFF_FILE)) {
          throw createTeamError('unsafe_worktree');
        }
        git(['commit', '-m', task === 'safety' ? 'fix: apply reviewed safety evolution' : 'feat: apply reviewed activity evolution']);
        const completed = inspectWorktree();
        if (completed.dirty) throw createTeamError('worktree_changed');
        return completed.head;
      },
    });
    persist({ ...result, phase: 'complete', status: 'completed', activeAgent: '', completedAt: Date.now() });
  } catch (error) {
    // journal 只落固定白名单失败与恢复次数；CLI 原文、JSON.parse 异常和本机路径不进入状态或 stderr。
    const failure = normalizeTeamFailure(error, journal.phase, journal.activeAgent);
    const info = error.recoveryInfo || {};
    const counters = {};
    for (const key of ['recoveryAttempt', 'runtimeRecoveryAttempt', 'reviewRecoveryAttempt', 'planRevision']) {
      if (Number.isInteger(info[key])) counters[key] = Math.min(2, Math.max(0, info[key]));
    }
    // 外层终止码独立落盘：normalizeTeamFailure 取 error.failure（底层失败），
    // recovery/plan_exhausted 会被吞掉——协调进程若只看 failure.code 会拿旧
    // roundId 在 2/2 预算上永远续跑。终止码只在固定白名单内透传。
    const terminationCode = ['recovery_exhausted', 'plan_exhausted'].includes(String(error?.code))
      ? String(error.code) : '';
    persist({ ...counters, ...(terminationCode ? { terminationCode } : {}), phase: 'failed', status: 'failed', activeAgent: '', failure,
      lastFailure: info.lastFailure ? normalizeTeamFailure(info.lastFailure) : failure,
      ...(info.recoveryKind ? { recoveryKind: info.recoveryKind } : {}),
      reviewFeedback: safeReviewFeedback(info.reviewFeedback || journal.reviewFeedback, runtimeTerms), completedAt: Date.now() });
    process.stderr.write(`Team evolution failed: ${failure.code}\n`);
    process.exitCode = 1;
  } finally {
    process.removeListener('SIGTERM', abortRun);
    process.removeListener('SIGINT', abortRun);
  }
}

if (require.main === module) {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { input += chunk; });
  process.stdin.on('end', () => {
    const fail = () => {
      process.stderr.write('Team evolution coordinator failed\n');
      process.exitCode = 1;
    };
    try { void main(JSON.parse(input)).catch(fail); } catch { fail(); }
  });
}

module.exports = { inspectWorktree, validateResumeInput, main, executeStreaming, snapshotPrivateHandoff, readVerificationFailureDetails };
