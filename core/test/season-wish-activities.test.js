const test = require('node:test');
const assert = require('node:assert/strict');
const activityService = require('../src/services/activity');
const {
  WISH_ACTIVITY_ID, WISH_SIGN_ACTIVITY_ID, HAPPY_SHARE_ACTIVITY_ID, HAPPY_SHARE_PLAY_ACTIVITY_ID,
  normalizeWishActivity, normalizeHappyShareActivity, getWishActivity, getHappyShareActivity,
} = activityService;
const { registerAdminSeasonActivityRoutes } = require('../src/controllers/admin-season-activity-routes');

const WISH_SNAPSHOT = {
  id: 2026092400, title: '秋祈良愿', startTime: 1790179200, endTime: 1791388799,
  visible: true, enabled: false, status: 0,
  children: [{
    id: 2026092401, parentId: 2026092400, type: 21, title: '秋祈良愿',
    startTime: 1790179200, endTime: 1791388799, visible: true, enabled: false, status: 20,
    payload: {
      uid: 'WishSignMainUI',
      tips: {
        title: '活动说明',
        txt: [
          '<b>【活动时间】</b>',
          '2026年9月24日 — 2026年10月7日',
          '<b>【活动简介】</b>',
          '1. 在9月24日 — 10月7日期间，农场主可在活动主界面祈愿，每日0点刷新。',
          '2. 祈愿可领取当日好运奖励，奖励内容包括2种限定种子、烟花互动道具和盆栽装扮。',
          '3. 活动期间，农场主若因农事繁忙错过祈愿，秋日之神会给农场主存储5日奖励（包括当天）。',
          '4. 农场主未成功领取的奖励，在第二天或活动结束后，会通过邮件补发。',
          '5. 祈愿签文仅作趣味参考，愿农场主所求皆如愿。',
        ],
      },
    },
  }],
  discoveryEvidence: {
    protocolShape: [
      { path: '1.2.119', wire: 2, count: 1, byteLengths: [4] },
      { path: '1.2.119.1', wire: 0, count: 1, byteLengths: [] },
      { path: '1.2.119.2', wire: 0, count: 1, byteLengths: [] },
      { path: '1.2.1.4', wire: 2, count: 1, byteLengths: [12] },
    ],
  },
};

const SHARE_SNAPSHOT = {
  id: 2026092500, title: '快乐不独享', startTime: 1790179200, endTime: 1791820799,
  visible: true, enabled: false, status: 0,
  children: [{
    id: 2026092501, parentId: 2026092500, type: 24, title: '快乐不独享',
    startTime: 1790179200, endTime: 1791820799, visible: true, enabled: false, status: 0,
    payload: {
      uid: 'HappySharePanel',
      tips: {
        title: '活动说明',
        txt: [
          '<b>【活动时间】</b>',
          '2026年9月24日 — 2026年10月12日',
          '<b>【活动简介】</b>',
          '1. 在9月24日 — 10月12日期间，农场主参与活动可拿快乐值。',
          '2. 快乐值有三种获取方式：每日在活动主界面领取，每日首次从活动主界面分享，每日点击好友分享的快乐包链接，以上内容每日0点刷新次数。',
          '3. 拿到一定快乐值可领取档位奖励，稚萌熊熊在向农场主招手哟。',
        ],
      },
    },
  }],
  discoveryEvidence: {
    protocolShape: [
      { path: '1.2.120', wire: 2, count: 1, byteLengths: [83] },
      { path: '1.2.120.1', wire: 2, count: 1, byteLengths: [81] },
    ],
  },
};

test('秋祈良愿说明转换为四个玩法指南，全部只读、未开始状态不伪造', () => {
  const activity = normalizeWishActivity(WISH_SNAPSHOT, { nowSeconds: 1790000000 });
  assert.deepEqual(activity.gameplayGuides.map(item => item.key), ['daily', 'rewards', 'storage', 'mail']);
  assert.ok(activity.gameplayGuides.every(item => item.operationSupported === false && item.statusAvailable === false));
  assert.ok(activity.gameplayGuides.every(item => item.evidence));
  assert.equal(activity.statusLabel, '未开始');
  assert.equal(activity.clientUiUid, 'WishSignMainUI');
  assert.equal(activity.uid, '');
  assert.equal(activity.uidConfirmed, false);
  assert.equal(activity.writeOperationsSupported, false);
  assert.deepEqual(activity.protocol.opaqueReadOnlyFields, [119]);
  assert.equal(activity.subActivities[0].protobufField, 119);
  assert.equal(activity.subActivities[0].protocolObserved, true);
  // 未声明字段只保留形状诊断：1.2.1.4 不属于 field 119，不进入观测清单。
  assert.ok(activity.protocol.observedShape.every(entry => entry.path.startsWith('1.2.119')));
  assert.match(activity.notices.join(' '), /签文仅作趣味参考/);
  assert.ok(activity.missingEvidence.some(item => /不改 EventPlants/.test(item)));
});

test('快乐不独享说明转换为三途径与档位指南，分享玩法不模拟', () => {
  const activity = normalizeHappyShareActivity(SHARE_SNAPSHOT, { nowSeconds: 1790000000 });
  assert.deepEqual(activity.gameplayGuides.map(item => item.key), ['daily-claim', 'daily-share', 'friend-link', 'tier-rewards']);
  assert.ok(activity.gameplayGuides.every(item => item.operationSupported === false));
  assert.equal(activity.clientUiUid, 'HappySharePanel');
  assert.deepEqual(activity.protocol.opaqueReadOnlyFields, [120]);
  assert.equal(activity.subActivities[0].protocolObserved, true);
  assert.ok(activity.missingEvidence.some(item => /不模拟分享/.test(item)));
  assert.deepEqual(activity.notices, []);
});

