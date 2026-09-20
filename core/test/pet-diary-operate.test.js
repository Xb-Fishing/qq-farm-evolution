const test = require('node:test');
const assert = require('node:assert/strict');

const { loadProto, types } = require('../src/utils/proto');

function mockModule(filename, exports) {
  return { id: filename, filename, loaded: true, exports };
}

test('pet-diary proto 注册并支持操作编码往返', async () => {
  await loadProto();
  for (const name of ['PetDiaryOperateRequest', 'PetDiaryOperateReply', 'PetDiaryGetGroupReply']) {
    assert.ok(types[name], `${name} registered`);
  }
  // 投喂：activity_id=2026090101, operate_type=29, selector 空参数
  const req = types.PetDiaryOperateRequest.encode(types.PetDiaryOperateRequest.create({
    activity_id: 2026090101,
    operate_type: 29,
    pet_treasure_hunt_feed: {},
  })).finish();
  const dec = types.PetDiaryOperateRequest.decode(req);
  assert.equal(Number(dec.activity_id), 2026090101);
  assert.equal(Number(dec.operate_type), 29);
  assert.ok(dec.pet_treasure_hunt_feed, 'feed selector present');

  // 兑换：shop_buy 携带 goods_id/count
  const buy = types.PetDiaryOperateRequest.encode(types.PetDiaryOperateRequest.create({
    activity_id: 2026090103,
    operate_type: 1,
    shop_buy: { goods_id: 50, count: 2 },
  })).finish();
  const buyDec = types.PetDiaryOperateRequest.decode(buy);
  assert.equal(Number(buyDec.shop_buy.goods_id), 50);
  assert.equal(Number(buyDec.shop_buy.count), 2);
});

