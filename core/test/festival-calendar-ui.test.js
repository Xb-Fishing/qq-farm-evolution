const { test, after } = require('node:test');
const assert = require('node:assert/strict'); const path = require('node:path');
const h = require('./activity-availability.test');
const { vue, WEB, compileSfcModule, render, makeNode, textOf, buttonsOf, click, flush, apiMock, findAll, deferred } = h;
const roots = []; after(() => roots.forEach(root => render(null, root)));
const state = { serverTime: 1, defaultEventId: 401, events: [{ id: 401, name: '重阳', open: true, startTime: 1, endTime: 9999999999, canClaim: true, canAnswer: true,
  question: '合成问题', options: ['手动选项甲', '手动选项乙'], wrongOptions: [], rewards: [{ id: 20165, name: '茱萸种子', count: '3' }], questionRewards: [] }], seasons: [] };
function mount(api) {
  const account = vue.ref('synthetic-festival-a');
  const Panel = compileSfcModule(path.join(WEB, 'src/components/activity/FestivalSignInPanel.vue'), spec => spec === 'vue' ? vue : spec === '@/api' ? { __esModule: true, default: api.instance } : undefined);
  const root = makeNode('root'); roots.push(root);
  render(vue.h({ setup: () => () => vue.h(Panel, { accountId: account.value }) }), root);
  return { root, account };
}
const button = (root, label) => buttonsOf(root).find(node => textOf(node).trim() === label);
test('actual festival panel query and claim require confirmation, issue one write and one reconciliation read', async () => {
  const api = apiMock(); api.setGet(async () => ({ data: { ok: true, calendar: state } })); api.setPost(async () => ({ data: { ok: true, message: '奖励已领取' } }));
  const { root } = mount(api); await flush(); assert.equal(api.calls.get.length, 0);
  click(button(root, '查询节日签到')); await flush(); assert.match(textOf(root), /茱萸种子/);
  click(button(root, '领取签到奖励')); await vue.nextTick(); assert.equal(api.calls.post.length, 0);
  click(button(root, '取消')); await vue.nextTick(); assert.equal(api.calls.post.length, 0);
  click(button(root, '领取签到奖励')); await vue.nextTick(); click(button(root, '确认节日操作')); await flush();
  assert.deepEqual(api.calls.post.map(row => row.body), [{ action: 'claim', input: { id: 401 } }]); assert.equal(api.calls.get.length, 2);
});
test('actual festival read errors and account changes clear old actions and ignore delayed responses', async () => {
  const api = apiMock(); const waiting = deferred(); api.setGet(() => waiting.promise);
  const { root, account } = mount(api); click(button(root, '查询节日签到')); await flush();
  account.value = 'synthetic-festival-b'; await vue.nextTick(); waiting.resolve({ data: { ok: true, calendar: state } }); await flush();
  assert.equal(button(root, '领取签到奖励'), undefined); assert.equal(api.calls.post.length, 0);
  api.setGet(async () => ({ data: { ok: false, error: '只读失败' } })); click(button(root, '查询节日签到')); await flush();
  assert.match(textOf(root), /只读失败/); assert.equal(findAll(root, node => node.props.role === 'dialog').length, 0);
});
