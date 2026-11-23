const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const prefix = path.resolve(os.tmpdir(), 'milk-auto-control-');
assert.equal(path.dirname(prefix), fs.realpathSync(os.tmpdir()));
const data = fs.mkdtempSync(prefix);
process.env.FARM_DATA_DIR = data;
process.env.FARM_ACCOUNT_ID = 'synthetic-milk-auto-control';
after(() => fs.rmSync(data, { recursive: true, force: true }));
const store = require('../src/models/store');
const milk = require('../src/services/milk-tea-activity');

test('activity rewards default off and enabling them leaves disabled ordinary tasks unchanged', () => {
  assert.equal(store.getAutomation().milk_tea_auto_rewards, false);
  for (const key of ['milk_tea_auto_seeds', 'milk_tea_auto_work', 'milk_tea_auto_upgrade', 'milk_tea_auto_craft', 'milk_tea_auto_hire', 'milk_tea_auto_open', 'milk_tea_auto_boost']) assert.equal(store.getAutomation()[key], false);
  store.applyConfigSnapshot({ automation: { task: false, milk_tea_auto_rewards: true } }, { persist: false });
  assert.equal(store.getAutomation().task, false);
  assert.equal(store.getAutomation().milk_tea_auto_rewards, true);
  const now = Date.now();
  assert.ok(milk.automaticMilkTeaWakeAt(now) <= now, 'activity wake must not depend on ordinary task preference');
});

test('disabling activity rewards stops their deadline even when ordinary tasks stay enabled', () => {
  store.applyConfigSnapshot({ automation: { task: true, milk_tea_auto_rewards: false } }, { persist: false });
  assert.equal(store.getAutomation().task, true);
  assert.ok(milk.automaticMilkTeaWakeAt(Date.now()) > Date.now() + 60000);
});

test('current unified caller ignores every retired activity flag while preserving ordinary task preferences', async () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../src/core/worker.js'), 'utf8');
  const start = source.indexOf('async function runUnifiedTick(');
  const end = source.indexOf('\n}', start);
  let calls = 0; let guardCalls = 0; let farmCalls = 0; let helpCalls = 0;
  const now = Date.now();
  const auto = { task: false, milk_tea_auto_rewards: true, friend_steal: false };
  const sandbox = {
    Date, unifiedSchedulerRunning: true, loginReady: true, friendSyncPaused: false,
    armOwnHarvestGuard() { guardCalls++; }, runFarmTick: async () => { farmCalls++; }, runHelpTick: async () => { helpCalls++; }, pauseRemainMsNow: () => 0, resumeAceReports() {}, markIdleQuietUntil() {},
    getAutomation: () => auto, ownHarvestDueAt: () => 0, nextScheduledStealAt: () => now + 600000,
    nextFarmRunAt: now + 600000, nextHelpRunAt: now + 600000, nextActivityRewardsAt: () => now,
    nextStealRunAt: now + 600000,
    stealIsImminent: () => false, stealIsDue: () => false, markStealDueAt() {}, STEAL_IDLE_MS: 86400000,
    ownHarvestIsDue: () => false, ownHarvestIsImminent: () => false, OWN_HARVEST_RESERVE_MS: 10000,
    // 真实 runAutomaticMilkTea 依赖注入的真实仓库背包读取在沙箱内的占位（原断言不变）
    getBag: async () => ({}), getBagItems: () => [],
    require: name => {
      assert.equal(name, '../services/milk-tea-activity');
      return { runAutomaticMilkTea: async deps => { assert.equal(deps.canRun(), true); calls++; } };
    },
  };
  vm.createContext(sandbox); vm.runInContext(source.slice(start, end + 2), sandbox);
  await sandbox.runUnifiedTick(); assert.equal(calls, 0);
  auto.task = true; auto.milk_tea_auto_rewards = false;
  await sandbox.runUnifiedTick(); assert.equal(calls, 0);
  for (const key of ['milk_tea_auto_seeds', 'milk_tea_auto_work', 'milk_tea_auto_upgrade', 'milk_tea_auto_craft', 'milk_tea_auto_hire', 'milk_tea_auto_open', 'milk_tea_auto_boost']) {
    auto.task = false; auto[key] = true;
    const before = calls; await sandbox.runUnifiedTick(); assert.equal(calls, before, key);
    auto[key] = false; await sandbox.runUnifiedTick(); assert.equal(calls, before);
  }
  for (const key of ['milk_tea_auto_rewards', 'milk_tea_auto_seeds', 'milk_tea_auto_work', 'milk_tea_auto_upgrade', 'milk_tea_auto_craft', 'milk_tea_auto_hire', 'milk_tea_auto_open', 'milk_tea_auto_boost']) auto[key] = true;
  sandbox.nextFarmRunAt = now - 1; sandbox.nextHelpRunAt = now - 1;
  await sandbox.runUnifiedTick();
  assert.equal(calls, 0); assert.equal(farmCalls, 1); assert.equal(helpCalls, 1);
  assert.ok(guardCalls >= 17, 'own maturity guard is armed independently of old activity preferences');
});

