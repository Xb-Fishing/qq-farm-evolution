'use strict';
// 重点名单陈旧目标治理——行为矩阵（2026-10-07）。
//
// 覆盖（与实现批验收一一对应）：
//   1. 严格双条件分类（isServerBusinessError + 严格十进制 1002002）
//   2. 尾随三次暂停状态机：只累计严格 1002002 真实 Enter 失败；其它结局
//      清零尾随；真实 Enter 成功清全部；多目标互不影响
//   3. 暂停门豁免：在线 / 活跃证据 / 观察窗 / 施肥 HOT 放行（只拦普通基线）
//   4. 真实进门路径记账：visitFriendForSteal 携带实际结局与发起代次；
//      复用哨兵预进门不重复记账；非重点目标 no-op；手动通道照常进门
//   5. 代次隔离：remove-re-add / 恢复意图后在途旧结果不得改写新状态
//   6. 用户意图：单调 opSeq、幂等消费、旧意图不可回退；reconcile 推进
//      consumedOpSeq；新意图覆盖旧镜像；版本相等的自然恢复丢失时旧暂停
//      如实重现（豁免通道仍可用）
//   7. 重启播种：尾随计数钳制（LIMIT-1），再暂停阈值 3−count
//   8. 状态推送：内容不变不重推；发送失败下次变更自动重试
//   9. store 意图持久化：一次保存落名单+意图；opSeq 单调；快照无共享
//      引用；applyConfigSnapshot/buildConfigSnapshotForAccount 两条链路；
//      保存失败回滚（有旧值恢复 / 无旧值删除）
//  10. 镜像：缺失/损坏读取返回 null 且不建目录不写文件；写入回读往返；
//      账号分文件
//  11. Worker 接线（源序）：播种先于首次配置应用；reconcile 在配置应用
//      之后；哨兵预进门代次先取后发、Strike 透传
//  12. Worker 管理器镜像分支：结构校验、落盘、写失败保留最后好快照、
//      旧代次迟到消息被身份守卫丢弃
//  13. 管理路由：GET 冷缓存零上游依赖零目录创建；toggle/resume/remove
//      本地构建响应；保存失败不广播且回滚名单；黑名单/自动捣乱保持原状
//  14. 真实 startBot 重启链（fork 隔离）：快照计数 0 / 计数 2 / 自然恢复
//      丢失 / 较新恢复意图已保存四边界，经真实 onMasterMessage('start')
//      → startBot → 播种镜像 → applyRuntimeConfig 链验收（自反证基线
//      文件迁入：本文件只在当前候选上运行，不参与旧代码反证登记）
//  15. 夹具边界：临时根/创建目标越界在任何创建原语前拒绝（零创建零
//      写入）；直接写/删目标解析后校验，越界目标写入前拒绝且零写入
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

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
const privateDir = createPrivateDataDir('farm-watchlist-stale-');
process.env.FARM_DATA_DIR = privateDir;
process.env.FARM_ACCOUNT_ID = 'stale-acct';
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

// 推送边界：真实 friend-api 模块上的 postToMaster 替换（orchestrator 在
// require 时解构捕获，必须在加载 orchestrator 之前替换）
const apiModule = require('../src/services/friend-api');
const pushCalls = [];
let pushOk = true;
apiModule.postToMaster = msg => { pushCalls.push(msg); return pushOk; };

// 调度器边界：空任务表——巡田环武装后不留真实定时器挂住测试进程
const schedulerModule = require('../src/services/scheduler');
schedulerModule.createScheduler = () => ({
    setTimeoutTask() {}, setIntervalTask() {}, clear() {}, clearAll() {},
});

const store = require('../src/models/store');
const watch = require('../src/services/fertilizer-watch');
const { classifyPrecheckFailure } = require('../src/services/friend-api');
const orchestrator = require('../src/services/friend-orchestrator');
const { getDataFile } = require('../src/config/runtime-paths');

const MIRROR_DIR = getDataFile('watchlist_state_mirror');
// 镜像目录在独立数据目录内（所有直接写/删目标都落在其下）
assertWriteInsidePrivateDir(MIRROR_DIR);

test.after(() => {
    assert.deepEqual(fingerprintCandidateSources(), candidateSourcesBefore,
        '候选源码内容与权限在成功与失败路径全程不得改变');
    fs.rmSync(assertWriteInsidePrivateDir(privateDir), { recursive: true, force: true });
});
const staleRejection = () => Object.assign(
    new Error('不是好友无法拜访 code=1002002'),
    { isServerBusinessError: true, serverErrorCode: '1002002' },
);
const now = 1_800_000_000_000;

test.afterEach(() => {
    orchestrator.resetWatchlistPauseStateForTests();
    watch.resetFertilizerWatchForTests();
    pushCalls.length = 0;
    pushOk = true;
});

function snapshotRow(gid) {
    return orchestrator.getWatchlistStateSnapshot().rows[String(gid)] || null;
}

async function rejectStale(gid, times = 1) {
    for (let i = 0; i < times; i++) {
        orchestrator.applyWatchlistEnterError(orchestrator.noteWatchlistEnterAttempt(gid), staleRejection());
    }
}

// ==================== 夹具边界反例 ====================

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

test('夹具写边界：越界目标在写入前被拒绝且零写入', () => {
    const escaped = path.resolve(privateDir, '..', 'farm-watchlist-stale-escape.json');
    assert.throws(() => assertWriteInsidePrivateDir(escaped), /越界/);
    assert.equal(fs.existsSync(escaped), false, '越界目标必须零写入');
    // 相对路径基点错误（解析回候选源码）同样必须拒绝
    assert.throws(() => assertWriteInsidePrivateDir(path.join(repoRoot, 'core/src/models/store.js')), /越界/);
    assert.equal(fs.existsSync(path.join(repoRoot, 'core/src/models/store.js')), true, '候选源码保持原状');
    // 合法目标放行并返回解析后路径
    const inside = path.join(privateDir, 'nested/deep/file.json');
    assert.equal(assertWriteInsidePrivateDir(inside), path.resolve(inside));
});

// ==================== 1. 分类矩阵 ====================

test('分类矩阵：仅业务错误标记 + 严格十进制安全正整数才给业务码', () => {
    const business = code => ({ isServerBusinessError: true, serverErrorCode: code });
    assert.deepEqual(classifyPrecheckFailure(business('1002002')), { category: 'business', code: 1002002 });
    assert.deepEqual(classifyPrecheckFailure(business(1002002)), { category: 'business', code: 1002002 });
    // 非严格十进制/非正整数/超安全范围 → unknown
    for (const bad of ['0x10', '1e2', ' 1002002', '1002002a', '', 0, -1, 1.5, '1002002.0', Number.NaN, Infinity, 2 ** 53]) {
        const info = classifyPrecheckFailure(business(bad));
        assert.equal(info.category, 'business', `${String(bad)} 仍属业务类`);
        assert.equal(info.code, 'unknown', `${String(bad)} 不得记为业务码`);
    }
    // 无业务标记 → 传输类
    for (const transport of [new Error('timeout'), { serverErrorCode: '1002002' },
        { isServerBusinessError: 'true', serverErrorCode: '1002002' },
        { isServerBusinessError: 1, serverErrorCode: '1002002' }, null]) {
        assert.deepEqual(classifyPrecheckFailure(transport), { category: 'transport', code: 'unknown' });
    }
    // 其它业务码：是业务错误但不是陈旧码
    assert.deepEqual(classifyPrecheckFailure(business('1002003')), { category: 'business', code: 1002003 });
});

// ==================== 2. 尾随三次暂停状态机 ====================

