'use strict';
// 重点名单陈旧目标治理——基线反例夹具（2026-10-07）。
//
// 合同：本文件是反证登记的唯一测试入口，只经旧代码（HEAD）已存在的
// 生产入口推进实际巡田并统计真实 Enter——真实 friend-orchestrator /
// friend-visit / fertilizer-watch / store 模块，生产调度环
// （applyStealScheduleFromFriends 武装 → 手动泵 watchlist_poll →
// pullWatchlistPollToNow 立即到期），Enter 计数挂在生产唯一进门点
// enterFriendFarm 上。禁止以新导出缺席（TypeError 或能力断言）充当
// 反证：旧代码上的失败必须全部来自实际请求计数的断言失败；重启链等
// 依赖新导出的验收一律放在非反证文件 friend-watchlist-stale.test.js。
// 夹具目录创建与直接写/删目标都先解析后校验，任何越界在创建/写入
// 原语调用之前拒绝；候选源码内容与权限全程前后断言不变。
// 顶层零新增导出依赖：旧代码（HEAD）可完整加载并运行。
//
// 断言（新代码必须成立、旧代码必须失败的反例点）：
//   连续 3 次真实 Enter 收到严格业务拒绝 1002002 后，第 4-6 个到期轮不再
//   发 Enter；此后 HOT 豁免通道照常进门且进场成功自然恢复基线巡田。
//   旧代码六轮全部发 Enter → Enter 计数断言失败。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// ===== 夹具创建与写边界（先解析校验，任何越界在原语调用前拒绝）=====
// 独立数据目录只隔离运行数据；目录创建与一切直接写/删目标都必须在
// 调用底层原语之前完成解析与目录边界校验——临时环境指向仓库时，
// 不允许先创建出目录再发现越界（那时越界副作用已发生）。
const repoRoot = path.resolve(__dirname, '../..');
const crypto = require('node:crypto');
const repoRootReal = fs.realpathSync(repoRoot);
// 目录边界判断带路径分隔符，避免同前缀目录误判
function isInsideOrEqualDir(candidate, base) {
    const c = path.resolve(String(candidate));
    const b = path.resolve(String(base));
    return c === b || c.startsWith(b + path.sep);
}
// 创建入口：临时根（realpath 解析，防符号链接绕回仓库）、创建前缀与
// 预期目标任一越界/非法，都在调用创建原语之前拒绝
function createPrivateDataDir(prefix) {
    if (typeof prefix !== 'string' || prefix.includes('..')
        || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(prefix))
        throw new Error(`非法创建前缀: ${prefix}`);
    const tempRoot = fs.realpathSync(path.resolve(os.tmpdir()));
    if (isInsideOrEqualDir(tempRoot, repoRootReal))
        throw new Error(`临时根不得位于仓库内: ${tempRoot}`);
    const expected = path.resolve(tempRoot, prefix);
    if (isInsideOrEqualDir(expected, repoRootReal))
        throw new Error(`越界创建目标: ${expected}`);
    const created = path.resolve(fs.mkdtempSync(path.join(tempRoot, prefix)));
    assert.ok(isInsideOrEqualDir(created, tempRoot),
        '独立数据目录必须位于系统临时目录内');
    assert.ok(!isInsideOrEqualDir(created, repoRootReal),
        '独立数据目录不得位于仓库内');
    return created;
}
const privateDir = createPrivateDataDir('farm-watchlist-baseline-');
process.env.FARM_DATA_DIR = privateDir;
process.env.FARM_ACCOUNT_ID = 'baseline-account';
function assertWriteInsidePrivateDir(target) {
    const resolved = path.resolve(String(target));
    const base = path.resolve(privateDir);
    if (resolved !== base && !resolved.startsWith(base + path.sep))
        throw new Error(`越界写目标: ${resolved}`);
    return resolved;
}

// ===== 候选源码指纹（内容+权限）：成功与失败路径全程前后一致 =====
const CANDIDATE_SOURCES = [
    'core/src/services/friend-api.js',
    'core/src/services/friend-visit.js',
    'core/src/services/friend-orchestrator.js',
    'core/src/core/worker.js',
    'core/src/models/store.js',
    'core/src/runtime/runtime-state.js',
    'core/src/runtime/worker-manager.js',
    'core/src/controllers/admin-friend-routes.js',
    'web/src/stores/friend.ts',
    'web/src/views/Friends.vue',
];
function fingerprintCandidateSources() {
    const out = {};
    for (const rel of CANDIDATE_SOURCES) {
        const file = path.join(repoRoot, rel);
        out[rel] = `${crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')}:${fs.statSync(file).mode & 0o777}`;
    }
    return out;
}
const candidateSourcesBefore = fingerprintCandidateSources();

