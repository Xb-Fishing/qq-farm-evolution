'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/**
 * 神秘商人面板缓存的「服务级」并发语义（2026-10-04）：
 * 失效后的旧在途读取不回填旧值、迟到拒绝不污染新状态、模块级缓存/冷却
 * 按 Worker 实例隔离。直接驱动真实商人服务的面板函数
 * （getMysteryShopForPanel，本轮新增），仅在上游传输边界注入可控模拟。
 *
 * 本文件用新增服务入口，不进「旧行为基线」组（基线组 =
 * mystery-panel-cache.test.js，只走旧 handleApiCall 调用链）。
 */

// 独立数据目录：在任何业务模块加载前设置（skill 隔离硬规则）
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mystery-inflight-'));
process.env.FARM_DATA_DIR = DATA_DIR;

const NPC_ID = 710001;
const ITEM_ID = 60001;

function activeOffer() {
  return {
    active: true,
    npc: {
      npc_id: NPC_ID, item_id: ITEM_ID, item_type: 1, item_count: 2,
      currency_id: 1001, price: 500, original_price: 1000, discount: 50,
      purchased: false,
    },
    start_time: 1000, end_time: 0,
  };
}

function emptyReply() {
  return { active: false, npc: {}, start_time: 0, end_time: 0 };
}

function buyReply() {
  return { reward: { item_id: ITEM_ID, count: 2 }, npc: { purchased: true } };
}

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

/** 加载真实商人服务，仅在上游边界注入可控模拟（与面板缓存基线同边界）。 */
function loadMysteryFixture() {
  const servicePath = require.resolve('../src/services/mystery-shop');
  const gameConfigPath = require.resolve('../src/config/gameConfig');
  const storePath = require.resolve('../src/models/store');
  const networkPath = require.resolve('../src/utils/network');
  const protoPath = require.resolve('../src/utils/proto');
  const utilsPath = require.resolve('../src/utils/utils');
  const paths = [servicePath, gameConfigPath, storePath, networkPath,
    protoPath, utilsPath];
  const previous = new Map(paths.map(file => [file, require.cache[file]]));

  const transport = {
    calls: [],
    server: { offer: activeOffer(), automation: {} },
    routes: {},
  };
  transport.routes.GetActiveNPC = () => ({ body: transport.server.offer });
  transport.routes.Buy = () => {
    transport.server.offer = emptyReply();
    return { body: buyReply() };
  };
  transport.routes.Abandon = () => {
    transport.server.offer = emptyReply();
    return { body: {} };
  };

  require.cache[gameConfigPath] = mockModule(gameConfigPath, {
    getItemById: () => null,
    getItemImageById: () => '',
  });
  require.cache[storePath] = mockModule(storePath, {
    getAutomation: () => transport.server.automation,
  });
  require.cache[networkPath] = mockModule(networkPath, {
    sendMsgAsync: async (service, method) => {
      transport.calls.push(method);
      const route = transport.routes[method];
      if (!route) throw new Error(`unexpected rpc ${method}`);
      return route();
    },
  });
  const replyType = makeType();
  require.cache[protoPath] = mockModule(protoPath, {
    types: {
      GetActiveMysteryNPCRequest: makeType(),
      GetActiveMysteryNPCReply: replyType,
      BuyMysteryShopRequest: makeType(),
      BuyMysteryShopReply: makeType(),
      AbandonMysteryShopRequest: makeType(),
      AbandonMysteryShopReply: makeType(),
    },
  });
  require.cache[utilsPath] = mockModule(utilsPath, {
    toNum: value => Number(value) || 0,
    log: () => {},
    logWarn: () => {},
  });
  delete require.cache[servicePath];

  return {
    service: require(servicePath),
    transport,
    restore() {
      for (const file of paths) {
        if (previous.get(file)) require.cache[file] = previous.get(file);
        else delete require.cache[file];
      }
    },
  };
}

const readCount = transport => transport.calls.filter(c => c === 'GetActiveNPC').length;
const buyCount = transport => transport.calls.filter(c => c === 'Buy').length;

/** 上游读取挂起控制：按次序把每次 GetActiveNPC 挂到独立手动门上。 */
function gatedReads(transport) {
  const gates = [];
  transport.routes.GetActiveNPC = () => new Promise((resolve, reject) => {
    gates.push({ resolve, reject });
  });
  return gates;
}

