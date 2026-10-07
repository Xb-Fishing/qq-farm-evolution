'use strict';
// Stage C 隔离工作区/发布门/应用目标映射的真实 Git 回归（2026-10-07）。
// 夹具：真实临时 git 仓库 + bare 远端 + 原库三类脏保留物（未暂存/已暂存/未跟踪）。
// 只验证已集成的行为合同：任务区隔离、发布门（隐私/漂移/推送/复核）、运行时区
// 干净证明、Bot 上下文映射、保留物不可漂移、应用目标记录。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync, spawnSync } = require('node:child_process');

// ---------------------------------------------------------------------------
// 生产形态钩子注入下的夹具隔离（2026-10-07 修复，与 evolution-autonomy 轮同类）：
// 协调进程环境注入 GIT_CONFIG_COUNT/KEY_*/VALUE_*（core.hooksPath=scripts/
// evolution-hooks，真实 pre-push 无条件拒绝推送）。本文件的夹具与被测服务的
// 内部 git 调用都继承 process.env，注入会把夹具对本地 bare 远端的推送全部误杀。
// 处理：被 runner 直接执行时，先在净化后的环境副本中重执行自身（专属子进程，
// 覆盖夹具初始化、漂移克隆、发布服务内部 git 与全部推送）；宿主进程 env、协调
// 进程注入与 no-push 钩子本身零改动。成功与失败路径的收尾都核对宿主
// GIT_CONFIG_* 快照、候选源码与工作区指纹不变。
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
  'core/src/services/evolution-publish.js',
  'core/src/services/evolution-worktree.js',
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

const test = require('node:test');
const assert = require('node:assert/strict');
const publish = require('../src/services/evolution-publish');
const { inspectWorktree } = require('../src/services/evolution-worktree');
const { logicSnapshot } = require('../src/services/evolution-validation');
const logicSnapshotOf = root => logicSnapshot(root).fingerprint;

