<script setup lang="ts">
import { computed, ref, watch } from 'vue'
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

const props = defineProps<{
  accountId: string
  seedsClaimed: boolean | null
  pendingDividend: number | null
}>()
const emit = defineEmits<{ changed: [] }>()
const route = '/api/activity/sweet-potato/trade'
const busy = ref(false)
const message = ref('')
const error = ref('')
const market = ref<Quote | null>(null)
const stock = ref<Stock | null>(null)
const goods = ref<Goods[]>([])
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
const selectedGoods = computed(() => goods.value.find(row => row.index === exchangeIndex.value))
const maxSale = computed(() => market.value?.acceptsSales === true
  ? Math.min(stock.value?.potatoes ?? 0, market.value.remaining ?? 0)
  : 0)
const maxExchange = computed(() => selectedGoods.value?.name
  ? Math.min(selectedGoods.value.limit ?? 0, Math.floor((stock.value?.coins ?? 0) / selectedGoods.value.unitPrice))
  : 0)
let generation = 0

watch(() => props.accountId, () => {
  generation++
  busy.value = false
  market.value = null
  stock.value = null
  goods.value = []
  records.value = null
  plots.value = null
  landId.value = null
  exchangeIndex.value = null
  selectedShop.value = ''
  confirm.value = null
  message.value = ''
  error.value = ''
})
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

async function run(action: (account: string, current: () => boolean) => Promise<void>) {
  if (busy.value || !props.accountId)
    return
  const account = props.accountId
  const currentGeneration = generation
  const current = () => account === props.accountId && currentGeneration === generation
  error.value = ''
  message.value = ''
  busy.value = true
  try {
    await action(account, current)
  }
  catch (e: any) {
    if (current())
      error.value = e?.response?.data?.error || e?.message || '活动操作未完成，请核对状态'
  }
  finally {
    if (current())
      busy.value = false
  }
}

function loadQuote() {
  market.value = null
  confirm.value = null
  const shop = selectedShop.value.trim()
  return run(async (account, current) => {
    const data = await request<{ quote: Quote, stock: Stock }>('quote', account, undefined, { shop })
    if (current() && shop === selectedShop.value.trim()) {
      market.value = data.quote
      stock.value = data.stock
    }
  })
}

function loadCatalog() {
  confirm.value = null
  return run(async (account, current) => {
    const data = await request<{ catalog: Goods[], stock: Stock }>('catalog', account)
    if (current()) {
      goods.value = data.catalog
      stock.value = data.stock
    }
  })
}

function loadRecords() {
  return run(async (account, current) => {
    const result = await request<Row[]>('records', account)
    if (current())
      records.value = result
  })
}

function loadPlots() {
  confirm.value = null
  return run(async (account, current) => {
    const result = await request<Plots>('plots', account)
    if (current()) {
      plots.value = result
      landId.value = null
    }
  })
}

