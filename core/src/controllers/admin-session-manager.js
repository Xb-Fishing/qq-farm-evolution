const crypto = require('node:crypto');
const fs = require('node:fs');
const { getDataFile } = require('../config/runtime-paths');
const { isPanelOwner } = require('../models/user-store');

const SESSIONS_FILE = getDataFile('admin-sessions.json');
// 会话上限，超出按先进先出淘汰最旧的
const MAX_SESSIONS = 20;

function createAdminSessionManager({ logger, getIo }) {
  const adminTokens = new Set();
  const adminSessions = new Map();

  // ── 会话持久化（重启不掉线，FIFO 淘汰）──
  function persistSessions() {
    try {
      const list = [...adminSessions.entries()]
        .map(([token, user]) => ({ token, user }))
        .slice(-MAX_SESSIONS);
      fs.writeFileSync(SESSIONS_FILE, JSON.stringify(list));
    } catch (err) {
      logger.warn('会话持久化写入失败', { error: err.message });
    }
  }

  try {
    const raw = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
    for (const item of (Array.isArray(raw) ? raw : []).slice(-MAX_SESSIONS)) {
      if (item?.token && isPanelOwner(item.user)) {
        adminTokens.add(item.token);
        adminSessions.set(item.token, item.user);
      }
    }
    if (adminSessions.size > 0) {
      logger.info(`已恢复 ${adminSessions.size} 个持久化会话`);
    }
  } catch { }

  function generateAdminToken() {
    return crypto.randomBytes(24).toString('hex');
  }

  function sendUnauthorized(res) {
    return res.status(401).json({
      ok: false,
      error: 'Unauthorized',
    });
  }

  function logAdminSessionEvent(event, reason, username) {
    logger.info(event, {
      reason,
      username,
    });
  }

  function createAdminSession(user) {
    if (!isPanelOwner(user)) return null;
    const token = generateAdminToken();
    // FIFO：超过上限先淘汰最旧的会话
    while (adminSessions.size >= MAX_SESSIONS) {
      const oldest = adminSessions.keys().next().value;
      invalidateAdminSessionAndDisconnect(oldest);
    }
    adminTokens.add(token);
    adminSessions.set(token, user);
    persistSessions();
    return token;
  }

  function invalidateAdminSession(token) {
    adminTokens.delete(token);
    adminSessions.delete(token);
    persistSessions();
  }

  function disconnectAdminTokenSockets(token) {
    const io = typeof getIo === 'function' ? getIo() : null;
    if (!io) return;
    for (const socket of io.sockets.sockets.values()) {
      String(socket.data.adminToken || '') === String(token)
        && socket.disconnect(true);
    }
  }

  function invalidateAdminSessionAndDisconnect(token) {
    invalidateAdminSession(token);
    disconnectAdminTokenSockets(token);
  }

  function invalidateAdminSessions(predicate) {
    for (const [token, session] of adminSessions.entries()) {
      if (predicate(session, token))
        invalidateAdminSessionAndDisconnect(token);
    }
  }

  function updateAdminSessions(predicate, updateSession) {
    let changed = false;
    for (const [token, session] of adminSessions.entries()) {
      if (predicate(session, token)) {
        updateSession(session, token);
        adminSessions.set(token, session);
        changed = true;
      }
    }
    if (changed) persistSessions();
  }

  function requireAdminToken(req, res, next) {
    const token = req.headers['x-admin-token'];
    if (!token || !hasToken(token))
      return sendUnauthorized(res);
    req.adminToken = token;
    req.currentUser = adminSessions.get(token);
    next();
  }

  function cleanupInvalidAdminSessions() {
    for (const [token, user] of adminSessions.entries()) {
      if (isPanelOwner(user)) continue;
      invalidateAdminSessionAndDisconnect(token);
      logAdminSessionEvent('admin session force logout', 'owner_changed', user.username);
    }
  }

  function hasToken(token) {
    return adminTokens.has(token) && isPanelOwner(adminSessions.get(token));
  }

  function getSession(token) {
    return hasToken(token) ? adminSessions.get(token) : null;
  }

  return {
    cleanupInvalidAdminSessions,
    createAdminSession,
    getSession,
    hasToken,
    invalidateAdminSessionAndDisconnect,
    invalidateAdminSessions,
    requireAdminToken,
    updateAdminSessions,
  };
}

module.exports = {
  createAdminSessionManager,
};
