<script setup lang="ts">
import type { Theme } from '@/utils/theme'
import { nextTick, ref } from 'vue'
import ThemePalette from '@/components/ThemePalette.vue'
import { useAppStore } from '@/stores/app'

const appStore = useAppStore()
const trigger = ref<HTMLButtonElement | null>(null)
const panel = ref<HTMLElement | null>(null)

function closePanel() {
  appStore.showThemePanel = false
  void nextTick(() => trigger.value?.focus())
}

function selectTheme(theme: Theme) {
  appStore.applyTheme(theme)
  closePanel()
}

function trapFocus(event: KeyboardEvent) {
  if (event.key !== 'Tab')
    return
  const buttons = Array.from(panel.value?.querySelectorAll<HTMLButtonElement>('button') || [])
  const first = buttons[0]
  const last = buttons[buttons.length - 1]
  if (first && last && ((event.shiftKey && document.activeElement === first) || (!event.shiftKey && document.activeElement === last))) {
    event.preventDefault()
    const target = event.shiftKey ? last : first
    target.focus()
  }
}
</script>

<template>
  <div class="relative">
    <button ref="trigger" type="button" class="theme-trigger icon-btn mx-2" title="主题设置" aria-label="主题设置" aria-haspopup="dialog" :aria-expanded="appStore.showThemePanel" @click="appStore.toggleThemePanel()">
      <div i-carbon-color-palette />
    </button>
    <Teleport to="body">
      <div v-if="appStore.showThemePanel" class="theme-dialog-backdrop" @click.self="closePanel">
        <div ref="panel" role="dialog" aria-modal="true" aria-label="选择界面主题" class="theme-dialog ui-card-elevated" @keydown="trapFocus" @keydown.esc.stop.prevent="closePanel">
          <div class="theme-dialog-heading">
            <div><h3>让农场更合眼缘</h3><p>八款配色，选择即刻生效</p></div>
            <button type="button" class="theme-close" aria-label="关闭主题设置" @click="closePanel">
              <span class="i-carbon-close" />
            </button>
          </div>
          <ThemePalette :current="appStore.currentTheme" @select="selectTheme" @close="closePanel" />
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.theme-trigger:focus-visible,
.theme-close:focus-visible {
  outline: 2px solid var(--theme-primary);
  outline-offset: 3px;
}
.theme-dialog-backdrop {
  position: fixed;
  inset: 0;
  z-index: 100;
  display: grid;
  place-items: center;
  padding: 16px;
  background: rgba(9, 19, 31, 0.4);
}
.theme-dialog {
  width: min(360px, calc(100vw - 32px));
  max-height: calc(100dvh - 32px);
  overflow-y: auto;
  padding: 20px;
  border-radius: 18px;
  color: var(--theme-text);
}
.theme-dialog-heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 18px;
}
.theme-dialog-heading h3 {
  margin: 0;
  font-size: 16px;
  font-weight: 700;
}
.theme-dialog-heading p {
  margin: 5px 0 0;
  color: var(--muted-text);
  font-size: 12px;
}
.theme-close {
  display: grid;
  flex-shrink: 0;
  place-items: center;
  width: 28px;
  height: 28px;
  border-radius: 7px;
  background: var(--surface-2);
}
</style>
