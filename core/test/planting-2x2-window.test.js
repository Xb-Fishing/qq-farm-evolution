const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// 2x2 预留 60 秒硬窗口（2026-10-04）端到端回归：真实 autoPlantEmptyLands
// + 真实 proto 编解码 + 真实植物配置，仅在上游传输边界（sendMsgAsync）与
// 背包/商店/配置读取注入可控模拟，服务器时钟用权威 getServerTimeSec 伪造。
// 断言核心：远期/未知/未到末季组合的空地立即交给 1x1 普通种植；60 秒内
// （含 60）才允许等待预留；等待期限=首次预留+60s，时钟前进不重置；完整
// 空闲方块立即按 2x2 立种；资格变化后旧预留不留空痕。
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'planting-2x2-window-'));
process.env.FARM_DATA_DIR = DATA_DIR;

const realUtils = require('../src/utils/utils');
let fakeNowSec = 1_700_000_000;

const state = {
  calls: [],        // { seedId, landIds } 每次真实 Plant 请求
  bagSeeds: [],     // getBagSeeds 返回
  prioritize2x2: true,
  strategy: 'level',
};

function mockModule(filename, exports) {
  return { id: filename, filename, loaded: true, exports };
}

const utilsPath = require.resolve('../src/utils/utils');
const networkPath = require.resolve('../src/utils/network');
const warehousePath = require.resolve('../src/services/warehouse');
const farmApiPath = require.resolve('../src/services/farm-api');
const fertilizerPath = require.resolve('../src/services/farm-fertilizer');
const analyticsPath = require.resolve('../src/services/analytics');
const storePath = require.resolve('../src/models/store');

const realFarmApi = require('../src/services/farm-api');

require.cache[utilsPath] = mockModule(utilsPath, {
  ...realUtils,
  getServerTimeSec: () => fakeNowSec,
  log: () => {},
  logWarn: () => {},
});

async function plantReplyFor(landIds, seedId) {
  // 真实 proto 构造 PlantReply：1x1 只回该地块；2x2 回主地块关联结构，
  // 供 plant2x2Seed 的服务器确认校验使用。
  const { types } = require('../src/utils/proto');
  state.calls.push({ seedId, landIds: [...landIds] });
  let land;
  if (landIds.length === 4) {
    const master = landIds[0];
    land = [
      { id: master, land_size: 2, slave_land_ids: landIds.slice(1) },
      ...landIds.slice(1).map(id => ({ id, master_land_id: master })),
    ];
  } else {
    land = landIds.map(id => ({ id }));
  }
  return { body: types.PlantReply.encode(types.PlantReply.create({ land })).finish() };
}

require.cache[networkPath] = mockModule(networkPath, {
  sendMsgAsync: async (serviceName, methodName, payload) => {
    assert.equal(serviceName, 'gamepb.plantpb.PlantService');
    assert.equal(methodName, 'Plant');
    const { types } = require('../src/utils/proto');
    const request = types.PlantRequest.decode(payload);
    const item = request.items && request.items[0];
    return plantReplyFor(item.land_ids.map(Number), Number(item.seed_id));
  },
  getUserState: () => ({ accountId: 'fixture-account', level: 200, gold: 1_000_000 }),
  getWsErrorState: () => null,
});

require.cache[warehousePath] = mockModule(warehousePath, {
  getBagSeeds: async () => state.bagSeeds,
});
require.cache[farmApiPath] = mockModule(farmApiPath, {
  ...realFarmApi,
  getShopInfo: async () => ({
    goods_list: [{ id: 11, item_id: 20002, price: 2, unlocked: true, conds: [], limit_count: 0, bought_num: 0 }],
  }),
  buyGoods: async () => ({ get_items: [], cost_items: [{ id: 1, count: 2 }] }),
  getSeedShopId: async () => 1,
  removePlant: async () => ({}),
});
require.cache[fertilizerPath] = mockModule(fertilizerPath, {
  runFertilizerByConfig: async () => ({}),
});
require.cache[analyticsPath] = mockModule(analyticsPath, {
  getPlantRankings: () => [],
});
require.cache[storePath] = mockModule(storePath, {
  getPlantingStrategy: () => state.strategy,
  getPreferredSeed: () => 0,
  getBagSeedPriority: () => [],
  getBagSeedFallbackStrategy: () => 'level',
  getPrioritize2x2Crops: () => state.prioritize2x2 === true,
  getPlantOrderRandom: () => false,
  getPlantDelaySeconds: () => 0,
});