test('只有严格 1002002 真实 Enter 失败累计；其它结局清零；成功清全部；目标独立', () => {
    watch.setPriorityGids([501, 502]);
    // 六个到期轮模拟：1-3 发起被拒，第 3 次后暂停，4-6 被门拦下
    //（remain 3h 在默认 122 分钟观察窗之外，走普通基线语义）
    for (let round = 1; round <= 6; round++) {
        const paused = orchestrator.isWatchlistBaselinePaused(501, now, 3 * 3600_000, {});
        if (round <= 3) {
            assert.equal(paused, false, `第 ${round} 轮之前不得暂停`);
            orchestrator.applyWatchlistEnterError(orchestrator.noteWatchlistEnterAttempt(501), staleRejection());
        } else {
            assert.equal(paused, true, `第 ${round} 轮必须已被暂停门拦下`);
        }
    }
    const row = snapshotRow(501);
    assert.equal(row.paused, true);
    assert.equal(row.trailingFailures, 3);
    assert.equal(row.pausedAt > 0, true);

    // 其它目标不受连坐
    assert.equal(snapshotRow(502), null);
    assert.equal(orchestrator.isWatchlistBaselinePaused(502, now, 3600_000, {}), false);

    // 其它真实结局（超时/传输/其它业务码）清零尾随；已暂停保持暂停（粘性）
    orchestrator.applyWatchlistEnterError(orchestrator.noteWatchlistEnterAttempt(501),
        Object.assign(new Error('请求超时'), { isServerBusinessError: true, serverErrorCode: '1002003' }));
    let after = snapshotRow(501);
    assert.equal(after.trailingFailures, 0, '非陈旧码结局清零尾随');
    assert.equal(after.paused, true, '暂停粘性：恢复只能来自真实成功或用户意图');

    // 未暂停时尾随清零可见：501 重新累计 2 次后传输错误清零
    orchestrator.applyWatchlistIntent(501, 1); // 恢复（清暂停），appliedIntentOpSeq=1
    rejectStale(501, 2);
    assert.equal(snapshotRow(501).trailingFailures, 2);
    orchestrator.applyWatchlistEnterError(orchestrator.noteWatchlistEnterAttempt(501), new Error('连接未打开'));
    assert.equal(snapshotRow(501).trailingFailures, 0, '传输失败同样只清零不累计');

    // 真实 Enter 成功：尾随与暂停一并清除（自然恢复）
    rejectStale(501, 3);
    assert.equal(snapshotRow(501).paused, true);
    orchestrator.applyWatchlistEnterSuccess(orchestrator.noteWatchlistEnterAttempt(501));
    after = snapshotRow(501);
    assert.equal(after.paused, false);
    assert.equal(after.trailingFailures, 0);
    assert.equal(after.pausedAt, 0);
    assert.equal(orchestrator.isWatchlistBaselinePaused(501, now, 3 * 3600_000, {}), false);
});

// ==================== 3. 暂停门豁免通道 ====================

test('暂停门只拦普通基线：在线/活跃证据/观察窗/施肥 HOT 放行', () => {
    watch.setPriorityGids([501]);
    rejectStale(501, 3);
    assert.equal(orchestrator.isWatchlistBaselinePaused(501, now, 3 * 3600_000, {}), true, '无证据时拦基线');
    assert.equal(orchestrator.isWatchlistBaselinePaused(501, now, 3 * 3600_000, { onlineNow: true }), false);
    assert.equal(orchestrator.isWatchlistBaselinePaused(501, now, 3 * 3600_000, { activityEvidence: true }), false);
    // 观察窗：remain 落在唤醒窗口内（默认约 122 分钟）
    assert.equal(orchestrator.isWatchlistBaselinePaused(501, now, 60 * 60_000, {}), false, '观察窗内放行');
    assert.equal(orchestrator.isWatchlistBaselinePaused(501, now, 0, {}), true, '无墙钟仍拦');
    // 施肥 HOT：成熟点前移（600→594）触发的 summary_ripe_advanced 造出 HOT
    // 后放行（盯梢武装以 store 名单为准；查询用真实墙钟）
    store.setWatchlistFriendGids('stale-acct', [501]);
    const fixture = sec => [{ gid: 501, name: 'stale-fixture', plant: { ripe_time_sec: sec } }];
    orchestrator.applyStealScheduleFromFriends(fixture(600), { myGid: 1, blacklist: new Set() });
    orchestrator.applyStealScheduleFromFriends(fixture(594), { myGid: 1, blacklist: new Set() });
    const at = Date.now();
    const state = watch.getWatchStateForTests(501, at);
    assert.equal(state.status, watch.WATCH_STATUS.HOT, '成熟临近应进入施肥 HOT');
    assert.equal(orchestrator.isWatchlistBaselinePaused(501, at, 3 * 3600_000, {}), false, 'HOT 放行');
});

// ==================== 4. 真实进门路径记账（visitFriendForSteal） ====================

// require-cache 替换 friend-api 后重载真实 friend-visit（既有测试技法）：
// 其余依赖全部为真实模块，惰性 require('./friend-orchestrator') 落到
// 本文件已加载的真实状态机实例上。
function withVisitStubApi(enterImpl, fn) {
    const visitPath = require.resolve('../src/services/friend-visit');
    const apiPath = require.resolve('../src/services/friend-api');
    const origVisit = require.cache[visitPath];
    const origApi = require.cache[apiPath];
    const enters = [];
    const stub = {
        enterFriendFarm: async gid => { enters.push(Number(gid)); return enterImpl(gid); },
        leaveFriendFarm: async () => {},
        checkCanOperateRemote: async () => ({ canOperate: true }),
        handleFriendEnterError: () => ({ handled: false }),
    };
    require.cache[apiPath] = { id: apiPath, filename: apiPath, loaded: true, exports: stub };
    delete require.cache[visitPath];
    return Promise.resolve(fn(require(visitPath))).finally(() => {
        if (origVisit) require.cache[visitPath] = origVisit;
        else delete require.cache[visitPath];
        if (origApi) require.cache[apiPath] = origApi;
        else delete require.cache[apiPath];
    }).then(result => ({ result, enters }));
}

test('visitFriendForSteal 记账：真实失败/成功/复用/非重点四态', async () => {
    watch.setPriorityGids([602]);
    const tally = () => ({ steal: 0, water: 0, weed: 0, bug: 0, putBug: 0, putWeed: 0 });

    // 真实 Enter 被拒：结果携带 failed + 发起代次，状态机累计
    let h = await withVisitStubApi(() => { throw staleRejection(); },
        visit => visit.visitFriendForSteal({ gid: 602, name: 'B' }, tally(), 1, 'stale-acct'));
    assert.equal(h.result.entered, false);
    assert.equal(h.result.enterOutcome, 'failed');
    assert.ok(h.result.enterEpoch > 0, '真实发起必须携带代次');
    assert.deepEqual(h.enters, [602]);
    assert.equal(snapshotRow(602).trailingFailures, 1);

    // 真实 Enter 成功：entered + real，清计数（手动通道暂停期间照常可用）
    rejectStale(602, 2); // 累计到 3 → 暂停
    assert.equal(snapshotRow(602).paused, true);
    h = await withVisitStubApi(() => ({ at_home: true, basic: { last_online: 0 }, lands: [] }),
        visit => visit.visitFriendForSteal({ gid: 602, name: 'B' }, tally(), 1, 'stale-acct'));
    assert.equal(h.result.entered, true);
    assert.equal(h.result.enterOutcome, 'real');
    assert.equal(h.result.ripeAtMs, 0);
    const cleared = snapshotRow(602);
    assert.equal(cleared.paused, false, '手动通道真实进场成功即自然恢复');
    assert.equal(cleared.trailingFailures, 0);

    // 复用哨兵预进门：不再发 Enter、不重复记账，只透传该次代次
    const before = orchestrator.getWatchlistStateSnapshot();
    h = await withVisitStubApi(() => { throw new Error('must not enter'); },
        visit => visit.visitFriendForSteal({ gid: 602, name: 'B' }, tally(), 1, 'stale-acct',
            { preEnter: { gid: 602, enterReply: { at_home: true, basic: { last_online: 0 }, lands: [] }, epochAtSend: 7 } }));
    assert.deepEqual(h.enters, [], '复用分支不得再发 Enter');
    assert.equal(h.result.enterOutcome, 'reused');
    assert.equal(h.result.enterEpoch, 7);
    assert.equal(JSON.stringify(orchestrator.getWatchlistStateSnapshot()), JSON.stringify(before),
        '复用分支不得改写暂停状态');

    // 非重点目标：真实 Enter 照常执行，记账 no-op
    h = await withVisitStubApi(() => ({ at_home: true, basic: { last_online: 0 }, lands: [] }),
        visit => visit.visitFriendForSteal({ gid: 603, name: 'C' }, tally(), 1, 'stale-acct'));
    assert.equal(h.result.enterOutcome, 'real');
    assert.equal(h.result.enterEpoch, 0, '非重点目标无代次');
    assert.equal(snapshotRow(603), null);
});

// ==================== 5. 代次隔离 ====================

