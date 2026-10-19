'use strict';
// 奶茶热销中（S4）显式查询 + 面板手动操作 + 管理路由行为回归。
// 覆盖合同：六种显式查询参数白名单/DTO 白名单/调用计数；14 个手动动作
// 各自成功与资格拒绝（成员/槽位/班次/配方果实/锁定/费用确认/余额/限购）；
// 营业开始/结算/最终截止边界与读取途中跨边界；Symbol 租约首 await 前持有、
// 忙拒绝不排队、finally 只释放自己；每个 await 后连接/就绪复查（零后续写）；
// 写后传输失败/解码失败/回显不匹配/缺结果体 = 结果未知零重试；雇佣部分失败
// 与互动输赢如实区分；真实管理路由鉴权/访问/连接/运行序 + 共享缓存隔离、
// 并发合并、写后失效、旧挂起不回填、裸账号 loader；旧 bear/wish/happy-share
// 服务直接调用零网络。
// 网络全部为替身（mock network + 注入 reader），零真实游戏请求；业务模块
// 加载前隔离 FARM_DATA_DIR，夹具目录先解析校验边界，结束清理并核对候选
// 源码内容与权限不变。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

// ===== 隔离环境（先于任何业务模块加载）=====
const repoRoot = path.resolve(__dirname, '..', '..');
const repoRootReal = fs.realpathSync(repoRoot);
function isInsideOrEqualDir(candidate, base) {
  const c = path.resolve(String(candidate));
  const b = path.resolve(String(base));
  return c === b || c.startsWith(b + path.sep);
}
const tempRoot = fs.realpathSync(path.resolve(os.tmpdir()));
assert.equal(isInsideOrEqualDir(tempRoot, repoRootReal), false, '临时根不得指向仓库');
// mkdtemp 前先验证前缀路径确实落在临时根内（防 tmpdir 解析漂移后越界建目录）
const mkdtempPrefix = path.join(tempRoot, 'farm-milk-tea-operate-');
assert.equal(isInsideOrEqualDir(mkdtempPrefix, tempRoot), true, 'mkdtemp 前缀必须位于临时根内');
const privateDir = path.resolve(fs.mkdtempSync(mkdtempPrefix));
assert.equal(isInsideOrEqualDir(privateDir, tempRoot), true, '独立运行数据目录必须落在临时根内');
process.env.FARM_DATA_DIR = privateDir;
function assertWriteInsidePrivateDir(target) {
  const resolved = path.resolve(String(target));
  if (!isInsideOrEqualDir(resolved, privateDir))
    throw new Error(`夹具写目标越界（已在写入原语前拒绝）: ${resolved}`);
  return resolved;
}

