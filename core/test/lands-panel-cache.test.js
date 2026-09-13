const assert = require('node:assert/strict');
const test = require('node:test');

// 面板土地读取缓存（2026-09-13 安全巡检）：FarmPanel 60s 固定轮询
// /api/lands 此前每次直发 AllLands。现在面板 RPC 'getLands' 走 60s 缓存 +
// 在途合并；面板触发的农场操作（doFarmOp/removePlant/removeAllPlants）后失效。
// 农场 tick 与 removeAllPlants 决策仍用无缓存新鲜读取。

function mockModule(filename, exports) {
  return { id: filename, filename, loaded: true, exports, paths: [] };
}

function loadLandsFixture(getAllLands) {
  const servicePath = require.resolve('../src/services/farm-land-analyzer');
  const configPath = require.resolve('../src/config/config');
  const gameConfigPath = require.resolve('../src/config/gameConfig');
  const utilsPath = require.resolve('../src/utils/utils');
  const farmApiPath = require.resolve('../src/services/farm-api');
  const paths = [servicePath, configPath, gameConfigPath, utilsPath, farmApiPath];
  const previous = new Map(paths.map(file => [file, require.cache[file]]));

  require.cache[configPath] = mockModule(configPath, {
    PlantPhase: {},
    PHASE_NAMES: [],
  });
  require.cache[gameConfigPath] = mockModule(gameConfigPath, {
    getPlantName: () => '',
    getKnownPlantName: () => '',
    getItemById: () => null,
    getPlantExp: () => 0,
    getPlantByIdOrSeedId: () => null,
    getPlantGrowTime: () => 0,
    getPlantGrowPhases: () => [],
    getSeedImageBySeedId: () => '',
    isSeedItem: () => false,
    getMutantDisplayPlantId: () => 0,
    getMutantPlantImageByPhase: () => '',
    getMutantEffectsByIds: () => [],
  });
  require.cache[utilsPath] = mockModule(utilsPath, {
    toNum: value => Number(value) || 0,
    toTimeSec: value => Number(value) || 0,
    getServerTimeSec: () => 1000,
    logWarn: () => {},
  });
  require.cache[farmApiPath] = mockModule(farmApiPath, { getAllLands });
  delete require.cache[servicePath];

  return {
    service: require(servicePath),
    restore() {
      for (const file of paths) {
        if (previous.get(file)) require.cache[file] = previous.get(file);
        else delete require.cache[file];
      }
    },
  };
}

function landReply(lands) {
  return { lands };
}

test('面板土地读取合并并发并复用 60 秒本地缓存', async () => {
  let upstreamCalls = 0;
  let finishRequest;
  const fixture = loadLandsFixture(() => {
    upstreamCalls += 1;
    return new Promise(resolve => { finishRequest = resolve; });
  });

  try {
    const first = fixture.service.getLandsDetailForPanel();
    const concurrent = fixture.service.getLandsDetailForPanel();
    assert.equal(upstreamCalls, 1);
    finishRequest(landReply([{ id: 1, unlocked: false, level: 1 }]));

    const [left, right] = await Promise.all([first, concurrent]);
    assert.equal(left.lands.length, 1);
    assert.equal(left.lands[0].status, 'locked');
    assert.deepEqual(right, left);

    // 缓存命中：后续面板读取不再穿透上游
    assert.deepEqual(await fixture.service.getLandsDetailForPanel(), left);
    assert.equal(upstreamCalls, 1);
  } finally {
    fixture.restore();
  }
});

test('面板操作失效后重新读取，内部 getLandsDetail 仍新鲜', async () => {
  let upstreamCalls = 0;
  const replies = [
    landReply([{ id: 1, unlocked: false, level: 1 }]),
    landReply([{ id: 2, unlocked: true, level: 1 }]),
  ];
  const fixture = loadLandsFixture(async () => {
    upstreamCalls += 1;
    return replies.shift();
  });

  try {
    const before = await fixture.service.getLandsDetailForPanel();
    assert.equal(before.lands[0].id, 1);

    fixture.service.invalidatePanelLandsCache();

    const after = await fixture.service.getLandsDetailForPanel();
    assert.equal(after.lands[0].id, 2);
    assert.equal(after.lands[0].status, 'empty');
    assert.equal(upstreamCalls, 2);

    // removeAllPlants 等内部决策路径不走缓存
    const fresh = await fixture.service.getLandsDetail();
    assert.deepEqual(fresh, { lands: [], summary: {} });
    assert.equal(upstreamCalls, 3);
  } finally {
    fixture.restore();
  }
});
