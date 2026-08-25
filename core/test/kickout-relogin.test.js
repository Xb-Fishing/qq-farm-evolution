const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-farm-kickout-relogin-'));
process.env.FARM_DATA_DIR = dataDir;

const store = require('../src/models/store');
const { createAutoCodeRefreshService } = require('../src/runtime/auto-code-refresh');
const { getSchedulerRegistrySnapshot } = require('../src/services/scheduler');

test.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

function createService() {
    return createAutoCodeRefreshService({
        store,
        getAccounts: () => ({ accounts: [] }),
        addOrUpdateAccount: () => {},
        resolveWorkerControls: () => ({}),
        log: () => {},
        addAccountLog: () => {},
    });
}

const NOW = Date.parse('2026-08-23T12:00:00');

test('empty config falls back to the escalating backoff', () => {
    const svc = createService();
    assert.equal(svc.isKickoutOverrideActive(null, NOW), false);
    assert.equal(svc.isKickoutOverrideActive({ delayMinutes: 0, validUntil: '' }, NOW), false);
    assert.equal(svc.resolveKickoutDelayMs(null, 0, NOW), 5 * 60000);
    assert.equal(svc.resolveKickoutDelayMs({ delayMinutes: 0 }, 1, NOW), 30 * 60000);
    assert.equal(svc.resolveKickoutDelayMs(null, 9, NOW), 3 * 60 * 60000);
});

test('custom delay wins while within its validity window', () => {
    const svc = createService();
    const cfg = { delayMinutes: 10, validUntil: '2026-08-23T13:00' };
    assert.equal(svc.isKickoutOverrideActive(cfg, NOW), true);
    assert.equal(svc.resolveKickoutDelayMs(cfg, 3, NOW), 10 * 60000);
});

test('empty validUntil keeps the custom delay active until cleared', () => {
    const svc = createService();
    const cfg = { delayMinutes: 45, validUntil: '' };
    assert.equal(svc.isKickoutOverrideActive(cfg, NOW), true);
    assert.equal(svc.resolveKickoutDelayMs(cfg, 0, NOW), 45 * 60000);
});

test('expired validity falls back to the default backoff', () => {
    const svc = createService();
    const cfg = { delayMinutes: 10, validUntil: '2026-08-23T11:00' };
    assert.equal(svc.isKickoutOverrideActive(cfg, NOW), false);
    assert.equal(svc.resolveKickoutDelayMs(cfg, 1, NOW), 30 * 60000);
    assert.equal(svc.resolveKickoutDelayMs({ delayMinutes: 10, validUntil: 'garbage' }, 0, NOW), 5 * 60000);
});

test('store persists and clamps the kickoutRelogin setting', () => {
    const account = store.addOrUpdateAccount({ username: 'kick_user', name: 'Kick farm' }).accounts.at(-1);
    const saved = store.applyConfigSnapshot(
        { kickoutRelogin: { delayMinutes: 99999, validUntil: ' 2026-08-23T18:00 ' } },
        { accountId: account.id }
    );
    assert.deepEqual(saved.kickoutRelogin, { delayMinutes: 4320, validUntil: '2026-08-23T18:00' });
    assert.deepEqual(store.getKickoutRelogin(account.id), { delayMinutes: 4320, validUntil: '2026-08-23T18:00' });

    store.applyConfigSnapshot({ kickoutRelogin: { delayMinutes: 0 } }, { accountId: account.id });
    assert.deepEqual(store.getKickoutRelogin(account.id), { delayMinutes: 0, validUntil: '2026-08-23T18:00' });
});

