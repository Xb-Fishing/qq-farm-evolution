<script setup lang="ts">
import { storeToRefs } from 'pinia'
import { onBeforeUnmount, onMounted, watch } from 'vue'
import FestivalSignInPanel from '@/components/activity/FestivalSignInPanel.vue'
import FriendRecallActivityPanel from '@/components/activity/FriendRecallActivityPanel.vue'
import GameUpdatePanel from '@/components/activity/GameUpdatePanel.vue'
import MugeActivityPanel from '@/components/activity/MugeActivityPanel.vue'
import RanchPanel from '@/components/activity/RanchPanel.vue'
import BaseButton from '@/components/ui/BaseButton.vue'
import { useAccountStore } from '@/stores/account'
import { useActivityStore } from '@/stores/activity'
import { useFriendRecallStore } from '@/stores/friend-recall'
import { useMugeStore } from '@/stores/muge'

const accountStore = useAccountStore()
const activityStore = useActivityStore()
const friendRecallStore = useFriendRecallStore()
const mugeStore = useMugeStore()
const { currentAccountId, currentAccount } = storeToRefs(accountStore)
async function refreshAll() {
  if (currentAccountId.value)
    await Promise.all([friendRecallStore.refresh(String(currentAccountId.value)), mugeStore.refresh(String(currentAccountId.value))])
}
onBeforeUnmount(() => {
  friendRecallStore.cancel()
  mugeStore.cancel()
  activityStore.cancelActivityReads()
})
watch(currentAccountId, () => {
  activityStore.clearActivityData()
  friendRecallStore.bind(String(currentAccountId.value || ''))
  mugeStore.bind(String(currentAccountId.value || ''))
  refreshAll()
}, { flush: 'sync' })
onMounted(() => {
  friendRecallStore.bind(String(currentAccountId.value || ''))
  mugeStore.bind(String(currentAccountId.value || ''))
  refreshAll()
})
</script>

<template>
  <section class="activity-page space-y-4">
    <header class="relative overflow-hidden rounded-xl from-slate-800 via-sky-800 to-indigo-900 bg-gradient-to-r shadow-sm">
      <div class="absolute h-64 w-64 rounded-full bg-sky-300/15 blur-3xl -right-12 -top-20" />
      <div class="relative flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
        <div class="min-w-0 flex items-center gap-3">
          <span class="grid h-12 w-12 shrink-0 place-items-center rounded-xl bg-white/10 text-3xl text-sky-100"><span class="i-carbon-events" /></span>
          <div>
            <h1 class="text-xl text-white font-bold">
              活动中心
            </h1>
            <div class="mt-1 text-xs text-sky-100/75">
              当前账号 {{ currentAccount?.name || '未选择' }} · 查看进行中的活动与奖励
            </div>
          </div>
        </div>
        <BaseButton variant="primary" :loading="friendRecallStore.loading || mugeStore.loading" :disabled="!currentAccountId" @click="refreshAll">
          刷新
        </BaseButton>
      </div>
    </header>
    <div v-if="!currentAccountId" class="rounded-lg bg-white p-10 text-center text-sm text-gray-500 shadow dark:bg-gray-800">
      请先选择账号，再查看活动数据。
    </div>
    <template v-else>
      <nav class="activity-nav" aria-label="活动快速导航">
        <a href="#ranch">牧场经营</a>
        <a v-if="mugeStore.activity?.available" href="#muge">牧歌初启</a>
        <a v-if="friendRecallStore.activity?.available" href="#friend-recall">故友重逢</a>
        <a href="#festival-sign-in">节日签到与节令日历</a>
      </nav>
      <RanchPanel :account-id="String(currentAccountId)" />
      <MugeActivityPanel
        :key="`muge-${currentAccountId}`" :activity="mugeStore.activity" :loading="mugeStore.loading" :error="mugeStore.error"
        :pending="mugeStore.pending" :ready="mugeStore.ready" :refresh-required="mugeStore.refreshRequired" :feedback="mugeStore.feedback" :rewards="mugeStore.rewards"
        @refresh="mugeStore.refresh(String(currentAccountId))" @operate="mugeStore.operate(String(currentAccountId), $event)"
      />
      <FriendRecallActivityPanel :activity="friendRecallStore.activity" :loading="friendRecallStore.loading" :error="friendRecallStore.error" @refresh="friendRecallStore.refresh(String(currentAccountId))" />
      <GameUpdatePanel :key="`update-${currentAccountId}`" :account-id="String(currentAccountId || '')" />
      <FestivalSignInPanel :key="`festival-${currentAccountId}`" :account-id="String(currentAccountId)" />
      <p v-if="!friendRecallStore.activity?.available && !mugeStore.activity?.available && !friendRecallStore.loading && !mugeStore.loading && !friendRecallStore.error && !mugeStore.error" class="rounded-lg bg-white p-8 text-center text-sm text-gray-500 dark:bg-gray-800">
        当前暂无可显示的专属活动；节令日历与游戏动态可独立查询。
      </p>
    </template>
  </section>
</template>

<style scoped>
.activity-page {
  min-width: 0;
}
.activity-nav {
  display: flex;
  flex-wrap: wrap;
  gap: 9px;
}
.activity-nav a {
  display: inline-flex;
  align-items: center;
  min-height: 44px;
  padding: 8px 12px;
  border: 1px solid var(--surface-border, #dbe3ec);
  border-radius: 9px;
  color: inherit;
  background: var(--surface-1, #fff);
  font-size: 13px;
}
.activity-page :deep(button) {
  min-height: 44px;
}
.activity-page .text-xs {
  overflow-wrap: anywhere;
}
</style>
