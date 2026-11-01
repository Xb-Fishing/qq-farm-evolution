'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
// This existing isolated fixture imports business only after FARM_DATA_DIR.
const { fixture, proto } = require('./milk-tea-autonomy-baseline.test');
const { Writer } = require('protobufjs');
const concat = (...rows) => Buffer.concat(rows.map(Buffer.from));
const scalar = (field, value) => Buffer.from(Writer.create().uint32(field * 8).int64(value).finish());
const nested = (field, value) => Buffer.from(Writer.create().uint32(field * 8 + 2).bytes(value).finish());
const item = (id, count) => concat(scalar(1, id), scalar(2, count));
const group = (id, field, body) => nested(1, concat(nested(1, scalar(1, 2026110100)), nested(2, concat(nested(1, scalar(1, id)), nested(field, body)))));
function goodsWire(explicit) {
  const goods = concat(scalar(1, 306), nested(2, item(21435, 1)), nested(3, item(1001, 20000)), scalar(4, 108), ...(explicit ? [scalar(5, 0)] : []));
  return group(2026110102, 102, nested(1, goods));
}
function workWire(now, explicit) {
  const shift = concat(nested(1, scalar(1, 9001)), scalar(3, 7001), scalar(7, Math.floor(now / 1000) + 3600), scalar(10, 1), nested(13, scalar(1, 1)), ...(explicit ? [scalar(9, 0)] : []));
  return concat(nested(1, shift), ...(explicit ? [scalar(5, 0)] : []));
}
for (const explicit of [false, true]) {
  test(`raw wire ${explicit ? 'explicit' : 'omitted'} purchased_count zero buys the initial stock through runAutomatic`, async () => {
    const f = await fixture({ milk_tea_auto_seeds: true });
    try {
      f.summary.level = 11; Object.assign(f.goods, { id: 306, rewards: [{ id: 21435, count: '1' }], costs: [{ id: 1001, count: '20000' }], purchaseLimit: 108 });
      f.setFlags({ milk_tea_seed_policy: { ...f.auto.milk_tea_seed_policy, targetSeedIds: [21435] } });
      const reader = f.deps.getActivityGroupSnapshot;
      f.deps.getActivityGroupSnapshot = async () => f.service.normalizeMilkTeaDiscovery(await reader(), goodsWire(explicit));
      await f.service.runAutomaticMilkTea(f.deps);
      assert.deepEqual(f.writes(), [1], 'same known zero means first purchase is eligible');
      assert.equal(Number(f.requests.find(row => Number(row.operate_type) === 1).shop_buy.count), 12);
    } finally { f.close(); }
  });
  test(`raw wire ${explicit ? 'explicit' : 'omitted'} false and zero performs the first shift interaction`, async () => {
    const f = await fixture({ milk_tea_auto_work: true });
    try {
      f.summary.hasUnclaimedWage = false;
      const type = proto.getRoot().lookupType('gamepb.milkteapb.MilkTeaGetWorkPageRsp');
      const decoded = type.decode(workWire(f.clock.now, explicit));
      f.response((cmd, reply) => cmd === 63 ? { ...reply, milk_tea_get_work_page: decoded } : reply);
      await f.service.runAutomaticMilkTea(f.deps);
      assert.deepEqual(f.writes(), [65], 'valid typed shift defaults authorize exactly one interaction');
    } finally { f.close(); }
  });
  test(`raw wire ${explicit ? 'explicit' : 'omitted'} false advances confirmed wages through three observations`, async () => {
    const f = await fixture({ milk_tea_auto_work: true });
    try {
      f.work.my_shift = null; f.work.slips = [{ shift_id: '7001' }];
      await f.service.runAutomaticMilkTea(f.deps);
      const summary = concat(scalar(1, 1), scalar(4, 1), ...(explicit ? [scalar(12, 0)] : []));
      const snapshot = { id: 2026110100, children: [{ id: 2026110101, details: {} }] };
      const normalized = f.service.normalizeMilkTeaDiscovery(snapshot, group(2026110101, 121, nested(1, summary)));
      Object.assign(f.summary, normalized.children[0].details.milkTea); await f.tick();
      assert.equal(f.service.actionStateSummary().wagesPending, false, 'a fresh, anchored canonical false clears the old wage latch');
      f.summary.hasUnclaimedWage = true; f.summary.hasUnclaimedWageKnown = true; f.work.slips = [{ shift_id: '7002' }]; await f.tick();
      assert.deepEqual(f.writes(), [64, 64]);
    } finally { f.close(); }
  });
}

test('plain missing, empty typed and malformed summary/goods remain unknown', async () => {
  const f = await fixture({});
  try {
    const type = proto.getRoot().lookupType('gamepb.milkteapb.MilkTeaActivitySummary');
    assert.equal(f.service.milkTeaSummaryDto({ milk_tea: { summary: type.decode(Buffer.alloc(0)) } }, true).hasUnclaimedWageKnown, false);
    assert.equal(f.service.milkTeaSummaryDto({ milk_tea: { summary: { shop_open_at: 1, level: 1 } } }, true).hasUnclaimedWageKnown, false);
    const plain = { shop: { goods: [{ id: 306, item: [{ id: 21435, count: 1 }], cost: [{ id: 1001, count: 1 }] }] } };
    assert.equal(f.service.exchangeShopRichDto(plain, true).items[0].purchasedCountKnown, false);
    for (const invalid of [-1, null, false, '', 'bad']) {
      plain.shop.goods[0].purchased_count = invalid;
      assert.equal(f.service.exchangeShopRichDto(plain, true).items[0].purchasedCountKnown, false);
    }
  } finally { f.close(); }
});
