
// Persistent-session async operation tracking.
if (globalThis.process?.env?.FARM_SESSION_BUSINESS === '1') {
  // eslint-disable-next-line no-func-assign -- Preserve the hoisted function and its existing recursive callers.
  performOwnHarvest = require('./business-state').wrapBusinessFunction('services/farming-orchestrator.js:performOwnHarvest', performOwnHarvest);
  // eslint-disable-next-line no-func-assign -- Preserve the hoisted function and its existing recursive callers.
  harvestOwnAtMaturity = require('./business-state').wrapBusinessFunction('services/farming-orchestrator.js:harvestOwnAtMaturity', harvestOwnAtMaturity);
  // eslint-disable-next-line no-func-assign -- Preserve the hoisted function and its existing recursive callers.
  checkFarm = require('./business-state').wrapBusinessFunction('services/farming-orchestrator.js:checkFarm', checkFarm);
  // eslint-disable-next-line no-func-assign -- Preserve the hoisted function and its existing recursive callers.
  runFarmOperation = require('./business-state').wrapBusinessFunction('services/farming-orchestrator.js:runFarmOperation', runFarmOperation);
}
const { CONFIG, PlantPhase } = require('../config/config');
const { getUserState, isConnected, networkEvents } = require('../utils/network');
const { toNum, log, logWarn, randomDelay, getServerTimeSec, getServerTimeMs } = require('../utils/utils');
const { isAutomationOn, getAutomation, getPrioritize2x2Crops, getPauseRemainMs } = require('../models/store');
const { recordOperation } = require('./stats');
const { recordEvent } = require('./daily-events');
const { createScheduler } = require('./scheduler');
const { getAllLands, harvest, farming, unlockLand, upgradeLand } = require('./farm-api');
const { analyzeLands, getCurrentPhase, resolveRemovableHarvestedLands } = require('./farm-land-analyzer');
const { runFertilizerByConfig } = require('./farm-fertilizer');
const { autoPlantEmptyLands } = require('./planting-service');
const { startFertilizerBuyCheckTimer, stopFertilizerBuyCheckTimer } = require('./farm-scheduler');
const {
  stealIsDue,
  stealIsImminent,
  ownHarvestIsDue,
  ownHarvestIsImminent,
  markOwnHarvestDueAt,
  isIdleQuiet,
} = require('../utils/behavior');
const friendActivity = require('./friend-activity');

// ─── 状态标记 ───

let isCheckingFarm = false;
let isFirstFarmCheck = true;
let farmLoopRunning = false;
let externalSchedulerMode = false;
let lastPushTime = 0;
let shouldRefresh2x2Plan = true;
let lastNextMatureDueAtMs = 0;
let lastNextMatureLandIds = [];
let ownMatureSchedule = new Map();
let ownHarvestInFlight = null;
// 只存可比较的作物快照；旧版热交接基线缺少生命周期字段，首次观察只重建。
const ownNudgeLandSnapshots = new Map();

const farmScheduler = createScheduler('farm');

function formatRemain(sec) {
  const n = Math.max(0, Math.floor(Number(sec) || 0));
  if (n <= 0) return '即将成熟';
  const h = Math.floor(n / 3600);
  const m = Math.floor((n % 3600) / 60);
  if (h > 0) return `${h}小时${m}分`;
  if (m > 0) return `${m}分`;
  return `${n}秒`;
}

/**
 * plant.id 是品种，不是植株身份。成熟/收获会把施肥余次重置为默认 0，
 * 换季/重种也会重置状态；只有连续生长快照的变化才可作为施肥证据。
 * phases 是当前及后续阶段的后缀，正常裁剪不会改变成熟墙钟。
 */
