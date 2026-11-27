<script setup lang="ts">
import { storeToRefs } from 'pinia'
import { computed, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import MysteryMerchantBanner from '@/components/shop/MysteryMerchantBanner.vue'
import Sidebar from '@/components/Sidebar.vue'
import TopAccountMenu from '@/components/TopAccountMenu.vue'
import { menuRoutes } from '@/router/menu'
import { useAppStore } from '@/stores/app'

const appStore = useAppStore()
const currentRoute = useRoute()
const pageTitle = computed(() => {
  const item = menuRoutes.find(item => `/${item.path}` === currentRoute.path)
  return item?.label === '概览' ? '农场概览' : item?.label || '农场工作台'
})
const { sidebarOpen } = storeToRefs(appStore)

onMounted(() => {
  appStore.fetchLoginPageConfig()
})
</script>

<template>
  <div class="app-shell w-screen flex overflow-hidden" style="height: 100dvh;">
    <!-- Mobile Sidebar Overlay -->
    <div
      v-if="sidebarOpen"
      class="fixed inset-0 z-40 bg-gray-950/55 backdrop-blur-md transition-opacity lg:hidden"
      @click="appStore.closeSidebar"
    />

    <Sidebar />

    <main class="relative h-full min-h-0 min-w-0 flex flex-1 flex-col overflow-hidden">
      <header class="shell-header relative z-30 flex shrink-0 items-center justify-between">
        <div class="min-w-0 flex items-center gap-3">
          <button
            class="h-9 w-9 flex items-center justify-center rounded-lg text-gray-500 transition lg:hidden hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-700"
            aria-label="打开导航菜单"
            @click="appStore.toggleSidebar"
          >
            <div class="i-carbon-menu text-xl" />
          </button>
          <div class="truncate text-base text-gray-900 font-semibold md:text-lg dark:text-gray-100">
            {{ pageTitle }}
          </div>
        </div>

        <TopAccountMenu />
      </header>

      <!-- Main Content Area -->
      <div class="min-h-0 flex flex-1 flex-col overflow-hidden">
        <MysteryMerchantBanner />
        <div class="shell-content custom-scrollbar min-h-0 flex flex-1 flex-col overflow-y-auto">
          <RouterView v-slot="{ Component, route }">
            <Transition name="slide-fade" mode="out-in">
              <div :key="route.path" class="shell-page min-w-0 flex-1">
                <component :is="Component" />
              </div>
            </Transition>
          </RouterView>
        </div>
      </div>
    </main>
  </div>
</template>

<style scoped>
.shell-header {
  min-height: 72px;
  padding: 12px 28px;
  border-bottom: 1px solid var(--surface-border);
  background: var(--surface-1);
}
.shell-content {
  padding: 24px 28px 32px;
}
.shell-page {
  width: 100%;
  max-width: 1480px;
  margin: 0 auto;
}
@media (max-width: 767px) {
  .shell-header {
    min-height: 64px;
    padding: 10px 16px;
  }
  .shell-content {
    padding: 16px 14px calc(20px + env(safe-area-inset-bottom));
  }
}
.app-shell {
  background: var(--app-bg);
}

/* 弹窗动画 */
.modal-fade-enter-active {
  animation: modal-in 0.4s ease-out;
}

.modal-fade-leave-active {
  animation: modal-out 0.3s ease-in;
}

@keyframes modal-in {
  0% {
    opacity: 0;
    transform: scale(0.9);
  }
  100% {
    opacity: 1;
    transform: scale(1);
  }
}

@keyframes modal-out {
  0% {
    opacity: 1;
    transform: scale(1);
  }
  100% {
    opacity: 0;
    transform: scale(0.9);
  }
}

/* 弹窗样式 */
.warning-modal {
  animation: float 3s ease-in-out infinite;
}

@keyframes float {
  0%,
  100% {
    transform: translateY(0);
  }
  50% {
    transform: translateY(-5px);
  }
}

/* 水波纹背景 */
.ripple-bg {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  width: 100%;
  height: 100%;
  overflow: hidden;
  pointer-events: none;
}

.ripple {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  border-radius: 50%;
  background: radial-gradient(circle, rgba(239, 68, 68, 0.1) 0%, transparent 70%);
  animation: ripple-effect 4s ease-out infinite;
}

.ripple-1 {
  width: 200px;
  height: 200px;
  animation-delay: 0s;
}

.ripple-2 {
  width: 300px;
  height: 300px;
  animation-delay: 1.3s;
}

.ripple-3 {
  width: 400px;
  height: 400px;
  animation-delay: 2.6s;
}

/* Slide Fade Transition */
.slide-fade-enter-active,
.slide-fade-leave-active {
  transition: all 0.2s ease-out;
}

.slide-fade-enter-from {
  opacity: 0;
  transform: translateY(10px);
}

.slide-fade-leave-to {
  opacity: 0;
  transform: translateY(-10px);
}

.custom-scrollbar::-webkit-scrollbar {
  width: 6px;
  height: 6px;
}
.custom-scrollbar::-webkit-scrollbar-track {
  background: transparent;
}
.custom-scrollbar::-webkit-scrollbar-thumb {
  background-color: rgba(156, 163, 175, 0.3);
  border-radius: 3px;
}
.custom-scrollbar:hover::-webkit-scrollbar-thumb {
  background-color: rgba(156, 163, 175, 0.5);
}

.custom-scrollbar {
  -webkit-overflow-scrolling: touch;
  overscroll-behavior: contain;
}
</style>
