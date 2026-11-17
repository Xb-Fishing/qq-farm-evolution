const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const h = require('./activity-availability.test');
const { normalizeMuge } = require('../src/services/muge-activity');
// Synthetic fixture only; no production reports or identities copied.
const dto = endTime => ({ available: true, title: '牧歌初启', endTime, personal: null, phase: 'open', notes: ['未领活动奖励邮件补发'], sections: ['兴牧庆典', '牧友同行', '成长手册', '牧场人格'].map((title, key) => ({ key: String(key), title, lines: ['<img onerror=attack>长文本'.repeat(100)] })) });
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
    for (const title of ['兴牧庆典', '牧友同行', '成长手册', '牧场人格', '尚未接入', '未取得']) assert.ok(h.textOf(root).includes(title));
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
    const refresh = h.buttonsOf(page.root).find(b => h.textOf(b).trim() === '刷新牧歌规则');
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