function write(action: Action) {
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
  return run(async (account, current) => {
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
        goods.value = []
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
  <div class="grid gap-4">
    <div class="flex flex-wrap gap-2">
      <BaseButton type="button" variant="primary" size="sm" :disabled="busy || seedsClaimed !== false" @click="write('seeds')">
        {{ seedsClaimed ? '今日种子已领取' : '领取今日红薯种子' }}
      </BaseButton>
      <BaseButton type="button" variant="outline" size="sm" :disabled="busy || !(Number(pendingDividend) > 0)" @click="write('dividend')">
        领取分红
      </BaseButton>
      <BaseButton type="button" variant="outline" size="sm" :disabled="busy" @click="loadRecords">
        查询收购记录
      </BaseButton>
    </div>
    <section class="space-y-2">
      <div class="flex flex-wrap items-center gap-2">
        <h4 class="font-medium">种植与收获红薯</h4>
        <BaseButton type="button" variant="outline" size="sm" :disabled="busy" @click="loadPlots">读取当前土地</BaseButton>
      </div>
      <p v-if="plots && !plots.empty.length && !plots.ready.length" class="text-sm text-gray-600 dark:text-gray-300">
        暂无可种空地或已成熟红薯。
      </p>
      <div v-else-if="plots" class="flex flex-wrap items-center gap-2">
        <label for="sweet-potato-land" class="text-sm">土地</label>
        <select id="sweet-potato-land" v-model="landId" class="rounded-md border border-gray-300 bg-white px-2 py-1 text-sm dark:border-gray-600 dark:bg-gray-800" :disabled="busy">
          <option :value="null">选择土地</option>
          <option v-for="id in plots.empty" :key="id" :value="id">{{ id }} 号地 · 可种</option>
          <option v-for="id in plots.ready" :key="id" :value="id">{{ id }} 号地 · 红薯成熟</option>
        </select>
        <BaseButton type="button" variant="primary" size="sm" :disabled="busy || !plotAction" @click="confirm = plotAction">
          {{ plotAction === 'harvestCrop' ? '收获红薯' : '种植红薯' }}
        </BaseButton>
      </div>
    </section>
    <section class="space-y-2">
      <h4 class="font-medium">出售蜜薯</h4>
      <form class="flex flex-wrap items-center gap-2" @submit.prevent="loadQuote">
        <label for="sweet-potato-shop" class="text-sm">好友 GID（留空查询自己的铺子）</label>
        <input id="sweet-potato-shop" v-model="selectedShop" inputmode="numeric" class="rounded-md border border-gray-300 bg-white px-2 py-1 text-sm dark:border-gray-600 dark:bg-gray-800 w-36" :disabled="busy">
        <BaseButton type="submit" variant="outline" size="sm" :disabled="busy">查询收购价</BaseButton>
      </form>
      <p v-if="market" class="text-sm">
        {{ market.name || '所选铺子' }}，每个 {{ market.unitPrice }} 福气币。当前可售 {{ maxSale }} 个。
      </p>
      <div v-if="maxSale > 0" class="flex flex-wrap items-center gap-2">
        <label for="sweet-potato-sale-count" class="text-sm">数量</label>
        <input id="sweet-potato-sale-count" v-model.number="sellCount" type="number" min="1" :max="maxSale" class="rounded-md border border-gray-300 bg-white px-2 py-1 text-sm dark:border-gray-600 dark:bg-gray-800 w-24" :disabled="busy">
        <BaseButton type="button" variant="outline" size="sm" :disabled="busy" @click="sellCount = maxSale">最大</BaseButton>
        <BaseButton type="button" variant="primary" size="sm" :disabled="busy || !Number.isInteger(sellCount) || sellCount < 1 || sellCount > maxSale" @click="confirm = 'sale'">
          预览出售
        </BaseButton>
      </div>
    </section>
    <section class="space-y-2">
      <div class="flex flex-wrap items-center gap-2">
        <h4 class="font-medium">兑换奖励</h4>
        <BaseButton type="button" variant="outline" size="sm" :disabled="busy" @click="loadCatalog">读取兑换目录</BaseButton>
      </div>
      <div v-if="goods.length" class="flex flex-wrap items-center gap-2">
        <label for="sweet-potato-goods" class="text-sm">兑换档位</label>
        <select id="sweet-potato-goods" v-model="exchangeIndex" class="rounded-md border border-gray-300 bg-white px-2 py-1 text-sm dark:border-gray-600 dark:bg-gray-800" :disabled="busy">
          <option :value="null">请选择</option>
          <option v-for="row in goods" :key="row.index" :value="row.index">
            {{ row.name || `第 ${row.index} 档（商品待核实）` }} · {{ row.unitPrice }} 福气币
          </option>
        </select>
        <label for="sweet-potato-exchange-count" class="text-sm">份数</label>
        <input id="sweet-potato-exchange-count" v-model.number="exchangeCount" type="number" min="1" :max="maxExchange" class="rounded-md border border-gray-300 bg-white px-2 py-1 text-sm dark:border-gray-600 dark:bg-gray-800 w-24" :disabled="busy">
        <BaseButton type="button" variant="primary" size="sm" :disabled="busy || !Number.isInteger(exchangeCount) || exchangeCount < 1 || exchangeCount > maxExchange" @click="confirm = 'exchange'">
          预览兑换
        </BaseButton>
      </div>
    </section>
    <div v-if="confirm" class="rounded border border-amber-300 p-3" aria-live="polite">
      <p v-if="confirm === 'sale'">出售 {{ sellCount }} 个蜜薯，预计获得 {{ sellCount * (market?.unitPrice ?? 0) }} 福气币。</p>
      <p v-else-if="confirm === 'exchange'">兑换 {{ exchangeCount }} 份，预计使用 {{ exchangeCount * (selectedGoods?.unitPrice ?? 0) }} 福气币。</p>
      <p v-else-if="confirm === 'plantCrop'">使用 1 颗红薯种子，在 {{ landId }} 号地种植。</p>
      <p v-else>收获 {{ landId }} 号地的成熟红薯。</p>
      <div class="mt-2 flex gap-2">
        <BaseButton type="button" variant="primary" size="sm" :disabled="busy" @click="write(confirm)">确认操作</BaseButton>
        <BaseButton type="button" variant="outline" size="sm" :disabled="busy" @click="confirm = null">取消</BaseButton>
      </div>
    </div>
    <div v-if="records" class="text-sm">
      <p v-if="records.length === 0">暂无收购记录</p>
      <ul v-else class="space-y-1">
        <li v-for="(row, index) in records" :key="index">
          {{ row.seller || '农友' }} · 蜜薯 {{ row.count ?? '未知' }} 个 · 分红 {{ row.dividend ?? '未知' }}
        </li>
      </ul>
    </div>
    <p v-if="error" class="text-sm text-red-700 dark:text-red-300" role="alert">{{ error }}</p>
    <p v-if="message" class="text-sm text-green-700 dark:text-green-300" role="status">{{ message }}</p>
  </div>
</template>
