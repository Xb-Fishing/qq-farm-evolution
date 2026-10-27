const test = require('node:test'); const assert = require('node:assert/strict');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const vm = require('node:vm'); const { createRequire } = require('node:module');
const prefix = path.resolve(os.tmpdir(), 'share-protocol-recovery-'); assert.equal(path.dirname(prefix), path.resolve(os.tmpdir()));
const temporary = fs.mkdtempSync(prefix); process.env.FARM_DATA_DIR = temporary;
const { loadProto, types } = require('../src/utils/proto');
test.before(loadProto); test.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
// Independent wire fixtures: an opaque field-1 bytes result and field-1 Item.
// They contain no natural response or sharing credential.
const reportWire = Buffer.concat([Buffer.from([10, 39]), Buffer.alloc(39, 8)]);
const claimWire = Buffer.from([10, 5, 8, 233, 7, 16, 5]);
let ordinal = 0;
function fixture(options = {}) {
  const dir = path.resolve(temporary, `case-${++ordinal}`); assert.equal(path.dirname(dir), temporary);
  fs.mkdirSync(dir); const calls = []; const logs = []; const clock = { now: Date.parse('2026-10-21T10:00:00Z') };
  let capsule; let response = options.reply; let release;
  class ClockDate extends Date { constructor(...args) { super(...(args.length ? args : [clock.now])); } static now() { return clock.now; } }
  const filename = path.resolve(__dirname, '../src/services/share.js'); const native = createRequire(filename);
  const replies = { CheckCanShare: Buffer.from([8, 1]), ReportShare: reportWire, ClaimShareReward: claimWire };
  const network = { sendMsgAsync: async (service, method, bytes) => {
    assert.equal(service, 'gamepb.sharepb.ShareService'); calls.push({ method, bytes: Buffer.from(bytes) });
    if (options.hold && method === 'CheckCanShare') await new Promise(resolve => { release = resolve; });
    const value = response ? await response(method) : replies[method];
    if (value instanceof Error) throw value;
    return { body: value };
  } };
  function reload() {
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module, exports: module.exports, Buffer, Date: ClockDate,
      process: { env: { FARM_ACCOUNT_ID: 'synthetic-share', FARM_SESSION_BUSINESS: '1' }, pid: process.pid },
      require: name => name === '../utils/network' ? network : name === '../utils/proto' ? { types }
        : name === '../utils/utils' ? { log: (tag, text, data) => logs.push({ tag, text, data }), toNum: Number }
          : name === '../config/gameConfig' ? { getItemById: () => null }
            : name === '../config/runtime-paths' ? { getDataFile: name => {
              const target = path.resolve(dir, name); assert.equal(path.dirname(target), dir); return target;
            } }
              : name === './business-state' ? { wrapBusinessFunction: (_name, fn) => fn,
                registerDataState: (_name, capture, restore, settings) => { capsule = { capture, restore, settings }; } } : native(name),
    }, { filename });
    return module.exports;
  }
  return { service: reload(), reload, calls, logs, clock, replies, dir, capsule: () => capsule,
    setResponse: value => { response = value; }, release: () => release?.() };
}

test('field-1 bytes report and field-1 reward list decode without fictitious success flags', () => {
  assert.equal(reportWire.length, 41);
  let report; assert.doesNotThrow(() => { report = types.ReportShareReply.decode(reportWire); });
  assert.equal(report.result.length, 39);
  const claim = types.ClaimShareRewardReply.decode(claimWire);
  assert.equal(Number(claim.items[0].id), 1001); assert.equal(Number(claim.items[0].count), 5);
});

test('actual daily flow accepts opaque report, claims once and logs only verified reward names', async () => {
  const f = fixture(); assert.equal(await f.service.performDailyShare(), true);
  assert.deepEqual(f.calls.map(row => row.method), ['CheckCanShare', 'ReportShare', 'ClaimShareReward']);
  assert.equal(f.calls[1].bytes.toString('hex'), '0801'); assert.equal(f.calls[2].bytes.toString('hex'), '0801');
  assert.ok(f.logs.some(row => row.text === '领取成功 → 金币5'));
  assert.equal(JSON.stringify(f.logs).includes('result":{"type":"Buffer"'), false);
  assert.equal(await f.service.performDailyShare(true), false); assert.equal(f.calls.length, 3);
  const reloaded = f.reload(); await reloaded.performDailyShare(true); assert.equal(f.calls.length, 3);
});

