'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'); const path = require('node:path');
const h = require('./activity-availability.test');
const { vue, pinia, evaluateModule, compileSfcModule, WEB, render, makeNode, buttonsOf, findAll, textOf, flush, click, deferred } = h;
const clone = value => JSON.parse(JSON.stringify(value));
const previousAdd = document.addEventListener; const previousRemove = document.removeEventListener;
const listeners = new Set();
document.addEventListener = (_event, callback) => listeners.add(callback);
document.removeEventListener = (_event, callback) => listeners.delete(callback);
test.after(() => { assert.equal(listeners.size, 0); document.addEventListener = previousAdd; document.removeEventListener = previousRemove; });
async function fixture(t) {
  const account = vue.ref('synthetic-settings');
  const alerts = []; const calls = [];
  const saved = { automation: { task: false, milk_tea_auto_rewards: false } };
  const api = { fail: false, pending: null,
    async get() { return { data: { ok: true, data: clone(saved) } }; },
    async post(url, body) { calls.push({ url, body: clone(body) }); if (api.pending) await api.pending.promise;
      if (api.fail) return { data: { ok: false, error: 'synthetic save rejected' } };
      if (url === '/api/automation') {
        const { milk_tea_control: milkControl, ...ordinary } = clone(body);
        saved.automation = { ...saved.automation, ...ordinary, ...milkControl };
      } return { data: { ok: true } }; },
  };
  const useAccountStore = pinia.defineStore('account', () => ({ currentAccountId: account }));
  let settingModule;
  const resolve = spec => spec === 'vue' ? vue : spec === 'pinia' ? pinia : spec === '@/api' ? { __esModule: true, default: api }
    : spec === '@/stores/account' ? { useAccountStore } : spec === '@/stores/setting' ? settingModule : undefined;
  settingModule = evaluateModule(fs.readFileSync(path.join(WEB, 'src/stores/setting.ts'), 'utf8'), resolve);
  const composition = evaluateModule(fs.readFileSync(path.join(WEB, 'src/composables/settings/useAutomationSettings.ts'), 'utf8'), resolve);
  const testPinia = pinia.createPinia(); pinia.setActivePinia(testPinia);
  const store = settingModule.useSettingStore(); await store.fetchSettings(account.value);
  const Tab = compileSfcModule(path.join(WEB, 'src/components/settings/AutomationSettingsTab.vue'), resolve);
  const root = makeNode('root'); let control;
  const Page = { setup() {
    control = composition.useAutomationSettings({ currentAccountId: account, showAlert: (...args) => alerts.push(args) }); control.syncLocalAutomationSettings();
    return () => vue.h(Tab, { currentAccountId: account.value, currentAccountName: 'Synthetic long account name', loading: store.loading, saving: control.automationSaving.value,
      autoCodeRefreshing: false, fertilizerLandTypeOptions: [], fertilizerOptions: [], settings: control.localAutomationSettings.value, autoCodeRefresh: control.localAutoCodeRefresh.value,
      'onUpdate:settings': value => { control.localAutomationSettings.value = value; }, onSave: control.saveAutomationSettings });
  } };
  function mount() { render(vue.h(Page), root); }
  mount(); t.after(() => render(null, root));
  return { root, alerts, calls, account, api, store, get control() { return control; }, reload: () => { render(null, root); mount(); }, saved: () => saved };
}
const button = (root, label) => { const node = buttonsOf(root).find(node => textOf(node).trim() === label); assert.ok(node, label); return node; };
function checkbox(root, label) { const node = findAll(root, row => row.tag === 'label' && textOf(row).trim() === label)[0]; assert.ok(node, label); return findAll(node, row => row.tag === 'input')[0]; }
async function toggle(f, label, value) { checkbox(f.root, label).props['onUpdate:modelValue'](value); await vue.nextTick(); }
function input(f, label, value) { const parent = findAll(f.root, row => row.tag === 'label' && textOf(row).trim() === label)[0]; assert.ok(parent, label); const node = findAll(parent, row => row.tag === 'input')[0]; node.props.onInput({ target: { value } }); }

