'use strict';
// Real DefaultPlan / Strategy / Timing / Automation / UI SFCs; only the API is replaced.
// The existing helper creates an independent FARM_DATA_DIR before loading dependencies,
// checks the write boundary, fingerprints candidate sources, and removes its fixture.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const originalDocument = globalThis.document;
const originalWindow = globalThis.window;
const originalDataDir = process.env.FARM_DATA_DIR;
const documentListeners = new Set();
globalThis.document = {
  createElement: () => ({ innerHTML: '', content: null }),
  addEventListener: (_event, listener) => documentListeners.add(listener),
  removeEventListener: (_event, listener) => documentListeners.delete(listener),
};
const h = require('./activity-availability.test');
const { WEB, vue, compileSfcModule, render, makeNode, textOf, findAll, buttonsOf, click, flush } = h;
assert.ok(h.isInsideOrEqualDir(fs.realpathSync(h.privateDir), fs.realpathSync(os.tmpdir())));
assert.equal(process.env.FARM_DATA_DIR, h.privateDir);

test.after(() => {
  assert.equal(documentListeners.size, 0, 'all real BaseSelect document listeners must be released');
  if (originalDocument === undefined) delete globalThis.document;
  else globalThis.document = originalDocument;
  if (originalWindow === undefined) delete globalThis.window;
  else globalThis.window = originalWindow;
  if (originalDataDir === undefined) delete process.env.FARM_DATA_DIR;
  else process.env.FARM_DATA_DIR = originalDataDir;
});

const clone = value => JSON.parse(JSON.stringify(value));
const endpoint = '/api/settings/default-plan';
const seeds = [
  { seedId: 101, name: 'Synthetic seed A', count: 2, requiredLevel: 1, plantSize: 1 },
  { seedId: 202, name: 'Synthetic seed B', count: 3, requiredLevel: 2, plantSize: 2 },
];

function completeConfig(quietEnabled = false) {
  return {
    plantingStrategy: 'bag_priority', preferredSeedId: 101, prioritize2x2Crops: false,
    bagSeedPriority: [101, 202], bagSeedKnownIds: [101, 202], bagSeedFallbackStrategy: 'level',
    stealDelaySeconds: 1, plantOrderRandom: false, plantDelaySeconds: 2,
    intervals: { farmMin: 8, farmMax: 12, helpMin: 30, helpMax: 35, stealMin: 25, stealMax: 30 },
    friendQuietHours: {
      enabled: quietEnabled, start: '23:00', end: '07:00', minSleepMinutes: 1,
      maxSleepMinutes: 120, wakeBeforeMinutes: 66, watchlistWakeBeforeMinutes: 122,
      pauseUntil: '', idleProtectionEnabled: false,
    },
    automation: {
      farm: false, harvest: false, plant: false, task: false, sell: false, friend: false,
      farm_push: false, land_upgrade: false, friend_steal: false, friend_help: false,
      friend_bad: false, friend_golden_bug: false, friend_help_exp_limit: false,
      golden_bug_clear: true, fertilizer_gift: false, fertilizer_buy_organic: true,
      fertilizer_buy_normal: false, mystery_shop_auto_buy: false, mystery_shop_allow_gold: true,
      mystery_shop_allow_coupon: false, mystery_shop_allow_gold_bean: false,
      fertilizer: 'none', skip_own_weed_bug: false, fertilizer_multi_season: false,
      fertilizer_land_types: ['purple', 'gold', 'black', 'red', 'normal'], fertilizer_smart_seconds: 300,
    },
    autoAcceptFriendMinLevel: 0, kickoutRelogin: { delayMinutes: 0, validUntil: '' },
    fertilizerBuyOrganicCount: 2, fertilizerBuyOrganicThresholdHours: 10,
    fertilizerBuyNormalCount: 3, fertilizerBuyNormalThresholdHours: 11,
    fertilizerBuyCheckIntervalMinutes: 60, goldenBugKeepCount: 0, goldenBugRoundLimit: 24,
    autoCodeRefresh: { enabled: false, intervalMinutes: 60 },
    compatibilityPayload: { revision: 7, values: ['synthetic passthrough'] },
  };
}

