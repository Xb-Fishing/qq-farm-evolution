'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { fixture, fixturePath, proto } = require('./milk-tea-autonomy-baseline.test');
const policy = require('../src/services/milk-tea-auto-policy');
const seedFlags = { milk_tea_auto_seeds: true };
async function using(flags, run) { const f = await fixture(flags); try { await run(f); } finally { f.close(); } }
const journal = f => JSON.parse(fs.readFileSync(f.journal(), 'utf8'));
const patchPolicy = (f, patch) => f.setFlags({ milk_tea_seed_policy: { ...f.auto.milk_tea_seed_policy, ...patch } });

// Reuse only the fixture prefix: complete production network/governor source,
// synthetic socket/clock/collaborators, and none of that file's test cases.
function networkHarness() {
  const path = require('node:path'); const Module = require('node:module');
  const filename = path.resolve(__dirname, 'network-request-lifecycle.test.js');
  const source = fs.readFileSync(filename, 'utf8');
  const boundary = source.indexOf("\nconst service = 'gamepb.userpb.UserService';");
  assert.ok(boundary > 0, 'reviewed network fixture boundary');
  const fixtureModule = new Module(filename, module);
  fixtureModule.filename = filename; fixtureModule.paths = Module._nodeModulePaths(__dirname);
  fixtureModule._compile(source.slice(0, boundary) + '\nmodule.exports = { createHarness, baseNow };', filename);
  return fixtureModule.exports;
}
async function throughBridge(error) {
  const path = require('node:path'); const vm = require('node:vm');
  const { EventEmitter } = require('node:events'); const codec = require('../src/runtime/session-codec');
  const filename = path.resolve(__dirname, '../src/runtime/session-business-bridge.js');
  const module = { exports: {} }; const port = new EventEmitter(); const faults = [];
  const collaborators = {
    'node:events': { EventEmitter }, 'node:perf_hooks': require('node:perf_hooks'),
    // Only VM-created request envelopes need the host Object prototype. The
    // actual error/reply codec and bridge rejection path remain unchanged.
    './session-codec': { ...codec, encode: value => codec.encode({ ...value }) },
    './session-game-adapter': Object.fromEntries(['STATS_METHODS', 'STATUS_METHODS', 'GOVERNOR_METHODS', 'NETWORK_READ_METHODS'].map(key => [key, []])
      .concat(['STATS_READ_METHODS', 'GOVERNOR_READ_METHODS'].map(key => [key, new Set()]))),
    '../utils/utils': { restoreServerClockSnapshot() {} }, '../utils/idle-protection': {},
  };
  const localRequire = name => { assert.ok(Object.hasOwn(collaborators, name), name); return collaborators[name]; };
  localRequire.resolve = name => name; localRequire.cache = {};
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module, exports: module.exports, require: localRequire, Buffer, SharedArrayBuffer }, { filename });
  port.postMessage = message => {
    assert.equal(message.kind, 'business_request');
    queueMicrotask(() => port.emit('message', { kind: 'game_reply', id: message.id, body: codec.encode({ error }) }));
  };
  const bridge = module.exports.createSessionBusinessBridge({ port,
    gate: { operation: () => ({ connectionEpoch: 1 }), setAuthorityProvider() {} },
    initialFacts: { sequence: 1, game: { connectionEpoch: 1, userState: {}, status: {}, clock: {} } },
    onControlFailure: value => faults.push(value),
  });
  try {
    const received = await bridge.network.sendMsgAsync('synthetic.Business', 'Read', Buffer.from('{}')).catch(value => value);
    assert.equal(bridge.pending.size, 0); assert.equal(faults.length, 0);
    return received;
  } finally { port.removeAllListeners(); }
}
async function actualBudgetRejection(reason) {
  const { createHarness, baseNow } = networkHarness(); const h = createHarness('milk-unsent-recovery');
  try {
    const count = reason === 'budget_total' ? h.governor.TOTAL_LIMIT : h.governor.PER_METHOD_LIMIT;
    for (let i = 0; i < count; i++) h.governor.recordSent('gamepb.activitypb.ActivityService', 'Operate', true, baseNow);
    let error;
    try { await h.network.sendMsgAsync('gamepb.activitypb.ActivityService', 'Operate', Buffer.from('{}')); }
    catch (value) { error = Object.assign(new Error(value.message), value); }
    assert.equal(h.attempts.length, 0, 'governor rejection occurs before any physical socket send');
    const decoded = await throughBridge(error);
    assert.equal(decoded.isGovernedRejection, true); assert.equal(decoded.governedReason, reason);
    assert.equal(decoded.isLocalRequestRejection, undefined, 'not a transferable proof');
    return decoded;
  } finally { await h.stop(); }
}
const recoveryActions = [
  ['claimWages', 64, { milk_tea_auto_work: true }, {}],
  ['upgrade', 61, { milk_tea_auto_upgrade: true }, {}],
  ['interact', 65, { milk_tea_auto_work: true }, { interactionType: 1, shiftId: '7001' }],
  ['exchange', 1, seedFlags, { goodsId: 301, count: 24, confirmedCosts: [{ itemId: 1001, count: '240000' }] }],
];
function declaration(state, action) {
  return action === 'claimWages' ? state.wages : action === 'upgrade' ? state.upgrades
    : action === 'interact' ? state.interactions['7001'] : state.purchases['301'];
}
for (const reason of ['budget_total', 'budget_method']) for (const [action, cmd, flags] of recoveryActions) {
  test(`real ${reason} releases durable ${action}, reload recovers once without stale replay`, async () => using(flags, async f => {
    if (action === 'claimWages') { f.work.my_shift = null; f.work.slips = [{ shift_id: '7001' }]; }
    if (action === 'interact') f.summary.hasUnclaimedWage = false;
    const rejection = await actualBudgetRejection(reason);
    f.response(value => {
      if (value !== cmd) return;
      assert.ok(declaration(journal(f).actionState, action), 'declaration must already be durable before transport');
      throw rejection;
    });
    await f.service.runAutomaticMilkTea(f.deps);
    assert.equal(f.writes().filter(value => value === cmd).length, 1, 'automatic entry reaches the existing action');
    assert.equal(Boolean(declaration(journal(f).actionState, action)), false, 'proved unsent declaration is durably released');
    assert.deepEqual(journal(f).actionState.spend, {}, 'unsent purchase consumes no daily allowance');
    f.response(null); f.reload(); await f.tick();
    assert.equal(f.writes().filter(value => value === cmd).length, 2, 'one valid submission after normal wake and reload');
    assert.equal(declaration(journal(f).actionState, action).status, 'confirmed');
    if (action === 'exchange') assert.equal(journal(f).actionState.spend['2026-10-29']['1001'], '240000');
    await f.tick(); assert.equal(f.writes().filter(value => value === cmd).length, 2, 'unchanged fresh state cannot replay confirmed action');
  }));
}
test('manual actions share strict budget rejection recovery with automatic execution', async () => {
  const rejection = await actualBudgetRejection('budget_total');
  for (const [action, cmd, flags, input] of recoveryActions) await using(flags, async f => {
    if (action === 'claimWages') { f.work.my_shift = null; f.work.slips = [{ shift_id: '7001' }]; }
    if (action === 'interact') f.summary.hasUnclaimedWage = false;
    const deps = { ...f.deps, getBag: require('../src/services/warehouse').getBag, getBagItems: require('../src/services/warehouse').getBagItems };
    f.response(value => { if (value === cmd) throw rejection; });
    await assert.rejects(f.service.runManualMilkTeaAction(action, input, deps), error => error.isGovernedRejection === true);
    assert.equal(Boolean(declaration(journal(f).actionState, action)), false);
    f.response(null); f.reload(); await f.tick();
    assert.equal(f.writes().filter(value => value === cmd).length, 2);
  });
});
test('incomplete, conflicting and sent-failure evidence retains durable declarations across reload', async () => {
  const negatives = [
    { code: 'LOCAL_REQUEST_TIMEOUT' }, { code: 'LOCAL_CONNECTION_CHANGED' }, { code: 'SESSION_EPOCH_RETIRED' },
    { business: true }, { isLocalRequestRejection: true }, { governedReason: 'budget_total' },
    { isGovernedRejection: 'true', governedReason: 'budget_total' },
    { isGovernedRejection: true, governedReason: 'cooldown' }, { isGovernedRejection: true },
    { isGovernedRejection: true, governedReason: 'budget_total', isServerBusinessError: true },
    { isGovernedRejection: true, governedReason: 'budget_method', serverErrorCode: 7 },
    { isGovernedRejection: true, governedReason: 'budget_total', business: true },
    { isGovernedRejection: true, governedReason: 'budget_total', unknown: true },
    { isGovernedRejection: true, governedReason: 'budget_total', code: 'LOCAL_CONNECTION_CHANGED' },
  ];
  for (const fields of negatives) await using(seedFlags, async f => {
    f.response(cmd => { if (cmd === 1) throw Object.assign(new Error('synthetic failure'), fields); });
    await f.service.runAutomaticMilkTea(f.deps);
    assert.ok(declaration(journal(f).actionState, 'exchange'), JSON.stringify(fields));
    f.response(null); f.reload(); await f.tick(); assert.deepEqual(f.writes(), [1]);
    assert.deepEqual(journal(f).actionState.purchases['301'].spent, { 1001: '240000' });
  });
});
test('failed persistence of proved-unsent release keeps memory and disk reserved', async () => using(seedFlags, async f => {
  const rejection = await actualBudgetRejection('budget_method'); const rename = fs.renameSync;
  f.response(cmd => { if (cmd === 1) { fs.renameSync = () => { throw new Error('synthetic release persistence failure'); }; throw rejection; } });
  try { await f.service.runAutomaticMilkTea(f.deps); } finally { fs.renameSync = rename; }
  assert.ok(journal(f).actionState.purchases['301']);
  f.response(null); await f.tick(); assert.deepEqual(f.writes(), [1], 'memory was rolled back after failed release');
  f.reload(); await f.tick(); assert.deepEqual(f.writes(), [1], 'disk still owns the reservation');
}));
test('late success or unsent rejection cannot settle or release a different connection or account journal', async () => {
  const rejection = await actualBudgetRejection('budget_total');
  for (const mode of ['success', 'unsent']) for (const change of ['connection', 'account']) await using(seedFlags, async f => {
    const originalAccount = process.env.FARM_ACCOUNT_ID;
    const otherJournal = fixturePath('milk-tea-auto-synthetic-stale-account.json');
    let connected = true; const originalConnection = f.deps.getConnection;
    f.deps.getConnection = () => connected ? originalConnection() : null;
    f.response((cmd, reply) => {
      if (cmd !== 1) return reply;
      if (change === 'connection') connected = false;
      else process.env.FARM_ACCOUNT_ID = 'synthetic-stale-account';
      if (mode === 'unsent') throw rejection;
      return reply;
    });
    try {
      await f.service.runAutomaticMilkTea(f.deps);
      assert.equal(journal(f).actionState.purchases['301'].status, 'pending', `${mode}/${change}`);
      assert.deepEqual(journal(f).actionState.spend, {});
      assert.equal(fs.existsSync(otherJournal), false, 'no write may be redirected to another account');
    } finally { process.env.FARM_ACCOUNT_ID = originalAccount; }
  });
});
test('turning policy off during a confirmed purchase still settles its exact successful spend', async () => using(seedFlags, async f => {
  f.response((cmd, reply) => { if (cmd === 1) f.setFlags({ milk_tea_auto_seeds: false }); return reply; });
  await f.service.runAutomaticMilkTea(f.deps);
  assert.equal(journal(f).actionState.purchases['301'].status, 'confirmed');
  assert.equal(journal(f).actionState.spend['2026-10-29']['1001'], '240000');
  const before = f.calls.length; await f.tick(); assert.equal(f.calls.length, before);
}));

