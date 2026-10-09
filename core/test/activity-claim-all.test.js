'use strict';
// 一键领取回归：真实行为测试（模拟网络/时钟，零真实游戏请求）。
// 三层：
//  1) 服务端资格汇总 summarizeBearClaimEligibility + getBearActivity 接线（真实 proto 编解码）
//  2) 真实 store（web/src/stores/activity.ts 编译加载）runner 编排：串行、部分失败、
//     账号切换取消、互斥、快乐值每日→新档位、无资格零写、禁止动作白名单；
//     活动下架门控的新增能力（下架状态/到期计时/显式重新检查/卸载作废）也登记在本文件
//     （非反证文件：activity-availability.test.js 只经旧入口观察旧代码反例）
//  3) 真实组件渲染点击：ClaimAllPanel 与 Activity.vue（内置真实 store + 模拟 api）
// 只复用既有依赖（vue / compiler-sfc / typescript / pinia / vue-router），不新增依赖。
// 业务模块加载前设置独立 FARM_DATA_DIR；夹具写目标先解析校验边界，越界在原语前拒绝。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

// ===== 夹具创建与写边界（先解析校验，任何越界在写入原语前拒绝）=====
const repoRoot = path.resolve(__dirname, '..', '..');
const repoRootReal = fs.realpathSync(repoRoot);
function isInsideOrEqualDir(candidate, base) {
  const c = path.resolve(String(candidate));
  const b = path.resolve(String(base));
  return c === b || c.startsWith(b + path.sep);
}
const tempRoot = fs.realpathSync(path.resolve(os.tmpdir()));
assert.equal(isInsideOrEqualDir(tempRoot, repoRootReal), false, '临时根不得指向仓库');
const privateDir = path.resolve(fs.mkdtempSync(path.join(tempRoot, 'farm-activity-claim-all-')));
assert.equal(isInsideOrEqualDir(privateDir, tempRoot), true, '独立运行数据目录必须落在临时根内');
process.env.FARM_DATA_DIR = privateDir; // 先于任何业务模块加载
function assertWriteInsidePrivateDir(target) {
  const resolved = path.resolve(String(target));
  if (!isInsideOrEqualDir(resolved, privateDir))
    throw new Error(`夹具写目标越界（已在写入原语前拒绝）: ${resolved}`);
  return resolved;
}

// 候选源码指纹：全部用例（含失败路径）结束后内容与权限不得被夹具改变
const CANDIDATE_SOURCES = [
  path.join(repoRoot, 'web', 'src', 'stores', 'activity.ts'),
  path.join(repoRoot, 'web', 'src', 'views', 'Activity.vue'),
  path.join(repoRoot, 'web', 'src', 'components', 'activity', 'SeasonRuleActivityPanel.vue'),
  path.join(repoRoot, 'web', 'src', 'components', 'admin', 'AdminActivityUpdatePanel.vue'),
];
function fingerprintOf(file) {
  const stat = fs.statSync(file);
  return {
    mode: stat.mode,
    size: stat.size,
    sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
  };
}
const fingerprintsBefore = new Map(CANDIDATE_SOURCES.map(file => [file, fingerprintOf(file)]));

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
async function openActivityManagement(root) {
  const toggle = buttonsOf(root).find(node => textOf(node).trim() === '活动管理');
  assert.ok(toggle, '确认下架后提供收起的活动管理入口');
  if (toggle.props['aria-expanded'] !== true)
    click(toggle);
  await flush();
  assert.ok(buttonsOf(root).some(node => textOf(node).includes('重新检查')), '仅展开后提供重新检查');
}
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

// ===== 整套收尾（成功与失败路径都执行）：卸载仍挂载的页面、释放 store 到期计时、
// 最终复核候选源码内容与权限、删除隔离运行数据目录 =====
const livePageRoots = [];
const liveStores = [];
test.after(() => {
  try {
    while (livePageRoots.length) {
      const root = livePageRoots.pop();
      try {
        render(null, root); // 页面卸载触发 onBeforeUnmount：作废在飞读取并释放到期计时
      }
      catch { /* 尽力卸载，失败不得掩盖后续指纹复核 */ }
    }
    for (const store of liveStores.splice(0)) {
      try {
        if (typeof store.cancelClaimAll === 'function')
          store.cancelClaimAll();
        if (typeof store.cancelActivityReads === 'function')
          store.cancelActivityReads(); // 页外 store（storeHarness）的到期计时统一释放
      }
      catch { /* 同上 */ }
    }
    for (const [file, before] of fingerprintsBefore)
      assert.deepEqual(fingerprintOf(file), before, `候选源码不得被夹具改变（套件收尾最终复核）: ${path.basename(file)}`);
  }
  finally {
    fs.rmSync(privateDir, { recursive: true, force: true });
  }
});

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
  liveStores.push(store); // 套件收尾统一释放到期计时（含用例失败路径）
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

// Activity.vue 页面挂载：真实 store + 真实路由组件树 + 模拟 api（返回 accountRef 供切换账号；
// sharedPinia 供跨卸载复用同一 store；useActivityStore 供用例直接取同一 store 实例）
function mountActivityPage(api, sharedPinia) {
  const toastLog = [];
  const testPinia = sharedPinia || pinia.createPinia();
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
  const activityStoreModule = evaluateModule(
    fs.readFileSync(path.join(WEB, 'src/stores/activity.ts'), 'utf8'), (spec) => {
      if (spec === 'vue')
        return vue;
      if (spec === 'pinia')
        return pinia;
      if (spec === '@/api')
        return { __esModule: true, default: api.instance };
      if (spec === '@/stores/account')
        return { useAccountStore };
      return undefined;
    },
  );
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
    if (spec === '@/stores/activity')
      return activityStoreModule;
    if (spec === '@/components/admin/AdminActivityUpdatePanel.vue' || spec === '@/components/admin/EvolutionAgentSettings.vue')
      return stubComponent;
    return undefined; // 其余 @/ 走真实文件
  };
  const Activity = compileSfcModule(path.join(WEB, 'src/views/Activity.vue'), resolve);
  const root = makeNode('root');
  livePageRoots.push(root); // 套件收尾统一卸载（含用例失败路径），卸载即释放该页在飞读取与计时
  render(vue.h(Activity), root);
  return { root, toastLog, accountRef, pinia: testPinia, useActivityStore: activityStoreModule.useActivityStore };
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

// ===== 活动下架门控：新增能力与生命周期验收（非反证区，可引用新增导出）=====

const wishGets = api => api.calls.get.filter(call => call.url.includes('wish')).length;

