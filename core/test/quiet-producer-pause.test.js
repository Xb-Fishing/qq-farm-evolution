const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'); const path = require('node:path'); const os = require('node:os'); const { EventEmitter } = require('node:events');
const prefix = path.resolve(os.tmpdir(), 'quiet-producer-fixture-'); assert.equal(path.dirname(prefix), fs.realpathSync(os.tmpdir()));
const data = fs.mkdtempSync(prefix); process.env.FARM_DATA_DIR = data; process.env.FARM_ACCOUNT_ID = 'synthetic-quiet-producer';
after(() => fs.rmSync(data, { recursive: true, force: true }));
const { loadProto, types } = require('../src/utils/proto'); before(loadProto);
const store = require('../src/models/store');
const pause = value => store.applyConfigSnapshot({ friendQuietHours: { idleProtectionEnabled: false, pauseUntil: value ? new Date(Date.now() + 600000).toISOString() : '' } }, { persist: false });
test('the actual task push and named debounce retain pending work while manual quiet is active', async () => {
  const names = ['../src/utils/network', '../src/services/scheduler', '../src/services/task'].map(require.resolve);
  const old = names.map(name => [name, require.cache[name]]); const tasks = new Map(); const events = new EventEmitter(); const sent = [];
  const scheduler = { clearAll: () => tasks.clear(), setTimeoutTask: (name, delay, fn) => { tasks.set(name, { delay, fn }); }, bindTimeoutTask() {} };
  require.cache[names[0]] = { exports: { isConnected: () => true, networkEvents: events, sendMsgAsync: async (_s, method) => {
    sent.push(method); const type = { ClaimTaskReward: 'ClaimTaskRewardReply', ClaimAllRewardsV2: 'ClaimAllRewardsV2Reply', Bag: 'BagReply' }[method];
    assert.ok(type, method); return { body: types[type].encode({}).finish() };
  } } };
  require.cache[names[1]] = { exports: { createScheduler: () => scheduler } }; delete require.cache[names[2]];
  const service = require(names[2]);
  try {
    store.applyConfigSnapshot({ automation: { task: true } }, { persist: false }); pause(true); service.initTaskSystem();
    events.emit('taskInfoNotify', { tasks: [{ id: 1, progress: 1, total_progress: 1, is_unlocked: true }], actives: [] });
    await tasks.get('task_claim_debounce').fn(); assert.deepEqual(sent, []); assert.ok(tasks.get('task_claim_debounce').delay > 5000);
    pause(false); await tasks.get('task_claim_debounce').fn(); assert.equal(sent.filter(method => method === 'ClaimTaskReward').length, 1);
  } finally { service.cleanupTaskSystem(); for (const [name, value] of old) { if (value) require.cache[name] = value; else delete require.cache[name]; } pause(false); }
});
test('dog automatic producer checks manual quiet again after its read; explicit manual claim remains possible', async () => {
  const names = ['../src/utils/network', '../src/services/dog-skill-gifts'].map(require.resolve); const old = names.map(name => [name, require.cache[name]]); const sent = [];
  require.cache[names[0]] = { exports: { sendMsgAsync: async (_s, method) => {
    sent.push(method);
    if (method === 'GetDogInfo') { pause(true); return { body: types.GetDogInfoReply.encode({ pending_gift_count: 1 }).finish() }; }
    assert.equal(method, 'ClaimSkillGifts'); return { body: types.ClaimSkillGiftsReply.encode({ claimed_count: 1, item: { id: 101351, count: 1 } }).finish() };
  } } }; delete require.cache[names[1]];
  try {
    const service = require(names[1]); pause(false);
    await service.checkAndClaimDogSkillGifts(undefined, { automatic: true }); assert.deepEqual(sent, ['GetDogInfo']);
    await service.checkAndClaimDogSkillGifts(1, { automatic: true }); assert.deepEqual(sent, ['GetDogInfo']);
    assert.equal((await service.checkAndClaimDogSkillGifts(1)).claimed, 1); assert.deepEqual(sent, ['GetDogInfo', 'ClaimSkillGifts']);
  } finally { for (const [name, value] of old) { if (value) require.cache[name] = value; else delete require.cache[name]; } pause(false); }
});
