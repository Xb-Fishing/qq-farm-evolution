#!/usr/bin/env node
'use strict';
// 进化应用进程（独立 helper，2026-10-05 合同 v2）。两个运行模式：
// - 主模式：由 Bot（applyEvolution）在 applying 状态下 detached 启动，负责
//   「先证明后动作」的整个应用流程；
// - --restart <contextFile>：由主模式通过原 pane 的 shell（tmux send-keys）启动，
//   读取 0600 私有上下文，把原 Bot 按捕获的 argv/env/cwd 结构化重启为自己的
//   子进程并等待退出——新 Bot 因此始终是原 pane 的后代，下一次
//   resolveTmuxPaneForProcess 才能再次解析到同一 pane（detached 直启会把新 Bot
//   挂到 init 名下，pane 关联永久丢失，自主应用就此失效）。
// 主模式流程（每一步失败都不停旧服务，除非已经进入停止段）：
//   1. 验证 Bot 身份（pid + /proc starttime 防复用）与 tmux pane 归属；
//   2. 验证 HEAD === 待应用提交且工作区干净；端口持有者必须在停止集合内
//      （旁观实例持端口时如实失败，绝不先停自己）；
//   3. 隔离构建 web；构建后重新采进程表，复核 Bot/pane 身份与归属、部署前提、
//      自主开关（仅自主路径：owner 已关闭则取消，保留候选与旧服务）；
//   4. 私有捕获 Bot 原始 argv/env/cwd（0600，用后即删，永不入库/入日志）；
//   5. 写回执 stopping → 只停 Bot 已证明的后代（排除本 helper 自身祖先分支），
//      每个 TERM/KILL 都先核对该 PID 的 starttime（PID 复用绝不杀错对象）；
//      TERM 有宽限期，僵尸态（Z/X）视为已停（容器 init 不收尸时 kill(pid,0)
//      会把僵尸误判为存活），宽限后仍活着才 KILL；
//   6. 等端口真正释放（失败即中止，绝不带着残留持有者换 dist/重启）→ 换 dist；
//   7. 等 pane 前台回到提示符后向原 pane 送键启动受审 --restart 分支（不 C-c、
//      不开新 window、不向 pane 发任何 env/secret，只传安全文件路径）；
//   8. 实测新 pid/starttime 出现在原 pane、HEAD 未漂移、新进程真实持有 adminPort
//      的 LISTEN socket（/proc socket inode）且 GET /api/health 返回 ok:true，
//      全部满足才把回执转 ready（新进程据此闭环 applied）。
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn, execFileSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '../..');
const STATE_FILE_NAME = 'activity-evolve-state.json';
const TERM_GRACE_MS = 8000;
const KILL_GRACE_MS = 5000;

function arg(name, fallback = '') {
  const index = process.argv.indexOf(`--${name}`);
  return index > 0 && index + 1 < process.argv.length ? process.argv[index + 1] : fallback;
}

function fail(message) {
  process.stderr.write(`[evolution-apply] ${message}\n`);
  process.exitCode = 1;
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// ---- /proc 进程表与身份 ----
function collectProcesses() {
  const map = new Map();
  let entries;
  try { entries = fs.readdirSync('/proc'); } catch { return map; }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const info = readStat(Number(entry));
    if (info) map.set(Number(entry), info);
  }
  return map;
}

/** /proc/PID/stat：state(0)/ppid(1)/pgrp(2)/tpgid(5)/starttime(19)，按最后一个 ')' 切分。 */
function readStat(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const close = stat.lastIndexOf(')');
    if (close < 0) return null;
    const fields = stat.slice(close + 2).split(' ');
    const number = value => { const n = Number(value); return Number.isInteger(n) ? n : 0; };
    return {
      state: fields[0] || '',
      ppid: number(fields[1]),
      pgrp: number(fields[2]),
      tpgid: number(fields[5]),
      starttime: fields[19] || '',
    };
  } catch { return null; }
}

function processStarttime(pid) {
  const info = readStat(pid);
  return info ? info.starttime : '';
}

/** pid 的祖先链里是否包含 candidate（pane 归属判定：Bot 必须长在目标 pane 里）。 */
function isDescendantOf(pid, candidate, cache) {
  const table = cache || collectProcesses();
  const seen = new Set();
  let current = Number(pid);
  for (let depth = 0; current > 1 && !seen.has(current) && depth < 64; depth += 1) {
    if (current === Number(candidate)) return true;
    seen.add(current);
    const info = table.get(current);
    current = info ? info.ppid : 0;
  }
  return false;
}

function readCmdline(pid) {
  try {
    const parts = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
    if (parts.length && parts[parts.length - 1] === '') parts.pop();
    return parts;
  } catch { return null; }
}

