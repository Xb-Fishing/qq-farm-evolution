
// Persistent-session async operation tracking.
if (globalThis.process?.env?.FARM_SESSION_BUSINESS === '1') {
  // eslint-disable-next-line no-func-assign -- Preserve the hoisted function and its existing recursive callers.
  fetchAnnouncements = require('./business-state').wrapBusinessFunction('services/official-announcements.js:fetchAnnouncements', fetchAnnouncements);
  // eslint-disable-next-line no-func-assign -- Preserve the hoisted function and its existing recursive callers.
  getOfficialAnnouncements = require('./business-state').wrapBusinessFunction('services/official-announcements.js:getOfficialAnnouncements', getOfficialAnnouncements);
}
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const protobuf = require('protobufjs');
const { getResourcePath, getDataDir } = require('../config/runtime-paths');
const { sendMsgAsync, isConnected, getWs } = require('../utils/network');
const { gameDateKey } = require('../config/game-date');

const SERVICE = 'gamepb.bulletinboardpb.BulletinBoardService';
const CACHE_MS = 5 * 60_000;
const FAILURE_MS = 30_000;
const MAX_DETAILS = 3;
let codecs;
let cached = null;
let cachedOwner = '';
let cachedScope = null;
let cachedUntil = 0;
let failedUntil = 0;
let failedScope = null;
let lastError = null;
let inFlight = null;

const accountOwner = () => String(process.env.FARM_ACCOUNT_ID || 'default');
const sameScope = (left, right) => !!left && !!right && left.owner === right.owner && left.connection === right.connection;
function assertCurrent(scope) {
    if (accountOwner() !== scope.owner || !isConnected() || getWs() !== scope.connection) {
        throw new Error('账号或连接已变更，公告结果已丢弃');
    }
}

function types() {
    if (!codecs) {
        const root = protobuf.parse(fs.readFileSync(getResourcePath('proto', 'bulletinboardpb.proto'), 'utf8'), { keepCase: true }).root;
        const lookup = name => root.lookupType(`gamepb.bulletinboardpb.${name}`);
        codecs = { listReq: lookup('GetBulletinListRequest'), listRep: lookup('GetBulletinListReply'),
            detailReq: lookup('GetBulletinDetailRequest'), detailRep: lookup('GetBulletinDetailReply') };
    }
    return codecs;
}

