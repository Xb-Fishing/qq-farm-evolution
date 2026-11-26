<script setup lang="ts">
defineProps<{
  loginLogsTotal: number
}>()
</script>

<template>
  <div class="mb-4 rounded-3xl bg-white p-6 shadow-sm dark:bg-gray-800">
    <div class="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
      <div>
        <h1 class="flex items-center gap-2 text-2xl text-gray-900 font-bold dark:text-gray-100">
          <div class="i-fas-user-shield text-lg" />
          后台管理
        </h1>
        <p class="mt-2 text-sm text-gray-500 dark:text-gray-400">
          管理系统配置与登录日志。
        </p>
      </div>

      <div class="text-sm">
        <div class="rounded-2xl bg-rose-50 px-4 py-3 text-rose-700 dark:bg-rose-900/20 dark:text-rose-300">
          <div class="text-xs opacity-80">
            登录日志
          </div>
          <div class="mt-1 font-medium">
            {{ loginLogsTotal }} 条
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
