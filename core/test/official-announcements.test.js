const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const protobuf = require('protobufjs');

const root = path.resolve(__dirname, '../..');
const tempRoot = fs.realpathSync(os.tmpdir());
function inside(target, base) {
    const value = path.resolve(target);
    assert.ok(value === base || value.startsWith(base + path.sep));
    return value;
}
const fixture = fs.mkdtempSync(inside(path.join(tempRoot, 'farm-announcement-'), tempRoot));
process.env.FARM_DATA_DIR = fixture;
process.env.FARM_ACCOUNT_ID = 'synthetic-news-account';
const protectedFiles = ['core/src/services/official-announcements.js', 'core/src/proto/bulletinboardpb.proto',
    'core/src/controllers/admin-official-announcement-routes.js', 'core/src/core/worker.js',
    'core/src/runtime/data-provider.js', 'core/test/official-announcements.test.js'];
function fingerprint() {
    return protectedFiles.map(file => {
        const target = path.join(root, file); const stat = fs.statSync(target);
        return [file, crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex'), stat.mode & 0o777, stat.size];
    });
}
const original = fingerprint();
test.after(() => {
    try { assert.deepEqual(fingerprint(), original); }
    finally { fs.rmSync(inside(fixture, tempRoot), { recursive: true, force: true }); }
});
const serviceFile = path.join(root, protectedFiles[0]);
const schema = protobuf.parse(fs.readFileSync(path.join(root, protectedFiles[1]), 'utf8'), { keepCase: true }).root;
const type = name => schema.lookupType(`gamepb.bulletinboardpb.${name}`);
const encode = (name, value) => Buffer.from(type(name).encode(type(name).create(value)).finish());
const defer = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

function harness(t, options = {}) {
    let clock = 1_800_000_000_000;
    let connected = true;
    const calls = [];
    const network = { isConnected: () => connected, sendMsgAsync: async (service, method, payload) => {
        const req = type(method === 'GetBulletinList' ? 'GetBulletinListRequest' : 'GetBulletinDetailRequest').toObject(
            type(method === 'GetBulletinList' ? 'GetBulletinListRequest' : 'GetBulletinDetailRequest').decode(payload), { longs: String });
        calls.push({ service, method, req, bytes: payload.length });
        if (options.send) return options.send(method, req);
        if (method === 'GetBulletinList') return { body: encode('GetBulletinListReply', { bulletins: options.entries || [
            { id: '71001', title: '合成更新说明', status: 1 }, { id: '71002', title: '合成玩法说明' },
        ] }) };
        return { body: encode('GetBulletinDetailReply', { title: '合成更新说明',
            content: '<p>合成活动玩法</p><script>untrusted()</script><p>奖励&amp;次数&#12290;</p>',
            begin_time: '2026-10-14', end_time: '2026-10-21' }) };
    } };
    const request = createRequire(serviceFile);
    const module = { exports: {} };
    const localRequire = name => name === '../utils/network' ? network : request(name);
    const localDate = { now: () => clock };
    vm.runInThisContext(`(function(require,module,exports,__dirname,Date){${  fs.readFileSync(serviceFile, 'utf8')  }\n})`, { filename: serviceFile })(localRequire, module, module.exports, path.dirname(serviceFile), localDate);
    return { ...module.exports, calls, setClock: value => { clock = value; }, now: () => clock,
        disconnect: () => { connected = false; } };
}

test('actual reader sends one list and only listed details, keeps read items and text/dates, saves private facts', async t => {
    const h = harness(t); const result = await h.getOfficialAnnouncements();
    assert.deepEqual(h.calls.map(x => x.method), ['GetBulletinList', 'GetBulletinDetail', 'GetBulletinDetail']);
    assert.deepEqual(h.calls[0].req, {});
    assert.ok(h.calls.every(x => x.service === 'gamepb.bulletinboardpb.BulletinBoardService'));
    assert.deepEqual(h.calls.slice(1).map(x => x.req.id), ['71001', '71002']);
    assert.equal(result.announcements.length, 2, 'read status is not availability');
    assert.equal(result.announcements[0].content, '合成活动玩法\n奖励&次数。');
    assert.equal(result.announcements[0].beginTime, '2026-10-14');
    assert.equal(result.partial, false);
    const dir = inside(path.join(fixture, 'official-game-announcements'), fixture);
    const files = fs.readdirSync(dir).filter(x => x.endsWith('.json'));
    assert.equal(files.length, 1); assert.doesNotMatch(files[0], /synthetic-news-account/);
    const file = inside(path.join(dir, files[0]), fixture);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(JSON.parse(fs.readFileSync(file)).source, 'official-game-bulletin');
});

test('concurrent reads coalesce and five-minute cache prevents extra upstream calls', async t => {
    const gate = defer();
    const h = harness(t, { send: async method => {
        assert.equal(method, 'GetBulletinList'); await gate.promise;
        return { body: encode('GetBulletinListReply', {}) };
    } });
    const first = h.getOfficialAnnouncements(); const second = h.getOfficialAnnouncements();
    assert.equal(h.calls.length, 1); gate.resolve();
    await Promise.all([first, second]);
    assert.equal((await h.getOfficialAnnouncements()).upstreamCached, true); assert.equal(h.calls.length, 1);
    h.setClock(h.now() + 300000);
    await h.getOfficialAnnouncements(); assert.equal(h.calls.length, 2);
});

test('list failure or invalid encoding stops with no alternative method or retry, failure cooldown expires', async t => {
    const h = harness(t, { send: () => { throw new Error('synthetic rejected'); } });
    await assert.rejects(h.getOfficialAnnouncements(), /synthetic rejected/);
    await assert.rejects(h.getOfficialAnnouncements(), /synthetic rejected/);
    assert.equal(h.calls.length, 1);
    h.setClock(h.now() + 30000); await assert.rejects(h.getOfficialAnnouncements());
    assert.equal(h.calls.length, 2);
    const bad = harness(t, { send: () => ({ body: Buffer.from([0x0A, 0xFF]) }) });
    await assert.rejects(bad.getOfficialAnnouncements()); assert.equal(bad.calls.length, 1);
});

test('detail failure keeps truthful list and partial marker, stops remaining requests', async t => {
    const h = harness(t, { send: method => {
        if (method === 'GetBulletinList') return { body: encode('GetBulletinListReply', { bulletins: [{ id: '71001', title: '列表标题' }, { id: '71002', title: '后续标题' }] }) };
        throw new Error('synthetic detail failed');
    } });
    const result = await h.getOfficialAnnouncements();
    assert.equal(result.partial, true); assert.match(result.detailError, /synthetic detail failed/);
    assert.equal(result.announcements[0].title, '列表标题'); assert.equal(result.announcements[0].detailLoaded, false);
    assert.equal(h.calls.length, 2);
    await h.getOfficialAnnouncements(); assert.equal(h.calls.length, 2);
});

test('bounded detail count and duplicate/zero ids never produce guessed detail requests', async t => {
    const entries = [{ id: 0, title: '无编号' }, ...Array.from({ length: 10 }, (_, i) => ({ id: String(71001 + i), title: '合成公告' })), { id: '71001', title: '重复' }];
    const h = harness(t, { entries }); const result = await h.getOfficialAnnouncements();
    assert.equal(result.announcements.length, 10); assert.equal(result.partial, true);
    assert.equal(h.calls.length, 4); assert.equal(new Set(h.calls.slice(1).map(x => x.req.id)).size, 3);
});

test('offline guard makes zero calls and file symlink refuses persistence without changing its outside target', async t => {
    const h = harness(t); h.disconnect(); await assert.rejects(h.getOfficialAnnouncements(), /未连接/); assert.equal(h.calls.length, 0);
    const other = inside(path.join(fixture, 'outside-target.json'), fixture); fs.writeFileSync(other, 'untouched');
    const dir = inside(path.join(fixture, 'official-game-announcements'), fixture);
    const key = crypto.createHash('sha256').update('synthetic-news-account').digest('hex').slice(0, 24);
    const target = inside(path.join(dir, `${key  }.json`), fixture); fs.rmSync(target, { force: true }); fs.symlinkSync(other, target);
    const connected = harness(t); const result = await connected.getOfficialAnnouncements();
    assert.equal(result.announcements.length, 2); assert.equal(fs.readFileSync(other, 'utf8'), 'untouched');
    fs.rmSync(target, { force: true });
});

test('real route and provider forward authorized account; no read for unauthorized or disconnected accounts', async () => {
    const { registerAdminOfficialAnnouncementRoutes } = require('../src/controllers/admin-official-announcement-routes');
    const { createDataProvider } = require('../src/runtime/data-provider');
    const calls = []; const payload = { source: 'official-game-bulletin', announcements: [] };
    const provider = createDataProvider({ workers: { synthetic: { status: { connection: { connected: true } } } },
        getAccounts: () => ({ accounts: [{ id: 'synthetic' }] }), buildDefaultStatus: () => ({}), normalizeStatusForPanel: v => v,
        callWorkerApi: async (...args) => { calls.push(args); return payload; } });
    let route; let allowed = true;
    registerAdminOfficialAnnouncementRoutes({ app: { get: (_path, handler) => { route = handler; } }, provider,
        getAccountIdFromRequest: () => 'synthetic', canAccessAccount: () => allowed,
        sendProviderError: () => assert.fail('unexpected provider failure') });
    const res = { status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; } };
    await route({}, res); assert.equal(res.body.ok, true); assert.deepEqual(calls, [['synthetic', 'getOfficialAnnouncements']]);
    allowed = false; await route({}, res); assert.equal(calls.length, 1);
    allowed = true; provider.getStatus = () => ({ connection: { connected: false } });
    await route({}, res); assert.equal(calls.length, 1);
});

