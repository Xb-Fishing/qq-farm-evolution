'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// This helper establishes an isolated FARM_DATA_DIR before loading any app code.
const originalDataDir = process.env.FARM_DATA_DIR;
const originalDocument = globalThis.document;
const originalWindow = globalThis.window;
const h = require('./activity-availability.test');
const isolatedDataDir = process.env.FARM_DATA_DIR;
assert.equal(isolatedDataDir, h.privateDir);

const componentFile = path.join(h.WEB, 'src/components/activity/MilkTeaActivityPanel.vue');
const guarded = [
  __filename,
  componentFile,
  path.join(h.WEB, 'src/stores/activity.ts'),
  path.join(h.WEB, 'src/views/Activity.vue'),
  path.resolve(__dirname, '../src/services/milk-tea-activity.js'),
  path.resolve(__dirname, '../src/controllers/admin-milk-tea-activity-routes.js'),
  path.resolve(__dirname, 'activity-availability.test.js'),
];
const fingerprints = guarded.map(h.fingerprintOf);
const Component = h.compileSfcModule(componentFile, spec => spec === 'vue' ? h.vue : undefined);
const roots = new Set();
let testEnvironment;

test.beforeEach(() => {
  testEnvironment = {
    dataDir: process.env.FARM_DATA_DIR,
    document: globalThis.document,
    window: globalThis.window,
    activeElement: globalThis.document?.activeElement,
    pinia: h.pinia.getActivePinia(),
  };
  assert.equal(process.env.FARM_DATA_DIR, isolatedDataDir);
});

test.afterEach(async () => {
  try {
    for (const root of roots) h.render(null, root);
    roots.clear();
    await h.flush();
  }
  finally {
    globalThis.document = testEnvironment.document;
    globalThis.window = testEnvironment.window;
    if (globalThis.document) globalThis.document.activeElement = testEnvironment.activeElement;
    h.pinia.setActivePinia(testEnvironment.pinia);
    process.env.FARM_DATA_DIR = testEnvironment.dataDir;
  }
});

test.after(() => {
  try {
    assert.deepEqual(guarded.map(h.fingerprintOf), fingerprints, 'tests must preserve source bytes and permissions');
  }
  finally {
    if (originalDataDir === undefined) delete process.env.FARM_DATA_DIR;
    else process.env.FARM_DATA_DIR = originalDataDir;
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  }
});

function activityWithStock(count = 7, patch = {}) {
  return h.snapshot({
    summary: { shopOpenAt: 1 },
    inventory: { available: true, ticketCount: 20, boostItemCount: count },
    ...patch,
  });
}

function mountPanel(patch = {}) {
  const state = h.vue.reactive({ activity: activityWithStock(), loading: false, operating: '', ...patch });
  const queries = Object.fromEntries(['shop', 'hireList', 'workshop', 'work', 'rank', 'sales']
    .map(kind => [kind, { data: null, loading: false, error: '' }]));
  const root = h.makeNode('root');
  roots.add(root);
  const events = [];
  const draw = () => h.render(h.vue.h(Component, {
    activity: state.activity,
    loading: state.loading,
    operating: state.operating,
    queries,
    onRefresh: () => events.push(['refresh']),
    onQuery: (...args) => events.push(['query', ...args]),
    onOperate: (...args) => events.push(['operate', ...args]),
  }), root);
  draw();
  return {
    root, state, events,
    update: next => { Object.assign(state, next); draw(); },
    unmount: () => { h.render(null, root); roots.delete(root); },
  };
}

function control(root, label) {
  const node = h.findAll(root, value => value.props['aria-label'] === label)[0];
  assert.ok(node, `actual control: ${label}`);
  return node;
}
function button(root, label) {
  const node = h.buttonsOf(root).find(value => h.textOf(value).trim() === label);
  assert.ok(node, `actual button: ${label}`);
  return node;
}
const maximum = root => control(root, '宣传喇叭最大数量');
const quantity = root => control(root, '喇叭数量');
const quantityValue = root => quantity(root).props.value ?? quantity(root).value;
const setQuantity = (root, value) => quantity(root).props['onUpdate:modelValue'](value);
const dialogs = root => h.findAll(root, value => value.props.role === 'dialog');

