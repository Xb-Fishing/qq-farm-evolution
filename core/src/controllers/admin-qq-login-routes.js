'use strict';
const { createHash } = require('node:crypto');
const { qqLoginGateway, safeError } = require('../services/qq-login-gateway');

function registerAdminQqLoginRoutes({ app, requireAdminToken, manager = qqLoginGateway }) {
  function session(req, res) {
    let valid = false;
    // This middleware refreshes currentUser/adminToken; never trust a pre-await copy alone.
    requireAdminToken(req, res, () => { valid = true; });
    if (!valid || !req.currentUser?.username || !req.adminToken) return null;
    return createHash('sha256').update(JSON.stringify([req.currentUser.username, req.adminToken])).digest('hex');
  }
  app.get('/api/qq-login/config', (req, res) => {
    if (session(req, res)) res.json({ ok: true, data: { enabled: manager.config().enabled === true } });
  });
  for (const action of ['create', 'status', 'code', 'cancel']) {
    app.post(`/api/qq-login/${action}`, async (req, res) => {
      const owner = session(req, res);
      if (!owner) return;
      const body = req.body;
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return res.status(400).json({ ok: false, error: 'QQ 扫码请求参数无效', code: 'INVALID' });
      }
      const keys = Object.keys(body);
      if (keys.some(key => key !== 'taskId') || (action === 'create' && keys.length)
        || (action !== 'create' && (typeof body.taskId !== 'string' || !body.taskId || body.taskId.length > 128))) {
        return res.status(400).json({ ok: false, error: 'QQ 扫码请求参数无效', code: 'INVALID' });
      }
      let disconnected = false;
      const cancel = () => {
        if (res.writableEnded) return;
        disconnected = true;
        void manager.cancelOwner(owner).catch(() => {});
      };
      res.once('close', cancel);
      req.once('aborted', cancel);
      try {
        const data = await manager[action](owner, body.taskId);
        const current = disconnected ? null : session(req, res);
        if (current !== owner) {
          await manager.cancelOwner(owner).catch(() => {});
          if (!disconnected && !res.destroyed && !res.writableEnded) res.status(401).json({ ok: false, error: 'QQ 扫码会话已失效' });
          return;
        }
        if (!res.destroyed && !res.writableEnded) res.json({ ok: true, data });
      } catch (error) {
        const current = disconnected ? null : session(req, res);
        if (current !== owner) await manager.cancelOwner(owner).catch(() => {});
        if (!disconnected && current === owner && !res.destroyed && !res.writableEnded) {
          res.json({ ok: false, ...safeError(error) });
        } else if (!disconnected && !res.destroyed && !res.writableEnded) {
          res.status(401).json({ ok: false, error: 'QQ 扫码会话已失效' });
        }
      } finally {
        res.removeListener('close', cancel);
        req.removeListener('aborted', cancel);
      }
    });
  }
}
module.exports = { registerAdminQqLoginRoutes };
