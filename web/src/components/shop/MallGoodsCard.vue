<script setup lang="ts">
import BaseButton from '@/components/ui/BaseButton.vue'
import { exactText } from '@/utils/commerce-quantity'

defineProps<{
  item: any
  canAfford?: boolean
  statusLabel?: string
  hint?: string
}>()
const emit = defineEmits<{
  (e: 'buy', item: any): void
}>()
</script>

<template>
  <article class="min-w-0 flex flex-col gap-3 border border-gray-200 rounded-xl bg-white p-4 text-gray-900 shadow-sm dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100">
    <div class="flex items-center gap-3">
      <img v-if="item.images?.[0]" :src="item.images[0]" :alt="item.name" class="h-14 w-14 shrink-0 object-contain">
      <h3 class="min-w-0 break-words text-sm font-semibold">
        {{ item.name }}
      </h3>
    </div>
    <p class="text-sm font-semibold">
      {{ item.isFree ? '免费' : `${exactText(item.price?.amountDec)} ${item.currencyName}` }} / 份
    </p>
    <ul class="text-sm text-gray-600 space-y-1 dark:text-gray-300">
      <li v-for="reward in item.items" :key="reward.id" class="break-words">
        每份：{{ reward.name }} × {{ exactText(reward.countDec) }}
      </li>
    </ul>
    <p class="text-sm text-gray-600 dark:text-gray-300">
      <template v-if="item.limit?.present">
        {{ item.limit.periodLabel || '本期' }}额度 {{ exactText(item.limit.limitCountDec) }} · 已购 {{ exactText(item.limit.boughtNumDec) }} · 剩余 {{ exactText(item.limit.remainingDec) }}
      </template>
      <template v-else>
        限购：{{ item.catalogRestricted === null ? '官方配置未设置限购' : '当前额度未知' }}
      </template>
    </p>
    <p v-if="item.purchaseBlockedReason" class="break-words text-sm text-red-600 dark:text-red-300">
      {{ item.purchaseBlockedReason }}
    </p>
    <BaseButton class="mt-auto min-h-11 w-full" variant="primary" :disabled="!item.canBuy" @click="emit('buy', item)">
      {{ item.canBuy ? '选择购买数量' : '当前不可购买' }}
    </BaseButton>
  </article>
</template>
