const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// 2x2 预留选择（2026-10-04 窗口规则修正后的回归）：
// 旧夹具用 1970 年附近的成熟时间——max(now, matureAt) 恒等于 now，所有组合
// 恰好都落进 60 秒窗口，规则被假通过。现在直接伪造权威服务器时钟
// getServerTimeSec，并改用真实植物配置（狗尾草=1 季、蘑菇=2 季）。
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'planting-2x2-reservation-'));
process.env.FARM_DATA_DIR = DATA_DIR;

const utilsPath = require.resolve('../src/utils/utils');
const realUtils = require('../src/utils/utils');
let fakeNowSec = 1_700_000_000;
require.cache[utilsPath] = {
  id: utilsPath, filename: utilsPath, loaded: true,
  exports: { ...realUtils, getServerTimeSec: () => fakeNowSec },
};

const { select2x2Reservations } = require('../src/services/planting-service');

const DOGTAIL = 1020516; // 狗尾草：1 季
const MUSHROOM = 1020050; // 蘑菇：2 季，单季 14400s
const now = () => fakeNowSec;

function growingLand(id, matureAt, { plantId = DOGTAIL, season = 1 } = {}) {
  return {
    id,
    unlocked: true,
    plant: { id: plantId, season, phases: [{ phase: 6, begin_time: matureAt }] },
  };
}

function emptyLand(id) {
  return { id, unlocked: true };
}

// 模块内预留状态跨用例泄漏会让断言互相污染；空组合调用即整体复位。
function resetReservationState() {
  select2x2Reservations([], [], 0, []);
}

test('真正同刻并列时保持既有预留；更早清空的组合优先（不再用 60s 容差并列）', () => {
  resetReservationState();
  const groupA = { key: '1-2-5-6', masterLandId: 5, landIds: [5, 6, 1, 2] };
  const groupB = { key: '3-4-7-8', masterLandId: 7, landIds: [7, 8, 3, 4] };

  const first = select2x2Reservations(
    [groupA, groupB],
    [],
    1,
    [
      growingLand(1, now() + 30), growingLand(2, now() + 30),
      growingLand(5, now() + 30), growingLand(6, now() + 30),
      growingLand(3, now() + 30), growingLand(4, now() + 30),
      growingLand(7, now() + 30), growingLand(8, now() + 30),
    ],
  );
  // 两组真正同刻清空：无旧预留时按主地块号稳定选 A。
  assert.deepEqual(first.map(group => group.key), [groupA.key]);

  // A 已圈住空地 1；两组仍真正同刻清空 → 稳定保持 A，不被并列组合挤掉。
  const second = select2x2Reservations(
    [groupA, groupB],
    [1],
    1,
    [
      emptyLand(1), growingLand(2, now() + 20), growingLand(5, now() + 20), growingLand(6, now() + 20),
      growingLand(3, now() + 20), growingLand(4, now() + 20), growingLand(7, now() + 20), growingLand(8, now() + 20),
    ],
  );
  assert.deepEqual(second.map(group => group.key), [groupA.key]);
  assert.ok(second[0].landIds.includes(1));

  // B 真的更早清空（20s vs 5s 的差值不是同一时刻）→ 按"最早清空优先"选 B。
  // 旧的 60 秒容差会把窗口内组合全部当成并列，再用锚点错选 A（2026-10-04 反例）。
  const third = select2x2Reservations(
    [groupA, groupB],
    [1],
    1,
    [
      emptyLand(1), growingLand(2, now() + 20), growingLand(5, now() + 20), growingLand(6, now() + 20),
      growingLand(3, now() + 5), growingLand(4, now() + 5), growingLand(7, now() + 5), growingLand(8, now() + 5),
    ],
  );
  assert.deepEqual(third.map(group => group.key), [groupB.key]);
});

test('真正同刻并列按主地块号稳定；更早清空优先于主地块号', () => {
  resetReservationState();
  const upper = { key: '3-4-7-8', masterLandId: 7, landIds: [7, 8, 3, 4] };
  const lower = { key: '7-8-11-12', masterLandId: 11, landIds: [11, 12, 7, 8] };

  // 同刻并列：按锚点（主地块号）稳定选 upper。
  const tied = select2x2Reservations([lower, upper], [], 1, [
    growingLand(3, now() + 45), growingLand(4, now() + 45),
    growingLand(7, now() + 45), growingLand(8, now() + 45),
    growingLand(11, now() + 45), growingLand(12, now() + 45),
  ]);
  assert.deepEqual(tied.map(group => group.key), [upper.key]);

  // lower 真实更早清空（45s < 50s）：优先 lower——旧 60s 容差会把它们当并列错选 upper。
  const earlier = select2x2Reservations([lower, upper], [], 1, [
    growingLand(3, now() + 50), growingLand(4, now() + 50),
    growingLand(7, now() + 45), growingLand(8, now() + 45),
    growingLand(11, now() + 45), growingLand(12, now() + 45),
  ]);
  assert.deepEqual(earlier.map(group => group.key), [lower.key]);
});

test('剩余植株 60 秒内无法清空的组合绝不预留（空地立即回到 1x1）', () => {
  resetReservationState();
  const slower = { key: '3-4-7-8', masterLandId: 7, landIds: [7, 8, 3, 4] };
  const sooner = { key: '7-8-11-12', masterLandId: 11, landIds: [11, 12, 7, 8] };
  const lands = [
    growingLand(3, now() + 3600), growingLand(4, now() + 3600),
    growingLand(7, now() + 120), growingLand(8, now() + 120),
    growingLand(11, now() + 120), growingLand(12, now() + 120),
  ];

  const selected = select2x2Reservations([slower, sooner], [], 1, lands);
  assert.deepEqual(selected, []);
});

