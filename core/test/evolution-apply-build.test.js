'use strict';
// 应用 helper（evolution-apply-process.js v2）真实行为回归：
// - /proc 身份、端口 socket 归属、僵尸态判定直接对着真实内核状态验证（僵尸用
//   「Node 父进程阻塞事件循环不 wait」的真实父子制造，不靠 shell trap 猜想）；
// - 主流程在真实 tmux pane 里端到端跑：fake Bot 由 pane shell 前台启动，helper
//   走「构建 → 身份守卫停止（含 TERM 忽略子进程的 KILL 兜底）→ 端口释放 → dist
//   切换 → 原 pane 送键 --restart → ready 回执」全链路；特殊字符环境变量（含
//   $() 与反引号）经 0600 context 文件往返不丢；私有上下文用后即删；同 pane 后台
//   实例与其他 pane 实例不被误伤；两次应用后新 Bot 都保持原 pane 后代；
// - helper 作为 Bot 后代运行（生产拓扑）：其祖先分支（含同分支的 updater 类
//   常驻进程）被排除在停止集合外，其余 Bot 子树照常停止；
// - 旁观端口持有者、脏工作区、自主开关关闭三类失败都必须发生在停服之前；
// - 二批（2026-10-08）：真实 ready 落盘「最近一次 ready」验收证书（目标快照 +
//   实测验证摘要 + 验收时溯源 + 进程身份，0600），失败应用保留既有证书，成功
//   应用原子更新；pane 残留未提交 restart 行的真实事故回归——旧 helper（HEAD
//   版本真进程）在残行后拼接命令而真实失败，新 helper 单事务 C-u 清行后成功
//   重启预期 marker Bot。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync, spawn, spawnSync } = require('node:child_process');

