const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parsePauseUntilMs,
  normalizePauseUntil,
} = require('../src/utils/pause-until');

test('旧版无时区静默时间按北京时间解释，避免服务器额外静默八小时', () => {
  const expected = Date.parse('2026-08-25T10:00:00+08:00');
  assert.equal(parsePauseUntilMs('2026-08-25T10:00'), expected);
  assert.equal(normalizePauseUntil('2026-08-25T10:00'), '2026-08-25T02:00:00.000Z');
});

test('新版 ISO 静默时间保持同一个绝对时刻', () => {
  const value = '2026-08-25T02:00:00.000Z';
  assert.equal(parsePauseUntilMs(value), Date.parse(value));
  assert.equal(normalizePauseUntil(value), value);
  assert.equal(normalizePauseUntil('invalid'), '');
  assert.equal(normalizePauseUntil(''), '');
});
