'use strict';
/**
 * 进化发布与隔离工作区（2026-10-07 Stage C）。
 *
 * 职责（全部「先证明后动作」，任何一步不可证明即拒绝，不动原库）：
 * - 私有保留源清单（hold manifest）：绑定原库 common-dir/公开基线 + 逐文件
 *   内容/权限/暂存指纹 + 整体工作区指纹。只在本机 0600 私有文件里，永不入 git。
 * - 任务工作区：fresh 任务在「独立验证过的公开远端 HEAD」上建分离 worktree
 *   （共享原库 git-common-dir → 会话登记跨工作区存活），路径必须落在
 *   <repoRoot>/tmp/evolution-workspaces/<runId>/ 边界内（符号链接/外穿硬拒）。
 * - 发布门：对真实提交范围做隐私扫描 + 远端身份核对（必须是建区时的公开基线，
 *   漂移即拒、绝不 force）+ 非强制 push HEAD:main + ls-remote 复核相等。
 * - 运行时工作区：已接受公开提交上的干净 worktree，供应用 helper 做有证明的
 *   目标根切换；Bot 启动上下文（argv/cwd/env）只按「被证明的源根 → 目标根」
 *   前缀映射，映射不可证明即在停服前失败。
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { inspectWorktree } = require('./evolution-worktree');
const { auditGitRange } = require('./privacy-guard');
const { logicSnapshot } = require('./evolution-validation');

const WORKSPACE_DIR_NAME = 'tmp/evolution-workspaces';
const RUN_ID_RE = /^[\w-]{1,100}$/;
const SHA_RE = /^[0-9a-f]{40}$/;

function publishError(reason, detail = {}) {
  return Object.assign(new Error(reason), { code: 'publish_failed', reason, ...detail });
}

function pubGit(root, args, options = {}) {
  try {
    return execFileSync('git', args, {
      cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
      timeout: options.timeoutMs || 60_000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...(options.env || {}) },
    });
  } catch (error) {
    throw publishError(error.reason || 'git_failed', { stderr: String(error.stderr || '').slice(0, 300) });
  }
}

function readPrivateJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writePrivateJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  // 原子落盘：唯一临时名 + rename（0600）——半写坏的记录绝不以完整面目被读到。
  const temp = `${file}.${process.pid}-${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  try { fs.chmodSync(temp, 0o600); } catch {}
  fs.renameSync(temp, file);
  try { fs.chmodSync(file, 0o600); } catch {}
}

/**
 * 路径边界：必须严格落在 <repoRoot>/tmp/evolution-workspaces/<runId>/ 内。
 * 逐组件检查：任何「已存在且是符号链接」的组件一律拒绝（即使它指向边界内——
 * 边界合同是精确生成目录，不是 realpath 等价）；尚不存在的尾部组件允许（建区）。
 */
function workspaceChildPath(repoRoot, runId, leaf) {
  if (!RUN_ID_RE.test(String(runId || ''))) throw publishError('invalid_run_id');
  let rootReal;
  try { rootReal = fs.realpathSync(repoRoot); } catch { throw publishError('repo_unreadable'); }
  const full = path.resolve(rootReal, WORKSPACE_DIR_NAME, runId, leaf || '');
  if (full !== rootReal && !full.startsWith(rootReal + path.sep)) {
    throw publishError('workspace_escape');
  }
  const relative = path.relative(rootReal, full);
  let current = rootReal;
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part);
    let stat;
    try { stat = fs.lstatSync(current); } catch { continue; } // 尚不存在（建区场景）
    if (stat.isSymbolicLink()) throw publishError('workspace_symlink_component');
  }
  return full;
}

/** rev-parse --git-common-dir 在主仓库返回相对路径（.git）：必须先对根 resolve。 */
function realCommonDir(root, options = {}) {
  const output = String(pubGit(root, ['rev-parse', '--git-common-dir'], { env: options.env })).trim();
  return fs.realpathSync(path.resolve(root, output));
}

function remoteMainHead(root, options = {}) {
  const output = String(pubGit(root, ['ls-remote', 'origin', 'refs/heads/main'], { timeoutMs: 30_000, env: options.env }) || '').trim();
  const head = output.split(/\s+/)[0] || '';
  if (!SHA_RE.test(head)) throw publishError('remote_unreadable');
  return head;
}

