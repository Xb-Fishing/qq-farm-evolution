/**
 * 秋祈良愿 / 快乐不独享（2026-09-24 开放）手动操作服务
 *
 * 命令字与字段号来自官方编码器重构：公开参考项目 1（映射仅存本机）@0ba48a1
 * 只读对照移植，其协议恢复文档声明字段号经官方生成代码 create/encode sentinel
 * 探测并由 HAR 明文响应标签交叉验证；四条请求编码已在本仓库 proto 下字节级
 * 复现（见 test/season-wish-operate.test.js 的 hex 断言）。
 *
 * 安全边界（照 pet-diary-operate 的手动模式）：
 * - 只在面板手动触发路径执行，不接每日自动任务；每次操作前重读
 *   List + GetGroup 做服务端前置校验（次数/状态/档位），与官方客户端一致，
 *   避免本地状态过期重复请求。
 * - shareShare（cmd 69 分享）不开放：面板按钮无法完成官方分享的用户流程
 *   （拉起 QQ 转发），直接发命令等于伪造分享状态；其响应还含敏感分享密钥。
 * - 失败错误原样给面板（业务码 + 消息），不做自动重试。
 */

const { toNum, toLong, log } = require('../utils/utils');
const { sendMsgAsync } = require('../utils/network');
const { types } = require('../utils/proto');
const { getActivityGroup, listActivityGroups, normalizeCoreItem } = require('./activity');

const WISH_SIGN_GROUP_ID = 2026092400;
const WISH_SIGN_PLAY_ID = 2026092401;
const HAPPY_SHARE_GROUP_ID = 2026092500;
const HAPPY_SHARE_PLAY_ID = 2026092501;

// 官方 ActivityWishSignChoose（协议恢复文档）：1-6 财运/感情/前程/生活/农耕/人际
const WISH_CHOICES = ['财运', '感情', '前程', '生活', '农耕', '人际'];

// 手动层白名单：action -> [目标子活动 ID, cmd, 是否带 choose_id 选择器]
const OPERATIONS = {
  wishDraw: [WISH_SIGN_PLAY_ID, 51, true],
  wishClaim: [WISH_SIGN_PLAY_ID, 52, true],
  shareDaily: [HAPPY_SHARE_PLAY_ID, 73, false],
  shareMilestones: [HAPPY_SHARE_PLAY_ID, 70, false],
};

function businessError(code, message) {
  const err = new Error(message);
  err.code = code;
  err.business = true;
  return err;
}

function fail(code, message) { throw businessError(code, message); }

const rewards = value => (Array.isArray(value) ? value : []).filter(Boolean).map(normalizeCoreItem);

/** List 确认目标根活动下发后，用空 UID 读取根 GetGroup，返回其玩法节点（不在窗口返回 null）。 */
async function readSeasonWishPlay(rootId, playId) {
  const listed = await listActivityGroups();
  const flatten = nodes => (nodes || []).flatMap(node => [node, ...flatten(node.children)]);
  const nodes = flatten(listed?.groups);
  if (!nodes.some(node => toNum(node?.activity?.id) === rootId && !toNum(node.activity.parent_id))) {
    return { listed: false, play: null };
  }
  const reply = await getActivityGroup(rootId, '', { discoveryProbe: true });
  const now = Math.floor(Date.now() / 1000);
  const play = (reply?.group?.children || []).find(node => toNum(node?.activity?.id) === playId) || null;
  const head = play?.activity;
  const active = !!play && toNum(head?.start_time) > 0 && now >= toNum(head.start_time) && now <= toNum(head.end_time);
  return { listed: true, play: active ? play : null };
}

/**
 * 手动操作入口。每次操作前重读活动状态做服务端前置校验，成功后返回奖励。
 * 未知操作在编码与请求前拒绝；不做自动重试。
 */