// 真实仓库 + bare 远端 + 三类脏保留物。返回 { root, remote, dataDir, git }。
function makeFixture(tag) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `farm-publish-${tag}-`));
  const remote = `${root}-remote.git`;
  const dataDir = path.join(root, 'core', 'data');
  const write = (file, text) => {
    // 外穿硬拒：fixture 写入目标解析后必须落在 fixture 内（2026-10-05 覆盖事故教训）。
    const full = path.resolve(root, file);
    if (full !== root && !full.startsWith(root + path.sep)) throw new Error(`fixture_escape:${file}`);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, text);
  };
  const git = (args, cwd = root) => execFileSync('git', args,
    { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  try {
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
    write('.gitignore', 'tmp/\ncore/data/\n');
    write('core/src/example.js', 'module.exports = 1;\n');
    write('docs/HANDOFF.md', 'Fixture constraints\n');
    git(['init', '-q', '-b', 'main']);
    git(['config', 'user.name', 'Test']);
    git(['config', 'user.email', 'test@users.noreply.github.com']);
    git(['add', '.']);
    git(['commit', '-qm', 'fixture base']);
    git(['remote', 'add', 'origin', remote]);
    git(['push', '-q', 'origin', 'main']);
    // 三类保留物：已跟踪文件未暂存改动 / 已暂存新文件 / 未跟踪文件。
    write('core/src/example.js', 'module.exports = 2; // dirty hold\n');
    write('core/src/staged-hold.js', 'module.exports = "staged";\n');
    git(['add', 'core/src/staged-hold.js']);
    write('core/src/untracked-hold.js', 'module.exports = "untracked";\n');
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    return { root, remote, dataDir, git, write };
  } catch (error) {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(remote, { recursive: true, force: true });
    throw error;
  }
}

function cleanup(fixture) {
  // worktree 元数据挂在原库 common-dir：先 prune 再删目录，避免残留 global git 引用。
  try { execFileSync('git', ['worktree', 'prune'], { cwd: fixture.root, stdio: 'ignore' }); } catch {}
  fs.rmSync(fixture.root, { recursive: true, force: true });
  fs.rmSync(fixture.remote, { recursive: true, force: true });
}

test('任务工作区：远端 HEAD 建区、原库物理不动、保留物在任务区不可见、provenance 复验', () => {
  const fixture = makeFixture('task');
  try {
    const statusBefore = fixture.git(['status', '--porcelain', '-z', '--untracked-files=normal']);
    const headBefore = fixture.git(['rev-parse', 'HEAD']);
    const remoteHead = publish.remoteMainHead(fixture.root);
    const manifest = publish.buildHoldManifest(fixture.root);
    publish.recordHoldManifest(fixture.dataDir, manifest);
    assert.ok(manifest.worktree.files.includes('core/src/example.js'));
    assert.ok(manifest.worktree.files.includes('core/src/staged-hold.js'));
    assert.ok(manifest.worktree.files.includes('core/src/untracked-hold.js'));

    const provenance = publish.createTaskWorkspace({
      repoRoot: fixture.root, dataDir: fixture.dataDir, runId: 'run-task-1',
    });
    assert.equal(provenance.publicBase, remoteHead);
    assert.equal(provenance.headAtCreation, remoteHead);
    assert.equal(provenance.taskRoot, path.join(fixture.root, 'tmp', 'evolution-workspaces', 'run-task-1', 'task'));
    assert.ok(fs.realpathSync(provenance.taskRoot).startsWith(fs.realpathSync(fixture.root) + path.sep));
    // 任务区干净且保留物不可见（内容仍是公开基线版本）。
    assert.equal(fixture.git(['status', '--porcelain', '--untracked-files=normal'], provenance.taskRoot), '');
    assert.equal(fixture.git(['show', 'HEAD:core/src/example.js'], provenance.taskRoot), 'module.exports = 1;');
    // 原库物理不动：HEAD/status 逐字节一致，保留物仍原样。
    assert.equal(fixture.git(['rev-parse', 'HEAD']), headBefore);
    assert.equal(fixture.git(['status', '--porcelain', '-z', '--untracked-files=normal']), statusBefore);
    assert.equal(fs.readFileSync(path.join(fixture.root, 'core/src/example.js'), 'utf8'),
      'module.exports = 2; // dirty hold\n');

    // provenance 复验 + 各类拒绝（路径外穿/HEAD 漂移/common-dir 冒充）。
    assert.equal(publish.verifyTaskWorkspace(fixture.root, provenance).ok, true);
    assert.equal(publish.verifyTaskWorkspace(fixture.root,
      { ...provenance, taskRoot: fixture.root }).reason, 'task_root_outside_boundary');
    assert.equal(publish.verifyTaskWorkspace(fixture.root,
      { ...provenance, headAtCreation: '0'.repeat(40) }).reason, 'task_head_drifted');
    const foreign = makeFixture('foreign');
    try {
      assert.equal(publish.verifyTaskWorkspace(fixture.root,
        { ...provenance, commonDir: `${foreign.root}/.git` }).reason, 'root_repo_mismatch');
    } finally { cleanup(foreign); }
    // 调用方根绑定（B5）：不存在/外库的调用方根必须被拒绝——绝不只信记录里的根。
    const ghost = publish.verifyTaskWorkspace('/nonexistent-root', publish.readProvenance(fixture.dataDir));
    assert.equal(ghost.ok, false);
    assert.ok(ghost.reason);
    // 同库运行时 worktree 是合法的换根调用方（common-dir 一致）。
    const runtimeCaller = publish.prepareRuntimeWorkspace({
      repoRoot: fixture.root, runId: 'run-task-1', commit: remoteHead, dataDir: fixture.dataDir,
    });
    assert.equal(publish.verifyTaskWorkspace(runtimeCaller.runtimeRoot, provenance).ok, true);
    // 已提交候选（B2）：真实提交后 HEAD 离开建区基线——旧口径（对照建区 HEAD）
    // 必须拒绝；对照「受信已审提交」（expectedHead）必须通过；任意其他提交仍拒。
    fs.writeFileSync(path.join(provenance.taskRoot, 'core/src/candidate.js'), 'module.exports = 1;\n');
    fixture.git(['add', '.'], provenance.taskRoot);
    fixture.git(['commit', '-qm', 'candidate'], provenance.taskRoot);
    const candidateHead = fixture.git(['rev-parse', 'HEAD'], provenance.taskRoot);
    assert.equal(publish.verifyTaskWorkspace(fixture.root, provenance).reason, 'task_head_drifted');
    assert.equal(publish.verifyTaskWorkspace(fixture.root, provenance, { expectedHead: candidateHead }).ok, true);
    assert.equal(publish.verifyTaskWorkspace(fixture.root, provenance,
      { expectedHead: '0'.repeat(40) }).reason, 'task_head_drifted');
    // 血缘：expectedHead 必须仍是公开基线的后代（伪造基线 = 不可证明）。
    assert.equal(publish.verifyTaskWorkspace(fixture.root,
      { ...provenance, publicBase: '1'.repeat(40) }, { expectedHead: candidateHead }).reason,
    'task_lineage_unprovable');
    // 重复建区拒绝。
    assert.throws(() => publish.createTaskWorkspace({
      repoRoot: fixture.root, dataDir: fixture.dataDir, runId: 'run-task-1',
    }), /workspace_exists/);
    // 重启后凭 runId + 记录的仓库根仍可复验（readProvenance 往返）。
    assert.equal(publish.verifyTaskWorkspace(fixture.root,
      publish.readProvenance(fixture.dataDir), { expectedHead: candidateHead }).ok, true);
  } finally { cleanup(fixture); }
});

test('新任务区可读取既有私有技能、数据和依赖链接，资源保持 ignored', () => {
  const fixture = makeFixture('resources');
  try {
    fs.appendFileSync(path.join(fixture.root, '.git/info/exclude'), '\ncore/node_modules/\ndocs/skills/\n');
    fixture.write('docs/skills/fixture/SKILL.md', 'Local fixture instructions\n');
    fixture.write('core/node_modules/fixture-dependency/index.js', 'module.exports = 42;\n');
    const provenance = publish.createTaskWorkspace({
      repoRoot: fixture.root, dataDir: fixture.dataDir, runId: 'run-resource-1',
    });
    assert.equal(require(path.join(provenance.taskRoot, 'core/node_modules/fixture-dependency')), 42);
    assert.equal(fs.realpathSync(path.join(provenance.taskRoot, 'core/data')), fs.realpathSync(fixture.dataDir));
    assert.equal(fs.readFileSync(path.join(provenance.taskRoot, 'docs/skills/fixture/SKILL.md'), 'utf8'), 'Local fixture instructions\n');
    assert.equal(fixture.git(['status', '--porcelain'], provenance.taskRoot), '');
    assert.ok(fs.statSync(path.join(provenance.taskRoot, 'tmp')).isDirectory());
  } finally { cleanup(fixture); }
});

test('私有 HANDOFF 链接只接受同库规范文件，拒绝替换到其他文件', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'farm-canonical-handoff-'));
  const root = path.join(dir, 'repo');
  const write = (relative, value) => {
    const full = path.resolve(dir, relative);
    if (!full.startsWith(dir + path.sep)) throw new Error('fixture_escape');
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, value);
    return full;
  };
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  try {
    write('repo/.gitignore', 'tmp/\ncore/data\ndocs/HANDOFF.md\n');
    write('repo/core/src/example.js', 'module.exports = 1;\n');
    write('repo/core/data/fixture', 'local\n');
    const content = 'Current private constraints\n';
    write('repo/docs/HANDOFF.md', content);
    git(['init', '-q', '-b', 'main']);
    git(['config', 'user.name', 'Synthetic fixture']);
    git(['config', 'user.email', 'fixture@users.noreply.github.com']);
    git(['add', '.']);
    git(['commit', '-qm', 'fixture']);
    const remote = path.join(dir, 'remote.git');
    git(['clone', '--bare', root, remote]);
    git(['remote', 'add', 'origin', remote]);
    const provenance = publish.createTaskWorkspace({ repoRoot: root, dataDir: path.join(root, 'core/data'), runId: 'private-handoff' });
    const { snapshotPrivateHandoff } = require('../scripts/run-evolution-team');
    const snapshot = snapshotPrivateHandoff(provenance.taskRoot);
    assert.equal(snapshot.ignored, true);
    assert.equal(snapshot.sha256, crypto.createHash('sha256').update(content).digest('hex'));
    const linked = path.join(provenance.taskRoot, 'docs/HANDOFF.md');
    fs.unlinkSync(linked);
    fs.symlinkSync(write('foreign.md', 'Unrelated fixture\n'), linked);
    assert.throws(() => snapshotPrivateHandoff(provenance.taskRoot), { code: 'unsafe_worktree' });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('发布门：隐私拦截、远端漂移拒绝、真实推送 + ls-remote 复核、保留物不进公开 diff', async () => {
  const fixture = makeFixture('publish');
  try {
    const headBefore = fixture.git(['rev-parse', 'HEAD']);
    publish.recordHoldManifest(fixture.dataDir, publish.buildHoldManifest(fixture.root));
    const provenance = publish.createTaskWorkspace({
      repoRoot: fixture.root, dataDir: fixture.dataDir, runId: 'run-pub-1',
    });
    const task = provenance.taskRoot;
    // 候选提交 1：带 provider-token → 隐私闸门必须拦截（不推送）。
    const fakeCredential = ['ghp', 'A'.repeat(24)].join('_');
    fs.writeFileSync(path.join(task, 'core/src/leak.js'), `const t = "${fakeCredential}";\n`);
    fixture.git(['add', '.'], task);
    fixture.git(['commit', '-qm', 'leaky'], task);
    const leakHead = fixture.git(['rev-parse', 'HEAD'], task);
    const blocked = await publish.publishFromWorkspace({
      taskRoot: task, base: provenance.publicBase, head: leakHead,
      expectedBase: provenance.publicBase,
    });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.reason, 'privacy_blocked');
    assert.equal(publish.remoteMainHead(task), provenance.publicBase);

    // 回退泄漏提交，做干净候选。
    fixture.git(['reset', '-q', '--hard', provenance.publicBase], task);
    fs.rmSync(path.join(task, 'core/src/leak.js'), { force: true });
    fs.writeFileSync(path.join(task, 'core/src/candidate.js'), 'module.exports = "candidate";\n');
    fixture.git(['add', '.'], task);
    fixture.git(['commit', '-qm', 'candidate'], task);
    const candidateHead = fixture.git(['rev-parse', 'HEAD'], task);

    // 远端漂移：第二个克隆推进远端 → 拒绝推送（绝不 force、绝不伪造收口）。
    const drift = fs.mkdtempSync(path.join(os.tmpdir(), 'farm-publish-drift-'));
    try {
      execFileSync('git', ['clone', '-q', fixture.remote, drift]);
      execFileSync('git', ['-C', drift, 'config', 'user.name', 'Drift']);
      execFileSync('git', ['-C', drift, 'config', 'user.email', 'd@users.noreply.github.com']);
      fs.writeFileSync(path.join(drift, 'OTHER.md'), 'drift\n');
      execFileSync('git', ['-C', drift, 'add', '.']);
      execFileSync('git', ['-C', drift, 'commit', '-qm', 'drift']);
      execFileSync('git', ['-C', drift, 'push', '-q', 'origin', 'main']);
      const drifted = await publish.publishFromWorkspace({
        taskRoot: task, base: provenance.publicBase, head: candidateHead,
        expectedBase: provenance.publicBase,
      });
      assert.equal(drifted.ok, false);
      assert.equal(drifted.reason, 'remote_drift');
    } finally { fs.rmSync(drift, { recursive: true, force: true }); }
    // 漂移测试后把远端复位回基线（bare 仓库直接改 ref，只影响夹具远端）。
    execFileSync('git', ['-C', fixture.remote, 'update-ref', 'refs/heads/main', provenance.publicBase]);
    execFileSync('git', ['fetch', '-q', 'origin', 'main'], { cwd: task });

    // 干跑：不推送。
    const dry = await publish.publishFromWorkspace({
      taskRoot: task, base: provenance.publicBase, head: candidateHead,
      expectedBase: provenance.publicBase, push: false,
    });
    assert.equal(dry.ok, true);
    assert.equal(publish.remoteMainHead(task), provenance.publicBase);
    // 真实推送 + ls-remote 复核相等；原库 HEAD 仍冻结在旧基线、保留物原样。
    const pushed = await publish.publishFromWorkspace({
      taskRoot: task, base: provenance.publicBase, head: candidateHead,
      expectedBase: provenance.publicBase,
    });
    assert.equal(pushed.ok, true);
    assert.equal(publish.remoteMainHead(task), candidateHead);
    // 原库 HEAD 仍冻结在旧基线（有意落后远端是合法状态）。
    assert.equal(fixture.git(['rev-parse', 'HEAD']), headBefore);
    assert.ok(publish.verifyHoldUnchanged(fixture.root, publish.readHoldManifest(fixture.dataDir)).ok);
    // 保留物内容不可能出现在公开提交范围里。
    const diffPaths = fixture.git(['diff', '--name-only', `${provenance.publicBase}..${candidateHead}`], task);
    assert.ok(!diffPaths.includes('core/src/staged-hold.js'));
    assert.ok(!diffPaths.includes('core/src/untracked-hold.js'));
    assert.ok(diffPaths.includes('core/src/candidate.js'));
  } finally { cleanup(fixture); }
});

