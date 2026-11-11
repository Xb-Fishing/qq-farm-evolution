import type { Theme } from '@/utils/theme'
import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import api from '@/api'
import { applyThemeToDocument, DEFAULT_THEME, isTheme, normalizeTheme, pairedTheme, readSavedTheme, saveTheme, THEMES } from '@/utils/theme'

export type { Theme } from '@/utils/theme'

export interface LoginPageConfig {
  logoUrl: string
  title: string
  loginSubtitle: string
  registerSubtitle: string
  purchaseUrl: string
  qqGroupUrl: string
}

const defaultLoginPageConfig: LoginPageConfig = {
  logoUrl: '',
  title: 'QQ农场智能助手',
  loginSubtitle: '欢迎回来，开启智慧农耕之旅',
  registerSubtitle: '创建账号，开启智慧农耕之旅',
  purchaseUrl: '',
  qqGroupUrl: '',
}

export const useAppStore = defineStore('app', () => {
  const sidebarOpen = ref(false)
  const restoredTheme = readSavedTheme()
  const currentTheme = ref<Theme>(restoredTheme || DEFAULT_THEME)
  let themeRevision = 0
  let themeRequest = 0
  let hasLocalChoice = restoredTheme !== null
  let lastLight: Theme = THEMES[currentTheme.value].isDark ? pairedTheme(currentTheme.value) : currentTheme.value
  let lastDark: Theme = THEMES[currentTheme.value].isDark ? currentTheme.value : pairedTheme(currentTheme.value)
  const showThemePanel = ref(false)
  const loginPageConfig = ref<LoginPageConfig>({ ...defaultLoginPageConfig })
  let loginPageConfigPromise: Promise<void> | null = null

  const themes = THEMES

  function toggleSidebar() {
    sidebarOpen.value = !sidebarOpen.value
  }

  function closeSidebar() {
    sidebarOpen.value = false
  }

  function openSidebar() {
    sidebarOpen.value = true
  }

  async function fetchTheme() {
    if (hasLocalChoice)
      return
    const revision = themeRevision
    const request = ++themeRequest
    try {
      const res = await api.get('/api/settings')
      const theme = res.data?.data?.ui?.theme
      if (res.data?.ok && isTheme(theme) && revision === themeRevision && request === themeRequest)
        applyTheme(theme)
    }
    catch {
      // A missing account setting never overrides the local/default palette.
    }
  }

  async function fetchLoginPageConfig() {
    if (loginPageConfigPromise)
      return loginPageConfigPromise

    loginPageConfigPromise = api.get('/api/public/login-links').then((res) => {
      if (res.data?.ok && res.data.data) {
        loginPageConfig.value = { ...defaultLoginPageConfig, ...res.data.data }
        document.title = loginPageConfig.value.title || defaultLoginPageConfig.title
      }
    }).catch(() => {
      // 保留默认品牌，页面仍可正常使用。
    }).finally(() => {
      loginPageConfigPromise = null
    })
    return loginPageConfigPromise
  }

  function syncTheme(theme: Theme) {
    applyThemeToDocument(theme)
    saveTheme(theme)
    if (THEMES[theme].isDark)
      lastDark = theme
    else
      lastLight = theme
  }

  function applyTheme(value: Theme) {
    themeRevision += 1
    hasLocalChoice = true
    const theme = normalizeTheme(value)
    currentTheme.value = theme
    syncTheme(theme)
  }

  function toggleThemePanel() {
    showThemePanel.value = !showThemePanel.value
  }

  function toggleDark() {
    applyTheme(THEMES[currentTheme.value].isDark ? lastLight : lastDark)
  }

  const isDark = computed(() => themes[currentTheme.value]?.isDark ?? false)

  watch(currentTheme, (val) => {
    themeRevision += 1
    hasLocalChoice = true
    const theme = normalizeTheme(val)
    if (theme !== val)
      currentTheme.value = theme
    syncTheme(theme)
  })

  applyThemeToDocument(currentTheme.value)

  return {
    sidebarOpen,
    isDark,
    currentTheme,
    showThemePanel,
    loginPageConfig,
    themes,
    applyTheme,
    toggleThemePanel,
    toggleDark,
    toggleSidebar,
    closeSidebar,
    openSidebar,
    fetchTheme,
    fetchLoginPageConfig,
  }
})
