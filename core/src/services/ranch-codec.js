'use strict';

const protobuf = require('protobufjs');
const social = require('./ranch-social');
const handbook = require('./ranch-handbook');
const cans = require('./ranch-task-cans');

// A separate protobuf root keeps scene 2 wire definitions separate from the farm codec.
// Proto3 scalar defaults are explicit: absent booleans decode as false, int64
// values as decimal strings, int32 values as 0, repeated values as empty arrays.
const schema = `syntax = "proto3";
message PlayerSceneLoginRequest {
    int32 global_scene_id = 1;
    repeated string experiment_keys = 2;
}
message PlayerSceneLoginReply {
    int32 global_scene_id = 1;
    int64 server_time = 2;
    
    bytes farm_scene_ext_data = 10;
    bytes big_farm_scene_ext_data = 11;
}
message AnimalRef {
    int64 ranch_inst_id = 1;
    int32 animal_inst_id = 2;
}
message ShelfRef {
    int64 ranch_inst_id = 1;
    int32 slot_index = 2;
}
message EnterHomesteadRequest { int64 host_gid = 1; int32 reason = 2; }
message RanchFriendBasic { int64 gid = 1; string name = 2; }
message EnterHomesteadReply {
    RanchFriendBasic basic = 1;
    bool is_tourist = 6;
    AllCellsReply homestead_cells = 8;
}
message LeaveHomesteadRequest { int64 host_gid = 1; }
message LeaveHomesteadReply {}
message GetRanchDetailRequest {
    int64 host_gid = 1;
    repeated int64 ranch_inst_ids = 2;
}
message GetRanchDetailReply {
    repeated RanchDetail ranches = 1;
    int64 interval = 2;
}
message StealProduceRequest { int64 host_gid = 1; repeated ShelfRef targets = 2; }
message StealProduceReply {
    repeated RanchDetail ranches = 1;
    repeated FacilityOpResult op_results = 4;
}
message RanchDetail {
    int64 ranch_inst_id = 1;
    int32 capacity = 2;
    int32 animal_count = 3;
    repeated AnimalDetail animals = 4;
    GrassInfo grass = 5;
    int32 husbandry_type = 6;
    repeated ShelfDetail shelves = 7;
    repeated RanchHazardView hazards = 8;
}
message AnimalDetail {
    int64 ranch_inst_id = 1;
    int32 slot_index = 2;
    int32 animal_inst_id = 3;
    int64 animal_id = 4;
    int32 stage = 5;
    int32 produce_count = 6;
    bool can_harvest = 7;
    int64 grow_ready_at_ms = 10;
    int64 produce_ready_at_ms = 11;
    bool grass_blocked = 12;
    int64 infant_ready_at_ms = 14;
    bool producing = 15;
    bool can_deliver = 16;
    int64 delivering_until_ms = 17;
    bool can_feed = 18;
    bool limited_can_used = 19;
    bool can_donate = 20;
    int64 expected_harvest_exp = 21;
    repeated ItemEntry expected_harvest_sells = 22;
    int64 expected_produce_exp = 23;
    repeated ItemEntry expected_produce_sells = 24;
    int64 mature_ready_at_ms = 25;
    AnimalMutationView mutation = 30;
}
message AnimalMutationView {
    int32 mutation_type = 1;
    int32 source = 2;
    int32 weight_display_x10 = 3;
    int32 scale_bp = 4;
    int32 weight_final_x10 = 5;
    int32 tier = 6;
    int64 became_at_ms = 7;
    bool strokable = 8;
    repeated int64 stroked_gids = 9;
}
message ProductLotDetail {
    int64 item_id = 1;
    int64 base_num = 2;
    int64 remain_num = 3;
    int64 stolen_num = 4;
    int64 animal_id = 5;
    bool can_steal = 6;
    repeated int64 stealers = 7;
}
message ShelfDetail {
    int32 slot_index = 1;
    repeated ProductLotDetail lots = 2;
    int64 total_remain = 3;
    bool can_collect = 4;
    bool can_steal = 5;
}
message GrassInfo {
    int64 amount = 1;
    int64 empty_at_ms = 2;
}
message PlaceAnimalItem {
    int64 ranch_inst_id = 1;
    int64 animal_id = 2;
    int64 giant_cub_item_id = 3;
}
message PlaceAnimalRequest {
    repeated PlaceAnimalItem items = 1;
}
message PlaceAnimalReply {
    repeated RanchDetail ranches = 1;
    repeated FacilityOpResult op_results = 3;
}
message TriggerProduceRequest {
    int64 host_gid = 1;
    repeated AnimalRef targets = 2;
}
message TriggerProduceReply {
    repeated RanchDetail ranches = 1;
    repeated FacilityOpResult op_results = 3;
}
message HarvestRanchRequest {
    repeated int64 ranch_inst_ids = 2;
    int32 op = 3;
    repeated AnimalRef animals = 4;
    repeated ShelfRef shelves = 5;
}
message HarvestRanchReply {
    repeated RanchDetail ranches = 1;
    repeated FacilityOpResult op_results = 5;
    repeated GiantShareView giant_shares = 6;
}
message GiantShareView {
    int64 animal_id = 1;
    int32 weight_x10 = 2;
    int32 tier = 3;
}
message RanchHazardView {
    int64 hazard_id = 1;
    int64 owner = 2;
    int32 hazard_type = 3;
}
message CleanAllRanchRequest {
    int64 host_gid = 1;
    repeated int64 ranch_inst_ids = 2;
}
message CleanAllRanchReply {
    repeated RanchDetail ranches = 1;
    repeated FacilityOpResult op_results = 2;
}
message CellInfo {
    int64 cell_id = 1;
    int32 grid_x = 2;
    int32 grid_y = 3;
    int32 status = 4;
    int64 occupied_by = 5;
    int32 region_id = 6;
    repeated Item unlock_need = 7;
    int64 unlock_end_time = 10;
    int32 unlock_secs = 11;
    bool can_share_unlock = 12;
    repeated Item share_cost = 13;
}
message FacilityInfo {
    int64 instance_id = 1;
    int32 facility_id = 2;
    int32 module_type = 3;
    int32 position_x = 4;
    int32 position_y = 5;
    int32 rotation = 6;
    int32 level = 7;
    int32 width = 8;
    int32 height = 9;
    int32 capacity = 10;
    repeated int64 occupied_cell_ids = 11;
    RanchDetail ranch = 20;
    FeedMachineDetail feed_machine = 21;
    bytes order_board = 22;
    int32 state = 12;
    int32 upgrade_state = 13;
    int64 upgrade_end_time = 14;
}
message AllCellsRequest {

}
message AllCellsReply {
    int32 grid_width = 1;
    int32 grid_height = 2;
    repeated CellInfo cells = 3;
    repeated FacilityInfo facilities = 4;
    repeated BuildingItemInfo building_items = 5;
    bool has_ready_upgrade = 6;
    int32 region_occupied_count = 7;
    int32 region_quota_count = 8;
    SpeedUpInfo region_speed_up = 9;
}
message FacilityDetailInfo {
    int64 instance_id = 1;
    string name = 2;
    string description = 3;
    int32 base_facility_id = 4;
    int32 module_type = 5;
    repeated Item upgrade_cost = 6;
    int32 level = 7;
    int32 facility_id = 8;
    int32 position_x = 9;
    int32 position_y = 10;
    int32 rotation = 11;
    int32 width = 12;
    int32 height = 13;
    int32 capacity = 14;
    RanchDetail ranch = 20;
    FeedMachineDetail feed_machine = 21;
    bytes order_board = 22;
    EmptyFacilityDetail empty_detail = 99;
}
message EmptyFacilityDetail {
}
message GetFacilityDetailRequest {
    int64 instance_id = 1;
    int64 host_gid = 2;
}
message GetFacilityDetailReply {
    FacilityDetailInfo info = 1;
}
message BuildingUpgradeInfo {
    int64 inst_id = 1;
    int32 state = 2;
    int64 end_time = 3;
    int32 target_facility_id = 4;
    int32 target_level = 5;
}
message UpgradeBuildingRequest {
    int64 inst_id = 1;
}
message UpgradeBuildingReply {
    BuildingUpgradeInfo upgrade = 1;
}
message CompleteBuildingUpgradeRequest {
    int64 inst_id = 1;
}
message CompleteBuildingUpgradeReply {
    FacilityInfo facility = 1;
    BuildingItemInfo item = 2;
}
message FeedMachineDetail {
    int32 feed_count = 1;
    int32 consume_rate = 2;
    int64 remaining_secs = 4;
    bool is_owner = 7;
    int32 status = 8;
}
message AddFeedRequest {
    int64 instance_id = 1;
    int32 add_count = 2;
    bool use_gold = 3;
    int64 host_gid = 4;
}
message AddFeedReply {
    FeedMachineDetail detail = 1;
    repeated Item consumed = 2;
}
message BuildingItemInfo {
    int64 inst_id = 1;
    int32 facility_id = 2;
    int32 level = 3;
    int32 upgrade_state = 5;
    int64 upgrade_end_time = 6;
    int64 added_at = 7;
    bool is_new = 8;
}
message SpeedUpInfo {
    int64 item_id = 1;
    int64 own_count = 2;
    int32 secs_per_item = 3;
}
message Item {
    int64 id = 1;
    int64 count = 2;
    int64 expire_time = 3;
    int64 uid = 6;
    bool is_new = 7;
    repeated int64 mutant_types = 8;
    bool is_locked = 9;
    bytes gift_detail = 10;
    ItemDetail item_detail = 11;
    int64 tab_id = 12;
    ItemShow show = 100;
}
message ItemShow {
    repeated SellCond sell_cond = 3;
    repeated ItemEntry sells = 4;
    repeated ItemEntry cond_sells = 5;
}
message ItemDetail {
    bytes weather_wood = 1;
    ItemRanchProduct ranch_product = 2;
}
message ItemRanchProduct {
    int64 src_item_id = 1;
    int64 src_animal_id = 2;
    int32 weight_x10 = 3;
    int32 tier = 4;
    int64 price_rate = 5;
    int64 base_point = 6;
}
message ItemEntry {
    int64 id = 1;
    int64 count = 2;
}
message SellCond {
    string type = 1;
    string params = 2;
}
message GetBagRequest {
    int32 global_scene_id = 1;
    int64 tab_id = 2;
}
message GetBagReply {
    repeated Item physical_items = 1;
    repeated Item virtual_items = 2;
    int64 max_grid_num = 3;
    int64 curr_grid_num = 4;
    int32 global_scene_id = 5;
}
message SellRequest {
    repeated Item items = 1;
}
message SellReply {
    repeated Item sell_items = 1;
    repeated Item get_items = 2;
}
message SceneData {
    AllCellsReply homestead_cells = 2;
}
message FacilityOpResult {
    int64 facility_inst_id = 1;
    int32 kind = 2;
    int64 target_id = 3;
    repeated Item rewards = 10;
    repeated Item costs = 11;
}
message ShopProfile {
    int64 shop_id = 1;      
    string shop_name = 2;   
    int32 shop_type = 3;    
    repeated int32 global_scene_ids = 4;
    bool is_rotation_shop = 5;
    bytes rotation_state = 6;
}
message GoodsInfo {
    int64 id = 1;              
    int64 bought_num = 2;      
    int64 price = 3;           
    int64 limit_count = 4;     
    bool unlocked = 5;         
    int64 item_id = 6;         
    int64 item_count = 7;      
    repeated Cond conds = 8;   
    bool is_display_countdown = 9;
    int64 end_time = 10;
    int64 discount_price = 11; 
    int64 discount_start_time = 12;
    int64 discount_end_time = 13;
    repeated ShowCond show_conds = 14;
    bool owned = 15;           
}
message ShowCond {
    string type = 1;
    string params = 2;
}
message Cond {
    int32 type = 1;    
    int64 param = 2;   
}
message ShopProfilesRequest {
    int32 global_scene_id = 1;
}
message ShopProfilesReply {
    repeated ShopProfile shop_profiles = 1;
}
message ShopInfoRequest {
    int64 shop_id = 1;
}
message ShopInfoReply {
    repeated GoodsInfo goods_list = 1;
}
message BuyGoodsRequest {
    int64 goods_id = 1;   
    int64 num = 2;        
    int64 price = 3;      
    bool auto_add = 4;
}
message BuyGoodsReply {
    GoodsInfo goods = 1;                  
    repeated Item get_items = 2;   
    repeated Item cost_items = 3;  
}
message RanchMallListRequest {
    int32 slot_type = 1;
    bool is_manual_open = 2;
    int32 global_scene_id = 3;
}
message RanchMallListReply {
    repeated RanchMallGoods goods_list = 1;
}
message RanchMallGoods {
    int64 goods_id = 1;
    string name = 2;
    int32 goods_type = 3;
    repeated RanchMallItem reward_items = 4;
    RanchMallPrice price = 5;
    bool is_free = 6;
    RanchMallPurchaseLimit purchase_limit = 7;
    bool is_available = 8;
    bool ad_only = 18;
    bool share_only = 19;
    bool is_owned = 20;
}
message RanchMallItem {
    int64 id = 1;
    int64 count = 2;
}
message RanchMallPrice {
    int64 id = 1;
    optional int64 count = 2;
}
message RanchMallPurchaseLimit {
    int32 type = 1;
    int64 bought_count = 2;
    int64 limit_count = 3;
    bool share_only = 4;
}
message RanchMallPurchaseRequest {
    int64 goods_id = 1;
    int64 count = 2;
}
message RanchMallPurchaseReply {
    int64 goods_id = 1;
    bool success = 2;
    repeated RanchMallItem reward_items = 3;
    bool is_first_buy = 4;
    RanchMallPurchaseLimit purchase_limit = 5;
}
message Task {
    repeated Item extra_rewards = 14;
    int64 id = 1;                    
    int64 progress = 2;              
    bool is_claimed = 3;             
    bool is_unlocked = 4;            
    repeated Item rewards = 5; 
    int64 total_progress = 6;        
    int64 share_multiple = 7;        
    repeated string params = 8;      
    string desc = 9;                 
    int32 task_type = 10;            
    int64 group = 11;                
    int64 cond_type = 12;            
    int64 is_show_text = 13;         
}
message ActiveReward {
    int64 point_id = 1;              
    int64 need_progress = 2;         
    int32 status = 3;                
    repeated Item rewards = 4; 
}
message Active {
    int32 type = 1;                       
    int64 progress = 2;                   
    repeated ActiveReward rewards = 3;    
}
message TaskInfo {
    repeated Task growth_tasks = 1;  
    repeated Task daily_tasks = 2;   
    repeated Task tasks = 3;         
    repeated Active actives = 4;     
}
message TaskInfoRequest {
    int32 global_scene_id = 1;
}
message TaskInfoReply {
    TaskInfo task_info = 1;
}
message ClaimTaskRewardRequest {
    int64 id = 1;           
    bool do_shared = 2;     
}
message ClaimTaskRewardReply {
    repeated Item items = 1;              
    TaskInfo task_info = 2;                      
    repeated Item compensated_items = 3;  
}
message BatchClaimTaskRewardRequest {
    repeated int64 ids = 1;  
    bool do_shared = 2;      
}
message BatchClaimTaskRewardReply {
    repeated Item items = 1;
    TaskInfo task_info = 2;
    repeated Item compensated_items = 3;
}
${social.SCHEMA}
${handbook.SCHEMA}
${cans.SCHEMA}`;
const root = protobuf.parse(schema, { keepCase: true }).root;
root.resolveAll();
const types = Object.freeze(Object.fromEntries(Object.entries(root.nested).filter(([, value]) => value instanceof protobuf.Type)));
const ROUTES = Object.freeze({
    ...social.ROUTES,
    ...handbook.ROUTES,
    ...cans.ROUTES,
    "enterFriend": { service: 'gamepb.visitpb.VisitService', method: 'EnterHomestead', request: 'EnterHomesteadRequest', reply: 'EnterHomesteadReply', writing: false },
    "leaveFriend": { service: 'gamepb.visitpb.VisitService', method: 'LeaveHomestead', request: 'LeaveHomesteadRequest', reply: 'LeaveHomesteadReply', writing: false },
    "friendDetail": { service: 'gamepb.animalpb.AnimalService', method: 'GetRanchDetail', request: 'GetRanchDetailRequest', reply: 'GetRanchDetailReply', writing: false },
    "stealFriend": { service: 'gamepb.animalpb.AnimalService', method: 'StealProduce', request: 'StealProduceRequest', reply: 'StealProduceReply', writing: true },
    "sceneLogin": {
        "service": "gamepb.globalscenepb.GlobalSceneService",
        "method": "PlayerSceneLogin",
        "request": "PlayerSceneLoginRequest",
        "reply": "PlayerSceneLoginReply",
        "writing": false
    },
    "cells": {
        "service": "gamepb.homesteadpb.HomesteadService",
        "method": "AllCells",
        "request": "AllCellsRequest",
        "reply": "AllCellsReply",
        "writing": false
    },
    "facilityDetail": {
        "service": "gamepb.homesteadpb.HomesteadService",
        "method": "GetFacilityDetail",
        "request": "GetFacilityDetailRequest",
        "reply": "GetFacilityDetailReply",
        "writing": false
    },
    "upgrade": {
        "service": "gamepb.homesteadpb.HomesteadService",
        "method": "UpgradeBuilding",
        "request": "UpgradeBuildingRequest",
        "reply": "UpgradeBuildingReply",
        "writing": true
    },
    "completeUpgrade": {
        "service": "gamepb.homesteadpb.HomesteadService",
        "method": "CompleteBuildingUpgrade",
        "request": "CompleteBuildingUpgradeRequest",
        "reply": "CompleteBuildingUpgradeReply",
        "writing": true
    },
    "bag": {
        "service": "gamepb.itempb.ItemService",
        "method": "GetBag",
        "request": "GetBagRequest",
        "reply": "GetBagReply",
        "writing": false
    },
    "sell": {
        "service": "gamepb.itempb.ItemService",
        "method": "Sell",
        "request": "SellRequest",
        "reply": "SellReply",
        "writing": true
    },
    "shopProfiles": {
        "service": "gamepb.shoppb.ShopService",
        "method": "ShopProfiles",
        "request": "ShopProfilesRequest",
        "reply": "ShopProfilesReply",
        "writing": false
    },
    "shop": {
        "service": "gamepb.shoppb.ShopService",
        "method": "ShopInfo",
        "request": "ShopInfoRequest",
        "reply": "ShopInfoReply",
        "writing": false
    },
    "mallGift": {
        "service": "gamepb.mallpb.MallService",
        "method": "GetMallListBySlotType",
        "request": "RanchMallListRequest",
        "reply": "RanchMallListReply",
        "writing": false
    },
    "claimMallGift": {
        "service": "gamepb.mallpb.MallService",
        "method": "Purchase",
        "request": "RanchMallPurchaseRequest",
        "reply": "RanchMallPurchaseReply",
        "writing": true
    },
    "buy": {
        "service": "gamepb.shoppb.ShopService",
        "method": "BuyGoods",
        "request": "BuyGoodsRequest",
        "reply": "BuyGoodsReply",
        "writing": true
    },
    "place": {
        "service": "gamepb.animalpb.AnimalService",
        "method": "PlaceAnimal",
        "request": "PlaceAnimalRequest",
        "reply": "PlaceAnimalReply",
        "writing": true
    },
    "addGrass": {
        "service": "gamepb.homesteadpb.FeedMachineService",
        "method": "AddFeed",
        "request": "AddFeedRequest",
        "reply": "AddFeedReply",
        "writing": true
    },
    "produce": {
        "service": "gamepb.animalpb.AnimalService",
        "method": "TriggerProduce",
        "request": "TriggerProduceRequest",
        "reply": "TriggerProduceReply",
        "writing": true
    },
    "harvest": {
        "service": "gamepb.animalpb.AnimalService",
        "method": "HarvestRanch",
        "request": "HarvestRanchRequest",
        "reply": "HarvestRanchReply",
        "writing": true
    },
    "clean": {
        "service": "gamepb.animalpb.RanchService",
        "method": "CleanAllRanch",
        "request": "CleanAllRanchRequest",
        "reply": "CleanAllRanchReply",
        "writing": true
    },
    "tasks": {
        "service": "gamepb.taskpb.TaskService",
        "method": "TaskInfo",
        "request": "TaskInfoRequest",
        "reply": "TaskInfoReply",
        "writing": false
    },
    "claimTask": {
        "service": "gamepb.taskpb.TaskService",
        "method": "ClaimTaskReward",
        "request": "ClaimTaskRewardRequest",
        "reply": "ClaimTaskRewardReply",
        "writing": true
    },
    "claimTasks": {
        "service": "gamepb.taskpb.TaskService",
        "method": "BatchClaimTaskReward",
        "request": "BatchClaimTaskRewardRequest",
        "reply": "BatchClaimTaskRewardReply",
        "writing": true
    }
});

