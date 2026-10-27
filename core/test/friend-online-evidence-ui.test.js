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
    let reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
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
    // 2026-09-28 定标：social_item_placed 升辅助在线源，应点亮
    assert.equal(h.store.applyOnlineEvidenceLog(evidenceLog('account-a', 1002, 'social_item_placed', now), now), true);
    assert.equal(h.store.friends[1].online, true);
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

// ==================== 重点名单管理块（2026-10-07 陈旧名单治理）====================

function watchlistStoreHarness(accountId = 'account-a') {
    const account = vue.reactive({ currentAccountId: accountId });
    const calls = { gets: [], posts: [] };
    const apiStub = {
        get: (url) => { const d = deferred(); calls.gets.push({ url, ...d }); return d.promise; },
        post: (url) => { const d = deferred(); calls.posts.push({ url, ...d }); return d.promise; },
    };
    const storeModule = evaluate(friendSource, {
        pinia,
        vue,
        '@/api': { __esModule: true, default: apiStub },
        '@/stores/account': { useAccountStore: () => account },
    });
    return { store: storeModule.useFriendStore(pinia.createPinia()), account, calls };
}

test('store: watchlist read lands alongside friends read (concurrent, both applied)', async () => {
    const h = watchlistStoreHarness();
    const p1 = h.store.fetchFriends('account-a');
    const p2 = h.store.fetchWatchlist('account-a');
    assert.equal(h.calls.gets.map(call => call.url).includes('/api/friend-watchlist'), true);
    // 好友列表先落地，重点名单后落地，两者互不阻塞
    h.calls.gets[0].resolve({ data: { ok: true, data: [{ gid: 1001, name: 'a' }] } });
    await p1;
    assert.deepEqual(h.store.friends.map(f => f.gid), [1001]);
    assert.deepEqual(h.store.watchlist, [], '名单未返回前不阻塞也不虚标');
    h.calls.gets[1].resolve({ data: { ok: true, data: [{ gid: 1002, name: '', avatarUrl: '', paused: true, pausedAt: 1, trailingFailures: 3 }], meta: { opSeq: 5, consumedOpSeq: 3 } } });
    await p2;
    assert.equal(h.store.watchlist.length, 1);
    assert.deepEqual(h.store.watchlistMeta, { opSeq: 5, consumedOpSeq: 3 });
});

test('store: stale watchlist reads dropped (older opSeq after resume; in-flight after clearFriendData)', async () => {
    const h = watchlistStoreHarness();
    // 模拟 resume 后的新状态（opSeq 5）已写入
    const p1 = h.store.fetchWatchlist('account-a');
    h.calls.gets[0].resolve({ data: { ok: true, data: [{ gid: 1002, paused: false }], meta: { opSeq: 5, consumedOpSeq: 5 } } });
    await p1;
    assert.equal(h.store.watchlist[0].paused, false);
    // 之后到达的旧快照（opSeq 4，paused:true）不得覆盖
    const p2 = h.store.fetchWatchlist('account-a');
    h.calls.gets[1].resolve({ data: { ok: true, data: [{ gid: 1002, paused: true }], meta: { opSeq: 4, consumedOpSeq: 4 } } });
    await p2;
    assert.equal(h.store.watchlist[0].paused, false, '旧 opSeq 快照不得回退已恢复的展示');
    assert.equal(h.store.watchlistMeta.opSeq, 5);
    // clearFriendData 之后到达的在途响应（代次已前移）不得写回
    const p3 = h.store.fetchWatchlist('account-a');
    h.store.clearFriendData();
    assert.deepEqual(h.store.watchlist, []);
    h.calls.gets[2].resolve({ data: { ok: true, data: [{ gid: 1002, paused: true }], meta: { opSeq: 6, consumedOpSeq: 5 } } });
    await p3;
    assert.deepEqual(h.store.watchlist, [], '清空后的在途旧响应不得写回');
});

test('store: notify state reflects saved/notifyAttempted; failed save keeps previous state', async () => {
    const h = watchlistStoreHarness();
    const p1 = h.store.toggleWatchlist('account-a', 1002);
    h.calls.posts[0].resolve({ data: { ok: true, saved: true, notifyAttempted: true, data: [{ gid: 1002 }], meta: { opSeq: 1, consumedOpSeq: 0 } } });
    assert.deepEqual(await p1, { ok: true, stale: false });
    assert.deepEqual(h.store.watchlistNotify, { saved: true, notifyAttempted: true });
    // 保存失败：ok=false 不更新通知状态
    const p2 = h.store.removeWatchlist('account-a', 1002);
    h.calls.posts[1].resolve({ data: { ok: false, saved: false, notifyAttempted: false, data: [], meta: { opSeq: 1, consumedOpSeq: 0 } } });
    assert.deepEqual(await p2, { ok: false, stale: false });
    assert.deepEqual(h.store.watchlistNotify, { saved: true, notifyAttempted: true }, '失败请求不得谎报已保存');
    assert.deepEqual(h.store.watchlist, [], '失败响应的回滚名单如实应用');
    // 账号未运行场景：保存成功但只标记 notifyAttempted=false
    const p3 = h.store.resumeWatchlist('account-a', 1002);
    h.calls.posts[2].resolve({ data: { ok: true, saved: true, notifyAttempted: false, data: [{ gid: 1002, paused: true }], meta: { opSeq: 2, consumedOpSeq: 1 } } });
    await p3;
    assert.deepEqual(h.store.watchlistNotify, { saved: true, notifyAttempted: false });
    assert.equal(h.store.watchlist[0].paused, true, 'Worker 未消费前展示保持暂停（诚实展示）');
});

