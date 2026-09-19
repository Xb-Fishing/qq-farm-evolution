const { toNum } = require('../utils/utils');
const { getItemById, getItemImageById, registerRuntimeItem } = require('../config/gameConfig');

const BEAR_ACTIVITY_ID = 2026090100;
const BEAR_PLAY_ACTIVITY_ID = 2026090101;
const BEAR_RECORD_ACTIVITY_ID = 2026090102;
const BEAR_SHOP_ACTIVITY_ID = 2026090103;
const BEAR_CURRENCY_ITEM_ID = 1029;
const BEAR_CLIENT_UI_UID = 'SEASON_BEAR_CAMPAIGN';
// 物品语义来自核对后的 ItemInfo/Plant；奖励数量和编号段不能证明名称或类型。
const BEAR_SEED_ITEM_ID = 29004;
const BEAR_CAKE_ITEM_ID = 1028;
// 三档挑战书 ID 来自 client-config-evidence ItemInfo 快照（type 19）与参考仓库 pet-diary
// 配置表、活动说明三方一致的证据闭环（2026-09-13）；仅只读展示，不推导写命令。
const BEAR_BASIC_CHALLENGE_ITEM_ID = 80101;
const BEAR_MIDDLE_CHALLENGE_ITEM_ID = 80102;
const BEAR_ADVANCED_CHALLENGE_ITEM_ID = 80103;
// 待护送宝藏 1030：Bag 实际出现 + ItemInfo 快照（type 19、activity 2026090101）闭环
// （2026-09-14）；寻宝产出、护送后结算，仅只读展示。
const BEAR_TREASURE_ITEM_ID = 1030;
// 玩法指南「已在面板开放的手动操作」展示映射：仅镜像活动卡顶部「玩法手动操作」区
// 七个已批准按钮（pet-diary-operate OPERATIONS 白名单的子集），属于展示层提示，
// 不代表写操作授权；care/escort/raid/tactics/shop/rank 无条目（未开放或无对应入口）。
// 新增键前必须先在面板与 OPERATIONS 同时存在，且不得包含 exchange/battle 等未开放动作。
const BEAR_GUIDE_MANUAL_ACTIONS = {
  grow: ['initialize', 'feed', 'claimDog'],
  treasure: ['draw'],
  pity: ['compensation'],
  album: ['story'],
  gift: ['seeds'],
};

function getBearObservedItemIds(snapshot) {
  const root = snapshot || {};
  if (toNum(root.id) !== BEAR_ACTIVITY_ID) return [];
  const record = (root.children || []).find(node => toNum(node?.id) === BEAR_RECORD_ACTIVITY_ID);
  const ids = [];
  for (const entry of record?.details?.starRecord?.records || []) {
    for (const reward of entry?.rewards || []) {
      const id = toNum(reward?.itemId ?? reward?.id);
      if (id > 0 && !ids.includes(id)) ids.push(id);
    }
  }
  return ids;
}

function normalizeBearReward(reward) {
  const id = toNum(reward?.itemId ?? reward?.id);
  if (id <= 0) return reward;
  const info = getItemById(id);
  const name = String(info?.name || reward?.itemName || reward?.name || '').trim();
  return {
    ...reward,
    itemId: id,
    itemName: name || String(reward?.itemName || reward?.name || `物品#${id}`).trim(),
    image: String(reward?.image || getItemImageById(id) || '').trim(),
  };
}

function plainText(value) {
  return typeof value === 'string'
    ? value.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim().slice(0, 2400)
    : '';
}

// 只提取说明事实；图片对象、链接属性及其他 payload 字段不进入玩法模型。
function ruleSections(payload, sourceId) {
  return ['tips', 'tips1', 'tips2'].flatMap(key => {
    const tips = payload?.[key];
    const sections = [];
    let section = { sourceId, key, title: plainText(tips?.title), lines: [] };
    for (const entry of (Array.isArray(tips?.txt) ? tips.txt : []).slice(0, 160)) {
      if (typeof entry !== 'string') continue;
      if (/^\s*<b>[^<]+<\/b>\s*$/.test(entry)) {
        if (section.lines.length) sections.push(section);
        section = { sourceId, key, title: plainText(entry), lines: [] };
      } else {
        section.lines.push(...entry.split(/<br\s*\/?>/i).map(plainText).filter(Boolean));
      }
    }
    if (section.lines.length) sections.push(section);
    return sections;
  });
}

