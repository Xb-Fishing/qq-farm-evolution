<script setup lang="ts">
import { computed } from 'vue'
import BaseInput from '@/components/ui/BaseInput.vue'
import BaseSwitch from '@/components/ui/BaseSwitch.vue'

interface StrategyTimingSettings {
  plantOrderRandom: boolean
  plantDelaySeconds: number
  stealDelaySeconds: number
  intervals: {
    farmMin: number
    farmMax: number
    helpMin: number
    helpMax: number
    stealMin: number
    stealMax: number
  }
  friendQuietHours: {
    enabled: boolean
    start: string
    end: string
    maxSleepMinutes: number
    minSleepMinutes: number
    wakeBeforeMinutes: number
    watchlistWakeBeforeMinutes: number
    pauseUntil: string
    idleProtectionEnabled: boolean
  }
}

const settings = defineModel<StrategyTimingSettings>('settings', { required: true })

type IntervalKey = keyof StrategyTimingSettings['intervals']

function intervalModel(key: IntervalKey) {
  return computed({
    get: () => settings.value.intervals[key],
    set: (value: number | string) => {
      const parsed = Number.parseInt(String(value), 10)
      settings.value = {
        ...settings.value,
        intervals: {
          ...settings.value.intervals,
          [key]: Number.isFinite(parsed) ? parsed : 1,
        },
      }
    },
  })
}

const farmMin = intervalModel('farmMin')
const farmMax = intervalModel('farmMax')
const helpMin = intervalModel('helpMin')
const helpMax = intervalModel('helpMax')
const stealMin = intervalModel('stealMin')
const stealMax = intervalModel('stealMax')

function addPauseMinutes(minutes: number) {
  const current = Date.parse(settings.value.friendQuietHours.pauseUntil || '')
  const base = Number.isFinite(current) && current > Date.now()
    ? current
    : Date.now()
  const next = new Date(base + minutes * 60 * 1000)
  next.setSeconds(0, 0)
  settings.value.friendQuietHours.pauseUntil = next.toISOString()
}