test('两组活动没有说明时不按 type、UID 或字段形状编造玩法', () => {
  const wish = normalizeWishActivity({ id: WISH_ACTIVITY_ID, children: [{ id: WISH_SIGN_ACTIVITY_ID, payload: { uid: 'WishSignMainUI' } }] });
  const share = normalizeHappyShareActivity({ id: HAPPY_SHARE_ACTIVITY_ID, children: [{ id: HAPPY_SHARE_PLAY_ACTIVITY_ID }] });
  assert.deepEqual(wish.gameplayGuides, []);
  assert.deepEqual(wish.notices, []);
  assert.deepEqual(share.gameplayGuides, []);
  assert.equal(wish.subActivities[0].protocolObserved, false);
  assert.equal(wish.writeOperationsSupported, false);
  assert.equal(share.writeOperationsSupported, false);
});

test('读取仅信 List 下发的根节点：缺根不发详情请求，快照不匹配立即停止', async () => {
  const calls = [];
  const listReader = async () => calls.push('list') && [];
  const snapshotReader = async (id, uid) => calls.push(['snapshot', id, uid]);
  await assert.rejects(
    getWishActivity({ getActivityDiscoveryList: listReader, getActivityGroupSnapshot: snapshotReader }),
    /未由当前 ActivityService.List 下发/,
  );
  await assert.rejects(
    getHappyShareActivity({ getActivityDiscoveryList: listReader, getActivityGroupSnapshot: snapshotReader }),
    /未由当前 ActivityService.List 下发/,
  );
  assert.deepEqual(calls, ['list', 'list']);

  // 根在列表但快照组不匹配：仍不发后续请求。
  const listWithRoot = async () => [{ id: WISH_ACTIVITY_ID, parentId: 0 }];
  const mismatchSnapshot = async () => calls.push('snapshot') && { id: 1 };
  await assert.rejects(
    getWishActivity({ getActivityDiscoveryList: listWithRoot, getActivityGroupSnapshot: mismatchSnapshot }),
    /活动组不匹配/,
  );
  assert.equal(calls.filter(item => item === 'snapshot').length, 1);
});

test('正常读取使用空活动组 UID 并产出玩法指南，不引入背包或子节点请求', async () => {
  const calls = [];
  const listWithRoot = async () => [{ id: HAPPY_SHARE_ACTIVITY_ID, parentId: 0 }];
  const snapshotReader = async (id, uid) => {
    calls.push(['snapshot', id, uid]);
    return JSON.parse(JSON.stringify(SHARE_SNAPSHOT));
  };
  const activity = await getHappyShareActivity({
    getActivityDiscoveryList: listWithRoot,
    getActivityGroupSnapshot: snapshotReader,
  });
  assert.deepEqual(calls, [['snapshot', HAPPY_SHARE_ACTIVITY_ID, '']]);
  assert.equal(activity.activityId, HAPPY_SHARE_ACTIVITY_ID);
  assert.equal(activity.gameplayGuides.length, 4);
});

test('管理只读路由按账号走缓存读取，两个活动共用注册器且不产生写路由', async () => {
  const routes = [];
  const reads = [];
  const activityReader = {
    read: async (accountId, read) => {
      reads.push(accountId);
      return { value: await read(accountId), upstreamCached: false };
    },
  };
  const provider = {
    getStatus: () => ({ connection: { connected: true } }),
    getWishActivity: async id => ({ id, activityId: WISH_ACTIVITY_ID }),
    getHappyShareActivity: async id => ({ id, activityId: HAPPY_SHARE_ACTIVITY_ID }),
  };
  registerAdminSeasonActivityRoutes({
    app: { get: (path, handler) => routes.push([path, handler]) },
    provider,
    getAccountIdFromRequest: req => req.accountId,
    canAccessAccount: () => true,
    sendProviderError: (res, err) => { throw err; },
    activityReader,
  });
  assert.deepEqual(routes.map(([path]) => path), ['/api/activity/wish', '/api/activity/happy-share']);

  const handlerFor = path => routes.find(([p]) => p === path)[1];
  const respond = () => {
    const state = { body: null };
    return { state, json: body => { state.body = body; } };
  };
  const wishRes = respond();
  await handlerFor('/api/activity/wish')({ accountId: 'a1' }, wishRes);
  assert.equal(wishRes.state.body.ok, true);
  assert.equal(wishRes.state.body.activity.activityId, WISH_ACTIVITY_ID);
  assert.equal(wishRes.state.body.upstreamCacheMs, 60 * 1000);
  const shareRes = respond();
  await handlerFor('/api/activity/happy-share')({ accountId: 'a1' }, shareRes);
  assert.equal(shareRes.state.body.activity.activityId, HAPPY_SHARE_ACTIVITY_ID);
  assert.deepEqual(reads, ['a1', 'a1']);
});

test('活动常量已导出注册，known 集合收集后不再作为未知候选', () => {
  const knownActivityIds = Object.entries(activityService)
    .filter(([key, value]) => key.endsWith('_ACTIVITY_ID') && Number.isFinite(Number(value)))
    .map(([, value]) => Number(value));
  for (const id of [WISH_ACTIVITY_ID, WISH_SIGN_ACTIVITY_ID, HAPPY_SHARE_ACTIVITY_ID, HAPPY_SHARE_PLAY_ACTIVITY_ID]) {
    assert.ok(knownActivityIds.includes(id), `missing ${id}`);
  }
});
