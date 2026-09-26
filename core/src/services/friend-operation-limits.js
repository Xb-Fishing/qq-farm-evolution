const { toNum, log, sleep } = require('../utils/utils');
const { getUserState } = require('../utils/network');
const { types } = require('../utils/proto');
const { sendMsgAsync } = require('../utils/network');
const { toLong } = require('../utils/utils');

// ===== Operation limits state =====
const operationLimits = new Map();
let lastResetDate = '';
let canGetHelpExp = true;
let helpAutoDisabledByLimit = false;
let localBadOperationCount = 0;

// 捣乱操作 ID（2026-09-26 修正，证据存 ignored tmp/mischief-operation-id-proof.json）：
// 10003 = 放草/放虫共用的每日 shared 额度（PutWeeds 与 PutInsects 均消耗它），
//         服务器侧 day_times 即当日已用捣乱总数；
// 10004 = 放虫单项计数（仅 PutInsects 回报），只作单项剩余判断，不并入总额。
// 10005/10006/10007 = 帮好友除草/除虫/浇水，属帮助计数，不进捣乱预算。
const BAD_SHARED_OPERATION_ID = 10003;
const PUT_BUG_OPERATION_ID = 10004;
const PUT_WEED_OPERATION_ID = 10003;
const GOLDEN_BUG_OPERATION_ID = 10015;
const BAD_DAILY_LIMIT = 100;

// ===== Operation type names =====
const OP_NAMES = {
  '10001': '操作 #10001',
  '10002': '操作 #10002',
  '10003': '捣乱共享额度（放虫/放草）',
  '10004': '给好友放虫',
  '10005': '帮好友除草',
  '10006': '帮好友除虫',
  '10007': '帮好友浇水',
  '10008': '操作 #10008',
  '10015': '给好友放黄金虫',
};

// ===== Daily reset =====

/**
 * Check if a new day has started (China timezone UTC+8) and reset limits.
 */
function checkDailyReset() {
  const { getServerTimeSec } = require('../utils/utils');
  const serverSec = getServerTimeSec();
  const serverMs = serverSec > 0
    ? serverSec * 1000
    : Date.now();

  // UTC+8 timezone offset: 8 hours in milliseconds
  const UTC_PLUS_8_OFFSET_MS = 8 * 3600 * 1000;
  const chinaDate = new Date(serverMs + UTC_PLUS_8_OFFSET_MS);
  const year = chinaDate.getUTCFullYear();
  const month = String(chinaDate.getUTCMonth() + 1).padStart(2, '0');
  const day = String(chinaDate.getUTCDate()).padStart(2, '0');
  const today = `${year}-${month}-${day}`;

  if (lastResetDate !== today) {
    if (lastResetDate !== '') {
      log('系统', '跨日重置，清空操作限制缓存');
    }
    operationLimits.clear();
    localBadOperationCount = 0;
    canGetHelpExp = true;

    if (helpAutoDisabledByLimit) {
      helpAutoDisabledByLimit = false;
      log('好友', '新的一天已开始，自动恢复帮忙操作功能', {
        module: 'friend',
        event: '好友巡查循环',
        result: 'ok',
      });
    }

    lastResetDate = today;
  }
}

/**
 * Disable help when daily experience limit is reached.
 * After this, no help visits are made at all (guard dogs included) to reduce request frequency;
 * the friend-list refresh for steal scheduling keeps running.
 */
function autoDisableHelpByExpLimit() {
  if (!canGetHelpExp) return;
  canGetHelpExp = false;
  helpAutoDisabledByLimit = true;
  log('好友', '今日帮助经验已达上限，自动停止全部帮忙进门（含护主犬），仅保留好友列表刷新', {
    module: 'friend',
    event: '好友巡查循环',
    result: 'ok',
  });
}

// ===== Operation limits =====

/**
 * Update operation limits from server response (after each RPC call).
 */
function updateOperationLimits(limits) {
  if (!limits || limits.length === 0) return;
  checkDailyReset();
  for (const limit of limits) {
    const id = toNum(limit.id);
    if (id > 0) {
      operationLimits.set(id, {
        dayTimes: toNum(limit.day_times),
        dayTimesLimit: toNum(limit.day_times_lt),
        dayExpTimes: toNum(limit.day_exp_times),
        dayExpTimesLimit: toNum(limit.day_ex_times_lt),
      });
    }
  }
}

/**
 * Check if we can still gain experience from a specific operation.
 */
