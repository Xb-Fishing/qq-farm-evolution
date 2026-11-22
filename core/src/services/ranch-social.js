'use strict';

const { decimal, metadata, positiveId } = require('./ranch-model');
const { verifyEntry } = require('./ranch-friend');

// The ranch codec supplies AnimalRef, RanchDetail, RanchHazardView and FacilityOpResult.
const SCHEMA = `
message GetRanchOpTimesRequest { repeated int64 op_ids = 1; }
message GetRanchOpTimesReply { repeated RanchOpTimesView ops = 1; }
message RanchOpTimesView {
    int64 op_id = 1;
    int64 times_limit = 2;
    int64 used_times = 3;
    int64 remaining_times = 4;
}
message StrokeAnimalRequest {
    int64 host_gid = 1;
    AnimalRef target = 2;
}
message StrokeAnimalReply {
    repeated RanchDetail ranches = 1;
    FacilityOpResult op_result = 2;
    bool triggered = 3;
    int64 remaining_times = 4;
}
message PutHazardRequest {
    int64 ranch_inst_id = 1;
    int64 host_gid = 2;
    int64 op_id = 3;
    int64 count = 4;
}
message PutHazardReply {
    int64 actual_count = 1;
    int64 remaining_times = 2;
    repeated RanchHazardView hazards = 3;
    repeated Item rewards = 4;
}
`;
const ranchRoute = (method, writing) => Object.freeze({ service: 'gamepb.animalpb.RanchService',
    method, request: `${method}Request`, reply: `${method}Reply`, writing });
const ROUTES = Object.freeze({
    ranchOpTimes: ranchRoute('GetRanchOpTimes', false),
    petDuck: ranchRoute('StrokeAnimal', true),
    careFriend: ranchRoute('StrokeAnimal', true),
    placeMosquito: ranchRoute('PutHazard', true),
});
const OP_IDS = Object.freeze({ petDuck: '11009', careFriend: '11009', placeMosquito: '11003' });
const ACTIONS = new Set(Object.keys(OP_IDS));
const DUCK = '60002';
const animalsById = new Map(metadata.animals.map(animal => [String(animal.id), animal.husbandry_type === '窝' ? 1 : 2]));
const MOSQUITO = 1;
// The ranch facility config assigns a limit of three to both base profiles.
// Higher levels of the same coop or shed use their matching base profile.
const MOSQUITO_LIMIT = 3;
const ranchModules = new Map([['MODULE_TYPE_RANCH_COOP', 6], ['MODULE_TYPE_RANCH_SHED', 7]]);
const facilityModules = new Map(metadata.facilities
    .map(facility => [facility.facility_id, ranchModules.get(facility.module_type)])
    .filter(([, module]) => module !== undefined));

function fail(code, message) {
    throw Object.assign(new Error(message), { code });
}

function remainingTimes(action, reply) {
    const candidates = Array.isArray(reply?.ops) ? reply.ops.filter(row => row?.op_id === OP_IDS[action]) : [];
    if (candidates.length !== 1) fail('RANCH_RESPONSE_MISMATCH', '牧场互动次数未确认');
    const [operation] = candidates;
    const limit = BigInt(decimal(operation.times_limit));
    const used = BigInt(decimal(operation.used_times));
    const remaining = BigInt(decimal(operation.remaining_times));
    if (used > limit || remaining > limit - used)
        fail('RANCH_RESPONSE_MISMATCH', '牧场互动次数未确认');
    if (remaining === 0n) fail('RANCH_INTERACTION_LIMIT', '当前牧场互动次数不足');
    return (remaining - 1n).toString();
}

