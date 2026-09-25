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
