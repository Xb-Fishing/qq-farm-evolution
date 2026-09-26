<script setup lang="ts">
import type { ClaimAllItemResult } from '@/stores/activity'
import { computed } from 'vue'
import BaseButton from '@/components/ui/BaseButton.vue'

// 活动中心「一键领取」控制区：只编排已有面板手动写入口（服务端每次操作前重读
// List+GetGroup 校验资格）；不自动抽签/购买/分享/夺宝/使用消耗道具。
const props = defineProps<{
  running: boolean
  disabled: boolean
  step: string
  results: ClaimAllItemResult[]
  /** 任一单项手动操作进行中（互斥：一键与单项不能并发） */
  hasOperating: boolean
}>()
const emit = defineEmits<{ (e: 'claim'): void }>()

const successCount = computed(() => props.results.filter(item => item.status === 'success').length)
const failedCount = computed(() => props.results.filter(item => item.status === 'failed').length)
const skippedCount = computed(() => props.results.filter(item => item.status === 'skipped').length)

function statusLabelOf(status: ClaimAllItemResult['status']) {
  return ({ success: '成功', failed: '失败', skipped: '跳过' })[status] || String(status || '')
}

function run() {
  if (props.running || props.disabled || props.hasOperating)
    return
  emit('claim')
}
</script>

<template>
  <div class="rounded-xl border border-emerald-200 bg-white p-3 shadow-sm dark:border-emerald-800/60 dark:bg-gray-800">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div class="min-w-0">
        <h2 class="text-base font-bold">
          一键领取
        </h2>
        <p class="mt-0.5 text-xs text-gray-500">
          仅领取当前账号已开放、已满足条件的免费奖励（S3 手记/补偿/比熊/种子、待领签文、快乐值每日与档位）；不自动抽签、购买、分享或使用消耗道具。
        </p>
      </div>
      <div class="flex items-center gap-2">
        <span v-if="running && step" class="text-xs text-emerald-600 dark:text-emerald-300">{{ step }}…</span>
        <BaseButton
          variant="primary"
          :loading="running"
          :disabled="disabled || running || hasOperating"
          title="每项写入前服务端会重新校验资格；部分失败会逐项展示，不会重复执行结果未知的项"
          @click="run"
        >
          一键领取
        </BaseButton>
      </div>
    </div>
    <div v-if="results.length" class="mt-3 space-y-1">
      <p class="text-xs text-gray-500">
        成功 {{ successCount }} · 失败 {{ failedCount }} · 跳过 {{ skippedCount }}（失败项结果未知时不会自动重试，请稍后刷新确认）
      </p>
      <ul class="space-y-1">
        <li
          v-for="item in results"
          :key="item.key"
          class="flex items-start gap-2 rounded px-2 py-1 text-xs"
          :class="item.status === 'success'
            ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-300'
            : item.status === 'failed'
              ? 'bg-red-50 text-red-600 dark:bg-red-900/20 dark:text-red-300'
              : 'bg-gray-50 text-gray-500 dark:bg-gray-900/40 dark:text-gray-400'"
        >
          <span class="shrink-0 font-medium">{{ statusLabelOf(item.status) }}</span>
          <span class="shrink-0">{{ String(item.label || '') }}</span>
          <span class="min-w-0 break-all">{{ String(item.detail || '') }}</span>
        </li>
      </ul>
    </div>
  </div>
</template>
