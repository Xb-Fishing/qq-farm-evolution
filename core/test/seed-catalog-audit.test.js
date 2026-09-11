const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const pb = require('protobufjs/minimal');
const { inspectBagItemShows } = require('../src/services/bag-item-evidence');
const { auditBagSeedCoverage, compareClientSeedCatalog } = require('../src/services/seed-catalog-audit');
const { getBagSeedsFromItems } = require('../src/services/warehouse');
const config = require('../src/config/gameConfig');
const { readTable } = require('../scripts/inspect-seed-catalog');
const { activityEvidenceFingerprint, planDailyActivityEvolution } = require('../src/services/activity-evolver');
const { execFileSync } = require('node:child_process');

function bagBody(show) {
  const item = pb.Writer.create().uint32(8).int64(25995).uint32(16).int64(30)
    .uint32(24).int64(-62135596800).uint32(48).int64(1);
  if (show !== undefined) item.uint32(802).bytes(show);
  const bag = pb.Writer.create().uint32(10).bytes(item.finish()).finish();
  return pb.Writer.create().uint32(10).bytes(bag).finish();
}

test('真实 Bag 形状的十字节负有效期后仍能读取非空、空、缺失 ItemShow', () => {
  const show = pb.Writer.create().uint32(34).bytes(pb.Writer.create().uint32(8).int64(1001).uint32(16).int64(2000).finish()).finish();
  for (const wrap of [value => value, value => Buffer.from(value), value => new Uint8Array(value)]) {
    assert.deepEqual(inspectBagItemShows(wrap(bagBody(show)), new Set([25995])).get(25995), {
      state: 'show_without_verified_name', showBytes: 8, fields: [{ field: 4, wire: 2, bytes: 6 }],
    });
  }
  assert.equal(inspectBagItemShows(bagBody(Buffer.alloc(0)), new Set([25995])).get(25995).state, 'empty_show');
  assert.equal(inspectBagItemShows(bagBody(), new Set([25995])).get(25995).state, 'no_show_field');
  assert.equal(inspectBagItemShows(Buffer.from([10, 255]), new Set([25995])).get(25995).state, 'malformed');
});

test('任意中文出售条件或昵称不能从 ItemShow 冒充种子名称', () => {
  const show = pb.Writer.create().uint32(26).string('活动结束后').uint32(34).string('测试玩家种子').finish();
  const evidence = inspectBagItemShows(bagBody(show), new Set([25995])).get(25995);
  assert.equal(evidence.state, 'show_without_verified_name');
  assert.doesNotMatch(JSON.stringify(evidence), /活动结束|测试玩家/);
});

test('审计识别已命名的错分果实和漏种子，不只搜索未知 ID', () => {
  const wrongLookup = {
    ...config,
    getItemById: id => id === 20516 ? { name: '萌宠元气糕', type: 4 } : config.getItemById(id),
  };
  const report = auditBagSeedCoverage([{ id: 20516, count: 56 }], [], wrongLookup);
  assert.deepEqual(report.issues.map(x => x.kind), ['seed_missing_from_priority', 'seed_name_conflict', 'seed_type_conflict']);
  assert.equal(auditBagSeedCoverage([{ id: 25995, count: 30 }], getBagSeedsFromItems([{ id: 25995, count: 30 }])).issues.length, 0);
});

test('客户端成对配置比对会发现种子名称、果实和四格占地漂移', () => {
  const source = [{ id: 29004, name: '泡泡棉花糖种子', type: 5 }];
  const plants = [{ id: 1029004, seed_id: 29004, fruit: { id: 49004 }, size: 2, land_level_need: 1 }];
  assert.deepEqual(compareClientSeedCatalog(source, plants), []);
  const drift = { ...config, getPlantBySeedId: () => ({ id: 1029004, fruit: { id: 20516 }, size: 1 }) };
  assert.deepEqual(compareClientSeedCatalog(source, plants, drift)[0].differences, ['fruit_id', 'size', 'land_level_need']);
});

test('种子识别未决缺口即使活动指纹不变也进入每日 Agent 复盘', () => {
  const report = { online: { available: true, checkedActivityIds: [2026090100], seedRecognition: { available: true, issues: [{ itemId: 999, kind: 'unclassified_item' }] } } };
  const state = { evolutionMemory: { activity: { reviewedHead: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), evidenceFingerprint: activityEvidenceFingerprint(report) } } };
  const plan = planDailyActivityEvolution(report, state);
  assert.equal(plan.evidenceChanged, false);
  assert.equal(plan.seedRecognitionNeedsReview, true);
  assert.equal(plan.shouldRun, true);
});

test('配置检查只解析同名 Cocos JsonAsset，不执行外部代码', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'seed-catalog-'));
  try {
    const file = path.join(directory, 'table.json');
    fs.writeFileSync(file, JSON.stringify([[], [], [], [], [], [[0, 'ItemInfo', [{ id: 20516, type: 5 }]]]]));
    assert.deepEqual(readTable(file, 'ItemInfo'), [{ id: 20516, type: 5 }]);
    assert.throws(() => readTable(file, 'Plant'), /唯一同名/);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('显式非种子类型覆盖名称后缀，并清理旧种子索引', () => {
  config.registerRuntimeItem(999990, { name: '测试种子', type: 5 });
  assert.equal(config.isSeedItem(999990), true);
  config.registerRuntimeItem(999990, { name: '测试种子', type: 11 });
  assert.equal(config.isSeedItem(999990), false);
});