// ---------------------------------------------------------------------------
// 私有保留源清单：原库脏内容的完整绑定（内容/权限/暂存/未跟踪 + 整体指纹）。
// 只在验证过的观察时刷新；比对失败 = 保留内容漂移，绝不清理原库来「修复」。
// ---------------------------------------------------------------------------

function buildHoldManifest(repoRoot, options = {}) {
  const inspected = inspectWorktree(repoRoot, { env: options.env });
  return {
    version: 1,
    recordedAt: Date.now(),
    repoRootReal: fs.realpathSync(repoRoot),
    commonDir: realCommonDir(repoRoot, options),
    publicBase: {
      head: inspected.head,
      remoteMain: remoteMainHead(repoRoot, options),
    },
    worktree: {
      head: inspected.head,
      files: inspected.files,
      fileFingerprints: inspected.fileFingerprints,
      fingerprint: inspected.fingerprint,
      dirty: inspected.dirty,
    },
  };
}

/** 保留内容未被触碰的证明：根/common-dir/HEAD/文件集合/逐文件内容权限暂存
 * 指纹/整体指纹全部精确一致。任何一项不可证明 = 保留物漂移，绝不放行。 */
function verifyHoldUnchanged(repoRoot, manifest, options = {}) {
  if (!manifest || manifest.version !== 1 || !manifest.worktree) {
    return { ok: false, reason: 'hold_manifest_invalid' };
  }
  try {
    const rootReal = fs.realpathSync(repoRoot);
    if (rootReal !== manifest.repoRootReal) return { ok: false, reason: 'hold_root_changed' };
    if (realCommonDir(rootReal, options) !== manifest.commonDir) {
      return { ok: false, reason: 'hold_root_changed' };
    }
    const now = inspectWorktree(rootReal, { env: options.env });
    if (now.head !== manifest.worktree.head) return { ok: false, reason: 'hold_head_changed' };
    if (now.files.length !== manifest.worktree.files.length
      || now.files.some((file, index) => file !== manifest.worktree.files[index])) {
      return { ok: false, reason: 'hold_files_changed' };
    }
    for (const [file, digest] of Object.entries(manifest.worktree.fileFingerprints)) {
      if (now.fileFingerprints[file] !== digest) return { ok: false, reason: 'hold_content_changed', file };
    }
    if (now.fingerprint !== manifest.worktree.fingerprint) {
      return { ok: false, reason: 'hold_fingerprint_changed' };
    }
    return { ok: true, inspectedAt: Date.now(), fingerprint: now.fingerprint };
  } catch {
    return { ok: false, reason: 'hold_verify_failed' };
  }
}

function holdManifestPath(dataDir) {
  return path.join(dataDir, 'evolution-holds.json');
}

function recordHoldManifest(dataDir, manifest) {
  writePrivateJson(holdManifestPath(dataDir), manifest);
}

function readHoldManifest(dataDir) {
  try { return readPrivateJson(holdManifestPath(dataDir)); } catch { return null; }
}

/**
 * 保留清单只做「首次初始化」：从真实原库（OriginalRoot）捕获一次。此后 Bot 可能
 * 已切换到干净的运行时工作区运行——当前根的清单（干净树）绝不覆盖原始绑定，
 * 否则原库脏保留物的完整证明链被静默清空。
 */
function ensureHoldManifest(dataDir, repoRoot, options = {}) {
  const existing = readHoldManifest(dataDir);
  if (existing) return existing;
  const manifest = buildHoldManifest(repoRoot, options);
  recordHoldManifest(dataDir, manifest);
  return manifest;
}

/**
 * 持久规范的存储/属主根（B5）：工作区永远挂第一次初始化保留清单的原库之下，
 * 而不是挂在「当前进程恰好运行所在的运行时工作区」之下——否则每次应用都会
 * 把工作区嵌套进上一个运行时根，逐层加深。仅当记录根与当前根同库（common-dir
 * 一致）时才采信记录根；不可证明即回退当前根（首次 bootstrap）。
 */
