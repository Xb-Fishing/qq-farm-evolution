<script setup lang="ts">
import { ref } from 'vue'

const bridgeUrl = `${window.location.origin}/mengka-nt`
const copyMessage = ref('')
const addressVisible = ref(false)

async function copyAddress() {
  try {
    await navigator.clipboard.writeText(bridgeUrl)
    copyMessage.value = '已复制服务器地址'
  }
  catch {
    copyMessage.value = '复制失败，请先点击“显示地址”后手动复制'
  }
}
</script>

<template>
  <section class="text-sm space-y-4" aria-label="萌卡 NT 登录接入">
    <p>通过萌卡 NT 中已登录的 Android QQ 获取农场 Code，直接推送到本面板，无需手动抓包。</p>
    <ol class="list-decimal pl-5 space-y-2">
      <li>在萌卡托管中登录目标 QQ，并安装 QQ 农场 Code 桥接插件。</li>
      <li>在插件中添加农场服务器，将地址设为下方的专用桥接地址。</li>
      <li>选择账号密码登录，填写本面板的用户名和密码（不是 QQ 密码），选中目标 QQ 后手动推送一次。</li>
      <li>回到本面板刷新账号列表。首次新增的 QQ 账号会自动启动。</li>
    </ol>
    <div class="space-y-2">
      <label for="mengka-nt-address" class="block font-medium">农场服务器地址</label>
      <input id="mengka-nt-address" :value="addressVisible ? bridgeUrl : ''" placeholder="地址已隐藏，点击复制或显示" readonly class="w-full border border-gray-300 rounded bg-transparent px-3 py-2 text-xs dark:border-gray-600">
      <button type="button" class="rounded bg-blue-600 px-3 py-2 text-white" @click="copyAddress">
        复制服务器地址
      </button>
      <button type="button" class="ml-2 rounded border border-gray-300 px-3 py-2 dark:border-gray-600" :aria-pressed="addressVisible" aria-controls="mengka-nt-address" @click="addressVisible = !addressVisible">
        {{ addressVisible ? '隐藏地址' : '显示地址' }}
      </button>
      <p class="text-xs opacity-75">接入地址属于你的部署信息，仅用于自己的插件配置，请勿放进公开反馈、截图或文档。</p>
      <p v-if="copyMessage" role="status" class="text-xs">
        {{ copyMessage }}
      </p>
    </div>
    <div class="rounded bg-blue-50 p-3 text-xs text-blue-900 dark:bg-blue-900/20 dark:text-blue-200">
      兼容使用账号密码及面板 Token 的 Code 桥接插件。插件需要能访问本面板；仅有访问 Code / Cookie 登录的插件版本不适用。
      在线账号收到新 Code 时保持连接，同一 Code 不重复处理。已有离线账号只保存 Code，请手动启动；手动停止的账号不会被推送拉起。
    </div>
    <p class="text-xs opacity-70">
      本面板不托管 QQ 密码，也不代替萌卡登录 QQ。只在你配置插件并推送后接收 Code；微信扫码与手动填码仍可正常使用。
    </p>
  </section>
</template>
