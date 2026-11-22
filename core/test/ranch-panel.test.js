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
assert.equal(fs.realpathSync(privateDir), privateDir);
function fixturePath(name) {
  const target = path.resolve(privateDir, name);
  assert.equal(path.dirname(target), privateDir);
  assert.equal(fs.existsSync(target), false);
  return target;
}
process.env.FARM_DATA_DIR = privateDir;
process.env.FARM_PRIVATE_CONFIG_FILE = fixturePath('private-config.json');
process.env.FARM_LOG_DIR = fixturePath('logs');
process.env.FARM_SESSION_LOG_DIR = fixturePath('session-logs');
const h = require('./activity-availability.test');
const { DEFAULT_POLICY, targetTypes } = require('../src/services/ranch-policy');
const state = () => ({ level: 1, grass: '30', currencies: [], facilities: [], cubs: [], inventory: [],
  animals: [{ id: 7, ranchId: '11', name: '鸡', canProduce: true }], tasks: [], lastOperation: null });
const roots = [];
test.after(() => {
  try { for (const root of roots) h.render(null, root); }
  finally {
    assert.equal(fs.realpathSync(privateDir), privateDir);
    fs.rmSync(privateDir, { recursive: true, force: true });
    assert.equal(fs.existsSync(privateDir), false);
  }
});
function fixture(initialPolicy = {}) {
  const posts = []; let read = async () => ({ data: { ok: true, data: state() } }); let prepare; let operate; let acknowledge; let cancel;
  const api = {
    get: async (url, config) => url.endsWith('/automation') ? { data: { ok: true, data: { policy: { ...DEFAULT_POLICY, ...initialPolicy }, targetTypes, revision: 0 } } } : read(url, config),
    post: async (url, body, config) => {
      posts.push({ url, body, config });
      if (url.endsWith('/prepare')) return prepare ? prepare() : { data: { ok: true, data: { id: 'synthetic-quote', label: '牧场生产', count: 1, costItems: [], expiresAt: Date.now() + 60000 } } };
      if (url.endsWith('/automation')) return { data: { ok: true, data: { policy: body, targetTypes, revision: 1 } } };
      if (url.endsWith('/operate') && operate) return operate();
      if ((url.endsWith('/acknowledge') || url.endsWith('/reconcile-feed')) && acknowledge) return acknowledge(body);
      if (url.endsWith('/cancel')) return cancel ? cancel() : { data: { ok: true, data: { cancelled: true } } };
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
  return { root, store, posts, mount, read: fn => { read = fn; }, prepare: fn => { prepare = fn; }, operate: fn => { operate = fn; }, acknowledge: fn => { acknowledge = fn; }, cancel: fn => { cancel = fn; } };
}
const button = (root, label) => h.buttonsOf(root).find(x => h.textOf(x).includes(label));
test('每日礼包入口按账号读取可领状态，确认后清除红点并显示回执', async () => {
  const f = fixture();
  await h.flush();
  const reward = { id: '80021', name: '无机罐头（1小时）', count: '1' };
  f.read(async (url, config) => {
    assert.equal(url, '/api/ranch/state');
    assert.equal(config.headers['x-account-id'], 'account-a');
    assert.equal(config.params.view, 'mallGift');
    return { data: { ok: true, data: { ...state(), mallGift: { status: 'ready', reward } } } };
  });
  f.prepare(() => ({ data: { ok: true, data: { id: 'gift-quote', label: '领取牧场每日礼包', count: 1,
    costItems: [], expectedRewards: [reward], validForMs: 60000 } } }));
  f.operate(() => ({ data: { ok: true, data: { id: 'gift-quote', action: 'claimMallGift', outcome: 'confirmed', completed: 1,
    message: '操作已确认', rewards: [reward], snapshot: { ...state(), mallGift: { status: 'claimed', reward } } } } }));
  h.click(button(f.root, '每日礼包'));
  await h.flush();
  assert.match(h.textOf(f.root), /今日可领取/);
  assert.equal(h.findAll(f.root, node => node.props['aria-label'] === '可领取').length, 1);
  h.click(button(f.root, '免费领取'));
  await h.flush();
  assert.deepEqual(f.posts.map(row => row.body), [{ action: 'claimMallGift', input: {} }]);
  assert.match(h.textOf(f.root), /预计获得：无机罐头（1小时） × 1/);
  h.click(button(f.root, '确认执行'));
  await h.flush();
  assert.deepEqual(f.posts.at(-1).body, { quoteId: 'gift-quote' });
  assert.match(h.textOf(f.root), /今日已领取/);
  assert.match(h.textOf(f.root), /已获得：无机罐头（1小时） × 1/);
  assert.equal(h.findAll(f.root, node => node.props['aria-label'] === '可领取').length, 0);
  assert.equal(button(f.root, '免费领取').props.disabled, true);

  const form = h.findAll(f.root, node => node.tag === 'form')[0];
  const option = h.findAll(form, node => node.tag === 'label' && h.textOf(node).trim() === '领取免费每日礼包')[0];
  assert.equal(f.store.automation.policy.mallGift, false);
  h.findAll(option, node => node.tag === 'input')[0].props['onUpdate:modelValue'](true);
  await h.flush();
  form.props.onSubmit({ preventDefault() {} });
  await h.flush();
  assert.equal(f.posts.at(-1).body.mallGift, true);
  assert.equal(f.posts.at(-1).body.buyEnabled, false);
});

test('friend ranch reads the selected account and uses the existing preview and confirmation flow', async () => {
  const f = fixture(); await h.flush();
  const reads = [];
  f.read(async (url, config) => {
    reads.push([url, config.headers['x-account-id'], config.params?.gid]);
    const data = url === '/api/friends' ? [{ gid: 73, name: '测试好友' }]
      : { host: '73', name: '测试好友', stealCount: 1, cleanCount: 1 };
    return { data: { ok: true, data } };
  });
  const section = h.findAll(f.root, node => node.tag === 'details'
    && h.findAll(node, child => child.tag === 'summary' && h.textOf(child).trim() === '好友牧场').length === 1)[0];
  section.props.onToggle({ currentTarget: { open: true } }); await h.flush();
  const select = h.findAll(section, node => node.props['aria-label'] === '选择好友牧场')[0];
  select.props.onChange({ target: { value: '73' } }); await h.flush();
  assert.deepEqual(reads, [['/api/friends', 'account-a', undefined], ['/api/ranch/friend', 'account-a', '73']]);
  assert.equal(f.posts.length, 0);
  h.click(button(section, '偷取产物')); await h.flush();
  assert.deepEqual(f.posts.map(row => row.body), [{ action: 'stealFriend', input: { hostGid: '73' } }]);
  h.click(button(f.root, '确认执行')); await h.flush();
  assert.equal(f.posts.filter(row => row.url.endsWith('/operate')).length, 1);
  h.click(button(section, '帮好友清理')); await h.flush();
  assert.deepEqual(f.posts.at(-1).body, { action: 'cleanFriend', input: { hostGid: '73' } });
});

test('ranch sale and friend switches are initially disabled and save as independent account options', async () => {
  const f = fixture();
  await h.flush();
  const form = h.findAll(f.root, node => node.tag === 'form')[0];
  const options = ['自动出售剩余可售产物', '自动偷取好友牧场产物', '自动帮好友清理牧场'];
  const inputs = options.map(text => h.findAll(form, node => node.tag === 'label' && h.textOf(node).trim() === text)
    .flatMap(label => h.findAll(label, node => node.tag === 'input'))[0]);
  assert.equal(f.store.automation.policy.sellProducts, false);
  assert.equal(f.store.automation.policy.friendSteal, false);
  assert.equal(f.store.automation.policy.friendClean, false);
  inputs[0].props['onUpdate:modelValue'](true);
  inputs[2].props['onUpdate:modelValue'](true);
  await h.flush();
  form.props.onSubmit({ preventDefault() {} });
  await h.flush();
  const saved = f.posts.find(row => row.url.endsWith('/automation'));
  assert.equal(saved.config.headers['x-account-id'], 'account-a');
  assert.equal(saved.body.sellProducts, true);
  assert.equal(saved.body.friendSteal, false);
  assert.equal(saved.body.friendClean, true);
});

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
    if (scenario === 'unmount and reentry') {
      await f.store.refresh();
      assert.equal(f.store.result, null, 'fresh read can settle the old request after a proven no-send rejection');
    }
    else assert.equal(f.store.result?.outcome, undefined);
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

test('stocking settings save either type without a budget and keep manual limits optional', async () => {
  const f = fixture();
  await h.flush();
  const form = h.findAll(f.root, node => node.tag === 'form')[0];
  const field = (label) => {
    const element = h.findAll(form, node => node.tag === 'label' && h.textOf(node).trim() === label)[0];
    return element && h.findAll(element, node => node.tag === 'input')[0];
  };
  assert.match(h.textOf(form), /先放养背包里匹配的幼崽/);
  assert.match(h.textOf(form), /栏舍已满、未解锁或状态不明时暂停补齐/);
  function set(label, value) {
    field(label).props['onUpdate:modelValue'](value);
  }
  set('启用牧场自动化', true);
  set('补齐棚', true);
  await h.flush();
  assert.equal(field('每日最多放养'), undefined);
  assert.equal(field('每日最多花费'), undefined);
  assert.equal(field('手动设置补齐额度').props.checked, false);
  form.props.onSubmit({ preventDefault() {} });
  await h.flush();
  const live = require('../src/services/ranch-policy').normalizePolicy(f.posts[0].body);
  assert.equal(live.stockBudgetMode, 'live');
  assert.equal(live.stockCoop, false);
  assert.equal(live.stockShed, true);
  assert.equal(live.buyMissingCubs, true);
  assert.equal(live.buyEnabled, false);
  assert.equal(live.cubDailyLimit, 0);
  assert.equal(live.currencyDailyLimit, 0);

  set('补齐棚', false);
  set('补齐窝', true);
  field('手动设置补齐额度').props.onChange({ target: { checked: true } });
  await h.flush();
  assert.equal(field('每日最多放养').props.min, 1);
  assert.equal(field('每日最多花费').props.min, 1);
  set('每日最多放养', 3);
  set('每日最多花费', 25);
  form.props.onSubmit({ preventDefault() {} });
  await h.flush();
  const manual = require('../src/services/ranch-policy').normalizePolicy(f.posts[1].body);
  assert.equal(manual.stockBudgetMode, 'manual');
  assert.equal(manual.stockCoop, true);
  assert.equal(manual.stockShed, false);
  assert.equal(manual.cubDailyLimit, 3);
  assert.equal(manual.currencyDailyLimit, 25);
});

test('switching ranch accounts discards unsaved stocking and smart feed changes', async () => {
  const f = fixture();
  await h.flush();
  const toggle = () => {
    const label = h.findAll(f.root, node => node.tag === 'label' && h.textOf(node).trim() === '补齐窝')[0];
    return h.findAll(label, node => node.tag === 'input')[0];
  };
  toggle().props['onUpdate:modelValue'](true);
  h.findAll(f.root, node => node.tag === 'input' && node.props.name === 'smartFeed')[0].props['onUpdate:modelValue'](true);
  await h.flush();
  f.mount('account-b');
  await h.flush();
  const form = h.findAll(f.root, node => node.tag === 'form')[0];
  form.props.onSubmit({ preventDefault() {} });
  await h.flush();
  assert.equal(f.posts.length, 1);
  assert.equal(f.posts[0].config.headers['x-account-id'], 'account-b');
  assert.equal(f.posts[0].body.stockCoop, false);
  assert.equal(f.posts[0].body.smartFeed, false);
  assert.equal(f.posts[0].body.stockBudgetMode, 'live');
});

test('smart stock takes over both fixed cub rules before the catalogue loads, and releases only the chosen type', async () => {
  const f = fixture({ enabled: false, placeEnabled: true, cubId: '60002', ranchId: '11', cubDailyLimit: 3,
    buyEnabled: true, shopId: '5', goodsId: '10008', currencyDailyLimit: 200 });
  await h.flush();
  const form = h.findAll(f.root, node => node.tag === 'form')[0];
  const field = label => {
    const entry = h.findAll(form, node => node.tag === 'label' && h.textOf(node).trim() === label)[0];
    return entry && h.findAll(entry, node => node.tag === 'input')[0];
  };
  assert.match(h.textOf(form), /开启补栏时会同时启用牧场自动化/);
  field('智能补栏').props.onChange({ target: { checked: true } });
  await h.flush();
  assert.match(h.textOf(form), /已接管窝，.*指定放养规则暂停/);
  assert.match(h.textOf(form), /已接管棚，.*指定幼崽购买规则暂停/);
  assert.equal(field('每日最多放养'), undefined);
  assert.equal(field('每日最多花费'), undefined);
  field('库存不足时补购幼崽').props['onUpdate:modelValue'](false);
  await h.flush();
  assert.match(h.textOf(form), /只用库存/);
  assert.match(h.textOf(form), /指定幼崽购买规则暂停/);
  form.props.onSubmit({ preventDefault() {} }); await h.flush();
  const policy = f.posts.at(-1).body;
  assert.deepEqual([policy.enabled, policy.stockCoop, policy.stockShed, policy.buyMissingCubs], [true, true, true, false]);
  assert.deepEqual([policy.placeEnabled, policy.cubId, policy.ranchId, policy.buyEnabled, policy.goodsId], [true, '60002', '11', true, '10008']);
  field('补齐棚').props['onUpdate:modelValue'](false); await h.flush();
  assert.match(h.textOf(form), /当前仅管理窝/);
  assert.doesNotMatch(h.textOf(form), /指定幼崽购买规则暂停/);
  assert.ok(field('每日最多花费'));
  assert.equal(field('每日最多放养'), undefined);
  field('智能补栏').props.onChange({ target: { checked: false } }); await h.flush();
  assert.ok(field('每日最多放养'));
  assert.doesNotMatch(h.textOf(form), /规则暂停/);
});

test('smart feed uses a boolean and parks only the stock-grass and matching pasture-purchase rules', async () => {
  const f = fixture({ enabled: true, grassEnabled: true, grassDailyLimit: 30, grassReserve: 5,
    buyEnabled: true, shopId: '6', goodsId: '10001', purchaseCount: 4, currencyDailyLimit: 12 });
  await h.flush();
  const form = h.findAll(f.root, node => node.tag === 'form')[0];
  const control = (label, tag = 'input') => {
    const field = h.findAll(form, node => node.tag === 'label' && h.textOf(node).trim().startsWith(label))[0];
    return h.findAll(field, node => node.tag === tag)[0];
  };
  const set = (label, value) => control(label).props['onUpdate:modelValue'](value);

  assert.equal(control('智能供草').props.role, 'switch');
  assert.equal(control('每日最多使用').props.required, true);
  assert.equal(control('单次购买数量').props.required, true);
  assert.equal(control('每日最多花费').props.required, true);

  set('智能供草', true);
  await h.flush();
  assert.match(h.textOf(form), /按动物占栏比例计算牧草目标储备.*先用库存.*用金券补购.*无需填写预算/);
  assert.match(h.textOf(form), /库存补草规则暂停，指定购买牧草也会暂停/);
  assert.match(h.textOf(form), /指定牧草购买暂停/);
  for (const label of ['每日最多使用', '至少保留牧草', '单次购买数量', '每日最多花费', '至少保留货币']) {
    assert.equal(control(label).props.required, false, `${label} must not block smart feed`);
    assert.ok(!control(label).props.disabled, `${label} stays editable`);
  }
  assert.equal(control('单次购买数量').props.min, undefined);

  set('每日最多使用', '');
  set('单次购买数量', '');
  set('每日最多花费', '');
  form.props.onSubmit({ preventDefault() {} });
  await h.flush();
  const parked = f.posts.at(-1).body;
  const policyTools = require('../src/services/ranch-policy');
  const policy = policyTools.normalizePolicy(parked);
  assert.equal(policy.smartFeed, true);
  assert.deepEqual([policy.grassEnabled, policy.buyEnabled, policy.goodsId, policy.purchaseCount], [true, true, '10001', 4]);
  assert.equal(policyTools.isAutomaticActionEnabled(policy, 'addGrass'), false);
  assert.equal(policyTools.isAutomaticActionEnabled(policy, 'buy'), false);

  control('商品', 'select').props.onChange({ target: { value: '10002' } });
  await h.flush();
  assert.doesNotMatch(h.textOf(form), /指定牧草购买暂停/);
  assert.equal(control('每日最多花费').props.required, true);
  assert.equal(control('单次购买数量').props.min, 1);
  control('商店', 'select').props.onChange({ target: { value: '5' } });
  control('商品', 'select').props.onChange({ target: { value: '10001' } });
  await h.flush();
  assert.doesNotMatch(h.textOf(form), /指定牧草购买暂停/);
  assert.equal(control('每日最多花费').props.required, true);

  control('商店', 'select').props.onChange({ target: { value: '6' } });
  control('商品', 'select').props.onChange({ target: { value: '10001' } });
  set('智能供草', false);
  set('每日最多使用', 20);
  set('每日最多花费', 15);
  await h.flush();
  form.props.onSubmit({ preventDefault() {} });
  await h.flush();
  const restored = policyTools.normalizePolicy(f.posts.at(-1).body);
  assert.equal(restored.smartFeed, false);
  assert.equal(policyTools.isAutomaticActionEnabled(restored, 'addGrass'), true);
  assert.equal(policyTools.isAutomaticActionEnabled(restored, 'buy'), true);
});

test('uncertain grass operations show expected versus observed amounts without a human acknowledgement button', async () => {
  const f = fixture(); await h.flush();
  f.read(async () => ({ data: { ok: true, data: { ...state(), lastOperation: {
    id: 'feed-review', action: 'addGrass', outcome: 'unknown', label: '补充牧草', message: '账目暂未匹配',
    reconciliation: { expectedGrass: '5', observedGrass: '5', expectedMachine: '5', observedMachine: '4', checking: false },
  } } } }));
  assert.equal(await f.store.refresh(), true); await h.flush();
  assert.match(h.textOf(f.root), /程序正在自动核账/);
  assert.match(h.textOf(f.root), /实测 4/);
  assert.equal(button(f.root, '已核对，允许继续'), undefined);
  assert.ok(button(f.root, '查看最新数量'));
});

test('the next refresh settles a lost feed HTTP response without a user acknowledgement', async () => {
  const f = fixture(); await h.flush();
  f.prepare(async () => quoteReply('feed-http-lost', 60000));
  assert.ok(await f.store.prepare('addGrass', { facilityId: '22', count: 5 }));
  f.operate(async () => { throw new Error('synthetic lost HTTP response'); });
  await f.store.execute();
  assert.equal(f.store.result.feedOperation, true);
  f.acknowledge(async body => ({ data: { ok: true, data: { id: body.operationId, outcome: 'not_sent', completed: 0 } } }));
  assert.equal(await f.store.refresh(), true);
  assert.equal(f.store.result.outcome, 'not_sent');
  assert.equal(f.posts.filter(p => p.url.endsWith('/acknowledge')).length, 0);
  assert.equal(f.posts.filter(p => p.url.endsWith('/operate')).length, 1);
});

const cancellations = f => f.posts.filter(post => post.url === '/api/ranch/cancel');
const cancelReply = { data: { ok: true, data: { cancelled: true } } };

for (const [label, dismiss] of [
  ['the cancel button', (f, dialog) => h.click(button(dialog, '取消'))],
  ['Escape', (_f, dialog) => dialog.props.onKeydown({ key: 'Escape', preventDefault() {}, stopPropagation() {} })],
  ['the overlay', (_f, dialog) => h.click(dialog.parent)],
]) {
  test(`${label} posts the displayed quote once and clears its confirmation immediately`, async () => {
    const f = await budgetFixture();
    const wait = h.deferred(); f.cancel(() => wait.promise);
    const dialog = h.findAll(f.root, node => node.props.role === 'dialog')[0];
    dismiss(f, dialog); dismiss(f, dialog);
    assert.equal(f.store.quote, null);
    assert.deepEqual(cancellations(f).map(post => [post.body, post.config.headers['x-account-id']]), [
      [{ quoteId: 'original' }, 'account-a'],
    ]);
    wait.resolve(cancelReply); await h.flush();
    assert.equal(f.store.quote, null);
    assert.deepEqual(operates(f), []);
  });
}

for (const reject of [
  () => ({ data: { ok: false, error: '账本未确认取消' } }),
  () => { throw new Error('账本暂不可达'); },
]) {
  test('a failed cancellation is visible without reopening the quote or retrying', async () => {
    const f = await budgetFixture(); f.cancel(reject);
    const cancel = button(f.root, '取消');
    h.click(cancel); h.click(cancel); await h.flush();
    assert.match(h.textOf(f.root), /牧场取消未确认：账本/);
    assert.equal(f.store.quote, null);
    assert.equal(cancellations(f).length, 1);
    assert.deepEqual(operates(f), []);
  });
}

test('refresh and account changes cancel known quotes on their original accounts and isolate late receipts', async () => {
  const f = await budgetFixture();
  const refreshing = h.deferred(); const switching = h.deferred();
  f.cancel(() => refreshing.promise);
  await f.store.refresh();
  assert.equal(f.store.quote, null);
  f.prepare(async () => quoteReply('second', 60000));
  await f.store.prepare('buy', economicIntent);
  f.cancel(() => switching.promise);
  f.mount('account-b'); await h.flush();
  f.prepare(async () => quoteReply('new-account', 60000));
  await f.store.prepare('buy', economicIntent);
  assert.deepEqual(cancellations(f).map(post => post.body.quoteId), ['original', 'second']);
  for (const post of cancellations(f)) {
    const interceptorHeaders = { 'x-account-id': 'account-b' };
    post.config.transformRequest[0](post.body, interceptorHeaders);
    assert.equal(interceptorHeaders['x-account-id'], 'account-a');
    assert.ok(!post.config.signal?.aborted);
  }
  refreshing.resolve({ data: { ok: false, error: '旧刷新取消失败' } });
  switching.resolve(cancelReply);
  await h.flush();
  assert.equal(f.store.accountId, 'account-b');
  assert.equal(f.store.quote.id, 'new-account');
  assert.equal(f.store.error, '');
});

test('unmount abandons its known quote once and old prepare finally cannot unset a reentered prepare', async () => {
  const f = await budgetFixture();
  const old = h.deferred(); const next = h.deferred();
  await f.store.refresh();
  f.prepare(() => old.promise);
  const abandoned = f.store.prepare('buy', economicIntent);
  h.render(null, f.root); f.mount('account-a'); await h.flush();
  f.prepare(() => next.promise);
  const current = f.store.prepare('buy', economicIntent);
  old.resolve(quoteReply('discarded', 60000));
  assert.equal(await abandoned, false);
  assert.equal(f.store.preparing, true);
  assert.equal(f.store.quote, null);
  next.resolve(quoteReply('reentered', 60000));
  assert.equal(await current, true);
  h.render(null, f.root); await h.flush();
  assert.equal(f.store.quote, null);
  assert.deepEqual(cancellations(f).map(post => post.body.quoteId), ['original', 'reentered']);
});

test('an execute in flight sends no cancellation and a prior cancellation cannot alter an unknown result', async () => {
  const f = await budgetFixture();
  const previous = h.deferred(); const sent = h.deferred();
  f.cancel(() => previous.promise);
  h.click(button(f.root, '取消'));
  f.prepare(async () => quoteReply('next', 60000));
  await f.store.prepare('buy', economicIntent);
  f.operate(() => sent.promise);
  const operation = f.store.execute();
  await f.store.closeQuote();
  assert.deepEqual(cancellations(f).map(post => post.body.quoteId), ['original']);
  sent.resolve({ data: { ok: false, error: '执行状态未知' } });
  await operation;
  previous.resolve({ data: { ok: false, error: '旧取消失败' } });
  await h.flush();
  assert.equal(f.store.error, '执行状态未知');
  assert.equal(f.store.result.outcome, 'unknown');
  assert.equal(f.store.result.id, 'next');
  assert.deepEqual(operates(f), ['next']);
});

test('renewal releases the superseded live quote and closing releases the replacement', async () => {
  const f = await budgetFixture();
  f.operate(async () => ({ data: { ok: false, code: 'RANCH_STATE_CHANGED', error: '费用已变化' } }));
  await f.store.execute(); await h.flush();
  f.prepare(async () => quoteReply('updated', 60000));
  h.click(button(f.root, '重新核对')); await h.flush();
  assert.equal(f.store.quote.id, 'updated');
  assert.deepEqual(cancellations(f).map(post => post.body.quoteId), ['original']);
  h.click(button(f.root, '取消')); await h.flush();
  assert.deepEqual(cancellations(f).map(post => post.body.quoteId), ['original', 'updated']);
  assert.deepEqual(operates(f), ['original']);
});

function actualApiFixture(t, respond) {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  // Load Axios in its actual Node environment before installing the consumer's window.
  delete globalThis.window;
  const axios = require(path.join(h.WEB, 'node_modules/axios'));
  const token = { value: 'fixture-session-a' }; const selectedAccount = { value: 'account-a' };
  const location = { pathname: '/activity', search: '', href: '' }; const warnings = [];
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { location } });
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: key => key === 'admin_token' ? token.value : null } });
  t.after(() => {
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else delete globalThis.window;
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous);
    else delete globalThis.localStorage;
  });
  const apiModule = h.evaluateModule(fs.readFileSync(path.join(h.WEB, 'src/api/index.ts'), 'utf8'), spec => {
    if (spec === 'axios') return axios;
    if (spec === '@vueuse/core') return { useStorage: key => key === 'admin_token' ? token : selectedAccount };
    if (spec === '@/stores/toast') return { useToastStore: () => ({ error() {}, warning: value => warnings.push(value) }) };
    if (spec === '@/utils/daily-feedback') return { currentFeedbackTrace: () => '', recordClientFailure() {} };
    if (spec === '@/utils/request-diagnostics') return { requestOperation: () => 'fixture-ranch' };
    if (spec === '@/utils/safe-redirect') return { resolveSafeRedirect: () => '/activity' };
    throw new Error(`unexpected API import ${spec}`);
  }, 'api/index.ts');
  const api = apiModule.default;
  api.defaults.adapter = async config => {
    const reply = await respond(config);
    const response = { status: 200, statusText: '', headers: {}, config, ...reply };
    if (config.validateStatus && !config.validateStatus(response.status))
      throw new axios.AxiosError('fixture rejected response', 'ERR_BAD_REQUEST', config, {}, response);
    return response;
  };
  const p = h.pinia.createPinia(); h.pinia.setActivePinia(p);
  const module = h.evaluateModule(fs.readFileSync(path.join(h.WEB, 'src/stores/ranch.ts'), 'utf8'), spec => spec === 'vue' ? h.vue
    : spec === 'pinia' ? h.pinia : spec === '@/api' ? { __esModule: true, default: api } : undefined);
  const store = module.useRanchStore(p); store.bind('account-a');
  t.after(() => store.cancel());
  return { store, api, token, selectedAccount, location, warnings };
}

