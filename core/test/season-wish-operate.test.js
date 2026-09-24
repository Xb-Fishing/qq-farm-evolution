const test = require('node:test');
const assert = require('node:assert/strict');

const { loadProto, types } = require('../src/utils/proto');

function mockModule(filename, exports) {
  return { id: filename, filename, loaded: true, exports };
}

const WISH_ROOT = 2026092400;
const WISH_PLAY = 2026092401;
const SHARE_ROOT = 2026092500;
const SHARE_PLAY = 2026092501;

test('季节活动 proto 注册并按官方编码器重构字节级复现四条请求', async () => {
  await loadProto();
  assert.ok(types.ActivityGetGroupReply, 'activity types loaded');
  const hex = value => Buffer.from(value).toString('hex');
  // 官方编码器重构 hex（公开参考项目 1 @0ba48a1 协议恢复文档，字段号经
  // 官方生成代码 sentinel 探测 + HAR 明文响应交叉验证）
  assert.equal(hex(types.ActivityOperateRequest.encode(types.ActivityOperateRequest.create({
    id: WISH_PLAY, cmd: 51, wish_sign_draw: { choose_id: 2 },
  })).finish()), '08f1ee8ec6071033ba09020802');
  assert.equal(hex(types.ActivityOperateRequest.encode(types.ActivityOperateRequest.create({
    id: WISH_PLAY, cmd: 52, wish_sign_claim: { choose_id: 2 },
  })).finish()), '08f1ee8ec6071034c209020802');
  // daily/milestones 官方请求体仅 id+cmd（8 字节，无选择器字段）
  assert.equal(hex(types.ActivityOperateRequest.encode(types.ActivityOperateRequest.create({
    id: SHARE_PLAY, cmd: 73,
  })).finish()), '08d5ef8ec6071049');
  assert.equal(hex(types.ActivityOperateRequest.encode(types.ActivityOperateRequest.create({
    id: SHARE_PLAY, cmd: 70,
  })).finish()), '08d5ef8ec6071046');
});

