<script setup lang="ts">
defineProps<{
  runtime?: {
    managementCommit?: string
    hostCommit?: string
    businessCommit?: string
    businessReady?: boolean
  }
}>()

function version(commit?: string) {
  return /^[a-f0-9]{40,64}$/i.test(commit || '') ? commit!.slice(0, 7) : '待确认'
}
</script>

<template>
  <details v-if="runtime" class="mt-2 text-xs text-gray-500 dark:text-gray-400">
    <summary class="cursor-pointer select-none">
      连接常驻 · {{ runtime.businessReady ? '业务已就绪' : '业务待就绪' }}
    </summary>
    <dl class="mt-2 grid grid-cols-3 gap-2 text-center">
      <div>
        <dt>管理版本</dt>
        <dd :title="runtime.managementCommit" class="mt-1 font-mono">{{ version(runtime.managementCommit) }}</dd>
      </div>
      <div>
        <dt>连接版本</dt>
        <dd :title="runtime.hostCommit" class="mt-1 font-mono">{{ version(runtime.hostCommit) }}</dd>
      </div>
      <div>
        <dt>业务版本</dt>
        <dd :title="runtime.businessCommit" class="mt-1 font-mono">{{ version(runtime.businessCommit) }}</dd>
      </div>
    </dl>
  </details>
</template>