function noteOwnFarmNudge(lands, nextMatureSec, matureSchedule = []) {
  const next = toNum(nextMatureSec);
  const matureByLand = new Map();
  for (const item of Array.isArray(matureSchedule) ? matureSchedule : []) {
    const landId = toNum(item && item.landId);
    const matureAtSec = toNum(item && item.matureAtSec);
    if (landId && matureAtSec) matureByLand.set(landId, matureAtSec);
  }

  const serverSec = getServerTimeSec();
  const reasons = new Set();
  const changedLandIds = [];
  const seenLandIds = new Set();
  for (const land of Array.isArray(lands) ? lands : []) {
    const plant = land && land.plant;
    const landId = toNum(land && land.id);
    if (landId) seenLandIds.add(landId);
    if (!landId) continue;
    if (!plant || !Array.isArray(plant.phases) || plant.phases.length === 0) {
      ownNudgeLandSnapshots.delete(landId);
      continue;
    }
    const plantId = toNum(plant.id);
    const currentPhase = getCurrentPhase(plant.phases, false, '', plantId);
    if (!plantId || !currentPhase || currentPhase.phase === PlantPhase.DEAD
      || currentPhase.phase === PlantPhase.UNKNOWN) {
      ownNudgeLandSnapshots.delete(landId);
      continue;
    }
    const fertRaw = plant.left_inorc_fert_times != null
      ? plant.left_inorc_fert_times
      : plant.leftInorcFertTimes;
    const fertLeft = fertRaw == null ? null : toNum(fertRaw);
    const nudged = !!(plant.is_nudged || plant.isNudged);
    const matureAtSec = matureByLand.get(landId) || 0;
    const season = plant.season == null ? null : toNum(plant.season);
    const growing = currentPhase.phase !== PlantPhase.MATURE && matureAtSec > serverSec;
    const phaseCount = plant.phases.length;
    const prev = ownNudgeLandSnapshots.get(landId);
    const sameCycle = prev && prev.version === 2 && prev.plantId === plantId
      && prev.season === season && prev.matureAtSec > 0 && matureAtSec > 0
      && matureAtSec <= prev.matureAtSec + 25 && phaseCount <= prev.phaseCount;
    if (sameCycle && prev.growing && prev.matureAtSec > serverSec) {
      const evidence = [];
      // 真正把未来成熟点提前（含直接催熟）仍可识别；自然到点不满足此前提。
      if (matureAtSec < prev.matureAtSec - 25) evidence.push('mature_time_advanced');
      // 成熟、枯死或收获后的默认计数/标志绝不能单独证明施肥。
      if (growing) {
        if (prev.fertLeft != null && fertLeft != null && fertLeft < prev.fertLeft) evidence.push('fertilizer_count_decreased');
        if (nudged && !prev.nudged) evidence.push('nudged_rising');
      }
      if (evidence.length) {
        changedLandIds.push(landId);
        for (const reason of evidence) reasons.add(reason);
      }
    }
    ownNudgeLandSnapshots.set(landId, { version: 2, plantId, season, matureAtSec, fertLeft, nudged, growing, phaseCount });
  }
  for (const landId of [...ownNudgeLandSnapshots.keys()]) {
    if (!seenLandIds.has(landId)) ownNudgeLandSnapshots.delete(landId);
  }

  if (isFirstFarmCheck || reasons.size === 0) return false;
  const remain = next > 0 ? Math.max(0, next - serverSec) : 0;
  const timing = remain > 0 ? `下次收获约 ${formatRemain(remain)}后` : '作物已成熟，请及时收获';
  log('农场', `自己农场检测到催熟/化肥，${timing}`, {
    module: 'farm',
    event: '催熟',
    result: 'ok',
    remainSec: remain,
    landIds: changedLandIds,
    reasons: [...reasons].sort(),
  });
  return true;
}

/** 把服务器秒级成熟时间转换为本机绝对毫秒墙钟，保留最近一次校时的小数部分。 */
function serverMatureSecToLocalMs(matureSec, localNow = Date.now(), serverNowMs = getServerTimeMs()) {
  const sec = toNum(matureSec);
  if (!sec) return 0;
  return Math.round(localNow + (sec * 1000 - serverNowMs));
}

