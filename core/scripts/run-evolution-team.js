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
  parseStageResult, runTeamWorkflow, teamJournalPath, buildStageSchema,
  createTeamError, normalizeTeamFailure, normalizeOrchestrationFiles, safeReviewFeedback,
} = require('../src/services/evolution-team');

const repoRoot = path.resolve(__dirname, '../..');

// 私有交接文档（owner 本地 git exclude 忽略，永不入库）。协调进程必须在
// 运行开始时独立于 Git 记录它的存在/非空/内容哈希（只记哈希不记内容），
// 验证时以"本地非空且与开始时相比真实变更"作为交接证据——修复此前只看
// git 差异列表导致 ignored HANDOFF 永远 missing_handoff 的误判。
const HANDOFF_FILE = 'docs/HANDOFF.md';

function isGitIgnored(file) {
  try {
    // check-ignore 退出码：0=被忽略（含 .git/info/exclude），1=未忽略。
    // --no-index：即使文件被强制 add 进了索引，也仍按忽略模式判定——被
    // 暂存的私有 HANDOFF 不能因此伪装成"可见文档"绕过私有保护。
    execFileSync('git', ['check-ignore', '--no-index', '--', file], {
      cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    });
    return true;
  } catch (error) {
    // 只认退出码 1（确实未被忽略）；128/其他状态码/无法执行 = 环境不可信。
    if (error && error.status === 1) return false;
    throw createTeamError('unsafe_worktree');
  }
}

/** 运行开始快照：ignored 标记 + 非空内容哈希；不可读/非普通文件一律拒绝。 */
function snapshotPrivateHandoff() {
  const snapshot = { ignored: isGitIgnored(HANDOFF_FILE), sha256: null };
  const full = path.join(repoRoot, HANDOFF_FILE);
  let stat;
  try { stat = fs.lstatSync(full); }
  catch (error) { if (error.code !== 'ENOENT') throw createTeamError('unsafe_worktree'); }
  if (stat) {
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
  '.gitignore', 'core/src/services/privacy-guard.js', 'core/src/services/local-privacy-terms.js',
  'core/src/services/private-config.js', 'core/src/services/feishu-notify.js',
  'core/src/services/activity-evolver.js',
    'core/src/services/evolution-countercheck.js', 'core/scripts/countercheck-reporter.cjs',
    'core/src/services/evolution-learning.js', 'core/src/services/evolution-validation.js', 'core/src/services/evolution-references.js',
    'core/src/services/daily-feedback.js', 'core/src/controllers/admin-feedback-routes.js',
    'web/src/utils/daily-feedback.ts',
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

function inspectWorktree() {
  const head = git(['rev-parse', 'HEAD']).trim();
  const status = git(['status', '--porcelain', '--untracked-files=normal']);
  const files = [...new Set([
    ...git(['diff', '--name-only', '-z', 'HEAD']).split('\0'),
    ...git(['ls-files', '--others', '--exclude-standard', '-z']).split('\0'),
  ].filter(Boolean))].sort();
  const hash = crypto.createHash('sha256').update(head).update(status);
  const fileFingerprints = {};
  for (const file of files) {
    const digest = hashWorktreeFile(file);
    fileFingerprints[file] = digest;
    hash.update(`\n${file}:${digest}`);
  }
  return { head, dirty: !!status.trim(), files, fingerprint: hash.digest('hex'), fileFingerprints };
}

// 逐文件指纹只含哈希：内容 + 权限 + 暂存状态，不把文件正文写进运行状态。
function hashWorktreeFile(file) {
  const fileHash = crypto.createHash('sha256');
  try {
    const full = path.join(repoRoot, file);
    let stat;
    try { stat = fs.lstatSync(full); }
    catch (error) { if (error.code !== 'ENOENT') throw createTeamError('unsafe_worktree'); }
    if (stat) {
      if (!stat.isFile()) throw createTeamError('unsafe_worktree');
      fileHash.update(`mode=${stat.mode.toString(8)};`);
      fileHash.update(fs.readFileSync(full));
    }
    fileHash.update(git(['diff', '--cached', '--binary', '--', file]));
  } catch (error) {
    if (error?.code) throw error;
    throw createTeamError('unsafe_worktree');
  }
  return fileHash.digest('hex');
}

function execute(bin, args, options = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(bin, args, {
        cwd: options.cwd || repoRoot,
        env: options.env || buildEvolutionAgentEnv(),
        stdio: ['pipe', options.capture ? 'pipe' : 'inherit', 'inherit'],
        // 不 detached：所有 CLI/测试进程随协调进程一起终止。
      });
    } catch {
      reject(createTeamError('cli_spawn'));
      return;
    }
    let stdout = '';
    let overflow = false;
    let spawnFailed = false;
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => {
      if (Buffer.byteLength(stdout) + Buffer.byteLength(chunk) > 512 * 1024) {
        overflow = true;
        child.kill('SIGTERM');
      } else stdout += chunk.toString();
    });
    child.stdin.on('error', () => {});
    child.stdin.end(options.stdin || '');
    child.once('error', () => {
      spawnFailed = true;
      reject(createTeamError('cli_spawn'));
    });
    child.once('close', (code, signal) => {
      if (spawnFailed) return;
      if (overflow) reject(createTeamError('output_limit', { exitCode: code }));
      else if (code !== 0 || signal) reject(createTeamError('cli_exit', { exitCode: code, signal }));
      else resolve(stdout);
    });
  });
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

