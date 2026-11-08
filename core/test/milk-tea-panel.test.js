'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('./activity-availability.test');
const { WEB, vue, compileSfcModule, render, makeNode, buttonsOf, textOf, findAll, click, flush, mountActivityPage, apiMock, deferred, snapshot } = h;
const path = require('node:path');
const activeRoots = [];
test.after(() => { for (const root of activeRoots) render(null, root); });
function queries() { return Object.fromEntries(['shop','hireList','workshop','work','rank','sales'].map(k => [k, { data: null, loading: false, error: '' }])); }
function mountPanel(activity, query = queries()) {
  const Panel = compileSfcModule(path.join(WEB, 'src/components/activity/MilkTeaActivityPanel.vue'), spec => spec === 'vue' ? vue : undefined);
  const events = []; const root = makeNode('root'); activeRoots.push(root);
  render(vue.h(Panel, { activity, queries: query, onQuery: (...args) => events.push(['query', ...args]), onOperate: (...args) => events.push(['operate', ...args]) }), root);
  return { root, events };
}
const button = (root, label) => buttonsOf(root).find(b => textOf(b).trim() === label);
function setModel(root, label, value) { const node = findAll(root, n => n.props['aria-label'] === label)[0]; assert.ok(node, label); node.props['onUpdate:modelValue'](value); }

test('candidate refresh, errors, duration and selection changes revoke hire confirmation before a write', async () => {
  for (const mutate of [q => { q.hireList.loading = true; }, q => { q.hireList.error = 'read failed'; }, q => { q.hireList.data = { durationId: 1, robots: [] }; }]) {
    const q = vue.reactive(queries()); q.shop.data = { slotAvailabilityKnown: true, employeeSlotCount: 1, freeSlotIndexes: [0] };
    q.hireList.data = { durationId: 1, robots: [{ gid: '9101', name: '合成员工' }] };
    const { root, events } = mountPanel(snapshot(), q); setModel(root, '雇佣候选', '9101'); await vue.nextTick();
    click(button(root, '雇佣所选员工')); await vue.nextTick(); assert.equal(findAll(root, n => n.props.role === 'dialog').length, 1);
    mutate(q); await vue.nextTick(); assert.equal(findAll(root, n => n.props.role === 'dialog').length, 0);
    assert.equal(button(root, '雇佣所选员工').props.disabled, true); assert.equal(events.length, 0);
  }
});

test('真实面板渲染全部说明玩法；null/缺省数值均不崩溃、不伪造0', () => {
  for (const value of [null, snapshot(), snapshot({ inventory: { available: false }, growthFund: {}, shareReward: {} })]) {
    const { root } = mountPanel(value);
    for (const section of ['开店、改名与升级','收银台与宣传喇叭','雇佣、特长与班次','工坊、配方与果实加工','我的工作、工资与互动','好友排行与销量日志','活动商城与专属种子','成长基金与快乐值','活动规则与结算']) assert.ok(textOf(root).includes(section));
    assert.match(textOf(root), /待确认/); render(null, root);
  }
});

test('实际页面六个查询按钮到store；挂载/普通刷新无这些请求、无翻页轮询', async () => {
  const api = apiMock(); api.setGet(async () => ({ data: { ok: true, activity: snapshot() } }));
  api.setPost(async (_url, body) => ({ data: { ok: true, kind: body.kind, data: {} } }));
  const page = mountActivityPage(api); activeRoots.push(page.root); await flush(); assert.equal(api.calls.post.length, 0);
  for (const label of ['查询店铺与收银台','查询雇佣候选','查询工坊与果实','查询我的工作','查询指定页排行','查询销量日志']) { click(button(page.root, label)); await flush(); }
  assert.deepEqual(api.calls.post.map(c => c.body.kind), ['shop','hireList','workshop','work','rank','sales']);
  assert.deepEqual(api.calls.post.map(c => c.body.params), [{},{durationId:1},{},{},{page:1},{}]);
  click(button(page.root, '刷新')); await flush(); await flush(); assert.equal(api.calls.post.length, 6); render(null, page.root);
});

