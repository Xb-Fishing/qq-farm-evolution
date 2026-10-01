'use strict';
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
        assert.ok(name in deps, `unexpected import ${name}`); return deps[name];
    }, mod, mod.exports, ...Object.values(globals));
    return mod.exports;
}
function deferred() { let resolve; let reject; const promise = new Promise((res, rej) => { resolve = res; reject = rej; }); return { promise, resolve, reject }; }
const response = (body, ok = true) => ({ ok, status: ok ? 200 : 500, json: async () => body });
const qr = id => response({ code: 0, data: { uuid: id, qrBase64: 'fixture-image' } });
const storage = { getItem: () => '' };
function storeHarness() {
    const calls = []; const timers = [];
    const useStore = evaluate(fs.readFileSync(path.join(root, 'web/src/stores/wx-login.ts'), 'utf8'), {
        vue, pinia, './user': { useUserStore: () => ({ username: 'fixture' }) },
    }, {
        localStorage: storage,
        fetch: (url, init) => {
            if (url.endsWith('wxlogin-config')) return Promise.resolve(response({ ok: true, config: {} }));
            const pending = deferred(); calls.push({ body: JSON.parse(init.body), signal: init.signal, ...pending }); return pending.promise;
        },
        setTimeout: (fn, ms) => { const timer = { fn, ms }; timers.push(timer); return timer; }, clearTimeout: () => {},
    }).useWxLoginStore;
    return { store: useStore(pinia.createPinia()), calls, timers };
}
async function ready(h, id = 'session-a') { const pending = h.store.getQRCode(); h.calls.at(-1).resolve(qr(id)); assert.equal(await pending, true); }

test('native rejection and HTTP failure cannot be mistaken for waiting legacy QR states', async () => {
    const h = storeHarness(); await ready(h);
    for (const [body, ok] of [[{ Success: false, code: -1, Message: 'fixture authorization rejected' }, true], [{ code: -1, msg: 'fixture service failed' }, false]]) {
        const pending = h.store.checkLogin(); h.calls.at(-1).resolve(response(body, ok)); await pending;
        assert.equal(h.store.status, 'error'); assert.match(h.store.errorMessage, /fixture/);
    }
    for (const code of [-1, -2]) {
        const pending = h.store.checkLogin(); h.calls.at(-1).resolve(response({ code })); await pending;
        assert.equal(h.store.status, code === -2 ? 'confirming' : 'qr_ready');
    }
});

test('new QR aborts old check/code and ignores late success, rejection and finally', async () => {
    for (const kind of ['check', 'code']) {
        for (const failure of [false, true]) {
            const h = storeHarness(); await ready(h);
            const pending = kind === 'check' ? h.store.checkLogin() : h.store.getFarmCode('fixture-user');
            const old = h.calls.at(-1);
            const next = h.store.getQRCode(); const latest = h.calls.at(-1);
            assert.equal(old.signal.aborted, true);
            if (failure) old.reject(new Error('fixture old failure'));
            else old.resolve(response({ code: 0, data: { wxid: 'obsolete', code: 'obsolete' } }));
            assert.equal((await pending).success, false);
            assert.equal(h.store.status, 'qr_loading'); assert.equal(h.store.isLoading, true); assert.equal(h.store.wxid, '');
            latest.resolve(qr('session-b')); await next;
            assert.equal(h.store.uuid, 'session-b'); assert.equal(h.store.status, 'qr_ready'); assert.equal(h.store.isLoading, false);
        }
    }
});

test('check and code timeouts abort transport and surface bounded failure; reset clears loading', async () => {
    const h = storeHarness(); await ready(h);
    for (const [kind, limit] of [['check', 120_000], ['code', 120_000]]) {
        const pending = kind === 'check' ? h.store.checkLogin() : h.store.getFarmCode('fixture-user');
        const request = h.calls.at(-1); const timer = h.timers.at(-1);
        assert.equal(timer.ms, limit);
        request.signal.addEventListener('abort', () => request.reject(request.signal.reason));
        timer.fn(); await pending;
        assert.equal(h.store.status, 'error'); assert.match(h.store.errorMessage, /超时/); assert.equal(h.store.isLoading, false);
    }
    h.store.resetState(); assert.equal(h.store.status, 'idle'); assert.equal(h.store.isLoading, false);
});

