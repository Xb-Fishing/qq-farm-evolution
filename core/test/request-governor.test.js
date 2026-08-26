const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const governor = require('../src/services/request-governor');

const T0 = 1_700_000_000_000;
const networkSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'utils', 'network.js'), 'utf8');
const activitySrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'activity.js'), 'utf8');
const activityRouteSrc = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'controllers', 'admin-activity-update-routes.js'),
    'utf8'
);

test('total budget drops non-whitelisted requests beyond the 60s limit', () => {
    governor.resetForTest();
    for (let i = 0; i < governor.TOTAL_LIMIT; i++) {
        assert.equal(governor.checkRequest('svc.Farm', `Do${i % 3}`, T0).allowed, true);
        governor.recordSent('svc.Farm', `Do${i % 3}`, true, T0);
    }
    const over = governor.checkRequest('svc.Farm', 'Extra', T0 + 1000);
    assert.equal(over.allowed, false);
    assert.equal(over.reason, 'budget_total');
});

test('whitelist and steal methods bypass the budget', () => {
    governor.resetForTest();
    for (let i = 0; i < governor.TOTAL_LIMIT + 5; i++) {
        governor.recordSent('gamepb.userpb.UserService', 'Heartbeat', true, T0);
    }
    const hb = governor.checkRequest('gamepb.userpb.UserService', 'Heartbeat', T0 + 2000);
    assert.equal(hb.allowed, true);
    assert.equal(hb.reason, 'whitelist');
    const ace = governor.checkRequest('gamepb.acepb.AceService', 'AntiData', T0 + 2000);
    assert.equal(ace.allowed, true);
    assert.equal(ace.reason, 'whitelist');
    const steal = governor.checkRequest('gamepb.plantpb.PlantService', 'Harvest', T0 + 2000);
    assert.equal(steal.allowed, true);
});

test('error slowdown never blocks heartbeat or login', () => {
    governor.resetForTest();
    for (let i = 0; i < 15; i++) {
        const r = governor.recordSent('svc.Farm', 'Broken', false, T0 + i * 1000);
        if (r.tripped) break;
    }
    assert.equal(governor.getBreakerState(T0 + 16_000).active, true);
    assert.equal(governor.checkRequest('gamepb.userpb.UserService', 'Heartbeat', T0 + 16_000).allowed, true);
    assert.equal(governor.checkRequest('gamepb.gatepb.GateService', 'Login', T0 + 16_000).allowed, true);
});

test('maturity contention failures do not accumulate toward slowdown', () => {
    governor.resetForTest();
    governor.setContentionMode(true, T0 + 20 * 60 * 1000);
    const methods = [
        ['gamepb.visitpb.VisitService', 'Enter'],
        ['gamepb.visitpb.VisitService', 'Leave'],
        ['gamepb.plantpb.PlantService', 'AllLands'],
        ['gamepb.plantpb.PlantService', 'CheckCanOperate'],
        ['gamepb.plantpb.PlantService', 'Harvest'],
    ];
    for (let i = 0; i < 20; i++) {
        const [service, method] = methods[i % methods.length];
        const r = governor.recordSent(service, method, false, T0 + i * 500);
        assert.equal(r.slowed, undefined, `watch-mode ${method} failures must not trigger slowdown`);
    }
    assert.equal(governor.getBreakerState(T0 + 11_000).active, false);
    assert.equal(governor.getRequestProfile(T0 + 11_000).contentionModeActive, true);
});

test('maturity failure exemption expires and ordinary failures still trigger slowdown', () => {
    governor.resetForTest();
    governor.setContentionMode(true, T0 + 5_000);
    for (let i = 0; i < 10; i++) {
        governor.recordSent('gamepb.plantpb.PlantService', 'Harvest', false, T0 + i * 200);
    }
    assert.equal(governor.getBreakerState(T0 + 4_000).active, false);

    let slowed = false;
    for (let i = 0; i < 20; i++) {
        const result = governor.recordSent(
            'gamepb.visitpb.VisitService',
            'Leave',
            false,
            T0 + 6_000 + i * 200
        );
        if (result.slowed) {
            slowed = true;
            assert.equal(result.failures[0].method, 'gamepb.visitpb.VisitService.Leave');
            break;
        }
    }
    assert.equal(slowed, true);
});

test('slowdown does not block ordinary or watch-essential methods', () => {
    governor.resetForTest();
    governor.setWatchMode(false);
    for (let i = 0; i < 14; i++) {
        const r = governor.recordSent('svc.Farm', 'Flaky', false, T0 + i * 1000);
        if (r.tripped) break;
    }
    assert.equal(governor.getBreakerState(T0 + 16_000).active, true);
    // 降速由调度层执行，请求层不再返回 cooldown。
    assert.equal(governor.checkRequest('svc.Farm', 'Other', T0 + 16_000).allowed, true);
    // 盯梢窗口激活后，Enter/AllLands 同样可继续运行。
    governor.setWatchMode(true, T0 + 30 * 60 * 1000);
    assert.equal(governor.checkRequest('gamepb.visitpb.VisitService', 'Enter', T0 + 16_000).allowed, true);
    assert.equal(governor.checkRequest('gamepb.plantpb.PlantService', 'AllLands', T0 + 16_000).allowed, true);
});

