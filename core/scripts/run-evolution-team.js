/** Detached coordinator. Children share its process group so the existing watchdog owns the whole run. */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const { buildEvolutionAgentCommand, buildEvolutionAgentEnv } = require('../src/services/activity-evolver');
const { collectRuntimePrivacyTerms } = require('../src/services/privacy-guard');
const { parseStageResult, runTeamWorkflow, teamJournalPath } = require('../src/services/evolution-team');

const repoRoot = path.resolve(__dirname, '../..');

function git(args) {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
}

function inspectWorktree() {
  const head = git(['rev-parse', 'HEAD']).trim();
  const status = git(['status', '--porcelain', '--untracked-files=normal']);
  const files = [...new Set([
    ...git(['diff', '--name-only', '-z', 'HEAD']).split('\0'),
    ...git(['ls-files', '--others', '--exclude-standard', '-z']).split('\0'),
  ].filter(Boolean))];
  const hash = crypto.createHash('sha256').update(head).update(status)
    .update(git(['diff', '--binary', 'HEAD'])).update(git(['diff', '--cached', '--binary']));
  for (const file of files.sort()) {
    hash.update(file);
    const full = path.join(repoRoot, file);
    if (fs.existsSync(full)) {
      const stat = fs.lstatSync(full);
      if (!stat.isFile()) throw new Error('进化改动包含不可审阅的文件类型');
      hash.update(fs.readFileSync(full));
    }
  }
  return { head, dirty: !!status.trim(), files, fingerprint: hash.digest('hex') };
}

function execute(bin, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd: options.cwd || repoRoot,
      env: options.env || buildEvolutionAgentEnv(),
      stdio: ['pipe', options.capture ? 'pipe' : 'inherit', 'inherit'],
      // 不 detached：所有 CLI/测试进程随协调进程一起终止。
    });
    let stdout = '';
    let overflow = false;
    child.stdout?.on('data', (chunk) => {
      if (Buffer.byteLength(stdout) + chunk.length > 512 * 1024) {
        overflow = true;
        child.kill('SIGTERM');
      } else stdout += chunk.toString();
    });
    child.stdin.on('error', () => {});
    child.stdin.end(options.stdin || '');
    child.once('error', () => reject(new Error('阶段执行器无法启动')));
    child.once('close', (code, signal) => {
      if (overflow || code !== 0 || signal) reject(new Error('阶段执行器失败或中断，请查看本机进化日志'));
      else resolve(stdout);
    });
  });
}

async function main(input) {
  process.umask(0o077);
  const { runId, baseCommit, settings, logDir, bins, prompt, task, dataDir } = input;
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
  const onProgress = async (phase, activeAgent) => {
    persist({ phase, activeAgent, status: 'running', updatedAt: Date.now() });
    process.stdout.write(`[team] ${phase} ${activeAgent}\n`);
  };
  try {
    if (inspectWorktree().head !== baseCommit) throw new Error('启动基线已变化');
    const result = await runTeamWorkflow({
      settings, prompt, inspect: inspectWorktree, onProgress,
      runStage: async (phase, agent, stagePrompt) => {
        const command = buildEvolutionAgentCommand(agent, stagePrompt);
        const outputFile = path.join(logDir, `evolve-team-${runId}-${phase}.log`);
        const args = [...command.args];
        if (agent === 'codex') args.splice(args.length - 1, 0, '--output-last-message', outputFile);
        else args.push('--output-format', 'json');
        try {
          const stdout = await execute(bins[agent], args, { env, stdin: command.stdin, capture: agent === 'claude' });
          let response;
          if (agent === 'codex') response = fs.readFileSync(outputFile, 'utf8');
          else {
            const envelope = JSON.parse(stdout);
            if (envelope.is_error || envelope.subtype !== 'success') throw new Error('Claude 未成功完成本阶段');
            response = envelope.structured_output ? JSON.stringify(envelope.structured_output) : envelope.result;
          }
          return parseStageResult(response, phase, runtimeTerms);
        } finally {
          try { fs.unlinkSync(outputFile); } catch {}
        }
      },
      verify: async () => {
        const { files } = inspectWorktree();
        const controls = new Set([
          'core/scripts/run-evolution-team.js', 'core/src/services/evolution-team.js',
          'core/src/services/activity-evolver.js', 'core/src/services/privacy-guard.js',
          'core/src/services/private-config.js', 'core/src/services/feishu-notify.js',
          'scripts/evolution-hooks/pre-push', '.gitignore',
        ]);
        if (files.some(file => controls.has(file))) throw new Error('自动进化不得修改本轮编排或隐私控制');
        if (!files.includes('docs/HANDOFF.md')) throw new Error('代码修改缺少 HANDOFF 更新');
        const tests = fs.readdirSync(path.join(repoRoot, 'core/test')).filter(file => file.endsWith('.test.js'));
        await execute(process.execPath, ['--test', '--test-concurrency=1', ...tests.map(file => `test/${file}`)], {
          cwd: path.join(repoRoot, 'core'), env,
        });
        if (files.some(file => file.startsWith('web/'))) {
          await execute('npm', ['run', 'build'], { cwd: path.join(repoRoot, 'web'), env });
        }
      },
      commit: async (approved) => {
        if (inspectWorktree().fingerprint !== approved.fingerprint) throw new Error('提交前工作区发生变化');
        git(['add', '--', ...approved.files]);
        git(['commit', '-m', task === 'safety' ? 'fix: apply reviewed safety evolution' : 'feat: apply reviewed activity evolution']);
        const completed = inspectWorktree();
        if (completed.dirty) throw new Error('提交后仍有未审阅改动');
        return completed.head;
      },
    });
    persist({ ...result, phase: 'complete', status: 'completed', activeAgent: '', completedAt: Date.now() });
  } catch (error) {
    persist({ phase: 'failed', status: 'failed', activeAgent: '', completedAt: Date.now() });
    // 不输出 CLI 原始错误或交接文本，防止跨阶段/通知意外透传。
    process.stderr.write(`Team evolution failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { input += chunk; });
  process.stdin.on('end', () => {
    void main(JSON.parse(input)).catch(() => {
      process.stderr.write('Team evolution coordinator failed\n');
      process.exitCode = 1;
    });
  });
}

module.exports = { inspectWorktree, main };
