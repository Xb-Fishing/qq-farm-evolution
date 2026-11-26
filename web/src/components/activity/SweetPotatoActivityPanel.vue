<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import api from '@/api'
import BaseButton from '@/components/ui/BaseButton.vue'
import SweetPotatoTrades from './SweetPotatoTrades.vue'
import SweetPotatoAutomation from './SweetPotatoAutomation.vue'

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
const loading = ref(false)
const error = ref('')
const available = computed(() => activity.value?.available === true && !error.value)
const personal = computed(() => available.value ? activity.value?.personal : null)
const sections = [
  { id: 'grow', label: '种植与收获', icon: 'i-carbon-leaf' },
  { id: 'market', label: '售卖与分红', icon: 'i-carbon-store' },
  { id: 'rewards', label: '兑换奖励', icon: 'i-carbon-gift' },
  { id: 'automation', label: '自动托管', icon: 'i-carbon-settings' },
] as const
type Section = typeof sections[number]['id']
const section = ref<Section>('grow')

function navigateTabs(event: KeyboardEvent, index: number) {
  let next: number
  switch (event.key) {
    case 'ArrowRight': next = (index + 1) % sections.length; break
    case 'ArrowLeft': next = (index + sections.length - 1) % sections.length; break
    case 'Home': next = 0; break
    case 'End': next = sections.length - 1; break
    default: return
  }
  event.preventDefault()
  section.value = sections[next]!.id
  nextTick(() => document.getElementById(`sweet-potato-tab-${section.value}`)?.focus())
}
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
    error.value = ''
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
  section.value = 'grow'
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
  <section v-if="active" id="sweet-potato" class="min-w-0 overflow-hidden border border-gray-200 rounded-2xl bg-white shadow-sm dark:border-gray-700 dark:bg-gray-800" aria-labelledby="sweet-potato-title">
    <header class="harvest-overview p-4 sm:p-6">
      <div class="flex items-start justify-between gap-3">
        <div class="min-w-0 flex items-center gap-3">
          <span class="harvest-emblem grid h-10 w-10 shrink-0 place-items-center rounded-xl text-xl sm:h-12 sm:w-12" aria-hidden="true">
            <span class="i-carbon-leaf" />
          </span>
          <div>
            <h2 id="sweet-potato-title" class="text-xl text-gray-900 font-bold sm:text-2xl dark:text-gray-100">
              以薯换福
            </h2>
            <p class="mt-0.5 text-xs text-gray-600 sm:text-sm dark:text-gray-300">活动期间可每日领种</p>
          </div>
        </div>
        <BaseButton type="button" variant="outline" size="sm" class="min-h-11 shrink-0 bg-white dark:bg-gray-800" :loading="loading" @click="refresh">
          刷新状态
        </BaseButton>
      </div>
      <dl v-if="personal" class="hero-stats mt-4 grid grid-cols-2 gap-x-4 gap-y-3 rounded-xl p-3 sm:grid-cols-3 sm:p-4">
        <div class="col-span-2 min-w-0 sm:col-span-1">
          <dt>福气币余额</dt>
          <dd class="coin-value">{{ formatNumber(personal.coinBalance) }}</dd>
        </div>
        <div class="min-w-0">
          <dt>自家基础铺价</dt>
          <dd>{{ formatNumber(personal.basePrice) }}</dd>
        </div>
        <div class="min-w-0">
          <dt>待领分红</dt>
          <dd>{{ formatNumber(personal.pendingDividend) }}</dd>
        </div>
      </dl>
      <div v-if="!personal || loading" class="mt-3 text-sm" aria-live="polite" :aria-busy="loading">
        <p v-if="loading" class="text-gray-700 dark:text-gray-200">正在读取活动状态…</p>
        <p v-else-if="error" class="text-red-700 dark:text-red-300">{{ error }}</p>
        <p v-else-if="activity && !activity.available" class="break-words text-gray-700 dark:text-gray-200">
          {{ typeof activity.reason === 'string' && activity.reason ? activity.reason : '活动状态待确认' }}
        </p>
      </div>
    </header>

    <div class="p-3 sm:p-5">
      <div class="harvest-tabs grid grid-cols-2 gap-1 rounded-xl p-1 sm:grid-cols-4" role="tablist" aria-label="以薯换福玩法">
        <button
          v-for="(tab, index) in sections"
          :id="`sweet-potato-tab-${tab.id}`"
          :key="tab.id"
          class="harvest-tab min-h-11 min-w-0 flex items-center justify-center gap-1.5 rounded-lg px-1.5 py-2 text-sm font-semibold"
          type="button"
          role="tab"
          :tabindex="section === tab.id ? 0 : -1"
          :aria-selected="section === tab.id"
          aria-controls="sweet-potato-workspace"
          @click="section = tab.id"
          @keydown="navigateTabs($event, index)"
        >
          <span :class="tab.icon" class="shrink-0" aria-hidden="true" />
          {{ tab.label }}
        </button>
      </div>
      <div id="sweet-potato-workspace" class="mt-3 sm:mt-4" role="tabpanel" :aria-labelledby="`sweet-potato-tab-${section}`">
        <div :hidden="section === 'automation' || !available">
          <SweetPotatoTrades
            v-if="activity?.available && activity.personal"
            :account-id="props.accountId"
            :section="section"
            :suspended="loading || !!error"
            :seeds-claimed="activity.personal.seedsClaimed"
            :pending-dividend="activity.personal.pendingDividend"
            @changed="refresh"
          />
        </div>
        <p v-if="section !== 'automation' && !available" class="rounded-xl bg-gray-50 px-4 py-3 text-sm text-gray-700 dark:bg-gray-900/50 dark:text-gray-200">
          活动状态确认后可进行操作。
        </p>
        <div :hidden="section !== 'automation'">
          <SweetPotatoAutomation :account-id="props.accountId" />
        </div>
      </div>

      <details class="mt-4 border-t border-gray-200 pt-2 text-sm text-gray-700 dark:border-gray-700 dark:text-gray-200">
        <summary class="min-h-11 cursor-pointer rounded-md px-1 py-3 font-medium">活动规则与个人状态</summary>
        <dl v-if="personal" class="grid grid-cols-2 gap-3 px-1 sm:grid-cols-4">
          <div>
            <dt>领种状态</dt>
            <dd class="font-semibold">{{ formatClaim(personal.seedsClaimed, '已领种', '未领种') }}</dd>
          </div>
          <div>
            <dt>分享状态</dt>
            <dd class="font-semibold">{{ formatClaim(personal.shared, '已分享', '未分享') }}</dd>
          </div>
          <div>
            <dt>暴击加成</dt>
            <dd class="break-words font-semibold">{{ formatNumber(personal.criticalBonus) }}</dd>
          </div>
          <div>
            <dt>铺子接收量</dt>
            <dd class="break-words font-semibold">{{ formatNumber(personal.receivedCount) }}</dd>
          </div>
        </dl>
        <p class="px-1 pb-2 leading-relaxed" :class="{ 'mt-3': personal }">
          红薯收获后得到蜜薯。可在自家铺子或好友铺子出售，用福气币兑换奖励。每日首次分享提高自家铺价，好友在你的铺子出售可产生分红。北京时间每日午夜按自家铺价结算剩余蜜薯。
        </p>
      </details>
    </div>
  </section>
