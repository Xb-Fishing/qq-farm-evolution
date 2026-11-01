<script setup lang="ts">
import type { AutomationConfig } from '@/stores/setting'
import { computed, ref } from 'vue'
import BaseButton from '@/components/ui/BaseButton.vue'
import BaseInput from '@/components/ui/BaseInput.vue'
import BaseSwitch from '@/components/ui/BaseSwitch.vue'

const automation = defineModel<AutomationConfig>('automation', { required: true })
const advancedOpen = ref(false)
const seeds = [
  { id: 20525, name: '森野甜莓种子' },
  { id: 20526, name: '森野白桃种子' },
  { id: 20527, name: '森野甜橙种子' },
  { id: 20528, name: '森野红柚种子' },
  { id: 20529, name: '森野芭乐种子' },
  { id: 21435, name: '森野柿子种子' },
  { id: 20021, name: '森野可可豆种子' },
  { id: 29005, name: '森野黄金芽种子' },
]
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
  automation.value.milk_tea_seed_policy = { ...policy.value, targetSeedIds: policy.value.targetSeedIds.length ? [...policy.value.targetSeedIds] : seeds.map(seed => seed.id) }
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
        未选择目标时不购买。以下是已登记的本期种子；执行前重新核对商城在售、奖励、价格与资格，不代表当前都有货。
      </p>
      <div class="grid grid-cols-1 min-w-0 gap-2 sm:grid-cols-2 xl:grid-cols-4">
        <BaseSwitch v-for="seed in seeds" :key="seed.id" class="min-h-11 min-w-0 rounded-lg bg-white px-2 dark:bg-gray-800" :model-value="policy.targetSeedIds.includes(seed.id)" :label="seed.name" @update:model-value="toggleTarget(seed.id, $event === true)" />
      </div>
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
