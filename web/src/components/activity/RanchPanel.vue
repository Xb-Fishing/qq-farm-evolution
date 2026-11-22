<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, reactive, ref, watch } from 'vue'
import RanchAutomationSettings from '@/components/activity/RanchAutomationSettings.vue'
import ConfirmModal from '@/components/ConfirmModal.vue'
import BaseButton from '@/components/ui/BaseButton.vue'
import { useRanchStore } from '@/stores/ranch'

const props = defineProps<{ accountId: string }>()
const ranch = useRanchStore()
const quantities = reactive<Record<string, string>>({})
const selectedRanch = reactive<Record<string, string>>({})
let retryTimer: ReturnType<typeof setTimeout> | null = null
let retries = 0
let viewGeneration = 0
let friendSequence = 0
const friendOptions = ref<Array<{ gid: string, name: string }>>([])
const selectedFriend = ref('')
const friendLoaded = ref(false)
const friendBusy = ref(false)
const friendError = ref('')
const friendState = ref<{ name: string, host: string, stealCount: number, cleanCount: number } | null>(null)
async function readFriend(gid?: string) {
  const attempt = ++friendSequence
  friendBusy.value = true
  friendError.value = ''
  try {
    const snapshot = await ranch.readFriend(gid)
    if (attempt !== friendSequence || !snapshot)
      return
    if (gid) {
      if (String(snapshot.host) === gid)
        friendState.value = snapshot
    }
    else {
      friendOptions.value = (Array.isArray(snapshot) ? snapshot : []).flatMap(row => {
        const id = String(row?.gid || '')
        return /^[1-9]\d*$/.test(id) && (typeof row.gid !== 'number' || Number.isSafeInteger(row.gid))
          ? [{ gid: id, name: String(row.remark || row.name || id) }]
          : []
      })
      friendLoaded.value = true
    }
  }
  catch (cause: any) {
    if (attempt === friendSequence) {
      if (gid)
        friendState.value = null
      friendError.value = cause?.response?.data?.error || cause?.message || '好友牧场暂不可用'
    }
  }
  finally {
    if (attempt === friendSequence)
      friendBusy.value = false
  }
}
function selectFriend(gid: string) {
  selectedFriend.value = gid
  friendState.value = null
  if (gid)
    void readFriend(gid)
  else {
    friendSequence++
    friendBusy.value = false
  }
}
async function executeQuote() {
  const host = ranch.quote?.intent?.input?.hostGid
  const generation = viewGeneration
  const confirmed = await ranch.execute()
  if (host && confirmed && generation === viewGeneration && selectedFriend.value === host)
    await readFriend(host)
}
function clearRetry() {
  if (retryTimer)
    clearTimeout(retryTimer)
  retryTimer = null
}
async function refresh(view = ranch.view, shop = ranch.shopId) {
  const generation = viewGeneration
  clearRetry()
  const ok = await ranch.refresh(view, shop)
  if (generation !== viewGeneration)
    return
  if (!ok && ['RANCH_FARM_PRIORITY', 'RANCH_BUDGET_BUSY', 'RANCH_BUSY', 'RANCH_SCENE_RECOVERING'].includes(ranch.errorCode) && retries++ < 12)
    retryTimer = setTimeout(() => { void refresh(view, shop) }, 5000)
  else if (ok)
    retries = 0
  return ok
}
watch(() => props.accountId, (id) => {
  viewGeneration++
  clearRetry()
  retries = 0
  ranch.bind(id)
  friendSequence++
  friendOptions.value = []
  selectedFriend.value = ''
  friendState.value = null
  friendLoaded.value = false
  friendBusy.value = false
  friendError.value = ''
  for (const key of Object.keys(quantities)) delete quantities[key]
  for (const key of Object.keys(selectedRanch)) delete selectedRanch[key]
  if (id)
    void refresh('animals')
  if (id)
    void ranch.loadAutomation()
}, { immediate: true, flush: 'sync' })
onBeforeUnmount(() => {
  viewGeneration++
  friendSequence++
  clearRetry()
  ranch.cancel()
})
const feedReview = computed(() => ranch.result?.action === 'addGrass' || !!ranch.result?.reconciliation || ranch.result?.feedOperation === true)
const eggReview = computed(() => ranch.result?.taskSaleReceipt === true)
watch(() => [props.accountId, ranch.result?.id, ranch.uncertain && feedReview.value] as const, ([id, operation, pending], _, onCleanup) => {
  if (!id || !operation || !pending)
    return
  let closed = false
  let timer: ReturnType<typeof setTimeout>
  const delays = [15000, 30000, 60000]
  const schedule = (index: number) => {
    timer = setTimeout(async () => {
      if (closed)
        return
      if (!ranch.operating && !ranch.loading && !ranch.quote)
        await ranch.refresh()
      if (!closed && index + 1 < delays.length)
        schedule(index + 1)
    }, delays[index])
  }
  schedule(0)
  onCleanup(() => {
    closed = true
    clearTimeout(timer)
  })
})
const facilities = computed(() => ranch.state?.facilities || [])
const facilityCards = ref<HTMLElement[]>([])
const estimatedServerTime = ref(0)
watch(() => [ranch.state, ranch.view] as const, ([snapshot, view], _, onCleanup) => {
  const receivedAt = performance.now()
  const serverTime = Number(snapshot?.serverTime) || 0
  estimatedServerTime.value = serverTime
  if (!serverTime || view !== 'animals')
    return
  const lastDeadline = Math.max(0, ...facilities.value.map((row: any) =>
    row.upgrade?.status === 'in_progress' ? Number(row.upgrade.endTimeMs) || 0 : 0))
  if (lastDeadline <= serverTime)
    return
  const timer = setInterval(() => {
    estimatedServerTime.value = serverTime + performance.now() - receivedAt
    if (estimatedServerTime.value >= lastDeadline)
      clearInterval(timer)
  }, 500)
  onCleanup(() => clearInterval(timer))
}, { immediate: true })
function secondsRemaining(upgrade: any) {
  return Math.max(0, Math.ceil((upgrade.endTimeMs - estimatedServerTime.value) / 1000))
}
function costLabel(cost: any) {
  const balance = ranch.state.currencies.find((row: any) => row.id === cost.id)
  const missing = balance ? BigInt(cost.count) - BigInt(balance.available) : 0n
  return `${cost.name} × ${cost.count}${missing > 0n ? `（还差 ${missing}）` : ''}`
}
function taskFacility(task: any) {
  if (!task.upgradeFacilityModuleType || task.claimed || task.canClaim)
    return
  return facilities.value.find((row: any) => row.active && row.moduleType === task.upgradeFacilityModuleType && row.level < task.upgradeFacilityLevel)
}
async function openFacility(task: any) {
  const facilityId = taskFacility(task)?.id
  const generation = viewGeneration
  if (!facilityId || !await refresh('animals'))
    return
  await nextTick()
  if (generation !== viewGeneration || ranch.view !== 'animals')
    return
  const card = facilityCards.value.find(node => node.id === `ranch-facility-${facilityId}`)
  card?.focus({ preventScroll: true })
  card?.scrollIntoView({ block: 'center' })
}
const animals = computed(() => ranch.state?.animals || [])
const producers = computed(() => animals.value.filter((row: any) => row.canProduce).length)
const harvests = computed(() => animals.value.filter((row: any) => row.canHarvest).length + facilities.value.reduce((n: number, row: any) => n + (row.ranch?.shelves?.filter((s: any) => s.canCollect).length || 0), 0))
const hazards = computed(() => facilities.value.reduce((n: number, row: any) => n + (row.ranch?.hazards?.length || 0), 0))
const saleItems = computed(() => (ranch.state?.inventory || []).filter((row: any) => row.canSell === true))
function cap(...values: any[]) {
  try {
    return Number(values.reduce((n: bigint, v) => {
      const next = BigInt(v ?? 0)
      return next < n ? next : n
    }, 999n))
  }
  catch { return 0 }
}
function amount(key: string, fallback = 1) {
  const n = Number(quantities[key] || fallback)
  return Number.isSafeInteger(n) && n > 0 ? n : 0
}
function grassMax(facility: any) {
  return cap(ranch.state.grass, facility.capacity - facility.feed.count)
}
function grassAmount(facility: any) {
  return amount(`grass-${facility.id}`, grassMax(facility))
}
function saleAmount(item: any) {
  return amount(`sell-${item.uid}`, cap(item.count))
}
function priceMax(good: any) {
  if (!good.available || !good.price)
    return 0
  const balance = ranch.state?.currencies?.find((row: any) => row.id === good.price.id)?.available
  try {
    return cap(good.maxCount, good.remaining ?? 999, BigInt(good.price.count) === 0n ? 999 : BigInt(balance || 0) / BigInt(good.price.count))
  }
  catch { return 0 }
}
function choices(cub: any) {
  return facilities.value.filter((row: any) => row.ranch && row.ranch.husbandryType === cub.husbandryType && row.ranch.capacity > row.ranch.count)
}
function ranchId(cub: any) {
  return selectedRanch[cub.id] || choices(cub)[0]?.id || ''
}
function placeMax(cub: any) {
  const room = facilities.value.find((row: any) => row.id === ranchId(cub))?.ranch
  return cub.locked ? 0 : cap(cub.count, room ? room.capacity - room.count : 0, 50)
}
function stage(row: any) {
  return row.canHarvest ? '可收获' : row.canProduce ? '可生产' : row.grassBlocked ? '缺少牧草' : ['未知', '幼崽期', '成长期', '生产期', '成熟期', '可收获'][row.stage] || '成长中'
}
const message = computed(() => {
  const quote = ranch.quote
  if (!quote)
    return ''
  const notSent = quote.notSentMessage ? `操作未发出：${quote.notSentMessage}\n` : ''
  if (ranch.reviewNotice)
    return `${notSent}${ranch.reviewNotice}\n重新核对后会显示最新数量和费用，仍需你确认执行。`
  const costs = quote.costItems?.map((row: any) => `${row.name} × ${row.count}`).join('、') || '无额外物品消耗'
  const rewards = quote.expectedRewards?.map((row: any) => `${row.name} × ${row.count}`).join('、')
  return `${notSent}${quote.renewed ? '已重新核对。\n' : ''}本次 ${quote.count} 项。\n消耗：${costs}${rewards ? `\n预计获得：${rewards}` : ''}\n确认单 60 秒有效。确认后执行一次，结果不明不会自动重试。`
})
defineExpose({ refresh })
</script>