test('real account component, composition and Pinia store save and reload new policies without ordinary tasks', async t => {
  const f = await fixture(t);
  for (const label of ['自动购买活动种子', '自动班次工作（互动与工资）', '自动升级店铺']) await toggle(f, label, true);
  await toggle(f, '森野甜莓种子', true); await toggle(f, '森野黄金芽种子', true);
  click(button(f.root, '展开高级预算')); await vue.nextTick(); input(f, '奶茶券每日上限', '8000');
  const select = findAll(f.root, row => row.tag === 'select' && row.props['aria-label'] === '互动方式')[0]; assert.ok(select); select.props.onChange({ target: { value: '3' } });
  assert.equal(f.calls.length, 0, 'editing and expanding are local operations');
  click(button(f.root, '保存自动控制')); await flush();
  const body = f.calls.find(call => call.url === '/api/automation').body;
  const payload = body.milk_tea_control;
  assert.equal(payload.milk_tea_auto_seeds, true); assert.equal(payload.milk_tea_auto_work, true); assert.equal(payload.milk_tea_auto_upgrade, true);
  assert.equal(payload.milk_tea_auto_rewards, false); assert.equal(body.task, false); assert.equal(payload.milk_tea_work_interaction_type, 3);
  assert.deepEqual(payload.milk_tea_seed_policy.targetSeedIds, [20525, 29005]); assert.equal(payload.milk_tea_seed_policy.ticketDailyLimit, '8000');
  f.reload(); await flush(); assert.equal(checkbox(f.root, '自动购买活动种子').checked, true); assert.equal(checkbox(f.root, '森野黄金芽种子').checked, true);
});
test('ordinary response failure and rejected save show failure and release loading, never false success', async t => {
  for (const mode of ['response', 'throw']) {
    const f = await fixture(t); f.api.fail = true;
    if (mode === 'throw') f.api.post = async () => { throw new Error('synthetic transport reject'); };
    await toggle(f, '自动升级店铺', true); click(button(f.root, '保存自动控制')); await flush();
    assert.equal(f.control.automationSaving.value, false); assert.ok(f.alerts.some(row => row[1] === 'danger')); assert.equal(f.alerts.some(row => row[0] === '自动控制设置已保存'), false);
    render(null, f.root);
  }
});
test('save captures all milk authorization before awaiting; later local mutations need another save', async t => {
  const f = await fixture(t); f.api.pending = deferred();
  await toggle(f, '自动购买活动种子', true); await toggle(f, '森野甜莓种子', true);
  click(button(f.root, '保存自动控制')); await vue.nextTick();
  assert.equal(f.control.automationSaving.value, true);
  f.control.localAutomationSettings.value.automation.milk_tea_auto_work = true;
  f.control.localAutomationSettings.value.automation.milk_tea_seed_policy.targetSeedIds = [20526];
  f.control.localAutomationSettings.value.automation.milk_tea_seed_policy.coinDailyLimit = '999999';
  f.api.pending.resolve(); await flush();
  const payload = f.calls.find(call => call.url === '/api/automation').body.milk_tea_control;
  assert.equal(payload.milk_tea_auto_seeds, true); assert.equal(payload.milk_tea_auto_work, false);
  assert.deepEqual(payload.milk_tea_seed_policy.targetSeedIds, [20525]);
  assert.equal(payload.milk_tea_seed_policy.coinDailyLimit, '240000');
});
test('invalid budgets block saving and unmount/account change invalidates a pending save notification', async t => {
  const invalid = await fixture(t); await toggle(invalid, '自动购买活动种子', true);
  invalid.control.localAutomationSettings.value.automation.milk_tea_seed_policy.coinDailyLimit = '-1';
  click(button(invalid.root, '保存自动控制')); await flush(); assert.equal(invalid.calls.length, 0); assert.ok(invalid.alerts.some(row => row[1] === 'danger')); render(null, invalid.root);
  for (const mode of ['unmount', 'account']) {
    const f = await fixture(t); f.api.pending = deferred(); await toggle(f, '自动升级店铺', true);
    click(button(f.root, '保存自动控制')); await vue.nextTick(); assert.equal(f.control.automationSaving.value, true);
    if (mode === 'unmount') render(null, f.root); else f.account.value = 'synthetic-settings-other';
    await vue.nextTick(); f.api.pending.resolve(); await flush(); assert.equal(f.alerts.length, 0); assert.equal(f.calls.length, 1, 'stale save cannot start the subsequent automation request');
    render(null, f.root);
  }
});
test('backend account/default-plan persistence deeply clones policies and invalid values cannot enable spending', () => {
  const store = require('../src/models/store'); const automation = { milk_tea_auto_seeds: true, milk_tea_auto_work: true, milk_tea_auto_upgrade: true, milk_tea_work_interaction_type: 3,
    milk_tea_seed_policy: { targetSeedIds: [20525], targetStock: 24, coinReserve: '1000000', coinDailyLimit: '240000', ticketReserve: '8000', ticketDailyLimit: '0' } };
  store.applyConfigSnapshot({ automation }, { accountId: 'synthetic-persistent' });
  store.setUserDefaultAccountPlan('synthetic-plan-user', { automation });
  const snapshot = store.getConfigSnapshot('synthetic-persistent'); snapshot.automation.milk_tea_seed_policy.targetSeedIds.push(20526);
  assert.deepEqual(store.getAutomation('synthetic-persistent').milk_tea_seed_policy.targetSeedIds, [20525]);
  const modulePath = require.resolve('../src/models/store'); delete require.cache[modulePath]; const reloaded = require(modulePath);
  assert.equal(reloaded.getAutomation('synthetic-persistent').milk_tea_auto_work, true);
  assert.equal(reloaded.getUserDefaultAccountPlan('synthetic-plan-user').config.automation.milk_tea_auto_upgrade, true);
  reloaded.applyConfigSnapshot({ automation: { milk_tea_auto_seeds: 'false', milk_tea_seed_policy: { ...automation.milk_tea_seed_policy, coinDailyLimit: 'bad' } } }, { persist: false, accountId: 'synthetic-persistent' });
  assert.equal(reloaded.getAutomation('synthetic-persistent').milk_tea_auto_seeds, false);
  assert.deepEqual(reloaded.getAutomation('synthetic-persistent').milk_tea_seed_policy.targetSeedIds, []);
});

