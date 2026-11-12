const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const web = path.resolve(__dirname, '../../web');
const vue = require(path.join(web, 'node_modules/vue'));
const compiler = require(path.join(web, 'node_modules/vue/compiler-sfc'));
const ts = require(path.join(web, 'node_modules/typescript'));

function node(tag, text = '') { return { tag, text, children: [], props: {}, parent: null }; }
function textOf(value) { return value.text + value.children.map(textOf).join(''); }
function find(value, predicate) { return predicate(value) ? value : value.children.map(child => find(child, predicate)).find(Boolean); }
const renderer = vue.createRenderer({
  createElement: tag => node(tag), createText: text => node('text', text), createComment: () => node('comment'),
  setText: (value, text) => { value.text = text; }, setElementText: (value, text) => { value.text = text; value.children = []; },
  parentNode: value => value.parent, nextSibling: () => null,
  insert: (child, parent, anchor) => { child.parent = parent; const index = parent.children.indexOf(anchor); parent.children.splice(index < 0 ? parent.children.length : index, 0, child); },
  remove: value => { if (value.parent) value.parent.children = value.parent.children.filter(child => child !== value); },
  patchProp: (value, key, previous, next) => { value.props[key] = next; },
});

test('真实账号弹窗呈现萌卡NT入口、专用地址和启动策略；复制地址不发取码或登录请求', async (t) => {
  const requests = [];
  const copies = [];
  let copyError = false;
  const wx = vue.reactive({ config: {}, resetState() {}, getQRCode() { assert.fail('NT页不应触发微信扫码'); } });
  const stub = { __esModule: true, default: { setup: (_, ctx) => () => vue.h('div', {}, ctx.slots.default?.()) } };
  const globals = { window: { location: { origin: 'fixture-origin' } },
    localStorage: { getItem: () => null }, navigator: { clipboard: { writeText: async value => { if (copyError) throw new Error('fixture clipboard denied'); copies.push(value); } } } };
  const load = file => {
    const { descriptor } = compiler.parse(fs.readFileSync(file, 'utf8'), { filename: file });
    const source = compiler.compileScript(descriptor, { id: path.basename(file), inlineTemplate: true }).content;
    const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ESNext } }).outputText;
    const module = { exports: {} };
    vm.compileFunction(code, ['require', 'module', 'exports', ...Object.keys(globals)])(name => {
      if (name === 'vue') return vue;
      if (name === '@vueuse/core') return { useIntervalFn: () => ({ pause() {}, resume() {} }) };
      if (name === '@/api') return { __esModule: true, default: { get: async url => { requests.push(url); return { data: { ok: true, enabled: false } }; } } };
      if (name === '@/stores/wx-login') return { useWxLoginStore: () => wx };
      if (name === '@/utils/gateway-url') return { parseManualLoginInput: () => ({}) };
      if (name.startsWith('@/components/ui/')) return stub;
      if (name === '@/components/MengkaNtLoginGuide.vue') return { __esModule: true, default: load(path.join(web, 'src/components/MengkaNtLoginGuide.vue')) };
      throw new Error(`Unexpected UI import: ${name}`);
    }, module, module.exports, ...Object.values(globals));
    return module.exports.default;
  };
  const Modal = load(path.join(web, 'src/components/AccountModal.vue'));
  const root = node('root');
  renderer.render(vue.h(Modal, { show: true, initialTab: 'mengka_nt' }), root);
  t.after(() => renderer.render(null, root));
  await vue.nextTick();
  assert.match(textOf(root), /萌卡 NT/);
  assert.match(textOf(root), /不是 QQ 密码/);
  assert.match(textOf(root), /手动停止的账号不会被推送拉起/);
  const address = find(root, value => value.tag === 'input');
  assert.equal(address.props.value, '', 'private deployment address is absent from the default input value');
  assert.doesNotMatch(textOf(root), /fixture-origin/);
  assert.match(textOf(root), /请勿放进公开反馈、截图或文档/);
  const reveal = find(root, value => value.tag === 'button' && textOf(value).trim() === '显示地址');
  assert.equal(reveal.props['aria-pressed'], false);
  reveal.props.onClick();
  await vue.nextTick();
  assert.equal(address.props.value, 'fixture-origin/mengka-nt');
  assert.equal(reveal.props['aria-pressed'], true);
  reveal.props.onClick();
  await vue.nextTick();
  assert.equal(address.props.value, '', 'explicit hide removes the displayed address again');
  const copy = find(root, value => value.tag === 'button' && textOf(value).trim() === '复制服务器地址');
  assert.ok(copy, '实际渲染的复制按钮必须可操作');
  await copy.props.onClick();
  await vue.nextTick();
  assert.deepEqual(copies, ['fixture-origin/mengka-nt']);
  assert.equal(address.props.value, '', 'copying never reveals the address in the page');
  assert.match(textOf(root), /已复制服务器地址/);
  copyError = true;
  await copy.props.onClick();
  await vue.nextTick();
  assert.equal(address.props.value, '', 'clipboard rejection does not expose the private address');
  assert.match(textOf(root), /请先点击“显示地址”后手动复制/);
  assert.equal(copies.length, 1);
  assert.ok(requests.every(url => url === '/api/capture/config'));
  reveal.props.onClick();
  await vue.nextTick();
  renderer.render(null, root);
  renderer.render(vue.h(Modal, { show: true, initialTab: 'mengka_nt' }), root);
  await vue.nextTick();
  assert.equal(find(root, value => value.tag === 'input').props.value, '', 'reopening starts private again');
});
