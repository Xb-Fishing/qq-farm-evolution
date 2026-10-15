'use strict';
// 当前活动沿真实 store / SFC 入口回归；退役活动不再参与领取计划。
const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('./activity-availability.test');
const { storeHarness, snapshot, deferred, flush, mountActivityPage, apiMock, buttonsOf, click, textOf, render } = h;
const before = { currentScore: 10, daily: { claimedCount: 0, claimLimit: 1, rewardClaimed: false }, milestones: [{ state: 1, threshold: 20 }] };
const after = { currentScore: 30, daily: { claimedCount: 1, claimLimit: 1, rewardClaimed: true }, milestones: [{ state: 2, threshold: 20 }] };
function ready(api) {
  let reads = 0;
  api.setGet(async () => ({ data: { ok: true, activity: snapshot({ shareReward: ++reads > 1 ? after : before }) } }));
  api.setPost(async () => ({ data: { ok: true, rewards: [] } }));
}

test('一键真实store：每日→重读→档位→收尾；再次运行不重放成功项', async () => {
  const { store, api } = storeHarness(); ready(api);
  assert.equal((await store.runClaimAll('acc-1')).successCount, 2);
  assert.deepEqual(api.calls.post.map(c => c.body.action), ['shareDaily', 'shareMilestones']);
  api.setGet(async () => ({ data: { ok: true, activity: snapshot({ shareReward: { ...after, milestones: [{ state: 3, threshold: 20 }] } }) } }));
  await store.runClaimAll('acc-1'); assert.equal(api.calls.post.length, 2);
  store.cancelActivityReads();
});

test('一键无资格、读取普通失败、非严格ok和空快照均零写', async () => {
  for (const data of [{ ok: true, activity: snapshot() }, { ok: false }, { ok: 'true', activity: snapshot({ shareReward: before }) }, { ok: true, activity: null }]) {
    const { store, api } = storeHarness(); api.setGet(async () => ({ data }));
    await store.runClaimAll('acc-1'); assert.equal(api.calls.post.length, 0); assert.equal(store.claimAllRunning, false); store.cancelActivityReads();
  }
});

test('一键每日未知/fulfilled但ok=false/抛错停止依赖领取；不重试、保留明细', async () => {
  for (const fail of [{ ok: false, outcome: 'unknown' }, { ok: false, error: 'failed' }, new Error('transport')]) {
    const { store, api } = storeHarness(); ready(api);
    api.setPost(async () => { if (fail instanceof Error) throw fail; return { data: fail }; });
    const result = await store.runClaimAll('acc-1');
    assert.equal(result.ok, false); assert.equal(api.calls.post.length, 1);
    assert.ok(store.claimAllResults.some(r => r.status === 'failed')); assert.equal(store.claimAllRunning, false); store.cancelActivityReads();
  }
});

test('一键部分成功、刷新fulfilled失败、不以旧资格继续；资格拒绝显式跳过', async () => {
  for (const mode of ['refresh', 'milestone', 'precondition']) {
    const { store, api } = storeHarness(); let reads = 0;
    api.setGet(async () => { const current = ++reads; return { data: mode === 'refresh' && current > 1 ? { ok: false, error: 'offline' } : { ok: true, activity: snapshot({ shareReward: current > 1 ? after : before }) } }; });
    api.setPost(async (_url, body) => {
      if (mode === 'precondition') throw { response: { status: 400, data: { code: 'SEASON_WISH_MILK_TEA_CLAIMED', error: '已领' } } };
      return { data: body.action === 'shareMilestones' ? { ok: false, outcome: 'unknown' } : { ok: true } };
    });
    const result = await store.runClaimAll('acc-1');
    if (mode === 'precondition') assert.ok(result.skippedCount > 0);
    else assert.equal(result.successCount, 1);
    if (mode === 'refresh') assert.equal(api.calls.post.length, 1);
    store.cancelActivityReads();
  }
});

