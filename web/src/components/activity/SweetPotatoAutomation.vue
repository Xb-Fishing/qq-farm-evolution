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
const working = ref('')
const fieldClass = 'mt-1.5 min-h-11 w-full min-w-0 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-900'
const toggleClass = 'min-h-11 flex items-center gap-2.5 rounded-lg border border-gray-200 px-3 py-2 dark:border-gray-700'
const toggleInputClass = 'h-5 w-5 shrink-0 accent-amber-700 dark:accent-amber-400'
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
  if (!props.accountId || working.value)
    return
  const account = props.accountId
  const currentGeneration = generation
  const current = () => account === props.accountId && currentGeneration === generation
  error.value = ''
  message.value = ''
  working.value = action
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
      working.value = ''
  }
}

watch(() => props.accountId, () => {
  generation++
  draft.value = null
  status.value = null
  goods.value = []
  working.value = ''
  error.value = ''
  message.value = ''
}, { flush: 'sync' })
</script>

<template>
  <section class="min-w-0 rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
    <div class="flex flex-wrap items-center justify-between gap-2">
      <h3 class="font-semibold">当前账号的托管设置</h3>
      <BaseButton type="button" variant="outline" class="min-h-11" :loading="working === 'automation'" :disabled="!!working" @click="run('automation')">
        {{ draft ? '刷新托管状态' : '读取托管设置' }}
      </BaseButton>
    </div>
    <p v-if="!draft && !error" class="mt-3 rounded-lg bg-gray-50 px-3 py-2.5 text-sm text-gray-700 dark:bg-gray-900/60 dark:text-gray-200">
      读取设置后，可为当前账号选择自动执行的操作。
    </p>
    <form v-if="draft" class="mt-3" @submit.prevent="run('automation-settings', true)">
      <fieldset :disabled="!!working" class="min-w-0 space-y-4">
        <label class="min-h-14 flex items-center justify-between gap-3 rounded-xl bg-amber-50 px-3 py-2 dark:bg-amber-950/40">
          <span class="min-w-0">
            <span class="block text-sm font-semibold">启用以薯换福托管</span>
            <span class="block text-xs text-gray-700 dark:text-gray-200">{{ status?.policy.enabled ? '已保存为开启' : '已保存为关闭' }}</span>
          </span>
          <input v-model="draft.enabled" type="checkbox" :class="toggleInputClass">
        </label>

        <div class="grid gap-2 text-sm md:grid-cols-3">
          <label :class="toggleClass">
            <input v-model="draft.claim" type="checkbox" :class="toggleInputClass">
            自动领种和领分红
          </label>
          <label :class="toggleClass">
            <input v-model="draft.grow" type="checkbox" :class="toggleInputClass">
            自动种植和收获红薯
          </label>
          <label :class="toggleClass">
            <input v-model="draft.sell" type="checkbox" :class="toggleInputClass">
            自动卖给自家铺子
          </label>
        </div>
        <div v-if="draft.sell" class="grid gap-3 rounded-xl bg-gray-50 p-3 sm:grid-cols-2 dark:bg-gray-900/60">
          <label class="min-w-0 text-sm font-medium">
            保留蜜薯数量
            <input v-model.number="draft.keepPotatoes" type="number" min="0" max="999999999" step="1" :class="fieldClass">
          </label>
          <label class="min-w-0 text-sm font-medium">
            每笔出售上限
            <input v-model.number="draft.saleBatch" type="number" min="1" max="8000" step="1" :class="fieldClass">
          </label>
        </div>

        <div class="space-y-3 border-t border-gray-200 pt-4 dark:border-gray-700">
          <div class="grid items-end gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
            <label class="min-w-0 text-sm font-medium">
              自动兑换
              <select v-model.number="draft.exchangeIndex" :class="fieldClass" @change="draft.exchangeIndex || (draft.coinBudget = 0)">
                <option :value="0">关闭</option>
                <option v-if="draft.exchangeIndex > 0 && !goods.some(item => item.index === draft?.exchangeIndex)" :value="draft.exchangeIndex">已选第 {{ draft.exchangeIndex }} 档</option>
                <option v-for="item in goods" :key="item.index" :value="item.index">{{ item.name }} · {{ item.unitPrice }} 福气币</option>
              </select>
            </label>
            <BaseButton type="button" variant="outline" class="min-h-11 justify-self-start" :loading="working === 'catalog'" @click="run('catalog')">读取可兑换商品</BaseButton>
          </div>
          <div v-if="draft.exchangeIndex > 0" class="grid gap-3 rounded-xl bg-gray-50 p-3 sm:grid-cols-2 dark:bg-gray-900/60">
            <label class="min-w-0 text-sm font-medium">
              每日福气币预算
              <input v-model.number="draft.coinBudget" type="number" min="1" max="999999999" step="1" :class="fieldClass">
            </label>
            <label class="min-w-0 text-sm font-medium">
              保留福气币
              <input v-model.number="draft.keepCoins" type="number" min="0" max="999999999" step="1" :class="fieldClass">
            </label>
            <p class="text-sm text-gray-600 sm:col-span-2 dark:text-gray-300">今日已用 {{ status?.spentToday ?? 0 }} 福气币</p>
          </div>
        </div>
      </fieldset>
      <div class="mt-4 flex flex-wrap items-center gap-3">
        <BaseButton type="submit" variant="primary" class="min-h-11" :loading="working === 'automation-settings'" :disabled="!!working">保存托管设置</BaseButton>
        <p v-if="message" role="status" class="text-sm text-green-700 dark:text-green-300">{{ message }}</p>
      </div>
    </form>
    <p v-if="status?.pending.length" class="mt-3 break-words rounded-lg bg-amber-50 px-3 py-2.5 text-sm text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
      待核对 {{ status.pending.map(value => label[value] || value).join('、') }}
    </p>
    <p v-if="status?.last" class="mt-3 break-words text-sm text-gray-600 dark:text-gray-300">
      最近处理 {{ label[status.last.action] || status.last.action }} · {{ status.last.state === 'confirmed' ? '回执已确认' : '状态已核对' }}
    </p>
    <p v-if="error" role="alert" class="mt-3 break-words rounded-lg bg-red-50 px-3 py-2.5 text-sm text-red-800 dark:bg-red-950/30 dark:text-red-200">{{ error }}</p>
  </section>
</template>
