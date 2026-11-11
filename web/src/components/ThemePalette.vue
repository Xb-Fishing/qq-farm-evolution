<script setup lang="ts">
import type { Theme } from '@/utils/theme'
import { onMounted, ref } from 'vue'
import { THEMES } from '@/utils/theme'

const props = defineProps<{ current: Theme }>()
const emit = defineEmits<{ select: [theme: Theme], close: [] }>()
const root = ref<HTMLElement | null>(null)
const groups = [
  { label: '日间 · 清爽明亮', themes: Object.keys(THEMES).filter(key => !THEMES[key as Theme].isDark) as Theme[] },
  { label: '夜间 · 柔和护眼', themes: Object.keys(THEMES).filter(key => THEMES[key as Theme].isDark) as Theme[] },
]

function moveFocus(event: KeyboardEvent) {
  const options = Array.from(root.value?.querySelectorAll<HTMLButtonElement>('button[data-theme]') || [])
  const index = options.indexOf(document.activeElement as HTMLButtonElement)
  let target = -1
  if (event.key === 'ArrowRight' || event.key === 'ArrowDown')
    target = (index + 1) % options.length
  else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp')
    target = (index - 1 + options.length) % options.length
  else if (event.key === 'Home')
    target = 0
  else if (event.key === 'End')
    target = options.length - 1
  const option = options[target]
  if (target >= 0 && option) {
    event.preventDefault()
    option.focus()
  }
}

onMounted(() => {
  root.value?.querySelector<HTMLButtonElement>('button[aria-pressed="true"]')?.focus()
})
</script>

<template>
  <section ref="root" class="theme-palette" aria-label="界面主题" @keydown="moveFocus" @keydown.esc.stop.prevent="emit('close')">
    <div v-for="group in groups" :key="group.label" class="palette-group">
      <h4 class="palette-group-title">
        {{ group.label }}
      </h4>
      <div class="palette-grid">
        <button
          v-for="key in group.themes" :key="key" type="button" class="palette-option"
          :data-theme="key" :aria-pressed="props.current === key"
          :aria-label="`${THEMES[key].name}${props.current === key ? '，当前使用' : ''}`"
          :style="{ '--preview-bg': THEMES[key].bg, '--preview-text': THEMES[key].text, '--preview-accent': THEMES[key].primary }"
          @click="emit('select', key)"
        >
          <span class="palette-preview" aria-hidden="true">
            <span class="palette-preview-nav" />
            <span class="palette-preview-content"><span /><span /><span /></span>
          </span>
          <span class="palette-option-name"><span :class="THEMES[key].icon" />{{ THEMES[key].name }}</span>
          <span class="palette-selected">{{ props.current === key ? '✓ 当前使用' : '点击预览' }}</span>
        </button>
      </div>
    </div>
  </section>
</template>

<style scoped>
.theme-palette {
  display: grid;
  gap: 16px;
  color: var(--theme-text);
}
.palette-group-title {
  margin: 0 0 8px;
  color: var(--muted-text);
  font-size: 12px;
  font-weight: 600;
}
.palette-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}
.palette-option {
  min-width: 0;
  padding: 10px;
  border: 1px solid var(--surface-border-strong);
  border-radius: 12px;
  text-align: left;
  background: var(--surface-1);
  transition:
    border-color 0.15s,
    box-shadow 0.15s;
}
.palette-option:hover {
  border-color: var(--theme-primary);
}
.palette-option[aria-pressed='true'] {
  border-color: var(--theme-primary);
  box-shadow: 0 0 0 1px var(--theme-primary);
}
.palette-option:focus-visible {
  outline: 2px solid var(--theme-primary);
  outline-offset: 3px;
}
.palette-preview {
  display: flex;
  height: 48px;
  padding: 6px;
  gap: 6px;
  border-radius: 7px;
  background: var(--preview-bg);
}
.palette-preview-nav {
  width: 12px;
  border-radius: 3px;
  background: var(--preview-accent);
  opacity: 0.8;
}
.palette-preview-content {
  flex: 1;
  display: grid;
  gap: 5px;
  align-content: center;
}
.palette-preview-content span {
  height: 4px;
  border-radius: 2px;
  background: var(--preview-text);
  opacity: 0.35;
}
.palette-preview-content span:first-child {
  width: 65%;
  background: var(--preview-accent);
  opacity: 1;
}
.palette-preview-content span:last-child {
  width: 75%;
}
.palette-option-name {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 9px;
  color: var(--theme-text);
  font-size: 12px;
  font-weight: 600;
}
.palette-selected {
  display: block;
  min-height: 15px;
  margin-top: 3px;
  color: var(--muted-text);
  font-size: 10px;
}
</style>
