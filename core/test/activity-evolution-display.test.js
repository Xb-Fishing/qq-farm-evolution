'use strict';
// 真实管理面板渲染：完成日来源、综合巡检与独立活动轮区分、未完成轮不能冒充完成。
// 全部状态和外部效果为隔离替身；不启动 Agent、不请求网络、不写生产状态。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

const repoRoot = path.resolve(__dirname, '..', '..');
const sourcePath = path.join(repoRoot, 'web/src/components/admin/AdminActivityUpdatePanel.vue');
const tempRoot = fs.realpathSync(os.tmpdir());
const inside = (target, base) => target === base || target.startsWith(base + path.sep);
assert.equal(inside(tempRoot, fs.realpathSync(repoRoot)), false);
const fixturePrefix = path.resolve(tempRoot, 'farm-activity-display-');
assert.equal(inside(fixturePrefix, tempRoot), true, '创建前校验夹具目标边界');
const privateDir = path.resolve(fs.mkdtempSync(fixturePrefix));
assert.equal(inside(privateDir, tempRoot), true);
process.env.FARM_DATA_DIR = privateDir;
function fingerprint() {
  return {
    mode: fs.statSync(sourcePath).mode,
    sha256: crypto.createHash('sha256').update(fs.readFileSync(sourcePath)).digest('hex'),
  };
}
const before = fingerprint();
const modules = path.join(repoRoot, 'web/node_modules');
const vue = require(path.join(modules, 'vue'));
const pinia = require(path.join(modules, 'pinia'));
const compiler = require(path.join(modules, 'vue/compiler-sfc'));
const ts = require(path.join(modules, 'typescript'));
const source = fs.readFileSync(sourcePath, 'utf8');
const parsed = compiler.parse(source, { filename: sourcePath });
assert.deepEqual(parsed.errors, []);
const script = compiler.compileScript(parsed.descriptor, { id: 'activity-evolution-display', inlineTemplate: true });
const compiled = ts.transpileModule(script.content, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ESNext },
}).outputText;

const node = tag => ({ tag, parent: null, children: [], text: '', props: {}, listeners: {}, addEventListener(event, handler) { this.listeners[event] = handler; } });
globalThis.document = { activeElement: null };
const { render } = vue.createRenderer({
  createElement: node,
  createText: text => ({ ...node('text'), text }),
  createComment: () => node('comment'),
  setText: (el, text) => { el.text = text; },
  setElementText: (el, text) => { el.text = text; el.children.length = 0; },
  patchProp: (el, key, _previous, value) => { el.props[key] = value; },
  parentNode: el => el.parent,
  nextSibling: (el) => {
    const siblings = el.parent?.children || [];
    return siblings[siblings.indexOf(el) + 1] || null;
  },
  insert: (el, parent, anchor) => {
    if (el.parent) {
      const index = el.parent.children.indexOf(el);
      if (index >= 0)
        el.parent.children.splice(index, 1);
    }
    const index = anchor ? parent.children.indexOf(anchor) : -1;
    parent.children.splice(index >= 0 ? index : parent.children.length, 0, el);
    el.parent = parent;
  },
  remove: (el) => {
    if (el?.parent) {
      const index = el.parent.children.indexOf(el);
      if (index >= 0)
        el.parent.children.splice(index, 1);
      el.parent = null;
    }
  },
});
const textOf = el => (el.text || '') + el.children.map(textOf).join('');
const mounted = new Set();
test.after(() => {
  try {
    for (const root of mounted)
      render(null, root);
    mounted.clear();
    assert.deepEqual(fingerprint(), before, '成功与失败收尾均核对源码内容与权限');
  }
  finally {
    assert.equal(inside(path.resolve(privateDir), tempRoot), true, '删除夹具前确认边界');
    fs.rmSync(privateDir, { recursive: true, force: true });
  }
});