async function mountPage(t, config = completeConfig()) {
  const calls = [];
  const notifications = [];
  let stored = { exists: true, enabled: true, updatedAt: 1, config: clone(config) };
  const api = {
    failure: null,
    async get(url) {
      if (url === '/api/activity/milk-tea/seed-catalog') return { data: { ok: true, seeds: [{id:20525,name:'森野甜莓种子'},{id:21435,name:'森野柿子种子'}] } };
      assert.equal(url, endpoint, 'no production or unrelated API calls');
      calls.push({ method: 'get', url });
      return { data: { ok: true, data: clone(stored) } };
    },
    async put(url, body) {
      assert.equal(url, endpoint, 'no production or unrelated API calls');
      calls.push({ method: 'put', url, body: clone(body) });
      if (api.failure === 'throw') throw new Error('synthetic transport failure');
      if (api.failure === 'response')
        return { data: { ok: false, error: 'synthetic rejected save', data: clone(stored) } };
      stored = { exists: true, enabled: body.enabled, updatedAt: stored.updatedAt + 1, config: clone(body.config) };
      return { data: { ok: true, data: clone(stored) } };
    },
  };
  const Page = compileSfcModule(path.join(WEB, 'src/components/settings/DefaultPlanSettingsTab.vue'), spec => {
    if (spec === 'vue') return vue;
    if (spec === '@/api') return { __esModule: true, default: api };
    return undefined;
  });
  const page = { root: null, api, calls, notifications };
  function unmount() {
    if (page.root) render(null, page.root);
    page.root = null;
  }
  function mount() {
    page.root = makeNode('root');
    render(vue.h(Page, {
      currentAccountId: 'synthetic-offline-account', currentAccountName: 'Synthetic account',
      plantingStrategyOptions: [{ label: 'Synthetic bag strategy', value: 'bag_priority' }],
      preferredSeedOptions: seeds.map(seed => ({ label: seed.name, value: seed.seedId })),
      bagFallbackStrategyOptions: [{ label: 'Synthetic level fallback', value: 'level' }],
      bagSeeds: clone(seeds), bagSeedsLoading: false, bagSeedsError: null,
      fertilizerLandTypeOptions: [], fertilizerOptions: [{ label: 'Synthetic no fertilizer', value: 'none' }],
      onNotify: (...args) => notifications.push(args),
    }), page.root);
  }
  page.reload = async () => { unmount(); mount(); await flush(); };
  t.after(() => { unmount(); assert.equal(documentListeners.size, 0); });
  mount();
  await flush();
  assert.equal(calls.length, 1);
  assert.match(textOf(page.root), /默认策略/);
  return page;
}

function button(root, label) {
  const found = buttonsOf(root).find(node => textOf(node).trim() === label);
  assert.ok(found, `missing real button: ${label}`);
  return found;
}

function input(root, label) {
  const direct = findAll(root, node => node.tag === 'input' && node.props['aria-label'] === label)[0]; if (direct) return direct;
  const found = findAll(root, node => node.tag === 'label' && textOf(node).trim() === label)[0];
  assert.ok(found, `missing real control label: ${label}`);
  const children = findAll(found, node => node.tag === 'input');
  const control = children[0] || findAll(found.parent, node => node.tag === 'input')[0];
  assert.ok(control, `missing real input: ${label}`);
  return control;
}

async function setSwitch(page, label, value) {
  const checkbox = input(page.root, label);
  assert.equal(checkbox.props.type, 'checkbox');
  // Drive the real checkbox's model handler through BaseSwitch and both parent models.
  if (checkbox.props['onUpdate:modelValue']) checkbox.props['onUpdate:modelValue'](value); else checkbox.props.onChange({target:{checked:value}});
  await flush();
  assert.equal(input(page.root, label).props.checked ?? input(page.root, label).checked, value, 'real checkbox must reflect the emitted value');
}

test('dedicated milk rewards switch saves and remounts without enabling ordinary tasks', async t => {
  const config = completeConfig();
  config.automation.milk_tea_auto_rewards = false;
  const page = await mountPage(t, config);
  click(button(page.root, '自动控制')); await vue.nextTick();
  await setSwitch(page, '奶茶自动领奖（满额收银、快乐值）', true);
  const saved = await save(page);
  assert.equal(saved.automation.milk_tea_auto_rewards, true);
  assert.equal(saved.automation.task, false);
  await page.reload();
  click(button(page.root, '自动控制')); await vue.nextTick();
  assert.equal(input(page.root, '奶茶自动领奖（满额收银、快乐值）').checked, true);
  assert.equal(input(page.root, '自动做任务').checked, false);
  await setSwitch(page, '奶茶自动领奖（满额收银、快乐值）', false);
  assert.equal((await save(page)).automation.milk_tea_auto_rewards, false);
});

async function setInput(page, label, value) {
  const control = input(page.root, label);
  assert.equal(typeof control.props.onInput, 'function');
  control.props.onInput({ target: { value: String(value) } });
  await vue.nextTick();
}

async function save(page) {
  click(button(page.root, '保存默认方案'));
  await flush();
  return page.calls.filter(call => call.method === 'put').at(-1).body.config;
}