function modalHarness(show = true) {
    const intervals = []; const saves = []; const pendingCode = deferred(); let qrCount = 0; let codeCalls = 0; let codeResponder = () => pendingCode.promise;
    const wx = vue.reactive({ isLoading: false, status: 'idle', uuid: show ? '' : 'other-session', qrCode: '', qrCreatedAt: 0, config: { autoAddAccount: true },
        resetState() { this.isLoading = false; this.uuid = ''; this.status = 'idle'; },
        async getQRCode() { this.uuid = `session-${++qrCount}`; this.status = 'qr_ready'; this.qrCreatedAt = Date.now(); return true; },
        async checkLogin() { this.wxid = 'fixture-user'; return { success: true, wxid: 'fixture-user', nickname: 'fixture' }; },
        retryable: false,
        canRetryFarmCode() { return this.retryable && this.status === 'error'; },
        async getFarmCode() { codeCalls++; const result = await codeResponder(); this.retryable = result.definitive !== true; this.status = result.success ? 'success' : 'error'; return result; },
    });
    const filename = path.join(root, 'web/src/components/AccountModal.vue');
    const { descriptor } = compiler.parse(fs.readFileSync(filename, 'utf8').replace('</script>', '\ndefineExpose({ activeTab, wxChecking, loading, close, retryWxCode })\n</script>'), { filename });
    const source = compiler.compileScript(descriptor, { id: 'wx-modal-test' }).content;
    const stub = { __esModule: true, default: {} };
    const Modal = evaluate(source, {
        vue,
        '@vueuse/core': { useIntervalFn: callback => { const interval = { callback, active: false }; intervals.push(interval); return { pause: () => { interval.active = false; }, resume: () => { interval.active = true; } }; } },
        '@/api': { __esModule: true, default: { get: async () => ({ data: {} }), post: async (_url, body) => { saves.push(body); return { data: { ok: true } }; } } },
        '@/components/ui/BaseButton.vue': stub, '@/components/ui/BaseInput.vue': stub, '@/components/ui/BaseTextarea.vue': stub,
        '@/stores/wx-login': { useWxLoginStore: () => wx }, '@/utils/gateway-url': { parseManualLoginInput: () => ({}) },
    }, { localStorage: storage }).default;
    Modal.render = () => null;
    const renderer = vue.createRenderer({ createComment: () => ({}), insert() {}, remove() {}, parentNode: () => null, nextSibling: () => null });
    const props = vue.reactive({ show, initialTab: 'wx', editData: { id: 'account-a', name: 'fixture' } });
    let instance;
    const app = renderer.createApp({ render: () => vue.h(Modal, { ...props, ref: value => { instance = value; } }) });
    app.mount({});
    return { app, props, wx, saves, pendingCode, intervals, instance: () => instance, qrCount: () => qrCount, codeCalls: () => codeCalls, setCodeResponder: fn => { codeResponder = fn; } };
}

test('real modal preserves initial wx tab and reopening same tab creates exactly one QR and resumes polling', async () => {
    const h = modalHarness();
    try {
        await vue.nextTick(); assert.equal(h.instance().activeTab, 'wx'); assert.equal(h.qrCount(), 1); assert.equal(h.intervals[0].active, true);
        h.props.show = false; await vue.nextTick(); assert.equal(h.intervals[0].active, false);
        h.props.show = true; await vue.nextTick(); await vue.nextTick();
        assert.equal(h.qrCount(), 2); assert.equal(h.intervals[0].active, true);
    } finally { h.app.unmount(); }
});

test('real modal never saves a late Code into a reopened session or another account', async () => {
    const h = modalHarness();
    try {
        await vue.nextTick(); const poll = h.intervals[0].callback(); await vue.nextTick();
        h.props.show = false; await vue.nextTick();
        h.props.editData = { id: 'account-b', name: 'fixture-next' }; h.props.show = true; await vue.nextTick(); await vue.nextTick();
        h.pendingCode.resolve({ success: true, code: 'fixture-code' }); await poll;
        assert.equal(h.saves.length, 0); assert.equal(h.wx.uuid, 'session-2'); assert.equal(h.intervals[0].active, true); assert.equal(h.instance().wxChecking, false);
    } finally { h.app.unmount(); }
});