test('十四种面板操作均先确认后发出；成员/槽位/配方/班次/费用取当前选择', async () => {
  const q = queries(); q.shop.data = { slots: [], employeeSlotCount: 1, slotAvailabilityKnown: true, freeSlotIndexes: [0] }; q.hireList.data = { durationId: 1, robots: [{ gid:'101',name:'员工',talentName:'服务' }] };
  q.workshop.data = { recipes:[{recipeId:2,fruitItemId:40525,name:'甜莓奶茶',unlocked:true}], fruits:[{uid:'23563',itemId:40525,name:'森野甜莓',count:7}] };
  // 明确有效班次：互动次数/上限/结束时间齐全，避免把缺失字段误判为可互动。
  q.work.data = { interactDone:false, myShift: { shiftId:'3001',interactCount:0,interactLimit:3,endAt:4102444800,interactPreviews:[{interactionType:1}] } };
  const { root, events } = mountPanel(snapshot({ summary:{canUpgrade:true}, inventory:{available:true,boostItemCount:2}, growthFund:{unlocked:true}, shareReward:{ currentScore: 140, milestones: [{ id: 5, threshold: 80, state: 2, rewards: [{ itemId: 1041, itemName: '奶茶券', itemCount: 1 }] }] }, exchangeShop:{items:[{id:9,name:'种子',costs:[{id:1041,count:'10',name:'奶茶券'}],exchangeBounds:{requestMax:999,limitKnown:true,hasPurchaseLimit:true,remainingLimit:5,affordableCount:20,maxCount:5,blockReason:'',unitCosts:[{itemId:1041,count:'10',name:'奶茶券'}]}}]} }), q);
  setModel(root,'店名','奶茶冲鸭'); setModel(root,'雇佣候选','101'); setModel(root,'选择森野甜莓，7个',['23563']); await vue.nextTick();
  for (const label of ['开店','改名','升级','领取收银台','使用宣传喇叭','雇佣所选员工','暂停被雇佣','制作所选果实','领取工资','执行班次互动','确认兑换 种子 × 1','领取成长基金','领取每日快乐值','领取快乐值档位']) {
    const count = events.length; click(button(root,label)); await vue.nextTick(); assert.equal(events.length,count, '写前确认');
    assert.ok(findAll(root,n=>n.props.role==='dialog').length); click(button(root,'确认执行')); await vue.nextTick(); assert.equal(events.length,count+1);
  }
  assert.deepEqual(events.map(e=>e[1]), ['createShop','renameShop','upgrade','claimCashier','boost','hire','hireSetting','craft','claimWages','interact','exchange','fundClaim','shareDaily','shareMilestones']);
  assert.deepEqual(events.find(e=>e[1]==='hire')[2].confirmedCosts,[{itemId:1041,count:'40'}]);
  assert.deepEqual(events.find(e=>e[1]==='craft')[2].fruitUids,['23563']);
  assert.equal(events.find(e=>e[1]==='interact')[2].shiftId,'3001'); render(null,root);
});

test('雇佣面板使用已确认容量空位；稀疏列表可选择空槽，确认前零请求', async () => {
  for (const freeSlotIndexes of [[0], [1]]) {
    const q = queries();
    q.shop.data = { level: 3, slots: [], employeeSlotCount: 2, slotAvailabilityKnown: true, freeSlotIndexes };
    q.hireList.data = { durationId: 1, robots: [{ gid: '9101', name: '合成员工' }] };
    const { root, events } = mountPanel(snapshot(), q);
    setModel(root, '雇佣候选', '9101'); await vue.nextTick();
    assert.doesNotMatch(textOf(root), /当前没有可雇佣空位/);
    assert.match(textOf(root), /已开放 2 个槽位，当前可雇佣 1 位员工/);
    const select = findAll(root, n => n.props['aria-label'] === '雇佣槽位')[0];
    assert.deepEqual(findAll(select, n => n.tag === 'option').map(n => n.props.value), freeSlotIndexes);
    const hire = button(root, '雇佣所选员工'); assert.equal(hire.props.disabled, false);
    click(hire); await vue.nextTick(); assert.equal(events.length, 0);
    assert.match(textOf(findAll(root, n => n.props.role === 'dialog')[0]), /40/);
    click(button(root, '确认执行')); await vue.nextTick();
    assert.deepEqual(events, [['operate', 'hire', { durationId: 1, hires: [{ slotIndex: freeSlotIndexes[0], targetGid: '9101' }], confirmedCosts: [{ itemId: 1041, count: '40' }] }]]);
  }
});

