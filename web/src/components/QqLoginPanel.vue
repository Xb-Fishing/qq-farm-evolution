<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import api from '@/api'
import BaseButton from '@/components/ui/BaseButton.vue'

const emit = defineEmits<{ ready: [value: { code: string, nickname: string }] }>()
const enabled = ref(false)
const configured = ref(false)
const busy = ref(false)
const state = ref('idle')
const message = ref('正在检查 QQ 扫码是否可用…')
const qrImage = ref('')
let taskId = ''
let deadline = 0
let generation = 0
let mounted = true
let codeRequested = false
let controller: AbortController | null = null
let pollTimer: ReturnType<typeof setTimeout> | undefined
let expiryTimer: ReturnType<typeof setTimeout> | undefined
function sessionKey() {
  try {
    return typeof localStorage === 'undefined' ? '' : localStorage.getItem('admin_token') || ''
  }
  catch {
    return ''
  }
}
const openedSession = sessionKey()
let sessionInvalidated = false
function invalidateSession() {
  if (sessionInvalidated)
    return
  sessionInvalidated = true
  generation++
  controller?.abort()
  stopTimers()
  qrImage.value = ''
  busy.value = false
  enabled.value = false
  state.value = 'session_changed'
  message.value = '面板登录会话已变化，请重新打开 QQ 扫码'
}
function sessionChanged() {
  if (sessionKey() !== openedSession)
    invalidateSession()
}
function options(signal?: AbortSignal, timeout = 20000, cleanup = false) {
  const requestGeneration = generation
  return {
    signal,
    timeout,
    errorFeedback: 'consumer' as const,
    // Auth failures stay in this session-bound consumer, so an old 401 cannot
    // clear a replacement session in the shared response interceptor.
    validateStatus: (status: number) => (status >= 200 && status < 300) || status === 401 || status === 403,
    transformRequest: [(body: any, headers: any) => {
      if (sessionKey() !== openedSession || (!cleanup && !current(requestGeneration))) {
        sessionChanged()
        throw Object.assign(new Error('已取消'), { code: 'ERR_CANCELED' })
      }
      if (openedSession)
        headers['x-admin-token'] = openedSession
      if (body === undefined)
        return body
      headers['Content-Type'] = 'application/json'
      return JSON.stringify(body)
    }],
  }
}
function requirePanelSession(response: { status?: number }) {
  if (response.status === 401 || response.status === 403) {
    invalidateSession()
    message.value = '面板登录已失效，请重新登录后再扫码'
    return false
  }
  return true
}
function stopTimers() {
  clearTimeout(pollTimer)
  clearTimeout(expiryTimer)
}
async function cancelRemote(id: string) {
  const result = await api.post('/api/qq-login/cancel', { taskId: id }, options(undefined, 20000, true))
  if (result.data?.ok !== true || result.data.data?.cancelled !== true)
    throw new Error('cancel unconfirmed')
}
function current(g: number) {
  sessionChanged()
  return mounted && !sessionInvalidated && g === generation
}
function displayTask(data: any) {
  if (typeof data?.taskId !== 'string' || !data.taskId || typeof data.expiresAt !== 'number'
    || !Number.isFinite(data.expiresAt) || data.expiresAt <= Date.now() || data.expiresAt > Date.now() + 180000
    || typeof data.qrImage !== 'string' || data.qrImage.length > 2800000
    || !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(data.qrImage)
    || !['waiting_scan', 'scanned', 'confirmed', 'cancelled', 'expired', 'failed'].includes(data.status)) {
    throw new Error('invalid task')
  }
  if (taskId && taskId !== data.taskId)
    throw new Error('task changed')
  taskId = data.taskId
  deadline = deadline ? Math.min(deadline, data.expiresAt) : data.expiresAt
  state.value = data.status
  qrImage.value = ['waiting_scan', 'scanned'].includes(data.status) ? data.qrImage : ''
  message.value = ({ waiting_scan: '请使用 QQ 扫码', scanned: '已扫码，请在 QQ 中确认', confirmed: '扫码已确认，请点击获取农场登录码', cancelled: '扫码已取消', expired: '二维码已过期', failed: '扫码失败，请取消后重新开始' } as Record<string, string>)[data.status]!
  const g = generation
  clearTimeout(expiryTimer)
  expiryTimer = setTimeout(() => {
    if (current(g))
      void expire()
  }, Math.max(1, deadline - Date.now()))
}
async function expire() {
  await cancel('二维码已过期，停止查询')
}
function queuePoll(g: number) {
  if (current(g) && ['waiting_scan', 'scanned'].includes(state.value))
    pollTimer = setTimeout(() => { void poll(g) }, 2000)
}
async function poll(g: number) {
  if (!current(g))
    return
  if (Date.now() >= deadline) {
    await expire()
    return
  }
  controller = new AbortController()
  try {
    const result = await api.post('/api/qq-login/status', { taskId }, options(controller.signal))
    if (!current(g))
      return
    if (!requirePanelSession(result))
      return
    if (Date.now() >= deadline) {
      await expire()
      return
    }
    if (result.data?.ok !== true)
      throw new Error('status failed')
    displayTask(result.data.data)
    queuePoll(g)
  }
  catch {
    if (current(g)) {
      state.value = 'error'
      qrImage.value = ''
      message.value = '扫码状态查询失败，请取消任务后重新开始'
    }
  }
}
async function create() {
  if (!enabled.value || busy.value || state.value !== 'idle')
    return
  const g = ++generation
  deadline = 0
  codeRequested = false
  busy.value = true
  state.value = 'creating'
  message.value = '正在获取 QQ 二维码…'
  controller = new AbortController()
  try {
    const result = await api.post('/api/qq-login/create', {}, options(controller.signal))
    const id = result.data?.data?.taskId
    if (!current(g)) {
      if (typeof id === 'string' && id)
        await cancelRemote(id).catch(() => {})
      return
    }
    if (!requirePanelSession(result))
      return
    if (typeof id === 'string' && id)
      taskId = id
    if (result.data?.ok !== true)
      throw new Error('create failed')
    displayTask(result.data.data)
    queuePoll(g)
  }
  catch {
    if (current(g)) {
      state.value = 'unknown'
      message.value = '二维码创建结果未确认，请取消或等待服务器限时清理'
    }
  }
  finally {
    if (current(g))
      busy.value = false
  }
}
async function getCode() {
  if (state.value !== 'confirmed' || codeRequested || busy.value || !taskId)
    return
  if (Date.now() >= deadline) {
    await expire()
    return
  }
  const g = generation
  codeRequested = true
  busy.value = true
  stopTimers()
  message.value = '正在获取登录码并等待 QQ 注销确认…'
  // Absolute expiry still applies while the 90 second gateway request is in flight.
  expiryTimer = setTimeout(() => {
    if (current(g))
      void expire()
  }, Math.max(1, deadline - Date.now()))
  controller = new AbortController()
  try {
    const result = await api.post('/api/qq-login/code', { taskId }, options(controller.signal, 100000))
    if (!current(g))
      return
    if (!requirePanelSession(result))
      return
    const code = result.data?.data?.code
    if (Date.now() >= deadline || result.data?.ok !== true || typeof code !== 'string' || !code.trim() || code.length > 512)
      throw new Error('code unconfirmed')
    stopTimers()
    taskId = ''
    state.value = 'done'
    emit('ready', { code, nickname: typeof result.data.data.nickname === 'string' ? result.data.data.nickname : '' })
  }
  catch {
    if (current(g)) {
      state.value = 'unknown'
      message.value = '取码结果未确认，请勿重复取码，取消或等待服务器限时清理'
    }
  }
  finally {
    if (current(g))
      busy.value = false
  }
}
async function cancel(reason = '已取消 QQ 扫码') {
  const g = ++generation
  controller?.abort()
  stopTimers()
  qrImage.value = ''
  busy.value = true
  const id = taskId
  state.value = 'cancelling'
  try {
    if (!id)
      throw new Error('create pending')
    await cancelRemote(id)
    if (current(g)) {
      taskId = ''
      state.value = 'idle'
      message.value = reason
    }
  }
  catch {
    if (current(g)) {
      state.value = 'cancel_unknown'
      message.value = '取消尚未确认，请等待服务器限时清理后再进入'
    }
  }
  finally {
    if (current(g))
      busy.value = false
  }
}
onMounted(async () => {
  if (typeof window !== 'undefined')
    window.addEventListener('storage', sessionChanged)
  const g = generation
  controller = new AbortController()
  try {
    const result = await api.get('/api/qq-login/config', options(controller.signal))
    if (!current(g))
      return
    if (!requirePanelSession(result))
      return
    enabled.value = result.data?.ok === true && result.data.data?.enabled === true
    message.value = enabled.value ? '点击获取二维码开始 QQ 扫码；取码后仍需手动保存账号' : 'QQ 扫码未启用：需要管理员配置独立授权网关，也可使用手动填码'
  }
  catch {
    if (current(g))
      message.value = '无法读取 QQ 扫码配置，可使用手动填码'
  }
  finally {
    if (current(g))
      configured.value = true
  }
})
onUnmounted(() => {
  if (typeof window !== 'undefined')
    window.removeEventListener('storage', sessionChanged)
  mounted = false
  generation++
  controller?.abort()
  stopTimers()
  qrImage.value = ''
  if (taskId)
    void cancelRemote(taskId).catch(() => {})
})
</script>

<template>
  <div class="min-w-0 break-words space-y-4" :style="{ color: 'var(--theme-text)' }">
    <p role="status" aria-live="polite" class="text-sm">
      {{ message }}
    </p>
    <img v-if="qrImage" :src="qrImage" alt="QQ 登录二维码" class="mx-auto h-auto max-w-full w-56 rounded bg-white p-2">
    <div class="flex flex-wrap gap-2">
      <BaseButton class="min-h-11" :disabled="!configured || !enabled || busy || state !== 'idle'" :loading="busy && state === 'creating'" @click="create">
        获取QQ二维码
      </BaseButton>
      <BaseButton v-if="state === 'confirmed'" class="min-h-11" :disabled="busy || codeRequested" :loading="busy" @click="getCode">
        获取农场登录码
      </BaseButton>
      <BaseButton v-if="state !== 'idle' && state !== 'done'" class="min-h-11" variant="secondary" :disabled="state === 'cancelling' || state === 'cancel_unknown'" @click="cancel()">
        取消扫码
      </BaseButton>
    </div>
    <p class="text-xs opacity-70">
      登录码会填入手动表单，请检查账号信息并点击保存。不会自动添加或连接账号。
    </p>
  </div>
</template>
