import { defineStore } from 'pinia'
import { ref } from 'vue'
import api from '@/api'
import { useAccountStore } from '@/stores/account'

export interface BlacklistItem {
  gid: number
  name: string
  avatarUrl: string
}

// 重点名单条目：名称/头像由后端返回空值，前端与已加载好友列表拼接展示；
// paused/pausedAt/trailingFailures 来自暂停状态镜像（Worker 停止时读最后快照）
export interface WatchlistItem {
  gid: number
  name: string
  avatarUrl: string
  paused: boolean
  pausedAt: number
  trailingFailures: number
}

// 用户意图版本（opSeq）与 Worker 已消费版本（consumedOpSeq）：
// consumedOpSeq >= opSeq 表示恢复/移除已被 Worker 消费
export interface WatchlistMeta {
  opSeq: number
  consumedOpSeq: number
}

// 最近一次名单写操作的通知状态：saved=已成功保存；
// notifyAttempted=已尝试向 Worker 广播（只表示"尝试过"，不代表已送达/已消费）
export interface WatchlistNotifyState {
  saved: boolean
  notifyAttempted: boolean
}

export interface KnownFriendSettings {
  knownFriendGids: number[]
  knownFriendGidSyncCooldownSec: number
  friendsListCacheTtlSec: number
}

// 已证实在线信号源（与 core/src/services/friend-activity.js 的 ONLINE_SOURCES 对齐），
// 只有这些源的 friend_activity_evidence 日志能实时点亮好友在线标记。
// lands_push 已剔除：LandsNotify 推送只有地块变化与 host_gid，可由他人放虫/
// 放草/偷菜触发，农场变化 ≠ 主人上线（2026-09-26 协议审查）。
// 2026-09-28 增补：social_item_placed 升辅助在线源——放置是写操作，
// owner_gid+created_at 精确到操作时刻（与 lands_push 的"主人推断"不同）。
const ONLINE_EVIDENCE_SOURCES = new Set(['at_home', 'presence_online', 'social_item_placed'])
// 实时证据有效期：超过即撤销在线标记，回落到 30 秒快照兜底。
const ONLINE_EVIDENCE_TTL_MS = 10_000