test('雇佣面板区分满员、未确认、读取失败和加载，刷新空位只发原有只读查询', async () => {
  const cases = [
    { data: { employeeSlotCount: 1, slotAvailabilityKnown: true, freeSlotIndexes: [] }, message: /当前没有可雇佣空位/ },
    { data: { slots: [] }, message: /雇佣空位尚未确认/ },
    { data: { employeeSlotCount: null, slotAvailabilityKnown: false, freeSlotIndexes: [] }, message: /雇佣空位尚未确认/ },
    { data: { employeeSlotCount: 1, slotAvailabilityKnown: true, freeSlotIndexes: [0] }, error: 'shop read failed', message: /雇佣空位读取失败/ },
    { data: { employeeSlotCount: 1, slotAvailabilityKnown: true, freeSlotIndexes: [0] }, loading: true, message: /正在读取雇佣空位/ },
  ];
  for (const row of cases) {
    const q = queries(); q.shop = { data: row.data, error: row.error || '', loading: row.loading || false };
    q.hireList.data = { durationId: 1, robots: [{ gid: '9101' }] };
    const { root, events } = mountPanel(snapshot(), q);
    setModel(root, '雇佣候选', '9101'); await vue.nextTick();
    assert.match(textOf(root), row.message);
    if (row.error || !row.data.slotAvailabilityKnown) assert.doesNotMatch(textOf(root), /当前没有可雇佣空位/);
    assert.equal(button(root, '雇佣所选员工').props.disabled, true);
    assert.equal(events.length, 0);
    if (!row.loading) {
      const refresh = button(root, '刷新雇佣空位');
      assert.ok(refresh, 'the hire section must offer the existing readonly shop query');
      click(refresh); await vue.nextTick();
      assert.deepEqual(events, [['query', 'shop', {}]]);
    }
  }
});

test('雇佣确认期间空位被占用或读取失败会撤销确认，不提交过时槽位', async () => {
  const q = vue.reactive(queries());
  q.shop.data = { employeeSlotCount: 1, slotAvailabilityKnown: true, freeSlotIndexes: [0] };
  q.hireList.data = { durationId: 1, robots: [{ gid: '9101' }] };
  const { root, events } = mountPanel(snapshot(), q);
  setModel(root, '雇佣候选', '9101'); await vue.nextTick();
  click(button(root, '雇佣所选员工')); await vue.nextTick();
  assert.equal(findAll(root, n => n.props.role === 'dialog').length, 1);
  q.shop.data = { employeeSlotCount: 1, slotAvailabilityKnown: true, freeSlotIndexes: [] }; await vue.nextTick();
  assert.equal(findAll(root, n => n.props.role === 'dialog').length, 0); assert.equal(events.length, 0);
  q.shop.data = { employeeSlotCount: 1, slotAvailabilityKnown: true, freeSlotIndexes: [0] }; await vue.nextTick();
  click(button(root, '雇佣所选员工')); await vue.nextTick();
  q.shop.error = 'fresh state unavailable'; await vue.nextTick();
  assert.equal(findAll(root, n => n.props.role === 'dialog').length, 0); assert.equal(events.length, 0);
});

test('实际页面确认到store；切号往返/卸载后迟到写成功、普通失败和异常无提示无刷新', async () => {
  for (const mode of ['success','ordinary','exception']) {
    const api = apiMock(); api.setGet(async()=>({data:{ok:true,activity:snapshot()}}));
    const page = mountActivityPage(api); activeRoots.push(page.root); await flush(); const gate=h.deferred(); api.setPost(()=>gate.promise);
    click(button(page.root,'领取每日快乐值')); await vue.nextTick(); click(button(page.root,'确认执行')); await flush(); assert.equal(api.calls.post[0].body.action,'shareDaily');
    page.accountRef.value='acc-2'; await flush(); page.accountRef.value='acc-1'; await flush(); const reads=api.calls.get.length;
    if(mode==='exception') gate.reject(new Error('late')); else gate.resolve({data:{ok:mode==='success'}});
    await flush(); assert.equal(page.toastLog.length,0); assert.equal(api.calls.get.length,reads); render(null,page.root);
  }
});