test('all switches off and paused/not-ready/yielding accounts perform zero reads', async () => {
  await using({}, async f => { await f.service.runAutomaticMilkTea(f.deps); assert.deepEqual(f.calls, []); });
  for (const deps of [{ isPaused: () => true }, { isReady: () => false }, { canRun: () => false }]) await using(seedFlags, async f => {
    await f.service.runAutomaticMilkTea({ ...f.deps, ...deps }); assert.deepEqual(f.calls, []);
  });
});
test('default warehouse Bag wire supplies stock and exact multi-currency duplicate costs; multi-seed portions are bounded', async () => {
  await using(seedFlags, async f => {
    f.goods.rewards[0].count = '5'; f.goods.costs = [{ id: 1001, count: '5000' }, { id: 1001, count: '5000' }, { id: 1041, count: '500' }];
    await f.service.runAutomaticMilkTea(f.deps); assert.deepEqual(f.writes(), [], 'ticket daily limit zero is respected');
    patchPolicy(f, { ticketDailyLimit: '2500' }); await f.tick();
    assert.deepEqual(f.writes(), [1]);
    assert.equal(Number(f.requests.find(row => Number(row.operate_type) === 1).shop_buy.count), 4);
    assert.ok(f.calls.includes('Bag'), 'uses actual warehouse getter rather than a test-only bag injection');
    const row = journal(f).actionState.spend['2026-10-29']; assert.deepEqual(row, { 1001: '40000', 1041: '2000' });
  });
});
for (const [name, mutate] of [
  ['no selected targets', f => patchPolicy(f, { targetSeedIds: [] })],
  ['explicit null policy', f => f.setFlags({ milk_tea_seed_policy: null })],
  ['invalid policy', f => f.setFlags({ milk_tea_seed_policy: { targetSeedIds: [20525], coinDailyLimit: 'oops' } })],
  ['unknown remaining limit', f => { delete f.goods.purchaseLimitKnown; }],
  ['unknown purchased count', f => { delete f.goods.purchasedCountKnown; }],
  ['incomplete decoded purchase data', f => { delete f.goods.automaticPurchaseDataComplete; }],
  ['unknown condition', f => { f.goods.condHints = [{}]; }],
  ['missing conditions', f => { delete f.goods.condHints; }],
  ['diamond cost', f => { f.goods.costs = [{ id: 1004, count: '1' }]; }],
  ['unknown cost', f => { f.goods.costs = [{ id: 999999, count: '1' }]; }],
  ['malformed cost', f => { f.goods.costs[0].count = '-1'; }],
  ['invalid stock', f => { f.bag.push({ id: 20525, count: '-1', uid: '3' }); }],
  ['zero budget', f => patchPolicy(f, { coinDailyLimit: '0' })],
  ['reserve consumes all balance', f => patchPolicy(f, { coinReserve: '2000000' })],
  ['stock target met', f => { f.bag.push({ id: 20525, count: '24', uid: '3' }); }],
]) test(`automatic purchase rejects ${name} with zero writes`, async () => using(seedFlags, async f => { mutate(f); await f.service.runAutomaticMilkTea(f.deps); assert.deepEqual(f.writes(), []); }));

