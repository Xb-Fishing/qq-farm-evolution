const { toNum } = require('../utils/utils');

// 秋祈良愿（2026-09-24 ~ 2026-10-07）与快乐不独享（2026-09-24 ~ 2026-10-12）：
// 两组活动在 2026-09-23 由 ActivityService.List 首次下发，enabled=false 尚未开放。
// 当前证据只有活动说明（payload.tips）与 GetGroup 字段形状；没有任何官方客户端
// 自然成功操作样本，因此全部玩法保持只读展示，不猜测 cmd 或请求参数。

const WISH_ACTIVITY_ID = 2026092400;
const WISH_SIGN_ACTIVITY_ID = 2026092401;
const WISH_CLIENT_UI_UID = 'WishSignMainUI';
const WISH_PROTOBUF_FIELD = 119;
// 烟花互动道具（活动开放首日 Bag 实际出现 6001，与 ItemInfo 快照/活动说明三方核对，
// 见 EventItems.json 与 docs/HANDOFF.md 2026-09-24 巡检）。专属图标待抓包证据，不伪造。
const WISH_FIREWORK_ITEM_ID = 6001;

const HAPPY_SHARE_ACTIVITY_ID = 2026092500;
const HAPPY_SHARE_PLAY_ACTIVITY_ID = 2026092501;
const HAPPY_SHARE_CLIENT_UI_UID = 'HappySharePanel';
const HAPPY_SHARE_PROTOBUF_FIELD = 120;

// 官方 ActivityWishSignChoose（协议恢复文档）：1-6 财运/感情/前程/生活/农耕/人际
const WISH_CHOICES = ['财运', '感情', '前程', '生活', '农耕', '人际'];

function plainText(value) {
  return typeof value === 'string'
    ? value.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim().slice(0, 2400)
    : '';
}

function ruleLines(payload) {
  const entries = Array.isArray(payload?.tips?.txt) ? payload.tips.txt : [];
  return entries
    .filter(entry => typeof entry === 'string')
    .flatMap(entry => entry.replace(/<br\s*\/?>/gi, '\n').split('\n'))
    .map(entry => plainText(entry))
    .filter(Boolean)
    .slice(0, 60);
}

function findLine(lines, pattern) {
  return (lines || []).find(line => pattern.test(line)) || '';
}

function statusLabel(node, nowSeconds) {
  if (!node) return '当前回包未包含';
  if (toNum(node.startTime) > nowSeconds) return '未开始';
  if (toNum(node.endTime) > 0 && toNum(node.endTime) < nowSeconds) return '已结束';
  if (!node.visible) return '未展示';
  return node.enabled ? '已启用' : `活动期内 · 节点未启用（状态 ${toNum(node.status)}）`;
}

function observedShape(snapshot, field) {
  const prefix = `1.2.${field}`;
  return (Array.isArray(snapshot?.discoveryEvidence?.protocolShape)
    ? snapshot.discoveryEvidence.protocolShape : [])
    .filter(entry => String(entry?.path || '') === prefix
      || String(entry?.path || '').startsWith(`${prefix}.`))
    .slice(0, 40)
    .map(entry => ({
      path: String(entry.path || ''),
      wire: toNum(entry.wire),
      count: Math.max(0, toNum(entry.count)),
      byteLengths: (Array.isArray(entry.byteLengths) ? entry.byteLengths : [])
        .map(toNum).filter(length => length >= 0).slice(0, 8),
    }));
}

function findChild(root, childId) {
  return (Array.isArray(root?.children) ? root.children : [])
    .find(node => toNum(node?.id) === childId) || null;
}

function baseActivity(root, play, activityId, clientUiUid, protobufField, nowSeconds) {
  return {
    activityId,
    title: plainText(root?.title) || plainText(play?.title) || '活动',
    startTime: toNum(root?.startTime) || toNum(play?.startTime),
    endTime: toNum(root?.endTime) || toNum(play?.endTime),
    visible: root?.visible === true, enabled: root?.enabled === true, status: toNum(root?.status),
    statusLabel: statusLabel(root, nowSeconds),
    uid: '', uidConfirmed: false, clientUiUid: plainText(play?.payload?.uid) || clientUiUid,
    readOnly: false, writeOperationsSupported: true,
    subActivities: [{
      id: toNum(play?.id), title: plainText(play?.title) || '玩法节点',
      type: toNum(play?.type), parentId: toNum(play?.parentId) || activityId,
      startTime: toNum(play?.startTime), endTime: toNum(play?.endTime),
      statusLabel: statusLabel(play, nowSeconds),
      clientUiUid: plainText(play?.payload?.uid),
      protobufField, protocolObserved: observedShape(root, protobufField).length > 0,
    }],
    protocol: {
      declaredReadOnlyFields: [protobufField],
      opaqueReadOnlyFields: [],
      observedShape: observedShape(root, protobufField),
    },
    ruleSections: [],
  };
}

