'use strict';
// 批准运行时入口路由（2026-10-08 维护会话二批）：原库（保留草稿的旧检出）上的
// 普通启动（npm/pnpm/start.sh/node core/client.js）必须加载已验收的运行时，而不
// 是原库保留代码。选择依据是「最后一次真实 ready 应用」写入的私有验收证书
// （evolution-approved-runtime.json，helper 仅在实测 源/进程/端口/健康/验证 全部
// 通过后原子落盘）——全局 evolution-validation.json / evolution-workspace.json 会被
// 下一轮自主研究合法替换，已接受的未变运行时必须保持可启动；最新 apply-target
// 可能指向尚未应用的更新候选，绝不提前执行。证书从未存在时才走 legacy 兼容路径
// （真实 ready 回执 + 仍然匹配的全局通过证据）。同根自举（已接受根 / helper 正在
// 应用的 pending 根）绝不跳过源身份证明：实测 HEAD/干净/内容+权限指纹，漂移即拒
// 绝；证明不了就明确失败退出，绝不静默运行旧源，也绝不放宽任何既有授权/预算/
// HOT/PREARM/恢复语义。
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');
// 只依赖源检出自身就存在的验证模块（原库旧检出也含 evolution-validation.js）；
// 原库没有 evolution-publish.js——保留物核验改用「已指纹证实的目标」侧 publish
// 服务（见 loadTargetPublishService）。
const { logicSnapshot, getValidationSummary } = require('../services/evolution-validation');

const WORKSPACE_DIR_NAME = 'tmp/evolution-workspaces';
const CERTIFICATE_FILE_NAME = 'evolution-approved-runtime.json';
const RUN_ID_RE = /^[\w-]{1,100}$/;
const SHA40_RE = /^[0-9a-f]{40}$/;
const SHA64_RE = /^[0-9a-f]{64}$/;
const SIGNAL_NUMBERS = {
    SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGILL: 4, SIGTRAP: 5, SIGABRT: 6, SIGBUS: 7,
    SIGFPE: 8, SIGKILL: 9, SIGUSR1: 10, SIGSEGV: 11, SIGUSR2: 12, SIGPIPE: 13,
    SIGALRM: 14, SIGTERM: 15, SIGCHLD: 17, SIGCONT: 18, SIGSTOP: 19, SIGTSTP: 20,
    SIGTTIN: 21, SIGTTOU: 22,
};

function reasonError(reason) {
    return Object.assign(new Error(reason), { reason });
}

function gitText(root, args) {
    // 输出只作判等/判空用，不携带本机路径；失败统一映射为固定 reason。
    return execFileSync('git', args, {
        cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
    });
}

/** 与 evolution-publish.realCommonDir 同式：--git-common-dir 相对路径必须对根 resolve。 */
function realCommonDir(root) {
    const output = String(gitText(root, ['rev-parse', '--git-common-dir'])).trim();
    return fs.realpathSync(path.resolve(root, output));
}

function readPrivateJson(file) {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function realpathOrNull(value) {
    try {
        return fs.realpathSync(value);
    } catch {
        return '';
    }
}

/** 应用目标记录（evolution-apply-target.json）的启动侧严格 schema；文件缺失 = 无
 * 管理目标（普通独立自举），存在但不可解析/schema 不符 = 拒绝（不是普通自举）。 */
function readApplyTargetRecord(dataDir) {
    const file = path.join(dataDir, 'evolution-apply-target.json');
    let raw;
    try {
        raw = fs.readFileSync(file, 'utf8');
    } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw reasonError('apply_target_unreadable');
    }
    let value;
    try {
        value = JSON.parse(raw);
    } catch {
        throw reasonError('apply_target_invalid');
    }
    if (!value || typeof value !== 'object'
        || !SHA40_RE.test(String(value.commit || ''))
        || !RUN_ID_RE.test(String(value.runId || ''))
        || !SHA64_RE.test(String(value.sourceFingerprint || ''))
        || !SHA64_RE.test(String(value.holdDigest || ''))
        || !String(value.runtimeRoot || '')
        || !Number.isSafeInteger(value.createdAt) || value.createdAt <= 0) {
        throw reasonError('apply_target_invalid');
    }
    return {
        runId: String(value.runId),
        commit: String(value.commit),
        runtimeRoot: String(value.runtimeRoot),
        sourceFingerprint: String(value.sourceFingerprint),
        holdDigest: String(value.holdDigest),
        createdAt: value.createdAt,
    };
}