for (const field of ['cost', 'item', 'cond_hints', 'complete']) test(`real rich DTO purchase completeness: ${field}`, async () => using(seedFlags, async f => {
  const raw = { id: 301, item: [{ id: 20525, count: '1' }], cost: [{ id: 1001, count: '10000' }], purchase_limit: '100', purchased_count: '0', cond_hints: [] };
  if (field === 'cost') raw.cost = [...Array.from({ length: 10 }, () => ({ id: 1001, count: '1000' })), { id: 1004, count: '1' }];
  if (field === 'item') raw.item = [...Array.from({ length: 10 }, () => ({ id: 20525, count: '1' })), { id: 20526, count: '1' }];
  if (field === 'cond_hints') raw.cond_hints = [...Array.from({ length: 12 }, () => ({ satisfied: true })), { satisfied: false }];
  const type = proto.types.MilkTeaGetGroupReply;
  const encoded = type.encode({ group: { head: { activity_id: 2026110100 }, children: [{ head: { activity_id: 2026110102 }, shop: { goods: [raw] } }] } }).finish();
  const dto = f.service.exchangeShopRichDto(type.decode(encoded).group.children[0]).items[0];
  assert.equal(dto.automaticPurchaseDataComplete, field === 'complete');
  Object.assign(f.goods, dto); await f.service.runAutomaticMilkTea(f.deps); assert.deepEqual(f.writes(), field === 'complete' ? [1] : []);
}));

