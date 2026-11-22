import { defineStore } from 'pinia'
import { ref } from 'vue'
import api from '@/api'

export interface MugeReward {
  id: string
  count: string
  name: string
  image?: string
}

export interface MugeRewardRow {
  id: string
  threshold: string
  status: number
  rewards: MugeReward[]
}

export interface MugeTaskRow {
  id: string
  description: string
  progress: string
  target: string
  status: number
  unlockDay: string
  rewards: MugeReward[]
}

export interface MugeQuestion {
  id: number
  title: string
  options: { value: number, text: string }[]
}

interface MugePersonality {
  answers: Record<string, number>
  personalityId: number
  settleCount: string
  shareRewardClaimed: boolean
}

interface MugePersonal {
  celebration: { total: string, tiers: MugeRewardRow[] } | null
  friends: { count: number, tiers: MugeRewardRow[] } | null
  handbook: { points: string, tiers: MugeRewardRow[], tasks: MugeTaskRow[] } | null
  personality: MugePersonality | null
}

export interface MugeActivity {
  available: boolean
  title?: string
  startTime?: number | null
  reason?: string
  endTime: number | null
  phase?: 'upcoming' | 'open'
  notes?: string[]
  personal: MugePersonal | null
  sections?: { key: string, title: string, lines: string[] }[]
  questions?: MugeQuestion[]
  automation?: { enabled: boolean }
}

export type MugeOperation
  = | { action: 'claimCelebration' | 'claimFriends' | 'claimTask' | 'claimHandbook' | 'resetSurvey' | 'claimShare', input?: never }
    | { action: 'finishSurvey', input: { answers: Record<string, number> } }
    | { action: 'setAutomation', input: { enabled: boolean } }

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

function isText(value: unknown): value is string {
  return typeof value === 'string'
}

function isCount(value: unknown) {
  return typeof value === 'string' && /^\d+$/.test(value)
}

function isReward(value: unknown): value is MugeReward {
  return isRecord(value) && isText(value.id) && isCount(value.count) && isText(value.name)
    && (value.image === undefined || isText(value.image))
}

function isList<T>(value: unknown, item: (entry: unknown) => entry is T): value is T[] {
  return Array.isArray(value) && value.every(item)
}

function isRewardRow(value: unknown): value is MugeRewardRow {
  return isRecord(value) && isText(value.id) && isCount(value.threshold) && Number.isInteger(value.status)
    && isList(value.rewards, isReward)
}

function isTaskRow(value: unknown): value is MugeTaskRow {
  return isRecord(value) && isText(value.id) && isText(value.description) && isCount(value.progress)
    && isCount(value.target) && Number.isInteger(value.status) && isCount(value.unlockDay) && isList(value.rewards, isReward)
}

function isQuestion(value: unknown): value is MugeQuestion {
  return isRecord(value) && Number.isSafeInteger(value.id) && isText(value.title) && Array.isArray(value.options)
    && value.options.length > 0 && value.options.every(option => isRecord(option) && Number.isSafeInteger(option.value) && isText(option.text))
}

function isPersonal(value: unknown) {
  if (value === null)
    return true
  if (!isRecord(value))
    return false
  const { celebration, friends, handbook, personality } = value
  return (celebration === null || (isRecord(celebration) && isCount(celebration.total) && isList(celebration.tiers, isRewardRow)))
    && (friends === null || (isRecord(friends) && Number.isSafeInteger(friends.count) && isList(friends.tiers, isRewardRow)))
    && (handbook === null || (isRecord(handbook) && isCount(handbook.points) && isList(handbook.tiers, isRewardRow) && isList(handbook.tasks, isTaskRow)))
    && (personality === null || (isRecord(personality) && isRecord(personality.answers)
      && Object.values(personality.answers).every(Number.isSafeInteger) && Number.isSafeInteger(personality.personalityId)
      && isCount(personality.settleCount) && typeof personality.shareRewardClaimed === 'boolean'))
}

function parseActivity(value: unknown): MugeActivity {
  if (!isRecord(value) || typeof value.available !== 'boolean')
    throw new Error('活动回复格式异常')
  if (value.endTime != null && (typeof value.endTime !== 'number' || !Number.isSafeInteger(value.endTime) || value.endTime <= 0))
    throw new Error('活动截止格式异常')
  if (value.available) {
    if (!Array.isArray(value.sections) || value.sections.some(section => !isRecord(section) || !isText(section.key) || !isText(section.title) || !isList(section.lines, isText)))
      throw new Error('活动规则格式异常')
    if ((value.phase !== 'upcoming' && value.phase !== 'open') || !isList(value.notes, isText) || !isPersonal(value.personal)
      || (value.questions !== undefined && !isList(value.questions, isQuestion))
      || (value.automation !== undefined && (!isRecord(value.automation) || typeof value.automation.enabled !== 'boolean'))) {
      throw new Error('活动状态格式异常')
    }
  }
  return value as unknown as MugeActivity
}

