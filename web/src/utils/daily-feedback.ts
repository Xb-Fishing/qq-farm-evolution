// Only fixed action categories and random correlation IDs leave the browser.
// Never collect text, values, account IDs, URLs, error messages, stacks or tokens as log data.
interface FeedbackEvent {
  kind: 'click' | 'client_error'
  page: string
  trace?: string
  target?: string
  category?: string
}
const pageNames = new Set(['dashboard', 'farm', 'friends', 'bag', 'shop', 'task', 'warehouse', 'activity', 'settings', 'accounts', 'admin'])
let queue: FeedbackEvent[] = []
let trace = ''
let traceAt = 0
let timer: ReturnType<typeof setTimeout> | undefined
let sending = false
let installed = false
let lastErrorAt = 0
function page() {
  const name = window.location.pathname.split('/')[1] || 'dashboard'
  return pageNames.has(name) ? name : 'other'
}
function readSessionToken() {
  try {
    return localStorage.getItem('admin_token') || ''
  }
  catch {
    return ''
  }
}
function scheduleFlush() {
  if (timer)
    return
  timer = setTimeout(() => {
    timer = undefined
    void flushFeedback()
  }, 1500)
}
function enqueue(event: FeedbackEvent) {
  if (!readSessionToken())
    return
  if (queue.length >= 200)
    queue.shift()
  queue.push(event)
  scheduleFlush()
}
export function currentFeedbackTrace() {
  // A short-lived interaction window includes its immediate refresh requests.
  return Date.now() - traceAt <= 5000 ? trace : ''
}
export function recordClientFailure(category: 'vue_error' | 'unhandled_rejection' | 'script_error' | 'network_error' | 'request_timeout') {
  if (Date.now() - lastErrorAt < 500)
    return
  lastErrorAt = Date.now()
  enqueue({ kind: 'client_error', category, page: page(), trace: currentFeedbackTrace() })
}
export async function flushFeedback() {
  if (sending || !queue.length)
    return
  const token = readSessionToken()
  if (!token) {
    queue = []
    return
  }
  sending = true
  const batch = queue.splice(0, 50)
  const abort = new AbortController()
  const timeout = setTimeout(() => abort.abort(), 5000)
  let delivered = false
  try {
    // Use fetch directly so telemetry never recursively records or retries API failures.
    const response = await fetch('/api/diagnostics/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-token': token },
      body: JSON.stringify({ events: batch }),
      signal: abort.signal,
      keepalive: true,
    })
    delivered = response.ok
    if (!response.ok && response.status !== 401 && response.status !== 429)
      queue = [...batch, ...queue].slice(-200)
  }
  catch { queue = [...batch, ...queue].slice(-200) }
  finally {
    clearTimeout(timeout)
    sending = false
  }
  if (delivered && queue.length)
    scheduleFlush()
  // A later click/online event retries retained feedback; no failure retry loop.
}
export function installDailyFeedback() {
  if (installed)
    return
  installed = true
  const captureClick = (event: MouseEvent) => {
    if (!(event.target instanceof Element))
      return
    const element = event.target.closest('button,a,input,select,[role="button"],[role="tab"]')
    if (!element || element.hasAttribute('disabled'))
      return
    const bytes = new Uint8Array(16)
    crypto.getRandomValues(bytes)
    bytes[6] = (bytes[6]! & 0x0F) | 0x40
    bytes[8] = (bytes[8]! & 0x3F) | 0x80
    const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
    trace = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
    traceAt = Date.now()
    const tag = element.tagName.toLowerCase()
    const target = element.getAttribute('role') === 'tab' ? 'tab' : tag === 'a' ? 'link' : ['button', 'input', 'select'].includes(tag) ? tag : 'control'
    enqueue({ kind: 'click', page: page(), target, trace })
  }
  document.addEventListener('click', (event) => {
    try {
      captureClick(event)
    }
    catch { /* Feedback must never break the user's action. */ }
  }, true)
  window.addEventListener('online', () => {
    void flushFeedback()
  })
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden')
      void flushFeedback()
  })
}
