const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), vm = require('node:vm'), crypto = require('node:crypto'), { createRequire } = require('node:module');
const parent = fs.realpathSync(os.tmpdir()), data = fs.mkdtempSync(path.join(parent, 'farm-read-panels-'));
process.env.FARM_DATA_DIR = data; process.env.FARM_ACCOUNT_ID = 'synthetic-query';
const source = path.resolve(__dirname, '../src/services/game-panel-readonly.js'), original = fs.readFileSync(source), originalHash = crypto.createHash('sha256').update(original).digest('hex');
test.after(() => { assert.equal(crypto.createHash('sha256').update(fs.readFileSync(source)).digest('hex'), originalHash); fs.rmSync(data, { recursive: true, force: true }); });
function varint(value) { let n = BigInt(value), out = []; do { const b = Number(n & 127n); n >>= 7n; out.push(b | (n ? 128 : 0)); } while (n); return Buffer.from(out); }
function scalar(field, value) { return Buffer.concat([varint(field * 8), varint(value)]); }
function nested(field, bytes) { return Buffer.concat([varint(field * 8 + 2), varint(bytes.length), bytes]); }
const collection = () => Buffer.concat([scalar(1, 710001), scalar(2, 0), scalar(3, 0), scalar(5, '9007199254740993')]);
const collectionBody = rows => nested(1, Buffer.concat([scalar(1, 1), ...rows.map(row => nested(2, row)), scalar(5, 0), scalar(6, 0)]));
const dogBody = () => Buffer.concat([nested(1, Buffer.concat([scalar(1, 1), nested(2, Buffer.from('测试犬')), scalar(5, 2)])), scalar(2, 1), scalar(3, 123456), scalar(4, 2592000), nested(5, Buffer.concat([scalar(1, 90004), scalar(2, 86400), scalar(3, 999)])), scalar(7, 0)]);
function fixture(body) {
  const calls = [], requireActual = createRequire(source), module = { exports: {} };
  let foodCount = 7;
  const mocks = { '../utils/network': { sendMsgAsync: async (service, method, request) => { calls.push({ service, method, hex: Buffer.from(request).toString('hex') }); if (body instanceof Error) throw body; return { body }; } }, './warehouse': { getBag: async () => { calls.push({ method: 'Bag' }); return { items: [{ id: 90004, count: foodCount }, { id: 90005, count: '9007199254740993' }] }; }, getBagItems: reply => reply.items, getBagDetail: () => { throw new Error('cached inventory must not be used'); } } };
  vm.compileFunction(original.toString(), ['require', 'module', 'exports', 'process', 'Buffer'])(name => Object.hasOwn(mocks, name) ? mocks[name] : requireActual(name), module, module.exports, process, Buffer);
  return { calls, setFoodCount: value => { foodCount = value; }, ...module.exports };
}
function evidence(kind) { const name = crypto.createHash('sha256').update(`${process.env.FARM_ACCOUNT_ID}:${kind}`).digest('hex') + '.json'; return JSON.parse(fs.readFileSync(path.join(data, 'game-panel-read-evidence', name))); }
test('collection default reader sends only category one, preserves exact counts and explicit zero wire fields', async () => {
  const f = fixture(collectionBody([collection()])), result = await f.getCollectionReadPanel();
  assert.deepEqual(f.calls, [{ service: 'gamepb.collectionpb.CollectionService', method: 'GetCollections', hex: '0a0101' }]);
  assert.equal(result.items[0].name, '菇菇氧'); assert.equal(result.items[0].star, 0); assert.equal(result.items[0].ownedCountDec, '9007199254740993'); assert.equal(result.currentScore, 0); assert.equal(result.writesEnabled, false);
  const stored = evidence('collections'); assert.equal(stored.schemaRoundtrip, true); assert.equal(stored.decoded.details[0].collections[0].is_new, false); assert.equal(stored.decoded.details[0].current_score, 0); assert.equal(Buffer.from(stored.replyBase64, 'base64').equals(collectionBody([collection()])), true);
});
test('dog reader keeps disputed time unknown and reads inventory exclusively from Bag', async () => {
  const f = fixture(dogBody()), result = await f.getDogReadPanel();
  assert.deepEqual(f.calls, [{ service: 'gamepb.dogpb.DogService', method: 'GetDogInfo', hex: '' }, { method: 'Bag' }]);
  assert.equal(result.currentDogName, '测试犬'); assert.equal(result.foods[0].countDec, '7'); assert.equal(result.foods[1].countDec, '9007199254740993'); assert.equal(result.foods[2].countDec, '0'); assert.equal(result.protectionKnown, false); assert.equal(result.feedingEnabled, false); assert.equal(result.pendingGiftCountDec, '0');
  const stored = evidence('dog'); assert.equal(stored.decoded.field_3, '123456'); assert.equal(stored.decoded.field_4, '2592000'); assert.equal(stored.decoded.foods[0].field_3, '999'); assert.equal(stored.schemaRoundtrip, true);
});
test('missing category, repeated collection and malformed dog replies fail without fallback writes', async () => {
  await assert.rejects(fixture(Buffer.alloc(0)).getCollectionReadPanel(), /未返回/); await assert.rejects(fixture(collectionBody([collection(), collection()])).getCollectionReadPanel(), /重复/); await assert.rejects(fixture(Buffer.alloc(0)).getDogReadPanel(), /不完整/);
  const f = fixture(new Error('synthetic server read error')); await assert.rejects(f.getCollectionReadPanel(), /synthetic/); assert.equal(f.calls.length, 1);
});
function routeFixture() {
  const routes = new Map(), calls = []; let scope = 'one', connected = true, allowed = true, gate;
  const state = { fetchedAt: 1, items: [], displays: [], currentScore: 0, claimedScore: 0, writesEnabled: false };
  require('../src/controllers/admin-game-update-routes').registerAdminGameUpdateRoutes({ app: { get: (url, handler) => routes.set(url, handler) }, getAccountIdFromRequest: req => req.accountId, canAccessAccount: () => allowed, sendProviderError: (res, error) => res.json({ ok: false, error: error.message }), provider: { getStatus: () => ({ connection: { connected } }), getGamePanelReadScope: () => scope, getCollectionReadPanel: async id => { calls.push(id); if (gate) return gate; return state; }, getDogReadPanel: async id => { calls.push(id); return { dogs: [] }; } } });
  async function query(accountId = 'synthetic-query') { const res = { status(code) { this.code = code; return this; }, json(body) { this.body = body; } }; await routes.get('/api/activity/collection-state')({ accountId }, res); return res; }
  return { calls, query, changeScope: () => { scope = 'two'; }, setConnected: v => { connected = v; }, setAllowed: v => { allowed = v; }, setGate: v => { gate = v; } };
}
test('real routes cache successful reads and reject unauthorized/offline accounts without another-account fallback', async () => {
  const f = routeFixture(); assert.equal((await f.query()).body.ok, true); assert.equal((await f.query()).body.upstreamCached, true); assert.deepEqual(f.calls, ['synthetic-query']); f.setAllowed(false); assert.equal((await f.query('other')).code, 403); f.setAllowed(true); f.setConnected(false); assert.equal((await f.query()).body.ok, false); assert.equal(f.calls.length, 1);
});
test('changed connection discards a late read/cache and an ordinary failure has a cooldown', async () => {
  let resolve; const f = routeFixture(); f.setGate(new Promise(r => { resolve = r; })); const pending = f.query(); await new Promise(r => setImmediate(r)); f.changeScope(); resolve({ items: [] }); assert.equal((await pending).body.ok, false);
  f.setGate(Promise.reject(new Error('synthetic read failure'))); assert.equal((await f.query()).body.ok, false); assert.equal((await f.query()).body.ok, false); assert.equal(f.calls.length, 2);
});

