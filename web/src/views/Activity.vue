<script setup lang="ts">
import { storeToRefs } from 'pinia'
import { onMounted, ref, watch } from 'vue'
import api from '@/api'
import WeatherActivityPanel from '@/components/activity/WeatherActivityPanel.vue'
import AdminActivityUpdatePanel from '@/components/admin/AdminActivityUpdatePanel.vue'
import BaseButton from '@/components/ui/BaseButton.vue'
import { useAccountStore } from '@/stores/account'
import { useActivityStore } from '@/stores/activity'
import { useToastStore } from '@/stores/toast'
import { useUserStore } from '@/stores/user'

const accountStore = useAccountStore()
const activityStore = useActivityStore()
const toast = useToastStore()
const userStore = useUserStore()
const { currentAccountId, currentAccount } = storeToRefs(accountStore)
const {
  weatherActivity,
  weatherLoading,
  weatherError,
} = storeToRefs(activityStore)

const showActivityAnalysis = ref(false)
type EvolutionAgent = 'claude' | 'codex'
const evolutionDefaultAgent = ref<EvolutionAgent>('claude')
const evolutionAgentLoading = ref(false)
const evolutionRunning = ref(false)
const evolutionNextRunAt = ref(0)
const evolutionIssueCount = ref(0)

async function refreshAll() {
  if (currentAccountId.value)
    await activityStore.fetchWeatherActivity(String(currentAccountId.value))
}

function syncEvolutionAgent(evolve: {
  defaultAgent?: EvolutionAgent
  agent?: EvolutionAgent
  status?: string
  nextAutoRunAt?: number
  pendingRuntimeIssueCount?: number
} | null | undefined) {
  evolutionDefaultAgent.value = (evolve?.defaultAgent || evolve?.agent) === 'codex' ? 'codex' : 'claude'
  evolutionRunning.value = evolve?.status === 'running'
  evolutionNextRunAt.value = Number(evolve?.nextAutoRunAt) || 0
  evolutionIssueCount.value = Number(evolve?.pendingRuntimeIssueCount) || 0
}

async function loadEvolutionAgent() {
  evolutionAgentLoading.value = true
  try {
    const { data } = await api.get('/api/activity/update/status')
    if (data.ok)
      syncEvolutionAgent(data.evolve)
  }
  catch { /* 活动分析面板会展示具体接口错误 */ }
  finally {
    evolutionAgentLoading.value = false
  }
}

async function saveEvolutionAgent(event: Event) {
  const agent = (event.target as HTMLSelectElement).value as EvolutionAgent
  evolutionAgentLoading.value = true
  try {
    const { data } = await api.post('/api/activity/update/agent', { agent })
    if (!data.ok)
      throw new Error(data.error || '保存默认执行器失败')
    syncEvolutionAgent(data.evolve)
    toast.success(`自动进化默认执行器已设为 ${agent === 'codex' ? 'Codex' : 'Claude'}`)
  }
  catch (error: any) {
    toast.error(error?.response?.data?.error || error.message || '保存默认执行器失败')
    await loadEvolutionAgent()
  }
  finally {
    evolutionAgentLoading.value = false
  }
}

async function refreshWeather() {
  if (!currentAccountId.value)
    return
  const result = await activityStore.fetchWeatherActivity(String(currentAccountId.value))
  result?.ok ? toast.success('雨落成诗只读状态已刷新') : toast.error(result?.error || '雨落成诗刷新失败')
}

watch(currentAccountId, () => {
  activityStore.clearActivityData()
  refreshAll()
})
watch(() => userStore.isAdmin, (isAdmin) => {
  if (isAdmin)
    void loadEvolutionAgent()
}, { immediate: true })
onMounted(refreshAll)
</script>

