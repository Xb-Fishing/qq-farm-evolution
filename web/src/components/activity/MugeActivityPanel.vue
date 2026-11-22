<script setup lang="ts">
import type { MugeActivity, MugeOperation, MugeReward, MugeRewardRow } from '@/stores/muge'
import { computed, ref, watch } from 'vue'
import BaseButton from '@/components/ui/BaseButton.vue'

const props = defineProps<{
  activity: MugeActivity | null
  loading: boolean
  error: string
  pending?: MugeOperation['action'] | null
  ready?: boolean
  refreshRequired?: boolean
  feedback?: string
  rewards?: MugeReward[]
}>()
const emit = defineEmits<{ refresh: [], operate: [MugeOperation] }>()

const canOperate = computed(() => props.ready && !props.loading && !props.pending
  && props.activity?.available && props.activity.phase === 'open')
const personal = computed(() => props.activity?.personal)
const personality = computed(() => personal.value?.personality)
const questions = computed(() => props.activity?.questions || [])
const surveyEdits = ref<Record<string, number>>({})
watch(() => personality.value?.personalityId, (next, previous) => {
  if (next != null && (next > 0 || (previous != null && previous > 0)))
    surveyEdits.value = {}
})
const surveyAnswers = computed(() => ({ ...personality.value?.answers, ...surveyEdits.value }))
const validAnswers = computed(() => {
  const answers: Record<string, number> = {}
  for (const question of questions.value) {
    const answer = surveyAnswers.value[question.id]
    if (answer !== undefined && question.options.some(option => option.value === answer))
      answers[question.id] = answer
  }
  return answers
})
const surveyComplete = computed(() => questions.value.length > 0 && questions.value.length === Object.keys(validAnswers.value).length)

function operate(operation: MugeOperation) {
  if (canOperate.value)
    emit('operate', operation)
}

function submitSurvey() {
  if (personality.value && personality.value.personalityId === 0 && surveyComplete.value)
    operate({ action: 'finishSurvey', input: { answers: validAnswers.value } })
}

function dateLabel(value: unknown) {
  const n = value == null ? Number.NaN : Number(value)
  return Number.isFinite(n) && n > 0 && !Number.isNaN(new Date(n * 1000).getTime())
    ? new Date(n * 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })
    : '时间未提供'
}

function rewardStatus(status: number) {
  switch (status) {
    case 1: return '未达标'
    case 2: return '可领取'
    case 3: return '已领取'
    case 4: return '未解锁'
    default: return '待确认'
  }
}

interface DisplayRow {
  id: string
  label: string
  detail?: string
  status: number
  rewards: MugeReward[]
}

function tierRows(tiers: MugeRewardRow[], label: (threshold: string) => string): DisplayRow[] {
  return tiers.map(tier => ({ ...tier, label: label(tier.threshold) }))
}

interface RewardSection {
  title: string
  summary: string | null
  groups: {
    title?: string
    action: 'claimCelebration' | 'claimFriends' | 'claimTask' | 'claimHandbook'
    button: string
    rows: DisplayRow[]
  }[]
}

const rewardSections = computed<RewardSection[]>(() => {
  const celebration = personal.value?.celebration
  const friends = personal.value?.friends
  const handbook = personal.value?.handbook
  return [
    {
      title: '兴牧庆典',
      summary: celebration ? `累计饲养 ${celebration.total} 只` : null,
      groups: [{ action: 'claimCelebration', button: '领取庆典奖励', rows: tierRows(celebration?.tiers || [], threshold => `饲养 ${threshold} 只`) }],
    },
    {
      title: '牧友同行',
      summary: friends ? `已开启牧场的好友 ${friends.count} 人` : null,
      groups: [{ action: 'claimFriends', button: '领取牧友奖励', rows: tierRows(friends?.tiers || [], threshold => `${threshold} 位好友`) }],
    },
    {
      title: '成长手册',
      summary: handbook ? `累计积分 ${handbook.points}` : null,
      groups: [
        {
          title: '手册任务',
          action: 'claimTask',
          button: '领取任务奖励',
          rows: (handbook?.tasks || []).map((task): DisplayRow => ({
            ...task,
            label: task.description,
            detail: task.status === 4 && task.unlockDay !== '0'
              ? `第 ${task.unlockDay} 天解锁 · ${task.progress} / ${task.target}`
              : `${task.progress} / ${task.target}`,
          })),
        },
        {
          title: '积分档位',
          action: 'claimHandbook',
          button: '领取积分奖励',
          rows: tierRows(handbook?.tiers || [], threshold => `${threshold} 积分`),
        },
      ],
    },
  ]
})
</script>

