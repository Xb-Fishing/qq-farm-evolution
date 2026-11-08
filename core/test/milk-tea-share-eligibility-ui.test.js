'use strict';
// 快乐值档位（shareMilestones）严格资格 UI：复用 activity-availability 的真实 SFC/page/store 夹具，
// 网络完全替身；全部断言针对真实渲染树与真实 store 行为。
const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('./activity-availability.test');
const { WEB, vue, compileSfcModule, render, makeNode, buttonsOf, textOf, findAll, click, flush, mountActivityPage, apiMock, snapshot } = h;
const path = require('node:path');

const activeRoots = [];
test.after(() => { for (const root of activeRoots) render(null, root); });
function queries() { return Object.fromEntries(['shop', 'hireList', 'workshop', 'work', 'rank', 'sales'].map(k => [k, { data: null, loading: false, error: '' }])); }
function mountPanel(activity, query = queries()) {
  const Panel = compileSfcModule(path.join(WEB, 'src/components/activity/MilkTeaActivityPanel.vue'), spec => spec === 'vue' ? vue : undefined);
  const events = []; const root = makeNode('root'); activeRoots.push(root);
  render(vue.h(Panel, { activity, queries: query, onQuery: (...args) => events.push(['query', ...args]), onOperate: (...args) => events.push(['operate', ...args]) }), root);
  return { root, events };
}
const button = (root, label) => buttonsOf(root).find(b => textOf(b).trim() === label);
const dialogsOf = root => findAll(root, n => n.props.role === 'dialog');
const statusTexts = root => findAll(root, n => n.props.role === 'status').map(n => textOf(n)).join('\n');
const share = (currentScore, milestones, extra = {}) => ({ shareReward: { currentScore, milestones, ...extra }, ...{} });
const eligibleShare = () => share(140, [{ id: 5, threshold: 80, state: 2, rewards: [{ itemId: 1041, itemName: '奶茶券', itemCount: 1 }] }]);

test('未知分享状态（缺失/空对象/分数缺失/档位非数组）一律待确认：按钮禁用、直接点击零确认零写', async () => {
  const cases = [
    ['无 shareReward', snapshot()],
    ['空对象', snapshot(share(undefined, undefined))],
    ['分数缺失', snapshot(share(null, [{ id: 5, threshold: 80, state: 2 }]))],
    ['档位非数组', snapshot(share(140, 'x'))],
    ...[NaN, Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1].map(score => [String(score), snapshot(share(score, [{ id: 5, threshold: 0, state: 2 }]))]),
  ];
  for (const [label, activity] of cases) {
    const { root, events } = mountPanel(activity);
    const claim = button(root, '领取快乐值档位');
    assert.ok(claim, label);
    assert.equal(claim.props.disabled, true, `${label} 按钮必须禁用`);
    assert.match(statusTexts(root), /待确认/, `${label} 必须显示待确认原因`);
    click(claim); await vue.nextTick();
    assert.equal(dialogsOf(root).length, 0, `${label} 直接点击不得弹确认`);
    assert.equal(events.length, 0, `${label} 零写`);
    render(null, root);
  }
});