async function section(page, name) {
  click(button(page.root, name));
  await vue.nextTick();
}

for (const initial of [false, true]) {
  test(`real quiet switch ${initial} -> ${!initial} survives payload, response, repeated save and reload`, async (t) => {
    const page = await mountPage(t, completeConfig(initial));
    assert.equal(input(page.root, '启用静默时段').checked, initial);
    await setSwitch(page, '启用静默时段', !initial);
    for (let attempt = 0; attempt < 2; attempt++) {
      const saved = await save(page);
      assert.equal(saved.friendQuietHours.enabled, !initial, 'PUT must use the edited strategy draft');
      assert.equal(input(page.root, '启用静默时段').checked, !initial, 'response must retain the edit');
    }
    assert.deepEqual(page.notifications, [['默认方案已保存'], ['默认方案已保存']]);
    await page.reload();
    assert.equal(input(page.root, '启用静默时段').checked, !initial);
    for (const time of findAll(page.root, node => node.tag === 'input' && node.props.type === 'time'))
      assert.equal(time.props.disabled, initial);
  });
}

test('real quiet controls retain the complete edited group after save and reload', async (t) => {
  const page = await mountPage(t);
  assert.doesNotMatch(textOf(page.root), /重点好友盯梢窗口/);
  assert.match(textOf(page.root), /不再进行施肥趋势追踪/);
  await setSwitch(page, '启用静默时段', true);
  await setSwitch(page, '重点防护', true);
  const times = findAll(page.root, node => node.tag === 'input' && node.props.type === 'time');
  assert.equal(times.length, 2);
  times[0].props['onUpdate:modelValue']('22:15');
  times[1].props['onUpdate:modelValue']('06:45');
  for (const [label, value] of [
    ['每次最短休息（分钟）', 9], ['每次最长休息（分钟）', 90],
    ['普通好友盯梢窗口 (分钟)', 55],
  ]) await setInput(page, label, value);
  const expected = {
    enabled: true, start: '22:15', end: '06:45', minSleepMinutes: 9, maxSleepMinutes: 90,
    wakeBeforeMinutes: 55, watchlistWakeBeforeMinutes: 122, pauseUntil: '', idleProtectionEnabled: true,
  };
  assert.deepEqual((await save(page)).friendQuietHours, expected);
  await page.reload();
  assert.equal(input(page.root, '每次最短休息（分钟）').props.value, 9);
  assert.equal(input(page.root, '重点防护').checked, true);
  assert.deepEqual((await save(page)).friendQuietHours, expected, 'all fields survive a fresh GET');
});

test('both real sections save their current fields while retaining compatibility config', async (t) => {
  const initial = completeConfig();
  const page = await mountPage(t, initial);
  await setSwitch(page, '启用静默时段', true);
  await setSwitch(page, '优先种植 2×2 作物', true);
  await setInput(page, '种植延迟 (秒)', 7);
  await setInput(page, '偷菜延迟 (秒)', 6);
  await setInput(page, '农场巡查最小 (秒)', 10);
  const downArrow = findAll(page.root, node => String(node.props.class || '').includes('i-carbon-arrow-down'))[0];
  assert.ok(downArrow, 'real seed ordering control');
  click(downArrow.parent);
  await section(page, '自动控制');
  await setSwitch(page, '农场巡查（浇水/除草/除虫）', true);
  await setSwitch(page, '自动好友互动', true);
  await setSwitch(page, '自动放黄金虫', true);
  await setSwitch(page, '启用', true);
  await setInput(page, '购买数量', 8);
  await setInput(page, '检测间隔 (分钟)', 17);
  await setInput(page, '重登延迟 (分钟)', 12);
  await setInput(page, '黄金虫保留数量', 5);
  await setInput(page, '自动通过好友最低等级', 15);
  await setInput(page, '断线重试(分钟)', 45);
  const saved = await save(page);
  assert.equal(saved.friendQuietHours.enabled, true);
  assert.equal(saved.prioritize2x2Crops, true);
  assert.equal(saved.plantDelaySeconds, 7);
  assert.equal(saved.stealDelaySeconds, 6);
  assert.equal(saved.intervals.farmMin, 10);
  assert.deepEqual(saved.bagSeedPriority, [202, 101]);
  assert.equal(saved.automation.farm, true);
  assert.equal(saved.fertilizerBuyOrganicCount, 8);
  assert.equal(saved.fertilizerBuyCheckIntervalMinutes, 17);
  assert.equal(saved.kickoutRelogin.delayMinutes, 12);
  assert.equal(saved.goldenBugKeepCount, 5);
  assert.equal(saved.autoAcceptFriendMinLevel, 15);
  assert.deepEqual(saved.autoCodeRefresh, { enabled: true, intervalMinutes: 45 });
  assert.deepEqual(saved.compatibilityPayload, initial.compatibilityPayload);
  assert.deepEqual(saved.bagSeedKnownIds, initial.bagSeedKnownIds);
  await page.reload();
  assert.equal(input(page.root, '启用静默时段').checked, true);
  assert.equal(input(page.root, '种植延迟 (秒)').props.value, 7);
  await section(page, '自动控制');
  assert.equal(input(page.root, '农场巡查（浇水/除草/除虫）').checked, true);
  assert.equal(input(page.root, '购买数量').props.value, 8);
  assert.deepEqual(await save(page), saved, 'a fresh response must preserve both groups and passthrough fields');
});

