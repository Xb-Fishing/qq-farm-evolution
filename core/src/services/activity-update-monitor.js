const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
const { readUpdateDigest, recordUpdateDigest } = require('./game-update-digest');
const { getDataFile } = require('../config/runtime-paths');
const { scanActivityUpdates } = require('./activity-update-scanner');
const { activityCatalog } = require('./activity-catalog-facts');

const DEFAULT_INTERVAL_MS = 30 * 60 * 1000;
const MANUAL_SCAN_UPSTREAM_CACHE_MS = 2 * 60 * 1000;
const MIN_INTERVAL_MS = 60 * 1000;
const INITIAL_SCAN_MIN_MS = 15 * 1000;
const INITIAL_SCAN_JITTER_MS = 10 * 1000;
const UNAVAILABLE_RETRY_MIN_MS = 60 * 1000;
const UNAVAILABLE_RETRY_JITTER_MS = 30 * 1000;
const STATE_FILE = getDataFile('activity-update-report.json');
const DIGEST_FILE = getDataFile('activity-update-digest.json');
// setTimeout 超过 2^31-1ms 会溢出为立即触发：超长到期只截断到上限，醒来后再续排。
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;

let timer = null;
let endTimeTimer = null;
let endTimeWakeGeneration = 0;
let endTimeWakeAt = 0;
let running = false;
let scanPromise = null;
let scanGeneration = -1;
let monitorGeneration = 0;
let monitorActive = false;
let report = null;
let knownActivityIds = [];
let intervalMs = DEFAULT_INTERVAL_MS;
let nextScanAt = 0;
let onlineScanner = null;
let localScanEnabled = false;
let onReport = null;

function emptyLocalReport() {
  return {
    scannedAt: Date.now(),
    appId: '1112386029',
    source: null,
    candidateCount: 0,
    incompleteCandidates: [],
    detectedActivityIds: [],
    unknownActivityIds: [],
    caches: [],
    warnings: [],
    localScanEnabled: false,
  };
}

function readSavedReport() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function writeSavedReport(value) {
  try {
    fs.mkdirSync(require('node:path').dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, `${JSON.stringify(value, null, 2)}\n`);
  } catch (error) {
    console.warn(`[活动更新] 保存分析结果失败: ${error.message}`);
  }
}

// ---- 稳定更新指纹与未审变更（持久，扫描/失败不清账） ----

// 稳定 digest 只取目录性内容（候选/结束活动、分组编号与来源版本），
// 排除时间/进度字段：同一事实重复扫描得到同一 digest。
function computeReportDigest(value) {
  const online = value?.online || {};
  const stable = {
    unknown: [...(online.unknownActivityIds || [])].map(Number).sort((a, b) => a - b),
    ended: [...(value?.endedActivityIds || [])].map(Number).sort((a, b) => a - b),
    groups: (online.groups || []).map((item) => `${Number(item?.id)}:${item?.reviewKind || ''}`).sort(),
    activityIds: (online.activities || []).map((item) => Number(item?.id)).filter(id => id > 0).sort((a, b) => a - b),
    sourceVersion: String(value?.source?.version || ''),
    catalog: activityCatalog(online.groups),
    gameFacts: value?.online?.gameUpdateEvidence?.factsComplete === true ? value.online.gameUpdateEvidence.semanticHash : '',
  };
  return crypto.createHash('sha256').update(JSON.stringify(stable)).digest('hex').slice(0, 32);
}

function readSavedDigest() {
  try { return readUpdateDigest(path.dirname(DIGEST_FILE)); }
  catch { return { unreviewed: [], incomplete: true, errorClass: 'invalid_update_digest' }; }
}

function persistUpdateDigest(scanned) {
  try { return recordUpdateDigest(path.dirname(DIGEST_FILE), scanned, computeReportDigest(scanned)); }
  catch (error) {
    console.warn(`[活动更新] 保存更新指纹失败: ${error.message}`);
    return null;
  }
}

