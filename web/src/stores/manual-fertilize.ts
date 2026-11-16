import type { Land } from '@/stores/farm'
import { defineStore } from 'pinia'
import { ref } from 'vue'
import api from '@/api'

export interface FertilizeTarget { id: number, identity: string }
export interface FertilizePlan { accountId: string, targets: FertilizeTarget[] }
interface Progress { active: boolean, confirmed: number, total: number, reason: string, refreshError: string }
interface Context {
  accountId: () => string
  lands: () => Land[]
  alive: () => boolean
  ready: () => boolean
  refresh: (accountId: string) => Promise<unknown>
  delay?: (ms: number) => Promise<unknown>
}

function identity(land: Land) {
  return JSON.stringify([land.plantId, land.currentSeason ?? null, land.phaseStartTime ?? null])
}
export function fertilizeTargets(lands: Land[]): FertilizeTarget[] {
  const seen = new Set<number>()
  return (Array.isArray(lands) ? lands : []).filter((land) => {
    if (!land || typeof land !== 'object')
      return false
    const id = Number(land.id)
    if (!Number.isSafeInteger(id) || id <= 0 || seen.has(id))
      return false
    seen.add(id)
    return land.status === 'growing' && Number.isFinite(land.matureInSec) && land.matureInSec > 0
      && !land.occupiedByMaster && land.unlocked !== false
      && Number.isSafeInteger(Number(land.plantId)) && Number(land.plantId) > 0
  }).map(land => ({ id: Number(land.id), identity: identity(land) }))
}

export const useManualFertilizeStore = defineStore('manual-fertilize', () => {
  const progress = ref<Record<string, Progress>>({})
  // Never remove a ticket on cancellation: a dispatched write must settle first.
  const tickets = new Map<string, { cancelled: boolean }>()
  function stop(accountId: string, reason = '已停止后续地块；已派发请求不会中断或自动重试') {
    const ticket = tickets.get(accountId)
    if (ticket) {
      ticket.cancelled = true
      progress.value[accountId]!.reason = reason
    }
  }
  function prepare(accountId: string, lands: Land[]): FertilizePlan {
    return { accountId, targets: fertilizeTargets(lands) }
  }
  function matches(plan: FertilizePlan, accountId: string, lands: Land[]) {
    return plan.accountId === accountId && JSON.stringify(plan.targets) === JSON.stringify(fertilizeTargets(lands))
  }
  async function run(plan: FertilizePlan, context: Context) {
    const id = plan.accountId
    if (!id || tickets.has(id) || !context.alive() || !context.ready()
      || !plan.targets.length || !matches(plan, context.accountId(), context.lands())) {
      return false
    }
    const ticket = { cancelled: false }
    tickets.set(id, ticket)
    progress.value[id] = { active: true, confirmed: 0, total: plan.targets.length, reason: '', refreshError: '' }
    const result = progress.value[id]!
    // UI countdown timers may pause in a background tab. Keep the earliest
    // known absolute deadline as well as accepting fresher, earlier deadlines.
    let nextHarvestAt = Infinity
    const dispatchCancelled = Object.assign(new Error('本次请求尚未派发，已停止'), { code: 'ERR_CANCELED' })
    const owned = () => tickets.get(id) === ticket && !ticket.cancelled
      && context.alive() && context.accountId() === id && context.ready()
    const eligible = (target: FertilizeTarget) => fertilizeTargets(context.lands())
      .some(current => current.id === target.id && current.identity === target.identity)
    function canSend(target: FertilizeTarget) {
      if (!owned()) {
        result.reason ||= '页面、账号或连接已变化，已停止后续地块'
        return false
      }
      const now = Date.now()
      const liveLands = context.lands()
      if (!Array.isArray(liveLands)) {
        result.reason = '土地状态读取异常，已停止后续地块'
        return false
      }
      for (const land of liveLands) {
        if (land && !land.occupiedByMaster && land.unlocked !== false && land.status === 'harvestable') {
          nextHarvestAt = now
        }
        else if (land && !land.occupiedByMaster && land.unlocked !== false) {
          if (Number.isSafeInteger(land.matureAtSec) && Number(land.matureAtSec) > 0)
            nextHarvestAt = Math.min(nextHarvestAt, Number(land.matureAtSec) * 1000)
          else if (Number.isFinite(land.matureInSec) && land.matureInSec > 0)
            nextHarvestAt = Math.min(nextHarvestAt, now + land.matureInSec * 1000)
        }
      }
      if (nextHarvestAt - now <= 10000) {
        result.reason = '有作物已成熟或将在10秒内成熟，已停止后续地块以保护收获'
        return false
      }
      if (!eligible(target)) {
        result.reason = '目标作物身份或状态已变化，已停止后续地块'
        return false
      }
      return true
    }
    try {
      for (const [index, target] of plan.targets.entries()) {
        if (!canSend(target))
          break
        if (index > 0) {
          await (context.delay ?? (ms => new Promise(resolve => setTimeout(resolve, ms))))(350)
          if (!canSend(target))
            break
        }
        try {
          const { data } = await api.post('/api/land/fertilize', { landId: target.id }, {
            headers: { 'x-account-id': id },
            errorFeedback: 'consumer',
            // Shared request interceptors read the current account asynchronously.
            // Pin the confirmed account after those interceptors, before dispatch.
            transformRequest: [(body, headers) => {
              if (!canSend(target))
                throw dispatchCancelled
              headers['x-account-id'] = id
              headers['Content-Type'] = 'application/json'
              return JSON.stringify(body)
            }],
          })
          if (data?.ok === true && data?.data?.success === true && data?.data?.count === 1) {
            result.confirmed++
          }
          else {
            result.reason = '请求结果未确认，已停止后续地块；请查看游戏实际结果'
            break
          }
        }
        catch (error) {
          if (error !== dispatchCancelled)
            result.reason = '请求异常或超时，结果未知；已停止后续地块，不自动重试'
          break
        }
        if (!owned()) {
          result.reason ||= '页面、账号或连接已变化，已停止后续地块'
          break
        }
      }
      result.reason ||= '本批次请求完成；实际消耗及成熟变化以游戏结果为准'
      if (owned()) {
        try {
          if (await context.refresh(id) === false)
            result.refreshError = '土地刷新失败；已确认请求数保留，请稍后查看土地'
        }
        catch {
          result.refreshError = '土地刷新失败；已确认请求数保留，请稍后查看土地'
        }
      }
    }
    finally {
      if (tickets.get(id) === ticket) {
        result.active = false
        tickets.delete(id)
      }
    }
    return true
  }
  return { progress, stop, prepare, matches, run }
})
