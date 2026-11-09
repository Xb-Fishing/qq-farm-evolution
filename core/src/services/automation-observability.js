// Observations never schedule work or authorize an operation.
const { redactExternalText } = require('./privacy-guard');
const CATEGORIES = {
  task: { label: '任务', module: 'task' }, rewards: { label: '日常奖励', module: 'task' },
  warehouse: { label: '出售', module: 'warehouse' }, fertilizer: { label: '化肥', module: 'farm' },
  land: { label: '土地', module: 'farm' }, shop: { label: '商城', module: 'warehouse' },
  friend: { label: '好友互动', module: 'friend' }, activity: { label: '活动', module: 'activity' },
  login: { label: '登录维护', module: 'system' },
};
const ACTIONS = {
  '领取任务': 'task', '领取活跃奖励': 'task', '图鉴奖励': 'task',
  email_rewards: 'rewards', daily_share: 'rewards', month_card_gift: 'rewards',
  mall_free_gifts: 'rewards', vip_daily_gift: 'rewards',
  '开启化肥礼包': 'fertilizer', '购买化肥': 'fertilizer',
  '施肥': 'fertilizer', '常规施肥': 'fertilizer', '多季节施肥': 'fertilizer',
  '解锁土地': 'land', '升级土地': 'land',
  sell_success: 'warehouse', sell_done: 'warehouse',
  '神秘商人自动购买': 'shop', '帮助好友': 'friend', '照顾好友': 'friend', '在线自动捣乱': 'friend',
  '放置黄金虫': 'friend', '自动同意好友': 'friend', milk_tea_operate: 'activity',
};
const MILK_ACTIONS = { createShop: '创建店铺', renameShop: '修改店名', hire: '雇佣',
  hireSetting: '调整雇佣设置', claimCashier: '领取营业收益', boost: '加速营业', upgrade: '升级店铺',
  craft: '制作奶茶', claimWages: '领取工资', interact: '完成互动', exchange: '兑换商品',
  fundClaim: '领取基金奖励', shareDaily: '领取每日分享奖励', shareFirst: '领取首次分享奖励', shareMilestones: '领取快乐值奖励' };
const queryTimes = new Map();
const CONTROL_LABELS = {
  farm: '农场巡查', harvest: '自动收获', plant: '自动种植', task: '任务领奖', sell: '自动出售',
  friend: '好友巡查', friend_steal: '好友偷菜', friend_help: '好友帮助', friend_bad: '好友捣乱',
  friend_golden_bug: '好友黄金虫', friend_help_exp_limit: '帮助经验限制', farm_push: '土地推送响应',
  land_upgrade: '土地升级', golden_bug_clear: '清理黄金虫', fertilizer_gift: '化肥道具填充',
  fertilizer_buy_organic: '购买有机化肥', fertilizer_buy_normal: '购买普通化肥', fertilizer: '施肥策略',
  skip_own_weed_bug: '跳过自家除草除虫', fertilizer_multi_season: '多季补肥', fertilizer_land_types: '施肥土地类型',
  mystery_shop_auto_buy: '神秘商人购买', mystery_shop_allow_gold: '商城金币消费',
  mystery_shop_allow_coupon: '商城点券消费', mystery_shop_allow_gold_bean: '商城金豆消费',
  milk_tea_auto_rewards: '奶茶自动领奖', milk_tea_auto_seeds: '奶茶种子补货',
  milk_tea_auto_work: '奶茶自动工作', milk_tea_auto_upgrade: '奶茶自动升级',
};

function snapshotAutomationConfig(config = {}) {
  return Object.fromEntries(Object.keys(CONTROL_LABELS).map(key => [key, JSON.stringify(config[key])]));
}

function logAutomationConfigChanges(previous, config = {}) {
  const changes = Object.entries(CONTROL_LABELS).flatMap(([key, label]) => {
    if (previous[key] === JSON.stringify(config[key])) return [];
    return [typeof config[key] === 'boolean' ? `${config[key] ? '开启' : '关闭'}${label}` : `调整${label}`];
  });
  if (!changes.length) return false;
  require('../utils/utils').log('系统', `自动控制配置已应用：${changes.join('；')}`, {
    module: 'system', event: 'automation_config', result: 'ok', logKind: 'status',
  });
  return true;
}