async function main(input) {
  process.umask(0o077);
  const { runId, baseCommit, settings, logDir, bins, prompt, task, dataDir, initialFailure, initialReviewFeedback } = input;
  const journalFile = teamJournalPath(logDir, runId);
  const journal = { runId, baseCommit, mainAgent: settings.mainAgent, subAgent: settings.subAgent };
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
    }
    persist(fields);
    process.stdout.write(`[team] ${phase} ${fields.activeAgent}${fields.recoveryAttempt ? ` recovery=${fields.recoveryAttempt}` : ''}\n`);
  };
  try {
    if (inspectWorktree().head !== baseCommit) throw createTeamError('head_changed');
    const handoffBaseline = snapshotPrivateHandoff();
    await onProgress('research', settings.subAgent, {});
    const references = await collectPublicReferences({ dataDir });
    const enrichedPrompt = `${prompt}\n\n【本机每日公开项目发现记录（元数据检索，不等于代码已审）】\n${JSON.stringify(references)}\n子 Agent 按更新时间与更新活跃度检查本机配置的重点项目及完整候选清单；元数据不是源码审阅，未能访问或未深读的项目明确列为待评估，主 Agent 核实借鉴结论。`;
    const result = await runTeamWorkflow({
      settings, prompt: enrichedPrompt, inspect: inspectWorktree, onProgress, initialFailure, initialReviewFeedback, verifyBaseline: true, dailyBrain: false, efficientMode: true,
      runStage: async (phase, agent, stagePrompt) => {
        // Prompt 始终走 stdin；阶段结构化输出由 schema 强约束，退出 0 不再当作交接成功。
        const command = buildEvolutionAgentCommand(agent, stagePrompt);
        const schema = JSON.stringify(buildStageSchema(phase));
        const args = [...command.args];
        let response;
        if (agent === 'codex') {
          const schemaFile = path.join(logDir, `evolve-team-${runId}-${phase}-schema.json`);
          const outputFile = path.join(logDir, `evolve-team-${runId}-${phase}.log`);
          try {
            fs.rmSync(outputFile, { force: true });
            fs.writeFileSync(schemaFile, `${schema}\n`, { mode: 0o600 });
          } catch { throw createTeamError('unknown'); }
          args.splice(args.length - 1, 0, '--output-schema', schemaFile, '--output-last-message', outputFile);
          try {
            await execute(bins[agent], args, { env, stdin: command.stdin });
            response = readTeamStageOutput(outputFile);
          } finally {
            for (const temp of [schemaFile, outputFile]) { try { fs.unlinkSync(temp); } catch {} }
          }
        } else {
          args.push('--output-format', 'json', '--json-schema', schema);
          const stdout = await execute(bins[agent], args, { env, stdin: command.stdin, capture: true });
          response = claudeStageResponse(stdout);
        }
        return parseStageResult(response, phase, runtimeTerms);
      },
      verify: async ({ reviewedOrchestrationFiles, baselineChecks = [] } = {}) => {
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
          const validation = await runEvolutionValidation({ repoRoot, dataDir, execute, env });
          validation.countercheck = await runBaselineChecks({ repoRoot, dataDir, baseCommit, checks: baselineChecks, env });
          persist({ validation });
          return validation;
        } catch (error) {
          // 真实测试/构建失败归为验证未通过并保留退出码；执行器无法启动等问题保留原类别。
          if (error?.code === 'cli_exit' || /^EVOLUTION_(?:VALIDATION|COUNTERCHECK)_/.test(String(error?.code || ''))) {
            throw createTeamError('verification_failed', { exitCode: error.exitCode, signal: error.signal });
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
    persist({ ...counters, phase: 'failed', status: 'failed', activeAgent: '', failure,
      ...(info.recoveryKind ? { recoveryKind: info.recoveryKind } : {}),
      reviewFeedback: safeReviewFeedback(info.reviewFeedback || journal.reviewFeedback, runtimeTerms), completedAt: Date.now() });
    process.stderr.write(`Team evolution failed: ${failure.code}\n`);
    process.exitCode = 1;
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

module.exports = { inspectWorktree, main };
