'use strict';
// 一键领取回归：真实行为测试（模拟网络/时钟，零真实游戏请求）。
// 三层：
//  1) 服务端资格汇总 summarizeBearClaimEligibility + getBearActivity 接线（真实 proto 编解码）
//  2) 真实 store（web/src/stores/activity.ts 编译加载）runner 编排：串行、部分失败、
//     账号切换取消、互斥、快乐值每日→新档位、无资格零写、禁止动作白名单
//  3) 真实组件渲染点击：ClaimAllPanel 与 Activity.vue（内置真实 store + 模拟 api）
// 只复用既有依赖（vue / compiler-sfc / typescript / pinia / vue-router），不新增依赖。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const REPO_ROOT = path.join(__dirname, '..', '..');
const WEB = path.join(REPO_ROOT, 'web');
const MODULES = path.join(WEB, 'node_modules');
const vue = require(path.join(MODULES, 'vue'));
const pinia = require(path.join(MODULES, 'pinia'));
const vueRouter = require(path.join(MODULES, 'vue-router'));
const sfcCompiler = require(path.join(MODULES, 'vue', 'compiler-sfc'));
const ts = require(path.join(MODULES, 'typescript'));

const { summarizeBearClaimEligibility } = require('../src/services/season-bear-activity');
const { getBearActivity } = require('../src/services/activity');
const { loadProto, types } = require('../src/utils/proto');

const BEAR_GROUP_ID = 2026090100;
const BEAR_PLAY_ID = 2026090101;
const BEAR_SEEDS_ID = 2026090102;

// ---------- TS / SFC 加载器（bear-activity-panel / wx-login-ui 测试既有模式） ----------
function evaluateModule(source, resolve, filename = 'module.ts') {
  const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ESNext },
  }).outputText;
  const mod = { exports: {} };
  mod.exports.__esModule = true;
  vm.compileFunction(code, ['require', 'module', 'exports'])(spec => {
    const value = resolve(spec, filename);
    if (value === undefined)
      throw new Error(`测试加载器无法解析依赖: ${spec} (from ${filename})`);
    return value;
  }, mod, mod.exports);
  return mod.exports;
}

function compileSfcModule(absPath, resolve) {
  const source = fs.readFileSync(absPath, 'utf8');
  const { descriptor, errors } = sfcCompiler.parse(source, { filename: absPath });
  assert.deepEqual(errors.map(String), [], `SFC 解析失败: ${absPath}`);
  const script = sfcCompiler.compileScript(descriptor, { id: path.basename(absPath), inlineTemplate: true });
  assert.deepEqual((script.errors || []).map(String), [], `SFC 编译失败: ${absPath}`);
  const cjs = ts.transpileModule(script.content, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ESNext },
  }).outputText;
  const mod = { exports: {} };
  mod.exports.__esModule = true;
  vm.compileFunction(cjs, ['require', 'module', 'exports'])(spec => {
    const value = resolve(spec, absPath);
    if (value !== undefined)
      return value;
    let target = null;
    if (spec.startsWith('@/'))
      target = path.join(WEB, 'src', spec.slice(2));
    else if (spec.startsWith('.'))
      target = path.resolve(path.dirname(absPath), spec);
    if (target) {
      if (fs.existsSync(target) && target.endsWith('.vue')) {
        const child = { exports: {} };
        child.exports.__esModule = true;
        child.exports.default = compileSfcModule(target, resolve);
        return child.exports;
      }
      for (const suffix of ['.ts', '.js']) {
        if (fs.existsSync(target + suffix)) {
          const child = { exports: {} };
          child.exports.__esModule = true;
          Object.assign(child.exports, evaluateModule(
            fs.readFileSync(target + suffix, 'utf8'), resolve, target + suffix,
          ));
          return child.exports;
        }
      }
    }
    throw new Error(`测试加载器无法解析依赖: ${spec} (from ${absPath})`);
  }, mod, mod.exports);
  return mod.exports.default;
}

// ---------- 自定义渲染器节点树（bear-activity-panel 测试既有模式） ----------
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
    if (!child)
      return; // 卸载时 vue 可能对 Teleport 目标传 null
    if (child.parent) {
      const index = child.parent.children.indexOf(child);
      if (index !== -1)
        child.parent.children.splice(index, 1);
      child.parent = null;
    }
  },
};
const { render } = vue.createRenderer({ ...nodeOps, patchProp: (el, key, prev, next) => { el.props[key] = next; } });

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
function click(button) {
  const handler = button.props.onClick;
  if (typeof handler !== 'function')
    throw new Error('按钮没有可点击处理器');
  handler({});
}
const flush = () => new Promise(resolve => setImmediate(resolve));
async function waitFor(predicate, label, rounds = 60) {
  for (let index = 0; index < rounds; index++) {
    if (predicate())
      return;
    await flush();
  }
  assert.ok(predicate(), `等待超时: ${label}`);
}
globalThis.window = globalThis.window || { prompt: () => null };

// ---------- 服务端资格汇总 ----------
function decodedPetReply(now, { stage = 2, dogGranted = false, compensation = 2, stories = [
  { order: 1, unlocked: true, claimed: false },
  { order: 2, unlocked: true, claimed: true },
  { order: 3, unlocked: false, claimed: false },
], seedsRewards = [{ unlock_day: 1, unlocked: true, claimable: true, claimed: false }], playActive = true, seedsActive = true, withState = true } = {}) {
  return {
    group: {
      children: [
        {
          head: { id: BEAR_PLAY_ID, start_time: playActive ? now - 1000 : 0, end_time: playActive ? now + 100000 : 0 },
          ...(withState
            ? {
                pet_treasure_hunt: {
                  nurture: { stage, dog_granted: dogGranted },
                  story: { stories },
                  plunder: { plunder_compensation_count: compensation },
                },
              }
            : {}),
        },
        {
          head: { id: BEAR_SEEDS_ID, start_time: seedsActive ? now - 1000 : 0, end_time: seedsActive ? now + 100000 : 0 },
          mega_event: { rewards: seedsRewards },
        },
      ],
    },
  };
}