test('old save finally cannot clear a new account read loading owner', async t => {
  const f = await fixture(t); f.api.pending = deferred();
  await toggle(f, '自动升级店铺', true); click(button(f.root, '保存自动控制')); await vue.nextTick();
  f.account.value = 'synthetic-next-read'; await vue.nextTick();
  const fresh = deferred(); f.api.get = () => fresh.promise;
  const read = f.store.fetchSettings(f.account.value); await vue.nextTick();
  f.api.pending.resolve(); await flush(); assert.equal(f.store.loading, true);
  fresh.resolve({ data: { ok: true, data: { automation: { milk_tea_auto_upgrade: false } } } }); await read;
  assert.equal(f.store.loading, false); assert.equal(f.alerts.length, 0);
});

test('real settings component renders absent or partial legacy policy without a crash or invented zero budget', () => {
  const Component = compileSfcModule(path.join(WEB, 'src/components/settings/MilkTeaAutomationSettings.vue'), spec => spec === 'vue' ? vue : undefined);
  for (const policy of [undefined, {}, { targetSeedIds: null, targetStock: 3 }]) {
    const root = makeNode('root');
    try {
      assert.doesNotThrow(() => render(vue.h(Component, { automation: { milk_tea_auto_seeds: true, milk_tea_seed_policy: policy } }), root));
      if (policy) assert.match(textOf(root), /请修正后保存/);
    } finally { render(null, root); }
  }
});

