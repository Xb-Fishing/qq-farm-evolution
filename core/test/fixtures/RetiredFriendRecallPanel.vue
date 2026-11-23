<script setup lang="ts">
import type { FriendRecallActivity } from './retired-friend-recall-store'
import BaseButton from '@/components/ui/BaseButton.vue'

defineProps<{ activity: FriendRecallActivity | null, loading: boolean, error: string }>()
defineEmits<{ refresh: [] }>()
function dateLabel(value: unknown) {
  const n = value == null ? Number.NaN : Number(value)
  return Number.isFinite(n) && n > 0 && !Number.isNaN(new Date(n * 1000).getTime())
    ? new Date(n * 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })
    : '时间未提供'
}
</script>

<template>
  <section v-if="activity?.available !== false" id="friend-recall" class="min-w-0 rounded-xl bg-white p-4 text-gray-800 shadow-sm dark:bg-gray-800 dark:text-gray-100">
    <header class="flex flex-wrap items-center justify-between gap-3">
      <h2 class="[overflow-wrap:anywhere] min-w-0 flex-1 break-words text-lg font-bold">
        {{ activity?.title || '故友重逢' }}
      </h2>
      <BaseButton variant="outline" size="lg" class="dark:text-white" :loading="loading" @click="$emit('refresh')">
        刷新规则
      </BaseButton>
    </header>
    <p class="mt-2 text-sm">
      规则参考；邀请、互动和领奖请在官方游戏中操作。
    </p>
    <p v-if="loading" role="status">
      正在读取规则…
    </p>
    <p v-if="error" role="alert" class="mt-2 break-words text-red-600 dark:text-red-400">
      {{ error }}
    </p>
    <p v-if="!activity && !loading && !error">
      尚未读取规则
    </p>
    <template v-if="activity?.available">
      <p class="mt-2 break-words text-sm">
        活动时间（北京时间）：{{ dateLabel(activity.startTime) }} — {{ dateLabel(activity.endTime) }}
      </p>
      <p class="mt-2 text-sm">
        个人身份、召回进度、领取状态及增益剩余时间：未知，请在官方游戏核对。
      </p>
      <p class="mt-2 text-sm">
        {{ activity.eligibility }}
      </p>
      <div class="grid mt-3 min-w-0 gap-3 md:grid-cols-2">
        <section v-for="section in activity.sections || []" :key="section.key" class="min-w-0 rounded-lg bg-gray-50 p-3 dark:bg-gray-900/50">
          <h3 class="font-bold">
            {{ section.title }}
          </h3>
          <p v-if="!section.lines.length" class="text-sm">
            当前未提供规则详情
          </p>
          <p v-for="(line, index) in section.lines" :key="index" class="[overflow-wrap:anywhere] mt-2 whitespace-pre-wrap break-words text-sm leading-6">
            {{ line }}
          </p>
        </section>
      </div>
    </template>
  </section>
</template>