test('资格汇总：四类免费领取与 pet-diary-operate 服务端校验逐条镜像，未知/未开放归为不可领', () => {
  const now = 1_790_200_000;
  const full = summarizeBearClaimEligibility(decodedPetReply(now), { nowSeconds: now });
  assert.deepEqual(full, {
    available: true, reason: '', stories: [1], dogClaimable: true, compensationCount: 2, seedsClaimable: true,
  });
  // 已领狗/无补偿/种子已领：各分类独立归 false，不互相影响 available
  const drained = summarizeBearClaimEligibility(decodedPetReply(now, {
    dogGranted: true, compensation: 0,
    stories: [{ order: 1, unlocked: true, claimed: true }],
    seedsRewards: [{ claimable: true, claimed: true }],
  }), { nowSeconds: now });
  assert.deepEqual(drained, { available: true, reason: '', stories: [], dogClaimable: false, compensationCount: 0, seedsClaimable: false });
  // 未成年不可领狗；stage 非 2
  assert.equal(summarizeBearClaimEligibility(decodedPetReply(now, { stage: 1 }), { nowSeconds: now }).dogClaimable, false);
  // 玩法节点不在活动窗口 / 状态未下发：available=false 带原因（前端跳过不试写）
  assert.equal(summarizeBearClaimEligibility(decodedPetReply(now, { playActive: false }), { nowSeconds: now }).available, false);
  assert.equal(summarizeBearClaimEligibility(decodedPetReply(now, { withState: false }), { nowSeconds: now }).available, false);
  // 种子节点过期：整体仍 available（手记/补偿可领），仅 seedsClaimable=false
  const seedsOff = summarizeBearClaimEligibility(decodedPetReply(now, { seedsActive: false }), { nowSeconds: now });
  assert.equal(seedsOff.available, true);
  assert.equal(seedsOff.seedsClaimable, false);
});

test('getBearActivity 接线：快照回调就地解码资格；公开快照不再携带 rawBody，序列化无原始回包', async () => {
  await loadProto();
  const now = Math.floor(Date.now() / 1000);
  const rawBody = types.PetDiaryGetGroupReply.encode(
    types.PetDiaryGetGroupReply.create(decodedPetReply(now)),
  ).finish();
  // 公开快照（getActivityGroupSnapshot 的返回形状）：discoveryEvidence 只剩挑选字段与结构指纹
  const snapshot = {
    id: BEAR_GROUP_ID, title: 'S3 萌宠', visible: true, enabled: true, status: 20,
    startTime: now - 2000, endTime: now + 200000,
    children: [{ id: BEAR_PLAY_ID }, { id: BEAR_SEEDS_ID }, { id: 2026090103 }],
    discoveryEvidence: { protocolShape: [{ path: '1.2.115', wire: 2, count: 1, byteLengths: [30] }] },
  };
  const activity = await getBearActivity({
    getActivityDiscoveryList: async () => [{ id: BEAR_GROUP_ID, parentId: 0 }],
    // 真实快照读取契约：原始回包经 options.onRawBody 私有回调交出，不进入返回值
    getActivityGroupSnapshot: async (id, uid, options = {}) => {
      if (typeof options.onRawBody === 'function')
        options.onRawBody(rawBody);
      return snapshot;
    },
    getBagItemCounts: async () => { throw new Error('bag offline'); },
    nowSeconds: now,
  });
  assert.deepEqual(activity.claimEligibility, {
    available: true, reason: '', stories: [1], dogClaimable: true, compensationCount: 2, seedsClaimable: true,
  });
  // 公开快照与活动对象序列化后均无原始回包/原始字节
  assert.ok(!('rawBody' in snapshot.discoveryEvidence));
  const activityJson = JSON.stringify(activity);
  assert.ok(!activityJson.includes('rawBody'));
  assert.ok(!activityJson.includes('discoveryEvidence'));
  assert.ok(!activityJson.includes('"type":"Buffer"'));
  // 快照读取未交出原始回包：资格保持未知（前端跳过），读取本身不失败
  const noRaw = await getBearActivity({
    getActivityDiscoveryList: async () => [{ id: BEAR_GROUP_ID, parentId: 0 }],
    getActivityGroupSnapshot: async () => ({ ...snapshot }),
    getBagItemCounts: async () => ({ counts: new Map(), available: false }),
    nowSeconds: now,
  });
  assert.equal(noRaw.claimEligibility.available, false);
  assert.match(noRaw.claimEligibility.reason, /未知/);
});

// ---------- 公开快照隐私回归：真实网络路径 + 真实 protobuf 编解码 ----------
// 真实回包字节经 getActivityGroupSnapshot（Worker/data-provider 同一公开出口）不得
// 泄出原始 Buffer / 原文密钥；萌宠资格只在 onRawBody 私有回调里就地解码。
const NETWORK_PATH = require.resolve('../src/utils/network');
const ACTIVITY_PATH = require.resolve('../src/services/activity');
function loadActivityWithNetwork(sendMsgAsync) {
  const savedNetwork = require.cache[NETWORK_PATH];
  const savedActivity = require.cache[ACTIVITY_PATH];
  require.cache[NETWORK_PATH] = {
    id: NETWORK_PATH, filename: NETWORK_PATH, loaded: true, children: [],
    exports: { sendMsgAsync, getUserState: () => ({}), isConnected: () => true },
  };
  delete require.cache[ACTIVITY_PATH];
  try {
    return require(ACTIVITY_PATH);
  }
  finally {
    require.cache[NETWORK_PATH] = savedNetwork;
    require.cache[ACTIVITY_PATH] = savedActivity;
  }
}