function mountPanel(state) {
  const calls = { reads: 0, writes: 0, starts: 0, stops: 0, settled: false };
  const evolve = vue.ref(null);
  const useEvolutionStore = pinia.defineStore('evolution', () => ({
    evolve,
    loadStatus: async () => {
      calls.reads += 1;
      await Promise.resolve();
      evolve.value = state;
      calls.settled = true;
      return { ok: true, evolve: state };
    },
    syncEvolve: value => { evolve.value = value; },
    startPolling: () => { calls.starts += 1; },
    stopPolling: () => { calls.stops += 1; },
  }));
  pinia.setActivePinia(pinia.createPinia());
  const mod = { exports: {} };
  vm.compileFunction(compiled, ['require', 'module', 'exports'])(spec => {
    if (spec === 'vue')
      return vue;
    if (spec === 'pinia')
      return pinia;
    if (spec === '@/stores/evolution')
      return { useEvolutionStore };
    if (spec === '@/stores/toast')
      return { useToastStore: () => ({ success() {}, warning() {} }) };
    if (spec === '@/api')
      return { default: { post: async () => { calls.writes += 1; throw new Error('展示不得写入'); } }, __esModule: true };
    if (spec === '@/components/ui/BaseButton.vue')
      return { default: { render: () => null }, __esModule: true };
    throw new Error(`未隔离的依赖: ${spec}`);
  }, mod, mod.exports);
  const root = node('root');
  mounted.add(root);
  render(vue.h(mod.exports.default), root);
  return { root, calls, evolve };
}

async function settled(h) {
  await new Promise(resolve => setImmediate(resolve));
  await vue.nextTick();
  assert.equal(h.calls.settled, true, '等待真实状态响应落地后断言');
  assert.equal(h.calls.reads, 1);
  assert.equal(h.calls.writes, 0);
}
function unmount(h) {
  render(null, h.root);
  mounted.delete(h.root);
  assert.equal(h.calls.starts, 1);
  assert.equal(h.calls.stops, 1);
}

test('后续综合巡检日期优先于九月独立活动轮，并准确注明两者来源', async () => {
  const h = mountPanel({ status: 'no_change', lastTask: 'safety', lastEvolveDate: '2026-09-24', lastActivityReviewDate: '2026-10-09' });
  await settled(h);
  assert.match(textOf(h.root), /最近完成：2026-10-09\s*（综合巡检含活动复核）/);
  assert.match(textOf(h.root), /上次独立活动进化：2026-09-24/);
  unmount(h);
});

test('更新的独立活动完成日优先，不能被更旧综合巡检覆盖', async () => {
  const h = mountPanel({ status: 'applied', lastTask: 'activity', lastEvolveDate: '2026-10-09', lastActivityReviewDate: '2026-10-08' });
  await settled(h);
  assert.match(textOf(h.root), /最近完成：2026-10-09\s*（独立活动进化）/);
  assert.doesNotMatch(textOf(h.root), /综合巡检含活动复核|上次独立活动进化/);
  unmount(h);
});

test('进行中或验收失败的独立活动启动日不冒充完成，保留最近真实综合复核', async () => {
  for (const status of ['running', 'review_blocked', 'failed']) {
    const h = mountPanel({ status, lastTask: 'activity', lastEvolveDate: '2026-10-10', lastActivityReviewDate: '2026-10-09' });
    await settled(h);
    assert.match(textOf(h.root), /最近完成：2026-10-09\s*（综合巡检含活动复核）/);
    assert.doesNotMatch(textOf(h.root), /2026-10-10/);
    unmount(h);
  }
});

test('没有合法完成日期时显示尚未完成，空值和不合法日期不伪造记录', async () => {
  for (const state of [
    { status: 'idle', lastEvolveDate: '', lastActivityReviewDate: '' },
    { status: 'no_change', lastTask: 'safety', lastEvolveDate: '2026-99-99', lastActivityReviewDate: '2026-02-30' },
    { status: 'running', lastTask: 'activity', lastEvolveDate: '2026-10-09', lastActivityReviewDate: '' },
  ]) {
    const h = mountPanel(state);
    await settled(h);
    assert.match(textOf(h.root), /最近完成：尚未完成/);
    assert.doesNotMatch(textOf(h.root), /综合巡检含活动复核|独立活动进化）|1970-/);
    unmount(h);
  }
});

test('共享状态收到新的完成日后立即更新真实面板，不触发额外读取或写入', async () => {
  const h = mountPanel({ status: 'applied', lastTask: 'activity', lastEvolveDate: '2026-09-24' });
  await settled(h);
  assert.match(textOf(h.root), /最近完成：2026-09-24\s*（独立活动进化）/);
  h.evolve.value = { status: 'no_change', lastTask: 'safety', lastEvolveDate: '2026-09-24', lastActivityReviewDate: '2026-10-09' };
  await vue.nextTick();
  assert.match(textOf(h.root), /最近完成：2026-10-09\s*（综合巡检含活动复核）/);
  assert.equal(h.calls.reads, 1, '展示更新复用共享状态，不另行探测');
  assert.equal(h.calls.writes, 0);
  unmount(h);
});
