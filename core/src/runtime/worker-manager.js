const { createScheduler } = require('../services/scheduler');

// 萌宠业务错误元数据校验（2026-09-20 跨 Worker 丢失修复）：
// Worker 回传的 errorMeta 只接受严格布尔标记 + 限定格式固定业务码
// （与 worker.js collectPetDiaryErrorMeta 同一格式，2026-09-24 扩展
// WISH_SIGN_/HAPPY_SHARE_/SEASON_WISH_ 前缀的季节活动手动操作）；
// 缺失、畸形、超长或非标量（含 JSON/structuredClone 往返后的旧式响应）
// 一律按普通错误处理，堆栈、cause 与额外属性不透传。
const PET_DIARY_ERROR_CODE_RE = /^(?:PET_DIARY|WISH_SIGN|HAPPY_SHARE|SEASON_WISH)_[A-Z0-9_]{1,48}$/;

function normalizePetDiaryErrorMeta(meta) {
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return null;
    if (meta.business !== true) return null;
    const code = meta.code;
    if (typeof code !== 'string' || !PET_DIARY_ERROR_CODE_RE.test(code)) return null;
    return { business: true, code };
}

/**
 * 创建 Worker 管理器
 * 负责账号 Worker 进程/线程的启动、停止、重启、消息处理和 RPC 调用
 */
