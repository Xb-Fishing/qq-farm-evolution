const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const Module = require('node:module');

const repo = path.resolve(__dirname, '../..');
const tmp = fs.realpathSync(os.tmpdir());
assert.ok(tmp !== repo && !tmp.startsWith(repo + path.sep));
const dataDir = fs.mkdtempSync(path.join(tmp, 'farm-sweet-potato-fixture-'));
process.env.FARM_DATA_DIR = dataDir;
after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

const network = require('../src/utils/network');
let send;
const originalSend = network.sendMsgAsync;
network.sendMsgAsync = (...args) => {
  assert.equal(typeof send, 'function', 'test must stub every network request');
  return send(...args);
};
const service = require('../src/services/activity');
network.sendMsgAsync = originalSend;
const activityRoutes = require.resolve('../src/controllers/admin-activity-routes');
const originalModuleLoad = Module._load;
let registerAdminActivityRoutes;
try {
  // The optional managed overlay starts recurring jobs when its update routes
  // register. This fixture exercises the production activity routes, with the
  // independent update scheduler outside its scope.
  Module._load = function loadFixtureRoute(request, parent, isMain) {
    if (request === './admin-activity-update-routes' && parent?.filename === activityRoutes) {
      return { registerAdminActivityUpdateRoutes() {} };
    }
    return originalModuleLoad.call(this, request, parent, isMain);
  };
  ({ registerAdminActivityRoutes } = require(activityRoutes));
} finally {
  Module._load = originalModuleLoad;
}
const { createDataProvider } = require('../src/runtime/data-provider');
const { types, loadProto } = require('../src/utils/proto');
before(loadProto);

const START = 1795572000;
const END = 1796831999;
const ROOT = 2026111707;
const MAIN = 2026111708;
const UID = 'YiShuHuanFuMainUI';

function varint(number) {
  let value = BigInt.asUintN(64, BigInt(number));
  const bytes = [];
  while (value >= 128n) {
    bytes.push(Number(value & 127n) + 128);
    value >>= 7n;
  }
  return Buffer.from([...bytes, Number(value)]);
}
const join = (...bytes) => Buffer.concat(bytes);
const integer = (id, value) => join(varint(id * 8), varint(value));
const field = (id, value) => join(varint(id * 8 + 2), varint(value.length), value);
const string = (id, value) => field(id, Buffer.from(value));
const EMPTY = Buffer.alloc(0);

function node({ id, parent = 0, start = START, end = END, uid, children = [], state, visible = true }) {
  const details = join(integer(1, id), parent ? integer(2, parent) : EMPTY, integer(6, start), integer(7, end),
    integer(20, Number(visible)), integer(22, 0), uid ? string(5, JSON.stringify({ uid })) : EMPTY);
  return join(field(1, details), ...children.map(child => field(2, child)),
    state == null ? EMPTY : field(130, state));
}

const rootNode = options => node({ id: ROOT, ...options });
const mainNode = options => node({ id: MAIN, parent: ROOT, uid: UID, ...options });
const groupReply = options => field(1, rootNode({ children: [mainNode(options)] }));
const listReply = field(1, rootNode());
const available = { available: true, status: 'available', personal: { basePrice: 31415 } };

function fakeClock(t, now = START * 1000) {
  const clock = { now };
  t.mock.method(Date, 'now', () => clock.now);
  return clock;
}

function upstream(t, responses) {
  const calls = [];
  send = async (name, method, body, timeout, options) => {
    assert.equal(name, 'gamepb.activitypb.ActivityService');
    assert.ok(calls.length < responses.length, `unexpected ${method} request`);
    const [expected, response] = responses[calls.length];
    calls.push(method);
    assert.equal(method, expected);
    if (method === 'GetGroup') {
      const request = types.ActivityGetGroupRequest.decode(body);
      assert.equal(Number(request.id), ROOT);
      assert.equal(request.uid, '');
      assert.equal(options.breakerExemptBusinessError, true);
    }
    return { body: await (typeof response === 'function' ? response() : response) };
  };
  t.after(() => { send = undefined; });
  assert.equal(typeof service.getSweetPotatoActivity, 'function', '缺少以薯换福只读服务');
  return calls;
}

