<script setup lang="ts">
import type { StarActivityData, StarGameplayGuide, StarSubActivity } from '@/stores/activity'
import { computed } from 'vue'
import BaseButton from '@/components/ui/BaseButton.vue'

const props = defineProps<{
  activity?: StarActivityData | null
  loading?: boolean
}>()

defineEmits<{
  claim: []
}>()

const record = computed(() => props.activity?.starRecord)

function stateLabel(item: StarActivityData['starRecord']['records'][number]) {
  if (item.claimed)
    return '已点亮'
  if (item.claimable)
    return '可点亮'
  return '未开放'
}

function formatTime(value?: number) {
  return value ? new Date(value * 1000).toLocaleString('zh-CN', { hour12: false }) : '-'
}

function guideIcon(icon: StarGameplayGuide['icon']) {
  return icon === 'claim' ? 'i-carbon-gift' : 'i-carbon-calendar'
}

function featureLabel(activity: StarSubActivity) {
  return activity.feature === 'starRecord' ? '观星礼录状态' : '星砂兑换商店状态'
}
</script>

<template>
  <section class="rounded-lg bg-white shadow-sm dark:bg-gray-800">
    <div class="flex flex-col gap-3 border-b border-gray-100 px-4 py-3 sm:flex-row sm:items-center sm:justify-between dark:border-gray-700">
      <div>
        <h2 class="text-base text-gray-900 font-semibold dark:text-gray-100">
          观星礼录
        </h2>
        <p class="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
          二十八星宿逐日开放，查看每日事件与奖励状态后领取当日馈赠
        </p>
      </div>
      <div class="flex items-center gap-2">
        <span class="rounded-lg bg-gray-50 px-2.5 py-1 text-xs text-gray-500 dark:bg-gray-900/40 dark:text-gray-300">
          已点亮 {{ record?.claimedCount || 0 }} / {{ record?.totalCount || 28 }}
        </span>
        <BaseButton
          class="w-28"
          variant="primary"
          :loading="loading"
          :disabled="!record?.claimableCount"
          @click="$emit('claim')"
        >
          一键点亮领取
        </BaseButton>
      </div>
    </div>

    <div class="p-4 space-y-4">
      <section class="rounded-xl from-indigo-950 via-sky-900 to-indigo-800 bg-gradient-to-r p-4 text-white">
        <div class="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div class="text-base font-semibold">
              {{ activity?.title || '心许千灯星垂野' }} · 观星礼录
            </div>
            <p class="mt-1 max-w-2xl text-xs text-white/75">
              官方说明确认：星宿共有二十八个，奖励每日投放；一键领取会收取当前全部已解锁星宿奖励。
            </p>
          </div>
          <div class="flex flex-wrap gap-2 text-xs">
            <span class="rounded-full bg-white/15 px-2.5 py-1">{{ activity?.inActivityWindow ? '活动期内' : '当前不在活动期' }}</span>
            <span class="rounded-full bg-white/15 px-2.5 py-1">已开放 {{ record?.unlockedCount || 0 }} / {{ record?.totalCount || 28 }}</span>
            <span class="rounded-full bg-amber-300/20 px-2.5 py-1 text-amber-100">可领取 {{ record?.claimableCount || 0 }}</span>
          </div>
        </div>
        <div class="mt-3 text-xs text-white/60">
          活动时间：{{ formatTime(activity?.startTime) }} — {{ formatTime(activity?.endTime) }} · 状态读取 1 分钟内重复刷新复用本地结果
        </div>
      </section>

      <section v-if="activity?.gameplayGuides?.length">
        <div class="flex flex-wrap items-end justify-between gap-2">
          <div>
            <h3 class="text-gray-900 font-semibold dark:text-white">
              观星礼录玩法流程
            </h3>
            <p class="mt-1 text-xs text-gray-500">
              流程来自活动说明；说明本身不用于推导 cmd 或请求字段。
            </p>
          </div>
          <span class="rounded-full bg-emerald-50 px-2.5 py-1 text-xs text-emerald-700 dark:bg-emerald-900/25 dark:text-emerald-200">
            已识别 {{ activity.gameplayGuides.length }} 个流程区块
          </span>
        </div>
        <div class="grid mt-3 gap-3 md:grid-cols-2">
          <article v-for="guide in activity.gameplayGuides" :key="guide.key" class="border border-sky-100 rounded-xl bg-sky-50/60 p-4 dark:border-sky-800/50 dark:bg-sky-950/20">
            <div class="flex items-center gap-2">
              <span :class="guideIcon(guide.icon)" class="text-xl text-sky-700 dark:text-sky-300" />
              <h4 class="text-sm text-gray-900 font-semibold dark:text-white">
                {{ guide.title }}
              </h4>
            </div>
            <ol class="mt-3 space-y-2">
              <li v-for="(step, index) in guide.steps" :key="step" class="flex gap-2 text-xs text-gray-600 leading-5 dark:text-gray-300">
                <span class="grid mt-0.5 h-4 w-4 shrink-0 place-items-center rounded-full bg-white text-[10px] text-sky-700 dark:bg-gray-800 dark:text-sky-200">{{ index + 1 }}</span>
                <span>{{ step }}</span>
              </li>
            </ol>
          </article>
        </div>
      </section>

      <section v-if="activity?.ruleWarnings?.length" class="border border-amber-200 rounded-xl bg-amber-50 p-4 dark:border-amber-800/60 dark:bg-amber-950/20">
        <div class="flex items-center gap-2 text-sm text-amber-800 font-semibold dark:text-amber-200">
          <span class="i-carbon-warning-alt" />
          补领与周期边界
        </div>
        <ul class="mt-2 text-xs text-amber-800 leading-5 space-y-1.5 dark:text-amber-200">
          <li v-for="warning in activity.ruleWarnings" :key="warning">
            • {{ warning }}
          </li>
        </ul>
      </section>

      <details v-if="activity?.subActivities?.length" class="border border-gray-100 rounded-xl p-4 dark:border-gray-700">
        <summary class="cursor-pointer text-sm text-gray-900 font-semibold dark:text-white">
          协议节点（诊断信息）
        </summary>
        <p class="mt-2 text-xs text-gray-500">
          节点字段只证明只读状态结构，不作为新增写操作证据。
        </p>
        <div class="grid mt-3 gap-2 md:grid-cols-2">
          <div v-for="child in activity.subActivities" :key="child.id" class="rounded-lg bg-gray-50 p-3 text-xs dark:bg-gray-900/30">
            <div class="flex items-start justify-between gap-2">
              <span class="text-gray-900 font-medium dark:text-white">{{ featureLabel(child) }}</span>
              <span class="text-gray-500">{{ child.statusLabel }}</span>
            </div>
            <div class="mt-1 text-gray-500">
              ID {{ child.id }} · type {{ child.type }} · protobuf field {{ child.protobufField }}
            </div>
            <div class="mt-1 text-gray-400">
              {{ child.protocolObserved ? '当前回包已观测对应只读字段' : '当前回包未观测对应字段' }}
            </div>
          </div>
        </div>
      </details>

      <div v-if="!record?.records?.length" class="p-8 text-center text-sm text-gray-500 dark:text-gray-400">
        暂无星宿数据
      </div>
      <div v-else class="grid grid-cols-[repeat(auto-fill,minmax(156px,1fr))] gap-3">
        <article
          v-for="item in record.records"
          :key="item.id"
          class="relative min-h-44 min-w-0 flex flex-col overflow-hidden border border-gray-200 rounded-lg p-3 dark:border-gray-700"
          :class="item.claimable ? 'bg-amber-50/60 dark:bg-amber-900/10' : 'bg-gray-50 dark:bg-gray-900/30'"
        >
          <img
            src="/activity/star-festival/constellation-glow.png"
            alt=""
            class="pointer-events-none absolute h-28 w-28 object-contain transition -right-8 -top-8"
            :class="item.claimed || item.claimable ? 'opacity-35' : 'grayscale opacity-10'"
          >
          <div class="relative flex items-center justify-between gap-2">
            <span class="text-sm text-gray-900 font-semibold dark:text-gray-100">{{ item.title }}</span>
            <span
              class="rounded px-1.5 py-0.5 text-[10px]"
              :class="item.claimed
                ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300'
                : item.claimable
                  ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300'
                  : 'bg-gray-200 text-gray-500 dark:bg-gray-700 dark:text-gray-300'"
            >
              {{ stateLabel(item) }}
            </span>
          </div>
          <div class="relative mt-1 text-xs text-sky-600 dark:text-sky-300">
            {{ item.category || '二十八星宿' }}
          </div>
          <p class="relative line-clamp-4 mt-2 text-xs text-gray-500 leading-5 dark:text-gray-400">
            {{ item.explain }}
          </p>
          <div v-if="item.rewards?.length" class="relative mt-auto flex flex-wrap gap-1 pt-3">
            <span
              v-for="reward in item.rewards"
              :key="`${item.id}-${reward.itemId}`"
              class="inline-flex items-center gap-1 rounded-full bg-white px-2 py-1 text-[10px] text-gray-600 dark:bg-gray-800 dark:text-gray-300"
            >
              <img v-if="reward.image" :src="reward.image" :alt="reward.itemName" class="h-4 w-4 object-contain">
              {{ reward.itemName }} ×{{ reward.itemCount }}
            </span>
          </div>
        </article>
      </div>
    </div>
  </section>
</template>