async function runManualSeasonWishAction(action, input = {}) {
  if (!Object.prototype.hasOwnProperty.call(OPERATIONS, action)) {
    fail('SEASON_WISH_UNKNOWN_ACTION', '该操作未开放（分享类操作不开放面板触发）');
  }
  const [targetId, command, withChoice] = OPERATIONS[action];
  const isWish = action === 'wishDraw' || action === 'wishClaim';
  const { listed, play } = await readSeasonWishPlay(
    isWish ? WISH_SIGN_GROUP_ID : HAPPY_SHARE_GROUP_ID,
    targetId,
  );
  if (!listed) {
    fail('SEASON_WISH_UNAVAILABLE', '活动未由当前 ActivityService.List 下发，停止操作');
  }
  const chooseId = toNum(input.chooseId);
  if (withChoice) {
    if (!Number.isInteger(chooseId) || chooseId < 1 || chooseId > WISH_CHOICES.length) {
      fail('WISH_SIGN_INVALID_CHOICE', '祈愿选择无效（1-6）');
    }
  }

  if (isWish) {
    if (!play) fail('WISH_SIGN_INACTIVE', '秋祈良愿当前不在活动时间内');
    const body = play.wish_sign;
    if (!body) fail('WISH_SIGN_NO_STATE', '服务端未下发祈愿状态，停止操作');
    const pending = body.pending || null;
    if (action === 'wishDraw') {
      if (pending) fail('WISH_SIGN_PENDING', '当前有待领取的祈愿奖励，请先领取');
      if (toNum(body.remaining_count) <= 0) fail('WISH_SIGN_LIMIT', '今日祈愿次数已用完');
    } else if (!pending || toNum(pending.choose_id) !== chooseId) {
      fail('WISH_SIGN_NO_PENDING', '没有与所选签文匹配的待领奖励');
    }
  } else {
    if (!play) fail('HAPPY_SHARE_INACTIVE', '快乐不独享当前不在活动时间内');
    const summary = play.share_reward?.summary;
    if (!summary) fail('HAPPY_SHARE_NO_STATE', '服务端未下发快乐值状态，停止操作');
    if (action === 'shareDaily' && summary.daily?.daily_reward_claimed === true) {
      fail('HAPPY_SHARE_CLAIMED', '今日快乐值已领取');
    }
    if (action === 'shareMilestones') {
      const currentScore = toNum(summary.current_score);
      const claimable = (summary.milestones || []).some(tier => toNum(tier?.state) === 2
        && currentScore >= toNum(tier?.threshold));
      if (!claimable) fail('HAPPY_SHARE_NO_CLAIMABLE', '当前没有可领取的快乐值档位');
    }
  }

  const requestInput = { id: toLong(targetId), cmd: command };
  if (withChoice) {
    requestInput[action === 'wishDraw' ? 'wish_sign_draw' : 'wish_sign_claim'] = { choose_id: chooseId };
  }
  const request = types.ActivityOperateRequest.encode(
    types.ActivityOperateRequest.create(requestInput),
  ).finish();
  const { body } = await sendMsgAsync('gamepb.activitypb.ActivityService', 'Operate', request);
  const reply = types.ActivityOperateReply.decode(body);
  if (toNum(reply.id) !== targetId || toNum(reply.cmd) !== command) {
    fail('SEASON_WISH_REPLY_MISMATCH', '活动响应不匹配，请刷新后查看结果');
  }

  let result = { ok: true, rewards: [] };
  if (action === 'wishDraw') {
    result = { ok: true, rewards: rewards(reply.wish_sign_draw?.rewards) };
  } else if (action === 'wishClaim') {
    result = { ok: true, rewards: rewards(reply.wish_sign_claim?.awards) };
  } else if (action === 'shareDaily') {
    const rsp = reply.share_reward_claim_daily;
    result = { ok: true, grantedScore: toNum(rsp?.granted_score), rewards: rewards(rsp?.rewards) };
  } else if (action === 'shareMilestones') {
    const rsp = reply.share_reward_claim_milestones;
    result = {
      ok: true,
      claimedTierIds: (rsp?.claimed_tier_ids || []).map(toNum),
      rewards: rewards(rsp?.rewards),
    };
  }
  log('活动', `季节活动手动操作完成: ${action}`, { event: 'season_wish_operate', action, activityId: targetId });
  return result;
}

module.exports = {
  OPERATIONS,
  WISH_CHOICES,
  WISH_SIGN_GROUP_ID, WISH_SIGN_PLAY_ID,
  HAPPY_SHARE_GROUP_ID, HAPPY_SHARE_PLAY_ID,
  runManualSeasonWishAction,
};