test('一键与单项互斥；取消/切号后旧finally不释放新操作、不继续写', async () => {
  const { store, api, accountState } = storeHarness(); ready(api);
  const gate = deferred(); api.setPost(() => gate.promise);
  const first = store.runClaimAll('acc-1'); await flush();
  assert.match((await store.runClaimAll('acc-1')).error, /进行中/);
  assert.match((await store.operateMilkTea('acc-1', 'shareDaily')).error, /进行中/);
  store.clearActivityData(); accountState.currentAccountId = 'acc-2';
  const gate2 = deferred(); api.setPost(() => gate2.promise);
  const second = store.operateMilkTea('acc-2', 'claimWages');
  gate.resolve({ data: { ok: true } }); await first;
  assert.equal(store.milkTeaOperating, 'claimWages'); assert.equal(api.calls.post.length, 2);
  gate2.resolve({ data: { ok: true } }); await second;
  assert.equal(store.milkTeaOperating, ''); store.cancelActivityReads();
});

test('快照/六查询按key隔离loading；卸载、账号往返的迟到成功/失败/异常不回填', async () => {
  for (const mode of ['success', 'ordinary', 'exception']) {
    const { store, api, accountState } = storeHarness(); const gate = deferred(); api.setPost(() => gate.promise);
    const old = store.runMilkTeaQuery('rank', 'acc-1', { page: 1 });
    api.setPost(async () => ({ data: { ok: true, data: { recipes: [] } } }));
    await store.runMilkTeaQuery('workshop', 'acc-1'); assert.equal(store.milkTeaQueries.rank.loading, true); assert.equal(store.milkTeaQueries.workshop.loading, false);
    store.cancelActivityReads(); accountState.currentAccountId = 'acc-2'; store.clearActivityData(); accountState.currentAccountId = 'acc-1'; store.clearActivityData();
    const next = deferred(); api.setPost(() => next.promise); const current = store.runMilkTeaQuery('rank', 'acc-1');
    if (mode === 'exception') gate.reject(new Error('late')); else gate.resolve({ data: mode === 'success' ? { ok: true, data: { page: 99 } } : { ok: false, error: 'late' } });
    assert.equal((await old).cancelled, true); assert.equal(store.milkTeaQueries.rank.loading, true); assert.equal(store.milkTeaQueries.rank.error, '');
    next.resolve({ data: { ok: true, data: { page: 2 } } }); await current;
    assert.equal(store.milkTeaQueries.rank.data.page, 2); store.cancelActivityReads();
  }
});

function clockHarness() {
  let now = 1000000; const timers = []; const cleared = [];
  const h = storeHarness({ Date: { now: () => now }, setTimeout: (fn, delay) => { const t = { fn, delay }; timers.push(t); return t; }, clearTimeout: t => cleared.push(t) });
  return { ...h, timers, cleared, setNow: value => { now = value; } };
}
test('真实timer：普通失败保留截止，提前回调重排、旧所有者不破坏新timer、到期零请求撤下', async () => {
  const { store, api, timers, cleared, setNow } = clockHarness();
  api.setGet(async () => ({ data: { ok: true, activity: snapshot({ timing: { endTime: 1002 } }) } })); await store.fetchMilkTeaActivity('acc-1');
  api.setGet(async () => ({ data: { ok: false, error: 'offline' } })); await store.fetchMilkTeaActivity('acc-1');
  assert.equal(store.milkTeaActivity.timing.endTime, 1002);
  setNow(1001999); timers[0].fn(); assert.equal(timers.at(-1).delay, 1);
  const old = timers.at(-1);
  api.setGet(async () => ({ data: { ok: true, activity: snapshot({ timing: { endTime: 1005 } }) } })); await store.fetchMilkTeaActivity('acc-1');
  const current = timers.at(-1); old.fn(); assert.equal(timers.at(-1), current); assert.ok(cleared.includes(old));
  const reads = api.calls.get.length; setNow(1005000); current.fn();
  assert.equal(store.milkTeaActivity, null); assert.equal(store.activityRetired.milkTea.reason, 'expired');
  await store.fetchMilkTeaActivity('acc-1'); await store.runMilkTeaQuery('rank', 'acc-1'); await store.operateMilkTea('acc-1', 'shareDaily');
  assert.equal(api.calls.get.length, reads); assert.equal(api.calls.post.length, 0); store.cancelActivityReads();
});