async function openConfirmation(f, count = 2) {
  setQuantity(f.root, count);
  await h.vue.nextTick();
  h.click(button(f.root, '使用宣传喇叭'));
  await h.vue.nextTick();
  assert.equal(dialogs(f.root).length, 1);
  assert.deepEqual(f.events, [], 'opening the confirmation must not request or write');
  return button(f.root, '确认执行');
}

test('horn maximum selects known stock 1/2/7/100/101 within the existing 100-per-use cap, locally only', async () => {
  for (const stock of [1, 2, 7, 100, 101]) {
    const f = mountPanel({ activity: activityWithStock(stock) });
    const expected = Math.min(stock, 100);
    assert.equal(Number(quantityValue(f.root)), 1, 'the initial quantity remains one');
    assert.equal(quantity(f.root).props.max, expected);
    assert.equal(maximum(f.root).props.disabled, false);
    assert.equal(h.textOf(maximum(f.root)).trim(), '最大');
    h.click(maximum(f.root));
    await h.vue.nextTick();
    assert.equal(Number(quantityValue(f.root)), expected, `stock ${stock}`);
    assert.equal(button(f.root, '使用宣传喇叭').props.disabled, false);
    assert.equal(dialogs(f.root).length, 0);
    assert.deepEqual(f.events, [], 'MAX must not refresh, query, open confirmation, or operate');
    if (stock > 100) assert.match(h.textOf(f.root), /单次最多使用 100 个/);
    f.unmount();
  }
});

test('unknown and malformed inventory cannot select maximum or use horns and never masquerades as known zero', async () => {
  const inventories = [
    undefined, null, {}, { available: false, boostItemCount: 7 },
    { available: 1, boostItemCount: 7 }, { available: true },
    ...[null, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, '7', true]
      .map(boostItemCount => ({ available: true, boostItemCount })),
  ];
  for (const inventory of inventories) {
    const f = mountPanel({ activity: activityWithStock(7, { inventory }) });
    assert.equal(maximum(f.root).props.disabled, true);
    assert.equal(quantity(f.root).props.disabled, true);
    assert.equal(button(f.root, '使用宣传喇叭').props.disabled, true);
    assert.match(h.textOf(f.root), /宣传喇叭：待确认/);
    assert.doesNotMatch(h.textOf(f.root), /暂无宣传喇叭/);
    h.click(maximum(f.root));
    h.click(button(f.root, '使用宣传喇叭'));
    await h.vue.nextTick();
    assert.equal(Number(quantityValue(f.root)), 1);
    assert.equal(dialogs(f.root).length, 0);
    assert.deepEqual(f.events, []);
    f.unmount();
  }
});

test('known zero is displayed as empty, with maximum and use disabled and no zero selected', async () => {
  const f = mountPanel({ activity: activityWithStock(0) });
  assert.match(h.textOf(f.root), /宣传喇叭：0/);
  assert.match(h.textOf(f.root), /暂无宣传喇叭/);
  for (const node of [maximum(f.root), quantity(f.root), button(f.root, '使用宣传喇叭')])
    assert.equal(node.props.disabled, true);
  h.click(maximum(f.root));
  h.click(button(f.root, '使用宣传喇叭'));
  await h.vue.nextTick();
  assert.equal(Number(quantityValue(f.root)), 1);
  assert.equal(dialogs(f.root).length, 0);
  assert.deepEqual(f.events, []);
});

