<script setup lang="ts">
import type { MilkTeaQueryKind } from '@/stores/activity'
import { storeToRefs } from 'pinia'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import GameUpdatePanel from '@/components/activity/GameUpdatePanel.vue'
import FestivalSignInPanel from '@/components/activity/FestivalSignInPanel.vue'
// 上一期 BearActivityPanel 已退役；只保留历史迁移定位，默认页面仅挂载当前奶茶面板。
import MilkTeaActivityPanel from '@/components/activity/MilkTeaActivityPanel.vue'
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
const { milkTeaActivity, milkTeaLoading, milkTeaError, milkTeaOperating, milkTeaQueries } = storeToRefs(activityStore)
const { claimAllRunning, claimAllStep, claimAllResults } = storeToRefs(activityStore)
const { activityRetired } = storeToRefs(activityStore)
const { evolve } = storeToRefs(evolutionStore)

const operationFeedback = ref<any>(null)
// 仅严格成功回复中明确列出的正数量奖励才作为“已确认奖励”展示；名称缺失/纯ID兜底未知物品。
const confirmedRewards = computed(() => {
  const feedback = operationFeedback.value
  if (feedback?.ok !== true || feedback.outcome === 'unknown' || !Array.isArray(feedback.rewards))
    return []
  return feedback.rewards.flatMap((item: any) => {
    const raw = item?.count
    const count = typeof raw === 'number' && Number.isSafeInteger(raw) && raw > 0
      ? String(raw)
      : typeof raw === 'string' && /^[1-9]\d*$/.test(raw) ? raw : ''
    if (!count)
      return []
    const name = typeof item?.name === 'string' ? item.name.trim() : ''
    return [{ name: name && !/^(?:未知物品|物品|未知种子|植物)?\s*\d+$/.test(name) ? name : '未知物品', count }]
  })
})
const showActivityAnalysis = ref(false)
const showActivityManagement = ref(false)

// 页面存活标记：卸载后旧回调（操作/一键/重新检查）不得弹提示或启动新刷新
let activityViewAlive = true

// 已结束活动从默认页面删除；手动恢复只在展开活动管理后提供，不自动探测。
const milkTeaRetired = computed(() => activityRetired.value.milkTea != null)
const RETIRED_LABELS = { milkTea: '奶茶热销中' } as const
const retiredKinds = computed(() => milkTeaRetired.value ? ['milkTea'] as const : [])
const hasVisibleActivity = computed(() => !milkTeaRetired.value)
let viewGeneration = 0
async function refreshAll() {
  if (currentAccountId.value)
    await activityStore.fetchMilkTeaActivity(String(currentAccountId.value))
}
function isSilentReadResult(result: any) {
  return result?.retired === true || result?.unavailable === true || result?.cancelled === true
}
async function refreshMilkTea() {
  const generation = viewGeneration
  const result = await activityStore.fetchMilkTeaActivity(String(currentAccountId.value || ''))
  if (!activityViewAlive || generation !== viewGeneration || isSilentReadResult(result))
    return
  result?.ok === true ? toast.success('奶茶状态已刷新') : toast.error(result?.error || '刷新失败')
}
async function queryMilkTea(kind: MilkTeaQueryKind, params: Record<string, unknown>) {
  const generation = viewGeneration
  const result = await activityStore.runMilkTeaQuery(kind, String(currentAccountId.value || ''), params)
  if (!activityViewAlive || generation !== viewGeneration || isSilentReadResult(result))
    return
  if (result?.ok !== true)
    toast.error(result?.error || '查询失败')
}
async function operateMilkTea(action: string, input: Record<string, unknown> = {}) {
  if (!currentAccountId.value || milkTeaOperating.value || claimAllRunning.value)
    return
  const generation = viewGeneration
  const runAccount = String(currentAccountId.value)
  const result = await activityStore.operateMilkTea(runAccount, action, input)
  if (!activityViewAlive || generation !== viewGeneration || isSilentReadResult(result))
    return
  operationFeedback.value = result
  if (result?.ok === true) {
    toast.success(result?.message || '操作完成，请核对最新状态')
    await refreshMilkTea()
  }
  else {
    toast.error(result?.message || result?.error || '操作未确认成功，请刷新核对')
  }
}

