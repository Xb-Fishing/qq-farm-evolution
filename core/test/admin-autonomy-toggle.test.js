'use strict';
// 自主进化开关的端到端回归（2026-10-05）：真实 admin 路由注册（进化服务 require.cache
// 隔离桩）+ 真实 AdminActivityUpdatePanel.vue 渲染点击（真实 evolution/toast store +
// 模拟 api）。只验开关合同：管理员角色门禁、enabled 严格布尔透传、面板按钮真实
// POST 并同步返回状态、退避剩余时间可见。应用/返工的审批与隐私语义由真实服务级
// 测试覆盖（evolution-autonomy / evolution-team），这里不替它们打桩下结论。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const REPO_ROOT = path.join(__dirname, '..', '..');
const WEB = path.join(REPO_ROOT, 'web');
const vue = require(path.join(WEB, 'node_modules', 'vue'));
const pinia = require(path.join(WEB, 'node_modules', 'pinia'));
const vueRouter = require(path.join(WEB, 'node_modules', 'vue-router'));
const sfcCompiler = require(path.join(WEB, 'node_modules', 'vue', 'compiler-sfc'));
const ts = require(path.join(WEB, 'node_modules', 'typescript'));

// ---------- 路由层 ----------
function loadRoutes(t, evolveState) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farm-autonomy-routes-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const toggleCalls = [];
  const evolverStub = {
    setAutonomousEvolution: (enabled) => { toggleCalls.push(enabled); return { ok: true, enabled }; },
    getEvolveState: () => evolveState.value,
    checkAndMaybeEvolve: () => {},
    startActivityEvolver: () => {},
  };
  const monitorStub = {
    getActivityUpdateState: () => ({}),
    MANUAL_SCAN_UPSTREAM_CACHE_MS: 120000,
    runActivityUpdateScan: async () => { throw new Error('not used'); },
    startActivityUpdateMonitor: () => {},
  };
  const evolverPath = require.resolve('../src/services/activity-evolver');
  const monitorPath = require.resolve('../src/services/activity-update-monitor');
  const evolverExports = require(evolverPath);
  const monitorExports = require(monitorPath);
  require.cache[evolverPath].exports = { ...evolverExports, ...evolverStub };
  require.cache[monitorPath].exports = { ...monitorExports, ...monitorStub };
  t.after(() => {
    require.cache[evolverPath].exports = evolverExports;
    require.cache[monitorPath].exports = monitorExports;
  });
  const routes = require('../src/controllers/admin-activity-update-routes');
  const registered = new Map();
  const app = {
    get: (route, ...handlers) => registered.set(route, handlers),
    post: (route, ...handlers) => registered.set(route, handlers),
  };
  routes.registerAdminActivityUpdateRoutes({
    app,
    provider: { getAccounts: () => ({ accounts: [] }), isAccountRunning: () => false, getStatus: () => null },
    store: {},
    requireAdminToken: (req, res, next) => {
      if (req.headers?.token === 'ok') {
        req.currentUser = { role: req.headers.role };
        return next();
      }
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    },
  });
  return { registered, toggleCalls };
}

function invoke(handlers, req) {
  const res = {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  let index = 0;
  const next = () => { index += 1; if (index < handlers.length) handlers[index](req, res, next); };
  handlers[0](req, res, next);
  return res;
}

test('autonomous-evolution 路由：管理员严格布尔透传；非管理员 403 不触碰开关', (t) => {
  const evolveState = { value: { status: 'idle', autonomousEvolutionEnabled: false } };
  const { registered, toggleCalls } = loadRoutes(t, evolveState);
  const handlers = registered.get('/api/activity/update/autonomous-evolution');
  assert.ok(handlers, '应注册 POST /api/activity/update/autonomous-evolution');

  const on = invoke(handlers, { headers: { token: 'ok', role: 'admin' }, body: { enabled: true } });
  assert.equal(on.statusCode, 200);
  assert.equal(on.body.ok, true);
  assert.equal(on.body.evolve.autonomousEvolutionEnabled, false, '响应携带服务端权威状态');
  assert.deepEqual(toggleCalls, [true]);

  for (const body of [{ enabled: false }, { enabled: 'yes' }, {}, { enabled: null }]) {
    invoke(handlers, { headers: { token: 'ok', role: 'super_admin' }, body });
  }
  assert.deepEqual(toggleCalls, [true, false, false, false, false], '非 true 一律按关闭，不透传任意真值');

  const forbidden = invoke(handlers, { headers: { token: 'ok', role: 'viewer' }, body: { enabled: true } });
  assert.equal(forbidden.statusCode, 403);
  const anonymous = invoke(handlers, { headers: {}, body: { enabled: true } });
  assert.equal(anonymous.statusCode, 401);
  assert.equal(toggleCalls.length, 5, '非管理员不得触发开关');
});

// ---------- UI 层：真实 AdminActivityUpdatePanel.vue 渲染点击 ----------
function evaluateModule(source, resolve, filename = 'module.ts') {
  const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ESNext },
  }).outputText;
  const mod = { exports: {} };
  mod.exports.__esModule = true;
  vm.compileFunction(code, ['require', 'module', 'exports'])(spec => {
    const value = resolve(spec, filename);
    if (value === undefined)
      throw new Error(`测试加载器无法解析依赖: ${spec} (from ${filename})`);
    return value;
  }, mod, mod.exports);
  return mod.exports;
}

