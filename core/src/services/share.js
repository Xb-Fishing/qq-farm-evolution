
// Persistent-session async operation tracking.
if (globalThis.process?.env?.FARM_SESSION_BUSINESS === '1') {
  // eslint-disable-next-line no-func-assign -- Preserve the hoisted function and its existing recursive callers.
  checkCanShare = require('./business-state').wrapBusinessFunction('services/share.js:checkCanShare', checkCanShare);
  // eslint-disable-next-line no-func-assign -- Preserve the hoisted function and its existing recursive callers.
  reportShare = require('./business-state').wrapBusinessFunction('services/share.js:reportShare', reportShare);
  // eslint-disable-next-line no-func-assign -- Preserve the hoisted function and its existing recursive callers.
  claimShareReward = require('./business-state').wrapBusinessFunction('services/share.js:claimShareReward', claimShareReward);
  // eslint-disable-next-line no-func-assign -- Preserve the hoisted function and its existing recursive callers.
  performDailyShare = require('./business-state').wrapBusinessFunction('services/share.js:performDailyShare', performDailyShare);
}
/**
 * 分享服务 - 每日自动完成分享并领取奖励
 *
 * 功能：
 * - 检查是否可以分享
 * - 上报分享状态
 * - 领取分享奖励
 */
const { sendMsgAsync } = require('../utils/network');
const { types } = require('../utils/proto');
const { log, toNum } = require('../utils/utils');
const { getItemById } = require('../config/gameConfig');
const fs = require('node:fs');
const path = require('node:path');
const { getDataFile } = require('../config/runtime-paths');

const DAILY_KEY = 'daily_share';

// 两次检查最小间隔：10分钟
const CHECK_COOLDOWN_MS = 10 * 60 * 1000;

// 每日状态追踪
let doneDateKey = '';
let lastCheckAt = 0;
let lastClaimAt = 0;
let running = false;

// Keep write claims on disk, outside the unchanged warm-state schema. Entry
// availability alone cannot reconcile a previously submitted reward request.
function attemptFile() {
  const account = String(process.env.FARM_ACCOUNT_ID || 'default').replace(/[^\w.-]/g, '_').slice(0, 80);
  return getDataFile(`daily-share-attempt-${account}.json`);
}

