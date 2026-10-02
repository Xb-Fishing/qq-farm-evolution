<script setup lang="ts">
import type { NeedsRescanAccount, WxLoginReminderConfig } from '@/composables/settings/useWxLoginReminder'
import { useRouter } from 'vue-router'
import BaseButton from '@/components/ui/BaseButton.vue'
import BaseInput from '@/components/ui/BaseInput.vue'
import BaseSwitch from '@/components/ui/BaseSwitch.vue'

defineProps<{
  saving: boolean
  testing: boolean
  needsRescanAccounts: NeedsRescanAccount[]
}>()

const emit = defineEmits<{
  save: []
  test: []
}>()

const config = defineModel<WxLoginReminderConfig>('config', { required: true })

const router = useRouter()

function openHelp(accountId: string) {
  router.push({ name: 'wxLoginHelp', query: { accountId } })
}
</script>

<template>
  <div class="border border-gray-200 rounded-lg bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
    <h4 class="mb-1 flex items-center gap-2 text-base text-gray-900 font-bold dark:text-gray-100">
      <div class="i-carbon-notification" />
      微信重扫提醒（Bark）
    </h4>
    <p class="mb-3 text-xs text-gray-500 dark:text-gray-400">
      凭据被系统确认失效、必须重新扫码时向你的 iPhone 发一条提醒（正常续期、临时网络波动不打扰）；
      另可选按自设周期的「扫码维护参考计划」提前提醒，方便你提前准备重扫。
    </p>

    <div
      v-if="needsRescanAccounts.length"
      class="mb-3 border border-amber-300 rounded bg-amber-50 p-3 text-sm dark:border-amber-700 dark:bg-amber-900/20"
    >
      <div class="mb-1 text-amber-800 font-medium dark:text-amber-300">
        以下账号需要重新扫码：
      </div>
      <div class="flex flex-wrap gap-2">
        <BaseButton
          v-for="account in needsRescanAccounts"
          :key="account.id"
          variant="secondary"
          size="sm"
          @click="openHelp(account.id)"
        >
          {{ account.name }} 去扫码
        </BaseButton>
      </div>
    </div>

    <div class="space-y-3">
      <div class="flex items-center justify-between gap-3">
        <span class="text-sm text-gray-700 font-medium dark:text-gray-300">启用提醒</span>
        <BaseSwitch v-model="config.enabled" />
      </div>

      <div class="grid grid-cols-1 gap-3 md:grid-cols-2">
        <BaseInput
          v-model="config.barkServer"
          label="Bark 服务器"
          type="text"
          placeholder="https://api.day.app（自建可改）"
        />
        <BaseInput
          v-model="config.deviceKey"
          label="设备 Key"
          type="password"
          placeholder="Bark 复制的 Key，或直接粘贴完整推送链接"
        />
      </div>

      <BaseInput
        v-model="config.serverUrl"
        label="面板访问地址（手机可打开）"
        type="text"
        placeholder="如 http://farm.example.com:3007"
      />
      <p class="text-xs text-gray-500 dark:text-gray-400">
        手机必须能访问这个地址（不能用 localhost / 127.0.0.1）。
        它用于提醒里的自助链接和二维码图片；发送二维码时手机无需已在面板页面。
      </p>

      <div class="mt-3 border-t pt-3 space-y-3 dark:border-gray-700">
        <div class="flex items-center justify-between gap-3">
          <span class="text-sm text-gray-700 font-medium dark:text-gray-300">扫码维护参考计划</span>
          <BaseSwitch v-model="config.advanceEnabled" />
        </div>
        <p class="text-xs text-gray-500 dark:text-gray-400">
          以你上次成功扫码的时间为基线，按自设周期计算参考维护时间，并在到期前提前提醒你准备重扫。
          这是你自行调整的计划参考，<b>不是</b>微信官方到期时间，也不能保证零断线。
          同次扫码只自动提醒一次；若尚未提前提醒，实际失效时再提醒，成功重扫后开始下一轮。
          仅当最近 24 小时内观察到「已在其他终端登录」的踢下线记录（作为手机进场参考）时才会发送
          周期提醒；提前提醒不会自动生成二维码，也不会改动正在运行的账号。
        </p>
        <div class="grid grid-cols-1 gap-3 md:grid-cols-2">
          <BaseInput
            v-model="config.maintenanceCycleHours"
            label="维护周期（小时，4–168）"
            type="number"
            min="4"
            max="168"
            step="1"
          />
          <BaseInput
            v-model="config.advanceMinutes"
            label="提前提醒（分钟，≥5 且小于周期）"
            type="number"
            min="5"
            step="1"
          />
        </div>
        <p class="text-xs text-gray-400">
          关闭后不发周期提前提醒；若该次扫码尚未提前提醒过，实际失效时仍会提醒一次。
          计划进度可在账号的「微信重新扫码」页面查看。
        </p>
      </div>
    </div>

    <div class="mt-4 flex justify-end gap-2 border-t pt-3 dark:border-gray-700">
      <BaseButton
        variant="secondary"
        size="sm"
        :loading="testing"
        :disabled="saving"
        @click="emit('test')"
      >
        测试通知
      </BaseButton>
      <BaseButton
        variant="primary"
        size="sm"
        :loading="saving"
        :disabled="testing"
        @click="emit('save')"
      >
        保存提醒设置
      </BaseButton>
    </div>

    <p class="mt-2 text-xs text-gray-400">
      Apple Watch 的显示取决于 iPhone 通知镜像设置；二维码图片与按钮以 iPhone 实际收到为准。
    </p>
  </div>
</template>
