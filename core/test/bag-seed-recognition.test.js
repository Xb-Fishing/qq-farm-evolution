const test = require('node:test');
const assert = require('node:assert/strict');

const {
  getBagSeedsFromItems,
} = require('../src/services/warehouse');
const {
  getGenericFallbackItemIds,
  getItemImageById,
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

  // 优先列表只含 29003；29004（活动种子，无植物映射）在列表外，也必须被种植。
  require.cache[warehousePath] = mockModule(warehousePath, {
    getBagSeeds: async () => [
      { seedId: 29003, name: '星语铃花种子', count: 2, requiredLevel: 1, plantSize: 1, image: '' },
      { seedId: 29004, name: '萌宠元气糕种子', count: 3, requiredLevel: 1, plantSize: 1, image: '' },
      { seedId: 21251, name: '紫玫瑰种子', count: 1, requiredLevel: 1, plantSize: 1, image: '' },
    ],
  });
  require.cache[storePath] = mockModule(storePath, {
    getBagSeedPriority: () => [29003],
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
      [21251, 29003, 29004],
    );
    assert.deepEqual(
      [...okLog.meta.outsidePrioritySeedIds].sort((a, b) => a - b),
      [21251, 29004],
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

test('generic fallback icons are tracked as an explicit gap signal', () => {
  const fallbackIds = getGenericFallbackItemIds();
  assert.deepEqual([...fallbackIds].sort((a, b) => a - b), [20522, 20523, 29004]);
  for (const id of fallbackIds) {
    assert.equal(getItemImageById(id), '/game-config/plant_images/common/seed.png');
  }
});