// 合成身份：全部使用真实植物配置但合成背包/商店数据，不触真实账号。
const SEED_2X2 = 29998;   // 哈哈南瓜：2x2、1 季
const SEED_1X1 = 20002;   // 白萝卜：1x1（商店普通种植）
const MUSHROOM_PLANT = 1020050; // 蘑菇：2 季，单季 14400s
const DOGTAIL_PLANT = 1020516;  // 狗尾草：1 季

function bag2x2(count = 2) {
  return [{ seedId: SEED_2X2, name: '哈哈南瓜', count, requiredLevel: 1, plantSize: 2 }];
}

function growingLand(id, matureAt, { plantId = DOGTAIL_PLANT, season = 1, plantedAt } = {}) {
  return {
    id, unlocked: true,
    plant: {
      id: plantId, season,
      phases: [
        { phase: 1, begin_time: plantedAt ?? matureAt - 3600 },
        { phase: 6, begin_time: matureAt },
      ],
    },
  };
}

function emptyLand(id) {
  return { id, unlocked: true };
}

/** 组 5/6/1/2（主地块 5）：三块植株 + 空地 1 的标准等待场景。 */
function waitingSquare(matureAt, extras = {}) {
  return [
    emptyLand(1),
    growingLand(2, matureAt, extras),
    growingLand(5, matureAt, extras),
    growingLand(6, matureAt, extras),
  ];
}

async function loadService() {
  await require('../src/utils/proto').loadProto();
  return require('../src/services/planting-service');
}

test('远期成熟的组合不预留：空地立即按 1x1 普通种植', async () => {
  const planting = await loadService();
  state.calls = [];
  state.bagSeeds = bag2x2();
  fakeNowSec = 1_700_000_000;

  const result = await planting.autoPlantEmptyLands(
    [],
    [1],
    waitingSquare(fakeNowSec + 3600),
  );

  assert.deepEqual(state.calls, [{ seedId: SEED_1X1, landIds: [1] }]);
  assert.deepEqual(result.reservedLandIds, []);
  assert.equal(result.plantedCount, 1);
});

test('未知植株（无阶段数据）的组合同样不预留，空地走 1x1', async () => {
  const planting = await loadService();
  state.calls = [];
  state.bagSeeds = bag2x2();
  fakeNowSec = 1_700_000_100;

  const result = await planting.autoPlantEmptyLands([], [1], [
    emptyLand(1),
    { id: 2, unlocked: true, plant: { id: DOGTAIL_PLANT, season: 1, phases: [] } },
    { id: 5, unlocked: true, plant: { id: DOGTAIL_PLANT, season: 1, phases: [] } },
    { id: 6, unlocked: true, plant: { id: DOGTAIL_PLANT, season: 1, phases: [] } },
  ]);

  assert.deepEqual(state.calls, [{ seedId: SEED_1X1, landIds: [1] }]);
  assert.deepEqual(result.reservedLandIds, []);
});

test('边界：剩余植株 60 秒整成熟可预留，61 秒不预留', async () => {
  const planting = await loadService();

  // 60 秒整：可等待预留，空地被圈住，本轮不发任何种植请求。
  state.calls = [];
  state.bagSeeds = bag2x2();
  fakeNowSec = 1_700_000_200;
  let result = await planting.autoPlantEmptyLands([], [1], waitingSquare(fakeNowSec + 60));
  assert.deepEqual(state.calls, []);
  assert.deepEqual([...result.reservedLandIds].sort(), [1, 2, 5, 6]);

  // 61 秒：超出窗口，不预留，空地立即 1x1。
  // （先复位模块内等待状态：上一场景的预留期限不应影响本场景。）
  planting.select2x2Reservations([], [], 0, []);
  state.calls = [];
  fakeNowSec = 1_700_000_400;
  result = await planting.autoPlantEmptyLands([], [1], waitingSquare(fakeNowSec + 61));
  assert.deepEqual(state.calls, [{ seedId: SEED_1X1, landIds: [1] }]);
  assert.deepEqual(result.reservedLandIds, []);
});

