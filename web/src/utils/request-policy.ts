export interface RequestPolicy {
  enabled: boolean
  total60s: number
  friend60s: number
  method60s: number
  rosterBonusPer100: number
}

export const defaultRequestPolicy = (): RequestPolicy => ({
  enabled: true, total60s: 80, friend60s: 80, method60s: 30, rosterBonusPer100: 20,
})