test('field 130 decodes a natural wire snapshot, including zero and empty claims', async t => {
  fakeClock(t);
  const state = join(field(1, EMPTY), field(2, EMPTY), field(4, Buffer.from([1, 2, 3, 4])),
    integer(5, 21), integer(7, 0));
  const body = groupReply({ state });
  const calls = upstream(t, [['List', listReply], ['GetGroup', body], ['GetGroup', body]]);
  assert.deepEqual(await service.getSweetPotatoActivity(), {
    available: true, status: 'available', startTime: START, endTime: END,
    personal: {
      basePrice: 21, criticalBonus: null, receivedCount: 0, coinBalance: null,
      pendingDividend: null, seedsClaimed: false, shared: false,
    },
  });
  const shared = await service.getActivityGroupSnapshot(ROOT);
  assert.doesNotMatch(JSON.stringify(shared), /sweet_potato|coinBalance|seedsClaimed/);
  assert.ok(shared.discoveryEvidence.protocolShape.some(row => row.path === '1.2.130'));
  assert.deepEqual(calls, ['List', 'GetGroup', 'GetGroup']);
});

test('field 130 preserves presence and rejects unsafe integers without reading private slots', async t => {
  fakeClock(t);
  const state = join(field(1, join(integer(1, 1), integer(2, 1))), integer(3, 0),
    field(4, string(102, 'private fixture')), integer(5, 8), integer(6, Number.MAX_SAFE_INTEGER),
    integer(7, -1), integer(11, 9_007_199_254_740_992n));
  const calls = upstream(t, [
    ['List', listReply], ['GetGroup', groupReply({ state })],
    ['List', listReply], ['GetGroup', groupReply({ state: join(integer(5, 1), integer(11, 3)) })],
    ['List', listReply], ['GetGroup', groupReply({ state: field(4, Buffer.from([1, 2, 3, 4])) })],
    ['List', listReply], ['GetGroup', groupReply({ state: integer(5, Number.MAX_SAFE_INTEGER + 1) })],
    ['List', listReply], ['GetGroup', groupReply({ state: integer(5, 0) })],
    ['List', listReply], ['GetGroup', groupReply({})],
  ]);
  const result = await service.getSweetPotatoActivity();
  assert.deepEqual(result.personal, {
    basePrice: 8, criticalBonus: Number.MAX_SAFE_INTEGER, receivedCount: null, coinBalance: 0,
    pendingDividend: null, seedsClaimed: true, shared: true,
  });
  assert.doesNotMatch(JSON.stringify(result), /private fixture/);
  const partial = await service.getSweetPotatoActivity();
  assert.equal(partial.personal.seedsClaimed, null);
  assert.equal(partial.personal.shared, null);
  assert.equal(partial.personal.pendingDividend, 3);
  for (let i = 0; i < 3; i++) {
    const unknown = await service.getSweetPotatoActivity();
    assert.equal(unknown.status, 'unknown');
    assert.equal(unknown.available, false);
    assert.equal(unknown.personal, null);
  }
  assert.equal((await service.getSweetPotatoActivity()).status, 'unknown');
  assert.equal(calls.length, 12);
});

test('wrong wire types, duplicate fields, invalid claim flags and overflowing prices stay unknown', async t => {
  fakeClock(t);
  const overflow = join(varint(5 * 8), Buffer.from([136, ...Array(8).fill(128), 2]));
  const states = [field(5, integer(8, 0)), overflow, join(integer(5, 8), integer(5, 9)),
    join(integer(5, 8), field(1, integer(1, 2))),
    join(integer(5, 8), field(1, join(integer(2, 0), integer(2, 1))))];
  upstream(t, states.flatMap(state => [['List', listReply], ['GetGroup', groupReply({ state })]]));
  for (const _state of states) {
    const result = await service.getSweetPotatoActivity();
    assert.equal(result.status, 'unknown');
    assert.equal(result.personal, null);
  }
});