// 写原语计数：证明越界目标在任何 mkdir/写/删/改权限原语「之前」被守卫拒绝（零创建零写入），
// 且合法目标经守卫后原语正常执行（计数器能观测真实写入，合法路径可用）
function withWritePrimitiveCounters(fn) {
  const tracked = ['mkdirSync', 'writeFileSync', 'appendFileSync', 'rmSync', 'chmodSync', 'symlinkSync'];
  const counts = Object.fromEntries(tracked.map(name => [name, 0]));
  const originals = tracked.map(name => [name, fs[name]]);
  for (const [name, original] of originals)
    fs[name] = (...args) => { counts[name] += 1; return original.apply(fs, args); };
  try {
    return { counts, value: fn() };
  }
  finally {
    for (const [name, original] of originals)
      fs[name] = original;
  }
}

test('夹具边界：越界写目标在任何写原语前拒绝（计数证明零创建零写入）；合法目标经守卫正常执行；候选源码内容与权限不变', () => {
  const escaped = path.join(privateDir, '..', 'farm-activity-claim-all-escape.json');
  const rejected = withWritePrimitiveCounters(() =>
    assert.throws(() => assertWriteInsidePrivateDir(escaped), /越界/));
  assert.deepEqual(rejected.counts, {
    mkdirSync: 0, writeFileSync: 0, appendFileSync: 0, rmSync: 0, chmodSync: 0, symlinkSync: 0,
  }, '越界拒绝必须发生在任何写原语之前（零创建零写入）');
  assert.equal(fs.existsSync(escaped), false, '被拒绝的目标不得被创建');
  assert.equal(fs.existsSync(path.resolve(privateDir, 'farm-activity-claim-all-escape.json')), false);
  // 合法目标：守卫放行且写原语被实际调用（证明计数器可观测真实写入、合法路径正常执行）
  const legal = path.join(privateDir, 'legal-guard-fixture.txt');
  const legalRun = withWritePrimitiveCounters(() =>
    fs.writeFileSync(assertWriteInsidePrivateDir(legal), 'legal'));
  assert.equal(legalRun.counts.writeFileSync, 1);
  assert.equal(fs.readFileSync(legal, 'utf8'), 'legal');
  for (const [file, before] of fingerprintsBefore) {
    assert.deepEqual(fingerprintOf(file), before, `候选源码不得被夹具改变: ${path.basename(file)}`);
  }
});

test('显式重新检查：有效未过期恢复展示；unavailable 保持下架；普通失败不改状态、不自动重试、零写', async () => {
  const h = storeHarness();
  const future = Math.floor(Date.now() / 1000) + 3600;
  // 先下架
  h.api.setGet(async url => (url.includes('wish')
    ? { data: { ok: false, unavailable: true, error: '活动未下发' } }
    : { data: { ok: true, activity: panelSafeActivity({}) } }));
  await h.store.fetchWishActivity('acc-1');
  assert.equal(h.store.activityRetired.wish?.reason, 'unavailable');
  // 重新检查 → 有效未过期：恢复
  h.api.setGet(async url => (url.includes('wish')
    ? { data: { ok: true, activity: panelSafeActivity({ endTime: future }) } }
    : { data: { ok: true, activity: panelSafeActivity({}) } }));
  const restored = await h.store.recheckActivity('wish', 'acc-1');
  assert.equal(restored?.ok, true);
  assert.equal(h.store.activityRetired.wish, null, '有效未过期响应应解除下架');
  assert.ok(h.store.wishActivity != null, '恢复后快照重新落地');
  assert.equal(wishGets(h.api), 2, '每次重新检查只读所选活动一次');
  // 再次下架后重新检查遇普通失败：状态不变、不自动重试
  h.api.setGet(async url => (url.includes('wish')
    ? { data: { ok: false, unavailable: true, error: '活动未下发' } }
    : { data: { ok: true, activity: panelSafeActivity({}) } }));
  await h.store.fetchWishActivity('acc-1');
  assert.equal(h.store.activityRetired.wish?.reason, 'unavailable');
  // 下架保持后，重新检查遇普通网络失败
  h.api.setGet(async url => (url.includes('wish')
    ? { data: { ok: false, error: '网络波动' } }
    : { data: { ok: true, activity: panelSafeActivity({}) } }));
  const failed = await h.store.recheckActivity('wish', 'acc-1');
  assert.equal(failed?.ok, false);
  assert.equal(failed?.retired, undefined, '普通失败不带下架标记');
  assert.equal(h.store.activityRetired.wish?.reason, 'unavailable', '普通失败不得解除下架');
  await flush();
  await flush();
  assert.equal(wishGets(h.api), 4, '重新检查失败后不自动重试（此前四次：下架/恢复/再下架/失败重查）');
  assert.equal(h.api.calls.post.length, 0, '重新检查零写请求');
});

test('到期计时：在飞的第二次读取不取消旧快照计时；迟到响应不得恢复已下架活动', async () => {
  const h = storeHarness();
  const nowSec = Math.floor(Date.now() / 1000);
  h.api.setGet(async url => (url.includes('wish')
    ? { data: { ok: true, activity: { endTime: nowSec + 1 } } }
    : { data: { ok: true, activity: {} } }));
  await h.store.fetchWishActivity('acc-1');
  assert.ok(h.store.wishActivity != null);
  assert.equal(h.store.activityRetired.wish, null);
  // 第二次读取在飞（不落地）：旧计时仍绑定已落地快照
  const gate = deferred();
  h.api.setGet(async () => gate.promise);
  const second = h.store.fetchWishActivity('acc-1');
  await new Promise(resolve => setTimeout(resolve, 1300)); // 越过 1 秒截止
  assert.equal(h.store.activityRetired.wish?.reason, 'expired', '在飞读取不取消旧快照的到期计时');
  assert.equal(h.store.wishActivity, null, '到期下架清快照');
  // 迟到的第二次读取返回有效未过期数据：不得恢复（乱序旧响应不得复活已结束活动）
  gate.resolve({ data: { ok: true, activity: { endTime: nowSec + 3600 } } });
  const lateResult = await second;
  assert.equal(lateResult?.retired, true, '迟到响应只带回下架标记');
  assert.equal(h.store.activityRetired.wish?.reason, 'expired');
  assert.equal(h.store.wishActivity, null);
  // 后续普通刷新零读取（到期下架与 unavailable 同门）
  await h.store.fetchWishActivity('acc-1');
  assert.equal(wishGets(h.api), 2);
});