function toLocalInputValue(d: Date) {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

const pauseUntilLocal = computed({
  get: () => {
    const ts = Date.parse(settings.value.friendQuietHours.pauseUntil || '')
    return Number.isFinite(ts) ? toLocalInputValue(new Date(ts)) : ''
  },
  set: (value: string) => {
    if (!value) {
      settings.value.friendQuietHours.pauseUntil = ''
      return
    }
    const ts = new Date(value).getTime()
    settings.value.friendQuietHours.pauseUntil = Number.isFinite(ts)
      ? new Date(ts).toISOString()
      : ''
  },
})

const pauseRemainText = computed(() => {
  const ts = Date.parse(settings.value.friendQuietHours.pauseUntil || '')
  if (!Number.isFinite(ts) || ts <= Date.now())
    return ''
  const min = Math.ceil((ts - Date.now()) / 60000)
  if (min < 60)
    return `${min} 分钟`
  return `${Math.round((min / 60) * 10) / 10} 小时`
})

async function restartAccount() {
  const { useAccountStore } = await import('@/stores/account')
  const { default: api } = await import('@/api')
  const accountStore = useAccountStore()
  const accountId = accountStore.currentAccountId
  if (!accountId)
    return
  try {
    await api.post(`/api/accounts/${accountId}/restart`, {}, {
      headers: { 'x-account-id': accountId },
    })
    settings.value.friendQuietHours.pauseUntil = ''
  }
  catch { /* 账号未运行时 404 可忽略 */ }
}
</script>

<template>
  <div class="space-y-3">
    <div class="grid grid-cols-2 gap-3 md:grid-cols-4">
      <BaseInput
        v-model.number="farmMin"
        label="农场巡查最小 (秒)"
        type="number"
        min="1"
      />
      <BaseInput
        v-model.number="farmMax"
        label="农场巡查最大 (秒)"
        type="number"
        min="1"
      />
    </div>

    <div class="grid grid-cols-2 gap-3 md:grid-cols-2">
      <BaseInput
        v-model.number="helpMin"
        label="帮助巡查最小 (秒)"
        type="number"
        min="1"
      />
      <BaseInput
        v-model.number="helpMax"
        label="帮助巡查最大 (秒)"
        type="number"
        min="1"
      />
    </div>

    <div class="grid grid-cols-2 gap-3 md:grid-cols-2">
      <BaseInput
        v-model.number="stealMin"
        label="偷菜巡查最小 (秒)"
        type="number"
        min="1"
      />
      <BaseInput
        v-model.number="stealMax"
        label="偷菜巡查最大 (秒)"
        type="number"
        min="1"
      />
    </div>

    <div class="idle-rest-settings flex flex-wrap items-center gap-4 border-t pt-3 dark:border-gray-700">
      <BaseInput
        v-model.number="settings.friendQuietHours.minSleepMinutes"
        label="每次最短休息（分钟）"
        type="number"
        min="1"
        :max="settings.friendQuietHours.maxSleepMinutes"
      />
      <BaseInput
        v-model.number="settings.friendQuietHours.maxSleepMinutes"
        label="每次最长休息（分钟）"
        type="number"
        :min="settings.friendQuietHours.minSleepMinutes"
        max="720"
      />
      <BaseInput
        v-model.number="settings.friendQuietHours.wakeBeforeMinutes"
        label="普通好友盯梢窗口 (分钟)"
        type="number"
        min="5"
        max="180"
      />
      <BaseInput
        v-model.number="settings.friendQuietHours.watchlistWakeBeforeMinutes"
        label="重点好友盯梢窗口 (分钟)"
        type="number"
        min="5"
        max="360"
      />
      <p class="w-full text-xs text-gray-500 dark:text-gray-400">
        每次在你设置的最短与最长分钟数之间随机休息，没有额外的 10 分钟上限。
        若休息会跨入提前观察窗口，则缩短休息；不足最短时长时按正常节奏巡查。设置相同的最短和最长值可固定休息时长。
      </p>
      <BaseSwitch
        v-model="settings.friendQuietHours.idleProtectionEnabled"
        label="重点防护"
        class="min-h-11"
      />
      <p class="w-full text-xs text-gray-500 dark:text-gray-400">
        开启后，空闲歇息期间暂停农场、偷菜、帮助和重点好友动作，保留连接心跳，到点恢复；关闭后使用原有空闲策略。
        设置手动保存；关掉开关解除自动防护，不清除手动静默时间。
      </p>
      <div class="flex flex-wrap items-end gap-4">
        <div class="flex flex-col gap-1">
          <label class="text-xs text-gray-500 dark:text-gray-400">静默到（到点前不检测任何东西，防封用）</label>
          <input
            v-model="pauseUntilLocal"
            type="datetime-local"
            class="w-44 border border-gray-200 rounded bg-white px-2 py-1 text-xs dark:border-gray-600 dark:bg-gray-800 dark:text-white"
          >
        </div>
        <button
          class="rounded bg-gray-100 px-3 py-1.5 text-xs text-gray-600 transition hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600"
          @click="addPauseMinutes(60)"
        >
          +1小时
        </button>
        <button
          class="rounded bg-gray-100 px-3 py-1.5 text-xs text-gray-600 transition hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600"
          @click="addPauseMinutes(180)"
        >
          +3小时
        </button>
        <button
          class="rounded bg-gray-100 px-3 py-1.5 text-xs text-gray-600 transition hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600"
          @click="settings.friendQuietHours.pauseUntil = ''"
        >
          取消静默
        </button>
        <button
          class="rounded bg-blue-100 px-3 py-1.5 text-xs text-blue-700 transition hover:bg-blue-200 dark:bg-blue-900/30 dark:text-blue-400 dark:hover:bg-blue-900/50"
          @click="restartAccount"
        >
          立即重启（拉起全部功能）
        </button>
        <p v-if="pauseRemainText" class="text-xs text-orange-500">
          当前静默剩余：{{ pauseRemainText }}
        </p>
      </div>
      <p class="w-full text-xs text-gray-400 dark:text-gray-500">
        静默期间偷菜/农场/帮助/重点监控全部暂停，WebSocket 心跳保留不掉线，到点自动恢复。
        「立即重启」会清掉静默并重启账号，把全部功能立刻拉起来（保存按钮只存配置不重启）。
      </p>
      <BaseSwitch
        v-model="settings.friendQuietHours.enabled"
        label="启用静默时段"
      />
      <div class="flex items-center gap-2">
        <input
          v-model="settings.friendQuietHours.start"
          type="time"
          class="w-20 border border-gray-200 rounded bg-white px-2 py-1 text-xs dark:border-gray-600 dark:bg-gray-800 dark:text-white"
          :disabled="!settings.friendQuietHours.enabled"
        >
        <span class="text-xs text-gray-500">-</span>
        <input
          v-model="settings.friendQuietHours.end"
          type="time"
          class="w-20 border border-gray-200 rounded bg-white px-2 py-1 text-xs dark:border-gray-600 dark:bg-gray-800 dark:text-white"
          :disabled="!settings.friendQuietHours.enabled"
        >
      </div>
    </div>

    <div class="border-t pt-3 space-y-3 dark:border-gray-700">
      <h4 class="text-sm text-gray-700 font-medium dark:text-gray-300">
        种植与偷菜延迟设置
      </h4>
      <div class="grid grid-cols-1 gap-3 md:grid-cols-3">
        <BaseSwitch
          v-model="settings.plantOrderRandom"
          label="种植顺序随机"
        />
        <BaseInput
          v-model.number="settings.plantDelaySeconds"
          label="种植延迟 (秒)"
          type="number"
          min="0"
        />
        <BaseInput
          v-model.number="settings.stealDelaySeconds"
          label="偷菜延迟 (秒)"
          type="number"
          min="0"
        />
      </div>
    </div>
  </div>
</template>

<style scoped>
.idle-rest-settings :deep(.base-input) {
  min-height: 42px;
}
</style>