test('real modal saves confirmed Code with the matching QR session and selected target', async () => {
    const h = modalHarness();
    try {
        await vue.nextTick(); const poll = h.intervals[0].callback(); await vue.nextTick();
        h.pendingCode.resolve({ success: true, code: 'fixture-code' }); await poll;
        assert.equal(h.saves.length, 1); assert.equal(h.saves[0].id, 'account-a'); assert.equal(h.saves[0].wxSessionId, 'session-1');
    } finally { h.app.unmount(); }
});


test('hidden modal mount and unmount never reset another modal shared QR session', async () => {
    const h = modalHarness(false);
    await vue.nextTick(); assert.equal(h.wx.uuid, 'other-session'); assert.equal(h.qrCount(), 0);
    h.app.unmount(); assert.equal(h.wx.uuid, 'other-session');
});

test('late QR from a reset generation cannot replace current image or clear its loading state', async () => {
    const h = storeHarness();
    const old = h.store.getQRCode(); const oldRequest = h.calls.at(-1);
    const current = h.store.getQRCode(); const currentRequest = h.calls.at(-1);
    oldRequest.resolve(qr('obsolete')); assert.equal(await old, false);
    assert.equal(h.store.uuid, ''); assert.equal(h.store.isLoading, true);
    currentRequest.resolve(qr('current')); assert.equal(await current, true);
    assert.equal(h.store.uuid, 'current'); assert.equal(h.store.isLoading, false);
});


test('temporary Code failure permits one manual retry using the same confirmed session', async () => {
    const h = modalHarness();
    try {
        await vue.nextTick(); const poll = h.intervals[0].callback(); await vue.nextTick();
        h.pendingCode.resolve({ success: false }); await poll;
        assert.equal(h.codeCalls(), 1); assert.equal(h.intervals[0].active, false);
        h.setCodeResponder(async () => ({ success: true, code: 'fixture-retry-code' }));
        await h.instance().retryWxCode();
        assert.equal(h.codeCalls(), 2); assert.equal(h.saves.length, 1); assert.equal(h.saves[0].wxSessionId, 'session-1');
    } finally { h.app.unmount(); }
});

test('manual Code retry finishing after close/reopen cannot save into the next session', async () => {
    const h = modalHarness();
    try {
        await vue.nextTick(); const poll = h.intervals[0].callback(); await vue.nextTick();
        h.pendingCode.resolve({ success: false }); await poll;
        const retry = deferred(); h.setCodeResponder(() => retry.promise); const work = h.instance().retryWxCode();
        h.props.show = false; await vue.nextTick(); h.props.show = true; await vue.nextTick();
        retry.resolve({ success: true, code: 'obsolete-retry-code' }); await work;
        assert.equal(h.saves.length, 0); assert.equal(h.qrCount(), 2);
    } finally { h.app.unmount(); }
});

test('definitive authorization loss disallows manual retry without triggering any automatic request', async () => {
    const h = storeHarness(); await ready(h);
    const check = h.store.checkLogin(); h.calls.at(-1).resolve(response({ code: 0, data: { wxid: 'fixture-user' } })); await check;
    const temporary = h.store.getFarmCode(); h.calls.at(-1).resolve(response({ Success: false, definitive: false, Message: 'fixture timeout' })); await temporary;
    assert.equal(h.store.canRetryFarmCode(), true); h.store.qrCreatedAt = Date.now() - 300_001; assert.equal(h.store.canRetryFarmCode(), false); h.store.qrCreatedAt = Date.now();
    const failed = h.store.getFarmCode(); h.calls.at(-1).resolve(response({ Success: false, definitive: true, Message: 'fixture authorization expired' })); await failed;
    assert.equal(h.store.canRetryFarmCode(), false); assert.match(h.store.errorMessage, /刷新二维码/); assert.equal(h.calls.length, 4);
    const modal = modalHarness();
    try {
        await vue.nextTick(); const poll = modal.intervals[0].callback(); await vue.nextTick();
        modal.pendingCode.resolve({ success: false, definitive: true }); await poll;
        await modal.instance().retryWxCode(); assert.equal(modal.codeCalls(), 1); assert.equal(modal.saves.length, 0); assert.equal(modal.intervals[0].active, false);
    } finally { modal.app.unmount(); }
});