test('actual Axios cancellation auth failures cannot clear or redirect a replacement login', async t => {
  const entered = h.deferred(); const late = h.deferred();
  let cancellationStarted = false;
  const f = actualApiFixture(t, async config => {
    if (config.url.endsWith('/cancel')) { cancellationStarted = true; entered.resolve(config); return late.promise; }
    if (config.url.endsWith('/prepare')) return quoteReply('original', 60000);
    return { data: { ok: true, data: state() } };
  });
  await f.store.refresh(); await f.store.prepare('buy', economicIntent);
  const closing = f.store.closeQuote();
  await h.flush();
  assert.equal(cancellationStarted, true, 'the current quote must actually dispatch cancellation before waiting for it');
  const config = await entered.promise;
  assert.equal(config.headers['x-account-id'], 'account-a');
  f.token.value = 'fixture-session-b'; f.selectedAccount.value = 'account-b';
  f.store.bind('account-b'); await f.store.refresh();
  late.resolve({ status: 401, data: { ok: false, error: 'fixture expired authorization' } });
  assert.equal(await closing, false);
  assert.equal(f.token.value, 'fixture-session-b');
  assert.equal(f.location.href, ''); assert.deepEqual(f.warnings, []);
  assert.equal(f.store.error, ''); assert.equal(f.store.accountId, 'account-b');
});

