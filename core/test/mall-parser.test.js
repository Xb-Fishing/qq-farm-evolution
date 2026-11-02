const assert = require('node:assert/strict');
const test = require('node:test');

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const prefix = path.resolve(fs.realpathSync(os.tmpdir()), 'mall-parser-test-');
assert.equal(path.dirname(prefix), fs.realpathSync(os.tmpdir()));
const temporary = fs.mkdtempSync(prefix);
process.env.FARM_DATA_DIR = temporary;
test.after(() => fs.rmSync(temporary, { recursive: true, force: true }));

const {
  parseMallLimitInfo,
  parseMallPriceInfo,
  parseMallPriceValue,
} = require('../src/services/mall');

test('parses mall price from the item count instead of the currency id', () => {
  assert.equal(parseMallPriceValue(Buffer.from('08ec071019', 'hex')), 25);
  assert.deepEqual(parseMallPriceInfo(Buffer.from('08ec071019', 'hex')), {
    currencyId: 1004,
    price: 25,
  });
  assert.deepEqual(parseMallPriceInfo(Buffer.from('08ea071019', 'hex')), {
    currencyId: 1002,
    price: 25,
  });
});

test('parses daily and activity purchase limits from current mall protocol', () => {
  assert.deepEqual(parseMallLimitInfo(Buffer.from('08011802', 'hex')), {
    limitType: 1,
    limitCount: 2,
    boughtNum: 0,
  });
  assert.deepEqual(parseMallLimitInfo(Buffer.from('080410031803', 'hex')), {
    limitType: 4,
    limitCount: 3,
    boughtNum: 3,
  });
});

function varint(value) {
  let number = BigInt(value); const bytes = [];
  do { const byte = Number(number & 127n); number >>= 7n; bytes.push(byte | (number ? 128 : 0)); } while (number);
  return bytes;
}
test('wide int64 prices preserve exact values instead of becoming free or truncated', () => {
  assert.equal(parseMallPriceValue(Buffer.from([8, ...varint(1002), 16, ...varint('9007199254740993')])), '9007199254740993');
  assert.equal(parseMallPriceValue(new Uint8Array([8, ...varint(1002), 16, ...varint(2147483648)])), 2147483648);
});
test('truncated, wrong-wire and overflowing prices are errors, never zero-price offers', () => {
  for (const bytes of [[8, 234, 7, 16, 128], [8, 234, 7, 18, 1, 0], [8, 234, 7, 16, ...Array.from({length: 9}).fill(255), 2], [8, 234, 7]]) {
    assert.throws(() => parseMallPriceInfo(Buffer.from(bytes)), /畸形/);
  }
});
test('wide limits remain exact and signed-negative or malformed data is rejected', () => {
  assert.deepEqual(parseMallLimitInfo(Buffer.from([8, 4, 16, ...varint('9007199254740993'), 24, ...varint('9007199254740994')])), {
    limitType: 4, boughtNum: '9007199254740993', limitCount: '9007199254740994',
  });
  assert.throws(() => parseMallLimitInfo(Buffer.from([8, 1, 24, ...Array.from({length: 9}).fill(255), 1])), /畸形/);
});
