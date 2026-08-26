<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import api from '@/api'
import BaseButton from '@/components/ui/BaseButton.vue'
import { useToastStore } from '@/stores/toast'

interface ActivityUpdateReport {
  scannedAt: number
  appId: string
  status: 'unavailable' | 'update-found' | 'up-to-date'
  source: null | { version: string, modifiedAt: number, wasmSize: number }
  candidateCount: number
  incompleteCandidates: Array<{ version: string, missing: string[] }>
  detectedActivityIds: number[]
  unknownActivityIds: number[]
  caches: Array<{ cacheListModifiedAt: number, bundles: string[] }>
  warnings: string[]
  localScanEnabled?: boolean
  sourceChanged?: boolean
  previousSourceVersion?: string | null
  analysis?: {
    candidateGroups: Array<{ date: string, ids: number[] }>
    requiresProtocolSample: boolean
    safeToAutoApply: boolean
    summary: string
  }
  online?: {
    available: boolean
    accountName?: string
    scannedAt?: number
    error?: string
    activities: Array<{
      id: number
      title: string
      type?: number
      status?: number
      startTime?: number
      endTime?: number
      visible?: boolean
      enabled?: boolean
    }>
    groups: Array<{
      id: number
      parentId?: number
      title?: string
      type?: number
      status?: number
      startTime?: number
      endTime?: number
      visible?: boolean
      enabled?: boolean
      features?: ActivityFeatures
      children?: ActivityGroup[]
      payload?: Record<string, unknown> | null
      error?: string
    } & ActivityGroup>
    unknownActivityIds: number[]
    probes?: { attempted: number, matched: number, activityGroups?: number }
  } | null
  localEvidence?: {
    enabled: boolean
    unknownActivityIds: number[]
    detectedActivityIds: number[]
    source: null | { version: string, modifiedAt: number, wasmSize: number }
    caches: Array<{ cacheListModifiedAt: number, bundles: string[] }>
    warnings: string[]
  }
}

interface ActivityFeatures {
  randomShop?: boolean
  exchangeShop?: boolean
  draw?: boolean
  starRecord?: boolean
}

interface ActivityGroup {
  id: number
  parentId?: number
  title?: string
  type?: number
  status?: number
  startTime?: number
  endTime?: number
  visible?: boolean
  enabled?: boolean
  features?: ActivityFeatures
  children?: ActivityGroup[]
  payload?: Record<string, unknown> | null
  error?: string
}

interface EvolveState {
  status?: string
  summary?: string
  commit?: string
  lastRunAt?: number
  lastTask?: string
  lastSafetyEvolveDate?: string
  lastEvolveDate?: string
  userInstruction?: string
  nextAutoRunAt?: number
  pendingRuntimeIssueCount?: number
  pendingRuntimeIssueOccurrences?: number
}

const toast = useToastStore()
const loading = ref(false)
const report = ref<ActivityUpdateReport | null>(null)
const error = ref('')
const intervalMs = ref(0)
const nextScanAt = ref(0)
const evolve = ref<EvolveState | null>(null)
const evolving = ref(false)
const safetyRunning = ref(false)
const applying = ref(false)
const testingNotify = ref(false)
const instructionDraft = ref('')
const instructionSaving = ref(false)
const revisionRunning = ref(false)

const EVOLVE_STATUS_LABELS: Record<string, string> = {
  idle: '空闲',
  running: '执行中…',
  revising: '正在回退并重做…',
  pending_apply: '待确认应用',
  applying: '正在重启应用…',
  applied: '已应用',
  push_failed: 'GitHub 推送失败，禁止应用',
  failed: '执行失败',
  interrupted: '已中止，可重试',
  rejected: '已拒绝，等待重做',
  revision_failed: '拒绝/重做失败',
  deferred: '有人工改动，已延期',
  no_change: '无需改动',
}
const evolveStatusLabel = computed(() => EVOLVE_STATUS_LABELS[evolve.value?.status || ''] || '空闲')
const evolutionBlocked = computed(() => ['running', 'revising', 'pending_apply', 'applying', 'push_failed'].includes(evolve.value?.status || ''))