test('a session changed before Axios cancellation dispatch sends no old quote with the new login', async t => {
  let cancels = 0;
  const f = actualApiFixture(t, async config => {
    if (config.url.endsWith('/cancel')) { cancels++; return cancelReply; }
    if (config.url.endsWith('/prepare')) return quoteReply('original', 60000);
    return { data: { ok: true, data: state() } };
  });
  await f.store.refresh(); await f.store.prepare('buy', economicIntent);
  f.api.interceptors.request.use(config => { f.token.value = 'fixture-session-b'; return config; });
  assert.equal(await f.store.closeQuote(), false);
  assert.equal(cancels, 0); assert.equal(f.token.value, 'fixture-session-b');
  assert.equal(f.store.error, ''); assert.equal(f.location.href, '');
});

test('actual Axios late aborted execute cannot replace a newer same-account confirmed result', async t => {
  const entered = h.deferred(); const late = h.deferred(); let operation = null; let quotes = 0; let writes = 0;
  const f = actualApiFixture(t, async config => {
    if (config.url.endsWith('/prepare')) return quoteReply(++quotes === 1 ? 'first' : 'second', 60000);
    if (config.url.endsWith('/operate')) {
      const id = JSON.parse(config.data).quoteId; writes++;
      operation = { id, outcome: 'confirmed', completed: 1, snapshot: state() };
      if (id === 'first') { entered.resolve(); return late.promise; }
      return { data: { ok: true, data: operation } };
    }
    return { data: { ok: true, data: { ...state(), lastOperation: operation } } };
  });
  await f.store.refresh(); await f.store.prepare('produce', { all: true });
  const first = f.store.execute(); await entered.promise;
  f.store.bind('account-a'); await f.store.refresh();
  await f.store.prepare('produce', { all: true }); assert.equal(await f.store.execute(), true);
  late.resolve({ data: { ok: true, data: { id: 'first', outcome: 'confirmed', snapshot: state() } } });
  assert.equal(await first, false);
  f.store.bind('account-a'); await f.store.refresh();
  assert.equal(f.store.result.id, 'second'); assert.equal(f.store.result.outcome, 'confirmed');
  assert.equal(f.store.blocked, false); assert.equal(writes, 2);
});

