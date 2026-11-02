const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const parent = fs.realpathSync(os.tmpdir());
const prefix = path.resolve(parent, 'farm-mail-regression-');
assert.equal(path.dirname(prefix), parent);
const root = fs.mkdtempSync(prefix);
process.env.FARM_DATA_DIR = root;
const protobuf = require('protobufjs');
const source = path.resolve(__dirname, '../src/services/email.js');
const schema = new protobuf.Root().loadSync([path.resolve(__dirname, '../src/proto/corepb.proto'), path.resolve(__dirname, '../src/proto/emailpb.proto')], { keepCase: true }).resolveAll();
const types = Object.fromEntries(['GetEmailListRequest','GetEmailListReply','ClaimEmailRequest','ClaimEmailReply','BatchClaimEmailRequest','BatchClaimEmailReply'].map(n => [n, schema.lookupType(`gamepb.emailpb.${n}`)]));
const encode = (n, data) => types[n].encode(types[n].create(data)).finish();
const initial = crypto.createHash('sha256').update(fs.readFileSync(source)).digest('hex');
test.after(() => { assert.equal(crypto.createHash('sha256').update(fs.readFileSync(source)).digest('hex'), initial); fs.rmSync(root, { recursive: true, force: true }); });
function harness(t, options = {}) {
  const dir = options.dir || path.resolve(root, crypto.randomUUID());
  assert.ok(dir.startsWith(root + path.sep)); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const state = { now: 1800000000000, boxes: { 1: [], 2: [] }, calls: [], fail: new Set(), connection: {}, connected: true, hook: null, logs: [] };
  class Clock extends Date { constructor(...args) { super(...(args.length ? args : [state.now])); } static now() { return state.now; } }
  const net = { isConnected: () => state.connected, getWs: () => state.connection,
    sendMsgAsync: async (service, method, bytes) => {
      const request = types[`${method}Request`].decode(bytes); const box = Number(request.box_type);
      state.calls.push({ method, box });
      if (state.hook) { const response = await state.hook(method, box, request); if (response) return response; }
      if (method === 'GetEmailList') {
        if (state.fail.has(box)) throw new Error('synthetic read failure');
        return { body: encode('GetEmailListReply', { emails: state.boxes[box] }) };
      }
      if (method === 'BatchClaimEmail' || method === 'ClaimEmail') {
        for (const row of state.boxes[box]) row.claimed = true;
        return { body: encode(`${method}Reply`, { items: [{ id: 1002, count: 150 }] }) };
      }
      throw new Error('unexpected method');
    } };
  const req = createRequire(source), module = { exports: {} };
  const env = { FARM_DATA_DIR: dir, FARM_ACCOUNT_ID: 'fixture-mail' };
  const context = { module, exports: module.exports, Buffer, structuredClone, Date: Clock, process: { env }, console,
    require: name => name === '../utils/network' ? net : name === '../utils/proto' ? { types }
      : name === '../utils/utils' ? { toNum: Number, log: (...x) => state.logs.push(x) }
        : name === '../config/gameConfig' ? { getItemById: () => ({ name: '示例奖励' }) }
          : name === '../config/runtime-paths' ? { getDataDir: () => dir } : req(name) };
  vm.runInNewContext(fs.readFileSync(source, 'utf8'), context, { filename: source });
  return { service: module.exports, state, dir, env, count: method => state.calls.filter(row => row.method === method).length,
    add: (box, id) => state.boxes[box].push({ id, has_reward: true, claimed: false }), encode };
}

test('same-day later mail is checked after the existing five-minute cooldown', async t => {
  const h = harness(t); h.add(1, 'first'); await h.service.checkAndClaimEmails();
  h.state.now += 300001; h.add(1, 'later'); await h.service.checkAndClaimEmails();
  assert.equal(h.count('BatchClaimEmail'), 2, 'doneToday must not hide later mail');
});
test('one mailbox failing is not evidence that both mailboxes are complete', async t => {
  const h = harness(t); h.state.fail.add(2); await h.service.checkAndClaimEmails();
  assert.equal(h.service.getEmailDailyState().doneToday, false);
});
test('a successful batch is not followed by individual writes and counts mail once', async t => {
  const h = harness(t); h.add(1, 'one'); h.add(1, 'two');
  const result = await h.service.checkAndClaimEmails();
  assert.equal(h.count('ClaimEmail'), 0, 'successful batch must never fall through');
  assert.equal(result.claimed, 2);
  assert.equal(result.rewardItems, 1);
});
module.exports = { harness, root };