function verifiedRanches(entry, detail) {
    if (!Array.isArray(entry.homestead_cells.facilities) || !Array.isArray(detail?.ranches))
        fail('RANCH_RESPONSE_MISMATCH', '好友牧场栏舍未确认');
    const facilities = new Map();
    for (const facility of entry.homestead_cells.facilities) {
        if (facilities.has(facility.instance_id)) fail('RANCH_RESPONSE_MISMATCH', '好友牧场的栏舍重复');
        facilities.set(facility.instance_id, facility);
    }
    const seen = new Set();
    return detail.ranches.map(ranch => {
        const ranchId = positiveId(ranch.ranch_inst_id);
        const facility = facilities.get(ranchId);
        if (!facility || seen.has(ranchId)) fail('RANCH_RESPONSE_MISMATCH', '好友牧场详情与进入时的栏舍不匹配');
        seen.add(ranchId);
        return { ranch, ranchId, facility };
    }).sort((left, right) => left.ranchId.length - right.ranchId.length || left.ranchId.localeCompare(right.ranchId));
}

function belongsToRanch(animal, ranchId) {
    return animal.ranch_inst_id === '0' || animal.ranch_inst_id === ranchId;
}

function petTarget(ranch, ranchId, actor, duckOnly) {
    if (![1, 2].includes(ranch.husbandry_type) || (duckOnly && ranch.husbandry_type !== 1)) return null;
    if (!Array.isArray(ranch.animals)) fail('RANCH_RESPONSE_MISMATCH', '好友牧场的动物状态未确认');
    const ids = new Set();
    const candidates = [];
    for (const animal of ranch.animals) {
        const id = animal.animal_inst_id;
        if (!Number.isInteger(id) || id <= 0 || id > 0x7FFFFFFF || ids.has(id) || !belongsToRanch(animal, ranchId))
            fail('RANCH_RESPONSE_MISMATCH', '待抚摸动物与栏舍不匹配');
        ids.add(id);
        if (animalsById.get(animal.animal_id) === ranch.husbandry_type && (!duckOnly || animal.animal_id === DUCK)
            && animal.mutation?.strokable === true
            && Array.isArray(animal.mutation.stroked_gids) && !animal.mutation.stroked_gids.includes(actor)
        ) candidates.push({ id, species: animal.animal_id });
    }
    return candidates.sort((a, b) => Number(b.species === DUCK) - Number(a.species === DUCK) || a.id - b.id)[0] || null;
}

function hazardsById(list) {
    if (!Array.isArray(list)) fail('RANCH_RESPONSE_MISMATCH', '好友牧场的污物状态未确认');
    const hazards = new Map();
    for (const hazard of list) {
        const id = positiveId(hazard.hazard_id);
        if (hazards.has(id)) fail('RANCH_RESPONSE_MISMATCH', '好友牧场的污物重复');
        if (hazard.hazard_type === MOSQUITO) decimal(hazard.owner, '污物来源');
        hazards.set(id, hazard);
    }
    return hazards;
}

function mosquitoCount(hazards) {
    return [...hazards.values()].filter(hazard => hazard.hazard_type === MOSQUITO).length;
}

function plan(action, { entry, detail, host, self, times }) {
    if (!ACTIONS.has(action)) fail('RANCH_INVALID_ARGUMENT', '不支持的牧场互动');
    const hostId = positiveId(host, '好友');
    const actor = positiveId(self, '当前账号');
    if (hostId === actor) fail('RANCH_INVALID_ARGUMENT', '请选择好友牧场');
    verifyEntry(entry, hostId);
    const remaining = remainingTimes(action, times);
    const ranches = verifiedRanches(entry, detail);
    const label = action === 'placeMosquito' ? '在好友牧场放一只蚊子' : '照料好友牧场的动物';
    for (const { ranch, ranchId, facility } of ranches) {
        const proof = { host: hostId, actor, ranchId, remaining };
        let payload;
        if (action !== 'placeMosquito') {
            const target = petTarget(ranch, ranchId, actor, action === 'petDuck');
            if (!target) continue;
            proof.animalId = target.id;
            proof.species = target.species;
            proof.husbandryType = ranch.husbandry_type;
            payload = { host_gid: hostId, target: { ranch_inst_id: ranchId, animal_inst_id: target.id } };
        } else {
            if (facility.state !== 1 || ![1, 2].includes(ranch.husbandry_type)
                || facility.module_type !== ranch.husbandry_type + 5
                || facilityModules.get(facility.facility_id) !== facility.module_type) continue;
            const hazards = hazardsById(ranch.hazards);
            if (mosquitoCount(hazards) >= MOSQUITO_LIMIT) continue;
            proof.husbandryType = ranch.husbandry_type;
            proof.hazardIds = [...hazards.keys()].sort();
            payload = { ranch_inst_id: ranchId, host_gid: hostId, op_id: OP_IDS[action], count: '1' };
        }
        // The shared quote hashes friendOffers along with the encoded target.
        return { action, label, route: action, payload, count: 1, costItems: [], expectedRewards: [], friendOffers: [proof] };
    }
    return null;
}