test('fresh limit, stock, cost, reward and saved policy changes after planning stop the actual write', async () => {
  for (const change of ['price', 'reward', 'quantity', 'stock', 'reserve', 'off', 'limit']) await using(seedFlags, async f => {
    let reads = 0;
    f.hook(kind => {
      if (kind !== 'group' || ++reads !== 2) return;
      if (change === 'price') f.goods.costs[0].count = '20000';
      if (change === 'reward') f.goods.rewards[0].id = 20526;
      if (change === 'quantity') f.goods.rewards[0].count = '10';
      if (change === 'stock') f.bag.push({ id: 20525, count: '24', uid: '3' });
      if (change === 'reserve') patchPolicy(f, { coinReserve: '1999999' });
      if (change === 'off') f.setFlags({ milk_tea_auto_seeds: false });
      if (change === 'limit') f.goods.purchasedCount = 99;
    });
    await f.service.runAutomaticMilkTea(f.deps); assert.deepEqual(f.writes(), [], change);
  });
});
test('selected purchase reply must confirm exact item and quantity; unknown survives reload and day change', async () => {
  for (const mode of ['transport', 'wrong_item', 'wrong_count', 'empty']) await using(seedFlags, async f => {
    if (mode === 'transport') f.unknown(1);
    else f.response((cmd, reply) => cmd !== 1 ? reply : { ...reply, shop_buy: { awards: mode === 'empty' ? [] : [{ id: mode === 'wrong_item' ? 20526 : 20525, count: '1' }] } });
    await f.service.runAutomaticMilkTea(f.deps); assert.deepEqual(f.writes(), [1]);
    assert.equal(journal(f).actionState.purchases['301'].status, 'pending');
    f.reload(); f.clock.now += 3 * 86400000; await f.tick(); assert.deepEqual(f.writes(), [1]);
  });
});
test('manual unknown purchase blocks automatic replay across restart, target change and midnight, keeping all reservations', async () => using(seedFlags, async f => {
  f.unknown(1);
  const warehouse = require('../src/services/warehouse');
  const result = await f.service.runManualMilkTeaAction('exchange', { goodsId: 301, count: 20, confirmedCosts: [{ itemId: 1001, count: '200000' }] }, { ...f.deps, getBag: warehouse.getBag, getBagItems: warehouse.getBagItems });
  assert.equal(result.outcome, 'unknown');
  f.unknown(0); f.reload(); f.clock.now += 86400000;
  f.goods.id = 302; f.goods.rewards[0].id = 20526;
  patchPolicy(f, { targetSeedIds: [20526] });
  await f.tick(); assert.equal(f.writes().filter(cmd => cmd === 1).length, 2);
  const latest = f.requests.filter(req => Number(req.operate_type) === 1).at(-1);
  assert.equal(Number(latest.shop_buy.count), 4, 'old unknown consumes 200k of the new 240k daily budget');
  const state = journal(f).actionState; assert.ok(state.purchases['301']);
}));
test('fresh purchase count alone cannot reconcile a different reward; exact natural count progress does release it', async () => using(seedFlags, async f => {
  f.unknown(1); await f.service.runAutomaticMilkTea(f.deps); f.unknown(0);
  f.goods.purchasedCount = 24; f.goods.rewards[0].id = 20526;
  await f.tick(); assert.ok(journal(f).actionState.purchases['301']);
  f.goods.rewards[0].id = 20525; f.bag.push({ id: 20525, count: '24', uid: '3' }); await f.tick();
  assert.equal(journal(f).actionState.purchases['301'], undefined); assert.deepEqual(f.writes(), [1]);
}));
test('confirmed purchase is charged once and waits for fresh counters rather than a stale stock repeat', async () => using(seedFlags, async f => {
  await f.service.runAutomaticMilkTea(f.deps); await f.tick(); assert.deepEqual(f.writes(), [1]);
  assert.equal(journal(f).actionState.spend['2026-10-29']['1001'], '240000');
}));

