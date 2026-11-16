<!-- Historical retired-season view; never imported by the application. -->
<script setup lang="ts">
import type { MilkTeaQueryKind } from '@/stores/activity'
import { storeToRefs } from 'pinia'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import FriendRecallActivityPanel from '@/components/activity/FriendRecallActivityPanel.vue'
import GameUpdatePanel from '@/components/activity/GameUpdatePanel.vue'
import FestivalSignInPanel from '@/components/activity/FestivalSignInPanel.vue'
// 上一期 BearActivityPanel 已退役；只保留历史迁移定位，默认页面挂载当前奶茶面板与故友重逢规则。
import MilkTeaActivityPanel from '@/components/activity/MilkTeaActivityPanel.vue'
import BaseButton from '@/components/ui/BaseButton.vue'
import { useAccountStore } from '@/stores/account'
import { useActivityStore } from '@/stores/activity'
import { useFriendRecallStore } from '@/stores/friend-recall'
import { useToastStore } from '@/stores/toast'

const accountStore = useAccountStore()
const activityStore = useActivityStore()
const friendRecallStore = useFriendRecallStore()
const toast = useToastStore()
const { currentAccountId, currentAccount } = storeToRefs(accountStore)
const { milkTeaActivity, milkTeaLoading, milkTeaError, milkTeaOperating, milkTeaQueries } = storeToRefs(activityStore)
const { claimAllRunning, claimAllStep, claimAllResults } = storeToRefs(activityStore)
const { activityRetired } = storeToRefs(activityStore)

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
  if (currentAccountId.value) {
    const id = String(currentAccountId.value)
    await Promise.allSettled([activityStore.fetchMilkTeaActivity(id), friendRecallStore.refresh(id)])
  }
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
  friendRecallStore.cancel()
  activityStore.cancelClaimAll()
  activityStore.cancelActivityReads()
})

