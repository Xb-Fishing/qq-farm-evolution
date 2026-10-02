<script setup lang="ts">
import { useIntervalFn } from '@vueuse/core'
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import api from '@/api'
import BaseButton from '@/components/ui/BaseButton.vue'

interface HelpPendingSession {
  sessionId: string
  createdAt: number
  expiresAt: number
  localTtlMs: number
  state: string
  detail: string
  qrBase64: string
}

interface HelpPlan {
  mode: string
  advanceEnabled: boolean
  cycleHours: number
  advanceMinutes: number
  available: boolean
  waitingForScan: boolean
  acceptedScanAt: number
  maintenanceAt: number
  reminderAt: number
  remainingMs: number
  overdue: boolean
  notified: boolean
  notificationSentAt: number
  notificationError: string
  recentMobileActivityAt: number
  recentMobileActivityAvailable: boolean
  pauseReason: string
}

interface HelpStatus {
  serverNow: number
  account: { id: string, name: string, platform: string }
  incident: { needsRescan: boolean, lastError: string, sentAt: number }
  pending: HelpPendingSession | null
  plan: HelpPlan | null
}

const route = useRoute()
const router = useRouter()

const accountId = computed(() => String(route.query.accountId || '').trim())
const loading = ref(true)
const sending = ref(false)
const loadError = ref('')
const forbidden = ref(false)
const status = ref<HelpStatus | null>(null)
const pushInfo = ref('')
const retrying = ref(false)
const retryInfo = ref('')

// 账号切换代次：所有迟到的 GET/发送/重试结果与 finally 都按代次丢弃，
// 不得把 A 账号的二维码/错误写到 B 账号上。
let viewEpoch = 0
// 状态拉取不重叠：同代次上一次未返回时跳过本轮（只读轮询，允许跳过）；
// 账号切换产生新代次，不受旧代次在途请求占位影响（旧结果按代次丢弃）。
let statusInFlight: { epoch: number, work: Promise<void> } | null = null

const STATE_LABELS: Record<string, string> = {
  pending: '等待扫码',
  scanned: '已扫码，请在手机上确认登录',
  saving: '已确认，正在保存新授权…',
  confirmed_retry: '已确认，但换取游戏登录码暂时失败',
  saved: '重新扫码完成，账号已更新',
  expired: '二维码已过期，可点击「重新发送二维码」',
  error: '保存失败',
}

const stateLabel = computed(() => {
  const state = status.value?.pending?.state
  if (!state)
    return ''
  return STATE_LABELS[state] || state
})

const qrImageSrc = computed(() => {
  const qr = status.value?.pending?.qrBase64
  if (!qr)
    return ''
  if (qr.startsWith('data:'))
    return qr
  return `data:image/png;base64,${qr}`
})

// 倒计时锚点只用服务端时间差（expiresAt - serverNow）+ 本地单调流逝
// （performance.now），手机与服务器墙钟是否一致不影响显示。
const countAnchor = ref<{ remainingMs: number, atMonotonic: number } | null>(null)
const elapsedNow = ref(0)

function acceptStatus(data: HelpStatus) {
  status.value = data
  const pending = data?.pending
  if (pending && pending.state !== 'saved' && Number(data?.serverNow) > 0 && pending.expiresAt > 0) {
    countAnchor.value = {
      remainingMs: pending.expiresAt - Number(data.serverNow),
      atMonotonic: performance.now(),
    }
  }
  else {
    countAnchor.value = null
  }
  elapsedNow.value = performance.now()
}