test('real provider binds read cache scope to the worker, account and actual connection epochs', async () => {
  const { createDataProvider } = require('../src/runtime/data-provider');
  const account = { id: 'synthetic-query', platform: 'wx', wxid: 'synthetic-binding' }, calls = [];
  const facts = { host: { hostId: 'synthetic-host' }, game: { connected: true, connectionEpoch: 1, loginEpoch: 1 }, business: { ready: true, epoch: 'one' } };
  const workers = { 'synthetic-query': { status: { connection: { connected: true } }, process: { persistentSession: true, sessionFacts: facts } } };
  const provider = createDataProvider({ workers, getAccounts: () => ({ accounts: [account] }), callWorkerApi: async (...args) => { calls.push(args); return {}; } });
  const original = provider.getGamePanelReadScope(account.id); facts.sequence = 20; assert.equal(provider.getGamePanelReadScope(account.id), original);
  facts.game.connectionEpoch = 2; assert.notEqual(provider.getGamePanelReadScope(account.id), original); account.wxid = 'synthetic-new-binding'; const changed = provider.getGamePanelReadScope(account.id); assert.notEqual(changed, original);
  facts.game.connected = undefined; assert.throws(() => provider.getGamePanelReadScope(account.id), /未就绪/); facts.game.connected = true;
  await provider.getCollectionReadPanel(account.id); await provider.getDogReadPanel(account.id); assert.deepEqual(calls, [[account.id, 'getCollectionReadPanel'], [account.id, 'getDogReadPanel']]);
});

// A new connection scope must not inherit the warehouse panel's older inventory.
test('a fresh dog read observes changed Bag inventory instead of the old panel cache', async () => {
  const f = fixture(dogBody()); assert.equal((await f.getDogReadPanel()).foods[0].countDec, '7');
  f.setFoodCount(3); assert.equal((await f.getDogReadPanel()).foods[0].countDec, '3');
  assert.equal(f.calls.filter(row => row.method === 'Bag').length, 2);
  assert.equal(f.calls.filter(row => row.method === 'GetDogInfo').length, 2);
});