watch(currentAccountId, () => {
  ++viewGeneration
  operationFeedback.value = null
  showActivityManagement.value = false
  friendRecallStore.bind(String(currentAccountId.value || ''))
  activityStore.clearActivityData()
  refreshAll()
}, { flush: 'sync' })
// 进入页面先同步清扫已过期的落地快照（零请求，不展示过期缓存），再正常刷新
onMounted(() => {
  friendRecallStore.bind(String(currentAccountId.value || ''))
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

        </div>
      </div>
    </header>

    <div v-if="!currentAccountId" class="rounded-lg bg-white p-10 text-center text-sm text-gray-500 shadow dark:bg-gray-800">
      请先选择账号，再查看活动数据。
    </div>
    <template v-else>
      <nav class="activity-nav" aria-label="活动快速导航">
        <a v-if="!milkTeaRetired" href="#milk-shop">奶茶小店</a>
        <a v-if="friendRecallStore.activity?.available" href="#friend-recall">故友重逢</a>
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
      <FriendRecallActivityPanel :activity="friendRecallStore.activity" :loading="friendRecallStore.loading" :error="friendRecallStore.error" @refresh="friendRecallStore.refresh(String(currentAccountId))" />
      <GameUpdatePanel :key="`update-${currentAccountId}`" :account-id="String(currentAccountId || '')" />
      <FestivalSignInPanel :key="`festival-${currentAccountId}`" :account-id="String(currentAccountId)" />
      <p v-if="!hasVisibleActivity && !friendRecallStore.activity?.available" class="rounded-lg bg-white p-8 text-center text-sm text-gray-500 dark:bg-gray-800">
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

<retired-worker lang="js">
// Historical API fixture, evaluated only in an isolated injected VM.
const FRIEND_PANEL_ENTRY_METHODS = new Set([
    'getFriends',
    'fetchFriendsDogInfo',
    'syncFriendsFromGids',
]);

// 背包面板入口的就绪闸门（2026-10-04 启动窗口 500 收口）：getBag/getBagSeeds
// 用同一组就绪条件，但单独成集合——上方集合与 isFriendSync 三入口绑定不得扩散。
// 未就绪照发时，协议加载窗口内 types.BagRequest 尚未原地发布（proto.js 启动
// 竞态语义），getBag() 以无关键字的 TypeError 失败并污染面板背包 60s 失败冷却
// （warehouse.panelBagRetryAfter），路由侧又按未知错误回 HTTP 500。未就绪就地
// 返回下方固定本地拒绝：零上游请求、零 Bag 编码、不等待登录、不重试、
// 不设置好友同步暂停；就绪后读取立即可用（拒绝不写失败冷却）。
const BAG_PANEL_ENTRY_METHODS = new Set([
    'getBag',
    'getBagSeeds',
]);

// 萌宠手动操作的业务错误元数据（2026-09-20 跨 Worker 丢失修复）：
// pet-diary-operate 抛出的业务拒绝带 business 标记 + 固定 code，旧管理通道
// 只回传 error 字符串导致下游一律按 502 服务故障处理。此处只收集严格布尔
// 标记与限定格式的固定业务码（PET_DIARY_/WISH_SIGN_/HAPPY_SHARE_/SEASON_WISH_
// 前缀，2026-09-24 扩展季节活动手动操作），不序列化整个 Error、堆栈、
// cause 或任意附加属性，也不扩大到其他业务错误。
const PET_DIARY_ERROR_CODE_RE = /^(?:PET_DIARY|WISH_SIGN|HAPPY_SHARE|SEASON_WISH|FESTIVAL)_[A-Z0-9_]{1,48}$/;

function collectPetDiaryErrorMeta(err) {
    if (!err || err.business !== true) return null;
    const code = err.code;
    if (typeof code !== 'string' || !PET_DIARY_ERROR_CODE_RE.test(code)) return null;
    return { business: true, code, ...(['list', 'group', 'precondition', 'write'].includes(err.milkTeaStage) ? { stage: err.milkTeaStage } : {}) };
}

/**
 * 只读探测：好友摘要字段在线漂移验证（2026-09-22）。
 * 拉两次 force-refresh 摘要（间隔 gapMs，默认 15s），逐好友 diff
 * gold/level/tags/plant 子字段，返回漂移明细 + 完整前后快照（脱敏 gid）。
 * 目的：验证「好友在线期间摘要字段会变」是否成立，为在线检测选字段。
 */
async function probeFriendSummaryDrift(gapMs = 15_000) {
    const gap = Math.max(5_000, Math.min(60_000, Number(gapMs) || 15_000));
    const snapshotFields = (friend) => ({
        level: Number(friend && friend.level) || 0,
        gold: Number(friend && friend.gold) || 0,
        tags: friend && friend.tags ? JSON.stringify(friend.tags) : '',
        plant: friend && friend.plant ? {
            stealPlantNum: Number(friend.plant.stealPlantNum ?? friend.plant.steal_plant_num) || 0,
            dryNum: Number(friend.plant.dryNum ?? friend.plant.dry_num) || 0,
            weedNum: Number(friend.plant.weedNum ?? friend.plant.weed_num) || 0,
            insectNum: Number(friend.plant.insectNum ?? friend.plant.insect_num) || 0,
            ripeTimeSec: Number(friend.plant.ripeTimeSec ?? friend.plant.ripe_time_sec) || 0,
        } : null,
    });
    const before = await getFriendsList(true);
    const beforeMap = new Map((before.friends || before || []).map(f => [Number(f.gid), f]));
    await new Promise(resolve => setTimeout(resolve, gap));
    const after = await getFriendsList(true);
    const afterMap = new Map((after.friends || after || []).map(f => [Number(f.gid), f]));

    const drifts = [];
    for (const [gid, friend] of afterMap) {
        const prev = beforeMap.get(gid);
        if (!prev) continue;
        const a = snapshotFields(prev);
        const b = snapshotFields(friend);
        const changed = [];
        if (a.level !== b.level) changed.push(`level ${a.level}→${b.level}`);
        if (a.gold !== b.gold) changed.push(`gold ${a.gold}→${b.gold}`);
        if (a.tags !== b.tags) changed.push('tags');
        if (JSON.stringify(a.plant) !== JSON.stringify(b.plant)) {
            if (a.plant && b.plant) {
                for (const key of Object.keys(a.plant)) {
                    if (a.plant[key] !== b.plant[key]) changed.push(`${key} ${a.plant[key]}→${b.plant[key]}`);
                }
            } else changed.push('plant presence');
        }
        if (changed.length > 0) {
            drifts.push({ name: friend.name || friend.remark || '', changed });
        }
    }
    log('系统', `摘要漂移探测完成：${drifts.length}/${afterMap.size} 位好友字段变化（间隔 ${Math.round(gap / 1000)}s）`,
        {
            module: 'system', event: 'summary_drift_probe', result: 'ok',
            gapMs: gap,
            friends: afterMap.size,
            drifted: drifts.length,
            driftDetail: drifts.map(item => `${item.name}: ${item.changed.join(', ')}`).join(' | ').slice(0, 500),
        });
    return {
        gapMs: gap,
        friendsBefore: beforeMap.size,
        friendsAfter: afterMap.size,
        driftedFriends: drifts.length,
        drifts,
        note: 'drifts>0 说明摘要字段在窗口内变化；结合巡田/趋势触发日志可判断是否与在线活动相关',
    };
}

async function handleApiCall(msg) {
    const { id, method, args } = msg;
    let result = null;
    let error = null;
    let errorMeta = null;

    if (FRIEND_PANEL_ENTRY_METHODS.has(method) || BAG_PANEL_ENTRY_METHODS.has(method) || method === 'getOfficialAnnouncements'
        || method === 'getEmailSnapshot' || method === 'getGameUpdateEvidence') {
        const ws = getWs();
        if (!isRunning || !loginReady || !ws || ws.readyState !== 1) {
            sendToMaster({
                type: 'api_response',
                id,
                result: null,
                error: '账号未就绪（未登录或连接未打开），请稍后重试',
            });
            return;
        }
    }

    // 好友同步操作期间暂停自动化
    const isFriendSync = method === 'getFriends' && args[0] === true
        || method === 'fetchFriendsDogInfo'
        || method === 'syncFriendsFromGids';

    if (isFriendSync) {
        friendSyncPaused = true;
        log('系统', '好友同步操作开始，已暂停其他自动化进程', {
            module: 'system', event: '好友同步暂停', method
        });
    }

    try {
        switch (method) {
            case 'getDogReadPanel':
                result = await require('../services/game-panel-readonly').getDogReadPanel();
                break;
            case 'getCollectionReadPanel':
                result = await require('../services/game-panel-readonly').getCollectionReadPanel();
                break;
            case 'getLocalConnectionState': {
                const socket = getWs();
                const state = socket?.readyState === 1 ? 'online'
                    : socket?.readyState === 3 || (!socket && isRunning === false && loginReady === false) ? 'offline' : 'unknown';
                result = { state, connected: state === 'online' ? true : state === 'offline' ? false : undefined,
                    businessReady: state === 'online' && isRunning === true && loginReady === true };
                break;
            }
            case 'getLands':
                result = await require('../services/farm-land-analyzer').getLandsDetailForPanel();
                break;
            case 'getFriends':
                result = await getFriendsList(args[0] === true);
                break;
            case 'probeFriendSummaryDrift':
                // 只读探测（2026-09-22 在线信号验证）：间隔取两次全量好友摘要并
                // diff 字段（gold/level/tags/plant 微态），输出哪些字段在好友
                // 在线期间发生漂移。两次调用走既有 getAllFriends 通道与治理预算。
                result = await probeFriendSummaryDrift(args[0]);
                break;
            case 'clearFriendsCache':
                require('../services/friend').clearFriendsListCache();
                result = { ok: true };
                break;
            case 'getInteractRecords':
                result = await getInteractRecords();
                break;
            case 'getFriendLands':
                result = await getFriendLandsDetail(args[0]);
                armStealWake();
                break;
            case 'doFriendOp':
                result = await doFriendOperation(args[0], args[1]);
                armStealWake();
                break;
            case 'getFriendDogInfo':
                result = await getFriendDogInfo(args[0]);
                armStealWake();
                break;
            case 'batchGetFriendDogInfo':
                result = await batchGetFriendDogInfo(args[0]);
                armStealWake();
                break;
            case 'syncFriendsFromGids':
                result = await syncFriendsFromGids(args[0]);
                break;
            case 'fetchFriendsDogInfo':
                result = await fetchFriendsDogInfo();
                break;
            case 'delFriend':
                result = await delFriend(args[0]);
                break;
            case 'getSeeds':
                result = await getAvailableSeeds();
                break;
            case 'getBag':
                result = await require('../services/warehouse').getBagDetail();
                break;
            case 'getBagSeeds':
                result = await require('../services/warehouse').getBagSeedsForPanel();
                break;
            case 'getDailyEvents':
                result = require('../services/daily-events').getTodayEvents(
                    process.env.FARM_ACCOUNT_ID || '');
                break;
            case 'clearBreaker': {
                const cleared = require('../services/request-governor').clearBreaker();
                if (cleared) {
                    resetUnifiedSchedule();
                    armOwnHarvestGuard();
                    armStealWake();
                    scheduleUnifiedNextTick();
                    log('系统', '异常降速已手动取消，恢复正常巡查', {
                        module: 'system', event: '降速取消', result: 'ok'
                    });
                    require('../services/daily-events').recordEvent(
                        process.env.FARM_ACCOUNT_ID || '', 'info', 'slowdown', '异常降速已手动取消');
                }
                result = { cleared };
                break;
            }
            case 'getDogSkillGiftStatus': {
                const dogGifts = require('../services/dog-skill-gifts');
                result = { pendingCount: dogGifts.getPendingGiftCount(await dogGifts.getDogInfoForPanel()) };
                break;
            }
            case 'claimDogSkillGifts':
                result = await require('../services/dog-skill-gifts').checkAndClaimDogSkillGifts();
                require('../services/dog-skill-gifts').invalidatePanelDogInfoCache();
                break;
            case 'useItem': {
                const { useItem } = require('../services/warehouse');
                const itemId = Number(args[0]) || 0;
                const count = args[1] ?? 1;
                const uid = args[2] ?? 0;
                result = await useItem(itemId, count, uid);
                break;
            }
            case 'sellItems': {
                // 面板手动出售（对象载荷）走唯一写守护；旧数组载荷保持原行为
                // （自动出售链路不经此 case）。
                if (args[0] && !Array.isArray(args[0]) && typeof args[0] === 'object') {
                    const { guardedBagSale } = require('../services/manual-commerce');
                    result = await guardedBagSale(args[0]);
                } else {
                    const { sellItems } = require('../services/warehouse');
                    const items = Array.isArray(args[0]) ? args[0] : [];
                    const totalCount = items.reduce((sum, it) => sum + (Number(it.count) || 0), 0);
                    result = await sellItems(items.map(it => ({
                        id: it.id, count: it.count, uid: it.uid || 0
                    })));
                    if (totalCount > 0) recordOperation('sell', totalCount);
                }
                break;
            }
            case 'setAutomation': {
                const item = args && args[0] ? args[0] : {};
                const patch = { [item.key]: item.value };
                applyRuntimeConfig({ automation: patch }, true);
                result = getAutomation();
                break;
            }
            case 'doFarmOp':
                result = await runFarmOperation(args[0]);
                // 面板触发的农场操作（收获/浇水/除草等）同时变更土地与背包
                require('../services/farm-land-analyzer').invalidatePanelLandsCache();
                require('../services/warehouse').invalidatePanelBagCache();
                break;
            case 'buyFertilizer': {
                const fertType = args[0] || 'organic';
                const count = Number(args[1]) || 1;
                result = await autoBuyFertilizer(true, fertType, count);
                require('../services/warehouse').invalidatePanelBagCache();
                break;
            }
            case 'checkAndBuyFertilizer': {
                const opts = args[0] || {};
                result = await checkAndBuyFertilizerBoth(opts);
                require('../services/warehouse').invalidatePanelBagCache();
                break;
            }
            case 'getAnalytics': {
                const { getPlantRankings } = require('../services/analytics');
                result = getPlantRankings(args[0]);
                break;
            }
            case 'getShopInfo': {
                const { getRegularShopForPanel } = require('../services/mall');
                result = await getRegularShopForPanel(args[0]);
                break;
            }
            case 'buyGoods': {
                // 面板手动购买（对象载荷 {shopKind, goodsId, count, quoteFingerprint}）
                // 走唯一写守护；旧三元组载荷（图鉴购买等既有链路）保持原行为。
                if (args[0] && !Array.isArray(args[0]) && typeof args[0] === 'object') {
                    const { guardedShopPurchase } = require('../services/manual-commerce');
                    result = await guardedShopPurchase(args[0]);
                } else {
                    const { buyGoods } = require('../services/farm');
                    result = await buyGoods(args[0], args[1], args[2]);
                }
                break;
            }
            case 'getMallGoods': {
                const { getMallGoodsList } = require('../services/mall');
                result = await getMallGoodsList(0);
                break;
            }
            case 'getMallCatalog': {
                // 面板商城目录：60s 缓存 + 在途合并 + 失败冷却（写成功后失效）。
                const { getMallCatalogForPanel } = require('../services/mall');
                result = await getMallCatalogForPanel();
                break;
            }
            case 'getMonthCardPanel': {
                // 面板月卡只读视图：首次选月卡分区才读，60s 缓存 + 合并，不轮询。
                const { getMonthCardPanelInfos } = require('../services/monthcard');
                result = await getMonthCardPanelInfos();
                break;
            }
            case 'buyMallGoods': {
                // 面板手动购买（对象载荷 {goodsId, count, quoteFingerprint}）走
                // 唯一写守护；旧二元组载荷保持原直购行为。
                if (args[0] && !Array.isArray(args[0]) && typeof args[0] === 'object') {
                    const { guardedMallPurchase } = require('../services/manual-commerce');
                    result = await guardedMallPurchase(args[0]);
                } else {
                    const { purchaseMallGoods } = require('../services/mall');
                    result = await purchaseMallGoods(args[0], args[1]);
                }
                break;
            }
            case 'getMysteryShop': {
                // 面板读走 60s 缓存 + 在途合并（2026-10-03 收口）；自动购买
                // 链 checkAndAutoBuyMysteryShop 仍直调无缓存的 getActiveMysteryShop。
                const { getMysteryShopForPanel } = require('../services/mystery-shop');
                result = await getMysteryShopForPanel();
                break;
            }
            case 'buyMysteryShopGoods': {
                const { buyMysteryShopGoods } = require('../services/mystery-shop');
                result = await buyMysteryShopGoods(args[0]);
                break;
            }
            case 'abandonMysteryShop': {
                const { abandonMysteryShop } = require('../services/mystery-shop');
                result = await abandonMysteryShop();
                break;
            }
            case 'getActivityDiscoveryList': {
                const { getActivityDiscoveryList } = require('../services/activity');
                result = await getActivityDiscoveryList();
                break;
            }
            case 'getOfficialAnnouncements': {
                const { getOfficialAnnouncements } = require('../services/official-announcements');
                result = await getOfficialAnnouncements();
                break;
            }
            case 'getEmailSnapshot': {
                // 只读双箱快照：60s 缓存 + 在途合并，面板刷新不穿透腾讯；无领取动作。
                const { getEmailSnapshot } = require('../services/email');
                result = await getEmailSnapshot(args[0] || {});
                break;
            }
            case 'getGameUpdateEvidence': {
                // 一次有界更新证据采集：公告/邮件/节日/任务/图鉴/商城各一次，只读。
                const { collectGameUpdateEvidence } = require('../services/game-update-evidence');
                result = await collectGameUpdateEvidence(args[0] || {});
                break;
            }
            case 'getActivityGroupSnapshot': {
                const { getActivityGroupSnapshot } = require('../services/activity');
                result = await getActivityGroupSnapshot(args[0], args[1]);
                break;
            }
            case 'getMilkTeaActivity': {
                const { getMilkTeaActivity } = require('../services/milk-tea-activity');
                const { getBag, getBagItems } = require('../services/warehouse');
                // 活动段入口防护：未登录就绪/连接不在位一律在触达读取前拒绝（零上游）
                result = await getMilkTeaActivity({
                    includeGameplay: true,
                    deps: { getBag, getBagItems, isReady: () => loginReady && getWs()?.readyState === 1, getConnection: () => getWs() },
                });
                break;
            }
            case 'getSolarCalendar':
            case 'operateSolarCalendar': {
                const service = require('../services/solar-calendar');
                const deps = { isReady: () => loginReady && getWs()?.readyState === 1, getConnection: () => getWs() };
                result = method === 'getSolarCalendar' ? await service.getSolarCalendar(deps) : await service.operateSolarCalendar(args[0], args[1] || {}, deps);
                break;
            }
            case 'queryMilkTeaActivity': {
                const { queryMilkTeaActivity } = require('../services/milk-tea-activity');
                const { getBag, getBagItems } = require('../services/warehouse');
                result = await queryMilkTeaActivity(args[0], args[1] || {}, {
                    getBag, getBagItems,
                    isReady: () => loginReady && getWs()?.readyState === 1,
                    getConnection: () => getWs(),
                });
                break;
            }
            case 'operateMilkTea': {
                const { runManualMilkTeaAction } = require('../services/milk-tea-activity');
                const { getBag, getBagItems } = require('../services/warehouse');
                result = await runManualMilkTeaAction(args[0], args[1] || {}, {
                    getBag, getBagItems,
                    isReady: () => loginReady && getWs()?.readyState === 1,
                    getConnection: () => getWs(),
                });
                break;
            }
            // S3 萌宠 / 秋祈良愿 / 快乐不独享（getBearActivity/getWishActivity/
            // getHappyShareActivity/operatePetDiary/operateSeasonWish）已随 S4 轮换
            // 下架（2026-10-15 退役）：Worker case 与 provider 转发一并移除，
            // 旧公开服务入口在任何读取/发包前固定拒绝。
            case 'getIllustratedList': {
                const { getIllustratedListV2 } = require('../services/illustrated');
                result = await getIllustratedListV2(args[0], args[1]);
                break;
            }
            case 'claimIllustratedRewards': {
                const { claimAllRewardsV2 } = require('../services/illustrated');
                result = await claimAllRewardsV2(args[0]);
                break;
            }
            case 'getCareerInfo': {
                const { getCareerInfo } = require('../services/career');
                result = await getCareerInfo(args[0]);
                break;
            }
            case 'getDailyGiftOverview':
                result = await getDailyGiftOverview();
                break;
            case 'getSchedulers':
                result = getSchedulerRegistrySnapshot();
                break;
            case 'fertilizeLand': {
                const landId = Number(args[0]) || 0;
                if (!landId) {
                    error = '无效的土地ID';
                } else {
                    log('施肥', `正在对土地 ${  landId  } 使用有机肥料催熟`, {
                        module: 'farm', event: '催熟', landId
                    });
                    const fertilizeCount = await fertilize([landId], ORGANIC_FERTILIZER_ID);
                    if (fertilizeCount > 0) {
                        log('施肥', `土地 ${  landId  } 催熟成功`, {
                            module: 'farm', event: '催熟', result: 'ok', landId
                        });
                        result = { success: true, count: fertilizeCount };
                    } else {
                        log('施肥', `土地 ${  landId  } 催熟失败，可能有机肥料不足`, {
                            module: 'farm', event: '催熟', result: 'error', landId
                        });
                        result = { success: false, count: 0 };
                    }
                    // 面板催熟同时变更土地与背包化肥数量
                    require('../services/farm-land-analyzer').invalidatePanelLandsCache();
                    require('../services/warehouse').invalidatePanelBagCache();
                }
                break;
            }
            case 'removePlant': {
                const landId = Number(args[0]) || 0;
                if (!landId) {
                    error = '无效的土地ID';
                } else {
                    result = await removePlant([landId]);
                    require('../services/farm-land-analyzer').invalidatePanelLandsCache();
                }
                break;
            }
            case 'removeAllPlants': {
                const landsDetail = await getLandsDetail();
                const lands = landsDetail?.lands || [];
                const occupiedLands = lands
                    .filter(l => l && l.unlocked && l.status !== 'empty' && l.status !== 'locked')
                    .map(l => l.id);

                if (occupiedLands.length === 0) {
                    result = { removed: 0, message: '没有可铲除的作物' };
                } else {
                    await removePlant(occupiedLands);
                    log('铲除', `已铲除 ${  occupiedLands.length  } 块土地上的作物`, {
                        module: 'farm', event: '一键铲除', result: 'ok', count: occupiedLands.length
                    });
                    result = { removed: occupiedLands.length };
                }
                require('../services/farm-land-analyzer').invalidatePanelLandsCache();
                break;
            }
            default:
                error = 'Unknown method';
        }
    } catch (err) {
        error = err.message;
        // 业务码元数据优先；否则尝试严格预算拒绝元数据（governed/stage，
        // 2026-10-30 奶茶 502 定位修复），二者按白名单互斥、附加属性不回传。
        errorMeta = collectPetDiaryErrorMeta(err)
            || (['getMilkTeaActivity', 'queryMilkTeaActivity', 'operateMilkTea'].includes(method)
                ? require('../services/operation-error-meta').collectOperationErrorMeta(err) : null);
    }

    if (isFriendSync) {
        friendSyncPaused = false;
        log('系统', '好友同步操作完成，已恢复自动化进程', {
            module: 'system', event: '好友同步恢复', method
        });
    }

    sendToMaster({
        type: 'api_response',
        id,
        result,
        error,
        ...(errorMeta ? { errorMeta } : {})
    });
}


// ==================== 每日礼包总览
</retired-worker>

<retired-automation>
<script setup lang="ts">
import { computed, ref } from 'vue'
import MilkTeaAutomationSettings from '@/components/settings/MilkTeaAutomationSettings.vue'
import BaseButton from '@/components/ui/BaseButton.vue'
import BaseInput from '@/components/ui/BaseInput.vue'
import BaseSelect from '@/components/ui/BaseSelect.vue'
import BaseSwitch from '@/components/ui/BaseSwitch.vue'

interface AutomationSettings {
  automation: {
    farm: boolean
    harvest: boolean
    plant: boolean
    task: boolean
    milk_tea_auto_rewards: boolean
    milk_tea_auto_seeds?: boolean
    milk_tea_auto_work?: boolean
    milk_tea_auto_upgrade?: boolean
    milk_tea_work_interaction_type?: number
    milk_tea_seed_policy?: {
      targetSeedIds: number[]
      targetStock: number
      coinReserve: string
      coinDailyLimit: string
      ticketReserve: string
      ticketDailyLimit: string
    }
    sell: boolean
    friend: boolean
    farm_push: boolean
    land_upgrade: boolean
    friend_steal: boolean
    friend_help: boolean
    friend_bad: boolean
    friend_golden_bug: boolean
    friend_help_exp_limit: boolean
    golden_bug_clear: boolean
    fertilizer_gift: boolean
    fertilizer_buy_organic: boolean
    fertilizer_buy_normal: boolean
    mystery_shop_auto_buy: boolean
    mystery_shop_allow_gold: boolean
    mystery_shop_allow_coupon: boolean
    mystery_shop_allow_gold_bean: boolean
    fertilizer: string
    skip_own_weed_bug: boolean
    fertilizer_multi_season: boolean
    fertilizer_land_types: string[]
    fertilizer_smart_seconds: number
  }
  autoAcceptFriendMinLevel: number
  kickoutRelogin: {
    delayMinutes: number
    validUntil: string
  }
  fertilizerBuyOrganicCount: number
  fertilizerBuyOrganicThresholdHours: number
  fertilizerBuyNormalCount: number
  fertilizerBuyNormalThresholdHours: number
  fertilizerBuyCheckIntervalMinutes: number
  goldenBugKeepCount: number
  goldenBugRoundLimit: number
}

interface AutoCodeRefreshConfig {
  enabled: boolean
  intervalMinutes: number
}

withDefaults(defineProps<{
  currentAccountName: string | null
  currentAccountId: string | number | null | undefined
  loading: boolean
  saving: boolean
  autoCodeRefreshing: boolean
  fertilizerLandTypeOptions: { label: string, value: string }[]
  fertilizerOptions: { label: string, value: string | number }[]
  title?: string
  saveLabel?: string
  templateMode?: boolean
  showRunAutoCodeRefresh?: boolean
}>(), {
  title: '自动控制',
  saveLabel: '保存自动控制',
  showRunAutoCodeRefresh: true,
  templateMode: false,
})

const emit = defineEmits<{
  save: []
  runAutoCodeRefresh: []
}>()

const settings = defineModel<AutomationSettings>('settings', { required: true })
const autoCodeRefresh = defineModel<AutoCodeRefreshConfig>('autoCodeRefresh', { required: true })

function toLocalInputValue(d: Date) {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function addKickoutValidMinutes(minutes: number) {
  const current = settings.value.kickoutRelogin.validUntil
  const base = current && new Date(current).getTime() > Date.now()
    ? new Date(current).getTime()
    : Date.now()
  const next = new Date(base + minutes * 60 * 1000)
  next.setSeconds(0, 0)
  settings.value.kickoutRelogin.validUntil = toLocalInputValue(next)
}

const kickoutValidRemainText = computed(() => {
  const ts = Date.parse(settings.value.kickoutRelogin?.validUntil || '')
  if (!Number.isFinite(ts) || ts <= Date.now())
    return ''
  const min = Math.ceil((ts - Date.now()) / 60000)
  if (min < 60)
    return `${min} 分钟`
  return `${Math.round((min / 60) * 10) / 10} 小时`
})

function isFastMatureFertilizerMode(mode: string) {
  return mode === 'smart' || mode === 'smart_only' || mode === 'smart_normal'
}

const mysteryShopSettingsVisible = ref(false)
</script>

<template>
  <div class="space-y-4">
    <div class="flex items-center justify-between">
      <h3 class="text-lg text-gray-900 font-bold dark:text-gray-100">
        {{ title }}
        <span v-if="currentAccountName" class="ml-2 text-sm text-gray-500 font-normal dark:text-gray-400">
          ({{ currentAccountName }})
        </span>
      </h3>
    </div>

    <div v-if="loading" class="py-4 text-center text-gray-500">
      <div class="i-svg-spinners-ring-resize mx-auto mb-2 text-2xl" />
      <p>加载中...</p>
    </div>

    <div v-else-if="!currentAccountId" class="py-8 text-center text-gray-500">
      <div class="i-carbon-settings-adjust mx-auto mb-2 text-3xl text-gray-400" />
      <p>请先选择账号</p>
    </div>

    <div v-else class="space-y-4">
      <div class="grid grid-cols-2 gap-3 md:grid-cols-3">
        <BaseSwitch v-model="settings.automation.farm" label="农场巡查（浇水/除草/除虫）" />
        <BaseSwitch v-model="settings.automation.harvest" label="自动收菜" />
        <BaseSwitch v-model="settings.automation.plant" label="自动种菜" />
        <BaseSwitch v-model="settings.automation.task" label="自动做任务" />
        <BaseSwitch v-model="settings.automation.milk_tea_auto_rewards" label="奶茶自动领奖（满额收银、快乐值）" />
        <BaseSwitch v-model="settings.automation.sell" label="自动卖果实" />
        <BaseSwitch v-model="settings.automation.friend" label="自动好友互动" />
        <BaseSwitch v-model="settings.automation.farm_push" label="推送触发巡田" />
        <BaseSwitch v-model="settings.automation.land_upgrade" label="自动升级土地" />
        <BaseSwitch v-model="settings.automation.fertilizer_gift" label="自动填充化肥" />
        <BaseSwitch v-model="settings.automation.fertilizer_buy_organic" label="自动购买有机化肥" />
        <BaseSwitch v-model="settings.automation.fertilizer_buy_normal" label="自动购买无机化肥" />
        <div class="w-fit max-w-full inline-flex items-center gap-1.5">
          <BaseSwitch v-model="settings.automation.mystery_shop_auto_buy" label="自动购买神秘商人商品" />
          <button
            class="h-7 w-7 inline-grid shrink-0 place-items-center rounded-md text-gray-400 transition hover:bg-gray-100 hover:text-gray-700 dark:text-gray-500 dark:hover:bg-gray-700 dark:hover:text-gray-200"
            type="button"
            title="设置允许使用的货币"
            aria-label="设置神秘商人自动购买"
            @click="mysteryShopSettingsVisible = true"
          >
            <span class="i-carbon-settings text-base" />
          </button>
        </div>
        <BaseSwitch v-model="settings.automation.skip_own_weed_bug" label="不除自己草虫" />
        <BaseSwitch v-model="settings.automation.golden_bug_clear" label="自动清除黄金虫" />
      </div>

      <MilkTeaAutomationSettings v-model:automation="settings.automation" :account-id="currentAccountId" :template-mode="templateMode" />

      <Transition name="fade">
        <div v-if="mysteryShopSettingsVisible" class="fixed inset-0 z-50 grid place-items-center bg-gray-950/45 p-4 backdrop-blur-[2px]" @click.self="mysteryShopSettingsVisible = false">
          <div class="w-full max-w-lg overflow-hidden border border-gray-200 rounded-2xl bg-white shadow-2xl dark:border-gray-700 dark:bg-gray-800">
            <div class="flex items-start justify-between border-b border-gray-100 px-6 py-5 dark:border-gray-700">
              <div>
                <div class="flex items-center gap-2">
                  <span class="h-8 w-8 inline-grid place-items-center rounded-lg bg-amber-50 text-amber-600 dark:bg-amber-900/30 dark:text-amber-300">
                    <span class="i-carbon-store text-lg" />
                  </span>
                  <h3 class="text-lg text-gray-900 font-semibold dark:text-gray-100">神秘商人自动购买</h3>
                </div>
                <p class="mt-2 text-sm text-gray-500 dark:text-gray-400">选择自动购买时可以使用的货币。</p>
              </div>
              <button class="h-8 w-8 inline-grid shrink-0 place-items-center rounded-lg text-gray-400 transition hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-gray-700 dark:hover:text-gray-200" type="button" aria-label="关闭" @click="mysteryShopSettingsVisible = false">
                <span class="i-carbon-close text-xl" />
              </button>
            </div>
            <div class="space-y-2 px-6 py-5">
              <div class="flex items-center justify-between gap-4 border border-gray-200 rounded-xl px-4 py-3 dark:border-gray-700">
                <div class="flex min-w-0 items-center gap-3">
                  <span class="h-9 w-9 inline-grid shrink-0 place-items-center rounded-full bg-yellow-50 text-yellow-600 dark:bg-yellow-900/25 dark:text-yellow-300"><span class="i-carbon-currency-dollar text-lg" /></span>
                  <div><div class="text-sm text-gray-800 font-medium dark:text-gray-100">金币</div><div class="mt-0.5 text-xs text-gray-500 dark:text-gray-400">允许使用金币自动购买</div></div>
                </div>
                <BaseSwitch v-model="settings.automation.mystery_shop_allow_gold" />
              </div>
              <div class="flex items-center justify-between gap-4 border border-gray-200 rounded-xl px-4 py-3 dark:border-gray-700">
                <div class="flex min-w-0 items-center gap-3">
                  <span class="h-9 w-9 inline-grid shrink-0 place-items-center rounded-full bg-blue-50 text-blue-600 dark:bg-blue-900/25 dark:text-blue-300"><span class="i-carbon-ticket text-lg" /></span>
                  <div><div class="text-sm text-gray-800 font-medium dark:text-gray-100">点券</div><div class="mt-0.5 text-xs text-gray-500 dark:text-gray-400">允许使用点券自动购买</div></div>
                </div>
                <BaseSwitch v-model="settings.automation.mystery_shop_allow_coupon" />
              </div>
              <div class="flex items-center justify-between gap-4 border border-gray-200 rounded-xl px-4 py-3 dark:border-gray-700">
                <div class="flex min-w-0 items-center gap-3">
                  <span class="h-9 w-9 inline-grid shrink-0 place-items-center rounded-full bg-emerald-50 text-emerald-600 dark:bg-emerald-900/25 dark:text-emerald-300"><span class="i-carbon-crop-health text-lg" /></span>
                  <div><div class="text-sm text-gray-800 font-medium dark:text-gray-100">金豆豆</div><div class="mt-0.5 text-xs text-gray-500 dark:text-gray-400">允许使用金豆豆自动购买</div></div>
                </div>
                <BaseSwitch v-model="settings.automation.mystery_shop_allow_gold_bean" />
              </div>
            </div>
            <div class="flex justify-end border-t border-gray-100 bg-gray-50/70 px-6 py-4 dark:border-gray-700 dark:bg-gray-900/20">
              <BaseButton class="min-w-24" size="sm" @click="mysteryShopSettingsVisible = false">完成</BaseButton>
            </div>
          </div>
        </div>
      </Transition>

      <div class="border border-gray-200 rounded bg-gray-50/70 p-3 dark:border-gray-700 dark:bg-gray-900/20">
        <div class="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div class="min-w-0 space-y-2">
            <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
              <span class="inline-flex items-center gap-1.5 text-sm text-gray-900 font-medium dark:text-gray-100">
                <span class="i-carbon-renew text-base text-gray-500 dark:text-gray-400" />
                微信断线自动恢复
              </span>
              <BaseSwitch
                v-model="autoCodeRefresh.enabled"
                label="启用"
              />
            </div>
            <p class="text-xs text-gray-500 dark:text-gray-400">
              <span class="text-amber-700 font-semibold dark:text-amber-300">仅微信账号可用。</span>
              微信登录凭据会始终约 25-35 分钟滚动保活，在线时不会换 Code、不会重启。本开关只控制真实断线后的自动换 Code 与重登；QQ 账号会跳过。
            </p>
          </div>

          <div class="flex flex-col gap-2 sm:flex-row sm:items-end">
            <BaseInput
              v-model.number="autoCodeRefresh.intervalMinutes"
              class="sm:w-36"
              label="断线重试(分钟)"
              type="number"
              min="1"
              max="1440"
              placeholder="60"
            />
            <BaseButton
              v-if="showRunAutoCodeRefresh"
              variant="secondary"
              size="sm"
              class="h-9 whitespace-nowrap"
              :loading="autoCodeRefreshing"
              :disabled="saving"
              @click="emit('runAutoCodeRefresh')"
            >
              <span class="i-carbon-renew mr-1" />
              手动换 Code 重连
            </BaseButton>
          </div>
        </div>
      </div>

      <div class="border border-gray-200 rounded bg-gray-50/70 p-3 dark:border-gray-700 dark:bg-gray-900/20">
        <div class="space-y-2">
          <span class="inline-flex items-center gap-1.5 text-sm text-gray-900 font-medium dark:text-gray-100">
            <span class="i-carbon-user-access text-base text-gray-500 dark:text-gray-400" />
            被顶号后自定义重登延迟
          </span>
          <div class="flex flex-wrap items-end gap-4">
            <BaseInput
              v-model.number="settings.kickoutRelogin.delayMinutes"
              class="sm:w-40"
              label="重登延迟 (分钟)"
              type="number"
              min="0"
              max="4320"
              placeholder="0=默认规则"
            />
            <div class="flex flex-col gap-1">
              <label class="text-xs text-gray-500 dark:text-gray-400">设置有效期至（过期自动回退默认规则）</label>
              <input
                v-model="settings.kickoutRelogin.validUntil"
                type="datetime-local"
                class="w-44 border border-gray-200 rounded bg-white px-2 py-1 text-xs dark:border-gray-600 dark:bg-gray-800 dark:text-white"
              >
            </div>
            <button
              type="button"
              class="rounded bg-gray-100 px-3 py-1.5 text-xs text-gray-600 transition hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600"
              @click="addKickoutValidMinutes(360)"
            >
              +6小时
            </button>
            <button
              type="button"
              class="rounded bg-gray-100 px-3 py-1.5 text-xs text-gray-600 transition hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600"
              @click="addKickoutValidMinutes(1440)"
            >
              +24小时
            </button>
            <button
              type="button"
              class="rounded bg-gray-100 px-3 py-1.5 text-xs text-gray-600 transition hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600"
              @click="settings.kickoutRelogin.validUntil = ''"
            >
              不限期
            </button>
            <p v-if="kickoutValidRemainText" class="text-xs text-orange-500">
              设置剩余有效：{{ kickoutValidRemainText }}
            </p>
          </div>
          <p class="text-xs text-gray-500 dark:text-gray-400">
            留空或填 0 用默认递增退避：5分钟 → 30分钟 → 1小时 → 3小时，当日最多自动接管 5 次。
            设置了延迟且在有效期内时，被顶号后固定按该延迟重登；有效期过了自动回退默认规则。
          </p>
        </div>
      </div>

      <div v-if="settings.automation.fertilizer_buy_organic || settings.automation.fertilizer_buy_normal" class="rounded bg-green-50 p-3 text-sm space-y-3 dark:bg-green-900/20">
        <div v-if="settings.automation.fertilizer_buy_organic" class="space-y-2">
          <div class="text-green-700 font-medium dark:text-green-400">
            有机化肥设置
          </div>
          <div class="flex flex-wrap gap-4">
            <BaseInput
              v-model.number="settings.fertilizerBuyOrganicCount"
              label="购买数量"
              type="number"
              min="1"
              max="10000"
            />
            <BaseInput
              v-model.number="settings.fertilizerBuyOrganicThresholdHours"
              label="触发阈值 (小时)"
              type="number"
              min="1"
              max="990"
            />
          </div>
        </div>
        <div v-if="settings.automation.fertilizer_buy_normal" class="space-y-2">
          <div class="text-green-700 font-medium dark:text-green-400">
            无机化肥设置
          </div>
          <div class="flex flex-wrap gap-4">
            <BaseInput
              v-model.number="settings.fertilizerBuyNormalCount"
              label="购买数量"
              type="number"
              min="1"
              max="10000"
            />
            <BaseInput
              v-model.number="settings.fertilizerBuyNormalThresholdHours"
              label="触发阈值 (小时)"
              type="number"
              min="1"
              max="990"
            />
          </div>
        </div>
        <div class="flex flex-wrap gap-4">
          <BaseInput
            v-model.number="settings.fertilizerBuyCheckIntervalMinutes"
            label="检测间隔 (分钟)"
            type="number"
            min="1"
            max="1440"
          />
        </div>
        <p class="text-xs text-gray-500 dark:text-gray-400">
          系统会按照设定的检测间隔定时检测化肥容器剩余量，当低于触发阈值时自动购买。保存设置后会立即检测一次。同时开启两种化肥购买时，优先购买有机化肥。
        </p>
      </div>

      <div v-if="settings.automation.friend" class="flex flex-wrap gap-4 rounded bg-blue-50 p-3 text-sm dark:bg-blue-900/20">
        <BaseSwitch v-model="settings.automation.friend_steal" label="自动偷菜" />
        <BaseSwitch v-model="settings.automation.friend_help" label="自动帮忙" />
        <BaseSwitch v-model="settings.automation.friend_bad" label="自动捣乱" />
        <BaseSwitch v-model="settings.automation.friend_golden_bug" label="自动放黄金虫" />
        <BaseSwitch v-model="settings.automation.friend_help_exp_limit" label="经验满只帮护主犬" />
      </div>

      <div v-if="settings.automation.friend && settings.automation.friend_golden_bug" class="grid grid-cols-1 gap-3 rounded bg-amber-50 p-3 text-sm md:grid-cols-2 dark:bg-amber-900/20">
        <BaseInput
          v-model.number="settings.goldenBugKeepCount"
          label="黄金虫保留数量"
          type="number"
          min="0"
          max="9999"
        />
        <BaseInput
          v-model.number="settings.goldenBugRoundLimit"
          label="黄金虫单轮上限"
          type="number"
          min="1"
          max="100"
        />
      </div>

      <div v-if="settings.automation.friend" class="rounded bg-sky-50 p-3 text-sm dark:bg-sky-900/20">
        <div class="grid grid-cols-1 gap-3 md:grid-cols-2">
          <BaseInput
            v-model.number="settings.autoAcceptFriendMinLevel"
            label="自动通过好友最低等级"
            type="number"
            min="0"
            max="200"
          />
        </div>
        <p class="mt-2 text-xs text-gray-500 dark:text-gray-400">
          设为 `0` 表示不限制等级；启用好友相关自动化后，系统会按这里的最低等级自动通过好友申请。
        </p>
      </div>

      <div class="space-y-3">
        <div class="border border-amber-200 rounded bg-amber-50/60 p-3 dark:border-amber-800/60 dark:bg-amber-900/10">
          <div class="mb-2 text-sm text-amber-800 font-medium dark:text-amber-300">
            施肥范围
          </div>
          <div class="grid grid-cols-2 gap-2 md:grid-cols-4">
            <label
              v-for="option in fertilizerLandTypeOptions"
              :key="option.value"
              class="flex cursor-pointer items-center gap-1.5 rounded bg-white px-2 py-1 text-xs text-gray-700 dark:bg-gray-800 dark:text-gray-300"
            >
              <input
                v-model="settings.automation.fertilizer_land_types"
                :value="option.value"
                type="checkbox"
                class="h-3.5 w-3.5"
              >
              <span>{{ option.label }}</span>
            </label>
          </div>
          <p class="mt-2 text-xs text-gray-500 dark:text-gray-400">
            施肥前会优先按土地类型过滤，仅对命中范围的地块执行施肥策略。
          </p>
        </div>

        <div class="flex items-center gap-4">
          <BaseSelect
            v-model="settings.automation.fertilizer"
            label="施肥策略"
            :options="fertilizerOptions"
            class="flex-1"
          />
        </div>

        <div class="flex items-center gap-4">
          <BaseSwitch
            v-model="settings.automation.fertilizer_multi_season"
            label="多季补肥"
          />
        </div>

        <div v-if="isFastMatureFertilizerMode(settings.automation.fertilizer)" class="rounded bg-amber-50 p-3 text-sm dark:bg-amber-900/20">
          <div class="mb-2 text-sm text-gray-900 font-medium dark:text-gray-100">
            快成熟判定秒数
          </div>
          <div class="flex flex-wrap items-end gap-4">
            <BaseInput
              v-model.number="settings.automation.fertilizer_smart_seconds"
              label="秒数"
              type="number"
              min="30"
              max="3600"
              class="w-40"
            />
            <span class="pb-2 text-xs text-gray-500 dark:text-gray-400">
              距离成熟时间 ≤ 此秒数时施肥（默认300秒=5分钟）
            </span>
          </div>
        </div>
      </div>

      <div class="flex justify-end gap-2 border-t pt-3 dark:border-gray-700">
        <BaseButton
          variant="primary"
          size="sm"
          :loading="saving"
          @click="emit('save')"
        >
          {{ saveLabel }}
        </BaseButton>
      </div>
    </div>
  </div>
</template>

</retired-automation>
