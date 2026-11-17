'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
// Reuse the real TS/SFC helpers. Current activity tests use require.main guards;
// requiring this helper registers its cleanup hooks, but no extra activity tests.
// Its isolated FARM_DATA_DIR is established before any business module loads.
const originalDataDir = process.env.FARM_DATA_DIR;
const { vue, pinia, WEB, evaluateModule, compileSfcModule, makeNode,
  textOf, buttonsOf, click, flush, deferred, fingerprintOf, privateDir, assertWriteInsidePrivateDir } = require('./activity-availability.test');
assertWriteInsidePrivateDir(path.join(privateDir, 'manual-fertilize-fixture'));
const sourceFiles = ['src/stores/manual-fertilize.ts', 'src/components/FarmPanel.vue', 'src/stores/farm.ts'].map(file => path.join(WEB, file));
const before = sourceFiles.map(fingerprintOf);
// Browser geometry/canvas are irrelevant to writes; keep real SFC controls and events.
const renderNode = tag => Object.assign(makeNode(tag), {
  getBoundingClientRect: () => ({ width: 800 }), getContext: () => null,
  focus() { document.activeElement = this; },
});
const { render } = vue.createRenderer({
  createElement: renderNode,
  createText: value => Object.assign(renderNode('TEXT'), { text: value }),
  createComment: () => renderNode('COMMENT'),
  setText: (node, value) => { node.text = value; },
  setElementText: (node, value) => { node.text = value; node.children = []; },
  parentNode: node => node.parent,
  nextSibling: node => node.parent?.children[node.parent.children.indexOf(node) + 1] || null,
  insert: (node, parent, anchor) => {
    if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1);
    node.parent = parent;
    const index = anchor ? parent.children.indexOf(anchor) : -1;
    if (index < 0) parent.children.push(node); else parent.children.splice(index, 0, node);
  },
  remove: node => { if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1); node.parent = null; },
  patchProp: (node, key, _prev, value) => { node.props[key] = value; },
});
const renderVue = { ...vue, Transition: { inheritAttrs: false, props: ['name'], setup: (_props, { slots }) => () => slots.default?.() } };
const roots = new Set();
test.after(() => {
  try {
    for (const root of roots) render(null, root);
    sourceFiles.forEach((file, i) => assert.deepEqual(fingerprintOf(file), before[i]));
  } finally {
    if (originalDataDir === undefined) delete process.env.FARM_DATA_DIR;
    else process.env.FARM_DATA_DIR = originalDataDir;
  }
});
const land = (id, extra = {}) => ({ id, plantId: 1020001, currentSeason: 1, phaseStartTime: 100, status: 'growing', matureInSec: 100, ...extra });
const success = () => ({ data: { ok: true, data: { success: true, count: 1 } } });
function harness(timing = {}) {
  const posts = []; const reads = []; const delays = [];
  let reply = async () => success();
  const api = { post: (...args) => { posts.push(args); return reply(...args); } };
  const resolve = spec => spec === 'vue' ? vue : spec === 'pinia' ? pinia
    : spec === '@/api' ? { __esModule: true, default: api } : undefined;
  const module = evaluateModule(fs.readFileSync(sourceFiles[0], 'utf8'), resolve, sourceFiles[0], timing);
  const container = pinia.createPinia();
  const store = module.useManualFertilizeStore(container);
  const state = { id: 'A', alive: true, ready: true, lands: [land(1), land(2)] };
  const context = {
    accountId: () => state.id, alive: () => state.alive, ready: () => state.ready, lands: () => state.lands,
    refresh: async id => { reads.push(id); }, delay: async ms => { delays.push(ms); },
  };
  return { module, container, store, state, context, posts, reads, delays, resolve,
    reply: fn => { reply = fn; }, plan: () => store.prepare(state.id, state.lands),
    run: () => store.run(store.prepare(state.id, state.lands), context) };
}

