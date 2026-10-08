const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// 2026-10-08：偷菜明细展示全名不变量（用户偏好：任何 steal item-detail
// 文本绝不出现数字物品 ID，未知条目写 未知物品/未知果实）。测试用独立
// FARM_DATA_DIR（先建目录再 import，结束后恢复环境并清理）。
const fixtureRoot = fs.realpathSync(os.tmpdir());
const sourceRoot = fs.realpathSync(path.resolve(__dirname, '..', '..'));
if (fixtureRoot === sourceRoot || fixtureRoot.startsWith(sourceRoot + path.sep)) {
  throw new Error('fixture root must be outside the source repository');
}
const fixturePrefix = path.resolve(fixtureRoot, 'steal-quantity-');
if (path.dirname(fixturePrefix) !== fixtureRoot) throw new Error('fixture creation out of bounds');
const DATA_DIR = fs.mkdtempSync(fixturePrefix);
const PREV_DATA_DIR = process.env.FARM_DATA_DIR;
process.env.FARM_DATA_DIR = DATA_DIR;

const { sumHarvestItemCount } = require('../src/services/friend-operation-limits');

test.after(() => {
  if (PREV_DATA_DIR === undefined) delete process.env.FARM_DATA_DIR;
  else process.env.FARM_DATA_DIR = PREV_DATA_DIR;
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  process.on('exit', () => fs.rmSync(DATA_DIR, { recursive: true, force: true }));
});

// 2026-09-28：偷菜统计从地块数改为真实数量。HarvestReply.items 为空时
// 回退块数（调用方处理），这里只测提取语义。实证（12:19 偷24块）：每块地
// 回包为 "果实+杂物" 成对（40516x84,1028x2），只统计可映射植物的果实 id。
// 2026-10-08：detail 改全名「名称×N，…」（杂物/特殊奖励经 getItemById
// 带实名，如 1028=萌宠元气糕），总量与果实聚合语义不变。
test('sumHarvestItemCount 只统计果实 id，杂物不计入；detail 显示全名', () => {
  // 40516=狗尾草、1040516=黄金·狗尾草 是果实；1028 是杂物（特殊奖励道具）
  const got = sumHarvestItemCount({ items: [
    { id: 40516, count: 84 }, { id: 1028, count: 2 },
    { id: 1040516, count: 5 }, { id: 1028, count: 3 },
  ] });
  assert.equal(got.total, 89);
  assert.equal(got.detail, '狗尾草×84，萌宠元气糕×2，黄金·狗尾草×5，萌宠元气糕×3');
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

// 2026-10-08 正向覆盖：普通果实+黄金变异+特殊奖励杂物+合成未知 id 混合。
// 未知 id（9990001 不在植物/物品表）写 未知物品，不出现数字；未知条目
// 仍不计总量、不进果实聚合。用户示例形态：狗尾草×33，萌宠元气糕×1。
test('detail 混合普通/黄金/特殊奖励/未知条目均为全名，总量不变', () => {
  const got = sumHarvestItemCount({ items: [
    { id: 40516, count: 33 }, { id: 1028, count: 1 }, { id: 9990001, count: 7 },
  ] });
  assert.equal(got.total, 33);
  assert.equal(got.detail, '狗尾草×33，萌宠元气糕×1，未知物品×7');
  assert.deepEqual(got.fruits, [{ name: '狗尾草', count: 33 }]);
  assert.equal(got.fruitSummary, '狗尾草×33');
  // 全未知条目：零果实贡献、零计数污染，展示仍不出现数字 ID。
  const unknownOnly = sumHarvestItemCount({ items: [{ id: 9990002, count: 4 }] });
  assert.equal(unknownOnly.total, 0);
  assert.equal(unknownOnly.detail, '未知物品×4');
  assert.deepEqual(unknownOnly.fruits, []);
  assert.equal(unknownOnly.fruitSummary, '');
});

test('缺失名称和带编号的占位名不进入任何到手明细', () => {
  const { getPlantByFruitId, getItemById } = require('../src/config/gameConfig');
  const plant = getPlantByFruitId(40516);
  const reward = getItemById(1028);
  const oldPlantName = plant.name;
  const oldRewardName = reward.name;
  try {
    for (const placeholder of ['40516', '物品#40516', '果实40516', '作物#40516', '植物 40516', '']) {
      plant.name = placeholder;
      const got = sumHarvestItemCount({ items: [{ id: 40516, count: 1 }] });
      assert.equal(got.detail, '未知果实×1');
      assert.equal(got.fruitSummary, '未知果实×1');
      assert.equal(got.total, 1);
    }
    reward.name = '物品#1028';
    const got = sumHarvestItemCount({ items: [{ id: 1028, count: 2 }] });
    assert.equal(got.detail, '未知物品×2');
    assert.equal(got.total, 0);
  } finally {
    plant.name = oldPlantName;
    reward.name = oldRewardName;
  }
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
  assert.equal(sumHarvestItemCount(decoded).detail, '狗尾草×24');
});