test('store: account switch during pending resume returns stale and writes nothing', async () => {
    const h = watchlistStoreHarness();
    h.store.watchlist = [{ gid: 1002, name: '', avatarUrl: '', paused: true, pausedAt: 1, trailingFailures: 3 }];
    const pending = h.store.resumeWatchlist('account-a', 1002);
    h.account.currentAccountId = 'account-b';
    h.calls.posts[0].resolve({ data: { ok: true, saved: true, notifyAttempted: true, data: [{ gid: 1002, paused: false }], meta: { opSeq: 9, consumedOpSeq: 9 } } });
    assert.deepEqual(await pending, { ok: false, stale: true });
    assert.equal(h.store.watchlist[0].paused, true, '账号切换后的旧响应不得写名单');
    assert.deepEqual(h.store.watchlistMeta, { opSeq: 0, consumedOpSeq: 0 });
    assert.deepEqual(h.store.watchlistNotify, { saved: false, notifyAttempted: false });
});

// ---- 页面级：真实 Friends.vue 模板渲染（管理块三布局 + 三态通知）----

function makeNodeOps() {
    let seq = 0;
    const node = (type, tag) => ({ id: seq++, type, tag, children: [], text: '', props: {}, parent: null });
    return {
        createElement(tag) { return node(1, tag); },
        createText(text) { const el = node(2); el.text = text; return el; },
        createComment(text) { const el = node(3); el.text = text; return el; },
        setText(el, text) { el.text = text; },
        setElementText(el, text) { el.children = []; if (text) { const t = node(2); t.text = text; el.children.push(t); } },
        parentNode(el) { return el.parent; },
        nextSibling(el) {
            const parent = el.parent; if (!parent) return null;
            return parent.children[parent.children.indexOf(el) + 1] || null;
        },
        insert(el, parent, anchor) {
            if (el.parent) { const i = el.parent.children.indexOf(el); if (i !== -1) el.parent.children.splice(i, 1); }
            const at = anchor ? parent.children.indexOf(anchor) : -1;
            if (at === -1) parent.children.push(el); else parent.children.splice(at, 0, el);
            el.parent = parent;
        },
        remove(el) { if (el.parent) { const i = el.parent.children.indexOf(el); if (i !== -1) el.parent.children.splice(i, 1); el.parent = null; } },
        patchProp(el, key, prev, next) { el.props[key] = next; },
    };
}

const textOf = el => (el.type === 2 ? el.text : el.children.map(textOf).join(''));