test('真实store准备零POST，过滤所有不合格地块，2x2仅主地一次，串行参数与最多一次刷新', async () => {
  const h = harness();
  h.state.lands.push(land(1), land(3, { occupiedByMaster: true }), land(4, { unlocked: false }),
    land(5, { status: 'dead' }), land(6, { status: 'harvestable' }), land(7, { status: 'empty' }),
    land(8, { plantId: 0 }), land(9, { matureInSec: 0 }), land(-1), land(1.2), land(10, { status: 'unknown' }));
  const plan = h.plan();
  assert.deepEqual(plan.targets.map(x => x.id), [1, 2]);
  assert.equal(h.posts.length, 0);
  // Exercise normal dispatch after the separately tested exclusion matrix;
  // an actually ripe crop independently stops dispatch to protect harvesting.
  h.state.lands = [land(1), land(2)];
  const first = deferred();
  h.reply(() => h.posts.length === 1 ? first.promise : Promise.resolve(success()));
  const run = h.store.run(plan, h.context);
  assert.equal(h.posts.length, 1);
  assert.equal(h.posts[0][0], '/api/land/fertilize');
  assert.deepEqual(h.posts[0][1], { landId: 1, fertilizerType: 'organic' });
  assert.deepEqual(h.posts[0][2].headers, { 'x-account-id': 'A' });
  assert.equal(await h.store.run(plan, h.context), false);
  first.resolve(success()); await run;
  assert.deepEqual(h.posts.map(x => x[1]), [{ landId: 1, fertilizerType: 'organic' }, { landId: 2, fertilizerType: 'organic' }]);
  assert.deepEqual(h.delays, [350]);
  assert.deepEqual(h.reads, ['A']);
  assert.equal(h.store.progress.A.confirmed, 2);
  assert.equal(h.store.progress.A.active, false);
  assert.equal(h.module.useManualFertilizeStore(h.container).progress.A.confirmed, 2, '重进保留结果');
});

test('空目标/离线/旧身份确认不写，计时减少不撤销同作物', async () => {
  const h = harness();
  const plan = h.plan(); h.state.lands[0].matureInSec--;
  assert.equal(h.store.matches(plan, 'A', h.state.lands), true);
  h.state.lands[0].currentSeason++;
  assert.equal(await h.store.run(plan, h.context), false);
  h.state.lands = []; assert.equal(await h.run(), false);
  h.state.lands = [land(1)]; h.state.ready = false; assert.equal(await h.run(), false);
  assert.equal(h.posts.length, 0);
});

for (const [label, response] of [
  ['外层false', { data: { ok: false, data: { success: true, count: 1 } } }],
  ['普通false', { data: { ok: true, data: { success: false, count: 1 } } }],
  ['count0', { data: { ok: true, data: { success: true, count: 0 } } }],
  ['count2', { data: { ok: true, data: { success: true, count: 2 } } }],
  ['字符串count', { data: { ok: true, data: { success: true, count: '1' } } }],
  ['缺字段', { data: { ok: true } }], ['畸形', {}], ['null', null],
]) test(`严格成功判定 ${label}：停止且不计数`, async () => {
  const h = harness(); h.reply(async () => response);
  await h.run(); assert.equal(h.posts.length, 1); assert.equal(h.store.progress.A.confirmed, 0);
  assert.match(h.store.progress.A.reason, /未知|未确认/);
});

test('异常/timeout保留先前已确认数，不重放；刷新拒绝独立提示', async () => {
  const h = harness(); h.reply(async () => { if (h.posts.length > 1) throw new Error('timeout'); return success(); });
  await h.run(); assert.equal(h.posts.length, 2); assert.equal(h.store.progress.A.confirmed, 1);
  assert.match(h.store.progress.A.reason, /结果未知/);
  const next = harness(); next.context.refresh = async () => { next.reads.push('A'); throw new Error('read failed'); };
  await next.run(); assert.equal(next.store.progress.A.confirmed, 2); assert.equal(next.reads.length, 1);
  assert.match(next.store.progress.A.refreshError, /刷新失败/);
});

