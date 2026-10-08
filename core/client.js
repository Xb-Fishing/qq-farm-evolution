const process = require('node:process');

// 最早入口路由（2026-10-08）：批准运行时重定向必须先于运行数据加固与任何业务
// 模块加载；worker/抓包/打包可执行与无管理目标时保持原有自举语义，证明失败
// 则明确退出（不静默运行旧源）。详见 src/runtime/approved-runtime-entry.js。
require('./src/runtime/approved-runtime-entry').routeApprovedRuntime(process);

const { secureRuntimeDataTree } = require('./src/config/runtime-paths');

// 所有后续运行文件默认只允许当前系统用户读取；并修正既有数据文件权限。
process.umask(0o077);
secureRuntimeDataTree();

const {
    startAdminServer,
    emitRealtimeStatus,
    emitRealtimeLog,
    emitRealtimeAccountLog,
} = require('./src/controllers/admin');
const { createRuntimeEngine } = require('./src/runtime/runtime-engine');
const { createModuleLogger } = require('./src/services/logger');
const { verifyAndRun } = require('./src/services/license');

const mainLogger = createModuleLogger('main');
const isWorkerProcess = process.env.FARM_WORKER === '1';

async function bootstrap() {
    if (isWorkerProcess) {
        require('./src/core/worker');
        return;
    }

    // 抓包服务子命令：qq-farm-bot --capture（或 FARM_CAPTURE_SERVER=1）
    if (process.argv.includes('--capture') || process.env.FARM_CAPTURE_SERVER === '1') {
        const { startCaptureServer } = require('./src/capture/index');
        const { resolveAdvertiseAddresses } = require('./src/capture/ip-utils');
        const { config, stop, log } = await startCaptureServer();
        const advertise = resolveAdvertiseAddresses(config);
        log.info(`抓包服务已启动，API: http://${config.apiHost}:${config.apiPort}`);
        log.info(`对外代理地址: ${advertise.addresses.length
            ? advertise.addresses.map(item => `${item.address} (${item.kind})`).join(', ')
            : '未检测到可用地址'}`);
        const shutdown = (signal) => {
            log.info(`收到 ${signal}，正在关闭抓包服务...`);
            void stop().then(() => process.exit(0));
        };
        process.on('SIGINT', () => shutdown('SIGINT'));
        process.on('SIGTERM', () => shutdown('SIGTERM'));
        return;
    }

    const licenseValid = await verifyAndRun();
    if (!licenseValid) {
        console.error('');
        console.error('[Error] License verification failed, exiting.');
        console.error('');
        process.exit(1);
        return;
    }

    const runtimeEngine = createRuntimeEngine({
        processRef: process,
        mainEntryPath: __filename,
        startAdminServer,
        onStatusSync: (accountId, status) => {
            emitRealtimeStatus(accountId, status);
        },
        onLog: (entry, accountId) => {
            if (accountId && entry) {
                entry.accountId = accountId;
            }
            emitRealtimeLog(entry);
        },
        onAccountLog: (entry) => {
            emitRealtimeAccountLog(entry);
        },
    });

    runtimeEngine.start({
        startAdminServer: true,
        autoStartAccounts: true,
    }).catch((err) => {
        mainLogger.error('runtime bootstrap failed', {
            error: err && err.message ? err.message : String(err),
        });
    });
}

bootstrap().catch((err) => {
    console.error('Bootstrap failed:', err);
    process.exit(1);
});
