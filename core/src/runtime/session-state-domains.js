// Explicit state domain manifest; no gameplay is started by this loader.
const BUSINESS_DOMAINS = [
  "utils/behavior.js",
  "services/email.js",
  "services/daily-events.js",
  "services/warehouse.js",
  "services/farm-land-analyzer.js",
  "services/planting-service.js",
  "services/farming-orchestrator.js",
  "services/mall.js",
  "services/friend-activity.js",
  "services/friend-api.js",
  "services/interact.js",
  "services/governed-warn-aggregation.js",
  "services/friend-self-echo.js",
  "services/friend-operation-limits.js",
  "services/friend-land-analyzer.js",
  "services/fertilizer-watch.js",
  "services/friend-visit.js",
  "services/friend-orchestrator.js",
  "services/friend-auto-bad.js",
  "services/friend-auto-bad-quota.js",
  "services/golden-bug-service.js",
  "services/monthcard.js",
  "services/qqvip.js",
  "services/daily-routine-state.js",
  "services/share.js",
  "services/task.js",
  "services/mystery-shop.js",
  "services/dog-skill-gifts.js",
  "services/activity.js",
  "services/milk-tea-activity.js",
  "services/official-announcements.js",
  "services/farm-scheduler.js"
];
function loadBusinessDomains() {
  for (const file of BUSINESS_DOMAINS) require(`../${  file}`);
}
module.exports = { BUSINESS_DOMAINS, loadBusinessDomains };
