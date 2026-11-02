<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import BaseButton from '@/components/ui/BaseButton.vue'
import { useActivityStore } from '@/stores/activity'
const props = defineProps<{ accountId: string }>()
const store = useActivityStore()
const expanded = ref(false)
const query = ref('')
const seriesId = ref('')
const star = ref(1)
const selectedId = ref<number | null>(null)
const number = (value: unknown) => value == null || !Number.isFinite(Number(value)) ? '未知' : Number(value).toLocaleString()
const time = (value: unknown) => value == null || !(Number(value) > 0) ? '未读取' : new Date(Number(value)).toLocaleString()
const catalog = computed(() => store.updateReads.catalog.data)
const entries = computed(() => (catalog.value?.series || []).flatMap((group: any) => (group.items || []).map((item: any) => ({ ...item, group }))))
const filtered = computed(() => entries.value.filter((item: any) => (!seriesId.value || String(item.group.id) === seriesId.value) && item.name.includes(query.value.trim())))
const selected = computed(() => entries.value.find((item: any) => item.id === selectedId.value))
const materials = computed(() => {
  const raw = selected.value?.group?.stars?.find((row: any) => row.level === Number(star.value))?.materials
  if (typeof raw !== 'string')
    return '材料配置未知'
  return raw.split(';').filter(Boolean).map(part => {
    const [id, count] = part.split(':')
    return `${id === '0' ? '同款藏品' : id === '1001' ? '金币' : `材料 ${id}`} × ${number(count)}`
  }).join('，')
})
const score = computed(() => catalog.value?.scores?.find((row: any) => row.star === Number(star.value))?.scores?.[Number(selected.value?.group?.rarity) - 1])
const labels: Record<string, string> = { announcements: '官方公告', emails: '两类邮箱', solarCalendar: '节令日历', tasks: '任务', illustrated: '图鉴', mall: '免费商城' }
const status = (value: string) => ({ ok: '读取成功', partial: '部分读取失败', error: '读取失败' }[value] || '未确认')
async function open() {
  expanded.value = !expanded.value
  if (expanded.value)
    await Promise.allSettled((['evidence', 'emails', 'catalog'] as const).filter(key => !store.updateReads[key].data).map(key => store.loadUpdate(key, props.accountId)))
}
onBeforeUnmount(() => store.cancelUpdateReads())
</script>