test('多季作物：第 1 季即将成熟不预留，末季 60 秒内成熟才预留', async () => {
  const planting = await loadService();

  planting.select2x2Reservations([], [], 0, []);
  state.calls = [];
  state.bagSeeds = bag2x2();
  fakeNowSec = 1_700_000_600;
  let result = await planting.autoPlantEmptyLands(
    [], [1], waitingSquare(fakeNowSec + 30, { plantId: MUSHROOM_PLANT, season: 1 }),
  );
  // 蘑菇第 1 季成熟后还要再长一整季（14400s），真实清空远超窗口。
  assert.deepEqual(state.calls, [{ seedId: SEED_1X1, landIds: [1] }]);
  assert.deepEqual(result.reservedLandIds, []);

  planting.select2x2Reservations([], [], 0, []);
  state.calls = [];
  fakeNowSec = 1_700_000_700;
  result = await planting.autoPlantEmptyLands(
    [], [1], waitingSquare(fakeNowSec + 30, { plantId: MUSHROOM_PLANT, season: 2 }),
  );
  assert.deepEqual(state.calls, []);
  assert.deepEqual([...result.reservedLandIds].sort(), [1, 2, 5, 6]);
});

test('等待期限随权威时钟连续推进，不因轮询重置：到期释放给 1x1', async () => {
  const planting = await loadService();

  planting.select2x2Reservations([], [], 0, []);
  state.calls = [];
  state.bagSeeds = bag2x2();
  const t0 = 1_700_000_800;
  fakeNowSec = t0;
  let result = await planting.autoPlantEmptyLands([], [1], waitingSquare(t0 + 30));
  assert.deepEqual(state.calls, []);
  assert.deepEqual([...result.reservedLandIds].sort(), [1, 2, 5, 6]);

  // +30s：仍在期限（t0+60）内，即使植株已全部成熟也继续等待，不重置期限。
  fakeNowSec = t0 + 30;
  result = await planting.autoPlantEmptyLands([], [1], waitingSquare(t0 + 30));
  assert.deepEqual(state.calls, []);
  assert.ok(result.reservedLandIds.includes(1));

  // +61s：期限耗尽，同一停滞组合不得重新圈地，空地立即 1x1。
  fakeNowSec = t0 + 61;
  result = await planting.autoPlantEmptyLands([], [1], waitingSquare(t0 + 30));
  assert.deepEqual(state.calls, [{ seedId: SEED_1X1, landIds: [1] }]);
  assert.deepEqual(result.reservedLandIds, []);

  // +121s：继续不预留（防同一成熟组合反复圈地）。
  fakeNowSec = t0 + 121;
  state.calls = [];
  result = await planting.autoPlantEmptyLands([], [1], waitingSquare(t0 + 30));
  assert.deepEqual(state.calls, [{ seedId: SEED_1X1, landIds: [1] }]);
});

test('资格变化后旧预留不留空痕：植株变为远期成熟即释放空地', async () => {
  const planting = await loadService();

  planting.select2x2Reservations([], [], 0, []);
  state.calls = [];
  state.bagSeeds = bag2x2();
  const t0 = 1_700_000_900;
  fakeNowSec = t0;
  let result = await planting.autoPlantEmptyLands([], [1], waitingSquare(t0 + 30));
  assert.deepEqual(result.reservedLandIds.sort(), [1, 2, 5, 6]);

  // 场景变化：剩余植株被换成远期成熟作物（如被重种长周期 1x1）。
  fakeNowSec = t0 + 10;
  result = await planting.autoPlantEmptyLands([], [1], waitingSquare(t0 + 7200));
  assert.deepEqual(state.calls, [{ seedId: SEED_1X1, landIds: [1] }]);
  assert.deepEqual(result.reservedLandIds, []);
});

