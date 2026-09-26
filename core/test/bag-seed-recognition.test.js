const test = require('node:test');
const assert = require('node:assert/strict');

const {
  getBagSeedsFromItems,
} = require('../src/services/warehouse');
const {
  getGenericFallbackItemIds,
  getItemById,
  getItemImageById,
  getPlantBySeedId,
  isSeedItem,
} = require('../src/config/gameConfig');

function mockModule(filename, exports) {
  return { id: filename, filename, loaded: true, exports };
}

test('plantFromBagSeeds plants seeds outside the priority list instead of dropping them', async () => {
  const servicePath = require.resolve('../src/services/planting-service');
  const warehousePath = require.resolve('../src/services/warehouse');
  const storePath = require.resolve('../src/models/store');
  const behaviorPath = require.resolve('../src/utils/behavior');
  const utilsPath = require.resolve('../src/utils/utils');
  const networkPath = require.resolve('../src/utils/network');
  const farmApiPath = require.resolve('../src/services/farm-api');
  const landAnalyzerPath = require.resolve('../src/services/farm-land-analyzer');
  const farmFertilizerPath = require.resolve('../src/services/farm-fertilizer');
  const analyticsPath = require.resolve('../src/services/analytics');
  const protoPath = require.resolve('../src/utils/proto');
  const paths = [warehousePath, storePath, behaviorPath, utilsPath, networkPath,
    farmApiPath, landAnalyzerPath, farmFertilizerPath, analyticsPath, protoPath];
  const previous = new Map(paths.map(path => [path, require.cache[path]]));
  const plantCalls = [];
  const logs = [];

  const emptyReply = Buffer.from([0x0A, 0x00]);

  // 优先列表只含 20001；25995（活动种子）在列表外，也必须被种植。
  require.cache[warehousePath] = mockModule(warehousePath, {
    getBagSeeds: async () => [
      { seedId: 20001, name: '草莓种子', count: 2, requiredLevel: 1, plantSize: 1, image: '' },
      { seedId: 25995, name: '芦苇种子', count: 3, requiredLevel: 1, plantSize: 1, image: '' },
      { seedId: 20002, name: '白萝卜种子', count: 1, requiredLevel: 1, plantSize: 1, image: '' },
    ],
  });
  require.cache[storePath] = mockModule(storePath, {
    getBagSeedPriority: () => [20001],
    getPlantOrderRandom: () => false,
    getPlantDelaySeconds: () => 0,
    getPrioritize2x2Crops: () => false,
  });
  require.cache[behaviorPath] = mockModule(behaviorPath, {
    shuffleInPlace: () => {},
    pauseSeconds: async () => {},
  });
  require.cache[utilsPath] = mockModule(utilsPath, {
    toNum: value => Number(value) || 0,
    toLong: value => value,
    toTimeSec: () => 0,
    getServerTimeSec: () => 0,
    log: (tag, message, meta) => logs.push({ message, meta }),
    logWarn: () => {},
  });
  require.cache[networkPath] = mockModule(networkPath, {
    sendMsgAsync: async () => {
      plantCalls.push(Date.now());
      return { body: emptyReply };
    },
    getUserState: () => ({ level: 100 }),
    getWsErrorState: () => ({}),
  });
  require.cache[farmApiPath] = mockModule(farmApiPath, {
    getShopInfo: async () => ({}),
    buyGoods: async () => ({}),
    getSeedShopId: async () => 1,
    removePlant: async () => ({}),
  });
  require.cache[landAnalyzerPath] = mockModule(landAnalyzerPath, {
    buildLandMap: () => new Map(),
    getDisplayLandContext: land => ({ masterLandId: land.id, occupiedLandIds: [land.id] }),
  });
  require.cache[farmFertilizerPath] = mockModule(farmFertilizerPath, {
    runFertilizerByConfig: async () => ({}),
  });
  require.cache[analyticsPath] = mockModule(analyticsPath, {
    getPlantRankings: () => [],
  });
  require.cache[protoPath] = mockModule(protoPath, {
    types: {
      PlantRequest: {
        create: value => value,
        encode: () => ({ finish: () => Buffer.alloc(0) }),
      },
      PlantReply: { decode: () => ({ land: [] }) },
    },
  });

  delete require.cache[servicePath];
  try {
    const service = require('../src/services/planting-service');
    const result = await service.plantFromBagSeeds([1, 2, 3, 4, 5], 'account-1');
    // 2 + 3 + 1 = 6 个种子、5 块地：全部地块都会被种，列表外种子不能缺席
    assert.equal(plantCalls.length, 5, `expected 5 lands planted, got ${plantCalls.length}`);
    assert.equal(result.totalPlanted, 5);

    const okLog = logs.find(entry => entry.meta && entry.meta.event === '种植种子' && entry.meta.result === 'ok');
    assert.ok(okLog, 'bag_priority success log recorded');
    assert.deepEqual(
      [...okLog.meta.plantedSeedIds].sort((a, b) => a - b),
      [20001, 20002, 25995],
    );
    assert.deepEqual(
      [...okLog.meta.outsidePrioritySeedIds].sort((a, b) => a - b),
      [20002, 25995],
    );
  } finally {
    delete require.cache[servicePath];
    for (const [path, entry] of previous) {
      if (entry === undefined) delete require.cache[path];
      else require.cache[path] = entry;
    }
  }
});

