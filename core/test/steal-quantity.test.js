const test = require('node:test');
const assert = require('node:assert/strict');

const { sumHarvestItemCount } = require('../src/services/friend-operation-limits');

// 2026-09-28：偷菜统计从地块数改为真实数量。HarvestReply.items 为空时
// 回退块数（调用方处理），这里只测提取语义。实证（12:19 偷24块）：每块地
// 回包为 "果实+杂物" 成对（40516x84,1028x2），只统计可映射植物的果实 id。
test('sumHarvestItemCount 只统计果实 id，杂物不计入', () => {
  // 40516=狗尾草、1040516=黄金·狗尾草 是果实；1028 是杂物
  const got = sumHarvestItemCount({ items: [
    { id: 40516, count: 84 }, { id: 1028, count: 2 },
    { id: 1040516, count: 5 }, { id: 1028, count: 3 },
  ] });
  assert.equal(got.total, 89);
  assert.equal(got.detail, '40516x84,1028x2,1040516x5,1028x3');
  // 2026-10-04 附加字段：实际果实名+数量聚合（黄金· 变异带全名，杂物不进清单）。
  assert.deepEqual(got.fruits, [
    { name: '狗尾草', count: 84 },
    { name: '黄金·狗尾草', count: 5 },
  ]);
  assert.equal(got.fruitSummary, '狗尾草×84，黄金·狗尾草×5');
  assert.deepEqual(sumHarvestItemCount({ items: [] }),
    { total: 0, detail: '', fruits: [], fruitSummary: '' });
  assert.deepEqual(sumHarvestItemCount(null),
    { total: 0, detail: '', fruits: [], fruitSummary: '' });
  // count=0 条目不进 detail，不贡献总量
  assert.deepEqual(sumHarvestItemCount({ items: [{ id: 40516, count: 0 }] }),
    { total: 0, detail: '', fruits: [], fruitSummary: '' });
});

// 编解码往返：proto 启用 items 字段后，wire 上带 items 的回包能解出来。
test('HarvestReply items 字段编解码往返', async () => {
  const proto = require('../src/utils/proto');
  await proto.loadProto();
  const { types } = require('../src/utils/proto');
  const buf = types.HarvestReply.encode(types.HarvestReply.create({
    items: [{ id: 40516, count: 24 }],
  })).finish();
  const decoded = types.HarvestReply.decode(buf);
  assert.equal(sumHarvestItemCount(decoded).total, 24);
});
