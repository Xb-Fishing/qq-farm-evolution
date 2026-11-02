const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const prefix = path.resolve(fs.realpathSync(os.tmpdir()), 'mall-route-test-');
assert.equal(path.dirname(prefix), fs.realpathSync(os.tmpdir()));
const temporary = fs.mkdtempSync(prefix); process.env.FARM_DATA_DIR = temporary;
test.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
const { classifyMallGoods, decorateMallEntry, buildRechargeZone, registerAdminMallRoutes } = require('../src/controllers/admin-mall-routes');
test('official per-ID page membership replaces the three-product display allowlist without inventing RPC slots', () => {
  assert.equal(classifyMallGoods(1006).zone, 'packages');
  assert.equal(classifyMallGoods(1047).zone, 'featured');
  assert.equal(classifyMallGoods(1015).zone, 'packages');
  assert.equal(classifyMallGoods(999999).catalogMapped, false);
  const tiers = buildRechargeZone().tiers;
  assert.equal(tiers.length, 8); assert.equal(tiers[0].priceYuan, '1'); assert.equal(tiers.at(-1).priceYuan, '648');
  assert.equal(tiers.every(row => row.firstChargeEligibility === 'unknown'), true);
});
test('unknown or insufficient balances never become buyable; exact balances do not round', () => {
  const row = { goodsId: 1006, price: { amountDec: '9007199254740993', currencyId: 1002 }, limit: { present: false },
    enabled: true, catalogMapped: true, catalogRestricted: null, items: [] };
  assert.equal(decorateMallEntry(row, {}).canBuy, false);
  assert.equal(decorateMallEntry(row, { status: { coupon: '9007199254740992' } }).canBuy, false);
  assert.equal(decorateMallEntry(row, { status: { coupon: '9007199254740993' } }).canBuy, true);
});
test('real mall routes reject an inaccessible account before provider reads or writes', async () => {
  const handlers = new Map(); let calls = 0;
  registerAdminMallRoutes({ app: { get: (key, value) => handlers.set(key, value), post: (key, value) => handlers.set(key, value) },
    provider: new Proxy({}, { get: () => () => { calls++; } }), getAccountIdFromRequest: () => 'synthetic', canAccessAccount: () => false });
  for (const handler of handlers.values()) {
    const response = { status(code) { assert.equal(code, 403); return this; }, json(value) { assert.equal(value.ok, false); } };
    await handler({}, response);
  }
  assert.equal(calls, 0);
});
