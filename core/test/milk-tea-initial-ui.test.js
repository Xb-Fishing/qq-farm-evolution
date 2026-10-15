const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('./activity-availability.test');
const { vue, render, textOf, buttonsOf, click, flush, mountActivityPage, apiMock, snapshot, storeHarness, deferred } = h;
const roots = [];
test.after(() => { for (const root of roots) render(null, root); });
function initialState() {
  return snapshot({
    summary: { shopOpenAt: 1, shopName: '测试小店', level: 1, totalRevenue: 1560 },
    inventory: { available: true, ticketCount: 17, boostItemCount: 2 },
    growthFund: { unlocked: false, tiers: [{ tierId: 1, state: 0, reward: [] }] },
    shareReward: { currentScore: 0, daily: { rewardClaimed: false, claimedCount: 0, claimLimit: 1 }, milestones: [] },
    gameplay: {
      shop: { available: true, error: '', data: { slots: [], pendingRewards: [{ id: 1041, count: 9 }], secPerCup: 20, nextFullAt: 0 } },
      workshop: { available: true, error: '', data: {
        recipes: [{ recipeId: 2, name: '甜莓奶茶', unlocked: true, stockCups: 4 }],
        fruits: [{ uid: '9001', name: '森野甜莓', count: '8', locked: false }],
      } },
      work: { available: true, error: '', data: { myShift: null, talentName: '服务', slips: [{ shiftId: '7001', shopName: '测试雇主', finalWage: 40, wageStatus: 1 }] } },
    },
  });
}

test('one initial GET fills actual gameplay and actions; no extra query POST or automatic write', async () => {
  const api = apiMock(); api.setGet(async () => ({ data: { ok: true, activity: initialState() } }));
  api.setPost(async () => ({ data: { ok: true, message: '领取已确认' } }));
  const page = mountActivityPage(api); roots.push(page.root); await flush();
  const text = textOf(page.root);
  for (const value of ['奶茶券：17', '宣传喇叭：2', '甜莓奶茶', '森野甜莓', '当前没有进行中的班次', '工资 40', '可领取', '基金未解锁']) assert.ok(text.includes(value), value);
  assert.doesNotMatch(text, /班次店铺 待确认|资格待确认/);
  assert.equal(api.calls.get.length, 1); assert.equal(api.calls.post.length, 0);
  click(buttonsOf(page.root).find(b => textOf(b).trim() === '领取收银台')); await vue.nextTick();
  assert.equal(api.calls.post.length, 0, 'opening confirmation is not a write');
  click(buttonsOf(page.root).find(b => textOf(b).trim() === '确认执行')); await flush();
  assert.equal(api.calls.post.length, 1); assert.equal(api.calls.post[0].body.action, 'claimCashier');
  assert.equal(api.calls.get.length, 2, 'confirmed success refreshes the same bounded overview once');
});

test('an offline account shows the actual error and cannot operate placeholder controls', async () => {
  const api = apiMock(); api.setGet(async () => ({ data: { ok: false, error: '账号未运行，请先启动账号' } }));
  const page = mountActivityPage(api); roots.push(page.root); await flush();
  assert.match(textOf(page.root), /账号未运行/);
  for (const label of ['领取工资', '查询我的工作', '查询工坊与果实']) {
    const button = buttonsOf(page.root).find(b => textOf(b).trim() === label);
    assert.ok(button); assert.equal(button.props.disabled, true, label);
  }
  assert.equal(api.calls.post.length, 0);
});

test('partial detail failure preserves proven data and shows its real refresh error', async () => {
  const f = storeHarness(); const good = initialState();
  f.api.setGet(async () => ({ data: { ok: true, activity: good } }));
  await f.store.fetchMilkTeaActivity('acc-1');
  assert.ok(f.store.milkTeaQueries.workshop.data, 'a successful initial overview must fill workshop state');
  const next = initialState(); next.gameplay.workshop = { available: false, data: null, error: '工坊读取失败，请刷新重试' };
  f.api.setGet(async () => ({ data: { ok: true, activity: next } }));
  await f.store.fetchMilkTeaActivity('acc-1');
  assert.equal(f.store.milkTeaQueries.workshop.data.recipes[0].name, '甜莓奶茶');
  assert.equal(f.store.milkTeaQueries.workshop.error, '工坊读取失败，请刷新重试');
  assert.equal(f.store.milkTeaQueries.work.data.slips[0].finalWage, 40);
  assert.equal(f.api.calls.post.length, 0);
});

test('an explicit query owns its result when a slower initial overview returns afterward', async () => {
  const f = storeHarness(); const overview = deferred();
  f.api.setGet(() => overview.promise);
  const loading = f.store.fetchMilkTeaActivity('acc-1');
  f.api.setPost(async () => ({ data: { ok: true, data: { level: 7, pendingRewards: [] } } }));
  await f.store.runMilkTeaQuery('shop', 'acc-1');
  overview.resolve({ data: { ok: true, activity: initialState() } }); await loading;
  assert.equal(f.store.milkTeaQueries.shop.data.level, 7);
  assert.ok(f.store.milkTeaQueries.work.data, 'the overview must still fill independent work state');
  assert.equal(f.store.milkTeaQueries.work.data.slips[0].finalWage, 40);
});

test('account lifecycle and not-open snapshots do not retain earlier gameplay choices', async () => {
  const f = storeHarness(); f.api.setGet(async () => ({ data: { ok: true, activity: initialState() } }));
  await f.store.fetchMilkTeaActivity('acc-1');
  const gate = deferred(); f.api.setGet(() => gate.promise); const old = f.store.fetchMilkTeaActivity('acc-1');
  f.accountState.currentAccountId = 'acc-2'; f.store.clearActivityData();
  gate.resolve({ data: { ok: true, activity: initialState() } }); await old;
  assert.equal(f.store.milkTeaActivity, null); assert.equal(f.store.milkTeaQueries.workshop.data, null);
  f.accountState.currentAccountId = 'acc-1'; f.api.setGet(async () => ({ data: { ok: true, activity: initialState() } }));
  await f.store.fetchMilkTeaActivity('acc-1');
  const closed = initialState(); closed.summary.shopOpenAt = 0;
  for (const kind of ['shop', 'workshop', 'work']) closed.gameplay[kind] = { available: false, data: null, error: '', state: 'not_open' };
  f.api.setGet(async () => ({ data: { ok: true, activity: closed } })); await f.store.fetchMilkTeaActivity('acc-1');
  for (const kind of ['shop', 'workshop', 'work']) assert.equal(f.store.milkTeaQueries[kind].data, null);
});
