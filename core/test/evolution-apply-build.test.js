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
// - 旁观端口持有者、脏工作区、自主开关关闭三类失败都必须发生在停服之前。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const { test } = require('node:test');
const helper = require('../scripts/evolution-apply-process');

const HELPER_SOURCE = path.join(__dirname, '../scripts/evolution-apply-process.js');
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
record({ pid: process.pid, ppid: process.ppid, special: process.env.BOT_SPECIAL || '' });
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

/** 独立 fixture 仓库 + 真实 tmux pane（fake Bot 由 pane shell 前台运行）。 */
function buildFixture(t) {
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
  fs.copyFileSync(HELPER_SOURCE, path.join(root, 'core/scripts/evolution-apply-process.js'));
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
