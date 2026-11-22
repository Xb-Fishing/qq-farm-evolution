'use strict';

const protobuf = require('protobufjs');

const root = protobuf.parse(`syntax = "proto3";
message ListRequest { int32 game_scene_id = 1; }
message ListReply { repeated Node groups = 1; }
message Head {
  int64 id = 1; int64 parent_id = 2; int32 type = 3;
  string title = 4; string payload = 5;
  int64 start_time = 6; int64 end_time = 7; int32 status = 20;
}
message Item { int64 id = 1; int64 count = 2; }
message Tier { int64 id = 1; int64 threshold = 2; repeated Item rewards = 3; int32 status = 4; }
message Task {
  int64 id = 1; int64 progress = 2; int64 target = 3; int32 status = 4;
  repeated Item rewards = 5; string description = 6; int64 unlock_day = 7;
}
message Celebration { int64 total = 1; repeated Tier tiers = 2; }
message CountedFriend { int64 gid = 1; }
message Friends { repeated Tier tiers = 1; repeated CountedFriend counted = 2; }
message Handbook { repeated Task tasks = 1; int64 points = 2; repeated Tier tiers = 3; }
message Survey {
  map<int64, int64> answers = 1; int64 personality_id = 2;
  int64 settle_count = 3; bool share_reward_claimed = 4;
}
message Node {
  Head head = 1; repeated Node children = 2;
  Handbook handbook = 124; Friends friends = 125;
  Celebration celebration = 126; Survey survey = 127;
}
message ClaimRequest { int64 target = 1; }
message ClaimReply { repeated int64 claimed_ids = 1; repeated Item awards = 2; }
message SaveSurvey { map<int64, int64> answers = 1; bool clear = 2; }
message Empty {}
message SurveyResult { int64 personality_id = 1; int64 percent_bp = 2; }
message ShareRequest { string share_id = 1; }
message ShareReply { repeated Item awards = 1; }
message Operation {
  int64 id = 1; int64 cmd = 2;
  ClaimRequest task = 182; ClaimRequest handbook = 183;
  ClaimRequest friends = 184; ClaimRequest celebration = 185;
  SaveSurvey save = 186; Empty settle = 187; ShareRequest share = 189;
}
message Receipt {
  int64 id = 1; int64 cmd = 2; Node state = 3;
  ClaimReply task = 182; ClaimReply handbook = 183;
  ClaimReply friends = 184; ClaimReply celebration = 185;
  Empty save = 186; SurveyResult settle = 187; ShareReply share = 189;
}`, { keepCase: true }).root;
root.resolveAll();

function encode(name, value) {
  const type = root.lookupType(name);
  return type.encode(type.fromObject(value)).finish();
}

function decode(name, bytes) {
  const type = root.lookupType(name);
  return type.toObject(type.decode(bytes), { longs: String, arrays: true, objects: true, defaults: true });
}

function decimalKey(key) {
  return /^\d+$/.test(key) ? key : protobuf.util.longFromHash(key).toString();
}

module.exports = { encode, decode, decimalKey };
