'use strict';
// 好友在线实时标记 UI 回归（2026-09-26 漏项修复）：
// 后端已产出可靠在线证据日志（friend-activity.js recordActivity ->
// utils.log -> worker setLogHook -> admin emitRealtimeLog('log:new',
// { accountId, time, tag, msg, isWarn, meta: { module, event, friendGid, source, at } }))，
// 但 Friends.vue 只靠 30 秒快照刷新，页面在线标记明显迟到。
// 本文件用真实 friend store + 真实 Friends.vue script setup 验证：
// 1) 可靠在线源证据（at_home/presence_online，2026-09-26 起 lands_push 剔除）到达立即点亮好友 online；
// 2) 异账号 / 非在线源 / 过期(>10s) / 未来时刻 / 无效 gid / 其它 event 零变化；
// 3) 10 秒过期撤销在线标记；
// 4) fetchFriends 晚响应不覆盖更新的实时证据；代次保护下旧 finally 不清新请求 loading；
// 5) clearFriendData / 换账号清掉事件状态，旧响应不污染新账号；
// 6) 页面卸载后不再处理 log:new。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '../..');
const modules = path.join(root, 'web/node_modules');
const vue = require(path.join(modules, 'vue'));
const pinia = require(path.join(modules, 'pinia'));
const compiler = require(path.join(modules, 'vue/compiler-sfc'));
const ts = require(path.join(modules, 'typescript'));

function evaluate(source, deps, globals = {}) {
    const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ESNext } }).outputText;
    const mod = { exports: {} };
    vm.compileFunction(code, ['require', 'module', 'exports', ...Object.keys(globals)])(name => {
        assert.ok(name in deps, `unexpected import ${name}`);
        return deps[name];
    }, mod, mod.exports, ...Object.values(globals));
    return mod.exports;
}

function deferred() {
    let resolve;
    const promise = new Promise((res) => { resolve = res; });
    return { promise, resolve };
}

// 真实 worker 日志包形状（worker.js setLogHook + admin.js emitRealtimeLog）
function evidenceLog(accountId, friendGid, source, at, event = 'friend_activity_evidence') {
    return { accountId, time: '2026-09-26 10:00:00', tag: '好友', msg: 'fixture', isWarn: false, meta: { module: 'friend', event, friendGid, source, at } };
}

const friendSource = fs.readFileSync(path.join(root, 'web/src/stores/friend.ts'), 'utf8');

// ==================== store 级 ====================

function storeHarness(accountId = 'account-a') {
    const account = vue.reactive({ currentAccountId: accountId });
    const calls = [];
    const apiStub = {
        get: (url) => { const d = deferred(); calls.push({ url, ...d }); return d.promise; },
        post: async () => ({ data: { ok: true } }),
    };
    const storeModule = evaluate(friendSource, {
        pinia,
        vue,
        '@/api': { __esModule: true, default: apiStub },
        '@/stores/account': { useAccountStore: () => account },
    });
    const store = storeModule.useFriendStore(pinia.createPinia());
    return { store, account, calls };
}

test('store: reliable online evidence lights friend online immediately; unreliable ones do nothing', () => {
    const h = storeHarness();
    const now = Date.now();
    h.store.friends = [{ gid: 1001, name: 'a' }, { gid: 1002, name: 'b' }];

    assert.equal(h.store.applyOnlineEvidenceLog(evidenceLog('account-a', 1001, 'at_home', now), now), true);
    assert.equal(h.store.friends[0].online, true);
    assert.equal(h.store.friends[0].activeAt, now);

    for (const bad of [
        evidenceLog('account-b', 1002, 'at_home', now), // 异账号
        evidenceLog('account-a', 1002, 'social_item_placed', now), // 非在线源
        evidenceLog('account-a', 1002, 'summary_drift', now),
        evidenceLog('account-a', 1002, 'at_home', now - 10_001), // 过期
        evidenceLog('account-a', 1002, 'at_home', now + 60_000), // 未来
        evidenceLog('account-a', 0, 'at_home', now), // 无效 gid
        evidenceLog('account-a', 1002, 'at_home', now, 'other_event'), // 其它 event
    ]) {
        assert.equal(h.store.applyOnlineEvidenceLog(bad, now), false);
    }
    // gid 边界：Infinity / 负数必须拒绝
    assert.equal(h.store.applyOnlineEvidenceLog(evidenceLog('account-a', Infinity, 'at_home', now), now), false);
    assert.equal(h.store.applyOnlineEvidenceLog(evidenceLog('account-a', -5, 'at_home', now), now), false);
    assert.equal(h.store.friends[1].online, undefined);
});