function watchlistPageHarness({ running = false, connected = true, api } = {}) {
    const account = {
        currentAccountId: vue.ref('account-a'),
        currentAccount: vue.ref({ id: 'account-a', running, platform: 'qq' }),
    };
    const logsRef = vue.ref([]);
    const statusStub = {
        status: vue.ref({ connection: { connected } }),
        loading: vue.ref(false),
        realtimeConnected: vue.ref(true),
        currentStatusReady: vue.ref(true),
        logs: logsRef,
        fetchStatus: async () => {},
        clearAccountScopedData() { logsRef.value = []; },
        onOnlineEvidence() { return () => {}; },
    };
    const toasts = [];
    const toastStub = {
        info: m => toasts.push({ kind: 'info', message: m }),
        success: m => toasts.push({ kind: 'success', message: m }),
        error: m => toasts.push({ kind: 'error', message: m }),
    };
    const accountStore = vue.reactive(account);
    const statusStore = vue.reactive(statusStub);
    const urls = [];
    // 可注入后端真实路由链（api 参数）；默认不渗透承诺（GET 悬挂）
    const baseApi = api || {
        get: () => new Promise(() => {}),
        post: async () => ({ data: { ok: true } }),
    };
    const apiStub = {
        get: (url, config) => { urls.push(url); return baseApi.get(url, config); },
        post: (url, body, config) => { urls.push(url); return baseApi.post(url, body, config); },
    };
    const piniaInstance = pinia.createPinia();
    const friendMod = evaluate(friendSource, {
        pinia,
        vue,
        '@/api': { __esModule: true, default: apiStub },
        '@/stores/account': { useAccountStore: () => account },
    });
    const friendStore = friendMod.useFriendStore(piniaInstance);

    const filename = path.join(root, 'web/src/views/Friends.vue');
    // 模板内联处理器含 TS 断言（$event.target as HTMLImageElement），预编译
    // 模板不转译 TS 表达式——夹具里去掉断言再编译（仅展示用，无行为差异）
    const raw = fs.readFileSync(filename, 'utf8')
        .replace('($event.target as HTMLImageElement).style.display', '($event.target).style.display');
    const { descriptor } = compiler.parse(raw, { filename });
    const compiled = compiler.compileScript(descriptor, { id: 'friends-watchlist-test' });
    const View = evaluate(compiled.content, {
        vue,
        pinia,
        '@vueuse/core': { useIntervalFn: () => ({ pause() {}, resume() {} }) },
        '@/api': { __esModule: true, default: apiStub },
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
    // 真实模板渲染：bindingMetadata 让 script-setup 绑定经 $setup 解析
    const template = compiler.compileTemplate({
        source: descriptor.template.content,
        filename,
        id: 'friends-watchlist-test',
        compilerOptions: { mode: 'function', bindingMetadata: compiled.bindings, hoistStatic: false },
    });
    assert.deepEqual(template.errors, []);
    View.render = vm.compileFunction(template.code, ['Vue'])(vue);

    const ops = makeNodeOps();
    const container = ops.createElement('div');
    // Teleport 目标：模板尾部有 <Teleport to="body">，字符串目标要求渲染器
    // 带 querySelector 选项；必须每次返回同一节点（mount/unmount 各查一次）
    const teleportTarget = ops.createElement('body');
    const renderer = vue.createRenderer({ ...ops, querySelector: () => teleportTarget });
    const app = renderer.createApp({ render: () => vue.h(View) });
    app.use(piniaInstance);
    app.mount(container);
    return {
        app, account: accountStore, friendStore, urls, ops, container, toasts,
        text: () => textOf(container),
    };
}

test('page: stopped account loads watchlist management without friends read; empty layout renders', async () => {
    const h = watchlistPageHarness({ running: false });
    // loadData 内部可能先 await fetchStatus 再发读取：冲刷微任务后再断言
    await vue.nextTick();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.urls.includes('/api/friend-watchlist'), true, '停止状态也要拉重点名单管理数据');
    assert.equal(h.urls.includes('/api/friends'), false, '停止状态不拉好友列表');
    const text = h.text();
    assert.equal(text.includes('重点监控管理'), true, '管理块标题渲染');
    assert.equal(text.includes('0 个目标'), true, '空名单计数');
    assert.equal(text.includes('暂无重点监控好友'), true, '空态引导文案');
    assert.equal(text.includes('基线巡田已暂停'), false);
    // 空好友列表布局也在同一页（暂无好友数据），无预填
    assert.equal(text.includes('暂无好友数据'), true);
});

test('page: paused items show badge + resume button; names joined from friends; GID fallback; notify three states', async () => {
    const h = watchlistPageHarness({ running: true });
    h.friendStore.friends = [{ gid: 1002, name: '甲', avatarUrl: '' }];
    h.friendStore.watchlist = [
        { gid: 1002, name: '', avatarUrl: '', paused: true, pausedAt: 1, trailingFailures: 3 },
        { gid: 1003, name: '', avatarUrl: '', paused: false, pausedAt: 0, trailingFailures: 0 },
    ];
    await vue.nextTick();
    const text = h.text();
    assert.equal(text.includes('2 个目标'), true);
    assert.equal(text.includes('甲'), true, '名称与已加载好友列表拼接');
    assert.equal(text.includes('GID:1003'), true, '好友列表缺失时回退 GID');
    assert.equal(text.includes('基线巡田已暂停（连续被拒 3 次）'), true, '暂停徽标');
    assert.equal(text.includes('恢复巡田'), true, '暂停目标才有恢复按钮');
    assert.equal(text.includes('移出名单'), true);
    // 未保存时无通知徽标（三态文案的真实链验证见下方真实路由用例）
    await vue.nextTick();
    assert.equal(h.text().includes('已保存'), false);
});

// ==================== 真实后端路由链（重点名单管理）====================
// store 意图持久化走真实模块：隔离数据目录必须在首次 require 后端模块前设置
const os = require('node:os');

// ===== 夹具创建与写边界（先解析校验，任何越界在原语调用前拒绝）=====
// 独立数据目录只隔离运行数据；目录创建与一切直接写/删目标都必须在
// 调用底层原语之前完成解析与目录边界校验——临时环境指向仓库时，
// 不允许先创建出目录再发现越界（那时越界副作用已发生）。
const crypto = require('node:crypto');
const rootReal = fs.realpathSync(root);
// 目录边界判断带路径分隔符，避免同前缀目录误判
function isInsideOrEqualDir(candidate, base) {
    const c = path.resolve(String(candidate));
    const b = path.resolve(String(base));
    return c === b || c.startsWith(b + path.sep);
}
// 创建入口：临时根（realpath 解析，防符号链接绕回仓库）、创建前缀与
// 预期目标任一越界/非法，都在调用创建原语之前拒绝
function createBackendDataDir(prefix) {
    if (typeof prefix !== 'string' || prefix.includes('..')
        || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(prefix))
        throw new Error(`非法创建前缀: ${prefix}`);
    const tempRoot = fs.realpathSync(path.resolve(os.tmpdir()));
    if (isInsideOrEqualDir(tempRoot, rootReal))
        throw new Error(`临时根不得位于仓库内: ${tempRoot}`);
    const expected = path.resolve(tempRoot, prefix);
    if (isInsideOrEqualDir(expected, rootReal))
        throw new Error(`越界创建目标: ${expected}`);
    const created = path.resolve(fs.mkdtempSync(path.join(tempRoot, prefix)));
    assert.ok(isInsideOrEqualDir(created, tempRoot),
        '独立数据目录必须位于系统临时目录内');
    assert.ok(!isInsideOrEqualDir(created, rootReal),
        '独立数据目录不得位于仓库内');
    return created;
}
const backendDir = createBackendDataDir('farm-watchlist-ui-');
process.env.FARM_DATA_DIR = backendDir;
function assertWriteInsideBackendDir(target) {
    const resolved = path.resolve(String(target));
    const base = path.resolve(backendDir);
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
        const file = path.join(root, rel);
        out[rel] = `${crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')}:${fs.statSync(file).mode & 0o777}`;
    }
    return out;
}
const candidateSourcesBefore = fingerprintCandidateSources();

