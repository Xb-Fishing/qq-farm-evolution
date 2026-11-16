import { defineStore } from 'pinia'
import { ref } from 'vue'
import api from '@/api'
import { useAccountStore } from '@/stores/account'

export interface ActivityExchangeShopItem {
  id: number
  sort: number
  status: number
  owned: boolean
  isRepeatable?: boolean
  exchangeLimit?: number
  ownedBlocksExchange?: boolean
  statusLabel: string
  name: string
  itemId: number
  itemCount: number
  itemName: string
  image?: string
  itemType: number
  itemTypeLabel: string
  isDecoration: boolean
  currencyId: number
  currencyName: string
  price: number
  desc: string
  extra: string
}

export interface WeatherActivityItem {
  itemId: number
  itemCount: number
  itemName: string
  image?: string
}

export interface WeatherSubActivity {
  id: number
  parentId: number
  type: number
  title: string
  startTime: number
  endTime: number
  sort: number
  visible: boolean
  enabled: boolean
  status: number
  statusLabel: string
  feature: 'exchangeShop' | 'draw' | 'opaque'
  protobufField: number
  protobufState: 'declared_read_only' | 'opaque_read_only'
  protocolObserved: boolean
  available: boolean
}

export interface WeatherGameplayGuide {
  key: 'mutation' | 'collect' | 'summon' | 'research' | 'prank'
  title: string
  icon: 'rain' | 'collect' | 'summon' | 'research' | 'prank'
  evidence: string
  steps: string[]
  source: 'activity_rules'
  operationSupported: boolean
}

export interface WeatherActivityData {
  uid: string
  uidConfirmed: boolean
  clientUiUid: string
  title: string
  activityId: number
  startTime: number
  endTime: number
  visible: boolean
  enabled: boolean
  status: number
  active: boolean
  readOnly: boolean
  inventoryAvailable: boolean
  writeOperationsSupported: boolean
  writeBoundary: string
  rulesTitle: string
  ruleLines: string[]
  gameplayGuides: WeatherGameplayGuide[]
  ruleWarnings: string[]
  items: {
    weatherBottle: WeatherActivityItem
    drawReward: WeatherActivityItem
  }
  exchangeShop: ActivityExchangeShopItem[]
  draw: {
    freeMax: number
    freeUsed: number
    freeRemaining: number
    paidMax: number
    paidUsed: number
    paidRemaining: number
    paidCurrencyId: number
    paidPrice: number
    fallbackPrice: number
    currencyName: string
    rewardPool: Array<WeatherActivityItem & { id: number, rarity: number, probability: string }>
  }
  subActivities: WeatherSubActivity[]
  protocol: {
    declaredReadOnlyFields: number[]
    opaqueReadOnlyFields: number[]
    observedShape: Array<{ path: string, wire: number, count: number, byteLengths: number[] }>
  }
  summary: {
    subActivityCount: number
    enabledCount: number
    exchangeItemCount: number
    rewardPoolCount: number
    gameplayGuideCount: number
  }
}

export interface CharityActivityResource {
  key: 'seed' | 'fruit' | 'loveValue'
  kind: 'seed' | 'fruit' | 'currency'
  name: string
  itemId: number | null
  itemIdSource: 'current_farm_plant_mapping' | ''
  count: number | null
  image: string
  evidence: string
}

export interface CharityGameplayGuide {
  key: 'seed' | 'grow' | 'donate' | 'publicFund'
  title: string
  icon: 'task' | 'grow' | 'heart' | 'fund'
  evidence: string
  steps: string[]
  source: 'activity_rules'
  operationSupported: boolean
}

export interface CharityRewardGroup {
  key: 'daily' | 'personal' | 'global'
  title: string
  condition: string
  evidence: string
  items: Array<{ name: string, count: number }>
  source: 'activity_rules'
  statusAvailable: boolean
  operationSupported: boolean
}

export interface CharityNotice {
  key: 'fundLimit' | 'authorization' | 'automation' | 'settlement'
  title: string
  text: string
  evidence: string
  source: 'activity_rules'
}

