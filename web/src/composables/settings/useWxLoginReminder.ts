import { ref } from 'vue'
import api from '@/api'

type AlertType = 'primary' | 'danger'

export interface WxLoginReminderConfig {
  enabled: boolean
  barkServer: string
  deviceKey: string
  serverUrl: string
}

export interface NeedsRescanAccount {
  id: string
  name: string
}

const DEFAULT_CONFIG: WxLoginReminderConfig = {
  enabled: false,
  barkServer: 'https://api.day.app',
  deviceKey: '',
  serverUrl: '',
}

export function useWxLoginReminder(
  showAlert: (message: string, type?: AlertType) => void,
  getAccounts: () => Array<{ id: string, name: string, platform?: string, needsWxRescan?: boolean, username?: string }>,
) {
  const configLoading = ref(false)
  const configSaving = ref(false)
  const testing = ref(false)
  const reminderConfig = ref<WxLoginReminderConfig>({ ...DEFAULT_CONFIG })

  async function fetchReminderConfig() {
    configLoading.value = true
    try {
      const { data } = await api.get('/api/user/wx-login-reminder/config')
      if (data?.ok) {
        reminderConfig.value = { ...DEFAULT_CONFIG, ...data.config }
      }
    }
    catch (e) {
      console.error('加载微信重扫提醒配置失败', e)
    }
    finally {
      configLoading.value = false
    }
  }

  async function handleSaveReminder() {
    configSaving.value = true
    try {
      const { data } = await api.post('/api/user/wx-login-reminder/config', reminderConfig.value)
      if (data?.ok) {
        reminderConfig.value = { ...DEFAULT_CONFIG, ...data.config }
        const dispatched = Array.isArray(data.dispatched) ? data.dispatched.length : 0
        showAlert(dispatched > 0
          ? `微信重扫提醒设置已保存，并补发了 ${dispatched} 条待发提醒`
          : '微信重扫提醒设置已保存', 'primary')
      }
      else {
        const fields = data?.fields || {}
        const firstFieldError = Object.values(fields)[0]
        showAlert(`保存失败: ${firstFieldError || data?.error || '未知错误'}`, 'danger')
      }
    }
    catch (e: any) {
      const fields = e?.response?.data?.fields || {}
      const firstFieldError = Object.values(fields)[0]
      showAlert(`保存失败: ${firstFieldError || e?.response?.data?.error || e?.message || '请求失败'}`, 'danger')
    }
    finally {
      configSaving.value = false
    }
  }

  async function handleTestReminder() {
    testing.value = true
    try {
      const { data } = await api.post('/api/user/wx-login-reminder/test', {})
      if (data?.ok) {
        showAlert('测试通知已发送，请查看你的设备', 'primary')
      }
      else {
        showAlert(`测试失败: ${data?.error || '未知错误'}`, 'danger')
      }
    }
    catch (e: any) {
      showAlert(`测试失败: ${e?.response?.data?.error || e?.message || '请求失败'}`, 'danger')
    }
    finally {
      testing.value = false
    }
  }

  // 待重扫账号来自账号列表的 needsWxRescan 标记（服务端凭据判定结果）。
  const needsRescanAccounts = ref<NeedsRescanAccount[]>([])
  function syncNeedsRescanAccounts() {
    needsRescanAccounts.value = getAccounts()
      .filter(account => account.platform === 'wx' && account.needsWxRescan === true)
      .map(account => ({ id: String(account.id), name: String(account.name || account.id) }))
  }

  return {
    configLoading,
    configSaving,
    testing,
    reminderConfig,
    needsRescanAccounts,
    fetchReminderConfig,
    handleSaveReminder,
    handleTestReminder,
    syncNeedsRescanAccounts,
  }
}