function plainText(value) {
    return String(value || '').slice(0, 64_000)
        .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
        .replace(/<br\b[^>]*>|<\/(?:p|div|li|h[1-6])\s*>/gi, '\n')
        .replace(/<[^>]*>/g, '')
        .replace(/&(?:nbsp|amp|lt|gt|quot|apos);/g, item => ({ '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" })[item])
        .replace(/&#(x[\da-f]+|\d+);/gi, (all, number) => {
            const code = Number.parseInt(number.replace(/^x/i, ''), /^x/i.test(number) ? 16 : 10);
            return code > 0 && code <= 0x10FFFF ? String.fromCodePoint(code) : all;
        })
        .replace(/\n[ \t]+/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function safeTarget(root, target) {
    const base = path.resolve(root);
    const resolved = path.resolve(target);
    if (resolved !== base && !resolved.startsWith(base + path.sep)) throw new Error('公告缓存路径越界');
    for (let current = resolved; ; current = path.dirname(current)) {
        try { if (fs.lstatSync(current).isSymbolicLink()) throw new Error('公告缓存路径含符号链接'); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (current === path.dirname(current)) break;
    }
    return resolved;
}

function persist(result, owner) {
    const dataDir = getDataDir();
    const accountKey = crypto.createHash('sha256').update(owner).digest('hex').slice(0, 24);
    const dir = safeTarget(dataDir, path.join(dataDir, 'official-game-announcements'));
    const target = safeTarget(dataDir, path.join(dir, `${accountKey}.json`));
    const temp = safeTarget(dataDir, path.join(dir, `${accountKey}.${crypto.randomUUID()}.tmp`));
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    try {
        fs.writeFileSync(temp, `${JSON.stringify(result)  }\n`, { mode: 0o600, flag: 'wx' });
        fs.renameSync(temp, target);
    } finally { fs.rmSync(temp, { force: true }); }
}

async function fetchAnnouncements(scope) {
    const c = types();
    const previous = cachedOwner === scope.owner ? cached : null;
    // 使用已声明请求的默认值，不枚举分页参数或公告编号。
    const { body } = await sendMsgAsync(SERVICE, 'GetBulletinList', c.listReq.encode(c.listReq.create({})).finish(), 5000);
    assertCurrent(scope);
    const reply = c.listRep.toObject(c.listRep.decode(body), { longs: String });
    const previousDetails = new Map((previous?.announcements || []).map(item => [item.id, item]));
    const seen = new Set();
    const announcements = [];
    for (const item of Array.isArray(reply.bulletins) ? reply.bulletins : []) {
        const id = String(item.id || '');
        if (!/^[1-9]\d{0,18}$/.test(id) || seen.has(id)) continue;
        seen.add(id);
        const listTitle = plainText(item.title).slice(0, 300);
        const entry = { id, title: listTitle, listTitle, detailLoaded: false };
        const old = previousDetails.get(id);
        const detailAt = old?.detailFetchedAt || previous?.fetchedAt;
        if (old?.detailLoaded === true && typeof old.content === 'string'
            && (old.listTitle ?? old.title) === listTitle && detailAt > 0 && detailAt <= Date.now()
            && gameDateKey(detailAt) === gameDateKey(Date.now())) {
            Object.assign(entry, { title: old.title, content: old.content, beginTime: old.beginTime,
                endTime: old.endTime, imageUrl: old.imageUrl, detailLoaded: true,
                detailFetchedAt: detailAt, detailCached: true });
        }
        announcements.push(entry);
        if (announcements.length === 30) break;
    }
    // 仍只读取三个真实下发的编号：先补缺，再轮换复查最旧正文，避免尾项永久饿死。
    const selected = [...announcements].sort((left, right) =>
        Number(left.detailLoaded) - Number(right.detailLoaded)
        || (left.detailFetchedAt || 0) - (right.detailFetchedAt || 0)).slice(0, MAX_DETAILS);
    let detailError = '';
    for (const item of selected) {
        assertCurrent(scope);
        try {
            const payload = c.detailReq.encode(c.detailReq.create({ id: item.id })).finish();
            const response = await sendMsgAsync(SERVICE, 'GetBulletinDetail', payload, 5000);
            assertCurrent(scope);
            const detail = c.detailRep.toObject(c.detailRep.decode(response.body), { longs: String });
            const content = plainText(detail.content);
            item.title = plainText(detail.title).slice(0, 300) || item.title;
            item.content = content;
            item.beginTime = plainText(detail.begin_time).slice(0, 100);
            item.endTime = plainText(detail.end_time).slice(0, 100);
            item.imageUrl = String(detail.image_url || '').slice(0, 2000);
            item.detailLoaded = true;
            item.detailFetchedAt = Date.now();
            item.detailCached = false;
        } catch (error) {
            assertCurrent(scope);
            // 失败即停止剩余详情，无重试、替代方法或编号试探。
            detailError = String(error.message || '公告详情读取失败').slice(0, 300);
            break;
        }
    }
    assertCurrent(scope);
    const result = { source: 'official-game-bulletin', fetchedAt: Date.now(), announcements,
        partial: !!detailError || announcements.some(item => !item.detailLoaded), detailError,
        empty: announcements.length === 0 };
    // 写盘失败不影响已经取得的只读结果；原始响应及账号身份不写入缓存。
    try { persist(result, scope.owner); } catch { /* 缓存不可写时仍返回当前读取结果 */ }
    return result;
}

async function getOfficialAnnouncements() {
    if (!isConnected()) throw new Error('账号未连接，无法读取官方公告');
    const scope = { owner: accountOwner(), connection: getWs() };
    if (cached && cachedOwner === scope.owner && sameScope(cachedScope, scope) && Date.now() < cachedUntil
        && cached.fetchedAt <= Date.now() && gameDateKey(cached.fetchedAt) === gameDateKey(Date.now())) return { ...cached, upstreamCached: true };
    if (sameScope(inFlight?.scope, scope)) return inFlight.promise;
    if (sameScope(failedScope, scope) && Date.now() < failedUntil) throw lastError;
    const operation = { scope, promise: null };
    inFlight = operation;
    operation.promise = (async () => {
        try {
            const result = await fetchAnnouncements(scope);
            assertCurrent(scope);
            cached = result;
            cachedOwner = scope.owner;
            cachedScope = scope;
            cachedUntil = Date.now() + CACHE_MS;
            failedUntil = 0;
            failedScope = null;
            return { ...result, upstreamCached: false };
        } catch (error) {
            if (accountOwner() === scope.owner && isConnected() && getWs() === scope.connection) {
                lastError = error;
                failedUntil = Date.now() + FAILURE_MS;
                failedScope = scope;
            }
            throw error;
        } finally { if (inFlight === operation) inFlight = null; }
    })();
    return operation.promise;
}

module.exports = { getOfficialAnnouncements };

// Persistent-session data capsule. No handles, functions or in-flight work.
if (globalThis.process?.env?.FARM_SESSION_BUSINESS === '1') {
  const { registerDataState } = require('./business-state');
  registerDataState('services/official-announcements.js', () => ({ cached, cachedOwner, cachedUntil, failedUntil, lastError }), value => {
      cached = value.cached;
      cachedOwner = value.cachedOwner || '';
      cachedUntil = value.cachedUntil;
      failedUntil = value.failedUntil;
      lastError = value.lastError;
  }, { idle: () => !inFlight, optionalKeys: ['cachedOwner'] });
}
