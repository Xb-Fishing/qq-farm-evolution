<script setup lang="ts">
import { useDateFormat, useIntervalFn, useNow, useStorage } from '@vueuse/core'
import { storeToRefs } from 'pinia'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import api from '@/api'
import ConfirmModal from '@/components/ConfirmModal.vue'
import ThemePalette from '@/components/ThemePalette.vue'

import { menuRoutes } from '@/router/menu'
import { useAccountStore } from '@/stores/account'
import { useAppStore } from '@/stores/app'
import { useShopStore } from '@/stores/shop'
import { useStatusStore } from '@/stores/status'
import { useToastStore } from '@/stores/toast'
import { useUserStore } from '@/stores/user'

const accountStore = useAccountStore()
const statusStore = useStatusStore()
const appStore = useAppStore()
const userStore = useUserStore()
const shopStore = useShopStore()
const toast = useToastStore()
const route = useRoute()
const router = useRouter()
const { currentAccount, currentAccountId } = storeToRefs(accountStore)
const { status, realtimeConnected } = storeToRefs(statusStore)
const { mysteryOffer, mysteryOfferAccountId } = storeToRefs(shopStore)
const { loginPageConfig, sidebarOpen } = storeToRefs(appStore)

const wsErrorNotifiedAt = ref<Record<string, number>>({})
const reminderOwner = computed(() => userStore.isAdmin ? userStore.username : '')
const readActivityIds = useStorage<number[]>(() => `activity-read-ids:${reminderOwner.value}`, [], undefined, { writeDefaults: false, flush: 'sync' })
const candidateIds = ref<number[]>([])
const unreadActivityIds = computed(() => {
  const read = new Set(Array.isArray(readActivityIds.value) ? readActivityIds.value : [])
  return candidateIds.value.filter(id => !read.has(id))
})
let reminderRequest = 0
let receivedReport = false
const brandLogoFailed = ref(false)

const systemConnected = ref(true)
const serverUptimeBase = ref(0)
const serverVersion = ref('')
const lastPingTime = ref(Date.now())
const now = useNow()
const formattedTime = useDateFormat(now, 'YYYY-MM-DD HH:mm:ss')
const fallbackAvatar = computed(() => userStore.isAdmin
  ? '/admin-default-avatar.jpg'
  : 'https://free.picui.cn/free/2026/03/10/69affe5755149.jpg')

function handleAvatarError(event: Event) {
  const image = event.target as HTMLImageElement
  if (image.src.endsWith(fallbackAvatar.value))
    return
  image.src = fallbackAvatar.value
}

async function checkConnection() {
  try {
    const res = await api.get('/api/ping')
    systemConnected.value = true
    if (res.data.ok && res.data.data) {
      if (res.data.data.uptime) {
        serverUptimeBase.value = res.data.data.uptime
        lastPingTime.value = Date.now()
      }
      if (res.data.data.version) {
        serverVersion.value = res.data.data.version
      }
    }
    const accountRef = currentAccount.value?.id || currentAccount.value?.uin
    if (accountRef) {
      statusStore.connectRealtime(String(accountRef))
    }
  }
  catch {
    systemConnected.value = false
  }
}

async function refreshStatusFallback() {
  if (realtimeConnected.value)
    return

  const accountRef = currentAccount.value?.id || currentAccount.value?.uin
  if (accountRef) {
    await statusStore.fetchStatus(String(accountRef))
  }
}

function markActivitiesRead() {
  if (route.path === '/activity' && reminderOwner.value && unreadActivityIds.value.length) {
    const prior = Array.isArray(readActivityIds.value) ? readActivityIds.value : []
    readActivityIds.value = [...prior, ...unreadActivityIds.value]
  }
}

async function refreshActivityUpdateReminder() {
  const owner = reminderOwner.value
  if (!owner)
    return
  const request = ++reminderRequest
  try {
    const { data } = await api.get('/api/activity/update/status')
    if (request !== reminderRequest || owner !== reminderOwner.value || data?.ok !== true
      || !Array.isArray(data.report?.unknownActivityIds) || data.report?.online?.available === false) {
      return
    }
    const reviewed = new Set<number>(Array.isArray(data.reviewedActivityIds) ? data.reviewedActivityIds.map(Number) : [])
    const ids = [...new Set<number>(data.report.unknownActivityIds.map(Number))]
      .filter(id => Number.isSafeInteger(id) && id > 0 && !reviewed.has(id))
    const previous = new Set(candidateIds.value)
    candidateIds.value = ids
    markActivitiesRead()
    const added = unreadActivityIds.value.filter(id => !previous.has(id))
    if (receivedReport && added.length)
      toast.warning(`新增 ${added.length} 个活动候选节点`, 8000)
    receivedReport = true
  }
  catch {
    // Keep the last successful report when polling fails.
  }
}

