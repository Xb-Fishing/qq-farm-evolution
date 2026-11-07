'use strict';
// 降速转换的诊断证据与核心准入回归。所有输入均为合成数据，无网络或游戏 RPC。
// 本文件锁定三层证据：
// 1) VM 装入真实 request-governor 源码，只 mock ./logger 与 ./daily-events：
//    阈值前零日志、第 12 次恰好一条且为纯整数元数据、持续期不再打、过期再触发
//    只加一条、breakerExempt/成熟竞速/盯梢豁免与成功请求零日志、两个 sink
//    任一抛错互不阻断且不影响真实降速状态。
// 2) core 准入不回退：降速不拦 Harvest/Steal/Enter/AllLands；紧急/盯梢窗口
//    关闭后普通 Enter 硬预算仍拦，白名单保持——不放松任何生产保护。
// 3) 隔离 plain Node 子进程（NODE_TEST_CONTEXT 清空）加载真实模块与真实
//    winston logger，合成 12 次 recordSent，等待真实 transport.close()/finish
//    并有界核对 combined-*.log：整数元数据未被脱敏丢失，
//    且无 method/service/账号身份正文。
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);
const root = path.resolve(__dirname, '..');
const governorPath = path.join(root, 'src', 'services', 'request-governor.js');
const loggerPath = path.join(root, 'src', 'services', 'logger.js');
const governorSource = fs.readFileSync(governorPath, 'utf8');

// 夹具根：默认系统 tmp，允许显式覆盖；写前校验目录存在，收尾校验未漂移。
const tmpRoot = fs.realpathSync(process.env.FARM_GOVERNOR_EVIDENCE_TMP_DIR || os.tmpdir());
assert.ok(fs.statSync(tmpRoot).isDirectory(), `夹具根必须是已存在目录: ${tmpRoot}`);
function createFixture(prefix) {
    const target = path.resolve(tmpRoot, prefix);
    assert.equal(path.dirname(target), tmpRoot, '创建前校验夹具目录边界');
    return fs.mkdtempSync(target);
}
const fixture = createFixture('request-governor-evidence-');
const environmentKeys = ['FARM_DATA_DIR', 'FARM_LOG_DIR', 'FARM_BREAKER_ERR_LIMIT',
    'FARM_REQUEST_LIMIT_60S', 'FARM_REQUEST_METHOD_LIMIT_60S'];
const originalEnvironment = Object.fromEntries(environmentKeys.map(key => [key, process.env[key]]));
const sourceFingerprint = () => [governorPath, loggerPath, __filename].map(file => ({
    file,
    mode: fs.statSync(file).mode & 0o777,
    sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
}));
const originalSources = sourceFingerprint();
// 首次业务加载前设定独立数据目录：本进程内的真实 logger/feedback 副作用只落夹具。
process.env.FARM_DATA_DIR = fixture;
process.env.FARM_LOG_DIR = path.join(fixture, 'logs');
process.env.FARM_BREAKER_ERR_LIMIT = '12';
process.env.FARM_REQUEST_LIMIT_60S = '80';
process.env.FARM_REQUEST_METHOD_LIMIT_60S = '30';
after(() => {
    try {
        assert.deepEqual(sourceFingerprint(), originalSources, '成功/失败收尾均不得改变源码内容或模式');
    } finally {
        assert.equal(path.dirname(fixture), tmpRoot, '收尾前校验夹具路径未被漂移');
        fs.rmSync(fixture, { recursive: true, force: true });
        for (const key of environmentKeys) {
            if (originalEnvironment[key] === undefined) delete process.env[key];
            else process.env[key] = originalEnvironment[key];
        }
    }
});

const T0 = 1_700_000_000_000;
const FAIL_SVC = 'gamepb.zzzpb.SyntheticService';
const FAIL_METHOD = 'ProbeFailZzz'; // 唯一标记串，用于反证日志泄漏
const IDENTITY_MARK = 'synthetic-rgov-identity';

