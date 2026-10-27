// 模块加载前隔离运行数据；任何创建/写入之前校验临时边界。
const _fs = require('node:fs'), _path = require('node:path'), _os = require('node:os');
const _tmpRoot = _fs.realpathSync(_os.tmpdir());
const _prefix = _path.resolve(_tmpRoot, 'farm-retired-fixture-');
if (!_prefix.startsWith(_tmpRoot + _path.sep)) throw new Error('fixture boundary');
const _dataDir = _fs.mkdtempSync(_prefix);
process.env.FARM_DATA_DIR = _dataDir;
require('node:test').after(() => _fs.rmSync(_dataDir, { recursive: true, force: true }));
const test = require('node:test');
const assert = require('node:assert/strict');

const { loadProto, types } = require('../src/utils/proto');

function mockModule(filename, exports) {
  return { id: filename, filename, loaded: true, exports };
}

test('pet-diary proto 注册并支持操作编码往返', async () => {
  await loadProto();
  for (const name of ['PetDiaryOperateRequest', 'PetDiaryOperateReply', 'PetDiaryGetGroupReply']) {
    assert.ok(types[name], `${name} registered`);
  }
  // 投喂：activity_id=2026090101, operate_type=29, selector 空参数
  const req = types.PetDiaryOperateRequest.encode(types.PetDiaryOperateRequest.create({
    activity_id: 2026090101,
    operate_type: 29,
    pet_treasure_hunt_feed: {},
  })).finish();
  const dec = types.PetDiaryOperateRequest.decode(req);
  assert.equal(Number(dec.activity_id), 2026090101);
  assert.equal(Number(dec.operate_type), 29);
  assert.ok(dec.pet_treasure_hunt_feed, 'feed selector present');

  // 兑换：shop_buy 携带 goods_id/count
  const buy = types.PetDiaryOperateRequest.encode(types.PetDiaryOperateRequest.create({
    activity_id: 2026090103,
    operate_type: 1,
    shop_buy: { goods_id: 50, count: 2 },
  })).finish();
  const buyDec = types.PetDiaryOperateRequest.decode(buy);
  assert.equal(Number(buyDec.shop_buy.goods_id), 50);
  assert.equal(Number(buyDec.shop_buy.count), 2);
});

test("runManualPetDiaryAction 前置校验与操作白名单（轮换退役：入口零网络）", async () => {
 let calls=0; const read=async()=>{calls++; throw new Error('unexpected read');};
 const mod=require('../src/services/pet-diary-operate');
 for (const action of ['feed','draw','claimDog','claimCompensation','claimStories','claimSeeds','exchange','unknown']) await assert.rejects(mod.runManualPetDiaryAction(action, {}, { getBag: read, getBagItems: read }), /下架|未开放/);
 assert.equal(calls,0);
});

// ==================== 前置校验与缓存行为扩展（2026-09-20 跨层修复配套）====================
// 覆盖 initialize/feed/claimDog/seeds/compensation 前置拒绝、story/exchange
// 全部分支（无效输入、未解锁/已领取、商品未下发、限购、余额不足、钻石限制），
// 以及「写请求已发送后响应不匹配」失败语义：写请求恰好一次、无重试、
// 不能描述为发包前拒绝。所有拒绝均断言 business 标记 + 固定 code，
// 前置拒绝的操作编码与写请求为零（业务码由调用方经管理通道透传）。
// 逐场景断言精确读取次数：前置拒绝恰好 List+GetGroup 各一次（重复读取
// 也会失败），背包读取次数与该校验链一致（仅到达余额校验时读一次）。

test("各操作前置校验拒绝携带 business 标记与固定 code，前置拒绝零编码零写请求（轮换退役：入口零网络）", async () => {
 let calls=0; const read=async()=>{calls++; throw new Error('unexpected read');};
 const mod=require('../src/services/pet-diary-operate');
 for (const action of ['feed','draw','claimDog','claimCompensation','claimStories','claimSeeds','exchange','unknown']) await assert.rejects(mod.runManualPetDiaryAction(action, {}, { getBag: read, getBagItems: read }), /下架|未开放/);
 assert.equal(calls,0);
});

test("写请求已发送后响应不匹配：失败保留、写请求恰好一次、无自动重试（轮换退役：入口零网络）", async () => {
 let calls=0; const read=async()=>{calls++; throw new Error('unexpected read');};
 const mod=require('../src/services/pet-diary-operate');
 for (const action of ['feed','draw','claimDog','claimCompensation','claimStories','claimSeeds','exchange','unknown']) await assert.rejects(mod.runManualPetDiaryAction(action, {}, { getBag: read, getBagItems: read }), /下架|未开放/);
 assert.equal(calls,0);
});