<template>
  <section class="space-y-4">
    <header class="relative min-h-36 overflow-hidden rounded-lg from-slate-800 via-sky-800 to-indigo-900 bg-gradient-to-r shadow-sm">
      <div class="absolute -right-12 -top-20 h-64 w-64 rounded-full bg-sky-300/15 blur-3xl" />
      <div class="relative flex min-h-40 flex-col justify-between gap-4 p-4 xl:flex-row xl:items-center">
        <div class="flex min-w-0 items-center gap-3">
          <span class="grid h-12 w-12 shrink-0 place-items-center rounded-xl bg-white/10 text-3xl text-sky-100">
            <span class="i-carbon-events" />
          </span>
          <div>
            <h1 class="text-xl text-white font-bold">活动中心</h1>
            <div class="mt-1 text-xs text-sky-100/75">
              当前账号 {{ currentAccount?.name || '未选择' }} · 当前活动按在线说明与只读证据展示
            </div>
          </div>
        </div>
        <div class="flex min-w-0 flex-wrap items-center gap-2 xl:max-w-[68%] xl:justify-end">
          <BaseButton variant="primary" :loading="weatherLoading" :disabled="!currentAccountId" @click="refreshAll">
            刷新
          </BaseButton>
          <label
            v-if="userStore.isAdmin"
            class="inline-flex items-center gap-2 rounded-lg border border-sky-200/25 bg-[#071b43]/75 px-3 py-1.5 text-xs text-sky-50 backdrop-blur-sm"
          >
            <span class="whitespace-nowrap">自动进化默认执行器</span>
            <select
              :value="evolutionDefaultAgent"
              class="rounded border border-sky-200/30 bg-[#102b56] px-2 py-1 text-xs text-white"
              :disabled="evolutionAgentLoading || evolutionRunning"
              @change="saveEvolutionAgent"
            >
              <option value="claude">Claude</option>
              <option value="codex">Codex</option>
            </select>
          </label>
          <span
            v-if="userStore.isAdmin"
            class="inline-flex items-center border border-sky-200/25 rounded-lg bg-[#071b43]/75 px-3 py-1.5 text-xs text-sky-50 backdrop-blur-sm"
          >
            下次自动：{{ evolutionNextRunAt ? new Date(evolutionNextRunAt).toLocaleString() : '待调度' }} · 待复盘 {{ evolutionIssueCount }} 类
          </span>
          <BaseButton v-if="userStore.isAdmin" variant="secondary" @click="showActivityAnalysis = true">
            <span class="i-carbon-analytics mr-1.5" />
            自动进化 / 活动分析
          </BaseButton>
        </div>
      </div>
    </header>

    <div v-if="!currentAccountId" class="rounded-lg bg-white p-10 text-center text-sm text-gray-500 shadow dark:bg-gray-800">
      请先选择账号，再查看活动数据。
    </div>
    <template v-else>
      <div v-if="weatherError" class="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-600 dark:bg-red-900/20 dark:text-red-300">
        {{ weatherError }}
      </div>
      <WeatherActivityPanel
        :activity="weatherActivity"
        :loading="weatherLoading"
        @refresh="refreshWeather"
      />
    </template>

    <Teleport to="body">
      <div
        v-if="showActivityAnalysis"
        class="fixed inset-0 z-60 flex items-center justify-center bg-black/55 p-3 sm:p-6"
        role="dialog"
        aria-modal="true"
        aria-label="活动分析"
        @click.self="showActivityAnalysis = false"
      >
        <div class="flex max-h-[92vh] w-full max-w-7xl flex-col overflow-hidden rounded-xl bg-white shadow-2xl dark:bg-gray-800">
          <header class="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-gray-200 px-4 py-3 dark:border-gray-700">
            <div>
              <h2 class="font-semibold text-gray-900 dark:text-white">活动分析</h2>
              <p class="mt-0.5 text-xs text-gray-500">在线发现未适配活动并读取只读活动树</p>
            </div>
            <div class="flex items-center gap-3">
              <label class="inline-flex items-center gap-2 text-xs text-gray-600 dark:text-gray-300">
                <span class="whitespace-nowrap font-medium">自动进化默认执行器</span>
                <select
                  :value="evolutionDefaultAgent"
                  class="rounded border border-gray-200 bg-white px-2 py-1.5 text-xs text-gray-800 dark:border-gray-600 dark:bg-gray-800 dark:text-white"
                  :disabled="evolutionAgentLoading || evolutionRunning"
                  @change="saveEvolutionAgent"
                >
                  <option value="claude">Claude</option>
                  <option value="codex">Codex</option>
                </select>
              </label>
              <button
                class="grid h-9 w-9 place-items-center rounded-lg text-gray-500 transition hover:bg-gray-100 dark:hover:bg-gray-700"
                aria-label="关闭活动分析"
                @click="showActivityAnalysis = false"
              >
                <span class="i-carbon-close text-xl" />
              </button>
            </div>
          </header>
          <div class="min-h-0 flex-1 overflow-y-auto p-4">
            <AdminActivityUpdatePanel />
          </div>
        </div>
      </div>
    </Teleport>
  </section>
</template>
