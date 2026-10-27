<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import api from '@/api'
import BaseButton from '@/components/ui/BaseButton.vue'

const props = defineProps<{
  accountId: string
}>()
const calendar = ref<any>(null)
const loading = ref(false)
const operating = ref(false)
const error = ref('')
const notice = ref('')
const resultRewards = ref<any[]>([])
const options = ref<Record<number, number>>({})
const pending = ref<{
  action: string
  input: Record<string, unknown>
  text: string
} | null>(null)
const dialog = ref<HTMLElement | null>(null)
let returnFocus: HTMLElement | null = null
let generation = 0
let alive = true
const currentEvents = computed(() => (calendar.value?.events || []).filter((event: any) => event.open || event.id === calendar.value?.defaultEventId))
watch(() => props.accountId, () => {
  ++generation
  calendar.value = null
  pending.value = null
  options.value = {}
  resultRewards.value = []
  loading.value = false
  operating.value = false
  error.value = ''
  notice.value = ''
})
onBeforeUnmount(() => {
  alive = false
  ++generation
})
watch(options, () => {
  if (pending.value?.action === 'answer')
    closeConfirmation()
}, { deep: true })
function closeConfirmation() {
  pending.value = null
  void nextTick(() => {
    if (returnFocus?.isConnected)
      returnFocus.focus()
  })
}
async function refresh() {
  if (!props.accountId || loading.value || operating.value)
    return
  const id = props.accountId
  const turn = ++generation
  pending.value = null
  options.value = {}
  loading.value = true
  error.value = ''
  try {
    const { data } = await api.get('/api/activity/festival', { headers: { 'x-account-id': id } })
    if (!alive || turn !== generation || id !== props.accountId)
      return
    if (data?.ok !== true || !data.calendar)
      throw new Error(data?.error || '节日签到读取失败')
    calendar.value = data.calendar
  }
  catch (failure: any) {
    if (alive && turn === generation) {
      calendar.value = null
      error.value = failure?.response?.data?.error || failure.message || '读取失败'
    }
  }
  finally {
    if (alive && turn === generation)
      loading.value = false
  }
}
function prepare(action: string, target: any) {
  if (loading.value || operating.value || !calendar.value)
    return
  if (action === 'answer' ? !target.canAnswer : !target.canClaim)
    return
  const input: Record<string, unknown> = { id: target.id }
  if (action === 'answer') {
    const index = options.value[target.id]
    if (!Number.isInteger(index) || index! < 0 || index! >= target.options.length || target.wrongOptions.includes(index))
      return
    input.optionIndex = index
    input.expectedQuestion = target.question
  }
  pending.value = { action, input, text: action === 'answer' ? `提交答案「${target.options[Number(input.optionIndex)]}」？答错可能需要等到次日再答。` : `领取${target.name}的${action === 'season' ? '季度' : '签到'}奖励？` }
  returnFocus = typeof document === 'undefined' ? null : document.activeElement as HTMLElement | null
  void nextTick(() => {
    if (dialog.value?.querySelector)
      dialog.value.querySelector<HTMLButtonElement>('button')?.focus()
  })
}
async function confirm() {
  if (!pending.value || loading.value || operating.value)
    return
  const request = pending.value
  const id = props.accountId
  const turn = generation
  closeConfirmation()
  operating.value = true
  notice.value = ''
  resultRewards.value = []
  try {
    const { data } = await api.post('/api/activity/festival', { action: request.action, input: request.input }, { headers: { 'x-account-id': id } })
    if (!alive || turn !== generation || id !== props.accountId)
      return
    notice.value = data?.message || data?.error || '操作未确认，请重新查询核对'
    if (data?.ok === true && Array.isArray(data.rewards))
      resultRewards.value = data.rewards
    operating.value = false
    // A single read reconciles success and unknown outcomes; never replay a write.
    await refresh()
  }
  catch (failure: any) {
    if (alive && turn === generation) {
      notice.value = failure?.response?.data?.error || '结果未确认，请重新查询核对'
      pending.value = null
      calendar.value = null
    }
  }
  finally {
    if (alive && turn === generation)
      operating.value = false
  }
}
const time = (value: number) => value > 0 ? new Date(value * 1000).toLocaleString() : '时间未提供'
</script>