test('confirmed session remains manually retryable after a 120-second Code timeout until its 300-second expiry', async () => {
    const h = storeHarness(); await ready(h);
    const check = h.store.checkLogin(); h.calls.at(-1).resolve(response({ code: 0, data: { wxid: 'fixture-user' } })); await check;
    const code = h.store.getFarmCode(); const request = h.calls.at(-1); const timer = h.timers.at(-1);
    assert.equal(timer.ms, 120_000);
    request.signal.addEventListener('abort', () => request.reject(request.signal.reason));
    h.store.qrCreatedAt = Date.now() - 120_001;
    timer.fn(); await code;
    assert.equal(h.store.canRetryFarmCode(), true, 'QR refresh age must not expire a confirmed session');
    assert.equal(h.store.uuid, 'session-a');
    h.store.qrCreatedAt = Date.now() - 300_001;
    assert.equal(h.store.canRetryFarmCode(), false);
});

// ── 首页“重新扫码授权”/ 直接重登入口行为（真实 Dashboard script + 真实 pinia store）──
function dashboardHarness() {
    const reloginCalls = []; const toasts = [];
    let responder = () => ({ ok: true });
    const piniaInstance = pinia.createPinia();
    const h = { fetchAccountCalls: [], clearCalls: [], fetchAccountsError: null };
    const useAccountStore = pinia.defineStore('account', {
        state: () => ({
            currentAccountId: 'account-a',
            currentAccount: { id: 'account-a', name: 'A', platform: 'wx' },
            accounts: [
                { id: 'account-a', name: 'A', platform: 'wx' },
                { id: 'account-c', name: 'C', platform: 'wx' },
            ],
        }),
        actions: {
            async reloginAccount(id) { reloginCalls.push(id); return await responder(id); },
            async fetchAccounts() { h.fetchAccountCalls.push(true); if (h.fetchAccountsError) throw h.fetchAccountsError; },
        },
    });
    const useStatusStore = pinia.defineStore('status', {
        state: () => ({ status: null, logs: [], accountLogs: [], realtimeConnected: true, currentStatusReady: true }),
        actions: {
            setRealtimeLogsEnabled() {}, connectRealtime() {},
            fetchStatus: async () => {}, fetchLogs: async () => {}, fetchAccountLogs: async () => {},
            clearAccountScopedData() { h.clearCalls.push(true); },
        },
    });
    const useBagStore = pinia.defineStore('bag', { state: () => ({ dashboardItems: [] }), actions: { fetchBag: async () => {}, clearBag() {} } });
    const useToastStore = pinia.defineStore('toast', {
        state: () => ({}),
        actions: { success: msg => toasts.push(['success', msg]), error: msg => toasts.push(['error', msg]) },
    });
    const filename = path.join(root, 'web/src/views/Dashboard.vue');
    const source = fs.readFileSync(filename, 'utf8')
        .replace('</script>', '\ndefineExpose({ reloginFromHome, rescanFromHome, onAccountSaved, showReloginModal })\n</script>');
    const { descriptor } = compiler.parse(source, { filename });
    const code = compiler.compileScript(descriptor, { id: 'wx-dashboard-test' }).content;
    const stub = { __esModule: true, default: {} };
    const Dashboard = evaluate(code, {
        vue, pinia,
        '@vueuse/core': { useIntervalFn: () => ({ pause() {}, resume() {} }) },
        '@/api': { __esModule: true, default: {
            get: async () => ({ data: { ok: true, data: {} } }),
            post: async () => ({ data: { ok: true } }),
            delete: async () => ({ data: { ok: true } }),
        } },
        '@/components/ui/BaseButton.vue': stub, '@/components/ui/BaseInput.vue': stub,
        '@/components/ui/BaseSelect.vue': stub, '@/components/AccountModal.vue': stub,
        '@/stores/account': { useAccountStore },
        '@/stores/bag': { useBagStore },
        '@/stores/status': { useStatusStore },
        '@/stores/toast': { useToastStore },
        '@/utils/number-format': { formatCouponAmount: v => v, formatGoldAmount: v => v, formatGoldBeanAmount: v => v },
    }, { localStorage: storage, window: { setInterval: () => 0, clearInterval: () => {} } }).default;
    Dashboard.render = () => null;
    const renderer = vue.createRenderer({ createComment: () => ({}), insert() {}, remove() {}, parentNode: () => null, nextSibling: () => null });
    let instance;
    const app = renderer.createApp({ render: () => vue.h(Dashboard, { ref: value => { if (value) instance = value; } }) });
    app.use(piniaInstance);
    app.mount({});
    const accountStore = useAccountStore(piniaInstance);
    const switchAccount = target => {
        accountStore.currentAccount = target;
        accountStore.currentAccountId = target.id;
    };
    return { app, instance: () => instance, accountStore, statusStore: undefined, switchAccount, reloginCalls, toasts, fetchAccountCalls: h.fetchAccountCalls, clearCalls: h.clearCalls, setResponder: fn => { responder = fn; }, setFetchAccountsError: err => { h.fetchAccountsError = err; } };
}

