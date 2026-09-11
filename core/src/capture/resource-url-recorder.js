/**
 * 官方资源 URL 被动记录器
 *
 * MITM 抓包会话期间，游戏客户端加载的 `*.qq.com` 资源（bundle config、
 * spriteFrame JSON、ASTC/PNG 纹理）请求都会流经代理。本模块只记录 GET
 * 请求的 URL（剥离 query），用于发现官方 CDN 地址——URL 自带 Cocos uuid
 * 和 native hash，`scripts/fetch-official-icons.js` 可直接按 URL 下载。
 *
 * 边界：
 * - 只存 URL，不存请求/响应体、账号或凭据；
 * - 文件是 ignored 的本机运行数据（core/data/capture/resource-urls.json，
 *   0600），不进 Git；
 * - 不影响代理的透明转发，失败静默（记录器绝不干扰抓包主流程）。
 */

const fs = require('node:fs');
const path = require('node:path');

const MAX_URLS_PER_FILE = 2000;
const FLUSH_DELAY_MS = 2000;
const RESOURCE_PATH_RE = /\.(?:png|jpe?g|webp|gif|astc|json|plist|atlas|bin)(?:\?|$)/i;
const RESOURCE_MARKER_RE = /\/(?:import|native|config\.)/i;

/** 判断请求 path 是否像游戏资源请求（用于决定是否记录 URL）。 */
function isResourcePath(pathname) {
  const value = String(pathname || '');
  if (!value) return false;
  return RESOURCE_PATH_RE.test(value) || RESOURCE_MARKER_RE.test(value);
}

/** 规整成完整 https URL（剥离 query，统一 scheme）。 */
function normalizeResourceUrl(host, target) {
  const rawPath = String(target || '').split('?')[0];
  if (!rawPath || rawPath.startsWith('http://') || rawPath.startsWith('https://')) {
    try {
      const url = new URL(rawPath);
      if (url.protocol === 'https:') return url.origin + url.pathname;
      return null;
    } catch {
      return null;
    }
  }
  const cleanHost = String(host || '').trim().toLowerCase();
  if (!cleanHost || !rawPath.startsWith('/')) return null;
  return `https://${cleanHost}${rawPath}`;
}

function createResourceUrlRecorder({ filePath, maxUrls = MAX_URLS_PER_FILE, flushDelayMs = FLUSH_DELAY_MS, log = () => {} }) {
  const urls = new Set();
  let flushTimer = null;
  let stopped = false;

  try {
    if (fs.existsSync(filePath)) {
      const saved = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      for (const url of Array.isArray(saved.urls) ? saved.urls : []) {
        if (typeof url === 'string' && url.startsWith('https://')) urls.add(url);
      }
    }
  } catch {
    // 读取失败（损坏/不存在）就重新开始
  }

  function flush() {
    flushTimer = null;
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const payload = JSON.stringify(
        { savedAt: new Date().toISOString(), count: urls.size, urls: Array.from(urls) },
        null,
        2,
      );
      fs.writeFileSync(filePath, payload, { mode: 0o600 });
    } catch (error) {
      log('warn', `资源 URL 记录落盘失败: ${error.message}`);
    }
  }

  function scheduleFlush() {
    if (flushTimer || stopped) return;
    flushTimer = setTimeout(() => flush(), flushDelayMs);
    if (flushTimer.unref) flushTimer.unref();
  }

  /**
   * 记录一条资源 URL。host 是 CONNECT 目标主机，target 是请求行 path。
   * 返回 true 表示新增（去重后），false 表示重复/无效/已满。
   */
  function record(host, target) {
    if (stopped) return false;
    if (urls.size >= maxUrls) return false;
    if (!isResourcePath(String(target || '').split('?')[0])) return false;
    const url = normalizeResourceUrl(host, target);
    if (!url) return false;
    if (urls.has(url)) return false;
    urls.add(url);
    scheduleFlush();
    return true;
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    // stop 时的 flush 是最终落盘，必须在置位之后仍然执行
    flush();
  }

  return { record, stop, isResourcePath, normalizeResourceUrl, size: () => urls.size };
}

module.exports = {
  createResourceUrlRecorder,
  isResourcePath,
  normalizeResourceUrl,
};