function canGetExp(operationId) {
  const limit = operationLimits.get(operationId);
  if (!limit) return true;
  // No experience limit set -> can get exp
  if (limit.dayExpTimesLimit <= 0) return true;
  return limit.dayExpTimes < limit.dayExpTimesLimit;
}

/**
 * Check if we can gain experience from any of the given operation candidates.
 */
function canGetExpByCandidates(expIds = []) {
  const ids = Array.isArray(expIds) ? expIds : [expIds];
  for (const id of ids) {
    if (canGetExp(toNum(id))) return true;
  }
  return false;
}

/**
 * Check if an operation can still be performed (by operation count limit).
 */
function canOperate(operationId, fallbackLimit = 0) {
  const limit = operationLimits.get(operationId);
  const fallback = Math.max(0, Number(fallbackLimit) || 0);
  if (!limit) return true; // No limit known -> assume allowed
  const dayTimesLimit = limit.dayTimesLimit > 0 ? limit.dayTimesLimit : fallback;
  if (dayTimesLimit <= 0) return true; // No limit set
  return limit.dayTimes < dayTimesLimit;
}

/**
 * Get remaining times for an operation. Returns 999 if unlimited.
 */
function getRemainingTimes(operationId, fallbackLimit = 0) {
  const limit = operationLimits.get(operationId);
  const fallback = Math.max(0, Number(fallbackLimit) || 0);
  if (!limit) return fallback > 0 ? fallback : 999;
  const dayTimesLimit = limit.dayTimesLimit > 0 ? limit.dayTimesLimit : fallback;
  if (dayTimesLimit <= 0) return 999;
  return Math.max(0, dayTimesLimit - limit.dayTimes);
}

function getOperationDayTimes(operationId) {
  const limit = operationLimits.get(operationId);
  return limit ? Math.max(0, toNum(limit.dayTimes)) : 0;
}

function getBadOperationUsedCount() {
  // 10003 是放草/放虫共用 shared 额度，服务器 day_times 已含两类捣乱总数；
  // 10004 只是虫子单项计数，SUM 会双算放虫。本机计数只在服务器数据缺失/
  // 滞后时兜底，取 max 而非相加。
  const sharedUsed = getOperationDayTimes(BAD_SHARED_OPERATION_ID);
  return Math.min(BAD_DAILY_LIMIT, Math.max(sharedUsed, localBadOperationCount));
}

function getBadRemainingTimes() {
  // 服务端 shared(10003) 可能设比 bot cap 更小的 day_times_limit：
  // 取 bot 总剩余与 shared 剩余的较小值，避免分项仍有余额时误判可继续。
  const botRemaining = BAD_DAILY_LIMIT - getBadOperationUsedCount();
  const sharedRemaining = getRemainingTimes(BAD_SHARED_OPERATION_ID, BAD_DAILY_LIMIT);
  return Math.max(0, Math.min(botRemaining, sharedRemaining));
}

function canOperateBad() {
  return getBadRemainingTimes() > 0;
}

function recordBadOperationSuccess(count) {
  localBadOperationCount += Math.max(0, Number(count) || 0);
}

/**
 * Get all operation limits as a key-value map with names.
 */
function getOperationLimits() {
  const result = {};
  const allIds = [10001, 10002, 10003, 10004, 10005, 10006, 10007, 10008, 10015];
  for (const id of allIds) {
    const limit = operationLimits.get(id);
    if (limit) {
      result[id] = {
        name: OP_NAMES[id] || `#${id}`,
        ...limit,
        remaining: getRemainingTimes(id),
      };
    }
  }
  return result;
}

// ===== Help exp limit state =====

function getCanGetHelpExp() {
  return canGetHelpExp;
}

function setCanGetHelpExp(value) {
  canGetHelpExp = !!value;
}

function getHelpAutoDisabledByLimit() {
  return helpAutoDisabledByLimit;
}

// ===== Friend operation RPC calls =====

/**
 * 自回声 ticket 包裹（2026-09-26）：写请求发出前登记 pending，成功回包用
 * 逐地块返回状态确认，失败/超时立即撤销。不改 RPC 次序/参数；空回包
 * land 在 confirmWrite 内部视为无证据撤销，不会抑制任何后续推送。
 */