// ===== 边界注入（全部是既有模块上的既有导出替换，旧代码同样成立）=====
const clock = { now: 1_800_000_000_000 };
const enterLog = [];
const logLines = [];

// 1) 调度器：手动泵任务表，避免真实定时器与分钟级真实等待
const schedulerModule = require('../src/services/scheduler');
const timerTasks = new Map();
schedulerModule.createScheduler = () => ({
    setTimeoutTask: (name, _delay, cb) => timerTasks.set(String(name), cb),
    setIntervalTask: (name, _interval, cb) => timerTasks.set(String(name), cb),
    clear: name => timerTasks.delete(String(name)),
    clearAll: () => timerTasks.clear(),
});

// 2) 网络边界：未连接的测试进程里让巡田前提（已连接/已登录）成立
const networkModule = require('../src/utils/network');
networkModule.isConnected = () => true;
networkModule.getUserState = () => ({ gid: 1 });

// 3) 工具边界：去掉轮内随机等待，纯逻辑推进；捕获日志用于断言
const utilsModule = require('../src/utils/utils');
utilsModule.randomDelay = async () => {};
utilsModule.log = (tag, message, meta) => logLines.push({ tag, message, ...meta });

// 4) Enter 边界：真实 friend-api 模块上的生产进门点替换（计数 + 可控结局）
const apiModule = require('../src/services/friend-api');
const staleRejection = () => Object.assign(
    new Error('不是好友无法拜访 code=1002002'),
    { isServerBusinessError: true, serverErrorCode: '1002002' },
);
let enterBehavior = 'stale';
apiModule.enterFriendFarm = async gid => {
    enterLog.push({ gid: Number(gid), at: clock.now });
    if (enterBehavior === 'stale') throw staleRejection();
    return { at_home: true, basic: { last_online: 0 }, lands: [] };
};
apiModule.leaveFriendFarm = async () => {};

// ===== 既有生产入口（HEAD 已存在的导出）=====
const store = require('../src/models/store');
const watch = require('../src/services/fertilizer-watch');
const friendActivity = require('../src/services/friend-activity');
const orchestrator = require('../src/services/friend-orchestrator');

test.after(() => {
    assert.deepEqual(fingerprintCandidateSources(), candidateSourcesBefore,
        '候选源码内容与权限在成功与失败路径全程不得改变');
    fs.rmSync(assertWriteInsidePrivateDir(privateDir), { recursive: true, force: true });
});

test.afterEach(() => {
    enterLog.length = 0;
    logLines.length = 0;
    enterBehavior = 'stale';
    // 反证边界：旧代码没有测试专用重置助手时不在此崩 TypeError——旧代码
    // 同样没有需要重置的暂停状态；反证登记只允许旧代码出现行为类失败
    if (typeof orchestrator.resetWatchlistPauseStateForTests === 'function')
        orchestrator.resetWatchlistPauseStateForTests();
    if (typeof watch.resetFertilizerWatchForTests === 'function')
        watch.resetFertilizerWatchForTests();
    clock.now = 1_800_000_000_000;
});

async function pumpWatchlistPoll() {
    const cb = timerTasks.get('watchlist_poll');
    assert.ok(typeof cb === 'function', 'watchlist_poll 任务必须在环');
    timerTasks.delete('watchlist_poll');
    await cb();
}

const healthRows = () => logLines.filter(row => row.event === 'priority_poll_health');
const pauseEvents = () => logLines.filter(row => row.event === 'watchlist_stale_paused');

