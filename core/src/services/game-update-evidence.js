// One bounded, shared read of already implemented game entries. No reward writes.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { gameDateKey } = require('../config/game-date');
const { solarCatalog } = require('./activity-catalog-facts');
const network = require('../utils/network');
const { getDataDir } = require('../config/runtime-paths');
const { VERIFIED_CLIENT_VERSION, validClientVersion, compareClientVersions } = require('../runtime/client-runtime-version');
const CACHE_MS = 60000;
const COLLECT_BUDGET_MS = 90000;
// Refuse to start a reader when its declared finite RPC chain no longer fits.
const SOURCE_BUDGET_MS = { announcements: 20000, emails: 20000, solarCalendar: 20000, tasks: 20000, illustrated: 20000, mall: 20000 };
let cached = null; let cachedConnection = null; let inFlight = null;
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const accountKey = () => digest(String(process.env.FARM_ACCOUNT_ID || 'default')).slice(0, 24);
function safeTarget(root, target) {
  const base = path.resolve(root); const resolved = path.resolve(target);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) throw new Error('证据路径越界');
  for (let current = resolved;; current = path.dirname(current)) {
    try { if (fs.lstatSync(current).isSymbolicLink()) throw new Error('证据路径含符号链接'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (current === path.dirname(current)) break;
  }
  return resolved;
}
function persist(evidence) {
  const root = getDataDir(); const dir = safeTarget(root, path.join(root, 'game-update-evidence'));
  const file = safeTarget(root, path.join(dir, `${evidence.accountKey}.json`));
  const temp = safeTarget(root, path.join(dir, `${evidence.accountKey}.${crypto.randomUUID()}.tmp`));
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.writeFileSync(temp, JSON.stringify(evidence), { mode: 0o600, flag: 'wx' }); fs.renameSync(temp, file); }
  finally { fs.rmSync(temp, { force: true }); }
}
function archiveAnnouncement(row) {
  const facts = { source: 'official-game-bulletin', id: String(row.id), title: String(row.title || ''),
    content: String(row.content || ''), imageUrl: String(row.imageUrl || ''),
    beginTime: String(row.beginTime || ''), endTime: String(row.endTime || '') };
  if (Buffer.byteLength(JSON.stringify(facts)) > 256 * 1024) throw new Error('公告正文超过留证上限');
  const fingerprint = digest(facts); const root = getDataDir();
  const dir = safeTarget(root, path.join(root, 'game-update-history'));
  const name = `announcement-${fingerprint}.json`; const file = safeTarget(root, path.join(dir, name));
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (fs.existsSync(file)) {
    if (fs.statSync(file).size > 256 * 1024 || digest(JSON.parse(fs.readFileSync(file, 'utf8'))) !== fingerprint) throw new Error('历史公告校验失败');
    return name;
  }
  const temporary = safeTarget(root, path.join(dir, `${crypto.randomUUID()}.tmp`));
  try { fs.writeFileSync(temporary, JSON.stringify(facts), { mode: 0o600, flag: 'wx' }); fs.renameSync(temporary, file); }
  finally { fs.rmSync(temporary, { force: true }); }
  return name;
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
    persist, archiveAnnouncement, ...(options.deps || {}),
  };
  const owner = accountKey(); const connection = deps.getConnection();
  const valid = () => accountKey() === owner && deps.isConnected() && deps.getConnection() === connection;
  if (!valid()) throw new Error('账号未连接，本轮未读取');
  if (cached?.accountKey === owner && cachedConnection === connection && deps.now() - cached.collectedAt >= 0
      && gameDateKey(cached.collectedAt) === gameDateKey(deps.now())
      && deps.now() - cached.collectedAt < CACHE_MS) return structuredClone({ ...cached, cached: true });
  if (inFlight) {
    const result = await inFlight;
    if (!valid() || result.accountKey !== owner) throw new Error('连接已变更，结果已丢弃');
    return structuredClone(result);
  }
  const task = (async () => {
    const deadlineAt = deps.now() + COLLECT_BUDGET_MS;
    const value = { source: 'game-update-evidence', accountKey: owner, collectedAt: deps.now(), sources: {},
      gaps: ['settings', 'collections', 'official-all-red-dots'].map(entry => ({ entry, reason: '缺当前官方界面或可达读取证据，未采集' })) };
    // Local configuration and the bridge's authoritative host version require
    // no extra game RPC. Never infer a host upgrade from manager settings alone.
    try {
      const currentVersion = require('../config/config').CONFIG.clientVersion;
      let configuredVersion = VERIFIED_CLIENT_VERSION;
      try {
        const file = safeTarget(getDataDir(), path.join(getDataDir(), 'store.json'));
        const stat = fs.lstatSync(file);
        if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error('invalid_config_snapshot');
        configuredVersion = JSON.parse(fs.readFileSync(file, 'utf8')).systemConfig?.clientVersion || VERIFIED_CLIENT_VERSION;
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (!validClientVersion(currentVersion) || !validClientVersion(configuredVersion)) throw new Error('invalid_client_version');
      const latestVersion = VERIFIED_CLIENT_VERSION;
      value.sources.clientVersion = { status: 'ok', fetchedAt: deps.now(), currentVersion, configuredVersion, latestVersion,
        synchronized: currentVersion === configuredVersion, outdated: compareClientVersions(currentVersion, latestVersion) < 0,
        factsHash: digest([latestVersion, configuredVersion, currentVersion]) };
    } catch { value.sources.clientVersion = { status: 'error', fetchedAt: deps.now(), errorClass: 'client_version_unknown' }; }

    const record = async (name, convert) => {
      if (!valid()) throw new Error('连接已变更，剩余读取已取消');
      if (deadlineAt - deps.now() < SOURCE_BUDGET_MS[name]) {
        value.sources[name] = { status: 'error', fetchedAt: deps.now(), errorClass: 'read_budget_exhausted' };
        return;
      }
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
      const entries = raw.announcements.map(row => {
        if (!/^[1-9]\d{0,18}$/.test(String(row?.id || ''))) throw new Error('公告编号无效');
        const entry = { id: String(row.id), titleHash: digest(row.title), contentHash: digest([row.title, row.content, row.imageUrl]),
          detailLoaded: row.detailLoaded === true, textAvailable: typeof row.content === 'string' && !!row.content.trim() };
        if (entry.detailLoaded) {
          try { entry.historyRef = deps.archiveAnnouncement(row); } catch { entry.historyUnavailable = true; }
        }
        return entry;
      });
      const partial = raw.partial === true || entries.some(row => !row.detailLoaded || !row.textAvailable);
      return { status: partial ? 'partial' : 'ok', fetchedAt: raw.fetchedAt, count: entries.length,
        details: entries.filter(row => row.detailLoaded && row.textAvailable).length, factsHash: digest(entries.map(({ historyRef: _ref, historyUnavailable: _missing, ...facts }) => facts)),
        entries, listComplete: entries.length < 30, cached: raw.upstreamCached === true };
    });
    await record('emails', raw => {
      if (!raw?.boxes || !(raw.fetchedAt > 0)) throw new Error('邮箱不完整');
      const boxes = {};
      for (const box of [1, 2]) {
        const row = raw.boxes[box];
        boxes[box] = row?.ok === true && Array.isArray(row.idHashes)
          ? { status: 'ok', fetchedAt: row.fetchedAt, total: row.total, claimable: row.claimable, factsHash: digest(row.idHashes) }
          : { status: 'error', errorClass: row?.errorClass === 'claim_busy' ? 'claim_busy' : 'read_failed' };
      }
      return { status: Object.values(boxes).every(row => row.status === 'ok') ? 'ok' : 'partial',
        fetchedAt: raw.fetchedAt, boxes, factsHash: digest(Object.values(boxes).map(row => row.factsHash || 'unknown')) };
    });
    await record('solarCalendar', raw => {
      const events = ids(raw?.events); const seasons = ids(raw?.seasons);
      const eventClaimable = raw.events.filter(row => row.canClaim || row.canAnswer).length;
      const seasonClaimable = raw.seasons.filter(row => row.canClaim === true).length;
      return { count: events.length, open: raw.events.filter(row => row.open).length,
        eventClaimable, seasonClaimable, claimable: eventClaimable + seasonClaimable,
        factsHash: digest(solarCatalog(raw)), state: raw };
    });
    await record('tasks', raw => {
      const info = raw?.task_info;
      if (!info) throw new Error('任务状态缺失');
      const daily = ids(info.daily_tasks || []); const growth = ids(info.growth_tasks || []); const main = ids(info.tasks || []);
      const all = [...(info.daily_tasks || []), ...(info.growth_tasks || []), ...(info.tasks || [])];
      const taskClaimable = all.filter(row => row.is_unlocked === true && row.is_claimed !== true
        && Number(row.total_progress) > 0 && Number(row.progress) >= Number(row.total_progress)).length;
      const actives = info.actives || [];
      if (!Array.isArray(actives) || actives.length > 100) throw new Error('活跃奖励状态不完整');
      const activeClaimable = actives.reduce((total, active) => {
        if (!Array.isArray(active.rewards) || active.rewards.length > 100) throw new Error('活跃奖励状态不完整');
        return total + active.rewards.filter(row => row.status === 2).length;
      }, 0);
      return { daily: daily.length, growth: growth.length, main: main.length,
        factsHash: digest([daily, growth, main, actives.map(active => [Number(active.type), ids(active.rewards, 'point_id')])]),
        taskClaimable, activeClaimable, claimable: taskClaimable + activeClaimable };
    });
    await record('illustrated', raw => {
      const itemIds = ids(raw?.items, 'seed_id');
      const itemClaimable = raw.items.filter(row => row.has_reward === true).length;
      const levelClaimable = raw.has_level_reward === true ? 1 : 0;
      return { count: itemIds.length, itemClaimable, levelClaimable, claimable: itemClaimable + levelClaimable, factsHash: digest(itemIds) };
    });
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