test('显式重新扫码入口：零直接重登请求，直接为当前账号打开扫码弹窗（在线 wx 可达）', async () => {
    const h = dashboardHarness();
    await vue.nextTick(); await vue.nextTick();
    const dash = h.instance();
    assert.ok(dash, 'Dashboard 实例与暴露入口必须存在');
    assert.equal(dash.showReloginModal, false);
    assert.equal(h.accountStore.currentAccount.platform, 'wx');
    dash.rescanFromHome();
    assert.equal(dash.showReloginModal, true, '扫码弹窗应立即打开');
    assert.deepEqual(h.reloginCalls, [], '显式扫码入口不得先发任何直接重登请求');
    h.app.unmount();
});

test('直接重登迟到结果：切换账号后不得给别的账号弹扫码，也不得误报旧成功', async () => {
    const h = dashboardHarness();
    await vue.nextTick(); await vue.nextTick();
    const dash = h.instance();

    const staleFailure = deferred();
    h.setResponder(() => staleFailure.promise);
    const first = dash.reloginFromHome();
    assert.deepEqual(h.reloginCalls, ['account-a']);
    // await 期间切换到账号 C：迟到的失败不能给 C 弹二维码
    h.switchAccount({ id: 'account-c', name: 'C', platform: 'wx' });
    staleFailure.resolve({ ok: false });
    await first;
    assert.equal(dash.showReloginModal, false);

    // 切回 A，迟到成功在已切换后不得误提示
    h.switchAccount({ id: 'account-a', name: 'A', platform: 'wx' });
    const staleSuccess = deferred();
    h.setResponder(() => staleSuccess.promise);
    const second = dash.reloginFromHome();
    h.switchAccount({ id: 'account-c', name: 'C', platform: 'wx' });
    staleSuccess.resolve({ ok: true });
    await second;
    assert.deepEqual(h.toasts, [], '迟到成功不得在切换后的账号上误提示');
    assert.equal(dash.showReloginModal, false);
    await vue.nextTick(); await vue.nextTick(); await vue.nextTick();
    h.app.unmount();
});

test('autoAdd 关闭时对既有账号的重扫码仍写回原账号：完整会话 + 新 Code，不退回手动路径', async () => {
    const h = modalHarness();
    h.wx.config.autoAddAccount = false;
    try {
        await vue.nextTick(); const poll = h.intervals[0].callback(); await vue.nextTick();
        h.pendingCode.resolve({ success: true, code: 'fixture-rescan-code' }); await poll;
        assert.equal(h.saves.length, 1, '必须保存到既有账号');
        assert.equal(h.saves[0].id, 'account-a');
        assert.equal(h.saves[0].wxSessionId, 'session-1');
        assert.equal(h.saves[0].code, 'fixture-rescan-code');
        assert.equal(h.saves[0].platform, 'wx');
        assert.equal(h.instance().activeTab, 'wx', '不得退回只保存 Code 的手动页签');
    } finally { h.app.unmount(); }
});

test('autoAdd 关闭且无目标账号时保留旧手动路径', async () => {
    const h = modalHarness();
    h.wx.config.autoAddAccount = false;
    h.props.editData = null;
    try {
        await vue.nextTick(); const poll = h.intervals[0].callback(); await vue.nextTick();
        h.pendingCode.resolve({ success: true, code: 'fixture-manual-code' }); await poll;
        assert.equal(h.saves.length, 0);
        assert.equal(h.instance().activeTab, 'manual');
    } finally { h.app.unmount(); }
});