test('运行时工作区 + 应用目标记录：干净/内容指纹/重复拒绝/记录往返/连续切换', () => {
  const fixture = makeFixture('runtime');
  try {
    const manifest = publish.ensureHoldManifest(fixture.dataDir, fixture.root);
    const provenance = publish.createTaskWorkspace({
      repoRoot: fixture.root, dataDir: fixture.dataDir, runId: 'run-rt-1',
    });
    const task = provenance.taskRoot;
    fs.writeFileSync(path.join(task, 'core/src/candidate.js'), 'module.exports = "rt";\n');
    fixture.git(['add', '.'], task);
    fixture.git(['commit', '-qm', 'rt candidate'], task);
    const head = fixture.git(['rev-parse', 'HEAD'], task);
    execFileSync('git', ['push', '-q', 'origin', 'HEAD:main'], { cwd: task });

    const runtime = publish.prepareRuntimeWorkspace({
      repoRoot: fixture.root, runId: 'run-rt-1', commit: head, dataDir: fixture.dataDir,
    });
    assert.equal(runtime.runtimeRoot,
      path.join(fixture.root, 'tmp', 'evolution-workspaces', 'run-rt-1', `runtime-${head.slice(0, 12)}`));
    const inspected = inspectWorktree(runtime.runtimeRoot);
    assert.equal(inspected.head, head);
    assert.equal(inspected.dirty, false);
    assert.equal(inspected.fingerprint, runtime.fingerprint);
    // 内容身份（B3）：logicSnapshot 当前内容+权限指纹，非空且区别于 HEAD/status 指纹。
    assert.match(runtime.logicFingerprint, /^[0-9a-f]{64}$/);
    assert.notEqual(runtime.logicFingerprint, runtime.fingerprint);
    assert.equal(logicSnapshotOf(runtime.runtimeRoot), runtime.logicFingerprint);
    // Main 反例（chmod 干净树）：HEAD/status 指纹不变，内容指纹必须变化。目标模式
    // 取「与当前不同」的另一档——umask 077 环境下 git 检出的文件本就是 600，写死
    // 644→600 会让 chmod 变成空操作（2026-10-07 实测踩坑），收尾还原为原模式。
    const cleanSource = path.join(runtime.runtimeRoot, 'core/src/example.js');
    const modeBefore = fs.statSync(cleanSource).mode & 0o777;
    fs.chmodSync(cleanSource, modeBefore === 0o600 ? 0o644 : 0o600);
    assert.equal(inspectWorktree(runtime.runtimeRoot).fingerprint, runtime.fingerprint);
    assert.notEqual(logicSnapshotOf(runtime.runtimeRoot), runtime.logicFingerprint);
    fs.chmodSync(cleanSource, modeBefore);

    // 幂等复用（B2 重启退回）：同一提交的既有运行时区（干净、同 HEAD）直接复用，
    // 不因「已存在」把候选卡死在待应用；脏/漂移的既有目录 = 不可证明，诚实拒绝。
    const reused = publish.prepareRuntimeWorkspace({
      repoRoot: fixture.root, runId: 'run-rt-1', commit: head, dataDir: fixture.dataDir,
    });
    assert.equal(reused.runtimeRoot, runtime.runtimeRoot);
    assert.equal(reused.logicFingerprint, runtime.logicFingerprint);
    fs.writeFileSync(path.join(runtime.runtimeRoot, 'core/src/example.js'), 'module.exports = "tampered";\n');
    assert.throws(() => publish.prepareRuntimeWorkspace({
      repoRoot: fixture.root, runId: 'run-rt-1', commit: head, dataDir: fixture.dataDir,
    }), /runtime_workspace_unprovable/);
    execFileSync('git', ['checkout', '-q', '--', 'core/src/example.js'], { cwd: runtime.runtimeRoot });
    assert.throws(() => publish.prepareRuntimeWorkspace({
      repoRoot: fixture.root, runId: 'run-rt-2', commit: '0'.repeat(40),
    }), /invalid_commit|git_failed/);
    // 连续切换（B1/B5 场景前置）：第二个提交获得独立的运行时根，不覆盖旧根、
    // 不嵌套（都挂在同一 runId 目录下）。
    fs.writeFileSync(path.join(task, 'core/src/candidate.js'), 'module.exports = "rt2";\n');
    fixture.git(['add', '.'], task);
    fixture.git(['commit', '-qm', 'rt candidate 2'], task);
    const head2 = fixture.git(['rev-parse', 'HEAD'], task);
    execFileSync('git', ['push', '-q', 'origin', 'HEAD:main'], { cwd: task });
    const runtime2 = publish.prepareRuntimeWorkspace({
      repoRoot: fixture.root, runId: 'run-rt-1', commit: head2, dataDir: fixture.dataDir,
    });
    assert.notEqual(runtime2.runtimeRoot, runtime.runtimeRoot);
    assert.equal(path.dirname(runtime2.runtimeRoot), path.dirname(runtime.runtimeRoot));

    publish.recordApplyTarget(fixture.dataDir, {
      runId: 'run-rt-1', commit: head2, runtimeRoot: runtime2.runtimeRoot,
      sourceFingerprint: runtime2.logicFingerprint, holdDigest: publish.holdDigest(manifest),
      createdAt: 123,
    });
    const record = publish.readApplyTarget(fixture.dataDir);
    assert.equal(record.commit, head2);
    assert.equal(record.runtimeRoot, runtime2.runtimeRoot);
    assert.equal(record.sourceFingerprint, runtime2.logicFingerprint);
    assert.equal(record.holdDigest, publish.holdDigest(manifest));
    // 非法字段被拒绝为不可证明（空记录）。
    publish.recordApplyTarget(fixture.dataDir, { runId: 'x', commit: 'nothex', runtimeRoot: '' });
    assert.equal(publish.readApplyTarget(fixture.dataDir), null);
  } finally { cleanup(fixture); }
});