// 秋祈良愿：每日祈愿领奖 + 限定种子/烟花/盆栽奖励 + 5 日存储 + 邮件补发。
// 烟花互动道具已由开放首日 Bag 证据确认为 6001（烟花桶）；奖励中的“2 种限定种子”
// 仍没有道具 ID、图片、植物或占地证据：不改 EventPlants.json、不猜写命令。
function normalizeWishActivity(snapshot, options = {}) {
  const root = snapshot || {};
  const play = findChild(root, WISH_SIGN_ACTIVITY_ID) || root;
  const lines = ruleLines(play?.payload);
  const nowSeconds = Number.isFinite(Number(options.nowSeconds))
    ? Number(options.nowSeconds)
    : Math.floor(Date.now() / 1000);
  const inventoryAvailable = options.inventoryAvailable === true;
  const counts = options.counts instanceof Map ? options.counts : new Map();
  const wishRule = findLine(lines, /在活动主界面祈愿|祈愿可领取当日好运奖励/);
  const rewardRule = findLine(lines, /奖励内容包括?2种限定种子|限定种子、烟花互动道具/);
  const storageRule = findLine(lines, /存储\s*5\s*日奖励/);
  const mailRule = findLine(lines, /通过邮件补发/);
  const signRule = findLine(lines, /签文仅作趣味参考/);
  const guides = [
    ['daily', '每日祈愿领奖', wishRule, ['活动期间每日在活动主界面祈愿', '领取当日好运奖励', '每日 0 点刷新次数'], '当日祈愿与领取状态'],
    ['rewards', '祈愿奖励内容', rewardRule, ['奖励包括 2 种限定种子', '烟花互动道具（烟花桶）与盆栽装扮', '2 种限定种子的 ID 与图片仍待下发证据'], '限定种子与盆栽的道具 ID、数量与领取进度'],
    ['storage', '错过祈愿的奖励存储', storageRule, ['农事繁忙错过祈愿时奖励自动存储', '最多存储 5 日奖励（含当天）'], '已存储天数与可补领内容'],
    ['mail', '未领取奖励邮件补发', mailRule, ['未成功领取的奖励不直接丢失', '第二天或活动结束后通过邮件补发'], '补发邮件状态'],
  ];
  return {
    ...baseActivity(root, play, WISH_ACTIVITY_ID, WISH_CLIENT_UI_UID, WISH_PROTOBUF_FIELD, nowSeconds),
    gameplayGuides: guides
      .filter(([, , evidence]) => evidence)
      .map(([key, title, evidence, steps, missingState]) => ({
        key, title, steps, missingState, evidence,
        actionLabel: '前往祈愿', operationSupported: false, statusAvailable: false,
      })),
    operateState: play?.details?.wishSign || null,
    choices: WISH_CHOICES.map((name, index) => ({ id: index + 1, name })),
    resources: [{
      key: 'firework', itemId: WISH_FIREWORK_ITEM_ID, name: '烟花桶',
      itemType: 23, itemTypeLabel: '道具', desc: '祈愿奖励的烟花互动道具，可在自己或好友农场放置烟花筒。',
      inventoryCount: inventoryAvailable ? counts.get(WISH_FIREWORK_ITEM_ID) ?? 0 : null,
    }],
    inventoryAvailable,
    notices: [signRule].filter(Boolean),
    ruleSections: lines.map((line, index) => ({ index, line })),
    missingEvidence: [
      '祈愿（cmd 51）与领取祈愿奖励（cmd 52）已按官方编码器重构证据接入面板手动操作（见 season-wish-operate.js）；不接自动任务。',
      '烟花互动道具已确认为烟花桶（6001，开放首日 Bag 证据 + ItemInfo 快照 + 活动说明三方核对）；专属图标仍待抓包证据，不伪造。',
      '2 种限定种子的道具 ID、图片、植物映射与占地（含是否四格）均无证据：不改 EventPlants.json，待下发/背包/土地证据补齐。',
      `field ${WISH_PROTOBUF_FIELD} 为 ActivityBodyWishSign（remaining_count/activity_day/pending），按官方编码器重构声明解码。`,
      '活动读取先由 ActivityService.List 确认根节点下发，再用空活动组 UID 读取 GetGroup； WishSignMainUI 只是客户端界面标识。',
    ],
  };
}