test('noncooperative old execution success, failure and exception leave a newer observed result intact', async () => {
  for (const response of ['success', 'failure', 'throw']) {
    const f = await budgetFixture(); const late = h.deferred(); f.operate(() => late.promise);
    const old = f.store.execute(); f.mount('account-b'); await h.flush(); f.mount('account-a'); await h.flush();
    const newer = { id: 'newer-observed', outcome: 'confirmed', completed: 1 };
    f.read(async () => ({ data: { ok: true, data: { ...state(), lastOperation: { id: 'original', outcome: 'confirmed' } } } }));
    await f.store.refresh();
    f.read(async () => ({ data: { ok: true, data: { ...state(), lastOperation: newer } } })); await f.store.refresh();
    if (response === 'throw') late.reject(new Error('old execute exception'));
    else late.resolve({ data: response === 'success' ? { ok: true, data: { id: 'original', outcome: 'confirmed', snapshot: state() } } : { ok: false, error: 'old execute failure' } });
    assert.equal(await old, false);
    f.store.bind('account-a');
    assert.equal(f.store.result.id, newer.id, 'the retained result must already belong to the latest observation before refreshing');
    await f.store.refresh();
    assert.equal(f.store.result.id, newer.id); assert.equal(f.store.result.outcome, 'confirmed');
    assert.equal(f.store.error, ''); assert.equal(f.store.blocked, false);
  }
});

