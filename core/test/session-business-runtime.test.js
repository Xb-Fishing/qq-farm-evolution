const test = require('node:test'); const assert = require('node:assert/strict');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const prefix = path.resolve(os.tmpdir(), 'session-real-business-test-');
assert.equal(path.dirname(prefix), path.resolve(os.tmpdir()));
const temporary = fs.mkdtempSync(prefix); process.env.FARM_DATA_DIR = temporary;
test.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
const { createSessionHostCore } = require('../src/runtime/session-host-core');
const { createSessionBusinessRuntime } = require('../src/runtime/session-business-runtime');
const { encode, decode } = require('../src/runtime/session-codec');
const runtimeRoot = path.resolve(__dirname, '../..');

test('real business Workers capture all state domains and retain the physical session during replacement', { timeout: 30000 }, async () => {
  let connectCount = 0; let revision = 0; let eventCallback;
  const messages = []; const game = {
    snapshot: () => ({ connectionEpoch: connectCount, connected: connectCount > 0, configRevision: revision,
      socketPresent: connectCount > 0, readyState: connectCount ? 1 : 3, userState: {}, status: {},
      clock: { serverTimeMs: 0, localTimeAtSync: 0 } }),
    syncConfig: value => ({ ...value, __revision: ++revision }),
    command: method => { if (method === 'network.connect') connectCount++; },
    query: method => method === 'idle.getIdleProtectionUntil' ? 0 : {},
    request: () => { throw new Error('No login event was sent; gameplay must not run'); },
    onEvent: callback => { eventCallback = callback; }, stop: () => {},
  };
  const core = createSessionHostCore({ identity: { hostId: 'synthetic-host', accountId: 'synthetic-account' }, game,
    createBusiness: createSessionBusinessRuntime, validateTarget: async target => target });
  core.events.on('master', envelope => messages.push(envelope.message));
  const target = commit => ({ runtimeRoot, commit, sourceFingerprint: commit });
  try {
    await core.attach(target('first'), { code: 'synthetic-code', platform: 'wx' });
    assert.equal(connectCount, 1); assert.equal(core.facts().business.ready, true);
    await core.attach(target('second'), { code: 'synthetic-code', platform: 'wx' });
    assert.equal(connectCount, 1, 'warm replacement must not connect or login again');
    assert.equal(core.facts().business.commit, 'second'); assert.equal(core.facts().business.ready, true);
    assert.equal(messages.some(message => message.type === 'error'), false, JSON.stringify(messages));
    assert.equal(typeof eventCallback, 'function');
  } finally { await core.revoke(); }
});

test('codec refuses an incomplete checkpoint rather than silently cold-starting business', { timeout: 30000 }, async () => {
  const facts = { sequence: 1, host: { accountId: 'synthetic-account' }, game: { connectionEpoch: 1, userState: {}, status: {},
    clock: { serverTimeMs: 0, localTimeAtSync: 0 } } };
  let connects = 0;
  const runtime = await createSessionBusinessRuntime({ target: { runtimeRoot }, epoch: 'synthetic-epoch', facts,
    config: {}, checkpoint: Buffer.from('not-a-checkpoint'), read: () => facts,
    command: () => { connects++; }, query: () => ({ facts, value: 0 }), request: () => {}, onMaster: () => {} });
  try { await assert.rejects(runtime.prepare()); assert.equal(connects, 0); }
  finally { await runtime.terminate(); }
  assert.throws(() => decode(Buffer.from('not-a-checkpoint')));
});

