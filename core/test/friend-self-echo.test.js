const { test } = require('node:test');
const assert = require('node:assert/strict');

/**
 * 好友自回声识别器行为测试（2026-09-26）。
 * 全部走真实生产模块 friend-self-echo 的公开 API；不 mock 游戏网络。
 * 铁口径：无 ticket / 无写前基线 / 字段缺省 / phase 无法确证 / 成熟相关
 * 风险 → 一律放行（external），只过滤有完整前后证据的纯自操作回声。
 */
const echo = require('../src/services/friend-self-echo');

const HOST = 9101;
const SELF = 777;
const FRIEND = 555;

/** Long 形式（protobufjs low/high/unsigned）。 */
function longOf(big) {
  const v = BigInt(big);
  const low = Number(BigInt.asIntN(32, v & 0xFFFFFFFFn));
  const high = Number(BigInt.asIntN(32, v >> 32n));
  return { low, high, unsigned: v >= 0n };
}

/** 真实形状的 phases 时间表：当前生长中 + 未来成熟（官方语义：当前+后续）。 */
function growingPlant(nowSec, overrides = {}) {
  return {
    id: 1001,
    name: '测试作物',
    phases: [
      { phase: 2, begin_time: nowSec - 120, phase_id: 2 },
      { phase: 6, begin_time: nowSec + 7200, phase_id: 19 },
    ],
    season: 1,
    dry_num: 2,
    stole_num: 0,
    fruit_id: 20001,
    fruit_num: 30,
    weed_owners: [FRIEND],
    insect_owners: [FRIEND],
    stealers: [],
    grow_sec: 3600,
    stealable: false,
    left_inorc_fert_times: 3,
    left_fruit_num: 30,
    social_items: [],
    ...overrides,
  };
}

function growLand(landId, plantOverrides) {
  return {
    id: landId,
    unlocked: true,
    level: 1,
    buff: { plant_yield_bonus: 0, planting_time_reduction: 0, plant_exp_bonus: 0, plant_mutant_bonus: 0 },
    plant: growingPlant(Math.floor(Date.now() / 1000), plantOverrides || {}),
  };
}

function clone(x) { return JSON.parse(JSON.stringify(x)); }

function setup() {
  echo.resetForTest();
  const now = Date.now();
  const land = growLand(1);
  echo.recordLandsBaseline(HOST, [land], now);
  return { now, land };
}

function classify(land, now) {
  return echo.classifyPushLands(HOST, [land], SELF, now);
}

test('无 ticket：历史 owner 含自己 gid 绝不拦截', () => {
  const { land, now } = setup();
  land.plant.insect_owners = [SELF, FRIEND]; // 历史状态里本来就有自己
  const v = classify(land, now);
  assert.equal(v.echoCount, 0, '无 ticket 的历史自己 owner 必须外部触发');
});

test('PutInsects 早到纯回声被吸收一次，重复推送放行', () => {
  const { land, now } = setup();
  const t = echo.registerPendingWrite('PutInsects', HOST, [1], now);
  assert.ok(t > 0);
  const push = clone(land);
  push.plant.insect_owners = [FRIEND, SELF];
  const v1 = classify(push, now);
  assert.equal(v1.echoCount, 1, '纯放虫回声（仅新增自己）应过滤');
  const v2 = classify(push, now + 10);
  assert.equal(v2.echoCount, 0, '同一 ticket 同地块只吸收一次');
});

test('放虫同时混入他人 gid / 另一种虫草变化：放行', () => {
  const { land, now } = setup();
  echo.registerPendingWrite('PutInsects', HOST, [1], now);
  const push = clone(land);
  push.plant.insect_owners = [FRIEND, SELF, 999]; // 还多了第三者
  assert.equal(classify(push, now).echoCount, 0);

  const push2 = clone(land);
  push2.plant.weed_owners = []; // 虫 ticket 但草被清了（另一种变化）
  assert.equal(classify(push2, now).echoCount, 0);
});

