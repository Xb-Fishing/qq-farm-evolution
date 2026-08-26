const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  WEATHER_ACTIVITY_ID,
  WEATHER_CLIENT_UI_UID,
  normalizeWeatherActivity,
} = require('../src/services/activity');
const {
  registerAdminWeatherActivityRoutes,
} = require('../src/controllers/admin-weather-activity-routes');

function createWeatherSnapshot() {
  return {
    id: 2026070300,
    parentId: 0,
    type: 1,
    title: '雨落成诗',
    startTime: 1787709600,
    endTime: 1788883199,
    visible: true,
    enabled: false,
    status: 0,
    discoveryEvidence: {
      protocolShape: [
        { path: '1.2.102', wire: 2, count: 1, byteLengths: [45] },
        { path: '1.2.105', wire: 2, count: 1, byteLengths: [31] },
        { path: '1.2.114', wire: 2, count: 1, byteLengths: [0] },
        { path: '1.2.117', wire: 2, count: 1, byteLengths: [113] },
        { path: '1.2.118', wire: 2, count: 1, byteLengths: [258] },
      ],
    },
    children: [
      {
        id: 2026070301,
        parentId: 2026070300,
        type: 3,
        title: '雨落成诗',
        startTime: 1787709600,
        endTime: 1788883199,
        visible: true,
        enabled: true,
        status: 18,
        payload: {
          uid: 'WeatherBottleUI',
          tips: {
            title: '活动说明',
            txt: ['<b>【活动简介】</b>', '成长中的作物有机会发生闪电变异。<br/>变异果实售价提升。'],
          },
        },
        details: {
          exchangeShop: {
            items: [{
              id: 200,
              status: 1,
              owned: true,
              statusLabel: '已拥有',
              itemId: 5001,
              itemCount: 1,
              itemName: '天气采集瓶',
              image: '',
              currencyId: 1005,
              currencyName: '金豆豆',
              price: 200,
            }],
          },
        },
        children: [],
      },
      { id: 2026070302, parentId: 2026070300, type: 17, visible: true, enabled: false, status: 0, children: [] },
      {
        id: 2026070303,
        parentId: 2026070300,
        type: 8,
        visible: true,
        enabled: false,
        status: 0,
        details: {
          draw: {
            freeMax: 4,
            freeUsed: 4,
            freeRemaining: 0,
            paidMax: 10,
            paidUsed: 1,
            paidRemaining: 9,
            paidCurrencyId: 5001,
            paidPrice: 1,
            fallbackPrice: 1,
            rewardPool: [{ id: 11001, rarity: 0, itemId: 5002, itemCount: 1, itemName: '物品5002', image: '', probability: '100%' }],
          },
        },
        children: [],
      },
      { id: 2026070304, parentId: 2026070300, type: 20, visible: true, enabled: false, status: 0, children: [] },
      { id: 2026070305, parentId: 2026070300, type: 6, visible: true, enabled: false, status: 0, children: [] },
    ],
  };
}

test('雨落成诗按在线证据标准化活动树、道具、次数和只读边界', () => {
  const activity = normalizeWeatherActivity(createWeatherSnapshot(), new Map([[5001, 3], [5002, 7]]));

  assert.equal(WEATHER_ACTIVITY_ID, 2026070300);
  assert.equal(WEATHER_CLIENT_UI_UID, 'WeatherBottleUI');
  assert.equal(activity.uid, '');
  assert.equal(activity.uidConfirmed, false);
  assert.equal(activity.clientUiUid, 'WeatherBottleUI');
  assert.equal(activity.subActivities.length, 5);
  assert.deepEqual(activity.subActivities.map(item => item.id), [
    2026070301, 2026070302, 2026070303, 2026070304, 2026070305,
  ]);
  assert.deepEqual(activity.subActivities.map(item => item.protobufField), [102, 114, 105, 118, 117]);
  assert.equal(activity.subActivities[0].statusLabel, '进行中');
  assert.equal(activity.items.weatherBottle.itemName, '天气采集瓶');
  assert.equal(activity.items.weatherBottle.itemCount, 3);
  assert.equal(activity.items.drawReward.itemName, '物品5002');
  assert.equal(activity.items.drawReward.itemCount, 7);
  assert.equal(activity.exchangeShop[0].price, 200);
  assert.equal(activity.draw.freeRemaining, 0);
  assert.equal(activity.draw.paidRemaining, 9);
  assert.equal(activity.draw.currencyName, '天气采集瓶');
  assert.equal(activity.draw.rewardPool[0].probability, '100%');
  assert.deepEqual(activity.protocol.opaqueReadOnlyFields, [114, 117, 118]);
  assert.equal(activity.protocol.observedShape.length, 5);
  assert.ok(activity.subActivities.every(item => item.protocolObserved));
  assert.equal(activity.readOnly, true);
  assert.equal(activity.writeOperationsSupported, false);
  assert.ok(activity.ruleLines.every(line => !line.includes('<')));
});

test('雨落成诗管理接口只读取已连接账号状态', async () => {
  const routes = new Map();
  const activity = normalizeWeatherActivity(createWeatherSnapshot());
  registerAdminWeatherActivityRoutes({
    app: { get: (route, handler) => routes.set(route, handler) },
    provider: {
      getStatus: () => ({ connection: { connected: true } }),
      getWeatherActivity: async () => activity,
    },
    getAccountIdFromRequest: () => 'account-A',
    canAccessAccount: () => true,
    sendProviderError: (_res, error) => { throw error; },
  });

  let body = null;
  await routes.get('/api/activity/weather')({}, { json: value => { body = value; } });
  assert.equal(body.ok, true);
  assert.equal(body.activity.activityId, WEATHER_ACTIVITY_ID);
  assert.equal(body.activity.writeOperationsSupported, false);
});

test('过期鹊桥专属 UI 与自动例行入口已停用，历史协议解析仍保留', () => {
  const workerSource = fs.readFileSync(path.join(__dirname, '../src/core/worker.js'), 'utf8');
  const activityViewSource = fs.readFileSync(path.join(__dirname, '../../web/src/views/Activity.vue'), 'utf8');
  const autoStart = workerSource.indexOf('async function runStarActivityAutoClaims()');
  const autoEnd = workerSource.indexOf('function stopStarActivityClaimTimer()', autoStart);
  const autoSource = workerSource.slice(autoStart, autoEnd);

  assert.doesNotMatch(autoSource, /qixi_|Qixi|qingmei_|Qingmei/);
  assert.doesNotMatch(activityViewSource, /QixiActivityPanel|鹊桥寄情/);
  assert.match(activityViewSource, /WeatherActivityPanel|雨落成诗/);
  assert.match(workerSource, /case 'getQixiActivity'/);
});