test('到期计时：新快照落地重排计时，旧计时不误撤；无效/缺失截止不建计时、不周期探测', async () => {
  const h = storeHarness();
  const nowSec = Math.floor(Date.now() / 1000);
  // 第一份快照 ≤1 秒后到期；新快照落地（3 秒后到期）：旧计时必须被取消
  let wishReads = 0;
  h.api.setGet(async (url) => {
    if (!url.includes('wish'))
      return { data: { ok: true, activity: {} } };
    wishReads += 1;
    return { data: { ok: true, activity: { endTime: wishReads === 1 ? nowSec + 1 : nowSec + 3 } } };
  });
  await h.store.fetchWishActivity('acc-1');
  await h.store.fetchWishActivity('acc-1');
  await new Promise(resolve => setTimeout(resolve, 1200)); // 越过旧截止、未到新截止
  assert.equal(h.store.activityRetired.wish, null, '新快照落地后旧计时不得到点下架');
  await new Promise(resolve => setTimeout(resolve, 2200)); // 越过新截止
  assert.equal(h.store.activityRetired.wish?.reason, 'expired', '新快照自己的截止到点正常下架');

  // 无效/缺失 endTime：不猜测、不建计时、不周期探测
  for (const invalid of [0, -5, Number.NaN, undefined]) {
    const h2 = storeHarness();
    h2.api.setGet(async () => ({ data: { ok: true, activity: { endTime: invalid } } }));
    await h2.store.fetchWishActivity('acc-1');
    assert.ok(h2.store.wishActivity != null, `endTime=${String(invalid)} 快照正常落地`);
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.equal(h2.store.activityRetired.wish, null, `endTime=${String(invalid)} 不得凭空下架`);
    assert.equal(wishGets(h2.api), 1, `endTime=${String(invalid)} 不得周期探测`);
  }
});

test('进入页面清扫：已过有效截止的落地快照立即下架（零请求）；缺失截止不动', () => {
  const h = storeHarness();
  const nowSec = Math.floor(Date.now() / 1000);
  h.store.wishActivity = { endTime: nowSec - 10 };
  h.store.bearActivity = { endTime: nowSec + 100 };
  h.store.happyShareActivity = {};
  h.store.sweepExpiredActivities();
  assert.equal(h.store.activityRetired.wish?.reason, 'expired', '过期落地快照立即下架');
  assert.equal(h.store.wishActivity, null);
  assert.equal(h.store.activityRetired.bear, null, '未到期不动');
  assert.equal(h.store.activityRetired.happyShare, null, '缺失截止不猜测');
  assert.equal(h.api.calls.get.length, 0, '清扫零请求');
});

test('切账号清下架状态与到期计时：旧计时不得在切账号后触发', async () => {
  const h = storeHarness();
  const nowSec = Math.floor(Date.now() / 1000);
  h.api.setGet(async () => ({ data: { ok: true, activity: { endTime: nowSec + 1 } } }));
  await h.store.fetchWishActivity('acc-1');
  h.accountState.currentAccountId = 'acc-2';
  h.store.clearActivityData();
  await new Promise(resolve => setTimeout(resolve, 1300));
  assert.equal(h.store.activityRetired.wish, null, '旧计时随切账号清除，不得在新账号触发');
  await h.store.fetchWishActivity('acc-2');
  assert.equal(wishGets(h.api), 2, '新账号恢复读取');
});

test('三活动并发读取互不作废：wish 下架不影响 bear/share 落地与 loading 清理', async () => {
  const h = storeHarness();
  const future = Math.floor(Date.now() / 1000) + 3600;
  const gates = { bear: deferred(), wish: deferred(), share: deferred() };
  h.api.setGet(async (url) => {
    if (url.includes('bear'))
      return gates.bear.promise;
    if (url.includes('happy-share'))
      return gates.share.promise;
    return gates.wish.promise;
  });
  const runs = Promise.all([
    h.store.fetchBearActivity('acc-1'),
    h.store.fetchWishActivity('acc-1'),
    h.store.fetchHappyShareActivity('acc-1'),
  ]);
  await waitFor(() => h.api.calls.get.length === 3, '三组并发读取发出');
  gates.share.resolve({ data: { ok: true, activity: panelSafeActivity({ endTime: future }) } });
  gates.bear.resolve({ data: { ok: true, activity: panelSafeActivity({ endTime: future }) } });
  await flush();
  gates.wish.resolve({ data: { ok: false, unavailable: true, error: '活动未下发' } });
  await runs;
  assert.equal(h.store.activityRetired.wish?.reason, 'unavailable');
  assert.ok(h.store.bearActivity != null, 'bear 正常落地');
  assert.ok(h.store.happyShareActivity != null, 'share 正常落地');
  assert.equal(h.store.bearLoading, false, '并发下架不卡死别家 loading');
  assert.equal(h.store.happyShareLoading, false);
  assert.equal(h.store.wishLoading, false);
});

test('runner 运行期间到期：未发出的写步骤停止，已发出请求的结果据实保留', async () => {
  const h = storeHarness();
  const nowSec = Math.floor(Date.now() / 1000);
  h.api.setGet(async (url) => {
    if (url.includes('bear'))
      return { data: { ok: true, activity: { claimEligibility: fullEligibility, endTime: nowSec + 1 } } };
    return { data: { ok: true, activity: {} } };
  });
  const gate = deferred();
  h.api.setPost(async () => gate.promise);
  const running = h.store.runClaimAll('acc-1');
  await waitFor(() => h.api.calls.post.length === 1, '首项写请求发出');
  await new Promise(resolve => setTimeout(resolve, 1300)); // 运行期间到期：快照计时触发下架
  gate.resolve({ data: { ok: true, rewards: [{ itemName: '种子', itemCount: 1 }] } });
  const result = await running;
  assert.deepEqual(h.api.calls.post.map(call => call.body.action), ['seeds'], '到期后剩余领取项不得再发写请求');
  const byKey = Object.fromEntries(h.store.claimAllResults.map(item => [item.key, item]));
  assert.equal(byKey['bear:seeds'].status, 'success', '已发出请求的结果据实保留');
  assert.equal(byKey.bear.status, 'skipped');
  assert.match(byKey.bear.detail, /运行期间活动已到期/);
  assert.equal(result.ok, true);
});

test('runner 快乐不独享：每日领取成功后依赖刷新返回下架 → 保留每日成功、零档位写、收尾不补读', async () => {
  const h = storeHarness();
  let shareReads = 0;
  h.api.setGet(async (url) => {
    if (url.includes('happy-share')) {
      shareReads += 1;
      // 首读（本轮资格）成功；每日领取后的依赖刷新确认活动已下架
      return shareReads <= 1
        ? { data: { ok: true, activity: { operateState: shareBeforeDaily } } }
        : { data: { ok: false, unavailable: true, error: '活动未下发' } };
    }
    return { data: { ok: true, activity: {} } };
  });
  h.api.setPost(async (url, body) => wishOkPost(url, body));
  const result = await h.store.runClaimAll('acc-1');
  assert.deepEqual(h.api.calls.post.map(call => call.body.action), ['shareDaily'], '只发生每日领取一项写入');
  const byKey = Object.fromEntries(h.store.claimAllResults.map(item => [item.key, item]));
  assert.equal(byKey['share:daily'].status, 'success', '已完成的每日领取结果保留');
  assert.equal(byKey['share:milestones'].status, 'skipped');
  assert.match(byKey['share:milestones'].detail, /每日领取后活动已结束/);
  assert.doesNotMatch(byKey['share:milestones'].detail, /结果未知/, '下架确认不是结果未知');
  assert.equal(shareReads, 2, '收尾不得补读已下架的快乐不独享');
  assert.equal(h.store.activityRetired.happyShare?.reason, 'unavailable');
  assert.equal(result.ok, true);
});

