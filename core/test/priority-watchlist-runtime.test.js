const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const privateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farm-priority-runtime-'));
process.env.FARM_DATA_DIR = privateDir;
const watch = require('../src/services/fertilizer-watch');
const governor = require('../src/services/request-governor');
const clocks = require('../src/services/steal-schedule');
const { toNum } = require('../src/utils/utils');
const orchestrator = fs.readFileSync(path.join(__dirname, '../src/services/friend-orchestrator.js'), 'utf8');
const visits = fs.readFileSync(path.join(__dirname, '../src/services/friend-visit.js'), 'utf8');
const api = fs.readFileSync(path.join(__dirname, '../src/services/friend-api.js'), 'utf8');
test.after(() => fs.rmSync(privateDir, { recursive: true, force: true }));
test.afterEach(() => { watch.resetFertilizerWatchForTests(); governor.resetForTest(); });

// Execute actual production function bodies, injecting only clocks, transport,
// account configuration and external dependencies. No game connection is made.
function sourceFunction(source, name) {
    const declarations = [...source.matchAll(/^(?:async )?function (\w+)\(/gm)];
    const index = declarations.findIndex(match => match[1] === name);
    assert.ok(index >= 0, `production function ${name} exists`);
    return source.slice(declarations[index].index, declarations[index + 1]?.index || source.length);
}

function fixture(t, options = {}) {
    let time = 1_800_000_000_000;
    t.mock.method(Date, 'now', () => time);
    const flags = { pause: false, own: false, stealDue: false, stealImminent: false,
        slowdown: false, budgetDenied: false, returnRemain: 0, ...options };
    let gids = [9];
    const transport = [];
    const logs = [];
    let leaves = 0;
    const context = {
        Date, Set, Map, Number, Math, Array,
        process: { env: { FARM_ACCOUNT_ID: 'fixture-account' } },
        ...watch, ...clocks, toNum, toLong: Number,
        getWatchlistFriendGids: () => gids,
        getFriendQuietHours: () => ({ watchlistWakeBeforeMinutes: 122 }),
        getUserState: () => ({ gid: 1 }), getFriendBlacklist: () => [],
        isConnected: () => true, isAutomationOn: () => true,
        getPauseRemainMs: () => flags.pause ? 1000 : 0,
        ownHarvestIsImminent: () => flags.own,
        stealIsDue: () => flags.stealDue, stealIsImminent: () => flags.stealImminent,
        getBreakerState: () => ({ active: flags.slowdown, recommendedDelayMs: 90_000 }),
        gaussianInt: (_min, max) => max,
        randomDelay: async () => {}, sellAllFruits: async () => {},
        log: (_tag, message, meta) => logs.push({ message, ...meta }),
        logWarn: () => {},
        watchlistPollLoopArmed: true, isCheckingFriends: false,
        watchlistPollNextAt: new Map(), watchlistPollRipeAt: new Map(),
        watchlistNames: new Map([[9, 'fixture-friend']]), watchlistWindowAnnounced: new Map(),
        friendSummaryDueByGid: new Map(),
        lastRipeRefreshAt: 0, nextFriendStealDueAtMs: 0, nextWatchlistStealDueAtMs: 0,
        OWN_HARVEST_RESERVE_MS: 10_000, WATCHLIST_POLL_TICK_MS: 3000,
        WATCHLIST_POLL_IDLE_MIN_MS: 300_000, WATCHLIST_POLL_IDLE_MAX_MS: 480_000,
        WATCHLIST_POLL_WINDOW_MIN_MS: 45_000, WATCHLIST_POLL_WINDOW_MAX_MS: 75_000,
        WATCHLIST_POLL_ONLINE_MIN_MS: 700, WATCHLIST_POLL_ONLINE_MAX_MS: 1_000,
        DUE_PREARM_WATCHLIST_MS: 60_000, DUE_PREARM_MS: 10_000,
        DEFAULT_WATCHLIST_WAKE_BEFORE_MINUTES: 122,
        friendScheduler: { setTimeoutTask: () => {} },
        armStealWakeForWorker: () => {}, formatWatchlistRemain: () => 'fixture interval',
        ensureWatchlistPollLoop: () => {}, announceWatchlist: () => {},
        recomputeFriendSummaryClocks: () => {}, getNextStealDueAtMs: () => 0, markStealDueAt: () => {},
        types: {
            VisitEnterRequest: { create: value => value, encode: value => ({ finish: () => value }) },
            VisitEnterReply: { decode: value => value },
        },
        sendMsgAsync: async (service, method, payload) => {
            transport.push({ service, method, payload });
            assert.equal(service, 'gamepb.visitpb.VisitService');
            assert.equal(method, 'Enter');
            assert.equal(payload.host_gid, 9);
            if (flags.budgetDenied) throw new Error('budget denied');
            const lands = flags.returnRemain > 0 ? [{ id: 1, plant: { id: 100,
                phases: [{ begin_time: Math.floor(time / 1000) + flags.returnRemain / 1000 }] } }] : [];
            return { body: { lands } };
        },
        parseBriefDogInfoBytes: () => null, extractVisitEnterBriefDogInfo: () => null,
        handleFriendEnterError: () => ({ handled: true, kind: 'budget' }),
        leaveFriendFarm: async () => { leaves++; if (flags.onLeave) flags.onLeave(); },
        getPlantBlacklist: () => [], analyzeFriendLands: () => ({ stealable: [] }),
        getCurrentPhase: () => ({ phase: 1 }), PlantPhase: { MATURE: 4 },
        isFriendActiveEvidence: () => false, isFriendAtHomeRecently: () => false,
        isFriendAtHome: () => false, isFriendOnlineRecently: () => false,
        isFriendOnlineEvidence: () => false,
        noteFriendActivity: () => {},
    };
    const functions = ['getWatchlistWakeBeforeMs', 'nextWatchlistPollDelayMs', 'isWatchlistObservationWindow',
        'scheduleWatchlistPollNext', 'watchlistPollTick', 'watchlistPollTickDelayMs', 'applyStealScheduleFromFriends']
        .map(name => sourceFunction(orchestrator, name));
    vm.createContext(context);
    vm.runInContext([...functions, sourceFunction(api, 'enterFriendFarm'),
        sourceFunction(visits, 'visitFriendForSteal')].join('\n'), context);
    return { flags, context, transport, logs,
        tick: () => context.watchlistPollTick(), time: () => time,
        setTime: value => { time = value; }, setGids: value => { gids = value; },
        next: () => context.watchlistPollNextAt.get(9),
        health: () => logs.filter(row => row.event === 'priority_poll_health'), leaves: () => leaves };
}

test('actual schedule transfers a Set into priority detection; only priority six-second advance activates HOT', t => {
    const f = fixture(t);
    const friends = seconds => [9, 10].map(gid => ({ gid, name: 'fixture', plant: { ripe_time_sec: seconds } }));
    f.context.applyStealScheduleFromFriends(friends(600), { myGid: 1, blacklist: new Set() });
    assert.equal(watch.isPriorityGid(9), true);
    assert.equal(watch.isPriorityGid(10), false);
    f.context.applyStealScheduleFromFriends(friends(594), { myGid: 1, blacklist: new Set() });
    assert.equal(watch.getWatchStateForTests(9, f.time()).status, watch.WATCH_STATUS.HOT);
    assert.equal(watch.getWatchStateForTests(10, f.time()), null);
    f.setGids([]);
    f.context.applyStealScheduleFromFriends(friends(594), { myGid: 1, blacklist: new Set() });
    assert.equal(watch.isPriorityGid(9), false);
    watch.setPriorityGids([9]);
    assert.equal(watch.isPriorityGid(9), true);
    watch.setPriorityGids('9');
    assert.equal(watch.isPriorityGid(9), false);
});

for (const known of [false, true]) {
    test(`persistent slowdown performs four actual budgeted visits with bounded extra delay (${known ? 'outside window' : 'unknown'})`, async t => {
        const f = fixture(t, { slowdown: true, returnRemain: known ? 6 * 3600_000 : 0 });
        if (known) f.context.watchlistPollRipeAt.set(9, f.time() + 6 * 3600_000);
        for (let i = 0; i < 4; i++) {
            await f.tick();
            assert.equal(f.transport.length, i + 1);
            const delay = f.next() - f.time();
            assert.ok(delay >= 390_000 && delay <= 615_000);
            f.setTime(f.next());
        }
        assert.equal(f.leaves(), 4);
        assert.equal(f.health().length, 4);
        assert.ok(f.health().every(row => row.mode === 'baseline' && row.result === 'ok'));
    });
}

test('window failures retain 45-75 second scheduling under slowdown; unknown failures retain 5-8 minutes', async t => {
    const f = fixture(t, { slowdown: true, budgetDenied: true });
    f.context.watchlistPollRipeAt.set(9, f.time() + 3600_000);
    await f.tick();
    assert.equal(f.transport.length, 1);
    assert.ok(f.next() - f.time() >= 45_000 && f.next() - f.time() <= 75_000);
    assert.equal(f.health()[0].result, 'failed');
    assert.equal(f.health()[0].mode, 'observation');
    assert.equal(f.leaves(), 0, 'a denied budget does not continue into a successful visit');
    f.context.watchlistPollRipeAt.clear();
    f.flags.slowdown = false;
    f.setTime(f.next());
    await f.tick();
    assert.equal(f.transport.length, 2);
    assert.ok(f.next() - f.time() >= 300_000 && f.next() - f.time() <= 480_000);
    assert.equal(f.health()[1].mode, 'baseline');
});

test('pause, own maturity and due/imminent stealing prevent baseline transport without fake attempts', async t => {
    const f = fixture(t);
    for (const flag of ['pause', 'own', 'stealDue', 'stealImminent']) {
        f.flags[flag] = true;
        await f.tick();
        assert.equal(f.transport.length, 0, flag);
        assert.equal(f.health().length, 0, flag);
        f.flags[flag] = false;
    }
    f.context.isCheckingFriends = true;
    await f.tick();
    assert.equal(f.transport.length, 0);
    f.context.isCheckingFriends = false;
    await f.tick();
    assert.equal(f.transport.length, 1, 'baseline resumes through the same guarded transport');
    await f.tick();
    assert.equal(f.transport.length, 1, 'not-yet-due tick does not perform another visit');
    assert.equal(f.health().length, 1);
});

test('first successful window discovery reports its actual next mode with only anonymous health fields', async t => {
    const f = fixture(t, { returnRemain: 3600_000, slowdown: true });
    await f.tick();
    const rows = f.health();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].mode, 'observation');
    assert.equal(rows[0].nextDelayMs, f.next() - f.time());
    assert.ok(rows[0].nextDelayMs >= 45_000 && rows[0].nextDelayMs <= 75_000);
    assert.deepEqual(Object.keys(rows[0]).sort(), ['event', 'message', 'mode', 'module', 'nextDelayMs', 'result']);
    assert.equal(JSON.stringify(rows).includes('fixture-account'), false);
    assert.equal(JSON.stringify(rows).includes('fixture-friend'), false);
    f.setTime(f.next());
    f.flags.returnRemain = 0;
    await f.tick();
    assert.equal(f.health().length, 2);
    assert.equal(f.health()[1].mode, 'baseline');
    assert.ok(f.health()[1].nextDelayMs >= 390_000);
});

