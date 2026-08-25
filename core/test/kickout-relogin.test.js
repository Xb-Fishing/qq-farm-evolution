const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-farm-kickout-relogin-'));
process.env.FARM_DATA_DIR = dataDir;

const store = require('../src/models/store');
const { createAutoCodeRefreshService } = require('../src/runtime/auto-code-refresh');

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