const remainingLabel = computed(() => {
  const pending = status.value?.pending
  if (!pending || pending.state === 'saved')
    return ''
  // 服务端已判过期（微信侧二维码可能早于本页倒计时失效）：以服务端为准。
  if (pending.state === 'expired')
    return '二维码已过期，请重新发送'
  const anchor = countAnchor.value
  if (!anchor)
    return ''
  const remaining = anchor.remainingMs - (elapsedNow.value - anchor.atMonotonic)
  if (remaining <= 0)
    return '扫码窗口已结束，请重新发送二维码'
  const totalSeconds = Math.ceil(remaining / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `扫码窗口剩余 ${minutes}:${String(seconds).padStart(2, '0')}（微信侧二维码可能提前失效）`
})

const canSend = computed(() => !sending.value && !forbidden.value && !!accountId.value)
const canRetryLogin = computed(() =>
  !retrying.value && !sending.value && !forbidden.value && status.value?.pending?.state === 'confirmed_retry')

// ── 扫码维护参考计划（与扫码会话独立；只读展示，不生成二维码） ──
const DAY_MS = 86_400_000

function formatServerTime(ms: number) {
  if (!Number.isFinite(ms) || ms <= 0)
    return '—'
  return new Date(ms).toLocaleString()
}

function formatDuration(ms: number) {
  const totalMinutes = Math.max(0, Math.floor(ms / 60_000))
  const days = Math.floor(totalMinutes / 1440)
  const hours = Math.floor((totalMinutes % 1440) / 60)
  const minutes = totalMinutes % 60
  if (days > 0)
    return `${days} 天 ${hours} 小时`
  if (hours > 0)
    return `${hours} 小时 ${minutes} 分钟`
  return `${minutes} 分钟`
}

const planSummary = computed(() => {
  const plan = status.value?.plan
  if (!plan)
    return ''
  if (!plan.available)
    return plan.pauseReason || '完成下一次扫码后开始计算计划'
  const parts = []
  if (plan.overdue) {
    parts.push('维护参考时间已到')
  }
  else {
    parts.push(`下次维护参考时间 ${formatServerTime(plan.maintenanceAt)}（剩约 ${formatDuration(plan.remainingMs)}）`)
  }
  parts.push(`周期 ${plan.cycleHours} 小时，提前 ${plan.advanceMinutes} 分钟提醒`)
  if (plan.notified) {
    // notified 只代表唯一一次自动提醒已认领（含发送失败），不承诺送达。
    parts.push(plan.notificationSentAt > 0
      ? '本轮自动提醒已发送，同次扫码不会重复自动发送'
      : `本轮自动提醒已尝试${plan.notificationError ? `（上次发送失败：${plan.notificationError}）` : ''}，不会重复自动发送`)
  }
  else if (plan.pauseReason) {
    parts.push(plan.pauseReason)
  }
  return parts.join('；')
})

const planActivityLabel = computed(() => {
  const plan = status.value?.plan
  if (!plan)
    return ''
  if (!plan.recentMobileActivityAt)
    return '最近未观察到其他终端登录（会漏掉无在线 Bot 时的手机进场，也无法区分另一台 PC）'
  const when = formatServerTime(plan.recentMobileActivityAt)
  // 与服务端判定一致：窗口含边界（<= 24h）。
  const within = plan.recentMobileActivityAvailable
    && (Number(status.value?.serverNow) || 0) - plan.recentMobileActivityAt <= DAY_MS
  return within
    ? `最近其他终端登录（作为手机进场参考）：${when}，在 24 小时窗口内`
    : `最近其他终端登录（作为手机进场参考）：${when}，已超出 24 小时窗口`
})

// 只读轮询状态；页面绝不自动发起发送类请求（发送必须来自用户点击）。
const { pause: stopStatusPolling, resume: startStatusPolling } = useIntervalFn(async () => {
  elapsedNow.value = performance.now()
  await loadStatus(true)
}, 2000, { immediate: false })

// 显式「重试完成登录」：同一扫码确认补一次换码+保存，不重发二维码。
async function retryCompleteLogin() {
  if (!canRetryLogin.value)
    return
  const epoch = viewEpoch
  retrying.value = true
  retryInfo.value = ''
  try {
    const { data } = await api.post('/api/wx-login-help/retry-login', { accountId: accountId.value }, { timeout: 120_000 })
    if (epoch !== viewEpoch)
      return
    if (data?.ok) {
      retryInfo.value = data.data.started
        ? '重试成功，新授权已保存并恢复运行'
        : `新授权已保存，但账号启动失败：${data.data.startError || '未知原因'}`
    }
    else {
      retryInfo.value = data?.error || '重试失败'
    }
  }
  catch (e: any) {
    if (epoch !== viewEpoch)
      return
    if (e?.response?.status === 403) {
      forbidden.value = true
      stopStatusPolling()
      return
    }
    retryInfo.value = e?.response?.data?.error || e?.message || '重试失败'
  }
  finally {
    if (epoch === viewEpoch)
      retrying.value = false
    await loadStatus(true, epoch)
  }
}

async function loadStatus(silent = false, epoch = viewEpoch) {
  if (epoch !== viewEpoch || !accountId.value || forbidden.value)
    return
  if (statusInFlight && statusInFlight.epoch === epoch)
    return
  const work = (async () => {
    try {
      const { data } = await api.get('/api/wx-login-help/status', {
        params: { accountId: accountId.value },
      })
      if (epoch !== viewEpoch)
        return
      if (data?.ok) {
        acceptStatus(data.data)
        loadError.value = ''
        forbidden.value = false
      }
      else if (!silent) {
        loadError.value = data?.error || '加载失败'
      }
    }
    catch (e: any) {
      if (epoch !== viewEpoch)
        return
      if (e?.response?.status === 403) {
        forbidden.value = true
        stopStatusPolling()
        return
      }
      if (!silent)
        loadError.value = e?.response?.data?.error || e?.message || '加载失败'
    }
  })()
  statusInFlight = { epoch, work }
  try {
    await work
  }
  finally {
    if (statusInFlight?.work === work)
      statusInFlight = null
  }
}

async function sendQr() {
  if (!canSend.value)
    return
  // 重发同时取代同账号旧状态读取，避免迟到的 saved/expired 结果停掉新二维码轮询。
  viewEpoch += 1
  const epoch = viewEpoch
  stopStatusPolling()
  sending.value = true
  pushInfo.value = ''
  if (status.value)
    status.value.pending = null
  countAnchor.value = null
  try {
    const { data } = await api.post('/api/wx-login-help/send-qr', { accountId: accountId.value }, { timeout: 100_000 })
    if (epoch !== viewEpoch)
      return
    if (data?.ok) {
      pushInfo.value = data.data.pushed
        ? '新二维码已推送到你的 Bark 通知（含二维码图片，点击通知可回到本页）'
        : `二维码仅在页面显示，未推送：${data.data.pushError || '未知原因'}`
      await loadStatus(true, epoch)
      if (!['saved', 'expired', 'error'].includes(status.value?.pending?.state || ''))
        startStatusPolling()
    }
    else {
      pushInfo.value = data?.error || '发送失败'
    }
  }
  catch (e: any) {
    if (epoch !== viewEpoch)
      return
    if (e?.response?.status === 403) {
      forbidden.value = true
      stopStatusPolling()
      return
    }
    pushInfo.value = e?.response?.data?.error || e?.message || '发送失败'
  }
  finally {
    if (epoch === viewEpoch)
      sending.value = false
  }
}

function backToDashboard() {
  router.push({ name: 'dashboard' })
}

// 终态（已保存/已过期/保存失败）不再有可观察变化：停轮询。
// confirmed_retry 保留轮询：会话到期时按钮要随服务端状态正确失效。
watch(() => status.value?.pending?.state, (state) => {
  if (state === 'saved' || state === 'expired' || state === 'error')
    stopStatusPolling()
})

// 账号参数变化（同组件复用）：清旧账号的二维码/错误/推送信息再加载，
// 迟到响应按代次丢弃，绝不显示或发送别的账号的二维码。
watch(accountId, async (next, prev) => {
  if (next === prev)
    return
  viewEpoch += 1
  const epoch = viewEpoch
  stopStatusPolling()
  status.value = null
  countAnchor.value = null
  pushInfo.value = ''
  retryInfo.value = ''
  loadError.value = ''
  forbidden.value = false
  sending.value = false
  retrying.value = false
  loading.value = true
  if (!next) {
    loadError.value = '缺少账号参数：请从提醒通知或账号面板进入'
    loading.value = false
    return
  }
  await loadStatus(false, epoch)
  if (epoch !== viewEpoch)
    return
  loading.value = false
  if (!forbidden.value)
    startStatusPolling()
})

onMounted(async () => {
  if (!accountId.value) {
    loadError.value = '缺少账号参数：请从提醒通知或账号面板进入'
    loading.value = false
    return
  }
  await loadStatus()
  loading.value = false
  if (!forbidden.value)
    startStatusPolling()
})

onUnmounted(() => {
  viewEpoch += 1
  stopStatusPolling()
})
</script>

<template>
  <div class="mx-auto max-w-xl p-4 space-y-4">
    <div class="flex items-center justify-between">
      <h1 class="text-xl text-gray-900 font-bold dark:text-gray-100">
        微信重新扫码
      </h1>
      <BaseButton variant="secondary" size="sm" @click="backToDashboard">
        返回概览
      </BaseButton>
    </div>

    <div v-if="loading" class="ui-card rounded-lg p-6 text-center text-sm text-gray-500">
      加载中…
    </div>

    <div v-else-if="forbidden" class="ui-card rounded-lg p-6 text-center text-sm text-red-600">
      无权访问此账号。请用账号属主自己的账号登录后再试。
    </div>

    <template v-else>
      <div class="ui-card rounded-lg p-4">
        <div class="text-sm text-gray-500">
          账号
        </div>
        <div class="text-lg text-gray-900 font-bold dark:text-gray-100">
          {{ status?.account?.name || accountId }}
        </div>

        <div
          v-if="status?.incident?.needsRescan"
          class="mt-3 border border-amber-300 rounded bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-700 dark:bg-amber-900/20 dark:text-amber-300"
        >
          该账号的微信登录已被系统确认失效，需要重新扫码授权后才能继续自动登录。
          <div v-if="status?.incident?.lastError" class="mt-1 text-xs opacity-80">
            上次自动提醒发送失败：{{ status.incident.lastError }}（可在设置里测试 Bark 后重试）
          </div>
        </div>
        <div
          v-else-if="status?.pending?.state !== 'saved'"
          class="mt-3 border border-gray-200 rounded bg-gray-50 p-3 text-sm text-gray-600 dark:border-gray-700 dark:bg-gray-800/60 dark:text-gray-300"
        >
          当前凭据未被判失效。如扫码遇到问题，仍可主动更换授权。
        </div>
      </div>

      <div v-if="status?.plan" class="ui-card rounded-lg p-4 text-sm">
        <div class="mb-1 text-gray-900 font-bold dark:text-gray-100">
          扫码维护参考计划
        </div>
        <p v-if="status.plan.available" class="text-gray-700 dark:text-gray-300">
          {{ planSummary }}
        </p>
        <p v-else class="text-gray-500 dark:text-gray-400">
          {{ planSummary }}
        </p>
        <p class="mt-1 text-xs text-gray-500 dark:text-gray-400">
          {{ planActivityLabel }}
        </p>
        <p class="mt-1 text-xs text-gray-400">
          计划为你自行设置的参考（在「设置 → 用户管理 → 微信重扫提醒」调整），不代表微信官方到期时间，也不保证零断线。
          同次扫码只自动提醒一次；若尚未提前提醒，实际失效时再提醒，成功重扫后开始下一轮。
          提前提醒不会自动生成二维码或改动运行中的账号。
        </p>
      </div>

      <div class="ui-card rounded-lg p-4">
        <div v-if="qrImageSrc" class="flex flex-col items-center gap-3 py-2">
          <div class="border border-gray-200 rounded bg-white p-2 dark:border-gray-700">
            <img :src="qrImageSrc" class="h-56 w-56" alt="微信登录二维码">
          </div>
          <p class="text-center text-sm text-gray-700 dark:text-gray-300">
            {{ stateLabel }}
          </p>
          <p class="text-center text-xs text-gray-500">
            {{ remainingLabel }}
          </p>
          <p v-if="status?.pending?.state === 'error'" class="text-center text-sm text-red-600">
            {{ status.pending.detail }}
          </p>
          <p v-if="status?.pending?.state === 'confirmed_retry'" class="max-w-md text-center text-xs text-amber-600 dark:text-amber-400">
            {{ status.pending.detail || '网络波动导致换码失败' }}。扫码确认仍然有效，可直接重试；若持续失败，请重新发送二维码。
          </p>
        </div>
        <div v-else class="py-8 text-center text-sm text-gray-500">
          暂无待扫码二维码。点击下方按钮生成并发送到你的 Bark。
        </div>

        <div class="mt-2 flex justify-center gap-2">
          <BaseButton
            variant="primary"
            :loading="sending"
            :disabled="!canSend"
            @click="sendQr"
          >
            {{ qrImageSrc ? '重新发送二维码' : '现在发送二维码' }}
          </BaseButton>
          <BaseButton
            v-if="canRetryLogin"
            variant="secondary"
            :loading="retrying"
            @click="retryCompleteLogin"
          >
            重试完成登录
          </BaseButton>
        </div>

        <p v-if="pushInfo" class="mt-3 text-center text-xs text-gray-500">
          {{ pushInfo }}
        </p>
        <p v-if="retryInfo" class="mt-1 text-center text-xs text-gray-500">
          {{ retryInfo }}
        </p>

        <div
          v-if="status?.pending?.state === 'saved'"
          class="mt-3 border border-emerald-300 rounded bg-emerald-50 p-3 text-center text-sm text-emerald-700 dark:border-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-300"
        >
          新授权已保存。账号按既有流程恢复运行，可在概览页确认在线状态。
          <div v-if="status?.pending?.detail" class="mt-1 text-xs text-amber-600 dark:text-amber-400">
            {{ status.pending.detail }}
          </div>
          <BaseButton variant="secondary" size="sm" class="mt-2" @click="backToDashboard">
            返回概览
          </BaseButton>
        </div>
      </div>

      <div class="ui-card rounded-lg p-4 text-xs text-gray-500 leading-relaxed">
        <p class="mb-1 font-medium">
          说明
        </p>
        <p>1. 点击「发送二维码」后，服务器会生成新二维码并立即推送到你的 Bark 通知；Apple Watch 能否显示取决于 iPhone 的通知镜像设置。</p>
        <p>2. 页面可以关闭或切到微信：服务器会在后台继续等待你扫码确认并自动保存。</p>
        <p>3. 倒计时是本页扫码窗口的参考时间；微信里的二维码可能更早失效，过期后点「重新发送二维码」再试即可。</p>
        <p v-if="loadError" class="mt-1 text-red-500">
          {{ loadError }}
        </p>
      </div>
    </template>
  </div>
</template>