function readAttempt() {
  try {
    const value = JSON.parse(fs.readFileSync(attemptFile(), 'utf8'));
    if (value?.version !== 1 || !/^\d{4}-\d{2}-\d{2}$/.test(value.date || '')
      || !['ReportShare', 'ClaimShareReward'].includes(value.stage)
      || !['pending', 'ok', 'already_claimed'].includes(value.outcome)) throw new Error('Invalid share journal');
    return value;
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function writeAttempt(date, stage, outcome = 'pending') {
  const file = attemptFile(); const temporary = `${file}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  let fd;
  try {
    fd = fs.openSync(temporary, 'w', 0o600);
    fs.writeFileSync(fd, JSON.stringify({ version: 1, date, stage, outcome })); fs.fsyncSync(fd);
    fs.closeSync(fd); fd = undefined; fs.renameSync(temporary, file);
    const directory = fs.openSync(path.dirname(file), 'r');
    try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(temporary); } catch {}
  }
}

function decodeReply(type, body) {
  try { return type.decode(body); }
  catch { throw Object.assign(new Error('分享响应解析失败'), { code: 'SHARE_REPLY_DECODE_FAILED', replyBytes: body?.length || 0 }); }
}

// ---- 日期工具 ----

function getDateKey() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function markDoneToday(date = getDateKey()) {
  doneDateKey = date;
}

function isDoneToday() {
  return doneDateKey === getDateKey();
}

// ---- 奖励摘要 ----
// 1001→金币, 1002→经验, 500→点券

function getRewardSummary(items) {
  const list = Array.isArray(items) ? items : [];
  const parts = [];
  for (const item of list) {
    const id = toNum(item.id);
    const count = toNum(item.count);
    if (count <= 0) continue;
    if (id === 1001 || id === 500001) {
      parts.push(`金币${count}`);
    } else if (id === 1002 || id === 500002) {
      parts.push(`经验${count}`);
    } else if (id === 500) {
      parts.push(`点券${count}`);
    } else {
      const info = getItemById(id);
      const name = info && info.name ? String(info.name) : '未知物品';
      parts.push(`${name}x${count}`);
    }
  }
  return parts.join('/');
}

/**
 * 判断是否"已领取"错误
 */
function isAlreadyClaimedError(err) {
  const msg = String(err && err.message || '');
  return Number(err?.code) === 1009001 || /\bcode=1009001\b/.test(msg) || msg.includes('已经领取');
}

// ---- RPC 调用 ----

async function checkCanShare() {
  const request = types.CheckCanShareRequest.encode(
    types.CheckCanShareRequest.create({})
  ).finish();
  const { body } = await sendMsgAsync('gamepb.sharepb.ShareService', 'CheckCanShare', request);
  return decodeReply(types.CheckCanShareReply, body);
}

async function reportShare() {
  const request = types.ReportShareRequest.encode(
    types.ReportShareRequest.create({ shared: true })
  ).finish();
  const { body } = await sendMsgAsync('gamepb.sharepb.ShareService', 'ReportShare', request);
  // RPC transport success has already been checked. The reply has no bool
  // success field; never publish the opaque share result (it may contain Ark).
  decodeReply(types.ReportShareReply, body);
}

async function claimShareReward() {
  const request = types.ClaimShareRewardRequest.encode(
    types.ClaimShareRewardRequest.create({ claimed: true })
  ).finish();
  const { body } = await sendMsgAsync('gamepb.sharepb.ShareService', 'ClaimShareReward', request);
  return decodeReply(types.ClaimShareRewardReply, body);
}

// ---- 主逻辑 ----

/**
 * 执行每日分享任务
 * @param {boolean} force - 强制检查
 */
async function performDailyShare(force = false) {
  const now = Date.now();

  if (running || isDoneToday()) return false;
  if (!force && now - lastCheckAt < CHECK_COOLDOWN_MS) return false;

  lastCheckAt = now;
  running = true;
  const date = getDateKey();
  let stage = 'journal'; let submitted = false;
  try {
    const previous = readAttempt();
    if (previous?.date === date) {
      if (previous.outcome !== 'pending') markDoneToday(date);
      else log('分享', '本次分享请求已提交、结果待核对，今日不重复提交', {
        module: 'task', event: DAILY_KEY, result: 'unknown', stage: previous.stage,
      });
      return false;
    }
    // 检查是否可以分享
    stage = 'CheckCanShare';
    const canShareResult = await checkCanShare();
    if (!canShareResult || !canShareResult.can_share) {
      markDoneToday(date);
      log('分享', '今日暂无可领取分享礼包', { module: 'task', event: DAILY_KEY, result: 'none' });
      return false;
    }

    // A failed durable claim prevents sending. Forced checks cannot bypass an
    // unknown write, including after a restart or a business-only replacement.
    if (getDateKey() !== date) return false;
    stage = 'ReportShare'; writeAttempt(date, stage); submitted = true;
    await reportShare();
    if (getDateKey() !== date) return false;
    stage = 'ClaimShareReward'; writeAttempt(date, stage);
    const claimResult = await claimShareReward();
    const items = Array.isArray(claimResult.items) ? claimResult.items : [];
    if (!items.some(item => toNum(item.id) > 0 && toNum(item.count) > 0)) {
      log('分享', '领取响应未确认奖励，本次结果待核对，今日不重复提交', {
        module: 'task', event: DAILY_KEY, result: 'unknown', stage,
      });
      return false;
    }
    const summary = getRewardSummary(items);

    log('分享',
      summary ? `领取成功 → ${summary}` : '领取成功',
      { module: 'task', event: DAILY_KEY, result: 'ok', count: items.length }
    );

    lastClaimAt = Date.now();
    markDoneToday(date);
    try { writeAttempt(date, stage, 'ok'); } catch { /* Pending claim still prevents replay. */ }
    return true;
  } catch (err) {
    if (submitted && isAlreadyClaimedError(err)) {
      markDoneToday(date);
      try { writeAttempt(date, stage, 'already_claimed'); } catch { /* Keep the pending claim. */ }
      log('分享', '今日分享奖励已领取', { module: 'task', event: DAILY_KEY, result: 'none', stage });
      return false;
    }
    const reason = err?.code === 'SHARE_REPLY_DECODE_FAILED' ? err.code : 'SHARE_REQUEST_FAILED';
    log('分享', submitted ? `${stage} 响应异常，结果待核对，今日不重复提交` : `分享检查失败（${stage}）`, {
      module: 'task', event: DAILY_KEY, result: submitted ? 'unknown' : 'error', stage, reason,
      ...(err?.replyBytes ? { replyBytes: err.replyBytes } : {}),
    });
    return false;
  } finally { running = false; }
}

module.exports = {
  performDailyShare,
  getShareDailyState: () => ({
    key: DAILY_KEY,
    doneToday: isDoneToday(),
    lastCheckAt,
    lastClaimAt,
  }),
};

// Persistent-session data capsule. No handles, functions or in-flight work.
if (globalThis.process?.env?.FARM_SESSION_BUSINESS === '1') {
  const { registerDataState } = require('./business-state');
  registerDataState('services/share.js', () => ({ doneDateKey, lastCheckAt, lastClaimAt }), value => {
      doneDateKey = value.doneDateKey;
      lastCheckAt = value.lastCheckAt;
      lastClaimAt = value.lastClaimAt;
  }, { idle: () => !running });
}