test('在途stop跨卸载重进仍互斥，晚到真实成功仅更新A；B可独立运行', async () => {
  const h = harness(); const pending = deferred(); h.reply(() => pending.promise);
  const run = h.run(); h.store.stop('A'); h.state.alive = false;
  const reentry = { ...h.context, alive: () => true };
  assert.equal(await h.store.run(h.plan(), reentry), false);
  assert.equal(h.store.progress.A.active, true);
  h.state.id = 'B'; h.state.alive = true; h.reply(async () => success());
  await h.run(); assert.equal(h.store.progress.B.confirmed, 2);
  pending.resolve(success()); await run;
  assert.equal(h.store.progress.A.confirmed, 1); assert.equal(h.store.progress.B.confirmed, 2);
  assert.deepEqual(h.reads, ['B']); assert.equal(h.posts.length, 3);
  h.state.id = 'A'; await h.run(); assert.equal(h.store.progress.A.confirmed, 2);
});

test('延迟stop/卸载/账号失配/目标变化/近成熟均零后续', async () => {
  for (const change of [h => h.store.stop('A'), h => { h.state.alive = false; },
    h => { h.state.id = 'B'; }, h => { h.state.lands[1].plantId++; },
    h => { h.state.lands[0].matureInSec = 10; }]) {
    const h = harness(); const delay = deferred(); h.context.delay = () => delay.promise;
    const run = h.run(); await flush(); assert.equal(h.posts.length, 1);
    change(h); delay.resolve(); await run;
    assert.equal(h.posts.length, 1); assert.equal(h.store.progress.A.confirmed, 1);
    if (!h.state.alive || h.state.id !== 'A' || /停止后续地块；/.test(h.store.progress.A.reason)) assert.equal(h.reads.length, 0);
  }
  const h = harness(); h.state.lands[1].matureInSec = 10; await h.run();
  assert.equal(h.posts.length, 0); assert.match(h.store.progress.A.reason, /10秒/);
});

// Real FarmPanel + real ConfirmModal/BaseButton, only environment and unrelated stores stubbed.
function mountPanel(h, shared) {
  pinia.setActivePinia(h.container);
  const account = shared?.account || pinia.defineStore('account', () => ({ currentAccountId: vue.ref('A'), currentAccount: vue.ref({ running: true }) }))(h.container);
  const farm = shared?.farm || pinia.defineStore('farm', () => ({
    lands: vue.ref([land(1), land(2)]), summary: vue.ref({}), loading: vue.ref(false), dogSkillGiftPendingCount: vue.ref(0),
    dogSkillGiftLoading: vue.ref(false), dogSkillGiftError: vue.ref(''),
    fetchLands: async id => { h.reads.push(id); }, fetchDogSkillGiftStatus: async () => {}, clearFarmData: () => {},
    operate: async () => {}, fertilizeLand: async () => {}, removePlant: async () => {}, removeAllPlants: async () => {},
  }))(h.container);
  const status = shared?.status || pinia.defineStore('status', () => ({
    status: vue.ref({ connection: { connected: true } }), loading: vue.ref(false), realtimeConnected: vue.ref(true), currentStatusReady: vue.ref(true),
    clearAccountScopedData: () => {}, fetchStatus: async () => {},
  }))(h.container);
  const listeners = new Map();
  Object.assign(globalThis.document, { addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: name => listeners.delete(name), querySelector: () => null });
  Object.assign(globalThis.window, { addEventListener() {}, removeEventListener() {} });
  const resolve = spec => {
    if (spec === 'vue') return renderVue;
    if (spec === '@/stores/manual-fertilize') return h.module;
    if (spec === '@/stores/account') return { useAccountStore: () => account };
    if (spec === '@/stores/farm') return { useFarmStore: () => farm };
    if (spec === '@/stores/status') return { useStatusStore: () => status };
    if (spec === '@vueuse/core') return { useIntervalFn: () => ({ pause() {}, resume() {} }) };
    if (spec === '@/components/LandCard.vue') return { __esModule: true, default: { render: () => null } };
    return h.resolve(spec);
  };
  const component = compileSfcModule(sourceFiles[1], resolve);
  const root = makeNode('root'); roots.add(root);
  render(vue.h(component), root);
  const press = async label => {
    const button = buttonsOf(root).find(node => textOf(node).trim() === label);
    assert.ok(button, `按钮 ${label}`); button.props.onClick({ currentTarget: button }); await flush();
  };
  return { root, account, farm, status, listeners, press,
    unmount() { render(null, root); roots.delete(root); } };
}

