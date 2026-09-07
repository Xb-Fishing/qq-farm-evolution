<script setup lang="ts">
import type { CharityActivityData, CharityGameplayGuide } from '@/stores/activity'
import { computed } from 'vue'
import BaseButton from '@/components/ui/BaseButton.vue'

const props = defineProps<{
  activity?: CharityActivityData | null
  loading?: boolean
}>()

defineEmits<{ refresh: [] }>()

const manualActions = ['领取公益礼包', '捐赠爱心值', '送出公益金']
const mainFlow = computed(() => ['seed', 'grow', 'donate', 'publicFund']
  .map(key => props.activity?.gameplayGuides?.find(item => item.key === key))
  .filter((item): item is CharityGameplayGuide => !!item))

function formatTime(value?: number) {
  return value ? new Date(value * 1000).toLocaleString('zh-CN', { hour12: false }) : '-'
}

function guideIcon(icon: CharityGameplayGuide['icon']) {
  return {
    task: 'i-carbon-task',
    grow: 'i-carbon-sprout',
    heart: 'i-carbon-favorite',
    fund: 'i-carbon-currency',
  }[icon]
}
</script>

<template>
  <div class="space-y-4">
    <section class="overflow-hidden rounded-lg bg-white shadow-sm dark:bg-gray-800">
      <div class="from-rose-700 via-red-600 to-emerald-700 bg-gradient-to-r px-5 py-5 text-white">
        <div class="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div class="flex items-center gap-2">
              <span class="i-carbon-favorite text-3xl" />
              <h2 class="text-lg font-bold">
                {{ activity?.title || '公益小红花' }}
              </h2>
            </div>
            <p class="mt-1 max-w-3xl text-sm text-white/85">
              完成每日任务或分享获得种子，种植并收获小红花积累爱心值，再由用户在官方客户端选择是否捐赠。
            </p>
          </div>
          <div class="text-right">
            <BaseButton variant="secondary" :loading="loading" @click="$emit('refresh')">
              刷新只读状态
            </BaseButton>
            <p class="mt-1 text-xs text-white/70">
              1 分钟内重复或失败刷新均复用本地结果
            </p>
          </div>
        </div>
        <div class="mt-4 flex flex-wrap gap-2 text-xs">
          <span class="rounded-full bg-white/15 px-2.5 py-1">
            {{ activity?.active ? '活动期内' : '当前不在活动期' }}
          </span>
          <span class="rounded-full bg-white/15 px-2.5 py-1">
            {{ activity?.participationEnabled ? '玩法节点已启用' : '当前样本玩法节点未启用' }}
          </span>
          <span class="rounded-full bg-amber-300/25 px-2.5 py-1 text-amber-50">
            只读展示 · 官方客户端人工参与
          </span>
        </div>
      </div>

      <div class="p-5 space-y-5">
        <section v-if="mainFlow.length">
          <div class="flex flex-wrap items-end justify-between gap-2">
            <div>
              <h3 class="text-gray-900 font-semibold dark:text-white">
                公益小红花参与流程
              </h3>
              <p class="mt-1 text-xs text-gray-500">
                流程名称和条件来自官方活动说明；它们不构成请求命令或参数证据。
              </p>
            </div>
            <span class="rounded-full bg-emerald-50 px-2.5 py-1 text-xs text-emerald-700 dark:bg-emerald-900/25 dark:text-emerald-200">
              已识别 {{ activity?.summary.gameplayGuideCount || 0 }} 个流程环节
            </span>
          </div>
          <div class="grid mt-3 gap-3 md:grid-cols-2 xl:grid-cols-4">
            <article v-for="(guide, index) in mainFlow" :key="guide.key" class="border border-rose-100 rounded-xl bg-rose-50/60 p-4 dark:border-rose-900/60 dark:bg-rose-950/20">
              <div class="flex items-center gap-3">
                <div class="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-rose-700 text-white">
                  <span :class="guideIcon(guide.icon)" class="text-xl" />
                </div>
                <div>
                  <div class="text-xs text-rose-700 dark:text-rose-300">
                    第 {{ index + 1 }} 步
                  </div>
                  <h4 class="text-sm text-gray-900 font-semibold dark:text-white">
                    {{ guide.title }}
                  </h4>
                </div>
              </div>
              <ol class="mt-3 text-xs text-gray-600 leading-5 space-y-1.5 dark:text-gray-300">
                <li v-for="step in guide.steps" :key="step">
                  • {{ step }}
                </li>
              </ol>
            </article>
          </div>
        </section>

        <section>
          <h3 class="text-gray-900 font-semibold dark:text-white">
            活动资源与当前可见状态
          </h3>
          <p class="mt-1 text-xs text-gray-500">
            当前证据只确认名称和用途，未提供道具 ID、图片、库存、爱心值或任务进度字段，因此不显示伪造的 0。
          </p>
          <div class="grid mt-3 gap-3 md:grid-cols-3">
            <div v-for="resource in activity?.resources || []" :key="resource.key" class="flex items-center gap-3 rounded-xl bg-slate-50 p-4 dark:bg-gray-900/35">
              <div class="grid h-11 w-11 shrink-0 place-items-center rounded-lg bg-rose-100 dark:bg-rose-900/30">
                <span :class="resource.kind === 'currency' ? 'i-carbon-favorite' : 'i-carbon-crop-growth'" class="text-2xl text-rose-700 dark:text-rose-200" />
              </div>
              <div>
                <div class="text-sm text-gray-900 font-semibold dark:text-white">
                  {{ resource.name }}
                </div>
                <div class="mt-1 text-xs text-gray-500">
                  名称来自活动说明
                </div>
                <div class="text-xs text-amber-700 dark:text-amber-300">
                  ID / 图片 / 数量待官方证据
                </div>
              </div>
            </div>
          </div>
        </section>

        <section>
          <h3 class="text-gray-900 font-semibold dark:text-white">
            三类活动奖励
          </h3>
          <div class="grid mt-3 gap-3 lg:grid-cols-3">
            <article v-for="group in activity?.rewardGroups || []" :key="group.key" class="border border-gray-100 rounded-xl p-4 dark:border-gray-700">
              <div class="flex items-start justify-between gap-2">
                <h4 class="text-sm text-gray-900 font-semibold dark:text-white">
                  {{ group.title }}
                </h4>
                <span class="shrink-0 rounded bg-gray-100 px-2 py-0.5 text-xs text-gray-500 dark:bg-gray-700 dark:text-gray-300">状态待解析</span>
              </div>
              <p class="mt-2 text-xs text-gray-500 leading-5">
                {{ group.condition }}
              </p>
              <ul class="mt-3 text-sm text-gray-700 space-y-1.5 dark:text-gray-300">
                <li v-for="(item, index) in group.items" :key="`${group.key}-${index}`" class="flex justify-between gap-3 rounded bg-gray-50 px-3 py-2 dark:bg-gray-900/35">
                  <span>{{ item.name }}</span>
                  <strong>×{{ item.count }}</strong>
                </li>
              </ul>
            </article>
          </div>
        </section>

        <section class="border border-amber-200 rounded-xl bg-amber-50 p-4 dark:border-amber-800/60 dark:bg-amber-950/20">
          <div class="flex items-center gap-2 text-sm text-amber-900 font-semibold dark:text-amber-100">
            <span class="i-carbon-warning-alt" />
            授权、公益金与自动化边界
          </div>
          <div class="grid mt-3 gap-2 md:grid-cols-2">
            <article v-for="notice in activity?.notices || []" :key="notice.key" class="rounded-lg bg-white/65 p-3 dark:bg-gray-900/25">
              <h4 class="text-xs text-amber-900 font-semibold dark:text-amber-100">
                {{ notice.title }}
              </h4>
              <p class="mt-1 text-xs text-amber-800 leading-5 dark:text-amber-200">
                {{ notice.text }}
              </p>
            </article>
          </div>
        </section>

        <section class="border border-gray-100 rounded-xl p-4 dark:border-gray-700">
          <h3 class="text-gray-900 font-semibold dark:text-white">
            官方客户端操作
          </h3>
          <p class="mt-1 text-xs text-gray-500">
            当前没有官方自然成功请求样本，且活动规则禁止自动方式参与。以下仅标示玩家流程，不会发送任何写请求。
          </p>
          <div class="mt-3 flex flex-wrap gap-2">
            <button v-for="action in manualActions" :key="action" type="button" disabled class="cursor-not-allowed rounded-lg bg-gray-100 px-3 py-2 text-xs text-gray-400 dark:bg-gray-700 dark:text-gray-500">
              {{ action }} · 请在官方客户端完成
            </button>
          </div>
        </section>

        <div class="border-t border-gray-100 pt-3 text-xs text-gray-500 dark:border-gray-700">
          活动时间：{{ formatTime(activity?.startTime) }} — {{ formatTime(activity?.endTime) }}。{{ activity?.writeBoundary || '写操作待官方证据' }}。
        </div>
      </div>
    </section>

    <details class="rounded-lg bg-white p-5 shadow-sm dark:bg-gray-800">
      <summary class="cursor-pointer text-sm text-gray-900 font-semibold dark:text-white">
        协议接入状态（诊断信息）
      </summary>
      <p class="mt-2 text-xs text-gray-500">
        当前仅确认根节点 2026090900、type 19 子节点 2026090901、客户端 UI 标识和不透明 field 116；字段形状不能证明写协议。
      </p>
      <div v-for="child in activity?.subActivities || []" :key="child.id" class="mt-3 border border-gray-100 rounded-lg p-3 dark:border-gray-700">
        <div class="flex flex-wrap items-start justify-between gap-2">
          <div>
            <div class="text-sm text-gray-900 font-medium dark:text-white">
              公益小红花玩法节点
            </div>
            <div class="mt-0.5 text-xs text-gray-500">
              ID {{ child.id }} · type {{ child.type }} · field {{ child.protobufField }} · UI {{ child.clientUiUid || '-' }}
            </div>
          </div>
          <span class="rounded bg-gray-100 px-2 py-0.5 text-xs text-gray-500 dark:bg-gray-700 dark:text-gray-300">{{ child.statusLabel }}</span>
        </div>
        <p class="mt-2 text-xs text-gray-500">
          {{ child.protocolObserved ? '当前回包已观测该不透明字段，业务进度/库存/领取语义仍未解码' : '当前回包未观测到该字段' }}
        </p>
      </div>
    </details>
  </div>
</template>
