const assert = require('node:assert/strict');
const test = require('node:test');

// 面板背包读取缓存（2026-09-13 安全巡检）：Dashboard(10s)/Settings(15s)/
// BagPanel(60s) 的固定轮询此前每次直发 ItemService.Bag；现在 getBagDetail /
// getBagSeedsForPanel 走 60s 缓存 + 在途合并 + 失败冷却，Sell/Use 成功后失效，
// 种植 getBagSeeds 仍保持无缓存新鲜读取。

function mockModule(filename, exports) {
  return { id: filename, filename, loaded: true, exports, paths: [] };
}

function makeType() {
  return {
    create: value => value,
    encode: () => ({ finish: () => Buffer.alloc(0) }),
    decode: body => body,
  };
}

function loadWarehouseFixture(sendMsgAsync) {
  const servicePath = require.resolve('../src/services/warehouse');
  const gameConfigPath = require.resolve('../src/config/gameConfig');
  const storePath = require.resolve('../src/models/store');
  const networkPath = require.resolve('../src/utils/network');
  const protoPath = require.resolve('../src/utils/proto');
  const utilsPath = require.resolve('../src/utils/utils');
  const statusPath = require.resolve('../src/services/status');
  const auditPath = require.resolve('../src/services/seed-catalog-audit');
  const paths = [servicePath, gameConfigPath, storePath, networkPath,
    protoPath, utilsPath, statusPath, auditPath];
  const previous = new Map(paths.map(file => [file, require.cache[file]]));

  require.cache[gameConfigPath] = mockModule(gameConfigPath, {
    getFruitName: () => '',
    getPlantByFruitId: () => null,
    getPlantBySeedId: () => null,
    getItemById: () => null,
    getItemImageById: () => '',
    getSeedLevel: () => 1,
    getSeedImageBySeedId: () => '',
    getSeedImageByName: () => null,
    getPlantImageByPhase: () => '',
    isSeedItem: () => false,
  });
  require.cache[storePath] = mockModule(storePath, { isAutomationOn: () => false });
  require.cache[networkPath] = mockModule(networkPath, {
    sendMsgAsync,
    networkEvents: { on: () => {}, off: () => {} },
    getUserState: () => ({ gold: 0, exp: 0 }),
  });
  require.cache[protoPath] = mockModule(protoPath, {
    types: {
      BagRequest: makeType(),
      BagReply: makeType(),
      SellRequest: makeType(),
      SellReply: makeType(),
      UseRequest: makeType(),
      UseReply: makeType(),
    },
  });
  require.cache[utilsPath] = mockModule(utilsPath, {
    toLong: value => value,
    toNum: value => Number(value) || 0,
    log: () => {},
    logWarn: () => {},
    sleep: async () => {},
  });
  require.cache[statusPath] = mockModule(statusPath, { updateStatusGold: () => {} });
  require.cache[auditPath] = mockModule(auditPath, {
    auditBagSeedCoverage: () => ({ issues: [] }),
  });
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

function bagBody(items) {
  return { item_bag: { items } };
}

test('面板背包读取合并并发并复用 60 秒本地缓存', async () => {
  let upstreamBagCalls = 0;
  let finishRequest;
  const fixture = loadWarehouseFixture(async (service, method) => {
    if (method !== 'Bag') throw new Error(`unexpected rpc ${method}`);
    upstreamBagCalls += 1;
    return new Promise(resolve => { finishRequest = resolve; });
  });

  try {
    const first = fixture.service.getBagSeedsForPanel();
    const concurrent = fixture.service.getBagSeedsForPanel();
    assert.equal(upstreamBagCalls, 1);
    finishRequest({ body: bagBody([{ id: 1001, count: 5 }]) });

    await Promise.all([first, concurrent]);
    // 缓存命中：后续面板读取不再穿透上游
    await fixture.service.getBagSeedsForPanel();
    const detail = await fixture.service.getBagDetail();
    assert.equal(upstreamBagCalls, 1);
    assert.equal(detail.totalKinds, 1);
    assert.equal(fixture.service.BAG_PANEL_CACHE_MS, 60_000);
  } finally {
    fixture.restore();
  }
});

test('Use 成功后缓存失效，下一次面板读取拿到新背包', async () => {
  // uid=0 时 useItem 先用无缓存的 getBag() 查物品 UID（第三次上游读取不经过面板缓存）
  const bodies = [
    { body: bagBody([{ id: 1001, count: 5 }]) },
    { body: bagBody([{ id: 20001, count: 1, uid: 77 }]) },
    { body: bagBody([{ id: 1001, count: 9 }]) },
  ];
  const seen = [];
  const fixture = loadWarehouseFixture(async (service, method) => {
    seen.push(method);
    if (method === 'Bag') return bodies.shift();
    return { body: {} };
  });

  try {
    const before = await fixture.service.getBagDetail();
    assert.equal(before.items[0].count, 5);

    await fixture.service.useItem(20001, 1);

    const after = await fixture.service.getBagDetail();
    assert.equal(after.items[0].count, 9);
    assert.deepEqual(seen, ['Bag', 'Bag', 'Use', 'Bag']);
  } finally {
    fixture.restore();
  }
});

test('Sell 成功后缓存失效，种植 getBagSeeds 始终新鲜不缓存', async () => {
  const seen = [];
  const fixture = loadWarehouseFixture(async (service, method) => {
    seen.push(method);
    return { body: bagBody([{ id: 1001, count: 1 }]) };
  });

  try {
    await fixture.service.getBagSeedsForPanel();
    await fixture.service.getBagSeedsForPanel();
    await fixture.service.sellItems([{ id: 40001, count: 2 }]);
    // 失效后面板读取重新穿透一次
    await fixture.service.getBagSeedsForPanel();
    // 种植路径每次都直读上游
    await fixture.service.getBagSeeds();
    await fixture.service.getBagSeeds();
    assert.deepEqual(seen, ['Bag', 'Sell', 'Bag', 'Bag', 'Bag']);
  } finally {
    fixture.restore();
  }
});

test('上游失败后 60 秒冷却，面板轮询不形成重试风暴', async () => {
  let upstreamBagCalls = 0;
  const fixture = loadWarehouseFixture(async (service, method) => {
    if (method !== 'Bag') return { body: {} };
    upstreamBagCalls += 1;
    throw new Error('unknown upstream response');
  });

  try {
    await assert.rejects(fixture.service.getBagDetail(), /unknown upstream/);
    await assert.rejects(fixture.service.getBagSeedsForPanel(), /冷却/);
    await assert.rejects(fixture.service.getBagSeedsForPanel(), /冷却/);
    assert.equal(upstreamBagCalls, 1);
  } finally {
    fixture.restore();
  }
});