<template>
  <section id="ranch" class="ranch-panel rounded-xl bg-white p-4 shadow-sm dark:bg-gray-800">
    <header class="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h2 class="text-lg font-semibold">
          牧场经营 <span v-if="ranch.state?.level" class="ml-2 text-sm text-emerald-600">Lv.{{ ranch.state.level }}</span>
        </h2>
        <p class="mt-1 text-sm text-gray-500">
          管理动物、补充牧草与领取收益，消耗前会确认数量。
        </p>
      </div>
      <BaseButton :loading="ranch.loading" :disabled="ranch.operating || ranch.acknowledging" @click="refresh()">
        刷新牧场
      </BaseButton>
    </header>
    <RanchAutomationSettings
      :key="accountId" :automation="ranch.automation" :state="ranch.optionState" :shops="ranch.optionShops"
      :loading="ranch.loadingOptions" :policy-error="ranch.error" :options-error="ranch.optionError" :saving="ranch.savingAutomation"
      @load="ranch.loadOptions" @retry-policy="ranch.loadAutomation" @save="ranch.saveAutomation"
    />
    <nav class="my-4 flex flex-wrap gap-2" aria-label="牧场功能">
      <BaseButton v-for="tab in [{ id: 'animals', name: '动物与库存' }, { id: 'shop', name: '幼崽与饲料商店' }, { id: 'tasks', name: '牧场任务' }]" :key="tab.id" :variant="ranch.view === tab.id ? 'primary' : 'secondary'" :disabled="ranch.operating || ranch.preparing || ranch.acknowledging" @click="refresh(tab.id)">
        {{ tab.name }}
      </BaseButton>
    </nav>
    <details class="mb-4 border rounded-lg p-3" @toggle="($event.currentTarget as HTMLDetailsElement).open && !friendLoaded && !friendBusy && readFriend()">
      <summary class="cursor-pointer font-medium">好友牧场</summary>
      <div class="mt-3 flex flex-wrap items-center gap-2">
        <select :value="selectedFriend" class="ranch-select" aria-label="选择好友牧场" :disabled="ranch.operating || ranch.preparing || !!ranch.quote" @change="selectFriend(($event.target as HTMLSelectElement).value)">
          <option value="">选择好友</option>
          <option v-for="row in friendOptions" :key="row.gid" :value="row.gid">{{ row.name }}</option>
        </select>
        <BaseButton variant="secondary" :disabled="friendBusy || ranch.operating || ranch.preparing || !!ranch.quote" @click="readFriend(selectedFriend || undefined)">
          {{ selectedFriend ? '刷新好友牧场' : '刷新好友列表' }}
        </BaseButton>
      </div>
      <p v-if="friendError" role="alert" class="mt-2 text-sm text-amber-700 dark:text-amber-300">{{ friendError }}</p>
      <p v-else-if="friendBusy" role="status" class="mt-2 text-sm text-gray-500">正在读取好友牧场…</p>
      <p v-else-if="friendLoaded && !friendOptions.length" class="mt-2 text-sm text-gray-500">当前账号没有好友。</p>
      <div v-if="friendState" class="mt-2 flex flex-wrap gap-2">
        <BaseButton :disabled="ranch.blocked || friendBusy || !friendState.stealCount" @click="ranch.prepare('stealFriend', { hostGid: friendState.host })">
          偷取产物（{{ friendState.stealCount }} 个货架）
        </BaseButton>
        <BaseButton :disabled="ranch.blocked || friendBusy || !friendState.cleanCount" @click="ranch.prepare('cleanFriend', { hostGid: friendState.host })">
          帮好友清理（{{ friendState.cleanCount }} 处）
        </BaseButton>
      </div>
    </details>
    <p v-if="ranch.error" role="alert" class="mb-3 rounded-lg bg-amber-50 p-3 text-sm text-amber-800 dark:bg-amber-950 dark:text-amber-100">
      {{ ranch.error }}
    </p>
    <p v-if="ranch.loading && !ranch.state" class="p-6 text-center text-sm text-gray-500">
      正在读取牧场状态…
    </p>
    <div v-if="ranch.result" role="status" class="mb-3 rounded-lg bg-slate-100 p-3 text-sm dark:bg-slate-900">
      <strong>{{ ranch.result.outcome === 'confirmed' ? '操作已确认' : feedReview && ranch.uncertain ? '程序正在自动核账' : ranch.result.outcome === 'replanned' ? '已按最新库存恢复巡检' : ranch.result.outcome === 'acknowledged' ? '已核对结果' : ranch.result.outcome === 'not_sent' ? '操作未发出' : '操作结果待核对' }}</strong>
      <p>{{ ranch.result.label }} · {{ ranch.result.message }}</p>
      <dl v-if="ranch.result.reconciliation" class="ranch-audit" aria-label="牧草核账明细">
        <div><dt>{{ ranch.result.action === 'buy' ? '背包入账' : '背包扣草' }}</dt><dd>预计 {{ ranch.result.reconciliation.expectedGrass }} · 实测 {{ ranch.result.reconciliation.observedGrass ?? '未能确定' }}</dd></div>
        <div v-if="ranch.result.action === 'buy'">
          <dt>金券支出</dt><dd>预计 {{ ranch.result.reconciliation.expectedTickets }} · 实测 {{ ranch.result.reconciliation.observedTickets ?? '未能确定' }}</dd>
        </div>
        <div v-else>
          <dt>牧草机净增</dt><dd>预计 {{ ranch.result.reconciliation.expectedMachine }} · 实测 {{ ranch.result.reconciliation.observedMachine ?? '未读到' }}</dd>
        </div>
      </dl>
      <p v-if="ranch.result.completed">
        已确认 {{ ranch.result.completed }} 项
      </p>
      <p v-if="ranch.result.rewards?.length">
        已获得：{{ ranch.result.rewards.map((item: any) => `${item.name} × ${item.count}`).join('、') }}
      </p>
      <div v-if="ranch.uncertain" class="mt-2 flex flex-wrap gap-2">
        <BaseButton :disabled="ranch.operating || ranch.loading || ranch.acknowledging" @click="eggReview ? refresh('tasks') : refresh()">
          {{ eggReview ? '查看任务进度' : feedReview ? '查看最新数量' : '刷新并核对' }}
        </BaseButton>
        <BaseButton v-if="!feedReview && !eggReview" :loading="ranch.acknowledging" :disabled="ranch.operating || ranch.loading || ranch.acknowledging" @click="ranch.acknowledge()">
          已核对，允许继续
        </BaseButton>
      </div>
    </div>
    <p v-if="ranch.state?.sceneRecoveryRequired" class="mb-3 text-sm text-amber-600">
      正在恢复农场，已暂停后续牧场操作。
    </p>
    <template v-if="ranch.state">
      <div class="mb-4 flex flex-wrap gap-3 rounded-lg bg-emerald-50 p-3 text-sm dark:bg-emerald-950">
        <span>牧草库存：<strong>{{ ranch.state.grass }}</strong></span>
        <span v-for="coin in ranch.state.currencies" :key="coin.id">{{ coin.name }}：{{ coin.total }}</span>
      </div>
      <template v-if="ranch.view === 'animals'">
        <div class="mb-4 flex flex-wrap gap-2">
          <BaseButton :disabled="ranch.blocked || !producers" @click="ranch.prepare('produce', { all: true })">
            一键生产（{{ producers }}）
          </BaseButton>
          <BaseButton :disabled="ranch.blocked || !harvests" @click="ranch.prepare('harvest', { all: true })">
            一键收获（{{ harvests }}）
          </BaseButton>
          <BaseButton :disabled="ranch.blocked || !hazards" @click="ranch.prepare('clean')">
            清理牧场（{{ hazards }}）
          </BaseButton>
          <BaseButton :disabled="ranch.blocked || !saleItems.length" @click="ranch.prepare('sell', { all: true })">
            批量出售产物（{{ saleItems.length }} 批）
          </BaseButton>
        </div>
        <details v-if="saleItems.length" class="mb-4 rounded-lg border border-gray-200 p-3 dark:border-gray-700">
          <summary class="cursor-pointer text-sm font-medium">
            按批次出售
          </summary>
          <ul class="mt-2 divide-y divide-gray-100 dark:divide-gray-800">
            <li v-for="item in saleItems" :key="`${item.id}:${item.uid}`" class="flex flex-wrap items-center gap-2 py-2 text-sm">
              <span class="min-w-28 flex-1">{{ item.name }} × {{ item.count }} · {{ item.sellPrices?.map((price: any) => `${price.name}×${price.count}`).join('、') }} / 件</span>
              <input v-model="quantities[`sell-${item.uid}`]" class="ranch-quantity" type="number" min="1" :max="cap(item.count)" :aria-label="`${item.name}出售数量`" :placeholder="String(cap(item.count))">
              <BaseButton :disabled="ranch.blocked || !saleAmount(item) || saleAmount(item) > cap(item.count)" @click="ranch.prepare('sell', { uid: item.uid, itemId: item.id, count: saleAmount(item) })">
                出售 {{ saleAmount(item) }} 件
              </BaseButton>
            </li>
          </ul>
        </details>
        <div class="grid gap-3 lg:grid-cols-2">
          <article v-for="facility in facilities" :id="`ranch-facility-${facility.id}`" :key="facility.id" ref="facilityCards" tabindex="-1" class="min-w-0 border border-gray-200 rounded-lg p-3 dark:border-gray-700">
            <h3 class="font-semibold">
              {{ facility.name }} <span class="text-sm text-gray-500">Lv.{{ facility.level }}</span>
            </h3>
            <div v-if="facility.upgrade" class="my-3 rounded-lg bg-emerald-50 p-3 text-sm dark:bg-emerald-950">
              <template v-if="facility.active && facility.upgrade.nextLevel">
                <p class="font-medium">
                  容量 {{ facility.capacity }} → {{ facility.upgrade.nextCapacity }}
                </p>
                <p v-if="facility.upgrade.status === 'available' || facility.upgrade.status === 'not_available'" class="my-1">
                  牧场 {{ facility.upgrade.requiredLevel }} 级可升 · 耗时 {{ facility.upgrade.durationSec }} 秒
                </p>
                <p v-if="facility.upgrade.canStart && facility.upgrade.costs?.length" class="mb-2">
                  预计消耗 {{ facility.upgrade.costs.map(costLabel).join('、') }}
                </p>
              </template>
              <BaseButton v-if="facility.upgrade.canStart || (facility.active && facility.upgrade.nextLevel && facility.upgrade.status === 'not_available')" :disabled="ranch.blocked || !facility.upgrade.canStart" @click="ranch.prepare('upgrade', { facilityId: facility.id })">
                升级至 {{ facility.upgrade.nextLevel }} 级
              </BaseButton>
              <template v-else-if="facility.upgrade.status === 'in_progress' || facility.upgrade.canComplete">
                <p v-if="facility.upgrade.status === 'in_progress' && secondsRemaining(facility.upgrade) > 0">
                  正在升级至 {{ facility.upgrade.nextLevel }} 级，约剩 {{ secondsRemaining(facility.upgrade) }} 秒
                </p>
                <BaseButton v-else :disabled="ranch.blocked" @click="ranch.prepare('completeUpgrade', { facilityId: facility.id })">
                  完成升级
                </BaseButton>
              </template>
              <p v-if="facility.upgrade.reason && facility.upgrade.status !== 'in_progress'" class="text-gray-600 dark:text-gray-300">
                {{ facility.upgrade.reason }}
              </p>
            </div>
            <template v-if="facility.feed">
              <p class="my-2 text-sm">
                牧草机 {{ facility.feed.count }} / {{ facility.capacity }} · <span v-if="facility.feed.remainingSec != null">剩余约 {{ Math.ceil(Number(facility.feed.remainingSec) / 60) }} 分钟</span><span v-else>当前未提供计时</span>
              </p>
              <div class="flex flex-wrap items-center gap-2">
                <input v-model="quantities[`grass-${facility.id}`]" class="ranch-quantity" type="number" min="1" :max="grassMax(facility)" :aria-label="`${facility.name}补草数量`" :placeholder="String(grassMax(facility))">
                <BaseButton :disabled="ranch.blocked || !grassAmount(facility) || grassAmount(facility) > grassMax(facility)" @click="ranch.prepare('addGrass', { facilityId: facility.id, count: grassAmount(facility) })">
                  补草 {{ grassAmount(facility) }} 份
                </BaseButton>
              </div>
            </template>
            <template v-if="facility.ranch">
              <p class="my-2 text-sm text-gray-500">
                动物 {{ facility.ranch.count }} / {{ facility.ranch.capacity }}
              </p>
              <p v-if="!facility.ranch.animals.length" class="py-3 text-sm text-gray-500">
                栏舍为空，可从背包放养或购买幼崽。
              </p>
              <div v-for="animal in facility.ranch.animals" :key="animal.id" class="flex flex-wrap items-center justify-between gap-2 border-t border-gray-100 py-2 dark:border-gray-700">
                <div><span class="font-medium">{{ animal.name }}</span><span class="ml-2 text-sm text-gray-500">{{ stage(animal) }}</span></div>
                <div class="flex gap-2">
                  <BaseButton v-if="animal.canProduce" :disabled="ranch.blocked" @click="ranch.prepare('produce', { targets: [{ ranchId: facility.id, animalId: animal.id }] })">
                    生产
                  </BaseButton>
                  <BaseButton v-if="animal.canHarvest" :disabled="ranch.blocked" @click="ranch.prepare('harvest', { targets: [{ ranchId: facility.id, animalId: animal.id }] })">
                    收获
                  </BaseButton>
                </div>
              </div>
            </template>
          </article>
        </div>
        <h3 class="mb-2 mt-5 font-semibold">
          背包幼崽
        </h3>
        <p v-if="!ranch.state.cubs.length" class="text-sm text-gray-500">
          暂无幼崽，可到幼崽商店购买。
        </p>
        <div v-for="cub in ranch.state.cubs" :key="cub.uid" class="mb-2 flex flex-wrap items-center gap-2 rounded-lg bg-gray-50 p-3 dark:bg-gray-900">
          <span class="min-w-28 flex-1">{{ cub.name }} × {{ cub.count }} <span v-if="cub.locked" class="text-sm text-amber-600">已锁定</span></span>
          <select :value="ranchId(cub)" class="ranch-select" :aria-label="`${cub.name}放养栏舍`" @change="selectedRanch[cub.id] = ($event.target as HTMLSelectElement).value">
            <option value="">
              {{ choices(cub)[0]?.name || '没有匹配的空位' }}
            </option>
            <option v-for="facility in choices(cub)" :key="facility.id" :value="facility.id">
              {{ facility.name }}（剩余 {{ facility.ranch.capacity - facility.ranch.count }}）
            </option>
          </select>
          <input v-model="quantities[`cub-${cub.id}`]" class="ranch-quantity" type="number" min="1" :max="placeMax(cub)" :aria-label="`${cub.name}放养数量`" placeholder="1">
          <BaseButton :disabled="ranch.blocked || placeMax(cub) < 1" @click="quantities[`cub-${cub.id}`] = String(placeMax(cub))">
            最大
          </BaseButton>
          <BaseButton :disabled="ranch.blocked || !ranchId(cub) || amount(`cub-${cub.id}`) > placeMax(cub)" @click="ranch.prepare('place', { itemId: cub.id, ranchId: ranchId(cub), count: amount(`cub-${cub.id}`) })">
            放养
          </BaseButton>
        </div>
      </template>
      <template v-else-if="ranch.view === 'shop'">
        <div class="mb-3 flex gap-2">
          <BaseButton :disabled="ranch.blocked" @click="refresh('shop', '5')">
            幼崽
          </BaseButton><BaseButton :disabled="ranch.blocked" @click="refresh('shop', '6')">
            饲料
          </BaseButton>
        </div>
        <p v-if="!ranch.state.shop" class="text-sm text-gray-500">
          商店尚未读取，请刷新。
        </p>
        <div class="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          <article v-for="good in ranch.state.shop?.goods || []" :key="good.id" class="min-w-0 border border-gray-200 rounded-lg p-3 dark:border-gray-700">
            <h3 class="font-medium">
              {{ good.reward.name }} × {{ good.reward.count }}
            </h3>
            <p class="my-2 text-sm text-gray-500">
              {{ good.price ? `${good.price.name} × ${good.price.count} / 份` : '价格尚未确认' }} · {{ good.remaining === null ? '未设置限购' : `剩余 ${good.remaining} 份` }}
            </p>
            <div class="flex flex-wrap gap-2">
              <input v-model="quantities[`goods-${good.id}`]" class="ranch-quantity" type="number" min="1" :max="priceMax(good)" :aria-label="`${good.reward.name}购买数量`" placeholder="1">
              <BaseButton :disabled="ranch.blocked || priceMax(good) < 1" @click="quantities[`goods-${good.id}`] = String(priceMax(good))">
                最大
              </BaseButton>
              <BaseButton :disabled="ranch.blocked || amount(`goods-${good.id}`) > priceMax(good)" @click="ranch.prepare('buy', { shopId: ranch.shopId, goodsId: good.id, count: amount(`goods-${good.id}`) })">
                购买
              </BaseButton>
            </div>
            <p v-if="!good.available || priceMax(good) < 1" class="mt-2 text-xs text-gray-500">
              {{ !good.available ? '尚未解锁、已售罄或当前不可购买' : '余额不足' }}
            </p>
          </article>
        </div>
      </template>
      <template v-else-if="ranch.view === 'tasks'">
        <BaseButton class="mb-3" :disabled="ranch.blocked || !ranch.state.tasks?.some((task: any) => task.canClaim)" @click="ranch.prepare('claimTasks', { all: true, double: false })">
          领取全部普通奖励
        </BaseButton>
        <p v-if="ranch.state.tasks?.length === 0" class="text-sm text-gray-500">
          当前没有牧场任务。
        </p>
        <article v-for="task in ranch.state.tasks || []" :key="task.id" class="mb-2 flex flex-wrap items-center justify-between gap-3 rounded-lg bg-gray-50 p-3 dark:bg-gray-900">
          <div class="min-w-0 flex-1">
            <p>{{ task.desc }}</p><p class="mt-1 text-sm text-gray-500">
              {{ task.progress }} / {{ task.total }} · {{ task.claimed ? '已领取' : task.unlocked ? '已解锁' : '未解锁' }}
            </p><p class="text-sm">
              {{ task.rewards.map((row: any) => `${row.name} × ${row.count}`).join('、') }}
            </p>
          </div>
          <BaseButton v-if="taskFacility(task)" :disabled="ranch.loading || ranch.preparing || ranch.operating" @click="openFacility(task)">
            前往{{ taskFacility(task).name }}升级
          </BaseButton>
          <BaseButton v-if="task.id === '300006' && task.desc === '出售鸡蛋' && task.unlocked && !task.claimed && !task.canClaim" :disabled="ranch.blocked || !saleItems.some((row: any) => row.id === '1060001')" @click="ranch.prepare('sell', { taskId: task.id })">
            出售任务所需鸡蛋
          </BaseButton>
          <BaseButton :disabled="ranch.blocked || !task.canClaim" @click="ranch.prepare('claimTasks', { taskId: task.id, double: false })">
            领取
          </BaseButton>
        </article>
      </template>
    </template>
    <p v-if="ranch.preparing" class="mt-3 text-sm text-gray-500" role="status">
      正在核对最新资格和费用…
    </p>
    <p v-if="ranch.operating" class="mt-3 text-sm text-gray-500" role="status">
      正在执行，请等待确认结果…
    </p>
    <ConfirmModal :show="!!ranch.quote" :title="ranch.quote?.label || '确认牧场操作'" :message="message" type="primary" :confirm-text="ranch.reviewNotice ? '重新核对' : '确认执行'" :loading="ranch.preparing" @confirm="executeQuote()" @close="ranch.closeQuote()" @cancel="ranch.closeQuote()" />
  </section>
</template>

<style scoped>
.ranch-panel {
  min-width: 0;
  overflow-wrap: anywhere;
}
.ranch-panel :deep(button),
.ranch-select,
.ranch-quantity {
  min-height: 44px;
}
.ranch-quantity {
  width: 72px;
  max-width: 100%;
  border: 1px solid var(--surface-border, #cbd5e1);
  border-radius: 8px;
  background: transparent;
  padding: 6px 8px;
}
.ranch-select {
  max-width: 100%;
  border: 1px solid var(--surface-border, #cbd5e1);
  border-radius: 8px;
  background: var(--surface-1, transparent);
  padding: 6px 8px;
}
.ranch-audit {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 12rem), 1fr));
  gap: 0.6rem;
  margin: 0.6rem 0;
}
.ranch-audit div {
  padding: 0.55rem 0.7rem;
  border-inline-start: 2px solid var(--theme-primary, #328266);
}
.ranch-audit dt {
  font-size: 0.75rem;
  opacity: 0.78;
}
.ranch-audit dd {
  margin: 0.2rem 0 0;
  font-variant-numeric: tabular-nums;
}
</style>