export interface CharityActivityData {
  uid: string
  uidConfirmed: boolean
  clientUiUid: string
  clientUiUidConfirmed: boolean
  title: string
  activityId: number
  startTime: number
  endTime: number
  visible: boolean
  enabled: boolean
  status: number
  active: boolean
  participationEnabled: boolean
  readOnly: boolean
  progressAvailable: boolean
  inventoryAvailable: boolean
  imageEvidenceAvailable: boolean
  writeOperationsSupported: boolean
  manualOnly: boolean
  writeBoundary: string
  rulesTitle: string
  ruleLines: string[]
  gameplayGuides: CharityGameplayGuide[]
  rewardGroups: CharityRewardGroup[]
  notices: CharityNotice[]
  resources: CharityActivityResource[]
  subActivities: Array<{
    id: number
    parentId: number
    type: number
    title: string
    startTime: number
    endTime: number
    visible: boolean
    enabled: boolean
    status: number
    statusLabel: string
    clientUiUid: string
    protobufField: number
    protobufState: 'opaque_read_only'
    protocolObserved: boolean
    available: boolean
  }>
  protocol: {
    declaredReadOnlyFields: number[]
    opaqueReadOnlyFields: number[]
    observedShape: Array<{ path: string, wire: number, count: number, byteLengths: number[] }>
  }
  summary: {
    subActivityCount: number
    gameplayGuideCount: number
    rewardGroupCount: number
    noticeCount: number
    resourceCount: number
  }
}

export interface HeluDrawReward {
  itemId: number
  itemCount: number
  count?: number
  itemName: string
  name?: string
  image?: string
}

export interface HeluDrawCost {
  itemId?: number
  itemName?: string
  itemCount?: number
  image?: string
}

export interface HeluDrawResult {
  rewards?: HeluDrawReward[]
  items?: HeluDrawReward[]
  cost?: HeluDrawCost | null
}

export interface HeluSeasonRewardTier {
  level: number
  freeRewards: HeluDrawReward[]
  premiumRewards: HeluDrawReward[]
}

export interface HeluSeasonPassport {
  uid?: string
  title: string
  seasonTitle?: string
  currentLevel: number
  score?: number
  currentProgress?: number
  nextLevelNeed?: number
  maxLevel?: number
  freeClaimedLevel?: number
  premiumClaimedLevel?: number
  claimableLevels: number
  rewardTierCount?: number
  levelRewardTiers?: HeluSeasonRewardTier[]
  rewards?: HeluDrawReward[]
  configText?: string
  startTime?: number
  endTime?: number
  nowTime?: number
  warning?: string
}

export interface HeluSolarTerm {
  id: number
  title: string
  status: number
  statusLabel: string
  claimable: boolean
  claimStatusKnown?: boolean
  claimActive?: boolean
  wineActive?: boolean
  startTime: number
  endTime: number
  rewards: HeluDrawReward[]
}

export interface HeluSolarTerms {
  nowTime?: number
  terms: HeluSolarTerm[]
  claimableCount: number
  currentTerm?: HeluSolarTerm | null
  tipsText?: string
  warning?: string
}

export interface StarRecordItem {
  id: number
  title: string
  category: string
  explain: string
  graph: string
  featured: boolean
  unlocked: boolean
  claimed: boolean
  claimable: boolean
  rewards: HeluDrawReward[]
}

export interface StarGameplayGuide {
  key: 'daily' | 'claim'
  title: string
  icon: 'calendar' | 'claim'
  evidence: string
  steps: string[]
  source: 'activity_rules'
  operationSupported: false
}

export interface StarSubActivity {
  id: number
  parentId: number
  type: number
  feature: 'starRecord' | 'exchangeShop'
  title: string
  protobufField: number
  sort: number
  visible: boolean
  enabled: boolean
  status: number
  statusLabel: string
  available: boolean
  protocolObserved: boolean
}

