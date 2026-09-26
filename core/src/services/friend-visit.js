const { PlantPhase } = require('../config/config');
const { getPlantBlacklist, isAutomationOn } = require('../models/store');
const { getUserState } = require('../utils/network');
const { toNum, log, logWarn, randomDelay, sleep } = require('../utils/utils');
const { stealIsDue } = require('../utils/behavior');
const { recordOperation } = require('./stats');
const { recordEvent } = require('./daily-events');
const { sellAllFruits } = require('./warehouse');
const {
  enterFriendFarm,
  leaveFriendFarm,
  checkCanOperateRemote,
  handleFriendEnterError,
} = require('./friend-api');
const { inspectFriendLands, unwatchFriend, isPriorityGid } = require('./fertilizer-watch');
const friendActivity = require('./friend-activity');
const { getCurrentPhase } = require('./farm-land-analyzer');
const { analyzeFriendLands } = require('./friend-land-analyzer');
const {
  getRemainingTimes,
  getBadRemainingTimes,
  PUT_BUG_OPERATION_ID,
  PUT_WEED_OPERATION_ID,
  BAD_DAILY_LIMIT,
  canGetExpByCandidates,
  getCanGetHelpExp,
  setCanGetHelpExp,
  helpWater,
  helpWeed,
  helpInsecticide,
  stealHarvest,
  putInsectsDetailed,
  putWeedsDetailed,
} = require('./friend-operation-limits');

// ===== Batch helper =====

/**
 * Run an operation on multiple land IDs. Falls back to single-ID calls if batch fails.
 * Returns the number of successful operations.
 */
async function runBatchWithFallback(landIds, batchFn, singleFn) {
  const ids = Array.isArray(landIds) ? landIds.filter(Boolean) : [];
  if (ids.length === 0) return 0;

  try {
    await batchFn(ids);
    return ids.length;
  } catch {
    // Fallback: one by one
    let ok = 0;
    for (const id of ids) {
      try {
        await singleFn([id]);
        ok++;
      } catch {
        // Skip individual failures
      }
      await sleep(100);
    }
    return ok;
  }
}

// ===== Single friend operation =====

/**
 * Perform a single operation on a friend's farm (steal/water/weed/bug/bad).
 * Handles entering/leaving the farm and error classification.
 */