test('malformed report stops claim and its durable stage prevents forced/restarted replay', async () => {
  const f = fixture(); f.setResponse(method => method === 'ReportShare' ? Buffer.from([10, 39, 1]) : f.replies[method]);
  assert.equal(await f.service.performDailyShare(), false);
  assert.deepEqual(f.calls.map(row => row.method), ['CheckCanShare', 'ReportShare']);
  assert.ok(f.logs.some(row => row.data.stage === 'ReportShare' && row.data.result === 'unknown' && row.data.reason === 'SHARE_REPLY_DECODE_FAILED'));
  f.setResponse(null); await f.service.performDailyShare(true); await f.reload().performDailyShare(true);
  assert.equal(f.calls.length, 2); assert.equal(f.service.getShareDailyState().doneToday, false);
  f.clock.now += 86400000; assert.equal(await f.reload().performDailyShare(), true); assert.equal(f.calls.length, 5);
});

test('unknown or empty claim outcome is not reported successful or replayed on the next business', async () => {
  for (const outcome of [Buffer.from([10, 5, 8]), Buffer.alloc(0), new Error('synthetic lost reply')]) {
    const f = fixture(); f.setResponse(method => method === 'ClaimShareReward' ? outcome : f.replies[method]);
    assert.equal(await f.service.performDailyShare(), false); assert.equal(f.calls.length, 3);
    assert.ok(f.logs.some(row => row.data.stage === 'ClaimShareReward' && row.data.result === 'unknown'));
    await f.reload().performDailyShare(true); assert.equal(f.calls.length, 3);
    assert.equal(f.logs.some(row => row.data.result === 'ok'), false);
  }
});

test('read failures can retry; numeric already-claimed errors complete without inventing a new award', async () => {
  const f = fixture(); f.setResponse(() => Buffer.from([8]));
  await f.service.performDailyShare(); assert.equal(f.calls.length, 1);
  assert.equal(f.logs.at(-1).data.stage, 'CheckCanShare'); assert.equal(f.logs.at(-1).data.result, 'error');
  f.setResponse(method => method === 'ClaimShareReward' ? Object.assign(new Error('synthetic server rejection'), { code: 1009001 }) : f.replies[method]);
  await f.service.performDailyShare(true); assert.equal(f.calls.length, 4);
  assert.equal(f.service.getShareDailyState().doneToday, true); assert.equal(f.logs.at(-1).data.result, 'none');
});

test('concurrent and warm callers keep the old capsule fields and wait for the active operation', async () => {
  const f = fixture({ hold: true });
  assert.deepEqual(Object.keys(f.capsule().capture()).sort(), ['doneDateKey', 'lastCheckAt', 'lastClaimAt']);
  const oldState = { doneDateKey: '', lastCheckAt: 0, lastClaimAt: 0 }; f.capsule().restore(oldState);
  const first = f.service.performDailyShare(); assert.equal(f.capsule().settings.idle?.(), false, 'an in-flight share must prevent checkpoint capture');
  await f.service.performDailyShare(true); assert.equal(f.calls.length, 1); f.release(); await first;
  assert.equal(f.capsule().settings.idle?.(), true); assert.equal(f.calls.length, 3);
});

test('corrupt journal blocks new writes and crossing midnight during the read does not write under the wrong day', async () => {
  const f = fixture(); const file = path.resolve(f.dir, 'daily-share-attempt-synthetic-share.json');
  assert.equal(path.dirname(file), f.dir); fs.writeFileSync(file, 'invalid');
  await f.service.performDailyShare(); assert.equal(f.calls.length, 0); assert.equal(f.logs.at(-1).data.stage, 'journal');
  const next = fixture(); next.setResponse(method => { next.clock.now += 86400000; return next.replies[method]; });
  await next.service.performDailyShare(); assert.deepEqual(next.calls.map(row => row.method), ['CheckCanShare']);
});