test('ordinary maturity contention does not boost Enter and slowdown does not block it', () => {
    governor.resetForTest();
    for (let i = 0; i < governor.PER_METHOD_LIMIT; i++) {
        governor.recordSent('gamepb.visitpb.VisitService', 'Enter', true, T0);
    }
    governor.setContentionMode(true, T0 + 30 * 60 * 1000);
    const limited = governor.checkRequest('gamepb.visitpb.VisitService', 'Enter', T0 + 500);
    assert.equal(limited.allowed, false);
    assert.equal(limited.reason, 'budget_method');

    governor.resetForTest();
    for (let i = 0; i < 14; i++) {
        const result = governor.recordSent('svc.Farm', 'Flaky', false, T0 + i * 1000);
        if (result.tripped) break;
    }
    governor.setContentionMode(true, T0 + 30 * 60 * 1000);
    const allowed = governor.checkRequest('gamepb.visitpb.VisitService', 'Enter', T0 + 16_000);
    assert.equal(allowed.allowed, true);
    assert.equal(allowed.reason, 'ok');
});

test('explicit read-only probe business failures stay in profile but not slowdown', () => {
    governor.resetForTest();
    for (let i = 0; i < 20; i++) {
        const result = governor.recordSent(
            'gamepb.activitypb.ActivityService',
            'GetGroup',
            false,
            T0 + i * 500,
            { breakerExempt: true }
        );
        assert.equal(result.tripped, false);
    }
    assert.equal(governor.getBreakerState(T0 + 11_000).active, false);
    const method = governor.getRequestProfile(T0 + 11_000).top
        .find(item => item.method === 'gamepb.activitypb.ActivityService.GetGroup');
    assert.equal(method.count, 20);
    assert.equal(method.errCount, 20);
});

test('activity discovery only reads List roots and exempts business errors, not transport failures', () => {
    const snapshotStart = activitySrc.indexOf('async function getActivityGroupSnapshot');
    const snapshotEnd = activitySrc.indexOf('/**', snapshotStart + 10);
    assert.match(activitySrc.slice(snapshotStart, snapshotEnd), /discoveryProbe: true/);
    assert.match(networkSrc, /options\.breakerExemptBusinessError === true/);
    assert.match(networkSrc, /err\.isServerBusinessError === true/);
    assert.match(networkSrc, /error\.isServerBusinessError = true/);
    assert.match(activityRouteSrc, /selectActivitySnapshotRoots\(activities, unknown\)/);
    assert.match(activityRouteSrc, /禁止枚举未由 ActivityService\.List 下发的活动 ID/);
    assert.doesNotMatch(activityRouteSrc, /MAX_DATE_PROBES_PER_SCAN|selectedProbeIds|GetGroup probe/);
});

test('per-method budget trips before the total budget', () => {
    governor.resetForTest();
    for (let i = 0; i < governor.PER_METHOD_LIMIT; i++) {
        governor.recordSent('svc.Farm', 'Spam', true, T0);
    }
    const over = governor.checkRequest('svc.Farm', 'Spam', T0 + 500);
    assert.equal(over.allowed, false);
    assert.equal(over.reason, 'budget_method');
    // 别的接口仍可用
    assert.equal(governor.checkRequest('svc.Farm', 'Other', T0 + 500).allowed, true);
});

test('repeated failures activate advisory slowdown without rejecting requests', () => {
    governor.resetForTest();
    let slowed = false;
    for (let i = 0; i < 14; i++) {
        const r = governor.recordSent('svc.Farm', 'Flaky', false, T0 + i * 1000);
        if (r.slowed) slowed = true;
    }
    assert.equal(slowed, true, 'ordinary polling should be advised to slow down');
    const state = governor.getBreakerState(T0 + 15_000);
    assert.equal(state.active, true);
    assert.equal(state.mode, 'slowdown');
    assert.equal(state.hardBlocked, false);
    assert.ok(state.recommendedDelayMs >= 30_000);
    const normal = governor.checkRequest('svc.Farm', 'Normal', T0 + 16_000);
    assert.equal(normal.allowed, true);
    assert.notEqual(normal.reason, 'cooldown');
    assert.equal(governor.checkRequest('gamepb.userpb.UserService', 'Heartbeat', T0 + 16_000).allowed, true);
    assert.equal(governor.clearBreaker(), false, 'wall clock differs from synthetic test time');
    assert.equal(governor.getBreakerState(T0 + 16_000).active, false);
});

test('watch mode boosts Enter/AllLands per-method limit inside the window only', () => {
    governor.resetForTest();
    // 填满普通单接口限值
    for (let i = 0; i < governor.PER_METHOD_LIMIT; i++) {
        governor.recordSent('gamepb.visitpb.VisitService', 'Enter', true, T0);
    }
    assert.equal(governor.checkRequest('gamepb.visitpb.VisitService', 'Enter', T0 + 500).allowed, false);

    // 进入盯梢窗口：同一时刻同样的量应当放行（限值 ×3）
    governor.setWatchMode(true, T0 + 10 * 60 * 1000);
    const boosted = governor.checkRequest('gamepb.visitpb.VisitService', 'Enter', T0 + 600);
    assert.equal(boosted.allowed, true);
    // 非放宽接口不享受
    assert.equal(governor.checkRequest('svc.Farm', 'Other', T0 + 600).allowed, true);

    // 窗口过期后恢复普通限值
    governor.setWatchMode(false);
    assert.equal(governor.checkRequest('gamepb.visitpb.VisitService', 'Enter', T0 + 500).allowed, false);
});

test('profile exposes top methods and drop counters', () => {
    governor.resetForTest();
    governor.recordSent('svc.A', 'Hot', true, T0);
    governor.recordSent('svc.A', 'Hot', false, T0 + 10);
    governor.recordSent('svc.B', 'Cold', true, T0 + 20);
    const p = governor.getRequestProfile(T0 + 100);
    assert.equal(p.windowCount, 3);
    const hot = p.top.find(m => m.method === 'svc.A.Hot');
    assert.equal(hot.count, 2);
    assert.equal(hot.errCount, 1);
});