async function doFriendOperation(gid, opType) {
  const numericGid = toNum(gid);
  if (!numericGid) {
    return { ok: false, message: '无效好友ID', opType };
  }

  // Enter friend's farm
  let enterReply;
  try {
    enterReply = await enterFriendFarm(numericGid);
  } catch (err) {
    const handled = handleFriendEnterError(numericGid, `GID:${numericGid}`, err);
    if (handled.handled && handled.kind === 'blacklist') {
      return { ok: true, opType, count: 0, message: '好友已自动加入黑名单' };
    }
    if (handled.handled && handled.kind === 'invalid_removed') {
      return { ok: true, opType, count: 0, message: '好友 GID 已失效，已自动移出已知列表' };
    }
    return { ok: false, message: `进入好友农场失败: ${err.message}`, opType };
  }

  try {
    const lands = enterReply.lands || [];
    const userState = getUserState();
    const plantBlacklist = getPlantBlacklist(userState.accountId);
    inspectFriendLands(numericGid, '', lands);
    const analysis = analyzeFriendLands(lands, userState.gid, '', { plantBlacklist });

    let okCount = 0;

    // ---- Steal ----
    if (opType === 'steal') {
      if (!analysis.stealable.length) {
        return { ok: true, opType, count: 0, message: '没有可偷取土地' };
      }

      const canOp = await checkCanOperateRemote(numericGid, 0x2714); // 10004
      if (!canOp.canOperate) {
        return { ok: true, opType, count: 0, message: 'Ta已经被偷的精光了QAQ' };
      }

      const stealCount = canOp.canStealNum > 0
        ? canOp.canStealNum
        : analysis.stealable.length;
      const targetLands = analysis.stealable.slice(0, stealCount);

      okCount = await runBatchWithFallback(
        targetLands,
        ids => stealHarvest(numericGid, ids),
        id => stealHarvest(numericGid, id)
      );

      if (okCount > 0) {
        recordOperation('steal', okCount);
        try {
          await sellAllFruits();
        } catch (sellErr) {
          logWarn('仓库', `手动偷取后自动出售失败: ${sellErr.message}`, {
            module: 'warehouse',
            event: '偷菜后出售',
            result: 'error',
            mode: 'manual',
          });
        }
      }

      return { ok: true, opType, count: okCount, message: `偷取完成 ${okCount} 块` };
    }

    // ---- Water ----
    if (opType === 'water') {
      if (!analysis.needWater.length) {
        return { ok: true, opType, count: 0, message: '没有可浇水土地' };
      }

      const canOp = await checkCanOperateRemote(numericGid, 0x2717); // 10007
      if (!canOp.canOperate) {
        return { ok: true, opType, count: 0, message: '浇水失败，来晚一步，可惜' };
      }

      okCount = await runBatchWithFallback(
        analysis.needWater,
        ids => helpWater(numericGid, ids),
        id => helpWater(numericGid, id)
      );

      if (okCount > 0) recordOperation('helpWater', okCount);
      return { ok: true, opType, count: okCount, message: `浇水完成 ${okCount} 块` };
    }

    // ---- Weed ----
    if (opType === 'weed') {
      if (!analysis.needWeed.length) {
        return { ok: true, opType, count: 0, message: '没有可除草土地' };
      }

      const canOp = await checkCanOperateRemote(numericGid, 0x2715); // 10005
      if (!canOp.canOperate) {
        return { ok: true, opType, count: 0, message: '除草失败，来晚一步，可惜' };
      }

      okCount = await runBatchWithFallback(
        analysis.needWeed,
        ids => helpWeed(numericGid, ids),
        id => helpWeed(numericGid, id)
      );

      if (okCount > 0) recordOperation('helpWeed', okCount);
      return { ok: true, opType, count: okCount, message: `除草完成 ${okCount} 块` };
    }

    // ---- Bug ----
    if (opType === 'bug') {
      if (!analysis.needBug.length) {
        return { ok: true, opType, count: 0, message: '没有可除虫土地' };
      }

      const canOp = await checkCanOperateRemote(numericGid, 0x2716); // 10006
      if (!canOp.canOperate) {
        return { ok: true, opType, count: 0, message: '除虫失败，来晚一步，可惜' };
      }

      okCount = await runBatchWithFallback(
        analysis.needBug,
        ids => helpInsecticide(numericGid, ids),
        id => helpInsecticide(numericGid, id)
      );

      if (okCount > 0) recordOperation('helpBug', okCount);
      return { ok: true, opType, count: okCount, message: `除虫完成 ${okCount} 块` };
    }

    // ---- Bad (put weeds & insects) ----
    if (opType === 'bad') {
      let bugCount = 0;
      let weedCount = 0;

      if (!analysis.canPutBug.length && !analysis.canPutWeed.length) {
        return {
          ok: true,
          opType,
          count: 0,
          bugCount: 0,
          weedCount: 0,
          message: '没有可捣乱土地',
        };
      }

      let failedMsgs = [];

      // Put insects
      if (analysis.canPutBug.length && getBadRemainingTimes() > 0) {
        const canPutBug = await checkCanOperateRemote(numericGid, PUT_BUG_OPERATION_ID);
        const remainingBug = Math.min(
          getRemainingTimes(PUT_BUG_OPERATION_ID, BAD_DAILY_LIMIT),
          getBadRemainingTimes()
        );
        const targets = canPutBug.canOperate ? analysis.canPutBug.slice(0, remainingBug) : [];
        const result = targets.length > 0
          ? await putInsectsDetailed(numericGid, targets)
          : { ok: 0, failed: [] };
        bugCount = result.ok;
        failedMsgs = failedMsgs.concat(
          (result.failed || []).map(f => `放虫#${f.landId}:${f.reason}`)
        );
        if (bugCount > 0) recordOperation('bug', bugCount);
      }

      // Put weeds
      if (analysis.canPutWeed.length && getBadRemainingTimes() > 0) {
        const canPutWeed = await checkCanOperateRemote(numericGid, PUT_WEED_OPERATION_ID);
        const remainingWeed = Math.min(
          getRemainingTimes(PUT_WEED_OPERATION_ID, BAD_DAILY_LIMIT),
          getBadRemainingTimes()
        );
        const targets = canPutWeed.canOperate ? analysis.canPutWeed.slice(0, remainingWeed) : [];
        const result = targets.length > 0
          ? await putWeedsDetailed(numericGid, targets)
          : { ok: 0, failed: [] };
        weedCount = result.ok;
        failedMsgs = failedMsgs.concat(
          (result.failed || []).map(f => `放草#${f.landId}:${f.reason}`)
        );
        if (weedCount > 0) recordOperation('weed', weedCount);
      }

      okCount = bugCount + weedCount;

      if (okCount <= 0) {
        const errSummary = failedMsgs.slice(-3).join(' | ');
        return {
          ok: true,
          opType,
          count: 0,
          bugCount,
          weedCount,
          message: errSummary ? `捣乱失败: ${errSummary}` : '捣乱失败或今日次数已用完',
        };
      }

      return {
        ok: true,
        opType,
        count: okCount,
        bugCount,
        weedCount,
        message: `捣乱完成 虫${bugCount}/草${weedCount}`,
      };
    }

    return { ok: false, opType, count: 0, message: '未知操作类型' };
  } catch (err) {
    return { ok: false, opType, count: 0, message: err.message || '操作失败' };
  } finally {
    try {
      await leaveFriendFarm(numericGid);
    } catch {
      // Ignore leave errors
    }
  }
}

// ===== Full friend visit =====

/**
 * Visit a friend and perform all enabled operations (help + steal + bad).
 * Tracks per-operation counts in the `tally` object.
 * Returns: { acted, entered }
 */