function typeFor(name) {
    const type = types[name];
    if (!type) throw new Error(`Unknown ranch message: ${name}`);
    return type;
}

function checkInput(type, value) {
    if (!value || typeof value !== 'object') throw new TypeError('Message object required');
    for (const [key, input] of Object.entries(value)) {
        const field = type.fields[key];
        if (!field) throw new TypeError(`Unknown field ${type.name}.${key}`);
        const entries = field.repeated ? input : [input];
        if (!Array.isArray(entries)) throw new TypeError(`Array required: ${key}`);
        for (const entry of entries) {
            if (field.resolvedType instanceof protobuf.Type) checkInput(field.resolvedType, entry);
            else if (field.type === 'int64') {
                if (typeof entry === 'number' && !Number.isSafeInteger(entry)) throw new TypeError(`Unsafe integer: ${key}`);
                const str = typeof entry === 'bigint' ? entry.toString() : String(entry);
                if (!/^-?\d+$/.test(str) || BigInt(str) < -(1n << 63n) || BigInt(str) > (1n << 63n) - 1n) throw new TypeError(`Invalid int64: ${key}`);
            } else if (field.type === 'int32' && (!Number.isInteger(entry) || entry < -2147483648 || entry > 2147483647)) throw new TypeError(`Invalid int32: ${key}`);
            else if (field.type === 'bool' && typeof entry !== 'boolean') throw new TypeError(`Invalid bool: ${key}`);
        }
    }
}

function encode(name, input = {}) {
    const type = typeFor(name);
    checkInput(type, input);
    // fromObject accepts decimal strings without losing int64 precision.
    const plain = value => {
        if (typeof value === 'bigint') return value.toString();
        if (Buffer.isBuffer(value) || value instanceof Uint8Array) return Buffer.from(value);
        if (Array.isArray(value)) return value.map(plain);
        if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, plain(item)]));
        return value;
    };
    const object = plain(input);
    const message = type.fromObject(object);
    const error = type.verify(message);
    if (error) throw new TypeError(error);
    return type.encode(message).finish();
}

function decode(name, bytes) {
    const type = typeFor(name);
    return type.toObject(type.decode(bytes), { longs: String, defaults: true, arrays: true, objects: true, bytes: Buffer });
}

module.exports = { types, encode, decode, ROUTES };