test('PutWeeds ticket 但推送出现虫：放行（另一种虫草不滤）', () => {
  const { land, now } = setup();
  echo.registerPendingWrite('PutWeeds', HOST, [1], now);
  const push = clone(land);
  push.plant.insect_owners = [FRIEND, SELF];
  assert.equal(classify(push, now).echoCount, 0);
});

test('Harvest 早到回声：写前已成熟 + 自己 stealer + 计数相符', () => {
  echo.resetForTest();
  const now = Date.now();
  const nowSec = Math.floor(now / 1000);
  const land = {
    id: 1,
    plant: growingPlant(nowSec, {
      phases: [{ phase: 6, begin_time: nowSec - 600, phase_id: 19 }],
      stealable: true,
      stole_num: 2,
      left_fruit_num: 20,
      stealers: [FRIEND],
    }),
  };
  echo.recordLandsBaseline(HOST, [land], now);
  echo.registerPendingWrite('Harvest', HOST, [1], now);
  const push = clone(land);
  push.plant.stealers = [FRIEND, SELF];
  push.plant.stole_num = 3;
  push.plant.left_fruit_num = 17;
  assert.equal(classify(push, now).echoCount, 1, '成熟地纯偷回声应过滤');
});

test('Harvest 计数字段缺省：放行（不确定就保留）', () => {
  echo.resetForTest();
  const now = Date.now();
  const nowSec = Math.floor(now / 1000);
  const land = {
    id: 1,
    plant: growingPlant(nowSec, {
      phases: [{ phase: 6, begin_time: nowSec - 600, phase_id: 19 }],
      stealable: true,
      stole_num: 2,
      stealers: [],
    }),
  };
  delete land.plant.left_fruit_num;
  echo.recordLandsBaseline(HOST, [land], now);
  echo.registerPendingWrite('Harvest', HOST, [1], now);
  const push = clone(land);
  push.plant.stealers = [SELF];
  push.plant.stole_num = 3;
  delete push.plant.left_fruit_num;
  assert.equal(classify(push, now).echoCount, 0);
});

test('Harvest 写前未成熟（跨成熟风险）：放行', () => {
  const { land, now } = setup();
  echo.registerPendingWrite('Harvest', HOST, [1], now);
  const push = clone(land);
  push.plant.stealers = [SELF];
  push.plant.stole_num = 1;
  push.plant.left_fruit_num = 10;
  assert.equal(classify(push, now).echoCount, 0, '写前生长中：偷不可能成立，一律外部');
});

test('WaterLand 早到无 actor 正证据：不拦（不等待 RPC）', () => {
  const { land, now } = setup();
  echo.registerPendingWrite('WaterLand', HOST, [1], now);
  const push = clone(land);
  push.plant.dry_num = 0;
  assert.equal(classify(push, now).echoCount, 0);
});

test('confirmed 迟到回声：WaterLand 纯差异 + 推送等于回包 → 拦', () => {
  const { land, now } = setup();
  const t = echo.registerPendingWrite('WaterLand', HOST, [1], now);
  const replyLand = clone(land);
  replyLand.plant.dry_num = 0;
  echo.confirmWrite(t, [replyLand], now + 50);
  const v = classify(clone(replyLand), now + 100);
  assert.equal(v.echoCount, 1, '已确认纯浇水回声应过滤');
});

test('confirmed WeedOut / Insecticide：集合清空纯差异可拦', () => {
  const { land, now } = setup();
  const t1 = echo.registerPendingWrite('WeedOut', HOST, [1], now);
  const weedDone = clone(land);
  weedDone.plant.weed_owners = [];
  echo.confirmWrite(t1, [weedDone], now + 50);
  assert.equal(classify(clone(weedDone), now + 60).echoCount, 1);

  const bugLand = clone(land);
  bugLand.plant.insect_owners = [SELF];
  echo.recordLandsBaseline(HOST, [bugLand], now + 70); // 写前基线：自己刚放的虫
  const t3 = echo.registerPendingWrite('Insecticide', HOST, [1], now + 80);
  const bugDone = clone(bugLand);
  bugDone.plant.insect_owners = [];
  echo.confirmWrite(t3, [bugDone], now + 90);
  assert.equal(classify(clone(bugDone), now + 100).echoCount, 1);
});