/** 最近一次真实 ready 应用的私有验收证书（helper 原子写入）：目标记录快照 +
 * 实测通过的验证摘要 + 验收时任务溯源快照 + ready 进程身份。文件缺失 = 从未存在
 * （legacy 兼容路径）；存在但不可解析/schema 不符 = 拒绝，绝不回退 legacy。 */
function readApprovedCertificate(dataDir) {
    const file = path.join(dataDir, CERTIFICATE_FILE_NAME);
    let raw;
    try {
        raw = fs.readFileSync(file, 'utf8');
    } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw reasonError('approved_certificate_invalid');
    }
    let value;
    try {
        value = JSON.parse(raw);
    } catch {
        throw reasonError('approved_certificate_invalid');
    }
    const target = value && typeof value === 'object' ? value.target : null;
    const validation = value && typeof value === 'object' ? value.validation : null;
    const provenance = value && typeof value === 'object' ? value.provenance : null;
    if (value.version !== 1
        || !Number.isSafeInteger(value.certifiedAt) || value.certifiedAt <= 0
        || !target || typeof target !== 'object'
        || !SHA40_RE.test(String(target.commit || ''))
        || !RUN_ID_RE.test(String(target.runId || ''))
        || !SHA64_RE.test(String(target.sourceFingerprint || ''))
        || !SHA64_RE.test(String(target.holdDigest || ''))
        || !String(target.runtimeRoot || '')
        || !validation || typeof validation !== 'object'
        || validation.state !== 'passed'
        || !SHA64_RE.test(String(validation.fingerprint || ''))
        || !Array.isArray(validation.checks)
        || validation.checks.join(',') !== 'backend,frontend'
        || !provenance || typeof provenance !== 'object'
        || String(provenance.runId || '') !== String(target.runId || '')
        || !String(provenance.taskRoot || '')
        || !String(provenance.commonDir || '')
        || !SHA40_RE.test(String(provenance.publicBase || ''))) {
        throw reasonError('approved_certificate_invalid');
    }
    if (validation.fingerprint !== target.sourceFingerprint) {
        throw reasonError('validation_fingerprint_mismatch');
    }
    return {
        certifiedAt: value.certifiedAt,
        target: {
            runId: String(target.runId),
            commit: String(target.commit),
            runtimeRoot: String(target.runtimeRoot),
            sourceFingerprint: String(target.sourceFingerprint),
            holdDigest: String(target.holdDigest),
        },
        validation: {
            state: 'passed',
            fingerprint: String(validation.fingerprint),
            checks: validation.checks.map(item => String(item)),
        },
        provenance: {
            runId: String(provenance.runId),
            taskRoot: String(provenance.taskRoot),
            repoRootReal: String(provenance.repoRootReal || ''),
            commonDir: String(provenance.commonDir),
            publicBase: String(provenance.publicBase),
        },
    };
}

/** 重定向回执（evolution-apply-receipt.json）：仅认真实 helper 写出的 ready 形状，
 * 且提交/根/源指纹/保留摘要必须与目标记录逐项一致（legacy 路径专用）。 */
function verifyReadyReceipt(dataDir, target) {
    let value;
    try {
        value = readPrivateJson(path.join(dataDir, 'evolution-apply-receipt.json'));
    } catch {
        return 'receipt_not_ready';
    }
    if (!value || typeof value !== 'object' || value.phase !== 'ready') return 'receipt_not_ready';
    if (String(value.expectedHead || '') !== target.commit
        || String(value.runtimeRoot || '') !== target.runtimeRoot
        || String(value.sourceFingerprint || '') !== target.sourceFingerprint
        || String(value.holdDigest || '') !== target.holdDigest) return 'receipt_mismatch';
    return null;
}

/** 当前全局验证记录必须「实际通过且指纹就是这份源内容」（legacy/pending 自举共
 * 用）。证书路径不读它——下一轮研究合法替换/失败不该封死已接受运行时。 */
function assertCurrentValidationMatches(dataDir, sourceFingerprint) {
    const validation = getValidationSummary(dataDir);
    if (validation.state !== 'passed') {
        throw reasonError('validation_not_passed');
    }
    if (validation.fingerprint !== sourceFingerprint) {
        throw reasonError('validation_fingerprint_mismatch');
    }
    if (validation.checks.join(',') !== 'backend,frontend') {
        throw reasonError('validation_checks_insufficient');
    }
}