test('getBagSeedsFromItems reports unknown bag items instead of silently dropping them', () => {
  // 4299991 = 本地索引没有条目的假想未知物品 id
  const seeds = getBagSeedsFromItems([
    { id: 29004, count: 3 },
    { id: 4299991, count: 1 },
    { id: 1001, count: 9999 }, // 金币：已知非种子，不应报未分类
  ]);
  assert.deepEqual(seeds.map(seed => seed.seedId), [29004]);
});

test('known seed-like items still resolve without plant mapping', () => {
  assert.equal(isSeedItem(20522), true);
  assert.equal(isSeedItem(20523), true);
  assert.equal(isSeedItem(29004), true);
});

test('precise downloaded icons remove seeds from the generic fallback gap set', () => {
  assert.deepEqual(getGenericFallbackItemIds(), []);
  assert.match(getItemImageById(29004), /29004_Crop_9004_Seed/);
});

test('服务端 showName 让未知背包物品进入种子列表', () => {
  const seeds = getBagSeedsFromItems([
    { id: 4299992, count: 5, showName: '神秘花种子' },
    { id: 4299993, count: 2, showName: '普通活动券' }, // 不以"种子"结尾 → 非种子
  ]);
  assert.deepEqual(seeds.map(seed => [seed.seedId, seed.name, seed.count]), [
    [4299992, '神秘花种子', 5],
  ]);
});

test('雨落成诗留存道具 5001/5002 已按活动证据登记', () => {
  assert.equal(getItemById(5001)?.name, '天气采集瓶');
  assert.equal(getItemById(5002)?.name, '雷雨召唤瓶');
  // 不是种子，不进背包种子列表
  assert.equal(isSeedItem(5001), false);
  const seeds = getBagSeedsFromItems([{ id: 5001, count: 3 }]);
  assert.deepEqual(seeds, []);
});

test('黄金变异物品按 104 段规律登记,挑战书按双源证据登记', () => {
  // 当前仓库在收狗尾草/泡泡棉花糖，其黄金变体与已登记的黄金·芦苇(1045995)同族同证据
  assert.equal(getItemById(1040516)?.name, '黄金·狗尾草');
  assert.equal(getItemById(1049004)?.name, '黄金·泡泡棉花糖');
  assert.equal(isSeedItem(1040516), false);
  assert.equal(isSeedItem(1049004), false);
  // 挑战书：client-config-evidence ItemInfo 快照 + pet-diary 挑战书配置表双源交叉
  assert.equal(getItemById(80101)?.name, '初级挑战书');
  assert.equal(getItemById(80102)?.name, '中级挑战书');
  assert.equal(getItemById(80103)?.name, '高级挑战书');
  assert.equal(isSeedItem(80102), false);
  // 待护送宝藏（2026-09-14 Bag 出现 + ItemInfo 快照闭环）：非种子，只读展示。
  assert.equal(getItemById(1030)?.name, '待护送宝藏');
  assert.equal(isSeedItem(1030), false);
  // 烟花桶（2026-09-24 秋祈良愿开放首日 Bag 出现 + ItemInfo 快照 + 活动说明三方闭环）：
  // type 23 使用型道具，非种子；祈愿奖励的烟花互动道具。
  assert.equal(getItemById(6001)?.name, '烟花桶');
  assert.equal(isSeedItem(6001), false);
});

