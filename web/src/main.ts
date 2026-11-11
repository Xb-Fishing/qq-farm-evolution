import { createPinia } from 'pinia'
import { createApp } from 'vue'
import { useAppStore } from '@/stores/app'
import { useToastStore } from '@/stores/toast'
import { installDailyFeedback, recordClientFailure } from '@/utils/daily-feedback'
import { applyThemeToDocument, DEFAULT_THEME, readSavedTheme } from '@/utils/theme'
import App from './App.vue'
import router from './router'
import '@unocss/reset/tailwind.css'
import 'virtual:uno.css'
import './style.css'

const app = createApp(App)
const pinia = createPinia()

app.use(pinia)
app.use(router)

// The first frame and the app store use the same palette and default.
applyThemeToDocument(readSavedTheme() || DEFAULT_THEME)

// Global Error Handling
const toast = useToastStore()

app.config.errorHandler = (err: any, _instance, info) => {
  console.error('全局 Vue 错误:', err, info)
  const message = err.message || String(err)
  if (message.includes('ResizeObserver loop'))
    return
  recordClientFailure('vue_error')
  toast.error(`应用错误: ${message}`)
}

window.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason
  if (reason && typeof reason === 'object' && 'isAxiosError' in reason)
    return

  console.error('Unhandled Rejection:', reason)
  recordClientFailure('unhandled_rejection')
  const message = reason?.message || String(reason)
  toast.error(`异步错误: ${message}`)
})

window.onerror = (message, _source, _lineno, _colno, error) => {
  console.error('Global Error:', message, error)
  if (String(message).includes('Script error'))
    return
  recordClientFailure('script_error')
  toast.error(`系统错误: ${message}`)
}

// Apply theme from localStorage immediately, then sync from server if authed
const appStore = useAppStore()
appStore.fetchTheme()

installDailyFeedback()
app.mount('#app')
