'use strict';
// 「重新验收并重试」端到端回归（2026-09-26）：真实 admin 路由注册（进化服务与扫描
// monitor 以 require.cache 注入隔离桩）+ 真实 AdminActivityUpdatePanel.vue 渲染点击
// （真实 evolution/toast store + 模拟 api）。不发真实请求、不启动 Agent、不碰生产 state。
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

// ---------- 路由层：真实 registerAdminActivityUpdateRoutes + 隔离桩 ----------
function loadRoutes(t, retryResult) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farm-retry-routes-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const evolverCalls = [];
  const evolverStub = {
    retryReviewBlockedEvolution: (...args) => { evolverCalls.push(args); return retryResult.value; },
    getEvolveState: () => ({ status: retryResult.value?.ok ? 'running' : 'review_blocked', running: false }),
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
  return { registered, evolverCalls };
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

test('evolve-retry 路由：管理员触发服务重试；非管理员 403 不触发；失败原样透传', (t) => {
  const retryResult = { value: { ok: true } };
  const { registered, evolverCalls } = loadRoutes(t, retryResult);
  const handlers = registered.get('/api/activity/update/evolve-retry');
  assert.ok(handlers, '应注册 POST /api/activity/update/evolve-retry');

  const ok = invoke(handlers, { headers: { token: 'ok', role: 'admin' }, body: {} });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.body.ok, true);
  assert.equal(ok.body.started, true);
  assert.deepEqual(evolverCalls, [[]], '不透传任何 HTTP 参数给重试入口');

  const forbidden = invoke(handlers, { headers: { token: 'ok', role: 'viewer' }, body: {} });
  assert.equal(forbidden.statusCode, 403);
  assert.equal(evolverCalls.length, 1, '非管理员不得触发重试');

  const anonymous = invoke(handlers, { headers: {}, body: {} });
  assert.equal(anonymous.statusCode, 401);

  retryResult.value = { ok: false, reason: 'dirty', error: '工作区仍有未提交内容（含未跟踪文件）；请先处理并提交这些改动，再点「重新验收并重试」' };
  const rejected = invoke(handlers, { headers: { token: 'ok', role: 'super_admin' }, body: {} });
  assert.equal(rejected.statusCode, 400);
  assert.equal(rejected.body.ok, false);
  assert.match(rejected.body.error, /工作区仍有未提交内容/);
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
    // v-model 等运行时指令需要的最小 DOM 面（只记录，不产生真实副作用）
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
  let getHandler = async () => ({ data: { ok: true } });
  let postHandler = async () => ({ data: { ok: true } });
  return {
    calls,
    setGet: fn => (getHandler = fn),
    setPost: fn => (postHandler = fn),
    instance: {
      get: async url => { calls.get.push({ url }); return getHandler(url); },
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

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
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
    if (spec === '@/stores/toast') {
      const child = { exports: {} };
      child.exports.__esModule = true;
      Object.assign(child.exports, evaluateModule(
        fs.readFileSync(path.join(WEB, 'src/stores/toast.ts'), 'utf8'), resolve, 'toast.ts',
      ));
      return child.exports;
    }
    if (spec === '@/stores/evolution') {
      const child = { exports: {} };
      child.exports.__esModule = true;
      Object.assign(child.exports, evaluateModule(
        fs.readFileSync(path.join(WEB, 'src/stores/evolution.ts'), 'utf8'), resolve, 'evolution.ts',
      ));
      return child.exports;
    }
    return undefined; // 其余（含相对路径 BaseButton）走真实文件
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

test('面板：review_blocked 显示「重新验收并重试」，点击直发 evolve-retry 并同步状态', async (t) => {
  const api = apiMock();
  api.setGet(statusGetHandler({ status: 'review_blocked', summary: '验收未通过，改动待返工', userInstruction: '' }));
  api.setPost(async () => ({ data: { ok: true, started: true, evolve: { status: 'running', summary: '自动综合巡检执行中' } } }));
  const { root } = mountPanel(t, api, 'review_blocked');
  await waitFor(() => textOf(root).includes('验收未通过'), '初始状态渲染');

  const retryButton = buttonsOf(root).find(node => textOf(node).includes('重新验收并重试'));
  assert.ok(retryButton, 'review_blocked 下应渲染重试按钮');
  assert.equal(retryButton.props.disabled, false);
  assert.match(String(retryButton.props.title || ''), /需先处理并提交工作区改动/, '应提示先处理工作区');

  click(retryButton);
  await waitFor(() => api.calls.post.some(call => call.url === '/api/activity/update/evolve-retry'), '发出重试请求');
  assert.equal(api.calls.post.filter(call => call.url === '/api/activity/update/evolve-retry').length, 1);
  await waitFor(() => textOf(root).includes('执行中'), '响应状态同步进面板');
  // 启动后按钮消失（状态不再是 review_blocked）
  assert.equal(buttonsOf(root).some(node => textOf(node).includes('重新验收并重试')), false);
  assert.doesNotMatch(textOf(root), /undefined|NaN/);
});

test('面板：请求在飞时 busy 锁正确，重复点击不双发；失败展示服务端原因', async (t) => {
  const api = apiMock();
  api.setGet(statusGetHandler({ status: 'review_blocked', userInstruction: '' }));
  const gate = deferred();
  api.setPost(async () => gate.promise);
  const { root } = mountPanel(t, api, 'review_blocked');
  await waitFor(() => buttonsOf(root).some(node => /重新验收并重试|重试启动中/.test(textOf(node))), '重试按钮渲染');

  const button = () => buttonsOf(root).find(node => /重新验收并重试|重试启动中/.test(textOf(node)));
  click(button());
  await waitFor(() => api.calls.post.length === 1, '第一次点击发出请求');
  await waitFor(() => button().props.disabled === true, '在飞期间按钮禁用');
  click(button()); // 禁用态再点：handler 自守卫，不得双发
  await flush();
  assert.equal(api.calls.post.filter(call => call.url === '/api/activity/update/evolve-retry').length, 1, 'busy 期间不得重复发请求');

  // 服务端 400：按 axios 语义以 response.data 形态拒绝
  gate.reject({ response: { data: { ok: false, error: '工作区仍有未提交内容（含未跟踪文件）；请先处理并提交这些改动，再点「重新验收并重试」' } } });
  await waitFor(() => textOf(root).includes('工作区仍有未提交内容'), '服务端失败原因展示');
  await waitFor(() => button() !== undefined && button().props.disabled === false, '失败后按钮恢复可点');
});

test('面板：非 review_blocked 状态不渲染重试按钮，其它 evolutionBlocked 按钮语义不变', async (t) => {
  const waitLabels = {
    idle: '空闲', running: '执行中…', pending_apply: '待确认应用',
    push_failed: 'GitHub 推送失败', privacy_blocked_local: '本地改动待检查',
  };
  for (const status of ['idle', 'pending_apply', 'push_failed', 'privacy_blocked_local', 'running']) {
    const api = apiMock();
    api.setGet(statusGetHandler({ status, userInstruction: '' }));
    api.setPost(async () => { throw new Error(`不得发起重试: ${status}`); });
    const { root } = mountPanel(t, api, status);
    await waitFor(() => textOf(root).includes(waitLabels[status]), `渲染 ${status}`);
    assert.equal(buttonsOf(root).some(node => /重新验收并重试|重试启动中/.test(textOf(node))), false, `${status} 不显示重试按钮`);
    // running/push_failed 等原有互斥按钮仍按 evolutionBlocked 禁用
    if (['running', 'push_failed', 'privacy_blocked_local', 'pending_apply'].includes(status)) {
      const patrol = buttonsOf(root).find(node => textOf(node).includes('立即巡检'));
      assert.ok(patrol, `${status} 应渲染立即巡检按钮`);
      assert.equal(patrol.props.disabled, true, `${status} 立即巡检保持禁用`);
    }
  }
});