test('all real gameplay domains, pending payloads and absolute timers survive a warm restore without startup actions', { timeout: 30000 }, async () => {
  let sequence = 1; const commands = []; let checkpoint;
  const facts = () => ({ sequence: sequence++, host: { accountId: 'synthetic-account' }, game: {
    platform: 'wx', connectionEpoch: 1, connected: true, readyState: 1, socketPresent: true,
    userState: {}, status: {}, clock: { serverTimeMs: 0, localTimeAtSync: 0 } } });
  const options = { target: { runtimeRoot }, epoch: 'synthetic-capsule-first', facts: facts(),
    config: { platform: 'wx', __revision: 1 }, read: facts,
    command: method => { commands.push(method); return { value: undefined, facts: facts() }; },
    query: () => ({ value: 0, facts: facts() }),
    request: () => { throw new Error('No economic operation is allowed during restore'); }, onMaster: () => {} };
  const cold = await createSessionBusinessRuntime(options);
  try {
    await cold.prepare(); await cold.activate([]); checkpoint = decode(await cold.quiesce());
  } finally { await cold.terminate(); }
  assert.equal(Object.keys(checkpoint.state.domains).length, 32);
  const domain = name => checkpoint.state.domains[name].value;
  const deadline = Date.now() + 600000;
  Object.assign(domain('services/planting-service.js'), { reserved2x2GroupKeys: ['1,2,3,4'],
    waiting2x2Deadlines: new Map([['1,2,3,4', deadline]]), failed2x2Retries: new Map([['1,2,3,4', { attempts: 2, retryAt: deadline }]]) });
  Object.assign(domain('services/friend-operation-limits.js'), { localBadOperationCount: 17, canGetHelpExp: false,
    operationLimits: new Map([[5, { remaining: 2 }]]) });
  Object.assign(domain('services/friend-auto-bad-quota.js'), { loadedAccounts: new Map([
    ['synthetic-account', { dayKey: '2099-01-01', reason: 'quota', resumeAt: deadline }]]) });
  Object.assign(domain('services/friend-self-echo.js'), { generation: 7, ticketSeq: 19, echoAbsorbedTotal: 4,
    tickets: new Map([['synthetic-ticket', { generation: 7, expiresAt: deadline }]]) });
  Object.assign(domain('services/fertilizer-watch.js'), { watches: new Map([[42, { dueAt: deadline, evidence: 'synthetic' }]]), priorityGids: new Set([42]) });
  Object.assign(domain('services/milk-tea-activity.js'), { endedEvidence: { endTime: deadline,
    overview: { timing: { phase: 'ended' }, status: 'complete' } } });
  Object.assign(domain('services/daily-routine-state.js'), { stateByAccount: new Map([
    ['synthetic-account', { date: '2099-01-01', done: { email_rewards: true, daily_share: true } }]]) });
  Object.assign(domain('services/official-announcements.js'), { cached: { announcements: [{ title: 'synthetic', publishedAt: deadline }] },
    cachedUntil: deadline, failedUntil: deadline - 1000, lastError: new Error('synthetic cached failure') });
  Object.assign(domain('services/task.js'), { pendingTaskClaim: { hasClaimable: true, claimable: [{ id: 11 }], actives: [{ id: 22 }] } });
  Object.assign(domain('core/worker.js'), { nextFarmRunAt: deadline, nextHelpRunAt: deadline + 100,
    nextStealRunAt: deadline + 200, lastDailyRunDate: '2099-01-01', ownHarvestArmedFor: deadline,
    ownHarvestRetryAttempt: 3, sentinelArmedFor: { kind: 'friend', gid: 42, dueAt: deadline },
    sentinelPendingPreEnter: { stage: 'enter', gid: 42, dueAt: deadline, id: 9 }, sentinelEntrySeq: 9 });
  const workerTimers = checkpoint.timers.namespaces.find(scope => scope.name === 'worker');
  assert.ok(workerTimers);
  const savedTimer = { name: 'sentinel_pre_enter', kind: 'timeout', delayMs: 3000, createdAt: deadline - 3000,
    nextRunAt: deadline, lastRunAt: 0, runCount: 0, running: false, preventOverlap: true, immediatePending: false, ordinal: 99 };
  workerTimers.timers.push(savedTimer);
  const warmed = await createSessionBusinessRuntime({ ...options, epoch: 'synthetic-capsule-next', facts: facts(),
    checkpoint: encode(checkpoint), config: { ...checkpoint.config, platform: 'wx' } });
  const before = commands.length;
  try {
    await warmed.prepare(); await warmed.activate([]);
    const restored = decode(await warmed.quiesce());
    assert.deepEqual(encode(restored.state), encode(checkpoint.state), 'all transferable state, including whitelisted error fields, survives exactly');
    assert.deepEqual(restored.timers, checkpoint.timers, 'original absolute deadlines and pending payload tasks are retained');
    assert.equal(commands.length, before, 'warm activation does not connect, reset stats, change idle protection or claim startup gifts');
  } finally { await warmed.terminate(); }
});

test('warm restore clears old readiness when a newer socket is OPEN but has not logged in', { timeout: 30000 }, async () => {
  let sequence = 1; let epoch = 1; let connected = true; const commands = []; let requests = 0; let checkpoint;
  const facts = () => ({ sequence: sequence++, host: { accountId: 'synthetic-readiness' }, game: {
    platform: 'wx', connectionEpoch: epoch, connected, socketPresent: true, readyState: 1,
    userState: {}, status: {}, clock: { serverTimeMs: 0, localTimeAtSync: 0 } } });
  const options = { target: { runtimeRoot }, epoch: 'synthetic-before-reconnect', facts: facts(),
    config: { platform: 'wx', __revision: 1 }, read: facts,
    command: method => { commands.push(method); return { value: undefined, facts: facts() }; },
    query: () => ({ value: 0, facts: facts() }), request: () => { requests++; throw new Error('login is incomplete'); }, onMaster: () => {} };
  const cold = await createSessionBusinessRuntime(options);
  try { await cold.prepare(); await cold.activate([]); checkpoint = decode(await cold.quiesce()); }
  finally { await cold.terminate(); }
  const worker = checkpoint.state.domains['core/worker.js'].value;
  worker.isRunning = true; worker.loginReady = true;
  const oldDisconnect = { name: 'disconnect', args: encode([]), facts: facts() };
  epoch = 2; connected = false;
  const before = commands.length;
  const warmed = await createSessionBusinessRuntime({ ...options, epoch: 'synthetic-after-reconnect', facts: facts(),
    checkpoint: encode(checkpoint), config: { ...checkpoint.config, platform: 'wx' } });
  try {
    await warmed.prepare(); await warmed.activate([oldDisconnect]);
    const next = decode(await warmed.quiesce()).state.domains['core/worker.js'].value;
    assert.equal(next.loginReady, false); assert.equal(next.isRunning, true);
    assert.equal(requests, 0); assert.equal(commands.length, before);
  } finally { await warmed.terminate(); }
});