for (const failure of ['response', 'throw']) {
  test(`failed save (${failure}) keeps the edited controls and never reports or applies success`, async (t) => {
    const page = await mountPage(t);
    await setSwitch(page, '启用静默时段', true);
    page.api.failure = failure;
    assert.equal((await save(page)).friendQuietHours.enabled, true);
    assert.equal(input(page.root, '启用静默时段').checked, true, 'old failed response must not replace the draft');
    assert.equal(page.notifications.length, 1);
    assert.match(page.notifications[0][0], /synthetic/);
    assert.equal(page.notifications[0][1], 'danger');
    assert.equal(page.calls.filter(call => call.method === 'get').length, 1, 'failed save must not fetch stale config');
    page.api.failure = null;
    assert.equal((await save(page)).friendQuietHours.enabled, true, 'retry must retain the unsaved edit');
    assert.deepEqual(page.notifications[1], ['默认方案已保存']);
  });
}

test('milk seed/work/upgrade preferences and exact budgets survive real default-plan save and remount', async t => {
  const page = await mountPage(t, completeConfig()); await section(page, '自动控制');
  for (const label of ['自动购买活动种子', '自动班次工作（互动与工资）', '自动升级店铺', '森野甜莓种子']) await setSwitch(page, label, true);
  click(button(page.root, '展开高级预算')); await vue.nextTick();
  await setInput(page, '奶茶券每日上限', '0');
  const saved = await save(page);
  assert.equal(saved.automation.milk_tea_auto_seeds, true); assert.equal(saved.automation.milk_tea_auto_work, true); assert.equal(saved.automation.milk_tea_auto_upgrade, true);
  assert.deepEqual(saved.automation.milk_tea_seed_policy.targetSeedIds, [20525]); assert.equal(saved.automation.milk_tea_seed_policy.ticketDailyLimit, '0');
  assert.equal(saved.automation.task, false);
  await page.reload(); await section(page, '自动控制'); assert.equal(input(page.root, '森野甜莓种子').props.checked, true);
  page.api.failure = 'response'; await save(page); assert.ok(page.notifications.some(row => row[1] === 'danger'));
});

test('full milk preset and separate hire budget survive default-plan reload and invalid hire policy makes zero PUT', async t => {
  const config = completeConfig();
  config.automation.milk_tea_seed_policy = { targetSeedIds: [21435], targetStock: 24, coinReserve: '1000000', coinDailyLimit: '180000', ticketReserve: '8000', ticketDailyLimit: '0' };
  config.automation.milk_tea_hire_policy = { durationId: 1, ticketDailyLimit: '80', ticketReserve: '9000' };
  const page = await mountPage(t, config); await section(page, '自动控制');
  click(button(page.root, '推荐全自动（保留目标与额度）')); await vue.nextTick();
  const saved = await save(page);
  assert.equal(saved.automation.milk_tea_auto_craft, true); assert.equal(saved.automation.milk_tea_auto_hire, true);
  assert.equal(saved.automation.milk_tea_auto_open, true); assert.equal(saved.automation.milk_tea_auto_boost, false);
  assert.equal(saved.automation.milk_tea_hire_policy.ticketDailyLimit, '80'); assert.equal(saved.automation.milk_tea_seed_policy.ticketDailyLimit, '0');
  assert.deepEqual(saved.automation.milk_tea_seed_policy.targetSeedIds, [21435]);
  await page.reload(); await section(page, '自动控制'); assert.equal(input(page.root, '自动雇佣员工').checked, true);
  click(button(page.root, '展开高级预算')); await vue.nextTick(); await setInput(page, '雇佣每日上限（奶茶券）', '-1');
  const before = page.calls.filter(row => row.method === 'put').length;
  click(button(page.root, '保存默认方案')); await flush();
  assert.equal(page.calls.filter(row => row.method === 'put').length, before); assert.match(page.notifications.at(-1)[0], /雇佣/);
});

