'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), path = require('node:path');
const h = require('./activity-availability.test');
const { vue, WEB, render, makeNode, textOf, buttonsOf, flush, compileSfcModule, storeHarness } = h;
const button = (root, label) => { const node = buttonsOf(root).find(row => textOf(row).trim() === label); assert.ok(node, label); return node; };
const click = node => node.props.onClick({ currentTarget: { focus() {} } });
function fixture(t) {
  const harness = storeHarness();
  const state = { fetchedAt: Date.now(), dogs: [{ id: 2, name: '合成守卫犬' }], currentDogName: '合成守卫犬', currentDogId: '2', pendingGiftCountDec: '0',
    foodInventoryKnown: true, foods: [{ id: 90004, name: '1天狗粮', countDec: '3', durationSeconds: 86400, quoteFingerprint: 'a'.repeat(64), canFeed: true }],
    protectionKnown: true, protectionSeconds: 3600, capacitySeconds: 2592000, feedingEnabled: true, feedingReason: '每次投喂1份' };
  const module = compileSfcModule(path.join(WEB, 'src/components/activity/GameUpdatePanel.vue'), name => {
    if (name === 'vue') return { ...vue, Transition: (_props, { slots }) => slots.default?.() };
    if (name === '@/stores/activity') return { useActivityStore: () => harness.store };
    return undefined;
  });
  harness.store.updateReads.dog.data = state;
  const root = makeNode('root'); render(vue.h(module, { accountId: 'acc-1' }), root);
  t.after(() => render(null, root));
  return { ...harness, state, root };
}
test('real dog panel and store require confirmation, pin the account and consume exactly one item', async t => {
  const f = fixture(t), writes = [];
  f.api.setPost(async (url, body, config) => {
    const headers = { 'x-account-id': 'interceptor-changed' };
    const encoded = config.transformRequest[0](body, headers);
    writes.push({ url, body: JSON.parse(encoded), account: headers['x-account-id'] });
    return { data: { ok: true, data: { confirmed: true, state: { ...f.state, protectionSeconds: 90000, foods: [{ ...f.state.foods[0], countDec: '2' }] } } } };
  });
  click(button(f.root, '查看更新与邮箱')); await flush();
  click(button(f.root, '喂 1 份')); await flush();
  assert.match(textOf(f.root), /将消耗 1 份1天狗粮/); assert.equal(writes.length, 0);
  click(button(f.root, '取消')); await flush(); assert.equal(writes.length, 0);
  click(button(f.root, '喂 1 份')); await flush();
  click(button(f.root, '确定')); await flush();
  assert.equal(writes.length, 1); assert.equal(writes[0].url, '/api/dog/feed'); assert.equal(writes[0].account, 'acc-1');
  assert.equal(writes[0].body.count, 1); assert.equal(writes[0].body.itemId, 90004);
  assert.equal(f.store.updateReads.dog.data.foods[0].countDec, '2');
});
test('account change before the actual Axios dispatch causes zero game writes; unknown results do not retry', async t => {
  const f = fixture(t); let writes = 0;
  f.api.setPost(async (_url, body, config) => {
    f.accountState.currentAccountId = 'acc-2';
    config.transformRequest[0](body, {}); writes++;
    throw new Error('must not reach transport');
  });
  await f.store.feedDog('acc-1', { itemId: 90004, count: 1, quoteFingerprint: 'a'.repeat(64), operationId: 'synthetic-operation' });
  assert.equal(writes, 0);
  f.store.cancelUpdateReads(); f.accountState.currentAccountId = 'acc-1';
  f.api.setPost(async () => { writes++; throw new Error('lost reply'); });
  await f.store.feedDog('acc-1', { itemId: 90004, count: 1, quoteFingerprint: 'a'.repeat(64), operationId: 'synthetic-operation2' });
  assert.equal(writes, 1); assert.match(f.store.updateReads.dog.error, /lost reply/);
  await flush(); assert.equal(writes, 1, 'there is no automatic POST retry');
});