test('管理面板真实渲染奶茶说明的已适配与占地/图标/自动样本待证边界', async () => {
  let loads = 0;
  const useEvolutionStore = h.pinia.defineStore('evolution-panel', () => ({ evolve: vue.ref(null), startPolling() {}, stopPolling() {}, loadStatus: async () => { loads += 1; return { ok: true, report: { scannedAt: 1, status: 'up-to-date', warnings: [], unknownActivityIds: [], detectedActivityIds: [], candidateCount: 0, caches: [], incompleteCandidates: [], online: { available: true, activities: [], unknownActivityIds: [], groups: [{ id: 2026110100, title: '奶茶热销中', payload: { tips: { txt: ['开店营业，升级小店，收银台','种植加工，奶茶工坊','雇佣好友，每班互动','宣传加速，宣传喇叭，排行榜，销量日志','成长基金，累计快乐值，人气装饰','48小时结算期，停止自动营业，未领收益通过邮件补发'] } } }] } } }; } }));
  h.pinia.setActivePinia(h.pinia.createPinia());
  const Panel = compileSfcModule(path.join(WEB,'src/components/admin/AdminActivityUpdatePanel.vue'), spec => {
    if(spec==='vue')return vue; if(spec==='vue-router')return require(path.join(WEB,'node_modules/vue-router')); if(spec==='pinia')return h.pinia;
    if(spec==='@/stores/evolution')return {useEvolutionStore};
    if(spec==='@/stores/toast')return {useToastStore:()=>({success(){},error(){}})};
    if(spec==='@/api')return {__esModule:true,default:{}};
  });
  const root=makeNode('root');activeRoots.push(root);render(vue.h(Panel),root);await flush(); await vue.nextTick(); assert.equal(loads, 1, '真实mounted读取状态');
  assert.match(textOf(root),/奶茶工坊与果实加工/);assert.match(textOf(root),/七种普通森野作物单格、黄金芽四格和种子、果实专属图已核验/);assert.match(textOf(root),/真正未登记的作物仍保留未知占地/);assert.match(textOf(root),/自然成功样本/);render(null,root);
});


test('批量制作多选、配方全选与一键全部在确认前零写，确认后一次提交完整整组数量', async () => {
  const q = queries();
  q.workshop.data = {
    recipes: [{ recipeId: 2, fruitItemId: 40525, unlocked: true }, { recipeId: 3, fruitItemId: 40526, unlocked: true }, { recipeId: 4, fruitItemId: 40527, unlocked: false }],
    fruits: [
      { uid: '8001', itemId: 40525, name: '甜莓', count: '7' },
      { uid: '8002', itemId: 40525, name: '黄金甜莓', count: '9' },
      { uid: '8003', itemId: 40526, name: '白桃', count: '11' },
      { uid: '8004', itemId: 40525, name: '锁定甜莓', count: '1', locked: true },
      { uid: '8005', itemId: 40527, name: '未解锁甜橙', count: '1' },
    ],
  };
  const { root, events } = mountPanel(snapshot(), q);
  assert.equal(findAll(root, n => n.tag === 'input' && n.props.type === 'checkbox').length, 3);
  setModel(root, '配方', 2); await vue.nextTick();
  click(button(root, '全选当前配方')); await vue.nextTick();
  assert.match(textOf(root), /已选 2 组，共 16 个果实/);
  assert.equal(events.length, 0);
  click(button(root, '制作所选果实')); await vue.nextTick();
  const dialog = findAll(root, n => n.props.role === 'dialog')[0];
  assert.match(textOf(dialog), /2 组、共 16 个果实/);
  assert.match(textOf(dialog), /甜莓 × 7；黄金甜莓 × 9/);
  assert.equal(events.length, 0);
  click(button(root, '取消')); await vue.nextTick();
  assert.equal(events.length, 0);
  click(button(root, '一键制作全部')); await vue.nextTick();
  assert.match(textOf(findAll(root, n => n.props.role === 'dialog')[0]), /3 组、共 27 个果实/);
  click(button(root, '确认执行')); await vue.nextTick();
  assert.equal(events.length, 1);
  assert.equal(events[0][1], 'craft');
  assert.deepEqual(events[0][2], { fruitUids: ['8001', '8002', '8003'], confirmedFruits: [
    { uid: '8001', itemId: 40525, count: '7' }, { uid: '8002', itemId: 40525, count: '9' }, { uid: '8003', itemId: 40526, count: '11' },
  ] });
});