function buildBearRuleModel(play, shop) {
  const sections = ruleSections(play?.payload, BEAR_PLAY_ACTIVITY_ID);
  const main = sections.filter(section => section.key === 'tips');
  const lines = main.flatMap(section => section.lines);
  const fromHeading = pattern => main.filter(section => pattern.test(section.title)).flatMap(section => section.lines);
  const definitions = [
    ['grow', '领养与投喂成长', lines.filter(line => /获取方式.*投喂|投喂.*培育.*比熊|投喂.*比熊幼崽/.test(line)), '成长进度、成年状态', '投喂比熊'],
    ['care', '看护与比熊变异', lines.filter(line => /看护状态/.test(line)), '看护状态', '设置看护'],
    ['treasure', '成年寻宝', fromHeading(/寻宝玩法/), '今日剩余次数、单次消耗、掉落', '派遣寻宝'],
    ['escort', '宝藏护送', fromHeading(/宝藏护送/), '护送倒计时、保底资金、博弈资金、被夺次数', '领取护送奖励'],
    // 挑战书库存不列入 missingState：它由背包读取在资源区展示（读取失败保持未知），
    // 不是待官方字段证据的活动状态；这里只保留真正缺字段证据的次数与目标状态。
    ['raid', '好友夺宝', [
      ...fromHeading(/夺宝博弈/),
      ...sections.filter(section => section.key === 'tips1' && /夺宝条件/.test(section.title)).flatMap(section => section.lines),
    ], '今日剩余次数、目标护送状态', '发起夺宝'],
    ['pity', '骰子胜负与安慰礼', fromHeading(/胜负与保底/), '连续失败次数、安慰礼领取状态', '领取安慰礼'],
    ['album', '爪印手记', fromHeading(/爪印手记/), '相册解锁进度、故事奖励领取状态', '领取故事奖励'],
    ['tactics', '锦囊选择与刷新', fromHeading(/锦囊系统/), '当前锦囊、免费与付费刷新剩余次数', '选择或刷新锦囊'],
    ['shop', '幸运星游记商城', lines.filter(line => /幸运星.*兑换/.test(line)), '兑换限额与拥有状态见商城', '兑换商品'],
    ['rank', '幸运星好友排名', lines.filter(line => /幸运星排行榜/.test(line)), '当前名次与好友排名', '查看排名'],
    ['gift', '每日稀有种子礼包', lines.filter(line => /每日.*免费.*稀有种子礼包|每日.*赠送.*稀有种子礼包/.test(line)), '累计待领份数、领取状态', '领取种子礼包'],
  ];
  const gameplayGuides = definitions.filter(([, , steps]) => steps.length).map(([key, title, steps, missingState, actionLabel]) => ({
    key, title, steps: [...new Set(steps)], missingState, actionLabel,
    // 仅展示层提示（镜像顶部已批准手动按钮），不是授权标记；只读边界见下方各标记。
    manualActions: [...(BEAR_GUIDE_MANUAL_ACTIONS[key] || [])],
    sourceId: BEAR_PLAY_ACTIVITY_ID, operationSupported: false, statusAvailable: false,
  }));
  const shopText = ruleSections(shop?.payload, BEAR_SHOP_ACTIVITY_ID).flatMap(section => section.lines).join('\n');
  const mainText = lines.join('\n');
  const conflicts = [
    [/350幸运星/, /400幸运星/, '护送初始价值', '玩法说明：总额 350、保底 50；商城说明：总额 400、保底 100。'],
    [/刷新2个锦囊/, /刷新3个锦囊/, '每日锦囊数量', '玩法说明：2 个；商城说明：3 个。'],
    [/必定获得.*挑战书/, /随机产出挑战书/, '寻宝挑战书产出', '玩法说明：必定获得；商城说明：随机产出。'],
    [/售价×4/, /四倍产量/, '比熊变异收益', '玩法说明：售价 ×4；商城说明：四倍产量。'],
  ].filter(([a, b]) => a.test(mainText) && b.test(shopText)).map(([, , title, text]) => ({ title, text }));
  const raidText = sections.filter(section => section.key === 'tips1').flatMap(section => section.lines).join('\n');
  if (/高于所选挑战书价值/.test(raidText) && /低于所选挑战书价值/.test(raidText)) {
    conflicts.push({ title: '挑战书等额边界', text: '夺宝条件要求博弈资金高于挑战书价值，提示只说明低于时不可用；相等时是否可用待官方确认。' });
  }
  return {
    gameplayGuides,
    notices: fromHeading(/温馨提示/),
    conflicts,
    ruleSections: sections,
  };
}

