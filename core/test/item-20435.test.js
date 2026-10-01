const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// 隔离必须在引入业务模块之前：独立数据目录 + 本用例专属 private-config 路径。
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-farm-item-20435-'));
process.env.FARM_DATA_DIR = dataDir;
const privateConfigPath = path.join(dataDir, 'private-config.json');
fs.writeFileSync(privateConfigPath, '{}\n', { mode: 0o600 });
process.env.FARM_PRIVATE_CONFIG_FILE = privateConfigPath;

const {
  getGenericFallbackItemIds,
  getItemById,
  getItemImageById,
  getPlantByIdOrSeedId,
  getPlantByFruitId,
  getPlantBySeedId,
  getSeedImageBySeedId,
  isSeedItem,
} = require('../src/config/gameConfig');
const { auditBagSeedCoverage } = require('../src/services/seed-catalog-audit');

function mockModule(filename, exports) {
  return { id: filename, filename, loaded: true, exports };
}

const GAME_CONFIG_DIR = path.join(__dirname, '../src/gameConfig');
const SHA_CROP_435 = '40a37caa1e73c186b9085515fd35021784af7eea98423bd4ef2046d08216f291';
const SHA_GOLD_CROP_435 = '20d19f25b0edfa47ba90e3b854478337ac5bf4bf7e949bb9b5c6b1bd4c9e7385';

test.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

test('山丹丹 20435 家族按官方提取配置登记：种子 type 5、果实合成命名、黄金 type 17', () => {
  // 名称/type/asset 逐字来自公开参考系提取快照（public-reference-3@864caf33），
  // 并与本机实测交叉：Bag 出现 20435、偷取服务端命名 山丹丹/黄金·山丹丹 地块
  // 分别到手 40435/1040435（2026-10-01 六轮/四好友）。
  assert.equal(getItemById(20435)?.name, '山丹丹种子');
  assert.equal(Number(getItemById(20435)?.type), 5);
  assert.equal(getItemById(20435)?.interaction_type, 'plant');
  assert.equal(getItemById(20435)?.asset_name, 'Crop_435');
  assert.equal(isSeedItem(20435), true);
  // 果实由 EventPlants 合成条目命名（同枸杞/月下美人惯例，不进 EventItems）
  assert.equal(getItemById(40435)?.name, '山丹丹');
  assert.equal(isSeedItem(40435), false);
  // 黄金变体（官方提取 ItemInfo type 17、gold/Crop_435、sells 1005:6）
  assert.equal(getItemById(1040435)?.name, '黄金·山丹丹');
  assert.equal(Number(getItemById(1040435)?.type), 17);
  assert.equal(isSeedItem(1040435), false);
});

test('seed→plant→fruit 双向映射与占地（官方 Plant 1020435/1120435 逐字段）', () => {
  const plant = getPlantBySeedId(20435);
  assert.equal(plant?.id, 1020435);
  assert.equal(plant?.name, '山丹丹');
  // 官方快照 size=null；按客户端默认规则+月下美人(1026030)同族先例登记 1x1。
  // 若后续官方快照声明 size:2，compareClientSeedCatalog 的 size 差异比对会暴露漂移。
  assert.equal(plant?.size, 1);
  assert.deepEqual(plant?.fruit, { id: 40435, count: 48 });
  assert.equal(plant?.mutant_effect_plant, '5:1120435:1');
  assert.equal(plant?.land_level_need, 1);
  assert.equal(plant?.seasons, 1);
  // 黄金展示植物：seed_id 为空（合并时 Number(null)=0），不进种子索引，只挂果实
  const golden = getPlantByIdOrSeedId(1120435);
  assert.equal(golden?.name, '黄金·山丹丹');
  assert.deepEqual(golden?.fruit, { id: 1040435, count: 10 });
  assert.equal(Number(golden?.seed_id), 0);
  assert.equal(getPlantBySeedId(0), undefined, '变异展示植物不得污染种子索引');
  // fruit→plant 反向索引
  assert.equal(getPlantByFruitId(40435)?.id, 1020435);
  assert.equal(getPlantByFruitId(1040435)?.id, 1120435);
});