test('wage latch covers the entire class; new slips, success, reload and malformed false never reopen it', async () => using({ milk_tea_auto_work: true }, async f => {
  f.unknown(64); await f.service.runAutomaticMilkTea(f.deps); assert.deepEqual(f.writes(), [64]);
  f.unknown(0); f.work.slips = [{ shift_id: 7002 }]; f.reload(); await f.tick(); assert.equal(f.writes().filter(cmd => cmd === 64).length, 1);
  f.summary.hasUnclaimedWage = false; f.summary.hasUnclaimedWageKnown = false; await f.tick(); assert.ok(journal(f).actionState.wages);
  f.summary.hasUnclaimedWageKnown = true; await f.tick(); assert.equal(journal(f).actionState.wages, null);
  f.summary.hasUnclaimedWage = true; await f.tick(); assert.equal(f.writes().filter(cmd => cmd === 64).length, 2);
  await f.tick(); assert.equal(f.writes().filter(cmd => cmd === 64).length, 2, 'confirmed reply with unchanged fresh state is also latched');
}));
test('one interaction for the entire shift; gameplay loss is attempted, option change or missing shift cannot replay it', async () => using({ milk_tea_auto_work: true }, async f => {
  f.summary.hasUnclaimedWage = false;
  await f.service.runAutomaticMilkTea(f.deps); assert.deepEqual(f.writes(), [65]);
  f.setFlags({ milk_tea_work_interaction_type: 2 }); await f.tick(); assert.deepEqual(f.writes(), [65]);
  const shift = f.work.my_shift; delete f.work.my_shift; await f.tick(); f.work.my_shift = shift; await f.tick(); assert.deepEqual(f.writes(), [65]);
  shift.shift_id = '7002'; await f.tick(); assert.deepEqual(f.writes(), [65, 65]);
}));
for (const field of ['interact_count', 'interact_limit', 'end_at', 'shift_id']) test(`missing ${field} does not authorize interaction`, async () => using({ milk_tea_auto_work: true }, async f => {
  f.summary.hasUnclaimedWage = false; delete f.work.my_shift[field]; await f.service.runAutomaticMilkTea(f.deps); assert.deepEqual(f.writes(), []);
}));
test('upgrade requires level progress, never a different day, success text, same-level reply or an unknown cost', async () => using({ milk_tea_auto_upgrade: true }, async f => {
  f.response((cmd, reply) => cmd === 61 ? { ...reply, milk_tea_upgrade: { level: f.summary.level } } : reply);
  await f.service.runAutomaticMilkTea(f.deps); assert.deepEqual(f.writes(), [61]); f.reload(); await f.tick(); assert.deepEqual(f.writes(), [61]);
  f.summary.level = 2; f.summary.upgradeCosts = [{ id: 1041, count: '1' }]; await f.tick(); assert.deepEqual(f.writes(), [61]);
  delete f.summary.upgradeCosts; f.response(null); await f.tick(); assert.deepEqual(f.writes(), [61, 61]);
}));
test('three new writes maximum and independent reward preference stays off; no one-minute success poller', async () => using({ ...seedFlags, milk_tea_auto_work: true, milk_tea_auto_upgrade: true }, async f => {
  await f.service.runAutomaticMilkTea(f.deps); assert.deepEqual(f.writes(), [64, 65, 61]); assert.equal(f.calls.includes(55), false);
  const count = f.calls.length; f.clock.now += 60000; await f.service.runAutomaticMilkTea(f.deps); assert.equal(f.calls.length, count);
}));
test('persist failure prevents writes; reconcile failure rolls back memory and cannot forget an unknown intent', async () => using(seedFlags, async f => {
  const rename = fs.renameSync;
  fs.renameSync = () => { throw new Error('synthetic disk failure'); };
  try { await f.service.runAutomaticMilkTea(f.deps); assert.deepEqual(f.writes(), []); }
  finally { fs.renameSync = rename; }
  f.unknown(1); await f.tick(); assert.deepEqual(f.writes(), [1]); f.unknown(0); f.goods.purchasedCount = 24;
  fs.renameSync = () => { throw new Error('synthetic reconcile disk failure'); };
  try { await f.tick(); assert.deepEqual(f.writes(), [1]); }
  finally { fs.renameSync = rename; }
  f.goods.purchasedCount = 0; await f.tick(); assert.deepEqual(f.writes(), [1], 'failed reconciliation did not delete the in-memory latch');
}));
test('corrupt or oversized journals are not silently truncated into reusable write identities', async () => using(seedFlags, async f => {
  f.unknown(1); await f.service.runAutomaticMilkTea(f.deps); const saved = journal(f);
  for (const mutate of [x => { x.actionState.purchases['301'].spent = { 1001: 'bad' }; }, x => { for (let i = 0; i < 33; i++) x.actionState.purchases[String(1000 + i)] = { ...x.actionState.purchases['301'], goodsId: 1000 + i }; }]) {
    const value = structuredClone(saved); mutate(value); fs.writeFileSync(f.journal(), JSON.stringify(value)); f.reload(); await f.tick(); assert.deepEqual(f.writes(), [1]);
  }
}));
test('real decoder distinguishes omitted booleans, Long zero and explicit fields without weakening manual data', async () => using({}, async f => {
  const summaryType = proto.types.MilkTeaGetGroupReply.root.lookupType('gamepb.milkteapb.MilkTeaActivitySummary');
  const decode = value => summaryType.decode(summaryType.encode(value).finish());
  assert.equal(f.service.milkTeaSummaryDto({ milk_tea: { summary: decode({}) } }).hasUnclaimedWageKnown, false);
  assert.equal(f.service.milkTeaSummaryDto({ milk_tea: { summary: decode({ has_unclaimed_wage: false }) } }).hasUnclaimedWageKnown, true);
  // Real GetGroup goods schema is exercised through the registered rich DTO.
  const group = proto.types.MilkTeaGetGroupReply;
  const encoded = group.encode({ group: { head: { activity_id: 2026110100 }, children: [{ head: { activity_id: 2026110102 }, shop: { goods: [{ id: 301, purchase_limit: '100', purchased_count: '0' }] } }] } }).finish();
  const child = group.decode(encoded).group.children[0];
  const dto = f.service.exchangeShopRichDto(child); assert.equal(dto.items[0].purchaseLimitKnown, true); assert.equal(dto.items[0].purchasedCountKnown, true);
}));
test('pure bounds refuse malformed limits and keep exact large balances', () => {
  const base = { stockGap: 24, seedsPerPortion: 1, remainingLimit: Infinity, unitCosts: [{ itemId: 1001, count: '1' }], balances: { 1001: '90071992547409930' }, reserves: { 1001: '90071992547409920' }, dailyRemaining: { 1001: '100' } };
  assert.equal(policy.purchasePortionCount(base), 10);
  for (const remainingLimit of [Number.NaN, -Infinity, -1, 0.5, null, undefined]) assert.equal(policy.purchasePortionCount({ ...base, remainingLimit }), 0);
});

