const assert = require('node:assert/strict');
const test = require('node:test');

const { AUTO_BUY_CHECK_INTERVAL_MS } = require('../src/services/mystery-shop');

test('mystery shop auto-buy polls often enough to catch offers appearing after login', () => {
  assert.equal(AUTO_BUY_CHECK_INTERVAL_MS, 10 * 60 * 1000);
  assert.ok(AUTO_BUY_CHECK_INTERVAL_MS < 3 * 60 * 60 * 1000);
});

const { nextAutoBuyCheckDelayMs } = require('../src/services/mystery-shop');

test('自动购买轮询间隔带 ±25% 抖动，不再是固定节奏', () => {
  const spread = Math.floor(AUTO_BUY_CHECK_INTERVAL_MS * 0.25);
  const samples = new Set();
  for (let i = 0; i < 50; i++) {
    const delay = nextAutoBuyCheckDelayMs();
    assert.ok(delay >= AUTO_BUY_CHECK_INTERVAL_MS - spread);
    assert.ok(delay <= AUTO_BUY_CHECK_INTERVAL_MS + spread);
    samples.add(delay);
  }
  assert.ok(samples.size > 1, '多次采样应产生不同间隔');
});
