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
}

export const useActivityStore = defineStore('activity', () => {
  const bearActivity = ref<BearActivityData | null>(null)
  const bearLoading = ref(false)
  const bearError = ref('')
  let bearRequestId = 0

  // 说明驱动的只读活动（秋祈良愿 / 快乐不独享）；共享一个请求代次防止账号切换旧响应回填
  const wishActivity = ref<SeasonRuleActivityData | null>(null)
  const wishLoading = ref(false)
  const wishError = ref('')
  const happyShareActivity = ref<SeasonRuleActivityData | null>(null)
  const happyShareLoading = ref(false)
  const happyShareError = ref('')
  let seasonRuleRequestId = 0

  function clearActivityData() {
    ++bearRequestId
    ++seasonRuleRequestId
    bearActivity.value = null
    bearLoading.value = false
    bearError.value = ''
    wishActivity.value = null
    wishLoading.value = false
    wishError.value = ''
    happyShareActivity.value = null
    happyShareLoading.value = false
    happyShareError.value = ''
  }

  function isCurrentAccount(accountId: string) {
    const accountStore = useAccountStore()
    const currentId = String((accountStore.currentAccountId as { value?: string })?.value ?? accountStore.currentAccountId ?? '')
    return currentId === String(accountId)
  }

  async function fetchBearActivity(accountId: string) {
    if (!accountId)
      return
    const requestedId = String(accountId)
    const requestId = ++bearRequestId
    bearLoading.value = true
    bearError.value = ''
    try {
      const { data } = await api.get('/api/activity/bear', {
        headers: { 'x-account-id': accountId },
      })
      if (requestId !== bearRequestId || !isCurrentAccount(requestedId))
        return data
      bearActivity.value = data.ok ? data.activity || null : null
      if (!data.ok)
        bearError.value = data.error || '获取 S3 萌宠失败'
      return data
    }
    catch (err: any) {
      const error = err.message || '获取 S3 萌宠失败'
      if (requestId === bearRequestId && isCurrentAccount(requestedId)) {
        bearActivity.value = null
        bearError.value = error
      }
      return { ok: false, error }
    }
    finally {
      if (requestId === bearRequestId)
        bearLoading.value = false
    }
  }

  // 秋祈良愿 / 快乐不独享：纯只读快照，无操作入口
  async function fetchSeasonRuleActivity(
    kind: 'wish' | 'happyShare',
    accountId: string,
  ) {
    if (!accountId)
      return
    const requestedId = String(accountId)
    const requestId = ++seasonRuleRequestId
    const isWish = kind === 'wish'
    const loading = isWish ? wishLoading : happyShareLoading
    const errorRef = isWish ? wishError : happyShareError
    const dataRef = isWish ? wishActivity : happyShareActivity
    loading.value = true
    errorRef.value = ''
    try {
      const { data } = await api.get(isWish ? '/api/activity/wish' : '/api/activity/happy-share', {
        headers: { 'x-account-id': accountId },
      })
      if (requestId !== seasonRuleRequestId || !isCurrentAccount(requestedId))
        return data
      dataRef.value = data.ok ? data.activity || null : null
      if (!data.ok)
        errorRef.value = data.error || `获取${isWish ? '秋祈良愿' : '快乐不独享'}失败`
      return data
    }
    catch (err: any) {
      const error = err.message || `获取${isWish ? '秋祈良愿' : '快乐不独享'}失败`
      if (requestId === seasonRuleRequestId && isCurrentAccount(requestedId)) {
        dataRef.value = null
        errorRef.value = error
      }
      return { ok: false, error }
    }
    finally {
      if (requestId === seasonRuleRequestId)
        loading.value = false
    }
  }

  function fetchWishActivity(accountId: string) {
    return fetchSeasonRuleActivity('wish', accountId)
  }

  function fetchHappyShareActivity(accountId: string) {
    return fetchSeasonRuleActivity('happyShare', accountId)
  }

  // 萌宠手动操作（写操作仅由面板按钮触发；成功后由调用方重新拉取只读状态）
  const bearOperating = ref('')
  async function operateBearPet(accountId: string, action: string, input: Record<string, unknown> = {}) {
    if (!accountId || bearOperating.value)
      return { ok: false, error: '操作进行中' }
    bearOperating.value = action
    try {
      const { data } = await api.post('/api/activity/pet-diary/operate', {
        action,
        input,
      }, {
        headers: { 'x-account-id': accountId },
      })
      return data
    }
    catch (err: any) {
      return { ok: false, error: err?.response?.data?.error || err.message || '操作失败' }
    }
    finally {
      bearOperating.value = ''
    }
  }

  return {
    bearActivity,
    bearLoading,
    bearError,
    bearOperating,
    clearActivityData,
    fetchBearActivity,
    operateBearPet,
    wishActivity,
    wishLoading,
    wishError,
    fetchWishActivity,
    happyShareActivity,
    happyShareLoading,
    happyShareError,
    fetchHappyShareActivity,
  }
})
