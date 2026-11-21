<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import BaseButton from '@/components/ui/BaseButton.vue'

const props = defineProps<{ automation: any, state: any, shops: Record<string, any>, loading: boolean, optionsError: string, saving: boolean, policyError: string }>()
const emit = defineEmits<{ save: [policy: Record<string, any>], retryPolicy: [], load: [shopId: string, force?: boolean] }>()
const draft = ref<Record<string, any>>({})
watch(() => props.automation, (value) => {
  draft.value = value ? { ...value.policy } : {}
}, { immediate: true })
const opened = ref(false)
watch([opened, () => draft.value.shopId], ([open, id]) => {
  if (open && id)
    emit('load', String(id))
})
const cubChoices = computed(() => {
  const choices = new Map<string, { id: string, name: string, type: number, count: bigint, sold: boolean }>()
  for (const cub of props.state?.cubs || []) {
    const row = choices.get(cub.id) || { id: cub.id, name: cub.name, type: cub.husbandryType, count: 0n, sold: false }
    if (!cub.locked)
      row.count += BigInt(cub.count)
    choices.set(row.id, row)
  }
  for (const good of props.shops['5']?.goods || []) {
    if (!good.available || !good.animal || !good.reward)
      continue
    const id = String(good.reward.id)
    const row = choices.get(id) || { id, name: good.reward.name, type: good.animal.husbandry_type === '窝' ? 1 : 2, count: 0n, sold: false }
    row.sold = true
    choices.set(id, row)
  }
  return [...choices.values()].filter(row => row.count > 0n || row.sold)
})
const selectedCub = computed(() => cubChoices.value.find(row => row.id === draft.value.cubId))
const rooms = computed(() => (props.state?.facilities || []).filter((row: any) =>
  row.active && row.ranch && (!selectedCub.value || row.ranch.husbandryType === selectedCub.value.type)))
const catalogue = computed(() => props.shops[draft.value.shopId]?.goods)
const goods = computed(() => (catalogue.value || []).filter((row: any) => row.available && row.price))
const selectedGood = computed(() => goods.value.find((row: any) => row.id === draft.value.goodsId))
const stocking = computed(() => draft.value.stockCoop || draft.value.stockShed)
const manualStockBudget = computed(() => stocking.value && draft.value.stockBudgetMode === 'manual')
function managedRoom(type?: number) {
  if (type === 1 && draft.value.stockCoop)
    return '窝'
  if (type === 2 && draft.value.stockShed)
    return '棚'
  return ''
}
const placeOwner = computed(() => managedRoom(props.automation?.targetTypes?.cubs?.[draft.value.cubId] ?? selectedCub.value?.type))
const buyOwner = computed(() => {
  const itemId = selectedGood.value?.reward?.id
  return managedRoom(props.automation?.targetTypes?.goods?.[draft.value.goodsId] ?? cubChoices.value.find(row => row.id === itemId)?.type)
})
const fixedPlacement = computed(() => draft.value.placeEnabled && !placeOwner.value)
const fixedPurchase = computed(() => draft.value.buyEnabled && !buyOwner.value)
const manualPlacement = computed(() => manualStockBudget.value || fixedPlacement.value)
const manualPurchase = computed(() => (manualStockBudget.value && draft.value.buyMissingCubs) || fixedPurchase.value)
function toggleSmartStock(checked: boolean) {
  draft.value.stockCoop = checked
  draft.value.stockShed = checked
  if (checked)
    draft.value.enabled = true
}
function changeStockBudget(manual: boolean) {
  draft.value.stockBudgetMode = manual ? 'manual' : 'live'
}
function changeCub(id: string) {
  draft.value.cubId = id
  if (!rooms.value.some((row: any) => row.id === draft.value.ranchId))
    draft.value.ranchId = ''
}
function changeShop(id: string) {
  draft.value.shopId = id
  draft.value.goodsId = ''
}
function changeGood(id: string) {
  draft.value.goodsId = id
  if (selectedGood.value)
    draft.value.currencyId = selectedGood.value.price.id
}
const freeActions = [{ key: 'harvest', name: '自动收获' }, { key: 'produce', name: '自动生产' }, { key: 'clean', name: '自动清理' }, { key: 'tasks', name: '领取普通任务奖励' }]
</script>