test('connection replacement while List is in flight prevents even a valid GetGroup read', async t => {
  fakeClock(t);
  let current = true;
  const calls = upstream(t, [['List', () => { current = false; return listReply; }]]);
  await assert.rejects(service.getSweetPotatoActivity(() => current), /连接已变化/);
  assert.deepEqual(calls, ['List']);
});

test('only current List roots and exact Group identities are accepted; expiry stops List→Group', async t => {
  const clock = fakeClock(t, START * 1000 - 1);
  const state = integer(5, 17);
  const calls = upstream(t, [
    ['List', EMPTY],
    ['List', field(1, rootNode({ start: START - 1 }))],
    ['List', field(1, rootNode({ parent: 123 }))],
    ['List', field(1, rootNode({ visible: false }))],
    ['List', listReply], ['GetGroup', field(1, rootNode({ id: ROOT + 10, children: [mainNode({ state })] }))],
    ['List', listReply], ['GetGroup', groupReply({ parent: ROOT + 1, state })],
    ['List', listReply], ['GetGroup', groupReply({ id: MAIN + 1, state })],
    ['List', listReply], ['GetGroup', groupReply({ uid: 'wrong', state })],
    ['List', listReply], ['GetGroup', groupReply({ end: END + 1, state })],
    ['List', listReply], ['GetGroup', groupReply({ visible: false, state })],
    ['List', listReply], ['GetGroup', field(1, rootNode({ state, children: [mainNode()] }))],
    ['List', () => { clock.now = END * 1000; return listReply; }],
  ]);
  assert.equal((await service.getSweetPotatoActivity()).status, 'unavailable');
  assert.deepEqual(calls, []);
  clock.now = START * 1000;
  for (let i = 0; i < 12; i++) {
    const result = await service.getSweetPotatoActivity();
    assert.equal(result.available, false);
    assert.equal(result.personal, null);
  }
  assert.equal((await service.getSweetPotatoActivity()).reason, '活动已结束');
  assert.equal(calls.length, 19);
});

function deferred() {
  let resolve, reject;
  const promise = new Promise((ok, failed) => { resolve = ok; reject = failed; });
  return { promise, resolve, reject };
}

function routeFixture(provider) {
  const handlers = new Map();
  const posts = new Map();
  const scopes = new Map([['a', 'first'], ['b', 'first']]);
  const calls = { scopes: 0, statuses: 0, reads: [] };
  let load = async () => available;
  let mutate = async () => ({});
  registerAdminActivityRoutes({
    app: {
      get(url, handler) { handlers.set(url, handler); },
      post(url, handler) { posts.set(url, handler); },
    },
    provider: provider || {
      getStatus() { calls.statuses++; return { connection: { connected: true } }; },
      getGamePanelReadScope(id) { calls.scopes++; return scopes.get(id); },
      async getSweetPotatoReadScope() { return 1; },
      getSweetPotatoActivity(id) { calls.reads.push(id); return load(id); },
      runSweetPotatoTrade(...args) { return mutate(...args); },
    },
    getAccountIdFromRequest: req => req.accountId,
    canAccessAccount: req => req.allowed,
    sendProviderError: (res, error) => res.status(500).json({ ok: false, error: error.message }),
    requireAdminToken() {},
  });
  const route = handlers.get('/api/activity/sweet-potato');
  assert.equal(typeof route, 'function', '缺少以薯换福 GET 路由');
  async function get(req = { accountId: 'a', allowed: true }) {
    const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; } };
    await route(req, res);
    return res;
  }
  async function post(action, accountId = 'a') {
    const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; } };
    await posts.get('/api/activity/sweet-potato/trade/:action')({ allowed: true, accountId, params: { action }, body: {} }, res);
    return res;
  }
  return { get, post, calls, scopes, loadWith: fn => { load = fn; }, mutateWith: fn => { mutate = fn; } };
}

