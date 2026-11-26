<script setup lang="ts">
import type { AdminTabKey } from '@/components/admin/AdminPanelTabs.vue'
import { onMounted, ref, watch } from 'vue'
import AdminAlertModal from '@/components/admin/AdminAlertModal.vue'
import AdminLoginLogConfirmModal from '@/components/admin/AdminLoginLogConfirmModal.vue'
import AdminLoginLogPanel from '@/components/admin/AdminLoginLogPanel.vue'
import AdminPanelHeader from '@/components/admin/AdminPanelHeader.vue'
import AdminPanelTabs from '@/components/admin/AdminPanelTabs.vue'
import AdminSystemConfigConfirmModals from '@/components/admin/AdminSystemConfigConfirmModals.vue'
import AdminSystemPanel from '@/components/admin/AdminSystemPanel.vue'
import { useAdminLoginLogs } from '@/composables/useAdminLoginLogs'
import { useAdminSystemConfig } from '@/composables/useAdminSystemConfig'
import { useToastStore } from '@/stores/toast'

const toast = useToastStore()

const savedAdminTab = localStorage.getItem('admin-active-tab')
const activeTab = ref<AdminTabKey>(['log', 'system'].includes(savedAdminTab || '')
  ? savedAdminTab as AdminTabKey
  : 'system')

watch(activeTab, (newTab) => {
  localStorage.setItem('admin-active-tab', newTab)
})

const tabs = [
  { key: 'log', label: '日志', icon: 'i-carbon-document' },
  { key: 'system', label: '系统', icon: 'i-carbon-settings' },
] as const

const modalVisible = ref(false)
const modalConfig = ref({
  title: '',
  message: '',
  type: 'primary' as 'primary' | 'danger',
  isAlert: true,
})

function showAlert(message: string, type: 'primary' | 'danger' = 'primary') {
  modalConfig.value = {
    title: type === 'danger' ? '错误' : '提示',
    message,
    type,
    isAlert: true,
  }
  modalVisible.value = true
}

const showClearLogsConfirm = ref(false)
const {
  loginLogs,
  loginLogsLoading,
  loginLogsTotal,
  clearLogsLoading,
  loginSuccessCount,
  loginFailedCount,
  loginLogSummary,
  fetchLoginLogs,
  clearLoginLogs,
} = useAdminLoginLogs()

function openClearLogsConfirm() {
  if (loginLogsTotal.value === 0) {
    toast.warning('暂无日志可清空')
    return
  }
  showClearLogsConfirm.value = true
}

async function confirmClearLogs() {
  const cleared = await clearLoginLogs()
  if (cleared)
    showClearLogsConfirm.value = false
}

const {
  systemConfigSaving,
  wxConfigSaving,
  captureConfigSaving,
  captureConfigTesting,
  loginLinksSaving,
  loginLogoUploading,
  showResetSystemConfirm,
  showSaveSystemConfirm,
  showResetLoginLinksConfirm,
  showResetWxConfigConfirm,
  showSaveWxConfigConfirm,
  localSystemConfig,
  defaultSystemConfig,
  localWxConfig,
  localCaptureConfig,
  localLoginLinks,
  platformOptions,
  osOptions,
  loadWxConfig,
  loadCaptureConfig,
  handleTestCaptureConfig,
  handleSaveCaptureConfig,
  loadLoginLinks,
  handleSaveLoginLinks,
  handleResetLoginLinks,
  openResetLoginLinksConfirm,
  handleUploadLoginLogo,
  handleSaveWxConfig,
  handleResetWxConfig,
  openResetWxConfigConfirm,
  openSaveWxConfigConfirm,
  loadSystemConfig,
  handleSaveSystemConfig,
  handleResetSystemConfig,
  openResetSystemConfirm,
  openSaveSystemConfirm,
} = useAdminSystemConfig({ showAlert })

onMounted(() => {
  fetchLoginLogs()
  loadSystemConfig()
  loadWxConfig()
  loadCaptureConfig()
  loadLoginLinks()
})
</script>

<template>
  <div class="admin-panel">
    <AdminPanelHeader
      :login-logs-total="loginLogsTotal"
    />

    <AdminPanelTabs v-model:active-tab="activeTab" :tabs="tabs">
      <AdminLoginLogPanel
        v-if="activeTab === 'log'"
        :logs="loginLogs"
        :loading="loginLogsLoading"
        :total="loginLogsTotal"
        :success-count="loginSuccessCount"
        :failed-count="loginFailedCount"
        :summary="loginLogSummary"
        @refresh="fetchLoginLogs"
        @clear="openClearLogsConfirm"
      />

      <AdminSystemPanel
        v-else-if="activeTab === 'system'"
        v-model:local-system-config="localSystemConfig"
        v-model:local-wx-config="localWxConfig"
        v-model:local-capture-config="localCaptureConfig"
        v-model:local-login-links="localLoginLinks"
        :default-system-config="defaultSystemConfig"
        :platform-options="platformOptions"
        :os-options="osOptions"
        :system-config-saving="systemConfigSaving"
        :wx-config-saving="wxConfigSaving"
        :capture-config-saving="captureConfigSaving"
        :capture-config-testing="captureConfigTesting"
        :login-links-saving="loginLinksSaving"
        :login-logo-uploading="loginLogoUploading"
        @reset-system="openResetSystemConfirm"
        @save-system="openSaveSystemConfirm"
        @reset-login-links="openResetLoginLinksConfirm"
        @reset-wx="openResetWxConfigConfirm"
        @save-wx="openSaveWxConfigConfirm"
        @test-capture="handleTestCaptureConfig"
        @save-capture="handleSaveCaptureConfig"
        @save-login-links="handleSaveLoginLinks"
        @upload-login-logo="handleUploadLoginLogo"
      />

    </AdminPanelTabs>

    <AdminLoginLogConfirmModal
      v-model:show="showClearLogsConfirm"
      :total="loginLogsTotal"
      :loading="clearLogsLoading"
      @clear="confirmClearLogs"
    />

    <AdminSystemConfigConfirmModals
      v-model:show-reset-system-confirm="showResetSystemConfirm"
      v-model:show-save-system-confirm="showSaveSystemConfirm"
      v-model:show-reset-login-links-confirm="showResetLoginLinksConfirm"
      v-model:show-reset-wx-config-confirm="showResetWxConfigConfirm"
      v-model:show-save-wx-config-confirm="showSaveWxConfigConfirm"
      :system-config-saving="systemConfigSaving"
      :wx-config-saving="wxConfigSaving"
      :login-links-saving="loginLinksSaving"
      @reset-login-links="handleResetLoginLinks"
      @reset-system="handleResetSystemConfig"
      @save-system="handleSaveSystemConfig"
      @reset-wx="handleResetWxConfig"
      @save-wx="handleSaveWxConfig"
    />

    <AdminAlertModal
      v-model:show="modalVisible"
      :config="modalConfig"
    />
  </div>
</template>

<style scoped lang="postcss">
</style>
