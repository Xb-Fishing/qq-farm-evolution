'use strict';
// 程序更新失败原因回归（2026-11-12 工单）：真实 HTTP 路由 + 真实 begin 隔离夹具。
// 旧实现把六种不同失败压成同一句“暂不能更新，请先检查版本并等待当前任务结束”；
// 本套件逐原因独立断言固定 reason 与可执行文案，并核零 spawn、锁归属与日志白名单。
// 纯合成：仅回环 HTTP 与本地临时仓库，零游戏请求，不实际执行更新。
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const http = require('node:http');

// 独立 FARM_DATA_DIR：先于任何业务模块加载（与 program-update.test.js 同模式）。
const tempRoot = fs.realpathSync(os.tmpdir());
const prefix = path.join(tempRoot, 'program-update-errors-');
assert.equal(path.dirname(prefix), tempRoot);
const dataRoot = path.resolve(fs.mkdtempSync(prefix));
process.env.FARM_DATA_DIR = dataRoot;
const updater = require('../src/services/program-update');
const routes = require('../src/controllers/admin-super-admin-routes');
// 真实实现基线：路由用例临时替换 begin/check，收尾一律还原到这里，
// 不依赖 after 钩子顺序或多服务器关闭顺序。
const REAL_UPDATER = { begin: updater.begin, check: updater.check };
// Reuse the updater's existing allowlist for fixture setup; no remote is contacted.
const trustedOrigin = /'([^']+\.git)'/.exec(updater.assertTrustedOrigin.toString())?.[1];
assert.ok(trustedOrigin, 'the updater must declare a trusted source for the local fixture');
after(() => fs.rmSync(dataRoot, { recursive: true, force: true }));

// 夹具写目标一律先 resolve 并核界，再调用被测模块的原子写。
let sequence = 0;
function inside(base, relative) {
    const target = path.resolve(base, relative);
    assert.ok(target.startsWith(path.resolve(base) + path.sep), 'fixture destination must remain within its root');
    return target;
}
function fixture() {
    const dir = path.resolve(dataRoot, `case-${++sequence}`);
    assert.equal(path.dirname(dir), dataRoot);
    fs.mkdirSync(dir);
    return dir;
}
function put(dir, file, value) {
    const target = path.resolve(dir, file);
    assert.ok(target.startsWith(dir + path.sep), `夹具写目标越界: ${target}`);
    updater.put(target, value);
    return target;
}
function fixtureRepo(dir) {
    const repo = inside(dir, 'repo');
    fs.mkdirSync(repo);
    cp.execFileSync('git', ['init', '-q', repo]);
    cp.execFileSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@invalid', 'commit', '--allow-empty', '-qm', 'fixture'], { cwd: repo });
    cp.execFileSync('git', ['remote', 'add', 'origin', trustedOrigin], { cwd: repo });
    return repo;
}
function availableData(dir, repo) {
    const data = inside(dir, 'data');
    fs.mkdirSync(data);
    put(data, 'private-config.json', { evolutionKnowledgeDir: inside(dir, 'artifacts') });
    put(data, 'program-update.json', {
        phase: 'available',
        currentCommit: cp.execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(),
        targetCommit: 'b'.repeat(40), latestVersion: '9.9.9',
    });
    return data;
}
function spawnProbe() {
    const { EventEmitter } = require('node:events');
    let spawned = 0;
    const spawn = () => { spawned++; return Object.assign(new EventEmitter(), { unref: () => {} }); };
    return { spawn, count: () => spawned };
}
async function startRouteServer({ logger, begin, check } = {}) {
    const express = require('express');
    const app = express();
    if (begin) updater.begin = begin;
    if (check) updater.check = check;
    let closed = false;
    const auth = (req, res, next) => {
        const role = req.headers['x-fixture-role'];
        if (!role) return res.status(401).json({ ok: false });
        req.currentUser = { role };
        next();
    };
    routes.registerAdminSuperAdminRoutes({ app, requireAdminToken: auth, requireSuperAdminRole: (_req, res) => res.status(403).json({ ok: false }), logger });
    app.use((_req, res) => res.status(404).json({ ok: false }));
    const server = http.createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const request = (pathname, role, method = 'POST') => new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, path: pathname, method, headers: role ? { 'x-fixture-role': role } : {} }, res => {
            let raw = '';
            res.on('data', chunk => { raw += chunk; });
            res.on('end', () => resolve({ status: res.statusCode, body: raw ? JSON.parse(raw) : {}, raw }));
        });
        req.on('error', reject);
        req.end();
    });
    return {
        port, request,
        // node:test 以注册顺序执行 after 钩子（非 LIFO）；close 幂等并一律
        // 还原到模块级真实实现，多服务器用例的关闭顺序因此无关紧要。
        close: () => {
            if (closed) return Promise.resolve();
            closed = true;
            return new Promise(done => { updater.begin = REAL_UPDATER.begin; updater.check = REAL_UPDATER.check; server.closeIdleConnections(); server.close(done); });
        },
    };
}
const PREFIXES = ['/api/admin/program-update', '/api/super-admin/program-update'];
const OLD_GENERIC = '暂不能更新，请先检查版本并等待当前任务结束';

