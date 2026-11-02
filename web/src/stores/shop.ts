import { defineStore } from 'pinia'
import { ref } from 'vue'
import api from '@/api'
import { useAccountStore } from '@/stores/account'

export interface ShopSeedItem {
  id: number
  itemId: number
  name: string
  image?: string
  price: number
  seedLevel: number
  requiredLevel: number
  seasons?: number
  incomePerSeason?: number
  expPerSeason?: number
  unlocked?: boolean
  isSoldOut?: boolean
  limitCount?: number
  boughtNum?: number
}
export interface ShopPetItem {
  id: number
  itemId: number
  name: string
  image?: string
  desc?: string
  price: number
  requiredLevel: number
  unlocked?: boolean
  isSoldOut?: boolean
  isGoldenBean?: boolean
}
export interface ShopDecorationItem {
  id: number
  itemId: number
  name: string
  image?: string
  desc?: string
  effectDesc?: string
  price: number
  canBuy?: boolean
}
export interface ShopMallItem {
  goodsId: number
  name: string
  price: any
  [key: string]: any
}
export interface MysteryShopOffer {
  active: boolean
  npcId: number
  itemId: number
  itemName: string
  itemImage?: string
  itemCount: number
  currencyId: number
  currencyName: string
  price: number
  originalPrice: number
  discount: number
  purchased: boolean
  startTime: number
  endTime: number
}
export const useShopStore = defineStore('shop', () => {
  const seeds = ref<ShopSeedItem[]>([])
  const pets = ref<ShopPetItem[]>([])
  const decorations = ref<ShopDecorationItem[]>([])
  const mallGoods = ref<ShopMallItem[]>([])
  const monthCard = ref<any>(null)
  const recharge = ref<any>(null)
  const extraError = ref('')
  const extraLoading = ref(false)
  let extraRequestId = 0
  const mysteryOffer = ref<MysteryShopOffer | null>(null)
  const mysteryOfferAccountId = ref('')
  const loading = ref(false)
  const petLoading = ref(false)
  const decorationLoading = ref(false)
  const mallLoading = ref(false)
  const mysteryLoading = ref(false)
  const error = ref('')
  const petError = ref('')
  const decorationError = ref('')
  const mallError = ref('')
  const mysteryError = ref('')
  const userGold = ref(0)
  const userGoldBean = ref(0)
  const userTicket = ref(0)
  const userDiamond = ref(0)
  let seedRequestId = 0
  let petRequestId = 0
  let decorationRequestId = 0
  let mallRequestId = 0
  let mysteryRequestId = 0
  function clearShopData() {
    seedRequestId++
    petRequestId++
    decorationRequestId++
    mallRequestId++
    mysteryRequestId++
    extraRequestId++
    monthCard.value = null
    recharge.value = null
    extraError.value = ''
    extraLoading.value = false
    seeds.value = []
    pets.value = []
    decorations.value = []
    mallGoods.value = []
    mysteryOffer.value = null
    mysteryOfferAccountId.value = ''
    loading.value = false
    petLoading.value = false
    decorationLoading.value = false
    mallLoading.value = false
    mysteryLoading.value = false
    error.value = ''
    petError.value = ''
    decorationError.value = ''
    mallError.value = ''
    mysteryError.value = ''
    userGold.value = 0
    userGoldBean.value = 0
    userTicket.value = 0
    userDiamond.value = 0
  }
  function isCurrentAccount(accountId: string) {
    const accountStore = useAccountStore()
    const currentId = String((accountStore.currentAccountId as {
      value?: string
    })?.value ?? accountStore.currentAccountId ?? '')
    return currentId === String(accountId)
  }
  const validRows = (rows: any) => Array.isArray(rows) && rows.every(row => row && typeof row === 'object' && Number.isFinite(row.id) && row.id > 0 && typeof row.name === 'string')

  async function fetchSeeds(accountId: string) {
    if (!accountId)
      return
    const requestedId = String(accountId)
    const requestId = ++seedRequestId
    loading.value = true
    error.value = ''
    try {
      const { data } = await api.get('/api/shop/seed', {
        headers: { 'x-account-id': accountId },
      })
      if (requestId !== seedRequestId || !isCurrentAccount(requestedId))
        return
      if (data.ok === true && validRows(data.data))
        seeds.value = data.data
      else
        error.value = data.error || '获取种子商店失败'
    }
    catch (err: any) {
      if (requestId === seedRequestId && isCurrentAccount(requestedId))
        error.value = err.message || '获取种子商店失败'
    }
    finally {
      if (requestId === seedRequestId)
        loading.value = false
    }
  }
  async function fetchPets(accountId: string) {
    if (!accountId)
      return
    const requestedId = String(accountId)
    const requestId = ++petRequestId
    petLoading.value = true
    petError.value = ''
    try {
      const { data } = await api.get('/api/shop/pet', {
        headers: { 'x-account-id': accountId },
      })
      if (requestId !== petRequestId || !isCurrentAccount(requestedId))
        return
      if (data.ok === true && validRows(data.data)) {
        pets.value = data.data
        userGold.value = data.userGold || 0
        userGoldBean.value = data.userGoldBean || 0
      }
      else {
        petError.value = data.error || '获取宠物商店失败'
      }
    }
    catch (err: any) {
      if (requestId === petRequestId && isCurrentAccount(requestedId))
        petError.value = err.message || '获取宠物商店失败'
    }
    finally {
      if (requestId === petRequestId)
        petLoading.value = false
    }
  }
  async function fetchDecorations(accountId: string) {
    if (!accountId)
      return
    const requestedId = String(accountId)
    const requestId = ++decorationRequestId
    decorationLoading.value = true
    decorationError.value = ''
    try {
      const { data } = await api.get('/api/shop/decoration', {
        headers: { 'x-account-id': accountId },
      })
      if (requestId !== decorationRequestId || !isCurrentAccount(requestedId))
        return
      if (data.ok === true && validRows(data.data)) {
        decorations.value = data.data
        userGoldBean.value = data.userGoldBean || 0
      }
      else {
        decorationError.value = data.error || '获取装扮商城失败'
      }
    }
    catch (err: any) {
      if (requestId === decorationRequestId && isCurrentAccount(requestedId))
        decorationError.value = err.message || '获取装扮商城失败'
    }
    finally {
      if (requestId === decorationRequestId)
        decorationLoading.value = false
    }
  }
  async function fetchMall(accountId: string) {
    if (!accountId)
      return
    const requestedId = String(accountId)
    const requestId = ++mallRequestId
    mallLoading.value = true
    mallError.value = ''
    try {
      const { data } = await api.get('/api/shop/mall', {
        headers: { 'x-account-id': accountId },
      })
      if (requestId !== mallRequestId || !isCurrentAccount(requestedId))
        return
      if (data.ok) {
        if (!data.data?.zones || !['featured', 'packages', 'unknown'].every(key => Array.isArray(data.data.zones[key]) && data.data.zones[key].every((row: any) => row && typeof row.name === 'string' && Number.isInteger(row.goodsId) && row.goodsId > 0 && row.price && Array.isArray(row.items) && row.items.every((item: any) => item && typeof item.name === 'string' && /^(?:0|[1-9]\d*)$/.test(String(item.countDec)))))) {
          mallError.value = '商城目录结构不完整，保留上次数据'
          return
        }
        mallGoods.value = [...data.data.zones.featured, ...data.data.zones.packages, ...data.data.zones.unknown]
        userTicket.value = data.userTicket || 0
        userDiamond.value = data.userDiamond || 0
      }
      else {
        mallError.value = data.error || '获取道具商城失败'
      }
    }
    catch (err: any) {
      if (requestId === mallRequestId && isCurrentAccount(requestedId))
        mallError.value = err.message || '获取道具商城失败'
    }
    finally {
      if (requestId === mallRequestId)
        mallLoading.value = false
    }
  }
  async function fetchMysteryShop(accountId: string) {
    if (!accountId)
      return
    const requestedId = String(accountId)
    const requestId = ++mysteryRequestId
    mysteryLoading.value = true
    mysteryError.value = ''
    try {
      const { data } = await api.get('/api/shop/mystery', {
        headers: { 'x-account-id': accountId },
      })
      if (requestId !== mysteryRequestId || !isCurrentAccount(requestedId))
        return
      if (data.ok) {
        mysteryOffer.value = data.data || null
        mysteryOfferAccountId.value = requestedId
      }
      else {
        mysteryError.value = data.error || '获取神秘商人失败'
      }
    }
    catch (err: any) {
      if (requestId === mysteryRequestId && isCurrentAccount(requestedId))
        mysteryError.value = err.message || '获取神秘商人失败'
    }
    finally {
      if (requestId === mysteryRequestId)
        mysteryLoading.value = false
    }
  }
  async function fetchMallExtra(accountId: string, kind: 'monthcard' | 'recharge') {
    const id = ++extraRequestId
    extraLoading.value = true
    extraError.value = ''
    try {
      const { data } = await api.get(`/api/shop/mall/${kind}`, { headers: { 'x-account-id': accountId } })
      if (id !== extraRequestId || !isCurrentAccount(accountId))
        return
      const valid = kind === 'monthcard' ? Array.isArray(data.data?.cards) : Array.isArray(data.data?.tiers)
      if (data.ok !== true || !valid) {
        extraError.value = data.error || '读取失败，保留上次数据'
        return
      }
      if (kind === 'monthcard')
        monthCard.value = data.data
      else
        recharge.value = data.data
    }
    catch (error: any) {
      if (id === extraRequestId && isCurrentAccount(accountId))
        extraError.value = error.message || '读取失败'
    }
    finally {
      if (id === extraRequestId)
        extraLoading.value = false
    }
  }
  async function buyGoods(accountId: string, request: Record<string, any>) {
    const { data } = await api.post('/api/shop/buy', request, { headers: { 'x-account-id': accountId } })
    return data
  }
  async function buyMallGoods(accountId: string, request: Record<string, any>) {
    const { data } = await api.post('/api/shop/mall/buy', request, { headers: { 'x-account-id': accountId } })
    return data
  }
  async function buyMysteryShopGoods(accountId: string, npcId: number) {
    const { data } = await api.post('/api/shop/mystery/buy', {
      npcId,
    }, {
      headers: { 'x-account-id': accountId },
    })
    return data
  }
  async function abandonMysteryShop(accountId: string) {
    const { data } = await api.post('/api/shop/mystery/abandon', {}, {
      headers: { 'x-account-id': accountId },
    })
    return data
  }
  async function refreshAll(accountId: string) {
    await Promise.all([
      fetchSeeds(accountId),
      fetchPets(accountId),
      fetchDecorations(accountId),
      fetchMall(accountId),
      fetchMysteryShop(accountId),
    ])
  }
  return {
    monthCard,
    recharge,
    extraError,
    extraLoading,
    fetchMallExtra,
    seeds,
    pets,
    decorations,
    mallGoods,
    mysteryOffer,
    mysteryOfferAccountId,
    loading,
    petLoading,
    decorationLoading,
    mallLoading,
    mysteryLoading,
    error,
    petError,
    decorationError,
    mallError,
    mysteryError,
    userGold,
    userGoldBean,
    userTicket,
    userDiamond,
    clearShopData,
    fetchSeeds,
    fetchPets,
    fetchDecorations,
    fetchMall,
    fetchMysteryShop,
    refreshAll,
    buyGoods,
    buyMallGoods,
    buyMysteryShopGoods,
    abandonMysteryShop,
  }
})
