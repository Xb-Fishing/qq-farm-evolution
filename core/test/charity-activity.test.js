const test = require('node:test');
const assert = require('node:assert/strict');

const {
  CHARITY_ACTIVITY_ID,
  CHARITY_FLOW_ACTIVITY_ID,
  CHARITY_CLIENT_UI_UID,
  CHARITY_PROTOBUF_FIELD,
  CHARITY_PLANT_ID,
  CHARITY_SEED_ITEM_ID,
  CHARITY_FRUIT_ITEM_ID,
  normalizeCharityActivity,
} = require('../src/services/activity');
function createCharitySnapshot() {
  return {
    id: 2026090900,
    parentId: 0,
    type: 1,
    title: '公益小红花',
    startTime: 1788192000,
    endTime: 1788969599,
    visible: true,
    enabled: false,
    status: 0,
    discoveryEvidence: {
      protocolShape: [
        { path: '1.2.116', wire: 2, count: 1, byteLengths: [296] },
        { path: '1.2.116.9', wire: 2, count: 5, byteLengths: [14, 13, 10, 9] },
      ],
    },
    children: [{
      id: 2026090901,
      parentId: 2026090900,
      type: 19,
      title: '公益小红花',
      startTime: 1788192000,
      endTime: 1788969599,
      visible: true,
      enabled: false,
      status: 0,
      payload: {
        uid: 'CharityRedFlower',
        tips: {
          title: '活动说明',
          txt: [
            '<b>【活动时间】</b>',
            '2026年9月1日 — 2026年9月9日',
            '用户完成每日任务或每日分享，即可获得小红花种子；在农场内种植并收获小红花果实后，可获得对应爱心值。捐赠爱心值即可为公益项目助力，点击「送出公益金」按钮，完成 1元公益助力。',
            '公益金使用限制：仅可用于支持活动内公益项目，不支持提现、兑换、转让、售卖，活动期间单用户仅可获得1次公益金资格。',
            '（1）公益礼包：活动期间每日收获小红花即可领取，礼包内含化肥（1小时） * 2，每日限领 1 次。',
            '（2）个人爱心值档位奖励：有机化肥（8 小时）*1、点券*50、有机化肥（8 小时）*2、点券*100、公益小红花做好事头像框*1。',
            '（3）全服公益结算礼包：全服达成公益目标后，满足参与条件的玩家即可领取，礼包内含化肥礼包*20、金豆豆*200、点券*300，单角色限领 1 次。',
            '公益金将在活动结束后结算，以公益金形式拨付的总金额不超过200万元。',
            "参与本活动需同意<on click='jumpUrl' param='[REDACTED]'>公益平台用户服务协议</on>并同意账号数据对接。",
            '不得以任何机器人软件、蜘蛛软件、爬虫软件、刷奖软件或其它任何自动方式参与本活动。',
          ],
        },
      },
      children: [],
    }],
  };
}

test('公益小红花按在线说明标准化流程、奖励、边界和不透明字段', () => {
  const activity = normalizeCharityActivity(createCharitySnapshot(), { nowSeconds: 1788800000 });

  assert.equal(CHARITY_ACTIVITY_ID, 2026090900);
  assert.equal(CHARITY_FLOW_ACTIVITY_ID, 2026090901);
  assert.equal(CHARITY_CLIENT_UI_UID, 'CharityRedFlower');
  assert.equal(CHARITY_PROTOBUF_FIELD, 116);
  assert.equal(CHARITY_PLANT_ID, 1020883);
  assert.equal(CHARITY_SEED_ITEM_ID, 20883);
  assert.equal(CHARITY_FRUIT_ITEM_ID, 40883);
  assert.equal(activity.uid, '');
  assert.equal(activity.uidConfirmed, false);
  assert.equal(activity.clientUiUid, 'CharityRedFlower');
  assert.equal(activity.clientUiUidConfirmed, true);
  assert.equal(activity.active, true);
  assert.equal(activity.participationEnabled, false);
  assert.equal(activity.subActivities[0].statusLabel, '活动期内 · 节点未启用');
  assert.equal(activity.subActivities[0].protocolObserved, true);
  assert.deepEqual(activity.protocol.opaqueReadOnlyFields, [116]);
  assert.equal(activity.protocol.observedShape.length, 2);
  assert.deepEqual(activity.gameplayGuides.map(item => item.key), ['seed', 'grow', 'donate', 'publicFund']);
  assert.deepEqual(activity.rewardGroups.map(item => item.key), ['daily', 'personal', 'global']);
  assert.deepEqual(activity.resources.map(item => item.name), ['小红花种子', '小红花果实', '爱心值']);
  assert.deepEqual(activity.resources.map(item => item.itemId), [20883, 40883, null]);
  assert.deepEqual(activity.resources.map(item => item.itemIdSource), [
    'current_farm_plant_mapping',
    'current_farm_plant_mapping',
    '',
  ]);
  assert.equal(activity.rewardGroups[0].items[0].count, 2);
  assert.equal(activity.rewardGroups[1].items.at(-1).name, '公益小红花做好事头像框');
  assert.deepEqual(activity.rewardGroups[2].items.map(item => item.count), [20, 200, 300]);
  assert.deepEqual(activity.notices.map(item => item.key), ['fundLimit', 'authorization', 'automation', 'settlement']);
  assert.equal(activity.manualOnly, true);
  assert.equal(activity.progressAvailable, false);
  assert.equal(activity.inventoryAvailable, false);
  assert.equal(activity.writeOperationsSupported, false);
  assert.ok(activity.gameplayGuides.every(item => item.operationSupported === false));
  assert.ok(activity.rewardGroups.every(item => item.operationSupported === false));
  assert.ok(activity.ruleLines.every(line => !line.includes('<')));
});

test('没有活动说明证据时不凭 type 19 或 field 116 猜玩法和奖励', () => {
  const snapshot = createCharitySnapshot();
  snapshot.children[0].payload.tips.txt = ['当前只有通用活动说明'];
  const activity = normalizeCharityActivity(snapshot, { nowSeconds: 1788800000 });

  assert.deepEqual(activity.gameplayGuides, []);
  assert.deepEqual(activity.rewardGroups, []);
  assert.deepEqual(activity.notices, []);
  assert.deepEqual(activity.resources, []);
  assert.equal(activity.subActivities[0].protocolObserved, true);
});
