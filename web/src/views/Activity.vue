<script setup lang="ts">
import { storeToRefs } from 'pinia'
import { onMounted, ref, watch } from 'vue'
import BearActivityPanel from '@/components/activity/BearActivityPanel.vue'
import AdminActivityUpdatePanel from '@/components/admin/AdminActivityUpdatePanel.vue'
import EvolutionAgentSettings from '@/components/admin/EvolutionAgentSettings.vue'
import BaseButton from '@/components/ui/BaseButton.vue'
import { useAccountStore } from '@/stores/account'
import { useActivityStore } from '@/stores/activity'
import { useEvolutionStore } from '@/stores/evolution'
import { useToastStore } from '@/stores/toast'
import { useUserStore } from '@/stores/user'

const accountStore = useAccountStore()
const activityStore = useActivityStore()
const evolutionStore = useEvolutionStore()
const toast = useToastStore()
const userStore = useUserStore()
const { currentAccountId, currentAccount } = storeToRefs(accountStore)
const { bearActivity, bearLoading, bearError, bearOperating } = storeToRefs(activityStore)
const { evolve } = storeToRefs(evolutionStore)

const showActivityAnalysis = ref(false)

async function refreshAll() {
  if (currentAccountId.value) {
    await activityStore.fetchBearActivity(String(currentAccountId.value))
  }
}

async function refreshBear() {
  if (!currentAccountId.value)
    return
  const result = await activityStore.fetchBearActivity(String(currentAccountId.value))
  result?.ok ? toast.success('S3 萌宠只读状态已刷新') : toast.error(result?.error || 'S3 萌宠刷新失败')
}

async function operateBear(action: string, input: Record<string, unknown> = {}) {
  if (!currentAccountId.value || bearOperating.value)
    return
  const result = await activityStore.operateBearPet(String(currentAccountId.value), action, input)
  if (result?.ok) {
    const rewardCount = result.rewards?.length || 0
    toast.success(`操作成功${rewardCount ? `，获得 ${rewardCount} 项奖励` : ''}`)
    await refreshBear()
  }
  else {
    toast.error(result?.error || '操作失败')
  }
}

watch(currentAccountId, () => {
  activityStore.clearActivityData()
  refreshAll()
})
watch(() => userStore.isAdmin, (isAdmin, _previous, onCleanup) => {
  if (isAdmin) {
    void evolutionStore.loadStatus().catch(() => {})
    evolutionStore.startPolling()
    onCleanup(() => evolutionStore.stopPolling())
  }
  else {
    showActivityAnalysis.value = false
  }
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
          <BaseButton variant="primary" :loading="bearLoading" :disabled="!currentAccountId" @click="refreshAll">
            刷新
          </BaseButton>
          <EvolutionAgentSettings v-if="userStore.isAdmin" dark />
          <span
            v-if="userStore.isAdmin"
            class="inline-flex items-center border border-sky-200/25 rounded-lg bg-[#071b43]/75 px-3 py-1.5 text-xs text-sky-50 backdrop-blur-sm"
          >
            下次自动：{{ evolve?.nextAutoRunAt ? new Date(evolve.nextAutoRunAt).toLocaleString() : '待调度' }} · 待复盘 {{ evolve?.pendingRuntimeIssueCount || 0 }} 类
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
      <div v-if="bearError" class="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-600 dark:bg-red-900/20 dark:text-red-300">
        {{ bearError }}
      </div>
      <BearActivityPanel v-model:operating="bearOperating" :activity="bearActivity" :loading="bearLoading" @refresh="refreshBear" @operate="operateBear" />
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
            <div class="min-w-0 flex items-center gap-3">
              <EvolutionAgentSettings />
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
