const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const h = require('./activity-availability.test');
const { normalizeFriendRecall } = require('../src/services/friend-recall-activity');
// Synthetic fixture only; no production reports or identities copied.
const dto = endTime => ({ available: true, title: '故友重逢', endTime, personal: null, sections: ['召回老友', '回归福利', '农场互动', '召回记录', '回归增益'].map((title, key) => ({ key: String(key), title, lines: ['<img onerror=attack>长文本'.repeat(100)] })) });
const files = ['stores/friend-recall.ts', 'components/activity/FriendRecallActivityPanel.vue', 'views/Activity.vue'].map(p => path.join(h.WEB, 'src', p));
const fingerprint = file => [fs.statSync(file).mode, crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')];
const before = files.map(fingerprint);
const stores = [];
test.after(() => { try { for (const s of stores) s.cancel(); assert.deepEqual(files.map(fingerprint), before); } finally { /* shared helper removes its bounded private fixture */ } });
function setup(timing = {}) {
  const api = h.apiMock(); const pinia = h.pinia.createPinia(); h.pinia.setActivePinia(pinia);
  const resolve = spec => spec === 'vue' ? h.vue : spec === 'pinia' ? h.pinia : spec === '@/api' ? { default: api.instance, __esModule: true } : undefined;
  const { useFriendRecallStore } = h.evaluateModule(fs.readFileSync(files[0], 'utf8'), resolve, files[0], timing);
  const store = useFriendRecallStore(pinia); stores.push(store); return { store, api, resolve };
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
    reject ? old.reject(new Error('old')) : old.resolve({ data: { ok: true, activity: dto(null) } }); await first;
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
  assert.equal(normalizeFriendRecall(null).personal, null);
});
test('actual panel renders five sections, text-only long input, loading/error and hides expired', async () => {
  const { resolve } = setup();
  const Panel = h.compileSfcModule(files[1], resolve); const root = h.makeNode('root'); let refreshes = 0;
  try {
    h.render(h.vue.h(Panel, { activity: dto(null), loading: false, error: '', onRefresh: () => refreshes++ }), root);
    for (const title of ['召回老友', '回归福利', '农场互动', '召回记录', '回归增益', '官方游戏', '未知']) assert.ok(h.textOf(root).includes(title));
    assert.equal(h.findAll(root, n => n.tag === 'img').length, 0); assert.ok(h.textOf(root).includes('<img onerror=attack>'));
    h.click(h.buttonsOf(root)[0]); assert.equal(refreshes, 1);
    h.render(h.vue.h(Panel, { activity: null, loading: true, error: 'ordinary failure' }), root); assert.match(h.textOf(root), /正在读取规则|ordinary failure/);
    h.render(h.vue.h(Panel, { activity: { available: false }, loading: false, error: '' }), root); assert.doesNotMatch(h.textOf(root), /故友重逢/);
  } finally { h.render(null, root); }
});
test('actual Activity view mounts recall alongside independent milk tea and cancels on unmount', async () => {
  const api = h.apiMock(); api.setGet(async url => ({ data: { ok: true, activity: url.includes('friend-recall') ? dto(null) : h.snapshot() } }));
  const page = h.mountActivityPage(api);
  try {
    await h.flush(); await h.vue.nextTick(); assert.match(h.textOf(page.root), /故友重逢/);
    assert.ok(api.calls.get.some(call => call.url === '/api/activity/friend-recall'));
    assert.ok(api.calls.get.some(call => call.url === '/api/activity/milk-tea'));
    assert.equal(api.calls.post.length, 0);
    h.click(h.buttonsOf(page.root).find(button => h.textOf(button).trim() === '刷新')); await h.flush();
    assert.ok(api.calls.get.filter(call => call.url === '/api/activity/milk-tea').length >= 2);
  } finally { h.render(null, page.root); }
});

test('deadline remains account-bound across B and failed A reentry; expiry aborts an in-flight refresh', async () => {
  let now = 2000000000000; let next = 0; const timers = new Map();
  class FakeDate extends Date { static now() { return now; } }
  const { store, api } = setup({ Date: FakeDate, setTimeout: fn => { timers.set(++next, fn); return next; }, clearTimeout: id => timers.delete(id) });
  let signal;
  api.setGet(async () => ({ data: { ok: true, activity: dto(now / 1000 + 10) } }));
  await store.refresh('synthetic-a');
  store.bind('synthetic-b'); assert.equal(timers.size, 0);
  api.setGet(async () => ({ data: { ok: true, activity: dto(null) } })); await store.refresh('synthetic-b');
  assert.equal(store.activity.endTime, null);
  store.bind('synthetic-a'); api.setGet(async () => { throw new Error('temporary'); }); await store.refresh('synthetic-a');
  assert.equal(store.error, 'temporary'); assert.equal(timers.size, 1);
  const late = h.deferred(); api.setGet((url, config) => { signal = config.signal; return late.promise; }); const pending = store.refresh('synthetic-a');
  now += 11000; const callback = [...timers.values()][0]; timers.clear(); callback();
  assert.equal(signal.aborted, true); assert.equal(store.loading, false); assert.equal(store.activity.available, false);
  late.reject(new Error('late')); await pending; assert.equal(store.error, ''); assert.equal(store.activity.available, false);
  store.bind('synthetic-b'); assert.equal(store.activity, null); store.cancel(); assert.equal(timers.size, 0);
});

test('actual page cancels delayed recall on account changes and unmount, while milk tea keeps refreshing', async () => {
  const api = h.apiMock(); const pending = []; const signals = [];
  api.setGet((url, config) => {
    if (url.includes('friend-recall')) {
      const request = h.deferred(); pending.push(request); signals.push(config.signal); return request.promise;
    }
    return Promise.resolve({ data: { ok: true, activity: h.snapshot() } });
  });
  const page = h.mountActivityPage(api);
  try {
    await h.flush(); const store = page.pinia._s.get('friend-recall');
    assert.equal(pending.length, 1);
    page.accountRef.value = 'synthetic-b'; page.accountRef.value = 'acc-1';
    await h.flush(); assert.equal(pending.length, 3); assert.equal(signals[0].aborted, true); assert.equal(signals[1].aborted, true);
    pending[0].resolve({ data: { ok: true, activity: { ...dto(null), title: 'stale-title' } } });
    pending[1].reject(new Error('stale-failure')); await h.flush();
    assert.equal(store.loading, true); assert.equal(store.error, ''); assert.equal(store.activity, null);
    assert.doesNotMatch(h.textOf(page.root), /stale-title|stale-failure/);
    h.render(null, page.root); assert.equal(signals[2].aborted, true);
    pending[2].resolve({ data: { ok: true, activity: dto(null) } }); await h.flush();
    assert.equal(store.activity, null); assert.equal(store.loading, false);
    assert.equal(page.toastLog.length, 0); assert.ok(api.calls.get.filter(call => call.url.includes('milk-tea')).length >= 3);
  } finally { h.render(null, page.root); }
});