test('页面重新检查提示矩阵：成功恢复/确认下架/普通失败/网络拒绝；不自动重试、零写', async () => {
  const api = apiMock();
  const future = Math.floor(Date.now() / 1000) + 3600;
  api.setGet(async (url) => {
    if (url.includes('wish'))
      return { data: { ok: false, unavailable: true, error: '活动未下发' } };
    return { data: { ok: true, activity: panelSafeActivity({ endTime: future }) } };
  });
  const { root, toastLog } = mountActivityPage(api);
  await waitFor(() => textOf(root).includes('活动管理'), '初始读取下架生效');
  assert.doesNotMatch(textOf(root), /秋祈良愿/, '默认页面删除已结束活动');
  await openActivityManagement(root);

  // 1) 普通失败：错误提示带原因；不自动重试
  api.setGet(async (url) => {
    if (url.includes('wish'))
      return { data: { ok: false, error: '网络波动' } };
    return { data: { ok: true, activity: panelSafeActivity({ endTime: future }) } };
  });
  click(buttonsOf(root).find(node => textOf(node).includes('重新检查')));
  await waitFor(() => toastLog.some(([, message]) => String(message).includes('网络波动')), '普通失败提示');
  await flush();
  assert.equal(wishGets(api), 2, '失败后不自动重试');
  assert.doesNotMatch(textOf(root), /错过存储 5 日/, '普通失败不得恢复玩法面板');

  // 2) 确认下架：明确「保持下架」提示
  api.setGet(async (url) => {
    if (url.includes('wish'))
      return { data: { ok: false, unavailable: true, error: '活动未下发' } };
    return { data: { ok: true, activity: panelSafeActivity({ endTime: future }) } };
  });
  click(buttonsOf(root).find(node => textOf(node).includes('重新检查')));
  await waitFor(() => toastLog.some(([, message]) => String(message).includes('保持下架')), '确认下架提示');
  assert.doesNotMatch(textOf(root), /错过存储 5 日/, '下架确认不得恢复玩法面板');

  // 3) 网络拒绝（异常抛出）：错误提示，不崩页面
  api.setGet(async (url) => {
    if (url.includes('wish'))
      throw new Error('连接中断');
    return { data: { ok: true, activity: panelSafeActivity({ endTime: future }) } };
  });
  click(buttonsOf(root).find(node => textOf(node).includes('重新检查')));
  await waitFor(() => toastLog.some(([, message]) => String(message).includes('连接中断')), '网络拒绝提示');
  assert.equal(wishGets(api), 4, '每次重新检查恰好一次读取');

  // 4) 成功恢复：恢复提示 + 面板回归
  api.setGet(async (url) => {
    if (url.includes('wish'))
      return { data: { ok: true, activity: panelSafeActivity({ operateState: wishPendingState, endTime: future }) } };
    return { data: { ok: true, activity: panelSafeActivity({ endTime: future }) } };
  });
  click(buttonsOf(root).find(node => textOf(node).includes('重新检查')));
  await waitFor(() => toastLog.some(([, message]) => String(message).includes('已恢复展示')), '恢复提示');
  await waitFor(() => textOf(root).includes('错过存储 5 日'), '真实有效快照落地后面板回归');
  assert.ok(textOf(root).includes('错过存储 5 日'), '玩法面板恢复展示');
  assert.equal(api.calls.post.length, 0, '重新检查全程零写请求');
});

test('收起活动管理不读取；展开后每个选中活动恰好一次读取零写，收起彻底移除旧名称与按钮', async () => {
  const api = apiMock();
  api.setGet(async () => ({ data: { ok: false, unavailable: true, error: '活动未下发' } }));
  const { root, toastLog } = mountActivityPage(api);
  await waitFor(() => textOf(root).includes('暂无进行中的活动。'), '三活动下架响应均落地');
  assert.equal(api.calls.get.length, 3);
  assert.doesNotMatch(textOf(root), /S3 萌宠|秋祈良愿|快乐不独享/);
  await openActivityManagement(root);
  assert.equal(api.calls.get.length, 3, '展开管理本身不探测');
  for (const [label, endpoint] of [['S3 萌宠', 'bear'], ['秋祈良愿', 'wish'], ['快乐不独享', 'happy-share']]) {
    const row = findAll(root, el => el.tag === 'div' && el.children.some(child => child.tag === 'span' && textOf(child) === label))[0];
    assert.ok(row, `${label} 管理行存在`);
    const before = api.calls.get.length;
    const hintsBefore = toastLog.length;
    click(buttonsOf(row).find(button => textOf(button).includes('重新检查')));
    await waitFor(() => toastLog.length === hintsBefore + 1, `${label} 重新检查响应已返回`);
    await flush();
    assert.equal(api.calls.get.length, before + 1, `${label} 每次只读取所选活动一次`);
    assert.ok(api.calls.get.at(-1).url.includes(endpoint), `${label} 没有读取其他活动`);
    assert.equal(api.calls.post.length, 0, `${label} 零写请求`);
    assert.doesNotMatch(textOf(root), /每日祈愿|档位奖励（稚萌熊熊）/, `${label} 未恢复玩法卡片`);
  }
  click(buttonsOf(root).find(button => textOf(button).trim() === '活动管理'));
  await flush();
  assert.doesNotMatch(textOf(root), /S3 萌宠|秋祈良愿|快乐不独享/);
  assert.ok(!buttonsOf(root).some(button => textOf(button).includes('重新检查')), '收起后按钮也从 DOM 移除');
  assert.equal(api.calls.get.length, 6, '收起不额外读取');
});

test('页面卸载作废在飞读取：迟到响应不回填快照、不重建到期计时、不弹提示', async () => {
  const api = apiMock();
  const nowSec = Math.floor(Date.now() / 1000);
  const future = nowSec + 3600;
  const gate = deferred();
  api.setGet(async (url) => {
    if (url.includes('wish'))
      return gate.promise; // wish 读取挂起
    return { data: { ok: true, activity: panelSafeActivity({ endTime: future }) } };
  });
  const { root, toastLog, pinia, useActivityStore } = mountActivityPage(api);
  await waitFor(() => textOf(root).includes('S3 萌宠') && api.calls.get.filter(call => !call.url.includes('wish')).length >= 2, '在架活动读取完成');
  // 卸载页面：作废三组在飞读取
  render(null, root);
  gate.resolve({ data: { ok: true, activity: panelSafeActivity({ endTime: nowSec + 1 }) } });
  await flush();
  await flush();
  const store = useActivityStore(pinia);
  assert.equal(store.wishActivity, null, '迟到响应不得回填快照');
  assert.equal(store.wishError, '', '迟到响应不得制造错误横幅');
  assert.equal(store.wishLoading, false, '迟到响应不得翻新 loading');
  assert.equal(store.activityRetired.wish, null, '迟到响应不得登记下架');
  await new Promise(resolve => setTimeout(resolve, 1300)); // 若错误重建了页外计时，此处会触发下架
  assert.equal(store.activityRetired.wish, null, '卸载后不得有页外计时触发下架');
  assert.equal(wishGets(api), 1, '无额外读取');
  assert.deepEqual(toastLog, [], '卸载后零提示');
});

