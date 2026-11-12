'use strict';
// 程序更新失败 UI 回归（2026-11-12 工单）：真实 ProgramUpdateCard / BaseButton SFC 挂载，
// 仅传输层为回环 HTTP 替身——错误响应全部来自真实注册的 check/install 路由与其固定白名单。
// 覆盖：点击安装展示具体失败文案、手动检查/安装恢复且无自动重复安装、403 权限失败、
// 卸载后迟到响应不污染、重进新实例正常、忙状态轮询与 timer 收尾。不实际执行更新。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const http = require('node:http');

// 复用既有夹具：独立 FARM_DATA_DIR 先于业务 require、自定义渲染器与候选源指纹复核。
const h = require('./activity-availability.test');
const { vue, render, makeNode, textOf, findAll, buttonsOf, click, flush, waitFor, WEB, privateDir } = h;
assert.ok(h.isInsideOrEqualDir(fs.realpathSync(privateDir), fs.realpathSync(os.tmpdir())));
assert.equal(process.env.FARM_DATA_DIR, privateDir);
const updater = require('../src/services/program-update');
const routes = require('../src/controllers/admin-super-admin-routes');
const REAL_UPDATER = { begin: updater.begin, check: updater.check, publicState: updater.publicState };

// 候选源（真实前端组件）在本套件前后内容与权限不得变化。
const CANDIDATES = [
    path.join(WEB, 'src', 'components', 'admin', 'ProgramUpdateCard.vue'),
    path.join(WEB, 'src', 'components', 'ui', 'BaseButton.vue'),
    path.resolve(__dirname, '../src/controllers/admin-super-admin-routes.js'),
    path.resolve(__dirname, '../src/services/program-update.js'),
    __filename,
    path.resolve(__dirname, 'program-update-errors.test.js'),
];
function fingerprintOf(file) {
    const stat = fs.statSync(file);
    return { mode: stat.mode, size: stat.size, sha256: require('node:crypto').createHash('sha256').update(fs.readFileSync(file)).digest('hex') };
}
const fingerprintsBefore = new Map(CANDIDATES.map(file => [file, fingerprintOf(file)]));

const compiler = require(path.join(WEB, 'node_modules', 'vue', 'compiler-sfc'));
const ts = require(path.join(WEB, 'node_modules', 'typescript'));
const vueRouter = require(path.join(WEB, 'node_modules', 'vue-router'));

// 真实 SFC：编译 script setup 得到组件，单独编译模板得到真实 render（带 bindingMetadata）。
function evaluate(source, deps, globals = {}) {
    const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ESNext } }).outputText;
    const mod = { exports: {} };
    vm.compileFunction(code, ['require', 'module', 'exports', ...Object.keys(globals)])(name => {
        assert.ok(name in deps, `unexpected import ${name}`);
        return deps[name];
    }, mod, mod.exports, ...Object.values(globals));
    return mod.exports;
}
function compileSfc(absPath, deps, globals = {}) {
    const source = fs.readFileSync(absPath, 'utf8');
    const { descriptor, errors } = compiler.parse(source, { filename: absPath });
    assert.deepEqual(errors.map(String), [], `SFC 解析失败: ${absPath}`);
    const compiled = compiler.compileScript(descriptor, { id: path.basename(absPath) });
    assert.deepEqual((compiled.errors || []).map(String), [], `SFC 编译失败: ${absPath}`);
    const component = evaluate(compiled.content, deps, globals).default;
    assert.equal(typeof component, 'object', '组件类型固定：编译产物必须仍是组件对象');
    const template = compiler.compileTemplate({
        source: descriptor.template.content, filename: absPath, id: path.basename(absPath),
        compilerOptions: { mode: 'function', bindingMetadata: compiled.bindings, hoistStatic: false },
    });
    assert.deepEqual(template.errors.map(String), [], `模板编译失败: ${absPath}`);
    component.render = vm.compileFunction(template.code, ['Vue'])(vue);
    return component;
}
const BaseButton = compileSfc(path.join(WEB, 'src', 'components', 'ui', 'BaseButton.vue'), { vue, 'vue-router': vueRouter });
const baseButtonModule = { __esModule: true, default: BaseButton };

