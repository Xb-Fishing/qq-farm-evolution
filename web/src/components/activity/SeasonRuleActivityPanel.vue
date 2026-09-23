<script setup lang="ts">
import type { SeasonRuleActivityData } from '@/stores/activity'
import BaseButton from '@/components/ui/BaseButton.vue'

// 秋祈良愿 / 快乐不独享共用的说明驱动只读面板：两组活动均无官方成功操作样本，
// 不提供任何操作按钮；玩法卡只展示说明已确认的流程与状态边界。
defineProps<{
  activity: SeasonRuleActivityData | null
  loading: boolean
  heading: string
  subtitle: string
}>()
defineEmits<{ (e: 'refresh'): void }>()

function time(value: number) {
  return value ? new Date(value * 1000).toLocaleString() : '未下发'
}
</script>

<template>
  <section class="rounded-xl bg-white p-4 shadow-sm space-y-4 dark:bg-gray-800">
    <header class="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h2 class="text-lg font-bold">
          {{ heading }}
        </h2>
        <p class="mt-1 text-sm text-gray-500">
          {{ subtitle }}
        </p>
      </div>
      <BaseButton variant="secondary" :loading="loading" @click="$emit('refresh')">
        刷新只读状态
      </BaseButton>
    </header>
    <p class="text-xs text-gray-500">
      1 分钟内重复刷新复用本地结果；当前未接入任何写操作，请在官方客户端人工参与。
    </p>

    <p v-if="!activity" class="py-6 text-center text-sm text-gray-500">
      {{ loading ? '正在读取活动状态…' : '当前没有可用活动快照（活动未由当前 List 下发时自动停止读取）。' }}
    </p>
    <template v-else>
      <div class="rounded-lg bg-sky-50 p-3 text-sm dark:bg-sky-950/30">
        <p class="font-medium">
          {{ activity.statusLabel }}
        </p>
        <p class="mt-1 text-xs">
          {{ time(activity.startTime) }} — {{ time(activity.endTime) }}
        </p>
      </div>

      <section>
        <h3 class="mb-3 font-semibold">
          玩法流程与当前状态
        </h3>
        <p v-if="!activity.gameplayGuides.length" class="text-sm text-gray-500">
          当前快照缺少活动说明，暂不推断参与流程。
        </p>
        <div class="grid items-start gap-3 lg:grid-cols-2">
          <article v-for="guide in activity.gameplayGuides" :key="guide.key" class="border border-gray-200 rounded-lg p-4 dark:border-gray-700">
            <h4 class="font-semibold">
              {{ guide.title }}
            </h4>
            <ul class="mt-2 list-disc pl-5 text-sm leading-6 space-y-1.5">
              <li v-for="(step, index) in guide.steps" :key="index">
                {{ step }}
              </li>
            </ul>
            <p class="mt-3 rounded bg-gray-50 p-2 text-xs text-gray-500 dark:bg-gray-900/40">
              {{ guide.missingState }}：当前快照未提供该实时状态，待官方字段证据，未知不按 0 处理。
            </p>
            <BaseButton class="mt-3" variant="secondary" size="sm" disabled>
              {{ guide.actionLabel }} · 操作协议待确认
            </BaseButton>
          </article>
        </div>
      </section>

      <aside v-if="activity.notices.length" class="rounded-lg bg-amber-50 p-4 text-sm dark:bg-amber-950/30">
        <h3 class="font-semibold">
          活动提示
        </h3>
        <ul class="mt-2 list-disc pl-5 space-y-1">
          <li v-for="(notice, index) in activity.notices" :key="index">
            {{ notice }}
          </li>
        </ul>
      </aside>

      <details class="border border-gray-200 rounded-lg p-3 text-xs dark:border-gray-700">
        <summary class="cursor-pointer font-medium">
          适配边界与活动节点
        </summary>
        <ul class="mt-3 list-disc pl-5 space-y-1">
          <li v-for="item in activity.missingEvidence" :key="item">
            {{ item }}
          </li>
        </ul>
        <p class="mt-3">
          根节点 {{ activity.activityId }}；客户端界面标识 {{ activity.clientUiUid || '未下发' }}；活动读取使用空 UID，不将界面标识作为请求参数。
        </p>
        <div v-for="node in activity.subActivities" :key="node.id" class="mt-2 border-t border-gray-100 pt-2 dark:border-gray-700">
          {{ node.title }} · {{ node.id }} / parent {{ node.parentId }} / type {{ node.type }} · {{ node.statusLabel }}
          <p>{{ time(node.startTime) }} — {{ time(node.endTime) }} · 界面标识 {{ node.clientUiUid || '未下发' }}</p>
          <p>字段 {{ node.protobufField }} · {{ node.protocolObserved ? '已观测（结构诊断，不解释业务字段）' : '未观测' }} · 只读</p>
        </div>
      </details>
    </template>
  </section>
</template>