function publishOwnMaturitySchedule(source = 'snapshot') {
  let nextSec = 0;
  const nextIds = [];
  for (const [landId, matureAtSec] of ownMatureSchedule.entries()) {
    if (!matureAtSec) continue;
    if (!nextSec || matureAtSec < nextSec) {
      nextSec = matureAtSec;
      nextIds.length = 0;
      nextIds.push(landId);
    } else if (matureAtSec === nextSec) {
      nextIds.push(landId);
    }
  }

  nextIds.sort((a, b) => a - b);
  const dueAt = serverMatureSecToLocalMs(nextSec);
  const changed = Math.abs(dueAt - lastNextMatureDueAtMs) > 5
    || nextIds.join(',') !== lastNextMatureLandIds.join(',');
  lastNextMatureDueAtMs = dueAt;
  lastNextMatureLandIds = nextIds;
  markOwnHarvestDueAt(
    isAutomationOn('farm') && isAutomationOn('harvest') ? dueAt : 0
  );

  if (changed) {
    networkEvents.emit('ownMaturityChanged', {
      dueAt,
      landIds: [...nextIds],
      source,
    });
  }
}

/** 用完整 AllLands 快照替换自己的成熟日程。 */
function replaceOwnMaturitySchedule(analysis) {
  const schedule = new Map();
  for (const item of Array.isArray(analysis && analysis.matureSchedule)
    ? analysis.matureSchedule : []) {
    const landId = toNum(item && item.landId);
    const matureAtSec = toNum(item && item.matureAtSec);
    if (landId && matureAtSec) schedule.set(landId, matureAtSec);
  }

  // 极少数协议快照可能不给成熟阶段 begin_time；已经成熟仍必须立即保护。
  const serverNowSec = Math.floor(getServerTimeMs() / 1000);
  for (const rawLandId of Array.isArray(analysis && analysis.harvestable)
    ? analysis.harvestable : []) {
    const landId = toNum(rawLandId);
    if (landId && !schedule.has(landId)) schedule.set(landId, serverNowSec);
  }
  ownMatureSchedule = schedule;
  publishOwnMaturitySchedule('all_lands');
}

/** 收获返回是增量快照：只替换本次目标，保留其他地块的已知成熟墙钟。 */
function reconcileOwnMaturityAfterHarvest(landIds, harvestReply) {
  const targets = new Set((Array.isArray(landIds) ? landIds : []).map(toNum).filter(Boolean));
  for (const landId of targets) ownMatureSchedule.delete(landId);

  const replyLands = Array.isArray(harvestReply && harvestReply.land) ? harvestReply.land : [];
  if (replyLands.length > 0) {
    const partial = analyzeLands(replyLands, false);
    const serverNowMs = getServerTimeMs();
    for (const item of partial.matureSchedule) {
      const landId = toNum(item && item.landId);
      const matureAtSec = toNum(item && item.matureAtSec);
      // 本次已接受的成熟收获不再重挂；只接续多季作物的新一季未来墙钟。
      if (landId && matureAtSec * 1000 > serverNowMs + 100) {
        ownMatureSchedule.set(landId, matureAtSec);
      }
    }
  }
  publishOwnMaturitySchedule('harvest_reply');
}

/**
 * 自己的所有收获请求共用一个在途 Promise，防止成熟定时器、farm tick 和推送重复发 Harvest。
 */