/** 目录路径的每个已存在组件都不得是符号链接（evolution-publish.workspaceChildPath
 * 同式）；目标根边界被符号链接穿透即拒绝。 */
function assertNoSymlinkComponents(fromRoot, toPath) {
    const relative = path.relative(fromRoot, toPath);
    let current = fromRoot;
    for (const part of relative.split(path.sep)) {
        current = path.join(current, part);
        let stat;
        try {
            stat = fs.lstatSync(current);
        } catch {
            continue; // 尚不存在的尾组件由存在性检查兜底
        }
        if (stat.isSymbolicLink()) throw reasonError('target_symlink_component');
    }
}

/** 已指纹证实的目标侧 publish 服务：保留物核验用目标自己的受信实现，不依赖原库
 * （旧检出可能没有 evolution-publish.js）。 */
function loadTargetPublishService(targetReal) {
    const file = path.join(targetReal, 'core', 'src', 'services', 'evolution-publish.js');
    try {
        if (!fs.statSync(file).isFile()) throw new Error('not_file');
        const publish = require(file);
        if (typeof publish?.readHoldManifest !== 'function'
            || typeof publish?.holdDigest !== 'function'
            || typeof publish?.verifyHoldUnchanged !== 'function') throw new Error('missing_exports');
        return publish;
    } catch {
        throw reasonError('publish_service_unprovable');
    }
}

/** 不可变源身份实测：真实 HEAD === 记录提交、porcelain 原始输出判空（不 trim）、
 * 完整内容+权限指纹（logicSnapshot）等于记录值。任何「曾经接受过」都不能跳过。 */
function verifyRootIdentity(root, target) {
    if (String(gitText(root, ['rev-parse', 'HEAD'])).trim() !== target.commit) {
        throw reasonError('target_head_mismatch');
    }
    if (gitText(root, ['status', '--porcelain', '-z', '--untracked-files=normal']) !== '') {
        throw reasonError('runtime_not_clean');
    }
    const fingerprint = logicSnapshot(root).fingerprint;
    if (!SHA64_RE.test(fingerprint) || fingerprint !== target.sourceFingerprint) {
        throw reasonError('source_fingerprint_mismatch');
    }
}

/** 证书内验收时溯源快照的完整性：属主根派生的 run 命名空间精确形态 + 同库
 * common-dir + publicBase → 已接受提交血缘（对象库共享，任务区被收尾清理后仍可
 * 证明）。不要求「当前可变的全局任务」仍是已接受的那个——历史任务可以漂移到更新
 * 候选或最终被清理，那不是撤销已验收运行时的理由。 */
function verifyCertifiedProvenance(ownerRoot, commonDir, targetReal, target, provenance) {
    if (realpathOrNull(provenance.repoRootReal) !== ownerRoot) throw reasonError('provenance_unprovable');
    const expectedTask = path.resolve(ownerRoot, WORKSPACE_DIR_NAME, target.runId, 'task');
    if (path.resolve(provenance.taskRoot) !== expectedTask) throw reasonError('provenance_unprovable');
    if (path.resolve(provenance.commonDir) !== commonDir) throw reasonError('provenance_unprovable');
    let stat;
    try {
        stat = fs.lstatSync(provenance.taskRoot);
    } catch {
        stat = null; // 历史任务区已被受信收尾清理：血缘改由共享对象库证明
    }
    if (stat) {
        if (!stat.isDirectory()) throw reasonError('provenance_unprovable');
        if (realCommonDir(fs.realpathSync(provenance.taskRoot)) !== commonDir) {
            throw reasonError('provenance_unprovable');
        }
    }
    try {
        gitText(targetReal, ['merge-base', '--is-ancestor', provenance.publicBase, target.commit]);
    } catch {
        throw reasonError('provenance_unprovable');
    }
}

