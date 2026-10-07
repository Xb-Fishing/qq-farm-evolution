/**
 * 进化团队原生会话登记（私有、仅本地）。
 *
 * owner 2026-10-07 要求：双 Agent 团队不再每阶段冷启动 CLI——首轮捕获执行器
 * 原生会话/线程 id（Claude envelope.session_id / Codex exec --json 的
 * thread.started），此后每阶段先用**原生压缩**收缩同一会话，再以同一 id 续接。
 * 所有登记/快照/锁都落在被 ignore 的数据目录（0600/0700，原子写），绝不进入
 * git 或任何产品 API；代码里不含真实 id、模型或本机路径。
 *
 * 安全合同：
 * - 角色（main/sub/reviewer:<stablekey>）+ provider + 仓库三元绑定；换 provider、
 *   跨仓库（按 git-common-dir 判同库，分离任务 worktree 不算跨库）、id 形状
 *   非法、登记文件损坏——一律 fail-safe 抛错，绝不静默替换或新开 id 顶替。
 * - 压缩必须等到真实完成证据：Codex 走 app-server（initialize → thread/read →
 *   thread/resume → thread/compact/start，ack 返回 {} 不算完成，必须等到同线程
 *   item/completed(contextCompaction)）；Claude 走原生 /compact 续接同一
 *   session_id，stream 中必须出现 compact_boundary 事件且 result 成功。
 *   任何失败/超时/线程不符：保留旧 id 与记录、置 compactPending，上层安全停。
 * - 同角色并发调用用带存活 PID + 持有 token 的锁文件串行化；活 PID 永远 busy
 *   （EPERM 也算活，不看年龄），只有确认持有者已死才 rename 接管；释放只删
 *   token 匹配的自己的锁。登记表（registry.json）变更另走登记级锁 + 唯一临时名
 *   原子写 + 锁内同步重读，跨角色并发不丢条目。
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');

const NATIVE_ID_PATTERN = /^[a-f0-9-]{8,64}$/i;
const LINE_LIMIT = 1024 * 1024;
const HANDOFF_CONTEXT_LIMIT = 16000;

function sessionError(reason) {
  return Object.assign(new Error(`session:${reason}`), { code: 'session_failed', reason });
}

function validNativeId(value) {
  return typeof value === 'string' && NATIVE_ID_PATTERN.test(value.trim()) ? value.trim() : '';
}

// 角色键清洗：纯安全字符（main/sub）保持原名；任何被改写的键（如
// reviewer:a.b 与 reviewer:a-b）必须仍可区分——追加原文短哈希防碰撞串角色。
function sanitizeRole(role) {
  const raw = String(role ?? '');
  const clean = raw.replace(/[^\w-]/g, '_').slice(0, 80) || 'unknown';
  return clean === raw ? clean
    : `${clean}-${crypto.createHash('sha256').update(raw).digest('hex').slice(0, 10)}`;
}

function ensurePrivateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch {}
}

function writePrivateFile(file, text) {
  // 唯一临时名：跨进程并发原子写不得共用固定 .tmp（会互相覆盖/丢失写入）。
  const temp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temp, text, { mode: 0o600 });
    try { fs.chmodSync(temp, 0o600); } catch {}
    fs.renameSync(temp, file);
  } catch (error) {
    try { fs.unlinkSync(temp); } catch {}
    throw error;
  }
}

// ---- 登记表（0600 原子写；损坏即 fail-safe，不重建不覆盖） ----

function registryPath(dataDir) {
  return path.join(dataDir, 'evolution-sessions', 'registry.json');
}

function readSessionRegistry(dataDir) {
  const file = registryPath(dataDir);
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw sessionError('registry_unreadable'); return { version: 1, entries: {} }; }
  let value;
  try { value = JSON.parse(raw); } catch { throw sessionError('registry_corrupt'); }
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== 1
    || !value.entries || typeof value.entries !== 'object' || Array.isArray(value.entries)) {
    throw sessionError('registry_corrupt');
  }
  return value;
}

function writeSessionRegistry(dataDir, registry) {
  ensurePrivateDir(path.dirname(registryPath(dataDir)));
  writePrivateFile(registryPath(dataDir), `${JSON.stringify(registry, null, 2)}\n`);
}

// 登记变更专用互斥：角色锁只串行化同角色，不同角色并发读-改-写 registry.json
// 会互相丢条目——所有变更必须先拿登记级锁，锁内同步重读最新内容再合并写回
// （唯一临时名原子替换），保住每个角色的既有条目。锁序恒为 角色→registry，
// 不得反向嵌套。
function mutateRegistry(dataDir, mutate) {
  const release = acquireRoleLock(dataDir, 'registry');
  try {
    const registry = readSessionRegistry(dataDir);
    const skipWrite = mutate(registry) === false;
    if (!skipWrite) writeSessionRegistry(dataDir, registry);
    return registry;
  } finally {
    release();
  }
}

// ---- 仓库绑定：git-common-dir 是同库判据；分离任务 worktree 共属一库，不因
// 分离 HEAD 的空分支名误判跨库。remote/branch 只作记录。 ----

function repoBinding(repoRoot) {
  const run = args => execFileSync('git', args, {
    cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
  let commonDir;
  try { commonDir = path.resolve(repoRoot, run(['rev-parse', '--git-common-dir'])); }
  catch { throw sessionError('repo_unavailable'); }
  let remote = '';
  try { remote = run(['remote', 'get-url', 'origin']); } catch {}
  let branch = '';
  try {
    branch = run(['rev-parse', '--abbrev-ref', 'HEAD']);
    if (branch === 'HEAD' || branch === '(no branch)') branch = '';
  } catch {}
  return { commonDir, remote, branch };
}

// ---- 角色锁（owner 目录合同，2026-10-07 R6：rename-aside 会被「死持有者被活
// 竞争者整替」竞态偷锁——Main 以注入复现证明）。锁 = 目录 <role>.lock.d，持有
// 者在目录内放唯一 <token>.owner JSON 文件；抢占 = 把「已写好完整 owner 负载的
// 唯一私有临时目录」原子 rename 成锁目录（目标非空必失败）。接管只发生在
// rename 失败之后重读当前 owner：确认持有者进程已死才 unlink 那一个精确文件名
// （失败即停），再 rmdir——目录非空（竞争者已放入 owner）时 rmdir 必失败，绝不
// 碰竞争者的任何内容。存活 PID 永远 busy（EPERM 也算活，不看年龄）；owner 不可
// 读/不合法 = fail closed。旧版 <role>.lock 文件：PID 确认已死才可 unlink，不可
// 读一律 fail closed，绝不为抢锁删除可能仍有活持有者的旧文件。 ----

const OWNER_FILE_PATTERN = /^[0-9a-f]{32}\.owner$/;

function isPidAlive(value) {
  const pid = Number(value);
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

function acquireRoleLock(dataDir, role) {
  const dir = path.join(dataDir, 'evolution-sessions');
  ensurePrivateDir(dir);
  const name = sanitizeRole(role);
  const lockDir = path.join(dir, `${name}.lock.d`);
  const legacyFile = path.join(dir, `${name}.lock`);
  const token = crypto.randomBytes(16).toString('hex');
  const payload = JSON.stringify({ pid: process.pid, at: Date.now(), token });
  const claimTemp = path.join(dir, `.${name}.claim-${process.pid}-${token}`);
  const busy = (reason) => {
    try { fs.rmSync(claimTemp, { recursive: true, force: true }); } catch {}
    throw sessionError(reason);
  };
  // 唯一私有临时目录：完整 owner 负载先落盘，再原子 rename 抢占（目标存在且
  // 非空必失败——这就是「不能偷走竞争者刚建的新锁」的根）。
  const tryClaim = () => {
    try {
      fs.rmSync(claimTemp, { recursive: true, force: true });
      fs.mkdirSync(claimTemp, { mode: 0o700 });
      fs.writeFileSync(path.join(claimTemp, `${token}.owner`), `${payload}\n`, { mode: 0o600 });
      fs.renameSync(claimTemp, lockDir);
      return true;
    } catch { return false; }
    finally { try { fs.rmSync(claimTemp, { recursive: true, force: true }); } catch {} }
  };
  // 旧版 <role>.lock 文件先判：活持有者（含不可读）必须挡住目录抢占，绝不为抢锁
  // 删除可能仍被持有的旧文件；确认死持有者才 unlink 后再走目录合同。
  if (fs.existsSync(legacyFile)) {
    let holder;
    try { holder = JSON.parse(fs.readFileSync(legacyFile, 'utf8')); } catch { return busy('lock_corrupt'); }
    if (isPidAlive(holder?.pid)) return busy('role_busy');
    try { fs.unlinkSync(legacyFile); } catch { return busy('role_busy'); }
    return tryClaim() ? release : busy('role_busy');
  }
  if (tryClaim()) return release;
  // rename 失败：此刻重读真实状态再决定，绝不基于抢占前的旧观察接管。
  let entries;
  try { entries = fs.readdirSync(lockDir); } catch { return busy('role_busy'); }
  if (!entries.length) {
    // 空遗弃目录：rmdir 只可能删掉空目录；竞争者已放入 owner 时必失败。
    try { fs.rmdirSync(lockDir); } catch { return busy('role_busy'); }
    return tryClaim() ? release : busy('role_busy');
  }
  const ownerFiles = entries.filter(entry => OWNER_FILE_PATTERN.test(entry));
  if (ownerFiles.length !== 1) return busy('lock_corrupt');
  let holder;
  try { holder = JSON.parse(fs.readFileSync(path.join(lockDir, ownerFiles[0]), 'utf8')); } catch { return busy('lock_corrupt'); }
  if (typeof holder?.token !== 'string' || ownerFiles[0] !== `${holder.token}.owner`) return busy('lock_corrupt');
  if (isPidAlive(holder.pid)) return busy('role_busy');
  // 死持有者回收：只 unlink 这一个精确文件名；随后 rmdir 仅在目录为空时成功。
  try { fs.unlinkSync(path.join(lockDir, ownerFiles[0])); } catch { return busy('role_busy'); }
  try { fs.rmdirSync(lockDir); } catch { return busy('role_busy'); }
  return tryClaim() ? release : busy('role_busy');
  function release() {
    // 只移除自己的唯一 owner 文件，再 rmdir 空目录；他人的内容绝不触碰。
    try {
      fs.unlinkSync(path.join(lockDir, `${token}.owner`));
      fs.rmdirSync(lockDir);
    } catch {}
  }
}

// ---- 原生压缩：Claude（/compact 同 id，必须出现 compact_boundary + 成功 result） ----

function openEventLog(logFile) {
  if (!logFile) return null;
  try { return fs.openSync(logFile, 'a', 0o600); } catch { return null; }
}

function compactClaudeSession({ bin, sessionId, env, cwd, logFile, timeoutMs = 300000 }) {
  const id = validNativeId(sessionId);
  if (!bin) return Promise.reject(sessionError('missing_cli'));
  if (!id) return Promise.reject(sessionError('invalid_id'));
  return new Promise((resolve, reject) => {
    let child;
    try {
      // 直接调用 CLI 二进制（可能是原生 .exe 打包），绝不 `node CLAUDE_BIN`。
      // 实测安装版 CLI：print/stream-json 模式必须带 --verbose 才输出事件流。
      child = spawn(bin, ['-p', '--resume', id, '--output-format', 'stream-json', '--verbose'], {
        cwd, env, stdio: ['pipe', 'pipe', 'inherit'],
      });
    } catch { reject(sessionError('compact_spawn')); return; }
    const log = openEventLog(logFile);
    let buffer = '';
    let sawBoundary = false;
    let settled = false;
    let succeeded = false;
    const closeLog = () => { if (log != null) try { fs.closeSync(log); } catch {} };
    // 失败收尾（2026-10-07 R6）：有界 TERM→KILL 清理自己启动的这一个子进程，等它
    // 真实退出后才 reject——调用方绝不可在原生子进程仍可能写 stdout 时释放角色/
    // 推进快照。超时同样走失败路径：已见成功 result 但进程不退出也不是完成。
    const fail = (reason) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill('SIGTERM'); } catch {}
      const killTimer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 3000);
      const done = () => {
        clearTimeout(killTimer);
        closeLog();
        reject(sessionError(reason));
      };
      child.once('close', done);
      if (child.exitCode != null || child.signalCode) done();
      else setTimeout(done, 8000);
    };
    const timer = setTimeout(() => fail('compact_timeout'), timeoutMs);
    const inspectLine = (line) => {
      if (!line || line.length > LINE_LIMIT) return;
      let value;
      try { value = JSON.parse(line); } catch { return; }
      if (!value || typeof value !== 'object') return;
      // 双证据都必须携带并匹配同一个原生会话 id：缺 id 的 boundary 不是证明。
      if (value.type === 'system' && value.subtype === 'compact_boundary'
        && value.session_id === id) sawBoundary = true;
      if (value.type === 'result') {
        if (value.is_error || value.subtype !== 'success') return fail('compact_failed');
        if (!sawBoundary) return fail('compact_unverified');
        if (value.session_id !== id) return fail('session_mismatch');
        // 已见同 id boundary + 同 id 成功 result：等进程自然退出（close 且退出码 0
        // 无信号）再收尾，不在 result 与进程结局核对完之前当成功。
        succeeded = true;
      }
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      if (settled) return;
      if (log != null) { try { fs.writeSync(log, chunk); } catch {} }
      buffer += chunk;
      for (;;) {
        const index = buffer.indexOf('\n');
        if (index < 0) break;
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        inspectLine(line);
        if (settled) return;
      }
      if (buffer.length > LINE_LIMIT) buffer = '';
    });
    child.stdin.on('error', () => {});
    child.stdin.end('/compact');
    child.once('error', () => fail('compact_spawn'));
    child.once('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      closeLog();
      // 成功只认 close 退出码 0 且无信号；进程退出而从未完成双证据核对 = fail closed。
      if (succeeded && code === 0 && !signal) {
        return resolve({ provider: 'claude', sessionId: id, compacted: true });
      }
      reject(sessionError(succeeded ? 'compact_incomplete' : sawBoundary ? 'compact_incomplete' : 'compact_unverified'));
    });
  });
}

// ---- 原生压缩：Codex（app-server 同线程 thread/compact/start + 等待
// item/completed(contextCompaction)；ack {} ≠ 完成） ----

function compactCodexThread({ bin, threadId, env, cwd, logFile, timeoutMs = 300000 }) {
  const id = validNativeId(threadId);
  if (!bin) return Promise.reject(sessionError('missing_cli'));
  if (!id) return Promise.reject(sessionError('invalid_id'));
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(bin, ['app-server', '--stdio'], { cwd, env, stdio: ['pipe', 'pipe', 'inherit'] });
    } catch { reject(sessionError('compact_spawn')); return; }
    const log = openEventLog(logFile);
    const events = [];
    let buffer = '';
    let nextId = 0;
    let settled = false;
    const waiting = new Map();
    const send = (value) => { try { child.stdin.write(`${JSON.stringify(value)}\n`); } catch {} };
    const rpc = (method, params) => new Promise((res, rej) => {
      const requestId = ++nextId;
      waiting.set(requestId, { res, rej });
      send({ jsonrpc: '2.0', id: requestId, method, params });
    });
    const finish = (ok, reason, _result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (log != null) try { fs.closeSync(log); } catch {}
      try { child.stdin.end(); } catch {}
      try { child.kill('SIGTERM'); } catch {}
      if (ok) resolve({ provider: 'codex', threadId: id, compacted: true, events });
      else reject(sessionError(reason));
    };
    const timer = setTimeout(() => finish(false, 'compact_timeout'), timeoutMs);
    const onLine = (line) => {
      if (!line || line.length > LINE_LIMIT) return;
      let value;
      try { value = JSON.parse(line); } catch { return; }
      if (!value || typeof value !== 'object') return;
      if (value.id !== undefined && waiting.has(value.id)) {
        const handler = waiting.get(value.id);
        waiting.delete(value.id);
        if (value.error) handler.rej(sessionError('compact_rpc_error'));
        else handler.res(value.result);
        return;
      }
      if (value.method === 'item/started' || value.method === 'item/completed') {
        const params = value.params || {};
        if (params.threadId === id && params.item?.type === 'contextCompaction') {
          events.push({ method: value.method, type: params.item.type });
          if (value.method === 'item/completed') finish(true);
        }
        return;
      }
      if (value.method === 'error') return finish(false, 'compact_error');
      // 服务端主动请求（工具审批等）一律拒绝：压缩过程不授权任何工具。
      if (value.id !== undefined && value.method) {
        send({ jsonrpc: '2.0', id: value.id, error: { code: -32601, message: 'session driver does not authorize tool requests' } });
      }
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      if (settled) return;
      if (log != null) { try { fs.writeSync(log, chunk); } catch {} }
      buffer += chunk;
      for (;;) {
        const index = buffer.indexOf('\n');
        if (index < 0) break;
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        onLine(line);
        if (settled) return;
      }
      if (buffer.length > LINE_LIMIT) buffer = '';
    });
    child.once('error', () => finish(false, 'compact_spawn'));
    child.once('close', () => { if (!settled) finish(false, 'compact_incomplete'); });
    (async () => {
      await rpc('initialize', { clientInfo: { name: 'farm-evolution-session-driver', version: '1.0' }, capabilities: { experimentalApi: true } });
      send({ jsonrpc: '2.0', method: 'initialized', params: {} });
      const read = await rpc('thread/read', { threadId: id, includeTurns: false });
      if (read?.thread?.id !== id) throw sessionError('thread_mismatch');
      const resumed = await rpc('thread/resume', { threadId: id, cwd, sandbox: 'read-only', approvalPolicy: 'never', excludeTurns: true });
      if (resumed?.thread?.id !== id) throw sessionError('thread_mismatch');
      await rpc('thread/compact/start', { threadId: id });
      // ack 已收到，等待 item/completed(contextCompaction)（onLine 收尾）。
    })().catch(error => finish(false, error?.reason || 'compact_error'));
  });
}

// ---- 私有 HANDOFF 增量交接（owner 2026-10-07 覆盖旧“每阶段完整重读”） ----

function splitSections(text) {
  const sections = [];
  let current = { heading: '', lines: [] };
  for (const line of String(text).split('\n')) {
    if (/^#{1,6} /.test(line)) {
      if (current.lines.some(item => item.trim())) sections.push(current);
      current = { heading: line.trim(), lines: [line] };
    } else current.lines.push(line);
  }
  if (current.lines.some(item => item.trim())) sections.push(current);
  return sections.map(section => ({ heading: section.heading, text: section.lines.join('\n') }));
}

// 真实 HANDOFF 同一标题会重复几十次：按标题做 Map 差异会静默丢掉更早的同名
// 章节（还有重排/位移）。存在任何重复标题时无法安全做增量，必须显式完整重读。
function hasDuplicateHeadings(sections) {
  const seen = new Set();
  for (const section of sections) {
    if (seen.has(section.heading)) return true;
    seen.add(section.heading);
  }
  return false;
}

function renderHandoffChanges(changes) {
  const parts = [];
  for (const change of changes) {
    const label = change.heading || '（文档开头/头部）';
    if (change.old == null) parts.push(`新增章节 ${label}：\n${change.now}`);
    else if (change.now == null) parts.push(`删除章节 ${label}（原文）：\n${change.old}`);
    else parts.push(`修改章节 ${label}\n旧：\n${change.old}\n新：\n${change.now}`);
  }
  return parts.join('\n\n');
}

function buildHandoffContext({ handoffFile, storeDir, role, forceRefresh = false }) {
  ensurePrivateDir(storeDir);
  const base = path.join(storeDir, sanitizeRole(role));
  const snapshotFile = `${base}.snapshot.md`;
  const shaFile = `${base}.sha256`;
  let current = null;
  try { current = fs.readFileSync(handoffFile, 'utf8'); } catch { current = null; }
  let snapshot = null;
  let snapshotSha = '';
  try {
    snapshot = fs.readFileSync(snapshotFile, 'utf8');
    snapshotSha = fs.readFileSync(shaFile, 'utf8').trim();
  } catch { snapshot = null; }
  const snapshotValid = snapshot != null && /^[0-9a-f]{64}$/.test(snapshotSha)
    && crypto.createHash('sha256').update(snapshot).digest('hex') === snapshotSha;
  const commit = () => {
    if (current == null || committed) return;
    committed = true;
    writePrivateFile(snapshotFile, current);
    writePrivateFile(shaFile, `${crypto.createHash('sha256').update(current).digest('hex')}\n`);
  };
  let committed = false;
  if (current == null) {
    return {
      mode: 'missing',
      directive: 'docs/HANDOFF.md 当前不存在或不可读：本轮无法做增量交接，也不得声称已读。先按运行约束处理交接文档缺失（只读阶段如实报告，不新建），implement/repair 阶段须先恢复该私有文档再继续。',
      commit,
    };
  }
  if (forceRefresh) {
    // 新原生会话（首轮或执行器切换）：上个会话的快照记忆不能当作本会话的已读
    // 上下文——旧会话的"记忆"对本会话是外来记忆，必须完整首读建立自己的基线。
    return {
      mode: 'refresh',
      directive: '本阶段开启了新的原生会话：此前的交接快照不构成你已读过的证据，第一项操作必须从头到尾完整读取 docs/HANDOFF.md（本轮首次完整读取），读完前禁止搜索源码、日志、diff 或提出方案。',
      commit,
    };
  }
  if (!snapshotValid) {
    // 基线缺失/损坏：绝不假装“只看末两节就是完整上下文”，必须显式完整重读。
    return {
      mode: 'refresh',
      directive: '私有交接的增量基线缺失或损坏：第一项操作必须从头到尾完整读取 docs/HANDOFF.md（本轮首次完整读取），读完前禁止搜索源码、日志、diff 或提出方案。',
      commit,
    };
  }
  const currentSha = crypto.createHash('sha256').update(current).digest('hex');
  if (currentSha === snapshotSha) {
    return {
      mode: 'unchanged',
      directive: 'HANDOFF 增量核验：内容与上个成功阶段快照完全一致（哈希相同），本轮无需重读 docs/HANDOFF.md；以本提示中的当前约束与阶段交接为准。',
      commit,
    };
  }
  if (current.startsWith(snapshot)) {
    const appended = current.slice(snapshot.length).trim();
    if (appended.length <= HANDOFF_CONTEXT_LIMIT) {
      return {
        mode: 'append',
        directive: `HANDOFF 增量核验：自上个成功阶段仅追加了以下内容（已替代完整重读；此前内容沿用你已核验的快照上下文）：\n${appended}`,
        commit,
      };
    }
  }
  const oldSections = splitSections(snapshot);
  const newSections = splitSections(current);
  if (hasDuplicateHeadings(oldSections) || hasDuplicateHeadings(newSections)) {
    return {
      mode: 'refresh',
      directive: '私有交接出现重复章节标题（或章节重排），无法安全生成增量：第一项操作必须从头到尾完整读取 docs/HANDOFF.md，读完前禁止搜索源码、日志、diff 或提出方案。',
      commit,
    };
  }
  const changes = renderHandoffChanges((() => {
    const oldMap = new Map(oldSections.map(section => [section.heading, section]));
    const newMap = new Map(newSections.map(section => [section.heading, section]));
    const result = [];
    for (const section of newSections) {
      const before = oldMap.get(section.heading);
      if (!before || before.text !== section.text) result.push({ heading: section.heading, old: before ? before.text : null, now: section.text });
    }
    for (const section of oldSections) if (!newMap.has(section.heading)) result.push({ heading: section.heading, old: section.text, now: null });
    return result;
  })());
  if (changes && changes.length <= HANDOFF_CONTEXT_LIMIT) {
    return {
      mode: 'changed',
      directive: `HANDOFF 增量核验：出现非追加修改，以下是全部变更章节（含删除/修订的旧原文与头部文字，已替代完整重读）：\n${changes}`,
      commit,
    };
  }
  return {
    mode: 'refresh',
    directive: '私有交接变更量超出增量注入上限：第一项操作必须从头到尾完整读取 docs/HANDOFF.md，读完前禁止搜索源码、日志、diff 或提出方案。',
    commit,
  };
}

// ---- 阶段会话驱动（runner runStage 专用） ----

function createStageSessions({ dataDir, repoRoot, handoffFile, compactTimeoutMs = 300000 }) {
  const handoffStore = path.join(dataDir, 'evolution-handoff');
  const binding = repoBinding(repoRoot);

  const loadEntry = (registry, role) => {
    const entry = registry.entries[role];
    if (entry === undefined) return null;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw sessionError('entry_corrupt');
    if (!['claude', 'codex'].includes(entry.provider)) throw sessionError('entry_corrupt');
    if (!validNativeId(entry.sessionId)) throw sessionError('entry_corrupt');
    if (!entry.repo || typeof entry.repo.commonDir !== 'string' || !entry.repo.commonDir) throw sessionError('entry_corrupt');
    return entry;
  };

  return {
    repoBinding: binding,
    /** 阶段开始：拿角色锁、校验登记项（provider/仓库/形状）。entry=null 表示首轮。 */
    beginStage({ role, provider }) {
      if (!['claude', 'codex'].includes(provider)) throw sessionError('unknown_provider');
      const release = acquireRoleLock(dataDir, role);
      try {
        const registry = readSessionRegistry(dataDir);
        let entry = loadEntry(registry, role);
        if (entry) {
          // 跨仓库（按 git-common-dir）fail-safe；显式换 provider 则不复用异构会话
          // （新一轮捕获后整体替换，不拿别的 provider 的会话续接）。
          if (entry.repo.commonDir !== binding.commonDir) throw sessionError('cross_repo');
          if (entry.provider !== provider) entry = null;
        }
        return { entry, provider, binding, release };
      } catch (error) {
        release();
        throw error;
      }
    },
    /** 后续阶段：先原生压缩同一 id（失败保留记录并抛错，绝不换新 id）。 */
    async compactBeforeResume({ entry, role, provider, bins, env, logDir, runId }) {
      if (!entry) throw sessionError('no_entry');
      mutateRegistry(dataDir, (registry) => {
        const current = registry.entries[role];
        if (!current || current.sessionId !== entry.sessionId) throw sessionError('entry_lost');
        registry.entries[role] = { ...current, compactPending: true, updatedAt: Date.now() };
      });
      const logFile = path.join(logDir, `evolve-session-${sanitizeRole(role)}-compact-${String(runId || 'run').replace(/[^\w-]/g, '_')}.log`);
      try {
        const result = provider === 'claude'
          ? await compactClaudeSession({ bin: bins[provider], sessionId: entry.sessionId, env, cwd: repoRoot, logFile, timeoutMs: compactTimeoutMs })
          : await compactCodexThread({ bin: bins[provider], threadId: entry.sessionId, env, cwd: repoRoot, logFile, timeoutMs: compactTimeoutMs });
        mutateRegistry(dataDir, (registry) => {
          const current = registry.entries[role];
          if (!current || current.sessionId !== entry.sessionId) throw sessionError('entry_lost');
          registry.entries[role] = { ...current, compactPending: false, lastCompactAt: Date.now(), updatedAt: Date.now() };
        });
        return result;
      } catch (error) {
        // 失败保留旧 id 与记录（compactPending=true），上层安全停。
        try {
          mutateRegistry(dataDir, (registry) => {
            const current = registry.entries[role];
            if (current && current.sessionId === entry.sessionId) {
              registry.entries[role] = { ...current, compactPending: true, updatedAt: Date.now() };
            }
          });
        } catch {}
        throw error?.code === 'session_failed' ? error : sessionError(error?.reason || 'compact_failed');
      }
    },
    /** 首轮：登记捕获到的原生 id（真实 CLI 输出，绝不信模型文本里的假 id）。 */
    recordCapturedId({ role, provider, runId, sessionId }) {
      const id = validNativeId(sessionId);
      if (!id) throw sessionError('invalid_id');
      mutateRegistry(dataDir, (registry) => {
        const existing = loadEntry(registry, role);
        // 同 provider 下 id 漂移 = 异常；显式换 provider 的整体替换是合法配置变更。
        if (existing && existing.sessionId !== id && existing.provider === provider) throw sessionError('id_mismatch');
        registry.entries[role] = {
          ...(existing || {}),
          role, provider, sessionId: id, repo: binding, boundRunId: String(runId || ''),
          createdAt: existing?.createdAt || Date.now(), updatedAt: Date.now(),
          lastCompactAt: existing?.lastCompactAt || 0,
          compactPending: false,
        };
      });
    },
    /** 换轮（新候选）仍复用持久会话，但记录边界：旧批准不携带授权由阶段提示约束。 */
    noteRunBoundary({ role, runId }) {
      mutateRegistry(dataDir, (registry) => {
        const entry = registry.entries[role];
        if (!entry || entry.boundRunId === String(runId || '')) return false;
        registry.entries[role] = { ...entry, boundRunId: String(runId || ''), updatedAt: Date.now() };
      });
    },
    handoffDirectiveFor(role, options = {}) {
      return buildHandoffContext({ handoffFile, storeDir: handoffStore, role, forceRefresh: options.forceRefresh === true });
    },
  };
}

module.exports = {
  createStageSessions,
  buildHandoffContext,
  compactClaudeSession,
  compactCodexThread,
  readSessionRegistry,
  repoBinding,
  acquireRoleLock,
  sessionError,
  validNativeId,
  sanitizeRole,
};
