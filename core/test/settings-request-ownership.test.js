'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const axios = require(path.resolve(__dirname, '../../web/node_modules/axios'));
const h = require('./activity-availability.test');
const { WEB, vue, pinia, evaluateModule } = h;
function fixture() {
  const selected = vue.ref('synthetic-A'), storageSelected = vue.ref('synthetic-A'), token = vue.ref('synthetic-authorization');
  const writes = [], configs = [];
  const api = evaluateModule(fs.readFileSync(path.join(WEB, 'src/api/index.ts'), 'utf8'), name => ({
    '@vueuse/core': { useStorage: key => key === 'current_account_id' ? storageSelected : token },
    axios: { __esModule: true, default: axios }, '@/stores/toast': { useToastStore: () => ({ error() {}, warning() {} }) },
    '@/utils/daily-feedback': { currentFeedbackTrace: () => null, recordClientFailure() {} },
    '@/utils/request-diagnostics': { requestOperation: () => 'settings' }, '@/utils/safe-redirect': { resolveSafeRedirect: () => '' },
  })[name], 'api/index.ts').default;
  let release, waiting;
  const gate = new Promise(resolve => { release = resolve; });
  const entered = new Promise(resolve => { waiting = resolve; });
  api.interceptors.request.use(async config => { if (config.method === 'post') { waiting(); await gate; } return config; });
  api.defaults.adapter = async config => {
    configs.push(config);
    if (config.method === 'post') writes.push({ account: config.headers['x-account-id'], body: JSON.parse(config.data) });
    return { status: 200, statusText: 'OK', headers: {}, config, data: { ok: true, data: {} } };
  };
  const policy = evaluateModule(fs.readFileSync(path.join(WEB, 'src/utils/request-policy.ts'), 'utf8'), () => undefined, 'request-policy.ts');
  const mod = evaluateModule(fs.readFileSync(path.join(WEB, 'src/stores/setting.ts'), 'utf8'), name => ({
    pinia, vue, '@/api': { __esModule: true, default: api }, '@/stores/account': { useAccountStore: () => ({ currentAccountId: selected }) },
    '@/utils/request-policy': policy,
  })[name], 'setting.ts');
  return { store: mod.useSettingStore(pinia.createPinia()), selected, storageSelected, writes, configs, release, entered };
}
test('actual Axios shared interceptor cannot retarget a settings write after account switch before dispatch', async () => {
  const f = fixture(); const pending = f.store.saveSettings('synthetic-A', { requestPolicy: { enabled: false, total60s: 80, friend60s: 40, method60s: 30 } });
  await f.entered; f.selected.value = 'synthetic-B'; f.storageSelected.value = 'synthetic-B'; f.release();
  await assert.rejects(pending, /账号或设置页面已变化/);
  assert.equal(f.writes.length, 0); assert.equal(f.configs.length, 0);
});
test('saved policy is frozen at click and final account pin survives an overriding shared interceptor', async () => {
  const f = fixture(); const draft = { requestPolicy: { enabled: false, total60s: 120, friend60s: 50, method60s: 30, rosterBonusPer100: 60 } };
  const pending = f.store.saveSettings('synthetic-A', draft); await f.entered;
  draft.requestPolicy.enabled = true; draft.requestPolicy.friend60s = 999; draft.requestPolicy.rosterBonusPer100 = 0;
  f.storageSelected.value = 'synthetic-B'; f.release(); await pending;
  assert.equal(f.writes.length, 1); assert.equal(f.writes[0].account, 'synthetic-A');
  assert.equal(f.writes[0].body.requestPolicy.enabled, false); assert.equal(f.writes[0].body.requestPolicy.friend60s, 50);
  assert.equal(f.writes[0].body.requestPolicy.rosterBonusPer100, 60);
});
