<script setup lang="ts">
import type { WeatherActivityData, WeatherGameplayGuide, WeatherSubActivity } from '@/stores/activity'
import { computed } from 'vue'
import BaseButton from '@/components/ui/BaseButton.vue'

const props = defineProps<{
  activity?: WeatherActivityData | null
  loading?: boolean
}>()

defineEmits<{ refresh: [] }>()

const itemCards = computed(() => props.activity
  ? [props.activity.items.weatherBottle, props.activity.items.drawReward]
  : [])

const mainRoute = computed(() => ['collect', 'summon', 'mutation']
  .map(key => props.activity?.gameplayGuides?.find(item => item.key === key))
  .filter((item): item is WeatherGameplayGuide => !!item))

function formatTime(value?: number) {
  return value ? new Date(value * 1000).toLocaleString('zh-CN', { hour12: false }) : '-'
}

function guideIcon(icon: WeatherGameplayGuide['icon']) {
  return {
    rain: 'i-carbon-rain-heavy',
    collect: 'i-carbon-location-heart',
    summon: 'i-carbon-cloud-lightning',
    research: 'i-carbon-microscope',
    prank: 'i-carbon-face-wink',
  }[icon]
}

function featureLabel(activity: WeatherSubActivity) {
  if (activity.feature === 'exchangeShop')
    return '天气采集瓶兑换状态'
  if (activity.feature === 'draw')
    return '活动奖励次数与奖池'
  return '玩法协议节点（业务映射待确认）'
}
</script>