test('真实FarmPanel确认/取消/Escape/空/离线/身份变化：确认前零POST', async () => {
  const h = harness(); const p = mountPanel(h);
  try {
    await p.press('一键施肥（有机）'); assert.match(textOf(p.root), /2 个生长主地块每块调用一次/);
    assert.equal(h.posts.length, 0); await p.press('取消'); assert.equal(h.posts.length, 0);
    assert.equal(textOf(document.activeElement).trim(), '一键施肥（有机）', '取消焦点回入口');
    await p.press('一键施肥（有机）'); p.listeners.get('keydown')({ key: 'Escape' }); await flush();
    assert.ok(!textOf(p.root).includes('确认一键施肥'));
    await p.press('一键施肥（有机）'); p.farm.lands[0].phaseStartTime++; await flush();
    assert.match(textOf(p.root), /目标作物已变化/); assert.ok(!textOf(p.root).includes('确认一键施肥'));
    p.farm.lands = []; await p.press('一键施肥（有机）'); assert.match(textOf(p.root), /没有可施肥/);
    p.status.status.connection.connected = false; await p.press('一键施肥（有机）'); assert.match(textOf(p.root), /账号离线/);
    assert.equal(h.posts.length, 0);
  } finally { p.unmount(); }
});

test('真实FarmPanel A→B→A同步失效，unmount/remount在途互斥，禁用普通操作', async () => {
  const h = harness(); const p = mountPanel(h); const pending = deferred(); h.reply(() => pending.promise);
  let remount;
  try {
    await p.press('一键施肥（有机）'); p.account.currentAccountId = 'B'; p.account.currentAccountId = 'A'; await flush();
    assert.ok(!textOf(p.root).includes('确认一键施肥')); assert.equal(h.posts.length, 0);
    await p.press('一键施肥（有机）'); await p.press('确定'); assert.equal(h.posts.length, 1);
    assert.ok(buttonsOf(p.root).filter(n => ['收获', '一键铲除'].includes(textOf(n).trim())).every(n => n.props.disabled));
    const harvest = buttonsOf(p.root).find(n => textOf(n).includes('收获')); click(harvest); await flush();
    assert.ok(!textOf(p.root).includes('确定要收获'));
    p.unmount(); remount = mountPanel(h, p); await remount.press('一键施肥（有机）'); assert.equal(h.posts.length, 1);
    pending.resolve(success()); await flush(); await flush();
    assert.equal(h.store.progress.A.confirmed, 1); assert.equal(h.store.progress.A.active, false);
    assert.match(textOf(remount.root), /已确认请求 1/);
  } finally { pending.resolve(success()); if (remount) remount.unmount(); else p.unmount(); }
});

test('真实SFC在途A→B→A取消后续、末尾零刷新且已确认回包保留', async () => {
  const h = harness(); const p = mountPanel(h); const pending = deferred(); h.reply(() => pending.promise);
  try {
    await p.press('一键施肥（有机）'); await p.press('确定'); h.reads.length = 0;
    p.account.currentAccountId = 'B'; p.account.currentAccountId = 'A'; await flush();
    pending.resolve(success()); await flush(); await flush();
    assert.equal(h.posts.length, 1); assert.equal(h.store.progress.A.confirmed, 1);
    assert.equal(h.store.progress.A.active, false); assert.deepEqual(h.reads, []);
    assert.match(textOf(p.root), /账号已切换/);
  } finally { pending.resolve(success()); p.unmount(); }
});

test('真实SFC停止按钮、正常成功单次刷新、普通操作与批次互斥', async () => {
  const h = harness(); const p = mountPanel(h); const pending = deferred();
  try {
    let operations = 0;
    p.farm.operate = async () => { operations++; await pending.promise; };
    const harvest = buttonsOf(p.root).find(node => textOf(node).includes('收获'));
    click(harvest); await flush(); await p.press('确定');
    await p.press('一键施肥（有机）'); assert.equal(h.posts.length, 0); assert.equal(operations, 1);
    pending.resolve(); await flush();
    h.reply(async () => success()); h.reads.length = 0;
    p.farm.lands = [land(1)];
    await p.press('一键施肥（有机）'); await p.press('确定');
    assert.equal(h.posts.length, 1); assert.deepEqual(h.reads, ['A']);
    assert.match(textOf(p.root), /已确认请求 1 \/ 1 次/);
    const inFlight = deferred(); h.reply(() => inFlight.promise); h.reads.length = 0;
    p.farm.lands = [land(1), land(2)];
    await p.press('一键施肥（有机）'); await p.press('确定'); await p.press('停止后续地块');
    assert.equal(h.store.progress.A.active, true);
    inFlight.resolve(success()); await flush(); await flush();
    assert.equal(h.posts.length, 2); assert.deepEqual(h.reads, []);
    assert.equal(h.store.progress.A.confirmed, 1);
  } finally { pending.resolve(); p.unmount(); }
});

