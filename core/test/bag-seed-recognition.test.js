const test = require('node:test');
const assert = require('node:assert/strict');

const {
  getBagSeedsFromItems,
  extractBagItemShowNames,
} = require('../src/services/warehouse');
const {
  getGenericFallbackItemIds,
  getItemById,
  getItemImageById,
  isSeedItem,
} = require('../src/config/gameConfig');

function mockModule(filename, exports) {
  return { id: filename, filename, loaded: true, exports };
}

// ---- 手工构造 protobuf 字节（只用于观察函数的单测夹具）----
function encodeVarint(value) {
  const bytes = [];
  let v = Number(value);
  while (v >= 0x80) { bytes.push((v & 0x7F) | 0x80); v = Math.floor(v / 128); }
  bytes.push(v);
  return Buffer.from(bytes);
}
function wireField(field, bytes) {
  return Buffer.concat([encodeVarint((field << 3) | 2), encodeVarint(bytes.length), bytes]);
}
function varintField(field, value) {
  return Buffer.concat([encodeVarint(field << 3), encodeVarint(value)]);
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

test('extractBagItemShowNames 读取服务端 ItemShow(field 100) 名称', () => {
  // BagReply{ item_bag{ items[ {id=1027, count=20, show{ "萌新挑战券" }}] } }
  const showBytes = wireField(1, Buffer.from('萌新挑战券', 'utf8'));
  const itemBytes = Buffer.concat([
    varintField(1, 1027),
    varintField(2, 20),
    wireField(100, showBytes),
  ]);
  const noShowItem = Buffer.concat([varintField(1, 5005), varintField(2, 26)]);
  // ItemBag.repeated items：每个条目独立 field-1 tag，不能合并到同一个 length 里
  const bagBytes = Buffer.concat([wireField(1, itemBytes), wireField(1, noShowItem)]);
  const body = wireField(1, bagBytes);

  const wanted = new Set([1027, 5005, 999]);
  const names = extractBagItemShowNames(body, wanted);
  assert.equal(names.get(1027), '萌新挑战券');
  assert.equal(names.has(5005), false); // 无 ItemShow 字段
  assert.equal(names.has(999), false); // 不在回包中
  assert.equal(extractBagItemShowNames(null, wanted).size, 0);
  assert.equal(extractBagItemShowNames(body, null).size, 0);
});

test('extractBagItemShowNames 忽略无中文名称候选的字节', () => {
  const showBytes = Buffer.concat([
    wireField(1, Buffer.from('ascii-id-123', 'utf8')), // 无 CJK，不是名称候选
    wireField(2, Buffer.from('使坏天气瓶', 'utf8')),
  ]);
  const itemBytes = Buffer.concat([varintField(1, 1027), varintField(2, 1), wireField(100, showBytes)]);
  const body = wireField(1, wireField(1, itemBytes));
  const names = extractBagItemShowNames(body, new Set([1027]));
  assert.equal(names.get(1027), '使坏天气瓶');
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