<template>
  <div class="space-y-4">
    <section class="overflow-hidden rounded-lg bg-white shadow-sm dark:bg-gray-800">
      <div class="from-slate-700 via-sky-700 to-indigo-800 bg-gradient-to-r px-5 py-5 text-white">
        <div class="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div class="flex items-center gap-2">
              <span class="i-carbon-rain-heavy text-3xl" />
              <h2 class="text-lg font-bold">
                {{ activity?.title || '雨落成诗' }}
              </h2>
            </div>
            <p class="mt-1 max-w-2xl text-sm text-white/80">
              去好友的雷雨农场采集天气，再回自己的农场召唤雷雨；闪电变异果实成熟后可按活动规则获得 4 倍售价。
            </p>
          </div>
          <div class="text-right">
            <BaseButton variant="secondary" :loading="loading" @click="$emit('refresh')">
              刷新只读状态
            </BaseButton>
            <p class="mt-1 text-xs text-white/65">
              1 分钟内重复刷新复用本地结果
            </p>
          </div>
        </div>
        <div class="mt-4 flex flex-wrap gap-2 text-xs">
          <span class="rounded-full bg-white/15 px-2.5 py-1">
            {{ activity?.active ? '活动进行中' : '当前未启用' }}
          </span>
          <span class="rounded-full bg-white/15 px-2.5 py-1">
            已从活动说明识别 {{ activity?.summary?.gameplayGuideCount || 0 }} 种玩法
          </span>
          <span class="rounded-full bg-amber-300/20 px-2.5 py-1 text-amber-100">
            只读展示 · 需官方自然成功样本
          </span>
        </div>
      </div>

      <div class="space-y-5 p-5">
        <section v-if="mainRoute.length">
          <div class="flex flex-wrap items-end justify-between gap-2">
            <div>
              <h3 class="text-gray-900 font-semibold dark:text-white">
                天气瓶主线
              </h3>
              <p class="mt-1 text-xs text-gray-500">
                下面的流程来自官方活动说明，只用于解释怎么玩，不会自动发送天气瓶操作。
              </p>
            </div>
            <span class="rounded-full bg-emerald-50 px-2.5 py-1 text-xs text-emerald-700 dark:bg-emerald-900/25 dark:text-emerald-200">
              活动说明已确认
            </span>
          </div>
          <div class="mt-3 grid gap-2 md:grid-cols-3">
            <div v-for="(guide, index) in mainRoute" :key="guide.key" class="relative rounded-xl border border-sky-100 bg-sky-50/70 p-4 dark:border-sky-800/50 dark:bg-sky-950/25">
              <div class="flex items-center gap-3">
                <div class="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-sky-700 text-white">
                  <span :class="guideIcon(guide.icon)" class="text-xl" />
                </div>
                <div>
                  <div class="text-xs text-sky-700 dark:text-sky-300">
                    第 {{ index + 1 }} 步
                  </div>
                  <div class="text-sm text-gray-900 font-semibold dark:text-white">
                    {{ guide.title }}
                  </div>
                </div>
              </div>
              <p class="mt-3 text-xs text-gray-600 leading-5 dark:text-gray-300">
                {{ guide.steps[guide.key === 'mutation' ? 2 : 1] || guide.steps[0] }}
              </p>
            </div>
          </div>
        </section>

        <section v-if="activity?.gameplayGuides?.length">
          <h3 class="text-gray-900 font-semibold dark:text-white">
            玩法说明与参与条件
          </h3>
          <div class="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            <article v-for="guide in activity.gameplayGuides || []" :key="guide.key" class="rounded-xl border border-gray-100 p-4 dark:border-gray-700">
              <div class="flex items-start justify-between gap-2">
                <div class="flex items-center gap-2">
                  <span :class="guideIcon(guide.icon)" class="text-xl text-sky-700 dark:text-sky-300" />
                  <h4 class="text-sm text-gray-900 font-semibold dark:text-white">
                    {{ guide.title }}
                  </h4>
                </div>
                <span class="shrink-0 rounded bg-gray-100 px-2 py-0.5 text-xs text-gray-500 dark:bg-gray-700 dark:text-gray-300">
                  说明已识别
                </span>
              </div>
              <ol class="mt-3 space-y-2">
                <li v-for="(step, index) in guide.steps" :key="step" class="flex gap-2 text-xs text-gray-600 leading-5 dark:text-gray-300">
                  <span class="mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-full bg-sky-100 text-[10px] text-sky-700 dark:bg-sky-900/40 dark:text-sky-200">{{ index + 1 }}</span>
                  <span>{{ step }}</span>
                </li>
              </ol>
              <div class="mt-3 border-t border-gray-100 pt-2 text-xs text-amber-700 dark:border-gray-700 dark:text-amber-300">
                当前请在官方 QQ 农场活动页人工执行；Bot 不会试探未知写接口
              </div>
            </article>
          </div>
        </section>

        <section class="rounded-xl border border-sky-200 bg-sky-50 p-4 dark:border-sky-800/60 dark:bg-sky-950/20">
          <h3 class="text-sm text-sky-900 font-semibold dark:text-sky-100">
            怎么执行
          </h3>
          <p class="mt-2 text-xs text-sky-800 leading-5 dark:text-sky-200">
            目前只能打开官方 QQ 农场的“雨落成诗”活动页，按上方流程人工使用天气瓶、推进研究或抽取奖励。要在本面板开放执行按钮，必须先取得当前官方客户端自然操作产生的成功请求样本，确认活动仍允许该操作，并补齐命令、参数、次数限制和失败边界；在此之前不会用线上账号猜接口。
          </p>
        </section>

        <section v-if="activity?.ruleWarnings?.length" class="rounded-xl border border-amber-200 bg-amber-50 p-4 dark:border-amber-800/60 dark:bg-amber-950/20">
          <div class="flex items-center gap-2 text-sm text-amber-800 font-semibold dark:text-amber-200">
            <span class="i-carbon-warning-alt" />
            活动注意事项
          </div>
          <ul class="mt-2 space-y-1.5 text-xs text-amber-800 leading-5 dark:text-amber-200">
            <li v-for="warning in activity.ruleWarnings || []" :key="warning">• {{ warning }}</li>
          </ul>
        </section>

        <div class="grid gap-3 md:grid-cols-2">
          <div v-for="item in itemCards" :key="item.itemId" class="flex items-center gap-3 rounded-xl bg-slate-50 p-4 dark:bg-gray-900/35">
            <div class="grid h-12 w-12 shrink-0 place-items-center rounded-lg bg-sky-100 dark:bg-sky-900/30">
              <img v-if="item.image" :src="item.image" alt="" class="h-10 w-10 object-contain">
              <span v-else class="i-carbon-chemistry text-2xl text-sky-700 dark:text-sky-200" />
            </div>
            <div>
              <div class="text-xs text-gray-500">
                {{ item.itemName || '活动道具' }} · ID {{ item.itemId || '-' }}
              </div>
              <div class="mt-0.5 text-xl text-gray-900 font-bold dark:text-white">
                {{ Number(item.itemCount || 0).toLocaleString() }}
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
              活动奖励次数与奖池
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
        {{ activity?.rulesTitle || '完整活动说明' }}
      </h3>
      <div class="mt-3 text-sm text-gray-600 leading-6 space-y-2 dark:text-gray-300">
        <p v-for="(line, index) in activity?.ruleLines || []" :key="`${index}-${line}`">
          {{ line }}
        </p>
      </div>
      <div class="mt-4 border-t border-gray-100 pt-3 text-xs text-gray-500 dark:border-gray-700">
        活动时间：{{ formatTime(activity?.startTime) }} — {{ formatTime(activity?.endTime) }}。{{ activity?.writeBoundary || '写操作待协议证据' }}。
      </div>
    </section>

    <details class="rounded-lg bg-white p-5 shadow-sm dark:bg-gray-800">
      <summary class="cursor-pointer text-sm text-gray-900 font-semibold dark:text-white">
        协议接入状态（诊断信息）
      </summary>
      <p class="mt-2 text-xs text-gray-500">
        这里展示服务端节点与只读字段证据，不等同于玩家玩法名称，也不会据此推测操作命令。
      </p>
      <div class="grid mt-3 gap-3 md:grid-cols-2 xl:grid-cols-3">
        <div v-for="child in activity?.subActivities || []" :key="child.id" class="border border-gray-100 rounded-lg p-3 dark:border-gray-700">
          <div class="flex items-start justify-between gap-2">
            <div>
              <div class="text-sm text-gray-900 font-medium dark:text-white">
                {{ featureLabel(child) }}
              </div>
              <div class="mt-0.5 text-xs text-gray-500">
                ID {{ child.id }} · type {{ child.type }} · 字段 {{ child.protobufField }}
              </div>
            </div>
            <span class="rounded px-2 py-0.5 text-xs" :class="child.enabled ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-900/25 dark:text-emerald-200' : 'bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-300'">{{ child.statusLabel }}</span>
          </div>
          <div class="mt-2 text-xs text-gray-500">
            {{ child.protocolObserved ? (child.protobufState === 'opaque_read_only' ? '当前回包已观测字段，业务语义仍需协议证据' : '当前回包已观测字段，仅开放读取') : '当前回包未观测到该字段' }}
          </div>
        </div>
      </div>
    </details>
  </div>
</template>
