'use strict';
// 真实 Vue 渲染回归：用 web 工作区已装的 Vue 编译器/运行时/TypeScript 在内存中编译并
// 渲染 BearActivityPanel.vue（含真实 BaseButton 子组件），检查实际渲染树与交互事件。
// 只复用既有依赖（vue / vue/compiler-sfc / typescript / vue-router），不新增任何依赖。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const REPO_ROOT = path.join(__dirname, '..', '..');
const WEB_MODULES = path.join(REPO_ROOT, 'web', 'node_modules');
const vue = require(path.join(WEB_MODULES, 'vue'));
const sfcCompiler = require(path.join(WEB_MODULES, 'vue', 'compiler-sfc'));
const typescript = require(path.join(WEB_MODULES, 'typescript'));
const vueRouter = require(path.join(WEB_MODULES, 'vue-router'));

const { normalizeBearActivity, BEAR_GUIDE_MANUAL_ACTIONS } = require('../src/services/activity');
const { OPERATIONS } = require('../src/services/pet-diary-operate');

function compileSfcModule(absPath) {
  const source = fs.readFileSync(absPath, 'utf8');
  const { descriptor, errors } = sfcCompiler.parse(source, { filename: absPath });
  assert.deepEqual(errors.map(String), [], `SFC 解析失败: ${absPath}`);
  const script = sfcCompiler.compileScript(descriptor, { id: path.basename(absPath), inlineTemplate: true });
  assert.deepEqual((script.errors || []).map(String), [], `SFC 编译失败: ${absPath}`);
  const cjs = typescript.transpileModule(script.content, {
    compilerOptions: { module: typescript.ModuleKind.CommonJS, target: typescript.ScriptTarget.ESNext },
  }).outputText;
  const mod = { exports: {} };
  mod.exports.__esModule = true;
  const req = spec => {
    if (spec === 'vue')
      return vue;
    if (spec === 'vue-router')
      return vueRouter;
    let target = null;
    if (spec.startsWith('@/'))
      target = path.join(REPO_ROOT, 'web', 'src', spec.slice(2));
    else if (spec.startsWith('.'))
      target = path.resolve(path.dirname(absPath), spec);
    if (target && fs.existsSync(target)) {
      const child = { exports: {} };
      child.exports.__esModule = true;
      child.exports.default = compileSfcModule(target);
      return child.exports;
    }
    throw new Error(`测试加载器无法解析依赖: ${spec}`);
  };
  vm.compileFunction(cjs, ['require', 'module', 'exports'])(req, mod, mod.exports);
  return mod.exports.default;
}

const Panel = compileSfcModule(path.join(REPO_ROOT, 'web/src/components/activity/BearActivityPanel.vue'));

function makeNode(tag) {
  return { tag, children: [], props: {}, text: '', parent: null };
}

const nodeOps = {
  createElement: tag => makeNode(tag),
  createText: (text) => {
    const node = makeNode('TEXT');
    node.text = String(text ?? '');
    return node;
  },
  createComment: () => makeNode('COMMENT'),
  setText: (node, text) => { node.text = String(text); },
  setElementText: (el, text) => { el.text = String(text); el.children.length = 0; },
  parentNode: node => node.parent,
  nextSibling: (node) => {
    if (!node.parent)
      return null;
    const siblings = node.parent.children;
    const index = siblings.indexOf(node);
    return index >= 0 && index + 1 < siblings.length ? siblings[index + 1] : null;
  },
  insert: (child, parent, anchor) => {
    if (child.parent && child.parent !== parent) {
      const index = child.parent.children.indexOf(child);
      if (index !== -1)
        child.parent.children.splice(index, 1);
    }
    child.parent = parent;
    const index = anchor ? parent.children.indexOf(anchor) : -1;
    if (index === -1)
      parent.children.push(child);
    else
      parent.children.splice(index, 0, child);
  },
  remove: (child) => {
    if (child.parent) {
      const index = child.parent.children.indexOf(child);
      if (index !== -1)
        child.parent.children.splice(index, 1);
      child.parent = null;
    }
  },
};

