'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const codec = require('./muge-codec');
const { MUGE_ROOT_ACTIVITY_ID, normalizeMuge, unavailable } = require('./muge-activity');
const { decimal, itemDto, positiveId } = require('./ranch-model');

const questions = require('../gameConfig/MugeQuestions.json').map(({ id, title, options }) =>
  ({ id, title, options: options.map((text, index) => ({ value: index + 1, text })) }));
const rootId = String(MUGE_ROOT_ACTIVITY_ID);
const sections = { celebration: '2026111702', friends: '2026111703', handbook: '2026111704', survey: '2026111705' };
const claims = {
  claimCelebration: { section: 'celebration', field: 'celebration', cmd: 85, rows: 'tiers', label: '领取兴牧庆典奖励' },
  claimFriends: { section: 'friends', field: 'friends', cmd: 84, rows: 'tiers', label: '领取牧友同行奖励' },
  claimTask: { section: 'handbook', field: 'task', cmd: 82, rows: 'tasks', label: '领取成长手册任务奖励' },
  claimHandbook: { section: 'handbook', field: 'handbook', cmd: 83, rows: 'tiers', label: '领取成长手册档位奖励' },
};
const surveyOperations = {
  save: { section: 'survey', field: 'save', cmd: 86 },
  settle: { section: 'survey', field: 'settle', cmd: 87 },
  share: { section: 'survey', field: 'share', cmd: 89, label: '领取牧场人格首次分享奖励' },
};
const rewardRows = rows => rows.map(itemDto).filter(item => item.count !== '0');
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const unavailableResult = () => fail('MUGE_RESULT_UNKNOWN', '结果待核对，请刷新活动查看进度');
const allowedInput = new Set(['claimCelebration', 'claimFriends', 'claimTask', 'claimHandbook', 'finishSurvey', 'resetSurvey', 'claimShare', 'setAutomation']);

function uniqueRows(rows, map) {
  const result = rows.map(map);
  if (new Set(result.map(row => row.id)).size !== result.length) fail('MUGE_READ_FAILED', '活动状态包含重复目标');
  return result;
}

function tierDto(rows) {
  return uniqueRows(rows, row => ({
    id: positiveId(row.id), threshold: decimal(row.threshold), status: row.status, rewards: rewardRows(row.rewards),
  }));
}

function surveyDto(survey) {
  if (!survey) return null;
  const answers = Object.fromEntries(Object.entries(survey.answers)
    .map(([key, value]) => [codec.decimalKey(key), Number(value)])
    .filter(([key, value]) => questions.some(q => String(q.id) === key && q.options.some(o => o.value === value))));
  const id = Number(survey.personality_id);
  return { answers, personalityId: Number.isSafeInteger(id) && id >= 0 ? id : 0,
    settleCount: decimal(survey.settle_count), shareRewardClaimed: survey.share_reward_claimed };
}

function sectionDto(node, key) {
  const raw = node?.[key];
  if (!raw) return null;
  if (key === 'celebration') return { total: decimal(raw.total), tiers: tierDto(raw.tiers) };
  if (key === 'friends') return { count: new Set(raw.counted.map(row => row.gid).filter(id => id !== '0')).size, tiers: tierDto(raw.tiers) };
  if (key === 'handbook') return { points: decimal(raw.points), tiers: tierDto(raw.tiers),
    tasks: uniqueRows(raw.tasks, row => ({ id: positiveId(row.id), description: row.description.slice(0, 180),
      progress: decimal(row.progress), target: decimal(row.target), status: row.status,
      unlockDay: decimal(row.unlock_day), rewards: rewardRows(row.rewards) })) };
  return surveyDto(raw);
}

