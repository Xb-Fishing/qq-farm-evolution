<script setup lang="ts">
import { useIntervalFn } from '@vueuse/core'
import { storeToRefs } from 'pinia'
import { computed, nextTick, onMounted, reactive, ref, watch } from 'vue'
import api from '@/api'
import BaseButton from '@/components/ui/BaseButton.vue'
import BaseInput from '@/components/ui/BaseInput.vue'
import BaseSelect from '@/components/ui/BaseSelect.vue'
import { useAccountStore } from '@/stores/account'
import { useBagStore } from '@/stores/bag'
import { useStatusStore } from '@/stores/status'
import { useToastStore } from '@/stores/toast'
import { formatCouponAmount, formatGoldAmount, formatGoldBeanAmount } from '@/utils/number-format'

const statusStore = useStatusStore()
const accountStore = useAccountStore()
const bagStore = useBagStore()
const toastStore = useToastStore()

const {
  status,
  logs: statusLogs,
  accountLogs: statusAccountLogs,
  realtimeConnected,
  currentStatusReady,
} = storeToRefs(statusStore)
const { currentAccountId, currentAccount } = storeToRefs(accountStore)
const { dashboardItems } = storeToRefs(bagStore)

const logContainer = ref<HTMLElement | null>(null)
const autoScroll = ref(true)
const lastBagFetchAt = ref(0)
const clearingLogs = ref(false)

const filter = reactive({
  module: '',
  event: '',
  keyword: '',
  isWarn: '',
})

const hasActiveLogFilter = computed(() =>
  !!(filter.module || filter.event || filter.keyword || filter.isWarn),
)
const currentAccountDisconnected = computed(() =>
  currentStatusReady.value && !status.value?.connection?.connected,
)

const allLogs = computed(() => {
  const sLogs = statusLogs.value || []
  const aLogs = (statusAccountLogs.value || []).map((log: any) => ({
    ts: new Date(log.time).getTime(),
    time: log.time,
    tag: log.action === 'Error' ? '错误' : '系统',
    msg: log.reason ? `${log.msg} (${log.reason})` : log.msg,
    isAccountLog: true,
  }))

  // 新日志在上、旧日志在下
  return [...sLogs, ...aLogs]
    .sort((a: any, b: any) => b.ts - a.ts)
})

const modules = [
  { label: '全部模块', value: '' },
  { label: '农场', value: 'farm' },
  { label: '好友', value: 'friend' },
  { label: '仓库', value: 'warehouse' },
  { label: '任务', value: 'task' },
  { label: '活动', value: 'activity' },
  { label: '系统', value: 'system' },
]

// value 必须与后端日志 meta.event 一致；同一动作在不同代码路径有中英文两种事件名，
// 用逗号合并（后端按逗号拆分做 OR 匹配）
const events = [
  { label: '全部事件', value: '' },
  { label: '偷好友菜', value: '偷好友菜' },
  { label: '化肥趋势触发', value: '化肥趋势触发' },
  { label: '化肥盯梢冷却', value: '化肥盯梢冷却' },
  { label: '重点预布控', value: '重点预布控' },
  { label: '重点监控生效', value: '重点监控' },
  { label: '重点低频观察', value: '重点低频观察窗口,重点盯梢窗口' },
  { label: '照顾好友', value: '照顾好友' },
  { label: '帮助好友', value: '帮助好友' },
  { label: '进入农场', value: '进入农场' },
  { label: '好友巡查', value: '好友巡查循环' },
  { label: '偷菜巡查', value: '偷菜巡查' },
  { label: '农场巡查', value: '农场循环' },
  { label: '土地提醒', value: '土地推送通知' },
  { label: '收获作物', value: '收获作物' },
  { label: '清理枯枝', value: '铲除植物' },
  { label: '种植种子', value: '种植种子' },
  { label: '选择种子', value: '选择种子' },
  { label: '施加化肥', value: '施肥,fertilize' },
  { label: '催熟', value: '催熟' },
  { label: '购买种子', value: '购买种子' },
  { label: '购买化肥', value: '购买化肥,fertilizer_buy' },
  { label: '开启礼盒', value: '开启化肥礼包,fertilizer_gift_open' },
  { label: '升级土地', value: '升级土地' },
  { label: '解锁土地', value: '解锁土地' },
  { label: '获取任务', value: '扫描任务' },
  { label: '完成任务', value: '领取任务,task_claim' },
  { label: '免费礼包', value: 'mall_free_gifts' },
  { label: '分享奖励', value: 'daily_share' },
  { label: '会员礼包', value: 'vip_daily_gift' },
  { label: '月卡礼包', value: 'month_card_gift' },
  { label: '邮箱领取', value: 'email_rewards' },
  { label: '图鉴奖励', value: '图鉴奖励' },
  { label: '同气礼包', value: '同气连枝礼包' },
  { label: '收获后出售', value: '收获后出售' },
  { label: '偷菜后出售', value: '偷菜后出售' },
  { label: '出售成功', value: 'sell_success,sell_done' },
]

const logLevels = [
  { label: '全部级别', value: '' },
  { label: '普通', value: 'info' },
  { label: '警告', value: 'warn' },
]