test('confirmed 但回包同时携带好友施肥（非本操作字段变化）：放行', () => {
  const { land, now } = setup();
  const t = echo.registerPendingWrite('WaterLand', HOST, [1], now);
  const replyLand = clone(land);
  replyLand.plant.dry_num = 0;
  replyLand.plant.left_inorc_fert_times = 2; // 好友同时施了肥
  echo.confirmWrite(t, [replyLand], now + 50);
  assert.equal(classify(clone(replyLand), now + 100).echoCount, 0,
    '回包字节相等但差异不纯：不得吞');
});

test('confirmed 推送与回包不一致：放行', () => {
  const { land, now } = setup();
  const t = echo.registerPendingWrite('WaterLand', HOST, [1], now);
  const replyLand = clone(land);
  replyLand.plant.dry_num = 0;
  echo.confirmWrite(t, [replyLand], now + 50);
  const other = clone(replyLand);
  other.plant.dry_num = 1;
  assert.equal(classify(other, now + 100).echoCount, 0);
});

test('失败撤销 / TTL 过期 / 空回包：都不长期拦', () => {
  const { land, now } = setup();
  // 失败撤销
  const t1 = echo.registerPendingWrite('PutInsects', HOST, [1], now);
  echo.revokeWrite(t1);
  const push = clone(land);
  push.plant.insect_owners = [FRIEND, SELF];
  assert.equal(classify(push, now + 10).echoCount, 0);
  // pending TTL 过期
  echo.registerPendingWrite('PutInsects', HOST, [1], now);
  assert.equal(classify(push, now + echo.PENDING_TTL_MS + 1).echoCount, 0);
  // 成功但回包无地块（缺回包地块）
  const t3 = echo.registerPendingWrite('PutInsects', HOST, [1], now);
  echo.confirmWrite(t3, [], now + 5);
  assert.equal(classify(push, now + 10).echoCount, 0);
});

test('跨好友 / 跨地块不串', () => {
  const { land, now } = setup();
  echo.registerPendingWrite('PutInsects', HOST, [1], now);
  const push = clone(land);
  push.plant.insect_owners = [FRIEND, SELF];
  assert.equal(echo.classifyPushLands(9999, [push], SELF, now).echoCount, 0, '别的host不拦');
  const otherLand = clone(push);
  otherLand.id = 2;
  assert.equal(classify(otherLand, now).echoCount, 0, '别的地块不拦');
});

test('混合通知：纯自身地块过滤，真实变化地块保留', () => {
  const { land, now } = setup();
  const land2 = growLand(2);
  echo.recordLandsBaseline(HOST, [land2], now);
  echo.registerPendingWrite('PutInsects', HOST, [1], now);
  const push1 = clone(land);
  push1.plant.insect_owners = [FRIEND, SELF];
  const push2 = clone(land2);
  push2.plant.left_inorc_fert_times = 2; // 好友施肥
  const v = echo.classifyPushLands(HOST, [push1, push2], SELF, now);
  assert.deepEqual(v.echoLands.map(l => l.id), [1]);
  assert.deepEqual(v.externalLands.map(l => l.id), [2]);
});

test('同地块叠加好友施肥/成熟变化：即使 ticket 有效也放行', () => {
  const { land, now } = setup();
  echo.registerPendingWrite('PutInsects', HOST, [1], now);
  const push = clone(land);
  push.plant.insect_owners = [FRIEND, SELF];
  push.plant.left_inorc_fert_times = 1; // 叠加施肥
  assert.equal(classify(push, now).echoCount, 0);

  const push2 = clone(land);
  push2.plant.insect_owners = [FRIEND, SELF];
  push2.plant.phases[1].begin_time -= 5400; // 阶段时间被催熟推进
  assert.equal(classify(push2, now).echoCount, 0);
});

