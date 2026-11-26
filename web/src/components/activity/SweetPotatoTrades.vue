<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import api from '@/api'
import BaseButton from '@/components/ui/BaseButton.vue'

interface Quote {
  shop: number
  name: string
  unitPrice: number
  remaining: number | null
  acceptsSales: boolean | null
}
interface Goods {
  index: number
  unitPrice: number
  limit: number | null
  name: string
}
interface Stock {
  seeds: number
  potatoes: number
  coins: number
}
interface Row {
  seller: string
  at: number | null
  count: number | null
  proceeds: number | null
  dividend: number | null
}
interface Plots {
  empty: number[]
  ready: number[]
}
type Action = 'seeds' | 'dividend' | 'sale' | 'exchange' | 'plantCrop' | 'harvestCrop'
type ConfirmedAction = Exclude<Action, 'seeds' | 'dividend'>
type Section = 'grow' | 'market' | 'rewards' | 'automation'

const props = defineProps<{
  accountId: string
  section: Section
  suspended: boolean
  seedsClaimed: boolean | null
  pendingDividend: number | null
}>()
const emit = defineEmits<{ changed: [] }>()
const route = '/api/activity/sweet-potato/trade'
const busy = ref(false)
const working = ref('')
const feedbackSection = ref<Section>(props.section)
const controlsDisabled = computed(() => busy.value || props.suspended)
const fieldClass = 'min-h-11 min-w-0 max-w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-900'
const cardClass = 'min-w-0 rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800'
const infoClass = 'break-words rounded-lg bg-gray-50 px-3 py-2.5 text-sm text-gray-700 dark:bg-gray-900/60 dark:text-gray-200'
const message = ref('')
const error = ref('')
const market = ref<Quote | null>(null)
const stock = ref<Stock | null>(null)
const goods = ref<Goods[] | null>(null)
const records = ref<Row[] | null>(null)
const selectedShop = ref('')
const sellCount = ref(1)
const exchangeCount = ref(1)
const exchangeIndex = ref<number | null>(null)
const confirm = ref<ConfirmedAction | null>(null)
const plots = ref<Plots | null>(null)
const landId = ref<number | null>(null)
const plotAction = computed(() => {
  if (!landId.value || !plots.value)
    return null
  if (plots.value.empty.includes(landId.value))
    return 'plantCrop' as const
  return plots.value.ready.includes(landId.value) ? 'harvestCrop' as const : null
})
const selectedGoods = computed(() => goods.value?.find(row => row.index === exchangeIndex.value))
const maxSale = computed(() => market.value?.acceptsSales === true
  ? Math.min(stock.value?.potatoes ?? 0, market.value.remaining ?? 0)
  : 0)
const maxExchange = computed(() => selectedGoods.value?.name
  ? Math.min(selectedGoods.value.limit ?? 0, Math.floor((stock.value?.coins ?? 0) / selectedGoods.value.unitPrice))
  : 0)
const confirmation = ref<HTMLElement | null>(null)
let previewTrigger: HTMLElement | null = null
let generation = 0

function preview(action: ConfirmedAction | null, event: MouseEvent) {
  if (controlsDisabled.value || !action)
    return
  previewTrigger = event.currentTarget as HTMLElement
  confirm.value = action
  nextTick(() => confirmation.value?.focus())
}

function cancelPreview() {
  const trigger = previewTrigger
  confirm.value = null
  nextTick(() => trigger?.focus())
}

watch(() => props.accountId, () => {
  generation++
  busy.value = false
  market.value = null
  stock.value = null
  goods.value = null
  records.value = null
  plots.value = null
  landId.value = null
  exchangeIndex.value = null
  selectedShop.value = ''
  sellCount.value = 1
  exchangeCount.value = 1
  working.value = ''
  confirm.value = null
  message.value = ''
  error.value = ''
}, { flush: 'sync' })
watch(confirm, (value) => { if (!value) previewTrigger = null }, { flush: 'sync' })
watch([() => props.section, () => props.suspended], () => { confirm.value = null })
watch(selectedShop, () => { market.value = null })
watch([selectedShop, sellCount, exchangeCount, exchangeIndex, landId], () => { confirm.value = null })

async function request<T>(action: string, accountId: string, body?: Record<string, unknown>, params?: Record<string, string>) {
  const config = { headers: { 'x-account-id': accountId }, params }
  const response = body === undefined
    ? await api.get(`${route}/${action}`, config)
    : await api.post(`${route}/${action}`, body, config)
  const data = response.data
  if (data?.ok !== true || String(data.accountId) !== accountId)
    throw new Error(data?.error || '账号已切换，请重新读取活动')
  return data.result as T
}

