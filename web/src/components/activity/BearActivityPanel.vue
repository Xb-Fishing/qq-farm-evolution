<script setup lang="ts">
import type { BearActivityData } from '@/stores/activity'
import BaseButton from '@/components/ui/BaseButton.vue'

defineProps<{ activity: BearActivityData | null, loading: boolean }>()
const emit = defineEmits<{
  (e: 'refresh'): void
  (e: 'operate', action: string, input?: Record<string, unknown>): void
}>()

const operating = defineModel<string>('operating', { default: '' })

function time(value: number) {
  return value ? new Date(value * 1000).toLocaleString() : '未下发'
}

// 手动操作区（写操作仅由按钮触发；命令字来自官方小程序 1.14.0.1 编码器）
interface ManualAction {
  key: string
  label: string
  hint: string
  primary?: boolean
}
const MANUAL_ACTIONS: ManualAction[] = [
  { key: 'initialize', label: '领养比熊（过开场）', hint: '首次进入活动需要完成领养流程' },
  { key: 'feed', label: '投喂元气糕', hint: '消耗元气糕培育幼崽（未成年时）', primary: true },
  { key: 'draw', label: '寻宝', hint: '成年后消耗元气糕寻宝，产出幸运星/宝藏/挑战书', primary: true },
  { key: 'claimDog', label: '领取永久比熊', hint: '成年后领取，永久保留宠物' },
  { key: 'seeds', label: '领取种子礼包', hint: '每日免费稀有种子礼包，未领可累计', primary: true },
  { key: 'compensation', label: '领取夺宝补偿', hint: '连续夺宝失败 3 次后触发的安慰礼（如有可领取）' },
  { key: 'story', label: '领取手记奖励', hint: '解锁的爪印手记奖励（需已解锁未领取）' },
]

// 玩法卡手动入口提示只映射顶部已批准按钮；未知动作键不展示，也不新增卡片触发入口。
const MANUAL_ACTION_LABELS: Record<string, string> = Object.fromEntries(
  MANUAL_ACTIONS.map(action => [action.key, action.label]),
)

function manualLabelsFor(guide: BearActivityData['gameplayGuides'][number]) {
  // 只接受标签表自身已有的键：直接索引会命中 Object.prototype 继承属性
  // （如 toString / constructor），join 后会把原生函数文本当“已开放”提示展示。
  return (guide.manualActions || [])
    .filter(key => Object.prototype.hasOwnProperty.call(MANUAL_ACTION_LABELS, key))
    .map(key => MANUAL_ACTION_LABELS[key])
}

// 状态行按玩法区分三类，不再统一宣称「待官方字段证据」：
// - 已开放手动操作的玩法（manualActions 非空）：实时状态（成年阶段/次数/领取态/补偿
//   数量）已由操作服务解析用于前置校验，当前快照未展示——缺的是展示，不是字段确认；
// - 夺宝：次数与目标状态确实待官方字段证据，但挑战书库存可从背包读取（道具库存区）；
// - 其余未开放玩法：实时状态当前快照未提供，待官方字段证据。
// 未按 0 处理、不新增状态请求；商城卡沿用面板无兑换入口的专属说明。
function stateNoteFor(guide: BearActivityData['gameplayGuides'][number]) {
  if (guide.key === 'shop')
    return '当前面板仅展示商品，暂无兑换入口；状态码语义待官方样本'
  if (guide.key === 'raid')
    return '实时状态当前快照未提供，待官方字段证据；挑战书库存见上方「活动道具与库存」'
  if (manualLabelsFor(guide).length)
    return '实时状态当前快照未展示，点击手动操作时会重新校验，未知不按 0 处理'
  return '实时状态当前快照未提供，待官方字段证据，未知不按 0 处理'
}

function runAction(action: ManualAction) {
  if (operating.value)
    return
  if (action.key === 'story') {
    const order = window.prompt('请输入手记编号（order）：', '1')
    if (!order)
      return
    emit('operate', 'story', { order: Number(order) })
    return
  }
  emit('operate', action.key)
}
</script>