test('连续三次严格被拒后停发基线 Enter；在线豁免进场成功自然恢复', async t => {
    t.mock.method(Date, 'now', () => clock.now);
    const gid = 9001;
    store.setWatchlistFriendGids('baseline-account', [gid]);

    // 既有入口：名单并进优先检测（noteWatchlistEnter 的前提）并武装巡田环
    orchestrator.applyStealScheduleFromFriends(
        [{ gid, name: 'baseline-friend', plant: { ripe_time_sec: 6 * 3600 } }],
        { myGid: 1, blacklist: new Set() },
    );
    assert.equal(watch.isPriorityGid(gid), true);

    // 六个到期轮：每轮立即到期并推进巡田环
    for (let round = 1; round <= 6; round++) {
        orchestrator.pullWatchlistPollToNow(gid, 0);
        await pumpWatchlistPoll();
        clock.now += 600_000;
    }
    // 反例断言：前三轮真实进门被拒 3 次，暂停后第 4-6 轮必须零 Enter
    assert.equal(enterLog.length, 3,
        `连续 3 次严格拒绝后基线巡田必须停发 Enter（实际 ${enterLog.length} 次）`);
    // 暂停期间不得伪造健康记录：跳过是静默重排，不是 ok/failed
    assert.equal(healthRows().length, 3, '只有前三轮实际尝试记健康日志');
    assert.equal(pauseEvents().length, 1, '第三次拒绝恰好告警一次');

    // 豁免通道：真实在线证据（既有 friend-activity 模块，生产由真实进门
    // 回复的 at_home 记录）命中时照常进门；进场成功即自然恢复
    enterBehavior = 'ok';
    friendActivity.recordActivity(gid, clock.now, 'at_home', 'baseline-test');
    assert.equal(friendActivity.isFriendOnlineRecently(gid, clock.now), true);
    orchestrator.pullWatchlistPollToNow(gid, 0);
    await pumpWatchlistPoll();
    assert.equal(enterLog.length, 4, '在线豁免通道必须照常进门');

    // 在线证据过期后的下一轮基线巡田恢复进门（成功已清暂停，不再被门拦）
    clock.now += 60_000;
    orchestrator.pullWatchlistPollToNow(gid, 0);
    await pumpWatchlistPoll();
    assert.equal(enterLog.length, 5, '真实进场成功后基线巡田自然恢复');
    for (const row of enterLog) {
        assert.equal(row.gid, gid, 'Enter 只发给名单目标');
    }
});

// 暂停门证据补齐（巡田时间表无值时回退逐目标成熟快照）：
// 失败轮从不写巡田成熟时间表（watchlistPollRipeAt），摘要建立的
// fertilizer-watch 逐目标快照是暂停门唯一可用证据。快照缺失/过期仍按
// 未知处理；既有缓存过期判断与目标隔离保持不变。
test('快照回退放行观察窗豁免：实际发 Enter；快照过期后仍按未知拦下', async t => {
    t.mock.method(Date, 'now', () => clock.now);
    const gid = 9101;
    store.setWatchlistFriendGids('baseline-account', [gid]);
    orchestrator.applyStealScheduleFromFriends(
        [{ gid, name: 'snapshot-friend', plant: { ripe_time_sec: 35 * 60 } }],
        { myGid: 1, blacklist: new Set() },
    );

    // 三轮真实被拒 → 暂停（未暂停时豁免不参与，进门照常被拒）
    for (let round = 1; round <= 3; round++) {
        orchestrator.pullWatchlistPollToNow(gid, 0);
        await pumpWatchlistPoll();
        clock.now += 600_000;
    }
    assert.equal(enterLog.length, 3);
    assert.equal(pauseEvents().length, 1);

    // 第 4 轮（剩余 5 分钟，观察窗内）：快照回退补齐证据 → 放行并实际发 Enter
    orchestrator.pullWatchlistPollToNow(gid, 0);
    await pumpWatchlistPoll();
    assert.equal(enterLog.length, 4, '观察窗豁免必须经快照回退实际进门，不得以日志代替执行');
    const health = healthRows();
    assert.equal(health[3].mode, 'observation', '观察窗内实际尝试按 observation 档记录');
    assert.equal(health[3].result, 'failed');
    assert.ok(health[3].nextDelayMs >= 45_000 && health[3].nextDelayMs <= 75_000,
        `观察窗内重排必须是 45-75s 档（实际 ${health[3].nextDelayMs}ms）`);

    // 反例：快照过期（dueAt 落在 90s 宽限之外）→ 按未知处理，暂停照常拦
    clock.now = 1_800_000_000_000 + 35 * 60_000 + 100_000;
    orchestrator.pullWatchlistPollToNow(gid, 0);
    await pumpWatchlistPoll();
    assert.equal(enterLog.length, 4, '过期快照不得继续放行');
    assert.equal(healthRows().length, 4, '暂停跳过不得伪造健康记录');
});

