<script setup lang="ts">
import type { MilkTeaActivityData, MilkTeaQueryKind, MilkTeaQueryState } from '@/stores/activity'
import { computed, nextTick, ref, watch } from 'vue'
import BaseButton from '@/components/ui/BaseButton.vue'

const props = defineProps<{
  activity: MilkTeaActivityData | null
  loading?: boolean
  operating?: string
  queries: Record<MilkTeaQueryKind, MilkTeaQueryState>
}>()
const emit = defineEmits<{
  refresh: []
  query: [kind: MilkTeaQueryKind, params: Record<string, unknown>]
  operate: [action: string, input: Record<string, unknown>]
}>()
const number = (value: unknown) => value == null || !Number.isFinite(Number(value)) ? '待确认' : Number(value).toLocaleString()
const shopName = ref('')
const durationId = ref(1)
const targetGid = ref('')
const slotIndex = ref(0)
const boostCount = ref(1)
const fruitUid = ref('')
const recipeId = ref(2)
const page = ref(1)
const day = ref('')
const interactionType = ref(1)
type ExchangeGoods = NonNullable<NonNullable<MilkTeaActivityData['exchangeShop']>['items']>[number]
const exchangeCounts = ref<Record<number, number | string>>({})
const exchangeNotice = ref('')
const dialogRef = ref<HTMLElement | null>(null)
let returnFocus: HTMLElement | null = null
const pending = ref<{ action: string, input: Record<string, unknown>, text: string } | null>(null)
const busy = computed(() => props.loading || !!props.operating || !props.activity)
const notOpened = computed(() => props.activity?.summary?.shopOpenAt === 0)
const settle = computed(() => props.activity?.timing?.phase === 'settle')
const shop = computed(() => props.queries.shop.data)
const hires = computed(() => props.queries.hireList.data)
const work = computed(() => props.queries.work.data)
const workshop = computed(() => props.queries.workshop.data)
const candidates = computed(() => [...(hires.value?.friends || []), ...(hires.value?.robots || [])])
const freeSlots = computed(() => (shop.value?.slots || []).filter((slot: any) => !slot.employee && !slot.isRobot))
const hireCost = computed(() => ({ 1: 40, 2: 130, 3: 270 }[Number(durationId.value)] || 0))
const shopStarted = computed(() => Number(props.activity?.summary?.shopOpenAt) > 0)
const validShopName = computed(() => Array.from(shopName.value.trim()).length >= 2 && Array.from(shopName.value.trim()).length <= 8)
const noCashierReward = computed(() => Array.isArray(shop.value?.pendingRewards) && shop.value.pendingRewards.length === 0)
const noClaimableWages = computed(() => Array.isArray(work.value?.slips) && !work.value.slips.some((slip: any) => slip.wageStatus === 1))
watch(() => props.activity?.exchangeShop?.items?.map(goods => goods.id) || [], (ids) => {
  const values: Record<number, number | string> = {}
  for (const id of ids) values[id] = exchangeCounts.value[id] ?? 1
  exchangeCounts.value = values
}, { immediate: true })
watch(() => JSON.stringify(props.activity?.exchangeShop || null), () => {
  if (pending.value?.action === 'exchange') {
    closeConfirmation()
    exchangeNotice.value = '商城信息已更新，请重新核对数量和费用。'
  }
})
watch(() => freeSlots.value.map((slot: any) => Number(slot.slotIndex)).filter((id: number) => Number.isSafeInteger(id) && id >= 0), (ids: number[]) => {
  if (ids.length && !ids.includes(slotIndex.value))
    slotIndex.value = ids[0]!
}, { immediate: true })
watch(() => (workshop.value?.recipes || []).filter((recipe: any) => recipe.unlocked === true).map((recipe: any) => Number(recipe.recipeId)).filter((id: number) => Number.isSafeInteger(id) && id > 0), (ids: number[]) => {
  if (ids.length && !ids.includes(recipeId.value))
    recipeId.value = ids[0]!
}, { immediate: true })
watch(() => (work.value?.myShift?.interactPreviews || []).map((preview: any) => Number(preview.interactionType)).filter((id: number) => Number.isSafeInteger(id) && id > 0), (ids: number[]) => {
  if (ids.length && !ids.includes(interactionType.value))
    interactionType.value = ids[0]!
}, { immediate: true })
function prepare(action: string, input: Record<string, unknown> = {}, text = '确认执行此操作？') {
  returnFocus = typeof document === 'undefined' ? null : document.activeElement as HTMLElement | null
  pending.value = { action, input, text }
  void nextTick(() => {
    if (dialogRef.value?.querySelector)
      dialogRef.value.querySelector<HTMLButtonElement>('button')?.focus()
  })
}
function confirm() {
  if (!pending.value || busy.value)
    return
  const action = pending.value
  closeConfirmation()
  emit('operate', action.action, action.input)
}
function closeConfirmation() {
  pending.value = null
  const target = returnFocus
  void nextTick(() => {
    if (target?.isConnected !== false)
      target?.focus?.()
  })
}
function confirmationKey(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    event.preventDefault()
    closeConfirmation()
    return
  }
  if (event.key !== 'Tab')
    return
  const controls = dialogRef.value?.querySelectorAll<HTMLButtonElement>('button:not([disabled])')
  if (!controls?.length)
    return
  const first = controls[0]
  const last = controls[controls.length - 1]
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault()
    last?.focus()
  }
  else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault()
    first?.focus()
  }
}
function exchangeCountOf(goods: ExchangeGoods) {
  return Number(exchangeCounts.value[goods.id] ?? 1)
}
function formatAmount(value: unknown) {
  const text = String(value ?? '')
  return /^\d+$/.test(text) ? BigInt(text).toLocaleString() : '待确认'
}
function validExchangeCount(goods: ExchangeGoods) {
  const count = exchangeCountOf(goods)
  const max = goods.exchangeBounds?.maxCount
  return Number.isSafeInteger(count) && count > 0 && typeof max === 'number'
    && count <= max && !!goods.exchangeBounds?.unitCosts?.length
}
function exchangeProblem(goods: ExchangeGoods) {
  if (goods.exchangeBounds?.blockReason)
    return goods.exchangeBounds.blockReason
  const max = goods.exchangeBounds?.maxCount
  if (max == null)
    return '可兑换数量尚未确认，请刷新活动。'
  if (!validExchangeCount(goods))
    return `请输入 1～${max} 之间的整数。`
  return ''
}
function exchangeTotals(goods: ExchangeGoods) {
  if (!validExchangeCount(goods))
    return []
  return goods.exchangeBounds!.unitCosts.map(cost => ({
    itemId: cost.itemId,
    name: cost.name,
    count: (BigInt(cost.count) * BigInt(exchangeCountOf(goods))).toString(),
  }))
}
function setMaximum(goods: ExchangeGoods) {
  const max = goods.exchangeBounds?.maxCount
  if (!busy.value && typeof max === 'number' && max > 0)
    exchangeCounts.value[goods.id] = max
}
function exchange(goods: ExchangeGoods) {
  if (busy.value || !validExchangeCount(goods))
    return
  exchangeNotice.value = ''
  const count = exchangeCountOf(goods)
  const totals = exchangeTotals(goods)
  const costs = totals.map(({ itemId, count }) => ({ itemId, count }))
  const limit = goods.exchangeBounds?.hasPurchaseLimit
    ? `当前剩余限购 ${formatAmount(goods.exchangeBounds.remainingLimit)} 份`
    : '服务端未设置限购'
  prepare('exchange', { goodsId: goods.id, count, confirmedCosts: costs }, `兑换 ${goods.name || '商品'} × ${formatAmount(count)} 份；合计消耗 ${totals.map(cost => `${cost.name || '活动货币'} × ${formatAmount(cost.count)}`).join('、')}；${limit}。`)
}
</script>