for (const [action, cmd, flags, input] of [['claimWages', 64, { milk_tea_auto_work: true }, {}], ['upgrade', 61, { milk_tea_auto_upgrade: true }, {}], ['interact', 65, { milk_tea_auto_work: true }, { interactionType: 1, shiftId: '7001' }]]) {
  test(`manual unknown ${action} owns the same durable declaration as automatic execution`, async () => using(flags, async f => {
    f.unknown(cmd); const result = await f.service.runManualMilkTeaAction(action, input, f.deps); assert.equal(result.outcome, 'unknown');
    f.reload(); f.unknown(0); await f.tick(); assert.equal(f.writes().filter(value => value === cmd).length, 1);
  }));
}
test('settlement, final expiry and changing maturity/day during a read stop affected automatic writes', async () => {
  await using({ ...seedFlags, milk_tea_auto_work: true, milk_tea_auto_upgrade: true }, async f => {
    f.clock.now = Date.parse('2026-11-15T12:00:00Z'); f.summary.hasUnclaimedWage = false;
    await f.service.runAutomaticMilkTea(f.deps); assert.deepEqual(f.writes(), []);
    f.clock.now = Date.parse('2026-11-17T00:00:00Z'); await f.service.runAutomaticMilkTea(f.deps);
    const count = f.calls.length; f.clock.now += 86400000; await f.service.runAutomaticMilkTea(f.deps); assert.equal(f.calls.length, count, 'known final expiry stops subsequent reads');
  });
  for (const reason of ['maturity', 'day', 'offline']) await using(seedFlags, async f => {
    let allowed = true; f.deps.canRun = () => allowed; f.deps.isReady = () => allowed;
    f.hook(kind => { if (kind !== 'bag') return; if (reason === 'day') f.clock.now += 86400000; else allowed = false; });
    await f.service.runAutomaticMilkTea(f.deps); assert.deepEqual(f.writes(), []);
  });
});