test('代次隔离：意图生效与名单重加后在途旧 Enter 结果不改写新状态', () => {
    watch.setPriorityGids([501]);
    store.setWatchlistConfig('stale-acct', [501], undefined);
    rejectStale(501, 3);
    assert.equal(snapshotRow(501).paused, true);

    // 恢复意图前发起的旧 Enter 结果（旧代次）不得把恢复后的状态改回暂停
    const staleAttempt = orchestrator.noteWatchlistEnterAttempt(501);
    orchestrator.applyWatchlistIntent(501, 1);
    assert.equal(snapshotRow(501).paused, false);
    orchestrator.applyWatchlistEnterError(staleAttempt, staleRejection());
    assert.equal(snapshotRow(501).paused, false, '旧代次失败结果必须丢弃');
    assert.equal(snapshotRow(501).trailingFailures, 0);

    // 移出名单：reconcile 清行并前移代次，迟到的旧失败不得复活该行；
    // 重新加回后不继承任何旧暂停状态
    const inFlight = orchestrator.noteWatchlistEnterAttempt(501);
    rejectStale(501, 3);
    store.setWatchlistConfig('stale-acct', [], [501]); // 移除（显式意图）
    orchestrator.reconcileWatchlistIntents();
    assert.equal(snapshotRow(501), null, '移出后行必须清掉');
    orchestrator.applyWatchlistEnterError(inFlight, staleRejection());
    assert.equal(snapshotRow(501), null, '旧代次结果不得复活已清行');

    store.setWatchlistConfig('stale-acct', [501], undefined); // 差集自动登记加回意图
    orchestrator.reconcileWatchlistIntents();
    const reborn = snapshotRow(501);
    assert.ok(reborn, '加回后行为新行');
    assert.equal(reborn.paused, false, 'remove-re-add 不继承旧暂停');
    assert.equal(reborn.trailingFailures, 0);
    // 新代次记账恢复正常
    orchestrator.applyWatchlistEnterError(orchestrator.noteWatchlistEnterAttempt(501), staleRejection());
    assert.equal(snapshotRow(501).trailingFailures, 1);
});

// ==================== 6. 用户意图与 reconcile ====================

test('意图消费：单调/幂等/不可回退；reconcile 推进版本；新意图覆盖旧镜像', () => {
    // store 配置隔离：独立账号（reconcile 读 FARM_ACCOUNT_ID），避免上个
    // 测试留下的 opSeq 影响单调断言
    const prevAccount = process.env.FARM_ACCOUNT_ID;
    process.env.FARM_ACCOUNT_ID = 'intent-acct';
    try {
    watch.setPriorityGids([502]);

    // reconcile：先应用意图，全部应用后才推进整体已消费版本
    store.setWatchlistConfig('intent-acct', [502], [502]); // opSeq=1 意图
    orchestrator.reconcileWatchlistIntents();
    const snap = orchestrator.getWatchlistStateSnapshot();
    assert.equal(snap.consumedOpSeq, 1);
    assert.equal(snapshotRow(502).appliedIntentOpSeq, 1);
    // 重复 reconcile 无新内容：不推进不重推
    const pushesBefore = pushCalls.length;
    orchestrator.reconcileWatchlistIntents();
    assert.equal(orchestrator.getWatchlistStateSnapshot().consumedOpSeq, 1);
    assert.equal(pushCalls.length, pushesBefore, '无变更不得重推');

    // 新意图覆盖旧镜像：重启播种了 paused 旧状态，但配置侧意图更新 → 恢复
    orchestrator.resetWatchlistPauseStateForTests();
    watch.setPriorityGids([502]);
    orchestrator.seedWatchlistStateFromMirror({
        version: 1,
        consumedOpSeq: 1,
        rows: { 502: { trailingFailures: 2, paused: true, pausedAt: now, appliedIntentOpSeq: 1 } },
    });
    assert.equal(snapshotRow(502).paused, true, '播种恢复旧暂停');
    store.setWatchlistConfig('intent-acct', [502], [502]); // opSeq=2 恢复意图
    orchestrator.reconcileWatchlistIntents();
    assert.equal(snapshotRow(502).paused, false, '更新的意图必须胜过旧镜像');
    assert.equal(orchestrator.getWatchlistStateSnapshot().consumedOpSeq, 2);

    // 版本相等的自然恢复推送丢失：重启后旧暂停如实重现，豁免通道仍可用
    orchestrator.resetWatchlistPauseStateForTests();
    watch.setPriorityGids([502]);
    store.setWatchlistConfig('intent-acct', [502], [502]); // opSeq=3（Worker 尚未消费）
    orchestrator.reconcileWatchlistIntents();
    assert.equal(orchestrator.getWatchlistStateSnapshot().consumedOpSeq, 3);
    rejectStale(502, 3); // 再次暂停
    const lastPush = pushCalls[pushCalls.length - 1];
    assert.equal(lastPush.type, 'watchlist_state_sync');
    assert.equal(lastPush.accountId, 'intent-acct');
    assert.equal(lastPush.state.rows['502'].paused, true);
    // 模拟：这条恢复推送丢失 + Worker 重启（镜像停留在 paused、版本已消费）
    orchestrator.resetWatchlistPauseStateForTests();
    watch.setPriorityGids([502]);
    orchestrator.seedWatchlistStateFromMirror(lastPush.state);
    assert.equal(snapshotRow(502).paused, true, '无新意图时旧暂停如实重现');
    assert.equal(orchestrator.isWatchlistBaselinePaused(502, now, 3600_000, { onlineNow: true }), false,
        '重现的暂停不拦豁免通道');

    // 幂等与回退（收尾：直接消费会推进已消费版本，放在版本断言之后）
    assert.equal(orchestrator.applyWatchlistIntent(502, 5), true);
    assert.equal(orchestrator.applyWatchlistIntent(502, 5), false, '重复消费幂等');
    assert.equal(orchestrator.applyWatchlistIntent(502, 3), false, '旧意图不可回退');
    assert.equal(orchestrator.applyWatchlistIntent(502, 0), false, '非法版本拒绝');
    } finally {
        process.env.FARM_ACCOUNT_ID = prevAccount;
    }
});

// ==================== 7. 重启播种边界 ====================

test('重启播种：尾随钳制 LIMIT-1；再暂停阈值 3−count（0 与 2 两例）', () => {
    watch.setPriorityGids([511, 512, 513]);
    // 钳制：镜像里的超大尾随只恢复到 LIMIT-1（count=2）
    orchestrator.seedWatchlistStateFromMirror({
        version: 1, consumedOpSeq: 0,
        rows: { 511: { trailingFailures: 99, paused: false, pausedAt: 0, appliedIntentOpSeq: 0 } },
    });
    assert.equal(snapshotRow(511).trailingFailures, 2, '尾随恢复钳制到 2');
    // 播种只生效一次：第二次调用被忽略
    orchestrator.seedWatchlistStateFromMirror({ version: 1, consumedOpSeq: 9, rows: {} });
    assert.equal(orchestrator.getWatchlistStateSnapshot().consumedOpSeq, 0, '二次播种忽略');

    // count=2（钳制后）：一次新拒绝即再暂停
    rejectStale(511, 1);
    assert.equal(snapshotRow(511).paused, true, 'count=2 时一次拒绝即再暂停');

    // count=0（无播种行）：需要 3 次新拒绝才暂停
    rejectStale(513, 2);
    assert.equal(snapshotRow(513).paused, false, 'count=0 时两次拒绝不暂停');
    rejectStale(513, 1);
    assert.equal(snapshotRow(513).paused, true, '第三次拒绝暂停');

    // 镜像缺失/损坏：按空状态启动，不抛错
    orchestrator.resetWatchlistPauseStateForTests();
    orchestrator.seedWatchlistStateFromMirror(null);
    orchestrator.seedWatchlistStateFromMirror('corrupt');
    assert.deepEqual(orchestrator.getWatchlistStateSnapshot().rows, {});
});

// ==================== 8. 状态推送纪律 ====================
// 重启闭环验收见文末「真实 startBot 重启链」一节：四例 fork 真实 worker
// 子进程，经真实 onMasterMessage('start') → startBot → 播种镜像 →
// applyRuntimeConfig 链执行（本文件第 11 节只保留源序断言）。