test('切账号往返（字符串恰好相等）后旧重新检查响应不弹提示：靠读取代次作废', async () => {
  const api = apiMock();
  const future = Math.floor(Date.now() / 1000) + 3600;
  api.setGet(async (url) => {
    if (url.includes('wish'))
      return { data: { ok: false, unavailable: true, error: '活动未下发' } };
    return { data: { ok: true, activity: panelSafeActivity({ endTime: future }) } };
  });
  const { root, toastLog, accountRef } = mountActivityPage(api);
  await waitFor(() => textOf(root).includes('活动管理'), '初始读取下架生效');
  await openActivityManagement(root);
  const wishReadsAtRecheck = wishGets(api);
  // 重新检查挂起：切走再切回（账号字符串回到同值）
  const gate = deferred();
  api.setGet(async (url) => {
    if (url.includes('wish'))
      return gate.promise;
    return { data: { ok: true, activity: panelSafeActivity({ endTime: future }) } };
  });
  click(buttonsOf(root).find(node => textOf(node).includes('重新检查')));
  await waitFor(() => wishGets(api) === wishReadsAtRecheck + 1, '重新检查读取已发出');
  accountRef.value = 'acc-2';
  await waitFor(() => api.calls.get.some(call => call.accountId === 'acc-2'), '切账号触发新读取');
  accountRef.value = 'acc-1'; // 往返回同 ID：仅凭字符串相等不足以判定同生命周期
  await waitFor(() => api.calls.get.some(call => call.accountId === 'acc-1'), '切回触发新读取');
  gate.resolve({ data: { ok: true, activity: panelSafeActivity({ endTime: future }) } });
  await flush();
  await flush();
  await flush();
  assert.deepEqual(toastLog, [], '旧生命周期的重新检查响应不得弹任何提示');
});

// ===== 2026-10-09 implement 轮补充：主审四缺口与写闸、跳过说明区分的验收 =====

test('空成功响应不解除下架：重新检查 ok 但无活动数据 → 保持下架、不虚报恢复、零写', async () => {
  const h = storeHarness();
  h.api.setGet(async url => (url.includes('wish')
    ? { data: { ok: false, unavailable: true, error: '活动未下发' } }
    : { data: { ok: true, activity: panelSafeActivity({}) } }));
  await h.store.fetchWishActivity('acc-1');
  assert.equal(h.store.activityRetired.wish?.reason, 'unavailable');
  // 重新检查 ok:true 但 activity 为空：不得恢复
  h.api.setGet(async url => (url.includes('wish')
    ? { data: { ok: true, activity: null } }
    : { data: { ok: true, activity: panelSafeActivity({}) } }));
  const empty = await h.store.recheckActivity('wish', 'acc-1');
  assert.equal(empty?.ok, false);
  assert.equal(empty?.retired, true);
  assert.equal(h.store.activityRetired.wish?.reason, 'unavailable', '空成功响应不得解除下架');
  assert.equal(h.store.wishActivity, null);
  // 再检查一次带回非空有效未过期快照 → 当前代次恢复展示
  const future = Math.floor(Date.now() / 1000) + 3600;
  h.api.setGet(async url => (url.includes('wish')
    ? { data: { ok: true, activity: panelSafeActivity({ endTime: future }) } }
    : { data: { ok: true, activity: panelSafeActivity({}) } }));
  const restored = await h.store.recheckActivity('wish', 'acc-1');
  assert.equal(restored?.ok, true);
  assert.equal(h.store.activityRetired.wish, null, '当前代次非空有效响应可恢复');
  assert.equal(wishGets(h.api), 3, '全程三次读取（初读+两次重新检查）');
  assert.equal(h.api.calls.post.length, 0, '重新检查零写请求');
});

test('过时代次的异常返回标记已取消：切账号后迟到的网络拒绝不是普通失败', async () => {
  const h = storeHarness();
  const gate = deferred();
  h.api.setGet(async (url) => {
    if (url.includes('wish'))
      return gate.promise;
    return { data: { ok: true, activity: panelSafeActivity({}) } };
  });
  const pending = h.store.fetchWishActivity('acc-1');
  h.accountState.currentAccountId = 'acc-2';
  h.store.clearActivityData(); // 切账号作废在飞读取
  gate.reject(new Error('network down'));
  const result = await pending;
  assert.equal(result?.ok, false);
  assert.equal(result?.cancelled, true, '过时代次的异常必须标记已取消');
  assert.equal(h.store.wishError, '', '旧代次异常不得回填新账号错误横幅');
  assert.equal(h.store.wishLoading, false);
});

test('卸载完整释放到期计时：页外不再触发下架；重进清扫按保留的截止证据零请求补判', async () => {
  const h = storeHarness();
  const end = Math.floor(Date.now() / 1000) + 1;
  h.api.setGet(async url => (url.includes('wish')
    ? { data: { ok: true, activity: panelSafeActivity({ endTime: end }) } }
    : { data: { ok: true, activity: panelSafeActivity({}) } }));
  await h.store.fetchWishActivity('acc-1');
  assert.equal(h.store.activityRetired.wish, null);
  // 页面卸载：作废在飞读取并完整释放计时（清计时+推进令牌）
  h.store.cancelActivityReads();
  await new Promise(resolve => setTimeout(resolve, 1300)); // 越过截止仍留在页外
  assert.equal(h.store.activityRetired.wish, null, '卸载后不得有页外计时触发下架');
  assert.ok(h.store.wishActivity != null, '已落地快照的截止证据保留');
  // 重进页面：进入清扫零请求补判下架
  h.store.sweepExpiredActivities();
  assert.equal(h.store.activityRetired.wish?.reason, 'expired', '清扫按保留的截止证据补判');
  assert.equal(h.store.wishActivity, null);
  assert.equal(wishGets(h.api), 1, '清扫与下架全程零新增请求');
});