test.after(() => {
    assert.deepEqual(fingerprintCandidateSources(), candidateSourcesBefore,
        '候选源码内容与权限在成功与失败路径全程不得改变');
    fs.rmSync(assertWriteInsideBackendDir(backendDir), { recursive: true, force: true });
});

test('夹具写边界：越界目标在写入前被拒绝且零写入', () => {
    const escaped = path.resolve(backendDir, '..', 'farm-watchlist-ui-escape.json');
    assert.throws(() => assertWriteInsideBackendDir(escaped), /越界/);
    assert.equal(fs.existsSync(escaped), false, '越界目标必须零写入');
    assert.throws(() => assertWriteInsideBackendDir(path.join(root, 'core/src/models/store.js')), /越界/);
    assert.equal(fs.existsSync(path.join(root, 'core/src/models/store.js')), true, '候选源码保持原状');
    const inside = path.join(backendDir, 'nested/file.json');
    assert.equal(assertWriteInsideBackendDir(inside), path.resolve(inside));
});

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
    fakeTmpdir = root;
    assert.throws(() => createBackendDataDir('farm-x-'), /临时根不得位于仓库内/);
    fakeTmpdir = path.join(root, 'core');
    assert.throws(() => createBackendDataDir('farm-x-'), /临时根不得位于仓库内/);
    // 符号链接临时根指回仓库（realpath 解析后等于仓库根）：同样创建前拒绝
    const linkDir = path.join(realRoot, `farm-root-link-${process.pid}`);
    fs.symlinkSync(rootReal, linkDir, 'dir');
    try {
        fakeTmpdir = linkDir;
        assert.throws(() => createBackendDataDir('farm-x-'), /临时根不得位于仓库内/);
    } finally {
        fs.rmSync(linkDir, { force: true });
    }
    // 合法临时根 + 越界/非法创建目标（前缀逃逸）：仍在原语调用前拒绝
    fakeTmpdir = realRoot;
    assert.throws(() => createBackendDataDir('../repo-escape-'), /非法创建前缀/);
    assert.throws(() => createBackendDataDir('farm-x-/../..'), /非法创建前缀/);
    assert.equal(calls.mkdtemp, 0, '任何拒绝路径都不得触达创建原语');
    assert.equal(calls.writes, 0, '任何拒绝路径都不得发生写入');
    assert.equal(fs.existsSync(path.join(root, 'farm-x-')), false, '仓库内零残留');
    // 合法独立临时目录仍可创建：恰好一次真实创建且位于系统临时目录内
    const okDir = createBackendDataDir('farm-x-ok-');
    assert.ok(isInsideOrEqualDir(okDir, realRoot), '合法路径创建于系统临时目录内');
    assert.equal(calls.mkdtemp, 1, '合法路径恰好一次真实创建');
    fs.rmSync(okDir, { recursive: true, force: true });
});