const CANDIDATE_SOURCES = [
  path.join(repoRoot, 'core', 'src', 'services', 'milk-tea-activity.js'),
  path.join(repoRoot, 'core', 'src', 'controllers', 'admin-milk-tea-activity-routes.js'),
  path.join(repoRoot, 'core', 'src', 'services', 'activity.js'),
  path.join(repoRoot, 'core', 'src', 'services', 'pet-diary-operate.js'),
  path.join(repoRoot, 'core', 'src', 'services', 'season-wish-operate.js'),
  path.join(repoRoot, 'core', 'src', 'core', 'worker.js'),
];
function fingerprintOf(file) {
  const stat = fs.statSync(file);
  return { mode: stat.mode, size: stat.size, sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') };
}
const fingerprintsBefore = new Map(CANDIDATE_SOURCES.map(file => [file, fingerprintOf(file)]));

const { loadProto, types } = require('../src/utils/proto');
const { registerAdminMilkTeaActivityRoutes } = require('../src/controllers/admin-milk-tea-activity-routes');
const { createActivityReadCache } = require('../src/controllers/activity-read-cache');

const ROOT = 2026110100;
const MAIN = 2026110101;
const SHOP = 2026110102;
const FUND = 2026110103;
const HAPPY = 2026110104;
const TICKET = 1041;
const BOOST = 1042;

const nowSec = () => Math.floor(Date.now() / 1000);
const hex = value => Buffer.from(value).toString('hex');

function mockModule(filename, exports) {
  return { id: filename, filename, loaded: true, exports, paths: [] };
}

// ===== 可变场景替身 =====

const OPEN_WINDOW = () => {
  const start = nowSec() - 86400;
  const end = start + 20 * 86400;
  return { start, end, settle: end - 4 * 86400 };
};

function defaultScenario() {
  const window = OPEN_WINDOW();
  return {
    ...window,
    clock: nowSec(),
    listRoot: true,
    listEnabled: true,
    snapshotId: ROOT,
    // 时间跨越注入：读取指定 cmd 回包时把时钟前移
    advanceOnCmd: null,
    advanceSeconds: 0,
    swapConnectionAfterList: false,
    loseReadyAfterSnapshot: false,
    connection: { tag: 'ws1' },
    connectionCurrent: null, // 置空时回落 scenario.connection
    ready: true,
    failOperate: null, // 'transport' | 'echoMismatch' | 'dropBody'
    blockList: null,  // { promise } —— 租约测试用：首个 await 悬挂
    bagItems: [
      { id: TICKET, count: '500', uid: '1' },
      { id: BOOST, count: '10', uid: '2' },
      { id: 40525, count: '7', uid: '23563' },
    ],
    summary: {
      shopOpenAt: 0, shopName: '', renameCdUntilAt: 0, level: 1, totalRevenue: 0,
      hireDisabled: false, cashierFull: false, cashierWarning: false, canUpgrade: false,
      openingGiftPreview: [], hasWorkerShift: false, hasUnclaimedWage: true, nextCupAt: 0,
    },
    exchangeShop: {
      items: [
        { id: 9001, name: '森野甜莓种子', order: 1, rewards: [{ id: 20525, count: '1' }], costs: [{ id: TICKET, count: '10' }], purchaseLimit: 5, purchasedCount: 0, diamondCostCount: 0, condHints: [] },
        { id: 9002, name: '奶茶券包', order: 2, rewards: [{ id: TICKET, count: '30' }], costs: [{ id: TICKET, count: '10' }], purchaseLimit: 0, purchasedCount: 0, diamondCostCount: 0, condHints: [] },
      ],
    },
    growthFund: {
      unlocked: true, unlockCost: [], tiers: [
        { tierId: 1, state: 2, conditions: [{ type: 'revenue', currentValue: 100, targetValue: 100, reached: true }], reward: [{ id: TICKET, count: '50' }] },
      ],
    },
    shareReward: {
      scoreItemId: TICKET, currentScore: 12,
      daily: { claimedCount: 0, claimLimit: 1, rewardClaimed: false, firstShareAwarded: false },
      milestones: [{ id: 1, threshold: 10, state: 2, rewards: [{ id: 210048, count: '1' }] }],
    },
    operateBodies: {}, // cmd -> 回包体（经 MilkTeaOperateReply 选择子挂载）
  };
}

function buildEnv(overrides = {}) {
  const scenario = defaultScenario();
  Object.assign(scenario, overrides);
  const env = {
    scenario,
    calls: [],          // 网络层方法名（Operate 计数）
    operateRequests: [], // 解码后的写/查询请求
    listCalls: 0,
    snapshotCalls: 0,
    bagCalls: 0,
  };

  const freeShopView = () => ({
    level: 2, total_revenue: 15000, next_level_revenue: 14000, can_upgrade: true,
    cashier_capacity_sec: 172800, sec_per_cup: 90, sales_item_id: BOOST,
    boost_cups_per_use: 40, effective_cups_per_hour: 40, is_settling: false,
    slots: [{ slot_index: 0, is_robot: false, begin_at: 0, end_at: 0, cost: 0 }],
    pending_rewards: [{ id: TICKET, count: '10' }], drink_cups: { 2: 19 }, next_full_at: 0,
  });

  const defaultBodies = () => ({
    53: { milk_tea_create_shop: { opening_gift: [{ id: TICKET, count: '20' }] } },
    54: { milk_tea_rename_shop: {} },
    55: { milk_tea_get_shop: { shop: freeShopView() } },
    56: { milk_tea_get_hire_list: {
      duration_id: 1, wage_total: 40, min_remain_biz_sec: 0,
      friends: [], robots: [{ friend: { gid: 101, name: '实习员工', level: 0 }, is_robot: true, talent_id: 9004, talent_name: '默默搬砖', state: 0 }],
    } },
    57: { milk_tea_hire: { results: [{ slot_index: 0, duration_id: 1, target_gid: 101, success: true }] } },
    58: { milk_tea_get_workshop: { recipes: [
      { recipe_id: 1, recipe_name: '普通奶茶', unlocked: true, stock_cups: -1 },
      { recipe_id: 2, recipe_name: '甜莓奶茶', unlocked: true, is_advanced: true, stock_cups: 19 },
    ] } },
    59: { milk_tea_claim_cashier: { items: [{ id: TICKET, count: '10' }] } },
    60: { milk_tea_boost: { cups: 40, token_gain: 3, coin_gain: 0 } },
    61: { milk_tea_upgrade: { level: 3, rewards: [] } },
    62: { milk_tea_craft: { crafted_cups: { 2: 20 }, drink_cups: { 2: 20 }, used_fruits: [{ id: 40525, count: '20', uid: 23563 }] } },
    63: { milk_tea_get_work_page: {
      my_shift: {
        employer: { gid: 101, name: '老板', level: 30 }, shop_name: '奶茶冲鸭', shift_id: 3001,
        talent_id: 9003, talent_name: '金牌服务', begin_at: 0, end_at: 0, settle_start_at: 0,
        interact_count: 0, interact_limit: 5, wage_total: 40,
        interact_previews: [{ interaction_type: 1, promote_cups: 10 }],
      },
      slips: [], talent_id: 9003, talent_name: '金牌服务', interact_done: false,
    } },
    64: { milk_tea_claim_wages: { claimed_count: 1, items: [{ id: TICKET, count: '12' }] } },
    65: { milk_tea_interact: { success: true, items_gained: [{ id: TICKET, count: '5' }] } },
    66: { milk_tea_get_rank: { page: 1, my_rank: 5, has_more: false, snapshot_time: 0, ranks: [{ owner: { gid: 101, name: '老板' }, shop_name: '奶茶冲鸭', level: 9, total_revenue: 999, rank: 1 }] } },
    67: { milk_tea_get_sales_log: { day: 20261015, token: 3, coin: 100, cups: 5, cups_by_recipe: { 2: 5 }, hires: [], items: [] } },
    68: { milk_tea_set_hire_disable: { hire_disabled: true } },
    1: { shop_buy: { awards: [{ id: 20525, count: '1' }], costs: [{ id: TICKET, count: '10' }] } },
    76: { growth_fund_claim: { claimed_tier_ids: [1], awards: [{ id: TICKET, count: '50' }] } },
    71: { share_reward_claim_milestones: { claimed_tier_ids: [1] } },
    74: { share_reward_claim_daily: { granted_score: 20 } },
  });
  if (!Object.keys(scenario.operateBodies).length) scenario.operateBodies = defaultBodies();
  env.defaultBodies = defaultBodies;

  const connection = () => (scenario.connectionCurrent || scenario.connection);
  env.swapConnection = () => { scenario.connectionCurrent = { tag: 'ws2' }; };

  const deps = {
    now: () => scenario.clock * 1000, // 服务 now 约定毫秒；scenario.clock 为秒
    getConnection: () => connection(),
    isReady: () => scenario.ready,
    getActivityDiscoveryList: async () => {
      env.listCalls += 1;
      if (scenario.swapConnectionAfterList) env.swapConnection();
      if (scenario.blockList) await scenario.blockList;
      return scenario.listRoot
        ? [{ id: ROOT, parentId: 0, enabled: scenario.listEnabled, startTime: scenario.start, endTime: scenario.end }]
        : [{ id: 2026090100, parentId: 0 }];
    },
    getActivityGroupSnapshot: async () => {
      env.snapshotCalls += 1;
      if (scenario.loseReadyAfterSnapshot) scenario.ready = false;
      if (scenario.advanceSeconds && !scenario.advanceOnCmd) scenario.clock += scenario.advanceSeconds;
      return {
        id: scenario.snapshotId,
        startTime: scenario.start,
        endTime: scenario.end,
        title: '奶茶热销中',
        children: [
          { id: MAIN, details: { milkTea: scenario.summary } },
          { id: SHOP, details: { exchangeShop: scenario.exchangeShop } },
          { id: FUND, details: { growthFund: scenario.growthFund } },
          { id: HAPPY, details: { shareReward: scenario.shareReward } },
        ],
        milkTeaTiming: { settleStartTime: scenario.settle },
      };
    },
    getBag: async () => { env.bagCalls += 1; return { items: scenario.bagItems }; },
    getBagItems: bag => (bag && bag.items) || [],
  };
  env.deps = deps;

  env.network = {
    sendMsgAsync: async (_service, method, payload) => {
      env.calls.push(method);
      if (method !== 'Operate') throw new Error(`意外网络调用: ${method}`);
      const req = types.MilkTeaOperateRequest.decode(payload);
      const cmd = Number(req.operate_type);
      env.operateRequests.push({ activityId: Number(req.activity_id), cmd, buffer: payload });
      if (scenario.advanceOnCmd === cmd && scenario.advanceSeconds) {
        scenario.clock += scenario.advanceSeconds;
      }
      if (scenario.failOperate === 'transport') throw new Error('传输失败');
      const replyPayload = { activity_id: req.activity_id, operate_type: scenario.failOperate === 'echoMismatch' ? cmd + 1 : cmd };
      const body = scenario.operateBodies[cmd];
      if (body && scenario.failOperate !== 'dropBody') Object.assign(replyPayload, body);
      return { body: types.MilkTeaOperateReply.encode(types.MilkTeaOperateReply.create(replyPayload)).finish() };
    },
    getWs: () => connection(),
    isConnected: () => true,
  };
  return env;
}

/** 每个用例装配全新服务实例（模块级租约/结束证据随 require 缓存重置）。 */
async function withFreshService(overrides, run) {
  await loadProto();
  const networkPath = require.resolve('../src/utils/network');
  const protoPath = require.resolve('../src/utils/proto');
  const servicePath = require.resolve('../src/services/milk-tea-activity');
  const previous = [networkPath, protoPath, servicePath].map(p => [p, require.cache[p]]);
  const env = buildEnv(overrides);
  require.cache[networkPath] = mockModule(networkPath, { ...env.network, sendMsgAsync: (...args) => env.network.sendMsgAsync(...args) });
  require.cache[protoPath] = mockModule(protoPath, { types });
  delete require.cache[servicePath];
  try {
    const service = require('../src/services/milk-tea-activity');
    await run(service, env);
  } finally {
    for (const [p, entry] of previous) {
      if (entry) require.cache[p] = entry;
      else delete require.cache[p];
    }
  }
}

const operateCount = env => env.calls.filter(method => method === 'Operate').length;
const business = code => err => err && err.business === true && err.code === code;

// ===== 六种显式查询 =====

test('显式查询：六种类型成功链、参数白名单、调用计数与 DTO 白名单', async () => {
  await withFreshService({}, async (service, env) => {
    // 六种查询逐一成功：List + GetGroup 各一次 + Operate 恰好一次
    const cases = [
      ['shop', {}, 55, result => {
        assert.equal(result.data.level, 2);
        assert.equal(result.data.nextLevelRevenue, 14000);
        assert.equal(result.data.salesItemId, BOOST);
        assert.deepEqual(result.data.drinkCups, { '2': 19 });
      }],
      ['hireList', { durationId: 1 }, 56, result => {
        assert.equal(result.data.robots.length, 1);
        assert.equal(result.data.robots[0].gid, '101');
      }],
      ['workshop', {}, 58, result => {
        assert.equal(result.data.recipes.length, 2);
        assert.equal(result.data.recipes[1].stockCups, 19);
      }],
      ['work', {}, 63, result => {
        assert.equal(result.data.myShift.shiftId, '3001');
        assert.equal(result.data.myShift.interactPreviews[0].interactionType, 1);
      }],
      ['rank', { page: 1 }, 66, result => {
        assert.equal(result.data.myRank, 5);
        assert.equal(result.data.ranks[0].shopName, '奶茶冲鸭');
      }],
      ['sales', { day: 20261015 }, 67, result => {
        assert.equal(result.data.day, 20261015);
        assert.deepEqual(result.data.cupsByRecipe, { '2': 5 });
      }],
    ];
    for (const [kind, params, cmd, verify] of cases) {
      env.calls.length = 0; env.operateRequests.length = 0;
      env.listCalls = 0; env.snapshotCalls = 0;
      const result = await service.queryMilkTeaActivity(kind, params, env.deps);
      assert.equal(result.kind, kind);
      verify(result);
      assert.equal(env.listCalls, 1, `${kind} 单次 List`);
      assert.equal(env.snapshotCalls, 1, `${kind} 单次根快照`);
      assert.equal(operateCount(env), 1, `${kind} 单次 Operate`);
      assert.equal(env.operateRequests[0].cmd, cmd);
    }
    // 请求编码：rank page=1 与官方向量一致（cmd66@2026110101）
    env.calls.length = 0; env.operateRequests.length = 0;
    await service.queryMilkTeaActivity('rank', { page: 1 }, env.deps);
    assert.equal(hex(env.operateRequests[0].buffer), '0895f98fc6071042da0a020801');

    // 未知查询类型：零网络零读取
    env.calls.length = 0; env.listCalls = 0;
    await assert.rejects(service.queryMilkTeaActivity('fund', {}, env.deps), business('SEASON_WISH_MILK_TEA_UNKNOWN_QUERY'));
    assert.equal(env.listCalls, 0);
    assert.equal(operateCount(env), 0);

    // 参数白名单：额外字段拒绝且零读取零发包
    for (const [kind, params] of [
      ['shop', { foo: 1 }],
      ['workshop', { page: 2 }],
      ['work', { day: 1 }],
      ['rank', { page: 1, extra: 'x' }],
      ['sales', { day: 1, page: 1 }],
      ['hireList', { durationId: 1, page: 1 }],
    ]) {
      env.listCalls = 0; env.calls.length = 0;
      await assert.rejects(
        service.queryMilkTeaActivity(kind, params, env.deps),
        business('SEASON_WISH_MILK_TEA_INVALID_INPUT'),
      );
      assert.equal(env.listCalls, 0, `${kind} 额外参数在读取前拒绝`);
      assert.equal(operateCount(env), 0);
    }
    // 数值域校验：坏班次/页码/日期零发包
    for (const [kind, params] of [['hireList', { durationId: 9 }], ['rank', { page: 0 }], ['sales', { day: 0 }]]) {
      env.calls.length = 0;
      await assert.rejects(service.queryMilkTeaActivity(kind, params, env.deps), business('SEASON_WISH_MILK_TEA_INVALID_INPUT'));
      assert.equal(operateCount(env), 0);
    }
    // 读路径回显不匹配/缺结果体：普通读错（不带 business；读无副作用），不重试
    env.scenario.failOperate = 'echoMismatch';
    await assert.rejects(
      service.queryMilkTeaActivity('shop', {}, env.deps),
      err => err.code === 'SEASON_WISH_MILK_TEA_REPLY_MISMATCH' && err.business !== true,
    );
    assert.equal(operateCount(env), 1);
    env.scenario.failOperate = 'dropBody';
    await assert.rejects(
      service.queryMilkTeaActivity('shop', {}, env.deps),
      err => err.code === 'SEASON_WISH_MILK_TEA_REPLY_MISMATCH' && err.business !== true,
    );
    assert.equal(operateCount(env), 2);
    env.scenario.failOperate = null;
  });
});

test('显式查询：缺根一次 List 零后续；不自动翻页/轮询（调用计数锁定）', async () => {
  await withFreshService({ listRoot: false }, async (service, env) => {
    await assert.rejects(service.queryMilkTeaActivity('shop', {}, env.deps), business('SEASON_WISH_MILK_TEA_UNAVAILABLE'));
    assert.equal(env.listCalls, 1);
    assert.equal(env.snapshotCalls, 0);
    assert.equal(operateCount(env), 0);
  });
  await withFreshService({ listEnabled: false }, async (service, env) => {
    const result = await service.queryMilkTeaActivity('shop', {}, env.deps);
    assert.equal(result.kind, 'shop');
    assert.equal(env.listCalls, 1);
    assert.equal(operateCount(env), 1, 'enabled=false 不误拒');
  });
});

// ===== 手动操作：逐动作成功 + 资格拒绝 =====

test('开店/改名：店名校验、开业状态、改名冷却与官方编码向量', async () => {
  await withFreshService({}, async (service, env) => {
    const run = (action, input) => service.runManualMilkTeaAction(action, input, env.deps);

    // 店名长度 2-8 之外拒绝，零发包
    env.calls.length = 0;
    await assert.rejects(run('createShop', { shopName: '茶' }), business('SEASON_WISH_MILK_TEA_INVALID_NAME'));
    assert.equal(operateCount(env), 0);

    // 成功开店：cmd53 与官方向量逐字节一致
    env.calls.length = 0; env.operateRequests.length = 0;
    const created = await run('createShop', { shopName: '奶茶冲鸭' });
    assert.equal(created.ok, true);
    assert.equal(hex(env.operateRequests[0].buffer), '0895f98fc6071035f2090e0a0ce5a5b6e88cb6e586b2e9b8ad');
    assert.deepEqual(created.rewards, [{ itemId: TICKET, count: '20', name: '奶茶券' }]);

    // 已开业再开店拒绝；改名成功向量
    env.scenario.summary.shopOpenAt = nowSec() - 600;
    env.scenario.summary.shopName = '奶茶冲鸭';
    env.calls.length = 0;
    await assert.rejects(run('createShop', { shopName: '奶茶小铺' }), business('SEASON_WISH_MILK_TEA_ALREADY'));
    assert.equal(operateCount(env), 0);
    env.operateRequests.length = 0;
    const renamed = await run('renameShop', { shopName: '奶茶小铺' });
    assert.equal(renamed.ok, true);
    assert.equal(hex(env.operateRequests[0].buffer), '0895f98fc6071036fa090e0a0ce5a5b6e88cb6e5b08fe993ba');

    // 未开业改名拒绝；冷却中拒绝
    env.calls.length = 0;
    env.scenario.summary.shopOpenAt = 0;
    env.scenario.summary.shopName = '';
    await assert.rejects(run('renameShop', { shopName: '奶茶小铺' }), business('SEASON_WISH_MILK_TEA_INVALID_STATE'));
    env.scenario.summary.shopOpenAt = nowSec() - 600;
    env.scenario.summary.shopName = '奶茶冲鸭';
    env.scenario.summary.renameCdUntilAt = nowSec() + 3600;
    await assert.rejects(run('renameShop', { shopName: '奶茶小铺' }), business('SEASON_WISH_MILK_TEA_LIMIT'));
    // 服务端未返回店铺状态：拒绝
    env.scenario.summary = null;
    await assert.rejects(run('renameShop', { shopName: '奶茶小铺' }), business('SEASON_WISH_MILK_TEA_NO_STATE'));
    assert.equal(operateCount(env), 0, '全部拒绝路径零发包');
  });
});

test('雇佣：班次/槽位/成员/费用确认/余额逐项前置校验与官方向量', async () => {
  await withFreshService({}, async (service, env) => {
    const run = () => service.runManualMilkTeaAction('hire', {
      durationId: 1,
      hires: [{ slotIndex: 0, targetGid: '101' }],
      confirmedCosts: [{ itemId: TICKET, count: '40' }],
    }, env.deps);

    // 班次无效
    await assert.rejects(service.runManualMilkTeaAction('hire', {
      durationId: 9, hires: [{ slotIndex: 0, targetGid: '101' }], confirmedCosts: [],
    }, env.deps), business('SEASON_WISH_MILK_TEA_INVALID_INPUT'));
    // 目标为空
    await assert.rejects(service.runManualMilkTeaAction('hire', {
      durationId: 1, hires: [], confirmedCosts: [],
    }, env.deps), business('SEASON_WISH_MILK_TEA_INVALID_INPUT'));
    assert.equal(operateCount(env), 0);

    // 槽位被占（员工在岗）
    env.scenario.operateBodies[55].milk_tea_get_shop.shop.slots[0].employee = { gid: 999, name: '在岗' };
    await assert.rejects(run(), business('SEASON_WISH_MILK_TEA_INVALID_STATE'));
    delete env.scenario.operateBodies[55].milk_tea_get_shop.shop.slots[0].employee;

    // 成员不在本次候选列表（候选人 gid 102 未下发）
    env.scenario.operateBodies[56].milk_tea_get_hire_list.robots = [
      { friend: { gid: 102, name: '实习员工' }, is_robot: true, state: 0 },
    ];
    await assert.rejects(run(), business('SEASON_WISH_MILK_TEA_INVALID_STATE'));
    env.scenario.operateBodies[56].milk_tea_get_hire_list.robots = [
      { friend: { gid: 101, name: '实习员工' }, is_robot: true, state: 0 },
    ];

    // 费用与确认值不一致
    env.scenario.bagItems = [{ id: TICKET, count: '500', uid: '1' }];
    await assert.rejects(service.runManualMilkTeaAction('hire', {
      durationId: 1, hires: [{ slotIndex: 0, targetGid: '101' }],
      confirmedCosts: [{ itemId: TICKET, count: '39' }],
    }, env.deps), business('SEASON_WISH_MILK_TEA_COST_CHANGED'));
    // 余额不足
    env.scenario.bagItems = [{ id: TICKET, count: '10', uid: '1' }];
    await assert.rejects(run(), business('SEASON_WISH_MILK_TEA_INSUFFICIENT'));
    // 资格核对允许有界前置读（cmd55/56）；拒绝路径一律零「写」请求（cmd57）
    assert.equal(env.operateRequests.filter(req => req.cmd === 57).length, 0, '所有资格拒绝零写请求');

    // 成功：先读店铺视图与候选（cmd55+56），写雇佣 cmd57 与官方向量一致
    env.scenario.bagItems = [{ id: TICKET, count: '500', uid: '1' }];
    env.calls.length = 0; env.operateRequests.length = 0;
    const hired = await run();
    assert.equal(hired.ok, true);
    assert.deepEqual(env.operateRequests.map(req => req.cmd), [55, 56, 57]);
    assert.equal(hex(env.operateRequests[2].buffer), '0895f98fc6071039920a080a06080010011865');
    assert.equal(hired.results[0].success, true);
  });
});

test('雇佣空位：等级容量减去有效班次，稀疏列表和到期残留在读取与写前校验中一致', async () => {
  // 注入时钟落后真实墙钟一小时（仍在营业窗口内）：表值与 env.deps.now 同源，避免异步装配跨整秒后未来班次提前到截止
  const fixtureClock = nowSec() - 3600;
  const cases = [
    { name: '一级空列表', level: 1, slots: [], free: [0] },
    { name: '二级省略空列表', level: 2, free: [0] },
    { name: '三级无人', level: 3, slots: [], free: [0, 1] },
    { name: '三级零号在岗', level: 3, slots: [{ slot_index: 0, employee: { gid: 7001 }, end_at: fixtureClock + 60 }], free: [1] },
    { name: '三级一号机器人在岗', level: 3, slots: [{ slot_index: 1, is_robot: true, end_at: fixtureClock + 60 }], free: [0] },
    { name: '截止时释放机器人残留', level: 1, slots: [{ slot_index: 0, is_robot: true, employee: { gid: 7002 }, shift_id: 8001, end_at: fixtureClock }], free: [0] },
    { name: '空员工对象不是占岗', level: 1, slots: [{ slot_index: 0, employee: {} }], free: [0] },
    { name: '缺员工但班次未结束', level: 1, slots: [{ slot_index: 0, end_at: fixtureClock + 1 }], free: [] },
    { name: '缺员工班次到截止释放', level: 1, slots: [{ slot_index: 0, end_at: fixtureClock }], free: [0] },
    { name: '缺员工班次已结束释放', level: 1, slots: [{ slot_index: 0, end_at: fixtureClock - 1 }], free: [0] },
    { name: '缺结束时间的在岗员工', level: 1, slots: [{ slot_index: 0, employee: { gid: 7003 } }], free: [] },
    { name: '未知等级不猜容量', level: 99, slots: [], free: [], unknown: true },
    { name: '异常索引不猜占用', level: 1, slots: [{ slot_index: 3 }], free: [], unknown: true },
    { name: '重复索引不忽略冲突', level: 1, slots: [{ slot_index: 0 }, { slot_index: 0 }], free: [], unknown: true },
  ];
  for (const row of cases) {
    await withFreshService({ clock: fixtureClock }, async (service, env) => {
      const shop = { level: row.level, ...(row.slots ? { slots: row.slots } : {}) };
      env.scenario.operateBodies[55] = { milk_tea_get_shop: { shop } };
      const result = await service.queryMilkTeaActivity('shop', {}, env.deps);
      assert.equal(result.data.slotAvailabilityKnown, !row.unknown, row.name);
      assert.equal(result.data.employeeSlotCount, row.level === 99 ? null : row.level >= 3 ? 2 : 1, row.name);
      assert.deepEqual(result.data.freeSlotIndexes, row.free, row.name);
      assert.equal(env.operateRequests.filter(req => req.cmd === 57).length, 0, '查询不雇佣');
      const slotIndex = row.free[0] ?? 0;
      env.scenario.operateBodies[57].milk_tea_hire.results = [{ slot_index: slotIndex, duration_id: 1, target_gid: 101, success: true }];
      const run = () => service.runManualMilkTeaAction('hire', {
        durationId: 1, hires: [{ slotIndex, targetGid: '101' }], confirmedCosts: [{ itemId: TICKET, count: '40' }],
      }, env.deps);
      if (row.free.length) {
        const hired = await run(); assert.equal(hired.ok, true, row.name);
        assert.deepEqual(env.operateRequests.slice(-3).map(req => req.cmd), [55, 56, 57]);
        assert.equal(Number(types.MilkTeaOperateRequest.decode(env.operateRequests.at(-1).buffer).milk_tea_hire.hires[0].slot_index), slotIndex);
      }
      else {
        await assert.rejects(run(), business(row.unknown ? 'SEASON_WISH_MILK_TEA_NO_STATE' : 'SEASON_WISH_MILK_TEA_INVALID_STATE'), row.name);
        assert.equal(env.operateRequests.filter(req => req.cmd === 57).length, 0, row.name);
      }
    });
  }
});

test('雇佣写前重新读取占用，未解锁槽位和已被占用的旧空位均零写', async () => {
  await withFreshService({}, async (service, env) => {
    env.scenario.operateBodies[55].milk_tea_get_shop.shop.slots = [];
    const initial = await service.queryMilkTeaActivity('shop', {}, env.deps);
    assert.deepEqual(initial.data.freeSlotIndexes, [0]);
    const run = slotIndex => service.runManualMilkTeaAction('hire', {
      durationId: 1, hires: [{ slotIndex, targetGid: '101' }], confirmedCosts: [{ itemId: TICKET, count: '40' }],
    }, env.deps);
    await assert.rejects(run(1), business('SEASON_WISH_MILK_TEA_INVALID_STATE'));
    env.scenario.operateBodies[55].milk_tea_get_shop.shop.slots = [{ slot_index: 0, end_at: nowSec() + 60 }];
    await assert.rejects(run(0), business('SEASON_WISH_MILK_TEA_INVALID_STATE'));
    assert.equal(env.operateRequests.filter(req => req.cmd === 57).length, 0);
    assert.equal(env.operateRequests.filter(req => req.cmd === 55).length, 3, '每次提交都读当前店铺');
  });
});

test('收银台/升级/喇叭/工坊加工：前置状态与官方向量', async () => {
  await withFreshService({}, async (service, env) => {
    const run = (action, input) => service.runManualMilkTeaAction(action, input, env.deps);

    // 收银台：无收益时拒绝；结算视图有合格收益仍可领取
    env.scenario.operateBodies[55].milk_tea_get_shop.shop.pending_rewards = [];
    await assert.rejects(run('claimCashier', {}), business('SEASON_WISH_MILK_TEA_NO_CLAIMABLE'));
    env.scenario.operateBodies[55].milk_tea_get_shop.shop.pending_rewards = [{ id: TICKET, count: '10' }];
    env.scenario.operateBodies[55].milk_tea_get_shop.shop.is_settling = true;
    env.operateRequests.length = 0;
    const cashier = await run('claimCashier', {});
    assert.equal(cashier.ok, true);
    assert.deepEqual(cashier.rewards, [{ itemId: TICKET, count: '10', name: '奶茶券' }]);

    // 升级：资格取根快照摘要 canUpgrade（cmd55 回包无该字段）；未达标拒绝；达标成功
    env.scenario.summary.canUpgrade = false;
    await assert.rejects(run('upgrade', {}), business('SEASON_WISH_MILK_TEA_INVALID_STATE'));
    env.scenario.summary.canUpgrade = true;
    const upgraded = await run('upgrade', {});
    assert.equal(upgraded.level, 3);

    // 喇叭：数量域、余额、费用确认
    await assert.rejects(run('boost', { count: 0 }), business('SEASON_WISH_MILK_TEA_INVALID_INPUT'));
    await assert.rejects(run('boost', { count: 101 }), business('SEASON_WISH_MILK_TEA_INVALID_INPUT'));
    env.scenario.bagItems = [{ id: BOOST, count: '0', uid: '2' }];
    await assert.rejects(run('boost', { count: 1 }), business('SEASON_WISH_MILK_TEA_INSUFFICIENT'));
    env.scenario.bagItems = [{ id: BOOST, count: '10', uid: '2' }];
    await assert.rejects(run('boost', { count: 1, confirmedCosts: [{ itemId: BOOST, count: '2' }] }), business('SEASON_WISH_MILK_TEA_COST_CHANGED'));
    env.operateRequests.length = 0;
    const boosted = await run('boost', { count: 1, confirmedCosts: [{ itemId: BOOST, count: '1' }] });
    assert.equal(boosted.ok, true);
    assert.equal(boosted.cups, 40);
    assert.equal(hex(env.operateRequests[0].buffer), '0895f98fc607103caa0a020801');

    // 加工：条目唯一、配方已知、果实归属、数量一致
    await assert.rejects(run('craft', { fruitUids: ['23563', '23563'] }), business('SEASON_WISH_MILK_TEA_INVALID_INPUT'));
    await assert.rejects(run('craft', { fruitUids: ['23563'], recipeId: 99 }), business('SEASON_WISH_MILK_TEA_INVALID_INPUT'));
    await assert.rejects(run('craft', { fruitUids: ['40404'], recipeId: 2 }), business('SEASON_WISH_MILK_TEA_INVALID_STATE'));
    await assert.rejects(run('craft', { fruitUids: ['23563', '23564'], recipeId: 2 }), business('SEASON_WISH_MILK_TEA_INVALID_STATE'));
    env.operateRequests.length = 0;
    env.scenario.bagItems = [{ id: 40525, count: '7', uid: '23563' }];
    const crafted = await run('craft', { fruitUids: ['23563'], recipeId: 2 });
    assert.equal(crafted.ok, true);
    assert.deepEqual(crafted.craftedCups, { '2': 20 });
    assert.equal(hex(env.operateRequests.find(row => row.cmd === 62).buffer), '0895f98fc607103eba0a050a038bb801');
    assert.equal(env.operateRequests.filter(r => r.cmd === 62).length, 1, '加工恰好一次写');
  });
});

test('工资/互动/雇佣开关：班次校验、互动选项、玩法输赢与官方向量', async () => {
  await withFreshService({}, async (service, env) => {
    const run = (action, input) => service.runManualMilkTeaAction(action, input, env.deps);
    const shift = () => env.scenario.operateBodies[63].milk_tea_get_work_page.my_shift;

    // 工资：无可领拒绝；有工资单成功
    env.scenario.summary.hasUnclaimedWage = false;
    env.scenario.operateBodies[63].milk_tea_get_work_page.slips = [];
    env.scenario.operateBodies[63].milk_tea_get_work_page.my_shift = null;
    await assert.rejects(run('claimWages', {}), business('SEASON_WISH_MILK_TEA_INVALID_STATE'));
    env.scenario.operateBodies[63].milk_tea_get_work_page.slips = [
      { employer: { gid: 101, name: '老板' }, shop_name: '奶茶冲鸭', shift_id: 2001, wages: { base_wage: 10, final_wage: 12 } },
    ];
    env.scenario.summary.hasUnclaimedWage = true;
    const wages = await run('claimWages', {});
    assert.equal(wages.ok, true);
    assert.equal(wages.claimedCount, 1);

    // 互动：无班次拒绝；班次变化拒绝；次数用尽拒绝；选项外互动拒绝
    await assert.rejects(run('interact', { interactionType: 1 }), business('SEASON_WISH_MILK_TEA_INVALID_STATE'));
    env.scenario.operateBodies[63].milk_tea_get_work_page.my_shift = {
      employer: { gid: 101, name: '老板' }, shop_name: '奶茶冲鸭', shift_id: 3001,
      interact_count: 5, interact_limit: 5, wage_total: 40,
      interact_previews: [{ interaction_type: 1, promote_cups: 10 }],
    };
    await assert.rejects(run('interact', { interactionType: 1 }), business('SEASON_WISH_MILK_TEA_LIMIT'));
    shift().interact_count = 0;
    await assert.rejects(run('interact', { interactionType: 9 }), business('SEASON_WISH_MILK_TEA_INVALID_INPUT'));
    await assert.rejects(run('interact', { interactionType: 1, shiftId: 9999 }), business('SEASON_WISH_MILK_TEA_INVALID_STATE'));
    // 成功：目标由班次雇主解析（gid 101），与官方 interact 向量一致
    env.operateRequests.length = 0;
    const interacted = await run('interact', { interactionType: 1, shiftId: '3001' });
    assert.equal(interacted.ok, true);
    assert.equal(interacted.gameplaySuccess, true);
    assert.equal(hex(env.operateRequests.at(-1).buffer), '0895f98fc6071041d20a0408651001');
    // 玩法输赢 ≠ 请求失败：success=false 仍 ok=true
    env.scenario.operateBodies[65].milk_tea_interact.success = false;
    const lost = await run('interact', { interactionType: 1 });
    assert.equal(lost.ok, true);
    assert.equal(lost.gameplaySuccess, false);
    assert.equal(lost.message, '互动未生效（玩法结果，非请求失败）');

    // 雇佣开关：非布尔拒绝；已处于目标态拒绝；成功向量
    await assert.rejects(run('hireSetting', { hireDisabled: 'yes' }), business('SEASON_WISH_MILK_TEA_INVALID_INPUT'));
    env.scenario.summary.hireDisabled = true;
    await assert.rejects(run('hireSetting', { hireDisabled: true }), business('SEASON_WISH_MILK_TEA_ALREADY'));
    env.scenario.summary.hireDisabled = false;
    env.operateRequests.length = 0;
    const toggled = await run('hireSetting', { hireDisabled: true });
    assert.equal(toggled.ok, true);
    assert.equal(hex(env.operateRequests[0].buffer), '0895f98fc6071044ea0a020801');
  });
});

test('商城兑换：商品/钻石/条件/限购/费用确认/余额与官方 cmd1@102 编码', async () => {
  await withFreshService({}, async (service, env) => {
    const run = input => service.runManualMilkTeaAction('exchange', input, env.deps);
    env.scenario.bagItems = [{ id: TICKET, count: '500', uid: '1' }];

    await assert.rejects(run({ goodsId: 0, count: 1 }), business('SEASON_WISH_MILK_TEA_INVALID_INPUT'));
    await assert.rejects(run({ goodsId: 9001, count: 0 }), business('SEASON_WISH_MILK_TEA_INVALID_INPUT'));
    await assert.rejects(run({ goodsId: 9999, count: 1 }), business('SEASON_WISH_MILK_TEA_INVALID_INPUT'));
    // 钻石费用：未知/钻石成本一律阻止
    env.scenario.exchangeShop.items.push({
      id: 9003, name: '钻石包', rewards: [{ id: TICKET, count: '99' }],
      costs: [{ id: 1004, count: '10' }], purchaseLimit: 0, purchasedCount: 0, diamondCostCount: 0, condHints: [],
    });
    await assert.rejects(run({ goodsId: 9003, count: 1, confirmedCosts: [{ itemId: 1004, count: '10' }] }), business('SEASON_WISH_MILK_TEA_DIAMOND_BLOCKED'));
    // 条件未满足
    env.scenario.exchangeShop.items[0].condHints = [{ condType: 'shop_level', satisfied: false, current: 1, target: 2 }];
    await assert.rejects(run({ goodsId: 9001, count: 1, confirmedCosts: [{ itemId: TICKET, count: '10' }] }), business('SEASON_WISH_MILK_TEA_CONDITION'));
    env.scenario.exchangeShop.items[0].condHints = [];
    // 限购
    env.scenario.exchangeShop.items[0].purchaseLimit = 1;
    env.scenario.exchangeShop.items[0].purchasedCount = 1;
    await assert.rejects(run({ goodsId: 9001, count: 1, confirmedCosts: [{ itemId: TICKET, count: '10' }] }), business('SEASON_WISH_MILK_TEA_LIMIT'));
    env.scenario.exchangeShop.items[0].purchaseLimit = 5;
    env.scenario.exchangeShop.items[0].purchasedCount = 0;
    // 费用不一致 / 余额不足
    await assert.rejects(run({ goodsId: 9002, count: 1, confirmedCosts: [{ itemId: TICKET, count: '9' }] }), business('SEASON_WISH_MILK_TEA_COST_CHANGED'));
    env.scenario.bagItems = [{ id: TICKET, count: '5', uid: '1' }];
    await assert.rejects(run({ goodsId: 9002, count: 1, confirmedCosts: [{ itemId: TICKET, count: '10' }] }), business('SEASON_WISH_MILK_TEA_INSUFFICIENT'));
    assert.equal(operateCount(env), 0, '全部写前拒绝零发包');

    // 成功：shop_buy 选择子挂在商城子活动 2026110102
    env.scenario.bagItems = [{ id: TICKET, count: '500', uid: '1' }];
    env.operateRequests.length = 0;
    const exchanged = await run({ goodsId: 9002, count: 2, confirmedCosts: [{ itemId: TICKET, count: '20' }] });
    assert.equal(exchanged.ok, true);
    assert.equal(env.operateRequests[0].activityId, SHOP);
    assert.equal(env.operateRequests[0].cmd, 1);
    const decoded = types.MilkTeaOperateRequest.decode(env.operateRequests[0].buffer);
    assert.equal(Number(decoded.shop_buy.goods_id), 9002);
    assert.equal(Number(decoded.shop_buy.count), 2);
  });
});

test('基金/快乐值：解锁与档位资格、cmd76 空参请求、cmd71/74 目标活动', async () => {
  await withFreshService({}, async (service, env) => {
    const run = (action, input) => service.runManualMilkTeaAction(action, input, env.deps);

    // 基金未解锁 / 无可领档位
    env.scenario.growthFund.unlocked = false;
    await assert.rejects(run('fundClaim', {}), business('SEASON_WISH_MILK_TEA_INVALID_STATE'));
    env.scenario.growthFund.unlocked = true;
    env.scenario.growthFund.tiers[0].conditions[0].reached = false;
    await assert.rejects(run('fundClaim', {}), business('SEASON_WISH_MILK_TEA_INVALID_STATE'));
    env.scenario.growthFund.tiers[0].conditions[0].reached = true;
    env.operateRequests.length = 0;
    const fund = await run('fundClaim', {});
    assert.equal(fund.ok, true);
    assert.deepEqual(fund.claimedTierIds, [1]);
    assert.equal(env.operateRequests[0].activityId, FUND);
    assert.equal(env.operateRequests[0].cmd, 76);
    const decodedFund = types.MilkTeaOperateRequest.decode(env.operateRequests[0].buffer);
    assert.equal(decodedFund.growth_fund_claim, undefined, 'cmd76 请求无选择子字段');

    // 快乐值每日：已领 / 次数用尽 / 成功
    env.scenario.shareReward.daily.rewardClaimed = true;
    await assert.rejects(run('shareDaily', {}), business('SEASON_WISH_MILK_TEA_CLAIMED'));
    env.scenario.shareReward.daily.rewardClaimed = false;
    env.scenario.shareReward.daily.claimedCount = 1;
    env.scenario.shareReward.daily.claimLimit = 1;
    await assert.rejects(run('shareDaily', {}), business('SEASON_WISH_MILK_TEA_LIMIT'));
    env.scenario.shareReward.daily.claimedCount = 0;
    env.operateRequests.length = 0;
    const daily = await run('shareDaily', {});
    assert.equal(daily.ok, true);
    assert.equal(env.operateRequests[0].activityId, HAPPY);
    assert.equal(env.operateRequests[0].cmd, 74);

    // 档位：无可领（state=1）拒绝；可领成功（state=2 且分数达标）
    env.scenario.shareReward.milestones[0].state = 1;
    await assert.rejects(run('shareMilestones', {}), business('SEASON_WISH_MILK_TEA_NO_CLAIMABLE'));
    env.scenario.shareReward.milestones[0].state = 2;
    env.operateRequests.length = 0;
    const tiers = await run('shareMilestones', {});
    assert.equal(tiers.ok, true);
    assert.equal(env.operateRequests[0].cmd, 71);

    // 未知动作：零读取零发包
    env.listCalls = 0;
    await assert.rejects(run('magicWish', {}), business('SEASON_WISH_MILK_TEA_UNKNOWN_ACTION'));
    assert.equal(env.listCalls, 0);
  });
});

// ===== 时间边界 =====

test('营业开始前/结算期/最终截止：逐相位拒绝与放行集合', async () => {
  const start = nowSec() + 86400;
  const end = start + 20 * 86400;
  await withFreshService({ start, end, settle: end - 4 * 86400, clock: nowSec() }, async (service, env) => {
    const run = action => service.runManualMilkTeaAction(action, { shopName: '奶茶冲鸭' }, env.deps);
    // 营业开始前：全部动作与查询拒绝
    await assert.rejects(run('createShop'), business('SEASON_WISH_MILK_TEA_NOT_STARTED'));
    await assert.rejects(service.queryMilkTeaActivity('shop', {}, env.deps), business('SEASON_WISH_MILK_TEA_NOT_STARTED'));
    assert.equal(env.snapshotCalls, 0, '开始前在 List 根时间即拒绝，零根读取');
    assert.equal(operateCount(env), 0);
  });

  // 结算期：营业类动作停止；种子兑换停止；非种子兑换/领取/工资/基金/快乐值保留
  const window = OPEN_WINDOW();
  await withFreshService({ ...window, clock: window.settle }, async (service, env) => {
    const run = (action, input = {}) => service.runManualMilkTeaAction(action, input, env.deps);
    for (const action of ['createShop', 'renameShop', 'hire', 'boost', 'upgrade', 'craft', 'interact', 'hireSetting']) {
      env.calls.length = 0;
      await assert.rejects(
        run(action, action === 'craft' ? { fruitUids: ['23563'] } : { shopName: '奶茶冲鸭', count: 1 }),
        business('SEASON_WISH_MILK_TEA_SETTLING'),
        `${action} 结算期停止`,
      );
      assert.equal(operateCount(env), 0);
    }
    env.scenario.operateBodies[55].milk_tea_get_shop.shop.is_settling = true;
    // 种子兑换停止
    env.scenario.bagItems = [{ id: TICKET, count: '500', uid: '1' }];
    await assert.rejects(
      run('exchange', { goodsId: 9001, count: 1, confirmedCosts: [{ itemId: TICKET, count: '10' }] }),
      business('SEASON_WISH_MILK_TEA_SETTLING_SEEDS'),
    );
    // 非种子兑换、合格领取仍可用
    env.operateRequests.length = 0;
    const exchanged = await run('exchange', { goodsId: 9002, count: 1, confirmedCosts: [{ itemId: TICKET, count: '10' }] });
    assert.equal(exchanged.ok, true);
    assert.equal((await run('claimCashier', {})).ok, true);
    assert.equal((await run('claimWages', {})).ok, true);
    assert.equal((await run('fundClaim', {})).ok, true);
    assert.equal((await run('shareDaily', {})).ok, true);
    assert.equal((await run('shareMilestones', {})).ok, true);
    // 查询在结算期仍可读
    assert.equal((await service.queryMilkTeaActivity('shop', {}, env.deps)).kind, 'shop');
  });

  // 最终截止（闭边界 clock === end）：List 根时间即拒绝，零根读取零发包
  const openWindow = OPEN_WINDOW();
  await withFreshService({ ...openWindow, clock: openWindow.end }, async (service, env) => {
    await assert.rejects(
      service.runManualMilkTeaAction('createShop', { shopName: '奶茶冲鸭' }, env.deps),
      business('SEASON_WISH_MILK_TEA_ENDED'),
    );
    await assert.rejects(service.queryMilkTeaActivity('shop', {}, env.deps), business('SEASON_WISH_MILK_TEA_ENDED'));
    assert.equal(env.snapshotCalls, 0);
    assert.equal(operateCount(env), 0);
  });
});

test('读取过程中跨边界：跨入最终截止/结算期零后续写', async () => {
  const window = OPEN_WINDOW();
  // List 后（读取 queryShop 回包时）跨入最终截止 → 零雇佣写
  await withFreshService({ ...window, advanceOnCmd: 55, advanceSeconds: window.end - nowSec() + 10 }, async (service, env) => {
    env.scenario.bagItems = [{ id: TICKET, count: '500', uid: '1' }];
    await assert.rejects(
      service.runManualMilkTeaAction('hire', {
        durationId: 1, hires: [{ slotIndex: 0, targetGid: '101' }],
        confirmedCosts: [{ itemId: TICKET, count: '40' }],
      }, env.deps),
      business('SEASON_WISH_MILK_TEA_ENDED'),
    );
    assert.deepEqual(env.operateRequests.map(req => req.cmd), [55], '前置读后即停，零写');
  });
  // 根快照读取后跨入结算期 → 营业动作停止
  const window2 = OPEN_WINDOW();
  await withFreshService({ ...window2, advanceSeconds: window2.settle - nowSec() }, async (service, env) => {
    await assert.rejects(
      service.runManualMilkTeaAction('createShop', { shopName: '奶茶冲鸭' }, env.deps),
      business('SEASON_WISH_MILK_TEA_SETTLING'),
    );
    assert.equal(operateCount(env), 0);
  });
});

// ===== 租约 =====

test('Symbol 租约：首个 await 前持有；忙拒绝不排队；成功/拒绝/未知后释放', async () => {
  await withFreshService({}, async (service, env) => {
    let releaseList;
    env.scenario.blockList = new Promise(resolve => { releaseList = resolve; });
    env.scenario.summary.shopOpenAt = 0;
    const first = service.runManualMilkTeaAction('createShop', { shopName: '奶茶冲鸭' }, env.deps);
    await new Promise(resolve => setImmediate(resolve));
    // 首个 await（List）尚未返回，租约已持有：并发查询与操作均忙拒绝、不排队
    env.listCalls = 0;
    await assert.rejects(service.queryMilkTeaActivity('shop', {}, env.deps), business('SEASON_WISH_MILK_TEA_BUSY'));
    await assert.rejects(
      service.runManualMilkTeaAction('boost', { count: 1, confirmedCosts: [{ itemId: BOOST, count: '1' }] }, env.deps),
      business('SEASON_WISH_MILK_TEA_BUSY'),
    );
    assert.equal(env.listCalls, 0, '忙拒绝不产生新读取');
    releaseList();
    assert.equal((await first).ok, true);
    // 成功后释放：下一个操作可获取
    assert.equal((await service.runManualMilkTeaAction('boost', {
      count: 1, confirmedCosts: [{ itemId: BOOST, count: '1' }],
    }, env.deps)).ok, true);
    // 业务拒绝后释放
    await assert.rejects(service.runManualMilkTeaAction('boost', { count: 0 }, env.deps), business('SEASON_WISH_MILK_TEA_INVALID_INPUT'));
    assert.equal((await service.queryMilkTeaActivity('shop', {}, env.deps)).kind, 'shop');
    // 结果未知（传输失败）后也释放
    env.scenario.failOperate = 'transport';
    const unknown = await service.runManualMilkTeaAction('boost', {
      count: 1, confirmedCosts: [{ itemId: BOOST, count: '1' }],
    }, env.deps);
    assert.equal(unknown.outcome, 'unknown');
    env.scenario.failOperate = null;
    assert.equal((await service.queryMilkTeaActivity('shop', {}, env.deps)).kind, 'shop');
    // 异常（读取抛普通错误）后释放
    env.scenario.blockList = Promise.reject(new Error('list down'));
    await assert.rejects(service.runManualMilkTeaAction('boost', {
      count: 1, confirmedCosts: [{ itemId: BOOST, count: '1' }],
    }, env.deps), /list down/);
    env.scenario.blockList = null;
    assert.equal((await service.queryMilkTeaActivity('shop', {}, env.deps)).kind, 'shop');
  });
});

// ===== 跨 await 连接所有权与就绪 =====

test('连接/就绪：入口捕获，每个 await 后复查；换连接或失去就绪零后续读写', async () => {
  await withFreshService({ ready: false }, async (service, env) => {
    // 入口未就绪：零读取
    await assert.rejects(service.runManualMilkTeaAction('boost', { count: 1 }, env.deps), business('SEASON_WISH_MILK_TEA_NOT_READY'));
    await assert.rejects(service.queryMilkTeaActivity('shop', {}, env.deps), business('SEASON_WISH_MILK_TEA_NOT_READY'));
    assert.equal(env.listCalls, 0);
    assert.equal(operateCount(env), 0);
  });
  await withFreshService({ swapConnectionAfterList: true }, async (service, env) => {
    // List 后连接更换：零根读取零发包
    await assert.rejects(service.runManualMilkTeaAction('boost', { count: 1 }, env.deps), business('SEASON_WISH_MILK_TEA_CONNECTION_CHANGED'));
    await assert.rejects(service.queryMilkTeaActivity('shop', {}, env.deps), business('SEASON_WISH_MILK_TEA_CONNECTION_CHANGED'));
    assert.equal(env.snapshotCalls, 0);
    assert.equal(operateCount(env), 0);
  });
  await withFreshService({ loseReadyAfterSnapshot: true }, async (service, env) => {
    // 根快照后失去就绪：零发包
    await assert.rejects(service.runManualMilkTeaAction('boost', { count: 1 }, env.deps), business('SEASON_WISH_MILK_TEA_NOT_READY'));
    assert.equal(operateCount(env), 0);
  });
  // 雇佣前置读（cmd55）后换连接：零雇佣写
  await withFreshService({ advanceOnCmd: 0, advanceSeconds: 0 }, async (service, env) => {
    env.scenario.bagItems = [{ id: TICKET, count: '500', uid: '1' }];
    // 在 cmd55 回包时换连接：借助 advanceOnCmd 钩子位置的既有机制不可用，直接改网络替身
    let shopReadCount = 0;
    env.network.sendMsgAsync = async (_service, method, payload) => {
      env.calls.push(method);
      const req = types.MilkTeaOperateRequest.decode(payload);
      const cmd = Number(req.operate_type);
      env.operateRequests.push({ activityId: Number(req.activity_id), cmd, buffer: payload });
      if (cmd === 55) shopReadCount += 1;
      if (cmd === 56) env.swapConnection(); // 候选读取完成后、雇佣写之前换连接
      const replyPayload = { activity_id: req.activity_id, operate_type: cmd, ...env.scenario.operateBodies[cmd] };
      return { body: types.MilkTeaOperateReply.encode(types.MilkTeaOperateReply.create(replyPayload)).finish() };
    };
    await assert.rejects(
      service.runManualMilkTeaAction('hire', {
        durationId: 1, hires: [{ slotIndex: 0, targetGid: '101' }],
        confirmedCosts: [{ itemId: TICKET, count: '40' }],
      }, env.deps),
      business('SEASON_WISH_MILK_TEA_CONNECTION_CHANGED'),
    );
    assert.deepEqual(env.operateRequests.map(req => req.cmd), [55, 56], '前置读完成即停，零写');
    assert.ok(shopReadCount >= 1);
  });
});

// ===== 结果存在性与未知结果 =====

test('写后失败：传输/回显不匹配/缺结果体 = 结果未知；恰好一次写零重试', async () => {
  await withFreshService({}, async (service, env) => {
    const run = () => service.runManualMilkTeaAction('boost', {
      count: 1, confirmedCosts: [{ itemId: BOOST, count: '1' }],
    }, env.deps);
    env.scenario.bagItems = [{ id: BOOST, count: '10', uid: '2' }];

    // 传输失败
    env.scenario.failOperate = 'transport';
    env.calls.length = 0;
    let outcome = await run();
    assert.equal(outcome.outcome, 'unknown');
    assert.equal(outcome.ok, false);
    assert.equal(outcome.command, 60);
    assert.equal(operateCount(env), 1, '不自动重试');

    // 回显不匹配（写路径）：可能已执行 → 未知而非业务拒绝
    env.scenario.failOperate = 'echoMismatch';
    env.calls.length = 0;
    outcome = await run();
    assert.equal(outcome.outcome, 'unknown');
    assert.equal(operateCount(env), 1);

    // 回复缺结果体：未知
    env.scenario.failOperate = 'dropBody';
    env.calls.length = 0;
    outcome = await run();
    assert.equal(outcome.outcome, 'unknown');
    assert.equal(operateCount(env), 1);
    env.scenario.failOperate = null;

    env.scenario.operateBodies[55].milk_tea_get_shop.shop.level = 3;
    env.scenario.operateBodies[55].milk_tea_get_shop.shop.slots.push({ slot_index: 1 });
    env.scenario.operateBodies[56].milk_tea_get_hire_list.robots.push({ friend: { gid: 102 } });
    env.scenario.bagItems.push({ id: TICKET, count: '500', uid: '1' });
    // 雇佣部分失败：ok=false 且逐条报告，不虚报全部成功
    env.scenario.operateBodies[57].milk_tea_hire.results = [
      { slot_index: 0, duration_id: 1, target_gid: 101, success: true },
      { slot_index: 1, duration_id: 1, target_gid: 102, success: false, error_code: 3, error_msg: '槽位已占用' },
    ];
    const hired = await service.runManualMilkTeaAction('hire', {
      durationId: 1,
      hires: [{ slotIndex: 0, targetGid: '101' }, { slotIndex: 1, targetGid: '102' }],
      confirmedCosts: [{ itemId: TICKET, count: '80' }],
    }, env.deps);
    assert.equal(hired.ok, false);
    assert.equal(hired.results.length, 2);
    assert.deepEqual(hired.results.map(row => row.success), [true, false]);
    assert.equal(hired.results[1].errorCode, 3);
  });
});

// ===== 管理路由与共享缓存 =====

function fakeApp() {
  const routes = new Map();
  return {
    routes,
    get(path, handler) { routes.set(`GET ${path}`, handler); },
    post(path, handler) { routes.set(`POST ${path}`, handler); },
  };
}

function fakeRes() {
  const state = { status: 200, body: null, ended: false };
  return {
    state,
    status(code) { state.status = code; return this; },
    json(body) { state.body = body; state.ended = true; return this; },
  };
}

function setupRoutes(provider, options = {}) {
  const app = fakeApp();
  app.reader = createActivityReadCache({ ttlMs: 60_000 });
  const allowed = new Set(options.allowed || ['acc-1', 'acc-2']);
  registerAdminMilkTeaActivityRoutes({
    app,
    provider,
    getAccountIdFromRequest: req => req.headers['x-account-id'] || '',
    canAccessAccount: (req, accountId) => allowed.has(accountId),
    sendProviderError: (res, err) => res.status(502).json({ ok: false, error: String(err && err.message || err) }),
    activityReader: app.reader,
  });
  return app;
}

test('管理路由：鉴权/访问/连接/运行序前置，零上游；业务码与普通错误分层', async () => {
  const providerCalls = [];
  const provider = {
    getStatus: _id => ({ connection: { connected: provider.connected !== false } }),
    isAccountRunning: async id => { providerCalls.push(['isAccountRunning', id]); return provider.running !== false; },
    getMilkTeaActivity: async id => { providerCalls.push(['getMilkTeaActivity', id]); return { timing: { phase: 'open' }, marker: 'fresh' }; },
    queryMilkTeaActivity: async (id, kind, params) => { providerCalls.push(['queryMilkTeaActivity', id, kind, params]); return { kind, data: {} }; },
    operateMilkTea: async (id, action, input) => { providerCalls.push(['operateMilkTea', id, action, input]); return provider.operateResult; },
  };
  const app = setupRoutes(provider);
  const get = async (headers = { 'x-account-id': 'acc-1' }) => {
    const res = fakeRes();
    await app.routes.get('GET /api/activity/milk-tea')({ headers }, res);
    return res.state;
  };
  const postQuery = async (body, headers = { 'x-account-id': 'acc-1' }) => {
    const res = fakeRes();
    await app.routes.get('POST /api/activity/milk-tea/query')({ headers, body }, res);
    return res.state;
  };
  const postOperate = async (body, headers = { 'x-account-id': 'acc-1' }) => {
    const res = fakeRes();
    await app.routes.get('POST /api/activity/milk-tea/operate')({ headers, body }, res);
    return res.state;
  };

  // 鉴权失败：零上游
  providerCalls.length = 0;
  assert.equal((await get({})).status, 400);
  assert.equal((await get({ 'x-account-id': 'stranger' })).status, 403);
  assert.deepEqual(providerCalls, []);

  // 连接失败（未连上游）与未运行：零上游请求
  provider.connected = false;
  const disconnected = await get();
  assert.deepEqual(disconnected.body, { ok: false, error: '获取奶茶热销中失败: 账号未运行' });
  assert.deepEqual(providerCalls, []);
  provider.connected = true;
  provider.running = false;
  assert.equal((await get()).status, 200);
  assert.deepEqual(providerCalls, [['isAccountRunning', 'acc-1']], '仅本地运行检查，零游戏上游');
  provider.running = true;

  // 下游错误分层：业务拒绝（List 不下发）→ unavailable 语义；普通失败 → 502
  provider.getMilkTeaActivity = async () => {
    const err = new Error('奶茶热销中未由当前 ActivityService.List 下发，停止读取活动详情');
    throw err;
  };
  const unavailable = await get();
  assert.deepEqual(unavailable.body, { ok: false, unavailable: true, error: '奶茶热销中未由当前 ActivityService.List 下发，停止读取活动详情' });
  app.reader.clear('acc-1');
  provider.getMilkTeaActivity = async () => { throw new Error('connection reset'); };
  assert.equal((await get()).status, 502);
  app.reader.clear('acc-1');
  provider.getMilkTeaActivity = async id => { providerCalls.push(['getMilkTeaActivity', id]); return { timing: { phase: 'open' }, marker: 'fresh' }; };

  // 查询路由：未知类型 400 零上游；业务拒绝 400 + 固定码；普通失败 502 无码
  providerCalls.length = 0;
  assert.equal((await postQuery({ kind: 'hack' })).status, 400);
  assert.deepEqual(providerCalls, []);
  provider.queryMilkTeaActivity = async () => {
    const err = new Error('奶茶热销中已过最终截止时间，停止新增玩法读取');
    err.business = true; err.code = 'SEASON_WISH_MILK_TEA_ENDED';
    throw err;
  };
  const ended = await postQuery({ kind: 'shop', params: {} });
  assert.equal(ended.status, 400);
  assert.equal(ended.body.code, 'SEASON_WISH_MILK_TEA_ENDED');
  provider.queryMilkTeaActivity = async (id, kind, params) => { providerCalls.push(['queryMilkTeaActivity', id, kind, params]); return { kind, data: {} }; };

  // 操作路由：未知动作 400 零上游；业务码 400；普通错误 502
  providerCalls.length = 0;
  assert.equal((await postOperate({ action: 'hack' })).status, 400);
  assert.deepEqual(providerCalls, []);
  provider.operateResult = null;
  provider.operateMilkTea = async () => {
    const err = new Error('费用与确认值不一致，请刷新后重新确认');
    err.business = true; err.code = 'SEASON_WISH_MILK_TEA_COST_CHANGED';
    throw err;
  };
  const rejected = await postOperate({ action: 'boost', input: { count: 1 } });
  assert.equal(rejected.status, 400);
  assert.equal(rejected.body.code, 'SEASON_WISH_MILK_TEA_COST_CHANGED');
  provider.operateMilkTea = async (id, action, input) => { providerCalls.push(['operateMilkTea', id, action, input]); return provider.operateResult; };
});

test('共享缓存：账号/路由/参数键隔离与并发合并；写成功/未知清缓存；写前拒绝保留；旧挂起不回填；裸账号 loader', async () => {
  const providerCalls = [];
  let resolveFirst;
  const provider = {
    getStatus: () => ({ connection: { connected: true } }),
    isAccountRunning: async () => true,
    getMilkTeaActivity: async id => {
      providerCalls.push(['getMilkTeaActivity', id]);
      if (resolveFirst) {
        const gate = resolveFirst;
        resolveFirst = null;
        await gate;
      }
      return { marker: `fresh-${providerCalls.filter(c => c[0] === 'getMilkTeaActivity').length}`, timing: { phase: 'open' } };
    },
    queryMilkTeaActivity: async (id, kind, params) => { providerCalls.push(['queryMilkTeaActivity', id, kind, params]); return { kind, data: params }; },
    operateMilkTea: async (id, action) => { providerCalls.push(['operateMilkTea', id, action]); return provider.operateResult; },
  };
  const app = setupRoutes(provider);
  const get = async (account = 'acc-1') => {
    const res = fakeRes();
    await app.routes.get('GET /api/activity/milk-tea')({ headers: { 'x-account-id': account } }, res);
    return res.state;
  };
  const postQuery = async (kind, params, account = 'acc-1') => {
    const res = fakeRes();
    await app.routes.get('POST /api/activity/milk-tea/query')({ headers: { 'x-account-id': account }, body: { kind, params } }, res);
    return res.state;
  };
  const postOperate = async (action, account = 'acc-1') => {
    const res = fakeRes();
    await app.routes.get('POST /api/activity/milk-tea/operate')({ headers: { 'x-account-id': account }, body: { action, input: {} } }, res);
    return res.state;
  };

  // 读缓存 + 并发合并：同键并发两次只打一次上游；loader 收到裸账号
  const first = get();
  const second = get();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.body.upstreamCached, false);
  assert.equal(b.body.upstreamCached, true);
  assert.deepEqual(providerCalls, [['getMilkTeaActivity', 'acc-1']]);

  // 账号与路由隔离
  await get('acc-2');
  await postQuery('rank', { page: 1 });
  assert.equal(providerCalls.filter(call => call[0] === 'getMilkTeaActivity').length, 2);
  // 参数键无碰撞：page=1 与 page='1' 旧拼接格式会撞键，JSON 键必须分开
  await postQuery('rank', { page: 1 });
  await postQuery('rank', { page: '1' });
  assert.equal(providerCalls.filter(call => call[0] === 'queryMilkTeaActivity').length, 2);

  // 写前业务拒绝：保留成功缓存
  provider.operateResult = null;
  provider.operateMilkTea = async () => {
    const err = new Error('余额不足');
    err.business = true; err.code = 'SEASON_WISH_MILK_TEA_INSUFFICIENT';
    throw err;
  };
  await postOperate('boost');
  const stillCached = await get();
  assert.equal(stillCached.body.upstreamCached, true, '写前拒绝不清缓存');
  assert.equal(providerCalls.filter(call => call[0] === 'getMilkTeaActivity').length, 2);

  provider.operateMilkTea = async () => ({ ok: false, results: [{ success: true }, { success: false }] });
  await postOperate('hire');
  assert.equal((await get()).body.upstreamCached, false, '部分写成功同样清缓存');

  // 写成功清缓存 + 旧挂起读取失效后不能回填
  provider.operateMilkTea = async (id, action) => {
    providerCalls.push(['operateMilkTea', id, action]);
    return provider.operateResult;
  };
  provider.operateResult = { ok: true, action: 'boost' };
  app.reader.clear('acc-1');
  let releaseOld;
  const gate = new Promise(resolve => { releaseOld = resolve; });
  let firstCall = true;
  provider.getMilkTeaActivity = async () => {
    if (firstCall) { firstCall = false; await gate; return { marker: 'old' }; }
    return { marker: 'new' };
  };
  const slowRead = get();
  await new Promise(resolve => setImmediate(resolve));
  await postOperate('boost');
  const afterWrite = await get();
  assert.equal(afterWrite.body.activity.marker, 'new');
  releaseOld();
  assert.equal((await slowRead).body.upstreamCached, false);
  assert.equal((await get()).body.activity.marker, 'new', '旧挂起回复不能回写覆盖新缓存');
});