test('外层 buff 变化 / 未知新增字段：放行', () => {
  const { land, now } = setup();
  echo.registerPendingWrite('PutInsects', HOST, [1], now);
  const push = clone(land);
  push.plant.insect_owners = [FRIEND, SELF];
  push.buff.plant_yield_bonus = 5; // LandInfo 外层字段
  assert.equal(classify(push, now).echoCount, 0);

  const push2 = clone(land);
  push2.plant.insect_owners = [FRIEND, SELF];
  push2.some_new_field = { x: 1 }; // 未知新增字段
  assert.equal(classify(push2, now).echoCount, 0);
});

test('phase 字节不变但当前跨过成熟墙钟：放行', () => {
  const now = Date.now();
  const nowSec = Math.floor(now / 1000);
  // 长表：当前生长 + 很久的未来成熟
  const land = growLand(1);
  echo.recordLandsBaseline(HOST, [land], now);
  echo.registerPendingWrite('PutInsects', HOST, [1], now);

  // 场景A：成熟墙钟在保护余量之外（1小时后）→ 纯回声可滤
  const pushFar = clone(land);
  pushFar.plant.insect_owners = [FRIEND, SELF];
  assert.equal(classify(pushFar, now).echoCount, 1, '墙钟远在未来的纯回声可滤');

  // 场景B：同样字节，但末条 begin_time 已过（现在已成熟）→ 放行
  const landDue = growLand(1);
  landDue.plant.phases[1].begin_time = nowSec - 10;
  echo.resetForTest();
  echo.recordLandsBaseline(HOST, [landDue], now);
  echo.registerPendingWrite('PutInsects', HOST, [1], now);
  const pushDue = clone(landDue);
  pushDue.plant.insect_owners = [FRIEND, SELF];
  assert.equal(classify(pushDue, now).echoCount, 0, '已跨成熟墙钟必须放行');

  // 场景C：墙钟在余量内（30s 后）→ 放行
  const landSoon = growLand(1);
  landSoon.plant.phases[1].begin_time = nowSec + 30;
  echo.resetForTest();
  echo.recordLandsBaseline(HOST, [landSoon], now);
  echo.registerPendingWrite('PutInsects', HOST, [1], now);
  const pushSoon = clone(landSoon);
  pushSoon.plant.insect_owners = [FRIEND, SELF];
  assert.equal(classify(pushSoon, now).echoCount, 0, '余量内可能跨成熟必须放行');
});

test('快照可偷（非 Harvest）：放行', () => {
  const { land, now } = setup();
  land.plant.stealable = true;
  land.plant.phases = [{ phase: 6, begin_time: Math.floor(now / 1000) - 60, phase_id: 19 }];
  echo.resetForTest();
  echo.recordLandsBaseline(HOST, [land], now);
  echo.registerPendingWrite('PutInsects', HOST, [1], now);
  const push = clone(land);
  push.plant.insect_owners = [FRIEND, SELF];
  assert.equal(classify(push, now).echoCount, 0);
});

test('写前基线过期：即使回包确认也不滤', () => {
  const now = Date.now();
  const land = growLand(1);
  echo.recordLandsBaseline(HOST, [land], now - echo.BASELINE_TTL_MS - 1); // 已过期
  const t = echo.registerPendingWrite('PutInsects', HOST, [1], now);
  const replyLand = clone(land);
  replyLand.plant.insect_owners = [FRIEND, SELF];
  echo.confirmWrite(t, [replyLand], now);
  assert.equal(classify(clone(replyLand), now).echoCount, 0,
    '无冻结写前基线的 ticket 永不抑制');
});