// 可注入假时钟：确定性验证忙状态轮询 timer 的调度与卸载清理。
function makeClock() {
    const timers = new Map();
    let seq = 0;
    return {
        setTimeout(fn, ms) { const id = ++seq; timers.set(id, { fn, ms }); return id; },
        clearTimeout(id) { timers.delete(id); },
        size() { return timers.size; },
        delays() { return [...timers.values()].map(entry => entry.ms); },
        fire() { const pending = [...timers.values()]; timers.clear(); for (const entry of pending) entry.fn(); },
    };
}

// 回环传输替身：真实 HTTP 请求真实路由；≥400 按 axios 错误形状抛出；可切换角色与滞留响应。
// completed 按 URL 后缀统计真实到达的响应，用例以此区分“请求已发出”与“响应已处理”。
function makeTransport(port) {
    const calls = { get: [], post: [] };
    const completed = { get: 0, check: 0, install: 0 };
    const settled = { get: 0, check: 0, install: 0 };
    let role = 'admin';
    const pendingGates = new Map();
    const held = new Set();
    const send = (method, url) => new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, path: url, method, headers: { 'x-fixture-role': role } }, res => {
            let raw = '';
            res.on('data', chunk => { raw += chunk; });
            res.on('end', () => {
                completed[url.endsWith('/check') ? 'check' : url.endsWith('/install') ? 'install' : 'get']++;
                let data = {};
                try { data = raw ? JSON.parse(raw) : {}; } catch { data = {}; }
                if (res.statusCode >= 400) reject(Object.assign(new Error(`fixture http ${res.statusCode}`), { response: { status: res.statusCode, data } }));
                else resolve({ data });
            });
        });
        req.on('error', reject);
        req.end();
    });
    const deliver = async (method, url) => {
        const gate = pendingGates.get(method);
        pendingGates.delete(method);
        const kind = url.endsWith('/check') ? 'check' : url.endsWith('/install') ? 'install' : 'get';
        let response;
        let failure;
        try { response = await send(method, url); } catch (error) { failure = error; }
        // Hold settlement of an actual HTTP response, including an actual 409.
        // This is distinct from parking before sending or inventing a payload.
        if (gate) { await gate.promise; held.delete(gate); }
        settled[kind]++;
        if (failure) throw failure;
        return response;
    };
    return {
        calls,
        completed,
        settled,
        setRole(value) { role = value; },
        parkNext(method = 'POST') {
            assert.equal(pendingGates.has(method), false);
            const gate = {};
            gate.promise = new Promise(resolve => { gate.resolve = resolve; });
            pendingGates.set(method, gate);
            held.add(gate);
            return gate;
        },
        releaseAll() { for (const gate of held) gate.resolve(); pendingGates.clear(); held.clear(); },
        module: {
            __esModule: true,
            default: {
                async get(url) { calls.get.push(url); return deliver('GET', url); },
                async post(url) { calls.post.push(url); return deliver('POST', url); },
            },
        },
    };
}

// 真实路由服务：真实 check/install 处理器与固定失败白名单；updater 方法按场景替换。
async function startPanel({ check, begin, defaultState } = {}) {
    const express = require('express');
    const app = express();
    if (check) updater.check = check;
    if (begin) updater.begin = begin;
    const messages = { current: '已是最新版本', applied: '更新完成', failed: '更新未完成，请查看运行日志后重试。' };
    const publicOf = state => ({ phase: state.phase, currentVersion: '1.0.0', latestVersion: state.latestVersion || null,
        updateAvailable: state.phase === 'available', updatedAt: state.updatedAt || 0, message: messages[state.phase] || '' });
    updater.publicState = ({ state } = {}) => publicOf(state || defaultState);
    const auth = (req, res, next) => {
        const roleFromHeader = req.headers['x-fixture-role'];
        if (!roleFromHeader) return res.status(401).json({ ok: false });
        req.currentUser = { role: roleFromHeader };
        next();
    };
    routes.registerAdminSuperAdminRoutes({ app, requireAdminToken: auth, requireSuperAdminRole: (_req, res) => res.status(403).json({ ok: false }), logger: undefined });
    const server = http.createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    return {
        port,
        close: () => new Promise(done => {
            updater.begin = REAL_UPDATER.begin; updater.check = REAL_UPDATER.check; updater.publicState = REAL_UPDATER.publicState;
            server.closeIdleConnections(); server.close(done);
        }),
    };
}