test('loading, another operation, no activity and settlement disable quantity, maximum and use without requests', async () => {
  const cases = [
    { loading: true }, { operating: 'claimCashier' }, { activity: null },
    { activity: activityWithStock(7, { timing: { phase: 'settle', endTime: 0 } }) },
    ...['before', 'ended', undefined].map(phase => ({ activity: activityWithStock(7, { timing: { phase, endTime: 0 } }) })),
  ];
  for (const patch of cases) {
    const f = mountPanel(patch);
    for (const node of [maximum(f.root), quantity(f.root), button(f.root, '使用宣传喇叭')])
      assert.equal(node.props.disabled, true);
    h.click(maximum(f.root));
    h.click(button(f.root, '使用宣传喇叭'));
    await h.vue.nextTick();
    assert.equal(Number(quantityValue(f.root)), 1);
    assert.equal(dialogs(f.root).length, 0);
    assert.deepEqual(f.events, []);
    f.unmount();
  }
});

test('manual empty, fractional, nonpositive, over-stock and over-100 counts cannot open a confirmation', async () => {
  for (const [stock, invalid] of [
    [7, ['', 0, -1, 1.5, 8, Number.NaN, Number.POSITIVE_INFINITY]],
    [101, [101]],
  ]) {
    const f = mountPanel({ activity: activityWithStock(stock) });
    for (const count of invalid) {
      setQuantity(f.root, count);
      await h.vue.nextTick();
      const use = button(f.root, '使用宣传喇叭');
      assert.equal(use.props.disabled, true, `stock ${stock}; input ${String(count)}`);
      h.click(use);
      await h.vue.nextTick();
      assert.equal(dialogs(f.root).length, 0);
      assert.deepEqual(f.events, []);
    }
    h.click(maximum(f.root));
    await h.vue.nextTick();
    assert.equal(Number(quantityValue(f.root)), Math.min(stock, 100), 'MAX recovers from invalid manual input');
    assert.equal(button(f.root, '使用宣传喇叭').props.disabled, false);
    f.unmount();
  }
});

test('maximum still requires confirmation; cancel sends nothing and repeated confirm clicks emit the exact boost once', async () => {
  const f = mountPanel();
  h.click(maximum(f.root));
  await h.vue.nextTick();
  h.click(button(f.root, '使用宣传喇叭'));
  await h.vue.nextTick();
  assert.match(h.textOf(dialogs(f.root)[0]), /消耗宣传喇叭 × 7/);
  assert.deepEqual(f.events, []);
  h.click(button(f.root, '取消'));
  await h.vue.nextTick();
  assert.equal(dialogs(f.root).length, 0);
  assert.deepEqual(f.events, []);
  h.click(button(f.root, '使用宣传喇叭'));
  await h.vue.nextTick();
  const confirm = button(f.root, '确认执行');
  h.click(confirm);
  h.click(confirm);
  await h.vue.nextTick();
  assert.equal(dialogs(f.root).length, 0);
  assert.deepEqual(f.events, [['operate', 'boost', {
    count: 7, confirmedCosts: [{ itemId: 1042, count: '7' }],
  }]]);
});

test('inventory, selection, activity snapshot, loading, operation and settlement changes revoke pending confirmations', async () => {
  const changes = [
    f => { f.state.activity.inventory.boostItemCount = 6; },
    f => { f.state.activity.inventory.available = false; },
    f => { setQuantity(f.root, 1); },
    f => { f.update({ activity: activityWithStock(7) }); },
    f => { f.update({ loading: true }); },
    f => { f.update({ operating: 'claimCashier' }); },
    f => { f.state.activity.timing.phase = 'settle'; },
    f => { f.state.activity.timing.phase = 'ended'; },
  ];
  for (const change of changes) {
    const f = mountPanel();
    await openConfirmation(f);
    change(f);
    await h.vue.nextTick();
    assert.equal(dialogs(f.root).length, 0);
    assert.match(h.textOf(f.root), /喇叭状态或数量已更新，请重新确认/);
    assert.deepEqual(f.events, []);
    f.unmount();
  }
});

