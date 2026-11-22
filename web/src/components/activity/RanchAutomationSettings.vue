<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import BaseButton from '@/components/ui/BaseButton.vue'

const props = defineProps<{ automation: any, state: any, shops: Record<string, any>, loading: boolean, optionsError: string, saving: boolean, policyError: string }>()
const emit = defineEmits<{ save: [policy: Record<string, any>], retryPolicy: [], load: [shopId: string, force?: boolean] }>()
const draft = ref<Record<string, any>>({})
watch(() => props.automation, (value) => {
  draft.value = value ? { ...value.policy, smartFeed: value.policy.smartFeed === true } : {}
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
const feedPurchaseOwned = computed(() => draft.value.smartFeed
  && draft.value.shopId === '6' && draft.value.goodsId === '10001')
const fixedPurchase = computed(() => draft.value.buyEnabled && !buyOwner.value && !feedPurchaseOwned.value)
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
function save() {
  const policy = { ...draft.value }
  if (feedPurchaseOwned.value && (!Number.isInteger(policy.purchaseCount) || policy.purchaseCount < 1 || policy.purchaseCount > 99))
    policy.purchaseCount = props.automation?.policy?.purchaseCount ?? 1
  emit('save', policy)
}
function revealInvalidField(event: Event) {
  const group = (event.target as HTMLElement).closest('details')
  if (group)
    group.open = true
}
const routineActions = [
  { key: 'harvest', name: '自动收获' },
  { key: 'produce', name: '自动生产' },
  { key: 'clean', name: '自动清理' },
  { key: 'tasks', name: '领取普通任务奖励' },
  { key: 'eggSale', name: '自动出售鸡蛋完成任务（只卖还差的数量）' },
  { key: 'sellProducts', name: '自动出售剩余可售产物' },
  { key: 'friendSteal', name: '自动偷取好友牧场产物' },
  { key: 'friendClean', name: '自动帮好友清理牧场' },
]
</script>

<template>
  <details class="ranch-automation" @toggle="opened = ($event.currentTarget as HTMLDetailsElement).open">
    <summary class="automation-heading">
      <span aria-hidden="true" class="automation-icon"><span class="i-carbon-settings-adjust" /></span>
      <span class="automation-title">牧场自动化</span>
      <span v-if="automation" class="automation-status" :class="{ 'is-on': automation.policy.enabled }">
        {{ automation.policy.enabled ? '已启用' : '未启用' }}
      </span>
      <span aria-hidden="true" class="automation-chevron i-carbon-chevron-down" />
    </summary>

    <form v-if="automation" class="automation-form" @invalid.capture="revealInvalidField" @submit.prevent="save">
      <div class="automation-master">
        <label class="automation-control">
          <input v-model="draft.enabled" class="automation-switch" type="checkbox" role="switch">
          <span>启用牧场自动化</span>
        </label>
        <label class="automation-interval">
          <span>巡检间隔</span>
          <input v-model.number="draft.intervalMinutes" type="number" min="2" max="60" required>
          <span class="automation-unit">分钟</span>
        </label>
      </div>

      <div class="automation-cards">
        <section class="automation-card automation-stock-card" aria-label="智能补栏">
          <div class="automation-card-heading">
            <span class="automation-icon" aria-hidden="true"><span class="i-carbon-agriculture-analytics" /></span>
            <label class="automation-control automation-card-toggle">
              <input
                :checked="stocking" class="automation-switch" type="checkbox" role="switch"
                @change="toggleSmartStock(($event.target as HTMLInputElement).checked)"
              >
              <span>智能补栏</span>
            </label>
          </div>
          <p class="automation-card-copy">
            先放养背包里匹配的幼崽，优先最高等级。{{ draft.buyMissingCubs ? '库存不足时按空位、余额和限购补购。' : '当前只用库存。' }}
          </p>
          <p v-if="!draft.enabled && !stocking" class="automation-note">
            开启补栏时会同时启用牧场自动化。
          </p>
          <p v-if="stocking && (!draft.stockCoop || !draft.stockShed)" class="automation-note">
            当前仅管理{{ draft.stockCoop ? '窝' : '棚' }}。
          </p>
          <div v-if="(draft.placeEnabled && placeOwner) || (draft.buyEnabled && buyOwner)" class="automation-notice" role="status">
            <p v-if="draft.placeEnabled && placeOwner">
              智能补栏已接管{{ placeOwner }}，指定放养规则暂停。
            </p>
            <p v-if="draft.buyEnabled && buyOwner">
              智能补栏已接管{{ buyOwner }}，指定幼崽购买规则暂停。
            </p>
          </div>
          <details class="automation-disclosure automation-stock-options">
            <summary>
              <span>调整补栏范围与额度</span><span aria-hidden="true" class="automation-chevron i-carbon-chevron-down" />
            </summary>
            <div class="automation-disclosure-content">
              <div class="automation-grid">
                <label class="automation-control"><input v-model="draft.stockCoop" type="checkbox"><span>补齐窝</span></label>
                <label class="automation-control"><input v-model="draft.stockShed" type="checkbox"><span>补齐棚</span></label>
              </div>
              <label class="automation-control"><input v-model="draft.buyMissingCubs" type="checkbox" :disabled="!stocking"><span>库存不足时补购幼崽</span></label>
              <label v-if="stocking" class="automation-control">
                <input :checked="manualStockBudget" type="checkbox" @change="changeStockBudget(($event.target as HTMLInputElement).checked)">
                <span>手动设置补齐额度</span>
              </label>
              <p class="automation-note">
                栏舍已满、未解锁或状态不明时暂停补齐。
              </p>
            </div>
          </details>
        </section>

        <section class="automation-card automation-feed-card" aria-label="智能供草">
          <div class="automation-card-heading">
            <span class="automation-icon" aria-hidden="true"><span class="i-carbon-sprout" /></span>
            <label class="automation-control automation-card-toggle">
              <input v-model="draft.smartFeed" class="automation-switch" type="checkbox" role="switch" name="smartFeed">
              <span>智能供草</span>
            </label>
          </div>
          <p class="automation-card-copy">
            按动物占栏比例计算牧草目标储备。有缺口时先用库存，库存不足再用金券补购，无需填写预算。
          </p>
          <p v-if="draft.smartFeed" class="automation-notice" role="status">
            库存补草规则暂停，指定购买牧草也会暂停。关闭智能供草可恢复已启用且配置完整的规则。
          </p>
          <p v-if="draft.smartFeed && !draft.enabled" class="automation-note">
            启用牧场自动化后才会供草。
          </p>
          <details class="automation-disclosure automation-grass-rules">
            <summary>
              <span>库存补草规则</span><span aria-hidden="true" class="automation-chevron i-carbon-chevron-down" />
            </summary>
            <div class="automation-disclosure-content">
              <label class="automation-control">
                <input v-model="draft.grassEnabled" type="checkbox"><span>使用库存自动补草</span>
              </label>
              <div class="automation-grid">
                <label class="automation-field"><span>每日最多使用</span><input v-model.number="draft.grassDailyLimit" type="number" min="0" max="1000000000" :required="draft.grassEnabled && !draft.smartFeed"></label>
                <label class="automation-field"><span>至少保留牧草</span><input v-model.number="draft.grassReserve" type="number" min="0" max="1000000000" :required="draft.grassEnabled && !draft.smartFeed"></label>
              </div>
            </div>
          </details>
        </section>
      </div>

      <fieldset class="automation-routine">
        <legend>日常管理</legend>
        <div class="automation-routine-grid">
          <label v-for="action in routineActions" :key="action.key" class="automation-control">
            <input v-model="draft[action.key]" type="checkbox"><span>{{ action.name }}</span>
          </label>
        </div>
        <p v-if="draft.sellProducts" class="automation-note">
          收获后优先出售未锁定、售价已确认的产物，并为进行中的鸡蛋任务留出需要的数量。
        </p>
        <p v-if="draft.friendSteal || draft.friendClean" class="automation-note">
          每轮巡查一位好友，沿用好友黑名单和静默时段。
        </p>
      </fieldset>

      <div class="automation-rule-list">
        <details class="automation-disclosure automation-fixed-rules">
          <summary>
            <span>指定放养与购买规则</span><span aria-hidden="true" class="automation-chevron i-carbon-chevron-down" />
          </summary>
          <div class="automation-disclosure-content automation-config-grid">
            <fieldset class="automation-rule">
              <legend>指定放养</legend>
              <label class="automation-control"><input v-model="draft.placeEnabled" type="checkbox"><span>使用库存自动放养</span></label>
              <label class="automation-field"><span>放养幼崽</span>
                <select :value="draft.cubId" @change="changeCub(($event.target as HTMLSelectElement).value)">
                  <option value="">{{ cubChoices.length ? '选择幼崽' : (loading ? '正在读取幼崽…' : state ? '暂无可选幼崽' : '库存尚未读到') }}</option>
                  <option v-if="draft.cubId && !selectedCub" :value="draft.cubId">已保存的幼崽（当前不可用）</option>
                  <option v-for="cub in cubChoices" :key="cub.id" :value="cub.id">{{ cub.name }} · 可用 {{ cub.count }}{{ cub.count === 0n ? '（补货后放养）' : '' }}</option>
                </select>
              </label>
              <p v-if="state && !cubChoices.some(cub => cub.count > 0n)" class="automation-note">
                可先选商店幼崽，有库存和空位后才会放养。
              </p>
              <label class="automation-field"><span>栏舍</span>
                <select v-model="draft.ranchId">
                  <option value="">{{ rooms.length ? '选择栏舍' : state ? '没有匹配的已启用栏舍' : '栏舍尚未读到' }}</option>
                  <option v-if="draft.ranchId && !rooms.some((room: any) => room.id === draft.ranchId)" :value="draft.ranchId">已保存的栏舍（当前不可用）</option>
                  <option v-for="room in rooms" :key="room.id" :value="room.id">{{ room.name }} · {{ room.ranch.count }}/{{ room.ranch.capacity }}{{ room.ranch.count >= room.ranch.capacity ? '（已满）' : '' }}</option>
                </select>
              </label>
            </fieldset>
            <fieldset class="automation-rule">
              <legend>指定购买</legend>
              <label class="automation-control"><input v-model="draft.buyEnabled" type="checkbox"><span>自动购买指定商品</span></label>
              <label class="automation-field"><span>商店</span><select :value="draft.shopId" @change="changeShop(($event.target as HTMLSelectElement).value)"><option value="5">幼崽商店</option><option value="6">饲料商店</option></select></label>
              <label class="automation-field"><span>商品</span>
                <select :value="draft.goodsId" @change="changeGood(($event.target as HTMLSelectElement).value)">
                  <option value="">{{ goods.length ? '选择商品' : loading ? '正在读取商品…' : catalogue ? '当前没有可购商品' : '商店尚未读到' }}</option>
                  <option v-if="draft.goodsId && !selectedGood" :value="draft.goodsId">已保存的商品（当前不可用）</option>
                  <option v-for="good in goods" :key="good.id" :value="good.id">{{ good.reward.name }} · {{ good.price.name }} × {{ good.price.count }}</option>
                </select>
              </label>
              <label class="automation-field"><span>单次购买数量</span>
                <input v-model.number="draft.purchaseCount" type="number" :min="feedPurchaseOwned ? undefined : 1" :max="feedPurchaseOwned ? undefined : 99" :step="feedPurchaseOwned ? 'any' : 1" :required="!feedPurchaseOwned">
              </label>
              <p v-if="draft.buyEnabled && feedPurchaseOwned" class="automation-notice" role="status">
                智能供草已接管牧草，指定牧草购买暂停。
              </p>
            </fieldset>
          </div>
        </details>
        <details v-if="manualPlacement || manualPurchase || (draft.buyEnabled && feedPurchaseOwned)" class="automation-disclosure automation-budget-rules">
          <summary>
            <span>手动额度</span><span aria-hidden="true" class="automation-chevron i-carbon-chevron-down" />
          </summary>
          <div class="automation-disclosure-content">
            <p v-if="fixedPlacement && (!draft.ranchId || !draft.cubId || !draft.cubDailyLimit)" class="automation-note">
              指定放养需选幼崽、栏舍并填写每日上限。
            </p>
            <p v-if="fixedPurchase && (!draft.goodsId || !draft.currencyDailyLimit)" class="automation-note">
              指定购买需选商品并填写每日上限。
            </p>
            <p v-if="draft.buyEnabled && feedPurchaseOwned" class="automation-note">
              仍可为指定牧草购买保存额度，智能供草期间暂停使用。
            </p>
            <div class="automation-config-grid">
              <template v-if="manualPlacement">
                <label class="automation-field"><span>每日最多放养</span><input v-model.number="draft.cubDailyLimit" type="number" :min="manualStockBudget ? 1 : 0" max="1000000000" required></label>
                <label class="automation-field"><span>每种幼崽至少保留</span><input v-model.number="draft.cubReserve" type="number" min="0" max="1000000000" required></label>
              </template>
              <template v-if="manualPurchase || (draft.buyEnabled && feedPurchaseOwned)">
                <label class="automation-field"><span>允许消耗的货币</span><select v-model="draft.currencyId"><option v-if="!state?.currencies?.length" :value="draft.currencyId">余额尚未读到</option><option v-for="coin in state?.currencies || []" :key="coin.id" :value="coin.id" :disabled="fixedPurchase && !!selectedGood && coin.id !== selectedGood.price.id">{{ coin.name }} · 可用 {{ coin.available }}</option></select></label>
                <label class="automation-field"><span>每日最多花费</span><input v-model.number="draft.currencyDailyLimit" type="number" :min="manualStockBudget && draft.buyMissingCubs ? 1 : 0" max="1000000000" :required="manualPurchase"></label>
                <label class="automation-field"><span>至少保留货币</span><input v-model.number="draft.currencyReserve" type="number" min="0" max="1000000000" :required="manualPurchase"></label>
              </template>
            </div>
            <p class="automation-note">
              {{ manualStockBudget ? '窝、棚和指定操作共用额度。幼崽商店使用金券。' : '' }}每日额度按北京时间零点重置，待核对结果仍暂停。
            </p>
          </div>
        </details>
      </div>

      <p v-if="policyError" role="alert" class="automation-notice">
        {{ policyError }}
      </p>
      <p v-if="optionsError" role="alert" class="automation-notice">
        {{ optionsError }}
      </p>
      <footer class="automation-footer">
        <BaseButton type="button" variant="secondary" :loading="loading" @click="emit('load', String(draft.shopId), true)">
          <span aria-hidden="true" class="i-carbon-renew" />刷新库存和商店
        </BaseButton>
        <BaseButton type="submit" variant="primary" :loading="saving">
          保存牧场自动化
        </BaseButton>
      </footer>
    </form>

    <div v-else-if="policyError && !saving" class="automation-unavailable">
      <p role="alert">
        {{ policyError }}
      </p>
      <BaseButton type="button" variant="secondary" @click="emit('retryPolicy')">
        重新读取自动化设置
      </BaseButton>
    </div>
    <p v-else role="status" class="automation-unavailable">
      正在读取该账号的自动化设置。
    </p>
  </details>
</template>

<style scoped>
.ranch-automation {
  --automation-stroke: var(--surface-border-strong, #aebaca);
  --automation-muted: var(--muted-text, #506176);
  --automation-accent: var(--theme-primary, #1d4ed8);
  margin-block: 1rem;
  border: 1px solid var(--surface-border, #d5deeb);
  border-radius: 16px;
  background: var(--surface-2, #f6f8fc);
  color: var(--theme-text, #172235);
  container-type: inline-size;
}
.ranch-automation summary {
  list-style: none;
  cursor: pointer;
}
.ranch-automation summary::-webkit-details-marker {
  display: none;
}
.automation-heading,
.automation-card-heading,
.automation-master,
.automation-footer {
  display: flex;
  align-items: center;
  gap: 12px;
}
.automation-heading {
  min-height: 64px;
  padding: 10px 16px;
  border-radius: 15px;
}
.automation-heading:hover,
.automation-disclosure summary:hover,
.automation-control:hover {
  background: color-mix(in srgb, var(--automation-accent) 7%, transparent);
}
.automation-title {
  margin-inline-end: auto;
  font-weight: 700;
}
.automation-icon {
  display: inline-grid;
  flex: none;
  place-items: center;
  width: 36px;
  height: 36px;
  border-radius: 10px;
  background: color-mix(in srgb, var(--automation-accent) 13%, var(--surface-1, #fff));
  color: color-mix(in srgb, var(--theme-text, #172235) 65%, var(--automation-accent));
  font-size: 20px;
}
.automation-status {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  border: 1px solid var(--surface-border, #d5deeb);
  border-radius: 999px;
  background: var(--surface-1, #fff);
  color: var(--automation-muted);
  font-size: 12px;
  font-weight: 650;
  white-space: nowrap;
}
.automation-status::before {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: currentColor;
  content: '';
}
.automation-status.is-on {
  color: #166044;
  background: #e9f8f0;
  border-color: #b8dfca;
}
.dark .automation-status.is-on {
  color: #baf4d5;
  background: #173b31;
  border-color: #376958;
}
.automation-chevron {
  flex: none;
  color: var(--automation-muted);
  font-size: 16px;
}
details[open] > summary .automation-chevron {
  transform: rotate(180deg);
}
.automation-form {
  display: grid;
  gap: 14px;
  padding: 0 16px 16px;
  font-size: 14px;
}
.automation-master {
  justify-content: space-between;
  padding: 6px 10px;
  border: 1px solid var(--surface-border, #d5deeb);
  border-radius: 12px;
  background: var(--surface-1, #fff);
}
.automation-interval,
.automation-control {
  display: flex;
  min-height: 44px;
  align-items: center;
  gap: 9px;
}
.automation-interval input {
  width: 66px;
}
.automation-unit,
.automation-note {
  color: var(--automation-muted);
}
.automation-cards,
.automation-config-grid,
.automation-grid,
.automation-routine-grid {
  display: grid;
  gap: 10px;
}
.automation-cards,
.automation-config-grid,
.automation-grid {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}
.automation-routine-grid {
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 6px;
}
.automation-card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
  padding: 12px;
  border: 1px solid var(--surface-border, #d5deeb);
  border-top: 2px solid color-mix(in srgb, var(--card-accent) 60%, var(--surface-1, #fff));
  border-radius: 12px;
  background: var(--surface-1, #fff);
}
.automation-stock-card {
  --card-accent: var(--automation-accent);
}
.automation-feed-card {
  --card-accent: #168264;
}
.automation-card .automation-icon {
  background: color-mix(in srgb, var(--card-accent) 14%, var(--surface-1, #fff));
  color: color-mix(in srgb, var(--theme-text, #172235) 68%, var(--card-accent));
}
.automation-card-toggle {
  flex: 1;
  flex-direction: row-reverse;
  justify-content: space-between;
  font-size: 15px;
  font-weight: 700;
}
.automation-card-copy {
  flex: 1;
  color: var(--automation-muted);
  line-height: 1.55;
}
.automation-card-copy,
.automation-note,
.automation-notice {
  margin: 0;
  overflow-wrap: anywhere;
}
.automation-note,
.automation-notice {
  font-size: 13px;
  line-height: 1.55;
}
.automation-notice {
  padding: 7px 9px;
  border-inline-start: 2px solid var(--card-accent, var(--automation-accent));
  border-radius: 4px;
  background: color-mix(in srgb, var(--card-accent, var(--automation-accent)) 8%, var(--surface-1, #fff));
}
.automation-control {
  padding: 4px 8px;
  border-radius: 8px;
  cursor: pointer;
}
.automation-control:has(input:disabled) {
  color: var(--automation-muted);
  cursor: default;
}
.automation-control input {
  flex: none;
  width: 17px;
  height: 17px;
  margin: 0;
  accent-color: var(--automation-accent);
}
.automation-control .automation-switch {
  position: relative;
  appearance: none;
  width: 37px;
  height: 22px;
  border: 1px solid #64748b;
  border-radius: 99px;
  background: #64748b;
  cursor: pointer;
}
.automation-switch::after {
  position: absolute;
  top: 3px;
  left: 3px;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: #fff;
  content: '';
}
.automation-switch:checked {
  border-color: #1c6654;
  background: #1c6654;
}
.automation-switch:checked::after {
  left: 18px;
}
.automation-routine,
.automation-rule {
  min-width: 0;
  margin: 0;
  padding: 6px 10px 8px;
  border: 1px solid var(--surface-border, #d5deeb);
  border-radius: 10px;
  background: var(--surface-1, #fff);
}
.automation-routine legend,
.automation-rule legend {
  padding-inline: 4px;
  font-weight: 650;
}
.automation-rule {
  display: grid;
  gap: 8px;
  align-content: start;
}
.automation-rule-list {
  border: 1px solid var(--surface-border, #d5deeb);
  border-radius: 11px;
  background: var(--surface-1, #fff);
}
.automation-rule-list > details + details {
  border-top: 1px solid var(--surface-border, #d5deeb);
}
.automation-disclosure summary {
  display: flex;
  min-height: 44px;
  align-items: center;
  justify-content: space-between;
  gap: 9px;
  padding: 5px 10px;
  border-radius: 8px;
  font-weight: 600;
}
.automation-card > .automation-disclosure {
  border-top: 1px solid var(--surface-border, #d5deeb);
}
.automation-disclosure-content {
  display: grid;
  gap: 9px;
  padding: 3px 10px 10px;
}
.automation-field {
  display: grid;
  min-width: 0;
  gap: 4px;
  align-content: start;
}
.automation-form input[type='number'],
.automation-form select {
  min-width: 0;
  min-height: 44px;
  max-width: 100%;
  padding: 6px 9px;
  border: 1px solid var(--automation-stroke);
  border-radius: 8px;
  color: inherit;
  background: var(--input-bg, #fff);
}
.automation-field input,
.automation-field select {
  width: 100%;
}
.dark .automation-form {
  color-scheme: dark;
}
.ranch-automation :is(summary, button, select, input):focus-visible {
  outline: 2px solid var(--automation-accent);
  outline-offset: 3px;
}
.automation-footer {
  justify-content: space-between;
  flex-wrap: wrap;
  padding-top: 2px;
}
.automation-footer button,
.automation-unavailable button {
  gap: 7px;
  min-height: 44px;
}
.automation-unavailable {
  display: grid;
  justify-items: start;
  gap: 8px;
  padding: 0 16px 16px;
  color: var(--automation-muted);
}
@container (max-width: 660px) {
  .automation-routine-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
@container (max-width: 520px) {
  .automation-heading {
    padding-inline: 10px;
  }
  .automation-form {
    padding-inline: 10px;
  }
  .automation-cards,
  .automation-config-grid {
    grid-template-columns: minmax(0, 1fr);
  }
  .automation-master {
    flex-wrap: wrap;
    gap: 2px 10px;
  }
}
@container (max-width: 300px) {
  .automation-routine-grid {
    grid-template-columns: minmax(0, 1fr);
  }
}
@container (max-width: 340px) {
  .automation-grid {
    grid-template-columns: minmax(0, 1fr);
  }
  .automation-footer button {
    width: 100%;
  }
}
@media (forced-colors: active) {
  .automation-control .automation-switch {
    appearance: auto;
    width: 17px;
    height: 17px;
  }
  .automation-switch::after {
    display: none;
  }
}
</style>