async function run(key: string, action: (account: string, current: () => boolean) => Promise<void>) {
  if (controlsDisabled.value || !props.accountId)
    return
  const account = props.accountId
  const currentGeneration = generation
  const current = () => account === props.accountId && currentGeneration === generation
  error.value = ''
  message.value = ''
  feedbackSection.value = props.section
  working.value = key
  busy.value = true
  try {
    await action(account, current)
  }
  catch (e: any) {
    if (current())
      error.value = e?.response?.data?.error || e?.message || '活动操作未完成，请核对状态'
  }
  finally {
    if (current()) {
      working.value = ''
      busy.value = false
    }
  }
}

function loadQuote() {
  market.value = null
  confirm.value = null
  const shop = selectedShop.value.trim()
  return run('quote', async (account, current) => {
    const data = await request<{ quote: Quote, stock: Stock }>('quote', account, undefined, { shop })
    if (current() && shop === selectedShop.value.trim()) {
      market.value = data.quote
      stock.value = data.stock
    }
  })
}

function loadCatalog() {
  confirm.value = null
  return run('catalog', async (account, current) => {
    const data = await request<{ catalog: Goods[], stock: Stock }>('catalog', account)
    if (current()) {
      goods.value = data.catalog
      stock.value = data.stock
    }
  })
}

function loadRecords() {
  confirm.value = null
  return run('records', async (account, current) => {
    const result = await request<Row[]>('records', account)
    if (current())
      records.value = result
  })
}

function loadPlots() {
  confirm.value = null
  return run('plots', async (account, current) => {
    const result = await request<Plots>('plots', account)
    if (current()) {
      plots.value = result
      landId.value = null
    }
  })
}

function write(action: Action) {
  if (controlsDisabled.value)
    return
  const body: Record<string, unknown> = {}
  if (action === 'sale') {
    if (confirm.value !== 'sale' || !market.value || !stock.value || sellCount.value > maxSale.value)
      return
    Object.assign(body, { shop: market.value.shop, count: sellCount.value, unitPrice: market.value.unitPrice, potatoes: stock.value.potatoes })
  }
  if (action === 'exchange') {
    if (confirm.value !== 'exchange' || !selectedGoods.value || !stock.value || exchangeCount.value > maxExchange.value)
      return
    Object.assign(body, { index: selectedGoods.value.index, count: exchangeCount.value, unitPrice: selectedGoods.value.unitPrice, coins: stock.value.coins })
  }
  if (action === 'plantCrop' || action === 'harvestCrop') {
    if (confirm.value !== action || plotAction.value !== action || !landId.value)
      return
    body.landId = landId.value
  }
  confirm.value = null
  return run(action, async (account, current) => {
    try {
      const result = await request<{ proceeds?: number, cost?: number, amount?: number, count?: number, landId?: number, potatoes?: number }>(action, account, body)
      if (current()) {
        const feedback = {
          seeds: `已领取红薯种子 × ${result.count}`,
          dividend: `已领取分红 ${result.amount} 福气币`,
          sale: `已售出 ${result.count} 个蜜薯，获得 ${result.proceeds} 福气币`,
          exchange: `兑换已确认，使用 ${result.cost} 福气币`,
          plantCrop: `${result.landId} 号地已种下红薯`,
          harvestCrop: `${result.landId} 号地已收获红薯，获得 ${result.potatoes ?? 0} 个蜜薯`,
        }
        message.value = feedback[action]
      }
    }
    finally {
      if (current()) {
        market.value = null
        stock.value = null
        goods.value = null
        exchangeIndex.value = null
        if (action === 'plantCrop' || action === 'harvestCrop') {
          plots.value = null
          landId.value = null
        }
        emit('changed')
      }
    }
  })
}
</script>

