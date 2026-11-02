<script setup lang="ts">
import { storeToRefs } from 'pinia'
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import api from '@/api'
import ConfirmModal from '@/components/ConfirmModal.vue'
import MallGoodsCard from '@/components/shop/MallGoodsCard.vue'
import MysteryGoodsCard from '@/components/shop/MysteryGoodsCard.vue'
import PurchaseQuantityModal from '@/components/shop/PurchaseQuantityModal.vue'
import ShopAccountHeader from '@/components/shop/ShopAccountHeader.vue'
import ShopTabToolbar from '@/components/shop/ShopTabToolbar.vue'
import BaseButton from '@/components/ui/BaseButton.vue'
import { useAccountStore } from '@/stores/account'
import { useShopStore } from '@/stores/shop'
import { useStatusStore } from '@/stores/status'
import { useToastStore } from '@/stores/toast'
import { exactText, newOperationId, purchaseMaximum } from '@/utils/commerce-quantity'

const accountStore = useAccountStore()
const shop = useShopStore()
const statusStore = useStatusStore()
const toast = useToastStore()
const route = useRoute()
const router = useRouter()
const { currentAccountId, currentAccount } = storeToRefs(accountStore)
const { status } = storeToRefs(statusStore)
const { seeds, pets, decorations, mallGoods, mysteryOffer, monthCard, recharge } = storeToRefs(shop)
const tab = ref<'seed' | 'pet' | 'decoration' | 'mall' | 'mystery'>('seed')
const zone = ref('featured')
const ascending = ref(true)
const busy = ref(false)
const mysteryAutoBuy = ref(false)
const nowSeconds = ref(Math.floor(Date.now() / 1000))
let expiryTimer: ReturnType<typeof setInterval> | undefined
const selection = ref<any>(null)
const mysteryAction = ref<'buy' | 'abandon' | null>(null)
let mounted = true
let generation = 0
const level = computed(() => status.value?.status?.level || 0)
const gold = computed(() => status.value?.status?.gold ?? null)
const coupon = computed(() => status.value?.status?.coupon ?? null)
const bean = computed(() => status.value?.status?.goldBean ?? shop.userGoldBean)
const diamond = computed(() => status.value?.status?.diamond ?? shop.userDiamond)
const loading = computed(() => shop.loading || shop.petLoading || shop.decorationLoading || shop.mallLoading || shop.mysteryLoading || shop.extraLoading)
const rows = computed<any[]>(() => tab.value === 'seed' ? [...seeds.value].sort((a, b) => ascending.value ? a.seedLevel - b.seedLevel : b.seedLevel - a.seedLevel) : tab.value === 'pet' ? pets.value : decorations.value)
const mallRows = computed(() => mallGoods.value.filter(item => (item.zone || 'unknown') === zone.value && (!item.endTime || nowSeconds.value < item.endTime)))
const error = computed(() => tab.value === 'seed' ? shop.error : tab.value === 'pet' ? shop.petError : tab.value === 'decoration' ? shop.decorationError : tab.value === 'mall' ? ['monthcard', 'recharge'].includes(zone.value) ? shop.extraError : shop.mallError : shop.mysteryError)
const zones = computed(() => [{ key: 'featured', title: '特惠（限时）' }, { key: 'packages', title: '礼包' }, { key: 'monthcard', title: '月卡' }, { key: 'recharge', title: '充值' }, ...(mallGoods.value.some(row => !row.zone) ? [{ key: 'unknown', title: '未核实分类' }] : [])])
function invalidate() {
  generation++
  selection.value = null
  mysteryAction.value = null
}
function balanceFor(item: any, mall = false) {
  if (mall)
    return item.balanceKnown ? item.currencyBalance : null
  return item.currencyId === 1005 ? bean.value : gold.value
}
function maximum(item: any, mall = false) {
  if (!mall && (item.requiredLevel || 0) > level.value)
    return '0'
  return purchaseMaximum(item, balanceFor(item, mall), mall)
}
function choose(item: any, mall = false) {
  if (busy.value || maximum(item, mall) === '0')
    return
  selection.value = { item: JSON.parse(JSON.stringify(item)), mall, account: String(currentAccountId.value), generation, operationId: newOperationId(), max: maximum(item, mall), balance: balanceFor(item, mall) }
}
async function refresh() {
  invalidate()
  const account = String(currentAccountId.value || '')
  if (!account)
    return
  if (tab.value === 'mall' && ['monthcard', 'recharge'].includes(zone.value))
    await shop.fetchMallExtra(account, zone.value as 'monthcard' | 'recharge')
  else
    await Promise.all([shop.refreshAll(account), statusStore.fetchStatus(account)])
}
async function refreshSettings(account: string) {
  const seq = generation
  try {
    const { data } = await api.get('/api/settings', { headers: { 'x-account-id': account } })
    if (mounted && seq === generation && account === String(currentAccountId.value))
      mysteryAutoBuy.value = data?.data?.automation?.mystery_shop_auto_buy === true
  }
  catch { /* settings read failure never changes a saved automation preference */ }
}
async function confirmQuantity(count: string) {
  const saved = selection.value
  if (!saved || busy.value || !mounted || saved.generation !== generation || saved.account !== String(currentAccountId.value))
    return
  busy.value = true
  try {
    const item = saved.item
    const request = { goodsId: saved.mall ? item.goodsId : item.goodsIdDec || item.id, count, quoteFingerprint: item.quoteFingerprint, operationId: saved.operationId, shopKind: item.shopKind }
    const result = saved.mall ? await shop.buyMallGoods(saved.account, request) : await shop.buyGoods(saved.account, request)
    if (!mounted || saved.account !== String(currentAccountId.value) || saved.generation !== generation)
      return
    selection.value = null
    if (result?.ok === true) {
      toast.success(result.data?.replayed ? '该操作已确认完成' : `已确认购买 ${item.name} × ${count} 份`)
      // A refresh failure cannot undo a confirmed write or repeat it.
      await Promise.all([shop.refreshAll(saved.account), statusStore.fetchStatus(saved.account)])
    }
    else {
      toast.error(result?.error || '交易未确认，请刷新后核对，不会自动重试')
    }
  }
  catch (error: any) {
    if (mounted && saved.account === String(currentAccountId.value) && saved.generation === generation) {
      selection.value = null
      toast.error(error.message || '交易结果未确认，请在游戏内核对')
    }
  }
  finally {
    busy.value = false
  }
}
async function confirmMystery() {
  if (!mysteryAction.value || busy.value || !mysteryOffer.value || !currentAccountId.value)
    return
  const account = String(currentAccountId.value)
  const seq = generation
  const action = mysteryAction.value
  const offer = mysteryOffer.value
  busy.value = true
  try {
    const result = action === 'buy' ? await shop.buyMysteryShopGoods(account, offer.npcId) : await shop.abandonMysteryShop(account)
    if (!mounted || seq !== generation || account !== String(currentAccountId.value))
      return
    mysteryAction.value = null
    if (result?.ok === true) {
      toast.success(action === 'buy' ? '神秘商人购买已确认' : '已请离神秘商人')
      await shop.fetchMysteryShop(account)
    }
    else {
      toast.error(result?.error || '操作未确认')
    }
  }
  catch (error: any) {
    if (mounted && seq === generation)
      toast.error(error.message || '操作未确认')
  }
  finally {
    busy.value = false
  }
}
watch([tab, zone], () => {
  invalidate()
  if (tab.value === 'mall' && ['monthcard', 'recharge'].includes(zone.value) && currentAccountId.value)
    shop.fetchMallExtra(String(currentAccountId.value), zone.value as 'monthcard' | 'recharge')
})
watch(() => [shop.seeds, shop.pets, shop.decorations, shop.mallGoods], () => {
  if (!busy.value)
    selection.value = null
})
watch(currentAccountId, () => {
  invalidate()
  shop.clearShopData()
  refresh()
  refreshSettings(String(currentAccountId.value || ''))
})
watch(() => route.query.tab, (value) => {
  if (['seed', 'pet', 'decoration', 'mall', 'mystery'].includes(String(value)))
    tab.value = value as typeof tab.value
})
onMounted(() => {
  expiryTimer = setInterval(() => {
    nowSeconds.value = Math.floor(Date.now() / 1000)
    if (selection.value?.item.endTime && nowSeconds.value >= selection.value.item.endTime)
      invalidate()
  }, 1000)
  if (['seed', 'pet', 'decoration', 'mall', 'mystery'].includes(String(route.query.tab)))
    tab.value = route.query.tab as typeof tab.value
  refresh()
  refreshSettings(String(currentAccountId.value || ''))
})
onUnmounted(() => {
  if (expiryTimer)
    clearInterval(expiryTimer)
  mounted = false
  invalidate()
})
</script>