watch(reminderOwner, () => {
  reminderRequest++
  receivedReport = false
  candidateIds.value = []
  void refreshActivityUpdateReminder()
}, { immediate: true, flush: 'sync' })
watch(() => route.path, markActivitiesRead)

onMounted(() => {
  appStore.fetchLoginPageConfig()
  accountStore.fetchAccounts()
  checkConnection()
  // 获取当前用户信息
  userStore.fetchUserInfo()
  // 获取公告（普通用户）
  fetchAnnouncement()
})

watch(() => loginPageConfig.value.logoUrl, () => {
  brandLogoFailed.value = false
})

onBeforeUnmount(() => {
  reminderRequest++
  statusStore.disconnectRealtime()
})

useIntervalFn(checkConnection, 30000)
useIntervalFn(refreshActivityUpdateReminder, 60000)
useIntervalFn(() => {
  refreshStatusFallback()
  accountStore.fetchAccounts()
}, 10000)

watch(() => currentAccount.value?.id || currentAccount.value?.uin || '', () => {
  const accountRef = currentAccount.value?.id || currentAccount.value?.uin
  statusStore.connectRealtime(String(accountRef || ''))
  refreshStatusFallback()
}, { immediate: true })

watch(() => status.value?.wsError, (wsError: any) => {
  if (!wsError || Number(wsError.code) !== 400 || !currentAccount.value)
    return

  const errAt = Number(wsError.at) || 0
  const accId = String(currentAccount.value.id || currentAccount.value.uin || '')
  const lastNotified = wsErrorNotifiedAt.value[accId] || 0
  if (errAt <= lastNotified)
    return

  wsErrorNotifiedAt.value[accId] = errAt
  router.push('/settings')
}, { deep: true })

const uptime = computed(() => {
  const diff = Math.floor(serverUptimeBase.value + (now.value.getTime() - lastPingTime.value) / 1000)
  const h = Math.floor(diff / 3600)
  const m = Math.floor((diff % 3600) / 60)
  const s = diff % 60
  return `${h}h ${m}m ${s}s`
})

const connectionStatus = computed(() => {
  if (!systemConnected.value) {
    return {
      text: '系统离线',
      color: 'bg-red-500',
      pulse: false,
    }
  }

  if (!currentAccount.value?.id) {
    return {
      text: '请添加账号',
      color: 'bg-gray-400',
      pulse: false,
    }
  }

  const isConnected = status.value?.connection?.connected
  if (isConnected) {
    return {
      text: '运行中',
      color: 'bg-green-500',
      pulse: true,
    }
  }

  return {
    text: '未连接',
    color: 'bg-gray-400', // Or red? Old version uses gray/offline class which is gray usually
    pulse: false,
  }
})

// 根据用户角色过滤导航菜单
const navItems = computed(() => {
  const isAdmin = userStore.isAdmin
  return menuRoutes
    .filter(item => item.showInNav !== false && (!item.adminOnly || isAdmin))
    .map(item => ({
      path: item.path ? `/${item.path}` : '/',
      label: item.label,
      icon: item.icon,
    }))
})

const hasActiveMysteryOffer = computed(() => {
  const offer = mysteryOffer.value
  if (!currentAccountId.value || mysteryOfferAccountId.value !== String(currentAccountId.value))
    return false
  if (!offer?.active || offer.purchased)
    return false
  const endTime = Number(offer.endTime || 0)
  const endMs = endTime > 10_000_000_000 ? endTime : endTime * 1000
  return !endMs || endMs > Date.now()
})

const version = __APP_VERSION__

watch(
  () => route.path,
  () => {
    // Close sidebar on route change (mobile only)
    if (window.innerWidth < 1024)
      appStore.closeSidebar()
  },
)