test('重启收口运行时证明：本进程根/cwd/入口/HEAD/内容指纹/保留物全链（B3）', () => {
  const fixture = makeFixture('runtime-proof');
  try {
    const manifest = publish.ensureHoldManifest(fixture.dataDir, fixture.root);
    const provenance = publish.createTaskWorkspace({
      repoRoot: fixture.root, dataDir: fixture.dataDir, runId: 'run-proof-1',
    });
    const task = provenance.taskRoot;
    fs.writeFileSync(path.join(task, 'core/client.js'), 'module.exports = 1;\n');
    fixture.git(['add', '.'], task);
    fixture.git(['commit', '-qm', 'proof candidate'], task);
    const head = fixture.git(['rev-parse', 'HEAD'], task);
    execFileSync('git', ['push', '-q', 'origin', 'HEAD:main'], { cwd: task });
    const runtime = publish.prepareRuntimeWorkspace({
      repoRoot: fixture.root, runId: 'run-proof-1', commit: head, dataDir: fixture.dataDir,
    });
    const record = {
      runId: 'run-proof-1', commit: head, runtimeRoot: runtime.runtimeRoot,
      sourceFingerprint: runtime.logicFingerprint, holdDigest: publish.holdDigest(manifest),
      createdAt: Date.now(),
    };
    publish.recordApplyTarget(fixture.dataDir, record);
    const args = { record: publish.readApplyTarget(fixture.dataDir), dataDir: fixture.dataDir };
    const okRun = publish.verifyRunningRuntime({
      ...args, repoRoot: runtime.runtimeRoot,
      cwd: path.join(runtime.runtimeRoot, 'core'), entry: 'client.js',
    });
    assert.equal(okRun.ok, true, JSON.stringify(okRun));
    // 健康旧源进程（原库根上运行）不能凭记录里的 runtimeRoot 被当成已应用。
    assert.equal(publish.verifyRunningRuntime({
      ...args, repoRoot: fixture.root, cwd: path.join(fixture.root, 'core'), entry: 'client.js',
    }).reason, 'runtime_root_mismatch');
    // 错误入口 / 错误 cwd。
    assert.equal(publish.verifyRunningRuntime({
      ...args, repoRoot: runtime.runtimeRoot, cwd: path.join(runtime.runtimeRoot, 'core'),
      entry: '/elsewhere/bot.js',
    }).reason, 'entry_outside_runtime');
    assert.equal(publish.verifyRunningRuntime({
      ...args, repoRoot: runtime.runtimeRoot, cwd: os.tmpdir(), entry: 'client.js',
    }).reason, 'cwd_outside_runtime');
    // 内容漂移（chmod 反例）在重启收口同样拒绝。目标模式与当前档不同（umask 077
    // 下检出即 600，写死 644→600 是空操作），收尾还原原模式以保证后续 ok 复验。
    const driftSource = path.join(runtime.runtimeRoot, 'core/src/example.js');
    const driftModeBefore = fs.statSync(driftSource).mode & 0o777;
    fs.chmodSync(driftSource, driftModeBefore === 0o600 ? 0o644 : 0o600);
    assert.equal(publish.verifyRunningRuntime({
      ...args, repoRoot: runtime.runtimeRoot,
      cwd: path.join(runtime.runtimeRoot, 'core'), entry: 'client.js',
    }).reason, 'source_fingerprint_mismatch');
    fs.chmodSync(driftSource, driftModeBefore);
    // 记录缺内容指纹 = 不可证明。
    publish.recordApplyTarget(fixture.dataDir, { ...record, sourceFingerprint: '' });
    assert.equal(publish.verifyRunningRuntime({
      record: publish.readApplyTarget(fixture.dataDir), dataDir: fixture.dataDir,
      repoRoot: runtime.runtimeRoot, cwd: path.join(runtime.runtimeRoot, 'core'), entry: 'client.js',
    }).reason, 'record_invalid');
    // 原库保留物漂移 = 拒绝。
    publish.recordApplyTarget(fixture.dataDir, record);
    fs.writeFileSync(path.join(fixture.root, 'core/src/example.js'), 'module.exports = 9;\n');
    assert.equal(publish.verifyRunningRuntime({
      ...args, repoRoot: runtime.runtimeRoot,
      cwd: path.join(runtime.runtimeRoot, 'core'), entry: 'client.js',
    }).reason, 'hold_changed');
    fs.writeFileSync(path.join(fixture.root, 'core/src/example.js'), 'module.exports = 2; // dirty hold\n');
    assert.equal(publish.verifyRunningRuntime({
      ...args, repoRoot: runtime.runtimeRoot,
      cwd: path.join(runtime.runtimeRoot, 'core'), entry: 'client.js',
    }).ok, true);
  } finally { cleanup(fixture); }
});