test('批量制作确认期间材料更新会撤销旧确认与选择，不提交过时消耗', async () => {
  const q = queries();
  q.workshop.data = { recipes: [{ recipeId: 2, fruitItemId: 40525, unlocked: true }], fruits: [{ uid: '8001', itemId: 40525, name: '甜莓', count: '7' }] };
  const state = vue.reactive(q);
  const { root, events } = mountPanel(snapshot(), state);
  click(button(root, '一键制作全部')); await vue.nextTick();
  assert.ok(findAll(root, n => n.props.role === 'dialog').length);
  state.workshop.data.fruits[0].count = '8'; await vue.nextTick();
  assert.equal(findAll(root, n => n.props.role === 'dialog').length, 0);
  assert.match(textOf(root), /请重新选择并确认/);
  assert.equal(button(root, '制作所选果实').props.disabled, true);
  assert.equal(events.length, 0);
});

// ===== 2026-10-21 互动可用性守卫与已确认奖励展示 =====
function validWork() {
  return { interactDone: false, myShift: { shiftId: '3001', interactCount: 0, interactLimit: 3, endAt: 4102444800, interactPreviews: [{ interactionType: 1 }] } };
}
function workQueries(work, extra = {}) {
  const q = queries();
  q.work = { data: work, loading: !!extra.loading, error: extra.error || '' };
  return q;
}
const dialogCount = root => findAll(root, n => n.props.role === 'dialog').length;

test('互动选择与按钮按明确班次次数启用；耗尽/已完成/零上限/未知/无班次/加载/失败/结算均禁用并给出具体原因', async () => {
  const exhausted = validWork(); exhausted.myShift.interactCount = 3;
  const done = validWork(); done.interactDone = true;
  const zeroLimit = validWork(); zeroLimit.myShift.interactLimit = 0;
  const unknownCount = validWork(); unknownCount.myShift.interactCount = null;
  const unknownLimit = validWork(); unknownLimit.myShift.interactLimit = undefined;
  const noShiftId = validWork(); noShiftId.myShift.shiftId = '';
  const ended = validWork(); ended.myShift.endAt = 1;
  const badOptions = [null, {}, 'invalid', [null, { interactionType: true }, { interactionType: '1' }]].map(value => {
    const work = validWork(); work.myShift.interactPreviews = value; return workQueries(work);
  });
  const cases = [
    { label: '耗尽', q: workQueries(exhausted), message: /互动次数已用完/ },
    { label: 'interactDone', q: workQueries(done), message: /互动已完成/ },
    { label: '零上限', q: workQueries(zeroLimit), message: /互动次数为零/ },
    { label: '未知次数', q: workQueries(unknownCount), message: /互动次数待确认/ },
    { label: '未知上限', q: workQueries(unknownLimit), message: /互动次数上限待确认/ },
    { label: '未知班次标识', q: workQueries(noShiftId), message: /班次信息待确认/ },
    { label: '已结束班次', q: workQueries(ended), message: /班次已经结束/ },
    ...badOptions.map((q, index) => ({ label: `畸形选项${index}`, q, message: /互动选项待确认/ })),
    { label: '无班次', q: workQueries({ interactDone: false, myShift: null }), message: /没有进行中的班次/ },
    { label: '无数据', q: workQueries(null), message: /工作状态待确认/ },
    { label: '加载', q: workQueries(validWork(), { loading: true }), message: /工作状态读取中/ },
    { label: '读取失败', q: workQueries(validWork(), { error: '合成工作读取失败' }), message: /工作状态读取失败/ },
    { label: '结算', q: workQueries(validWork()), activity: { timing: { phase: 'settle', endTime: 0 } }, message: /结算期/ },
  ];
  for (const row of cases) {
    const { root, events } = mountPanel(snapshot(row.activity || {}), row.q);
    assert.equal(button(root, '执行班次互动').props.disabled, true, `${row.label} 必须禁用互动`);
    assert.equal(findAll(root, n => n.props['aria-label'] === '互动类型')[0].props.disabled, true, `${row.label} 必须同步禁用选择`);
    assert.match(textOf(root), row.message, `${row.label} 必须显示具体原因`);
    if (!/已用完/.test(String(row.message)))
      assert.doesNotMatch(textOf(root), /互动次数已用完/, `${row.label} 不得假装次数耗尽`);
    click(button(root, '执行班次互动')); await vue.nextTick();
    assert.equal(events.length, 0, `${row.label} 必须零写`);
    assert.equal(dialogCount(root), 0, `${row.label} 不得打开确认`);
    render(null, root);
  }
});