test('背包识别：20435 进种子列表，果实分类正确，三者均不再报 unknown', () => {
  const utilsPath = require.resolve('../src/utils/utils');
  const warehousePath = require.resolve('../src/services/warehouse');
  const inboxPath = require.resolve('../src/services/evolution-issue-inbox');
  const previousUtils = require.cache[utilsPath];
  const previousWarehouse = require.cache[warehousePath];
  const previousInbox = require.cache[inboxPath];
  const logs = [];
  const recorded = [];
  const utilsMod = require('../src/utils/utils');
  require.cache[utilsPath] = mockModule(utilsPath, {
    ...utilsMod,
    log: (tag, message, meta) => logs.push({ message, meta }),
    logWarn: () => {},
  });
  require.cache[inboxPath] = mockModule(inboxPath, {
    recordRuntimeIssue: (type, level) => {
      recorded.push({ type, level });
      return true;
    },
  });
  delete require.cache[warehousePath];
  try {
    const { getBagSeedsFromItems: getSeeds } = require('../src/services/warehouse');
    const bag = [
      { id: 20435, count: 1 },
      { id: 40435, count: 737 },
      { id: 1040435, count: 7 },
      { id: 21625, count: 4 },
    ];
    const seeds = getSeeds(bag);
    assert.deepEqual(seeds.map(seed => [seed.seedId, seed.name]), [
      [20435, '山丹丹种子'],
      [21625, '枸杞种子'],
    ]);
    assert.equal(seeds[0].plantSize, 1);
    assert.equal(seeds[0].mappingStatus, 'mapped');
    assert.match(seeds[0].image, /20435_Crop_435_Seed\.png$/);
    assert.equal(logs.filter(l => l.meta && l.meta.event === 'bag_unclassified_item').length, 0,
      '已登记家族不得再报 unknown');
    assert.equal(recorded.length, 0);
    // 未登记的新未知 ID 仍必须如实上报（回归保留）
    getSeeds([...bag, { id: 4299991, count: 1 }]);
    const reported = logs.filter(l => l.meta && l.meta.event === 'bag_unclassified_item');
    assert.equal(reported.length, 1);
    assert.deepEqual(reported[0].meta.unclassifiedItemIds, [4299991]);
    assert.deepEqual(recorded, [{ type: 'bag_unclassified', level: 'warn' }]);
    // 审计消费同一输入：山丹丹家族零缺口（含 seed_icon_missing）
    const audit = auditBagSeedCoverage(bag, getSeeds(bag));
    assert.equal(audit.issues.filter(i => [20435, 40435, 1040435].includes(i.itemId)).length, 0);
  } finally {
    delete require.cache[warehousePath];
    if (previousUtils === undefined) delete require.cache[utilsPath];
    else require.cache[utilsPath] = previousUtils;
    if (previousInbox === undefined) delete require.cache[inboxPath];
    else require.cache[inboxPath] = previousInbox;
    if (previousWarehouse !== undefined) require.cache[warehousePath] = previousWarehouse;
  }
});