// ===== 旧 S3 服务直接调用零网络 =====

test('旧 bear/wish/happy-share 公开入口直接调用零网络（S4 轮换退役）', async () => {
  await loadProto();
  const networkPath = require.resolve('../src/utils/network');
  const utilsPath = require.resolve('../src/utils/utils');
  const protoPath = require.resolve('../src/utils/proto');
  const activityPath = require.resolve('../src/services/activity');
  const petDiaryPath = require.resolve('../src/services/pet-diary-operate');
  const seasonWishPath = require.resolve('../src/services/season-wish-operate');
  const previous = [networkPath, utilsPath, protoPath, activityPath, petDiaryPath, seasonWishPath]
    .map(p => [p, require.cache[p]]);
  const calls = [];
  require.cache[networkPath] = mockModule(networkPath, {
    sendMsgAsync: async (_s, method) => { calls.push(method); throw new Error(`不应有网络调用: ${method}`); },
    getWs: () => null,
    isConnected: () => true,
  });
  require.cache[protoPath] = mockModule(protoPath, { types });
  for (const p of [activityPath, petDiaryPath, seasonWishPath]) delete require.cache[p];
  try {
    const activity = require('../src/services/activity');
    const petDiary = require('../src/services/pet-diary-operate');
    const seasonWish = require('../src/services/season-wish-operate');
    await assert.rejects(petDiary.readPetDiaryGroup(), /下架退役/);
    await assert.rejects(petDiary.operatePetDiary('feed'), /下架退役/);
    await assert.rejects(activity.getBearActivity(), /下架退役/);
    await assert.rejects(activity.getWishActivity(), /下架退役/);
    await assert.rejects(activity.getHappyShareActivity(), /下架退役/);
    await assert.rejects(petDiary.runManualPetDiaryAction('feed', {}, { getBag: async () => ({}), getBagItems: () => [] }), /PET_DIARY_RETIRED|下架退役/);
    await assert.rejects(seasonWish.runManualSeasonWishAction('wishDraw', {}), /SEASON_WISH_RETIRED|下架退役/);
    assert.deepEqual(calls, [], '旧入口零网络');
    // 共享能力保留：发现列表 / 根快照 / 公告入口仍在导出（接线未删共享读取）
    assert.equal(typeof activity.getActivityDiscoveryList, 'function');
    assert.equal(typeof activity.getActivityGroupSnapshot, 'function');
  } finally {
    for (const [p, entry] of previous) {
      if (entry) require.cache[p] = entry;
      else delete require.cache[p];
    }
  }
});