// 快乐不独享：快乐值三途径（每日领取/每日首次分享/点好友分享链接）+ 档位奖励。
// “分享”与“点击好友链接”属官方客户端社交传播玩法；Bot 不模拟分享、不伪造点击。
function normalizeHappyShareActivity(snapshot, options = {}) {
  const root = snapshot || {};
  const play = findChild(root, HAPPY_SHARE_PLAY_ACTIVITY_ID) || root;
  const lines = ruleLines(play?.payload);
  const nowSeconds = Number.isFinite(Number(options.nowSeconds))
    ? Number(options.nowSeconds)
    : Math.floor(Date.now() / 1000);
  const claimRule = findLine(lines, /每日在活动主界面领取/);
  const shareRule = findLine(lines, /每日首次从活动主界面分享/);
  const friendLinkRule = findLine(lines, /点击好友分享的快乐包链接/);
  const tierRule = findLine(lines, /拿到一定快乐值可领取档位奖励|稚萌熊熊/);
  const guides = [
    ['daily-claim', '每日领取快乐值', claimRule, ['每日在活动主界面领取快乐值', '每日 0 点刷新次数'], '今日领取状态'],
    ['daily-share', '每日首次分享', shareRule, ['每日首次从活动主界面完成分享', '获得快乐值'], '今日分享状态'],
    ['friend-link', '好友快乐包链接', friendLinkRule, ['点击好友分享的快乐包链接', '获得快乐值；每类途径每日 0 点刷新'], '今日好友链接点击状态'],
    ['tier-rewards', '快乐值档位奖励', tierRule, ['积累快乐值达到档位', '领取档位奖励（稚萌熊熊）'], '当前快乐值、档位进度与领取状态'],
  ];
  return {
    ...baseActivity(root, play, HAPPY_SHARE_ACTIVITY_ID, HAPPY_SHARE_CLIENT_UI_UID, HAPPY_SHARE_PROTOBUF_FIELD, nowSeconds),
    gameplayGuides: guides
      .filter(([, , evidence]) => evidence)
      .map(([key, title, evidence, steps, missingState]) => ({
        key, title, steps, missingState, evidence,
        actionLabel: '前往活动页', operationSupported: false, statusAvailable: false,
      })),
    operateState: play?.details?.shareReward || null,
    notices: [],
    ruleSections: lines.map((line, index) => ({ index, line })),
    missingEvidence: [
      '每日领取（cmd 73）与档位领奖（cmd 70）已按官方编码器重构证据接入面板手动操作（见 season-wish-operate.js）；不接自动任务。',
      '分享与点击好友链接是官方客户端社交玩法，Bot 不模拟分享、不伪造点击；面板分享按钮无法完成官方分享用户流程（拉起 QQ 转发），直接发命令等于伪造分享状态，因此分享操作不开放。',
      `field ${HAPPY_SHARE_PROTOBUF_FIELD} 为 ActivityBodyShareReward（快乐值/每日状态/档位），按官方编码器重构声明解码。`,
      '活动读取先由 ActivityService.List 确认根节点下发，再用空活动组 UID 读取 GetGroup；HappySharePanel 只是客户端界面标识。',
    ],
  };
}

module.exports = {
  WISH_ACTIVITY_ID, WISH_SIGN_ACTIVITY_ID, WISH_CLIENT_UI_UID, WISH_PROTOBUF_FIELD, WISH_FIREWORK_ITEM_ID,
  HAPPY_SHARE_ACTIVITY_ID, HAPPY_SHARE_PLAY_ACTIVITY_ID, HAPPY_SHARE_CLIENT_UI_UID, HAPPY_SHARE_PROTOBUF_FIELD,
  normalizeWishActivity, normalizeHappyShareActivity,
};