function syncEvolveState(value: EvolveState | null | undefined) {
  evolve.value = value || null
  instructionDraft.value = value?.userInstruction || ''
}

const discoveredGroups = computed(() => report.value?.online?.groups || [])

const statusLabel = computed(() => {
  if (!report.value)
    return '尚未扫描'
  if (report.value.status === 'update-found')
    return '发现候选更新'
  if (report.value.status === 'up-to-date')
    return '未发现未知活动'
  return '扫描环境不可用'
})

const statusClass = computed(() => {
  if (report.value?.status === 'update-found')
    return 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-200'
  if (report.value?.status === 'up-to-date')
    return 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-200'
  return 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300'
})

function formatTime(value?: number) {
  return value ? new Date(value).toLocaleString() : '—'
}

function activityStatus(group: ActivityGroup) {
  const now = Date.now() / 1000
  if (group.startTime && now < group.startTime)
    return '未开始'
  if (group.endTime && now > group.endTime)
    return '已结束'
  if (group.enabled === false)
    return '未启用'
  return '进行中'
}

function flattenGroup(group: ActivityGroup): ActivityGroup[] {
  return [group, ...(group.children || []).flatMap(flattenGroup)]
}

function featureSummary(group: ActivityGroup) {
  const nodes = flattenGroup(group)
  const exchange = nodes.filter(node => node.features?.exchangeShop).length
  const randomShop = nodes.filter(node => node.features?.randomShop).length
  const draw = nodes.filter(node => node.features?.draw).length
  const starRecord = nodes.filter(node => node.features?.starRecord).length
  return { nodes: nodes.length, exchange, randomShop, draw, starRecord }
}

function contentSummary(group: ActivityGroup) {
  const summary = featureSummary(group)
  const parts = [`节点 ${summary.nodes}`]
  if (summary.exchange)
    parts.push(`兑换 ${summary.exchange}`)
  if (summary.randomShop)
    parts.push(`刷新店 ${summary.randomShop}`)
  if (summary.draw)
    parts.push(`抽奖 ${summary.draw}`)
  if (summary.starRecord)
    parts.push(`图鉴 ${summary.starRecord}`)
  return parts.join(' · ')
}