test('store: evidence older than 10s revokes online mark; clearFriendData wipes evidence', () => {
    const h = storeHarness();
    const now = Date.now();
    h.store.friends = [{ gid: 1001, name: 'a' }];
    assert.equal(h.store.applyOnlineEvidenceLog(evidenceLog('account-a', 1001, 'at_home', now), now), true);
    h.store.expireOnlineEvidence(now + 10_001);
    assert.equal(h.store.friends[0].online, false);
    assert.deepEqual(h.store.onlineEvidence, {});

    assert.equal(h.store.applyOnlineEvidenceLog(evidenceLog('account-a', 1001, 'presence_online', now), now), true);
    h.store.clearFriendData();
    assert.deepEqual(h.store.onlineEvidence, {});
    h.store.friends = [{ gid: 1001, name: 'a' }];
    h.store.expireOnlineEvidence(now + 10_001);
    assert.equal(h.store.friends[0].online, undefined, '清空证据后过期撤销不应再碰 online 字段');
});

test('store: late fetchFriends response cannot overwrite fresher realtime evidence', async () => {
    const h = storeHarness();
    const pending = h.store.fetchFriends('account-a');
    const now = Date.now();
    assert.equal(h.store.applyOnlineEvidenceLog(evidenceLog('account-a', 1001, 'at_home', now), now), true);
    // 晚到的列表响应（不含 online 字段）必须合并实时证据
    h.calls[0].resolve({ data: { ok: true, data: [{ gid: 1001, name: 'a' }] } });
    await pending;
    assert.equal(h.store.friends[0].online, true);
    assert.equal(h.store.friends[0].activeAt, now);
    assert.equal(h.store.loading, false);
});

test('store: generation guard — older finally cannot clear newer request loading', async () => {
    const h = storeHarness();
    const p1 = h.store.fetchFriends('account-a');
    const p2 = h.store.fetchFriends('account-a');
    assert.equal(h.store.loading, true);
    h.calls[0].resolve({ data: { ok: true, data: [{ gid: 1001 }] } });
    await p1;
    assert.equal(h.store.loading, true, '旧请求 finally 不清新请求的 loading');
    h.calls[1].resolve({ data: { ok: true, data: [{ gid: 1002 }] } });
    await p2;
    assert.equal(h.store.loading, false);
    assert.equal(h.store.friends[0].gid, 1002, '旧响应不覆盖新响应');
});

test('store: clearFriendData bumps generation — stale response cannot repopulate list', async () => {
    const h = storeHarness();
    h.store.friends = [{ gid: 1001, name: 'old' }];
    const pending = h.store.fetchFriends('account-a');
    assert.equal(h.store.loading, true);
    // 清空且没有新 fetch（例如 A→B→A 或手动清空）
    h.store.clearFriendData();
    assert.deepEqual(h.store.friends, []);
    assert.equal(h.store.loading, false, '清空时 loading 复位');
    // 旧 A 响应到达：当前账号仍是 A，但代次已前移，不得写回
    h.calls[0].resolve({ data: { ok: true, data: [{ gid: 1001, name: 'stale' }] } });
    await pending;
    assert.deepEqual(h.store.friends, [], '旧响应不得重新写回已清空的列表');
    assert.equal(h.store.loading, false, '旧 finally 不得影响清空后的 loading');
});

test('store: account switch rejects evidence for the other account', () => {
    const h = storeHarness('account-a');
    const now = Date.now();
    h.store.friends = [{ gid: 1001, name: 'a' }];
    h.account.currentAccountId = 'account-b';
    assert.equal(h.store.applyOnlineEvidenceLog(evidenceLog('account-a', 1001, 'at_home', now), now), false);
    assert.equal(h.store.friends[0].online, undefined);
});

// ==================== 页面级（真实 Friends.vue script setup） ====================

const componentStub = { __esModule: true, default: { render: () => null } };

