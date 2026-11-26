const { getAllLands, harvest } = require('./farm-api');
const { analyzeLands, invalidatePanelLandsCache } = require('./farm-land-analyzer');
const { plantSeeds, isReserved2x2Land } = require('./planting-service');
const { isActive: ownHarvestActive } = require('./own-quiet-priority');
const { getPrioritize2x2Crops } = require('../models/store');
const { getBag, getBagItems, invalidatePanelBagCache } = require('./warehouse');

const SEED_ID = 20307;
const CROP_IDS = new Set([1020307, 1120307]);
const HARVEST_ITEMS = new Set([40307, 1040307, 1032]);

function hasSweetPotato(land) {
  return CROP_IDS.has(Number(land?.plant?.id));
}

function readPlots(lands) {
  const farm = analyzeLands(lands);
  const prioritizeLarge = getPrioritize2x2Crops();
  const empty = farm.empty.filter(id => !prioritizeLarge || !isReserved2x2Land(id));
  const ownedCrop = new Set(lands.filter(hasSweetPotato).map(row => Number(row.id)));
  return { empty, ready: farm.harvestable.filter(id => ownedCrop.has(id)), planted: [...ownedCrop] };
}

async function getSweetPotatoPlots(checkConnection) {
  checkConnection();
  const { lands } = await getAllLands();
  checkConnection();
  if (!Array.isArray(lands)) throw new Error('未收到当前土地数据，请刷新');
  return readPlots(lands);
}

function checkFarmWindow(checkConnection) {
  checkConnection();
  if (ownHarvestActive()) throw new Error('农场正在优先收获，请稍后操作');
  if (require('./activity').sweetPotatoOutsideWindow()) throw new Error('以薯换福活动已结束或尚未开放');
}

async function performSweetPotatoPlotAction(action, landId, checkConnection, onDispatch = () => {}) {
  if (!Number.isSafeInteger(landId) || landId <= 0) throw new Error('请选择有效的土地');
  checkFarmWindow(checkConnection);
  if (action === 'plantCrop') {
    const inventory = getBagItems(await getBag());
    if (!inventory.some(row => Number(row.id) === SEED_ID && Number(row.count) > 0))
      throw new Error('背包中没有红薯种子，请先领取');
  }
  const plots = await getSweetPotatoPlots(checkConnection);
  const allowed = action === 'plantCrop' ? plots.empty : plots.ready;
  if (!allowed.includes(landId)) throw new Error('土地状态已变化，请重新选择');
  checkFarmWindow(checkConnection);
  try {
    onDispatch();
    if (action === 'plantCrop') {
      const planted = await plantSeeds(SEED_ID, [landId], { maxPlantCount: 1, stopOnError: true });
      checkConnection();
      if (planted.planted !== 1) throw new Error('红薯种植未确认，请刷新土地核对');
      const { lands } = await getAllLands();
      checkConnection();
      if (!lands?.some(row => Number(row.id) === landId && hasSweetPotato(row))) {
        throw new Error('红薯种植回执待核对，请刷新土地');
      }
      return { landId, planted: true };
    }
    const result = await harvest([landId], { all: false });
    checkConnection();
    const items = (result.items || []).map(row => ({ id: Number(row.id), count: Number(row.count) }))
      .filter(row => HARVEST_ITEMS.has(row.id) && Number.isSafeInteger(row.count) && row.count > 0);
    if (!items.length) throw new Error('红薯收获回执待核对，请刷新背包和土地');
    return { landId, items, potatoes: items.filter(row => row.id === 1032).reduce((sum, row) => sum + row.count, 0) };
  } finally {
    invalidatePanelBagCache();
    invalidatePanelLandsCache();
  }
}

module.exports = { getSweetPotatoPlots, performSweetPotatoPlotAction };