async function visitFriend(friend, tally, myGid, accountId) {
  const { gid, name } = friend;
  let enterReply;

  // Enter friend's farm
  try {
    enterReply = await enterFriendFarm(gid);
  } catch (err) {
    const handled = handleFriendEnterError(gid, name, err);
    if (handled.handled) {
      if (handled.kind === 'blacklist') unwatchFriend(gid);
      return { acted: false, entered: false };
    }
    logWarn('好友', `进入 ${name} 农场失败: ${err.message}`, {
      module: 'friend',
      event: '进入农场',
      result: 'error',
      friendName: name,
      friendGid: gid,
    });
    return { acted: false, entered: false };
  }

  // 好友实时在场信号（2026-09-22 调研，外部参考仓库逆向 field 6/17）：进门
  // 回包自带"好友此刻在不在农场"与最后上线时刻，统一走 friend-activity
  // 的 noteEnterPresence（at_home / last_online 进活跃表）。
  // 2026-09-26 验收修复：必须在空地块早退之前——所有进门路径（含空土地）
  // 都先记录 presence 再返回。
  try {
    const presence = friendActivity.noteEnterPresence(gid, enterReply);
    if (presence.onlineEdge) {
      recordEvent(process.env.FARM_ACCOUNT_ID || '', 'info', 'friend_online',
        `好友上线：${name || `GID:${gid}`}`);
    }
  } catch { /* 证据记录失败不影响进门主流程 */ }

  const lands = enterReply.lands || [];
  if (lands.length === 0) {
    inspectFriendLands(gid, name, []);
    unwatchFriend(gid);
    await leaveFriendFarm(gid);
    return { acted: false, entered: true, ripeAtMs: 0 };
  }

  const inspectResult = inspectFriendLands(gid, name, lands) || {};
  const ripeAtMs = Number(inspectResult.ripeAt) || 0;

  const plantBlacklist = getPlantBlacklist(accountId);
  const analysis = analyzeFriendLands(lands, myGid, name, { plantBlacklist });
  const actionLogs = [];

  // ---- Steal first (highest priority vs water/weed/bug) ----
  if (isAutomationOn('friend_steal') && analysis.stealable.length > 0) {
    const canOp = await checkCanOperateRemote(gid, 0x2714); // 10004
    if (canOp.canOperate) {
      const stealCount = canOp.canStealNum > 0
        ? canOp.canStealNum
        : analysis.stealable.length;
      const targetLands = analysis.stealable.slice(0, stealCount);
      let stolen = 0;
      const stolenNames = [];

      try {
        await stealHarvest(gid, targetLands);
        stolen = targetLands.length;
        targetLands.forEach(landId => {
          const info = analysis.stealableInfo.find(s => s.landId === landId);
          if (info) stolenNames.push(info.name);
        });
      } catch {
        for (const landId of targetLands) {
          try {
            await stealHarvest(gid, [landId]);
            stolen++;
            const info = analysis.stealableInfo.find(s => s.landId === landId);
            if (info) stolenNames.push(info.name);
          } catch {
            // Skip individual failures
          }
        }
      }

      if (stolen > 0) {
        const namesStr = [...new Set(stolenNames)].join('/');
        actionLogs.push(`偷${stolen}${namesStr ? `(${namesStr})` : ''}`);
        tally.steal += stolen;
        recordOperation('steal', stolen);
        recordEvent(process.env.FARM_ACCOUNT_ID || '', 'info', 'steal',
          `偷取 ${name} ${stolen} 个${namesStr ? `（${namesStr}）` : ''}`);
      }
    }
  }

  // ---- Help (weed / bug / water) ----
  const helpEnabled = !!isAutomationOn('friend_help');
  const expLimitEnabled = !!isAutomationOn('friend_help_exp_limit');

  if (!expLimitEnabled) setCanGetHelpExp(true);

  if (helpEnabled) {
    // Skip help if exp limit is reached and we haven't been overridden
    if (!expLimitEnabled || getCanGetHelpExp()) {
      const helpOptions = [
        {
          id: 0x2715,             // 10005 = weed
          expIds: [0x2715, 0x2713], // [10005, 10003]
          list: analysis.needWeed,
          fn: helpWeed,
          key: 'weed',
          name: '草',
          record: 'helpWeed',
        },
        {
          id: 0x2716,             // 10006 = bug
          expIds: [0x2716, 0x2712], // [10006, 10002]
          list: analysis.needBug,
          fn: helpInsecticide,
          key: 'bug',
          name: '虫',
          record: 'helpBug',
        },
        {
          id: 0x2717,             // 10007 = water
          expIds: [0x2717, 0x2711], // [10007, 10001]
          list: analysis.needWater,
          fn: helpWater,
          key: 'water',
          name: '水',
          record: 'helpWater',
        },
      ];

      for (const opt of helpOptions) {
        const canGetExp = !expLimitEnabled ||
          (canGetExpByCandidates(opt.expIds) && getCanGetHelpExp());

        if (opt.list.length > 0 && canGetExp) {
          const canOp = await checkCanOperateRemote(gid, opt.id);
          if (canOp.canOperate) {
            const okCount = await runBatchWithFallback(
              opt.list,
              ids => opt.fn(gid, ids, expLimitEnabled),
              id => opt.fn(gid, id, expLimitEnabled)
            );
            if (okCount > 0) {
              actionLogs.push(`${opt.name}${okCount}`);
              tally[opt.key] += okCount;
              recordOperation(opt.record, okCount);
              await randomDelay(500, 1000);
            }
          }
        }
      }
    }
  }

  // ---- Bad (put weeds & insects) ----
  const badEnabled = isAutomationOn('friend_bad');
  let badCount = 0;
  let putBugCount = 0;
  let putWeedCount = 0;
  const badFailedMsgs = [];

  if (badEnabled) {
    const canPutBug = await checkCanOperateRemote(gid, PUT_BUG_OPERATION_ID);
    const canPutWeed = await checkCanOperateRemote(gid, PUT_WEED_OPERATION_ID);

    // Put insects
    if (analysis.canPutBug.length > 0 && canPutBug.canOperate && getBadRemainingTimes() > 0) {
      const remainingBug = Math.min(
        getRemainingTimes(PUT_BUG_OPERATION_ID, BAD_DAILY_LIMIT),
        getBadRemainingTimes()
      );
      const targets = analysis.canPutBug.slice(0, remainingBug);
      const result = await putInsectsDetailed(gid, targets);
      const okCount = result.ok;
      badFailedMsgs.push(...(result.failed || []).map(f => `放虫#${f.landId}:${f.reason}`));
      if (okCount > 0) {
        actionLogs.push(`放虫${okCount}`);
        tally.putBug += okCount;
        putBugCount += okCount;
        badCount += okCount;
      }
      await randomDelay(500, 1500);
    }

    // Put weeds
    if (analysis.canPutWeed.length > 0 && canPutWeed.canOperate && getBadRemainingTimes() > 0) {
      const remainingWeed = Math.min(
        getRemainingTimes(PUT_WEED_OPERATION_ID, BAD_DAILY_LIMIT),
        getBadRemainingTimes()
      );
      const targets = analysis.canPutWeed.slice(0, remainingWeed);
      const result = await putWeedsDetailed(gid, targets);
      const okCount = result.ok;
      badFailedMsgs.push(...(result.failed || []).map(f => `放草#${f.landId}:${f.reason}`));
      if (okCount > 0) {
        actionLogs.push(`放草${okCount}`);
        tally.putWeed += okCount;
        putWeedCount += okCount;
        badCount += okCount;
      }
      await randomDelay(500, 1500);
    }
  }

  if (actionLogs.length > 0) {
    const priority = isPriorityGid(gid);
    log('好友', `${priority ? '[重点] ' : ''}${name}: ${actionLogs.join('/')}`, {
      module: 'friend',
      event: '照顾好友',
      result: 'ok',
      friendName: name,
      friendGid: gid,
      actions: actionLogs,
      ...(priority ? { priority: true } : {}),
    });
  }

  await leaveFriendFarm(gid);
  return {
    acted: actionLogs.length > 0,
    entered: true,
    ripeAtMs,
    count: badCount,
    bugCount: putBugCount,
    weedCount: putWeedCount,
    message: badCount > 0
      ? `捣乱完成 虫${putBugCount}/草${putWeedCount}`
      : badFailedMsgs.slice(-3).join(' | '),
  };
}

