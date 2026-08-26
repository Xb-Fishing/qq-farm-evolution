const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  STAR_ACTIVITY_ID,
  STAR_RECORD_ACTIVITY_ID,
  STAR_SHOP_ACTIVITY_ID,
  normalizeStarActivityTree,
  normalizeStarRuleData,
} = require('../src/services/activity');
const {
  STAR_ACTIVITY_UPSTREAM_CACHE_MS,
  registerAdminHeluActivityRoutes,
} = require('../src/controllers/admin-helu-activity-routes');

function createStarActivityTree() {
  const recordNode = {
    activity: {
      id: 2026072701,
      parent_id: 2026072700,
      type: 13,
      title: '千星同明',
      payload: JSON.stringify({
        uid: 'SAIJI_MEGA_EVENT',
        tips: {
          title: '活动说明',
          txt: [
            '<b>1. 星宿轮转，每日馈赠</b>',
            '活动期间，观星礼录以星宿为主线，星宿共有二十八个，逐日点亮。奖励每日投放，玩家每日可通过点亮星宿领取当日星宿馈赠。',
            '<b>【参与方式】</b>',
            '查看当日星宿事件、每日奖励和可领取状态。每日奖励开放后即可领取，点击一键领取按钮可领取已解锁的全部星宿奖励。',
            '<b>【注意事项】</b>',
            '活动结束后，将不再开放新的每日奖励。观星礼录奖励仅在当前游记周期生效，不跨活动继承。超出补领范围的奖励无法补领，请及时领取每日奖励。',
          ],
        },
      }),
      start_time: 1785290400,
      end_time: 1787846399,
      visible: true,
      enabled: false,
      status: 0,
    },
    star_record: {
      status: 1,
      opened_days: 28,
      configs: [{ id: 1, title: '角木蛟', extra: JSON.stringify({ category: '东方青龙', explain: '当日星宿事件' }) }],
      records: [{ id: 1, unlocked: true, claimed: false, rewards: [{ id: 1023, count: 10 }] }],
    },
    children: [],
  };
  const shopNode = {
    activity: {
      id: 2026072702,
      parent_id: 2026072700,
      type: 3,
      title: '千星同明',
      start_time: 1785290400,
      end_time: 1787846399,
      visible: true,
      enabled: false,
      status: 0,
    },
    exchange_shop: {
      items: [{
        id: 30,
        name: '萤火星房小屋',
        item: { id: 201008, count: 1 },
        cost: { id: 1023, count: 4000 },
        status: 1,
        owned: true,
        sort: 1,
      }],
    },
    children: [],
  };
  const rootNode = {
    activity: {
      id: 2026072700,
      parent_id: 0,
      type: 1,
      title: '心许千灯星垂野',
      start_time: 1785290400,
      end_time: 1787846399,
      visible: true,
      enabled: false,
      status: 0,
    },
    children: [recordNode, shopNode],
  };
  return { rootNode, recordNode, shopNode };
}

test('千星活动按在线说明标准化每日星宿流程、补领边界和只读节点', () => {
  const tree = createStarActivityTree();
  const activity = normalizeStarActivityTree(
    tree.rootNode,
    tree.recordNode,
    tree.shopNode,
    { nowSeconds: 1787709600 },
  );

  assert.equal(activity.activityId, STAR_ACTIVITY_ID);
  assert.equal(activity.uid, 'SAIJI_MEGA_EVENT');
  assert.equal(activity.uidConfirmed, true);
  assert.equal(activity.inActivityWindow, true);
  assert.deepEqual(activity.subActivities.map(item => item.id), [
    STAR_RECORD_ACTIVITY_ID,
    STAR_SHOP_ACTIVITY_ID,
  ]);
  assert.deepEqual(activity.subActivities.map(item => item.protobufField), [110, 102]);
  assert.ok(activity.subActivities.every(item => item.protocolObserved));
  assert.deepEqual(activity.gameplayGuides.map(item => item.key), ['daily', 'claim']);
  assert.ok(activity.gameplayGuides.every(item => item.source === 'activity_rules'));
  assert.ok(activity.gameplayGuides.every(item => item.operationSupported === false));
  assert.match(activity.gameplayGuides[0].steps.join(' '), /二十八星宿.*按日/);
  assert.match(activity.gameplayGuides[1].steps.join(' '), /每日奖励.*一键领取/);
  assert.equal(activity.ruleWarnings.length, 1);
  assert.match(activity.ruleWarnings[0], /不跨活动继承.*无法补领/);
  assert.equal(activity.writeOperationsDerivedFromRules, false);
  assert.equal(activity.starRecord.claimableCount, 1);
  assert.equal(activity.exchangeShop[0].currencyName, '星砂');
  assert.equal(activity.exchangeShop[0].price, 4000);
});

