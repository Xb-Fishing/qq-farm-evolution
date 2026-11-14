const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const crypto = require('node:crypto');
const prefix = path.resolve(os.tmpdir(), 'farm-update-log-ui-');
assert.equal(path.dirname(prefix), path.resolve(os.tmpdir()));
const temporary = fs.mkdtempSync(prefix);
process.env.FARM_DATA_DIR = temporary;
const root = path.resolve(__dirname, '../..');
const modules = path.join(root, 'web/node_modules');
const vue = require(path.join(modules, 'vue'));
const compiler = require(path.join(modules, 'vue/compiler-sfc'));
const ts = require(path.join(modules, 'typescript'));
const marked = require(path.join(modules, 'marked'));
const componentFile = path.join(root, 'web/src/components/login/UpdateLogModal.vue');
const utilityFile = path.join(root, 'web/src/utils/update-log.ts');
const docFile = path.join(root, 'docs/CHANGELOG.md');
const fingerprint = () => [componentFile, utilityFile, docFile, __filename].map(file => ({ file,
  mode: fs.statSync(file).mode & 0o777, hash: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') }));
const before = fingerprint();
function evaluate(source, deps, globals = {}) {
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ESNext } }).outputText;
  const module = { exports: {} };
  vm.compileFunction(code, ['require', 'module', 'exports', ...Object.keys(globals)])(name => {
    assert.ok(Object.hasOwn(deps, name), name); return deps[name];
  }, module, module.exports, ...Object.values(globals));
  return module.exports;
}
const utility = evaluate(fs.readFileSync(utilityFile, 'utf8'), { marked });
const parsed = compiler.parse(fs.readFileSync(componentFile, 'utf8'), { filename: componentFile });
assert.deepEqual(parsed.errors, []);
const source = compiler.compileScript(parsed.descriptor, { id: 'update-log-test', inlineTemplate: true }).content;
const node = tag => ({ tag, parent: null, children: [], text: '', props: {} });
const body = node('body');
const renderer = vue.createRenderer({
  createElement: node, createText: text => ({ ...node('text'), text }), createComment: () => node('comment'),
  setText: (el, text) => { el.text = text; }, setElementText: (el, text) => { el.text = text; el.children = []; },
  patchProp: (el, key, _prior, next) => { el.props[key] = next; }, parentNode: el => el.parent,
  nextSibling: el => { const items = el.parent?.children || []; return items[items.indexOf(el) + 1] || null; },
  insert: (el, parent, anchor) => {
    if (el.parent) el.parent.children.splice(el.parent.children.indexOf(el), 1);
    const index = anchor ? parent.children.indexOf(anchor) : -1;
    if (index < 0) parent.children.push(el); else parent.children.splice(index, 0, el);
    el.parent = parent;
  },
  remove: el => { if (el.parent) el.parent.children.splice(el.parent.children.indexOf(el), 1); el.parent = null; },
  querySelector: selector => selector === 'body' ? body : null,
});
const mounted = new Set();
test.after(() => {
  for (const root of mounted) renderer.render(null, root);
  fs.rmSync(temporary, { recursive: true, force: true });
  assert.deepEqual(fingerprint(), before);
});
function findHtml(el) { return [el.props.innerHTML || '', ...el.children.map(findHtml)].join(''); }
function mount(document) {
  const listeners = new Map(); let closed = 0;
  const component = evaluate(source, { vue, '@/stores/app': { useAppStore: () => ({ loginPageConfig: { title: '示例农场' } }) },
    '@/utils/update-log': utility, '../../../../docs/CHANGELOG.md?raw': { default: document, __esModule: true } }, {
    window: { addEventListener: (name, callback) => listeners.set(name, callback),
      removeEventListener: (name, callback) => { if (listeners.get(name) === callback) listeners.delete(name); } },
  }).default;
  const root = node('root'); mounted.add(root);
  renderer.render(vue.h(component, { show: true, onClose: () => { closed += 1; } }), root);
  return { html: () => findHtml(body), listeners, escape: () => listeners.get('keydown')?.({ key: 'Escape' }),
    get closed() { return closed; }, unmount: () => { renderer.render(null, root); mounted.delete(root); } };
}

test('真实弹窗显示当前功能及历史详细记录，省略旧流水图和固定空态', () => {
  const h = mount(fs.readFileSync(docFile, 'utf8'));
  assert.match(h.html(), /微信凭据与更新保护/);
  assert.match(h.html(), /默认方案与奶茶雇佣空位/);
  assert.match(h.html(), /程序版本更新/);
  assert.match(h.html(), /奶茶批量制作/);
  assert.doesNotMatch(h.html(), /暂无更新日志|flowchart TB/);
  h.escape(); assert.equal(h.closed, 1);
  h.unmount(); assert.equal(h.listeners.size, 0);
});

test('弹窗读取同一份文档内容，后续记录无需再维护第二份列表', () => {
  const h = mount('## 详细记录\n\n### 合成更新条目\n\n新增的示例功能。');
  assert.match(h.html(), /合成更新条目/);
  assert.match(h.html(), /新增的示例功能/);
  h.unmount();
});

test('记录渲染保留安全链接并拒绝原始HTML、脚本链接和自动远程图片', () => {
  const html = utility.renderUpdateLog('## 详细记录\n\n<script>bad()</script>\n\n[错误](javascript:bad) [说明](../README.md) ![示例](//invalid/image)\n\n<img src=x onerror=bad()>');
  assert.doesNotMatch(html, /<script|javascript:|onerror|<img/);
  assert.match(html, /href="\.\.\/README.md"/);
  assert.match(html, /rel="noopener noreferrer"/);
});