function pageHarness() {
    const intervals = [];
    const account = {
        currentAccountId: vue.ref('account-a'),
        currentAccount: vue.ref({ id: 'account-a', running: true, platform: 'qq' }),
    };
    const logsRef = vue.ref([]);
    // 对齐真实 status store 的在线证据独立订阅通道（status.ts onOnlineEvidence /
    // dispatchOnlineEvidence）：Set 回调逐条分发，仅分发 friend_activity_evidence，
    // 分发与日志展示（logs 数组）解耦——日志未入 logs 也能点亮。
    const evidenceListeners = new Set();
    const statusStub = {
        status: vue.ref({ connection: { connected: true } }),
        loading: vue.ref(false),
        realtimeConnected: vue.ref(true),
        currentStatusReady: vue.ref(true),
        logs: logsRef,
        fetchStatus: async () => {},
        clearAccountScopedData() { logsRef.value = []; },
        onOnlineEvidence(cb) {
            evidenceListeners.add(cb);
            return () => { evidenceListeners.delete(cb); };
        },
    };
    const dispatchOnlineEvidence = (entry) => {
        const meta = entry?.meta;
        if (!meta || meta.event !== 'friend_activity_evidence')
            return;
        for (const cb of evidenceListeners) {
            try { cb(entry); } catch { /* 单订阅者异常不阻断 */ }
        }
    };
    const toastStub = { info() {}, success() {}, error() {} };
    // reactive 包装让 ref 字段在属性访问时解包（对齐真实 pinia store 行为）
    const accountStore = vue.reactive(account);
    const statusStore = vue.reactive(statusStub);
    const piniaInstance = pinia.createPinia();
    const friendMod = evaluate(friendSource, {
        pinia,
        vue,
        '@/api': { __esModule: true, default: { get: () => new Promise(() => {}), post: async () => ({ data: { ok: true } }) } },
        '@/stores/account': { useAccountStore: () => account },
    });
    const friendStore = friendMod.useFriendStore(piniaInstance);

    const filename = path.join(root, 'web/src/views/Friends.vue');
    const { descriptor } = compiler.parse(fs.readFileSync(filename, 'utf8'), { filename });
    const source = compiler.compileScript(descriptor, { id: 'friends-online-test' }).content;
    const View = evaluate(source, {
        vue,
        pinia,
        '@vueuse/core': { useIntervalFn: (callback) => { const interval = { callback, active: false }; intervals.push(interval); return { pause: () => {}, resume: () => {} }; } },
        '@/api': { __esModule: true, default: { post: async () => ({ data: { ok: true } }) } },
        '@/components/ConfirmModal.vue': componentStub,
        '@/components/friends/FriendsFriendList.vue': componentStub,
        '@/components/friends/FriendsPageHeader.vue': componentStub,
        '@/components/friends/FriendsSyncSettings.vue': componentStub,
        '@/components/friends/FriendsTabs.vue': componentStub,
        '@/stores/account': { useAccountStore: () => accountStore },
        '@/stores/friend': { useFriendStore: () => friendStore },
        '@/stores/status': { useStatusStore: () => statusStore },
        '@/stores/toast': { useToastStore: () => toastStub },
        '@/utils/number-format': { formatGoldAmount: v => String(v) },
    }).default;
    View.render = () => null;
    const renderer = vue.createRenderer({ createComment: () => ({}), insert() {}, remove() {}, parentNode: () => null, nextSibling: () => null });
    const app = renderer.createApp({ render: () => vue.h(View) });
    app.use(piniaInstance);
    app.mount({});
    return { app, account: accountStore, status: statusStore, friendStore, intervals, dispatchOnlineEvidence };
}

test('page: log:new reliable evidence lights online immediately without waiting for snapshot', async () => {
    const h = pageHarness();
    try {
        h.friendStore.friends = [{ gid: 1001, name: 'a' }];
        const now = Date.now();
        h.status.logs.push(evidenceLog('account-a', 1001, 'at_home', now));
        await vue.nextTick();
        assert.equal(h.friendStore.friends[0].online, true);
        // 异账号 / 非在线源 / 旧日志零变化
        h.status.logs.push(evidenceLog('account-b', 1001, 'at_home', now));
        h.status.logs.push(evidenceLog('account-a', 1001, 'social_item_placed', now));
        h.status.logs.push(evidenceLog('account-a', 1001, 'at_home', now - 60_000));
        await vue.nextTick();
        assert.equal(h.friendStore.friends.filter(f => f.online).length, 1);
        // 快照整体替换（logs:snapshot）：历史日志不点亮，替换后新推送仍能处理
        h.status.logs = [evidenceLog('account-a', 1001, 'at_home', now - 60_000)];
        await vue.nextTick();
        assert.equal(h.friendStore.friends[0].online, true, '替换快照本身不改状态');
        h.status.logs.push(evidenceLog('account-a', 1002, 'at_home', now));
        await vue.nextTick();
        assert.equal(Object.keys(h.friendStore.onlineEvidence).includes('1002'), true, '快照替换后仍能处理新推送');
        // 卸载后不再处理
        h.app.unmount();
        h.status.logs.push(evidenceLog('account-a', 1003, 'at_home', Date.now()));
        await vue.nextTick();
        assert.equal(Object.keys(h.friendStore.onlineEvidence).includes('1003'), false, '页面卸载后无后续处理');
    }
    finally {
        try { h.app.unmount(); } catch {}
    }
});

