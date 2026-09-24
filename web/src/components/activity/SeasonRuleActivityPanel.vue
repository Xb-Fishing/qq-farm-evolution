<script setup lang="ts">
import type { SeasonRuleActivityData, ShareOperateState, WishOperateState } from '@/stores/activity'
import { computed } from 'vue'
import BaseButton from '@/components/ui/BaseButton.vue'

// 秋祈良愿 / 快乐不独享共用面板：说明驱动展示 + 面板手动操作（两级写操作第①级，
// 编码证据来自官方编码器重构，见 season-wish-operate.js）。分享类玩法不开放
// （面板无法完成官方分享用户流程，直接发命令等于伪造分享状态）。
const props = defineProps<{
  activity: SeasonRuleActivityData | null
  loading: boolean
  heading: string
  subtitle: string
  kind: 'wish' | 'happyShare'
  operating: string
}>()
const emit = defineEmits<{
  (e: 'refresh'): void
  (e: 'operate', action: string, input: Record<string, unknown>): void
}>()

function time(value: number) {
  return value ? new Date(value * 1000).toLocaleString() : '未下发'
}

// 模板内不做 TS 断言：状态在此归一化（活动未开放时为 null）
const wishState = computed<WishOperateState | null>(() => {
  const state = props.kind === 'wish' ? props.activity?.operateState : null
  return state && 'remainingCount' in state ? state as WishOperateState : null
})
const shareState = computed<ShareOperateState | null>(() => {
  const state = props.kind === 'happyShare' ? props.activity?.operateState : null
  return state && 'currentScore' in state ? state as ShareOperateState : null
})
const wishPendingRewards = computed(() => {
  const rewards = wishState.value?.pending?.rewards || []
  return rewards.map(r => `${r.itemName}×${r.itemCount}`).join('、')
})

const WISH_CHOICE_LABELS = ['财运', '感情', '前程', '生活', '农耕', '人际']

function runWishDraw() {
  if (props.operating)
    return
  const pending = wishState.value?.pending
  const choice = pending?.chooseId
    ?? (window.prompt(`请输入祈愿签文编号（1-6）：\n${WISH_CHOICE_LABELS.map((n, i) => `${i + 1}=${n}`).join('、')}`, '2') || '')
  const chooseId = Number(choice)
  if (!Number.isInteger(chooseId) || chooseId < 1 || chooseId > 6)
    return
  emit('operate', 'wishDraw', { chooseId })
}

function runWishClaim() {
  if (props.operating)
    return
  const pending = wishState.value?.pending
  if (!pending)
    return
  emit('operate', 'wishClaim', { chooseId: pending.chooseId })
}

