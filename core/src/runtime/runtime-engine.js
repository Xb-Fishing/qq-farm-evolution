const { fork } = require('node:child_process');
const path = require('node:path');
const process = require('node:process');
const { Worker } = require('node:worker_threads');
const store = require('../models/store');
const { updateRuntimeConfig } = require('../config/config');
const { sendPushooMessage, sendSmtpEmail } = require('../services/push');
const { MiniProgramLoginSession } = require('../services/qrlogin');
const { createAutoCodeRefreshService } = require('./auto-code-refresh');
const { createDataProvider } = require('./data-provider');
const { createReloginReminderService } = require('./relogin-reminder');
const { createRuntimeState } = require('./runtime-state');
const { createWorkerManager } = require('./worker-manager');
const { getSharedWxLoginReminder } = require('../services/wx-login-reminder');
const { bindRescanProvider } = require('../services/wx-rescan-save');

/**
 * 自助扫码恢复排程的 reason 包装。auto-code-refresh.isRecoveryReason 只认
 * 既有前缀（ws_400 / kickout: / ws_reconnect_failed: / refresh_failed）：
 * 裸传 code_temporary/start_refused 等阶段码会被当普通原因，performCodeRefresh
 * 拿到 recovery=null——不计每日 5 次、不计连续失败 3 次，失败后排程永远循环。
 * 这里把阶段码包装成已识别的 refresh_failed:rescan:<stage>，只改接线，
 * 不动分类器、预算与节奏。
 */
function wrapRescanRecoveryReason(reason) {
    const stage = String(reason || '').trim() || 'recovery';
    return `refresh_failed:rescan:${stage}`;
}

/**
 * Worker 连接态同步时的检查点收口（仅自动恢复路径的兜底；手动完成/显式
 * 重试的收口走保存链自己的守卫，不经过这里）。
 *
 * 不能见到 connected=true 就清「授权已保存/登录未收口」检查点：在线扫码
 * 保存新授权、旧 Code 已作废但新 Code 还没换成功时，仍在跑的旧 Worker 会
 * 继续上报 connected=true。必须同时满足才收口：
 *  - 新农场 Code 已落盘（account.code 非空）；
 *  - 当前连接来自检查点写入之后才启动的 Worker（startedAt 严格晚于
 *    checkpoint.savedAt——自动恢复排程至少 1 分钟后才触发，新 Worker 必然
 *    更晚，严格 > 不影响正常收口），且该 Worker 不在停止中；
 *  - 传给 noteScanCodeResolved 的是捕获时的代次/属主/wxid + 临界区守卫
 *    （守卫复验提交瞬间仍是同一条 Worker）：注册表排队期间出现更新扫码
 *    时由代次/绑定在临界区内拒收，绝不用执行时的最新检查点替换旧期望。
 */
function settleScanCheckpointOnConnect({ reminder, workers, getAccounts, accountId, status }) {
    try {
        const id = String(accountId || '');
        if (!id || !reminder || typeof reminder.getScanCheckpoint !== 'function'
            || typeof reminder.noteScanCodeResolved !== 'function') return null;
        if (!status || !status.connection || status.connection.connected !== true) return null;
        const checkpoint = reminder.getScanCheckpoint(id);
        if (!checkpoint) return null;
        const data = typeof getAccounts === 'function' ? getAccounts() : null;
        const account = data && Array.isArray(data.accounts)
            ? data.accounts.find(acc => String(acc && acc.id) === id) : null;
        const code = String(account && account.code || '');
        const owner = String(account && account.username || '').trim();
        const wxid = String(account && account.wxid || '');
        if (!code || !owner || !wxid) return null;
        const worker = workers ? workers[id] : null;
        if (!worker || worker.stopping === true) return null;
        // 旧 Worker（检查点写入前已启动）的连接消息不清检查点。
        if (!((Number(worker.startedAt) || 0) > Number(checkpoint.savedAt))) return null;
        const capturedWorker = worker;
        const settled = reminder.noteScanCodeResolved(id, {
            generation: checkpoint.generation,
            owner,
            wxid,
            // connected:true 只在此可信 runtime 接线传：这轮的内存 pending 也
            // 一并收口为 saved（清失败 detail），自动恢复后页面不再留可重试
            // 入口（否则用户再点会多换一次 Code、重启健康农场）。
            connected: true,
            guard: () => workers[id] === capturedWorker && capturedWorker.stopping !== true,
        });
        return settled && typeof settled.catch === 'function' ? settled.catch(() => {}) : settled;
    } catch {
        return null; // 状态收口失败不影响运行
    }
}

