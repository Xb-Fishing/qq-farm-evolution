const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// 快车道偷菜 daily 记录写明实际果实（2026-10-04）：真实 fastLaneSteal 调用链
// （真实 stealHarvest → 真实 proto 编解码 → 真实 sumHarvestItemCount → 真实
// fastLaneDailyText），仅在上游传输（sendMsgAsync）与好友边界（重点/在线/
// 进门 API/daily 记录）注入可控模拟。断言：单一/混合果实与黄金· 变异按
// 权威 getPlantByFruitId 写实名；杂物 1028 不进数量与名称；回包缺 items 不
// 编造数量、不宣称偷到果实（只报处理块数，推送作物名至多作"观察作物"引用
// 并标注"到手果实未确认"）；每次只发 1 个原生 Harvest、零 Enter/CheckCanOperate。
// 好友 GID 全部为合成 ID。
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fastlane-harvest-name-'));
process.env.FARM_DATA_DIR = DATA_DIR;

const state = {
  harvestBodies: [],  // 每次原生 Harvest 请求解码后的 land_ids
  enters: 0,
  checks: 0,
  daily: [],          // recordEvent 捕获
  replyItems: null,   // 当前场景 HarvestReply.items
  priorityGids: new Set(),
  online: true,
};

function mockModule(filename, exports) {
  return { id: filename, filename, loaded: true, exports };
}

const networkPath = require.resolve('../src/utils/network');
const dailyPath = require.resolve('../src/services/daily-events');
const warehousePath = require.resolve('../src/services/warehouse');
const watchPath = require.resolve('../src/services/fertilizer-watch');
const activityPath = require.resolve('../src/services/friend-activity');
const apiPath = require.resolve('../src/services/friend-api');

require.cache[networkPath] = mockModule(networkPath, {
  sendMsgAsync: async (serviceName, methodName, payload) => {
    assert.equal(serviceName, 'gamepb.plantpb.PlantService');
    if (methodName === 'Harvest') {
      const { types } = require('../src/utils/proto');
      state.harvestBodies.push(types.HarvestRequest.decode(payload).land_ids.map(Number));
      return {
        body: types.HarvestReply.encode(types.HarvestReply.create({
          items: state.replyItems || [],
        })).finish(),
      };
    }
    throw new Error(`合成场景不应出现 ${methodName} 请求`);
  },
  getUserState: () => ({ accountId: 'fixture-account', level: 200, gold: 1000 }),
  getWsErrorState: () => null,
});
require.cache[dailyPath] = mockModule(dailyPath, {
  recordEvent: (accountId, level, event, message) => {
    state.daily.push({ accountId, level, event, message });
  },
});
require.cache[warehousePath] = mockModule(warehousePath, {
  sellAllFruits: async () => ({}),
});
require.cache[watchPath] = mockModule(watchPath, {
  inspectFriendLands: () => null,
  unwatchFriend: () => {},
  isPriorityGid: gid => state.priorityGids.has(Number(gid)),
});
require.cache[activityPath] = mockModule(activityPath, {
  isFriendOnlineRecently: () => state.online,
  noteEnterPresence: () => null,
  resolveFriendDisplayName: (_, name) => name,
});
require.cache[apiPath] = mockModule(apiPath, {
  enterFriendFarm: async () => { state.enters += 1; return {}; },
  leaveFriendFarm: async () => ({}),
  checkCanOperateRemote: async () => { state.checks += 1; return { can_operate: true }; },
  handleFriendEnterError: () => ({ handled: false }),
});

const DOGTAIL_FRUIT = 40516;      // 狗尾草果实
const GOLDEN_DOGTAIL_FRUIT = 1040516; // 黄金·狗尾草果实
const SCRAP = 1028;               // 萌宠元气糕（杂物）
const DOGTAIL_PLANT = 1020516;
const UNKNOWN_PLANT = 999999999;

function ripeLand(landId, plantId = DOGTAIL_PLANT) {
  const matureAt = Math.floor(Date.now() / 1000) - 10;
  return { id: landId, plant: { id: plantId, season: 1, phases: [{ phase: 5, begin_time: matureAt - 60 }, { phase: 6, begin_time: matureAt }] } };
}

async function loadServices() {
  await require('../src/utils/proto').loadProto();
  return require('../src/services/friend-visit');
}

async function runFastLane(gid, lands) {
  state.priorityGids.add(gid);
  const { fastLaneSteal } = await loadServices();
  const before = state.daily.length;
  fastLaneSteal(gid, lands);
  const deadline = Date.now() + 5_000;
  while (state.daily.length <= before && Date.now() < deadline) {
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.ok(state.daily.length > before, '快车道 daily 记录未产生');
  return state.daily[state.daily.length - 1];
}

test('单一果实：daily 写实名+数量，原生 Harvest 恰一次，零 Enter/Check', async () => {
  state.replyItems = [{ id: DOGTAIL_FRUIT, count: 24 }, { id: SCRAP, count: 2 }];
  const record = await runFastLane(987654321, [ripeLand(3), ripeLand(7)]);

  assert.equal(record.event, 'steal');
  assert.equal(record.message, '快车道偷取 狗尾草×24（2 块地，推送直达）');
  assert.deepEqual(state.harvestBodies, [[3, 7]]);
  assert.equal(state.enters, 0);
  assert.equal(state.checks, 0);
});

test('混合果实与黄金· 变异：全部按权威映射写全名', async () => {
  state.replyItems = [
    { id: DOGTAIL_FRUIT, count: 24 },
    { id: GOLDEN_DOGTAIL_FRUIT, count: 10 },
    { id: SCRAP, count: 5 },
  ];
  const record = await runFastLane(987654322, [ripeLand(1), ripeLand(2)]);

  assert.equal(record.message, '快车道偷取 狗尾草×24，黄金·狗尾草×10（2 块地，推送直达）');
});

test('只有杂物/回包缺 items：不宣称偷到果实，只如实报处理块数', async () => {
  // items 里只有杂物：数量与名称都不计；推送作物名只作"观察作物"引用，
  // 明确"到手果实未确认"，不再写"偷取 狗尾草N块地"暗示已得手。
  state.replyItems = [{ id: SCRAP, count: 3 }];
  let record = await runFastLane(987654323, [ripeLand(4)]);
  assert.equal(record.message, '快车道已处理 1 块地（推送直达，观察作物：狗尾草，到手果实未确认）');

  // 回包完全没有 items：同样回退推送名，措辞一致。
  state.replyItems = [];
  state.daily = [];
  record = await runFastLane(987654324, [ripeLand(5), ripeLand(6)]);
  assert.equal(record.message, '快车道已处理 2 块地（推送直达，观察作物：狗尾草，到手果实未确认）');

  // 推送地块作物也未知：只报块数与未确认，不提作物名。
  state.replyItems = [];
  state.daily = [];
  record = await runFastLane(987654325, [ripeLand(8, UNKNOWN_PLANT)]);
  assert.equal(record.message, '快车道已处理 1 块地（推送直达，到手果实未确认）');
});

test.after(() => fs.rmSync(DATA_DIR, { recursive: true, force: true }));