function statusLabel(node, nowSeconds) {
  if (!node) return '当前回包未包含';
  if (toNum(node.startTime) > nowSeconds) return '未开始';
  if (toNum(node.endTime) > 0 && toNum(node.endTime) < nowSeconds) return '已结束';
  if (!node.visible) return '未展示';
  return node.enabled ? '已启用' : `活动期内 · 节点未启用（状态 ${toNum(node.status)}）`;
}

function normalizeBearActivity(snapshot, options = {}) {
  const root = snapshot || {};
  const nodes = Array.isArray(root.children) ? root.children : [];
  const play = nodes.find(node => toNum(node.id) === BEAR_PLAY_ACTIVITY_ID);
  const record = nodes.find(node => toNum(node.id) === BEAR_RECORD_ACTIVITY_ID);
  const shop = nodes.find(node => toNum(node.id) === BEAR_SHOP_ACTIVITY_ID);
  const rules = buildBearRuleModel(play, shop);
  const inventoryAvailable = options.inventoryAvailable === true;
  const counts = options.counts instanceof Map ? options.counts : new Map();
  const countFor = id => inventoryAvailable && id ? counts.get(id) ?? 0 : null;
  const exchangeShop = (shop?.details?.exchangeShop?.items || []).map(item => ({
    ...item,
    name: plainText(item.name || item.itemName),
    currencyName: getItemById(item.currencyId)?.name || plainText(item.currencyName),
    // 保留服务端原始状态码；通用归一化的“可兑换”不是 S3 次数语义证据。
    statusLabel: `状态 ${toNum(item.status)} · 含义待确认`,
    inventoryCount: countFor(toNum(item.itemId)),
    operationSupported: false,
  }));
  for (const item of exchangeShop) {
    if (item.itemId > 0 && item.name) registerRuntimeItem(item.itemId, { name: item.name });
  }
  const evidenceText = rules.gameplayGuides.flatMap(guide => guide.steps).join('\n');
  const resources = [
    ['currency', '幸运星', BEAR_CURRENCY_ITEM_ID, /幸运星.*兑换/, '寻宝、投喂与夺宝产出，用于游记商城'],
    ['cake', '萌宠元气糕', BEAR_CAKE_ITEM_ID, /萌宠元气糕/, '稀有作物产出，用于投喂与寻宝'],
    ['seed', '泡泡棉花糖种子', BEAR_SEED_ITEM_ID, /稀有种子礼包/, '占地 2×2；收获活动作物可额外获得萌宠元气糕'],
    ['gift', '稀有种子礼包', null, /稀有种子礼包/, '每日免费赠送，未领取可累计'],
    ['treasure', '待护送宝藏', BEAR_TREASURE_ITEM_ID, /待护送宝藏|宝藏护送/, '寻宝获得后自动开启护送'],
    ['basic', '初级挑战书', BEAR_BASIC_CHALLENGE_ITEM_ID, /初级挑战书/, '价值 50 幸运星；胜利 60、失败 40'],
    ['middle', '中级挑战书', BEAR_MIDDLE_CHALLENGE_ITEM_ID, /中级挑战书/, '价值 150 幸运星；胜利 225、失败 75'],
    ['advanced', '高级挑战书', BEAR_ADVANCED_CHALLENGE_ITEM_ID, /高级挑战书/, '价值 300 幸运星；胜利 510、失败 90'],
  ].filter(([, , , pattern]) => pattern.test(evidenceText)).map(([key, name, itemId, , purpose]) => ({
    key, name, itemId, purpose, count: countFor(itemId), image: itemId ? getItemImageById(itemId) : '',
  }));
  const nowSeconds = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const observedShape = (root.discoveryEvidence?.protocolShape || [])
    .filter(entry => /^1\.2\.(?:102|110|115)(?:\.|$)/.test(String(entry.path)))
    .slice(0, 60).map(entry => ({
      path: String(entry.path), wire: toNum(entry.wire), count: toNum(entry.count),
      byteLengths: (entry.byteLengths || []).slice(0, 8).map(toNum),
    }));
  return {
    activityId: BEAR_ACTIVITY_ID, title: plainText(root.title) || 'S3 萌宠',
    startTime: toNum(root.startTime), endTime: toNum(root.endTime),
    visible: root.visible === true, enabled: root.enabled === true, status: toNum(root.status),
    statusLabel: statusLabel(root, nowSeconds),
    uid: '', uidConfirmed: false, clientUiUid: plainText(play?.payload?.uid),
    readOnly: true, writeOperationsSupported: false, inventoryAvailable,
    ...rules, resources, exchangeShop,
    records: (record?.details?.starRecord?.records || []).map(entry => ({
      ...entry,
      rewards: (entry.rewards || []).map(normalizeBearReward),
    })),
    recordStateAvailable: !!record?.details?.starRecord,
    subActivities: [
      [BEAR_PLAY_ACTIVITY_ID, '萌宠成长与寻宝夺宝', 115, play],
      [BEAR_RECORD_ACTIVITY_ID, '游记奖励记录', 110, record],
      [BEAR_SHOP_ACTIVITY_ID, '幸运星游记商城', 102, shop],
    ].map(([id, title, protobufField, node]) => ({
      id, title, protobufField, type: toNum(node?.type), parentId: toNum(node?.parentId),
      startTime: toNum(node?.startTime), endTime: toNum(node?.endTime),
      visible: node?.visible === true, enabled: node?.enabled === true, status: toNum(node?.status),
      clientUiUid: plainText(node?.payload?.uid), statusLabel: statusLabel(node, nowSeconds),
      available: !!node, protocolObserved: observedShape.some(entry => entry.path === `1.2.${protobufField}`),
    })),
    protocol: { declaredReadOnlyFields: [102, 110], opaqueReadOnlyFields: [115], observedShape },
    missingEvidence: [
      // 状态字段分两类：操作服务已解析并用于操作前校验的字段（成年阶段、投喂/寻宝次数与
      // 消耗、手记与礼包领取态、夺宝补偿数量）只是当前快照未展示，不能统称尚未确认；
      // 看护/护送/夺宝次数/锦囊/排名状态见下方条目的待官方字段证据边界。
      '成长阶段、投喂与寻宝次数及消耗、手记与种子礼包领取态、夺宝补偿数量已由操作服务解析并用于操作前校验，当前只读快照未展示这些实时状态。元气糕与三档挑战书库存随背包读取展示，读取失败保持未知、不补零。',
      '待护送宝藏（1030）与挑战书三档已按 ItemInfo 证据登记但专属图片仍待官方资源。元气糕为额外掉落物 1028，不能把奖励中的狗尾草种子 20516 当成元气糕。',
      'field 115 仅保留结构诊断；field 110 奖励记录不能直接认定为爪印手记。',
      // 已开放手动能力 / 快照未展示的实时状态 / 策略性未开放操作 三类边界分开表达，
      // 不得再笼统宣称「所有操作协议待确认」（顶部七个手动按钮 2026-09-18 已上线）。
      '投喂、寻宝、种子礼包、手记奖励、夺宝安慰礼、领养与领取永久比熊已开放面板手动操作（活动卡顶部「玩法手动操作」区）；其余玩法操作请在官方客户端人工进行。',
      '夺宝与好友信息、付费刷新等好友交互暂不开放；看护、护送、夺宝今日次数、锦囊、排名的实时状态仍待官方字段证据，未知不按 0 处理。',
      '商城状态码、次数与付费边界待官方样本；兑换能力已具备，但当前面板未提供商品兑换入口。',
    ],
  };
}

module.exports = {
  BEAR_ACTIVITY_ID, BEAR_PLAY_ACTIVITY_ID, BEAR_RECORD_ACTIVITY_ID, BEAR_SHOP_ACTIVITY_ID,
  BEAR_CURRENCY_ITEM_ID, BEAR_SEED_ITEM_ID, BEAR_CAKE_ITEM_ID,
  BEAR_BASIC_CHALLENGE_ITEM_ID, BEAR_MIDDLE_CHALLENGE_ITEM_ID, BEAR_ADVANCED_CHALLENGE_ITEM_ID,
  BEAR_TREASURE_ITEM_ID,
  BEAR_GUIDE_MANUAL_ACTIONS,
  BEAR_CLIENT_UI_UID,
  getBearObservedItemIds, normalizeBearActivity,
};