test('timer超长延迟、取消、未知截止和重进清扫：页外旧回调不复活，到期零网络', async () => {
  const { store, api, timers, setNow } = clockHarness();
  api.setGet(async () => ({ data: { ok: true, activity: snapshot({ timing: { endTime: 9999999999 } }) } })); await store.fetchMilkTeaActivity('acc-1');
  assert.equal(timers.at(-1).delay, 2147483647); timers.at(-1).fn(); assert.equal(timers.length, 2);
  const old = timers.at(-1); store.cancelActivityReads(); const size = timers.length; old.fn(); assert.equal(timers.length, size);
  store.sweepExpiredActivities(); assert.equal(timers.length, size + 1);
  setNow(9999999999000); store.cancelActivityReads(); store.sweepExpiredActivities(); assert.equal(store.milkTeaActivity, null); assert.equal(api.calls.get.length, 1);
  store.clearActivityData(); api.setGet(async () => ({ data: { ok: true, activity: snapshot() } })); await store.fetchMilkTeaActivity('acc-1');
  assert.equal(timers.length, size + 1); store.cancelActivityReads();
});

test('过期同步拦写和重进；重查不合法/非严格ok均保持下架', async () => {
  const { store, api, setNow } = clockHarness();
  api.setGet(async () => ({ data: { ok: true, activity: snapshot({ timing: { endTime: 1001 } }) } })); await store.fetchMilkTeaActivity('acc-1');
  setNow(1001000); assert.equal((await store.operateMilkTea('acc-1', 'shareDaily')).retired, true); assert.equal(api.calls.post.length, 0);
  for (const data of [{ ok: true, activity: {} }, { ok: true, activity: [] }, { ok: true, activity: null }, { ok: 1, activity: snapshot() }]) {
    api.setGet(async () => ({ data })); await store.recheckActivity('milkTea', 'acc-1'); assert.ok(store.activityRetired.milkTea);
  }
  store.cancelActivityReads();
});

test('实际页面点击一键到达store；结果逐项渲染；卸载取消迟到提示和后续刷新', async () => {
  const api = apiMock(); ready(api); const page = mountActivityPage(api); await flush();
  // 页面初读不计入 runner 的资格序列
  ready(api); click(buttonsOf(page.root).find(b => textOf(b).includes('一键领取'))); await flush(); await flush();
  assert.deepEqual(api.calls.post.map(c => c.body.action), ['shareDaily', 'shareMilestones']);
  assert.match(textOf(page.root), /快乐值每日领取/);
  render(null, page.root);
  for (const mode of ['success', 'ordinary', 'exception']) {
    const api = apiMock(); ready(api); const page = mountActivityPage(api); await flush(); const gate = deferred(); api.setPost(() => gate.promise);
    click(buttonsOf(page.root).find(b => textOf(b).includes('一键领取'))); await flush();
    const reads = api.calls.get.length; render(null, page.root);
    if (mode === 'exception') gate.reject(new Error('late')); else gate.resolve({ data: { ok: mode === 'success' } });
    await flush(); assert.equal(page.toastLog.length, 0); assert.equal(api.calls.get.length, reads); assert.equal(api.calls.post.length, 1);
  }
});

test('快照迟到成功/普通失败/异常：账号往返与卸载重进后零回填；旧finally不清新loading', async () => {
  for (const mode of ['success','ordinary','exception']) {
    const {store,api,accountState}=storeHarness();const old=deferred();api.setGet(()=>old.promise);
    const pending=store.fetchMilkTeaActivity('acc-1');store.cancelActivityReads();store.clearActivityData();accountState.currentAccountId='acc-2';store.clearActivityData();accountState.currentAccountId='acc-1';
    const next=deferred();api.setGet(()=>next.promise);const current=store.fetchMilkTeaActivity('acc-1');
    if(mode==='exception')old.reject(new Error('late'));else old.resolve({data:{ok:mode==='success',activity:snapshot({title:'stale'})}});
    assert.equal((await pending).cancelled,true);assert.equal(store.milkTeaActivity,null);assert.equal(store.milkTeaLoading,true);assert.equal(store.milkTeaError,'');
    next.resolve({data:{ok:true,activity:snapshot({title:'fresh'})}});await current;assert.equal(store.milkTeaActivity.title,'fresh');assert.equal(store.milkTeaLoading,false);store.cancelActivityReads();
  }
});