function plainActivityText(value: unknown) {
  return String(value ?? '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .trim()
}

function activityRuleSections(group: ActivityGroup) {
  return flattenGroup(group).flatMap((node) => {
    const payload = node.payload as Record<string, unknown> | null | undefined
    const tipsValue = payload && typeof payload === 'object'
      ? payload.tips
      : null
    if (!tipsValue || typeof tipsValue !== 'object')
      return []
    const tips = tipsValue as Record<string, unknown>
    const lines = Array.isArray(tips.txt)
      ? tips.txt.map(plainActivityText).filter(Boolean)
      : []
    if (!lines.length)
      return []
    return [{
      id: node.id,
      title: plainActivityText(tips.title) || '活动说明',
      uid: plainActivityText(payload?.uid),
      lines,
    }]
  })
}

function activityNodeLabel(node: ActivityGroup) {
  if (!node.parentId || node.type === 1)
    return '主活动'
  if (node.type === 15)
    return '核心玩法节点'
  if (node.type === 16)
    return '赠礼关联节点'
  return `功能节点 · 类型 ${node.type || '未知'}`
}

function activityNodeDescription(node: ActivityGroup) {
  if (node.type === 15)
    return '包含 QiXiActivity 活动标识及完整玩法规则，是鹊羽获取、筑桥和奖励适配的主要入口。'
  if (node.type === 16)
    return '当前在线接口仅返回基础元数据；可能关联香囊赠礼或情谊记录，具体字段仍需活动开放后的协议样本确认。'
  return node.parentId ? '服务端活动树中的功能子节点。' : '活动组根节点，负责活动入口和起止时间。'
}

async function scanUpdates() {
  loading.value = true
  error.value = ''
  try {
    const { data } = await api.post('/api/activity/update/scan')
    if (!data.ok)
      throw new Error(data.error || '活动更新扫描失败')
    report.value = data.report
    intervalMs.value = Number(data.intervalMs) || intervalMs.value
    nextScanAt.value = Number(data.nextScanAt) || nextScanAt.value
    syncEvolveState(data.evolve)
    if (data.report?.status === 'update-found')
      toast.warning(`发现 ${data.report.unknownActivityIds.length} 个候选活动 ID`)
    else if (data.report?.status === 'unavailable')
      toast.warning(data.report?.online?.error || '活动扫描等待已连接的农场账号')
    else
      toast.success('活动更新扫描完成')
  }
  catch (err: any) {
    error.value = err?.response?.data?.error || err.message || '活动更新扫描失败'
  }
  finally {
    loading.value = false
  }
}

async function triggerEvolve() {
  evolving.value = true
  error.value = ''
  try {
    const { data } = await api.post('/api/activity/update/evolve?task=activity')
    if (!data.ok)
      throw new Error(data.error || '启动进化失败')
    syncEvolveState(data.evolve)
    if (data.started === false) {
      toast.warning(data.message || '当前无需启动活动进化')
      return
    }
    toast.success('已启动活动进化任务，完成后飞书通知')
  }
  catch (err: any) {
    error.value = err?.response?.data?.error || err.message || '启动进化失败'
  }
  finally {
    evolving.value = false
  }
}

async function triggerSafetyEvolve() {
  safetyRunning.value = true
  error.value = ''
  try {
    const { data } = await api.post('/api/activity/update/evolve?task=safety')
    if (!data.ok)
      throw new Error(data.error || '启动安全巡检失败')
    syncEvolveState(data.evolve)
    if (data.started === false) {
      toast.warning(data.message || '当前暂不能启动安全巡检')
      return
    }
    toast.success('已启动防封安全巡检，完成后飞书通知')
  }
  catch (err: any) {
    error.value = err?.response?.data?.error || err.message || '启动安全巡检失败'
  }
  finally {
    safetyRunning.value = false
  }
}

async function testNotify() {
  testingNotify.value = true
  try {
    const { data } = await api.post('/api/activity/update/notify-test')
    if (data.ok)
      toast.success('测试消息已发送到飞书')
    else
      throw new Error(data.error || '发送失败')
  }
  catch (err: any) {
    toast.warning(err?.response?.data?.error || err.message || '发送失败')
  }
  finally {
    testingNotify.value = false
  }
}

async function saveEvolutionInstruction() {
  instructionSaving.value = true
  error.value = ''
  try {
    const { data } = await api.post('/api/activity/update/instruction', {
      instruction: instructionDraft.value,
    })
    if (!data.ok)
      throw new Error(data.error || '保存修改要求失败')
    syncEvolveState(data.evolve)
    toast.success(instructionDraft.value ? '修改要求已保存，后续每轮 Claude/Codex 都会读取' : '已清空额外修改要求')
  }
  catch (err: any) {
    error.value = err?.response?.data?.error || err.message || '保存修改要求失败'
  }
  finally {
    instructionSaving.value = false
  }
}

async function reviseEvolution() {
  if (!instructionDraft.value.trim()) {
    toast.warning('请先写明哪里不满意，以及希望怎么改')
    return
  }
  revisionRunning.value = true
  error.value = ''
  try {
    const { data } = await api.post('/api/activity/update/revise', {
      instruction: instructionDraft.value,
    })
    if (!data.ok)
      throw new Error(data.error || '拒绝并重做失败')
    syncEvolveState(data.evolve)
    toast.success('已回退不满意的提交，并按你的要求重新启动进化')
  }
  catch (err: any) {
    error.value = err?.response?.data?.error || err.message || '拒绝并重做失败'
    await loadUpdateStatus()
  }
  finally {
    revisionRunning.value = false
  }
}

async function applyEvolve() {
  applying.value = true
  error.value = ''
  try {
    const { data } = await api.post('/api/activity/update/apply')
    if (!data.ok)
      throw new Error(data.error || '应用进化失败')
    syncEvolveState(data.evolve)
    toast.warning('正在重启应用进化，面板稍等片刻恢复')
  }
  catch (err: any) {
    error.value = err?.response?.data?.error || err.message || '应用进化失败'
  }
  finally {
    applying.value = false
  }
}

async function loadUpdateStatus() {
  loading.value = true
  error.value = ''
  try {
    const { data } = await api.get('/api/activity/update/status')
    if (!data.ok)
      throw new Error(data.error || '读取活动更新状态失败')
    report.value = data.report || null
    intervalMs.value = Number(data.intervalMs) || 0
    nextScanAt.value = Number(data.nextScanAt) || 0
    syncEvolveState(data.evolve)
  }
  catch (err: any) {
    error.value = err?.response?.data?.error || err.message || '读取活动更新状态失败'
  }
  finally {
    loading.value = false
  }
}

onMounted(loadUpdateStatus)
</script>

<template>
  <section class="space-y-4">
    <div class="flex flex-col gap-3 rounded-lg border border-gray-200 bg-gray-50 p-4 dark:border-gray-700 dark:bg-gray-900/40 sm:flex-row sm:items-center sm:justify-between">
      <div>
        <h3 class="font-semibold text-gray-900 dark:text-white">
          活动自动更新
        </h3>
        <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">
          服务端会定时读取在线 ActivityService.List，发现未知活动后再只读调用 GetGroup。不会执行活动操作。
        </p>
      </div>
      <BaseButton variant="primary" :loading="loading" @click="scanUpdates">
        <span class="i-carbon-search mr-2" />
        立即重新分析
      </BaseButton>
    </div>

    <div v-if="error" class="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700 dark:bg-red-900/20 dark:text-red-300">
      {{ error }}
    </div>

    <template v-if="report">
      <div class="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <div class="rounded-lg border border-gray-200 p-4 dark:border-gray-700">
          <div class="text-xs text-gray-500">扫描状态</div>
          <span class="mt-2 inline-flex rounded-full px-2.5 py-1 text-xs font-medium" :class="statusClass">{{ statusLabel }}</span>
        </div>
        <div class="rounded-lg border border-gray-200 p-4 dark:border-gray-700">
          <div class="text-xs text-gray-500">发现方式</div>
          <div class="mt-2 break-all text-sm font-medium text-gray-900 dark:text-white">在线 List + GetGroup</div>
        </div>
        <div class="rounded-lg border border-gray-200 p-4 dark:border-gray-700">
          <div class="text-xs text-gray-500">在线读取时间</div>
          <div class="mt-2 text-sm text-gray-900 dark:text-white">{{ formatTime(report.online?.scannedAt) }}</div>
          <div class="text-xs text-gray-500">{{ report.online?.accountName || '等待在线账号' }}</div>
        </div>
        <div class="rounded-lg border border-gray-200 p-4 dark:border-gray-700">
          <div class="text-xs text-gray-500">在线活动树</div>
          <div class="mt-2 text-sm font-medium text-gray-900 dark:text-white">{{ report.online?.activities.length || 0 }} 个服务端节点</div>
          <div class="text-xs text-gray-500">仅统计 ActivityService 在线响应</div>
        </div>
      </div>

      <div class="rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-800 dark:border-blue-800 dark:bg-blue-900/20 dark:text-blue-200">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <span>{{ report.analysis?.summary || '自动分析已完成' }}</span>
          <span class="text-xs opacity-75">
            每 {{ Math.round(intervalMs / 60000) || 30 }} 分钟自动分析 · 下次 {{ formatTime(nextScanAt) }}
          </span>
        </div>
      </div>
    </template>

    <div class="rounded-lg border border-purple-200 bg-purple-50 p-4 dark:border-purple-800 dark:bg-purple-900/20">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div class="min-w-0">
          <h4 class="text-sm font-semibold text-purple-900 dark:text-purple-200">
            自动进化（活动 + 防封安全巡检）
          </h4>
          <p class="mt-1 text-xs text-purple-700/90 dark:text-purple-300/90">
            每天北京时间 00:00-01:00 自动跑一版：安全巡检会同时复盘近 72 小时的脱敏运行问题，活动任务核对活动上下线。agent 改代码 → 全量测试 → git 提交（不重启），飞书通知后由你点「应用进化」生效。
          </p>
        </div>
        <button
          class="rounded bg-purple-100 px-3 py-1.5 text-xs text-purple-700 transition hover:bg-purple-200 dark:bg-purple-900/50 dark:text-purple-300"
          :loading="testingNotify"
          @click="testNotify"
        >
          发送测试通知
        </button>
      </div>
      <div class="grid mt-3 gap-2 sm:grid-cols-2">
        <div class="border border-purple-200 rounded bg-white/70 px-3 py-2 text-xs text-purple-800 dark:border-purple-700/50 dark:bg-gray-800/70 dark:text-purple-300">
          <div class="font-medium">
            下次自动进化
          </div>
          <div class="mt-1">
            {{ formatTime(evolve?.nextAutoRunAt) }}
          </div>
        </div>
        <div class="border border-purple-200 rounded bg-white/70 px-3 py-2 text-xs text-purple-800 dark:border-purple-700/50 dark:bg-gray-800/70 dark:text-purple-300">
          <div class="font-medium">
            待 Agent 复盘的运行问题
          </div>
          <div class="mt-1">
            {{ evolve?.pendingRuntimeIssueCount || 0 }} 类 · {{ evolve?.pendingRuntimeIssueOccurrences || 0 }} 次
          </div>
          <div class="mt-1 opacity-75">
            只保留脱敏摘要；确认无需修改或更新生效后清除，最长保留 72 小时。
          </div>
        </div>
      </div>
      <div class="mt-3 rounded border border-purple-200 bg-white/70 p-3 dark:border-purple-700/50 dark:bg-gray-800/70">
        <label class="text-xs font-medium text-purple-900 dark:text-purple-200" for="evolution-user-instruction">
          给 Claude/Codex 的修改要求
        </label>
        <textarea
          id="evolution-user-instruction"
          v-model="instructionDraft"
          maxlength="4000"
          rows="3"
          class="mt-2 w-full resize-y rounded border border-purple-200 bg-white px-3 py-2 text-sm text-gray-800 outline-none focus:border-purple-500 dark:border-purple-700 dark:bg-gray-900 dark:text-white"
          placeholder="例如：本次熔断收得太紧。保持当前收菜/偷菜优先级，只降低普通巡查频率；自己成熟收获、好友到点偷菜、重点用户 HOT/PREARM 不得被 cooldown 阻断。"
          :disabled="evolve?.status === 'running' || evolve?.status === 'revising'"
        />
        <p class="mt-1 text-xs text-purple-700/90 dark:text-purple-300/90">
          保存后会持久加入以后每一轮提示词，清空并保存即可取消。拒绝重做时会先回退旧提交，再强制读取完整 HANDOFF、上一轮日志和被拒绝 diff，沿用原分析继续修改；没有待应用提交时按钮保持可见但置灰。
        </p>
        <div class="mt-2 flex flex-wrap gap-2">
          <button
            class="rounded bg-purple-600 px-3 py-1.5 text-xs text-white transition hover:bg-purple-700 disabled:opacity-50"
            :disabled="instructionSaving || evolve?.status === 'running' || evolve?.status === 'revising'"
            @click="saveEvolutionInstruction"
          >
            {{ instructionSaving ? '保存中…' : '保存修改要求' }}
          </button>
          <button
            class="rounded bg-rose-600 px-3 py-1.5 text-xs text-white transition hover:bg-rose-700 disabled:opacity-50"
            :disabled="revisionRunning || evolve?.status !== 'pending_apply' || !instructionDraft.trim()"
            :title="evolve?.status === 'pending_apply' ? '回退当前待应用提交并续接上一轮上下文重做' : '当前没有待应用的进化提交'"
            @click="reviseEvolution"
          >
            {{ revisionRunning
              ? '正在回退并重做…'
              : evolve?.status === 'pending_apply'
                ? '拒绝本次并按要求重做'
                : '拒绝本次并按要求重做（当前无待应用提交）' }}
          </button>
        </div>
      </div>
      <div class="mt-3 grid gap-2 md:grid-cols-2">
        <div class="rounded border border-purple-200 bg-white/60 p-2.5 dark:border-purple-700/50 dark:bg-gray-800/60">
          <div class="text-xs font-medium text-purple-900 dark:text-purple-200">
            安全巡检（防封审计）
          </div>
          <div class="mt-1 text-xs text-purple-800 dark:text-purple-300">
            状态：{{ evolveStatusLabel }}
            <span v-if="evolve?.commit">（提交 {{ String(evolve.commit).slice(0, 8) }}）</span>
          </div>
          <p v-if="evolve?.summary" class="mt-1 text-xs break-all text-purple-700 dark:text-purple-300">
            {{ evolve.summary }}
          </p>
          <div class="mt-2">
            <button
              class="rounded bg-purple-600 px-3 py-1.5 text-xs text-white transition hover:bg-purple-700 disabled:opacity-50"
              :disabled="evolutionBlocked"
              @click="triggerSafetyEvolve"
            >
              {{ safetyRunning ? '启动中…' : '立即巡检' }}
            </button>
          </div>
        </div>
        <div class="rounded border border-purple-200 bg-white/60 p-2.5 dark:border-purple-700/50 dark:bg-gray-800/60">
          <div class="text-xs font-medium text-purple-900 dark:text-purple-200">
            活动进化
          </div>
          <div class="mt-1 text-xs text-purple-800 dark:text-purple-300">
            上次：{{ evolve?.lastEvolveDate || '未跑' }}
          </div>
          <div class="mt-2">
            <button
              class="rounded bg-purple-600 px-3 py-1.5 text-xs text-white transition hover:bg-purple-700 disabled:opacity-50"
              :disabled="evolutionBlocked"
              @click="triggerEvolve"
            >
              {{ evolving ? '启动中…' : '立即进化' }}
            </button>
          </div>
        </div>
      </div>
      <div class="mt-2">
        <button
          class="rounded bg-amber-500 px-3 py-1.5 text-xs text-white transition hover:bg-amber-600 disabled:opacity-50"
          :disabled="evolve?.status !== 'pending_apply'"
          @click="applyEvolve"
        >
          {{ applying ? '正在重启…' : '应用进化（重启生效）' }}
        </button>
      </div>
    </div>

    <template v-if="report">
      <div class="grid gap-4 lg:grid-cols-2">
        <div class="rounded-lg border border-gray-200 p-4 dark:border-gray-700">
          <h4 class="text-sm font-semibold text-gray-900 dark:text-white">候选新活动 ID</h4>
          <div v-if="report.unknownActivityIds.length" class="mt-3 flex flex-wrap gap-2">
            <code v-for="id in report.unknownActivityIds" :key="id" class="rounded bg-amber-50 px-2 py-1 text-xs text-amber-800 dark:bg-amber-900/30 dark:text-amber-200">{{ id }}</code>
          </div>
          <p v-else class="mt-3 text-sm text-gray-500">没有发现当前代码尚未登记的活动 ID。</p>
          <p class="mt-3 text-xs text-gray-400">共识别 {{ report.detectedActivityIds.length }} 个日期型活动 ID；候选项仍需协议样本确认。</p>
          <div v-if="report.analysis?.candidateGroups.length" class="mt-3 space-y-2 border-t border-gray-100 pt-3 dark:border-gray-700">
            <div v-for="group in report.analysis.candidateGroups" :key="group.date" class="text-xs text-gray-500">
              {{ group.date }}：{{ group.ids.join('、') }}
            </div>
          </div>
        </div>

        <div class="rounded-lg border border-gray-200 p-4 dark:border-gray-700">
          <h4 class="text-sm font-semibold text-gray-900 dark:text-white">扫描提示</h4>
          <ul v-if="report.warnings.length" class="mt-3 space-y-2 text-sm text-amber-700 dark:text-amber-300">
            <li v-for="warning in report.warnings" :key="warning" class="flex gap-2">
              <span class="i-carbon-warning-alt mt-0.5 shrink-0" />{{ warning }}
            </li>
          </ul>
          <p v-else class="mt-3 text-sm text-gray-500">源码目录与资源缓存检查正常。</p>
          <div class="mt-3 text-xs text-gray-400">扫描时间：{{ formatTime(report.scannedAt) }}</div>
        </div>
      </div>

      <div class="rounded-lg border border-gray-200 p-4 dark:border-gray-700">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <h4 class="text-sm font-semibold text-gray-900 dark:text-white">在线 ActivityService 分析</h4>
          <span
            class="rounded-full px-2.5 py-1 text-xs"
            :class="report.online?.available
              ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-200'
              : 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300'"
          >
            {{ report.online?.available ? `已通过 ${report.online.accountName || '在线账号'} 读取` : '等待在线账号' }}
          </span>
        </div>
        <p v-if="!report.online?.available" class="mt-3 text-sm text-gray-500">
          {{ report.online?.error || '启动并连接任意账号后，定时器会自动读取服务端活动列表。' }}
        </p>
        <template v-else>
          <div class="mt-3 grid gap-3 sm:grid-cols-3">
            <div class="rounded-lg bg-gray-50 px-3 py-2 dark:bg-gray-900/40">
              <div class="text-xs text-gray-500">服务端活动</div>
              <div class="mt-1 font-medium">{{ report.online.activities.length }} 个</div>
            </div>
            <div class="rounded-lg bg-gray-50 px-3 py-2 dark:bg-gray-900/40">
              <div class="text-xs text-gray-500">新增候选</div>
              <div class="mt-1 font-medium">{{ report.online.unknownActivityIds.length }} 个</div>
            </div>
            <div class="rounded-lg bg-gray-50 px-3 py-2 dark:bg-gray-900/40">
              <div class="text-xs text-gray-500">GetGroup 探测</div>
              <div class="mt-1 font-medium">{{ report.online.probes?.activityGroups || 0 }} 组 · {{ report.online.probes?.matched || 0 }} 节点</div>
            </div>
          </div>
          <div v-if="report.online.groups.length" class="mt-3 space-y-2">
            <div v-for="group in report.online.groups" :key="group.id" class="rounded-lg border border-gray-100 px-3 py-2 text-sm dark:border-gray-700">
              <div class="flex flex-wrap justify-between gap-2">
                <span class="font-medium text-gray-900 dark:text-white">{{ group.title || `活动 ${group.id}` }}</span>
                <code class="text-xs text-gray-500">{{ group.id }}</code>
              </div>
              <div class="mt-1 text-xs text-gray-500">
                {{ group.error || `${formatTime(group.startTime && group.startTime * 1000)} — ${formatTime(group.endTime && group.endTime * 1000)}` }}
              </div>
            </div>
          </div>
        </template>
      </div>

      <div
        v-if="discoveredGroups.length"
        class="rounded-lg border border-amber-200 bg-amber-50 p-4 text-amber-900 dark:border-amber-800 dark:bg-amber-900/20 dark:text-amber-200"
      >
        <h4 class="font-semibold">新活动待适配</h4>
        <p class="mt-2 text-sm">
          已自动发现 {{ discoveredGroups.length }} 个活动入口。当前仅保存只读结构快照，等待确认兑换、抽奖或任务规则。
        </p>
        <div class="mt-3 space-y-2">
          <div v-for="group in discoveredGroups" :key="group.id" class="rounded-lg bg-white/70 px-3 py-2 dark:bg-gray-900/40">
            <div class="flex flex-wrap items-center justify-between gap-2">
              <strong>{{ group.title || `活动 ${group.id}` }}</strong>
              <code class="text-xs">ID {{ group.id }}</code>
            </div>
            <div class="mt-1 text-xs opacity-80">来源 List + GetGroup · {{ contentSummary(group) }}</div>
          </div>
        </div>
      </div>

      <div v-if="discoveredGroups.length" class="space-y-4">
        <article v-for="group in discoveredGroups" :key="`detail-${group.id}`" class="rounded-lg border border-gray-200 p-4 dark:border-gray-700">
          <div class="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h4 class="text-lg font-semibold text-gray-900 dark:text-white">{{ group.title || `活动 ${group.id}` }}</h4>
              <code class="mt-1 block text-sm text-gray-500">ID {{ group.id }}</code>
            </div>
            <span class="rounded-full bg-teal-50 px-3 py-1 text-xs font-medium text-teal-700 dark:bg-teal-900/30 dark:text-teal-200">
              {{ activityStatus(group) }}
            </span>
          </div>
          <div class="mt-4 grid gap-3 sm:grid-cols-3">
            <div class="rounded-lg bg-gray-50 p-3 dark:bg-gray-900/40">
              <div class="text-xs text-gray-500">开始时间</div>
              <div class="mt-1 font-medium text-gray-900 dark:text-white">{{ formatTime(group.startTime && group.startTime * 1000) }}</div>
            </div>
            <div class="rounded-lg bg-gray-50 p-3 dark:bg-gray-900/40">
              <div class="text-xs text-gray-500">结束时间</div>
              <div class="mt-1 font-medium text-gray-900 dark:text-white">{{ formatTime(group.endTime && group.endTime * 1000) }}</div>
            </div>
            <div class="rounded-lg bg-gray-50 p-3 dark:bg-gray-900/40">
              <div class="text-xs text-gray-500">内容摘要</div>
              <div class="mt-1 font-medium text-gray-900 dark:text-white">{{ contentSummary(group) }}</div>
            </div>
          </div>
          <div v-if="group.children?.length" class="mt-4">
            <div class="text-sm font-semibold text-gray-900 dark:text-white">活动节点 {{ group.children.length }}</div>
            <div class="mt-2 grid gap-2 sm:grid-cols-2">
              <div v-for="child in group.children" :key="child.id" class="rounded-lg border border-gray-100 px-3 py-2 dark:border-gray-700">
                <div class="flex justify-between gap-2 text-sm">
                  <span class="font-medium">{{ child.title || `节点 ${child.id}` }}</span>
                  <code class="text-xs text-gray-500">{{ child.id }}</code>
                </div>
                <div class="mt-1 text-xs text-gray-500">{{ activityNodeLabel(child) }} · {{ contentSummary(child) }}</div>
                <p class="mt-2 text-xs leading-5 text-gray-500">{{ activityNodeDescription(child) }}</p>
              </div>
            </div>
          </div>
          <div v-if="activityRuleSections(group).length" class="mt-5 border-t border-gray-100 pt-4 dark:border-gray-700">
            <h5 class="font-semibold text-gray-900 dark:text-white">玩法规则与完整活动说明</h5>
            <section
              v-for="section in activityRuleSections(group)"
              :key="section.id"
              class="mt-3 rounded-lg bg-gray-50 p-4 dark:bg-gray-900/40"
            >
              <div class="flex flex-wrap items-center justify-between gap-2">
                <h6 class="font-medium text-gray-900 dark:text-white">{{ section.title }}</h6>
                <span class="text-xs text-gray-500">
                  节点 {{ section.id }}<template v-if="section.uid"> · {{ section.uid }}</template>
                </span>
              </div>
              <div class="mt-3 space-y-2 text-sm leading-6 text-gray-700 dark:text-gray-300">
                <p v-for="(line, index) in section.lines" :key="`${section.id}-${index}`" class="whitespace-pre-line">
                  {{ line }}
                </p>
              </div>
            </section>
          </div>
        </article>
      </div>

    </template>
  </section>
</template>