test('合法班次正常互动先确认后恰一次操作；选择不在当前选项时禁用不提交', async () => {
  const { root, events } = mountPanel(snapshot(), workQueries(validWork()));
  assert.equal(button(root, '执行班次互动').props.disabled, false);
  assert.equal(findAll(root, n => n.props['aria-label'] === '互动类型')[0].props.disabled, false);
  setModel(root, '互动类型', 5); await vue.nextTick();
  assert.equal(button(root, '执行班次互动').props.disabled, true);
  assert.match(textOf(root), /所选互动不在当前班次可选项中/);
  click(button(root, '执行班次互动')); await vue.nextTick();
  assert.equal(events.length, 0);
  setModel(root, '互动类型', 1); await vue.nextTick();
  assert.equal(button(root, '执行班次互动').props.disabled, false);
  click(button(root, '执行班次互动')); await vue.nextTick();
  assert.equal(events.length, 0, '确认前零写');
  assert.equal(dialogCount(root), 1);
  click(button(root, '确认执行')); await vue.nextTick();
  assert.deepEqual(events, [['operate', 'interact', { interactionType: 1, shiftId: '3001' }]]);
  assert.equal(dialogCount(root), 0);
  render(null, root);
});

test('互动确认期间班次/次数/上限/选项/读取状态/完成标记/选择/结算变化均撤销，旧确认零写', async () => {
  const mutations = [
    ['班次', q => { q.work.data.myShift.shiftId = '3002'; }],
    ['次数', q => { q.work.data.myShift.interactCount = 1; }],
    ['上限', q => { q.work.data.myShift.interactLimit = 4; }],
    ['选项', q => { q.work.data.myShift.interactPreviews = [{ interactionType: 2 }]; }],
    ['读取中', q => { q.work.loading = true; }],
    ['读取失败', q => { q.work.error = '合成失败'; }],
    ['完成标记', q => { q.work.data.interactDone = true; }],
    ['数据缺失', q => { q.work.data = null; }],
  ];
  for (const [label, mutate] of mutations) {
    const q = vue.reactive(workQueries(validWork()));
    const { root, events } = mountPanel(snapshot(), q);
    click(button(root, '执行班次互动')); await vue.nextTick();
    assert.equal(dialogCount(root), 1, `${label} 前置确认必须打开`);
    mutate(q); await vue.nextTick();
    assert.equal(dialogCount(root), 0, `${label} 变化必须撤销旧确认`);
    assert.equal(events.length, 0, `${label} 变化不得提交`);
    render(null, root);
  }
  const q = vue.reactive(workQueries(validWork()));
  q.work.data.myShift.interactPreviews = [{ interactionType: 1 }, { interactionType: 2 }];
  const selection = mountPanel(snapshot(), q);
  click(button(selection.root, '执行班次互动')); await vue.nextTick();
  setModel(selection.root, '互动类型', 2); await vue.nextTick();
  assert.equal(dialogCount(selection.root), 0, '选择变化必须撤销旧确认');
  assert.equal(selection.events.length, 0);
  render(null, selection.root);
  const activity = vue.reactive(snapshot());
  const settled = mountPanel(activity, workQueries(validWork()));
  click(button(settled.root, '执行班次互动')); await vue.nextTick();
  activity.timing.phase = 'settle'; await vue.nextTick();
  assert.equal(dialogCount(settled.root), 0, '结算状态变化必须撤销旧确认');
  assert.equal(settled.events.length, 0);
  render(null, settled.root);
});

test('互动确认支持取消与Escape；确认时班次已过endAt就地零写撤销', async () => {
  const q = vue.reactive(workQueries(validWork()));
  const { root, events } = mountPanel(snapshot(), q);
  click(button(root, '执行班次互动')); await vue.nextTick();
  click(button(root, '取消')); await vue.nextTick();
  assert.equal(dialogCount(root), 0); assert.equal(events.length, 0);
  click(button(root, '执行班次互动')); await vue.nextTick();
  const backdrop = findAll(root, n => String(n.props.class || '').includes('milk-modal-backdrop'))[0];
  assert.ok(backdrop, '真实组件必须渲染确认遮罩');
  backdrop.props.onKeydown({ key: 'Escape', preventDefault() {} }); await vue.nextTick();
  assert.equal(dialogCount(root), 0); assert.equal(events.length, 0);
  const originalNow = Date.now;
  let now = 1_700_000_000_000;
  Date.now = () => now;
  try {
    q.work.data.myShift.endAt = Math.floor(now / 1000) + 5;
    await vue.nextTick();
    click(button(root, '执行班次互动')); await vue.nextTick();
    assert.equal(dialogCount(root), 1);
    now += 10_000;
    click(button(root, '确认执行')); await vue.nextTick();
    assert.equal(dialogCount(root), 0);
    assert.equal(events.length, 0, '班次过期确认必须零写');
    assert.match(textOf(root), /班次已经结束/);
  } finally {
    Date.now = originalNow;
    render(null, root);
  }
});