// 用户相关
const showUserDropdown = ref(false)
// 公告相关
const showAnnouncementModal = ref(false)
const showAnnouncementViewModal = ref(false)
const announcementContent = ref('')
const announcementShowOnce = ref(true)
const announcementSaving = ref(false)
const announcementLoading = ref(false)
const showSaveAnnouncementConfirm = ref(false)
const currentAnnouncement = ref<{ content: string, showOnce: boolean, updatedAt: number, shouldShow?: boolean } | null>(null)
const showThemeDropdown = ref(false)
const themeTrigger = ref<HTMLButtonElement | null>(null)

function closeThemeDropdown() {
  showThemeDropdown.value = false
  void nextTick(() => themeTrigger.value?.focus())
}

const showTokenDropdown = ref(false)
const tokenVisible = ref(false)
const tokenCopied = ref(false)

async function handleLogout() {
  await userStore.logout()
  router.push('/login')
}

// 公告相关函数
async function openAnnouncementModal() {
  showUserDropdown.value = false
  announcementLoading.value = true
  showAnnouncementModal.value = true
  try {
    const res = await api.get('/api/announcement')
    if (res.data?.ok && res.data?.data) {
      announcementContent.value = res.data.data.content || ''
      announcementShowOnce.value = res.data.data.showOnce !== false
    }
  }
  catch (e) {
    console.error('获取公告失败', e)
  }
  finally {
    announcementLoading.value = false
  }
}

function openSaveAnnouncementConfirm() {
  showSaveAnnouncementConfirm.value = true
}

async function saveAnnouncement() {
  showSaveAnnouncementConfirm.value = false
  announcementSaving.value = true
  try {
    const res = await api.post('/api/admin/announcement', {
      content: announcementContent.value,
      showOnce: announcementShowOnce.value,
      confirmed: true,
    })
    if (res.data?.ok) {
      showAnnouncementModal.value = false
    }
    else {
      console.error('保存公告失败', res.data?.error)
    }
  }
  catch (e) {
    console.error('保存公告失败', e)
  }
  finally {
    announcementSaving.value = false
  }
}

async function fetchAnnouncement() {
  if (userStore.isAdmin)
    return
  try {
    const res = await api.get('/api/announcement')
    if (res.data?.ok && res.data?.data) {
      currentAnnouncement.value = res.data.data
      if (res.data.data.shouldShow && res.data.data.content) {
        showAnnouncementViewModal.value = true
      }
    }
  }
  catch (e) {
    console.error('获取公告失败', e)
  }
}

async function markAnnouncementRead() {
  try {
    await api.post('/api/announcement/read')
    showAnnouncementViewModal.value = false
  }
  catch (e) {
    console.error('标记公告已读失败', e)
  }
}

async function copyToken() {
  const tokenValue = userStore.token
  if (!tokenValue)
    return

  try {
    await navigator.clipboard.writeText(tokenValue)
    tokenCopied.value = true
    setTimeout(() => {
      tokenCopied.value = false
    }, 2000)
  }
  catch (e) {
    console.error('复制失败', e)
  }
}
</script>

