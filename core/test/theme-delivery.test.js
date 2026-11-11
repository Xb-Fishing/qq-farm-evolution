const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

// Isolate before loading any project module. These tests never contact an API.
const temporaryParent = fs.realpathSync(os.tmpdir());
const prefix = path.resolve(temporaryParent, 'farm-theme-delivery-');
assert.equal(path.dirname(prefix), temporaryParent);
const dataDir = fs.mkdtempSync(prefix);
process.env.FARM_DATA_DIR = dataDir;
process.env.FARM_PRIVATE_CONFIG_FILE = path.join(dataDir, 'none.json');
test.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
const web = path.resolve(__dirname, '../../web');
const vue = require(path.join(web, 'node_modules/vue'));
const pinia = require(path.join(web, 'node_modules/pinia'));
const compiler = require(path.join(web, 'node_modules/vue/compiler-sfc'));
const ts = require(path.join(web, 'node_modules/typescript'));

function harness(saved, options = {}) {
  const storage = new Map(saved === undefined ? [] : [['ui_theme', saved]]);
  const styles = new Map();
  const classes = new Set();
  const calls = [];
  const document = { activeElement: null, documentElement: {
    style: { setProperty: (key, value) => styles.set(key, value) },
    classList: { toggle: (key, on) => on ? classes.add(key) : classes.delete(key) },
  } };
  const localStorage = {
    getItem: key => { if (options.blockStorage) throw new Error('storage blocked'); return storage.get(key) ?? null; },
    setItem: (key, value) => { if (options.blockStorage) throw new Error('storage blocked'); storage.set(key, value); },
  };
  const modules = new Map();
  const api = { get: url => { calls.push(url); return options.get ? options.get(url) : Promise.resolve({ data: { ok: true, data: {} } }); } };
  const evaluate = (source, filename) => {
    const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ESNext } }).outputText;
    const module = { exports: {} };
    vm.compileFunction(code, ['require', 'module', 'exports', 'document', 'localStorage'])(resolve, module, module.exports, document, localStorage);
    return module.exports;
  };
  const load = (filename) => {
    if (modules.has(filename)) return modules.get(filename);
    const source = fs.readFileSync(filename, 'utf8');
    let result;
    if (filename.endsWith('.vue')) {
      const { descriptor, errors } = compiler.parse(source, { filename });
      assert.deepEqual(errors, []);
      const script = compiler.compileScript(descriptor, { id: path.basename(filename), inlineTemplate: true });
      result = evaluate(script.content, filename);
    } else result = evaluate(source, filename);
    modules.set(filename, result);
    return result;
  };
  const resolve = name => {
    if (name === 'vue') return vue;
    if (name === 'pinia') return pinia;
    if (name === '@/api') return { __esModule: true, default: api };
    if (name.startsWith('@/')) {
      const filename = path.join(web, 'src', name.slice(2));
      return load(filename.endsWith('.vue') ? filename : `${filename}.ts`);
    }
    throw new Error(`Unexpected theme dependency: ${name}`);
  };
  const themes = load(path.join(web, 'src/utils/theme.ts'));
  pinia.setActivePinia(pinia.createPinia());
  const store = load(path.join(web, 'src/stores/app.ts')).useAppStore();
  return { storage, styles, classes, document, calls, themes, store, load };
}

test('首屏、store和非法缓存统一默认蓝，保留全部八个已有主题ID', () => {
  const h = harness();
  assert.equal(h.store.currentTheme, 'light-blue');
  assert.equal(h.themes.DEFAULT_THEME, 'light-blue');
  assert.equal(h.styles.get('--theme-primary'), h.themes.THEMES['light-blue'].primary);
  assert.equal(Object.keys(h.themes.THEMES).length, 8);
  for (const invalid of ['unknown', '__proto__', 'constructor']) {
    const invalidTheme = harness(invalid);
    assert.equal(invalidTheme.store.currentTheme, 'light-blue');
    assert.equal(invalidTheme.themes.isTheme(invalid), false);
    assert.equal(invalidTheme.classes.has('dark'), false);
  }
  const main = fs.readFileSync(path.join(web, 'src/main.ts'), 'utf8');
  assert.match(main, /applyThemeToDocument\(readSavedTheme\(\) \|\| DEFAULT_THEME\)/);
  assert.doesNotMatch(main, /const themes:/);
});

