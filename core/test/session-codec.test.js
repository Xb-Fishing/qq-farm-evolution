const test = require('node:test'); const assert = require('node:assert/strict');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const temp = fs.realpathSync(os.tmpdir()); const repo = fs.realpathSync(path.join(__dirname, '../..'));
assert.ok(temp !== repo && !temp.startsWith(repo + path.sep));
const prefix = path.resolve(temp, 'session-codec-test-'); assert.equal(path.dirname(prefix), temp);
const temporary = fs.mkdtempSync(prefix);
function fixturePath(name) {
  const target = path.resolve(temporary, name);
  assert.equal(path.dirname(target), temporary);
  return target;
}
process.env.FARM_DATA_DIR = temporary;
process.env.FARM_PRIVATE_CONFIG_FILE = fixturePath('private-config.json');
process.env.FARM_LOG_DIR = fixturePath('logs');
process.env.FARM_SESSION_LOG_DIR = fixturePath('session-logs');
test.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
const Long = require('long'); const protobuf = require('protobufjs');
const { encode, decode } = require('../src/runtime/session-codec');

test('bridge preserves bytes, Long, protobuf own fields, aliases and cycles', () => {
  const root = protobuf.parse('syntax="proto3"; message Facts { int64 gold=1; int32 level=2; bytes body=3; }').root;
  const type = root.lookupType('Facts');
  const message = type.decode(type.encode({ gold: Long.fromString('9007199254740995'), body: Buffer.from([0, 128, 255]) }).finish());
  const state = { message, map: new Map(), set: new Set(), same: message, absent: undefined, dictionary: Object.assign(Object.create(null), { count: 1 }) };
  state.map.set(state, message); state.set.add(state); state.self = state;
  const copy = decode(encode(state), { lookupType: name => root.lookupType(name) });
  assert.equal(copy.self, copy); assert.equal(copy.message, copy.same); assert.equal(copy.map.get(copy), copy.message);
  assert.equal(copy.set.has(copy), true); assert.equal(copy.message.gold.toString(), '9007199254740995');
  assert.equal(Long.isLong(copy.message.gold), true); assert.deepEqual(copy.message.body, Buffer.from([0, 128, 255]));
  assert.equal(Object.hasOwn(copy.message, 'level'), false); assert.equal(copy.message.level, 0);
  assert.equal(Object.hasOwn(copy, 'absent'), true);
  assert.equal(Object.getPrototypeOf(copy.dictionary), null); assert.equal(copy.dictionary.count, 1);
});

test('sparse arrays preserve holes, explicit undefined and shared socket references', () => {
  const socket = {}; const array = []; array.length = 5; array[2] = undefined; array[4] = socket;
  const restoredSocket = {};
  const copy = decode(encode(array, { special: value => value === socket ? 'socket-1' : null }), {
    special: reference => { assert.equal(reference, 'socket-1'); return restoredSocket; },
  });
  assert.equal(copy.length, 5); assert.equal(Object.hasOwn(copy, 0), false); assert.equal(Object.hasOwn(copy, 2), true);
  assert.equal(copy[2], undefined); assert.equal(copy[4], restoredSocket);
});

test('errors keep business semantics while rejecting non-transferable checkpoint values', () => {
  const error = Object.assign(new Error('governed'), { code: 'RATE_LIMIT', isGovernedRejection: true, pauseRemainMs: 31, privateField: 'not forwarded' });
  const copy = decode(encode(error)); assert.equal(copy instanceof Error, true);
  assert.equal(copy.message, 'governed'); assert.equal(copy.code, 'RATE_LIMIT'); assert.equal(copy.pauseRemainMs, 31);
  assert.equal(copy.privateField, undefined); assert.equal(copy.isGovernedRejection, true);
  const timer = setTimeout(() => {}, 10000);
  try { for (const value of [() => {}, Promise.resolve(), timer]) assert.throws(() => encode(value), /Unsupported/); }
  finally { clearTimeout(timer); }
});

test('errors retain an explicit local rejection marker only when provided', () => {
  for (const marker of [true, false]) {
    const original = Object.assign(new Error('synthetic rejection'), {
      isLocalRequestRejection: marker, operationNotSent: true, quoteId: 'synthetic-quote', outcome: 'not_sent',
    });
    const copy = decode(encode(original));
    assert.equal(copy.isLocalRequestRejection, marker);
    for (const field of ['operationNotSent', 'quoteId', 'outcome'])
      assert.equal(Object.hasOwn(copy, field), false);
  }
  assert.equal(Object.hasOwn(decode(encode(new Error('ordinary error'))), 'isLocalRequestRejection'), false);
});