<template>
  <aside
    class="fixed inset-y-0 left-0 z-50 h-full w-72 flex flex-col border-r border-gray-200/60 p-3 transition-transform duration-300 lg:static lg:translate-x-0 dark:border-gray-700/60"
    :class="sidebarOpen ? 'translate-x-0' : '-translate-x-full'"
    :style="{ background: 'color-mix(in srgb, var(--surface-1) 90%, transparent)', color: 'var(--theme-text)' }"
  >
    <!-- Brand -->
    <div class="relative h-16 flex flex-none items-center justify-between px-2">
      <div class="min-w-0 flex items-center gap-3">
        <div class="h-11 w-11 flex flex-none items-center justify-center overflow-hidden rounded-full shadow-sm ring-1 ring-gray-200 dark:ring-gray-700">
          <img
            v-if="loginPageConfig.logoUrl && !brandLogoFailed"
            :src="loginPageConfig.logoUrl"
            :alt="`${loginPageConfig.title || 'QQ农场智能助手'}图标`"
            class="h-full w-full scale-150 object-cover"
            @error="brandLogoFailed = true"
          >
          <div v-else class="i-carbon-sprout text-xl text-white" />
        </div>
        <div class="min-w-0">
          <div class="truncate text-[15px] font-bold tracking-tight" style="color: var(--theme-text);">
            {{ loginPageConfig.title || 'QQ农场智能助手' }}
          </div>
          <div class="truncate text-[11px] font-mono opacity-45" style="color: var(--theme-text);">
            QQ FARM ASSISTANT
          </div>
        </div>
      </div>
      <!-- Mobile Close Button -->
      <button
        class="h-8 w-8 flex flex-none items-center justify-center rounded-lg text-gray-500 transition lg:hidden hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-700"
        @click="appStore.closeSidebar"
      >
        <div class="i-carbon-close text-xl" />
      </button>
    </div>

    <!-- 渐变分隔线 -->
    <div class="mx-2 mb-3 h-px flex-none" style="background: linear-gradient(90deg, color-mix(in srgb, var(--theme-primary) 45%, transparent), transparent);" />

    <!-- User Info -->
    <div class="px-1 py-4">
      <div class="group relative">
        <button
          class="ui-card w-full flex items-center justify-between rounded-lg px-3.5 py-3 outline-none transition-all duration-200 hover:border-gray-300 hover:-translate-y-0.5 dark:hover:border-gray-600"
          style="--focus-ring: var(--theme-primary)"
          @click="showUserDropdown = !showUserDropdown"
        >
          <div class="flex items-center gap-3 overflow-hidden">
            <div class="h-9 w-9 flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-gray-200 ring-2 ring-white dark:bg-gray-600 dark:ring-gray-700">
              <img
                :src="userStore.avatar || fallbackAvatar"
                class="h-full w-full object-cover"
                @error="handleAvatarError"
              >
            </div>
            <div class="min-w-0 flex flex-col items-start">
              <span class="w-full truncate text-left text-sm font-medium">
                {{ userStore.username || '未登录' }}
              </span>
              <div class="mt-0.5 flex items-center gap-1.5">
                <span
                  class="rounded px-1 py-0.2 text-[10px] font-medium leading-tight"
                  :class="userStore.isAdmin ? 'bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200' : 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200'"
                >
                  {{ userStore.isAdmin ? '管理员' : '用户' }}
                </span>
              </div>
            </div>
          </div>
          <div
            class="i-carbon-chevron-down text-gray-400 transition-transform duration-200"
            :class="{ 'rotate-180': showUserDropdown }"
          />
        </button>

        <!-- User Dropdown Menu -->
        <div
          v-if="showUserDropdown"
          class="glass-panel absolute left-0 right-0 top-full z-50 mt-2 overflow-hidden rounded-lg py-1"
        >
          <div class="border-b border-gray-100 px-4 py-2 dark:border-gray-700">
            <div class="text-sm text-gray-900 font-medium dark:text-white">
              {{ userStore.username }}
            </div>
            <div class="text-xs text-gray-500 dark:text-gray-400">
              {{ userStore.isAdmin ? '管理员' : '普通用户' }}
            </div>
          </div>
          <div class="py-1">
            <button
              v-if="userStore.isAdmin"
              class="w-full flex items-center gap-2 px-4 py-2 text-sm transition-colors hover:bg-gray-100/50 dark:hover:bg-gray-700/50"
              :style="{ color: 'var(--theme-primary)' }"
              @click="openAnnouncementModal"
            >
              <div class="i-carbon-notification" />
              <span>设置公告</span>
            </button>
            <button
              class="w-full flex items-center gap-2 px-4 py-2 text-sm text-red-600 transition-colors hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-900/20"
              @click="handleLogout"
            >
              <div class="i-carbon-logout" />
              <span>退出登录</span>
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- Navigation -->
    <nav class="custom-scrollbar flex-1 overflow-y-auto px-1 py-1 space-y-1">
      <router-link
        v-for="item in navItems"
        :key="item.path"
        :to="item.path"
        :active-class="item.path === '/' ? '' : 'router-link-active'"
        :exact-active-class="item.path === '/' ? 'router-link-active' : 'router-link-exact-active'"
        class="nav-item group relative flex items-center gap-3 rounded-xl px-2 py-1.5 transition-colors duration-200"
      >
        <span class="nav-icon h-9 w-9 flex flex-none items-center justify-center rounded-lg text-[22px] transition-colors duration-200">
          <div :class="[item.icon]" />
        </span>
        <span class="min-w-0 flex-1 truncate text-sm font-medium">{{ item.label }}</span>
        <span
          v-if="item.path === '/shop' && hasActiveMysteryOffer"
          class="h-2 w-2 shrink-0 rounded-full bg-red-500 shadow-[0_0_0_3px_rgba(239,68,68,0.15)]"
          title="神秘商人已出现"
        />
        <span
          v-if="item.path === '/activity' && unreadActivityIds.length"
          class="h-2 w-2 shrink-0 rounded-full bg-red-500 shadow-[0_0_0_3px_rgba(239,68,68,0.15)]"
          :title="`${unreadActivityIds.length} 个未读活动候选节点`"
        />
      </router-link>
    </nav>

    <!-- Token Display (All Users) -->
    <div v-if="userStore.token" class="ui-subtle-panel mb-3 rounded-lg px-2 py-2">
      <button
        class="w-full flex items-center justify-between rounded-lg px-3 py-2 transition-colors hover:bg-gray-100/50 dark:hover:bg-gray-700/50"
        @click="showTokenDropdown = !showTokenDropdown"
      >
        <div class="flex items-center gap-2">
          <div class="i-carbon-key text-sm" :style="{ color: 'var(--theme-primary)' }" />
          <span class="text-xs text-gray-500 font-medium dark:text-gray-400">我的 Token</span>
        </div>
        <div
          class="i-carbon-chevron-down text-gray-400 transition-transform duration-200"
          :class="{ 'rotate-180': showTokenDropdown }"
        />
      </button>
      <div
        v-show="showTokenDropdown"
        class="px-1 pt-2 transition-all"
      >
        <div class="mb-1 flex items-center justify-between">
          <button
            class="flex items-center gap-1 rounded px-2 py-1 text-xs transition-colors hover:bg-gray-100 dark:hover:bg-gray-700"
            :class="tokenVisible ? 'text-blue-500' : 'text-gray-500 dark:text-gray-400'"
            @click="tokenVisible = !tokenVisible"
          >
            <div :class="tokenVisible ? 'i-carbon-view-off' : 'i-carbon-view'" />
            <span>{{ tokenVisible ? '隐藏' : '显示' }}</span>
          </button>
          <button
            class="flex items-center gap-1 rounded px-2 py-1 text-xs transition-colors hover:bg-gray-100 dark:hover:bg-gray-700"
            :class="tokenCopied ? 'text-green-500' : 'text-gray-500 dark:text-gray-400'"
            @click="copyToken"
          >
            <div v-if="tokenCopied" class="i-carbon-checkmark" />
            <div v-else class="i-carbon-copy" />
            <span>{{ tokenCopied ? '已复制' : '复制' }}</span>
          </button>
        </div>
        <div class="break-all rounded bg-gray-100/50 px-2 py-1.5 text-[10px] text-gray-600 font-mono dark:bg-gray-700/50 dark:text-gray-400">
          {{ tokenVisible ? userStore.token : '••••••••••••••••' }}
        </div>
      </div>
    </div>

    <!-- Footer Status -->
    <div class="relative mt-4 flex-none rounded-xl px-3 py-2.5" style="background: color-mix(in srgb, var(--surface-2) 80%, transparent);">
      <div class="flex items-center justify-between text-xs">
        <div class="flex items-center gap-1.5 font-medium" style="color: var(--theme-text);">
          <span
            class="h-2 w-2 rounded-full"
            :class="[connectionStatus.color, { 'animate-pulse': connectionStatus.pulse }]"
          />
          <span>{{ connectionStatus.text }}</span>
        </div>
        <span class="font-mono opacity-60" style="color: var(--theme-text);">{{ uptime }}</span>
      </div>

      <div class="mt-2 flex items-center justify-between border-t pt-2 text-xs opacity-80" style="border-color: color-mix(in srgb, var(--theme-text) 10%, transparent); color: var(--theme-text);">
        <span class="font-mono">{{ formattedTime }}</span>
        <!-- 主题调色盘按钮 -->
        <button
          ref="themeTrigger"
          class="h-7 w-7 flex items-center justify-center rounded-lg transition-colors hover:bg-gray-200/60 dark:hover:bg-gray-700/60"
          type="button"
          title="主题设置"
          aria-label="主题设置"
          aria-haspopup="dialog"
          :aria-expanded="showThemeDropdown"
          @click="showThemeDropdown = !showThemeDropdown"
        >
          <div class="i-carbon-color-palette text-sm" :style="{ color: 'var(--theme-primary)' }" />
        </button>
      </div>

      <div class="mt-1 flex items-center justify-between text-[11px] font-mono opacity-45" style="color: var(--theme-text);">
        <div class="flex items-center gap-2">
          <span>Web v{{ version }}</span>
          <a
            href="https://github.com/XyhTender/qq-farm-automation-bot"
            target="_blank"
            rel="noopener noreferrer"
            title="开源地址"
            class="inline-flex items-center transition-colors hover:opacity-70"
          >
            <div class="i-carbon-logo-github text-base" />
          </a>
        </div>
        <span v-if="serverVersion">Core v{{ serverVersion }}</span>
      </div>

      <!-- Shared preview keeps sidebar and dialog choices identical. -->
      <div
        v-if="showThemeDropdown" class="theme-sidebar-palette ui-card-elevated"
        role="dialog" aria-label="选择界面主题"
      >
        <div class="theme-sidebar-heading">
          <span>界面主题</span><button type="button" aria-label="关闭主题设置" @click="closeThemeDropdown">
            <span class="i-carbon-close" />
          </button>
        </div>
        <ThemePalette :current="appStore.currentTheme" @select="appStore.applyTheme($event); closeThemeDropdown()" @close="closeThemeDropdown" />
      </div>
    </div>
  </aside>

  <!-- Overlay for mobile when sidebar is open -->
  <div
    v-if="showUserDropdown"
    class="fixed inset-0 z-40 bg-transparent"
    @click="showUserDropdown = false"
  />

  <!-- 管理员设置公告弹窗 -->
  <div
    v-if="showAnnouncementModal"
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm"
    @click.self="showAnnouncementModal = false"
  >
    <div class="w-[500px] rounded-xl bg-white p-5 shadow-2xl dark:bg-gray-800" @click.stop>
      <h3 class="mb-4 text-lg text-gray-900 font-bold dark:text-gray-100">
        设置公告
      </h3>

      <div v-if="announcementLoading" class="flex justify-center py-8">
        <div class="i-svg-spinners-90-ring-with-bg text-2xl text-blue-500" />
      </div>

      <template v-else>
        <div class="mb-4">
          <label class="mb-1.5 block text-sm text-gray-600 dark:text-gray-400">
            公告内容
          </label>
          <textarea
            v-model="announcementContent"
            rows="6"
            placeholder="请输入公告内容（留空则不显示公告）"
            class="w-full border border-gray-200 rounded-lg bg-white px-3 py-2 text-sm dark:border-gray-600 focus:border-blue-500 dark:bg-gray-700 dark:text-white focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
        </div>

        <div class="mb-4 flex items-center gap-2">
          <input
            id="announcementShowOnce"
            v-model="announcementShowOnce"
            type="checkbox"
            class="h-4 w-4 border-gray-300 rounded text-blue-600 focus:ring-blue-500"
          >
          <label for="announcementShowOnce" class="text-sm text-gray-600 dark:text-gray-400">
            只显示一次（公告变动时再显示）
          </label>
        </div>

        <div class="flex justify-end gap-2">
          <button
            class="border border-gray-200 rounded-lg px-4 py-1.5 text-sm text-gray-600 transition dark:border-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-700"
            @click="showAnnouncementModal = false"
          >
            取消
          </button>
          <button
            class="rounded-lg px-4 py-1.5 text-sm text-white font-medium shadow transition disabled:cursor-not-allowed disabled:opacity-50 hover:opacity-90"
            :style="{ backgroundColor: 'var(--theme-primary)' }"
            :disabled="announcementSaving"
            @click="openSaveAnnouncementConfirm"
          >
            <div v-if="announcementSaving" class="i-svg-spinners-90-ring-with-bg mr-1 inline-block align-text-bottom" />
            保存
          </button>
        </div>
      </template>
    </div>
  </div>

  <ConfirmModal
    :show="showSaveAnnouncementConfirm"
    title="确认保存系统公告"
    message="确定要保存当前系统公告吗？保存后会立刻影响普通用户看到的公告内容与展示策略。"
    type="danger"
    :loading="announcementSaving"
    confirm-text="确认保存"
    cancel-text="取消"
    @confirm="saveAnnouncement"
    @close="!announcementSaving && (showSaveAnnouncementConfirm = false)"
    @cancel="!announcementSaving && (showSaveAnnouncementConfirm = false)"
  />

  <!-- 普通用户查看公告弹窗 -->
  <div
    v-if="showAnnouncementViewModal && currentAnnouncement?.content"
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm"
  >
    <div
      class="announcement-view-modal rounded-xl bg-white shadow-2xl dark:bg-gray-800"
      @click.stop
    >
      <div class="p-5">
        <div class="mb-4 flex items-center gap-2">
          <div class="i-carbon-notification text-xl" :style="{ color: 'var(--theme-primary)' }" />
          <h3 class="text-lg text-gray-900 font-bold dark:text-gray-100">
            系统公告
          </h3>
        </div>

        <div class="announcement-content mb-4 overflow-y-auto whitespace-pre-wrap rounded-lg bg-gray-50 p-4 text-sm text-gray-700 dark:bg-gray-700/50 dark:text-gray-300">
          {{ currentAnnouncement.content }}
        </div>

        <div class="flex justify-end">
          <button
            class="rounded-lg px-4 py-1.5 text-sm text-white font-medium shadow transition hover:opacity-90"
            :style="{ backgroundColor: 'var(--theme-primary)' }"
            @click="markAnnouncementRead"
          >
            我知道了
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.theme-sidebar-palette {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 100%;
  z-index: 50;
  margin-bottom: 8px;
  padding: 14px;
  border-radius: 16px;
  max-height: calc(100dvh - 160px);
  overflow-y: auto;
}
.theme-sidebar-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
  font-size: 13px;
  font-weight: 600;
  color: var(--theme-text);
}
.theme-sidebar-heading button {
  width: 28px;
  height: 28px;
  border-radius: 7px;
}
.theme-sidebar-heading button:focus-visible {
  outline: 2px solid var(--theme-primary);
  outline-offset: 2px;
}