test('真实共享API拦截器+Axios离线adapter：切号不能覆盖已确认A的最终请求头', async () => {
  window.location ||= { href: pathToFileURL(path.join(privateDir, 'offline-document.html')).href, pathname: '/', search: '' };
  const axios = require(path.join(WEB, 'node_modules/axios/dist/node/axios.cjs'));
  const storedAccount = vue.ref('A');
  const apiResolve = spec => {
    if (spec === 'axios') return { __esModule: true, default: axios };
    if (spec === '@vueuse/core') return { useStorage: key => key === 'current_account_id' ? storedAccount : vue.ref('') };
    if (spec === '@/stores/toast') return { useToastStore: () => ({ error() {}, warning() {} }) };
    if (spec === '@/utils/daily-feedback') return { currentFeedbackTrace: () => '', recordClientFailure() {} };
    if (spec === '@/utils/request-diagnostics') return { requestOperation: () => 'other' };
    if (spec === '@/utils/safe-redirect') return { resolveSafeRedirect: () => '' };
  };
  const api = evaluateModule(fs.readFileSync(path.join(WEB, 'src/api/index.ts'), 'utf8'), apiResolve, 'api.ts').default;
  const requests = [];
  const dispatched = deferred();
  api.defaults.adapter = async config => {
    requests.push(config);
    await dispatched.promise;
    return { data: { ok: true, data: { success: true, count: 1 } }, status: 200, statusText: 'OK', headers: {}, config };
  };
  const module = evaluateModule(fs.readFileSync(sourceFiles[0], 'utf8'), spec => spec === 'vue' ? vue : spec === 'pinia' ? pinia
    : spec === '@/api' ? { __esModule: true, default: api } : undefined, sourceFiles[0]);
  const store = module.useManualFertilizeStore(pinia.createPinia());
  let currentAccount = 'A';
  const lands = [land(1), land(2)];
  let refreshes = 0;
  const run = store.run(store.prepare('A', lands), {
    accountId: () => currentAccount, alive: () => true, ready: () => true, lands: () => lands,
    refresh: async () => { refreshes++; },
  });
  await flush();
  assert.equal(requests.length, 1, '先确认adapter已派发，再切号');
  storedAccount.value = 'B'; currentAccount = 'B'; store.stop('A');
  dispatched.resolve();
  await run;
  assert.equal(requests.length, 1);
  assert.equal(requests[0].headers.get('x-account-id'), 'A');
  assert.equal(requests[0].headers.get('Content-Type'), 'application/json');
  assert.deepEqual(JSON.parse(requests[0].data), { landId: 1, fertilizerType: 'organic' });
  assert.equal(store.progress.A.confirmed, 1); assert.equal(refreshes, 0);
});

test('倒计时冻结的异步停顿仍以成熟墙钟保护收获', async () => {
  let now = 2000000000000;
  class FrozenDate extends Date { static now() { return now; } }
  const h = harness({ Date: FrozenDate });
  h.reply(async () => { now += 95000; return success(); });
  await h.run();
  assert.equal(h.posts.length, 1, 'UI剩余100秒未递减，但墙钟只剩5秒，不得继续发送');
  assert.equal(h.store.progress.A.confirmed, 1);
  assert.match(h.store.progress.A.reason, /10秒/);
});

test('已处理地块正常推进阶段不阻断其余合格目标', async () => {
  const h = harness();
  h.reply(async () => { h.state.lands[0].phaseStartTime = 200; return success(); });
  await h.run();
  assert.deepEqual(h.posts.map(p => p[1].landId), [1, 2]);
  assert.equal(h.store.progress.A.confirmed, 2);
});