test('Bot 上下文映射（真实脚本形态 B1）：源仓库根 + 入口从原 cwd 解析、只映射入口与 cwd', () => {
  const source = fs.mkdtempSync(path.join(os.tmpdir(), 'farm-map-src-'));
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'farm-map-dst-'));
  try {
    for (const root of [source, target]) {
      fs.mkdirSync(path.join(root, 'core', 'src'), { recursive: true });
      fs.writeFileSync(path.join(root, 'core', 'client.js'), 'entry\n');
      fs.writeFileSync(path.join(root, 'core', 'src', 'main.js'), 'entry\n');
    }
    // 正式形态：argv=[node,'client.js']、cwd=<源仓库根>/core。源根必须是仓库根
    // （不是 cwd），入口相对名从原 cwd 解析。
    const formal = {
      argv: ['/usr/bin/node', 'client.js', '--flag', 'value'],
      argv0: 'node',
      exe: '/usr/bin/node',
      cwd: path.join(source, 'core'),
      env: { PATH: '/usr/bin', FARM_DATA_DIR: '/old/data' },
    };
    const mapped = publish.mapBotContextToTarget(formal, source, target, '/real/data');
    assert.equal(mapped.cwd, path.join(target, 'core'));
    assert.equal(mapped.argv[0], '/usr/bin/node');
    assert.equal(mapped.argv[1], path.join(target, 'core', 'client.js'));
    assert.equal(mapped.argv[2], '--flag');
    assert.equal(mapped.argv[3], 'value');
    assert.equal(mapped.exe, '/usr/bin/node');
    assert.equal(mapped.env.FARM_DATA_DIR, '/real/data');
    assert.equal(mapped.env.PATH, '/usr/bin');
    // 「长得像路径的普通参数」即使真实存在（源根内目录名）也原样保留：只映射被
    // 证明的 Node 入口与 cwd，不做文件系统存在性猜测。
    const misleading = publish.mapBotContextToTarget(
      { ...formal, argv: ['/usr/bin/node', 'client.js', 'core', 'src'] }, source, target, '/real/data');
    assert.equal(misleading.argv[2], 'core');
    assert.equal(misleading.argv[3], 'src');
    // node 旗标排在入口之前：入口仍是第一个非旗标参数。
    const flagged = publish.mapBotContextToTarget(
      { ...formal, argv: ['/usr/bin/node', '--max-old-space-size=4096', 'client.js'] }, source, target, '/real/data');
    assert.equal(flagged.argv[2], path.join(target, 'core', 'client.js'));
    // 绝对路径入口（源根内）同样可映射。
    const absolute = publish.mapBotContextToTarget(
      { ...formal, argv: ['/usr/bin/node', path.join(source, 'core/src/main.js')] }, source, target, '/real/data');
    assert.equal(absolute.argv[1], path.join(target, 'core/src/main.js'));
    // 源根外的入口 = 未证明的部署，停服前失败。
    assert.throws(() => publish.mapBotContextToTarget(
      { ...formal, argv: ['/usr/bin/node', '/elsewhere/bot.js'] }, source, target, '/real/data'),
    /argv_unmappable/);
    // 源侧存在、目标侧缺失的入口 = 未证明的部署。
    fs.rmSync(path.join(target, 'core', 'client.js'));
    assert.throws(() => publish.mapBotContextToTarget(formal, source, target, '/real/data'), /argv_unmappable/);
    fs.writeFileSync(path.join(target, 'core', 'client.js'), 'entry\n');
    // 连续切换（B1/B5）：Bot 已运行在 <源根>/tmp/evolution-workspaces/<runId>/
    // runtime-<c12> 上的旧运行时根——前缀基准必须是该运行时根，不是源根（否则
    // cwd 会嵌套映射到新目标根的 tmp/ 下）。
    const runtimeLeaf = path.join(source, 'tmp', 'evolution-workspaces', 'run-1', 'runtime-abcdef123456');
    fs.mkdirSync(path.join(runtimeLeaf, 'core'), { recursive: true });
    fs.writeFileSync(path.join(runtimeLeaf, 'core', 'client.js'), 'entry\n');
    const secondHop = publish.mapBotContextToTarget(
      { ...formal, cwd: path.join(runtimeLeaf, 'core') }, source, target, '/real/data');
    assert.equal(secondHop.cwd, path.join(target, 'core'));
    assert.equal(secondHop.argv[1], path.join(target, 'core', 'client.js'));
    // 手工伪造的同名前缀（非本模块生成的 runtime-<12hex> 形态）不享受运行时基准，
    // 仍按源根前缀——目标侧无对应目录即 cwd_unmappable。
    fs.mkdirSync(path.join(source, 'tmp', 'evolution-workspaces', 'run-1', 'runtime-not-hex'), { recursive: true });
    assert.throws(() => publish.mapBotContextToTarget(
      { ...formal, cwd: path.join(source, 'tmp', 'evolution-workspaces', 'run-1', 'runtime-not-hex') },
      source, target, '/real/data'), /cwd_unmappable/);
    // cwd 不在源根内 = 映射不可证明。
    assert.throws(() => publish.mapBotContextToTarget(
      { ...formal, cwd: os.tmpdir() }, source, target, '/real/data'), /cwd_unmappable/);
    // 目标侧 cwd 目录缺失 = 同样不可证明。
    assert.throws(() => publish.mapBotContextToTarget(
      { ...formal, cwd: path.join(source, 'missing') }, source, target, '/real/data'), /cwd_unmappable/);
  } finally {
    fs.rmSync(source, { recursive: true, force: true });
    fs.rmSync(target, { recursive: true, force: true });
  }
});