function ownerStorageRoot(dataDir, fallbackRoot, options = {}) {
  const existing = readHoldManifest(dataDir);
  if (existing?.repoRootReal) {
    try {
      const recorded = realCommonDir(existing.repoRootReal, options);
      try {
        if (recorded === realCommonDir(fallbackRoot, options)) return existing.repoRootReal;
      } catch {
        // 当前根不可读（如换根竞态）：登记根仍真实可用时以持久属主根为准。
        return existing.repoRootReal;
      }
    } catch { /* 登记根不可用：回退当前根 */ }
  }
  return fallbackRoot;
}

/** 保留清单内容的私有摘要（不进产品状态/API）：只有数量与整体指纹。 */
function holdDigest(manifest) {
  if (!manifest?.worktree) return '';
  return crypto.createHash('sha256').update(JSON.stringify(manifest.worktree)).digest('hex');
}

// ---------------------------------------------------------------------------
// 任务/运行时工作区
// ---------------------------------------------------------------------------

function provenancePath(dataDir) {
  return path.join(dataDir, 'evolution-workspace.json');
}

function recordProvenance(dataDir, record) {
  writePrivateJson(provenancePath(dataDir), record);
}

function readProvenance(dataDir) {
  try {
    const value = readPrivateJson(provenancePath(dataDir));
    if (!value || typeof value !== 'object') return null;
    return {
      runId: String(value.runId || ''),
      taskRoot: String(value.taskRoot || ''),
      // 建区时的仓库根（绝对路径）：应用重启后 Bot 可能已运行在别的运行时工作区，
      // 边界核验以记录里的根为准（仍要求同一 git 库，见 verifyTaskWorkspace）。
      repoRootReal: String(value.repoRootReal || ''),
      commonDir: String(value.commonDir || ''),
      publicBase: SHA_RE.test(String(value.publicBase || '')) ? String(value.publicBase) : '',
      headAtCreation: SHA_RE.test(String(value.headAtCreation || '')) ? String(value.headAtCreation) : '',
      createdAt: Math.max(0, Number(value.createdAt) || 0),
    };
  } catch { return null; }
}

/**
 * 建任务工作区：fetch 后以「独立验证的公开远端 HEAD」建分离 worktree。
 * 原库只发生 fetch（移动 refs/remotes 追踪引用），不改 HEAD/文件/索引。
 */
function createTaskWorkspace({ repoRoot, dataDir, runId, options = {} }) {
  const taskRoot = workspaceChildPath(repoRoot, runId, 'task');
  if (fs.existsSync(taskRoot)) throw publishError('workspace_exists');
  pubGit(repoRoot, ['fetch', 'origin', 'main'], { timeoutMs: 120_000, env: options.env });
  const remoteHead = remoteMainHead(repoRoot, options);
  const tracked = String(pubGit(repoRoot, ['rev-parse', 'refs/remotes/origin/main'], { env: options.env })).trim();
  if (tracked !== remoteHead) throw publishError('remote_tracking_mismatch');
  fs.mkdirSync(path.dirname(taskRoot), { recursive: true, mode: 0o700 });
  pubGit(repoRoot, ['worktree', 'add', '--detach', taskRoot, remoteHead]);
  fs.chmodSync(taskRoot, 0o700);
  const head = String(pubGit(taskRoot, ['rev-parse', 'HEAD'], { env: options.env })).trim();
  if (head !== remoteHead) throw publishError('workspace_head_mismatch');
  wireRuntimeResources(repoRoot, taskRoot, dataDir);
  const provenance = {
    runId, taskRoot, publicBase: remoteHead, headAtCreation: head,
    repoRootReal: fs.realpathSync(repoRoot),
    commonDir: realCommonDir(taskRoot, options),
    createdAt: Date.now(),
  };
  recordProvenance(dataDir, provenance);
  return provenance;
}

/**
 * 复用已登记任务工作区（B2/B5 合同）：
 * - 调用方根绑定：调用方 canonical common-dir 必须与登记的 common-dir 一致——
 *   原库与其运行时 worktree 都合法（同库换根运行是正常切换），外库/不存在的
 *   调用方根一律拒绝，绝不只信记录里的根。
 * - 边界：taskRoot 必须精确等于 <记录的原库根>/tmp/evolution-workspaces/<runId>/task。
 * - HEAD：publicBase/headAtCreation 保持不可变（建区事实）；当前 HEAD 只对照
 *   「受信提交」——调用方显式传入的 expectedHead（真实 checkpoint 或已完成的
 *   主审批准提交），并要求该提交仍是公开基线的后代（血缘证明）。没有任何受信
 *   输入时退回建区 HEAD（fresh 区未提交阶段）。绝不宽泛取消检查，也绝不改写
 *   headAtCreation 来伪装漂移。
 */
