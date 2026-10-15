<script setup lang="ts">
import { computed, ref } from 'vue'
import type { MilkTeaActivityData, MilkTeaQueryKind, MilkTeaQueryState } from '@/stores/activity'

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
const exchangeCount = ref(1)
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
function prepare(action: string, input: Record<string, unknown> = {}, text = '确认执行此操作？') {
  pending.value = { action, input, text }
}
function confirm() {
  if (!pending.value || busy.value)
    return
  const action = pending.value
  pending.value = null
  emit('operate', action.action, action.input)
}
function exchange(goods: NonNullable<NonNullable<MilkTeaActivityData['exchangeShop']>['items']>[number]) {
  const costs = (goods.costs || []).map(cost => ({ itemId: cost.id, count: String(Number(cost.count) * Number(exchangeCount.value)) }))
  prepare('exchange', { goodsId: goods.id, count: Number(exchangeCount.value), confirmedCosts: costs },
    `兑换 ${goods.name || '商品'} × ${number(exchangeCount.value)}；消耗 ${(goods.costs || []).map(cost => `${cost.name || '活动货币'} × ${number(Number(cost.count) * Number(exchangeCount.value))}`).join('、') || '费用待确认，无法兑换'}。`)
}
</script>

<template>
  <article class="rounded-lg bg-white p-4 shadow space-y-5 dark:bg-gray-800">
    <header class="flex items-center justify-between gap-2">
      <div><h2 class="text-lg font-bold">奶茶热销中</h2><p class="text-sm text-gray-500">经营奶茶店 · 手动查询与操作</p></div>
      <button :disabled="busy" @click="emit('refresh')">刷新活动</button>
    </header>
    <p v-if="loading" role="status">正在读取活动、库存、收银台、工坊与工作状态…</p>
    <p v-if="!activity">活动状态待确认，请刷新后查看；缺少状态时操作仍需重新校验资格。</p>
    <p v-if="settle" class="text-amber-700">已进入结算期：停止营业操作和专属种子购买；合格奖励领取、非种子兑换仍可用。</p>
    <p v-if="activity?.inventory?.available">奶茶券：{{ number(activity.inventory.ticketCount) }} · 宣传喇叭：{{ number(activity.inventory.boostItemCount) }}</p>
    <p v-else-if="!loading" class="text-amber-700">活动库存读取失败，请刷新后重试；不会把未知库存显示为零。</p>
    <p v-if="notOpened">店铺尚未开业，填写店名并开店后即可查看经营状态。</p>

    <section data-gameplay="shop" class="space-y-2">
      <h3 class="font-semibold">开店、改名与升级</h3>
      <p>店名 {{ activity?.summary?.shopName || '待确认' }} · 等级 {{ number(activity?.summary?.level) }} · 营业额 {{ number(activity?.summary?.totalRevenue) }}</p>
      <label>店名（2–8 字） <input v-model="shopName" maxlength="8" aria-label="店名"></label>
      <button :disabled="busy || settle" @click="prepare('createShop', { shopName }, '确认开设奶茶店？')">开店</button>
      <button :disabled="busy || settle" @click="prepare('renameShop', { shopName }, '确认改名？改名后有冷却时间。')">改名</button>
      <button :disabled="busy || settle || activity?.summary?.canUpgrade !== true" @click="prepare('upgrade')">升级</button>
      <button :disabled="busy || queries.shop.loading" @click="emit('query', 'shop', {})">查询店铺与收银台</button>
      <p v-if="queries.shop.loading">店铺查询中</p><p v-if="queries.shop.error">{{ queries.shop.error }}</p>
    </section>

    <section v-if="!notOpened" data-gameplay="cashier" class="space-y-2">
      <h3 class="font-semibold">收银台与宣传喇叭</h3>
      <p>可收奖励 {{ shop?.pendingRewards?.length == null ? '待确认' : number(shop.pendingRewards.length) }} 项 · 每杯 {{ number(shop?.secPerCup) }} 秒 · 满额时间 {{ shop?.nextFullAt ? new Date(Number(shop.nextFullAt) * 1000).toLocaleString() : shop ? '暂无预计时间' : '待读取店铺状态' }}</p>
      <button :disabled="busy" @click="prepare('claimCashier')">领取收银台</button>
      <label>喇叭数量 <input v-model.number="boostCount" type="number" min="1" max="100" aria-label="喇叭数量"></label>
      <button :disabled="busy || settle" @click="prepare('boost', { count: Number(boostCount), confirmedCosts: [{ itemId: 1042, count: String(boostCount) }] }, `消耗宣传喇叭 × ${number(boostCount)}，确认使用？`)">使用宣传喇叭</button>
    </section>

    <section v-if="!notOpened" data-gameplay="hire" class="space-y-2">
      <h3 class="font-semibold">雇佣、特长与班次</h3><p>先查询店铺空槽，再查询当前班次候选；费用在确认后仍会重新校验。</p>
      <label>雇佣时长 <select v-model.number="durationId" aria-label="雇佣时长"><option :value="1">4 小时 / 40 奶茶券</option><option :value="2">12 小时 / 130 奶茶券</option><option :value="3">24 小时 / 270 奶茶券</option></select></label>
      <button :disabled="busy || queries.hireList.loading" @click="emit('query', 'hireList', { durationId: Number(durationId) })">查询雇佣候选</button>
      <p v-if="queries.hireList.error">{{ queries.hireList.error }}</p>
      <label>空槽 <select v-model.number="slotIndex" aria-label="雇佣槽位"><option v-for="slot in freeSlots" :key="slot.slotIndex" :value="slot.slotIndex">槽位 {{ Number(slot.slotIndex) + 1 }}</option></select></label>
      <p v-if="shop && !freeSlots.length">当前没有可雇佣空位，请先升级店铺或等待现有班次结束。</p>
      <label>候选 <select v-model="targetGid" aria-label="雇佣候选"><option value="">请选择</option><option v-for="candidate in candidates" :key="candidate.gid" :value="candidate.gid">{{ candidate.name || '员工' }} · {{ candidate.talentName || '特长待确认' }}</option></select></label>
      <button :disabled="busy || settle || !targetGid || !freeSlots.length || Number(hires?.durationId) !== Number(durationId)" @click="prepare('hire', { durationId: Number(durationId), hires: [{ slotIndex: Number(slotIndex), targetGid }], confirmedCosts: [{ itemId: 1041, count: String(hireCost) }] }, `消耗奶茶券 × ${hireCost} 雇佣所选员工，确认？`)">雇佣所选员工</button>
      <button :disabled="busy || settle || !activity?.summary" @click="prepare('hireSetting', { hireDisabled: !activity?.summary?.hireDisabled })">{{ activity?.summary?.hireDisabled ? '开启被雇佣' : '暂停被雇佣' }}</button>
    </section>

    <section v-if="!notOpened" data-gameplay="workshop" class="space-y-2">
      <h3 class="font-semibold">工坊、配方与果实加工</h3><p>仅加工背包中当前可用的唯一果实条目；已锁定或失效条目不能加工。</p>
      <button :disabled="busy || queries.workshop.loading" @click="emit('query', 'workshop', {})">查询工坊与果实</button><p v-if="queries.workshop.error">{{ queries.workshop.error }}</p>
      <p v-if="workshop">已读取 {{ number(workshop.recipes?.length) }} 种配方、{{ number(workshop.fruits?.length) }} 类果实。</p>
      <p v-if="workshop?.fruits && !workshop.fruits.length">背包中暂无可加工的活动果实。</p>
      <label>配方 <select v-model.number="recipeId" aria-label="配方"><option v-for="recipe in workshop?.recipes || []" :key="recipe.recipeId" :value="recipe.recipeId" :disabled="!recipe.unlocked">{{ recipe.name || '配方待确认' }} · 库存 {{ number(recipe.stockCups) }}</option></select></label>
      <label>果实 <select v-model="fruitUid" aria-label="加工果实"><option value="">请选择</option><option v-for="fruit in workshop?.fruits || []" :key="fruit.uid" :value="fruit.uid" :disabled="fruit.locked">{{ fruit.name || '果实' }} × {{ number(fruit.count) }}{{ fruit.locked ? '（已锁定）' : '' }}</option></select></label>
      <button :disabled="busy || settle || !fruitUid" @click="prepare('craft', { recipeId: Number(recipeId), fruitUids: [fruitUid] }, '确认加工所选果实条目？请核对条目数量，加工会消耗该条目。')">加工所选果实</button>
    </section>

    <section v-if="!notOpened" data-gameplay="work" class="space-y-2">
      <h3 class="font-semibold">我的工作、工资与互动</h3>
      <button :disabled="busy || queries.work.loading" @click="emit('query', 'work', {})">查询我的工作</button><p v-if="queries.work.error">{{ queries.work.error }}</p>
      <p v-if="work?.myShift">班次店铺 {{ work.myShift.shopName || '奶茶店' }} · 工资 {{ number(work.myShift.wageTotal) }} · 互动 {{ number(work.myShift.interactCount) }} / {{ number(work.myShift.interactLimit) }}</p>
      <p v-else-if="work">当前没有进行中的班次。</p>
      <p v-else-if="!loading && !queries.work.error">工作状态尚未读取，请点击查询我的工作。</p>
      <p v-if="work?.talentName">今日特长：{{ work.talentName }}</p>
      <p v-for="slip in work?.slips || []" :key="slip.shiftId">{{ slip.shopName || '奶茶店' }} · 工资 {{ number(slip.finalWage) }} 奶茶券 · {{ slip.wageStatus === 1 ? '可领取' : '暂不可领取' }}</p>
      <button :disabled="busy" @click="prepare('claimWages')">领取工资</button>
      <label>互动 <select v-model.number="interactionType" aria-label="互动类型"><option v-for="preview in work?.myShift?.interactPreviews || []" :key="preview.interactionType" :value="preview.interactionType">{{ ({ 1: '宣传推广', 2: '花式摇杯', 3: '招牌试饮', 4: '划水摸鱼', 5: '申请涨薪' } as Record<number, string>)[preview.interactionType] || '互动' }}</option></select></label>
      <button :disabled="busy || settle || !work?.myShift" @click="prepare('interact', { interactionType: Number(interactionType), shiftId: work?.myShift?.shiftId })">执行班次互动</button>
    </section>

    <section data-gameplay="rank-sales" class="space-y-2">
      <h3 class="font-semibold">好友排行与销量日志</h3>
      <label>排行页码 <input v-model.number="page" type="number" min="1" aria-label="排行页码"></label>
      <button :disabled="busy || queries.rank.loading" @click="emit('query', 'rank', { page: Number(page) })">查询指定页排行</button>
      <p v-if="queries.rank.error">{{ queries.rank.error }}</p>
      <p v-for="entry in queries.rank.data?.ranks || []" :key="entry.rank">第 {{ number(entry.rank) }} 名 · {{ entry.shopName || '奶茶店' }} · {{ number(entry.totalRevenue) }}</p>
      <label>日期（年月日） <input v-model="day" placeholder="留空为今日" aria-label="销量日期"></label>
      <button :disabled="busy || queries.sales.loading" @click="emit('query', 'sales', day ? { day: Number(day) } : {})">查询销量日志</button>
      <p v-if="queries.sales.error">{{ queries.sales.error }}</p><p>售出 {{ number(queries.sales.data?.cups) }} 杯 · 奶茶券 {{ number(queries.sales.data?.token) }}</p>
    </section>

    <section data-gameplay="exchange" class="space-y-2">
      <h3 class="font-semibold">活动商城与专属种子</h3><p>结算期不再售卖专属种子；钻石或未知费用不可兑换。种子占地与专属图尚有待证项，详见活动管理。</p>
      <input v-model.number="exchangeCount" type="number" min="1" aria-label="兑换数量">
      <div v-for="goods in activity?.exchangeShop?.items || []" :key="goods.id">
        <span>{{ goods.name || '商品名称待确认' }} · 已购 {{ number(goods.purchasedCount) }} / {{ number(goods.purchaseLimit) }}</span>
        <span v-for="(item, index) in goods.rewards || []" :key="index"><img v-if="item.image" :src="item.image" :alt="item.name || '奖励'" class="inline h-8 w-8">{{ item.name || '奖励' }} × {{ number(item.count) }}<small v-if="!item.image">（专属图待补）</small><small v-else-if="item.iconStatus === 'generic'">（通用回退）</small></span>
        <button :disabled="busy || !!goods.diamondCostCount || !goods.costs?.length" @click="exchange(goods)">确认兑换 {{ goods.name || '商品' }}</button>
      </div>
      <p v-if="!activity?.exchangeShop">商城状态待确认</p>
    </section>

    <section data-gameplay="fund-share" class="space-y-2">
      <h3 class="font-semibold">成长基金与快乐值</h3><p>基金仅支持已解锁档位领取；付费解锁请在官方客户端完成。分享与好友快乐包链接也请在官方客户端使用。</p>
      <p>基金 {{ activity?.growthFund?.unlocked == null ? '待确认' : activity.growthFund.unlocked ? '已解锁' : '未解锁' }} · 快乐值 {{ number(activity?.shareReward?.currentScore) }}</p>
      <p v-for="tier in activity?.growthFund?.tiers || []" :key="tier.tierId">基金档位 {{ number(tier.tierId) }} · {{ activity?.growthFund?.unlocked === false ? '基金未解锁' : tier.state === 2 ? '可领取' : tier.state === 3 ? '已领取' : '暂不可领取' }}<span v-for="(item, index) in tier.reward || []" :key="index">{{ item.name || '奖励' }} × {{ number(item.count) }}<img v-if="item.image" :src="item.image" :alt="item.name || '奖励'" class="inline h-8 w-8"><small v-else>（专属图待补）</small></span></p>
      <p>每日快乐值领取 {{ activity?.shareReward?.daily?.rewardClaimed == null ? '待确认' : activity.shareReward.daily.rewardClaimed ? '已领取' : '未领取' }} · 次数 {{ number(activity?.shareReward?.daily?.claimedCount) }} / {{ number(activity?.shareReward?.daily?.claimLimit) }}</p>
      <p v-for="(tier, index) in activity?.shareReward?.milestones || []" :key="index">快乐值档位 {{ number(tier.threshold) }} · {{ tier.state === 2 ? '可领取' : tier.state === 3 ? '已领取' : '暂不可领取' }}<span v-for="(item, itemIndex) in tier.rewards || []" :key="itemIndex">{{ item.itemName || '未知物品' }} × {{ number(item.itemCount) }}<img v-if="item.image" :src="item.image" :alt="item.itemName || '奖励'" class="inline h-8 w-8"><small v-else>（专属图待补）</small></span></p>
      <button :disabled="busy || activity?.growthFund?.unlocked !== true" @click="prepare('fundClaim')">领取成长基金</button>
      <button :disabled="busy" @click="prepare('shareDaily')">领取每日快乐值</button>
      <button :disabled="busy" @click="prepare('shareMilestones')">领取快乐值档位</button>
    </section>
    <section data-gameplay="rules"><h3 class="font-semibold">活动规则与结算</h3><p v-for="(rule, index) in activity?.rules || []" :key="index" class="whitespace-pre-line">{{ rule }}</p><p v-if="!activity?.rules?.length">官方说明待确认</p></section>
    <div v-if="pending" role="dialog" aria-label="确认奶茶操作" class="border rounded p-3 space-x-3">
      <p>{{ pending.text }}</p><button :disabled="busy" @click="confirm">确认执行</button><button @click="pending = null">取消</button>
    </div>
  </article>
</template>