test('畸形土地输入不崩溃且不能授权发送', () => {
  const h = harness();
  assert.deepEqual(h.module.fertilizeTargets([null, undefined, {}, land(1)]).map(x => x.id), [1]);
  for (const value of [null, undefined, {}, 'invalid'])
    assert.deepEqual(h.module.fertilizeTargets(value), []);
});

test('真实farm store的HTTP200业务false明确提示刷新失败并保留写确认', async () => {
  const h = harness(); let gets = 0;
  const api = { async get() { gets++; return { data: { ok: false, error: 'synthetic read rejected' } }; } };
  const resolver = spec => spec === 'vue' ? vue : spec === 'pinia' ? pinia
    : spec === '@/api' ? { __esModule: true, default: api }
      : spec === '@/stores/account' ? { useAccountStore: () => ({ currentAccountId: 'A' }) } : undefined;
  const module = evaluateModule(fs.readFileSync(sourceFiles[2], 'utf8'), resolver, sourceFiles[2]);
  const farm = module.useFarmStore(h.container);
  h.context.refresh = id => farm.fetchLands(id);
  await h.run();
  assert.equal(gets, 1);
  assert.equal(h.store.progress.A.confirmed, 2);
  assert.match(h.store.progress.A.refreshError, /刷新失败/);
});

test('真实Axios等待拦截器时停止，adapter零派发且不计已确认', async () => {
  window.location ||= { href: pathToFileURL(path.join(privateDir, 'offline-document.html')).href, pathname: '/', search: '' };
  const axios = require(path.join(WEB, 'node_modules/axios/dist/node/axios.cjs'));
  const api = axios.create(); const gate = deferred(); let writes = 0;
  api.interceptors.request.use(async config => { await gate.promise; return config; });
  api.defaults.adapter = async config => { writes++; return { data: success().data, status: 200, statusText: 'OK', headers: {}, config }; };
  const module = evaluateModule(fs.readFileSync(sourceFiles[0], 'utf8'), spec => spec === 'vue' ? vue : spec === 'pinia' ? pinia
    : spec === '@/api' ? { __esModule: true, default: api } : undefined, sourceFiles[0]);
  const store = module.useManualFertilizeStore(pinia.createPinia());
  const lands = [land(1)]; const plan = store.prepare('A', lands);
  const run = store.run(plan, { accountId: () => 'A', alive: () => true, ready: () => true, lands: () => lands, refresh: async () => {} });
  store.stop('A'); gate.resolve(); await run;
  assert.equal(writes, 0);
  assert.equal(store.progress.A.confirmed, 0);
  assert.equal(store.progress.A.active, false);
});

test('已有成熟收获及施肥后自然成熟优先，停止新增地块', async () => {
  for (const duringReply of [false, true]) {
    const h = harness();
    const ripe = land(3, { status: 'harvestable', matureInSec: 0 });
    if (!duringReply) h.state.lands.push(ripe);
    else h.reply(async () => { h.state.lands.push(ripe); return success(); });
    await h.run();
    assert.equal(h.posts.length, duringReply ? 1 : 0);
    assert.equal(h.store.progress.A.confirmed, duringReply ? 1 : 0);
    assert.match(h.store.progress.A.reason, /收获/);
  }
});

test('等待期间土地变畸形停止后续并保留已确认', async () => {
  const h = harness();
  h.reply(async () => { h.state.lands = null; return success(); });
  await h.run();
  assert.equal(h.posts.length, 1);
  assert.equal(h.store.progress.A.confirmed, 1);
  assert.equal(h.store.progress.A.active, false);
  assert.match(h.store.progress.A.reason, /土地状态读取异常/);
});

test('批次开始前缓存已陈旧，使用DTO绝对成熟截止而非重锚相对秒数', async () => {
  const now = 2000000000000;
  class CurrentDate extends Date { static now() { return now; } }
  for (const remaining of [-1, 5, 100]) {
    const h = harness({ Date: CurrentDate });
    h.state.lands[0].matureAtSec = now / 1000 + remaining;
    await h.run();
    assert.equal(h.posts.length, remaining <= 10 ? 0 : 2);
    assert.equal(h.store.progress.A.confirmed, remaining <= 10 ? 0 : 2);
  }
});

