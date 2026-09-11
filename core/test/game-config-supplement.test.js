const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  getItemById,
  getItemImageById,
  getPlantNameBySeedId,
  getPlantBySeedId,
  getPlantByIdOrSeedId,
  isSeedItem,
  getPlantGrowPhases,
} = require('../src/config/gameConfig');
const { getBagSeedsFromItems } = require('../src/services/warehouse');

const activityPlants = [
  { asset: 'Crop_9003', seedId: 29003, fruitId: 49003, plantId: 1029003, mutantId: 1049003, name: '星语铃花' },
  { asset: 'Crop_1353', seedId: 21353, fruitId: 41353, plantId: 1021353, mutantId: 1041353, name: '粉樱花' },
  { asset: 'Crop_264', seedId: 20264, fruitId: 40264, plantId: 1020264, mutantId: 1040264, name: '红色郁金香' },
  { asset: 'Crop_1404', seedId: 21404, fruitId: 41404, plantId: 1021404, mutantId: 1041404, name: '白牵牛花' },
  { asset: 'Crop_108', seedId: 20108, fruitId: 40108, plantId: 1020108, mutantId: 1040108, name: '铃兰' },
  { asset: 'Crop_1037', seedId: 21037, fruitId: 41037, plantId: 1021037, mutantId: 1041037, name: '银星海棠' },
  { asset: 'Crop_6032', seedId: 26032, fruitId: 46032, plantId: 1060032, mutantId: 1046032, name: '金盏花' },
  { asset: 'Crop_1050', seedId: 21050, fruitId: 41050, plantId: 1021050, mutantId: 1041050, name: '卷丹百合' },
  { asset: 'Crop_1251', seedId: 21251, fruitId: 41251, plantId: 1021251, mutantId: 1041251, name: '紫玫瑰' },
  { asset: 'Crop_1380', seedId: 21380, fruitId: 41380, plantId: 1021380, mutantId: 1041380, name: '米兰花' },
  { asset: 'Crop_129', seedId: 20129, fruitId: 40129, plantId: 1020129, mutantId: 1040129, name: '勿忘我' },
  { asset: 'Crop_375', seedId: 20375, fruitId: 40375, plantId: 1020375, mutantId: 1040375, name: '木槿' },
];

function assertImageExists(itemId, label) {
  const imageUrl = getItemImageById(itemId);
  assert.match(imageUrl, /^\/game-config\/seed_images_named\/.+\.png$/, label);
  const relativePath = decodeURIComponent(imageUrl.replace('/game-config/', ''));
  assert.equal(
    fs.existsSync(path.join(__dirname, '..', 'src', 'gameConfig', relativePath)),
    true,
    `${label} file`,
  );
}

test('supplemental source mappings resolve names and official images', () => {
  const expected = new Map([
    [20207, '绣球花种子'],
    [40207, '绣球花'],
    [20329, '发财红包种子'],
    [40329, '发财红包'],
    [1040265, '黄金·朱雀花'],
    [1041037, '黄金·银星海棠'],
    [1041050, '黄金·卷丹百合'],
    [1046032, '黄金·金盏花'],
    [1041353, '黄金·粉樱花'],
    [1049003, '黄金·星语铃花'],
    [301102, '足球'],
    [204003, '黄金·哈哈南瓜塔'],
    [204006, '星语花铃'],
    [204007, '黄金·星语花铃'],
  ]);

  for (const [itemId, name] of expected) {
    assert.equal(getItemById(itemId)?.name, name);
    assert.match(getItemImageById(itemId), /^\/game-config\/seed_images_named\/.+\.png$/);
  }
});

test('star bell flower is configured as a 2x2 crop', () => {
  assert.equal(getPlantBySeedId(29003)?.size, 2);
});

test('charity red flower maps the observed plant to its activity seed as a single-grid crop', () => {
  const plant = getPlantBySeedId(20883);
  assert.deepEqual({
    id: plant?.id,
    seedId: plant?.seed_id,
    fruitId: plant?.fruit?.id,
    name: plant?.name,
    size: plant?.size,
  }, {
    id: 1020883,
    seedId: 20883,
    fruitId: 40883,
    name: '小红花',
    size: 1,
  });
  assert.equal(getItemById(20883)?.name, '小红花种子');
  assert.equal(getItemById(40883)?.name, '小红花');
});

test('活动商城明确标为种子的道具进入背包优先种子索引', () => {
  assert.equal(isSeedItem(20522), true);
  assert.equal(isSeedItem(20523), true);
  assert.equal(getItemById(20522)?.name, '金币果种子');
  assert.equal(getItemById(20523)?.name, '经验蘑菇种子');
  assert.equal(getPlantNameBySeedId(20522), '金币果');
});

