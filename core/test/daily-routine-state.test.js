const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-farm-daily-routine-'));
process.env.FARM_DATA_DIR = dataDir;

const state = require('../src/services/daily-routine-state');
const { isNotVipError } = require('../src/services/qqvip');

test.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

test('daily routine completion survives worker memory reset and stays account-scoped', () => {
  const today = new Date('2026-08-24T12:00:00Z');
  assert.equal(state.isDailyRoutineDone('1', 'email_rewards', today), false);
  assert.equal(state.markDailyRoutineDone('1', 'email_rewards', today), true);
  state.resetMemoryForTest();
  assert.equal(state.isDailyRoutineDone('1', 'email_rewards', today), true);
  assert.equal(state.isDailyRoutineDone('2', 'email_rewards', today), false);
});

test('daily routine completion expires on the next local date', () => {
  state.resetMemoryForTest();
  assert.equal(
    state.isDailyRoutineDone('1', 'email_rewards', new Date('2026-08-25T12:00:00Z')),
    false
  );
});

test('non-VIP is a known terminal daily result, not an unknown retry target', () => {
  assert.equal(isNotVipError(new Error('code=1020001 非QQ会员')), true);
  assert.equal(isNotVipError(new Error('请求超时: RefreshVipInfo')), false);
  assert.equal(isNotVipError(new Error('未知错误码')), false);
});

test('worker startup consults persisted daily state without forcing completed RPCs', () => {
  const worker = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'worker.js'), 'utf8');
  assert.match(worker, /runDailyRoutineStep\('email_rewards'/);
  assert.match(worker, /runDailyRoutineStep\('vip_daily_gift'/);
  assert.match(worker, /withPersistedDone\('mall_free_gifts'/);
  const start = worker.indexOf('function startDailyRoutineTimer');
  const end = worker.indexOf('// 神秘商人可能在登录后的任意时间出现', start);
  const timer = worker.slice(start, end);
  assert.match(timer, /runDailyRoutines\(false\)\.catch/);
  assert.doesNotMatch(timer, /runDailyRoutines\(true\)/);
});

test('unknown pushes are evidence-only with a bounded type set and no retry branch', () => {
  const network = fs.readFileSync(path.join(__dirname, '..', 'src', 'utils', 'network.js'), 'utf8');
  const start = network.indexOf('// 未识别推送绝不触发新接口或重试');
  const end = network.indexOf('\n    } catch (e)', start);
  const block = network.slice(start, end);
  assert.match(block, /MAX_UNKNOWN_NOTIFY_TYPES/);
  assert.match(block, /不响应\/不重试/);
  assert.doesNotMatch(block, /sendMsg(?:Async)?\(/);
  assert.doesNotMatch(block, /setTimeout/);
});