async function performOwnHarvest(landIds, options = {}) {
  const ids = [...new Set((Array.isArray(landIds) ? landIds : []).map(toNum).filter(Boolean))];
  if (ids.length === 0) return { harvestedCount: 0, landIds: [], reply: null };
  if (ownHarvestInFlight) return ownHarvestInFlight;

  const task = (async () => {
    const reply = await harvest(ids);
    // 成功收获即结束旧茬；即使两次巡田之间已同种补种，也不得比较旧基线。
    for (const landId of ids) ownNudgeLandSnapshots.delete(landId);
    reconcileOwnMaturityAfterHarvest(ids, reply);
    const dueAt = Number(options.dueAt) || 0;
    const latencyMs = dueAt > 0 ? Math.max(0, Date.now() - dueAt) : null;
    log('收获', `${options.priority ? '到点保护收获' : '收获'}完成 ${ids.length} 块土地`, {
      module: 'farm', event: options.priority ? '到点保护收获' : '收获作物', result: 'ok',
      count: ids.length, landIds: [...ids], priority: !!options.priority,
      ...(latencyMs == null ? {} : { dueAt, latencyMs })
    });
    recordOperation('harvest', ids.length);
    recordEvent(process.env.FARM_ACCOUNT_ID || '', 'info', 'harvest',
      `${options.priority ? '到点保护' : '收获'} ${ids.length} 块土地`);
    networkEvents.emit('farmHarvested', {
      count: ids.length,
      landIds: [...ids],
      opType: options.opType || 'harvest',
      priority: !!options.priority,
      latencyMs,
    });
    return { harvestedCount: ids.length, landIds: ids, reply };
  })();

  ownHarvestInFlight = task;
  try {
    return await task;
  } finally {
    if (ownHarvestInFlight === task) ownHarvestInFlight = null;
  }
}

/** 到计算成熟点时直接收缓存地块，不增加一次 AllLands 往返。 */
async function harvestOwnAtMaturity() {
  const dueAt = lastNextMatureDueAtMs;
  if (!dueAt || dueAt > Date.now() + 100 || lastNextMatureLandIds.length === 0) {
    return { harvestedCount: 0, landIds: [], reply: null, dueAt };
  }
  return performOwnHarvest(lastNextMatureLandIds, {
    opType: 'maturity_guard',
    priority: true,
    dueAt,
  });
}

// ─── 辅助函数 ───

/** 判断是否为临时性网络错误 */
function isTransientNetworkError(err) {
  const msg = String(err && err.message || '');
  if (!msg) return false;
  return [
    '连接未打开', '请求超时', '请求已中断',
    '连接关闭', '发送失败', '请求队列已满'
  ].some(pattern => msg.includes(pattern));
}

// ─── 核心巡田逻辑 ───

/**
 * 检查并执行农场操作
 * @returns {boolean} 是否有需要执行的操作
 */
async function checkFarm(options = {}) {
  if (getPauseRemainMs(process.env.FARM_ACCOUNT_ID || '') > 0) return false;
  const userState = getUserState();
  if (isCheckingFarm || !userState.gid || !isAutomationOn('farm') || !isConnected()) {
    return false;
  }
  if (!options.fromPush && (stealIsDue() || stealIsImminent(800)) && !ownHarvestIsDue()) {
    return false;
  }

  isCheckingFarm = true;
  try {
    const result = await runFarmOperation('all', { automatic: true });
    isFirstFarmCheck = false;
    return !!(result && result.hadWork);
  } catch (err) {
    if (!isTransientNetworkError(err)) {
      logWarn('巡田', `检查失败: ${err.message}`);
    }
    return false;
  } finally {
    isCheckingFarm = false;
  }
}

/**
 * 执行农场操作
 * @param {string} opType - 操作类型：'all' | 'harvest' | 'plant' | 'clear' | 'upgrade'
 */