test('a trade receipt invalidates only the changed account activity state', async t => {
  fakeClock(t, START * 1000);
  const h = routeFixture();
  let claimed = false;
  h.loadWith(async () => ({ ...available, personal: { ...available.personal, seedsClaimed: claimed } }));
  const accountB = { allowed: true, accountId: 'b' };
  assert.equal((await h.get()).body.activity.personal.seedsClaimed, false);
  assert.equal((await h.get(accountB)).body.activity.personal.seedsClaimed, false);
  h.mutateWith(async () => { claimed = true; return { itemId: 20307, count: 28 }; });
  assert.equal((await h.post('seeds')).body.ok, true);
  assert.equal((await h.get()).body.activity.personal.seedsClaimed, true);
  assert.equal((await h.get(accountB)).body.activity.personal.seedsClaimed, false);
  assert.deepEqual(h.calls.reads, ['a', 'b', 'a']);
});

test('API checks account ownership and window, merges successes and failures per connection', async t => {
  const clock = fakeClock(t, START * 1000 - 1);
  const h = routeFixture();
  assert.equal((await h.get({ accountId: 'a', allowed: false })).statusCode, 403);
  assert.equal((await h.get({ allowed: true })).statusCode, 400);
  assert.equal((await h.get()).body.activity.reason, '活动尚未开放');
  assert.deepEqual(h.calls, { scopes: 0, statuses: 0, reads: [] });

  clock.now = START * 1000;
  h.loadWith(async id => {
    if (id === 'b') throw new Error('fixture failure');
    return available;
  });
  const [first, joined, failure, joinedFailure] = await Promise.all([
    h.get(), h.get(), h.get({ accountId: 'b', allowed: true }), h.get({ accountId: 'b', allowed: true }),
  ]);
  assert.deepEqual(first.body, { ok: true, accountId: 'a', activity: available, upstreamCached: false });
  assert.equal(joined.body.upstreamCached, true);
  assert.equal((await h.get()).body.upstreamCached, true);
  assert.equal(failure.body.error, 'fixture failure');
  assert.deepEqual(joinedFailure.body, failure.body);
  assert.deepEqual((await h.get({ accountId: 'b', allowed: true })).body, failure.body);
  assert.deepEqual(h.calls.reads, ['a', 'b']);
  clock.now += 60_001;
  h.loadWith(async () => ({ available: false, status: 'unknown', personal: null }));
  assert.equal((await h.get({ accountId: 'b', allowed: true })).body.activity.status, 'unknown');
  h.scopes.set('a', 'replacement');
  assert.equal((await h.get()).body.upstreamCached, false);
  assert.deepEqual(h.calls.reads, ['a', 'b', 'b', 'a']);
});

test('API discards results after connection replacement, reassignment and expiry', async t => {
  const clock = fakeClock(t, END * 1000 - 50);
  const h = routeFixture();
  const old = deferred();
  const oldEntered = deferred();
  const req = { accountId: 'a', allowed: true };
  h.loadWith(() => { oldEntered.resolve(); return old.promise; });
  const p = h.get(req);
  await oldEntered.promise;
  h.scopes.set('a', 'replacement');
  old.resolve(available);
  assert.match((await p).body.error, /连接已变化/);

  const ownership = deferred();
  const ownershipEntered = deferred();
  h.loadWith(() => { ownershipEntered.resolve(); return ownership.promise; });
  const q = h.get(req);
  await ownershipEntered.promise;
  req.allowed = false;
  ownership.resolve(available);
  assert.match((await q).body.error, /授权已变化/);

  req.allowed = true;
  const late = deferred();
  const lateEntered = deferred();
  h.loadWith(() => { lateEntered.resolve(); return late.promise; });
  const r = h.get(req);
  await lateEntered.promise;
  clock.now = END * 1000;
  const scopeReads = h.calls.scopes;
  const statusReads = h.calls.statuses;
  assert.equal((await h.get(req)).body.activity.reason, '活动已结束');
  assert.equal(h.calls.scopes, scopeReads);
  assert.equal(h.calls.statuses, statusReads);
  late.resolve(available);
  assert.equal((await r).body.activity.personal, null);
  clock.now = END * 1000 - 1;
  h.loadWith(async () => available);
  assert.equal((await h.get(req)).body.upstreamCached, false, '跨过到期时刻的个人数据没有进入缓存');
  assert.deepEqual(h.calls.reads, ['a', 'a', 'a', 'a']);
});

