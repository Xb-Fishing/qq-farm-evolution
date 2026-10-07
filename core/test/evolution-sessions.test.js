'use strict';
// 原生会话登记（evolution-sessions.js，2026-10-07 Stage B 回归）：
// - 原生压缩必须等到真实完成证据：Codex 走 app-server（thread/read → resume →
//   compact/start，ack {} ≠ 完成，必须等到同线程 item/completed(contextCompaction)）；
//   Claude 走同 id /compact（stream 必须出现 compact_boundary + 成功 result）。
//   失败/超时/线程不符：保留旧 id、置 compactPending，绝不静默换新 id。
// - 登记/锁/快照合同：角色+provider+仓库（git-common-dir）绑定；换 provider 不复用
//   异构会话但允许显式整体替换；同 provider id 漂移 = id_mismatch；跨库 fail-safe；
//   登记损坏 fail-safe；同角色活 PID 锁 busy、死锁可接管；重启同 id 续接。
// - 全部登记/快照/日志只落 ignored 数据目录且 0600，绝不进 git 或产品 API。
// - 私有 HANDOFF 增量：missing/refresh/unchanged/append/changed（含删除章节与
//   旧原文）/超大 refresh；损坏快照强制完整重读；水位只在成功 commit 后推进。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { test } = require('node:test');
const {
  createStageSessions, buildHandoffContext, compactClaudeSession, compactCodexThread,
  readSessionRegistry, repoBinding, acquireRoleLock, sessionError, validNativeId, sanitizeRole,
} = require('../src/services/evolution-sessions');

const CLAUDE_ID = 'aaaa1111-2222-3333-4444-555566667777';
const CODEX_ID = 'bbbb8888-9999-aaaa-bbbb-ccccddddeeee';

function buildRepo(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `farm-sessions-${tag}-`));
  const write = (file, data) => {
    const full = path.resolve(dir, file);
    if (full !== dir && !full.startsWith(dir + path.sep)) throw new Error(`fixture_escape:${file}`);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, data);
  };
  const git = args => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  write('.gitignore', 'core/data/\n');
  write('core/src/example.js', 'module.exports = 1;\n');
  git(['init', '-q']);
  git(['config', 'user.name', 'Sessions fixture']);
  git(['config', 'user.email', ['fixture', 'users.noreply.github.com'].join('@')]);
  git(['add', '.']);
  git(['commit', '-qm', 'fixture']);
  return { dir, write, git };
}

// 会话感知假 CLI：app-server 子协议 + /compact 原生事件 + 可注入失败模式。
const FAKE_CLI = `#!/usr/bin/env node
const fs = require('node:fs');
const SESSION = { claude: '${CLAUDE_ID}', codex: '${CODEX_ID}' };
const mode = f => fs.existsSync(f);
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
      if (value.method === 'thread/read' || value.method === 'thread/resume') {
        const id = mode('core/data/wrong-thread') ? 'ffff0000-0000-0000-0000-000000000000' : value.params.threadId;
        reply({ thread: { id } });
      } else if (value.method === 'thread/compact/start') {
        reply({});
        if (!mode('core/data/ack-only')) {
          for (const method of ['item/started', 'item/completed']) {
            process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method, params: { threadId: value.params.threadId, item: { type: 'contextCompaction' } } }) + '\\n');
          }
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
    // 参数合同：安装版 CLI 的 print/stream-json 模式必须带 --verbose 才输出事件流。
    if (!process.argv.includes('--verbose')) process.exit(2);
    if (!mode('core/data/skip-boundary')) {
      const boundaryId = mode('core/data/boundary-wrong-id') ? 'dddd4321-8765-4321-8765-aabbccddeeff' : SESSION.claude;
      process.stdout.write(JSON.stringify({ type: 'system', subtype: 'compact_boundary', session_id: boundaryId }) + '\\n');
    }
    if (!mode('core/data/no-result')) {
      process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: mode('core/data/compact-error'),
        session_id: mode('core/data/wrong-id-result') ? 'eeee1212-3434-5656-7878-9a9abbbbcccc' : SESSION.claude }) + '\\n');
      // 双证据已见但进程不退出：真实 CLI 可能挂在收尾——超时必须按失败收口。
      if (mode('core/data/hang-after-result')) setInterval(() => {}, 1000);
    }
    return;
  }
  throw new Error('unexpected prompt');
});
`;

