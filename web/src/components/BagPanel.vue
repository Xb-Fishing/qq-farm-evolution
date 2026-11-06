<script setup lang="ts">
import { useIntervalFn } from '@vueuse/core'
import { storeToRefs } from 'pinia'
import { computed, onUnmounted, ref, watch } from 'vue'
import ConfirmModal from '@/components/ConfirmModal.vue'
import PurchaseQuantityModal from '@/components/shop/PurchaseQuantityModal.vue'
import { useAccountStore } from '@/stores/account'
import { useBagStore } from '@/stores/bag'
import { useStatusStore } from '@/stores/status'
import { useToastStore } from '@/stores/toast'
import { allocateSale, exactDecimal, exactText, newOperationId } from '@/utils/commerce-quantity'

const accountStore = useAccountStore()
const bagStore = useBagStore()
const statusStore = useStatusStore()
const toastStore = useToastStore()
const { currentAccountId, currentAccount } = storeToRefs(accountStore)
const { items, loading: bagLoading, originalItems } = storeToRefs(bagStore)
const { status, loading: statusLoading, error: statusError, realtimeConnected, currentStatusReady } = storeToRefs(statusStore)
const imageErrors = ref<Record<string | number, boolean>>({})
const bagLoaded = ref(false)
const saleSelection = ref<any>(null)
const saleBusy = ref(false)
let generation = 0
let mounted = true
const CATEGORY_OPTIONS = [
  { label: '全部', value: 'all' },
  { label: '果实', value: 'fruit' },
  { label: '种子', value: 'seed' },
  { label: '道具', value: 'tool' },
  { label: '其他', value: 'other' },
] as const
type CategoryValue = typeof CATEGORY_OPTIONS[number]['value']
const selectedCategory = ref<CategoryValue>('fruit')
function getItemCategory(item: any): CategoryValue {
  const itemType = Number(item?.itemType || 0)
  if (itemType === 17 || itemType === 6)
    return 'fruit'
  if (itemType === 5)
    return 'seed'
  if (itemType === 11)
    return 'tool'
  return 'other'
}
const filteredItems = computed(() => {
  if (selectedCategory.value === 'all')
    return items.value
  return items.value.filter((item: any) => getItemCategory(item) === selectedCategory.value)
})
const categoryCounts = computed(() => {
  const counts: Record<CategoryValue, number> = { all: items.value.length, fruit: 0, seed: 0, tool: 0, other: 0 }
  for (const item of items.value) {
    const cat = getItemCategory(item)
    counts[cat]++
  }
  return counts
})
const confirmModal = ref({
  show: false,
  title: '',
  message: '',
  type: 'primary' as 'primary' | 'danger',
  loading: false,
  action: '' as 'sell' | 'use' | 'batchSell',
  item: null as any,
  selectedItems: [] as any[],
})
function invalidateConfirmations() {
  generation++
  saleSelection.value = null
  confirmModal.value.show = false
}
onUnmounted(() => {
  mounted = false
  invalidateConfirmations()
})
const batchMode = ref(false)
const selectedForBatch = ref<Set<number>>(new Set())
const batchSellResult = ref<{
  gold: number
  goldBean: number
} | null>(null)
const selectedSellableCount = computed(() => {
  return selectedForBatch.value.size
})
function getPriceClass(item: any) {
  const priceId = Number(item?.priceId || 0)
  if (priceId === 1005)
    return 'text-amber-400 dark:text-amber-300'
  if (priceId === 1002)
    return 'text-sky-400 dark:text-sky-300'
  return 'text-gray-400'
}
function canSell(item: any) {
  return Boolean(item?.sellable) && Boolean(item?.saleQuoteFingerprint)
}
function canBatchSell(item: any) {
  return canSell(item) && Number(item.count || 0) > 0
}
function canUse(item: any) {
  return Boolean(item?.usable) || Number(item?.itemType || 0) === 11
}
function handleSellClick(item: any) {
  if (batchMode.value) {
    const isSelected = selectedForBatch.value.has(Number(item.id))
    if (isSelected) {
      selectedForBatch.value.delete(Number(item.id))
    }
    else {
      selectedForBatch.value.add(Number(item.id))
    }
    return
  }
  if (!canSell(item) || saleBusy.value)
    return
  const stock = originalItems.value.filter(row => Number(row.id) === Number(item.id) && row.locked !== true)
    .reduce((sum, row) => sum + BigInt(exactDecimal(row.countDec ?? row.count) || '0'), 0n)
    .toString()
  saleSelection.value = { item: { ...item }, account: String(currentAccountId.value), generation, stock, operationId: newOperationId() }
}
async function confirmSale(count: string) {
  const saved = saleSelection.value
  if (!saved || saleBusy.value || saved.generation !== generation || saved.account !== String(currentAccountId.value))
    return
  saleBusy.value = true
  try {
    const payload = allocateSale(originalItems.value, Number(saved.item.id), count)
    const result = await bagStore.sellItems(saved.account, payload, { operationId: saved.operationId, quotes: { [saved.item.id]: saved.item.saleQuoteFingerprint }, explicitBatch: payload.length > 1 })
    if (!mounted || saved.generation !== generation || saved.account !== String(currentAccountId.value))
      return
    saleSelection.value = null
    if (result?.ok === true) {
      toastStore.success(`已确认出售 ${saved.item.name} × ${count}`)
      await loadBag()
    }
    else {
      toastStore.error(result?.error || '出售未确认，请刷新核对，不会自动重试')
    }
  }
  catch (error: any) {
    if (mounted && saved.generation === generation) {
      saleSelection.value = null
      toastStore.error(error.message || '出售未确认')
    }
  }
  finally {
    saleBusy.value = false
  }
}
function handleUseClick(item: any) {
  confirmModal.value = {
    show: true,
    title: '确认使用',
    message: `确定要使用全部 ${item.name || `物品${item.id}`} 吗?\n数量：${exactText(item.countDec ?? item.count ?? 0)}`,
    type: 'primary',
    loading: false,
    action: 'use',
    item,
    selectedItems: [],
  }
}
async function handleConfirm() {
  const modal = confirmModal.value
  const account = String(currentAccountId.value)
  const seq = generation
  if (!account || modal.loading || !modal.show)
    return
  modal.loading = true
  try {
    let result
    if (modal.action === 'batchSell') {
      const quotes = Object.fromEntries(items.value.filter(item => selectedForBatch.value.has(Number(item.id))).map(item => [item.id, item.saleQuoteFingerprint]))
      result = await bagStore.sellItems(account, modal.selectedItems, { quotes, explicitBatch: true, operationId: newOperationId() })
    }
    else if (modal.action === 'use' && modal.item) {
      const source = originalItems.value.find(row => Number(row.id) === Number(modal.item.id))
      const count = exactDecimal(modal.item.countDec ?? modal.item.count ?? 1)
      const uid = exactDecimal(source?.uidDec ?? source?.uid ?? 0)
      if (!count || !uid)
        throw new Error('物品数量或 UID 无法精确识别，请刷新背包')
      result = await bagStore.useItem(account, Number(modal.item.id), count, uid)
    }
    else {
      return
    }
    if (!mounted || seq !== generation || account !== String(currentAccountId.value) || confirmModal.value !== modal)
      return
    if (result?.ok === true) {
      toastStore.success(modal.action === 'use' ? '物品使用已确认' : '所选物品出售已确认')
      selectedForBatch.value.clear()
      batchMode.value = false
      await loadBag()
    }
    else {
      toastStore.error(result?.error || '操作未确认，请刷新核对')
    }
  }
  catch (error: any) {
    if (mounted && seq === generation)
      toastStore.error(error.message || '操作未确认')
  }
  finally {
    modal.loading = false
    modal.show = false
  }
}
function handleCancel() {
  confirmModal.value.show = false
}
function toggleBatchMode() {
  batchMode.value = !batchMode.value
  if (!batchMode.value) {
    selectedForBatch.value.clear()
    batchSellResult.value = null
  }
}
function selectAllSellable() {
  selectedForBatch.value.clear()
  for (const item of filteredItems.value) {
    if (canBatchSell(item)) {
      selectedForBatch.value.add(Number(item.id))
    }
  }
}
function handleBatchSellClick() {
  const sellableItems = filteredItems.value.filter((item: any) => canBatchSell(item))
  if (sellableItems.length === 0) {
    toastStore.warning('没有可批量出售的物品')
    return
  }
  const selectedList = Array.from(selectedForBatch.value)
  if (selectedList.length === 0) {
    toastStore.warning('请先选择要出售的物品')
    return
  }
  const itemsToSell = originalItems.value
    .filter((it: any) => selectedList.includes(Number(it.id)))
    .map((it: any) => ({ id: it.id, count: it.countDec || String(it.count), uid: it.uidDec || String(it.uid || 0) }))
  const totals = new Map<string, bigint>()
  for (const row of itemsToSell) {
    const item = items.value.find(item => Number(item.id) === Number(row.id))
    const amount = BigInt(exactDecimal(item?.priceDec ?? item?.price) || '0') * BigInt(row.count)
    const currency = String(item?.priceUnit || '金币')
    totals.set(currency, (totals.get(currency) || 0n) + amount)
  }
  const messages = [`确定出售所选 ${selectedList.length} 种物品？`, ...Array.from(totals, ([currency, value]) => `预计收入：${value.toLocaleString('zh-CN')} ${currency}`)]
  confirmModal.value = {
    show: true,
    title: '批量出售',
    message: messages.join('\n'),
    type: 'danger',
    loading: false,
    action: 'batchSell',
    item: null,
    selectedItems: itemsToSell,
  }
}
async function loadBag() {
  if (!currentAccountId.value)
    return
  const account = String(currentAccountId.value)
  const seq = generation
  const acc = currentAccount.value
  if (!acc)
    return
  try {
    if (!realtimeConnected.value)
      await statusStore.fetchStatus(account)
    if (mounted && seq === generation && account === String(currentAccountId.value) && acc.running)
      await bagStore.fetchBag(account)
  }
  finally {
    if (mounted && seq === generation && account === String(currentAccountId.value))
      bagLoaded.value = true
  }
  imageErrors.value = {}
}
const showInitialLoading = computed(() => !bagLoaded.value && (bagLoading.value || statusLoading.value))
watch(currentAccountId, (newId, oldId) => {
  invalidateConfirmations()
  selectedForBatch.value.clear()
  if (oldId !== undefined && newId !== oldId) {
    bagLoaded.value = false
    bagStore.clearBag()
    statusStore.clearAccountScopedData()
  }
  loadBag()
}, { immediate: true })
watch(() => currentAccount.value?.running, () => {
  loadBag()
})
watch(() => items.value.map(item => item.saleQuoteFingerprint).join('|'), () => {
  if (!saleBusy.value && !confirmModal.value.loading)
    invalidateConfirmations()
})
useIntervalFn(loadBag, 60000)
</script>

