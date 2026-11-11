// Classify locally; raw URLs, parameters and payloads never enter telemetry.
export function requestOperation(method: unknown, url: unknown): string {
  if (typeof url !== 'string' || typeof method !== 'string') return 'other'
  const pathname = url.split(/[?#]/, 1)[0] || ''
  const verb = method.toUpperCase()
  if (verb === 'POST' && pathname === '/api/shop/mall/buy') return 'mall_purchase'
  if (verb === 'POST' && pathname === '/api/shop/buy') return 'shop_purchase'
  if (verb === 'POST' && pathname === '/api/bag/sell') return 'bag_sale'
  if (verb === 'GET') {
    const section = pathname.split('/')[2]
    const known: Record<string, string> = { status: 'status_query', farm: 'farm_query', friends: 'friend_query', bag: 'bag_query', shop: 'shop_query', activity: 'activity_query', settings: 'settings_query', accounts: 'account_query', admin: 'admin_query' }
    return Object.prototype.hasOwnProperty.call(known, section || '') ? known[section!]! : 'other_query'
  }
  return 'other'
}