async function runFarmOperation(opType, options = {}) {
  const automaticPaused = () => options.automatic === true && getPauseRemainMs(process.env.FARM_ACCOUNT_ID || '') > 0;
  if (automaticPaused()) return { hadWork: false, actions: [], harvestedCount: 0 };
  const landsReply = await getAllLands();
  if (automaticPaused()) return { hadWork: false, actions: [], harvestedCount: 0 };
  if (!landsReply.lands || landsReply.lands.length === 0) {
    if (opType !== 'all') log('农场', '没有土地数据');
    return { hadWork: false, actions: [], harvestedCount: 0 };
  }

  const lands = landsReply.lands;
  const analysis = analyzeLands(lands, isFirstFarmCheck);
  noteOwnFarmNudge(lands, analysis.nextMatureSec, analysis.matureSchedule);
  replaceOwnMaturitySchedule(analysis);
  const labels = [];

  // 构建状态标签
  if (analysis.harvestable.length) labels.push(`收:${  analysis.harvestable.length}`);
  if (analysis.needWeed.length) labels.push(`草:${  analysis.needWeed.length}`);
  if (analysis.needBug.length) labels.push(`虫:${  analysis.needBug.length}`);
  if (analysis.needGoldenBug.length) labels.push(`金虫:${  analysis.needGoldenBug.length}`);
  if (analysis.needWater.length) labels.push(`水:${  analysis.needWater.length}`);
  if (analysis.dead.length) labels.push(`枯:${  analysis.dead.length}`);
  if (analysis.empty.length) labels.push(`空:${  analysis.empty.length}`);
  if (analysis.unlockable.length) labels.push(`解:${  analysis.unlockable.length}`);
  if (analysis.upgradable.length) labels.push(`升:${  analysis.upgradable.length}`);
  labels.push(`长:${  analysis.growing.length}`);

  const actions = [];

  // ── 收获：永远先于务农、种植、升级和好友偷菜让路判断 ──
  let harvestedLands = [];
  let harvestResult = null;
  let removeResult = null;
  const pausedResult = () => ({ hadWork: actions.length > 0, actions, harvestedCount: harvestedLands.length });

  if (opType === 'harvest' || (opType === 'all' && isAutomationOn('harvest'))) {
    if (analysis.harvestable.length > 0) {
      try {
        const outcome = await performOwnHarvest(analysis.harvestable, { opType });
        harvestResult = outcome.reply;
        harvestedLands = [...outcome.landIds];
        if (outcome.harvestedCount > 0) actions.push(`收获${outcome.harvestedCount}`);
      } catch (err) {
        logWarn('收获', err.message, { module: 'farm', event: '收获作物', result: 'error' });
        recordEvent(process.env.FARM_ACCOUNT_ID || '', 'error', 'harvest_failed', `收获失败: ${err.message}`);
      }
    }
  }

  if (automaticPaused()) return pausedResult();

  // 保护自己的下一批成熟作物：最后十秒不再启动非必要业务；若好友已到点，
  // 也只在自己的当批收获完成后才让出执行权。
  if (opType === 'all' && ownHarvestIsImminent(10_000)) {
    return { hadWork: actions.length > 0, actions, harvestedCount: harvestedLands.length };
  }
  if (stealIsDue()) {
    return { hadWork: actions.length > 0, actions, harvestedCount: harvestedLands.length };
  }

  // ── 一键务农（浇水/除草/除虫）──
  if (opType === 'all' || opType === 'clear') {
    const skipOwnWeedBug = opType === 'all' && isAutomationOn('skip_own_weed_bug');
    const ordinaryLandIds = skipOwnWeedBug
      ? [...analysis.needWater]
      : [...analysis.needWeed, ...analysis.needBug, ...analysis.needWater];
    const goldenBugLandIds = isAutomationOn('golden_bug_clear')
      ? analysis.needGoldenBug
      : [];
    const farmingLandIds = [...new Set([...ordinaryLandIds, ...goldenBugLandIds])];

    if (farmingLandIds.length > 0) {
      try {
        await farming(farmingLandIds);
        const parts = [];
        if (!skipOwnWeedBug && analysis.needWeed.length > 0) {
          parts.push(`草${analysis.needWeed.length}`);
          recordOperation('weed', analysis.needWeed.length);
        }
        if (!skipOwnWeedBug && analysis.needBug.length > 0) {
          parts.push(`虫${analysis.needBug.length}`);
          recordOperation('bug', analysis.needBug.length);
        }
        if (analysis.needWater.length > 0) {
          parts.push(`水${analysis.needWater.length}`);
          recordOperation('water', analysis.needWater.length);
        }
        if (goldenBugLandIds.length > 0) {
          parts.push(`黄金虫${goldenBugLandIds.length}`);
          recordOperation('goldenBugClear', goldenBugLandIds.length);
        }
        actions.push(`一键务农${parts.join('/')}`);
        recordOperation('farming', farmingLandIds.length);
        recordEvent(process.env.FARM_ACCOUNT_ID || '', 'info', 'farming',
          `一键务农：${parts.join('/') || '无动作'}`);
      } catch (err) {
        logWarn('一键务农', err.message);
        recordEvent(process.env.FARM_ACCOUNT_ID || '', 'error', 'farming_failed', `一键务农失败: ${err.message}`);
      }
    }
  }

  if (automaticPaused()) return pausedResult();

  // ── 种植 ──
  if (opType === 'plant' || (opType === 'all' && isAutomationOn('plant'))) {
    const emptyLands = [...new Set(analysis.empty)];
    let deadLands = [...new Set(analysis.dead)];

    // 收获后检查可铲除的地块
    if (opType === 'all' && harvestedLands.length > 0) {
      await randomDelay(200, 800);
      if (automaticPaused()) return pausedResult();
      removeResult = await resolveRemovableHarvestedLands(harvestedLands, harvestResult);
      deadLands = [...new Set([...deadLands, ...removeResult.removable])];
    }

    if (automaticPaused()) return pausedResult();
    const shouldRefresh2x2 = shouldRefresh2x2Plan && getPrioritize2x2Crops();
    if (deadLands.length > 0 || emptyLands.length > 0 || shouldRefresh2x2) {
      try {
        const plantResult = await autoPlantEmptyLands(deadLands, emptyLands, lands);
        const removedCount = Number(plantResult && plantResult.removedCount) || 0;
        const plantedCount = Number(plantResult && (plantResult.occupiedCount || plantResult.plantedCount)) || 0;
        if (removedCount > 0) {
          actions.push(`铲除${  removedCount}`);
          recordOperation('remove', removedCount);
        }
        if (plantedCount > 0) {
          actions.push(`种植${  plantedCount}`);
          recordOperation('plant', plantedCount);
          recordEvent(process.env.FARM_ACCOUNT_ID || '', 'info', 'plant',
            `种植 ${plantedCount} 块${removedCount > 0 ? `（铲除 ${removedCount}）` : ''}`);
        }
      } catch (err) {
        logWarn('种植', err.message);
        recordEvent(process.env.FARM_ACCOUNT_ID || '', 'error', 'plant_failed', `种植失败: ${err.message}`);
      } finally {
        shouldRefresh2x2Plan = false;
      }
    }
  }

  if (automaticPaused()) return pausedResult();

  // ── 多季作物补肥 ──
  if (opType === 'all' && removeResult && Array.isArray(removeResult.growing) &&
      removeResult.growing.length > 0 && isAutomationOn('fertilizer_multi_season') &&
      (getAutomation().fertilizer || 'none') !== 'final_normal') {
    const multiSeasonLands = [...new Set(
      removeResult.growing.map(id => toNum(id)).filter(Boolean)
    )];
    if (multiSeasonLands.length > 0) {
      log('施肥', `检测到多季作物进入后续季，准备执行多季补肥，目标地块 ${multiSeasonLands.length} 块`, {
        module: 'farm', event: '多季节施肥', result: 'trigger',
        count: multiSeasonLands.length, landIds: multiSeasonLands
      });
      try {
        await runFertilizerByConfig(multiSeasonLands, { reason: 'multi_season' });
      } catch (err) {
        logWarn('施肥', `多季补肥执行失败: ${err.message}`, {
          module: 'farm', event: '多季节施肥', result: 'error'
        });
      }
    }
  }

  if (automaticPaused()) return pausedResult();

  // ── 土地升级/解锁 ──
  const shouldUpgrade = opType === 'all' && isAutomationOn('land_upgrade');
  if (shouldUpgrade || opType === 'upgrade') {
    // 解锁土地
    if (analysis.unlockable.length > 0) {
      let unlockedCount = 0;
      for (const landId of analysis.unlockable) {
        if (automaticPaused()) break;
        try {
          await unlockLand(landId, false);
          log('解锁', `土地#${landId} 解锁成功`, {
            module: 'farm', event: '解锁土地', result: 'ok', landId
          });
          unlockedCount++;
        } catch (err) {
          logWarn('解锁', `土地#${landId} 解锁失败: ${err.message}`, {
            module: 'farm', event: '解锁土地', result: 'error', landId
          });
        }
        await randomDelay(200, 500);
      }
      if (unlockedCount > 0) actions.push(`解锁${  unlockedCount}`);
    }

    // 升级土地
    if (analysis.upgradable.length > 0) {
      let upgradedCount = 0;
      for (const landId of analysis.upgradable) {
        if (automaticPaused()) break;
        try {
          const result = await upgradeLand(landId);
          const newLevel = result.land ? toNum(result.land.level) : '?';
          log('升级', `土地#${landId} 升级成功 → 等级${newLevel}`, {
            module: 'farm', event: '升级土地', result: 'ok', landId, level: newLevel
          });
          upgradedCount++;
        } catch (err) {
          log('升级', `土地#${landId} 升级失败: ${err.message}`, {
            module: 'farm', event: '升级土地', result: 'error', landId
          });
        }
        await randomDelay(200, 500);
      }
      if (upgradedCount > 0) {
        actions.push(`升级${  upgradedCount}`);
        recordOperation('upgrade', upgradedCount);
      }
    }
  }

  if (automaticPaused()) return pausedResult();

  // ── 智能施肥（巡田时触发）──
  if (opType === 'all') {
    const fertilizerMode = getAutomation().fertilizer || 'none';
    if (fertilizerMode === 'smart' || fertilizerMode === 'smart_only' || fertilizerMode === 'smart_normal' ||
        fertilizerMode === 'final_normal' || fertilizerMode === 'final_organic') {
      try {
        const fertResult = await runFertilizerByConfig([], { skipNormal: true });
        if (fertResult.organic > 0) actions.push(`有机肥${  fertResult.organic}`);
        else if (fertResult.normal > 0) actions.push(`普通肥${  fertResult.normal}`);
      } catch (err) {
        logWarn('施肥', `巡田时施肥失败: ${err.message}`);
      }
    }
  }

  // ── 日志输出 ──
  const summary = actions.length > 0 ? ` → ${actions.join('/')}` : '';
  if (actions.length > 0) {
    log('农场', `[${labels.join(' ')}]${summary}`, {
      module: 'farm', event: '农场循环', opType, actions
    });
  }

  return { hadWork: actions.length > 0, actions, harvestedCount: harvestedLands.length };
}