test('夹具边界：越界创建零写，合法创建确实执行且可清理', () => {
    const originalCreate = fs.mkdtempSync;
    let writes = 0;
    let created;
    fs.mkdtempSync = (...args) => { writes++; return originalCreate(...args); };
    try {
        assert.throws(() => createFixture('../request-governor-outside-'),
            /创建前校验夹具目录边界/);
        assert.equal(writes, 0, '越界目标必须在实际写操作前被拒绝');
        created = createFixture('request-governor-boundary-');
        assert.equal(writes, 1, '合法目标必须实际创建，不能跳过写操作');
        assert.equal(path.dirname(created), tmpRoot);
        assert.ok(fs.statSync(created).isDirectory());
    } finally {
        fs.mkdtempSync = originalCreate;
        if (created) {
            assert.equal(path.dirname(created), tmpRoot);
            fs.rmSync(created, { recursive: true, force: true });
        }
    }
});

/** VM 装入真实源码：仅替换 ./logger 与 ./daily-events，其余 require 一律拒绝。 */
function loadGovernorInVm({ loggerModule, dailyEventsModule }) {
    // 影子 process：清掉 NODE_TEST_CONTEXT 使生产日志分支生效，但不动真实全局。
    const env = { ...process.env, FARM_ACCOUNT_ID: IDENTITY_MARK };
    delete env.NODE_TEST_CONTEXT;
    const fakeProcess = { env };
    const mod = { exports: {} };
    vm.compileFunction(governorSource, ['require', 'module', 'exports', 'process'], {
        filename: governorPath,
    })(
        name => {
            if (name === './logger') return loggerModule;
            if (name === './daily-events') return dailyEventsModule;
            throw new Error(`unexpected require: ${name}`);
        },
        mod,
        mod.exports,
        fakeProcess
    );
    return mod.exports;
}

/** 捕获型双 sink：可分别注入“创建失败/写入失败/事件失败”。 */
function makeSinks() {
    const warns = [];
    const events = [];
    let loggerFailMode = null; // 'create' | 'write' | null
    let dailyFail = false;
    const loggerModule = {
        createModuleLogger(name) {
            if (loggerFailMode === 'create') throw new Error('logger create boom');
            return {
                warn(message, meta) {
                    if (loggerFailMode === 'write') throw new Error('logger write boom');
                    warns.push({ name, message, meta });
                },
            };
        },
    };
    const dailyEventsModule = {
        recordEvent(...args) {
            if (dailyFail) throw new Error('daily-events boom');
            events.push(args);
        },
    };
    return {
        warns, events, loggerModule, dailyEventsModule,
        failLogger(mode) { loggerFailMode = mode; },
        failDaily() { dailyFail = true; },
        load() { return loadGovernorInVm({ loggerModule, dailyEventsModule }); },
    };
}

/** 累计 n 次失败，返回最后一次 recordSent 结果。 */
function failN(gov, n, baseAt, stepMs = 1000, svc = FAIL_SVC, method = FAIL_METHOD) {
    let result;
    for (let i = 0; i < n; i++) result = gov.recordSent(svc, method, false, baseAt + i * stepMs);
    return result;
}

function assertSlowdownMeta(warn, { failureCount, failureMethodCount, slowdownMs, slowdownUntil }) {
    assert.equal(warn.name, 'system');
    assert.equal(warn.message, '连续请求失败触发普通巡查降速');
    assert.equal(warn.meta.event, 'request_slowdown_started');
    assert.equal(warn.meta.failureCount, failureCount);
    assert.equal(warn.meta.failureMethodCount, failureMethodCount);
    assert.equal(warn.meta.slowdownMs, slowdownMs);
    assert.equal(warn.meta.slowdownUntil, slowdownUntil);
    assert.deepEqual(Object.keys(warn.meta).sort(), ['event', 'failureCount',
        'failureMethodCount', 'slowdownMs', 'slowdownUntil'].sort());
    for (const field of ['failureCount', 'failureMethodCount', 'slowdownMs', 'slowdownUntil']) {
        assert.ok(Number.isInteger(warn.meta[field]), `${field} 必须保持整数（未脱敏成字符串/丢失）`);
    }
    assert.ok(warn.meta.slowdownMs >= 5 * 60 * 1000 && warn.meta.slowdownMs < 10 * 60 * 1000);
    // 诊断日志零 method/service/原错误/身份。
    const logged = JSON.stringify(warn);
    assert.ok(!logged.includes(FAIL_METHOD) && !logged.includes(FAIL_SVC), '日志不得携带 method/service');
    assert.ok(!logged.includes(IDENTITY_MARK), '日志不得携带账号身份');
}