function createWorkerManager(deps) {
    const {
        fork,
        WorkerThread,
        runtimeMode = 'thread',
        processRef,
        mainEntryPath,
        workerScriptPath,
        workers,
        globalLogs,
        log,
        addAccountLog,
        normalizeStatusForPanel,
        buildConfigSnapshotForAccount,
        getOfflineAutoDeleteMs,
        triggerOfflineReminder,
        addOrUpdateAccount,
        getAccounts,
        deleteAccount,
        scheduleAutoRelogin,
        scheduleKickoutRelogin,
        scheduleAccountRefresh,
        stopAccountRefresh,
        refreshAccountCode,
        updateSystemClientVersion,
        onStatusSync,
        onWorkerLog
    } = deps;

    const scheduler = createScheduler('worker_manager');
    const restartHistory = new Map();
    const credentialRefreshes = new Map();
    // RPC 超时定时器全局序号：worker 记录的 reqId 从 1 重置，按账号+reqId
    // 命名会在换代后重名（新请求覆盖旧定时器，旧 promise 永久悬挂）。
    let rpcTimerSeq = 0;

    /** 结算某条 Worker 记录的全部挂起 RPC 并清其计时器（记录被替换/删除前必调） */
    function settleWorkerRequests(wrk) {
        if (!wrk || !wrk.requests || wrk.requests.size === 0) return;
        for (const pending of wrk.requests.values()) {
            if (pending.timerKey) scheduler.clear(pending.timerKey);
            try { pending.reject(new Error('Worker exited')); } catch { }
        }
        wrk.requests.clear();
    }
    const WATCHDOG_PING_MS = 30000;
    const WATCHDOG_TIMEOUT_MS = 90000;
    const WATCHDOG_MAX_RESTARTS = 3;

    /** 是否支持 Thread 模式（非 pkg 打包 + Worker 可用） */
    const threadMode = runtimeMode === 'thread' && !processRef.pkg && typeof WorkerThread === 'function';

    function cleanText(value) {
        return String(value || '').trim();
    }

    function buildQqAvatarUrl(qq) {
        const value = cleanText(qq);
        if (!/^\d+$/.test(value)) return '';
        return `https://q1.qlogo.cn/g?b=qq&nk=${  value  }&s=100`;
    }

    function resolveLoginProfile(status, worker) {
        const data = status && typeof status === 'object' ? status : {};
        const info = data.status && typeof data.status === 'object' ? data.status : {};
        const platform = cleanText(info.platform || data.platform || worker.platform || 'qq').toLowerCase();
        const gid = cleanText(info.gid || data.gid);
        const openId = cleanText(info.openId || info.open_id || data.openId || data.open_id);
        const avatar = cleanText(info.avatar || info.avatarUrl || info.avatar_url || data.avatar || data.avatarUrl || data.avatar_url);
        const qq = cleanText(info.qq || info.uin || data.qq || data.uin || worker.qq || worker.uin);
        const fallbackAvatar = platform === 'qq' ? buildQqAvatarUrl(qq) : '';

        return {
            platform,
            gid,
            openId,
            qq,
            avatar: avatar || fallbackAvatar
        };
    }

    function syncAccountProfile(accountId, msgData, worker) {
        const profile = resolveLoginProfile(msgData, worker);
        const update = { id: accountId };

        if (profile.openId && worker.openId !== profile.openId) {
            update.openId = profile.openId;
        }
        if (profile.gid && worker.gid !== profile.gid) {
            update.gid = profile.gid;
        }
        if (profile.qq && worker.qq !== profile.qq) {
            update.qq = profile.qq;
            update.uin = profile.qq;
        }
        if (profile.avatar && worker.avatar !== profile.avatar) {
            update.avatar = profile.avatar;
        }

        if (Object.keys(update).length <= 1) return;

        addOrUpdateAccount(update);
        if (update.openId) worker.openId = update.openId;
        if (update.gid) worker.gid = update.gid;
        if (update.qq) {
            worker.qq = update.qq;
            worker.uin = update.uin;
        }
        if (update.avatar) worker.avatar = update.avatar;
    }

    /**
     * 创建 Thread Worker
     */
    function createThreadWorker(account) {
        const worker = new WorkerThread(workerScriptPath, {
            workerData: {
                accountId: String(account.id || ''),
                channel: 'thread'
            }
        });
        // 统一 send/kill 接口
        worker.send = (msg) => worker.postMessage(msg);
        worker.kill = () => worker.terminate();
        return worker;
    }

    /**
     * 创建 Fork Worker
     */
    function createForkWorker(account) {
        if (processRef.pkg) {
            // pkg 打包模式：fork 主入口而不是 worker 脚本
            return fork(mainEntryPath, [], {
                execPath: processRef.execPath,
                stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
                env: {
                    ...processRef.env,
                    FARM_WORKER: '1',
                    FARM_ACCOUNT_ID: String(account.id || '')
                }
            });
        }
        return fork(workerScriptPath, [], {
            stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
            env: {
                ...processRef.env,
                FARM_ACCOUNT_ID: String(account.id || '')
            }
        });
    }

    /**
     * 根据运行模式创建 Worker
     */
    function createWorker(account) {
        if (threadMode) return createThreadWorker(account);
        return createForkWorker(account);
    }

    /**
     * 启动账号 Worker
     */
    function startWorker(account) {
        if (!account || !account.id) return false;
        // 全程使用 canonical latest：restartWorker 闭包捕获的是排队重启时的
        // 快照，两轮扫码并发时旧快照会把上一轮 Code/身份元数据发给新 Worker。
        // 持久层没有该账号时保留传入快照兜底（等价于旧行为）。
        const data = typeof getAccounts === 'function' ? getAccounts() : {};
        const latest = (Array.isArray(data.accounts) ? data.accounts : [])
            .find(item => String(item.id) === String(account.id)) || account;
        if (latest.autoLogin === false) {
            log('系统', `账号 ${latest.name || account.id} 已设为不登录，跳过启动`, {
                accountId: String(account.id),
                accountName: latest.name || account.name || '',
            });
            return false;
        }
        if (workers[latest.id]) return false;

        log('系统', `正在启动账号: ${  latest.name}`, {
            accountId: String(latest.id),
            accountName: latest.name
        });

        let proc = null;
        try {
            proc = createWorker(latest);
        } catch (err) {
            const errorMsg = err && err.message ? err.message : String(err || 'unknown error');
            log('错误', `账号 ${  latest.name  } 启动失败: ${  errorMsg}`, {
                accountId: String(latest.id),
                accountName: latest.name
            });
            addAccountLog('start_failed', `账号 ${  latest.name  } 启动失败`,
                latest.id, latest.name, { reason: errorMsg });
            return false;
        }

        // 注册 Worker 记录
        workers[latest.id] = {
            process: proc,
            status: null,
            logs: [],
            requests: new Map(),
            reqId: 1,
            name: latest.name,
            username: latest.username || '',
            platform: latest.platform || 'qq',
            gid: latest.gid || '',
            openId: latest.openId || latest.open_id || '',
            qq: latest.qq || latest.uin || '',
            uin: latest.uin || latest.qq || '',
            avatar: latest.avatar || latest.avatarUrl || '',
            stopping: false,
            startedAt: Date.now(),
            disconnectedSince: 0,
            offlineReminderTriggered: false,
            autoDeleteTriggered: false,
            wsError: null,
            lastPongAt: Date.now()
        };

        // 发送启动配置（同上：用 latest 的 Code/平台，不用旧快照）
        proc.send({
            type: 'start',
            config: { code: latest.code, platform: latest.platform }
        });

        // 发送配置快照
        proc.send({
            type: 'config_sync',
            config: buildConfigSnapshotForAccount(latest.id)
        });

        // 监听 Worker 消息：旧进程迟到消息不得作用于已换代的 Worker 记录
        proc.on('message', (msg) => {
            const current = workers[latest.id];
            if (!current || current.process !== proc) return;
            handleWorkerMessage(latest.id, msg);
        });

        // 监听 Worker 错误
        proc.on('error', (err) => {
            log('系统', `账号 ${  latest.name  } 子进程启动失败: ${
                err && err.message ? err.message : err}`, {
                accountId: String(latest.id),
                accountName: latest.name
            });
        });

        // 监听 Worker 退出
        proc.on('exit', (code, signal) => {
            const wrk = workers[latest.id];
            const displayName = wrk && wrk.name ? wrk.name : latest.name;
            // 同代次守卫：wrk 已是新进程时，本进程不得动新代次的任何状态
            const sameGeneration = !!wrk && wrk.process === proc;

            log('系统', `账号 ${  displayName  } 进程退出 (code=${  code
                }, signal=${  signal || 'none'  })`, {
                accountId: String(latest.id),
                accountName: displayName,
                runtimeMode: threadMode ? 'thread' : 'fork'
            });

            // force_kill/restart_fallback 按账号命名：只有本代次还持有
            // workers 记录时才清理，否则旧 exit 会取消新 Worker 已挂的
            // 强杀/重启回退定时器，下一轮重启可能永远完不成。
            if (sameGeneration) {
                scheduler.clear(`force_kill_${  latest.id}`);
                scheduler.clear(`restart_fallback_${  latest.id}`);
            }

            // 清理所有未完成的 API 请求：只清本进程的。若退出事件晚于新
            // Worker 注册（force_kill 与 restart_fallback 竞态），这里的
            // workers[latest.id] 已是新 Worker，绝不能替它拒绝请求。
            if (sameGeneration) settleWorkerRequests(wrk);

            if (sameGeneration) {
                delete workers[latest.id];
            }
        });

        // 每次启动/重启后重新武装微信凭据保活。stopWorker 会清理旧任务，
        // 因此必须由新 Worker 生命周期重新建立，避免重启一次后保活永久消失。
        if (typeof scheduleAccountRefresh === 'function') scheduleAccountRefresh(latest.id);

        return true;
    }

    /**
     * 停止账号 Worker
     */
    function stopWorker(accountId) {
        const wrk = workers[accountId];
        if (!wrk) return;

        const targetProc = wrk.process;
        wrk.stopping = true;

        // 停就停干净：清掉该账号的自动刷新/凭证保活/接管倒计时，
        // 避免停止后定时器把账号自动拉起来影响后续操作
        if (typeof stopAccountRefresh === 'function') stopAccountRefresh(accountId);

        // 发送停止指令
        wrk.process.send({ type: 'stop' });

        // 1 秒后强制杀死
        scheduler.setTimeoutTask(`force_kill_${  accountId}`, 1000, () => {
            const current = workers[accountId];
            if (current && current.process === targetProc) {
                current.process.kill();
                // 记录即将删除而旧 proc 的 exit 可能迟到（甚至已被新记录
                // 顶替后才会触发守卫跳过），必须在这里结算旧 RPC，否则
                // 旧 promise 只能等早已被同名新任务覆盖的超时定时器。
                settleWorkerRequests(current);
                // kill 可能同步触发 exit → doRestart 已注册新 Worker：删除前
                // 重查记录仍是本代次，否则会把新记录一起删掉
                if (workers[accountId] === current) delete workers[accountId];
            }
        });
    }

    /**
     * 重启账号 Worker
     */
    function restartWorker(account) {
        if (!account) return;
        const accountId = account.id;
        const wrk = workers[accountId];

        // 如果未运行，直接启动
        if (!wrk) return startWorker(account);

        const targetProc = wrk.process;
        let restarted = false;

        const doRestart = () => {
            if (restarted) return;
            restarted = true;
            const current = workers[accountId];
            // 只有当前记录仍是本代次（或已无记录）时才清 restart_fallback，
            // 避免另一个旧重启回调取消新代次已挂的同名定时器
            if (!current || current.process === targetProc) {
                scheduler.clear(`restart_fallback_${  accountId}`);
            }
            if (!current) return startWorker(account);
            if (current.process !== targetProc) return;

            settleWorkerRequests(current);
            delete workers[accountId];
            startWorker(account);
        };

        const forceKill = () => {
            const current = workers[accountId];
            if (!current || current.process !== targetProc) return false;
            try { current.process.kill(); } catch { }
            settleWorkerRequests(current);
            // kill 同步 exit 可能让 doRestart 先注册新 Worker：删除前重查
            if (workers[accountId] === current) delete workers[accountId];
            return true;
        };

        // 如果进程已退出，直接重启
        if (typeof targetProc.exitCode === 'number' || targetProc.signalCode) {
            return doRestart();
        }

        // 先尝试正常停止，再等待退出事件
        targetProc.once('exit', doRestart);
        stopWorker(accountId);

        // 1500ms 超时回退
        scheduler.setTimeoutTask(`restart_fallback_${  accountId}`, 1500, () => {
            if (restarted) return;
            forceKill();
            doRestart();
        });
    }

    /**
     * 处理 Worker 消息
     */
    function handleWorkerMessage(accountId, msg) {
        const wrk = workers[accountId];
        if (!wrk) return;

        if (msg.type === 'status_sync') {
            // 状态同步
            wrk.status = normalizeStatusForPanel(msg.data, accountId, wrk.name);
            if (typeof onStatusSync === 'function') {
                onStatusSync(accountId, wrk.status, wrk.name);
            }

            syncAccountProfile(accountId, msg.data, wrk);

            // 同步昵称
            if (msg.data && msg.data.status && msg.data.status.name) {
                const nick = String(msg.data.status.name).trim();
                if (nick && nick !== '未知' && nick !== '未登录') {
                    if (wrk.nick !== nick) {
                        const oldNick = wrk.nick;
                        wrk.nick = nick;
                        addOrUpdateAccount({ id: accountId, nick });
                        if (oldNick !== nick) {
                            log('系统', `已同步账号昵称: ${  oldNick || 'None'  } -> ${  nick}`, {
                                accountId, accountName: wrk.name
                            });
                        }
                    }
                }
            }

            // 连接状态追踪和离线提醒
            const isConnected = !!(msg.data && msg.data.connection && msg.data.connection.connected);
            if (isConnected) {
                wrk.disconnectedSince = 0;
                wrk.offlineReminderTriggered = false;
                wrk.autoDeleteTriggered = false;
                wrk.wsError = null;
            } else if (!wrk.stopping) {
                const now = Date.now();
                if (!wrk.disconnectedSince) wrk.disconnectedSince = now;

                const offlineDuration = now - wrk.disconnectedSince;
                if (!wrk.offlineReminderTriggered && offlineDuration >= 60000) {
                    wrk.offlineReminderTriggered = true;
                    const offlineMinutes = Math.floor(offlineDuration / 60000);
                    log('系统', `账号 ${  wrk.name  } 已离线 ${  offlineMinutes  } 分钟，发送下线提醒`);

                    triggerOfflineReminder({
                        accountId,
                        accountName: wrk.name,
                        username: wrk.username,
                        reason: 'offline',
                        offlineMs: offlineDuration
                    });
                    addAccountLog('offline_reminder',
                        `账号 ${  wrk.name  } 已离线 ${  offlineMinutes  } 分钟，已发送下线提醒`,
                        accountId, wrk.name, { reason: 'offline', offlineMs: offlineDuration });
                }

                const autoDeleteMs = typeof getOfflineAutoDeleteMs === 'function'
                    ? getOfflineAutoDeleteMs(wrk.username)
                    : Infinity;
                if (!wrk.autoDeleteTriggered && offlineDuration >= autoDeleteMs) {
                    wrk.autoDeleteTriggered = true;
                    const offlineMinutes = Math.floor(offlineDuration / 60000);
                    log('系统', `账号 ${  wrk.name  } 持续离线 ${  offlineMinutes  } 分钟，自动删除账号信息`, {
                        accountId: String(accountId),
                        accountName: wrk.name
                    });
                    triggerOfflineReminder({
                        accountId,
                        accountName: wrk.name,
                        username: wrk.username,
                        reason: 'offline_timeout',
                        offlineMs: offlineDuration
                    });
                    addAccountLog('offline_delete',
                        `账号 ${  wrk.name  } 持续离线 ${  offlineMinutes  } 分钟，已自动删除`,
                        accountId, wrk.name, { reason: 'offline_timeout', offlineMs: offlineDuration });
                    stopWorker(accountId);
                    try {
                        if (typeof deleteAccount === 'function') deleteAccount(accountId);
                    } catch (err) {
                        log('错误', `删除离线账号失败: ${  err.message}`);
                    }
                }
            }
        } else if (msg.type === 'log') {
            // 日志消息
            const entry = {
                ...msg.data,
                accountId,
                accountName: wrk.name,
                ts: Date.now(),
                meta: msg.data && msg.data.meta ? msg.data.meta : {}
            };
            entry._searchText = (`${entry.msg || ''  } ${  entry.tag || '' 
                } ${  JSON.stringify(entry.meta || {})}`).toLowerCase();

            wrk.logs.push(entry);
            if (wrk.logs.length > 1000) wrk.logs.shift();

            globalLogs.push(entry);
            if (globalLogs.length > 2000) globalLogs.shift();

            if (typeof onWorkerLog === 'function') {
                onWorkerLog(entry, accountId, wrk.name);
            }
        } else if (msg.type === 'error') {
            log('错误', `账号[${  accountId  }]进程报错: ${  msg.error}`, {
                accountId: String(accountId),
                accountName: wrk.name
            });
        } else if (msg.type === 'ws_error') {
            // WebSocket 错误
            const code = Number(msg.code) || 0;
            const message = msg.message || '';
            wrk.wsError = { code, message, at: Date.now() };

            // Code 400 = 登录失效
            if (code === 400) {
                addAccountLog('ws_400', `账号 ${  wrk.name  } 登录失效，请更新 Code`,
                    accountId, wrk.name);
                if (typeof refreshAccountCode === 'function' && !credentialRefreshes.has(accountId)) {
                    const task = Promise.resolve(refreshAccountCode(accountId, 'ws_400'))
                        .then(ok => {
                            if (!ok && typeof scheduleAutoRelogin === 'function') {
                                scheduleAutoRelogin(accountId, 'ws_400_refresh_failed');
                            }
                        })
                        .finally(() => credentialRefreshes.delete(accountId));
                    credentialRefreshes.set(accountId, task);
                }
            }
        } else if (msg.type === 'watchdog_pong') {
            wrk.lastPongAt = Date.now();
        } else if (msg.type === 'account_kicked') {
            // 被踢下线
            const reason = msg.reason || '未知';
            const sessionMs = wrk.startedAt ? Date.now() - wrk.startedAt : 0;
            log('系统', `账号 ${  wrk.name  } 被踢下线，已自动停止账号`, {
                accountId: String(accountId),
                accountName: wrk.name
            });

            triggerOfflineReminder({
                accountId,
                accountName: wrk.name,
                reason: `kickout:${  reason}`,
                offlineMs: 0
            });
            addAccountLog('kickout_stop',
                `账号 ${  wrk.name  } 被踢下线，已自动停止`,
                accountId, wrk.name, { reason });

            stopWorker(accountId);
            const scheduledTakeover = typeof scheduleKickoutRelogin === 'function'
                && scheduleKickoutRelogin(accountId, `kickout:${reason}`, sessionMs);
            if (!scheduledTakeover && typeof scheduleAutoRelogin === 'function') {
                scheduleAutoRelogin(accountId, `kickout:${reason}`);
            }
        } else if (msg.type === 'ws_reconnect_failed') {
            const reason = msg.reason || '未知';
            log('系统', `账号 ${  wrk.name  } 连接多次重试失败，已自动停止账号`, {
                accountId: String(accountId),
                accountName: wrk.name
            });

            triggerOfflineReminder({
                accountId,
                accountName: wrk.name,
                reason: `ws_reconnect_failed:${  reason}`,
                offlineMs: 0
            });
            addAccountLog('ws_reconnect_failed',
                `账号 ${  wrk.name  } 连接多次重试失败，已自动停止`,
                accountId, wrk.name, { reason });

            stopWorker(accountId);
            if (typeof scheduleAutoRelogin === 'function') {
                scheduleAutoRelogin(accountId, `ws_reconnect_failed:${reason}`);
            }
        } else if (msg.type === 'client_version_update') {
            const clientVersion = cleanText(msg.clientVersion);
            if (clientVersion && typeof updateSystemClientVersion === 'function') {
                const changed = updateSystemClientVersion(clientVersion);
                if (changed) {
                    log('系统', `已根据服务端 WebSocket 回包更新游戏版本: ${clientVersion}`, {
                        accountId: String(accountId), accountName: wrk.name
                    });
                    addAccountLog('client_version_update',
                        `服务端已自动更新游戏版本: ${clientVersion}`,
                        accountId, wrk.name, { previous: cleanText(msg.previous) });
                }
            }
        } else if (msg.type === 'automation_patch') {
            const patch = msg.patch && typeof msg.patch === 'object' ? msg.patch : {};
            if ((patch.automation && typeof patch.automation === 'object')
                || patch.friendBadRetryDate !== undefined) {
                const store = require('../models/store');
                store.applyConfigSnapshot(patch, { accountId });
                const currentWrk = workers[accountId];
                if (currentWrk && currentWrk.process) {
                    currentWrk.process.send({
                        type: 'config_sync',
                        config: buildConfigSnapshotForAccount(accountId)
                    });
                }
            }
        } else if (msg.type === 'watchlist_state_sync') {
            // 重点名单暂停状态镜像（2026-10-07）：Worker 推送 → 主进程落盘。
            // 结构校验（版本/行表/有限整数版本号）失败按畸形丢弃，绝不把
            // 畸形状态写进镜像；写失败只记日志——Worker 业务路径不等落盘，
            // 镜像保留最后一份好快照，下一次状态变更重推。
            const state = msg.state && typeof msg.state === 'object' ? msg.state : null;
            if (state && state.version === 1
                && state.rows && typeof state.rows === 'object' && !Array.isArray(state.rows)
                && Number.isFinite(Number(state.consumedOpSeq))) {
                try {
                    const { writeWatchlistStateMirror } = require('../models/store');
                    // 真实保存函数吞掉磁盘异常并返回 false：false 同样按写失败
                    // 记诊断（最后好快照保留在盘上，下次状态变更重推），不抛
                    // 错、不阻断后续消息处理。
                    const saved = writeWatchlistStateMirror(accountId, state);
                    if (saved !== true) {
                        log('错误', `账号 ${  wrk.name  } 重点名单状态镜像写入失败: 保存函数返回失败`, {
                            accountId: String(accountId),
                            accountName: wrk.name
                        });
                    }
                } catch (err) {
                    log('错误', `账号 ${  wrk.name  } 重点名单状态镜像写入失败: ${  err.message}`, {
                        accountId: String(accountId),
                        accountName: wrk.name
                    });
                }
            }
        } else if (msg.type === 'api_response') {
            // API 响应
            const { id, result, error } = msg;
            const pendingRequest = wrk.requests.get(id);
            if (pendingRequest && pendingRequest.timerKey)
                scheduler.clear(pendingRequest.timerKey);

            const pending = pendingRequest;
            if (pending) {
                if (error) {
                    const err = new Error(error);
                    // 萌宠业务错误元数据还原：校验通过才恢复 business 标记与
                    // 固定 code；旧式仅含 error 字符串的响应仍是普通 Error
                    const meta = normalizePetDiaryErrorMeta(msg.errorMeta);
                    if (meta) {
                        err.business = true;
                        err.code = meta.code;
                    }
                    pending.reject(err);
                } else {
                    pending.resolve(result);
                }
                wrk.requests.delete(id);
            }
        } else if (msg.type === 'friend_blacklist_add') {
            // 好友黑名单添加
            const gid = Number(msg.gid) || 0;
            if (gid > 0) {
                const { addFriendToBlacklist } = require('../models/store');
                addFriendToBlacklist(accountId, gid);
                log('好友', `已将好友 ${  msg.friendName || `GID:${  gid}`  } 加入黑名单`, {
                    accountId: String(accountId),
                    accountName: wrk.name,
                    friendGid: gid,
                    friendName: msg.friendName,
                    reason: msg.reason
                });

                // 同步黑名单到 Worker
                const currentWrk = workers[accountId];
                if (currentWrk && currentWrk.process) {
                    currentWrk.process.send({
                        type: 'config_sync',
                        config: buildConfigSnapshotForAccount(accountId)
                    });
                }
            }
        }
    }

    function findAccount(accountId) {
        const data = typeof getAccounts === 'function' ? getAccounts() : { accounts: [] };
        return (data.accounts || []).find(account => String(account.id) === String(accountId));
    }

    scheduler.setIntervalTask('watchdog_tick', WATCHDOG_PING_MS, () => {
        const now = Date.now();
        for (const [accountId, wrk] of Object.entries(workers)) {
            if (!wrk || wrk.stopping) continue;
            if (now - Number(wrk.lastPongAt || 0) > WATCHDOG_TIMEOUT_MS) {
                const history = (restartHistory.get(accountId) || [])
                    .filter(at => now - at < 60 * 60 * 1000);
                if (history.length >= WATCHDOG_MAX_RESTARTS) {
                    wrk.stopping = true;
                    stopWorker(accountId);
                    log('错误', `账号 ${wrk.name} Worker 连续无响应，已停止自动重启`, {
                        accountId, accountName: wrk.name
                    });
                    addAccountLog('worker_watchdog_stopped',
                        `Worker 一小时内已重启 ${WATCHDOG_MAX_RESTARTS} 次，停止账号`,
                        accountId, wrk.name);
                    continue;
                }
                history.push(now);
                restartHistory.set(accountId, history);
                const account = findAccount(accountId);
                log('错误', `账号 ${wrk.name} Worker 超过 90 秒无响应，正在自动重启`, {
                    accountId, accountName: wrk.name
                });
                if (account) restartWorker(account);
                continue;
            }
            try { wrk.process.send({ type: 'watchdog_ping', at: now }); } catch { }
        }
    }, { preventOverlap: true });

    /**
     * 调用 Worker API（RPC）
     */
    function callWorkerApi(accountId, method, ...args) {
        const wrk = workers[accountId];
        if (!wrk) return Promise.reject(new Error('账号未运行'));

        // 检查最后一个参数是否包含 _timeoutMs
        const lastArg = args.at(-1);
        const customTimeout = lastArg && typeof lastArg === 'object' && lastArg._timeoutMs;
        const timeoutMs = customTimeout
            ? Number(lastArg._timeoutMs) || 10000
            : 10000;

        const actualArgs = customTimeout ? args.slice(0, -1) : args;

        return new Promise((resolve, reject) => {
            const reqId = wrk.reqId++;
            // 计时器名带全局序号：换代后新记录 reqId 从 1 重置，按账号+reqId
            // 命名会重名并互相覆盖，导致旧请求永久悬挂
            const timerKey = `api_timeout_${  accountId  }_${  reqId  }_${  ++rpcTimerSeq}`;
            wrk.requests.set(reqId, { resolve, reject, timerKey });

            // API 超时保护
            scheduler.setTimeoutTask(timerKey, timeoutMs, () => {
                if (wrk.requests.has(reqId)) {
                    wrk.requests.delete(reqId);
                    reject(new Error('API Timeout'));
                }
            });

            wrk.process.send({
                type: 'api_call',
                id: reqId,
                method,
                args: actualArgs
            });
        });
    }

    return {
        startWorker,
        stopWorker,
        restartWorker,
        callWorkerApi
    };
}

module.exports = { createWorkerManager };
