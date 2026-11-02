const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { gameDateKey } = require('../config/game-date');
const network = require('../utils/network');
const { sendMsgAsync } = network;
const { types } = require('../utils/proto');
const { log, toNum } = require('../utils/utils');
const { getItemById } = require('../config/gameConfig');
const { getDataDir } = require('../config/runtime-paths');
const { strictBudgetRejection } = require('./operation-error-meta');
const DAILY_KEY = 'email_rewards';
const CHECK_COOLDOWN_MS = 300000;
const SNAPSHOT_CACHE_MS = 60000;
const MAX_EMAILS = 2000;
let doneDateKey = ''; let lastCheckAt = 0; let stateOwner = '';
let cachedSnapshot = null; let cachedConnection = null; let snapshotInFlight = null; let claimInFlight = null;
let snapshotRevision = 0;
function getDateKey() { const date = new Date(); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`; }
function accountKey() { return crypto.createHash('sha256').update(String(process.env.FARM_ACCOUNT_ID || 'default')).digest('hex').slice(0, 24); }
function hash(box, id) { return crypto.createHash('sha256').update(`${box}:${id}`).digest('hex'); }
function ownership() {
  const account = accountKey(); const connection = network.getWs();
  return { account, connection, valid: () => accountKey() === account && network.isConnected() && network.getWs() === connection };
}
function errorKind(error) { return strictBudgetRejection(error) ? 'budget' : error?.code === 'EMAIL_STATE' ? 'state' : 'read'; }
function safeTarget(root, target) {
  const base = path.resolve(root); const resolved = path.resolve(target);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) throw new Error('邮箱路径越界');
  for (let current = resolved;; current = path.dirname(current)) {
    try { if (fs.lstatSync(current).isSymbolicLink()) throw new Error('邮箱路径含符号链接'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (current === path.dirname(current)) break;
  }
  return resolved;
}
function fileFor(directory, owner) { const root = getDataDir(); return safeTarget(root, path.join(root, directory, `${owner}.json`)); }
function atomicWrite(directory, owner, value) {
  const file = fileFor(directory, owner); const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temp = safeTarget(getDataDir(), path.join(dir, `${owner}.${crypto.randomUUID()}.tmp`));
  try { fs.writeFileSync(temp, JSON.stringify(value), { flag: 'wx', mode: 0o600 }); fs.renameSync(temp, file); }
  finally { fs.rmSync(temp, { force: true }); }
}
function loadJournal(owner) {
  try {
    const file = fileFor('email-claim-declarations', owner); const stat = fs.statSync(file);
    if (stat.size > 1024 * 1024) throw new Error('invalid');
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (value.accountKey !== owner || !value.boxes || typeof value.boxes !== 'object' || Array.isArray(value.boxes)) throw new Error('invalid');
    for (const [box, row] of Object.entries(value.boxes)) {
      if (!['1', '2'].includes(box) || !Array.isArray(row.hashes) || row.hashes.length > MAX_EMAILS || new Set(row.hashes).size !== row.hashes.length
        || !row.hashes.every(id => /^[a-f0-9]{64}$/.test(id))) throw new Error('invalid');
    }
    return value;
  } catch (error) {
    if (error.code === 'ENOENT') return { accountKey: owner, boxes: {} };
    throw Object.assign(new Error('邮箱防重记录不可读，暂停领取'), { code: 'EMAIL_STATE' });
  }
}
function rows(reply) {
  if (!reply || !Array.isArray(reply.emails) || reply.emails.length > MAX_EMAILS) throw new Error('邮箱列表不完整');
  const unique = new Map();
  for (const row of reply.emails) {
    if (!row || typeof row.id !== 'string' || !row.id || row.id.length > 512) throw new Error('邮箱条目不完整');
    if (unique.has(row.id)) throw new Error('邮箱条目重复');
    unique.set(row.id, row);
  }
  return [...unique.values()];
}
function claimable(row) { return row.has_reward === true && row.claimed !== true; }
function reconcile(journal, box, list) {
  const declaration = journal.boxes[box];
  if (!declaration) return 0;
  // 消失/过期不能证明领取成功；只有显式 claimed 确认才结算封数。
  const confirmed = new Set(list.filter(row => row.claimed === true).map(row => hash(box, row.id)));
  const count = declaration.hashes.filter(id => confirmed.has(id)).length;
  declaration.hashes = declaration.hashes.filter(id => !confirmed.has(id));
  if (!declaration.hashes.length) delete journal.boxes[box];
  return count;
}
async function getEmailList(boxType = 1, options = {}) {
  const request = types.GetEmailListRequest.encode(
    types.GetEmailListRequest.create({ box_type: Number(boxType) || 1 })
  ).finish();
  const timeoutMs = Number.isSafeInteger(options.timeoutMs) ? Math.max(1, Math.min(20000, options.timeoutMs)) : 20000;
  const { body } = await sendMsgAsync('gamepb.emailpb.EmailService', 'GetEmailList', request, timeoutMs);
  return types.GetEmailListReply.decode(body);
}

async function claimEmail(boxType = 1, emailId = '') {
  const request = types.ClaimEmailRequest.encode(
    types.ClaimEmailRequest.create({
      box_type: Number(boxType) || 1,
      email_id: String(emailId || ''),
    })
  ).finish();
  snapshotRevision++; cachedSnapshot = null; cachedConnection = null;
  const { body } = await sendMsgAsync('gamepb.emailpb.EmailService', 'ClaimEmail', request);
  return types.ClaimEmailReply.decode(body);
}

async function batchClaimEmail(boxType = 0, emailId = '') {
  const request = types.BatchClaimEmailRequest.encode(
    types.BatchClaimEmailRequest.create({
      box_type: Number(boxType) || 0,
      email_id: String(emailId || ''),
    })
  ).finish();
  snapshotRevision++; cachedSnapshot = null; cachedConnection = null;
  const { body } = await sendMsgAsync('gamepb.emailpb.EmailService', 'BatchClaimEmail', request);
  return types.BatchClaimEmailReply.decode(body);
}

function getRewardSummary(items) {
  const list = Array.isArray(items) ? items : [];
  const parts = [];
  for (const item of list) {
    const id = toNum(item.id);
    const count = toNum(item.count);
    if (count <= 0) continue;
    const configuredName = getItemById(id)?.name;
    const legacyNames = { 500001: '金币', 500002: '经验', 500: '点券' };
    const name = configuredName ? String(configuredName) : legacyNames[id] || `物品#${id}`;
    parts.push([1001, 1002, 500001, 500002, 500].includes(id) ? `${name}${count}` : `${name}x${count}`);
  }
  return parts.join('/');
}