async function withSelfEchoTicket(op, gid, landIds, rpc) {
  const selfEcho = require('./friend-self-echo');
  const ticket = selfEcho.registerPendingWrite(op, gid, landIds);
  try {
    const reply = await rpc();
    selfEcho.confirmWrite(ticket, reply && reply.land);
    return reply;
  } catch (err) {
    selfEcho.revokeWrite(ticket);
    throw err;
  }
}

/**
 * Help water a friend's lands.
 * If `checkExpLimit` is true, sleeps 200ms after the call and checks if exp increased
 * to determine if the help exp limit is reached.
 */
async function helpWater(gid, landIds, checkExpLimit = false) {
  const expBefore = toNum((getUserState() || {}).exp);
  const payload = types.WaterLandRequest.encode(
    types.WaterLandRequest.create({
      land_ids: landIds,
      host_gid: toLong(gid),
    })
  ).finish();
  const reply = await withSelfEchoTicket('WaterLand', gid, landIds, async () => {
    const { body } = await sendMsgAsync(
      'gamepb.plantpb.PlantService',
      'WaterLand',
      payload
    );
    return types.WaterLandReply.decode(body);
  });
  updateOperationLimits(reply.operation_limits);

  if (checkExpLimit) {
    await sleep(200);
    const expAfter = toNum((getUserState() || {}).exp);
    if (expAfter <= expBefore) autoDisableHelpByExpLimit();
  }

  return reply;
}

/**
 * Help weed a friend's lands.
 */
async function helpWeed(gid, landIds, checkExpLimit = false) {
  const expBefore = toNum((getUserState() || {}).exp);
  const payload = types.WeedOutRequest.encode(
    types.WeedOutRequest.create({
      land_ids: landIds,
      host_gid: toLong(gid),
    })
  ).finish();
  const reply = await withSelfEchoTicket('WeedOut', gid, landIds, async () => {
    const { body } = await sendMsgAsync(
      'gamepb.plantpb.PlantService',
      'WeedOut',
      payload
    );
    return types.WeedOutReply.decode(body);
  });
  updateOperationLimits(reply.operation_limits);

  if (checkExpLimit) {
    await sleep(200);
    const expAfter = toNum((getUserState() || {}).exp);
    if (expAfter <= expBefore) autoDisableHelpByExpLimit();
  }

  return reply;
}

/**
 * Help insecticide a friend's lands.
 */
async function helpInsecticide(gid, landIds, checkExpLimit = false) {
  const expBefore = toNum((getUserState() || {}).exp);
  const payload = types.InsecticideRequest.encode(
    types.InsecticideRequest.create({
      land_ids: landIds,
      host_gid: toLong(gid),
    })
  ).finish();
  const reply = await withSelfEchoTicket('Insecticide', gid, landIds, async () => {
    const { body } = await sendMsgAsync(
      'gamepb.plantpb.PlantService',
      'Insecticide',
      payload
    );
    return types.InsecticideReply.decode(body);
  });
  updateOperationLimits(reply.operation_limits);

  if (checkExpLimit) {
    await sleep(200);
    const expAfter = toNum((getUserState() || {}).exp);
    if (expAfter <= expBefore) autoDisableHelpByExpLimit();
  }

  return reply;
}

/**
 * Steal harvest from a friend's lands (bulk or single).
 */
async function stealHarvest(gid, landIds) {
  // 好友 Harvest 的批量失败→逐地回退是成熟竞速常态。所有入口（定时偷菜、
  // 重点盯梢、帮助/捣乱顺带偷、手动偷）都在唯一 API 层续上短竞速窗口，
  // 避免上层遗漏导致成熟竞争的预期业务失败累计进异常降速阈值。
  require('./request-governor').setContentionMode(true, Date.now() + 60_000);
  const payload = types.HarvestRequest.encode(
    types.HarvestRequest.create({
      land_ids: landIds,
      host_gid: toLong(gid),
      is_all: true,
    })
  ).finish();
  const reply = await withSelfEchoTicket('Harvest', gid, landIds, async () => {
    const { body } = await sendMsgAsync(
      'gamepb.plantpb.PlantService',
      'Harvest',
      payload
    );
    return types.HarvestReply.decode(body);
  });
  updateOperationLimits(reply.operation_limits);
  return reply;
}

/**
 * Generic helper to put items (weeds/insects) on friend's lands one by one.
 * Returns the number of successful operations.
 */