test('等待期限=首次预留+60s：时钟前进不重置，到期释放且同一停滞组合不得重新预留', () => {
  resetReservationState();
  const group = { key: '1-2-5-6', masterLandId: 5, landIds: [5, 6, 1, 2] };
  const waitingLands = () => [
    emptyLand(1),
    growingLand(2, now()), growingLand(5, now()), growingLand(6, now()),
  ];

  const first = select2x2Reservations([group], [1], 1, waitingLands());
  assert.deepEqual(first.map(g => g.key), [group.key]);

  // 轮询不续期：清空进度推进（又空一块）后仍在期限内可续留。
  fakeNowSec += 30;
  const stillWaiting = select2x2Reservations([group], [1, 2], 1, [
    emptyLand(1), emptyLand(2), growingLand(5, now()), growingLand(6, now()),
  ]);
  assert.deepEqual(stillWaiting.map(g => g.key), [group.key]);

  // 首次预留+60s 到点：即使植株已全部成熟（窗口内），也释放且不再重新预留。
  fakeNowSec += 31;
  const expired = select2x2Reservations([group], [1], 1, waitingLands());
  assert.deepEqual(expired, []);

  // 之后每次轮询都不得让同一停滞组合把空地再圈回去。
  fakeNowSec += 60;
  assert.deepEqual(select2x2Reservations([group], [1], 1, waitingLands()), []);
});

test('组合完全清空后等待痕迹复位，可立即按完整空闲组合立种', () => {
  resetReservationState();
  const group = { key: '1-2-5-6', masterLandId: 5, landIds: [5, 6, 1, 2] };
  const lands = [
    emptyLand(1),
    growingLand(2, now()), growingLand(5, now()), growingLand(6, now()),
  ];
  assert.deepEqual(select2x2Reservations([group], [1], 1, lands).map(g => g.key), [group.key]);

  fakeNowSec += 120; // 期限早已耗尽
  const ready = select2x2Reservations([group], [1, 2, 5, 6], 1, [
    emptyLand(1), emptyLand(2), emptyLand(5), emptyLand(6),
  ]);
  // 完整空闲=立种路径，不受等待期限/释放标记影响。
  assert.deepEqual(ready.map(g => g.key), [group.key]);

  // 再次进入等待状态时期限从新时刻起算，而非沿用旧期限。
  fakeNowSec += 10;
  const nextRound = select2x2Reservations([group], [1, 2, 5], 1, [
    emptyLand(1), emptyLand(2), emptyLand(5), growingLand(6, now() + 5),
  ]);
  assert.deepEqual(nextRound.map(g => g.key), [group.key]);
});

test('多季作物未到末季不预留：清空时间按剩余季数计算', () => {
  resetReservationState();
  const group = { key: '1-2-5-6', masterLandId: 5, landIds: [5, 6, 1, 2] };
  // 第 1 季即将成熟的蘑菇还有 1 整季（14400s）要长：真实清空在 4 小时后。
  const firstSeason = select2x2Reservations([group], [1], 1, [
    emptyLand(1),
    growingLand(2, now() + 30, { plantId: MUSHROOM, season: 1 }),
    growingLand(5, now() + 30, { plantId: MUSHROOM, season: 1 }),
    growingLand(6, now() + 30, { plantId: MUSHROOM, season: 1 }),
  ]);
  assert.deepEqual(firstSeason, []);

  // 末季（第 2 季）60 秒内成熟=真实可清空，允许预留。
  const finalSeason = select2x2Reservations([group], [1], 1, [
    emptyLand(1),
    growingLand(2, now() + 30, { plantId: MUSHROOM, season: 2 }),
    growingLand(5, now() + 30, { plantId: MUSHROOM, season: 2 }),
    growingLand(6, now() + 30, { plantId: MUSHROOM, season: 2 }),
  ]);
  assert.deepEqual(finalSeason.map(g => g.key), [group.key]);
});

test('未知数据（无阶段/无成熟时刻/未知植物）一律按不可清空处理', () => {
  resetReservationState();
  const group = { key: '1-2-5-6', masterLandId: 5, landIds: [5, 6, 1, 2] };
  // 植株存在但没有阶段数据：不能当成"已清空"来预留。
  const noPhases = select2x2Reservations([group], [1, 2, 5], 1, [
    emptyLand(1), emptyLand(2), emptyLand(5),
    { id: 6, unlocked: true, plant: { id: DOGTAIL, season: 1, phases: [] } },
  ]);
  assert.deepEqual(noPhases, []);

  // 成熟时刻缺失（begin_time=0）同样未知。
  const noMatureAt = select2x2Reservations([group], [1, 2, 5], 1, [
    emptyLand(1), emptyLand(2), emptyLand(5),
    growingLand(6, 0),
  ]);
  assert.deepEqual(noMatureAt, []);

  // 植物不在配置里：生长/季数一概未知，不预留。
  const unknownPlant = select2x2Reservations([group], [1, 2, 5], 1, [
    emptyLand(1), emptyLand(2), emptyLand(5),
    growingLand(6, now() + 30, { plantId: 999999999 }),
  ]);
  assert.deepEqual(unknownPlant, []);
});
