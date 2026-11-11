export const THEME_KEY = 'ui_theme'
export const DEFAULT_THEME = 'light-blue'
export type Theme = 'light-blue' | 'light-green' | 'light-pink' | 'dark-blue' | 'dark-purple' | 'dark-teal' | 'dark-orange' | 'dark-red'

export interface ThemeDefinition {
  name: string
  isDark: boolean
  bg: string
  text: string
  primary: string
  secondary: string
  gradient: string
  icon: string
}

export const THEMES: Record<Theme, ThemeDefinition> = {
  'light-blue': { name: '晴空蓝', isDark: false, bg: '#f4f7fb', text: '#182b42', primary: '#1d4ed8', secondary: '#1e40af', gradient: 'linear-gradient(135deg, #1d4ed8, #1e40af)', icon: 'i-carbon-sun' },
  'light-green': { name: '清新绿', isDark: false, bg: '#f2f7f3', text: '#193329', primary: '#166534', secondary: '#14532d', gradient: 'linear-gradient(135deg, #166534, #14532d)', icon: 'i-fas-leaf' },
  'light-pink': { name: '樱花粉', isDark: false, bg: '#fbf4f7', text: '#382631', primary: '#be185d', secondary: '#9d174d', gradient: 'linear-gradient(135deg, #be185d, #9d174d)', icon: 'i-carbon-favorite' },
  'dark-blue': { name: '深海蓝', isDark: true, bg: '#101b2b', text: '#edf3fc', primary: '#93c5fd', secondary: '#bfdbfe', gradient: 'linear-gradient(135deg, #1d4ed8, #1e40af)', icon: 'i-carbon-moon' },
  'dark-purple': { name: '紫罗兰', isDark: true, bg: '#1a1728', text: '#f2eefa', primary: '#d8b4fe', secondary: '#e9d5ff', gradient: 'linear-gradient(135deg, #6b21a8, #581c87)', icon: 'i-fas-crown' },
  'dark-teal': { name: '青空青', isDark: true, bg: '#102323', text: '#e1f3ef', primary: '#5eead4', secondary: '#99f6e4', gradient: 'linear-gradient(135deg, #115e59, #134e4a)', icon: 'i-carbon-tree' },
  'dark-orange': { name: '暖阳橙', isDark: true, bg: '#241e19', text: '#fff3e2', primary: '#fcd34d', secondary: '#fde68a', gradient: 'linear-gradient(135deg, #92400e, #78350f)', icon: 'i-carbon-sun' },
  'dark-red': { name: '绯红夜', isDark: true, bg: '#271b20', text: '#fff0f2', primary: '#fda4af', secondary: '#fecdd3', gradient: 'linear-gradient(135deg, #9f1239, #881337)', icon: 'i-carbon-close-filled' },
}

export function isTheme(value: unknown): value is Theme {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(THEMES, value)
}

export function normalizeTheme(value: unknown): Theme {
  return isTheme(value) ? value : DEFAULT_THEME
}

export function readSavedTheme(): Theme | null {
  try {
    const value = localStorage.getItem(THEME_KEY)
    return isTheme(value) ? value : null
  }
  catch {
    return null
  }
}

export function saveTheme(theme: Theme) {
  try {
    localStorage.setItem(THEME_KEY, theme)
  }
  catch { /* Theme controls remain usable when browser storage is restricted. */ }
}

export function applyThemeToDocument(value: unknown): Theme {
  const key = normalizeTheme(value)
  const theme = THEMES[key]
  if (typeof document === 'undefined')
    return key
  const root = document.documentElement
  if (!root)
    return key
  for (const property of ['bg', 'text', 'primary', 'secondary', 'gradient'] as const)
    root.style.setProperty(`--theme-${property}`, theme[property])
  root.style.setProperty('--theme-on-primary', theme.isDark ? theme.bg : '#ffffff')
  root.style.setProperty('--theme-on-gradient', '#ffffff')
  root.style.colorScheme = theme.isDark ? 'dark' : 'light'
  root.classList.toggle('dark', theme.isDark)
  return key
}

export function pairedTheme(theme: Theme): Theme {
  const pairs: Record<Theme, Theme> = {
    'light-blue': 'dark-blue',
    'light-green': 'dark-teal',
    'light-pink': 'dark-red',
    'dark-blue': 'light-blue',
    'dark-purple': 'light-pink',
    'dark-teal': 'light-green',
    'dark-orange': 'light-green',
    'dark-red': 'light-pink',
  }
  return pairs[theme]
}