const { render } = vue.createRenderer({
  ...nodeOps,
  patchProp: (el, key, prev, next) => { el.props[key] = next; },
});

// window.prompt 仅由手记输入触发；默认取消，具体用例内覆盖。
let promptResponse = null;
globalThis.window = { prompt: () => promptResponse };

function fixtureActivity(options = {}) {
  const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'season-bear.json'), 'utf8'));
  return normalizeBearActivity(fixture, { nowSeconds: 1789010000, ...options });
}

function mountPanel(activity, { operating = '' } = {}) {
  const root = makeNode('root');
  const events = [];
  render(vue.h(Panel, {
    activity,
    loading: false,
    operating,
    onOperate: (...args) => events.push(args),
    onRefresh: () => events.push(['refresh']),
    'onUpdate:operating': () => {},
  }), root);
  return { root, events };
}

function textOf(node) {
  if (node.tag === 'TEXT' || node.tag === 'COMMENT')
    return node.text || '';
  return (node.text || '') + (node.children || []).map(textOf).join('');
}

function findAll(node, pred, out = []) {
  if (pred(node))
    out.push(node);
  for (const child of node.children || [])
    findAll(child, pred, out);
  return out;
}

const buttonsOf = root => findAll(root, node => node.tag === 'button');
const articlesOf = root => findAll(root, node => node.tag === 'article');

function guideCard(root, title) {
  // 玩法卡标题是卡片文本的开头（h4 在首位），用前缀匹配避免步骤文本中的同名词误命中。
  return articlesOf(root).find(card => textOf(card).startsWith(title));
}

const TOP_BUTTON_LABELS = [
  '领养比熊（过开场）', '投喂元气糕', '寻宝', '领取永久比熊',
  '领取种子礼包', '领取夺宝补偿', '领取手记奖励',
];

function topButtons(root) {
  return buttonsOf(root).filter(button => TOP_BUTTON_LABELS.includes(textOf(button).trim()));
}

function click(button) {
  const handler = button.props.onClick;
  if (typeof handler !== 'function')
    throw new Error('按钮没有可点击处理器');
  handler({});
}

test('真实渲染：五类玩法卡显示顶部手动入口提示且不再标协议待确认，六类维持原禁用边界', () => {
  const { root, events } = mountPanel(fixtureActivity());
  assert.equal(events.length, 0);

  // 五类已开放手动操作的玩法卡：显示对应顶部按钮标签，不渲染卡片按钮（不新增触发入口）。
  const opened = [
    ['领养与投喂成长', /手动操作已开放：领养比熊（过开场）、投喂元气糕、领取永久比熊（上方「玩法手动操作」区）?/],
    ['成年寻宝', /手动操作已开放：寻宝/],
    ['骰子胜负与安慰礼', /手动操作已开放：领取夺宝补偿/],
    ['爪印手记', /手动操作已开放：领取手记奖励/],
    ['每日稀有种子礼包', /手动操作已开放：领取种子礼包/],
  ];
  const topLabels = topButtons(root).map(button => textOf(button).trim());
  assert.deepEqual([...topLabels].sort(), [...TOP_BUTTON_LABELS].sort());
  for (const [title, pattern] of opened) {
    const card = guideCard(root, title);
    assert.ok(card, `未找到玩法卡: ${title}`);
    const text = textOf(card);
    assert.match(text, pattern);
    assert.doesNotMatch(text, /操作协议待确认/);
    assert.equal(findAll(card, node => node.tag === 'button').length, 0, `${title} 卡不得新增可点击执行入口`);
    assert.equal(findAll(card, node => node.props.onClick != null).length, 0, `${title} 卡不得新增点击处理器`);
    // 提示中的按钮标签必须真实存在于顶部手动操作区。
    const hintLabels = (text.match(/手动操作已开放：(.+?)（上方/)?.[1] || '').split('、');
    for (const label of hintLabels) assert.ok(topLabels.includes(label), `提示标签 ${label} 不在顶部按钮中`);
  }

  // 其余六类玩法卡：保持禁用按钮与准确边界。
  const raid = guideCard(root, '好友夺宝');
  assert.match(textOf(raid), /发起夺宝 · 好友交互暂未开放/);
  assert.doesNotMatch(textOf(raid), /操作协议待确认/);
  const shop = guideCard(root, '幸运星游记商城');
  assert.match(textOf(shop), /兑换商品 · 面板暂无兑换入口/);
  assert.match(textOf(shop), /兑换限额与拥有状态见商城：当前面板仅展示商品，暂无兑换入口；状态码语义待官方样本/);
  assert.doesNotMatch(textOf(shop), /操作仍待确认/);
  for (const title of ['看护与比熊变异', '宝藏护送', '锦囊选择与刷新', '幸运星好友排名']) {
    const card = guideCard(root, title);
    assert.match(textOf(card), /操作协议待确认/, `${title} 应保持原禁用边界`);
  }
  for (const card of [raid, shop, guideCard(root, '看护与比熊变异'), guideCard(root, '宝藏护送'), guideCard(root, '锦囊选择与刷新'), guideCard(root, '幸运星好友排名')]) {
    const button = findAll(card, node => node.tag === 'button')[0];
    assert.ok(button, '未开放玩法卡应保留禁用按钮');
    assert.equal(button.props.disabled, true, '未开放玩法按钮必须禁用');
    click(button);
  }
  assert.equal(events.length, 0, '禁用按钮点击不得触发操作');

  // 商城正文不得笼统宣称兑换能力未开放，改为说明面板未提供兑换入口。
  assert.match(textOf(root), /价格和拥有标记来自本次回包；状态码的次数与可兑换含义尚未确认，当前面板未提供兑换入口/);
  assert.doesNotMatch(textOf(root), /不开放兑换/);

  // 按钮总数锁定：1 刷新 + 7 顶部手动 + 6 未开放玩法卡 = 14，无新增执行入口。
  assert.equal(buttonsOf(root).length, 14);
});