test('完整空闲方块立即按 2x2 立种：两组各发一次 4 地块请求，不买商店种子', async () => {
  const planting = await loadService();

  planting.select2x2Reservations([], [], 0, []);
  state.calls = [];
  state.bagSeeds = bag2x2(2);
  fakeNowSec = 1_700_001_000;

  const result = await planting.autoPlantEmptyLands(
    [],
    [1, 2, 5, 6, 3, 4, 7, 8],
    [1, 2, 3, 4, 5, 6, 7, 8].map(emptyLand),
  );

  assert.deepEqual(state.calls.map(call => call.seedId), [SEED_2X2, SEED_2X2]);
  assert.ok(state.calls.every(call => call.landIds.length === 4));
  assert.ok(state.calls.some(call => call.landIds.includes(5)));
  assert.ok(state.calls.some(call => call.landIds.includes(7)));
  assert.equal(result.plantedCount, 2);
  assert.equal(result.occupiedCount, 8);
});

test('最早清空优先：两个并列可等待组按真实清空时刻排序，不按锚点', async () => {
  const planting = await loadService();

  planting.select2x2Reservations([], [], 0, []);
  state.calls = [];
  state.bagSeeds = bag2x2(1); // 只想种 1 组：谁先清空就等谁
  const t0 = 1_700_002_000;
  fakeNowSec = t0;

  // 组 5-6-1-2（锚点 5）50s 后清空；组 3-4-7-8（锚点 7）10s 后清空。
  // 旧的 60s 并列容差会把两组合视为同优先再按锚点选 5-6-1-2（错误）。
  const lands = [
    emptyLand(1),
    growingLand(2, t0 + 50), growingLand(5, t0 + 50), growingLand(6, t0 + 50),
    emptyLand(3),
    growingLand(4, t0 + 10), growingLand(7, t0 + 10), growingLand(8, t0 + 10),
  ];
  const result = await planting.autoPlantEmptyLands([], [1, 3], lands);

  assert.deepEqual(result.reservedLandIds.sort(), [3, 4, 7, 8]);
  assert.deepEqual(state.calls, [{ seedId: SEED_1X1, landIds: [1] }]);
});

test('到期释放后：仅收割一块旧作物不重新圈地，被证明的新种植周期才重来', async () => {
  const planting = await loadService();

  planting.select2x2Reservations([], [], 0, []);
  state.calls = [];
  state.bagSeeds = bag2x2(1);
  const t0 = 1_700_002_100;
  fakeNowSec = t0;

  // 圈住空地 1 等待 2/5/6 清空（30s 后成熟）。
  let result = await planting.autoPlantEmptyLands([], [1], waitingSquare(t0 + 30));
  assert.deepEqual(result.reservedLandIds.sort(), [1, 2, 5, 6]);

  // 期限耗尽：释放并记下仍占用地块的作物身份；空地 1 回到 1x1。
  fakeNowSec = t0 + 61;
  state.calls = [];
  result = await planting.autoPlantEmptyLands([], [1], waitingSquare(t0 + 30));
  assert.deepEqual(state.calls, [{ seedId: SEED_1X1, landIds: [1] }]);
  assert.deepEqual(result.reservedLandIds, []);

  // 又一块旧作物（2 号地）被收割：只是身份表变短，没有新占用出现，
  // 不得重启 60s 等待期限——空地 1/2 立即 1x1。
  fakeNowSec = t0 + 121;
  state.calls = [];
  result = await planting.autoPlantEmptyLands([], [1, 2], [
    emptyLand(1), emptyLand(2),
    growingLand(5, t0 + 30), growingLand(6, t0 + 30),
  ]);
  assert.deepEqual(state.calls.map(call => call.landIds), [[1], [2]]);
  assert.deepEqual(result.reservedLandIds, []);

  // 预测成熟时刻抖动（播种时刻不变、只是成熟时刻重算）同样不算新周期。
  fakeNowSec = t0 + 130;
  state.calls = [];
  result = await planting.autoPlantEmptyLands([], [1, 2], [
    emptyLand(1), emptyLand(2),
    growingLand(5, t0 + 33, { plantedAt: t0 + 30 - 3600 }), growingLand(6, t0 + 30),
  ]);
  assert.deepEqual(state.calls.map(call => call.landIds), [[1], [2]]);
  assert.deepEqual(result.reservedLandIds, []);

  // 5 号地被重种（新种植周期：新的播种时刻）且新周期 60s 内可清空：
  // 释放标记作废重来，组合重新进入等待。
  fakeNowSec = t0 + 200;
  state.calls = [];
  result = await planting.autoPlantEmptyLands([], [1, 2], [
    emptyLand(1), emptyLand(2),
    growingLand(5, t0 + 210, { plantedAt: t0 + 150 }), growingLand(6, t0 + 30),
  ]);
  assert.deepEqual(state.calls, []);
  assert.deepEqual(result.reservedLandIds.sort(), [1, 2, 5, 6]);
});

