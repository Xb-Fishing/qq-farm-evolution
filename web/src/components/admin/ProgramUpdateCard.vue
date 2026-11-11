<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import api from '@/api'
import BaseButton from '@/components/ui/BaseButton.vue'

interface UpdateState { phase: string, currentVersion: string | null, latestVersion: string | null, updateAvailable: boolean, message: string }
const props = withDefaults(defineProps<{ canUpdate?: boolean }>(), { canUpdate: false })
const allowed = ref(false)
const canUpdate = computed(() => props.canUpdate && allowed.value)
const refreshing = ref(false)
const update = ref<UpdateState | null>(null)
const pending = ref(false)
const error = ref('')
let timer: ReturnType<typeof setTimeout> | undefined
let disposed = false
let revision = 0
const labels: Record<string, string> = { idle: '尚未检查', current: '已是最新版本', available: '发现新版本', queued: '准备更新', fetching: '下载更新', dependencies: '准备更新', validating: '检查更新', overlay: '准备更新', preparing: '准备更新', applying: '正在应用，页面可能短暂重连', applied: '更新完成', failed: '更新未完成', interrupted: '准备已中断', unavailable: '当前部署方式不可更新' }
const busy = computed(() => !!update.value && ['queued', 'fetching', 'dependencies', 'validating', 'overlay', 'preparing', 'applying'].includes(update.value.phase))
function scheduleRefresh() {
  clearTimeout(timer)
  if (!disposed && busy.value)
    timer = setTimeout(refresh, 5000)
}
async function refresh() {
  if (disposed || refreshing.value)
    return
  clearTimeout(timer)
  refreshing.value = true
  const ticket = revision
  try {
    const { data } = await api.get('/api/admin/program-update')
    if (!disposed && ticket === revision && !pending.value) {
      update.value = data.update
      allowed.value = data.access?.canUpdate === true
      error.value = ''
    }
  }
  catch {
    if (!disposed && ticket === revision && !pending.value) {
      allowed.value = false
      if (!busy.value)
        error.value = '版本状态读取失败，请刷新重试'
    }
  }
  finally {
    refreshing.value = false
    scheduleRefresh()
  }
}
async function run(action: 'check' | 'install') {
  if (!canUpdate.value || pending.value || busy.value || update.value?.phase === 'unavailable')
    return
  pending.value = true
  const ticket = ++revision
  error.value = ''
  try {
    const { data } = await api.post(`/api/admin/program-update/${action}`, {}, { timeout: 120000 })
    if (!disposed && ticket === revision)
      update.value = data.update
  }
  catch (e: any) {
    if (!disposed && ticket === revision) {
      if (e.response?.status === 403)
        allowed.value = false
      error.value = e.response?.data?.error || '操作失败，请稍后重试'
    }
  }
  finally {
    pending.value = false
    revision++
    scheduleRefresh()
  }
}
onMounted(async () => {
  await refresh()
  if (!disposed && canUpdate.value && !busy.value && !update.value?.latestVersion && update.value?.phase !== 'unavailable')
    await run('check')
})
onUnmounted(() => {
  disposed = true
  revision++
  clearTimeout(timer)
})
</script>

<template>
  <section class="ui-card border rounded-2xl p-4 space-y-3" aria-label="程序更新">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h4 class="font-semibold">
          程序更新
        </h4>
        <p class="mt-1 text-sm opacity-75">
          查看当前版本，获取并安装可用更新。账号和设置会保留。
        </p>
      </div>
      <span class="rounded-full bg-gray-100 px-3 py-1 text-xs dark:bg-gray-800" role="status" aria-live="polite">{{ labels[update?.phase || 'idle'] || '正在检查' }}</span>
    </div>
    <div class="flex flex-wrap gap-x-6 gap-y-1 text-sm">
      <span>当前版本 <strong>{{ update?.currentVersion ? `v${update.currentVersion}` : '读取中' }}</strong></span>
      <span>最新版本 <strong>{{ update?.latestVersion ? `v${update.latestVersion}` : '待检查' }}</strong></span>
    </div>
    <p v-if="update?.message" class="text-sm">
      {{ update.message }}
    </p>
    <p v-if="!props.canUpdate || (update && !allowed)" class="text-sm opacity-80">
      需要管理员权限才能更新程序。
    </p>
    <p v-if="error" class="text-sm text-red-600" role="alert">
      {{ error }}
    </p>
    <div class="flex flex-wrap gap-2">
      <BaseButton variant="secondary" :loading="refreshing" @click="refresh">
        刷新状态
      </BaseButton>
      <BaseButton v-if="canUpdate" variant="secondary" :loading="pending" :disabled="busy || update?.phase === 'unavailable'" @click="run('check')">
        检查新版本
      </BaseButton>
      <BaseButton v-if="canUpdate && update?.updateAvailable" :disabled="pending || busy" @click="run('install')">
        更新到 {{ update.latestVersion ? `v${update.latestVersion}` : '最新版本' }}
      </BaseButton>
    </div>
    <p class="text-xs opacity-65">
      更新期间页面可能短暂重连，请等待完成。
    </p>
  </section>
</template>