function sharedErrorFixture() {
  window.location ||= { href: pathToFileURL(path.join(privateDir, 'offline-document.html')).href, pathname: '/', search: '' };
  const axios = require(path.join(WEB, 'node_modules/axios/dist/node/axios.cjs'));
  const selected = vue.ref('A'); const toasts = []; const failures = [];
  const resolver = spec => {
    if (spec === 'axios') return { __esModule: true, default: axios };
    if (spec === '@vueuse/core') return { useStorage: key => key === 'current_account_id' ? selected : vue.ref('') };
    if (spec === '@/stores/toast') return { useToastStore: () => ({ error: value => toasts.push(value), warning: value => toasts.push(value) }) };
    if (spec === '@/utils/daily-feedback') return { currentFeedbackTrace: () => '', recordClientFailure: (...args) => failures.push(args) };
    if (spec === '@/utils/request-diagnostics') return { requestOperation: () => 'farm_query' };
    if (spec === '@/utils/safe-redirect') return { resolveSafeRedirect: () => '' };
  };
  const api = evaluateModule(fs.readFileSync(path.join(WEB, 'src/api/index.ts'), 'utf8'), resolver, 'shared-api.ts').default;
  const module = evaluateModule(fs.readFileSync(sourceFiles[0], 'utf8'), spec => spec === 'vue' ? vue : spec === 'pinia' ? pinia
    : spec === '@/api' ? { __esModule: true, default: api } : undefined, sourceFiles[0]);
  const store = module.useManualFertilizeStore(pinia.createPinia()); const state = { account: 'A', alive: true };
  const lands = [land(1)]; const context = { accountId: () => state.account, alive: () => state.alive, ready: () => true, lands: () => lands, refresh: async () => {} };
  return { axios, api, store, state, selected, toasts, failures, run: () => store.run(store.prepare('A', lands), context) };
}

test('shared interceptor queued cancellation is silent and sends zero requests', async () => {
  const fixture = sharedErrorFixture(); const gate = deferred(); let sends = 0;
  fixture.api.interceptors.request.use(async config => { await gate.promise; return config; });
  fixture.api.defaults.adapter = async config => { sends++; return { data: success().data, status: 200, statusText: 'OK', headers: {}, config }; };
  const pending = fixture.run(); fixture.store.stop('A'); fixture.state.alive = false; gate.resolve(); await pending;
  assert.equal(sends, 0); assert.equal(fixture.toasts.length, 0); assert.equal(fixture.failures.length, 0);
});

test('shared interceptor late dispatched failure cannot toast in another account and keeps diagnostics', async () => {
  const fixture = sharedErrorFixture(); const gate = deferred(); let sends = 0;
  fixture.api.defaults.adapter = async config => {
    sends++; await gate.promise;
    throw new fixture.axios.AxiosError('synthetic server error', 'ERR_BAD_RESPONSE', config, {},
      { status: 500, statusText: 'failure', data: { ok: false, error: 'synthetic failure' }, headers: {}, config });
  };
  const pending = fixture.run(); await flush(); assert.equal(sends, 1);
  fixture.selected.value = 'B'; fixture.state.account = 'B'; fixture.store.stop('A'); gate.resolve(); await pending;
  assert.equal(fixture.toasts.length, 0);
  assert.equal(fixture.failures.length, 1, 'real failure diagnostics must remain');
  assert.equal(fixture.store.progress.A.confirmed, 0);
  assert.equal(fixture.store.progress.A.active, false);
});