/**
 * 解析启动路由（纯判定，不 spawn）：
 * - ordinary：无管理目标 / 已接受运行时自身自举（当前实际仓库根 == 证书运行时根，
 *   实测身份后不再重生，绝不循环）/ helper 正在应用的 pending 运行时自举（实测
 *   身份 + 当前全局验证匹配，helper 才可能到达 ready）/ 显式旁路。
 * - dispatch：全部证明通过后的重定向参数（真实子进程目标 argv/cwd/共享 dataDir）。
 * - refuse：目标存在但任一证明失败（固定 reason，不携带本机路径）。
 */
function resolveApprovedRuntimeRouting(options) {
    try {
        return resolveRoutingStrict(options);
    } catch (error) {
        return { action: 'refuse', reason: error?.reason || 'routing_unprovable' };
    }
}

function resolveRoutingStrict(options) {
    const repoRoot = fs.realpathSync(path.resolve(options.repoRoot));
    // 解析 dataDir：显式 FARM_DATA_DIR（可能尚不存在=首次自举）或源 core/data。
    let dataDir;
    if (options.env?.FARM_DATA_DIR) {
        dataDir = path.resolve(String(options.env.FARM_DATA_DIR));
    } else {
        try {
            dataDir = fs.realpathSync(path.join(repoRoot, 'core', 'data'));
        } catch (error) {
            if (error.code !== 'ENOENT') throw reasonError('data_dir_unprovable');
            return { action: 'ordinary', reason: 'no_apply_target' };
        }
    }
    const certificate = readApprovedCertificate(dataDir);
    const pending = readApplyTargetRecord(dataDir);

    // 同根自举守卫（先于完整目标链，防无限重生）：都必须实测不可变源身份。
    if (certificate && realpathOrNull(certificate.target.runtimeRoot) === repoRoot) {
        verifyRootIdentity(repoRoot, certificate.target);
        return { action: 'ordinary', reason: 'selected_runtime_bootstrap' };
    }
    if (pending && realpathOrNull(pending.runtimeRoot) === repoRoot) {
        verifyRootIdentity(repoRoot, pending);
        assertCurrentValidationMatches(dataDir, pending.sourceFingerprint);
        return { action: 'ordinary', reason: 'pending_runtime_bootstrap' };
    }

    // 冷启动选择：最后一次真实 ready（证书）优先；最新 apply-target 可能指向尚未
    // 应用的更新候选，绝不提前执行。证书从未存在才走 legacy（ready 回执 + 仍然
    // 匹配的全局通过证据）。
    let target;
    let mode;
    if (certificate) {
        target = certificate.target;
        mode = 'certified';
    } else if (pending) {
        target = pending;
        mode = 'legacy';
    } else {
        return { action: 'ordinary', reason: 'no_apply_target' };
    }

    // —— 以下全部证明先于任何目标代码加载 ——
    // 1) 属主根：从当前检出的真实 common .git 派生（worktree 共库即可）。
    const commonDir = realCommonDir(repoRoot);
    if (path.basename(commonDir) !== '.git') {
        throw reasonError('owner_root_unprovable');
    }
    const ownerRoot = path.dirname(commonDir);
    // 2) 精确生成边界：<属主根>/tmp/evolution-workspaces/<有效 runId>/runtime-<commit12>。
    const expectedRoot = path.resolve(ownerRoot, WORKSPACE_DIR_NAME, target.runId,
        `runtime-${target.commit.slice(0, 12)}`);
    if (path.resolve(target.runtimeRoot) !== expectedRoot) {
        throw reasonError('target_outside_owner_boundary');
    }
    assertNoSymlinkComponents(ownerRoot, expectedRoot);
    // 3) 目标真实存在、同库（common-dir 一致，外库同形目录拒绝）。
    let targetReal;
    try {
        targetReal = fs.realpathSync(expectedRoot);
        if (!fs.statSync(targetReal).isDirectory()) throw new Error('not_dir');
    } catch {
        throw reasonError('target_missing');
    }
    if (realCommonDir(targetReal) !== commonDir) {
        throw reasonError('target_repo_mismatch');
    }
    // 4) 不可变源身份：真实 HEAD / 干净 / 完整内容+权限指纹（两种路径同强度）。
    verifyRootIdentity(targetReal, target);

    // 5) 应用证据：证书内嵌验收时验证摘要（schema 已核状态/项别，这里核指纹即本
    //    源内容）；legacy 则要求当前全局验证仍通过且指纹匹配 + 真实 ready 回执。
    if (mode === 'certified') {
        if (certificate.validation.fingerprint !== target.sourceFingerprint) {
            throw reasonError('validation_fingerprint_mismatch');
        }
    } else {
        assertCurrentValidationMatches(dataDir, target.sourceFingerprint);
        const receiptReason = verifyReadyReceipt(dataDir, target);
        if (receiptReason) throw reasonError(receiptReason);
    }

    // 6) 审批证据判等完成后才加载目标代码，随后核对当前保留物。
    const publish = loadTargetPublishService(targetReal);
    const manifest = publish.readHoldManifest(dataDir);
    if (!manifest || publish.holdDigest(manifest) !== target.holdDigest
        || publish.verifyHoldUnchanged(manifest.repoRootReal, manifest).ok !== true) {
        throw reasonError('hold_unprovable');
    }

    // 7) 溯源：证书路径核验收时快照的命名空间/同库/血缘（当前任务可漂移/已清理）；
    //    legacy 路径继续用当前全局任务区对照受信提交。
    if (mode === 'certified') {
        verifyCertifiedProvenance(ownerRoot, commonDir, targetReal, target, certificate.provenance);
    } else {
        const provenance = publish.readProvenance(dataDir);
        if (!provenance || typeof publish.verifyTaskWorkspace !== 'function'
            || publish.verifyTaskWorkspace(ownerRoot, provenance, { expectedHead: target.commit }).ok !== true) {
            throw reasonError('provenance_unprovable');
        }
    }

    // 真实目标入口与 core cwd（映射后的子进程 argv/cwd 均落在目标根内）。
    const targetEntry = path.join(targetReal, 'core', 'client.js');
    const targetCwd = path.join(targetReal, 'core');
    try {
        if (!fs.statSync(targetEntry).isFile()) throw new Error('not_file');
        if (!fs.statSync(targetCwd).isDirectory()) throw new Error('not_dir');
    } catch {
        throw reasonError('target_entry_missing');
    }
    return { action: 'dispatch', targetRoot: targetReal, targetEntry, targetCwd, dataDir, commit: target.commit };
}