// ===== Visit friend for steal only =====

/**
 * Visit a friend specifically to steal crops.
 */
/**
 * 偷取好友成熟作物。options.preEnter = { gid, enterReply } 表示哨兵已提前
 * Enter 驻留（Worker armSentinelPreEnter）：复用其 Enter 回复省一次往返，
 * 不再重复发 Enter；Leave 仍走正常路径。
 */
// ===== 推送直达偷菜（fast-lane，2026-09-24 方案C）=====
// 只为对抗"好友在线施肥催熟秒收"的竞速：推送自带变化地块状态，成熟且还站着
// 的地块直接发 Harvest（协议自包含，无需 Enter/CheckCanOperate——qqfarm-sdk
// 与 既有公开参考证据 双实证）。仅重点好友 + 好友在线（10 秒内有动作/at_home）时
// 启用；失败忽略（多半已被主人收走）。自然成熟的常规偷收仍走 PREARM 布防。

const fastLaneInFlight = new Map(); // gid -> Promise
const fastLaneRecent = new Map(); // gid -> Map<landId, at>（防推送回声重复开火）

function fastLaneRipeLandIds(lands) {
  const serverSec = Math.floor(Date.now() / 1000);
  const ids = [];
  for (const land of Array.isArray(lands) ? lands : []) {
    const plant = land && land.plant;
    const phases = plant && plant.phases;
    const landId = toNum(land && land.id);
    if (!landId || !Array.isArray(phases) || phases.length === 0) continue;
    const last = phases[phases.length - 1];
    const begin = toNum(last && (last.begin_time != null ? last.begin_time : last.beginTime));
    // 已成熟（最后阶段开始时刻已过）且植株还在 = 可偷窗口
    if (begin > 0 && begin <= serverSec) ids.push(landId);
  }
  return ids;
}

async function fastLaneSteal(gid, lands) {
  const id = toNum(gid);
  if (!id || !isPriorityGid(id)) return;
  // 在线闸门（用户定标）：离线时失败率高、也无施肥竞速意义
  if (!friendActivity.isFriendOnlineRecently(id)) return;
  const ripeIds = fastLaneRipeLandIds(lands);
  if (ripeIds.length === 0) return;
  // 防重复：3 秒内已开火过的地块不再发（我们自己偷完的推送回声会被这里挡住）
  const recent = fastLaneRecent.get(id) || new Map();
  const now = Date.now();
  for (const [landId, at] of recent) if (now - at > 3_000) recent.delete(landId);
  const targets = ripeIds.filter(landId => !recent.has(landId));
  if (targets.length === 0) return;
  targets.forEach(landId => recent.set(landId, now));
  fastLaneRecent.set(id, recent);

  // 串行化：同好友同一时刻只 1 个在途 Harvest，后到的地块并进下一次
  const prev = fastLaneInFlight.get(id) || Promise.resolve();
  const run = prev.catch(() => undefined).then(async () => {
    try {
      await stealHarvest(id, targets);
      recordOperation('steal', targets.length);
      log('好友', `[重点] 快车道偷菜成功：${targets.length} 块（推送直达，未进门）`, {
        module: 'friend', event: '偷好友菜', friendGid: id, priority: true,
        actions: [`偷${targets.length}`], mode: 'fast_lane', result: 'ok',
      });
      recordEvent(process.env.FARM_ACCOUNT_ID || '', 'info', 'steal',
        `快车道偷取 ${targets.length} 块（推送直达）`);
      void sellAllFruits().catch(() => {});
    } catch { /* 已被主人收走等预期失败，静默 */ }
  });
  fastLaneInFlight.set(id, run);
  void run.catch(() => {}).then(() => { if (fastLaneInFlight.get(id) === run) fastLaneInFlight.delete(id); });
}

