'use strict';
// Explicit historical reader: production activity discovery stays generic.
const shared = require('../../src/services/activity');
const legacy = require('../../src/services/milk-tea-activity');
async function getActivityGroupSnapshot(activityId, uid = '', options = {}) {
  let raw;
  const snapshot = await shared.getActivityGroupSnapshot(activityId, uid, {
    ...options,
    onRawBody(body) { raw = body; options.onRawBody?.(body); },
  });
  if (Number(activityId) === legacy.MILK_TEA_ROOT_ACTIVITY_ID) {
    legacy.normalizeMilkTeaDiscovery(snapshot, raw);
  }
  return snapshot;
}
module.exports = {
  ...shared, ...legacy, getActivityGroupSnapshot,
  getMilkTeaActivity: (options = {}) => legacy.getMilkTeaActivity({ getActivityGroupSnapshot, ...options }),
};