test('real service missing confirmation rejects before dispatch and does not strand reentry in an unacknowledgeable result', async () => {
  const { createRanchService } = require('../src/services/ranch-service');
  const file = fixturePath('missing-confirmation-ledger.json');
  const previous = { id: '00000000-0000-0000-0000-000000000002', outcome: 'confirmed', label: '前次完成', completed: 1 };
  const missing = '00000000-0000-0000-0000-000000000003';
  fs.writeFileSync(file, JSON.stringify({ version: 1, quotes: [], lastOperation: previous, lastObservedAt: 1 }), { mode: 0o600 });
  const original = fs.readFileSync(file);
  let calls = 0;
  const service = createRanchService({ file: () => file, network: {
    withRanchScene() { calls++; assert.fail('missing confirmation must not enter a game scene'); },
  } });
  const f = fixture(); await h.flush();
  f.read(async () => ({ data: { ok: true, data: { ...state(), lastOperation: JSON.parse(fs.readFileSync(file, 'utf8')).lastOperation } } }));
  await f.store.refresh();
  f.prepare(async () => quoteReply(missing, 60000));
  f.operate(async () => ({ data: await service.execute(missing) }));
  assert.equal(await f.store.prepare('produce', { all: true }), true);
  assert.equal(await f.store.execute(), false);
  assert.equal(f.store.errorCode, 'RANCH_CONFIRMATION_MISSING');
  assert.equal((await service.acknowledge(missing)).code, 'RANCH_INVALID_ARGUMENT');
  assert.equal(calls, 0); assert.deepEqual(fs.readFileSync(file), original);
  f.store.bind('account-a'); await f.store.refresh();
  assert.equal(f.store.result.id, previous.id); assert.equal(f.store.result.outcome, 'confirmed');
  assert.equal(f.store.blocked, false); assert.equal(f.store.uncertain, false);
  assert.equal(f.posts.filter(post => post.url.endsWith('/acknowledge')).length, 0);
});

