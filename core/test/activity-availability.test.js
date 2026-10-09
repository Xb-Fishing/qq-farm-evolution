'use strict';
// 活动下架门控回归（登记反证文件，2026-10-08）。
// 只经「旧源码已有」的读取入口（fetchBearActivity / fetchWishActivity /
// fetchHappyShareActivity）、领取编排（runClaimAll）与页面入口（Activity.vue
// 真实渲染点击）观察请求计数与展示行为：
//   - 旧代码（无下架门控）必须在本文件至少一项真实行为上失败（重复读取、
//     过期资格触发写请求、已结束活动仍出现在默认页面等），而不是缺少新增导出的环境失败；
//   - 当前代码全部通过。
// 本文件不引用任何新增导出（activityRetired / recheckActivity /
// cancelActivityReads / sweepExpiredActivities），新增能力与生命周期验收在
// activity-claim-all.test.js（非反证文件）。
// 网络全部为隔离替身（api mock），零真实游戏请求；业务模块加载前设置独立
// FARM_DATA_DIR，一切目录创建/写入先解析校验边界，越界在原语调用前拒绝。
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
const privateDir = path.resolve(fs.mkdtempSync(path.join(tempRoot, 'farm-activity-availability-')));
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
  path.join(repoRoot, 'web', 'src', 'components', 'activity', 'SeasonRuleActivityPanel.vue'),
  path.join(repoRoot, 'web', 'src', 'components', 'admin', 'AdminActivityUpdatePanel.vue'),
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
  return { tag, children: [], props: {}, text: '', parent: null };
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

function storeHarness() {
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
    fs.readFileSync(path.join(WEB, 'src/stores/activity.ts'), 'utf8'), resolve,
  );
  const store = mod.useActivityStore(pinia.createPinia());
  return { store, api, accountState };
}

function countGets(api) {
  const counts = { bear: 0, wish: 0, share: 0 };
  for (const call of api.calls.get) {
    if (call.url.includes('bear'))
      counts.bear += 1;
    else if (call.url.includes('happy-share'))
      counts.share += 1;
    else if (call.url.includes('wish'))
      counts.wish += 1;
  }
  return counts;
}

const fullEligibility = { available: true, reason: '', stories: [2, 5], dogClaimable: true, compensationCount: 1, seedsClaimable: true };
const emptyEligibility = { available: true, reason: '', stories: [], dogClaimable: false, compensationCount: 0, seedsClaimable: false };
const wishPendingState = { remainingCount: 1, activityDay: 2, pending: { chooseId: 3, textId: 1, dayId: 2, rewards: [] } };
const shareBeforeDaily = { currentScore: 10, daily: { claimedCount: 0, claimLimit: 1, rewardClaimed: false, firstShareAwarded: false }, milestones: [{ id: 1, threshold: 20, state: 1, rewards: [] }] };

function petOkPost(url, body) {
  return { data: { ok: true, action: body.action, rewards: [{ id: 29004, count: '3', name: '' }], message: '操作成功' } };
}
function wishOkPost(url, body) {
  const rewards = { wishClaim: [{ itemName: '烟花桶', itemCount: 2 }], shareDaily: [{ itemName: '快乐值', itemCount: 30 }] }[body.action] || [];
  return { data: { ok: true, rewards, ...(body.action === 'shareDaily' ? { grantedScore: 30 } : {}) } };
}

// 页面挂载（真实 store + 真实路由组件树 + 模拟 api）；sharedPinia 供跨卸载复用同一 store
function panelSafeActivity(extra = {}) {
  return {
    activityId: 1, title: '活动', startTime: 0, endTime: 0, visible: true, enabled: true, status: 20,
    statusLabel: '已启用', uid: '', uidConfirmed: false, clientUiUid: '', readOnly: true,
    inventoryAvailable: false, gameplayGuides: [], notices: [], conflicts: [], resources: [],
    exchangeShop: [], records: [], recordStateAvailable: false, subActivities: [], ruleSections: [],
    missingEvidence: [], protocol: { declaredReadOnlyFields: [], opaqueReadOnlyFields: [] },
    ...extra,
  };
}