// ---- 已知活动 endTime 单次计时唤醒复核 ----

function nextKnownEndTimeMs(value, nowMs = Date.now()) {
  const activities = value?.online?.activities;
  if (!Array.isArray(activities) || value?.online?.available === false) return 0;
  const known = new Set((knownActivityIds || []).map(Number));
  let earliest = 0;
  for (const item of activities) {
    const id = Number(item?.id);
    if (!id || (known.size > 0 && !known.has(id))) continue;
    let end = Number(item?.endTime) || 0;
    if (end > 1e12) end = Math.floor(end / 1000);
    if (!end) continue;
    const endMs = end * 1000;
    if (endMs <= nowMs) continue; // 结算边界：已过期交给常规扫描
    if (!earliest || endMs < earliest) earliest = endMs;
  }
  return earliest;
}

function clearEndTimeWake() {
  endTimeWakeGeneration += 1;
  if (endTimeTimer) clearTimeout(endTimeTimer);
  endTimeTimer = null;
  endTimeWakeAt = 0;
}

function armEndTimeReview(value, nowMs = Date.now()) {
  if (!value?.online?.available) return false; // 读取失败保留既有到期证据。
  const targetMs = nextKnownEndTimeMs(value, nowMs);
  if (!targetMs) { clearEndTimeWake(); return false; }
  if (endTimeTimer && endTimeWakeAt === targetMs) return true;
  clearEndTimeWake();
  const generation = endTimeWakeGeneration;
  const monitorOwner = monitorGeneration;
  endTimeWakeAt = targetMs;
  endTimeTimer = setTimeout(async () => {
    if (generation !== endTimeWakeGeneration || monitorOwner !== monitorGeneration || endTimeTimer === null) return;
    endTimeTimer = null;
    if (Date.now() < targetMs) { armEndTimeReview(value); return; }
    endTimeWakeAt = 0;
    let result;
    try { result = await runActivityUpdateScan({ maxAgeMs: 0 }); }
    catch { /* 原低频扫描继续恢复，不增加到期重试风暴。 */ }
    if (monitorActive && monitorOwner === monitorGeneration) scheduleNextScan(result?.status === 'unavailable' ? nextUnavailableRetryDelayMs() : nextScanDelayMs());
  }, Math.min(MAX_TIMER_DELAY_MS, Math.max(1, targetMs - nowMs)));
  endTimeTimer.unref?.();
  return true;
}

function isActivityReportFresh(value, maxAgeMs, now = Date.now()) {
  if (value?.status === 'unavailable' || value?.online?.available === false) return false;
  const scannedAt = Number(value?.scannedAt) || 0;
  const ageLimit = Math.max(0, Number(maxAgeMs) || 0);
  return scannedAt > 0 && ageLimit > 0 && now - scannedAt >= 0 && now - scannedAt < ageLimit;
}

/**
 * 识别已结束的活动：在线列表中 end_time 已过期，或已知活动从列表中消失
 * （上次扫描还在、这次不在，才判定消失，避免列表抖动误报）。
 */
function detectEndedActivities(online, previous, knownIds) {
  if (!online?.available || !Array.isArray(online.activities)) return [];
  const nowSec = Math.floor(Date.now() / 1000);
  const known = new Set((knownIds || []).map(Number));
  const listed = new Map((online.activities).map(item => [Number(item.id), item]));
  const prevListed = new Set(((previous?.online?.activities) || []).map(item => Number(item.id)));
  const ended = [];
  for (const [id, item] of listed) {
    let end = Number(item.endTime) || 0;
    if (end > 1e12) end = Math.floor(end / 1000); // 兼容毫秒时间戳
    if (end > 0 && end <= nowSec) ended.push({ id, title: String(item.title || ''), reason: 'expired' });
  }
  for (const id of known) {
    if (!listed.has(id) && prevListed.has(id)) ended.push({ id, title: '', reason: 'missing' });
  }
  return ended.sort((a, b) => b.id - a.id);
}

