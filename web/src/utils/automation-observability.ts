export const AUTOMATION_CATEGORY_LABELS: Record<string, string> = {
  farm: '农场',
  task: '任务',
  rewards: '日常奖励',
  warehouse: '出售',
  fertilizer: '化肥',
  land: '土地',
  shop: '商城',
  friend: '好友互动',
  activity: '活动',
  login: '登录维护',
  system: '系统',
}

export const AUTOMATION_LOG_EVENT_GROUPS = [
  { label: '自动控制：查询/检查', value: 'automation_query,扫描任务,扫描活跃奖励,milk_tea_refresh,milk_tea_auto_check' },
  { label: '自动控制：配置变化', value: 'automation_config' },
  { label: '自动控制：任务/奖励', value: '任务领奖中,任务领奖异常,领取任务,领取活跃奖励,图鉴奖励,email_rewards,daily_share,month_card_gift,mall_free_gifts,vip_daily_gift' },
  { label: '自动控制：化肥', value: '购买化肥,开启化肥礼包,施肥,常规施肥,多季节施肥' },
  { label: '自动控制：土地', value: '解锁土地,升级土地' },
  { label: '自动控制：出售', value: 'sell_success,sell_done,sell_failed,sell_empty' },
  { label: '自动控制：商城', value: '神秘商人自动购买,mall_free_gifts' },
  { label: '自动控制：好友互动', value: '帮助好友,照顾好友,在线自动捣乱,放置黄金虫,自动同意好友' },
  { label: '自动控制：奶茶', value: 'milk_tea_operate,milk_tea_auto_check' },
]

export function getDailyEventCategory(event: { type: string, category?: string }) {
  if (event.category && Object.keys(AUTOMATION_CATEGORY_LABELS).includes(event.category))
    return event.category
  if (['harvest', 'plant', 'farming', 'harvest_failed', 'plant_failed', 'farming_failed'].includes(event.type))
    return 'farm'
  if (['steal', 'friend_online'].includes(event.type))
    return 'friend'
  if (['kickout', 'reconnect_failed', 'code_refresh_failed', 'credential_keepalive_failed'].includes(event.type))
    return 'login'
  return 'system'
}