test('畸形档位（id/threshold/state 非法）显示待确认且不判可领；同批存在合法档位时保留入口', async () => {
  const malformed = [
    { id: 0, threshold: 80, state: 2 },
    { id: 1.5, threshold: 80, state: 2 },
    { id: 5, threshold: -1, state: 2 },
    { id: 5, threshold: null, state: 2 },
    { id: 5, threshold: 1.5, state: 2 },
    ...[NaN, Infinity, -1, 0, 99].map(state => ({ id: 5, threshold: 80, state })),
    { id: 5, threshold: 80, state: '2' },
    { id: 5, threshold: 80 },
    null,
  ];
  for (const tier of malformed) {
    const { root, events } = mountPanel(snapshot(share(140, [tier])));
    assert.match(textOf(root), /待确认/, `畸形档位 ${JSON.stringify(tier)} 行必须显示待确认`);
    assert.doesNotMatch(textOf(root), /· 可领取/, `畸形档位 ${JSON.stringify(tier)} 不得标可领`);
    const claim = button(root, '领取快乐值档位');
    assert.equal(claim.props.disabled, true, `畸形档位 ${JSON.stringify(tier)} 且无合法档位时禁用`);
    click(claim); await vue.nextTick();
    assert.equal(dialogsOf(root).length, 0); assert.equal(events.length, 0);
    render(null, root);
  }
  // 同批畸形 + 合法：有任一合法可领保留入口；畸形行仍单独待确认。
  const { root, events } = mountPanel(snapshot(share(140, [{ id: 9, threshold: 90, state: 2 }, { id: 0, threshold: 80, state: 2 }])));
  const claim = button(root, '领取快乐值档位');
  assert.equal(claim.props.disabled, false, '存在合法可领档位必须保留入口');
  assert.match(textOf(root), /待确认/, '畸形行仍显示待确认');
  click(claim); await vue.nextTick(); assert.equal(dialogsOf(root).length, 1);
  click(button(root, '确认执行')); await vue.nextTick();
  assert.deepEqual(events, [['operate', 'shareMilestones', {}]]);
  render(null, root);
});

test('同 tick 原地变化后即使仍有合法档位也不能提交旧确认，迟到的确认处理器零写', async () => {
  for (const mutate of [
    act => { act.shareReward.currentScore = 150; },
    act => { act.shareReward.milestones[0].id = 6; },
    act => { act.shareReward.milestones[0].threshold = 90; },
    act => { act.timing.phase = 'settle'; },
  ]) {
    const activity = vue.reactive(snapshot(eligibleShare()));
    const { root, events } = mountPanel(activity);
    click(button(root, '领取快乐值档位')); await vue.nextTick();
    const oldConfirm = button(root, '确认执行'); assert.ok(oldConfirm);
    mutate(activity);
    click(oldConfirm); // 不等 nextTick；真实迟到 handler 也必须复核。
    assert.equal(events.length, 0);
    await vue.nextTick(); assert.equal(dialogsOf(root).length, 0);
    assert.equal(button(root, '领取快乐值档位').props.disabled, false, '新资格仍可用，必须重新确认');
    render(null, root);
  }
});



test('已知空档位、全部已领、分数未达均显示无可领取；仅 state=2 分数不足不得标可领', async () => {
  const cases = [
    ['空档位', share(140, []), /没有可领取的快乐值档位/],
    ['全部已领', share(140, [{ id: 1, threshold: 60, state: 3 }, { id: 2, threshold: 120, state: 3 }]), /暂无可领取奖励/],
    ['分数未达', share(20, [{ id: 1, threshold: 60, state: 2 }, { id: 2, threshold: 120, state: 3 }]), /暂无可领取奖励/],
  ];
  for (const [label, shareData, reason] of cases) {
    const { root, events } = mountPanel(snapshot(shareData));
    const claim = button(root, '领取快乐值档位');
    assert.equal(claim.props.disabled, true, `${label} 按钮必须禁用`);
    assert.match(statusTexts(root), reason, `${label} 必须给出明确原因`);
    click(claim); await vue.nextTick();
    assert.equal(dialogsOf(root).length, 0, `${label} 直接点击零确认`);
    assert.equal(events.length, 0);
    render(null, root);
  }
  // 反证核心：state=2 但分数不足的行不得标“可领取”。
  const { root } = mountPanel(snapshot(share(20, [{ id: 1, threshold: 60, state: 2 }])));
  assert.match(textOf(root), /快乐值档位 60 · 暂不可领取/, 'state=2 分数不足必须显示暂不可领取');
  assert.doesNotMatch(textOf(root), /· 可领取/, 'state=2 分数不足不得标可领取');
  render(null, root);
});

