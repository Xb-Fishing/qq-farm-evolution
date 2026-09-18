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
  const previous = new Map([networkPath, utilsPath].map(p => [p, require.cache[p]]));

  const calls = [];
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
    assert.ok(calls.every(method => ['GetGroup', 'Operate'].includes(method)));
  } finally {
    delete require.cache[servicePath];
    for (const [path, entry] of previous) {
      if (entry === undefined) delete require.cache[path];
      else require.cache[path] = entry;
    }
  }
});
