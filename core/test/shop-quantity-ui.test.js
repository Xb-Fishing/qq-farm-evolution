const test = require('node:test'); const assert = require('node:assert/strict');
const path = require('node:path'); const fs = require('node:fs');
const h = require('./activity-availability.test');
const { vue, pinia, render, makeNode, compileSfcModule, evaluateModule, textOf, buttonsOf, findAll, click, flush, apiMock, deferred } = h;
const roots = [];
const files = ['views/Shop.vue', 'components/BagPanel.vue', 'stores/shop.ts', 'stores/bag.ts', 'components/shop/PurchaseQuantityModal.vue'].map(name => path.join(h.WEB, 'src', name));
const before = files.map(file => [file, h.fingerprintOf(file)]);
function setup(kind = 'shop', options = {}) {
  const p = pinia.createPinia(); pinia.setActivePinia(p);
  const api = apiMock(); const toasts = []; const account = vue.ref('synthetic-a');
  const wallet = { gold: '100000', coupon: '100000', diamond: '100000', goldBean: '100000', level: 240 };
  const useAccountStore = pinia.defineStore('account', () => ({ currentAccountId: account, currentAccount: vue.ref({ name: '示例账号', running: true }) }));
  const useStatusStore = pinia.defineStore('status', () => ({ status: vue.ref({ status: wallet }), loading: vue.ref(false), error: vue.ref(''), realtimeConnected: vue.ref(true), currentStatusReady: vue.ref(true), fetchStatus: async () => {}, clearAccountScopedData() {} }));
  const ordinary = { id: 7, name: '示例种子', itemId: 20001, price: 5, priceDec: '5', itemCountDec: '2', quoteKnown: true, quoteFingerprint: 'a'.repeat(64), shopKind: 'seed', currencyId: 1001, requiredLevel: 1, unlocked: true, limitCountDec: '8', boughtNumDec: '1', seedLevel: 1 };
  const goods = { goodsId: 1006, name: '示例狗粮礼包', zone: 'packages', price: { amountDec: '33' }, items: [{ id: 90004, name: '1天狗粮', countDec: '1' }], quoteFingerprint: 'b'.repeat(64), isFree: false, enabled: true, currencyName: '点券', currencyBalance: '1000', balanceKnown: true, canBuy: true, catalogRestricted: null, limit: { present: false } };
  const bag = { items: [{ id: 40001, name: '示例果实', itemType: 6, price: 3, priceDec: '3', priceId: 1001, priceUnit: '金币', count: 7, countDec: '7', sellable: true, saleQuoteFingerprint: 'c'.repeat(64) }], originalItems: [{ id: 40001, uidDec: '9007199254740993', countDec: '4' }, { id: 40001, uidDec: '9007199254740994', countDec: '3' }] };
  const state = { ordinary, goods, bag, failRead: false };
  api.setGet(async url => {
    if (options.getGate) await options.getGate.promise;
    if (state.failRead) return { data: { ok: false, error: '合成读取失败' } };
    if (url === '/api/shop/seed') return { data: { ok: true, data: [state.ordinary] } };
    if (url === '/api/shop/mall') return { data: { ok: true, data: { zones: { featured: [], packages: [state.goods], unknown: [] } } } };
    if (url === '/api/shop/mall/monthcard') return { data: { ok: true, data: { cards: [], ownershipKnown: false } } };
    if (url === '/api/shop/mall/recharge') return { data: { ok: true, data: { tiers: [{ id: 1, priceYuan: '1', gainDiamond: 10, firstChargeBonusDiamond: 10 }], notes: [] } } };
    if (url === '/api/bag') return { data: { ok: true, data: state.bag } };
    if (url === '/api/settings') return { data: { ok: true, data: { automation: {} } } };
    return { data: { ok: true, data: [] } };
  });
  const cache = new Map();
  function resolve(spec) {
    // The synthetic renderer has no browser classList/CSS engine. Keep the real
    // component transition lifecycle without DOM-specific animation hooks.
    if (spec === 'vue') return { ...vue, Transition: vue.BaseTransition };
    if (spec === 'pinia') return pinia;
    if (spec === 'vue-router') return { useRoute: () => ({ query: {} }), useRouter: () => ({ push() {} }) };
    if (spec === '@/api') return { __esModule: true, default: api.instance };
    if (spec === '@/stores/account') return { useAccountStore };
    if (spec === '@/stores/status') return { useStatusStore };
    if (spec === '@/stores/toast') return { useToastStore: () => ({ success: value => toasts.push(['success', value]), error: value => toasts.push(['error', value]), warning: value => toasts.push(['warning', value]) }) };
    if (spec === '@vueuse/core') return { useIntervalFn: () => ({ pause() {}, resume() {} }) };
    if (spec.startsWith('@/')) {
      const target = path.join(h.WEB, 'src', spec.slice(2));
      if (cache.has(target)) return cache.get(target);
      if (spec.endsWith('.vue')) { const output = { __esModule: true, default: compileSfcModule(target, resolve) }; cache.set(target, output); return output; }
      if (fs.existsSync(`${target  }.ts`)) { const output = evaluateModule(fs.readFileSync(`${target  }.ts`, 'utf8'), resolve, `${target  }.ts`); cache.set(target, output); return output; }
    }
    return undefined;
  }
  const component = compileSfcModule(path.join(h.WEB, 'src', kind === 'shop' ? 'views/Shop.vue' : 'components/BagPanel.vue'), resolve);
  const root = makeNode('root'); roots.push(root); render(vue.h(component), root);
  return { root, api, state, toasts, account: vue.toRef(useAccountStore(p), 'currentAccountId'),
    shop: kind === 'shop' ? resolve('@/stores/shop').useShopStore(p) : null, bagStore: kind === 'bag' ? resolve('@/stores/bag').useBagStore(p) : null };
}
const button = (root, text) => buttonsOf(root).find(node => textOf(node).trim() === text);
const quantity = root => findAll(root, node => node.props['aria-label'] === '数量')[0];
test.after(() => { while (roots.length) render(null, roots.pop()); for (const [file, fingerprint] of before) assert.deepEqual(h.fingerprintOf(file), fingerprint); });
test('actual Shop/store provides quantities for every mall good, local maximum/cancel are zero request, and confirmation writes once', async () => {
  const f = setup(); await flush(); click(button(f.root, '道具商店')); await flush(); click(button(f.root, '礼包')); await flush();
  click(button(f.root, '选择购买数量')); await flush(); const reads = f.api.calls.get.length;
  click(button(f.root, '最大')); await flush(); assert.equal(f.api.calls.get.length, reads); assert.equal(f.api.calls.post.length, 0);
  click(button(f.root, '取消')); await flush(); assert.equal(f.api.calls.post.length, 0);
  click(button(f.root, '选择购买数量')); await flush(); quantity(f.root).props['onUpdate:modelValue']('3'); await flush();
  assert.match(textOf(f.root), /99 点券/); click(button(f.root, '确认购买')); click(button(f.root, '确认购买')); await flush();
  assert.equal(f.api.calls.post.length, 1); assert.equal(f.api.calls.post[0].body.count, '3'); assert.match(f.api.calls.post[0].body.operationId, /\w{8}/);
});
test('zero max and fractional/empty quantities cannot be submitted; wide totals remain exact', async () => {
  const f = setup(); await flush(); click(button(f.root, '选择购买数量')); await flush();
  for (const value of ['', '0', '-1', '1.5', '8']) {
    quantity(f.root).props['onUpdate:modelValue'](value); await flush(); assert.equal(button(f.root, '确认购买').props.disabled, true);
  }
  assert.equal(f.api.calls.post.length, 0);
  click(button(f.root, '取消')); await flush();
  f.state.ordinary.priceDec = '9007199254740993'; f.state.ordinary.currencyId = 1001;
  // Mount the real modal directly for a balance beyond Number precision.
  const props = { show: true, itemName: '精确价格', unitPrice: '9007199254740993', currencyLabel: '金币', balance: '9223372036854775807', maxQuantity: '99' };
  const modalRoot = makeNode('root'); roots.push(modalRoot);
  const component = compileSfcModule(path.join(h.WEB, 'src/components/shop/PurchaseQuantityModal.vue'), spec => spec === 'vue' ? vue : spec === '@/utils/commerce-quantity' ? evaluateModule(fs.readFileSync(path.join(h.WEB, 'src/utils/commerce-quantity.ts'), 'utf8'), () => undefined) : undefined);
  render(vue.h(component, props), modalRoot); await flush(); quantity(modalRoot).props['onUpdate:modelValue']('3'); await flush();
  assert.match(textOf(modalRoot), /27,021,597,764,222,979/);
  render(vue.h(component, { ...props, maxQuantity: 0 }), modalRoot); await flush(); assert.equal(button(modalRoot, '确认购买').props.disabled, true);
});
test('account switch, catalog change and unmount discard old confirmations and late writes', async () => {
  const f = setup(); await flush(); click(button(f.root, '选择购买数量')); await flush();
  f.account.value = 'synthetic-b'; await flush(); assert.equal(quantity(f.root), undefined); assert.equal(f.api.calls.post.length, 0);
  click(button(f.root, '选择购买数量')); await flush(); f.state.ordinary = { ...f.state.ordinary, priceDec: '6' }; await f.shop.fetchSeeds('synthetic-b'); await flush(); assert.equal(quantity(f.root), undefined);
  click(button(f.root, '选择购买数量')); await flush(); const gate = deferred(); f.api.setPost(async () => { await gate.promise; return { data: { ok: true } }; });
  click(button(f.root, '确认购买')); await flush(); render(null, f.root); gate.resolve(); await flush(); assert.equal(f.toasts.length, 0);
});
test('ordinary failure releases busy and confirmed success remains success when subsequent refresh fails', async () => {
  const f = setup(); await flush(); f.api.setPost(async () => ({ data: { ok: false, error: '合成拒绝' } }));
  click(button(f.root, '选择购买数量')); await flush(); click(button(f.root, '确认购买')); await flush(); assert.ok(f.toasts.some(row => row[0] === 'error'));
  f.api.setPost(async () => { f.state.failRead = true; return { data: { ok: true } }; });
  click(button(f.root, '选择购买数量')); await flush(); click(button(f.root, '确认购买')); await flush();
  assert.ok(f.toasts.some(row => row[0] === 'success')); assert.equal(f.shop.seeds.length, 1);
});
test('month card and recharge only read after explicit selection, with payment and ownership limits visible', async () => {
  const f = setup(); await flush(); assert.equal(f.api.calls.get.some(row => /monthcard|recharge/.test(row.url)), false);
  click(button(f.root, '道具商店')); await flush(); click(button(f.root, '月卡')); await flush(); assert.match(textOf(f.root), /持有与到期状态以游戏内/);
  click(button(f.root, '充值')); await flush(); assert.match(textOf(f.root), /首充资格以游戏内状态为准/); assert.match(textOf(f.root), /¥1/); assert.equal(f.api.calls.post.length, 0);
});
test('actual Bag/store allocates only selected quantity across exact UIDs and preserves the existing batch entry', async () => {
  const f = setup('bag'); await flush();
  const sell = buttonsOf(f.root).find(node => node.props['aria-label'] === '出售 示例果实');
  assert.ok(sell, buttonsOf(f.root).map(textOf).join('|')); sell.props.onClick({ stopPropagation() {} }); await flush();
  quantity(f.root).props['onUpdate:modelValue']('5'); await flush(); assert.match(textOf(f.root), /15 金币/); assert.equal(f.api.calls.post.length, 0);
  click(button(f.root, '确认出售')); await flush(); assert.equal(f.api.calls.post.length, 1);
  assert.deepEqual(f.api.calls.post[0].body.items, [{ id: 40001, uid: '9007199254740993', count: '4' }, { id: 40001, uid: '9007199254740994', count: '1' }]);
  assert.equal(f.api.calls.post[0].body.explicitBatch, true); assert.ok(f.api.calls.post[0].body.quotes[40001]);
});
test('actual Bag use confirmation and store preserve long UID and quantity without writes before confirmation', async () => {
  const f = setup('bag'); await flush();
  f.state.bag = { items: [{ id: 20001, name: '示例礼包', itemType: 11, usable: true, count: 9007199254740992, countDec: '9007199254740993' }],
    originalItems: [{ id: 20001, uid: 9007199254740992, uidDec: '9007199254740993', countDec: '9007199254740993' }] };
  await f.bagStore.fetchBag('synthetic-a'); await flush();
  click(buttonsOf(f.root).find(node => textOf(node).includes('道具'))); await flush();
  const use = buttonsOf(f.root).find(node => node.props.title === '使用全部'); assert.ok(use);
  use.props.onClick({ stopPropagation() {} }); await flush();
  assert.equal(f.api.calls.post.length, 0);
  assert.match(textOf(f.root).replaceAll(',', ''), /9007199254740993/);
  click(button(f.root, '确认使用')); await flush();
  assert.equal(f.api.calls.post.length, 1);
  assert.equal(f.api.calls.post[0].body.uid, '9007199254740993');
  assert.equal(f.api.calls.post[0].body.count, '9007199254740993');
});
test('a verified free offer with sparse zero-price fields still opens a one-unit zero-cost confirmation', async () => {
  const f = setup(); await flush();
  f.state.goods = { ...f.state.goods, isFree: true, price: { amountDec: '' }, balanceKnown: false, currencyBalance: '',
    limit: { present: true, limitCountDec: '1', boughtNumDec: '0', remainingDec: '1' }, catalogRestricted: { type: 1, times: 1 } };
  await f.shop.fetchMall('synthetic-a'); click(button(f.root, '道具商店')); await flush(); click(button(f.root, '礼包')); await flush();
  click(button(f.root, '选择购买数量')); await flush(); assert.ok(quantity(f.root));
  click(button(f.root, '最大')); await flush(); assert.equal(String(quantity(f.root).value ?? quantity(f.root).props.value), '1');
  assert.match(textOf(f.root), /总消耗：免费/); assert.equal(f.api.calls.post.length, 0);
});
test('fulfilled malformed rows keep the last usable Shop and Bag snapshots instead of crashing templates', async () => {
  const f = setup(); await flush();
  f.api.setGet(async () => ({ data: { ok: true, data: [null] } }));
  await f.shop.fetchSeeds('synthetic-a'); await flush(); assert.equal(f.shop.seeds.length, 1); assert.ok(f.shop.error);
  const bag = setup('bag'); await flush();
  bag.api.setGet(async () => ({ data: { ok: true, data: { items: [null], originalItems: [] } } }));
  await bag.bagStore.fetchBag('synthetic-a'); await flush(); assert.equal(bag.bagStore.items.length, 1); assert.ok(bag.bagStore.error);
});