// 2026-09-22 线上事故回归：好友施肥把成熟点催到只剩几秒，本轮进门结束时
// 成熟时刻已成过去时。旧代码把它当"没有在长的作物"退 6-8 分钟慢档且不布
// PREARM，菜被在线的主人收走。现在必须立即 PREARM 重访 + 保持窗口档节奏。
test('ripened-during-visit re-arms PREARM and keeps window cadence instead of idling', async t => {
    const f = fixture(t, { returnRemain: 5000 });
    f.flags.onLeave = () => f.setTime(f.time() + 60_000); // 进门期间成熟点已过
    await f.tick();
    const state = watch.getWatchStateForTests(9, f.time());
    assert.equal(state.status, watch.WATCH_STATUS.PREARM, '进门期间已熟必须布 PREARM 重访');
    assert.ok(state.nextVisitAt <= f.time() + 5_000, 'PREARM 必须立即到期');
    const health = f.health().pop();
    assert.ok(health.nextDelayMs < 100_000, `慢档回退是回归（nextDelayMs=${health.nextDelayMs}）`);
});

test('truly-empty friend farm still falls back to idle cadence', async t => {
    const f = fixture(t, { returnRemain: 0 });
    await f.tick();
    assert.equal(watch.getWatchStateForTests(9, f.time()), null, '无作物不应布防');
    const health = f.health().pop();
    assert.ok(health.nextDelayMs >= 300_000, '无作物保持 6-8 分钟慢档');
});

// 好友在线快档（2026-09-22 at_home 实测）：onlineNow 命中时巡田间隔 1 秒内，
// 观察窗/慢档语义不变
test('online tier polls sub-second while friend is at home', t => {
    const f = fixture(t);
    const delay = f.context.nextWatchlistPollDelayMs(30 * 60_000, { onlineNow: true });
    assert.ok(delay >= 700 && delay <= 1_000, `online tier delay=${delay}`);
    const idle = f.context.nextWatchlistPollDelayMs(0, { onlineNow: true });
    assert.ok(idle >= 300_000, `remain=0 仍走慢档（idle=${idle}）`);
    const normal = f.context.nextWatchlistPollDelayMs(30 * 60_000, { onlineNow: false });
    assert.ok(normal >= 45_000, `离线回落 45-75s（normal=${normal}）`);
});
