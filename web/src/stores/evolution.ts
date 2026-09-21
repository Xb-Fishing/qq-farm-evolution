import { defineStore } from 'pinia'
import { computed, reactive, ref } from 'vue'
import api from '@/api'

export type EvolutionAgentKind = 'claude' | 'codex'

export interface EvolutionCollaboration {
  phase: 'triage' | 'research' | 'revise_plan' | 'plan' | 'implement' | 'verify' | 'review' | 'diagnose' | 'repair' | 'repair_review' | 'commit' | 'complete' | 'failed'
  status: 'running' | 'completed' | 'failed'
  activeAgent: EvolutionAgentKind | ''
  recoveryAttempt?: number
  recoveryLimit?: number
  recoveryKind?: 'runtime' | 'review' | ''
  runtimeRecoveryAttempt?: number
  reviewRecoveryAttempt?: number
  planRevision?: number
  reviewFeedback?: string
  repairOnly?: boolean
  failure?: { code: string, label: string, phase: string, agent: EvolutionAgentKind | '' } | null
}

export interface EvolutionState {
  status?: string
  summary?: string
  commit?: string
  lastRunAt?: number
  lastTask?: string
  lastSafetyEvolveDate?: string
  lastEvolveDate?: string
  /** 每日综合巡检合并复核活动侧的完成日（不写 lastEvolveDate，防封去重语义保留） */
  lastActivityReviewDate?: string
  /** 上一轮 Agent 会话 ID（隐私拦截/拒绝重做时 --resume 续接原对话） */
  agentSessionId?: string
  userInstruction?: string
  nextAutoRunAt?: number
  pendingRuntimeIssueCount?: number
  pendingRuntimeIssueOccurrences?: number
  defaultAgent?: EvolutionAgentKind
  agent?: EvolutionAgentKind
  mainAgent?: EvolutionAgentKind
  subAgent?: EvolutionAgentKind
  dualAgentEnabled?: boolean
  collaboration?: EvolutionCollaboration | null
  learning?: { count: number, updatedAt: number }
  feedbackCleanupPending?: boolean
  dailyFeedback?: { day: string, counts: { clicks: number, requests: number, failures: number }, dropped: number, unreadableFiles: number }
  validation?: { state: 'unknown' | 'running' | 'passed' | 'failed', checkedAt: number, fingerprint: string, checks: string[] }
  references?: { state: string, searchedAt?: string, candidateCount?: number, queriesSucceeded?: number, newCandidates?: string[], discoveryComplete?: boolean }
}

export interface EvolutionAgentDraft {
  dualAgentEnabled: boolean
  mainAgent: EvolutionAgentKind
  subAgent: EvolutionAgentKind
}

const AGENT_KINDS: EvolutionAgentKind[] = ['claude', 'codex']
const STATUS_POLL_INTERVAL_MS = 10 * 1000

function normalizeAgentKind(value: unknown, fallback: EvolutionAgentKind): EvolutionAgentKind {
  return AGENT_KINDS.includes(value as EvolutionAgentKind) ? (value as EvolutionAgentKind) : fallback
}

