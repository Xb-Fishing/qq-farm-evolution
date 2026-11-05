const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const protobuf = require('protobufjs');

const repo = path.resolve(__dirname, '../..');
const tempRoot = fs.realpathSync(os.tmpdir());
function inside(target, base) {
    const value = path.resolve(target);
    assert.ok(value === base || value.startsWith(base + path.sep), 'fixture write must stay inside its root');
    return value;
}
const fixture = fs.mkdtempSync(inside(path.join(tempRoot, 'farm-news-progress-'), tempRoot));
const originalEnv = { data: process.env.FARM_DATA_DIR, owner: process.env.FARM_ACCOUNT_ID };
process.env.FARM_DATA_DIR = fixture;
process.env.FARM_ACCOUNT_ID = 'synthetic-announcement-owner';
const serviceFile = path.join(repo, 'core/src/services/official-announcements.js');
const stateFile = path.join(repo, 'core/src/services/business-state.js');
const protectedFiles = [serviceFile, stateFile, __filename, path.join(repo, 'core/test/official-announcements.test.js')];
function fingerprint() {
    return protectedFiles.map(file => [file, crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'), fs.statSync(file).mode & 0o777]);
}
const before = fingerprint();
test.after(() => {
    try { assert.deepEqual(fingerprint(), before); }
    finally {
        for (const [key, value] of [['FARM_DATA_DIR', originalEnv.data], ['FARM_ACCOUNT_ID', originalEnv.owner]]) {
            if (value === undefined) delete process.env[key]; else process.env[key] = value;
        }
        fs.rmSync(inside(fixture, tempRoot), { recursive: true, force: true });
        assert.equal(fs.existsSync(fixture), false);
    }
});
const schema = protobuf.parse(fs.readFileSync(path.join(repo, 'core/src/proto/bulletinboardpb.proto'), 'utf8'), { keepCase: true }).root;
const type = name => schema.lookupType(`gamepb.bulletinboardpb.${name}`);
const encode = (name, value) => Buffer.from(type(name).encode(type(name).create(value)).finish());
const entries = count => Array.from({ length: count }, (_, i) => ({ id: String(81001 + i), title: `合成公告${i + 1}` }));
const deferred = t => {
    let resolve;
    const promise = new Promise(yes => { resolve = yes; });
    t.after(() => resolve());
    return { promise, resolve };
};
function load(file, requireFn, args = {}) {
    const module = { exports: {} };
    vm.runInThisContext(`(function(require,module,exports,__dirname,process,Date){${fs.readFileSync(file, 'utf8')}\n})`, { filename: file })(
        requireFn, module, module.exports, path.dirname(file), args.process || process, args.Date || Date);
    return module.exports;
}
function harness(options = {}) {
    const directory = fs.mkdtempSync(inside(path.join(fixture, 'reader-'), fixture));
    let clock = Date.UTC(2026, 10, 5, 7);
    let socket = {};
    let connected = true;
    let rows = entries(options.count || 4);
    let revision = 1;
    let send;
    const calls = [];
    const writes = [];
    const localProcess = { env: { FARM_ACCOUNT_ID: 'synthetic-owner-a', FARM_SESSION_BUSINESS: '1' } };
    const state = load(stateFile, createRequire(stateFile));
    const actualRequire = createRequire(serviceFile);
    const safeFs = new Proxy(fs, { get(target, key) {
        if (!['mkdirSync', 'writeFileSync', 'renameSync', 'rmSync'].includes(key)) return target[key];
        return (...args) => {
            inside(args[0], fixture);
            if (key === 'renameSync') inside(args[1], fixture);
            writes.push([key, args[0]]);
            return target[key](...args);
        };
    } });
    function reply(method, req) {
        return { body: method === 'GetBulletinList'
            ? encode('GetBulletinListReply', { bulletins: rows })
            : encode('GetBulletinDetailReply', { title: rows.find(row => row.id === req.id)?.title || '合成公告',
                content: `合成正文版本${revision}`, begin_time: '合成开始时间', end_time: '合成结束时间' }) };
    }
    const network = { getWs: () => socket, isConnected: () => connected,
        sendMsgAsync: async (service, method, bytes, timeout) => {
            assert.equal(service, 'gamepb.bulletinboardpb.BulletinBoardService');
            assert.ok(['GetBulletinList', 'GetBulletinDetail'].includes(method));
            assert.equal(timeout, 5000);
            const request = type(method === 'GetBulletinList' ? 'GetBulletinListRequest' : 'GetBulletinDetailRequest');
            const req = request.toObject(request.decode(bytes), { longs: String });
            if (method === 'GetBulletinList') assert.deepEqual(req, {});
            else assert.ok(rows.some(row => row.id === req.id), 'detail ID must come from this list');
            calls.push({ method, req });
            return send ? send(method, req) : reply(method, req);
        } };
    const localRequire = name => {
        if (name === '../utils/network') return network;
        if (name === './business-state') return state;
        if (name === '../config/runtime-paths') return { getDataDir: () => directory,
            getResourcePath: (...parts) => path.join(repo, 'core/src', ...parts) };
        if (name === 'node:fs') return safeFs;
        return actualRequire(name);
    };
    const sessionMode = process.env.FARM_SESSION_BUSINESS;
    let reader;
    try {
        process.env.FARM_SESSION_BUSINESS = '1';
        reader = load(serviceFile, localRequire, { process: localProcess, Date: { now: () => clock } });
    } finally {
        if (sessionMode === undefined) delete process.env.FARM_SESSION_BUSINESS;
        else process.env.FARM_SESSION_BUSINESS = sessionMode;
    }
    return { reader, state, calls, writes, directory, reply, env: localProcess.env,
        setRows: value => { rows = value; }, setRevision: value => { revision = value; },
        setSend: value => { send = value; }, advance: (ms = 300000) => { clock += ms; },
        disconnect: () => { connected = false; }, reconnect: () => { connected = true; socket = {}; },
        files: () => {
            const dir = inside(path.join(directory, 'official-game-announcements'), fixture);
            return fs.existsSync(dir) ? fs.readdirSync(dir).map(name => inside(path.join(dir, name), fixture)) : [];
        } };
}
const detailIds = calls => calls.filter(row => row.method === 'GetBulletinDetail').map(row => row.req.id);
function bounded(calls) {
    assert.equal(calls.filter(row => row.method === 'GetBulletinList').length, 1);
    assert.ok(detailIds(calls).length <= 3);
    assert.equal(new Set(detailIds(calls)).size, detailIds(calls).length);
}

test('four listed announcements complete over bounded refreshes with per-body evidence and cache reuse', async () => {
    const h = harness();
    const first = await h.reader.getOfficialAnnouncements();
    assert.equal(first.partial, true);
    assert.equal(first.announcements.filter(row => row.detailLoaded).length, 3);
    const timestamp = first.announcements[0].detailFetchedAt;
    assert.ok(timestamp > 0, 'successful bodies must have their own collection time');
    bounded(h.calls);
    const count = h.calls.length;
    assert.equal((await h.reader.getOfficialAnnouncements()).upstreamCached, true);
    assert.equal(h.calls.length, count);
    h.advance();
    const second = await h.reader.getOfficialAnnouncements();
    assert.equal(second.partial, false, 'the tail must not remain permanently unread');
    assert.equal(second.announcements[3].detailLoaded, true);
    assert.equal(second.announcements[2].detailFetchedAt, timestamp);
    assert.equal(second.announcements[2].detailCached, true);
    assert.equal(second.announcements[3].detailCached, false);
    assert.equal(detailIds(h.calls.slice(count))[0], '81004');
    bounded(h.calls.slice(count));
});

test('ten listed entries all receive details in four rounds without extra calls, duplicate or zero IDs', async () => {
    const h = harness({ count: 10 });
    h.setRows([{ id: '0', title: '无效' }, ...entries(10), entries(1)[0]]);
    let result;
    for (let round = 0; round < 4; round++) {
        const start = h.calls.length;
        result = await h.reader.getOfficialAnnouncements(); bounded(h.calls.slice(start)); h.advance();
    }
    assert.equal(result.announcements.length, 10);
    assert.equal(result.partial, false, 'every listed tail must eventually be read');
    assert.equal(new Set(detailIds(h.calls)).size, 10);
    assert.equal(detailIds(h.calls).includes('0'), false);
});

test('oldest-body rotation discovers same-ID edits and removed or retitled entries cannot inherit old content', async () => {
    const h = harness(); await h.reader.getOfficialAnnouncements(); h.advance();
    await h.reader.getOfficialAnnouncements(); h.advance(); h.setRevision(2);
    const third = await h.reader.getOfficialAnnouncements();
    assert.equal(detailIds(h.calls.slice(-4))[0], '81003');
    assert.equal(third.announcements[2].content, '合成正文版本2');
    const rows = entries(4); rows[3].title = '合成改名';
    h.setRows(rows); h.advance();
    const start = h.calls.length;
    const retitled = await h.reader.getOfficialAnnouncements();
    assert.equal(detailIds(h.calls.slice(start))[0], '81004');
    assert.equal(retitled.announcements[3].title, '合成改名');
    h.setRows(rows.slice(0, 2)); h.advance();
    const reduced = await h.reader.getOfficialAnnouncements();
    assert.deepEqual(reduced.announcements.map(row => row.id), ['81001', '81002']);
    assert.deepEqual(detailIds(h.calls.slice(-3)), ['81001', '81002']);
});

test('a new game day does not describe old bodies as fresh evidence', async () => {
    const h = harness(); await h.reader.getOfficialAnnouncements(); h.advance();
    await h.reader.getOfficialAnnouncements(); h.advance(86400000);
    const next = await h.reader.getOfficialAnnouncements();
    assert.equal(next.partial, true);
    assert.equal(next.announcements[3].detailLoaded, false);
    assert.equal(Object.hasOwn(next.announcements[3], 'content'), false);
    assert.ok(next.announcements.slice(0, 3).every(row => row.detailCached === false));
});

test('ordinary or malformed detail failure stops this round and preserves known and newly successful bodies truthfully', async () => {
    for (const malformed of [false, true]) {
        const h = harness(); await h.reader.getOfficialAnnouncements(); h.advance();
        h.setSend((method, req) => {
            if (method === 'GetBulletinDetail' && req.id === '81001') {
                if (malformed) return { body: Buffer.from([0x0A, 0xFF]) };
                throw new Error('synthetic ordinary detail failure');
            }
            return h.reply(method, req);
        });
        const start = h.calls.length;
        const result = await h.reader.getOfficialAnnouncements();
        assert.equal(result.partial, true); assert.ok(result.detailError);
        assert.equal(result.announcements.filter(row => row.detailLoaded).length, 4);
        assert.equal(result.announcements[0].detailCached, true);
        assert.equal(result.announcements[3].detailCached, false);
        assert.deepEqual(detailIds(h.calls.slice(start)), ['81004', '81001']);
        await h.reader.getOfficialAnnouncements(); assert.equal(h.calls.length, start + 3);
    }
});

test('list failures and malformed wire preserve files, cooldown, and same-scope coalescing', async t => {
    const h = harness(); await h.reader.getOfficialAnnouncements(); h.advance();
    const file = h.files()[0]; const saved = fs.readFileSync(file);
    h.setSend(() => { throw new Error('synthetic list failure'); });
    const start = h.calls.length;
    await assert.rejects(h.reader.getOfficialAnnouncements(), /synthetic list failure/);
    await assert.rejects(h.reader.getOfficialAnnouncements(), /synthetic list failure/);
    assert.equal(h.calls.length, start + 1); assert.deepEqual(fs.readFileSync(file), saved);
    h.advance(30000); const gate = deferred(t);
    h.setSend(async (method, req) => { await gate.promise; return h.reply(method, req); });
    const first = h.reader.getOfficialAnnouncements(); const second = h.reader.getOfficialAnnouncements();
    assert.equal(h.calls.length, start + 2); gate.resolve();
    await Promise.all([first, second]); assert.equal(h.calls.length, start + 5);
    h.advance(); h.setSend(() => ({ body: Buffer.from([0x0A, 0xFF]) }));
    await assert.rejects(h.reader.getOfficialAnnouncements());
});

test('list or detail late results after disconnect, socket or owner change cannot persist or cache', async t => {
    for (const phase of ['GetBulletinList', 'GetBulletinDetail']) {
        for (const change of ['disconnect', 'socket', 'owner']) {
            const h = harness(); await h.reader.getOfficialAnnouncements(); h.advance();
            const file = h.files()[0]; const saved = fs.readFileSync(file);
            const ready = deferred(t); const gate = deferred(t);
            h.setSend(async (method, req) => {
                if (method === phase) { ready.resolve(); await gate.promise; }
                return h.reply(method, req);
            });
            const pending = h.reader.getOfficialAnnouncements();
            const rejected = assert.rejects(pending, /账号或连接已变更/);
            await ready.promise;
            if (change === 'disconnect') h.disconnect();
            else if (change === 'socket') h.reconnect();
            else h.env.FARM_ACCOUNT_ID = 'synthetic-owner-b';
            const count = h.calls.length; gate.resolve(); await rejected;
            assert.equal(h.calls.length, count); assert.deepEqual(fs.readFileSync(file), saved);
            assert.equal(h.files().length, 1);
            h.reconnect(); h.setSend(null);
            const recovered = await h.reader.getOfficialAnnouncements();
            assert.equal(recovered.upstreamCached, false, 'stale scope cannot seed a cache hit or cooldown');
        }
    }
});

test('old finally does not clear a newer scope in-flight request or its successful cache', async t => {
    const h = harness(); const oldGate = deferred(t); const newGate = deferred(t);
    let lists = 0;
    h.setSend(async (method, req) => {
        if (method === 'GetBulletinList') { lists++; await (lists === 1 ? oldGate : newGate).promise; }
        return h.reply(method, req);
    });
    const old = h.reader.getOfficialAnnouncements(); const rejected = assert.rejects(old, /账号或连接已变更/);
    // A baseline may fail before reaching the await; keep teardown failures observed too.
    rejected.catch(() => {});
    h.reconnect();
    const current = h.reader.getOfficialAnnouncements();
    assert.equal(lists, 2); oldGate.resolve(); await rejected;
    const joined = h.reader.getOfficialAnnouncements(); assert.equal(lists, 2);
    newGate.resolve(); await Promise.all([current, joined]);
    assert.equal((await h.reader.getOfficialAnnouncements()).upstreamCached, true);
    assert.equal(h.calls.length, 5);
});

test('real data capsule unload and restore retains success without serializing handles, and legacy state remains compatible', async () => {
    const first = harness(); await first.reader.getOfficialAnnouncements();
    const snapshot = JSON.parse(JSON.stringify(first.state.snapshotBusinessState()));
    assert.ok(snapshot.domains['services/official-announcements.js'], 'the production reader must register its real data capsule');
    const domain = snapshot.domains['services/official-announcements.js'].value;
    assert.equal(domain.cachedOwner, 'synthetic-owner-a', 'state must bind body evidence to its owner');
    assert.equal(Object.hasOwn(domain, 'inFlight'), false); assert.equal(Object.hasOwn(domain, 'cachedScope'), false);
    const next = harness(); next.state.restoreBusinessState(snapshot);
    const result = await next.reader.getOfficialAnnouncements();
    assert.equal(result.upstreamCached, false, 'a new module must validate its socket before serving a cache hit');
    assert.equal(result.partial, false); assert.equal(detailIds(next.calls)[0], '81004');
    assert.ok(result.announcements.every(row => row.detailLoaded));
    const legacy = structuredClone(snapshot); delete legacy.domains['services/official-announcements.js'].value.cachedOwner;
    const upgraded = harness(); upgraded.state.restoreBusinessState(legacy);
    const fresh = await upgraded.reader.getOfficialAnnouncements();
    assert.equal(fresh.partial, true, 'unbound legacy evidence is not re-attributed to a new owner');
    const cold = harness(); assert.equal((await cold.reader.getOfficialAnnouncements()).partial, true);
    assert.equal(cold.calls.length, 4);
});

test('private persistence writes valid targets, rejects symlink ancestors before writes, and cleans failed temporary writes', async () => {
    const h = harness(); await h.reader.getOfficialAnnouncements();
    assert.ok(h.writes.some(row => row[0] === 'writeFileSync'));
    assert.equal(h.files().length, 1); assert.equal(fs.statSync(h.files()[0]).mode & 0o777, 0o600);
    h.advance();
    const directory = inside(path.join(h.directory, 'official-game-announcements'), fixture);
    const outside = inside(path.join(h.directory, 'separate-target'), fixture);
    fs.mkdirSync(outside, { mode: 0o700 });
    const basename = path.basename(h.files()[0]);
    fs.copyFileSync(inside(path.join(directory, basename), fixture), inside(path.join(outside, basename), fixture));
    fs.rmSync(directory, { recursive: true }); fs.symlinkSync(outside, directory);
    const saved = fs.readFileSync(inside(path.join(outside, path.basename(h.files()[0])), fixture));
    const writes = h.writes.length;
    assert.equal((await h.reader.getOfficialAnnouncements()).partial, false);
    assert.equal(h.writes.length, writes, 'symlink rejection must precede even mkdir/write');
    assert.deepEqual(fs.readFileSync(inside(path.join(outside, path.basename(h.files()[0])), fixture)), saved);
    fs.unlinkSync(directory); fs.mkdirSync(directory, { mode: 0o700 });
    fs.copyFileSync(inside(path.join(outside, basename), fixture), inside(path.join(directory, basename), fixture));
    h.advance();
    const rename = fs.renameSync;
    try {
        fs.renameSync = () => { throw new Error('synthetic rename failure'); };
        await h.reader.getOfficialAnnouncements();
    } finally { fs.renameSync = rename; }
    assert.ok(h.files().every(file => file.endsWith('.json')), 'failed atomic write leaves no temporary file');
    assert.throws(() => inside(path.join(fixture, '..', 'escape'), fixture), /fixture write/);
});