<template>
  <details class="my-4 border border-gray-200 rounded-lg p-3 dark:border-gray-700" @toggle="opened = ($event.currentTarget as HTMLDetailsElement).open">
    <summary class="cursor-pointer font-medium">
      牧场自动化 · {{ automation?.policy?.enabled ? '已启用' : '未启用' }}
    </summary>
    <form v-if="automation" class="mt-3 text-sm space-y-3" @submit.prevent="emit('save', { ...draft })">
      <label class="flex items-center gap-2"><input v-model="draft.enabled" type="checkbox">启用牧场自动化</label>
      <div class="flex flex-wrap gap-4">
        <label v-for="action in freeActions" :key="action.key" class="flex items-center gap-2"><input v-model="draft[action.key]" type="checkbox">{{ action.name }}</label>
      </div>
      <label class="block">巡检间隔（分钟） <input v-model.number="draft.intervalMinutes" type="number" min="2" max="60" required></label>
      <fieldset class="border rounded p-3 space-y-2">
        <legend>
          <label><input :checked="stocking" type="checkbox" @change="toggleSmartStock(($event.target as HTMLInputElement).checked)">{{ !draft.enabled && !stocking ? '启用牧场自动化并智能补栏' : '智能补栏' }}</label>
        </legend>
        <p v-if="!draft.enabled && !stocking">
          启用并保存后，也会恢复其他已勾选的牧场规则。
        </p>
        <p v-else-if="!draft.enabled">
          牧场自动化已暂停，重新启用后开始补栏。
        </p>
        <p>
          先放养背包里匹配的幼崽，优先最高等级。
          <template v-if="draft.buyMissingCubs">
            库存不足时按空位、余额和限购补购，分轮补满。
          </template>
          <template v-else>
            当前只用库存，余下空位等有幼崽时再补。
          </template>
        </p>
        <p v-if="stocking && (!draft.stockCoop || !draft.stockShed)">
          当前仅管理{{ draft.stockCoop ? '窝' : '棚' }}。
        </p>
        <p v-if="draft.placeEnabled && placeOwner" role="status">
          智能补栏已接管{{ placeOwner }}，该栏舍的指定放养规则暂停。
        </p>
        <p v-if="draft.buyEnabled && buyOwner" role="status">
          智能补栏已接管{{ buyOwner }}，该栏舍的指定幼崽购买规则暂停。
        </p>
        <details>
          <summary class="cursor-pointer">
            调整智能补栏范围与额度
          </summary>
          <div class="mt-2 flex flex-wrap gap-4">
            <label class="flex items-center gap-2"><input v-model="draft.stockCoop" type="checkbox">补齐窝</label>
            <label class="flex items-center gap-2"><input v-model="draft.stockShed" type="checkbox">补齐棚</label>
          </div>
          <label class="flex items-center gap-2"><input v-model="draft.buyMissingCubs" type="checkbox" :disabled="!stocking">库存不足时补购幼崽</label>
          <p>关闭补购后只用库存。栏舍已满、未解锁或状态不明时暂停补齐。</p>
          <label v-if="stocking" class="flex items-center gap-2">
            <input :checked="manualStockBudget" type="checkbox" @change="changeStockBudget(($event.target as HTMLInputElement).checked)">
            手动设置补齐额度
          </label>
        </details>
      </fieldset>
      <fieldset class="border rounded p-3 space-y-2">
        <legend><label><input v-model="draft.grassEnabled" type="checkbox">使用库存自动补草</label></legend>
        <label class="block">每日最多使用 <input v-model.number="draft.grassDailyLimit" type="number" min="0" max="1000000000" required></label>
        <label class="block">至少保留牧草 <input v-model.number="draft.grassReserve" type="number" min="0" max="1000000000" required></label>
      </fieldset>
      <details class="border rounded p-3">
        <summary class="cursor-pointer">
          指定放养与购买规则（可选）
        </summary>
        <p class="my-2">
          固定养某种幼崽或另购饲料时使用。取消对应栏舍的智能补齐后，已启用且配置完整的指定规则恢复。
        </p>
        <fieldset class="border rounded p-3 space-y-2">
          <legend><label><input v-model="draft.placeEnabled" type="checkbox">使用库存自动放养</label></legend>
          <p v-if="placeOwner">
            要在{{ placeOwner }}固定放养此幼崽，请先取消该栏舍的智能补齐。
          </p>
          <label class="block">放养幼崽
            <select :value="draft.cubId" @change="changeCub(($event.target as HTMLSelectElement).value)">
              <option value="">{{ cubChoices.length ? '选择幼崽' : (loading ? '正在读取幼崽…' : state ? '暂无可选幼崽' : '库存尚未读到') }}</option>
              <option v-if="draft.cubId && !selectedCub" :value="draft.cubId">已保存的幼崽（当前不可用）</option>
              <option v-for="cub in cubChoices" :key="cub.id" :value="cub.id">{{ cub.name }} · 可用 {{ cub.count }}{{ cub.count === 0n ? '（补货后放养）' : '' }}</option>
            </select>
          </label>
          <p v-if="state && !cubChoices.some(cub => cub.count > 0n)" class="text-xs">
            背包没有可放养的幼崽。可先选已解锁的商店幼崽，有库存和空位后才会放养。
          </p>
          <label class="block">栏舍
            <select v-model="draft.ranchId">
              <option value="">{{ rooms.length ? '选择栏舍' : state ? '没有匹配的已启用栏舍' : '栏舍尚未读到' }}</option>
              <option v-if="draft.ranchId && !rooms.some((room: any) => room.id === draft.ranchId)" :value="draft.ranchId">已保存的栏舍（当前不可用）</option>
              <option v-for="room in rooms" :key="room.id" :value="room.id">{{ room.name }} · {{ room.ranch.count }}/{{ room.ranch.capacity }}{{ room.ranch.count >= room.ranch.capacity ? '（已满）' : '' }}</option>
            </select>
          </label>
        </fieldset>
        <fieldset class="border rounded p-3 space-y-2">
          <legend><label><input v-model="draft.buyEnabled" type="checkbox">自动购买指定商品</label></legend>
          <label class="block">商店 <select :value="draft.shopId" @change="changeShop(($event.target as HTMLSelectElement).value)"><option value="5">幼崽商店</option><option value="6">饲料商店</option></select></label>
          <label class="block">商品
            <select :value="draft.goodsId" @change="changeGood(($event.target as HTMLSelectElement).value)">
              <option value="">{{ goods.length ? '选择商品' : loading ? '正在读取商品…' : catalogue ? '当前没有可购商品' : '商店尚未读到' }}</option>
              <option v-if="draft.goodsId && !selectedGood" :value="draft.goodsId">已保存的商品（当前不可用）</option>
              <option v-for="good in goods" :key="good.id" :value="good.id">{{ good.reward.name }} · {{ good.price.name }} × {{ good.price.count }}</option>
            </select>
          </label>
          <label class="block">单次购买数量 <input v-model.number="draft.purchaseCount" type="number" min="1" max="99" required></label>
          <p v-if="buyOwner">
            要为{{ buyOwner }}固定购买此幼崽，请先取消该栏舍的智能补齐。
          </p>
        </fieldset>
      </details>
      <fieldset v-if="manualPlacement || manualPurchase" class="border rounded p-3 space-y-2">
        <legend>手动额度</legend>
        <p v-if="fixedPlacement && (!draft.ranchId || !draft.cubId || !draft.cubDailyLimit)">
          指定放养需选定幼崽、栏舍并填写每日上限才会执行。
        </p>
        <p v-if="fixedPurchase && (!draft.goodsId || !draft.currencyDailyLimit)">
          指定购买需选定商品并填写每日上限才会执行。
        </p>
        <template v-if="manualPlacement">
          <label class="block">每日最多放养 <input v-model.number="draft.cubDailyLimit" type="number" :min="manualStockBudget ? 1 : 0" max="1000000000" required></label>
          <label class="block">每种幼崽至少保留 <input v-model.number="draft.cubReserve" type="number" min="0" max="1000000000" required></label>
        </template>
        <template v-if="manualPurchase">
          <label class="block">允许消耗的货币 <select v-model="draft.currencyId"><option v-if="!state?.currencies?.length" :value="draft.currencyId">余额尚未读到</option><option v-for="coin in state?.currencies || []" :key="coin.id" :value="coin.id" :disabled="fixedPurchase && !!selectedGood && coin.id !== selectedGood.price.id">{{ coin.name }} · 可用 {{ coin.available }}</option></select></label>
          <label class="block">每日最多花费 <input v-model.number="draft.currencyDailyLimit" type="number" :min="manualStockBudget && draft.buyMissingCubs ? 1 : 0" max="1000000000" required></label>
          <label class="block">至少保留货币 <input v-model.number="draft.currencyReserve" type="number" min="0" max="1000000000" required></label>
        </template>
        <p v-if="manualStockBudget">
          窝、棚和指定操作共用每日额度。幼崽商店的幼崽使用金券。
        </p>
      </fieldset>
      <div class="flex flex-wrap items-center gap-2">
        <BaseButton type="button" variant="secondary" :loading="loading" @click="emit('load', String(draft.shopId), true)">
          刷新库存和商店
        </BaseButton>
        <span v-if="optionsError" role="alert">{{ optionsError }}</span>
      </div>
      <p>每日额度按北京时间零点重置。未知结果仍暂停，不会因换日重试。</p>
      <BaseButton type="submit" :loading="saving">
        保存牧场自动化
      </BaseButton>
    </form>
    <p v-else-if="policyError && !saving" role="alert" class="mt-3 text-sm">
      {{ policyError }} <BaseButton variant="secondary" @click="emit('retryPolicy')">
        重新读取自动化设置
      </BaseButton>
    </p>
    <p v-else class="mt-3 text-sm">
      正在读取该账号的自动化设置。
    </p>
  </details>
</template>

<style scoped>
input[type='number'],
select {
  min-height: 40px;
  max-width: 100%;
  padding: 4px 8px;
  border: 1px solid #94a3b8;
  border-radius: 6px;
  background: transparent;
}
input[type='number'] {
  width: 110px;
}
</style>