// 手动操作开放的玩法卡提示（照 BearActivityPanel 2026-09-19 模式：卡片不重复接线）
const MANUAL_GUIDE_ACTIONS: Record<string, string[]> = {
  'daily': ['祈愿', '领取祈愿奖励'],
  'rewards': [],
  'storage': [],
  'mail': [],
  'daily-claim': ['每日领取'],
  'daily-share': [],
  'friend-link': [],
  'tier-rewards': ['领取档位奖励'],
}
function manualLabelsFor(guide: { key: string }) {
  const key = guide.key
  if (!Object.prototype.hasOwnProperty.call(MANUAL_GUIDE_ACTIONS, key))
    return []
  return (MANUAL_GUIDE_ACTIONS[key] || []).slice()
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
      1 分钟内重复刷新复用本地结果；操作命令字来自官方编码器重构证据（手动触发模式，不自动执行）。
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

      <!-- 手动操作区（编码证据：祈愿 cmd51 / 领取 cmd52 / 每日领取 cmd73 / 档位 cmd70） -->
      <section v-if="kind === 'wish'" class="border border-emerald-200 rounded-lg bg-emerald-50/70 p-3 dark:border-emerald-800/50 dark:bg-emerald-900/20">
        <h3 class="text-sm text-emerald-900 font-semibold dark:text-emerald-200">
          玩法手动操作
        </h3>
        <p class="mt-1 text-xs text-emerald-700/90 dark:text-emerald-300/90">
          由你点击触发，每次操作前 Bot 会重读活动状态校验次数/待领取；不会自动执行。放烟花请走背包物品使用。
        </p>
        <div class="mt-3 flex flex-wrap items-center gap-2">
          <BaseButton variant="primary" size="sm" :loading="operating === 'wishDraw'" :disabled="!!operating" @click="runWishDraw">
            祈愿
          </BaseButton>
          <BaseButton
            variant="secondary" size="sm" :loading="operating === 'wishClaim'" :disabled="!!operating || !wishState?.pending"
            :title="wishState?.pending ? `领取签文 #${wishState?.pending?.chooseId} 的奖励` : '当前没有待领取的祈愿奖励'"
            @click="runWishClaim"
          >
            领取祈愿奖励
          </BaseButton>
          <span v-if="wishState" class="text-xs text-gray-600 dark:text-gray-300">
            今日剩余祈愿 {{ wishState.remainingCount }} 次 · 活动第 {{ wishState.activityDay }} 天<template v-if="wishState.pending">
              · 待领取签文 #{{ wishState.pending.chooseId }}（{{ wishPendingRewards }}）</template>
          </span>
          <span v-else class="text-xs text-gray-500">祈愿状态未下发（活动未开放时无实时状态）。</span>
        </div>
      </section>
      <section v-else class="border border-emerald-200 rounded-lg bg-emerald-50/70 p-3 dark:border-emerald-800/50 dark:bg-emerald-900/20">
        <h3 class="text-sm text-emerald-900 font-semibold dark:text-emerald-200">
          玩法手动操作
        </h3>
        <p class="mt-1 text-xs text-emerald-700/90 dark:text-emerald-300/90">
          每日领取与档位领奖由你点击触发，操作前重读状态校验；分享与好友链接属官方社交玩法，不开放面板触发。
        </p>
        <div class="mt-3 flex flex-wrap items-center gap-2">
          <BaseButton variant="primary" size="sm" :loading="operating === 'shareDaily'" :disabled="!!operating" @click="$emit('operate', 'shareDaily', {})">
            每日领取快乐值
          </BaseButton>
          <BaseButton variant="secondary" size="sm" :loading="operating === 'shareMilestones'" :disabled="!!operating" @click="$emit('operate', 'shareMilestones', {})">
            领取档位奖励
          </BaseButton>
          <span v-if="shareState" class="text-xs text-gray-600 dark:text-gray-300">
            当前快乐值 {{ shareState.currentScore }}<template v-if="shareState.daily">
              · 今日领取 {{ shareState.daily.rewardClaimed ? '已完成' : '未领取' }} · 分享 {{ shareState.daily.firstShareAwarded ? '已完成' : '未分享' }}</template>
          </span>
          <span v-else class="text-xs text-gray-500">快乐值状态未下发（活动未开放时无实时状态）。</span>
        </div>
        <div v-if="shareState?.milestones?.length" class="mt-3 text-xs text-gray-600 dark:text-gray-300">
          档位：<span v-for="tier in shareState.milestones" :key="tier.id" class="mr-3">
            {{ tier.threshold }} 快乐值 → {{ tier.rewards.map(r => `${r.itemName}×${r.itemCount}`).join('、') || '?' }}
            （{{ tier.state === 2 ? '可领取' : tier.state === 3 ? '已领取' : '未达成' }}）
          </span>
        </div>
      </section>

      <!-- 道具库存（烟花桶等已确认道具；未知道具不伪造数量） -->
      <section v-if="activity.resources?.length">
        <h3 class="mb-3 font-semibold">
          活动道具与库存
        </h3>
        <p v-if="!activity.inventoryAvailable" class="mb-2 text-xs text-amber-600">
          本次背包读取不可用，数量保持未知。
        </p>
        <div class="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <article v-for="item in activity.resources" :key="item.key" class="border border-gray-200 rounded-lg p-3 dark:border-gray-700">
            <div class="flex items-center gap-2">
              <span class="i-carbon-gift text-xl text-amber-500" />
              <h4 class="text-sm font-semibold">
                {{ item.name }}
              </h4>
            </div>
            <p class="mt-2 text-lg font-bold">
              {{ item.inventoryCount == null ? '数量待确认' : Number(item.inventoryCount).toLocaleString() }}
            </p>
            <p class="mt-1 text-xs text-gray-500">
              {{ item.desc }}
            </p>
            <p class="mt-1 text-xs text-gray-400">
              道具 ID {{ item.itemId }}（专属图片待抓包证据）
            </p>
          </article>
        </div>
      </section>

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
              {{ guide.missingState }}：当前快照未提供该实时状态时未知不按 0 处理；点击手动操作时会重新校验。
            </p>
            <p v-if="manualLabelsFor(guide).length" class="mt-3 rounded bg-emerald-50 p-2 text-xs text-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-300">
              手动操作已开放：{{ manualLabelsFor(guide).join('、') }}（上方「玩法手动操作」区）
            </p>
            <p v-else-if="guide.key === 'daily-share' || guide.key === 'friend-link'" class="mt-3 rounded bg-amber-50 p-2 text-xs text-amber-700 dark:bg-amber-900/20 dark:text-amber-300">
              {{ guide.actionLabel }} · 分享类玩法不开放面板触发（需在官方客户端完成分享流程）
            </p>
            <p v-else-if="guide.key === 'rewards'" class="mt-3 rounded bg-gray-50 p-2 text-xs text-gray-500 dark:bg-gray-900/40">
              {{ guide.actionLabel }} · 奖励随祈愿/领取发放，见上方手动操作区
            </p>
            <p v-else class="mt-3 rounded bg-gray-50 p-2 text-xs text-gray-500 dark:bg-gray-900/40">
              {{ guide.actionLabel }} · 该步骤由系统自动处理（存储/邮件补发），无需操作
            </p>
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
          <p>字段 {{ node.protobufField }} · {{ node.protocolObserved ? '已观测（结构诊断，不解释业务字段）' : '未观测' }}</p>
        </div>
      </details>
    </template>
  </section>
</template>
