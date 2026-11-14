'use strict';
// 当前奶茶活动真实 store/SFC 渲染夹具；网络完全替身。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

// ===== 夹具创建与写边界（先解析校验，任何越界在原语调用前拒绝）=====
const repoRoot = path.resolve(__dirname, '..', '..');
const repoRootReal = fs.realpathSync(repoRoot);
function isInsideOrEqualDir(candidate, base) {
  const c = path.resolve(String(candidate));
  const b = path.resolve(String(base));
  return c === b || c.startsWith(b + path.sep);
}
const tempRoot = fs.realpathSync(path.resolve(os.tmpdir()));
assert.equal(isInsideOrEqualDir(tempRoot, repoRootReal), false, '临时根不得指向仓库');
const prefixPath = path.join(tempRoot, 'farm-activity-availability-');
assert.ok(isInsideOrEqualDir(prefixPath, tempRoot));
const privateDir = path.resolve(fs.mkdtempSync(prefixPath));
assert.equal(isInsideOrEqualDir(privateDir, tempRoot), true, '独立运行数据目录必须落在临时根内');
process.env.FARM_DATA_DIR = privateDir; // 先于任何业务模块加载
function assertWriteInsidePrivateDir(target) {
  const resolved = path.resolve(String(target));
  if (!isInsideOrEqualDir(resolved, privateDir))
    throw new Error(`夹具写目标越界（已在写入原语前拒绝）: ${resolved}`);
  return resolved;
}

// 候选源码指纹：全部用例（含失败路径）结束后内容与权限不得被夹具改变
const CANDIDATE_SOURCES = [
  path.join(repoRoot, 'web', 'src', 'stores', 'activity.ts'),
  path.join(repoRoot, 'web', 'src', 'views', 'Activity.vue'),
  path.join(repoRoot, 'web', 'src', 'components', 'activity', 'MilkTeaActivityPanel.vue'),
];
function fingerprintOf(file) {
  const stat = fs.statSync(file);
  return {
    mode: stat.mode,
    size: stat.size,
    sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
  };
}
const fingerprintsBefore = new Map(CANDIDATE_SOURCES.map(file => [file, fingerprintOf(file)]));

// ===== TS / SFC 加载器（activity-claim-all 测试既有模式）=====
const WEB = path.join(repoRoot, 'web');
const MODULES = path.join(WEB, 'node_modules');
const vue = require(path.join(MODULES, 'vue'));
const pinia = require(path.join(MODULES, 'pinia'));
const vueRouter = require(path.join(MODULES, 'vue-router'));
const sfcCompiler = require(path.join(MODULES, 'vue', 'compiler-sfc'));
const ts = require(path.join(MODULES, 'typescript'));

function evaluateModule(source, resolve, filename = 'module.ts', timing = {}) {
  const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ESNext },
  }).outputText;
  const mod = { exports: {} };
  mod.exports.__esModule = true;
  vm.compileFunction(code, ['require', 'module', 'exports', 'setTimeout', 'clearTimeout', 'Date'])(spec => {
    const value = resolve(spec, filename);
    if (value === undefined)
      throw new Error(`测试加载器无法解析依赖: ${spec} (from ${filename})`);
    return value;
  }, mod, mod.exports, timing.setTimeout || setTimeout, timing.clearTimeout || clearTimeout, timing.Date || Date);
  return mod.exports;
}

function compileSfcModule(absPath, resolve) {
  const source = fs.readFileSync(absPath, 'utf8');
  const { descriptor, errors } = sfcCompiler.parse(source, { filename: absPath });
  assert.deepEqual(errors.map(String), [], `SFC 解析失败: ${absPath}`);
  // The test host models VNodes, not a browser HTML parser. Keep static subtrees
  // as VNodes so the same real templates retain all interaction assertions.
  const script = sfcCompiler.compileScript(descriptor, { id: path.basename(absPath), inlineTemplate: true,
    templateOptions: { compilerOptions: { hoistStatic: false } } });
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
    if (spec === 'vue-router') return vueRouter;
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
          Object.assign(child.exports, evaluateModule(
            fs.readFileSync(target + suffix, 'utf8'), resolve, target + suffix,
          ));
          return child.exports;
        }
      }
    }
    throw new Error(`测试加载器无法解析依赖: ${spec} (from ${absPath})`);
  }, mod, mod.exports);
  return mod.exports.default;
}

