import type { Ref } from 'vue'
import { storeToRefs } from 'pinia'
import { computed, onScopeDispose, ref, watch, watchEffect } from 'vue'
import api from '@/api'
import { useFarmStore } from '@/stores/farm'
import { useSettingStore } from '@/stores/setting'

interface BagSeedItem {
  seedId: number
  name: string
  count: number
  requiredLevel: number
  plantSize: number
}

interface AutomationSettingsSnapshot {
  automation: Record<string, unknown>
}

type AlertType = 'primary' | 'danger'

const analyticsSortByMap: Record<string, string> = {
  max_exp: 'exp',
  max_fert_exp: 'fert',
  max_profit: 'profit',
  max_fert_profit: 'fert_profit',
}

export function useStrategySettings({
  currentAccountId,
  currentAccountRunning,
  getAutomationSettings,
  showAlert,
}: {
  currentAccountId: Ref<string | number | null | undefined>
  /** 当前账号严格运行态：账号缺失、未运行或无选择均为 false，由调用方从既有账号列表派生 */
  currentAccountRunning: Ref<boolean>
  getAutomationSettings: () => AutomationSettingsSnapshot
  showAlert: (message: string, type?: AlertType) => void
}) {
  const settingStore = useSettingStore()
  const farmStore = useFarmStore()
  const { settings, loading: settingsLoading } = storeToRefs(settingStore)
  const { seeds } = storeToRefs(farmStore)

  const strategySaving = ref(false)

  const localStrategySettings = ref({
    plantingStrategy: 'max_exp',
    preferredSeedId: 0,
    prioritize2x2Crops: false,
    bagSeedPriority: [] as number[],
    bagSeedKnownIds: [] as number[],
    bagSeedFallbackStrategy: 'level',
    stealDelaySeconds: 0,
    plantOrderRandom: false,
    plantDelaySeconds: 0,
    intervals: { farmMin: 8, farmMax: 12, helpMin: 30, helpMax: 35, stealMin: 25, stealMax: 30 },
    friendQuietHours: { enabled: false, start: '23:00', end: '07:00', maxSleepMinutes: 120, wakeBeforeMinutes: 66, watchlistWakeBeforeMinutes: 122, pauseUntil: '' },
  })

  const plantingStrategyOptions = [
    { label: '优先种植种子', value: 'preferred' },
    { label: '最高等级作物', value: 'level' },
    { label: '最大经验/时', value: 'max_exp' },
    { label: '最大普通肥经验/时', value: 'max_fert_exp' },
    { label: '最大净利润/时', value: 'max_profit' },
    { label: '最大普通肥净利润/时', value: 'max_fert_profit' },
    { label: '背包种子优先', value: 'bag_priority' },
  ]

  const bagFallbackStrategyOptions = [
    { label: '最高等级作物', value: 'level' },
    { label: '最大经验/时', value: 'max_exp' },
    { label: '最大普通肥经验/时', value: 'max_fert_exp' },
    { label: '最大净利润/时', value: 'max_profit' },
    { label: '最大普通肥净利润/时', value: 'max_fert_profit' },
    { label: '优先种植种子', value: 'preferred' },
  ]

  const bagSeeds = ref<BagSeedItem[]>([])
  const bagSeedsLoading = ref(false)
  const bagSeedsError = ref<string | null>(null)
  const draggingBagSeedId = ref<number | null>(null)
  let bagSeedsRequestId = 0
  // 当前在途的种子请求（代次 id + 归一化账号标识）；null = 无在途。
  // 三个触发入口（就绪 watcher / 15 秒周期 / 显式重置）统一走 requestBagSeeds 去重。
  // 就绪 watcher 为 post flush：账号切换时 Settings 的账号 watch（pre flush）先执行显式重置，
  // 由重置发起唯一的新代次请求，watcher 随后经统一入口去重跳过——同拍立即恰好读取一次。
  let bagSeedsActiveRequest: { id: number, accountId: string } | null = null
  let strategyPreviewRequestId = 0

  // 账号未运行（含账号缺失/无选择）时暂停背包种子首取与轮询：后端固定返回「账号未运行」，
  // 离线轮询只会产生 304 噪声；运行态恢复后立即读取一次，再由既有 15 秒周期接管。
  const bagSeedFetchEligible = computed(() =>
    localStrategySettings.value.plantingStrategy === 'bag_priority'
    && !!currentAccountId.value
    && currentAccountRunning.value === true)

  // 递增请求代次并放弃在途请求：停止、失格、切换、重置、卸载后，
  // 旧在途请求的成功/失败/finally 不得再写状态。
  function invalidateBagSeedRequests() {
    bagSeedsRequestId++
    bagSeedsActiveRequest = null
    bagSeedsLoading.value = false
  }

  const sortedBagSeeds = computed(() => {
    const priority = localStrategySettings.value.bagSeedPriority || []
    const seedMap = new Map(bagSeeds.value.map(seed => [Number(seed.seedId), seed]))
    const orderedSeeds: BagSeedItem[] = []
    const seen = new Set<number>()

    for (const rawSeedId of priority) {
      const seedId = Number(rawSeedId)
      if (!seedId || seen.has(seedId))
        continue
      const seed = seedMap.get(seedId)
      if (!seed)
        continue
      seen.add(seedId)
      orderedSeeds.push(seed)
    }

    return orderedSeeds
  })

  // 背包中存在、但未加入优先列表的种子：识别结果全量可见（后端种植已不丢种子，这里只影响顺序）。
  const unplannedBagSeeds = computed(() => {
    const priority = localStrategySettings.value.bagSeedPriority || []
    const prioritySet = new Set(priority.map(seedId => Number(seedId)))
    return bagSeeds.value
      .filter((seed) => {
        const seedId = Number(seed.seedId)
        return seedId > 0 && !prioritySet.has(seedId)
      })
      .sort((a, b) => (a.requiredLevel - b.requiredLevel) || (a.seedId - b.seedId))
  })

  function addBagSeedToPriority(seedId: number) {
    const id = Number(seedId)
    if (!id || localStrategySettings.value.bagSeedPriority.includes(id))
      return
    localStrategySettings.value.bagSeedPriority = [...localStrategySettings.value.bagSeedPriority, id]
  }

  function addAllBagSeedsToPriority() {
    const currentIds = bagSeeds.value.map(seed => Number(seed.seedId)).filter(seedId => seedId > 0)
    const priority = localStrategySettings.value.bagSeedPriority || []
    localStrategySettings.value.bagSeedPriority = [...new Set([...priority, ...currentIds])]
  }

  // 该请求是否仍是当前有效代次：代次与账号双重匹配，且当前选择没有变。
  function isBagSeedRequestCurrent(requestId: number, requestedId: string) {
    return bagSeedsActiveRequest !== null
      && bagSeedsActiveRequest.id === requestId
      && bagSeedsActiveRequest.accountId === requestedId
      && String(currentAccountId.value ?? '') === requestedId
  }

  // 统一种子读取入口：不满足条件直接返回；当前选择已有在途请求时不再发起第二次。
  // 就绪 watcher、15 秒周期与显式重置都从这里进，同一账号同一时刻最多一个在途请求。
  function requestBagSeeds() {
    if (!bagSeedFetchEligible.value)
      return
    const accountId = currentAccountId.value
    if (!accountId)
      return
    const requestedId = String(accountId)
    if (bagSeedsActiveRequest && bagSeedsActiveRequest.accountId === requestedId)
      return
    const requestId = ++bagSeedsRequestId
    bagSeedsActiveRequest = { id: requestId, accountId: requestedId }
    bagSeedsLoading.value = true
    bagSeedsError.value = null
    void runBagSeedRequest(requestId, requestedId, accountId)
  }

  async function runBagSeedRequest(requestId: number, requestedId: string, accountId: string | number) {
    try {
      const res = await api.get('/api/bag/seeds', {
        headers: { 'x-account-id': accountId },
      })
      if (!isBagSeedRequestCurrent(requestId, requestedId))
        return
      if (res.data.ok) {
        bagSeeds.value = res.data.data || []
        const currentIds = bagSeeds.value.map(seed => Number(seed.seedId)).filter(seedId => seedId > 0)
        const priority = localStrategySettings.value.bagSeedPriority || []
        const knownIds = localStrategySettings.value.bagSeedKnownIds || []

        if (knownIds.length === 0) {
          // 迁移：从未记录过已知种子时，无法区分「用户故意移除」和「新获得」，
          // 把背包里有而优先列表没有的种子（含活动种子）追加到列表末尾
          const missing = currentIds.filter(seedId => !priority.includes(seedId))
          if (priority.length === 0 || missing.length > 0)
            localStrategySettings.value.bagSeedPriority = [...priority, ...missing]
          localStrategySettings.value.bagSeedKnownIds = [...new Set([...priority, ...currentIds])]
        }
        else {
          const knownSet = new Set(knownIds.map(Number))
          const newIds = currentIds.filter(seedId => !knownSet.has(seedId))
          if (newIds.length > 0)
            localStrategySettings.value.bagSeedPriority = [...priority, ...newIds]
          localStrategySettings.value.bagSeedKnownIds = [...new Set([...knownIds, ...currentIds])]
        }
      }
    }
    catch (e: any) {
      if (isBagSeedRequestCurrent(requestId, requestedId))
        bagSeedsError.value = e.message || '加载失败'
    }
    finally {
      // 只有仍是当前在途请求才清 loading：旧代次的 finally 不得清除新代次的 loading。
      if (bagSeedsActiveRequest !== null && bagSeedsActiveRequest.id === requestId) {
        bagSeedsActiveRequest = null
        bagSeedsLoading.value = false
      }
    }
  }

  function resetBagSeedPriority() {
    localStrategySettings.value.bagSeedPriority = bagSeeds.value.map(seed => Number(seed.seedId)).filter(seedId => seedId > 0)
  }

  function getCurrentBagSeedOrder() {
    return sortedBagSeeds.value.map(seed => Number(seed.seedId)).filter(seedId => seedId > 0)
  }

  function moveBagSeed(seedId: number, direction: -1 | 1) {
    const nextOrder = getCurrentBagSeedOrder()
    const index = nextOrder.indexOf(seedId)
    const targetIndex = index + direction
    if (index < 0 || targetIndex < 0 || targetIndex >= nextOrder.length)
      return

    const temp = nextOrder[index]!
    nextOrder[index] = nextOrder[targetIndex]!
    nextOrder[targetIndex] = temp
    localStrategySettings.value.bagSeedPriority = nextOrder
  }

  function removeBagSeedPriority(seedId: number) {
    localStrategySettings.value.bagSeedPriority = getCurrentBagSeedOrder()
      .filter(itemSeedId => itemSeedId !== Number(seedId))
  }

  function startBagSeedDrag(seedId: number, event: DragEvent) {
    draggingBagSeedId.value = seedId
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move'
      event.dataTransfer.setData('text/plain', String(seedId))
    }
  }

  function dragOverBagSeed(_seedId: number, event: DragEvent) {
    if (draggingBagSeedId.value === null)
      return
    event.preventDefault()
    if (event.dataTransfer)
      event.dataTransfer.dropEffect = 'move'
  }

  function dropBagSeed(seedId: number, event: DragEvent) {
    event.preventDefault()
    const sourceSeedId = draggingBagSeedId.value ?? Number(event.dataTransfer?.getData('text/plain') || '')
    if (!sourceSeedId || sourceSeedId === seedId) {
      draggingBagSeedId.value = null
      return
    }

    const nextOrder = getCurrentBagSeedOrder()
    const sourceIndex = nextOrder.indexOf(sourceSeedId)
    const targetIndex = nextOrder.indexOf(seedId)

    if (sourceIndex < 0 || targetIndex < 0) {
      draggingBagSeedId.value = null
      return
    }

    const [moved] = nextOrder.splice(sourceIndex, 1)
    const newTargetIndex = sourceIndex < targetIndex ? targetIndex - 1 : targetIndex
    nextOrder.splice(newTargetIndex, 0, moved!)

    localStrategySettings.value.bagSeedPriority = nextOrder
    draggingBagSeedId.value = null
  }

  // 只观察运行态布尔值与策略的实际变化：账号列表对象整体替换（约 3 秒一次）或
  // loading/错误变化不触发新的首取；失格时放弃在途请求。
  // post flush 是刻意的：Settings 的账号 watch（pre flush，注册更晚）在同一拍先执行
  // 显式重置——重置无条件失效在途请求并立即发起唯一的新代次请求，本 watcher 随后在
  // post 阶段经统一入口去重跳过。切换同拍因此仍立即恰好读取一次，且唯一请求是重置后
  // 发起的，不依赖复用重置前的在途请求。
  watch(bagSeedFetchEligible, (eligible, wasEligible) => {
    if (eligible)
      requestBagSeeds()
    else if (wasEligible)
      invalidateBagSeedRequests()
  }, { immediate: true, flush: 'post' })

  const bagSeedsRefreshTimer = window.setInterval(() => {
    requestBagSeeds()
  }, 15_000)
  onScopeDispose(() => {
    window.clearInterval(bagSeedsRefreshTimer)
    invalidateBagSeedRequests()
  })

  const preferredSeedOptions = computed(() => {
    const options: { label: string, value: number, disabled?: boolean }[] = [{ label: '自动选择', value: 0, disabled: false }]
    if (seeds.value) {
      options.push(...seeds.value.map(seed => ({
        label: `${seed.requiredLevel}级 ${seed.name} (${seed.price}金)`,
        value: seed.seedId,
        disabled: seed.locked || seed.soldOut,
      })))
    }
    return options
  })

  const strategyPreviewLabel = ref<string | null>(null)

  watchEffect(async () => {
    const requestId = ++strategyPreviewRequestId
    let strategy = localStrategySettings.value.plantingStrategy
    if (strategy === 'preferred') {
      strategyPreviewLabel.value = null
      return
    }
    if (strategy === 'bag_priority') {
      strategy = localStrategySettings.value.bagSeedFallbackStrategy || 'level'
      if (strategy === 'preferred') {
        const preferredId = localStrategySettings.value.preferredSeedId
        if (preferredId > 0 && seeds.value) {
          const seed = seeds.value.find(s => s.seedId === preferredId)
          strategyPreviewLabel.value = seed ? `${seed.requiredLevel}级 ${seed.name}` : '未选择优先种子'
        }
        else {
          strategyPreviewLabel.value = '未选择优先种子'
        }
        return
      }
    }
    if (!seeds.value || seeds.value.length === 0) {
      strategyPreviewLabel.value = null
      return
    }
    const available = seeds.value.filter(s => !s.locked && !s.soldOut)
    if (available.length === 0) {
      strategyPreviewLabel.value = '暂无可用种子'
      return
    }
    if (strategy === 'level') {
      const best = [...available].sort((a, b) => b.requiredLevel - a.requiredLevel)[0]
      strategyPreviewLabel.value = best ? `${best.requiredLevel}级 ${best.name}` : null
      return
    }
    const sortBy = analyticsSortByMap[strategy]
    if (sortBy) {
      try {
        const accountId = currentAccountId.value
        if (!accountId) {
          strategyPreviewLabel.value = null
          return
        }
        const requestedId = String(accountId)
        const res = await api.get(`/api/analytics?sort=${sortBy}`, {
          headers: { 'x-account-id': accountId },
        })
        if (requestId !== strategyPreviewRequestId || String(currentAccountId.value || '') !== requestedId)
          return
        const rankings: any[] = res.data.ok ? (res.data.data || []) : []
        const availableIds = new Set(available.map(s => s.seedId))
        const match = rankings.find(r => availableIds.has(Number(r.seedId)))
        if (match) {
          const seed = available.find(s => s.seedId === Number(match.seedId))
          strategyPreviewLabel.value = seed ? `${seed.requiredLevel}级 ${seed.name}` : null
        }
        else {
          strategyPreviewLabel.value = '暂无匹配种子'
        }
      }
      catch {
        if (requestId === strategyPreviewRequestId)
          strategyPreviewLabel.value = null
      }
    }
  })

  function syncLocalStrategySettings() {
    if (settings.value) {
      localStrategySettings.value = JSON.parse(JSON.stringify({
        plantingStrategy: settings.value.plantingStrategy,
        preferredSeedId: settings.value.preferredSeedId,
        prioritize2x2Crops: settings.value.prioritize2x2Crops === true,
        bagSeedPriority: settings.value.bagSeedPriority ?? [],
        bagSeedKnownIds: settings.value.bagSeedKnownIds ?? [],
        bagSeedFallbackStrategy: settings.value.bagSeedFallbackStrategy ?? 'level',
        stealDelaySeconds: settings.value.stealDelaySeconds ?? 0,
        plantOrderRandom: !!settings.value.plantOrderRandom,
        plantDelaySeconds: settings.value.plantDelaySeconds ?? 0,
        intervals: settings.value.intervals,
        friendQuietHours: settings.value.friendQuietHours,
      }))
    }
  }

  async function loadStrategyData() {
    if (currentAccountId.value) {
      const accountId = String(currentAccountId.value)
      await settingStore.fetchSettings(accountId)
      syncLocalStrategySettings()
      await farmStore.fetchSeeds(accountId)
    }
  }

  async function saveStrategySettings() {
    if (!currentAccountId.value)
      return
    strategySaving.value = true
    try {
      const fullSettings = {
        ...settings.value,
        ...localStrategySettings.value,
        automation: getAutomationSettings().automation,
      }
      const res = await settingStore.saveSettings(String(currentAccountId.value), fullSettings)
      if (res.ok) {
        showAlert('策略设置已保存', 'primary')
      }
      else {
        showAlert(`保存失败: ${res.error}`, 'danger')
      }
    }
    finally {
      strategySaving.value = false
    }
  }

  function resetStrategyState() {
    // 显式重置（账号切换/应用默认方案）：无条件递增代次并放弃全部在途请求——
    // 同一选择的在途请求也不得复用，其迟到成功/失败/finally 不得回填重置后的新草稿。
    // 重置后条件仍满足时立即读取一次（新代次），不等下一个 15 秒周期。
    invalidateBagSeedRequests()
    bagSeeds.value = []
    bagSeedsError.value = null
    draggingBagSeedId.value = null
    strategyPreviewLabel.value = null
    requestBagSeeds()
  }

  return {
    settings,
    settingsLoading,
    strategySaving,
    localStrategySettings,
    plantingStrategyOptions,
    bagFallbackStrategyOptions,
    bagSeeds,
    bagSeedsLoading,
    bagSeedsError,
    sortedBagSeeds,
    unplannedBagSeeds,
    preferredSeedOptions,
    strategyPreviewLabel,
    resetBagSeedPriority,
    moveBagSeed,
    removeBagSeedPriority,
    addBagSeedToPriority,
    addAllBagSeedsToPriority,
    startBagSeedDrag,
    dragOverBagSeed,
    dropBagSeed,
    syncLocalStrategySettings,
    loadStrategyData,
    saveStrategySettings,
    resetStrategyState,
  }
}