<template>
  <section class="update-card" aria-label="游戏更新与邮箱">
    <div class="update-heading">
      <div><h2>游戏更新与邮箱</h2><p>查看采集时间、两类邮件和本地藏品目录。</p></div>
      <BaseButton variant="secondary" :disabled="!accountId" :aria-expanded="expanded" @click="open">{{ expanded ? '收起更新与邮箱' : '查看更新与邮箱' }}</BaseButton>
    </div>
    <div v-if="expanded" class="update-sections">
      <section aria-label="今日动态">
        <h3>今日动态</h3>
        <BaseButton variant="secondary" :loading="store.updateReads.evidence.loading" @click="store.loadUpdate('evidence', accountId)">刷新今日动态</BaseButton>
        <p v-if="store.updateReads.evidence.error" role="alert">{{ store.updateReads.evidence.error }}（保留上次成功快照）</p>
        <p>采集：{{ time(store.updateReads.evidence.data?.collectedAt) }}。缓存状态有时效，不代表此刻没有新奖励。</p>
        <ul v-if="store.updateReads.evidence.data">
          <li v-for="(source, key) in store.updateReads.evidence.data.sources" :key="key">{{ labels[String(key)] || '已审入口' }}：{{ status(source.status) }} · {{ time(source.fetchedAt) }}</li>
        </ul>
        <p class="update-muted">设置、珍藏室持有状态和官方全部红点界面尚未取得当前证据。</p>
      </section>
      <section aria-label="只读邮箱">
        <h3>只读邮箱</h3>
        <BaseButton variant="secondary" :loading="store.updateReads.emails.loading" @click="store.loadUpdate('emails', accountId)">刷新邮箱</BaseButton>
        <p v-if="store.updateReads.emails.error" role="alert">{{ store.updateReads.emails.error }}（保留上次成功快照）</p>
        <p>列表不含邮件正文与附件明细，刷新不会领取奖励。</p>
        <div v-for="box in [1, 2]" :key="box" class="update-row">
          <strong>{{ box === 1 ? '系统邮箱' : '玩家邮箱' }}</strong>
          <span v-if="store.updateReads.emails.data?.boxes?.[box]?.ok">共 {{ number(store.updateReads.emails.data.boxes[box].total) }} 封 · 可领 {{ number(store.updateReads.emails.data.boxes[box].claimable) }} 封 · {{ time(store.updateReads.emails.data.boxes[box].fetchedAt) }}</span>
          <span v-else>{{ store.updateReads.emails.data ? '本箱读取失败，数量未知' : '尚未读取' }}</span>
        </div>
      </section>
      <section aria-label="本地藏品目录">
        <h3>本地藏品目录</h3>
        <p>125 级解锁，最多 5 星。当前持有、激活、展台与已领评分奖励未知；本区只查阅配置。</p>
        <BaseButton variant="secondary" :loading="store.updateReads.catalog.loading" @click="store.loadUpdate('catalog', accountId)">刷新本地目录</BaseButton>
        <p v-if="store.updateReads.catalog.error" role="alert">{{ store.updateReads.catalog.error }}</p>
        <div class="update-fields">
          <label>搜索藏品<input v-model="query" aria-label="搜索藏品" placeholder="输入名称"></label>
          <label>藏品系列<select v-model="seriesId" aria-label="藏品系列"><option value="">全部系列</option><option v-for="group in catalog?.series || []" :key="group.id" :value="String(group.id)">{{ group.name }}</option></select></label>
        </div>
        <p v-if="catalog && !filtered.length">没有匹配的藏品</p>
        <div class="update-items">
          <BaseButton v-for="item in filtered" :key="item.id" variant="secondary" :aria-pressed="selectedId === item.id" @click="selectedId = item.id">{{ item.name }} · {{ item.group.name }}</BaseButton>
        </div>
        <div v-if="selected" class="update-detail" aria-label="藏品材料详情">
          <h4>{{ selected.name }}</h4><p>{{ selected.description }}</p>
          <label>查看星级<select v-model="star" aria-label="查看星级"><option v-for="level in [1, 2, 3, 4, 5]" :key="level" :value="level">{{ level }} 星</option></select></label>
          <p>本级所需：{{ materials }}。配置评分：{{ number(score) }}。</p>
          <p class="update-muted">{{ selected.imageStatus }}；未新增激活、升星或药水消耗入口。</p>
        </div>
        <details v-if="catalog"><summary>评分奖励配置（不代表已领取）</summary><ul><li v-for="row in catalog.milestones || []" :key="row.level">{{ number(row.score) }} 分：<span v-for="buff in row.buffs || []" :key="buff.name">{{ buff.name === '节省10%肥料' ? `${number(Number(buff.value) / 100)}%概率节省10%肥料` : `${buff.name} +${number(Number(buff.value) / 100)}%` }} </span><span v-if="!row.buffs?.length">奖励以当前官方状态为准</span></li></ul></details>
        <p v-if="catalog" class="update-muted">来源：{{ catalog.source.alias }} · 定版配置；已读取的配置不代表已取得当前账号状态。</p>
      </section>
      <details v-if="catalog"><summary>本次更新作物与核对边界</summary><ul><li v-for="crop in catalog.crops" :key="crop.seedId">{{ crop.level }} 级 · {{ crop.name }} · {{ crop.size }} 格 · {{ crop.imageStatus }}</li></ul><p v-for="gap in catalog.evidenceGaps" :key="gap">{{ gap }}</p></details>
    </div>
  </section>
</template>

<style scoped>
.update-card { min-width: 0; padding: 1rem; border: 1px solid #cbd5e1; border-radius: 1rem; background: #fff; color: #1e293b; overflow-wrap: anywhere; }
.update-heading { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: .75rem; }
h2, h3, h4 { font-weight: 700; margin-bottom: .5rem; } p, li { font-size: .875rem; line-height: 1.7; } .update-muted { color: #64748b; }
.update-sections { display: grid; gap: 1.5rem; margin-top: 1.25rem; } .update-sections section { min-width: 0; border-top: 1px solid #e2e8f0; padding-top: 1rem; }
.update-fields, .update-items { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 13rem), 1fr)); gap: .75rem; margin: .75rem 0; }
label { display: grid; gap: .3rem; min-width: 0; font-size: .875rem; } input, select { width: 100%; min-width: 0; max-width: 100%; padding: .6rem; border: 1px solid #94a3b8; border-radius: .5rem; background: inherit; color: inherit; }
.update-items :deep(button) { min-height: 44px; white-space: normal; text-align: start; } .update-row { display: grid; gap: .25rem; padding: .5rem 0; } .update-detail { padding: 1rem; border-radius: .75rem; background: #f1f5f9; }
:global(.dark .update-card) { background: #0f172a; color: #e2e8f0; border-color: #475569; } :global(.dark .update-detail) { background: #1e293b; } :global(.dark .update-muted) { color: #cbd5e1; }
</style>
