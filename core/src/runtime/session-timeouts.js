const BUSINESS_DRAIN_TIMEOUT_MS = 180000;
const BUSINESS_CONTROL_TIMEOUT_MS = 185000;
const BUSINESS_BOOT_TIMEOUT_MS = 30000;
// Drain, prepare and activate have separate bounded control calls. Allow a
// Worker boot and local validation/settlement without racing those deadlines.
const SESSION_ATTACH_TIMEOUT_MS = 3 * BUSINESS_CONTROL_TIMEOUT_MS + BUSINESS_BOOT_TIMEOUT_MS + 30000;
const sessionReadyTimeoutMs = accountCount => SESSION_ATTACH_TIMEOUT_MS
  * Math.max(1, Math.floor(Number(accountCount) || 0)) + 60000;
module.exports = { BUSINESS_DRAIN_TIMEOUT_MS, BUSINESS_CONTROL_TIMEOUT_MS, BUSINESS_BOOT_TIMEOUT_MS,
  SESSION_ATTACH_TIMEOUT_MS, sessionReadyTimeoutMs };