// 驻留实验（2026-09-22）：重点好友进门后不 Leave——验证服务器是否向"驻留在
// 农场里的访客"推送该农场的变化（催熟/收菜的毫秒级真·trigger 通道）。
// 实验结论出来前只对重点好友生效；非重点好友行为不变。
async function maybeLurkLeave(gid) {
  if (isPriorityGid(gid)) return;
  await leaveFriendFarm(gid);
}

async function visitFriendForSteal(friend, tally, myGid, accountId, options = {}) {
  const { gid, name } = friend;
  const preEnter = options && options.preEnter && Number(options.preEnter.gid) === Number(gid)
    ? options.preEnter
    : null;
  let enterReply;

  if (preEnter && preEnter.enterReply) {
    // 哨兵预进门驻留：直接复用 Enter 回复。地块状态到点可能变化，成熟判定
    // 由后续 CheckCanOperate/Harvest 的服务端应答兜底，本地分析仅做选择。
    enterReply = preEnter.enterReply;
  } else {
    try {
      enterReply = await enterFriendFarm(gid);
    } catch (err) {
      const handled = handleFriendEnterError(gid, name, err);
      if (handled.handled) {
        if (handled.kind === 'blacklist') unwatchFriend(gid);
        return { acted: false, entered: false };
      }
      logWarn('好友', `进入 ${name} 农场失败: ${err.message}`, {
        module: 'friend',
        event: '进入农场',
        result: 'error',
        friendName: name,
        friendGid: gid,
      });
      return { acted: false, entered: false };
    }
  }

  // 好友实时在场信号（同 visitFriend）：统一走 noteEnterPresence。
  // 2026-09-26 验收修复：空地块早退之前记录，所有进门路径不漏。
  try {
    const presence = friendActivity.noteEnterPresence(gid, enterReply);
    if (presence.onlineEdge) {
      recordEvent(process.env.FARM_ACCOUNT_ID || '', 'info', 'friend_online',
        `好友上线：${name || `GID:${gid}`}`);
    }
  } catch { /* 证据记录失败不影响进门主流程 */ }

  const lands = enterReply.lands || [];
  if (lands.length === 0) {
    inspectFriendLands(gid, name, []);
    unwatchFriend(gid);
    await maybeLurkLeave(gid);
    return { acted: false, entered: true, ripeAtMs: 0 };
  }

  const inspectResult = inspectFriendLands(gid, name, lands) || {};
  const ripeAtMs = Number(inspectResult.ripeAt) || 0;

  const plantBlacklist = getPlantBlacklist(accountId);
  const analysis = analyzeFriendLands(lands, myGid, name, { plantBlacklist });
  const actionLogs = [];
  let stealAttemptFailed = false;

  // Check if any stealable land still has remaining steal slots for us
  const hasStealSlot = lands.some(land => {
    const plant = land.plant;
    if (!plant || !plant.phases || plant.phases.length === 0) return false;
    const phase = getCurrentPhase(plant.phases, false, '', plant.id);
    if (!phase || phase.phase !== PlantPhase.MATURE) return false;
    if (!plant.stealable) return false;

    const stealPlayers = plant.steal_player;
    if (!stealPlayers || stealPlayers.length === 0) return true;

    const mySteal = stealPlayers.find(s => toNum(s.gid) === myGid);
    const myStealCount = mySteal ? toNum(mySteal.num) : 0;
    const maxSteal = toNum(plant.steal_num, 0);
    return myStealCount < maxSteal;
  });

  if (!hasStealSlot && analysis.stealable.length === 0) {
    await maybeLurkLeave(gid);
    return { acted: false, entered: true, ripeAtMs };
  }

  // Steal
  if (analysis.stealable.length > 0) {
    const canOp = await checkCanOperateRemote(gid, 0x2714); // 10004
    if (canOp.canOperate) {
      const stealCount = canOp.canStealNum > 0
        ? canOp.canStealNum
        : analysis.stealable.length;
      const targetLands = analysis.stealable.slice(0, stealCount);
      let stolen = 0;
      const stolenNames = [];

      try {
        await stealHarvest(gid, targetLands);
        stolen = targetLands.length;
        targetLands.forEach(landId => {
          const info = analysis.stealableInfo.find(s => s.landId === landId);
          if (info) stolenNames.push(info.name);
        });
      } catch {
        for (const landId of targetLands) {
          try {
            await stealHarvest(gid, [landId]);
            stolen++;
            const info = analysis.stealableInfo.find(s => s.landId === landId);
            if (info) stolenNames.push(info.name);
          } catch {
            // Skip individual failures
          }
        }
      }

      if (stolen > 0) {
        const namesStr = [...new Set(stolenNames)].join('/');
        actionLogs.push(`偷${stolen}${namesStr ? `(${namesStr})` : ''}`);
        tally.steal += stolen;
        recordOperation('steal', stolen);
        recordEvent(process.env.FARM_ACCOUNT_ID || '', 'info', 'steal',
          `偷取 ${name} ${stolen} 个${namesStr ? `（${namesStr}）` : ''}`);
      } else if (targetLands.length > 0) {
        // 已确认有可偷地块且服务端允许操作，但批量与逐地 Harvest 都失败。
        // 告诉调度器保留短时成熟重试，不能误当成“已被偷光”清掉 due。
        stealAttemptFailed = true;
      }
    }
  }

  if (actionLogs.length > 0) {
    const priority = isPriorityGid(gid);
    log('好友', `${priority ? '[重点] ' : ''}${name}: ${actionLogs.join('/')}`, {
      module: 'friend',
      event: '偷好友菜',
      result: 'ok',
      friendName: name,
      friendGid: gid,
      actions: actionLogs,
      ...(priority ? { priority: true } : {}),
    });
  }

  await maybeLurkLeave(gid);
  return {
    acted: actionLogs.length > 0,
    entered: true,
    ripeAtMs,
    retryNeeded: stealAttemptFailed,
  };
}

