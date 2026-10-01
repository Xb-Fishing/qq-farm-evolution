'use strict';
// 自部署注册/引导回归（2026-10-01 工单：免费领卡提示库存不足）：
// 1) docker compose 转发 FARM_ADMIN_USERNAME/FARM_ADMIN_PASSWORD（默认空，未设置照常启动）；
// 2) 全新数据目录可从宿主环境安全初始化管理员并免卡密登录；无/非法环境不产生不安全管理员；
//    已有管理员不被后续不同环境覆盖；
// 3) 卡密领取配置：全新/不可读默认关闭，显式 enabled/disabled 保持不变；
// 4) 库存只统计未用/启用的时间卡密；管理员建卡并开启后领取成功，注册消耗库存，
//    同一 UA 24 小时内只发一张（发放语义不变）。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '../..');
const USER_STORE_PATH = require.resolve('../src/models/user-store');
const RUNTIME_PATHS_PATH = require.resolve('../src/config/runtime-paths');
const ADMIN_ENV_KEYS = ['FARM_ADMIN_USERNAME', 'FARM_ADMIN_PASSWORD', 'ADMIN_PASSWORD'];
const TEST_ENV_KEYS = ['FARM_DATA_DIR', ...ADMIN_ENV_KEYS];
const tempDirs = new Set();
let originalEnv;

test.beforeEach(() => {
    originalEnv = Object.fromEntries(TEST_ENV_KEYS.map(key => [key, process.env[key]]));
});

test.afterEach(() => {
    for (const mod of [USER_STORE_PATH, RUNTIME_PATHS_PATH]) delete require.cache[mod];
    for (const key of TEST_ENV_KEYS) {
        if (originalEnv[key] === undefined) delete process.env[key];
        else process.env[key] = originalEnv[key];
    }
    for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
    tempDirs.clear();
});

// user-store 在 require 时固化数据文件路径并执行 initConfiguredAdmin()，
// 因此每个场景都必须：清掉管理员环境 -> 设 FARM_DATA_DIR -> 清缓存后重新 require。
function loadStore(dataDir, envPatch = {}) {
    for (const key of ADMIN_ENV_KEYS) delete process.env[key];
    process.env.FARM_DATA_DIR = dataDir;
    Object.assign(process.env, envPatch);
    for (const mod of [USER_STORE_PATH, RUNTIME_PATHS_PATH]) delete require.cache[mod];
    // ensureDataDir() 会在后续调用时读取环境，因此隔离目录必须保持到场景结束。
    return require(USER_STORE_PATH);
}

function freshDir(label) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `farm-bootstrap-${label}-`));
    tempDirs.add(dir);
    return dir;
}

function readJson(dir, name) {
    return JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
}

// ─── 管理员初始化 ───

test('全新数据目录：宿主环境变量初始化管理员，登录不需要卡密', () => {
    const dir = freshDir('admin-init');
    const store = loadStore(dir, {
        FARM_ADMIN_USERNAME: 'hostadmin',
        FARM_ADMIN_PASSWORD: 'Str0ngPass!01',
    });

    const users = readJson(dir, 'users.json').users;
    assert.equal(users.length, 1);
    assert.equal(users[0].role, 'admin');
    assert.equal(users[0].username, 'hostadmin');
    assert.ok(!('password' in users[0] && users[0].password.length < 60), '密码必须存哈希而非明文');

    const login = store.validateUser('hostadmin', 'Str0ngPass!01', '127.0.0.11');
    assert.equal(login.error, undefined);
    assert.equal(login.role, 'admin');
    assert.equal(login.cardCode, null, '管理员登录不需要卡密');
    assert.equal(store.getUserCount(), 1);
});

test('无环境变量：不创建任何管理员，登录被拒绝（无默认口令）', () => {
    const dir = freshDir('admin-none');
    const store = loadStore(dir);

    assert.equal(store.getUserCount(), 0);
    assert.equal(readJson(dir, 'users.json').users.length, 0);
    const login = store.validateUser('admin', 'admin', '127.0.0.12');
    assert.equal(login.error, 'invalid_credentials');
});

test('非法环境（弱密码/非法用户名）：拒绝创建管理员', () => {
    for (const [name, patch] of [
        ['weak-password', { FARM_ADMIN_USERNAME: 'bootadmin', FARM_ADMIN_PASSWORD: '123456' }],
        ['bad-username', { FARM_ADMIN_USERNAME: 'boot admin!', FARM_ADMIN_PASSWORD: 'Str0ngPass!02' }],
    ]) {
        const dir = freshDir(`admin-${name}`);
        const store = loadStore(dir, patch);
        assert.equal(store.getUserCount(), 0, `${name} 不得创建管理员`);
        assert.equal(store.validateUser(patch.FARM_ADMIN_USERNAME, patch.FARM_ADMIN_PASSWORD, '127.0.0.13').error, 'invalid_credentials');
    }
});

test('已有管理员不被不同环境覆盖：重载后原管理员仍可登录，新环境用户不存在', () => {
    const dir = freshDir('admin-keep');
    loadStore(dir, { FARM_ADMIN_USERNAME: 'firstadmin', FARM_ADMIN_PASSWORD: 'Str0ngPass!03' });

    const reloaded = loadStore(dir, { FARM_ADMIN_USERNAME: 'secondadmin', FARM_ADMIN_PASSWORD: 'OtherPass!04' });
    assert.equal(reloaded.getUserCount(), 1, '不得新增或覆盖管理员');
    assert.equal(reloaded.validateUser('firstadmin', 'Str0ngPass!03', '127.0.0.14').role, 'admin');
    assert.equal(reloaded.validateUser('secondadmin', 'OtherPass!04', '127.0.0.15').error, 'invalid_credentials');
});