<template>
  <section v-if="activity?.available !== false" id="muge" class="min-w-0 scroll-mt-4 rounded-xl bg-white p-4 text-gray-800 shadow-sm dark:bg-gray-800 dark:text-gray-100">
    <header class="flex flex-wrap items-center justify-between gap-3">
      <div class="min-w-0">
        <h2 class="break-words text-lg font-bold">
          {{ activity?.title || '牧歌初启' }}
        </h2>
        <p v-if="activity?.available" class="mt-1 break-words text-xs text-gray-500 dark:text-gray-400">
          北京时间 {{ dateLabel(activity.startTime) }} — {{ dateLabel(activity.endTime) }}
        </p>
      </div>
      <div class="flex flex-wrap gap-2">
        <BaseButton href="#ranch" variant="secondary" class="min-h-11">
          前往牧场经营与任务
        </BaseButton>
        <BaseButton variant="outline" class="min-h-11" :loading="loading" :disabled="!!pending" @click="emit('refresh')">
          刷新牧歌活动
        </BaseButton>
      </div>
    </header>
    <p v-if="loading" role="status" class="mt-2 text-sm">
      正在读取牧歌活动…
    </p>
    <p v-if="error" role="alert" class="mt-2 break-words text-sm text-red-600 dark:text-red-400">
      {{ error }}
    </p>
    <p v-if="refreshRequired" role="status" class="mt-2 text-sm text-amber-700 dark:text-amber-300">
      请刷新活动，确认最新进度和领奖状态后再操作。
    </p>
    <div v-if="feedback || rewards?.length" role="status" class="mt-3 rounded-lg bg-emerald-50 p-3 text-sm text-emerald-900 dark:bg-emerald-950 dark:text-emerald-100">
      <p v-if="feedback">
        {{ feedback }}
      </p>
      <ul v-if="rewards?.length" class="flex flex-wrap gap-x-3 gap-y-1">
        <li v-for="(reward, index) in rewards" :key="`${reward.id}-${index}`">
          {{ reward.name }} × {{ reward.count }}
        </li>
      </ul>
    </div>
    <p v-if="!activity && !loading && !error" class="mt-2 text-sm">
      尚未读取活动信息
    </p>
    <template v-if="activity?.available">
      <p v-if="activity.phase === 'upcoming'" class="mt-3 text-sm">
        活动尚未开始
      </p>
      <template v-else-if="activity.phase === 'open'">
        <div v-if="activity.automation" class="mt-4 flex flex-wrap items-center justify-between gap-3 border border-gray-200 rounded-lg p-3 dark:border-gray-700">
          <div>
            <h3 class="text-sm font-semibold">
              自动领取活动奖励
            </h3>
            <p class="mt-1 text-xs text-gray-500 dark:text-gray-400">
              饲养、牧友和成长手册达标后自动领取免费奖励
            </p>
          </div>
          <BaseButton
            :variant="activity.automation.enabled ? 'outline' : 'primary'" class="min-h-11"
            :loading="pending === 'setAutomation'" :disabled="!canOperate"
            @click="operate({ action: 'setAutomation', input: { enabled: !activity.automation.enabled } })"
          >
            {{ activity.automation.enabled ? '关闭自动领取' : '开启自动领取' }}
          </BaseButton>
        </div>
        <div class="grid mt-4 min-w-0 gap-3 md:grid-cols-2">
          <section v-for="section in rewardSections" :key="section.title" class="min-w-0 rounded-lg bg-gray-50 p-3 dark:bg-gray-900/50">
            <h3 class="font-bold">
              {{ section.title }}
            </h3>
            <p v-if="section.summary === null" class="mt-2 text-sm text-gray-500 dark:text-gray-400">
              个人进度未取得
            </p>
            <template v-else>
              <p class="mt-1 text-sm text-gray-600 dark:text-gray-300">
                {{ section.summary }}
              </p>
              <div v-for="group in section.groups" :key="group.action" class="mt-3">
                <h4 v-if="group.title" class="text-sm font-semibold">
                  {{ group.title }}
                </h4>
                <ul v-if="group.rows.length" class="divide-y divide-gray-200 dark:divide-gray-700">
                  <li v-for="row in group.rows" :key="row.id" class="py-2 text-sm">
                    <div class="flex flex-wrap items-baseline justify-between gap-x-2">
                      <span class="break-words">{{ row.label }}</span>
                      <span :class="row.status === 2 ? 'text-emerald-700 dark:text-emerald-300' : 'text-gray-500 dark:text-gray-400'">{{ rewardStatus(row.status) }}</span>
                    </div>
                    <p v-if="row.detail" class="mt-1 text-xs text-gray-500 dark:text-gray-400">
                      {{ row.detail }}
                    </p>
                    <ul v-if="row.rewards.length" class="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs">
                      <li v-for="reward in row.rewards" :key="reward.id" class="inline-flex items-center gap-1">
                        <img v-if="reward.image" :src="reward.image" alt="" loading="lazy" class="h-5 w-5 object-contain">
                        {{ reward.name }} × {{ reward.count }}
                      </li>
                    </ul>
                  </li>
                </ul>
                <p v-else class="mt-1 text-sm text-gray-500 dark:text-gray-400">
                  暂无奖励记录
                </p>
                <BaseButton
                  v-if="group.rows.some(row => row.status === 2)" variant="primary" class="mt-2 min-h-11"
                  :loading="pending === group.action" :disabled="!canOperate" @click="operate({ action: group.action })"
                >
                  {{ group.button }}
                </BaseButton>
              </div>
            </template>
          </section>
          <section class="min-w-0 rounded-lg bg-gray-50 p-3 dark:bg-gray-900/50">
            <h3 class="font-bold">
              牧场人格
            </h3>
            <p v-if="!personality" class="mt-2 text-sm text-gray-500 dark:text-gray-400">
              个人进度未取得
            </p>
            <template v-else-if="personality.personalityId > 0">
              <p class="mt-2 text-sm">
                人格测评已完成 · 结果编号 {{ personality.personalityId }}
              </p>
              <p v-if="personality.shareRewardClaimed" class="mt-2 text-sm text-emerald-700 dark:text-emerald-300">
                首次分享奖励已领取
              </p>
              <div class="mt-3 flex flex-wrap gap-2">
                <BaseButton
                  v-if="!personality.shareRewardClaimed" variant="primary" class="min-h-11"
                  :loading="pending === 'claimShare'" :disabled="!canOperate" @click="operate({ action: 'claimShare' })"
                >
                  领取首次分享奖励
                </BaseButton>
                <BaseButton
                  variant="outline" class="min-h-11" :loading="pending === 'resetSurvey'" :disabled="!canOperate || !questions.length"
                  @click="operate({ action: 'resetSurvey' })"
                >
                  重新作答
                </BaseButton>
              </div>
            </template>
            <form v-else-if="questions.length" class="mt-2" @submit.prevent="submitSurvey">
              <p class="text-sm text-gray-600 dark:text-gray-300">
                已选择 {{ Object.keys(validAnswers).length }} / {{ questions.length }} 题
              </p>
              <fieldset v-for="question in questions" :key="question.id" class="mt-3 min-w-0" :disabled="!canOperate">
                <legend class="break-words text-sm font-medium">
                  {{ question.title }}
                </legend>
                <label v-for="option in question.options" :key="option.value" class="mt-1 flex items-start gap-2 rounded-md px-2 py-1 text-sm hover:bg-white dark:hover:bg-gray-800">
                  <input
                    type="radio" class="mt-1 shrink-0" :name="`muge-question-${question.id}`" :value="option.value"
                    :checked="surveyAnswers[question.id] === option.value" @change="surveyEdits[question.id] = option.value"
                  >
                  <span class="break-words">{{ option.text }}</span>
                </label>
              </fieldset>
              <BaseButton type="submit" variant="primary" class="mt-3 min-h-11" :loading="pending === 'finishSurvey'" :disabled="!canOperate || !surveyComplete">
                提交人格测评
              </BaseButton>
            </form>
            <p v-else class="mt-2 text-sm text-gray-500 dark:text-gray-400">
              暂未取得测评题目
            </p>
          </section>
        </div>
      </template>
      <details v-if="activity.sections?.length" class="mt-4 text-sm">
        <summary class="cursor-pointer font-medium">
          查看活动规则
        </summary>
        <div class="grid mt-2 min-w-0 gap-3 md:grid-cols-2">
          <section v-for="section in activity.sections" :key="section.key" class="min-w-0 rounded-lg bg-gray-50 p-3 dark:bg-gray-900/50">
            <h3 class="font-semibold">
              {{ section.title }}
            </h3>
            <p v-for="(line, index) in section.lines" :key="index" class="[overflow-wrap:anywhere] mt-1 whitespace-pre-wrap">
              {{ line }}
            </p>
          </section>
        </div>
        <p v-for="(note, index) in activity.notes || []" :key="index" class="mt-2 break-words">
          {{ note }}
        </p>
      </details>
    </template>
  </section>
</template>