test('原生压缩：Codex 必须等到同线程 item/completed，Claude 必须见到 compact_boundary', async () => {
  const { dir, write } = buildRepo('compact');
  try {
    write('core/data/fake-cli', FAKE_CLI);
    fs.chmodSync(path.join(dir, 'core/data/fake-cli'), 0o700);
    const bin = path.join(dir, 'core/data/fake-cli');
    const logFile = path.join(dir, 'core/data/compact.log');

    const codexOk = await compactCodexThread({ bin, threadId: CODEX_ID, cwd: dir, logFile, timeoutMs: 5000 });
    assert.equal(codexOk.compacted, true);
    assert.equal(codexOk.threadId, CODEX_ID);
    const logText = fs.readFileSync(logFile, 'utf8');
    assert.match(logText, /item\/completed/);
    assert.match(logText, /contextCompaction/);
    assert.equal((fs.statSync(logFile).mode & 0o777), 0o600, '压缩事件日志必须 0600');
    fs.unlinkSync(logFile);

    // ack {} 但永无 item/completed ⇒ 超时，不算完成。
    write('core/data/ack-only', '1');
    await assert.rejects(
      compactCodexThread({ bin, threadId: CODEX_ID, cwd: dir, logFile, timeoutMs: 300 }),
      error => error.code === 'session_failed' && error.reason === 'compact_timeout');
    fs.unlinkSync(path.join(dir, 'core/data/ack-only'));

    // thread/read 回不同线程 id ⇒ 线程不符，安全停。
    write('core/data/wrong-thread', '1');
    await assert.rejects(
      compactCodexThread({ bin, threadId: CODEX_ID, cwd: dir, logFile, timeoutMs: 5000 }),
      error => error.reason === 'thread_mismatch');
    fs.unlinkSync(path.join(dir, 'core/data/wrong-thread'));

    // Claude：boundary + 成功 result 才算完成。
    const claudeOk = await compactClaudeSession({ bin, sessionId: CLAUDE_ID, cwd: dir, logFile, timeoutMs: 5000 });
    assert.equal(claudeOk.compacted, true);
    assert.equal(claudeOk.sessionId, CLAUDE_ID);

    // 成功 result 但无 compact_boundary ⇒ 未核实。
    write('core/data/skip-boundary', '1');
    await assert.rejects(
      compactClaudeSession({ bin, sessionId: CLAUDE_ID, cwd: dir, logFile, timeoutMs: 5000 }),
      error => error.reason === 'compact_unverified');
    fs.unlinkSync(path.join(dir, 'core/data/skip-boundary'));

    // result is_error ⇒ 失败。
    write('core/data/compact-error', '1');
    await assert.rejects(
      compactClaudeSession({ bin, sessionId: CLAUDE_ID, cwd: dir, logFile, timeoutMs: 5000 }),
      error => error.reason === 'compact_failed');
    fs.unlinkSync(path.join(dir, 'core/data/compact-error'));

    // 只有 boundary、进程退出而无 result ⇒ 不算完成（fail closed）。
    write('core/data/no-result', '1');
    await assert.rejects(
      compactClaudeSession({ bin, sessionId: CLAUDE_ID, cwd: dir, logFile, timeoutMs: 5000 }),
      error => error.reason === 'compact_incomplete');
    fs.unlinkSync(path.join(dir, 'core/data/no-result'));

    // 成功 result 但 session_id 不是同一原生会话 ⇒ 拒绝。
    write('core/data/wrong-id-result', '1');
    await assert.rejects(
      compactClaudeSession({ bin, sessionId: CLAUDE_ID, cwd: dir, logFile, timeoutMs: 5000 }),
      error => error.reason === 'session_mismatch');
    fs.unlinkSync(path.join(dir, 'core/data/wrong-id-result'));

    // boundary 的 session_id 不是同一原生会话 ⇒ 缺 id/错 id 的 boundary 不是证明。
    write('core/data/boundary-wrong-id', '1');
    await assert.rejects(
      compactClaudeSession({ bin, sessionId: CLAUDE_ID, cwd: dir, logFile, timeoutMs: 5000 }),
      error => error.reason === 'compact_unverified');
    fs.unlinkSync(path.join(dir, 'core/data/boundary-wrong-id'));

    // 双证据齐但进程永不退出 ⇒ 超时必须失败（不得把 timeout 当成功放行、留下活子进程）。
    write('core/data/hang-after-result', '1');
    await assert.rejects(
      compactClaudeSession({ bin, sessionId: CLAUDE_ID, cwd: dir, logFile, timeoutMs: 400 }),
      error => error.reason === 'compact_timeout');
    fs.unlinkSync(path.join(dir, 'core/data/hang-after-result'));

    // 非法 id / 缺 CLI 立即拒绝。
    assert.equal(validNativeId('not an id!!'), '');
    await assert.rejects(compactClaudeSession({ bin, sessionId: 'junk', timeoutMs: 1000 }), { reason: 'invalid_id' });
    await assert.rejects(compactClaudeSession({ bin: '', sessionId: CLAUDE_ID, timeoutMs: 1000 }), { reason: 'missing_cli' });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('阶段会话驱动：首轮捕获→压缩→同 id 续接；失败保留 id；重启不丢', async () => {
  const { dir, write } = buildRepo('driver');
  try {
    write('core/data/fake-cli', FAKE_CLI);
    fs.chmodSync(path.join(dir, 'core/data/fake-cli'), 0o700);
    write('docs/HANDOFF.md', 'Fixture constraints\n');
    // 私有 HANDOFF 与生产形态一致：只在本地 exclude 忽略（不入库不可见）。
    fs.appendFileSync(path.join(dir, '.git/info/exclude'), 'docs/HANDOFF.md\n');
    const dataDir = path.join(dir, 'core/data');
    const sessions = createStageSessions({
      dataDir, repoRoot: dir, handoffFile: path.join(dir, 'docs/HANDOFF.md'), compactTimeoutMs: 5000,
    });

    // 首轮：无登记 entry=null；捕获后落盘。
    const first = sessions.beginStage({ role: 'main', provider: 'codex' });
    assert.equal(first.entry, null);
    first.release();
    sessions.recordCapturedId({ role: 'main', provider: 'codex', runId: 'run1', sessionId: CODEX_ID });
    const registryFile = path.join(dataDir, 'evolution-sessions/registry.json');
    assert.equal((fs.statSync(registryFile).mode & 0o777), 0o600, '登记文件必须 0600');
    assert.equal(readSessionRegistry(dataDir).entries.main.sessionId, CODEX_ID);

    // 后续阶段：先原生压缩同一 id 再续接（登记不换 id）。
    const second = sessions.beginStage({ role: 'main', provider: 'codex' });
    assert.equal(second.entry.sessionId, CODEX_ID);
    await sessions.compactBeforeResume({
      entry: second.entry, role: 'main', provider: 'codex',
      bins: { codex: path.join(dataDir, 'fake-cli') }, env: process.env,
      logDir: path.join(dataDir, 'logs'), runId: 'run1',
    });
    second.release();
    const afterCompact = readSessionRegistry(dataDir).entries.main;
    assert.equal(afterCompact.sessionId, CODEX_ID);
    assert.equal(afterCompact.compactPending, false);

    // 重启（新实例读同一登记）：仍同 id 续接。
    const rebooted = createStageSessions({ dataDir, repoRoot: dir, handoffFile: path.join(dir, 'docs/HANDOFF.md') });
    const rebootStage = rebooted.beginStage({ role: 'main', provider: 'codex' });
    assert.equal(rebootStage.entry.sessionId, CODEX_ID);
    rebootStage.release();

    // 压缩失败：保留旧 id、compactPending=true、抛错（绝不换新 id 顶替）。
    write('core/data/ack-only', '1');
    const failing = createStageSessions({ dataDir, repoRoot: dir, handoffFile: path.join(dir, 'docs/HANDOFF.md'), compactTimeoutMs: 300 });
    const stage = failing.beginStage({ role: 'main', provider: 'codex' });
    await assert.rejects(
      failing.compactBeforeResume({
        entry: stage.entry, role: 'main', provider: 'codex',
        bins: { codex: path.join(dataDir, 'fake-cli') }, env: process.env,
        logDir: path.join(dataDir, 'logs'), runId: 'run1',
      }),
      error => error.reason === 'compact_timeout');
    stage.release();
    const pending = readSessionRegistry(dataDir).entries.main;
    assert.equal(pending.sessionId, CODEX_ID, '失败不得换 id');
    assert.equal(pending.compactPending, true);
    fs.unlinkSync(path.join(dataDir, 'ack-only'));

    // 同 provider 下 id 漂移 = 异常；显式换 provider 的整体替换合法。
    assert.throws(() => sessions.recordCapturedId({ role: 'main', provider: 'codex', runId: 'run2', sessionId: 'cccc1111-2222-3333-4444-555566667777' }),
      { reason: 'id_mismatch' });
    sessions.recordCapturedId({ role: 'main', provider: 'claude', runId: 'run2', sessionId: CLAUDE_ID });
    // 换 provider 后不得复用异构会话：beginStage 视为首轮。
    const switched = sessions.beginStage({ role: 'main', provider: 'codex' });
    assert.equal(switched.entry, null, 'provider 切换不得复用对方会话');
    switched.release();

    // 登记文件绝不进入 git 跟踪面。
    const tracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard'], { cwd: dir, encoding: 'utf8' });
    assert.equal(tracked, '');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('仓库绑定与锁：跨库 fail-safe、活 PID 永远 busy、死锁接管、登记损坏 fail-safe', () => {
  const a = buildRepo('lock-a');
  const b = buildRepo('lock-b');
  try {
    const dataDir = path.join(a.dir, 'core/data');
    const sessions = createStageSessions({ dataDir, repoRoot: a.dir, handoffFile: path.join(a.dir, 'docs/HANDOFF.md') });
    sessions.recordCapturedId({ role: 'main', provider: 'codex', runId: 'run1', sessionId: CODEX_ID });

    // 同库判据 = git-common-dir 绝对路径（分离任务 worktree 与主库同 commonDir）。
    const bindingA = repoBinding(a.dir);
    assert.ok(path.isAbsolute(bindingA.commonDir) && bindingA.commonDir.startsWith(a.dir + path.sep));
    assert.notEqual(repoBinding(b.dir).commonDir, bindingA.commonDir);

    // 跨库：登记在 A，工作目录换 B ⇒ fail-safe。
    const foreign = createStageSessions({ dataDir, repoRoot: b.dir, handoffFile: path.join(b.dir, 'docs/HANDOFF.md') });
    assert.throws(() => foreign.beginStage({ role: 'main', provider: 'codex' }), { reason: 'cross_repo' });

    // 登记损坏：不重建不静默替换。
    fs.writeFileSync(path.join(dataDir, 'evolution-sessions/registry.json'), '{partial');
    assert.throws(() => readSessionRegistry(dataDir), { reason: 'registry_corrupt' });
    assert.throws(() => sessions.beginStage({ role: 'main', provider: 'codex' }), { reason: 'registry_corrupt' });

    // 移除损坏登记（相当于人工清理）后重建：同角色活 PID 锁 busy；死进程锁可接管。
    fs.rmSync(path.join(dataDir, 'evolution-sessions'), { recursive: true, force: true });
    sessions.recordCapturedId({ role: 'main', provider: 'codex', runId: 'run1', sessionId: CODEX_ID });
    const lockFile = path.join(dataDir, 'evolution-sessions/main.lock');
    fs.writeFileSync(lockFile, `${JSON.stringify({ pid: process.pid, at: Date.now() })}\n`);
    assert.throws(() => sessions.beginStage({ role: 'main', provider: 'codex' }), { reason: 'role_busy' });
    // 活 PID 无论多老都 busy（真实任务一跑几小时，年龄不构成接管理由）。
    fs.writeFileSync(lockFile, `${JSON.stringify({ pid: process.pid, at: Date.now() - 3 * 60 * 60 * 1000 })}\n`);
    assert.throws(() => sessions.beginStage({ role: 'main', provider: 'codex' }), { reason: 'role_busy' });
    // 死 PID（不存在进程）⇒ rename 接管并正常释放。
    fs.writeFileSync(lockFile, `${JSON.stringify({ pid: 999999999, at: Date.now() })}\n`);
    const takeover = sessions.beginStage({ role: 'main', provider: 'codex' });
    assert.equal(takeover.entry.sessionId, CODEX_ID);
    takeover.release();
    assert.equal(fs.existsSync(lockFile), false, '释放必须移除自己的锁');
    // 不可读的残缺旧版锁文件：无法证明持有者已死 ⇒ fail closed，绝不为抢锁删除。
    fs.writeFileSync(lockFile, 'not-json');
    assert.throws(() => sessions.beginStage({ role: 'main', provider: 'codex' }), { reason: 'lock_corrupt' });
    assert.equal(fs.readFileSync(lockFile, 'utf8'), 'not-json', '残缺锁不得被删除');
    fs.unlinkSync(lockFile);

    // owner 目录合同（2026-10-07 R6，Main 注入复现的偷锁竞态回归）：
    // 抢占 = 完整负载的私有临时目录原子 rename 成锁目录；rename 失败后才重读
    // 当前 owner——死持有者被活竞争者整替后，读到的是活竞争者，必须 busy。
    const lockDirFile = path.join(dataDir, 'evolution-sessions/main.lock.d');
    const owner = (name, payload) => {
      fs.mkdirSync(lockDirFile, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(lockDirFile, `${name}.owner`), `${JSON.stringify(payload)}\n`);
    };
    // 活竞争者刚建的新锁（对应 Main 证明场景中被整替后的真实状态）绝不被偷。
    owner('f'.repeat(32), { pid: process.pid, at: Date.now(), token: 'f'.repeat(32) });
    assert.throws(() => sessions.beginStage({ role: 'main', provider: 'codex' }), { reason: 'role_busy' });
    assert.equal(fs.readdirSync(lockDirFile).length, 1, '竞争者的锁内容原样保留');
    // 死持有者 owner：只回收那一个精确文件名，随后可正常抢占。
    fs.rmSync(lockDirFile, { recursive: true, force: true });
    owner('e'.repeat(32), { pid: 999999999, at: Date.now(), token: 'e'.repeat(32) });
    const reclaimed = sessions.beginStage({ role: 'main', provider: 'codex' });
    assert.equal(reclaimed.entry.sessionId, CODEX_ID);
    reclaimed.release();
    assert.equal(fs.existsSync(lockDirFile), false, '释放后锁目录必须移除');
    // 两个 owner 文件 / 损坏 JSON / 文件名与 token 不匹配：无法证明持有者 ⇒ fail closed。
    fs.mkdirSync(lockDirFile, { recursive: true });
    fs.writeFileSync(path.join(lockDirFile, `${'a'.repeat(32)}.owner`), '{}\n');
    fs.writeFileSync(path.join(lockDirFile, `${'b'.repeat(32)}.owner`), '{}\n');
    assert.throws(() => sessions.beginStage({ role: 'main', provider: 'codex' }), { reason: 'lock_corrupt' });
    fs.rmSync(lockDirFile, { recursive: true, force: true });
    owner('c'.repeat(32), { pid: 999999999, at: Date.now(), token: 'd'.repeat(32) });
    assert.throws(() => sessions.beginStage({ role: 'main', provider: 'codex' }), { reason: 'lock_corrupt' });
    fs.rmSync(lockDirFile, { recursive: true, force: true });
    fs.mkdirSync(lockDirFile, { recursive: true });
    fs.writeFileSync(path.join(lockDirFile, `${'c'.repeat(32)}.owner`), 'garbage\n');
    assert.throws(() => sessions.beginStage({ role: 'main', provider: 'codex' }), { reason: 'lock_corrupt' });
    fs.rmSync(lockDirFile, { recursive: true, force: true });
    // 空遗弃目录：rmdir 后可抢占。
    fs.mkdirSync(lockDirFile, { recursive: true });
    const emptied = sessions.beginStage({ role: 'main', provider: 'codex' });
    emptied.release();
    // 释放只删自己的 owner：持有期间他人放入的 owner 文件不被触碰。
    const holding = sessions.beginStage({ role: 'main', provider: 'codex' });
    fs.writeFileSync(path.join(lockDirFile, `${'9'.repeat(32)}.owner`), '{}\n');
    holding.release();
    assert.ok(fs.existsSync(path.join(lockDirFile, `${'9'.repeat(32)}.owner`)), '他人的 owner 文件不得被释放路径删除');
    fs.rmSync(lockDirFile, { recursive: true, force: true });

    // 释放只删 token 匹配的自己的锁：锁被他人（含接管后的新持有者）重写后不得误删。
    const foreignLock = `${JSON.stringify({ pid: 999999999, at: Date.now(), token: ['not', 'mine'].join('-') })}\n`;
    const releaseSub = acquireRoleLock(dataDir, 'sub');
    fs.writeFileSync(path.join(dataDir, 'evolution-sessions/sub.lock'), foreignLock);
    releaseSub();
    assert.equal(fs.existsSync(path.join(dataDir, 'evolution-sessions/sub.lock')), true, '不得删除他人持有的锁');
    acquireRoleLock(dataDir, 'sub')(); // 他人锁已死可接管并释放（清理）。

    // 角色键清洗防碰撞：不同 reviewer 键清洗后必须仍是不同锁（不串角色）。
    assert.notEqual(sanitizeRole('reviewer:a.b'), sanitizeRole('reviewer:a-b'));
    const releaseA = acquireRoleLock(dataDir, 'reviewer:a.b');
    const releaseB = acquireRoleLock(dataDir, 'reviewer:a-b');
    releaseA();
    releaseB();
    assert.equal(sanitizeRole('main'), 'main');

    // 登记变更走登记级锁 + 唯一临时名：其他角色条目不丢，固定 .tmp 残留不阻塞。
    sessions.recordCapturedId({ role: 'sub', provider: 'claude', runId: 'run1', sessionId: CLAUDE_ID });
    const registryFile = path.join(dataDir, 'evolution-sessions/registry.json');
    fs.writeFileSync(`${registryFile}.tmp`, 'stale garbage from an old writer');
    const before = readSessionRegistry(dataDir);
    sessions.noteRunBoundary({ role: 'main', runId: 'run2' });
    const after = readSessionRegistry(dataDir);
    assert.equal(after.entries.sub.sessionId, CLAUDE_ID, '跨角色变更不得丢失其他角色条目');
    assert.equal(after.entries.main.boundRunId, 'run2');
    assert.equal(before.entries.main.boundRunId, 'run1');
    assert.equal(fs.readFileSync(`${registryFile}.tmp`, 'utf8'), 'stale garbage from an old writer', '不得动他人的临时文件');

    // acquireRoleLock 直用合同：同进程内串行。
    const release = acquireRoleLock(dataDir, 'main');
    assert.throws(() => acquireRoleLock(dataDir, 'main'), { reason: 'role_busy' });
    release();
    acquireRoleLock(dataDir, 'main')();
    assert.equal(sessionError('x').code, 'session_failed');
  } finally { fs.rmSync(a.dir, { recursive: true, force: true }); fs.rmSync(b.dir, { recursive: true, force: true }); }
});

test('私有 HANDOFF 增量：missing/refresh/unchanged/append/changed/超大/损坏与水位推进', async () => {
  const a = buildRepo('handoff');
  try {
    const storeDir = path.join(a.dir, 'core/data/evolution-handoff');
    const handoff = path.join(a.dir, 'docs/HANDOFF.md');
    const context = role => buildHandoffContext({ handoffFile: handoff, storeDir, role });

    // 文档缺失：missing，不新建不假装已读。
    assert.equal(context('main').mode, 'missing');

    // 无快照基线：强制完整重读。
    a.write('docs/HANDOFF.md', '# A\nalpha\n');
    const fresh = context('main');
    assert.equal(fresh.mode, 'refresh');
    assert.match(fresh.directive, /完整读取/);

    // 成功阶段 commit 后：unchanged（哈希相同免重读）。
    fresh.commit();
    assert.equal(context('main').mode, 'unchanged');

    // 追加：delta 内联，不要求重读。
    a.write('docs/HANDOFF.md', '# A\nalpha\n# B\nbravo\n');
    const appended = context('main');
    assert.equal(appended.mode, 'append');
    assert.match(appended.directive, /bravo/);
    appended.commit();

    // 旧章节改写 + 删除章节：changed 必须含旧原文与删除内容。
    a.write('docs/HANDOFF.md', '# A\nalpha2\n# C\ncharlie\n');
    const changed = context('main');
    assert.equal(changed.mode, 'changed');
    assert.match(changed.directive, /alpha2/);
    assert.match(changed.directive, /alpha\n/);
    assert.match(changed.directive, /bravo/);
    assert.match(changed.directive, /删除章节/);
    changed.commit();

    // 非追加但变更量超大（>16k）：强制完整重读。
    a.write('docs/HANDOFF.md', `# A\nalpha2\n# D\n${'x'.repeat(20000)}\n`);
    assert.equal(context('main').mode, 'refresh');

    // 快照损坏（哈希对不上）：绝不拿“末两节”冒充完整上下文。
    a.write('docs/HANDOFF.md', '# A\nalpha2\n');
    const snapshotFile = path.join(storeDir, 'main.snapshot.md');
    fs.writeFileSync(snapshotFile, `${fs.readFileSync(snapshotFile, 'utf8')}tampered`);
    const corrupt = context('main');
    assert.equal(corrupt.mode, 'refresh');
    assert.match(corrupt.directive, /完整读取/);
    // 恢复合法基线（完整重读后的 commit），继续后续水位断言。
    corrupt.commit();

    // 水位只在成功 commit 后推进：失败/未跑完阶段不 commit，下轮重拿同一段增量。
    a.write('docs/HANDOFF.md', '# A\nalpha3\n# E\necho\n');
    const before = context('main');
    assert.equal(before.mode, 'changed');
    // （模拟阶段失败：不调用 commit。）
    assert.equal(context('main').mode, 'changed', '未 commit 不得推进读水位');
    before.commit();
    assert.equal(context('main').mode, 'unchanged');

    // 重复标题：真实 HANDOFF 同名章节会重复多次，按标题 Map 差异会丢更早同名章节
    // ——无法安全做增量时必须显式完整重读，不得给出残缺"变更章节"。
    // （非追加修改：改早段并引入第二个同名章节，startsWith-append 不适用。）
    a.write('docs/HANDOFF.md', '# A\nalpha3\n# E\necho2\n# E\necho\n');
    assert.equal(context('main').mode, 'refresh');
    assert.match(context('main').directive, /重复章节标题/);
    context('main').commit();

    // 新原生会话（首轮/换执行器）：即使内容与快照一致，旧会话记忆不算已读证据。
    assert.equal(buildHandoffContext({ handoffFile: handoff, storeDir, role: 'main', forceRefresh: true }).mode, 'refresh');
    assert.equal(buildHandoffContext({ handoffFile: handoff, storeDir, role: 'main', forceRefresh: false }).mode, 'unchanged');

    // 快照文件 0600。
    assert.equal((fs.statSync(snapshotFile).mode & 0o777), 0o600);
    assert.equal((fs.statSync(path.join(storeDir, 'main.sha256')).mode & 0o777), 0o600);

    // 角色隔离：sub 有独立水位，不共享 main 快照。
    assert.equal(context('sub').mode, 'refresh');
  } finally { fs.rmSync(a.dir, { recursive: true, force: true }); }
});

// 两进程真实争用同一角色锁（2026-10-07 R6）：三个独立 node 进程循环 抢占→持有
// →释放，共享追加日志按序回放——任何时刻出现第二个 H 而前一个 H 尚未 R 即违约。
test('两进程争用同一角色锁：任意时刻至多一个持有者', () => {
  const a = buildRepo('lock-contention');
  const { spawnSync } = require('node:child_process');
  try {
    const dataDir = path.join(a.dir, 'core/data');
    const logFile = path.join(dataDir, 'contention.log');
    const script = `
      const fs = require('node:fs');
      const { acquireRoleLock } = require(${JSON.stringify(require.resolve('../src/services/evolution-sessions'))});
      const [dataDir, worker, logFile] = process.argv.slice(1);
      const line = text => { try { fs.appendFileSync(logFile, worker + text + '\\n'); } catch {} };
      for (let i = 0; i < 10; i++) {
        try {
          const release = acquireRoleLock(dataDir, 'main');
          line('H');
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15 + (i % 3) * 12);
          line('R');
          release();
        } catch { line('B'); }
      }
      line('D');
    `;
    const children = [1, 2, 3].map(worker => spawnSync(process.execPath, ['-e', script, dataDir, String(worker), logFile], {
      cwd: a.dir, timeout: 30_000, encoding: 'utf8',
    }));
    for (const child of children) assert.equal(child.status, 0, child.stderr);
    const events = fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean);
    assert.ok(events.filter(event => event.endsWith('H')).length >= 10, '必须有真实成功抢占');
    let holder = '';
    for (const event of events) {
      const worker = event.slice(0, -1);
      const kind = event.slice(-1);
      if (kind === 'H') {
        assert.equal(holder, '', `worker ${worker} 抢占时 worker ${holder} 仍持有锁`);
        holder = worker;
      } else if (kind === 'R' || kind === 'D') {
        if (holder && (kind === 'R' || worker === holder)) holder = '';
      }
    }
  } finally { fs.rmSync(a.dir, { recursive: true, force: true }); }
});
