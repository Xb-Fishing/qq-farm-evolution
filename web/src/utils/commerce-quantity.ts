export function exactDecimal(value: unknown): string | null {
  if (typeof value === 'number' && !Number.isSafeInteger(value))
    return null
  if (value == null || typeof value === 'boolean')
    return null
  const text = String(value)
  return /^(?:0|[1-9]\d*)$/.test(text) && BigInt(text) <= 9223372036854775807n ? text : null
}
export function exactText(value: unknown) {
  const text = exactDecimal(value)
  return text === null ? '未知' : BigInt(text).toLocaleString('zh-CN')
}
export function purchaseMaximum(item: any, balance: unknown, mall = false): string {
  if (!item)
    return '0'
  const price = item?.isFree === true ? '0' : exactDecimal(mall ? item.price?.amountDec : item.priceDec ?? item.price)
  const funds = exactDecimal(balance)
  if (!item || (mall ? !item.canBuy : item.quoteKnown !== true || item.unlocked === false) || price === null)
    return '0'
  let max = 99n
  if (!item.isFree && price !== '0') {
    if (funds === null)
      return '0'
    if (BigInt(price) > 0n)
      max = max < BigInt(funds) / BigInt(price) ? max : BigInt(funds) / BigInt(price)
  }
  const limit = exactDecimal(mall ? item.limit?.limitCountDec : item.limitCountDec ?? item.limitCount)
  const bought = exactDecimal(mall ? item.limit?.boughtNumDec : item.boughtNumDec ?? item.boughtNum)
  if (mall && item.limit?.present && (limit === null || limit === '0' || bought === null))
    return '0'
  if (limit !== null && BigInt(limit) > 0n) {
    if (bought === null)
      return '0'
    const left = BigInt(limit) > BigInt(bought) ? BigInt(limit) - BigInt(bought) : 0n
    max = max < left ? max : left
  }
  return max.toString()
}
export function allocateSale(stacks: any[], itemId: number, selected: string) {
  let left = BigInt(selected)
  const items: Array<{
    id: number
    uid: string
    count: string
  }> = []
  for (const stack of stacks.filter(row => Number(row.id) === itemId)) {
    const count = exactDecimal(stack.countDec ?? stack.count)
    const uid = exactDecimal(stack.uidDec ?? stack.uid ?? 0)
    if (count === null || uid === null || stack.locked === true)
      continue
    const take = left < BigInt(count) ? left : BigInt(count)
    if (take > 0n)
      items.push({ id: itemId, uid, count: take.toString() })
    left -= take
    if (left === 0n)
      break
  }
  if (left !== 0n)
    throw new Error('可出售库存已变化，请刷新')
  return items
}
export function newOperationId() {
  return globalThis.crypto?.randomUUID?.() || `operation_${Date.now()}_${Math.random().toString(36).slice(2)}`
}
