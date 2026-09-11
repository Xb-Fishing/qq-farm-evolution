const config = require('../config/gameConfig');

/** 可直接进入每日活动报告；只含物品 ID/缺口类别，不含账号、数量或原始正文。 */
function auditBagSeedCoverage(items, seeds, lookup = config) {
  const seedIds = new Set((seeds || []).map(seed => Number(seed.seedId)));
  const issues = [];
  const seen = new Set();
  for (const item of items || []) {
    const id = Number(item.id);
    if (!Number.isSafeInteger(id) || id <= 0 || Number(item.count) <= 0 || seen.has(id)) continue;
    seen.add(id);
    const info = lookup.getItemById(id);
    const plant = lookup.getPlantBySeedId(id);
    const add = kind => issues.push({ itemId: id, kind });
    if (!info && !plant) add('unclassified_item');
    if (plant && info && Number(info.type) !== 5) add('seed_type_conflict');
    if (plant && info && info.name !== `${plant.name}种子`) add('seed_name_conflict');
    if ((plant || lookup.isSeedItem(id)) && !seedIds.has(id)) add('seed_missing_from_priority');
    if (seedIds.has(id) && !plant) add('seed_footprint_unverified');
    if (seedIds.has(id) && !lookup.getSeedImageBySeedId(id)) add('seed_icon_missing');
  }
  issues.sort((a, b) => a.itemId - b.itemId || a.kind.localeCompare(b.kind));
  return { available: true, inspectedKinds: seen.size, issues };
}

/** 对照经审阅的客户端 ItemInfo + Plant 快照，检查已命名但被分错类的物品。 */
function compareClientSeedCatalog(items, plants, lookup = config) {
  const bySeed = new Map(plants.filter(plant => plant.seed_id > 0).map(plant => [Number(plant.seed_id), plant]));
  return items.filter(item => Number(item.type) === 5).flatMap(item => {
    const id = Number(item.id);
    const currentItem = lookup.getItemById(id);
    const currentPlant = lookup.getPlantBySeedId(id);
    const sourcePlant = bySeed.get(id);
    const differences = [];
    if (!lookup.isSeedItem(id)) differences.push('seed_missing');
    if (currentItem?.name !== item.name) differences.push('name');
    if (sourcePlant) {
      if (currentPlant?.id !== sourcePlant.id) differences.push('plant_id');
      if (currentPlant?.fruit?.id !== sourcePlant.fruit?.id) differences.push('fruit_id');
      if (Number(currentPlant?.size || 0) !== Number(sourcePlant.size || 1)) differences.push('size');
      if (Number(currentPlant?.land_level_need || 0) !== Number(sourcePlant.land_level_need || 0)) differences.push('land_level_need');
    } else differences.push('source_plant_missing');
    return differences.length ? [{ itemId: id, differences }] : [];
  });
}

module.exports = { auditBagSeedCoverage, compareClientSeedCatalog };
