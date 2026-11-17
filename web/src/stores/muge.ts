import { defineStore } from 'pinia'
import { ref } from 'vue'
import api from '@/api'

export interface MugeActivity {
  available: boolean
  title?: string
  startTime?: number | null
  reason?: string
  endTime: number | null
  phase?: 'upcoming' | 'open'
  notes?: string[]
  personal: null
  sections?: { key: string, title: string, lines: string[] }[]
}
export const useMugeStore = defineStore('muge', () => {
  const accountId = ref('')
  const activity = ref<MugeActivity | null>(null)
  const loading = ref(false)
  const error = ref('')
  const deadlines = new Map<string, number>()
  function rememberDeadline(value: unknown) {
    if (typeof value !== 'number' && (typeof value !== 'string' || !/^\d+$/.test(value)))
      return
    const end = Number(value)
    if (!Number.isSafeInteger(end) || end <= 0)
      return
    const earliest = Math.min(deadlines.get(accountId.value) ?? end, end)
    deadlines.set(accountId.value, earliest)
    if (activity.value)
      activity.value = { ...activity.value, endTime: earliest }
  }
  let generation = 0
  let controller: AbortController | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  function clearTimer() {
    if (timer != null)
      clearTimeout(timer)
    timer = null
  }
  function expired(id = accountId.value) {
    const end = deadlines.get(id)
    return end != null && Date.now() >= end * 1000
  }
  function hideExpired() {
    if (!expired())
      return false
    ++generation
    controller?.abort()
    controller = null
    clearTimer()
    activity.value = { available: false, reason: '活动已结束', endTime: deadlines.get(accountId.value) ?? null, personal: null }
    loading.value = false
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
      if (token !== generation)
        return
      if (!hideExpired())
        schedule()
    }, Math.min(2147483647, Math.max(1, end * 1000 - Date.now())))
  }
  function cancel() {
    ++generation
    controller?.abort()
    controller = null
    clearTimer()
    loading.value = false
  }
  function bind(id: string) {
    cancel()
    accountId.value = id
    activity.value = null
    error.value = ''
    hideExpired()
  }
  async function refresh(id: string) {
    if (id !== accountId.value)
      bind(id)
    if (!id || hideExpired())
      return
    cancel()
    const token = generation
    const request = new AbortController()
    controller = request
    loading.value = true
    error.value = ''
    schedule()
    if (token !== generation)
      return
    try {
      const { data, headers } = await api.get('/api/activity/muge', { headers: { 'x-account-id': id }, signal: request.signal, timeout: 120000, errorFeedback: 'consumer' })
      if (token !== generation || id !== accountId.value)
        return
      rememberDeadline(headers?.['x-activity-end-time'])
      if (hideExpired())
        return
      if (data?.ok !== true || !data.activity || typeof data.activity.available !== 'boolean')
        throw new Error(data?.error || '活动回复格式异常')
      const next = data.activity as MugeActivity
      if (next.available && (!Array.isArray(next.sections) || next.sections.some(section => !section || typeof section.title !== 'string' || !Array.isArray(section.lines) || section.lines.some(line => typeof line !== 'string'))))
        throw new Error('活动规则格式异常')
      if (next.available && (next.personal !== null || !['upcoming', 'open'].includes(next.phase || '') || !Array.isArray(next.notes) || next.notes.some(line => typeof line !== 'string')))
        throw new Error('活动状态格式异常')
      if (next.endTime != null && (typeof next.endTime !== 'number' || !Number.isSafeInteger(next.endTime) || next.endTime <= 0))
        throw new Error('活动截止格式异常')
      if (next.endTime != null)
        rememberDeadline(next.endTime)
      activity.value = { ...next, endTime: deadlines.get(id) ?? null }
      hideExpired()
    }
    catch (cause: any) {
      if (token !== generation || id !== accountId.value)
        return
      rememberDeadline(cause?.response?.headers?.['x-activity-end-time'])
      if (!hideExpired())
        error.value = cause?.response?.data?.error || cause?.message || '读取失败'
    }
    finally {
      if (token === generation && id === accountId.value) {
        loading.value = false
        controller = null
        schedule()
      }
    }
  }
  return { accountId, activity, loading, error, bind, refresh, cancel }
})