test('写入口下架闸：已下架活动的手动操作零新增写请求', async () => {
  const h = storeHarness();
  h.api.setGet(async () => ({ data: { ok: false, unavailable: true, error: '活动未下发' } }));
  await Promise.all([
    h.store.fetchBearActivity('acc-1'),
    h.store.fetchWishActivity('acc-1'),
    h.store.fetchHappyShareActivity('acc-1'),
  ]);
  const bearBlocked = await h.store.operateBearPet('acc-1', 'seeds', {});
  assert.equal(bearBlocked?.ok, false);
  assert.equal(bearBlocked?.retired, true);
  const wishBlocked = await h.store.operateSeasonWish('acc-1', 'wishClaim', { chooseId: 3 });
  assert.equal(wishBlocked?.ok, false);
  assert.equal(wishBlocked?.retired, true);
  const shareBlocked = await h.store.operateSeasonWish('acc-1', 'shareDaily', {});
  assert.equal(shareBlocked?.ok, false);
  assert.equal(shareBlocked?.retired, true);
  assert.equal(h.api.calls.post.length, 0, '下架活动零新增写请求');
});

test('runner 跳过说明区分：本轮读取一次后确认结束 vs 此前已停读零读取零写入', async () => {
  // (a) 本轮首读探测到 unavailable：说明必须承认发生过一次读取，不得说成全程零读取
  const a = storeHarness();
  a.api.setGet(async url => (url.includes('wish')
    ? { data: { ok: false, unavailable: true, error: '活动未下发' } }
    : { data: { ok: true, activity: {} } }));
  a.api.setPost(async (url, body) => (url.includes('pet-diary') ? petOkPost(url, body) : wishOkPost(url, body)));
  const resultA = await a.store.runClaimAll('acc-1');
  assert.equal(resultA.ok, true);
  const detailA = a.store.claimAllResults.find(item => item.key === 'wish')?.detail;
  assert.match(String(detailA), /本轮读取一次后确认/);
  assert.doesNotMatch(String(detailA), /零读取零写入/);
  assert.equal(wishGets(a.api), 1, '本轮确实读取过一次');
  assert.equal(a.api.calls.post.length, 0);

  // (b) 一键领取开始前已下架（门控零请求返回）：零读取零写入，说明如实登记
  const b = storeHarness();
  b.api.setGet(async url => (url.includes('wish')
    ? { data: { ok: false, unavailable: true, error: '活动未下发' } }
    : { data: { ok: true, activity: {} } }));
  b.api.setPost(async (url, body) => (url.includes('pet-diary') ? petOkPost(url, body) : wishOkPost(url, body)));
  await b.store.fetchWishActivity('acc-1'); // 建立下架证据
  const resultB = await b.store.runClaimAll('acc-1');
  assert.equal(resultB.ok, true);
  const detailB = b.store.claimAllResults.find(item => item.key === 'wish')?.detail;
  assert.match(String(detailB), /此前已确认/);
  assert.match(String(detailB), /零读取零写入/);
  assert.equal(wishGets(b.api), 1, '一键领取对已停读活动零新增读取');
  assert.equal(b.api.calls.post.length, 0);
});

test('页面手动操作成功后的刷新对已下架活动静默：零新增读取、零错误提示', async () => {
  const api = apiMock();
  const future = Math.floor(Date.now() / 1000) + 3600;
  let wishReads = 0;
  api.setGet(async (url) => {
    if (url.includes('happy-share'))
      return { data: { ok: false, unavailable: true, error: '活动未下发' } };
    if (url.includes('wish')) {
      wishReads += 1;
      return { data: { ok: true, activity: panelSafeActivity({ operateState: wishPendingState, endTime: future }) } };
    }
    return { data: { ok: true, activity: panelSafeActivity({ endTime: future }) } };
  });
  api.setPost(async (url, body) => wishOkPost(url, body));
  const { root, toastLog } = mountActivityPage(api);
  await waitFor(() => textOf(root).includes('待领取签文'), '祈愿面板带待领取状态渲染');
  const shareReadsBefore = api.calls.get.filter(call => call.url.includes('happy-share')).length;
  click(buttonsOf(root).find(node => textOf(node).includes('领取祈愿奖励')));
  await waitFor(() => toastLog.some(([, message]) => String(message).includes('操作成功')), '操作成功提示');
  await waitFor(() => wishReads >= 2, '操作后刷新重读祈愿');
  assert.equal(api.calls.get.filter(call => call.url.includes('happy-share')).length, shareReadsBefore, '已下架活动零新增读取');
  assert.equal(toastLog.filter(([kind]) => kind === 'error').length, 0, '操作后刷新不得把下架当失败弹错误提示');
  assert.equal(api.calls.post.length, 1, '只发生用户点击的一项写请求');
});

test('页面卸载后的旧操作回调不弹提示、不启动新的页面刷新', async () => {
  const api = apiMock();
  const future = Math.floor(Date.now() / 1000) + 3600;
  api.setGet(async (url) => {
    if (url.includes('happy-share'))
      return { data: { ok: true, activity: panelSafeActivity({ operateState: shareAfterDaily }) } };
    if (url.includes('wish'))
      return { data: { ok: true, activity: panelSafeActivity({ operateState: wishPendingState, endTime: future }) } };
    return { data: { ok: true, activity: panelSafeActivity({ endTime: future }) } };
  });
  const gate = deferred();
  api.setPost(async () => gate.promise);
  const { root, toastLog } = mountActivityPage(api);
  await waitFor(() => textOf(root).includes('待领取签文'), '祈愿面板渲染');
  const getsBefore = api.calls.get.length;
  click(buttonsOf(root).find(node => textOf(node).includes('领取祈愿奖励')));
  await waitFor(() => api.calls.post.length === 1, '写请求已发出');
  render(null, root); // 卸载页面
  gate.resolve({ data: { ok: true, rewards: [{ itemName: '烟花桶', itemCount: 2 }] } });
  await flush();
  await flush();
  await flush();
  assert.deepEqual(toastLog, [], '卸载后的旧操作回调零提示');
  assert.equal(api.calls.get.length, getsBefore, '卸载后不得启动新的页面刷新');
});

// ===== 2026-10-09 repair 轮补充：主审三缺口的验收 =====

test('重进清扫为仍有效的保留快照恢复到期计时：读取缓慢期间到期仍零请求撤下', async () => {
  const h = storeHarness();
  const end = Math.floor(Date.now() / 1000) + 1;
  h.api.setGet(async url => (url.includes('wish')
    ? { data: { ok: true, activity: panelSafeActivity({ endTime: end }) } }
    : { data: { ok: true, activity: panelSafeActivity({}) } }));
  await h.store.fetchWishActivity('acc-1');
  assert.equal(h.store.activityRetired.wish, null);
  // 页面卸载释放计时（快照与截止证据保留）；重进：清扫恢复计时，新读取在飞且缓慢
  h.store.cancelActivityReads();
  const gate = deferred();
  h.api.setGet(async url => (url.includes('wish')
    ? gate.promise
    : { data: { ok: true, activity: panelSafeActivity({}) } }));
  const slow = h.store.fetchWishActivity('acc-1');
  h.store.sweepExpiredActivities();
  await new Promise(resolve => setTimeout(resolve, 1300)); // 越过截止：无新响应落地
  assert.equal(h.store.activityRetired.wish?.reason, 'expired', '清扫恢复的计时在读取缓慢期间到点撤下');
  assert.equal(h.store.wishActivity, null);
  assert.equal(wishGets(h.api), 2, '撤下不靠请求（初读+缓慢读取，零额外读取）');
  gate.resolve({ data: { ok: true, activity: panelSafeActivity({ endTime: Math.floor(Date.now() / 1000) + 3600 }) } });
  const late = await slow;
  assert.equal(late?.retired, true, '迟到响应不复活已下架活动');
  assert.equal(h.store.wishActivity, null);
});