test('枸杞 2026-09-23 Bag 出现,按快照+Plant+Bag 三方证据登记', () => {
  // 种子进运行时种子索引（type 5），背包优先种植可识别
  assert.equal(getItemById(21625)?.name, '枸杞种子');
  assert.equal(isSeedItem(21625), true);
  // 植物映射：seed→plant→fruit 双向闭环（快照 Plant 1021625 逐字段）
  const plant = getPlantBySeedId(21625);
  assert.equal(plant?.name, '枸杞');
  assert.equal(plant?.size, 1);
  assert.equal(plant?.fruit?.id, 41625);
  assert.equal(plant?.mutant_effect_plant, '5:1121625:1');
  // 果实由 EventPlants 合成条目命名（同 40516 狗尾草惯例，不进 EventItems）
  assert.equal(getItemById(41625)?.name, '枸杞');
  // 黄金变体果实（Plant 1121625 fruit 1041625 + ItemInfo type 17 双源）
  assert.equal(getItemById(1041625)?.name, '黄金·枸杞');
  assert.equal(isSeedItem(1041625), false);
  // 变异展示植物 seed_id 为空,不污染种子索引
  assert.equal(getPlantBySeedId(0), undefined);
});

test('bag_unclassified_item 日志按清单签名去重,不再每个农场 tick 刷屏', () => {
  // warehouse 在 require 时解构 utils.log,重载 utils 模块后再重载 warehouse 捕获日志
  const utilsPath = require.resolve('../src/utils/utils');
  const warehousePath = require.resolve('../src/services/warehouse');
  const previousUtils = require.cache[utilsPath];
  const previousWarehouse = require.cache[warehousePath];
  const logs = [];
  const utilsMod = require('../src/utils/utils');
  require.cache[utilsPath] = mockModule(utilsPath, {
    ...utilsMod,
    log: (tag, message, meta) => logs.push({ message, meta }),
    logWarn: () => {},
  });
  delete require.cache[warehousePath];
  try {
    const { getBagSeedsFromItems: getSeeds } = require('../src/services/warehouse');
    getSeeds([{ id: 4299981, count: 1 }]);
    assert.equal(logs.filter(l => l.meta && l.meta.event === 'bag_unclassified_item').length, 1);
    getSeeds([{ id: 4299981, count: 1 }]);
    assert.equal(logs.filter(l => l.meta && l.meta.event === 'bag_unclassified_item').length, 1,
      'same signature must not log again');
    // 新增 ID 时重新报告
    getSeeds([{ id: 4299981, count: 1 }, { id: 4299982, count: 1 }]);
    const logged = logs.filter(l => l.meta && l.meta.event === 'bag_unclassified_item');
    assert.equal(logged.length, 2);
    assert.deepEqual(logged[1].meta.addedItemIds, [4299982]);
    // 清单清空后复位,再出现可重新报告
    getSeeds([{ id: 29004, count: 3 }]);
    getSeeds([{ id: 4299981, count: 1 }]);
    assert.equal(logs.filter(l => l.meta && l.meta.event === 'bag_unclassified_item').length, 3,
      'after reset, new unknown should log again');
  } finally {
    delete require.cache[warehousePath];
    if (previousUtils === undefined) delete require.cache[utilsPath];
    else require.cache[utilsPath] = previousUtils;
    if (previousWarehouse !== undefined) require.cache[warehousePath] = previousWarehouse;
  }
});