// ---------------------------------------------------------------------------
// 生产形态钩子注入下的夹具隔离（2026-10-07 修复，与 evolution-autonomy 轮同类）：
// 协调进程环境注入 GIT_CONFIG_COUNT/KEY_*/VALUE_*（core.hooksPath=scripts/
// evolution-hooks，真实 pre-push 无条件拒绝推送）。本文件目标根切换夹具的
// bare 远端推送、任务区推送与被测服务/apply helper 的内部 git 调用都继承
// process.env，注入会把它们全部误杀。处理：被 runner 直接执行时，先在净化后的
// 环境副本中重执行自身（专属子进程，覆盖夹具初始化、两次连续目标根切换与全部
// 推送）；宿主进程 env、协调进程注入与 no-push 钩子本身零改动。成功与失败路径
// 的收尾都核对宿主 GIT_CONFIG_* 快照、候选源码与工作区指纹不变。
// ---------------------------------------------------------------------------
const SANDBOX_ENV = 'FARM_EVOLUTION_TEST_GIT_SANDBOX';
const GIT_CONFIG_ENV_RE = /^GIT_CONFIG_(?:COUNT|KEY_\d+|VALUE_\d+)$/;
function sanitizeGitConfigEnv(env) {
  const clean = { ...env };
  for (const key of Object.keys(clean)) { if (GIT_CONFIG_ENV_RE.test(key)) delete clean[key]; }
  return clean;
}
function gitConfigSnapshot() {
  const entries = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (GIT_CONFIG_ENV_RE.test(key)) entries[key] = value;
  }
  return entries;
}
const GUARD_ROOT = path.join(__dirname, '..', '..');
const GUARD_SOURCES = [
  'core/scripts/evolution-apply-process.js',
  'core/src/services/evolution-publish.js',
  'core/src/services/evolution-validation.js',
];
function candidateFingerprint() {
  const hash = crypto.createHash('sha256');
  const gitRaw = args => execFileSync('git', args,
    { cwd: GUARD_ROOT, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  hash.update(gitRaw(['rev-parse', 'HEAD']));
  // porcelain 原始输出：首列是固定状态位，绝不做整体 trim（既有硬门）。
  hash.update(gitRaw(['status', '--porcelain', '-z', '--untracked-files=normal']));
  for (const rel of GUARD_SOURCES) hash.update(fs.readFileSync(path.join(GUARD_ROOT, rel)));
  return hash.digest('hex');
}
if (require.main === module && process.env[SANDBOX_ENV] !== '1') {
  const envBefore = JSON.stringify(gitConfigSnapshot());
  const fingerprintBefore = candidateFingerprint();
  let code = 1;
  try {
    const child = spawnSync(process.execPath, [...process.execArgv, __filename], {
      env: { ...sanitizeGitConfigEnv(process.env), [SANDBOX_ENV]: '1' }, stdio: 'inherit',
    });
    code = child.status === 0 ? 0 : 1;
  } finally {
    if (JSON.stringify(gitConfigSnapshot()) !== envBefore || candidateFingerprint() !== fingerprintBefore) {
      process.stderr.write('host GIT_CONFIG_* env or candidate fingerprint changed during fixtures\n');
      code = 1;
    }
  }
  process.exit(code);
}

const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const { test } = require('node:test');
const helper = require('../scripts/evolution-apply-process');

const HELPER_SOURCE = path.join(__dirname, '../scripts/evolution-apply-process.js');
const HELPER_CODE = fs.readFileSync(HELPER_SOURCE, 'utf8');
/** 以原始字节（-H hex）向 pane 送字面文本：以 '-' 开头的文本会被 send-keys 的
 * 选项解析吞掉，-H 按字节无歧义（与 helper 单事务送键同机制）。 */
function sendLiteral(target, text) {
  const bytes = Buffer.from(text, 'utf8');
  tmux(['send-keys', '-t', target, '-H', ...bytes.toString('hex').match(/../g)]);
}
const SPECIAL_ENV = 'a"b $d \\e 空格 ;分号 $(echo hi) `tick`';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const shq = value => `'${String(value).replace(/'/g, `'\\''`)}'`;
const tmux = args => execFileSync('tmux', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

const BOT_SCRIPT = `
const http = require('node:http');
const fs = require('node:fs');
const port = Number(process.argv[2]);
const evidence = process.argv[3];
const record = entry => fs.appendFileSync(evidence, JSON.stringify(entry) + '\\n');
record({ pid: process.pid, ppid: process.ppid, special: process.env.BOT_SPECIAL || '',
  farm: process.env.FARM_DATA_DIR || '' });
if (process.env.BOT_IGNORE_TERM_CHILD === '1') {
  const child = require('node:child_process').spawn(process.execPath, ['-e',
    'process.on("SIGTERM", () => {});process.stdout.write(String(process.pid));setInterval(() => {}, 1000);'],
    { stdio: ['ignore', 'pipe', 'ignore'] });
  let out = '';
  child.stdout.on('data', chunk => {
    out += chunk;
    const pid = Number(out.trim());
    if (pid) record({ childPid: pid });
  });
}
if (process.env.BOT_SPAWN_MID === '1') {
  require('node:child_process').spawn('bash',
    [process.env.BOT_MID_SCRIPT, process.env.BOT_CMD_FILE, process.env.BOT_UPDATER_PID_FILE],
    { stdio: 'ignore' });
}
if (process.env.BOT_NO_LISTEN !== '1') {
  http.createServer((req, res) => {
    if (req.url === '/api/health') { res.setHeader('content-type', 'application/json'); res.end('{"ok":true}'); }
    else { res.statusCode = 404; res.end('{}'); }
  }).listen(port, '127.0.0.1');
}
setInterval(() => {}, 1e9);
`;

// mid 分支：helper 经它启动（helper 因此是 Bot 后代，同生产拓扑）；同分支的
// sleep600 是必须被排除在停止集合外的 updater 类常驻进程。等测试写入命令文件后
// 才启动 helper。
const MID_SCRIPT = `#!/bin/sh
sleep 600 &
echo $! > "$2"
while [ ! -s "$1" ]; do sleep 0.2; done
sh -c "$(cat "$1")" &
wait
`;

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function healthOk(port) {
  return new Promise((resolve) => {
    const request = http.get({ host: '127.0.0.1', port, path: '/api/health', timeout: 1500 }, (response) => {
      let body = '';
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => { try { resolve(JSON.parse(body).ok === true); } catch { resolve(false); } });
    });
    request.once('error', () => resolve(false));
  });
}

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(200);
  }
  throw new Error(`等待超时：${label}`);
}

function readEvidence(file) {
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
}

/** 独立 fixture 仓库 + 真实 tmux pane（fake Bot 由 pane shell 前台运行）。
 * helperSource 可注入旧版 helper（从 git HEAD 提取）做真实行为反例。 */
function buildFixture(t, { helperSource = HELPER_CODE } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'farm-apply2-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'repo');
  const dataDir = path.join(root, 'core', 'data');
  const session = `farmapply${process.pid}${Date.now().toString(36)}`;
  fs.mkdirSync(path.join(root, 'core', 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'logs'), { recursive: true });
  fs.mkdirSync(path.join(root, 'tmp'));
  fs.mkdirSync(path.join(root, 'web', 'dist'), { recursive: true });
  fs.writeFileSync(path.join(root, '.gitignore'), 'tmp/\ncore/data/\nweb/dist/\n');
  fs.writeFileSync(path.join(root, 'core/scripts/evolution-apply-process.js'), helperSource);
  fs.writeFileSync(path.join(root, 'web/package.json'), JSON.stringify({ name: 'web', private: true, scripts: { build: 'node build.cjs' } }));
  fs.writeFileSync(path.join(root, 'web/build.cjs'),
    "const fs=require('fs');let out='dist';for(let i=2;i<process.argv.length;i++){if(process.argv[i]==='--outDir')out=process.argv[i+1];}"
    + "fs.mkdirSync(out,{recursive:true});fs.writeFileSync(require('path').join(out,'index.html'),'rebuilt');\n");
  fs.writeFileSync(path.join(root, 'web/dist/index.html'), 'old UI');
  const botScript = path.join(dir, 'bot.cjs');
  fs.writeFileSync(botScript, BOT_SCRIPT);
  const midScript = path.join(dir, 'mid.sh');
  fs.writeFileSync(midScript, MID_SCRIPT);
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }).trim();
  git(['init', '-q']);
  git(['-c', 'user.name=fixture', '-c', 'user.email=fixture@invalid', 'add', '.']);
  git(['-c', 'user.name=fixture', '-c', 'user.email=fixture@invalid', 'commit', '-qm', 'fixture']);
  const head = git(['rev-parse', 'HEAD']);
  tmux(['-f', '/dev/null', 'new-session', '-d', '-s', session, '-c', root, '-x', '200', '-y', '50']);
  // 只清理本 fixture 自己创建的会话；默认 tmux server 上其他会话（farm 等）绝不触碰。
  t.after(() => { try { tmux(['kill-session', '-t', session]); } catch {} });
  return {
    root, dataDir, head, session, target: `${session}:0.0`, git, botScript, midScript,
    helper: path.join(root, 'core/scripts/evolution-apply-process.js'),
    /** --restart 分支的 Bot stdio 指向日志文件而非 pty，SIGHUP 不传导：按证据 PID 收尾。 */
    killEvidencePids() {
      try {
        for (const entry of readEvidence(path.join(dataDir, 'bot-evidence.jsonl'))) {
          for (const pid of [entry.pid, entry.childPid].filter(Number.isInteger)) {
            try { process.kill(pid, 'SIGKILL'); } catch {}
          }
        }
      } catch {}
    },
  };
}

async function startBot(f, port, { termChild = false, listen = true, mid = false } = {}) {
  const evidence = path.join(f.dataDir, 'bot-evidence.jsonl');
  const assignment = [
    `BOT_SPECIAL=${shq(SPECIAL_ENV)}`,
    ...(termChild ? ['BOT_IGNORE_TERM_CHILD=1'] : []),
    ...(listen ? [] : ['BOT_NO_LISTEN=1']),
    ...(mid ? [
      `BOT_SPAWN_MID=1`,
      `BOT_MID_SCRIPT=${shq(f.midScript)}`,
      `BOT_CMD_FILE=${shq(path.join(f.dataDir, 'mid-cmd'))}`,
      `BOT_UPDATER_PID_FILE=${shq(path.join(f.dataDir, 'updater.pid'))}`,
    ] : []),
  ].join(' ');
  const command = `${assignment} ${shq(process.execPath)} ${shq(f.botScript)} ${port} ${shq(evidence)}`;
  tmux(['send-keys', '-t', f.target, '-l', command]);
  tmux(['send-keys', '-t', f.target, 'Enter']);
  await waitFor(async () => (listen ? healthOk(port) : fs.existsSync(evidence)), 10_000, 'fake Bot 启动');
  return evidence;
}

function helperArgs(f, { botPid, botStarttime, port, autonomy = false }) {
  return ['--bot-pid', String(botPid), '--bot-starttime', botStarttime, '--expected-head', f.head,
    '--tmux-target', f.target, '--data-dir', f.dataDir, '--admin-port', String(port),
    ...(autonomy ? ['--autonomy', '1'] : [])];
}

async function runApply(f, options, { watch = false } = {}) {
  const receiptFile = path.join(f.dataDir, 'evolution-apply-receipt.json');
  const phases = new Set();
  const watcher = watch
    ? setInterval(() => { try { phases.add(JSON.parse(fs.readFileSync(receiptFile, 'utf8')).phase); } catch {} }, 30)
    : null;
  const child = spawn(process.execPath, [f.helper, ...helperArgs(f, options)], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const code = await new Promise(resolve => child.once('exit', resolve));
  if (watcher) clearInterval(watcher);
  let receipt = null;
  try { receipt = JSON.parse(fs.readFileSync(receiptFile, 'utf8')); } catch {}
  return { code, stderr, receipt, phases };
}

/** 生产拓扑：helper 由 Bot 的后代分支（mid）启动，同分支的 updater 常驻进程
 * 必须被停止集合排除；命令经文件传递，mid 收到后才真正启动 helper。 */
async function runApplyViaDescendant(f, options) {
  const cmdFile = path.join(f.dataDir, 'mid-cmd');
  const errLog = path.join(f.dataDir, 'helper-descendant.err');
  const receiptFile = path.join(f.dataDir, 'evolution-apply-receipt.json');
  fs.writeFileSync(cmdFile,
    `${shq(process.execPath)} ${shq(f.helper)} ${helperArgs(f, options).map(shq).join(' ')} 2>${shq(errLog)}`);
  await waitFor(() => {
    try { return ['ready', 'failed', 'ready-timeout'].includes(JSON.parse(fs.readFileSync(receiptFile, 'utf8')).phase); }
    catch { return false; }
  }, 120_000, 'Bot 后代分支的应用收口');
  return { receipt: JSON.parse(fs.readFileSync(receiptFile, 'utf8')), stderr: fs.readFileSync(errLog, 'utf8') };
}

const alive = (pid, starttime) => helper.aliveNonZombie(pid, starttime);

test('apply helper 的 /proc 身份、socket 归属与僵尸判定来自真实内核状态', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'farm-apply-proc-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const self = helper.readStat(process.pid);
  assert.ok(self && Number.isInteger(self.ppid) && self.ppid >= 0);
  assert.match(self.starttime, /^\d+$/);
  assert.equal(helper.isDescendantOf(process.pid, process.pid), true);
  assert.equal(helper.isDescendantOf(process.pid, 1), false);
  // starttime 守卫：不匹配视为已停（PID 复用保护）。
  assert.equal(alive(process.pid, '0'), false);
  assert.equal(alive(process.pid, self.starttime), true);

  // 端口归属：真实 LISTEN socket 的 inode 只属于持有进程。
  const port = await freePort();
  const server = http.createServer(() => {});
  t.after(() => server.close());
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  const inodes = helper.listeningInodes(port);
  assert.ok(inodes.size >= 1);
  assert.equal(helper.holdsSocket(process.pid, inodes), true);
  const sleeper = spawn('sleep', ['5'], { stdio: 'ignore' });
  t.after(() => { try { sleeper.kill('SIGKILL'); } catch {} });
  assert.equal(helper.holdsSocket(sleeper.pid, inodes), false);
  assert.equal(helper.listeningInodes(1).size, 0);

  // 僵尸态（Z）：Node 父 spawn 子后阻塞事件循环（libuv 无法 reap），子退出后
  // 成为可验证的僵尸——kill(pid,0) 仍成功，必须视为已停。内层脚本用 JSON.stringify
  // 拼接，避免手写转义在单引号字符串里坍塌成语法错误。
  const zpidFile = path.join(dir, 'zombie.pid');
  const grandchild = 'require("node:fs").writeFileSync(process.env.ZPID, String(process.pid));';
  const parentScript = 'const cp = require("node:child_process");'
    + `cp.spawn(process.execPath, ["-e", ${JSON.stringify(grandchild)}], { stdio: "ignore" });`
    + 'while (true) {}';
  const blocker = spawn(process.execPath, ['-e', parentScript],
    { stdio: 'ignore', env: { ...process.env, ZPID: zpidFile } });
  t.after(() => { try { blocker.kill('SIGKILL'); } catch {} });
  await waitFor(() => {
    try {
      return helper.readStat(Number(fs.readFileSync(zpidFile, 'utf8').trim()))?.state === 'Z';
    } catch { return false; }
  }, 8000, '僵尸子进程出现');
  const zombiePid = Number(fs.readFileSync(zpidFile, 'utf8').trim());
  const zombie = helper.readStat(zombiePid);
  assert.equal(zombie.state, 'Z');
  assert.equal(alive(zombiePid, zombie.starttime), false);
});

test('真实 tmux pane 中连续两次应用：进程树保持原 pane、回执闭环、上下文即删', async (t) => {
  const f = buildFixture(t);
  t.after(() => f.killEvidencePids());
  const port = await freePort();
  // 同 pane 后台实例（shell 作业控制独立进程组）与其他 pane 实例都不属于停止集合。
  // 后台实例必须在 Bot 前台启动之前送键：Bot 占据前台时 keystrokes 只会进 tty 缓冲。
  const bgPidFile = path.join(f.dataDir, 'bg-instance.pid');
  const markerScript = "require('node:fs').writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1e9)";
  tmux(['send-keys', '-t', f.target, '-l', `${shq(process.execPath)} -e ${shq(markerScript)} ${shq(bgPidFile)} &`]);
  tmux(['send-keys', '-t', f.target, 'Enter']);
  const otherSession = `${f.session}-other`;
  tmux(['-f', '/dev/null', 'new-session', '-d', '-s', otherSession, '-c', f.root, '-x', '80', '-y', '24']);
  t.after(() => { try { tmux(['kill-session', '-t', otherSession]); } catch {} });
  const otherPidFile = path.join(f.dataDir, 'other-pane.pid');
  tmux(['send-keys', '-t', `${otherSession}:0.0`, '-l', `${shq(process.execPath)} -e ${shq(markerScript)} ${shq(otherPidFile)}`]);
  tmux(['send-keys', '-t', `${otherSession}:0.0`, 'Enter']);
  await waitFor(() => fs.existsSync(bgPidFile) && fs.existsSync(otherPidFile), 10_000, '旁观实例启动');
  const bgPid = Number(fs.readFileSync(bgPidFile, 'utf8'));
  const otherPid = Number(fs.readFileSync(otherPidFile, 'utf8'));
  const bgStart = helper.processStarttime(bgPid);
  const otherStart = helper.processStarttime(otherPid);

  const evidence = await startBot(f, port, { termChild: true });
  const panePid = Number(tmux(['display-message', '-p', '-t', f.target, '#{pane_pid}']));
  const paneStart = helper.processStarttime(panePid);
  const first = readEvidence(evidence)[0];
  assert.equal(first.ppid, panePid, '初始 Bot 必须长在目标 pane 的 shell 里');
  const termChildPid = readEvidence(evidence).find(entry => Number.isInteger(entry.childPid))?.childPid || 0;
  const termChildStart = termChildPid ? helper.processStarttime(termChildPid) : '';

  // 第一次应用：TERM 忽略子进程走 8s 宽限后的 KILL 兜底，ready 回执闭环。
  const run1 = await runApply(f, {
    botPid: first.pid, botStarttime: helper.processStarttime(first.pid), port,
  }, { watch: true });
  assert.equal(run1.code, 0, run1.stderr);
  assert.equal(run1.receipt.phase, 'ready');
  assert.ok(run1.receipt.readyAt > 0);
  // stopping/starting 可稳定观测（停止段有 8s 宽限、启动段有子进程 spawn 延迟）；
  // started→ready 可能快于任何轮询周期，其发生由终态回执携带的 newPid/newStarttime
  // （started 阶段落盘的字段）证明，不赌观测时序。
  assert.ok(run1.phases.has('stopping') && run1.phases.has('starting'),
    `回执相位应推进到启动段，实际：${[...run1.phases].join(',')}`);
  assert.match(String(run1.receipt.newStarttime), /^\d+$/);
  const newPid1 = run1.receipt.newPid;
  assert.ok(Number.isInteger(newPid1) && newPid1 > 0 && newPid1 !== first.pid,
    `newPid 必须是真实 PID（waitFor 返回值合同），实际：${run1.receipt.newPid}`);
  assert.equal(alive(first.pid, helper.processStarttime(first.pid) || 'x'), false, '旧 Bot 已停');
  assert.equal(helper.isDescendantOf(newPid1, panePid), true, '新 Bot 必须仍是原 pane 后代');
  assert.equal(helper.processStarttime(panePid), paneStart, 'pane shell 未被重启');
  assert.ok(helper.holdsSocket(newPid1, helper.listeningInodes(port)), '新 Bot 真实持有端口');
  assert.ok(await healthOk(port));
  if (termChildPid) assert.equal(alive(termChildPid, termChildStart), false, 'TERM 忽略子进程被 KILL 兜底停掉');
  assert.equal(alive(bgPid, bgStart), true, '同 pane 后台实例不被误伤');
  assert.equal(alive(otherPid, otherStart), true, '其他 pane 实例不被误伤');
  // 特殊字符环境变量（含 $() 与反引号）经 0600 context 文件原样往返；上下文用后即删。
  const gen2 = readEvidence(evidence).find(entry => entry.pid === newPid1);
  assert.equal(gen2.special, SPECIAL_ENV);
  assert.equal(fs.existsSync(path.join(f.dataDir, 'evolution-apply-context.json')), false);
  assert.equal(fs.readFileSync(path.join(f.root, 'web/dist/index.html'), 'utf8'), 'rebuilt');
  assert.ok(fs.readdirSync(path.join(f.dataDir, 'logs')).some(name => name.startsWith('bot-restart-')));

  // 第二次应用：对已重启的新 Bot 再次解析同一 pane，重复完整闭环。
  const run2 = await runApply(f, {
    botPid: newPid1, botStarttime: helper.processStarttime(newPid1), port,
  }, { watch: true });
  assert.equal(run2.code, 0, run2.stderr);
  assert.equal(run2.receipt.phase, 'ready');
  const newPid2 = run2.receipt.newPid;
  assert.ok(Number.isInteger(newPid2) && newPid2 > 0 && newPid2 !== newPid1);
  assert.equal(helper.isDescendantOf(newPid2, panePid), true);
  assert.equal(helper.processStarttime(panePid), paneStart);
  assert.ok(await healthOk(port));
  assert.equal(alive(bgPid, bgStart), true, '后台实例两次应用后仍在');
  assert.equal(alive(otherPid, otherStart), true, '其他 pane 实例两次应用后仍在');
  assert.equal(f.git(['status', '--porcelain']), '', '应用后仓库保持干净');
});

test('helper 作为 Bot 后代运行时排除自身祖先分支，同分支 updater 常驻进程保留', async (t) => {
  const f = buildFixture(t);
  t.after(() => f.killEvidencePids());
  const port = await freePort();
  const evidence = await startBot(f, port, { mid: true });
  const panePid = Number(tmux(['display-message', '-p', '-t', f.target, '#{pane_pid}']));
  const bot = readEvidence(evidence)[0];
  const botStart = helper.processStarttime(bot.pid);

  const result = await runApplyViaDescendant(f, { botPid: bot.pid, botStarttime: botStart, port });
  assert.equal(result.receipt.phase, 'ready', result.stderr);
  const newPid = result.receipt.newPid;
  assert.ok(Number.isInteger(newPid) && newPid > 0 && newPid !== bot.pid);
  assert.equal(alive(bot.pid, 'x'), false, '旧 Bot 已停');
  assert.equal(helper.isDescendantOf(newPid, panePid), true, '新 Bot 仍是原 pane 后代');
  // mid 分支里的 updater 类常驻进程（sleep 600）被停止集合排除，应用后仍存活。
  const updaterPid = Number(fs.readFileSync(path.join(f.dataDir, 'updater.pid'), 'utf8').trim());
  const updaterStart = helper.processStarttime(updaterPid);
  assert.ok(updaterPid > 0);
  assert.equal(alive(updaterPid, updaterStart), true, 'helper 祖先分支的 updater 进程必须保留');
  assert.ok(await healthOk(port));
  try { process.kill(updaterPid, 'SIGKILL'); } catch {}
});

test('旁观端口持有者、脏工作区与自主关闭都在停服前如实失败', async (t) => {
  const f = buildFixture(t);
  t.after(() => f.killEvidencePids());
  const port = await freePort();
  const evidence = await startBot(f, port, { listen: false });
  const bot = readEvidence(evidence)[0];
  const botStart = helper.processStarttime(bot.pid);
  const botAlive = () => alive(bot.pid, botStart);

  // 脏工作区：构建前失败。
  fs.writeFileSync(path.join(f.root, 'dirty.txt'), 'local edit');
  const dirty = await runApply(f, { botPid: bot.pid, botStarttime: botStart, port });
  assert.equal(dirty.code, 1);
  assert.equal(dirty.receipt, null, '前置失败不写回执（Bot 从未进入停止段）');
  assert.match(dirty.stderr, /工作区不干净/);
  assert.ok(botAlive());
  assert.equal(fs.readFileSync(path.join(f.root, 'web/dist/index.html'), 'utf8'), 'old UI');
  fs.unlinkSync(path.join(f.root, 'dirty.txt'));

  // 旁观端口持有者：停止集合外进程持端口，必须在停服前中止。
  const holder = spawn(process.execPath, ['-e',
    `require('http').createServer((q,s)=>s.end('{}')).listen(${port},'127.0.0.1');setInterval(()=>{},1e9);`],
  { stdio: 'ignore' });
  t.after(() => { try { holder.kill('SIGKILL'); } catch {} });
  await waitFor(() => helper.listeningInodes(port).size > 0, 5000, '旁观进程占用端口');
  const bystander = await runApply(f, { botPid: bot.pid, botStarttime: botStart, port });
  assert.equal(bystander.code, 1);
  assert.equal(bystander.receipt, null);
  assert.match(bystander.stderr, /停止集合外的进程持有/);
  assert.ok(botAlive());
  holder.kill('SIGKILL');
  await waitFor(async () => !helper.listeningInodes(port).size, 5000, '旁观进程释放端口');

  // 自主开关关闭（toggle-off 竞态）：构建后、停服前取消，候选与旧服务保留。
  fs.writeFileSync(path.join(f.dataDir, 'activity-evolve-state.json'),
    JSON.stringify({ autonomousEvolutionEnabled: false, status: 'applying' }));
  const cancelled = await runApply(f, { botPid: bot.pid, botStarttime: botStart, port, autonomy: true });
  assert.equal(cancelled.code, 1);
  assert.equal(cancelled.receipt.phase, 'failed');
  assert.match(cancelled.receipt.error, /自主进化已被关闭/);
  assert.ok(botAlive());
  assert.equal(fs.readFileSync(path.join(f.root, 'web/dist/index.html'), 'utf8'), 'old UI', '候选与旧服务保留');
});

// 兄弟拓扑宿主脚本（2026-10-05 真实回归）：H 在目标 pane 后台运行，Bot 是 H 的
// 子进程；helper 由 H 的另一条分支（cmd 文件就绪后）启动——helper 与目标 Bot 是
// 兄弟而非其后代。公共祖先 H 的子树绝不能被「排除自身祖先」逻辑误放。
const HOST_SIBLING_SCRIPT = `
const fs = require('node:fs');
const cp = require('node:child_process');
const [botScript, port, evidence, pidFile, hostPidFile, cmdFile, errFile] = process.argv.slice(2);
const bot = cp.spawn(process.execPath, [botScript, port, evidence],
  { env: process.env, stdio: ['ignore', 'ignore', 'ignore'] });
fs.writeFileSync(pidFile, String(bot.pid));
fs.writeFileSync(hostPidFile, String(process.pid));
const err = fs.openSync(errFile, 'a');
(function watch() {
  setTimeout(() => {
    if (fs.existsSync(cmdFile) && fs.statSync(cmdFile).size > 0) {
      cp.spawn('sh', ['-c', fs.readFileSync(cmdFile, 'utf8')], { stdio: ['ignore', err, err] });
    } else watch();
  }, 150);
})();
setInterval(() => {}, 1e9);
`;

// ---------------------------------------------------------------------------
// 隔离候选目标根切换 e2e（Stage C/B1-B7）：真实 bare 远端 + 任务/运行时工作区 +
// 真实 tmux pane。fake Bot 入口提交在 fixture 的 core/client.js，按正式脚本形态
// （cwd=<原库>/core、argv=[node,'client.js',...]）由 pane 前台启动；helper 走
// --target-root 全链证明 → 构建/切换都落在运行时根，原库保留物（脏树）逐字节
// 不动、旁观不受伤、两次连续切换各有独立运行时根。
// ---------------------------------------------------------------------------
function buildTargetFixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'farm-apply-target-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'repo');
  const remote = `${root}-remote.git`;
  const dataDir = path.join(root, 'core', 'data');
  const session = `farmtgt${process.pid}${Date.now().toString(36)}`;
  fs.mkdirSync(path.join(root, 'core', 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(root, 'core', 'src'), { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'logs'), { recursive: true });
  fs.mkdirSync(path.join(root, 'web', 'dist'), { recursive: true });
  fs.writeFileSync(path.join(root, '.gitignore'), 'tmp/\ncore/data/\nweb/dist/\n');
  fs.copyFileSync(HELPER_SOURCE, path.join(root, 'core/scripts/evolution-apply-process.js'));
  fs.writeFileSync(path.join(root, 'core/client.js'), BOT_SCRIPT);
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  // helper 的服务依赖经 re-export shim 指回候选仓真实模块（依赖链保持真实，
  // fixture 只提供落点；与 autonomy 子进程夹具同构）。
  fs.mkdirSync(path.join(root, 'core/src/services'), { recursive: true });
  for (const name of ['evolution-publish', 'evolution-validation', 'evolution-worktree']) {
    fs.writeFileSync(path.join(root, 'core/src/services', `${name}.js`),
      `module.exports=require(${JSON.stringify(path.join(__dirname, `../src/services/${name}.js`))});\n`);
  }
  fs.writeFileSync(path.join(root, 'core/src/example.js'), 'module.exports = 1;\n');
  fs.writeFileSync(path.join(root, 'docs/HANDOFF.md'), 'Fixture constraints\n');
  fs.writeFileSync(path.join(root, 'web/package.json'), JSON.stringify({ name: 'web', private: true, scripts: { build: 'node build.cjs' } }));
  fs.writeFileSync(path.join(root, 'web/build.cjs'),
    "const fs=require('fs');let out='dist';for(let i=2;i<process.argv.length;i++){if(process.argv[i]==='--outDir')out=process.argv[i+1];}"
    + "fs.mkdirSync(out,{recursive:true});fs.writeFileSync(require('path').join(out,'index.html'),'rebuilt');\n");
  fs.writeFileSync(path.join(root, 'web/dist/index.html'), 'old UI');
  const git = (args, cwd = root) => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }).trim();
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.name', 'fixture']);
  git(['config', 'user.email', 'fixture@invalid']);
  git(['add', '.']);
  git(['commit', '-qm', 'fixture base']);
  git(['remote', 'add', 'origin', remote]);
  git(['push', '-q', 'origin', 'main']);
  // 原库三类保留物之一：已跟踪未暂存改动 + 未跟踪文件（原库从此是脏树，Bot 在
  // 脏原库上运行——这正是 Stage C 要保护的真实形态）。
  fs.writeFileSync(path.join(root, 'core/src/example.js'), 'module.exports = 2; // dirty hold\n');
  fs.writeFileSync(path.join(root, 'core/src/untracked-hold.js'), 'module.exports = "untracked";\n');
  tmux(['-f', '/dev/null', 'new-session', '-d', '-s', session, '-c', root, '-x', '200', '-y', '50']);
  t.after(() => { try { tmux(['kill-session', '-t', session]); } catch {} });
  return {
    root, dataDir, session, target: `${session}:0.0`, git,
    helper: path.join(root, 'core/scripts/evolution-apply-process.js'),
    killEvidencePids() {
      try {
        for (const entry of readEvidence(path.join(dataDir, 'bot-evidence.jsonl'))) {
          for (const pid of [entry.pid, entry.childPid].filter(Number.isInteger)) {
            try { process.kill(pid, 'SIGKILL'); } catch {}
          }
        }
      } catch {}
    },
  };
}

/** 写入离线回归验证记录（真实 runner 落盘格式：passed + backend/frontend + 指纹）。 */
function writeValidationRecord(dataDir, fingerprint) {
  fs.writeFileSync(path.join(dataDir, 'evolution-validation.json'), `${JSON.stringify({
    version: 1, state: 'passed', checkedAt: Date.now(), fingerprint, checks: ['backend', 'frontend'],
  })}\n`, { mode: 0o600 });
}

test('目标根切换 e2e：真实远端+任务/运行时区、正式脚本形态、两次连续切换、原库脏保留物不动', async (t) => {
  const f = buildTargetFixture(t);
  t.after(() => f.killEvidencePids());
  const publish = require('../src/services/evolution-publish');
  const { logicSnapshot } = require('../src/services/evolution-validation');
  const port = await freePort();

  const manifest = publish.ensureHoldManifest(f.dataDir, f.root);
  const holdsBefore = {
    example: fs.readFileSync(path.join(f.root, 'core/src/example.js'), 'utf8'),
    untracked: fs.readFileSync(path.join(f.root, 'core/src/untracked-hold.js'), 'utf8'),
    status: f.git(['status', '--porcelain', '-z', '--untracked-files=normal']),
  };
  const provenance = publish.createTaskWorkspace({
    repoRoot: f.root, dataDir: f.dataDir, runId: 'run-e2e-1',
  });

  // 候选 1：任务区真实提交 + 发布到 bare 远端。
  const task = provenance.taskRoot;
  fs.writeFileSync(path.join(task, 'core/src/example.js'), 'module.exports = 10;\n');
  f.git(['add', '.'], task);
  f.git(['commit', '-qm', 'candidate 1'], task);
  const head1 = f.git(['rev-parse', 'HEAD'], task);
  f.git(['push', '-q', 'origin', 'HEAD:main'], task);
  const rt1 = publish.prepareRuntimeWorkspace({
    repoRoot: f.root, runId: 'run-e2e-1', commit: head1, dataDir: f.dataDir,
  });
  publish.recordApplyTarget(f.dataDir, {
    runId: 'run-e2e-1', commit: head1, runtimeRoot: rt1.runtimeRoot,
    sourceFingerprint: rt1.logicFingerprint, holdDigest: publish.holdDigest(manifest),
    createdAt: Date.now(),
  });

  // 旁观实例：同 pane 后台 + 其他 pane（都不属于停止集合）。
  const bgPidFile = path.join(f.dataDir, 'bg-instance.pid');
  const markerScript = "require('node:fs').writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1e9)";
  tmux(['send-keys', '-t', f.target, '-l', `${shq(process.execPath)} -e ${shq(markerScript)} ${shq(bgPidFile)} &`]);
  tmux(['send-keys', '-t', f.target, 'Enter']);
  const otherSession = `${f.session}-other`;
  tmux(['-f', '/dev/null', 'new-session', '-d', '-s', otherSession, '-c', f.root, '-x', '80', '-y', '24']);
  t.after(() => { try { tmux(['kill-session', '-t', otherSession]); } catch {} });
  const otherPidFile = path.join(f.dataDir, 'other-pane.pid');
  tmux(['send-keys', '-t', `${otherSession}:0.0`, '-l', `${shq(process.execPath)} -e ${shq(markerScript)} ${shq(otherPidFile)}`]);
  tmux(['send-keys', '-t', `${otherSession}:0.0`, 'Enter']);
  await waitFor(() => fs.existsSync(bgPidFile) && fs.existsSync(otherPidFile), 10_000, '旁观实例启动');
  const bgPid = Number(fs.readFileSync(bgPidFile, 'utf8'));
  const otherPid = Number(fs.readFileSync(otherPidFile, 'utf8'));
  const bgStart = helper.processStarttime(bgPid);
  const otherStart = helper.processStarttime(otherPid);

  // 正式脚本形态启动 Bot：cwd=<原库>/core、argv=[node,'client.js',port,evidence]。
  const evidence = path.join(f.dataDir, 'bot-evidence.jsonl');
  tmux(['send-keys', '-t', f.target, '-l', `cd core && ${shq(process.execPath)} client.js ${port} ${shq(evidence)}`]);
  tmux(['send-keys', '-t', f.target, 'Enter']);
  await waitFor(() => healthOk(port), 10_000, 'fake Bot 启动（正式形态）');
  const panePid = Number(tmux(['display-message', '-p', '-t', f.target, '#{pane_pid}']));
  const paneStart = helper.processStarttime(panePid);
  const first = readEvidence(evidence)[0];
  assert.equal(first.ppid, panePid, '初始 Bot 必须长在目标 pane 的 shell 里');
  assert.equal(first.farm, '', '原库上的旧 Bot 尚无 FARM_DATA_DIR（legacy 形态）');
  const botStart = helper.processStarttime(first.pid);

  const runTarget = async (targetRoot, head, botPid, botStarttime) => {
    const args = ['--bot-pid', String(botPid), '--bot-starttime', botStarttime, '--expected-head', head,
      '--tmux-target', f.target, '--data-dir', f.dataDir, '--admin-port', String(port),
      '--target-root', targetRoot];
    const child = spawn(process.execPath, [f.helper, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    const code = await new Promise(resolve => child.once('exit', resolve));
    let receipt = null;
    try { receipt = JSON.parse(fs.readFileSync(path.join(f.dataDir, 'evolution-apply-receipt.json'), 'utf8')); } catch {}
    return { code, stderr, receipt };
  };
  const assertOriginalRootUntouched = () => {
    assert.equal(fs.readFileSync(path.join(f.root, 'core/src/example.js'), 'utf8'), holdsBefore.example);
    assert.equal(fs.readFileSync(path.join(f.root, 'core/src/untracked-hold.js'), 'utf8'), holdsBefore.untracked);
    assert.equal(f.git(['status', '--porcelain', '-z', '--untracked-files=normal']), holdsBefore.status);
    assert.equal(fs.readFileSync(path.join(f.root, 'web/dist/index.html'), 'utf8'), 'old UI');
    assert.equal(publish.verifyHoldUnchanged(f.root, publish.readHoldManifest(f.dataDir)).ok, true);
  };

  // 反例（B3）：验证记录指纹与运行时内容不符 → 停服前失败，旧服务保持在线。
  writeValidationRecord(f.dataDir, '0'.repeat(64));
  const bad = await runTarget(rt1.runtimeRoot, head1, first.pid, botStart);
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /离线回归验证记录缺失\/未通过\/指纹不符/);
  assert.ok(alive(first.pid, botStart), '验证门失败必须发生在停服之前');
  assertOriginalRootUntouched();
  // 失败应用绝不写「最近一次 ready」验收证书（二批）：没有成功就没有验收。
  const certFile = path.join(f.dataDir, 'evolution-approved-runtime.json');
  assert.equal(fs.existsSync(certFile), false, '失败应用不得写验收证书');

  // 正例：真实内容指纹的验证记录 → 全链切换成功。
  writeValidationRecord(f.dataDir, rt1.logicFingerprint);
  const run1 = await runTarget(rt1.runtimeRoot, head1, first.pid, botStart);
  assert.equal(run1.code, 0, run1.stderr);
  assert.equal(run1.receipt.phase, 'ready');
  assert.equal(run1.receipt.runtimeRoot, rt1.runtimeRoot);
  assert.equal(run1.receipt.sourceFingerprint, rt1.logicFingerprint);
  const newPid1 = run1.receipt.newPid;
  assert.ok(Number.isInteger(newPid1) && newPid1 > 0 && newPid1 !== first.pid);
  assert.equal(alive(first.pid, 'x'), false, '旧 Bot 已停');
  assert.equal(helper.isDescendantOf(newPid1, panePid), true, '新 Bot 必须仍是原 pane 后代');
  assert.equal(helper.processStarttime(panePid), paneStart, 'pane shell 未被重启');
  assert.ok(helper.holdsSocket(newPid1, helper.listeningInodes(port)), '新 Bot 真实持有端口');
  assert.ok(await healthOk(port));
  // B1 映射实测：新 Bot 的 cwd/入口都落在运行时根内，普通参数（evidence 绝对路径）原样。
  assert.equal(fs.readlinkSync(`/proc/${newPid1}/cwd`), path.join(rt1.runtimeRoot, 'core'));
  const cmdline1 = fs.readFileSync(`/proc/${newPid1}/cmdline`, 'utf8').split('\0').filter(Boolean);
  assert.equal(cmdline1[1], path.join(rt1.runtimeRoot, 'core', 'client.js'));
  assert.equal(cmdline1[2], String(port));
  assert.equal(cmdline1[3], evidence);
  const gen2 = readEvidence(evidence).find(entry => entry.pid === newPid1);
  assert.equal(gen2.farm, f.dataDir, 'FARM_DATA_DIR 必须强制映射到实际原数据目录');
  // dist 切换发生在运行时根；原库（含脏保留物）逐字节不动。
  assert.equal(fs.readFileSync(path.join(rt1.runtimeRoot, 'web/dist/index.html'), 'utf8'), 'rebuilt');
  assert.equal(logicSnapshot(rt1.runtimeRoot).fingerprint, rt1.logicFingerprint, '运行时内容身份在切换后保持');
  assertOriginalRootUntouched();
  assert.equal(alive(bgPid, bgStart), true, '同 pane 后台实例不被误伤');
  assert.equal(alive(otherPid, otherStart), true, '其他 pane 实例不被误伤');
  assert.equal(fs.existsSync(path.join(f.dataDir, 'evolution-apply-context.json')), false, '私有上下文用后即删');
  // 真实 ready 落盘验收证书（二批）：目标记录快照 + 实测通过验证摘要 + 验收时
  // 溯源快照 + ready 进程身份，私有 0600。
  const cert1 = JSON.parse(fs.readFileSync(certFile, 'utf8'));
  assert.equal(cert1.version, 1);
  assert.ok(Number.isInteger(cert1.certifiedAt) && cert1.certifiedAt > 0);
  assert.equal(cert1.target.commit, head1);
  assert.equal(cert1.target.runtimeRoot, rt1.runtimeRoot);
  assert.equal(cert1.target.sourceFingerprint, rt1.logicFingerprint);
  assert.equal(cert1.target.holdDigest, publish.holdDigest(manifest));
  assert.equal(cert1.validation.state, 'passed');
  assert.equal(cert1.validation.fingerprint, rt1.logicFingerprint);
  assert.deepEqual(cert1.validation.checks, ['backend', 'frontend']);
  assert.equal(cert1.provenance.runId, provenance.runId);
  assert.equal(cert1.provenance.taskRoot, provenance.taskRoot);
  assert.equal(cert1.provenance.publicBase, provenance.publicBase);
  assert.equal(cert1.provenance.commonDir, provenance.commonDir);
  assert.equal(cert1.process.newPid, run1.receipt.newPid);
  assert.equal(cert1.process.expectedHead, head1);
  assert.equal(fs.statSync(certFile).mode & 0o777, 0o600);

  // 第二次连续切换：新候选 → 独立运行时根（不覆盖/不嵌套），对运行时根上的新 Bot
  // 再次应用（cwd=旧运行时根/core、入口为映射后的绝对路径——仍在原库边界内）。
  fs.writeFileSync(path.join(task, 'core/src/example.js'), 'module.exports = 20;\n');
  f.git(['add', '.'], task);
  f.git(['commit', '-qm', 'candidate 2'], task);
  const head2 = f.git(['rev-parse', 'HEAD'], task);
  f.git(['push', '-q', 'origin', 'HEAD:main'], task);
  const rt2 = publish.prepareRuntimeWorkspace({
    repoRoot: f.root, runId: 'run-e2e-1', commit: head2, dataDir: f.dataDir,
  });
  assert.notEqual(rt2.runtimeRoot, rt1.runtimeRoot);
  publish.recordApplyTarget(f.dataDir, {
    runId: 'run-e2e-1', commit: head2, runtimeRoot: rt2.runtimeRoot,
    sourceFingerprint: rt2.logicFingerprint, holdDigest: publish.holdDigest(manifest),
    createdAt: Date.now(),
  });
  writeValidationRecord(f.dataDir, rt2.logicFingerprint);
  // 二批：候选 2 的失败应用（验证指纹错误 → 停服前失败）必须保留下一次 ready
  // 证书（仍是 rt1），已接受运行时的可启动性不因新候选失败而丢失。
  writeValidationRecord(f.dataDir, '0'.repeat(64));
  const failed2 = await runTarget(rt2.runtimeRoot, head2, newPid1, helper.processStarttime(newPid1));
  assert.equal(failed2.code, 1);
  assert.match(failed2.stderr, /离线回归验证记录缺失\/未通过\/指纹不符/);
  assert.ok(alive(newPid1, helper.processStarttime(newPid1)), '失败发生在停服之前，新 Bot 保留');
  const certKept = JSON.parse(fs.readFileSync(certFile, 'utf8'));
  assert.equal(certKept.target.commit, head1, '失败应用必须保留上一次 ready 证书');
  assert.equal(certKept.target.runtimeRoot, rt1.runtimeRoot);
  writeValidationRecord(f.dataDir, rt2.logicFingerprint);
  const run2 = await runTarget(rt2.runtimeRoot, head2, newPid1, helper.processStarttime(newPid1));
  assert.equal(run2.code, 0, run2.stderr);
  assert.equal(run2.receipt.phase, 'ready');
  const newPid2 = run2.receipt.newPid;
  assert.ok(Number.isInteger(newPid2) && newPid2 > 0 && newPid2 !== newPid1);
  assert.equal(helper.isDescendantOf(newPid2, panePid), true);
  assert.equal(fs.readlinkSync(`/proc/${newPid2}/cwd`), path.join(rt2.runtimeRoot, 'core'));
  const cmdline2 = fs.readFileSync(`/proc/${newPid2}/cmdline`, 'utf8').split('\0').filter(Boolean);
  assert.equal(cmdline2[1], path.join(rt2.runtimeRoot, 'core', 'client.js'));
  assert.ok(await healthOk(port));
  assert.ok(fs.existsSync(path.join(rt1.runtimeRoot, 'core/client.js')), '旧运行时根不被删除');
  // 二批：第二次成功应用后证书原子更新为 rt2（最近一次 ready 换新）。
  const cert2 = JSON.parse(fs.readFileSync(certFile, 'utf8'));
  assert.equal(cert2.target.commit, head2);
  assert.equal(cert2.target.runtimeRoot, rt2.runtimeRoot);
  assert.equal(cert2.process.newPid, run2.receipt.newPid);
  assert.equal(cert2.validation.fingerprint, rt2.logicFingerprint);
  assertOriginalRootUntouched();
  assert.equal(alive(bgPid, bgStart), true, '两次切换后旁观实例仍在');
  assert.equal(alive(otherPid, otherStart), true);
});

// ---------------------------------------------------------------------------
// 真实事故回归（2026-10-08 二批）：被中断的 helper 只把 literal 敲进了 pane 的
// tty 输入缓冲（前台 Bot 不读 stdin、Enter 从未送达），Bot 退出后残行留在提示符
// 上。无清行的故障对照把命令直接拼在残行之后
// → 坏命令执行、新 Bot 永不出现、服务已停；新 helper 在同一个 tmux 事务里
// C-u 清残行 + 字面命令 + 回车（-H 字节流），预期 marker Bot 正常重启。
// 两个 helper 都是真进程真命令效果，不做源码字符串断言或 mock。
// ---------------------------------------------------------------------------
test('pane 残留未提交 restart 行：无清行对照真实失败，新 helper 单事务清行成功', async (t) => {
  // 固定缺陷条件：当前 helper 只移除清行字节；不把不断前进的 HEAD 当旧版本。
  // 这是故障对照（真实进程与残行效果），不是协调器的历史源码基线验收。
  const UNSAFE_HELPER = HELPER_CODE.replace('Buffer.from([0x15]), ', '');
  assert.notEqual(UNSAFE_HELPER, HELPER_CODE, '故障对照必须实际移除清行');
  const STALE_LINE = '--restart /nonexistent/evolution-apply-context.json';

  {
    const f = buildFixture(t, { helperSource: UNSAFE_HELPER });
    t.after(() => f.killEvidencePids());
    const port = await freePort();
    const evidence = await startBot(f, port);
    const first = readEvidence(evidence)[0];
    const botStart = helper.processStarttime(first.pid);
    // 事故形态：Bot 占据前台时敲入 literal（进 tty 缓冲），不送 Enter。
    sendLiteral(f.target, STALE_LINE);
    const old = await runApply(f, { botPid: first.pid, botStarttime: botStart, port });
    assert.equal(old.code, 1);
    assert.equal(old.receipt.phase, 'failed');
    assert.match(old.receipt.error, /新 Bot 未在原 pane 中启动/);
    assert.equal(readEvidence(evidence).length, 1, '无清行对照下没有任何新 Bot 落证据');
    assert.equal(await healthOk(port), false, '服务已停止且未被重启');
    const paneText = tmux(['capture-pane', '-p', '-t', f.target]);
    assert.match(paneText, /not found/, '残行拼接产生了真实坏命令（非字符串断言）');
  }

  {
    const f = buildFixture(t);
    t.after(() => f.killEvidencePids());
    const port = await freePort();
    const evidence = await startBot(f, port);
    const panePid = Number(tmux(['display-message', '-p', '-t', f.target, '#{pane_pid}']));
    const first = readEvidence(evidence)[0];
    sendLiteral(f.target, STALE_LINE);
    const fixed = await runApply(f, { botPid: first.pid, botStarttime: helper.processStarttime(first.pid), port });
    assert.equal(fixed.code, 0, fixed.stderr);
    assert.equal(fixed.receipt.phase, 'ready');
    const newPid = fixed.receipt.newPid;
    assert.ok(Number.isInteger(newPid) && newPid > 0 && newPid !== first.pid);
    assert.equal(helper.isDescendantOf(newPid, panePid), true, '新 Bot 仍是原 pane 后代');
    assert.ok(await healthOk(port), '预期 marker Bot 成功启动并监听');
    const markerBot = readEvidence(evidence).find(entry => entry.pid === newPid);
    assert.ok(markerBot, '重启的 marker Bot 真实留下运行证据');
    const paneText = tmux(['capture-pane', '-p', '-t', f.target]);
    assert.doesNotMatch(paneText, /not found/, '残行被 C-u 清掉，没有坏命令执行');
  }
});

test('helper 与目标 Bot 为兄弟拓扑时不得豁免公共宿主祖先：TERM 忽略子进程照常被停', async (t) => {
  const f = buildFixture(t);
  t.after(() => f.killEvidencePids());
  const port = await freePort();
  // 宿主脚本放 gitignored dataDir：写进仓库根会成为未跟踪文件，让 helper 的
  // 干净工作区前置门合法拒绝（早期失败不写回执，测试只能超时）。
  const hostScript = path.join(f.dataDir, 'host-sibling.cjs');
  const pidFile = path.join(f.dataDir, 'sibling-bot.pid');
  const hostPidFile = path.join(f.dataDir, 'sibling-host.pid');
  const cmdFile = path.join(f.dataDir, 'sibling-cmd');
  const errLog = path.join(f.dataDir, 'helper-sibling.err');
  const receiptFile = path.join(f.dataDir, 'evolution-apply-receipt.json');
  fs.writeFileSync(hostScript, HOST_SIBLING_SCRIPT);
  fs.writeFileSync(cmdFile, '');
  t.after(() => {
    try { process.kill(Number(fs.readFileSync(hostPidFile, 'utf8')), 'SIGKILL'); } catch {}
  });
  // Bot 带 TERM 忽略子进程（正是旧 bug 存活的那类），由宿主 H 启动。
  const command = [
    'BOT_IGNORE_TERM_CHILD=1',
    shq(process.execPath), shq(hostScript), shq(f.botScript), String(port),
    shq(path.join(f.dataDir, 'bot-evidence.jsonl')), shq(pidFile), shq(hostPidFile), shq(cmdFile), shq(errLog),
  ].join(' ');
  tmux(['send-keys', '-t', f.target, '-l', `${command} &`]);
  tmux(['send-keys', '-t', f.target, 'Enter']);
  await waitFor(async () => fs.existsSync(pidFile) && await healthOk(port), 10_000, '兄弟拓扑 Bot 启动');
  const botPid = Number(fs.readFileSync(pidFile, 'utf8'));
  const botStart = helper.processStarttime(botPid);
  const panePid = Number(tmux(['display-message', '-p', '-t', f.target, '#{pane_pid}']));
  const evidence = path.join(f.dataDir, 'bot-evidence.jsonl');
  const termChildPid = readEvidence(evidence).find(entry => Number.isInteger(entry.childPid))?.childPid || 0;
  const termChildStart = termChildPid ? helper.processStarttime(termChildPid) : '';
  assert.ok(termChildPid > 0, 'Bot 必须产生 TERM 忽略子进程');
  assert.equal(helper.isDescendantOf(botPid, panePid), true, 'Bot 仍在目标 pane 树内（helper 前置门要求）');

  // helper 由 H 启动：与 Bot 同父（兄弟），非 Bot 后代——这正是测试进程直启 helper
  // 在真实宿主上的拓扑，且不依赖测试进程自身 ancestry，完全确定。
  fs.writeFileSync(cmdFile,
    `${shq(process.execPath)} ${shq(f.helper)} ${helperArgs(f, { botPid, botStarttime: botStart, port }).map(shq).join(' ')}`);
  await waitFor(() => {
    try { return ['ready', 'failed', 'ready-timeout'].includes(JSON.parse(fs.readFileSync(receiptFile, 'utf8')).phase); }
    catch { return false; }
  }, 120_000, '兄弟拓扑应用收口');
  const receipt = JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
  assert.equal(receipt.phase, 'ready', fs.readFileSync(errLog, 'utf8'));
  assert.equal(alive(botPid, 'x'), false, '旧 Bot 已停');
  // 旧 bug 的精确反例：公共祖先 H 子树被误豁免 ⇒ TERM 忽略子进程活过整个宽限。
  assert.equal(alive(termChildPid, termChildStart), false, 'Bot 的 TERM 忽略子进程必须被 KILL 兜底停掉');
  const newPid = receipt.newPid;
  assert.ok(Number.isInteger(newPid) && newPid > 0 && newPid !== botPid);
  assert.equal(helper.isDescendantOf(newPid, panePid), true, '新 Bot 仍是原 pane 后代');
  assert.ok(await healthOk(port));
});

// 与目标根切换夹具同型的最小真实 Git 序列（init/config/commit/remote/push），
// 供夹具隔离回归在两种环境形态下分别执行。
const SANDBOX_FIXTURE_SCRIPT = `'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const base = path.resolve(process.argv[2]);
const write = (file, text) => {
  const full = path.resolve(base, file);
  if (full !== base && !full.startsWith(base + path.sep)) throw new Error(\`fixture_escape:\${file}\`);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, text);
};
const git = args => execFileSync('git', args,
  { cwd: path.join(base, 'repo'), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
write('repo/file.txt', 'fixture\\n');
execFileSync('git', ['init', '-q', '--bare', '-b', 'main', path.join(base, 'remote.git')]);
git(['init', '-q', '-b', 'main']);
git(['config', 'user.name', 'fixture']);
git(['config', 'user.email', 'fixture@users.noreply.github.com']);
git(['add', '.']);
git(['commit', '-qm', 'fixture']);
git(['remote', 'add', 'origin', path.join(base, 'remote.git')]);
git(['push', '-q', 'origin', 'main']);
`;

test('夹具隔离回归：生产形态钩子注入下真实 Git 夹具推送仅在净化环境成功', () => {
  const hostBefore = gitConfigSnapshot();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'farm-apply-git-sandbox-'));
  try {
    // 写边界硬拒：脚本与两个夹具根都必须落在本 mkdtemp 目录内（外穿事故硬门）。
    const write = (file, text) => {
      const full = path.resolve(dir, file);
      if (full !== dir && !full.startsWith(dir + path.sep)) throw new Error(`fixture_escape:${file}`);
      fs.writeFileSync(full, text);
    };
    write('fixture.cjs', SANDBOX_FIXTURE_SCRIPT);
    // 生产形态注入（与协调进程 buildEvolutionAgentEnv 同形，hooksPath 指向本仓
    // 真实 scripts/evolution-hooks，只读引用）。
    const injected = {
      ...sanitizeGitConfigEnv(process.env),
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'core.hooksPath',
      GIT_CONFIG_VALUE_0: path.join(GUARD_ROOT, 'scripts', 'evolution-hooks'),
    };
    // 负对照：注入存在而未净化 → 真实 pre-push 必须拒绝夹具推送。
    const raw = spawnSync(process.execPath, [path.join(dir, 'fixture.cjs'), path.join(dir, 'raw')],
      { env: injected, encoding: 'utf8' });
    assert.notEqual(raw.status, 0, '未净化环境下的夹具推送必须被真实钩子拒绝');
    assert.match(raw.stderr || '', /automatic evolution agents cannot push/);
    // 正例：同一夹具序列在净化后的环境副本中成功（本文件顶部沙箱同款净化）。
    const clean = spawnSync(process.execPath, [path.join(dir, 'fixture.cjs'), path.join(dir, 'clean')],
      { env: sanitizeGitConfigEnv(injected), encoding: 'utf8' });
    assert.equal(clean.status, 0, clean.stderr || '净化环境下的夹具推送应成功');
    // 宿主环境未被夹具触碰。
    assert.deepEqual(gitConfigSnapshot(), hostBefore);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