test('shared timing panel drops dead steal interval inputs and renders maturity scheduling note', async (t) => {
  const config = completeConfig();
  config.intervals.stealMin = 123;
  config.intervals.stealMax = 456;
  const page = await mountPage(t, config);
  assert.doesNotMatch(textOf(page.root), /偷菜巡查最小|偷菜巡查最大/, 'ineffective steal interval inputs must not render');
  assert.match(textOf(page.root), /偷菜检查按好友作物成熟时间自动安排/);
  assert.match(textOf(page.root), /暂无成熟时间时，约每5–8分钟重新发现/);
  assert.match(textOf(page.root), /重点好友仍按在线状态和成熟时间检查/);
  for (const label of ['农场巡查最小 (秒)', '农场巡查最大 (秒)', '帮助巡查最小 (秒)', '帮助巡查最大 (秒)', '种植延迟 (秒)', '偷菜延迟 (秒)']) {
    const control = input(page.root, label);
    assert.equal(typeof control.props.onInput, 'function', `real control must stay editable: ${label}`);
  }
});

test('non-default steal intervals survive real load, valid timing edits, save and remount', async (t) => {
  const config = completeConfig();
  config.intervals.stealMin = 123;
  config.intervals.stealMax = 456;
  const page = await mountPage(t, config);
  assert.doesNotMatch(textOf(page.root), /偷菜巡查最小/);
  await setInput(page, '农场巡查最小 (秒)', 11);
  await setInput(page, '帮助巡查最大 (秒)', 44);
  await setInput(page, '偷菜延迟 (秒)', 9);
  const saved = await save(page);
  assert.equal(saved.intervals.farmMin, 11);
  assert.equal(saved.intervals.helpMax, 44);
  assert.equal(saved.stealDelaySeconds, 9);
  assert.equal(saved.intervals.stealMin, 123, 'compat stealMin must pass through the real model chain untouched');
  assert.equal(saved.intervals.stealMax, 456, 'compat stealMax must pass through the real model chain untouched');
  await page.reload();
  assert.equal(input(page.root, '农场巡查最小 (秒)').props.value, 11);
  const reloaded = await save(page);
  assert.equal(reloaded.intervals.stealMin, 123);
  assert.equal(reloaded.intervals.stealMax, 456);
  assert.equal(reloaded.intervals.farmMin, 11);
});

test('page load and local timing edits perform zero PUT', async (t) => {
  const config = completeConfig();
  config.intervals.stealMin = 123;
  config.intervals.stealMax = 456;
  const page = await mountPage(t, config);
  assert.equal(page.calls.filter(call => call.method === 'put').length, 0, 'mount must not save');
  await setInput(page, '农场巡查最大 (秒)', 21);
  await setInput(page, '帮助巡查最小 (秒)', 33);
  await setSwitch(page, '启用静默时段', true);
  await flush();
  assert.equal(page.calls.filter(call => call.method === 'put').length, 0, 'local edits must not save');
  assert.equal((await save(page)).intervals.farmMax, 21, 'only an explicit save issues one PUT');
  assert.equal(page.calls.filter(call => call.method === 'put').length, 1, 'explicit save must issue exactly one PUT');
});

for (const failure of ['response', 'throw']) {
  test(`failed save (${failure}) keeps saved compatibility steal intervals after reload`, async (t) => {
    const config = completeConfig();
    config.intervals.stealMin = 123;
    config.intervals.stealMax = 456;
    const page = await mountPage(t, config);
    await setInput(page, '农场巡查最小 (秒)', 13);
    const saved = await save(page);
    assert.equal(saved.intervals.farmMin, 13);
    assert.equal(saved.intervals.stealMin, 123);
    assert.equal(saved.intervals.stealMax, 456);
    page.api.failure = failure;
    await setInput(page, '帮助巡查最小 (秒)', 31);
    await save(page);
    assert.equal(page.notifications.at(-1)[1], 'danger');
    await page.reload();
    page.api.failure = null;
    const retained = await save(page);
    assert.equal(page.notifications.at(-1)[0], '默认方案已保存', 'normal saving must recover after re-entry');
    assert.equal(retained.intervals.stealMin, 123, 'saved compat stealMin survives a failed save and reload');
    assert.equal(retained.intervals.stealMax, 456, 'saved compat stealMax survives a failed save and reload');
    assert.equal(retained.intervals.farmMin, 13);
    assert.equal(retained.intervals.helpMin, 30, 'reloaded draft must come from the stored config, not the unsaved edit');
  });
}