function analyzeReport(scanned, previous, online = null) {
  // 正式候选必须得到在线接口确认。本机源码/缓存仅作为辅助证据展示。
  const candidateIds = [...new Set(online?.unknownActivityIds || [])]
    .sort((a, b) => b - a);
  const endedActivities = detectEndedActivities(online, previous, knownActivityIds);
  const groups = new Map();
  for (const id of candidateIds) {
    const date = String(id).slice(0, 8);
    const items = groups.get(date) || [];
    items.push(id);
    groups.set(date, items);
  }
  const previousVersion = previous?.source?.version || '';
  return {
    ...scanned,
    status: !scanned.source && !online?.available
      ? 'unavailable'
      : candidateIds.length ? 'update-found' : 'up-to-date',
    unknownActivityIds: candidateIds,
    endedActivityIds: endedActivities.map(item => item.id),
    endedActivities,
    hasChanges: candidateIds.length > 0 || endedActivities.length > 0,
    online,
    localEvidence: {
      enabled: scanned.localScanEnabled === true,
      unknownActivityIds: scanned.unknownActivityIds || [],
      detectedActivityIds: scanned.detectedActivityIds || [],
      source: scanned.source || null,
      caches: scanned.caches || [],
      warnings: scanned.warnings || [],
    },
    sourceChanged: !!previousVersion && previousVersion !== scanned.source?.version,
    previousSourceVersion: previousVersion || null,
    analysis: {
      candidateGroups: [...groups.entries()].map(([date, ids]) => ({ date, ids })),
      requiresProtocolSample: candidateIds.length > 0,
      safeToAutoApply: false,
      summary: (candidateIds.length
        ? `发现 ${candidateIds.length} 个候选活动 ID，已自动读取在线活动列表和只读活动分组`
        : online?.available
          ? '在线活动列表未发现尚未登记的新活动'
          : '在线分析等待已连接账号')
        + (endedActivities.length ? `；检测到 ${endedActivities.length} 个已结束活动` : ''),
    },
  };
}

async function runActivityUpdateScan(options = {}) {
  const maxAgeMs = Math.max(0, Number(options.maxAgeMs) || 0);
  const current = report || readSavedReport();
  if (isActivityReportFresh(current, maxAgeMs)) {
    report = current;
    return current;
  }
  const generation = monitorGeneration;
  if (scanPromise && scanGeneration === generation) return scanPromise;
  running = true;
  const task = Promise.resolve().then(async () => {
    try {
      if (generation !== monitorGeneration) throw Object.assign(new Error('活动更新扫描已取消'), { code: 'SCAN_CANCELLED' });
      const previous = report || readSavedReport();
      const scanned = localScanEnabled
        ? { ...scanActivityUpdates({ knownActivityIds }), localScanEnabled: true }
        : emptyLocalReport();
      let online = null;
      if (typeof onlineScanner === 'function') {
        try { online = await onlineScanner(knownActivityIds, scanned); }
        catch (error) { online = { available: false, error: error.message || String(error), activities: [], groups: [], unknownActivityIds: [] }; }
      }
      if (generation !== monitorGeneration) throw Object.assign(new Error('活动更新扫描已取消'), { code: 'SCAN_CANCELLED' });
      report = analyzeReport(scanned, previous, online);
      if (report.status !== 'unavailable' && !persistUpdateDigest(report)) report.digestPersistenceFailed = true;
      writeSavedReport(report);
      if (monitorActive) {
        armEndTimeReview(report);
        if (typeof onReport === 'function') {
          try { onReport(report); }
          catch (error) { console.warn(`[活动更新] 报告回调失败: ${error.message}`); }
        }
      }
      return report;
    } finally {
      if (scanPromise === task) { running = false; scanPromise = null; }
    }
  });
  scanPromise = task;
  scanGeneration = generation;
  return task;
}

