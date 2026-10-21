'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const temporaryRoot = fs.realpathSync(process.env.FARM_LOG_HISTORY_TEST_DIR || os.tmpdir());
const prefix = path.resolve(temporaryRoot, 'friend-quiet-hours-');
assert.equal(path.dirname(prefix), temporaryRoot);
const fixture = fs.mkdtempSync(prefix);
process.env.FARM_DATA_DIR = fixture;
const sourceRoot = path.resolve(__dirname, '../src');
const files = ['services/friend-api.js', 'models/store.js'];
const fingerprint = () => files.map(file => {
  const absolute = path.resolve(sourceRoot, file);
  assert.ok(absolute.startsWith(sourceRoot + path.sep));
  return [file, fs.statSync(absolute).mode & 0o777, crypto.createHash('sha256').update(fs.readFileSync(absolute)).digest('hex')];
});
const original = fingerprint();
test.after(() => {
  try { assert.deepEqual(fingerprint(), original); }
  finally {
    assert.ok(path.resolve(fixture).startsWith(temporaryRoot + path.sep));
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

// Each child uses its native Date/TZ, real API and real configuration store.
// Only the local clock in the final default-argument observation is frozen.
const program = `
const path = require('node:path');
const root = process.argv[1];
const store = require(path.join(root, 'models/store'));
const { inFriendQuietHours } = require(path.join(root, 'services/friend-api'));
const network = require(path.join(root, 'utils/network'));
const id = process.env.FARM_ACCOUNT_ID;
const rows = [];
function config(start, end, enabled = true) {
  store.applyConfigSnapshot({ friendQuietHours: { enabled, start, end,
    pauseUntil: '2035-01-01T00:00:00.000Z', idleProtectionEnabled: false } }, { persist: false, accountId: id });
}
function observe(name, beijingTime, expected) {
  rows.push({ name, actual: inFriendQuietHours(new Date(beijingTime)), expected });
}
config('02:04', '06:30');
observe('before daily start', '2026-10-22T02:03:59.999+08:00', false);
observe('daily start inclusive', '2026-10-22T02:04:00+08:00', true);
observe('last millisecond before daily end', '2026-10-22T06:29:59.999+08:00', true);
observe('daily end exclusive', '2026-10-22T06:30:00+08:00', false);
observe('old UTC-shifted start is outside quiet', '2026-10-22T10:04:00+08:00', false);
observe('next Beijing day uses the same selected clock', '2026-10-23T02:04:00+08:00', true);
const saved = store.getFriendQuietHours(id);
const NativeDate = Date;
const instant = Date.parse('2026-10-22T02:04:00+08:00');
globalThis.Date = class extends NativeDate {
  constructor(...args) { super(...(args.length ? args : [instant])); }
  static now() { return instant; }
};
try { rows.push({ name: 'real callers use the default current Date', actual: inFriendQuietHours(), expected: true }); }
finally { globalThis.Date = NativeDate; }
config('23:00', '03:00');
observe('before overnight start', '2026-10-22T22:59:59.999+08:00', false);
observe('overnight start inclusive', '2026-10-22T23:00:00+08:00', true);
observe('overnight Beijing midnight', '2026-10-23T00:00:00+08:00', true);
observe('last millisecond before overnight end', '2026-10-23T02:59:59.999+08:00', true);
observe('overnight end exclusive', '2026-10-23T03:00:00+08:00', false);
config('02:04', '06:30', false);
observe('disabled at selected start', '2026-10-22T02:04:00+08:00', false);
config('02:04', '02:04');
observe('equal endpoints remain all-day before start', '2026-10-22T00:00:00+08:00', true);
observe('equal endpoints remain all-day after start', '2026-10-22T22:00:00+08:00', true);
console.log(JSON.stringify({ rows, saved, socketPresent: !!network.getWs() }));
`;

for (const [index, zone] of ['UTC', 'Asia/Shanghai', 'America/Los_Angeles', 'Asia/Tokyo'].entries()) {
  test(`daily quiet hours use Beijing time with native host timezone ${zone}`, () => {
    const dataDir = path.resolve(fixture, `zone-${index}`);
    assert.ok(dataDir.startsWith(fixture + path.sep));
    fs.mkdirSync(dataDir, { mode: 0o700 });
    let result;
    try {
      result = spawnSync(process.execPath, ['-e', program, sourceRoot], {
        env: { ...process.env, TZ: zone, NODE_OPTIONS: '', FARM_DATA_DIR: dataDir, FARM_ACCOUNT_ID: 'synthetic-quiet-zone' },
        encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024,
      });
      assert.equal(result.status, 0, result.stderr);
      const lines = result.stdout.trim().split('\n');
      const observed = JSON.parse(lines.at(-1));
      assert.equal(observed.socketPresent, false, 'pure time checks must never create a game connection');
      for (const row of observed.rows) assert.equal(row.actual, row.expected, `${zone}: ${row.name}`);
      assert.equal(observed.saved.start, '02:04', 'saved wall clock is not shifted during migration');
      assert.equal(observed.saved.end, '06:30');
      assert.equal(observed.saved.pauseUntil, '2035-01-01T00:00:00.000Z', 'separate manual pause remains an absolute instant');
      assert.equal(observed.saved.idleProtectionEnabled, false);
    } finally { assert.deepEqual(fingerprint(), original); }
  });
}
