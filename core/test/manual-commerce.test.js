const test = require('node:test'); const assert = require('node:assert/strict');
const fs = require('node:fs'); const path = require('node:path'); const os = require('node:os'); const vm = require('node:vm');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');
const prefix = path.resolve(fs.realpathSync(os.tmpdir()), 'manual-commerce-test-');
assert.equal(path.dirname(prefix), fs.realpathSync(os.tmpdir()));
const temporary = fs.mkdtempSync(prefix); process.env.FARM_DATA_DIR = temporary;
const proto = require('../src/utils/proto');
const config = require('../src/config/gameConfig');
const sources = ['manual-commerce.js', 'mall.js', 'farm-api.js', 'warehouse.js'].map(name => path.resolve(__dirname, '../src/services', name));
const before = sources.map(file => [file, fs.readFileSync(file), fs.statSync(file).mode]);
function evaluate(file, mocks, env, bridge) {
  const mod = { exports: {} }; const original = createRequire(file);
  vm.compileFunction(fs.readFileSync(file, 'utf8'), ['require', 'module', 'exports', 'process', 'globalThis'])(
    name => Object.hasOwn(mocks, name) ? mocks[name] : original(name), mod, mod.exports, { env }, bridge);
  return mod.exports;
}
function varint(value) { let n = BigInt(value); const bytes = []; do { const b = Number(n & 127n); n >>= 7n; bytes.push(b | (n ? 128 : 0)); } while (n); return bytes; }
function itemBytes(id, count) { return Buffer.from([8, ...varint(id), 16, ...varint(count)]); }
function fixture() {
  const dir = fs.mkdtempSync(path.join(temporary, 'case-')); assert.equal(path.dirname(dir), temporary);
  const state = { dir, connected: true, ws: {}, epoch: 1, sends: [], failWrite: false, readGate: null, writeGate: null,
    error: null, badReply: false, wallet: { gid: 123, level: 10, gold: '100000', coupon: '100000', diamond: '100000', goldBean: '100000' },
    goods: { goods_id: 1002, name: '10小时有机化肥', price: itemBytes(1002, 42), item_ids: [itemBytes(80011, 2), itemBytes(80013, 1)], enabled: true },
    shopGoods: { id: '7', item_id: '20001', item_count: '1', price: '5', limit_count: '10', bought_num: '0', unlocked: true, conds: [{ type: 1, param: '1' }] },
    bag: [{ id: '40001', uid: '9007199254740993', count: '10' }] };
  const env = { ...process.env, FARM_SESSION_BUSINESS: '', FARM_DATA_DIR: dir, FARM_ACCOUNT_ID: 'synthetic-commerce' };
  const bridge = { __farmSessionBridge: { readFacts: () => ({ game: { connectionEpoch: state.epoch, loginEpoch: 1 } }) } };
  const network = { getWs: () => state.ws, isConnected: () => state.connected, getUserState: () => state.wallet, networkEvents: new EventEmitter(),
    sendMsgAsync: async (service, method, body) => {
      const { types } = proto;
      state.sends.push({ method, body: Buffer.from(body) });
      if (['GetMallListBySlotType', 'ShopInfo', 'Bag'].includes(method)) { if (state.readGate) await state.readGate; if (state.readError) throw state.readError; }
      const encode = (type, object) => ({ body: type.encode(type.create(object)).finish() });
      if (method === 'GetMallListBySlotType') return encode(types.GetMallListBySlotTypeResponse, { goods_list: [types.MallGoods.encode(types.MallGoods.create(state.goods)).finish()] });
      if (method === 'ShopInfo') return encode(types.ShopInfoReply, { goods_list: [state.shopGoods] });
      if (method === 'Bag') return encode(types.BagReply, { item_bag: { items: state.bag } });
      if (state.writeGate) await state.writeGate;
      if (state.error) throw state.error;
      if (state.badReply) return { body: Buffer.alloc(0) };
      if (method === 'Purchase') { const request = types.PurchaseRequest.decode(body); return encode(types.PurchaseResponse, { goods_id: request.goods_id, count: request.count }); }
      if (method === 'BuyGoods') { const request = types.BuyGoodsRequest.decode(body); return encode(types.BuyGoodsReply, { get_items: [{ id: state.shopGoods.item_id, count: String(BigInt(request.num.toString()) * BigInt(state.shopGoods.item_count)) }] }); }
      if (method === 'Sell') { const request = types.SellRequest.decode(body); return encode(types.SellReply, { sell_items: request.items, get_items: [{ id: '1001', count: '30' }] }); }
      throw new Error('Unexpected synthetic method');
    } };
  const gameConfig = { ...config, getItemById(id) {
    if (Number(id) === 40001) return { id: 40001, name: '合成果实', price: 3, price_id: 1001, sells: '1001:3' };
    if (Number(id) === 40002) return { id: 40002, name: '条件材料', price: 3, price_id: 1001, sell_cond: 'condition' };
    if (Number(id) === 700001) return { id: 700001, name: '合成藏品', type: 99 };
    return config.getItemById(id);
  }, getPlantByFruitId: id => [40001, 40002].includes(Number(id)) ? { id: 1 } : null };
  let manual;
  const mocks = { './stats': { recordOperation: (_kind, count) => { state.soldStats = (state.soldStats || 0) + count; } }, './mall': new Proxy({}, { get: (_, key) => mall[key] }), './farm-api': new Proxy({}, { get: (_, key) => farm[key] }), './manual-commerce': new Proxy({}, { get: (_, key) => manual[key] }), '../utils/network': network, '../config/gameConfig': gameConfig, '../utils/proto': proto,
    './own-quiet-priority': { wrapSend: value => value }, '../models/store': { isAutomationOn: () => false },
    '../config/runtime-paths': { getDataDir: () => dir } };
  const mall = evaluate(sources[1], mocks, env, bridge); const farm = evaluate(sources[2], mocks, env, bridge);
  const warehouse = evaluate(sources[3], { ...mocks, './manual-commerce': new Proxy({}, { get: (_, key) => manual[key] }) }, env, bridge);
  const fakeFs = new Proxy(fs, { get(target, key) { if (key === 'renameSync') return (...args) => { assert.ok(path.resolve(args[0]).startsWith(dir + path.sep)); if (state.failWrite) throw new Error('synthetic persistence failure'); return fs.renameSync(...args); }; return target[key]; } });
  manual = evaluate(sources[0], { ...mocks, 'node:fs': fakeFs, './mall': mall, './farm-api': farm, './warehouse': warehouse }, env, bridge);
  const writes = () => state.sends.filter(row => ['Purchase', 'BuyGoods', 'Sell'].includes(row.method));
  const mallRequest = () => ({ goodsId: state.goods.goods_id, count: '2', quoteFingerprint: mall.buildMallGoodsPanelEntry(proto.types.MallGoods.decode(proto.types.MallGoods.encode(proto.types.MallGoods.create(state.goods)).finish()), 0).quoteFingerprint, operationId: 'synthetic_operation_12345' });
  const shopRequest = () => ({ shopKind: 'seed', goodsId: '7', count: '2', quoteFingerprint: manual.shopPanelFields(state.shopGoods, 'seed', 1).quoteFingerprint, operationId: 'synthetic_operation_12345' });
  const saleRequest = () => ({ items: [{ id: 40001, uid: '9007199254740993', count: '3' }], quotes: { 40001: manual.quoteFingerprint(manual.bagItemQuote(40001, state.bag)) }, operationId: 'synthetic_operation_12345', explicitBatch: true });
  return { reload: () => evaluate(sources[0], { ...mocks, 'node:fs': fakeFs, './mall': mall, './farm-api': farm, './warehouse': warehouse }, env, bridge), state, manual, mall, warehouse, farm, mallRequest, shopRequest, saleRequest, writes, env };
}
test.before(async () => { await proto.loadProto(); });
test.after(() => {
  for (const [file, bytes, mode] of before) { assert.deepEqual(fs.readFileSync(file), bytes); assert.equal(fs.statSync(file).mode, mode); }
  fs.rmSync(temporary, { recursive: true, force: true });
});
test('default mall chain encodes exactly one confirmed order; operation id replay does not purchase again', async () => {
  const f = fixture(); const request = f.mallRequest();
  await f.manual.guardedMallPurchase(request); assert.equal(f.writes().length, 1);
  const sent = proto.types.PurchaseRequest.decode(f.writes()[0].body); assert.equal(sent.goods_id, 1002); assert.equal(sent.count, 2);
  assert.equal((await f.manual.guardedMallPurchase(request)).replayed, true); assert.equal(f.writes().length, 1);
});
test('invalid quantities, stale prices, unknown balances and exhausted limits produce zero writes', async () => {
  for (const value of [0, -1, 1.2, '', Number.NaN, 100, true]) {
    const f = fixture(); await assert.rejects(f.manual.guardedMallPurchase({ ...f.mallRequest(), count: value })); assert.equal(f.writes().length, 0);
  }
  for (const kind of ['price', 'balance', 'limit', 'free-conflict', 'absent-price', 'unknown-product', 'bad-limit']) {
    const f = fixture(); const request = f.mallRequest();
    if (kind === 'price') f.state.goods.price = itemBytes(1002, 43);
    if (kind === 'balance') delete f.state.wallet.coupon;
    if (kind === 'limit') { f.state.goods.limit = Buffer.from([8, 1, 16, 1, 24, 1]); request.quoteFingerprint = f.mallRequest().quoteFingerprint; }
    if (kind === 'free-conflict') f.state.goods.is_free = true;
    if (kind === 'absent-price') delete f.state.goods.price;
    if (kind === 'unknown-product') f.state.goods.goods_id = 999999;
    if (kind === 'bad-limit') { f.state.goods.is_limited = true; delete f.state.goods.limit; }
    await assert.rejects(f.manual.guardedMallPurchase(request)); assert.equal(f.writes().length, 0, kind);
  }
});
test('same-target unknown result survives module reload and changing the requested quantity', async () => {
  const f = fixture(); f.state.error = new Error('synthetic timeout');
  await assert.rejects(f.manual.guardedMallPurchase(f.mallRequest()), { code: 'COMMERCE_UNKNOWN' });
  f.state.error = null;
  await assert.rejects(f.reload().guardedMallPurchase({ ...f.mallRequest(), count: '1', operationId: 'another_operation_12345' }), { code: 'COMMERCE_PENDING' });
  assert.equal(f.writes().length, 1);
  const records = fs.readdirSync(path.join(f.state.dir, 'manual-commerce')); assert.equal(records.length, 1);
  assert.equal(fs.statSync(path.join(f.state.dir, 'manual-commerce', records[0])).mode & 0o777, 0o600);
});
test('empty typed replies and business rejections retain claims; only proven unsent budget errors can release', async () => {
  for (const kind of ['empty', 'business', 'untrusted-local', 'budget']) {
    const f = fixture();
    if (kind === 'empty') f.state.badReply = true;
    else f.state.error = Object.assign(new Error('synthetic'), kind === 'business' ? { isServerBusinessError: true } : kind === 'budget' ? { isGovernedRejection: true, governedReason: 'budget_total' } : { isLocalRequestRejection: true });
    await assert.rejects(f.manual.guardedMallPurchase(f.mallRequest()));
    f.state.badReply = false; f.state.error = null;
    if (kind === 'budget') await f.manual.guardedMallPurchase({ ...f.mallRequest(), operationId: 'another_operation_12345' });
    else await assert.rejects(f.manual.guardedMallPurchase(f.mallRequest()), { code: 'COMMERCE_PENDING' });
  }
});
test('busy operations are rejected, account/connection changes during fresh reads fence the write', async () => {
  const f = fixture(); let resolve; f.state.readGate = new Promise(done => { resolve = done; });
  const first = f.manual.guardedMallPurchase(f.mallRequest());
  await assert.rejects(f.manual.guardedMallPurchase(f.mallRequest()), { code: 'COMMERCE_BUSY' });
  f.state.epoch++; resolve(); await assert.rejects(first, { code: 'COMMERCE_OWNER' }); assert.equal(f.writes().length, 0);
});
test('persistence failure, corrupt journal and symlink ancestor fail before writes', async () => {
  const f = fixture(); f.state.failWrite = true;
  await assert.rejects(f.manual.guardedMallPurchase(f.mallRequest()), { code: 'COMMERCE_PERSIST' }); assert.equal(f.writes().length, 0);
  f.state.failWrite = false;
  const dir = path.join(f.state.dir, 'manual-commerce'); const file = path.join(dir, `${f.manual.commerceAccountKey()}.json`);
  assert.ok(file.startsWith(f.state.dir + path.sep)); fs.writeFileSync(file, '{', { mode: 0o600 });
  await assert.rejects(f.manual.guardedMallPurchase(f.mallRequest()), { code: 'COMMERCE_JOURNAL' }); assert.equal(f.writes().length, 0);
  const another = fixture(); fs.symlinkSync(dir, path.join(another.state.dir, 'manual-commerce'));
  await assert.rejects(another.manual.guardedMallPurchase(another.mallRequest())); assert.equal(another.writes().length, 0);
});
test('ordinary shop uses fresh real ShopInfo and exact 64-bit price in the encoded BuyGoods request', async () => {
  const f = fixture(); f.state.shopGoods.price = '9007199254740993'; f.state.wallet.gold = '9223372036854775807';
  await f.manual.guardedShopPurchase(f.shopRequest()); assert.equal(f.writes().length, 1);
  const request = proto.types.BuyGoodsRequest.decode(f.writes()[0].body); assert.equal(request.price.toString(), '9007199254740993'); assert.equal(request.num.toString(), '2');
  const denied = fixture(); const quote = denied.shopRequest(); denied.state.shopGoods.conds.push({ type: 2, param: '1' });
  await assert.rejects(denied.manual.guardedShopPurchase(quote), { code: 'COMMERCE_COND' }); assert.equal(denied.writes().length, 0);
});
test('partial sale preserves 64-bit UID and quantity through real Bag and Sell encoders; DTO carries exact revisions', async () => {
  const f = fixture(); f.state.bag[0].count = '9007199254740995';
  const request = f.saleRequest(); request.items[0].count = '9007199254740993';
  await f.manual.guardedBagSale(request);
  const sent = proto.types.SellRequest.decode(f.writes()[0].body); assert.equal(sent.items[0].uid.toString(), '9007199254740993'); assert.equal(sent.items[0].count.toString(), '9007199254740993');
  const detail = await f.warehouse.getBagDetail(); assert.equal(detail.originalItems[0].uidDec, '9007199254740993'); assert.equal(detail.items[0].countDec, '9007199254740995'); assert.match(detail.items[0].saleQuoteFingerprint, /^[a-f0-9]{64}$/);
});
test('sale rejects unknown/conditional material, changed inventory, duplicate UIDs and mismatched prices with zero writes', async () => {
  for (const kind of ['collectible', 'conditional', 'stale', 'duplicate', 'price']) {
    const f = fixture(); const request = f.saleRequest();
    if (kind === 'collectible' || kind === 'conditional') { const id = kind === 'collectible' ? 700001 : 40002; request.items[0].id = id; f.state.bag[0].id = String(id); request.quotes = { [id]: f.manual.quoteFingerprint(f.manual.bagItemQuote(id, f.state.bag)) }; }
    if (kind === 'stale') f.state.bag[0].count = '1';
    if (kind === 'duplicate') request.items.push({ ...request.items[0] });
    if (kind === 'price') request.quotes[40001] = '0'.repeat(64);
    await assert.rejects(f.manual.guardedBagSale(request)); assert.equal(f.writes().length, 0, kind);
  }
});
test('default decoded goods preserve proto omitted enabled semantics and strict expiry, while no unknown page is fabricated', () => {
  const f = fixture(); delete f.state.goods.enabled;
  const entry = f.mall.buildMallGoodsPanelEntry(proto.types.MallGoods.decode(proto.types.MallGoods.encode(proto.types.MallGoods.create(f.state.goods)).finish()), 0);
  assert.equal(entry.enabled, true); assert.equal(entry.zone, 'packages');
  f.state.goods.end_time = Math.floor(Date.now() / 1000);
  assert.equal(f.mall.buildMallGoodsPanelEntry(f.state.goods, 0).expired, true);
});