test('合法可领先一次确认再一次 shareMilestones 空参事件；取消零写；结算期合法领取保留', async () => {
  for (const phase of ['open', 'settle']) {
    const { root, events } = mountPanel(snapshot({ ...eligibleShare(), timing: { endTime: 0, phase } }));
    const claim = button(root, '领取快乐值档位');
    assert.equal(claim.props.disabled, false, `${phase} 期合法档位必须可点`);
    assert.match(textOf(root), /快乐值档位 80 · 可领取/);
    click(claim); await vue.nextTick();
    assert.equal(dialogsOf(root).length, 1);
    click(button(root, '取消')); await vue.nextTick();
    assert.equal(events.length, 0); assert.equal(dialogsOf(root).length, 0);
    click(claim); await vue.nextTick();
    click(button(root, '确认执行')); await vue.nextTick();
    assert.deepEqual(events, [['operate', 'shareMilestones', {}]], `${phase} 一次确认恰一次空参事件`);
    click(claim); await vue.nextTick(); // 自动领奖不代劳，手动可再次走原确认
    click(button(root, '确认执行')); await vue.nextTick();
    assert.equal(events.length, 2, '手动再次确认可再次发出');
    render(null, root);
  }
});

test('活动未开始/已结束不准领取快乐值档位并给出原因', async () => {
  for (const [phase, pattern] of [['beforeStart', /尚未开始/], ['ended', /已结束/]]) {
    const { root, events } = mountPanel(snapshot({ ...eligibleShare(), timing: { endTime: 0, phase } }));
    const claim = button(root, '领取快乐值档位');
    assert.equal(claim.props.disabled, true, `${phase} 必须禁用`);
    assert.match(statusTexts(root), pattern);
    click(claim); await vue.nextTick();
    assert.equal(dialogsOf(root).length, 0); assert.equal(events.length, 0);
    render(null, root);
  }
});

test('读取/操作期间禁用；确认期间分数、档位、阶段、加载或操作状态变化撤销旧确认', async () => {
  const Panel = compileSfcModule(path.join(WEB, 'src/components/activity/MilkTeaActivityPanel.vue'), spec => spec === 'vue' ? vue : undefined);
  // loading / operating 禁用
  for (const extra of [{ loading: true }, { operating: 'shareMilestones' }]) {
    const root = makeNode('root'); activeRoots.push(root);
    render(vue.h(Panel, { activity: snapshot(eligibleShare()), queries: queries(), ...extra }), root);
    assert.equal(button(root, '领取快乐值档位').props.disabled, true, JSON.stringify(extra));
    click(button(root, '领取快乐值档位')); assert.equal(dialogsOf(root).length, 0, 'busy handler must not open confirmation');
    render(null, root);
  }
  // 确认期间深层资格变化（分数跌到阈值下）同 tick 撤销：确认按钮就地失效零写。
  {
    const activity = vue.reactive(snapshot(eligibleShare()));
    const { root, events } = mountPanel(activity);
    click(button(root, '领取快乐值档位')); await vue.nextTick();
    assert.equal(dialogsOf(root).length, 1);
    activity.shareReward.currentScore = 10; // 同 tick 资格失效
    click(button(root, '确认执行')); await vue.nextTick();
    assert.equal(events.length, 0, '资格失效后确认必须零写');
    assert.equal(dialogsOf(root).length, 0, '确认就地撤销');
    assert.match(statusTexts(root), /状态已更新|暂无可领取/);
    render(null, root);
  }
  // 确认期间各触发源逐一撤销：分数深层变化 / 档位状态变化 / 阶段变化 / 快照身份更换 / loading / operating。
  const deepMutations = [
    ['分数深层变化', act => { act.shareReward.currentScore = 200; }],
    ['档位状态变化', act => { act.shareReward.milestones[0].state = 3; }],
    ['阶段变化', act => { act.timing.phase = 'settle'; }],
  ];
  for (const [label, mutate] of deepMutations) {
    const activity = vue.reactive(snapshot(eligibleShare()));
    const { root, events } = mountPanel(activity);
    click(button(root, '领取快乐值档位')); await vue.nextTick();
    assert.equal(dialogsOf(root).length, 1, label);
    mutate(activity); await vue.nextTick();
    assert.equal(dialogsOf(root).length, 0, `${label} 必须撤销旧确认`);
    assert.equal(events.length, 0);
    render(null, root);
  }
  // 同根重渲染更换 props：快照身份更换 / loading / operating 任一变化撤销旧确认。
  const propMutations = [
    ['快照身份更换', () => ({ activity: snapshot(eligibleShare()) })],
    ['读取 loading', activity => ({ activity, loading: true })],
    ['操作 operating', activity => ({ activity, operating: 'shareMilestones' })],
  ];
  for (const [label, nextProps] of propMutations) {
    const root = makeNode('root'); activeRoots.push(root);
    const events = [];
    const mount = props => render(vue.h(Panel, { queries: queries(), onOperate: (...args) => events.push(args), ...props }), root);
    const activity = snapshot(eligibleShare());
    mount({ activity });
    click(button(root, '领取快乐值档位')); await vue.nextTick();
    assert.equal(dialogsOf(root).length, 1, label);
    mount(nextProps(activity)); await vue.nextTick();
    assert.equal(dialogsOf(root).length, 0, `${label} 必须撤销旧确认`);
    assert.equal(events.length, 0);
    render(null, root);
  }
});