<template>
  <div class="space-y-3">
    <div v-if="section === 'grow'" class="grid gap-3 lg:grid-cols-2">
      <section :class="cardClass">
        <h3 class="font-semibold">今日红薯种子</h3>
        <p class="mb-3 mt-1 text-sm text-gray-600 dark:text-gray-300">
          {{ seedsClaimed === true ? '今日种子已领取。' : seedsClaimed === false ? '领取种子后即可在空地种植。' : '领种状态待确认，请刷新活动状态。' }}
        </p>
        <BaseButton type="button" variant="primary" class="min-h-11" :loading="working === 'seeds'" :disabled="controlsDisabled || seedsClaimed !== false" @click="write('seeds')">
          领取今日种子
        </BaseButton>
      </section>
      <section :class="cardClass">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <h3 class="font-semibold">农田</h3>
          <BaseButton type="button" variant="outline" class="min-h-11" :loading="working === 'plots'" :disabled="controlsDisabled" @click="loadPlots">读取当前土地</BaseButton>
        </div>
        <p v-if="!plots" class="mt-3" :class="infoClass">读取后可选择空地种植，或收获成熟红薯。</p>
        <p v-else-if="!plots.empty.length && !plots.ready.length" class="mt-3" :class="infoClass">暂无可种空地或已成熟红薯。</p>
        <div v-else class="mt-3 space-y-2">
          <label for="sweet-potato-land" class="block text-sm font-medium">土地</label>
          <div class="flex flex-wrap gap-2">
            <select id="sweet-potato-land" v-model="landId" :class="fieldClass" class="w-full sm:w-auto" :disabled="controlsDisabled">
              <option :value="null">选择土地</option>
              <option v-for="id in plots.empty" :key="id" :value="id">{{ id }} 号地 · 可种</option>
              <option v-for="id in plots.ready" :key="id" :value="id">{{ id }} 号地 · 红薯成熟</option>
            </select>
            <BaseButton type="button" variant="primary" class="min-h-11" :disabled="controlsDisabled || !plotAction" @click="preview(plotAction, $event)">
              {{ plotAction === 'harvestCrop' ? '收获红薯' : '种植红薯' }}
            </BaseButton>
          </div>
        </div>
      </section>
    </div>

    <section v-else-if="section === 'market'" :class="cardClass">
      <h3 class="font-semibold">出售蜜薯</h3>
      <form class="mt-3 space-y-2" @submit.prevent="loadQuote">
        <label for="sweet-potato-shop" class="block text-sm font-medium">铺子</label>
        <div class="flex flex-wrap gap-2">
          <input id="sweet-potato-shop" v-model="selectedShop" inputmode="numeric" placeholder="好友 GID（留空查自家）" :class="fieldClass" class="w-full sm:w-56" :disabled="controlsDisabled">
          <BaseButton type="submit" variant="outline" class="min-h-11" :loading="working === 'quote'" :disabled="controlsDisabled">查询收购价</BaseButton>
        </div>
      </form>
      <div v-if="market" class="mt-3" :class="infoClass">
        <p class="font-semibold">{{ market.name || '所选铺子' }} · {{ market.unitPrice }} 福气币/个</p>
        <p class="mt-1">
          {{ stock?.potatoes === 0 ? '背包暂无可售蜜薯。' : market.acceptsSales === false ? '铺子暂不收购。' : market.acceptsSales !== true || market.remaining === null ? '收购额度待确认，请重新查询。' : `当前可售 ${maxSale} 个蜜薯。` }}
        </p>
      </div>
      <div v-if="maxSale > 0" class="mt-3 space-y-2">
        <label for="sweet-potato-sale-count" class="block text-sm font-medium">出售数量</label>
        <div class="flex flex-wrap gap-2">
          <input id="sweet-potato-sale-count" v-model.number="sellCount" type="number" min="1" :max="maxSale" :class="fieldClass" class="w-20" :disabled="controlsDisabled">
          <BaseButton type="button" variant="outline" class="min-h-11" :disabled="controlsDisabled" @click="sellCount = maxSale">最大</BaseButton>
          <BaseButton type="button" variant="primary" class="min-h-11" :disabled="controlsDisabled || !Number.isInteger(sellCount) || sellCount < 1 || sellCount > maxSale" @click="preview('sale', $event)">预览出售</BaseButton>
        </div>
      </div>
    </section>

    <section v-else-if="section === 'rewards'" :class="cardClass">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <h3 class="font-semibold">奖励目录</h3>
        <BaseButton type="button" variant="outline" class="min-h-11" :loading="working === 'catalog'" :disabled="controlsDisabled" @click="loadCatalog">读取兑换目录</BaseButton>
      </div>
      <p v-if="!goods?.length" class="mt-3" :class="infoClass">
        {{ goods ? '暂无可显示的兑换商品。' : '读取后可查看商品、价格和本次可换数量。' }}
      </p>
      <div v-else class="mt-3 space-y-3">
        <div class="grid gap-2">
          <label for="sweet-potato-goods" class="text-sm font-medium">兑换商品</label>
          <select id="sweet-potato-goods" v-model="exchangeIndex" :class="fieldClass" class="w-full sm:max-w-md" :disabled="controlsDisabled">
            <option :value="null">选择商品</option>
            <option v-for="row in goods" :key="row.index" :value="row.index">
              {{ row.name || `第 ${row.index} 档（商品待核实）` }} · {{ row.unitPrice }} 福气币
            </option>
          </select>
        </div>
        <p v-if="selectedGoods" :class="infoClass">
          {{ !selectedGoods.name || selectedGoods.limit === null ? '商品或兑换额度待确认。' : `当前可兑换 ${maxExchange} 份 · 余额 ${stock?.coins ?? 0} 福气币` }}
        </p>
        <div v-if="maxExchange > 0" class="space-y-2">
          <label for="sweet-potato-exchange-count" class="block text-sm font-medium">兑换份数</label>
          <div class="flex flex-wrap gap-2">
            <input id="sweet-potato-exchange-count" v-model.number="exchangeCount" type="number" min="1" :max="maxExchange" :class="fieldClass" class="w-20" :disabled="controlsDisabled">
            <BaseButton type="button" variant="primary" class="min-h-11" :disabled="controlsDisabled || !Number.isInteger(exchangeCount) || exchangeCount < 1 || exchangeCount > maxExchange" @click="preview('exchange', $event)">预览兑换</BaseButton>
          </div>
        </div>
      </div>
    </section>

    <section v-if="confirm" ref="confirmation" class="rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950 focus:outline-amber-700 dark:border-amber-800 dark:bg-amber-950/50 dark:text-amber-100" tabindex="-1" aria-label="操作预览" @keydown.esc.stop.prevent="cancelPreview">
      <p v-if="confirm === 'sale'">出售 {{ sellCount }} 个蜜薯，预计获得 {{ sellCount * (market?.unitPrice ?? 0) }} 福气币。</p>
      <p v-else-if="confirm === 'exchange'">兑换 {{ exchangeCount }} 份，预计使用 {{ exchangeCount * (selectedGoods?.unitPrice ?? 0) }} 福气币。</p>
      <p v-else-if="confirm === 'plantCrop'">使用 1 颗红薯种子，在 {{ landId }} 号地种植。</p>
      <p v-else>收获 {{ landId }} 号地的成熟红薯。</p>
      <div class="mt-3 flex flex-wrap gap-2">
        <BaseButton type="button" variant="primary" class="min-h-11" :disabled="controlsDisabled" @click="write(confirm)">确认操作</BaseButton>
        <BaseButton type="button" variant="outline" class="min-h-11" @click="cancelPreview">取消</BaseButton>
      </div>
    </section>

    <section v-if="section === 'market'" :class="cardClass">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 class="font-semibold">铺子分红</h3>
          <p class="mt-1 text-sm text-gray-600 dark:text-gray-300">{{ pendingDividend == null ? '待领分红尚未确认' : `待领 ${pendingDividend} 福气币` }}</p>
        </div>
        <BaseButton type="button" variant="primary" class="min-h-11" :loading="working === 'dividend'" :disabled="controlsDisabled || !(Number(pendingDividend) > 0)" @click="write('dividend')">领取分红</BaseButton>
      </div>
      <div class="mt-3 border-t border-gray-200 pt-3 dark:border-gray-700">
        <BaseButton type="button" variant="outline" class="min-h-11" :loading="working === 'records'" :disabled="controlsDisabled" @click="loadRecords">查询收购记录</BaseButton>
        <div v-if="records" class="mt-3" :class="infoClass">
          <p v-if="records.length === 0">暂无收购记录。</p>
          <ul v-else class="divide-y divide-gray-200 dark:divide-gray-700">
            <li v-for="(row, index) in records" :key="index" class="py-2">
              <span class="font-medium">{{ row.seller || '农友' }}</span> · 蜜薯 {{ row.count ?? '未知' }} 个 · 分红 {{ row.dividend ?? '未知' }}
            </li>
          </ul>
        </div>
      </div>
    </section>

    <template v-if="feedbackSection === section">
      <p v-if="error" class="break-words rounded-lg bg-red-50 px-3 py-2.5 text-sm text-red-800 dark:bg-red-950/30 dark:text-red-200" role="alert">{{ error }}</p>
      <p v-if="message" class="break-words rounded-lg bg-green-50 px-3 py-2.5 text-sm text-green-800 dark:bg-green-950/30 dark:text-green-200" role="status">{{ message }}</p>
    </template>
  </div>
</template>