// 目标隔离：其他目标的窗口证据（快照或时间表）不能释放本目标的暂停；
// 未暂停目标照常按自身节奏进门。
test('目标隔离：他目标的观察窗快照不释放本目标暂停', async t => {
    t.mock.method(Date, 'now', () => clock.now);
    const far = 9201;   // 自身快照 6 小时（窗口外）
    const near = 9202;  // 自身快照 40 分钟（窗口内）
    store.setWatchlistFriendGids('baseline-account', [far, near]);
    orchestrator.applyStealScheduleFromFriends([
        { gid: far, name: 'far-friend', plant: { ripe_time_sec: 6 * 3600 } },
        { gid: near, name: 'near-friend', plant: { ripe_time_sec: 40 * 60 } },
    ], { myGid: 1, blacklist: new Set() });

    // 三轮：两目标都被拒满 3 次，双双暂停
    for (let round = 1; round <= 3; round++) {
        orchestrator.pullWatchlistPollToNow(far, 0);
        orchestrator.pullWatchlistPollToNow(near, 0);
        await pumpWatchlistPoll();
        clock.now += 600_000;
    }
    assert.equal(enterLog.filter(row => row.gid === far).length, 3);
    assert.equal(enterLog.filter(row => row.gid === near).length, 3);

    // 第 4 轮：near 自身剩余 10 分钟（窗口内）→ 快照回退放行；far 自身 6 小时
    // → 窗口外照常拦下（near 的窗口证据不得外溢释放 far）
    orchestrator.pullWatchlistPollToNow(far, 0);
    orchestrator.pullWatchlistPollToNow(near, 0);
    await pumpWatchlistPoll();
    assert.equal(enterLog.filter(row => row.gid === far).length, 3,
        '他目标的窗口证据不得释放本目标暂停');
    assert.equal(enterLog.filter(row => row.gid === near).length, 4,
        '自身快照在窗内必须放行');
});

// ==================== 夹具写边界反例 ====================

test('夹具写边界：越界目标在写入前被拒绝且零写入', () => {
    const escaped = path.resolve(privateDir, '..', 'farm-watchlist-baseline-escape.json');
    assert.throws(() => assertWriteInsidePrivateDir(escaped), /越界/);
    assert.equal(fs.existsSync(escaped), false, '越界目标必须零写入');
    // 相对路径基点错误（解析回候选源码）同样必须拒绝
    assert.throws(() => assertWriteInsidePrivateDir(path.join(repoRoot, 'core/src/models/store.js')), /越界/);
    assert.equal(fs.existsSync(path.join(repoRoot, 'core/src/models/store.js')), true, '候选源码保持原状');
    // 合法目标放行并返回解析后路径
    const inside = path.join(privateDir, 'nested/deep/file.json');
    assert.equal(assertWriteInsidePrivateDir(inside), path.resolve(inside));
});

// ==================== 夹具创建边界反例 ====================

test('夹具创建边界：仓库内临时根/越界目标在任何创建原语前被拒绝且零创建零写入', t => {
    const calls = { mkdtemp: 0, writes: 0 };
    const realRoot = fs.realpathSync(path.resolve(os.tmpdir()));
    const realMkdtemp = fs.mkdtempSync.bind(fs);
    const realWrite = fs.writeFileSync.bind(fs);
    t.mock.method(fs, 'mkdtempSync',
        (...args) => { calls.mkdtemp += 1; return realMkdtemp(...args); });
    t.mock.method(fs, 'writeFileSync',
        (...args) => { calls.writes += 1; return realWrite(...args); });
    let fakeTmpdir = realRoot;
    t.mock.method(os, 'tmpdir', () => fakeTmpdir);
    // 仓库根本身 / 仓库子目录作为临时根：创建原语调用前拒绝
    fakeTmpdir = repoRoot;
    assert.throws(() => createPrivateDataDir('farm-x-'), /临时根不得位于仓库内/);
    fakeTmpdir = path.join(repoRoot, 'core');
    assert.throws(() => createPrivateDataDir('farm-x-'), /临时根不得位于仓库内/);
    // 符号链接临时根指回仓库（realpath 解析后等于仓库根）：同样创建前拒绝
    const linkDir = path.join(realRoot, `farm-root-link-${process.pid}`);
    fs.symlinkSync(repoRootReal, linkDir, 'dir');
    try {
        fakeTmpdir = linkDir;
        assert.throws(() => createPrivateDataDir('farm-x-'), /临时根不得位于仓库内/);
    } finally {
        fs.rmSync(linkDir, { force: true });
    }
    // 合法临时根 + 越界/非法创建目标（前缀逃逸）：仍在原语调用前拒绝
    fakeTmpdir = realRoot;
    assert.throws(() => createPrivateDataDir('../repo-escape-'), /非法创建前缀/);
    assert.throws(() => createPrivateDataDir('farm-x-/../..'), /非法创建前缀/);
    assert.equal(calls.mkdtemp, 0, '任何拒绝路径都不得触达创建原语');
    assert.equal(calls.writes, 0, '任何拒绝路径都不得发生写入');
    assert.equal(fs.existsSync(path.join(repoRoot, 'farm-x-')), false, '仓库内零残留');
    // 合法独立临时目录仍可创建：恰好一次真实创建且位于系统临时目录内
    const okDir = createPrivateDataDir('farm-x-ok-');
    assert.ok(isInsideOrEqualDir(okDir, realRoot), '合法路径创建于系统临时目录内');
    assert.equal(calls.mkdtemp, 1, '合法路径恰好一次真实创建');
    fs.rmSync(okDir, { recursive: true, force: true });
});
