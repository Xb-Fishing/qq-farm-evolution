const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const h = require('./activity-availability.test');
const service = require('../src/services/milk-tea-activity');
const roots = [];
const componentFile = path.join(h.WEB, 'src/components/activity/MilkTeaActivityPanel.vue');
const guarded = [__filename, componentFile, path.resolve(__dirname, '../src/services/milk-tea-activity.js'), path.join(h.WEB, 'src/stores/activity.ts')];
const before = guarded.map(h.fingerprintOf);
test.after(() => {
  try { for (const root of roots) h.render(null, root); }
  finally { assert.deepEqual(guarded.map(h.fingerprintOf), before); }
});

function goods(patch = {}) {
  return { id: 9001, name: '甜莓种子', rewards: [{ id: 20525, name: '森野甜莓种子', count: '1' }],
    costs: [{ id: 1041, name: '奶茶券', count: '100' }], purchaseLimit: 5, purchasedCount: 1,
    diamondCostCount: 0, ...patch };
}
function inventory(count = 1000) { return { available: true, counts: new Map([[1041, count], [1042, 2]]) }; }
function bound(row, inv = inventory(), phase = 'open') { return service.getMilkTeaExchangeBounds(row, inv, { phase }); }
function row(patch = {}, inv = inventory()) { const g = goods(patch); return { ...g, exchangeBounds: bound(g, inv) }; }
function activity(items) { return h.snapshot({ summary: { shopOpenAt: 1 }, inventory: { available: true, ticketCount: 1000 }, exchangeShop: { items } }); }
function panel(items) {
  const Component = h.compileSfcModule(componentFile, spec => spec === 'vue' ? h.vue : undefined);
  const root = h.makeNode('root'); roots.push(root);
  const writes = [];
  const queries = Object.fromEntries(['shop', 'hireList', 'workshop', 'work', 'rank', 'sales'].map(k => [k, { data: null, error: '', loading: false }]));
  const update = data => h.render(h.vue.h(Component, { activity: data, queries, onOperate: (...args) => writes.push(args) }), root);
  update(activity(items)); return { root, writes, update };
}
function control(root, label) {
  const node = h.findAll(root, n => n.props['aria-label'] === label)[0];
  assert.ok(node, `actual quantity control: ${label}`); return node;
}
function button(root, label) {
  const node = h.buttonsOf(root).find(n => h.textOf(n).trim() === label);
  assert.ok(node, `actual button: ${label}`); return node;
}
function set(root, label, value) { control(root, label).props['onUpdate:modelValue'](value); }

test('current bounds intersect server quota, purchased count, all material balances and the 999-per-write cap', () => {
  assert.equal(bound(goods()).maxCount, 4);
  assert.equal(bound(goods(), inventory(250)).maxCount, 2);
  const noQuota = bound(goods({ purchaseLimit: 0 }), inventory(500));
  assert.equal(noQuota.hasPurchaseLimit, false); assert.equal(noQuota.remainingLimit, null); assert.equal(noQuota.maxCount, 5);
  assert.equal(bound(goods({ purchaseLimit: 0, costs: [{ id: 1041, count: '1' }] }), inventory(100000)).maxCount, 999);
  const duplicate = bound(goods({ costs: [{ id: 1041, count: '30' }, { id: 1041, count: '20' }] }), inventory(120));
  assert.equal(duplicate.maxCount, 2); assert.deepEqual(duplicate.unitCosts.map(x => [x.itemId, x.count]), [[1041, '50']]);
});

test('sold-out, insufficient, diamond, unmet condition and settlement seed entries are bounded at zero', () => {
  for (const [g, inv, phase] of [
    [goods({ purchasedCount: 5 }), inventory(), 'open'], [goods(), inventory(99), 'open'],
    [goods({ diamondCostCount: 1 }), inventory(), 'open'],
    [goods({ condHints: [{ satisfied: false }] }), inventory(), 'open'], [goods(), inventory(), 'settle'],
  ]) { const result = bound(g, inv, phase); assert.equal(result.maxCount, 0); assert.ok(result.blockReason); }
  assert.equal(bound(goods({ rewards: [{ id: 80011, count: '1' }] }), inventory(), 'settle').maxCount, 4, 'non-seed settlement exchange remains available');
});

test('unknown stock or quota is not displayed as zero, and large costs do not round into an affordable purchase', () => {
  assert.equal(bound(goods(), { available: false, counts: new Map() }).maxCount, null);
  assert.equal(bound(goods({ purchaseLimit: undefined })).maxCount, null);
  assert.equal(bound(goods({ purchasedCount: undefined })).maxCount, null);
  const expensive = goods({ purchaseLimit: 0, costs: [{ id: 1041, count: '9007199254740993' }] });
  assert.equal(bound(expensive, inventory('18014398509481986')).maxCount, 2);
  assert.equal(bound(expensive, inventory(Number('18014398509481986'))).maxCount, null, 'unsafe numeric balance cannot be trusted');
  assert.equal(bound(goods({ costs: [{ id: 1041, count: '1.5' }] })).maxCount, 0);
});

