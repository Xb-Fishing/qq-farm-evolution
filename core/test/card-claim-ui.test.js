'use strict';
// 登录页免费领卡 UI 回归（2026-10-01 工单）：真实 Login.vue script + 真实模板渲染。
// 已开启免费领取但 availableTimeCards=0 时按钮禁用并显示“暂无可领取卡密”，
// 程序化点击不得发请求；卡密栏提示管理员发放/自部署管理员无需卡密且不泄露环境变量；
// 有库存时按钮可点、领取后刷新库存状态；领取撞上库存清零时失败弹窗并转为禁用。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '../..');
const modules = path.join(root, 'web/node_modules');
const vue = require(path.join(modules, 'vue'));
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

// 极简自定义渲染器：只记录元素/文本/属性，供断言
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
            const next = parent.children[parent.children.indexOf(el) + 1];
            return next || null;
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

function walk(el, pred, out = []) {
    if (pred(el)) out.push(el);
    for (const child of el.children) walk(child, pred, out);
    return out;
}
const textOf = el => (el.type === 2 ? el.text : el.children.map(textOf).join(''));

// 真实 Login.vue：编译 script setup，并单独编译模板得到真实 render
function loginHarness({ enabled, availableTimeCards, claimResult }) {
    const statusResponder = { enabled, availableTimeCards };
    const gets = [];
    const posts = [];
    const apiStub = {
        __esModule: true,
        default: {
            get: async (url) => {
                gets.push(url);
                if (url === '/api/card-claim/status') {
                    return { data: { ok: true, enabled: statusResponder.enabled, availableTimeCards: statusResponder.availableTimeCards } };
                }
                if (url === '/api/game-version') return { data: { ok: true, clientVersion: 'fixture-version' } };
                return { data: { ok: true } };
            },
            post: async (url) => {
                posts.push(url);
                if (url === '/api/card-claim/claim') return typeof claimResult === 'function' ? claimResult() : claimResult;
                return { data: { ok: true } };
            },
        },
    };
    const stub = { __esModule: true, default: { name: 'Stub', render: () => null } };
    const route = vue.reactive({ query: {} });
    const appStub = vue.reactive({
        loginPageConfig: { logoUrl: '', title: '', loginSubtitle: '', registerSubtitle: '', purchaseUrl: '', qqGroupUrl: '' },
        fetchLoginPageConfig: async () => {},
    });

    const filename = path.join(root, 'web/src/views/Login.vue');
    const source = fs.readFileSync(filename, 'utf8').replace(
        '</script>',
        '\ndefineExpose({ toggleMode, claimFreeCard, checkCardClaimStatus, cardClaimEnabled, availableTimeCards, claimStockEmpty, showClaimModal, claimModalContent })\n</script>',
    );
    const { descriptor } = compiler.parse(source, { filename });
    const compiled = compiler.compileScript(descriptor, { id: 'login-card-test' });
    const Login = evaluate(compiled.content, {
        vue,
        'vue-router': { useRoute: () => route },
        '@/api': apiStub,
        '@/components/login/LoginModals.vue': stub,
        '@/components/login/PasswordStrengthMeter.vue': stub,
        '@/components/login/UpdateLogModal.vue': stub,
        '@/components/ui/BaseButton.vue': stub,
        '@/components/ui/BaseInput.vue': stub,
        '@/composables/usePasswordStrength': { getPasswordStrength: () => ({ valid: true, message: '', score: 2 }) },
        '@/stores/app': { useAppStore: () => appStub },
        '@/stores/user': { useUserStore: () => ({}), formatTimeDuration: card => `${card.days}天` },
        '@/utils/safe-redirect': evaluate(fs.readFileSync(path.join(root, 'web/src/utils/safe-redirect.ts'), 'utf8'), {}, {
            window: { location: { origin: 'https://panel.example.invalid' } },
        }),
    }, { console }).default;

    // 必须带 bindingMetadata：script-setup 绑定经 $setup 解析，而不是实例代理
    const template = compiler.compileTemplate({
        source: descriptor.template.content,
        filename,
        id: 'login-card-test',
        compilerOptions: { mode: 'function', bindingMetadata: compiled.bindings, hoistStatic: false },
    });
    assert.deepEqual(template.errors, []);
    Login.render = vm.compileFunction(template.code, ['Vue'])(vue);
    Login.components = {
        LoginModals: stub.default, PasswordStrengthMeter: stub.default, UpdateLogModal: stub.default,
        BaseButton: stub.default, BaseInput: stub.default,
    };

    const ops = makeNodeOps();
    const renderer = vue.createRenderer(ops);
    const app = renderer.createApp({ render: () => vue.h(Login, { ref: value => { if (value) instance = value; } }) });
    let instance;
    const rootEl = ops.createElement('root');
    app.mount(rootEl);

    const statusGets = () => gets.filter(url => url === '/api/card-claim/status').length;
    const claimPosts = () => posts.filter(url => url === '/api/card-claim/claim').length;
    const claimButtons = () => walk(rootEl, el => el.type === 1 && el.tag === 'button' && /claim-card-btn/.test(el.props.class || ''));
    const cardHints = () => walk(rootEl, el => el.type === 1 && el.tag === 'p' && el.props.class === 'form-hint');
    return {
        app, rootEl, instance: () => instance, statusResponder, statusGets, claimPosts, claimButtons, cardHints, textOf,
        async toRegisterMode() { instance.toggleMode(); await vue.nextTick(); await vue.nextTick(); },
    };
}