test('real settings payload, route and provider publish milk authorization as one complete snapshot', async t => {
  const f = await fixture(t); const backend = require('../src/models/store');
  const id = f.account.value; const snapshots = []; let revision = 0;
  backend.applyConfigSnapshot({ automation: { milk_tea_auto_seeds: false, milk_tea_auto_work: false, milk_tea_auto_upgrade: false, milk_tea_seed_policy: { targetSeedIds: [20525], targetStock: 24, coinReserve: '1000000', coinDailyLimit: '240000', ticketReserve: '8000', ticketDailyLimit: '0' } } }, { persist: false, accountId: id });
  const provider = require('../src/runtime/data-provider').createDataProvider({ store: backend, workers: {}, globalLogs: [], accountLogs: [],
    getAccounts: () => ({ accounts: [{ id }] }), nextConfigRevision: () => ++revision, scheduleAutoCodeRefresh() {},
    broadcastConfigToWorkers: accountId => snapshots.push(clone(backend.getAutomation(accountId))), callWorkerApi: () => { throw new Error('No game calls in configuration fixture'); } });
  const routes = new Map(); const app = {};
  for (const method of ['get', 'post', 'put', 'delete']) app[method] = (url, handler) => routes.set(`${method} ${url}`, handler);
  require('../src/controllers/admin-farm-resource-routes').registerAdminFarmResourceRoutes({ app, provider, getAccountIdFromRequest: () => id, canAccessAccount: () => true });
  f.api.get = async () => ({ data: { ok: true, data: backend.getConfigSnapshot(id) } });
  f.api.post = async (url, body) => {
    f.calls.push({ url, body: clone(body) });
    if (url === '/api/settings/save') return { data: { ok: true, data: await provider.saveSettings(id, body) } };
    assert.equal(url, '/api/automation');
    const res = { status() { return this; }, json(value) { this.value = value; return this; } };
    await routes.get('post /api/automation')({ body }, res); return { data: res.value };
  };
  await toggle(f, '自动购买活动种子', true); await toggle(f, '自动班次工作（互动与工资）', true); await toggle(f, '自动升级店铺', true);
  await toggle(f, '森野白桃种子', true);
  click(button(f.root, '展开高级预算')); await vue.nextTick();
  input(f, '每种种子库存目标（颗）', '12'); input(f, '金币每日上限', '120000');
  const selection = findAll(f.root, row => row.tag === 'select' && row.props['aria-label'] === '互动方式')[0];
  selection.props.onChange({ target: { value: '3' } });
  click(button(f.root, '保存自动控制')); await flush();
  assert.ok(snapshots.some(row => row.milk_tea_auto_seeds === true), 'actual provider/store must apply the new configuration');
  for (const row of snapshots) if (row.milk_tea_auto_seeds || row.milk_tea_auto_work || row.milk_tea_auto_upgrade) {
    assert.deepEqual(row.milk_tea_seed_policy.targetSeedIds, [20526], 'no broadcast may enable new automation against the old selected target');
    assert.equal(row.milk_tea_auto_seeds, true); assert.equal(row.milk_tea_auto_work, true); assert.equal(row.milk_tea_auto_upgrade, true);
    assert.equal(row.milk_tea_seed_policy.targetStock, 12); assert.equal(row.milk_tea_seed_policy.coinDailyLimit, '120000'); assert.equal(row.milk_tea_work_interaction_type, 3);
  }
  assert.deepEqual(backend.getAutomation(id).milk_tea_seed_policy.targetSeedIds, [20526]);
  assert.equal(snapshots.filter(row => row.milk_tea_auto_seeds).length, 1, 'milk policy is published once as a complete group');
  await provider.setAutomation(id, 'milk_tea_control', { milk_tea_auto_rewards: true, task: true, friend_bad: true });
  assert.equal(backend.getAutomation(id).task, false); assert.equal(backend.getAutomation(id).friend_bad, false);
  assert.equal(backend.getAutomation(id).milk_tea_control, undefined);
  await assert.rejects(provider.setAutomation(id, 'milk_tea_control', null), /Invalid milk automation settings/);
  const file = h.assertWriteInsidePrivateDir(path.join(h.privateDir, 'store.json'));
  const disk = fs.readFileSync(file); const before = backend.getAutomation(id); const broadcasts = snapshots.length;
  const rename = fs.renameSync;
  fs.renameSync = (src, dest) => {
    const target = h.assertWriteInsidePrivateDir(dest);
    if (target === file) throw new Error('synthetic milk config persistence failure');
    return rename(src, dest);
  };
  try {
    await assert.rejects(provider.setAutomation(id, 'milk_tea_control', { ...before, milk_tea_auto_seeds: false,
      milk_tea_seed_policy: { ...before.milk_tea_seed_policy, targetSeedIds: [20525] } }), /synthetic milk config persistence failure/);
  } finally { fs.renameSync = rename; }
  assert.deepEqual(backend.getAutomation(id), before, 'failed group persistence rolls back the complete in-memory snapshot');
  assert.equal(fs.readFileSync(file).equals(disk), true); assert.equal(snapshots.length, broadcasts, 'provider must not broadcast an uncommitted authorization');
  await provider.setAutomation(id, 'milk_tea_control', { ...before, milk_tea_auto_seeds: false });
  assert.equal(backend.getAutomation(id).milk_tea_auto_seeds, false); assert.equal(snapshots.length, broadcasts + 1);
});
