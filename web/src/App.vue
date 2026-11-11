<script setup lang="ts">
import { onMounted } from 'vue'
import { RouterView } from 'vue-router'
import ToastContainer from '@/components/ToastContainer.vue'
import { useAppStore } from '@/stores/app'

const appStore = useAppStore()

onMounted(() => {
  appStore.fetchTheme()
})
</script>

<template>
  <div class="app-root h-screen w-screen overflow-hidden" :style="{ color: 'var(--theme-text)' }">
    <RouterView />
    <ToastContainer />
  </div>
</template>

<style>
/* Global styles */
body {
  margin: 0;
  font-family: 'DM Sans', 'PingFang SC', 'Microsoft YaHei', sans-serif;
  background: var(--app-bg);
  color: var(--theme-text);
  font-feature-settings: 'cv02', 'cv03', 'cv04', 'cv11';
}

/* Color theme variables */
:root {
  --theme-bg: #f4f7fb;
  --theme-text: #182b42;
  --theme-primary: #1d4ed8;
  --theme-secondary: #1e40af;
  --theme-gradient: linear-gradient(135deg, #1d4ed8, #1e40af);
  --theme-on-primary: #ffffff;
  --theme-on-gradient: #ffffff;
  --app-bg: linear-gradient(160deg, var(--theme-bg), color-mix(in srgb, var(--theme-bg) 97%, var(--theme-primary)));
  --surface-1: color-mix(in srgb, var(--theme-bg) 12%, #ffffff);
  --surface-2: color-mix(in srgb, var(--theme-bg) 58%, #ffffff);
  --surface-3: color-mix(in srgb, var(--theme-bg) 84%, #ffffff);
  --surface-border: rgba(30, 48, 70, 0.1);
  --surface-border-strong: rgba(30, 48, 70, 0.18);
  --surface-shadow: 0 12px 32px rgba(24, 43, 66, 0.1);
  --surface-shadow-soft: 0 2px 8px rgba(24, 43, 66, 0.045);
  --muted-text: #5b6b7f;
  --input-bg: var(--surface-1);
  --panel-glow: color-mix(in srgb, var(--theme-primary) 6%, transparent);
}

.dark {
  --surface-1: color-mix(in srgb, var(--theme-bg) 92%, #ffffff);
  --surface-2: color-mix(in srgb, var(--theme-bg) 96%, #ffffff);
  --surface-3: color-mix(in srgb, var(--theme-bg) 87%, #ffffff);
  --surface-border: rgba(205, 220, 235, 0.12);
  --surface-border-strong: rgba(205, 220, 235, 0.24);
  --surface-shadow: 0 12px 32px rgba(0, 0, 0, 0.24);
  --surface-shadow-soft: 0 2px 8px rgba(0, 0, 0, 0.12);
  --muted-text: #a8b5c7;
  --input-bg: var(--surface-2);
  --panel-glow: color-mix(in srgb, var(--theme-primary) 5%, transparent);
}

.app-root {
  background: var(--app-bg);
}

/* Theme surfaces are explicit components, never overrides of utility colors. */
.ui-card {
  border: 1px solid var(--surface-border);
  background: var(--surface-1);
  box-shadow: var(--surface-shadow-soft);
}

.ui-card-elevated {
  border: 1px solid var(--surface-border);
  background: var(--surface-1);
  box-shadow: var(--surface-shadow);
}

.ui-subtle-panel {
  border: 1px solid var(--surface-border);
  background: color-mix(in srgb, var(--surface-2) 86%, transparent);
}

.glass-panel {
  border: 1px solid var(--surface-border);
  background: color-mix(in srgb, var(--surface-1) 96%, transparent);
  backdrop-filter: blur(8px);
  box-shadow: var(--surface-shadow-soft);
}

.metric-card {
  position: relative;
  overflow: hidden;
}

.metric-card::before {
  content: '';
  position: absolute;
  inset: 0;
  pointer-events: none;
  background:
    linear-gradient(135deg, var(--panel-glow), transparent 42%),
    linear-gradient(180deg, rgba(255, 255, 255, 0.12), transparent 34%);
}

.metric-card > * {
  position: relative;
}

/* Solid accent fills need their paired text color in every theme. */
.text-white[style*="background-color: var(--theme-primary)"] {
  color: var(--theme-on-primary);
}

/* Use CSS variables for theme colors */
.btn-primary {
  background: var(--theme-gradient);
  border-color: var(--theme-primary);
}

.btn-primary:hover {
  filter: brightness(0.94);
}

.text-primary {
  color: var(--theme-primary);
}

.bg-primary {
  background-color: var(--theme-primary);
}

.border-primary {
  border-color: var(--theme-primary);
}

.bg-gradient-primary {
  background: var(--theme-gradient);
}
</style>