<template>
  <section id="festival-sign-in" class="festival-panel" aria-label="节日签到与节令日历">
    <header>
      <div><h2>节日签到 · 节令日历</h2><p>查看当期节令奖励，领取种子并参与问答。</p></div>
      <BaseButton :loading="loading" :disabled="loading || operating || !accountId" variant="secondary" @click="refresh">
        查询节日签到
      </BaseButton>
    </header>
    <p v-if="!calendar && !error" class="muted">
      点击查询，查看当前可领种子、节令问题和季度图鉴奖励。
    </p>
    <p v-if="error" role="alert">
      {{ error }}
    </p><p v-if="notice" role="status">
      {{ notice }}
    </p>
    <div v-if="resultRewards.length" class="reward-list" aria-label="本次获得奖励">
      <span v-for="item in resultRewards" :key="item.id"><img v-if="item.image" :src="item.image" :alt="item.name">获得 {{ item.name }} × {{ item.count }}</span>
    </div>
    <p v-if="calendar && !currentEvents.length" class="muted">
      当前没有开放的节令签到；季度图鉴奖励仍可查看。
    </p>
    <div class="festival-grid">
      <article v-for="event in currentEvents" :key="event.id">
        <h3>{{ event.name }} <small>{{ event.open ? '进行中' : '当前不可参与' }}</small></h3>
        <p class="muted">
          {{ time(event.startTime) }} ～ {{ time(event.endTime) }}
        </p>
        <p>{{ event.description }}</p>
        <div class="reward-list">
          <span v-for="item in event.rewards" :key="item.id"><img v-if="item.image" :src="item.image" :alt="item.name">{{ item.name }} × {{ item.count }}</span>
        </div>
        <BaseButton :disabled="loading || operating || !event.canClaim" @click="prepare('claim', event)">
          {{ event.directClaimed ? '签到奖励已领取' : '领取签到奖励' }}
        </BaseButton>
        <fieldset v-if="event.question" :disabled="loading || operating || !event.canAnswer">
          <legend>{{ event.question }}</legend>
          <label v-for="(option, index) in event.options" :key="index"><input v-model="options[event.id]" type="radio" :name="`festival-${event.id}`" :value="index" :disabled="event.wrongOptions.includes(index)">{{ option }}</label>
        </fieldset>
        <div class="reward-list">
          <span v-for="item in event.questionRewards" :key="item.id"><img v-if="item.image" :src="item.image" :alt="item.name">答对可得 {{ item.name }} × {{ item.count }}</span>
        </div>
        <BaseButton v-if="event.question" :disabled="loading || operating || !event.canAnswer || options[event.id] == null" variant="secondary" @click="prepare('answer', event)">
          {{ event.quizClaimed ? '答题奖励已领取' : event.quizWrongToday ? '今日已答，明日再试' : '提交节令答案' }}
        </BaseButton>
      </article>
      <article v-for="season in calendar?.seasons || []" :key="season.id">
        <h3>{{ season.name }}图鉴</h3><p>已点亮 {{ season.litCount }} / {{ season.totalCount }}</p>
        <div class="reward-list">
          <span v-for="item in season.rewards" :key="item.id"><img v-if="item.image" :src="item.image" :alt="item.name">{{ item.name }} × {{ item.count }}</span>
        </div>
        <BaseButton :disabled="loading || operating || !season.canClaim" variant="secondary" @click="prepare('season', season)">
          {{ season.claimed ? '季度奖励已领取' : '领取季度奖励' }}
        </BaseButton>
      </article>
    </div>
    <div v-if="pending" ref="dialog" class="festival-confirm" role="dialog" aria-modal="false" aria-label="确认节日操作" tabindex="-1" @keydown.esc="closeConfirmation">
      <p>{{ pending.text }}</p><div>
        <BaseButton variant="secondary" @click="closeConfirmation">
          取消
        </BaseButton><BaseButton @click="confirm">
          确认节日操作
        </BaseButton>
      </div>
    </div>
  </section>
</template>

<style scoped>
.festival-panel {
  padding: 20px;
  border: 1px solid var(--surface-border, #dbe3ec);
  border-radius: 14px;
  background: var(--surface-1, #fff);
  color: var(--text-primary, inherit);
}
header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 12px;
}
h2,
h3 {
  font-weight: 700;
}
p,
label,
legend {
  font-size: 13px;
  line-height: 1.8;
  overflow-wrap: anywhere;
}
.muted,
small {
  color: var(--muted-text, #64748b);
  font-size: 12px;
}
.festival-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 300px), 1fr));
  gap: 16px;
  margin-top: 14px;
}
article {
  padding: 14px;
  background: var(--surface-2, #f8fafc);
  border-radius: 12px;
  min-width: 0;
}
fieldset {
  display: grid;
  gap: 6px;
  margin: 14px 0;
}
label {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 36px;
}
.reward-list {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin: 10px 0;
  font-size: 13px;
}
.reward-list span {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}
img {
  width: 32px;
  height: 32px;
  object-fit: contain;
}
.festival-confirm {
  padding: 14px;
  margin-top: 14px;
  border: 2px solid #3b82f6;
  border-radius: 12px;
}
.festival-confirm > div {
  display: flex;
  gap: 10px;
  margin-top: 10px;
}
</style>
