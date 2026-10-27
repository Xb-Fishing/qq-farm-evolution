'use strict';
// 批准运行时入口路由回归（2026-10-08 维护会话，二批扩展）：真实本地 git 仓库 +
// bare 远端 + 真实 worktree 运行时 + 合成标记子进程。覆盖：冷启动源入口重定向
// （真实子进程 argv/cwd/共享 dataDir，旧入口哨兵绝不落盘）、旧源无路由反例、
// 同根自举不循环（已接受/pending 两形态都实测身份）、worker/抓包/打包/无目标
// 保持原语义、回执/校验/指纹/HEAD/干净/外库/符号链接/保留物/溯源各类拒绝先于
// 目标执行、退出码与信号精确传播；二批新增：最近一次 ready 验收证书选择（全局
// 记录被下一轮合法替换/失败后已接受运行时仍可启动、更新 pending 不被提前执行）、
// 同根权限/内容/HEAD 漂移拒绝、证书损坏拒绝、验收时溯源快照容忍任务区漂移/清理。
// 标记文件放在共享 dataDir（git 忽略）内：既证明数据共享，也不弄脏运行时树。
// 不触真实远端/服务/生产数据，无游戏请求；全部夹具只在独立临时目录内创建。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync, spawnSync } = require('node:child_process');

// ---------------------------------------------------------------------------
// 夹具 Git 环境隔离（与 evolution-publish 轮同类）：协调进程注入生产形态
// GIT_CONFIG_COUNT/KEY_*/VALUE_*（core.hooksPath → 真实 pre-push 无条件拒绝）。
// 被 runner 直接执行时先在净化环境副本中重执行自身；宿主 env 与候选源码指纹
// 成功/失败路径前后都必须保持不变。
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
const CORE_ROOT = path.resolve(__dirname, '..');
const GUARD_ROOT = path.resolve(__dirname, '..', '..');
const GUARD_SOURCES = [
  'core/client.js',
  'core/src/runtime/approved-runtime-entry.js',
  'core/src/services/privacy-guard.js',
  'core/src/services/evolution-validation.js',
  'core/src/services/evolution-publish.js',
  'core/src/services/evolution-worktree.js',
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

const test = require('node:test');
const assert = require('node:assert/strict');
// 测试进程自身先设独立数据目录，再加载被测模块（业务模块零加载，双保险）。
const originalDataDir = process.env.FARM_DATA_DIR;
process.env.FARM_DATA_DIR = process.env.FARM_DATA_DIR
  || fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'approved-entry-data-'));
const entry = require('../src/runtime/approved-runtime-entry');
const publish = require('../src/services/evolution-publish');