test('runManualPetDiaryAction 前置校验与操作白名单', async () => {
  await loadProto();
  const servicePath = require.resolve('../src/services/pet-diary-operate');
  const networkPath = require.resolve('../src/utils/network');
  const utilsPath = require.resolve('../src/utils/utils');
  const protoPath = require.resolve('../src/utils/proto');
  const previous = new Map([networkPath, utilsPath, protoPath].map(p => [p, require.cache[p]]));

  const calls = [];
  const encodes = [];
  const guardedTypes = { ...types };
  for (const name of ['ActivityListRequest', 'ActivityGetGroupRequest', 'PetDiaryOperateRequest']) {
    guardedTypes[name] = {
      create: value => types[name].create(value),
      encode: value => { encodes.push(name); return types[name].encode(value); },
    };
  }
  require.cache[protoPath] = mockModule(protoPath, { types: guardedTypes });
  let listed = true;
  let listedEnd = 0;
  // GetGroup 回包：构造活跃活动组 + 成年比熊状态
  const buildGroupReply = (nurtureOverrides = {}) => {
    const group = types.PetDiaryGetGroupReply.create({
      group: {
        head: {
          id: 2026090100,
          start_time: Math.floor(Date.now() / 1000) - 3600,
          end_time: Math.floor(Date.now() / 1000) + 86400,
        },
        children: [
          {
            head: { id: 2026090101, start_time: Math.floor(Date.now() / 1000) - 3600, end_time: Math.floor(Date.now() / 1000) + 86400 },
            pet_treasure_hunt: {
              nurture: { cg_played: true, stage: 2, growth: 7000, dog_granted: false, ...nurtureOverrides },
              feed: { feed_count: 3 },
              hunt: { treasure_count: 1, treasure_cost: [{ id: 1028, count: 700 }] },
            },
          },
          {
            head: { id: 2026090102, start_time: Math.floor(Date.now() / 1000) - 3600, end_time: Math.floor(Date.now() / 1000) + 86400 },
            mega_event: { rewards: [{ unlock_day: 1, unlocked: true, claimable: true, claimed: false }] },
          },
          { head: { id: 2026090103 } },
        ],
      },
    });
    return types.PetDiaryGetGroupReply.encode(group).finish();
  };

  require.cache[networkPath] = mockModule(networkPath, {
    sendMsgAsync: async (_service, method, payload) => {
      calls.push(method);
      if (method === 'List') return { body: types.ActivityListReply.encode(types.ActivityListReply.create({
        groups: listed ? [{ activity: { id: 2026090100, end_time: listedEnd } }] : [],
      })).finish() };
      if (method === 'GetGroup') return { body: buildGroupReply() };
      // Operate 回包：匹配请求的 activity_id/operate_type
      const req = types.PetDiaryOperateRequest.decode(payload);
      const reply = types.PetDiaryOperateReply.create({
        activity_id: req.activity_id,
        operate_type: req.operate_type,
        pet_treasure_hunt_draw: { rewards: [{ id: 1029, count: 5 }] },
        pet_treasure_hunt_feed: { rewards: [] },
        mega_event_claim_all: { awards: [{ id: 29004, count: 1 }] },
      });
      return { body: types.PetDiaryOperateReply.encode(reply).finish() };
    },
  });
  const realUtils = require('../src/utils/utils');
  require.cache[utilsPath] = mockModule(utilsPath, { ...realUtils });

  delete require.cache[servicePath];
  try {
    const { runManualPetDiaryAction, OPERATIONS } = require('../src/services/pet-diary-operate');
    const deps = {
      getBag: async () => ({}),
      getBagItems: () => [{ id: 1028, count: 100000 }, { id: 1029, count: 500 }],
    };

    // 1. 寻宝成功（成年、次数未满、余额充足）
    const draw = await runManualPetDiaryAction('draw', {}, deps);
    assert.equal(draw.action, 'draw');
    assert.equal(draw.rewards.length, 1);

    // 2. 未开放操作被拒
    await assert.rejects(
      runManualPetDiaryAction('battle', {}, deps),
      /未开放/,
    );

    // 3. 前置校验：投喂在成年后（stage 2）被拒
    await assert.rejects(
      runManualPetDiaryAction('feed', {}, deps),
      /不可投喂/,
    );

    // 4. 余额不足被拒（清空背包）
    await assert.rejects(
      runManualPetDiaryAction('draw', {}, { getBag: async () => ({}), getBagItems: () => [] }),
      /元气糕不足/,
    );

    // 5. 命令字白名单与官方编码器一致
    assert.deepEqual(OPERATIONS.feed, [29, 'pet_treasure_hunt_feed']);
    assert.deepEqual(OPERATIONS.draw, [30, 'pet_treasure_hunt_draw']);
    assert.deepEqual(OPERATIONS.seeds, [21, 'mega_event_claim_all']);
    assert.deepEqual(OPERATIONS.exchange, [1, 'shop_buy']);

    // 6. Operate 走 ActivityService（不引入新接口）
    assert.ok(calls.every(method => ['List', 'GetGroup', 'Operate'].includes(method)));
    assert.deepEqual(calls.slice(0, 3), ['List', 'GetGroup', 'Operate']);
    calls.length = 0;
    encodes.length = 0;
    await assert.rejects(runManualPetDiaryAction('battle', {}, deps), /未开放/);
    assert.deepEqual(calls, []);
    assert.deepEqual(encodes, []);
    listed = false;
    await assert.rejects(runManualPetDiaryAction('draw', {}, { getBag: () => { throw new Error('must not read bag'); } }), /未由当前列表下发/);
    assert.deepEqual(calls, ['List']);
    assert.deepEqual(encodes, ['ActivityListRequest']);
    calls.length = 0;
    listed = true;
    listedEnd = Math.floor(Date.now() / 1000) - 1;
    await assert.rejects(runManualPetDiaryAction('draw', {}, deps), /已结束/);
    assert.deepEqual(calls, ['List']);
  } finally {
    delete require.cache[servicePath];
    for (const [path, entry] of previous) {
      if (entry === undefined) delete require.cache[path];
      else require.cache[path] = entry;
    }
  }
});

// ==================== 前置校验与缓存行为扩展（2026-09-20 跨层修复配套）====================
// 覆盖 initialize/feed/claimDog/seeds/compensation 前置拒绝、story/exchange
// 全部分支（无效输入、未解锁/已领取、商品未下发、限购、余额不足、钻石限制），
// 以及「写请求已发送后响应不匹配」失败语义：写请求恰好一次、无重试、
// 不能描述为发包前拒绝。所有拒绝均断言 business 标记 + 固定 code，
// 前置拒绝的操作编码与写请求为零（业务码由调用方经管理通道透传）。
// 逐场景断言精确读取次数：前置拒绝恰好 List+GetGroup 各一次（重复读取
// 也会失败），背包读取次数与该校验链一致（仅到达余额校验时读一次）。

