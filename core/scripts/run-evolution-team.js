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
        if (files.length && !files.includes('docs/HANDOFF.md')) throw createTeamError('missing_handoff');
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
        git(['add', '--', ...approved.files]);
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