// 挂载真实卡片：canUpdate=true，注入假时钟；root 登记以便统一卸载。
const liveRoots = [];
const componentCache = new WeakMap();
function mountCard(transport, clock) {
    let byClock = componentCache.get(transport);
    if (!byClock) { byClock = new WeakMap(); componentCache.set(transport, byClock); }
    let Card = byClock.get(clock);
    if (!Card) {
        Card = compileSfc(path.join(WEB, 'src', 'components', 'admin', 'ProgramUpdateCard.vue'), {
            vue, '@/api': transport.module, '@/components/ui/BaseButton.vue': baseButtonModule,
        }, { setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });
        Card.components = { BaseButton };
        byClock.set(clock, Card);
    }
    const root = makeNode('root');
    liveRoots.push(root);
    render(vue.h(Card, { canUpdate: true }), root);
    return root;
}
async function panelCase(t, options) {
    const panel = await startPanel(options);
    const transport = makeTransport(panel.port);
    const clock = makeClock();
    const roots = [];
    t.after(async () => {
        try {
            for (const root of roots) render(null, root);
            transport.releaseAll();
            assert.equal(clock.size(), 0, 'every case unmounts its cards and releases timers');
        } finally { await panel.close(); }
    });
    return { transport, clock, mount() { const root = mountCard(transport, clock); roots.push(root); return root; } };
}
const alertOf = root => findAll(root, node => node.tag === 'p' && node.props.role === 'alert');
const chipOf = root => findAll(root, node => node.tag === 'span' && node.props.role === 'status');
const hintOf = root => findAll(root, node => node.tag === 'p' && /需要管理员权限才能更新程序/.test(textOf(node)));
const buttonBy = (root, pattern) => buttonsOf(root).find(button => pattern.test(textOf(button)));
const countOf = (calls, suffix) => calls.post.filter(url => url.endsWith(suffix)).length;

test.after(() => {
    try {
        while (liveRoots.length) { const root = liveRoots.pop(); try { render(null, root); } catch { /* 尽力卸载 */ } }
        for (const [file, before] of fingerprintsBefore)
            assert.deepEqual(fingerprintOf(file), before, `候选源不得被夹具改变: ${path.basename(file)}`);
    } finally {
        updater.begin = REAL_UPDATER.begin; updater.check = REAL_UPDATER.check; updater.publicState = REAL_UPDATER.publicState;
    }
});

