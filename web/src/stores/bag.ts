import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import api from '@/api'
import { useAccountStore } from '@/stores/account'

export const useBagStore = defineStore('bag', () => {
  const allItems = ref<any[]>([])
  const originalItems = ref<any[]>([])
  const loading = ref(false)
  const error = ref('')
  let requestId = 0
  function clearBag() {
    requestId++
    loading.value = false
    error.value = ''
    allItems.value = []
    originalItems.value = []
  }
  const items = computed(() => {
    const hiddenIds = new Set([1, 1001, 1002, 1101, 1011, 1012, 3001, 3002])
    return allItems.value.filter((it: any) => !hiddenIds.has(Number(it.id || 0)))
  })
  const dashboardItems = computed(() => {
    const targetIds = new Set([1011, 1012, 3001, 3002])
    return allItems.value.filter((it: any) => targetIds.has(Number(it.id || 0)))
  })
  async function fetchBag(accountId: string) {
    if (!accountId)
      return
    const requestedId = accountId
    const sequence = ++requestId
    error.value = ''
    loading.value = true
    try {
      const res = await api.get('/api/bag', {
        headers: { 'x-account-id': accountId },
      })
      const acc = useAccountStore()
      const curId = String((acc.currentAccountId as {
        value?: string
      })?.value ?? acc.currentAccountId ?? '')
      if (curId !== requestedId || sequence !== requestId)
        return
      if (res.data.ok === true && Array.isArray(res.data.data?.items) && res.data.data.items.every((row: any) => row && typeof row.name === 'string' && Number.isFinite(row.id) && row.id > 0) && Array.isArray(res.data.data?.originalItems) && res.data.data.originalItems.every((row: any) => row && Number.isFinite(row.id) && row.id > 0)) {
        allItems.value = Array.isArray(res.data.data.items) ? res.data.data.items : []
        originalItems.value = Array.isArray(res.data.data.originalItems) ? res.data.data.originalItems : []
      }
      else {
        error.value = res.data.error || '背包回复不完整，保留上次数据'
      }
    }
    catch (e) {
      const acc = useAccountStore()
      const curId = String((acc.currentAccountId as {
        value?: string
      })?.value ?? acc.currentAccountId ?? '')
      if (curId === requestedId && sequence === requestId)
        error.value = '读取失败，保留上次数据'
      console.error(e)
    }
    finally {
      if (sequence === requestId)
        loading.value = false
    }
  }
  async function useItem(accountId: string, itemId: number, count = 1, uid = 0) {
    const res = await api.post('/api/bag/use', { itemId, count, uid }, {
      headers: { 'x-account-id': accountId },
    })
    return res.data
  }
  async function sellItems(accountId: string, items: Array<{
    id: number
    count: number | string
    uid?: number | string
  }>, options: Record<string, any> = {}) {
    const res = await api.post('/api/bag/sell', { items, ...options }, {
      headers: { 'x-account-id': accountId },
    })
    return res.data
  }
  return { error, items, allItems, originalItems, dashboardItems, loading, fetchBag, clearBag, useItem, sellItems }
})