function mountRewardPage(postHandler, activity = snapshot()) {
  const api = apiMock();
  api.setGet(async () => ({ data: { ok: true, activity } }));
  api.setPost(postHandler);
  const page = mountActivityPage(api);
  activeRoots.push(page.root);
  return { api, page };
}
async function submitMilkTeaOperation(page) {
  await flush();
  click(button(page.root, '领取每日快乐值')); await vue.nextTick();
  click(button(page.root, '确认执行')); await flush(); await flush();
}

test('实际页面严格ok===true的成功回复展示已确认奖励，保留字符串精度并兜底未知名称', async () => {
  const rewards = [
    { itemId: 40525, name: '森野甜莓', count: '9007199254740993' },
    { itemId: 0, name: '', count: 3 },
    { itemId: 42, name: '12345', count: '2' },
    { itemId: 43, name: '零数量', count: 0 },
    { itemId: 44, name: '负数', count: -1 },
    { itemId: 45, name: '物品12345', count: '4' },
    null,
    { name: '畸形数量', count: {} },
  ];
  const { api, page } = mountRewardPage(async () => ({ data: { ok: true, message: '操作完成', rewards } }));
  await submitMilkTeaOperation(page);
  const text = textOf(page.root);
  assert.match(text, /森野甜莓 × 9007199254740993/);
  assert.match(text, /未知物品 × 3/);
  assert.match(text, /未知物品 × 2/);
  assert.match(text, /未知物品 × 4/);
  assert.doesNotMatch(text, /零数量|负数|物品12345|畸形数量/);
  assert.equal(api.calls.post.length, 1);
  render(null, page.root);
});

test('实际页面 gameplaySuccess=false 但 ok===true 的真实互动回复仍展示已确认奖励', async () => {
  const { api, page } = mountRewardPage(async () => ({ data: { ok: true, gameplaySuccess: false, message: '互动未生效（玩法结果，非请求失败）', rewards: [{ itemId: 1040528, name: '黄金·森野红柚', count: '1' }] } }), snapshot({ gameplay: { work: { available: true, data: validWork() } } }));
  await flush();
  click(button(page.root, '执行班次互动')); await vue.nextTick();
  assert.equal(api.calls.post.length, 0);
  click(button(page.root, '确认执行')); await flush(); await flush();
  assert.match(textOf(page.root), /黄金·森野红柚 × 1/);
  assert.equal(api.calls.post.length, 1);
  assert.equal(api.calls.post[0].body.action, 'interact');
  assert.deepEqual(api.calls.post[0].body.input, { interactionType: 1, shiftId: '3001' });
  render(null, page.root);
});

test('失败/非严格成功/未知奖励/异常回复不展示奖励且不自动重试', async () => {
  const cases = [
    ['非严格成功', async () => ({ data: { ok: 'true', rewards: [{ name: '伪造奖励', count: 1 }] } })],
    ['普通失败', async () => ({ data: { ok: false, error: '合成失败', rewards: [{ name: '伪造奖励', count: 1 }] } })],
    ['未知结果', async () => ({ data: { ok: true, outcome: 'unknown', rewards: [{ name: '伪造奖励', count: 1 }] } })],
    ['未知奖励形态', async () => ({ data: { ok: true, rewards: { name: '伪造奖励', count: 1 } } })],
    ['异常', async () => { throw new Error('synthetic network failure'); }],
  ];
  for (const [label, handler] of cases) {
    const { api, page } = mountRewardPage(handler);
    await submitMilkTeaOperation(page);
    assert.doesNotMatch(textOf(page.root), /伪造奖励/, `${label} 不得冒充已确认奖励`);
    assert.equal(api.calls.post.length, 1, `${label} 不得自动重试`);
    render(null, page.root);
  }
});

