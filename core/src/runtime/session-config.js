// Keep legacy dispatch pauses in business. Resident hosts may still use the
// older wire guard, so never send them the separate manual pause deadline.
function sessionPolicyConfig(config = {}) {
  const quiet = config.friendQuietHours;
  if (!quiet || typeof quiet !== 'object') return config;
  return { ...config, __dispatchPauseUntil: quiet.pauseUntil || '',
    friendQuietHours: { ...quiet, pauseUntil: '' } };
}
function businessPolicyConfig(config = {}) {
  if (!Object.hasOwn(config, '__dispatchPauseUntil')) return config;
  const result = { ...config, friendQuietHours: { ...config.friendQuietHours, pauseUntil: config.__dispatchPauseUntil } };
  delete result.__dispatchPauseUntil;
  return result;
}
module.exports = { sessionPolicyConfig, businessPolicyConfig };
