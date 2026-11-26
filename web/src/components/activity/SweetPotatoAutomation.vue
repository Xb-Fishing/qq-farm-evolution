<script setup lang="ts">
import { ref, watch } from 'vue'
import api from '@/api'
import BaseButton from '@/components/ui/BaseButton.vue'

interface Policy {
  enabled: boolean
  claim: boolean
  grow: boolean
  sell: boolean
  keepPotatoes: number
  saleBatch: number
  exchangeIndex: number
  coinBudget: number
  keepCoins: number
}

interface Status {
  policy: Policy
  pending: string[]
  spentToday: number
  last: { action: string, state: string, at: number } | null
}

interface Goods { index: number, name: string, unitPrice: number }

const props = defineProps<{ accountId: string }>()
const root = '/api/activity/sweet-potato/trade'
const draft = ref<Policy | null>(null)
const status = ref<Status | null>(null)
const busy = ref(false)
const goods = ref<Goods[]>([])
const error = ref('')
const message = ref('')
const label: Record<string, string> = {
  seeds: '领种', dividend: '领分红', plantCrop: '种植', harvestCrop: '收获', sale: '售卖', exchange: '兑换',
}
let generation = 0

async function request<T>(action: string, accountId: string, payload?: Policy) {
  const config = { headers: { 'x-account-id': accountId } }
  const response = payload
    ? await api.post(`${root}/${action}`, payload, config)
    : await api.get(`${root}/${action}`, config)
  if (response.data?.ok !== true || String(response.data.accountId) !== accountId)
    throw new Error(response.data?.error || '账号已切换，请重新读取')
  return response.data.result as T
}

async function run(action: string, savePolicy = false) {
  if (!props.accountId || busy.value)
    return
  const account = props.accountId
  const currentGeneration = generation
  const current = () => account === props.accountId && currentGeneration === generation
  error.value = ''
  message.value = ''
  busy.value = true
  try {
    if (action === 'catalog') {
      const result = await request<{ catalog: Goods[] }>(action, account)
      if (current())
        goods.value = result.catalog.filter(item => item.name)
      return
    }
    const result = await request<Status>(action, account, savePolicy && draft.value ? { ...draft.value } : undefined)
    if (current()) {
      status.value = result
      draft.value = { ...result.policy }
      if (savePolicy)
        message.value = '托管设置已保存'
    }
  }
  catch (e: any) {
    if (current())
      error.value = e?.response?.data?.error || e?.message || '暂时无法读取以薯换福托管设置'
  }
  finally {
    if (current())
      busy.value = false
  }
}

watch(() => props.accountId, () => {
  generation++
  draft.value = null
  status.value = null
  goods.value = []
  busy.value = false
  error.value = ''
  message.value = ''
}, { flush: 'sync' })
</script>

<template>
  <section class="border border-gray-200 rounded-lg p-4 dark:border-gray-700">
    <div class="flex flex-wrap items-center gap-2">
      <h3 class="font-medium">活动自动托管</h3>
      <BaseButton type="button" size="sm" variant="outline" :loading="busy" @click="run('automation')">
        {{ draft ? '刷新托管状态' : '读取托管设置' }}
      </BaseButton>
    </div>
    <form v-if="draft" class="mt-3 grid gap-3" @submit.prevent="run('automation-settings', true)">
      <fieldset :disabled="busy" class="grid gap-3">
        <label class="flex items-center gap-2">
          <input v-model="draft.enabled" type="checkbox">
          启用以薯换福托管
        </label>
        <div class="flex flex-wrap gap-4 text-sm">
          <label class="flex items-center gap-2">
            <input v-model="draft.claim" type="checkbox">
            自动领种和领分红
          </label>
          <label class="flex items-center gap-2">
            <input v-model="draft.grow" type="checkbox">
            自动种植和收获红薯
          </label>
          <label class="flex items-center gap-2">
            <input v-model="draft.sell" type="checkbox">
            自动卖给自家铺子
          </label>
        </div>
        <div v-if="draft.sell" class="flex flex-wrap gap-3">
          <label class="flex items-center gap-2 text-sm">
            保留蜜薯数量
            <input v-model.number="draft.keepPotatoes" type="number" min="0" max="999999999" step="1" class="w-28 border border-gray-300 rounded px-2 py-1 dark:border-gray-600 dark:bg-gray-800">
          </label>
          <label class="flex items-center gap-2 text-sm">
            每笔出售上限
            <input v-model.number="draft.saleBatch" type="number" min="1" max="8000" step="1" class="w-28 border border-gray-300 rounded px-2 py-1 dark:border-gray-600 dark:bg-gray-800">
          </label>
        </div>
        <div class="flex flex-wrap items-center gap-3">
          <label class="flex items-center gap-2 text-sm">
            自动兑换
            <select v-model.number="draft.exchangeIndex" class="border border-gray-300 rounded px-2 py-1 dark:border-gray-600 dark:bg-gray-800" @change="draft.exchangeIndex || (draft.coinBudget = 0)">
              <option :value="0">关闭</option>
              <option v-if="draft.exchangeIndex > 0 && !goods.some(item => item.index === draft?.exchangeIndex)" :value="draft.exchangeIndex">已选第 {{ draft.exchangeIndex }} 档</option>
              <option v-for="item in goods" :key="item.index" :value="item.index">{{ item.name }} · {{ item.unitPrice }} 福气币</option>
            </select>
          </label>
          <BaseButton type="button" variant="outline" size="sm" :disabled="busy" @click="run('catalog')">读取可兑换商品</BaseButton>
        </div>
        <div v-if="draft.exchangeIndex > 0" class="flex flex-wrap gap-3">
          <label class="flex items-center gap-2 text-sm">
            每日福气币预算
            <input v-model.number="draft.coinBudget" type="number" min="1" max="999999999" step="1" class="w-28 border border-gray-300 rounded px-2 py-1 dark:border-gray-600 dark:bg-gray-800">
          </label>
          <label class="flex items-center gap-2 text-sm">
            保留福气币
            <input v-model.number="draft.keepCoins" type="number" min="0" max="999999999" step="1" class="w-28 border border-gray-300 rounded px-2 py-1 dark:border-gray-600 dark:bg-gray-800">
          </label>
          <span class="text-sm text-gray-600 dark:text-gray-300">今日已用 {{ status?.spentToday ?? 0 }}</span>
        </div>
      </fieldset>
      <div>
        <BaseButton type="submit" variant="primary" size="sm" :loading="busy">保存托管设置</BaseButton>
      </div>
    </form>
    <p v-if="status?.pending.length" class="mt-2 text-sm text-amber-700 dark:text-amber-300">
      待核对 {{ status.pending.map(value => label[value] || value).join('、') }}
    </p>
    <p v-if="status?.last" class="mt-2 text-sm text-gray-600 dark:text-gray-300">
      最近处理 {{ label[status.last.action] || status.last.action }} · {{ status.last.state === 'confirmed' ? '回执已确认' : '状态已核对' }}
    </p>
    <p v-if="message" role="status" class="mt-2 text-sm text-green-700 dark:text-green-300">{{ message }}</p>
    <p v-if="error" role="alert" class="mt-2 text-sm text-red-700 dark:text-red-300">{{ error }}</p>
  </section>
</template>
