import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import api from '@/api'

export const useRanchStore = defineStore('ranch', () => {
  const accountId = ref('')
  const view = ref('animals')
  const shopId = ref('5')
  const state = ref<any>(null)
  const readError = ref(false)
  const loading = ref(false)
  const preparing = ref(false)
  const operating = ref(false)
  const error = ref('')
  const errorCode = ref('')
  const quote = ref<any>(null)
  const result = ref<any>(null)
  const automation = ref<any>(null)
  const savingAutomation = ref(false)
  const uncertain = computed(() => ['pending', 'unknown', 'partial'].includes(result.value?.outcome || ''))
  const blocked = computed(() => !state.value || readError.value || loading.value || preparing.value || operating.value || uncertain.value || !!state.value?.sceneRecoveryRequired)
  let generation = 0
  let readSequence = 0
  let confirmationSequence = 0
  const controllers = new Set<AbortController>()
  const outcomes = new Map<string, any>()
  function cancel() {
    generation++
    confirmationSequence++
    for (const controller of controllers) controller.abort()
    controllers.clear()
    quote.value = null
    loading.value = false
    preparing.value = false
    operating.value = false
    savingAutomation.value = false
  }
  function bind(id: string) {
    cancel()
    accountId.value = String(id || '')
    state.value = null
    automation.value = null
    readError.value = false
    error.value = ''
    errorCode.value = ''
    result.value = outcomes.get(accountId.value) || null
  }
  function requestConfig(id: string, token: number) {
    const controller = new AbortController()
    controllers.add(controller)
    return {
      controller,
      config: {
        timeout: 30000,
        signal: controller.signal,
        errorFeedback: 'consumer' as const,
        headers: { 'x-account-id': id },
        transformRequest: [(body: any, headers: any) => {
          if (generation !== token || accountId.value !== id || controller.signal.aborted)
            throw Object.assign(new Error('已取消'), { code: 'ERR_CANCELED' })
          headers['x-account-id'] = id
          if (body === undefined)
            return body
          headers['Content-Type'] = 'application/json'
          return JSON.stringify(body)
        }],
      },
    }
  }
  function failure(e: any) {
    const body = e?.response?.data
    error.value = body?.error || e?.message || '牧场请求暂时失败，请稍后重试'
    errorCode.value = body?.code || ''
  }
  async function automationRequest(policy?: Record<string, any>) {
    const id = accountId.value
    if (!id || savingAutomation.value)
      return false
    const token = generation
    const request = requestConfig(id, token)
    savingAutomation.value = true
    try {
      const { data } = policy
        ? await api.post('/api/ranch/automation', policy, request.config)
        : await api.get('/api/ranch/automation', request.config)
      if (generation !== token)
        return false
      if (data?.ok !== true)
        throw Object.assign(new Error(data?.error || '自动化设置未保存'), { response: { data } })
      automation.value = data.data
      return true
    }
    catch (e: any) {
      if (generation === token && e?.code !== 'ERR_CANCELED')
        failure(e)
      return false
    }
    finally {
      controllers.delete(request.controller)
      if (generation === token)
        savingAutomation.value = false
    }
  }
  async function refresh(nextView = view.value, nextShop = shopId.value) {
    const id = accountId.value
    if (!id || operating.value)
      return false
    const token = generation
    const sequence = ++readSequence
    confirmationSequence++
    view.value = nextView
    shopId.value = nextShop
    quote.value = null
    loading.value = true
    error.value = ''
    errorCode.value = ''
    const request = requestConfig(id, token)
    try {
      const { data } = await api.get('/api/ranch/state', { ...request.config, params: { view: nextView, shopId: nextShop } })
      if (generation !== token || sequence !== readSequence)
        return false
      if (data?.ok !== true)
        throw Object.assign(new Error(data?.error || '牧场数据未能读取'), { response: { data } })
      state.value = data.data
      readError.value = false
      result.value = data.data.lastOperation || null
      outcomes.set(id, result.value)
      return true
    }
    catch (e: any) {
      if (generation === token && sequence === readSequence && e?.code !== 'ERR_CANCELED') {
        failure(e)
        readError.value = true
      }
      return false
    }
    finally {
      controllers.delete(request.controller)
      if (generation === token && sequence === readSequence)
        loading.value = false
    }
  }
  async function prepare(action: string, input: Record<string, any> = {}) {
    const id = accountId.value
    if (!id || blocked.value)
      return false
    const token = generation
    const sequence = ++confirmationSequence
    preparing.value = true
    quote.value = null
    error.value = ''
    errorCode.value = ''
    const request = requestConfig(id, token)
    try {
      const { data } = await api.post('/api/ranch/prepare', { action, input }, request.config)
      if (generation !== token || sequence !== confirmationSequence)
        return false
      if (data?.ok !== true)
        throw Object.assign(new Error(data?.error || '未能准备操作'), { response: { data } })
      if (data.data?.sceneRecoveryRequired)
        throw new Error('正在恢复农场，请稍后重新准备操作')
      quote.value = data.data
      return true
    }
    catch (e: any) {
      if (generation === token && e?.code !== 'ERR_CANCELED')
        failure(e)
      return false
    }
    finally {
      controllers.delete(request.controller)
      if (generation === token)
        preparing.value = false
    }
  }
  async function execute() {
    const selected = quote.value
    const id = accountId.value
    if (!selected || !id || operating.value)
      return false
    if (selected.expiresAt <= Date.now()) {
      quote.value = null
      error.value = '确认已过期，请重新准备'
      return false
    }
    const token = generation
    quote.value = null
    operating.value = true
    error.value = ''
    const request = requestConfig(id, token)
    try {
      const { data } = await api.post('/api/ranch/operate', { quoteId: selected.id }, request.config)
      if (data?.ok !== true)
        throw Object.assign(new Error(data?.error || '操作未完成'), { response: { data } })
      outcomes.set(id, data.data)
      if (generation !== token)
        return false
      result.value = data.data
      if (data.data.snapshot)
        state.value = { ...data.data.snapshot, lastOperation: data.data, sceneRecoveryRequired: data.data.sceneRecoveryRequired }
      return data.data.outcome === 'confirmed'
    }
    catch (e: any) {
      const uncertain = { id: selected.id, outcome: 'unknown', label: selected.label, message: '请求状态暂未确认，请刷新核对；不会自动重试' }
      outcomes.set(id, uncertain)
      if (generation === token) {
        if (e?.code !== 'ERR_CANCELED')
          failure(e)
        result.value = uncertain
      }
      return false
    }
    finally {
      controllers.delete(request.controller)
      if (generation === token)
        operating.value = false
    }
  }
  async function acknowledge() {
    const selected = result.value
    const id = accountId.value
    if (!selected || operating.value || loading.value)
      return false
    const token = generation
    const request = requestConfig(id, token)
    try {
      const { data } = await api.post('/api/ranch/acknowledge', { operationId: selected.id }, request.config)
      if (generation !== token)
        return false
      if (data?.ok !== true)
        throw Object.assign(new Error(data?.error || '请先刷新核对'), { response: { data } })
      result.value = data.data
      outcomes.set(id, data.data)
      error.value = ''
      return true
    }
    catch (e: any) {
      if (generation === token && e?.code !== 'ERR_CANCELED')
        failure(e)
      return false
    }
    finally { controllers.delete(request.controller) }
  }
  function closeQuote() {
    confirmationSequence++
    quote.value = null
  }
  return { accountId, view, shopId, state, loading, preparing, operating, error, errorCode, quote, result, uncertain, blocked, automation, savingAutomation, loadAutomation: () => automationRequest(), saveAutomation: automationRequest, bind, cancel, refresh, prepare, execute, acknowledge, closeQuote }
})
