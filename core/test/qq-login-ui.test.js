'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const http = require('node:http');
const temp = fs.realpathSync(os.tmpdir()), prefix = path.resolve(temp, 'farm-qq-ui-');
assert.equal(path.dirname(prefix), temp);
const data = fs.mkdtempSync(prefix), previous = process.env.FARM_DATA_DIR;
process.env.FARM_DATA_DIR = data;
const savedOverrides = Object.fromEntries(['FARM_LOG_DIR', 'FARM_PRIVATE_CONFIG_FILE', 'FARM_ACCOUNT_ID'].map(key => [key, process.env[key]]));
const fixtureLogDir = path.resolve(data, 'logs'), fixtureConfig = path.resolve(data, 'private-config.json');
assert.equal(path.dirname(fixtureLogDir), path.resolve(data)); assert.equal(path.dirname(fixtureConfig), path.resolve(data));
process.env.FARM_LOG_DIR = fixtureLogDir; process.env.FARM_PRIVATE_CONFIG_FILE = fixtureConfig; process.env.FARM_ACCOUNT_ID = 'synthetic-qq-fixture';
const root = path.resolve(__dirname, '../..'), web = path.join(root, 'web');
const vue = require(path.join(web, 'node_modules/vue'));
const compiler = require(path.join(web, 'node_modules/vue/compiler-sfc'));
const ts = require(path.join(web, 'node_modules/typescript'));
const files = ['QqLoginPanel.vue', 'AccountModal.vue'].map(f => path.join(web, 'src/components', f));
const before = files.map(f => [fs.readFileSync(f), fs.statSync(f).mode]);
const live = new Set();
test.after(() => {
  for (const [key, value] of Object.entries(savedOverrides)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  for (const h of live) h.unmount();
  files.forEach((f, i) => { assert.deepEqual(fs.readFileSync(f), before[i][0]); assert.equal(fs.statSync(f).mode, before[i][1]); });
  if (previous === undefined) delete process.env.FARM_DATA_DIR; else process.env.FARM_DATA_DIR = previous;
  assert.equal(path.dirname(path.resolve(data)), temp); fs.rmSync(data, { recursive: true, force: true });
});
function node(tag, text = '') { return { tag, text, props: {}, children: [], parent: null, addEventListener() {}, removeEventListener() {} }; }
const textOf = n => n.text + n.children.map(textOf).join('');
const find = (n, predicate) => predicate(n) ? n : n.children.map(c => find(c, predicate)).find(Boolean);
const renderer = vue.createRenderer({
  createElement: tag => node(tag), createText: text => node('text', text), createComment: () => node('comment'),
  setText: (n, text) => { n.text = text; }, setElementText: (n, text) => { n.text = text; n.children = []; },
  parentNode: n => n.parent, nextSibling: n => n.parent?.children[n.parent.children.indexOf(n) + 1] || null,
  insert: (child, parent, anchor) => { if (child.parent) child.parent.children = child.parent.children.filter(n => n !== child); child.parent = parent;
    const index = parent.children.indexOf(anchor); parent.children.splice(index < 0 ? parent.children.length : index, 0, child); },
  remove: n => { if (n.parent) n.parent.children = n.parent.children.filter(c => c !== n); n.parent = null; },
  patchProp: (n, key, _old, value) => { n.props[key] = value; },
});
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
async function flush() { for (let i = 0; i < 6; i++) { await Promise.resolve(); await vue.nextTick(); } }
function harness({ modal = true, enabled = true, editData, show = true } = {}) {
  let clock = 1000000, serial = 0, instance, storageSession = 'fixture-session-a', beforeDispatch = () => {};
  const timers = new Map(), calls = [], ready = [], saved = [];
  let responder = (url) => {
    if (url.endsWith('/create')) return { taskId: `local-${++serial}`, status: 'waiting_scan', qrImage: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZVQAAAAASUVORK5CYII=', expiresAt: clock + 120000 };
    if (url.endsWith('/status')) return { taskId: `local-${serial}`, status: 'confirmed', qrImage: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZVQAAAAASUVORK5CYII=', expiresAt: clock + 100000 };
    if (url.endsWith('/code')) return { code: 'fixture-code', nickname: 'fixture-nickname' };
    if (url.endsWith('/cancel')) return { cancelled: true };
    return {};
  };
  const defaultResponder = responder;
  const api = {
    async get(url, config) { calls.push({ url, config }); return { data: { ok: true, data: { enabled }, enabled: false } }; },
    async post(url, body, config) {
      beforeDispatch();
      const headers = { 'x-admin-token': storageSession };
      for (const transform of config?.transformRequest || []) body = transform(body, headers);
      if (typeof body === 'string') body = JSON.parse(body);
      calls.push({ url, body, config }); const result = await responder(url, body, config);
      return { data: result?.ok === false ? result : { ok: true, data: result } }; },
  };
  const button = { __esModule: true, default: { inheritAttrs: false, props: ['disabled', 'loading'], setup: (props, ctx) => () => vue.h('button', { ...ctx.attrs, disabled: props.disabled }, ctx.slots.default?.()) } };
  const input = { __esModule: true, default: { props: ['modelValue', 'label'], setup: (props, ctx) => () => vue.h('input', { value: props.modelValue, 'aria-label': props.label, onInput: e => ctx.emit('update:modelValue', e.target.value) }) } };
  const empty = { __esModule: true, default: { render: () => null } };
  const cache = new Map();
  const load = file => {
    if (cache.has(file)) return cache.get(file);
    let source = fs.readFileSync(file, 'utf8');
    if (file.endsWith('AccountModal.vue')) source = source.replace('</script>', '\ndefineExpose({ activeTab, form, submitManual, close })\n</script>');
    const { descriptor } = compiler.parse(source, { filename: file });
    const script = compiler.compileScript(descriptor, { id: path.basename(file), inlineTemplate: true, templateOptions: { compilerOptions: { hoistStatic: false } } }).content;
    const code = ts.transpileModule(script, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ESNext } }).outputText;
    const mod = { exports: {} };
    vm.compileFunction(code, ['require', 'module', 'exports', 'setTimeout', 'clearTimeout', 'Date', 'localStorage'])(name => {
      if (name === 'vue') return vue;
      if (name === '@/api') return { __esModule: true, default: api };
      if (name === '@vueuse/core') return { useIntervalFn: () => ({ pause() {}, resume() {} }) };
      if (name === '@/stores/wx-login') return { useWxLoginStore: () => ({ config: {}, resetState() {} }) };
      if (name === '@/utils/gateway-url') return { parseManualLoginInput: value => ({ code: value }) };
      if (name === '@/components/QqLoginPanel.vue') return { __esModule: true, default: load(files[0]) };
      if (name === '@/components/ui/BaseButton.vue') return button;
      if (name === '@/components/ui/BaseInput.vue' || name === '@/components/ui/BaseTextarea.vue') return input;
      if (name === '@/components/MengkaNtLoginGuide.vue') return empty;
      throw new Error(`unexpected import ${name}`);
    }, mod, mod.exports, (fn, ms) => { const id = Symbol(); timers.set(id, { fn, at: clock + ms, ms }); return id; },
    id => timers.delete(id), class extends Date { static now() { return clock; } }, { getItem: key => key === 'admin_token' ? storageSession : null });
    cache.set(file, mod.exports.default); return mod.exports.default;
  };
  const component = load(modal ? files[1] : files[0]), tree = node('root');
  const props = vue.reactive({ show, editData, initialTab: 'qq' });
  const app = renderer.createApp({ render: () => vue.h(component, { ...props, onReady: value => ready.push(value), onSaved: value => saved.push(value), ref: value => { instance = value; } }) });
  app.mount(tree);
  const h = { tree, calls, ready, saved, props, instance: () => instance, timers,
    text: () => textOf(tree), count: action => calls.filter(c => c.url === `/api/qq-login/${action}`).length,
    button: label => find(tree, n => n.tag === 'button' && textOf(n).trim() === label),
    async click(label) { const n = h.button(label); assert.ok(n, `button ${label} is rendered`); assert.ok(!n.props.disabled, `button ${label} is enabled`); n.props.onClick(); await flush(); },
    respond: fn => { responder = fn; },
    resetResponse: () => { responder = defaultResponder; },
    changeSession: value => { storageSession = value; },
    session: () => storageSession,
    beforeDispatch: fn => { beforeDispatch = fn; },
    async advance(ms) { clock += ms; const due = [...timers.entries()].filter(([, t]) => t.at <= clock); for (const [id, t] of due) { if (timers.delete(id)) t.fn(); } await flush(); },
    unmount() { if (live.delete(h)) { app.unmount(); timers.clear(); } },
  };
  live.add(h); return h;
}
test('real QQ modal mounts config only; explicit scan, serialized poll and explicit Code fill manual form without saving', async t => {
  const h = harness({ editData: { id: 'synthetic-target', name: 'existing-name', platform: 'qq', qq: 'synthetic-identity' } }); t.after(h.unmount); await flush();
  assert.ok(h.button('QQ扫码')); assert.equal(h.count('config'), 1); assert.equal(h.count('create'), 0); assert.equal(h.count('code'), 0);
  await h.click('获取QQ二维码'); assert.equal(h.count('create'), 1); assert.equal(h.count('status'), 0);
  await h.advance(1999); assert.equal(h.count('status'), 0); await h.advance(1); assert.equal(h.count('status'), 1);
  assert.equal(h.count('code'), 0); assert.ok(h.button('获取农场登录码'));
  await h.click('获取农场登录码'); assert.equal(h.count('code'), 1); assert.equal(h.instance().activeTab, 'manual');
  assert.equal(h.instance().form.code, 'fixture-code'); assert.equal(h.instance().form.platform, 'qq'); assert.equal(h.instance().form.name, 'existing-name');
  assert.ok(!h.calls.some(c => c.url === '/api/accounts'));
  assert.equal(h.calls.find(c => c.url.endsWith('/code')).config.timeout, 100000);
  await h.instance().submitManual(); await flush();
  const save = h.calls.find(c => c.url === '/api/accounts'); assert.ok(save); assert.equal(save.body.id, 'synthetic-target'); assert.equal(save.body.code, 'fixture-code');
});
test('QQ tab is unavailable in wx edit and disabled gateway shows a reason without create requests', async t => {
  const wx = harness({ editData: { id: 'synthetic-wx', platform: 'wx' } }); t.after(wx.unmount); await flush();
  assert.equal(wx.button('QQ扫码'), undefined); assert.equal(wx.count('config'), 0); assert.equal(wx.instance().activeTab, 'manual');
  const disabled = harness({ modal: false, enabled: false }); t.after(disabled.unmount); await flush();
  assert.match(disabled.text(), /未启用/); assert.equal(disabled.button('获取QQ二维码').props.disabled, true); assert.equal(disabled.count('create'), 0);
});
test('serial polling never overlaps pending requests; absolute expiry removes QR and aborts transport', async t => {
  const h = harness({ modal: false }); t.after(h.unmount); await flush(); await h.click('获取QQ二维码');
  const pending = deferred(); h.respond(url => url.endsWith('/status') ? pending.promise : { cancelled: true });
  await h.advance(2000); assert.equal(h.count('status'), 1); await h.advance(4000); assert.equal(h.count('status'), 1);
  const signal = h.calls.find(c => c.url.endsWith('/status')).config.signal;
  await h.advance(114000); assert.equal(signal.aborted, true); assert.equal(find(h.tree, n => n.tag === 'img'), undefined);
  pending.resolve({ taskId: 'local-1', status: 'confirmed', qrImage: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZVQAAAAASUVORK5CYII=', expiresAt: Date.now() + 120000 }); await flush();
  assert.equal(h.count('code'), 0); assert.equal(h.ready.length, 0); assert.equal(h.timers.size, 0);
});
test('switching tab aborts an in-flight create; late local ID is cancelled and reopening never leaks old QR', async t => {
  const h = harness(); t.after(h.unmount); await flush(); const pending = deferred();
  h.respond(url => url.endsWith('/create') ? pending.promise : { cancelled: true }); await h.click('获取QQ二维码');
  const signal = h.calls.find(c => c.url.endsWith('/create')).config.signal;
  await h.click('手动填码'); assert.equal(signal.aborted, true);
  pending.resolve({ taskId: 'late-local', status: 'waiting_scan', qrImage: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZVQAAAAASUVORK5CYII=', expiresAt: 1120000 }); await flush();
  assert.equal(h.calls.filter(c => c.url.endsWith('/cancel') && c.body.taskId === 'late-local').length, 1);
  await h.click('QQ扫码'); assert.equal(h.count('create'), 1); assert.equal(find(h.tree, n => n.tag === 'img'), undefined);
});
test('late Code after modal close or tab change cannot emit or fill a reopened form', async t => {
  for (const close of [false, true]) {
    const h = harness(); t.after(h.unmount); await flush(); await h.click('获取QQ二维码'); await h.advance(2000);
    const pending = deferred(); h.respond(url => url.endsWith('/code') ? pending.promise : { cancelled: true }); await h.click('获取农场登录码');
    assert.equal(h.count('code'), 1); const signal = h.calls.find(c => c.url.endsWith('/code')).config.signal;
    if (close) { h.props.show = false; await flush(); h.props.show = true; await flush(); } else { await h.click('手动填码'); await h.click('QQ扫码'); }
    assert.equal(signal.aborted, true); pending.resolve({ code: 'obsolete-code', nickname: 'obsolete-name' }); await flush();
    assert.equal(h.instance().form.code, ''); assert.equal(h.count('code'), 1); assert.ok(!h.calls.some(c => c.url === '/api/accounts'));
  }
});
test('changing edit target unmounts the original QQ task and never applies its late Code', async t => {
  const h = harness({ editData: { id: 'target-a', platform: 'qq', name: 'original' } }); t.after(h.unmount);
  await flush(); await h.click('获取QQ二维码'); await h.advance(2000);
  const pending = deferred(); h.respond(url => url.endsWith('/code') ? pending.promise : { cancelled: true });
  await h.click('获取农场登录码'); h.props.editData = { id: 'target-b', platform: 'qq', name: 'next' }; await flush();
  pending.resolve({ code: 'wrong-target-code' }); await flush();
  assert.equal(h.instance().form.code, ''); assert.equal(h.instance().activeTab, 'qq');
  assert.equal(h.count('config'), 2); assert.ok(!h.calls.some(c => c.url === '/api/accounts'));
});
test('ordinary and rejected failures have bounded feedback; cancelled false and unknown Code block retries', async t => {
  for (const reject of [false, true]) {
    const h = harness({ modal: false }); t.after(h.unmount); await flush(); await h.click('获取QQ二维码'); await h.advance(2000);
    h.respond(() => { if (reject) throw new Error('private upstream body'); return { ok: false, error: 'private upstream body' }; });
    await h.click('获取农场登录码'); assert.match(h.text(), /取码结果未确认/); assert.doesNotMatch(h.text(), /private upstream/);
    assert.equal(h.button('获取农场登录码'), undefined); assert.equal(h.count('code'), 1);
    await h.click('取消扫码'); assert.match(h.text(), /取消尚未确认/); assert.equal(h.button('获取QQ二维码').props.disabled, true);
    assert.equal(h.button('取消扫码').props.disabled, true); await h.advance(200000); assert.equal(h.count('code'), 1);
  }
});
test('create failure and status ordinary failure do not automatically repeat or expose upstream text', async t => {
  for (const stage of ['create', 'status']) {
    const h = harness({ modal: false }); t.after(h.unmount); await flush();
    if (stage === 'status') await h.click('获取QQ二维码');
    h.respond(() => ({ ok: false, error: 'sensitive-origin' }));
    if (stage === 'create') await h.click('获取QQ二维码'); else await h.advance(2000);
    await h.advance(6000); assert.equal(h.count(stage), 1); assert.doesNotMatch(h.text(), /sensitive-origin/);
  }
});

test('browser session changes without unmount discard late create/status/Code and stop the old flow', async t => {
  for (const stage of ['create', 'status', 'code']) {
    const h = harness(); t.after(h.unmount); await flush();
    if (stage !== 'create') await h.click('获取QQ二维码');
    if (stage === 'code') await h.advance(2000);
    const pending = deferred(); h.respond(url => url.endsWith(`/${stage}`) ? pending.promise : { cancelled: true });
    if (stage === 'create') await h.click('获取QQ二维码');
    else if (stage === 'status') await h.advance(2000);
    else await h.click('获取农场登录码');
    h.changeSession('fixture-session-b');
    pending.resolve(stage === 'code' ? { code: 'wrong-session-code' } : { taskId: 'local-1', status: 'waiting_scan', qrImage: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZVQAAAAASUVORK5CYII=', expiresAt: 1120000 });
    await flush();
    assert.equal(h.instance().form.code, '');
    assert.equal(find(h.tree, n => n.tag === 'img'), undefined);
    const attempts = h.calls.length; await h.advance(200000); assert.equal(h.calls.length, attempts);
  }
});

test('session replacement before Axios dispatch makes zero create requests', async t => {
  const h = harness({ modal: false }); t.after(h.unmount); await flush();
  h.beforeDispatch(() => h.changeSession('fixture-session-b'));
  await h.click('获取QQ二维码');
  assert.equal(h.count('create'), 0); assert.equal(h.ready.length, 0);
});

test('QQ Code handoff stays bound through explicit manual-save dispatch and response', async t => {
  for (const change of ['session', 'target', 'dispatch', 'late']) {
    const h = harness({ editData: { id: 'target-a', platform: 'qq', name: 'original' } }); t.after(h.unmount);
    await flush(); await h.click('获取QQ二维码'); await h.advance(2000); await h.click('获取农场登录码');
    assert.equal(h.instance().activeTab, 'manual'); assert.equal(h.instance().form.code, 'fixture-code');
    if (change === 'session') h.changeSession('fixture-session-b');
    if (change === 'target') { h.props.editData = { id: 'target-b', platform: 'qq', name: 'next' }; await flush(); }
    if (change === 'dispatch') h.beforeDispatch(() => h.changeSession('fixture-session-b'));
    const pending = deferred(); if (change === 'late') h.respond(url => url === '/api/accounts' ? pending.promise : { cancelled: true });
    const work = h.instance().submitManual(); await flush();
    if (change === 'late') { assert.equal(h.calls.filter(c => c.url === '/api/accounts').length, 1); h.changeSession('fixture-session-b'); pending.resolve({}); }
    await work; await flush();
    assert.equal(h.saved.length, 0, change);
    assert.equal(h.instance().form.code, '', change);
    assert.equal(h.instance().form.name, '', change);
    if (change !== 'late') assert.equal(h.calls.filter(c => c.url === '/api/accounts').length, 0, change);
  }
});

test('a completed old manual save cannot emit success or clear the next QQ handoff after modal reentry', async t => {
  const h = harness(); t.after(h.unmount); await flush();
  await h.click('获取QQ二维码'); await h.advance(2000); await h.click('获取农场登录码');
  const pending = deferred(); h.respond(url => url === '/api/accounts' ? pending.promise : { cancelled: true });
  const oldSave = h.instance().submitManual(); await flush();
  h.props.show = false; await flush(); h.props.show = true; await flush();
  h.resetResponse(); await h.click('获取QQ二维码'); await h.advance(2000); await h.click('获取农场登录码');
  pending.resolve({}); await oldSave; await flush();
  assert.equal(h.saved.length, 0); assert.equal(h.instance().form.code, 'fixture-code');
  assert.equal(h.calls.filter(c => c.url === '/api/accounts').length, 1);
});

test('actual API response interceptor cannot clear a replacement session on an old QQ-save 401', async t => {
  const h = harness(); t.after(h.unmount); await flush();
  await h.click('获取QQ二维码'); await h.advance(2000); await h.click('获取农场登录码');
  const pending = deferred(); h.respond(() => pending.promise);
  const saving = h.instance().submitManual(); await flush();
  const requestConfig = h.calls.find(c => c.url === '/api/accounts').config;
  const arrived = deferred(), respond = deferred();
  const server = http.createServer(async (req, res) => {
    for await (const _ of req) { /* drain only this synthetic request */ }
    arrived.resolve(); await respond.promise;
    res.writeHead(401, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'expired fixture' }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const location = { pathname: '/settings', search: '', href: '' };
  const source = ts.transpileModule(fs.readFileSync(path.join(web, 'src/api/index.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ESNext } }).outputText;
  const mod = { exports: {} }, tokenRef = { get value() { return h.session(); }, set value(value) { h.changeSession(value); } };
  vm.compileFunction(source, ['require', 'module', 'exports', 'window'])(name => {
    if (name === 'axios') return require(path.join(web, 'node_modules/axios'));
    if (name === '@vueuse/core') return { useStorage: key => key === 'admin_token' ? tokenRef : { value: '' } };
    if (name === '@/stores/toast') return { useToastStore: () => ({ error() {}, warning() {} }) };
    if (name === '@/utils/daily-feedback') return { currentFeedbackTrace: () => '', recordClientFailure() {} };
    if (name === '@/utils/request-diagnostics') return { requestOperation: () => 'fixture-save' };
    if (name === '@/utils/safe-redirect') return { resolveSafeRedirect: () => '/settings' };
    throw new Error(`unexpected API import ${name}`);
  }, mod, mod.exports, { location });
  const api = mod.exports.default;
  api.defaults.baseURL = ['http:', '', `127.0.0.1:${server.address().port}`].join('/');
  const actual = api.post('/api/accounts', { code: 'fixture-code' }, { ...requestConfig, proxy: false }).catch(error => error.response);
  await arrived.promise; h.changeSession('fixture-session-b'); respond.resolve();
  const response = await actual; pending.resolve(response.data); await saving; await flush();
  assert.equal(h.session(), 'fixture-session-b'); assert.equal(location.href, '');
  assert.equal(h.saved.length, 0); assert.equal(h.instance().form.code, '');
});