function mountActivityPage(api, sharedPinia) {
  const toastLog = [];
  const testPinia = sharedPinia || pinia.createPinia();
  pinia.setActivePinia(testPinia);
  const accountRef = vue.ref('acc-1');
  const useAccountStore = pinia.defineStore('account', () => ({
    currentAccountId: accountRef,
    currentAccount: vue.ref({ name: '账号A' }),
  }));
  const useEvolutionStore = pinia.defineStore('evolution', () => ({
    evolve: vue.ref(null),
    loadStatus: async () => {},
    startPolling: () => {},
    stopPolling: () => {},
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
    if (spec === '@/stores/evolution')
      return { useEvolutionStore };
    if (spec === '@/stores/toast')
      return { useToastStore: () => ({ success: (...args) => toastLog.push(['success', ...args]), error: (...args) => toastLog.push(['error', ...args]) }) };
    if (spec === '@/stores/user')
      return { useUserStore: () => ({ isAdmin: false }) };
    if (spec === '@/components/admin/AdminActivityUpdatePanel.vue' || spec === '@/components/admin/EvolutionAgentSettings.vue')
      return stubComponent;
    return undefined;
  };
  const Activity = compileSfcModule(path.join(WEB, 'src/views/Activity.vue'), resolve);
  const root = makeNode('root');
  livePageRoots.push(root); // 套件收尾统一卸载（含用例失败路径）
  render(vue.h(Activity), root);
  return { root, toastLog, accountRef, pinia: testPinia };
}

// ===== 用例 =====

// 写原语计数：证明越界目标在任何 mkdir/写/删/改权限原语「之前」被守卫拒绝（零创建零写入），
// 且合法目标经守卫后原语正常执行（计数器能观测真实写入，合法路径可用）
function withWritePrimitiveCounters(fn) {
  const tracked = ['mkdirSync', 'writeFileSync', 'appendFileSync', 'rmSync', 'chmodSync', 'symlinkSync'];
  const counts = Object.fromEntries(tracked.map(name => [name, 0]));
  const originals = tracked.map(name => [name, fs[name]]);
  for (const [name, original] of originals)
    fs[name] = (...args) => { counts[name] += 1; return original.apply(fs, args); };
  try {
    return { counts, value: fn() };
  }
  finally {
    for (const [name, original] of originals)
      fs[name] = original;
  }
}

test('夹具边界：越界写目标在任何写原语前拒绝（计数证明零创建零写入）；合法目标经守卫正常执行；候选源码内容与权限不变', () => {
  const escaped = path.join(privateDir, '..', 'farm-activity-availability-escape.json');
  const rejected = withWritePrimitiveCounters(() =>
    assert.throws(() => assertWriteInsidePrivateDir(escaped), /越界/));
  assert.deepEqual(rejected.counts, {
    mkdirSync: 0, writeFileSync: 0, appendFileSync: 0, rmSync: 0, chmodSync: 0, symlinkSync: 0,
  }, '越界拒绝必须发生在任何写原语之前（零创建零写入）');
  assert.equal(fs.existsSync(escaped), false, '被拒绝的目标不得被创建');
  assert.equal(fs.existsSync(path.resolve(privateDir, 'farm-activity-availability-escape.json')), false);
  // 合法目标：守卫放行且写原语被实际调用（证明计数器可观测真实写入、合法路径正常执行）
  const legal = path.join(privateDir, 'legal-guard-fixture.txt');
  const legalRun = withWritePrimitiveCounters(() =>
    fs.writeFileSync(assertWriteInsidePrivateDir(legal), 'legal'));
  assert.equal(legalRun.counts.writeFileSync, 1);
  assert.equal(fs.readFileSync(legal, 'utf8'), 'legal');
  for (const [file, before] of fingerprintsBefore) {
    assert.deepEqual(fingerprintOf(file), before, `候选源码不得被夹具改变: ${path.basename(file)}`);
  }
});

test('结构化 unavailable：清旧快照与旧错误，同账号再次普通刷新零新增读取', async () => {
  const h = storeHarness();
  h.store.wishActivity = panelSafeActivity({ activityId: 9, title: '旧快照' });
  h.api.setGet(async (url) => {
    if (url.includes('wish'))
      return { data: { ok: false, unavailable: true, error: '活动未下发' } };
    return { data: { ok: true, activity: panelSafeActivity({}) } };
  });
  const first = await h.store.fetchWishActivity('acc-1');
  assert.equal(first?.ok, false);
  assert.equal(h.store.wishActivity, null, '下架后旧快照必须清空');
  assert.equal(h.store.wishError, '', '下架不是读取错误，不得留下错误横幅');
  const again = await h.store.fetchWishActivity('acc-1');
  assert.equal(again?.ok, false);
  assert.equal(countGets(h.api).wish, 1, '已下架活动的普通刷新不得再发读取请求');
});

test('三活动分别 unavailable：预置旧快照全部清空；再次刷新与一键领取零新增读取、零写请求', async () => {
  const h = storeHarness();
  h.store.bearActivity = panelSafeActivity({ activityId: 1 });
  h.store.wishActivity = panelSafeActivity({ activityId: 2 });
  h.store.happyShareActivity = panelSafeActivity({ activityId: 3 });
  h.api.setGet(async () => ({ data: { ok: false, unavailable: true, error: '活动未下发' } }));
  h.api.setPost(async (url, body) => (url.includes('pet-diary') ? petOkPost(url, body) : wishOkPost(url, body)));
  await h.store.fetchBearActivity('acc-1');
  await h.store.fetchWishActivity('acc-1');
  await h.store.fetchHappyShareActivity('acc-1');
  assert.equal(h.store.bearActivity, null);
  assert.equal(h.store.wishActivity, null);
  assert.equal(h.store.happyShareActivity, null);
  assert.equal(h.store.bearError, '');
  assert.equal(h.store.wishError, '');
  assert.equal(h.store.happyShareError, '');
  // 普通刷新：三组全部零新增读取
  await h.store.fetchBearActivity('acc-1');
  await h.store.fetchWishActivity('acc-1');
  await h.store.fetchHappyShareActivity('acc-1');
  assert.deepEqual(countGets(h.api), { bear: 1, wish: 1, share: 1 }, '下架后普通刷新零新增读取');
  // 一键领取：零新增读取、零写请求，三项显式「已结束」跳过，收尾不补读
  const result = await h.store.runClaimAll('acc-1');
  assert.equal(result.ok, true);
  assert.deepEqual(countGets(h.api), { bear: 1, wish: 1, share: 1 }, '一键领取对已下架活动零读取');
  assert.equal(h.api.calls.post.length, 0, '一键领取对已下架活动零写请求');
  const byKey = Object.fromEntries(h.store.claimAllResults.map(item => [item.key, item]));
  for (const key of ['bear', 'wish', 'share']) {
    assert.equal(byKey[key].status, 'skipped');
    assert.match(byKey[key].detail, /已结束/);
  }
  assert.equal(h.store.claimAllResults.some(item => item.key === 'refresh'), false, '收尾不得补读已下架活动');
});

test('有效 endTime 已过期 + 可领资格：一键领取每活动首轮读取一次、零写、显式跳过、收尾不补读', async () => {
  const h = storeHarness();
  const past = Math.floor(Date.now() / 1000) - 1000;
  h.api.setGet(async (url) => {
    if (url.includes('bear'))
      return { data: { ok: true, activity: { claimEligibility: fullEligibility, endTime: past } } };
    if (url.includes('happy-share'))
      return { data: { ok: true, activity: { operateState: shareBeforeDaily, endTime: past } } };
    return { data: { ok: true, activity: { operateState: wishPendingState, endTime: past } } };
  });
  h.api.setPost(async (url, body) => (url.includes('pet-diary') ? petOkPost(url, body) : wishOkPost(url, body)));
  const result = await h.store.runClaimAll('acc-1');
  assert.equal(result.ok, true);
  assert.deepEqual(countGets(h.api), { bear: 1, wish: 1, share: 1 }, '过期活动首轮各读取一次后不再读取');
  assert.equal(h.api.calls.post.length, 0, '过期资格不得触发任何写请求');
  const byKey = Object.fromEntries(h.store.claimAllResults.map(item => [item.key, item]));
  for (const key of ['bear', 'wish', 'share']) {
    assert.equal(byKey[key].status, 'skipped');
    assert.match(byKey[key].detail, /已结束/);
  }
  assert.equal(h.store.bearActivity, null, '过期快照不得保留展示');
  assert.equal(h.store.wishActivity, null);
  assert.equal(h.store.happyShareActivity, null);
});

test('enabled:false / 普通失败（含离线）/ 空快照都不是下架证据：再次刷新仍会重新读取', async () => {
  const h = storeHarness();
  const future = Math.floor(Date.now() / 1000) + 3600;
  h.api.setGet(async (url) => {
    if (url.includes('bear'))
      return { data: { ok: true, activity: panelSafeActivity({ enabled: false, endTime: future, claimEligibility: emptyEligibility }) } };
    if (url.includes('happy-share'))
      return { data: { ok: true, activity: null } };
    return { data: { ok: false, error: '账号未运行' } };
  });
  await h.store.fetchBearActivity('acc-1');
  await h.store.fetchWishActivity('acc-1');
  await h.store.fetchHappyShareActivity('acc-1');
  const before = countGets(h.api);
  await h.store.fetchBearActivity('acc-1');
  await h.store.fetchWishActivity('acc-1');
  await h.store.fetchHappyShareActivity('acc-1');
  const after = countGets(h.api);
  assert.equal(after.bear, before.bear + 1, 'enabled:false 不是下架证据，仍可刷新');
  assert.equal(after.wish, before.wish + 1, '普通失败/账号离线不是下架证据');
  assert.equal(after.share, before.share + 1, '空快照不是下架证据');
});

test('切账号清下架状态：clearActivityData 后重新读取恢复发请求', async () => {
  const h = storeHarness();
  h.api.setGet(async (url) => {
    if (url.includes('wish'))
      return { data: { ok: false, unavailable: true, error: '活动未下发' } };
    return { data: { ok: true, activity: panelSafeActivity({}) } };
  });
  await h.store.fetchWishActivity('acc-1');
  await h.store.fetchWishActivity('acc-1');
  assert.equal(countGets(h.api).wish, 1, '同账号下不再探测');
  h.accountState.currentAccountId = 'acc-2';
  h.store.clearActivityData();
  await h.store.fetchWishActivity('acc-2');
  assert.equal(countGets(h.api).wish, 2, '下架证据不跨账号，新账号恢复读取');
});

test('页面真实渲染：unavailable 活动从默认页面删除，恢复入口收起；在架活动保留；刷新/一键领取零新增读取', async () => {
  const api = apiMock();
  const future = Math.floor(Date.now() / 1000) + 3600;
  api.setGet(async (url) => {
    if (url.includes('wish'))
      return { data: { ok: false, unavailable: true, error: '活动未下发' } };
    if (url.includes('happy-share'))
      return { data: { ok: true, activity: panelSafeActivity({ operateState: { ...shareBeforeDaily, daily: { claimedCount: 1, claimLimit: 1, rewardClaimed: true, firstShareAwarded: false } }, endTime: future }) } };
    return { data: { ok: true, activity: panelSafeActivity({ claimEligibility: emptyEligibility, endTime: future }) } };
  });
  api.setPost(async (url, body) => (url.includes('pet-diary') ? petOkPost(url, body) : wishOkPost(url, body)));
  const { root, toastLog } = mountActivityPage(api);
  // 活动管理只有确认下架后才出现，不能把初始空快照当作响应完成。
  await waitFor(() => textOf(root).includes('活动管理') && textOf(root).includes('档位奖励（稚萌熊熊）'), '读取落地且下架活动已删除');
  const text = textOf(root);
  assert.doesNotMatch(text, /秋祈良愿/, '默认页面不保留下架活动名称、卡片或结束说明');
  assert.ok(!buttonsOf(root).some(node => textOf(node).includes('重新检查')), '恢复入口默认收起');
  assert.doesNotMatch(text, /错过存储 5 日/, '下架活动的玩法面板应撤下');
  assert.doesNotMatch(text, /活动未下发/, '下架不是读取错误，不渲染错误横幅');
  assert.match(text, /档位奖励（稚萌熊熊）/, '在架活动面板保留');

  // 顶部普通刷新：已下架活动零新增读取，在架活动照常
  click(buttonsOf(root).find(node => textOf(node).trim() === '刷新'));
  await waitFor(() => countGets(api).bear >= 2, '在架活动刷新重新读取');
  assert.equal(countGets(api).wish, 1, '普通刷新不得探测已下架活动');

  // 一键领取：wish 零新增读取、零写请求，跳过项明确「已结束」
  click(buttonsOf(root).find(node => textOf(node).trim() === '一键领取'));
  await waitFor(() => toastLog.some(([, message]) => String(message).includes('一键领取')), '一键领取完成提示');
  assert.equal(countGets(api).wish, 1, '一键领取不得补读已下架活动');
  assert.equal(api.calls.post.filter(call => call.url.includes('season-wish')).length, 0, '已下架活动零写请求');
  assert.match(textOf(root), /已结束/, '领取结果明确跳过已下架活动');
  assert.equal(api.calls.post.length, 0, '在架无可领时同样零写');
});

test('同账号重新进入页面不得自动探测已下架活动（共享 store 状态跨页面实例保留）', async () => {
  const api = apiMock();
  const future = Math.floor(Date.now() / 1000) + 3600;
  api.setGet(async (url) => {
    if (url.includes('wish'))
      return { data: { ok: false, unavailable: true, error: '活动未下发' } };
    return { data: { ok: true, activity: panelSafeActivity({ endTime: future }) } };
  });
  const shared = pinia.createPinia();
  const first = mountActivityPage(api, shared);
  await waitFor(() => textOf(first.root).includes('活动管理'), '首次读取后下架生效');
  render(null, first.root); // 卸载（页面实例销毁，store 保留）
  const second = mountActivityPage(api, shared);
  await waitFor(() => countGets(api).bear >= 2 && textOf(second.root).includes('活动管理'), '重进后在架活动重新读取且下架状态落地');
  assert.equal(countGets(api).wish, 1, '重新进入不得自动探测已下架活动');
  assert.doesNotMatch(textOf(second.root), /秋祈良愿/, '重进仍删除已下架活动名称与说明');
  assert.doesNotMatch(textOf(second.root), /错过存储 5 日/, '重进不得展示已下架面板');
});

test('三活动过期或未下发后默认页面全部删除：无旧介绍、操作、刷新与重新检查，普通刷新零新增读取', async () => {
  for (const reason of ['unavailable', 'expired']) {
    const api = apiMock();
    api.setGet(async () => ({ data: reason === 'unavailable'
      ? { ok: false, unavailable: true, error: '活动未下发' }
      : { ok: true, activity: panelSafeActivity({ endTime: Math.floor(Date.now() / 1000) - 1 }) } }));
    const { root } = mountActivityPage(api);
    await waitFor(() => textOf(root).includes('暂无进行中的活动。') && countGets(api).share === 1, `${reason} 三活动响应均落地`);
    assert.doesNotMatch(textOf(root), /S3 萌宠|秋祈良愿|快乐不独享|错过存储|cmd\d+|编码器|复用本地结果/, `${reason} 默认页面删除旧活动与技术说明`);
    assert.ok(!buttonsOf(root).some(node => /重新检查|一键领取|刷新状态|祈愿|领奖/.test(textOf(node))), `${reason} 无旧活动操作入口`);
    const before = countGets(api);
    click(buttonsOf(root).find(node => textOf(node).trim() === '刷新'));
    await flush();
    await flush();
    assert.deepEqual(countGets(api), before, `${reason} 普通刷新零新增读取`);
    assert.equal(api.calls.post.length, 0, `${reason} 零写请求`);
    render(null, root);
  }
});

test('未知截止、普通读取失败与网络拒绝保留活动入口：不误删、不新增探测、不显示编码说明', async () => {
  const api = apiMock();
  api.setGet(async (url) => {
    if (url.includes('wish'))
      return { data: { ok: false, error: '暂时读取失败' } };
    if (url.includes('happy-share'))
      throw new Error('连接暂时中断');
    return { data: { ok: true, activity: panelSafeActivity({ endTime: 0 }) } };
  });
  const { root } = mountActivityPage(api);
  await waitFor(() => textOf(root).includes('暂时读取失败') && textOf(root).includes('连接暂时中断'), '普通失败与拒绝已返回');
  assert.match(textOf(root), /S3 萌宠/);
  assert.match(textOf(root), /秋祈良愿 · 每日祈愿/);
  assert.match(textOf(root), /快乐不独享 · 快乐值/);
  assert.doesNotMatch(textOf(root), /活动管理|已结束/, '未知/普通失败不被当作结束');
  const seasonPanels = findAll(root, el => el.tag === 'section' && el.children.some(child => child.tag === 'header' && /秋祈良愿 · 每日祈愿|快乐不独享 · 快乐值/.test(textOf(child))));
  assert.equal(seasonPanels.length, 2);
  for (const panel of seasonPanels)
    assert.doesNotMatch(textOf(panel), /编码器|命令字|复用本地结果|当前 List/, '当季活动产品提示无技术说明');
  assert.deepEqual(countGets(api), { bear: 1, wish: 1, share: 1 }, '每活动仅页面初始读取一次');
  assert.equal(api.calls.post.length, 0);
});
