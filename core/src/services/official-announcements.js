const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const protobuf = require('protobufjs');
const { getResourcePath, getDataDir } = require('../config/runtime-paths');
const { sendMsgAsync, isConnected } = require('../utils/network');

const SERVICE = 'gamepb.bulletinboardpb.BulletinBoardService';
const CACHE_MS = 5 * 60_000;
const FAILURE_MS = 30_000;
const MAX_DETAILS = 3;
let codecs;
let cached = null;
let cachedUntil = 0;
let failedUntil = 0;
let lastError = null;
let inFlight = null;

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

function persist(result) {
    const dataDir = getDataDir();
    const accountKey = crypto.createHash('sha256').update(String(process.env.FARM_ACCOUNT_ID || 'default')).digest('hex').slice(0, 24);
    const dir = safeTarget(dataDir, path.join(dataDir, 'official-game-announcements'));
    const target = safeTarget(dataDir, path.join(dir, `${accountKey}.json`));
    const temp = safeTarget(dataDir, path.join(dir, `${accountKey}.${crypto.randomUUID()}.tmp`));
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    try {
        fs.writeFileSync(temp, `${JSON.stringify(result)  }\n`, { mode: 0o600, flag: 'wx' });
        fs.renameSync(temp, target);
    } finally { fs.rmSync(temp, { force: true }); }
}

async function fetchAnnouncements() {
    const c = types();
    // 使用已声明请求的默认值，不枚举分页参数或公告编号。
    const { body } = await sendMsgAsync(SERVICE, 'GetBulletinList', c.listReq.encode(c.listReq.create({})).finish(), 5000);
    const reply = c.listRep.toObject(c.listRep.decode(body), { longs: String });
    const seen = new Set();
    const announcements = [];
    for (const item of Array.isArray(reply.bulletins) ? reply.bulletins : []) {
        const id = String(item.id || '');
        if (!/^[1-9]\d{0,18}$/.test(id) || seen.has(id)) continue;
        seen.add(id);
        announcements.push({ id, title: plainText(item.title).slice(0, 300), detailLoaded: false });
        if (announcements.length === 30) break;
    }
    // 仅查询列表真实下发的前几条详情；不提供任意编号或强刷入口。
    let detailError = '';
    for (const item of announcements.slice(0, MAX_DETAILS)) {
        if (!isConnected()) { detailError = '账号连接已关闭，剩余详情未读取'; break; }
        try {
            const payload = c.detailReq.encode(c.detailReq.create({ id: item.id })).finish();
            const response = await sendMsgAsync(SERVICE, 'GetBulletinDetail', payload, 5000);
            const detail = c.detailRep.toObject(c.detailRep.decode(response.body), { longs: String });
            const content = plainText(detail.content);
            item.title = plainText(detail.title).slice(0, 300) || item.title;
            item.content = content;
            item.beginTime = plainText(detail.begin_time).slice(0, 100);
            item.endTime = plainText(detail.end_time).slice(0, 100);
            item.imageUrl = String(detail.image_url || '').slice(0, 2000);
            item.detailLoaded = true;
        } catch (error) {
            // 失败即停止剩余详情，无重试、替代方法或编号试探。
            detailError = String(error.message || '公告详情读取失败').slice(0, 300);
            break;
        }
    }
    const result = { source: 'official-game-bulletin', fetchedAt: Date.now(), announcements,
        partial: announcements.some(item => !item.detailLoaded), detailError,
        empty: announcements.length === 0 };
    // 写盘失败不影响已经取得的只读结果；原始响应及账号身份不写入缓存。
    try { persist(result); } catch { /* 缓存不可写时仍返回当前读取结果 */ }
    return result;
}

async function getOfficialAnnouncements() {
    if (!isConnected()) throw new Error('账号未连接，无法读取官方公告');
    if (cached && Date.now() < cachedUntil) return { ...cached, upstreamCached: true };
    if (inFlight) return inFlight;
    if (Date.now() < failedUntil) throw lastError;
    inFlight = (async () => {
        try {
            const result = await fetchAnnouncements();
            cached = result;
            cachedUntil = Date.now() + CACHE_MS;
            failedUntil = 0;
            return { ...result, upstreamCached: false };
        } catch (error) {
            lastError = error;
            failedUntil = Date.now() + FAILURE_MS;
            throw error;
        } finally { inFlight = null; }
    })();
    return inFlight;
}

module.exports = { getOfficialAnnouncements };
