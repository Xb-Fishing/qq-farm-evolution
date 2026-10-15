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

const WISH_ROOT = 2026092400;
const WISH_PLAY = 2026092401;
const SHARE_ROOT = 2026092500;
const SHARE_PLAY = 2026092501;

test('季节活动 proto 注册并按官方编码器重构字节级复现四条请求', async () => {
  await loadProto();
  assert.ok(types.ActivityGetGroupReply, 'activity types loaded');
  const hex = value => Buffer.from(value).toString('hex');
  // 官方编码器重构 hex（公开参考项目 1 @0ba48a1 协议恢复文档，字段号经
  // 官方生成代码 sentinel 探测 + HAR 明文响应交叉验证）
  assert.equal(hex(types.ActivityOperateRequest.encode(types.ActivityOperateRequest.create({
    id: WISH_PLAY, cmd: 51, wish_sign_draw: { choose_id: 2 },
  })).finish()), '08f1ee8ec6071033ba09020802');
  assert.equal(hex(types.ActivityOperateRequest.encode(types.ActivityOperateRequest.create({
    id: WISH_PLAY, cmd: 52, wish_sign_claim: { choose_id: 2 },
  })).finish()), '08f1ee8ec6071034c209020802');
  // daily/milestones 官方请求体仅 id+cmd（8 字节，无选择器字段）
  assert.equal(hex(types.ActivityOperateRequest.encode(types.ActivityOperateRequest.create({
    id: SHARE_PLAY, cmd: 73,
  })).finish()), '08d5ef8ec6071049');
  assert.equal(hex(types.ActivityOperateRequest.encode(types.ActivityOperateRequest.create({
    id: SHARE_PLAY, cmd: 70,
  })).finish()), '08d5ef8ec6071046');
});

test("runManualSeasonWishAction：白名单、前置校验与成功链（轮换退役：入口零网络）", async () => {
 let calls=0; const read=async()=>{calls++; throw new Error('unexpected read');};
 const mod=require('../src/services/season-wish-operate');
 for (const action of ['wishDraw','wishClaim','shareDaily','shareMilestones','unknown']) await assert.rejects(mod.runManualSeasonWishAction(action, {}, { getBag: read, getBagItems: read }), /下架/);
 assert.equal(calls,0);
});
