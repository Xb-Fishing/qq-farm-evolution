const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { test } = require('node:test');

// 私有（git-ignored）HANDOFF 交接证据（2026-10-04）：owner 本地用
// .git/info/exclude 忽略 docs/HANDOFF.md，旧实现只查 git 差异列表，导致
// 只要改了代码就永远 missing_handoff。现在协调进程在运行开始独立快照
// HANDOFF 的存在/非空/内容哈希（只记哈希），验证时要求真实本地更新。
// 全链路用真实 detached CLI + 假 Agent + 隔离本地 Git 仓库验证：
// ignored+真实更新通过且提交只含公开源码/测试；未更新/缺失拒绝；
// 非普通文件证据拒绝；无代码改动不强求更新；验证失败仍拒绝；
// 强制 add 进索引/运行中途删忽略模式把私有文档变 git 可见 → 整体
// unsafe_worktree 且绝不产生包含私有文档的提交（check-ignore --no-index +
// baseline.ignored 钉死 + verify/commit 双闸门）。
// 可见（被跟踪）HANDOFF 的旧语义由既有 evolution-team.test.js 覆盖。

const HANDOFF_TEXT = 'Fixture private constraints\n';

test('ignored 私有 HANDOFF：真实更新通过、未更新/缺失/不可读拒绝、无代码不强求', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'farm-team-private-handoff-'));
  const write = (file, text) => {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), text);
  };
  const git = args => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const journalOf = runId => JSON.parse(fs.readFileSync(path.join(dir, 'core/data/logs', `evolve-team-${runId}.json`), 'utf8'));
  try {
    write('core/scripts/run-evolution-team.js', fs.readFileSync(path.join(__dirname, '../scripts/run-evolution-team.js')));
    for (const name of ['activity-evolver', 'privacy-guard', 'evolution-team', 'evolution-validation', 'evolution-countercheck', 'evolution-sessions', 'evolution-worktree']) {
      write(`core/src/services/${name}.js`, `module.exports = require(${JSON.stringify(require.resolve(`../src/services/${name}`))});`);
    }
    write('core/src/services/evolution-references.js', 'module.exports.collectPublicReferences = async () => ({state:"complete", discoveryComplete:true});\n');
    write('.gitignore', 'core/data/\n');
    write('docs/HANDOFF.md', HANDOFF_TEXT);
    write('core/src/example.js', 'module.exports = 1;\n');
    write('core/test/example.test.js', 'require("node:assert/strict").ok([1, 2].includes(require("../src/example")));\n');
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
  if (prompt === '/compact') {
    process.stdout.write(JSON.stringify({ type: 'system', subtype: 'compact_boundary', session_id: SESSION.claude }) + '\\n');
    process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, session_id: SESSION.claude }) + '\\n');
    return;
  }
  const phase = prompt.match(/只完成 (\\w+) 阶段/)[1];
  if (phase === 'implement' && !fs.existsSync('core/data/skip-code')) {
    fs.writeFileSync('core/src/example.js', fs.existsSync('core/data/break-tests') ? 'module.exports = 3;\\n' : 'module.exports = 2;\\n');
    if (!fs.existsSync('core/data/skip-handoff')) fs.appendFileSync('docs/HANDOFF.md', 'Verified implementation\\n');
    if (fs.existsSync('core/data/force-stage-handoff')) require('node:child_process').execFileSync('git', ['add', '-f', 'docs/HANDOFF.md'], { stdio: 'ignore' });
    if (fs.existsSync('core/data/unignore-handoff')) fs.writeFileSync('.git/info/exclude', fs.readFileSync('.git/info/exclude', 'utf8').replace('docs/HANDOFF.md\\n', ''));
  }
  const decision = { research: 'researched', plan: 'approve', implement: 'implemented', review: 'approve', diagnose: 'repair', repair: 'no_change', repair_review: 'approve' }[phase];
  const result = {decision, summary: 'Verified fixture change', ...(phase === 'diagnose' ? {allowedFiles: []} : {}), ...(phase === 'plan' ? {allowedFiles:['core/src/example.js','docs/HANDOFF.md','core/test/behavior.test.js'], acceptanceChecks:['example returns expected value'], baselineChecks:[]} : {})};
  const schemaIndex = process.argv.indexOf('--output-schema');
  if (schemaIndex >= 0) {
    if (!JSON.parse(fs.readFileSync(process.argv[schemaIndex + 1])).properties.decision.enum.includes(decision)) throw new Error('Missing stage schema');
    if (process.argv.includes('--json')) process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: SESSION.codex }) + '\\n');
    fs.writeFileSync(process.argv[process.argv.indexOf('--output-last-message') + 1], JSON.stringify(result));
  } else {
    const jsonIndex = process.argv.indexOf('--json-schema');
    if (jsonIndex < 0 || !JSON.parse(process.argv[jsonIndex + 1]).properties.decision.enum.includes(decision)) throw new Error('Missing stage schema');
    process.stdout.write(JSON.stringify({subtype:'success', is_error:false, session_id: SESSION.claude, result:'completed', structured_output:result}));
  }
});
`;
    write('core/data/fake-agent', fakeCli);
    fs.chmodSync(path.join(dir, 'core/data/fake-agent'), 0o700);
    fs.mkdirSync(path.join(dir, 'core/data/logs'), { recursive: true });
    git(['init', '-q']);
    git(['config', 'user.name', 'Test']);
    git(['config', 'user.email', ['test', 'users.noreply.github.com'].join('@')]);
    // owner 场景：HANDOFF 只在本地 exclude 里忽略（不进 .gitignore，不进提交）。
    fs.appendFileSync(path.join(dir, '.git/info/exclude'), 'docs/HANDOFF.md\n');
    git(['add', '.']);
    git(['commit', '-qm', 'fixture']);
    const baseCommit = git(['rev-parse', 'HEAD']);
    assert.equal(git(['ls-files', '--', 'docs/HANDOFF.md']), '', 'HANDOFF 不应被跟踪');

    const run = (runId) => {
      const input = {
        runId, baseCommit, task: 'safety', prompt: 'Fixture task',
        settings: { mainAgent: 'codex', subAgent: 'claude', dualAgentEnabled: true },
        bins: { codex: path.join(dir, 'core/data/fake-agent'), claude: path.join(dir, 'core/data/fake-agent') },
        logDir: path.join(dir, 'core/data/logs'), dataDir: path.join(dir, 'core/data'),
      };
      return spawnSync(process.execPath, ['core/scripts/run-evolution-team.js'], {
        cwd: dir, input: JSON.stringify(input), encoding: 'utf8', timeout: 60000,
        env: { ...process.env, FARM_DATA_DIR: path.join(dir, 'core/data') },
      });
    };
    const resetRun = () => {
      git(['reset', '--hard', baseCommit]);
      write('docs/HANDOFF.md', HANDOFF_TEXT);
      // 中途改过本地 exclude 的场景要还原（reset --hard 不覆盖 .git/info）。
      fs.writeFileSync(path.join(dir, '.git/info/exclude'), 'docs/HANDOFF.md\n');
    };

    // 1) ignored + 真实本地更新（脏文件、未暂存）：通过；提交只含公开源码，
    //    绝不含 HANDOFF，且任何历史提交里都不曾出现私有文档。
    const success = run('private-update');
    assert.equal(success.status, 0, success.stderr);
    const committed = git(['show', '--name-only', '--format=', 'HEAD']).split('\n').filter(Boolean);
    assert.deepEqual(committed, ['core/src/example.js']);
    assert.equal(git(['status', '--porcelain']), '');
    assert.equal(git(['log', '--all', '--oneline', '--', 'docs/HANDOFF.md']), '', '私有文档绝不进入任何历史提交');
    assert.match(fs.readFileSync(path.join(dir, 'docs/HANDOFF.md'), 'utf8'), /Verified implementation/);
    const okJournal = journalOf('private-update');
    assert.equal(okJournal.status, 'completed');
    assert.equal(okJournal.decision, 'approve');

    // 2) ignored 但未更新：拒绝（missing_handoff 驱动，最终收口失败）。
    resetRun();
    write('core/data/skip-handoff', '1');
    const unchanged = run('private-unchanged');
    assert.equal(unchanged.status, 1);
    assert.equal(git(['rev-parse', 'HEAD']), baseCommit);
    const unchangedJournal = journalOf('private-unchanged');
    assert.equal(unchangedJournal.status, 'failed');
    assert.ok(['missing_handoff', 'recovery_exhausted'].includes(unchangedJournal.failure.code));
    assert.equal(unchangedJournal.lastFailure.code, 'missing_handoff');

    // 3) ignored 且文档缺失：同样拒绝。
    resetRun();
    fs.unlinkSync(path.join(dir, 'docs/HANDOFF.md'));
    const missing = run('private-missing');
    assert.equal(missing.status, 1);
    assert.equal(git(['rev-parse', 'HEAD']), baseCommit);
    assert.equal(journalOf('private-missing').lastFailure.code, 'missing_handoff');

    // 4) 非普通文件"证据"（目录占位）：运行开始即拒绝，绝不放行。
    resetRun();
    fs.unlinkSync(path.join(dir, 'docs/HANDOFF.md'));
    fs.mkdirSync(path.join(dir, 'docs/HANDOFF.md'));
    const nonRegular = run('private-nonregular');
    assert.equal(nonRegular.status, 1);
    assert.equal(git(['rev-parse', 'HEAD']), baseCommit);
    assert.equal(journalOf('private-nonregular').failure.code, 'unsafe_worktree');
    fs.rmdirSync(path.join(dir, 'docs/HANDOFF.md'));

    // 5) 无代码改动：不强求更新 ignored HANDOFF（零改动收口，不制造提交）。
    resetRun();
    fs.unlinkSync(path.join(dir, 'core/data/skip-handoff'));
    write('core/data/skip-code', '1');
    const noCode = run('private-nocode');
    assert.equal(noCode.status, 0, noCode.stderr);
    assert.equal(git(['rev-parse', 'HEAD']), baseCommit);
    const noCodeJournal = journalOf('private-nocode');
    assert.equal(noCodeJournal.decision, 'no_change');
    assert.equal(noCodeJournal.head, baseCommit);

    // 6) 验证失败仍拒绝：即使 HANDOFF 已真实更新。
    resetRun();
    fs.unlinkSync(path.join(dir, 'core/data/skip-code'));
    write('core/data/break-tests', '1');
    const broken = run('private-broken-tests');
    assert.equal(broken.status, 1);
    assert.equal(git(['rev-parse', 'HEAD']), baseCommit);
    assert.ok(['verification_failed', 'recovery_exhausted'].includes(journalOf('private-broken-tests').failure.code));

    // 7) 私有 HANDOFF 被强制 add 进暂存区（实现阶段）：
    // 普通 check-ignore 会因文件已入索引而误报"未忽略"，绕过私有保护并
    // 可能把它提交进历史。--no-index 判定 + verify/commit 双闸门必须整体
    // 判 unsafe_worktree，且绝不产生包含私有文档的提交。
    resetRun();
    write('core/data/force-stage-handoff', '1');
    const forceStaged = run('private-force-staged');
    assert.equal(forceStaged.status, 1);
    assert.equal(git(['rev-parse', 'HEAD']), baseCommit, '强制暂存的私有 HANDOFF 绝不能被提交');
    assert.equal(journalOf('private-force-staged').failure.code, 'unsafe_worktree');
    fs.unlinkSync(path.join(dir, 'core/data/force-stage-handoff'));

    // 8) 运行开始前就已强制暂存：快照仍必须按忽略模式判私有（--no-index），
    // 后续验证发现私有文档进入差异列表 → unsafe，无提交。
    resetRun();
    git(['add', '-f', 'docs/HANDOFF.md']);
    const preStaged = run('private-pre-staged');
    assert.equal(preStaged.status, 1);
    assert.equal(git(['rev-parse', 'HEAD']), baseCommit, '开始前强制暂存的私有 HANDOFF 同样绝不入库');
    assert.equal(journalOf('private-pre-staged').failure.code, 'unsafe_worktree');

    // 9) 运行中途删掉本地 exclude 的忽略模式让 HANDOFF 变可见：
    // 开始时已判定私有（baseline.ignored 钉死），中途变成 git 可见即整体不安全。
    resetRun();
    write('core/data/unignore-handoff', '1');
    const unignored = run('private-unignored-midrun');
    assert.equal(unignored.status, 1);
    assert.equal(git(['rev-parse', 'HEAD']), baseCommit, '中途变可见的私有 HANDOFF 绝不能被提交');
    assert.equal(journalOf('private-unignored-midrun').failure.code, 'unsafe_worktree');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