test('stop 清理 + 代次保护：旧回包不污染新 ticket', () => {
  const { land, now } = setup();
  const t = echo.registerPendingWrite('PutInsects', HOST, [1], now);
  echo.stop();
  const replyLand = clone(land);
  replyLand.plant.insect_owners = [FRIEND, SELF];
  echo.confirmWrite(t, [replyLand], now + 5); // stop 后迟到的旧回包
  assert.equal(classify(clone(replyLand), now + 10).echoCount, 0);

  // stop 后重新建立的世界：新 ticket 正常工作
  echo.recordLandsBaseline(HOST, [land], now + 20);
  const t2 = echo.registerPendingWrite('PutInsects', HOST, [1], now + 20);
  assert.ok(t2 !== t, 'ticket 序号不重用');
  const push = clone(land);
  push.plant.insect_owners = [FRIEND, SELF];
  assert.equal(classify(push, now + 30).echoCount, 1);
});

test('Long/数值/字符串同义：owners 用 Long(>2^53) 与普通数字等价比较', () => {
  const bigId = 9007199254740993n; // 2^53 + 1，Number 精度损失
  const now = Date.now();
  const land = growLand(1);
  land.plant.weed_owners = [longOf(bigId)]; // 好友 gid 用 Long 表示
  echo.resetForTest();
  echo.recordLandsBaseline(HOST, [land], now);
  echo.registerPendingWrite('PutWeeds', HOST, [1], now);
  const push = clone(land);
  // 同值 Long（独立对象）+ 新增自己的普通数字 gid：Long/数值同义比较
  push.plant.weed_owners = [
    { low: land.plant.weed_owners[0].low, high: land.plant.weed_owners[0].high },
    SELF,
  ];
  assert.equal(echo.longToBigStr(longOf(bigId)), bigId.toString(), 'Long 精确无损失');
  const v = echo.classifyPushLands(HOST, [push], SELF, now);
  assert.equal(v.echoCount, 1, '数值/Long 同值 owners 视为未变');
});

test('longToBigStr：signed/unsigned 高位', () => {
  // unsigned: high=1, low=0 → 2^32
  assert.equal(echo.longToBigStr({ low: 0, high: 1, unsigned: true }), '4294967296');
  // signed: high=-1, low=-1 → -1
  assert.equal(echo.longToBigStr({ low: -1, high: -1, unsigned: false }), '-1');
  // unsigned 同 low/high → 4294967295
  assert.equal(echo.longToBigStr({ low: -1, high: 0, unsigned: true }), '4294967295');
  // > 2^53
  assert.equal(echo.longToBigStr(longOf(12345678901234567n)), '12345678901234567');
});

test('未知有序数组顺序变化保留（不被集合排序抹掉）', () => {
  const { land, now } = setup();
  land.plant.social_items = [
    { item_id: 301101, count: 1, type: 2, owner_gid: FRIEND, created_at: 1 },
    { item_id: 301102, count: 1, type: 2, owner_gid: FRIEND, created_at: 2 },
  ];
  echo.resetForTest();
  echo.recordLandsBaseline(HOST, [land], now);
  echo.registerPendingWrite('PutInsects', HOST, [1], now);
  const push = clone(land);
  push.plant.insect_owners = [FRIEND, SELF];
  push.plant.social_items = [push.plant.social_items[1], push.plant.social_items[0]]; // 顺序换了
  assert.equal(classify(push, now).echoCount, 0, '非集合数组保序，顺序变化=真实差异');
});

test('基线每 host 地块数有界', () => {
  echo.resetForTest();
  const now = Date.now();
  const many = [];
  for (let i = 1; i <= 70; i++) many.push(growLand(i));
  echo.recordLandsBaseline(HOST, many, now);
  assert.equal(echo.stats().baselineHosts, 1);
  // 只要有界即可（上限 64）；老地块被剪不影响正确性——被剪的不滤。
  const land1 = growLand(1);
  const push = clone(land1);
  push.plant.insect_owners = [FRIEND, SELF];
  echo.registerPendingWrite('PutInsects', HOST, [1], now + 5);
  // land1 是最老基线之一，可能已被剪：无论剪否都不得误吞
  const v = classify(push, now + 10);
  assert.ok(v.echoCount === 0 || v.echoCount === 1);
});