function receiptRanch(ranches, ranchId) {
    const matches = ranches?.filter(ranch => ranch.ranch_inst_id === ranchId);
    return matches?.length === 1 ? matches[0] : null;
}

function petRewards(reply, proof) {
    const result = reply.op_result;
    const ranch = receiptRanch(reply.ranches, proof.ranchId);
    const animals = ranch?.animals?.filter(animal => animal.animal_inst_id === proof.animalId);
    const animal = animals?.length === 1 ? animals[0] : null;
    if (result?.kind !== 1 || result.target_id !== String(proof.animalId) || result.facility_inst_id !== proof.ranchId
        || !Array.isArray(result.costs) || result.costs.length !== 0 || ranch?.husbandry_type !== proof.husbandryType
        || animal?.animal_id !== proof.species || !belongsToRanch(animal, proof.ranchId)
        || !animal.mutation?.stroked_gids?.includes(proof.actor)
        || (reply.triggered === true && !(animal.mutation.mutation_type > 0))) return null;
    return result.rewards;
}

function mosquitoRewards(reply, proof, afterDetail) {
    const ranch = receiptRanch(afterDetail?.ranches, proof.ranchId);
    if (reply.actual_count !== '1' || ranch?.husbandry_type !== proof.husbandryType) return null;
    const receiptHazards = hazardsById(reply.hazards);
    const currentHazards = hazardsById(ranch.hazards);
    if (mosquitoCount(receiptHazards) > MOSQUITO_LIMIT || mosquitoCount(currentHazards) > MOSQUITO_LIMIT) return null;
    const addedByActor = hazards => [...hazards].filter(([id, hazard]) => !proof.hazardIds.includes(id)
        && hazard.hazard_type === MOSQUITO && hazard.owner === proof.actor);
    const placed = addedByActor(receiptHazards);
    const observed = addedByActor(currentHazards);
    // The receipt does not carry a host or ranch ID. The fresh detail locates the new hazard.
    if (placed.length !== 1 || observed.length !== 1 || placed[0][0] !== observed[0][0]) return null;
    return reply.rewards;
}

function verify(actionPlan, reply, afterDetail) {
    const unknown = () => fail('RANCH_RESULT_UNKNOWN', '好友牧场互动结果未确认，请刷新核对');
    const proof = actionPlan.friendOffers?.[0];
    if (!ACTIONS.has(actionPlan.action) || !proof || proof.remaining !== reply?.remaining_times) unknown();
    try {
        const rewards = actionPlan.action === 'placeMosquito' ? mosquitoRewards(reply, proof, afterDetail) : petRewards(reply, proof);
        if (Array.isArray(rewards) && rewards.every(item => decimal(item.id) !== '0' && decimal(item.count) !== '0'))
            return { completed: 1, rewards };
    } catch { /* Malformed response fields are an unknown result after dispatch. */ }
    unknown();
}

module.exports = { SCHEMA, ROUTES, ACTIONS, OP_IDS, plan, verify };