// ===== 真实路由：各已知原因独立用例（旧源同文案反证点）=====
test('install 拒绝 check_update_first：固定 reason 与“检查新版本”可执行文案，两条别名一致', async t => {
    const server = await startRouteServer({ begin: () => { throw new Error('check_update_first'); } });
    t.after(() => server.close());
    for (const prefix of PREFIXES) {
        const response = await server.request(`${prefix}/install`, 'admin');
        assert.equal(response.status, 409, `${prefix} 保持 409`);
        assert.equal(response.body.ok, false);
        assert.equal(response.body.reason, 'check_update_first', `${prefix} reason 固定`);
        assert.match(response.body.error, /检查新版本/);
        assert.notEqual(response.body.error, OLD_GENERIC);
    }
});
test('install 拒绝 evolution_busy：提示等任务结束后手动安装，而非笼统等待', async t => {
    const server = await startRouteServer({ begin: () => { throw new Error('evolution_busy'); } });
    t.after(() => server.close());
    for (const prefix of PREFIXES) {
        const response = await server.request(`${prefix}/install`, 'super_admin');
        assert.equal(response.status, 409);
        assert.equal(response.body.reason, 'evolution_busy');
        assert.match(response.body.error, /任务结束/);
        assert.match(response.body.error, /手动/);
        assert.notEqual(response.body.error, OLD_GENERIC);
    }
});
test('install 拒绝 update_busy：提示等待已有更新完成', async t => {
    const server = await startRouteServer({ begin: () => { throw new Error('update_busy'); } });
    t.after(() => server.close());
    const response = await server.request('/api/admin/program-update/install', 'admin');
    assert.equal(response.status, 409);
    assert.equal(response.body.reason, 'update_busy');
    assert.match(response.body.error, /已有.*更新/);
    assert.match(response.body.error, /等待/);
    assert.notEqual(response.body.error, OLD_GENERIC);
});
test('install 拒绝 update_requires_existing_tmux：解释不能确认原窗格并按原部署更新，不指示新开实例', async t => {
    const server = await startRouteServer({ begin: () => { throw new Error('update_requires_existing_tmux'); } });
    t.after(() => server.close());
    const response = await server.request('/api/super-admin/program-update/install', 'admin');
    assert.equal(response.status, 409);
    assert.equal(response.body.reason, 'update_requires_existing_tmux');
    assert.match(response.body.error, /tmux/);
    assert.match(response.body.error, /原部署/);
    assert.match(response.body.error, /不要另开新实例/);
    assert.notEqual(response.body.error, OLD_GENERIC);
});
test('install 拒绝 untrusted_update_source：说明来源未受信任、不自动更新', async t => {
    const server = await startRouteServer({ begin: () => { throw new Error('untrusted_update_source'); } });
    t.after(() => server.close());
    const response = await server.request('/api/admin/program-update/install', 'admin');
    assert.equal(response.status, 409);
    assert.equal(response.body.reason, 'untrusted_update_source');
    assert.match(response.body.error, /受信任/);
    assert.match(response.body.error, /来源/);
    assert.notEqual(response.body.error, OLD_GENERIC);
});
test('check 拒绝 remote_unreadable：提示检查现部署 Git 访问后手动检查', async t => {
    const server = await startRouteServer({ check: async () => { throw new Error('remote_unreadable'); } });
    t.after(() => server.close());
    for (const prefix of PREFIXES) {
        const response = await server.request(`${prefix}/check`, 'admin');
        assert.equal(response.status, 409);
        assert.equal(response.body.reason, 'remote_unreadable');
        assert.match(response.body.error, /Git/);
        assert.match(response.body.error, /手动检查/);
        assert.notEqual(response.body.error, '版本检查失败，请稍后重试');
    }
});
test('check 拒绝 untrusted_update_source：与 install 同一白名单映射', async t => {
    const server = await startRouteServer({ check: async () => { throw new Error('untrusted_update_source'); } });
    t.after(() => server.close());
    const response = await server.request('/api/admin/program-update/check', 'super_admin');
    assert.equal(response.status, 409);
    assert.equal(response.body.reason, 'untrusted_update_source');
    assert.match(response.body.error, /受信任/);
});

