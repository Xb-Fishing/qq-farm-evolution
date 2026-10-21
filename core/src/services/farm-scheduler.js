
// Persistent-session async operation tracking.
if (globalThis.process?.env?.FARM_SESSION_BUSINESS === '1') {
  // eslint-disable-next-line no-func-assign -- Preserve the hoisted function and its existing recursive callers.
  checkFertilizerBuyOnce = require('./business-state').wrapBusinessFunction('services/farm-scheduler.js:checkFertilizerBuyOnce', checkFertilizerBuyOnce);
}
/**
 * 农场调度辅助模块
 * 负责化肥自动购买检测定时器
 */
const { log, logWarn } = require('../utils/utils');
const {
  isAutomationOn,
  getFertilizerBuyOrganicCount,
  getFertilizerBuyOrganicThresholdHours,
  getFertilizerBuyNormalCount,
  getFertilizerBuyNormalThresholdHours,
  getFertilizerBuyCheckIntervalMinutes,
  getPauseRemainMs
} = require('../models/store');
const { checkAndBuyFertilizerBoth } = require('./mall');

let fertilizerBuyCheckTimer = null;
const sessionFertilizerScheduler = globalThis.process?.env?.FARM_SESSION_BUSINESS === '1'
  ? require('./scheduler').createScheduler('farm-fertilizer') : null;

/** 启动化肥自动购买检测定时器 */
function startFertilizerBuyCheckTimer() {
  if (sessionFertilizerScheduler) sessionFertilizerScheduler.clear('fertilizer_buy_check');
  else if (fertilizerBuyCheckTimer) clearInterval(fertilizerBuyCheckTimer);

  if (!isAutomationOn('fertilizer_buy_organic') && !isAutomationOn('fertilizer_buy_normal')) return;

  const intervalMinutes = getFertilizerBuyCheckIntervalMinutes();
  const intervalMs = intervalMinutes * 60 * 1000;

  if (sessionFertilizerScheduler) sessionFertilizerScheduler.setIntervalTask('fertilizer_buy_check', intervalMs, checkFertilizerBuyOnce, { preventOverlap: false });
  else fertilizerBuyCheckTimer = setInterval(() => { checkFertilizerBuyOnce(); }, intervalMs);

  log('农场', `化肥自动购买检测定时器已启动，间隔 ${intervalMinutes} 分钟`, {
    module: 'farm',
    event: '购买化肥计时器',
    result: 'start',
    intervalMinutes
  });
}

/** 停止化肥自动购买检测定时器 */
function stopFertilizerBuyCheckTimer() {
  sessionFertilizerScheduler?.clear('fertilizer_buy_check');
  if (fertilizerBuyCheckTimer) {
    clearInterval(fertilizerBuyCheckTimer);
    fertilizerBuyCheckTimer = null;
  }
  log('农场', '化肥自动购买检测定时器已停止', {
    module: 'farm',
    event: '购买化肥计时器',
    result: 'stop'
  });
}

/** 执行一次化肥购买检测 */
async function checkFertilizerBuyOnce() {
  if (getPauseRemainMs(process.env.FARM_ACCOUNT_ID || '') > 0) return;
  if (!isAutomationOn('fertilizer_buy_organic') && !isAutomationOn('fertilizer_buy_normal')) return;

  try {
    const config = {
      automatic: true,
      buyOrganic: isAutomationOn('fertilizer_buy_organic'),
      buyNormal: isAutomationOn('fertilizer_buy_normal'),
      organicCount: getFertilizerBuyOrganicCount(),
      organicThresholdHours: getFertilizerBuyOrganicThresholdHours(),
      normalCount: getFertilizerBuyNormalCount(),
      normalThresholdHours: getFertilizerBuyNormalThresholdHours()
    };
    await checkAndBuyFertilizerBoth(config);
  } catch (err) {
    logWarn('农场', `化肥自动购买检测失败: ${err.message}`, {
      module: 'farm',
      event: 'fertilizer_auto_buy',
      result: 'error',
      error: err.message
    });
  }
}

module.exports = {
  startFertilizerBuyCheckTimer,
  stopFertilizerBuyCheckTimer
};

if (sessionFertilizerScheduler) sessionFertilizerScheduler.bindIntervalTask('fertilizer_buy_check', checkFertilizerBuyOnce);