test('写入口同步截止核对：快照已过截止但到期计时未执行 → 手动操作零写并同步下架', async () => {
  const h = storeHarness();
  const end = Math.floor(Date.now() / 1000) + 1;
  h.api.setGet(async () => ({ data: { ok: true, activity: panelSafeActivity({ operateState: wishPendingState, endTime: end }) } }));
  await Promise.all([
    h.store.fetchBearActivity('acc-1'),
    h.store.fetchWishActivity('acc-1'),
    h.store.fetchHappyShareActivity('acc-1'),
  ]);
  h.store.cancelActivityReads(); // 卸载释放计时：快照保留、无计时触发
  await new Promise(resolve => setTimeout(resolve, 1300)); // 截止已过且无计时回调执行
  assert.equal(h.store.activityRetired.wish, null, '前置：无页外计时，标记尚未置位');
  const blocked = await h.store.operateSeasonWish('acc-1', 'wishClaim', { chooseId: 3 });
  assert.equal(blocked?.ok, false);
  assert.equal(blocked?.retired, true, '写入口按当前快照截止同步拦下（不等计时回调）');
  assert.equal(h.store.activityRetired.wish?.reason, 'expired', '同步落地 expired 下架');
  assert.equal(h.api.calls.post.length, 0, '零新增写请求');
  const bearBlocked = await h.store.operateBearPet('acc-1', 'seeds', {});
  assert.equal(bearBlocked?.retired, true, 'bear 写入口同规则');
  assert.equal(h.api.calls.post.length, 0);
  // 未知截止（缺失/无效）不得被同步闸误拦：无截止快照仍照常发写
  const h2 = storeHarness();
  h2.api.setGet(async () => ({ data: { ok: true, activity: panelSafeActivity({ endTime: 0, operateState: wishPendingState }) } }));
  await h2.store.fetchWishActivity('acc-1');
  h2.api.setPost(async (url, body) => wishOkPost(url, body));
  const allowed = await h2.store.operateSeasonWish('acc-1', 'wishClaim', { chooseId: 3 });
  assert.equal(allowed?.ok, true, '未知截止不猜测、不拦写');
  assert.equal(h2.api.calls.post.length, 1);
});

test('切账号往返（账号串恰好相等）后旧单项操作回调不弹提示、不启动新刷新（成功与拒绝）', async () => {
  const api = apiMock();
  const future = Math.floor(Date.now() / 1000) + 3600;
  api.setGet(async (url) => {
    if (url.includes('happy-share'))
      return { data: { ok: true, activity: panelSafeActivity({ operateState: shareAfterDaily }) } };
    if (url.includes('wish'))
      return { data: { ok: true, activity: panelSafeActivity({ operateState: wishPendingState, endTime: future }) } };
    return { data: { ok: true, activity: panelSafeActivity({ endTime: future }) } };
  });
  let gate = deferred();
  api.setPost(async () => gate.promise);
  const { root, toastLog, accountRef } = mountActivityPage(api);
  await waitFor(() => textOf(root).includes('待领取签文'), '祈愿面板渲染');
  click(buttonsOf(root).find(node => textOf(node).includes('领取祈愿奖励')));
  await waitFor(() => api.calls.post.length === 1, '第一笔写请求已发出');
  // 切走再切回：账号串与旧回调相等，只能靠生命周期代次作废
  accountRef.value = 'acc-2';
  await flush();
  accountRef.value = 'acc-1';
  await waitFor(() => wishGets(api) === 3, '两次切换各触发一轮刷新');
  const getsAfterSwitch = api.calls.get.length;
  gate.resolve({ data: { ok: true, rewards: [{ itemName: '烟花桶', itemCount: 2 }] } });
  await flush();
  await flush();
  await flush();
  assert.equal(toastLog.length, 0, '往返后的旧成功回调零提示');
  assert.equal(api.calls.get.length, getsAfterSwitch, '旧成功回调不得启动新的页面刷新');

  // 同一页面第二轮：拒绝路径（迟到的网络异常）同样靠代次作废
  await waitFor(() => textOf(root).includes('待领取签文'), '祈愿面板重新渲染');
  gate = deferred();
  click(buttonsOf(root).find(node => textOf(node).includes('领取祈愿奖励')));
  await waitFor(() => api.calls.post.length === 2, '第二笔写请求已发出');
  accountRef.value = 'acc-2';
  await flush();
  accountRef.value = 'acc-1';
  await waitFor(() => wishGets(api) === 5, '两次切换各触发一轮刷新');
  const getsBeforeReject = api.calls.get.length;
  gate.reject(new Error('network down'));
  await flush();
  await flush();
  await flush();
  assert.equal(toastLog.filter(([kind]) => kind === 'error').length, 0, '往返后的旧拒绝回调零错误提示');
  assert.equal(api.calls.get.length, getsBeforeReject, '旧拒绝回调不得启动新的页面刷新');
});

// ===== 2026-10-09 review 返工：主审复核缺口（截止证据不随读取失败丢失 / 重新检查恢复条件严格）的验收 =====