.custom-scrollbar::-webkit-scrollbar {
  width: 4px;
}
.custom-scrollbar::-webkit-scrollbar-track {
  background: transparent;
}
.custom-scrollbar::-webkit-scrollbar-thumb {
  background-color: rgba(156, 163, 175, 0.3);
  border-radius: 2px;
}
.custom-scrollbar:hover::-webkit-scrollbar-thumb {
  background-color: rgba(156, 163, 175, 0.5);
}

/* ===== 导航菜单项 ===== */

/* 默认态 */
.nav-item {
  opacity: 0.82;
}
.nav-item:hover {
  background: var(--surface-2);
  opacity: 1;
}

/* 图标容器 */
.nav-item .nav-icon {
  color: color-mix(in srgb, var(--theme-text) 58%, transparent);
}
.nav-item:hover .nav-icon {
  background: color-mix(in srgb, var(--theme-text) 7%, transparent);
  color: var(--theme-text);
}

/* 选中态：渐变图标胶囊 + 左侧指示条 */
.router-link-active.nav-item,
.router-link-exact-active.nav-item {
  background: color-mix(in srgb, var(--theme-primary) 9%, transparent) !important;
  color: var(--theme-primary) !important;
  opacity: 1;
}

.router-link-active .nav-icon,
.router-link-exact-active .nav-icon {
  background: var(--theme-gradient) !important;
  color: #fff !important;
  box-shadow: 0 4px 12px color-mix(in srgb, var(--theme-primary) 28%, transparent);
}

.router-link-active::before,
.router-link-exact-active::before {
  content: '';
  position: absolute;
  top: 50%;
  left: -4px;
  width: 3px;
  height: 56%;
  transform: translateY(-50%);
  border-radius: 0 4px 4px 0;
  background: var(--theme-gradient);
}

/* 公告查看弹窗可调整大小 */
.announcement-view-modal {
  min-width: 320px;
  min-height: 200px;
  width: 500px;
  height: auto;
  max-width: 90vw;
  max-height: 90vh;
  resize: both;
  overflow: hidden;
  position: relative;
  display: flex;
  flex-direction: column;
}

.announcement-view-modal > div {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.announcement-content {
  flex: 1;
  min-height: 80px;
}

/* 自定义调整大小手柄样式 */
.announcement-view-modal::-webkit-resizer {
  background: linear-gradient(
    -45deg,
    transparent 50%,
    var(--theme-primary) 50%,
    var(--theme-primary) 60%,
    transparent 60%,
    transparent 70%,
    var(--theme-primary) 70%,
    var(--theme-primary) 80%,
    transparent 80%
  );
  border-radius: 0 0 12px 0;
}
</style>