test('actual default overview includes current bounds using one existing inventory read for all catalog materials', async () => {
  const calls = [];
  const now = Date.now();
  const start = Math.floor(now / 1000) - 60;
  const end = start + 3600;
  const g = goods({ costs: [{ id: 1041, count: '100' }, { id: 1001, count: '20' }] });
  const result = await service.getMilkTeaActivity({ now: () => now,
    getActivityDiscoveryList: async () => { calls.push('List'); return [{ id: service.MILK_TEA_ROOT_ACTIVITY_ID, startTime: start, endTime: end }]; },
    getActivityGroupSnapshot: async () => { calls.push('GetGroup'); return { id: service.MILK_TEA_ROOT_ACTIVITY_ID, startTime: start, endTime: end,
      children: [{ id: service.MILK_TEA_SHOP_ACTIVITY_ID, details: { exchangeShop: { items: [g] } } }] }; },
    getBagItemCounts: async ids => { calls.push(['Bag', ids]); return { available: true, counts: new Map([[1041, 250], [1042, 0], [1001, 75]]) }; },
  });
  assert.deepEqual(calls, ['List', 'GetGroup', ['Bag', [1041, 1042, 1001]]]);
  assert.equal(result.exchangeShop.items[0].exchangeBounds.maxCount, 2);
  assert.equal(result.exchangeShop.items[0].exchangeBounds.remainingLimit, 4);
});

test('each real product card displays remaining quota and owns its independent quantity and maximum action', async () => {
  const f = panel([row(), row({ id: 9002, name: '白桃种子', purchaseLimit: 0, costs: [{ id: 1041, count: '200', name: '奶茶券' }] })]);
  assert.match(h.textOf(f.root), /剩余 4 份/); assert.match(h.textOf(f.root), /服务端未设置限购/);
  set(f.root, '甜莓种子兑换数量', 3); await h.vue.nextTick();
  const max = h.buttonsOf(f.root).filter(n => h.textOf(n).trim() === '最大'); assert.equal(max.length, 2);
  h.click(max[1]); await h.vue.nextTick();
  const first = control(f.root, '甜莓种子兑换数量');
  const second = control(f.root, '白桃种子兑换数量');
  assert.equal(Number(first.props.value ?? first.value), 3);
  assert.equal(Number(second.props.value ?? second.value), 5);
  assert.equal(f.writes.length, 0, 'editing quantities and maximum must not request or write');
});

test('per-product total costs are confirmed before exactly one exchange and invalid counts cannot open a write', async () => {
  const f = panel([row({ costs: [{ id: 1041, name: '奶茶券', count: '30' }, { id: 1041, name: '奶茶券', count: '20' }] }, inventory(120))]);
  for (const value of [0, -1, 1.5, 3, '']) {
    set(f.root, '甜莓种子兑换数量', value); await h.vue.nextTick();
    const buy = h.buttonsOf(f.root).find(n => h.textOf(n).trim().startsWith('确认兑换 甜莓种子')); assert.ok(buy);
    assert.equal(buy.props.disabled, true); h.click(buy); await h.vue.nextTick();
    assert.equal(h.findAll(f.root, n => n.props.role === 'dialog').length, 0); assert.equal(f.writes.length, 0);
  }
  set(f.root, '甜莓种子兑换数量', 2); await h.vue.nextTick();
  h.click(button(f.root, '确认兑换 甜莓种子 × 2')); await h.vue.nextTick();
  assert.equal(f.writes.length, 0); assert.match(h.textOf(f.root), /合计消耗 奶茶券 × 100/);
  h.click(button(f.root, '取消')); await h.vue.nextTick(); assert.equal(f.writes.length, 0);
  h.click(button(f.root, '确认兑换 甜莓种子 × 2')); await h.vue.nextTick();
  h.click(button(f.root, '确认执行')); await h.vue.nextTick();
  assert.deepEqual(f.writes, [['exchange', { goodsId: 9001, count: 2, confirmedCosts: [{ itemId: 1041, count: '100' }] }]]);
});

test('changed catalog closes an old confirmation, updates bounds, and does not replay it', async () => {
  const f = panel([row()]); set(f.root, '甜莓种子兑换数量', 3); await h.vue.nextTick();
  h.click(button(f.root, '确认兑换 甜莓种子 × 3')); await h.vue.nextTick();
  assert.equal(h.findAll(f.root, n => n.props.role === 'dialog').length, 1);
  f.update(activity([row({ purchasedCount: 4 })])); await h.vue.nextTick(); await h.flush();
  assert.equal(h.findAll(f.root, n => n.props.role === 'dialog').length, 0); assert.equal(f.writes.length, 0);
  assert.match(h.textOf(f.root), /当前最多可兑 1 份/);
  assert.equal(button(f.root, '确认兑换 甜莓种子 × 3').props.disabled, true);
});

test('actual page refreshes remaining allowance after a confirmed exchange through the existing store route', async () => {
  let purchased = 1;
  const api = h.apiMock();
  api.setGet(async () => ({ data: { ok: true, activity: activity([row({ purchasedCount: purchased })]) } }));
  api.setPost(async (_url, body) => { assert.equal(body.action, 'exchange'); purchased += body.input.count; return { data: { ok: true, action: 'exchange' } }; });
  const page = h.mountActivityPage(api); roots.push(page.root); await h.flush();
  set(page.root, '甜莓种子兑换数量', 2); await h.vue.nextTick();
  h.click(button(page.root, '确认兑换 甜莓种子 × 2')); await h.vue.nextTick();
  assert.equal(api.calls.post.length, 0);
  h.click(button(page.root, '确认执行')); await h.flush(); await h.flush();
  assert.equal(api.calls.post.length, 1);
  assert.match(h.textOf(page.root), /剩余 2 份/);
  assert.equal(api.calls.get.filter(x => x.url === '/api/activity/milk-tea').length, 2, 'one ordinary refresh follows the write');
});