test('过期释放标记不挡完整空闲：四块全空立即 2x2 立种', async () => {
  const planting = await loadService();

  planting.select2x2Reservations([], [], 0, []);
  state.calls = [];
  state.bagSeeds = bag2x2(1);
  const t0 = 1_700_002_200;
  fakeNowSec = t0;

  let result = await planting.autoPlantEmptyLands([], [1], waitingSquare(t0 + 30));
  assert.deepEqual(result.reservedLandIds.sort(), [1, 2, 5, 6]);

  // 期限耗尽释放后，四块地全部真实空闲：陈旧的释放/等待痕迹一律作废，
  // 立即按 2x2 立种（不回到 1x1）。
  fakeNowSec = t0 + 90;
  state.calls = [];
  result = await planting.autoPlantEmptyLands(
    [], [1, 2, 5, 6], [1, 2, 5, 6].map(emptyLand),
  );
  assert.deepEqual(state.calls, [{ seedId: SEED_2X2, landIds: [5, 6, 1, 2] }]);
  assert.equal(result.plantedCount, 1);
});

test('全生长中不消耗等待期限：期限自首次圈住空地起算，不被轮询续期', async () => {
  const planting = await loadService();

  planting.select2x2Reservations([], [], 0, []);
  state.calls = [];
  state.bagSeeds = bag2x2(1);
  const t0 = 1_700_002_300;
  fakeNowSec = t0;

  // 四块全生长中（30s 后清空）：组合可等待，但一块空地都没有时不启动
  // 60s 期限、不拦任何 1x1。
  let result = await planting.autoPlantEmptyLands([], [], [
    growingLand(1, t0 + 30), growingLand(2, t0 + 30),
    growingLand(5, t0 + 30), growingLand(6, t0 + 30),
  ]);
  assert.deepEqual(state.calls, []);
  assert.deepEqual(result.reservedLandIds.sort(), [1, 2, 5, 6]);

  // t0+5 出现第一块空地（2 号）：期限从这一刻起算（t0+65），不是从 t0。
  fakeNowSec = t0 + 5;
  const withEmpty = [growingLand(1, t0 + 30), emptyLand(2), growingLand(5, t0 + 30), growingLand(6, t0 + 30)];
  result = await planting.autoPlantEmptyLands([], [2], withEmpty);
  assert.deepEqual(result.reservedLandIds.sort(), [1, 2, 5, 6]);
  assert.deepEqual(state.calls, []);

  // t0+62：若期限误从 t0 起算（t0+60）此刻应已释放；正确行为是仍在等待。
  fakeNowSec = t0 + 62;
  state.calls = [];
  result = await planting.autoPlantEmptyLands([], [2], withEmpty);
  assert.deepEqual(state.calls, []);
  assert.deepEqual(result.reservedLandIds.sort(), [1, 2, 5, 6]);

  // t0+66：期限（t0+65）耗尽，空地 2 立即 1x1，同一停滞组合不再重圈。
  fakeNowSec = t0 + 66;
  state.calls = [];
  result = await planting.autoPlantEmptyLands([], [2], withEmpty);
  assert.deepEqual(state.calls, [{ seedId: SEED_1X1, landIds: [2] }]);
  assert.deepEqual(result.reservedLandIds, []);
});

test.after(() => fs.rmSync(DATA_DIR, { recursive: true, force: true }));