// 只读快照无正文/附件扩展，不持久化邮件标题或 opaque ID。
async function getEmailSnapshot() {
  const owner = ownership();
  if (!owner.valid()) throw new Error('账号未连接，无法读取邮箱');
  if (claimInFlight) return { source: 'email-service', accountKey: owner.account, fetchedAt: Date.now(), partial: true, busy: true,
    boxes: Object.fromEntries([1, 2].map(box => [box, { ok: false, errorClass: 'claim_busy', fetchedAt: Date.now() }])) };
  if (cachedSnapshot?.accountKey === owner.account && cachedConnection === owner.connection
      && gameDateKey(cachedSnapshot.fetchedAt) === gameDateKey(Date.now())
      && Date.now() - cachedSnapshot.fetchedAt >= 0 && Date.now() - cachedSnapshot.fetchedAt < SNAPSHOT_CACHE_MS)
    return structuredClone({ ...cachedSnapshot, cached: true });
  if (snapshotInFlight) {
    const value = await snapshotInFlight;
    if (!owner.valid() || value.accountKey !== owner.account) throw new Error('账号连接已变更');
    return structuredClone(value);
  }
  const task = (async () => {
    const revision = snapshotRevision;
    const value = { source: 'email-service', accountKey: owner.account, fetchedAt: Date.now(), partial: false, boxes: {} };
    for (const box of [1, 2]) {
      if (!owner.valid()) throw new Error('账号连接已变更');
      try {
        const list = rows(await getEmailList(box, { timeoutMs: 10000 }));
        if (!owner.valid()) throw new Error('账号连接已变更');
        if (snapshotRevision !== revision) throw Object.assign(new Error('邮箱状态正在变更，请稍后刷新'), { code: 'EMAIL_STATE_CHANGED' });
        value.boxes[box] = { ok: true, fetchedAt: Date.now(), total: list.length,
          claimable: list.filter(claimable).length, idHashes: list.map(row => hash(box, row.id)).sort() };
      } catch (error) {
        if (!owner.valid()) throw new Error('账号连接已变更');
        if (snapshotRevision !== revision) throw new Error('邮箱状态正在变更，请稍后刷新');
        value.partial = true; value.boxes[box] = { ok: false, fetchedAt: Date.now(), errorClass: errorKind(error) };
      }
    }
    if (!owner.valid()) throw new Error('账号连接已变更');
    if (snapshotRevision !== revision) throw new Error('邮箱状态正在变更，请稍后刷新');
    try { atomicWrite('email-snapshots', owner.account, value); } catch { value.persistenceFailed = true; }
    cachedSnapshot = value; cachedConnection = owner.connection;
    return structuredClone(value);
  })();
  snapshotInFlight = task;
  try { return await task; } finally { if (snapshotInFlight === task) snapshotInFlight = null; }
}