const eventLabelMap: Record<string, string> = Object.fromEntries(
  events
    .filter(event => event.value)
    .flatMap(event => event.value.split(',').map(v => [v.trim(), event.label])),
)

const displayName = computed(() => {
  const account = accountStore.currentAccount
  const gameName = status.value?.status?.name

  if (gameName) {
    if (account?.name)
      return `${gameName} (${account.name})`
    return gameName
  }

  if (currentAccountDisconnected.value) {
    if (account) {
      if (account.name && account.nick)
        return `${account.nick} (${account.name})`
      return account.name || account.nick || '未登录'
    }
    return '未登录'
  }

  if (account) {
    if (account.name && account.nick)
      return `${account.nick} (${account.name})`
    return account.name || account.nick || '未命名'
  }

  return '未命名'
})

const expRate = computed(() => {
  const gain = status.value?.sessionExpGained || 0
  const uptime = status.value?.uptime || 0
  if (!uptime)
    return '0/小时'
  const rate = gain / (uptime / 3600)
  return `${Math.floor(rate)}/小时`
})

const timeToLevel = computed(() => {
  const gain = status.value?.sessionExpGained || 0
  const uptime = status.value?.uptime || 0
  const current = status.value?.levelProgress?.current || 0
  const needed = status.value?.levelProgress?.needed || 0

  if (!needed || !uptime || gain <= 0)
    return ''

  const ratePerHour = gain / (uptime / 3600)
  if (ratePerHour <= 0)
    return ''

  const expNeeded = Math.max(0, needed - current)
  const minsToLevel = expNeeded / (ratePerHour / 60)

  if (minsToLevel < 60)
    return `约 ${Math.ceil(minsToLevel)} 分钟后升级`
  return `约 ${(minsToLevel / 60).toFixed(1)} 小时后升级`
})

const fertilizerNormal = computed(() => dashboardItems.value.find((item: any) => Number(item.id) === 1011))
const fertilizerOrganic = computed(() => dashboardItems.value.find((item: any) => Number(item.id) === 1012))
const collectionNormal = computed(() => dashboardItems.value.find((item: any) => Number(item.id) === 3001))
const collectionRare = computed(() => dashboardItems.value.find((item: any) => Number(item.id) === 3002))

const nextFarmCheck = ref('--:--:--')
const nextHelpCheck = ref('--:--:--')
const nextStealCheck = ref('--:--:--')
const nextStealKnown = ref('')
const localUptime = ref(0)

let localNextFarmRemainSec = 0
let localNextHelpRemainSec = 0
let localNextStealKnownRemainSec = 0
const helpExpCapped = ref(false)
const slowdownActive = ref(false)
const slowdownRemainSec = ref(0)
const slowdownDelaySec = ref(0)
const slowdownClearing = ref(false)
const stealPending = ref(false)
const stealTimePartial = ref(false)

interface WatchlistRipe {
  gid: number
  name: string
  ripeAt: number
  remainSec: number
  inWindow: boolean
  matured?: boolean
}
const watchlistRipe = ref<WatchlistRipe[]>([])
let watchlistTicker = 0
// 盯梢窗口分钟数（重点好友可配，默认 122）；inWindow 判断用它而不是写死
const watchlistWindowMinutes = ref(122)

// 服务端快照按 30s 推一次，这里本地每秒衰减 remainSec 保持平滑
watch(watchlistRipe, () => {
  clearInterval(watchlistTicker)
  watchlistTicker = window.setInterval(() => {
    for (const item of watchlistRipe.value) {
      if (item.remainSec > 0) {
        item.remainSec--
        item.inWindow = item.remainSec <= watchlistWindowMinutes.value * 60
        if (item.remainSec <= 0)
          item.matured = true
      }
    }
  }, 1000)
})

async function clearSlowdown() {
  if (!currentAccountId.value || slowdownClearing.value)
    return
  slowdownClearing.value = true
  try {
    const { data } = await api.post('/api/breaker/clear', {}, {
      headers: { 'x-account-id': currentAccountId.value },
    })
    if (data?.ok) {
      if (data.data?.cleared) {
        toastStore.success('异常降速已取消，恢复正常巡查节奏')
        slowdownActive.value = false
      }
      else {
        toastStore.info('当前没有生效中的异常降速')
      }
    }
  }
  catch (err: any) {
    toastStore.warning(err?.response?.data?.error || err.message || '取消失败')
  }
  finally {
    slowdownClearing.value = false
  }
}
let localNextStealRemainSec = 0

function resetDashboardState() {
  lastBagFetchAt.value = 0
  localUptime.value = 0
  localNextFarmRemainSec = 0
  localNextHelpRemainSec = 0
  localNextStealRemainSec = 0
  localNextStealKnownRemainSec = 0
  stealPending.value = false
  stealTimePartial.value = false
  helpExpCapped.value = false
  slowdownActive.value = false
  slowdownRemainSec.value = 0
  slowdownDelaySec.value = 0
  watchlistRipe.value = []
  nextFarmCheck.value = '--:--:--'
  nextHelpCheck.value = '--:--:--'
  nextStealCheck.value = '--:--:--'
  nextStealKnown.value = ''
}