test('真实交互：七个顶部按钮各自只触发原有 operate 事件；手记输入与取消；操作中禁用；无快照不展示手动区', () => {
  const { root, events } = mountPanel(fixtureActivity());
  for (const key of ['initialize', 'feed', 'draw', 'claimDog', 'seeds', 'compensation']) {
    events.length = 0;
    const button = topButtons(root).find(item => textOf(item).trim() === (
      { initialize: '领养比熊（过开场）', feed: '投喂元气糕', draw: '寻宝', claimDog: '领取永久比熊', seeds: '领取种子礼包', compensation: '领取夺宝补偿' }[key]
    ));
    click(button);
    assert.deepEqual(events, [[key]], `${key} 应且只应触发 operate 事件`);
  }
  // 手记输入：传入 order 参数；取消输入不触发。
  events.length = 0;
  promptResponse = '3';
  try {
    click(topButtons(root).find(item => textOf(item).trim() === '领取手记奖励'));
    assert.deepEqual(events, [['story', { order: 3 }]]);
    events.length = 0;
    promptResponse = null;
    click(topButtons(root).find(item => textOf(item).trim() === '领取手记奖励'));
    assert.deepEqual(events, []);
  } finally {
    promptResponse = null;
  }
  // 刷新按钮保持原有 refresh 事件。
  events.length = 0;
  click(buttonsOf(root).find(item => textOf(item).includes('刷新只读状态')));
  assert.deepEqual(events, [['refresh']]);

  // operating 非空时：按钮禁用且点击不产生新操作。
  const busy = mountPanel(fixtureActivity(), { operating: 'feed' });
  for (const button of topButtons(busy.root)) {
    assert.equal(button.props.disabled, true, '操作进行中按钮必须禁用');
    click(button);
  }
  assert.equal(busy.events.length, 0, '操作进行中不得产生新操作事件');

  // activity 为 null：不展示手动操作区，只保留刷新按钮。
  const empty = mountPanel(null);
  assert.doesNotMatch(textOf(empty.root), /玩法手动操作/);
  assert.equal(buttonsOf(empty.root).length, 1);
  assert.match(textOf(empty.root), /当前没有可用活动快照/);
});

