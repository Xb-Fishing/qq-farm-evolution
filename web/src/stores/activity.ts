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
  // 按活动独立的请求序号：祈愿/快乐不独享并发刷新时，共享计数器会作废先发出的一方
  // 并让它的 loading 永远不清（2026-09-24 面板"一直刷新"事故）
  const seasonRuleRequestIds: Record<'wish' | 'happyShare', number> = { wish: 0, happyShare: 0 }

  // 秋祈良愿 / 快乐不独享手动操作（写操作仅由面板按钮或一键领取触发；成功后由调用方重新拉取只读状态）
  const seasonWishOperating = ref('')
  // 单项操作代次：取消/切账号/新一轮开始后，旧 response 的 finally 不得清掉新代次的 busy
  let seasonWishOperateSeq = 0
  // 一键领取运行态：与单项操作互斥（运行中拒绝单项，单项进行中拒绝一键）
  const claimAllRunning = ref(false)
  const claimAllStep = ref('')
  const claimAllResults = ref<ClaimAllItemResult[]>([])
  let claimAllRunId = 0
  // 萌宠手动操作（写操作仅由面板按钮或一键领取触发；成功后由调用方重新拉取只读状态）
  const bearOperating = ref('')
  let bearOperateSeq = 0

  function clearActivityData() {
    ++bearRequestId
    ++seasonRuleRequestIds.wish
    ++seasonRuleRequestIds.happyShare
    // 账号切换：取消一键领取（停止后续请求），旧账号结果不展示给新账号；
    // 同时作废在飞单项操作代次，旧 response 的 finally 不得清掉新账号的 busy 状态
    ++claimAllRunId
    claimAllRunning.value = false
    claimAllStep.value = ''
    claimAllResults.value = []
    ++seasonWishOperateSeq
    ++bearOperateSeq
    seasonWishOperating.value = ''
    bearOperating.value = ''
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
    const kindKey = (kind === 'happyShare' ? 'happyShare' : 'wish') as 'wish' | 'happyShare'
    seasonRuleRequestIds[kindKey] = (seasonRuleRequestIds[kindKey] || 0) + 1
    const requestId = seasonRuleRequestIds[kindKey]
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
      if (requestId !== seasonRuleRequestIds[kindKey] || !isCurrentAccount(requestedId))
        return data
      dataRef.value = data.ok ? data.activity || null : null
      if (!data.ok)
        errorRef.value = data.error || `获取${isWish ? '秋祈良愿' : '快乐不独享'}失败`
      return data
    }
    catch (err: any) {
      const error = err.message || `获取${isWish ? '秋祈良愿' : '快乐不独享'}失败`
      if (requestId === (seasonRuleRequestIds[kind] ?? -2) && isCurrentAccount(requestedId)) {
        dataRef.value = null
        errorRef.value = error
      }
      return { ok: false, error }
    }
    finally {
      if (requestId === (seasonRuleRequestIds[kind] ?? -3))
        loading.value = false
    }
  }

  function fetchWishActivity(accountId: string) {
    return fetchSeasonRuleActivity('wish', accountId)
  }

  function fetchHappyShareActivity(accountId: string) {
    return fetchSeasonRuleActivity('happyShare', accountId)
  }

  // 实际发请求的内部入口（公共入口多一层一键互斥；runner 串行调用这里）
  async function performSeasonWishOperate(accountId: string, action: string, input: Record<string, unknown> = {}) {
    const opSeq = ++seasonWishOperateSeq
    seasonWishOperating.value = action
    try {
      const { data } = await api.post('/api/activity/season-wish/operate', {
        action,
        input,
      }, {
        headers: { 'x-account-id': accountId },
      })
      return data
    }
    catch (err: any) {
      return { ok: false, error: err?.response?.data?.error || err.message || '操作失败', status: err?.response?.status, code: err?.response?.data?.code }
    }
    finally {
      if (opSeq === seasonWishOperateSeq)
        seasonWishOperating.value = ''
    }
  }

  async function operateSeasonWish(accountId: string, action: string, input: Record<string, unknown> = {}) {
    if (!accountId || seasonWishOperating.value || claimAllRunning.value)
      return { ok: false, error: '操作进行中' }
    return performSeasonWishOperate(accountId, action, input)
  }

  async function performBearPetOperate(accountId: string, action: string, input: Record<string, unknown> = {}) {
    const opSeq = ++bearOperateSeq
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
      return { ok: false, error: err?.response?.data?.error || err.message || '操作失败', status: err?.response?.status, code: err?.response?.data?.code }
    }
    finally {
      if (opSeq === bearOperateSeq)
        bearOperating.value = ''
    }
  }

  async function operateBearPet(accountId: string, action: string, input: Record<string, unknown> = {}) {
    if (!accountId || bearOperating.value || claimAllRunning.value)
      return { ok: false, error: '操作进行中' }
    return performBearPetOperate(accountId, action, input)
  }

  // ===== 一键领取（编排层）：只复用上方已证实的手动写入口，不新增协议/命令 =====
  // 开始时先重读三组只读状态生成本轮计划（不依赖任意旧页面状态漏掉可领奖励），
  // 每一项写入仍由后端 List+GetGroup 资格闸门实时校验后才放行；任一读取失败/
  // 缺字段/活动未下发则该活动显式跳过、零写。绝不自动抽签/购买/分享/夺宝/消耗道具。
  function rewardText(rewards: unknown): string {
    if (!Array.isArray(rewards) || !rewards.length)
      return ''
    return rewards.filter(Boolean).map((item: any) => {
      const name = String(item?.itemName || item?.name || '道具')
      const count = item?.itemCount ?? item?.count
      return count == null ? name : `${name}×${Number(count)}`
    }).join('、')
  }

  function shareOperateStateOf(activity: SeasonRuleActivityData | null): ShareOperateState | null {
    const state = activity?.operateState
    return state && 'currentScore' in state ? state as ShareOperateState : null
  }

  /** 取消进行中的一键领取（账号切换/页面卸载）：停止后续请求，旧响应不回填。 */
  function cancelClaimAll() {
    ++claimAllRunId
    claimAllRunning.value = false
    claimAllStep.value = ''
  }

  // 写前资格校验业务码白名单：与 pet-diary-operate / season-wish-operate 两个服务在
  // 发出 Operate 写请求「之前」的 fail 调用点一一对应（一键只发 seeds/compensation/
  // claimDog/story/wishClaim/shareDaily/shareMilestones，白名单只收这些动作的资格码）。
  // 只有白名单内的 400 才能按「未写入跳过」归因；未知 code、REPLY_MISMATCH（写后）、
  // 无 code 的 400、其他错误一律视为结果未知，记失败不自动重试。
  const PRECONDITION_SKIP_CODES = new Set([
    // pet-diary-operate：List/GetGroup 重读后的写前校验
    'PET_DIARY_UNAVAILABLE',
    'PET_DIARY_INACTIVE',
    'PET_DIARY_NO_STATE',
    'PET_DIARY_ALREADY',
    'PET_DIARY_INVALID_STATE',
    'PET_DIARY_INVALID_INPUT',
    // season-wish-operate：同上写前校验
    'SEASON_WISH_UNAVAILABLE',
    'WISH_SIGN_NO_PENDING',
    'HAPPY_SHARE_INACTIVE',
    'HAPPY_SHARE_NO_STATE',
    'HAPPY_SHARE_CLAIMED',
    'HAPPY_SHARE_NO_CLAIMABLE',
  ])

  async function runClaimAll(accountIdRaw: string) {
    const accountId = String(accountIdRaw || '')
    if (!accountId)
      return { ok: false, error: '未选择账号', failedCount: 0, successCount: 0, skippedCount: 0 }
    if (claimAllRunning.value || seasonWishOperating.value || bearOperating.value)
      return { ok: false, error: '操作进行中，请稍后再试', failedCount: 0, successCount: 0, skippedCount: 0 }
    const runId = ++claimAllRunId
    const alive = () => runId === claimAllRunId && isCurrentAccount(accountId)
    claimAllRunning.value = true
    claimAllStep.value = '准备'
    claimAllResults.value = []
    const push = (item: ClaimAllItemResult) => {
      if (alive())
        claimAllResults.value.push(item)
    }

    // 单项写入：成功记奖励；400 且带写前资格校验业务码=未发生写，按跳过归因；
    // 其余一切失败（无 code 的 400、写后 REPLY_MISMATCH、502、网络）=结果未知，记失败且不自动重试。
    const step = async (key: string, label: string, kind: 'bear' | 'wish', action: string, input: Record<string, unknown>) => {
      claimAllStep.value = label
      const result = kind === 'bear'
        ? await performBearPetOperate(accountId, action, input)
        : await performSeasonWishOperate(accountId, action, input)
      if (!alive())
        return
      const code = String((result as any)?.code || '')
      if (result?.ok) {
        const rewards = rewardText((result as any).rewards)
        push({ key, label, status: 'success', detail: rewards ? `获得 ${rewards}` : '已领取' })
      }
      else if ((result as any)?.status === 400 && code && PRECONDITION_SKIP_CODES.has(code)) {
        push({ key, label, status: 'skipped', detail: `服务端资格校验未通过（未写入）：${String((result as any).error || '')}` })
      }
      else {
        push({ key, label, status: 'failed', detail: `${String((result as any)?.error || '操作失败')}（结果未知，不自动重试，请稍后刷新确认）` })
      }
    }

    const skip = (key: string, label: string, detail: string) =>
      push({ key, label, status: 'skipped', detail })

    try {
      // 0) 本轮资格先重读：写计划只认本轮服务端只读状态（服务端 ≤60s 读缓存），
      // 不依赖任意旧页面状态漏掉可领奖励。任一读取失败/活动未下发：该活动显式跳过、零写。
      claimAllStep.value = '读取活动资格'
      const [bearFresh, wishFresh, shareFresh] = await Promise.all([
        fetchBearActivity(accountId),
        fetchWishActivity(accountId),
        fetchHappyShareActivity(accountId),
      ])
      if (!alive())
        return finishRun(runId)

      // 1) S3 萌宠四类免费领取：资格只认服务端推导的 claimEligibility，未知即跳过不试写
      const bear = (bearFresh as any)?.ok ? (bearFresh as any).activity || null : null
      const eligibility = bear?.claimEligibility
      if (!(bearFresh as any)?.ok) {
        skip('bear', 'S3 萌宠', `活动状态读取失败（${String((bearFresh as any)?.error || '未知错误')}），跳过（本轮不试写）`)
      }
      else if (!eligibility) {
        skip('bear', 'S3 萌宠', '快照缺少实时领取资格，跳过（不试写）')
      }
      else if (eligibility.available !== true) {
        skip('bear', 'S3 萌宠', `${String(eligibility.reason || '当前不可领取')}，跳过`)
      }
      else {
        if (eligibility.seedsClaimable === true)
          await step('bear:seeds', 'S3 种子礼包', 'bear', 'seeds', {})
        if (!alive())
          return finishRun(runId)
        if (Number(eligibility.compensationCount || 0) > 0)
          await step('bear:compensation', 'S3 夺宝补偿', 'bear', 'compensation', {})
        if (!alive())
          return finishRun(runId)
        if (eligibility.dogClaimable === true)
          await step('bear:claimDog', 'S3 永久比熊', 'bear', 'claimDog', {})
        for (const order of (eligibility.stories || [])) {
          if (!alive())
            return finishRun(runId)
          await step(`bear:story:${order}`, `S3 手记 #${Number(order)}`, 'bear', 'story', { order: Number(order) })
        }
      }

      // 2) 秋祈良愿：只领取已抽出的待领签文（不自动抽签）
      if (alive()) {
        const wish = (wishFresh as any)?.ok ? (wishFresh as any).activity || null : null
        const wishState = wish?.operateState && 'remainingCount' in wish.operateState
          ? wish.operateState as WishOperateState
          : null
        if (!(wishFresh as any)?.ok)
          skip('wish', '秋祈良愿', `活动状态读取失败（${String((wishFresh as any)?.error || '未知错误')}），跳过（本轮不试写）`)
        else if (!wishState)
          skip('wish', '秋祈良愿', '服务端未下发祈愿状态，跳过（不试写）')
        else if (wishState.pending)
          await step('wish:claim', '秋祈良愿待领签文', 'wish', 'wishClaim', { chooseId: Number(wishState.pending.chooseId) })
        else
          skip('wish', '秋祈良愿', '没有待领取的祈愿奖励（已抽出才领取，不自动抽签）')
      }

      // 3) 快乐不独享：每日领取 → 重读状态（成功后路由已清只读缓存）→ 档位
      //    每日领取依赖的刷新失败时不得以旧 state 判档位：记跳过、不试写、不自动重试。
      const shareData = (shareFresh as any)?.ok ? (shareFresh as any).activity || null : null
      let shareState = shareOperateStateOf(shareData)
      if (alive()) {
        if (!(shareFresh as any)?.ok)
          skip('share', '快乐不独享', `活动状态读取失败（${String((shareFresh as any)?.error || '未知错误')}），跳过（本轮不试写）`)
        else if (!shareState)
          skip('share', '快乐不独享', '服务端未下发快乐值状态，跳过（不试写）')
      }
      let stateForMilestones: ShareOperateState | null = shareState
      if (alive() && shareState) {
        if (shareState.daily && shareState.daily.rewardClaimed === false) {
          await step('share:daily', '快乐值每日领取', 'wish', 'shareDaily', {})
          if (!alive())
            return finishRun(runId)
          // 每日领取会加快乐值，可能解锁新档位：必须以刷新后的服务端状态重算，不用旧缓存
          claimAllStep.value = '刷新快乐值状态'
          const fresh = await fetchHappyShareActivity(accountId)
          if (!alive())
            return finishRun(runId)
          const nextState = fresh?.ok === true ? shareOperateStateOf((fresh as any).activity || null) : null
          if (!nextState) {
            stateForMilestones = null
            skip('share:milestones', '快乐值档位奖励', fresh?.ok === true
              ? '每日领取后服务端未下发快乐值状态，跳过档位领取（不试写）'
              : `每日领取后状态刷新失败（${String(fresh?.error || '未知错误')}），档位不以旧状态继续（结果未知，不自动重试，请稍后刷新确认）`)
          }
          else {
            shareState = nextState
            stateForMilestones = nextState
          }
        }
        if (stateForMilestones) {
          const score = Number(stateForMilestones.currentScore || 0)
          const claimable = (stateForMilestones.milestones || []).some(tier =>
            Number(tier?.state) === 2 && score >= Number(tier?.threshold))
          if (!alive())
            return finishRun(runId)
          if (claimable)
            await step('share:milestones', '快乐值档位奖励', 'wish', 'shareMilestones', {})
          else if (stateForMilestones.daily)
            skip('share:milestones', '快乐值档位奖励', '当前没有可领取的快乐值档位')
        }
      }

      // 4) 收尾：尽力刷新三个只读状态；刷新失败不丢已领结果，只追加提示。
      //    fetch 内部 catch 后永远 fulfilled（返回 {ok:false}），所以要同时检查
      //    rejected 与 fulfilled.value.ok === false，不能只看 rejected。
      if (alive()) {
        claimAllStep.value = '刷新活动状态'
        const refreshed = await Promise.allSettled([
          fetchBearActivity(accountId),
          fetchWishActivity(accountId),
          fetchHappyShareActivity(accountId),
        ])
        if (alive() && refreshed.some(item => item.status === 'rejected'
          || (item.status === 'fulfilled' && item.value && (item.value as any).ok === false))) {
          skip('refresh', '刷新活动状态', '部分活动状态刷新失败，已领取结果以上方为准')
        }
      }
      return finishRun(runId)
    }
    catch (err: any) {
      // 整体意外异常：释放当前轮 busy 并保留已产生的结果，结果未知不自动重试。
      // 只比对代次（不调 alive：异常源可能正是账号状态读取本身）；已取消的旧轮不追加。
      if (runId === claimAllRunId) {
        claimAllResults.value.push({
          key: 'runner',
          label: '一键领取',
          status: 'failed',
          detail: `${String(err?.message || err || '编排异常')}（本轮已中止并释放，已领取结果保留；请稍后刷新确认）`,
        })
      }
      return finishRun(runId)
    }
  }

  function finishRun(runId: number) {
    if (runId !== claimAllRunId)
      return { ok: false, error: '已取消', failedCount: 0, successCount: 0, skippedCount: 0 }
    claimAllRunning.value = false
    claimAllStep.value = ''
    const results = claimAllResults.value
    const successCount = results.filter(item => item.status === 'success').length
    const failedCount = results.filter(item => item.status === 'failed').length
    const skippedCount = results.filter(item => item.status === 'skipped').length
    const summary = `一键领取完成：成功 ${successCount} 项、失败 ${failedCount} 项、跳过 ${skippedCount} 项`
    return { ok: failedCount === 0, error: failedCount ? summary : '', summary, successCount, failedCount, skippedCount }
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
    seasonWishOperating,
    operateSeasonWish,
    claimAllRunning,
    claimAllStep,
    claimAllResults,
    runClaimAll,
    cancelClaimAll,
  }
})