// ===== Visit friend for help only =====

/**
 * Visit a friend specifically to help (water/weed/bug).
 * Honors experience limit. Guard dog friends bypass the limit.
 */
async function visitFriendForHelp(friend, tally, myGid, accountId, ignoreExpLimit = false, expLimitMode = false) {
  if (stealIsDue()) return { acted: false, entered: false };
  const { gid, name } = friend;
  const expLimitEnabled = !!isAutomationOn('friend_help_exp_limit');
  const checkExpLimit = expLimitEnabled && !ignoreExpLimit;
  const hasGuardDog = !!friend.hasGuardDog;

  if (!checkExpLimit) setCanGetHelpExp(true);

  // Skip if exp limit reached and no guard dog
  if (checkExpLimit && !getCanGetHelpExp() && !hasGuardDog) {
    return { acted: false, entered: false };
  }

  let enterReply;
  try {
    enterReply = await enterFriendFarm(gid);
  } catch (err) {
    const handled = handleFriendEnterError(gid, name, err);
    if (handled.handled) {
      if (handled.kind === 'blacklist') unwatchFriend(gid);
      return { acted: false, entered: false };
    }
    logWarn('好友', `进入 ${name} 农场失败: ${err.message}`, {
      module: 'friend',
      event: '进入农场',
      result: 'error',
      friendName: name,
      friendGid: gid,
    });
    return { acted: false, entered: false };
  }

  // 帮助进门也产出在场证据（与其他进门路径共用 noteEnterPresence，
  // 在线证据生产/消费口径与面板 online 定义一致）
  try {
    const presence = friendActivity.noteEnterPresence(gid, enterReply);
    if (presence.onlineEdge) {
      recordEvent(process.env.FARM_ACCOUNT_ID || '', 'info', 'friend_online',
        `好友上线：${name || `GID:${gid}`}`);
    }
  } catch { /* 证据记录失败不影响进门主流程 */ }

  const lands = enterReply.lands || [];
  if (lands.length === 0) {
    inspectFriendLands(gid, name, []);
    unwatchFriend(gid);
    await leaveFriendFarm(gid);
    return { acted: false, entered: true, ripeAtMs: 0 };
  }

  const inspectResult = inspectFriendLands(gid, name, lands) || {};
  const ripeAtMs = Number(inspectResult.ripeAt) || 0;

  const analysis = analyzeFriendLands(lands, myGid, name, {});
  const actionLogs = [];

  const helpOptions = [
    {
      id: 0x2715,             // 10005 = weed
      expIds: [0x2715, 0x2713], // [10005, 10003]
      list: analysis.needWeed,
      fn: helpWeed,
      key: 'weed',
      name: '草',
      record: 'helpWeed',
    },
    {
      id: 0x2716,             // 10006 = bug
      expIds: [0x2716, 0x2712], // [10006, 10002]
      list: analysis.needBug,
      fn: helpInsecticide,
      key: 'bug',
      name: '虫',
      record: 'helpBug',
    },
    {
      id: 0x2717,             // 10007 = water
      expIds: [0x2717, 0x2711], // [10007, 10001]
      list: analysis.needWater,
      fn: helpWater,
      key: 'water',
      name: '水',
      record: 'helpWater',
    },
  ];

  for (const opt of helpOptions) {
    const canGetExp = !checkExpLimit ||
      hasGuardDog ||
      (canGetExpByCandidates(opt.expIds) && getCanGetHelpExp());

    if (opt.list.length > 0 && canGetExp) {
      const canOp = await checkCanOperateRemote(gid, opt.id);
      if (canOp.canOperate) {
        const useExpCheck = hasGuardDog ? false : checkExpLimit;
        const okCount = await runBatchWithFallback(
          opt.list,
          ids => opt.fn(gid, ids, useExpCheck),
          id => opt.fn(gid, id, useExpCheck)
        );
        if (okCount > 0) {
          actionLogs.push(`${opt.name}${okCount}`);
          tally[opt.key] += okCount;
          recordOperation(opt.record, okCount);

          if (expLimitMode && hasGuardDog) {
            log('好友', `[护主犬好友] ✅ ${name}: 除${opt.name}${okCount}`, {
              module: 'friend',
              event: '护主犬好友帮助成功',
              friendName: name,
              operation: opt.name,
              count: okCount,
            });
          }
          await randomDelay(300, 900);
        }
      }
    }
  }

  if (actionLogs.length > 0) {
    log('好友', `${name}: ${actionLogs.join('/')}`, {
      module: 'friend',
      event: '帮助好友',
      result: 'ok',
      friendName: name,
      friendGid: gid,
      actions: actionLogs,
    });
  }

  await leaveFriendFarm(gid);
  return { acted: actionLogs.length > 0, entered: true, ripeAtMs };
}