test('推送：内容不变不重推；发送失败下次变更自动重试', () => {
    watch.setPriorityGids([521]);
    rejectStale(521, 1);
    assert.equal(pushCalls.length, 1, '尾随 1 变更推送一次');
    // 同内容无变更操作（重复成功结算 / 幂等意图）不重推
    orchestrator.applyWatchlistEnterSuccess(null);
    orchestrator.applyWatchlistIntent(521, 0);
    assert.equal(pushCalls.length, 1);

    // 发送失败：不阻塞业务，下次状态变更自动重试
    pushOk = false;
    rejectStale(521, 1); // 尾随 2（内容变更）
    assert.equal(pushCalls.length, 2, '失败后内容变更仍尝试推送');
    pushOk = true;
    rejectStale(521, 1); // 尾随 3 → 暂停
    assert.equal(pushCalls.length, 3);
    assert.equal(pushCalls[2].state.rows['521'].paused, true);
    // 状态推送只在真实变更时发生：配置侧恢复意图经 reconcile 生效后推送；
    // 紧随的无变更 reconcile 不得全表重推（独立账号避免串号）
    const prevAccount = process.env.FARM_ACCOUNT_ID;
    process.env.FARM_ACCOUNT_ID = 'push-acct';
    try {
        store.setWatchlistConfig('push-acct', [521], [521]);
        orchestrator.reconcileWatchlistIntents();
        assert.equal(pushCalls.length, 4, '真实变更（意图生效）推送');
        orchestrator.reconcileWatchlistIntents();
        assert.equal(pushCalls.length, 4, '无变更不得重推');
    } finally {
        process.env.FARM_ACCOUNT_ID = prevAccount;
    }
});

// ==================== 9. store 意图持久化 ====================

test('store：一次保存落名单+意图；opSeq 单调；快照无共享引用；两条快照链', () => {
    const acct = 'store-acct';
    // 计数：包一层 fs.writeFileSync（保持原实现）
    const counter = { n: 0 };
    const origWrite = fs.writeFileSync;
    fs.writeFileSync = (...args) => { if (String(args[0]).includes('store.json')) counter.n++; return origWrite.apply(fs, args); };
    try {
        store.setWatchlistConfig(acct, [601], [601]);
    } finally {
        fs.writeFileSync = origWrite;
    }
    assert.equal(counter.n, 1, '名单+意图必须一次配置保存完成');
    assert.deepEqual(store.getWatchlistFriendGids(acct), [601]);
    assert.deepEqual(store.getWatchlistResetMeta(acct), { opSeq: 1, intents: { 601: 1 } });

    // opSeq 单调：无意图变化不递增；意图变化递增
    store.setWatchlistConfig(acct, [601], undefined); // 同名单：diff 为空
    assert.equal(store.getWatchlistResetMeta(acct).opSeq, 1, '无意图变更不递增');
    store.setWatchlistConfig(acct, [], [601]); // 移除意图
    let meta = store.getWatchlistResetMeta(acct);
    assert.equal(meta.opSeq, 2);
    assert.deepEqual(meta.intents, { 601: 2 });
    store.setWatchlistConfig(acct, [601, 602], undefined); // 差集自动登记 [601,602]（重新加入/新增）
    meta = store.getWatchlistResetMeta(acct);
    assert.equal(meta.opSeq, 3);
    assert.deepEqual(meta.intents, { 601: 3, 602: 3 }, '加回与新增目标都登记意图');

    // 快照无共享嵌套引用：两次快照互不影响，改返回值不腐蚀存储
    const s1 = store.getConfigSnapshot(acct);
    const s2 = store.getConfigSnapshot(acct);
    assert.notEqual(s1.watchlistResetMeta, s2.watchlistResetMeta);
    assert.notEqual(s1.watchlistResetMeta.intents, s2.watchlistResetMeta.intents);
    s1.watchlistResetMeta.intents[601] = 999;
    assert.equal(store.getWatchlistResetMeta(acct).intents[601], 3, '外部修改不得写回存储');

    // applyConfigSnapshot 链：Worker 配置应用路径
    store.applyConfigSnapshot({ watchlistResetMeta: { opSeq: 8, intents: { 602: 8 } } }, { accountId: acct });
    assert.equal(store.getWatchlistResetMeta(acct).opSeq, 8);
    // buildConfigSnapshotForAccount 链：主进程下发路径
    const runtimeState = require('../src/runtime/runtime-state').createRuntimeState({ store });
    const built = runtimeState.buildConfigSnapshotForAccount(acct);
    assert.equal(built.watchlistResetMeta.opSeq, 8);
    assert.deepEqual(built.watchlistResetMeta.intents, { 602: 8 });
    assert.notEqual(built.watchlistResetMeta, store.getWatchlistResetMeta(acct));
});

test('store：保存失败回滚（有旧值恢复/无旧值删除）且内存保持旧值', () => {
    const acct = 'rollback-acct';
    store.setWatchlistConfig(acct, [611], [611]); // 先成功保存（有旧值）
    const before = store.getWatchlistResetMeta(acct);

    const origWrite = fs.writeFileSync;
    fs.writeFileSync = () => { throw new Error('disk full'); };
    try {
        assert.throws(() => store.setWatchlistConfig(acct, [612], [612]), /disk full/);
    } finally {
        fs.writeFileSync = origWrite;
    }
    assert.deepEqual(store.getWatchlistFriendGids(acct), [611], '名单回滚到旧值');
    assert.deepEqual(store.getWatchlistResetMeta(acct), before, '意图元数据回滚到旧值');

    // 无旧值账号：失败后不残留半套元数据
    const fresh = 'rollback-fresh';
    fs.writeFileSync = () => { throw new Error('disk full'); };
    try {
        assert.throws(() => store.setWatchlistConfig(fresh, [613], [613]), /disk full/);
    } finally {
        fs.writeFileSync = origWrite;
    }
    assert.deepEqual(store.getWatchlistFriendGids(fresh), []);
    assert.equal(store.getWatchlistResetMeta(fresh), null);
});

// ==================== 10. 镜像读取 ====================

test('镜像：缺失/损坏读取返回 null 且不建目录不写文件；写入回读往返；账号分文件', () => {
    // 缺失：连目录都不建
    fs.rmSync(assertWriteInsidePrivateDir(MIRROR_DIR), { recursive: true, force: true });
    assert.equal(store.readWatchlistStateMirror('mirror-acct'), null);
    assert.equal(fs.existsSync(MIRROR_DIR), false, '读取不得创建目录');

    // 写入 → 回读往返
    const state = { version: 1, consumedOpSeq: 4, rows: { 701: { trailingFailures: 2, paused: true, pausedAt: now, appliedIntentOpSeq: 3 } } };
    assert.equal(store.writeWatchlistStateMirror('mirror-acct', state), true);
    assert.deepEqual(store.readWatchlistStateMirror('mirror-acct'), state);

    // 账号分文件
    const other = { version: 1, consumedOpSeq: 0, rows: {} };
    store.writeWatchlistStateMirror('mirror-acct-2', other);
    assert.deepEqual(store.readWatchlistStateMirror('mirror-acct-2'), other);
    assert.notDeepEqual(store.readWatchlistStateMirror('mirror-acct'), other);

    // 损坏：null，且不产生新文件
    const filesBefore = fs.readdirSync(MIRROR_DIR).sort().join(',');
    const corruptFile = path.join(MIRROR_DIR, 'mirror-corrupt.json');
    fs.writeFileSync(assertWriteInsidePrivateDir(corruptFile), '{oops', 'utf8');
    const filesWithCorrupt = fs.readdirSync(MIRROR_DIR).sort().join(',');
    assert.equal(store.readWatchlistStateMirror('mirror-corrupt'), null);
    assert.equal(fs.readdirSync(MIRROR_DIR).sort().join(','), filesWithCorrupt, '损坏读取不新增文件');
    assert.notEqual(filesWithCorrupt, filesBefore);
});

// ==================== 11. Worker 接线（源序断言） ====================