function assertFailedTransition(result) {
    assert.equal(result.tripped, false, '保持非熔断返回语义');
    assert.equal(result.slowed, true);
    assert.deepEqual(result.failures, [{ method: `${FAIL_SVC}.${FAIL_METHOD}`, count: 12 }],
        '日志成功或失败均保留原失败汇总返回');
}

// ─── 1) VM 行为断言 ───

test('VM：阈值前零日志，第 12 次失败恰好一条且元数据为精确整数', () => {
    const sinks = makeSinks();
    const gov = sinks.load();
    for (let i = 0; i < 11; i++) {
        assert.equal(failN(gov, 1, T0 + i * 1000).slowed, undefined);
    }
    assert.equal(sinks.warns.length, 0, '阈值前不得产生诊断日志');
    assert.equal(sinks.events.length, 0);
    const triggerAt = T0 + 11 * 1000;
    const result = gov.recordSent(FAIL_SVC, FAIL_METHOD, false, triggerAt);
    assertFailedTransition(result);
    assert.equal(result.slowed, true);
    assert.equal(sinks.warns.length, 1, '第 12 次失败恰好一条诊断日志');
    assertSlowdownMeta(sinks.warns[0], {
        failureCount: 12,
        failureMethodCount: 1,
        slowdownMs: result.slowdownMs,
        slowdownUntil: triggerAt + result.slowdownMs,
    });
    assert.equal(sinks.events.length, 1, 'daily-events 照常各一条');
});

test('VM：降速持续期内再次累计失败不再重复打日志', () => {
    const sinks = makeSinks();
    const gov = sinks.load();
    const first = failN(gov, 12, T0);
    assert.equal(first.slowed, true);
    // 窗口内（slowdown 至少 5 分钟）再来一批失败：状态在但不再打日志。
    const second = failN(gov, 12, T0 + 20_000, 1000, 'gamepb.zzzpb.OtherService', 'AlsoFailingZzz');
    assert.equal(second.slowed, undefined);
    assert.equal(sinks.warns.length, 1, '持续期不得重复打');
    assert.equal(sinks.events.length, 1);
    const state = gov.getBreakerState(T0 + 40_000);
    assert.equal(state.active, true);
    assert.equal(state.count, 1);
});

test('VM：降速过期后新阈值再触发只新增一条', () => {
    const sinks = makeSinks();
    const gov = sinks.load();
    const first = failN(gov, 12, T0);
    const slowdownUntil = T0 + 11 * 1000 + first.slowdownMs;
    const later = slowdownUntil + 60_000; // 已跨过降速；第一波错误在触发时已清空。
    const second = failN(gov, 12, later, 1000, 'gamepb.zzzpb.SecondWave', 'WaveFailZzz');
    assert.equal(second.slowed, true);
    assert.equal(sinks.warns.length, 2, '过期后新转换恰好新增一条');
    assertSlowdownMeta(sinks.warns[1], {
        failureCount: 12,
        failureMethodCount: 1,
        slowdownMs: second.slowdownMs,
        slowdownUntil: later + 11 * 1000 + second.slowdownMs,
    });
    assert.equal(gov.getBreakerState(later + 12_000).count, 2);
});

test('VM：breakerExempt/成熟竞速/盯梢豁免与成功请求均不产生降速日志', () => {
    const sinks = makeSinks();
    const gov = sinks.load();
    // 成功请求
    for (let i = 0; i < 20; i++) gov.recordSent(FAIL_SVC, FAIL_METHOD, true, T0 + i);
    // 显式只读探测豁免
    for (let i = 0; i < 20; i++) {
        gov.recordSent('gamepb.zzzpb.ReadProbe', 'GetNothingZzz', false, T0 + i, { breakerExempt: true });
    }
    // 成熟竞速宽限内的链路失败
    gov.setContentionMode(true, T0 + 60_000);
    for (const [svc, method] of [
        ['gamepb.visitpb.VisitService', 'Enter'],
        ['gamepb.visitpb.VisitService', 'Leave'],
        ['gamepb.plantpb.PlantService', 'AllLands'],
        ['gamepb.plantpb.PlantService', 'CheckCanOperate'],
        ['gamepb.plantpb.PlantService', 'Harvest'],
    ]) {
        for (let i = 0; i < 5; i++) gov.recordSent(svc, method, false, T0 + 1_000 + i);
    }
    // 盯梢 HOT 窗口内的目标链路失败
    gov.setContentionMode(false);
    gov.setWatchMode(true, T0 + 120_000);
    for (let i = 0; i < 10; i++) gov.recordSent('gamepb.visitpb.VisitService', 'Enter', false, T0 + 2_000 + i);
    assert.equal(sinks.warns.length, 0, '豁免失败与成功请求均不得产生降速日志');
    assert.equal(sinks.events.length, 0);
    assert.equal(gov.getBreakerState(T0 + 5_000).active, false);
});

