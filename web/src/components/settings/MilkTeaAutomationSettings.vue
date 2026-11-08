<script setup lang="ts">
import type { AutomationConfig } from '@/stores/setting'
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import api from '@/api'
import BaseButton from '@/components/ui/BaseButton.vue'
import BaseInput from '@/components/ui/BaseInput.vue'
import BaseSwitch from '@/components/ui/BaseSwitch.vue'

const automation = defineModel<AutomationConfig>('automation', { required: true })
const advancedOpen = ref(false)
const props = withDefaults(defineProps<{ accountId?: string | number | null, templateMode?: boolean }>(), { templateMode: false })
type Seed = { id: number, name: string, requiredLevel?: number, image?: string }
const catalog = ref<Seed[]>([])
const shop = ref<any>(null)
const catalogLoading = ref(false)
const catalogError = ref('')
const shopError = ref('')
const seedSearch = ref('')
let seedGeneration = 0
let seedAlive = true
const positive = (value: unknown) => /^(?:[1-9]\d*)$/.test(String(value))
function seedOption(seed: Seed) {
  if (props.templateMode) return { ...seed, eligible: true, reason: '默认方案目标；执行时按实际账号的商城资格复核' }
  if (catalogLoading.value) return { ...seed, eligible: false, reason: '正在读取商城资格' }
  if (!shop.value) return { ...seed, eligible: false, reason: shopError.value || '尚未取得当前账号商城状态' }
  if (shop.value.timing?.phase !== 'open') return { ...seed, eligible: false, reason: '当前不在奶茶营业期，暂停购种' }
  const offers = (shop.value.exchangeShop?.items || []).filter((goods: any) => Array.isArray(goods.rewards)
    && goods.rewards.length === 1 && Number(goods.rewards[0].id) === seed.id && positive(goods.rewards[0].count))
  if (!offers.length) return { ...seed, eligible: false, reason: '当前奶茶商城未上架' }
  let reason = '商城条件或限购状态待确认'
  for (const goods of offers) {
    if (goods.automaticPurchaseDataComplete !== true || goods.purchaseLimitKnown !== true || goods.purchasedCountKnown !== true
      || !Number.isSafeInteger(goods.purchaseLimit) || goods.purchaseLimit < 0 || !Number.isSafeInteger(goods.purchasedCount) || goods.purchasedCount < 0
      || !Array.isArray(goods.condHints)) continue
    const unmet = goods.condHints.find((hint: any) => hint.satisfied !== true)
    if (unmet) {
      reason = String(unmet.params || '').includes('奶茶店等级') && positive(unmet.target)
        ? `需奶茶店 ${unmet.target} 级（当前 ${unmet.current ?? '待确认'} 级）` : '尚未满足商城解锁条件'
      continue
    }
    if (goods.purchaseLimit > 0 && goods.purchasedCount >= goods.purchaseLimit) { reason = '当前商品限购已用尽'; continue }
    if (Number(goods.diamondCostCount) > 0 || !Array.isArray(goods.costs) || !goods.costs.length
      || goods.costs.some((cost: any) => ![1001, 1041].includes(Number(cost.id)) || !positive(cost.count))) { reason = '费用未知或不支持自动支付'; continue }
    return { ...seed, eligible: true, reason: '已满足当前商城解锁条件；保存后仍按预算购买' }
  }
  return { ...seed, eligible: false, reason }
}
const seeds = computed(() => {
  const rows = new Map(catalog.value.map(seed => [seed.id, seed]))
  for (const id of policy.value.targetSeedIds) if (!rows.has(id)) rows.set(id, { id, name: '已保存种子（目录未读取）' })
  return [...rows.values()].map(seedOption).sort((a, b) => Number(policy.value.targetSeedIds.includes(b.id)) - Number(policy.value.targetSeedIds.includes(a.id))
    || Number(b.eligible) - Number(a.eligible) || a.id - b.id)
})
const visibleSeeds = computed(() => seeds.value.filter(seed => seed.name.includes(seedSearch.value.trim())))
async function refreshSeeds() {
  const turn = ++seedGeneration
  if (automation.value.milk_tea_auto_seeds !== true) { catalogLoading.value = false; shop.value = null; return }
  const account = String(props.accountId || '')
  catalogLoading.value = true; catalogError.value = ''; shopError.value = ''; shop.value = null
  const current = () => seedAlive && turn === seedGeneration && account === String(props.accountId || '')
  try {
    const { data } = await api.get('/api/activity/milk-tea/seed-catalog')
    if (!current()) return
    if (data?.ok !== true || !Array.isArray(data.seeds)) throw new Error('种子目录读取失败')
    catalog.value = data.seeds.filter((seed: Seed) => Number.isSafeInteger(seed.id) && seed.id > 0 && typeof seed.name === 'string')
    if (!props.templateMode) {
      if (!account || account === 'default-plan') { shopError.value = '请选择真实账号后查询商城资格'; return }
      try {
        const response = await api.get('/api/activity/milk-tea', { headers: { 'x-account-id': account } })
        if (!current()) return
        if (response.data?.ok !== true || !response.data.activity) throw new Error(response.data?.error || '当前商城读取失败')
        shop.value = response.data.activity
      }
      catch (error: any) { if (current()) shopError.value = error.message || '当前商城读取失败' }
    }
  }
  catch (error: any) { if (current()) { catalogError.value = error.message || '种子目录读取失败' } }
  finally { if (current()) catalogLoading.value = false }
}
watch([() => props.accountId, () => props.templateMode, () => automation.value.milk_tea_auto_seeds], () => { void refreshSeeds() }, { immediate: true })
onBeforeUnmount(() => { seedAlive = false; ++seedGeneration })
const interactions = [
  { value: 1, label: '宣传推广（推荐）' },
  { value: 2, label: '花式摇杯' },
  { value: 3, label: '招牌试饮' },
  { value: 4, label: '划水摸鱼' },
  { value: 5, label: '申请涨薪' },
]
const policy = computed(() => {
  const value = automation.value.milk_tea_seed_policy
  if (!value) {
    return { targetSeedIds: [] as number[], targetStock: 24, coinReserve: '1000000', coinDailyLimit: '240000', ticketReserve: '8000', ticketDailyLimit: '0' }
  }
  return {
    targetSeedIds: Array.isArray(value.targetSeedIds) ? value.targetSeedIds : [],
    targetStock: value.targetStock ?? Number.NaN,
    coinReserve: typeof value.coinReserve === 'string' ? value.coinReserve : '',
    coinDailyLimit: typeof value.coinDailyLimit === 'string' ? value.coinDailyLimit : '',
    ticketReserve: typeof value.ticketReserve === 'string' ? value.ticketReserve : '',
    ticketDailyLimit: typeof value.ticketDailyLimit === 'string' ? value.ticketDailyLimit : '',
  }
})
function updatePolicy(key: string, value: unknown) {
  automation.value.milk_tea_seed_policy = { ...policy.value, [key]: value }
}
function toggleTarget(id: number, checked: boolean) {
  const selected = new Set(policy.value.targetSeedIds)
  if (checked && !seeds.value.find(seed => seed.id === id)?.eligible) return
  if (checked)
    selected.add(id)
  else selected.delete(id)
  updatePolicy('targetSeedIds', [...selected])
}
const hirePolicy = computed(() => {
  const value = automation.value.milk_tea_hire_policy
  return value == null
    ? { durationId: 1, ticketDailyLimit: '480', ticketReserve: '8000' }
    : { durationId: value.durationId ?? Number.NaN, ticketDailyLimit: value.ticketDailyLimit ?? '', ticketReserve: value.ticketReserve ?? '' }
})
function updateHire(key: string, value: unknown) {
  automation.value.milk_tea_hire_policy = { ...hirePolicy.value, [key]: value }
}
function recommend() {
  automation.value.milk_tea_auto_rewards = true
  automation.value.milk_tea_auto_seeds = true
  automation.value.milk_tea_auto_work = true
  automation.value.milk_tea_auto_upgrade = true
  automation.value.milk_tea_auto_craft = true
  automation.value.milk_tea_auto_hire = true
  automation.value.milk_tea_auto_open = true
  automation.value.milk_tea_seed_policy = { ...policy.value, targetSeedIds: policy.value.targetSeedIds.length ? [...policy.value.targetSeedIds] : [] }
  automation.value.milk_tea_hire_policy = { ...hirePolicy.value }
}
const hireInvalid = computed(() => ![1, 2, 3].includes(hirePolicy.value.durationId)
  || [hirePolicy.value.ticketDailyLimit, hirePolicy.value.ticketReserve].some(value => !/^(?:0|[1-9]\d{0,19})$/.test(String(value))))