test('真实渲染：补偿提示为连续三次夺宝失败触发，差异提示、玩法流程、赛季提示与奖励记录保留', () => {
  const { root } = mountPanel(fixtureActivity());
  const compensation = topButtons(root).find(button => textOf(button).includes('领取夺宝补偿'));
  assert.equal(compensation.props.title, '连续夺宝失败 3 次后触发的安慰礼（如有可领取）');
  assert.doesNotMatch(String(compensation.props.title), /被夺宝/);

  // 官方说明差异、十一类玩法流程、赛季结束提示、奖励记录区继续保留。
  assert.match(textOf(root), /官方说明存在差异/);
  assert.equal(articlesOf(root).filter(card => /操作协议待确认|手动操作已开放|好友交互暂未开放|面板暂无兑换入口/.test(textOf(card))).length, 11);
  assert.match(textOf(root), /每日刷新与赛季结束提示/);
  assert.match(textOf(root), /游记奖励记录/);
  assert.match(textOf(root), /奖励记录状态尚未包含在当前快照中。/);
});

test('真实渲染：状态行按玩法区分快照未展示与待字段证据；背包失败未知、成功显示库存', () => {
  const input = fixtureActivity();
  const { root } = mountPanel(input);
  assert.equal(input.inventoryAvailable, false);
  assert.match(textOf(root), /本次背包读取不可用，数量保持未知。/);
  assert.equal(articlesOf(root).filter(card => textOf(card).includes('数量待确认')).length, 8);
  // 指南状态行不再统一宣称「当前状态待官方字段证据」：
  // 五类已开放手动操作的玩法说明实时状态快照未展示、操作前重新校验（成长进度明确未展示）；
  // 夺宝说明次数与目标状态待字段证据、挑战书库存见道具库存区；看护/护送/锦囊/排名保持待字段证据。
  const guideCards = articlesOf(root).filter(item => /手动操作已开放|操作协议待确认|好友交互暂未开放|面板暂无兑换入口/.test(textOf(item)));
  assert.equal(guideCards.length, 11);
  for (const card of guideCards) {
    const text = textOf(card);
    assert.doesNotMatch(text, /当前状态待官方字段证据/);
    if (text.startsWith('幸运星游记商城')) {
      assert.match(text, /当前面板仅展示商品，暂无兑换入口；状态码语义待官方样本/);
    } else if (text.startsWith('好友夺宝')) {
      assert.match(text, /今日剩余次数、目标护送状态：实时状态当前快照未提供，待官方字段证据；挑战书库存见上方「活动道具与库存」/);
    } else if (/手动操作已开放/.test(text)) {
      assert.match(text, /实时状态当前快照未展示，点击手动操作时会重新校验，未知不按 0 处理/);
    } else {
      assert.match(text, /实时状态当前快照未提供，待官方字段证据，未知不按 0 处理/);
    }
  }
  // 成长进度不得被展示成已知（快照未提供，也不因顶部入口开放伪造实时状态）。
  const growCard = guideCard(root, '领养与投喂成长');
  assert.match(textOf(growCard), /成长进度、成年状态：实时状态当前快照未展示/);

  // 背包读取成功：资源区显示真实库存；夺宝卡不再把挑战书库存列为缺字段证据（与资源区矛盾）。
  const stocked = fixtureActivity({ inventoryAvailable: true, counts: new Map([[80102, 3], [1028, 12]]) });
  const stockedRender = mountPanel(stocked);
  const middleCard = articlesOf(stockedRender.root).find(card => textOf(card).startsWith('中级挑战书'));
  assert.ok(middleCard, '资源区应展示中级挑战书卡');
  assert.match(textOf(middleCard), /^中级挑战书3/);
  assert.match(textOf(middleCard), /道具 ID 80102/);
  assert.doesNotMatch(textOf(stockedRender.root), /本次背包读取不可用/);
  const stockedRaid = guideCard(stockedRender.root, '好友夺宝');
  assert.doesNotMatch(textOf(stockedRaid), /今日剩余次数、挑战书库存/);
  assert.match(textOf(stockedRaid), /今日剩余次数、目标护送状态：实时状态当前快照未提供，待官方字段证据；挑战书库存见上方「活动道具与库存」/);

  // 记录领取态为 null 时展示未知，不显示已领取。
  const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'season-bear.json'), 'utf8'));
  fixture.children[1].details = {
    starRecord: {
      records: [{ id: 1, title: '比熊赠礼', unlocked: null, claimed: null, rewards: [] }],
    },
  };
  const withRecords = normalizeBearActivity(fixture, { nowSeconds: 1789010000 });
  const rendered = mountPanel(withRecords);
  assert.match(textOf(rendered.root), /解锁状态未知 · 领取状态未知/);
  assert.doesNotMatch(textOf(rendered.root), /已领取/);
});