function readBoard(group, now) {
  if (!group) return { ...unavailable('当前列表未下发活动'), personal: null };
  const h = group.head;
  const startTime = Number(h.start_time);
  const endTime = Number(h.end_time);
  if (!Number.isSafeInteger(startTime) || startTime <= 0 || !Number.isSafeInteger(endTime) || endTime <= startTime)
    fail('MUGE_READ_FAILED', '活动开始或结束时间未确认');
  if (now >= endTime) return { ...unavailable('活动已结束', endTime), personal: null };
  let payload;
  try { payload = JSON.parse(h.payload); } catch { payload = null; }
  const rules = normalizeMuge({ id: MUGE_ROOT_ACTIVITY_ID, parentId: 0, title: h.title, startTime, endTime, payload }, now);
  const child = key => group.children.find(node => node.head?.id === sections[key] && node.head.parent_id === rootId
    && now >= (Number(node.head.start_time) || startTime) && now < (Number(node.head.end_time) || endTime));
  const open = now >= startTime && h.status === 1;
  const personal = open ? {
    celebration: sectionDto(child('celebration'), 'celebration'), friends: sectionDto(child('friends'), 'friends'),
    handbook: sectionDto(child('handbook'), 'handbook'), personality: sectionDto(child('survey'), 'survey'),
  } : null;
  return { available: true, title: h.title || '牧歌初启', startTime, endTime, phase: open ? 'open' : 'upcoming',
    sections: rules.sections || [], notes: rules.notes || [], questions: personal?.personality ? questions : [], personal };
}

