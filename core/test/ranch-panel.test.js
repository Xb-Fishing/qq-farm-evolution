'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const temp = fs.realpathSync(os.tmpdir());
const repo = fs.realpathSync(path.join(__dirname, '../..'));
assert.ok(temp !== repo && !temp.startsWith(repo + path.sep));
const prefix = path.resolve(temp, 'farm-ranch-panel-');
assert.equal(path.dirname(prefix), temp);
const privateDir = fs.mkdtempSync(prefix);
function fixturePath(name) {
  const target = path.resolve(privateDir, name);
  assert.equal(path.dirname(target), privateDir);
  return target;
}
process.env.FARM_DATA_DIR = privateDir;
process.env.FARM_PRIVATE_CONFIG_FILE = fixturePath('private-config.json');
process.env.FARM_LOG_DIR = fixturePath('logs');
process.env.FARM_SESSION_LOG_DIR = fixturePath('session-logs');
const h = require('./activity-availability.test');
const { DEFAULT_POLICY } = require('../src/services/ranch-policy');
const state = () => ({ level: 1, grass: '30', currencies: [], facilities: [], cubs: [], inventory: [],
  animals: [{ id: 7, ranchId: '11', name: '鸡', canProduce: true }], tasks: [], lastOperation: null });
const roots = [];
test.after(() => {
  try { for (const root of roots) h.render(null, root); }
  finally { fs.rmSync(privateDir, { recursive: true, force: true }); }
});
function fixture() {
  const posts = []; let read = async () => ({ data: { ok: true, data: state() } }); let prepare; let operate; let acknowledge;
  const api = {
    get: async (url, config) => url.endsWith('/automation') ? { data: { ok: true, data: { policy: { ...DEFAULT_POLICY }, revision: 0 } } } : read(url, config),
    post: async (url, body, config) => {
      posts.push({ url, body, config });
      if (url.endsWith('/prepare')) return prepare ? prepare() : { data: { ok: true, data: { id: 'synthetic-quote', label: '牧场生产', count: 1, costItems: [], expiresAt: Date.now() + 60000 } } };
      if (url.endsWith('/automation')) return { data: { ok: true, data: { policy: body, revision: 1 } } };
      if (url.endsWith('/operate') && operate) return operate();
      if (url.endsWith('/acknowledge') && acknowledge) return acknowledge(body);
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
  return { root, store, posts, mount, read: fn => { read = fn; }, prepare: fn => { prepare = fn; }, operate: fn => { operate = fn; }, acknowledge: fn => { acknowledge = fn; } };
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
  const ranch = id => ({ id, name: `栏舍${id}`, level: 1, active: true, ranch: { husbandryType: 1, count: 0, capacity: 4, animals: [], shelves: [], hazards: [] } });
  f.read(async () => ({ data: { ok: true, data: { ...state(), facilities: [ranch('11'), ranch('12')],
    cubs: [{ id: '60001', name: '鸡幼崽', count: '2', husbandryType: 1, locked: false }] } } }));
  await f.store.refresh(); await h.flush();
  const select = h.findAll(f.root, node => node.props['aria-label'] === '鸡幼崽放养栏舍')[0];
  assert.equal(select.props.value, '11'); assert.equal(f.posts.length, 0);
  select.props.onChange({ target: { value: '12' } }); await h.flush();
  h.click(button(f.root, '放养')); await h.flush();
  assert.equal(f.posts[0].body.input.ranchId, '12'); assert.equal(f.posts[0].url, '/api/ranch/prepare');
});

test('automation opens the correct shop itself, joins inventory stacks and keeps future placement separate from buying', async () => {
  const f = fixture(); await h.flush();
  const calls = [];
  const room = (id, type, active) => ({ id, name: `栏舍${id}`, active, ranch: { husbandryType: type, count: 3, capacity: 3, animals: [], shelves: [], hazards: [] } });
  const cub = (id, count, locked = false) => ({ id, name: id === '60001' ? '鸡幼崽' : '鸭幼崽', count, locked, husbandryType: 1 });
  const stock = { ...state(), facilities: [room('11', 1, true), room('12', 2, true), room('13', 1, false)],
    currencies: [{ id: '1007', name: '金券', available: '45' }, { id: '1005', name: '金豆豆', available: '7' }],
    cubs: [cub('60001', '2'), cub('60001', '1'), cub('60001', '9', true)] };
  const card = (id, item, name, price, animal) => ({ id, available: true, reward: { id: item, name }, price: { id: price, name: '货币', count: '3' }, animal });
  f.read(async (_url, config) => {
    const { view, shopId } = config.params; calls.push([view, shopId]);
    const goods = shopId === '5' ? [card('71', '60002', '鸭幼崽', '1007', { husbandry_type: '窝' })] : [card('81', '7001', '牧草', '1005', null)];
    return { data: { ok: true, data: { ...stock, shop: view === 'shop' ? { shopId, goods } : null } } };
  });
  await f.store.refresh(); await h.flush();
  const form = () => h.findAll(f.root, n => n.tag === 'form')[0];
  const select = label => h.findAll(h.findAll(form(), n => n.tag === 'label' && h.textOf(n).trim().startsWith(label))[0], n => n.tag === 'select')[0];
  h.findAll(f.root, n => n.tag === 'details')[0].props.onToggle({ currentTarget: { open: true } });
  await h.flush();
  assert.deepEqual(calls, [['animals', '5'], ['shop', '5']]); assert.equal(f.store.view, 'animals');
  assert.match(h.textOf(select('放养幼崽')), /鸡幼崽 · 可用 3/);
  assert.match(h.textOf(select('放养幼崽')), /鸭幼崽 · 可用 0（补货后放养）/);
  select('放养幼崽').props.onChange({ target: { value: '60002' } }); await h.flush();
  assert.match(h.textOf(select('栏舍')), /栏舍11 · 3\/3（已满）/);
  assert.doesNotMatch(h.textOf(select('栏舍')), /栏舍12|栏舍13/);
  select('栏舍').props['onUpdate:modelValue']('11');
  select('商店').props.onChange({ target: { value: '6' } }); await h.flush();
  assert.match(h.textOf(select('商品')), /牧草/); assert.doesNotMatch(h.textOf(select('商品')), /鸭幼崽/);
  select('商品').props.onChange({ target: { value: '81' } }); await h.flush();
  assert.equal(f.posts.length, 0);
  form().props.onSubmit({ preventDefault() {} }); await h.flush();
  assert.deepEqual(f.posts.map(p => p.url), ['/api/ranch/automation']);
  const { cubId, ranchId, shopId, goodsId, currencyId, buyEnabled } = f.posts[0].body;
  assert.deepEqual({ cubId, ranchId, shopId, goodsId, currencyId, buyEnabled }, { cubId: '60002', ranchId: '11', shopId: '6', goodsId: '81', currencyId: '1005', buyEnabled: false });
});

test('catalogue failures are retryable and a previous account cannot populate current choices', async () => {
  const f = fixture(); await h.flush();
  const pending = h.deferred();
  f.read(async () => pending.promise);
  const loading = f.store.loadOptions('5'); await h.flush();
  f.read(async () => ({ data: { ok: true, data: state() } })); f.mount('account-b'); await h.flush();
  pending.resolve({ data: { ok: true, data: { ...state(), shop: { shopId: '5', goods: [{ id: 'old' }] } } } });
  await loading; assert.deepEqual(Object.keys(f.store.optionShops), []);
  f.read(async () => { throw new Error('牧场暂忙'); }); await f.store.loadOptions('5');
  assert.match(f.store.optionError, /牧场暂忙/); assert.equal(f.store.loadingOptions, false);
  f.read(async () => ({ data: { ok: true, data: { ...state(), shop: { shopId: '5', goods: [] } } } }));
  await f.store.loadOptions('5', true); assert.equal(f.store.optionError, ''); assert.deepEqual(f.store.optionShops['5'].goods, []);
  assert.equal(f.posts.length, 0);
});

function quoteReply(id, validForMs, price = '2') {
  return { data: { ok: true, data: { id, action: 'buy', label: '购买幼崽', count: 1,
    costItems: [{ name: '金券', count: price }], expectedRewards: [{ name: '鸡', count: '1' }],
    expiresAt: Date.now() - 3600000, validForMs } } };
}
const budgetError = '本轮请求预算不足，已为农场与场景恢复保留额度';
const budgetDenied = proof => ({ data: { ok: false, code: 'RANCH_BUDGET_BUSY', error: budgetError, ...proof } });
const confirmedQuote = { operationNotSent: true, quoteId: 'original' };
const economicIntent = { shopId: '5', goodsId: '71', count: 1 };
const operates = f => f.posts.filter(p => p.url.endsWith('/operate')).map(p => p.body.quoteId);

async function budgetFixture(validForMs = 60000) {
  const f = fixture(); await h.flush();
  f.prepare(async () => quoteReply('original', validForMs));
  await f.store.prepare('buy', economicIntent); await h.flush();
  return f;
}
test('a proven budget refusal preserves the confirmation until an explicit click sends once', async () => {
  const f = await budgetFixture();
  let writes = 0;
  f.operate(async () => budgetDenied(confirmedQuote));
  h.click(button(f.root, '确认执行')); await h.flush();
  await h.flush();
  assert.equal(f.store.result.outcome, 'not_sent');
  assert.equal(f.store.blocked, false);
  assert.match(h.textOf(f.root), /操作未发出/);
  assert.ok(h.textOf(f.root).includes(budgetError));
  const dialog = h.findAll(f.root, node => node.props.role === 'dialog')[0];
  assert.ok(dialog, 'the original confirmation remains open');
  assert.ok(h.textOf(dialog).includes(budgetError), 'the refusal is visible inside the confirmation');
  assert.match(h.textOf(dialog), /操作未发出/);
  assert.match(h.textOf(dialog), /金券 × 2/);
  assert.deepEqual(f.store.quote.intent, { action: 'buy', input: economicIntent });
  assert.deepEqual(operates(f), ['original']);
  assert.equal(f.posts.length, 2);
  assert.equal(writes, 0);
  const reply = h.deferred();
  f.operate(() => { writes++; return reply.promise; });
  const confirm = button(f.root, '确认执行');
  h.click(confirm); h.click(confirm); await h.flush();
  assert.equal(writes, 1);
  reply.resolve({ data: { ok: true, data: { outcome: 'confirmed', snapshot: state() } } }); await h.flush();
  assert.deepEqual(operates(f), ['original', 'original']);
  assert.match(h.textOf(f.root), /操作已确认/);
});
test('expiry while waiting for a budget rejection permits only a fresh quote before another execute', async () => {
  const f = await budgetFixture(500);
  const pending = h.deferred();
  const deadline = f.store.quote.deadline;
  f.operate(() => pending.promise);
  h.click(button(f.root, '确认执行'));
  assert.deepEqual(operates(f), ['original']);
  await new Promise(resolve => setTimeout(resolve, Math.max(0, deadline - performance.now()) + 10));
  pending.resolve(budgetDenied(confirmedQuote)); await h.flush();
  assert.equal(f.store.result.outcome, 'not_sent');
  assert.ok(button(f.root, '重新核对'));
  f.prepare(async () => quoteReply('fresh', 60000, '4'));
  h.click(button(f.root, '重新核对')); await h.flush();
  assert.deepEqual(operates(f), ['original']);
  assert.deepEqual(f.posts.at(-1).body.input, economicIntent);
  assert.match(h.textOf(f.root), /金券 × 4/);
  assert.equal(f.store.quote.notSentMessage, undefined, 'a new quote clears the previous refusal');
  f.operate(async () => ({ data: { ok: true, data: { outcome: 'confirmed', snapshot: state() } } }));
  h.click(button(f.root, '确认执行')); await h.flush();
  assert.deepEqual(operates(f), ['original', 'fresh']);
});
for (const [scenario, invalidate] of [
  ['account switch', f => f.mount('account-b')],
  ['unmount and reentry', f => { h.render(null, f.root); f.mount('account-a'); }],
  ['confirmation sequence change', f => f.store.closeQuote()],
]) {
  test(`late budget refusal cannot restore a confirmation after ${scenario}`, async () => {
    const f = await budgetFixture();
    const pending = h.deferred();
    f.operate(() => pending.promise);
    h.click(button(f.root, '确认执行')); invalidate(f); await h.flush();
    pending.resolve(budgetDenied(confirmedQuote)); await h.flush();
    assert.equal(f.store.quote, null);
    assert.equal(f.store.result?.outcome, undefined);
    assert.equal(button(f.root, '确认执行'), undefined);
    assert.deepEqual(operates(f), ['original']);
    assert.equal(f.posts.length, 2);
  });
}
for (const [scenario, reject] of [
  ['legacy budget rejection', () => budgetDenied({})],
  ['mismatched quote', () => budgetDenied({ ...confirmedQuote, quoteId: 'another' })],
  ['scene recovery failure', () => budgetDenied({ ...confirmedQuote, sceneRecoveryRequired: true })],
  ['transport timeout', () => { throw new Error('synthetic timeout'); }],
]) {
  test(`${scenario} keeps the operation unknown and blocks replay after reentry`, async () => {
    const f = await budgetFixture(); f.operate(reject);
    h.click(button(f.root, '确认执行')); await h.flush();
    assert.equal(f.store.quote, null);
    assert.equal(f.store.result?.outcome, 'unknown');
    h.render(null, f.root); f.mount('account-a'); await h.flush();
    assert.equal(f.store.result?.outcome, 'unknown');
    assert.equal(f.store.blocked, true);
    f.read(async () => ({ data: { ok: true, data: { ...state(), lastOperation: { id: 'previous', outcome: 'confirmed' } } } }));
    await f.store.refresh();
    assert.equal(f.store.result.id, 'original');
    assert.equal(f.store.result.outcome, 'unknown');
    assert.equal(await f.store.prepare('buy', economicIntent), false);
    assert.equal(await f.store.execute(), false);
    assert.deepEqual(operates(f), ['original']);
    assert.equal(f.posts.length, 2);
  });
}
test('explicit acknowledgement clears a lost admission only after the server cancels its prepared quote', async () => {
  const f = await budgetFixture(); f.operate(() => budgetDenied({}));
  h.click(button(f.root, '确认执行')); await h.flush();
  await f.store.refresh(); await h.flush();
  assert.equal(f.store.uncertain, true);
  f.acknowledge(async body => ({ data: { ok: true, data: { id: body.operationId, outcome: 'not_sent', message: '已取消尚未发送的操作' } } }));
  h.click(button(f.root, '已核对，允许继续')); await h.flush();
  assert.equal(f.posts.at(-1).url, '/api/ranch/acknowledge');
  assert.deepEqual(f.posts.at(-1).body, { operationId: 'original' });
  assert.equal(f.store.result.outcome, 'not_sent');
  assert.equal(f.store.uncertain, false);
  assert.equal(f.store.quote, null);
  assert.deepEqual(operates(f), ['original']);
  assert.equal(f.store.blocked, false);
});
test('duplicate old acknowledgements cannot clear the next unknown operation or its reentry state', async () => {
  const f = await budgetFixture();
  f.operate(async () => { throw new Error('synthetic transport interruption'); });
  await f.store.execute();
  const replies = [];
  f.acknowledge(body => {
    const reply = h.deferred(); replies.push({ body, reply }); return reply.promise;
  });
  const first = f.store.acknowledge();
  const second = f.store.acknowledge();
  replies[0].reply.resolve({ data: { ok: true, data: { id: 'original', outcome: 'not_sent' } } });
  await first;
  f.prepare(async () => quoteReply('next-unknown', 60000));
  await f.store.prepare('buy', economicIntent);
  await f.store.execute();
  for (const pending of replies.slice(1)) pending.reply.resolve({ data: { ok: true, data: { id: 'original', outcome: 'not_sent' } } });
  await second; await h.flush();
  assert.equal(replies.length, 1, 'only one acknowledgement may be in flight');
  assert.equal(f.store.result.id, 'next-unknown');
  assert.equal(f.store.result.outcome, 'unknown');
  assert.equal(f.store.blocked, true);
  h.render(null, f.root); f.mount('account-a'); await h.flush();
  assert.equal(f.store.result.id, 'next-unknown');
  assert.equal(f.store.result.outcome, 'unknown');
  assert.equal(f.store.blocked, true);
  assert.deepEqual(operates(f), ['original', 'next-unknown']);
});
test('acknowledgement busy state disables the button and blocks reads and new intents', async () => {
  const f = await budgetFixture(); f.operate(() => budgetDenied({}));
  await f.store.execute(); await h.flush();
  const replies = [];
  f.acknowledge(() => { const pending = h.deferred(); replies.push(pending); return pending.promise; });
  const action = button(f.root, '已核对，允许继续');
  h.click(action); h.click(action); await h.flush();
  const busy = f.store.acknowledging;
  const disabled = button(f.root, '已核对，允许继续')?.props.disabled;
  const read = await f.store.refresh();
  const prepare = await f.store.prepare('buy', economicIntent);
  const execute = await f.store.execute();
  for (const reply of replies) reply.resolve({ data: { ok: true, data: { id: 'original', outcome: 'not_sent' } } });
  await h.flush();
  assert.equal(busy, true); assert.equal(disabled, true);
  assert.equal(read, false); assert.equal(prepare, false); assert.equal(execute, false);
  assert.equal(replies.length, 1);
  assert.equal(f.store.acknowledging, false);
  assert.deepEqual(operates(f), ['original']);
});
test('old acknowledgement completion after an account switch cannot release the new acknowledgement', async () => {
  const f = await budgetFixture();
  f.operate(async () => { throw new Error('synthetic transport interruption'); });
  await f.store.execute();
  const oldReply = h.deferred(); const newReply = h.deferred();
  f.acknowledge(body => body.operationId === 'original' ? oldReply.promise : newReply.promise);
  const old = f.store.acknowledge();
  f.mount('account-b'); await h.flush();
  f.prepare(async () => quoteReply('account-b-unknown', 60000));
  await f.store.prepare('buy', economicIntent); await f.store.execute();
  const current = f.store.acknowledge();
  oldReply.resolve({ data: { ok: true, data: { id: 'original', outcome: 'not_sent' } } });
  await old;
  const stillBusy = f.store.acknowledging;
  const currentId = f.store.result.id;
  newReply.resolve({ data: { ok: true, data: { id: 'account-b-unknown', outcome: 'not_sent' } } });
  await current;
  assert.equal(stillBusy, true);
  assert.equal(currentId, 'account-b-unknown');
  assert.equal(f.store.accountId, 'account-b');
  assert.equal(f.store.result.id, 'account-b-unknown');
  assert.equal(f.store.result.outcome, 'not_sent');
  assert.equal(f.store.acknowledging, false);
});
for (const reply of [null, { id: 'different', outcome: 'not_sent' }, { id: 'original', outcome: 'confirmed' }]) {
  test(`invalid acknowledgement ${JSON.stringify(reply)} keeps the current unknown and allows explicit recovery`, async () => {
    const f = await budgetFixture(); f.operate(() => budgetDenied({}));
    await f.store.execute();
    f.acknowledge(async () => ({ data: { ok: true, data: reply } }));
    const invalid = await f.store.acknowledge();
    assert.equal(invalid, false);
    assert.equal(f.store.result.id, 'original'); assert.equal(f.store.result.outcome, 'unknown');
    assert.equal(f.store.acknowledging, false); assert.equal(f.store.blocked, true);
    f.acknowledge(async () => ({ data: { ok: true, data: { id: 'original', outcome: 'not_sent' } } }));
    assert.equal(await f.store.acknowledge(), true);
    assert.deepEqual(operates(f), ['original']);
  });
}
test('an acknowledgement failure preserves unknown and a later explicit retry can succeed', async () => {
  const f = await budgetFixture(); f.operate(() => budgetDenied({}));
  await f.store.execute();
  f.acknowledge(async () => { throw new Error('synthetic acknowledgement interruption'); });
  assert.equal(await f.store.acknowledge(), false);
  assert.equal(f.store.result.outcome, 'unknown'); assert.equal(f.store.acknowledging, false);
  f.acknowledge(async () => ({ data: { ok: true, data: { id: 'original', outcome: 'not_sent' } } }));
  assert.equal(await f.store.acknowledge(), true);
  assert.equal(f.posts.filter(post => post.url.endsWith('/acknowledge')).length, 2);
  assert.deepEqual(operates(f), ['original']);
});
test('a fresh observed result can settle an unknown operation for the same confirmation', async () => {
  const f = await budgetFixture();
  f.operate(async () => { throw new Error('synthetic timeout'); });
  h.click(button(f.root, '确认执行')); await h.flush();
  assert.equal(f.store.result.outcome, 'unknown');
  f.read(async () => ({ data: { ok: true, data: { ...state(), lastOperation: { id: 'original', outcome: 'confirmed' } } } }));
  await f.store.refresh(); await h.flush();
  assert.match(h.textOf(f.root), /操作已确认/);
  assert.equal(f.store.blocked, false);
  assert.deepEqual(operates(f), ['original']);
});
test('a fresh ranch confirmation works when the browser wall clock is ahead of the game clock', async () => {
  const f = fixture(); await h.flush(); f.prepare(async () => quoteReply('original', 55000));
  await f.store.prepare('buy', { shopId: '5', goodsId: '71', count: 1 }); await h.flush();
  h.click(button(f.root, '确认执行')); await h.flush();
  assert.deepEqual(f.posts.filter(p => p.url.endsWith('/operate')).map(p => p.body.quoteId), ['original']);
  assert.match(h.textOf(f.root), /操作已确认/);
});
test('expired ranch quote renews the original selection and shows the new price before any write', async () => {
  const f = fixture(); await h.flush(); let round = 0;
  f.prepare(async () => ++round === 1 ? quoteReply('old', 0, '2') : quoteReply('fresh', 55000, '4'));
  const input = { shopId: '5', goodsId: '71', count: 1 };
  await f.store.prepare('buy', input); input.count = 9; await h.flush();
  assert.ok(button(f.root, '重新核对')); h.click(button(f.root, '重新核对')); await h.flush();
  assert.equal(f.posts.filter(p => p.url.endsWith('/operate')).length, 0);
  assert.equal(f.posts.filter(p => p.url.endsWith('/prepare')).at(-1).body.input.count, 1);
  assert.match(h.textOf(f.root), /金券 × 4/);
  h.click(button(f.root, '确认执行')); await h.flush();
  assert.deepEqual(f.posts.filter(p => p.url.endsWith('/operate')).map(p => p.body.quoteId), ['fresh']);
});
test('server expiry offers a fresh review; a lost execute reply is never renewed', async () => {
  const f = fixture(); await h.flush(); let seq = 0; f.prepare(async () => quoteReply(`quote-${++seq}`, 60000));
  f.operate(async () => { throw Object.assign(new Error('expired'), { response: { data: { ok: false, code: 'RANCH_QUOTE_EXPIRED', error: '确认已到期' } } }); });
  await f.store.prepare('buy', { shopId: '5', goodsId: '71', count: 1 }); await f.store.execute(); await h.flush();
  assert.equal(f.store.uncertain, false); assert.ok(button(f.root, '重新核对'));
  assert.equal(await f.store.execute(), false, 'renewing a quote does not report a confirmed operation'); await h.flush();
  f.operate(async () => { throw new Error('synthetic timeout'); });
  await f.store.execute(); await h.flush();
  assert.equal(f.store.result.outcome, 'unknown'); assert.equal(f.store.quote, null);
  assert.equal(await f.store.prepare('buy', { count: 1 }), false);
  assert.equal(f.posts.filter(p => p.url.endsWith('/prepare')).length, 2);
});
test('changing account while renewing a ranch quote discards late confirmation', async () => {
  const f = fixture(); await h.flush(); f.prepare(async () => quoteReply('old', 0));
  await f.store.prepare('buy', { count: 1 }); await h.flush();
  const wait = h.deferred(); f.prepare(() => wait.promise);
  h.click(button(f.root, '重新核对')); f.mount('account-b'); await h.flush();
  wait.resolve(quoteReply('foreign', 60000)); await h.flush();
  assert.equal(f.store.quote, null); assert.equal(f.posts.filter(p => p.url.endsWith('/operate')).length, 0);
});

test('nest task opens its facility without spending and only a separate confirmation starts the upgrade', async () => {
  const f = fixture(); await h.flush();
  const nest = { id: '41', moduleType: 6, name: '窝', active: true, capacity: 3, level: 1,
    upgrade: { status: 'available', nextLevel: 2, nextCapacity: 4, requiredLevel: 8, durationSec: 10, canStart: true,
      costs: [{ id: '1007', name: '金券', count: '14000' }] } };
  const task = { desc: '窝升级至2级', id: '300018', upgradeFacilityModuleType: 6, upgradeFacilityLevel: 2,
    progress: '1', total: '2', unlocked: true, claimed: false, canClaim: false, rewards: [] };
  const stock = { ...state(), level: 9, facilities: [nest], currencies: [{ id: '1007', name: '金券', available: '5709', total: '5709' }] };
  f.read(async (_, config) => ({ data: { ok: true, data: { ...stock, tasks: config.params.view === 'tasks' ? [task] : null } } }));
  h.click(button(f.root, '牧场任务')); await h.flush();
  h.click(button(f.root, '前往窝升级')); await h.flush();
  assert.equal(f.store.view, 'animals'); assert.equal(f.posts.length, 0);
  assert.match(h.textOf(f.root), /还差 8291/); assert.match(h.textOf(f.root), /容量 3 → 4/);
  f.prepare(async () => ({ data: { ok: false, code: 'RANCH_INSUFFICIENT_BALANCE', error: '金券不足，升级还差 8291' } }));
  h.click(button(f.root, '升级至 2 级')); await h.flush();
  assert.equal(f.store.quote, null); assert.match(h.textOf(f.root), /金券不足/);
  f.prepare(async () => quoteReply('nest-quote', 60000, '13800'));
  h.click(button(f.root, '升级至 2 级')); await h.flush();
  assert.equal(f.posts.length, 2);
  for (const post of f.posts) assert.deepEqual(post.body, { action: 'upgrade', input: { facilityId: '41' } });
  assert.match(h.textOf(f.root), /金券 × 13800/);
  f.operate(async () => ({ data: { ok: true, data: { outcome: 'confirmed', message: '已开始升级',
    snapshot: { ...stock, serverTime: 1800000000000, facilities: [{ ...nest, upgrade: { ...nest.upgrade, canStart: false, status: 'in_progress', endTimeMs: 1800000010000 } }] } } } }));
  h.click(button(f.root, '确认执行')); await h.flush();
  assert.match(h.textOf(f.root), /正在升级至 2 级/); assert.equal(button(f.root, '完成升级'), undefined);
  f.read(async () => ({ data: { ok: true, data: { ...stock, facilities: [{ ...nest, upgrade: { ...nest.upgrade, canStart: false, canComplete: true, status: 'ready' } }] } } }));
  h.click(button(f.root, '刷新牧场')); await h.flush();
  h.click(button(f.root, '完成升级')); await h.flush();
  assert.deepEqual(f.posts.at(-1).body, { action: 'completeUpgrade', input: { facilityId: '41' } });
  assert.deepEqual(f.posts.filter(p => p.url.endsWith('/operate')).map(p => p.body.quoteId), ['nest-quote']);
});

test('stocking settings independently save either type and do not enable fixed purchase', async () => {
  const f = fixture();
  await h.flush();
  const form = h.findAll(f.root, node => node.tag === 'form')[0];
  const field = label => h.findAll(h.findAll(form, node => node.tag === 'label' && h.textOf(node).trim() === label)[0], node => node.tag === 'input')[0];
  assert.match(h.textOf(form), /先放养背包里匹配的幼崽/);
  assert.match(h.textOf(form), /栏舍已满、未解锁或状态不明时暂停补齐/);
  function set(label, value) {
    field(label).props['onUpdate:modelValue'](value);
  }
  set('启用牧场自动化', true);
  set('补齐棚', true);
  set('每日最多放养', 3);
  set('每日最多花费', 25);
  await h.flush();
  assert.equal(field('每日最多花费').props.min, 1);
  form.props.onSubmit({ preventDefault() {} });
  await h.flush();
  assert.equal(f.posts[0].body.stockCoop, false);
  assert.equal(f.posts[0].body.stockShed, true);
  assert.equal(f.posts[0].body.buyEnabled, false);
  assert.equal(f.posts[0].body.cubDailyLimit, 3);
  assert.equal(f.posts[0].body.currencyDailyLimit, 25);
  set('补齐棚', false);
  set('补齐窝', true);
  await h.flush();
  form.props.onSubmit({ preventDefault() {} });
  await h.flush();
  assert.equal(f.posts[1].body.stockCoop, true);
  assert.equal(f.posts[1].body.stockShed, false);
});