<template>
  <section aria-label="商城" class="space-y-4">
    <div class="rounded-xl bg-white p-4 text-gray-900 shadow-sm space-y-5 dark:bg-gray-800 dark:text-gray-100">
      <ShopAccountHeader :account-name="currentAccount?.name" :level="level" :gold="Number(gold || 0)" :coupon="Number(coupon || 0)" :diamond="Number(diamond || 0)" :gold-bean="Number(bean || 0)" />
      <ShopTabToolbar v-model:tab="tab" :ascending="ascending" :loading="loading" :disabled="!currentAccountId || busy" @toggle-ascending="ascending = !ascending" @refresh="refresh" />
      <p v-if="!currentAccountId" class="py-6 text-center">
        请先选择账号。
      </p>
      <template v-else>
        <p v-if="error" role="alert" class="break-words rounded-lg bg-red-50 p-3 text-red-700 dark:bg-red-900/30 dark:text-red-200">
          {{ error }}；可刷新，保留上次可用数据。
        </p>
        <p v-if="loading" role="status" class="text-sm text-gray-500 dark:text-gray-300">
          正在读取商品状态…
        </p>
        <template v-if="tab === 'mall'">
          <nav aria-label="商城分类" class="flex flex-wrap gap-2">
            <BaseButton v-for="entry in zones" :key="entry.key" :variant="zone === entry.key ? 'primary' : 'outline'" :aria-pressed="zone === entry.key" @click="zone = entry.key">
              {{ entry.title }}
            </BaseButton>
          </nav>
          <template v-if="zone === 'monthcard'">
            <p class="text-sm">
              月卡购买需在游戏内打开「月卡商店」完成支付；此处只读取现有月卡信息。
            </p>
            <p v-if="monthCard && !monthCard.cards.length">
              当前未取得月卡条目；持有与到期状态以游戏内展示为准。
            </p>
            <article v-for="card in monthCard?.cards || []" :key="card.goodsId" class="border border-gray-200 rounded-lg p-4 space-y-2 dark:border-gray-600">
              <h3 class="font-semibold">
                月卡条目 {{ card.goodsId }}
              </h3>
              <p>{{ card.canClaim ? '上次读取时奖励可领取' : '上次读取时奖励不可领取' }}</p>
              <p>奖励：{{ card.reward.summary }}；持有期限以游戏内为准。</p>
            </article>
          </template>
          <template v-else-if="zone === 'recharge'">
            <p class="text-sm">
              请在 QQ 农场内打开「充值商店」，选择档位后按官方页面支付。首充资格以游戏内状态为准。
            </p>
            <div class="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <article v-for="tier in recharge?.tiers || []" :key="tier.id" class="border border-gray-200 rounded-lg p-4 space-y-2 dark:border-gray-600">
                <h3 class="font-semibold">
                  ¥{{ tier.priceYuan }}
                </h3><p>{{ exactText(tier.gainDiamond) }} 钻石</p>
                <p class="text-sm text-gray-500 dark:text-gray-300">
                  符合首充条件时另赠 {{ exactText(tier.firstChargeBonusDiamond) }} 钻石，资格以游戏内为准
                </p>
              </article>
            </div>
            <p v-for="note in recharge?.notes || []" :key="String(note)" class="break-words text-sm">
              {{ note }}
            </p>
          </template>
          <template v-else>
            <p class="text-sm text-gray-500 dark:text-gray-300">
              按当前商品和官方分类展示。每份奖励、可买数量以最新状态为准。
            </p>
            <p v-if="!loading && !mallRows.length">
              当前未获取到此分类的可用商品状态，请在游戏内对应商店查看。
            </p>
            <div class="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3 max-[360px]:grid-cols-1">
              <MallGoodsCard v-for="item in mallRows" :key="item.goodsId" :item="item" @buy="choose($event, true)" />
            </div>
          </template>
        </template>
        <template v-else-if="tab === 'mystery'">
          <div class="flex flex-wrap items-center justify-between gap-3">
            <p>神秘商人自动购买{{ mysteryAutoBuy ? '已开启' : '未开启' }}</p><BaseButton variant="outline" @click="router.push({ path: '/settings', query: { tab: 'automation' } })">
              前往设置
            </BaseButton>
          </div>
          <p v-if="!mysteryOffer?.active">
            神秘商人暂未出现。
          </p>
          <MysteryGoodsCard v-else :offer="mysteryOffer" :balance="Number(mysteryOffer.currencyId === 1002 ? coupon || 0 : mysteryOffer.currencyId === 1005 ? bean : gold || 0)" :loading="busy" @buy="mysteryAction = 'buy'" @abandon="mysteryAction = 'abandon'" />
        </template>
        <template v-else>
          <p v-if="!loading && !rows.length">
            当前没有商品，请刷新后查看。
          </p>
          <div class="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-3 max-[360px]:grid-cols-1">
            <article v-for="item in rows" :key="item.id" class="min-w-0 flex flex-col gap-3 border border-gray-200 rounded-xl p-4 dark:border-gray-600">
              <img v-if="item.image" :src="item.image" :alt="item.name" class="mx-auto h-14 w-14 object-contain">
              <h3 class="break-words font-semibold">
                {{ item.name }}
              </h3>
              <p class="text-sm">
                {{ exactText(item.priceDec ?? item.price) }} {{ item.currencyId === 1005 ? '金豆豆' : '金币' }} / 份
              </p>
              <p class="text-sm">
                每份 {{ exactText(item.itemCountDec ?? item.itemCount) }} 件 · 剩余可买 {{ exactText(maximum(item)) }} 份
              </p>
              <p v-if="item.requiredLevel" class="text-sm">
                需要 {{ item.requiredLevel }} 级
              </p>
              <p v-if="item.seasons" class="text-sm">
                {{ item.seasons }} 季 · 每季收益 {{ exactText(item.incomePerSeason) }} 金币 · 经验 {{ exactText(item.expPerSeason) }}
              </p>
              <p v-if="item.desc || item.effectDesc" class="break-words text-sm text-gray-500 dark:text-gray-300">
                {{ item.desc || item.effectDesc }}
              </p>
              <p v-if="maximum(item) === '0'" class="text-sm text-red-600 dark:text-red-300">
                额度已用尽、余额不足或资格未确认。
              </p>
              <BaseButton class="mt-auto min-h-11" variant="primary" :disabled="busy || maximum(item) === '0'" @click="choose(item)">
                选择购买数量
              </BaseButton>
            </article>
          </div>
        </template>
      </template>
    </div>
    <PurchaseQuantityModal :show="!!selection" :item-name="selection?.item.name || ''" :unit-price="(selection?.item.isFree ? 0 : selection?.mall ? selection?.item.price.amountDec : selection?.item.priceDec) ?? null" :currency-label="selection?.mall ? selection?.item.currencyName || '' : selection?.item.currencyId === 1005 ? '金豆豆' : '金币'" :balance="selection?.balance" :max-quantity="selection?.max || '0'" :item-count="selection?.mall ? selection?.item.items.reduce((sum: bigint, item: any) => sum + BigInt(item.countDec), 0n).toString() : selection?.item.itemCountDec || '1'" :loading="busy" :is-free="!!selection?.item.isFree" @confirm="confirmQuantity" @close="!busy && (selection = null)" @cancel="!busy && (selection = null)" />
    <ConfirmModal :show="!!mysteryAction" :title="mysteryAction === 'buy' ? '确认购买神秘商品' : '请离神秘商人'" :message="mysteryAction === 'buy' ? `购买 ${mysteryOffer?.itemName} × ${mysteryOffer?.itemCount}，总消耗 ${exactText(mysteryOffer?.price)} ${mysteryOffer?.currencyName}，完成后商人离开。` : '确定请离当前神秘商人？'" :loading="busy" @confirm="confirmMystery" @close="!busy && (mysteryAction = null)" @cancel="!busy && (mysteryAction = null)" />
  </section>
</template>