test('八款主题实际恢复DOM变量和明暗模式，已有选择不被服务器覆盖', async () => {
  const keys = Object.keys(harness().themes.THEMES);
  for (const key of keys) {
    const h = harness(key);
    const theme = h.themes.THEMES[key];
    assert.equal(h.store.currentTheme, key);
    assert.equal(h.classes.has('dark'), theme.isDark);
    assert.equal(h.document.documentElement.style.colorScheme, theme.isDark ? 'dark' : 'light');
    assert.equal(h.styles.get('--theme-bg'), theme.bg);
    assert.equal(h.styles.get('--theme-gradient'), theme.gradient);
    await h.store.fetchTheme();
    assert.equal(h.calls.length, 0, '本地已有合法主题时不拿服务器旧设置覆盖');
  }
});

test('明暗切换确实跨模式，并保留用户最近选择的日间/夜间配色', async () => {
  const h = harness('light-green');
  h.store.toggleDark();
  assert.equal(h.store.currentTheme, 'dark-teal');
  assert.equal(h.store.isDark, true);
  h.store.applyTheme('dark-purple');
  h.store.toggleDark();
  assert.equal(h.store.currentTheme, 'light-green');
  h.store.toggleDark();
  assert.equal(h.store.currentTheme, 'dark-purple');
  await vue.nextTick();
  assert.equal(h.storage.get('ui_theme'), 'dark-purple');
});

test('设置请求迟到或并发旧响应不覆盖新选择，包括再次选择当前默认色', async () => {
  let resolve;
  const h = harness(undefined, { get: () => new Promise(done => { resolve = done; }) });
  const request = h.store.fetchTheme();
  h.store.applyTheme('light-blue');
  resolve({ data: { ok: true, data: { ui: { theme: 'dark-red' } } } });
  await request;
  assert.equal(h.store.currentTheme, 'light-blue');
  assert.equal(h.classes.has('dark'), false);

  const pending = [];
  const concurrent = harness(undefined, { get: () => new Promise(done => pending.push(done)) });
  const first = concurrent.store.fetchTheme();
  const second = concurrent.store.fetchTheme();
  pending[1]({ data: { ok: true, data: { ui: { theme: 'dark-purple' } } } });
  await second;
  pending[0]({ data: { ok: true, data: { ui: { theme: 'light-pink' } } } });
  await first;
  assert.equal(concurrent.store.currentTheme, 'dark-purple');
});

test('存储拒绝/设置读取失败时仍可使用主题，未知服务器值不能污染DOM', async () => {
  const h = harness(undefined, { blockStorage: true, get: async () => { throw new Error('offline'); } });
  await h.store.fetchTheme();
  h.store.applyTheme('dark-blue');
  assert.equal(h.store.isDark, true);
  const unknown = harness(undefined, { get: async () => ({ data: { ok: true, data: { ui: { theme: '__proto__' } } } }) });
  await unknown.store.fetchTheme();
  assert.equal(unknown.store.currentTheme, 'light-blue');
});

function luminance(hex) {
  const channels = hex.slice(1).match(/../g).map(channel => Number.parseInt(channel, 16) / 255)
    .map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722;
}
function contrast(a, b) {
  const first = luminance(a), second = luminance(b);
  return (Math.max(first, second) + .05) / (Math.min(first, second) + .05);
}