test.after(() => {
  for (const [file, before] of fingerprintsBefore) {
    assert.deepEqual(fingerprintOf(file), before, `候选源码被改动: ${file}`);
  }
  fs.rmSync(assertWriteInsidePrivateDir(privateDir), { recursive: true, force: true });
});

test('写前追加边界：锁定/重复背包条目、重复成员槽位、未知费用与越权班次零写', async () => {
  await withFreshService({},async(service,env)=>{
    const run=(action,input)=>service.runManualMilkTeaAction(action,input,env.deps);
    env.scenario.bagItems=[{id:40525,uid:'23563',count:'7',locked:true}];
    await assert.rejects(run('craft',{recipeId:2,fruitUids:['23563']}),business('SEASON_WISH_MILK_TEA_INVALID_STATE'));
    env.scenario.bagItems=[{id:40525,uid:'23563',count:'7'},{id:40525,uid:'23563',count:'1'}];
    await assert.rejects(run('craft',{recipeId:2,fruitUids:['23563']}),business('SEASON_WISH_MILK_TEA_INVALID_STATE'));
    await assert.rejects(run('hire',{durationId:1,hires:[{slotIndex:0,targetGid:'101'},{slotIndex:0,targetGid:'101'}]}),business('SEASON_WISH_MILK_TEA_INVALID_INPUT'));
    env.scenario.exchangeShop.items[0].costs=[{id:99999999,count:'1'}];
    await assert.rejects(run('exchange',{goodsId:9001,count:1,confirmedCosts:[{itemId:99999999,count:'1'}]}),business('SEASON_WISH_MILK_TEA_UNKNOWN_COST'));
    await assert.rejects(run('interact',{interactionType:1,targetGid:'999'}),business('SEASON_WISH_MILK_TEA_INVALID_INPUT'));
    assert.deepEqual(env.operateRequests.map(r=>r.cmd),[63]);
  });
});