test('开启免费领取但库存为 0：按钮禁用并显示暂无库存文案，点击不发请求', async () => {
    const h = loginHarness({ enabled: true, availableTimeCards: 0, claimResult: null });
    try {
        await vue.nextTick(); await vue.nextTick();
        assert.equal(h.instance().cardClaimEnabled, true);
        assert.equal(h.instance().claimStockEmpty, true);
        await h.toRegisterMode();

        const [button] = h.claimButtons();
        assert.ok(button, '注册模式下必须渲染免费领取按钮');
        assert.equal(button.props.disabled, true, '无库存时按钮必须禁用');
        assert.match(h.textOf(button), /暂无可领取卡密/, '按钮文案要说明库存清零');

        await h.instance().claimFreeCard();
        assert.equal(h.claimPosts(), 0, '禁用态下程序化点击不得发出领取请求');
    } finally { h.app.unmount(); }
});

test('注册模式的卡密提示：管理员发放 + 自部署管理员无需卡密，且不泄露环境变量', async () => {
    const h = loginHarness({ enabled: true, availableTimeCards: 0, claimResult: null });
    try {
        await vue.nextTick(); await vue.nextTick();
        await h.toRegisterMode();
        const hints = h.cardHints().map(h.textOf).join('\n');
        assert.match(hints, /管理员/, '要说明注册卡密由本站管理员发放');
        assert.match(hints, /无需卡密|不需要卡密/, '要说明自部署管理员无需卡密');
        assert.ok(!/FARM_ADMIN|ADMIN_PASSWORD|export\s|\.env/.test(hints), '产品 UI 不得出现环境变量名或机器操作说明');
    } finally { h.app.unmount(); }
});

test('有库存：按钮可点，领取成功后展示卡密弹窗并刷新库存状态', async () => {
    const h = loginHarness({
        enabled: true,
        availableTimeCards: 2,
        claimResult: { data: { ok: true, cardCode: 'FIXTURETIMECARD00', days: 7, description: 'fixture' } },
    });
    try {
        await vue.nextTick(); await vue.nextTick();
        await h.toRegisterMode();

        const [button] = h.claimButtons();
        assert.ok(!button.props.disabled, '有库存时按钮可用');
        assert.match(h.textOf(button), /免费领取卡密/);

        const before = h.statusGets();
        await h.instance().claimFreeCard();
        await vue.nextTick(); await vue.nextTick();
        assert.equal(h.claimPosts(), 1);
        assert.equal(h.statusGets(), before + 1, '领取尝试后必须刷新库存状态');
        assert.equal(h.instance().showClaimModal, true);
        assert.equal(h.instance().claimModalContent.success, true);
        assert.equal(h.instance().claimModalContent.cardCode, 'FIXTURETIMECARD00');
        assert.ok(!button.props.disabled, '库存未清零时按钮保持可用');
    } finally { h.app.unmount(); }
});

test('领取撞上库存清零：失败弹窗提示库存不足，刷新后按钮转为禁用', async () => {
    const h = loginHarness({
        enabled: true,
        availableTimeCards: 1,
        claimResult: () => {
            h.statusResponder.availableTimeCards = 0; // 后端已发完，状态接口同时清零
            return Promise.reject(Object.assign(new Error('fixture claim rejected'), {
                response: { status: 400, data: { ok: false, error: '卡密库存不足，请联系管理员！' } },
            }));
        },
    });
    try {
        await vue.nextTick(); await vue.nextTick();
        await h.toRegisterMode();
        const [button] = h.claimButtons();
        assert.ok(!button.props.disabled);

        await h.instance().claimFreeCard();
        await vue.nextTick(); await vue.nextTick();
        assert.equal(h.claimPosts(), 1);
        assert.equal(h.instance().showClaimModal, true);
        assert.equal(h.instance().claimModalContent.success, false);
        assert.match(h.instance().claimModalContent.message, /库存不足/);
        assert.equal(button.props.disabled, true, '刷新到 0 库存后按钮必须禁用');
        assert.match(h.textOf(button), /暂无可领取卡密/);
    } finally { h.app.unmount(); }
});

test('未开启免费领取：不渲染领取按钮，也不视为库存清零', async () => {
    const h = loginHarness({ enabled: false, availableTimeCards: 0, claimResult: null });
    try {
        await vue.nextTick(); await vue.nextTick();
        await h.toRegisterMode();
        assert.equal(h.claimButtons().length, 0);
        assert.equal(h.instance().claimStockEmpty, false);
    } finally { h.app.unmount(); }
});