/** 操作类型键列表 */
const OPERATION_KEYS = [
    'harvest', 'water', 'weed', 'bug', 'farming', 'fertilize', 'plant',
    'steal', 'helpWater', 'helpWeed', 'helpBug',
    'taskClaim', 'sell', 'upgrade', 'tongQiGift'
];

/**
 * 创建运行时引擎
 * @param {object} options
 * @param {object} options.processRef - process 引用
 * @param {string} options.mainEntryPath - 主入口文件路径
 * @param {string} options.workerScriptPath - Worker 脚本路径
 * @param {string} options.runtimeMode - 运行模式 'thread' | 'fork'
 * @param {Function} options.onStatusSync - 状态同步回调
 * @param {Function} options.onLog - 日志回调
 * @param {Function} options.onAccountLog - 账号日志回调
 * @param {Function} options.startAdminServer - 启动管理服务器回调
 */
function createRuntimeEngine(options = {}) {
    const processRef = options.processRef || process;
    const mainEntryPath = options.mainEntryPath || path.join(__dirname, '../../client.js');
    const workerScriptPath = options.workerScriptPath || path.join(__dirname, '../core/worker.js');
    const runtimeMode = String(options.runtimeMode || processRef.env.FARM_RUNTIME_MODE || 'thread').toLowerCase();
    const onStatusSync = typeof options.onStatusSync === 'function' ? options.onStatusSync : null;
    const onLog = typeof options.onLog === 'function' ? options.onLog : null;
    const onAccountLog = typeof options.onAccountLog === 'function' ? options.onAccountLog : null;
    const startAdminServer = typeof options.startAdminServer === 'function' ? options.startAdminServer : null;

    // Worker 启动/重启的引用占位
    const engine = { startWorker: null, restartWorker: null };

    // 创建运行时状态
    const runtimeState = createRuntimeState({
        store,
        operationKeys: OPERATION_KEYS
    });

    const {
        workers,
        globalLogs,
        accountLogs,
        runtimeEvents,
        nextConfigRevision,
        buildConfigSnapshotForAccount,
        log,
        addAccountLog,
        normalizeStatusForPanel,
        buildDefaultStatus,
        filterLogs
    } = runtimeState;

    // 创建重登提醒服务
    const reloginReminder = createReloginReminderService({
        store,
        miniProgramLoginSession: MiniProgramLoginSession,
        sendPushooMessage,
        sendSmtpEmail,
        log,
        addAccountLog,
        getAccounts: store.getAccounts,
        addOrUpdateAccount: store.addOrUpdateAccount,
        resolveWorkerControls: () => engine,
        // 微信失效已由 Bark 重扫提醒认领时，不再叠加通用下线推送。
        shouldSkipOfflineReminder: ({ accountId }) =>
            getSharedWxLoginReminder().shouldSuppressOfflineReminder(accountId) === true
    });
    const { getOfflineAutoDeleteMs, triggerOfflineReminder } = reloginReminder;

    const autoCodeRefresh = createAutoCodeRefreshService({
        store,
        getAccounts: store.getAccounts,
        addOrUpdateAccount: store.addOrUpdateAccount,
        resolveWorkerControls: () => engine,
        log,
        addAccountLog,
        // 仅微信账号凭据被服务端判定明确失效时通知一次；回调内部自带
        // 平台过滤与去重，异常不影响保活/错误预算。
        onWxCredentialDefinitivelyInvalid: (accountId) =>
            getSharedWxLoginReminder().noteCredentialInvalid(accountId)
    });

    // 创建 Worker 管理器
    const {
        startWorker,
        stopWorker,
        restartWorker,
        callWorkerApi
    } = createWorkerManager({
        fork,
        WorkerThread: Worker,
        runtimeMode,
        processRef,
        mainEntryPath,
        workerScriptPath,
        workers,
        globalLogs,
        store,
        log,
        addAccountLog,
        normalizeStatusForPanel,
        buildConfigSnapshotForAccount,
        getOfflineAutoDeleteMs,
        triggerOfflineReminder,
        addOrUpdateAccount: store.addOrUpdateAccount,
        getAccounts: store.getAccounts,
        deleteAccount: store.deleteAccount,
        scheduleAutoRelogin: autoCodeRefresh.scheduleRelogin,
        scheduleKickoutRelogin: autoCodeRefresh.scheduleKickoutRelogin,
        scheduleAccountRefresh: autoCodeRefresh.scheduleAccount,
        stopAccountRefresh: autoCodeRefresh.stopAccount,
        refreshAccountCode: autoCodeRefresh.refreshAccountCode,
        updateSystemClientVersion: (clientVersion) => {
            const value = String(clientVersion || '').trim();
            const current = store.getSystemConfig() || store.DEFAULT_SYSTEM_CONFIG || {};
            if (!value || current.clientVersion === value) return false;
            const saved = store.setSystemConfig({ ...current, clientVersion: value });
            if (saved) updateRuntimeConfig(saved);
            return !!saved;
        },
        onStatusSync: (accountId, status, accountName) => {
            runtimeEvents.emit('status', { accountId, status, accountName });
            // Worker 真正连上 = 登录已收口：解掉该账号的「授权已保存/登录未
            // 收口」持久检查点（覆盖自动恢复排程成功上线的路径——那条路径
            // 不经过完成链自己的收口调用）。必须过 settleScanCheckpointOnConnect
            // 的时间门与绑定门：旧 Worker 的 connected、空 Code、排队期间的
            // 旧事件都不得清新扫码的检查点。只清检查点，不触碰扫码会话。
            settleScanCheckpointOnConnect({
                reminder: getSharedWxLoginReminder(),
                workers,
                getAccounts: store.getAccounts,
                accountId,
                status,
            });
            if (onStatusSync) onStatusSync(accountId, status, accountName);
        },
        onWorkerLog: (entry, accountId, accountName) => {
            runtimeEvents.emit('worker_log', { entry, accountId, accountName });
            if (onLog) onLog(entry, accountId, accountName);
        }
    });

    engine.startWorker = startWorker;
    engine.restartWorker = restartWorker;

    // 创建数据提供器
    const dataProviderDeps = {
        workers,
        globalLogs,
        accountLogs,
        store,
        getAccounts: store.getAccounts,
        callWorkerApi,
        buildDefaultStatus,
        normalizeStatusForPanel,
        filterLogs,
        addAccountLog,
        nextConfigRevision,
        broadcastConfigToWorkers,
        startWorker,
        stopWorker,
        restartWorker,
        scheduleAutoCodeRefresh: autoCodeRefresh.scheduleAccount,
        stopAutoCodeRefresh: autoCodeRefresh.stopAccount,
        refreshAccountCode: autoCodeRefresh.refreshAccountCode,
        // 自助扫码恢复排程：沿既有 scheduleRelogin 预算/节奏（只接线）。
        // 阶段码必须包装成 isRecoveryReason 已识别的 refresh_failed:rescan:
        // 前缀，否则 performCodeRefresh 不计每日/连续失败预算，永远循环。
        scheduleRescanRecovery: (accountId, reason) =>
            autoCodeRefresh.scheduleRelogin(accountId, wrapRescanRecoveryReason(reason)),
        needsWxRescan: (id) => getSharedWxLoginReminder().needsRescan(id)
    };
    const dataProvider = createDataProvider(dataProviderDeps);
    // 服务端守望的扫码保存复用与面板相同的账号运行时动作。
    bindRescanProvider(dataProvider);

    // 绑定全局日志事件
    runtimeEvents.on('log', (entry) => {
        if (onLog) {
            onLog(
                entry,
                entry && entry.accountId ? entry.accountId : '',
                entry && entry.accountName ? entry.accountName : ''
            );
        }
    });

    runtimeEvents.on('account_log', (entry) => {
        if (onAccountLog) onAccountLog(entry);
        // 「已在其他终端登录」踢下线：作为用户手机进场的参考信号记录（维护
        // 计划前置条件）。绑定快照在调用内同步捕获；异步落盘失败静默放弃，
        // 不影响踢下线/接管主流程，也不代表能检测到全部手机进场。
        if (entry && entry.action === 'kickout_stop'
            && String(entry.reason || '').trim() === '已在其他终端登录') {
            try {
                const recorded = getSharedWxLoginReminder().noteOtherTerminalLogin(entry.accountId);
                if (recorded && typeof recorded.catch === 'function') recorded.catch(() => {});
            } catch { /* 记录失败不影响账号日志 */ }
        }
    });

    /** 广播配置到所有/指定 Worker */
    function broadcastConfigToWorkers(accountId = '') {
        const targetId = String(accountId || '').trim();
        for (const [id, worker] of Object.entries(workers)) {
            if (targetId && String(id) !== targetId) continue;
            const config = buildConfigSnapshotForAccount(id);
            try {
                worker.process.send({ type: 'config_sync', config });
            } catch { }
        }
    }

    // ── 启动期「人工扫码已确认但登录未收口」的恢复判定（fresh Code before Worker）──
    // startup 原生换码临时失败后：回退判定一律读规范最新账号态 + 持久扫码
    // 检查点，绝不拿 await 前快照里的旧一次性 Code/空 Code 拉 Worker。
    const startupRecoveryIds = new Set();

    function resolveStartupWxRecovery(accountId) {
        const latest = (store.getAccounts().accounts || [])
            .find(item => String(item && item.id) === String(accountId)) || null;
        // await 期间被暂停/删除：不启动、不排程（不借启动迁移重开暂停账号）。
        if (!latest || !store.isAccountAutoLogin(latest)) return null;
        let checkpoint = null;
        try {
            checkpoint = getSharedWxLoginReminder().getScanCheckpoint(String(accountId));
        } catch { checkpoint = null; }
        // 无待收口检查点且旧 Code 仍在：保留既有受控回退（临时网络失败）。
        if (!checkpoint && String(latest.code || '')) return { fallback: latest };
        // 检查点在（授权已保存、换码/启动未收口）或当前无有效 Code：
        // 不得回退旧码/空码，交给自动恢复排程收口。
        return { recover: latest };
    }

    /** 挂启动恢复排程并记录：engine.start 的 rescheduleAll 之后需重挂（见 start）。 */
    function armStartupWxRecovery(accountId) {
        const id = String(accountId);
        if (!autoCodeRefresh.scheduleRelogin(id, wrapRescanRecoveryReason('startup'))) return false;
        startupRecoveryIds.add(id);
        return true;
    }

    /** 启动所有账号 */
    async function startAllAccounts() {
        const accounts = store.getAccounts().accounts || [];
        if (accounts.length > 0) {
            log('系统', `发现 ${  accounts.length  } 个账号，正在启动...`);
            for (const acc of accounts) {
                // 为移植前已扫码保存凭证的微信账号执行一次默认策略迁移。
                if (acc.platform === 'wx' && acc.loginBuffer && acc.wxDefaultsApplied !== true) {
                    const currentRefresh = store.getAutoCodeRefresh(acc.id);
                    store.setAutoCodeRefresh(acc.id, {
                        enabled: true,
                        intervalMinutes: currentRefresh.intervalMinutes || 60
                    });
                    store.addOrUpdateAccount({ id: acc.id, wxDefaultsApplied: true });
                    acc.wxDefaultsApplied = true;
                    log('系统', `已为微信扫码账号 ${acc.name} 默认开启断线自动恢复`, {
                        accountId: String(acc.id), accountName: acc.name
                    });
                }
                if (!store.isAccountAutoLogin(acc)) {
                    log('系统', `账号 ${acc.name} 已设为不登录，跳过启动`, {
                        accountId: String(acc.id), accountName: acc.name
                    });
                    continue;
                }
                if (acc.platform === 'wx' && acc.loginBuffer) {
                    const refreshed = await autoCodeRefresh.refreshAccountCode(acc.id, 'startup');
                    // 明确的 OAuth 授权失效不能拿旧 Code 启动 Worker；否则
                    // Worker 会立即收到 400，再次进入普通重登排程。
                    const credentialBlocked = typeof autoCodeRefresh.isCredentialBlocked === 'function'
                        && autoCodeRefresh.isCredentialBlocked(acc.id);
                    if (!refreshed && !credentialBlocked) {
                        const decision = resolveStartupWxRecovery(acc.id);
                        if (decision && decision.fallback) {
                            startWorker(decision.fallback);
                        } else if (decision) {
                            // 沿既有自动恢复排程收口（原间隔 + 每日 5 次/连续
                            // 失败 3 次预算；熔断/失败后仍保留用户显式重试入口）。
                            armStartupWxRecovery(acc.id);
                        }
                        // decision === null：await 期间已暂停/删除，不启动不排程。
                    }
                } else {
                    startWorker(acc);
                }
            }
        } else {
            log('系统', '未发现账号，请访问管理面板添加账号');
        }
    }

    /** 引擎启动入口 */
    async function start(startOpts = {}) {
        const shouldStartAdmin = startOpts.startAdminServer !== false;
        const shouldAutoStart = startOpts.autoStartAccounts !== false;

        // 加载系统配置
        const sysConfig = store.getSystemConfig();
        if (sysConfig) {
            updateRuntimeConfig(sysConfig);
            log('系统', `已加载系统配置: serverUrl=${  sysConfig.serverUrl
                 }, clientVersion=${  sysConfig.clientVersion
                 }, platform=${  sysConfig.platform}`);
        }

        if (shouldStartAdmin && startAdminServer) {
            startAdminServer(dataProvider);
        }

        if (shouldAutoStart) {
            await startAllAccounts();
        }
        autoCodeRefresh.rescheduleAll();
        // rescheduleAll 的 clearAll 会顺手清掉启动期刚挂的 relogin 恢复任务：
        // 对记录在册的账号按当前真实状态（暂停/删除/检查点/Code/阻断）复核后
        // 重挂。重挂只重建被清掉的同一任务，不额外消耗每日/连续失败预算
        // （attempts 仅在真正换码时递增），也不把已能受控回退的账号再排程。
        for (const id of Array.from(startupRecoveryIds)) {
            startupRecoveryIds.delete(id);
            const decision = resolveStartupWxRecovery(id);
            if (decision && !decision.fallback) armStartupWxRecovery(id);
        }

        // 扫码维护参考计划的本地巡检：只读注册表与账号状态，零网络探测。
        try {
            getSharedWxLoginReminder().startMaintenanceSweep();
        } catch (error) {
            log('错误', `微信扫码维护计划巡检启动失败: ${(error && error.message) || error}`);
        }
    }

    /** 停止所有账号 */
    function stopAllAccounts() {
        try { getSharedWxLoginReminder().stopMaintenanceSweep(); } catch { /* 未启动即可 */ }
        for (const id of Object.keys(workers)) {
            stopWorker(id);
        }
    }

    return {
        store,
        runtimeEvents,
        workers,
        dataProvider,
        start,
        startAllAccounts,
        stopAllAccounts,
        broadcastConfigToWorkers,
        startWorker,
        stopWorker,
        restartWorker,
        callWorkerApi,
        log,
        addAccountLog
    };
}

module.exports = { createRuntimeEngine, wrapRescanRecoveryReason, settleScanCheckpointOnConnect };
