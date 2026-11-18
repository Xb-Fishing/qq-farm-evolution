'use strict';
const { randomUUID } = require('node:crypto');
const axios = require('axios');

// Optional independent gateway: configure FARM_QQ_AUTH_ENABLED=1 together with
// FARM_QQ_AUTH_ENDPOINT and a private FARM_QQ_AUTH_SIGNATURE at startup.
// This adapter does not install a QQ host or persist gateway credentials.

const LIMIT = 2 * 1024 * 1024;
const TTL = 180000;
const STATES = new Set(['waiting_scan', 'scanned', 'confirmed', 'cancelled', 'expired', 'failed']);
const ERRORS = Object.freeze({
  DISABLED: 'QQ 扫码网关未启用或配置无效', BUSY: 'QQ 扫码工作流正在使用中',
  NOT_FOUND: 'QQ 扫码任务不可用', INVALID: 'QQ 扫码响应无效',
  FAILED: 'QQ 扫码网关请求失败', EXPIRED: 'QQ 扫码任务已过期',
  WAIT: '请稍后查询扫码状态', UNCONFIRMED: '请先确认 QQ 扫码登录',
  CODE_UNKNOWN: '取码结果未确认，请勿重复取码，等待任务清理',
  CANCEL_PENDING: '取消尚未确认，任务将由服务器限时清理',
});
function knownError(code) { return typeof code === 'string' && Object.prototype.hasOwnProperty.call(ERRORS, code); }
function failure(code) { const key = knownError(code) ? code : 'FAILED'; const error = new Error(ERRORS[key]); error.code = key; return error; }
function safeError(error) { const code = knownError(error?.code) ? error.code : 'FAILED'; return { code, error: ERRORS[code] }; }
function boundedString(value, max) {
  // eslint-disable-next-line no-control-regex
  return typeof value === 'string' && value.length > 0 && value.length <= max && value.trim() === value && !/[\x00-\x1F\x7F-\x9F]/.test(value);
}
function readConfig(env) {
  if (env.FARM_QQ_AUTH_ENABLED !== '1') return null;
  const signature = env.FARM_QQ_AUTH_SIGNATURE;
  if (!boundedString(signature, 512) || signature.length < 32 || new Set(signature).size < 12
    || signature === 'qq-miniapp-auth-default-signing-secret') return null;
  try {
    if (typeof env.FARM_QQ_AUTH_ENDPOINT !== 'string' || env.FARM_QQ_AUTH_ENDPOINT.trim() !== env.FARM_QQ_AUTH_ENDPOINT || /[?#]/.test(env.FARM_QQ_AUTH_ENDPOINT)) return null;
    const url = new URL(env.FARM_QQ_AUTH_ENDPOINT);
    const loopback = url.hostname === 'localhost' || url.hostname === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(url.hostname);
    if (url.username || url.password || url.search || url.hash || !['https:', 'http:'].includes(url.protocol)
      || (url.protocol === 'http:' && !loopback) || (url.pathname !== '/' && url.pathname !== '')) return null;
    return Object.freeze({ endpoint: url.origin, signature });
  } catch { return null; }
}
function validPng(value) {
  if (typeof value !== 'string' || value.length > Math.ceil(LIMIT / 3) * 4 + 22 || !value.startsWith('data:image/png;base64,')) return false;
  const encoded = value.slice(22);
  if (!encoded || encoded.length % 4 || !/^[a-z0-9+/]+={0,2}$/i.test(encoded)) return false;
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length < 57 || bytes.length > LIMIT || bytes.toString('base64') !== encoded
    || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return false;
  let offset = 8; let imageData = false;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    if (length > bytes.length - offset - 12) return false;
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    if (offset === 8) {
      if (type !== 'IHDR' || length !== 13) return false;
      const width = bytes.readUInt32BE(offset + 8);
      const height = bytes.readUInt32BE(offset + 12);
      if (!width || !height || width > 2048 || height > 2048) return false;
    } else if (type === 'IHDR') return false;
    if (type === 'IDAT' && length) imageData = true;
    offset += length + 12;
    if (type === 'IEND') return length === 0 && imageData && offset === bytes.length;
  }
  return false;
}

function createQqLoginGateway({ env = process.env, request = config => axios.request(config), now = Date.now,
  schedule = (fn, ms) => setTimeout(fn, ms), unschedule = timer => clearTimeout(timer) } = {}) {
  let slot = null;
  const arm = (job, ms) => {
    if (job.timer) unschedule(job.timer);
    job.timer = schedule(() => { job.timer = null; void expire(job); }, Math.max(1, ms));
    job.timer?.unref?.();
  };
  function release(job) { if (job.timer) unschedule(job.timer); job.timer = null; if (slot === job) slot = null; }
  async function call(job, path, data, timeout = 15000) {
    try {
      const response = await request({ method: 'POST', url: `${job.config.endpoint}${path}`, data,
        headers: { 'X-API-Signature': job.config.signature }, timeout,
        maxRedirects: 0, proxy: false, maxContentLength: LIMIT, maxBodyLength: LIMIT,
        responseType: 'json', validateStatus: status => status === 200 });
      if (response?.status !== 200 || response.data?.ok !== true) throw failure('FAILED');
      return response.data;
    } catch { throw failure('FAILED'); }
  }
  async function cleanup(job) {
    job.cancelled = true;
    if (job.inFlight) throw failure('CANCEL_PENDING');
    if (!job.upstreamId) {
      if (now() >= job.guardUntil) release(job);
      else arm(job, job.guardUntil - now());
      throw failure('CANCEL_PENDING');
    }
    job.inFlight = true;
    try { await call(job, '/api/qq/logout', { taskId: job.upstreamId }); release(job); }
    catch {
      if (now() >= job.guardUntil) release(job);
      else arm(job, job.guardUntil - now());
      throw failure('CANCEL_PENDING');
    } finally { job.inFlight = false; }
  }
  async function expire(job) {
    if (slot !== job) return;
    job.cancelled = true;
    if (job.inFlight) return; // The bounded transport still owns this slot until it settles.
    if (now() >= job.guardUntil) { release(job); return; }
    try { await cleanup(job); } catch { /* retain the bounded cleanup guard */ }
  }
  function owned(owner, id) {
    if (!boundedString(owner, 512) || !boundedString(id, 128) || !slot || slot.owner !== owner || slot.id !== id) throw failure('NOT_FOUND');
    return slot;
  }
  function active(job) {
    if (job.cancelled || now() >= job.deadline) { void expire(job); throw failure('EXPIRED'); }
    if (job.inFlight) throw failure('BUSY');
  }
  function taskView(job) { return { taskId: job.id, status: job.status, qrImage: job.qrImage, expiresAt: job.deadline }; }
  function parseTask(task, job, creating) {
    if (!task || !boundedString(task.id, 256) || (!creating && task.id !== job.upstreamId)
      || !STATES.has(task.status) || typeof task.expiresAt !== 'number' || !Number.isFinite(task.expiresAt)
      || task.expiresAt <= now() || task.expiresAt > now() + TTL || !validPng(task.qrImage)) throw failure('INVALID');
    job.upstreamId = task.id; job.status = task.status; job.qrImage = task.qrImage;
    job.deadline = Math.min(job.deadline, task.expiresAt);
    arm(job, job.deadline - now());
  }
  return {
    config: () => ({ enabled: !!readConfig(env) }),
    async create(owner) {
      const config = readConfig(env);
      if (!config) throw failure('DISABLED');
      if (!boundedString(owner, 512)) throw failure('NOT_FOUND');
      if (slot) throw failure('BUSY');
      const job = { id: randomUUID(), owner, config, inFlight: true, cancelled: false,
        deadline: now() + TTL, guardUntil: now() + TTL + 15000, lastPoll: -Infinity, codeRequested: false };
      slot = job; arm(job, TTL);
      try {
        const result = await call(job, '/api/qq/login/qrcode', {});
        // Retain even a partially valid upstream ID so malformed/late creates can be cancelled.
        if (boundedString(result.task?.id, 256)) job.upstreamId = result.task.id;
        parseTask(result.task, job, true);
        if (job.cancelled || now() >= job.deadline) throw failure('EXPIRED');
        return taskView(job);
      } catch (error) { job.cancelled = true; throw error; }
      finally { job.inFlight = false; if (job.cancelled) { try { await cleanup(job); } catch { /* guarded */ } } }
    },
    async status(owner, id) {
      const job = owned(owner, id); active(job);
      if (job.codeRequested) throw failure('CODE_UNKNOWN');
      if (now() - job.lastPoll < 2000) throw failure('WAIT');
      job.lastPoll = now(); job.inFlight = true;
      try {
        const result = await call(job, '/api/qq/login/status', { taskId: job.upstreamId, refresh: false });
        if (job.cancelled || now() >= job.deadline) throw failure('EXPIRED');
        parseTask(result.task, job, false);
        if (['cancelled', 'expired', 'failed'].includes(job.status)) job.cancelled = true;
        return taskView(job);
      } finally { job.inFlight = false; if (job.cancelled) { try { await cleanup(job); } catch { /* guarded */ } } }
    },
    async code(owner, id) {
      const job = owned(owner, id); active(job);
      if (job.codeRequested) throw failure('CODE_UNKNOWN');
      if (job.status !== 'confirmed') throw failure('UNCONFIRMED');
      job.codeRequested = true; job.inFlight = true;
      try {
        // The reviewed gateway contract returns ok:true only AFTER native logout succeeds.
        const result = await call(job, '/api/qq/miniapp/code', { taskId: job.upstreamId, appId: '1112386029' }, 90000);
        if (!boundedString(result.code, 512) || (result.nickname !== undefined && !boundedString(result.nickname, 128))) throw failure('CODE_UNKNOWN');
        if (job.cancelled || now() >= job.deadline) { release(job); throw failure('EXPIRED'); }
        release(job);
        return { code: result.code, nickname: result.nickname || '' };
      } catch { job.cancelled = true; throw failure('CODE_UNKNOWN'); }
      finally { job.inFlight = false; if (slot === job && job.cancelled) { try { await cleanup(job); } catch { /* guarded */ } } }
    },
    async cancel(owner, id) { const job = owned(owner, id); await cleanup(job); return { cancelled: true }; },
    async cancelOwner(owner) {
      if (!slot || slot.owner !== owner) return;
      await cleanup(slot);
    },
  };
}
const qqLoginGateway = createQqLoginGateway();
module.exports = { createQqLoginGateway, qqLoginGateway, safeError, validPng };
