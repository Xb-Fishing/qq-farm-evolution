'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const prefix = path.resolve(fs.realpathSync(os.tmpdir()), 'farm-manual-fertilize-');
assert.equal(path.dirname(prefix), fs.realpathSync(os.tmpdir()));
const root = fs.mkdtempSync(prefix);
process.env.FARM_DATA_DIR = root;
const proto = require('../src/utils/proto');
const { createDataProvider } = require('../src/runtime/data-provider');
const { registerAdminFarmOperationRoutes } = require('../src/controllers/admin-farm-operation-routes');
const serviceFile = path.resolve(__dirname, '../src/services/farm-api.js');
const workerFile = path.resolve(__dirname, '../src/core/worker.js');
const sources = [serviceFile, workerFile].map(file => [file, fs.readFileSync(file)]);
test.before(() => proto.loadProto());
test.after(() => {
  for (const [file, bytes] of sources) assert.deepEqual(fs.readFileSync(file), bytes);
  fs.rmSync(root, { recursive: true, force: true });
});
function fixture({ failure = false, allowed = true } = {}) {
  const writes = []; const logs = []; const workerCalls = []; const invalidations = [];
  const actual = createRequire(serviceFile);
  const mod = { exports: {} };
  const mocks = {
    '../utils/network': { getUserState: () => ({ gid: 910000 }), sendMsgAsync: async (service, method, body) => {
      assert.equal(service, 'gamepb.plantpb.PlantService'); assert.equal(method, 'Fertilize');
      writes.push(Buffer.from(body));
      if (failure) throw new Error('synthetic lost reply');
      return { body: proto.types.FertilizeReply.encode({}).finish() };
    } },
    './own-quiet-priority': { wrapSend: send => send },
  };
  vm.compileFunction(fs.readFileSync(serviceFile, 'utf8'), ['require', 'module', 'exports', 'globalThis'])(
    name => Object.hasOwn(mocks, name) ? mocks[name] : actual(name), mod, mod.exports, { process: { env: {} } });
  const worker = fs.readFileSync(workerFile, 'utf8');
  const start = worker.indexOf('const FRIEND_PANEL_ENTRY_METHODS = new Set([');
  const end = worker.indexOf('// ==================== 每日礼包总览', start);
  assert.ok(start > 0 && end > start);
  let response;
  const handler = new vm.Script(`${worker.slice(start, end)}\n({ handleApiCall })`).runInNewContext({
    ...mod.exports, isRunning: true, loginReady: true, friendSyncPaused: false,
    log: (...args) => logs.push(args), sendToMaster: value => { response = value; },
    require: name => {
      if (name === '../services/farm-land-analyzer') return { invalidatePanelLandsCache: () => invalidations.push('lands') };
      if (name === '../services/warehouse') return { invalidatePanelBagCache: () => invalidations.push('bag') };
      throw new Error(`Unexpected worker dependency ${name}`);
    },
  });
  async function callWorkerApi(id, method, ...args) {
    workerCalls.push({ id, method, args });
    await handler.handleApiCall(JSON.parse(JSON.stringify({ id: workerCalls.length, method, args })));
    if (response.error) throw new Error(response.error);
    return JSON.parse(JSON.stringify(response.result));
  }
  const provider = createDataProvider({ getAccounts: () => ({ accounts: [{ id: 'synthetic-fertilize' }] }), callWorkerApi });
  const routes = new Map();
  registerAdminFarmOperationRoutes({ app: { post: (url, handler) => routes.set(url, handler) }, provider,
    getAccountIdFromRequest: () => 'synthetic-fertilize', canAccessAccount: () => allowed,
    sendProviderError: (res, error) => res.status(400).json({ ok: false, error: error.message }) });
  async function request(body) {
    const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; return this; } };
    await routes.get('/api/land/fertilize')({ body }, res);
    return res;
  }
  return { request, writes, logs, workerCalls, invalidations, callWorkerApi, provider };
}

test('real fertilizer route/provider/Worker/shared service encodes normal 1011 and preserves organic/default 1012', async () => {
  for (const [type, expectedId] of [['normal', '1011'], ['organic', '1012'], [undefined, '1012']]) {
    const f = fixture();
    const response = await f.request({ landId: 910001, ...(type === undefined ? {} : { fertilizerType: type }) });
    assert.equal(response.body.ok, true, response.body.error);
    assert.deepEqual(response.body.data, { success: true, count: 1 });
    assert.equal(f.writes.length, 1);
    const sent = proto.types.FertilizeRequest.decode(f.writes[0]);
    assert.equal(sent.fertilizer_id.toString(), expectedId);
    assert.deepEqual(sent.land_ids.map(String), ['910001']);
    assert.deepEqual(f.workerCalls[0], { id: 'synthetic-fertilize', method: 'fertilizeLand', args: [910001, type || 'organic'] });
    assert.deepEqual(f.invalidations, ['lands', 'bag']);
    if (type === 'normal') assert.ok(f.logs.every(row => !row[1].includes('催熟')));
  }
});

test('malformed fertilizer types and inaccessible account stop before Worker or game write', async () => {
  for (const type of [null, '', 'NORMAL', 'other', 1011, true, [], {}]) {
    const f = fixture();
    const response = await f.request({ landId: 910001, fertilizerType: type });
    assert.equal(response.statusCode, 400); assert.equal(response.body.ok, false);
    assert.equal(f.workerCalls.length, 0); assert.equal(f.writes.length, 0);
    await assert.rejects(f.callWorkerApi('synthetic-fertilize', 'fertilizeLand', 910001, type), /无效的肥料类型/);
    assert.equal(f.writes.length, 0, 'direct Worker calls validate too');
  }
  const f = fixture({ allowed: false });
  assert.equal((await f.request({ landId: 910001, fertilizerType: 'normal' })).statusCode, 403);
  assert.equal(f.workerCalls.length, 0);
});

test('legacy direct provider/Worker defaults organic and lost normal reply never retries or confirms success', async () => {
  const legacy = fixture();
  await legacy.provider.fertilizeLand('synthetic-fertilize', 910001);
  await legacy.callWorkerApi('synthetic-fertilize', 'fertilizeLand', 910002);
  assert.deepEqual(legacy.writes.map(body => proto.types.FertilizeRequest.decode(body).fertilizer_id.toString()), ['1012', '1012']);
  const f = fixture({ failure: true });
  const response = await f.request({ landId: 910001, fertilizerType: 'normal' });
  assert.equal(f.writes.length, 1, 'shared service must not replay an uncertain write');
  assert.equal(response.body.ok, true);
  assert.deepEqual(response.body.data, { success: false, count: 0 });
  assert.match(f.logs.at(-1)[1], /未确认/);
});