test('色板正文、强调色和主按钮渐变端点具有可读对比度', () => {
  const h = harness();
  for (const [key, theme] of Object.entries(h.themes.THEMES)) {
    assert.ok(contrast(theme.bg, theme.text) >= 7, `${key}正文`);
    assert.ok(contrast(theme.bg, theme.primary) >= 4.5, `${key}强调色`);
    for (const color of theme.gradient.match(/#[a-f\d]{6}/g))
      assert.ok(contrast(color, '#ffffff') >= 4.5, `${key}按钮`);
  }
});

function mount(h, component) {
  const makeNode = (tag, text = '') => vue.markRaw({ tag, text, children: [], props: {}, parent: null,
    focus() { h.document.activeElement = this; },
    querySelectorAll(selector) {
      const nodes = [];
      const visit = value => {
        const match = value.tag === 'button' && (selector === 'button'
          || (selector === 'button[data-theme]' && value.props['data-theme'])
          || (selector === 'button[aria-pressed="true"]' && value.props['aria-pressed'] === true));
        if (match) nodes.push(value);
        for (const child of value.children) visit(child);
      };
      visit(this);
      return nodes;
    },
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; },
  });
  const body = makeNode('body');
  const root = makeNode('root');
  const renderer = vue.createRenderer({
    createElement: tag => makeNode(tag), createText: text => makeNode('text', text), createComment: () => makeNode('comment'),
    setText: (node, text) => { node.text = text; }, setElementText: (node, text) => { node.text = text; node.children = []; },
    parentNode: node => node.parent,
    nextSibling: node => node.parent?.children[node.parent.children.indexOf(node) + 1] || null,
    querySelector: selector => selector === 'body' ? body : null,
    insert: (child, parent, anchor) => {
      if (child.parent) child.parent.children = child.parent.children.filter(item => item !== child);
      child.parent = parent;
      const index = parent.children.indexOf(anchor);
      parent.children.splice(index < 0 ? parent.children.length : index, 0, child);
    },
    remove: node => { if (node.parent) node.parent.children = node.parent.children.filter(child => child !== node); },
    patchProp: (node, key, previous, next) => { node.props[key] = next; },
  });
  renderer.render(vue.h(component), root);
  return { root, body, unmount: () => renderer.render(null, root) };
}
function textOf(node) { return node.text + node.children.map(textOf).join(''); }
function find(node, predicate) { return predicate(node) ? node : node.children.map(child => find(child, predicate)).find(Boolean); }
function dispatch(node, event, data = {}) {
  const callbacks = Array.isArray(node.props[event]) ? node.props[event] : [node.props[event]];
  for (const callback of callbacks) if (callback) callback(data);
}

test('真实主题弹窗：八款分组预览、当前焦点、键盘换焦点、选择与Esc返回触发器', async (t) => {
  const h = harness('light-green');
  const component = h.load(path.join(web, 'src/components/ThemeToggle.vue')).default;
  const mounted = mount(h, component);
  t.after(mounted.unmount);
  const trigger = find(mounted.root, node => node.tag === 'button');
  dispatch(trigger, 'onClick');
  await vue.nextTick();
  assert.match(textOf(mounted.body), /日间 · 清爽明亮/);
  assert.match(textOf(mounted.body), /夜间 · 柔和护眼/);
  assert.equal(mounted.body.querySelectorAll('button[data-theme]').length, 8);
  assert.equal(h.document.activeElement.props['data-theme'], 'light-green');
  const dialog = find(mounted.body, node => node.props.role === 'dialog');
  const buttons = dialog.querySelectorAll('button');
  buttons[0].focus();
  dispatch(dialog, 'onKeydown', { key: 'Tab', shiftKey: true, preventDefault() {}, stopPropagation() {} });
  assert.equal(h.document.activeElement, buttons.at(-1));
  dispatch(dialog, 'onKeydown', { key: 'Tab', shiftKey: false, preventDefault() {}, stopPropagation() {} });
  assert.equal(h.document.activeElement, buttons[0]);
  const palette = find(mounted.body, node => node.props['aria-label'] === '界面主题');
  dispatch(palette, 'onKeydown', { key: 'End', preventDefault() {}, stopPropagation() {} });
  assert.equal(h.document.activeElement.props['data-theme'], 'dark-red');
  dispatch(h.document.activeElement, 'onClick');
  await vue.nextTick();
  assert.equal(h.store.currentTheme, 'dark-red');
  assert.equal(textOf(mounted.body), '');
  assert.equal(h.document.activeElement, trigger);
  dispatch(trigger, 'onClick');
  await vue.nextTick();
  const reopened = find(mounted.body, node => node.props['aria-label'] === '界面主题');
  dispatch(reopened, 'onKeydown', { key: 'Escape', preventDefault() {}, stopPropagation() {} });
  await vue.nextTick();
  assert.equal(textOf(mounted.body), '');
  assert.equal(h.document.activeElement, trigger);
});