test('all known preflight refusals settle only their pending marker while true unknown results stay blocked', async () => {
  for (const code of ['RANCH_CONFIRMATION_MISSING', 'RANCH_QUOTE_EXPIRED', 'RANCH_STATE_CHANGED', 'RANCH_SESSION_CHANGED']) {
    const f = await budgetFixture();
    f.operate(async () => ({ data: { ok: false, code, error: '已知预检拒绝' } }));
    assert.equal(await f.store.execute(), false);
    f.mount('account-b'); await h.flush(); f.mount('account-a'); await h.flush();
    assert.equal(f.store.result, null, code);
    assert.equal(f.store.blocked, false, code);
  }
  const f = await budgetFixture();
  f.operate(async () => { throw new Error('unknown sent operation'); });
  assert.equal(await f.store.execute(), false);
  f.mount('account-b'); await h.flush(); f.mount('account-a'); await h.flush();
  assert.equal(f.store.result.id, 'original'); assert.equal(f.store.result.outcome, 'unknown');
  assert.equal(f.store.blocked, true);
});

test('a late known refusal cannot restore an older observation over the current result', async () => {
  const f = await budgetFixture(); const late = h.deferred(); f.operate(() => late.promise);
  const request = f.store.execute(); f.store.bind('account-a');
  const latest = { id: 'latest', outcome: 'confirmed' };
  f.read(async () => ({ data: { ok: true, data: { ...state(), lastOperation: { id: 'original', outcome: 'confirmed' } } } }));
  await f.store.refresh();
  f.read(async () => ({ data: { ok: true, data: { ...state(), lastOperation: latest } } })); await f.store.refresh();
  late.resolve({ data: { ok: false, code: 'RANCH_CONFIRMATION_MISSING', error: '旧确认不存在' } });
  await request; f.store.bind('account-a');
  assert.equal(f.store.result.id, latest.id); await f.store.refresh();
  assert.equal(f.store.result.id, latest.id); assert.equal(f.store.blocked, false);
});


