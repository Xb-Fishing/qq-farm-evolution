'use strict';
const positive = (value, fallback) => (typeof value === 'number' || (typeof value === 'string' && /^\d+$/.test(value))) && Number.isSafeInteger(Number(value)) && Number(value) > 0 && Number(value) <= 10000 ? Number(value) : fallback;
const DEFAULT_REQUEST_POLICY = Object.freeze({ enabled: true,
  total60s: positive(process.env.FARM_REQUEST_LIMIT_60S, 80),
  friend60s: positive(process.env.FARM_REQUEST_LIMIT_60S, 80),
  method60s: positive(process.env.FARM_REQUEST_METHOD_LIMIT_60S, 30) });
function normalizeRequestPolicy(value = {}, fallback = DEFAULT_REQUEST_POLICY) {
  const raw = value && typeof value === 'object' ? value : {};
  return { enabled: typeof raw.enabled === 'boolean' ? raw.enabled : fallback.enabled,
    ...Object.fromEntries(['total60s', 'friend60s', 'method60s'].map(key => [key, positive(raw[key], fallback[key])])) };
}
function validateRequestPolicy(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.enabled !== 'boolean'
    || ['total60s', 'friend60s', 'method60s'].some(key => !Number.isSafeInteger(value[key]) || value[key] < 1 || value[key] > 10000))
    throw Object.assign(new Error('请求预算必须是 1–10000 的整数，限流开关必须明确开启或关闭'), { code: 'REQUEST_POLICY_INVALID', statusCode: 400 });
  return normalizeRequestPolicy(value);
}
module.exports = { DEFAULT_REQUEST_POLICY, normalizeRequestPolicy, validateRequestPolicy };