<template>
  <section class="rounded-xl bg-white p-4 shadow-sm space-y-4 dark:bg-gray-800">
    <header class="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h2 class="text-lg font-bold">
          S3 萌宠 · 萌宠成长日记
        </h2>
        <p class="mt-1 text-sm text-gray-500">
          培育比熊 → 成年寻宝 → 宝藏护送 / 好友夺宝 → 幸运星兑换
        </p>
      </div>
      <BaseButton variant="secondary" :loading="loading" @click="$emit('refresh')">
        刷新只读状态
      </BaseButton>
    </header>
    <p class="text-xs text-gray-500">
      1 分钟内重复刷新复用本地结果；操作协议来自官方小程序 1.14.0.1 编码器（手动触发模式）。
    </p>

    <section v-if="activity" class="border border-emerald-200 rounded-lg bg-emerald-50/70 p-3 dark:border-emerald-800/50 dark:bg-emerald-900/20">
      <h3 class="text-sm font-semibold text-emerald-900 dark:text-emerald-200">
        玩法手动操作
      </h3>
      <p class="mt-1 text-xs text-emerald-700/90 dark:text-emerald-300/90">
        由你点击触发，每次操作前 Bot 会重新校验余额/次数/状态；不会自动执行、不消耗钻石。夺宝等好友交互暂未开放。
      </p>
      <div class="mt-3 flex flex-wrap gap-2">
        <BaseButton
          v-for="action in MANUAL_ACTIONS"
          :key="action.key"
          :variant="action.primary ? 'primary' : 'secondary'"
          size="sm"
          :loading="operating === action.key"
          :disabled="!!operating"
          :title="action.hint"
          @click="runAction(action)"
        >
          {{ action.label }}
        </BaseButton>
      </div>
    </section>

    <p v-if="!activity" class="py-8 text-center text-sm text-gray-500">
      {{ loading ? '正在读取 S3 萌宠…' : '当前没有可用活动快照，请查看读取提示。' }}
    </p>
    <template v-else>
      <div class="rounded-lg bg-sky-50 p-3 text-sm dark:bg-sky-950/30">
        <p class="font-medium">
          {{ activity.statusLabel }}
        </p>
        <p class="mt-1 text-xs">
          {{ time(activity.startTime) }} — {{ time(activity.endTime) }}
        </p>
      </div>

      <aside v-if="activity.conflicts.length" class="border border-amber-200 rounded-lg bg-amber-50 p-3 text-sm dark:border-amber-800 dark:bg-amber-950/30">
        <h3 class="font-semibold">
          官方说明存在差异
        </h3>
        <p class="mt-1 text-xs">
          下方流程采用玩法节点说明；数值差异尚未定论，以官方客户端实际状态为准。
        </p>
        <ul class="mt-2 list-disc pl-5 space-y-1">
          <li v-for="item in activity.conflicts" :key="item.title">
            {{ item.title }}：{{ item.text }}
          </li>
        </ul>
      </aside>

      <section>
        <h3 class="mb-3 font-semibold">
          活动道具与库存
        </h3>
        <p v-if="!activity.inventoryAvailable" class="mb-2 text-xs text-amber-600">
          本次背包读取不可用，数量保持未知。
        </p>
        <div class="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <article v-for="item in activity.resources" :key="item.key" class="border border-gray-200 rounded-lg p-3 dark:border-gray-700">
            <div class="flex items-center gap-2">
              <img v-if="item.image" :src="item.image" :alt="item.name" class="h-9 w-9 object-contain">
              <span v-else class="i-carbon-gift text-xl text-amber-500" />
              <h4 class="text-sm font-semibold">
                {{ item.name }}
              </h4>
            </div>
            <p class="mt-2 text-lg font-bold">
              {{ item.count == null ? '数量待确认' : Number(item.count).toLocaleString() }}
            </p>
            <p class="mt-1 text-xs text-gray-500">
              {{ item.purpose }}
            </p>
            <p class="mt-1 text-xs text-gray-400">
              {{ item.itemId ? `道具 ID ${item.itemId}` : '道具 ID / 专属图片待官方证据' }}
            </p>
          </article>
        </div>
      </section>

      <section>
        <h3 class="mb-3 font-semibold">
          玩法流程与当前状态
        </h3>
        <p v-if="!activity.gameplayGuides.length" class="text-sm text-gray-500">
          当前快照缺少玩法说明，暂不推断参与流程。
        </p>
        <div class="grid items-start gap-3 lg:grid-cols-2">
          <article v-for="guide in activity.gameplayGuides" :key="guide.key" class="border border-gray-200 rounded-lg p-4 dark:border-gray-700">
            <h4 class="font-semibold">
              {{ guide.title }}
            </h4>
            <ul class="mt-2 list-disc pl-5 text-sm leading-6 space-y-1.5">
              <li v-for="(step, index) in guide.steps" :key="index">
                {{ step }}
              </li>
            </ul>
            <p class="mt-3 rounded bg-gray-50 p-2 text-xs text-gray-500 dark:bg-gray-900/40">
              {{ guide.missingState }}：{{ stateNoteFor(guide) }}
            </p>
            <p v-if="manualLabelsFor(guide).length" class="mt-3 rounded bg-emerald-50 p-2 text-xs text-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-300">
              手动操作已开放：{{ manualLabelsFor(guide).join('、') }}（上方「玩法手动操作」区）
            </p>
            <BaseButton v-else class="mt-3" variant="secondary" size="sm" disabled>
              {{ guide.actionLabel }} · {{ guide.key === 'raid' ? '好友交互暂未开放' : guide.key === 'shop' ? '面板暂无兑换入口' : '操作协议待确认' }}
            </BaseButton>
          </article>
        </div>
      </section>

      <section>
        <h3 class="mb-2 font-semibold">
          幸运星游记商城
        </h3>
        <p class="mb-3 text-xs text-gray-500">
          价格和拥有标记来自本次回包；状态码的次数与可兑换含义尚未确认，当前面板未提供兑换入口。
        </p>
        <div v-if="activity.exchangeShop.length" class="overflow-x-auto">
          <table class="w-full whitespace-nowrap text-left text-sm">
            <thead class="bg-gray-50 text-gray-500 dark:bg-gray-900/40">
              <tr>
                <th class="p-2">
                  商品
                </th><th class="p-2">
                  价格
                </th><th class="p-2">
                  背包数量
                </th><th class="p-2">
                  商城拥有标记 / 状态
                </th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="item in activity.exchangeShop" :key="item.id" class="border-b border-gray-100 dark:border-gray-700">
                <td class="p-2">
                  <div class="flex items-center gap-2">
                    <img v-if="item.image" :src="item.image" :alt="item.name" class="h-8 w-8 object-contain">
                    <span v-else class="i-carbon-gift text-gray-400" />
                    <span>{{ item.name }} ×{{ item.itemCount }}<small class="block text-gray-400">道具 ID {{ item.itemId }}</small></span>
                  </div>
                </td>
                <td class="p-2">
                  {{ Number(item.price || 0).toLocaleString() }} {{ item.currencyName }}
                </td>
                <td class="p-2">
                  {{ item.inventoryCount == null ? '未知' : Number(item.inventoryCount).toLocaleString() }}
                </td>
                <td class="p-2">
                  {{ item.owned ? '已拥有' : '未标记拥有' }}<small class="block text-gray-400">{{ item.statusLabel }}</small>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p v-else class="text-sm text-gray-500">
          本次未下发商城商品。
        </p>
      </section>

      <section>
        <h3 class="mb-2 font-semibold">
          游记奖励记录
        </h3>
        <p class="mb-2 text-xs text-gray-500">
          仅展示回包中的奖励与解锁标记；尚不能将这些记录认定为爪印手记，不接入旧赛季领取命令。
        </p>
        <div v-if="activity.recordStateAvailable" class="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
          <article v-for="record in activity.records" :key="record.id" class="rounded-lg bg-gray-50 p-3 text-sm dark:bg-gray-900/40">
            <p class="font-medium">
              {{ record.title || `奖励记录 ${record.id}` }}
            </p>
            <p class="mt-1 text-xs text-gray-500">
              {{ record.unlocked === null ? '解锁状态未知' : record.unlocked ? '已解锁' : '未解锁' }} · {{ record.claimed === null ? '领取状态未知' : record.claimed ? '已领取' : '未领取' }}
            </p>
            <p v-for="(reward, index) in record.rewards" :key="index" class="mt-1 flex items-center gap-1 text-xs">
              <img v-if="reward.image" :src="reward.image" :alt="reward.itemName" class="h-6 w-6 object-contain">
              {{ reward.itemName }} ×{{ reward.itemCount }}
            </p>
          </article>
          <p v-if="!activity.records.length" class="text-sm text-gray-500">
            本次记录列表为空。
          </p>
        </div>
        <p v-else class="text-sm text-gray-500">
          奖励记录状态尚未包含在当前快照中。
        </p>
      </section>

      <aside v-if="activity.notices.length" class="rounded-lg bg-amber-50 p-4 text-sm dark:bg-amber-950/30">
        <h3 class="font-semibold">
          每日刷新与赛季结束提示
        </h3>
        <ul class="mt-2 list-disc pl-5 space-y-1">
          <li v-for="(notice, index) in activity.notices" :key="index">
            {{ notice }}
          </li>
        </ul>
      </aside>

      <details class="border border-gray-200 rounded-lg p-3 text-xs dark:border-gray-700">
        <summary class="cursor-pointer font-medium">
          适配边界与活动节点
        </summary>
        <ul class="mt-3 list-disc pl-5 space-y-1">
          <li v-for="item in activity.missingEvidence" :key="item">
            {{ item }}
          </li>
        </ul>
        <p class="mt-3">
          根节点 {{ activity.activityId }}；客户端界面标识 {{ activity.clientUiUid || '未下发' }}；活动读取使用空 UID，不将界面标识作为请求参数。
        </p>
        <div v-for="node in activity.subActivities" :key="node.id" class="mt-2 border-t border-gray-100 pt-2 dark:border-gray-700">
          {{ node.title }} · {{ node.id }} / parent {{ node.parentId }} / type {{ node.type }} · {{ node.statusLabel }}
          <p>{{ time(node.startTime) }} — {{ time(node.endTime) }} · 界面标识 {{ node.clientUiUid || '未下发' }}</p>
          <p>字段 {{ node.protobufField }} · {{ node.protocolObserved ? '已观测' : '未观测' }} · {{ node.protobufField === 115 ? '不透明结构，未解释业务字段' : '已有 proto，只读展示' }}</p>
        </div>
      </details>
    </template>
  </section>
</template>