test('default panel readers coalesce/cool down reads and invalidate across owner changes and purchases', async () => {
  const f = fixture();
  await Promise.all([f.mall.getMallCatalogForPanel(), f.mall.getMallCatalogForPanel()]);
  await f.mall.getMallCatalogForPanel();
  assert.equal(f.state.sends.filter(row => row.method === 'GetMallListBySlotType').length, 1);
  await Promise.all([f.mall.getRegularShopForPanel(2), f.mall.getRegularShopForPanel(2)]);
  assert.equal(f.state.sends.filter(row => row.method === 'ShopInfo').length, 1);
  await f.farm.buyGoods('7', '1', '5'); await f.mall.getRegularShopForPanel(2);
  assert.equal(f.state.sends.filter(row => row.method === 'ShopInfo').length, 2);
  const failed = fixture(); failed.state.readError = new Error('synthetic read failure');
  await assert.rejects(failed.mall.getMallCatalogForPanel());
  await assert.rejects(failed.mall.getMallCatalogForPanel(), /冷却/);
  assert.equal(failed.state.sends.length, 1);
  failed.state.readError = null; failed.state.epoch++;
  await failed.mall.getMallCatalogForPanel(); assert.equal(failed.state.sends.length, 2);
});
test('a read finishing after connection replacement cannot overwrite the new cached catalog', async () => {
  const f = fixture(); let resolve;
  f.state.readGate = new Promise(done => { resolve = done; });
  const old = f.mall.getMallCatalogForPanel();
  f.state.epoch++; f.state.readGate = null;
  const current = await f.mall.getMallCatalogForPanel();
  resolve(); await assert.rejects(old, /已变更/);
  assert.equal(await f.mall.getMallCatalogForPanel(), current);
});
test('a definite business rejection pauses an unchanged offer; only a fresh changed quote permits an explicit new order', async () => {
  const f = fixture(); f.state.error = Object.assign(new Error('synthetic rejection'), { isServerBusinessError: true, serverErrorCode: 1000019 });
  await assert.rejects(f.manual.guardedMallPurchase(f.mallRequest()), { code: 'COMMERCE_REJECTED' });
  f.state.error = null;
  await assert.rejects(f.manual.guardedMallPurchase({ ...f.mallRequest(), count: '1', operationId: 'another_operation_12345' }), { code: 'COMMERCE_PENDING' });
  f.state.goods.price = itemBytes(1002, 43);
  await f.manual.guardedMallPurchase({ ...f.mallRequest(), operationId: 'another_operation_12345' });
  assert.equal(f.writes().length, 2);
});
test('invalid confirmation payloads stop before any upstream read, not merely before writes', async () => {
  for (const patch of [{ operationId: null }, { operationId: 1234567890123456 }, { quoteFingerprint: 'bad' }]) {
    const f = fixture(); await assert.rejects(f.manual.guardedMallPurchase({ ...f.mallRequest(), ...patch }), { code: 'COMMERCE_ARGS' }); assert.equal(f.state.sends.length, 0);
  }
});
test('a pending UID in a later sale group blocks the whole new batch before the first write', async () => {
  const f = fixture(); f.state.bag.push({ id: '40001', uid: '9007199254740994', count: '8' });
  f.state.error = new Error('synthetic timeout');
  const first = f.saleRequest(); first.items[0].uid = '9007199254740994';
  await assert.rejects(f.manual.guardedBagSale(first), { code: 'COMMERCE_UNKNOWN' });
  f.state.error = null;
  const next = f.saleRequest(); next.items.push({ id: 40001, uid: '9007199254740994', count: '1' }); next.operationId = 'another_operation_12345';
  await assert.rejects(f.manual.guardedBagSale(next), { code: 'COMMERCE_PENDING' }); assert.equal(f.writes().length, 1);
});
test('verified free goods with proto3 omitted zero price remain usable and respect the one-item quota', async () => {
  const f = fixture();
  f.state.goods = { goods_id: 1001, name: '每日福利', is_free: true, price: Buffer.alloc(0), item_ids: [itemBytes(80001, 1)], limit: Buffer.from([8, 1, 24, 1]) };
  delete f.state.wallet.coupon;
  const request = { ...f.mallRequest(), count: '1' };
  await f.manual.guardedMallPurchase(request); assert.equal(f.writes().length, 1);
});

test('confirmed manual sales retain existing operation statistics without counting an idempotent receipt twice', async () => {
  const f = fixture(); const request = f.saleRequest();
  await f.manual.guardedBagSale(request); assert.equal(f.state.soldStats, 3);
  await f.manual.guardedBagSale(request); assert.equal(f.state.soldStats, 3); assert.equal(f.writes().length, 1);
});

test('manual sale statistics exclude unsent budgets, unknown results, server refusals and unconfirmed replies', async () => {
  for (const kind of ['budget', 'timeout', 'server-rejection', 'empty-reply']) {
    const f = fixture();
    if (kind === 'empty-reply') f.state.badReply = true;
    else f.state.error = Object.assign(new Error('synthetic sale failure'),
      kind === 'budget' ? { isGovernedRejection: true, governedReason: 'budget_total' }
        : kind === 'server-rejection' ? { isServerBusinessError: true, serverErrorCode: 71 } : {});
    await assert.rejects(f.manual.guardedBagSale(f.saleRequest()));
    assert.equal(f.state.soldStats || 0, 0, kind);
  }
});
