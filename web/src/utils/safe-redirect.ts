/**
 * 解析登录后应返回的地址：只接受站内相对路径（以单个 / 开头），
 * 拒绝 //host、/\host、协议相对与外链，避免开放重定向。
 */
export function resolveSafeRedirect(target: unknown): string {
  const raw = String(target ?? '').trim()
  if (!raw || !raw.startsWith('/'))
    return ''
  if (raw.startsWith('//') || raw.startsWith('/\\'))
    return ''
  if (raw.includes('://') || raw.toLowerCase().startsWith('/url:') || /\r|\n/.test(raw))
    return ''
  try {
    const parsed = new URL(raw, window.location.origin)
    if (parsed.origin !== window.location.origin)
      return ''
    return parsed.pathname + parsed.search + parsed.hash
  }
  catch {
    return ''
  }
}
