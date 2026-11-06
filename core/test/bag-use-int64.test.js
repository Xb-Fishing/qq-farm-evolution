const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const tempRoot = fs.realpathSync(os.tmpdir());
const prefix = path.resolve(tempRoot, 'farm-bag-use-int64-');
assert.equal(path.dirname(prefix), tempRoot);
const root = fs.mkdtempSync(prefix);
process.env.FARM_DATA_DIR = root;
const proto = require('../src/utils/proto');
const { createDataProvider } = require('../src/runtime/data-provider');
const { registerAdminBagRoutes } = require('../src/controllers/admin-bag-routes');
const workerFile = path.resolve(__dirname, '../src/core/worker.js');
const serviceFile = path.resolve(__dirname, '../src/services/warehouse.js');
const bytes = [workerFile, serviceFile].map(file => [file, fs.readFileSync(file)]);
test.before(() => proto.loadProto());
test.after(() => {
    for (const [file, content] of bytes) assert.deepEqual(fs.readFileSync(file), content);
    fs.rmSync(root, { recursive: true, force: true });
});
function fixture(uid = '9007199254740993') {
    const writes = [];
    const state = { bagReplies: [] };
    const network = { sendMsgAsync: async (_service, method, body) => {
        if (method === 'Bag') return { body: proto.types.BagReply.encode({ item_bag: { items: [{ id: 20001, count: 5, uid }] } }).finish() };
        writes.push({ method, body: Buffer.from(body) });
        if (method === 'Use') return { body: proto.types.UseReply.encode({}).finish() };
        if (method === 'BatchUse') return { body: proto.types.BatchUseReply.encode({}).finish() };
        throw new Error('Unexpected synthetic transport');
    } };
    const actual = createRequire(serviceFile); const mod = { exports: {} };
    const mocks = { '../utils/network': network, './own-quiet-priority': { wrapSend: value => value } };
    vm.compileFunction(fs.readFileSync(serviceFile, 'utf8'), ['require', 'module', 'exports', 'globalThis'])(
        name => Object.hasOwn(mocks, name) ? mocks[name] : actual(name), mod, mod.exports, { process: { env: {} } });
    const service = mod.exports;
    const worker = fs.readFileSync(workerFile, 'utf8');
    const start = worker.indexOf('const FRIEND_PANEL_ENTRY_METHODS = new Set([');
    const end = worker.indexOf('// ==================== 每日礼包总览', start);
    assert.ok(start > 0 && end > start);
    let response;
    const handler = new vm.Script(`${worker.slice(start, end)}\n({handleApiCall})`).runInNewContext({
        isRunning: true, loginReady: true, friendSyncPaused: false, log() {}, sendToMaster: message => { response = message; },
        require: name => name === '../services/warehouse' ? service : actual(name),
    });
    const provider = createDataProvider({ getAccounts: () => ({ accounts: [{ id: 'synthetic-a' }] }),
        callWorkerApi: async (_id, method, ...args) => {
            await handler.handleApiCall(JSON.parse(JSON.stringify({ id: 1, method, args })));
            if (response.error) throw new Error(response.error);
            return response.result;
        } });
    provider.getBag = async () => state.bagReplies.shift() || ({ originalItems: [] });
    const routes = new Map();
    registerAdminBagRoutes({ app: { get() {}, post: (url, callback) => routes.set(url, callback) }, provider,
        getAccountIdFromRequest: () => 'synthetic-a', canAccessAccount: () => true, emitRealtimeLog() {},
        sendProviderError: (res, error) => res.status(400).json({ ok: false, error: error.message }) });
    const use = async body => {
        const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; return this; } };
        await routes.get('/api/bag/use')({ body }, res); return res;
    };
    return { service, writes, use, state };
}
test('real bag route, provider, Worker and protobuf encode exact long UID and quantity', async () => {
    for (const uid of ['9007199254740993', '9223372036854775806']) {
        const f = fixture(uid);
        const response = await f.use({ itemId: 20001, count: '9007199254740993', uid });
        assert.equal(response.body.ok, true, response.body.error);
        assert.equal(f.writes.length, 1);
        const sent = proto.types.UseRequest.decode(f.writes[0].body);
        assert.equal(sent.item.uid.toString(), uid);
        assert.equal(sent.item.count.toString(), '9007199254740993');
    }
});
test('missing UID bag lookup and batch use preserve all int64 bits', async () => {
    const f = fixture('9223372036854775806');
    await f.service.useItem(20001, 1);
    assert.equal(proto.types.UseRequest.decode(f.writes[0].body).item.uid.toString(), '9223372036854775806');
    await f.service.batchUseItems([{ itemId: 20001, count: '9007199254740993', uid: '9007199254740993' }]);
    const sent = proto.types.BatchUseRequest.decode(f.writes[1].body);
    assert.equal(sent.items[0].uid.toString(), '9007199254740993');
    assert.equal(sent.items[0].count.toString(), '9007199254740993');
});
test('unsafe numeric identities, invalid counts and values outside signed int64 cause zero writes', async () => {
    for (const input of [{ uid: 9007199254740992 }, { uid: '9223372036854775808' }, { uid: '-1' }, { count: 9007199254740992 }, { count: '0' }, { count: '1.5' }]) {
        const f = fixture();
        const response = await f.use({ itemId: 20001, uid: '9007199254740993', count: '1', ...input });
        assert.equal(response.body.ok, false);
        assert.equal(f.writes.length, 0);
        await assert.rejects(f.service.batchUseItems([{ itemId: 20001, uid: '9007199254740993', count: '1', ...input }]));
        assert.equal(f.writes.length, 0);
    }
});
test('bag-use feedback computes exact reward differences across multiple stacks', async () => {
    const f = fixture();
    f.state.bagReplies = [{ originalItems: [{ id: 1001, countDec: '9007199254740992' }, { id: 1001, count: 2 }] },
        { originalItems: [{ id: 1001, countDec: '9007199254740993' }, { id: 1001, count: 2 }] }];
    const response = await f.use({ itemId: 20001, count: 1, uid: '9007199254740993' });
    assert.equal(response.body.ok, true);
    assert.deepEqual(response.body.data.items.map(item => ({ id: item.id, count: item.count })), [{ id: 1001, count: 1 }]);
});