function createMugeGameplay({ network, file, now, automationAllowed = () => true,
  log = () => {} }) {
  let running = false;
  function load() {
    try {
      const data = JSON.parse(fs.readFileSync(file(), 'utf8'));
      if (data.version !== 1 || typeof data.enabled !== 'boolean' || !Number.isSafeInteger(data.nextAt)
        || !data.pending || typeof data.pending !== 'object' || Array.isArray(data.pending)) throw new Error('invalid');
      return data;
    } catch (cause) {
      if (cause.code === 'ENOENT') return { version: 1, enabled: false, nextAt: 0, pending: {} };
      fail('MUGE_STORAGE_FAILED', '牧歌操作记录暂不可读');
    }
  }
  function save(data) {
    const target = file();
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const tmp = `${target}.${crypto.randomUUID()}.tmp`;
    try {
      const fd = fs.openSync(tmp, 'wx', 0o600);
      try { fs.writeFileSync(fd, JSON.stringify(data)); fs.fsyncSync(fd); }
      finally { fs.closeSync(fd); }
      fs.renameSync(tmp, target);
    } finally { fs.rmSync(tmp, { force: true }); }
  }
  async function read() {
    const { body } = await network.sendMsgAsync('gamepb.activitypb.ActivityService', 'List',
      codec.encode('ListRequest', { game_scene_id: 1 }), 9000);
    const reply = codec.decode('ListReply', body);
    const group = reply.groups.find(node => node.head?.id === rootId && node.head?.parent_id === '0');
    const board = readBoard(group, now());
    const data = load();
    const prior = Object.keys(data.pending).length;
    const personal = board.personal;
    if (personal) {
      for (const [key, value] of Object.entries(data.pending)) {
        const rule = claims[key];
        const rows = rule && personal[rule.section]?.[rule.rows];
        const survey = personal.personality;
        if ((rows && value.ids.every(id => rows.some(row => row.id === id && row.status === 3)))
          || (key === 'share' && survey?.shareRewardClaimed)
          || (key === 'save' && survey && Object.entries(value.answers).every(([id, answer]) => survey.answers[id] === answer))
          || (key === 'reset' && survey && !Object.keys(survey.answers).length)
          || (key === 'settle' && survey && BigInt(survey.settleCount) > BigInt(value.count))) delete data.pending[key];
      }
    }
    if (prior !== Object.keys(data.pending).length) save(data);
    return { ...board, automation: { enabled: data.enabled }, pendingActions: Object.keys(data.pending) };
  }

  async function dispatch(board, socket, key, rule, payload, pending, validate, automatic) {
    if (network.getWs() !== socket || !network.isConnected() || now() >= board.endTime)
      fail('MUGE_SESSION_CHANGED', '活动或账号连接已变化，请刷新');
    const data = load();
    if (automatic && (!data.enabled || !automationAllowed())) fail('MUGE_PAUSED', '活动自动领取已暂缓');
    if (data.pending[key]) unavailableResult();
    const id = sections[rule.section];
    const bytes = codec.encode('Operation', { id, cmd: rule.cmd, [rule.field]: payload });
    data.pending[key] = pending;
    save(data);
    let receipt;
    let rewards;
    try {
      const { body } = await network.sendMsgAsync('gamepb.activitypb.ActivityService', 'Operate', bytes, 9000);
      receipt = codec.decode('Receipt', body);
      if (network.getWs() !== socket || receipt.id !== id || Number(receipt.cmd) !== rule.cmd
        || receipt.state?.head?.id !== id || !receipt[rule.field]) unavailableResult();
      validate(receipt[rule.field], sectionDto(receipt.state, rule.section));
      rewards = rewardRows(receipt[rule.field].awards || []);
    } catch (cause) {
      if (cause.isLocalRequestRejection === true || cause.isGovernedRejection === true) {
        const latest = load();
        delete latest.pending[key];
        save(latest);
        fail('MUGE_NOT_SENT', '本轮请求暂缓，请稍后刷新');
      }
      unavailableResult();
    }
    const latest = load();
    delete latest.pending[key];
    save(latest);
    const result = receipt[rule.field];
    if (rule.label) log(rule.label, result.claimed_ids?.length || rewards.length || 1, rewards, automatic);
    return rewards;
  }

  async function claim(board, socket, action, automatic) {
    const rule = claims[action];
    const rows = board.personal[rule.section]?.[rule.rows];
    if (!rows) fail('MUGE_UNAVAILABLE', '该模块进度暂未返回');
    const ids = rows.filter(row => row.status === 2).map(row => row.id);
    if (!ids.length) fail('MUGE_NOT_CLAIMABLE', '暂无可领取奖励');
    return dispatch(board, socket, action, rule, { target: 0 }, { ids }, (result, current) => {
      const known = new Set(rows.map(row => row.id));
      if (!result.claimed_ids.length || new Set(result.claimed_ids).size !== result.claimed_ids.length
        || result.claimed_ids.some(id => !known.has(id) || !current?.[rule.rows]?.some(row => row.id === id && row.status === 3))) unavailableResult();
    }, automatic);
  }

  async function operate(action, input = {}, automatic = false) {
    if (!allowedInput.has(action) || !input || typeof input !== 'object' || Array.isArray(input))
      fail('MUGE_INVALID_ARGUMENT', '牧歌操作参数无效');
    if (action === 'setAutomation') {
      if (typeof input.enabled !== 'boolean') fail('MUGE_INVALID_ARGUMENT', '自动领取设置无效');
      const data = load();
      data.enabled = input.enabled;
      data.nextAt = 0;
      save(data);
      try { return { activity: await read() }; }
      catch { return { activity: null, refreshRequired: true }; }
    }
    if (running) fail('MUGE_BUSY', '牧歌操作正在进行');
    if (!network.isConnected() || !network.getWs()) fail('MUGE_OFFLINE', '账号尚未连接');
    running = true;
    const socket = network.getWs();
    try {
      const board = await read();
      if (board.phase !== 'open' || !board.personal) fail('MUGE_UNAVAILABLE', '牧歌初启当前无法操作');
      let rewards = [];
      if (Object.hasOwn(claims, action)) {
        rewards = await claim(board, socket, action, automatic);
      } else {
        const survey = board.personal.personality;
        if (!survey) fail('MUGE_UNAVAILABLE', '牧场人格进度暂未返回');
        if (action === 'claimShare') {
          if (!survey.personalityId || survey.shareRewardClaimed) fail('MUGE_NOT_CLAIMABLE', '请先完成人格测试，首次分享奖只能领取一次');
          rewards = await dispatch(board, socket, 'share', surveyOperations.share, {}, {}, (_, current) => {
            if (!current?.shareRewardClaimed) unavailableResult();
          }, false);
        } else if (action === 'resetSurvey') {
          if (!Object.keys(survey.answers).length) return { activity: board, rewards };
          await dispatch(board, socket, 'reset', surveyOperations.save, { clear: true }, {}, (_, current) => {
            if (!current || Object.keys(current.answers).length) unavailableResult();
          }, false);
        } else {
          const answers = input.answers;
          if (!answers || typeof answers !== 'object' || Array.isArray(answers) || Object.keys(answers).length !== questions.length
            || !questions.every(question => question.options.some(option => option.value === answers[question.id])))
            fail('MUGE_INVALID_ARGUMENT', '请为每道题选择一个有效选项');
          const matches = current => current && Object.entries(answers).every(([id, answer]) => current.answers[id] === answer);
          if (!matches(survey)) await dispatch(board, socket, 'save', surveyOperations.save, { answers }, { answers }, (_, current) => {
            if (!matches(current)) unavailableResult();
          }, false);
          await dispatch(board, socket, 'settle', surveyOperations.settle, {}, { count: survey.settleCount }, (result, current) => {
            if (!current?.personalityId || Number(result.personality_id) !== current.personalityId
              || BigInt(current.settleCount) <= BigInt(survey.settleCount)) unavailableResult();
          }, false);
        }
      }
      try { return { activity: await read(), rewards }; }
      catch { return { activity: null, rewards, refreshRequired: true }; }
    } finally { running = false; }
  }

  async function automate() {
    const at = now();
    const data = load();
    if (!data.enabled || data.nextAt > at || running || !automationAllowed()) return;
    data.nextAt = at + 300;
    save(data);
    running = true;
    try {
      const socket = network.getWs();
      if (!socket || !network.isConnected()) return;
      const board = await read();
      if (board.phase !== 'open' || !board.personal) return;
      for (const [action, rule] of Object.entries(claims)) {
        if (!board.pendingActions.includes(action) && board.personal[rule.section]?.[rule.rows].some(row => row.status === 2)) {
          await claim(board, socket, action, true);
          const latest = load();
          if (latest.enabled) {
            latest.nextAt = Math.min(latest.nextAt, now() + 30);
            save(latest);
          }
          break;
        }
      }
    } finally { running = false; }
  }
  return { read, operate, automate };
}