/** 停止判定：消失、starttime 复用、或 Z/X 僵尸态都算「已停」。 */
function aliveNonZombie(pid, expectedStarttime) {
  const info = readStat(pid);
  if (!info || !expectedStarttime || info.starttime !== expectedStarttime) return false;
  return info.state !== 'Z' && info.state !== 'X';
}

/** 身份守卫发信号：发之前重读 starttime，PID 已退出/被复用就不发。 */
function signalGuarded(pid, expectedStarttime, signal) {
  const info = readStat(pid);
  if (!info || !expectedStarttime || info.starttime !== expectedStarttime) return false;
  try { process.kill(pid, signal); return true; } catch { return false; }
}

function panePidOf(target) {
  try {
    return Number(execFileSync('tmux', ['display-message', '-p', '-t', target, '#{pane_pid}'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()) || 0;
  } catch { return 0; }
}

function git(args, root = REPO_ROOT) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }).trim();
}

// ---- 端口归属与健康 ----
/** adminPort 的 LISTEN socket inode 集合（/proc/net/tcp{,6}，0A=LISTEN）。 */
function listeningInodes(port) {
  const hexPort = port.toString(16).toUpperCase().padStart(4, '0');
  const inodes = new Set();
  for (const file of ['/proc/net/tcp', '/proc/net/tcp6']) {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    for (const line of text.split('\n').slice(1)) {
      const columns = line.trim().split(/\s+/);
      if (columns.length < 10) continue;
      const localPort = String(columns[1] || '').split(':')[1];
      const inode = columns[9];
      if (localPort === hexPort && columns[3] === '0A' && /^\d+$/.test(inode)) inodes.add(inode);
    }
  }
  return inodes;
}

/** pid 是否真实持有 inodes 中的 socket（fd 符号链接 → socket:[inode]）。 */
function holdsSocket(pid, inodes) {
  if (!inodes.size) return false;
  let fds;
  try { fds = fs.readdirSync(`/proc/${pid}/fd`); } catch { return false; }
  for (const fd of fds) {
    try {
      const link = fs.readlinkSync(`/proc/${pid}/fd/${fd}`);
      const match = /^socket:\[(\d+)\]$/.exec(link);
      if (match && inodes.has(match[1])) return true;
    } catch {}
  }
  return false;
}

function portOwnerPids(port, table) {
  const inodes = listeningInodes(port);
  const owners = [];
  if (!inodes.size) return owners;
  for (const pid of table.keys()) {
    if (holdsSocket(pid, inodes)) owners.push(pid);
  }
  return owners;
}

/** 端口无人监听才算释放；任何应答/非拒绝错误都视为仍被持有（保守中止）。 */
function portFree(port) {
  return new Promise(resolve => {
    const request = http.get({ host: '127.0.0.1', port, path: '/', timeout: 1500 }, () => resolve(false));
    request.once('error', error => resolve(error?.code === 'ECONNREFUSED'));
    request.once('timeout', () => { request.destroy(); resolve(false); });
  });
}

/** GET /api/health：HTTP 2xx 且 JSON body 的 ok === true 才算健康；body 超限直接拒。 */
function healthOk(port, timeoutMs = 3000) {
  return new Promise(resolve => {
    let body = '';
    let overflow = false;
    const request = http.get({ host: '127.0.0.1', port, path: '/api/health', timeout: timeoutMs }, response => {
      if (response.statusCode < 200 || response.statusCode >= 300) {
        response.resume();
        resolve(false);
        return;
      }
      response.setEncoding('utf8');
      response.on('data', chunk => {
        if (body.length < 8192) body += chunk;
        if (body.length >= 8192) { overflow = true; response.destroy(); resolve(false); }
      });
      response.on('end', () => {
        if (overflow) return;
        try { resolve(JSON.parse(body)?.ok === true); } catch { resolve(false); }
      });
    });
    request.once('error', () => resolve(false));
    request.once('timeout', () => { request.destroy(); resolve(false); });
  });
}

/** 等待谓词成立：返回谓词最后一次真值（调用方需要实际值，如新 Bot 的 PID）。 */
async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await sleep(300);
  }
  process.stderr.write(`[evolution-apply] 等待${label}超时\n`);
  return false;
}