test('VM：logger 创建抛错不阻 daily-events 与真实降速', () => {
    const sinks = makeSinks();
    const gov = sinks.load();
    sinks.failLogger('create');
    const result = failN(gov, 12, T0);
    assertFailedTransition(result);
    assert.equal(result.slowed, true, '返回值不受 logger 创建失败影响');
    assert.equal(sinks.events.length, 1, '另一 sink 照常收到事件');
    assert.equal(sinks.warns.length, 0);
    const state = gov.getBreakerState(T0 + 12_000);
    assert.equal(state.active, true, '降速状态照常生效');
    assert.equal(state.count, 1);
});

test('VM：logger 写入抛错不阻 daily-events 与真实降速', () => {
    const sinks = makeSinks();
    const gov = sinks.load();
    sinks.failLogger('write');
    const result = failN(gov, 12, T0);
    assertFailedTransition(result);
    assert.equal(result.slowed, true);
    assert.equal(sinks.events.length, 1);
    const state = gov.getBreakerState(T0 + 12_000);
    assert.equal(state.active, true);
    assert.equal(state.count, 1);
});

test('VM：daily-events 抛错不阻诊断日志与真实降速', () => {
    const sinks = makeSinks();
    const gov = sinks.load();
    sinks.failDaily();
    const result = failN(gov, 12, T0);
    assertFailedTransition(result);
    assert.equal(result.slowed, true, '返回值不受事件记录失败影响');
    assert.equal(sinks.warns.length, 1, '诊断日志不受事件记录失败影响');
    assertSlowdownMeta(sinks.warns[0], {
        failureCount: 12,
        failureMethodCount: 1,
        slowdownMs: result.slowdownMs,
        slowdownUntil: T0 + 11 * 1000 + result.slowdownMs,
    });
    const state = gov.getBreakerState(T0 + 12_000);
    assert.equal(state.active, true);
    assert.equal(state.count, 1);
});

// ─── 2) core 准入（真实模块，NODE_TEST_CONTEXT 日志分支保持关闭） ───

const governor = require('../src/services/request-governor');

test('core 准入：降速期间 Harvest/Steal/Enter/AllLands 照常允许，白名单保持', () => {
    governor.resetForTest();
    let slowed = false;
    for (let i = 0; i < 14 && !slowed; i++) {
        slowed = governor.recordSent(FAIL_SVC, FAIL_METHOD, false, T0 + i * 1000).slowed;
    }
    assert.equal(slowed, true);
    const state = governor.getBreakerState(T0 + 15_000);
    assert.equal(state.active, true);
    assert.equal(state.hardBlocked, false, '降速只是通知调度层，不做整号硬拦');
    // 自己收获与好友偷菜（白名单正则）不受影响。
    assert.equal(governor.checkRequest('gamepb.plantpb.PlantService', 'Harvest', T0 + 15_000).allowed, true);
    assert.equal(governor.checkRequest('gamepb.friendpb.FriendService', 'Steal', T0 + 15_000).allowed, true);
    // 重点 PREARM 链路的 Enter/AllLands 在普通（非紧急/盯梢）状态下按预算正常放行。
    const enter = governor.checkRequest('gamepb.visitpb.VisitService', 'Enter', T0 + 15_000);
    assert.equal(enter.allowed, true);
    assert.equal(enter.reason, 'ok');
    const lands = governor.checkRequest('gamepb.plantpb.PlantService', 'AllLands', T0 + 15_000);
    assert.equal(lands.allowed, true);
    assert.equal(lands.reason, 'ok');
    // 防封兜底白名单保持。
    assert.equal(governor.checkRequest('gamepb.userpb.UserService', 'Heartbeat', T0 + 15_000).reason, 'whitelist');
    assert.equal(governor.checkRequest('gamepb.gatepb.GateService', 'Login', T0 + 15_000).reason, 'whitelist');
});

