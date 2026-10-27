const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'); const path = require('node:path'); const os = require('node:os');
const prefix = path.resolve(os.tmpdir(), 'festival-calendar-fixture-'); assert.equal(path.dirname(prefix), fs.realpathSync(os.tmpdir()));
const data = fs.mkdtempSync(prefix); process.env.FARM_DATA_DIR = data;
after(() => fs.rmSync(data, { recursive: true, force: true }));
const { types, loadProto } = require('../src/utils/proto'); before(loadProto);
const { getSolarCalendar, operateSolarCalendar } = require('../src/services/solar-calendar');
function fixture() {
  const now = Math.floor(Date.now() / 1000); const socket = {};
  let current = socket; let ready = true; let unknown = false;
  const calls = [];
  const event = { id: 401, window_status: 2, open_start_time: now - 100, open_end_time: now + 1000,
    rewards: [{ id: 20165, count: 3 }], question_rewards: [{ id: 20165, count: 1 }], direct_claimed: false, quiz_claimed: false, quiz_wrong_today: false, wrong_options: [] };
  const season = { id: 4, reward_claimable: true, reward_claimed: false, rewards: [{ id: 1041, count: 3 }] };
  const deps = { isReady: () => ready, getConnection: () => current, now: () => now * 1000,
    sendMsgAsync: async (service, method, body) => {
      assert.equal(service, 'gamepb.solartermspb.SolarTermsV2Service');
      calls.push({ method, input: types[`${method}Request`].decode(body) });
      if (unknown && method !== 'GetSolarTermsV2') throw new Error('synthetic unknown');
      const result = method === 'GetSolarTermsV2' ? { server_time: now, default_event_id: 401, events: [event], seasons: [season] }
        : method === 'ClaimSolarSeason' ? { rewards: season.rewards, updated_season: { ...season, reward_claimed: true } }
          : { rewards: event.rewards, updated_event: { ...event, ...(method === 'AnswerSolarTerms' ? { quiz_claimed: true } : { direct_claimed: true }) }, ...(method === 'AnswerSolarTerms' ? { correct: true } : {}) };
      return { body: types[`${method}Reply`].encode(result).finish() };
    } };
  return { calls, deps, event, season, setReady: value => { ready = value; }, swap: () => { current = {}; }, setUnknown: () => { unknown = true; } };
}
test('independent V2 query decodes actual rewards and question without ActivityService or guessed answers', async () => {
  const f = fixture(); const result = await getSolarCalendar(f.deps);
  assert.deepEqual(f.calls.map(row => row.method), ['GetSolarTermsV2']);
  assert.equal(result.events[0].name, '重阳'); assert.equal(result.events[0].rewards[0].name, '茱萸种子');
  assert.equal(result.events[0].canClaim, true); assert.equal(result.events[0].options.length, 4); assert.equal(Object.hasOwn(result.events[0], 'answerIndex'), false);
});
test('sign-in, user-selected quiz and season each recheck current eligibility before one write', async () => {
  const f = fixture();
  for (const [action, input, method] of [['claim', { id: 401 }, 'ClaimSolarTermsV2'], ['answer', { id: 401, optionIndex: 0, expectedQuestion: '重阳节又被称为什么节？' }, 'AnswerSolarTerms'], ['season', { id: 4 }, 'ClaimSolarSeason']]) {
    const before = f.calls.length; assert.equal((await operateSolarCalendar(action, input, f.deps)).ok, true);
    assert.deepEqual(f.calls.slice(before).map(row => row.method), ['GetSolarTermsV2', method]);
  }
  assert.equal(Number(f.calls.find(row => row.method === 'AnswerSolarTerms').input.option_index), 0);
});
test('wrong/old selections, closed windows, already claimed and not ready produce zero writes', async () => {
  const f = fixture();
  for (const input of [{ id: 401, optionIndex: -1 }, { id: 401, optionIndex: 0, expectedQuestion: '旧题' }, { id: 999, optionIndex: 0 }]) await assert.rejects(operateSolarCalendar('answer', input, f.deps), /请选择|条件|变化/);
  f.event.wrong_options = [0]; await assert.rejects(operateSolarCalendar('answer', { id: 401, optionIndex: 0, expectedQuestion: '重阳节又被称为什么节？' }, f.deps), /变化/);
  f.event.direct_claimed = true; await assert.rejects(operateSolarCalendar('claim', { id: 401 }, f.deps), /条件/);
  f.event.direct_claimed = false; f.event.open_end_time = 1; await assert.rejects(operateSolarCalendar('claim', { id: 401 }, f.deps), /条件/);
  f.setReady(false); await assert.rejects(getSolarCalendar(f.deps), /未连接/);
  assert.ok(f.calls.every(row => row.method === 'GetSolarTermsV2'));
});
test('unknown write result returns unknown once with no retry or fabricated rewards', async () => {
  const f = fixture(); f.setUnknown();
  const result = await operateSolarCalendar('claim', { id: 401 }, f.deps);
  assert.equal(result.outcome, 'unknown'); assert.equal(result.ok, false);
  assert.deepEqual(f.calls.map(row => row.method), ['GetSolarTermsV2', 'ClaimSolarTermsV2']);
});

test('missing claim flags or rewards never report a confirmed award; proto3 false quiz can confirm a wrong attempt', async () => {
  for (const [action, response] of [
    ['claim', { updated_event: { id: 401 }, rewards: [{ id: 20165, count: 1 }] }],
    ['answer', { correct: true, updated_event: { id: 401, quiz_claimed: true } }],
    ['answer', { updated_event: { id: 401, quiz_wrong_today: true } }],
  ]) {
    const f = fixture(); const read = f.deps.sendMsgAsync;
    f.deps.sendMsgAsync = async (service, method, bytes) => method === 'GetSolarTermsV2' ? read(service, method, bytes) : { body: types[`${method}Reply`].encode(response).finish() };
    const result = await operateSolarCalendar(action, { id: 401, optionIndex: 0, expectedQuestion: '重阳节又被称为什么节？' }, f.deps);
    if (response.updated_event.quiz_wrong_today) { assert.equal(result.ok, true); assert.equal(result.correct, false); assert.match(result.message, /不正确/); }
    else { assert.equal(result.outcome, 'unknown'); assert.equal(result.ok, false); }
  }
});