test('公开快照隐私：真实 GetGroup 回包序列化后无原始字节/分享密钥；onRawBody 收到原始 Buffer', async () => {
  await loadProto();
  const now = Math.floor(Date.now() / 1000);
  const fixture = decodedPetReply(now);
  fixture.group.head = { id: BEAR_GROUP_ID, start_time: now - 2000, end_time: now + 200000 };
  // 原始回包里埋一个“密钥”标记：wire 层可见，任何公开序列化输出不可见
  fixture.group.children[0].pet_treasure_hunt.story.stories[0].selected_desc = 'SHARE-SECRET-9f8e7d';
  const body = types.PetDiaryGetGroupReply.encode(types.PetDiaryGetGroupReply.create(fixture)).finish();
  const mod = loadActivityWithNetwork(async () => ({ body }));

  // Worker/data-provider 的公开调用（无 options）：返回值里没有任何原始回包
  const snapshot = await mod.getActivityGroupSnapshot(BEAR_GROUP_ID, '');
  assert.equal(Number(snapshot.id), BEAR_GROUP_ID);
  assert.ok(!('rawBody' in (snapshot.discoveryEvidence || {})), '公开快照不得携带 rawBody');
  const json = JSON.stringify(snapshot);
  assert.ok(!json.includes('SHARE-SECRET-9f8e7d'), '原文密钥不得出现在快照序列化结果');
  assert.ok(!json.includes('rawBody'));
  assert.ok(!json.includes('"type":"Buffer"'), '不得整体透传原始 Buffer');

  // 私有回调：服务内调用方拿到的是完整原始字节（可二次解码）
  let callbackBody = null;
  await mod.getActivityGroupSnapshot(BEAR_GROUP_ID, '', { onRawBody: b => (callbackBody = b) });
  assert.ok(Buffer.isBuffer(callbackBody));
  assert.ok(callbackBody.equals(Buffer.from(body)));

  // getBearActivity 走真实 getActivityGroupSnapshot：int64 head 编码→解码（Long）后资格逐字段成立
  const activity = await mod.getBearActivity({
    getActivityDiscoveryList: async () => [{ id: BEAR_GROUP_ID, parentId: 0 }],
    getActivityGroupSnapshot: mod.getActivityGroupSnapshot,
    getBagItemCounts: async () => ({ counts: new Map(), available: false }),
  });
  assert.deepEqual(activity.claimEligibility, {
    available: true, reason: '', stories: [1], dogClaimable: true, compensationCount: 2, seedsClaimable: true,
  });
});

test('资格汇总（真实编解码 fixture）：状态缺失/活动不在窗口归不可领且带原因', async () => {
  await loadProto();
  const now = Math.floor(Date.now() / 1000);
  for (const [name, extra, reasonPattern] of [
    ['状态未下发', { withState: false }, /状态未下发/],
    ['玩法节点不在窗口', { playActive: false }, /不在活动时间内/],
  ]) {
    const fixture = decodedPetReply(now, extra);
    fixture.group.head = { id: BEAR_GROUP_ID, start_time: now - 2000, end_time: now + 200000 };
    const body = types.PetDiaryGetGroupReply.encode(
      types.PetDiaryGetGroupReply.create(fixture),
    ).finish();
    const mod = loadActivityWithNetwork(async () => ({ body }));
    const activity = await mod.getBearActivity({
      getActivityDiscoveryList: async () => [{ id: BEAR_GROUP_ID, parentId: 0 }],
      getActivityGroupSnapshot: mod.getActivityGroupSnapshot,
      getBagItemCounts: async () => ({ counts: new Map(), available: false }),
    });
    assert.equal(activity.claimEligibility.available, false, name);
    assert.match(activity.claimEligibility.reason, reasonPattern, name);
  }
});