// ===== 未知/畸形异常：固定 unknown，不回显原文、路径、地址或请求数据 =====
test('install 未知异常映射固定 unknown，响应不携带原始错误文本', async t => {
    const server = await startRouteServer({ begin: () => { throw new Error("ENOENT: no such file or directory, open '/private-fixture/path/secret-token'"); } });
    t.after(() => server.close());
    const response = await server.request('/api/admin/program-update/install', 'admin');
    assert.equal(response.status, 409);
    assert.equal(response.body.reason, 'unknown');
    assert.match(response.body.error, /保留当前服务/);
    assert.doesNotMatch(response.raw, /private-fixture|secret-token|ENOENT/);
});
test('install 畸形异常（无 message / 非字符串 message）同样固定 unknown', async t => {
    const malformedException = { weird: 'fixture-object' };
    const server = await startRouteServer({
        begin: () => { throw malformedException; },
        check: async () => { throw Object.assign(new Error('x'), { message: 42 }); },
    });
    t.after(() => server.close());
    const install = await server.request('/api/admin/program-update/install', 'admin');
    assert.equal(install.status, 409);
    assert.equal(install.body.reason, 'unknown');
    assert.doesNotMatch(install.raw, /fixture-object/);
    const check = await server.request('/api/admin/program-update/check', 'admin');
    assert.equal(check.status, 409);
    assert.equal(check.body.reason, 'unknown');
    assert.doesNotMatch(check.raw, /"42"|NaN/);
});

test('畸形异常 getter 失败与非对象抛出仍返回固定 unknown，只读取一次 message', async t => {
    let thrown;
    let reads = 0;
    const server = await startRouteServer({ begin: () => { throw thrown; }, check: async () => { throw thrown; } });
    t.after(() => server.close());
    for (const value of [null, 'fixture-thrown-text', Object.defineProperty({}, 'message', { get() { reads++; throw new Error('fixture-accessor'); } })]) {
        thrown = value;
        for (const suffix of ['install', 'check']) {
            const response = await server.request(`/api/admin/program-update/${suffix}`, 'admin');
            assert.equal(response.status, 409);
            assert.equal(response.body.reason, 'unknown');
            assert.doesNotMatch(response.raw, /fixture-thrown-text|fixture-accessor/);
        }
    }
    assert.equal(reads, 2, 'each rejection reads the getter exactly once');
});

test('安装已入队但状态投影失败时不得声称未执行或建议重复安装', async t => {
    const originalPublicState = updater.publicState;
    let dispatched = 0;
    const server = await startRouteServer({ begin: () => { dispatched++; return { phase: 'queued' }; } });
    t.after(async () => { updater.publicState = originalPublicState; await server.close(); });
    updater.publicState = () => { throw new Error('fixture-projection-failure'); };
    const response = await server.request('/api/admin/program-update/install', 'admin');
    assert.equal(response.status, 409);
    assert.equal(response.body.reason, 'unknown');
    assert.equal(dispatched, 1);
    assert.match(response.body.error, /无法确认.*结果/);
    assert.match(response.body.error, /先刷新状态/);
    assert.match(response.body.error, /不要重复安装/);
    assert.doesNotMatch(response.body.error, /未执行|未发送|再重试/);
    assert.doesNotMatch(response.raw, /fixture-projection-failure/);
});