// ── status store 状态缓存代次（真实 store + mock api deferred）──
function statusHarness(currentAccountId = 'account-a') {
    const piniaInstance = pinia.createPinia();
    const useAccountStore = pinia.defineStore('account', {
        state: () => ({ currentAccountId, currentAccount: { id: currentAccountId, platform: 'wx' } }),
    });
    const pendingRequests = [];
    const useStatusStore = evaluate(fs.readFileSync(path.join(root, 'web/src/stores/status.ts'), 'utf8'), {
        vue, pinia,
        '@vueuse/core': { useStorage: () => vue.ref('fixture-token') },
        'socket.io-client': { io: () => ({ on() {}, off() {}, connect() {}, disconnect() {}, close() {} }) },
        '@/api': { __esModule: true, default: { get: () => { const p = deferred(); pendingRequests.push(p); return p.promise; } } },
        '@/stores/account': { useAccountStore },
    }).useStatusStore;
    pinia.setActivePinia(piniaInstance);
    return { store: useStatusStore(piniaInstance), pendingRequests, accountStore: useAccountStore(piniaInstance) };
}

test('扫码清缓存后：旧 HTTP 成功/错误不回填，旧 finally 不结束新 loading', async () => {
    const h = statusHarness();
    const first = h.store.fetchStatus('account-a');
    h.store.clearAccountScopedData();
    assert.equal(h.store.loading, false, '新作用域必须清 loading');

    const second = h.store.fetchStatus('account-a');
    assert.equal(h.store.loading, true, '新请求自己的 loading');
    // 旧请求迟到成功：不回填
    h.pendingRequests[0].resolve({ data: { ok: true, data: { marker: 'stale' } } });
    await first;
    assert.equal(h.store.status, null, '清缓存后的旧成功不得回填状态');
    assert.equal(h.store.loading, true, '旧 finally 不得结束新请求的 loading');
    // 新请求成功：正常应用
    h.pendingRequests[1].resolve({ data: { ok: true, data: { marker: 'fresh' } } });
    await second;
    assert.equal(h.store.status.marker, 'fresh');
    assert.equal(h.store.loading, false);
});

test('清缓存后的旧请求失败不得写入错误', async () => {
    const h = statusHarness();
    const first = h.store.fetchStatus('account-a');
    h.store.clearAccountScopedData();
    h.pendingRequests[0].reject(new Error('stale transport failure'));
    await first.catch(() => {});
    assert.equal(h.store.error, '', '迟到错误不得回填');
    assert.equal(h.store.loading, false);
});

test('同账号请求反序：先发后至的旧回包不得覆盖新回包', async () => {
    const h = statusHarness();
    const first = h.store.fetchStatus('account-a');
    const second = h.store.fetchStatus('account-a');
    h.pendingRequests[1].resolve({ data: { ok: true, data: { gen: 2 } } });
    await second;
    h.pendingRequests[0].resolve({ data: { ok: true, data: { gen: 1 } } });
    await first;
    assert.equal(h.store.status.gen, 2, '反序旧回包必须丢弃');
});

test('HTTP 发出后已有更新 realtime 状态：迟到 HTTP 不得覆盖实时状态', async () => {
    const h = statusHarness();
    const pending = h.store.fetchStatus('account-a');
    h.store.__handleRealtimeStatusForTests({ accountId: 'account-a', status: { source: 'realtime' } });
    assert.equal(h.store.status.source, 'realtime');
    h.pendingRequests[0].resolve({ data: { ok: true, data: { source: 'http' } } });
    await pending;
    assert.equal(h.store.status.source, 'realtime', '迟到的 HTTP 回包不得覆盖更新过的实时状态');
});

// ── Dashboard：同账号新扫码覆盖旧 direct 反馈；saved 事件清理当前账号缓存 ──

test('主审反例：主动扫码后，旧的同账号直接重登失败不得再弹二维码、成功不得误提示', async () => {
    const h = dashboardHarness();
    try {
        await vue.nextTick(); await vue.nextTick();
        const dash = h.instance();

        // 扫码取代失败反馈
        const staleFailure = deferred();
        h.setResponder(() => staleFailure.promise);
        const first = dash.reloginFromHome();
        assert.equal(h.reloginCalls.length, 1);
        dash.rescanFromHome();
        assert.equal(dash.showReloginModal, true);
        dash.showReloginModal = false; // 模拟扫码保存成功后 modal 关闭
        staleFailure.resolve({ ok: false });
        await first;
        assert.equal(dash.showReloginModal, false, '被扫码取代的旧失败不得重新弹 QR');

        // 扫码取代成功反馈：不误 toast
        const staleSuccess = deferred();
        h.setResponder(() => staleSuccess.promise);
        const second = dash.reloginFromHome();
        assert.equal(h.reloginCalls.length, 2, 'rescan 后 busy 已复位，可再次直接重登');
        dash.rescanFromHome();
        staleSuccess.resolve({ ok: true });
        await second;
        assert.deepEqual(h.toasts, [], '被扫码取代的旧成功不得误提示');
        assert.equal(dash.showReloginModal, true, '扫码 modal 仍打开等待新授权');
    } finally { await vue.nextTick(); await vue.nextTick(); h.app.unmount(); }
});

