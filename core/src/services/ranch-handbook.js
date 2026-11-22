'use strict';

const { metadata } = require('./ranch-model');

const ACTIONS = new Set(['stockAnimals', 'collectProducts', 'gainRanchXp', 'growAlbum', 'finishBuildings', 'useCans']);
const SCHEMA = `
message RanchBookRequest { int32 rarity = 1; int32 type = 2; }
message RanchBookItem { int32 fruit_id = 1; bool unlocked = 3; }
message RanchBookReply { repeated RanchBookItem list = 1; int32 type = 6; }
`;
const ROUTES = Object.freeze({
  ranchBook: { service: 'gamepb.illustratedpb.IllustratedService', method: 'GetIllustratedListV2',
    request: 'RanchBookRequest', reply: 'RanchBookReply', writing: false },
});
const primaryProduct = new Map(metadata.animals.map(animal => [String(animal.id), animal.product_item?.id]));

function planStock(snapshot, max, reserve, album) {
  const present = new Set(snapshot.animals.map(animal => animal.animalId));
  for (const cub of snapshot.cubs) {
    if (cub.locked || (album && (present.has(cub.animalId) || album.get(primaryProduct.get(cub.animalId)) !== false))) continue;
    const room = snapshot.facilities.find(row => row.active && row.ranch?.husbandryType === cub.husbandryType
      && row.ranch.capacity > row.ranch.count && row.ranch.animals.length === row.ranch.count);
    if (!room) continue;
    const ready = snapshot.cubs.filter(row => row.id === cub.id && !row.locked)
      .reduce((total, row) => total + BigInt(row.count), 0n) - BigInt(reserve);
    if (ready <= 0n) continue;
    const count = Math.min(ready > 50n ? 50 : Number(ready), album ? 1 : max, room.ranch.capacity - room.ranch.count);
    return { action: 'place', input: { ranchId: room.id, itemId: cub.id, count }, preparing: Boolean(album) };
  }
  return null;
}

function choose(kind, snapshot, { max, reserve, book }) {
  if (kind === 'stockAnimals') return planStock(snapshot, max, reserve);
  if (kind === 'finishBuildings') {
    const room = snapshot.facilities.find(row => [6, 7].includes(row.moduleType) && row.upgrade?.canComplete);
    return room ? { action: 'completeUpgrade', input: { facilityId: room.id } } : null;
  }
  if (kind === 'growAlbum') {
    if (book?.type !== 101 || !Array.isArray(book.list) || !book.list.length
      || new Set(book.list.map(item => item.fruit_id)).size !== book.list.length) return null;
    const album = new Map(book.list.map(item => [item.fruit_id, item.unlocked]));
    const ready = snapshot.animals.find(animal => animal.canHarvest && album.get(primaryProduct.get(animal.animalId)) === false);
    return ready ? { action: 'harvest', input: { ranchId: ready.ranchId, animalId: ready.id } }
      : planStock(snapshot, max, reserve, album);
  }
  const shelfReady = snapshot.facilities.some(row => row.ranch?.shelves.some(shelf => shelf.canCollect));
  if (shelfReady || (kind === 'gainRanchXp' && snapshot.animals.some(animal => animal.canHarvest)))
    return { action: 'harvest', input: { all: true } };
  if (kind === 'gainRanchXp' && snapshot.tasks?.some(task => task.canClaim))
    return { action: 'claimTasks', input: { all: true } };
  const animal = snapshot.animals.find(row => row.canProduce);
  return animal ? { action: 'produce', input: { ranchId: animal.ranchId, animalId: animal.id }, preparing: true } : null;
}

module.exports = { ACTIONS, SCHEMA, ROUTES, choose };