test('切号往返/卸载后的迟到成功回复不泄漏旧奖励', async () => {
  const gate = deferred();
  const { api, page } = mountRewardPage(() => gate.promise);
  await flush();
  click(button(page.root, '领取每日快乐值')); await vue.nextTick();
  click(button(page.root, '确认执行')); await flush();
  page.accountRef.value = 'acc-2'; await flush();
  page.accountRef.value = 'acc-1'; await flush();
  const reads = api.calls.get.length;
  gate.resolve({ data: { ok: true, rewards: [{ name: '迟到奖励', count: '5' }] } });
  await flush(); await flush();
  assert.equal(page.toastLog.length, 0, '切号往返后不得弹旧回复提示');
  assert.doesNotMatch(textOf(page.root), /迟到奖励/);
  assert.equal(api.calls.get.length, reads, '迟到结果不得触发新读取');
  render(null, page.root);

  const gate2 = deferred();
  const second = mountRewardPage(() => gate2.promise);
  await flush();
  click(button(second.page.root, '领取每日快乐值')); await vue.nextTick();
  click(button(second.page.root, '确认执行')); await flush();
  render(null, second.page.root);
  gate2.resolve({ data: { ok: true, rewards: [{ name: '卸载迟到奖励', count: '6' }] } });
  await flush(); await flush();
  assert.doesNotMatch(textOf(second.page.root), /卸载迟到奖励/);
  assert.equal(second.page.toastLog.length, 0);
  // 卸载后重进：新页面只展示 refreshed 快照，不继承旧回复。
  const reentered = mountRewardPage(async () => ({ data: { ok: true } }));
  await flush();
  assert.doesNotMatch(textOf(reentered.page.root), /卸载迟到奖励/);
  assert.equal(reentered.api.calls.post.length, 0);
  render(null, reentered.page.root);
});

test('活动到期后的迟到成功回复不泄漏奖励且不新增读取', async () => {
  const originalNow = Date.now;
  let now = 1_700_000_000_000;
  Date.now = () => now;
  try {
    const gate = deferred();
    const api = apiMock();
    api.setGet(async () => ({ data: { ok: true, activity: snapshot({ timing: { endTime: Math.floor(now / 1000) + 5, phase: 'open' } }) } }));
    api.setPost(() => gate.promise);
    const page = mountActivityPage(api); activeRoots.push(page.root);
    await flush();
    click(button(page.root, '领取每日快乐值')); await vue.nextTick();
    click(button(page.root, '确认执行')); await flush();
    now += 10_000;
    const reads = api.calls.get.length;
    gate.resolve({ data: { ok: true, rewards: [{ name: '到期迟到奖励', count: '7' }] } });
    await flush(); await flush();
    assert.doesNotMatch(textOf(page.root), /到期迟到奖励/);
    assert.equal(api.calls.get.length, reads, '到期刷新门必须零新读取');
    render(null, page.root);
  } finally {
    Date.now = originalNow;
  }
});

test('happy-share gift names and probability descriptions render without inventing missing tiers or claims', () => {
  const { root, events } = mountPanel(snapshot({
    happyShareUpdate: { notice: '快乐不独享已新增奶茶券惊喜礼包档位', giftTiersAvailable: false, gifts: [{ id: 101616, name: '奶茶券惊喜礼包', platform: 'QQ', description: '概率获得奶茶兑换券' }] },
    shareReward: { currentScore: 140, milestones: [{ id: 5, threshold: 80, state: 2, rewards: [{ itemId: 101616, itemName: '奶茶券惊喜礼包', itemCount: 1, description: '概率获得奶茶兑换券' }] }] },
  }));
  assert.match(textOf(root), /奶茶券惊喜礼包/); assert.match(textOf(root), /概率获得奶茶兑换券/);
  assert.match(textOf(root), /尚未下发奶茶券惊喜礼包档位/); assert.equal(events.length, 0);
});

test('稀疏奖励数据安全渲染，已确认档位不因空奖励展示条目崩溃', () => {
  const { root } = mountPanel(snapshot({ shareReward: { currentScore: 140, milestones: [{ id: 5, threshold: 80, state: 2, rewards: [null] }] } }));
  assert.equal(button(root, '领取快乐值档位').props.disabled, false);
  assert.match(textOf(root), /未知物品/);
  render(null, root);
});