// ---------------------------------------------------------------------------
// 夹具写边界：临时根 realpath 后必须不在源仓库内（拒绝 repository-root TMPDIR
// 逃逸，且拒绝发生在任何 mkdir 之前）；具体写入再按 fixture 根做外穿硬拒。
// ---------------------------------------------------------------------------
function fixtureBaseDir() {
  const base = fs.realpathSync(os.tmpdir());
  const resolved = path.resolve(base);
  if (resolved === GUARD_ROOT || resolved.startsWith(GUARD_ROOT + path.sep)) {
    throw new Error('fixture_tmpdir_inside_repository');
  }
  return base;
}
function checkedMkdtemp(prefix) {
  return fs.mkdtempSync(path.join(fixtureBaseDir(), prefix));
}
function sourceFingerprintOf(root) {
  const hash = crypto.createHash('sha256');
  const gitRaw = args => execFileSync('git', args,
    { cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  hash.update(gitRaw(['rev-parse', 'HEAD']));
  hash.update(gitRaw(['status', '--porcelain', '-z', '--untracked-files=normal']));
  return hash.digest('hex');
}

// 源检出（旧形态）：无入口路由，业务自举直接落标记 —— 旧源反例的基线行为。
// 目标/受管源检出：入口最早路由；dispatch 后本进程不再落任何标记。
// 标记写入共享 dataDir 内的 FARM_TEST_MARKER（append 一行含真实 cwd/argv/入口）。
function fixtureClientSource(routed) {
  const lines = [
    'const fs = require(\'node:fs\');',
    'const process = require(\'node:process\');',
    routed ? 'require(\'./src/runtime/approved-runtime-entry\').routeApprovedRuntime(process);' : '',
    'const marker = process.env.FARM_TEST_MARKER;',
    'if (marker) fs.appendFileSync(marker, JSON.stringify({ cwd: process.cwd(), argv: process.argv, entry: __filename, dataDir: process.env.FARM_DATA_DIR || \'\' }) + \'\\n\');',
    'const code = Number(process.env.FARM_TEST_EXIT_CODE || 0);',
    'if (process.env.FARM_TEST_SELF_SIGNAL) process.kill(process.pid, process.env.FARM_TEST_SELF_SIGNAL);',
    'else if (code) process.exit(code);',
  ].filter(Boolean);
  return `${lines.join('\n')}\n`;
}
const OLD_CLIENT = fixtureClientSource(false);
const ROUTED_CLIENT = fixtureClientSource(true);
const PRIVACY_STUB = 'module.exports = { auditGitRange: () => ({ ok: true, findings: [] }), collectRuntimePrivacyTerms: () => [] };\n';
const REAL_SOURCES = {
  'core/src/runtime/approved-runtime-entry.js': path.join(CORE_ROOT, 'src', 'runtime', 'approved-runtime-entry.js'),
  'core/src/services/evolution-validation.js': path.join(CORE_ROOT, 'src', 'services', 'evolution-validation.js'),
  'core/src/services/evolution-publish.js': path.join(CORE_ROOT, 'src', 'services', 'evolution-publish.js'),
  'core/src/services/evolution-worktree.js': path.join(CORE_ROOT, 'src', 'services', 'evolution-worktree.js'),
};

const RUN_ID = 'oct08-entry-test';

/**
 * 构建完整夹具（真实 git + bare 远端 + 任务区候选提交 + 干净运行时 worktree +
 * 保留草稿/引导对 + 四份私有记录）。certificate=true 时额外写「最近一次真实
 * ready」验收证书（模拟 helper 成功应用后的落盘事实）。foreignTarget=true 时不建
 * 真实运行时，改为在精确边界上放一个外库 git 仓库（同形目录冒充；指纹用合成
 * 64hex 占位）。
 */
function makeRoutingFixture(tag, { foreignTarget = false, certificate = false } = {}) {
  const root = checkedMkdtemp(`farm-entry-${tag}-`);
  const remote = `${root}-remote.git`;
  const dataDir = path.join(root, 'core', 'data');
  const markerFile = path.join(dataDir, 'boot-marker.json');
  const git = (args, cwd = root) => execFileSync('git', args,
    { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const write = (base, file, text) => {
    const full = path.resolve(base, file);
    if (full !== base && !full.startsWith(base + path.sep)) throw new Error(`fixture_escape:${file}`);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, text);
  };
  try {
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
    // 基线提交 = 旧检出形态（无路由入口 + 可用的验证模块）。
    write(root, '.gitignore', 'tmp/\ncore/data/\n');
    write(root, 'core/src/services/evolution-validation.js',
      fs.readFileSync(REAL_SOURCES['core/src/services/evolution-validation.js']));
    write(root, 'core/client.js', OLD_CLIENT);
    git(['init', '-q', '-b', 'main']);
    git(['config', 'user.name', 'Test']);
    git(['config', 'user.email', 'test@users.noreply.github.com']);
    git(['add', '.']);
    git(['commit', '-qm', 'fixture base']);
    git(['remote', 'add', 'origin', remote]);
    git(['push', '-q', 'origin', 'main']);
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    // 任务区候选提交 = 新运行时形态（路由入口 + helper + 目标侧 publish 服务）。
    const provenance = publish.createTaskWorkspace({ repoRoot: root, dataDir, runId: RUN_ID });
    write(provenance.taskRoot, 'core/client.js', ROUTED_CLIENT);
    for (const [file, source] of Object.entries(REAL_SOURCES)) {
      write(provenance.taskRoot, file, fs.readFileSync(source));
    }
    write(provenance.taskRoot, 'core/src/services/privacy-guard.js', PRIVACY_STUB);
    git(['add', '.'], provenance.taskRoot);
    git(['commit', '-qm', 'candidate runtime'], provenance.taskRoot);
    const candidateHead = git(['rev-parse', 'HEAD'], provenance.taskRoot);
    // 运行时根：真实干净 worktree（或外库冒充目录）。
    let runtimeRoot;
    let logicFingerprint;
    if (foreignTarget) {
      runtimeRoot = path.join(root, 'tmp', 'evolution-workspaces', RUN_ID, `runtime-${candidateHead.slice(0, 12)}`);
      fs.mkdirSync(runtimeRoot, { recursive: true });
      git(['init', '-q', '-b', 'main'], runtimeRoot);
      git(['config', 'user.name', 'Test'], runtimeRoot);
      git(['config', 'user.email', 'test@users.noreply.github.com'], runtimeRoot);
      write(runtimeRoot, 'core/client.js', ROUTED_CLIENT);
      git(['add', '.'], runtimeRoot);
      git(['commit', '-qm', 'foreign lookalike'], runtimeRoot);
      logicFingerprint = '0'.repeat(64);
    } else {
      const prepared = publish.prepareRuntimeWorkspace({
        repoRoot: root, runId: RUN_ID, commit: candidateHead, dataDir,
      });
      runtimeRoot = prepared.runtimeRoot;
      logicFingerprint = prepared.logicFingerprint;
    }
    // 受管源检出 = 基线 HEAD + 保留草稿（未跟踪）+ 复制的引导对（模拟 Main 复制
    // bootstrap pair 后的新 hold 事实）。
    write(root, 'core/src/retained-draft.js', 'module.exports = "retained";\n');
    write(root, 'core/client.js', ROUTED_CLIENT);
    write(root, 'core/src/runtime/approved-runtime-entry.js',
      fs.readFileSync(REAL_SOURCES['core/src/runtime/approved-runtime-entry.js']));
    // 四份私有记录（合成验收记录，仅在独立临时目录内、明确标注为测试夹具）。
    const manifest = publish.buildHoldManifest(root);
    publish.recordHoldManifest(dataDir, manifest);
    const holdDigestValue = publish.holdDigest(manifest);
    publish.recordApplyTarget(dataDir, {
      runId: RUN_ID, commit: candidateHead, runtimeRoot,
      sourceFingerprint: logicFingerprint, holdDigest: holdDigestValue, createdAt: Date.now(),
    });
    fs.writeFileSync(path.join(dataDir, 'evolution-validation.json'),
      `${JSON.stringify({ version: 1, state: 'passed', checkedAt: Date.now(), fingerprint: logicFingerprint, checks: ['backend', 'frontend'] })}\n`);
    fs.writeFileSync(path.join(dataDir, 'evolution-apply-receipt.json'),
      `${JSON.stringify({ expectedHead: candidateHead, oldPid: 111, oldStarttime: '1', adminPort: 3007, startedAt: Date.now(), runtimeRoot, sourceFingerprint: logicFingerprint, holdDigest: holdDigestValue, phase: 'ready', newPid: 222, newStarttime: '2' })}\n`);
    if (certificate) {
      fs.writeFileSync(path.join(dataDir, 'evolution-approved-runtime.json'),
        `${JSON.stringify({ version: 1, certifiedAt: Date.now(),
          target: { runId: RUN_ID, commit: candidateHead, runtimeRoot,
            sourceFingerprint: logicFingerprint, holdDigest: holdDigestValue, createdAt: Date.now() - 1000 },
          validation: { state: 'passed', fingerprint: logicFingerprint, checks: ['backend', 'frontend'], checkedAt: Date.now() },
          provenance: { ...provenance },
          process: { newPid: 222, newStarttime: '2', adminPort: 3007, expectedHead: candidateHead } })}\n`,
        { mode: 0o600 });
    }
    return {
      root, remote, dataDir, markerFile, git, write, runtimeRoot, candidateHead, provenance,
      sourceFingerprint: () => sourceFingerprintOf(root),
      applyTargetFile: path.join(dataDir, 'evolution-apply-target.json'),
      receiptFile: path.join(dataDir, 'evolution-apply-receipt.json'),
      validationFile: path.join(dataDir, 'evolution-validation.json'),
      certificateFile: path.join(dataDir, 'evolution-approved-runtime.json'),
    };
  } catch (error) {
    try { execFileSync('git', ['worktree', 'prune'], { cwd: root, stdio: 'ignore' }); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(remote, { recursive: true, force: true });
    throw error;
  }
}

function cleanup(fixture) {
  try { execFileSync('git', ['worktree', 'prune'], { cwd: fixture.root, stdio: 'ignore' }); } catch {}
  fs.rmSync(fixture.root, { recursive: true, force: true });
  fs.rmSync(fixture.remote, { recursive: true, force: true });
}

/** 在既有夹具上追加「更新的 pending 候选」：任务区新提交 + 独立运行时根 + 目标
 * 记录切到 rt2（全局验证/回执由调用方按场景覆写，模拟下一轮研究/应用中状态）。 */
function addPendingCandidate(fixture) {
  fixture.write(fixture.provenance.taskRoot, 'core/src/example-pending.js', 'module.exports = 2;\n');
  fixture.git(['add', '.'], fixture.provenance.taskRoot);
  fixture.git(['commit', '-qm', 'candidate 2'], fixture.provenance.taskRoot);
  const head = fixture.git(['rev-parse', 'HEAD'], fixture.provenance.taskRoot);
  fixture.git(['push', '-q', 'origin', 'HEAD:main'], fixture.provenance.taskRoot);
  const prepared = publish.prepareRuntimeWorkspace({
    repoRoot: fixture.root, runId: RUN_ID, commit: head, dataDir: fixture.dataDir,
  });
  const record = JSON.parse(fs.readFileSync(fixture.applyTargetFile, 'utf8'));
  publish.recordApplyTarget(fixture.dataDir, {
    runId: RUN_ID, commit: head, runtimeRoot: prepared.runtimeRoot,
    sourceFingerprint: prepared.logicFingerprint, holdDigest: record.holdDigest, createdAt: Date.now(),
  });
  return { head, runtimeRoot: prepared.runtimeRoot, fingerprint: prepared.logicFingerprint };
}

function writeGlobalValidation(fixture, { state = 'passed', fingerprint, checks = ['backend', 'frontend'] }) {
  fs.writeFileSync(fixture.validationFile,
    `${JSON.stringify({ version: 1, state, checkedAt: Date.now(), fingerprint, checks })}\n`);
}

function childEnv(fixture, extra = {}) {
  const env = sanitizeGitConfigEnv(process.env);
  delete env.FARM_DATA_DIR;
  delete env.FARM_WORKER;
  delete env.FARM_CAPTURE_SERVER;
  return { ...env, FARM_TEST_MARKER: fixture.markerFile, ...extra };
}

function runClient(fixture, args = [], extraEnv = {}) {
  return spawnSync(process.execPath, [path.join(fixture.root, 'core', 'client.js'), ...args], {
    cwd: path.join(fixture.root, 'core'), env: childEnv(fixture, extraEnv), encoding: 'utf8',
  });
}

function readMarkers(fixture) {
  if (!fs.existsSync(fixture.markerFile)) return [];
  return fs.readFileSync(fixture.markerFile, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
}

function resolveOf(fixture, env = {}) {
  return entry.resolveApprovedRuntimeRouting({ repoRoot: fixture.root, env });
}
function resolveAt(repoRoot, fixture, env = {}) {
  return entry.resolveApprovedRuntimeRouting({ repoRoot, env });
}

// ---------------------------------------------------------------------------
// 夹具写边界：repository-root TMPDIR 逃逸必须在任何 mkdir 之前被拒绝。
// ---------------------------------------------------------------------------
test('夹具临时根不得解析进源仓库，拒绝先于任何目录创建', () => {
  const insideRepo = path.join(GUARD_ROOT, 'does-not-exist-fixture-escape');
  assert.ok(!fs.existsSync(insideRepo));
  const base = fs.realpathSync(os.tmpdir());
  if (base === GUARD_ROOT || base.startsWith(GUARD_ROOT + path.sep)) {
    assert.fail('real host tmpdir unexpectedly inside repository');
  }
  // 宿主真实 tmpdir 在仓库外时，checkedMkdtemp 正常工作且产物在仓库外。
  const okDir = checkedMkdtemp('farm-entry-boundary-');
  try {
    assert.ok(okDir.startsWith(base + path.sep));
    assert.ok(!okDir.startsWith(GUARD_ROOT + path.sep));
  } finally { fs.rmSync(okDir, { recursive: true, force: true }); }
  assert.ok(!fs.existsSync(insideRepo), 'no directory created inside repository');
});

test('冷启动源入口重定向到选中运行时：真实子进程目标 argv/cwd/共享数据，源侧旧自举绝不落盘', () => {
  const fixture = makeRoutingFixture('cold');
  try {
    const before = fixture.sourceFingerprint();
    const run = runClient(fixture, ['--user-arg']);
    assert.equal(run.status, 0, `stderr: ${run.stderr}`);
    // 真实子进程：目标入口/cwd/argv/共享 dataDir 全部落在选中运行时。
    let markers = readMarkers(fixture);
    assert.equal(markers.length, 1, 'exactly one business bootstrap must run');
    assert.equal(markers[0].entry, path.join(fixture.runtimeRoot, 'core', 'client.js'),
      'source-side old bootstrap sentinel must never run');
    assert.equal(markers[0].cwd, path.join(fixture.runtimeRoot, 'core'));
    assert.equal(markers[0].argv[1], path.join(fixture.runtimeRoot, 'core', 'client.js'));
    assert.ok(markers[0].argv.includes('--user-arg'));
    assert.equal(markers[0].dataDir, fixture.dataDir);
    // 受管源检出（含保留草稿与引导对）前后指纹不变。
    assert.equal(fixture.sourceFingerprint(), before);
    // 复跑同一夹具（连续启动）仍精确重定向一次。
    const again = runClient(fixture);
    assert.equal(again.status, 0, `stderr: ${again.stderr}`);
    markers = readMarkers(fixture);
    assert.equal(markers.length, 2);
    assert.ok(markers.every(m => m.entry === path.join(fixture.runtimeRoot, 'core', 'client.js')));
  } finally { cleanup(fixture); }
});

test('旧源反例：无入口路由的基线检出直接执行旧自举（无 dispatch）', () => {
  const fixture = makeRoutingFixture('stale');
  try {
    // 公开基线的真实检出 = 旧形态源（基线提交无路由入口）。
    const staleRoot = path.join(fixture.root, 'tmp', 'stale-base');
    fixture.git(['worktree', 'add', '-q', '--detach', staleRoot, fixture.provenance.publicBase]);
    const run = spawnSync(process.execPath, [path.join(staleRoot, 'core', 'client.js')], {
      cwd: path.join(staleRoot, 'core'), env: childEnv(fixture), encoding: 'utf8',
    });
    assert.equal(run.status, 0, `stderr: ${run.stderr}`);
    const markers = readMarkers(fixture);
    assert.equal(markers.length, 1);
    assert.equal(markers[0].entry, path.join(staleRoot, 'core', 'client.js'),
      'stale source without routing must run its own old bootstrap (baseline counterexample)');
  } finally { cleanup(fixture); }
});

test('选中运行时自身自举不循环：直接启动目标根只跑一次业务自举', () => {
  const fixture = makeRoutingFixture('noloop');
  try {
    const run = spawnSync(process.execPath, [path.join(fixture.runtimeRoot, 'core', 'client.js')], {
      cwd: path.join(fixture.runtimeRoot, 'core'),
      env: childEnv(fixture, { FARM_DATA_DIR: fixture.dataDir }), encoding: 'utf8',
    });
    assert.equal(run.status, 0, `stderr: ${run.stderr}`);
    const markers = readMarkers(fixture);
    assert.equal(markers.length, 1, 'selected runtime must bootstrap directly without respawning');
    assert.equal(markers[0].entry, path.join(fixture.runtimeRoot, 'core', 'client.js'));
    // 判定层同样返回普通自举（不重生）：以选中运行时根为当前仓库根（此处是
    // helper 正在应用的 pending 根，当前全局验证匹配才放行）。
    assert.deepEqual(resolveAt(fixture.runtimeRoot, fixture, { FARM_DATA_DIR: fixture.dataDir }),
      { action: 'ordinary', reason: 'pending_runtime_bootstrap' });
  } finally { cleanup(fixture); }
});

test('worker/抓包/打包可执行/无管理目标全部保持既有入口语义，不消费外部记录', () => {
  const fixture = makeRoutingFixture('bypass');
  try {
    const sourceEntry = path.join(fixture.root, 'core', 'client.js');
    // 无管理目标：删除记录后源检出普通自举。
    const targetRecord = fs.readFileSync(fixture.applyTargetFile, 'utf8');
    fs.rmSync(fixture.applyTargetFile);
    assert.deepEqual(resolveOf(fixture), { action: 'ordinary', reason: 'no_apply_target' });
    let run = runClient(fixture);
    assert.equal(run.status, 0, `stderr: ${run.stderr}`);
    assert.deepEqual(readMarkers(fixture).map(m => m.entry), [sourceEntry]);
    // worker：源内直接自举，不重定向、不读外部记录。
    run = runClient(fixture, [], { FARM_WORKER: '1' });
    assert.equal(run.status, 0, `stderr: ${run.stderr}`);
    assert.deepEqual(readMarkers(fixture).map(m => m.entry), [sourceEntry, sourceEntry]);
    // 抓包子命令：保持既有入口语义。
    run = runClient(fixture, ['--capture']);
    assert.equal(run.status, 0, `stderr: ${run.stderr}`);
    assert.deepEqual(readMarkers(fixture).map(m => m.entry), [sourceEntry, sourceEntry, sourceEntry]);
    // 打包可执行（process.pkg）：guard 先于任何记录读取，直接普通自举。
    const exits = [];
    const fakePkgProc = {
      env: { FARM_DATA_DIR: fixture.dataDir, FARM_TEST_MARKER: fixture.markerFile },
      argv: ['node', 'client.js'],
      argv0: 'node',
      execPath: process.execPath,
      pkg: {},
      stderr: { write() { throw new Error('pkg bypass must not refuse'); } },
      exit(code) { exits.push(code); },
    };
    assert.equal(entry.routeApprovedRuntime(fakePkgProc), false);
    assert.deepEqual(exits, []);
    assert.deepEqual(readMarkers(fixture).map(m => m.entry), [sourceEntry, sourceEntry, sourceEntry]);
    // 记录恢复后恢复重定向。
    fs.writeFileSync(fixture.applyTargetFile, targetRecord);
    assert.equal(resolveOf(fixture).action, 'dispatch');
  } finally { cleanup(fixture); }
});

test('回执/校验记录不可证时拒绝，且拒绝先于目标执行（真实进程核验一条）', () => {
  const fixture = makeRoutingFixture('receipt');
  try {
    const before = fixture.sourceFingerprint();
    const receipt = JSON.parse(fs.readFileSync(fixture.receiptFile, 'utf8'));
    // 真实进程：失败回执（phase=failed，模拟 helper 中断遗留）→ 明确退出 1，
    // 不落任何标记，源检出指纹不变。
    fs.writeFileSync(fixture.receiptFile, `${JSON.stringify({ ...receipt, phase: 'failed' })}\n`);
    const run = runClient(fixture);
    assert.equal(run.status, 1);
    assert.match(run.stderr, /refusing to start unproven target: receipt_not_ready/);
    assert.deepEqual(readMarkers(fixture), []);
    assert.equal(fixture.sourceFingerprint(), before);
    // 回执字段错配（runtimeRoot / 指纹 / 保留摘要 / 提交）逐一拒绝。
    fs.writeFileSync(fixture.receiptFile, `${JSON.stringify({ ...receipt, runtimeRoot: '/tmp/other-root' })}\n`);
    assert.equal(resolveOf(fixture).reason, 'receipt_mismatch');
    fs.writeFileSync(fixture.receiptFile, `${JSON.stringify({ ...receipt, sourceFingerprint: '0'.repeat(64) })}\n`);
    assert.equal(resolveOf(fixture).reason, 'receipt_mismatch');
    fs.writeFileSync(fixture.receiptFile, `${JSON.stringify({ ...receipt, holdDigest: '0'.repeat(64) })}\n`);
    assert.equal(resolveOf(fixture).reason, 'receipt_mismatch');
    fs.writeFileSync(fixture.receiptFile, `${JSON.stringify({ ...receipt, expectedHead: '0'.repeat(40) })}\n`);
    assert.equal(resolveOf(fixture).reason, 'receipt_mismatch');
    // 回执缺失。
    fs.rmSync(fixture.receiptFile);
    assert.equal(resolveOf(fixture).reason, 'receipt_not_ready');
    fs.writeFileSync(fixture.receiptFile, `${JSON.stringify(receipt)}\n`);
    assert.equal(resolveOf(fixture).action, 'dispatch');
  } finally { cleanup(fixture); }
});

test('目标记录/校验记录损坏或不足一律拒绝（先于目标执行）', () => {
  const fixture = makeRoutingFixture('records');
  try {
    const targetRecord = fs.readFileSync(fixture.applyTargetFile, 'utf8');
    const validation = fs.readFileSync(fixture.validationFile, 'utf8');
    // 应用目标记录：JSON 损坏 / runId schema 不符。
    fs.writeFileSync(fixture.applyTargetFile, '{not json');
    assert.equal(resolveOf(fixture).reason, 'apply_target_invalid');
    const record = JSON.parse(targetRecord);
    fs.writeFileSync(fixture.applyTargetFile, `${JSON.stringify({ ...record, runId: '../escape' })}\n`);
    assert.equal(resolveOf(fixture).reason, 'apply_target_invalid');
    // 记录指纹与真实内容不符 → 内容+权限指纹核验拒绝。
    fs.writeFileSync(fixture.applyTargetFile, `${JSON.stringify({ ...record, sourceFingerprint: '0'.repeat(64) })}\n`);
    assert.equal(resolveOf(fixture).reason, 'source_fingerprint_mismatch');
    // 记录提交与边界/真实 HEAD 不符 → 派生边界拒绝。
    fs.writeFileSync(fixture.applyTargetFile, `${JSON.stringify({ ...record, commit: '0'.repeat(40) })}\n`);
    assert.equal(resolveOf(fixture).reason, 'target_outside_owner_boundary');
    fs.writeFileSync(fixture.applyTargetFile, targetRecord);
    // 回归记录：failed / 指纹错配 / 只有 backend / 缺失。
    const parsed = JSON.parse(validation);
    fs.writeFileSync(fixture.validationFile, `${JSON.stringify({ ...parsed, state: 'failed', fingerprint: '' })}\n`);
    assert.equal(resolveOf(fixture).reason, 'validation_not_passed');
    fs.writeFileSync(fixture.validationFile, `${JSON.stringify({ ...parsed, fingerprint: '0'.repeat(64) })}\n`);
    assert.equal(resolveOf(fixture).reason, 'validation_fingerprint_mismatch');
    fs.writeFileSync(fixture.validationFile, `${JSON.stringify({ ...parsed, checks: ['backend'] })}\n`);
    assert.equal(resolveOf(fixture).reason, 'validation_checks_insufficient');
    fs.rmSync(fixture.validationFile);
    assert.equal(resolveOf(fixture).reason, 'validation_not_passed');
    fs.writeFileSync(fixture.validationFile, validation);
    assert.equal(resolveOf(fixture).action, 'dispatch');
  } finally { cleanup(fixture); }
});

test('运行时源漂移（权限/内容/HEAD/干净度/符号链接/缺失）全部拒绝且可恢复', () => {
  const fixture = makeRoutingFixture('drift');
  try {
    const clientFile = path.join(fixture.runtimeRoot, 'core', 'client.js');
    const originalMode = fs.statSync(clientFile).mode & 0o777;
    // 权限漂移（非可执行位内变化，git 不感知、logicSnapshot 感知）→ 指纹错配。
    fs.chmodSync(clientFile, originalMode === 0o600 ? 0o644 : 0o600);
    assert.equal(resolveOf(fixture).reason, 'source_fingerprint_mismatch');
    fs.chmodSync(clientFile, originalMode);
    // 内容漂移（未提交修改）→ 干净度拒绝。
    fs.appendFileSync(clientFile, '\n');
    assert.equal(resolveOf(fixture).reason, 'runtime_not_clean');
    fixture.git(['checkout', '--', 'core/client.js'], fixture.runtimeRoot);
    // HEAD 漂移：回退到公开基线 → 提交错配。
    fixture.git(['checkout', '-q', '--detach', fixture.provenance.publicBase], fixture.runtimeRoot);
    assert.equal(resolveOf(fixture).reason, 'target_head_mismatch');
    fixture.git(['checkout', '-q', '--detach', fixture.candidateHead], fixture.runtimeRoot);
    assert.equal(resolveOf(fixture).action, 'dispatch');
    // 目标缺失。
    const realRuntime = fixture.runtimeRoot;
    const movedRuntime = `${fixture.runtimeRoot}-moved`;
    fs.renameSync(realRuntime, movedRuntime);
    assert.equal(resolveOf(fixture).reason, 'target_missing');
    fs.renameSync(movedRuntime, realRuntime);
    // 符号链接逃逸：边界路径组件被符号链接穿透。
    fs.renameSync(realRuntime, movedRuntime);
    fs.symlinkSync(movedRuntime, realRuntime);
    assert.equal(resolveOf(fixture).reason, 'target_symlink_component');
    fs.rmSync(realRuntime);
    fs.renameSync(movedRuntime, realRuntime);
    assert.equal(resolveOf(fixture).action, 'dispatch');
  } finally { cleanup(fixture); }
});

test('边界外根与外库同形目标拒绝；属主根派生边界必须精确', () => {
  const fixture = makeRoutingFixture('boundary');
  try {
    // 边界外根：记录指向别处（即使同库同形）→ 拒绝。
    const record = JSON.parse(fs.readFileSync(fixture.applyTargetFile, 'utf8'));
    fs.writeFileSync(fixture.applyTargetFile,
      `${JSON.stringify({ ...record, runtimeRoot: path.join(fixture.root, 'elsewhere', 'runtime-x') })}\n`);
    assert.equal(resolveOf(fixture).reason, 'target_outside_owner_boundary');
    fs.writeFileSync(fixture.applyTargetFile, `${JSON.stringify(record)}\n`);
    assert.equal(resolveOf(fixture).action, 'dispatch');
  } finally { cleanup(fixture); }
  const foreign = makeRoutingFixture('foreign', { foreignTarget: true });
  try {
    // 精确边界上的外库 git 仓库（同形目录冒充）：common-dir 不一致 → 拒绝。
    assert.equal(resolveOf(foreign).reason, 'target_repo_mismatch');
  } finally { cleanup(foreign); }
});

test('保留物与任务溯源漂移拒绝（目标侧 publish 服务核验），恢复后可再 dispatch', () => {
  const fixture = makeRoutingFixture('hold');
  try {
    // 保留草稿内容漂移 → 当前保留物不可证。
    const draft = path.join(fixture.root, 'core', 'src', 'retained-draft.js');
    const original = fs.readFileSync(draft, 'utf8');
    fs.writeFileSync(draft, 'module.exports = "drifted";\n');
    assert.equal(resolveOf(fixture).reason, 'hold_unprovable');
    fs.writeFileSync(draft, original);
    assert.equal(resolveOf(fixture).action, 'dispatch');
    // 保留摘要错配（目标记录侧改摘要，回执先拒绝——两处必须一致才可信）。
    const record = JSON.parse(fs.readFileSync(fixture.applyTargetFile, 'utf8'));
    fs.writeFileSync(fixture.applyTargetFile, `${JSON.stringify({ ...record, holdDigest: '0'.repeat(64) })}\n`);
    assert.equal(resolveOf(fixture).reason, 'receipt_mismatch');
    fs.writeFileSync(fixture.applyTargetFile, `${JSON.stringify(record)}\n`);
    // 任务溯源漂移：taskRoot 改写 → 边界核验失败。
    const provenanceFile = path.join(fixture.dataDir, 'evolution-workspace.json');
    const provenanceRaw = fs.readFileSync(provenanceFile, 'utf8');
    const provenance = JSON.parse(provenanceRaw);
    fs.writeFileSync(provenanceFile,
      `${JSON.stringify({ ...provenance, taskRoot: path.join(fixture.root, 'elsewhere') })}\n`);
    assert.equal(resolveOf(fixture).reason, 'provenance_unprovable');
    fs.writeFileSync(provenanceFile, provenanceRaw);
    // 任务区 HEAD 漂移（离开受信提交）→ 溯源不可证。
    fixture.git(['checkout', '-q', '--detach', fixture.provenance.publicBase], fixture.provenance.taskRoot);
    assert.equal(resolveOf(fixture).reason, 'provenance_unprovable');
    fixture.git(['checkout', '-q', '--detach', fixture.candidateHead], fixture.provenance.taskRoot);
    assert.equal(resolveOf(fixture).action, 'dispatch');
  } finally { cleanup(fixture); }
});

test('退出码与信号精确传播：目标退出码与自伤信号经包装进程原样透传', () => {
  const fixture = makeRoutingFixture('exitcode');
  try {
    let run = runClient(fixture, [], { FARM_TEST_EXIT_CODE: '7' });
    assert.equal(run.status, 7, `stderr: ${run.stderr}`);
    assert.equal(readMarkers(fixture).length, 1);
    run = runClient(fixture, [], { FARM_TEST_SELF_SIGNAL: 'SIGTERM' });
    assert.equal(run.status, 143, `stderr: ${run.stderr}`);
    assert.equal(readMarkers(fixture).length, 2);
    // 源检出保留物与引导对在成功/失败路径后都保持原样。
    assert.ok(fs.statSync(path.join(fixture.root, 'core', 'src', 'retained-draft.js')).isFile());
    assert.ok(fs.statSync(path.join(fixture.root, 'core', 'src', 'runtime', 'approved-runtime-entry.js')).isFile());
  } finally { cleanup(fixture); }
});

// ---------------------------------------------------------------------------
// 二批：最近一次 ready 验收证书（evolution-approved-runtime.json）选择语义。
// ---------------------------------------------------------------------------

test('证书路径：全局验证/回执被下一轮替换或失败后，已接受运行时仍被冷启动选择（默认 dataDir，无 FARM_DATA_DIR）', () => {
  const fixture = makeRoutingFixture('cert-global', { certificate: true });
  try {
    // 下一轮自主研究合法替换全局验证（failed / 新指纹）、回执也是失败残留——
    // 都不是撤销已验收运行时的理由。
    writeGlobalValidation(fixture, { state: 'failed', fingerprint: 'f'.repeat(64), checks: [] });
    fs.writeFileSync(fixture.receiptFile, `${JSON.stringify({ phase: 'failed' })}\n`);
    assert.equal(resolveOf(fixture).action, 'dispatch');
    // 真实进程冷启动（env 无 FARM_DATA_DIR）：dataDir 从源 core/data 实解，子进程
    // argv/cwd/入口全部落在已接受运行时根。
    const run = runClient(fixture, ['--user-arg']);
    assert.equal(run.status, 0, `stderr: ${run.stderr}`);
    const markers = readMarkers(fixture);
    assert.equal(markers.length, 1);
    assert.equal(markers[0].entry, path.join(fixture.runtimeRoot, 'core', 'client.js'));
    assert.equal(markers[0].cwd, path.join(fixture.runtimeRoot, 'core'));
    assert.equal(markers[0].argv[1], path.join(fixture.runtimeRoot, 'core', 'client.js'));
    assert.ok(markers[0].argv.includes('--user-arg'));
    assert.equal(markers[0].dataDir, fixture.dataDir);
  } finally { cleanup(fixture); }
});

test('更新 pending 目标不被原库冷启动选中；无证书时未证实 pending 同样拒绝', () => {
  const fixture = makeRoutingFixture('cert-pending', { certificate: true });
  try {
    const pending = addPendingCandidate(fixture);
    // 全局验证与 ready 回执都已指向 rt2（下一轮已通过/已就绪）：原库冷启动仍选
    // 证书里的 rt1 —— 绝不提前执行未应用的候选。
    writeGlobalValidation(fixture, { fingerprint: pending.fingerprint });
    fs.writeFileSync(fixture.receiptFile, `${JSON.stringify({
      expectedHead: pending.head, runtimeRoot: pending.runtimeRoot,
      sourceFingerprint: pending.fingerprint,
      holdDigest: JSON.parse(fs.readFileSync(fixture.applyTargetFile, 'utf8')).holdDigest,
      phase: 'ready', newPid: 1, newStarttime: '1', adminPort: 3007, startedAt: Date.now() })}\n`);
    assert.deepEqual(resolveOf(fixture), { action: 'dispatch', targetRoot: fixture.runtimeRoot,
      targetEntry: path.join(fixture.runtimeRoot, 'core', 'client.js'),
      targetCwd: path.join(fixture.runtimeRoot, 'core'),
      dataDir: fixture.dataDir, commit: fixture.candidateHead });
    const run = runClient(fixture);
    assert.equal(run.status, 0, `stderr: ${run.stderr}`);
    assert.equal(readMarkers(fixture)[0].entry, path.join(fixture.runtimeRoot, 'core', 'client.js'));
  } finally { cleanup(fixture); }
  const legacy = makeRoutingFixture('pending-unproved');
  try {
    addPendingCandidate(legacy);
    // 证书从未存在（legacy）：pending 自身指纹与记录一致，但全局验证（仍是 rt1
    // 的通过证据）与 pending 指纹不符 → 拒绝，绝不提前执行未应用候选。
    assert.equal(resolveOf(legacy).reason, 'validation_fingerprint_mismatch');
    const run = runClient(legacy);
    assert.equal(run.status, 1);
    assert.match(run.stderr, /refusing to start unproven target: validation_fingerprint_mismatch/);
    assert.deepEqual(readMarkers(legacy), []);
  } finally { cleanup(legacy); }
});

test('同根已接受运行时：全局漂移下可自举，但权限/内容/HEAD 漂移拒绝且可恢复', () => {
  const fixture = makeRoutingFixture('cert-sameroot', { certificate: true });
  try {
    writeGlobalValidation(fixture, { state: 'failed', fingerprint: '', checks: [] });
    assert.deepEqual(resolveAt(fixture.runtimeRoot, fixture),
      { action: 'ordinary', reason: 'selected_runtime_bootstrap' });
    // 真实进程直接启动已接受根：一次业务自举、入口在目标根。
    const clientFile = path.join(fixture.runtimeRoot, 'core', 'client.js');
    const run = spawnSync(process.execPath, [clientFile], {
      cwd: path.join(fixture.runtimeRoot, 'core'),
      env: childEnv(fixture, { FARM_DATA_DIR: fixture.dataDir }), encoding: 'utf8',
    });
    assert.equal(run.status, 0, `stderr: ${run.stderr}`);
    assert.equal(readMarkers(fixture)[0].entry, clientFile);
    // 权限漂移（git 不可见、logicSnapshot 可见）→ 拒绝。
    const originalMode = fs.statSync(clientFile).mode & 0o777;
    fs.chmodSync(clientFile, originalMode === 0o600 ? 0o644 : 0o600);
    assert.equal(resolveAt(fixture.runtimeRoot, fixture).reason, 'source_fingerprint_mismatch');
    fs.chmodSync(clientFile, originalMode);
    // 内容漂移（未提交修改）→ 拒绝。
    fs.appendFileSync(clientFile, '\n');
    assert.equal(resolveAt(fixture.runtimeRoot, fixture).reason, 'runtime_not_clean');
    fixture.git(['checkout', '--', 'core/client.js'], fixture.runtimeRoot);
    // HEAD 漂移 → 拒绝。
    fixture.git(['checkout', '-q', '--detach', fixture.provenance.publicBase], fixture.runtimeRoot);
    assert.equal(resolveAt(fixture.runtimeRoot, fixture).reason, 'target_head_mismatch');
    fixture.git(['checkout', '-q', '--detach', fixture.candidateHead], fixture.runtimeRoot);
    assert.deepEqual(resolveAt(fixture.runtimeRoot, fixture),
      { action: 'ordinary', reason: 'selected_runtime_bootstrap' });
  } finally { cleanup(fixture); }
});

test('同根 pending 运行时：当前验证匹配才可自举（helper 到达 ready 的通路），漂移即拒', () => {
  const fixture = makeRoutingFixture('cert-pendingroot', { certificate: true });
  try {
    const pending = addPendingCandidate(fixture);
    const pendingEntry = path.join(pending.runtimeRoot, 'core', 'client.js');
    // helper 正在应用 rt2：全局验证 = rt2 通过 → 允许自举（否则 ready 永远到不了）。
    writeGlobalValidation(fixture, { fingerprint: pending.fingerprint });
    assert.deepEqual(resolveAt(pending.runtimeRoot, fixture),
      { action: 'ordinary', reason: 'pending_runtime_bootstrap' });
    const run = spawnSync(process.execPath, [pendingEntry], {
      cwd: path.join(pending.runtimeRoot, 'core'),
      env: childEnv(fixture, { FARM_DATA_DIR: fixture.dataDir }), encoding: 'utf8',
    });
    assert.equal(run.status, 0, `stderr: ${run.stderr}`);
    assert.equal(readMarkers(fixture)[0].entry, pendingEntry);
    // 全局验证指纹漂移（下一轮研究替换）→ pending 根不再可自举，真实进程拒绝。
    writeGlobalValidation(fixture, { fingerprint: '0'.repeat(64) });
    assert.equal(resolveAt(pending.runtimeRoot, fixture).reason, 'validation_fingerprint_mismatch');
    const refused = spawnSync(process.execPath, [pendingEntry], {
      cwd: path.join(pending.runtimeRoot, 'core'),
      env: childEnv(fixture, { FARM_DATA_DIR: fixture.dataDir }), encoding: 'utf8',
    });
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /refusing to start unproven target: validation_fingerprint_mismatch/);
    assert.equal(readMarkers(fixture).length, 1, '拒绝路径绝不落业务自举标记');
    writeGlobalValidation(fixture, { state: 'failed', fingerprint: pending.fingerprint });
    assert.equal(resolveAt(pending.runtimeRoot, fixture).reason, 'validation_not_passed');
  } finally { cleanup(fixture); }
});

test('验收证书损坏或 schema 不足一律拒绝（真实进程核验一条）', () => {
  const fixture = makeRoutingFixture('cert-corrupt', { certificate: true });
  try {
    const before = fixture.sourceFingerprint();
    const raw = fs.readFileSync(fixture.certificateFile, 'utf8');
    fs.writeFileSync(fixture.certificateFile, '{not json');
    const run = runClient(fixture);
    assert.equal(run.status, 1);
    assert.match(run.stderr, /refusing to start unproven target: approved_certificate_invalid/);
    assert.deepEqual(readMarkers(fixture), []);
    // schema 不足：验证摘要只有 backend；runId 与目标不一致 —— 均拒绝。
    const parsed = JSON.parse(raw);
    fs.writeFileSync(fixture.certificateFile,
      `${JSON.stringify({ ...parsed, validation: { ...parsed.validation, checks: ['backend'] } })}\n`);
    assert.equal(resolveOf(fixture).reason, 'approved_certificate_invalid');
    fs.writeFileSync(fixture.certificateFile,
      `${JSON.stringify({ ...parsed, provenance: { ...parsed.provenance, runId: 'other-run' } })}\n`);
    assert.equal(resolveOf(fixture).reason, 'approved_certificate_invalid');
    fs.writeFileSync(fixture.certificateFile, raw);
    assert.equal(resolveOf(fixture).action, 'dispatch');
    assert.equal(fixture.sourceFingerprint(), before);
  } finally { cleanup(fixture); }
});

test('已接受运行时不因当前任务区漂移/清理失格（验收时溯源快照 + 共享对象库血缘）', () => {
  const fixture = makeRoutingFixture('cert-taskdrift', { certificate: true });
  try {
    // 任务区漂移：未提交 WIP / HEAD 回退到公开基线都不影响证书路径（当前任务是
    // 可变的全局记录，不是已验收运行时的身份证明）。
    fixture.write(fixture.provenance.taskRoot, 'core/src/wip.js', 'module.exports = "wip";\n');
    assert.equal(resolveOf(fixture).action, 'dispatch');
    fixture.git(['checkout', '-q', '--detach', fixture.provenance.publicBase], fixture.provenance.taskRoot);
    assert.equal(resolveOf(fixture).action, 'dispatch');
    // 任务区被受信收尾清理（worktree remove）：publicBase → 已接受提交的血缘仍可
    // 从共享对象库证明，冷启动照常 dispatch。
    fixture.git(['worktree', 'remove', '--force', fixture.provenance.taskRoot]);
    assert.equal(resolveOf(fixture).action, 'dispatch');
    const run = runClient(fixture);
    assert.equal(run.status, 0, `stderr: ${run.stderr}`);
    assert.equal(readMarkers(fixture)[0].entry, path.join(fixture.runtimeRoot, 'core', 'client.js'));
  } finally { cleanup(fixture); }
});

test.after(() => {
  if (originalDataDir === undefined) {
    fs.rmSync(process.env.FARM_DATA_DIR, { recursive: true, force: true });
    delete process.env.FARM_DATA_DIR;
  } else {
    process.env.FARM_DATA_DIR = originalDataDir;
  }
});