const OP_META: Record<string, { label: string, icon: string, color: string }> = {
  harvest: { label: '收获', icon: 'i-carbon-crop-growth', color: 'text-green-500' },
  water: { label: '浇水', icon: 'i-carbon-rain-drop', color: 'text-blue-400' },
  weed: { label: '除草', icon: 'i-carbon-cut', color: 'text-yellow-500' },
  bug: { label: '除虫', icon: 'i-carbon-pest', color: 'text-red-400' },
  farming: { label: '一键务农', icon: 'i-carbon-clean', color: 'text-teal-500' },
  fertilize: { label: '施肥', icon: 'i-carbon-chemistry', color: 'text-emerald-500' },
  plant: { label: '种植', icon: 'i-carbon-tree', color: 'text-lime-500' },
  remove: { label: '铲除', icon: 'i-carbon-trash-can', color: 'text-stone-500' },
  steal: { label: '偷菜', icon: 'i-carbon-run', color: 'text-orange-500' },
  helpWater: { label: '帮浇水', icon: 'i-carbon-rain-drop', color: 'text-blue-300' },
  goldenBugClear: { label: '清黄金虫', icon: 'i-carbon-clean', color: 'text-amber-500' },
  goldenBugPut: { label: '放黄金虫', icon: 'i-carbon-pest', color: 'text-yellow-500' },
  helpWeed: { label: '帮除草', icon: 'i-carbon-cut', color: 'text-yellow-400' },
  helpBug: { label: '帮除虫', icon: 'i-carbon-pest', color: 'text-red-300' },
  taskClaim: { label: '任务', icon: 'i-carbon-task-complete', color: 'text-indigo-500' },
  sell: { label: '出售', icon: 'i-carbon-shopping-cart', color: 'text-pink-500' },
  tongQiGift: { label: '同气礼包', icon: 'i-carbon-gift', color: 'text-rose-500' },
}

const filteredOperations = computed(() => {
  const operations = status.value?.operations || {}
  const result: Record<string, number> = {}

  for (const key of Object.keys(operations)) {
    if (key !== 'upgrade' && key !== 'levelUp')
      result[key] = operations[key]
  }

  return result
})

function getEventLabel(event: string) {
  return eventLabelMap[event] || event
}

function formatBucketTime(item: any) {
  if (!item)
    return '0.0h'
  if (item.hoursText)
    return item.hoursText.replace('小时', 'h')
  return `${(Number(item.count || 0) / 3600).toFixed(1)}h`
}

function updateCountdowns() {
  if (currentAccountDisconnected.value) {
    nextFarmCheck.value = '账号未登录'
    nextHelpCheck.value = '账号未登录'
    nextStealCheck.value = '账号未登录'
    return
  }

  localUptime.value++

  if (slowdownActive.value && slowdownRemainSec.value > 0) {
    slowdownRemainSec.value--
    if (slowdownRemainSec.value <= 0)
      slowdownActive.value = false
  }

  if (localNextFarmRemainSec > 0) {
    localNextFarmRemainSec--
    nextFarmCheck.value = formatDuration(localNextFarmRemainSec)
  }
  else {
    nextFarmCheck.value = '检查中...'
  }

  if (localNextHelpRemainSec > 0) {
    localNextHelpRemainSec--
    nextHelpCheck.value = formatDuration(localNextHelpRemainSec)
  }
  else {
    nextHelpCheck.value = '检查中...'
  }

  if (stealPending.value && localNextStealRemainSec > 0) {
    localNextStealRemainSec--
    nextStealCheck.value = `抢收重试 ${formatDuration(localNextStealRemainSec)}`
  }
  else if (stealPending.value) {
    nextStealCheck.value = '正在抢收...'
  }
  else if (localNextStealRemainSec > 0) {
    localNextStealRemainSec--
    nextStealCheck.value = formatDuration(localNextStealRemainSec)
  }
  else {
    nextStealCheck.value = '检查中...'
  }

  if (localNextStealKnownRemainSec > 0)
    localNextStealKnownRemainSec--

  const knownIsScheduledCheck = localNextStealRemainSec > 0
    && Math.abs(localNextStealKnownRemainSec - localNextStealRemainSec) <= 2
  if (!stealPending.value && localNextStealKnownRemainSec > 0 && !knownIsScheduledCheck) {
    nextStealKnown.value = `全局已知最早成熟 ${formatDuration(localNextStealKnownRemainSec)}`
  }
  else if (!stealPending.value && stealTimePartial.value) {
    nextStealKnown.value = '部分好友成熟时刻不可见'
  }
  else {
    nextStealKnown.value = ''
  }
}