test('月下美人 2026-09-25/26 Bag 出现,按镜像配置快照+Plant+Bag 三方证据登记', () => {
  const {
    getSeedImageBySeedId, getItemImageById,
  } = require('../src/config/gameConfig');
  // 种子进运行时种子索引（type 5），背包优先种植可识别
  assert.equal(getItemById(26030)?.name, '月下美人种子');
  assert.equal(isSeedItem(26030), true);
  // 植物映射：seed→plant→fruit 双向闭环；官方 Plant 表 size null=无2x2证据，登记为 1x1
  const plant = getPlantBySeedId(26030);
  assert.equal(plant?.name, '月下美人');
  assert.equal(plant?.size, 1);
  assert.equal(plant?.fruit?.id, 46030);
  assert.equal(plant?.mutant_effect_plant, '5:1126030:1');
  // 果实由 EventPlants 合成条目命名（同枸杞惯例，不进 EventItems）
  assert.equal(getItemById(46030)?.name, '月下美人');
  // 黄金变体果实（Plant 1126030 fruit 1046030 + ItemInfo type 17 双源）
  assert.equal(getItemById(1046030)?.name, '黄金·月下美人');
  assert.equal(isSeedItem(1046030), false);
  // 官方专属图（非通用回退）：种子/果实/黄金三张都必须命中本地文件
  assert.match(getSeedImageBySeedId(26030), /26030_Crop_6030_Seed\.png$/);
  assert.match(getSeedImageBySeedId(46030), /46030_Crop_6030_Seed\.png$/);
  assert.match(getSeedImageBySeedId(1046030) || getItemImageById(1046030), /1046030_gold_Crop_6030_Seed\.png$/);
  // 背包识别不再 unknown，mappingStatus=mapped 且带真实图片
  const seeds = getBagSeedsFromItems([
    { id: 26030, count: 2, showName: '月下美人种子' },
    { id: 46030, count: 48, showName: '月下美人' },
    { id: 1046030, count: 1, showName: '黄金·月下美人' },
  ]);
  assert.equal(seeds.length, 1);
  assert.equal(seeds[0].mappingStatus, 'mapped');
  assert.equal(seeds[0].plantSize, 1);
  assert.match(seeds[0].image, /26030_Crop_6030_Seed\.png$/);
});

test('月下美人图片文件缺失时审计必须报 seed_icon_missing,不得静默通过', () => {
  const { auditBagSeedCoverage } = require('../src/services/seed-catalog-audit');
  const config = require('../src/config/gameConfig');
  // 正常：登记 + 图片齐备 → 无缺口
  const ok = auditBagSeedCoverage(
    [{ id: 26030, count: 2 }],
    getBagSeedsFromItems([{ id: 26030, count: 2 }]),
  );
  assert.equal(ok.issues.filter(i => i.itemId === 26030).length, 0);
  // 行为回归：图片索引拿不到该种子贴图时必须产生 seed_icon_missing 缺口
  const noIconLookup = Object.create(config);
  noIconLookup.getSeedImageBySeedId = () => '';
  const missing = auditBagSeedCoverage(
    [{ id: 26030, count: 2 }],
    getBagSeedsFromItems([{ id: 26030, count: 2 }]),
    noIconLookup,
  );
  assert.ok(missing.issues.some(i => i.itemId === 26030 && i.kind === 'seed_icon_missing'));
});

test('bag_unclassified 签名变化同步进运行时待办,同签名不风暴', () => {
  const utilsPath = require.resolve('../src/utils/utils');
  const warehousePath = require.resolve('../src/services/warehouse');
  const inboxPath = require.resolve('../src/services/evolution-issue-inbox');
  const previousUtils = require.cache[utilsPath];
  const previousWarehouse = require.cache[warehousePath];
  const previousInbox = require.cache[inboxPath];
  const recorded = [];
  const utilsMod = require('../src/utils/utils');
  require.cache[utilsPath] = mockModule(utilsPath, {
    ...utilsMod,
    log: () => {},
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
    getSeeds([{ id: 4299981, count: 1 }]);
    assert.equal(recorded.length, 1, 'first unknown id must enter the issue inbox');
    assert.deepEqual(recorded[0], { type: 'bag_unclassified', level: 'warn' });
    getSeeds([{ id: 4299981, count: 1 }]);
    assert.equal(recorded.length, 1, 'same signature must not storm the inbox');
    // 签名变化但只是旧 ID 消失（无新增）：不刷待办次数
    getSeeds([{ id: 4299982, count: 1 }]);
    assert.equal(recorded.length, 2);
    // 全部补齐后复位，再出现可重新上报
    getSeeds([{ id: 29004, count: 3 }]);
    getSeeds([{ id: 4299981, count: 1 }]);
    assert.equal(recorded.length, 3, 'after reset, new unknown must re-enter the inbox');
  } finally {
    delete require.cache[warehousePath];
    if (previousUtils === undefined) delete require.cache[utilsPath];
    else require.cache[utilsPath] = previousUtils;
    if (previousInbox === undefined) delete require.cache[inboxPath];
    else require.cache[inboxPath] = previousInbox;
    if (previousWarehouse !== undefined) require.cache[warehousePath] = previousWarehouse;
  }
});
