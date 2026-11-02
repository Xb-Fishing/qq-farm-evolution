// One bounded, shared read of already implemented game entries. No reward writes.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const network = require('../utils/network');
const { getDataDir } = require('../config/runtime-paths');
const CACHE_MS = 60000;
let cached = null, cachedConnection = null, inFlight = null;
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const accountKey = () => digest(String(process.env.FARM_ACCOUNT_ID || 'default')).slice(0, 24);
function safeTarget(root, target) {
  const base = path.resolve(root), resolved = path.resolve(target);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) throw new Error('证据路径越界');
  for (let current = resolved;; current = path.dirname(current)) {
    try { if (fs.lstatSync(current).isSymbolicLink()) throw new Error('证据路径含符号链接'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (current === path.dirname(current)) break;
  }
  return resolved;
}
function persist(evidence) {
  const root = getDataDir(), dir = safeTarget(root, path.join(root, 'game-update-evidence'));
  const file = safeTarget(root, path.join(dir, `${evidence.accountKey}.json`));
  const temp = safeTarget(root, path.join(dir, `${evidence.accountKey}.${crypto.randomUUID()}.tmp`));
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.writeFileSync(temp, JSON.stringify(evidence), { mode: 0o600, flag: 'wx' }); fs.renameSync(temp, file); }
  finally { fs.rmSync(temp, { force: true }); }
}
const ids = (list, key = 'id') => {
  if (!Array.isArray(list) || list.length > 4000) throw new Error('状态列表不完整');
  return [...new Set(list.map(row => String(row?.[key] ?? '')).filter(Boolean))].sort();
};
function buildSemanticFingerprint(evidence) {
  const values = {};
  for (const name of Object.keys(evidence.sources).sort()) {
    const item = evidence.sources[name];
    // 失败、普通进度和时间戳不构成新的游戏版本事实。
    if (item.status === 'ok') values[name] = item.factsHash;
  }
  return digest(values);
}
async function readIllustrated() {
  // Use the existing schema and exact existing reader, without its catch-to-empty compatibility layer.
  const { types } = require('../utils/proto');
  const request = types.GetIllustratedListV2Request;
  const response = await network.sendMsgAsync('gamepb.illustratedpb.IllustratedService', 'GetIllustratedListV2',
    request.encode(request.create({ refresh: false, illustrated_type: 1 })).finish());
  return types.GetIllustratedListV2Reply.decode(response.body);
}
async function readMall() {
  const { types } = require('../utils/proto');
  const request = types.GetMallListBySlotTypeRequest;
  const response = await network.sendMsgAsync('gamepb.mallpb.MallService', 'GetMallListBySlotType',
    request.encode(request.create({ slot_type: 1 })).finish());
  const reply = types.GetMallListBySlotTypeResponse.decode(response.body);
  return reply.goods_list.map(bytes => types.MallGoods.decode(bytes));
}
async function collectGameUpdateEvidence(options = {}) {
  const deps = {
    now: Date.now, isConnected: network.isConnected, getConnection: network.getWs,
    announcements: () => require('./official-announcements').getOfficialAnnouncements(),
    emails: () => require('./email').getEmailSnapshot(),
    solarCalendar: () => require('./solar-calendar').getSolarCalendar(),
    tasks: () => require('./task').getTaskInfo(), illustrated: readIllustrated, mall: readMall,
    persist, ...(options.deps || {}),
  };
  const owner = accountKey(), connection = deps.getConnection();
  const valid = () => accountKey() === owner && deps.isConnected() && deps.getConnection() === connection;
  if (!valid()) throw new Error('账号未连接，本轮未读取');
  if (cached?.accountKey === owner && cachedConnection === connection && deps.now() - cached.collectedAt >= 0
      && deps.now() - cached.collectedAt < CACHE_MS) return structuredClone({ ...cached, cached: true });
  if (inFlight) {
    const result = await inFlight;
    if (!valid() || result.accountKey !== owner) throw new Error('连接已变更，结果已丢弃');
    return structuredClone(result);
  }
  const task = (async () => {
    const value = { source: 'game-update-evidence', accountKey: owner, collectedAt: deps.now(), sources: {},
      gaps: ['settings', 'collections', 'official-all-red-dots'].map(entry => ({ entry, reason: '缺当前官方界面或可达读取证据，未采集' })) };
    const record = async (name, convert) => {
      if (!valid()) throw new Error('连接已变更，剩余读取已取消');
      try {
        const raw = await deps[name]();
        if (!valid()) throw new Error('连接已变更');
        value.sources[name] = { status: 'ok', fetchedAt: deps.now(), ...convert(raw) };
      } catch {
        if (!valid()) throw new Error('连接已变更，结果已丢弃');
        value.sources[name] = { status: 'error', fetchedAt: deps.now(), errorClass: 'read_failed' };
      }
    };
    await record('announcements', raw => {
      if (!Array.isArray(raw?.announcements) || raw.announcements.length > 30 || !(raw.fetchedAt > 0)) throw new Error('公告不完整');
      const entries = raw.announcements.map(row => ({ id: String(row.id), contentHash: digest([row.title, row.content]), detailLoaded: row.detailLoaded === true }));
      const partial = raw.partial === true || entries.some(row => !row.detailLoaded);
      return { status: partial ? 'partial' : 'ok', fetchedAt: raw.fetchedAt, count: entries.length,
        details: entries.filter(row => row.detailLoaded).length, factsHash: digest(entries), cached: raw.upstreamCached === true };
    });
    await record('emails', raw => {
      if (!raw?.boxes || !(raw.fetchedAt > 0)) throw new Error('邮箱不完整');
      const boxes = {};
      for (const box of [1, 2]) {
        const row = raw.boxes[box];
        boxes[box] = row?.ok === true && Array.isArray(row.idHashes)
          ? { status: 'ok', fetchedAt: row.fetchedAt, total: row.total, claimable: row.claimable, factsHash: digest(row.idHashes) }
          : { status: 'error', errorClass: 'read_failed' };
      }
      return { status: Object.values(boxes).every(row => row.status === 'ok') ? 'ok' : 'partial',
        fetchedAt: raw.fetchedAt, boxes, factsHash: digest(Object.values(boxes).map(row => row.factsHash || 'unknown')) };
    });
    await record('solarCalendar', raw => {
      const events = ids(raw?.events), seasons = ids(raw?.seasons);
      return { count: events.length, open: raw.events.filter(row => row.open).length,
        claimable: raw.events.filter(row => row.canClaim || row.canAnswer).length, factsHash: digest([events, seasons]), state: raw };
    });
    await record('tasks', raw => {
      const info = raw?.task_info;
      if (!info) throw new Error('任务状态缺失');
      const daily = ids(info.daily_tasks || []), growth = ids(info.growth_tasks || []), main = ids(info.tasks || []);
      const all = [...(info.daily_tasks || []), ...(info.growth_tasks || []), ...(info.tasks || [])];
      return { daily: daily.length, growth: growth.length, main: main.length,
        factsHash: digest([daily, growth, main]), claimable: all.filter(row => row.is_unlocked === true && row.is_claimed !== true
          && Number(row.total_progress) > 0 && Number(row.progress) >= Number(row.total_progress)).length };
    });
    await record('illustrated', raw => ({ count: ids(raw?.items, 'seed_id').length,
      claimable: raw.items.filter(row => row.has_reward === true).length, factsHash: digest(ids(raw.items, 'seed_id')) }));
    await record('mall', raw => ({ count: ids(raw, 'goods_id').length,
      free: raw.filter(row => row.is_free === true && row.enabled === true).length, factsHash: digest(ids(raw, 'goods_id')) }));
    if (!valid()) throw new Error('连接已变更，结果已丢弃');
    value.status = Object.values(value.sources).every(row => row.status === 'ok') ? 'partial_coverage' : 'partial';
    value.semanticHash = buildSemanticFingerprint(value);
    // 只有全部已审入口成功时才给变化检测提供有效指纹，失败不制造版本事件。
    value.factsComplete = Object.values(value.sources).every(row => row.status === 'ok');
    try { deps.persist(value); } catch { value.persistenceFailed = true; }
    cached = value; cachedConnection = connection;
    return structuredClone(value);
  })();
  inFlight = task;
  try { return await task; } finally { if (inFlight === task) inFlight = null; }
}
module.exports = { collectGameUpdateEvidence, buildSemanticFingerprint, EVIDENCE_CACHE_MS: CACHE_MS };
if (globalThis.process?.env?.FARM_SESSION_BUSINESS === '1') {
  const business = require('./business-state');
  module.exports.collectGameUpdateEvidence = business.wrapBusinessFunction('services/game-update-evidence.js:collectGameUpdateEvidence', collectGameUpdateEvidence);
}