/**
 * 距最近一块作物成熟还剩多少毫秒（0 = 没有/未知）。
 * ponytail: 基于上一轮巡田的快照，两轮之间新种的作物要等下一轮才纳入，误差由常规轮询兜底。
 */
function getNextMatureInMs() {
  if (!lastNextMatureDueAtMs) return 0;
  return Math.max(0, lastNextMatureDueAtMs - Date.now());
}

/** 最近一块自己作物的绝对成熟墙钟；到期后仍保留，直到确认发出收获。 */
function getNextMatureDueAtMs() {
  return lastNextMatureDueAtMs;
}

// ── 定时巡田循环 ──

function scheduleNextFarmCheck(intervalMs = CONFIG.farmCheckInterval) {
  if (externalSchedulerMode) return;
  if (!farmLoopRunning) return;
  farmScheduler.setTimeoutTask('farm_check_loop', Math.max(0, intervalMs), onFarmLoopTimer);
}

function startFarmCheckLoop(options = {}) {
  if (farmLoopRunning) return;
  externalSchedulerMode = !!options.externalScheduler;
  farmLoopRunning = true;
  shouldRefresh2x2Plan = true;
  networkEvents.on('landsChanged', onLandsChangedPush);
  if (!externalSchedulerMode) scheduleNextFarmCheck(1000); // 1 秒后首次检查
  startFertilizerBuyCheckTimer();
}