test.after(() => {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

// ==================== 1. 失效后的旧在途读取：成功不回填 ====================

test('旧读取 A 在失效后完成：先于 B 或晚于 B 均不得回填旧值，B 挂起期间第三次读取合并 B', { timeout: 5000 }, async () => {
  // 场景一：A 先于 B 完成
  {
    const fixture = loadMysteryFixture();
    const gates = gatedReads(fixture.transport);
    try {
      const readA = fixture.service.getMysteryShopForPanel();
      await fixture.service.buyMysteryShopGoods(NPC_ID);
      const readB = fixture.service.getMysteryShopForPanel();
      assert.equal(readCount(fixture.transport), 2);
      assert.equal(buyCount(fixture.transport), 1);

      gates[0].resolve({ body: activeOffer() });
      const a = await readA;
      assert.equal(a.active, true, '旧调用方仍拿到旧值');

      const readC = fixture.service.getMysteryShopForPanel();
      assert.equal(readCount(fixture.transport), 2, 'B 挂起期间第三次读取合并 B');

      gates[1].resolve({ body: emptyReply() });
      const [b, c] = await Promise.all([readB, readC]);
      assert.equal(b.active, false);
      assert.deepEqual(c, b);

      const hit = await fixture.service.getMysteryShopForPanel();
      assert.equal(hit.active, false, '旧值未回填，缓存为新值');
      assert.equal(readCount(fixture.transport), 2);
    } finally {
      fixture.restore();
    }
  }

  // 场景二：A 晚于 B 完成
  {
    const fixture = loadMysteryFixture();
    const gates = gatedReads(fixture.transport);
    try {
      const readA = fixture.service.getMysteryShopForPanel();
      await fixture.service.buyMysteryShopGoods(NPC_ID);
      const readB = fixture.service.getMysteryShopForPanel();

      gates[1].resolve({ body: emptyReply() });
      const b = await readB;
      assert.equal(b.active, false);

      gates[0].resolve({ body: activeOffer() });
      const a = await readA;
      assert.equal(a.active, true, '旧调用方拿到旧值');

      const hit = await fixture.service.getMysteryShopForPanel();
      assert.equal(hit.active, false, '迟到的旧值不能覆盖已缓存的新值');
      assert.equal(readCount(fixture.transport), 2);
    } finally {
      fixture.restore();
    }
  }
});

// ==================== 2. 失效后的旧在途读取：迟到拒绝不污染新状态 ====================

test('旧读取 A 迟到拒绝：不设置新失败冷却、不清除 B，B 结果正常缓存', { timeout: 5000 }, async () => {
  // 场景一：A 拒绝发生在 B 挂起期间
  {
    const fixture = loadMysteryFixture();
    const gates = gatedReads(fixture.transport);
    try {
      const readA = fixture.service.getMysteryShopForPanel();
      await fixture.service.buyMysteryShopGoods(NPC_ID);
      const readB = fixture.service.getMysteryShopForPanel();

      gates[0].reject(new Error('old read failed'));
      await assert.rejects(readA, /old read failed/);

      gates[1].resolve({ body: emptyReply() });
      const b = await readB;
      assert.equal(b.active, false);

      const hit = await fixture.service.getMysteryShopForPanel();
      assert.equal(hit.active, false, 'A 的 catch 未设置冷却，读取命中 B 缓存');
      assert.equal(readCount(fixture.transport), 2);
    } finally {
      fixture.restore();
    }
  }

  // 场景二：A 拒绝发生在 B 完成之后
  {
    const fixture = loadMysteryFixture();
    const gates = gatedReads(fixture.transport);
    try {
      const readA = fixture.service.getMysteryShopForPanel();
      await fixture.service.buyMysteryShopGoods(NPC_ID);
      const readB = fixture.service.getMysteryShopForPanel();

      gates[1].resolve({ body: emptyReply() });
      await readB;

      gates[0].reject(new Error('old read failed late'));
      await assert.rejects(readA, /old read failed late/);

      const hit = await fixture.service.getMysteryShopForPanel();
      assert.equal(hit.active, false, '迟到拒绝不清除已缓存的新值');
      assert.equal(readCount(fixture.transport), 2);
    } finally {
      fixture.restore();
    }
  }
});

// ==================== 3. 模块级状态按 Worker 实例隔离 ====================

test('两个隔离商人模块实例的缓存、冷却与失效互不影响', { timeout: 5000 }, async () => {
  const fixtureA = loadMysteryFixture();
  const fixtureB = loadMysteryFixture();
  try {
    assert.notEqual(fixtureA.service, fixtureB.service);
    assert.equal(fixtureA.service.MYSTERY_PANEL_CACHE_MS, 60_000);

    await fixtureA.service.getMysteryShopForPanel();
    await fixtureB.service.getMysteryShopForPanel();
    assert.equal(readCount(fixtureA.transport), 1);
    assert.equal(readCount(fixtureB.transport), 1);

    await fixtureA.service.getMysteryShopForPanel();
    assert.equal(readCount(fixtureA.transport), 1, 'A 命中自身缓存');
    assert.equal(readCount(fixtureB.transport), 1);

    // A 写失效不影响 B 缓存
    await fixtureA.service.buyMysteryShopGoods(NPC_ID);
    await fixtureA.service.getMysteryShopForPanel();
    await fixtureB.service.getMysteryShopForPanel();
    assert.equal(readCount(fixtureA.transport), 2);
    assert.equal(readCount(fixtureB.transport), 1, 'B 缓存不受 A 失效影响');

    // B 失败冷却不影响 A（先请离失效 B 自身缓存，使其下一次读取真正穿透）
    await fixtureB.service.abandonMysteryShop();
    fixtureB.transport.routes.GetActiveNPC = () => { throw new Error('B upstream down'); };
    await assert.rejects(fixtureB.service.getMysteryShopForPanel(), /B upstream down/);
    await assert.rejects(fixtureB.service.getMysteryShopForPanel(), /冷却/);
    assert.equal(readCount(fixtureB.transport), 2);
    const hitA = await fixtureA.service.getMysteryShopForPanel();
    assert.equal(hitA.active, false, 'A 仍命中自身缓存，B 的冷却不外溢');
    assert.equal(readCount(fixtureA.transport), 2);
  } finally {
    fixtureB.restore();
    fixtureA.restore();
  }
});