watch(status, (newVal) => {
  if (newVal?.nextChecks) {
    localNextFarmRemainSec = newVal.nextChecks.farmRemainSec || 0
    localNextHelpRemainSec = newVal.nextChecks.helpRemainSec || 0
    stealPending.value = newVal.nextChecks.stealPending === true
    // 微信好友摘要对部分普通好友不下发成熟时刻；已知地块
    // 快照仍取最小值，但面板不能把它冒充成全好友完整答案。
    stealTimePartial.value = String((newVal as any).status?.platform || '').toLowerCase() === 'wx'
    localNextStealRemainSec = stealPending.value
      ? (newVal.nextChecks.stealRetryRemainSec || 0)
      : (newVal.nextChecks.stealRemainSec || 0)
    localNextStealKnownRemainSec = newVal.nextChecks.stealKnownRemainSec || 0
    helpExpCapped.value = newVal.nextChecks.helpExpCapped === true
    slowdownActive.value = newVal.slowdown?.active === true
    slowdownRemainSec.value = newVal.slowdown?.remainSec || 0
    slowdownDelaySec.value = newVal.slowdown?.recommendedDelaySec || 0
    const wakeMin = Number((newVal as any).watchlistWakeBeforeMinutes)
    if (wakeMin > 0)
      watchlistWindowMinutes.value = wakeMin
    if (Array.isArray(newVal.watchlistRipe))
      watchlistRipe.value = newVal.watchlistRipe
    updateCountdowns()
  }

  if (newVal?.uptime !== undefined)
    localUptime.value = newVal.uptime
}, { deep: true })