test('actual Worker API switch executes reader and returns success or error through its existing response channel', async t => {
    const h = harness(t);
    const source = fs.readFileSync(path.join(root, 'core/src/core/worker.js'), 'utf8');
    const start = source.indexOf('async function handleApiCall(msg)');
    const end = source.indexOf('// ==================== 每日礼包总览', start);
    assert.ok(start > 0 && end > start);
    const responses = [];
    const context = vm.createContext({
        FRIEND_PANEL_ENTRY_METHODS: new Set(), BAG_PANEL_ENTRY_METHODS: new Set(),
        isRunning: true, loginReady: true, getWs: () => ({ readyState: 1 }),
        require: name => { assert.equal(name, '../services/official-announcements'); return h; },
        sendToMaster: value => responses.push(JSON.parse(JSON.stringify(value))),
        collectPetDiaryErrorMeta: () => null,
    });
    const handle = vm.runInContext(`${source.slice(start, end)}\n;handleApiCall`, context);
    await handle({ id: 'synthetic-request', method: 'getOfficialAnnouncements', args: [] });
    assert.equal(responses[0].error, null); assert.equal(responses[0].result.source, 'official-game-bulletin');
    assert.equal(responses[0].result.announcements.length, 2);
    h.disconnect();
    await handle({ id: 'synthetic-offline', method: 'getOfficialAnnouncements', args: [] });
    assert.match(responses[1].error, /账号未连接/);
    assert.equal(h.calls.length, 3);
    context.loginReady = false;
    await handle({ id: 'synthetic-unready', method: 'getOfficialAnnouncements', args: [] });
    assert.match(responses[2].error, /账号未就绪/);
    assert.equal(h.calls.length, 3);
});