function actionFromLog(message, meta = {}) {
  const event = String(meta.event || '');
  const category = Object.hasOwn(ACTIONS, event) ? ACTIONS[event] : '';
  if (!category) return null;
  const expectedModule = category === 'shop' ? 'shop' : category === 'land' ? 'farm'
    : ['task', 'rewards'].includes(category) ? 'task'
      : category === 'fertilizer' ? (['购买化肥', '开启化肥礼包'].includes(event) ? 'warehouse' : 'farm') : category;
  if (meta.module !== expectedModule) return null;
  if (event === 'sell_done' ? meta.result !== 'unknown_gain'
    : event === '神秘商人自动购买' ? meta.result !== 'success'
      : event === 'milk_tea_operate' ? !(meta.result === 'ok' || (meta.action === 'interact' && meta.result === 'gameplay_lose'))
        : meta.result !== 'ok') return null;
  if (event === 'vip_daily_gift' && (!Array.isArray(meta.vipTypes) || !meta.vipTypes.length)) return null;
  if (event === '购买化肥' && meta.automationAction !== true) return null;
  if (['开启化肥礼包', '购买化肥', '施肥', '常规施肥', '多季节施肥', '放置黄金虫', '自动同意好友', 'email_rewards', 'mall_free_gifts', '领取活跃奖励', '神秘商人自动购买'].includes(event)
    && !(Number(meta.count) > 0)) return null;
  const friendActions = event === '照顾好友' ? meta.completedActions : meta.actions;
  if (['帮助好友', '照顾好友'].includes(event) && (!Array.isArray(friendActions) || !friendActions.length)) return null;
  if (event === '在线自动捣乱' && !((Number(meta.putBug) || 0) + (Number(meta.putWeed) || 0) > 0)) return null;
  if (event.startsWith('sell_') && !(Number(meta.soldCount) > 0)) return null;
  let summary = redactExternalText(String(message || '')).slice(0, 280);
  if (['帮助好友', '照顾好友'].includes(event)) {
    const labels = { 草: '除草', 虫: '除虫', 水: '浇水', 放虫: '放虫', 放草: '放草' };
    const actions = friendActions.flatMap(value => {
      const match = String(value).match(/^([草虫水]|放[虫草])(\d+)$/);
      return match && Number(match[2]) > 0 ? [`${labels[match[1]]} ${Number(match[2])} 次`] : [];
    });
    if (!actions.length) return null;
    summary = `已照顾好友：${actions.join('，')}`;
  }
  if (event === '在线自动捣乱') summary = `已对在线好友放虫 ${Number(meta.putBug) || 0} 次、放草 ${Number(meta.putWeed) || 0} 次`;
  if (event === '自动同意好友') summary = `已同意 ${Number(meta.count)} 个好友申请`;
  if (event === '放置黄金虫') summary = `已放置黄金虫 ${Number(meta.count)} 只`;
  if (event === 'sell_done') summary = `已提交出售 ${Number(meta.soldCount)} 个果实，金币收益尚未确认`;
  if (event === 'milk_tea_operate') {
    if (!Object.hasOwn(MILK_ACTIONS, meta.action)) return null;
    if (meta.action === 'hire' && !(Number(meta.successCount) > 0)) return null;
    summary = `奶茶：${MILK_ACTIONS[meta.action]}`;
    if (meta.action === 'hire') summary += `，成功 ${Number(meta.successCount)} 次`;
    if (meta.result === 'gameplay_lose') summary += '（本次玩法未生效）';
  }
  return { category, message: summary, level: 'info' };
}

function observeAutomationLog(accountId, tag, message, isWarn, meta = {}, record) {
  const action = actionFromLog(message, meta);
  const category = action?.category || (Object.hasOwn(CATEGORIES, meta.automationCategory) ? meta.automationCategory
    : Object.hasOwn(ACTIONS, meta.event) ? ACTIONS[meta.event] : '');
  const normalized = { ...meta };
  if (category) normalized.automationCategory = category;
  if (['mall', 'shop'].includes(normalized.module)) normalized.module = 'warehouse';
  if (action) {
    normalized.logKind = 'action';
    try { (record || require('./daily-events').recordAutomationEvent)(accountId, action.category, action.message, action.level); }
    catch { /* Keep the original runtime log even when the event sink fails. */ }
  }
  const displayTag = ['mall', 'shop'].includes(meta.module) ? '仓库' : tag;
  return { tag: displayTag, meta: normalized };
}

function logAutomationQuery(category, message) {
  if (!Object.hasOwn(CATEGORIES, category)) return false;
  const now = Date.now();
  const key = `${category}:${message}`;
  if (queryTimes.has(key) && now - queryTimes.get(key) < 60_000) return false;
  queryTimes.set(key, now);
  try {
    require('../utils/utils').log(CATEGORIES[category].label, message, {
      module: CATEGORIES[category].module, event: 'automation_query', result: 'read',
      automationCategory: category, logKind: 'query',
    });
    return true;
  } catch { return false; }
}

module.exports = { actionFromLog, observeAutomationLog, logAutomationQuery, snapshotAutomationConfig, logAutomationConfigChanges };
