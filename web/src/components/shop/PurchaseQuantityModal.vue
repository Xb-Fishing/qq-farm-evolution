<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, watch } from 'vue'
import BaseButton from '@/components/ui/BaseButton.vue'
import { exactDecimal, exactText } from '@/utils/commerce-quantity'

const props = withDefaults(defineProps<{
  show: boolean
  title?: string
  itemName: string
  unitPrice: string | number | null
  currencyLabel: string
  balance?: string | number | null
  maxQuantity?: string | number
  loading?: boolean
  isFree?: boolean
  mode?: 'buy' | 'sell'
  itemCount?: string | number
}>(), { title: '确认购买', maxQuantity: 99, loading: false, isFree: false, mode: 'buy', itemCount: 1, balance: null })
const emit = defineEmits<{
  (e: 'confirm', quantity: string): void
  (e: 'close'): void
  (e: 'cancel'): void
}>()
const quantity = ref('1')
const input = ref<HTMLInputElement | null>(null)
let previousFocus: HTMLElement | null = null
const max = computed(() => {
  const cap = exactDecimal(props.maxQuantity)
  const price = exactDecimal(props.unitPrice)
  if (cap === null || price === null)
    return '0'
  if (props.mode === 'sell' || props.isFree || price === '0')
    return cap
  const balance = exactDecimal(props.balance)
  if (balance === null)
    return '0'
  const affordable = BigInt(balance) / BigInt(price)
  return (affordable < BigInt(cap) ? affordable : BigInt(cap)).toString()
})
const valid = computed(() => {
  const count = exactDecimal(quantity.value)
  return !props.loading && count !== null && BigInt(count) > 0n && BigInt(count) <= BigInt(max.value)
})
const total = computed(() => {
  const count = exactDecimal(quantity.value)
  const price = exactDecimal(props.unitPrice)
  return count === null || price === null ? '未知' : (BigInt(count) * BigInt(price)).toLocaleString('zh-CN')
})
const pieces = computed(() => {
  const count = exactDecimal(quantity.value)
  const each = exactDecimal(props.itemCount)
  return count && each ? (BigInt(count) * BigInt(each)).toLocaleString('zh-CN') : '未知'
})
function close(cancel = false) {
  if (props.loading)
    return
  if (cancel)
    emit('cancel')
  else
    emit('close')
}
function keydown(event: KeyboardEvent) {
  if (!props.show)
    return
  if (event.key === 'Escape') {
    event.preventDefault()
    close(true)
  }
  if (event.key === 'Tab' && typeof document !== 'undefined') {
    const controls = Array.from(document.querySelectorAll<HTMLElement>('[data-quantity-dialog] input, [data-quantity-dialog] button:not(:disabled)'))
    const first = controls[0]
    const last = controls[controls.length - 1]
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last?.focus()
    }
    else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first?.focus()
    }
  }
}
watch(() => props.show, async (show) => {
  if (show) {
    quantity.value = '1'
    previousFocus = typeof document !== 'undefined' ? document.activeElement as HTMLElement : null
    if (typeof window !== 'undefined')
      window.addEventListener?.('keydown', keydown)
    await nextTick()
    input.value?.focus?.()
  }
  else {
    if (typeof window !== 'undefined')
      window.removeEventListener?.('keydown', keydown)
    previousFocus?.focus?.()
  }
}, { immediate: true })
onUnmounted(() => {
  if (typeof window !== 'undefined')
    window.removeEventListener?.('keydown', keydown)
})
</script>

<template>
  <div v-if="show" class="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-black/50 p-3" @click.self="close()">
    <section data-quantity-dialog role="dialog" aria-modal="true" aria-labelledby="quantity-title" class="commerce-quantity-dialog my-auto max-w-md min-w-0 w-full rounded-xl bg-white p-5 text-gray-900 shadow-xl space-y-4 dark:bg-gray-800 dark:text-gray-100">
      <h2 id="quantity-title" class="text-lg font-semibold">
        {{ title }}
      </h2>
      <p class="break-words font-medium">
        {{ itemName }}
      </p>
      <p class="text-sm">
        {{ mode === 'sell' ? '预计单件收入' : '每份单价' }}：{{ isFree ? '免费' : `${exactText(unitPrice)} ${currencyLabel}` }}
      </p>
      <p v-if="mode === 'buy'" class="text-sm">
        每份 {{ exactText(itemCount) }} 件 · 本次共 {{ pieces }} 件
      </p>
      <label class="block text-sm" for="purchase-quantity">数量（{{ mode === 'sell' ? '件' : '份' }}）</label>
      <div class="flex gap-2">
        <input id="purchase-quantity" ref="input" v-model="quantity" aria-label="数量" inputmode="numeric" autocomplete="off" class="min-h-11 min-w-0 w-full border border-gray-300 rounded-lg bg-white px-3 text-gray-900 dark:border-gray-600 dark:bg-gray-900 dark:text-white" :disabled="loading">
        <BaseButton class="min-h-11 shrink-0 whitespace-nowrap" variant="outline" :disabled="loading || max === '0'" @click="quantity = max">
          最大
        </BaseButton>
      </div>
      <p class="text-sm text-gray-600 dark:text-gray-300">
        当前最多 {{ exactText(max) }} {{ mode === 'sell' ? '件' : '份' }}<span v-if="mode === 'buy'">（本地单次上限 99 份）</span>
      </p>
      <p v-if="max === '0'" role="alert" class="text-sm text-red-600 dark:text-red-300">
        当前无可用额度，或余额、价格、资格尚未确认。
      </p>
      <p v-else-if="!valid && !loading" role="alert" class="text-sm text-red-600 dark:text-red-300">
        请输入不超过当前上限的正整数。
      </p>
      <p class="break-words text-base font-semibold">
        {{ mode === 'sell' ? '预计收入' : '总消耗' }}：{{ isFree ? '免费' : `${total} ${currencyLabel}` }}
      </p>
      <p v-if="mode === 'buy'" class="text-sm text-gray-600 dark:text-gray-300">
        余额：{{ exactText(balance) }} {{ currencyLabel }}
      </p>
      <div class="flex flex-wrap justify-end gap-2">
        <BaseButton variant="outline" :disabled="loading" @click="close(true)">
          取消
        </BaseButton>
        <BaseButton variant="primary" :loading="loading" :disabled="!valid" @click="valid && emit('confirm', quantity)">
          {{ mode === 'sell' ? '确认出售' : '确认购买' }}
        </BaseButton>
      </div>
    </section>
  </div>
</template>

<style scoped>
.commerce-quantity-dialog {
  background-color: #fff !important;
  color: #111827;
}
:global(html.dark .commerce-quantity-dialog) {
  background-color: #1f2937 !important;
  color: #f3f4f6;
}
</style>