const amountFields = [
  { key: 'coinReserve', label: '金币保留量' },
  { key: 'coinDailyLimit', label: '金币每日上限' },
  { key: 'ticketReserve', label: '奶茶券保留量' },
  { key: 'ticketDailyLimit', label: '奶茶券每日上限' },
] as const
const invalid = computed(() => !Number.isSafeInteger(policy.value.targetStock) || policy.value.targetStock < 0 || policy.value.targetStock > 9999
  || amountFields.some(field => !/^(?:0|[1-9]\d{0,19})$/.test(String(policy.value[field.key]))))
</script>

<template>
  <section class="min-w-0 border border-orange-200 rounded-xl bg-orange-50/60 p-4 space-y-4 dark:border-orange-800 dark:bg-orange-900/10" aria-label="奶茶活动自动化">
    <div class="space-y-1">
      <h3 class="text-base text-gray-900 font-semibold dark:text-gray-100">
        奶茶活动自动化
      </h3>
      <p class="text-sm text-gray-600 dark:text-gray-300">
        独立开关默认关闭，保存后生效。约每 15 分钟或已知节点复核；每轮最多 3 次操作，公平轮转，让位于成熟收获与好友抢收。
      </p>
    </div>
    <BaseButton variant="secondary" class="min-h-11" @click="recommend">
      推荐全自动（保留目标与额度）
    </BaseButton>
    <p class="text-sm text-gray-600 dark:text-gray-300">
      推荐配置只修改当前表单，保存后生效；保留已有目标和自定义预算。开启收益领取、补货、制作、雇佣、工作、升级与免费开店；宣传喇叭另行选择。
    </p>
    <div class="grid grid-cols-1 gap-2 md:grid-cols-3">
      <BaseSwitch v-model="automation.milk_tea_auto_work" class="min-h-11" label="自动班次工作（互动与工资）" />
      <BaseSwitch v-model="automation.milk_tea_auto_upgrade" class="min-h-11" label="自动升级店铺" />
      <BaseSwitch v-model="automation.milk_tea_auto_seeds" class="min-h-11" label="自动购买活动种子" />
      <BaseSwitch v-model="automation.milk_tea_auto_craft" class="min-h-11" label="自动制作奶茶（整组果实）" />
      <BaseSwitch v-model="automation.milk_tea_auto_hire" class="min-h-11" label="自动雇佣员工" />
      <BaseSwitch v-model="automation.milk_tea_auto_open" class="min-h-11" label="自动免费开店" />
      <BaseSwitch v-model="automation.milk_tea_auto_boost" class="min-h-11" label="自动使用现有宣传喇叭" />
    </div>
    <p class="text-sm text-gray-600 dark:text-gray-300">
      工作处理被雇佣的已有班次，每班互动一次并领取工资；雇佣开关为自己的店铺补员工，每轮一人。制作消耗每条所选果实的整组库存，最多 100 组，实际杯数以游戏结果为准。不会购买喇叭或花钻石。
    </p>
    <p v-if="automation.milk_tea_auto_open || automation.milk_tea_auto_rewards" class="text-sm text-gray-600 dark:text-gray-300">
      免费开店仅在确认未开业时使用“奶茶小店”，保留已有店名。已解锁且达标的免费基金随自动领奖处理，不会购买基金。
    </p>
    <p v-if="automation.milk_tea_auto_boost" class="text-sm text-gray-600 dark:text-gray-300">
      喇叭按当前库存与可用杯数计算有用量，每次最多 100 个；只用现有库存，不购买。结果未知时等待库存对账，不重复消耗。
    </p>
    <button type="button" class="min-h-11 rounded-lg px-2 text-sm text-orange-800 underline dark:text-orange-200 focus-visible:outline-2" :aria-expanded="advancedOpen" @click="advancedOpen = !advancedOpen">
      {{ advancedOpen ? '收起高级预算' : '展开高级预算' }}
    </button>
    <div v-if="automation.milk_tea_auto_hire" class="min-w-0 space-y-3">
      <p class="text-sm text-gray-600 dark:text-gray-300">
        雇佣独立预算：奶茶券保留 {{ hirePolicy.ticketReserve }}，每日最多 {{ hirePolicy.ticketDailyLimit }}。与购种的奶茶券预算分别保存，未确认的费用持续预留。
      </p>
      <div v-if="advancedOpen" class="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <label class="min-w-0 text-sm space-y-2"><span>雇佣班次</span>
          <select class="base-input min-h-11 w-full border border-gray-200 rounded-lg bg-white px-3 text-sm dark:border-gray-700 dark:bg-gray-800" :value="hirePolicy.durationId" @change="updateHire('durationId', Number(($event.target as HTMLSelectElement).value))">
            <option :value="1">4 小时 · 40 券（推荐）</option><option :value="2">12 小时 · 130 券</option><option :value="3">24 小时 · 270 券</option>
          </select>
        </label>
        <label class="min-w-0 text-sm space-y-2"><span>雇佣每日上限（奶茶券）</span><BaseInput :model-value="hirePolicy.ticketDailyLimit" inputmode="numeric" @update:model-value="updateHire('ticketDailyLimit', String($event))" /></label>
        <label class="min-w-0 text-sm space-y-2"><span>雇佣保留量（奶茶券）</span><BaseInput :model-value="hirePolicy.ticketReserve" inputmode="numeric" @update:model-value="updateHire('ticketReserve', String($event))" /></label>
      </div>
      <p v-if="hireInvalid" role="alert" class="text-sm text-red-700 dark:text-red-300">请填写有效班次和非负整数雇佣预算后保存。</p>
    </div>
    <label v-if="automation.milk_tea_auto_work" class="block max-w-sm text-sm text-gray-700 space-y-2 dark:text-gray-300">
      <span>互动方式</span>
      <select class="base-input min-h-11 w-full border border-gray-200 rounded-lg bg-white px-3 text-sm dark:border-gray-700 dark:bg-gray-800" aria-label="互动方式" :value="automation.milk_tea_work_interaction_type ?? 1" @change="automation.milk_tea_work_interaction_type = Number(($event.target as HTMLSelectElement).value)">
        <option v-for="option in interactions" :key="option.value" :value="option.value">{{ option.label }}</option>
      </select>
      <span class="block text-xs">仅执行当前班次明确提供的所选互动；缺少选项时跳过。</span>
    </label>
    <div v-if="automation.milk_tea_auto_seeds" class="min-w-0 space-y-3">
      <h4 class="text-sm text-gray-900 font-semibold dark:text-gray-100">
        购买目标
      </h4>
      <p class="text-sm text-gray-600 dark:text-gray-300">
        未选择目标时不购买。完整种子目录均可查看；当前账号按奶茶商城在售与解锁条件选择，执行前再次核对奖励、价格、限购与预算。
      </p>
      <p v-if="templateMode" class="text-sm text-gray-600 dark:text-gray-300">默认方案不绑定当前账号等级；可预设完整目录中的目标，实际账号运行时仍须满足奶茶商城上架、等级与预算条件。</p>
      <p v-else class="text-sm text-gray-600 dark:text-gray-300">当前奶茶店等级：{{ shop?.summary?.level ?? '待确认' }}。等级以奶茶商城商品的实际要求为准。</p>
      <div class="flex flex-wrap items-center gap-2">
        <input v-model="seedSearch" type="search" class="base-input min-h-11 min-w-0 flex-1 rounded-lg px-3 text-sm" placeholder="搜索种子，例如经验蘑菇" aria-label="搜索购种目标">
        <BaseButton variant="secondary" :disabled="catalogLoading" @click="refreshSeeds">{{ catalogLoading ? '正在查询种子资格' : '刷新种子资格' }}</BaseButton>
      </div>
      <p v-if="catalogError || shopError" role="alert" class="text-sm text-orange-700 dark:text-orange-300">{{ catalogError || shopError }}</p>
      <div class="grid max-h-96 grid-cols-1 min-w-0 gap-2 overflow-y-auto sm:grid-cols-2 xl:grid-cols-3" aria-label="完整购种目录">
        <label v-for="seed in visibleSeeds" :key="seed.id" class="flex min-h-14 min-w-0 items-start gap-2 rounded-lg bg-white p-2 text-sm dark:bg-gray-800">
          <input type="checkbox" class="mt-1 shrink-0" :aria-label="seed.name" :checked="policy.targetSeedIds.includes(seed.id)" :disabled="!policy.targetSeedIds.includes(seed.id) && !seed.eligible" @change="toggleTarget(seed.id, ($event.target as HTMLInputElement).checked)">
          <span class="min-w-0 break-words"><span class="block font-medium">{{ seed.name }}</span><span class="block text-xs text-gray-500 dark:text-gray-400">{{ seed.reason }}</span></span>
        </label>
      </div>
      <p v-if="!catalogLoading && !visibleSeeds.length" class="text-sm text-gray-500">{{ seedSearch ? '没有匹配的种子' : '尚未取得种子目录，请刷新重试' }}</p>
      <label class="block max-w-xs text-sm text-gray-700 space-y-2 dark:text-gray-300">
        <span>每种种子库存目标（颗）</span>
        <BaseInput :model-value="policy.targetStock" type="number" min="0" max="9999" @update:model-value="updatePolicy('targetStock', $event === '' ? -1 : Number($event))" />
      </label>
      <p class="text-sm text-gray-600 dark:text-gray-300">
        每轮最多购买一批，以库存缺口、限购、余额与预算中最小值为准。当前金币保留 {{ policy.coinReserve }}、每日上限 {{ policy.coinDailyLimit }}；购种奶茶券保留 {{ policy.ticketReserve }}、每日上限 {{ policy.ticketDailyLimit }}。
      </p>
      <div v-if="advancedOpen" class="grid grid-cols-1 min-w-0 gap-4 sm:grid-cols-2">
        <label v-for="field in amountFields" :key="field.key" class="min-w-0 text-sm text-gray-700 space-y-2 dark:text-gray-300">
          <span>{{ field.label }}</span>
          <BaseInput :model-value="policy[field.key]" inputmode="numeric" @update:model-value="updatePolicy(field.key, String($event))" />
        </label>
      </div>
      <p v-if="invalid" role="alert" class="text-sm text-red-700 dark:text-red-300">
        库存目标须为 0–9999 的整数，预算须为非负整数；请修正后保存。
      </p>
      <p class="text-sm text-gray-600 dark:text-gray-300">
        仅允许金币与奶茶券；未知费用、资格或限购信息时暂停购买。结果未知的购买持续占用预算，跨日或修改目标也不会重发。关闭开关可停止后续动作，已发送的结果仍会结算。
      </p>
    </div>
  </section>
</template>
