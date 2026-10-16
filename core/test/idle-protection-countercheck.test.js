const assert = require('node:assert/strict');
const { test, after } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const crypto = require('node:crypto');
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'idle-protection-baseline-'));
process.env.FARM_DATA_DIR = fixture;
process.env.FARM_ACCOUNT_ID = 'synthetic-idle-baseline';
const sourceRoot = path.resolve(__dirname, '../src');
const sourceFiles = ['core/worker.js', 'models/store.js', 'utils/network.js', 'services/friend-visit.js'];
function fingerprint() {
  return sourceFiles.map(file => {
    const p = path.resolve(sourceRoot, file); assert.ok(p.startsWith(sourceRoot + path.sep));
    return [file, fs.statSync(p).mode & 0o777, crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')];
  });
}
const before = fingerprint();
after(() => {
  try { assert.deepEqual(fingerprint(), before); }
  finally { assert.equal(path.dirname(fixture), os.tmpdir()); fs.rmSync(fixture, { recursive: true, force: true }); }
});
function loadExisting(relative, name, context) {
  const text = fs.readFileSync(path.join(sourceRoot, relative), 'utf8');
  const start = new RegExp(`(?:async )?function ${name}\\(`).exec(text);
  if (!start) throw new Error(`environment_existing_entry_missing:${name}`);
  const end = text.indexOf('\n}', start.index);
  if (end < 0) throw new Error('environment_entry_parse');
  vm.createContext(context); vm.runInContext(text.slice(start.index, end + 2), context);
  return context[name];
}

test('existing idle maximum respects the selected twenty-minute range', () => {
  const getMax = loadExisting('core/worker.js', 'idleMaxSleepMs', {
    getFriendQuietHours: () => ({ maxSleepMinutes: 20 }),
  });
  assert.equal(getMax(), 20 * 60_000);
});

test('existing settings entry preserves the selected idle protection and lower range', () => {
  const store = require('../src/models/store');
  const accountId = process.env.FARM_ACCOUNT_ID;
  store.applyConfigSnapshot({ friendQuietHours: { minSleepMinutes: 12, maxSleepMinutes: 20, idleProtectionEnabled: true } }, { persist: false, accountId });
  const read = store.getFriendQuietHours(accountId);
  assert.equal(read.minSleepMinutes, 12); assert.equal(read.idleProtectionEnabled, true);
});

test('existing wire send refuses business work while protection is active', async () => {
  let calls = 0;
  const error = Object.assign(new Error('synthetic local pause'), { code: 'LOCAL_BUSINESS_PAUSED' });
  const context = { ws: { readyState: 1, send: () => calls++ }, WebSocket: { OPEN: 1 },
    clientSeq: 1, pendingCallbacks: new Map(), encodeMsg: async () => Buffer.from('synthetic'),
    businessPauseError: () => error, log() {} };
  const send = loadExisting('utils/network.js', 'sendMsg', context);
  const result = await send('gamepb.plantpb.PlantService', 'Harvest', Buffer.alloc(0), () => {});
  assert.equal(calls, 0); assert.equal(result, false);
});

test('existing push fast lane does not harvest during a pause', async () => {
  let calls = 0;
  const context = { process: { env: { FARM_ACCOUNT_ID: 'synthetic-idle-baseline' } }, Date,
    getPauseRemainMs: () => 60_000, toNum: Number, isPriorityGid: () => true,
    friendActivity: { isFriendOnlineRecently: () => true }, fastLaneRipeLandIds: () => [1],
    fastLaneRecent: new Map(), fastLaneInFlight: new Map(),
    stealHarvest: async () => { calls++; return {}; }, sumHarvestItemCount: () => ({ total: 1 }),
    recordOperation() {}, log() {}, recordEvent() {}, fastLaneDailyText: () => '', sellAllFruits: async () => {} };
  const push = loadExisting('services/friend-visit.js', 'fastLaneSteal', context);
  await push(42, []); await context.fastLaneInFlight.get(42); assert.equal(calls, 0);
});
