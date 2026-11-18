<script setup lang="ts">
import type { MugeActivity } from '@/stores/muge'
import BaseButton from '@/components/ui/BaseButton.vue'

defineProps<{ activity: MugeActivity | null, loading: boolean, error: string }>()
defineEmits<{ refresh: [] }>()
function dateLabel(value: unknown) {
  const n = value == null ? Number.NaN : Number(value)
  return Number.isFinite(n) && n > 0 && !Number.isNaN(new Date(n * 1000).getTime())
    ? new Date(n * 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })
    : '时间未提供'
}
</script>

<template>
  <section v-if="activity?.available !== false" id="muge" class="min-w-0 rounded-xl bg-white p-4 text-gray-800 shadow-sm dark:bg-gray-800 dark:text-gray-100">
    <header class="flex flex-wrap items-center justify-between gap-3">
      <h2 class="[overflow-wrap:anywhere] min-w-0 flex-1 break-words text-lg font-bold">
        {{ activity?.title || '牧歌初启' }}
      </h2>
      <BaseButton variant="outline" size="lg" class="min-h-11 dark:text-white" :loading="loading" @click="$emit('refresh')">
        刷新牧歌规则
      </BaseButton>
    </header>
    <p class="mt-2 text-sm">
      此处提供牧歌初启活动规则与参与条件；活动专属个人进度和领奖状态尚未取得。牧场经营与牧场任务已在本页提供入口。
    </p>
    <BaseButton href="#ranch" variant="secondary" class="mt-2 min-h-11">
      前往牧场经营与任务
    </BaseButton>
    <p v-if="loading" role="status" class="mt-2">
      正在读取牧歌规则…
    </p>
    <p v-if="error" role="alert" class="mt-2 break-words text-red-600 dark:text-red-400">
      {{ error }}
    </p>
    <p v-if="!activity && !loading && !error" class="mt-2">
      尚未读取活动信息
    </p>
    <template v-if="activity?.available">
      <p class="mt-2 break-words text-sm">
        活动时间（北京时间）：{{ dateLabel(activity.startTime) }} — {{ dateLabel(activity.endTime) }}
      </p>
      <p v-if="activity.phase === 'upcoming'" class="mt-2 text-sm">
        活动尚未开始，开放后可手动刷新规则。
      </p>
      <div class="grid mt-3 min-w-0 gap-3 md:grid-cols-2">
        <section v-for="section in activity.sections || []" :key="section.key" class="min-w-0 rounded-lg bg-gray-50 p-3 dark:bg-gray-900/50">
          <h3 class="font-bold">
            {{ section.title }}
          </h3>
          <p v-for="(line, index) in section.lines" :key="index" class="[overflow-wrap:anywhere] mt-2 whitespace-pre-wrap break-words text-sm leading-6">
            {{ line }}
          </p>
          <p class="mt-2 text-sm text-gray-600 dark:text-gray-300">
            个人资格、进度、奖励数量与领取状态尚未取得；当前规则不代表已经解锁或可以领取。
          </p>
        </section>
      </div>
      <p v-for="(note, index) in activity.notes || []" :key="index" class="mt-3 break-words text-sm">
        {{ note }}
      </p>
    </template>
  </section>
</template>