function verifyTaskWorkspace(repoRoot, provenance, options = {}) {
  try {
    if (!provenance?.runId || !provenance?.taskRoot) return { ok: false, reason: 'provenance_invalid' };
    const callerReal = fs.realpathSync(repoRoot);
    const callerCommon = realCommonDir(callerReal, options);
    if (callerCommon !== provenance.commonDir) return { ok: false, reason: 'root_repo_mismatch' };
    const rootReal = fs.realpathSync(provenance.repoRootReal);
    const stat = fs.lstatSync(provenance.taskRoot);
    if (!stat.isDirectory()) return { ok: false, reason: 'task_root_not_dir' };
    const taskReal = fs.realpathSync(provenance.taskRoot);
    const expectedBase = path.resolve(rootReal, WORKSPACE_DIR_NAME, provenance.runId);
    if (taskReal !== path.resolve(expectedBase, 'task')) return { ok: false, reason: 'task_root_outside_boundary' };
    const head = String(pubGit(provenance.taskRoot, ['rev-parse', 'HEAD'], { env: options.env })).trim();
    const expected = SHA_RE.test(String(options.expectedHead || ''))
      ? String(options.expectedHead) : provenance.headAtCreation;
    if (!SHA_RE.test(String(expected))) return { ok: false, reason: 'task_head_unprovable' };
    if (head !== expected) return { ok: false, reason: 'task_head_drifted' };
    if (SHA_RE.test(String(options.expectedHead || ''))) {
      try {
        pubGit(provenance.taskRoot, ['merge-base', '--is-ancestor', provenance.publicBase, head], { env: options.env });
      } catch {
        return { ok: false, reason: 'task_lineage_unprovable' };
      }
    }
    const commonDir = realCommonDir(provenance.taskRoot, options);
    if (commonDir !== provenance.commonDir) return { ok: false, reason: 'common_dir_changed' };
    return { ok: true };
  } catch (error) {
    if (error?.code === 'publish_failed' && error.reason) return { ok: false, reason: error.reason };
    return { ok: false, reason: 'task_verify_failed' };
  }
}

/** 运行时资源接线（B6）：依赖与私有文档以符号链接共享原库既有内容，全部
 * git-ignored/excluded，不做任意私有源拷贝；tmp/ 先建好（构建/应用前的就绪性）。 */
const RUNTIME_LINKS = [
  'node_modules', 'core/node_modules', 'web/node_modules',
  'core/data', 'docs/HANDOFF.md', 'docs/skills', 'core/docs/skills',
];

function wireRuntimeResources(sourceRoot, runtimeRoot, dataDir = '') {
  const sourceReal = fs.realpathSync(sourceRoot);
  fs.mkdirSync(path.join(runtimeRoot, 'tmp'), { recursive: true, mode: 0o700 });
  // 目录尾斜杠的 ignore 规则不匹配符号链接；这些已知私有资源在所有关联
  // worktree 中使用精确的本地排除项，避免进入候选差异或提交。
  const excludeFile = path.join(realCommonDir(runtimeRoot), 'info', 'exclude');
  let excludes = '';
  try { excludes = fs.readFileSync(excludeFile, 'utf8'); } catch (error) {
    if (error.code !== 'ENOENT') throw publishError('resource_exclude_unreadable');
  }
  const lines = new Set(excludes.split(/\r?\n/));
  const missing = RUNTIME_LINKS
    .filter(relative => !String(pubGit(runtimeRoot, ['ls-files', '--', relative])).trim())
    .map(relative => `/${relative}`).filter(pattern => !lines.has(pattern));
  if (missing.length) {
    fs.mkdirSync(path.dirname(excludeFile), { recursive: true });
    fs.appendFileSync(excludeFile, `\n${missing.join('\n')}\n`);
  }
  for (const relative of RUNTIME_LINKS) {
    const from = relative === 'core/data' && dataDir ? path.resolve(dataDir) : path.join(sourceReal, relative);
    let stat;
    try { stat = fs.statSync(from); } catch { continue; }
    if (!stat.isDirectory() && !stat.isFile()) continue;
    const to = path.join(runtimeRoot, relative);
    if (fs.existsSync(to)) continue; // 目标已存在（检出内容）绝不覆盖
    fs.mkdirSync(path.dirname(to), { recursive: true, mode: 0o700 });
    fs.symlinkSync(from, to);
  }
}

