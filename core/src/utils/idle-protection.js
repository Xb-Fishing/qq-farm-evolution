// Per-worker, transient idle pause. Never persist it as the owner's manual pauseUntil.
let idleProtectionUntil = 0;

function setIdleProtectionUntil(until) {
  idleProtectionUntil = Math.max(0, Number(until) || 0);
}

function getIdleProtectionUntil(now = Date.now()) {
  if (idleProtectionUntil <= now) idleProtectionUntil = 0;
  return idleProtectionUntil;
}

function planIdleProtection({ enabled, now, farmAt, helpAt, ownDueAt, stealDueAt,
  horizonMs, activeMs }) {
  if (enabled !== true || (horizonMs > 0 && horizonMs <= activeMs)) return 0;
  if ((ownDueAt > 0 && ownDueAt <= now) || (stealDueAt > 0 && stealDueAt <= now)) return 0;
  // Ordinary patrols must both have finished; summary refresh floors and independent
  // watchlist polling do not shorten this explicit idle pause. Known maturity does.
  let until = Math.min(Number(farmAt) || now, Number(helpAt) || now);
  if (ownDueAt > now) until = Math.min(until, ownDueAt - 10_000);
  if (stealDueAt > now) until = Math.min(until, stealDueAt - 1500);
  return until - now >= 60_000 ? until : 0;
}

module.exports = { setIdleProtectionUntil, getIdleProtectionUntil, planIdleProtection };
