<script setup lang="ts">
import { computed } from 'vue'
import { useEvolutionStore } from '@/stores/evolution'
import { useToastStore } from '@/stores/toast'

const props = withDefaults(defineProps<{ dark?: boolean }>(), { dark: false })

const toast = useToastStore()
const evolutionStore = useEvolutionStore()
const disabled = computed(() => evolutionStore.agentsLocked || evolutionStore.saving || evolutionStore.loading || !evolutionStore.evolve)

const COLLABORATION_PHASE_LABELS: Record<string, string> = {
  research: '资料检索',
  plan: '方案确认',
  revise_plan: '子 Agent 修订方案（只读）',
  implement: '实施改动',
  verify: '运行验证',
  review: '复核审查',
  diagnose: '主 Agent 分析失败原因',
  repair: '子 Agent 修复',
  repair_review: '主 Agent 验收修复',
  commit: '提交收口',
  complete: '协作完成',
  failed: '协作失败',
}
const COLLABORATION_STATUS_LABELS: Record<string, string> = {
  running: '执行中',
  completed: '已完成',
  failed: '失败',
}

function agentDisplayName(agent: string) {
  return agent === 'codex' ? 'Codex' : 'Claude'
}

const phaseText = computed(() => {
  const collab = evolutionStore.collaboration
  if (collab) {
    const phase = collab.repairOnly && collab.status === 'completed'
      ? '编排修复已验收，原巡检待继续'
      : COLLABORATION_PHASE_LABELS[collab.phase] || collab.phase
    const status = COLLABORATION_STATUS_LABELS[collab.status] || collab.status
    const agent = collab.activeAgent ? ` · ${agentDisplayName(collab.activeAgent)} 执行` : ''
    const recovery = collab.recoveryKind || collab.planRevision
      ? ` · 执行恢复 ${collab.runtimeRecoveryAttempt || 0}/2 · 方案修订 ${collab.planRevision || 0}/2 · 验收返工 ${collab.reviewRecoveryAttempt || 0}/2`
      : collab.recoveryAttempt ? ` · 修复 ${collab.recoveryAttempt}/${collab.recoveryLimit || 2}` : ''
    const failure = collab.status === 'failed' && collab.failure ? ` · ${collab.failure.label}` : ''
    return `双 Agent：${phase}（${status}${agent}）${recovery}${failure}`
  }
  if (evolutionStore.running)
    return `进化任务执行中 · ${agentDisplayName(evolutionStore.activeMainAgent)}`
  return ''
})

const phaseClass = computed(() => {
  const status = evolutionStore.collaboration?.status
  if (status === 'failed')
    return props.dark ? 'bg-rose-500/25 text-rose-200' : 'bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-200'
  if (status === 'completed')
    return props.dark ? 'bg-emerald-400/20 text-emerald-200' : 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-200'
  return props.dark ? 'bg-amber-400/25 text-amber-100' : 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-200'
})

const shellClass = computed(() => [
  'flex flex-col gap-1.5 rounded-lg border px-3 py-2 text-xs',
  props.dark
    ? 'border-sky-200/25 bg-[#071b43]/75 text-sky-50 backdrop-blur-sm'
    : 'border-gray-200 bg-gray-50 text-gray-700 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200',
].join(' '))

const selectClass = computed(() => [
  'rounded px-1.5 py-1 text-xs outline-none disabled:opacity-50',
  props.dark
    ? 'border border-sky-200/30 bg-[#102b56] text-white'
    : 'border border-gray-200 bg-white text-gray-800 dark:border-gray-600 dark:bg-gray-800 dark:text-white',
].join(' '))

const saveButtonClass = computed(() => [
  'rounded px-2 py-1 text-xs text-white transition disabled:opacity-50',
  props.dark ? 'bg-sky-500/80 hover:bg-sky-500' : 'bg-purple-600 hover:bg-purple-700',
].join(' '))

const hintClass = computed(() => (props.dark ? 'text-sky-100/70' : 'text-gray-500 dark:text-gray-400'))
const errorClass = computed(() => (props.dark ? 'text-rose-300' : 'text-rose-600 dark:text-rose-300'))

async function saveAgentSettings() {
  const result = await evolutionStore.saveAgents()
  if (!result.ok) {
    toast.error(result.error || '保存进化执行器配置失败')
    return
  }
  const main = agentDisplayName(evolutionStore.draft.mainAgent)
  toast.success(evolutionStore.draft.dualAgentEnabled
    ? `双 Agent 配置已保存：主 ${main} · 子 ${agentDisplayName(evolutionStore.draft.subAgent)}`
    : `进化执行器已设为 ${main}（单执行器模式）`)
}
</script>

<template>
  <div :class="shellClass">
    <div class="flex flex-wrap items-center gap-2">
      <label class="inline-flex items-center gap-1.5">
        <input
          v-model="evolutionStore.draft.dualAgentEnabled"
          type="checkbox"
          class="h-3.5 w-3.5"
          :disabled="disabled"
          @change="evolutionStore.markDraftDirty()"
        >
        <span class="whitespace-nowrap">双 Agent 协作</span>
      </label>
      <label class="inline-flex items-center gap-1.5">
        <span class="whitespace-nowrap">{{ evolutionStore.draft.dualAgentEnabled ? '主 Agent' : '执行器' }}</span>
        <select
          v-model="evolutionStore.draft.mainAgent"
          :class="selectClass"
          :disabled="disabled"
          @change="evolutionStore.markDraftDirty()"
        >
          <option value="claude">Claude</option>
          <option value="codex">Codex</option>
        </select>
      </label>
      <label class="inline-flex items-center gap-1.5" :class="evolutionStore.draft.dualAgentEnabled ? '' : 'opacity-40'">
        <span class="whitespace-nowrap">子 Agent</span>
        <select
          v-model="evolutionStore.draft.subAgent"
          :class="selectClass"
          :disabled="!evolutionStore.draft.dualAgentEnabled || disabled"
          @change="evolutionStore.markDraftDirty()"
        >
          <option value="claude">Claude</option>
          <option value="codex">Codex</option>
        </select>
      </label>
      <button
        v-if="evolutionStore.draftDirty || evolutionStore.saving"
        :class="saveButtonClass"
        :disabled="disabled"
        @click="saveAgentSettings"
      >
        {{ evolutionStore.saving ? '保存中…' : '保存配置' }}
      </button>
      <span v-if="phaseText" class="rounded-full px-2 py-0.5 font-medium" :class="phaseClass">{{ phaseText }}</span>
    </div>
    <p :class="hintClass">
      推荐组合：主 Codex（确认方案与复核）+ 子 Claude（检索 GitHub、巡查与实施）；关闭双 Agent 时仅由主 Agent 单独执行。
      执行恢复、只读方案修订和验收返工分别限两次；方案通过后才允许实施。
    </p>
    <p v-if="evolutionStore.error" :class="errorClass">
      {{ evolutionStore.error }}
    </p>
  </div>
</template>