test('保留物不可漂移：内容/文件集合/HEAD 漂移都拒绝，未触碰通过；清单只做首次初始化', () => {
  const fixture = makeFixture('hold');
  try {
    const manifest = publish.ensureHoldManifest(fixture.dataDir, fixture.root);
    assert.equal(publish.verifyHoldUnchanged(fixture.root, manifest).ok, true);
    // 未暂存保留物内容变化。
    fs.writeFileSync(path.join(fixture.root, 'core/src/example.js'), 'module.exports = 3;\n');
    assert.equal(publish.verifyHoldUnchanged(fixture.root, manifest).reason, 'hold_content_changed');
    fs.writeFileSync(path.join(fixture.root, 'core/src/example.js'), 'module.exports = 2; // dirty hold\n');
    // 新增未跟踪文件 = 保留集合漂移。
    fs.writeFileSync(path.join(fixture.root, 'core/src/extra-hold.js'), 'x\n');
    assert.equal(publish.verifyHoldUnchanged(fixture.root, manifest).reason, 'hold_files_changed');
    fs.rmSync(path.join(fixture.root, 'core/src/extra-hold.js'));
    assert.equal(publish.verifyHoldUnchanged(fixture.root, manifest).ok, true);
    // 根漂移（拿别的根来对清单）与原库 HEAD 前进都拒绝：保留证明绑定精确事实。
    const other = makeFixture('hold-other');
    try {
      assert.equal(publish.verifyHoldUnchanged(other.root, manifest).ok, false);
    } finally { cleanup(other); }
    const headBefore = fixture.git(['rev-parse', 'HEAD']);
    fixture.git(['commit', '--allow-empty', '-qm', 'advance']);
    assert.equal(publish.verifyHoldUnchanged(fixture.root, manifest).reason, 'hold_head_changed');
    // 移回 HEAD 引用（不动工作区——脏保留物必须原样保留）。
    fixture.git(['update-ref', 'HEAD', headBefore]);
    assert.equal(publish.verifyHoldUnchanged(fixture.root, manifest).ok, true);
    // 首次初始化（B5）：已登记的清单不被后续（例如干净运行时根的）重新初始化覆盖。
    const second = publish.ensureHoldManifest(fixture.dataDir, fixture.root);
    assert.equal(second.recordedAt, manifest.recordedAt);
    assert.deepEqual(second.worktree.fileFingerprints, manifest.worktree.fileFingerprints);
    // 属主根：登记根同库时优先返回登记根（跨运行时切换的工作区挂载锚点）。
    assert.equal(publish.ownerStorageRoot(fixture.dataDir, fixture.root), manifest.repoRootReal);
    assert.equal(publish.ownerStorageRoot(fixture.dataDir, '/nonexistent-root'), manifest.repoRootReal);
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farm-hold-empty-'));
    try {
      assert.equal(publish.ownerStorageRoot(path.join(emptyDir, 'core/data'), fixture.root), fixture.root);
    } finally { fs.rmSync(emptyDir, { recursive: true, force: true }); }
  } finally { cleanup(fixture); }
});