// ===== 在线自动捣乱（面板 per-friend 开关，friend-auto-bad 调度调用）=====

/**
 * 随机选 1-3 块可放地块。cap<=0 或无地块时返回空数组——零额度绝不
 * slice 一块（旧实现的 Math.max(1, n) 会在额度为 0 时仍发一次请求）。
 */
function pickRandomLands(list, cap) {
  const shuffled = [...(Array.isArray(list) ? list : [])].sort(() => Math.random() - 0.5);
  const n = Math.min(Number(cap) || 0, shuffled.length, 1 + Math.floor(Math.random() * 3));
  return n > 0 ? shuffled.slice(0, n) : [];
}

/**
 * 对在线好友随机放虫/放草。虫与草相互独立：一方无可放地块/额度/失败
 * 不阻断另一方；总每日额度为 0 时零请求直接返回。
 * impl.guard（可选）在每种写动作前复查：返回 false 立即停止剩余写
 * （暂停/移出名单/让步/代际失效），reasons 记 <kind>_aborted。
 * 返回 { bug, weed, reasons, aborted }（固定原因码，供日志与调度退避归因）。
 * impl 仅供 core/test 注入网络替身，生产留空走真实协议。
 */
async function placeAutoBadItems(gid, analysis, tally, impl = {}) {
  const checkCanOperate = impl.checkCanOperate || checkCanOperateRemote;
  const putInsects = impl.putInsects || putInsectsDetailed;
  const putWeeds = impl.putWeeds || putWeedsDetailed;
  const badRemaining = impl.badRemaining || getBadRemainingTimes;
  const remainingFor = impl.remainingFor || ((opId, limit) => getRemainingTimes(opId, limit));
  const guard = impl.guard || null;
  const result = { bug: 0, weed: 0, reasons: [], aborted: false };

  if (badRemaining() <= 0) {
    result.reasons.push('cap_zero');
    return result;
  }

  const place = async (kind, list, opId, putFn, tallyKey) => {
    // 写动作前复查（2026-09-26 验收）：进门是异步的，进门期间守卫可能翻转
    if (guard && !guard()) {
      result.aborted = true;
      result.reasons.push(`${kind}_aborted`);
      return;
    }
    const remaining = Math.min(remainingFor(opId, BAD_DAILY_LIMIT), badRemaining());
    if (remaining <= 0) {
      result.reasons.push(`${kind}_cap_zero`);
      return;
    }
    if (!Array.isArray(list) || list.length === 0) {
      result.reasons.push(`no_${kind}_plots`);
      return;
    }
    // 单项 check+put 独立 try：虫的远程检查抛错不得跳过草，也不得让
    // 调用方失去 Leave 机会；错误只记固定原因码
    try {
      const canOp = await checkCanOperate(gid, opId);
      if (!canOp || !canOp.canOperate) {
        result.reasons.push(`${kind}_denied`);
        return;
      }
      // 远程 check 是异步的：等待期间暂停/stop/移出名单必须零写——
      // check 完成后、紧贴 put 前再查一次 guard
      if (guard && !guard()) {
        result.aborted = true;
        result.reasons.push(`${kind}_aborted`);
        return;
      }
      const targets = pickRandomLands(list, remaining);
      if (targets.length === 0) {
        result.reasons.push(`no_${kind}_targets`);
        return;
      }
      try {
        const put = await putFn(gid, targets);
        if (put && put.ok > 0) {
          result[kind] += put.ok;
          tally[tallyKey] += put.ok;
        } else {
          result.reasons.push(`${kind}_rejected`);
        }
      } catch {
        result.reasons.push(`${kind}_error`);
      }
    } catch {
      result.reasons.push(`${kind}_error`);
    }
    await randomDelay(500, 1500);
  };

  await place('bug', analysis && analysis.canPutBug, PUT_BUG_OPERATION_ID, putInsects, 'putBug');
  await place('weed', analysis && analysis.canPutWeed, PUT_WEED_OPERATION_ID, putWeeds, 'putWeed');

  log('好友', `在线自动捣乱 → 放虫${result.bug}/放草${result.weed}${result.reasons.length ? `（${result.reasons.join(',')}）` : ''}`, {
    module: 'friend',
    event: '在线自动捣乱',
    result: result.bug + result.weed > 0 ? 'ok' : 'zero',
    friendGid: gid,
    putBug: result.bug,
    putWeed: result.weed,
    reasons: result.reasons,
  });
  return result;
}

