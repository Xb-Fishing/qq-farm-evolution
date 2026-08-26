<script setup lang="ts">
import type { WeatherActivityData, WeatherSubActivity } from '@/stores/activity'
import BaseButton from '@/components/ui/BaseButton.vue'

defineProps<{
  activity?: WeatherActivityData | null
  loading?: boolean
}>()

defineEmits<{ refresh: [] }>()

function formatTime(value?: number) {
  return value ? new Date(value * 1000).toLocaleString('zh-CN', { hour12: false }) : '-'
}

function featureLabel(activity: WeatherSubActivity) {
  if (activity.feature === 'exchangeShop')
    return '兑换商店（只读）'
  if (activity.feature === 'draw')
    return '抽奖状态（只读）'
  return `未命名玩法（type ${activity.type}）`
}
</script>

<template>
  <div class="space-y-4">
    <section class="overflow-hidden rounded-lg bg-white shadow-sm dark:bg-gray-800">
      <div class="from-slate-700 via-sky-700 to-indigo-800 bg-gradient-to-r px-5 py-4 text-white">
        <div class="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div class="flex items-center gap-2">
              <span class="i-carbon-rain-heavy text-3xl" />
              <h2 class="text-lg font-bold">
                {{ activity?.title || '雨落成诗' }}
              </h2>
            </div>
            <p class="mt-1 text-sm text-white/80">
              雷雨天气与天气瓶活动 · 当前仅提供已证实的只读状态
            </p>
          </div>
          <BaseButton variant="secondary" :loading="loading" @click="$emit('refresh')">
            刷新只读状态
          </BaseButton>
        </div>
      </div>

      <div class="p-5 space-y-4">
        <div class="flex flex-wrap gap-2 text-xs">
          <span class="rounded-full px-2.5 py-1" :class="activity?.active ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-900/25 dark:text-emerald-200' : 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300'">
            {{ activity?.active ? '活动进行中' : '当前未启用' }}
          </span>
          <span class="rounded-full bg-amber-50 px-2.5 py-1 text-amber-700 dark:bg-amber-900/25 dark:text-amber-200">
            写操作未接入
          </span>
          <span class="rounded-full bg-sky-50 px-2.5 py-1 text-sky-700 dark:bg-sky-900/25 dark:text-sky-200">
            客户端界面标识 {{ activity?.clientUiUid || 'WeatherBottleUI' }}
          </span>
        </div>

        <div class="grid gap-3 md:grid-cols-2">
          <div v-for="item in [activity?.items.weatherBottle, activity?.items.drawReward]" :key="item?.itemId" class="flex items-center gap-3 rounded-xl bg-slate-50 p-4 dark:bg-gray-900/35">
            <div class="grid h-12 w-12 shrink-0 place-items-center rounded-lg bg-sky-100 dark:bg-sky-900/30">
              <img v-if="item?.image" :src="item.image" alt="" class="h-10 w-10 object-contain">
              <span v-else class="i-carbon-chemistry text-2xl text-sky-700 dark:text-sky-200" />
            </div>
            <div>
              <div class="text-xs text-gray-500">
                {{ item?.itemName || '活动道具' }} · ID {{ item?.itemId || '-' }}
              </div>
              <div class="mt-0.5 text-xl text-gray-900 font-bold dark:text-white">
                {{ Number(item?.itemCount || 0).toLocaleString() }}
              </div>
              <div class="text-xs text-gray-400">
                {{ activity?.inventoryAvailable === false ? '背包读取失败，数量暂不可用' : '当前背包数量' }}
              </div>
            </div>
          </div>
        </div>

        <div class="grid gap-3 lg:grid-cols-2">
          <div class="border border-gray-100 rounded-xl p-4 dark:border-gray-700">
            <h3 class="text-gray-900 font-semibold dark:text-white">
              天气采集瓶兑换
            </h3>
            <div v-if="activity?.exchangeShop.length" class="mt-3 space-y-2">
              <div v-for="item in activity.exchangeShop" :key="item.id" class="rounded-lg bg-gray-50 p-3 text-sm dark:bg-gray-900/30">
                <div class="flex items-center justify-between gap-3">
                  <span class="text-gray-900 font-medium dark:text-white">{{ item.itemName }} ×{{ item.itemCount }}</span>
                  <span class="text-xs text-gray-500">{{ item.statusLabel }}</span>
                </div>
                <div class="mt-1 text-xs text-gray-500">
                  {{ item.currencyName || `货币 ${item.currencyId}` }} ×{{ item.price }} · 仅展示，不发送兑换请求
                </div>
              </div>
            </div>
            <p v-else class="mt-3 text-sm text-gray-500">
              暂未读取到兑换商品。
            </p>
          </div>

          <div class="border border-gray-100 rounded-xl p-4 dark:border-gray-700">
            <h3 class="text-gray-900 font-semibold dark:text-white">
              抽奖次数与奖池
            </h3>
            <div class="grid grid-cols-2 mt-3 gap-2 text-sm">
              <div class="rounded-lg bg-emerald-50 p-3 dark:bg-emerald-900/20">
                免费剩余 <strong>{{ activity?.draw.freeRemaining || 0 }}/{{ activity?.draw.freeMax || 0 }}</strong>
              </div>
              <div class="rounded-lg bg-sky-50 p-3 dark:bg-sky-900/20">
                付费剩余 <strong>{{ activity?.draw.paidRemaining || 0 }}/{{ activity?.draw.paidMax || 0 }}</strong>
              </div>
            </div>
            <div class="mt-2 text-xs text-gray-500">
              每次消耗 {{ activity?.draw.currencyName || '活动道具' }} ×{{ activity?.draw.paidPrice || 0 }}；没有成功请求样本，因此不提供抽取按钮。
            </div>
            <div v-for="reward in activity?.draw.rewardPool || []" :key="reward.id" class="mt-3 rounded-lg bg-gray-50 p-3 text-sm dark:bg-gray-900/30">
              {{ reward.itemName }} ×{{ reward.itemCount }}<span v-if="reward.probability" class="ml-2 text-xs text-gray-500">{{ reward.probability }}</span>
            </div>
          </div>
        </div>
      </div>
    </section>

    <section class="rounded-lg bg-white p-5 shadow-sm dark:bg-gray-800">
      <h3 class="text-gray-900 font-semibold dark:text-white">
        子玩法与协议状态
      </h3>
      <div class="grid mt-3 gap-3 md:grid-cols-2 xl:grid-cols-3">
        <div v-for="child in activity?.subActivities || []" :key="child.id" class="border border-gray-100 rounded-lg p-3 dark:border-gray-700">
          <div class="flex items-start justify-between gap-2">
            <div>
              <div class="text-sm text-gray-900 font-medium dark:text-white">
                {{ featureLabel(child) }}
              </div>
              <div class="mt-0.5 text-xs text-gray-500">
                ID {{ child.id }} · 字段 {{ child.protobufField }}
              </div>
            </div>
            <span class="rounded px-2 py-0.5 text-xs" :class="child.enabled ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-900/25 dark:text-emerald-200' : 'bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-300'">{{ child.statusLabel }}</span>
          </div>
          <div class="mt-2 text-xs text-gray-500">
            {{ child.protocolObserved ? (child.protobufState === 'opaque_read_only' ? '当前回包已观测字段，业务语义待官方证据' : '当前回包已观测字段，仅开放读取') : '当前回包未观测到该字段' }}
          </div>
        </div>
      </div>
    </section>

    <section class="rounded-lg bg-white p-5 shadow-sm dark:bg-gray-800">
      <h3 class="text-gray-900 font-semibold dark:text-white">
        {{ activity?.rulesTitle || '活动说明' }}
      </h3>
      <div class="mt-3 text-sm text-gray-600 leading-6 space-y-2 dark:text-gray-300">
        <p v-for="(line, index) in activity?.ruleLines || []" :key="`${index}-${line}`">
          {{ line }}
        </p>
      </div>
      <div class="mt-4 border-t border-gray-100 pt-3 text-xs text-gray-500 dark:border-gray-700">
        活动时间：{{ formatTime(activity?.startTime) }} — {{ formatTime(activity?.endTime) }}。活动组 UID 尚无证据；{{ activity?.writeBoundary || '写操作待协议证据' }}。
      </div>
    </section>
  </div>
</template>
