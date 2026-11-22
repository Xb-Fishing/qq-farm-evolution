'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const protobuf = require('protobufjs');
const codec = require('../src/services/ranch-codec');
const social = require('../src/services/ranch-social');

const host = '9007199254740993';
const self = '9007199254740995';
const ranchId = '9007199254740997';
const unknown = { code: 'RANCH_RESULT_UNKNOWN' };

// Use the actual ranch definitions as dependencies and construct independent wire vectors.
const root = protobuf.Root.fromJSON(codec.types.AnimalRef.root.toJSON());
if (!root.lookup('StrokeAnimalRequest')) protobuf.parse(`syntax = "proto3";${social.SCHEMA}`, root, { keepCase: true });
root.resolveAll();
const encode = (name, value) => {
    const type = root.lookupType(name);
    return Buffer.from(type.encode(type.fromObject(value)).finish());
};
const decode = (name, bytes) => {
    const type = root.lookupType(name);
    return type.toObject(type.decode(bytes), { defaults: true, longs: String });
};

function fixture() {
    const animal = { ranch_inst_id: ranchId, animal_inst_id: 9, animal_id: '60002',
        mutation: { strokable: true, stroked_gids: ['55'] } };
    const hazard = { hazard_id: '12', owner: '55', hazard_type: 1 };
    const ranch = { ranch_inst_id: ranchId, husbandry_type: 1, animals: [animal], hazards: [hazard] };
    const facility = { instance_id: ranchId, facility_id: 6001003, module_type: 6, state: 1 };
    const entry = { basic: { gid: host }, homestead_cells: { facilities: [facility] } };
    const times = { ops: ['11009', '11003'].map(op_id => ({ op_id, times_limit: '5', used_times: '3', remaining_times: '2' })) };
    const detail = { ranches: [ranch] };
    return { input: { host, self, times, entry, detail }, animal, facility, ranch, hazard };
}

test('social codecs preserve large host and ranch IDs, route scope and quota wire tags', () => {
    assert.equal(social.ROUTES.ranchOpTimes.writing, false);
    assert.equal(social.ROUTES.petDuck.service, 'gamepb.animalpb.RanchService');
    assert.equal(social.ROUTES.placeMosquito.method, 'PutHazard');
    assert.deepEqual(encode('GetRanchOpTimesRequest', {}), Buffer.alloc(0));
    const timeReply = protobuf.Writer.create().uint32(10).fork().uint32(8).int64(11009)
        .uint32(16).int64(5).uint32(24).int64(3).uint32(32).int64(2).ldelim().finish();
    const { input } = fixture();
    input.times = decode('GetRanchOpTimesReply', timeReply);
    const pet = social.plan('petDuck', input);
    const petRequest = protobuf.Writer.create().uint32(8).int64(host).uint32(18).fork()
        .uint32(8).int64(ranchId).uint32(16).int32(9).ldelim().finish();
    assert.deepEqual(encode('StrokeAnimalRequest', pet.payload), Buffer.from(petRequest));
    assert.equal(pet.friendOffers[0].remaining, '1');
    const mosquito = social.plan('placeMosquito', fixture().input);
    const mosquitoRequest = protobuf.Writer.create().uint32(8).int64(ranchId).uint32(16).int64(host)
        .uint32(24).int64(11003).uint32(32).int64(1).finish();
    assert.deepEqual(encode('PutHazardRequest', mosquito.payload), Buffer.from(mosquitoRequest));
});

test('petting selects a currently eligible duck and rejects wrong visit identities or unproven quota', () => {
    const { input, animal, ranch } = fixture();
    ranch.animals.unshift({ ...animal, animal_inst_id: 2, animal_id: '60001' });
    ranch.animals.push({ ...animal, animal_inst_id: 4, mutation: { strokable: true, stroked_gids: [self] } });
    assert.equal(social.plan('petDuck', input).payload.target.animal_inst_id, 9);
    animal.mutation.strokable = false;
    assert.equal(social.plan('petDuck', input), null);

    const mismatch = { code: 'RANCH_RESPONSE_MISMATCH' };
    assert.throws(() => social.plan('petDuck', { ...input, times: { ops: [] } }), mismatch);
    assert.throws(() => social.plan('petDuck', { ...input, times: { ops: [input.times.ops[0], input.times.ops[0]] } }), mismatch);
    input.times.ops[0].remaining_times = '3';
    assert.throws(() => social.plan('petDuck', input), mismatch);
    input.times.ops[0].remaining_times = '0';
    assert.throws(() => social.plan('petDuck', input), { code: 'RANCH_INTERACTION_LIMIT' });
    assert.throws(() => social.plan('petDuck', { ...input, host: '42' }), { code: 'RANCH_FRIEND_UNAVAILABLE' });
});