test('扫码保存成功：仅清当前账号状态缓存并刷新账号列表；别的账号与无 id 保留旧兼容', async () => {
    const h = dashboardHarness();
    try {
        await vue.nextTick(); await vue.nextTick();
        const dash = h.instance();
        dash.rescanFromHome();
        assert.equal(dash.showReloginModal, true);

        // 保存的是当前账号：清缓存 + 刷新列表
        await dash.onAccountSaved('account-a');
        assert.equal(dash.showReloginModal, false);
        assert.equal(h.clearCalls.length, 1);
        assert.equal(h.fetchAccountCalls.length, 1);

        // 保存的是别的账号：不清当前账号缓存
        dash.rescanFromHome();
        await dash.onAccountSaved('account-other');
        assert.equal(h.clearCalls.length, 1, '不得清其它账号的缓存');
        assert.equal(h.fetchAccountCalls.length, 2);

        // 无 id（旧调用方）：只关弹窗 + 刷新列表，不清缓存
        dash.rescanFromHome();
        await dash.onAccountSaved(undefined);
        assert.equal(h.clearCalls.length, 1);
        assert.equal(h.fetchAccountCalls.length, 3);
    } finally { await vue.nextTick(); await vue.nextTick(); h.app.unmount(); }
});

test('HTTP pending 期间收到实时状态：迟到 HTTP 保留实时数据且 loading 正常复位', async () => {
    const h = statusHarness();
    const pending = h.store.fetchStatus('account-a');
    assert.equal(h.store.loading, true);
    h.store.__handleRealtimeStatusForTests({ accountId: 'account-a', status: { source: 'realtime' } });
    h.pendingRequests[0].resolve({ data: { ok: true, data: { source: 'http-old' } } });
    await pending;
    assert.equal(h.store.status.source, 'realtime', '实时状态保留');
    assert.equal(h.store.loading, false, 'realtime 修订不得让 finally 跳过而 loading 永久 true');
});

test('旧请求被 realtime 取代后：其 finally 不得结束更晚 HTTP 的 loading', async () => {
    const h = statusHarness();
    const first = h.store.fetchStatus('account-a');
    h.store.__handleRealtimeStatusForTests({ accountId: 'account-a', status: { source: 'realtime' } });
    const second = h.store.fetchStatus('account-a');
    assert.equal(h.store.loading, true, '新请求自己的 loading');
    h.pendingRequests[0].resolve({ data: { ok: true, data: { source: 'http-old' } } });
    await first;
    assert.equal(h.store.status.source, 'realtime');
    assert.equal(h.store.loading, true, '旧 finally 不得结束新请求的 loading');
    // 新请求发出时 realtime 修订已计入起点，回包比 realtime 新：正常应用
    h.pendingRequests[1].resolve({ data: { ok: true, data: { source: 'http-new' } } });
    await second;
    assert.equal(h.store.status.source, 'http-new');
    assert.equal(h.store.loading, false);
});

test('账号列表刷新失败：当前账号缓存已清、无未处理异常、不重开 QR 不误报失败', async () => {
    const h = dashboardHarness();
    try {
        await vue.nextTick(); await vue.nextTick();
        const dash = h.instance();
        dash.rescanFromHome();
        assert.equal(dash.showReloginModal, true);
        h.setFetchAccountsError(new Error('fixture: account list refresh failed'));
        await dash.onAccountSaved('account-a');
        assert.equal(dash.showReloginModal, false, '授权已保存成功，不得因列表刷新失败重开 QR');
        assert.equal(h.clearCalls.length, 1, '当前账号状态缓存必须在列表刷新前已清');
        assert.equal(h.fetchAccountCalls.length, 1);
        assert.deepEqual(h.toasts, [], '已保存的授权不得被误报为保存失败');
    } finally { await vue.nextTick(); await vue.nextTick(); h.app.unmount(); }
});
