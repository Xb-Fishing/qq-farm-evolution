const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const protobuf = require('protobufjs');
const { getResourcePath, getDataDir } = require('../config/runtime-paths');
const { sendMsgAsync } = require('../utils/network');
const { getItemById, getItemImageById } = require('../config/gameConfig');
const catalog = require('../gameConfig/UpdateCatalog.json');

// Deliberately separate from dogpb: its legacy scalar names have conflicting
// semantics. Reading these fields must not authorize feeding or change callers.
class ReadPresenceRoot extends protobuf.Root {
  resolveAll() {
    const preserve = node => {
      for (const field of node.fieldsArray || []) if (!field.repeated && !field.map) field.setOption('features.field_presence', 'EXPLICIT', true);
      for (const child of node.nestedArray || []) preserve(child);
    };
    preserve(this);
    return super.resolveAll();
  }
}
const root = new ReadPresenceRoot();
root.loadSync(getResourcePath('proto', 'panel-readonly.proto'), { keepCase: true });
root.resolveAll();
const type = name => root.lookupType(`gamepb.panelreadpb.${name}`);
const metadata = new Map(catalog.series.flatMap(group => group.items.map(item => [String(item.id), { ...item, seriesName: group.name }])));
const own = (value, key) => Object.hasOwn(value, key);
function decimal(value, fallback = '0') {
  const text = value == null ? fallback : String(value);
  if (!/^(?:0|[1-9][0-9]*)$/.test(text) || BigInt(text) > 9223372036854775807n) throw new Error('游戏状态数值无效');
  return text;
}
function identifier(value) {
  const text = decimal(value), id = Number(text);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('游戏状态编号无效');
  return id;
}

function recordEvidence(kind, request, body, reply, messageType) {
  const accountId = process.env.FARM_ACCOUNT_ID;
  if (!accountId) throw new Error('只读证据缺少账号归属');
  if (body.length > 1024 * 1024) throw new Error('只读状态超过预期大小');
  const dir = path.join(getDataDir(), 'game-panel-read-evidence');
  try { fs.mkdirSync(dir, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.mode & 0o077) throw new Error('只读证据目录不可用');
  const file = path.join(dir, crypto.createHash('sha256').update(`${accountId}:${kind}`).digest('hex') + '.json');
  const temporary = file + '.' + crypto.randomUUID();
  const record = { source: 'authorized_account_read', kind, accountId, fetchedAt: Date.now(),
    requestBase64: Buffer.from(request).toString('base64'), replyBase64: Buffer.from(body).toString('base64'),
    replySHA256: crypto.createHash('sha256').update(body).digest('hex'),
    decoded: messageType.toObject(reply, { longs: String }),
    schemaRoundtrip: Buffer.from(messageType.encode(reply).finish()).equals(Buffer.from(body)) };
  try { fs.writeFileSync(temporary, JSON.stringify(record) + '\n', { mode: 0o600, flag: 'wx' }); fs.renameSync(temporary, file); }
  finally { fs.rmSync(temporary, { force: true }); }
  return record.fetchedAt;
}

async function getCollectionReadPanel() {
  const request = type('GetCollectionsRequest').encode({ categories: [1] }).finish();
  const { body } = await sendMsgAsync('gamepb.collectionpb.CollectionService', 'GetCollections', request);
  const replyType = type('GetCollectionsReply'), reply = replyType.decode(body);
  const details = reply.details.filter(row => row.category === 1);
  if (details.length !== 1) throw new Error('未返回珍藏室类别，请在游戏内确认解锁状态');
  const detail = details[0], seen = new Set();
  const items = detail.collections.map(row => {
    const id = identifier(row.collection_id), meta = metadata.get(String(id));
    if (seen.has(id)) throw new Error('珍藏室状态含重复藏品');
    seen.add(id);
    const star = row.star_level || 0;
    if (!Number.isInteger(star) || star < 0 || star > 5) throw new Error('珍藏室星级无效');
    return { id, name: meta?.name || `藏品 ${id}`, seriesName: meta?.seriesName || '', image: getItemImageById(id) || '',
      star, ownedCountDec: decimal(row.own_count), isNew: row.is_new === true };
  });
  const currentScore = detail.current_score || 0, claimedScore = detail.claimed_reward_score || 0;
  if (!Number.isSafeInteger(currentScore) || currentScore < 0 || !Number.isSafeInteger(claimedScore) || claimedScore < 0) throw new Error('珍藏室评分无效');
  const displays = reply.display_slots.map(slot => {
    const itemId = decimal(slot.display?.item_id);
    return { slotType: slot.slot_type || 0, itemIdDec: itemId, name: itemId === '0' ? '空展台' : metadata.get(itemId)?.name || `藏品 ${itemId}` };
  });
  const fetchedAt = recordEvidence('collections', request, body, reply, replyType);
  return { fetchedAt, currentScore, claimedScore, items, displays, writesEnabled: false };
}

async function getDogReadPanel() {
  const request = Buffer.alloc(0);
  const { body } = await sendMsgAsync('gamepb.dogpb.DogService', 'GetDogInfo', request);
  const replyType = type('DogPanelReply'), reply = replyType.decode(body);
  if (!reply.dogs.length && !own(reply, 'current_dog_id') && !own(reply, 'pending_gift_count')) throw new Error('守卫犬状态不完整');
  const dogs = reply.dogs.map(row => ({ id: identifier(row.id), name: row.name || `守卫犬 ${row.id}`, levelDec: decimal(row.level) }));
  const currentId = own(reply, 'current_dog_id') ? decimal(reply.current_dog_id) : null;
  const fetchedAt = recordEvidence('dog', request, body, reply, replyType);
  // Only Bag supplies inventory. Dog reply food.field_3 is not a quantity.
  let foodInventoryKnown = false, foods = [], inventoryError = '';
  try {
    const warehouse = require('./warehouse');
    const items = warehouse.getBagItems(await warehouse.getBag());
    foods = [90004, 90005, 90006].map(id => ({ id, name: getItemById(id)?.name || `狗粮 ${id}`, image: getItemImageById(id) || '',
      countDec: items.filter(row => Number(row.id) === id).reduce((sum, row) => sum + BigInt(decimal(row.count)), 0n).toString() }));
    foodInventoryKnown = true;
  } catch { inventoryError = '狗粮库存读取失败，数量未知'; }
  return { fetchedAt, dogs, currentDogName: currentId === null ? '当前守卫犬未知' : currentId === '0' ? '未选择守卫犬' : dogs.find(row => String(row.id) === currentId)?.name || `守卫犬 ${currentId}`,
    pendingGiftCountDec: decimal(reply.pending_gift_count), foodInventoryKnown, foods, inventoryError,
    protectionKnown: false, feedingEnabled: false, feedingReason: '护卫时长、容量及投喂调用仍在核实，请在游戏内喂食' };
}

if (globalThis.process?.env?.FARM_SESSION_BUSINESS === '1') {
  const { wrapBusinessFunction } = require('./business-state');
  getCollectionReadPanel = wrapBusinessFunction('services/game-panel-readonly.js:getCollectionReadPanel', getCollectionReadPanel);
  getDogReadPanel = wrapBusinessFunction('services/game-panel-readonly.js:getDogReadPanel', getDogReadPanel);
}
module.exports = { getCollectionReadPanel, getDogReadPanel };
