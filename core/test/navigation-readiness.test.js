'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '../..');
const modules = path.join(root, 'web/node_modules');
const vue = require(path.join(modules, 'vue'));
const routerLib = require(path.join(modules, 'vue-router'));
const compiler = require(path.join(modules, 'vue/compiler-sfc'));
const ts = require(path.join(modules, 'typescript'));

function evaluate(source, dependencies) {
    const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ESNext } }).outputText;
    const mod = { exports: {} };
    vm.compileFunction(code, ['require', 'module', 'exports'])(name => {
        assert.ok(name in dependencies, `unexpected import ${name}`);
        return dependencies[name];
    }, mod, mod.exports);
    return mod.exports;
}

function layoutComponent() {
    const filename = path.join(root, 'web/src/layouts/DefaultLayout.vue');
    const { descriptor } = compiler.parse(fs.readFileSync(filename, 'utf8'), { filename });
    const result = compiler.compileScript(descriptor, { id: 'navigation-test', inlineTemplate: true });
    const store = { loginPageConfig: vue.ref({}), sidebarOpen: vue.ref(false), fetchLoginPageConfig() {}, closeSidebar() {}, toggleSidebar() {} };
    const stub = { __esModule: true, default: () => null };
    return evaluate(result.content, {
        vue: { ...vue, Transition: { setup: (_props, { attrs, slots }) => () => vue.h(vue.BaseTransition, { ...attrs, onLeave: (_el, done) => queueMicrotask(done) }, slots) } },
        pinia: { storeToRefs: value => value },
        '@/stores/app': { useAppStore: () => store },
        '@/components/shop/MysteryMerchantBanner.vue': stub,
        '@/components/Sidebar.vue': stub,
        '@/components/TopAccountMenu.vue': stub,
    }).default;
}
function node(tag, text = '') { return { tag, text, children: [], parent: null }; }
function detach(child) {
    if (!child.parent) return;
    const siblings = child.parent.children;
    siblings.splice(siblings.indexOf(child), 1);
    child.parent = null;
}
const renderer = vue.createRenderer({
    createElement: tag => node(tag), createText: text => node('#text', text), createComment: () => node('#comment'),
    setText: (el, text) => { el.text = text; }, setElementText: (el, text) => { el.text = text; el.children = []; },
    parentNode: el => el.parent, nextSibling: el => el.parent?.children[el.parent.children.indexOf(el) + 1] || null,
    insert(child, parent, anchor) { detach(child); child.parent = parent; const at = anchor ? parent.children.indexOf(anchor) : -1; parent.children.splice(at < 0 ? parent.children.length : at, 0, child); },
    remove: detach, patchProp() {},
});
function content(el) { return [el.text, ...el.children.map(content)].join(' '); }

test('real layout navigates away from a fragment-root dashboard repeatedly without refresh', async () => {
    const dashboard = { render: () => vue.h(vue.Fragment, [vue.h('article', 'dashboard-body'), vue.h(vue.Comment)]) };
    const router = routerLib.createRouter({ history: routerLib.createMemoryHistory(), routes: [
        { path: '/', component: dashboard },
        { path: '/personal', component: { render: () => vue.h('article', 'personal-body') } },
        { path: '/activity', component: { render: () => vue.h('article', 'activity-body') } },
    ] });
    await router.push('/');
    const host = node('root');
    const app = renderer.createApp(layoutComponent());
    app.use(router);
    app.mount(host);
    try {
        assert.match(content(host), /dashboard-body/);
        for (const [destination, marker] of [['/activity', 'activity-body'], ['/personal', 'personal-body'], ['/', 'dashboard-body'], ['/personal', 'personal-body'], ['/activity', 'activity-body']]) {
            await router.push(destination);
            await vue.nextTick();
            await vue.nextTick();
            assert.match(content(host), new RegExp(marker), `route ${destination} should mount`);
        }
    } finally { app.unmount(); }
});

const recovery = evaluate(fs.readFileSync(path.join(root, 'web/src/router/chunk-recovery.ts'), 'utf8'), {});
function memoryStorage() {
    const values = new Map();
    return { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
}
test('removed lazy chunks recover at the intended route once across page loads', async () => {
    const storage = memoryStorage();
    const locations = [];
    const router = routerLib.createRouter({ history: routerLib.createMemoryHistory(), routes: [
        { path: '/', component: { render: () => null } },
        { path: '/activity', component: () => Promise.reject(new Error('Failed to fetch dynamically imported module')) },
    ] });
    router.onError((error, to) => recovery.recoverRouteChunk(error, to.fullPath, storage, path => locations.push(path)));
    await router.push('/');
    await assert.rejects(router.push('/activity?tab=all'));
    assert.deepEqual(locations, ['/activity?tab=all']);
    await assert.rejects(router.push('/activity?tab=all'));
    assert.equal(locations.length, 1, 'persistent import failure must not create a reload loop');
    recovery.clearRouteChunkRetry(storage);
    await assert.rejects(router.push('/activity'));
    assert.equal(locations.length, 2, 'successful navigation permits recovery after a future deployment');
});

test('ordinary render failures, foreign destinations and unavailable retry storage never reload', () => {
    let reloads = 0;
    const replace = () => { reloads++; };
    const error = new Error('Failed to fetch dynamically imported module');
    assert.equal(recovery.recoverRouteChunk(new Error('Cannot read properties of undefined'), '/activity', memoryStorage(), replace), false);
    assert.equal(recovery.recoverRouteChunk(error, '//foreign.invalid', memoryStorage(), replace), false);
    assert.equal(recovery.recoverRouteChunk(error, '/activity', { getItem() { throw new Error('blocked'); } }, replace), false);
    assert.equal(reloads, 0);
});