test('legacy loaded capsule without policy fingerprint preserves its absolute wake and performs no early reads', async () => using(seedFlags, async f => {
  const file = require.resolve('../src/services/business-state'); const previous = require.cache[file]; const env = process.env.FARM_SESSION_BUSINESS;
  let capsule;
  require.cache[file] = { exports: { wrapBusinessFunction: (_name, fn) => fn, registerBusinessState: (_name, value) => { capsule = value; } } };
  process.env.FARM_SESSION_BUSINESS = '1';
  try { f.reload(); }
  finally { if (previous) require.cache[file] = previous; else delete require.cache[file]; if (env === undefined) delete process.env.FARM_SESSION_BUSINESS; else process.env.FARM_SESSION_BUSINESS = env; }
  const next = f.clock.now + 600000;
  capsule.restore({ endedEvidence: null, automaticState: { nextCheckAt: next, claims: {}, loaded: true } });
  assert.equal(f.service.automaticMilkTeaWakeAt(f.clock.now), next);
  await f.service.runAutomaticMilkTea(f.deps); assert.deepEqual(f.calls, []);
}));

test('combined free rewards and three new actions stay within the documented 29-RPC round ceiling', async () => using({ ...seedFlags, milk_tea_auto_work: true, milk_tea_auto_upgrade: true, milk_tea_auto_rewards: true }, async f => {
  const read = f.deps.getActivityGroupSnapshot;
  f.deps.getActivityGroupSnapshot = async (...args) => {
    const snapshot = await read(...args); snapshot.children.push({ id: 2026110104, details: { shareReward: { currentScore: 10,
      daily: { rewardClaimed: false, firstShareAwarded: false }, milestones: [{ id: 1, state: 2, threshold: 10 }] } } }); return snapshot;
  };
  f.response((cmd, reply) => {
    const fields = { 55: { milk_tea_get_shop: { shop: { cashier_capacity_sec: 172800, cashier_elapsed_sec: 172800, pending_rewards: [{ id: 1041, count: 10 }] } } },
      59: { milk_tea_claim_cashier: { items: [{ id: 1041, count: 10 }] } }, 74: { share_reward_claim_daily: { granted_score: 5 } },
      70: { share_reward_share: { granted_score: 5 } }, 71: { share_reward_claim_milestones: { claimed_tier_ids: [1] } } };
    return { ...reply, ...fields[cmd] };
  });
  await f.service.runAutomaticMilkTea(f.deps);
  assert.deepEqual(f.writes(), [59, 74, 70, 71, 64, 65, 61]);
  assert.equal(f.calls.filter(value => value !== 'Operate').length, 29);
}));