test('runManualSeasonWishAction：白名单、前置校验与成功链', async () => {
  await loadProto();
  const servicePath = require.resolve('../src/services/season-wish-operate');
  const activityPath = require.resolve('../src/services/activity');
  const networkPath = require.resolve('../src/utils/network');
  const utilsPath = require.resolve('../src/utils/utils');
  const protoPath = require.resolve('../src/utils/proto');
  const previous = new Map([networkPath, utilsPath, protoPath, activityPath, servicePath].map(p => [p, require.cache[p]]));

  const calls = [];
  const operateRequests = [];
  const now = Math.floor(Date.now() / 1000);
  const window = { start_time: now - 3600, end_time: now + 86400 };

  let wishBody = { remaining_count: 1, activity_day: 1, pending: null };
  let shareSummary = {
    score_item_id: 90042, current_score: 5, daily_reward: 5, first_share_reward: 10,
    daily: { claimed_count: 0, claim_limit: 1, daily_reward_claimed: false, first_share_awarded: false },
    milestones: [{ tier_id: 1, threshold: 5, rewards: [{ id: 6001, count: 20 }], state: 2 }],
  };
  let listed = true;

  const buildListReply = () => types.ActivityListReply.encode(types.ActivityListReply.create({
    groups: listed ? [
      { activity: { id: WISH_ROOT, ...window }, children: [{ activity: { id: WISH_PLAY, ...window }, wish_sign: wishBody }] },
      { activity: { id: SHARE_ROOT, ...window }, children: [{ activity: { id: SHARE_PLAY, ...window }, share_reward: { summary: shareSummary } }] },
    ] : [],
  })).finish();

  require.cache[networkPath] = mockModule(networkPath, {
    sendMsgAsync: async (_service, method, payload) => {
      calls.push(method);
      if (method === 'List') return { body: buildListReply() };
      if (method === 'GetGroup') {
        const wantId = Number(types.ActivityGetGroupRequest.decode(payload).id);
        const children = wantId === WISH_ROOT
          ? [{ activity: { id: WISH_PLAY, ...window }, wish_sign: wishBody }]
          : [{ activity: { id: SHARE_PLAY, ...window }, share_reward: { summary: shareSummary } }];
        return { body: types.ActivityGetGroupReply.encode(types.ActivityGetGroupReply.create({
          group: { activity: { id: wantId, ...window }, children },
        })).finish() };
      }
      // Operate：记录请求并回显匹配回包
      const req = types.ActivityOperateRequest.decode(payload);
      operateRequests.push({ id: Number(req.id), cmd: Number(req.cmd), hex: Buffer.from(payload).toString('hex') });
      const reply = types.ActivityOperateReply.create({
        id: req.id, cmd: req.cmd,
        wish_sign_draw: { text_id: 7, day_id: 1, rewards: [{ id: 6001, count: 20 }] },
        wish_sign_claim: { awards: [{ id: 6001, count: 20 }] },
        share_reward_claim_daily: { rewards: [{ id: 90042, count: 5 }], granted_score: 5 },
        share_reward_claim_milestones: { claimed_tier_ids: [1], rewards: [{ id: 6001, count: 20 }] },
      });
      return { body: types.ActivityOperateReply.encode(reply).finish() };
    },
    getUserState: () => ({}),
    isConnected: () => true,
  });
  const realUtils = require('../src/utils/utils');
  require.cache[utilsPath] = mockModule(utilsPath, { ...realUtils });
  require.cache[protoPath] = mockModule(protoPath, { types });

  delete require.cache[activityPath];
  delete require.cache[servicePath];
  try {
    const { runManualSeasonWishAction, OPERATIONS, WISH_CHOICES } = require('../src/services/season-wish-operate');

    // 白名单锁定：分享（shareShare/cmd 69）不开放
    assert.deepEqual(Object.keys(OPERATIONS).sort(), ['shareDaily', 'shareMilestones', 'wishClaim', 'wishDraw']);
    assert.equal(WISH_CHOICES.length, 6);

    // 1. 未知/未开放操作：零请求
    calls.length = 0;
    await assert.rejects(runManualSeasonWishAction('shareShare', {}), /未开放/);
    assert.deepEqual(calls, []);

    // 2. 祈愿 chooseId 无效：前置读取后拒绝，零 Operate
    calls.length = 0;
    await assert.rejects(runManualSeasonWishAction('wishDraw', { chooseId: 9 }), /祈愿选择无效/);
    assert.ok(!calls.includes('Operate'));

    // 3. 祈愿成功：List + GetGroup + Operate 恰好一次，编码与官方 hex 一致
    calls.length = 0; operateRequests.length = 0;
    const draw = await runManualSeasonWishAction('wishDraw', { chooseId: 2 });
    assert.deepEqual(calls, ['List', 'GetGroup', 'Operate']);
    assert.equal(operateRequests.length, 1);
    assert.equal(operateRequests[0].hex, '08f1ee8ec6071033ba09020802');
    assert.equal(draw.rewards.length, 1);
    assert.equal(draw.rewards[0].itemId, 6001);
    assert.equal(draw.rewards[0].itemName, '烟花桶');

    // 4. 已有 pending 时再祈愿被拒
    wishBody = { remaining_count: 0, activity_day: 1, pending: { choose_id: 2, text_id: 7, day_id: 1, rewards: [{ id: 6001, count: 20 }] } };
    calls.length = 0;
    await assert.rejects(runManualSeasonWishAction('wishDraw', { chooseId: 2 }), /待领取/);
    assert.ok(!calls.includes('Operate'));

    // 5. 领取：签文不匹配被拒；匹配成功
    await assert.rejects(runManualSeasonWishAction('wishClaim', { chooseId: 3 }), /没有与所选签文匹配/);
    calls.length = 0; operateRequests.length = 0;
    const claim = await runManualSeasonWishAction('wishClaim', { chooseId: 2 });
    assert.equal(operateRequests[0].hex, '08f1ee8ec6071034c209020802');
    assert.equal(claim.rewards[0].itemId, 6001);

    // 6. 每日领取：已领取被拒；未领取成功且请求体 8 字节
    shareSummary = { ...shareSummary, daily: { ...shareSummary.daily, daily_reward_claimed: true } };
    await assert.rejects(runManualSeasonWishAction('shareDaily', {}), /今日快乐值已领取/);
    shareSummary = { ...shareSummary, daily: { ...shareSummary.daily, daily_reward_claimed: false } };
    calls.length = 0; operateRequests.length = 0;
    const daily = await runManualSeasonWishAction('shareDaily', {});
    assert.equal(operateRequests[0].hex, '08d5ef8ec6071049');
    assert.equal(daily.grantedScore, 5);

    // 7. 档位领奖：无可领档位（state 全 1）被拒；可领成功
    shareSummary = { ...shareSummary, current_score: 1, milestones: [{ tier_id: 1, threshold: 5, state: 1 }] };
    await assert.rejects(runManualSeasonWishAction('shareMilestones', {}), /没有可领取的快乐值档位/);
    shareSummary = { ...shareSummary, current_score: 5, milestones: [{ tier_id: 1, threshold: 5, state: 2 }] };
    calls.length = 0; operateRequests.length = 0;
    const tiers = await runManualSeasonWishAction('shareMilestones', {});
    assert.equal(operateRequests[0].hex, '08d5ef8ec6071046');
    assert.deepEqual(tiers.claimedTierIds, [1]);

    // 8. 活动不在 List 下发：零 GetGroup/Operate
    listed = false;
    calls.length = 0;
    await assert.rejects(runManualSeasonWishAction('wishDraw', { chooseId: 2 }), /未由当前 ActivityService.List 下发/);
    assert.deepEqual(calls, ['List']);
  } finally {
    for (const [path, entry] of previous) {
      if (entry) require.cache[path] = entry;
      else delete require.cache[path];
    }
  }
});