test('点击安装展示路由具体失败文案；手动检查与安装恢复且无自动重复安装', async t => {
    let beginCalls = 0;
    const scene = await panelCase(t, {
        check: async () => ({ phase: 'available', latestVersion: '9.9.9' }),
        begin: () => { beginCalls++; if (beginCalls === 1) throw new Error('check_update_first'); return { phase: 'applied', latestVersion: '9.9.9' }; },
        defaultState: { phase: 'available', latestVersion: '9.9.9' },
    });
    const { transport, clock } = scene;
    const root = scene.mount();
    await waitFor(() => buttonBy(root, /更新到/));
    assert.match(textOf(chipOf(root)[0]), /发现新版本/);
    assert.equal(countOf(transport.calls, 'check'), 0, '挂载不得自动触发检查');

    click(buttonBy(root, /更新到/));
    await waitFor(() => transport.completed.install === 1 && alertOf(root).length === 1);
    assert.match(textOf(alertOf(root)[0]), /检查新版本/, '展示路由针对未检查的具体文案');
    assert.equal(countOf(transport.calls, 'install'), 1);
    for (let i = 0; i < 5; i++) await flush();
    assert.equal(countOf(transport.calls, 'install'), 1, '失败后不得自动重复安装');
    assert.equal(clock.size(), 0, '非忙状态不排轮询 timer');

    click(buttonBy(root, /检查新版本/));
    await waitFor(() => transport.completed.check === 1);
    await waitFor(() => alertOf(root).length === 0);
    assert.match(textOf(chipOf(root)[0]), /发现新版本/, '手动检查恢复可用状态');

    click(buttonBy(root, /更新到/));
    await waitFor(() => transport.completed.install === 2 && /更新完成/.test(textOf(chipOf(root)[0])));
    assert.equal(alertOf(root).length, 0);
    assert.equal(countOf(transport.calls, 'install'), 2, '仅手动重试一次安装');
    assert.equal(clock.size(), 0, '收尾无残留 timer');
});

test('状态读取普通失败保留已知版本；手动刷新恢复权限和入口', async t => {
    let failed = false;
    const state = { latestVersion: '9.9.9' };
    Object.defineProperty(state, 'phase', { get() { if (failed) throw new Error('fixture-read-failure'); return 'available'; } });
    const scene = await panelCase(t, { defaultState: state });
    const { transport } = scene;
    const root = scene.mount();
    await waitFor(() => buttonBy(root, /更新到/));
    failed = true;
    click(buttonBy(root, /刷新状态/));
    await waitFor(() => alertOf(root).length === 1);
    assert.match(textOf(alertOf(root)[0]), /版本状态读取失败/);
    assert.match(textOf(root), /v1\.0\.0/);
    assert.match(textOf(root), /v9\.9\.9/);
    assert.equal(buttonBy(root, /更新到/), undefined);
    failed = false;
    click(buttonBy(root, /刷新状态/));
    await waitFor(() => alertOf(root).length === 0 && buttonBy(root, /更新到/));
    assert.equal(transport.calls.post.length, 0, 'read recovery never dispatches check or install');
});

test('结果未知提示先刷新；刷新发现已入队后只轮询状态，不重复安装', async t => {
    let installations = 0;
    const current = { phase: 'available', latestVersion: '9.9.9' };
    const scene = await panelCase(t, {
        defaultState: current,
        begin: () => { installations++; current.phase = 'queued'; throw new Error('fixture-result-unknown'); },
    });
    const { transport, clock } = scene;
    const root = scene.mount();
    await waitFor(() => buttonBy(root, /更新到/));
    click(buttonBy(root, /更新到/));
    await waitFor(() => alertOf(root).length === 1);
    assert.match(textOf(alertOf(root)[0]), /无法确认.*结果/);
    assert.match(textOf(alertOf(root)[0]), /先刷新状态/);
    assert.match(textOf(alertOf(root)[0]), /不要重复安装/);
    for (let i = 0; i < 5; i++) await flush();
    assert.equal(installations, 1);
    assert.equal(countOf(transport.calls, 'install'), 1);
    click(buttonBy(root, /刷新状态/));
    await waitFor(() => /准备更新/.test(textOf(chipOf(root)[0])));
    await waitFor(() => clock.size() === 1);
    assert.equal(buttonBy(root, /更新到/), undefined);
    clock.fire();
    await waitFor(() => clock.size() === 1);
    assert.equal(installations, 1, 'unknown results never cause an automatic second installation');
    assert.equal(countOf(transport.calls, 'check'), 0);
});