/** 收到地块变化推送时的响应 */
function onLandsChangedPush(lands) {
  // 自家农场地块推送里 social_items 的 owner_gid/created_at = 谁在我家放
  // 了道具+何时放（2026-09-22 好友活跃证据，零成本搭车）。
  // weed_owners/insect_owners = 谁在我家放了草/虫（2026-09-28，无放置时间戳，
  // 以推送到达为上界，只算活跃不算在线）。
  try {
    friendActivity.noteSocialItems(lands, getUserState().gid, Date.now());
    friendActivity.noteMischiefOwners(lands, getUserState().gid, Date.now());
  } catch { /* 证据失败不影响主流程 */ }
  if (getPauseRemainMs(process.env.FARM_ACCOUNT_ID || '') > 0) return;
  if (!isAutomationOn('farm_push')) return;
  if (isIdleQuiet()) return;
  shouldRefresh2x2Plan = true;
  if (isCheckingFarm) return;
  const now = Date.now();
  if (now - lastPushTime < 500) return; // 500ms 去抖
  lastPushTime = now;
  log('农场', `收到推送: ${lands.length}块土地变化，检查中...`, {
    module: 'farm', event: '土地推送通知', result: 'trigger_check', count: lands.length
  });
  farmScheduler.setTimeoutTask('farm_push_check', 1000, onFarmPushTimer);
}