test('被踢等待接管期间继续滚动长凭据但不提前申请 Code 或启动 Worker', async () => {
    const account = {
        id: 'offline-credential-test',
        name: 'Offline credential fixture',
        wxid: 'wx-fixture',
        loginBuffer: 'login-buffer-fixture',
        refreshtoken: 'refresh-token-fixture',
    };
    let keepaliveCalls = 0;
    let restartCalls = 0;
    let accountWrites = 0;
    const svc = createAutoCodeRefreshService({
        store: {
            getKickoutRelogin: () => ({ delayMinutes: 0, validUntil: '' }),
            isAccountAutoLogin: () => true,
        },
        getAccounts: () => ({ accounts: [account] }),
        addOrUpdateAccount: () => { accountWrites += 1; },
        resolveWorkerControls: () => ({ restartWorker: () => { restartCalls += 1; } }),
        keepWxCredentialAlive: async () => {
            keepaliveCalls += 1;
            return { Success: true };
        },
        getCredentialKeepaliveDelayMs: () => 5,
        log: () => {},
        addAccountLog: () => {},
    });

    try {
        assert.equal(svc.scheduleKickoutRelogin(account.id, 'kickout:test'), true);
        const scheduled = getSchedulerRegistrySnapshot('auto_code_refresh')
            .schedulers.flatMap(item => item.tasks.map(task => task.name));
        assert.ok(scheduled.includes(`relogin_${account.id}`));
        assert.ok(scheduled.includes(`wx_keepalive_${account.id}`));

        await new Promise(resolve => setTimeout(resolve, 30));
        assert.ok(keepaliveCalls >= 1);
        assert.equal(accountWrites, 0);
        assert.equal(restartCalls, 0);
    } finally {
        svc.stopAccount(account.id);
    }

    const remaining = getSchedulerRegistrySnapshot('auto_code_refresh')
        .schedulers.flatMap(item => item.tasks.map(task => task.name));
    assert.ok(!remaining.includes(`relogin_${account.id}`));
    assert.ok(!remaining.includes(`wx_keepalive_${account.id}`));
});

test('保活临时失败使用受控短重试，不等下一个常规到期窗口', async () => {
    const account = {
        id: 'credential-retry-test',
        name: 'Credential retry fixture',
        wxid: 'wx-retry-fixture',
        loginBuffer: 'login-buffer-fixture',
        refreshtoken: 'refresh-token-fixture',
        wxCredentialExpiresAt: Date.now() + 60 * 60000,
    };
    const reasons = [];
    let calls = 0;
    const svc = createAutoCodeRefreshService({
        store: { isAccountAutoLogin: () => true },
        getAccounts: () => ({ accounts: [account] }),
        addOrUpdateAccount: () => {},
        resolveWorkerControls: () => ({}),
        keepWxCredentialAlive: async () => {
            calls += 1;
            return calls === 1
                ? { Success: false, Message: 'temporary fixture', definitive: false }
                : { Success: true };
        },
        getCredentialKeepaliveDelayMs: (_account, options) => {
            reasons.push(options.reason);
            return 5;
        },
        log: () => {},
        addAccountLog: () => {},
    });

    try {
        svc.scheduleAccount(account.id);
        await new Promise(resolve => setTimeout(resolve, 30));
        assert.ok(calls >= 2);
        assert.equal(reasons[0], 'normal');
        assert.equal(reasons[1], 'retry');
    } finally {
        svc.stopAccount(account.id);
    }
});

test('新扫码账号保存凭据有效期，供重启后继续按期续期', () => {
    const account = store.addOrUpdateAccount({
        username: 'credential_lifetime_user',
        name: 'Credential lifetime fixture',
        platform: 'wx',
        wxid: 'wx-lifetime-fixture',
        loginBuffer: 'buffer',
        refreshtoken: 'refresh',
        accesstoken: 'a',
        wxCredentialExpiresAt: 123456789,
        wxCredentialExpiresIn: 7200,
        wxRefreshTokenObservedAt: 123450000,
        wxCredentialLastSuccessAt: 123450001,
    }).accounts.at(-1);
    assert.equal(account.wxCredentialExpiresAt, 123456789);
    assert.equal(account.wxCredentialExpiresIn, 7200);
    assert.equal(account.wxRefreshTokenObservedAt, 123450000);
    assert.equal(account.wxCredentialLastSuccessAt, 123450001);
});