test('各操作前置校验拒绝携带 business 标记与固定 code，前置拒绝零编码零写请求', async () => {
  await loadProto();
  const servicePath = require.resolve('../src/services/pet-diary-operate');
  const networkPath = require.resolve('../src/utils/network');
  const utilsPath = require.resolve('../src/utils/utils');
  const protoPath = require.resolve('../src/utils/proto');
  const previous = new Map([networkPath, utilsPath, protoPath].map(p => [p, require.cache[p]]));

  const calls = [];
  const encodes = [];
  const guardedTypes = { ...types };
  for (const name of ['ActivityListRequest', 'ActivityGetGroupRequest', 'PetDiaryOperateRequest']) {
    guardedTypes[name] = {
      create: value => types[name].create(value),
      encode: value => { encodes.push(name); return types[name].encode(value); },
    };
  }
  require.cache[protoPath] = mockModule(protoPath, { types: guardedTypes });

  // 可变活动组状态：默认成年比熊、种子礼包可领、无补偿、商城空
  let groupOverrides = {};
  const buildMutableGroupReply = () => {
    const start = Math.floor(Date.now() / 1000) - 3600;
    const end = Math.floor(Date.now() / 1000) + 86400;
    const o = groupOverrides;
    const group = types.PetDiaryGetGroupReply.create({
      group: {
        head: { id: 2026090100, start_time: start, end_time: end },
        children: [
          {
            head: { id: 2026090101, start_time: start, end_time: end },
            pet_treasure_hunt: {
              nurture: { cg_played: true, stage: 2, growth: 7000, dog_granted: false,
                ...(o.nurture || {}) },
              feed: { feed_count: 3, ...(o.feed || {}) },
              hunt: { treasure_count: 1, treasure_cost: [{ id: 1028, count: 700 }] },
              plunder: { plunder_compensation_count: o.plunderCompensation || 0 },
              story: { stories: o.stories || [{ order: 1, unlocked: true, claimed: false }] },
            },
          },
          {
            head: { id: 2026090102, start_time: start, end_time: end },
            mega_event: { rewards: o.seedRewards
              || [{ unlock_day: 1, unlocked: true, claimable: true, claimed: false }] },
          },
          {
            head: { id: 2026090103, start_time: start, end_time: end },
            shop: { goods: o.shopGoods || [] },
          },
        ],
      },
    });
    return types.PetDiaryGetGroupReply.encode(group).finish();
  };

  require.cache[networkPath] = mockModule(networkPath, {
    sendMsgAsync: async (_service, method, payload) => {
      calls.push(method);
      if (method === 'List') return { body: types.ActivityListReply.encode(types.ActivityListReply.create({
        groups: [{ activity: { id: 2026090100 } }],
      })).finish() };
      if (method === 'GetGroup') return { body: buildMutableGroupReply() };
      const req = types.PetDiaryOperateRequest.decode(payload);
      const reply = types.PetDiaryOperateReply.create({
        activity_id: req.activity_id,
        operate_type: req.operate_type,
      });
      return { body: types.PetDiaryOperateReply.encode(reply).finish() };
    },
  });
  const realUtils = require('../src/utils/utils');
  require.cache[utilsPath] = mockModule(utilsPath, { ...realUtils });

  delete require.cache[servicePath];
  try {
    const { runManualPetDiaryAction } = require('../src/services/pet-diary-operate');
    // 逐场景统计背包读取次数：背包校验（feed/draw/exchange 的余额检查）只应
    // 在到达该校验时读取一次，前置更早的拒绝不应重复读取或自动重试
    let bagReads = 0;
    let bagItems = [{ id: 1028, count: 100000 }, { id: 1029, count: 500 }];
    const deps = {
      getBag: async () => { bagReads += 1; return {}; },
      getBagItems: () => bagItems,
    };

    // 拒绝场景表：[名称, 操作, 输入, 状态覆盖, 期望 code, 期望消息片段, 期望背包读取次数, 可选背包覆盖]
    const cases = [
      ['initialize 已领养', 'initialize', {}, { nurture: { cg_played: true } },
        'PET_DIARY_ALREADY', /已领养/, 0],
      ['feed 成年后拒绝', 'feed', {}, { nurture: { stage: 2 } },
        'PET_DIARY_INVALID_STAGE', /不可投喂/, 0],
      ['feed 次数已满（幼年段）', 'feed', {}, { nurture: { stage: 1 }, feed: { feed_count: 16 } },
        'PET_DIARY_LIMIT', /次数已用完/, 0],
      ['feed 元气糕不足（幼年段空背包）', 'feed', {},
        { nurture: { stage: 1 }, feed: { feed_count: 0 } },
        'PET_DIARY_INSUFFICIENT', /元气糕不足/, 1, []],
      ['claimDog 未成年', 'claimDog', {}, { nurture: { stage: 1 } },
        'PET_DIARY_INVALID_STAGE', /尚未成年/, 0],
      ['claimDog 已领取', 'claimDog', {}, { nurture: { dog_granted: true } },
        'PET_DIARY_ALREADY', /已经领取/, 0],
      ['seeds 无可领礼包', 'seeds', {},
        { seedRewards: [{ unlock_day: 1, unlocked: true, claimable: false, claimed: false }] },
        'PET_DIARY_INVALID_STATE', /没有可领取的种子礼包/, 0],
      ['seeds 已领取', 'seeds', {},
        { seedRewards: [{ unlock_day: 1, unlocked: true, claimable: true, claimed: true }] },
        'PET_DIARY_INVALID_STATE', /没有可领取的种子礼包/, 0],
      ['compensation 无可领补偿', 'compensation', {}, { plunderCompensation: 0 },
        'PET_DIARY_INVALID_STATE', /没有可领取的夺宝补偿/, 0],
      ['story 编号无效', 'story', { order: 0 }, {}, 'PET_DIARY_INVALID_INPUT', /编号无效/, 0],
      ['story 未解锁', 'story', { order: 1 },
        { stories: [{ order: 1, unlocked: false, claimed: false }] },
        'PET_DIARY_INVALID_STATE', /尚未解锁或已领取/, 0],
      ['story 已领取', 'story', { order: 1 },
        { stories: [{ order: 1, unlocked: true, claimed: true }] },
        'PET_DIARY_INVALID_STATE', /尚未解锁或已领取/, 0],
      ['story 不存在', 'story', { order: 99 }, {}, 'PET_DIARY_INVALID_STATE', /尚未解锁或已领取/, 0],
      ['exchange 商品编号无效', 'exchange', { goodsId: 0 }, {},
        'PET_DIARY_INVALID_INPUT', /商品编号无效/, 0],
      ['exchange 商品未下发', 'exchange', { goodsId: 50 }, {},
        'PET_DIARY_INVALID_INPUT', /未发现该商品/, 0],
      ['exchange 钻石成本被阻止', 'exchange', { goodsId: 50 },
        { shopGoods: [{ id: 50, purchase_limit: '0', purchased_count: '0', diamond_cost_count: 5 }] },
        'PET_DIARY_DIAMOND_BLOCKED', /钻石/, 0],
      ['exchange 钻石货币成本被阻止', 'exchange', { goodsId: 50 },
        { shopGoods: [{ id: 50, purchase_limit: '0', purchased_count: '0',
          diamond_cost_count: 0, cost: [{ id: 1004, count: '10' }] }] },
        'PET_DIARY_DIAMOND_BLOCKED', /钻石/, 0],
      ['exchange 限购', 'exchange', { goodsId: 50, count: 2 },
        { shopGoods: [{ id: 50, purchase_limit: '1', purchased_count: '0',
          diamond_cost_count: 0, cost: [{ id: 1029, count: '10' }] }] },
        'PET_DIARY_LIMIT', /限购/, 0],
      ['exchange 余额不足', 'exchange', { goodsId: 50 },
        { shopGoods: [{ id: 50, purchase_limit: '0', purchased_count: '0',
          diamond_cost_count: 0, cost: [{ id: 1029, count: '999999' }] }] },
        'PET_DIARY_INSUFFICIENT', /余额不足/, 1],
    ];

    for (const [name, action, input, overrides, expectedCode, expectedMsg, expectedBagReads, bagOverride] of cases) {
      groupOverrides = overrides;
      bagItems = bagOverride === undefined
        ? [{ id: 1028, count: 100000 }, { id: 1029, count: 500 }]
        : bagOverride;
      bagReads = 0;
      calls.length = 0;
      encodes.length = 0;
      let caught = null;
      try { await runManualPetDiaryAction(action, input, deps); }
      catch (err) { caught = err; }
      assert.ok(caught, `${name}: 应被拒绝`);
      assert.equal(caught.business, true, `${name}: business 标记`);
      assert.equal(caught.code, expectedCode, `${name}: 固定 code`);
      if (expectedMsg) assert.match(caught.message, expectedMsg, `${name}: 原有提示`);
      // 逐场景精确读取次数：前置拒绝恰好 List+GetGroup 各一次（无重复读取、
      // 无自动重试）；背包读取次数与该校验链一致；操作编码与写请求为零
      assert.deepEqual(calls, ['List', 'GetGroup'], `${name}: 状态读取次数（实际 ${calls.join(',')}）`);
      assert.equal(bagReads, expectedBagReads, `${name}: 背包读取次数`);
      assert.ok(!encodes.includes('PetDiaryOperateRequest'), `${name}: 零操作编码`);
    }

    // compensation 可领取 → 成功路径：写请求恰好一次、零背包读取
    groupOverrides = { plunderCompensation: 2 };
    bagItems = [{ id: 1028, count: 100000 }, { id: 1029, count: 500 }];
    bagReads = 0;
    calls.length = 0;
    const okResult = await runManualPetDiaryAction('compensation', {}, deps);
    assert.equal(okResult.action, 'compensation');
    assert.deepEqual(calls, ['List', 'GetGroup', 'Operate']);
    assert.equal(bagReads, 0);

    // story 可领取 → 成功路径（领手记走 order 参数）：零背包读取
    groupOverrides = {};
    bagReads = 0;
    calls.length = 0;
    const storyResult = await runManualPetDiaryAction('story', { order: 1 }, deps);
    assert.equal(storyResult.action, 'story');
    assert.deepEqual(calls, ['List', 'GetGroup', 'Operate']);
    assert.equal(bagReads, 0);

    // exchange 正常成功：非钻石、限购内、余额足（1029 ×500 库存）：一次背包读取
    groupOverrides = { shopGoods: [{ id: 50, purchase_limit: '5', purchased_count: '0',
      diamond_cost_count: 0, cost: [{ id: 1029, count: '10' }] }] };
    bagReads = 0;
    calls.length = 0;
    const exchangeResult = await runManualPetDiaryAction('exchange', { goodsId: 50, count: 2 }, deps);
    assert.equal(exchangeResult.action, 'exchange');
    assert.deepEqual(calls, ['List', 'GetGroup', 'Operate']);
    assert.equal(bagReads, 1);
  } finally {
    delete require.cache[servicePath];
    for (const [path, entry] of previous) {
      if (entry === undefined) delete require.cache[path];
      else require.cache[path] = entry;
    }
  }
});