</template>

<style scoped>
.harvest-overview {
  background: linear-gradient(115deg, #fff5df, #fffaf1 62%, #f3f5e8);
  border-bottom: 1px solid #f0dfc6;
}

.harvest-emblem {
  background: #f5dfbc;
  color: #80401c;
}

.hero-stats {
  background: rgb(255 255 255 / 68%);
  border: 1px solid #f0dfc6;
  align-items: end;
}

.hero-stats dt {
  color: #605445;
  font-size: 0.8125rem;
}

.hero-stats dd {
  color: #31271d;
  font-size: 1.25rem;
  font-weight: 700;
  line-height: 1.2;
  margin: 0.25rem 0 0;
  font-variant-numeric: tabular-nums;
  overflow-wrap: anywhere;
}

.hero-stats .coin-value {
  color: #80401c;
  font-size: clamp(1.5rem, 3vw, 2.125rem);
}

.harvest-tabs {
  background: #f4f3ef;
}

.harvest-tab {
  color: #51493e;
}

.harvest-tab:hover {
  background: #f6e8d2;
}

.harvest-tab[aria-selected='true'] {
  background: #843e21;
  color: white;
}

.harvest-tab:focus-visible,
summary:focus-visible {
  outline: 2px solid #a2522e;
  outline-offset: 2px;
}

.harvest-overview:where(.dark *) {
  background: linear-gradient(115deg, #372b22, #292527 66%, #242b29);
  border-color: #554137;
}

.harvest-emblem:where(.dark *) {
  background: #583b2b;
  color: #ffd5a7;
}

.hero-stats:where(.dark *) {
  background: rgb(22 20 20 / 45%);
  border-color: #554137;
}

.hero-stats:where(.dark *) dt {
  color: #dbccba;
}

.hero-stats:where(.dark *) dd {
  color: #fff7eb;
}

.hero-stats:where(.dark *) .coin-value {
  color: #ffd5a7;
}

.harvest-tabs:where(.dark *) {
  background: #19212c;
}

.harvest-tab:where(.dark *) {
  color: #e2e8f0;
}

.harvest-tab:where(.dark *):hover {
  background: #3f342d;
}

.harvest-tab:where(.dark *)[aria-selected='true'] {
  background: #ffd5a7;
  color: #392514;
}

.harvest-tab:where(.dark *):focus-visible,
summary:where(.dark *):focus-visible {
  outline-color: #ffd5a7;
}
</style>