export const useMugeStore = defineStore('muge', () => {
  const accountId = ref('')
  const activity = ref<MugeActivity | null>(null)
  const loading = ref(false)
  const pending = ref<MugeOperation['action'] | null>(null)
  const ready = ref(false)
  const refreshRequired = ref(false)
  const error = ref('')
  const feedback = ref('')
  const rewards = ref<MugeReward[]>([])
  const deadlines = new Map<string, number>()
  let generation = 0
  let controller: AbortController | null = null
  let timer: ReturnType<typeof setTimeout> | null = null

  function rememberDeadline(value: unknown) {
    if (typeof value !== 'number' && (typeof value !== 'string' || !/^\d+$/.test(value)))
      return
    const end = Number(value)
    if (!Number.isSafeInteger(end) || end <= 0)
      return
    const earliest = Math.min(deadlines.get(accountId.value) ?? end, end)
    deadlines.set(accountId.value, earliest)
    if (activity.value && activity.value.endTime !== earliest)
      activity.value = { ...activity.value, endTime: earliest }
  }
  function clearTimer() {
    if (timer != null)
      clearTimeout(timer)
    timer = null
  }
  function expired() {
    const end = deadlines.get(accountId.value)
    return end != null && Date.now() >= end * 1000
  }
  function cancel() {
    ++generation
    controller?.abort()
    controller = null
    clearTimer()
    loading.value = false
    pending.value = null
    ready.value = false
  }
  function hideExpired() {
    if (!expired())
      return false
    cancel()
    activity.value = { available: false, reason: '活动已结束', endTime: deadlines.get(accountId.value) ?? null, personal: null }
    return true
  }
  function schedule() {
    clearTimer()
    const end = deadlines.get(accountId.value)
    if (end == null || hideExpired())
      return
    const token = generation
    timer = setTimeout(() => {
      timer = null
      if (token === generation && !hideExpired())
        schedule()
    }, Math.min(2147483647, Math.max(1, end * 1000 - Date.now())))
  }
  function bind(id: string) {
    cancel()
    accountId.value = id
    activity.value = null
    error.value = ''
    feedback.value = ''
    rewards.value = []
    refreshRequired.value = false
    hideExpired()
  }
  function startRequest(id: string) {
    ++generation
    controller?.abort()
    const token = generation
    const request = new AbortController()
    controller = request
    const current = () => token === generation && id === accountId.value
    const config = {
      headers: { 'x-account-id': id },
      signal: request.signal,
      timeout: 120000,
      errorFeedback: 'consumer' as const,
      transformRequest: [(body: unknown, headers: Record<string, string>) => {
        if (!current() || request.signal.aborted || expired())
          throw Object.assign(new Error('已取消'), { code: 'ERR_CANCELED' })
        // The shared interceptor reads the current selection before this transform.
        headers['x-account-id'] = id
        if (body === undefined)
          return body
        headers['Content-Type'] = 'application/json'
        return JSON.stringify(body)
      }],
    }
    schedule()
    return { current, config }
  }
  function acceptActivity(value: unknown) {
    const next = parseActivity(value)
    rememberDeadline(next.endTime)
    if (hideExpired())
      return false
    activity.value = { ...next, endTime: deadlines.get(accountId.value) ?? null }
    return true
  }
  async function refresh(id: string) {
    if (id !== accountId.value)
      bind(id)
    if (!id || hideExpired() || pending.value)
      return
    ready.value = false
    loading.value = true
    error.value = ''
    const { current, config } = startRequest(id)
    if (!current())
      return
    try {
      const { data, headers } = await api.get('/api/activity/muge', config)
      if (!current())
        return
      rememberDeadline(headers?.['x-activity-end-time'])
      if (hideExpired())
        return
      if (data?.ok !== true)
        throw new Error(data?.error || '活动回复格式异常')
      if (acceptActivity(data.activity)) {
        ready.value = true
        refreshRequired.value = false
      }
    }
    catch (cause: any) {
      if (!current())
        return
      rememberDeadline(cause?.response?.headers?.['x-activity-end-time'])
      if (!hideExpired())
        error.value = cause?.response?.data?.error || cause?.message || '读取失败'
    }
    finally {
      if (current()) {
        loading.value = false
        controller = null
        schedule()
      }
    }
  }
  function acceptOperation(data: unknown) {
    if (!isRecord(data) || typeof data.ok !== 'boolean')
      throw new Error('操作结果待确认')
    if (data.activity != null && !acceptActivity(data.activity))
      return
    if (isList(data.rewards, isReward))
      rewards.value = data.rewards
    refreshRequired.value = data.refreshRequired === true || data.code === 'MUGE_RESULT_UNKNOWN' || data.activity == null
    ready.value = !refreshRequired.value
    if (data.ok)
      feedback.value = '操作已完成'
    else
      error.value = typeof data.error === 'string' ? data.error : '操作结果待确认'
  }
  async function operate(id: string, { action, input }: MugeOperation) {
    if (!id || id !== accountId.value || hideExpired() || !ready.value || loading.value || pending.value
      || !activity.value?.available || activity.value.phase !== 'open') {
      return
    }
    pending.value = action
    error.value = ''
    feedback.value = ''
    rewards.value = []
    const { current, config } = startRequest(id)
    if (!current())
      return
    try {
      const { data, headers } = await api.post('/api/activity/muge/operate', { action, input }, config)
      if (!current())
        return
      rememberDeadline(headers?.['x-activity-end-time'])
      if (!hideExpired())
        acceptOperation(data)
    }
    catch (cause: any) {
      if (!current())
        return
      rememberDeadline(cause?.response?.headers?.['x-activity-end-time'])
      if (hideExpired())
        return
      const reply = cause?.response?.data
      refreshRequired.value = true
      ready.value = false
      error.value = reply?.error || cause?.message || '操作结果待确认'
    }
    finally {
      if (current()) {
        pending.value = null
        controller = null
        schedule()
      }
    }
  }
  return { accountId, activity, loading, pending, ready, refreshRequired, error, feedback, rewards, bind, refresh, operate, cancel }
})