test('写请求已发送后响应不匹配：失败保留、写请求恰好一次、无自动重试', async () => {
  await loadProto();
  const servicePath = require.resolve('../src/services/pet-diary-operate');
  const networkPath = require.resolve('../src/utils/network');
  const utilsPath = require.resolve('../src/utils/utils');
  const protoPath = require.resolve('../src/utils/proto');
  const previous = new Map([networkPath, utilsPath, protoPath].map(p => [p, require.cache[p]]));

  let operateCalls = 0;
  require.cache[networkPath] = mockModule(networkPath, {
    sendMsgAsync: async (_service, method, payload) => {
      if (method === 'List') return { body: types.ActivityListReply.encode(types.ActivityListReply.create({
        groups: [{ activity: { id: 2026090100 } }],
      })).finish() };
      if (method === 'GetGroup') {
        const start = Math.floor(Date.now() / 1000) - 3600;
        const end = Math.floor(Date.now() / 1000) + 86400;
        const group = types.PetDiaryGetGroupReply.create({
          group: {
            head: { id: 2026090100, start_time: start, end_time: end },
            children: [
              { head: { id: 2026090101, start_time: start, end_time: end },
                pet_treasure_hunt: {
                  nurture: { cg_played: true, stage: 2 },
                  feed: { feed_count: 3 },
                  hunt: { treasure_count: 1, treasure_cost: [{ id: 1028, count: 700 }] } } },
              { head: { id: 2026090102, start_time: start, end_time: end } },
              { head: { id: 2026090103, start_time: start, end_time: end } },
            ],
          },
        });
        return { body: types.PetDiaryGetGroupReply.encode(group).finish() };
      }
      // Operate：回包 activity_id/operate_type 与请求不匹配（模拟解码后校验失败）
      operateCalls += 1;
      const req = types.PetDiaryOperateRequest.decode(payload);
      const reply = types.PetDiaryOperateReply.create({
        activity_id: 999999,
        operate_type: req.operate_type,
      });
      return { body: types.PetDiaryOperateReply.encode(reply).finish() };
    },
  });
  const realUtils = require('../src/utils/utils');
  require.cache[utilsPath] = mockModule(utilsPath, { ...realUtils });
  require.cache[protoPath] = mockModule(protoPath, { types });

  delete require.cache[servicePath];
  try {
    const { runManualPetDiaryAction } = require('../src/services/pet-diary-operate');
    const deps = { getBag: async () => ({}), getBagItems: () => [{ id: 1028, count: 100000 }] };
    let caught = null;
    try { await runManualPetDiaryAction('draw', {}, deps); }
    catch (err) { caught = err; }
    assert.ok(caught, '响应不匹配应失败');
    assert.equal(caught.business, true);
    assert.equal(caught.code, 'PET_DIARY_REPLY_MISMATCH');
    // 写请求已发出且只有一次；此失败不是发包前拒绝，也无自动重试
    assert.equal(operateCalls, 1);
  } finally {
    delete require.cache[servicePath];
    for (const [path, entry] of previous) {
      if (entry === undefined) delete require.cache[path];
      else require.cache[path] = entry;
    }
  }
});
