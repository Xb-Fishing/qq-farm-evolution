<script setup lang="ts">
import { storeToRefs } from 'pinia'
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import BearActivityPanel from '@/components/activity/BearActivityPanel.vue'
import ClaimAllPanel from '@/components/activity/ClaimAllPanel.vue'
import SeasonRuleActivityPanel from '@/components/activity/SeasonRuleActivityPanel.vue'
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
const { wishActivity, wishLoading, wishError } = storeToRefs(activityStore)
const { happyShareActivity, happyShareLoading, happyShareError } = storeToRefs(activityStore)
const { seasonWishOperating } = storeToRefs(activityStore)
const { claimAllRunning, claimAllStep, claimAllResults } = storeToRefs(activityStore)
const { evolve } = storeToRefs(evolutionStore)

const showActivityAnalysis = ref(false)

async function refreshAll() {
  if (currentAccountId.value) {
    await Promise.all([
      activityStore.fetchBearActivity(String(currentAccountId.value)),
      activityStore.fetchWishActivity(String(currentAccountId.value)),
      activityStore.fetchHappyShareActivity(String(currentAccountId.value)),
    ])
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

async function refreshWish() {
  if (!currentAccountId.value)
    return
  const result = await activityStore.fetchWishActivity(String(currentAccountId.value))
  result?.ok ? toast.success('秋祈良愿只读状态已刷新') : toast.error(result?.error || '秋祈良愿刷新失败')
}

async function refreshHappyShare() {
  if (!currentAccountId.value)
    return
  const result = await activityStore.fetchHappyShareActivity(String(currentAccountId.value))
  result?.ok ? toast.success('快乐不独享只读状态已刷新') : toast.error(result?.error || '快乐不独享刷新失败')
}

// 秋祈良愿 / 快乐不独享手动操作：成功后刷新对应只读状态
async function operateSeasonWish(action: string, input: Record<string, unknown> = {}) {
  if (!currentAccountId.value || seasonWishOperating.value)
    return
  const result = await activityStore.operateSeasonWish(String(currentAccountId.value), action, input)
  if (result?.ok) {
    const rewardText = result.rewards?.length
      ? `，获得 ${result.rewards.map((r: { itemName: string, itemCount: number }) => `${r.itemName}×${r.itemCount}`).join('、')}`
      : (result.grantedScore ? `，快乐值 +${result.grantedScore}` : '')
    toast.success(`操作成功${rewardText}`)
    await Promise.all([refreshWish(), refreshHappyShare()])
  }
  else {
    toast.error(result?.error || '操作失败')
  }
}

// 一键领取：编排层只在 store 内复用已证实手动写入口；部分失败不提示全成功
let activityViewAlive = true
async function claimAll() {
  if (!currentAccountId.value || claimAllRunning.value || seasonWishOperating.value || bearOperating.value)
    return
  const runAccount = String(currentAccountId.value)
  const result = await activityStore.runClaimAll(runAccount)
  // 取消/切账号/卸载后的旧任务结果直接静默：不得在新账号页弹旧任务提示
  if (!activityViewAlive || currentAccountId.value !== runAccount || result?.error === '已取消')
    return
  if (!result?.ok)
    toast.error(String((result as any)?.summary || result?.error || '一键领取未完成'))
  else
    toast.success(String((result as any)?.summary || '一键领取完成'))
}

// 页面卸载：停止一键领取后续请求，旧响应不回填、不弹提示
onBeforeUnmount(() => {
  activityViewAlive = false
  activityStore.cancelClaimAll()
})

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
      <ClaimAllPanel
        :running="claimAllRunning" :disabled="!currentAccountId" :step="claimAllStep"
        :results="claimAllResults" :has-operating="!!seasonWishOperating || !!bearOperating"
        @claim="claimAll"
      />
      <BearActivityPanel v-model:operating="bearOperating" :activity="bearActivity" :loading="bearLoading" @refresh="refreshBear" @operate="operateBear" />
      <div v-if="wishError" class="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-600 dark:bg-red-900/20 dark:text-red-300">
        {{ wishError }}
      </div>
      <SeasonRuleActivityPanel
        :activity="wishActivity" :loading="wishLoading" kind="wish" :operating="seasonWishOperating"
        heading="秋祈良愿 · 每日祈愿"
        subtitle="每日祈愿领好运奖励 · 限定种子 / 烟花 / 盆栽 · 错过存储 5 日 · 邮件补发"
        @refresh="refreshWish" @operate="operateSeasonWish"
      />
      <div v-if="happyShareError" class="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-600 dark:bg-red-900/20 dark:text-red-300">
        {{ happyShareError }}
      </div>
      <SeasonRuleActivityPanel
        :activity="happyShareActivity" :loading="happyShareLoading" kind="happyShare" :operating="seasonWishOperating"
        heading="快乐不独享 · 快乐值"
        subtitle="每日领取 / 每日首次分享 / 好友快乐包链接 · 档位奖励（稚萌熊熊）"
        @refresh="refreshHappyShare" @operate="operateSeasonWish"
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