test('真实页面：业务拒绝和传输未知结果均不自动重试；手动刷新可重新确认', async () => {
  for (const failure of ['business', 'unknown']) {
    const api = apiMock();
    api.setGet(async () => ({ data: { ok: true, activity: snapshot(eligibleShare()) } }));
    let succeed = false;
    api.setPost(async () => {
      if (!succeed && failure === 'unknown') throw new Error('synthetic transport timeout');
      return { data: succeed ? { ok: true, message: '领取成功' } : { ok: false, error: '合成业务拒绝' } };
    });
    const page = mountActivityPage(api); activeRoots.push(page.root); await flush();
    click(button(page.root, '领取快乐值档位')); await vue.nextTick();
    click(button(page.root, '确认执行')); await flush(); await flush();
    assert.equal(api.calls.post.length, 1, `${failure} 不得自动重试`);
    assert.equal(api.calls.post[0].body.action, 'shareMilestones');
    assert.deepEqual(api.calls.post[0].body.input, {});
    await flush(); await flush(); assert.equal(api.calls.post.length, 1, '后续 tick 也不重试');
    click(button(page.root, '刷新')); await flush(); await flush();
    click(button(page.root, '领取快乐值档位')); await vue.nextTick();
    assert.equal(dialogsOf(page.root).length, 1, '手动刷新后凭新资格重新确认');
    succeed = true;
    click(button(page.root, '确认执行')); await flush(); await flush();
    assert.equal(api.calls.post.length, 2, '明确手动确认只发一次');
    render(null, page.root);
  }
});

test('真实页面：确认期间切账号撤销并清理；卸载重进不残留旧确认', async () => {
  const api = apiMock();
  api.setGet(async () => ({ data: { ok: true, activity: snapshot(eligibleShare()) } }));
  api.setPost(async () => ({ data: { ok: true, message: '领取成功' } }));
  const page = mountActivityPage(api); activeRoots.push(page.root); await flush();
  click(button(page.root, '领取快乐值档位')); await vue.nextTick();
  assert.equal(dialogsOf(page.root).length, 1);
  page.accountRef.value = 'acc-2'; await flush(); await flush();
  assert.equal(dialogsOf(page.root).length, 0, '切账号必须撤销旧确认');
  assert.equal(api.calls.post.length, 0, '切账号零写');
  render(null, page.root);
  // 卸载重进：新页面零确认零写，凭新读取重新走原确认。
  const api2 = apiMock();
  api2.setGet(async () => ({ data: { ok: true, activity: snapshot(eligibleShare()) } }));
  api2.setPost(async () => ({ data: { ok: true, message: '领取成功' } }));
  const second = mountActivityPage(api2); activeRoots.push(second.root); await flush();
  assert.equal(dialogsOf(second.root).length, 0, '重进不残留旧确认');
  assert.equal(api2.calls.post.length, 0);
  click(button(second.root, '领取快乐值档位')); await vue.nextTick();
  click(button(second.root, '确认执行')); await flush(); await flush();
  assert.equal(api2.calls.post.length, 1);
  assert.equal(api2.calls.post[0].body.action, 'shareMilestones');
  render(null, second.root);
});