/**
 * 在线捣乱专用进门：Enter 回包本身就是在线探测（at_home / last_online，
 * noteEnterPresence 统一入表），在线且未完成会话时才放虫/放草。
 * 调度方（friend-auto-bad）负责名单、守卫、会话与退避。
 * options.guard（可选）在进门后与每种写动作前复查（placeAutoBadItems
 * 内逐项执行）：返回 false 时停止剩余写并带 aborted=true 返回。
 * 返回 { entered, online, bug, weed, reason, aborted, offlineSinceMs }；
 * reason 为固定原因码；offlineSinceMs=at_home=false 且服务端下发
 * last_online 时的离线时刻（墙钟 ms，0=未知）。
 * impl 仅供 core/test 注入网络替身（enter/leave/analyze/place），
 * 生产留空走真实协议。
 */
async function visitFriendForAutoBad(friend, tally, myGid, options = {}) {
  const { gid, name } = friend;
  const allowPlace = options.allowPlace !== false;
  const guard = options.guard || null;
  const impl = options.impl || {};

  const enter = impl.enter || enterFriendFarm;
  const leave = impl.leave || leaveFriendFarm;

  let enterReply;
  try {
    enterReply = await enter(gid);
  } catch (err) {
    const handled = handleFriendEnterError(gid, name, err);
    if (handled.handled) {
      if (handled.kind === 'blacklist') unwatchFriend(gid);
      return { entered: false, online: false, bug: 0, weed: 0, reason: 'enter_failed', atHome: null, atHomeDecoded: false };
    }
    logWarn('好友', `进入 ${name} 农场失败: ${err.message}`, {
      module: 'friend',
      event: '进入农场',
      result: 'error',
      friendName: name,
      friendGid: gid,
    });
    return { entered: false, online: false, bug: 0, weed: 0, reason: 'enter_failed', atHome: null, atHomeDecoded: false };
  }

  // 进门即记录 presence（含空地块早退路径），Enter 回包同时是离线探测
  // atHomeDecoded：回包里真的下发了 at_home 字段才算解码——protobuf 原型
  // 缺省值 false 不能当"下发过 false"，缺字段时 atHome=null（不下结论）
  let atHomeNow = null;
  const atHomeDecoded = Object.prototype.hasOwnProperty.call(enterReply || {}, 'at_home');
  let offlineSinceMs = 0;
  try {
    const presence = friendActivity.noteEnterPresence(gid, enterReply);
    atHomeNow = atHomeDecoded ? !!presence.atHome : null;
    offlineSinceMs = atHomeDecoded && presence.atHome ? 0 : presence.lastOnlineMs;
    if (presence.onlineEdge) {
      recordEvent(process.env.FARM_ACCOUNT_ID || '', 'info', 'friend_online',
        `好友上线：${name || `GID:${gid}`}`);
    }
  } catch { /* 证据记录失败不影响进门主流程 */ }
  // 在线判定：本次进门 at_home，或 10 秒窗口内的已证实在线证据
  // （at_home/lands_push/presence_online，与快档/面板同口径）
  const online = atHomeNow || friendActivity.isFriendOnlineRecently(gid);

  // 进门是异步的：进门后先复查守卫（暂停/移出名单/让步/代际失效），
  // 失败直接离开，不再做任何写动作
  if (guard && !guard()) {
    await leave(gid);
    return { entered: true, online, bug: 0, weed: 0, reason: 'aborted', aborted: true, offlineSinceMs, atHome: atHomeNow, atHomeDecoded };
  }

  const lands = enterReply.lands || [];
  if (!online || !allowPlace || lands.length === 0) {
    if (lands.length === 0) inspectFriendLands(gid, name, []);
    await leave(gid);
    return {
      entered: true,
      online,
      bug: 0,
      weed: 0,
      reason: !online ? 'not_online' : (!allowPlace ? 'session_done' : 'no_lands'),
      offlineSinceMs,
      atHome: atHomeNow,
      atHomeDecoded,
    };
  }

  inspectFriendLands(gid, name, lands);
  const analysis = (impl.analyze || analyzeFriendLands)(lands, myGid, name, {});
  // 进入成功后 Leave 用 finally 保证：放虫/放草任何异常都不许跳过离开
  let placed = { bug: 0, weed: 0, reasons: [], aborted: false };
  try {
    placed = await placeAutoBadItems(gid, analysis, tally, { guard, ...(impl.place || {}) });
  } catch {
    placed = { bug: 0, weed: 0, reasons: ['place_error'], aborted: false };
  } finally {
    await leave(gid);
  }
  return {
    entered: true,
    online: true,
    bug: placed.bug,
    weed: placed.weed,
    reason: placed.reasons.join(',') || null,
    aborted: placed.aborted,
    offlineSinceMs,
    atHome: atHomeNow,
    atHomeDecoded,
  };
}

// ===== Exports =====
module.exports = {
  fastLaneSteal,
  fastLaneRipeLandIdsForTests: fastLaneRipeLandIds,
  runBatchWithFallback,
  doFriendOperation,
  visitFriend,
  visitFriendForSteal,
  visitFriendForHelp,
  visitFriendForAutoBad,
  placeAutoBadItems,
};