test('consumer errors retain timeout diagnostics and auth recovery; ordinary callers still toast', async () => {
  const f = sharedErrorFixture();
  f.api.defaults.adapter = async config => { throw new f.axios.AxiosError('late timeout', 'ECONNABORTED', config, {}); };
  await f.run();
  assert.equal(f.toasts.length, 0); assert.equal(f.failures.length, 1);
  assert.equal(f.failures[0][0], 'request_timeout');
  f.api.defaults.adapter = async config => { throw new f.axios.AxiosError('failed', 'ERR_BAD_RESPONSE', config, {},
    { status: 500, statusText: 'failure', data: {}, headers: {}, config }); };
  await assert.rejects(f.api.get('/api/lands'));
  assert.equal(f.toasts.length, 1); assert.equal(f.failures.length, 2);
  f.api.defaults.adapter = async config => { throw new f.axios.AxiosError('expired', 'ERR_BAD_RESPONSE', config, {},
    { status: 401, statusText: 'Unauthorized', data: {}, headers: {}, config }); };
  await assert.rejects(f.api.get('/api/lands', { errorFeedback: 'consumer' }));
  assert.match(f.toasts.at(-1), /登录已过期/);
  assert.match(window.location.href, /login/);
  assert.equal(f.failures.length, 2);
});

test('batch final land read opts into consumer feedback while ordinary refresh keeps global defaults', async () => {
  const h = harness(); const requests = [];
  const api = { async get(url, config) { requests.push({ url, config }); return { data: { ok: true, data: { lands: [] } } }; } };
  const resolver = spec => spec === 'vue' ? vue : spec === 'pinia' ? pinia
    : spec === '@/api' ? { __esModule: true, default: api }
      : spec === '@/stores/account' ? { useAccountStore: () => ({ currentAccountId: 'A' }) } : undefined;
  const module = evaluateModule(fs.readFileSync(sourceFiles[2], 'utf8'), resolver, sourceFiles[2]);
  const farm = module.useFarmStore(h.container);
  await farm.fetchLands('A', 'consumer'); await farm.fetchLands('A');
  assert.deepEqual(requests.map(r => r.config.errorFeedback), ['consumer', 'global']);
  assert.deepEqual(requests.map(r => r.config.headers), [{ 'x-account-id': 'A' }, { 'x-account-id': 'A' }]);
});


test('normal uses the shared batch, 350ms pacing and confirmed-only progress; malformed plans send nothing', async () => {
  const h = harness();
  const plan = h.store.prepare('A', h.state.lands, 'normal');
  assert.equal(plan.fertilizerType, 'normal');
  h.reply(async () => { if (h.posts.length === 2) throw new Error('unknown write outcome'); return success(); });
  await h.store.run(plan, h.context);
  assert.deepEqual(h.posts.map(p => p[1]), [{ landId: 1, fertilizerType: 'normal' }, { landId: 2, fertilizerType: 'normal' }]);
  assert.deepEqual(h.delays, [350]);
  assert.equal(h.store.progress.A.fertilizerType, 'normal');
  assert.equal(h.store.progress.A.confirmed, 1);
  assert.match(h.store.progress.A.reason, /结果未知.*不自动重试/);
  assert.deepEqual(h.reads, ['A']);
  assert.equal(await h.store.run({ ...plan, fertilizerType: 'invalid' }, h.context), false);
  assert.equal(h.posts.length, 2);
});

test('real normal confirmation and stop share the organic in-flight mutex without claiming maturity', async () => {
  const h = harness(); const p = mountPanel(h); const pending = deferred();
  h.reply(() => pending.promise);
  try {
    await p.press('一键施肥（普通）');
    assert.match(textOf(p.root), /确认一键施肥（普通）/);
    assert.match(textOf(p.root), /使用普通肥，对 2 个生长主地块每块调用一次/);
    assert.equal(h.posts.length, 0);
    await p.press('取消'); assert.equal(h.posts.length, 0);
    await p.press('一键施肥（普通）'); await p.press('确定');
    assert.deepEqual(h.posts[0][1], { landId: 1, fertilizerType: 'normal' });
    assert.ok(buttonsOf(p.root).find(n => textOf(n).trim() === '一键施肥（有机）').props.disabled);
    await p.press('停止后续地块'); pending.resolve(success()); await flush(); await flush();
    assert.equal(h.posts.length, 1); assert.equal(h.store.progress.A.confirmed, 1);
    assert.match(textOf(p.root), /普通肥：已确认请求 1 \/ 2 次/);
    assert.ok(!textOf(p.root).includes('催熟成功'));
  } finally { pending.resolve(success()); p.unmount(); }
});