function compileSfcModule(absPath, resolve) {
  const source = fs.readFileSync(absPath, 'utf8');
  const { descriptor, errors } = sfcCompiler.parse(source, { filename: absPath });
  assert.deepEqual(errors.map(String), [], `SFC 解析失败: ${absPath}`);
  const script = sfcCompiler.compileScript(descriptor, { id: path.basename(absPath), inlineTemplate: true });
  assert.deepEqual((script.errors || []).map(String), [], `SFC 编译失败: ${absPath}`);
  const cjs = ts.transpileModule(script.content, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ESNext },
  }).outputText;
  const mod = { exports: {} };
  mod.exports.__esModule = true;
  vm.compileFunction(cjs, ['require', 'module', 'exports'])(spec => {
    const value = resolve(spec, absPath);
    if (value !== undefined)
      return value;
    let target = null;
    if (spec.startsWith('@/'))
      target = path.join(WEB, 'src', spec.slice(2));
    else if (spec.startsWith('.'))
      target = path.resolve(path.dirname(absPath), spec);
    if (target) {
      if (fs.existsSync(target) && target.endsWith('.vue')) {
        const child = { exports: {} };
        child.exports.__esModule = true;
        child.exports.default = compileSfcModule(target, resolve);
        return child.exports;
      }
      for (const suffix of ['.ts', '.js']) {
        if (fs.existsSync(target + suffix)) {
          const child = { exports: {} };
          child.exports.__esModule = true;
          Object.assign(child.exports, evaluateModule(fs.readFileSync(target + suffix, 'utf8'), resolve, target + suffix));
          return child.exports;
        }
      }
    }
    throw new Error(`测试加载器无法解析依赖: ${spec}`);
  }, mod, mod.exports);
  return mod.exports.default;
}

function makeNode(tag) {
  return {
    tag, children: [], props: {}, text: '', parent: null,
    addEventListener(type, handler) { (this.listeners ||= {})[type] = handler; },
    removeEventListener(type) { if (this.listeners) delete this.listeners[type]; },
    setAttribute() {}, removeAttribute() {},
  };
}
const nodeOps = {
  createElement: tag => makeNode(tag),
  createText: (text) => { const node = makeNode('TEXT'); node.text = String(text ?? ''); return node; },
  createComment: () => makeNode('COMMENT'),
  setText: (node, text) => { node.text = String(text ?? ''); },
  setElementText: (el, text) => { el.text = String(text ?? ''); el.children.length = 0; },
  parentNode: node => node.parent,
  nextSibling: (node) => {
    if (!node.parent)
      return null;
    const siblings = node.parent.children;
    const index = siblings.indexOf(node);
    return index >= 0 && index < siblings.length ? siblings[index + 1] : null;
  },
  insert: (child, parent, anchor) => {
    if (child.parent && child.parent !== parent) {
      const index = child.parent.children.indexOf(child);
      if (index !== -1)
        child.parent.children.splice(index, 1);
    }
    child.parent = parent;
    const index = anchor ? parent.children.indexOf(anchor) : -1;
    if (index === -1)
      parent.children.push(child);
    else
      parent.children.splice(index, 0, child);
  },
  remove: (child) => {
    if (!child)
      return;
    if (child.parent) {
      const index = child.parent.children.indexOf(child);
      if (index !== -1)
        child.parent.children.splice(index, 1);
      child.parent = null;
    }
  },
};
const { render } = vue.createRenderer({ ...nodeOps, patchProp: (el, key, prev, next) => { el.props[key] = next; } });