test('官方专属图：三个 ID 都命中本地文件，sha256 与清单逐条一致（100x100 PNG）', () => {
  assert.match(getSeedImageBySeedId(20435) || '', /20435_Crop_435_Seed\.png$/);
  assert.match(getSeedImageBySeedId(40435) || '', /40435_Crop_435_Seed\.png$/);
  assert.match(getSeedImageBySeedId(1040435) || getItemImageById(1040435), /1040435_gold_Crop_435_Seed\.png$/);
  // 完整物品图链路（含 asset_name/果实→植物→种子回退）也必须命中各自专属文件
  assert.match(getItemImageById(20435), /20435_Crop_435_Seed\.png$/);
  assert.match(getItemImageById(40435), /40435_Crop_435_Seed\.png$/);
  assert.match(getItemImageById(1040435), /1040435_gold_Crop_435_Seed\.png$/);
  const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const dims = file => {
    const b = fs.readFileSync(file);
    assert.equal(b.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'PNG signature');
    return [b.readUInt32BE(16), b.readUInt32BE(20)];
  };
  const imgDir = path.join(GAME_CONFIG_DIR, 'seed_images_named');
  const seedFile = path.join(imgDir, '20435_Crop_435_Seed.png');
  const fruitFile = path.join(imgDir, '40435_Crop_435_Seed.png');
  const goldFile = path.join(imgDir, '1040435_gold_Crop_435_Seed.png');
  assert.equal(sha(seedFile), SHA_CROP_435);
  assert.equal(sha(fruitFile), SHA_CROP_435);
  assert.equal(sha(goldFile), SHA_GOLD_CROP_435);
  for (const f of [seedFile, fruitFile, goldFile]) assert.deepEqual(dims(f), [100, 100]);
  // 清单逐条核对：activityEntries 新行的 id/file/sha256 必须与实际文件一致
  const manifest = JSON.parse(fs.readFileSync(path.join(imgDir, 'event-seed-sources.json'), 'utf8'));
  const expected = [
    [20435, seedFile, SHA_CROP_435, 'Crop_435'],
    [40435, fruitFile, SHA_CROP_435, 'Crop_435'],
    [1040435, goldFile, SHA_GOLD_CROP_435, 'gold/Crop_435'],
  ];
  for (const [id, file, sha256, assetPath] of expected) {
    const rows = manifest.activityEntries.filter(entry => entry.id === id);
    assert.equal(rows.length, 1, `activityEntries 中 ${id} 必须恰好一条`);
    assert.equal(path.basename(rows[0].file), path.basename(file));
    assert.equal(rows[0].sha256, sha256);
    assert.equal(rows[0].assetPath, assetPath, 'assetPath 必须是观测到的 ItemInfo 逻辑资产名');
    assert.ok(typeof rows[0].sourcePath === 'string' && rows[0].sourcePath.endsWith(`/${id}.png`),
      'sourcePath 必须指向参考系内确切相对源文件');
    assert.equal(rows[0].sourceGrade, 'reviewed_public_client_snapshot');
    assert.equal(rows[0].sha256, sha(file), '清单 sha256 与实际文件哈希一致');
  }
  // 种子/果实同图依据：gitBlob 相同 + 逻辑资产名相同（不宣称未观测的 spriteFrame）
  const seedRow = manifest.activityEntries.find(entry => entry.id === 20435);
  const fruitRow = manifest.activityEntries.find(entry => entry.id === 40435);
  assert.equal(seedRow.gitBlob, fruitRow.gitBlob);
  assert.equal(seedRow.assetPath, fruitRow.assetPath);
  // 登记不引入通用回退缺口
  assert.ok(!getGenericFallbackItemIds().includes(20435));
});

test('家族条目恰好一条且字段确认；既有登记保持不变', () => {
  const eventItems = JSON.parse(fs.readFileSync(path.join(GAME_CONFIG_DIR, 'EventItems.json'), 'utf8'));
  const ids = eventItems.map(entry => entry.id);
  assert.equal(new Set(ids).size, ids.length, 'EventItems 不得出现重复 ID');
  // 恰好一条 + 字段确认（不冻结表尾顺序，未来合法追加不破坏本回归）
  assert.equal(ids.filter(id => id === 20435).length, 1);
  assert.equal(ids.filter(id => id === 1040435).length, 1);
  const seedRow = eventItems.find(entry => entry.id === 20435);
  assert.equal(seedRow.name, '山丹丹种子');
  assert.equal(seedRow.type, 5);
  assert.equal(seedRow.asset_name, 'Crop_435');
  const goldRow = eventItems.find(entry => entry.id === 1040435);
  assert.equal(goldRow.name, '黄金·山丹丹');
  assert.equal(goldRow.type, 17);
  assert.equal(goldRow.asset_name, 'gold/Crop_435');
  const eventPlants = JSON.parse(fs.readFileSync(path.join(GAME_CONFIG_DIR, 'EventPlants.json'), 'utf8'));
  const plantIds = eventPlants.map(entry => entry.id);
  assert.equal(new Set(plantIds).size, plantIds.length, 'EventPlants 不得出现重复 ID');
  assert.equal(plantIds.filter(id => id === 1020435).length, 1);
  assert.equal(plantIds.filter(id => id === 1120435).length, 1);
  const plantRow = eventPlants.find(entry => entry.id === 1020435);
  assert.equal(plantRow.seed_id, 20435);
  assert.equal(plantRow.fruit_id, 40435);
  assert.equal(plantRow.fruit_count, 48);
  // 既有登记抽检（值为本轮之前已闭环的确认值，不锁未来目录规模）
  assert.equal(getItemById(26030)?.name, '月下美人种子');
  assert.equal(getPlantBySeedId(26030)?.name, '月下美人');
  assert.equal(getItemById(21625)?.name, '枸杞种子');
  assert.equal(getItemById(5006)?.name, '乌云使坏瓶');
  assert.equal(getItemById(1041625)?.name, '黄金·枸杞');
  assert.equal(isSeedItem(26030), true);
  assert.equal(isSeedItem(5006), false);
  assert.equal(getPlantBySeedId(29004)?.size, 2, '泡泡棉花糖必须保持 2x2');
});
