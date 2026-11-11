<script setup lang="ts">
import { onMounted, ref } from 'vue'
import api from '@/api'
import BaseButton from '@/components/ui/BaseButton.vue'
interface Investigation { id: string, area: string, question: string, missing: string, conclusion: string, lastCheckedAt: number, needsOwner: boolean, verification?: { method: string, checked: string, result: string } }
const entries = ref<Investigation[]>([])
const error = ref('')
const loading = ref(false)
const labels: Record<string, string> = { external_updates: '参考更新', interface_compatibility: '接口兼容', planting: '种植资料', runtime_logs: '运行异常', uncertain_incidents: '历史事件', usability: '使用体验', problem_analysis: '故障排查', retired_activities: '活动清退' }
async function load() {
  if (loading.value) return
  loading.value = true
  error.value = ''
  try { const { data } = await api.get('/api/super-admin/investigations'); entries.value = data.investigations }
  catch { error.value = '调查记录暂时不可读，请稍后刷新' }
  finally { loading.value = false }
}
onMounted(load)
</script>
<template>
  <section class="ui-card space-y-3 border rounded-2xl p-4" aria-label="自进化待跟进调查">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div><h4 class="font-semibold">待跟进调查 · {{ entries.length }}</h4><p class="mt-1 text-sm opacity-75">查看实际复核结果与具体缺项；历史未定位事件继续保留，不当作已修复。</p></div>
      <BaseButton variant="secondary" size="sm" :loading="loading" @click="load">刷新记录</BaseButton>
    </div>
    <p v-if="error" role="alert" class="text-sm text-red-600">{{ error }}</p>
    <p v-else-if="!entries.length && !loading" class="text-sm opacity-70">当前没有待跟进调查。</p>
    <details v-for="entry in entries" :key="entry.id" class="border rounded-xl p-3">
      <summary class="cursor-pointer break-words text-sm font-medium">{{ labels[entry.area] || '调查' }} · {{ entry.question }}</summary>
      <div class="mt-3 space-y-2 break-words text-sm">
        <p v-if="entry.conclusion">本次核验：{{ entry.conclusion }}</p>
        <p v-if="entry.verification">实际检查：{{ entry.verification.checked }}；{{ entry.verification.result }}</p>
        <p>尚缺：{{ entry.missing }}</p>
        <p class="text-xs opacity-65">{{ entry.needsOwner ? '需要外部材料或用户观察' : '由现有日志与后续证据继续跟进' }} · {{ entry.lastCheckedAt ? new Date(entry.lastCheckedAt).toLocaleString() : '尚无额外复核回执' }}</p>
      </div>
    </details>
  </section>
</template>