// ===== 日志白名单：仅固定枚举字段；sink 抛错不改变 HTTP 结果 =====
test('阻断日志仅记录固定 module/event/action/failureReason，不携带原错误或请求内容', async t => {
    const warns = [];
    const server = await startRouteServer({
        logger: { warn: (message, meta) => warns.push({ message, meta }) },
        begin: () => { throw new Error("spawn x FAILED code:7 at '/private-fixture/secret'"); },
    });
    t.after(() => server.close());
    const response = await server.request('/api/admin/program-update/install', 'admin');
    assert.equal(response.status, 409);
    assert.equal(response.body.reason, 'unknown');
    assert.equal(warns.length, 1, '一次拒绝恰好一次记录');
    const { message, meta } = warns[0];
    assert.equal(typeof message, 'string');
    assert.deepEqual(Object.keys(meta).sort(), ['action', 'event', 'failureReason', 'module'], '仅四个固定字段');
    assert.equal(meta.module, 'program-update');
    assert.equal(meta.event, 'update_action_failed');
    assert.equal(meta.action, 'install');
    assert.equal(meta.failureReason, 'unknown');
    assert.doesNotMatch(JSON.stringify({ message, meta }), /private-fixture|secret|spawn x|code:7/, '记录不得含原错误文本');
});
test('日志 sink 抛错或 logger 缺失都不改变 HTTP 结果', async t => {
    const broken = await startRouteServer({
        logger: { warn: () => { throw new Error('sink broken'); } },
        begin: () => { throw new Error('update_busy'); },
        check: async () => { throw new Error('remote_unreadable'); },
    });
    t.after(() => broken.close());
    const install = await broken.request('/api/admin/program-update/install', 'admin');
    assert.equal(install.status, 409);
    assert.equal(install.body.reason, 'update_busy');
    assert.match(install.body.error, /等待/);
    const check = await broken.request('/api/admin/program-update/check', 'admin');
    assert.equal(check.status, 409);
    assert.equal(check.body.reason, 'remote_unreadable');
    const absent = await startRouteServer({
        begin: () => { throw new Error('check_update_first'); },
    });
    t.after(() => absent.close());
    const response = await absent.request('/api/admin/program-update/install', 'admin');
    assert.equal(response.status, 409);
    assert.equal(response.body.reason, 'check_update_first');
    await broken.close();
    await absent.close();
});

// ===== 认证边界与成功路径保持不变 =====
test('认证边界保持：未登录 401、普通 user 403、admin 与 super_admin 成功，成功不记拒绝日志', async t => {
    const warns = [];
    const actions = [];
    const server = await startRouteServer({
        logger: { warn: (message, meta) => warns.push({ message, meta }) },
        check: async () => { actions.push('check'); return { phase: 'available', latestVersion: '2.0.0' }; },
        begin: () => { actions.push('install'); return { phase: 'queued' }; },
    });
    t.after(() => server.close());
    for (const pathname of PREFIXES.flatMap(p => [`${p}/check`, `${p}/install`])) {
        assert.equal((await server.request(pathname)).status, 401, `${pathname} 未认证拒绝`);
        const denied = await server.request(pathname, 'user');
        assert.equal(denied.status, 403, `${pathname} 普通用户拒绝`);
        assert.equal(denied.body.ok, false);
    }
    for (const role of ['admin', 'super_admin']) {
        const check = await server.request('/api/admin/program-update/check', role);
        assert.equal(check.status, 200);
        assert.equal(check.body.ok, true);
        assert.equal(check.body.update.phase, 'available');
        const install = await server.request('/api/super-admin/program-update/install', role);
        assert.equal(install.status, 200);
        assert.equal(install.body.ok, true);
        assert.equal(install.body.update.phase, 'queued');
        const status = await server.request('/api/admin/program-update', role, 'GET');
        assert.equal(status.status, 200);
        assert.equal(status.body.ok, true);
        assert.equal(status.body.access.canUpdate, true);
    }
    assert.deepEqual(actions, ['check', 'install', 'check', 'install']);
    assert.equal(warns.length, 0, '成功分支不记拒绝');
});