test('provider forwards the read with room for two network timeouts', async () => {
  const calls = [];
  const provider = createDataProvider({
    getAccounts: () => ({ accounts: [{ id: 'farm-a' }] }),
    callWorkerApi: (...args) => { calls.push(args); return available; },
  });
  assert.equal(typeof provider.getSweetPotatoActivity, 'function');
  assert.equal(await provider.getSweetPotatoReadScope('farm-a'), available);
  assert.equal(await provider.getSweetPotatoActivity('farm-a', 7), available);
  assert.deepEqual(calls[0].slice(0, 2), ['farm-a', 'getSweetPotatoReadScope']);
  assert.deepEqual(calls[1].slice(0, 3), ['farm-a', 'getSweetPotatoActivity', 7]);
  assert.ok(calls[1][3]._timeoutMs > 40_000);
});

test('real admin and Worker path separates cached results by socket inside the same Worker process', async t => {
  fakeClock(t);
  assert.equal(typeof service.getSweetPotatoReadScope, 'function');
  const source = fs.readFileSync(path.join(repo, 'core/src/core/worker.js'), 'utf8');
  const from = source.indexOf('async function handleApiCall');
  const to = source.indexOf('// ==================== 每日礼包总览', from);
  assert.ok(from >= 0 && to > from);
  let socket = { readyState: 1 };
  let serial = 0;
  const replies = new Map();
  const handle = vm.runInNewContext(`${source.slice(from, to)}\nhandleApiCall`, {
    FRIEND_PANEL_ENTRY_METHODS: new Set(),
    BAG_PANEL_ENTRY_METHODS: new Set(),
    isRunning: true,
    loginReady: true,
    getWs: () => socket,
    collectPetDiaryErrorMeta: () => null,
    require: () => service,
    sendToMaster: message => replies.set(message.id, message),
  });
  const worker = { status: { connection: { connected: true } }, process: {} };
  const provider = createDataProvider({
    workers: { a: worker },
    getAccounts: () => ({ accounts: [{ id: 'a', platform: 'wx' }] }),
    buildDefaultStatus: () => ({}),
    normalizeStatusForPanel: status => status,
    async callWorkerApi(account, method, ...args) {
      assert.equal(account, 'a');
      const id = ++serial;
      await handle({ id, method, args: args.slice(0, -1) });
      const reply = replies.get(id);
      replies.delete(id);
      if (reply.error) throw new Error(reply.error);
      return reply.result;
    },
  });
  const h = routeFixture(provider);
  const calls = upstream(t, [
    ['List', listReply], ['GetGroup', groupReply({ state: integer(5, 17) })],
    ['List', () => { throw new Error('old socket failure'); }],
    ['List', listReply], ['GetGroup', groupReply({ state: integer(5, 29) })],
  ]);
  const originalScope = provider.getGamePanelReadScope('a');
  assert.equal((await h.get()).body.activity.personal.basePrice, 17);
  assert.equal((await h.get()).body.upstreamCached, true);
  const first = await provider.getSweetPotatoReadScope('a');
  socket = { readyState: 1 };
  assert.equal(provider.getGamePanelReadScope('a'), originalScope);
  await assert.rejects(provider.getSweetPotatoActivity('a', first), /连接已变化/);
  assert.match((await h.get()).body.error, /old socket failure/);
  assert.match((await h.get()).body.error, /old socket failure/);
  socket = { readyState: 1 };
  const fresh = await h.get();
  assert.equal(fresh.body.activity.personal.basePrice, 29);
  assert.equal(fresh.body.upstreamCached, false);
  assert.deepEqual(calls, ['List', 'GetGroup', 'List', 'List', 'GetGroup']);
});

