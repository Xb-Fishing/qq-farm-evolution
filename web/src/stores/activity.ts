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
  daily?: { rewardClaimed?: boolean, claimedCount?: number, claimLimit?: number }
  milestones?: Array<{ id?: number, threshold?: number, state?: number, rewards?: Array<{ itemId?: number, itemCount?: number, itemName?: string, image?: string }> }>
}
export interface MilkTeaActivityData {
  activityId?: number
  title?: string
  timing?: { startTime?: number, endTime?: number, settleStartTime?: number, phase?: string }
  rules?: string[]
  summary?: { shopOpenAt?: number, shopName?: string, level?: number, totalRevenue?: number, canUpgrade?: boolean, hireDisabled?: boolean, hasUnclaimedWage?: boolean }
  inventory?: { available?: boolean, ticketCount?: number, boostItemCount?: number }
  exchangeShop?: { items?: Array<{ id: number, name?: string, rewards?: MilkTeaItem[], costs?: MilkTeaItem[], purchaseLimit?: number, purchasedCount?: number, diamondCostCount?: number }> }
  growthFund?: { unlocked?: boolean, tiers?: Array<{ tierId?: number, state?: number, conditions?: Array<{ reached?: boolean }>, reward?: MilkTeaItem[] }> }
  shareReward?: MilkTeaShareReward
  gameplay?: Partial<Record<'shop' | 'workshop' | 'work', {
    available: boolean
    data: Record<string, any> | null
    error: string
    state?: 'not_open'
  }>>
}
export type MilkTeaQueryKind = 'shop' | 'hireList' | 'workshop' | 'work' | 'rank' | 'sales'
export interface MilkTeaQueryState { data: Record<string, any> | null, loading: boolean, error: string }