// ===== 真实 begin：零 spawn、自身锁清理、他人锁不动 =====
test('真实 begin：STATE 不存在时固定 check_update_first，零 spawn 且不留锁', () => {
    const dir = fixture();
    const repo = fixtureRepo(dir);
    const data = inside(dir, 'data');
    fs.mkdirSync(data);
    const probe = spawnProbe();
    assert.throws(() => updater.begin({ root: repo, dataDir: data, spawn: probe.spawn }),
        error => error instanceof Error && error.message === 'check_update_first', '缺失检查状态必须是稳定原因');
    assert.equal(probe.count(), 0, '零 spawn');
    assert.equal(updater.lockHeld(data), false, '不留锁');
    assert.equal(fs.existsSync(path.join(data, 'program-update.json')), false, '不落盘状态');
});
test('真实 begin：演进任务占用时固定 evolution_busy，自身锁已释放且零 spawn', () => {
    const dir = fixture();
    const repo = fixtureRepo(dir);
    const data = availableData(dir, repo);
    put(data, 'activity-evolve-state.json', { activeRun: true });
    const probe = spawnProbe();
    assert.throws(() => updater.begin({ root: repo, dataDir: data, spawn: probe.spawn, resolvePane: () => '%fixture' }), /evolution_busy/);
    assert.equal(probe.count(), 0, '零 spawn');
    assert.equal(updater.lockHeld(data), false, '自身锁必须释放');
    assert.equal(updater.read(path.join(data, 'program-update.json')).phase, 'available', '拒绝不改写可用状态');
});
test('真实 begin：已有他人更新锁时固定 update_busy，不动他人锁且零 spawn', () => {
    const dir = fixture();
    const repo = fixtureRepo(dir);
    const data = availableData(dir, repo);
    put(data, 'program-update-lock/owner.json', { runId: 'foreign-run' });
    const probe = spawnProbe();
    assert.throws(() => updater.begin({ root: repo, dataDir: data, spawn: probe.spawn, resolvePane: () => '%fixture' }), /update_busy/);
    assert.equal(probe.count(), 0, '零 spawn');
    assert.equal(updater.lockHeld(data), true, '他人锁必须原样保留');
    assert.equal(updater.read(path.join(data, 'program-update-lock', 'owner.json')).runId, 'foreign-run', '锁归属不变');
    assert.equal(updater.read(path.join(data, 'program-update.json')).phase, 'available');
});
test('真实 begin：无法运行 tmux 时固定 update_requires_existing_tmux，零 spawn 且自身锁已释放', () => {
    const dir = fixture();
    const repo = fixtureRepo(dir);
    const data = availableData(dir, repo);
    const bin = inside(dir, 'bin');
    fs.mkdirSync(bin);
    const gitBinary = cp.execFileSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
    assert.ok(gitBinary.startsWith('/'), 'fixture git 绝对路径');
    fs.symlinkSync(gitBinary, inside(bin, 'git'));
    const probe = spawnProbe();
    const previousPath = process.env.PATH;
    process.env.PATH = bin; // tmux 不可用，git 可用
    try {
        assert.throws(() => updater.begin({ root: repo, dataDir: data, spawn: probe.spawn }),
            error => error instanceof Error && error.message === 'update_requires_existing_tmux', 'tmux 不可执行必须归一化');
    } finally { process.env.PATH = previousPath; }
    assert.equal(probe.count(), 0, '零 spawn');
    assert.equal(updater.lockHeld(data), false, '自身锁必须释放');
    assert.equal(updater.read(path.join(data, 'program-update.json')).phase, 'available');
});
test('真实 begin：正常可用状态入队，spawn 一次且写入都落在隔离夹具内', () => {
    const dir = fixture();
    const repo = fixtureRepo(dir);
    const data = availableData(dir, repo);
    const probe = spawnProbe();
    const state = updater.begin({ root: repo, dataDir: data, spawn: probe.spawn, resolvePane: () => '%fixture' });
    assert.equal(state.phase, 'queued');
    assert.equal(probe.count(), 1);
    assert.equal(updater.lockHeld(data), true, '进行中的更新持有自身锁');
    const stored = updater.read(path.join(data, 'program-update.json'));
    assert.equal(stored.phase, 'queued');
    assert.ok(stored.artifactsRoot.startsWith(dir + path.sep), '产物目录必须落在夹具内');
    assert.ok(fs.existsSync(path.join(stored.artifactsRoot, 'program-updates')) || stored.artifactsRoot.includes('program-updates'));
});

test('真实 begin：tmux 可查询但没有归属窗格时拒绝且清理自身锁', () => {
    const dir = fixture();
    const repo = fixtureRepo(dir);
    const data = availableData(dir, repo);
    const probe = spawnProbe();
    const exec = cp.execFileSync;
    let paneQueries = 0;
    cp.execFileSync = (command, args, options) => {
        if (command === 'tmux') { paneQueries++; return '%fixture 1\n'; }
        return exec(command, args, options);
    };
    try {
        assert.throws(() => updater.begin({ root: repo, dataDir: data, spawn: probe.spawn }), /update_requires_existing_tmux/);
    } finally { cp.execFileSync = exec; }
    assert.equal(paneQueries, 1);
    assert.equal(probe.count(), 0);
    assert.equal(updater.lockHeld(data), false);
    assert.equal(updater.read(path.join(data, 'program-update.json')).phase, 'available');
});