test('路径与收尾安全（B7）：符号链接组件拒绝、脏候选绝不删除、旧版共享文件私有继承', () => {
  const fixture = makeFixture('safety');
  try {
    const manifest = publish.ensureHoldManifest(fixture.dataDir, fixture.root);
    // 已存在的符号链接组件（即使指向边界内）在建区前被拒绝。
    fs.mkdirSync(path.join(fixture.root, 'real-tmp'));
    fs.symlinkSync(path.join(fixture.root, 'real-tmp'), path.join(fixture.root, 'tmp'), 'dir');
    assert.throws(() => publish.createTaskWorkspace({
      repoRoot: fixture.root, dataDir: fixture.dataDir, runId: 'run-safe-1',
    }), /workspace_symlink_component|repo_unreadable/);
    fs.rmSync(path.join(fixture.root, 'tmp'));
    const provenance = publish.createTaskWorkspace({
      repoRoot: fixture.root, dataDir: fixture.dataDir, runId: 'run-safe-1',
    });
    const task = provenance.taskRoot;
    // 脏候选（HEAD 未漂移但有未审改动）绝不删除。
    fs.writeFileSync(path.join(task, 'core/src/unreviewed.js'), 'x\n');
    assert.equal(publish.pruneTaskWorkspace(fixture.root, provenance), false);
    assert.ok(fs.existsSync(task));
    // 已提交但未推送/未应用的候选同样不删（HEAD 漂移 = 还有未收口内容）。
    fixture.git(['add', '.'], task);
    fixture.git(['commit', '-qm', 'unreviewed candidate'], task);
    assert.equal(publish.pruneTaskWorkspace(fixture.root, provenance), false);
    assert.ok(fs.existsSync(task));
    // 干净且核验通过（对照受信提交）的已收口任务树才可退役。
    const head = fixture.git(['rev-parse', 'HEAD'], task);
    assert.equal(publish.pruneTaskWorkspace(fixture.root, provenance, { expectedHead: head }), true);
    assert.equal(fs.existsSync(task), false);
    // 旧版共享文件（B6）：legacy <原库>/core/share.txt 缺失时独占私有拷贝进
    // 实际数据目录（0600、不覆盖既有、原库源不动），动作记入私有备注。
    fs.writeFileSync(path.join(fixture.root, 'core', 'share.txt'), 'legacy-share\n');
    assert.equal(publish.ensureLegacyShareFile({ repoRoot: fixture.root, dataDir: fixture.dataDir }), 'copied');
    assert.equal(fs.readFileSync(path.join(fixture.dataDir, 'share.txt'), 'utf8'), 'legacy-share\n');
    assert.equal((fs.statSync(path.join(fixture.dataDir, 'share.txt')).mode & 0o777), 0o600);
    assert.equal(fs.readFileSync(path.join(fixture.root, 'core', 'share.txt'), 'utf8'), 'legacy-share\n');
    assert.equal(publish.ensureLegacyShareFile({ repoRoot: fixture.root, dataDir: fixture.dataDir }), 'present');
    assert.equal(JSON.parse(fs.readFileSync(path.join(fixture.dataDir, 'evolution-share-note.json'), 'utf8')).action, 'present');
    // 保留物证明仍然成立（fixture 根只多了被 gitignore 的内容 + 未跟踪 share.txt
    // 会构成保留集合漂移——share.txt 属于原库新增未跟踪文件，本就应被拒收）。
    assert.equal(publish.verifyHoldUnchanged(fixture.root, manifest).ok, false);
  } finally { cleanup(fixture); }
});

// 与 makeFixture 同型的最小真实 Git 夹具序列（init/config/commit/remote/push），
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'farm-git-sandbox-'));
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
