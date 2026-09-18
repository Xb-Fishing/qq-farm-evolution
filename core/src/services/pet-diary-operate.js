/**
 * 萌宠成长日记（S3）活动操作服务
 *
 * 命令字与选择器来自官方小程序 1.14.0.1 编码器（参考仓库 xxxscarlxrd404/qq-farm-bot
 * @34505ac 只读对照移植；其文件头声明命令字不按响应长度或 UI 文案推断）。
 * proto 结构见 core/src/proto/pet-diary.proto（同源移植，已注册进 utils/proto.js）。
 *
 * 安全边界（本项目的接入模式）：
 * - 全部操作只在「手动触发」路径执行（面板按钮），不接入每日自动任务；
 *   每次操作前重读活动状态做服务端前置校验（余额/次数/状态），
 *   与官方客户端行为一致，避免本地状态过期造成重复扣费。
 * - 钻石（1004）与零消耗一律拒绝，防止误花强付费资源。
 * - 操作成功后重新读取快照；失败错误原样给面板，不做自动重试。
 * - 本轮只开放非夺宝操作（投喂/寻宝/领种子/手记/开宝/领狗/初始化/兑换）；
 *   夺宝（battle/43）与好友信息（47）暂不开放：涉及选择好友目标，
 *   等第一轮线上样本积累后再评估。
 */

const { toNum, toLong, log } = require('../utils/utils');
const { sendMsgAsync } = require('../utils/network');
const { types } = require('../utils/proto');

const PET_DIARY_GROUP_ID = 2026090100;
const PET_DIARY_PLAY_ID = 2026090101;
const PET_DIARY_SEEDS_ID = 2026090102;
const PET_DIARY_SHOP_ID = 2026090103;
const DIAMOND_ITEM_ID = 1004;

// 命令字与选择器均来自官方编码器（参考仓库只读对照；键名即 OperateRequest 选择器字段）
const OPERATIONS = {
  initialize: [27, 'pet_treasure_hunt_finish_cg'],
  feed: [29, 'pet_treasure_hunt_feed'],
  draw: [30, 'pet_treasure_hunt_draw'],
  story: [32, 'pet_treasure_hunt_claim_story'],
  compensation: [46, 'pet_treasure_hunt_claim_plunder_compensation'],
  claimDog: [48, 'pet_treasure_hunt_claim_dog'],
  markStories: [49, 'pet_treasure_hunt_mark_story_animated'],
  skipBattle: [50, 'pet_treasure_hunt_set_skip_battle_cg'],
  seeds: [21, 'mega_event_claim_all'],
  exchange: [1, 'shop_buy'],
};

function businessError(code, message) {
  const err = new Error(message);
  err.code = code;
  err.business = true;
  return err;
}

function fail(code, message) { throw businessError(code, message); }

function str64(value) { return String(value == null ? '' : value); }
function num64(value) { return Number(value) || 0; }

function list(value) { return Array.isArray(value) ? value : []; }

function itemDto(raw) {
  const id = num64(raw && raw.id);
  return {
    id,
    count: str64(raw && raw.count),
    name: '',
  };
}

function items(value) { return list(value).filter(Boolean).map(itemDto); }

/** 读活动组（GetGroup 请求类型与通用活动一致；响应用 PetDiaryGetGroupReply 解码）。 */
async function readPetDiaryGroup() {
  const request = types.ActivityGetGroupRequest.encode(
    types.ActivityGetGroupRequest.create({ id: toLong(PET_DIARY_GROUP_ID) }),
  ).finish();
  const { body } = await sendMsgAsync('gamepb.activitypb.ActivityService', 'GetGroup', request);
  const reply = types.PetDiaryGetGroupReply.decode(body);
  const group = reply.group;
  if (num64(group && group.head && group.head.id) !== PET_DIARY_GROUP_ID) {
    fail('PET_DIARY_UNAVAILABLE', '服务端未返回萌宠成长日记活动');
  }
  const children = list(group && group.children);
  const findChild = id => children.find(entry => num64(entry && entry.head && entry.head.id) === id) || null;
  return {
    group,
    pet: findChild(PET_DIARY_PLAY_ID),
    seeds: findChild(PET_DIARY_SEEDS_ID),
    shop: findChild(PET_DIARY_SHOP_ID),
  };
}

function headActive(head) {
  const now = Math.floor(Date.now() / 1000);
  return num64(head && head.start_time) > 0
    && now >= num64(head.start_time) && now <= num64(head.end_time);
}