test('有结果体但实际动作未确认：每日/档位/基金/收银台/工资均结果未知且零重试', async () => {
  for (const [action,cmd,body] of [
    ['shareDaily',74,{share_reward_claim_daily:{}}],
    ['shareMilestones',71,{share_reward_claim_milestones:{claimed_tier_ids:[99]}}],
    ['fundClaim',76,{growth_fund_claim:{claimed_tier_ids:[]}}],
    ['claimCashier',59,{milk_tea_claim_cashier:{items:[]}}],
    ['claimWages',64,{milk_tea_claim_wages:{claimed_count:0,items:[]}}],
  ]) await withFreshService({},async(service,env)=>{
    env.scenario.operateBodies[cmd]=body;
    const result=await service.runManualMilkTeaAction(action,{},env.deps);
    assert.equal(result.ok,false);assert.equal(result.outcome,'unknown');
    assert.equal(env.operateRequests.filter(r=>r.cmd===cmd).length,1);
  });
});

test('首次读取已过最终截止：真实路由结构化撤下；普通失败不冒充下架', async () => {
  const provider={getStatus:()=>({connection:{connected:true}}),isAccountRunning:async()=>true,getMilkTeaActivity:async()=>{const err=new Error('ended');err.business=true;err.code='SEASON_WISH_MILK_TEA_ENDED';throw err;}};
  const app=setupRoutes(provider);const req={headers:{'x-account-id':'acc-1'}};
  const first=fakeRes();await app.routes.get('GET /api/activity/milk-tea')(req,first);
  assert.equal(first.state.body.unavailable,true);assert.equal(first.state.body.expired,true);
  app.reader.clear('acc-1');provider.getMilkTeaActivity=async()=>{throw new Error('ordinary failure');};
  const failed=fakeRes();await app.routes.get('GET /api/activity/milk-tea')(req,failed);
  assert.equal(failed.state.status,502);assert.equal(failed.state.body.unavailable,undefined);
});

