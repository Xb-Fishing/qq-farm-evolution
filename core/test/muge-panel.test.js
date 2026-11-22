const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const h = require('./activity-availability.test');
const { normalizeMuge } = require('../src/services/muge-activity');
// Synthetic fixture only; no production reports or identities copied.
const dto = endTime => ({ available: true, title: '牧歌初启', endTime, personal: null, phase: 'open', notes: ['未领活动奖励邮件补发'], sections: ['兴牧庆典', '牧友同行', '成长手册', '牧场人格'].map((title, key) => ({ key: String(key), title, lines: ['<img onerror=attack>长文本'.repeat(100)] })) });
const reward = { id: '1', count: '3', name: '测试奖励', image: '/game/assets/item/1.png' };
const tier = (id, threshold, status) => ({ id, threshold, status, rewards: [reward] });
const completeDto = (endTime = null) => ({
  ...dto(endTime),
  personal: {
    celebration: { total: '7', tiers: [tier('101', '5', 2), tier('102', '7', 3), tier('103', '10', 1)] },
    friends: { count: 4, tiers: [tier('201', '3', 2), tier('202', '9', 1)] },
    handbook: {
      points: '30', tiers: [tier('301', '30', 2)], tasks: [
        { id: '401', description: '完成一次测试任务', progress: '1', target: '1', status: 2, unlockDay: '1', rewards: [reward] },
        { id: '402', description: '累计测试任务', progress: '0', target: '3', status: 4, unlockDay: '5', rewards: [reward] },
      ],
    },
    personality: { answers: { 11: 0 }, personalityId: 0, settleCount: '0', shareRewardClaimed: false },
  },
  questions: [
    { id: 11, title: '第一题', options: [{ value: 0, text: '选项甲' }, { value: 1, text: '选项乙' }] },
    { id: 12, title: '第二题', options: [{ value: 0, text: '选项丙' }, { value: 1, text: '选项丁' }] },
  ],
  automation: { enabled: false },
});
const files = ['stores/muge.ts', 'components/activity/MugeActivityPanel.vue', 'views/Activity.vue'].map(p => path.join(h.WEB, 'src', p));
const fingerprint = file => [fs.statSync(file).mode, crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')];
const before = files.map(fingerprint);
const stores = [];
test.after(() => { try { for (const s of stores) s.cancel(); assert.deepEqual(files.map(fingerprint), before); } finally { /* shared helper removes its bounded private fixture */ } });
function setup(timing = {}) {
  const api = h.apiMock(); const pinia = h.pinia.createPinia(); h.pinia.setActivePinia(pinia);
  const resolve = spec => spec === 'vue' ? h.vue : spec === 'pinia' ? h.pinia : spec === '@/api' ? { default: api.instance, __esModule: true } : undefined;
  const { useMugeStore } = h.evaluateModule(fs.readFileSync(files[0], 'utf8'), resolve, files[0], timing);
  const store = useMugeStore(pinia); stores.push(store); return { store, api, resolve };
}
test('actual store preserves ordinary errors and deadline, expires once without polling, reentry stays expired', async () => {
  let now = 2000000000000; let next = 0; const timers = new Map();
  class FakeDate extends Date { static now() { return now; } }
  const { store, api } = setup({ Date: FakeDate, setTimeout: fn => { timers.set(++next, fn); return next; }, clearTimeout: id => timers.delete(id) });
  api.setGet(async () => ({ data: { ok: true, activity: dto(now / 1000 + 10) } }));
  await store.refresh('synthetic-a'); assert.equal(timers.size, 1);
  api.setGet(async () => { throw new Error('network'); }); await store.refresh('synthetic-a');
  assert.equal(store.error, 'network'); assert.equal(store.activity.available, true); assert.equal(timers.size, 1);
  now += 11000; const callback = [...timers.values()][0]; timers.clear(); callback(); assert.equal(store.activity.available, false);
  const count = api.calls.get.length; await store.refresh('synthetic-a'); assert.equal(api.calls.get.length, count);
  store.cancel(); store.bind('synthetic-a'); await store.refresh('synthetic-a'); assert.equal(store.activity.available, false); assert.equal(timers.size, 0);
});
test('A-B-A, abort, late success/failure and unmount cannot refill or clear new loading; reentry can fetch', async () => {
  for (const reject of [false, true]) {
    const { store, api } = setup(); const old = h.deferred(); const fresh = h.deferred();
    api.setGet(() => old.promise); const first = store.refresh('synthetic-a');
    store.bind('synthetic-b'); store.bind('synthetic-a'); api.setGet(() => fresh.promise); const second = store.refresh('synthetic-a');
    reject ? old.reject(Object.assign(new Error('old'), { response: { headers: { 'x-activity-end-time': '1' } } })) : old.resolve({ data: { ok: true, activity: dto(null) }, headers: { 'x-activity-end-time': '1' } }); await first;
    assert.equal(store.loading, true); assert.equal(store.activity, null); assert.equal(store.error, '');
    fresh.resolve({ data: { ok: true, activity: dto(null) } }); await second; assert.equal(store.activity.available, true);
    const pending = h.deferred(); api.setGet(() => pending.promise); const third = store.refresh('synthetic-a'); store.cancel();
    pending.resolve({ data: { ok: true, activity: dto(1) } }); await third;
    assert.equal(store.activity.available, true); assert.equal(store.loading, false);
    api.setGet(async () => ({ data: { ok: true, activity: dto(null) } })); await store.refresh('synthetic-a'); assert.equal(store.error, '');
  }
});
test('empty/malformed responses retain errors and recover; unknown end is not zero', async () => {
  const { store, api } = setup(); await store.refresh(''); assert.equal(api.calls.get.length, 0);
  for (const data of [null, {}, { ok: true, activity: null }, { ok: true, activity: { available: true, sections: null } }, { ok: true, activity: { ...dto(null), endTime: 'bad' } }]) {
    api.setGet(async () => ({ data })); await store.refresh('synthetic-a'); assert.ok(store.error); assert.equal(store.activity, null);
  }
  api.setGet(async () => ({ data: { ok: true, activity: dto(null) } })); await store.refresh('synthetic-a'); assert.equal(store.activity.endTime, null); assert.equal(store.error, '');
  assert.equal(normalizeMuge(null).personal, null);
});
test('actual panel renders four sections, text-only long input, loading/error and hides expired', async () => {
  const { resolve } = setup();
  const Panel = h.compileSfcModule(files[1], resolve); const root = h.makeNode('root'); let refreshes = 0;
  try {
    h.render(h.vue.h(Panel, { activity: dto(null), loading: false, error: '', onRefresh: () => refreshes++ }), root);
    for (const title of ['兴牧庆典', '牧友同行', '成长手册', '牧场人格', '个人进度', '未取得']) assert.ok(h.textOf(root).includes(title));
    assert.doesNotMatch(h.textOf(root), /牧场经营、任务与领奖尚未接入/);
    const link = h.findAll(root, n => n.tag === 'a' && n.props.href === '#ranch');
    assert.equal(link.length, 1); assert.match(h.textOf(link[0]), /前往牧场经营与任务/);
    h.click(link[0]); assert.equal(refreshes, 0, 'same-page navigation does not refresh or write');
    assert.equal(h.findAll(root, n => n.tag === 'img').length, 0); assert.ok(h.textOf(root).includes('<img onerror=attack>'));
    h.click(h.buttonsOf(root)[0]); assert.equal(refreshes, 1);
    h.render(h.vue.h(Panel, { activity: null, loading: true, error: 'ordinary failure' }), root); assert.match(h.textOf(root), /正在读取规则|ordinary failure/);
    h.render(h.vue.h(Panel, { activity: { available: false }, loading: false, error: '' }), root); assert.doesNotMatch(h.textOf(root), /牧歌初启/);
  } finally { h.render(null, root); }
});
test('production Activity view reads and renders current Muge on mount, refreshes and cancels across account/unmount', async () => {
  const api = h.apiMock();
  api.setGet(async url => ({ data: { ok: true, activity: url.includes('/muge') ? dto(null) : { available: false, endTime: null, personal: null } } }));
  const page = h.mountActivityPage(api);
  try {
    await h.flush();
    assert.equal(api.calls.get.filter(c => c.url === '/api/activity/muge').length, 1);
    assert.match(h.textOf(page.root), /兴牧庆典/);
    assert.equal(api.calls.post.length, 0);
    const refresh = h.buttonsOf(page.root).find(b => h.textOf(b).trim() === '刷新牧歌活动');
    h.click(refresh); await h.flush();
    assert.equal(api.calls.get.filter(c => c.url === '/api/activity/muge').length, 2);
    page.accountRef.value = 'synthetic-b'; await h.flush();
    assert.equal(api.calls.get.filter(c => c.url === '/api/activity/muge').at(-1).accountId, 'synthetic-b');
    const store = page.pinia._s.get('muge');
    h.render(null, page.root); assert.equal(store.loading, false);
    assert.equal(api.calls.get.some(c => c.url.includes('milk-tea')), false);
  } finally { h.render(null, page.root); }
});

test('ordinary ok=false preserves successful rules, recovers, and consumer error handling is explicit', async () => {
  const { store, api } = setup();
  api.setGet(async () => ({ data: { ok: true, activity: dto(null) } })); await store.refresh('synthetic-a');
  api.setGet(async () => ({ data: { ok: false, error: '普通读取失败' } })); await store.refresh('synthetic-a');
  assert.equal(store.activity.available, true); assert.equal(store.error, '普通读取失败'); assert.equal(store.loading, false);
  api.setGet(async () => ({ data: { ok: true, activity: dto(null) } })); await store.refresh('synthetic-a');
  assert.equal(store.error, ''); assert.equal(api.calls.post.length, 0);
  let config;
  const resolve = spec => spec === 'vue' ? h.vue : spec === 'pinia' ? h.pinia : spec === '@/api' ? { __esModule: true, default: { get: async (_url, options) => { config = options; throw new Error('transport'); } } } : undefined;
  const module = h.evaluateModule(fs.readFileSync(files[0], 'utf8'), resolve, files[0]);
  const separate = module.useMugeStore(h.pinia.createPinia()); stores.push(separate); await separate.refresh('synthetic-c');
  assert.equal(config.errorFeedback, 'consumer'); assert.ok(config.signal); assert.equal(separate.loading, false);
});

for (const kind of ['ordinary', 'http']) test(`new deadline on ${kind} error after unknown success expires actual panel without polling`, async () => {
  let now = 2000000000000; const timers = new Map(); let next = 0;
  class FakeDate extends Date { static now() { return now; } }
  const { store, api, resolve } = setup({ Date: FakeDate, setTimeout: fn => { timers.set(++next, fn); return next; }, clearTimeout: id => timers.delete(id) });
  const Panel = h.compileSfcModule(files[1], resolve); const root = h.makeNode('root');
  const Host = { setup: () => () => h.vue.h(Panel, { activity: store.activity, loading: store.loading, error: store.error }) };
  try {
    api.setGet(async () => ({ data: { ok: true, activity: dto(null) } })); await store.refresh('synthetic-a');
    h.render(h.vue.h(Host), root); assert.match(h.textOf(root), /兴牧庆典/);
    const headers = { 'x-activity-end-time': String(now / 1000 + 2) };
    api.setGet(async () => { if (kind === 'http') throw Object.assign(new Error('ordinary failure'), { response: { data: { error: 'ordinary failure' }, headers } }); return { data: { ok: false, error: 'ordinary failure' }, headers }; });
    await store.refresh('synthetic-a'); assert.equal(store.error, 'ordinary failure');
    assert.equal(store.activity.endTime, now / 1000 + 2); assert.equal(timers.size, 1);
    now += 3000; const callback = [...timers.values()][0]; timers.clear(); callback(); await h.flush();
    assert.equal(store.activity.available, false); assert.doesNotMatch(h.textOf(root), /兴牧庆典/);
    const count = api.calls.get.length; await store.refresh('synthetic-a'); assert.equal(api.calls.get.length, count);
  } finally { h.render(null, root); store.cancel(); }
});

test('malformed cutoff headers never invent or erase a known deadline', async () => {
  const { store, api } = setup();
  for (const value of [true, false, [], {}, '', 'NaN', '-1', '1.5', '9007199254740992']) {
    api.setGet(async () => ({ data: { ok: true, activity: dto(null) }, headers: { 'x-activity-end-time': value } }));
    await store.refresh('synthetic-a'); assert.equal(store.activity.endTime, null); assert.equal(store.error, '');
  }
  const end = Math.floor(Date.now() / 1000) + 60;
  api.setGet(async () => ({ data: { ok: true, activity: dto(end) } })); await store.refresh('synthetic-a');
  api.setGet(async () => ({ data: { ok: false, error: 'failed' }, headers: { 'x-activity-end-time': 'NaN' } }));
  await store.refresh('synthetic-a'); assert.equal(store.activity.endTime, end); assert.equal(store.error, 'failed');
});

const findButton = (root, label) => h.buttonsOf(root).find(button => h.textOf(button).trim() === label);
const ok = activity => ({ data: { ok: true, activity } });

test('activity routes fresh qualified batches, automation preference, survey answers, and sharing through real panel controls', async () => {
  const api = h.apiMock();
  let activity = completeDto();
  api.setGet(async url => ok(url.includes('/muge') ? activity : { available: false, endTime: null, personal: null }));
  api.setPost(async (url, { action, input }) => {
    assert.equal(url, '/api/activity/muge/operate');
    const next = structuredClone(activity);
    const { celebration, friends, handbook, personality } = next.personal;
    switch (action) {
      case 'claimCelebration': celebration.tiers[0].status = 3; break;
      case 'claimFriends': friends.tiers[0].status = 3; break;
      case 'claimTask': handbook.tasks[0].status = 3; break;
      case 'claimHandbook': handbook.tiers[0].status = 3; break;
      case 'setAutomation': next.automation.enabled = input.enabled; break;
      case 'finishSurvey': personality.answers = input.answers; personality.personalityId = 12; break;
      case 'claimShare': personality.shareRewardClaimed = true; break;
      case 'resetSurvey': personality.answers = {}; personality.personalityId = 0; break;
      default: assert.fail(action);
    }
    activity = next;
    return { data: { ok: true, activity: next, ...(action.startsWith('claim') ? { rewards: [reward] } : {}) } };
  });
  const page = h.mountActivityPage(api);
  try {
    await h.flush();
    for (const label of ['累计饲养 7 只', '好友 4 人', '累计积分 30', '5 天解锁', '可领取', '已领取', '未达标', '未解锁', '测试奖励 × 3']) {
      assert.ok(h.textOf(page.root).includes(label), label);
    }
    assert.equal(findButton(page.root, '提交人格测评').props.disabled, true);
    assert.equal(findButton(page.root, '领取首次分享奖励'), undefined);
    for (const [label, action] of [
      ['领取庆典奖励', 'claimCelebration'], ['领取牧友奖励', 'claimFriends'],
      ['领取任务奖励', 'claimTask'], ['领取积分奖励', 'claimHandbook'],
    ]) {
      h.click(findButton(page.root, label));
      await h.flush();
      assert.equal(api.calls.post.at(-1).body.action, action);
      assert.equal(findButton(page.root, label), undefined);
    }
    h.click(findButton(page.root, '开启自动领取'));
    await h.flush();
    assert.deepEqual(api.calls.post.at(-1).body.input, { enabled: true });
    assert.ok(findButton(page.root, '关闭自动领取'));
    const chooseAnswer = () => h.findAll(page.root, n => n.tag === 'input'
      && n.props.name === 'muge-question-12' && n.props.value === 1)[0].props.onChange({});
    chooseAnswer();
    h.click(findButton(page.root, '刷新牧歌活动'));
    await h.flush();
    assert.equal(findButton(page.root, '提交人格测评').props.disabled, false, 'refresh preserves same-account draft');
    page.accountRef.value = 'synthetic-b'; await h.flush();
    assert.equal(findButton(page.root, '提交人格测评').props.disabled, true, 'switching accounts drops the previous draft');
    page.accountRef.value = 'acc-1'; await h.flush();
    chooseAnswer(); await h.flush();
    h.findAll(page.root, n => n.tag === 'form' && n.props.onSubmit)[0].props.onSubmit({ preventDefault() {} });
    await h.flush();
    assert.deepEqual(api.calls.post.at(-1).body, { action: 'finishSurvey', input: { answers: { 11: 0, 12: 1 } } });
    assert.match(h.textOf(page.root), /结果编号 12/);
    assert.equal(api.calls.post.some(call => call.body.action === 'claimShare'), false);
    h.click(findButton(page.root, '领取首次分享奖励'));
    await h.flush();
    assert.match(h.textOf(page.root), /首次分享奖励已领取/);
    assert.equal(findButton(page.root, '领取首次分享奖励'), undefined);
    h.click(findButton(page.root, '重新作答'));
    await h.flush();
    assert.equal(api.calls.post.at(-1).body.action, 'resetSurvey');
    assert.equal(findButton(page.root, '提交人格测评').props.disabled, true);
    assert.ok(api.calls.post.every(call => call.accountId === 'acc-1'));
  } finally { h.render(null, page.root); }
});

test('uncertain writes and malformed snapshots preserve progress and require a successful read before another write', async () => {
  const { store, api } = setup();
  const activity = completeDto();
  api.setGet(async () => ok(activity));
  await store.refresh('synthetic-a');
  assert.equal(store.ready, true);
  const pending = h.deferred();
  api.setPost(() => pending.promise);
  const first = store.operate('synthetic-a', { action: 'claimCelebration' });
  await store.operate('synthetic-a', { action: 'claimCelebration' });
  await store.refresh('synthetic-a');
  assert.equal(api.calls.post.length, 1);
  assert.equal(api.calls.get.length, 1);
  pending.reject(new Error('timeout')); await first;
  assert.equal(store.activity.personal.celebration.tiers[0].status, 2);
  assert.equal(store.refreshRequired, true);
  assert.equal(store.ready, false);
  await store.operate('synthetic-a', { action: 'claimCelebration' });
  assert.equal(api.calls.post.length, 1);
  api.setGet(async () => ok({ ...activity, personal: { celebration: [] } }));
  await store.refresh('synthetic-a');
  assert.match(store.error, /活动状态格式异常/);
  assert.equal(store.ready, false);
  assert.equal(store.refreshRequired, true);
  api.setGet(async () => ok(activity));
  await store.refresh('synthetic-a');
  assert.equal(store.error, '');
  assert.equal(store.ready, true);
  assert.equal(store.refreshRequired, false);
  api.setPost(async () => ({ data: { ok: true, rewards: [reward], refreshRequired: true } }));
  await store.operate('synthetic-a', { action: 'claimCelebration' });
  assert.equal(store.rewards[0].name, reward.name);
  assert.equal(store.ready, false);
  assert.equal(store.refreshRequired, true);
  await store.refresh('synthetic-a');
  api.setPost(async () => ({ data: { ok: false, code: 'MUGE_RESULT_UNKNOWN', error: '状态待确认', activity } }));
  await store.operate('synthetic-a', { action: 'claimCelebration' });
  assert.equal(store.error, '状态待确认');
  assert.equal(store.ready, false);
});

test('late writes never change another account or reopen an expired activity', async () => {
  let now = 2000000000000;
  class FakeDate extends Date { static now() { return now; } }
  const { store, api } = setup({ Date: FakeDate });
  const end = now / 1000 + 60;
  api.setGet(async () => ok(completeDto(end)));
  await store.refresh('synthetic-a');
  const old = h.deferred();
  let oldTransform;
  api.setPost((_url, body, config) => {
    oldTransform = config.transformRequest[0];
    const headers = { 'x-account-id': 'stale-interceptor-selection' };
    assert.deepEqual(JSON.parse(oldTransform(body, headers)), { action: 'claimCelebration' });
    assert.equal(headers['x-account-id'], 'synthetic-a');
    return old.promise;
  });
  const prior = store.operate('synthetic-a', { action: 'claimCelebration' });
  await store.refresh('synthetic-b');
  assert.throws(() => oldTransform({ action: 'claimCelebration' }, {}), { code: 'ERR_CANCELED' });
  old.resolve({ data: { ok: true, activity: completeDto(1), rewards: [reward] } });
  await prior;
  assert.equal(store.accountId, 'synthetic-b');
  assert.equal(store.activity.endTime, end);
  assert.deepEqual(store.rewards, []);
  const pending = h.deferred();
  api.setPost(() => pending.promise);
  const current = store.operate('synthetic-b', { action: 'claimTask' });
  now = end * 1000;
  pending.resolve({ data: { ok: true, activity: completeDto(end + 60), rewards: [reward] } });
  await current;
  assert.equal(store.activity.available, false);
  assert.equal(store.pending, null);
  assert.equal(store.ready, false);
  assert.deepEqual(store.rewards, []);
});