export interface StarActivityData {
  uid: string
  uidConfirmed?: boolean
  clientUiUid?: string
  title: string
  activityId: number
  startTime?: number
  endTime?: number
  visible?: boolean
  enabled?: boolean
  status?: number
  inActivityWindow?: boolean
  starRecord: {
    status: number
    openedDays: number
    records: StarRecordItem[]
    totalCount: number
    unlockedCount: number
    claimedCount: number
    claimableCount: number
  }
  exchangeShop: ActivityExchangeShopItem[]
  shopReadOnly: boolean
  shopWarning?: string
  starSandCurrencyId: number
  starSandBalance: number
  rulesTitle?: string
  ruleLines?: string[]
  gameplayGuides?: StarGameplayGuide[]
  ruleWarnings?: string[]
  subActivities?: StarSubActivity[]
  protocol?: {
    declaredReadOnlyFields: number[]
  }
  writeOperationsDerivedFromRules?: boolean
  summary?: {
    starCount: number
    exchangeShopCount: number
    gameplayGuideCount: number
  }
  passport?: HeluSeasonPassport | null
  solarTerms?: HeluSolarTerms | null
  qingmei?: QingmeiActivity | null
  warning?: string
}

export type HeluSubActivityKey = 'giftLotus' | 'shop' | 'journey' | 'notes'

export interface QingmeiActivity {
  uid: string
  title: string
  activityId: number
  claimActivityId: number
  claimCommand: number
  wineActivityId?: number
  wineTitle?: string
  winePreviewCommand?: number
  wineBrewCommand?: number
  wineSellCommand?: number
  startTime?: number
  endTime?: number
  status?: number
  claimed: boolean
  claimable: boolean
  reward: HeluDrawReward
  material?: HeluDrawReward
  warning?: string
}

export interface QingmeiBrewResult {
  wineType: number
  cost: number
  price: number
  canDouble: boolean
}

export interface QingmeiSellResult {
  multiple: number
  gold: number
  item?: HeluDrawReward
}

export interface HeluSubActivity {
  key: HeluSubActivityKey
  id: number
  parentId: number
  title: string
  icon: string
  type: number
  sort: number
  status: number
  visible: boolean
  enabled: boolean
  startTime: number
  endTime: number
  payload?: Record<string, unknown> | null
  payloadSummary: Array<{ key: string, value: string }>
  hasDraw: boolean
  hasExchangeShop: boolean
  available: boolean
  source: string
}

export interface HeluActivityData {
  uid: string
  title: string
  activityId: number
  drawActivityId: number
  drawCommand: number
  draw: {
    freeMax: number
    freeUsed: number
    freeRemaining: number
    paidMax: number
    paidUsed: number
    paidRemaining: number
    paidPrice: number
    paidCurrencyId: number
    rewardPool: HeluDrawReward[]
    actions?: {
      one?: { count: number, available: boolean, cost: number, currencyId: number, type: string, label: string }
      batch?: { count: number, available: boolean, cost: number, currencyId: number, type: string, label: string }
    }
    dailyMax: number
    dailyUsed: number
    dailyRemaining: number
  }
  exchangeActivityId: number
  exchangeShop: ActivityExchangeShopItem[]
  subActivities: HeluSubActivity[]
  passport?: HeluSeasonPassport | null
  solarTerms?: HeluSolarTerms | null
  qingmei?: QingmeiActivity | null
  heluBalance: number
  lastDrawResult?: HeluDrawResult | null
  warning?: string
  summary: {
    rewardPoolCount: number
    exchangeShopCount: number
    activityCount: number
    subActivityCount?: number
    dailyUsed: number
    dailyRemaining: number
  }
  raw?: {
    activityCount?: number
    activityTitles?: string[]
    activityIds?: number[]
  }
}

export interface WishOperateState {
  remainingCount: number
  activityDay: number
  pending: null | {
    chooseId: number
    textId: number
    dayId: number
    rewards: Array<{ itemId: number, itemName: string, itemCount: number, image: string }>
  }
}

export interface ShareOperateState {
  scoreItemId: number
  currentScore: number
  dailyReward: number
  firstShareReward: number
  daily: { claimedCount: number, claimLimit: number, rewardClaimed: boolean, firstShareAwarded: boolean }
  milestones: Array<{ id: number, threshold: number, state: number, rewards: Array<{ itemId: number, itemName: string, itemCount: number, image: string }> }>
}

