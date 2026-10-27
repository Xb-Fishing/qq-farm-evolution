const { types } = require('../utils/proto');
const network = require('../utils/network');
const { getItemById, getItemImageById } = require('../config/gameConfig');
const config = require('../gameConfig/SolarCalendar.json');
const SERVICE = 'gamepb.solartermspb.SolarTermsV2Service';
let busy = false;
function reject(code, message) { throw Object.assign(new Error(message), { code: `FESTIVAL_${code}`, business: true }); }
function guard(deps, connection) {
  if ((deps.getConnection || network.getWs)() !== connection) reject('CONNECTION_CHANGED', '连接已变更，请重新查询');
  if (!(deps.isReady || (() => network.isConnected()))()) reject('NOT_READY', '账号未连接');
}
async function rpc(method, input, deps) {
  const request = types[`${method}Request`];
  const { body } = await (deps.sendMsgAsync || network.sendMsgAsync)(SERVICE, method, request.encode(request.create(input)).finish());
  return types[`${method}Reply`].decode(body);
}
function rewards(rows) {
  return (rows || []).filter(row => Number(row.id) > 0 && Number(row.count) > 0).slice(0, 30).map(row => ({
    id: Number(row.id), count: String(row.count), name: getItemById(Number(row.id))?.name || '未知物品', image: getItemImageById(Number(row.id)),
  }));
}
function calendarDto(raw) {
  if (!Object.hasOwn(raw, 'server_time') || !(Number(raw.server_time) > 0)) reject('NO_STATE', '节日签到状态不完整，请稍后重新查询');
  const now = Number(raw.server_time);
  return {
    serverTime: now, defaultEventId: Number(raw.default_event_id || 0),
    events: (raw.events || []).slice(0, 50).map(row => {
      const entry = config.events.find(item => item.id === Number(row.id));
      const options = entry?.answer?.split(';') || [];
      const open = Number(row.window_status) === 2 && Number(row.open_start_time) <= now && now < Number(row.open_end_time);
      return { id: Number(row.id), name: entry?.name || '节令活动', description: entry?.description || '',
        startTime: Number(row.open_start_time), endTime: Number(row.open_end_time), open,
        directClaimed: row.direct_claimed === true, quizClaimed: row.quiz_claimed === true, quizWrongToday: row.quiz_wrong_today === true,
        question: entry?.question || '', options, wrongOptions: (row.wrong_options || []).map(Number),
        rewards: rewards(row.rewards), questionRewards: rewards(row.question_rewards),
        canClaim: open && row.direct_claimed !== true && rewards(row.rewards).length > 0,
        canAnswer: open && !!entry?.question && options.length > 1 && row.quiz_claimed !== true && row.quiz_wrong_today !== true,
      };
    }),
    seasons: (raw.seasons || []).slice(0, 10).map(row => ({ id: Number(row.id),
      name: config.seasons.find(item => item.id === Number(row.id))?.name || '季度图鉴',
      litCount: Number(row.lit_count || 0), totalCount: Number(row.total_count || 0), rewards: rewards(row.rewards),
      claimed: row.reward_claimed === true, canClaim: row.reward_claimable === true && row.reward_claimed !== true && rewards(row.rewards).length > 0,
    })),
  };
}
async function getSolarCalendar(deps = {}) {
  const connection = (deps.getConnection || network.getWs)(); guard(deps, connection);
  const raw = await rpc('GetSolarTermsV2', {}, deps); guard(deps, connection);
  return calendarDto(raw);
}
async function operateSolarCalendar(action, input = {}, deps = {}) {
  if (!['claim', 'answer', 'season'].includes(action)) reject('INPUT', '未知的节日操作');
  if (!Number.isSafeInteger(input.id) || input.id <= 0) reject('INPUT', '请选择当前活动');
  if (busy) reject('BUSY', '节日操作进行中，请稍后再试');
  busy = true;
  try {
    const connection = (deps.getConnection || network.getWs)(); guard(deps, connection);
    const state = await getSolarCalendar(deps); guard(deps, connection);
    const target = (action === 'season' ? state.seasons : state.events).find(row => row.id === input.id);
    if (!target || !(action === 'answer' ? target.canAnswer : target.canClaim)) reject('INELIGIBLE', '当前不满足领取或答题条件，请重新查询');
    if (action !== 'season' && Math.floor((deps.now || Date.now)() / 1000) >= target.endTime) reject('ENDED', '本期活动已结束');
    const params = { id: input.id };
    if (action === 'answer') {
      const index = input.optionIndex;
      if (input.expectedQuestion !== target.question || !Number.isInteger(index) || index < 0 || index >= target.options.length || target.wrongOptions.includes(index)) reject('ANSWER_CHANGED', '题目或选项已变化，请重新选择');
      params.option_index = index;
    }
    const method = { claim: 'ClaimSolarTermsV2', answer: 'AnswerSolarTerms', season: 'ClaimSolarSeason' }[action];
    guard(deps, connection);
    let reply;
    try { reply = await rpc(method, params, deps); }
    catch { return { ok: false, outcome: 'unknown', message: '结果未知，请重新查询核对，不会自动重试' }; }
    const updated = action === 'season' ? reply.updated_season : reply.updated_event;
    const granted = rewards(reply.rewards);
    const confirmed = action === 'claim' ? updated?.direct_claimed === true && granted.length > 0
      : action === 'season' ? updated?.reward_claimed === true && granted.length > 0
        : reply.correct === true ? updated?.quiz_claimed === true && granted.length > 0
          : updated?.quiz_wrong_today === true;
    if (!updated || Number(updated.id) !== input.id || !confirmed) return { ok: false, outcome: 'unknown', message: '回包未确认结果，请重新查询核对，不会自动重试' };
    return { ok: true, correct: action === 'answer' ? reply.correct === true : undefined, rewards: granted, message: action === 'answer' ? (reply.correct ? '回答正确，奖励已领取' : '本次回答不正确，请按活动规则稍后再试') : '奖励已领取' };
  } finally { busy = false; }
}
module.exports = { getSolarCalendar, operateSolarCalendar, calendarDto };