/** 旧版共享文件继承（B6）：老环境无 FARM_DATA_DIR 时 Bot 用 <原库>/core/share.txt；
 * 强制 FARM_DATA_DIR 后路径变为 <dataDir>/share.txt。缺失时做独占私有拷贝
 * （0600、不覆盖既有数据、原库源不动），结果记入私有 0600 备注（不含内容）。 */
function ensureLegacyShareFile({ repoRoot, dataDir }) {
  const legacy = path.join(repoRoot, 'core', 'share.txt');
  const target = path.join(dataDir, 'share.txt');
  let action = 'absent';
  try {
    if (fs.existsSync(target)) action = 'present';
    else if (fs.statSync(legacy).isFile()) {
      const temp = `${target}.${process.pid}-${crypto.randomUUID()}.tmp`;
      fs.copyFileSync(legacy, temp);
      fs.chmodSync(temp, 0o600);
      try {
        fs.linkSync(temp, target);
        action = 'copied';
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        action = 'present';
      } finally {
        fs.unlinkSync(temp);
      }
    }
  } catch {
    action = 'unprovable';
  }
  if (action !== 'absent') writePrivateJson(path.join(dataDir, 'evolution-share-note.json'), { action, recordedAt: Date.now() });
  return action;
}

/**
 * 已接受公开提交上的干净运行时 worktree（应用 helper 的目标根）。按提交后缀
 * 命名（runtime-<commit12>）：同一提交可核验复用，不同提交各有独立运行时根，
 * 连续切换不覆盖旧根。内容身份用 logicSnapshot（当前内容+权限指纹）——
 * inspectWorktree 指纹只是 HEAD/status 哈希，捕获不了「干净树上的权限改动」。
 */
function prepareRuntimeWorkspace({ repoRoot, runId, commit, dataDir = '', options = {} }) {
  if (!SHA_RE.test(String(commit || ''))) throw publishError('invalid_commit');
  const runtimeRoot = workspaceChildPath(repoRoot, runId, `runtime-${String(commit).slice(0, 12)}`);
  // 幂等复用（B2 重启退回修复，2026-10-07）：自主应用启动后重启收口退回
  // pending_apply 是正常节奏（helper 失败/错误根），再次应用同一提交时既有运行时
  // 区仍是「干净 + 同 HEAD」的可证明工作区 → 直接复用，绝不因「已存在」把候选
  // 卡死在待应用。脏/漂移的既有目录 = 不可证明，诚实拒绝（绝不删除重建——退役
  // 只走 pruneTaskWorkspace 的受信收尾）。重新计算内容与权限指纹，下游 helper
  // 必须将它与实际通过的完整回归记录核对，准备完成本身不构成应用批准。
  if (fs.existsSync(runtimeRoot)) {
    try {
      const inspected = inspectWorktree(runtimeRoot, { env: options.env });
      if (inspected.head === commit && !inspected.dirty) {
        const fingerprint = logicSnapshot(runtimeRoot).fingerprint;
        if (/^[0-9a-f]{64}$/.test(fingerprint)) {
          return { runtimeRoot, fingerprint: inspected.fingerprint, logicFingerprint: fingerprint };
        }
      }
    } catch { /* 落到下面的诚实拒绝 */ }
    throw publishError('runtime_workspace_unprovable');
  }
  pubGit(repoRoot, ['cat-file', '-e', `${commit}^{commit}`], { env: options.env });
  fs.mkdirSync(path.dirname(runtimeRoot), { recursive: true, mode: 0o700 });
  pubGit(repoRoot, ['worktree', 'add', '--detach', runtimeRoot, commit]);
  fs.chmodSync(runtimeRoot, 0o700);
  wireRuntimeResources(repoRoot, runtimeRoot, dataDir);
  if (dataDir) ensureLegacyShareFile({ repoRoot, dataDir });
  const inspected = inspectWorktree(runtimeRoot, { env: options.env });
  if (inspected.head !== commit || inspected.dirty) throw publishError('runtime_not_clean');
  const logicFingerprint = logicSnapshot(runtimeRoot).fingerprint;
  if (!/^[0-9a-f]{64}$/.test(logicFingerprint)) throw publishError('runtime_content_unprovable');
  return { runtimeRoot, fingerprint: inspected.fingerprint, logicFingerprint };
}