async function checkAndClaimEmails(force = false) {
  if (claimInFlight) return claimInFlight;
  const owner = ownership();
  const task = runCheck(force, owner);
  claimInFlight = task;
  try { return await task; } finally { if (claimInFlight === task) claimInFlight = null; }
}
async function runCheck(force, owner) {
  const result = { claimed: 0, rewardItems: 0, partial: false, unknown: false, boxes: {} }; const rewards = [];
  if (!owner.valid()) return { ...result, skipped: 'offline' };
  if (stateOwner !== owner.account) { stateOwner = owner.account; lastCheckAt = 0; doneDateKey = ''; }
  if (!force && lastCheckAt && Date.now() - lastCheckAt < CHECK_COOLDOWN_MS) return { ...result, cooldown: true };
  lastCheckAt = Date.now(); doneDateKey = '';
  if (snapshotInFlight) { try { await snapshotInFlight; } catch { /* 领取仍需重新核对 */ } }
  if (!owner.valid()) return { ...result, unknown: true };
  let journal;
  try { journal = loadJournal(owner.account); }
  catch { return { ...result, partial: true, stateBlocked: true }; }
  for (const box of [1, 2]) {
    if (!owner.valid()) { result.unknown = true; break; }
    let list;
    try { list = rows(await getEmailList(box)); }
    catch { result.boxes[box] = { ok: false }; result.partial = true; continue; }
    if (!owner.valid()) { result.unknown = true; break; }
    const work = structuredClone(journal);
    const confirmed = reconcile(work, box, list);
    try { atomicWrite('email-claim-declarations', owner.account, work); journal = work; result.claimed += confirmed; }
    catch { result.partial = true; continue; }
    // batch 的范围不缩为某个新 ID：任何未决声明都保留整箱，禁止新邮件覆盖旧声明。
    if (journal.boxes[box]) { result.unknown = true; result.boxes[box] = { ok: true, pending: true }; continue; }
    const candidates = list.filter(claimable);
    if (!candidates.length) { result.boxes[box] = { ok: true, claimable: 0 }; continue; }
    const declared = structuredClone(journal);
    declared.boxes[box] = { hashes: candidates.map(row => hash(box, row.id)), declaredAt: Date.now() };
    try { atomicWrite('email-claim-declarations', owner.account, declared); journal = declared; }
    catch { result.partial = true; continue; }
    if (!owner.valid()) { result.unknown = true; break; }
    let reply;
    try { reply = await batchClaimEmail(box, candidates[0].id); }
    catch (error) {
      if (!owner.valid()) { result.unknown = true; break; }
      if (strictBudgetRejection(error)) {
        const released = structuredClone(journal); delete released.boxes[box];
        try { atomicWrite('email-claim-declarations', owner.account, released); journal = released; } catch { result.unknown = true; }
        result.partial = true;
      } else result.unknown = true;
      result.boxes[box] = { ok: true, batch: 'unknown' }; continue;
    }
    if (!owner.valid()) { result.unknown = true; break; }
    // 请求完成的奖励只计一次；封数独立由新鲜 claimed 标记确认。
    if (!reply || !Array.isArray(reply.items)) { result.unknown = true; continue; }
    rewards.push(...reply.items); result.rewardItems += reply.items.length;
    try {
      const fresh = rows(await getEmailList(box));
      if (!owner.valid()) { result.unknown = true; break; }
      const checked = structuredClone(journal); const count = reconcile(checked, box, fresh);
      atomicWrite('email-claim-declarations', owner.account, checked); journal = checked; result.claimed += count;
      if (journal.boxes[box]) result.unknown = true;
      result.boxes[box] = { ok: true, batch: 'ok', pending: !!journal.boxes[box] };
    } catch { result.unknown = true; }
  }
  if (owner.valid()) {
    cachedSnapshot = null; cachedConnection = null;
    if (!result.partial && !result.unknown && result.boxes[1]?.ok && result.boxes[2]?.ok) doneDateKey = getDateKey();
    if (rewards.length) log('邮箱', `[邮箱领取] 已确认 ${result.claimed} 封 → ${getRewardSummary(rewards)}`, { module: 'task', event: DAILY_KEY, result: 'ok', count: result.claimed });
  }
  return result;
}
function getEmailDailyState() {
  return { key: DAILY_KEY, doneToday: stateOwner === accountKey() && doneDateKey === getDateKey(), lastCheckAt,
    partial: cachedSnapshot?.partial };
}
module.exports = { getEmailList, claimEmail, batchClaimEmail, getEmailSnapshot, checkAndClaimEmails, getEmailDailyState };
if (globalThis.process?.env?.FARM_SESSION_BUSINESS === '1') {
  const business = require('./business-state');
  for (const name of ['getEmailList','claimEmail','batchClaimEmail','getEmailSnapshot','checkAndClaimEmails'])
    module.exports[name] = business.wrapBusinessFunction(`services/email.js:${name}`, module.exports[name]);
  business.registerDataState('services/email.js', () => ({ doneDateKey, lastCheckAt, stateOwner }), value => {
    doneDateKey = value.doneDateKey || ''; lastCheckAt = value.lastCheckAt || 0; stateOwner = value.stateOwner || '';
  }, { optionalKeys: ['stateOwner'], idle: () => !claimInFlight && !snapshotInFlight });
}