/**
 * 发送一次活动 Operate（手动触发路径专用）。
 * @param {string} action - OPERATIONS 键
 * @param {object} params - 选择器字段值（如 { goods_id, count }）
 * @param {number} targetId - 接收操作的子活动 ID（默认玩法节点）
 */
async function operatePetDiary(action, params = {}, targetId = PET_DIARY_PLAY_ID) {
  if (!Object.prototype.hasOwnProperty.call(OPERATIONS, action)) {
    fail('PET_DIARY_UNKNOWN_ACTION', '未知萌宠操作');
  }
  const [command, selector] = OPERATIONS[action];
  const requestInput = {
    activity_id: toLong(targetId),
    operate_type: command,
    [selector]: params,
  };
  const request = types.PetDiaryOperateRequest.encode(
    types.PetDiaryOperateRequest.create(requestInput),
  ).finish();
  const { body } = await sendMsgAsync('gamepb.activitypb.ActivityService', 'Operate', request);
  const reply = types.PetDiaryOperateReply.decode(body);
  if (num64(reply.activity_id) !== targetId || num64(reply.operate_type) !== command) {
    fail('PET_DIARY_REPLY_MISMATCH', '活动响应不匹配，请刷新后查看结果');
  }
  return { reply, selector, command };
}

/** 背包余额表（itemId -> BigInt string）。 */
async function readBalances(getBag, getBagItems) {
  const result = new Map();
  const bag = await getBag();
  for (const item of getBagItems(bag) || []) {
    const id = String(num64(item && item.id));
    result.set(id, (BigInt(result.get(id) || '0') + BigInt(str64(item && item.count))).toString());
  }
  return result;
}

function costsAvailable(costs, balances, count = 1) {
  if (!balances || !costs.length) return false;
  const totals = new Map();
  for (const cost of costs) {
    const id = String(num64(cost.id));
    if (id === String(DIAMOND_ITEM_ID) || id === '0' || BigInt(str64(cost.count)) <= 0n) return false;
    totals.set(id, (totals.get(id) || 0n) + BigInt(str64(cost.count)) * BigInt(count));
  }
  return [...totals].every(([id, amount]) => BigInt(balances.get(id) || '0') >= amount);
}

/** 解析玩法节点的 pet_treasure_hunt 状态（无状态返回 null）。 */
function petState(pet) {
  const data = pet && pet.pet_treasure_hunt;
  return data || null;
}

function feedCostsFromCatalog() {
  // 活动说明与挑战书配置表（2026-09-13 证据链）：投喂消耗 1028 萌宠元气糕 ×700
  return [{ id: 1028, count: '700' }];
}

function treasureCostsFromState(state) {
  return items(state && state.hunt && state.hunt.treasure_cost);
}

/**
 * 手动操作入口：投喂 / 寻宝 / 领取种子礼包 / 领手记 / 开宝箱 / 领狗 / 初始化 / 兑换。
 * 每次操作前重读状态校验，成功后返回奖励与提示（不自动重试）。
 */
