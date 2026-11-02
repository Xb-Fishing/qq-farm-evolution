const catalog = require('../gameConfig/UpdateCatalog.json');
const { getItemImageById, getSeedImageBySeedId } = require('../config/gameConfig');
// Static configuration only; ownership and activated stars require fresh official state.
function getUpdateCatalog() {
  const value = structuredClone(catalog);
  for (const group of value.series) for (const item of group.items) item.image = getItemImageById(item.id) || '';
  for (const crop of value.crops) {
    crop.seedImage = getSeedImageBySeedId(crop.seedId) || '';
    crop.fruitImage = getItemImageById(crop.fruitId) || '';
  }
  return value;
}
module.exports = { getUpdateCatalog };