function textOf(node) {
  if (node.tag === 'TEXT' || node.tag === 'COMMENT')
    return node.text || '';
  return (node.text || '') + (node.children || []).map(textOf).join('');
}
function findAll(node, pred, out = []) {
  if (pred(node))
    out.push(node);
  for (const child of node.children || [])
    findAll(child, pred, out);
  return out;
}
const buttonsOf = root => findAll(root, node => node.tag === 'button');
function click(button) {
  const handler = button.props.onClick;
  if (typeof handler !== 'function')
    throw new Error('按钮没有可点击处理器');
  handler({});
}
const flush = () => new Promise(resolve => setImmediate(resolve));
async function waitFor(predicate, label, rounds = 80) {
  for (let index = 0; index < rounds; index++) {
    if (predicate())
      return;
    await flush();
  }
  assert.ok(predicate(), `等待超时: ${label}`);
}

function apiMock() {
  const calls = { get: [], post: [] };
  let postHandler = async () => ({ data: { ok: true } });
  return {
    calls,
    setPost: fn => (postHandler = fn),
    instance: {
      get: async url => { calls.get.push({ url }); return { data: { ok: true, report: minimalReport(), intervalMs: 60000, nextScanAt: 0 } }; },
      post: async (url, body) => { calls.post.push({ url, body }); return postHandler(url, body); },
    },
  };
}

function minimalReport() {
  return {
    scannedAt: 1,
    appId: 'x',
    status: 'up-to-date',
    source: null,
    candidateCount: 0,
    incompleteCandidates: [],
    detectedActivityIds: [],
    unknownActivityIds: [],
    caches: [],
    warnings: [],
    online: { available: true, activities: [], groups: [], unknownActivityIds: [], checkedActivityIds: [] },
  };
}

function mountPanel(t, api) {
  const testPinia = pinia.createPinia();
  pinia.setActivePinia(testPinia);
  const resolve = (spec) => {
    if (spec === 'vue')
      return vue;
    if (spec === 'pinia')
      return pinia;
    if (spec === 'vue-router')
      return vueRouter;
    if (spec === '@/api')
      return { __esModule: true, default: api.instance };
    if (spec === '@/stores/toast' || spec === '@/stores/evolution') {
      const child = { exports: {} };
      child.exports.__esModule = true;
      Object.assign(child.exports, evaluateModule(
        fs.readFileSync(path.join(WEB, 'src', `${spec.slice(2)}.ts`), 'utf8'), resolve, spec,
      ));
      return child.exports;
    }
    return undefined;
  };
  const Panel = compileSfcModule(path.join(WEB, 'src/components/admin/AdminActivityUpdatePanel.vue'), resolve);
  const root = makeNode('root');
  render(vue.h(Panel), root);
  t.after(() => render(null, root));
  return { root };
}

function statusGetHandler(evolve) {
  return async () => ({ data: { ok: true, report: minimalReport(), intervalMs: 60000, nextScanAt: 0, evolve } });
}

test('面板：自主进化按钮真实 POST 开关端点并同步服务端状态；开启后展示退避剩余时刻', async (t) => {
  const api = apiMock();
  const evolve = { status: 'review_blocked', summary: '验收未通过', autonomousEvolutionEnabled: false };
  // 初始/后续状态经 status 轮询注入。
  api.instance.get = async url => {
    api.calls.get.push({ url });
    return statusGetHandler(evolve)();
  };
  api.setPost(async (url, body) => {
    assert.equal(url, '/api/activity/update/autonomous-evolution');
    evolve.autonomousEvolutionEnabled = body.enabled === true;
    if (body.enabled === true) evolve.autonomy = { nextReworkAt: Date.now() + 9 * 60 * 1000 };
    return { data: { ok: true, evolve: { ...evolve } } };
  });
  const { root } = mountPanel(t, api);
  await waitFor(() => textOf(root).includes('自主进化：关'), '初始渲染自主进化开关');

  const toggle = buttonsOf(root).find(node => textOf(node).includes('自主进化'));
  assert.ok(toggle, '应渲染自主进化开关按钮');
  click(toggle);
  await waitFor(() => api.calls.post.length === 1, '点击发出 POST');
  assert.deepEqual(api.calls.post[0].body, { enabled: true }, '关闭状态下点击应请求开启');
  await waitFor(() => textOf(root).includes('自主进化：开'), '同步服务端开启状态');
  assert.ok(textOf(root).includes('下次自动处理'), '开启且有退避剩余时应展示下次自动处理时刻');
  assert.ok(textOf(root).includes('自动应用生效'), '开启后说明文案切换为自动应用');

  click(buttonsOf(root).find(node => textOf(node).includes('自主进化')));
  await waitFor(() => api.calls.post.length === 2, '第二次点击发出 POST');
  assert.deepEqual(api.calls.post[1].body, { enabled: false }, '开启状态下点击应请求关闭');
  await waitFor(() => textOf(root).includes('由你点「应用进化」生效'), '关闭后说明文案恢复人工确认');
});