function extractProductionFunction(relPath, name) {
    const source = fs.readFileSync(path.join(root, 'core', relPath), 'utf8');
    // 允许缩进：runtime-engine 的 broadcastConfigToWorkers 是嵌套函数
    const declarations = [...source.matchAll(/^[ \t]*(?:async )?function (\w+)\(/gm)];
    const index = declarations.findIndex(match => match[1] === name);
    assert.ok(index >= 0, `production function ${name} exists`);
    return source.slice(declarations[index].index, declarations[index + 1]?.index || source.length);
}

// 真实广播语义：runtime-engine 的真实 broadcastConfigToWorkers 源码绑定
// 空 Worker 注册表——无运行 Worker 时循环空转（"已尝试通知"≠已送达）
function compileRealBroadcast() {
    const source = extractProductionFunction('src/runtime/runtime-engine.js', 'broadcastConfigToWorkers');
    return vm.compileFunction(`${source}\nreturn broadcastConfigToWorkers;`,
        ['workers', 'buildConfigSnapshotForAccount'])({}, () => ({}));
}

// 真实路由链：真实 createDataProvider（真实 broadcastConfig 方法）→ 真实
// registerAdminFriendRoutes → 真实 store 持久化；web api 桩只做转发
function realRouteApi() {
    const routes = {};
    const app = {
        get: (p, handler) => { routes[`GET ${p}`] = handler; },
        post: (p, handler) => { routes[`POST ${p}`] = handler; },
    };
    const store = require('../src/models/store');
    const { createDataProvider } = require('../src/runtime/data-provider');
    const { registerAdminFriendRoutes } = require('../src/controllers/admin-friend-routes');
    const provider = createDataProvider({ broadcastConfigToWorkers: compileRealBroadcast() });
    registerAdminFriendRoutes({
        app, provider, store,
        getAccountIdFromRequest: req => req.headers['x-account-id'],
        canAccessAccount: () => true,
        sendProviderError: (res, error) => res.status(500).json({ ok: false, error: String(error) }),
    });
    const request = async (method, url, { accountId = 'account-a', body = {} } = {}) => {
        const handler = routes[`${method} ${url}`];
        if (!handler) return { data: { ok: true } }; // 页面其它接口与本课题无关
        const res = {
            statusCode: 0, jsoned: undefined,
            status(code) { this.statusCode = code; return this; },
            json(payload) { this.jsoned = payload; },
        };
        await handler({ headers: { 'x-account-id': accountId }, body, query: {} }, res);
        return { data: res.jsoned };
    };
    const api = {
        get: (url, config) => request('GET', url, { accountId: config?.headers?.['x-account-id'] }),
        post: (url, body, config) => request('POST', url, { accountId: config?.headers?.['x-account-id'], body }),
    };
    return { api, store };
}

function findClickable(el, needle) {
    if (el.type === 1 && typeof el.props.onClick === 'function' && textOf(el).includes(needle))
        return el;
    for (const child of el.children) {
        const hit = findClickable(child, needle);
        if (hit) return hit;
    }
    return null;
}

const flushPage = async () => {
    await vue.nextTick();
    await new Promise(resolve => setImmediate(resolve));
};

test('page（真实路由链）: 停止+断开+普通好友数据为空——暂停条目经真实 GET 可见可操作、零好友读取；移出后离线提示回归', async () => {
    const backend = realRouteApi();
    // 服务端真值：名单配置 + 暂停状态镜像（Worker 停止前最后落盘快照）
    backend.store.setWatchlistConfig('account-a', [4001], undefined);
    assert.equal(backend.store.writeWatchlistStateMirror('account-a', {
        version: 1, consumedOpSeq: 0,
        rows: { 4001: { trailingFailures: 3, paused: true, pausedAt: 123, appliedIntentOpSeq: 0 } },
    }), true);
    const h = watchlistPageHarness({ running: false, connected: false, api: backend.api });
    try {
        await flushPage();
        assert.equal(h.urls.includes('/api/friend-watchlist'), true, '停止状态也要拉重点名单管理数据');
        assert.equal(h.urls.includes('/api/friends'), false, '停止状态不得读取普通好友列表');
        let text = h.text();
        assert.equal(text.includes('账号未登录'), false, '有名单管理数据时离线分支必须让位');
        assert.equal(text.includes('重点监控管理'), true);
        assert.equal(text.includes('1 个目标'), true);
        assert.equal(text.includes('基线巡田已暂停（连续被拒 3 次）'), true, '暂停徽标来自真实镜像');
        assert.equal(text.includes('GID:4001'), true, '好友列表缺失回退 GID 展示');

        // 恢复按钮 → 真实 POST：意图真实落盘；停止账号展示待运行文案
        const resumeBtn = findClickable(h.container, '恢复巡田');
        assert.ok(resumeBtn, '暂停目标必须有恢复按钮');
        await resumeBtn.props.onClick();
        await flushPage();
        text = h.text();
        assert.equal(text.includes('已保存（账号未运行，启动后自动应用）'), true, '停止账号：待运行文案');
        assert.equal(text.includes('基线巡田已暂停'), true, 'Worker 未消费前徽标如实保持');
        const meta = backend.store.getWatchlistResetMeta('account-a');
        // 种子保存（加入 4001）已消耗 opSeq 1，恢复意图是第二次保存
        assert.equal(meta.opSeq, 2, '恢复意图经真实路由落盘');
        assert.equal(meta.intents['4001'], 2, '恢复意图按目标登记');

        // 移出名单 → 真实 POST：条目消失；名单数据清空后离线提示回归
        const removeBtn = findClickable(h.container, '移出名单');
        assert.ok(removeBtn);
        await removeBtn.props.onClick();
        await flushPage();
        text = h.text();
        assert.equal(text.includes('GID:4001'), false, '移出后条目消失');
        assert.deepEqual(backend.store.getWatchlistFriendGids('account-a'), [], '移出经真实路由落盘');
        assert.equal(text.includes('账号未登录'), true, '名单空+断开+无好友数据 → 离线提示回归');
    }
    finally {
        h.app.unmount();
    }
});

test('page（真实路由链）: 通知三态接真实空 Worker 广播；暂停徽标独立展示', async () => {
    const backend = realRouteApi();
    backend.store.setWatchlistConfig('account-a', [4101], undefined);
    backend.store.writeWatchlistStateMirror('account-a', {
        version: 1, consumedOpSeq: 0,
        rows: { 4101: { trailingFailures: 3, paused: true, pausedAt: 1, appliedIntentOpSeq: 0 } },
    });
    // 运行中的账号（真实广播在空 Worker 注册表上执行——"已尝试"语义）
    const h = watchlistPageHarness({ running: true, connected: true, api: backend.api });
    try {
        await flushPage();
        const resumeBtn = findClickable(h.container, '恢复巡田');
        assert.ok(resumeBtn);
        await resumeBtn.props.onClick();
        await flushPage();
        let text = h.text();
        assert.equal(text.includes('已保存，等待运行中的账号应用'), true, '运行中账号：待应用文案');
        assert.equal(text.includes('基线巡田已暂停'), true, '通知文案与暂停徽标相互独立');
        assert.deepEqual(h.friendStore.watchlistNotify, { saved: true, notifyAttempted: true },
            '真实广播已尝试（空注册表也算尝试，不代表送达）');

        // Worker 消费后镜像 consumed 前进 → 真实 GET → 已生效
        backend.store.writeWatchlistStateMirror('account-a', {
            version: 1, consumedOpSeq: 9,
            rows: { 4101: { trailingFailures: 0, paused: false, pausedAt: 0, appliedIntentOpSeq: 1 } },
        });
        await h.friendStore.fetchWatchlist('account-a');
        await flushPage();
        text = h.text();
        assert.equal(text.includes('已生效'), true, 'consumed 追平 opSeq 后切换已生效');
        assert.equal(text.includes('基线巡田已暂停'), false, '镜像已解除 → 徽标消失');
    }
    finally {
        h.app.unmount();
    }
});

// ==================== 写入口生命周期与版本守卫（friend.ts）====================

test('store: 写入口生命周期守卫——清空/切换/切回后的旧写响应整体丢弃（stale，零写入）', async () => {
    // 变体1：toggle 发起后手动清空（A→B→A 或手动清空同路径）
    {
        const h = watchlistStoreHarness();
        const pending = h.store.toggleWatchlist('account-a', 1002);
        h.store.clearFriendData();
        h.calls.posts[0].resolve({ data: { ok: true, saved: true, notifyAttempted: true, data: [{ gid: 1002, paused: false }], meta: { opSeq: 3, consumedOpSeq: 2 } } });
        assert.deepEqual(await pending, { ok: false, stale: true });
        assert.deepEqual(h.store.watchlist, [], '旧写响应不得写回名单');
        assert.deepEqual(h.store.watchlistMeta, { opSeq: 0, consumedOpSeq: 0 });
        assert.deepEqual(h.store.watchlistNotify, { saved: false, notifyAttempted: false }, '旧写响应不得写通知状态');
    }
    // 变体2：remove 发起后切到 B（账号一致性守卫）
    {
        const h = watchlistStoreHarness();
        const pending = h.store.removeWatchlist('account-a', 1002);
        h.account.currentAccountId = 'account-b';
        h.calls.posts[0].resolve({ data: { ok: true, saved: true, notifyAttempted: true, data: [], meta: { opSeq: 2, consumedOpSeq: 1 } } });
        assert.deepEqual(await pending, { ok: false, stale: true });
        assert.deepEqual(h.store.watchlist, []);
    }
    // 变体3：A→B→A 切回（账号一致性恢复，只有生命周期代次能拦）
    {
        const h = watchlistStoreHarness();
        const pending = h.store.resumeWatchlist('account-a', 1002);
        h.account.currentAccountId = 'account-b';
        h.store.clearFriendData();
        h.account.currentAccountId = 'account-a';
        h.calls.posts[0].resolve({ data: { ok: true, saved: true, notifyAttempted: true, data: [{ gid: 1002, paused: false }], meta: { opSeq: 4, consumedOpSeq: 4 } } });
        assert.deepEqual(await pending, { ok: false, stale: true }, '切回原账号后代次已前移，旧写响应仍须丢弃');
        assert.deepEqual(h.store.watchlist, []);
        assert.deepEqual(h.store.watchlistMeta, { opSeq: 0, consumedOpSeq: 0 });
    }
    // 变体4：清空后新写完成，更早的旧写响应（版本更新也）后到 → 只按代次丢弃
    {
        const h = watchlistStoreHarness();
        const oldWrite = h.store.toggleWatchlist('account-a', 1002); // 旧生命周期发起
        h.store.clearFriendData();
        const newWrite = h.store.toggleWatchlist('account-a', 1003); // 新生命周期发起
        h.calls.posts[1].resolve({ data: { ok: true, saved: true, notifyAttempted: true, data: [{ gid: 1003, paused: false }], meta: { opSeq: 1, consumedOpSeq: 0 } } });
        assert.deepEqual(await newWrite, { ok: true, stale: false });
        h.calls.posts[0].resolve({ data: { ok: true, saved: true, notifyAttempted: true, data: [{ gid: 1002, paused: false }], meta: { opSeq: 9, consumedOpSeq: 9 } } });
        assert.deepEqual(await oldWrite, { ok: false, stale: true }, '旧生命周期响应即使携带更新版本也整体丢弃');
        assert.deepEqual(h.store.watchlist.map(item => item.gid), [1003], '新生命周期结果保持');
        assert.equal(h.store.watchlistMeta.opSeq, 1);
    }
});

// 请求拒绝（catch 分支）同样受生命周期守卫：旧生命周期的请求失败不是
// 当前页面的失败——清空/切换/切回后拒绝 → stale（不弹错）；当前生命周期的
// 真实失败仍如实返回 stale=false。
test('store: 写入口拒绝分支同样受生命周期守卫——旧代次请求失败按 stale 丢弃', async () => {
    // 变体1：resume 发起后手动清空，再让请求拒绝
    {
        const h = watchlistStoreHarness();
        h.store.watchlist = [{ gid: 1002, name: '', avatarUrl: '', paused: true, pausedAt: 1, trailingFailures: 3 }];
        const pending = h.store.resumeWatchlist('account-a', 1002);
        h.store.clearFriendData();
        h.calls.posts[0].reject(new Error('network down'));
        assert.deepEqual(await pending, { ok: false, stale: true });
        assert.deepEqual(h.store.watchlist, [], '拒绝分支不得写回名单');
        assert.deepEqual(h.store.watchlistMeta, { opSeq: 0, consumedOpSeq: 0 });
        assert.deepEqual(h.store.watchlistNotify, { saved: false, notifyAttempted: false });
    }
    // 变体2：remove 发起后切到 B，再让请求拒绝
    {
        const h = watchlistStoreHarness();
        const pending = h.store.removeWatchlist('account-a', 1002);
        h.account.currentAccountId = 'account-b';
        h.calls.posts[0].reject(new Error('network down'));
        assert.deepEqual(await pending, { ok: false, stale: true });
        assert.deepEqual(h.store.watchlist, []);
    }
    // 变体3：toggle 发起后 A→B→A 切回，再让请求拒绝
    {
        const h = watchlistStoreHarness();
        const pending = h.store.toggleWatchlist('account-a', 1002);
        h.account.currentAccountId = 'account-b';
        h.store.clearFriendData();
        h.account.currentAccountId = 'account-a';
        h.calls.posts[0].reject(new Error('network down'));
        assert.deepEqual(await pending, { ok: false, stale: true }, '切回原账号后代次已前移，旧请求失败仍须丢弃');
        assert.deepEqual(h.store.watchlistMeta, { opSeq: 0, consumedOpSeq: 0 });
    }
    // 变体4：清空后新写完成，更早的旧写请求再拒绝 → 只按代次丢弃
    {
        const h = watchlistStoreHarness();
        const oldWrite = h.store.toggleWatchlist('account-a', 1002);
        h.store.clearFriendData();
        const newWrite = h.store.removeWatchlist('account-a', 1003);
        h.calls.posts[1].resolve({ data: { ok: true, saved: true, notifyAttempted: true, data: [{ gid: 1003 }], meta: { opSeq: 2, consumedOpSeq: 1 } } });
        assert.deepEqual(await newWrite, { ok: true, stale: false });
        h.calls.posts[0].reject(new Error('network down'));
        assert.deepEqual(await oldWrite, { ok: false, stale: true }, '旧生命周期的请求失败不影响新生命周期结果');
        assert.deepEqual(h.store.watchlist.map(item => item.gid), [1003], '新生命周期结果保持');
    }
    // 变体5：当前生命周期的真实失败仍如实返回（三入口逐一核对）
    {
        const h = watchlistStoreHarness();
        const pToggle = h.store.toggleWatchlist('account-a', 1002);
        h.calls.posts[0].reject(new Error('network down'));
        assert.deepEqual(await pToggle, { ok: false, stale: false });
        const pResume = h.store.resumeWatchlist('account-a', 1002);
        h.calls.posts[1].reject(new Error('network down'));
        assert.deepEqual(await pResume, { ok: false, stale: false });
        const pRemove = h.store.removeWatchlist('account-a', 1002);
        h.calls.posts[2].reject(new Error('network down'));
        assert.deepEqual(await pRemove, { ok: false, stale: false });
    }
});

// 页面级：真实 Friends.vue 处理器（按钮 onClick）统计过期错误提示为零——
// 旧生命周期的请求失败不得在新页面弹"恢复巡田失败/移出重点名单失败"；
// 当前生命周期的真实失败恰好弹一次。
test('page: 旧生命周期请求拒绝零错误提示；当前生命周期失败如实提示一次', async () => {
    // 场景1：清空后旧恢复请求拒绝 → 零错误提示
    {
        const posts = [];
        const h = watchlistPageHarness({
            running: true,
            api: { get: () => new Promise(() => {}), post: url => { const d = deferred(); posts.push({ url, ...d }); return d.promise; } },
        });
        try {
            h.friendStore.watchlist = [{ gid: 1002, name: '', avatarUrl: '', paused: true, pausedAt: 1, trailingFailures: 3 }];
            await flushPage();
            const resumeBtn = findClickable(h.container, '恢复巡田');
            assert.ok(resumeBtn, '暂停目标必须有恢复按钮');
            const clicked = resumeBtn.props.onClick();
            h.friendStore.clearFriendData();
            posts[posts.length - 1].reject(new Error('network down'));
            await clicked;
            await flushPage();
            assert.equal(h.toasts.length, 0, '清空后旧请求拒绝不得弹错');
        }
        finally {
            h.app.unmount();
        }
    }
    // 场景2：切换账号后旧移除请求拒绝 → 零错误提示
    {
        const posts = [];
        const h = watchlistPageHarness({
            running: true,
            api: { get: () => new Promise(() => {}), post: url => { const d = deferred(); posts.push({ url, ...d }); return d.promise; } },
        });
        try {
            h.friendStore.watchlist = [{ gid: 1002, name: '', avatarUrl: '', paused: false, pausedAt: 0, trailingFailures: 0 }];
            await flushPage();
            const removeBtn = findClickable(h.container, '移出名单');
            assert.ok(removeBtn);
            const clicked = removeBtn.props.onClick();
            h.account.currentAccountId = 'account-b';
            posts[posts.length - 1].reject(new Error('network down'));
            await clicked;
            await flushPage();
            assert.equal(h.toasts.length, 0, '切换账号后旧请求拒绝不得弹错');
        }
        finally {
            h.app.unmount();
        }
    }
    // 场景3：当前生命周期失败 → 恰好一次错误提示
    {
        const posts = [];
        const h = watchlistPageHarness({
            running: true,
            api: { get: () => new Promise(() => {}), post: url => { const d = deferred(); posts.push({ url, ...d }); return d.promise; } },
        });
        try {
            h.friendStore.watchlist = [{ gid: 1002, name: '', avatarUrl: '', paused: true, pausedAt: 1, trailingFailures: 3 }];
            await flushPage();
            const resumeBtn = findClickable(h.container, '恢复巡田');
            const clicked = resumeBtn.props.onClick();
            posts[posts.length - 1].reject(new Error('network down'));
            await clicked;
            await flushPage();
            assert.deepEqual(h.toasts, [{ kind: 'error', message: '恢复巡田失败，请重试' }], '当前生命周期失败如实提示一次');
        }
        finally {
            h.app.unmount();
        }
    }
});

test('store: 同代次乱序——较早发起但携带较新服务端版本的响应必须应用', async () => {
    const h = watchlistStoreHarness();
    // remove 先发起（慢响应），resume 后发起（快响应）
    const pRemove = h.store.removeWatchlist('account-a', 1002);
    const pResume = h.store.resumeWatchlist('account-a', 1002);
    h.calls.posts[1].resolve({ data: { ok: true, saved: true, notifyAttempted: true, data: [{ gid: 1002, paused: false }], meta: { opSeq: 7, consumedOpSeq: 6 } } });
    assert.deepEqual(await pResume, { ok: true, stale: false });
    assert.equal(h.store.watchlist[0].paused, false);
    // remove 响应后到但携带更新的服务端版本（opSeq 8）→ 必须应用，
    // 不得按"最后发起的写请求"或发起顺序裁决
    h.calls.posts[0].resolve({ data: { ok: true, saved: true, notifyAttempted: true, data: [], meta: { opSeq: 8, consumedOpSeq: 8 } } });
    assert.deepEqual(await pRemove, { ok: true, stale: false }, '较新服务端版本的迟到响应必须应用');
    assert.deepEqual(h.store.watchlist, []);
    assert.equal(h.store.watchlistMeta.opSeq, 8);
});

test('store: 同代次乱序——较旧版本迟到响应按 stale 丢弃；保存失败回滚迟到亦然', async () => {
    const h = watchlistStoreHarness();
    // resume（opSeq 7）先回并应用；更早保存的 remove 快照（opSeq 6）后到 → 丢弃
    const pRemove = h.store.removeWatchlist('account-a', 1002);
    const pResume = h.store.resumeWatchlist('account-a', 1002);
    h.calls.posts[1].resolve({ data: { ok: true, saved: true, notifyAttempted: true, data: [{ gid: 1002, paused: false }], meta: { opSeq: 7, consumedOpSeq: 7 } } });
    await pResume;
    h.calls.posts[0].resolve({ data: { ok: true, saved: true, notifyAttempted: true, data: [], meta: { opSeq: 6, consumedOpSeq: 6 } } });
    assert.deepEqual(await pRemove, { ok: false, stale: true }, '较旧版本迟到响应必须丢弃');
    assert.equal(h.store.watchlist.length, 1, '已应用的较新状态保持');
    assert.equal(h.store.watchlistMeta.opSeq, 7);

    // 保存失败的回滚快照（opSeq 相同场景见下一条；这里是已有更新版本 opSeq 9 后
    // 迟到的 opSeq 8 回滚）→ 丢弃，不得把展示回退到更旧的名单
    const pFail = h.store.toggleWatchlist('account-a', 1004);
    h.calls.posts[2].resolve({ data: { ok: true, saved: true, notifyAttempted: true, data: [{ gid: 1004 }], meta: { opSeq: 9, consumedOpSeq: 8 } } });
    await pFail;
    const pFailOld = h.store.removeWatchlist('account-a', 1004);
    h.calls.posts[3].resolve({ data: { ok: false, saved: false, notifyAttempted: false, data: [{ gid: 1002, paused: true }], meta: { opSeq: 8, consumedOpSeq: 8 } } });
    assert.deepEqual(await pFailOld, { ok: false, stale: true }, '迟到的旧回滚快照丢弃');
    assert.deepEqual(h.store.watchlist.map(item => item.gid), [1004], '更新版本的结果不被回滚');
});

test('store: 版本相等的保存失败回滚如实应用；consumed 只前进不回退；写在途时 GET 落地', async () => {
    // 保存失败但无更新写：回滚快照（opSeq 相等）如实展示，不谎报已保存
    {
        const h = watchlistStoreHarness();
        const pOk = h.store.toggleWatchlist('account-a', 1002);
        h.calls.posts[0].resolve({ data: { ok: true, saved: true, notifyAttempted: true, data: [{ gid: 1002, paused: true }], meta: { opSeq: 2, consumedOpSeq: 2 } } });
        assert.deepEqual(await pOk, { ok: true, stale: false });
        const pFail = h.store.removeWatchlist('account-a', 1002);
        h.calls.posts[1].resolve({ data: { ok: false, saved: false, notifyAttempted: false, data: [{ gid: 1002, paused: true }], meta: { opSeq: 2, consumedOpSeq: 1 } } });
        assert.deepEqual(await pFail, { ok: false, stale: false }, '版本相等不算 stale（回滚如实展示）');
        assert.equal(h.store.watchlist[0].paused, true, '回滚名单如实应用');
        assert.deepEqual(h.store.watchlistNotify, { saved: true, notifyAttempted: true }, '失败不更新通知状态（保留上次成功）');
        assert.equal(h.store.watchlistMeta.consumedOpSeq, 2, '相等版本下 consumed 只前进不回退');
    }
    // 写在途时 GET 先落地：GET 快照如实展示；写响应携带更新版本 → 覆盖
    {
        const h = watchlistStoreHarness();
        const pWrite = h.store.resumeWatchlist('account-a', 1002);
        const pGet = h.store.fetchWatchlist('account-a');
        h.calls.gets[0].resolve({ data: { ok: true, data: [{ gid: 1002, paused: true }], meta: { opSeq: 6, consumedOpSeq: 5 } } });
        await pGet;
        assert.equal(h.store.watchlist[0].paused, true, '写在途时 GET 快照先落地');
        h.calls.posts[0].resolve({ data: { ok: true, saved: true, notifyAttempted: true, data: [{ gid: 1002, paused: false }], meta: { opSeq: 7, consumedOpSeq: 7 } } });
        assert.deepEqual(await pWrite, { ok: true, stale: false });
        assert.equal(h.store.watchlist[0].paused, false, '写响应版本更新 → 覆盖在途 GET');
        assert.equal(h.store.watchlistMeta.opSeq, 7);
    }
});