<template>
  <article class="milk-panel">
    <header class="milk-header">
      <div class="milk-title">
        <span class="milk-mark i-carbon-cafe" aria-hidden="true" /><div>
          <div class="milk-heading">
            <h2>奶茶热销中</h2><span class="milk-badge">{{ settle ? '结算期' : notOpened ? '待开业' : activity ? '营业中' : '读取中' }}</span>
          </div><p>{{ activity?.summary?.shopName || '经营自己的奶茶小店' }} · 加工果实，收获好生意</p>
        </div>
      </div>
      <BaseButton class="milk-action" variant="secondary" :loading="loading" :disabled="busy" @click="emit('refresh')">
        <span class="i-carbon-renew mr-1.5" aria-hidden="true" />刷新活动
      </BaseButton>
    </header>
    <p v-if="loading" class="milk-notice" role="status">
      正在读取活动、库存、收银台、工坊与工作状态…
    </p>
    <p v-if="!activity && !loading" class="milk-notice">
      活动状态待确认，请刷新后查看。
    </p>
    <p v-if="settle" class="milk-notice milk-warning">
      已进入结算期：营业操作和种子购买已停止，合格奖励和非种子兑换仍可使用。
    </p>
    <div class="milk-stats">
      <div><span>店铺等级</span><strong>{{ number(activity?.summary?.level) }}<small> 级</small></strong></div>
      <div><span>累计营业额</span><strong>{{ number(activity?.summary?.totalRevenue) }}</strong></div>
      <div><span>奶茶券：<b>{{ activity?.inventory?.available ? number(activity.inventory.ticketCount) : '待确认' }}</b></span><small>用于雇佣与活动兑换</small></div>
      <div><span>宣传喇叭：<b>{{ activity?.inventory?.available ? number(activity.inventory.boostItemCount) : '待确认' }}</b></span><small>为小店加速营业</small></div>
    </div>
    <p v-if="!activity?.inventory?.available && !loading" class="milk-notice milk-warning">
      活动库存读取失败，请刷新后重试；不会把未知库存显示为零。
    </p>
    <nav class="milk-nav" aria-label="奶茶玩法导航">
      <a href="#milk-shop">店铺经营</a><a href="#milk-workshop">工坊加工</a><a href="#milk-work">我的工作</a><a href="#milk-exchange">活动商城</a><a href="#milk-rewards">活动奖励</a>
    </nav>
    <div class="milk-grid">
      <section id="milk-shop" data-gameplay="shop" class="milk-card">
        <div class="milk-card-heading">
          <span class="i-carbon-store" aria-hidden="true" /><div><h3>开店、改名与升级</h3><p>打造你的奶茶小店</p></div>
        </div>
        <p class="milk-copy">
          店名 <strong>{{ activity?.summary?.shopName || '待确认' }}</strong> · 等级 {{ number(activity?.summary?.level) }} · 营业额 {{ number(activity?.summary?.totalRevenue) }}
        </p>
        <p v-if="notOpened" class="milk-notice">
          店铺尚未开业，填写店名并开店后即可查看经营状态。
        </p>
        <label class="milk-field">店名（2–8 字）<input v-model="shopName" maxlength="8" aria-label="店名" placeholder="为小店取一个名字" class="milk-input"></label>
        <p v-if="shopStarted" class="milk-muted">
          店铺已营业，改名时填写新的店名。
        </p>
        <div class="milk-actions">
          <BaseButton class="milk-action" variant="primary" :disabled="busy || settle || shopStarted || !validShopName" @click="prepare('createShop', { shopName }, '确认开设奶茶店？')">
            开店
          </BaseButton><BaseButton class="milk-action" variant="secondary" :disabled="busy || settle || notOpened || !validShopName" @click="prepare('renameShop', { shopName }, '确认改名？改名后有冷却时间。')">
            改名
          </BaseButton><BaseButton class="milk-action" variant="secondary" :disabled="busy || settle || activity?.summary?.canUpgrade !== true" @click="prepare('upgrade')">
            升级
          </BaseButton>
        </div>
        <BaseButton class="milk-action milk-query" variant="secondary" :loading="queries.shop.loading" :disabled="busy || queries.shop.loading" @click="emit('query', 'shop', {})">
          查询店铺与收银台
        </BaseButton>
        <p v-if="queries.shop.loading" class="milk-muted" role="status">
          店铺查询中
        </p><p v-if="queries.shop.error" class="milk-error" role="alert">
          {{ queries.shop.error }}
        </p>
      </section>
      <section v-if="!notOpened" data-gameplay="cashier" class="milk-card">
        <div class="milk-card-heading">
          <span class="i-carbon-wallet" aria-hidden="true" /><div><h3>收银台与宣传喇叭</h3><p>营业收益，记得及时领取</p></div>
        </div>
        <div class="milk-cashier">
          <span>可收奖励 {{ shop?.pendingRewards?.length == null ? '待确认' : number(shop.pendingRewards.length) }} 项</span><BaseButton class="milk-action" variant="primary" :disabled="busy || noCashierReward" @click="prepare('claimCashier')">
            领取收银台
          </BaseButton>
        </div>
        <p class="milk-muted">
          每杯 {{ number(shop?.secPerCup) }} 秒 · 满额时间 {{ shop?.nextFullAt ? new Date(Number(shop.nextFullAt) * 1000).toLocaleString() : shop ? '暂无预计时间' : '待读取店铺状态' }}
        </p>
        <div class="milk-divider" /><div class="milk-inline-form">
          <label class="milk-field">喇叭数量<input v-model.number="boostCount" type="number" min="1" max="100" aria-label="喇叭数量" class="milk-input"></label><BaseButton class="milk-action" variant="secondary" :disabled="busy || settle" @click="prepare('boost', { count: Number(boostCount), confirmedCosts: [{ itemId: 1042, count: String(boostCount) }] }, `消耗宣传喇叭 × ${number(boostCount)}，确认使用？`)">
            使用宣传喇叭
          </BaseButton>
        </div>
      </section>
      <section v-if="!notOpened" id="milk-workshop" data-gameplay="workshop" class="milk-card">
        <div class="milk-card-heading">
          <span class="i-carbon-cafe" aria-hidden="true" /><div><h3>工坊、配方与果实加工</h3><p>选择配方和背包果实，补充奶茶库存</p></div>
        </div>
        <p v-if="workshop" class="milk-muted">
          已读取 {{ number(workshop.recipes?.length) }} 种配方、{{ number(workshop.fruits?.length) }} 类果实。
        </p><p v-if="workshop?.fruits && !workshop.fruits.length" class="milk-notice">
          背包中暂无可加工的活动果实。
        </p>
        <div class="milk-fields">
          <label class="milk-field">配方<select v-model.number="recipeId" aria-label="配方" class="milk-input"><option v-for="recipe in workshop?.recipes || []" :key="recipe.recipeId" :value="recipe.recipeId" :disabled="!recipe.unlocked">{{ recipe.name || '配方待确认' }} · 库存 {{ number(recipe.stockCups) }}</option></select></label><label class="milk-field">果实<select v-model="fruitUid" aria-label="加工果实" class="milk-input"><option value="">请选择</option><option v-for="fruit in workshop?.fruits || []" :key="fruit.uid" :value="fruit.uid" :disabled="fruit.locked">{{ fruit.name || '果实' }} × {{ number(fruit.count) }}{{ fruit.locked ? '（已锁定）' : '' }}</option></select></label>
        </div>
        <div class="milk-actions">
          <BaseButton class="milk-action" variant="primary" :disabled="busy || settle || !fruitUid" @click="prepare('craft', { recipeId: Number(recipeId), fruitUids: [fruitUid] }, '确认加工所选果实条目？请核对条目数量，加工会消耗该条目。')">
            加工所选果实
          </BaseButton><BaseButton class="milk-action" variant="secondary" :loading="queries.workshop.loading" :disabled="busy || queries.workshop.loading" @click="emit('query', 'workshop', {})">
            查询工坊与果实
          </BaseButton>
        </div><p class="milk-muted">
          已锁定或失效条目不能加工，执行前会再次确认。
        </p><p v-if="queries.workshop.error" class="milk-error" role="alert">
          {{ queries.workshop.error }}
        </p>
      </section>
      <section v-if="!notOpened" id="milk-work" data-gameplay="work" class="milk-card">
        <div class="milk-card-heading">
          <span class="i-carbon-user-avatar" aria-hidden="true" /><div><h3>我的工作、工资与互动</h3><p>查看当前班次和待领工资</p></div>
        </div>
        <p v-if="work?.myShift" class="milk-copy">
          班次店铺 {{ work.myShift.shopName || '奶茶店' }} · 工资 {{ number(work.myShift.wageTotal) }} · 互动 {{ number(work.myShift.interactCount) }} / {{ number(work.myShift.interactLimit) }}
        </p><p v-else-if="work" class="milk-notice">
          当前没有进行中的班次。
        </p><p v-else-if="!loading && !queries.work.error" class="milk-notice">
          工作状态尚未读取，请点击查询我的工作。
        </p><p v-if="work?.talentName" class="milk-muted">
          今日特长：{{ work.talentName }}
        </p>
        <p v-for="slip in work?.slips || []" :key="slip.shiftId" class="milk-list-row">
          {{ slip.shopName || '奶茶店' }} · 工资 {{ number(slip.finalWage) }} 奶茶券 · <strong>{{ slip.wageStatus === 1 ? '可领取' : '暂不可领取' }}</strong>
        </p>
        <div class="milk-actions">
          <BaseButton class="milk-action" variant="primary" :disabled="busy || noClaimableWages" @click="prepare('claimWages')">
            领取工资
          </BaseButton><BaseButton class="milk-action" variant="secondary" :loading="queries.work.loading" :disabled="busy || queries.work.loading" @click="emit('query', 'work', {})">
            查询我的工作
          </BaseButton>
        </div>
        <div class="milk-inline-form">
          <label class="milk-field">班次互动<select v-model.number="interactionType" aria-label="互动类型" class="milk-input"><option v-for="preview in work?.myShift?.interactPreviews || []" :key="preview.interactionType" :value="preview.interactionType">{{ ({ 1: '宣传推广', 2: '花式摇杯', 3: '招牌试饮', 4: '划水摸鱼', 5: '申请涨薪' } as Record<number, string>)[preview.interactionType] || '互动' }}</option></select></label><BaseButton class="milk-action" variant="secondary" :disabled="busy || settle || !work?.myShift" @click="prepare('interact', { interactionType: Number(interactionType), shiftId: work?.myShift?.shiftId })">
            执行班次互动
          </BaseButton>
        </div><p v-if="queries.work.error" class="milk-error" role="alert">
          {{ queries.work.error }}
        </p>
      </section>
      <section v-if="!notOpened" data-gameplay="hire" class="milk-card milk-full">
        <div class="milk-card-heading">
          <span class="i-carbon-group" aria-hidden="true" /><div><h3>雇佣、特长与班次</h3><p>先查询本班候选，再选择空槽和员工</p></div>
        </div>
        <div class="milk-hire-fields">
          <label class="milk-field">雇佣时长<select v-model.number="durationId" aria-label="雇佣时长" class="milk-input"><option :value="1">4 小时 / 40 奶茶券</option><option :value="2">12 小时 / 130 奶茶券</option><option :value="3">24 小时 / 270 奶茶券</option></select></label><label class="milk-field">空槽<select v-model.number="slotIndex" aria-label="雇佣槽位" class="milk-input"><option v-for="slot in freeSlots" :key="slot.slotIndex" :value="slot.slotIndex">槽位 {{ Number(slot.slotIndex) + 1 }}</option></select></label><label class="milk-field">候选员工<select v-model="targetGid" aria-label="雇佣候选" class="milk-input"><option value="">请选择</option><option v-for="candidate in candidates" :key="candidate.gid" :value="candidate.gid">{{ candidate.name || '员工' }} · {{ candidate.talentName || '特长待确认' }}</option></select></label>
        </div>
        <p v-if="shop && !freeSlots.length" class="milk-notice">
          当前没有可雇佣空位，请先升级店铺或等待现有班次结束。
        </p><p v-if="queries.hireList.error" class="milk-error" role="alert">
          {{ queries.hireList.error }}
        </p>
        <div class="milk-actions">
          <BaseButton class="milk-action" variant="secondary" :loading="queries.hireList.loading" :disabled="busy || queries.hireList.loading" @click="emit('query', 'hireList', { durationId: Number(durationId) })">
            查询雇佣候选
          </BaseButton><BaseButton class="milk-action" variant="primary" :disabled="busy || settle || !targetGid || !freeSlots.length || Number(hires?.durationId) !== Number(durationId)" @click="prepare('hire', { durationId: Number(durationId), hires: [{ slotIndex: Number(slotIndex), targetGid }], confirmedCosts: [{ itemId: 1041, count: String(hireCost) }] }, `消耗奶茶券 × ${hireCost} 雇佣所选员工，确认？`)">
            雇佣所选员工
          </BaseButton><BaseButton class="milk-action" variant="secondary" :disabled="busy || settle || !activity?.summary" @click="prepare('hireSetting', { hireDisabled: !activity?.summary?.hireDisabled })">
            {{ activity?.summary?.hireDisabled ? '开启被雇佣' : '暂停被雇佣' }}
          </BaseButton><span class="milk-muted">本次费用：{{ hireCost }} 奶茶券</span>
        </div>
      </section>
    </div>
    <section id="milk-exchange" data-gameplay="exchange" class="milk-card milk-section">
      <div class="milk-section-heading">
        <div class="milk-card-heading">
          <span class="i-carbon-shopping-bag" aria-hidden="true" /><div><h3>活动商城与专属种子</h3><p>选择喜欢的奖励，兑换前核对消耗</p></div>
        </div>
      </div>
      <p class="milk-muted">
        数量按商品分别选择；可兑上限取当前余额、剩余限购和单次上限的最小值。提交时会重新核验，以服务端返回为准。结算期不再售卖专属种子；钻石或未知费用不可兑换。
      </p>
      <p v-if="exchangeNotice" class="milk-notice" role="status">
        {{ exchangeNotice }}
      </p>
      <div class="milk-goods-grid">
        <article v-for="goods in activity?.exchangeShop?.items || []" :key="goods.id" class="milk-goods">
          <div>
            <h4>{{ goods.name || '商品名称待确认' }}</h4><p class="milk-muted">
              <template v-if="goods.exchangeBounds?.limitKnown && goods.exchangeBounds.hasPurchaseLimit">
                限购 {{ number(goods.purchaseLimit) }} 份 · 已兑 {{ number(goods.purchasedCount) }} 份 · 剩余 {{ number(goods.exchangeBounds.remainingLimit) }} 份
              </template>
              <template v-else-if="goods.exchangeBounds?.limitKnown">
                服务端未设置限购
              </template>
              <template v-else>
                限购信息待读取
              </template>
            </p>
          </div><div class="milk-reward-list">
            <div v-for="(item, index) in goods.rewards || []" :key="index" class="milk-reward">
              <img v-if="item.image" :src="item.image" :alt="item.name || '奖励'"><span v-else class="milk-item-placeholder i-carbon-gift" aria-hidden="true" /><span>{{ item.name || '奖励' }} × {{ number(item.count) }}<small v-if="!item.image">暂无专属图标</small><small v-else-if="item.iconStatus === 'generic'">通用图标</small></span>
            </div>
          </div><p class="milk-cost">
            每份消耗：<span v-for="(cost, index) in goods.costs || []" :key="index">{{ cost.name || '活动货币' }} × {{ formatAmount(cost.count) }} </span><span v-if="!goods.costs?.length">费用待确认</span>
          </p>
          <p class="milk-muted">
            当前最多可兑 {{ number(goods.exchangeBounds?.maxCount) }} 份<span v-if="goods.exchangeBounds && goods.exchangeBounds.maxCount === goods.exchangeBounds.requestMax">（单次上限）</span>
          </p>
          <div class="milk-exchange-controls">
            <label class="milk-field milk-quantity">兑换数量<input v-model.number="exchangeCounts[goods.id]" type="number" min="1" step="1" :max="goods.exchangeBounds?.maxCount ?? undefined" :aria-label="`${goods.name || '商品'}兑换数量`" :disabled="busy || !goods.exchangeBounds?.maxCount" class="milk-input"></label>
            <BaseButton class="milk-action milk-max" variant="secondary" :disabled="busy || !goods.exchangeBounds?.maxCount" @click="setMaximum(goods)">
              最大
            </BaseButton>
          </div>
          <p v-if="exchangeProblem(goods)" class="milk-muted" role="status">
            {{ exchangeProblem(goods) }}
          </p>
          <p v-else class="milk-cost">
            本次合计：<span v-for="cost in exchangeTotals(goods)" :key="cost.itemId">{{ cost.name }} × {{ formatAmount(cost.count) }} </span>
          </p>
          <BaseButton class="milk-action milk-buy" variant="primary" :disabled="busy || !validExchangeCount(goods)" @click="exchange(goods)">
            确认兑换 {{ goods.name || '商品' }} × {{ formatAmount(exchangeCountOf(goods)) }}
          </BaseButton>
        </article>
      </div><p v-if="!activity?.exchangeShop" class="milk-notice">
        商城状态待确认
      </p>
    </section>
    <section id="milk-rewards" data-gameplay="fund-share" class="milk-card milk-section">
      <div class="milk-card-heading">
        <span class="i-carbon-gift" aria-hidden="true" /><div><h3>成长基金与快乐值</h3><p>查看进度，领取已达成的奖励</p></div>
      </div>
      <div class="milk-grid milk-rewards-grid">
        <div>
          <div class="milk-subheading">
            <h4>成长基金</h4><span class="milk-badge">{{ activity?.growthFund?.unlocked == null ? '待确认' : activity.growthFund.unlocked ? '已解锁' : '未解锁' }}</span>
          </div><p class="milk-muted">
            仅领取已解锁档位；付费解锁请在官方客户端完成。
          </p><div v-for="tier in activity?.growthFund?.tiers || []" :key="tier.tierId" class="milk-list-row">
            <span>基金档位 {{ number(tier.tierId) }} · {{ activity?.growthFund?.unlocked === false ? '基金未解锁' : tier.state === 2 ? '可领取' : tier.state === 3 ? '已领取' : '暂不可领取' }}</span><span v-for="(item, index) in tier.reward || []" :key="index" class="milk-reward"><img v-if="item.image" :src="item.image" :alt="item.name || '奖励'"><span>{{ item.name || '奖励' }} × {{ number(item.count) }}</span></span>
          </div><BaseButton class="milk-action" variant="secondary" :disabled="busy || activity?.growthFund?.unlocked !== true" @click="prepare('fundClaim')">
            领取成长基金
          </BaseButton>
        </div>
        <div>
          <div class="milk-subheading">
            <h4>快乐值奖励</h4><span class="milk-badge">{{ number(activity?.shareReward?.currentScore) }} 快乐值</span>
          </div><p class="milk-muted">
            每日快乐值领取 {{ activity?.shareReward?.daily?.rewardClaimed == null ? '待确认' : activity.shareReward.daily.rewardClaimed ? '已领取' : '未领取' }} · 次数 {{ number(activity?.shareReward?.daily?.claimedCount) }} / {{ number(activity?.shareReward?.daily?.claimLimit) }}
          </p><p v-for="(tier, index) in activity?.shareReward?.milestones || []" :key="index" class="milk-list-row">
            快乐值档位 {{ number(tier.threshold) }} · {{ tier.state === 2 ? '可领取' : tier.state === 3 ? '已领取' : '暂不可领取' }}<span v-for="(item, itemIndex) in tier.rewards || []" :key="itemIndex" class="milk-reward"><img v-if="item.image" :src="item.image" :alt="item.itemName || '奖励'"><span>{{ item.itemName || '未知物品' }} × {{ number(item.itemCount) }}</span></span>
          </p><div class="milk-actions">
            <BaseButton class="milk-action" variant="primary" :disabled="busy" @click="prepare('shareDaily')">
              领取每日快乐值
            </BaseButton><BaseButton class="milk-action" variant="secondary" :disabled="busy" @click="prepare('shareMilestones')">
              领取快乐值档位
            </BaseButton>
          </div><p class="milk-muted">
            分享与好友快乐包链接请在官方客户端使用。
          </p>
        </div>
      </div>
    </section>
    <details data-gameplay="rank-sales" class="milk-card milk-section">
      <summary class="milk-summary">
        好友排行与销量日志<span class="i-carbon-chevron-down" aria-hidden="true" />
      </summary><div class="milk-grid milk-details-body">
        <div>
          <div class="milk-inline-form">
            <label class="milk-field">排行页码<input v-model.number="page" type="number" min="1" aria-label="排行页码" class="milk-input"></label><BaseButton class="milk-action" variant="secondary" :loading="queries.rank.loading" :disabled="busy || queries.rank.loading" @click="emit('query', 'rank', { page: Number(page) })">
              查询指定页排行
            </BaseButton>
          </div><p v-if="queries.rank.error" class="milk-error" role="alert">
            {{ queries.rank.error }}
          </p><p v-for="entry in queries.rank.data?.ranks || []" :key="entry.rank" class="milk-list-row">
            第 {{ number(entry.rank) }} 名 · {{ entry.shopName || '奶茶店' }} · {{ number(entry.totalRevenue) }}
          </p>
        </div><div>
          <div class="milk-inline-form">
            <label class="milk-field">日期（年月日）<input v-model="day" placeholder="留空为今日" aria-label="销量日期" class="milk-input"></label><BaseButton class="milk-action" variant="secondary" :loading="queries.sales.loading" :disabled="busy || queries.sales.loading" @click="emit('query', 'sales', day ? { day: Number(day) } : {})">
              查询销量日志
            </BaseButton>
          </div><p v-if="queries.sales.error" class="milk-error" role="alert">
            {{ queries.sales.error }}
          </p><p class="milk-muted">
            售出 {{ number(queries.sales.data?.cups) }} 杯 · 奶茶券 {{ number(queries.sales.data?.token) }}
          </p>
        </div>
      </div>
    </details>
    <details data-gameplay="rules" class="milk-card milk-section">
      <summary class="milk-summary">
        活动规则与结算<span class="i-carbon-chevron-down" aria-hidden="true" />
      </summary><div class="milk-details-body">
        <p v-for="(rule, index) in activity?.rules || []" :key="index" class="milk-rule">
          {{ rule }}
        </p><p v-if="!activity?.rules?.length" class="milk-muted">
          官方说明待确认
        </p>
      </div>
    </details>
    <div v-if="pending" class="milk-modal-backdrop" @keydown="confirmationKey" @click.self="closeConfirmation">
      <section ref="dialogRef" class="milk-modal" role="dialog" aria-label="确认奶茶操作" aria-modal="true" tabindex="-1">
        <div class="milk-card-heading">
          <span class="i-carbon-checkmark-outline" aria-hidden="true" /><div><h3>确认奶茶操作</h3><p>请核对本次操作和资源消耗</p></div>
        </div><p class="milk-confirm-copy">
          {{ pending.text }}
        </p><div class="milk-modal-actions">
          <BaseButton class="milk-action" variant="secondary" @click="closeConfirmation">
            取消
          </BaseButton><BaseButton class="milk-action" variant="primary" :disabled="busy" @click="confirm">
            确认执行
          </BaseButton>
        </div>
      </section>
    </div>
  </article>