test('千星活动没有说明证据时不凭 type 或 protobuf 字段猜玩法', () => {
  const { recordNode } = createStarActivityTree();
  recordNode.activity.payload = JSON.stringify({ uid: 'SAIJI_MEGA_EVENT', tips: { txt: ['普通活动说明'] } });
  const rules = normalizeStarRuleData(recordNode);
  assert.deepEqual(rules.gameplayGuides, []);
  assert.deepEqual(rules.ruleWarnings, []);
});

test('千星管理读取缓存合并页面刷新，写操作后清除旧状态', async () => {
  const routes = new Map();
  let upstreamReads = 0;
  const activity = normalizeStarActivityTree(...Object.values(createStarActivityTree()));
  registerAdminHeluActivityRoutes({
    app: {
      get: (route, handler) => routes.set(`GET ${route}`, handler),
      post: (route, handler) => routes.set(`POST ${route}`, handler),
    },
    provider: {
      getStatus: () => ({ connection: { connected: true } }),
      getStarActivity: async () => {
        upstreamReads += 1;
        return activity;
      },
      claimStarRecordRewards: async () => ({ ok: true, recordIds: [1], activity }),
    },
    getAccountIdFromRequest: () => 'account-A',
    canAccessAccount: () => true,
    sendProviderError: (_res, error) => { throw error; },
  });

  const response = () => {
    const state = { body: null, statusCode: 200 };
    return {
      state,
      json: body => { state.body = body; },
      status: (statusCode) => {
        state.statusCode = statusCode;
        return { json: body => { state.body = body; } };
      },
    };
  };

  let res = response();
  await routes.get('GET /api/activity/star')({}, res);
  assert.equal(res.state.body.upstreamCached, false);
  res = response();
  await routes.get('GET /api/activity/star')({}, res);
  assert.equal(res.state.body.upstreamCached, true);
  assert.equal(res.state.body.upstreamCacheMs, STAR_ACTIVITY_UPSTREAM_CACHE_MS);
  assert.equal(upstreamReads, 1);

  await routes.get('POST /api/activity/star/records/claim')({ body: {} }, response());
  res = response();
  await routes.get('GET /api/activity/star')({}, res);
  assert.equal(res.state.body.upstreamCached, false);
  assert.equal(upstreamReads, 2);
});

test('千星只读状态使用 List 验证后的 GetGroup，专属 UI 与扫描面板覆盖说明玩法', () => {
  const serviceSource = fs.readFileSync(path.join(__dirname, '../src/services/activity.js'), 'utf8');
  const getStarStart = serviceSource.indexOf('async function getStarActivity()');
  const getStarEnd = serviceSource.indexOf('async function claimStarRecordRewards()', getStarStart);
  const getStarSource = serviceSource.slice(getStarStart, getStarEnd);
  const panelSource = fs.readFileSync(path.join(__dirname, '../../web/src/components/activity/StarRecordPanel.vue'), 'utf8');
  const scanSource = fs.readFileSync(path.join(__dirname, '../../web/src/components/admin/AdminActivityUpdatePanel.vue'), 'utf8');

  assert.match(getStarSource, /listActivityGroups\(\)/);
  assert.match(getStarSource, /getActivityGroup\(/);
  assert.doesNotMatch(getStarSource, /operateActivityReply\(/);
  assert.doesNotMatch(serviceSource, /STAR_SHOP_OPEN_CMD/);
  assert.match(panelSource, /观星礼录玩法流程/);
  assert.match(panelSource, /补领与周期边界/);
  assert.match(panelSource, /协议节点（诊断信息）/);
  assert.match(panelSource, /1 分钟内重复刷新复用本地结果/);
  assert.match(scanSource, /星宿轮转与每日馈赠/);
  assert.match(scanSource, /游记周期与补领边界/);
});
