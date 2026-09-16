const test = require('node:test');
const assert = require('node:assert/strict');

const {
  getMutantDisplayPlantId,
  getKnownPlantName,
  getMutantEffectsByIds,
  getPlantBySeedId,
  getPlantByFruitId,
  getPlantByIdOrSeedId,
  getItemById,
  isSeedItem,
} = require('../src/config/gameConfig');

// S3 萌宠（2026090100）作物变异显示闭环回归。
// 证据链：client-config-evidence Plant 快照的 mutant_effect_plant 映射 +
// ItemInfo 快照名称 + MutantEffect 15/16（比熊/乐园）与活动说明交叉核对。

test('bubble candy resolves the leyuan mutation variant plant by name', () => {
  const displayId = getMutantDisplayPlantId(1029004, [16]);
  assert.equal(displayId, 1028004);
  assert.equal(getKnownPlantName(displayId), '比熊棉花糖');
});

test('bubble candy resolves the golden mutation variant plant by name', () => {
  const displayId = getMutantDisplayPlantId(1029004, [5]);
  assert.equal(displayId, 1129004);
  assert.equal(getKnownPlantName(displayId), '黄金·泡泡棉花糖');
});

test('combined golden + leyuan mutation wins over single-effect mappings', () => {
  const displayId = getMutantDisplayPlantId(1029004, [5, 16]);
  assert.equal(displayId, 1128004);
  assert.equal(getKnownPlantName(displayId), '黄金·比熊棉花糖');
});

test('foxtail and reed resolve their golden variant plants', () => {
  assert.equal(getKnownPlantName(getMutantDisplayPlantId(1020516, [5])), '黄金·狗尾草');
  assert.equal(getKnownPlantName(getMutantDisplayPlantId(1025995, [5])), '黄金·芦苇');
});

test('bichon is a price mutation and keeps the base plant display id', () => {
  // 快照 Plant 表没有任何 mutant_effect_plant 引用效果 15；比熊变异只改售价，
  // 展示仍为原作物，名称与效果标签由 mutantEffects 承载。
  assert.equal(getMutantDisplayPlantId(1020516, [15]), 1020516);
  assert.equal(getMutantDisplayPlantId(1029004, [15]), 1029004);
});

test('mutant effects 15 and 16 expose display names and descriptions', () => {
  const [bichon] = getMutantEffectsByIds([15]);
  assert.equal(bichon.name, '比熊');
  assert.match(bichon.description, /售价\*4倍/);
  assert.equal(bichon.tips, '比熊犬处于看护状态时概率触发');

  const [leyuan] = getMutantEffectsByIds([16]);
  assert.equal(leyuan.name, '乐园');
  assert.equal(leyuan.fruit_name, '比熊棉花糖');
  assert.equal(leyuan.tips, '种植泡泡棉花糖有概率出现');
});

test('mutation variant plants do not pollute seed and item indexes', () => {
  // 变体植物 seed_id 为空：不得写入 seedToPlant(0)，也不得合成 id=0 的物品。
  assert.equal(getPlantBySeedId(0), undefined);
  assert.equal(getItemById(0), undefined);
});

test('leyuan mutation fruits are registered as known non-seed items', () => {
  const candy = getItemById(204008);
  assert.equal(candy.name, '比熊棉花糖');
  assert.equal(candy.type, 18);
  assert.equal(isSeedItem(204008), false);

  const goldenCandy = getItemById(204009);
  assert.equal(goldenCandy.name, '黄金·比熊棉花糖');
  assert.equal(goldenCandy.type, 18);

  assert.equal(getPlantByFruitId(204008).name, '比熊棉花糖');
  assert.equal(getPlantByFruitId(1040516).name, '黄金·狗尾草');
});

test('base S3 seed mappings keep their registered size and names', () => {
  assert.equal(getPlantBySeedId(20516).name, '狗尾草');
  assert.equal(getPlantBySeedId(25995).name, '芦苇');
  assert.equal(getPlantBySeedId(29004).size, 2);
});

test('land analyzer resolution chain shows the mutation variant name (plant id回包)', () => {
  // 复刻 farm-land-analyzer/friend-land-analyzer 的展示解析链：
  // plantConfig → plantId → displayPlantId → displayName
  const rawPlantId = 1029004;
  const mutantConfigIds = [16];
  const plantConfig = getPlantByIdOrSeedId(rawPlantId);
  const plantId = Number(plantConfig?.id) || rawPlantId;
  const displayPlantId = getMutantDisplayPlantId(plantId, mutantConfigIds);
  const displayName = getKnownPlantName(displayPlantId)
    || getKnownPlantName(plantId);
  assert.equal(displayName, '比熊棉花糖');
  assert.equal(getMutantEffectsByIds(mutantConfigIds)[0].name, '乐园');
});

test('land analyzer resolution chain accepts the seed id回包 and still resolves the golden variant', () => {
  const rawPlantId = 29004;
  const mutantConfigIds = [5];
  const plantConfig = getPlantByIdOrSeedId(rawPlantId);
  const plantId = Number(plantConfig?.id) || rawPlantId;
  const displayPlantId = getMutantDisplayPlantId(plantId, mutantConfigIds);
  const displayName = getKnownPlantName(displayPlantId)
    || getKnownPlantName(plantId);
  assert.equal(displayName, '黄金·泡泡棉花糖');
  assert.equal(plantId, 1029004);
});