async function runManualPetDiaryAction(action, input, deps = {}) {
  const getBag = deps.getBag;
  const getBagItems = deps.getBagItems;
  const { pet, seeds, shop } = await readPetDiaryGroup();
  if (!pet || !headActive(pet.head)) {
    fail('PET_DIARY_INACTIVE', '萌宠成长日记当前不在活动时间内');
  }
  const state = petState(pet);
  if (!state) fail('PET_DIARY_NO_STATE', '服务端未返回萌宠养成状态');
  const nurture = state.nurture || {};
  let targetId = PET_DIARY_PLAY_ID;
  let params = {};

  if (action === 'initialize') {
    if (nurture.cg_played === true) fail('PET_DIARY_ALREADY', '已领养比熊，请刷新状态');
  } else if (action === 'feed') {
    if (num64(nurture.stage) !== 1) fail('PET_DIARY_INVALID_STAGE', '比熊当前阶段不可投喂');
    if (num64(state.feed && state.feed.feed_count) >= 16) fail('PET_DIARY_LIMIT', '今日投喂次数已用完');
    if (!costsAvailable(feedCostsFromCatalog(), await readBalances(getBag, getBagItems))) {
      fail('PET_DIARY_INSUFFICIENT', '萌宠元气糕不足，请先种植活动作物');
    }
  } else if (action === 'draw') {
    if (num64(nurture.stage) !== 2) fail('PET_DIARY_INVALID_STAGE', '比熊成年后才可寻宝');
    if (num64(state.hunt && state.hunt.treasure_count) >= 10) fail('PET_DIARY_LIMIT', '今日寻宝次数已用完');
    if (!costsAvailable(treasureCostsFromState(state), await readBalances(getBag, getBagItems))) {
      fail('PET_DIARY_INSUFFICIENT', '萌宠元气糕不足，请先种植活动作物');
    }
  } else if (action === 'claimDog') {
    if (num64(nurture.stage) !== 2) fail('PET_DIARY_INVALID_STAGE', '比熊尚未成年');
    if (nurture.dog_granted === true) fail('PET_DIARY_ALREADY', '比熊已经领取');
  } else if (action === 'story') {
    const order = toNum(input && input.order);
    if (order <= 0) fail('PET_DIARY_INVALID_INPUT', '手记编号无效');
    const stories = list(state.story && state.story.stories);
    const match = stories.find(s => num64(s.order) === order && s.unlocked === true && s.claimed !== true);
    if (!match) fail('PET_DIARY_INVALID_STATE', '手记尚未解锁或已领取');
    params = { order };
  } else if (action === 'seeds') {
    if (!seeds || !headActive(seeds.head)) fail('PET_DIARY_INACTIVE', '种子礼包节点不在活动时间内');
    const rewards = list(seeds.mega_event && seeds.mega_event.rewards);
    if (!rewards.some(r => r.claimable === true && r.claimed !== true)) {
      fail('PET_DIARY_INVALID_STATE', '当前没有可领取的种子礼包');
    }
    targetId = PET_DIARY_SEEDS_ID;
  } else if (action === 'exchange') {
    if (!shop) fail('PET_DIARY_INACTIVE', '商城节点不可用');
    const goodsId = toNum(input && input.goodsId);
    const count = Math.max(1, toNum(input && input.count) || 1);
    if (goodsId <= 0) fail('PET_DIARY_INVALID_INPUT', '商品编号无效');
    const goods = list(shop.shop && shop.shop.goods).find(g => num64(g.id) === goodsId);
    if (!goods) fail('PET_DIARY_INVALID_INPUT', '服务端目录未发现该商品');
    if (num64(goods.diamond_cost_count) > 0
      || list(goods.cost).some(c => String(num64(c.id)) === String(DIAMOND_ITEM_ID))) {
      fail('PET_DIARY_DIAMOND_BLOCKED', '该商品可能消耗钻石，已阻止兑换');
    }
    if (BigInt(str64(goods.purchase_limit)) > 0n
      && BigInt(str64(goods.purchased_count)) + BigInt(count) > BigInt(str64(goods.purchase_limit))) {
      fail('PET_DIARY_LIMIT', '兑换数量超过剩余限购次数');
    }
    if (!costsAvailable(list(goods.cost), await readBalances(getBag, getBagItems), count)) {
      fail('PET_DIARY_INSUFFICIENT', '兑换余额不足');
    }
    targetId = PET_DIARY_SHOP_ID;
    params = { goods_id: goodsId, count };
  } else if (action === 'compensation') {
    if (num64(state.plunder && state.plunder.plunder_compensation_count) <= 0) {
      fail('PET_DIARY_INVALID_STATE', '当前没有可领取的夺宝补偿');
    }
  } else if (action === 'skipBattle') {
    const skip = input && input.skip;
    if (typeof skip !== 'boolean') fail('PET_DIARY_INVALID_INPUT', '跳过动画设置无效');
    params = { skip };
  } else if (action === 'markStories') {
    const orders = list(input && input.orders).map(toNum).filter(Boolean);
    if (!orders.length) fail('PET_DIARY_INVALID_INPUT', '手记编号无效');
    params = { orders };
  } else {
    fail('PET_DIARY_UNKNOWN_ACTION', `操作 ${action} 未开放（夺宝等好友交互暂不提供）`);
  }

  const { reply, selector, command } = await operatePetDiary(action, params, targetId);
  const result = reply[selector] || {};
  const rewards = items(result.rewards || result.awards);
  log('活动', `萌宠操作完成: ${action}(cmd ${command}) 奖励 ${rewards.length} 项`, {
    module: 'activity',
    event: 'pet_diary_operate',
    action,
    command,
    targetId,
    rewardCount: rewards.length,
    result: 'ok',
  });
  return {
    action,
    rewards,
    message: '操作成功，请刷新查看最新状态',
    operateReplyId: num64(reply.activity_id),
  };
}

module.exports = {
  PET_DIARY_GROUP_ID,
  PET_DIARY_PLAY_ID,
  PET_DIARY_SEEDS_ID,
  PET_DIARY_SHOP_ID,
  OPERATIONS,
  runManualPetDiaryAction,
  readPetDiaryGroup,
  operatePetDiary,
};
