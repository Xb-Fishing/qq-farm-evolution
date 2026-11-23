'use strict';
const MAX_REQUEST_BUDGET = 10000;
const DEFAULT_ROSTER_BONUS_PER_100 = 20;
const positive = (value, fallback) => (typeof value === 'number' || (typeof value === 'string' && /^\d+$/.test(value))) && Number.isSafeInteger(Number(value)) && Number(value) > 0 && Number(value) <= MAX_REQUEST_BUDGET ? Number(value) : fallback;
const DEFAULT_REQUEST_POLICY = Object.freeze({ enabled: true,
  total60s: positive(process.env.FARM_REQUEST_LIMIT_60S, 80),
  friend60s: positive(process.env.FARM_REQUEST_LIMIT_60S, 80),
  method60s: positive(process.env.FARM_REQUEST_METHOD_LIMIT_60S, 30),
  rosterBonusPer100: DEFAULT_ROSTER_BONUS_PER_100 });
function normalizeRequestPolicy(value = {}, fallback = DEFAULT_REQUEST_POLICY) {
  const raw = value && typeof value === 'object' ? value : {};
  return { enabled: typeof raw.enabled === 'boolean' ? raw.enabled : fallback.enabled,
    rosterBonusPer100: raw.rosterBonusPer100 === 0 || raw.rosterBonusPer100 === '0' ? 0
      : positive(raw.rosterBonusPer100, fallback.rosterBonusPer100 ?? DEFAULT_ROSTER_BONUS_PER_100),
    ...Object.fromEntries(['total60s', 'friend60s', 'method60s'].map(key => [key, positive(raw[key], fallback[key])])) };
}
function validateRequestPolicy(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.enabled !== 'boolean'
    || ['total60s', 'friend60s', 'method60s'].some(key => !Number.isSafeInteger(value[key]) || value[key] < 1 || value[key] > MAX_REQUEST_BUDGET))
    throw Object.assign(new Error('请求预算必须是 1–10000 的整数，限流开关必须明确开启或关闭'), { code: 'REQUEST_POLICY_INVALID', statusCode: 400 });
  if (Object.hasOwn(value, 'rosterBonusPer100') && (!Number.isSafeInteger(value.rosterBonusPer100)
    || value.rosterBonusPer100 < 0 || value.rosterBonusPer100 > MAX_REQUEST_BUDGET))
    throw Object.assign(new Error('每 100 位好友新增的请求额度必须是 0–10000 的整数'), { code: 'REQUEST_POLICY_INVALID', statusCode: 400 });
  return normalizeRequestPolicy(value);
}
function totalBudgetForRoster({ total60s, rosterBonusPer100 }, rosterSize) {
  return Math.min(MAX_REQUEST_BUDGET, total60s + Math.floor(rosterSize * rosterBonusPer100 / 100));
}
module.exports = { DEFAULT_REQUEST_POLICY, normalizeRequestPolicy, validateRequestPolicy, totalBudgetForRoster };
