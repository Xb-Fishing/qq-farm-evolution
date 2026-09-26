const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// 放虫/放草 operation ID 契约（2026-09-26 修正）：
// 10003 = 放草/放虫共用 shared 每日额度（PutWeeds/PutInsects 均消耗）；
// 10004 = 放虫单项计数（不并入总额，避免双算）；
// 10005/10006/10007 = 帮好友除草/除虫/浇水（帮助计数，不进捣乱预算）。
// 协议证据存 ignored tmp/mischief-operation-id-proof.json，不入库。本测试
// 只锁定生产行为，全内存替身，无网络。
process.env.FARM_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'opid-contract-'));
process.env.FARM_ACCOUNT_ID = 'opid-contract-test';

const limits = require('../src/services/friend-operation-limits');
const { placeAutoBadItems } = require('../src/services/friend-visit');

function feed(entries) {
  limits.updateOperationLimits(entries.map(([id, dayTimes, dayTimesLimit]) => ({
    id, day_times: dayTimes, day_times_lt: dayTimesLimit,
    day_exp_times: 0, day_ex_times_lt: 0,
  })));
}

test('帮助计数（10005/10006）不耗尽捣乱预算：54+63 且 shared=0 时预算 100', () => {
  // 复现线上只读缓存形态：10005=54、10006=63 曾被误加成 117 清零预算
  feed([[10005, 54, 0], [10006, 63, 0], [10003, 0, 100], [10004, 0, 100]]);
  assert.equal(limits.getBadRemainingTimes(), 100);
  assert.equal(limits.canOperateBad(), true);
});

test('shared=10、bug 单项=4：总已用 10 而非 14（10004 不双算）', () => {
  feed([[10003, 10, 100], [10004, 4, 100]]);
  assert.equal(limits.getBadOperationUsedCount(), 10);
  assert.equal(limits.getBadRemainingTimes(), 90);
});

test('shared=100 才总额归零', () => {
  feed([[10003, 100, 100], [10004, 100, 100]]);
  assert.equal(limits.getBadRemainingTimes(), 0);
  assert.equal(limits.canOperateBad(), false);
});

test('服务端 shared cap 20 已用 20：即使 bot cap 未满、bug 分项仍有余额，总额为 0', () => {
  feed([[10003, 20, 20], [10004, 4, 100]]); // bug 分项剩 96，但 shared 已尽
  assert.equal(limits.getBadRemainingTimes(), 0);
  assert.equal(limits.canOperateBad(), false);
});

test('服务端 shared cap 20 已用 7：总剩余 13，不双算 bug 分项', () => {
  feed([[10003, 7, 20], [10004, 7, 100]]);
  assert.equal(limits.getBadRemainingTimes(), 13);
});

test('无 shared 记录时保持 bot cap fallback=100；服务端无限额度仍受 bot 100 约束', () => {
  // limits 是单例，前面用例已写入 10003 记录；此处取全新实例验证 fallback
  delete require.cache[require.resolve('../src/services/friend-operation-limits')];
  const fresh = require('../src/services/friend-operation-limits');
  const feedFresh = (entries) => fresh.updateOperationLimits(entries.map(([id, dayTimes, dayTimesLimit]) => ({
    id, day_times: dayTimes, day_times_lt: dayTimesLimit, day_exp_times: 0, day_ex_times_lt: 0,
  })));
  feedFresh([[10004, 0, 100]]); // 无 10003 记录
  assert.equal(fresh.getBadRemainingTimes(), 100);
  feedFresh([[10003, 60, 0]]); // 服务端 shared 无上限（limit<=0）
  assert.equal(fresh.getBadRemainingTimes(), 40);
});

test('getOperationLimits 展示真实捣乱操作与已核验名称，未知项中性', () => {
  feed([[10003, 5, 100], [10004, 6, 100], [10005, 54, 0], [10008, 25, 0]]);
  const all = limits.getOperationLimits();
  assert.equal(all['10003'].name, '捣乱共享额度（放虫/放草）');
  assert.equal(all['10004'].name, '给好友放虫');
  assert.equal(all['10005'].name, '帮好友除草');
  assert.equal(all['10008'].name, '操作 #10008');
});

test('placeAutoBadItems 按正确 opId 发 CheckCanOperate（虫 10004、草 10003）', async () => {
  feed([[10003, 0, 100], [10004, 0, 100]]);
  const checkedOpIds = [];
  const tally = { putBug: 0, putWeed: 0 };
  const result = await placeAutoBadItems(77, { canPutBug: [1], canPutWeed: [2] }, tally, {
    checkCanOperate: async (_gid, opId) => { checkedOpIds.push(Number(opId)); return { canOperate: true }; },
    putInsects: async (_gid, ids) => ({ ok: ids.length, failed: [] }),
    putWeeds: async (_gid, ids) => ({ ok: ids.length, failed: [] }),
  });
  assert.deepEqual(checkedOpIds, [10004, 10003]);
  assert.equal(result.bug, 1);
  assert.equal(result.weed, 1);
});

test('捣乱预算归零时 placeAutoBadItems 零写请求', async () => {
  feed([[10003, 100, 100], [10004, 100, 100]]);
  let checked = 0;
  const result = await placeAutoBadItems(77, { canPutBug: [1], canPutWeed: [2] }, { putBug: 0, putWeed: 0 }, {
    checkCanOperate: async () => { checked++; return { canOperate: true }; },
    putInsects: async () => { throw new Error('must not be called'); },
    putWeeds: async () => { throw new Error('must not be called'); },
  });
  assert.equal(checked, 0);
  assert.ok(result.reasons.includes('cap_zero'));
});
