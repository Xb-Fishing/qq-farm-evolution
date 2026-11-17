<script setup lang="ts">
import { ref, watch } from 'vue'
import BaseButton from '@/components/ui/BaseButton.vue'

const props = defineProps<{ automation: any, state: any, saving: boolean }>()
const emit = defineEmits<{ save: [policy: Record<string, any>] }>()
const draft = ref<Record<string, any>>({})
watch(() => props.automation, (value) => {
  draft.value = value ? { ...value.policy } : {}
}, { immediate: true })
const freeActions = [{ key: 'harvest', name: '自动收获' }, { key: 'produce', name: '自动生产' }, { key: 'clean', name: '自动清理' }, { key: 'tasks', name: '领取普通任务奖励' }]
</script>

<template>
  <details class="my-4 border border-gray-200 rounded-lg p-3 dark:border-gray-700">
    <summary class="cursor-pointer font-medium">
      牧场自动化 · {{ automation?.policy?.enabled ? '已启用' : '未启用' }}
    </summary>
    <form v-if="automation" class="mt-3 text-sm space-y-3" @submit.prevent="emit('save', { ...draft })">
      <p>每轮最多执行一项，优先处理农场收获。消耗功能默认关闭；结果未确认时暂停，直到手动核对。</p>
      <label class="flex items-center gap-2"><input v-model="draft.enabled" type="checkbox">启用牧场自动化</label>
      <div class="flex flex-wrap gap-4">
        <label v-for="action in freeActions" :key="action.key" class="flex items-center gap-2"><input v-model="draft[action.key]" type="checkbox">{{ action.name }}</label>
      </div>
      <label class="block">巡检间隔（分钟） <input v-model.number="draft.intervalMinutes" type="number" min="2" max="60" required></label>
      <fieldset class="border rounded p-3 space-y-2">
        <legend><label><input v-model="draft.grassEnabled" type="checkbox">使用库存自动补草</label></legend>
        <label class="block">每日最多使用 <input v-model.number="draft.grassDailyLimit" type="number" min="0" max="1000000000" required></label>
        <label class="block">至少保留牧草 <input v-model.number="draft.grassReserve" type="number" min="0" max="1000000000" required></label>
      </fieldset>
      <fieldset class="border rounded p-3 space-y-2">
        <legend><label><input v-model="draft.placeEnabled" type="checkbox">使用库存自动放养</label></legend>
        <label class="block">幼崽 <select v-model="draft.cubId"><option value="">请选择库存幼崽</option><option v-if="draft.cubId && !state?.cubs?.some((x: any) => x.id === draft.cubId)" :value="draft.cubId">已保存的幼崽（当前无库存）</option><option v-for="cub in state?.cubs || []" :key="`${cub.id}:${cub.uid}`" :value="cub.id">{{ cub.name }}</option></select></label>
        <label class="block">栏舍 <select v-model="draft.ranchId"><option value="">请选择栏舍</option><option v-for="facility in (state?.facilities || []).filter((x: any) => x.ranch)" :key="facility.id" :value="facility.id">{{ facility.name }}</option></select></label>
        <label class="block">每日最多放养 <input v-model.number="draft.cubDailyLimit" type="number" min="0" max="1000000000" required></label>
        <label class="block">至少保留幼崽 <input v-model.number="draft.cubReserve" type="number" min="0" max="1000000000" required></label>
      </fieldset>
      <fieldset class="border rounded p-3 space-y-2">
        <legend><label><input v-model="draft.buyEnabled" type="checkbox">自动购买指定商品</label></legend>
        <p>先打开下方商店，查看商品及费用，再选择购买目标。</p>
        <label class="block">商店 <select v-model="draft.shopId"><option value="5">幼崽商店</option><option value="6">饲料商店</option></select></label>
        <label class="block">商品 <select v-model="draft.goodsId"><option value="">请选择商品</option><option v-if="draft.goodsId && !state?.shop?.goods?.some((x: any) => x.id === draft.goodsId)" :value="draft.goodsId">已保存的商品</option><option v-for="good in state?.shop?.shopId === draft.shopId ? state.shop.goods : []" :key="good.id" :value="good.id">{{ good.reward.name }} · {{ good.price?.name }} {{ good.price?.count }}</option></select></label>
        <label class="block">单次购买数量 <input v-model.number="draft.purchaseCount" type="number" min="1" max="99" required></label>
        <label class="block">允许消耗的货币 <select v-model="draft.currencyId"><option v-for="coin in state?.currencies || []" :key="coin.id" :value="coin.id">{{ coin.name }}</option></select></label>
        <label class="block">每日最多花费 <input v-model.number="draft.currencyDailyLimit" type="number" min="0" max="1000000000" required></label>
        <label class="block">至少保留货币 <input v-model.number="draft.currencyReserve" type="number" min="0" max="1000000000" required></label>
      </fieldset>
      <p>每日额度按北京时间零点重置。未知结果仍暂停，不会因换日重试。</p>
      <BaseButton type="submit" :loading="saving">
        保存牧场自动化
      </BaseButton>
    </form>
    <p v-else class="mt-3 text-sm">
      正在读取该账号的自动化设置。
    </p>
  </details>
</template>

<style scoped>
input[type='number'],
select {
  min-height: 40px;
  max-width: 100%;
  padding: 4px 8px;
  border: 1px solid #94a3b8;
  border-radius: 6px;
  background: transparent;
}
input[type='number'] {
  width: 110px;
}
</style>