export const useActivityStore = defineStore('activity', () => {
  // ===== 奶茶热销中（S4，2026110100 族）=====
  // 旧 S3 萌宠 / 秋祈良愿 / 快乐不独享已随 S4 轮换整链退役（路由不再注册、
  // provider/Worker 转发移除）；本 store 只保留类型导出供历史组件编译，
  // 运行态全部切换为奶茶活动。
  const milkTeaActivity = ref<MilkTeaActivityData | null>(null)
  const milkTeaLoading = ref(false)
  const milkTeaError = ref('')
  let milkTeaRequestId = 0

  // 六种显式查询各自独立的请求代次与 loading/error：并发查询互不作废
  // （沿用 2026-09-24「一直刷新」事故的按活动独立序号经验）
  const milkTeaQueries = ref<Record<MilkTeaQueryKind, MilkTeaQueryState>>({
    shop: { data: null, loading: false, error: '' },
    hireList: { data: null, loading: false, error: '' },
    workshop: { data: null, loading: false, error: '' },
    work: { data: null, loading: false, error: '' },
    rank: { data: null, loading: false, error: '' },
    sales: { data: null, loading: false, error: '' },
  })
  const milkTeaQueryIds: Record<MilkTeaQueryKind, number> = { shop: 0, hireList: 0, workshop: 0, work: 0, rank: 0, sales: 0 }

  // 手动操作（写操作仅由面板按钮或一键领取触发；成功后由调用方重新拉取只读状态）
  const milkTeaOperating = ref('')
  // 单项操作代次：取消/切账号/新一轮开始后，旧 response 的 finally 不得清掉新代次的 busy
  let milkTeaOperateSeq = 0
  // 一键领取运行态：与单项操作互斥（运行中拒绝单项，单项进行中拒绝一键）
  const claimAllRunning = ref(false)
  const claimAllStep = ref('')
  const claimAllResults = ref<ClaimAllItemResult[]>([])
  let claimAllRunId = 0
  // 页面生命周期代次：卸载（cancelActivityReads）与切账号（clearActivityData）各推进一次。
  // 在飞单项写操作在响应落地时对账：代次已变 = 旧回调，返回 cancelled，页面不弹提示、
  // 不启动新刷新（切账号往返后账号串恰好相等也靠代次识别，不依赖字符串比较）。
  let activityLifecycleSeq = 0

  // ===== 活动下架门控（沿用 2026-10-08 语义，键收敛为 milkTea）=====
  // 下架判据只有两种：读取路由的结构化 unavailable:true（官方 List 不再下发该活动），
  // 或「已落地快照」的有效 endTime 到期。enabled:false、普通网络错误、账号离线、
  // 空快照、未知错误都不是下架证据。下架后清旧快照与旧错误、面板换下架说明；
  // 同账号普通刷新与一键领取对该活动零读取零写入，只有用户显式「重新检查」再读一次。
  const activityRetired = ref<Record<ActivityKey, ActivityRetiredInfo | null>>({ milkTea: null })
  // 到期计时绑定「已落地快照」而不是请求开始代次：发起第二次读取不取消旧计时
  // （旧快照仍在展示，到点仍须撤下）；只有新快照落地/显式恢复/切账号会推进令牌，
  // 旧计时因此不会误撤新快照。卸载只作废在飞读取，迟到响应不能重建计时。
  const expiryTimers: Record<ActivityKey, any> = { milkTea: null }
  const expiryTokens: Record<ActivityKey, number> = { milkTea: 0 }

  // 已核实格式的有效截止时间（秒）：正的有限数值；0/缺失/无效一律「未知截止」，不猜测
  function validEndTimeOf(activity: unknown): number {
    const timing = (activity as { timing?: { endTime?: unknown } } | null)?.timing
    const direct = Number((activity as { endTime?: unknown } | null)?.endTime)
    const end = Number.isFinite(direct) && direct > 0 ? direct : Number(timing?.endTime)
    return Number.isFinite(end) && end > 0 ? Math.floor(end) : 0
  }

  /** 「重新检查解除下架」的快照合法性：非空普通对象。数组/字符串/数字/null/空对象都
   * 不是合法快照，不得凭它们恢复展示（合法但未知截止的快照可恢复，不据此误判结束）。
   * 只约束显式恢复条件；正常读取的快照落地不经过此判断。 */
  function isRecoverableSnapshot(activity: unknown): boolean {
    return typeof activity === 'object'
      && activity !== null
      && !Array.isArray(activity)
      && Object.keys(activity).length > 0
  }

  function isActivityRetired(key: ActivityKey) {
    return activityRetired.value[key] != null
  }

  function retireActivity(key: ActivityKey, reason: ActivityRetireReason) {
    if (expiryTimers[key]) {
      clearTimeout(expiryTimers[key])
      expiryTimers[key] = null
    }
    ++expiryTokens[key]
    activityRetired.value[key] = { reason }
    // 清旧快照与旧错误：下架不是读取错误，也不得继续展示过期数据
    if (key === 'milkTea') {
      milkTeaActivity.value = null
      milkTeaError.value = ''
    }
  }

  function currentSnapshotOf(key: ActivityKey): unknown {
    if (key === 'milkTea')
      return milkTeaActivity.value
    return null
  }

  /** 写入口同步核对：下架标记，或「当前快照的有效截止已实际到期但到期计时尚未执行」
   * （卸载已释放计时、事件循环忙于定时器回调前）都算已结束；后者当场同步落地 expired
   * 下架（面板与后续写步骤立即撤下），不等计时回调。零请求、零猜测（未知截止不拦）。 */
  function activityEndedNow(key: ActivityKey) {
    if (activityRetired.value[key] != null)
      return true
    const end = validEndTimeOf(currentSnapshotOf(key))
    if (end && end * 1000 <= Date.now()) {
      retireActivity(key, 'expired')
      return true
    }
    return false
  }

  function scheduleExpiry(key: ActivityKey, endTimeSec: number) {
    if (expiryTimers[key])
      clearTimeout(expiryTimers[key])
    const token = ++expiryTokens[key]
    const timer: any = setTimeout(() => {
      if (token !== expiryTokens[key] || isActivityRetired(key))
        return // 新快照已重排计时并推进令牌，或已下架：旧计时不误撤
      expiryTimers[key] = null
      // 回调落地前再核对「当前快照的有效截止」与实际时间：定时器被提前/截断触发
      // 或当前快照截止已被新数据推后时，不得提前下架
      const currentEnd = validEndTimeOf(currentSnapshotOf(key))
      if (currentEnd && currentEnd * 1000 <= Date.now())
        retireActivity(key, 'expired')
      else if (currentEnd)
        scheduleExpiry(key, currentEnd)
    }, Math.min(2_147_483_647, Math.max(0, endTimeSec * 1000 - Date.now())))
    if (typeof timer?.unref === 'function')
      timer.unref() // 长截止的计时不得阻塞页面/测试进程退出
    expiryTimers[key] = timer
  }

  function clearExpiry(key: ActivityKey) {
    if (expiryTimers[key]) {
      clearTimeout(expiryTimers[key])
      expiryTimers[key] = null
    }
    ++expiryTokens[key]
  }

  /** 页面卸载：作废在飞读取（快照 + 六种查询）并完整释放到期计时（清计时+推进令牌），
   * 迟到响应不回填快照/错误/loading、不在页外重建计时；下架状态与已落地快照的截止
   * 证据保留给重进页面（重进先 sweepExpiredActivities 同步清扫，再由正常刷新为仍
   * 有效快照重排计时）。 */
  function cancelActivityReads() {
    ++activityLifecycleSeq
    ++milkTeaOperateSeq
    milkTeaOperating.value = ''
    ++milkTeaRequestId
    milkTeaLoading.value = false
    for (const kind of Object.keys(milkTeaQueryIds) as MilkTeaQueryKind[]) {
      ++milkTeaQueryIds[kind]
      milkTeaQueries.value[kind].loading = false
    }
    clearExpiry('milkTea')
  }

  /** 页面进入时同步清扫：已过有效截止的落地快照立即下架；仍有效的保留快照恢复到期计时
   * （零请求，不展示过期缓存，也不等新响应才重建截止保护）。 */
  function sweepExpiredActivities() {
    const key: ActivityKey = 'milkTea'
    if (isActivityRetired(key))
      return
    const end = validEndTimeOf(currentSnapshotOf(key))
    if (end && end * 1000 <= Date.now()) {
      retireActivity(key, 'expired')
      return
    }
    // 仍有效的保留快照：重进页面时恢复到期计时。卸载已释放旧计时，不能等新响应
    // 落地才重建保护——重进后的刷新缓慢/失败期间，快照到点仍会被零请求撤下。
    if (end)
      scheduleExpiry(key, end)
  }

  // 显式重新检查（下架卡片按钮触发）：每次只读所选活动一次。有效未过期响应恢复展示；
  // unavailable/过期保持下架；普通失败不改下架状态、不自动重试；不发任何写请求。
  async function recheckActivity(kind: ActivityKey, accountId: string) {
    if (kind === 'milkTea')
      return fetchMilkTeaActivity(accountId, { recheck: true })
    return { ok: false, error: '未知活动' }
  }

  function clearActivityData() {
    ++activityLifecycleSeq
    ++milkTeaRequestId
    // 账号切换：下架证据与到期计时属于旧账号，一并清掉（豁免通道与快照照旧清空）
    clearExpiry('milkTea')
    activityRetired.value.milkTea = null
    // 账号切换：取消一键领取（停止后续请求），旧账号结果不展示给新账号；
    // 同时作废在飞单项操作与查询代次，旧 response 的 finally 不得清掉新账号的 busy
    ++claimAllRunId
    claimAllRunning.value = false
    claimAllStep.value = ''
    claimAllResults.value = []
    ++milkTeaOperateSeq
    milkTeaOperating.value = ''
    milkTeaActivity.value = null
    milkTeaLoading.value = false
    milkTeaError.value = ''
    for (const kind of Object.keys(milkTeaQueryIds) as MilkTeaQueryKind[]) {
      ++milkTeaQueryIds[kind]
      milkTeaQueries.value[kind] = { data: null, loading: false, error: '' }
    }
  }

  function isCurrentAccount(accountId: string) {
    const accountStore = useAccountStore()
    const currentId = String((accountStore.currentAccountId as { value?: string })?.value ?? accountStore.currentAccountId ?? '')
    return currentId === String(accountId)
  }

  async function fetchMilkTeaActivity(accountId: string, options: { recheck?: boolean } = {}) {
    if (!accountId)
      return
    // 下架门：普通刷新/一键领取对已下架活动零读取；显式重新检查才放行
    if (!options.recheck && activityEndedNow('milkTea'))
      return { ok: false, retired: true, error: '活动已结束' }
    const requestedId = String(accountId)
    const requestId = ++milkTeaRequestId
    const initialQueryIds = { ...milkTeaQueryIds }
    const initialQueryBusy = { shop: milkTeaQueries.value.shop.loading, workshop: milkTeaQueries.value.workshop.loading, work: milkTeaQueries.value.work.loading }
    milkTeaLoading.value = true
    milkTeaError.value = ''
    try {
      const { data } = await api.get('/api/activity/milk-tea', {
        headers: { 'x-account-id': accountId },
      })
      if (requestId !== milkTeaRequestId || !isCurrentAccount(requestedId))
        // 请求已被新一轮/切账号/页面卸载作废：迟到响应不回填，也不给调用方可消费的结果
        return { ok: false, cancelled: true, error: '已取消' }
      if ((data as any)?.unavailable === true) {
        retireActivity('milkTea', 'unavailable')
        return { ok: false, unavailable: true, retired: true, error: String((data as any).error || '活动已结束') }
      }
      if ((data as any)?.ok === true) {
        const activity = (data as any).activity || null
        const end = validEndTimeOf(activity)
        if (end && end * 1000 <= Date.now()) {
          // 有效截止时间已过：下架；读取返回值不得继续提供可消费的过期资格
          retireActivity('milkTea', 'expired')
          return { ok: false, retired: true, expired: true, error: '活动已结束（已过截止时间）' }
        }
        if (isActivityRetired('milkTea')) {
          if (!options.recheck)
            return { ok: false, retired: true, error: '活动已结束' }
          // 显式恢复：仅当前代次、非空合法（非空普通对象）、有效未过期快照可解除下架
          if (!isRecoverableSnapshot(activity))
            return { ok: false, retired: true, error: '重新检查未返回有效活动数据，保持下架（未恢复）' }
          activityRetired.value.milkTea = null
        }
        milkTeaActivity.value = activity
        // The first-page GET includes one bounded batch of the three core views.
        // A manual query begun before/during this GET retains its own ownership.
        for (const kind of ['shop', 'workshop', 'work'] as const) {
          const entry = activity?.gameplay?.[kind]
          if (!entry || initialQueryBusy[kind] || initialQueryIds[kind] !== milkTeaQueryIds[kind])
            continue
          const valid = entry.available === true && entry.data && typeof entry.data === 'object'
            && !Array.isArray(entry.data) && Object.keys(entry.data).length > 0
          if (valid)
            milkTeaQueries.value[kind] = { data: entry.data, loading: false, error: '' }
          else if (entry.state === 'not_open')
            milkTeaQueries.value[kind] = { data: null, loading: false, error: '' }
          else
            milkTeaQueries.value[kind] = { ...milkTeaQueries.value[kind], loading: false, error: entry.error || '玩法状态读取失败，请刷新重试' }
        }
        if (end)
          scheduleExpiry('milkTea', end)
        else
          clearExpiry('milkTea') // 新快照无有效截止：不猜测，也不沿用旧快照的计时
        return data
      }
      // 普通失败（含账号离线/网络/未知错误与非严格成功标记）：不是下架证据，不提前判定结束。
      // 已落地快照与截止证据保留——失败清快照会让到期计时与写入口同步核对失去依据，
      // 到点无法零请求撤下；错误横幅照常展示，返回值 ok 一律严格 false
      milkTeaError.value = (data as any)?.error || '获取奶茶热销中失败'
      return { ok: false, error: milkTeaError.value }
    }
    catch (err: any) {
      const error = err.message || '获取奶茶热销中失败'
      if (requestId === milkTeaRequestId && isCurrentAccount(requestedId)) {
        // 网络拒绝/超时与普通失败同规则：保留已落地快照与截止证据，只记录错误横幅
        milkTeaError.value = error
      }
      else {
        // 过时代次的异常（网络拒绝/超时迟到）：与迟到成功响应同样标记已取消
        return { ok: false, cancelled: true, error: '已取消' }
      }
      return { ok: false, error }
    }
    finally {
      if (requestId === milkTeaRequestId)
        milkTeaLoading.value = false
    }
  }

  /** 显式查询（shop/hireList/workshop/work/rank/sales）：仅用户点击触发，各自独立
   * loading/代次；不自动轮询、不后台翻页。 */
  async function runMilkTeaQuery(kind: MilkTeaQueryKind, accountId: string, params: Record<string, unknown> = {}) {
    if (!accountId)
      return { ok: false, error: '未选择账号' }
    if (activityEndedNow('milkTea'))
      return { ok: false, retired: true, error: '活动已结束' }
    const requestedId = String(accountId)
    const requestId = ++milkTeaQueryIds[kind]
    milkTeaQueries.value[kind] = { ...milkTeaQueries.value[kind], loading: true, error: '' }
    try {
      const { data } = await api.post('/api/activity/milk-tea/query', { kind, params }, {
        headers: { 'x-account-id': accountId },
      })
      if (requestId !== milkTeaQueryIds[kind] || !isCurrentAccount(requestedId))
        return { ok: false, cancelled: true, error: '已取消' }
      if ((data as any)?.ok === true) {
        milkTeaQueries.value[kind] = { data: (data as any).data || null, loading: false, error: '' }
        return data
      }
      const error = String((data as any)?.error || '查询失败')
      milkTeaQueries.value[kind] = { ...milkTeaQueries.value[kind], loading: false, error }
      return { ok: false, error }
    }
    catch (err: any) {
      if (requestId !== milkTeaQueryIds[kind] || !isCurrentAccount(requestedId))
        return { ok: false, cancelled: true, error: '已取消' }
      const error = err?.response?.data?.error || err.message || '查询失败'
      milkTeaQueries.value[kind] = { ...milkTeaQueries.value[kind], loading: false, error }
      return { ok: false, error, status: err?.response?.status, code: err?.response?.data?.code }
    }
  }

  // 实际发请求的内部入口（公共入口多一层一键互斥；runner 串行调用这里）
  async function performMilkTeaOperate(accountId: string, action: string, input: Record<string, unknown> = {}) {
    // 写前同步闸：下架标记之外，当前快照有效截止已实际到期也当场拦下（计时回调未跑不放行）
    if (activityEndedNow('milkTea'))
      return { ok: false, retired: true, error: '活动已结束，已停止操作（未发送请求）' }
    const opSeq = ++milkTeaOperateSeq
    const lifecycle = activityLifecycleSeq
    const requestedId = String(accountId)
    milkTeaOperating.value = action
    try {
      const { data } = await api.post('/api/activity/milk-tea/operate', {
        action,
        input,
      }, {
        headers: { 'x-account-id': accountId },
      })
      // 卸载/切账号（含往返，账号串恰好相等）后的旧响应：不给调用方可消费的结果
      if (lifecycle !== activityLifecycleSeq || !isCurrentAccount(requestedId))
        return { ok: false, cancelled: true, error: '已取消' }
      return data
    }
    catch (err: any) {
      if (lifecycle !== activityLifecycleSeq || !isCurrentAccount(requestedId))
        // 旧代次的迟到异常同迟到成功：标记已取消，不得当普通失败提示
        return { ok: false, cancelled: true, error: '已取消' }
      return { ok: false, error: err?.response?.data?.error || err.message || '操作失败', status: err?.response?.status, code: err?.response?.data?.code }
    }
    finally {
      if (opSeq === milkTeaOperateSeq)
        milkTeaOperating.value = ''
    }
  }

  async function operateMilkTea(accountId: string, action: string, input: Record<string, unknown> = {}) {
    if (!accountId || milkTeaOperating.value || claimAllRunning.value)
      return { ok: false, error: '操作进行中' }
    return performMilkTeaOperate(accountId, action, input)
  }

  /** 取消进行中的一键领取（账号切换/页面卸载）：停止后续请求，旧响应不回填。 */
  function cancelClaimAll() {
    ++claimAllRunId
    claimAllRunning.value = false
    claimAllStep.value = ''
  }

  // 写前资格校验业务码白名单：与 milk-tea-activity 服务在发出 Operate 写请求
  // 「之前」的 fail 调用点对应（一键只发 shareDaily/shareMilestones；两个动作的
  // 写前资格码如下）。只有白名单内的 400 才能按「未写入跳过」归因；未知 code、
  // REPLY_MISMATCH（写后）、无 code 的 400、其他错误一律视为结果未知，记失败不自动重试。
  const PRECONDITION_SKIP_CODES = new Set([
    'SEASON_WISH_MILK_TEA_UNAVAILABLE',
    'SEASON_WISH_MILK_TEA_ENDED',
    'SEASON_WISH_MILK_TEA_SETTLING',
    'SEASON_WISH_MILK_TEA_NO_STATE',
    'SEASON_WISH_MILK_TEA_INVALID_STATE',
    'SEASON_WISH_MILK_TEA_CLAIMED',
    'SEASON_WISH_MILK_TEA_LIMIT',
    'SEASON_WISH_MILK_TEA_NO_CLAIMABLE',
    'SEASON_WISH_MILK_TEA_BUSY',
  ])

  // ===== 一键领取（编排层）：只复用上方已证实的手动写入口，不新增协议/命令 =====
  // 迁移为当前快乐值：每日领取 → 重读快照 → 领取已成立档位；其他奶茶动作用独立按钮。
  // 每一项写入仍由后端 List+GetGroup 资格闸门实时校验后才放行；任一读取失败/缺字段/
  // 活动未下发则显式跳过、零写。绝不自动分享/购买/雇佣/消耗道具。
  function rewardText(rewards: unknown): string {
    if (!Array.isArray(rewards) || !rewards.length)
      return ''
    return rewards.filter(Boolean).map((item: any) => {
      const count = item?.itemCount ?? item?.count
      const label = item?.itemName || item?.name || '未知物品'
      return count == null ? label : `${label}×${Number(count)}`
    }).join('、')
  }

  function shareRewardOf(activity: MilkTeaActivityData | null | undefined): MilkTeaShareReward | null {
    return activity?.shareReward || null
  }

  async function runClaimAll(accountIdRaw: string) {
    const accountId = String(accountIdRaw || '')
    if (!accountId)
      return { ok: false, error: '未选择账号', failedCount: 0, successCount: 0, skippedCount: 0 }
    if (claimAllRunning.value || milkTeaOperating.value)
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
    const skip = (key: string, label: string, detail: string) => push({ key, label, status: 'skipped', detail })

    // 单项写入：成功记奖励；400 且带写前资格校验业务码=未发生写，按跳过归因；
    // 其余一切失败（无 code 的 400、写后 REPLY_MISMATCH、502、网络）与 outcome=unknown
    // =结果未知，记失败且不自动重试。
    const step = async (key: string, label: string, action: string, input: Record<string, unknown>) => {
      claimAllStep.value = label
      const result = await performMilkTeaOperate(accountId, action, input)
      if (!alive())
        return
      const code = String((result as any)?.code || '')
      if (result?.ok === true) {
        const rewards = rewardText((result as any).rewards)
        push({ key, label, status: 'success', detail: rewards ? `获得 ${rewards}` : '已领取' })
      }
      else if ((result as any)?.retired) {
        push({ key, label, status: 'skipped', detail: '运行期间活动已结束，该请求未发出（已发出请求的结果以上方为准，不自动重试）' })
      }
      else if ((result as any)?.status === 400 && code && PRECONDITION_SKIP_CODES.has(code)) {
        push({ key, label, status: 'skipped', detail: `服务端资格校验未通过（未写入）：${String((result as any).error || '')}` })
      }
      else {
        push({ key, label, status: 'failed', detail: `${String((result as any)?.error || '操作失败')}（结果未知，不自动重试，请稍后刷新确认）` })
      }
      return result?.ok === true
    }

    try {
      // 1) 读取当前快乐值状态（一键不依赖页面旧状态；读取失败则零写）
      claimAllStep.value = '读取活动状态'
      const fresh = await fetchMilkTeaActivity(accountId)
      if (!alive())
        return finishRun(runId)
      if (fresh?.retired) {
        skip('share', '快乐值', '活动已结束（服务端不再下发或已过截止时间），本轮零写入')
        return finishRun(runId)
      }
      if (fresh?.ok !== true) {
        skip('share', '快乐值', `活动状态读取失败（${String(fresh?.error || '未知错误')}），本轮零写入（不自动重试）`)
        return finishRun(runId)
      }
      let shareState = shareRewardOf(milkTeaActivity.value)

      // 2) 快乐值每日领取（免费、已证实的领取路径）
      if (shareState?.daily && shareState.daily.rewardClaimed === false
        && (!Number(shareState.daily.claimLimit) || Number(shareState.daily.claimedCount) < Number(shareState.daily.claimLimit))
        && !activityEndedNow('milkTea')) {
        const dailySucceeded = await step('share:daily', '快乐值每日领取', 'shareDaily', {})
        if (!alive())
          return finishRun(runId)
        if (!dailySucceeded) {
          skip('share:milestones', '快乐值档位奖励', '每日领取未确认成功，停止依赖该结果的领取（不重试）')
          return finishRun(runId)
        }
        // 每日领取会加快乐值，可能解锁新档位：必须以刷新后的服务端状态重算，不用旧缓存
        claimAllStep.value = '刷新快乐值状态'
        const afterDaily = await fetchMilkTeaActivity(accountId)
        if (!alive())
          return finishRun(runId)
        if (afterDaily?.retired) {
          skip('share:milestones', '快乐值档位奖励', '每日领取后活动已结束，跳过档位领取（不试写；已领取结果保留）')
          shareState = null
        }
        else if (afterDaily?.ok === true) {
          shareState = shareRewardOf(milkTeaActivity.value)
        }
        else {
          skip('share:milestones', '快乐值档位奖励', `每日领取后状态刷新失败（${String(afterDaily?.error || '未知错误')}），档位不以旧状态继续（结果未知，不自动重试，请稍后刷新确认）`)
          shareState = null
        }
      }
      else if (shareState?.daily && shareState.daily.rewardClaimed === false && activityEndedNow('milkTea')) {
        skip('share:daily', '快乐值每日领取', '运行期间活动已到期，每日领取停止（不试写）')
        shareState = null
      }

      // 3) 快乐值档位奖励（state===2 为可领取，沿用本仓库已验证解读）
      if (shareState) {
        const score = Number(shareState.currentScore || 0)
        const claimable = (shareState.milestones || []).some(tier =>
          Number(tier?.state) === 2 && score >= Number(tier?.threshold))
        if (!alive())
          return finishRun(runId)
        if (claimable && !activityEndedNow('milkTea'))
          await step('share:milestones', '快乐值档位奖励', 'shareMilestones', {})
        else if (claimable)
          skip('share:milestones', '快乐值档位奖励', '运行期间活动已到期，停止领取（不试写）')
        else
          skip('share:milestones', '快乐值档位奖励', '当前没有可领取的快乐值档位')
      }

      // 4) 收尾：尽力刷新只读状态；刷新失败不丢已领结果，只追加提示。
      //    已下架活动不补读（零请求）。fetch 内部 catch 后永远 fulfilled（返回 {ok:false}），
      //    所以要同时检查 rejected 与 fulfilled.value.ok === false，不能只看 rejected。
      if (alive()) {
        claimAllStep.value = '刷新活动状态'
        const refreshed = await Promise.allSettled([
          isActivityRetired('milkTea') ? Promise.resolve({ ok: true }) : fetchMilkTeaActivity(accountId),
        ])
        if (alive() && refreshed.some(item => item.status === 'rejected'
          || (item.status === 'fulfilled' && item.value && (item.value as any).ok === false))) {
          skip('refresh', '刷新活动状态', '活动状态刷新失败，已领取结果以上方为准')
        }
      }
      return finishRun(runId)
    }
    catch (err: any) {
      // 整体意外异常：释放当前轮 busy 并保留已产生的结果，结果未知不自动重试。
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
    milkTeaActivity,
    milkTeaLoading,
    milkTeaError,
    milkTeaQueries,
    fetchMilkTeaActivity,
    runMilkTeaQuery,
    milkTeaOperating,
    operateMilkTea,
    clearActivityData,
    claimAllRunning,
    claimAllStep,
    claimAllResults,
    runClaimAll,
    cancelClaimAll,
    activityRetired,
    recheckActivity,
    cancelActivityReads,
    sweepExpiredActivities,
  }
})