test('pet receipt must confirm the same duck and newly recorded actor even if no mutation was triggered', () => {
    const { input, ranch, animal } = fixture();
    const plan = social.plan('petDuck', input);
    const stroked = [...animal.mutation.stroked_gids, self];
    const reply = { remaining_times: '1', triggered: false,
        ranches: [{ ...ranch, animals: [{ ...animal, mutation: { ...animal.mutation, stroked_gids: stroked } }] }],
        op_result: { kind: 1, target_id: '9', facility_inst_id: ranchId, costs: [], rewards: [{ id: '1007', count: '1' }] } };
    const roundTrip = decode('StrokeAnimalReply', encode('StrokeAnimalReply', reply));
    assert.equal(roundTrip.op_result.rewards[0].id, '1007');
    assert.equal(social.verify(plan, roundTrip).completed, 1);
    assert.throws(() => social.verify(plan, { ...reply, remaining_times: '2' }), unknown);
    assert.throws(() => social.verify(plan, { ...reply, ranches: [ranch] }), unknown);
    assert.throws(() => social.verify(plan, { ...reply, triggered: true }), unknown);
    assert.throws(() => social.verify(plan, { ...reply, op_result: { ...reply.op_result, target_id: '7' } }), unknown);
});

test('a mosquito plan needs a supported active room, a unique baseline and available capacity', () => {
    const { input, facility, ranch, hazard } = fixture();
    assert.ok(social.plan('placeMosquito', input));
    facility.facility_id = 6001009;
    assert.equal(social.plan('placeMosquito', input), null);
    Object.assign(facility, { facility_id: 6002007, module_type: 7 });
    assert.equal(social.plan('placeMosquito', input), null);
    ranch.husbandry_type = 2;
    assert.ok(social.plan('placeMosquito', input));
    ranch.hazards.push({ ...hazard, hazard_id: '13' }, { ...hazard, hazard_id: '14' });
    assert.equal(social.plan('placeMosquito', input), null);
    ranch.hazards[2].hazard_id = '13';
    assert.throws(() => social.plan('placeMosquito', input), { code: 'RANCH_RESPONSE_MISMATCH' });
});

test('placement confirmation needs the receipt mosquito and the same new hazard in the visited room', () => {
    const { input, ranch, hazard } = fixture();
    const plan = social.plan('placeMosquito', input);
    const added = { hazard_id: '9007199254740999', owner: self, hazard_type: 1 };
    const reply = { actual_count: '1', remaining_times: '1', hazards: [hazard, added], rewards: [] };
    const current = pending => ({ ranches: [{ ...ranch, hazards: pending }] });
    const roundTrip = decode('PutHazardReply', encode('PutHazardReply', reply));
    assert.equal(roundTrip.hazards[1].hazard_id, added.hazard_id);
    assert.deepEqual(social.verify(plan, roundTrip, current([hazard, added])), { completed: 1, rewards: [] });
    assert.throws(() => social.verify(plan, reply), unknown);
    assert.throws(() => social.verify(plan, reply, current([hazard])), unknown);
    assert.throws(() => social.verify(plan, reply, current([hazard, { ...added, owner: '77' }])), unknown);
    assert.throws(() => social.verify(plan, reply, current([hazard, { ...added, hazard_id: '19' }])), unknown);
    const wrongRoom = { ranches: [{ ...ranch, ranch_inst_id: '44', hazards: [hazard, added] }] };
    assert.throws(() => social.verify(plan, reply, wrongRoom), unknown);
    assert.throws(() => social.verify(plan, { ...reply, hazards: [hazard, added, added] }, current([hazard, added])), unknown);
    assert.throws(() => social.verify(plan, { ...reply, rewards: [{ id: '1007', count: '0' }] }, current([hazard, added])), unknown);
});