function exitCodeForChild(child) {
    if (typeof child.status === 'number') return child.status;
    if (child.signal && SIGNAL_NUMBERS[child.signal]) return 128 + SIGNAL_NUMBERS[child.signal];
    return 1;
}

/**
 * client.js 最早入口（先于 secureRuntimeDataTree 与任何业务 import）：
 * - 旁路（worker/抓包/打包可执行）不读取任何外部记录，保持既有入口语义；
 * - ordinary 直接返回 false 交普通自举；
 * - refuse 明确失败退出（固定 reason，不携带本机路径）；
 * - dispatch 用真实 process.execPath 子进程切换到目标入口/cwd/共享 dataDir，
 *   继承 execArgv/用户参数/环境与标准三流，精确传播退出码/信号；本包装进程
 *   绝不在 dispatch 后继续 import 旧业务模块（spawnSync 后即 exit）。
 */
function routeApprovedRuntime(proc = process, options = {}) {
    if (proc.env.FARM_WORKER === '1') return false;
    if (proc.argv.includes('--capture') || proc.env.FARM_CAPTURE_SERVER === '1') return false;
    if (proc.pkg) return false; // 打包可执行保持既有入口语义，不消费外部记录
    // 本模块位于 <仓库根>/core/src/runtime/：仓库根是三级上层。
    const repoRoot = options.repoRoot || path.resolve(__dirname, '..', '..', '..');
    const routing = resolveApprovedRuntimeRouting({ repoRoot, env: proc.env });
    if (routing.action === 'ordinary') return false;
    if (routing.action === 'refuse') {
        proc.stderr.write(`[approved-runtime] refusing to start unproven target: ${routing.reason}\n`);
        proc.exit(1);
        return false;
    }
    const child = spawnSync(proc.execPath, [...proc.execArgv, routing.targetEntry, ...proc.argv.slice(2)], {
        cwd: routing.targetCwd,
        env: { ...proc.env, FARM_DATA_DIR: routing.dataDir },
        argv0: proc.argv0,
        stdio: 'inherit',
    });
    if (child.error) {
        proc.stderr.write('[approved-runtime] target dispatch failed\n');
        proc.exit(1);
        return false;
    }
    proc.exit(exitCodeForChild(child));
    return false;
}

module.exports = { resolveApprovedRuntimeRouting, routeApprovedRuntime };
