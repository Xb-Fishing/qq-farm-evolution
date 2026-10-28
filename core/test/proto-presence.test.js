const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { test, before, after } = require('node:test');

const prefix = path.resolve(os.tmpdir(), 'qq-farm-proto-presence-');
assert.equal(path.dirname(prefix), path.resolve(os.tmpdir()));
const dataDir = fs.mkdtempSync(prefix);
process.env.FARM_DATA_DIR = dataDir;
const proto = require('../src/utils/proto');
const friendActivity = require('../src/services/friend-activity');
const own = (message, field) => Object.hasOwn(message, field);
before(() => proto.loadProto());
after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

// These bytes deliberately bypass the upgraded encoder: it used to hide the
// regression by omitting explicit scalar defaults before the decoder saw them.
test('raw explicit false stays distinct from a missing friend presence field', () => {
  const reply = proto.getRoot().lookupType('gamepb.visitpb.EnterReply').decode(Buffer.from('3000', 'hex'));
  assert.equal(own(reply, 'at_home'), true);
  assert.equal(reply.at_home, false);
  assert.equal(own(proto.getRoot().lookupType('gamepb.visitpb.EnterReply').decode(Buffer.alloc(0)), 'at_home'), false);
});

test('raw nested zero balances stay distinct from omitted balance fields', () => {
  const basic = proto.types.BasicNotify.decode(Buffer.from('0a0420002800', 'hex')).basic;
  assert.equal(own(basic, 'gold'), true);
  assert.equal(own(basic, 'exp'), true);
  assert.equal(Number(basic.gold), 0);
  assert.equal(Number(basic.exp), 0);
  const omitted = proto.types.BasicNotify.decode(Buffer.from('0a00', 'hex')).basic;
  assert.equal(own(omitted, 'gold'), false);
  assert.equal(own(omitted, 'exp'), false);
});

test('encoding and reencoding preserve explicitly supplied scalar defaults', () => {
  const Basic = proto.getRoot().lookupType('gamepb.userpb.BasicInfo');
  const wire = Buffer.from('200028007000', 'hex');
  const message = Basic.decode(wire);
  assert.deepEqual(Buffer.from(Basic.encode(message).finish()), wire);
  assert.deepEqual(Buffer.from(Basic.encode({ exp: 0, gold: 0, disable_nudge: false }).finish()), wire);
  assert.equal(Basic.encode({}).finish().length, 0);
});

test('repeated request fields retain the schema wire format', () => {
  const Request = proto.types.BatchBasicInfoRequest;
  assert.deepEqual([...Request.encode({ gids: [1, 2] }).finish()], [8, 1, 8, 2]);
});

// Exercise the production consumer bodies with decoded messages and local
// collaborators, without opening sockets or adding test-only runtime exports.
function consumer(relative, name, globals) {
  const source = fs.readFileSync(path.join(__dirname, '../src', relative), 'utf8');
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} exists`);
  const end = source.indexOf('\nfunction ', start + 1);
  assert.ok(end > start, `${name} has a following declaration`);
  return vm.runInNewContext(`${source.slice(start, end)}\n${name};`, globals);
}

test('real notification consumer applies explicit zero and leaves omitted balances alone', () => {
  const state = { gold: 123, exp: 456, level: 1 };
  const notify = consumer('utils/network.js', 'handleNotify', {
    Buffer, types: proto.types, userState: state, sessionTransportHooks: null,
    hasOwn: own, toNum: Number, log: () => {}, updateStatusGold: () => {},
    updateStatusLevel: () => {}, recordOperation: () => {},
  });
  const apply = hex => notify({ body: proto.types.EventMessage.encode({
    message_type: 'gamepb.userpb.BasicNotify', body: Buffer.from(hex, 'hex'),
  }).finish() });
  apply('0a00');
  assert.deepEqual(state, { gold: 123, exp: 456, level: 1 });
  apply('0a0420002800');
  assert.deepEqual(state, { gold: 0, exp: 0, level: 1 });
});

test('real friend evidence consumer recognizes explicit absence without inventing missing evidence', () => {
  friendActivity.resetForTest();
  const observations = [];
  const unsubscribe = friendActivity.onPresenceObservation((_gid, _now, value) => observations.push(value));
  try {
    friendActivity.noteEnterPresence(501, proto.getRoot().lookupType('gamepb.visitpb.EnterReply').decode(Buffer.from('3000', 'hex')));
    friendActivity.noteEnterPresence(501, proto.getRoot().lookupType('gamepb.visitpb.EnterReply').decode(Buffer.alloc(0)));
    assert.equal(observations[0].atHomeDecoded, true);
    assert.equal(observations[0].atHome, false);
    assert.equal(observations[1].atHomeDecoded, false);
  } finally {
    unsubscribe();
    friendActivity.resetForTest();
  }
});

test('real fertilizer target consumer rejects explicitly exhausted quota', () => {
  const Plant = proto.getRoot().lookupType('gamepb.plantpb.PlantInfo');
  const targets = consumer('services/farm-fertilizer.js', 'getOrganicFertilizerTargetsFromLands', {
    toNum: Number, getCurrentPhase: () => ({ phase: 1 }), PlantPhase: { DEAD: 99 },
  });
  const land = wire => ({ id: 1, unlocked: true, plant: Object.assign(Plant.decode(wire), { phases: [{}] }) });
  assert.deepEqual([...targets([land(Buffer.from('880100', 'hex'))])], []);
  assert.deepEqual([...targets([land(Buffer.alloc(0))])], [1]);
  assert.deepEqual([...targets([land(Buffer.from('880101', 'hex'))])], [1]);
});

test('truncated protocol messages continue to fail decoding', () => {
  assert.throws(() => proto.getRoot().lookupType('gamepb.visitpb.EnterReply').decode(Buffer.from('30', 'hex')), /range|buffer/i);
});