test('core 准入：紧急/盯梢窗口关闭后普通 Enter 硬预算仍拦，白名单不受影响', () => {
    governor.resetForTest();
    governor.setUrgentMode(false);
    governor.setWatchMode(false);
    for (let i = 0; i < governor.PER_METHOD_LIMIT; i++) {
        governor.recordSent('gamepb.visitpb.VisitService', 'Enter', true, T0 + i * 10);
    }
    const blockedMethod = governor.checkRequest('gamepb.visitpb.VisitService', 'Enter', T0 + 1_000);
    assert.equal(blockedMethod.allowed, false, '单接口硬预算必须仍然拦截');
    assert.equal(blockedMethod.reason, 'budget_method');
    // 总量预算同样保持。
    for (let i = 0; i < governor.TOTAL_LIMIT; i++) {
        governor.recordSent('gamepb.zzzpb.FillerService', 'FillerZzz', true, T0 + i * 10);
    }
    const blockedTotal = governor.checkRequest('gamepb.zzzpb.YetAnother', 'PlainZzz', T0 + 2_000);
    assert.equal(blockedTotal.allowed, false);
    assert.equal(blockedTotal.reason, 'budget_total');
    // 预算满时白名单与偷菜键仍放行。
    assert.equal(governor.checkRequest('gamepb.userpb.UserService', 'Heartbeat', T0 + 2_000).allowed, true);
    assert.equal(governor.checkRequest('gamepb.acepb.AceService', 'AntiData', T0 + 2_000).allowed, true);
    assert.equal(governor.checkRequest('gamepb.plantpb.PlantService', 'Harvest', T0 + 2_000).allowed, true);
});

// ─── 3) 子进程：真实 logger → combined 落盘证据 ───

const SUBPROCESS_SCRIPT = `
'use strict';
// 隔离 plain Node 子进程：NODE_TEST_CONTEXT 已由父进程清空，真实 winston 落盘。
const path = require('node:path');
const { createRequire } = require('node:module');
const loggerPath = ${JSON.stringify(loggerPath)};
const anchorRequire = createRequire(loggerPath);
const winston = anchorRequire('winston');
let rootLogger = null;
const originalCreateLogger = winston.createLogger;
winston.createLogger = function patchedCreateLogger(...args) {
    rootLogger = originalCreateLogger.apply(this, args);
    return rootLogger;
};
const governor = require(${JSON.stringify(governorPath)});
const T0 = 1_700_000_000_000;
// 合成 12 次失败：recordSent 是纯记账函数，无任何真实 RPC/网络。
let result = null;
for (let i = 0; i < 12; i++) {
    result = governor.recordSent('gamepb.zzzpb.SyntheticService', 'ProbeFailZzz', false, T0 + i * 1000);
}
if (!result || result.slowed !== true) {
    console.error('slowdown not triggered');
    process.exit(2);
}
// 真实 flush：DailyRotateFile 要等 transport.close() → logStream 排空后的
// 'finish'（logger 自身的 finish 不等传输流）；带上限兜底，不靠盲 sleep。
// 旧基线没有诊断 logger 时也正常交回，让父测试以“缺少日志行”断言失败。
const rotateTransports = rootLogger ? rootLogger.transports.filter(t => t && t.logStream) : [];
let capTimer;
const cap = new Promise(resolve => { capTimer = setTimeout(() => resolve('timeout'), 8_000); });
const flushed = Promise.all(rotateTransports.map(t => new Promise(resolve => {
    t.once('finish', resolve);
    t.close();
}))).then(() => 'finish');
Promise.race([flushed, cap]).then(outcome => {
    clearTimeout(capTimer);
    process.stdout.write('\\n<<<RGOV_JSON>>>' + JSON.stringify({
        slowdownMs: result.slowdownMs,
        slowdownUntil: T0 + 11 * 1000 + result.slowdownMs,
        loggerCaptured: Boolean(rootLogger),
        flushed: outcome === 'finish',
    }));
    process.exit(0);
});
`;

