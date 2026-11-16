const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const priorDataDir = process.env.FARM_DATA_DIR;
const temporaryRoot = fs.realpathSync(os.tmpdir());
const sourceRoot = fs.realpathSync(path.resolve(__dirname, '../..'));
assert.ok(temporaryRoot !== sourceRoot && !temporaryRoot.startsWith(sourceRoot + path.sep));
const prefix = path.resolve(temporaryRoot, 'farm-lands-panel-cache-');
assert.equal(path.dirname(prefix), temporaryRoot);
const fixtureDataDir = fs.mkdtempSync(prefix);
process.env.FARM_DATA_DIR = fixtureDataDir;
const protectedFiles = [__filename, require.resolve('../src/services/farm-land-analyzer')];
const fingerprints = () => protectedFiles.map(file => [fs.statSync(file).mode,
  crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')]);
const initialFingerprints = fingerprints();
test.after(() => {
  try { assert.deepEqual(fingerprints(), initialFingerprints); }
  finally {
    if (priorDataDir === undefined) delete process.env.FARM_DATA_DIR;
    else process.env.FARM_DATA_DIR = priorDataDir;
    assert.equal(path.dirname(fixtureDataDir), temporaryRoot);
    fs.rmSync(fixtureDataDir, { recursive: true, force: true });
  }
});

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
    PlantPhase: { UNKNOWN: 0, SEED: 1, MATURE: 6, DEAD: 7 },
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

test('真实土地DTO透传绝对成熟时刻，60秒缓存不重新锚定旧倒计时', async () => {
  let upstreamCalls = 0;
  const fixture = loadLandsFixture(async () => {
    upstreamCalls++;
    return landReply([{ id: 1, unlocked: true, level: 1, plant: { id: 1020001,
      phases: [{ phase: 1, begin_time: 900 }, { phase: 6, begin_time: 1200 }] } }]);
  });
  const originalNow = Date.now;
  try {
    const first = await fixture.service.getLandsDetailForPanel();
    assert.equal(first.lands[0].matureAtSec, 1200);
    assert.equal(first.lands[0].matureInSec, 200);
    const before = Date.now(); Date.now = () => before + 30000;
    const cached = await fixture.service.getLandsDetailForPanel();
    assert.equal(upstreamCalls, 1, '不为批次额外触发上游读取');
    assert.equal(cached.lands[0].matureAtSec, 1200, '绝对截止随缓存保持原值');
    assert.equal(cached.lands[0].matureInSec, 200, '旧相对值不会被误当新的绝对截止');
  } finally { Date.now = originalNow; fixture.restore(); }
});