function sourceFunction(source, name) {
    const declarations = [...source.matchAll(/^(?:async )?function (\w+)\(/gm)];
    const index = declarations.findIndex(match => match[1] === name);
    assert.ok(index >= 0, `production function ${name} exists`);
    return source.slice(declarations[index].index, declarations[index + 1]?.index || source.length);
}

test('worker 接线：播种先于首次配置应用；reconcile 紧随配置应用；哨兵代次先取后发', () => {
    const workerSource = fs.readFileSync(path.join(__dirname, '../src/core/worker.js'), 'utf8');
    const startBot = sourceFunction(workerSource, 'startBot');
    const seedAt = startBot.indexOf('seedWatchlistStateFromMirror');
    const configAt = startBot.indexOf('applyRuntimeConfig(getConfigSnapshot(), false)');
    assert.ok(seedAt >= 0 && configAt >= 0 && seedAt < configAt,
        'startBot 必须在首次 applyRuntimeConfig 之前播种镜像（否则已消费意图被旧镜像回滚）');
    assert.ok(startBot.slice(seedAt).includes('readWatchlistStateMirror'), '播种数据来自镜像读取');

    const applyRuntime = sourceFunction(workerSource, 'applyRuntimeConfig');
    const applyAt = applyRuntime.indexOf('applyConfigSnapshot');
    const reconcileAt = applyRuntime.indexOf('reconcileWatchlistIntents');
    assert.ok(applyAt >= 0 && reconcileAt >= 0 && applyAt < reconcileAt,
        'reconcile 必须在 applyConfigSnapshot 完成配置应用之后执行');

    const arm = sourceFunction(workerSource, 'armSentinelPreEnter');
    assert.ok(arm.includes('sentinelPreEnter = { gid, dueAt, enteredAt: Date.now(), enterReply };'),
        '哨兵驻留标记原始字段保持不变');
    assert.ok(arm.includes('sentinelPreEnter.epochAtSend = wlAttempt ? wlAttempt.epoch : 0;'));
    const noteAt = arm.indexOf('noteWatchlistEnterAttempt');
    const sendAt = arm.indexOf('enterFriendFarm(gid)');
    assert.ok(noteAt >= 0 && sendAt >= 0 && noteAt < sendAt, '代次必须在 await Enter 之前取');
    const strike = sourceFunction(workerSource, 'runSentinelStrike');
    assert.ok(strike.includes('epochAtSend: Number(preEnter.epochAtSend) || 0'),
        'Strike 复用分支必须透传发起代次');
});

// ==================== 12. Worker 管理器镜像分支 ====================

function managerHarness(t) {
    // worker-manager 顶层解构 createScheduler：先 mock 再惰性 require，
    // 避免 watchdog 30s 真实定时器挂住测试进程
    const schedulerModule = require('../src/services/scheduler');
    t.mock.method(schedulerModule, 'createScheduler', () => ({
        setTimeoutTask() {}, setIntervalTask() {}, clear() {}, clearAll() {},
    }));
    const { createWorkerManager } = require('../src/runtime/worker-manager');
    class FakeWorker extends EventEmitter {
        constructor() { super(); this.exitCode = undefined; this.signalCode = undefined; }
        postMessage() {}
        kill() {}
    }
    const logs = [];
    const workers = {};
    const mgr = createWorkerManager({
        fork: () => { throw new Error('fork 不应被使用'); },
        WorkerThread: FakeWorker,
        runtimeMode: 'thread',
        processRef: { env: {}, pkg: false },
        mainEntryPath: '', workerScriptPath: 'fixture-worker.js',
        workers, globalLogs: [],
        log: (tag, message, meta) => logs.push({ tag, message, meta }),
        addAccountLog() {},
        normalizeStatusForPanel: data => data,
        buildConfigSnapshotForAccount: () => ({}),
        getOfflineAutoDeleteMs: () => Infinity,
        triggerOfflineReminder() {}, addOrUpdateAccount() {},
        getAccounts: () => ({ accounts: [{ id: 'mgr-acct', name: 'A', code: 'x', platform: 'qq' }] }),
        deleteAccount() {}, scheduleAutoRelogin() {}, scheduleKickoutRelogin() {},
        scheduleAccountRefresh() {}, stopAccountRefresh() {},
        refreshAccountCode: async () => false, updateSystemClientVersion() {},
        onStatusSync() {}, onWorkerLog() {},
    });
    return { mgr, workers, logs };
}

const validState = { version: 1, consumedOpSeq: 2, rows: { 801: { trailingFailures: 1, paused: false, pausedAt: 0, appliedIntentOpSeq: 0 } } };

test('manager 镜像分支：结构校验落盘；畸形丢弃；写失败保留最后好快照；旧代次消息被守卫丢弃', t => {
    const { mgr, workers, logs } = managerHarness(t);
    assert.equal(mgr.startWorker({ id: 'mgr-acct', name: 'A', code: 'x', platform: 'qq' }), true);
    const wrk = workers['mgr-acct'];
    assert.ok(wrk && wrk.process);

    const writeMock = t.mock.method(store, 'writeWatchlistStateMirror');
    // 合法状态 → 落盘
    wrk.process.emit('message', { type: 'watchlist_state_sync', state: validState });
    assert.equal(writeMock.mock.calls.length, 1);
    assert.deepEqual(writeMock.mock.calls[0].arguments, ['mgr-acct', validState]);

    // 畸形状态：按丢弃处理，不落盘不抛错
    for (const bad of [null, { version: 2, rows: {}, consumedOpSeq: 0 },
        { version: 1, rows: [], consumedOpSeq: 0 }, { version: 1, rows: {}, consumedOpSeq: 'x' },
        { version: 1, rows: {}, consumedOpSeq: Infinity }, { rows: {}, consumedOpSeq: 1 }]) {
        wrk.process.emit('message', { type: 'watchlist_state_sync', state: bad });
    }
    assert.equal(writeMock.mock.calls.length, 1, '畸形状态不得写盘');
    writeMock.mock.restore();

    // 磁盘写失败（fs 底层原语注入，保留真实保存函数的 false 返回语义）：
    // 真实 writeWatchlistStateMirror 吞掉异常返回 false，管理器必须识别并记
    // 诊断；镜像文件保留最后一份好快照
    const goodState = { version: 1, consumedOpSeq: 5, rows: { 801: { trailingFailures: 2, paused: true, pausedAt: now, appliedIntentOpSeq: 4 } } };
    store.writeWatchlistStateMirror('mgr-acct', goodState);
    const origWriteSync = fs.writeFileSync;
    fs.writeFileSync = (target, ...args) => {
        if (String(target).includes('mgr-acct')) throw new Error('disk full');
        return origWriteSync.call(fs, target, ...args);
    };
    try {
        wrk.process.emit('message', { type: 'watchlist_state_sync', state: { version: 1, consumedOpSeq: 6, rows: {} } });
    } finally {
        fs.writeFileSync = origWriteSync;
    }
    assert.ok(logs.some(row => row.tag === '错误' && row.message.includes('镜像写入失败')), 'false 返回必须记诊断');
    assert.ok(logs.some(row => row.message.includes('保存函数返回失败')), '诊断须指明保存函数返回失败');
    assert.deepEqual(store.readWatchlistStateMirror('mgr-acct'), goodState, '文件保留最后好快照');
    // 恢复后的下一条合法状态正常落盘（消息循环未中断）
    wrk.process.emit('message', { type: 'watchlist_state_sync', state: { version: 1, consumedOpSeq: 7, rows: {} } });
    assert.deepEqual(store.readWatchlistStateMirror('mgr-acct'), { version: 1, consumedOpSeq: 7, rows: {} });

    // 身份守卫：Worker 记录已换代后，旧进程的迟到消息不得写盘
    const guardMock = t.mock.method(store, 'writeWatchlistStateMirror');
    const oldProc = wrk.process;
    wrk.process = { send() {}, on() {}, kill() {} }; // 模拟新代次进程顶替记录
    oldProc.emit('message', { type: 'watchlist_state_sync', state: validState });
    assert.equal(guardMock.mock.calls.length, 0, '旧代次消息必须被丢弃');
    guardMock.mock.restore();
});

// ==================== 13. 管理路由 ====================

function routeHarness() {
    const { registerAdminFriendRoutes } = require('../src/controllers/admin-friend-routes');
    const routes = {};
    const app = {
        get: (p, h) => { routes[`GET ${p}`] = h; },
        post: (p, h) => { routes[`POST ${p}`] = h; },
    };
    const calls = { getFriends: 0, broadcast: 0 };
    const provider = {
        getFriends: async () => { calls.getFriends++; return [{ gid: 501, name: 'X', avatarUrl: 'a' }]; },
        broadcastConfig: () => { calls.broadcast++; return true; },
    };
    registerAdminFriendRoutes({
        app, provider, store,
        getAccountIdFromRequest: req => req.headers['x-account-id'],
        canAccessAccount: () => true,
        sendProviderError: (res, error) => res.status(500).json({ ok: false, error: String(error) }),
    });
    // 黑名单/自动捣乱等处理器是 async（等 provider.getFriends），call 必须等待
    const call = async (key, { accountId = 'route-acct', body = {}, query = {} } = {}) => {
        const res = { statusCode: 0, jsoned: undefined,
            status(code) { this.statusCode = code; return this; },
            json(payload) { this.jsoned = payload; } };
        await routes[key]({ headers: { 'x-account-id': accountId }, body, query }, res);
        return res;
    };
    return { call, calls };
}

test('watchlist 路由：GET 零上游依赖零目录创建；保存失败不广播且回滚；resume/remove 意图', async () => {
    const { call, calls } = routeHarness();

    // 冷缓存 GET：零 provider.getFriends、同步响应（不等上游）、兼容字段
    fs.rmSync(assertWriteInsidePrivateDir(MIRROR_DIR), { recursive: true, force: true });
    const cold = await call('GET /api/friend-watchlist', { accountId: 'route-cold' });
    assert.equal(cold.statusCode, 0);
    assert.deepEqual(cold.jsoned, { ok: true, data: [], meta: { opSeq: 0, consumedOpSeq: 0 } });
    assert.equal(calls.getFriends, 0, 'watchlist GET 不得触发好友列表上游读取');
    assert.equal(fs.existsSync(MIRROR_DIR), false, '冷缓存 GET 不得创建镜像目录');

    // toggle 加入：一次保存落名单+意图，广播仅在成功后尝试
    const added = await call('POST /api/friend-watchlist/toggle', { body: { gid: 501 } });
    assert.equal(added.jsoned.ok, true);
    assert.equal(added.jsoned.saved, true);
    assert.equal(added.jsoned.notifyAttempted, true);
    assert.equal(added.jsoned.meta.opSeq, 1);
    assert.deepEqual(added.jsoned.data.map(item => item.gid), [501]);
    assert.deepEqual(Object.keys(added.jsoned.data[0]).sort(),
        ['avatarUrl', 'gid', 'name', 'paused', 'pausedAt', 'trailingFailures']);
    assert.equal(added.jsoned.data[0].name, '', '名称由前端拼接，后端返回空值');
    assert.equal(calls.getFriends, 0, '写路径同样零上游好友读取');
    assert.equal(calls.broadcast, 1);

    // 镜像存在时 GET 呈现暂停状态（Worker 未消费意图前如实显示暂停）
    store.writeWatchlistStateMirror('route-acct', {
        version: 1, consumedOpSeq: 0,
        rows: { 501: { trailingFailures: 3, paused: true, pausedAt: now, appliedIntentOpSeq: 0 } },
    });
    const viewed = await call('GET /api/friend-watchlist');
    assert.equal(viewed.jsoned.data[0].paused, true);
    assert.equal(viewed.jsoned.data[0].trailingFailures, 3);

    // resume：意图登记 + opSeq 推进；镜像未更新前仍显示暂停（诚实展示）
    const resumed = await call('POST /api/friend-watchlist/resume', { body: { gid: 501 } });
    assert.equal(resumed.jsoned.ok, true);
    assert.equal(resumed.jsoned.meta.opSeq, 2);
    assert.equal(resumed.jsoned.data[0].paused, true, '消费前不得谎报已恢复');
    // 非名单目标 400
    assert.equal((await call('POST /api/friend-watchlist/resume', { body: { gid: 999 } })).statusCode, 400);

    // remove：移出 + 显式意图
    const removed = await call('POST /api/friend-watchlist/remove', { body: { gid: 501 } });
    assert.equal(removed.jsoned.ok, true);
    assert.deepEqual(removed.jsoned.data, []);
    assert.equal(removed.jsoned.meta.opSeq, 3);
    assert.deepEqual(store.getWatchlistResetMeta('route-acct').intents, { 501: 3 });

    // 保存失败：不广播、响应回滚名单、ok=false
    const origWrite = fs.writeFileSync;
    fs.writeFileSync = () => { throw new Error('disk full'); };
    let failed;
    try {
        failed = await call('POST /api/friend-watchlist/toggle', { body: { gid: 502 } });
    } finally {
        fs.writeFileSync = origWrite;
    }
    assert.equal(failed.jsoned.ok, false);
    assert.equal(failed.jsoned.saved, false);
    assert.equal(failed.jsoned.notifyAttempted, false, '保存失败不得尝试广播');
    assert.equal(calls.broadcast, 3, '只有三次成功保存各广播一次');
    assert.deepEqual(failed.jsoned.data.map(item => item.gid), [], '响应反映回滚后的名单');
    assert.deepEqual(store.getWatchlistFriendGids('route-acct'), [], '内存名单保持回滚值');

    // 损坏镜像 GET：返回默认值且不写新文件
    fs.mkdirSync(assertWriteInsidePrivateDir(MIRROR_DIR), { recursive: true });
    fs.writeFileSync(assertWriteInsidePrivateDir(path.join(MIRROR_DIR, 'route-corrupt.json')), '{oops', 'utf8');
    const corruptView = await call('GET /api/friend-watchlist', { accountId: 'route-corrupt' });
    assert.equal(corruptView.jsoned.ok, true);
    assert.equal(corruptView.jsoned.data[0] === undefined, true);
    assert.deepEqual(fs.readdirSync(MIRROR_DIR).filter(f => f.startsWith('route-corrupt')), ['route-corrupt.json'],
        '损坏读取不得新增文件');
});

test('反向验证：黑名单与自动捣乱路由保持 provider.getFriends 装饰原状', async () => {
    const { call, calls } = routeHarness();
    store.setFriendBlacklist('route-acct', [501]);
    const bl = await call('GET /api/friend-blacklist');
    assert.equal(bl.jsoned.ok, true);
    assert.equal(bl.jsoned.data[0].name, 'X', '黑名单仍从好友列表装饰名称');
    assert.ok(calls.getFriends >= 1, '黑名单 GET 仍走 provider.getFriends');

    store.setAutoBadFriendGids('route-acct', [501]);
    const ab = await call('GET /api/friend-auto-bad');
    assert.equal(ab.jsoned.data[0].name, 'X', '自动捣乱 GET 仍装饰名称');
    assert.ok(calls.getFriends >= 2);
    // toggle 自动捣乱保持既有归一化语义
    const toggled = await call('POST /api/friend-auto-bad/toggle', { body: { gid: 501 } });
    assert.equal(toggled.jsoned.ok, true);
    assert.deepEqual(toggled.jsoned.data, []);
});

// ==================== 14. 真实 startBot 重启链（fork 隔离夹具）====================
// 边界声明（尽力而为镜像，维持原设计）：未落盘的状态更新重启后不重现；
// 意图版本相等时旧暂停可以重现；存在更新且已保存的恢复意图时启动链
// （播种 → 首次配置应用 → reconcile）必须重新应用。不做可靠交付、锁或
// 重启策略改造。四例均执行真实 startBot 与配置应用链，首次访问经实际
// 巡田入口统计 Enter，内存/文件/逐条目应用版本/整体消费版本分别核对。
// 本文件只在当前候选上运行（非反证登记入口），直接使用重启链生产 API。
const restartClock = { now: 1_800_000_000_000 };
const staleRejectionDirect = () => Object.assign(
    new Error('不是好友无法拜访 code=1002002'),
    { isServerBusinessError: true, serverErrorCode: '1002002' },
);
function rejectStaleDirect(gid, times = 1) {
    for (let i = 0; i < times; i++) {
        orchestrator.applyWatchlistEnterError(
            orchestrator.noteWatchlistEnterAttempt(gid), staleRejectionDirect());
    }
}
function persistSnapshotFor(accountId) {
    assert.equal(store.writeWatchlistStateMirror(accountId,
        orchestrator.getWatchlistStateSnapshot()), true, '预重启快照必须真实落盘');
    return store.readWatchlistStateMirror(accountId);
}

// 子进程夹具源码：只替换网络/计时等外部边界（调度器手动泵、connect 不真正
// 登录、randomDelay 去随机、进门点计数、postToMaster 捕获）；startBot、
// 镜像播种、applyConfigSnapshot、reconcile、巡田环全部为真实生产代码，
// 'start'/'config_sync' 均经真实 onMasterMessage 消息入口进入。
const STARTBOT_CHILD_SOURCE = `'use strict';
const path = require('node:path');
const CORE = __CORE__;
const clock = { now: 1_800_000_000_000 };
const enterLog = [];
const pushCalls = [];
const logLines = [];

const schedulerModule = require(path.join(CORE, 'src/services/scheduler'));
const timerTasks = new Map();
schedulerModule.createScheduler = () => ({
    setTimeoutTask: (name, _delay, cb) => timerTasks.set(String(name), cb),
    setIntervalTask: (name, _interval, cb) => timerTasks.set(String(name), cb),
    clear: name => timerTasks.delete(String(name)),
    clearAll: () => timerTasks.clear(),
});

const networkModule = require(path.join(CORE, 'src/utils/network'));
networkModule.isConnected = () => true;
networkModule.getUserState = () => ({ gid: 1 });
// 连接边界：记录并通告"启动链已到 connect"（播种与首次配置应用均已完成），
// 不真正登录，onReady 不触发
networkModule.connect = async () => { process.send({ type: 't:started' }); };

const utilsModule = require(path.join(CORE, 'src/utils/utils'));
utilsModule.randomDelay = async () => {};
utilsModule.log = (tag, message, meta) => logLines.push({ tag, message, ...meta });

const apiModule = require(path.join(CORE, 'src/services/friend-api'));
apiModule.enterFriendFarm = async gid => {
    enterLog.push({ gid: Number(gid), at: clock.now });
    throw Object.assign(new Error('不是好友无法拜访 code=1002002'),
        { isServerBusinessError: true, serverErrorCode: '1002002' });
};
apiModule.leaveFriendFarm = async () => {};
apiModule.postToMaster = msg => { pushCalls.push(msg); return true; };

Date.now = () => clock.now;

const store = require(path.join(CORE, 'src/models/store'));
const watch = require(path.join(CORE, 'src/services/fertilizer-watch'));
const orchestrator = require(path.join(CORE, 'src/services/friend-orchestrator'));
// 真实 worker：加载即注册 onMasterMessage（'start'/'config_sync' 生产入口）
require(path.join(CORE, 'src/core/worker'));

async function pumpWatchlistPoll() {
    const cb = timerTasks.get('watchlist_poll');
    if (typeof cb !== 'function') throw new Error('watchlist_poll 未武装');
    timerTasks.delete('watchlist_poll');
    await cb();
}
const accountId = () => process.env.FARM_ACCOUNT_ID || '';

process.on('message', async (msg) => {
    try {
        if (!msg || typeof msg.type !== 'string' || !msg.type.startsWith('t:')) return;
        let reply;
        switch (msg.type) {
            case 't:snapshot':
                reply = { snapshot: orchestrator.getWatchlistStateSnapshot() }; break;
            case 't:arm':
                store.setWatchlistFriendGids(accountId(), [msg.gid]);
                orchestrator.applyStealScheduleFromFriends(
                    [{ gid: msg.gid, name: 'restart-friend', plant: { ripe_time_sec: msg.ripeSec } }],
                    { myGid: 1, blacklist: new Set() });
                reply = { ok: watch.isPriorityGid(msg.gid) === true };
                break;
            case 't:pump':
                orchestrator.pullWatchlistPollToNow(msg.gid, 0);
                await pumpWatchlistPoll();
                reply = {
                    enters: enterLog.length,
                    healthRows: logLines.filter(row => row.event === 'priority_poll_health').length,
                };
                break;
            case 't:gate':
                reply = {
                    paused: orchestrator.isWatchlistBaselinePaused(msg.gid, clock.now, msg.remainMs, {}),
                    pausedOnline: orchestrator.isWatchlistBaselinePaused(msg.gid, clock.now, msg.remainMs, { onlineNow: true }),
                };
                break;
            case 't:store-config':
                store.setWatchlistConfig(accountId(), msg.gids, msg.resetGids);
                reply = { opSeq: store.getWatchlistResetMeta(accountId()).opSeq };
                break;
            case 't:build-config': {
                const runtimeState = require(path.join(CORE, 'src/runtime/runtime-state'))
                    .createRuntimeState({ store });
                reply = { config: runtimeState.buildConfigSnapshotForAccount(accountId()) };
                break;
            }
            case 't:mirror-write':
                reply = { ok: store.writeWatchlistStateMirror(msg.accountId, msg.state) === true }; break;
            case 't:mirror-read':
                reply = { state: store.readWatchlistStateMirror(msg.accountId) }; break;
            case 't:pushes':
                reply = { pushes: pushCalls }; break;
            case 't:exit': process.exit(0); return;
            default: reply = { error: 'unknown control ' + msg.type };
        }
        process.send({ rid: msg.rid, ...reply });
    } catch (err) {
        process.send({ rid: msg && msg.rid, error: String((err && err.stack) || err) });
    }
});
process.send({ type: 't:ready' });
`;

const startBotFixturePath = (() => {
    const target = assertWriteInsidePrivateDir(path.join(privateDir, 'startbot-child-fixture.cjs'));
    fs.writeFileSync(target, STARTBOT_CHILD_SOURCE.replace('__CORE__', JSON.stringify(path.resolve(__dirname, '..'))));
    return target;
})();

const { fork } = require('node:child_process');
const askRid = { n: 0 };
function withStartBotChild(accountId, run) {
    return new Promise((resolve, reject) => {
        const child = fork(startBotFixturePath, [], {
            execArgv: [],
            env: { ...process.env, FARM_ACCOUNT_ID: accountId },
            stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        });
        let output = '';
        const absorb = chunk => {
            output += chunk;
            if (output.length > 8000) output = output.slice(-8000);
        };
        child.stdout.on('data', absorb);
        child.stderr.on('data', absorb);
        const watchdog = setTimeout(() => {
            child.kill();
            reject(new Error(`startBot 子进程超时\n子进程输出尾部:\n${output.slice(-1500)}`));
        }, 45_000);
        const ask = msg => new Promise((res, rej) => {
            const rid = ++askRid.n;
            const timer = setTimeout(() => rej(new Error(
                `控制消息超时: ${msg.type}\n子进程输出尾部:\n${output.slice(-1500)}`)), 15_000);
            const onMsg = m => {
                if (m.rid !== rid) return;
                child.off('message', onMsg);
                clearTimeout(timer);
                if (m.error) rej(new Error(`子进程错误: ${m.error}`));
                else res(m);
            };
            child.on('message', onMsg);
            child.send({ ...msg, rid });
        });
        const waitType = type => new Promise((res, rej) => {
            const timer = setTimeout(() => rej(new Error(
                `等待 ${type} 超时\n子进程输出尾部:\n${output.slice(-1500)}`)), 30_000);
            const onMsg = m => {
                if (m.type !== type) return;
                child.off('message', onMsg);
                clearTimeout(timer);
                res(m);
            };
            child.on('message', onMsg);
        });
        (async () => {
            await waitType('t:ready');
            // 真实消息入口（与生产一致）：'start' → onMasterMessage → startBot
            child.send({ type: 'start', config: { code: 'fixture-code', platform: 'qq' } });
            // connect 到达 = 播种与首次配置应用均已完成（startBot 源序）
            await waitType('t:started');
            return await run({ ask, send: m => child.send(m) });
        })().then(result => {
            clearTimeout(watchdog);
            resolve(result);
        }, err => {
            clearTimeout(watchdog);
            reject(err);
        }).finally(() => {
            try { child.send({ type: 't:exit' }); } catch { /* 子进程已退出 */ }
            setTimeout(() => child.kill(), 500).unref();
        });
    });
}

test('真实 startBot 重启链（快照计数 0）：暂停推送丢失恢复 0；首次失败计 1；重满门限才再暂停', async t => {
    t.mock.method(Date, 'now', () => restartClock.now);
    const gid = 9401;
    // 预重启（旧进程仿真）：尾随累计 2 后一次真实成功清零 → 最后好快照计数 0
    watch.setPriorityGids([gid]);
    rejectStaleDirect(gid, 2);
    orchestrator.applyWatchlistEnterSuccess(orchestrator.noteWatchlistEnterAttempt(gid));
    const persisted = persistSnapshotFor('rst-a');
    assert.equal(persisted.rows[String(gid)].trailingFailures, 0, '最后好快照计数 0');

    await withStartBotChild('rst-a', async ({ ask }) => {
        // 内存：真实启动加载按文件恢复 0/未暂停/两类版本逐项核对
        let snap = (await ask({ type: 't:snapshot' })).snapshot;
        assert.equal(snap.rows[String(gid)].trailingFailures, 0, '内存恢复计数 0');
        assert.equal(snap.rows[String(gid)].paused, false, '未落盘的暂停不重现');
        assert.equal(snap.rows[String(gid)].appliedIntentOpSeq,
            persisted.rows[String(gid)].appliedIntentOpSeq, '逐条目意图版本随文件恢复');
        assert.equal(snap.consumedOpSeq, persisted.consumedOpSeq, '整体消费版本随文件恢复');
        // 文件：启动链不得改写镜像
        assert.deepEqual((await ask({ type: 't:mirror-read', accountId: 'rst-a' })).state, persisted);

        assert.equal((await ask({ type: 't:arm', gid, ripeSec: 6 * 3600 })).ok, true);
        snap = (await ask({ type: 't:snapshot' })).snapshot;
        assert.equal(snap.rows[String(gid)].trailingFailures, 0, '武装巡田不得改写暂停状态');

        // 首次到期：实际发 Enter，同类失败计 1（不要求重新失败满三次才计数）
        let pumped = await ask({ type: 't:pump', gid });
        assert.equal(pumped.enters, 1, '重启后首次到期必须实际进门');
        assert.equal(pumped.healthRows, 1, '实际尝试记健康日志');
        snap = (await ask({ type: 't:snapshot' })).snapshot;
        assert.equal(snap.rows[String(gid)].trailingFailures, 1);
        assert.equal(snap.rows[String(gid)].paused, false);

        // 重新达到连续门限（3）后才暂停
        await ask({ type: 't:pump', gid });
        pumped = await ask({ type: 't:pump', gid });
        assert.equal(pumped.enters, 3);
        snap = (await ask({ type: 't:snapshot' })).snapshot;
        assert.equal(snap.rows[String(gid)].trailingFailures, 3);
        assert.equal(snap.rows[String(gid)].paused, true, '重新达到门限后暂停');

        // 内存/文件一致：重新暂停的真实推送按主进程动作落盘后与内存一致
        const pushes = (await ask({ type: 't:pushes' })).pushes;
        const last = pushes[pushes.length - 1];
        assert.equal(last.type, 'watchlist_state_sync');
        assert.equal(last.accountId, 'rst-a');
        assert.equal((await ask({ type: 't:mirror-write', accountId: 'rst-a', state: last.state })).ok, true);
        const again = (await ask({ type: 't:mirror-read', accountId: 'rst-a' })).state;
        snap = (await ask({ type: 't:snapshot' })).snapshot;
        assert.deepEqual(again.rows[String(gid)], snap.rows[String(gid)], '文件与内存逐条目一致');
        assert.equal(again.consumedOpSeq, snap.consumedOpSeq, '文件与内存整体消费版本一致');
    });
});

test('真实 startBot 重启链（快照计数 2）：恢复 2 后首次同类失败即再暂停', async t => {
    t.mock.method(Date, 'now', () => restartClock.now);
    const gid = 9402;
    watch.setPriorityGids([gid]);
    rejectStaleDirect(gid, 2);
    const persisted = persistSnapshotFor('rst-b');
    assert.equal(persisted.rows[String(gid)].trailingFailures, 2, '最后好快照计数 2');

    await withStartBotChild('rst-b', async ({ ask }) => {
        let snap = (await ask({ type: 't:snapshot' })).snapshot;
        assert.equal(snap.rows[String(gid)].trailingFailures, 2, '内存恢复计数 2');
        assert.equal(snap.rows[String(gid)].paused, false, '未落盘的暂停不重现');
        assert.deepEqual((await ask({ type: 't:mirror-read', accountId: 'rst-b' })).state, persisted);

        await ask({ type: 't:arm', gid, ripeSec: 6 * 3600 });
        const pumped = await ask({ type: 't:pump', gid });
        assert.equal(pumped.enters, 1, '恢复 2 后首次到期必须实际进门');
        snap = (await ask({ type: 't:snapshot' })).snapshot;
        assert.equal(snap.rows[String(gid)].trailingFailures, 3);
        assert.equal(snap.rows[String(gid)].paused, true, '3−2=1：一次失败即再暂停');

        const pushes = (await ask({ type: 't:pushes' })).pushes;
        const last = pushes[pushes.length - 1];
        await ask({ type: 't:mirror-write', accountId: 'rst-b', state: last.state });
        const again = (await ask({ type: 't:mirror-read', accountId: 'rst-b' })).state;
        assert.deepEqual(again.rows[String(gid)], snap.rows[String(gid)], '文件与内存逐条目一致');
        assert.equal(again.consumedOpSeq, snap.consumedOpSeq, '文件与内存整体消费版本一致');
    });
});

test('真实 startBot 重启链（自然恢复丢失）：旧暂停如实重现零 Enter；豁免开放；真实 config_sync 恢复', async t => {
    t.mock.method(Date, 'now', () => restartClock.now);
    const gid = 9403;
    watch.setPriorityGids([gid]);
    rejectStaleDirect(gid, 3);
    const persisted = persistSnapshotFor('rst-c');
    assert.equal(persisted.rows[String(gid)].paused, true);

    await withStartBotChild('rst-c', async ({ ask, send }) => {
        // 无新意图版本：播种如实重现旧暂停
        let snap = (await ask({ type: 't:snapshot' })).snapshot;
        assert.equal(snap.rows[String(gid)].paused, true, '意图版本无推进时旧暂停如实重现');
        assert.deepEqual((await ask({ type: 't:mirror-read', accountId: 'rst-c' })).state, persisted);

        await ask({ type: 't:arm', gid, ripeSec: 6 * 3600 });
        const pumped = await ask({ type: 't:pump', gid });
        assert.equal(pumped.enters, 0, '重启后首次到期必须零 Enter');
        assert.equal(pumped.healthRows, 0, '暂停跳过不得伪造健康记录');
        const gate = await ask({ type: 't:gate', gid, remainMs: 3 * 3600_000 });
        assert.equal(gate.paused, true, '无证据仍拦普通基线');
        assert.equal(gate.pausedOnline, false, '在线豁免通道保持开放');

        // 用户再次恢复：真实保存意图 → 真实 buildConfigSnapshotForAccount →
        // 真实 'config_sync' 消息 → applyRuntimeConfig → reconcile
        const saved = await ask({ type: 't:store-config', gids: [gid], resetGids: [gid] });
        assert.ok(saved.opSeq > (persisted.consumedOpSeq || 0), '恢复意图版本必须前进');
        const built = await ask({ type: 't:build-config' });
        send({ type: 'config_sync', config: built.config });
        // 消息有序：config_sync 先于后续控制消息被处理；轮询核实直至消费
        for (let i = 0; i < 50 && (await ask({ type: 't:snapshot' })).snapshot.consumedOpSeq < saved.opSeq; i++) {
            await new Promise(resolve => setTimeout(resolve, 20));
        }
        snap = (await ask({ type: 't:snapshot' })).snapshot;
        assert.equal(snap.rows[String(gid)].paused, false, '真实配置链消费恢复意图解除暂停');
        assert.equal(snap.rows[String(gid)].appliedIntentOpSeq, saved.opSeq, '逐条目应用版本推进到意图版本');
        assert.equal(snap.consumedOpSeq, saved.opSeq, '整体消费版本推进到意图版本');

        const resumed = await ask({ type: 't:pump', gid });
        assert.equal(resumed.enters, 1, '恢复后首次到期实际进门');
    });
});

test('真实 startBot 重启链（更新恢复意图已保存）：播种旧暂停→配置应用清除，双版本推进，首次访问进门', async t => {
    t.mock.method(Date, 'now', () => restartClock.now);
    const gid = 9404;
    watch.setPriorityGids([gid]);
    rejectStaleDirect(gid, 3);
    const persisted = persistSnapshotFor('rst-d');
    assert.equal(persisted.rows[String(gid)].paused, true);
    // Worker 停机期间用户经管理路由保存恢复意图（配置侧版本前进）
    store.setWatchlistConfig('rst-d', [gid], [gid]);
    const meta = store.getWatchlistResetMeta('rst-d');
    assert.ok(meta.opSeq > persisted.consumedOpSeq, '配置意图版本必须比镜像消费版本新');

    await withStartBotChild('rst-d', async ({ ask }) => {
        const snap = (await ask({ type: 't:snapshot' })).snapshot;
        const row = snap.rows[String(gid)];
        assert.equal(row.paused, false, '较新意图清除暂停（播种先于配置应用；顺序相反则旧暂停会重现）');
        assert.equal(row.appliedIntentOpSeq, meta.opSeq, '逐条目应用版本推进到意图版本');
        assert.equal(snap.consumedOpSeq, meta.opSeq, '整体消费版本推进到意图版本');
        // 文件：启动链不改写镜像（仍为旧暂停快照；解除经推送由主进程落盘）
        assert.deepEqual((await ask({ type: 't:mirror-read', accountId: 'rst-d' })).state, persisted);
        // 解除后普通基线放行：首次允许的实际访问发起 Enter
        await ask({ type: 't:arm', gid, ripeSec: 6 * 3600 });
        const pumped = await ask({ type: 't:pump', gid });
        assert.equal(pumped.enters, 1, '首次允许的实际访问必须发起 Enter');
    });
});