test('子进程：真实 logger 落盘 combined，整数元数据完整且无 method/身份正文', async () => {
    const subFixture = createFixture('request-governor-subproc-');
    const scriptPath = path.resolve(subFixture, 'trigger.js');
    try {
        assert.equal(path.dirname(subFixture), tmpRoot, '写前校验子夹具路径');
        assert.ok(scriptPath.startsWith(subFixture + path.sep), '脚本写入前校验夹具边界');
        fs.writeFileSync(scriptPath, SUBPROCESS_SCRIPT, { encoding: 'utf8', mode: 0o600 });
        const env = { ...process.env };
        delete env.NODE_TEST_CONTEXT;
        env.NODE_OPTIONS = '';
        env.FARM_SESSION_BUSINESS = '0';
        env.FARM_ACCOUNT_ID = IDENTITY_MARK;
        env.FARM_DATA_DIR = subFixture;
        env.FARM_LOG_DIR = path.join(subFixture, 'logs');
        env.LOG_LEVEL = 'info';
        const { stdout } = await execFileAsync(process.execPath, [scriptPath], {
            env, cwd: root, timeout: 30_000,
        });
        const markerMatch = stdout.match(/<<<RGOV_JSON>>>([\s\S]*)/);
        assert.ok(markerMatch, `子进程必须回传结果标记，stdout: ${stdout.slice(0, 500)}`);
        const expected = JSON.parse(markerMatch[1].trim());
        const logsDir = path.join(subFixture, 'logs');
        // 有界等待目标日志行（flush 已真实完成，这里只是兜底轮询，非盲 sleep）。
        const deadline = Date.now() + 5_000;
        let entry = null;
        let allText = '';
        while (Date.now() < deadline) {
            const names = fs.existsSync(logsDir)
                ? fs.readdirSync(logsDir).filter(n => /^combined(?:-\d{4}-\d{2}-\d{2}-\d{2})?\.log$/.test(n))
                : [];
            allText = names.map(n => fs.readFileSync(path.join(logsDir, n), 'utf8')).join('\n');
            entry = allText.split('\n').filter(Boolean)
                .map(line => { try { return JSON.parse(line); } catch { return null; } })
                .find(e => e && (e.event === 'request_slowdown_started' || e.meta?.event === 'request_slowdown_started'));
            if (entry) break;
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        assert.ok(entry, `combined 日志必须包含降速诊断行，实际内容: ${allText || '(空)'}`);
        assert.equal(expected.loggerCaptured, true, '当前源码须实际创建 winston logger');
        assert.equal(expected.flushed, true, '必须完成真实 transport flush，不能把超时当成功');
        const merged = Object.assign({}, entry.meta || {}, entry);
        const allowedKeys = new Set(['app', 'timestamp', 'level', 'module', 'message', 'event',
            'failureCount', 'failureMethodCount', 'slowdownMs', 'slowdownUntil']);
        assert.deepEqual(Object.keys(merged).filter(key => !allowedKeys.has(key)), [],
            '真实日志不得携带额外身份、方法或错误字段');
        assert.equal(merged.level, 'warn');
        assert.equal(merged.module, 'system');
        assert.equal(merged.message, '连续请求失败触发普通巡查降速');
        assert.equal(merged.event, 'request_slowdown_started');
        assert.equal(merged.failureCount, 12);
        assert.equal(merged.failureMethodCount, 1);
        assert.equal(merged.slowdownMs, expected.slowdownMs);
        assert.equal(merged.slowdownUntil, expected.slowdownUntil);
        for (const field of ['failureCount', 'failureMethodCount', 'slowdownMs', 'slowdownUntil']) {
            assert.ok(Number.isInteger(merged[field]), `${field} 经真实 logger 后仍是整数`);
        }
        // 无 method/service/身份正文（combined 全文件扫描）。
        assert.ok(!allText.includes('ProbeFailZzz') && !allText.includes('SyntheticService'),
            'combined 不得包含失败 method/service 正文');
        assert.ok(!allText.includes(IDENTITY_MARK), 'combined 不得包含账号身份');
    } finally {
        assert.equal(path.dirname(subFixture), tmpRoot, '收尾前校验子夹具路径未被漂移');
        fs.rmSync(subFixture, { recursive: true, force: true });
    }
});