function mountPanel(t, clock) {
  const modules = path.join(repo, 'web/node_modules');
  const vue = require(path.join(modules, 'vue'));
  const compiler = require(path.join(modules, 'vue/compiler-sfc'));
  const ts = require(path.join(modules, 'typescript'));
  const filename = path.join(repo, 'web/src/components/activity/SweetPotatoActivityPanel.vue');
  assert.ok(fs.existsSync(filename), '缺少以薯换福子面板');
  const { descriptor, errors } = compiler.parse(fs.readFileSync(filename, 'utf8'), { filename });
  assert.deepEqual(errors, []);
  const source = compiler.compileScript(descriptor, { id: 'sweet-potato-test', inlineTemplate: true }).content;
  const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ESNext },
  }).outputText;
  const calls = [];
  const timers = new Map();
  const modulesByName = {
    vue,
    '@/api': { default: { get(url, config) {
      const result = deferred();
      calls.push({ ...result, url, config });
      return result.promise;
    } } },
    '@/components/ui/BaseButton.vue': { default: {
      props: ['loading'],
      setup: (props, { slots }) => () => vue.h('button', { disabled: props.loading }, slots.default?.()),
    } },
    './SweetPotatoTrades.vue': { default: {
      props: ['accountId', 'seedsClaimed', 'pendingDividend'],
      setup: () => () => vue.h('div', { 'data-test': 'sweet-potato-trades' }),
    } },
  };
  const mod = { exports: {} };
  vm.compileFunction(code, ['require', 'exports', 'setTimeout', 'clearTimeout'])(
    name => { assert.ok(modulesByName[name], name); return modulesByName[name]; },
    mod.exports,
    (fn, delay) => { const id = Symbol(); timers.set(id, { fn, delay }); return id; },
    id => timers.delete(id),
  );
  const el = (tag, text = '') => ({ tag, text, parent: null, props: {}, children: [] });
  const remove = child => {
    if (child.parent) child.parent.children.splice(child.parent.children.indexOf(child), 1);
    child.parent = null;
  };
  const renderer = vue.createRenderer({
    createElement: el,
    createText: text => el('#text', text),
    createComment: () => el('#comment'),
    setElementText: (node, text) => { node.text = text; node.children = []; },
    setText: (node, text) => { node.text = text; },
    patchProp: (node, key, _, value) => { node.props[key] = value; },
    parentNode: node => node.parent,
    nextSibling: node => node.parent?.children[node.parent.children.indexOf(node) + 1] || null,
    insert(child, parent, anchor) {
      remove(child);
      const position = anchor ? parent.children.indexOf(anchor) : parent.children.length;
      parent.children.splice(position, 0, child);
      child.parent = parent;
    },
    remove,
  });
  const accountId = vue.ref('a');
  const component = vue.ref(null);
  const container = el('main');
  const app = renderer.createApp({ setup: () => () => vue.h(mod.exports.default, {
    accountId: accountId.value, ref: component,
  }) });
  app.mount(container);
  let mounted = true;
  function unmount() {
    if (mounted) app.unmount();
    mounted = false;
  }
  t.after(unmount);
  function text(node = container) {
    return node.text + node.children.map(child => text(child)).join('');
  }
  function button(node = container) {
    if (node.tag === 'button') return node;
    return node.children.map(child => button(child)).find(Boolean);
  }
  const tick = async () => { await Promise.resolve(); await vue.nextTick(); };
  function reply(index, activity, account = calls[index].config.headers['x-account-id']) {
    calls[index].resolve({ data: { ok: true, accountId: account, activity } });
  }
  function expire() {
    const [[id, { fn, delay }]] = [...timers];
    assert.equal(delay, END * 1000 - clock.now);
    clock.now += delay;
    timers.delete(id);
    fn();
  }
  return { calls, timers, accountId, component, unmount, text, button, tick, reply, expire };
}