/**
 * 重启收口的运行时证明（B3）：不是「记录里有个 runtimeRoot」就算应用成功——
 * 必须实测「本进程」真实运行在记录的运行时根上（仓库根/cwd/入口都在根内）、
 * HEAD 等于记录提交、当前内容 logicSnapshot 等于记录源指纹（非空）、原库保留
 * 物摘要一致且未动。健康的旧源进程或错误入口进程绝不能被标记为已应用。
 */
function verifyRunningRuntime({ record, repoRoot, cwd = '', entry = '', dataDir }) {
  if (!record?.commit || !record?.runtimeRoot || !/^[0-9a-f]{64}$/.test(String(record.sourceFingerprint || ''))) {
    return { ok: false, reason: 'record_invalid' };
  }
  try {
    const runtimeReal = fs.realpathSync(record.runtimeRoot);
    const rootReal = fs.realpathSync(repoRoot);
    if (runtimeReal !== rootReal) return { ok: false, reason: 'runtime_root_mismatch' };
    const cwdAbs = path.resolve(rootReal, String(cwd || ''));
    if (cwdAbs !== rootReal && !cwdAbs.startsWith(rootReal + path.sep)) {
      return { ok: false, reason: 'cwd_outside_runtime' };
    }
    const entryAbs = path.resolve(cwdAbs || rootReal, String(entry || ''));
    if (entryAbs !== rootReal && !entryAbs.startsWith(rootReal + path.sep)) {
      return { ok: false, reason: 'entry_outside_runtime' };
    }
    if (String(pubGit(rootReal, ['rev-parse', 'HEAD'])).trim() !== record.commit) {
      return { ok: false, reason: 'head_mismatch' };
    }
    if (logicSnapshot(rootReal).fingerprint !== record.sourceFingerprint) {
      return { ok: false, reason: 'source_fingerprint_mismatch' };
    }
    const manifest = readHoldManifest(dataDir);
    if (!manifest || holdDigest(manifest) !== record.holdDigest
      || !verifyHoldUnchanged(manifest.repoRootReal, manifest).ok) {
      return { ok: false, reason: 'hold_changed' };
    }
    return { ok: true };
  } catch {
    return { ok: false, reason: 'runtime_verify_failed' };
  }
}

// ---------------------------------------------------------------------------
// 发布门（任务工作区内执行；原库零改动）
// ---------------------------------------------------------------------------

/**
 * 从任务工作区发布：真实提交范围隐私扫描 → 远端仍是建区基线（漂移即拒，绝不
 * force/绝不伪造收口）→ 非强制 push HEAD:main → ls-remote 复核相等。
 */
async function publishFromWorkspace({ taskRoot, base, head, expectedBase, reviewedOrchestrationFiles = [], push = true, options = {} }) {
  if (!SHA_RE.test(String(head || ''))) return { ok: false, reason: 'invalid_head' };
  const remoteHead = remoteMainHead(taskRoot, options);
  if (remoteHead === head) return { ok: true, alreadyAtRemote: true };
  const baseline = String(expectedBase || base || '');
  if (!SHA_RE.test(baseline)) return { ok: false, reason: 'baseline_unprovable' };
  if (remoteHead !== baseline) return { ok: false, reason: 'remote_drift', remoteHead };
  const audit = auditGitRange(taskRoot, baseline, head, { reviewedOrchestrationFiles, runtimeTerms: options.runtimeTerms });
  if (!audit.ok) return { ok: false, reason: 'privacy_blocked', findings: audit.findings };
  if (!push) return { ok: true, pushed: false };
  try {
    pubGit(taskRoot, ['push', 'origin', 'HEAD:main'], { timeoutMs: 120_000, env: options.env });
  } catch (error) {
    return { ok: false, reason: 'push_failed', error: String(error.stderr || error.reason || '').slice(0, 300) };
  }
  if (remoteMainHead(taskRoot, options) !== head) return { ok: false, reason: 'remote_verification_failed' };
  return { ok: true, pushed: true };
}