test('403 权限失败展示真实拒绝文案并收起操作；手动刷新以管理员恢复', async t => {
    const scene = await panelCase(t, {
        check: async () => ({ phase: 'available', latestVersion: '9.9.9' }),
        begin: () => ({ phase: 'applied', latestVersion: '9.9.9' }),
        defaultState: { phase: 'available', latestVersion: '9.9.9' },
    });
    const { transport } = scene;
    const root = scene.mount();
    await waitFor(() => buttonBy(root, /更新到/));
    transport.setRole('user');
    click(buttonBy(root, /更新到/));
    await waitFor(() => hintOf(root).length === 1);
    assert.match(textOf(alertOf(root)[0]), /需要管理员权限/, '展示真实 403 路由文案');
    assert.equal(buttonBy(root, /更新到/), undefined, '权限收起后安装按钮隐藏');
    assert.equal(countOf(transport.calls, 'install'), 1);
    transport.setRole('admin');
    click(buttonBy(root, /刷新状态/));
    await waitFor(() => hintOf(root).length === 0);
    assert.equal(alertOf(root).length === 0, true, '刷新成功清除失败提示');
    assert.ok(buttonBy(root, /更新到/), '管理员状态经刷新恢复');
    render(null, root);
});

test('卸载后的迟到失败响应不污染重进实例；迟到状态读取同样安全', async t => {
    const scene = await panelCase(t, {
        check: async () => ({ phase: 'available', latestVersion: '9.9.9' }),
        begin: () => { throw new Error('update_requires_existing_tmux'); },
        defaultState: { phase: 'available', latestVersion: '9.9.9' },
    });
    const { transport, clock } = scene;
    const first = scene.mount();
    await waitFor(() => buttonBy(first, /更新到/));
    const late = transport.parkNext();
    click(buttonBy(first, /更新到/));
    await waitFor(() => transport.completed.install === 1);
    assert.equal(transport.settled.install, 0, 'actual HTTP 409 remains in flight to the component');
    render(null, first); // 卸载，安装响应仍在途

    const second = scene.mount();
    await waitFor(() => buttonBy(second, /更新到/));
    assert.match(textOf(chipOf(second)[0]), /发现新版本/);
    late.resolve();
    await waitFor(() => transport.settled.install === 1);
    for (let i = 0; i < 8; i++) await flush();
    assert.match(textOf(chipOf(second)[0]), /发现新版本/, '迟到失败不污染重进实例状态');
    assert.equal(alertOf(second).length, 0, '迟到失败不得写到已卸载/新实例界面');
    assert.equal(clock.size(), 0);

    const beforeGet = transport.completed.get;
    const beforeSettledGet = transport.settled.get;
    const lateGet = transport.parkNext('GET');
    const third = scene.mount();
    await waitFor(() => transport.completed.get === beforeGet + 1);
    assert.equal(transport.settled.get, beforeSettledGet, 'actual GET response is held before delivery');
    render(null, third);
    lateGet.resolve();
    await waitFor(() => transport.settled.get === beforeSettledGet + 1);
    for (let i = 0; i < 8; i++) await flush();
    assert.equal(clock.size(), 0, '卸载后迟到的状态读取不排新 timer');
    assert.match(textOf(chipOf(second)[0]), /发现新版本/);
    assert.equal(alertOf(second).length, 0);
});

test('忙状态仅轮询不自动检查；timer 到点刷新，卸载即清理', async t => {
    const scene = await panelCase(t, {
        check: async () => ({ phase: 'available', latestVersion: '9.9.9' }),
        begin: () => ({ phase: 'queued' }),
        defaultState: { phase: 'queued' },
    });
    const { transport, clock } = scene;
    const root = scene.mount();
    await waitFor(() => /准备更新|下载更新|检查更新/.test(textOf(chipOf(root)[0])));
    assert.equal(countOf(transport.calls, 'check'), 0, '忙状态不得自动检查');
    assert.equal(countOf(transport.calls, 'install'), 0);
    await waitFor(() => clock.size() === 1);
    assert.deepEqual(clock.delays(), [5000], '忙状态按固定间隔排轮询');
    const before = transport.calls.get.length;
    clock.fire();
    await waitFor(() => transport.calls.get.length === before + 1);
    await waitFor(() => clock.size() === 1);
    render(null, root);
    assert.equal(clock.size(), 0, '卸载必须清理轮询 timer');
});