test('real Vue panel opens once, handles manual refresh and failure, and drops switched responses', async t => {
  const clock = fakeClock(t);
  const h = mountPanel(t, clock);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].url, '/api/activity/sweet-potato');
  assert.match(h.text(), /正在读取活动状态/);
  await h.component.value.refresh();
  assert.equal(h.calls.length, 1, 'refresh while loading shares the current request');

  h.reply(0, { ...available, personal: {
    ...available.personal, seedsClaimed: false, shared: true, receivedCount: 0,
  } });
  await h.tick();
  assert.match(h.text(), /个人基础铺价31,415/);
  assert.match(h.text(), /暴击加成待确认/);
  assert.match(h.text(), /领种状态未领种/);
  assert.match(h.text(), /分享状态已分享/);
  assert.match(h.text(), /接收量0/);
  assert.match(h.text(), /北京时间每日午夜按自家铺价结算/);
  assert.equal(h.calls.length, 1);

  h.button().props.onClick();
  assert.equal(h.calls.length, 2);
  h.calls[1].reject(new Error('fixture network error'));
  await h.tick();
  assert.match(h.text(), /读取失败/);

  h.button().props.onClick();
  h.accountId.value = 'b';
  await h.tick();
  assert.deepEqual(h.calls.map(call => call.config.headers['x-account-id']), ['a', 'a', 'a', 'b']);
  assert.equal(h.calls[2].config.signal.aborted, true);
  h.reply(2, available);
  await h.tick();
  assert.doesNotMatch(h.text(), /31,415/);
  assert.match(h.text(), /正在读取/);
  h.reply(3, available, 'a');
  await h.tick();
  assert.match(h.text(), /读取失败/);
  h.button().props.onClick();
  h.reply(4, { available: false, status: 'unknown', reason: '个人铺价待确认', personal: null });
  await h.tick();
  assert.match(h.text(), /个人铺价待确认/);
  assert.equal(h.calls.length, 5);

  h.button().props.onClick();
  h.unmount();
  assert.equal(h.calls[5].config.signal.aborted, true);
  assert.equal(h.timers.size, 0);
  h.reply(5, available);
  await h.tick();
  assert.equal(h.text(), '');
});

test('real Vue panel hides at the one local deadline, including a late response', async t => {
  const clock = fakeClock(t, START * 1000 - 1);
  const early = mountPanel(t, clock);
  assert.equal(early.text(), '');
  assert.equal(early.calls.length, 0);
  assert.equal(early.timers.size, 0);
  clock.now = START * 1000;
  early.component.value.refresh();
  assert.equal(early.calls.length, 1, 'a manual refresh after opening can activate an already mounted page');
  early.unmount();

  clock.now = END * 1000 - 20;
  const h = mountPanel(t, clock);
  assert.equal(h.calls.length, 1);
  assert.equal(h.timers.size, 1);
  h.expire();
  await h.tick();
  assert.equal(h.text(), '');
  assert.equal(h.calls[0].config.signal.aborted, true);
  h.reply(0, available);
  await h.tick();
  assert.equal(h.text(), '');
  await h.component.value.refresh();
  assert.equal(h.calls.length, 1);
  assert.equal(h.timers.size, 0);
  const ended = mountPanel(t, clock);
  assert.equal(ended.text(), '');
  assert.equal(ended.calls.length, 0);
});