test('真实渲染：旧数据缺少 manualActions 或包含未知动作值时不崩溃、不显示裸动作键', () => {
  // 旧数据（缓存中没有 manualActions 字段）：全部玩法卡回退到原禁用按钮；
  // raid/shop 的后缀按玩法键固定（好友交互未开放 / 面板暂无兑换入口），不依赖 manualActions。
  const legacy = fixtureActivity();
  for (const guide of legacy.gameplayGuides) delete guide.manualActions;
  const legacyRender = mountPanel(legacy);
  const legacyCards = articlesOf(legacyRender.root)
    .filter(card => /操作协议待确认|好友交互暂未开放|面板暂无兑换入口/.test(textOf(card)));
  assert.equal(legacyCards.length, 11);
  assert.equal(legacyCards.filter(card => textOf(card).includes('操作协议待确认')).length, 9);
  for (const card of legacyCards) {
    const button = findAll(card, node => node.tag === 'button')[0];
    assert.equal(button.props.disabled, true, '旧数据回退按钮必须禁用');
  }
  assert.equal(buttonsOf(legacyRender.root).length, 1 + 7 + 11);
  assert.deepEqual(topButtons(legacyRender.root).map(button => textOf(button).trim()).sort(), [...TOP_BUTTON_LABELS].sort());
  assert.doesNotMatch(textOf(legacyRender.root), /undefined|NaN/);

  // 未知动作值（含原型属性键 toString / constructor）：过滤后回退禁用按钮或仅显示可匹配
  // 标签，不显示裸动作键、不显示继承函数文本、不产生虚假的“已开放”提示、不新增执行按钮。
  const bogus = fixtureActivity();
  bogus.gameplayGuides.find(guide => guide.key === 'grow').manualActions = ['bogus_action', 'toString', 'feed', 'constructor'];
  bogus.gameplayGuides.find(guide => guide.key === 'treasure').manualActions = ['another_bogus', 'toString'];
  bogus.gameplayGuides.find(guide => guide.key === 'pity').manualActions = ['toString', 'constructor'];
  const bogusRender = mountPanel(bogus);
  assert.doesNotMatch(textOf(bogusRender.root), /bogus_action|another_bogus/);
  assert.doesNotMatch(textOf(bogusRender.root), /native code/);
  assert.doesNotMatch(textOf(bogusRender.root), /toString|constructor/);
  const growCard = guideCard(bogusRender.root, '领养与投喂成长');
  assert.match(textOf(growCard), /手动操作已开放：投喂元气糕（上方「玩法手动操作」区）/);
  assert.equal(findAll(growCard, node => node.tag === 'button').length, 0);
  const treasureCard = guideCard(bogusRender.root, '成年寻宝');
  assert.match(textOf(treasureCard), /派遣寻宝 · 操作协议待确认/);
  const pityCard = guideCard(bogusRender.root, '骰子胜负与安慰礼');
  assert.match(textOf(pityCard), /领取安慰礼 · 操作协议待确认/);
  assert.equal(findAll(pityCard, node => node.tag === 'button').length, 1);
  assert.equal(topButtons(bogusRender.root).length, 7, '顶部既有操作入口保持不变');

  // 后端数据契约：提示键必须属于现有 OPERATIONS 白名单（与 season-bear-activity 测试互证）。
  for (const action of new Set(Object.values(BEAR_GUIDE_MANUAL_ACTIONS).flat())) {
    assert.ok(Object.prototype.hasOwnProperty.call(OPERATIONS, action));
  }
});