test('普通失败与网络拒绝不丢已落地截止证据：三活动到点仍零请求下架；截止后零新增读取、零写', async () => {
  const modes = [
    ['普通失败', () => ({ data: { ok: false, error: '账号未运行' } })],
    ['网络拒绝', () => Promise.reject(new Error('连接中断'))],
  ];
  for (const [label, failWith] of modes) {
    const h = storeHarness();
    const end = Math.floor(Date.now() / 1000) + 1;
    // 三活动先落地带未来截止的快照（计时绑定已落地快照）
    h.api.setGet(async () => ({ data: { ok: true, activity: panelSafeActivity({ endTime: end }) } }));
    await Promise.all([
      h.store.fetchBearActivity('acc-1'),
      h.store.fetchWishActivity('acc-1'),
      h.store.fetchHappyShareActivity('acc-1'),
    ]);
    // 截止前的读取失败「已返回」（不是挂起）：已落地快照与截止证据必须保留
    h.api.setGet(async () => failWith());
    const failed = await Promise.all([
      h.store.fetchBearActivity('acc-1'),
      h.store.fetchWishActivity('acc-1'),
      h.store.fetchHappyShareActivity('acc-1'),
    ]);
    for (const res of failed)
      assert.equal(res?.ok, false, `${label} 前置：失败已返回`);
    assert.ok(h.store.bearActivity != null && h.store.wishActivity != null && h.store.happyShareActivity != null, `${label} 后快照（截止证据）不得被清空`);
    assert.equal(h.store.activityRetired.bear, null, `${label} 本身不得提前判定结束（bear）`);
    assert.equal(h.store.activityRetired.wish, null, `${label} 本身不得提前判定结束（wish）`);
    assert.equal(h.store.activityRetired.happyShare, null, `${label} 本身不得提前判定结束（happyShare）`);
    assert.notEqual(h.store.bearError, '', `${label} 照常留下错误横幅`);
    await new Promise(resolve => setTimeout(resolve, 1300)); // 越过截止：计时仍读得到快照截止
    assert.equal(h.store.activityRetired.bear?.reason, 'expired', `${label} 后到点仍零请求下架（bear）`);
    assert.equal(h.store.activityRetired.wish?.reason, 'expired', `${label} 后到点仍零请求下架（wish）`);
    assert.equal(h.store.activityRetired.happyShare?.reason, 'expired', `${label} 后到点仍零请求下架（happyShare）`);
    assert.equal(h.store.bearActivity, null, '下架清快照');
    assert.equal(h.store.wishActivity, null);
    assert.equal(h.store.happyShareActivity, null);
    // 截止后：普通刷新零新增读取（下架门），手动写入口全部被闸（零写）
    const getsAtRetire = h.api.calls.get.length;
    await Promise.all([
      h.store.fetchBearActivity('acc-1'),
      h.store.fetchWishActivity('acc-1'),
      h.store.fetchHappyShareActivity('acc-1'),
    ]);
    assert.equal(h.api.calls.get.length, getsAtRetire, `${label} 下架后普通刷新零新增读取`);
    assert.equal((await h.store.operateBearPet('acc-1', 'seeds', {}))?.retired, true);
    assert.equal((await h.store.operateSeasonWish('acc-1', 'wishClaim', { chooseId: 3 }))?.retired, true);
    assert.equal((await h.store.operateSeasonWish('acc-1', 'shareDaily', {}))?.retired, true);
    assert.equal(h.api.calls.post.length, 0, `${label} 下架后零新增写请求`);
  }
});

test('重新检查恢复条件严格：非布尔 ok 或不合法快照（空对象/数组/非对象）一律保持下架、恰好一次读取、零写', async () => {
  const future = Math.floor(Date.now() / 1000) + 3600;
  const invalid = [
    ['空对象快照', () => ({ data: { ok: true, activity: {} } })],
    ['数组快照', () => ({ data: { ok: true, activity: [{ endTime: future }] } })],
    ['字符串快照', () => ({ data: { ok: true, activity: 'activity' } })],
    ['非布尔成功标记', () => ({ data: { ok: 'yes', activity: panelSafeActivity({ endTime: future }) } })],
    ['数字成功标记', () => ({ data: { ok: 1, activity: panelSafeActivity({ endTime: future }) } })],
  ];
  for (const [label, respond] of invalid) {
    const h = storeHarness();
    h.api.setGet(async url => (url.includes('wish')
      ? { data: { ok: false, unavailable: true, error: '活动未下发' } }
      : { data: { ok: true, activity: panelSafeActivity({}) } }));
    await h.store.fetchWishActivity('acc-1');
    assert.equal(h.store.activityRetired.wish?.reason, 'unavailable', `${label} 前置下架`);
    h.api.setGet(async url => (url.includes('wish')
      ? respond()
      : { data: { ok: true, activity: panelSafeActivity({}) } }));
    const res = await h.store.recheckActivity('wish', 'acc-1');
    assert.equal(res?.ok, false, `${label} 不得虚报恢复`);
    assert.equal(h.store.activityRetired.wish?.reason, 'unavailable', `${label} 保持下架`);
    assert.equal(wishGets(h.api), 2, `${label} 恰好一次读取`);
    assert.equal(h.api.calls.post.length, 0, `${label} 零写`);
  }
  // 合法但未知截止的快照：按批准规则恢复（不误判结束、不建计时、零周期探测）
  const h2 = storeHarness();
  h2.api.setGet(async url => (url.includes('wish')
    ? { data: { ok: false, unavailable: true, error: '活动未下发' } }
    : { data: { ok: true, activity: panelSafeActivity({}) } }));
  await h2.store.fetchWishActivity('acc-1');
  assert.equal(h2.store.activityRetired.wish?.reason, 'unavailable');
  h2.api.setGet(async url => (url.includes('wish')
    ? { data: { ok: true, activity: panelSafeActivity({ endTime: 0 }) } }
    : { data: { ok: true, activity: panelSafeActivity({}) } }));
  const restored = await h2.store.recheckActivity('wish', 'acc-1');
  assert.equal(restored?.ok, true, '合法快照（未知截止）可恢复');
  assert.equal(h2.store.activityRetired.wish, null);
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(h2.store.activityRetired.wish, null, '未知截止不得误判结束');
  assert.equal(wishGets(h2.api), 2, '未知截止不周期探测');
});

test('页面重新检查：不合法快照/非布尔 ok 不出现恢复提示，保持下架、每次恰好一次读取、零写', async () => {
  const api = apiMock();
  const future = Math.floor(Date.now() / 1000) + 3600;
  api.setGet(async (url) => {
    if (url.includes('wish'))
      return { data: { ok: false, unavailable: true, error: '活动未下发' } };
    return { data: { ok: true, activity: panelSafeActivity({ endTime: future }) } };
  });
  const { root, toastLog } = mountActivityPage(api);
  await waitFor(() => textOf(root).includes('活动管理'), '初始读取下架生效');
  await openActivityManagement(root);
  for (const payload of [
    { ok: true, activity: {} },
    { ok: true, activity: ['not-an-activity'] },
    { ok: 'yes', activity: panelSafeActivity({ endTime: future }) },
  ]) {
    api.setGet(async (url) => {
      if (url.includes('wish'))
        return { data: payload };
      return { data: { ok: true, activity: panelSafeActivity({ endTime: future }) } };
    });
    const before = wishGets(api);
    click(buttonsOf(root).find(node => textOf(node).includes('重新检查')));
    await waitFor(() => wishGets(api) === before + 1, '重新检查恰好一次读取');
    await flush();
    await flush();
    assert.ok(!toastLog.some(([, message]) => String(message).includes('已恢复')), '不得出现恢复提示');
    assert.doesNotMatch(textOf(root), /错过存储 5 日/, '不合法响应不得恢复玩法面板');
  }
  assert.equal(api.calls.post.length, 0, '重新检查全程零写请求');
});