export interface SeasonRuleActivityData {
  activityId: number
  title: string
  startTime: number
  endTime: number
  statusLabel: string
  visible: boolean
  enabled: boolean
  status: number
  uid: string
  uidConfirmed: boolean
  clientUiUid: string
  readOnly: boolean
  writeOperationsSupported: boolean
  gameplayGuides: Array<{
    key: string
    title: string
    steps: string[]
    missingState: string
    actionLabel: string
    evidence: string
    operationSupported: false
    statusAvailable: false
  }>
  operateState?: WishOperateState | ShareOperateState | null
  choices?: Array<{ id: number, name: string }>
  resources?: Array<{
    key: string
    itemId: number | null
    name: string
    itemTypeLabel: string
    desc: string
    inventoryCount: number | null
  }>
  inventoryAvailable?: boolean
  notices: string[]
  ruleSections: Array<{ index: number, line: string }>
  subActivities: Array<{
    id: number
    title: string
    type: number
    parentId: number
    startTime: number
    endTime: number
    statusLabel: string
    clientUiUid: string
    protobufField: number
    protocolObserved: boolean
  }>
  protocol: { declaredReadOnlyFields: number[], opaqueReadOnlyFields: number[] }
  missingEvidence: string[]
}

export interface BearActivityData {
  activityId: number
  title: string
  startTime: number
  endTime: number
  statusLabel: string
  uid: string
  uidConfirmed: boolean
  clientUiUid: string
  inventoryAvailable: boolean
  gameplayGuides: Array<{
    key: string
    title: string
    steps: string[]
    missingState: string
    actionLabel: string
    /** 展示层提示：已在顶部「玩法手动操作」区开放的按钮键名，不代表写操作授权 */
    manualActions: string[]
    sourceId: number
    operationSupported: false
    statusAvailable: false
  }>
  notices: string[]
  conflicts: Array<{ title: string, text: string }>
  resources: Array<{ key: string, name: string, itemId: number | null, purpose: string, count: number | null, image: string }>
  exchangeShop: Array<ActivityExchangeShopItem & { inventoryCount: number | null, operationSupported: false }>
  records: Array<{ id: number, title: string, unlocked: boolean | null, claimed: boolean | null, rewards: WeatherActivityItem[] }>
  recordStateAvailable: boolean
  subActivities: Array<{
    id: number
    title: string
    type: number
    parentId: number
    startTime: number
    endTime: number
    statusLabel: string
    clientUiUid: string
    protobufField: number
    protocolObserved: boolean
  }>
  protocol: { declaredReadOnlyFields: number[], opaqueReadOnlyFields: number[] }
  ruleSections: Array<{ sourceId: number, key: string, title: string, lines: string[] }>
  missingEvidence: string[]
  /** 一键领取资格汇总（服务端 GetGroup 同条回包推导；未知时前端跳过不试写） */
  claimEligibility?: {
    available: boolean
    reason?: string
    stories?: number[]
    dogClaimable?: boolean
    compensationCount?: number
    seedsClaimable?: boolean
  } | null
}

export interface ClaimAllItemResult {
  key: string
  label: string
  status: 'success' | 'failed' | 'skipped'
  detail: string
}

export type ActivityKey = 'milkTea'
export type ActivityRetireReason = 'unavailable' | 'expired'
export interface ActivityRetiredInfo { reason: ActivityRetireReason }