test('牧场批量出售和推荐补草从同页打开确认，确认前均不执行', async () => {
  const f = fixture(); await h.flush();
  f.read(async () => ({ data: { ok: true, data: {
    ...state(), grass: '30',
    facilities: [{ id: '22', name: '牧草机', capacity: 50, level: 1, feed: { count: 40 } }],
    inventory: [
      { id: '1060001', uid: '9007199254741001', name: '鸡蛋', count: '5', canSell: true, sellPrices: [{ name: '金券', count: '2' }] },
      { id: '1060002', uid: '9007199254741002', name: '鸭蛋', count: '7', canSell: false },
    ],
  } } }));
  await f.store.refresh();
  f.prepare(async () => ({ data: { ok: true, data: { id: 'sale-quote', label: '出售牧场产物', count: 1,
    costItems: [{ name: '鸡蛋', count: '5' }], expectedRewards: [{ name: '金券', count: '10' }], validForMs: 60000 } } }));
  h.click(button(f.root, '批量出售产物（1 批）')); await h.flush();
  assert.deepEqual(f.posts.at(-1).body, { action: 'sell', input: { all: true } });
  assert.match(h.textOf(f.root), /预计获得：金券 × 10/);
  assert.equal(f.posts.filter(post => post.url.endsWith('/operate')).length, 0);
  await f.store.closeQuote();
  h.click(button(f.root, '补草 10 份')); await h.flush();
  assert.deepEqual(f.posts.at(-1).body, { action: 'addGrass', input: { facilityId: '22', count: 10 } });
  assert.equal(f.posts.filter(post => post.url.endsWith('/operate')).length, 0);
});