// Current production retirement checks, distinct from the explicit historical
// leaf/store/view fixtures retained by the old milk-tea behavior suites.
const h = require('./activity-availability.test');
const crypto = require('node:crypto');
const protectedFiles = [__filename, '../src/core/worker.js', '../src/runtime/data-provider.js', '../src/controllers/admin-activity-routes.js', '../../web/src/views/Activity.vue', '../../web/src/stores/activity.ts', '../../web/src/components/settings/AutomationSettingsTab.vue'].map(file => path.resolve(__dirname, file));
const sourceFingerprint = () => protectedFiles.map(file => [fs.statSync(file).mode, crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')]);
const sourceBefore = sourceFingerprint();
after(() => assert.deepEqual(sourceFingerprint(), sourceBefore));
const workerFile = path.resolve(__dirname, '../src/core/worker.js');
const source = () => fs.readFileSync(workerFile, 'utf8');
function workerApiFixture() {
  const code = source();
  const start = code.indexOf('const FRIEND_PANEL_ENTRY_METHODS = new Set([');
  const end = code.indexOf('// ==================== 每日礼包总览', start);
  assert.ok(start >= 0 && end > start);
  const replies = []; let oldCalls = 0;
  const sandbox = {
    Date, console, Set, Map, process: { env: {} },
    isRunning: true, loginReady: true, friendSyncPaused: false,
    getWs: () => ({ readyState: 1 }), getBag: async () => ({}), getBagItems: () => [],
    sendToMaster: reply => replies.push(reply), log() {}, getSchedulerRegistrySnapshot: () => [],
    require: name => {
      if (name === '../services/warehouse') return { getBag: async () => ({}), getBagItems: () => [] };
      if (name === '../services/solar-calendar') return { getSolarCalendar: async () => ({ current: true }) };
      if (name === '../services/milk-tea-activity') {
        const call = async () => { oldCalls++; return { legacy: true }; };
        return { getMilkTeaActivity: call, queryMilkTeaActivity: call, runManualMilkTeaAction: call };
      }
      throw new Error('unconfigured isolated dependency');
    },
  };
  vm.createContext(sandbox); vm.runInContext(code.slice(start, end), sandbox);
  return { sandbox, replies, oldCalls: () => oldCalls };
}

test('current parent registry removes all four expired milk-tea routes; current independent entries remain', () => {
  const updatePath = require.resolve('../src/controllers/admin-activity-update-routes');
  const rootPath = require.resolve('../src/controllers/admin-activity-routes');
  const prior = [require.cache[updatePath], require.cache[rootPath]];
  require.cache[updatePath] = { id: updatePath, filename: updatePath, loaded: true, exports: { registerAdminActivityUpdateRoutes() {} } };
  delete require.cache[rootPath];
  try {
    const { registerAdminActivityRoutes } = require(rootPath);
    const routes = new Map(); let calls = 0;
    const app = Object.fromEntries(['get', 'post', 'put', 'delete'].map(method => [method,
      (url, ...handlers) => routes.set(`${method} ${url}`, handlers.at(-1))]));
    const provider = new Proxy({}, { get: () => async () => { calls++; return {}; } });
    registerAdminActivityRoutes({ app, provider, store: {}, getAccountIdFromRequest: () => 'synthetic-current',
      canAccessAccount: () => true, sendProviderError() {}, requireAdminToken: (_req, _res, next) => next?.() });
    for (const entry of ['get /api/activity/milk-tea', 'post /api/activity/milk-tea/query',
      'post /api/activity/milk-tea/operate', 'get /api/activity/milk-tea/seed-catalog'])
      assert.equal(routes.has(entry), false, entry);
    assert.equal(routes.has('get /api/activity/muge'), true);
    assert.equal(routes.has('get /api/activity/official-announcements'), true);
    assert.ok([...routes.keys()].some(key => /festival|solar-calendar/.test(key)));
    assert.equal(calls, 0);
  } finally {
    for (const [index, file] of [updatePath, rootPath].entries()) {
      if (prior[index]) require.cache[file] = prior[index]; else delete require.cache[file];
    }
  }
});

test('current provider has no expired forwarding members, preserving current common/calendar methods', () => {
  const { createDataProvider } = require('../src/runtime/data-provider'); let calls = 0;
  const provider = createDataProvider({ getAccounts: () => ({ accounts: [] }), callWorkerApi: () => { calls++; } });
  for (const method of ['getMilkTeaActivity', 'queryMilkTeaActivity', 'operateMilkTea'])
    assert.equal(provider[method], undefined, method);
  assert.equal(typeof provider.getActivityDiscoveryList, 'function');
  assert.equal(typeof provider.getSolarCalendar, 'function');
  assert.equal(calls, 0);
});

test('current real Worker API rejects all expired methods before old service, preserving calendar dispatch', async () => {
  const fixture = workerApiFixture();
  for (const method of ['getMilkTeaActivity', 'queryMilkTeaActivity', 'operateMilkTea']) {
    await fixture.sandbox.handleApiCall({ id: method, method, args: [] });
    assert.equal(fixture.replies.at(-1).error, 'Unknown method');
    assert.equal(fixture.oldCalls(), 0);
  }
  await fixture.sandbox.handleApiCall({ id: 'calendar', method: 'getSolarCalendar', args: [] });
  assert.equal(fixture.replies.at(-1).result.current, true);
  assert.equal(fixture.replies.at(-1).error, null);
});

test('current activity deadline is inert even with a restored legacy overdue deadline', () => {
  const code = source(); const start = code.indexOf('function nextActivityRewardsAt('); const end = code.indexOf('\n}', start);
  assert.ok(start >= 0 && end > start); let oldCalls = 0;
  const sandbox = { Date, require: () => ({ automaticMilkTeaWakeAt: () => { oldCalls++; return 1; } }) };
  vm.createContext(sandbox); vm.runInContext(code.slice(start, end + 2), sandbox);
  assert.equal(sandbox.nextActivityRewardsAt(Date.now()), Infinity);
  assert.equal(oldCalls, 0);
});

test('current store and page have zero expired runtime requests through refresh, account change and reentry', async () => {
  const current = h.storeHarness();
  for (const method of ['fetchMilkTeaActivity', 'runMilkTeaQuery', 'operateMilkTea', 'runClaimAll', 'recheckActivity'])
    assert.equal(current.store[method], undefined, method);
  current.api.setGet(async () => ({ data: { ok: true, snapshot: { boxes: {} } } }));
  assert.equal((await current.store.loadUpdate('emails', 'acc-1')).ok, true);
  assert.equal(current.api.calls.post.length, 0);
  const api = h.apiMock();
  api.setGet(async url => {
    if (url.includes('milk-tea')) throw new Error('expired endpoint must never be requested');
    return { data: { ok: true, activity: { available: true, title: '牧歌初启', endTime: null, personal: null, phase: 'open', sections: [], notes: [] } } };
  });
  let page = h.mountActivityPage(api);
  try {
    await h.flush(); assert.match(h.textOf(page.root), /牧歌初启/);
    assert.doesNotMatch(h.textOf(page.root), /奶茶|一键领取|重新检查/);
    h.click(h.buttonsOf(page.root).find(button => h.textOf(button).trim() === '刷新')); await h.flush();
    page.accountRef.value = 'synthetic-b'; page.accountRef.value = 'acc-1'; await h.flush();
    const shared = page.pinia; h.render(null, page.root); page = h.mountActivityPage(api, shared); await h.flush();
    assert.equal(api.calls.get.filter(call => call.url.includes('milk-tea')).length, 0);
    assert.equal(api.calls.post.length, 0);
    assert.ok(api.calls.get.some(call => call.url === '/api/activity/muge'));
  } finally { h.render(null, page.root); }
});

test('current settings renders no retired switches even when saved legacy preferences are all true', () => {
  const api = h.apiMock(); const stub = { render: () => null };
  const resolve = spec => spec === 'vue' ? h.vue : spec === 'pinia' ? h.pinia
    : spec === '@/api' ? { __esModule: true, default: api.instance }
      : ['@/components/ui/BaseSelect.vue', '@/components/ui/BaseInput.vue'].includes(spec) ? { __esModule: true, default: stub } : undefined;
  const component = h.compileSfcModule(path.resolve(__dirname, '../../web/src/components/settings/AutomationSettingsTab.vue'), resolve);
  const root = h.makeNode('root');
  const automation = { harvest: true, milk_tea_auto_rewards: true, milk_tea_auto_seeds: true, milk_tea_auto_work: true,
    milk_tea_auto_upgrade: true, milk_tea_auto_craft: true, milk_tea_auto_hire: true, milk_tea_auto_open: true, milk_tea_auto_boost: true };
  try {
    h.render(h.vue.h(component, { settings: { automation, kickoutRelogin: { delayMinutes: 0, validUntil: '' } },
      autoCodeRefresh: { enabled: false }, fertilizerOptions: [], fertilizerLandTypeOptions: [], currentAccountId: 'synthetic-current' }), root);
    assert.match(h.textOf(root), /自动收菜/);
    assert.doesNotMatch(h.textOf(root), /奶茶/);
    assert.equal(api.calls.get.length, 0); assert.equal(api.calls.post.length, 0);
  } finally { h.render(null, root); }
});

test('current common catalog rejects missing source metadata and preserves the last successful read', async () => {
  const fixture = h.storeHarness();
  const catalog = require('../src/gameConfig/UpdateCatalog.json');
  fixture.api.setGet(async () => ({ data: { ok: true, catalog } }));
  assert.equal((await fixture.store.loadUpdate('catalog', 'acc-1')).ok, true);
  const prior = fixture.store.updateReads.catalog.data;
  fixture.api.setGet(async () => ({ data: { ok: true, catalog: { ...catalog, source: null } } }));
  assert.equal((await fixture.store.loadUpdate('catalog', 'acc-1')).ok, false);
  assert.equal(fixture.store.updateReads.catalog.data, prior);
  assert.match(fixture.store.updateReads.catalog.error, /目录状态不完整/);
});