function stopFarmCheckLoop() {
  farmLoopRunning = false;
  externalSchedulerMode = false;
  farmScheduler.clearAll();
  networkEvents.removeListener('landsChanged', onLandsChangedPush);
  stopFertilizerBuyCheckTimer();
}

function refreshFarmCheckLoop(delayMs = 0) {
  if (!farmLoopRunning) return;
  shouldRefresh2x2Plan = true;
  scheduleNextFarmCheck(delayMs);
}

module.exports = {
  checkFarm,
  runFarmOperation,
  harvestOwnAtMaturity,
  getNextMatureInMs,
  getNextMatureDueAtMs,
  serverMatureSecToLocalMs,
  startFarmCheckLoop,
  stopFarmCheckLoop,
  refreshFarmCheckLoop,
  noteOwnFarmNudgeForTests: noteOwnFarmNudge,
  resetOwnNudgeBaselineForTests() {
    ownNudgeLandSnapshots.clear();
    isFirstFarmCheck = false;
  },
};

async function onFarmLoopTimer() {
  if (!farmLoopRunning) return;
  await checkFarm();
  if (farmLoopRunning) scheduleNextFarmCheck(CONFIG.farmCheckInterval);
}
async function onFarmPushTimer() {
  if (!isCheckingFarm && getPauseRemainMs(process.env.FARM_ACCOUNT_ID || '') <= 0) await checkFarm({ fromPush: true });
}
function bindFarmSessionState() {
  if (farmLoopRunning) networkEvents.on('landsChanged', onLandsChangedPush);
  farmScheduler.bindTimeoutTask('farm_check_loop', onFarmLoopTimer);
  farmScheduler.bindTimeoutTask('farm_push_check', onFarmPushTimer);
}

// Persistent-session data capsule. No handles, functions or in-flight work.
if (globalThis.process?.env?.FARM_SESSION_BUSINESS === '1') {
  const { registerDataState, restoreContainer } = require('./business-state');
  registerDataState('services/farming-orchestrator.js', () => ({ isCheckingFarm, isFirstFarmCheck, farmLoopRunning, externalSchedulerMode, lastPushTime, shouldRefresh2x2Plan, lastNextMatureDueAtMs, lastNextMatureLandIds, ownMatureSchedule, ownNudgeLandSnapshots }), value => {
      isCheckingFarm = value.isCheckingFarm;
      isFirstFarmCheck = value.isFirstFarmCheck;
      farmLoopRunning = value.farmLoopRunning;
      externalSchedulerMode = value.externalSchedulerMode;
      lastPushTime = value.lastPushTime;
      shouldRefresh2x2Plan = value.shouldRefresh2x2Plan;
      lastNextMatureDueAtMs = value.lastNextMatureDueAtMs;
      lastNextMatureLandIds = value.lastNextMatureLandIds;
      ownMatureSchedule = value.ownMatureSchedule;
      restoreContainer(ownNudgeLandSnapshots, value.ownNudgeLandSnapshots);
  }, { idle: () => !isCheckingFarm && !ownHarvestInFlight, bind: bindFarmSessionState, });
}