async function putPlantItems(gid, landIds, RequestType, ReplyType, rpcMethod) {
  let ok = 0;
  const ids = Array.isArray(landIds) ? landIds : [];

  for (const landId of ids) {
    try {
      const payload = RequestType.encode(
        RequestType.create({
          land_ids: [toLong(landId)],
          host_gid: toLong(gid),
        })
      ).finish();
      const reply = await withSelfEchoTicket(rpcMethod, gid, [landId], async () => {
        const { body } = await sendMsgAsync(
          'gamepb.plantpb.PlantService',
          rpcMethod,
          payload
        );
        return ReplyType.decode(body);
      });
      updateOperationLimits(reply.operation_limits);
      ok++;
    } catch (err) {
      const msg = (err && err.message) ? err.message : '未知错误';
      if (msg.includes('1001046')) {
        // Already done - silently skip
      } else {
        log('好友', `放虫/放草失败: landId=${landId}, 错误: ${msg}`, {
          module: 'friend',
          event: '放虫放草失败',
          landId,
          error: msg,
        });
      }
      await require('../utils/utils').randomDelay(500, 1500);
    }

    if (ok > 0) {
      await require('../utils/utils').randomDelay(500, 1000);
    }
  }

  return ok;
}

/**
 * Detailed version of putPlantItems that returns failure details.
 * Returns: { ok: number, failed: [{landId, reason}] }
 */
async function putPlantItemsDetailed(gid, landIds, RequestType, ReplyType, rpcMethod) {
  let ok = 0;
  const failed = [];
  const ids = Array.isArray(landIds) ? landIds : [];

  for (const landId of ids) {
    try {
      const payload = RequestType.encode(
        RequestType.create({
          land_ids: [toLong(landId)],
          host_gid: toLong(gid),
        })
      ).finish();
      const reply = await withSelfEchoTicket(rpcMethod, gid, [landId], async () => {
        const { body } = await sendMsgAsync(
          'gamepb.plantpb.PlantService',
          rpcMethod,
          payload
        );
        return ReplyType.decode(body);
      });
      updateOperationLimits(reply.operation_limits);
      ok++;
    } catch (err) {
      const msg = (err && err.message) ? err.message : '未知错误';
      failed.push({
        landId,
        reason: msg,
      });
      if (!msg.includes('1001046')) {
        log('好友', `放虫/放草失败: landId=${landId}, 错误: ${msg}`, {
          module: 'friend',
          event: '放虫放草失败',
          landId,
          error: msg,
          detailed: true,
        });
      }
    }
    if (ok > 0) {
      await require('../utils/utils').randomDelay(500, 1000);
    }
  }

  return { ok, failed };
}

// ===== Specific put operations =====

async function putInsects(gid, landIds) {
  const ok = await putPlantItems(gid, landIds, types.PutInsectsRequest, types.PutInsectsReply, 'PutInsects');
  recordBadOperationSuccess(ok);
  return ok;
}

async function putWeeds(gid, landIds) {
  const ok = await putPlantItems(gid, landIds, types.PutWeedsRequest, types.PutWeedsReply, 'PutWeeds');
  recordBadOperationSuccess(ok);
  return ok;
}

async function putInsectsDetailed(gid, landIds) {
  const result = await putPlantItemsDetailed(gid, landIds, types.PutInsectsRequest, types.PutInsectsReply, 'PutInsects');
  recordBadOperationSuccess(result.ok);
  return result;
}

async function putWeedsDetailed(gid, landIds) {
  const result = await putPlantItemsDetailed(gid, landIds, types.PutWeedsRequest, types.PutWeedsReply, 'PutWeeds');
  recordBadOperationSuccess(result.ok);
  return result;
}

// ===== Exports =====
module.exports = {
  OP_NAMES,
  BAD_SHARED_OPERATION_ID,
  PUT_BUG_OPERATION_ID,
  PUT_WEED_OPERATION_ID,
  GOLDEN_BUG_OPERATION_ID,
  BAD_DAILY_LIMIT,
  checkDailyReset,
  autoDisableHelpByExpLimit,
  updateOperationLimits,
  canGetExp,
  canGetExpByCandidates,
  canOperate,
  canOperateBad,
  getRemainingTimes,
  getBadRemainingTimes,
  getBadOperationUsedCount,
  getOperationLimits,
  getCanGetHelpExp,
  setCanGetHelpExp,
  getHelpAutoDisabledByLimit,
  helpWater,
  helpWeed,
  helpInsecticide,
  stealHarvest,
  putPlantItems,
  putPlantItemsDetailed,
  putInsects,
  putWeeds,
  putInsectsDetailed,
  putWeedsDetailed,
};