<template>
  <div class="space-y-4">
    <div class="mb-4 flex items-center justify-between">
      <h2 class="flex items-center gap-2 text-2xl font-bold">
        <div class="i-carbon-inventory-management" />
        背包
      </h2>
      <div v-if="items.length" class="text-sm text-gray-500">
        共 {{ items.length }} 种物品
      </div>
    </div>

    <div v-if="showInitialLoading" class="flex justify-center py-12">
      <div class="i-svg-spinners-90-ring-with-bg text-4xl text-blue-500" />
    </div>

    <div v-else-if="!currentAccountId" class="rounded-lg bg-white p-8 text-center text-gray-500 shadow dark:bg-gray-800">
      请选择账号后查看背包
    </div>

    <div v-else-if="statusError && items.length === 0" class="border border-red-200 rounded-lg bg-red-50 p-8 text-center text-red-500 shadow dark:border-red-800 dark:bg-red-900/20">
      <div class="mb-2 text-lg font-bold">
        获取数据失败
      </div>
      <div class="text-sm">
        {{ statusError }}
      </div>
    </div>

    <div v-else-if="currentStatusReady && !status?.connection?.connected && items.length === 0" class="flex flex-col items-center justify-center gap-4 rounded-lg bg-white p-12 text-center text-gray-500 shadow dark:bg-gray-800">
      <div class="i-carbon-connection-signal-off text-4xl text-gray-400" />
      <div>
        <div class="text-lg text-gray-700 font-medium dark:text-gray-300">
          账号未登录
        </div>
        <div class="mt-1 text-sm text-gray-400">
          请先运行账号或检查网络连接
        </div>
      </div>
    </div>

    <div v-else-if="items.length === 0" class="rounded-lg bg-white p-8 text-center text-gray-500 shadow dark:bg-gray-800">
      无可展示物品
    </div>

    <div v-else>
      <div class="mb-4 flex flex-wrap items-center gap-2">
        <button
          v-for="cat in CATEGORY_OPTIONS"
          :key="cat.value"
          class="rounded-lg px-3 py-1.5 text-sm font-medium transition"
          :class="selectedCategory === cat.value
            ? 'bg-blue-500 text-white dark:bg-blue-600'
            : 'bg-gray-100 text-gray-700 hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600'"
          @click="selectedCategory = cat.value"
        >
          {{ cat.label }}
          <span class="ml-1 text-xs opacity-70">({{ categoryCounts[cat.value] || 0 }})</span>
        </button>

        <div class="flex-1" />

        <template v-if="selectedCategory === 'fruit' || selectedCategory === 'all'">
          <button
            class="rounded-lg px-3 py-1.5 text-sm font-medium transition"
            :class="batchMode
              ? 'bg-orange-500 text-white dark:bg-orange-600'
              : 'bg-gray-100 text-gray-700 hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600'"
            @click="toggleBatchMode"
          >
            <div v-if="batchMode" class="i-carbon-close mr-1 inline-block" />
            {{ batchMode ? '取消批量' : '批量出售' }}
          </button>
          <template v-if="batchMode">
            <button
              class="rounded-lg bg-blue-500 px-3 py-1.5 text-sm text-white font-medium transition dark:bg-blue-600 hover:bg-blue-600 dark:hover:bg-blue-700"
              @click="selectAllSellable"
            >
              全选
            </button>
            <button
              class="rounded-lg px-3 py-1.5 text-sm font-medium transition"
              :class="selectedSellableCount > 0
                ? 'bg-red-500 text-white hover:bg-red-600 dark:bg-red-600 dark:hover:bg-red-700'
                : 'bg-gray-100 text-gray-400 dark:bg-gray-700 dark:text-gray-500'"
              :disabled="selectedSellableCount === 0"
              @click="handleBatchSellClick"
            >
              出售 ({{ selectedSellableCount }})
            </button>
          </template>
        </template>
      </div>

      <div class="grid grid-cols-2 gap-4 lg:grid-cols-5 md:grid-cols-4 sm:grid-cols-3 xl:grid-cols-6">
        <div
          v-for="item in filteredItems"
          :key="item.id"
          class="group relative flex flex-col items-center border rounded-lg bg-white p-3 transition dark:border-gray-700 dark:bg-gray-800 hover:shadow-md"
          :class="{
            'ring-2 ring-orange-500 dark:ring-orange-400': batchMode && selectedForBatch.has(Number(item.id)),
            'opacity-50': batchMode && canBatchSell(item) && !selectedForBatch.has(Number(item.id)),
          }"
          @click="batchMode && canBatchSell(item) && handleSellClick(item)"
        >
          <div class="absolute left-2 top-2 text-xs text-gray-400 font-mono">
            #{{ item.id }}
          </div>

          <div class="absolute right-1 top-1 flex gap-1">
            <template v-if="!batchMode">
              <button
                v-if="canSell(item)"
                class="rounded bg-red-500 px-1.5 py-0.5 text-[10px] text-white opacity-70 transition dark:bg-red-600 hover:opacity-100"
                title="选择出售数量"
                :aria-label="`出售 ${item.name}`"
                @click.stop="handleSellClick(item)"
              >
                售
              </button>
              <button
                v-if="canUse(item)"
                class="rounded bg-green-500 px-1.5 py-0.5 text-[10px] text-white opacity-70 transition dark:bg-green-600 hover:opacity-100"
                title="使用全部"
                @click.stop="handleUseClick(item)"
              >
                用
              </button>
            </template>
            <div
              v-else-if="canBatchSell(item)"
              class="h-5 w-5 flex items-center justify-center border-2 rounded transition"
              :class="selectedForBatch.has(Number(item.id))
                ? 'border-orange-500 bg-orange-500 text-white'
                : 'border-gray-300 bg-white dark:border-gray-600 dark:bg-gray-700'"
            >
              <div v-if="selectedForBatch.has(Number(item.id))" class="i-carbon-checkmark text-xs" />
            </div>
          </div>

          <div
            class="thumb-wrap mb-2 mt-6 h-16 w-16 flex items-center justify-center rounded-full bg-gray-50 dark:bg-gray-700/50"
            :data-fallback="(item.name || '物').slice(0, 1)"
          >
            <img
              v-if="item.image && !imageErrors[item.id]"
              :src="item.image"
              :alt="item.name"
              class="max-h-full max-w-full object-contain"
              loading="lazy"
              @error="imageErrors[item.id] = true"
            >
            <div v-else class="text-2xl text-gray-400 font-bold uppercase">
              {{ (item.name || '物').slice(0, 1) }}
            </div>
          </div>

          <div class="mb-1 w-full flex items-center justify-center gap-1 px-2 text-center text-sm font-bold" :title="item.name">
            <span class="truncate">{{ item.name || `物品${item.id}` }}</span>
            <span
              v-if="getItemCategory(item) === 'seed' && Number(item.plantSize) === 2"
              class="shrink-0 border border-emerald-300 rounded bg-emerald-50 px-1 py-0.5 text-[10px] text-emerald-700 font-semibold leading-none dark:border-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300"
              title="四格作物，占用 2×2 土地"
            >
              &lt;2x2&gt;
            </span>
          </div>

          <div class="mb-2 flex flex-col items-center gap-0.5 text-xs text-gray-400">
            <span v-if="item.uid">UID: {{ item.uid }}</span>
            <span>
              类型: {{ item.itemType || 0 }}
              <span v-if="item.level > 0"> · Lv{{ item.level }}</span>
              <span v-if="item.price > 0" :class="getPriceClass(item)"> · {{ item.price }}{{ item.priceUnit || '金' }}</span>
            </span>
          </div>

          <div class="mt-auto font-medium" :class="item.hoursText ? 'text-blue-500' : 'text-gray-600 dark:text-gray-300'">
            {{ item.hoursText || `x${exactText(item.countDec ?? item.count)}` }}
          </div>
        </div>
      </div>
    </div>

    <p v-if="bagStore.error" role="alert" class="text-sm text-red-600 dark:text-red-300">
      {{ bagStore.error }}
    </p>
    <PurchaseQuantityModal :show="!!saleSelection" mode="sell" title="确认出售" :item-name="saleSelection?.item.name || ''" :unit-price="saleSelection?.item.priceDec ?? null" :currency-label="saleSelection?.item.priceUnit || '金币'" :max-quantity="saleSelection?.stock || '0'" :loading="saleBusy" @confirm="confirmSale" @close="!saleBusy && (saleSelection = null)" @cancel="!saleBusy && (saleSelection = null)" />
    <ConfirmModal
      :show="confirmModal.show"
      :title="confirmModal.title"
      :message="confirmModal.message"
      :type="confirmModal.type"
      :loading="confirmModal.loading"
      :confirm-text="confirmModal.action === 'sell' ? '确认出售' : confirmModal.action === 'batchSell' ? '确认出售' : '确认使用'"
      @confirm="handleConfirm"
      @close="handleCancel"
      @cancel="handleCancel"
    />
  </div>
</template>

<style scoped>
.thumb-wrap.fallback img {
  display: none;
}

.thumb-wrap.fallback::after {
  content: attr(data-fallback);
  font-size: 1.5rem;
  font-weight: bold;
  color: #9ca3af;
  text-transform: uppercase;
}
</style>
