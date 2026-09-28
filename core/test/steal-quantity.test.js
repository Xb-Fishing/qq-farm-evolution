const test = require('node:test');
const assert = require('node:assert/strict');

const { sumHarvestItemCount } = require('../src/services/friend-operation-limits');

// 2026-09-28：偷菜统计从地块数改为真实数量。HarvestReply.items 为空时
// 回退块数（调用方处理），这里只测提取语义。
test('sumHarvestItemCount 汇总 items 数量，空回包返回 0', () => {
  assert.deepEqual(sumHarvestItemCount({ items: [{ id: 301101, count: 12 }, { id: 301103, count: 6 }] }),
    { total: 18, detail: '301101x12,301103x6' });
  assert.deepEqual(sumHarvestItemCount({ items: [] }), { total: 0, detail: '' });
  assert.deepEqual(sumHarvestItemCount(null), { total: 0, detail: '' });
  // count=0 条目不进 detail，不贡献总量
  assert.deepEqual(sumHarvestItemCount({ items: [{ id: 1, count: 0 }, { id: 2, count: 3 }] }),
    { total: 3, detail: '2x3' });
});

// 编解码往返：proto 启用 items 字段后，wire 上带 items 的回包能解出来。
test('HarvestReply items 字段编解码往返', async () => {
  const proto = require('../src/utils/proto');
  await proto.loadProto();
  const { types } = require('../src/utils/proto');
  const buf = types.HarvestReply.encode(types.HarvestReply.create({
    items: [{ id: 301101, count: 24 }],
  })).finish();
  const decoded = types.HarvestReply.decode(buf);
  assert.equal(sumHarvestItemCount(decoded).total, 24);
});