// 活动中心顶部与活动分析弹窗共享同一份进化状态；轮询只刷新服务端快照，
// 未保存的本地执行器草稿（dirty）不被覆盖，保存失败时回滚为服务端值。
export const useEvolutionStore = defineStore('evolution', () => {
  const evolve = ref<EvolutionState | null>(null)
  const draft = reactive<EvolutionAgentDraft>({ dualAgentEnabled: false, mainAgent: 'claude', subAgent: 'claude' })
  const draftDirty = ref(false)
  const loading = ref(false)
  const saving = ref(false)
  const error = ref('')

  let pollRefCount = 0
  let pollTimer: ReturnType<typeof setInterval> | null = null
  let statusInFlight: Promise<any> | null = null
  let stateRevision = 0

  const running = computed(() => evolve.value?.status === 'running')
  const collaboration = computed(() => (evolve.value?.dualAgentEnabled ? (evolve.value?.collaboration || null) : null))
  const activeMainAgent = computed<EvolutionAgentKind>(() =>
    normalizeAgentKind(evolve.value?.mainAgent ?? evolve.value?.defaultAgent ?? evolve.value?.agent, 'claude'))
  // 执行器配置在运行/回退重做/应用期间锁定；双 Agent 协作进行中也锁定
  const agentsLocked = computed(() => {
    const status = evolve.value?.status
    return status === 'running' || status === 'revising' || status === 'applying' || evolve.value?.collaboration?.status === 'running'
  })

  function applyServerAgents(value: EvolutionState | null | undefined) {
    draft.dualAgentEnabled = value?.dualAgentEnabled === true
    draft.mainAgent = normalizeAgentKind(value?.mainAgent ?? value?.defaultAgent ?? value?.agent, 'claude')
    draft.subAgent = normalizeAgentKind(value?.subAgent, draft.mainAgent === 'codex' ? 'claude' : 'codex')
  }

  function syncEvolve(value: EvolutionState | null | undefined, options: { applyAgents?: boolean } = {}) {
    stateRevision += 1
    evolve.value = value || null
    if (options.applyAgents === true || !draftDirty.value)
      applyServerAgents(evolve.value)
  }

  function markDraftDirty() {
    draftDirty.value = true
  }

  function resetDraft() {
    applyServerAgents(evolve.value)
    draftDirty.value = false
  }

  async function loadStatus(silent = false) {
    if (statusInFlight)
      return statusInFlight
    if (!silent)
      loading.value = true
    const revisionAtRequest = stateRevision
    statusInFlight = api.get('/api/activity/update/status')
      .then(({ data }) => {
        if (data.ok && revisionAtRequest === stateRevision)
          syncEvolve(data.evolve)
        // 已有保存/任务响应先返回时，丢弃旧 GET 的状态，避免把新配置覆盖回旧值。
        return data.ok ? { ...data, evolve: evolve.value } : data
      })
      .finally(() => {
        statusInFlight = null
        if (!silent)
          loading.value = false
      })
    return statusInFlight
  }

  async function saveAgents() {
    if (saving.value)
      return { ok: false, error: '正在保存，请稍候' }
    if (agentsLocked.value)
      return { ok: false, error: '进化任务执行期间不能修改执行器配置' }
    saving.value = true
    error.value = ''
    try {
      const { data } = await api.post('/api/activity/update/agents', {
        dualAgentEnabled: draft.dualAgentEnabled,
        mainAgent: draft.mainAgent,
        subAgent: draft.subAgent,
      })
      if (!data.ok)
        throw new Error(data.error || '保存进化执行器配置失败')
      syncEvolve(data.evolve, { applyAgents: true })
      draftDirty.value = false
      return { ok: true }
    }
    catch (err: any) {
      // 保存失败：两个入口都恢复为服务端当前状态，错误保留在共享状态供展示
      try {
        if (statusInFlight)
          await statusInFlight
        await loadStatus(true)
      }
      catch { /* 状态也不可用时恢复最后一次已确认快照 */ }
      resetDraft()
      error.value = err?.response?.data?.error || err.message || '保存进化执行器配置失败'
      return { ok: false, error: error.value }
    }
    finally {
      saving.value = false
    }
  }

  // 引用计数轮询：活动中心页与活动分析弹窗共用一个 10 秒状态刷新，全部 unmount 后清理定时器
  function startPolling() {
    pollRefCount += 1
    if (pollTimer)
      return
    pollTimer = setInterval(() => {
      if (saving.value || statusInFlight)
        return
      void loadStatus(true).catch(() => {})
    }, STATUS_POLL_INTERVAL_MS)
  }

  function stopPolling() {
    if (pollRefCount > 0)
      pollRefCount -= 1
    if (pollRefCount === 0 && pollTimer) {
      clearInterval(pollTimer)
      pollTimer = null
    }
  }

  return {
    evolve,
    draft,
    draftDirty,
    loading,
    saving,
    error,
    running,
    collaboration,
    activeMainAgent,
    agentsLocked,
    syncEvolve,
    markDraftDirty,
    resetDraft,
    loadStatus,
    saveAgents,
    startPolling,
    stopPolling,
  }
})