test('confirm synchronously rechecks inventory and selected quantity before queued watchers run', async () => {
  for (const change of [
    f => { f.state.activity.inventory.boostItemCount = 6; },
    f => { f.state.activity.inventory.available = false; },
    f => { setQuantity(f.root, 1); },
    f => { f.state.activity.timing.phase = 'ended'; },
  ]) {
    const f = mountPanel();
    const confirm = await openConfirmation(f);
    change(f);
    h.click(confirm); // Deliberately no nextTick between mutation and confirmation.
    assert.deepEqual(f.events, []);
    await h.vue.nextTick();
    assert.equal(dialogs(f.root).length, 0);
    f.unmount();
  }
  const f = mountPanel({ activity: activityWithStock(101) });
  const confirm = await openConfirmation(f, 100);
  f.state.activity.inventory.boostItemCount = 102; // The per-use maximum remains 100.
  h.click(confirm);
  assert.deepEqual(f.events, [], 'a changed stock invalidates consent even when quantity and cap remain valid');
  await h.vue.nextTick();
  assert.equal(dialogs(f.root).length, 0);
});

test('refreshed inventory supplies the next maximum and stale over-stock selections remain unusable', async () => {
  const f = mountPanel();
  h.click(maximum(f.root));
  await h.vue.nextTick();
  assert.equal(Number(quantityValue(f.root)), 7);
  f.update({ activity: activityWithStock(2) });
  await h.vue.nextTick();
  assert.equal(quantity(f.root).props.max, 2);
  assert.equal(button(f.root, '使用宣传喇叭').props.disabled, true);
  h.click(maximum(f.root));
  await h.vue.nextTick();
  assert.equal(Number(quantityValue(f.root)), 2);
  f.update({ activity: activityWithStock(101) });
  await h.vue.nextTick();
  h.click(maximum(f.root));
  await h.vue.nextTick();
  assert.equal(Number(quantityValue(f.root)), 100);
  assert.deepEqual(f.events, []);
});

test('real Activity page MAX sends no POST; one confirmed boost keeps its existing GET refresh and uses new inventory', async () => {
  const api = h.apiMock();
  let stock = 7;
  api.setGet(async () => ({ data: { ok: true, activity: activityWithStock(stock) } }));
  api.setPost(async (url, body) => {
    assert.equal(url, '/api/activity/milk-tea/operate');
    assert.deepEqual(body, { action: 'boost', input: { count: 2, confirmedCosts: [{ itemId: 1042, count: '2' }] } });
    stock -= body.input.count;
    return { data: { ok: true, action: 'boost', message: '喇叭已使用' } };
  });
  const page = h.mountActivityPage(api);
  roots.add(page.root);
  await h.waitFor(() => maximum(page.root).props.disabled === false, 'initial activity inventory');
  assert.equal(api.calls.get.length, 1);
  h.click(maximum(page.root));
  await h.vue.nextTick();
  await h.flush();
  assert.equal(Number(quantityValue(page.root)), 7);
  assert.equal(api.calls.get.length, 1, 'MAX must not refresh');
  assert.equal(api.calls.post.length, 0, 'MAX must not query or operate');
  setQuantity(page.root, 2);
  await h.vue.nextTick();
  h.click(button(page.root, '使用宣传喇叭'));
  await h.vue.nextTick();
  assert.equal(api.calls.post.length, 0);
  h.click(button(page.root, '确认执行'));
  await h.waitFor(() => api.calls.get.length === 2 && quantity(page.root).props.max === 5
    && maximum(page.root).props.disabled === false, 'successful boost refresh');
  assert.equal(api.calls.post.length, 1);
  assert.ok(api.calls.get.every(call => call.url === '/api/activity/milk-tea'));
  h.click(maximum(page.root));
  await h.vue.nextTick();
  assert.equal(Number(quantityValue(page.root)), 5);
  assert.equal(api.calls.post.length, 1);
  stock = 101;
  h.click(button(page.root, '刷新活动'));
  await h.waitFor(() => api.calls.get.length === 3 && quantity(page.root).props.max === 100
    && maximum(page.root).props.disabled === false, 'manual inventory refresh');
  h.click(maximum(page.root));
  await h.vue.nextTick();
  assert.equal(Number(quantityValue(page.root)), 100);
  assert.equal(api.calls.post.length, 1, 'refresh and the next MAX add no query or boost');
  assert.equal(api.calls.post[0].accountId, 'acc-1');
});