test('page: direct online-evidence channel lights friend even when log is not shown in logs array; unmount unsubscribes', async () => {
    const h = pageHarness();
    try {
        h.friendStore.friends = [{ gid: 2001, name: 'synthetic-a' }, { gid: 2002, name: 'synthetic-b' }];
        const now = Date.now();
        // 日志展示关闭（未入 logs 数组）场景：独立订阅通道仍同步分发并点亮
        const before = h.status.logs.length;
        h.dispatchOnlineEvidence(evidenceLog('account-a', 2001, 'at_home', now));
        assert.equal(h.status.logs.length, before, '分发不写入日志展示数组');
        await vue.nextTick();
        assert.equal(h.friendStore.friends[0].online, true, '未入 logs 数组的证据经直连通道点亮');
        // 非 friend_activity_evidence 事件不分发
        h.dispatchOnlineEvidence(evidenceLog('account-a', 2002, 'at_home', now, 'other_event'));
        await vue.nextTick();
        assert.equal(h.friendStore.friends[1].online, undefined, '非在线证据事件零效果');
        // 卸载退订：同一通道再分发不再被消费
        h.app.unmount();
        h.dispatchOnlineEvidence(evidenceLog('account-a', 2002, 'at_home', Date.now()));
        await vue.nextTick();
        assert.equal(Object.keys(h.friendStore.onlineEvidence).includes('2002'), false, 'unmount 退订后不再消费');
    }
    finally {
        try { h.app.unmount(); } catch {}
    }
});

test('page: 1s ticker revokes expired online evidence', async () => {
    const h = pageHarness();
    try {
        h.friendStore.friends = [{ gid: 1001, name: 'a' }];
        const now = Date.now();
        h.status.logs.push(evidenceLog('account-a', 1001, 'at_home', now));
        await vue.nextTick();
        assert.equal(h.friendStore.friends[0].online, true);
        // 页面 ticker 每秒调用 expireOnlineEvidence()（真实时钟），这里直接验证
        // ticker 已注册且撤销链路生效：把证据视为过期（now 前移 10.5s）
        h.friendStore.expireOnlineEvidence(now + 10_501);
        assert.equal(h.friendStore.friends[0].online, false);
        assert.equal(h.intervals.length >= 2, true, '页面 ticker 已注册（含在线过期撤销）');
        assert.equal(typeof h.intervals[0].callback, 'function');
    }
    finally {
        h.app.unmount();
    }
});

test('page: log bridge still fires when logs are pinned at the 1000-entry cap', async () => {
    const h = pageHarness();
    try {
        h.friendStore.friends = [{ gid: 1001, name: 'a' }, { gid: 1002, name: 'b' }, { gid: 1003, name: 'c' }];
        const now = Date.now();
        // 用过期历史日志填满 1000 条（时间窗过滤保证它们零效果），对齐 pushRealtimeLog 的 slice(-1000) 上限
        const filler = Array.from({ length: 1000 }, (_, i) =>
            evidenceLog('account-a', 9000 + i, 'at_home', now - 60_000));
        h.status.logs = filler;
        await vue.nextTick();
        assert.equal(Object.keys(h.friendStore.onlineEvidence).length, 0, '填充日志全部过期，零效果');

        // 上限后的追加：push 后 slice(-1000) 得到等长新数组（身份变化、长度仍 1000）
        const capped = [...filler, evidenceLog('account-a', 1001, 'at_home', now)].slice(-1000);
        assert.equal(capped.length, 1000);
        h.status.logs = capped;
        await vue.nextTick();
        assert.equal(h.friendStore.friends[0].online, true, '等长数组替换后新日志仍被消费');

        // 同一数组上等长原地回绕（shift 后 push，长度/身份不变、末条变化）；必须经 reactive 代理触发
        h.status.logs.shift();
        h.status.logs.push(evidenceLog('account-a', 1002, 'at_home', now));
        await vue.nextTick();
        assert.equal(h.friendStore.friends[1].online, true, '同数组等长追加（末条变化）仍被消费');
    }
    finally {
        h.app.unmount();
    }
});

test('page: log bridge ignores pushes when current account is not running', async () => {
    const h = pageHarness();
    try {
        h.friendStore.friends = [{ gid: 1001, name: 'a' }];
        h.account.currentAccount = { id: 'account-a', running: false, platform: 'qq' };
        h.status.logs.push(evidenceLog('account-a', 1001, 'at_home', Date.now()));
        await vue.nextTick();
        assert.equal(h.friendStore.friends[0].online, undefined, '账号未运行时不处理 log:new');
        h.account.currentAccount = { id: 'account-a', running: true, platform: 'qq' };
        h.status.logs.push(evidenceLog('account-a', 1002, 'at_home', Date.now()));
        await vue.nextTick();
        assert.equal(Object.keys(h.friendStore.onlineEvidence).includes('1001'), false, '未运行期间积压的日志在恢复运行后也不补处理');
        assert.equal(Object.keys(h.friendStore.onlineEvidence).includes('1002'), true, '恢复运行后的新日志正常处理');
    }
    finally {
        h.app.unmount();
    }
});