test('S3 萌宠活动种子在未建立 Plant 映射时仍进入背包优先索引', () => {
  const seeds = getBagSeedsFromItems([
    { id: 29004, count: 3 },
    { id: 20516, count: 56 },
    { id: 80001, count: 2 },
  ]);
  assert.deepEqual(seeds.map(item => [item.seedId, item.name, item.count, item.plantSize]), [
    [29004, '萌宠元气糕种子', 3, 1],
  ]);
  assert.match(seeds[0].image, /plant_images\/common\/seed\.png$/);
  assert.equal(getItemById(20516)?.name, '萌宠元气糕');
  assert.match(getItemImageById(20516), /10001_.+harvest/);
});

test('S3 商城已知商品均有仓库内可加载的图标回退', () => {
  for (const itemId of [1029, 201010, 207010, 205009, 202009, 206009, 203010, 208010, 2161, 401005, 20522, 20523]) {
    const image = getItemImageById(itemId);
    assert.match(image, /^\/(?:game-config|activity)\//, `item ${itemId} image URL`);
    const relative = decodeURIComponent(image.replace('/game-config/', ''));
    const file = image.startsWith('/game-config/')
      ? path.join(__dirname, '..', 'src', 'gameConfig', relative)
      : path.join(__dirname, '..', '..', 'web', 'public', image.replace('/activity/', 'activity/'));
    assert.equal(fs.existsSync(file), true, `item ${itemId} image file`);
  }
});

test('土地回包使用 seed id 时通过同一映射得到活动植物配置', () => {
  assert.equal(getPlantByIdOrSeedId(29003)?.id, 1029003);
  assert.equal(getPlantByIdOrSeedId(29003)?.seed_id, 29003);
});

test('qixi activity items resolve official static icons', () => {
  const expected = new Map([
    [1024, '/activity/qixi/qixi-feather.png'],
    [301103, '/activity/qixi/qixi-dew.png'],
  ]);

  for (const [itemId, imageUrl] of expected) {
    assert.equal(getItemImageById(itemId), imageUrl);
    assert.equal(
      fs.existsSync(path.join(__dirname, '..', '..', 'web', 'public', imageUrl)),
      true,
      `${getItemById(itemId)?.name} image file`,
    );
  }
});

test('recent bag items resolve official names and icons', () => {
  const expected = new Map([
    [1026, '鹊羽香囊'],
    [101304, '千星游记礼包'],
  ]);

  for (const [itemId, name] of expected) {
    assert.equal(getItemById(itemId)?.name, name);
    assertImageExists(itemId, `${name} image`);
  }
});

test('activity supplements preserve growth phases from the base plant config', () => {
  const baseBackedActivitySeeds = [
    21353, 20264, 21404, 20108, 21050, 21251, 21380, 20129, 20375, 20329
  ];
  for (const seedId of baseBackedActivitySeeds) {
    const plant = getPlantBySeedId(seedId);
    assert.ok(getPlantGrowPhases(plant.id).length > 0, `${plant.name} growth phases`);
  }
});

test('decoration fruits in the mutant illustrated have complete images', () => {
  assertImageExists(204003, 'golden pumpkin tower image');
  assertImageExists(204004, 'moon lotus tower image');
  assertImageExists(204005, 'golden moon lotus tower image');
  assertImageExists(204006, 'star bell tower image');
  assertImageExists(204007, 'golden star bell tower image');
});

test('current activity plants cover crop and mutant illustrated mappings', () => {
  for (const plant of activityPlants) {
    const seed = getItemById(plant.seedId);
    const fruit = getItemById(plant.fruitId);
    const mutant = getItemById(plant.mutantId);
    const plantConfig = getPlantBySeedId(plant.seedId);

    assert.equal(seed?.name, `${plant.name}种子`, `${plant.asset} seed name`);
    assert.equal(seed?.asset_name, plant.asset, `${plant.asset} seed asset`);
    assert.equal(fruit?.name, plant.name, `${plant.asset} fruit name`);
    assert.equal(fruit?.asset_name, plant.asset, `${plant.asset} fruit asset`);
    assert.equal(plantConfig?.id, plant.plantId, `${plant.asset} plant mapping`);
    assert.equal(plantConfig?.fruit?.id, plant.fruitId, `${plant.asset} fruit mapping`);
    assert.equal(mutant?.name, `黄金·${plant.name}`, `${plant.asset} mutant name`);

    assertImageExists(plant.seedId, `${plant.asset} seed image`);
    assertImageExists(plant.fruitId, `${plant.asset} fruit image`);
    assertImageExists(plant.mutantId, `${plant.asset} mutant image`);
  }
});