// ─── 卡密领取配置默认值 ───

test('全新数据目录：免费领取默认关闭并落盘 enabled=false', () => {
    const dir = freshDir('claim-fresh');
    const store = loadStore(dir);

    assert.equal(store.getCardClaimStatus().enabled, false);
    assert.equal(readJson(dir, 'card-claim.json').enabled, false);
});

test('显式配置保持不变：enabled=true / enabled=false 重载后均不翻转', () => {
    const dir = freshDir('claim-explicit');
    loadStore(dir).setCardClaimStatus(true);
    assert.equal(loadStore(dir).getCardClaimStatus().enabled, true);

    const dir2 = freshDir('claim-explicit-off');
    loadStore(dir2).setCardClaimStatus(false);
    assert.equal(loadStore(dir2).getCardClaimStatus().enabled, false);
});

test('历史 enabled=true 文件重载后保持开启且领取记录不丢', () => {
    const dir = freshDir('claim-legacy');
    fs.writeFileSync(path.join(dir, 'card-claim.json'), JSON.stringify({
        enabled: true,
        records: [{ uaHash: 'legacy-hash', claimTime: Date.now(), cardCode: 'LEGACYCODE00000A' }],
    }));
    const store = loadStore(dir);
    assert.equal(store.getCardClaimStatus().enabled, true);
    assert.equal(store.getCardClaimRecords().length, 1);
});

test('card-claim.json 不可读（损坏 JSON）时按关闭处理', () => {
    const dir = freshDir('claim-corrupt');
    fs.writeFileSync(path.join(dir, 'card-claim.json'), '{ not valid json');
    assert.equal(loadStore(dir).getCardClaimStatus().enabled, false);
});

// ─── 库存口径与领取流程 ───

test('库存只统计未使用且启用的时间卡密（排除额度卡/禁用卡/已用卡）', () => {
    const dir = freshDir('stock-scope');
    const store = loadStore(dir);

    const available = store.createCard('可用时间卡', 3, 'time');
    const used = store.createCard('将被使用', 3, 'time');
    const disabled = store.createCard('已禁用', 3, 'time');
    store.createCard('额度卡', 5, 'quota');
    store.updateCard(disabled.code, { enabled: false });
    assert.equal(store.getAvailableTimeCardCount(), 2, '额度卡与禁用卡不计入库存');

    assert.equal(store.registerUser('fixtureuser1', 'Str0ngPass!05', used.code).ok, true);
    assert.equal(store.getAvailableTimeCardCount(), 1, '已用卡不重复计数');
    assert.equal(store.registerUser('fixtureuser1x', 'Str0ngPass!05', available.code).ok, true);
    assert.equal(store.getAvailableTimeCardCount(), 0, '注册消耗时间卡库存');
});

test('管理员建时间卡并开启领取后：领取成功、注册可用、库存清零后报不足', () => {
    const dir = freshDir('claim-flow');
    const store = loadStore(dir);
    const card = store.createCard('免费注册卡', 7, 'time');
    assert.equal(store.getCardClaimStatus().enabled, false, '未开启时不得领取');
    assert.equal(store.claimCardByUA('fixture-ua-1').ok, false);

    store.setCardClaimStatus(true);
    const claim = store.claimCardByUA('fixture-ua-1');
    assert.equal(claim.ok, true);
    assert.equal(claim.cardCode, card.code);

    const again = store.claimCardByUA('fixture-ua-1');
    assert.equal(again.ok, false, '同一 UA 24 小时内只发一张');
    assert.match(again.error, /24小时/);

    const reg = store.registerUser('fixtureuser2', 'Str0ngPass!06', claim.cardCode);
    assert.equal(reg.ok, true, '领取的卡密必须能完成注册');
    assert.equal(store.getAvailableTimeCardCount(), 0);

    const empty = store.claimCardByUA('fixture-ua-2');
    assert.equal(empty.ok, false);
    assert.match(empty.error, /库存不足/);
});

// ─── docker compose 转发（有 docker compose CLI 才跑，无需 daemon）───

function composeAvailable() {
    try {
        execFileSync('docker', ['compose', 'version'], { stdio: 'ignore' });
        return true;
    } catch {
        return false;
    }
}

test('compose 转发管理员初始化变量，未设置时为空值且不阻塞启动', { skip: !composeAvailable() }, () => {
    const composeFile = path.join(ROOT, 'docker-compose.yml');
    const isolatedEnvFile = path.join(freshDir('compose-config'), '.env');
    fs.writeFileSync(isolatedEnvFile, '');
    const composeArgs = ['compose', '--env-file', isolatedEnvFile, '-f', composeFile, 'config'];
    const baseEnv = { PATH: process.env.PATH, HOME: process.env.HOME };

    const forwarded = execFileSync('docker', composeArgs, {
        env: { ...baseEnv, FARM_ADMIN_USERNAME: 'synthetic-bootstrap-admin', FARM_ADMIN_PASSWORD: 'synthetic-bootstrap-pass' },
    }).toString();
    assert.match(forwarded, /FARM_ADMIN_USERNAME: synthetic-bootstrap-admin/);
    assert.match(forwarded, /FARM_ADMIN_PASSWORD: synthetic-bootstrap-pass/);

    const unset = execFileSync('docker', composeArgs, { env: baseEnv }).toString();
    assert.match(unset, /FARM_ADMIN_USERNAME: ""/);
    assert.match(unset, /FARM_ADMIN_PASSWORD: ""/);
});
