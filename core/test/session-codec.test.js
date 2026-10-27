const test = require('node:test'); const assert = require('node:assert/strict');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const prefix = path.resolve(os.tmpdir(), 'session-codec-test-'); assert.equal(path.dirname(prefix), path.resolve(os.tmpdir()));
const temporary = fs.mkdtempSync(prefix); process.env.FARM_DATA_DIR = temporary;
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
