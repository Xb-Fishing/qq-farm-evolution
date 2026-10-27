const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

/**
 * 共享 Git 工作区实测器（纯检查，无写动作）：runner（validateResumeInput /
 * inspectWorktree）与协调进程（丢失协作恢复的身份核验）必须用同一套逐文件
 * 指纹算法（内容 + 权限 + 暂存状态），否则两侧"当前脏树 === 凭据快照"的精确
 * 合同永远对不上。此处参数化仓库根目录；错误固定为 unsafe_worktree，不携带
 * 本机路径或 git 原文。
 */
function worktreeGit(root, args, env) {
  try {
    return execFileSync('git', args, {
      cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
      ...(env ? { env } : {}),
    });
  } catch {
    throw Object.assign(new Error('unsafe_worktree'), { code: 'unsafe_worktree' });
  }
}

function inspectWorktree(root, options = {}) {
  const env = options.env;
  const git = args => worktreeGit(root, args, env);
  const head = git(['rev-parse', 'HEAD']).trim();
  const status = git(['status', '--porcelain', '--untracked-files=normal']);
  // 变更集合 = 工作区对 HEAD + 暂存区对 HEAD + 未跟踪三者并集（仅暂存文件不出
  // 现在 diff HEAD 里，漏掉它等于允许未经指纹核对的暂存内容混过续接校验）。
  const files = [...new Set([
    ...git(['diff', '--name-only', '-z', 'HEAD']).split('\0'),
    ...git(['diff', '--cached', '--name-only', '-z']).split('\0'),
    ...git(['ls-files', '--others', '--exclude-standard', '-z']).split('\0'),
  ].filter(Boolean))].sort();
  const hash = crypto.createHash('sha256').update(head).update(status);
  const fileFingerprints = {};
  for (const file of files) {
    const digest = hashWorktreeFile(root, file, options);
    fileFingerprints[file] = digest;
    hash.update(`\n${file}:${digest}`);
  }
  return { head, dirty: !!status.trim(), files, fingerprint: hash.digest('hex'), fileFingerprints };
}

// 逐文件指纹只含哈希：内容 + 权限 + 暂存状态，不把文件正文写进运行状态。
function hashWorktreeFile(root, file, options = {}) {
  const fileHash = crypto.createHash('sha256');
  try {
    const full = path.join(root, file);
    let stat;
    try { stat = fs.lstatSync(full); }
    catch (error) { if (error.code !== 'ENOENT') throw Object.assign(new Error('unsafe_worktree'), { code: 'unsafe_worktree' }); }
    if (stat) {
      if (!stat.isFile()) throw Object.assign(new Error('unsafe_worktree'), { code: 'unsafe_worktree' });
      fileHash.update(`mode=${stat.mode.toString(8)};`);
      fileHash.update(fs.readFileSync(full));
    }
    fileHash.update(worktreeGit(root, ['diff', '--cached', '--binary', '--', file], options.env));
  } catch (error) {
    if (error?.code === 'unsafe_worktree') throw error;
    throw Object.assign(new Error('unsafe_worktree'), { code: 'unsafe_worktree' });
  }
  return fileHash.digest('hex');
}

module.exports = { inspectWorktree, hashWorktreeFile };