// 一键领取：编排层只在 store 内复用已证实手动写入口；部分失败不提示全成功
async function claimAll() {
  if (!currentAccountId.value || claimAllRunning.value || milkTeaOperating.value)
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

// 活动管理中的显式重新检查：只读所选活动一次；提示同样受页面存活 + 账号双守卫，
// 切账号往返（字符串恰好相等）也靠读取代次作废，不弹旧生命周期提示
async function recheck(kind: 'milkTea') {
  if (!currentAccountId.value)
    return
  const runAccount = String(currentAccountId.value)
  const result = await activityStore.recheckActivity(kind, runAccount)
  if (!activityViewAlive || currentAccountId.value !== runAccount || (result as any)?.cancelled)
    return
  if (result?.ok)
    toast.success('重新检查完成：活动仍在进行，已恢复展示')
  else if ((result as any)?.retired)
    toast.error('重新检查确认：活动已结束，保持下架')
  else
    toast.error(String((result as any)?.error || '重新检查失败，请稍后再试'))
}

// 页面卸载：停止一键领取后续请求，作废在飞读取（迟到响应不回填/不重建计时），旧响应不弹提示
onBeforeUnmount(() => {
  activityViewAlive = false
  ++viewGeneration
  activityStore.cancelClaimAll()
  activityStore.cancelActivityReads()
})

watch(currentAccountId, () => {
  ++viewGeneration
  operationFeedback.value = null
  showActivityManagement.value = false
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
// 进入页面先同步清扫已过期的落地快照（零请求，不展示过期缓存），再正常刷新
onMounted(() => {
  activityStore.sweepExpiredActivities()
  refreshAll()
})
</script>

<template>
  <section class="activity-page space-y-4">
    <header class="relative overflow-hidden rounded-xl from-slate-800 via-sky-800 to-indigo-900 bg-gradient-to-r shadow-sm">
      <div class="absolute h-64 w-64 rounded-full bg-sky-300/15 blur-3xl -right-12 -top-20" />
      <div class="relative flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
        <div class="min-w-0 flex items-center gap-3">
          <span class="grid h-12 w-12 shrink-0 place-items-center rounded-xl bg-white/10 text-3xl text-sky-100">
            <span class="i-carbon-events" />
          </span>
          <div>
            <h1 class="text-xl text-white font-bold">
              活动中心
            </h1>
            <div class="mt-1 text-xs text-sky-100/75">
              当前账号 {{ currentAccount?.name || '未选择' }} · 查看进行中的活动与奖励
            </div>
          </div>
        </div>
        <div class="min-w-0 flex flex-wrap items-center gap-2">
          <BaseButton variant="primary" :loading="milkTeaLoading" :disabled="!currentAccountId" @click="refreshAll">
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
      <nav class="activity-nav" aria-label="活动快速导航">
        <a v-if="!milkTeaRetired" href="#milk-shop">奶茶小店</a>
        <a href="#festival-sign-in">节日签到与节令日历</a>
      </nav>
      <div v-if="milkTeaError && !milkTeaRetired" class="act-alert act-alert-error" role="alert">
        {{ milkTeaError }}
      </div>
      <section v-if="hasVisibleActivity" class="act-card flex flex-col gap-3">
        <div class="flex flex-wrap items-start justify-between gap-3">
          <div class="min-w-0">
            <h2 class="text-sm text-gray-900 font-bold dark:text-white">
              一键领取
            </h2>
            <p class="mt-1 text-xs text-gray-500 leading-5 dark:text-gray-400">
              领取奶茶活动的每日快乐值、首次分享与合格档位奖励；每项领取前重新校验资格。
            </p>
          </div>
          <div class="act-actions">
            <BaseButton variant="primary" :loading="claimAllRunning" :disabled="claimAllRunning || !!milkTeaOperating" @click="claimAll">
              一键领取
            </BaseButton>
            <BaseButton v-if="claimAllRunning" variant="outline" @click="activityStore.cancelClaimAll()">
              停止后续领取
            </BaseButton>
          </div>
        </div>
        <p v-if="claimAllStep" role="status" class="act-note">
          <span class="i-svg-spinners-ring-resize animate-spin" aria-hidden="true" />{{ claimAllStep }}
        </p>
        <ul v-if="claimAllResults.length" class="act-rows">
          <li v-for="result in claimAllResults" :key="result.key">
            <span
              class="act-badge"
              :class="result.status === 'success' ? 'act-badge-success' : result.status === 'failed' ? 'act-badge-failed' : 'act-badge-skipped'"
            >{{ result.status === 'success' ? '成功' : result.status === 'failed' ? '失败' : '跳过' }}</span>
            <span class="min-w-0 flex-1 break-words">{{ result.label }} · {{ result.detail }}</span>
          </li>
        </ul>
      </section>
      <section
        v-if="operationFeedback && !milkTeaRetired"
        class="act-card flex flex-col gap-2"
        :class="operationFeedback.ok === true ? 'act-card-ok' : 'act-card-error'"
      >
        <p class="break-words text-sm text-gray-900 font-medium leading-6 dark:text-white">
          {{ operationFeedback.message || operationFeedback.error || '操作回复已返回，请核对最新状态' }}
        </p>
        <ul v-if="operationFeedback.results?.length" class="act-rows">
          <li v-for="(row, index) in operationFeedback.results || []" :key="index">
            槽位 {{ Number(row.slotIndex) + 1 }}：{{ row.success ? '已雇佣' : row.errorMsg || '未成功' }}
          </li>
        </ul>
        <div v-if="confirmedRewards.length" class="flex flex-col gap-1">
          <p class="text-xs text-gray-500 dark:text-gray-400">
            本次成功回复确认的奖励
          </p>
          <ul class="act-rows">
            <li v-for="(reward, index) in confirmedRewards" :key="`${reward.name}-${index}`">
              <span class="act-badge act-badge-success">已确认</span>
              <span class="min-w-0 flex-1 break-words">{{ reward.name }} × {{ reward.count }}</span>
            </li>
          </ul>
        </div>
      </section>
      <MilkTeaActivityPanel v-if="!milkTeaRetired" :key="String(currentAccountId)" :activity="milkTeaActivity" :loading="milkTeaLoading" :operating="milkTeaOperating || (claimAllRunning ? 'claimAll' : '')" :queries="milkTeaQueries" @refresh="refreshMilkTea" @query="queryMilkTea" @operate="operateMilkTea" />
      <GameUpdatePanel :key="`update-${currentAccountId}`" :account-id="String(currentAccountId || '')" />
      <FestivalSignInPanel :key="`festival-${currentAccountId}`" :account-id="String(currentAccountId)" />
      <p v-if="!hasVisibleActivity" class="rounded-lg bg-white p-8 text-center text-sm text-gray-500 dark:bg-gray-800">
        当前奶茶活动已结束；节日签到仍可在上方独立查询。
      </p>
      <div v-if="retiredKinds.length" class="text-sm text-gray-500 dark:text-gray-400">
        <button
          class="inline-flex items-center gap-1 rounded px-2 py-1 hover:bg-gray-100 dark:hover:bg-gray-800"
          :aria-expanded="showActivityManagement"
          aria-controls="activity-management"
          @click="showActivityManagement = !showActivityManagement"
        >
          活动管理 <span :class="showActivityManagement ? 'i-carbon-chevron-up' : 'i-carbon-chevron-down'" />
        </button>
        <div v-if="showActivityManagement" id="activity-management" class="mt-2 rounded-lg bg-gray-50 p-3 space-y-2 dark:bg-gray-800/60">
          <p class="text-xs">
            如活动再次开放，可手动检查并恢复显示。
          </p>
          <div v-for="kind in retiredKinds" :key="kind" class="flex flex-wrap items-center justify-between gap-2">
            <span>{{ RETIRED_LABELS[kind] }}</span>
            <BaseButton variant="secondary" @click="recheck(kind)">
              重新检查
            </BaseButton>
          </div>
        </div>
      </div>
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
        <div class="max-h-[92vh] max-w-7xl w-full flex flex-col overflow-hidden rounded-xl bg-white shadow-2xl dark:bg-gray-800">
          <header class="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-gray-200 px-4 py-3 dark:border-gray-700">
            <div>
              <h2 class="text-gray-900 font-semibold dark:text-white">
                活动分析
              </h2>
              <p class="mt-0.5 text-xs text-gray-500">
                在线发现未适配活动并读取只读活动树
              </p>
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

<style scoped>
.activity-page {
  min-width: 0;
}
.activity-nav {
  display: flex;
  flex-wrap: wrap;
  gap: 9px;
}
.activity-nav a {
  display: inline-flex;
  align-items: center;
  min-height: 42px;
  padding: 8px 12px;
  border: 1px solid var(--surface-border, #dbe3ec);
  border-radius: 9px;
  color: inherit;
  background: var(--surface-1, #fff);
  font-size: 13px;
}
.activity-page :deep(button) {
  min-height: 42px;
}
.activity-page .text-xs {
  overflow-wrap: anywhere;
}
.act-card {
  padding: 18px 22px;
  border: 1px solid var(--surface-border, rgba(15, 23, 42, 0.09));
  border-radius: 14px;
  background: var(--surface-1, #fff);
}
.act-actions {
  display: flex;
  align-items: center;
  gap: 9px;
  flex-wrap: wrap;
}
.act-actions :deep(button) {
  min-height: 42px;
}
.act-alert {
  padding: 13px 16px;
  border-radius: 10px;
  font-size: 13px;
  line-height: 1.8;
  overflow-wrap: anywhere;
}
.act-alert-error {
  background: color-mix(in srgb, #ef4444 9%, transparent);
  color: #b91c1c;
}
.act-note {
  display: flex;
  gap: 8px;
  align-items: center;
  font-size: 13px;
  line-height: 1.8;
  color: var(--muted-text, #64748b);
}
.act-rows {
  display: grid;
  gap: 8px;
  list-style: none;
  padding: 0;
  margin: 0;
}
.act-rows li {
  display: flex;
  align-items: baseline;
  gap: 9px;
  font-size: 12px;
  line-height: 1.8;
}
.act-badge {
  flex-shrink: 0;
  padding: 3px 8px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 600;
}
.act-badge-success {
  background: rgba(34, 197, 94, 0.1);
  color: #15803d;
}
.act-badge-failed {
  background: rgba(239, 68, 68, 0.1);
  color: #b91c1c;
}
.act-badge-skipped {
  background: var(--surface-2, #f8fafc);
  color: var(--muted-text, #64748b);
}
.dark .act-alert-error,
.dark .act-badge-failed {
  color: #fca5a5;
}
.dark .act-badge-success {
  color: #86efac;
}
@media (max-width: 700px) {
  .act-card {
    padding: 16px;
  }
  .act-card :deep(button) {
    min-height: 42px;
  }
  .act-actions {
    width: 100%;
  }
}
</style>