// ===== 自定义渲染器节点树（既有模式）=====
function makeNode(tag) {
  return { tag, tagName: String(tag).toUpperCase(), children: [], props: {}, text: '', parent: null, addEventListener() {}, removeEventListener() {}, get options() { return this.children.filter(n => n.tag === 'option'); } };
}
const nodeOps = {
  createElement: tag => makeNode(tag),
  createText: (text) => {
    const node = makeNode('TEXT');
    node.text = String(text ?? '');
    return node;
  },
  createComment: () => makeNode('COMMENT'),
  setText: (node, text) => { node.text = String(text); },
  setElementText: (el, text) => { el.text = String(text); el.children.length = 0; },
  parentNode: node => node.parent,
  nextSibling: (node) => {
    if (!node.parent)
      return null;
    const siblings = node.parent.children;
    const index = siblings.indexOf(node);
    return index >= 0 && index + 1 < siblings.length ? siblings[index + 1] : null;
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
async function waitFor(predicate, label, rounds = 60) {
  for (let index = 0; index < rounds; index++) {
    if (predicate())
      return;
    await flush();
  }
  assert.ok(predicate(), `等待超时: ${label}`);
}
globalThis.document = globalThis.document || { activeElement: null };
globalThis.window = globalThis.window || { prompt: () => null };

// ===== 整套收尾（成功与失败路径都执行）：卸载仍挂载的页面（卸载即释放该页在飞读取
// 与到期计时）、最终复核候选源码内容与权限、删除隔离运行数据目录。
// 反证合同保持：收尾只做清理与指纹复核，不引用任何新增导出——旧代码上同样零失败。 =====
const livePageRoots = [];
test.after(() => {
  try {
    while (livePageRoots.length) {
      const root = livePageRoots.pop();
      try {
        render(null, root);
      }
      catch { /* 尽力卸载，失败不得掩盖后续指纹复核 */ }
    }
    for (const [file, before] of fingerprintsBefore)
      assert.deepEqual(fingerprintOf(file), before, `候选源码不得被夹具改变（套件收尾最终复核）: ${path.basename(file)}`);
  }
  finally {
    fs.rmSync(privateDir, { recursive: true, force: true });
  }
});

// ===== 网络替身与 store 装配（零真实请求）=====
function apiMock() {
  const calls = { get: [], post: [] };
  let getHandler = async () => ({ data: { ok: true } });
  let postHandler = async () => ({ data: { ok: true } });
  const instance = {
    get: async (url, config) => {
      calls.get.push({ url, accountId: config?.headers?.['x-account-id'] });
      return getHandler(url, config);
    },
    post: async (url, body, config) => {
      calls.post.push({ url, body, accountId: config?.headers?.['x-account-id'] });
      return postHandler(url, body, config);
    },
  };
  return { instance, calls, setGet: fn => (getHandler = fn), setPost: fn => (postHandler = fn) };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function storeHarness(timing = {}) {
  const api = apiMock();
  const accountState = { currentAccountId: 'acc-1' };
  const resolve = (spec) => {
    if (spec === 'vue')
      return vue;
    if (spec === 'pinia')
      return pinia;
    if (spec === '@/api')
      return { __esModule: true, default: api.instance };
    if (spec === '@/stores/account')
      return { useAccountStore: () => accountState };
    return undefined;
  };
  const mod = evaluateModule(
    fs.readFileSync(path.join(WEB, 'src/stores/activity.ts'), 'utf8'), resolve, 'activity.ts', timing,
  );
  const store = mod.useActivityStore(pinia.createPinia());
  return { store, api, accountState };
}

function mountActivityPage(api, sharedPinia) {
  const toastLog = [];
  const testPinia = sharedPinia || pinia.createPinia();
  pinia.setActivePinia(testPinia);
  let accountRef = vue.ref('acc-1');
  const useAccountStore = pinia.defineStore('account', () => ({
    currentAccountId: accountRef,
    currentAccount: vue.ref({ name: '账号A' }),
  }));
  const stubComponent = { render: () => null };
  const resolve = (spec) => {
    if (spec === 'vue')
      return vue;
    if (spec === 'vue-router')
      return vueRouter;
    if (spec === 'pinia')
      return pinia;
    if (spec === '@/api')
      return { __esModule: true, default: api.instance };
    if (spec === '@/stores/account')
      return { useAccountStore };
    if (spec === '@/stores/toast')
      return { useToastStore: () => ({ success: (...args) => toastLog.push(['success', ...args]), error: (...args) => toastLog.push(['error', ...args]) }) };
    return undefined;
  };
  accountRef = vue.toRef(useAccountStore(testPinia), 'currentAccountId');
  const Activity = compileSfcModule(path.join(WEB, 'src/views/Activity.vue'), resolve);
  const root = makeNode('root');
  livePageRoots.push(root); // 套件收尾统一卸载（含用例失败路径）
  render(vue.h(Activity), root);
  return { root, toastLog, accountRef, pinia: testPinia };
}


function snapshot(extra = {}) {
  return { title: '奶茶热销中', timing: { endTime: 0, phase: 'open' }, summary: {}, rules: [], ...extra };
}
module.exports = { vue, pinia, WEB, compileSfcModule, evaluateModule, render, makeNode, textOf, findAll, buttonsOf, click, flush, waitFor, storeHarness, mountActivityPage, apiMock, deferred, snapshot, privateDir, assertWriteInsidePrivateDir, isInsideOrEqualDir, fingerprintsBefore, fingerprintOf };
if (require.main === module) {
  test('unavailable 撤下奶茶活动；普通刷新/一键零新增读写；手动重查仅一次', async () => {
    const { store, api } = storeHarness();
    api.setGet(async () => ({ data: { ok: false, unavailable: true } }));
    await store.fetchMilkTeaActivity('acc-1');
    await store.fetchMilkTeaActivity('acc-1'); await store.runClaimAll('acc-1');
    assert.equal(api.calls.get.length, 1); assert.equal(api.calls.post.length, 0);
    assert.equal(store.milkTeaActivity, null);
    api.setGet(async () => ({ data: { ok: true, activity: snapshot() } }));
    await store.recheckActivity('milkTea', 'acc-1');
    assert.equal(api.calls.get.length, 2); assert.equal(store.activityRetired.milkTea, null);
    store.cancelActivityReads();
  });
  test('未知截止、enabled=false、普通失败与空状态不冒充下架；切号清除归属', async () => {
    const { store, api } = storeHarness();
    for (const data of [{ ok: true, activity: snapshot({ enabled: false }) }, { ok: false, error: 'offline' }, { ok: true, activity: null }]) {
      api.setGet(async () => ({ data }));
      await store.fetchMilkTeaActivity('acc-1'); assert.equal(store.activityRetired.milkTea, null);
    }
    api.setGet(async () => ({ data: { ok: false, unavailable: true } }));
    await store.fetchMilkTeaActivity('acc-1'); store.clearActivityData();
    assert.equal(store.activityRetired.milkTea, null); store.cancelActivityReads();
  });
  test('真实默认页面无旧活动/介绍/横幅/请求；挂载与普通刷新仅读奶茶快照', async () => {
    const api = apiMock(); api.setGet(async () => ({ data: { ok: true, activity: snapshot() } }));
    const page = mountActivityPage(api); await flush();
    assert.doesNotMatch(textOf(page.root), /S3|萌宠|秋祈|稚萌熊熊/);
    assert.ok(api.calls.get.length >= 1); assert.ok(api.calls.get.every(c => c.url === '/api/activity/milk-tea'));
    assert.equal(api.calls.post.length, 0);
    click(buttonsOf(page.root).find(b => textOf(b).trim() === '刷新')); await flush();
    assert.equal(api.calls.post.length, 0); render(null, page.root);
  });
}

if (require.main === module) test('夹具写边界：越界零创建零写，合法可写；权限选择真实不同值并恢复', () => {
  const count = { mkdir:0, write:0 };
  const write = (target, content) => { const dest=assertWriteInsidePrivateDir(target); count.mkdir++;fs.mkdirSync(path.dirname(dest),{recursive:true});count.write++;fs.writeFileSync(dest,content); };
  const source=CANDIDATE_SOURCES[0], before=fingerprintOf(source);
  assert.throws(()=>write(source,'bad'),/越界/);assert.deepEqual(count,{mkdir:0,write:0});assert.deepEqual(fingerprintOf(source),before);
  const dest=path.join(privateDir,'guarded','valid.txt');write(dest,'fixture');assert.deepEqual(count,{mkdir:1,write:1});assert.equal(fs.readFileSync(dest,'utf8'),'fixture');
  const original=fs.statSync(dest).mode & 0o777;const changed=original === 0o600 ? 0o640 : 0o600;
  try {fs.chmodSync(assertWriteInsidePrivateDir(dest),changed);assert.notEqual(fs.statSync(dest).mode & 0o777,original);} finally {fs.chmodSync(assertWriteInsidePrivateDir(dest),original);}
});