export const useFriendStore = defineStore('friend', () => {
  const friends = ref<any[]>([])
  const loading = ref(false)
  // gid -> { at, source }：实时在线证据，log:new 桥写入，10 秒过期由页面 ticker 撤销
  const onlineEvidence = ref<Record<string, { at: number, source: string }>>({})
  let friendsReqSeq = 0
  const dogInfoLoading = ref(false)
  const friendLands = ref<Record<string, any[]>>({})
  const friendLandsLoading = ref<Record<string, boolean>>({})
  const blacklist = ref<BlacklistItem[]>([])
  const watchlist = ref<WatchlistItem[]>([])
  const watchlistMeta = ref<WatchlistMeta>({ opSeq: 0, consumedOpSeq: 0 })
  const watchlistNotify = ref<WatchlistNotifyState>({ saved: false, notifyAttempted: false })
  // 重点名单读取代次：clearFriendData 前移后，在途旧 GET 响应（含 resume/
  // remove 之前发起的快照）不再写回，避免旧暂停状态污染新展示
  let watchlistReqSeq = 0
  // 名单生命周期代次：只在 clearFriendData（账号切换/手动清空）时单调前移，
  // 永不复位、写发起不复用。写入口在发起时捕获当前代次，响应到达时代次已
  // 前移（含 A→B→A 切回）即整体丢弃——旧写响应不得写回名单、版本、通知
  // 状态或触发过期错误提示。同一代次内的多个在途写只按服务端意图版本
  // （opSeq）裁决：较早发起但携带较新服务端版本的响应仍正常应用。
  let watchlistAccountEpoch = 0
  const autoBadList = ref<BlacklistItem[]>([])
  const interactRecords = ref<any[]>([])
  const interactLoading = ref(false)
  const interactError = ref('')

  const knownFriendGids = ref<number[]>([])
  const knownFriendGidSyncCooldownSec = ref(600)
  const friendsListCacheTtlSec = ref(60)
  const knownFriendSettingsLoading = ref(false)
  const knownFriendSettingsSaving = ref(false)

  function clearFriendData() {
    // 代次前移：清空后没有新 fetch 时（A→B→A / 手动清空），旧响应 seq 不再匹配，不会写回旧列表
    friendsReqSeq++
    loading.value = false
    friends.value = []
    onlineEvidence.value = {}
    friendLands.value = {}
    friendLandsLoading.value = {}
    blacklist.value = []
    watchlist.value = []
    watchlistMeta.value = { opSeq: 0, consumedOpSeq: 0 }
    watchlistNotify.value = { saved: false, notifyAttempted: false }
    watchlistReqSeq++
    watchlistAccountEpoch++
    autoBadList.value = []
    interactRecords.value = []
    interactError.value = ''
    knownFriendGids.value = []
    knownFriendGidSyncCooldownSec.value = 600
    friendsListCacheTtlSec.value = 60
  }

  function isCurrentAccount(accountId: string) {
    const accountStore = useAccountStore()
    const currentId = String((accountStore.currentAccountId as { value?: string })?.value ?? accountStore.currentAccountId ?? '')
    return currentId === String(accountId)
  }

  function buildPlantSummaryFromDetail(lands: any[], summary: any) {
    let stealNum = 0
    let dryNum = 0
    let weedNum = 0
    let insectNum = 0

    const detailLands = Array.isArray(lands) ? lands : []
    if (detailLands.length > 0) {
      for (const land of detailLands) {
        if (!land || !land.unlocked)
          continue
        if (land.status === 'stealable')
          stealNum++
        if (land.needWater)
          dryNum++
        if (land.needWeed)
          weedNum++
        if (land.needBug)
          insectNum++
      }
    }
    else {
      stealNum = Array.isArray(summary?.stealable) ? summary.stealable.length : 0
      dryNum = Array.isArray(summary?.needWater) ? summary.needWater.length : 0
      weedNum = Array.isArray(summary?.needWeed) ? summary.needWeed.length : 0
      insectNum = Array.isArray(summary?.needBug) ? summary.needBug.length : 0
    }

    return {
      stealNum: Number(stealNum) || 0,
      dryNum: Number(dryNum) || 0,
      weedNum: Number(weedNum) || 0,
      insectNum: Number(insectNum) || 0,
      ripeAt: Number(summary?.ripeAt) || 0,
      matureInSec: Number(summary?.matureInSec) || 0,
      timeSource: summary?.timeSource || (summary?.ripeAt ? 'lands' : 'unknown'),
    }
  }

  function syncFriendPlantSummary(friendId: string, lands: any[], summary: any) {
    const key = String(friendId)
    const idx = friends.value.findIndex(f => String(f?.gid || '') === key)
    if (idx < 0)
      return

    const nextPlant = buildPlantSummaryFromDetail(lands, summary)
    friends.value[idx] = {
      ...friends.value[idx],
      plant: nextPlant,
    }
  }

  // 把仍在有效期内的实时在线证据合并进新拉取的好友快照：
  // 晚到的列表响应不能覆盖更新的实时在线标记。
  function mergeOnlineEvidence(list: any[], now = Date.now()) {
    const fresh = Object.entries(onlineEvidence.value)
      .filter(([, ev]) => now - ev.at <= ONLINE_EVIDENCE_TTL_MS)
    if (fresh.length === 0)
      return list
    const byGid = new Map(fresh.map(([gid, ev]) => [Number(gid), ev]))
    return list.map((f: any) => {
      const ev = byGid.get(Number(f?.gid))
      return ev ? { ...f, online: true, activeAt: ev.at } : f
    })
  }

  async function fetchFriends(accountId: string, forceSync = false) {
    if (!accountId)
      return
    const requestedId = String(accountId)
    // 代次保护：更晚的请求开始后，旧响应不写列表、旧 finally 不清新请求的 loading
    const seq = ++friendsReqSeq
    loading.value = true
    try {
      const res = await api.get('/api/friends', {
        headers: { 'x-account-id': accountId },
        params: forceSync ? { forceSync: 'true' } : {},
      })
      if (seq !== friendsReqSeq || !isCurrentAccount(requestedId))
        return
      if (res.data.ok) {
        friends.value = mergeOnlineEvidence(res.data.data || [])
      }
    }
    finally {
      if (seq === friendsReqSeq)
        loading.value = false
    }
  }

  // log:new 桥：只认当前账号、已证实在线源、10 秒窗口内的非未来证据。
  // 数据包形状来自 worker setLogHook + admin emitRealtimeLog：
  // { accountId, time, tag, msg, isWarn, meta: { module, event, friendGid, source, at } }
  function applyOnlineEvidence(accountId: unknown, gid: unknown, at: unknown, source: unknown, now = Date.now()) {
    if (!accountId || !isCurrentAccount(String(accountId)))
      return false
    const id = Number(gid)
    const src = String(source || '')
    if (!Number.isSafeInteger(id) || id <= 0 || !ONLINE_EVIDENCE_SOURCES.has(src))
      return false
    const atMs = Number(at) || 0
    if (!atMs || atMs > now + 1000 || now - atMs > ONLINE_EVIDENCE_TTL_MS)
      return false
    const key = String(id)
    const prev = onlineEvidence.value[key]
    if (prev && prev.at >= atMs)
      return true
    onlineEvidence.value = { ...onlineEvidence.value, [key]: { at: atMs, source: src } }
    const idx = friends.value.findIndex(f => Number(f?.gid) === id)
    if (idx >= 0) {
      friends.value[idx] = { ...friends.value[idx], online: true, activeAt: atMs }
    }
    return true
  }

  function applyOnlineEvidenceLog(entry: any, now = Date.now()) {
    const meta = entry?.meta
    if (!meta || meta.event !== 'friend_activity_evidence')
      return false
    return applyOnlineEvidence(entry.accountId, meta.friendGid, meta.at, meta.source, now)
  }

  // 撤销过期证据对应的在线标记（页面 1 秒 ticker 调用）
  function expireOnlineEvidence(now = Date.now()) {
    const expired = Object.entries(onlineEvidence.value)
      .filter(([, ev]) => now - ev.at > ONLINE_EVIDENCE_TTL_MS)
      .map(([gid]) => Number(gid))
    if (expired.length === 0)
      return
    const next = { ...onlineEvidence.value }
    for (const gid of expired)
      delete next[String(gid)]
    onlineEvidence.value = next
    const expiredSet = new Set(expired)
    friends.value = friends.value.map((f: any) =>
      expiredSet.has(Number(f?.gid)) ? { ...f, online: false } : f,
    )
  }

  async function fetchFriendsDogInfo(accountId: string) {
    if (!accountId)
      return { ok: false, error: '账号ID无效' }
    const requestedId = String(accountId)
    dogInfoLoading.value = true
    try {
      const res = await api.post('/api/friends/fetch-dog-info', {}, {
        headers: { 'x-account-id': accountId },
        timeout: 600000,
      })
      if (res.data.ok && Array.isArray(res.data.friends) && isCurrentAccount(requestedId)) {
        friends.value = res.data.friends
      }
      return {
        ok: !!res.data.ok,
        failCount: res.data.failCount || 0,
        blacklistCount: res.data.blacklistCount || 0,
        guardDogCount: res.data.guardDogCount || 0,
        error: res.data.error || '',
      }
    }
    catch (e: any) {
      return {
        ok: false,
        error: e?.response?.data?.error || e?.message || '获取狗信息失败',
      }
    }
    finally {
      dogInfoLoading.value = false
    }
  }

  async function fetchFriendDogInfo(accountId: string, gid: string | number) {
    if (!accountId || !gid)
      return null
    try {
      const res = await api.get(`/api/friend/${gid}/dog`, {
        headers: { 'x-account-id': accountId },
      })
      if (res.data.ok)
        return res.data.data
    }
    catch {
      // ignore
    }
    return null
  }
  async function fetchInteractRecords(accountId: string) {
    if (!accountId)
      return
    const requestedId = String(accountId)
    interactLoading.value = true
    interactError.value = ''

    try {
      const res = await api.get('/api/interact-records', {
        headers: { 'x-account-id': accountId },
      })
      if (!isCurrentAccount(requestedId))
        return
      if (res.data.ok) {
        interactRecords.value = Array.isArray(res.data.data) ? res.data.data : []
      }
      else {
        interactError.value = res.data.error || '加载访客记录失败'
      }
    }
    catch (error: any) {
      interactError.value = error?.response?.data?.error || error?.message || '加载访客记录失败'
    }
    finally {
      interactLoading.value = false
    }
  }

  async function fetchBlacklist(accountId: string) {
    if (!accountId)
      return
    const requestedId = String(accountId)
    try {
      const res = await api.get('/api/friend-blacklist', {
        headers: { 'x-account-id': accountId },
      })
      if (!isCurrentAccount(requestedId))
        return
      if (res.data.ok) {
        blacklist.value = res.data.data || []
      }
    }
    catch { /* ignore */ }
  }

  async function toggleBlacklist(accountId: string, gid: number) {
    if (!accountId || !gid)
      return
    const res = await api.post('/api/friend-blacklist/toggle', { gid }, {
      headers: { 'x-account-id': accountId },
    })
    if (res.data.ok) {
      blacklist.value = res.data.data || []
    }
  }

  // 统一应用重点名单响应：列表 + 意图/消费版本元数据。
  // 版本守卫：服务端意图版本（opSeq）较旧的响应一律拒绝（返回 false），
  // 不得回退名单/元数据/通知状态——覆盖乱序到达的旧写响应与旧 GET 快照。
  // 版本相等时仍应用（保存失败回滚快照的 opSeq 不前进，无更新写时如实
  // 展示回滚名单）；同版本消费进度只前进不回退。
  function applyWatchlistResponse(payload: any) {
    const meta = payload?.meta || {}
    const opSeq = Number(meta.opSeq) || 0
    if (opSeq < watchlistMeta.value.opSeq)
      return false
    watchlist.value = Array.isArray(payload?.data) ? payload.data : []
    watchlistMeta.value = {
      opSeq,
      consumedOpSeq: Math.max(watchlistMeta.value.consumedOpSeq, Number(meta.consumedOpSeq) || 0),
    }
    return true
  }

  // 读取代次 + 账号一致性守卫；版本守卫在 applyWatchlistResponse 内统一执行
  async function fetchWatchlist(accountId: string) {
    if (!accountId)
      return
    const requestedId = String(accountId)
    const seq = ++watchlistReqSeq
    try {
      const res = await api.get('/api/friend-watchlist', {
        headers: { 'x-account-id': accountId },
      })
      if (seq !== watchlistReqSeq || !isCurrentAccount(requestedId))
        return
      if (res.data.ok)
        applyWatchlistResponse(res.data)
    }
    catch { /* ignore */ }
  }

  // 写操作统一走 applyWatchlistResponse（含保存失败时的回滚后名单快照）；
  // 生命周期代次或账号已变化（清空/切换/切回）→ 整体丢弃（stale=true 不写
  // 名单与通知、页面不弹错），成功响应与请求拒绝（catch）同等守卫——旧生命
  // 周期的请求失败不是当前页面的失败；代次未变但版本较旧 → 同样按 stale
  // 丢弃；较早发起而携带较新服务端版本的响应由版本守卫正常放行。
  async function toggleWatchlist(accountId: string, gid: number) {
    if (!accountId || !gid)
      return { ok: false, stale: false }
    const requestedId = String(accountId)
    const epoch = watchlistAccountEpoch
    try {
      const res = await api.post('/api/friend-watchlist/toggle', { gid }, {
        headers: { 'x-account-id': accountId },
      })
      if (epoch !== watchlistAccountEpoch || !isCurrentAccount(requestedId))
        return { ok: false, stale: true }
      if (!applyWatchlistResponse(res.data))
        return { ok: false, stale: true }
      if (res.data.ok) {
        watchlistNotify.value = {
          saved: res.data.saved !== false,
          notifyAttempted: !!res.data.notifyAttempted,
        }
      }
      return { ok: !!res.data.ok, stale: false }
    }
    catch {
      // 拒绝分支同样受生命周期守卫：旧生命周期的请求失败不弹过期错误
      if (epoch !== watchlistAccountEpoch || !isCurrentAccount(requestedId))
        return { ok: false, stale: true }
      return { ok: false, stale: false }
    }
  }

  // 恢复某目标的普通基线巡田（用户意图；Worker 消费前只影响本地展示）
  async function resumeWatchlist(accountId: string, gid: number) {
    if (!accountId || !gid)
      return { ok: false, stale: false }
    const requestedId = String(accountId)
    const epoch = watchlistAccountEpoch
    try {
      const res = await api.post('/api/friend-watchlist/resume', { gid }, {
        headers: { 'x-account-id': accountId },
      })
      if (epoch !== watchlistAccountEpoch || !isCurrentAccount(requestedId))
        return { ok: false, stale: true }
      if (!applyWatchlistResponse(res.data))
        return { ok: false, stale: true }
      if (res.data.ok) {
        watchlistNotify.value = {
          saved: res.data.saved !== false,
          notifyAttempted: !!res.data.notifyAttempted,
        }
      }
      return { ok: !!res.data.ok, stale: false }
    }
    catch {
      // 拒绝分支同样受生命周期守卫：旧生命周期的请求失败不弹过期错误
      if (epoch !== watchlistAccountEpoch || !isCurrentAccount(requestedId))
        return { ok: false, stale: true }
      return { ok: false, stale: false }
    }
  }

  // 移出重点名单（显式移除意图：旧暂停状态不被 remove-re-add 继承）
  async function removeWatchlist(accountId: string, gid: number) {
    if (!accountId || !gid)
      return { ok: false, stale: false }
    const requestedId = String(accountId)
    const epoch = watchlistAccountEpoch
    try {
      const res = await api.post('/api/friend-watchlist/remove', { gid }, {
        headers: { 'x-account-id': accountId },
      })
      if (epoch !== watchlistAccountEpoch || !isCurrentAccount(requestedId))
        return { ok: false, stale: true }
      if (!applyWatchlistResponse(res.data))
        return { ok: false, stale: true }
      if (res.data.ok) {
        watchlistNotify.value = {
          saved: res.data.saved !== false,
          notifyAttempted: !!res.data.notifyAttempted,
        }
      }
      return { ok: !!res.data.ok, stale: false }
    }
    catch {
      // 拒绝分支同样受生命周期守卫：旧生命周期的请求失败不弹过期错误
      if (epoch !== watchlistAccountEpoch || !isCurrentAccount(requestedId))
        return { ok: false, stale: true }
      return { ok: false, stale: false }
    }
  }

  // 在线自动捣乱名单：好友上线时随机放虫/放草（每次上线一次）
  async function fetchAutoBad(accountId: string) {
    if (!accountId)
      return
    const requestedId = String(accountId)
    try {
      const res = await api.get('/api/friend-auto-bad', {
        headers: { 'x-account-id': accountId },
      })
      if (!isCurrentAccount(requestedId))
        return
      if (res.data.ok) {
        autoBadList.value = res.data.data || []
      }
    }
    catch { /* 名单拉取失败不阻塞好友页 */ }
  }

  // 返回结果供页面提示（每个好友独立开关，与重点监控无依赖）。
  // stale=true 表示响应回来时账号已切换：不写名单、页面也不得弹错
  async function toggleAutoBad(accountId: string, gid: number) {
    if (!accountId || !gid)
      return { ok: false, error: '参数无效', stale: false }
    const requestedId = String(accountId)
    try {
      const res = await api.post('/api/friend-auto-bad/toggle', { gid }, {
        headers: { 'x-account-id': accountId },
      })
      if (!isCurrentAccount(requestedId))
        return { ok: false, error: '', stale: true }
      if (res.data.ok) {
        autoBadList.value = res.data.data || []
        return { ok: true, stale: false }
      }
      return { ok: false, error: res.data.error || '设置失败', stale: false }
    }
    catch (e: any) {
      if (!isCurrentAccount(requestedId))
        return { ok: false, error: '', stale: true }
      return { ok: false, error: e?.response?.data?.error || '设置失败', stale: false }
    }
  }

  async function fetchFriendLands(accountId: string, friendId: string) {
    if (!accountId || !friendId)
      return
    const requestedId = String(accountId)
    friendLandsLoading.value[friendId] = true
    try {
      const res = await api.get(`/api/friend/${friendId}/lands`, {
        headers: { 'x-account-id': accountId },
      })
      if (!isCurrentAccount(requestedId))
        return
      if (res.data.ok) {
        const lands = res.data.data.lands || []
        const summary = res.data.data.summary || null
        friendLands.value[friendId] = lands
        syncFriendPlantSummary(friendId, lands, summary)
      }
    }
    finally {
      friendLandsLoading.value[friendId] = false
    }
  }

  async function operate(accountId: string, friendId: string, opType: string) {
    if (!accountId || !friendId)
      return { ok: false, message: '参数无效' }
    try {
      const res = await api.post(`/api/friend/${friendId}/op`, { opType }, {
        headers: { 'x-account-id': accountId },
      })
      const result = res.data?.data || res.data || {}
      await fetchFriends(accountId)
      if (friendLands.value[friendId]) {
        await fetchFriendLands(accountId, friendId)
      }
      return result
    }
    catch (e: any) {
      return { ok: false, message: e?.response?.data?.error || e?.message || '操作失败' }
    }
  }

  function applyKnownFriendSettings(data: KnownFriendSettings | null | undefined) {
    if (!data)
      return
    knownFriendGids.value = Array.isArray(data.knownFriendGids) ? data.knownFriendGids : []
    knownFriendGidSyncCooldownSec.value = Number.isFinite(data.knownFriendGidSyncCooldownSec)
      ? Math.max(30, Math.min(86400, data.knownFriendGidSyncCooldownSec))
      : 600
    friendsListCacheTtlSec.value = Number.isFinite(data.friendsListCacheTtlSec)
      ? Math.max(10, Math.min(86400, data.friendsListCacheTtlSec))
      : 60
  }

  async function fetchKnownFriendSettings(accountId: string) {
    if (!accountId)
      return
    const requestedId = String(accountId)
    knownFriendSettingsLoading.value = true
    try {
      const res = await api.get('/api/friend-known-gids', {
        headers: { 'x-account-id': accountId },
      })
      if (!isCurrentAccount(requestedId))
        return
      if (res.data.ok) {
        applyKnownFriendSettings(res.data.data)
      }
    }
    finally {
      knownFriendSettingsLoading.value = false
    }
  }

  async function saveKnownFriendSettings(accountId: string, payload: Partial<KnownFriendSettings>) {
    if (!accountId)
      return
    knownFriendSettingsSaving.value = true
    try {
      const res = await api.post('/api/friend-known-gids', payload, {
        headers: { 'x-account-id': accountId },
      })
      if (res.data.ok) {
        applyKnownFriendSettings(res.data.data)
      }
    }
    finally {
      knownFriendSettingsSaving.value = false
    }
  }

  async function removeKnownFriendGid(accountId: string, gid: number) {
    if (!accountId || !gid)
      return
    knownFriendSettingsSaving.value = true
    try {
      const res = await api.post('/api/friend-known-gids/remove', { gid }, {
        headers: { 'x-account-id': accountId },
      })
      if (res.data.ok) {
        applyKnownFriendSettings(res.data.data)
      }
    }
    finally {
      knownFriendSettingsSaving.value = false
    }
  }

  async function batchAddKnownFriendGids(accountId: string, gids: number[]) {
    if (!accountId || !gids || gids.length === 0)
      return { ok: false, addedCount: 0 }
    knownFriendSettingsSaving.value = true
    try {
      const res = await api.post('/api/friend-known-gids/batch-add', { gids }, {
        headers: { 'x-account-id': accountId },
      })
      if (res.data.ok) {
        applyKnownFriendSettings(res.data.data)
      }
      return { ok: res.data.ok, addedCount: res.data.addedCount || 0 }
    }
    finally {
      knownFriendSettingsSaving.value = false
    }
  }

  async function removeUnsyncedKnownFriendGids(accountId: string, gids: number[]) {
    if (!accountId || !gids || gids.length === 0)
      return { ok: false, removedCount: 0 }
    knownFriendSettingsSaving.value = true
    try {
      const res = await api.post('/api/friend-known-gids/batch-remove', { gids }, {
        headers: { 'x-account-id': accountId },
      })
      if (res.data.ok) {
        applyKnownFriendSettings(res.data.data)
      }
      return { ok: res.data.ok, removedCount: res.data.removedCount || 0 }
    }
    finally {
      knownFriendSettingsSaving.value = false
    }
  }

  return {
    friends,
    loading,
    onlineEvidence,
    applyOnlineEvidenceLog,
    expireOnlineEvidence,
    dogInfoLoading,
    friendLands,
    friendLandsLoading,
    blacklist,
    watchlist,
    watchlistMeta,
    watchlistNotify,
    autoBadList,
    interactRecords,
    interactLoading,
    interactError,
    knownFriendGids,
    knownFriendGidSyncCooldownSec,
    friendsListCacheTtlSec,
    knownFriendSettingsLoading,
    knownFriendSettingsSaving,
    clearFriendData,
    fetchFriends,
    fetchFriendsDogInfo,
    fetchFriendDogInfo,
    fetchBlacklist,
    toggleBlacklist,
    fetchWatchlist,
    toggleWatchlist,
    resumeWatchlist,
    removeWatchlist,
    fetchAutoBad,
    toggleAutoBad,
    fetchInteractRecords,
    fetchFriendLands,
    operate,
    fetchKnownFriendSettings,
    saveKnownFriendSettings,
    removeKnownFriendGid,
    batchAddKnownFriendGids,
    removeUnsyncedKnownFriendGids,
  }
})
