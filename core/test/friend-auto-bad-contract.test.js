const { test } = require('node:test');
const assert = require('node:assert/strict');

/**
 * 新函数契约测试（2026-09-26 在线自动捣乱重构）。
 * 只断言新模块导出的函数存在并遵守零额度契约。
 * 注：旧代码（HEAD 基线）行为反例取证由主协调进程独立完成，证据见
 * tmp/auto-bad-coordinator-counterexample.json（原 visitFriendForHelp
 * 在单项 quota=0 时仍发 2 次写；当前实现 0 次），不在本文件重复宣称。
 */
const friendActivity = require('../src/services/friend-activity');
const friendVisit = require('../src/services/friend-visit');

test('进场在场证据必须经统一 noteEnterPresence（缺省 last_online=0 不当离线时刻）', async () => {
  assert.equal(typeof friendActivity.noteEnterPresence, 'function',
    '缺少统一进场证据入口：所有进门路径都应产出在线证据');
  friendActivity.resetForTest();
  const t0 = Date.now();
  const first = friendActivity.noteEnterPresence(501, { at_home: true, lands: [] }, t0);
  assert.equal(first.atHome, true);
  friendActivity.noteEnterPresence(501, { at_home: false, basic: { last_online: 0 }, lands: [] }, t0 + 1_000);
  assert.equal(friendActivity.isFriendAtHomeRecently(501, t0 + 2_000), true,
    '缺省 last_online=0 不得覆盖 at_home 证据');
});

test('placeAutoBadItems 独立存在且总额度为 0 时零请求', async () => {
  assert.equal(typeof friendVisit.placeAutoBadItems, 'function',
    '在线捣乱必须有独立可测执行体');
  let requests = 0;
  const result = await friendVisit.placeAutoBadItems(
    501,
    { canPutBug: [1, 2], canPutWeed: [3, 4] },
    { putBug: 0, putWeed: 0 },
    {
      badRemaining: () => 0,
      remainingFor: () => 0,
      checkCanOperate: async () => { requests += 1; return { canOperate: true }; },
      putInsects: async () => { requests += 1; return { ok: 1 }; },
      putWeeds: async () => { requests += 1; return { ok: 1 }; },
    }
  );
  assert.equal(requests, 0, '额度为 0 必须零请求');
  assert.deepEqual(result.reasons, ['cap_zero']);
});