let instance;
let canAutomate;
function gameplay() {
  if (!instance) {
    const account = process.env.FARM_ACCOUNT_ID;
    if (!account) fail('MUGE_ACCOUNT_REQUIRED', '牧歌操作尚未绑定账号');
    const suffix = crypto.createHash('sha256').update(account).digest('hex').slice(0, 24);
    const { getServerTimeSec, log } = require('../utils/utils');
    instance = createMugeGameplay({ network: require('../utils/network'), now: getServerTimeSec,
      file: () => require('../config/runtime-paths').getDataFile(`muge-operations-${suffix}.json`),
      automationAllowed: () => canAutomate?.() === true,
      log: (label, count, rewards, automatic) => {
        const detail = rewards.map(item => `${item.name}×${item.count}`).join('、');
        log('活动', `牧歌初启 · ${label}${detail ? ` · ${detail}` : ''}`,
          { module: 'activity', event: 'muge_reward_claimed', result: 'ok', count, automatic });
      },
    });
  }
  return instance;
}

async function safe(call) {
  try { return { ok: true, ...await call() }; }
  catch (cause) {
    const known = /^MUGE_[A-Z_]+$/.test(cause?.code || '');
    return { ok: false, code: known ? cause.code : 'MUGE_READ_FAILED', error: known ? cause.message : '牧歌初启读取失败，请稍后刷新' };
  }
}

module.exports = {
  createMugeGameplay, readBoard,
  bindMugeAutomation: guard => { canAutomate = guard; },
  getMugeActivity: () => safe(async () => ({ activity: await gameplay().read() })),
  operateMuge: (action, input) => safe(() => gameplay().operate(action, input)),
  runMugeAutomation: () => safe(() => gameplay().automate()),
};
if (process.env.FARM_SESSION_BUSINESS === '1') {
  const { wrapBusinessFunction } = require('./business-state');
  for (const name of ['getMugeActivity', 'operateMuge', 'runMugeAutomation'])
    module.exports[name] = wrapBusinessFunction('muge:' + name, module.exports[name]);
}