test('标量参数及班次回显：布尔/结构体/缺槽位不可隐式变成合法选择，零写', async () => {
  await withFreshService({},async(service,env)=>{
    await assert.rejects(service.queryMilkTeaActivity('rank',{page:true},env.deps),business('SEASON_WISH_MILK_TEA_INVALID_INPUT'));
    await assert.rejects(service.queryMilkTeaActivity('hireList',{durationId:{low:1,high:0}},env.deps),business('SEASON_WISH_MILK_TEA_INVALID_INPUT'));
    await assert.rejects(service.runManualMilkTeaAction('hire',{durationId:1,hires:[{targetGid:'101'}]},env.deps),business('SEASON_WISH_MILK_TEA_INVALID_INPUT'));
    env.scenario.operateBodies[56].milk_tea_get_hire_list.duration_id=2;
    await assert.rejects(service.runManualMilkTeaAction('hire',{durationId:1,hires:[{slotIndex:0,targetGid:'101'}],confirmedCosts:[{itemId:TICKET,count:'40'}]},env.deps),business('SEASON_WISH_MILK_TEA_NO_STATE'));
    assert.deepEqual(env.operateRequests.map(r=>r.cmd),[55,56]);
  });
});


test('批量制作整组果实：同配方多组与多配方均只发一次写，确认数量变动零写', async () => {
  await withFreshService({}, async (service, env) => {
    const run = input => service.runManualMilkTeaAction('craft', input, env.deps);
    env.scenario.bagItems = [
      { id: 40525, uid: '23563', count: '7' },
      { id: 40525, uid: '23564', count: '9' },
      { id: 40526, uid: '23565', count: '11' },
    ];
    env.scenario.operateBodies[58].milk_tea_get_workshop.recipes.push({ recipe_id: 3, unlocked: true });
    const confirmedFruits = env.scenario.bagItems.map(item => ({ uid: item.uid, itemId: item.id, count: item.count }));
    const input = { fruitUids: ['23563', '23564'], recipeId: 2, confirmedFruits: confirmedFruits.slice(0, 2) };
    await assert.doesNotReject(async () => { assert.equal((await run(input)).ok, true); });
    assert.deepEqual(env.operateRequests.map(req => req.cmd), [58, 62]);
    assert.deepEqual(types.MilkTeaOperateRequest.decode(env.operateRequests[1].buffer).milk_tea_craft.fruit_uids.map(String), input.fruitUids);
    env.operateRequests.length = 0;
    await assert.doesNotReject(async () => { assert.equal((await run({ fruitUids: confirmedFruits.map(row => row.uid), confirmedFruits })).ok, true); });
    assert.deepEqual(env.operateRequests.map(req => req.cmd), [58, 62]);
    assert.deepEqual(types.MilkTeaOperateRequest.decode(env.operateRequests[1].buffer).milk_tea_craft.fruit_uids.map(String), ['23563', '23564', '23565']);
    for (const change of ['count', 'lock', 'recipe', 'missing']) {
      env.operateRequests.length = 0;
      const original = env.scenario.bagItems.map(row => ({ ...row }));
      if (change === 'count') env.scenario.bagItems[0].count = '8';
      if (change === 'lock') env.scenario.bagItems[0].locked = true;
      if (change === 'recipe') env.scenario.operateBodies[58].milk_tea_get_workshop.recipes[1].unlocked = false;
      if (change === 'missing') env.scenario.bagItems.shift();
      await assert.rejects(run(input), business(change === 'count' ? 'SEASON_WISH_MILK_TEA_COST_CHANGED' : 'SEASON_WISH_MILK_TEA_INVALID_STATE'));
      assert.equal(env.operateRequests.filter(row => row.cmd === 62).length, 0);
      env.scenario.bagItems = original;
      env.scenario.operateBodies[58].milk_tea_get_workshop.recipes[1].unlocked = true;
    }
    for (const fruitUids of [[], ['23563', '23563'], [''], ['-1'], ['9223372036854775808']]) {
      await assert.rejects(run({ fruitUids }), business('SEASON_WISH_MILK_TEA_INVALID_INPUT'));
    }
  });
});
