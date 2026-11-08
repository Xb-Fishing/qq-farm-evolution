// Compare published content, never account progress or claim state.
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  return value;
}
function items(rows) {
  return (rows || []).map(row => [String(row.id ?? row.itemId), String(row.count ?? row.itemCount)]).sort();
}
function solarCatalog(calendar) {
  return {
    events: (calendar.events || []).map(row => [row.id, row.name, row.description, row.startTime, row.endTime,
      row.question, row.options, items(row.rewards), items(row.questionRewards)]).sort((a, b) => a[0] - b[0]),
    seasons: (calendar.seasons || []).map(row => [row.id, row.name, row.totalCount, items(row.rewards)]).sort((a, b) => a[0] - b[0]),
    missingEvents: (calendar.missingEvents || []).map(row => [row.id, row.name, row.question, row.options]).sort((a, b) => a[0] - b[0]),
  };
}
function activityCatalog(groups) {
  const visit = row => {
    const details = row.details || {};
    const share = details.shareReward;
    return stable({
      id: row.id, parentId: row.parentId, title: row.title, type: row.type,
      startTime: row.startTime, endTime: row.endTime, payload: row.payload,
      share: share ? { dailyReward: share.dailyReward, firstShareReward: share.firstShareReward,
        milestones: (share.milestones || []).map(tier => [tier.id, tier.threshold, items(tier.rewards)]).sort((a, b) => a[0] - b[0]) } : null,
      fund: (details.growthFund?.tiers || []).map(tier => [tier.tierId, items(tier.reward)]).sort((a, b) => a[0] - b[0]),
      shop: (details.exchangeShop?.items || []).map(item => [item.id, item.name, items(item.rewards), items(item.costs), item.purchaseLimit]).sort((a, b) => a[0] - b[0]),
      children: (row.children || []).map(visit).sort((a, b) => a.id - b.id),
    });
  };
  return (groups || []).map(visit).sort((a, b) => a.id - b.id);
}
module.exports = { activityCatalog, solarCatalog };
