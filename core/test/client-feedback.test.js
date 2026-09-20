const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const webRequire = createRequire(path.resolve(__dirname, '../../web/package.json'));
const ts = webRequire('typescript');

function fixture() {
  const listeners = {};
  const timers = new Map();
  const sent = [];
  let time = 100000;
  let timerId = 0;
  let status = 200;
  const storage = new Map([['admin_token', 'test-session']]);
  class Element {
    constructor(tag = 'BUTTON') { this.tagName = tag; }
    closest() { return this; }
    hasAttribute() { return false; }
    getAttribute() { return null; }
  }
  const window = { location: { pathname: '/friends/private-name' }, addEventListener: (key, fn) => { listeners[key] = fn; } };
  const document = { visibilityState: 'visible', addEventListener: (key, fn) => { listeners[key] = fn; } };
  const globals = { window, document, Element, Uint8Array, AbortController,
    crypto: require('node:crypto').webcrypto,
    Date: { now: () => time },
    localStorage: { getItem: key => storage.get(key) || null },
    setTimeout: fn => { const id = ++timerId; timers.set(id, fn); return id; },
    clearTimeout: id => timers.delete(id),
    fetch: async (url, config) => { sent.push({ url, config }); return { ok: status === 200, status }; },
  };
  function load(file, imports = {}) {
    const output = ts.transpileModule(fs.readFileSync(path.resolve(__dirname, '../../web/src', file), 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const module = { exports: {} };
    vm.runInNewContext(output, { ...globals, exports: module.exports, module,
      require: name => { if (!(name in imports)) throw new Error('Unexpected import'); return imports[name]; },
    }, { filename: file });
    return module.exports;
  }
  const feedback = load('utils/daily-feedback.ts');
  return { feedback, listeners, sent, timers, storage, load,
    click: () => listeners.click({ target: new Element() }),
    advance: ms => { time += ms; }, fail: () => { status = 503; } };
}

test('真实前端收集器只上传点击类别和随机关联号，不收集页面参数或元素文本', async () => {
  const f = fixture();
  f.feedback.installDailyFeedback();
  f.click();
  const trace = f.feedback.currentFeedbackTrace();
  assert.match(trace, /^[a-f\d-]{36}$/);
  await f.feedback.flushFeedback();
  assert.equal(f.sent.length, 1);
  const events = JSON.parse(f.sent[0].config.body).events;
  assert.deepEqual(events, [{ kind: 'click', page: 'friends', target: 'button', trace }]);
  assert.doesNotMatch(f.sent[0].config.body, /private-name|test-session|token|password/);
  assert.equal(f.sent[0].config.headers['x-admin-token'], 'test-session');
  f.advance(5001);
  assert.equal(f.feedback.currentFeedbackTrace(), '');
});

test('真实 Axios 入口将点击关联号交给后端，网络错误产生固定类别反馈', async () => {
  const f = fixture();
  f.feedback.installDailyFeedback();
  f.click();
  const toast = { error() {}, warning() {} };
  const api = f.load('api/index.ts', {
    '@vueuse/core': { useStorage: () => ({ value: 'test-session' }) },
    'axios': { __esModule: true, default: webRequire('axios') },
    '@/stores/toast': { useToastStore: () => toast },
    '@/utils/daily-feedback': f.feedback,
  }).default;
  let trace;
  api.defaults.adapter = async (config) => {
    trace = config.headers['x-feedback-id'];
    return { data: { ok: true }, status: 200, statusText: 'OK', config, headers: {} };
  };
  await api.get('/api/friends');
  assert.equal(trace, f.feedback.currentFeedbackTrace());
  api.defaults.adapter = async () => { throw Object.assign(new Error('private-response'), { request: {}, code: 'ECONNABORTED' }); };
  await assert.rejects(api.get('/api/friends'));
  await f.feedback.flushFeedback();
  const events = JSON.parse(f.sent[0].config.body).events;
  assert.ok(events.some(row => row.category === 'request_timeout' && row.trace === trace));
  assert.doesNotMatch(f.sent[0].config.body, /private-response/);
});

test('上报失败不递归或重试风暴，后续交互重送；登出后不收集', async () => {
  const f = fixture();
  f.feedback.installDailyFeedback();
  f.fail();
  f.click();
  await f.feedback.flushFeedback();
  assert.equal(f.sent.length, 1);
  f.advance(1000);
  f.click();
  await f.feedback.flushFeedback();
  assert.equal(f.sent.length, 2);
  assert.equal(JSON.parse(f.sent[1].config.body).events.length, 2);
  f.storage.clear();
  f.click();
  await f.feedback.flushFeedback();
  assert.equal(f.sent.length, 2);
});
