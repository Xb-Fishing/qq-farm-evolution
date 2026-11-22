import { defineStore } from 'pinia'
import { computed, ref, toRaw } from 'vue'
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
  const acknowledging = ref(false)
  const error = ref('')
  const errorCode = ref('')
  const quote = ref<any>(null)
  const reviewNotice = ref('')
  let expiryTimer: ReturnType<typeof setTimeout> | undefined
  function clearQuote() {
    clearTimeout(expiryTimer)
    quote.value = null
    reviewNotice.value = ''
  }
  const expiryNotice = '本次确认已到期，请重新核对数量和费用。'
  function showQuote(selected: any) {
    clearQuote()
    quote.value = selected
    if (selected.deadline !== null) {
      const remaining = selected.deadline - performance.now()
      if (remaining <= 0) {
        reviewNotice.value = expiryNotice
      }
      else {
        expiryTimer = setTimeout(() => {
          reviewNotice.value = expiryNotice
        }, remaining)
      }
    }
  }
  const result = ref<any>(null)
  const automation = ref<any>(null)
  const savingAutomation = ref(false)
  const optionState = ref<any>(null)
  const optionShops = ref<Record<string, any>>({})
  const optionError = ref('')
  const loadingOptions = ref(false)
  const reads = new Map<string, Promise<any>>()
  let optionsSequence = 0
  const uncertain = computed(() => ['pending', 'unknown', 'partial'].includes(result.value?.outcome || ''))
  const blocked = computed(() => !state.value || readError.value || loading.value || preparing.value || operating.value || acknowledging.value || uncertain.value || !!state.value?.sceneRecoveryRequired)
  let generation = 0
  let readSequence = 0
  let confirmationSequence = 0
  const controllers = new Set<AbortController>()
  const outcomes = new Map<string, any>()
  function cancel() {
    void closeQuote()
    generation++
    optionsSequence++
    reads.clear()
    loadingOptions.value = false
    for (const controller of controllers) controller.abort()
    controllers.clear()
    loading.value = false
    preparing.value = false
    operating.value = false
    acknowledging.value = false
    savingAutomation.value = false
  }
  function bind(id: string) {
    cancel()
    accountId.value = String(id || '')
    state.value = null
    optionState.value = null
    optionShops.value = {}
    optionError.value = ''
    automation.value = null
    readError.value = false
    error.value = ''
    errorCode.value = ''
    result.value = outcomes.get(accountId.value) || null
  }
  function sessionKey() {
    try {
      return typeof localStorage === 'undefined' ? '' : localStorage.getItem('admin_token') || ''
    }
    catch {
      return ''
    }
  }
  function accountHeaders(id: string, beforeSend?: () => void) {
    return {
      errorFeedback: 'consumer' as const,
      headers: { 'x-account-id': id },
      transformRequest: [(body: any, headers: any) => {
        beforeSend?.()
        // The shared request interceptor may have selected a different account.
        headers['x-account-id'] = id
        if (body === undefined)
          return body
        headers['Content-Type'] = 'application/json'
        return JSON.stringify(body)
      }],
    }
  }
  function requestConfig(id: string, token: number) {
    const controller = new AbortController()
    controllers.add(controller)
    return {
      controller,
      config: {
        timeout: 30000,
        signal: controller.signal,
        ...accountHeaders(id, () => {
          if (generation !== token || accountId.value !== id || controller.signal.aborted)
            throw Object.assign(new Error('已取消'), { code: 'ERR_CANCELED' })
        }),
      },
    }
  }
  function failure(e: any) {
    const body = e?.response?.data
    error.value = body?.error || e?.message || '牧场请求暂时失败，请稍后重试'
    errorCode.value = body?.code || ''
  }
  async function readFriend(gid?: string) {
    const id = accountId.value
    if (!id)
      return null
    const token = generation
    const request = requestConfig(id, token)
    try {
      const { data } = await api.get(gid ? '/api/ranch/friend' : '/api/friends', {
        ...request.config,
        ...(gid && { params: { gid } }),
      })
      if (generation !== token)
        return null
      if (data?.ok !== true || data.data?.sceneRecoveryRequired)
        throw new Error(data?.error || '好友牧场暂不可用，请稍后刷新')
      return data.data
    }
    finally {
      controllers.delete(request.controller)
    }
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
  function rememberOptions(snapshot: any) {
    if (!snapshot || snapshot.sceneRecoveryRequired)
      return
    if (!optionState.value || Number(snapshot.serverTime ?? 0) >= Number(optionState.value.serverTime ?? 0))
      optionState.value = snapshot
    const shop = snapshot.shop
    if (shop && Array.isArray(shop.goods))
      optionShops.value = { ...optionShops.value, [shop.shopId]: { ...shop, fetchedAt: Date.now() } }
  }
  function readSnapshot(id: string, token: number, view: string, shopId: string) {
    const key = `${view}:${shopId}`
    const pending = reads.get(key)
    if (pending)
      return pending
    const request = requestConfig(id, token)
    const task = api.get('/api/ranch/state', { ...request.config, params: { view, shopId } })
      .then(({ data }) => {
        if (data?.ok !== true || !data.data)
          throw Object.assign(new Error(data?.error || '牧场数据未能读取'), { response: { data } })
        if (generation === token)
          rememberOptions(data.data)
        return data.data
      })
      .finally(() => {
        controllers.delete(request.controller)
        if (reads.get(key) === task)
          reads.delete(key)
      })
    reads.set(key, task)
    return task
  }
  async function loadOptions(selectedShop: string, force = false) {
    if (!accountId.value || !['5', '6'].includes(selectedShop))
      return
    const id = accountId.value
    const token = generation
    const sequence = ++optionsSequence
    const current = () => token === generation && sequence === optionsSequence
    loadingOptions.value = true
    optionError.value = ''
    try {
      // Finish the active scene read before asking for another shop.
      await Promise.allSettled([...reads.values()])
      for (const shop of new Set([selectedShop, '5'])) {
        if (!current())
          return
        if (!force && Date.now() - (optionShops.value[shop]?.fetchedAt ?? 0) < 60000)
          continue
        const state = await readSnapshot(id, token, 'shop', shop)
        if (state.sceneRecoveryRequired || String(state.shop?.shopId) !== shop)
          throw new Error('该商店尚未读到，请稍后刷新选项')
      }
    }
    catch (e: any) {
      if (current() && e?.code !== 'ERR_CANCELED')
        optionError.value = e?.response?.data?.error || e?.message || '选项暂时无法读取'
    }
    finally {
      if (current())
        loadingOptions.value = false
    }
  }
  async function refresh(nextView = view.value, nextShop = shopId.value) {
    const id = accountId.value
    if (!id || operating.value || acknowledging.value)
      return false
    const token = generation
    const sequence = ++readSequence
    confirmationSequence++
    preparing.value = false
    view.value = nextView
    shopId.value = nextShop
    loading.value = true
    error.value = ''
    errorCode.value = ''
    void closeQuote()
    try {
      const snapshot = await readSnapshot(id, token, nextView, nextShop)
      if (generation !== token || sequence !== readSequence)
        return false
      state.value = snapshot
      readError.value = false
      const previous = outcomes.get(id)
      const observed = snapshot.lastOperation
      // A lost HTTP response may refer to a still-unconsumed feed quote, rather than the latest operation.
      if (previous?.outcome === 'unknown' && previous.feedOperation && observed?.id !== previous.id) {
        const request = requestConfig(id, token)
        try {
          const { data } = await api.post('/api/ranch/reconcile-feed', { operationId: previous.id }, request.config)
          if (generation !== token || sequence !== readSequence || outcomes.get(id) !== previous)
            return false
          result.value = data?.ok === true && data.data?.id === previous.id
            ? (['unknown', 'partial', 'pending'].includes(observed?.outcome) ? observed : data.data)
            : previous
        }
        finally {
          controllers.delete(request.controller)
        }
      }
      else {
        result.value = previous?.outcome === 'unknown' && observed?.id !== previous.id ? previous : observed || null
      }
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
      if (generation === token && sequence === readSequence)
        loading.value = false
    }
  }
  async function prepare(action: string, input: Record<string, any> = {}, renewing = false) {
    const id = accountId.value
    if (!id || blocked.value)
      return false
    if (!renewing)
      void closeQuote()
    const token = generation
    const sequence = ++confirmationSequence
    preparing.value = true
    error.value = ''
    errorCode.value = ''
    const request = requestConfig(id, token)
    try {
      const intent = { action, input: JSON.parse(JSON.stringify(input)) }
      const { data } = await api.post('/api/ranch/prepare', intent, request.config)
      // An abandoned prepare can finish despite aborting the request. Its quote expires on the worker.
      if (generation !== token || sequence !== confirmationSequence)
        return false
      if (data?.ok !== true)
        throw Object.assign(new Error(data?.error || '未能准备操作'), { response: { data } })
      if (data.data?.sceneRecoveryRequired)
        throw new Error('正在恢复农场，请稍后重新准备操作')
      if (!data.data?.id)
        throw new Error('未取得牧场确认记录，请重新准备')
      const ttl = data.data.validForMs
      // A legacy server only supplies an absolute game time; let it validate that quote.
      const deadline = Number.isFinite(ttl) ? performance.now() + Math.max(0, ttl) : null
      const previous = quote.value
      if (renewing && previous?.id && previous.id !== data.data.id
        && (previous.deadline === null || performance.now() < previous.deadline)) {
        // A fresh review replaces the earlier one. If cancellation fails, its worker TTL still applies.
        void cancelPreparedQuote(id, previous.id).catch(() => {})
      }
      showQuote({ ...data.data, intent, deadline, renewed: renewing })
      return true
    }
    catch (e: any) {
      if (generation === token && sequence === confirmationSequence && e?.code !== 'ERR_CANCELED') {
        failure(e)
        if (renewing)
          reviewNotice.value = error.value
      }
      return false
    }
    finally {
      controllers.delete(request.controller)
      if (generation === token && sequence === confirmationSequence)
        preparing.value = false
    }
  }
  async function execute() {
    const selected = quote.value
    const id = accountId.value
    if (!selected || !id || preparing.value || operating.value || acknowledging.value)
      return false
    if (reviewNotice.value || (selected.deadline !== null && performance.now() >= selected.deadline)) {
      await prepare(selected.intent.action, selected.intent.input, true)
      return false
    }
    const token = generation
    const sequence = confirmationSequence
    clearQuote()
    operating.value = true
    error.value = ''
    // A re-entered panel can observe a newer result before this HTTP request settles.
    const lastOutcome = outcomes.get(id)
    const pendingOutcome = { id: selected.id, outcome: 'unknown', label: selected.label, message: '请求结果正在确认；不会自动重试' }
    outcomes.set(id, pendingOutcome)
    const ownsOutcome = () => toRaw(outcomes.get(id)) === pendingOutcome
    const request = requestConfig(id, token)
    try {
      const { data } = await api.post('/api/ranch/operate', { quoteId: selected.id }, request.config)
      if (data?.ok !== true)
        throw Object.assign(new Error(data?.error || '操作未完成'), { response: { data } })
      if (!data.data || typeof data.data !== 'object')
        throw new Error('操作回执不完整，请刷新核对')
      if (!ownsOutcome())
        return false
      outcomes.set(id, data.data)
      if (generation !== token)
        return false
      result.value = data.data
      if (data.data.snapshot) {
        state.value = { ...data.data.snapshot, lastOperation: data.data, sceneRecoveryRequired: data.data.sceneRecoveryRequired }
        rememberOptions(state.value)
      }
      else if (data.data.refreshRequired) {
        readError.value = true
      }
      return data.data.outcome === 'confirmed'
    }
    catch (e: any) {
      if (!ownsOutcome())
        return false
      const body = e?.response?.data
      if (body?.ok === false && body.operationNotSent === true && body.quoteId === selected.id && !body.sceneRecoveryRequired) {
        const unsent = { id: selected.id, outcome: 'not_sent', label: selected.label, message: body.error || '本次请求未发出' }
        outcomes.set(id, unsent)
        if (generation === token && sequence === confirmationSequence) {
          failure(e)
          result.value = unsent
          showQuote({ ...selected, notSentMessage: error.value })
        }
        return false
      }
      if (body?.ok === false && ['RANCH_QUOTE_EXPIRED', 'RANCH_STATE_CHANGED', 'RANCH_CONFIRMATION_MISSING', 'RANCH_SESSION_CHANGED'].includes(body.code)) {
        if (lastOutcome)
          outcomes.set(id, lastOutcome)
        else
          outcomes.delete(id)
        if (generation === token && sequence === confirmationSequence) {
          failure(e)
          if (!body.sceneRecoveryRequired && ['RANCH_QUOTE_EXPIRED', 'RANCH_STATE_CHANGED'].includes(body.code)) {
            quote.value = selected
            reviewNotice.value = error.value
          }
          else {
            readError.value = true
          }
        }
        return false
      }
      const action = selected.intent?.action
      const feedOperation = action === 'addGrass' || (action === 'buy' && String(selected.intent?.input?.goodsId) === '10001' && String(selected.intent?.input?.shopId) === '6')
      const uncertain = { id: selected.id, action, feedOperation, outcome: 'unknown', label: selected.label, message: feedOperation ? '牧草操作状态暂未确认，程序会自动读取库存，不会重发原单' : '请求状态暂未确认，请刷新核对；不会自动重试' }
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
    const operationId = selected?.id
    const id = accountId.value
    if (!selected || typeof operationId !== 'string' || !operationId || !uncertain.value || operating.value || loading.value || acknowledging.value)
      return false
    const token = generation
    const request = requestConfig(id, token)
    acknowledging.value = true
    const ownsResult = () => generation === token && accountId.value === id && result.value === selected
      && result.value?.id === operationId && uncertain.value
    try {
      const { data } = await api.post('/api/ranch/acknowledge', { operationId }, request.config)
      if (!ownsResult())
        return false
      if (data?.ok !== true)
        throw Object.assign(new Error(data?.error || '请先刷新核对'), { response: { data } })
      if (data.data?.id !== operationId || !['acknowledged', 'not_sent'].includes(data.data?.outcome))
        throw new Error('核对回执未匹配当前操作，请刷新核对')
      result.value = data.data
      outcomes.set(id, data.data)
      error.value = ''
      return true
    }
    catch (e: any) {
      if (ownsResult() && e?.code !== 'ERR_CANCELED')
        failure(e)
      return false
    }
    finally {
      controllers.delete(request.controller)
      if (generation === token)
        acknowledging.value = false
    }
  }
  async function cancelPreparedQuote(id: string, quoteId: string) {
    const session = sessionKey()
    // The request stays bound to this account even if the panel changes or unmounts.
    const { data } = await api.post('/api/ranch/cancel', { quoteId }, {
      ...accountHeaders(id, () => {
        if (sessionKey() !== session)
          throw Object.assign(new Error('已取消'), { code: 'ERR_CANCELED' })
      }),
      timeout: 5000,
      // Consume auth failures here before the shared interceptor can clear a new login.
      validateStatus: (status: number) => (status >= 200 && status < 300) || status === 401 || status === 403,
    })
    if (data?.ok !== true || data.data?.cancelled !== true)
      throw Object.assign(new Error('无法取消这条牧场确认记录'), { response: { data } })
  }
  async function closeQuote() {
    const quoteId = quote.value?.id
    const id = accountId.value
    if (operating.value) {
      confirmationSequence++
      return false
    }
    if (!quoteId || !id) {
      if (preparing.value) {
        confirmationSequence++
        preparing.value = false
      }
      return false
    }
    const token = generation
    const session = sessionKey()
    const sequence = ++confirmationSequence
    const previousResult = result.value
    clearQuote()
    preparing.value = false
    try {
      await cancelPreparedQuote(id, quoteId)
      return true
    }
    catch (e: any) {
      if (generation === token && sessionKey() === session && accountId.value === id && sequence === confirmationSequence
        && result.value === previousResult && !uncertain.value) {
        error.value = `牧场取消未确认：${e?.response?.data?.error || e?.message || '请求失败'}`
        errorCode.value = ''
      }
      return false
    }
  }
  return { accountId, view, shopId, state, loading, preparing, operating, acknowledging, error, errorCode, quote, reviewNotice, result, uncertain, blocked, automation, savingAutomation, optionState, optionShops, optionError, loadingOptions, loadOptions, loadAutomation: () => automationRequest(), saveAutomation: automationRequest, bind, cancel, refresh, readFriend, prepare, execute, acknowledge, closeQuote }
})