// 固定 30 分钟扫描是机器指纹：均匀打散 ±20%，均值不变（防封巡检 2026-08-23）
function nextScanDelayMs(baseMs = intervalMs) {
  const spread = Math.floor(baseMs * 0.2);
  return Math.max(MIN_INTERVAL_MS, baseMs - spread + Math.floor(Math.random() * (spread * 2 + 1)));
}

function nextInitialScanDelayMs(random = Math.random) {
  return INITIAL_SCAN_MIN_MS + Math.floor(random() * (INITIAL_SCAN_JITTER_MS + 1));
}

function nextUnavailableRetryDelayMs(random = Math.random) {
  return UNAVAILABLE_RETRY_MIN_MS + Math.floor(random() * (UNAVAILABLE_RETRY_JITTER_MS + 1));
}

function scheduleNextScan(delayMs = nextScanDelayMs()) {
  if (!monitorActive) return;
  const generation = monitorGeneration;
  if (timer) clearTimeout(timer);
  const delay = Math.max(0, Number(delayMs) || 0);
  nextScanAt = Date.now() + delay;
  const handle = setTimeout(async () => {
    if (!monitorActive || generation !== monitorGeneration || timer !== handle) return;
    let result = null;
    try {
      result = await runActivityUpdateScan();
    } catch (error) {
      console.warn(`[活动更新] 定时分析失败: ${error.message}`);
    } finally {
      if (monitorActive && generation === monitorGeneration) scheduleNextScan(result?.status === 'unavailable'
        ? nextUnavailableRetryDelayMs()
        : nextScanDelayMs());
    }
  }, delay);
  timer = handle;
  timer.unref?.();
}

function startActivityUpdateMonitor(options = {}) {
  monitorGeneration++;
  monitorActive = true;
  knownActivityIds = (options.knownActivityIds || []).map(Number);
  onlineScanner = typeof options.onlineScanner === 'function' ? options.onlineScanner : null;
  onReport = typeof options.onReport === 'function' ? options.onReport : null;
  localScanEnabled = options.localScanEnabled === true
    || String(process.env.ACTIVITY_LOCAL_SCAN_ENABLED || '').toLowerCase() === 'true';
  intervalMs = Math.max(MIN_INTERVAL_MS, Number(options.intervalMs) || Number(process.env.ACTIVITY_UPDATE_INTERVAL_MS) || DEFAULT_INTERVAL_MS);
  report = report || readSavedReport();
  // 路由注册早于账号 Worker 完成登录。首扫稍作抖动等待，避免启动瞬间把旧报告
  // 覆盖为 unavailable；若账号仍离线，只检查连接状态后低频重试，不发协议请求。
  scheduleNextScan(nextInitialScanDelayMs());
  // 重启后按已保存报告里的已知活动 endTime 续排单次到期复核。
  armEndTimeReview(report);
}

function stopActivityUpdateMonitor() {
  monitorGeneration++;
  monitorActive = false;
  if (timer) clearTimeout(timer); timer = null; nextScanAt = 0; clearEndTimeWake();
}

function getActivityUpdateState() {
  return {
    running,
    intervalMs,
    nextScanAt,
    nextEndTimeReviewAt: endTimeWakeAt,
    report: report || readSavedReport(),
    updateDigest: readSavedDigest(),
  };
}

module.exports = {
  DEFAULT_INTERVAL_MS,
  MANUAL_SCAN_UPSTREAM_CACHE_MS,
  nextScanDelayMs,
  nextInitialScanDelayMs,
  nextUnavailableRetryDelayMs,
  analyzeReport,
  computeReportDigest,
  armEndTimeReview,
  nextKnownEndTimeMs,
  readSavedDigest,
  getActivityUpdateState,
  isActivityReportFresh,
  runActivityUpdateScan,
  startActivityUpdateMonitor,
  stopActivityUpdateMonitor,
};