</template>

<style scoped>
.milk-panel p {
  overflow-wrap: anywhere;
}
.milk-panel {
  --milk-border: var(--surface-border, rgba(15, 23, 42, 0.09));
  color: var(--theme-text, #172033);
  min-width: 0;
  display: grid;
  gap: 18px;
}
.milk-header,
.milk-section-heading,
.milk-heading,
.milk-title,
.milk-subheading {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
}
.milk-header,
.milk-section-heading,
.milk-subheading {
  justify-content: space-between;
}
.milk-header {
  padding: 6px 2px;
}
.milk-title > div {
  min-width: 0;
}
.milk-mark {
  font-size: 29px;
  flex-shrink: 0;
  color: var(--theme-primary);
}
.milk-heading {
  gap: 10px;
  flex-wrap: wrap;
}
.milk-heading h2 {
  font-size: 22px;
  font-weight: 750;
  letter-spacing: -0.4px;
}
.milk-title p,
.milk-card-heading p {
  color: var(--muted-text, #64748b);
  font-size: 13px;
  margin-top: 4px;
  line-height: 1.6;
}
.milk-badge {
  display: inline-flex;
  align-items: center;
  flex-shrink: 0;
  padding: 4px 9px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--theme-primary) 10%, transparent);
  color: var(--theme-primary);
  font-size: 12px;
  font-weight: 600;
}
.milk-stats {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 12px;
}
.milk-stats > div {
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 8px;
  padding: 18px 20px;
  background: var(--surface-1, #fff);
  border: 1px solid var(--milk-border);
  border-radius: 14px;
  min-width: 0;
}
.milk-stats span {
  font-size: 13px;
  color: var(--muted-text, #64748b);
}
.milk-stats strong,
.milk-stats b {
  font-size: 23px;
  line-height: 1.2;
  font-weight: 700;
  color: var(--theme-text, #172033);
}
.milk-stats b {
  display: block;
  margin-top: 8px;
}
.milk-stats small,
.milk-muted {
  color: var(--muted-text, #64748b);
  font-size: 12px;
  line-height: 1.7;
}
.milk-stats strong small {
  font-weight: 400;
}
.milk-nav {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 4px 0;
}
.milk-nav a {
  padding: 9px 14px;
  border-radius: 9px;
  color: var(--muted-text, #64748b);
  font-size: 13px;
  font-weight: 600;
  transition:
    background 0.15s,
    color 0.15s;
  min-height: 40px;
}
.milk-nav a:hover,
.milk-nav a:focus-visible {
  color: var(--theme-primary);
  background: color-mix(in srgb, var(--theme-primary) 9%, transparent);
}
.milk-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 18px;
}
.milk-full {
  grid-column: 1/-1;
}
.milk-card {
  min-width: 0;
  padding: 22px;
  border: 1px solid var(--milk-border);
  border-radius: 16px;
  background: var(--surface-1, #fff);
  box-shadow: 0 2px 6px rgba(15, 23, 42, 0.025);
  scroll-margin-top: 16px;
}
.milk-card-heading {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  margin-bottom: 18px;
  min-width: 0;
}
.milk-card-heading > span {
  font-size: 22px;
  flex-shrink: 0;
  color: var(--theme-primary);
  margin-top: 1px;
}
.milk-card h3 {
  font-size: 15px;
  font-weight: 700;
  line-height: 1.5;
}
.milk-copy {
  font-size: 13px;
  line-height: 1.8;
  margin-bottom: 12px;
}
.milk-fields {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}
.milk-field {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 7px;
  font-size: 12px;
  font-weight: 550;
  color: var(--muted-text, #64748b);
}
.milk-input {
  width: 100%;
  min-width: 0;
  max-width: 100%;
  height: 42px;
  border: 1px solid var(--surface-border-strong, #cbd5e1);
  border-radius: 9px;
  background: var(--input-bg, #fff);
  padding: 9px 11px;
  color: var(--theme-text, #172033);
  font: inherit;
  font-size: 13px;
  font-weight: 400;
  transition:
    border-color 0.15s,
    box-shadow 0.15s;
}
.milk-input:focus {
  outline: none;
  border-color: var(--theme-primary);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--theme-primary) 15%, transparent);
}
.milk-input::placeholder {
  color: var(--muted-text, #64748b);
  opacity: 0.8;
}
.milk-input:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
.milk-action {
  min-height: 42px;
  max-width: 100%;
  white-space: normal;
  line-height: 1.5;
  overflow-wrap: anywhere;
}
.milk-actions {
  display: flex;
  align-items: center;
  gap: 9px;
  flex-wrap: wrap;
  margin-top: 15px;
}
.milk-query {
  margin-top: 12px;
}
.milk-inline-form {
  display: flex;
  align-items: flex-end;
  gap: 10px;
  min-width: 0;
  margin-top: 15px;
}
.milk-inline-form > .milk-field {
  flex: 1;
}
.milk-inline-form > .milk-action {
  flex-shrink: 0;
}
.milk-notice,
.milk-error {
  padding: 11px 14px;
  border-radius: 9px;
  background: var(--surface-2, #f8fafc);
  color: var(--muted-text, #64748b);
  font-size: 13px;
  line-height: 1.7;
  overflow-wrap: anywhere;
}
.milk-warning {
  background: color-mix(in srgb, #d97706 9%, transparent);
  color: #b45309;
}
.milk-error {
  margin-top: 10px;
  background: color-mix(in srgb, #ef4444 9%, transparent);
  color: #dc2626;
}
.milk-cashier {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  margin-bottom: 10px;
}
.milk-cashier > span {
  font-size: 15px;
  font-weight: 650;
}
.milk-divider {
  height: 1px;
  background: var(--milk-border);
  margin-top: 20px;
}
.milk-hire-fields {
  display: grid;
  grid-template-columns: 1fr 0.7fr 1.5fr;
  gap: 14px;
  margin-bottom: 12px;
}
.milk-section-heading {
  margin-bottom: 16px;
  align-items: flex-start;
}
.milk-section-heading .milk-card-heading {
  margin-bottom: 0;
}
.milk-quantity {
  width: 110px;
  flex-shrink: 0;
}
.milk-exchange-controls {
  display: flex;
  align-items: flex-end;
  gap: 0.75rem;
}
.milk-exchange-controls .milk-quantity {
  flex: 1;
  min-width: 0;
}
.milk-exchange-controls .milk-max {
  flex: none;
}
.milk-goods-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 14px;
  margin-top: 20px;
}
.milk-goods {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 18px;
  border: 1px solid var(--milk-border);
  border-radius: 12px;
  background: var(--surface-2, #f8fafc);
}
.milk-goods h4,
.milk-subheading h4 {
  font-size: 14px;
  font-weight: 650;
  line-height: 1.6;
  overflow-wrap: anywhere;
}
.milk-reward-list {
  display: grid;
  gap: 7px;
  flex: 1;
}
.milk-reward {
  display: flex;
  align-items: center;
  gap: 9px;
  font-size: 13px;
  min-width: 0;
  line-height: 1.6;
}
.milk-reward > span:last-child {
  min-width: 0;
  overflow-wrap: anywhere;
}
.milk-reward img {
  width: 34px;
  height: 34px;
  object-fit: contain;
  flex-shrink: 0;
}
.milk-item-placeholder {
  font-size: 25px;
  color: var(--muted-text, #64748b);
  flex-shrink: 0;
  opacity: 0.65;
}
.milk-reward small {
  display: block;
  color: var(--muted-text, #64748b);
  font-size: 11px;
}
.milk-cost {
  font-size: 12px;
  line-height: 1.7;
  color: var(--muted-text, #64748b);
}
.milk-buy {
  width: 100%;
}
.milk-rewards-grid {
  margin-top: 16px;
  gap: 24px;
}
.milk-subheading {
  margin-bottom: 8px;
}
.milk-list-row {
  padding: 12px 0;
  border-bottom: 1px solid var(--milk-border);
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  align-items: center;
  font-size: 13px;
  line-height: 1.7;
  overflow-wrap: anywhere;
}
.milk-list-row:last-of-type {
  margin-bottom: 14px;
}
.milk-summary {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  cursor: pointer;
  font-size: 14px;
  font-weight: 650;
  min-height: 22px;
  list-style: none;
}
.milk-summary::-webkit-details-marker {
  display: none;
}
.milk-summary > span {
  color: var(--muted-text, #64748b);
  transition: transform 0.15s;
}
details[open] > .milk-summary > span {
  transform: rotate(180deg);
}
.milk-details-body {
  padding-top: 16px;
}
.milk-rule {
  font-size: 13px;
  line-height: 1.9;
  white-space: pre-line;
  margin-bottom: 8px;
}
.milk-modal-backdrop {
  position: fixed;
  inset: 0;
  z-index: 1000;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
  background: rgba(15, 23, 42, 0.5);
  backdrop-filter: blur(3px);
}
.milk-modal {
  background: var(--surface-1, #fff);
  border: 1px solid var(--milk-border);
  border-radius: 18px;
  padding: 26px;
  max-width: 460px;
  width: 100%;
  max-height: calc(100dvh - 40px);
  overflow: auto;
  box-shadow: 0 24px 80px rgba(0, 0, 0, 0.25);
  outline: none;
}
.milk-confirm-copy {
  font-size: 14px;
  line-height: 1.9;
  overflow-wrap: anywhere;
  white-space: pre-line;
}
.milk-modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 24px;
}
.milk-panel a:focus-visible,
.milk-summary:focus-visible {
  outline: 2px solid var(--theme-primary);
  outline-offset: 3px;
}
.dark .milk-error {
  color: #fca5a5;
}
.dark .milk-warning {
  color: #fcd34d;
}
@media (max-width: 1000px) {
  .milk-goods-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
@media (max-width: 700px) {
  .milk-header {
    align-items: flex-start;
    gap: 10px;
  }
  .milk-heading h2 {
    font-size: 19px;
  }
  .milk-title p {
    font-size: 12px;
  }
  .milk-mark {
    display: none;
  }
  .milk-header > .milk-action {
    flex-shrink: 0;
    font-size: 12px;
    padding: 8px 10px;
  }
  .milk-stats {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 10px;
  }
  .milk-stats > div {
    padding: 15px;
  }
  .milk-stats strong,
  .milk-stats b {
    font-size: 21px;
  }
  .milk-grid {
    grid-template-columns: minmax(0, 1fr);
    gap: 14px;
  }
  .milk-card {
    padding: 17px;
    border-radius: 13px;
  }
  .milk-hire-fields {
    grid-template-columns: minmax(0, 1fr);
  }
  .milk-nav {
    gap: 3px;
  }
  .milk-nav a {
    padding: 9px 10px;
    font-size: 12px;
  }
  .milk-fields {
    grid-template-columns: minmax(0, 1fr);
  }
  .milk-inline-form {
    flex-wrap: wrap;
  }
  .milk-inline-form > .milk-field {
    flex-basis: 100%;
  }
  .milk-section-heading {
    flex-wrap: wrap;
  }
  .milk-quantity {
    width: 100%;
  }
  .milk-quantity .milk-input {
    max-width: 120px;
  }
  .milk-goods-grid {
    grid-template-columns: minmax(0, 1fr);
  }
  .milk-cashier {
    flex-wrap: wrap;
  }
  .milk-rewards-grid {
    gap: 22px;
  }
  .milk-modal {
    padding: 21px;
  }
  .milk-modal-actions > .milk-action {
    flex: 1;
  }
}
@media (prefers-reduced-motion: reduce) {
  .milk-panel * {
    transition: none !important;
  }
}
</style>
