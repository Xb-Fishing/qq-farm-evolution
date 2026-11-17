'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const h = require('./activity-availability.test');
const { DEFAULT_POLICY } = require('../src/services/ranch-policy');
const state = () => ({ level: 1, grass: '30', currencies: [], facilities: [], cubs: [], inventory: [],
  animals: [{ id: 7, ranchId: '11', name: '鸡', canProduce: true }], tasks: [], lastOperation: null });
const roots = [];
test.after(() => { for (const root of roots) h.render(null, root); });
function fixture() {
  const posts = []; let read = async () => ({ data: { ok: true, data: state() } }); let prepare;
  const api = {
    get: async (url, config) => url.endsWith('/automation') ? { data: { ok: true, data: { policy: { ...DEFAULT_POLICY }, revision: 0 } } } : read(url, config),
    post: async (url, body, config) => {
      posts.push({ url, body, config });
      if (url.endsWith('/prepare')) return prepare ? prepare() : { data: { ok: true, data: { id: 'synthetic-quote', label: '牧场生产', count: 1, costItems: [], expiresAt: Date.now() + 60000 } } };
      if (url.endsWith('/automation')) return { data: { ok: true, data: { policy: body, revision: 1 } } };
      return { data: { ok: true, data: { outcome: 'confirmed', completed: 1, rewards: [], snapshot: state() } } };
    },
  };
  const p = h.pinia.createPinia(); h.pinia.setActivePinia(p);
  let storeModule;
  // The custom renderer has no DOM classList; only CSS transitions are replaced.
  const vue = { ...h.vue, Transition: { setup: (_props, { slots }) => () => slots.default?.() } };
  const resolve = spec => spec === 'vue' ? vue : spec === 'pinia' ? h.pinia
    : spec === '@/api' ? { __esModule: true, default: api } : spec === '@/stores/ranch' ? storeModule : undefined;
  storeModule = h.evaluateModule(fs.readFileSync(path.join(h.WEB, 'src/stores/ranch.ts'), 'utf8'), resolve);
  const store = storeModule.useRanchStore(p);
  const Panel = h.compileSfcModule(path.join(h.WEB, 'src/components/activity/RanchPanel.vue'), resolve);
  const root = h.makeNode('root'); roots.push(root);
  const mount = id => h.render(h.vue.h(Panel, { accountId: id }), root);
  mount('account-a');
  return { root, store, posts, mount, read: fn => { read = fn; }, prepare: fn => { prepare = fn; } };
}
const button = (root, label) => h.buttonsOf(root).find(x => h.textOf(x).includes(label));
test('real ranch panel prepares then confirms once; free and paid automation preferences save for selected account', async () => {
  const f = fixture(); await h.flush(); assert.equal(f.posts.length, 0);
  h.click(button(f.root, '一键生产')); await h.flush();
  assert.equal(f.posts.length, 1); assert.equal(f.posts[0].url, '/api/ranch/prepare');
  assert.match(h.textOf(f.root), /无额外物品消耗/);
  h.click(button(f.root, '确认执行')); await h.flush();
  assert.equal(f.posts.filter(x => x.url.endsWith('/operate')).length, 1); assert.match(h.textOf(f.root), /操作已确认/);
  const form = h.findAll(f.root, x => x.tag === 'form')[0];
  const checkbox = h.findAll(form, x => x.tag === 'input' && x.props.type === 'checkbox')[0];
  checkbox.props['onUpdate:modelValue'](true); await h.vue.nextTick();
  form.props.onSubmit({ preventDefault() {} }); await h.flush();
  const saved = f.posts.find(x => x.url.endsWith('/automation'));
  assert.equal(saved.body.enabled, true); assert.equal(saved.body.buyEnabled, false);
  assert.equal(saved.config.headers['x-account-id'], 'account-a');
});
test('switch and unload discard stale reads and confirmations; failed refresh retains confirmed result and blocks actions', async () => {
  const f = fixture(); await h.flush(); const pending = h.deferred(); f.prepare(() => pending.promise);
  const preparing = f.store.prepare('produce', { all: true }); f.mount('account-b'); await h.flush();
  pending.resolve({ data: { ok: true, data: { id: 'old' } } }); await preparing;
  assert.equal(f.store.accountId, 'account-b'); assert.equal(f.store.quote, null);
  f.store.result = { outcome: 'confirmed', message: 'confirmed reward', rewards: [{ name: '果实', count: '2' }] };
  f.read(async () => { throw new Error('synthetic read failed'); }); await f.store.refresh(); await h.flush();
  assert.equal(f.store.result.outcome, 'confirmed'); assert.equal(f.store.blocked, true); assert.match(h.textOf(f.root), /果实/);
  const read = h.deferred(); f.read(() => read.promise); const request = f.store.refresh();
  h.render(null, f.root); read.resolve({ data: { ok: true, data: { ...state(), level: 99 } } }); await request;
  assert.notEqual(f.store.state.level, 99); assert.equal(f.store.quote, null);
});
test('placement selector visibly uses the same eligible default and edited destination as its quote', async () => {
  const f = fixture(); await h.flush();
  const ranch = id => ({ id, name: '栏舍' + id, level: 1, active: true, ranch: { husbandryType: 1, count: 0, capacity: 4, animals: [], shelves: [], hazards: [] } });
  f.read(async () => ({ data: { ok: true, data: { ...state(), facilities: [ranch('11'), ranch('12')],
    cubs: [{ id: '60001', name: '鸡幼崽', count: '2', husbandryType: 1, locked: false }] } } }));
  await f.store.refresh(); await h.flush();
  const select = h.findAll(f.root, node => node.props['aria-label'] === '鸡幼崽放养栏舍')[0];
  assert.equal(select.props.value, '11'); assert.equal(f.posts.length, 0);
  select.props.onChange({ target: { value: '12' } }); await h.flush();
  h.click(button(f.root, '放养')); await h.flush();
  assert.equal(f.posts[0].body.input.ranchId, '12'); assert.equal(f.posts[0].url, '/api/ranch/prepare');
});