test('budget and unknown outcomes expose a bounded status reason without journal identities', async () => using(seedFlags, async f => {
  patchPolicy(f, { coinDailyLimit: '0' }); await f.service.runAutomaticMilkTea(f.deps); assert.match(f.service.actionStateSummary().lastMessage, /预算不足/);
  patchPolicy(f, { coinDailyLimit: '240000' }); f.unknown(1); await f.tick();
  assert.match(f.service.actionStateSummary().lastMessage, /结果未知/); assert.equal(f.service.actionStateSummary().lastMessage.includes('301'), false);
}));

test('a delayed unknown purchase confirmed after midnight still consumes the confirmation-day budget', async () => using(seedFlags, async f => {
  f.unknown(1); await f.service.runAutomaticMilkTea(f.deps); assert.deepEqual(f.writes(), [1]);
  f.unknown(0); f.clock.now += 86400000; f.goods.purchasedCount = 24;
  f.bag[0].count = '1760000'; // Fresh wallet reflects the delayed purchase; seeds may already be consumed normally.
  await f.tick(); assert.deepEqual(f.writes(), [1], 'must not spend another full daily allowance when confirmation arrives');
  assert.equal(journal(f).actionState.spend['2026-10-30']['1001'], '240000');
}));


test('fixture journal guard rejects out-of-bounds writes before the primitive and permits an actual in-bounds write', () => {
  let writes = 0;
  const write = name => { const target = fixturePath(name); writes++; fs.writeFileSync(target, 'synthetic-boundary-proof'); };
  assert.throws(() => write('../outside-journal-probe'), /fixture write boundary/);
  assert.equal(writes, 0);
  write('inside-journal-probe'); assert.equal(writes, 1);
  assert.equal(fs.readFileSync(fixturePath('inside-journal-probe'), 'utf8'), 'synthetic-boundary-proof');
  fs.unlinkSync(fixturePath('inside-journal-probe'));
});

test('manual seed confirmation keeps its existing entry when counters are missing; automatic buying still waits', async () => using(seedFlags, async f => {
  delete f.goods.purchasedCountKnown;
  const warehouse = require('../src/services/warehouse'); const deps = { ...f.deps, getBag: warehouse.getBag, getBagItems: warehouse.getBagItems };
  const input = { goodsId: 301, count: 1, confirmedCosts: [{ itemId: 1001, count: '10000' }] };
  assert.equal((await f.service.runManualMilkTeaAction('exchange', input, deps)).ok, true);
  assert.equal((await f.service.runManualMilkTeaAction('exchange', input, deps)).ok, true, 'new explicit manual confirmation can buy again after a confirmed result');
  assert.equal(journal(f).actionState.purchases['301'].baselinePurchased, null);
  await f.tick(); assert.deepEqual(f.writes(), [1, 1], 'missing counter does not permit automatic buying');
  f.goods.purchasedCountKnown = true; f.goods.purchasedCount = 2; f.bag.push({ id: 20525, count: '24', uid: '3' }); await f.tick();
  assert.equal(journal(f).actionState.purchases['301'], undefined, 'known counter may reconcile an already confirmed manual result');
}));
test('manual unknown with an unknown starting count is never guessed as zero or replaced by the next intent', async () => using(seedFlags, async f => {
  delete f.goods.purchasedCountKnown; f.unknown(1);
  const warehouse = require('../src/services/warehouse'); const deps = { ...f.deps, getBag: warehouse.getBag, getBagItems: warehouse.getBagItems };
  const input = { goodsId: 301, count: 1, confirmedCosts: [{ itemId: 1001, count: '10000' }] };
  assert.equal((await f.service.runManualMilkTeaAction('exchange', input, deps)).outcome, 'unknown');
  f.reload(); f.unknown(0); f.goods.purchasedCountKnown = true; f.goods.purchasedCount = 1;
  await f.tick(); assert.deepEqual(f.writes(), [1]);
  await assert.rejects(f.service.runManualMilkTeaAction('exchange', input, deps), { code: 'SEASON_WISH_MILK_TEA_LIMIT' });
  assert.deepEqual(f.writes(), [1]); assert.equal(journal(f).actionState.purchases['301'].baselinePurchased, null);
}));