function formatDuration(seconds: number) {
  if (seconds <= 0)
    return '00:00:00'

  const days = Math.floor(seconds / 86400)
  const hours = Math.floor((seconds % 86400) / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const remainSeconds = Math.floor(seconds % 60)
  const pad = (value: number) => value.toString().padStart(2, '0')

  if (days > 0)
    return `${days}天 ${pad(hours)}:${pad(minutes)}:${pad(remainSeconds)}`
  return `${pad(hours)}:${pad(minutes)}:${pad(remainSeconds)}`
}

function getLogTagClass(tag: string) {
  if (tag === '错误')
    return 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300'
  if (tag === '系统')
    return 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300'
  if (tag === '活动')
    return 'bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-300'
  if (tag === '警告')
    return 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-300'
  return 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300'
}

function getLogMsgClass(tag: string) {
  if (tag === '错误')
    return 'text-red-600 dark:text-red-400'
  return 'text-gray-700 dark:text-gray-300'
}

function formatLogTime(timeStr: string) {
  if (!timeStr)
    return ''
  const parts = timeStr.split(' ')
  return parts.length > 1 ? parts[1] : timeStr
}

function getOpName(key: string | number) {
  return OP_META[String(key)]?.label || String(key)
}

function getOpIcon(key: string | number) {
  return OP_META[String(key)]?.icon || 'i-carbon-circle-dash'
}

function getOpColor(key: string | number) {
  return OP_META[String(key)]?.color || 'text-gray-400'
}

function getExpPercent(progress: any) {
  if (!progress || !progress.needed)
    return 0
  return Math.min(100, Math.max(0, (progress.current / progress.needed) * 100))
}

interface DailyEvent {
  at: number
  level: 'info' | 'warn' | 'error'
  type: string
  message: string
  count?: number
}

const dailyEvents = ref<DailyEvent[]>([])
let dailyEventsRequestId = 0

async function fetchDailyEvents() {
  if (!currentAccountId.value || !currentAccount.value?.running)
    return
  const requestedId = String(currentAccountId.value)
  const requestId = ++dailyEventsRequestId
  try {
    const { data } = await api.get('/api/daily-events', { headers: { 'x-account-id': requestedId } })
    if (requestId === dailyEventsRequestId && String(currentAccountId.value) === requestedId && data?.ok)
      dailyEvents.value = data.data?.events || []
  }
  catch { /* 事件日志拉取失败不影响面板 */ }
}

const EVENT_LEVEL_STYLE: Record<string, string> = {
  info: 'text-gray-600 dark:text-gray-300',
  warn: 'text-amber-600 dark:text-amber-400',
  error: 'text-red-600 dark:text-red-400',
}
const EVENT_TYPE_LABELS: Record<string, string> = {
  harvest: '收菜',
  plant: '播种',
  steal: '偷菜',
  farming: '务农',
  kickout: '被踢',
  breaker: '熔断',
  slowdown: '安全降速',
  harvest_failed: '收菜异常',
  plant_failed: '播种异常',
  farming_failed: '务农异常',
}

function formatEventTime(ts: number) {
  const d = new Date(ts)
  const pad = (v: number) => String(v).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

async function refreshBag(force = false) {
  if (!currentAccountId.value || !currentAccount.value?.running || !currentStatusReady.value || !status.value?.connection?.connected)
    return
  const now = Date.now()
  if (!force && now - lastBagFetchAt.value < 2500)
    return

  lastBagFetchAt.value = now
  await bagStore.fetchBag(currentAccountId.value)
}

async function refresh(forceReloadLogs = false) {
  if (!currentAccountId.value)
    return

  const account = currentAccount.value
  if (!account)
    return

  // 首次加载、断线回退时走 HTTP；实时连接正常时优先依赖 WS 推送。
  if (!realtimeConnected.value) {
    await statusStore.fetchStatus(currentAccountId.value)
    await statusStore.fetchAccountLogs(currentAccountId.value)
  }

  if (forceReloadLogs || hasActiveLogFilter.value || !realtimeConnected.value) {
    await statusStore.fetchLogs(currentAccountId.value, {
      module: filter.module || undefined,
      event: filter.event || undefined,
      keyword: filter.keyword || undefined,
      isWarn: filter.isWarn === 'warn' ? true : filter.isWarn === 'info' ? false : undefined,
    })
  }

  // 仅在账号运行且连接稳定后再拉背包，避免启动阶段出现 500。
  await refreshBag()
  await fetchDailyEvents()
}

function syncRealtimeAccount() {
  if (currentAccountId.value)
    statusStore.connectRealtime(currentAccountId.value)
}

function onLogFilterChange() {
  refresh(true)
}

function onLogSearchTrigger() {
  refresh(true)
}

watch(currentAccountId, async (newId, oldId) => {
  if (oldId !== undefined && newId !== oldId) {
    statusStore.clearAccountScopedData()
    bagStore.clearBag()
    resetDashboardState()
  }
  syncRealtimeAccount()
  await refresh(true)
  scrollToNewest()
})

watch(() => status.value?.connection?.connected, (connected) => {
  if (connected)
    refreshBag(true)
})

watch(() => JSON.stringify(status.value?.operations || {}), (next, prev) => {
  if (!realtimeConnected.value || next === prev)
    return
  refreshBag()
})

watch(hasActiveLogFilter, (enabled) => {
  statusStore.setRealtimeLogsEnabled(!enabled)
  refresh()
})

function onLogScroll(event: Event) {
  const element = event.target as HTMLElement
  if (!element)
    return
  // 新日志在顶部：停留在顶部附近才自动跟随
  autoScroll.value = element.scrollTop < 50
}

async function clearLogs() {
  if (!currentAccountId.value)
    return

  clearingLogs.value = true
  try {
    const { data } = await api.delete('/api/logs')
    if (data?.ok) {
      toastStore.success('日志已清空')
      await refresh(true)
    }
    else {
      toastStore.error(`清空失败: ${data?.error || '未知错误'}`)
    }
  }
  catch (error: any) {
    const message = error?.response?.data?.error || error?.message || '请求失败'
    toastStore.error(`清空失败: ${message}`)
  }
  finally {
    clearingLogs.value = false
  }
}

watch(allLogs, () => {
  nextTick(() => {
    if (logContainer.value && autoScroll.value)
      logContainer.value.scrollTop = 0
  })
}, { deep: true })

function scrollToNewest() {
  nextTick(() => {
    if (logContainer.value)
      logContainer.value.scrollTop = 0
  })
}

onMounted(async () => {
  statusStore.setRealtimeLogsEnabled(!hasActiveLogFilter.value)
  syncRealtimeAccount()
  await refresh()
  scrollToNewest()
})

// Auto refresh fallback every 10s (WS 断开或启用筛选时回退 HTTP)
useIntervalFn(refresh, 10000)
// Countdown timer (every 1s)
useIntervalFn(updateCountdowns, 1000)
</script>

<template>
  <div class="flex flex-col gap-5 pt-1 md:pt-2">
    <div
      v-if="slowdownActive"
      class="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 dark:border-amber-700 dark:bg-amber-900/20"
    >
      <div class="flex items-center gap-2 text-sm text-amber-800 dark:text-amber-200">
        <div class="i-carbon-warning-alt text-lg" />
        <span>
          请求异常降速中：普通巡查放缓到约 {{ slowdownDelaySec }} 秒级，自己收获、成熟抢收和施肥 HOT 保持运行；约
          <span class="font-mono font-bold">{{ formatDuration(slowdownRemainSec) }}</span>
          后恢复常规节奏
        </span>
      </div>
      <button
        class="rounded bg-amber-500 px-3 py-1.5 text-xs text-white transition hover:bg-amber-600 disabled:opacity-50"
        :disabled="slowdownClearing"
        @click="clearSlowdown"
      >
        {{ slowdownClearing ? '取消中…' : '取消降速' }}
      </button>
    </div>
    <div class="grid grid-cols-1 gap-4 lg:grid-cols-3 sm:grid-cols-2">
      <div class="ui-card metric-card min-h-[168px] flex flex-col rounded-lg p-5">
        <div class="mb-2 flex items-start justify-between">
          <div class="flex items-center gap-1.5 text-sm text-gray-500">
            <div class="i-fas-user-circle" />
            账号
          </div>
          <div class="rounded-lg bg-blue-100 px-2 py-0.5 text-xs text-blue-700 dark:bg-blue-900/30 dark:text-blue-300">
            Lv.{{ status?.status?.level || 0 }}
          </div>
        </div>
        <div class="mb-1 truncate text-xl font-bold" :title="displayName">
          {{ displayName }}
        </div>
        <div class="mt-auto">
          <div class="mb-1 flex justify-between text-xs text-gray-500">
            <div class="flex items-center gap-1">
              <div class="i-fas-bolt text-blue-400" />
              <span>EXP</span>
            </div>
            <span>{{ status?.levelProgress?.current || 0 }} / {{ status?.levelProgress?.needed || '?' }}</span>
          </div>
          <div class="h-2 w-full overflow-hidden rounded-full bg-gray-100 dark:bg-gray-700">
            <div
              class="h-full rounded-full bg-blue-500 transition-all duration-500"
              :style="{ width: `${getExpPercent(status?.levelProgress)}%` }"
            />
          </div>
          <div class="mt-2 flex justify-between text-xs text-gray-400">
            <span>效率: {{ expRate }}</span>
            <span>{{ timeToLevel }}</span>
          </div>
        </div>
      </div>

      <div class="ui-card metric-card min-h-[168px] flex flex-col justify-between rounded-lg p-5">
        <div class="grid grid-cols-4 gap-3">
          <div class="min-w-0">
            <div class="flex items-center gap-1.5 text-xs text-gray-500">
              <div class="i-fas-coins text-yellow-500" />
              金币
            </div>
            <div class="text-2xl text-yellow-600 font-bold dark:text-yellow-500">
              {{ formatGoldAmount(status?.status?.gold || 0) }}
            </div>
            <div
              v-if="(status?.sessionGoldGained || 0) !== 0"
              class="text-[10px]"
              :class="(status?.sessionGoldGained || 0) > 0 ? 'text-green-500' : 'text-red-500'"
            >
              {{ (status?.sessionGoldGained || 0) > 0 ? '+' : '' }}{{ formatGoldAmount(status?.sessionGoldGained || 0) }}
            </div>
          </div>
          <div class="min-w-0 text-center">
            <div class="flex items-center justify-center gap-1.5 text-xs text-gray-500">
              <div class="i-fas-ticket-alt text-emerald-400" />
              点券
            </div>
            <div class="text-2xl text-emerald-500 font-bold dark:text-emerald-400">
              {{ formatCouponAmount(status?.status?.coupon || 0) }}
            </div>
            <div
              v-if="(status?.sessionCouponGained || 0) !== 0"
              class="text-[10px]"
              :class="(status?.sessionCouponGained || 0) > 0 ? 'text-green-500' : 'text-red-500'"
            >
              {{ (status?.sessionCouponGained || 0) > 0 ? '+' : '' }}{{ formatCouponAmount(status?.sessionCouponGained || 0) }}
            </div>
          </div>
          <div class="min-w-0 text-center">
            <div class="flex items-center justify-center gap-1.5 text-xs text-gray-500">
              <div class="i-carbon-diamond-outline text-cyan-500" />
              钻石
            </div>
            <div class="text-2xl text-cyan-600 font-bold dark:text-cyan-400">
              {{ formatCouponAmount(status?.status?.diamond || 0) }}
            </div>
          </div>
          <div class="min-w-0 text-right">
            <div class="flex items-center justify-end gap-1.5 text-xs text-gray-500">
              <div class="i-carbon-circle text-amber-500" />
              金豆
            </div>
            <div class="text-2xl text-amber-500 font-bold dark:text-amber-400">
              {{ formatGoldBeanAmount(status?.status?.goldBean || 0) }}
            </div>
          </div>
        </div>
        <div class="mt-4 border-t border-gray-100/80 pt-3 dark:border-gray-700/80">
          <div class="flex items-center justify-between">
            <div class="flex items-center gap-2">
              <div class="h-2.5 w-2.5 rounded-full" :class="status?.connection?.connected ? 'bg-green-500' : currentStatusReady ? 'bg-red-500' : 'bg-gray-300'" />
              <span class="text-xs font-bold">{{ status?.connection?.connected ? '在线' : currentStatusReady ? '离线' : '检查中' }}</span>
            </div>
            <div class="flex items-center gap-1.5 text-xs text-gray-400">
              <div class="i-fas-clock text-purple-400" />
              {{ formatDuration(localUptime) }}
            </div>
          </div>
        </div>
      </div>

      <div class="ui-card metric-card min-h-[168px] flex flex-col justify-between rounded-lg p-5">
        <div class="mb-2 flex items-center gap-1.5 text-sm text-gray-500">
          <div class="i-fas-flask text-emerald-400" />
          化肥容器
        </div>
        <div class="grid grid-cols-2 gap-2">
          <div>
            <div class="flex items-center gap-1 text-xs text-gray-400">
              <div class="i-fas-flask text-emerald-400" />
              普通
            </div>
            <div class="font-bold">
              {{ formatBucketTime(fertilizerNormal) }}
            </div>
          </div>
          <div>
            <div class="flex items-center gap-1 text-xs text-gray-400">
              <div class="i-fas-vial text-emerald-400" />
              有机
            </div>
            <div class="font-bold">
              {{ formatBucketTime(fertilizerOrganic) }}
            </div>
          </div>
        </div>
        <div class="my-3 border-t border-gray-100/80 dark:border-gray-700/80" />
        <div class="mb-1 flex items-center gap-1.5 text-sm text-gray-500">
          <div class="i-fas-star text-emerald-400" />
          收藏点
        </div>
        <div class="grid grid-cols-2 gap-2">
          <div>
            <div class="flex items-center gap-1 text-xs text-gray-400">
              <div class="i-fas-bookmark text-emerald-400" />
              普通
            </div>
            <div class="font-bold">
              {{ collectionNormal?.count || 0 }}
            </div>
          </div>
          <div>
            <div class="flex items-center gap-1 text-xs text-gray-400">
              <div class="i-fas-gem text-emerald-400" />
              典藏
            </div>
            <div class="font-bold">
              {{ collectionRare?.count || 0 }}
            </div>
          </div>
        </div>
      </div>
    </div>

    <div class="flex flex-1 flex-col items-stretch gap-5 md:flex-row">
      <div class="flex flex-1 flex-col gap-5 md:w-3/4">
        <div class="ui-card-elevated flex flex-1 flex-col rounded-lg p-5 md:overflow-hidden">
          <div class="mb-4 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <h3 class="flex items-center gap-2 text-lg font-medium">
              <div class="i-carbon-document" />
              <span>运行日志</span>
            </h3>

            <div class="flex flex-wrap items-center gap-2 text-sm">
              <BaseSelect
                v-model="filter.module"
                :options="modules"
                class="w-32"
                @change="onLogFilterChange"
              />

              <BaseSelect
                v-model="filter.event"
                :options="events"
                class="w-32"
                @change="onLogFilterChange"
              />

              <BaseSelect
                v-model="filter.isWarn"
                :options="logLevels"
                class="w-32"
                @change="onLogFilterChange"
              />

              <BaseInput
                v-model="filter.keyword"
                placeholder="关键词..."
                class="w-32"
                clearable
                @keyup.enter="onLogSearchTrigger"
                @clear="onLogSearchTrigger"
              />

              <BaseButton
                variant="primary"
                size="sm"
                @click="onLogSearchTrigger"
              >
                <div class="i-carbon-search" />
              </BaseButton>

              <BaseButton
                variant="secondary"
                size="sm"
                :loading="clearingLogs"
                @click="clearLogs"
              >
                <div class="i-carbon-trash-can mr-1" />
                清空
              </BaseButton>
            </div>
          </div>

          <div ref="logContainer" class="ui-subtle-panel max-h-[50vh] min-h-0 flex-1 overflow-y-auto rounded-lg p-4 text-sm leading-relaxed font-mono" @scroll="onLogScroll">
            <div v-if="!allLogs.length" class="py-8 text-center text-gray-400">
              <div class="i-carbon-document-blank mx-auto mb-3 text-3xl text-gray-300" />
              <div class="text-sm text-gray-500 dark:text-gray-400">
                暂无日志
              </div>
              <div class="mt-1 text-xs text-gray-400">
                运行账号后，这里会持续追加巡查、种植、任务和出售记录。
              </div>
            </div>
            <div v-for="log in allLogs" :key="log.ts + log.msg" class="mb-1 break-all">
              <span class="mr-2 select-none text-gray-400">[{{ formatLogTime(log.time) }}]</span>
              <span class="mr-2 rounded px-1.5 py-0.5 text-xs font-bold" :class="getLogTagClass(log.tag)">{{ log.tag }}</span>
              <span v-if="log.meta?.event" class="mr-2 rounded bg-blue-50 px-1.5 py-0.5 text-xs text-blue-500 dark:bg-blue-900/20 dark:text-blue-400">{{ getEventLabel(log.meta.event) }}</span>
              <span :class="getLogMsgClass(log.tag)">{{ log.msg }}</span>
            </div>
          </div>
        </div>
      </div>

      <div class="flex flex-col gap-5 md:w-1/4">
        <div class="ui-card flex flex-col rounded-lg p-5">
          <h3 class="mb-4 flex items-center gap-2 text-lg font-medium">
            <div class="i-carbon-hourglass" />
            <span>下次检查倒计时</span>
          </h3>
          <div class="flex flex-col justify-center gap-4">
            <div class="flex items-center justify-between">
              <div class="flex items-center gap-2 text-gray-700 dark:text-gray-300">
                <div class="i-carbon-sprout text-lg text-green-500" />
                <span>农场</span>
              </div>
              <div class="text-lg font-bold font-mono">
                {{ nextFarmCheck }}
              </div>
            </div>
            <div class="flex items-center justify-between">
              <div class="flex items-center gap-2 text-gray-700 dark:text-gray-300">
                <div class="i-carbon-user-multiple text-lg text-blue-500" />
                <span>帮助</span>
                <span
                  v-if="helpExpCapped"
                  class="rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-700 dark:bg-amber-900/30 dark:text-amber-300"
                  title="今日帮助经验已达上限，帮忙全停，跨日（北京时间 0 点）自动恢复"
                >经验上限</span>
              </div>
              <div class="text-lg font-bold font-mono" :class="helpExpCapped ? 'text-amber-500' : ''">
                {{ nextHelpCheck }}
              </div>
            </div>
            <div class="flex items-center justify-between">
              <div class="flex items-center gap-2 text-gray-700 dark:text-gray-300">
                <div class="i-carbon-run text-lg text-orange-500" />
                <span>偷菜</span>
              </div>
              <div class="flex flex-col items-end">
                <div class="text-lg font-bold font-mono">
                  {{ nextStealCheck }}
                </div>
                <div
                  v-if="nextStealKnown"
                  class="max-w-36 text-right text-[11px] text-gray-400"
                  title="这是所有已获取好友中的最早成熟墙钟，不代表刚刚偷取的好友，也不是下次检查时间"
                >
                  {{ nextStealKnown }}
                </div>
              </div>
            </div>
          </div>
        </div>

        <div class="ui-card flex-1 rounded-lg p-5">
          <h3 class="mb-3 flex items-center gap-2 text-lg font-medium">
            <div class="i-carbon-chart-column" />
            <span>今日统计</span>
          </h3>
          <div v-if="currentAccountDisconnected" class="ui-subtle-panel flex flex-col items-center justify-center gap-4 rounded-lg p-10 text-center text-gray-500">
            <div class="i-carbon-connection-signal-off text-4xl text-gray-400" />
            <div class="flex flex-col">
              <div class="text-lg text-gray-700 font-medium dark:text-gray-300">
                账号未登录
              </div>
              <div class="mt-1 text-sm text-gray-400">
                请先运行账号或检查网络连接。
              </div>
            </div>
          </div>
          <div v-else-if="!Object.keys(filteredOperations).length" class="ui-subtle-panel flex flex-col items-center justify-center gap-3 rounded-lg p-8 text-center">
            <div class="i-carbon-chart-column text-3xl text-gray-300" />
            <div class="text-sm text-gray-600 font-medium dark:text-gray-300">
              暂无主动作统计
            </div>
            <div class="text-xs text-gray-400">
              通常是刚启动、刚切换账号，或本轮巡查尚未完成。
            </div>
          </div>
          <div v-else class="grid grid-cols-2 gap-2 2xl:gap-3">
            <div
              v-for="(val, key) in filteredOperations"
              :key="key"
              class="ui-subtle-panel flex items-center justify-between rounded-lg px-3 py-2"
            >
              <div class="flex items-center gap-2">
                <div class="text-base 2xl:text-lg" :class="[getOpIcon(key), getOpColor(key)]" />
                <div class="text-xs text-gray-500 2xl:text-sm">
                  {{ getOpName(key) }}
                </div>
              </div>
              <div class="text-sm font-bold 2xl:text-base">
                {{ val }}
              </div>
            </div>
          </div>
        </div>
      </div>

      <div v-if="watchlistRipe.length" class="ui-card rounded-lg p-5">
        <h3 class="mb-3 flex items-center gap-2 text-lg font-medium">
          <div class="i-carbon-star-filled text-yellow-500" />
          <span>重点监控</span>
          <span class="ml-auto text-xs font-normal text-gray-400">常态低频；确认施肥后自动进入 HOT</span>
        </h3>
        <div class="space-y-1.5">
          <div
            v-for="item in watchlistRipe"
            :key="item.gid"
            class="ui-subtle-panel flex items-center justify-between rounded-lg px-3 py-2"
          >
            <div class="flex min-w-0 items-center gap-2">
              <span class="truncate text-sm text-gray-700 dark:text-gray-200">{{ item.name }}</span>
              <span
                v-if="item.inWindow"
                class="shrink-0 rounded bg-emerald-100 px-1.5 py-0.5 text-xs text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300"
                :title="`已进入 ${watchlistWindowMinutes} 分钟成熟观察窗口；仅确认施肥后切换 HOT 并放宽门限`"
              >成熟观察</span>
            </div>
            <div class="font-mono text-sm font-bold" :class="item.inWindow ? 'text-emerald-500' : 'text-gray-500'">
              {{ item.remainSec > 0 ? formatDuration(item.remainSec) : '已成熟，抢收中' }}
            </div>
          </div>
        </div>
      </div>

      <div class="ui-card rounded-lg p-5">
        <h3 class="mb-3 flex items-center gap-2 text-lg font-medium">
          <div class="i-carbon-list-checked" />
          <span>今日事件</span>
          <span class="ml-auto text-xs font-normal text-gray-400">仅保留当天</span>
        </h3>
        <div v-if="!dailyEvents.length" class="ui-subtle-panel rounded-lg p-6 text-center text-sm text-gray-400">
          今天还没有记录到事件
        </div>
        <div v-else class="max-h-80 space-y-1.5 overflow-y-auto pr-1">
          <div
            v-for="ev in [...dailyEvents].reverse()"
            :key="`${ev.at}-${ev.type}`"
            class="ui-subtle-panel flex items-start gap-2 rounded-lg px-3 py-1.5"
          >
            <span class="shrink-0 font-mono text-xs text-gray-400">{{ formatEventTime(ev.at) }}</span>
            <span
              v-if="EVENT_TYPE_LABELS[ev.type] || ev.level !== 'info'"
              class="shrink-0 rounded px-1.5 py-0.5 text-xs"
              :class="ev.level === 'error' ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300' : ev.level === 'warn' ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300' : 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300'"
            >{{ EVENT_TYPE_LABELS[ev.type] || ev.type }}</span>
            <span class="min-w-0 flex-1 break-all text-xs" :class="EVENT_LEVEL_STYLE[ev.level] || EVENT_LEVEL_STYLE.info">
              {{ ev.message }}<span v-if="ev.count && ev.count > 1" class="ml-1 text-gray-400">×{{ ev.count }}</span>
            </span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