export interface MilkTeaItem { id: number, count?: string | number, name?: string, image?: string, iconStatus?: string }
export interface MilkTeaShareReward {
  currentScore?: number
  daily?: { rewardClaimed?: boolean, firstShareAwarded?: boolean, claimedCount?: number, claimLimit?: number }
  milestones?: Array<{ id?: number, threshold?: number, state?: number, rewards?: Array<{ itemId?: number, itemCount?: number, itemName?: string, image?: string, description?: string }> }>
}
export interface MilkTeaExchangeBounds {
  requestMax: number
  limitKnown: boolean
  hasPurchaseLimit: boolean
  remainingLimit: number | null
  affordableCount: number | null
  maxCount: number | null
  blockReason: string
  unitCosts: Array<{ itemId: number, count: string, name: string }>
}
export interface MilkTeaAutomationStatus {
  unavailable?: boolean
  lastMessage?: string
  rewardsEnabled?: boolean
  seedsEnabled?: boolean
  workEnabled?: boolean
  upgradeEnabled?: boolean
  craftEnabled?: boolean
  hireEnabled?: boolean
  openEnabled?: boolean
  boostEnabled?: boolean
  hirePolicy?: { durationId: number, ticketDailyLimit: string, ticketReserve: string }
  reservedFruitStacks?: number
  pendingHires?: number
  familyReasons?: Record<string, string>
  seedReasons?: { name: string, reason: string }[]
  nextCheckAt?: number
  pendingPurchases?: number
  pendingInteractions?: number
  wagesPending?: boolean
  upgradePending?: boolean
}
export interface MilkTeaActivityData {
  activityId?: number
  title?: string
  timing?: { startTime?: number, endTime?: number, settleStartTime?: number, phase?: string }
  rules?: string[]
  summary?: { shopOpenAt?: number, shopName?: string, level?: number, totalRevenue?: number, canUpgrade?: boolean, hireDisabled?: boolean, hasUnclaimedWage?: boolean }
  inventory?: { available?: boolean, ticketCount?: number, boostItemCount?: number }
  exchangeShop?: { items?: Array<{ id: number, name?: string, rewards?: MilkTeaItem[], costs?: MilkTeaItem[], purchaseLimit?: number, purchaseLimitKnown?: boolean, purchasedCountKnown?: boolean, purchasedCount?: number, diamondCostCount?: number, exchangeBounds?: MilkTeaExchangeBounds }> }
  growthFund?: { unlocked?: boolean, tiers?: Array<{ tierId?: number, state?: number, conditions?: Array<{ reached?: boolean }>, reward?: MilkTeaItem[] }> }
  happyShareUpdate?: { notice: string, giftTiersAvailable: boolean, gifts: Array<{ id: number, name: string, platform: string, description: string, image?: string }> }
  shareReward?: MilkTeaShareReward
  automationStatus?: MilkTeaAutomationStatus | null
  gameplay?: Partial<Record<'shop' | 'workshop' | 'work', {
    available: boolean
    data: Record<string, any> | null
    error: string
    state?: 'not_open'
  }>>
}
export type MilkTeaQueryKind = 'shop' | 'hireList' | 'workshop' | 'work' | 'rank' | 'sales'
export interface MilkTeaQueryState { data: Record<string, any> | null, loading: boolean, error: string }

