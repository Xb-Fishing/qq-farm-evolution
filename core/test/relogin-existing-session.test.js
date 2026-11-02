const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'relogin-existing-session-'));
process.env.FARM_DATA_DIR = root;
process.env.FARM_PRIVATE_CONFIG_FILE = path.join(root, 'private-config.json');
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
const { createDataProvider } = require('../src/runtime/data-provider');

function fixture(adopt, options = {}) {
  const account = { id: 'synthetic-session', platform: 'wx', autoLogin: true, credentialGeneration: 'synthetic-current', sessionGeneration: 'synthetic-binding', refreshtoken: 'synthetic-fixture-only' };
  let refreshes = 0; let adoptions = 0; let lastOptions;
  const proc = { persistentSession: true, businessInitialized: true, businessFaultEpoch: options.fault || '' };
  const workers = { [account.id]: { process: proc } };
  const provider = createDataProvider({ workers,
    getAccounts: () => ({ accounts: [account] }), store: {}, needsWxRescan: () => options.needScan === true,
    refreshAccountCode: async () => { refreshes++; return options.refreshOk !== false; },
    tryAdoptAccountSession: async (actual, settings) => { adoptions++; assert.equal(actual, account); lastOptions = settings;
      const result = await adopt(account, settings); proc.sessionFacts = result?.facts; return result; } });
  const routes = new Map(); const filename = path.resolve(__dirname, '../src/controllers/admin-account-runtime-routes.js');
  const native = createRequire(filename); const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module, exports: module.exports,
    require: name => name === '../models/store' ? { getAccounts: () => ({ accounts: [account] }) } : native(name) }, { filename });
  module.exports.registerAdminAccountRuntimeRoutes({ app: { post: (url, fn) => routes.set(url, fn) }, provider,
    resolveAccountReference: id => id, canAccessAccount: () => options.denied !== true });
  async function invoke() {
    const response = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
    await routes.get('/api/accounts/:id/relogin')({ params: { id: account.id } }, response);
    return response;
  }
  return { invoke, account, workers, provider, counts: () => ({ refreshes, adoptions }), settings: () => lastOptions };
}
const online = (ready = true) => ({ state: 'adopted', facts: {
  host: { hostId: 'synthetic-host', pid: 4123, starttime: '1234' },
  game: { connected: true, terminal: false, connectionEpoch: 7, loginEpoch: 1 },
  business: { ready, epoch: 'synthetic-business', commit: 'synthetic-commit', sourceFingerprint: 'synthetic-source' } } });

test('actual relogin route/provider adopts a verified existing session without refreshing credentials', async () => {
  const f = fixture(() => online()); const r = await f.invoke();
  assert.equal(r.statusCode, 200); assert.equal(r.body.mode, 'existing_connection'); assert.equal(r.body.businessReady, true);
  assert.deepEqual(f.counts(), { refreshes: 0, adoptions: 1 }); assert.equal(f.settings().connectedOnly, true); assert.equal(f.settings().isCurrent(), true);
});
test('unhealthy, unknown, disabled and cancelled sessions never fall through to credentials or QR', async () => {
  for (const state of ['unhealthy', 'unknown', 'disabled', 'cancelled']) {
    const f = fixture(() => ({ state, facts: { game: { connected: true } } })); const r = await f.invoke();
    assert.equal(r.statusCode, 409); assert.equal(r.body.ok, false); assert.equal(r.body.needScan, false); assert.equal(r.body.recoveryPending, true);
    assert.equal(f.counts().refreshes, 0);
  }
});
test('missing connection recovery wiring cannot authorize credential refresh', async () => {
  const f = fixture(() => online()); delete f.provider.recoverAccountConnection;
  const r = await f.invoke(); assert.equal(r.statusCode, 409); assert.equal(r.body.needScan, false); assert.equal(f.counts().refreshes, 0);
});
test('readiness flags, a known local fault and thrown status cannot manufacture online recovery success', async () => {
  for (const [adopt, options] of [[() => online(false), {}], [() => online(), { fault: 'synthetic-business' }],
    [() => { throw new Error('synthetic unavailable'); }, {}], [() => ({ ...online(), facts: { game: { connected: 'true' }, business: { ready: true } } }), {}]]) {
    const f = fixture(adopt, options); const r = await f.invoke(); assert.equal(r.statusCode, 409); assert.equal(f.counts().refreshes, 0); assert.equal(r.body.needScan, false);
  }
});
test('confirmed offline permits one normal login attempt and an explicit credential failure requests QR', async () => {
  for (const state of ['absent', 'offline']) {
    const f = fixture(() => ({ state })); const r = await f.invoke(); assert.equal(r.statusCode, 200); assert.equal(r.body.ok, true); assert.equal(f.counts().refreshes, 1);
  }
  const failed = fixture(() => ({ state: 'offline' }), { refreshOk: false, needScan: true }); const r = await failed.invoke();
  assert.equal(r.statusCode, 409); assert.equal(r.body.needScan, true); assert.equal(failed.counts().refreshes, 1);
});
test('authorization rejection and rebinding during adoption cannot start login or report an old success', async () => {
  const denied = fixture(() => online(), { denied: true }); assert.equal((await denied.invoke()).statusCode, 403); assert.equal(denied.counts().adoptions, 0);
  for (const field of ['username', 'ownerId', 'userId', 'wxid', 'platform', 'sessionGeneration', 'credentialGeneration', 'autoLogin', 'uin', 'openId']) {
    const changed = fixture(account => { account[field] = field === 'autoLogin' ? false : 'synthetic-new'; return online(); });
    const r = await changed.invoke(); assert.equal(r.statusCode, 409, field); assert.equal(r.body.ok, false); assert.equal(changed.counts().refreshes, 0);
    assert.equal(changed.settings().isCurrent(), false, field);
  }
});

test('late success from a replaced or stopped proxy cannot mask a newer fault; natural sequence advances remain valid', async () => {
  for (const kind of ['new-fault', 'missing-record', 'stopping', 'uninitialized', 'host', 'connection', 'login', 'business']) {
    const old = online();
    const f = fixture(() => {
      if (kind === 'missing-record') delete f.workers[f.account.id];
      else if (kind === 'stopping') f.workers[f.account.id].stopping = true;
      else {
        const live = structuredClone(old.facts);
        if (kind === 'new-fault') { live.business.ready = false; live.business.epoch = 'synthetic-new-epoch'; }
        if (kind === 'host') live.host.hostId = 'synthetic-new-host';
        if (kind === 'connection') live.game.connectionEpoch++;
        if (kind === 'login') live.game.loginEpoch++;
        if (kind === 'business') live.business.epoch = 'synthetic-new-epoch';
        f.workers[f.account.id] = { process: { persistentSession: true, businessInitialized: kind !== 'uninitialized', sessionFacts: live,
          businessFaultEpoch: kind === 'new-fault' ? live.business.epoch : '' } };
      }
      return old;
    });
    const r = await f.invoke(); assert.equal(r.statusCode, 409, kind); assert.equal(r.body.ok, false); assert.equal(r.body.needScan, false); assert.equal(f.counts().refreshes, 0);
  }
  const old = online();
  const current = fixture(() => { current.workers[current.account.id] = { process: { persistentSession: true, businessInitialized: true,
    sessionFacts: { ...structuredClone(old.facts), sequence: 99, observedAt: 123456 } } }; return old; });
  assert.equal((await current.invoke()).body.ok, true);
});