function shellQuote(text) {
  return `'${String(text).replace(/'/g, `'\\''`)}'`;
}

/** 私有「最近一次真实 ready」验收证书（2026-10-08 二批）：只含目标记录快照、
 * 实测通过的验证摘要、验收时任务溯源快照与 ready 进程身份；原子落盘（唯一临时
 * 名 + rename，0600）。失败/pending 应用绝不触碰既有证书——历史验收不是伪造的
 * 当前回执，回执仍如实保留 failed/starting 状态。 */
function writeApprovedCertificate(dataDir, certificate) {
  const file = path.join(dataDir, 'evolution-approved-runtime.json');
  const temp = `${file}.${process.pid}-cert.tmp`;
  // 结尾换行给显式字节（0x0a）：`\n` 转义二次复制会产生字面反斜杠文本，破坏 JSON。
  fs.writeFileSync(temp, Buffer.concat([
    Buffer.from(JSON.stringify(certificate, null, 2), 'utf8'), Buffer.from([0x0A]),
  ]), { mode: 0o600 });
  try { fs.chmodSync(temp, 0o600); } catch {}
  fs.renameSync(temp, file);
  try { fs.chmodSync(file, 0o600); } catch {}
}

/** 自主路径的停服前复核：owner 经 API 关闭后不得继续停服（候选与旧服务保留）。 */
function autonomyStillEnabled(dataDir) {
  try {
    const state = JSON.parse(fs.readFileSync(path.join(dataDir, STATE_FILE_NAME), 'utf8'));
    return state?.autonomousEvolutionEnabled === true && state?.status === 'applying';
  } catch { return false; }
}

/**
 * 只停 Bot 已证明的后代（排除本 helper 自身的祖先分支——我杀我自己 = 没有人执行
 * 重启）。祖先豁免以「helper 实测是目标 Bot 后代」为前提：是，才豁免 helper 到
 * Bot 之间的更新链祖先；不是（兄弟/独立拓扑），只豁免 helper 自身子树，绝不把
 * 公共宿主祖先（tmux server/宿主进程）的子树误放。每个目标按采集时的 starttime 守卫：TERM 有宽限，僵尸视为已停，宽限后
 * 仍存活才 KILL，且 KILL 前再次核对身份，绝不误杀复用 PID。Bot 本体最后停。
 */
async function stopBotTree(botPid, botStarttime, table) {
  const spared = new Set([process.pid]);
  const chainSeen = new Set([process.pid]);
  let cursor = table.get(process.pid);
  let helperUnderBot = false;
  while (cursor && cursor.ppid > 1 && !chainSeen.has(cursor.ppid)) {
    if (cursor.ppid === botPid) { helperUnderBot = true; break; }
    chainSeen.add(cursor.ppid);
    spared.add(cursor.ppid);
    cursor = table.get(cursor.ppid);
  }
  // 公共祖先守卫（2026-10-05 真实回归）：只有 helper 的祖先链实测能走到目标
  // Bot（helper 确是其后代，生产 updater 拓扑）时，沿途祖先才是可信的「更新链」
  // 而豁免。兄弟/独立拓扑下（如 helper 与被测 Bot 同 tmux server 的不同 pane），
  // 这条链会一路爬过公共祖先（tmux server/宿主进程）——其子树展开会把目标 Bot
  // 的子进程一并误放。此时只豁免 helper 自身及其子树，任何宿主祖先都不豁免。
  if (!helperUnderBot) {
    spared.clear();
    spared.add(process.pid);
  }
  const sparedSubtree = new Set(spared);
  const expand = [...spared];
  while (expand.length) {
    const pid = expand.pop();
    for (const [child, info] of table) {
      if (info.ppid === pid && !sparedSubtree.has(child)) {
        sparedSubtree.add(child);
        expand.push(child);
      }
    }
  }
  const depth = new Map([[botPid, 0]]);
  const victims = [];
  const queue = [botPid];
  while (queue.length) {
    const pid = queue.shift();
    for (const [child, info] of table) {
      if (info.ppid !== pid || depth.has(child)) continue;
      depth.set(child, depth.get(pid) + 1);
      queue.push(child);
      if (!sparedSubtree.has(child)) victims.push(child);
    }
  }
  if (victims.includes(process.pid)) throw new Error('停止集合包含应用进程自身，取消应用');
  const targets = [...victims.sort((a, b) => depth.get(b) - depth.get(a)), botPid];
  const identities = new Map(targets.map(pid => [pid, (table.get(pid) || {}).starttime || '']));
  identities.set(botPid, botStarttime);
  for (const pid of targets) signalGuarded(pid, identities.get(pid), 'SIGTERM');
  const termDeadline = Date.now() + TERM_GRACE_MS;
  while (Date.now() < termDeadline
    && targets.some(pid => aliveNonZombie(pid, identities.get(pid)))) await sleep(300);
  for (const pid of targets) signalGuarded(pid, identities.get(pid), 'SIGKILL');
  const killDeadline = Date.now() + KILL_GRACE_MS;
  while (Date.now() < killDeadline
    && targets.some(pid => aliveNonZombie(pid, identities.get(pid)))) await sleep(200);
  if (targets.some(pid => aliveNonZombie(pid, identities.get(pid)))) {
    throw new Error('旧 Bot 进程未全部退出（存在不可中断进程），取消重启');
  }
}

/** pane shell 是否已回到可接命令状态（tty 语义，不数后台实例）：
 * 1) shell 自身处于 tty 前台进程组（tpgid === shell pgrp）——交互 shell 的前台
 *    任务运行时 tpgid 是任务进程组，直接判出「忙」；
 * 2) 没有共享 shell 进程组的存活子进程——后台任务有自己的进程组不阻挡送键，
 *    而 shell 进程组内的存活子进程可能正在消费 stdin，保守视为忙。
 * 无法证明空闲（读不到 tty 状态）时返回 false，由调用方选择等待或中止。 */
function paneAcceptingCommands(panePid) {
  const shell = readStat(panePid);
  if (!shell || !(shell.tpgid > 0) || shell.tpgid !== shell.pgrp) return false;
  const table = collectProcesses();
  for (const info of table.values()) {
    if (info.ppid === panePid && info.state !== 'Z' && info.state !== 'X' && info.pgrp === shell.pgrp) return false;
  }
  return true;
}

/** 在原 pane 进程树里找到按捕获 argv 重启的新 Bot（排除旧 pid 与本 helper）。 */
function findRestartedBot(panePid, argv, excludePid, minStarttime) {
  const table = collectProcesses();
  const wanted = argv.join('\0');
  for (const [pid, info] of table) {
    if (pid === excludePid || pid === process.pid) continue;
    if (!isDescendantOf(pid, panePid, table)) continue;
    if (minStarttime && Number(info.starttime) < minStarttime) continue;
    const cmdline = readCmdline(pid);
    if (cmdline && cmdline.join('\0') === wanted) return pid;
  }
  return 0;
}

async function spawnStarttime(pid) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const value = processStarttime(pid);
    if (value) return value;
    await sleep(200);
  }
  return '';
}

// ---- --restart 分支：在原 pane 的 shell 里运行，重启原 Bot 并等待退出 ----
async function restartFrom(contextFile) {
  const context = JSON.parse(fs.readFileSync(contextFile, 'utf8'));
  const logDir = path.join(context.dataDir, 'logs');
  fs.mkdirSync(logDir, { recursive: true, mode: 0o700 });
  const restartLog = path.join(logDir, `bot-restart-${Date.now()}.log`);
  const logFd = fs.openSync(restartLog, 'a', 0o600);
  let child;
  try {
    // 非 detached：新 Bot 作为本进程子进程存在，本进程随 pane 前台存续，
    // Bot 始终保持原 pane 后代身份；Bot 退出时本进程随之退出（pane 回到提示符）。
    // 可执行文件用捕获的原 exe（/proc/exe），argv0 保留原 cmdline[0]——argv[0]
    // 可能只是 PATH 解析名或显示名，不直接当可执行文件猜。绝不打印 env。
    child = spawn(context.exe || context.argv[0], context.argv.slice(1), {
      cwd: context.cwd, env: context.env, stdio: ['ignore', logFd, logFd],
      argv0: context.argv0 || context.argv[0],
    });
  } finally {
    fs.closeSync(logFd);
  }
  if (!child.pid) {
    process.exitCode = 1;
    return;
  }
  const code = await new Promise(resolve => child.once('exit', exitCode => resolve(exitCode)));
  process.exit(Number.isInteger(code) ? code : 1);
}

// ---- 主模式入口 ----
async function main() {
  const botPid = Number(arg('bot-pid'));
  const botStarttime = arg('bot-starttime');
  const expectedHead = arg('expected-head');
  const tmuxTarget = arg('tmux-target');
  const dataDir = path.resolve(arg('data-dir'));
  const adminPort = Number(arg('admin-port')) || 3007;
  const nodeBinDir = path.resolve(arg('node-bin-dir') || path.dirname(process.execPath));
  const autonomyRequired = arg('autonomy') === '1';
  // 隔离候选（Stage C）：--target-root = 已接受公开提交上的干净运行时工作区。
  // 提供时部署/构建/HEAD 核对全部落在目标根；原库保留物只做「未被触碰」证明，
  // 绝不部署原库内容。未提供时保持既有同根路径（REPO_ROOT）语义不变。
  const targetRootArg = arg('target-root');
  const targetRoot = targetRootArg ? path.resolve(targetRootArg) : '';
  // 仅隔离候选模式加载发布模块（同根 legacy 部署的极简环境没有这些源文件）。
  const evolutionPublish = targetRoot ? require('../src/services/evolution-publish') : null;
  for (const [label, ok] of [['bot-pid', botPid > 0], ['bot-starttime', /^\d+$/.test(botStarttime)],
    ['expected-head', /^[0-9a-f]{40}$/.test(expectedHead)], ['tmux-target', !!tmuxTarget]]) {
    if (!ok) return fail(`缺少或非法参数：${label}`);
  }

  // 每次复核都重新采表并重验 Bot 身份 + pane 归属（pane PID 自身也要防复用）。
  const firstPanePid = panePidOf(tmuxTarget);
  const firstPaneStart = firstPanePid ? processStarttime(firstPanePid) : '';
  const verifyContext = () => {
    const table = collectProcesses();
    const bot = table.get(botPid);
    if (!bot || bot.starttime !== botStarttime) {
      throw new Error(`Bot 进程 ${botPid} 已不存在或 starttime 不符，取消应用（服务保持运行）`);
    }
    const panePid = panePidOf(tmuxTarget);
    if (!panePid) throw new Error('目标 pane 已消失');
    if (!isDescendantOf(botPid, panePid, table)) {
      throw new Error(`Bot ${botPid} 不在 tmux pane ${tmuxTarget} 的进程树内，取消应用（防误伤旁观实例）`);
    }
    return { table, panePid };
  };
  const deployRoot = targetRoot || REPO_ROOT;
  const assertDeployable = () => {
    if (git(['rev-parse', 'HEAD'], deployRoot) !== expectedHead) throw new Error('HEAD 已漂移');
    if (git(['status', '--porcelain', '--untracked-files=normal'], deployRoot)) throw new Error('工作区不干净');
  };
  // 目标根全链证明（停服前失败 = 旧服务保持在线）：运行时根绑定/源内容指纹
  // （logicSnapshot：当前内容+权限，非 HEAD/status 哈希）/验证记录（真实 runner
  // 的 backend+frontend 通过证据，非空且指纹一致）/原库保留物未动/任务区
  // provenance（对照受信提交，不再拿建区 HEAD 硬套已提交候选）/远端身份/运行时
  // 资源就绪（tmp 可写、依赖可用），全部不可证明即取消。
  let targetRecord = null;
  let targetSourceRoot = '';
  // 验收证书素材（2026-10-08 二批）：只在真实 ready 后落盘——证明成功的溯源快照与
  // 实测通过的验证摘要都是「assertTargetProven 实际核过」的观测值，绝不从模型
  // 文本或未来全局记录推断通过标志。
  let targetProvenance = null;
  let targetValidation = null;
  const assertTargetProven = () => {
    if (!targetRoot) return;
    const record = evolutionPublish.readApplyTarget(dataDir);
    if (!record || record.commit !== expectedHead
      || path.resolve(record.runtimeRoot) !== targetRoot) {
      throw new Error('运行时目标记录与参数不符（提交/目标根漂移），取消应用');
    }
    if (!/^[0-9a-f]{64}$/.test(record.sourceFingerprint || '')) {
      throw new Error('应用目标记录缺少内容指纹（sourceFingerprint），取消应用');
    }
    const provenance = evolutionPublish.readProvenance(dataDir);
    const verified = provenance
      ? evolutionPublish.verifyTaskWorkspace(REPO_ROOT, provenance, { expectedHead }) : { ok: false };
    if (!verified.ok || provenance.runId !== record.runId) {
      throw new Error(`任务工作区 provenance 不可证明（${verified.reason || 'missing'}），取消应用`);
    }
    // 被证明的源仓库根（原库）：Bot 上下文映射用它做前缀合同（cwd 常在 <根>/core，
    // 不能把 cwd 当仓库根——那会把 client.js 映射到目标根根下）。
    targetSourceRoot = provenance.repoRootReal;
    const manifest = evolutionPublish.readHoldManifest(dataDir);
    // 保留物按清单记录的原始仓库根核对（Bot 换根运行后 REPO_ROOT 不再是原库）。
    const hold = evolutionPublish.verifyHoldUnchanged(manifest?.repoRootReal || REPO_ROOT, manifest);
    if (!hold.ok || evolutionPublish.holdDigest(manifest) !== record.holdDigest) {
      throw new Error(`原库保留物已变化（${hold.reason || '摘要不符'}），取消应用`);
    }
    if (evolutionPublish.remoteMainHead(targetRoot) !== expectedHead) {
      throw new Error('远端 origin/main 与待应用提交不一致，取消应用');
    }
    // 运行时源内容身份：当前内容+权限指纹（logicSnapshot）必须等于记录值——
    // 干净树上的权限改动（如 chmod 644→600）HEAD/status 指纹捕获不到。
    const validation = require('../src/services/evolution-validation');
    if (validation.logicSnapshot(targetRoot).fingerprint !== record.sourceFingerprint) {
      throw new Error('运行时内容指纹与记录不符，取消应用');
    }
    // 内容验证证据（真实协调器 backend+frontend）：记录必须 passed、全项完成、
    // 且其指纹就是这个源内容——缺失/空/漂移一律停服前拒绝。
    const summary = validation.getValidationSummary(dataDir);
    const expectedChecks = fs.existsSync(path.join(targetRoot, 'web', 'package.json'))
      ? 'backend,frontend' : 'backend';
    if (summary.state !== 'passed' || summary.checks.join(',') !== expectedChecks
      || summary.fingerprint !== record.sourceFingerprint) {
      throw new Error('离线回归验证记录缺失/未通过/指纹不符，取消应用');
    }
    // 运行时资源就绪：tmp 必须可写（构建/收尾都落在这里），依赖目录可用。
    const probe = path.join(targetRoot, 'tmp', `probe.${process.pid}`);
    fs.mkdirSync(path.join(targetRoot, 'tmp'), { recursive: true, mode: 0o700 });
    try {
      fs.writeFileSync(probe, 'x');
      fs.unlinkSync(probe);
    } catch (error) {
      throw new Error(`运行时 tmp 不可写，取消应用（${error.code || error.message}）`);
    }
    const inspected = require('../src/services/evolution-worktree').inspectWorktree(targetRoot);
    if (inspected.head !== expectedHead || inspected.dirty) {
      throw new Error('运行时工作区已漂移（HEAD/干净度），取消应用');
    }
    targetRecord = record;
    targetProvenance = provenance;
    targetValidation = {
      state: summary.state, fingerprint: summary.fingerprint,
      checks: summary.checks, checkedAt: summary.checkedAt || 0,
    };
  };
  try { assertTargetProven(); } catch (error) { return fail(`应用前置校验失败（服务保持运行）：${error.message}`); }
  let { table, panePid } = verifyContext();
  if (!firstPaneStart || panePid !== firstPanePid || processStarttime(panePid) !== firstPaneStart) {
    return fail('pane 进程身份不稳定（PID 复用或 pane 已重建），取消应用');
  }
  try { assertDeployable(); } catch (error) { return fail(`应用前置校验失败（服务保持运行）：${error.message}`); }
  // 端口持有者必须落在本次停止集合内：旁观实例持端口时新 Bot 绑定必然失败，
  // 只能在停服之前如实失败（服务保持在线）。
  const owners = portOwnerPids(adminPort, table);
  if (owners.length && !owners.every(pid => pid === botPid || isDescendantOf(pid, botPid, table))) {
    return fail(`端口 ${adminPort} 由停止集合外的进程持有（pid ${owners.join(',')}），取消应用（服务保持运行）`);
  }

  fs.mkdirSync(path.join(dataDir, 'logs'), { recursive: true, mode: 0o700 });
  const buildLog = path.join(dataDir, 'logs', 'evolve-apply.log');
  const buildRoot = fs.mkdtempSync(path.join(deployRoot, 'tmp', 'evolution-apply.XXXXXX'));
  let contextFile = '';
  const receiptFile = path.join(dataDir, 'evolution-apply-receipt.json');
  const writeReceipt = (fields) => {
    fs.writeFileSync(receiptFile, `${JSON.stringify({
      expectedHead, oldPid: botPid, oldStarttime: botStarttime, adminPort, startedAt: Date.now(),
      ...(targetRoot ? { runtimeRoot: targetRoot,
        sourceFingerprint: targetRecord ? targetRecord.sourceFingerprint : '',
        holdDigest: targetRecord ? targetRecord.holdDigest : '' } : {}),
      ...fields,
    })}\n`, { mode: 0o600 });
    try { fs.chmodSync(receiptFile, 0o600); } catch {}
  };
  try {
    // 隔离构建（失败不停旧服务）。
    await new Promise((resolve, reject) => {
      const out = fs.openSync(buildLog, 'a', 0o600);
      const child = spawn('npm', ['run', 'build', '--', '--outDir', path.join(buildRoot, 'dist'), '--emptyOutDir'], {
        cwd: path.join(deployRoot, 'web'),
        env: { ...process.env, PATH: `${nodeBinDir}${path.delimiter}${process.env.PATH || ''}` },
        stdio: ['ignore', out, out],
      });
      fs.closeSync(out);
      child.once('error', reject);
      child.once('exit', code => (code === 0 ? resolve() : reject(new Error(`web 构建退出码 ${code}`))));
    });
    if (!fs.existsSync(path.join(buildRoot, 'dist', 'index.html'))) throw new Error('构建产物缺少 index.html');

    // 停止前全量复核：build 耗时数分钟，Bot/pane 身份、归属、部署前提与自主开关
    // 都可能已变化；新出现的 Bot 后代也要进停止集合（重新采表）。
    ({ table, panePid } = verifyContext());
    if (panePid !== firstPanePid || processStarttime(panePid) !== firstPaneStart) {
      throw new Error('pane 进程已重启或重建（PID/身份变化），取消应用');
    }
    if (autonomyRequired && !autonomyStillEnabled(dataDir)) {
      throw new Error('自主进化已被关闭，取消本次自动应用（候选与旧服务保留）');
    }
    assertDeployable();
    assertTargetProven();

    // 私有捕获 Bot 原始启动上下文（0600；重启完成或失败后即删，绝不入库）。
    contextFile = path.join(dataDir, 'evolution-apply-context.json');
    const readProcList = (file) => {
      const parts = fs.readFileSync(`/proc/${botPid}/${file}`, 'utf8').split('\0');
      if (parts.length && parts[parts.length - 1] === '') parts.pop();
      return parts;
    };
    const botContext = {
      argv: readProcList('cmdline'),
      exe: (() => { try { return fs.readlinkSync(`/proc/${botPid}/exe`); } catch { return ''; } })(),
      argv0: readProcList('cmdline')[0] || '',
      env: Object.fromEntries(readProcList('environ').map(item => {
        const index = item.indexOf('=');
        return index > 0 ? [item.slice(0, index), item.slice(index + 1)] : null;
      }).filter(Boolean)),
      cwd: fs.readlinkSync(`/proc/${botPid}/cwd`),
      dataDir,
      adminPort,
      expectedHead,
    };
    // 隔离候选：Bot 上下文按「被证明的源仓库根（provenance.repoRootReal）→ 目标根」
    // 映射。真实脚本形态是 argv=[node,'client.js']、cwd=<源根>/core——cwd 不是仓库
    // 根；入口从原始 cwd 解析后落在源根内才可映射。只映射被证明的 Node 入口与
    // cwd，其余 argv（旗标/普通参数）原样保留；映射不可证明在停服前失败。
    // FARM_DATA_DIR 强制指向实际原数据目录（运行时共享原数据）。
    if (targetRoot) {
      const { argv, argv0, exe, cwd, env } = evolutionPublish
        .mapBotContextToTarget(botContext, targetSourceRoot, targetRoot, dataDir);
      Object.assign(botContext, { argv, argv0, exe, cwd, env });
    }
    fs.writeFileSync(contextFile, `${JSON.stringify(botContext)}\n`, { mode: 0o600 });
    try { fs.chmodSync(contextFile, 0o600); } catch {}

    writeReceipt({ phase: 'stopping', newPid: 0, newStarttime: '' });
    await stopBotTree(botPid, botStarttime, table);

    // 端口释放失败必须中止：残留持有者会让新 Bot 无法绑定，绝不能换 dist/重启。
    const released = await waitFor(() => portFree(adminPort), 15_000, `端口 ${adminPort} 释放`);
    if (!released) throw new Error(`端口 ${adminPort} 在旧进程退出后仍未释放，取消重启（请人工检查）`);

    const distDir = path.join(deployRoot, 'web', 'dist');
    const previousDist = path.join(buildRoot, 'previous-dist');
    if (fs.existsSync(distDir)) fs.renameSync(distDir, previousDist);
    try {
      fs.renameSync(path.join(buildRoot, 'dist'), distDir);
    } catch (error) {
      if (fs.existsSync(previousDist)) fs.renameSync(previousDist, distDir);
      throw error;
    }

    writeReceipt({ phase: 'starting', newPid: 0, newStarttime: '' });
    // 在原 pane 的 shell 中启动受审 --restart 分支：只有 shell 真正回到可接命令状态
    // （tty 前台进程组判定）才送键；keystrokes 落进仍在运行的前台进程会是错误输入，
    // 无法证明空闲就诚实中止重启，绝不超时后猜着送。
    const quiet = await waitFor(() => paneAcceptingCommands(panePid), 10_000, 'pane 提示符空闲');
    if (!quiet) throw new Error('pane 前台未回到提示符（仍有前台任务或无法证明空闲），已取消送键重启，请人工处理');
    const command = [process.execPath, __filename, '--restart', contextFile].map(shellQuote).join(' ');
    // 单事务送键（2026-10-08 真实事故修复）：清行（C-u）+ 字面命令 + 回车必须在
    // 一个 tmux 调用里以原始字节（-H hex）送达。旧实现分两次 exec——literal 已敲入
    // 而 Enter 未达的中断窗口里，pane 残留未提交行；下一个 helper 又把命令直接拼在
    // 残行之后，坏路径 context.json/root/.nvm/.../node 打开失败、helper 超时且服务
    // 已停。注意不能用 C-u ... -l cmd Enter 混排：本机 tmux 会把中途的 -l 当字面键
    // 敲出（实测 -lecho ...）；-H 按字节发送无歧义（0x15=C-u、0x0d=回车，UTF-8 安全）。
    // Buffer.concat 显式字节（0x15/0x0d）：模板字符串转义在复制/改写时易被二次
    // 转义成字面反斜杠文本（2026-10-08 事故复核），直接给字节杜绝歧义。
    const keyBytes = Buffer.concat([
      Buffer.from([0x15]), Buffer.from(command, 'utf8'), Buffer.from([0x0D]),
    ]);
    execFileSync('tmux', ['send-keys', '-t', tmuxTarget, '-H',
      ...keyBytes.toString('hex').match(/../g)], { stdio: ['ignore', 'ignore', 'ignore'] });

    const minStarttime = Number(processStarttime(process.pid)) || 0;
    // waitFor 返回谓词真值：这里就是找到的新 Bot PID（不是布尔），绝不能当 true 用。
    const newBot = await waitFor(() => findRestartedBot(panePid, botContext.argv, botPid, minStarttime),
      30_000, '新 Bot 进程出现在原 pane');
    if (!newBot) throw new Error('新 Bot 未在原 pane 中启动（重启未发生，服务已停止，请人工启动）');
    const newStarttime = await spawnStarttime(newBot);
    writeReceipt({ phase: 'started', newPid: newBot, newStarttime });

    // ready = 新进程仍存活且身份未复用 + HEAD 未漂移 + 真实持有 adminPort 的
    // LISTEN socket + /api/health 返回 ok:true。任意 TCP 应答不算成功。
    const ready = await waitFor(async () => {
      if (!aliveNonZombie(newBot, newStarttime)) return false;
      if (git(['rev-parse', 'HEAD'], deployRoot) !== expectedHead) return false;
      if (!holdsSocket(newBot, listeningInodes(adminPort))) return false;
      return await healthOk(adminPort);
    }, 90_000, `新 Bot 端口 ${adminPort} 监听与健康检查`);
    // ready 之后、落盘回执之前再全量重证一次：健康进程不能掩盖「源内容/保留物/
    // 远端在重启窗口内被改写」——此时仍可诚实 failed，而不是把错误对象标记 ready。
    if (ready && targetRoot) {
      try { assertTargetProven(); } catch (error) {
        writeReceipt({ phase: 'failed', newPid: newBot, newStarttime: processStarttime(newBot) || '',
          error: `就绪后复核失败：${String(error.message || '').slice(0, 240)}` });
        return fail(error.message || '就绪后复核失败');
      }
    }
    writeReceipt({ phase: ready ? 'ready' : 'ready-timeout', newPid: newBot,
      newStarttime: processStarttime(newBot) || '', readyAt: ready ? Date.now() : 0 });
    // 真实 ready（源/进程/端口/健康/验证 + 就绪后全量重证全部实测通过）才写「最近
    // 一次 ready」验收证书：原库普通启动据此选择本运行时，而不再依赖会被下一轮
    // 研究合法替换的全局验证/任务记录。ready-timeout/failed 绝不触碰既有证书。
    if (ready && targetRoot && targetRecord) {
      writeApprovedCertificate(dataDir, {
        version: 1,
        certifiedAt: Date.now(),
        target: { ...targetRecord },
        validation: targetValidation,
        provenance: targetProvenance,
        process: { newPid: newBot, newStarttime: processStarttime(newBot) || '',
          adminPort, expectedHead },
      });
    }
    // 私有上下文用后即删（environ 含凭据，不留存）。
    try { fs.unlinkSync(contextFile); } catch {}
    contextFile = '';
    if (!ready) process.exitCode = 1;
  } catch (error) {
    if (contextFile) { try { fs.unlinkSync(contextFile); } catch {} }
    writeReceipt({ phase: 'failed', newPid: 0, newStarttime: '', error: String(error.message || '').slice(0, 300) });
    return fail(error.message || '应用失败');
  } finally {
    try { fs.rmSync(buildRoot, { recursive: true, force: true }); } catch {}
  }
}

if (require.main === module) {
  const restartFile = arg('restart');
  if (restartFile) void restartFrom(restartFile);
  else void main();
}
module.exports = {
  collectProcesses, readStat, processStarttime, isDescendantOf, aliveNonZombie,
  signalGuarded, listeningInodes, holdsSocket,
};
