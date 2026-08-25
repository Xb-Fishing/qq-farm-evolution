const crypto = require('node:crypto');
const fs = require('node:fs');
const { getDataFile } = require('../config/runtime-paths');

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
      if (item && item.token && item.user) {
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

  function logAdminSessionRejected(reason, username) {
    logger.warn('admin session rejected', {
      reason,
      username,
    });
  }

  function logAdminSessionEvent(event, reason, username) {
    logger.info(event, {
      reason,
      username,
    });
  }

  function createAdminSession(user) {
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

  function getAdminSessionRejection(currentUser) {
    if (
      !currentUser
      || currentUser.role === 'admin'
      || currentUser.role === 'super_admin'
      || !currentUser.card
    ) {
      return null;
    }
    if (currentUser.card.enabled === false) {
      return {
        reason: 'banned',
        error: '账号已被封禁，请联系管理员',
      };
    }
    if (
      currentUser.card.expiresAt
      && currentUser.card.expiresAt < Date.now()
    ) {
      return {
        reason: 'expired',
        error: '账号已过期，请续费后重新登录',
      };
    }
    return null;
  }

  function requireAdminToken(req, res, next) {
    const token = req.headers['x-admin-token'];
    if (!token || !adminTokens.has(token))
      return sendUnauthorized(res);
    req.adminToken = token;
    req.currentUser = adminSessions.get(token);
    const rejection = getAdminSessionRejection(req.currentUser);
    if (rejection) {
      logAdminSessionRejected(rejection.reason, req.currentUser.username);
      invalidateAdminSession(token);
      return res.status(403).json({
        ok: false,
        error: rejection.error,
      });
    }
    next();
  }

  function cleanupInvalidAdminSessions() {
    const now = Date.now();
    const expiredSessions = [];
    for (const [token, session] of adminSessions.entries()) {
      if (session.role === 'admin' || session.role === 'super_admin')
        continue;
      if (session.card && session.card.enabled === false) {
        logAdminSessionEvent(
          'admin session cleanup queued',
          'banned',
          session.username,
        );
        expiredSessions.push({
          token,
          username: session.username,
          reason: 'banned',
        });
        continue;
      }
      if (
        session.card
        && session.card.expiresAt
        && session.card.expiresAt < now
      ) {
        logAdminSessionEvent(
          'admin session cleanup queued',
          'expired',
          session.username,
        );
        expiredSessions.push({
          token,
          username: session.username,
          reason: 'expired',
        });
      }
    }
    for (const { token, username, reason } of expiredSessions) {
      invalidateAdminSessionAndDisconnect(token);
      logAdminSessionEvent('admin session force logout', reason, username);
    }
  }

  function hasToken(token) {
    return adminTokens.has(token);
  }

  function getSession(token) {
    return adminSessions.get(token) || null;
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