// ---------- 真实 store runner ----------
function apiMock() {
  const calls = { get: [], post: [] };
  let getHandler = async () => ({ data: { ok: true } });
  let postHandler = async () => ({ data: { ok: true } });
  const instance = {
    get: async (url, config) => {
      calls.get.push({ url, accountId: config?.headers?.['x-account-id'] });
      return getHandler(url, config);
    },
    post: async (url, body, config) => {
      calls.post.push({ url, body, accountId: config?.headers?.['x-account-id'] });
      return postHandler(url, body, config);
    },
  };
  return { instance, calls, setGet: fn => (getHandler = fn), setPost: fn => (postHandler = fn) };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function storeHarness() {
  const api = apiMock();
  const accountState = { currentAccountId: 'acc-1' };
  const resolve = (spec) => {
    if (spec === 'vue')
      return vue;
    if (spec === 'pinia')
      return pinia;
    if (spec === '@/api')
      return { __esModule: true, default: api.instance };
    if (spec === '@/stores/account')
      return { useAccountStore: () => accountState };
    return undefined;
  };
  const mod = evaluateModule(
    fs.readFileSync(path.join(WEB, 'src/stores/activity.ts'), 'utf8'), resolve,
  );
  const store = mod.useActivityStore(pinia.createPinia());
  return { store, api, accountState };
}

const fullEligibility = { available: true, reason: '', stories: [2, 5], dogClaimable: true, compensationCount: 1, seedsClaimable: true };
const wishPendingState = { remainingCount: 1, activityDay: 2, pending: { chooseId: 3, textId: 1, dayId: 2, rewards: [] } };
const shareBeforeDaily = { currentScore: 10, daily: { claimedCount: 0, claimLimit: 1, rewardClaimed: false, firstShareAwarded: false }, milestones: [{ id: 1, threshold: 20, state: 1, rewards: [] }] };
const shareAfterDaily = { currentScore: 40, daily: { claimedCount: 1, claimLimit: 1, rewardClaimed: true, firstShareAwarded: false }, milestones: [{ id: 1, threshold: 20, state: 2, rewards: [] }] };

function petOkPost(url, body) {
  return { data: { ok: true, action: body.action, rewards: [{ id: 29004, count: '3', name: '' }], message: '操作成功' } };
}
function wishOkPost(url, body) {
  const rewards = { wishClaim: [{ itemName: '烟花桶', itemCount: 2 }], shareDaily: [{ itemName: '快乐值', itemCount: 30 }] }[body.action] || [];
  return { data: { ok: true, rewards, ...(body.action === 'shareDaily' ? { grantedScore: 30 } : {}) } };
}

test('runner 全量：先重读三组资格再按序领取 + 待领签文 + 快乐值每日→刷新→新档位；只发白名单动作', async () => {
  const h = storeHarness();
  let shareState = shareBeforeDaily;
  h.api.setGet(async (url) => {
    if (url.includes('happy-share'))
      return { data: { ok: true, activity: { operateState: shareState } } };
    if (url.includes('wish'))
      return { data: { ok: true, activity: { operateState: wishPendingState } } };
    return { data: { ok: true, activity: { claimEligibility: fullEligibility } } };
  });
  h.api.setPost(async (url, body) => {
    if (body.action === 'shareDaily')
      shareState = shareAfterDaily; // 每日领取成功 → 快乐值 40、档位 1 变可领取
    return url.includes('pet-diary') ? petOkPost(url, body) : wishOkPost(url, body);
  });

  const result = await h.store.runClaimAll('acc-1');

  const posts = h.api.calls.post.map(call => ({ url: call.url, action: call.body.action, input: call.body.input }));
  // 顺序：种子→补偿→比熊→手记2→手记5→签文→每日→（刷新）→档位
  assert.deepEqual(posts.map(post => post.action), [
    'seeds', 'compensation', 'claimDog', 'story', 'story', 'wishClaim', 'shareDaily', 'shareMilestones',
  ]);
  assert.deepEqual(posts[3].input, { order: 2 });
  assert.deepEqual(posts[4].input, { order: 5 });
  assert.deepEqual(posts[5].input, { chooseId: 3 });
  // 写计划来自本轮重读：开跑后先发 3 个只读请求（bear/wish/happy-share）
  assert.ok(h.api.calls.get.length >= 3, '本轮资格先重读');
  assert.ok(h.api.calls.get.every(call => call.accountId === 'acc-1'));
  // 每日领取后必须重读快乐值状态再判档位（不依赖旧缓存）
  const shareReads = h.api.calls.get.filter(call => call.url.includes('happy-share'));
  assert.ok(shareReads.length >= 2, '每日领取后应重读快乐值状态');
  // 白名单：绝不出现抽签/购买/分享/夺宝/投喂/寻宝/兑换/初始化
  const forbidden = ['wishDraw', 'shareShare', 'exchange', 'battle', 'feed', 'draw', 'initialize', 'skipBattle', 'markStories'];
  assert.equal(posts.filter(post => forbidden.includes(post.action)).length, 0);
  assert.ok(h.api.calls.post.every(call => call.accountId === 'acc-1'));

  assert.equal(result.ok, true);
  assert.equal(result.successCount, 8);
  assert.equal(result.failedCount, 0);
  const statuses = h.store.claimAllResults.map(item => item.status);
  assert.deepEqual(statuses, Array.from({ length: 8 }, () => 'success'));
  assert.match(h.store.claimAllResults[0].detail, /道具×3/);
  assert.match(h.store.claimAllResults[5].detail, /烟花桶×2/);
  assert.equal(h.store.claimAllRunning, false);
  assert.equal(h.store.claimAllStep, '');
});

test('runner 计划只认本轮重读：旧页面状态过期不改写本轮计划（旧状态漏项由重读补回）', async () => {
  const h = storeHarness();
  // 页面旧状态：全部“无可领”；本轮服务端重读：种子可领。若沿用旧页面状态会漏掉奖励。
  h.store.bearActivity = { claimEligibility: { available: true, reason: '', stories: [], dogClaimable: false, compensationCount: 0, seedsClaimable: false } };
  h.api.setGet(async url => (url.includes('bear')
    ? { data: { ok: true, activity: { claimEligibility: { available: true, reason: '', stories: [], dogClaimable: false, compensationCount: 0, seedsClaimable: true } } } }
    : { data: { ok: true, activity: {} } }));
  h.api.setPost(async (url, body) => petOkPost(url, body));
  const result = await h.store.runClaimAll('acc-1');
  assert.deepEqual(h.api.calls.post.map(call => call.body.action), ['seeds'], '重读后的新资格必须生效');
  assert.equal(result.successCount, 1);
});

test('runner 零写：全无奖励只产生跳过项，不发任何写请求', async () => {
  const h = storeHarness();
  h.api.setGet(async () => ({
    data: {
      ok: true,
      activity: {
        claimEligibility: { available: true, reason: '', stories: [], dogClaimable: false, compensationCount: 0, seedsClaimable: false },
        operateState: { remainingCount: 1, activityDay: 2, pending: null },
      },
    },
  }));
  const result = await h.store.runClaimAll('acc-1');
  assert.equal(h.api.calls.post.length, 0, '无奖励时零写请求');
  assert.equal(result.ok, true);
  assert.equal(result.successCount, 0);
  // 快照可用但无可领：祈愿无待领 + 快乐值无档位（bear 各分类为空不产生条目）
  assert.deepEqual(h.store.claimAllResults.map(item => item.status), ['skipped', 'skipped']);
});

test('runner 零写（读取失败/状态缺失）：本轮读取失败的活动显式跳过、不试写；资格未知同样零写', async () => {
  const h = storeHarness();
  h.api.setGet(async (url) => {
    if (url.includes('bear') || url.includes('happy-share'))
      return { data: { ok: false, error: '账号未运行' } }; // 本轮读取失败：显式跳过
    return { data: { ok: true, activity: { operateState: wishPendingState } } };
  });
  h.api.setPost(async (url, body) => (url.includes('pet-diary') ? petOkPost(url, body) : wishOkPost(url, body)));
  const result = await h.store.runClaimAll('acc-1');
  assert.equal(result.ok, true);
  const byKey = Object.fromEntries(h.store.claimAllResults.map(item => [item.key, item]));
  assert.equal(byKey.bear.status, 'skipped');
  assert.match(byKey.bear.detail, /活动状态读取失败/);
  assert.match(byKey.bear.detail, /账号未运行/);
  assert.equal(byKey.share.status, 'skipped');
  assert.match(byKey.share.detail, /活动状态读取失败/);
  assert.equal(byKey['wish:claim'].status, 'success');
  assert.ok(h.api.calls.post.every(call => call.url.includes('season-wish')), '读取失败的活动不得发对应写请求');

  // 资格对象缺失（服务端快照无 claimEligibility）同样跳过不试写
  const h2 = storeHarness();
  h2.api.setPost(async (url, body) => (url.includes('pet-diary') ? petOkPost(url, body) : wishOkPost(url, body)));
  h2.api.setGet(async url => (url.includes('bear')
    ? { data: { ok: true, activity: {} } }
    : { data: { ok: true, activity: { operateState: wishPendingState } } }));
  await h2.store.runClaimAll('acc-1');
  const bearSkip = h2.store.claimAllResults.find(item => item.key === 'bear');
  assert.equal(bearSkip.status, 'skipped');
  assert.match(bearSkip.detail, /缺少实时领取资格/);
  assert.ok(h2.api.calls.post.every(call => call.url.includes('season-wish')), '萌宠资格未知时不得发萌宠写请求');
});

test('runner 失败分类：400+写前业务码跳过；400 无 code、写后 REPLY_MISMATCH、网络失败均记失败不重试', async () => {
  const h = storeHarness();
  const eligibility = { ...fullEligibility, stories: [], dogClaimable: true };
  let shareState = shareBeforeDaily;
  h.api.setGet(async (url) => {
    if (url.includes('happy-share'))
      return { data: { ok: true, activity: { operateState: shareState } } };
    if (url.includes('wish'))
      return { data: { ok: true, activity: { operateState: wishPendingState } } };
    return { data: { ok: true, activity: { claimEligibility: eligibility } } };
  });
  h.api.setPost(async (url, body) => {
    if (body.action === 'seeds') {
      throw new Error('Network timeout'); // 无 response：结果未知
    }
    if (body.action === 'compensation') {
      const err = new Error('活动响应不匹配，请刷新后查看结果');
      err.response = { status: 400, data: { ok: false, error: err.message, code: 'PET_DIARY_REPLY_MISMATCH' } };
      throw err; // 写后响应不匹配：可能已写入，不得按“未写入跳过”
    }
    if (body.action === 'claimDog') {
      const err = new Error('请求失败');
      // 400 带白名单之外的未知业务 code：不得声称“未写入”而跳过，一律按结果未知记失败
      err.response = { status: 400, data: { ok: false, error: '请求失败', code: 'PET_DIARY_NEW_CHECK' } };
      throw err;
    }
    if (body.action === 'wishClaim') {
      const err = new Error('没有与所选签文匹配的待领奖励');
      err.response = { status: 400, data: { ok: false, error: err.message, code: 'WISH_SIGN_NO_PENDING' } };
      throw err; // 写前资格校验业务码：未发生写，按跳过归因
    }
    if (body.action === 'shareDaily')
      shareState = shareAfterDaily;
    return url.includes('pet-diary') ? petOkPost(url, body) : wishOkPost(url, body);
  });
  const result = await h.store.runClaimAll('acc-1');

  const actions = h.api.calls.post.map(call => call.body.action);
  assert.deepEqual(actions, ['seeds', 'compensation', 'claimDog', 'wishClaim', 'shareDaily', 'shareMilestones']);
  assert.equal(result.ok, false, '存在失败项时不得报全成功');
  assert.equal(result.failedCount, 3);
  assert.equal(result.successCount, 2);
  assert.equal(result.skippedCount, 1);
  const byKey = Object.fromEntries(h.store.claimAllResults.map(item => [item.key, item]));
  assert.equal(byKey['bear:seeds'].status, 'failed');
  assert.match(byKey['bear:seeds'].detail, /不自动重试/);
  assert.equal(byKey['bear:compensation'].status, 'failed', '写后 REPLY_MISMATCH 不得按跳过归因');
  assert.match(byKey['bear:compensation'].detail, /不自动重试/);
  assert.equal(byKey['bear:claimDog'].status, 'failed', '400 带未知业务 code 不得按跳过归因');
  assert.ok(!byKey['bear:claimDog'].detail.includes('未写入'), '未知 code 不得声称未写入');
  assert.equal(byKey['wish:claim'].status, 'skipped');
  assert.match(byKey['wish:claim'].detail, /服务端资格校验未通过（未写入）/);
  assert.equal(byKey['share:milestones'].status, 'success');
  // 失败项没有被自动重试（各项只出现一次）
  for (const action of ['seeds', 'compensation', 'claimDog'])
    assert.equal(actions.filter(item => item === action).length, 1);
});

test('runner 快乐值：每日领取后刷新失败不以旧 state 继续档位（显式跳过），其余活动照常', async () => {
  const h = storeHarness();
  let shareReads = 0;
  h.api.setGet(async (url) => {
    if (url.includes('happy-share')) {
      shareReads += 1;
      // 首读（本轮资格）成功；每日领取后的依赖刷新失败 → 档位不以旧状态继续
      return shareReads <= 1
        ? { data: { ok: true, activity: { operateState: shareBeforeDaily } } }
        : { data: { ok: false, error: ' upstream 超时' } };
    }
    if (url.includes('bear'))
      return { data: { ok: true, activity: { claimEligibility: { ...fullEligibility, stories: [], dogClaimable: false, compensationCount: 0 } } } };
    return { data: { ok: true, activity: {} } };
  });
  h.api.setPost(async (url, body) => (url.includes('pet-diary') ? petOkPost(url, body) : wishOkPost(url, body)));
  const result = await h.store.runClaimAll('acc-1');

  const actions = h.api.calls.post.map(call => call.body.action);
  assert.deepEqual(actions, ['seeds', 'shareDaily'], '每日领取已写入；刷新失败不得再试写档位');
  const byKey = Object.fromEntries(h.store.claimAllResults.map(item => [item.key, item]));
  assert.equal(byKey['bear:seeds'].status, 'success', '独立活动照常执行');
  assert.equal(byKey['share:daily'].status, 'success');
  assert.equal(byKey['share:milestones'].status, 'skipped');
  assert.match(byKey['share:milestones'].detail, /状态刷新失败/);
  assert.match(byKey['share:milestones'].detail, /不以旧状态继续/);
  assert.match(byKey['share:milestones'].detail, /不自动重试/);
  assert.equal(result.failedCount, 0);
});

test('runner 互斥：进行中拒绝二次一键与单项操作；单项进行中拒绝一键', async () => {
  const h = storeHarness();
  h.api.setGet(async url => (url.includes('bear')
    ? { data: { ok: true, activity: { claimEligibility: fullEligibility } } }
    : { data: { ok: true, activity: {} } }));
  const gate = deferred();
  h.api.setPost(async () => gate.promise);
  const running = h.store.runClaimAll('acc-1');
  await waitFor(() => h.api.calls.post.length === 1, '第一项写请求发出');
  assert.equal(h.store.claimAllRunning, true);
  // 二次一键与单项手动都被 busy 拒绝且不产生新请求
  const again = await h.store.runClaimAll('acc-1');
  assert.equal(again.ok, false);
  assert.match(again.error, /操作进行中/);
  const single = await h.store.operateBearPet('acc-1', 'seeds');
  assert.equal(single.ok, false);
  assert.match(single.error, /操作进行中/);
  const singleWish = await h.store.operateSeasonWish('acc-1', 'shareDaily');
  assert.equal(singleWish.ok, false);
  assert.equal(h.api.calls.post.length, 1);
  gate.resolve({ data: { ok: true, rewards: [] } });
  await running;
  // 结束后单项操作恢复可用
  h.api.setPost(async (url, body) => (url.includes('pet-diary') ? petOkPost(url, body) : wishOkPost(url, body)));
  const resumed = await h.store.operateBearPet('acc-1', 'seeds');
  assert.equal(resumed.ok, true);
});

test('runner 账号切换：clearActivityData 取消后续请求，旧响应/finally 不污染新账号', async () => {
  const h = storeHarness();
  h.api.setGet(async url => (url.includes('bear')
    ? { data: { ok: true, activity: { claimEligibility: fullEligibility } } }
    : { data: { ok: true, activity: {} } }));
  const gate = deferred();
  h.api.setPost(async () => gate.promise);
  const running = h.store.runClaimAll('acc-1');
  await waitFor(() => h.api.calls.post.length === 1, '第一项写请求发出');
  const getsBeforeCancel = h.api.calls.get.length;
  // 切换账号：取消 + 清旧账号结果
  h.accountState.currentAccountId = 'acc-2';
  h.store.clearActivityData();
  assert.equal(h.store.claimAllRunning, false);
  assert.equal(h.store.claimAllResults.length, 0);
  gate.resolve({ data: { ok: true, rewards: [{ itemName: '烟花桶', itemCount: 9 }] } });
  const result = await running;
  await flush();
  assert.equal(result.ok, false);
  assert.equal(h.api.calls.post.length, 1, '取消后不再发出后续写请求');
  assert.equal(h.api.calls.get.length, getsBeforeCancel, '取消后不再发出刷新读请求');
  assert.deepEqual(h.store.claimAllResults, [], '旧账号成功响应不得回填到新账号结果');
});

test('runner 收尾刷新失败：已领结果保留并追加提示（fetch 全部 fulfilled、靠 ok:false 识别）', async () => {
  const h = storeHarness();
  let bearReads = 0;
  h.api.setGet(async (url) => {
    if (url.includes('bear')) {
      bearReads += 1;
      // 首读（本轮资格）成功；收尾刷新失败（fetch 捕获后 fulfilled + ok:false）
      return bearReads <= 1
        ? { data: { ok: true, activity: { claimEligibility: { ...fullEligibility, stories: [], dogClaimable: false, compensationCount: 0 } } } }
        : { data: { ok: false, error: '账号未运行' } };
    }
    return { data: { ok: true, activity: {} } };
  });
  h.api.setPost(async (url, body) => petOkPost(url, body));
  const result = await h.store.runClaimAll('acc-1');
  assert.equal(result.successCount, 1);
  const refreshItem = h.store.claimAllResults.find(item => item.key === 'refresh');
  assert.equal(refreshItem.status, 'skipped');
  assert.match(refreshItem.detail, /刷新失败/);
  assert.equal(h.store.claimAllResults.find(item => item.key === 'bear:seeds').status, 'success');
});

test('runner 意外异常：整体收口释放 busy、保留已产生结果并记失败项', async () => {
  const h = storeHarness();
  h.api.setGet(async () => ({ data: { ok: false, error: '读取失败' } }));
  h.api.setPost(async (url, body) => petOkPost(url, body));
  // 让账号状态读取在中途开始抛错（如渲染层异常）：runner 必须整体收口而不是卡死 busy
  let accountReads = 0;
  Object.defineProperty(h.accountState, 'currentAccountId', {
    configurable: true,
    get() {
      accountReads += 1;
      if (accountReads > 4)
        throw new Error('renderer boom');
      return 'acc-1';
    },
  });
  const result = await h.store.runClaimAll('acc-1');
  assert.equal(result.ok, false);
  assert.equal(result.failedCount >= 1, true, '意外异常要留失败项');
  assert.match(h.store.claimAllResults.map(item => item.detail).join('\n'), /本轮已中止并释放/);
  assert.equal(h.store.claimAllRunning, false, '意外异常不得让 busy 卡死');
  assert.equal(h.store.claimAllStep, '');
});

test('单项操作旧 finally 代次：切账号后旧 response 不清新轮 busy，新轮结束才释放', async () => {
  const h = storeHarness();
  h.api.setGet(async () => ({ data: { ok: true, activity: {} } }));
  const gates = [deferred(), deferred()];
  let postCount = 0;
  h.api.setPost(async () => gates[postCount++].promise);
  const op1 = h.store.operateBearPet('acc-1', 'seeds');
  await waitFor(() => postCount === 1, '旧账号单项在飞');
  assert.equal(h.store.bearOperating, 'seeds');
  // 账号切换：作废旧代次；新账号立即开新一轮单项
  h.accountState.currentAccountId = 'acc-2';
  h.store.clearActivityData();
  assert.equal(h.store.bearOperating, '');
  const op2 = h.store.operateBearPet('acc-2', 'compensation');
  await waitFor(() => postCount === 2, '新账号单项在飞');
  assert.equal(h.store.bearOperating, 'compensation');
  // 旧 response 迟到返回：其 finally 不得清掉新轮 busy
  gates[0].resolve({ data: { ok: true, rewards: [] } });
  await flush();
  assert.equal(h.store.bearOperating, 'compensation', '旧 finally 不得释放新轮 busy');
  const rejected = await h.store.operateBearPet('acc-2', 'seeds');
  assert.equal(rejected.ok, false, '新轮在飞时仍应互斥');
  gates[1].resolve({ data: { ok: true, rewards: [] } });
  await Promise.all([op1, op2]);
  await flush();
  assert.equal(h.store.bearOperating, '', '新轮结束后正常释放');
});

// ---------- 真实组件：ClaimAllPanel 渲染/点击/禁用 ----------
const ClaimAllPanel = compileSfcModule(path.join(WEB, 'src/components/activity/ClaimAllPanel.vue'), spec =>
  spec === 'vue' || spec === 'vue-router' ? (spec === 'vue' ? vue : vueRouter) : undefined);

function mountPanel(props) {
  const root = makeNode('root');
  const events = [];
  render(vue.h(ClaimAllPanel, { ...props, onClaim: () => events.push(['claim']) }), root);
  return { root, events };
}

test('ClaimAllPanel 真实渲染：点击触发 claim；running/disabled/单项操作中禁用；结果逐项展示', async () => {
  const normal = mountPanel({ running: false, disabled: false, step: '', results: [], hasOperating: false });
  const button = buttonsOf(normal.root).find(node => textOf(node).includes('一键领取'));
  assert.ok(button, '应渲染一键领取按钮');
  click(button);
  assert.deepEqual(normal.events, [['claim']]);

  for (const busy of [
    { running: true, disabled: false, step: 'S3 种子礼包', hasOperating: false },
    { running: false, disabled: true, step: '', hasOperating: false },
    { running: false, disabled: false, step: '', hasOperating: true },
  ]) {
    const state = mountPanel({ ...busy, results: [] });
    const busyButton = buttonsOf(state.root).find(node => textOf(node).includes('一键领取'));
    assert.equal(busyButton.props.disabled, true);
    click(busyButton);
    assert.deepEqual(state.events, [], '禁用态点击不得触发');
  }
  // 运行中展示当前步骤
  const stepping = mountPanel({ running: true, disabled: false, step: '快乐值每日领取', results: [], hasOperating: false });
  assert.match(textOf(stepping.root), /快乐值每日领取…/);

  const withResults = mountPanel({
    running: false, disabled: false, step: '',
    hasOperating: false,
    results: [
      { key: 'a', label: 'S3 种子礼包', status: 'success', detail: '获得 道具×3' },
      { key: 'b', label: '秋祈良愿待领签文', status: 'failed', detail: 'Network timeout（结果未知，不自动重试，请稍后刷新确认）' },
      { key: 'c', label: '快乐值档位奖励', status: 'skipped', detail: '当前没有可领取的快乐值档位' },
    ],
  });
  const text = textOf(withResults.root);
  assert.match(text, /成功 1 · 失败 1 · 跳过 1/);
  assert.match(text, /S3 种子礼包/);
  assert.match(text, /获得 道具×3/);
  assert.match(text, /不自动重试/);
  assert.doesNotMatch(text, /undefined|NaN/);
});

// ---------- 真实组件：Activity.vue 按钮点击 → store 编排 → 结果渲染 ----------
// 面板可安全渲染的最小活动快照（真实面板组件会读取这些展示字段）
function panelSafeActivity(extra = {}) {
  const emptyGuides = [];
  return {
    activityId: 1, title: '活动', startTime: 0, endTime: 0, visible: true, enabled: true, status: 20,
    statusLabel: '已启用', uid: '', uidConfirmed: false, clientUiUid: '', readOnly: true,
    inventoryAvailable: false, gameplayGuides: emptyGuides, notices: [], conflicts: [], resources: [],
    exchangeShop: [], records: [], recordStateAvailable: false, subActivities: [], ruleSections: [],
    missingEvidence: [], protocol: { declaredReadOnlyFields: [], opaqueReadOnlyFields: [] },
    ...extra,
  };
}

// Activity.vue 页面挂载：真实 store + 真实路由组件树 + 模拟 api（返回 accountRef 供切换账号）
function mountActivityPage(api) {
  const toastLog = [];
  const testPinia = pinia.createPinia();
  pinia.setActivePinia(testPinia);
  const accountRef = vue.ref('acc-1');
  const useAccountStore = pinia.defineStore('account', () => ({
    currentAccountId: accountRef,
    currentAccount: vue.ref({ name: '账号A' }),
  }));
  const useEvolutionStore = pinia.defineStore('evolution', () => ({
    evolve: vue.ref(null),
    loadStatus: async () => {},
    startPolling: () => {},
    stopPolling: () => {},
  }));
  const stubComponent = { render: () => null };
  const resolve = (spec) => {
    if (spec === 'vue')
      return vue;
    if (spec === 'vue-router')
      return vueRouter;
    if (spec === 'pinia')
      return pinia;
    if (spec === '@/api')
      return { __esModule: true, default: api.instance };
    if (spec === '@/stores/account')
      return { useAccountStore };
    if (spec === '@/stores/evolution')
      return { useEvolutionStore };
    if (spec === '@/stores/toast')
      return { useToastStore: () => ({ success: (...args) => toastLog.push(['success', ...args]), error: (...args) => toastLog.push(['error', ...args]) }) };
    if (spec === '@/stores/user')
      return { useUserStore: () => ({ isAdmin: false }) };
    if (spec === '@/components/admin/AdminActivityUpdatePanel.vue' || spec === '@/components/admin/EvolutionAgentSettings.vue')
      return stubComponent;
    return undefined; // 其余 @/ 走真实文件
  };
  const Activity = compileSfcModule(path.join(WEB, 'src/views/Activity.vue'), resolve);
  const root = makeNode('root');
  render(vue.h(Activity), root);
  return { root, toastLog, accountRef };
}

test('Activity.vue 集成：真实按钮点击走 store 编排，写请求按序发出、结果渲染进页面', async () => {
  const api = apiMock();
  let shareState = shareBeforeDaily;
  api.setGet(async (url) => {
    if (url.includes('happy-share'))
      return { data: { ok: true, activity: panelSafeActivity({ operateState: shareState }) } };
    if (url.includes('wish'))
      return { data: { ok: true, activity: panelSafeActivity({ operateState: wishPendingState }) } };
    return { data: { ok: true, activity: panelSafeActivity({ claimEligibility: fullEligibility }) } };
  });
  api.setPost(async (url, body) => {
    if (body.action === 'shareDaily')
      shareState = shareAfterDaily;
    return url.includes('pet-diary') ? petOkPost(url, body) : wishOkPost(url, body);
  });

  const { root, toastLog } = mountActivityPage(api);
  await waitFor(() => api.calls.get.length >= 3, '页面初始读取三组活动');

  const button = buttonsOf(root).find(node => textOf(node).trim() === '一键领取');
  assert.ok(button, '活动中心应渲染一键领取按钮');
  click(button);
  await waitFor(() => api.calls.post.length === 8, '八项写请求按序完成');
  await waitFor(() => textOf(root).includes('成功 8'), '结果渲染进页面');

  assert.deepEqual(api.calls.post.map(call => call.body.action), [
    'seeds', 'compensation', 'claimDog', 'story', 'story', 'wishClaim', 'shareDaily', 'shareMilestones',
  ]);
  assert.ok(api.calls.post.every(call => call.accountId === 'acc-1'));
  assert.ok(textOf(root).includes('失败 0'));
  assert.ok(toastLog.some(([kind, message]) => kind === 'success' && String(message).includes('成功 8')), '完成提示不得早于编排结束');
  assert.doesNotMatch(textOf(root), /undefined|NaN/);
});

test('Activity.vue 集成（部分失败）：真实点击→store→请求，失败/跳过/成功逐项渲染、错误提示不虚报', async () => {
  const api = apiMock();
  let shareState = shareBeforeDaily;
  api.setGet(async (url) => {
    if (url.includes('happy-share'))
      return { data: { ok: true, activity: panelSafeActivity({ operateState: shareState }) } };
    if (url.includes('wish'))
      return { data: { ok: true, activity: panelSafeActivity({ operateState: wishPendingState }) } };
    return { data: { ok: true, activity: panelSafeActivity({ claimEligibility: { ...fullEligibility, stories: [], dogClaimable: false } }) } };
  });
  api.setPost(async (url, body) => {
    if (body.action === 'seeds') {
      throw new Error('Network timeout'); // 结果未知 → 失败
    }
    if (body.action === 'compensation') {
      const err = new Error('活动响应不匹配，请刷新后查看结果');
      err.response = { status: 400, data: { ok: false, error: err.message, code: 'PET_DIARY_REPLY_MISMATCH' } };
      throw err; // 写后不匹配 → 失败
    }
    if (body.action === 'wishClaim') {
      const err = new Error('没有与所选签文匹配的待领奖励');
      err.response = { status: 400, data: { ok: false, error: err.message, code: 'WISH_SIGN_NO_PENDING' } };
      throw err; // 写前资格校验 → 跳过
    }
    if (body.action === 'shareDaily')
      shareState = shareAfterDaily;
    return url.includes('pet-diary') ? petOkPost(url, body) : wishOkPost(url, body);
  });

  const { root, toastLog } = mountActivityPage(api);
  await waitFor(() => api.calls.get.length >= 3, '页面初始读取三组活动');
  click(buttonsOf(root).find(node => textOf(node).trim() === '一键领取'));
  await waitFor(() => textOf(root).includes('成功 2'), '成功计数渲染');
  await waitFor(() => textOf(root).includes('失败 2'), '失败计数渲染');

  const text = textOf(root);
  assert.ok(text.includes('跳过 1'));
  assert.match(text, /Network timeout/);
  assert.match(text, /服务端资格校验未通过（未写入）/);
  assert.match(text, /活动响应不匹配/);
  assert.match(text, /不自动重试/);
  // 失败存在：完成提示走错误通道且不宣称全部成功
  assert.ok(toastLog.some(([kind]) => kind === 'error'), '存在失败项时走错误提示');
  assert.ok(!toastLog.some(([, message]) => String(message).includes('失败 0')));
  assert.doesNotMatch(text, /undefined|NaN/);
});

test('Activity.vue 集成（取消）：运行中切换账号即取消，停止后续请求、旧结果不展示、不弹旧任务提示', async () => {
  const api = apiMock();
  api.setGet(async (url) => {
    if (url.includes('wish'))
      return { data: { ok: true, activity: panelSafeActivity({ operateState: wishPendingState }) } };
    return { data: { ok: true, activity: panelSafeActivity({ claimEligibility: fullEligibility }) } };
  });
  const gate = deferred();
  api.setPost(async () => gate.promise);
  const { root, accountRef, toastLog } = mountActivityPage(api);
  await waitFor(() => api.calls.get.length >= 3, '页面初始读取三组活动');
  click(buttonsOf(root).find(node => textOf(node).trim() === '一键领取'));
  await waitFor(() => api.calls.post.length === 1, '第一项写请求发出');
  const postsBeforeCancel = api.calls.post.length;
  // 切换账号：watch → clearActivityData → cancelClaimAll（新账号重新读取但不发写）
  accountRef.value = 'acc-2';
  await waitFor(() => api.calls.get.some(call => call.accountId === 'acc-2'), '切换账号触发重新读取');
  gate.resolve({ data: { ok: true, rewards: [{ itemName: '烟花桶', itemCount: 9 }] } });
  await flush();
  await flush();
  assert.equal(api.calls.post.length, postsBeforeCancel, '取消后不再发出后续写请求');
  assert.ok(!textOf(root).includes('烟花桶×9'), '旧账号成功响应不得渲染给新账号');
  assert.deepEqual(toastLog, [], '取消后的旧任务结果不得弹提示（切账号页静默）');
  assert.doesNotMatch(textOf(root), /undefined|NaN/);
});

test('Activity.vue 集成（卸载）：onBeforeUnmount 取消后旧响应不弹结果提示', async () => {
  const api = apiMock();
  api.setGet(async () => ({ data: { ok: true, activity: panelSafeActivity({ claimEligibility: fullEligibility }) } }));
  const gate = deferred();
  api.setPost(async () => gate.promise);
  const { root, toastLog } = mountActivityPage(api);
  await waitFor(() => api.calls.get.length >= 3, '页面初始读取三组活动');
  click(buttonsOf(root).find(node => textOf(node).trim() === '一键领取'));
  await waitFor(() => api.calls.post.length === 1, '第一项写请求发出');
  // 页面卸载：cancelClaimAll + 组件失活守卫
  render(null, root);
  gate.resolve({ data: { ok: true, rewards: [{ itemName: '烟花桶', itemCount: 9 }] } });
  await flush();
  await flush();
  assert.deepEqual(toastLog, [], '卸载后旧任务结果不得弹提示');
});