// Expired seasonal runtime has been removed; these independent reads remain.
export const useActivityStore = defineStore('activity', () => {
  type UpdateKind = 'evidence' | 'emails' | 'catalog' | 'dog' | 'collections'
  const updateReads = ref<Record<UpdateKind, { data: any, loading: boolean, error: string }>>({
    evidence: { data: null, loading: false, error: '' },
    emails: { data: null, loading: false, error: '' },
    catalog: { data: null, loading: false, error: '' },
    dog: { data: null, loading: false, error: '' },
    collections: { data: null, loading: false, error: '' },
  })
  const updateSeq: Record<UpdateKind, number> = { evidence: 0, emails: 0, catalog: 0, dog: 0, collections: 0 }
  function cancelUpdateReads(clear = false) {
    for (const key of ['evidence', 'emails', 'catalog', 'dog', 'collections'] as UpdateKind[]) {
      ++updateSeq[key]
      updateReads.value[key].loading = false
      if (clear)
        updateReads.value[key] = { data: null, loading: false, error: '' }
    }
  }
  async function loadUpdate(kind: UpdateKind, accountId: string) {
    if (!accountId || !isCurrentAccount(accountId) || updateReads.value[kind].loading)
      return { ok: false, cancelled: true }
    const seq = ++updateSeq[kind]
    const current = () => seq === updateSeq[kind] && isCurrentAccount(accountId)
    updateReads.value[kind].loading = true
    updateReads.value[kind].error = ''
    const endpoint = { evidence: 'game-update-evidence', emails: 'emails', catalog: 'game-update-catalog', dog: 'dog-state', collections: 'collection-state' }[kind]
    try {
      const { data } = await api.get(`/api/activity/${endpoint}`, { headers: { 'x-account-id': accountId }, timeout: 120000 })
      if (!current())
        return { ok: false, cancelled: true }
      if (data?.ok !== true)
        throw new Error(data?.error || '读取失败，请稍后刷新')
      const value = data[{ evidence: 'evidence', emails: 'snapshot', catalog: 'catalog', dog: 'state', collections: 'state' }[kind]]
      if (!value || typeof value !== 'object')
        throw new Error('状态不完整，请稍后刷新')
      if (kind === 'catalog' && (typeof value.source?.alias !== 'string' || !Array.isArray(value.series) || !Array.isArray(value.scores) || !Array.isArray(value.milestones)
        || value.series.some((group: any) => typeof group?.name !== 'string' || !Array.isArray(group.items) || !Array.isArray(group.stars)
          || group.items.some((item: any) => typeof item?.name !== 'string'))
        || value.scores.some((row: any) => !row || !Array.isArray(row.scores))
        || value.milestones.some((row: any) => !row || !Array.isArray(row.buffs)))) {
        throw new Error('目录状态不完整，请稍后刷新')
      }
      if (kind === 'emails' && (!value.boxes || typeof value.boxes !== 'object'))
        throw new Error('邮箱状态不完整，请稍后刷新')
      if (kind === 'evidence' && (!value.sources || typeof value.sources !== 'object' || Array.isArray(value.sources)
        || Object.values(value.sources).some(source => !source || typeof source !== 'object'))) {
        throw new Error('动态状态不完整，请稍后刷新')
      }
      const isCount = (count: unknown) => typeof count === 'string' && /^(?:0|[1-9]\d*)$/.test(count)
      if (kind === 'dog' && (!Array.isArray(value.dogs) || !Array.isArray(value.foods) || typeof value.currentDogName !== 'string'
        || typeof value.foodInventoryKnown !== 'boolean' || !isCount(value.pendingGiftCountDec) || value.feedingEnabled !== false
        || value.foods.some((food: any) => !food || typeof food.name !== 'string' || !isCount(food.countDec)))) {
        throw new Error('守卫犬状态不完整，请稍后刷新')
      }
      if (kind === 'collections' && (!Array.isArray(value.items) || !Array.isArray(value.displays) || !Number.isInteger(value.currentScore)
        || !Number.isInteger(value.claimedScore) || value.writesEnabled !== false
        || value.items.some((item: any) => !item || typeof item.name !== 'string' || !Number.isInteger(item.star) || item.star < 0 || item.star > 5 || !isCount(item.ownedCountDec))
        || value.displays.some((slot: any) => !slot || !Number.isInteger(slot.slotType) || typeof slot.name !== 'string'))) {
        throw new Error('珍藏室状态不完整，请稍后刷新')
      }
      updateReads.value[kind].data = value
      return { ok: true }
    }
    catch (error: any) {
      if (!current())
        return { ok: false, cancelled: true }
      updateReads.value[kind].error = String(error?.message || '读取失败')
      return { ok: false }
    }
    finally {
      if (current())
        updateReads.value[kind].loading = false
    }
  }

  function isCurrentAccount(accountId: string) {
    const accountStore = useAccountStore()
    const currentId = String((accountStore.currentAccountId as { value?: string })?.value ?? accountStore.currentAccountId ?? '')
    return currentId === String(accountId)
  }

  function clearActivityData() {
    cancelUpdateReads(true)
  }
  function cancelActivityReads() {
    cancelUpdateReads()
  }
  return { updateReads, loadUpdate, cancelUpdateReads, clearActivityData, cancelActivityReads }
})