/** 任务工作区收尾（B7）：只退役「已验证 + 干净 + HEAD 未漂移」的已收口任务树
 * （非强制 remove，脏树天然失败）。脏/未审/身份漂移的候选绝不删除，运行时根
 * （新部署本体）永不在此删除；删不掉就留在原地交人工核对。 */
function pruneTaskWorkspace(repoRoot, provenance, options = {}) {
  if (!provenance?.taskRoot) return false;
  const verify = verifyTaskWorkspace(repoRoot, provenance, options);
  if (!verify.ok) return false;
  const inspected = inspectWorktree(provenance.taskRoot, { env: options.env });
  if (inspected.dirty || inspected.files.length) return false;
  try {
    pubGit(repoRoot, ['worktree', 'remove', provenance.taskRoot], { env: options.env });
  } catch {
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Bot 启动上下文的目标根映射（应用 helper 停服前调用）
// ---------------------------------------------------------------------------

/**
 * 只映射两项：被证明的 Node 入口与 cwd（B1 真实脚本形态合同）。
 * - sourceRoot 必须是被证明的「源仓库根」（原库或其运行时 worktree——由调用方
 *   经 verifyTaskWorkspace 证明后传入），不是 Bot 的 cwd（cwd 常在 <根>/core）。
 * - 连续切换：Bot 可能已运行在 <源根>/tmp/evolution-workspaces/<runId>/runtime-<c12>
 *   上的旧运行时根——此时前缀基准改为该运行时根（本模块生成的精确目录形态），
 *   否则映射会嵌套进新目标根的 tmp/ 下。除此之外一律按源根前缀。
 * - 入口按 node 语义识别：argv[0] 是执行器，其后第一个非旗标参数即脚本入口，
 *   从「原始 cwd」解析；必须落在（有效）源根内且是存在的文件，目标侧对应文件
 *   也必须存在，否则停服前失败（argv_unmappable，包括入口在源根外的场景）。
 * - 其余 argv 一律原样保留：旗标、普通参数——即使某个普通参数恰好长得像源根
 *   内存在的路径/目录，也不做文件系统存在性猜测式映射。
 * - cwd 必须在（有效）源根内且映射目标存在（目录），否则 cwd_unmappable。
 * - exe/argv0/其余 env 原样保留；FARM_DATA_DIR 强制指向实际原原数据目录。
 */
function mapBotContextToTarget(context, sourceRoot, targetRoot, dataDir) {
  if (!Array.isArray(context?.argv) || context.argv.length < 2) throw publishError('context_invalid');
  if (!sourceRoot || !targetRoot) throw publishError('roots_unprovable');
  const sourceReal = fs.realpathSync(sourceRoot);
  const targetReal = fs.realpathSync(targetRoot);
  const cwdAbs = path.resolve(sourceReal, String(context.cwd || ''));
  if (cwdAbs !== sourceReal && !cwdAbs.startsWith(sourceReal + path.sep)) throw publishError('cwd_unmappable');
  // 有效源根：cwd 落在本模块生成的运行时工作区（精确形态）内时，改以该运行时根
  // 为前缀基准；其余（含手工伪造的同名前缀）一律仍按源根，交给存在性/边界检查。
  let effectiveSource = sourceReal;
  const relative = path.relative(sourceReal, cwdAbs);
  const workspacePrefix = `${WORKSPACE_DIR_NAME}/`;
  if (relative.startsWith(workspacePrefix)) {
    const match = /^[\w-]{1,100}\/runtime-[0-9a-f]{12}(?:\/|$)/.exec(relative.slice(workspacePrefix.length));
    if (match) effectiveSource = path.join(sourceReal, workspacePrefix, match[0].replace(/\/$/, ''));
  }
  if (cwdAbs !== effectiveSource && !cwdAbs.startsWith(effectiveSource + path.sep)) throw publishError('cwd_unmappable');
  try { if (!fs.statSync(cwdAbs).isDirectory()) throw new Error('not_dir'); } catch { throw publishError('cwd_unmappable'); }
  const cwdTarget = cwdAbs === effectiveSource
    ? targetReal
    : path.join(targetReal, cwdAbs.slice(effectiveSource.length + path.sep.length));
  try { if (!fs.statSync(cwdTarget).isDirectory()) throw new Error('not_dir'); } catch { throw publishError('cwd_unmappable'); }
  let entryIndex = -1;
  for (let index = 1; index < context.argv.length; index += 1) {
    if (String(context.argv[index]).startsWith('-')) continue;
    entryIndex = index;
    break;
  }
  if (entryIndex < 0) throw publishError('argv_unmappable');
  const entryAbs = path.resolve(cwdAbs, String(context.argv[entryIndex]));
  if (entryAbs === effectiveSource || !entryAbs.startsWith(effectiveSource + path.sep)) throw publishError('argv_unmappable');
  try { if (!fs.statSync(entryAbs).isFile()) throw new Error('not_file'); } catch { throw publishError('argv_unmappable'); }
  const entryTarget = path.join(targetReal, entryAbs.slice(effectiveSource.length + path.sep.length));
  try { if (!fs.statSync(entryTarget).isFile()) throw new Error('not_file'); } catch { throw publishError('argv_unmappable'); }
  return {
    argv: context.argv.map((item, index) => (index === entryIndex ? entryTarget : item)),
    argv0: context.argv0 || context.argv[0],
    exe: context.exe || '',
    cwd: cwdTarget,
    env: { ...context.env, FARM_DATA_DIR: dataDir },
  };
}

// ---------------------------------------------------------------------------
// 私有应用目标记录：helper 与重启后的收口据此核对运行时根/提交/源指纹/保留摘要。
// ---------------------------------------------------------------------------

function applyTargetPath(dataDir) {
  return path.join(dataDir, 'evolution-apply-target.json');
}

function recordApplyTarget(dataDir, record) {
  writePrivateJson(applyTargetPath(dataDir), {
    runId: String(record.runId || ''),
    commit: String(record.commit || ''),
    runtimeRoot: String(record.runtimeRoot || ''),
    sourceFingerprint: /^[0-9a-f]{64}$/.test(String(record.sourceFingerprint || ''))
      ? String(record.sourceFingerprint) : '',
    holdDigest: /^[0-9a-f]{64}$/.test(String(record.holdDigest || '')) ? String(record.holdDigest) : '',
    createdAt: Math.max(0, Number(record.createdAt) || 0),
  });
}

function readApplyTarget(dataDir) {
  try {
    const value = readPrivateJson(applyTargetPath(dataDir));
    if (!value || typeof value !== 'object') return null;
    if (!SHA_RE.test(String(value.commit || '')) || !String(value.runtimeRoot || '')) return null;
    return {
      runId: String(value.runId || ''),
      commit: String(value.commit),
      runtimeRoot: String(value.runtimeRoot),
      sourceFingerprint: /^[0-9a-f]{64}$/.test(String(value.sourceFingerprint || '')) ? String(value.sourceFingerprint) : '',
      holdDigest: /^[0-9a-f]{64}$/.test(String(value.holdDigest || '')) ? String(value.holdDigest) : '',
      createdAt: Math.max(0, Number(value.createdAt) || 0),
    };
  } catch { return null; }
}

module.exports = {
  WORKSPACE_DIR_NAME,
  buildHoldManifest,
  recordHoldManifest,
  readHoldManifest,
  ensureHoldManifest,
  ownerStorageRoot,
  verifyHoldUnchanged,
  holdDigest,
  realCommonDir,
  createTaskWorkspace,
  verifyTaskWorkspace,
  prepareRuntimeWorkspace,
  verifyRunningRuntime,
  ensureLegacyShareFile,
  publishFromWorkspace,
  pruneTaskWorkspace,
  mapBotContextToTarget,
  recordProvenance,
  readProvenance,
  recordApplyTarget,
  readApplyTarget,
  remoteMainHead,
};
