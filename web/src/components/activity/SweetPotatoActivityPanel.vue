<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import api from '@/api'
import BaseButton from '@/components/ui/BaseButton.vue'
import SweetPotatoTrades from './SweetPotatoTrades.vue'

interface SweetPotatoPersonal {
  basePrice: number | null
  criticalBonus: number | null
  receivedCount: number | null
  coinBalance: number | null
  pendingDividend: number | null
  seedsClaimed: boolean | null
  shared: boolean | null
}

interface SweetPotatoActivity {
  available: boolean
  status: 'available' | 'unknown' | 'unavailable'
  reason?: string
  personal: SweetPotatoPersonal | null
}

const props = defineProps<{ accountId: string }>()
const START_MS = 1795572000 * 1000
const END_MS = 1796831999 * 1000
const inWindow = (now = Date.now()) => now >= START_MS && now < END_MS
const active = ref(false)
const activity = ref<SweetPotatoActivity | null>(null)
const available = computed(() => activity.value?.available === true)
const loading = ref(false)
const error = ref('')
let pending: AbortController | null = null
let expiry: ReturnType<typeof setTimeout> | undefined

function clearRead() {
  pending?.abort()
  pending = null
  activity.value = null
  loading.value = false
  error.value = ''
}

function expire() {
  clearTimeout(expiry)
  expiry = undefined
  active.value = false
  clearRead()
}

async function refresh() {
  const now = Date.now()
  if (!inWindow(now)) {
    expire()
    return
  }
  const accountId = props.accountId
  if (!accountId || pending)
    return
  if (!active.value) {
    active.value = true
    expiry = setTimeout(expire, END_MS - now)
  }
  const request = new AbortController()
  pending = request
  loading.value = true
  error.value = ''
  activity.value = null
  const stillCurrent = () => pending === request && props.accountId === accountId
  try {
    const { data } = await api.get('/api/activity/sweet-potato', {
      headers: { 'x-account-id': accountId },
      timeout: 50_000,
      signal: request.signal,
      errorFeedback: 'consumer',
    })
    if (!stillCurrent())
      return
    if (!inWindow()) {
      expire()
      return
    }
    const result = data?.activity as SweetPotatoActivity | undefined
    if (data?.ok !== true || data.accountId !== accountId
      || !result || typeof result.available !== 'boolean'
      || (result.available
        ? result.status !== 'available' || !result.personal || typeof result.personal !== 'object' || Array.isArray(result.personal)
        : (result.status !== 'unavailable' && result.status !== 'unknown') || result.personal !== null))
      throw new Error('读取失败')
    activity.value = result
  }
  catch {
    if (stillCurrent()) {
      if (inWindow())
        error.value = '读取失败，请检查当前账号的连接后刷新。'
      else
        expire()
    }
  }
  finally {
    if (stillCurrent()) {
      pending = null
      loading.value = false
    }
  }
}

watch(() => props.accountId, () => {
  clearRead()
  refresh()
}, { immediate: true, flush: 'sync' })

onBeforeUnmount(expire)

defineExpose({ refresh, active, available, loading })

function formatNumber(value: unknown) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? Number(value).toLocaleString('zh-CN')
    : '待确认'
}

function formatClaim(value: unknown, yes: string, no: string) {
  return typeof value === 'boolean' ? (value ? yes : no) : '待确认'
}
</script>

<template>
  <section v-if="active" id="sweet-potato" class="rounded-xl bg-white p-4 shadow-sm dark:bg-gray-800" aria-labelledby="sweet-potato-title">
    <header class="flex flex-wrap items-center justify-between gap-3">
      <h2 id="sweet-potato-title" class="text-lg text-gray-900 font-semibold dark:text-gray-100">
        以薯换福
      </h2>
      <BaseButton type="button" variant="outline" :loading="loading" @click="refresh">
        刷新状态
      </BaseButton>
    </header>

    <p class="mt-2 text-sm text-gray-600 dark:text-gray-300">
      在游戏里领取红薯种子，种植后收获蜜薯。可在自己的铺子或通过好友分享卡出售，用福气币兑换奖励。
      每日首次分享可提高自家铺价。好友在你的铺子出售可产生分红。北京时间每日午夜按自家铺价结算剩余蜜薯。
    </p>

    <div class="mt-3 text-sm" aria-live="polite" :aria-busy="loading">
      <p v-if="loading" class="text-gray-600 dark:text-gray-300">
        正在读取活动状态…
      </p>
      <p v-else-if="error" class="text-red-700 dark:text-red-300">
        {{ error }}
      </p>
      <p v-else-if="activity && !activity.available" class="text-gray-600 dark:text-gray-300">
        {{ typeof activity.reason === 'string' && activity.reason ? activity.reason : '活动状态待确认' }}
      </p>
      <dl v-else-if="activity?.personal" class="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <div
          v-for="[label, value] in [
            ['个人基础铺价', formatNumber(activity.personal.basePrice)],
            ['暴击加成', formatNumber(activity.personal.criticalBonus)],
            ['领种状态', formatClaim(activity.personal.seedsClaimed, '已领种', '未领种')],
            ['分享状态', formatClaim(activity.personal.shared, '已分享', '未分享')],
            ['福气币余额', formatNumber(activity.personal.coinBalance)],
            ['接收量', formatNumber(activity.personal.receivedCount)],
            ['待领分红', formatNumber(activity.personal.pendingDividend)],
          ]" :key="label"
          class="min-w-0 rounded-lg bg-gray-50 p-3 dark:bg-gray-900/50"
        >
          <dt class="text-gray-500 dark:text-gray-400">{{ label }}</dt>
          <dd class="mt-1 break-words text-gray-900 font-medium dark:text-gray-100">{{ value }}</dd>
        </div>
      </dl>
    </div>
    <SweetPotatoTrades
      v-if="activity?.available && activity.personal"
      class="mt-4"
      :account-id="props.accountId"
      :seeds-claimed="activity.personal.seedsClaimed"
      :pending-dividend="activity.personal.pendingDividend"
      @changed="refresh"
    />
  </section>
</template>
